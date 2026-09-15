const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const pools = require("./lib/pools");
const C = require("../test/lp-staking/helpers/constants");
const signing = require("../test/lp-staking/helpers/signing");

// The live ApeBond rehearsal: one real purchase, end to end, on a TEST STACK.
//
// ──────────────────────── what this proves, and why it has to be live ────────────────────────
//
// Every part of the ApeBond route is already under test — 58 Hardhat cases on the adapter, 40 on
// the escrow, the B1–B10 scenario on a pinned mainnet fork, and `deploy-apebond.js` itself driven
// as a child process on a spawned node. None of that proves the LIVE stack is wired: that the
// adapter the timelock allowlisted is the one the escrow points at, that the key the backend
// holds is the key the adapter recovers to, that the SoulZap seat really is allowlisted, and that
// a bonus reserved on chain can be claimed by the person it names once the cliff passes. Those
// are facts about ONE deployment, and the only way to establish them is to buy a position with
// real gas and claim the bonus afterwards.
//
// SoulZap is not deployed on a test stack, so its seat is played by a wallet the operator holds
// (`LP_REHEARSAL_CALLER_KEY`), allowlisted on the adapter at activation time through
// `LP_APEBOND_SOULZAP_CALLERS`. That wallet does what SoulZap would do — it mints the position and
// presents the authorization — and nothing else about the flow changes: the same `depositFor`, the
// same 15-field EIP-712 authorization, the same custody assertions.
//
// ──────────────────────── test stacks only ────────────────────────
//
// This script REFUSES chain 1 outright, with no `CONFIRM=yes` escape. Nothing here is an operator
// action on a production stack: it mints liquidity, signs an authorization with a key read out of
// the environment, and burns a purchase id — all of which belong on a stack that exists to be
// experimented on. A mainnet campaign is driven by SoulZap and by the backend, not from here.
//
// ──────────────────────── the two phases ────────────────────────
//
//   LP_REHEARSAL_PHASE=deposit  (default) From the caller wallet: approve both pool tokens to the
//                               position manager, `NPM.mint` the campaign's range, read the
//                               minted liquidity back, build and sign the `PurchaseAuthorization`,
//                               approve the adapter for the NFT, and call `depositFor`. Then
//                               assert the four facts the purchase is supposed to have produced —
//                               the vault owns the NFT, the vault credits the BENEFICIARY with it,
//                               the escrow holds a matching unclaimed reservation, and the
//                               `ApeBondPositionDeposited` log is in the receipt — and write the
//                               record file.
//
//   LP_REHEARSAL_PHASE=claim    After the cliff. Reads the record (or takes the purchase id
//                               directly), asserts `claimable(purchaseId)` equals the bonus,
//                               sends `claim` from the DEPLOYER — anyone may trigger it, and using
//                               a different wallet than the beneficiary is the point: the money
//                               still goes to the beneficiary — then asserts the beneficiary's
//                               balance grew by exactly the bonus and that a second claim reverts.
//
// Between the two the operator waits out `LP_REHEARSAL_CLIFF_SECONDS` (default 300, the Sepolia
// test stack #5 cliff). Run the claim phase early and it prints the seconds remaining and exits
// non-zero.
//
// ──────────────────────── the record file ────────────────────────
//
// `apebond-rehearsal-<chainId>.json`, written beside the registry file (so a run driven by a
// scratch `DEPLOYMENTS_FILE` leaves it in the scratch directory). It carries the token id, the
// purchase id, the unlock timestamp, the figures and every transaction hash, which is what lets
// the claim phase run in a different shell, on a different day, with no arguments. It is a run
// artifact, not a record of the deployment — `.gitignore` covers it, exactly as it covers
// `apebond-*-batch.json`.
//
// ──────────────────────── the environment ────────────────────────
//
//   LP_REHEARSAL_PHASE             deposit | claim (deposit)
//   LP_REHEARSAL_CALLER_KEY        private key of the wallet playing the SoulZap seat. It MUST
//                                  already be allowlisted on the adapter; the run checks
//                                  `soulZapCallers(caller)` and stops before the mint if it is
//                                  not. Deposit phase only. Never printed
//   LP_REHEARSAL_CALLER_IMPERSONATE  the SoulZap seat's ADDRESS, played without its private key
//                                  by impersonating it on a Hardhat node. Honoured on chain
//                                  31337 ONLY and refused loudly anywhere else — see
//                                  `scripts/lib/pools.js:impersonatedSignerFromEnv`. It exists
//                                  for the opt-in fork dry-run, which rehearses this script
//                                  against a fork of the live stack and must not hold the live
//                                  wallet's key. Mutually exclusive with LP_REHEARSAL_CALLER_KEY
//   LP_REHEARSAL_BENEFICIARY       the buyer: who the vault credits with the position and who the
//                                  escrow pays. Deposit phase only
//   LP_APEBOND_PURCHASE_SIGNER_KEY private key that signs the authorization. It must match
//                                  `adapter.purchaseSigner()`, which the run checks against the
//                                  chain. Deposit phase only. Never printed
//   LP_REHEARSAL_CLIFF_SECONDS     how long the bonus is locked, from the deposit (300)
//   LP_REHEARSAL_PURCHASE_ID       claim phase: the purchase to claim. Defaults to the one in the
//                                  record file
//   LP_REHEARSAL_GROSS/_NET/_BONUS the sample figures, in whole tokens. Gross and net are parsed
//                                  in the INPUT token's decimals, the bonus in the BONUS token's.
//                                  Default to the sample campaign in
//                                  test/lp-staking/helpers/constants.js — 10,000 gross, 9,900 net
//                                  after a 1% fee, 495 bonus (5% of the net)
//   LP_REHEARSAL_AMOUNT0/_AMOUNT1  what to mint with, in whole token0 / token1. Unset means the
//                                  run computes a value-balanced pair from the pool's own price
//                                  and the range, sized to fit the caller's balances — see
//                                  {defaultMintAmounts}
//   LP_REHEARSAL_BUDGET_BPS        the share of each balance those defaults may use (5000 = half)
//   LP_REHEARSAL_INPUT_TOKEN       the authorization's `inputToken`. Audit trail only — the
//                                  adapter never moves it. Defaults to the pool's token1
//   LP_REHEARSAL_HALF_WIDTH_TICKS  half-width of the campaign range around the pool's current
//                                  tick (1200, the sample campaign's)
//   LP_REHEARSAL_TICK_LOWER/_UPPER the range, stated outright instead of derived
//   LP_REHEARSAL_RECORD            where the record file lives
//   LP_APEBOND_ADAPTER/_ESCROW/_VAULT  address overrides for the registry lookups
//   DEPLOYMENTS_FILE               redirects the registry, like every other script here
//
//     LP_REHEARSAL_CALLER_KEY=0x… LP_REHEARSAL_BENEFICIARY=0x… \
//     LP_APEBOND_PURCHASE_SIGNER_KEY=0x… \
//       npx hardhat run scripts/apebond-rehearsal.js --network sepolia
//
//     # ...wait out the cliff...
//     LP_REHEARSAL_PHASE=claim npx hardhat run scripts/apebond-rehearsal.js --network sepolia
//
// The runbook is in scripts/README.md under "After the activation: opening the route".

