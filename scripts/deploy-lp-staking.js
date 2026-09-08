const hre = require("hardhat");
const pools = require("./lib/pools");
const uniswapByChain = require("./lib/uniswap");
// Only the registry kind of the timelock is needed here. Since the bootstrap stopped
// routing anything through the timelock (N-7), this script builds no timelock operation.
const { TIMELOCK_KIND } = require("./lp-timelock");

// Deploy the full LP staking stack and record every address in deployments.json.
//
// ──────────────────────── the bootstrap, and why it looks like this ────────────────────────
//
// Both UUPS proxies are born owned by the LPTimelock: `initialize` names the timelock as the
// owner inside the proxy's own deployment transaction, and no key ever holds the owner tier
// on them, not even for one block. That is possible because the one owner-only call the
// bootstrap used to need — `setZapper` on the vault — is gone from the bootstrap: the
// zapper's address is an `initialize` argument, and it is known before the zapper exists.
//
// A CREATE address is a pure function of (deployer, nonce), and every transaction in this
// script carries an explicit nonce (see `deployContract`), so the next three addresses are
// computable at any point in the run. The vault implementation takes nonce N, the vault
// proxy N + 1 and the zapper N + 2; the script computes N + 2 with `getCreateAddress`,
// passes it to the vault's `initialize`, deploys the zapper, and asserts it landed there.
// If it did not, the run throws and names the one repair: `setZapper` through the timelock.
//
// The order, in full:
//
//   1. config, local validation and the on-chain checks (pool triple, decimals, factory)
//   2. `LPTimelock(minDelay, [multisig], [multisig], address(0))` — depends on nothing,
//      and everything below names it, so it goes first
//   3. `TokenX(name, symbol, owner = DEPLOYER)` — the deployer must call `setMinter`
//   4. RewardsDistributor implementation + LPProxy,
//      `initialize(owner = timelock, guardian, operator, signer)`
//   5. predict the zapper's address from the deployer's next-but-two nonce
//   6. LPStakingVault implementation + LPProxy,
//      `initialize(owner = timelock, guardian, operator, zapper = predicted, window, ticks)`
//   7. `LPZapper(vault, …, owner = DEPLOYER, window, ticks)`; record it, then assert the
//      address matches the prediction
//   8. ONLY with LP_APEBOND_ENABLED=1: the same prediction trick a second time — predict the
//      adapter's address, deploy the BonusEscrow implementation + LPProxy with
//      `initialize(owner = timelock, adapter = predicted)`, deploy
//      `ApeBondPositionAdapter(…, owner = DEPLOYER, guardian, purchaseSigner)`, record it,
//      then assert it landed on the predicted address
//   9. `tokenX.setMinter(distributor)`, the optional `tokenX.setEpochCap(id, cap)`, and —
//      with the route on — `adapter.setSoulZapCaller(c, true)` for every LP_APEBOND_SOULZAP_CALLERS entry
//  10. `adapter.transferOwnership(timelock)` (plain `Ownable`, effective in that block), then
//      `tokenX.transferOwnership(operator)` and `zapper.transferOwnership(operator)` —
//      `Ownable2Step`, so those two only NOMINATE; skipped when the operator IS the deployer
//  11. `increaseObservationCardinalityNext` on the pool (permissionless)
//  12. post-deploy verification, the address summary, the verify commands
//
// The one remaining bootstrap window: NONE on the proxies. TokenX and LPZapper stay owned by
// the DEPLOYER until the operator multisig sends `acceptOwnership()` on each — two plain
// transactions, no timelock, printed by this run. Neither contract can move a staker's
// position or a user's funds; what the deployer still holds until then is TokenX's minter
// wiring and the zapper's sweep.
//
// ──────────────────────── the three admin tiers ────────────────────────
//
// owner    = the LPTimelock. Upgrades, `setZapper`, `setGuardian`, `setOperator`, the ASSET
//            leg switch — every one of them scheduled, public for `minDelay`, then executed.
// guardian = LP_GUARDIAN, a hot key. The three pause switches, with no delay and nothing
//            else. Required, and it must NOT be the operator.
// operator = LP_OPERATOR, a multisig. The vault's `setTwapParams` and `rescuePosition`, the
//            distributor's `setSigner` and `recoverExcessAsset`, and those same three pause
//            switches as the cold fallback for a lost guardian key. Also the owner of TokenX
//            and LPZapper. Required.
//
// ──────────────────────── the optional ApeBond route ────────────────────────
//
// `BonusEscrow` is a third UUPS proxy and follows the same born-owned rule: its `initialize`
// names the timelock as owner AND the adapter it will accept reservations from, so no key
// holds its owner tier for even one block and `setAdapter` is never needed at bootstrap. The
// adapter's address is predicted from the deployer's nonce exactly as the zapper's is.
//
// `ApeBondPositionAdapter` is plain `Ownable`, not a proxy, and goes to the TIMELOCK — not the
// operator — in one transaction, because its owner tier is the SoulZap allowlist and the
// guardian rotation. Its SoulZap entries are written by the DEPLOYER before that transfer.
//
// One call is left over, and deliberately: `vault.setStakeOperator(adapter, true)` is
// owner-tier on a vault the timelock owns from birth, so this run cannot make it. The run
// prints the exact schedule/execute line for the multisig and reports the missing allowlist
// entry as a WARN rather than a failure. Until it executes, ApeBond `depositFor` reverts
// `NotZapper` and nothing else is affected.
//
// Required env
//   LP_ASSET       — ASSET token (18 decimals), one side of the pool
//   LP_USDC        — USDC token (6 decimals), the other side and the zap-in token
//   LP_POOL        — the Uniswap V3 ASSET-USDC pool this stack is bound to
//   LP_SIGNER      — backend voucher signer for RewardsDistributor; MUST NOT be
//                    the deployer or the multisig — it signs EIP-712 payloads on
//                    every claim, which a Ledger cannot serve
//   LP_MULTISIG    — the timelock's sole proposer, executor and canceller
//   LP_GUARDIAN    — pause tier on BOTH proxies: the vault's two pause switches and the
//                    distributor's, with no delay and nothing else. A hot key, and the run
//                    throws if it equals LP_OPERATOR
//   LP_OPERATOR    — routine-operations tier on BOTH proxies (setTwapParams,
//                    rescuePosition, setSigner, recoverExcessAsset, plus the three pause
//                    switches as the cold fallback), and the owner TokenX and LPZapper are
//                    handed to
//   LP_TOKENX_NAME / LP_TOKENX_SYMBOL — TokenX branding, decided at deploy time
//
// Optional env (defaults in parentheses)
//   LP_NPM                    — NonfungiblePositionManager (per-chain default, see
//                               scripts/lib/uniswap.js)
//   LP_ROUTER                 — SwapRouter02 (per-chain default, same file)
//   LP_FACTORY                — UniswapV3Factory (per-chain default, same file). Only read
//                               to prove LP_POOL is the factory's canonical pool
//   LP_FEE                    — pool fee tier in hundredths of a bip (3000)
//   LP_TWAP_WINDOW            — TWAP lookback in seconds, 300..3600 (300)
//   LP_TWAP_MAX_DEVIATION_BPS — spot-vs-TWAP ceiling in BPS, <= 2000 (1000). The contract
//                               stores TICKS; this script converts exactly with
//                               floor(ln(1 + bps/1e4) / ln(1.0001)) and logs both numbers.
//                               500 bps = 487 ticks, 1000 = 953, 2000 = 1823
//   LP_TIMELOCK_MIN_DELAY     — seconds between a scheduled operation and its earliest
//                               execution (172800 = 48 h, the mainnet figure). Sepolia
//                               staging runs 300 so the flow can be rehearsed end to end;
//                               the fork suites run 60. 0 is legal and means no delay at all,
//                               which is only ever right on a throwaway chain
//   LP_EPOCH_ID               — first epoch id to arm on TokenX (none)
//   LP_EPOCH_CAP              — that epoch's mint cap, in whole TokenX (none)
//   LP_OBSERVATION_CARDINALITY — oracle slots to grow the pool into (150). Must be at least
//                               2 * ceil(LP_TWAP_WINDOW / 12): one slot per block in the
//                               worst case, doubled for margin. 300 s needs >= 50, 3600 s
//                               needs >= 600
//
// Optional env — the ApeBond route (SoulZap integration spec §6). The whole section is OFF
// unless LP_APEBOND_ENABLED=1, and a run without it deploys exactly the stack this script
// deployed before the integration existed: same contracts, same transactions, same registry
// keys. None of the variables below is read while the flag is absent; the run states in one
// line that the route is not part of it, and that is the whole difference.
//   LP_APEBOND_ENABLED        — 1 deploys BonusEscrow + ApeBondPositionAdapter alongside the
//                               stack and wires them; 0 or unset deploys neither (unset)
//   LP_APEBOND_BONUS_TOKEN    — token every campaign bonus is denominated and paid in. It is
//                               the escrow implementation's one immutable, so it can never be
//                               changed by an upgrade (LP_ASSET)
//   LP_APEBOND_GUARDIAN       — the adapter's undelayed fast path: setPurchaseSigner and
//                               setDepositsPaused. Defaults to LP_OPERATOR, the multisig that
//                               holds the same two rights on the distributor (LP_OPERATOR)
//   LP_APEBOND_PURCHASE_SIGNER — backend key whose EIP-712 signature authorizes a purchase.
//                               UNSET leaves it address(0), which is the deposit path CLOSED:
//                               every depositFor reverts InvalidSignature until the guardian
//                               opens it with one undelayed setPurchaseSigner. That is the
//                               deliberate default — a campaign is opened when it starts,
//                               not when it is deployed (none)
//   LP_APEBOND_SOULZAP_CALLERS — comma-separated SoulZap contracts allowed to present an
//                               authorization to depositFor. Empty allowlists nobody, which
//                               is the other half of the same closed default (none)
//
// Mainnet needs CONFIRM=yes, like every other state-changing script here.

