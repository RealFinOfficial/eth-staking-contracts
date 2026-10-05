const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const pools = require("./lib/pools");
const { deployContract } = require("./lib/proxies");

// The live ApeBond rehearsal on a TEST STACK (Sepolia test stack #6): real purchases through the
// deployed adapter, end to end, and the two attacks the B.3 refactor closes, shown on chain.
//
// ──────────────────────── what each phase proves ────────────────────────
//
//   LP_REHEARSAL_PHASE=caller      deploys a `MockSoulZapCaller` (the test-only stand-in for the
//                                  SoulZap router: holds the NFT, approves the adapter, calls
//                                  `depositFor`) and records it. Run it BEFORE the route is
//                                  deployed and pass its address in LP_APEBOND_SOULZAP_CALLERS, so
//                                  the adapter allowlists it for the campaign at wiring time.
//   LP_REHEARSAL_PHASE=deposit     (default) one purchase: the signer mints a position on the
//                                  campaign's exact range INTO the caller contract, which deposits
//                                  it for LP_REHEARSAL_BENEFICIARY. The adapter computes the bonus
//                                  (value at the vault's TWAP x rate, zero below the minimum) and
//                                  the escrow records it under the NFT's tokenId — with no balance
//                                  needed (override O2).
//   LP_REHEARSAL_PHASE=loop        B.3 P2: the caller buys with ITSELF as the beneficiary and
//                                  unstakes in the same transaction. The escrow must emit
//                                  `BonusForfeited`; a claim after the cliff reverts `Forfeited`.
//   LP_REHEARSAL_PHASE=withdrawal  B.3 P3: a purchase for the SIGNER, then two no-swap rebalances
//                                  by the signer — first to a range whose upper bound sits just
//                                  above the price (most of the position is refunded), then to
//                                  one whose lower bound sits just below it. The bonus follows the
//                                  position and is scaled each time; the run prints both shares.
//   LP_REHEARSAL_PHASE=claim       after the cliff: `claim(tokenId)` for every purchase recorded
//                                  and not yet paid. A claim the escrow cannot cover reverts
//                                  `InsufficientFunds(needed, balance)` — reported, not hidden.
//   LP_REHEARSAL_PHASE=status      every recorded reservation as the escrow reports it now.
//
// It REFUSES chain 1 outright, with no CONFIRM escape: it mints positions and stakes them, which is
// never an operator action on mainnet.
//
// ──────────────────────── environment ────────────────────────
//
//   LP_REHEARSAL_PHASE            caller | deposit | loop | withdrawal | claim | status (deposit)
//   LP_REHEARSAL_CALLER           the MockSoulZapCaller to use (the one this script recorded)
//   LP_REHEARSAL_BENEFICIARY      deposit: the buyer the vault credits and the escrow pays (signer)
//   LP_REHEARSAL_CAMPAIGN_ID      the campaign (the one recorded for the adapter in deployments.json)
//   LP_REHEARSAL_AMOUNT0/_AMOUNT1 what to mint with, in whole token0 / token1. Unset: a value-
//                                 balanced pair using LP_REHEARSAL_BUDGET_BPS of each balance (2000)
//   LP_REHEARSAL_R1_TICKS / _R2_TICKS  withdrawal: the two ranges as "lower,upper". Unset: R1 =
//                                 [grid - 6000, grid + spacing], R2 = [grid, grid + 6000 + spacing],
//                                 grid = the price tick aligned down — the document's shape on the
//                                 pool's tick grid
//   LP_REHEARSAL_RECORD           the record file (apebond-rehearsal-<chainId>.json beside the registry)
//   DEPLOYMENTS_FILE              redirects the registry, like every other script here
//
//     LP_REHEARSAL_PHASE=caller npx hardhat run scripts/apebond-rehearsal.js --network sepolia
//     LP_REHEARSAL_PHASE=loop   npx hardhat run scripts/apebond-rehearsal.js --network sepolia

