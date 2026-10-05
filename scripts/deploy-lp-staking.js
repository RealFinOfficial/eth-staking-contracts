const fs = require("fs");
const path = require("path");

const hre = require("hardhat");
const pools = require("./lib/pools");
const uniswapByChain = require("./lib/uniswap");
const { deployContract, deployProxyPair } = require("./lib/proxies");
const apebond = require("./lib/apebond");
// The core bootstrap routes nothing through the timelock (N-7). The optional ApeBond route
// builds ONE batch — the vault-escrow link — and only prints and files it.
const { TIMELOCK_KIND, buildBatch, encodeScheduleBatch, encodeExecuteBatch, describeCall } = require("./lp-timelock");

// Deploy the full LP staking stack and record every address in deployments.json.
//
// ──────────────────────── the bootstrap, and why it looks like this ────────────────────────
//
// FIVE UUPS proxies, every one of them born owned by the LPTimelock: each `initialize` names
// the timelock as the owner inside the proxy's own deployment transaction, and no key ever
// holds the owner tier, not even for one block. Nothing is left to hand over afterwards — no
// `setMinter`, no `transferOwnership`, no `acceptOwnership`: the Overture token is born with
// the operator as its minter, the distributor is born with both launch reward tokens, the
// registry is born bound to the distributor, and the vault is born pointing at the zapper.
//
// That last one works because the zapper's address is known before the zapper exists. A
// CREATE address is a pure function of (deployer, nonce), and every transaction in this
// script carries an explicit nonce (see `deployContract`). The vault implementation takes
// nonce N, the vault proxy N + 1, the zapper implementation N + 2 and the zapper PROXY N + 3;
// the script computes N + 3 with `getCreateAddress`, passes it to the vault's `initialize`,
// deploys the zapper, and asserts its proxy landed there. If it did not, the run throws and
// names the one repair: `setZapper` through the timelock.
//
// The order, in full:
//
//   1. config, local validation and the on-chain checks (pool triple, decimals, factory)
//   2. `LPTimelock(minDelay, [multisig], [multisig], address(0))` — depends on nothing,
//      and everything below names it, so it goes first
//   3. TokenOverture implementation + LPProxy,
//      `initialize(name, symbol, owner = timelock, minter = operator)`
//   4. RewardsDistributor implementation + LPProxy,
//      `initialize(owner = timelock, guardian, operator, signer,
//                  [{ASSET, conditional, claims LP_ASSET_CLAIMS_ENABLED}, {OVTR, unconditional, claims open}])`
//   5. LPEpochRegistry implementation (bound to the distributor) + LPProxy,
//      `initialize(owner = timelock, operator)`
//   6. predict the zapper PROXY's address from the deployer's nonce + 3
//   7. LPStakingVault implementation + LPProxy,
//      `initialize(owner = timelock, guardian, operator, zapper = predicted, window, ticks)` —
//      `bonusEscrow` stays zero (the ApeBond escrow is not part of this stack)
//   8. LPZapper implementation + LPProxy, `initialize(owner = timelock, operator, window, ticks)`;
//      record it, then assert the proxy address matches the prediction
//   9. ONLY with LP_APEBOND_ENABLED=1 (Sepolia test stack #6; mainnet deploys without it):
//      `BonusEscrow` implementation(bonusToken, vault) + LPProxy, `initialize(owner = timelock,
//      adapter = 0)`; `ApeBondPositionAdapter(positionManager, vault, escrow, owner = DEPLOYER,
//      guardian)`; its callers and campaign written by the deployer, then
//      `transferOwnership(timelock)`; and the ONE timelock batch that activates the route —
//      `vault.setBonusEscrow(escrow)`, `vault.setStakeOperator(adapter, true)`,
//      `escrow.setAdapter(adapter)` — PRINTED and FILED, not sent (see the route's note below)
//  10. `increaseObservationCardinalityNext` on the pool (permissionless)
//  11. post-deploy verification of all five proxies + the timelock (and the ApeBond pair), the
//      address summary, the verify commands, and the operator's next steps (fund the
//      distributor, schedule epoch 1, run the ApeBond link batch)
//
// Every proxy goes through `deployProxyPair`: `validateImplementation`, the implementation
// deploy, the `LPProxy` deploy with the `initialize` calldata, and `forceImport` into the
// `hardhat-upgrades` manifest — so `.openzeppelin/<network>.json` records all five layouts.
//
// ──────────────────────── the admin tiers ────────────────────────
//
// owner    = the LPTimelock, on all five proxies. Upgrades, `setZapper`, `setBonusEscrow`,
//            `setGuardian`, `setOperator`, `addRewardToken`, `setRewardTokenEnabled`,
//            `setClaimsEnabled`, `setMinter` — every one of them scheduled, public for
//            `minDelay`, then executed. The multisig is the timelock's only proposer,
//            executor and canceller.
// guardian = LP_GUARDIAN, a hot key. The three pause switches (vault deposits, vault
//            rebalance, distributor claims), with no delay and nothing else. Required at
//            deploy time, and it must NOT be the operator.
// operator = LP_OPERATOR, a multisig. Immediate levers on every proxy: the vault's and the
//            zapper's `setTwapParams` and `rescuePosition`, the zapper's `sweep`, the
//            distributor's `setSigner` and `recoverExcess`, the registry's epoch scheduling,
//            the pause switches as the cold fallback, `setGuardian` on the vault and the
//            distributor. It is also the Overture token's MINTER, and the party that funds the
//            distributor (mints $OVTR into it, transfers $ASSET into it). Required.
//
// Required env
//   LP_ASSET       — ASSET token (18 decimals), one side of the pool and a reward token
//   LP_USDC        — USDC token (6 decimals), the other side and the zap-in token
//   LP_POOL        — the Uniswap V3 ASSET-USDC pool this stack is bound to
//   LP_SIGNER      — backend voucher signer for RewardsDistributor; MUST NOT be
//                    the deployer or the multisig — it signs EIP-712 payloads on
//                    every claim, which a Ledger cannot serve
//   LP_MULTISIG    — the timelock's sole proposer, executor and canceller
//   LP_GUARDIAN    — pause tier (see above). A hot key; the run throws if it equals LP_OPERATOR
//   LP_OPERATOR    — operator tier on all five proxies and the Overture token's minter
//
// Optional env (defaults in parentheses)
//   LP_OVERTURE_NAME          — the Overture token's ERC-20 name, also its permit domain name
//                               ("Overture")
//   LP_OVERTURE_SYMBOL        — its ERC-20 symbol ("OVTR")
//   LP_ASSET_CLAIMS_ENABLED   — 1 to open $ASSET claims at deploy (0: closed at launch, opened
//                               later by the timelock with `setClaimsEnabled(ASSET, true)`)
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
//   LP_VAULT_CONTRACT         — TEST HOOK, refused on mainnet: the vault implementation's artifact
//                               (LPStakingVault). The ApeBond activation suite deploys the lane-1
//                               vault (LPStakingVaultLane1Mock) to rehearse the in-place upgrade
//   LP_OBSERVATION_CARDINALITY — oracle slots to grow the pool into (150). Must be at least
//                               2 * ceil(LP_TWAP_WINDOW / 12): one slot per block in the
//                               worst case, doubled for margin. 300 s needs >= 50, 3600 s
//                               needs >= 600
//
// Optional env — the ApeBond route (B.3 decision document; Sepolia only until ApeBond goes to
// mainnet). OFF unless LP_APEBOND_ENABLED=1; with it off nothing below is read and the run is
// exactly the stack above. There is no purchase signer: the adapter computes every bonus.
//   LP_APEBOND_ENABLED          — 1 deploys BonusEscrow + ApeBondPositionAdapter; 0 or unset not
//   LP_APEBOND_BONUS_TOKEN      — the escrow's immutable bonus token; must be one of the pool's
//                                 two tokens (LP_ASSET)
//   LP_APEBOND_GUARDIAN         — the adapter's pause key, setDepositsPaused only (LP_GUARDIAN)
//   LP_APEBOND_SOULZAP_CALLERS  — comma-separated SoulZap contracts: the global allowlist, and
//                                 the callers permitted for the campaign below (none)
//   LP_APEBOND_CAMPAIGN_ID and the campaign's four numbers — see `readCampaign` in
//                                 scripts/lib/apebond.js (none: no campaign is configured)
//   LP_APEBOND_BATCH_FILE       — where the link batch is filed (apebond-link-batch.json beside
//                                 the registry)
//
// ──────────────────────── the ApeBond route, and why its last step is printed ────────────────
//
// Every proxy here is born owned by the timelock, so the three owner-tier calls that activate
// the route cannot be sent by this run. They are ONE batch, atomic, and this run prints its
// `scheduleBatch` / `executeBatch` calldata and writes it as a `TIMELOCK_BATCH` file. Until it
// executes, nothing can be bought: the vault refuses the adapter's `stakeFor` and the escrow
// refuses its `reserve`. Drive it with `scripts/deploy-apebond.js` (default mode: it finds the
// pair already deployed, builds the same batch, schedules, waits, executes on a test chain, and
// asserts the link) or with `lp-timelock.js schedule-batch` / `execute-batch` from the multisig.
//
// Funding and the emission schedule are NOT part of this script: the operator funds the
// distributor with `scripts/lp-fund-rewards.js` and schedules epochs with `scripts/lp-epoch.js`.
//
// Mainnet needs CONFIRM=yes, like every other state-changing script here.