// ERC-1967 implementation slot: keccak256("eip1967.proxy.implementation") - 1.
const ERC1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

// 48 h, the figure `docs/specs/01-contracts.md` §2.5 proposes for mainnet. Every upgrade is
// visible on-chain for at least this long before it can execute, and `unstake` is never
// pausable, so the delay IS the exit window.
const DEFAULT_TIMELOCK_MIN_DELAY = 172800;

// The two exceptions the spec grants the proxies (§1): both implementations keep their fixed
// protocol references `immutable`, set in a constructor that ends with `_disableInitializers()`.
const UUPS_UNSAFE_ALLOW = ["constructor", "state-variable-immutable"];

const VALID_FEE_TIERS = [100, 500, 3000, 10000];
const MIN_TWAP_WINDOW = 300; // TwapGuard.MIN_TWAP_WINDOW
const MAX_TWAP_WINDOW = 3600; // TwapGuard.MAX_TWAP_WINDOW
const MAX_TWAP_DEVIATION_TICKS = 1823; // TwapGuard.MAX_TWAP_DEVIATION_TICKS
// The guard's defaults, decided 2026-08-26 from the spec review: a WIDE circuit breaker.
// 300 s of lookback clears within ~1-2.5 minutes even after a 20% crash, and 1000 bps never
// trips below a 10% instantaneous move — so `rebalance` stays available exactly when a
// position has fallen out of range and needs it. The caller's own minimums remain the
// primary protection; see `libraries/TwapGuard.sol`.
const DEFAULT_TWAP_WINDOW = 300;
const DEFAULT_TWAP_MAX_DEVIATION_BPS = 1000;

// Observation slots. A pool fills at most one per block, so `window / 12` seconds of history
// is `ceil(window / 12)` slots in the worst case (every block trading); doubling that leaves
// room for the burst of activity a crash produces, which is exactly when the guard is read.
const DEFAULT_OBSERVATION_CARDINALITY = 150;
const SECONDS_PER_BLOCK = 12;
const CARDINALITY_MARGIN = 2;

/** Smallest cardinality that can hold `window` seconds of history with margin. */
function requiredCardinality(window) {
  return CARDINALITY_MARGIN * Math.ceil(window / SECONDS_PER_BLOCK);
}

/**
 * Exact basis-points -> ticks conversion, the one the guard's NatSpec states.
 *
 * A tick is a 1.0001x price step and steps compound, so a deviation of `bps` basis points
 * is `floor(ln(1 + bps/1e4) / ln(1.0001))` ticks. The human-facing knob stays in bps
 * because that is how a risk limit is discussed; the contract stores the tick count,
 * because that is what it compares against. Doing the log here rather than on-chain keeps
 * an immutable contract free of a fixed-point logarithm it would only use for a circuit
 * breaker.
 */
function bpsToTicks(bps) {
  return Math.floor(Math.log(1 + bps / 1e4) / Math.log(1.0001));
}

const ASSET_DECIMALS = 18;
const USDC_DECIMALS = 6;
const TOKENX_DECIMALS = 18;

/** Reads an address env var, applies a default and normalises the checksum. */
function readAddress(name, fallback) {
  const raw = process.env[name] || fallback;
  if (!raw) throw new Error(`Set ${name}`);
  try {
    return hre.ethers.getAddress(raw);
  } catch {
    throw new Error(`${name} is not a valid address: ${raw}`);
  }
}

/**
 * Reads a comma-separated address list. Unset and empty both mean the EMPTY list — never a
 * list holding one empty entry, which is the classic way a trailing comma turns into a call
 * against address(0). Every entry is checksummed here, and a repeat is refused rather than
 * sent twice.
 */
function readAddressList(name) {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return [];

  const seen = new Set();
  return raw.split(",").map((entry, index) => {
    const value = entry.trim();
    if (!value) throw new Error(`${name} has an empty entry at position ${index}`);
    let address;
    try {
      address = hre.ethers.getAddress(value);
    } catch {
      throw new Error(`${name} entry ${index} is not a valid address: ${value}`);
    }
    if (seen.has(address)) throw new Error(`${name} lists ${address} twice`);
    seen.add(address);
    return address;
  });
}

/**
 * The ApeBond section's master switch, read strictly.
 *
 * Only "1" turns it on and only "0" or an absent value turn it off; anything else throws.
 * A typo (`LP_APEBOND_ENABLED=true`) must not silently deploy half a campaign — or, worse,
 * silently skip the escrow on the run that was supposed to carry it.
 */
function readApeBondFlag() {
  const raw = process.env.LP_APEBOND_ENABLED;
  if (raw === undefined || raw.trim() === "" || raw === "0") return false;
  if (raw === "1") return true;
  throw new Error(`LP_APEBOND_ENABLED must be 1, 0 or unset — got ${raw}`);
}

/** Deploys one contract with an explicit nonce and returns it with its receipt. */
async function deployContract(name, args, deployer) {
  const nonce = await pools.resolveNonce(deployer.address);
  console.log(`\nDeploying ${name}... (nonce ${nonce})`);
  const factory = await hre.ethers.getContractFactory(name);
  const contract = await factory.deploy(...args, { nonce });
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  const tx = contract.deploymentTransaction();
  const receipt = await hre.ethers.provider.getTransactionReceipt(tx.hash);

  console.log(`  ${name}: ${address}`);
  console.log(`  ${pools.explorerAddress(await pools.chainId(), address)}`);
  console.log(`  deploy tx: ${tx.hash}`);
  return { contract, address, tx, receipt };
}

/**
 * Deploys one UUPS implementation and the `LPProxy` in front of it, and registers the pair in
 * the `hardhat-upgrades` manifest.
 *
 * Three steps, each of which answers a different question:
 *
 *   - `validateImplementation` — is this contract safe behind a proxy at all? It reads the
 *     build info only, sends nothing, and rejects `selfdestruct`, `delegatecall`, state
 *     written from a constructor and a missing `_authorizeUpgrade`. Cheaper to fail here than
 *     to find out after the implementation is on chain.
 *   - two nonce-controlled deploys rather than `upgrades.deployProxy`, because mainnet signs
 *     through a Ledger and every transaction in this script carries an explicit nonce (see
 *     deployContract); the plugin sends its own un-nonce-able pair. `initialize` still runs
 *     inside the proxy's OWN deployment transaction — an uninitialized proxy is one
 *     `initialize` race away from belonging to whoever calls it first.
 *   - `forceImport` — writes `.openzeppelin/<network>.json`, which is the storage layout every
 *     future `validateUpgrade` grades a new implementation against. Skipping it would leave
 *     the deployed layout unrecorded, and the first upgrade with nothing to compare to.
 */