const ADAPTER_KIND = "ApeBondPositionAdapter";
const PHASES = ["caller", "deposit", "loop", "withdrawal", "claim", "status"];
const DEFAULT_PHASE = "deposit";
const DEFAULT_BUDGET_BPS = 2000n;
const WITHDRAWAL_WIDTH_TICKS = 6000;
const Q96 = 1n << 96n;
const FAR_DEADLINE = 10n ** 12n;

const ADAPTER_ABI = [
  "function vault() view returns (address)",
  "function escrow() view returns (address)",
  "function positionManager() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function soulZapCallers(address caller) view returns (bool)",
  "function campaignCallers(bytes32 campaignId, address caller) view returns (bool)",
  "function campaigns(bytes32 campaignId) view returns (bool enabled, int24 tickLower, int24 tickUpper, uint64 bonusCliffSeconds, uint16 bonusBps, uint256 minBonusAmount)",
  "function previewBonus(bytes32 campaignId, uint128 liquidity) view returns (uint256 positionValue, uint256 bonus, int24 twapTick)",
  "event ApeBondPositionDeposited(uint256 indexed tokenId, bytes32 indexed campaignId, address indexed beneficiary, uint128 liquidity, int24 tickLower, int24 tickUpper, int24 twapTick, uint256 positionValue, uint256 bonusAmount, uint64 bonusUnlockAt)",
];
const ESCROW_ABI = [
  "function bonusToken() view returns (address)",
  "function totalReserved() view returns (uint256)",
  "function reservationOf(uint256 tokenId) view returns (address beneficiary, uint256 amount, uint64 unlockAt, bool claimed, bool forfeited)",
  "function claim(uint256 tokenId) returns (uint256 amount)",
  "event BonusForfeited(uint256 indexed tokenId, address indexed beneficiary, uint256 amount)",
  "event BonusMoved(uint256 indexed oldTokenId, uint256 indexed newTokenId, address indexed beneficiary, uint256 previousAmount, uint256 newAmount)",
  "error InsufficientFunds(uint256 needed, uint256 balance)",
  "error Forfeited(uint256 tokenId)",
  "error CliffNotReached(uint256 unlockAt, uint256 blockTimestamp)",
  "error AlreadyClaimed(uint256 tokenId)",
];
const VAULT_ABI = [
  "function pool() view returns (address)",
  "function stakerOf(uint256 tokenId) view returns (address)",
  "function bonusEscrow() view returns (address)",
  "function rebalance(uint256 tokenId, int24 newTickLower, int24 newTickUpper, (bool zeroForOne, uint256 amountIn, uint256 amountOutMin, uint256 amount0Min, uint256 amount1Min) swap, uint256 deadline) returns (uint256 newTokenId)",
  "event Rebalanced(address indexed user, uint256 indexed oldTokenId, uint256 indexed newTokenId, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 amount0Refunded, uint256 amount1Refunded, uint256 timestamp)",
];
const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
];
const TOKEN_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
];
const NPM_ABI = [
  "function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function positions(uint256 tokenId) view returns (uint96, address, address, address, uint24, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256, uint256, uint128, uint128)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
];

// ──────────────────────── small helpers ────────────────────────

