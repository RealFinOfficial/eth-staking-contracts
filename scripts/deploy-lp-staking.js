const hre = require("hardhat");
const pools = require("./lib/pools");
const timelockOps = require("./lp-timelock");

// Deploy the full LP staking stack and record every address in deployments.json.
//
// Deploy order is fixed by the wiring: TokenX first (nothing depends on it),
// then RewardsDistributor (needs TokenX), then LPStakingVault, then LPZapper
// (needs the vault), then the LPTimelock that ends up owning the two proxies.
//
// ──────────────────────── the bootstrap, and why it looks like this ────────────────────────
//
// Both UUPS proxies (implementation + LPProxy) take the SAME route, and `setZapper` is the
// reason there is a route at all: it is owner-only and has to run before the handover, so
// neither proxy can be born owned by its final owner.
//
//   1. `initialize(owner_ = DEPLOYER, guardian_ = LP_GUARDIAN, …)` — the deployer owns both
//      proxies for exactly as long as the wiring takes.
//   2. wire: `tokenX.setMinter`, `vault.setZapper`, the optional `tokenX.setEpochCap`.
//   3. `LPTimelock(LP_TIMELOCK_MIN_DELAY, [multisig], [multisig], address(0))`.
//   4. `transferOwnership(timelock)` on both proxies. `Ownable2Step` only NOMINATES.
//   5. `acceptOwnership()` on both, and that call is itself a timelock operation — the
//      timelock is the only address that can send it, and only through schedule → delay →
//      execute. Which is where the two networks part:
//
//        * **staging** (`LP_MULTISIG == deployer`, e.g. the Sepolia rehearsal): this script
//          holds the proposer and executor key, so it schedules both operations, waits out
//          `minDelay` in wall time, executes them, and the post-deploy checks assert
//          `owner == timelock` and `pendingOwner == 0`.
//        * **mainnet** (a real Safe): the script cannot schedule anything. It prints the two
//          `schedule(...)` payloads and the two later `execute(...)` payloads with their
//          operation ids, and the post-deploy checks assert the documented INTERIM state —
//          `owner == deployer`, `pendingOwner == timelock` — until the Safe finishes the
//          handover. Until then the deployer key is still the owner of both proxies; that is
//          the one window in the whole runbook where it matters that it stays safe.
//
// LP_GUARDIAN holds the undelayed fast path on both proxies throughout. TokenX and LPZapper
// are plain `Ownable` and go straight to the multisig in step 4.
//
// Required env
//   LP_ASSET       — ASSET token (18 decimals), one side of the pool
//   LP_USDC        — USDC token (6 decimals), the other side and the zap-in token
//   LP_POOL        — the Uniswap V3 ASSET-USDC pool this stack is bound to
//   LP_SIGNER      — backend voucher signer for RewardsDistributor; MUST NOT be
//                    the deployer or the multisig — it signs EIP-712 payloads on
//                    every claim, which a Ledger cannot serve
//   LP_MULTISIG    — owner of TokenX and LPZapper, guardian of the two proxies by default,
//                    and the timelock's sole proposer, executor and canceller
//   LP_TOKENX_NAME / LP_TOKENX_SYMBOL — TokenX branding, decided at deploy time
//
// Optional env (defaults in parentheses)
//   LP_NPM                    — NonfungiblePositionManager (per-chain default, see UNISWAP_BY_CHAIN)
//   LP_ROUTER                 — SwapRouter02 (per-chain default, see UNISWAP_BY_CHAIN)
//   LP_FEE                    — pool fee tier in hundredths of a bip (3000)
//   LP_TWAP_WINDOW            — TWAP lookback in seconds, 300..3600 (300)
//   LP_TWAP_MAX_DEVIATION_BPS — spot-vs-TWAP ceiling in BPS, <= 2000 (1000). The contract
//                               stores TICKS; this script converts exactly with
//                               floor(ln(1 + bps/1e4) / ln(1.0001)) and logs both numbers.
//                               500 bps = 487 ticks, 1000 = 953, 2000 = 1823
//   LP_GUARDIAN               — pause tier on BOTH proxies: the vault's two pause switches and
//                               the distributor's, with no delay and nothing else
//                               (LP_MULTISIG)
//   LP_OPERATOR               — routine-operations tier on BOTH proxies: the vault's
//                               setTwapParams and rescuePosition, the distributor's setSigner
//                               and recoverExcessAsset, plus all three pause switches as the
//                               cold fallback for a lost guardian key — all with no delay
//                               (LP_MULTISIG)
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
// Mainnet needs CONFIRM=yes, like every other state-changing script here.

