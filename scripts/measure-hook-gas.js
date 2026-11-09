const hre = require("hardhat");

const pools = require("./lib/pools");
const { scanLogs } = require("./lib/logs");

// Measures, READ-ONLY, what the vault's two fail-open bonus notifications really cost on the live
// chain, and compares it with the gas the vault forwards (audit notes item 20, "Glamsterdam: fixed
// hook stipends"). Run it before every mainnet operation that links, upgrades or re-sizes a hook,
// and after every network fork.
//
//     npx hardhat run scripts/measure-hook-gas.js --network sepolia
//     npx hardhat run scripts/measure-hook-gas.js --network mainnet
//
// Why it exists. The vault calls the ApeBond `BonusEscrow.onUnstake` and the staking v3
// `V3BonusVault.onUnstake` / `onRebalance` inside `try` with a fixed gas allowance, and a hook that
// runs out of it fails OPEN: the exit or the rebalance completes, the bonus is not forfeited or not
// moved, and only a `BonusHookFailed` / `BonusListenerFailed` event says so. Glamsterdam (EIP-8037,
// live on Sepolia since 2026-10-06) made a new storage slot about ten times dearer, which Foundry and
// the Hardhat network do not reproduce. Only the live chain gives the real figure.
//
// How it measures. For each hook and each live reservation it sends `eth_estimateGas` with the
// VAULT as the sender (`from` = the vault: a node simulates any sender, no key is involved, and the
// hooks accept only the vault). Nothing is signed and nothing is sent. The estimate includes the
// 21,000 intrinsic gas and the calldata cost, which the vault's allowance does not have to cover, so
// it OVERSTATES the hook's need: a conservative figure. A second check, `eth_call` with the gas
// limit set to exactly the allowance, says whether the hook completes inside it (again
// conservative: the intrinsic gas comes out of the same limit).
//
// `onRebalance` is simulated as the vault would send it: old = the position as staked (read from
// the position manager, or from the vault's own `Staked` / `Rebalanced` event when the NFT is
// already burned), new = the same range and liquidity under a tokenId nobody uses (2^64 + id), so
// the hook writes a NEW reservation row: the expensive path Glamsterdam reprices.
//
// ──────────────────────── environment (all optional) ────────────────────────
//
//   MEASURE_VAULT              the LPStakingVault proxy (default: deployments.json LPStakingVault)
//   MEASURE_ESCROW             the BonusEscrow (default: vault.bonusEscrow(); none = skipped)
//   MEASURE_LISTENER           the V3BonusVault (default: vault.bonusListener(); none = skipped)
//   MEASURE_ESCROW_TOKEN_IDS   comma-separated tokenIds to measure on the escrow (default: the
//                              latest active reservations found in its BonusReserved / BonusMoved)
//   MEASURE_LISTENER_TOKEN_IDS the same for the listener (LpBonusReserved / LpBonusMoved)
//   MEASURE_FROM_BLOCK         first block of the event scan (default: the contract's deployment
//                              block in deployments.json, else latest - 200,000)
//   MEASURE_MAX_IDS            how many active reservations per contract (default 3)
//
// Output: one row per (contract, hook, tokenId) with the estimate, the allowance, the ratio
// allowance / estimate and the verdict (OK at 1.5x or more, LOW between 1x and 1.5x, FAIL below).
// A FAIL or LOW row means: raise the allowance with `setBonusHookGas` (lp-timelock.js) before the
// operation. The script never changes anything.