const ADAPTER_KIND = "ApeBondPositionAdapter";
const ESCROW_KIND = "BonusEscrow";
const VAULT_KIND = "LPStakingVault";

const PHASES = ["deposit", "claim"];
const DEFAULT_PHASE = "deposit";

/**
 * The cliff a rehearsal uses: 300 seconds, the Sepolia test stack #5 cliff. Production is TBD
 * with ApeBond (expected 2–3 months). The unlock is a full cliff with no vesting, because the
 * buyer's position is an NFT and cannot be split into time-released parts (decided 2026-09-15).
 */
const DEFAULT_CLIFF_SECONDS = 300;
/** How long the signed authorization stays good for. One hour, as a quote would be. */
const AUTHORIZATION_TTL_SECONDS = 3600;
/** Share of each balance the computed mint amounts may spend, in basis points. */
const DEFAULT_BUDGET_BPS = 5000n;

/** The campaign every rehearsal purchase is tagged with, so the indexer can filter them out. */
const REHEARSAL_CAMPAIGN = "REAL-APEBOND-REHEARSAL";

/** The SoulZap seat's address, played by impersonation instead of by its key. 31337 only. */
const CALLER_IMPERSONATE_ENV = "LP_REHEARSAL_CALLER_IMPERSONATE";

/** Uniswap V3's fee -> tick spacing map, used only when the pool will not say. */
const TICK_SPACING_BY_FEE = { 100: 1, 500: 10, 3000: 60, 10000: 200 };

const Q96 = 1n << 96n;

const ADAPTER_ABI = [
  "function vault() view returns (address)",
  "function escrow() view returns (address)",
  "function positionManager() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function guardian() view returns (address)",
  "function purchaseSigner() view returns (address)",
  "function depositsPaused() view returns (bool)",
  "function soulZapCallers(address caller) view returns (bool)",
  "function consumedPurchaseIds(bytes32 purchaseId) view returns (bool)",
  "function consumedNonces(uint256 nonce) view returns (bool)",
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
  "function hashPurchaseAuthorization((bytes32 purchaseId,bytes32 campaignId,bytes32 soulZapRequestId,address beneficiary,address soulZapCaller,address inputToken,uint256 grossInputAmount,uint256 netInputAmount,uint256 guaranteedBonusAmount,uint64 bonusUnlockAt,uint128 minLiquidity,int24 expectedTickLower,int24 expectedTickUpper,uint256 nonce,uint256 deadline) authorization) view returns (bytes32)",
  "function depositFor(uint256 tokenId,(bytes32 purchaseId,bytes32 campaignId,bytes32 soulZapRequestId,address beneficiary,address soulZapCaller,address inputToken,uint256 grossInputAmount,uint256 netInputAmount,uint256 guaranteedBonusAmount,uint64 bonusUnlockAt,uint128 minLiquidity,int24 expectedTickLower,int24 expectedTickUpper,uint256 nonce,uint256 deadline) authorization,bytes realSignature)",
  "event ApeBondPositionDeposited(bytes32 indexed purchaseId,bytes32 indexed campaignId,address indexed beneficiary,bytes32 soulZapRequestId,uint256 tokenId,uint128 liquidity,int24 tickLower,int24 tickUpper,address inputToken,uint256 grossInputAmount,uint256 netInputAmount,uint256 guaranteedBonusAmount,uint64 bonusUnlockAt)",
];

const ESCROW_ABI = [
  "function bonusToken() view returns (address)",
  "function adapter() view returns (address)",
  "function totalReserved() view returns (uint256)",
  "function reservationOf(bytes32 purchaseId) view returns (address beneficiary,uint256 amount,uint64 unlockAt,bool claimed)",
  "function claimable(bytes32 purchaseId) view returns (uint256)",
  "function claim(bytes32 purchaseId) returns (uint256 amount)",
];

const VAULT_ABI = [
  "function pool() view returns (address)",
  "function stakerOf(uint256 tokenId) view returns (address)",
  "function isStakeOperator(address account) view returns (bool)",
  "function depositsPaused() view returns (bool)",
];

const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function tickSpacing() view returns (int24)",
];

const TOKEN_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 value) returns (bool)",
];

const NPM_ABI = [
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function positions(uint256 tokenId) view returns (uint96 nonce,address operator,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128,uint128 tokensOwed0,uint128 tokensOwed1)",
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
  "function approve(address to,uint256 tokenId) payable",
  "event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)",
];

// ──────────────────────── small helpers ────────────────────────

function sameValue(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function readPhase() {
  const raw = process.env.LP_REHEARSAL_PHASE;
  if (raw === undefined || raw.trim() === "") return DEFAULT_PHASE;
  if (!PHASES.includes(raw)) {
    throw new Error(`LP_REHEARSAL_PHASE must be one of ${PHASES.join(", ")} — got ${raw}`);
  }
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

/**
 * The wallet that plays the SoulZap seat: either its private key, or — on a Hardhat node
 * only — the account itself, impersonated.
 *
 * The two are mutually exclusive rather than ordered, because they are two different
 * statements about who the caller is and a run handed both would have to guess which one the
 * operator meant. Everything downstream uses `.address` and `connect()`, which both shapes
 * answer identically.
 */
async function resolveCaller() {
  const impersonated = await pools.impersonatedSignerFromEnv(CALLER_IMPERSONATE_ENV);
  if (impersonated === null) return readKeyEnv("LP_REHEARSAL_CALLER_KEY");

  if (process.env.LP_REHEARSAL_CALLER_KEY) {
    throw new Error(
      `${CALLER_IMPERSONATE_ENV} and LP_REHEARSAL_CALLER_KEY are both set. They name the ` +
        `SoulZap seat two different ways — one by address and one by key — so this run cannot ` +
        `tell which of them is meant. Set exactly one.`
    );
  }
  return impersonated;
}

/** A required private key, turned into a wallet on this network. The key is never printed. */
function readKeyEnv(name) {
  const raw = process.env[name];
  if (!raw) throw new Error(`Set ${name} to the private key it names`);
  try {
    return new hre.ethers.Wallet(raw, hre.ethers.provider);
  } catch {
    throw new Error(`${name} is not a valid private key`);
  }
}

function readIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^-?[0-9]+$/.test(raw.trim())) throw new Error(`${name} is not an integer: ${raw}`);
  return Number(raw.trim());
}