// Uniswap V3 is NOT at one address across chains. Sepolia got its own deployment,
// and the mainnet addresses have zero code there. Keyed by chain id; a chain that
// is not listed has no default, so LP_NPM / LP_ROUTER become required for it —
// including a local fork, which reports 31337 rather than the forked chain id.
// The getCode() check below is the backstop: a wrong address here fails there.
const UNISWAP_BY_CHAIN = {
  // mainnet
  1: {
    positionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
    swapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
  },
  // sepolia
  11155111: {
    positionManager: "0x1238536071E1c677A632429e3655c799b22cDA52",
    swapRouter02: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E",
  },
};

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

/**
 * Waits out the timelock's own delay in WALL time.
 *
 * Only the staging path reaches this: the script holds the proposer and executor key there,
 * so the whole schedule → delay → execute cycle happens inside one run and the operator sees
 * the real flow rather than a shortcut. There is deliberately no `evm_increaseTime` here — a
 * deploy script must not depend on a test-only RPC method, and on a real network the clock is
 * the clock. With `minDelay = 0` there is nothing to wait for.
 */
async function waitOutMinDelay(seconds) {
  if (seconds <= 0) {
    console.log("  minDelay is 0 — both operations are ready in the block they were scheduled in.");
    return;
  }
  const total = seconds + 1; // `readyAt` is exclusive: OZ needs timestamp >= scheduled + delay
  const readyAt = new Date(Date.now() + total * 1000);
  console.log(`\nWaiting out the ${seconds}s timelock delay (ready at ${readyAt.toISOString()})...`);
  const step = Math.min(30, total);
  for (let left = total; left > 0; left -= step) {
    const chunk = Math.min(step, left);
    await new Promise((resolve) => setTimeout(resolve, chunk * 1000));
    console.log(`  ${Math.max(left - chunk, 0)}s left`);
  }
}