const VAULT_ABI = [
  "function positionManager() view returns (address)",
  "function bonusEscrow() view returns (address)",
  "function bonusListener() view returns (address)",
  "function bonusHookGas() view returns (uint256)",
  "function bonusListenerGas() view returns (uint256)",
  "function BONUS_HOOK_GAS() view returns (uint256)",
  "function BONUS_LISTENER_GAS() view returns (uint256)",
  "event Staked(address indexed user, uint256 indexed tokenId, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 timestamp)",
  "event Rebalanced(address indexed user, uint256 indexed oldTokenId, uint256 indexed newTokenId, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 amount0Refunded, uint256 amount1Refunded, uint256 timestamp)",
];
const HOOKS_ABI = [
  "function onUnstake(uint256 tokenId)",
  "function onRebalance(uint256 oldTokenId, uint256 newTokenId, (int24 tickLower, int24 tickUpper, uint128 liquidity) old_, (int24 tickLower, int24 tickUpper, uint128 liquidity) new_)",
];
const ESCROW_ABI = [
  "function isActive(uint256 tokenId) view returns (bool)",
  "event BonusReserved(uint256 indexed tokenId, address indexed beneficiary, uint256 amount, uint64 unlockAt)",
  "event BonusMoved(uint256 indexed oldTokenId, uint256 indexed newTokenId, address indexed beneficiary, uint256 oldAmount, uint256 newAmount)",
];
const LISTENER_ABI = [
  "function lpReservation(uint256 tokenId) view returns (address user, uint256 amount, uint64 unlockAt, bool claimed, bool forfeited)",
  "event LpBonusReserved(uint256 indexed tokenId, address indexed user, uint256 amount, uint64 unlockAt)",
  "event LpBonusMoved(uint256 indexed oldTokenId, uint256 indexed newTokenId, address indexed user, uint256 oldAmount, uint256 newAmount)",
];
const NPM_ABI = [
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
];

const ZERO = "0x0000000000000000000000000000000000000000";
const FRESH_ID_OFFSET = 2n ** 64n;

function optionalAddress(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return null;
  if (!hre.ethers.isAddress(raw)) throw new Error(`${name} must be an address — got ${raw}`);
  return hre.ethers.getAddress(raw);
}

function idList(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return null;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => BigInt(s));
}

/** The vault's allowances: storage (current code) or the old fixed constants (pre-fix code). */
async function readAllowances(vault) {
  try {
    return { escrow: await vault.bonusHookGas(), listener: await vault.bonusListenerGas(), source: "bonusHookGas() / bonusListenerGas()" };
  } catch {
    let listener = null;
    try {
      listener = await vault.BONUS_LISTENER_GAS();
    } catch {
      // the 746b22c vault has no listener at all
    }
    return { escrow: await vault.BONUS_HOOK_GAS(), listener, source: "fixed constants (pre-fix vault code)" };
  }
}