async function deployProxyPair(name, constructorArgs, initArgs, deployer) {
  const factory = await hre.ethers.getContractFactory(name);

  console.log(`\nValidating ${name} as a UUPS implementation...`);
  await hre.upgrades.validateImplementation(factory, {
    kind: "uups",
    constructorArgs,
    unsafeAllow: UUPS_UNSAFE_ALLOW,
  });
  console.log(`  ${name} passes the UUPS implementation checks`);

  const impl = await deployContract(name, constructorArgs, deployer);
  const initData = impl.contract.interface.encodeFunctionData("initialize", initArgs);
  const proxy = await deployContract("LPProxy", [impl.address, initData], deployer);

  await hre.upgrades.forceImport(proxy.address, factory, {
    kind: "uups",
    constructorArgs,
  });
  // Where that file lands is the plugin's call, not ours: a named network writes
  // `.openzeppelin/<network>.json` in the repo (committed — it is the layout baseline), while
  // a development chain (31337, anvil, a spawned `hardhat node`) writes into the OS temp
  // directory instead, so a fork run leaves nothing behind to clean up.
  console.log(`  recorded in the hardhat-upgrades manifest for network ${hre.network.name}`);

  return {
    impl,
    proxy,
    initData,
    address: proxy.address,
    tx: proxy.tx,
    receipt: proxy.receipt,
    contract: await hre.ethers.getContractAt(name, proxy.address, deployer),
  };
}