async function main() {
  const chainId = await pools.chainId();
  const mainnet = pools.isMainnet(chainId);
  const deployer = await pools.getSigner();

  // ──────────────────────── config ────────────────────────

  const uniswap = UNISWAP_BY_CHAIN[chainId] || {};

  const asset = readAddress("LP_ASSET");
  const usdc = readAddress("LP_USDC");
  const poolAddress = readAddress("LP_POOL");
  const positionManager = readAddress("LP_NPM", uniswap.positionManager);
  const swapRouter = readAddress("LP_ROUTER", uniswap.swapRouter02);
  const signer = readAddress("LP_SIGNER");
  const multisig = readAddress("LP_MULTISIG");
  // Fast-path incident responder on the distributor proxy: pauses, signer rotation and
  // `recoverExcessAsset`, with no timelock in front of it. Defaults to the multisig, which
  // is what it is unless a dedicated ops key is provisioned.
  const guardian = readAddress("LP_GUARDIAN", multisig);
  // Routine-operations tier on BOTH proxies (2026-09-09 role split): the vault's TWAP
  // calibration and NFT rescue, the distributor's signer rotation and ASSET recovery, plus
  // all three pause switches as the cold fallback for a lost guardian key. Optional here and
  // defaulted to the multisig; making it required, and rejecting `operator == guardian`, is
  // part of the N-7 bootstrap rewrite.
  const operator = readAddress("LP_OPERATOR", multisig);

  // The timelock's own parameter. 48 h on mainnet; staging and the fork suites shorten it so
  // the schedule -> execute flow is rehearsable rather than theoretical.
  const timelockMinDelay = Number(process.env.LP_TIMELOCK_MIN_DELAY || DEFAULT_TIMELOCK_MIN_DELAY);

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
  console.log(`Voucher signer:     ${signer}`);
  console.log(`Multisig:           ${multisig}`);
  console.log(`Guardian:           ${guardian}${guardian === multisig ? " (= the multisig)" : ""}`);
  console.log(`Operator:           ${operator}${operator === multisig ? " (= the multisig)" : ""}`);
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

  // ──────────────────────── on-chain safety checks ────────────────────────

  console.log("\nChecking the configuration on-chain...");

  for (const [label, address] of [
    ["LP_POOL", poolAddress],
    ["LP_NPM", positionManager],
    ["LP_ROUTER", swapRouter],
    ["LP_ASSET", asset],
    ["LP_USDC", usdc],
  ]) {
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
  // This is the fork in the road for the whole ownership bootstrap below, so it is stated
  // before anything is deployed rather than discovered halfway through.
  const stagingBootstrap = multisig.toLowerCase() === deployer.address.toLowerCase();
  if (stagingBootstrap) {
    console.log(
      "\nSTAGING BOOTSTRAP: LP_MULTISIG is the deployer, so this run holds the timelock's\n" +
        "         proposer and executor roles itself. It will schedule both acceptOwnership\n" +
        `         operations, wait out the ${timelockMinDelay}s delay and execute them, ending with\n` +
        "         the timelock as the owner of both proxies. TokenX and the zapper still end\n" +
        "         up owned by the deploying key, which is only right on staging — set\n" +
        "         LP_MULTISIG to the real multisig before a production run."
    );
  } else {
    console.log(
      "\nMULTISIG BOOTSTRAP: the timelock's roles belong to LP_MULTISIG, which this run cannot\n" +
        "         sign for. It will nominate the timelock on both proxies and print the two\n" +
        "         schedule payloads; until the multisig schedules and executes them, the\n" +
        "         DEPLOYER is still the owner of both proxies (pendingOwner = the timelock)."
    );
  }
  if (!epochId) {
    console.log(
      "\nWARNING: LP_EPOCH_ID / LP_EPOCH_CAP are unset, so TokenX starts on epoch 0 with a\n" +
        "         zero cap. Every claimTokenX will revert with EpochMintCapExceeded until\n" +
        "         the owner arms an epoch with setEpochCap(epochId, cap). Arm it from the\n" +
        "         multisig before announcing claims."
    );
  }

  pools.requireConfirmation(chainId, "deploy the LP staking stack");
  if (mainnet) console.log("\nEvery transaction below needs a Ledger confirmation.");

  // ──────────────────────── deploy ────────────────────────

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
  });

  // The distributor is a UUPS proxy (spec 01 revision 2026-08-26): an implementation that
  // carries the two immutables and burns its own initializers, then an LPProxy whose
  // constructor delegatecalls `initialize` in the SAME transaction. The owner named here is
  // the DEPLOYER; the timelock takes over at the end of the run.
  const distributorDeploy = await deployProxyPair(
    "RewardsDistributor",
    [tokenXDeploy.address, asset],
    [deployer.address, guardian, operator, signer],
    deployer
  );
  const distributorImplDeploy = distributorDeploy.impl;
  const distributorProxyDeploy = distributorDeploy.proxy;
  const distributorInitData = distributorDeploy.initData;
  // The `owner` field is filled in after the timelock exists; recording the rest now means a
  // run that dies in the next transaction still leaves the address written down.
  const distributorRecord = {
    deployTx: distributorDeploy.tx.hash,
    block: distributorDeploy.receipt.blockNumber,
    implementation: distributorImplDeploy.address,
    implementationTx: distributorImplDeploy.tx.hash,
    tokenX: tokenXDeploy.address,
    asset,
    signer,
    guardian,
    operator,
  };
  pools.recordDeployment(chainId, "RewardsDistributor", distributorDeploy.address, distributorRecord);

  // The vault is a UUPS proxy for the same reason and in the same shape: implementation (the
  // six immutables, the live pool triple check on them, and `_disableInitializers()`), then an
  // LPProxy. Owner = the deployer, because `setZapper` below is owner-only and the handover
  // follows the wiring.
  const vaultDeploy = await deployProxyPair(
    "LPStakingVault",
    [positionManager, poolAddress, token0, token1, fee, swapRouter],
    [deployer.address, guardian, operator, hre.ethers.ZeroAddress, twapWindow, twapMaxDeviationTicks],
    deployer
  );
  const vaultImplDeploy = vaultDeploy.impl;
  const vaultProxyDeploy = vaultDeploy.proxy;
  const vaultInitData = vaultDeploy.initData;
  const vaultRecord = {
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
    guardian,
    operator,
  };
  pools.recordDeployment(chainId, "LPStakingVault", vaultDeploy.address, vaultRecord);

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
  pools.recordDeployment(chainId, "LPZapper", zapperDeploy.address, {
    deployTx: zapperDeploy.tx.hash,
    block: zapperDeploy.receipt.blockNumber,
    vault: vaultDeploy.address,
    usdc,
    asset,
    twapWindow,
    maxTwapDeviationTicks: twapMaxDeviationTicks,
  });

  const tokenX = tokenXDeploy.contract;
  const distributor = distributorDeploy.contract;
  const vault = vaultDeploy.contract;
  const zapper = zapperDeploy.contract;

  // ──────────────────────── wiring ────────────────────────
  // All of this is onlyOwner, so it must happen while the deployer still owns
  // the contracts — hence before the ownership transfers below.

  console.log("\nWiring the stack...");
  await pools.send("Setting TokenX minter to the distributor", deployer, (o) =>
    tokenX.setMinter(distributorDeploy.address, o)
  );
  await pools.send("Whitelisting the zapper on the vault", deployer, (o) =>
    vault.setZapper(zapperDeploy.address, o)
  );

  if (epochId) {
    await pools.send(`Arming epoch ${epochId} with cap ${epochCapRaw} TokenX`, deployer, (o) =>
      tokenX.setEpochCap(epochId, epochCap, o)
    );
  } else {
    console.log("Skipping setEpochCap — no epoch armed, claims will revert (see the warning above).");
  }

  // ──────────────────────── the timelock ────────────────────────

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
  pools.recordDeployment(chainId, timelockOps.TIMELOCK_KIND, timelockDeploy.address, {
    deployTx: timelockDeploy.tx.hash,
    block: timelockDeploy.receipt.blockNumber,
    minDelay: timelockMinDelay,
    proposers: [multisig],
    executors: [multisig],
    cancellers: [multisig],
    admin: hre.ethers.ZeroAddress,
  });

  // ──────────────────────── ownership ────────────────────────

  console.log("\nTransferring ownership...");
  await pools.send("TokenX -> multisig", deployer, (o) => tokenX.transferOwnership(multisig, o));
  // Both proxies are Ownable2Step, so these two transactions only NOMINATE. The acceptance is
  // the timelock's own first operation — see the bootstrap below.
  await pools.send("RewardsDistributor -> timelock (nomination)", deployer, (o) =>
    distributor.transferOwnership(timelockDeploy.address, o)
  );
  await pools.send("LPStakingVault -> timelock (nomination)", deployer, (o) =>
    vault.transferOwnership(timelockDeploy.address, o)
  );
  await pools.send("LPZapper -> multisig", deployer, (o) => zapper.transferOwnership(multisig, o));

  // Now that the owner is known, the registry records it beside the address it belongs to.
  pools.recordDeployment(chainId, "RewardsDistributor", distributorDeploy.address, {
    ...distributorRecord,
    owner: timelockDeploy.address,
  });
  pools.recordDeployment(chainId, "LPStakingVault", vaultDeploy.address, {
    ...vaultRecord,
    owner: timelockDeploy.address,
  });

  // ──────────────────────── the acceptance, through the timelock ────────────────────────

  const acceptOperations = [
    timelockOps.buildOperation({ target: distributorDeploy.address, fn: "acceptOwnership" }),
    timelockOps.buildOperation({ target: vaultDeploy.address, fn: "acceptOwnership" }),
  ];
  const acceptLabels = ["RewardsDistributor", "LPStakingVault"];

  if (stagingBootstrap) {
    console.log("\nHanding both proxies to the timelock (schedule -> delay -> execute)...");
    for (const [index, op] of acceptOperations.entries()) {
      await pools.send(`Scheduling ${acceptLabels[index]}.acceptOwnership`, deployer, (o) =>
        timelock.schedule(op.target, op.value, op.data, op.predecessor, op.salt, timelockMinDelay, o)
      );
      console.log(`  operation id: ${op.id}`);
    }

    await waitOutMinDelay(timelockMinDelay);

    for (const [index, op] of acceptOperations.entries()) {
      await pools.send(`Executing ${acceptLabels[index]}.acceptOwnership`, deployer, (o) =>
        timelock.execute(op.target, op.value, op.data, op.predecessor, op.salt, o)
      );
    }
  } else {
    console.log("\n──────── the multisig's four timelock transactions ────────");
    console.log(
      "Both proxies are nominated but NOT yet owned by the timelock. Send these from the\n" +
        `multisig (${multisig}), which is the timelock's only proposer and executor.\n` +
        `Every payload goes to the timelock at ${timelockDeploy.address}, value 0.\n` +
        "The salt is derived from the call itself (scripts/lp-timelock.js documents how), so\n" +
        "the id below can be recomputed by anyone from the public calldata."
    );
    for (const [index, op] of acceptOperations.entries()) {
      console.log(`\n${acceptLabels[index]}.acceptOwnership()  —  operation ${op.id}`);
      console.log(`  target:      ${op.target}`);
      console.log(`  payload:     ${op.data}`);
      console.log(`  predecessor: ${op.predecessor}`);
      console.log(`  salt:        ${op.salt}`);
      console.log(`  1. schedule: ${timelockOps.encodeSchedule(op, timelockMinDelay)}`);
      console.log(`  2. execute (after ${timelockMinDelay}s): ${timelockOps.encodeExecute(op)}`);
    }
    console.log(
      `\nOr, with the key that holds the roles:\n` +
        `  TIMELOCK_ACTION=schedule TIMELOCK_TARGET=RewardsDistributor TIMELOCK_FN=acceptOwnership \\\n` +
        `    npx hardhat run scripts/lp-timelock.js --network ${hre.network.name}\n` +
        `  (then TIMELOCK_TARGET=LPStakingVault, and the same two with TIMELOCK_ACTION=execute\n` +
        `  once ${timelockMinDelay}s have passed)`
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
  check("TokenX.owner", await tokenX.owner(), multisig);
  check("TokenX.totalSupply", await tokenX.totalSupply(), 0);
  if (epochId) {
    check("TokenX.currentEpochId", await tokenX.currentEpochId(), epochId);
    check("TokenX.epochCap[current]", await tokenX.epochCap(epochId), epochCap);
  } else {
    console.log(`WARN  TokenX.currentEpochId: ${await tokenX.currentEpochId()} with cap ${await tokenX.epochCap(0)} — claims revert until an epoch is armed`);
  }

  // Ownable2Step through a timelock has exactly two legal end states, and which one this run
  // reached is decided by whether it could sign for the timelock's proposer role.
  const [expectedProxyOwner, expectedPendingOwner] = stagingBootstrap
    ? [timelockDeploy.address, hre.ethers.ZeroAddress]
    : [deployer.address, timelockDeploy.address];

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
  check("LPZapper.owner", await zapper.owner(), multisig);

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
  if (!stagingBootstrap) {
    check(
      "LPTimelock.PROPOSER_ROLE[deployer]",
      await timelock.hasRole(PROPOSER_ROLE, deployer.address),
      false
    );
  }

  // UUPS keeps the upgrade authority in the implementation, so the ERC-1967 ADMIN slot must be
  // empty on both proxies. A non-zero value there would mean a transparent proxy's ProxyAdmin
  // got in somehow, and with it a second, unowned upgrade path.
  for (const [label, address] of [
    ["RewardsDistributor", distributorDeploy.address],
    ["LPStakingVault", vaultDeploy.address],
  ]) {
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
  // The timelock's proposer/executor arrays are address[]; hardhat-verify wants them as JSON.
  console.log(
    `npx hardhat verify --network ${network} ${timelockDeploy.address} ` +
      `${timelockMinDelay} '["${multisig}"]' '["${multisig}"]' ${hre.ethers.ZeroAddress}`
  );
  console.log(
    "\nThe constructor argument is the DEPLOYER, not the multisig — ownership moved " +
      "afterwards,\nso verification must replay the value the constructor actually saw.\n" +
      "Each proxy needs two commands: one for the implementation, one for the proxy itself\n" +
      "(implementation address + the `initialize` calldata)."
  );

  if (failures.length > 0) {
    throw new Error(
      `Post-deploy verification failed for: ${failures.join(", ")}. ` +
        `The contracts are deployed and recorded in deployments.json — fix the state from the multisig.`
    );
  }
  console.log("\nAll post-deploy checks passed.");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