function sameValue(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function readPhase() {
  const raw = process.env.LP_REHEARSAL_PHASE;
  if (raw === undefined || raw.trim() === "") return DEFAULT_PHASE;
  if (!PHASES.includes(raw)) throw new Error(`LP_REHEARSAL_PHASE must be one of ${PHASES.join(", ")} — got ${raw}`);
  return raw;
}

function readAddressEnv(name, fallback) {
  const raw = process.env[name] || fallback;
  if (!raw) throw new Error(`Set ${name}`);
  try {
    return hre.ethers.getAddress(raw);
  } catch {
    throw new Error(`${name} is not a valid address: ${raw}`);
  }
}

function readRange(name, fallback) {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return fallback;
  const parts = raw.split(",").map((part) => Number(part.trim()));
  if (parts.length !== 2 || !parts.every(Number.isInteger) || parts[0] >= parts[1]) {
    throw new Error(`${name} must be "lower,upper" with lower < upper — got ${raw}`);
  }
  return parts;
}

function resolveRecordFile(chainId) {
  if (process.env.LP_REHEARSAL_RECORD) return path.resolve(process.env.LP_REHEARSAL_RECORD);
  const registryPath = process.env.DEPLOYMENTS_FILE
    ? path.resolve(process.env.DEPLOYMENTS_FILE)
    : path.join(__dirname, "..", "deployments.json");
  return path.join(path.dirname(registryPath), `apebond-rehearsal-${chainId}.json`);
}

function readRecord(file) {
  if (!fs.existsSync(file)) return { purchases: [] };
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  record.purchases = record.purchases || [];
  return record;
}

function writeRecord(file, record) {
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
  console.log(`Record written: ${file}`);
}

function alignDown(tick, spacing) {
  return Math.floor(Number(tick) / spacing) * spacing;
}

/** sqrt(1.0001^tick) in Q64.96, good to a double's precision — used only to SIZE a mint. */
function sqrtRatioAtTick(tick) {
  return BigInt(Math.floor(Math.sqrt(Math.pow(1.0001, Number(tick))) * 2 ** 96));
}

/**
 * The largest value-balanced pair whose two legs both fit inside `budgetBps` of the signer's
 * balances, for a range [lower, upper] at the pool's price. Uniswap pulls only what the
 * liquidity needs, so this is a sizing choice, not a price.
 */
function defaultMintAmounts({ sqrtPriceX96, tickLower, tickUpper, balance0, balance1, budgetBps }) {
  const sqrtA = sqrtRatioAtTick(tickLower);
  const sqrtB = sqrtRatioAtTick(tickUpper);
  const budget0 = (balance0 * budgetBps) / 10_000n;
  const budget1 = (balance1 * budgetBps) / 10_000n;
  const sqrtP = sqrtPriceX96 < sqrtA ? sqrtA : sqrtPriceX96 > sqrtB ? sqrtB : sqrtPriceX96;
  const candidates = [];
  if (sqrtP < sqrtB) candidates.push((budget0 * sqrtP * sqrtB) / (Q96 * (sqrtB - sqrtP)));
  if (sqrtP > sqrtA) candidates.push((budget1 * Q96) / (sqrtP - sqrtA));
  const liquidity = candidates.reduce((a, b) => (a < b ? a : b));
  const amount0 = sqrtP < sqrtB ? (liquidity * Q96 * (sqrtB - sqrtP)) / (sqrtP * sqrtB) : 0n;
  const amount1 = sqrtP > sqrtA ? (liquidity * (sqrtP - sqrtA)) / Q96 : 0n;
  return { amount0, amount1 };
}

function mintedTokenId(receipt, npmAddress) {
  const iface = new hre.ethers.Interface(NPM_ABI);
  for (const log of receipt.logs) {
    if (!sameValue(log.address, npmAddress)) continue;
    const parsed = iface.parseLog(log);
    if (parsed && parsed.name === "Transfer" && parsed.args.from === hre.ethers.ZeroAddress) return parsed.args.tokenId;
  }
  throw new Error(`no NFT mint Transfer log in ${receipt.hash}`);
}

function findEvent(receipt, contract, name) {
  for (const log of receipt.logs) {
    if (!sameValue(log.address, contract.target)) continue;
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed && parsed.name === name) return parsed.args;
    } catch {
      /* another event of the same contract */
    }
  }
  return null;
}

async function ensureAllowance(token, owner, spender, amount, label) {
  if ((await token.allowance(owner.address, spender)) >= amount) return;
  await pools.send(`  Approving ${label}`, owner, (o) => token.connect(owner).approve(spender, amount, o));
}

// ──────────────────────── the stack ────────────────────────