// ERC-1967 implementation slot: keccak256("eip1967.proxy.implementation") - 1.
const ERC1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

// 48 h, the figure `docs/specs/01-contracts.md` §2.5 proposes for mainnet. Every upgrade is
// visible on-chain for at least this long before it can execute, and `unstake` is never
// pausable, so the delay IS the exit window.
const DEFAULT_TIMELOCK_MIN_DELAY = 172800;

// The proxies are deployed through `lib/proxies.js`, whose `UUPS_UNSAFE_ALLOW` is the spec's
// exception (§1): the vault, the registry and the zapper keep their fixed protocol references
// `immutable`, set in a constructor that ends with `_disableInitializers()`. Identical to the
// lists in `validate-upgrade-safety.js` and `deploy-implementation.js` — never drift apart.

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
const OVERTURE_DECIMALS = 18;

// The Overture token's launch branding (Brandon, 1 Oct): ERC-20 name "Overture", symbol "OVTR",
// ticker $OVTR. The name is also the permit domain name, fixed at deploy.
const DEFAULT_OVERTURE_NAME = "Overture";
const DEFAULT_OVERTURE_SYMBOL = "OVTR";

// keccak256("RewardClaim(address token,address user,uint256 cumulativeAmount,uint256 deadline)")
const REWARD_CLAIM_TYPEHASH = "0x746a03cb3aaddb17f8408279b7ff5133a65d78143d19fbd50c05d05bca850c63";

