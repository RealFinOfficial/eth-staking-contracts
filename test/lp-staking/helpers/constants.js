/**
 * Shared constants for the local-fork integration suite.
 *
 * Everything here is a fact about the environment the suite builds: the mainnet
 * addresses the fork inherits, the pinned block, the Hardhat test mnemonic the spawned
 * node hands out, and the scenario's own parameters.
 *
 * The minimal ABI fragments below are the same ones test/lp-staking/fork/LPStakingFork.test.js
 * declares (L159–197). Keep the two in sync — they describe the same real contracts.
 * The four LP-staking contracts are NOT listed here: their ABIs are read from the
 * compiled artifacts at runtime, so a Solidity change can never drift past this file.
 */

// ─────────────────────────── Mainnet addresses (inherited by the fork) ───────────────────────────

/** Uniswap V3 core and periphery, in canonical EIP-55 checksummed form. */
const FACTORY_ADDR = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const NPM_ADDR = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const ROUTER_ADDR = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";

/** Deployed at the same address on every chain; the indexer's RPC client relies on it. */
const MULTICALL3_ADDR = "0xcA11bde05977b3631167028862bE2a173976CA11";

/**
 * The real REAL/USDC 0.30% pool and its two tokens. This suite never trades on it — it
 * reads the pool's immutables as proof that the fork really serves archive state at
 * {@link PINNED_BLOCK}, which a fresh mock pool cannot demonstrate.
 */
const REAL_POOL_ADDR = "0xe76532bae172876B6c7170Ce02309715502c360B";
const REAL_ASSET_ADDR = "0x99E980265Bf36516C442be982df1772a6cCb3233";
const REAL_USDC_ADDR = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

/** Pinned so every run sees the same Uniswap deployment and the same base fee. */
const PINNED_BLOCK = 25750000;

/** What `hardhat node` reports for itself, regardless of the chain it forks. */
const LOCAL_CHAIN_ID = 31337n;

// ─────────────────────────── Accounts ───────────────────────────

/** Hardhat's built-in development mnemonic; the spawned node unlocks these accounts. */
const MNEMONIC = "test test test test test test test test test test test junk";
const DERIVATION_PREFIX = "m/44'/60'/0'/0";

/**
 * Role -> account index. The deploy scripts run as child processes and take account 0 as
 * their signer (`pools.getSigner()` returns `getSigners()[0]`), so `deployer` must be 0.
 */
const ROLES = {
  deployer: 0,
  alice: 1,
  bob: 2,
  carol: 3,
  dave: 4,
  backOffice: 5, // LP_SIGNER — the voucher signer, a hot backend key
  multisig: 6, // LP_MULTISIG — final owner of all four contracts
  signer2: 7, // rotation target for setSigner / setMinter
};

// ─────────────────────────── Pool and stack parameters ───────────────────────────

const FEE = 3000;
const TICK_SPACING = 60;

/** Starting price of the fresh pool, in tUSDC per tASSET. */
const PRICE_USDC_PER_ASSET_NUM = 1n;
const PRICE_USDC_PER_ASSET_DEN = 2n;

const ASSET_DECIMALS = 18n;
const USDC_DECIMALS = 6n;

const TOKENX_NAME = "Real LP Rewards";
const TOKENX_SYMBOL = "RLP";

const ASSET_NAME = "Test ASSET";
const ASSET_SYMBOL = "tASSET";
const USDC_NAME = "Test USDC";
const USDC_SYMBOL = "tUSDC";
/** OpenZeppelin 5.x ERC20Permit always uses domain version "1". */
const ERC2612_VERSION = "1";

/** EIP-712 domain of the real Uniswap V3 position manager's ERC-721 permit. */
const NFT_PERMIT_NAME = "Uniswap V3 Positions NFT-V1";
const NFT_PERMIT_VERSION = "1";

const TWAP_WINDOW = 300; // TwapGuard.MIN_TWAP_WINDOW — shortest legal window
/** What the scenario hands the deploy script, in bps — the script's human-facing knob. */
const MAX_DEVIATION_BPS = 1000;
/** What the script converts that into and the contract stores: floor(ln 1.10 / ln 1.0001). */
const MAX_DEVIATION_TICKS = 953;
/** Retuned by A19/A20 from the multisig. */
const RETUNED_TWAP_WINDOW = 600;
/** `setTwapParams` takes ticks directly — no conversion on this path. */
const RETUNED_MAX_DEVIATION_TICKS = 400;

// Deploy default since 2026-08-26: 2 * ceil(window / 12) slots, so a 300 s window needs 50
// and 150 leaves margin for the burst of trading a crash produces.
const OBSERVATION_CARDINALITY = 150;

/**
 * The timelock's `minDelay` for the fork suites, in seconds.
 *
 * Mainnet runs 48 h and Sepolia staging 300 s; a fork run wants the flow, not the wait. 60 s
 * is short enough that `evm_increaseTime(61)` between schedule and execute costs nothing, and
 * long enough that the two are genuinely different blocks with a real ready-at between them.
 * It must stay well below the TWAP window's warm-up history, which the same clock consumes.
 */
const TIMELOCK_MIN_DELAY = 60;

const ASSET = (n) => BigInt(n) * 10n ** ASSET_DECIMALS;
const USDC = (n) => BigInt(n) * 10n ** USDC_DECIMALS;
const TOKENS = (n) => BigInt(n) * 10n ** 18n; // TokenX, 18 decimals like ASSET

/** Mock supplies. Everything the scenario spends comes out of the deployer's balance. */
const ASSET_SUPPLY = 10n ** 25n; // 10,000,000 tASSET
const USDC_SUPPLY = 10n ** 13n; // 10,000,000 tUSDC