async function resolveStack(chainId, signer) {
  const registry = pools.readRegistry()[String(chainId)] || {};
  const adapterEntry = registry[ADAPTER_KIND];
  if (!adapterEntry) {
    throw new Error(
      `No ${ADAPTER_KIND} recorded for chain ${chainId}. Deploy the route (deploy-lp-staking.js with ` +
        `LP_APEBOND_ENABLED=1, or deploy-apebond.js) first, or point DEPLOYMENTS_FILE at its registry.`
    );
  }
  const adapter = new hre.ethers.Contract(adapterEntry.address, ADAPTER_ABI, signer);
  const escrow = new hre.ethers.Contract(await adapter.escrow(), ESCROW_ABI, signer);
  const vault = new hre.ethers.Contract(await adapter.vault(), VAULT_ABI, signer);
  if (!sameValue(await vault.bonusEscrow(), escrow.target)) {
    throw new Error(
      `The vault ${vault.target} reports to ${await vault.bonusEscrow()}, not to the adapter's escrow ` +
        `${escrow.target}: the link batch has not executed. Run scripts/deploy-apebond.js first.`
    );
  }
  const npmAddress = hre.ethers.getAddress(await adapter.positionManager());
  const npm = new hre.ethers.Contract(npmAddress, NPM_ABI, signer);
  const pool = new hre.ethers.Contract(await vault.pool(), POOL_ABI, signer);
  const token0 = new hre.ethers.Contract(await adapter.token0(), TOKEN_ABI, signer);
  const token1 = new hre.ethers.Contract(await adapter.token1(), TOKEN_ABI, signer);
  const bonusToken = new hre.ethers.Contract(await escrow.bonusToken(), TOKEN_ABI, signer);

  const recorded = (adapterEntry.campaigns || [])[0];
  const rawCampaign = process.env.LP_REHEARSAL_CAMPAIGN_ID || (recorded && recorded.id);
  if (!rawCampaign) throw new Error("Set LP_REHEARSAL_CAMPAIGN_ID: the adapter's registry entry records no campaign");
  const campaignId = /^0x[0-9a-fA-F]{64}$/.test(rawCampaign) ? rawCampaign : hre.ethers.id(rawCampaign);
  const campaign = await adapter.campaigns(campaignId);
  if (campaign.tickLower === campaign.tickUpper) throw new Error(`Campaign ${campaignId} is not configured on ${adapter.target}`);

  return {
    adapter,
    escrow,
    vault,
    npm,
    npmAddress,
    pool,
    token0,
    token1,
    bonusToken,
    campaignId,
    campaign,
    fee: Number(await adapter.fee()),
    tickSpacing: Number(await adapter.tickSpacing()),
    bonusDecimals: Number(await bonusToken.decimals()),
    bonusSymbol: await bonusToken.symbol(),
  };
}

/** The MockSoulZapCaller to use: the env override, else the one recorded by phase `caller`. */
async function resolveCaller(record, signer, stack) {
  const address = readAddressEnv("LP_REHEARSAL_CALLER", record.caller);
  const caller = await hre.ethers.getContractAt("MockSoulZapCaller", address, signer);
  if (!(await stack.adapter.soulZapCallers(address)) || !(await stack.adapter.campaignCallers(stack.campaignId, address))) {
    throw new Error(
      `The caller ${address} is not allowlisted on the adapter for campaign ${stack.campaignId}. The timelock ` +
        `must send setSoulZapCaller and setCampaignCaller first (or redeploy the route with it in ` +
        `LP_APEBOND_SOULZAP_CALLERS).`
    );
  }
  return caller;
}