async function main() {
  const chainId = await pools.chainId();
  const mainnet = pools.isMainnet(chainId);
  const deployer = await pools.getSigner();

  // ──────────────────────── config ────────────────────────

  const uniswap = uniswapByChain.forChain(chainId);

  const asset = readAddress("LP_ASSET");
  const usdc = readAddress("LP_USDC");
  const poolAddress = readAddress("LP_POOL");
  const positionManager = readAddress("LP_NPM", uniswap.positionManager);
  const swapRouter = readAddress("LP_ROUTER", uniswap.swapRouter02);
  // Read only for the canonical-pool check below (C-2). Nothing on chain is bound to it.
  const factoryAddress = readAddress("LP_FACTORY", uniswap.factory);
  const signer = readAddress("LP_SIGNER");
  const multisig = readAddress("LP_MULTISIG");
  // Pause tier on BOTH proxies: the vault's two pause switches and the distributor's, with
  // no delay and nothing else. A HOT key — it is meant to be reachable at three in the
  // morning — which is why it is required and must be a different address from the operator:
  // a key held for speed and a key held for value must not be the same key.
  const guardian = readAddress("LP_GUARDIAN");
  // Routine-operations tier on BOTH proxies (2026-09-09 role split): the vault's TWAP
  // calibration and NFT rescue, the distributor's signer rotation and ASSET recovery, plus
  // all three pause switches as the cold fallback for a lost guardian key. It is also the
  // address TokenX and LPZapper are handed to, and the address rescued NFTs and recovered
  // ASSET are sent to. Required.
  const operator = readAddress("LP_OPERATOR");

  // The timelock's own parameter. 48 h on mainnet; staging and the fork suites shorten it so
  // the schedule -> execute flow is rehearsable rather than theoretical.
  const timelockMinDelay = Number(process.env.LP_TIMELOCK_MIN_DELAY || DEFAULT_TIMELOCK_MIN_DELAY);

  // ──── the ApeBond route, off unless asked for ────
  //
  // Every value below is read only when the flag is on, so an operator who never heard of the
  // integration cannot be tripped up by a stale LP_APEBOND_* left in a shell: with the flag
  // off nothing here is read, nothing is deployed and nothing is recorded.
  //
  // The two "closed" defaults are the point of the section: no purchase signer and no SoulZap
  // caller, so a freshly deployed adapter accepts nothing from anyone. Opening it is a
  // separate, deliberate act — the guardian's undelayed `setPurchaseSigner` for the signer,
  // the timelock's delayed `setSoulZapCaller` for a caller.
  const apeBond = readApeBondFlag();
  const bonusToken = apeBond ? readAddress("LP_APEBOND_BONUS_TOKEN", asset) : null;
  const apeBondGuardian = apeBond ? readAddress("LP_APEBOND_GUARDIAN", operator) : null;
  const purchaseSigner =
    apeBond && process.env.LP_APEBOND_PURCHASE_SIGNER
      ? readAddress("LP_APEBOND_PURCHASE_SIGNER")
      : hre.ethers.ZeroAddress;
  const soulZapCallers = apeBond ? readAddressList("LP_APEBOND_SOULZAP_CALLERS") : [];

  const fee = Number(process.env.LP_FEE || 3000);
  const twapWindow = Number(process.env.LP_TWAP_WINDOW || DEFAULT_TWAP_WINDOW);
  const twapMaxDeviationBps = Number(
    process.env.LP_TWAP_MAX_DEVIATION_BPS || DEFAULT_TWAP_MAX_DEVIATION_BPS
  );
  const twapMaxDeviationTicks = bpsToTicks(twapMaxDeviationBps);
  const observationCardinality = Number(
    process.env.LP_OBSERVATION_CARDINALITY || DEFAULT_OBSERVATION_CARDINALITY
  );

  const tokenXName = process.env.LP_TOKENX_NAME;
  const tokenXSymbol = process.env.LP_TOKENX_SYMBOL;
  if (!tokenXName || !tokenXSymbol) throw new Error("Set LP_TOKENX_NAME and LP_TOKENX_SYMBOL");

  const epochId = process.env.LP_EPOCH_ID;
  const epochCapRaw = process.env.LP_EPOCH_CAP;
  if (Boolean(epochId) !== Boolean(epochCapRaw)) {
    throw new Error("LP_EPOCH_ID and LP_EPOCH_CAP must be set together, or neither");
  }
  // LP_EPOCH_CAP is given in whole TokenX, not wei — the same convention as
  // REWARD_AMOUNT in fund-rewards.js.
  const epochCap = epochCapRaw ? hre.ethers.parseUnits(epochCapRaw, TOKENX_DECIMALS) : undefined;

  // ──────────────────────── local validation ────────────────────────

  if (asset === usdc) throw new Error("LP_ASSET and LP_USDC must be different tokens");
  // The guardian is a hot key and the operator is a multisig; one address holding both tiers
  // is a hot key holding the operator tier, which is the arrangement the role split exists to
  // prevent. This is the one role rule that is fatal.
  if (guardian === operator) {
    throw new Error(
      `LP_GUARDIAN and LP_OPERATOR must be different addresses — both are ${guardian}. ` +
        `The guardian is a hot pause key; the operator is a multisig that can move value.`
    );
  }
  if (!VALID_FEE_TIERS.includes(fee)) {
    throw new Error(`LP_FEE must be one of ${VALID_FEE_TIERS.join(", ")} — got ${fee}`);
  }
  if (!Number.isInteger(twapWindow) || twapWindow < MIN_TWAP_WINDOW || twapWindow > MAX_TWAP_WINDOW) {
    throw new Error(
      `LP_TWAP_WINDOW must be an integer in ${MIN_TWAP_WINDOW}..${MAX_TWAP_WINDOW} — got ${twapWindow}`
    );
  }
  if (
    !Number.isInteger(twapMaxDeviationBps) ||
    twapMaxDeviationBps <= 0 ||
    twapMaxDeviationTicks < 1 ||
    twapMaxDeviationTicks > MAX_TWAP_DEVIATION_TICKS
  ) {
    throw new Error(
      `LP_TWAP_MAX_DEVIATION_BPS must convert into 1..${MAX_TWAP_DEVIATION_TICKS} ticks — ` +
        `got ${twapMaxDeviationBps} bps = ${twapMaxDeviationTicks} ticks`
    );
  }
  if (!Number.isInteger(observationCardinality) || observationCardinality < 1 || observationCardinality > 65535) {
    throw new Error(`LP_OBSERVATION_CARDINALITY must be a uint16 — got ${observationCardinality}`);
  }
  if (!Number.isInteger(timelockMinDelay) || timelockMinDelay < 0) {
    throw new Error(
      `LP_TIMELOCK_MIN_DELAY must be a non-negative integer number of seconds — got ` +
        `${process.env.LP_TIMELOCK_MIN_DELAY}`
    );
  }
  // Sizing the oracle is a liveness dependency, not a nicety: a buffer too small for the
  // window makes `observe()` revert `OLD` and takes both swap legs down with it, and a burst
  // of trading wraps a small buffer fastest.
  const minimumCardinality = requiredCardinality(twapWindow);
  if (observationCardinality < minimumCardinality) {
    throw new Error(
      `LP_OBSERVATION_CARDINALITY ${observationCardinality} is too small for a ${twapWindow}s ` +
        `window: at one observation per 12s block it needs at least ` +
        `${CARDINALITY_MARGIN} * ceil(${twapWindow} / ${SECONDS_PER_BLOCK}) = ${minimumCardinality} slots`
    );
  }

  // The constructors take the pair pre-sorted; sorting here removes one way to
  // get it wrong. Address comparison is on the lowercase hex, as Solidity does.
  const [token0, token1] =
    asset.toLowerCase() < usdc.toLowerCase() ? [asset, usdc] : [usdc, asset];

  // Names a collapsed role in the printout instead of leaving the reader to compare hex.
  const roleNote = (address) => {
    const parts = [];
    if (address === multisig) parts.push("= the multisig");
    if (address === deployer.address) parts.push("= the deployer");
    return parts.length > 0 ? ` (${parts.join(", ")})` : "";
  };

  console.log("Deploying the LP staking stack...");
  console.log(`Network:            chain ${chainId}`);
  console.log(`Deployer:           ${deployer.address}`);
  console.log(`ASSET:              ${asset}`);
  console.log(`USDC:               ${usdc}`);
  console.log(`Pool:               ${poolAddress}`);
  console.log(`  token0:           ${token0}`);
  console.log(`  token1:           ${token1}`);
  console.log(`  fee:              ${fee}`);
  console.log(`PositionManager:    ${positionManager}`);
  console.log(`SwapRouter02:       ${swapRouter}`);
  console.log(`Factory:            ${factoryAddress}`);
  console.log(`Voucher signer:     ${signer}`);
  console.log(`Multisig:           ${multisig}`);
  console.log(`Guardian:           ${guardian}${roleNote(guardian)}`);
  console.log(`Operator:           ${operator}${roleNote(operator)}`);
  console.log(
    `Timelock minDelay:  ${timelockMinDelay}s` +
      (timelockMinDelay === DEFAULT_TIMELOCK_MIN_DELAY ? " (48 h, the mainnet default)" : "")
  );
  console.log(`TokenX:             ${tokenXName} (${tokenXSymbol})`);
  console.log(`TWAP window:        ${twapWindow}s`);
  console.log(
    `TWAP max deviation: ${twapMaxDeviationBps} bps = ${twapMaxDeviationTicks} ticks (what the contract stores)`
  );
  console.log(
    `Initial epoch:      ${epochId ? `${epochId} capped at ${epochCapRaw} TokenX` : "NOT ARMED"}`
  );
  console.log(
    `Observation target: ${observationCardinality} (>= ${minimumCardinality} for a ${twapWindow}s window)`
  );
  if (apeBond) {
    console.log(`ApeBond route:      ENABLED (LP_APEBOND_ENABLED=1)`);
    console.log(`  bonus token:      ${bonusToken}${bonusToken === asset ? " (= ASSET)" : ""}`);
    console.log(
      `  guardian:         ${apeBondGuardian}${apeBondGuardian === operator ? " (= the operator)" : ""}`
    );
    console.log(
      `  purchase signer:  ${
        purchaseSigner === hre.ethers.ZeroAddress
          ? "NOT SET — the deposit path is closed until the guardian opens it"
          : purchaseSigner
      }`
    );
    console.log(
      `  SoulZap callers:  ${soulZapCallers.length > 0 ? soulZapCallers.join(", ") : "none"}`
    );
  } else {
    console.log(`ApeBond route:      not deployed (set LP_APEBOND_ENABLED=1 to add it)`);
  }

  // ──────────────────────── on-chain safety checks ────────────────────────

  console.log("\nChecking the configuration on-chain...");

  const codeChecks = [
    ["LP_POOL", poolAddress],
    ["LP_NPM", positionManager],
    ["LP_ROUTER", swapRouter],
    ["LP_FACTORY", factoryAddress],
    ["LP_ASSET", asset],
    ["LP_USDC", usdc],
  ];
  // The bonus token is the escrow's one immutable and no upgrade can change it, so a wrong
  // address here is a campaign settled in the wrong currency for good. It is checked with the
  // rest, and only when the route is being deployed.
  if (apeBond && bonusToken !== asset && bonusToken !== usdc) {
    codeChecks.push(["LP_APEBOND_BONUS_TOKEN", bonusToken]);
  }
  for (const [label, address] of codeChecks) {
    const code = await hre.ethers.provider.getCode(address);
    if (code === "0x") throw new Error(`No contract code at ${label} ${address} on chain ${chainId}`);
  }

  // The vault and the zapper both re-check the pool triple in their constructors,
  // so a mismatch would revert there anyway — but failing here costs no gas and
  // says which of the three values is wrong.
  const pool = await hre.ethers.getContractAt("IUniswapV3Pool", poolAddress);
  const poolToken0 = hre.ethers.getAddress(await pool.token0());
  const poolToken1 = hre.ethers.getAddress(await pool.token1());
  const poolFee = Number(await pool.fee());
  if (poolToken0 !== token0 || poolToken1 !== token1 || poolFee !== fee) {
    throw new Error(
      `Pool mismatch at ${poolAddress}:\n` +
        `  pool says token0=${poolToken0} token1=${poolToken1} fee=${poolFee}\n` +
        `  config says token0=${token0} token1=${token1} fee=${fee}`
    );
  }
  console.log(`  pool triple matches (token0/token1/fee)`);

  // The triple check proves the contract at LP_POOL CLAIMS these tokens and this fee. Only the
  // factory proves it IS the canonical pool for them — the pool the router will swap against
  // and the position manager will mint into. The TWAP guard is the one consumer of LP_POOL,
  // so a wrong address here would silently read an unrelated market for the life of the
  // deployment (immutable) while every swap executes against the real one.
  const FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
  const factory = new hre.ethers.Contract(factoryAddress, FACTORY_ABI, hre.ethers.provider);
  const canonicalPool = hre.ethers.getAddress(await factory.getPool(token0, token1, fee));
  if (canonicalPool !== poolAddress) {
    throw new Error(
      `LP_POOL ${poolAddress} is not the factory's pool for (${token0}, ${token1}, ${fee}) — ` +
        `factory ${factoryAddress} reports ${canonicalPool}`
    );
  }
  console.log(`  pool is the canonical factory pool`);

  // The zapper cannot tell ASSET from USDC on-chain: both are just "one side of
  // the pair", and swapping the two roles produces a stack that mints positions
  // with the legs reversed and no revert anywhere. Decimals are the one cheap
  // discriminator, so they are asserted before a single byte is deployed.
  const assetToken = await pools.getErc20(asset);
  const usdcToken = await pools.getErc20(usdc);
  const assetDecimals = Number(await assetToken.decimals());
  const usdcDecimals = Number(await usdcToken.decimals());
  if (usdcDecimals !== USDC_DECIMALS) {
    throw new Error(
      `LP_USDC ${usdc} reports ${usdcDecimals} decimals, expected ${USDC_DECIMALS} — ` +
        `LP_ASSET and LP_USDC look swapped`
    );
  }
  if (assetDecimals !== ASSET_DECIMALS) {
    throw new Error(
      `LP_ASSET ${asset} reports ${assetDecimals} decimals, expected ${ASSET_DECIMALS} — ` +
        `LP_ASSET and LP_USDC look swapped`
    );
  }
  console.log(
    `  decimals match (${await assetToken.symbol()} 18 / ${await usdcToken.symbol()} 6)`
  );

  const slot0 = await pool.slot0();
  const cardinality = Number(slot0.observationCardinality);
  const cardinalityNext = Number(slot0.observationCardinalityNext);
  console.log(`  oracle: cardinality ${cardinality}, next ${cardinalityNext}`);

  if (signer === deployer.address || signer === multisig) {
    console.log(
      "\nWARNING: LP_SIGNER is the deployer or the multisig.\n" +
        "         The signer signs an EIP-712 voucher on every claim — it must be a hot\n" +
        "         backend key, and a Ledger cannot serve that role."
    );
  }
  // The role rules that are NOT fatal. Every one of them is a collapse a staging run is
  // expected to make and a production run is not, so each is stated once, in full, and the
  // run continues: the fatal case (guardian == operator) already threw above.
  const collapses = [];
  if (guardian === multisig) collapses.push("LP_GUARDIAN is the multisig");
  if (operator === multisig) collapses.push("LP_OPERATOR is the multisig");
  if (guardian === deployer.address) collapses.push("LP_GUARDIAN is the deploying key");
  if (operator === deployer.address) collapses.push("LP_OPERATOR is the deploying key");
  if (collapses.length > 0) {
    console.log(
      "\nWARNING: the admin tiers are collapsed onto fewer addresses than the model assumes:\n" +
        collapses.map((line) => `         - ${line}`).join("\n") +
        "\n         That is the staging arrangement. On mainnet the guardian is a hot key, the\n" +
        "         operator is a multisig, and neither is the key that signs this deployment."
    );
  }

  if (!epochId) {
    console.log(
      "\nWARNING: LP_EPOCH_ID / LP_EPOCH_CAP are unset, so TokenX starts on epoch 0 with a\n" +
        "         zero cap. Every claimTokenX will revert with EpochMintCapExceeded until\n" +
        "         TokenX's owner arms an epoch with setEpochCap(epochId, cap). Arm it from\n" +
        "         the operator before announcing claims."
    );
  }

  pools.requireConfirmation(chainId, "deploy the LP staking stack");
  if (mainnet) console.log("\nEvery transaction below needs a Ledger confirmation.");

  // ──────────────────────── deploy ────────────────────────

  // The timelock first. It depends on nothing, and both proxies name it as their owner in
  // their own deployment transaction, so it has to exist before either of them.
  //
  // Stock OZ v5, through the repo's own `LPTimelock` wrapper. Roles, per spec §2.5: the
  // multisig is the only proposer, the only executor (execution is deliberately NOT open) and
  // — because the OZ constructor grants it alongside PROPOSER_ROLE — the only canceller.
  // `admin = address(0)` leaves the timelock its own DEFAULT_ADMIN_ROLE holder, so even a
  // role change is a scheduled, publicly visible operation.
  const timelockDeploy = await deployContract(
    "LPTimelock",
    [timelockMinDelay, [multisig], [multisig], hre.ethers.ZeroAddress],
    deployer
  );
  const timelock = await hre.ethers.getContractAt("LPTimelock", timelockDeploy.address, deployer);
  pools.recordDeployment(chainId, TIMELOCK_KIND, timelockDeploy.address, {
    deployTx: timelockDeploy.tx.hash,
    block: timelockDeploy.receipt.blockNumber,
    minDelay: timelockMinDelay,
    proposers: [multisig],
    executors: [multisig],
    cancellers: [multisig],
    admin: hre.ethers.ZeroAddress,
  });

  // TokenX is the one contract the deployer must own for a moment: `setMinter` below is
  // owner-only and the distributor does not exist yet at construction time.
  const tokenXDeploy = await deployContract(
    "TokenX",
    [tokenXName, tokenXSymbol, deployer.address],
    deployer
  );
  pools.recordDeployment(chainId, "TokenX", tokenXDeploy.address, {
    deployTx: tokenXDeploy.tx.hash,
    block: tokenXDeploy.receipt.blockNumber,
    name: tokenXName,
    symbol: tokenXSymbol,
    owner: operator,
  });

  // The distributor is a UUPS proxy (spec 01 revision 2026-08-26): an implementation that
  // carries the two immutables and burns its own initializers, then an LPProxy whose
  // constructor delegatecalls `initialize` in the SAME transaction. The owner named there is
  // the TIMELOCK — the proxy is born owned by it, and no key ever holds the owner tier.
  const distributorDeploy = await deployProxyPair(
    "RewardsDistributor",
    [tokenXDeploy.address, asset],
    [timelockDeploy.address, guardian, operator, signer],
    deployer
  );
  const distributorImplDeploy = distributorDeploy.impl;
  const distributorProxyDeploy = distributorDeploy.proxy;
  const distributorInitData = distributorDeploy.initData;
  pools.recordDeployment(chainId, "RewardsDistributor", distributorDeploy.address, {
    deployTx: distributorDeploy.tx.hash,
    block: distributorDeploy.receipt.blockNumber,
    implementation: distributorImplDeploy.address,
    implementationTx: distributorImplDeploy.tx.hash,
    tokenX: tokenXDeploy.address,
    asset,
    signer,
    owner: timelockDeploy.address,
    guardian,
    operator,
  });

  // The vault is born owned by the timelock, so nobody can call `setZapper` at bootstrap
  // without a 48 h schedule. Instead the zapper's address is passed to `initialize` ahead of
  // its deployment: CREATE addresses are a pure function of (deployer, nonce), and every
  // transaction in this script carries an explicit nonce, so the next three are known now —
  // vault implementation, vault proxy, zapper.
  const vaultImplNonce = await pools.resolveNonce(deployer.address);
  const predictedZapper = hre.ethers.getCreateAddress({ from: deployer.address, nonce: vaultImplNonce + 2 });
  console.log(`\nPredicted LPZapper address: ${predictedZapper} (deployer nonce ${vaultImplNonce + 2})`);

  // The vault is a UUPS proxy for the same reason and in the same shape: implementation (the
  // six immutables, the live pool triple check on them, and `_disableInitializers()`), then an
  // LPProxy. Owner = the timelock, zapper = the address the next transaction but one will
  // deploy to.
  const vaultDeploy = await deployProxyPair(
    "LPStakingVault",
    [positionManager, poolAddress, token0, token1, fee, swapRouter],
    [timelockDeploy.address, guardian, operator, predictedZapper, twapWindow, twapMaxDeviationTicks],
    deployer
  );
  const vaultImplDeploy = vaultDeploy.impl;
  const vaultProxyDeploy = vaultDeploy.proxy;
  const vaultInitData = vaultDeploy.initData;
  pools.recordDeployment(chainId, "LPStakingVault", vaultDeploy.address, {
    deployTx: vaultDeploy.tx.hash,
    block: vaultDeploy.receipt.blockNumber,
    implementation: vaultImplDeploy.address,
    implementationTx: vaultImplDeploy.tx.hash,
    pool: poolAddress,
    token0,
    token1,
    fee,
    twapWindow,
    maxTwapDeviationTicks: twapMaxDeviationTicks,
    owner: timelockDeploy.address,
    guardian,
    operator,
    zapper: predictedZapper,
  });

  const zapperDeploy = await deployContract(
    "LPZapper",
    [
      vaultDeploy.address,
      positionManager,
      poolAddress,
      token0,
      token1,
      fee,
      swapRouter,
      usdc,
      asset,
      deployer.address,
      twapWindow,
      twapMaxDeviationTicks,
    ],
    deployer
  );
  // Recorded BEFORE the prediction is checked: if the address is wrong the run throws, and
  // the address of a contract that is already on chain must not be lost with it.
  pools.recordDeployment(chainId, "LPZapper", zapperDeploy.address, {
    deployTx: zapperDeploy.tx.hash,
    block: zapperDeploy.receipt.blockNumber,
    vault: vaultDeploy.address,
    usdc,
    asset,
    twapWindow,
    maxTwapDeviationTicks: twapMaxDeviationTicks,
    owner: operator,
  });

  if (zapperDeploy.address.toLowerCase() !== predictedZapper.toLowerCase()) {
    throw new Error(
      `LPZapper landed at ${zapperDeploy.address}, but the vault was initialized with ` +
        `${predictedZapper}. The stack is deployed and recorded; the zap path is OFF until the ` +
        `timelock executes LPStakingVault.setZapper(${zapperDeploy.address}) ` +
        `(TIMELOCK_TARGET=LPStakingVault TIMELOCK_FN=setZapper). Staking works meanwhile.`
    );
  }
  console.log(`  LPZapper landed on the predicted address; the vault was born pointing at it`);

  // ──────────────────────── the ApeBond route (optional) ────────────────────────
  //
  // Two contracts that each need the other's address, deployed under the same born-owned rule
  // as the two core proxies (N-7). `BonusEscrow` is a UUPS proxy that must exist before the
  // adapter's constructor can reference it, and the escrow must point at the adapter before
  // anyone can buy a bond — but `setAdapter` is owner-tier and the owner is the timelock from
  // the escrow's very first transaction, so the deployer could never make that call.
  //
  // The way out is the zapper's, applied a second time: a CREATE address is a pure function of
  // (deployer, nonce) and every transaction here carries an explicit nonce, so the escrow
  // implementation takes nonce M, the escrow proxy M + 1 and the adapter M + 2. The script
  // computes M + 2 with `getCreateAddress` and hands it to the escrow's
  // `initialize(owner = timelock, adapter = predicted)`. The escrow is therefore born owned by
  // the timelock AND born pointing at its adapter, with no window in which any key holds its
  // owner tier, and the run asserts the adapter really landed where it was promised.
  //
  // The escrow is a proxy and the adapter is NOT, which is the team's split by what a contract
  // holds: the escrow custodies the campaign's money and the ledger of who is owed what, so
  // its code must be fixable without moving the obligations; the adapter holds nothing across
  // transactions and is replaced by deploying a new one and re-pointing the escrow
  // (`setAdapter`) and the vault (`setStakeOperator`) at it — two timelock operations.
  let escrowDeploy = null;
  let adapterDeploy = null;
  if (apeBond) {
    const escrowImplNonce = await pools.resolveNonce(deployer.address);
    const predictedAdapter = hre.ethers.getCreateAddress({
      from: deployer.address,
      nonce: escrowImplNonce + 2,
    });
    console.log(
      `\nPredicted ApeBondPositionAdapter address: ${predictedAdapter} ` +
        `(deployer nonce ${escrowImplNonce + 2})`
    );

    escrowDeploy = await deployProxyPair(
      "BonusEscrow",
      [bonusToken],
      [timelockDeploy.address, predictedAdapter],
      deployer
    );
    pools.recordDeployment(chainId, "BonusEscrow", escrowDeploy.address, {
      deployTx: escrowDeploy.tx.hash,
      block: escrowDeploy.receipt.blockNumber,
      implementation: escrowDeploy.impl.address,
      implementationTx: escrowDeploy.impl.tx.hash,
      bonusToken,
      owner: timelockDeploy.address,
      adapter: predictedAdapter,
    });

    adapterDeploy = await deployContract(
      "ApeBondPositionAdapter",
      [
        positionManager,
        vaultDeploy.address,
        escrowDeploy.address,
        token0,
        token1,
        fee,
        deployer.address,
        apeBondGuardian,
        purchaseSigner,
      ],
      deployer
    );
    // Recorded BEFORE the prediction is checked, for the same reason the zapper is: a contract
    // that is already on chain must not lose its address to a failing assertion.
    pools.recordDeployment(chainId, "ApeBondPositionAdapter", adapterDeploy.address, {
      deployTx: adapterDeploy.tx.hash,
      block: adapterDeploy.receipt.blockNumber,
      vault: vaultDeploy.address,
      escrow: escrowDeploy.address,
      bonusToken,
      token0,
      token1,
      fee,
      guardian: apeBondGuardian,
      purchaseSigner,
      soulZapCallers,
      owner: timelockDeploy.address,
    });

    if (adapterDeploy.address.toLowerCase() !== predictedAdapter.toLowerCase()) {
      throw new Error(
        `ApeBondPositionAdapter landed at ${adapterDeploy.address}, but BonusEscrow was ` +
          `initialized with ${predictedAdapter}. Both contracts are deployed and recorded; the ` +
          `escrow's reserve path points at the wrong address, so every depositFor reverts, ` +
          `until the timelock executes BonusEscrow.setAdapter(${adapterDeploy.address}) ` +
          `(TIMELOCK_TARGET=BonusEscrow TIMELOCK_FN=setAdapter). The core stack is unaffected.`
      );
    }
    console.log(
      "  ApeBondPositionAdapter landed on the predicted address; the escrow was born pointing at it"
    );
  }

  const tokenX = tokenXDeploy.contract;
  const distributor = distributorDeploy.contract;
  const vault = vaultDeploy.contract;
  const zapper = zapperDeploy.contract;
  const escrow = escrowDeploy ? escrowDeploy.contract : null;
  const adapter = adapterDeploy ? adapterDeploy.contract : null;

  // ──────────────────────── wiring ────────────────────────
  // What is left of it. The vault needs nothing — it was born pointing at the zapper — so
  // this is TokenX only, and TokenX is still owned by the deployer at this point.

  console.log("\nWiring the stack...");
  await pools.send("Setting TokenX minter to the distributor", deployer, (o) =>
    tokenX.setMinter(distributorDeploy.address, o)
  );

  if (apeBond) {
    // The adapter's SoulZap allowlist, and nothing else. Two wirings that used to live here are
    // gone since N-7: `escrow.setAdapter` (the escrow was born pointing at the adapter) and
    // `vault.setStakeOperator` (owner-tier on a vault the timelock owns from birth — it is the
    // one operation this run leaves for the multisig, printed below). What is left is
    // owner-only on the ADAPTER, which the deployer still owns at this point.
    for (const caller of soulZapCallers) {
      await pools.send(`Allowlisting SoulZap caller ${caller}`, deployer, (o) =>
        adapter.setSoulZapCaller(caller, true, o)
      );
    }
    if (soulZapCallers.length === 0) {
      console.log(
        "No LP_APEBOND_SOULZAP_CALLERS — the adapter accepts nobody until the timelock adds\n" +
          "  one with setSoulZapCaller. That is a scheduled operation from here on."
      );
    }
  }

  if (epochId) {
    await pools.send(`Arming epoch ${epochId} with cap ${epochCapRaw} TokenX`, deployer, (o) =>
      tokenX.setEpochCap(epochId, epochCap, o)
    );
  } else {
    console.log("Skipping setEpochCap — no epoch armed, claims will revert (see the warning above).");
  }

  // ──────────────────────── ownership ────────────────────────

  // Only TokenX and LPZapper are handed over here: both proxies were born owned by the
  // timelock and there is nothing to transfer on them. Both of these are `Ownable2Step`, so
  // each call only NOMINATES — the operator finishes it with one plain transaction per
  // contract, no timelock in the path.
  console.log("\nTransferring ownership...");
  if (apeBond) {
    // The adapter is plain `Ownable`: one transaction, no acceptance, owned from this block on.
    // Nothing is lost by the missing second step — the adapter custodies nothing, and a
    // mis-addressed owner is repaired by deploying a replacement, which is the documented way
    // to change the adapter anyway. The escrow appears nowhere here: it was born owned by the
    // timelock, exactly like the vault and the distributor.
    await pools.send("ApeBondPositionAdapter -> timelock", deployer, (o) =>
      adapter.transferOwnership(timelockDeploy.address, o)
    );
  }
  const handsOverPlainContracts = operator.toLowerCase() !== deployer.address.toLowerCase();
  if (handsOverPlainContracts) {
    await pools.send("TokenX -> operator (nomination)", deployer, (o) =>
      tokenX.transferOwnership(operator, o)
    );
    await pools.send("LPZapper -> operator (nomination)", deployer, (o) =>
      zapper.transferOwnership(operator, o)
    );
    console.log(
      `\nTwo plain transactions for the operator (${operator}), no timelock involved:\n` +
        `  TokenX.acceptOwnership()    -> ${tokenXDeploy.address}  payload 0x79ba5097\n` +
        `  LPZapper.acceptOwnership()  -> ${zapperDeploy.address}  payload 0x79ba5097\n` +
        "Until they land, the DEPLOYER still owns both (pendingOwner = the operator)."
    );
  } else {
    console.log(
      "TokenX and LPZapper -> operator: skipped, the operator IS the deployer and already owns both."
    );
  }

  if (apeBond) {
    // The ONE owner-tier call this run cannot make. Since N-7 the vault is owned by the
    // timelock from its own deployment transaction, so `setStakeOperator` — which is what lets
    // the adapter call `stakeFor` — is a scheduled operation like an upgrade. It is left
    // pending on purpose rather than worked around: the alternative would be a bootstrap
    // window in which some key holds the vault's owner tier, which is exactly what N-7 removed.
    //
    // Until it executes, `isStakeOperator(adapter)` is false and every ApeBond `depositFor`
    // reverts `NotZapper`. Nothing else is affected: staking, zapping, claims and rebalances
    // all work, and the escrow already holds and honours nothing, because no purchase can be
    // made yet.
    console.log(
      `\n──────── the one timelock operation this run leaves behind ────────\n` +
        `Send it from the multisig (${multisig}), the timelock's only proposer and executor.\n` +
        `Target the timelock at ${timelockDeploy.address}, value 0.\n\n` +
        `  TIMELOCK_ACTION=schedule TIMELOCK_TARGET=LPStakingVault \\\n` +
        `    TIMELOCK_FN=setStakeOperator TIMELOCK_ARGS=${adapterDeploy.address},true \\\n` +
        `    npx hardhat run scripts/lp-timelock.js --network ${hre.network.name}\n\n` +
        `  ...wait out the ${timelockMinDelay}s delay, then the same line with\n` +
        `  TIMELOCK_ACTION=execute.\n\n` +
        `Until it lands the ApeBond deposit path is CLOSED (depositFor reverts NotZapper);\n` +
        `the core LP stack is fully live regardless.`
    );
  }

  // ──────────────────────── oracle warm-up ────────────────────────
  // Permissionless, so it works after the ownership transfers.

  console.log("\nGrowing the pool oracle...");
  if (cardinalityNext >= observationCardinality) {
    console.log(
      `Skipping increaseObservationCardinalityNext — already ${cardinalityNext} >= ${observationCardinality}.`
    );
  } else {
    const poolAsDeployer = await hre.ethers.getContractAt("IUniswapV3Pool", poolAddress, deployer);
    await pools.send(
      `increaseObservationCardinalityNext(${observationCardinality})`,
      deployer,
      (o) => poolAsDeployer.increaseObservationCardinalityNext(observationCardinality, o)
    );
  }

  // The pool is not deployed by this script, but the size the stack was armed with is a
  // deployment fact of the same kind as the guard parameters, so it goes in the registry
  // beside them. The other three keys are the ones create-sepolia-pool.js writes.
  pools.recordDeployment(chainId, "UniswapV3Pool", poolAddress, {
    token0,
    token1,
    fee,
    observationCardinality: Math.max(observationCardinality, cardinalityNext),
  });

  if (cardinality <= 1) {
    console.log(
      `\nNOTE: the pool still stores ${cardinality} observation. Growing the array only\n` +
        `      allocates slots — they fill one per block that trades. Until the oracle holds\n` +
        `      at least ${twapWindow}s of history, pool.observe() reverts with 'OLD' and every\n` +
        `      TWAP-guarded path (zapIn, and any rebalance with a swap leg) reverts with it.\n` +
        `      Unguarded paths (stake, unstake, swap-free rebalance) work from block one.\n` +
        `      On a fresh pool: seed liquidity, trade it for ~${twapWindow}s, then re-check\n` +
        `      with pool.observe([${twapWindow}, 0]).`
    );
  }

  // ──────────────────────── verification ────────────────────────

  console.log("\n──────── post-deploy verification ────────");
  const failures = [];
  const check = (label, actual, expected) => {
    const ok = String(actual).toLowerCase() === String(expected).toLowerCase();
    console.log(`${ok ? "OK  " : "FAIL"}  ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
    if (!ok) failures.push(label);
  };

  check("TokenX.name", await tokenX.name(), tokenXName);
  check("TokenX.symbol", await tokenX.symbol(), tokenXSymbol);
  check("TokenX.decimals", await tokenX.decimals(), TOKENX_DECIMALS);
  check("TokenX.minter", await tokenX.minter(), distributorDeploy.address);
  // Ownable2Step (N-1): a nomination the operator has not accepted yet leaves the DEPLOYER
  // the owner. When the operator is the deployer nothing was nominated at all.
  const [expectedPlainOwner, expectedPlainPendingOwner] = handsOverPlainContracts
    ? [deployer.address, operator]
    : [operator, hre.ethers.ZeroAddress];
  check("TokenX.owner", await tokenX.owner(), expectedPlainOwner);
  check("TokenX.pendingOwner", await tokenX.pendingOwner(), expectedPlainPendingOwner);
  check("TokenX.totalSupply", await tokenX.totalSupply(), 0);
  if (epochId) {
    check("TokenX.currentEpochId", await tokenX.currentEpochId(), epochId);
    check("TokenX.epochCap[current]", await tokenX.epochCap(epochId), epochCap);
  } else {
    console.log(`WARN  TokenX.currentEpochId: ${await tokenX.currentEpochId()} with cap ${await tokenX.epochCap(0)} — claims revert until an epoch is armed`);
  }

  // The proxies have exactly ONE legal end state since N-7: born owned by the timelock, with
  // nothing pending. There is no interim, no branch and no window in which a key owns them.
  const expectedProxyOwner = timelockDeploy.address;
  const expectedPendingOwner = hre.ethers.ZeroAddress;

  check("RewardsDistributor.tokenX", await distributor.tokenX(), tokenXDeploy.address);
  check("RewardsDistributor.asset", await distributor.asset(), asset);
  check("RewardsDistributor.signer", await distributor.signer(), signer);
  check("RewardsDistributor.owner", await distributor.owner(), expectedProxyOwner);
  check("RewardsDistributor.pendingOwner", await distributor.pendingOwner(), expectedPendingOwner);
  check("RewardsDistributor.guardian", await distributor.guardian(), guardian);
  check("RewardsDistributor.operator", await distributor.operator(), operator);
  check("RewardsDistributor.paused", await distributor.paused(), false);
  check("RewardsDistributor.assetClaimsEnabled", await distributor.assetClaimsEnabled(), false);
  // Reads the ERC-1967 slot rather than trusting the constructor argument: this is the only
  // proof that the proxy in the registry really delegates to the implementation in it.
  check(
    "RewardsDistributor.implementation (ERC-1967 slot)",
    hre.ethers.getAddress(
      "0x" +
        (
          await hre.ethers.provider.getStorage(
            distributorDeploy.address,
            ERC1967_IMPLEMENTATION_SLOT
          )
        ).slice(-40)
    ),
    distributorImplDeploy.address
  );

  check("LPStakingVault.pool", await vault.pool(), poolAddress);
  check("LPStakingVault.positionManager", await vault.positionManager(), positionManager);
  check("LPStakingVault.swapRouter", await vault.swapRouter(), swapRouter);
  check("LPStakingVault.token0", await vault.token0(), token0);
  check("LPStakingVault.token1", await vault.token1(), token1);
  check("LPStakingVault.fee", await vault.fee(), fee);
  check("LPStakingVault.zapper", await vault.zapper(), zapperDeploy.address);
  check("LPStakingVault.depositsPaused", await vault.depositsPaused(), false);
  check("LPStakingVault.rebalancePaused", await vault.rebalancePaused(), false);
  check("LPStakingVault.twapWindow", await vault.twapWindow(), twapWindow);
  check("LPStakingVault.maxTwapDeviationTicks", await vault.maxTwapDeviationTicks(), twapMaxDeviationTicks);
  check("LPStakingVault.guardian", await vault.guardian(), guardian);
  check("LPStakingVault.operator", await vault.operator(), operator);
  check("LPStakingVault.owner", await vault.owner(), expectedProxyOwner);
  check("LPStakingVault.pendingOwner", await vault.pendingOwner(), expectedPendingOwner);
  // Reads the ERC-1967 slot rather than trusting the constructor argument: this is the only
  // proof that the proxy in the registry really delegates to the implementation in it.
  check(
    "LPStakingVault.implementation (ERC-1967 slot)",
    hre.ethers.getAddress(
      "0x" +
        (
          await hre.ethers.provider.getStorage(vaultDeploy.address, ERC1967_IMPLEMENTATION_SLOT)
        ).slice(-40)
    ),
    vaultImplDeploy.address
  );

  check("LPZapper.vault", await zapper.vault(), vaultDeploy.address);
  check("LPZapper.pool", await zapper.pool(), poolAddress);
  check("LPZapper.positionManager", await zapper.positionManager(), positionManager);
  check("LPZapper.swapRouter", await zapper.swapRouter(), swapRouter);
  check("LPZapper.token0", await zapper.token0(), token0);
  check("LPZapper.token1", await zapper.token1(), token1);
  check("LPZapper.fee", await zapper.fee(), fee);
  check("LPZapper.usdc", await zapper.usdc(), usdc);
  check("LPZapper.asset", await zapper.asset(), asset);
  check("LPZapper.usdcIsToken0", await zapper.usdcIsToken0(), usdc === token0);
  check("LPZapper.twapWindow", await zapper.twapWindow(), twapWindow);
  check("LPZapper.maxTwapDeviationTicks", await zapper.maxTwapDeviationTicks(), twapMaxDeviationTicks);
  check("LPZapper.owner", await zapper.owner(), expectedPlainOwner);
  check("LPZapper.pendingOwner", await zapper.pendingOwner(), expectedPlainPendingOwner);

  if (apeBond) {
    // The two facts that make the route a route at all: the escrow will take a reservation
    // only from this adapter, and the vault will take a `stakeFor` only from it. The first is
    // checked here and must hold — the escrow was born pointing at the adapter. The second
    // cannot hold yet, by design: it is the timelock operation this run leaves behind, so it
    // is reported as a WARN with the exact call that closes it, not as a failure.
    check("BonusEscrow.bonusToken", await escrow.bonusToken(), bonusToken);
    check("BonusEscrow.adapter", await escrow.adapter(), adapterDeploy.address);
    check("BonusEscrow.totalReserved", await escrow.totalReserved(), 0);
    check("BonusEscrow.owner", await escrow.owner(), expectedProxyOwner);
    check("BonusEscrow.pendingOwner", await escrow.pendingOwner(), expectedPendingOwner);
    check(
      "BonusEscrow.implementation (ERC-1967 slot)",
      hre.ethers.getAddress(
        "0x" +
          (
            await hre.ethers.provider.getStorage(escrowDeploy.address, ERC1967_IMPLEMENTATION_SLOT)
          ).slice(-40)
      ),
      escrowDeploy.impl.address
    );
    const adapterIsStakeOperator = await vault.isStakeOperator(adapterDeploy.address);
    if (adapterIsStakeOperator) {
      check("LPStakingVault.isStakeOperator(adapter)", adapterIsStakeOperator, true);
    } else {
      console.log(
        "WARN  LPStakingVault.isStakeOperator(adapter) is false — PENDING TIMELOCK OPERATION.\n" +
          `      Schedule and execute setStakeOperator(${adapterDeploy.address}, true) from the\n` +
          `      multisig (${multisig}); until then every ApeBond depositFor reverts NotZapper.`
      );
    }

    // The adapter's immutables, read back off the deployed bytecode rather than trusted from
    // the arguments a line above: this is the only proof the constructor got the pool triple
    // and the two contracts the vault itself was deployed against.
    check("ApeBondPositionAdapter.positionManager", await adapter.positionManager(), positionManager);
    check("ApeBondPositionAdapter.vault", await adapter.vault(), vaultDeploy.address);
    check("ApeBondPositionAdapter.escrow", await adapter.escrow(), escrowDeploy.address);
    check("ApeBondPositionAdapter.token0", await adapter.token0(), token0);
    check("ApeBondPositionAdapter.token1", await adapter.token1(), token1);
    check("ApeBondPositionAdapter.fee", await adapter.fee(), fee);
    check("ApeBondPositionAdapter.guardian", await adapter.guardian(), apeBondGuardian);
    check("ApeBondPositionAdapter.purchaseSigner", await adapter.purchaseSigner(), purchaseSigner);
    check("ApeBondPositionAdapter.depositsPaused", await adapter.depositsPaused(), false);
    // Plain `Ownable`: no nomination to wait out, so the timelock owns it in every bootstrap.
    check("ApeBondPositionAdapter.owner", await adapter.owner(), timelockDeploy.address);
    for (const caller of soulZapCallers) {
      check(`ApeBondPositionAdapter.soulZapCallers[${caller}]`, await adapter.soulZapCallers(caller), true);
    }
    if (purchaseSigner === hre.ethers.ZeroAddress) {
      console.log(
        "WARN  ApeBondPositionAdapter.purchaseSigner is 0 — every depositFor reverts until the\n" +
          `      guardian (${apeBondGuardian}) calls setPurchaseSigner. That is the documented\n` +
          "      default; open the route when the campaign starts."
      );
    }
  }

  check("LPTimelock.getMinDelay", await timelock.getMinDelay(), timelockMinDelay);
  const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
  const EXECUTOR_ROLE = await timelock.EXECUTOR_ROLE();
  const CANCELLER_ROLE = await timelock.CANCELLER_ROLE();
  const DEFAULT_ADMIN_ROLE = await timelock.DEFAULT_ADMIN_ROLE();
  check("LPTimelock.PROPOSER_ROLE[multisig]", await timelock.hasRole(PROPOSER_ROLE, multisig), true);
  check("LPTimelock.EXECUTOR_ROLE[multisig]", await timelock.hasRole(EXECUTOR_ROLE, multisig), true);
  check("LPTimelock.CANCELLER_ROLE[multisig]", await timelock.hasRole(CANCELLER_ROLE, multisig), true);
  // Self-administered: the timelock is its own admin, and nobody else is — least of all the
  // key that deployed it, which would otherwise be a permanent back door around the delay.
  check(
    "LPTimelock.DEFAULT_ADMIN_ROLE[timelock]",
    await timelock.hasRole(DEFAULT_ADMIN_ROLE, timelockDeploy.address),
    true
  );
  check(
    "LPTimelock.DEFAULT_ADMIN_ROLE[deployer]",
    await timelock.hasRole(DEFAULT_ADMIN_ROLE, deployer.address),
    false
  );

  // UUPS keeps the upgrade authority in the implementation, so the ERC-1967 ADMIN slot must be
  // empty on every proxy here. A non-zero value there would mean a transparent proxy's
  // ProxyAdmin got in somehow, and with it a second, unowned upgrade path.
  const uupsProxies = [
    ["RewardsDistributor", distributorDeploy.address],
    ["LPStakingVault", vaultDeploy.address],
  ];
  if (apeBond) uupsProxies.push(["BonusEscrow", escrowDeploy.address]);
  for (const [label, address] of uupsProxies) {
    check(
      `${label}.adminSlot (ERC-1967, must be empty for UUPS)`,
      await hre.upgrades.erc1967.getAdminAddress(address),
      hre.ethers.ZeroAddress
    );
  }

  // ──────────────────────── summary ────────────────────────

  console.log("\n──────── deployed addresses ────────");
  console.log(`TokenX:             ${tokenXDeploy.address}`);
  console.log(`RewardsDistributor: ${distributorDeploy.address} (proxy)`);
  console.log(`  implementation:   ${distributorImplDeploy.address}`);
  console.log(`LPStakingVault:     ${vaultDeploy.address} (proxy)`);
  console.log(`  implementation:   ${vaultImplDeploy.address}`);
  console.log(`LPZapper:           ${zapperDeploy.address}`);
  if (apeBond) {
    console.log(`BonusEscrow:        ${escrowDeploy.address} (proxy)`);
    console.log(`  implementation:   ${escrowDeploy.impl.address}`);
    console.log(`ApeBondAdapter:     ${adapterDeploy.address}`);
  }
  console.log(`LPTimelock:         ${timelockDeploy.address} (minDelay ${timelockMinDelay}s)`);

  const network = hre.network.name;
  console.log("\n──────── verify on the explorer ────────");
  console.log(
    `npx hardhat verify --network ${network} ${tokenXDeploy.address} ` +
      `"${tokenXName}" "${tokenXSymbol}" ${deployer.address}`
  );
  console.log(
    `npx hardhat verify --network ${network} ${distributorImplDeploy.address} ` +
      `${tokenXDeploy.address} ${asset}`
  );
  console.log(
    `npx hardhat verify --network ${network} ${distributorProxyDeploy.address} ` +
      `${distributorImplDeploy.address} ${distributorInitData}`
  );
  console.log(
    `npx hardhat verify --network ${network} ${vaultImplDeploy.address} ` +
      `${positionManager} ${poolAddress} ${token0} ${token1} ${fee} ${swapRouter}`
  );
  console.log(
    `npx hardhat verify --network ${network} ${vaultProxyDeploy.address} ` +
      `${vaultImplDeploy.address} ${vaultInitData}`
  );
  console.log(
    `npx hardhat verify --network ${network} ${zapperDeploy.address} ` +
      `${vaultDeploy.address} ${positionManager} ${poolAddress} ${token0} ${token1} ${fee} ` +
      `${swapRouter} ${usdc} ${asset} ${deployer.address} ${twapWindow} ${twapMaxDeviationTicks}`
  );
  if (apeBond) {
    console.log(
      `npx hardhat verify --network ${network} ${escrowDeploy.impl.address} ${bonusToken}`
    );
    console.log(
      `npx hardhat verify --network ${network} ${escrowDeploy.proxy.address} ` +
        `${escrowDeploy.impl.address} ${escrowDeploy.initData}`
    );
    console.log(
      `npx hardhat verify --network ${network} ${adapterDeploy.address} ` +
        `${positionManager} ${vaultDeploy.address} ${escrowDeploy.address} ${token0} ${token1} ` +
        `${fee} ${deployer.address} ${apeBondGuardian} ${purchaseSigner}`
    );
  }
  // The timelock's proposer/executor arrays are address[]; hardhat-verify wants them as JSON.
  console.log(
    `npx hardhat verify --network ${network} ${timelockDeploy.address} ` +
      `${timelockMinDelay} '["${multisig}"]' '["${multisig}"]' ${hre.ethers.ZeroAddress}`
  );
  console.log(
    "\nTokenX and LPZapper name the DEPLOYER in their constructor argument, not the " +
      "operator —\nthe nomination happens afterwards, and verification must replay the value " +
      "the\nconstructor actually saw.\n" +
      "Each proxy needs two commands: one for the implementation, one for the proxy itself\n" +
      "(implementation address + the `initialize` calldata). The vault's calldata now carries\n" +
      "SIX arguments — owner, guardian, operator, zapper, window, ticks — and the " +
      "distributor's\nfour: owner, guardian, operator, signer."
  );

  if (failures.length > 0) {
    throw new Error(
      `Post-deploy verification failed for: ${failures.join(", ")}. ` +
        `The contracts are deployed and recorded in deployments.json — fix the state from the ` +
        `operator, or through the timelock for an owner-tier field.`
    );
  }
  console.log("\nAll post-deploy checks passed.");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