// LPEpochRegistry's constants, re-declared so the post-deploy check compares against the spec.
const REGISTRY_INTERVAL = 900;
const REGISTRY_SCHEDULE_MARGIN = 1800;

/** Parses a 0/1/true/false env flag; anything else is an error rather than a guess. */
function readFlag(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  throw new Error(`${name} must be 0 or 1 (or true/false) — got ${raw}`);
}

/** The ERC-1967 implementation slot of `proxy`, as an address. */
async function implementationOf(proxy) {
  const raw = await hre.ethers.provider.getStorage(proxy, ERC1967_IMPLEMENTATION_SLOT);
  return hre.ethers.getAddress("0x" + raw.slice(-40));
}

/**
 * Where the ApeBond link batch is filed: `LP_APEBOND_BATCH_FILE`, else beside the registry this
 * run writes (so a run on a scratch `DEPLOYMENTS_FILE` leaves the file in the scratch directory).
 */
function resolveApeBondBatchFile() {
  if (process.env.LP_APEBOND_BATCH_FILE) return path.resolve(process.env.LP_APEBOND_BATCH_FILE);
  const registryPath = process.env.DEPLOYMENTS_FILE
    ? path.resolve(process.env.DEPLOYMENTS_FILE)
    : path.join(__dirname, "..", "deployments.json");
  return path.join(path.dirname(registryPath), "apebond-link-batch.json");
}

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
  // Routine-operations tier on all five proxies: TWAP calibration and NFT rescue (vault and
  // zapper), the zapper's sweep, the distributor's signer rotation and recovery, the
  // registry's epoch scheduling, all three pause switches as the cold fallback for a lost
  // guardian key, and `setGuardian` on the vault and the distributor. It is also the Overture
  // token's minter and the address rescued NFTs and recovered tokens are sent to. Required.
  const operator = readAddress("LP_OPERATOR");

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

  const overtureName = process.env.LP_OVERTURE_NAME || DEFAULT_OVERTURE_NAME;
  const overtureSymbol = process.env.LP_OVERTURE_SYMBOL || DEFAULT_OVERTURE_SYMBOL;
  // $ASSET claims are CLOSED at launch (Q-e): they open later, after maturity, through a
  // timelock `setClaimsEnabled(ASSET, true)`. The flag exists for rehearsals that need them open.
  const assetClaimsEnabled = readFlag("LP_ASSET_CLAIMS_ENABLED", false);
  // The vault implementation's artifact. Production never sets it. The ApeBond activation suite
  // sets `LPStakingVaultLane1Mock` — lane 1's vault as mainnet deploys it, without the
  // stake-operator allowlist — to rehearse activating the route on a live mainnet-shaped stack.
  const vaultContract = process.env.LP_VAULT_CONTRACT || "LPStakingVault";
  if (mainnet && vaultContract !== "LPStakingVault") {
    throw new Error(`LP_VAULT_CONTRACT=${vaultContract} is a test hook and is refused on mainnet`);
  }
  if (process.env.LP_APEBOND_ENABLED === "1" && vaultContract !== "LPStakingVault") {
    throw new Error(
      `LP_APEBOND_ENABLED=1 deploys the route onto a FRESH current vault; LP_VAULT_CONTRACT=${vaultContract} ` +
        `is the pre-route vault, which scripts/deploy-apebond.js activates in place instead`
    );
  }

  // ──── the ApeBond route, off unless asked for ────
  // Every value below is read only when the flag is on, so a stale LP_APEBOND_* left in a shell
  // changes nothing on a run that does not deploy the route.
  const apeBond = apebond.readApeBondFlag();
  const bonusToken = apeBond ? readAddress("LP_APEBOND_BONUS_TOKEN", asset) : null;
  const apeBondGuardian = apeBond ? readAddress("LP_APEBOND_GUARDIAN", guardian) : null;
  const soulZapCallers = apeBond ? apebond.readAddressList("LP_APEBOND_SOULZAP_CALLERS") : [];

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
  console.log(`Overture token:     ${overtureName} (${overtureSymbol}), minter = the operator`);
  console.log(
    `Reward tokens:      ASSET (conditional, claims ${assetClaimsEnabled ? "OPEN" : "closed"}), ` +
      `${overtureSymbol} (unconditional, claims open)`
  );
  console.log(`TWAP window:        ${twapWindow}s`);
  console.log(
    `TWAP max deviation: ${twapMaxDeviationBps} bps = ${twapMaxDeviationTicks} ticks (what the contract stores)`
  );
  console.log(
    `Observation target: ${observationCardinality} (>= ${minimumCardinality} for a ${twapWindow}s window)`
  );
  if (!apeBond) console.log(`ApeBond route:      not deployed (set LP_APEBOND_ENABLED=1 to add it)`);

  // ──────────────────────── on-chain safety checks ────────────────────────

  console.log("\nChecking the configuration on-chain...");

  for (const [label, address] of [
    ["LP_POOL", poolAddress],
    ["LP_NPM", positionManager],
    ["LP_ROUTER", swapRouter],
    ["LP_FACTORY", factoryAddress],
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

  // The ApeBond route's inputs, checked before a single byte is deployed: the bonus token must
  // be one of the pool's two tokens (the escrow's constructor enforces it too), and the campaign
  // must be a range a position on this pool can have.
  let apeBondCampaign = null;
  let apeBondFacts = null;
  if (apeBond) {
    if (bonusToken !== token0 && bonusToken !== token1) {
      throw new Error(`LP_APEBOND_BONUS_TOKEN ${bonusToken} is neither pool token (${token0}, ${token1})`);
    }
    const poolSpacing = await hre.ethers.getContractAt(
      ["function tickSpacing() view returns (int24)"],
      poolAddress
    );
    const bonusErc20 = await pools.getErc20(bonusToken);
    apeBondFacts = {
      currentTick: Number(slot0.tick),
      tickSpacing: Number(await poolSpacing.tickSpacing()),
      bonusDecimals: Number(await bonusErc20.decimals()),
      bonusSymbol: await bonusErc20.symbol(),
    };
    apeBondCampaign = apebond.readCampaign(apeBondFacts);
    console.log(`ApeBond route:      ENABLED (LP_APEBOND_ENABLED=1)`);
    console.log(`  bonus token:      ${bonusToken}${bonusToken === asset ? " (= ASSET)" : ""}`);
    console.log(`  guardian:         ${apeBondGuardian}${apeBondGuardian === guardian ? " (= LP_GUARDIAN)" : ""}`);
    console.log(`  SoulZap callers:  ${soulZapCallers.length > 0 ? soulZapCallers.join(", ") : "none"}`);
    console.log(`  campaign:         ${apebond.describeCampaign(apeBondCampaign, apeBondFacts)}`);
  }

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


  pools.requireConfirmation(chainId, "deploy the LP staking stack");
  if (mainnet) console.log("\nEvery transaction below needs a Ledger confirmation.");

  // ──────────────────────── deploy ────────────────────────

  // The timelock first. It depends on nothing, and all five proxies name it as their owner in
  // their own deployment transaction, so it has to exist before any of them.
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

  // The Overture token: a UUPS proxy born owned by the timelock (upgrades, `setMinter`), with
  // the operator as its minter. No cap of any kind: the operator mints $OVTR INTO the
  // distributor, which pays claims out of that balance by transfer.
  const overtureDeploy = await deployProxyPair(
    "TokenOverture",
    [],
    [overtureName, overtureSymbol, timelockDeploy.address, operator],
    deployer
  );
  pools.recordDeployment(chainId, "TokenOverture", overtureDeploy.address, {
    deployTx: overtureDeploy.tx.hash,
    block: overtureDeploy.receipt.blockNumber,
    implementation: overtureDeploy.impl.address,
    implementationTx: overtureDeploy.impl.tx.hash,
    name: overtureName,
    symbol: overtureSymbol,
    decimals: OVERTURE_DECIMALS,
    owner: timelockDeploy.address,
    minter: operator,
  });

  // The distributor, born with both launch reward tokens. Every reward token is PRE-FUNDED and
  // paid by transfer; a claim whose token balance is short reverts with InsufficientFunds until
  // the operator funds it. There is no cap anywhere.
  const launchRewardTokens = [
    { token: asset, conditional: true, claimsEnabled: assetClaimsEnabled },
    { token: overtureDeploy.address, conditional: false, claimsEnabled: true },
  ];
  const distributorDeploy = await deployProxyPair(
    "RewardsDistributor",
    [],
    [
      timelockDeploy.address,
      guardian,
      operator,
      signer,
      launchRewardTokens.map((t) => [t.token, t.conditional, t.claimsEnabled]),
    ],
    deployer
  );
  pools.recordDeployment(chainId, "RewardsDistributor", distributorDeploy.address, {
    deployTx: distributorDeploy.tx.hash,
    block: distributorDeploy.receipt.blockNumber,
    implementation: distributorDeploy.impl.address,
    implementationTx: distributorDeploy.impl.tx.hash,
    signer,
    owner: timelockDeploy.address,
    guardian,
    operator,
    rewardTokens: [
      {
        address: asset,
        symbol: await assetToken.symbol(),
        decimals: ASSET_DECIMALS,
        conditional: true,
        claimsEnabled: assetClaimsEnabled,
      },
      {
        address: overtureDeploy.address,
        symbol: overtureSymbol,
        decimals: OVERTURE_DECIMALS,
        conditional: false,
        claimsEnabled: true,
      },
    ],
  });

  // The emission schedule. Its implementation is bound to the distributor (immutable); the
  // proxy is born owned by the timelock with the operator as the scheduler. No epoch exists
  // yet: the operator schedules epoch 1 with lp-epoch.js, at least 30 minutes ahead.
  const registryDeploy = await deployProxyPair(
    "LPEpochRegistry",
    [distributorDeploy.address],
    [timelockDeploy.address, operator],
    deployer
  );
  pools.recordDeployment(chainId, "LPEpochRegistry", registryDeploy.address, {
    deployTx: registryDeploy.tx.hash,
    block: registryDeploy.receipt.blockNumber,
    implementation: registryDeploy.impl.address,
    implementationTx: registryDeploy.impl.tx.hash,
    distributor: distributorDeploy.address,
    owner: timelockDeploy.address,
    operator,
    interval: REGISTRY_INTERVAL,
    scheduleMargin: REGISTRY_SCHEDULE_MARGIN,
  });

  // The vault is born owned by the timelock, so nobody can call `setZapper` at bootstrap
  // without a 48 h schedule. Instead the zapper's PROXY address is passed to `initialize` ahead
  // of its deployment: CREATE addresses are a pure function of (deployer, nonce), and every
  // transaction in this script carries an explicit nonce, so the next four are known now —
  // vault implementation (N), vault proxy (N + 1), zapper implementation (N + 2), zapper
  // proxy (N + 3).
  const vaultImplNonce = await pools.resolveNonce(deployer.address);
  const predictedZapper = hre.ethers.getCreateAddress({ from: deployer.address, nonce: vaultImplNonce + 3 });
  console.log(`\nPredicted LPZapper proxy address: ${predictedZapper} (deployer nonce ${vaultImplNonce + 3})`);

  // The vault: implementation (the six immutables, the live pool triple check on them, and
  // `_disableInitializers()`), then an LPProxy. Owner = the timelock, zapper = the address the
  // zapper proxy will land on. `bonusEscrow` is not an initialize argument and stays zero: the
  // ApeBond escrow is not part of this stack, and linking one is a timelock `setBonusEscrow`.
  const vaultDeploy = await deployProxyPair(
    vaultContract,
    [positionManager, poolAddress, token0, token1, fee, swapRouter],
    [timelockDeploy.address, guardian, operator, predictedZapper, twapWindow, twapMaxDeviationTicks],
    deployer
  );
  pools.recordDeployment(chainId, "LPStakingVault", vaultDeploy.address, {
    deployTx: vaultDeploy.tx.hash,
    block: vaultDeploy.receipt.blockNumber,
    implementation: vaultDeploy.impl.address,
    implementationTx: vaultDeploy.impl.tx.hash,
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
    bonusEscrow: hre.ethers.ZeroAddress,
  });

  // The zapper: implementation (nine immutables, the live pool triple check), then an LPProxy
  // owned by the timelock with the operator holding the immediate levers.
  const zapperDeploy = await deployProxyPair(
    "LPZapper",
    [vaultDeploy.address, positionManager, poolAddress, token0, token1, fee, swapRouter, usdc, asset],
    [timelockDeploy.address, operator, twapWindow, twapMaxDeviationTicks],
    deployer
  );
  // Recorded BEFORE the prediction is checked: if the address is wrong the run throws, and
  // the address of a contract that is already on chain must not be lost with it.
  pools.recordDeployment(chainId, "LPZapper", zapperDeploy.address, {
    deployTx: zapperDeploy.tx.hash,
    block: zapperDeploy.receipt.blockNumber,
    implementation: zapperDeploy.impl.address,
    implementationTx: zapperDeploy.impl.tx.hash,
    vault: vaultDeploy.address,
    usdc,
    asset,
    twapWindow,
    maxTwapDeviationTicks: twapMaxDeviationTicks,
    owner: timelockDeploy.address,
    operator,
  });

  if (zapperDeploy.address.toLowerCase() !== predictedZapper.toLowerCase()) {
    throw new Error(
      `LPZapper's proxy landed at ${zapperDeploy.address}, but the vault was initialized with ` +
        `${predictedZapper}. The stack is deployed and recorded; the zap path is OFF until the ` +
        `timelock executes LPStakingVault.setZapper(${zapperDeploy.address}) ` +
        `(TIMELOCK_TARGET=LPStakingVault TIMELOCK_FN=setZapper). Staking works meanwhile.`
    );
  }
  console.log(`  LPZapper's proxy landed on the predicted address; the vault was born pointing at it`);

  // ──────────────────────── the ApeBond route (optional) ────────────────────────
  let apeBondDeploy = null;
  let apeBondBatch = null;
  let apeBondBatchFile = null;
  if (apeBond) {
    apeBondDeploy = await apebond.deployEscrowAndAdapter({
      chainId,
      deployer,
      vaultAddress: vaultDeploy.address,
      timelockAddress: timelockDeploy.address,
      positionManager,
      bonusToken,
      guardian: apeBondGuardian,
    });
    await apebond.wireAdapter({
      chainId,
      deployer,
      adapterAddress: apeBondDeploy.adapterDeploy.address,
      timelockAddress: timelockDeploy.address,
      soulZapCallers,
      campaign: apeBondCampaign,
    });
    const ops = await apebond.linkOps({
      vaultAddress: vaultDeploy.address,
      escrowAddress: apeBondDeploy.escrowDeploy.address,
      adapterAddress: apeBondDeploy.adapterDeploy.address,
      upgradeTo: null,
      vaultHasRoute: true,
    });
    apeBondBatch = buildBatch(ops, process.env.TIMELOCK_SALT_TAG || "");
    apeBondBatchFile = resolveApeBondBatchFile();
    fs.writeFileSync(
      apeBondBatchFile,
      JSON.stringify(apebond.batchFileContents(apeBondBatch.calls), null, 2) + "\n"
    );
  }

  const overture = overtureDeploy.contract;
  const distributor = distributorDeploy.contract;
  const registry = registryDeploy.contract;
  const vault = vaultDeploy.contract;
  const zapper = zapperDeploy.contract;

  // Nothing to wire and nothing to hand over: every proxy was born with its final owner, its
  // final roles and its final links.

  // ──────────────────────── oracle warm-up ────────────────────────
  // Permissionless: any key may grow the oracle.

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

  // Every proxy has exactly ONE legal end state: born owned by the timelock, with nothing
  // pending. There is no interim, no branch and no window in which a key owns one of them.
  const expectedProxyOwner = timelockDeploy.address;
  const expectedPendingOwner = hre.ethers.ZeroAddress;

  check("TokenOverture.name", await overture.name(), overtureName);
  check("TokenOverture.symbol", await overture.symbol(), overtureSymbol);
  check("TokenOverture.decimals", await overture.decimals(), OVERTURE_DECIMALS);
  check("TokenOverture.minter", await overture.minter(), operator);
  check("TokenOverture.owner", await overture.owner(), expectedProxyOwner);
  check("TokenOverture.pendingOwner", await overture.pendingOwner(), expectedPendingOwner);
  check("TokenOverture.totalSupply", await overture.totalSupply(), 0);
  check(
    "TokenOverture.implementation (ERC-1967 slot)",
    await implementationOf(overtureDeploy.address),
    overtureDeploy.impl.address
  );

  check("RewardsDistributor.signer", await distributor.signer(), signer);
  check("RewardsDistributor.owner", await distributor.owner(), expectedProxyOwner);
  check("RewardsDistributor.pendingOwner", await distributor.pendingOwner(), expectedPendingOwner);
  check("RewardsDistributor.guardian", await distributor.guardian(), guardian);
  check("RewardsDistributor.operator", await distributor.operator(), operator);
  check("RewardsDistributor.paused", await distributor.paused(), false);
  check("RewardsDistributor.REWARD_CLAIM_TYPEHASH", await distributor.REWARD_CLAIM_TYPEHASH(), REWARD_CLAIM_TYPEHASH);
  const domain = await distributor.eip712Domain();
  check("RewardsDistributor.eip712Domain.name", domain.name, "RealLPRewards");
  check("RewardsDistributor.eip712Domain.version", domain.version, "1");
  check("RewardsDistributor.eip712Domain.verifyingContract", domain.verifyingContract, distributorDeploy.address);
  const onChainTokens = await distributor.rewardTokens();
  check("RewardsDistributor.rewardTokens().length", onChainTokens.length, launchRewardTokens.length);
  for (let index = 0; index < launchRewardTokens.length; index++) {
    const expected = launchRewardTokens[index];
    const label = `RewardsDistributor.rewardTokens()[${index}]`;
    check(label, onChainTokens[index] || "(missing)", expected.token);
    const state = await distributor.rewardToken(expected.token);
    check(`${label}.registered`, state.registered, true);
    check(`${label}.enabled`, state.enabled, true);
    check(`${label}.conditional`, state.conditional, expected.conditional);
    check(`${label}.claimsEnabled`, state.claimsEnabled, expected.claimsEnabled);
    check(`${label}.decimals`, state.decimals, 18);
  }
  check(
    "RewardsDistributor.implementation (ERC-1967 slot)",
    await implementationOf(distributorDeploy.address),
    distributorDeploy.impl.address
  );

  check("LPEpochRegistry.distributor", await registry.distributor(), distributorDeploy.address);
  check("LPEpochRegistry.owner", await registry.owner(), expectedProxyOwner);
  check("LPEpochRegistry.pendingOwner", await registry.pendingOwner(), expectedPendingOwner);
  check("LPEpochRegistry.operator", await registry.operator(), operator);
  check("LPEpochRegistry.epochCount", await registry.epochCount(), 0);
  check("LPEpochRegistry.lastLiveId", await registry.lastLiveId(), 0);
  check("LPEpochRegistry.INTERVAL", await registry.INTERVAL(), REGISTRY_INTERVAL);
  check("LPEpochRegistry.SCHEDULE_MARGIN", await registry.SCHEDULE_MARGIN(), REGISTRY_SCHEDULE_MARGIN);
  check(
    "LPEpochRegistry.implementation (ERC-1967 slot)",
    await implementationOf(registryDeploy.address),
    registryDeploy.impl.address
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
  // The ApeBond escrow hooks ship OFF: no escrow is linked by this script.
  check("LPStakingVault.bonusEscrow", await vault.bonusEscrow(), hre.ethers.ZeroAddress);
  // Reads the ERC-1967 slot rather than trusting the constructor argument: this is the only
  // proof that the proxy in the registry really delegates to the implementation in it.
  check(
    "LPStakingVault.implementation (ERC-1967 slot)",
    await implementationOf(vaultDeploy.address),
    vaultDeploy.impl.address
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
  check("LPZapper.owner", await zapper.owner(), expectedProxyOwner);
  check("LPZapper.pendingOwner", await zapper.pendingOwner(), expectedPendingOwner);
  check("LPZapper.operator", await zapper.operator(), operator);
  check(
    "LPZapper.implementation (ERC-1967 slot)",
    await implementationOf(zapperDeploy.address),
    zapperDeploy.impl.address
  );

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
  // empty on all five proxies. A non-zero value there would mean a transparent proxy's
  // ProxyAdmin got in somehow, and with it a second, unowned upgrade path.
  for (const [label, address] of [
    ["TokenOverture", overtureDeploy.address],
    ["RewardsDistributor", distributorDeploy.address],
    ["LPEpochRegistry", registryDeploy.address],
    ["LPStakingVault", vaultDeploy.address],
    ["LPZapper", zapperDeploy.address],
  ]) {
    check(
      `${label}.adminSlot (ERC-1967, must be empty for UUPS)`,
      await hre.upgrades.erc1967.getAdminAddress(address),
      hre.ethers.ZeroAddress
    );
  }

  if (apeBond) {
    // Everything the route needs except the link, which is the batch this run does not send.
    await apebond.checkRoute(check, {
      vaultAddress: vaultDeploy.address,
      escrowAddress: apeBondDeploy.escrowDeploy.address,
      adapterAddress: apeBondDeploy.adapterDeploy.address,
      timelockAddress: timelockDeploy.address,
      bonusToken,
      guardian: apeBondGuardian,
      soulZapCallers,
      campaign: apeBondCampaign,
      expectLinked: false,
    });
    check(
      "BonusEscrow.implementation (ERC-1967 slot)",
      await implementationOf(apeBondDeploy.escrowDeploy.address),
      apeBondDeploy.escrowDeploy.impl.address
    );
    console.log(
      "WARN  the route is NOT linked yet — PENDING TIMELOCK BATCH (below). Until it executes:\n" +
        "      LPStakingVault.bonusEscrow() == 0, the adapter is not a stake operator, and the escrow's\n" +
        "      adapter is 0, so no ApeBond purchase can be made. Everything else is live."
    );
  }

  // ──────────────────────── summary ────────────────────────

  console.log("\n──────── deployed addresses ────────");
  for (const [label, d] of [
    ["TokenOverture", overtureDeploy],
    ["RewardsDistributor", distributorDeploy],
    ["LPEpochRegistry", registryDeploy],
    ["LPStakingVault", vaultDeploy],
    ["LPZapper", zapperDeploy],
  ]) {
    console.log(`${label.padEnd(20)}${d.address} (proxy)`);
    console.log(`  implementation:   ${d.impl.address}`);
  }
  if (apeBond) {
    console.log(`BonusEscrow         ${apeBondDeploy.escrowDeploy.address} (proxy)`);
    console.log(`  implementation:   ${apeBondDeploy.escrowDeploy.impl.address}`);
    console.log(`ApeBondAdapter:     ${apeBondDeploy.adapterDeploy.address}`);
  }
  console.log(`LPTimelock:         ${timelockDeploy.address} (minDelay ${timelockMinDelay}s)`);

  const network = hre.network.name;
  console.log("\n──────── verify on the explorer ────────");
  // Each proxy needs two commands: one for the implementation (its constructor arguments) and
  // one for the proxy itself (the implementation address + the `initialize` calldata).
  const verifyPair = (d, implArgs) => {
    console.log(`npx hardhat verify --network ${network} ${d.impl.address}${implArgs ? ` ${implArgs}` : ""}`);
    console.log(`npx hardhat verify --network ${network} ${d.proxy.address} ${d.impl.address} ${d.initData}`);
  };
  verifyPair(overtureDeploy, "");
  verifyPair(distributorDeploy, "");
  verifyPair(registryDeploy, distributorDeploy.address);
  verifyPair(vaultDeploy, `${positionManager} ${poolAddress} ${token0} ${token1} ${fee} ${swapRouter}`);
  verifyPair(
    zapperDeploy,
    `${vaultDeploy.address} ${positionManager} ${poolAddress} ${token0} ${token1} ${fee} ${swapRouter} ${usdc} ${asset}`
  );
  if (apeBond) {
    verifyPair(apeBondDeploy.escrowDeploy, `${bonusToken} ${vaultDeploy.address}`);
    console.log(
      `npx hardhat verify --network ${network} ${apeBondDeploy.adapterDeploy.address} ` +
        `${positionManager} ${vaultDeploy.address} ${apeBondDeploy.escrowDeploy.address} ` +
        `${deployer.address} ${apeBondGuardian}`
    );
  }
  // The timelock's proposer/executor arrays are address[]; hardhat-verify wants them as JSON.
  console.log(
    `npx hardhat verify --network ${network} ${timelockDeploy.address} ` +
      `${timelockMinDelay} '["${multisig}"]' '["${multisig}"]' ${hre.ethers.ZeroAddress}`
  );

  console.log(
    "\n──────── next steps for the operator (nothing below was done by this run) ────────\n" +
      `1. Fund the distributor (the operator mints ${overtureSymbol} into it and transfers ASSET):\n` +
      `   LP_FUND_OVTR_AMOUNT=… LP_FUND_ASSET_AMOUNT=… npx hardhat run scripts/lp-fund-rewards.js --network ${network}\n` +
      "   Claims of a token revert with InsufficientFunds until its balance covers them.\n" +
      "2. Schedule epoch 1 on the registry, at least 30 minutes before it starts:\n" +
      `   EPOCH_ACTION=schedule EPOCH_ID=1 EPOCH_STARTS_AT=… EPOCH_ENDS_AT=… npx hardhat run scripts/lp-epoch.js --network ${network}\n` +
      "3. Register the five proxies with the indexer module and the backend (scripts/README.md)."
  );

  if (apeBond) {
    console.log(
      `\n──────── the ApeBond link: ONE timelock batch this run does NOT send ────────\n` +
        `Send it from the multisig (${multisig}), the timelock's proposer and executor, to the\n` +
        `timelock at ${timelockDeploy.address}, value 0. Batch id ${apeBondBatch.id}:`
    );
    apeBondBatch.calls.forEach((call, index) => console.log(`  ${index}. ${describeCall(call)}`));
    console.log(`\n  scheduleBatch calldata (delay ${timelockMinDelay}s):`);
    console.log(`  ${encodeScheduleBatch(apeBondBatch, timelockMinDelay)}`);
    console.log(`\n  ...wait out ${timelockMinDelay}s, then executeBatch calldata:`);
    console.log(`  ${encodeExecuteBatch(apeBondBatch)}`);
    console.log(
      `\nThe same batch as a file: ${apeBondBatchFile}\n` +
        `  TIMELOCK_ACTION=schedule-batch TIMELOCK_BATCH=${apeBondBatchFile} \\\n` +
        `    npx hardhat run scripts/lp-timelock.js --network ${network}\n` +
        `or, where the deploying key holds both timelock roles (a test stack), one command that\n` +
        `schedules, waits, executes and asserts the link:\n` +
        `  npx hardhat run scripts/deploy-apebond.js --network ${network}`
    );
  }

  if (failures.length > 0) {
    throw new Error(
      `Post-deploy verification failed for: ${failures.join(", ")}. ` +
        `The contracts are deployed and recorded in deployments.json — fix the state from the ` +
        `operator, or through the timelock for an owner-tier field.`
    );
  }
  console.log("\nAll post-deploy checks passed.");
}

// The bootstrap primitives, shared with `scripts/deploy-apebond.js`, which adds the ApeBond
// contracts to a stack that is ALREADY live. Both deploys produce byte-identical shapes through
// `lib/proxies.js`, so the two scripts run the same code rather than two copies that can drift.
module.exports = {
  ERC1967_IMPLEMENTATION_SLOT,
  readAddress,
  readAddressList: apebond.readAddressList,
  readApeBondFlag: apebond.readApeBondFlag,
  implementationOf,
  deployContract,
  deployProxyPair,
};

// `hardhat run` executes this file as the entry point; a `require` from another script or from
// the suites must only pick up the exports above, and must NOT deploy a stack.
if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