/** Mints a position on the campaign's exact range into `recipient`, from the signer's tokens. */
async function mintCampaignPosition(stack, signer, recipient, range) {
  const [tickLower, tickUpper] = range || [Number(stack.campaign.tickLower), Number(stack.campaign.tickUpper)];
  const slot0 = await stack.pool.slot0();
  const d0 = Number(await stack.token0.decimals());
  const d1 = Number(await stack.token1.decimals());
  let amount0;
  let amount1;
  if (process.env.LP_REHEARSAL_AMOUNT0 || process.env.LP_REHEARSAL_AMOUNT1) {
    amount0 = hre.ethers.parseUnits((process.env.LP_REHEARSAL_AMOUNT0 || "0").trim(), d0);
    amount1 = hre.ethers.parseUnits((process.env.LP_REHEARSAL_AMOUNT1 || "0").trim(), d1);
  } else {
    const budgetBps = BigInt(process.env.LP_REHEARSAL_BUDGET_BPS || DEFAULT_BUDGET_BPS);
    ({ amount0, amount1 } = defaultMintAmounts({
      sqrtPriceX96: slot0.sqrtPriceX96,
      tickLower,
      tickUpper,
      balance0: await stack.token0.balanceOf(signer.address),
      balance1: await stack.token1.balanceOf(signer.address),
      budgetBps,
    }));
  }
  console.log(
    `Minting on [${tickLower}, ${tickUpper}] (pool tick ${slot0.tick}): ` +
      `${hre.ethers.formatUnits(amount0, d0)} ${await stack.token0.symbol()} + ` +
      `${hre.ethers.formatUnits(amount1, d1)} ${await stack.token1.symbol()} desired`
  );
  await ensureAllowance(stack.token0, signer, stack.npmAddress, amount0, "token0 -> NonfungiblePositionManager");
  await ensureAllowance(stack.token1, signer, stack.npmAddress, amount1, "token1 -> NonfungiblePositionManager");
  const receipt = await pools.send("Minting the position", signer, (o) =>
    stack.npm.mint(
      [
        stack.token0.target,
        stack.token1.target,
        stack.fee,
        tickLower,
        tickUpper,
        amount0,
        amount1,
        0,
        0,
        recipient,
        FAR_DEADLINE,
      ],
      o
    )
  );
  return mintedTokenId(receipt, stack.npmAddress);
}

const units = (stack, value) => `${hre.ethers.formatUnits(value, stack.bonusDecimals)} ${stack.bonusSymbol}`;

/** One purchase through the caller contract; returns the deposit event's figures. */
async function purchase(stack, signer, caller, beneficiary, { loop = false } = {}) {
  const tokenId = await mintCampaignPosition(stack, signer, caller.target);
  const receipt = loop
    ? await pools.send(`Buying AND unstaking token ${tokenId} in one transaction (the P2 loop)`, signer, (o) =>
        caller.depositAndUnstake(stack.adapter.target, stack.npmAddress, tokenId, stack.campaignId, stack.vault.target, o)
      )
    : await pools.send(`Depositing token ${tokenId} for ${beneficiary}`, signer, (o) =>
        caller.deposit(stack.adapter.target, stack.npmAddress, tokenId, stack.campaignId, beneficiary, o)
      );
  const deposited = findEvent(receipt, stack.adapter, "ApeBondPositionDeposited");
  if (!deposited) throw new Error(`No ApeBondPositionDeposited in ${receipt.hash}`);
  console.log(
    `  position value ${units(stack, deposited.positionValue)} at TWAP tick ${deposited.twapTick}; ` +
      `bonus ${units(stack, deposited.bonusAmount)}` +
      (deposited.bonusAmount > 0n ? ` unlocking at ${deposited.bonusUnlockAt}` : " (below the campaign's minimum: no reservation)")
  );
  return { tokenId, receipt, deposited };
}

// ──────────────────────── phases ────────────────────────

async function runCaller({ chainId, signer, record, recordFile }) {
  const deployed = await deployContract("MockSoulZapCaller", [], signer);
  record.caller = deployed.address;
  record.callerTx = deployed.tx.hash;
  writeRecord(recordFile, record);
  console.log(
    `\nAllowlist it on the adapter: pass LP_APEBOND_SOULZAP_CALLERS=${deployed.address} to the route's deploy\n` +
      `(deploy-lp-staking.js with LP_APEBOND_ENABLED=1, or deploy-apebond.js) BEFORE the adapter is handed to\n` +
      `the timelock; afterwards it takes setSoulZapCaller + setCampaignCaller through the timelock.`
  );
}