async function optionalView(fn) {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/**
 * The latest active reservations recorded by `contract` (newest first, at most `max`).
 * `reservedEvent` / `movedEvent` name the two events whose tokenId (the moved one: its NEW id)
 * can carry a reservation; `isActive(id)` filters them.
 */
async function activeIds({ contract, reservedEvent, movedEvent, fromBlock, toBlock, max, isActive }) {
  const address = await contract.getAddress();
  const topics = [[contract.interface.getEvent(reservedEvent).topicHash, contract.interface.getEvent(movedEvent).topicHash]];
  const logs = await scanLogs(hre.ethers.provider, { address, topics, fromBlock, toBlock });
  const ids = [];
  for (const log of logs.reverse()) {
    const parsed = contract.interface.parseLog(log);
    const id = parsed.name === reservedEvent ? parsed.args.tokenId : parsed.args.newTokenId;
    if (ids.some((x) => x === id)) continue;
    if (await isActive(id)) ids.push(id);
    if (ids.length >= max) break;
  }
  return ids;
}

/** The position as the vault would report it in `old_`: live from the NPM, else from the vault's events. */
async function snapshotOf({ npm, vault, tokenId, fromBlock, toBlock }) {
  try {
    const p = await npm.positions(tokenId);
    if (p.liquidity > 0n) return { tickLower: p.tickLower, tickUpper: p.tickUpper, liquidity: p.liquidity, source: "positions()" };
  } catch {
    // burned (a rebalanced or unstaked NFT): fall back to the vault's own record of it
  }
  const vaultAddress = await vault.getAddress();
  const idTopic = hre.ethers.zeroPadValue(hre.ethers.toBeHex(tokenId), 32);
  const staked = await scanLogs(hre.ethers.provider, {
    address: vaultAddress,
    topics: [vault.interface.getEvent("Staked").topicHash, null, idTopic],
    fromBlock,
    toBlock,
  });
  const rebalanced = await scanLogs(hre.ethers.provider, {
    address: vaultAddress,
    topics: [vault.interface.getEvent("Rebalanced").topicHash, null, null, idTopic],
    fromBlock,
    toBlock,
  });
  const last = [...staked, ...rebalanced].sort((a, b) => a.blockNumber - b.blockNumber).pop();
  if (!last) return null;
  const args = vault.interface.parseLog(last).args;
  return { tickLower: args.tickLower, tickUpper: args.tickUpper, liquidity: args.liquidity, source: `vault event, block ${last.blockNumber}` };
}

/** `eth_estimateGas` and the at-allowance `eth_call`, both from the vault. Never sends anything. */
async function measure({ vaultAddress, target, data, allowance }) {
  const provider = hre.ethers.provider;
  let estimate = null;
  let error = null;
  try {
    estimate = await provider.estimateGas({ from: vaultAddress, to: target, data });
  } catch (e) {
    error = (e.shortMessage || e.message || String(e)).split("\n")[0];
  }
  let fits = null;
  if (allowance !== null) {
    try {
      await provider.call({ from: vaultAddress, to: target, data, gasLimit: allowance });
      fits = true;
    } catch {
      fits = false;
    }
  }
  return { estimate, error, fits };
}

function verdict(allowance, estimate) {
  if (allowance === null || estimate === null) return "n/a";
  const ratio = Number(allowance) / Number(estimate);
  if (ratio >= 1.5) return "OK";
  if (ratio >= 1) return "LOW";
  return "FAIL";
}

async function main() {
  const chainId = await pools.chainId();
  const network = hre.network.name;
  const registry = pools.readRegistry()[String(chainId)] || {};
  const vaultAddress =
    optionalAddress("MEASURE_VAULT") || (registry.LPStakingVault && hre.ethers.getAddress(registry.LPStakingVault.address));
  if (!vaultAddress) throw new Error(`No LPStakingVault for chain ${chainId}: set MEASURE_VAULT`);

  const provider = hre.ethers.provider;
  const vault = new hre.ethers.Contract(vaultAddress, VAULT_ABI, provider);
  const npm = new hre.ethers.Contract(await vault.positionManager(), NPM_ABI, provider);
  const allowances = await readAllowances(vault);
  const escrowAddress = optionalAddress("MEASURE_ESCROW") || (await optionalView(() => vault.bonusEscrow()));
  const listenerAddress = optionalAddress("MEASURE_LISTENER") || (await optionalView(() => vault.bonusListener()));
  const latest = await provider.getBlockNumber();
  const max = Number(process.env.MEASURE_MAX_IDS || 3);
  const defaultFrom = (kind) =>
    process.env.MEASURE_FROM_BLOCK
      ? Number(process.env.MEASURE_FROM_BLOCK)
      : registry[kind] && registry[kind].block
        ? Number(registry[kind].block)
        : Math.max(0, latest - 200_000);
  const vaultFrom = defaultFrom("LPStakingVault");
  const block = await provider.getBlock(latest);

  console.log("Measuring the vault's bonus hook gas (read-only: eth_estimateGas / eth_call from the vault)");
  console.log(`Network:    ${network} (chain ${chainId}), block ${latest} (${new Date(block.timestamp * 1000).toISOString()})`);
  console.log(`Vault:      ${vaultAddress}`);
  console.log(`Allowances: escrow ${allowances.escrow}, listener ${allowances.listener === null ? "none" : allowances.listener} (${allowances.source})`);

  const rows = [];
  const hooks = new hre.ethers.Interface(HOOKS_ABI);

  const targets = [];
  if (escrowAddress && escrowAddress !== ZERO) {
    const contract = new hre.ethers.Contract(escrowAddress, ESCROW_ABI, provider);
    targets.push({
      label: "BonusEscrow",
      address: escrowAddress,
      allowance: allowances.escrow,
      // The escrow's onRebalance is FAIL CLOSED (no try, all remaining gas): measured for the
      // record, not held to an allowance.
      rebalanceAllowance: null,
      ids:
        idList("MEASURE_ESCROW_TOKEN_IDS") ||
        (await activeIds({
          contract,
          reservedEvent: "BonusReserved",
          movedEvent: "BonusMoved",
          fromBlock: defaultFrom("BonusEscrow"),
          toBlock: latest,
          max,
          isActive: (id) => contract.isActive(id),
        })),
    });
  } else {
    console.log("Escrow:     none linked, skipped");
  }
  if (listenerAddress && listenerAddress !== ZERO) {
    const contract = new hre.ethers.Contract(listenerAddress, LISTENER_ABI, provider);
    targets.push({
      label: "V3BonusVault",
      address: listenerAddress,
      allowance: allowances.listener,
      rebalanceAllowance: allowances.listener,
      ids:
        idList("MEASURE_LISTENER_TOKEN_IDS") ||
        (await activeIds({
          contract,
          reservedEvent: "LpBonusReserved",
          movedEvent: "LpBonusMoved",
          fromBlock: defaultFrom("V3BonusVault"),
          toBlock: latest,
          max,
          isActive: async (id) => {
            const r = await contract.lpReservation(id);
            return r.user !== ZERO && !r.claimed && !r.forfeited && BigInt(block.timestamp) < r.unlockAt;
          },
        })),
    });
  } else {
    console.log("Listener:   none linked, skipped");
  }

  for (const t of targets) {
    console.log(`${t.label.padEnd(11)} ${t.address}: active reservations measured: ${t.ids.length ? t.ids.join(", ") : "none found"}`);
    for (const id of t.ids) {
      const unstake = await measure({
        vaultAddress,
        target: t.address,
        data: hooks.encodeFunctionData("onUnstake", [id]),
        allowance: t.allowance,
      });
      rows.push({ contract: t.label, hook: "onUnstake", id, allowance: t.allowance, failClosed: false, ...unstake });

      const snap = await snapshotOf({ npm, vault, tokenId: id, fromBlock: vaultFrom, toBlock: latest });
      if (!snap) {
        rows.push({ contract: t.label, hook: "onRebalance", id, allowance: t.rebalanceAllowance, error: "no snapshot found" });
        continue;
      }
      const s = [snap.tickLower, snap.tickUpper, snap.liquidity];
      const rebalance = await measure({
        vaultAddress,
        target: t.address,
        data: hooks.encodeFunctionData("onRebalance", [id, FRESH_ID_OFFSET + BigInt(id), s, s]),
        allowance: t.rebalanceAllowance,
      });
      rows.push({
        contract: t.label,
        hook: "onRebalance",
        id,
        allowance: t.rebalanceAllowance,
        failClosed: t.rebalanceAllowance === null,
        snapshot: snap.source,
        ...rebalance,
      });
    }
  }

  console.log("");
  console.log(
    "contract     hook         tokenId   estimate   allowance   allowance/estimate   eth_call at allowance   verdict"
  );
  for (const r of rows) {
    const allowance = r.failClosed ? "all gas" : r.allowance === null || r.allowance === undefined ? "n/a" : String(r.allowance);
    const ratio = r.estimate && r.allowance && !r.failClosed ? (Number(r.allowance) / Number(r.estimate)).toFixed(2) + "x" : "-";
    const fits = r.fits === null || r.fits === undefined || r.failClosed ? "-" : r.fits ? "completes" : "OUT OF GAS / REVERT";
    const v = r.error ? `ERROR: ${r.error}` : r.failClosed ? "fail closed (no stipend)" : verdict(r.allowance, r.estimate);
    console.log(
      `${r.contract.padEnd(12)} ${r.hook.padEnd(12)} ${String(r.id).padEnd(9)} ${String(r.estimate ?? "-").padEnd(10)} ` +
        `${allowance.padEnd(11)} ${ratio.padEnd(20)} ${fits.padEnd(23)} ${v}`
    );
  }
  console.log("");
  console.log(
    "The estimate includes the 21,000 intrinsic gas and the calldata cost, so it overstates the hook's\n" +
      "own need. Keep each allowance at 1.5x the largest estimate or more; a LOW or FAIL row needs\n" +
      "`setBonusHookGas(escrowGas, listenerGas)` through the timelock (lp-timelock.js) BEFORE the\n" +
      "operation. Re-run after every network fork and before every escrow or listener upgrade."
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

module.exports = { main };