/** Handed to alice/bob/carol/dave before the scenario starts. */
const USER_ASSET = ASSET(100_000);
const USER_USDC = USDC(50_000);

/** Deployer's seed position: wide enough that every scenario swap stays in range. */
const SEED_HALF_WIDTH_TICKS = 6000;
const SEED_ASSET = 10n ** 24n; // 1,000,000 tASSET
const SEED_USDC = 5n * 10n ** 11n; // 500,000 tUSDC — the same value at 0.50

/** Oracle warm-up: 8 round trips, 60 s apart, is 960 s of history for a 300 s window. */
const WARMUP_ROUNDS = 8;
const WARMUP_STEP_SECONDS = 60;
const WARMUP_SWAP_USDC = USDC(1_000);

/** A9's fee generator. Bigger than the warm-up so the fees are visible, still in range. */
const FEE_ROUNDS = 3;
const FEE_SWAP_USDC = USDC(2_000);
const FEE_STEP_SECONDS = 30;

const EPOCH_ONE = 1n;
const EPOCH_TWO = 2n;
const EPOCH_ONE_CAP = 10n ** 24n; // 1,000,000 TokenX — armed by the deploy script
const EPOCH_TWO_CAP = 5n * 10n ** 23n; // 500,000 TokenX
const EPOCH_ROLLOVER_DELAY = 3600;
const EPOCH_ROLLOVER_OVERSHOOT = 3660;

const FAR_DEADLINE = 10n ** 12n;
const MAX_UINT128 = (1n << 128n) - 1n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// ─────────────────────────── Minimal ABIs ───────────────────────────
// Keep in sync with test/lp-staking/fork/LPStakingFork.test.js L159–197 — same contracts.

const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function nonces(address) view returns (uint256)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function permit(address owner,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "event Approval(address indexed owner,address indexed spender,uint256 value)",
];

const POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives,uint160[] secondsPerLiquidityCumulativeX128s)",
  "function increaseObservationCardinalityNext(uint16)",
  "event Initialize(uint160 sqrtPriceX96,int24 tick)",
  "event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)",
  "event Mint(address sender,address indexed owner,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount,uint256 amount0,uint256 amount1)",
  "event Burn(address indexed owner,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount,uint256 amount0,uint256 amount1)",
  "event Collect(address indexed owner,address recipient,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount0,uint128 amount1)",
  "event IncreaseObservationCardinalityNext(uint16 observationCardinalityNextOld,uint16 observationCardinalityNextNew)",
];

const FACTORY_ABI = [
  "function getPool(address,address,uint24) view returns (address)",
  "function owner() view returns (address)",
  "event PoolCreated(address indexed token0,address indexed token1,uint24 indexed fee,int24 tickSpacing,address pool)",
];

const NPM_ABI = [
  "function positions(uint256) view returns (uint96 nonce,address operator,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128,uint128 tokensOwed0,uint128 tokensOwed1)",
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
  "function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline)) payable returns (uint256 amount0,uint256 amount1)",
  "function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) payable returns (uint256 amount0,uint256 amount1)",
  "function ownerOf(uint256) view returns (address)",
  "function getApproved(uint256) view returns (address)",
  "function approve(address,uint256)",
  "function transferFrom(address,address,uint256)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function createAndInitializePoolIfNecessary(address,address,uint24,uint160) payable returns (address)",
  "event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)",
];

const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
];

module.exports = {
  FACTORY_ADDR,
  NPM_ADDR,
  ROUTER_ADDR,
  MULTICALL3_ADDR,
  REAL_POOL_ADDR,
  REAL_ASSET_ADDR,
  REAL_USDC_ADDR,
  PINNED_BLOCK,
  LOCAL_CHAIN_ID,
  MNEMONIC,
  DERIVATION_PREFIX,
  ROLES,
  FEE,
  TICK_SPACING,
  PRICE_USDC_PER_ASSET_NUM,
  PRICE_USDC_PER_ASSET_DEN,
  ASSET_DECIMALS,
  USDC_DECIMALS,
  TOKENX_NAME,
  TOKENX_SYMBOL,
  ASSET_NAME,
  ASSET_SYMBOL,
  USDC_NAME,
  USDC_SYMBOL,
  ERC2612_VERSION,
  NFT_PERMIT_NAME,
  NFT_PERMIT_VERSION,
  TWAP_WINDOW,
  MAX_DEVIATION_BPS,
  MAX_DEVIATION_TICKS,
  RETUNED_TWAP_WINDOW,
  RETUNED_MAX_DEVIATION_TICKS,
  OBSERVATION_CARDINALITY,
  TIMELOCK_MIN_DELAY,
  ASSET,
  USDC,
  TOKENS,
  ASSET_SUPPLY,
  USDC_SUPPLY,
  USER_ASSET,
  USER_USDC,
  SEED_HALF_WIDTH_TICKS,
  SEED_ASSET,
  SEED_USDC,
  WARMUP_ROUNDS,
  WARMUP_STEP_SECONDS,
  WARMUP_SWAP_USDC,
  FEE_ROUNDS,
  FEE_SWAP_USDC,
  FEE_STEP_SECONDS,
  EPOCH_ONE,
  EPOCH_TWO,
  EPOCH_ONE_CAP,
  EPOCH_TWO_CAP,
  EPOCH_ROLLOVER_DELAY,
  EPOCH_ROLLOVER_OVERSHOOT,
  FAR_DEADLINE,
  MAX_UINT128,
  ZERO_ADDRESS,
  ERC20_ABI,
  POOL_ABI,
  FACTORY_ABI,
  NPM_ABI,
  ROUTER_ABI,
};