async function runDeposit({ signer, stack, record, recordFile }) {
  const caller = await resolveCaller(record, signer, stack);
  const beneficiary = readAddressEnv("LP_REHEARSAL_BENEFICIARY", signer.address);
  const { tokenId, receipt, deposited } = await purchase(stack, signer, caller, beneficiary);
  const [, amount, unlockAt, , forfeited] = await stack.escrow.reservationOf(tokenId);
  record.purchases.push({
    kind: "deposit",
    tokenId: tokenId.toString(),
    beneficiary,
    depositTx: receipt.hash,
    positionValue: deposited.positionValue.toString(),
    bonus: amount.toString(),
    unlockAt: Number(unlockAt),
    forfeited,
  });
  writeRecord(recordFile, record);
  console.log(`\nEscrow totalReserved: ${units(stack, await stack.escrow.totalReserved())}`);
}

async function runLoop({ signer, stack, record, recordFile }) {
  const caller = await resolveCaller(record, signer, stack);
  const { tokenId, receipt, deposited } = await purchase(stack, signer, caller, caller.target, { loop: true });
  const forfeitedEvent = findEvent(receipt, stack.escrow, "BonusForfeited");
  const [, amount, , , forfeited] = await stack.escrow.reservationOf(tokenId);
  if (deposited.bonusAmount > 0n && (!forfeitedEvent || !forfeited || amount !== 0n)) {
    throw new Error(`The loop kept its bonus: BonusForfeited ${forfeitedEvent ? "emitted" : "MISSING"}, forfeited=${forfeited}, amount=${amount}`);
  }
  console.log(
    deposited.bonusAmount > 0n
      ? `  OK: BonusForfeited(${tokenId}, ${caller.target}, ${units(stack, forfeitedEvent.amount)}) in the same transaction`
      : "  (no bonus was reserved, so there was nothing to forfeit)"
  );
  record.purchases.push({ kind: "loop", tokenId: tokenId.toString(), beneficiary: caller.target, depositTx: receipt.hash, bonus: "0", forfeited: true });
  writeRecord(recordFile, record);
}

async function runWithdrawal({ signer, stack, record, recordFile }) {
  const caller = await resolveCaller(record, signer, stack);
  const { tokenId: id0, deposited } = await purchase(stack, signer, caller, signer.address);
  const bonus0 = deposited.bonusAmount;
  if (bonus0 === 0n) throw new Error("The purchase earned no bonus; raise the mint size (LP_REHEARSAL_BUDGET_BPS)");

  const slot0 = await stack.pool.slot0();
  const grid = alignDown(slot0.tick, stack.tickSpacing);
  const r1 = readRange("LP_REHEARSAL_R1_TICKS", [grid - WITHDRAWAL_WIDTH_TICKS, grid + stack.tickSpacing]);
  const r2 = readRange("LP_REHEARSAL_R2_TICKS", [grid, grid + WITHDRAWAL_WIDTH_TICKS + stack.tickSpacing]);
  const noSwap = [false, 0, 0, 0, 0];

  let current = id0;
  const steps = [];
  for (const [label, range] of [["rebalance 1", r1], ["rebalance 2", r2]]) {
    const receipt = await pools.send(`${label}: token ${current} -> [${range[0]}, ${range[1]}], no swap`, signer, (o) =>
      stack.vault.rebalance(current, range[0], range[1], noSwap, FAR_DEADLINE, o)
    );
    const moved = findEvent(receipt, stack.escrow, "BonusMoved");
    const rebalanced = findEvent(receipt, stack.vault, "Rebalanced");
    if (!moved) throw new Error(`${label}: no BonusMoved — the reservation was not active or the link is wrong`);
    const ppm = (moved.newAmount * 1_000_000n) / bonus0;
    console.log(
      `  ${label}: bonus ${units(stack, moved.previousAmount)} -> ${units(stack, moved.newAmount)} ` +
        `(${Number(ppm) / 10_000} % of the original); refunded ${rebalanced.amount0Refunded} token0 / ${rebalanced.amount1Refunded} token1`
    );
    steps.push({ label, range, newTokenId: moved.newTokenId.toString(), amount: moved.newAmount.toString(), ppmOfOriginal: Number(ppm), tx: receipt.hash });
    current = moved.newTokenId;
  }
  record.purchases.push({ kind: "withdrawal", tokenId: current.toString(), originalTokenId: id0.toString(), beneficiary: signer.address, bonus: bonus0.toString(), steps });
  writeRecord(recordFile, record);
}