/** One registry kind, overridable by an env var, never invented. */
function resolveKind(chainId, kind, overrideName) {
  if (process.env[overrideName]) return readAddressEnv(overrideName);
  const address = pools.registryAddress(chainId, kind);
  if (!address) {
    throw new Error(
      `No ${kind} recorded for chain ${chainId} in the deployment registry. Activate the route ` +
        `with scripts/deploy-apebond.js first, point DEPLOYMENTS_FILE at the registry that ` +
        `records it, or name it with ${overrideName}=0x…`
    );
  }
  return hre.ethers.getAddress(address);
}

/** Where the record file lives: the override, else beside the registry this run reads. */
function resolveRecordFile(chainId) {
  if (process.env.LP_REHEARSAL_RECORD) return path.resolve(process.env.LP_REHEARSAL_RECORD);
  const registryPath = process.env.DEPLOYMENTS_FILE
    ? path.resolve(process.env.DEPLOYMENTS_FILE)
    : path.join(__dirname, "..", "deployments.json");
  return path.join(path.dirname(registryPath), `apebond-rehearsal-${chainId}.json`);
}

function readRecord(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeRecord(file, record) {
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
  console.log(`Record written: ${file}`);
}

/**
 * The sample campaign's figures, restated in the decimals of the token each one belongs to.
 *
 * The constants are 18-decimal bigints because the suite states the whole sample in tASSET; here
 * gross and net belong to whatever the authorization's `inputToken` is and the bonus belongs to
 * the escrow's `bonusToken`, and the two need not share a decimals count. So each constant is
 * converted back to its WHOLE-token figure — 10,000 / 9,900 / 495 — and re-parsed against the
 * token that will carry it. An operator who wants other numbers states them the same way, in
 * whole tokens.
 */
function sampleFigure(envName, constant, decimals) {
  const human = process.env[envName]
    ? process.env[envName].trim()
    : hre.ethers.formatUnits(constant, C.ASSET_DECIMALS);
  try {
    return hre.ethers.parseUnits(human, decimals);
  } catch {
    throw new Error(`${envName} is not a number in whole tokens: ${human}`);
  }
}

/** `Math.floor` division onto the tick grid, the way the suite's helper does it. */
function alignDown(tick, spacing) {
  return Math.floor(Number(tick) / spacing) * spacing;
}

/** Uniswap's sqrt(1.0001^tick) in Q64.96, good to a double's 16 significant digits. */
function sqrtRatioAtTick(tick) {
  const ratio = Math.sqrt(Math.pow(1.0001, Number(tick))) * 2 ** 96;
  if (!Number.isFinite(ratio) || ratio <= 0) {
    throw new Error(`tick ${tick} is outside the range this script can price`);
  }
  return BigInt(Math.floor(ratio));
}

/**
 * A value-balanced pair of mint amounts that fits both of the caller's balances.
 *
 * Uniswap V3 decides the ratio, not the operator: for a range [a, b] straddling the current price
 * P, a position of liquidity L needs `L * (sqrt(b) - sqrt(P)) / (sqrt(P) * sqrt(b))` of token0 and
 * `L * (sqrt(P) - sqrt(a))` of token1, and any excess on either side is simply not pulled. So the
 * question is not "how much of each" but "how much liquidity", and this picks the largest L whose
 * two legs both fit inside `budgetBps` of the caller's respective balance. The binding side is
 * spent down to that share exactly; the other side is spent proportionally less.
 *
 * Out-of-range cases are handled because a test pool can sit anywhere: below the range the
 * position is all token0, above it all token1, and the unused side's budget is then irrelevant.
 */
function defaultMintAmounts({ sqrtPriceX96, tickLower, tickUpper, balance0, balance1, budgetBps }) {
  const sqrtA = sqrtRatioAtTick(tickLower);
  const sqrtB = sqrtRatioAtTick(tickUpper);
  if (sqrtB <= sqrtA) throw new Error("the range is empty: tickUpper must be above tickLower");

  const budget0 = (balance0 * budgetBps) / 10_000n;
  const budget1 = (balance1 * budgetBps) / 10_000n;
  const sqrtP = sqrtPriceX96 < sqrtA ? sqrtA : sqrtPriceX96 > sqrtB ? sqrtB : sqrtPriceX96;

  // The liquidity each budget alone could support, on the leg it funds.
  const candidates = [];
  if (sqrtP < sqrtB) candidates.push((budget0 * sqrtP * sqrtB) / (Q96 * (sqrtB - sqrtP)));
  if (sqrtP > sqrtA) candidates.push((budget1 * Q96) / (sqrtP - sqrtA));
  if (candidates.length === 0) throw new Error("the pool price sits exactly on both range bounds");

  const liquidity = candidates.reduce((a, b) => (a < b ? a : b));
  const amount0 = sqrtP < sqrtB ? (liquidity * Q96 * (sqrtB - sqrtP)) / (sqrtP * sqrtB) : 0n;
  const amount1 = sqrtP > sqrtA ? (liquidity * (sqrtP - sqrtA)) / Q96 : 0n;
  return { amount0, amount1, liquidity };
}

/** The token id out of a mint receipt: the NFT `Transfer` from address(0). */
function mintedTokenId(receipt, npmAddress) {
  const topic = hre.ethers.id("Transfer(address,address,uint256)");
  for (const log of receipt.logs) {
    if (
      sameValue(log.address, npmAddress) &&
      log.topics.length === 4 &&
      log.topics[0] === topic &&
      BigInt(log.topics[1]) === 0n
    ) {
      return BigInt(log.topics[3]);
    }
  }
  throw new Error(`no NFT mint Transfer log in ${receipt.hash}`);
}

/** Approves `spender` for `amount` when the allowance is short. Returns the tx hash, or null. */
async function ensureTokenAllowance(token, owner, spender, amount, label) {
  const current = await token.allowance(owner.address, spender);
  if (current >= amount) {
    console.log(`  ${label} allowance already sufficient`);
    return null;
  }
  const receipt = await pools.send(`  Approving ${label}`, owner, (o) =>
    token.connect(owner).approve(spender, amount, o)
  );
  return receipt.hash;
}

/** Everything both phases resolve the same way. */
async function resolveStack(chainId) {
  const adapterAddress = resolveKind(chainId, ADAPTER_KIND, "LP_APEBOND_ADAPTER");
  if ((await hre.ethers.provider.getCode(adapterAddress)) === "0x") {
    throw new Error(`No contract code at ${ADAPTER_KIND} ${adapterAddress}`);
  }
  const adapter = new hre.ethers.Contract(adapterAddress, ADAPTER_ABI, hre.ethers.provider);

  // The escrow and the vault are read OFF THE ADAPTER, not out of the registry: those are the
  // addresses the purchase will actually touch, and a registry that disagrees with them is the
  // thing this rehearsal exists to catch.
  const escrowAddress = hre.ethers.getAddress(await adapter.escrow());
  const vaultAddress = hre.ethers.getAddress(await adapter.vault());
  const registryEscrow = process.env.LP_APEBOND_ESCROW
    ? readAddressEnv("LP_APEBOND_ESCROW")
    : pools.registryAddress(chainId, ESCROW_KIND);
  const registryVault = process.env.LP_APEBOND_VAULT
    ? readAddressEnv("LP_APEBOND_VAULT")
    : pools.registryAddress(chainId, VAULT_KIND);
  if (registryEscrow && !sameValue(registryEscrow, escrowAddress)) {
    throw new Error(
      `The adapter ${adapterAddress} points at escrow ${escrowAddress}, but ${ESCROW_KIND} for ` +
        `chain ${chainId} is recorded as ${registryEscrow}. One of the two is wrong; a purchase ` +
        `would reserve against the adapter's, not the registry's.`
    );
  }
  if (registryVault && !sameValue(registryVault, vaultAddress)) {
    throw new Error(
      `The adapter ${adapterAddress} points at vault ${vaultAddress}, but ${VAULT_KIND} for chain ` +
        `${chainId} is recorded as ${registryVault}.`
    );
  }

  const escrow = new hre.ethers.Contract(escrowAddress, ESCROW_ABI, hre.ethers.provider);
  const vault = new hre.ethers.Contract(vaultAddress, VAULT_ABI, hre.ethers.provider);
  const bonusTokenAddress = hre.ethers.getAddress(await escrow.bonusToken());
  const bonusToken = new hre.ethers.Contract(bonusTokenAddress, TOKEN_ABI, hre.ethers.provider);

  return {
    adapter,
    adapterAddress,
    escrow,
    escrowAddress,
    vault,
    vaultAddress,
    bonusToken,
    bonusTokenAddress,
  };
}

// ──────────────────────── phase: deposit ────────────────────────

async function runDeposit({ chainId, stack, recordFile }) {
  const { adapter, adapterAddress, escrow, escrowAddress, vault, vaultAddress, bonusToken, bonusTokenAddress } =
    stack;

  const caller = await resolveCaller();
  const beneficiary = readAddressEnv("LP_REHEARSAL_BENEFICIARY");
  const purchaseSignerWallet = readKeyEnv("LP_APEBOND_PURCHASE_SIGNER_KEY");

  const npmAddress = hre.ethers.getAddress(await adapter.positionManager());
  const token0Address = hre.ethers.getAddress(await adapter.token0());
  const token1Address = hre.ethers.getAddress(await adapter.token1());
  const fee = Number(await adapter.fee());
  const poolAddress = hre.ethers.getAddress(await vault.pool());

  const npm = new hre.ethers.Contract(npmAddress, NPM_ABI, hre.ethers.provider);
  const pool = new hre.ethers.Contract(poolAddress, POOL_ABI, hre.ethers.provider);
  const token0 = new hre.ethers.Contract(token0Address, TOKEN_ABI, hre.ethers.provider);
  const token1 = new hre.ethers.Contract(token1Address, TOKEN_ABI, hre.ethers.provider);

  const [symbol0, symbol1, decimals0, decimals1] = await Promise.all([
    token0.symbol(),
    token1.symbol(),
    token0.decimals().then(Number),
    token1.decimals().then(Number),
  ]);
  const bonusDecimals = Number(await bonusToken.decimals());
  const bonusSymbol = await bonusToken.symbol();

  const inputTokenAddress = readAddressEnv("LP_REHEARSAL_INPUT_TOKEN", token1Address);
  const inputDecimals = sameValue(inputTokenAddress, token0Address)
    ? decimals0
    : sameValue(inputTokenAddress, token1Address)
      ? decimals1
      : Number(await new hre.ethers.Contract(inputTokenAddress, TOKEN_ABI, hre.ethers.provider).decimals());

  // ──────── the checks that come before a single transaction ────────

  console.log(`\n──────── the live stack, read off the chain ────────`);
  console.log(`${ADAPTER_KIND}:  ${adapterAddress}`);
  console.log(`  ${pools.explorerAddress(chainId, adapterAddress)}`);
  console.log(`${ESCROW_KIND}:            ${escrowAddress}`);
  console.log(`${VAULT_KIND}:         ${vaultAddress}`);
  console.log(`positionManager:        ${npmAddress}`);
  console.log(`pool:                   ${poolAddress}`);
  console.log(`token0/token1:          ${symbol0} ${token0Address} / ${symbol1} ${token1Address}`);
  console.log(`fee:                    ${fee}`);
  console.log(`bonusToken:             ${bonusSymbol} ${bonusTokenAddress} (${bonusDecimals} decimals)`);
  console.log(`SoulZap seat (caller):  ${caller.address}`);
  console.log(`Beneficiary (buyer):    ${beneficiary}`);

  const failures = [];
  const gate = (ok, message) => {
    console.log(`${ok ? "OK  " : "FAIL"}  ${message}`);
    if (!ok) failures.push(message);
  };

  console.log(`\n──────── the four gates a purchase has to pass ────────`);
  gate(
    await adapter.soulZapCallers(caller.address),
    `adapter.soulZapCallers(${caller.address}) — the caller wallet is allowlisted`
  );
  const onChainSigner = hre.ethers.getAddress(await adapter.purchaseSigner());
  gate(
    sameValue(onChainSigner, purchaseSignerWallet.address),
    `adapter.purchaseSigner() is ${onChainSigner}, and LP_APEBOND_PURCHASE_SIGNER_KEY belongs to ` +
      `${purchaseSignerWallet.address}`
  );
  gate(!(await adapter.depositsPaused()), "adapter.depositsPaused() is false");
  gate(!(await vault.depositsPaused()), "vault.depositsPaused() is false");
  gate(
    await vault.isStakeOperator(adapterAddress),
    `vault.isStakeOperator(adapter) — the timelock has allowlisted the adapter`
  );
  gate(
    sameValue(await escrow.adapter(), adapterAddress),
    `escrow.adapter() points back at this adapter`
  );

  if (failures.length > 0) {
    throw new Error(
      `The route is not open: ${failures.length} of the gates above failed. Nothing was sent. ` +
        `Fix the wiring first — setPurchaseSigner is scripts/set-purchase-signer.js, the SoulZap ` +
        `allowlist and the vault's stake-operator entry are both owner-tier and go through the ` +
        `timelock.`
    );
  }

  // ──────── the figures ────────

  const grossInputAmount = sampleFigure("LP_REHEARSAL_GROSS", C.APEBOND_GROSS_INPUT, inputDecimals);
  const netInputAmount = sampleFigure("LP_REHEARSAL_NET", C.APEBOND_NET_INPUT, inputDecimals);
  const guaranteedBonusAmount = sampleFigure("LP_REHEARSAL_BONUS", C.APEBOND_BONUS, bonusDecimals);
  const cliffSeconds = readIntEnv("LP_REHEARSAL_CLIFF_SECONDS", DEFAULT_CLIFF_SECONDS);
  if (cliffSeconds < 0) throw new Error("LP_REHEARSAL_CLIFF_SECONDS cannot be negative");

  // The escrow must be able to back the bonus, or `depositFor` reverts at the reserve step with
  // every earlier transaction already mined — the mint and the two approvals included.
  const escrowBalance = await bonusToken.balanceOf(escrowAddress);
  const totalReserved = await escrow.totalReserved();
  const freeBalance = escrowBalance > totalReserved ? escrowBalance - totalReserved : 0n;
  console.log(`\n──────── the campaign's figures ────────`);
  console.log(`gross input:   ${hre.ethers.formatUnits(grossInputAmount, inputDecimals)} (inputToken ${inputTokenAddress})`);
  console.log(`net input:     ${hre.ethers.formatUnits(netInputAmount, inputDecimals)}`);
  console.log(`bonus:         ${hre.ethers.formatUnits(guaranteedBonusAmount, bonusDecimals)} ${bonusSymbol}`);
  console.log(`cliff:         ${cliffSeconds}s from the deposit`);
  console.log(`escrow free:   ${hre.ethers.formatUnits(freeBalance, bonusDecimals)} ${bonusSymbol} (balance - totalReserved)`);
  if (guaranteedBonusAmount > freeBalance) {
    throw new Error(
      `The escrow can back ${hre.ethers.formatUnits(freeBalance, bonusDecimals)} ${bonusSymbol} ` +
        `but this purchase reserves ${hre.ethers.formatUnits(guaranteedBonusAmount, bonusDecimals)}. ` +
        `depositFor would revert Underfunded with the mint already paid for. Fund it first: ` +
        `LP_APEBOND_FUND_TARGET=… npx hardhat run scripts/fund-escrow.js --network ${hre.network.name}`
    );
  }

  // ──────── the range and the mint amounts ────────

  let tickSpacing;
  try {
    tickSpacing = Number(await pool.tickSpacing());
  } catch {
    tickSpacing = TICK_SPACING_BY_FEE[fee];
    if (!tickSpacing) throw new Error(`The pool does not report tickSpacing and fee ${fee} is not a standard tier`);
  }

  const slot0 = await pool.slot0();
  const currentTick = Number(slot0.tick);
  const sqrtPriceX96 = BigInt(slot0.sqrtPriceX96);

  let tickLower;
  let tickUpper;
  if (process.env.LP_REHEARSAL_TICK_LOWER || process.env.LP_REHEARSAL_TICK_UPPER) {
    tickLower = readIntEnv("LP_REHEARSAL_TICK_LOWER");
    tickUpper = readIntEnv("LP_REHEARSAL_TICK_UPPER");
    if (tickLower === undefined || tickUpper === undefined) {
      throw new Error("LP_REHEARSAL_TICK_LOWER and LP_REHEARSAL_TICK_UPPER are set together");
    }
  } else {
    const halfWidth = readIntEnv("LP_REHEARSAL_HALF_WIDTH_TICKS", C.APEBOND_HALF_WIDTH_TICKS);
    const alignedHalfWidth = alignDown(halfWidth, tickSpacing);
    if (alignedHalfWidth <= 0) {
      throw new Error(
        `LP_REHEARSAL_HALF_WIDTH_TICKS=${halfWidth} rounds to zero on a ${tickSpacing}-tick grid`
      );
    }
    const centre = alignDown(currentTick, tickSpacing);
    tickLower = centre - alignedHalfWidth;
    tickUpper = centre + alignedHalfWidth;
  }
  if (tickLower % tickSpacing !== 0 || tickUpper % tickSpacing !== 0) {
    throw new Error(
      `[${tickLower}, ${tickUpper}] is not on the ${tickSpacing}-tick grid; NPM.mint would revert`
    );
  }

  const balance0 = await token0.balanceOf(caller.address);
  const balance1 = await token1.balanceOf(caller.address);
  const budgetBps = BigInt(readIntEnv("LP_REHEARSAL_BUDGET_BPS", Number(DEFAULT_BUDGET_BPS)));

  let amount0Desired;
  let amount1Desired;
  if (process.env.LP_REHEARSAL_AMOUNT0 || process.env.LP_REHEARSAL_AMOUNT1) {
    amount0Desired = hre.ethers.parseUnits((process.env.LP_REHEARSAL_AMOUNT0 || "0").trim(), decimals0);
    amount1Desired = hre.ethers.parseUnits((process.env.LP_REHEARSAL_AMOUNT1 || "0").trim(), decimals1);
  } else {
    const computed = defaultMintAmounts({
      sqrtPriceX96,
      tickLower,
      tickUpper,
      balance0,
      balance1,
      budgetBps,
    });
    amount0Desired = computed.amount0;
    amount1Desired = computed.amount1;
  }

  console.log(`\n──────── the position the caller mints ────────`);
  console.log(`pool tick now:   ${currentTick} (spacing ${tickSpacing}, sqrtPriceX96 ${sqrtPriceX96})`);
  console.log(`campaign range:  [${tickLower}, ${tickUpper}]`);
  console.log(`amount0:         ${hre.ethers.formatUnits(amount0Desired, decimals0)} ${symbol0}`);
  console.log(`  caller holds:  ${hre.ethers.formatUnits(balance0, decimals0)} ${symbol0}`);
  console.log(`amount1:         ${hre.ethers.formatUnits(amount1Desired, decimals1)} ${symbol1}`);
  console.log(`  caller holds:  ${hre.ethers.formatUnits(balance1, decimals1)} ${symbol1}`);
  console.log(
    process.env.LP_REHEARSAL_AMOUNT0 || process.env.LP_REHEARSAL_AMOUNT1
      ? `amounts stated by LP_REHEARSAL_AMOUNT0 / LP_REHEARSAL_AMOUNT1`
      : `amounts computed value-balanced at the pool's own price, within ${budgetBps} bps of each balance`
  );

  if (amount0Desired === 0n && amount1Desired === 0n) {
    throw new Error("Both mint amounts are zero — the caller wallet holds neither pool token");
  }
  if (balance0 < amount0Desired) {
    throw new Error(
      `The caller needs ${hre.ethers.formatUnits(amount0Desired, decimals0)} ${symbol0} and holds ` +
        `${hre.ethers.formatUnits(balance0, decimals0)}. Fund ${caller.address} and re-run; nothing was sent.`
    );
  }
  if (balance1 < amount1Desired) {
    throw new Error(
      `The caller needs ${hre.ethers.formatUnits(amount1Desired, decimals1)} ${symbol1} and holds ` +
        `${hre.ethers.formatUnits(balance1, decimals1)}. Fund ${caller.address} and re-run; nothing was sent.`
    );
  }

  pools.requireConfirmation(chainId, `mint a position and run an ApeBond purchase on chain ${chainId}`);

  // ──────── the transactions ────────

  console.log(`\n──────── 1/4: the caller approves the position manager ────────`);
  const approve0Tx = amount0Desired > 0n
    ? await ensureTokenAllowance(token0, caller, npmAddress, amount0Desired, symbol0)
    : null;
  const approve1Tx = amount1Desired > 0n
    ? await ensureTokenAllowance(token1, caller, npmAddress, amount1Desired, symbol1)
    : null;

  console.log(`\n──────── 2/4: the caller mints the campaign position ────────`);
  const npmAsCaller = new hre.ethers.Contract(npmAddress, NPM_ABI, caller);
  const mintDeadline = BigInt((await hre.ethers.provider.getBlock("latest")).timestamp + AUTHORIZATION_TTL_SECONDS);
  const mintReceipt = await pools.send("Minting the position", caller, (o) =>
    npmAsCaller.mint(
      {
        token0: token0Address,
        token1: token1Address,
        fee,
        tickLower,
        tickUpper,
        amount0Desired,
        amount1Desired,
        // A rehearsal on a test stack: the position is checked against the authorization after
        // the fact (exact ticks, a liquidity floor), which is a stronger gate than a mint-time
        // slippage bound and does not make the run fail on a quiet pool's one-tick drift.
        amount0Min: 0n,
        amount1Min: 0n,
        recipient: caller.address,
        deadline: mintDeadline,
      },
      o
    )
  );
  const tokenId = mintedTokenId(mintReceipt, npmAddress);
  const position = await npm.positions(tokenId);
  const liquidity = BigInt(position.liquidity);
  console.log(`  tokenId:    ${tokenId}`);
  console.log(`  liquidity:  ${liquidity}`);
  console.log(`  range:      [${position.tickLower}, ${position.tickUpper}]`);
  if (Number(position.tickLower) !== tickLower || Number(position.tickUpper) !== tickUpper) {
    throw new Error(
      `The minted position sits at [${position.tickLower}, ${position.tickUpper}], not the ` +
        `[${tickLower}, ${tickUpper}] the authorization will name. depositFor would revert ` +
        `TickRangeMismatch.`
    );
  }
  if (liquidity === 0n) throw new Error(`Position ${tokenId} minted with zero liquidity`);

  // ──────── the authorization ────────

  const block = await hre.ethers.provider.getBlock("latest");
  const nowSeconds = block.timestamp;
  const nonce = BigInt(nowSeconds);
  const purchaseId = hre.ethers.keccak256(
    hre.ethers.solidityPacked(
      ["string", "uint256", "uint256", "address"],
      [REHEARSAL_CAMPAIGN, nonce, tokenId, caller.address]
    )
  );
  const campaignId = hre.ethers.id(REHEARSAL_CAMPAIGN);
  const soulZapRequestId = hre.ethers.id(`${REHEARSAL_CAMPAIGN}:${nonce}`);
  const bonusUnlockAt = BigInt(nowSeconds + cliffSeconds);

  const authorization = {
    purchaseId,
    campaignId,
    soulZapRequestId,
    beneficiary,
    soulZapCaller: caller.address,
    inputToken: inputTokenAddress,
    grossInputAmount,
    netInputAmount,
    guaranteedBonusAmount,
    bonusUnlockAt,
    minLiquidity: liquidity,
    expectedTickLower: tickLower,
    expectedTickUpper: tickUpper,
    nonce,
    deadline: BigInt(nowSeconds + AUTHORIZATION_TTL_SECONDS),
  };

  if (await adapter.consumedPurchaseIds(purchaseId)) {
    throw new Error(`purchaseId ${purchaseId} has already been spent on this adapter`);
  }
  if (await adapter.consumedNonces(nonce)) {
    throw new Error(`nonce ${nonce} has already been used on this adapter — re-run in a second`);
  }

  console.log(`\n──────── 3/4: REAL signs the purchase authorization ────────`);
  const domain = await signing.readEip712Domain(adapter);
  console.log(`  domain:     ${domain.name} / ${domain.version} / chain ${domain.chainId} / ${domain.verifyingContract}`);
  const realSignature = await signing.signPurchaseAuthorization({
    signer: purchaseSignerWallet,
    domain,
    authorization,
  });
  // The one check that proves the signing pipeline and the contract agree: the adapter's own
  // digest against the one ethers just signed. A mismatch here is a field order or a type
  // mismatch, and it is far cheaper to find now than as an InvalidSignature revert.
  const contractDigest = await adapter.hashPurchaseAuthorization(authorization);
  const localDigest = hre.ethers.TypedDataEncoder.hash(
    domain,
    { PurchaseAuthorization: signing.PURCHASE_AUTHORIZATION_FIELDS },
    authorization
  );
  if (contractDigest !== localDigest) {
    throw new Error(
      `The adapter hashes this authorization to ${contractDigest}, ethers to ${localDigest}. ` +
        `The two encodings disagree; nothing more was sent.`
    );
  }
  const recovered = hre.ethers.verifyTypedData(
    domain,
    { PurchaseAuthorization: signing.PURCHASE_AUTHORIZATION_FIELDS },
    authorization,
    realSignature
  );
  if (!sameValue(recovered, onChainSigner)) {
    throw new Error(`The signature recovers to ${recovered}, but the adapter expects ${onChainSigner}`);
  }
  console.log(`  purchaseId: ${purchaseId}`);
  console.log(`  digest:     ${contractDigest} (adapter and ethers agree)`);
  console.log(`  unlockAt:   ${bonusUnlockAt} (${pools.epochToIso(bonusUnlockAt)})`);

  console.log(`\n──────── 4/4: the caller approves the adapter and calls depositFor ────────`);
  const approveNftReceipt = await pools.send("  Approving the adapter for the NFT", caller, (o) =>
    npmAsCaller.approve(adapterAddress, tokenId, o)
  );
  const adapterAsCaller = new hre.ethers.Contract(adapterAddress, ADAPTER_ABI, caller);
  const depositReceipt = await pools.send("  depositFor", caller, (o) =>
    adapterAsCaller.depositFor(tokenId, authorization, realSignature, o)
  );

  // ──────── the assertions ────────

  console.log(`\n──────── what the purchase produced ────────`);
  const checks = [];
  const check = (label, actual, expected) => {
    const ok = sameValue(actual, expected);
    console.log(`${ok ? "OK  " : "FAIL"}  ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
    if (!ok) checks.push(label);
  };

  check("positionManager.ownerOf(tokenId) — the vault has custody", await npm.ownerOf(tokenId), vaultAddress);
  check(`${VAULT_KIND}.stakerOf(tokenId) — the BUYER is credited`, await vault.stakerOf(tokenId), beneficiary);

  const reservation = await escrow.reservationOf(purchaseId);
  check(`${ESCROW_KIND}.reservationOf(purchaseId).beneficiary`, reservation.beneficiary, beneficiary);
  check(`${ESCROW_KIND}.reservationOf(purchaseId).amount`, reservation.amount, guaranteedBonusAmount);
  check(`${ESCROW_KIND}.reservationOf(purchaseId).unlockAt`, reservation.unlockAt, bonusUnlockAt);
  check(`${ESCROW_KIND}.reservationOf(purchaseId).claimed`, reservation.claimed, false);
  check(
    `${ESCROW_KIND}.totalReserved rose by the bonus`,
    await escrow.totalReserved(),
    totalReserved + guaranteedBonusAmount
  );
  // Before the cliff the bonus is recorded and unclaimable, which is the whole point of a cliff.
  check(`${ESCROW_KIND}.claimable(purchaseId) before the cliff`, await escrow.claimable(purchaseId), 0n);

  const deposited = depositReceipt.logs
    .filter((log) => sameValue(log.address, adapterAddress))
    .map((log) => {
      try {
        return adapter.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed && parsed.name === "ApeBondPositionDeposited");
  check("ApeBondPositionDeposited is in the receipt", Boolean(deposited), true);
  if (deposited) {
    check("  event.purchaseId", deposited.args.purchaseId, purchaseId);
    check("  event.beneficiary", deposited.args.beneficiary, beneficiary);
    check("  event.tokenId", deposited.args.tokenId, tokenId);
    check("  event.liquidity", deposited.args.liquidity, liquidity);
  }

  const record = {
    chainId,
    network: hre.network.name,
    adapter: adapterAddress,
    escrow: escrowAddress,
    vault: vaultAddress,
    positionManager: npmAddress,
    pool: poolAddress,
    bonusToken: bonusTokenAddress,
    bonusDecimals,
    bonusSymbol,
    purchaseId,
    campaignId,
    soulZapRequestId,
    tokenId: tokenId.toString(),
    liquidity: liquidity.toString(),
    beneficiary,
    soulZapCaller: caller.address,
    inputToken: inputTokenAddress,
    grossInputAmount: grossInputAmount.toString(),
    netInputAmount: netInputAmount.toString(),
    guaranteedBonusAmount: guaranteedBonusAmount.toString(),
    bonusUnlockAt: bonusUnlockAt.toString(),
    bonusUnlockAtIso: pools.epochToIso(bonusUnlockAt),
    cliffSeconds,
    tickLower,
    tickUpper,
    nonce: nonce.toString(),
    deadline: authorization.deadline.toString(),
    deposit: {
      at: new Date().toISOString(),
      approveToken0Tx: approve0Tx,
      approveToken1Tx: approve1Tx,
      mintTx: mintReceipt.hash,
      approveNftTx: approveNftReceipt.hash,
      depositTx: depositReceipt.hash,
    },
    claim: null,
  };
  writeRecord(recordFile, record);

  console.log(`\n──────── transactions ────────`);
  console.log(`mint:        ${pools.explorerTx(chainId, mintReceipt.hash)}`);
  console.log(`approve NFT: ${pools.explorerTx(chainId, approveNftReceipt.hash)}`);
  console.log(`depositFor:  ${pools.explorerTx(chainId, depositReceipt.hash)}`);

  if (checks.length > 0) {
    throw new Error(`The purchase landed but ${checks.length} assertion(s) failed: ${checks.join(", ")}`);
  }

  const remaining = Number(bonusUnlockAt) - nowSeconds;
  console.log(
    `\nThe deposit phase passed. The bonus of ` +
      `${hre.ethers.formatUnits(guaranteedBonusAmount, bonusDecimals)} ${bonusSymbol} unlocks in ` +
      `${remaining}s, at ${pools.epochToIso(bonusUnlockAt)}. Then:\n\n` +
      `  LP_REHEARSAL_PHASE=claim npx hardhat run scripts/apebond-rehearsal.js --network ${hre.network.name}`
  );
}

// ──────────────────────── phase: claim ────────────────────────

async function runClaim({ chainId, stack, recordFile }) {
  const { escrow, escrowAddress, bonusToken } = stack;
  const sender = await pools.getSigner();

  const record = readRecord(recordFile);
  const purchaseId = process.env.LP_REHEARSAL_PURCHASE_ID
    ? process.env.LP_REHEARSAL_PURCHASE_ID.trim()
    : record && record.purchaseId;
  if (!purchaseId) {
    throw new Error(
      `No purchase to claim: ${recordFile} does not exist and LP_REHEARSAL_PURCHASE_ID is unset. ` +
        `Run the deposit phase first, or name the purchase id.`
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(purchaseId)) {
    throw new Error(`LP_REHEARSAL_PURCHASE_ID is not a bytes32: ${purchaseId}`);
  }

  // The reservation is read off the CHAIN, not out of the record: the record says what the
  // deposit phase believed, the escrow says what is actually owed, and the claim is about the
  // second one.
  const reservation = await escrow.reservationOf(purchaseId);
  if (reservation.beneficiary === hre.ethers.ZeroAddress) {
    throw new Error(
      `${ESCROW_KIND} ${escrowAddress} holds no reservation for ${purchaseId}. Either the deposit ` +
        `phase never landed, or this id belongs to another stack.`
    );
  }

  const decimals = Number(await bonusToken.decimals());
  const symbol = await bonusToken.symbol();
  const units = (value) => `${hre.ethers.formatUnits(value, decimals)} ${symbol}`;
  const beneficiary = hre.ethers.getAddress(reservation.beneficiary);
  const bonus = BigInt(reservation.amount);
  const unlockAt = BigInt(reservation.unlockAt);

  console.log(`${ESCROW_KIND}:   ${escrowAddress}`);
  console.log(`  ${pools.explorerAddress(chainId, escrowAddress)}`);
  console.log(`Network:       chain ${chainId} (${hre.network.name})`);
  console.log(`purchaseId:    ${purchaseId}`);
  console.log(`  beneficiary: ${beneficiary}`);
  console.log(`  bonus:       ${units(bonus)}`);
  console.log(`  unlockAt:    ${unlockAt} (${pools.epochToIso(unlockAt)})`);
  console.log(`  claimed:     ${reservation.claimed}`);
  console.log(`Trigger:       ${sender.address}${sameValue(sender.address, beneficiary) ? "" : " (NOT the beneficiary — the money still goes to the beneficiary)"}`);

  if (reservation.claimed) {
    throw new Error(`The bonus for ${purchaseId} has already been claimed. Nothing was sent.`);
  }

  const block = await hre.ethers.provider.getBlock("latest");
  const claimable = await escrow.claimable(purchaseId);
  if (claimable === 0n) {
    const remaining = Number(unlockAt) - block.timestamp;
    console.log(
      `\nThe cliff has NOT passed. Chain time is ${block.timestamp} ` +
        `(${pools.epochToIso(block.timestamp)}), the bonus unlocks at ${unlockAt}.`
    );
    console.log(`Seconds remaining: ${remaining > 0 ? remaining : 0}`);
    throw new Error(
      `claimable(${purchaseId}) is 0 with ${remaining > 0 ? remaining : 0}s of the cliff left. ` +
        `Nothing was sent; re-run this phase after that.`
    );
  }
  if (claimable !== bonus) {
    throw new Error(
      `claimable(${purchaseId}) is ${units(claimable)} but the reservation records ${units(bonus)}`
    );
  }
  console.log(`\nOK    claimable(purchaseId) = ${units(claimable)}, the full reserved bonus`);

  const beforeBeneficiary = await bonusToken.balanceOf(beneficiary);
  const beforeEscrow = await bonusToken.balanceOf(escrowAddress);
  const beforeReserved = await escrow.totalReserved();
  console.log(`  beneficiary balance before: ${units(beforeBeneficiary)}`);
  console.log(`  escrow balance before:      ${units(beforeEscrow)}`);
  console.log(`  totalReserved before:       ${units(beforeReserved)}`);

  pools.requireConfirmation(chainId, `claim ${units(bonus)} for ${beneficiary}`);

  const escrowAsSender = new hre.ethers.Contract(escrowAddress, ESCROW_ABI, sender);
  const claimReceipt = await pools.send(`Claiming ${units(bonus)}`, sender, (o) =>
    escrowAsSender.claim(purchaseId, o)
  );

  const afterBeneficiary = await bonusToken.balanceOf(beneficiary);
  const afterEscrow = await bonusToken.balanceOf(escrowAddress);
  const afterReserved = await escrow.totalReserved();

  const failures = [];
  const check = (label, actual, expected) => {
    const ok = sameValue(actual, expected);
    console.log(`${ok ? "OK  " : "FAIL"}  ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
    if (!ok) failures.push(label);
  };

  console.log(`\n──────── what the claim produced ────────`);
  check("the beneficiary's balance grew by exactly the bonus", afterBeneficiary - beforeBeneficiary, bonus);
  check("the escrow's balance fell by exactly the bonus", beforeEscrow - afterEscrow, bonus);
  check("totalReserved fell by exactly the bonus", beforeReserved - afterReserved, bonus);
  check("the reservation is marked claimed", (await escrow.reservationOf(purchaseId)).claimed, true);
  check("claimable(purchaseId) is now 0", await escrow.claimable(purchaseId), 0n);

  // A spent reservation must stay spent. Asked as a static call so the assertion costs no gas
  // and cannot itself move anything.
  let secondClaimReverted = false;
  try {
    await escrowAsSender.claim.staticCall(purchaseId);
  } catch {
    secondClaimReverted = true;
  }
  check("a second claim reverts", secondClaimReverted, true);

  console.log(`\n  beneficiary balance after: ${units(afterBeneficiary)}`);
  console.log(`  escrow balance after:      ${units(afterEscrow)}`);
  console.log(`  totalReserved after:       ${units(afterReserved)}`);
  console.log(`claim: ${pools.explorerTx(chainId, claimReceipt.hash)}`);

  if (record && record.purchaseId === purchaseId) {
    record.claim = {
      at: new Date().toISOString(),
      tx: claimReceipt.hash,
      trigger: sender.address,
      amount: bonus.toString(),
    };
    writeRecord(recordFile, record);
  } else {
    console.log(
      `The record file does not describe this purchase, so it was left alone: ${recordFile}`
    );
  }

  if (failures.length > 0) {
    throw new Error(`The claim landed but ${failures.length} assertion(s) failed: ${failures.join(", ")}`);
  }
  console.log(
    `\nThe claim phase passed. ${units(bonus)} reached ${beneficiary}, triggered by ` +
      `${sender.address}. The ApeBond route is proven end to end on chain ${chainId}.`
  );
}

// ──────────────────────── the run ────────────────────────

async function main() {
  const chainId = await pools.chainId();

  // No CONFIRM escape. A rehearsal mints liquidity, signs with a key out of the environment and
  // burns a purchase id; none of that is a mainnet operator action, and SoulZap drives the real
  // campaign anyway.
  if (pools.isMainnet(chainId)) {
    throw new Error(
      "apebond-rehearsal.js refuses to run on mainnet. It is a TEST-STACK script: it mints a " +
        "position, signs an authorization with a key read from the environment and spends a " +
        "purchase id. On mainnet the purchase comes from SoulZap and the signature from the " +
        "backend, and neither is driven from here."
    );
  }

  const phase = readPhase();
  const recordFile = resolveRecordFile(chainId);
  console.log(`ApeBond rehearsal — phase ${phase}, chain ${chainId} (${hre.network.name})`);
  console.log(`Record file: ${recordFile}`);

  const stack = await resolveStack(chainId);
  if (phase === "deposit") {
    await runDeposit({ chainId, stack, recordFile });
  } else {
    await runClaim({ chainId, stack, recordFile });
  }
}

module.exports = {
  PHASES,
  DEFAULT_PHASE,
  DEFAULT_CLIFF_SECONDS,
  REHEARSAL_CAMPAIGN,
  CALLER_IMPERSONATE_ENV,
  readPhase,
  resolveCaller,
  resolveRecordFile,
  defaultMintAmounts,
  sqrtRatioAtTick,
  alignDown,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