async function runClaim({ signer, stack, record, recordFile }) {
  const now = (await hre.ethers.provider.getBlock("latest")).timestamp;
  for (const p of record.purchases) {
    if (p.claimTx) continue;
    const [beneficiary, amount, unlockAt, claimed, forfeited] = await stack.escrow.reservationOf(p.tokenId);
    if (beneficiary === hre.ethers.ZeroAddress) {
      console.log(`token ${p.tokenId}: no reservation (moved, or never reserved)`);
      continue;
    }
    if (claimed || forfeited || now < Number(unlockAt)) {
      console.log(`token ${p.tokenId}: ${claimed ? "already claimed" : forfeited ? "FORFEITED" : `locked until ${unlockAt} (now ${now})`}`);
      continue;
    }
    try {
      const receipt = await pools.send(`Claiming ${units(stack, amount)} for token ${p.tokenId}`, signer, (o) => stack.escrow.claim(p.tokenId, o));
      p.claimTx = receipt.hash;
      writeRecord(recordFile, record);
    } catch (error) {
      const data = error.data || (error.error && error.error.data);
      let reason = error.shortMessage || error.message;
      try {
        const parsed = stack.escrow.interface.parseError(data);
        if (parsed && parsed.name === "InsufficientFunds") {
          reason = `InsufficientFunds: needs ${units(stack, parsed.args.needed)}, the escrow holds ${units(stack, parsed.args.balance)} — fund it with scripts/fund-escrow.js`;
        } else if (parsed) reason = parsed.name;
      } catch {
        /* not an escrow error */
      }
      console.log(`token ${p.tokenId}: claim reverted — ${reason}`);
    }
  }
}

async function runStatus({ stack, record }) {
  console.log(`Escrow ${stack.escrow.target}: totalReserved ${units(stack, await stack.escrow.totalReserved())}, balance ${units(stack, await stack.bonusToken.balanceOf(stack.escrow.target))}`);
  for (const p of record.purchases) {
    const [beneficiary, amount, unlockAt, claimed, forfeited] = await stack.escrow.reservationOf(p.tokenId);
    console.log(`  token ${p.tokenId} (${p.kind}): beneficiary ${beneficiary}, amount ${units(stack, amount)}, unlockAt ${unlockAt}, claimed ${claimed}, forfeited ${forfeited}`);
  }
}

async function main() {
  const chainId = await pools.chainId();
  if (pools.isMainnet(chainId)) {
    throw new Error("apebond-rehearsal.js refuses to run on mainnet: it mints and stakes test positions.");
  }
  const phase = readPhase();
  const signer = await pools.getSigner();
  const recordFile = resolveRecordFile(chainId);
  const record = readRecord(recordFile);
  console.log(`ApeBond rehearsal — phase ${phase} on chain ${chainId} (${hre.network.name}), signer ${signer.address}`);

  if (phase === "caller") return runCaller({ chainId, signer, record, recordFile });

  const stack = await resolveStack(chainId, signer);
  const c = stack.campaign;
  console.log(
    `Adapter ${stack.adapter.target}, escrow ${stack.escrow.target}, vault ${stack.vault.target}\n` +
      `Campaign ${stack.campaignId}: range ${c.tickLower}..${c.tickUpper}, cliff ${c.bonusCliffSeconds}s, ` +
      `rate ${c.bonusBps} bps, minimum ${units(stack, c.minBonusAmount)}, ${c.enabled ? "enabled" : "DISABLED"}`
  );
  const context = { chainId, signer, stack, record, recordFile };
  if (phase === "deposit") return runDeposit(context);
  if (phase === "loop") return runLoop(context);
  if (phase === "withdrawal") return runWithdrawal(context);
  if (phase === "claim") return runClaim(context);
  return runStatus(context);
}

module.exports = { PHASES, readPhase, resolveRecordFile, defaultMintAmounts, alignDown };

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
