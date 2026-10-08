const hre = require("hardhat");

const pools = require("./lib/pools");

// The ordinary USER side of LP staking on a TEST STACK (Sepolia test stack #6), from the configured
// signer: the wallet gets DIRECT positions (not ApeBond purchases) and claims a reward, exactly
// the calls the website makes for a connected wallet. Nothing here needs an operator role.
//
// ──────────────────────── what each phase does ────────────────────────
//
//   LP_USER_PHASE=zap        USDC in, staked position out, in ONE zapper call. The script
//                            approves LP_USER_USDC tUSDC to the `LPZapper` proxy (only when the
//                            allowance is short) and calls `zapIn(usdcAmount, tickLower,
//                            tickUpper, swap, deadline)`. The zapper pulls the tUSDC, swaps
//                            `swap.amountIn` of it to $ASSET (TWAP-guarded), mints a position on
//                            the range with its WHOLE post-swap balance, stakes it in the vault for
//                            `msg.sender` (= the signer) and refunds what the mint did not take.
//                            The split is computed here the way the frontend computes it (a
//                            single-range model of the swap, solved by bisection); the eth_call
//                            preflight of `zapIn` is the authority on whether it goes through.
//   LP_USER_PHASE=stake-nft  The two-step route: mint a Uniswap V3 position on the stack's pool
//                            through the NonfungiblePositionManager (recipient = the signer),
//                            approve it to the vault, `vault.stake(tokenId)`. With
//                            LP_USER_TOKEN_ID set it skips the mint and stakes that NFT, which
//                            the signer must own — the recovery path when a mint landed and the
//                            stake did not.
//   LP_USER_PHASE=claim      One reward token for one position, through the backend's voucher:
//                            GET <api>/api/lp/positions/<wallet> for the position's `lineage_id`,
//                            read `claimed(token, wallet)` on the distributor, POST
//                            <api>/api/lp/claim-voucher, check the voucher here (token, wallet,
//                            distributor, chain, deadline, and that the signature recovers to the
//                            distributor's `signer()`), preflight, then `distributor.claim(token,
//                            cumulativeAmount, deadline, signature)` from the signer. A 4xx answer
//                            is printed with its body.
//   LP_USER_PHASE=status     (default) read-only: the pool, the wallet's balances, its positions
//                            staked in the vault (the vault's NFTs as the position manager lists
//                            them, filtered by `stakerOf`), its unstaked positions on this pool,
//                            and `claimed(token, wallet)` per reward token. Sends nothing.
//
// It REFUSES chain 1 outright, with no CONFIRM escape: it mints and stakes test positions and
// claims test rewards, which is never something an operator script does on mainnet.
//
// The signer is whatever key the network config holds (`PRIVATE_KEY` for --network sepolia).
// dotenv never overrides a variable that is already set, so `PRIVATE_KEY=0x… npx hardhat run …`
// acts as that wallet whatever `.env` says. LP_USER_EXPECTED_WALLET makes a wrong key a refusal
// instead of positions in the wrong wallet.
//
// ──────────────────────── environment ────────────────────────
//
//   LP_USER_PHASE             zap | stake-nft | claim | status (status)
//   LP_USER_EXPECTED_WALLET   optional: refuse unless the signer is this address
//   LP_USER_USDC              zap: whole tUSDC to zap in (500). stake-nft with neither amount
//                             set: the value of the minted pair, in whole tUSDC at the pool price
//   LP_USER_TICKS             zap / stake-nft: the range as "lower,upper", on the pool's tick grid.
//                             Unset: [tick - 6000, tick + 6000], lower aligned down and upper
//                             aligned up to the spacing (price x0.55 .. x1.82 around the current)
//   LP_USER_SLIPPAGE_BPS      zap / stake-nft: the minimums' tolerance in bps (100). Applied to
//                             the swap's expected output and to what the mint is expected to take
//   LP_USER_AMOUNT0/_AMOUNT1  stake-nft: what to mint with, in whole token0 / token1. One set: the
//                             other is the matching amount for the range at the current price.
//                             Neither set: a pair worth LP_USER_USDC
//   LP_USER_TOKEN_ID          claim: the position (its NFT id), required. stake-nft: an NFT the
//                             signer already owns, staked instead of minting a new one
//   LP_USER_TOKEN             claim: OVTR | TRW | any reward-token symbol, or an address (OVTR)
//   LP_USER_API               claim: the backend base URL (https://staking-api.factori.cloud/staking)
//   DEPLOYMENTS_FILE          redirects the registry, like every other script here
//
//     LP_USER_PHASE=zap       LP_USER_USDC=500 npx hardhat run scripts/lp-user-rehearsal.js --network sepolia
//     LP_USER_PHASE=stake-nft LP_USER_AMOUNT1=250 npx hardhat run scripts/lp-user-rehearsal.js --network sepolia
//     LP_USER_PHASE=claim     LP_USER_TOKEN=OVTR LP_USER_TOKEN_ID=<tokenId> \
//       npx hardhat run scripts/lp-user-rehearsal.js --network sepolia
//     LP_USER_PHASE=status    npx hardhat run scripts/lp-user-rehearsal.js --network sepolia

const PHASES = ["zap", "stake-nft", "claim", "status"];
const DEFAULT_PHASE = "status";
const DEFAULT_USDC = "500";
const DEFAULT_HALF_WIDTH_TICKS = 6000;
const DEFAULT_SLIPPAGE_BPS = 100;
const DEFAULT_TOKEN = "OVTR";
const DEFAULT_API = "https://staking-api.factori.cloud/staking";
/** Seconds from the latest block to the mint deadline: the frontend's TX_DEADLINE_SECONDS. */
const DEADLINE_SECONDS = 1200;
/** At most this many of the wallet's own position NFTs are read in `status` (newest first). */
const HELD_LIST_LIMIT = 100;

const VAULT_KIND = "LPStakingVault";
const ZAPPER_KIND = "LPZapper";
const DISTRIBUTOR_KIND = "RewardsDistributor";
// Fully qualified, so a mock with the same name can never make the lookup ambiguous. The
// artifacts carry every custom error, which is what lets a preflight revert decode by name.
const VAULT_ARTIFACT = "contracts/lp-staking/LPStakingVault.sol:LPStakingVault";
const ZAPPER_ARTIFACT = "contracts/lp-staking/LPZapper.sol:LPZapper";
const DISTRIBUTOR_ARTIFACT = "contracts/lp-staking/RewardsDistributor.sol:RewardsDistributor";

/** The EIP-712 domain the distributor initialises with (`__EIP712_init("RealLPRewards", "1")`). */
const VOUCHER_DOMAIN = { name: "RealLPRewards", version: "1" };
const VOUCHER_TYPES = {
  RewardClaim: [
    { name: "token", type: "address" },
    { name: "user", type: "address" },
    { name: "cumulativeAmount", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function liquidity() view returns (uint128)",
  "function tickSpacing() view returns (int24)",
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
  "function positions(uint256 tokenId) view returns (uint96, address, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256, uint256, uint128, uint128)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function approve(address to, uint256 tokenId)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
];

// ──────────────────────── Uniswap V3 math (exact, ported from the frontend's src/lib/univ3.ts) ────────────────────────

const Q96 = 1n << 96n;
const MIN_TICK = -887272;
const MAX_TICK = 887272;
const MIN_SQRT_RATIO = 4295128739n;
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;
const UINT256_MAX = (1n << 256n) - 1n;
const BPS = 10_000n;
const ONE_E18 = 10n ** 18n;
/** Reference liquidity for the ratio helpers: large enough that integer rounding is invisible. */
const L_REF = 10n ** 30n;

/** (bit of |tick|, multiplier) — v3-core TickMath.sol, verbatim. */
const TICK_MAGIC = [
  [0x1, 0xfffcb933bd6fad37aa2d162d1a594001n],
  [0x2, 0xfff97272373d413259a46990580e213an],
  [0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000, 0x48a170391f7dc42444e8fa2n],
];

/** sqrt(1.0001 ** tick) * 2**96, exactly as the pool computes it. */
function getSqrtRatioAtTick(tick) {
  if (!Number.isInteger(tick)) throw new Error(`tick ${tick} is not an integer`);
  const absTick = Math.abs(tick);
  if (absTick > MAX_TICK) throw new Error(`tick ${tick} out of range [${MIN_TICK}, ${MAX_TICK}]`);
  let ratio = absTick & 0x1 ? TICK_MAGIC[0][1] : 1n << 128n;
  for (const [mask, magic] of TICK_MAGIC.slice(1)) {
    if (absTick & mask) ratio = (ratio * magic) >> 128n;
  }
  if (tick > 0) ratio = UINT256_MAX / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

function sortPair(a, b) {
  return a > b ? [b, a] : [a, b];
}

function amount0ForLiquidity(sqrtA, sqrtB, liquidity) {
  const [lo, hi] = sortPair(sqrtA, sqrtB);
  return ((liquidity << 96n) * (hi - lo)) / hi / lo;
}

function amount1ForLiquidity(sqrtA, sqrtB, liquidity) {
  const [lo, hi] = sortPair(sqrtA, sqrtB);
  return (liquidity * (hi - lo)) / Q96;
}

/** (token0, token1) that `liquidity` holds in [sqrtA, sqrtB] at the price sqrtP. */
function amountsForLiquidity(sqrtP, sqrtA, sqrtB, liquidity) {
  const [lo, hi] = sortPair(sqrtA, sqrtB);
  if (sqrtP <= lo) return { amount0: amount0ForLiquidity(lo, hi, liquidity), amount1: 0n };
  if (sqrtP < hi) {
    return { amount0: amount0ForLiquidity(sqrtP, hi, liquidity), amount1: amount1ForLiquidity(lo, sqrtP, liquidity) };
  }
  return { amount0: 0n, amount1: amount1ForLiquidity(lo, hi, liquidity) };
}

function liquidityForAmount0(sqrtA, sqrtB, amount0) {
  const [lo, hi] = sortPair(sqrtA, sqrtB);
  return (amount0 * ((lo * hi) / Q96)) / (hi - lo);
}

function liquidityForAmount1(sqrtA, sqrtB, amount1) {
  const [lo, hi] = sortPair(sqrtA, sqrtB);
  return (amount1 * Q96) / (hi - lo);
}

/** v3-periphery LiquidityAmounts.getLiquidityForAmounts: the side that runs out first binds. */
function liquidityForAmounts(sqrtP, sqrtA, sqrtB, amount0, amount1) {
  const [lo, hi] = sortPair(sqrtA, sqrtB);
  if (sqrtP <= lo) return liquidityForAmount0(lo, hi, amount0);
  if (sqrtP < hi) {
    const l0 = liquidityForAmount0(sqrtP, hi, amount0);
    const l1 = liquidityForAmount1(lo, sqrtP, amount1);
    return l0 < l1 ? l0 : l1;
  }
  return liquidityForAmount1(lo, hi, amount1);
}

/** token0 expressed in token1 units at this price. */
function valueInToken1(amount0, sqrtP) {
  return (((amount0 * sqrtP) / Q96) * sqrtP) / Q96;
}

/** token1 expressed in token0 units at this price. */
function valueInToken0(amount1, sqrtP) {
  return (((amount1 * Q96) / sqrtP) * Q96) / sqrtP;
}

/** The share of a position's value that is token1, x 1e18: 0 below the range, 1e18 above it. */
function share1Scaled(sqrtP, sqrtA, sqrtB) {
  const [lo, hi] = sortPair(sqrtA, sqrtB);
  if (sqrtP <= lo) return 0n;
  if (sqrtP >= hi) return ONE_E18;
  const { amount0, amount1 } = amountsForLiquidity(sqrtP, lo, hi, L_REF);
  const total = valueInToken1(amount0, sqrtP) + amount1;
  return total === 0n ? 0n : (amount1 * ONE_E18) / total;
}

function clampSqrt(sqrt) {
  if (sqrt < MIN_SQRT_RATIO) return MIN_SQRT_RATIO;
  if (sqrt >= MAX_SQRT_RATIO) return MAX_SQRT_RATIO - 1n;
  return sqrt;
}

/**
 * A single-range, constant-liquidity exact-input swap with the fee taken on the input. Tick
 * crossings are ignored, so a large trade on a thin pool is estimated too kindly — the
 * `amountOutMin` derived from it is what bounds the real execution, and the preflight shows it.
 */
function estimateExactInput({ zeroForOne, amountIn, sqrtPriceX96, liquidity, feePips }) {
  if (amountIn <= 0n || liquidity <= 0n) return { amountOut: 0n, sqrtPriceAfter: sqrtPriceX96 };
  const amountInLessFee = amountIn - (amountIn * feePips) / 1_000_000n;
  if (zeroForOne) {
    const sqrtPriceAfter = clampSqrt((liquidity * Q96 * sqrtPriceX96) / (liquidity * Q96 + amountInLessFee * sqrtPriceX96));
    return { amountOut: amount1ForLiquidity(sqrtPriceAfter, sqrtPriceX96, liquidity), sqrtPriceAfter };
  }
  const sqrtPriceAfter = clampSqrt(sqrtPriceX96 + (amountInLessFee * Q96) / liquidity);
  return { amountOut: amount0ForLiquidity(sqrtPriceX96, sqrtPriceAfter, liquidity), sqrtPriceAfter };
}

function priceImpactBps(before, after) {
  if (before === 0n) return 0;
  const p0 = before * before;
  const p1 = after * after;
  return Number(((p1 > p0 ? p1 - p0 : p0 - p1) * BPS) / p0);
}

/**
 * The swap that turns `amount0` / `amount1` into the ratio [tickLower, tickUpper] wants — the
 * frontend's `estimateSwapToRatio`, solved by bisection on the swap input against the model's own
 * output: the residual "token1 held minus token1 the range wants, both at the post-swap price"
 * changes sign exactly once between swapping nothing and swapping everything.
 */
function estimateSwapToRatio({ amount0, amount1, sqrtPriceX96, liquidity, tickLower, tickUpper, feePips }) {
  const sqrtA = getSqrtRatioAtTick(tickLower);
  const sqrtB = getSqrtRatioAtTick(tickUpper);
  const idle = (zeroForOne) => ({
    zeroForOne,
    amountIn: 0n,
    expectedOut: 0n,
    sqrtPriceAfter: sqrtPriceX96,
    priceImpactBps: 0,
    amount0After: amount0,
    amount1After: amount1,
  });
  if (amount0 <= 0n && amount1 <= 0n) return idle(false);

  const totalValue1 = valueInToken1(amount0, sqrtPriceX96) + amount1;
  const wantToken1 = (totalValue1 * share1Scaled(sqrtPriceX96, sqrtA, sqrtB)) / ONE_E18;
  const zeroForOne = wantToken1 > amount1;
  const imbalance = wantToken1 > amount1 ? wantToken1 - amount1 : amount1 - wantToken1;
  if (imbalance <= totalValue1 / 10n ** 12n) return idle(zeroForOne);

  const swapAt = (amountIn) => {
    const out = estimateExactInput({ zeroForOne, amountIn, sqrtPriceX96, liquidity, feePips });
    const amount0After = zeroForOne ? amount0 - amountIn : amount0 + out.amountOut;
    const amount1After = zeroForOne ? amount1 + out.amountOut : amount1 - amountIn;
    const target =
      ((valueInToken1(amount0After, out.sqrtPriceAfter) + amount1After) * share1Scaled(out.sqrtPriceAfter, sqrtA, sqrtB)) /
      ONE_E18;
    return { ...out, amount0After, amount1After, short: zeroForOne ? amount1After < target : amount1After > target };
  };

  const maxIn = zeroForOne ? amount0 : amount1;
  if (maxIn <= 0n || !swapAt(0n).short) return idle(zeroForOne);
  let lo = 0n;
  let hi = maxIn;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (swapAt(mid).short) lo = mid;
    else hi = mid;
  }
  const final = swapAt(hi);
  return {
    zeroForOne,
    amountIn: hi,
    expectedOut: final.amountOut,
    sqrtPriceAfter: final.sqrtPriceAfter,
    priceImpactBps: priceImpactBps(sqrtPriceX96, final.sqrtPriceAfter),
    amount0After: final.amount0After,
    amount1After: final.amount1After,
  };
}

/** `amount * (1 - bps)`, never zero for a non-zero amount: a zero minimum is no protection. */
function withSlippage(amount, slippageBps) {
  if (amount <= 0n) return 0n;
  const min = (amount * (BPS - BigInt(slippageBps))) / BPS;
  return min > 0n ? min : 1n;
}

/**
 * `amount0Min` / `amount1Min` for a mint: the mint takes only what the range ratio can use, so the
 * minimums come from the CONSUMED amounts at `sqrtPriceX96`, not from the desired ones.
 */
function mintMinimums({ amount0Desired, amount1Desired, sqrtPriceX96, tickLower, tickUpper, slippageBps }) {
  const sqrtA = getSqrtRatioAtTick(tickLower);
  const sqrtB = getSqrtRatioAtTick(tickUpper);
  const liquidity = liquidityForAmounts(sqrtPriceX96, sqrtA, sqrtB, amount0Desired, amount1Desired);
  const consumed = amountsForLiquidity(sqrtPriceX96, sqrtA, sqrtB, liquidity);
  return {
    liquidity,
    amount0: consumed.amount0,
    amount1: consumed.amount1,
    amount0Min: withSlippage(consumed.amount0, slippageBps),
    amount1Min: withSlippage(consumed.amount1, slippageBps),
  };
}

/** The pair a range holds when it is worth `valueUsdc` (smallest units) at sqrtP. */
function pairWorth({ valueUsdc, usdcIsToken0, sqrtPriceX96, tickLower, tickUpper }) {
  const sqrtA = getSqrtRatioAtTick(tickLower);
  const sqrtB = getSqrtRatioAtTick(tickUpper);
  const ref = amountsForLiquidity(sqrtPriceX96, sqrtA, sqrtB, L_REF);
  const refValue = usdcIsToken0
    ? ref.amount0 + valueInToken0(ref.amount1, sqrtPriceX96)
    : ref.amount1 + valueInToken1(ref.amount0, sqrtPriceX96);
  return amountsForLiquidity(sqrtPriceX96, sqrtA, sqrtB, (L_REF * valueUsdc) / refValue);
}

/** Given one side, the other side a mint on [tickLower, tickUpper] needs at sqrtP. */
function matchingPair({ amount0, amount1, sqrtPriceX96, tickLower, tickUpper }) {
  const sqrtA = getSqrtRatioAtTick(tickLower);
  const sqrtB = getSqrtRatioAtTick(tickUpper);
  // Out of range the position is one-sided, and only one of the two amounts can size it.
  if (amount0 !== null && sqrtPriceX96 >= sqrtB) {
    throw new Error("The range sits below the price and takes token1 only: set LP_USER_AMOUNT1, not LP_USER_AMOUNT0");
  }
  if (amount1 !== null && sqrtPriceX96 <= sqrtA) {
    throw new Error("The range sits above the price and takes token0 only: set LP_USER_AMOUNT0, not LP_USER_AMOUNT1");
  }
  const unbounded = UINT256_MAX >> 128n;
  const liquidity =
    amount0 !== null
      ? liquidityForAmounts(sqrtPriceX96, sqrtA, sqrtB, amount0, unbounded)
      : liquidityForAmounts(sqrtPriceX96, sqrtA, sqrtB, unbounded, amount1);
  const needed = amountsForLiquidity(sqrtPriceX96, sqrtA, sqrtB, liquidity);
  // The given side stays exactly as given; only the missing side comes from the range.
  return amount0 !== null ? { amount0, amount1: needed.amount1 } : { amount0: needed.amount0, amount1 };
}

// ──────────────────────── small helpers ────────────────────────

function sameValue(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function readPhase() {
  const raw = process.env.LP_USER_PHASE;
  if (raw === undefined || raw.trim() === "") return DEFAULT_PHASE;
  if (!PHASES.includes(raw.trim())) throw new Error(`LP_USER_PHASE must be one of ${PHASES.join(", ")} — got ${raw}`);
  return raw.trim();
}

function readSlippageBps() {
  const raw = process.env.LP_USER_SLIPPAGE_BPS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_SLIPPAGE_BPS;
  const bps = Number(raw.trim());
  if (!Number.isInteger(bps) || bps < 0 || bps >= 10_000) {
    throw new Error(`LP_USER_SLIPPAGE_BPS must be an integer in [0, 9999] — got ${raw}`);
  }
  return bps;
}

/** A whole-token env amount in smallest units; `fallback` when unset, null when unset without one. */
function readWholeAmount(name, decimals, fallback) {
  const raw = (process.env[name] || "").trim() || fallback;
  if (raw === undefined || raw === "") return null;
  let amount;
  try {
    amount = hre.ethers.parseUnits(raw, decimals);
  } catch {
    throw new Error(`${name} must be a decimal number of whole tokens — got ${raw}`);
  }
  if (amount <= 0n) throw new Error(`${name} must be positive — got ${raw}`);
  return amount;
}

function readTokenId(name) {
  const raw = (process.env[name] || "").trim();
  if (raw === "") return null;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a decimal NFT id — got ${raw}`);
  return BigInt(raw);
}

function alignDown(tick, spacing) {
  return Math.floor(tick / spacing) * spacing;
}

function alignUp(tick, spacing) {
  return Math.ceil(tick / spacing) * spacing;
}

/** LP_USER_TICKS, checked against the grid; unset = [tick - 6000, tick + 6000] aligned outward. */
function readRange(tick, spacing) {
  const minTick = alignUp(MIN_TICK, spacing);
  const maxTick = alignDown(MAX_TICK, spacing);
  const raw = process.env.LP_USER_TICKS;
  if (!raw || raw.trim() === "") {
    return [
      Math.max(minTick, alignDown(tick - DEFAULT_HALF_WIDTH_TICKS, spacing)),
      Math.min(maxTick, alignUp(tick + DEFAULT_HALF_WIDTH_TICKS, spacing)),
    ];
  }
  const parts = raw.split(",").map((part) => Number(part.trim()));
  if (parts.length !== 2 || !parts.every(Number.isInteger) || parts[0] >= parts[1]) {
    throw new Error(`LP_USER_TICKS must be "lower,upper" with lower < upper — got ${raw}`);
  }
  for (const t of parts) {
    if (t % spacing !== 0) throw new Error(`LP_USER_TICKS: ${t} is not a multiple of the pool's tick spacing ${spacing}`);
    if (t < minTick || t > maxTick) throw new Error(`LP_USER_TICKS: ${t} is outside [${minTick}, ${maxTick}]`);
  }
  return parts;
}

function fmt(token, amount) {
  return `${hre.ethers.formatUnits(amount, token.decimals)} ${token.symbol}`;
}

/** USDC per $ASSET at `tick`, for display only (a double is fine here, never for a minimum). */
function usdcPerAsset(stack, tick) {
  const raw1per0 = Math.pow(1.0001, Number(tick)) * Math.pow(10, stack.token0.decimals - stack.token1.decimals);
  return stack.usdcIsToken0 ? 1 / raw1per0 : raw1per0;
}

function priceText(price) {
  return String(Number(price.toPrecision(6)));
}

function describeRange(stack, tickLower, tickUpper, tick) {
  const now = usdcPerAsset(stack, tick);
  const [low, high] = [usdcPerAsset(stack, tickLower), usdcPerAsset(stack, tickUpper)].sort((a, b) => a - b);
  const pct = (price) => `${price >= now ? "+" : ""}${((price / now - 1) * 100).toFixed(1)} %`;
  return (
    `[${tickLower}, ${tickUpper}] (pool tick ${tick}, spacing ${stack.tickSpacing}): ` +
    `${priceText(low)} .. ${priceText(high)} ${stack.usdc.symbol} per ${stack.asset.symbol}, ` +
    `${pct(low)} .. ${pct(high)} around the current ${priceText(now)}`
  );
}

async function latestTimestamp() {
  return (await hre.ethers.provider.getBlock("latest")).timestamp;
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

/**
 * One line for a revert: the custom error by name (tried against every contract the call can
 * reach, because a vault error comes back out of the zapper undecoded by the zapper's ABI), a
 * revert string ("Too little received", "Price slippage check"), or the provider's message.
 */
function describeRevert(error, contracts) {
  if (error.revert && error.revert.name) return `${error.revert.name}(${error.revert.args.map(String).join(", ")})`;
  if (error.reason) return error.reason;
  const data = error.data || (error.error && error.error.data) || (error.info && error.info.error && error.info.error.data);
  if (typeof data === "string" && data.length >= 10) {
    for (const contract of contracts) {
      try {
        const parsed = contract.interface.parseError(data);
        if (parsed) return `${parsed.name}(${parsed.args.map(String).join(", ")})`;
      } catch {
        /* not this contract's error */
      }
    }
    return `unrecognised revert data ${data}`;
  }
  return error.shortMessage || error.message;
}

/** eth_call first, so a revert is reported by name and nothing is spent on it. */
async function preflight(label, contracts, call) {
  try {
    return await call();
  } catch (error) {
    throw new Error(`${label} would revert: ${describeRevert(error, contracts)} — nothing was sent for it`);
  }
}

/** One HTTP request to the backend. A non-2xx answer throws WITH its status and body. */
async function httpJson(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${url} answered HTTP ${response.status} ${response.statusText}\n  body: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${method} ${url} answered HTTP ${response.status} with a body that is not JSON: ${text.slice(0, 500)}`);
  }
}

// ──────────────────────── the stack ────────────────────────

async function registryContract(chainId, kind, artifact, signer) {
  const address = pools.registryAddress(chainId, kind);
  if (!address) {
    throw new Error(`No ${kind} recorded for chain ${chainId}. Point DEPLOYMENTS_FILE at the stack's registry.`);
  }
  if ((await hre.ethers.provider.getCode(address)) === "0x") throw new Error(`No contract code at ${kind} ${address} on chain ${chainId}`);
  return hre.ethers.getContractAt(artifact, address, signer);
}

async function describeToken(address, signer) {
  const contract = new hre.ethers.Contract(address, TOKEN_ABI, signer);
  return {
    contract,
    address: hre.ethers.getAddress(address),
    symbol: await contract.symbol(),
    decimals: Number(await contract.decimals()),
  };
}

/**
 * The vault, zapper and distributor from the registry; the pool, the position manager and the two
 * tokens from their immutables, cross-checked so the zapper provably feeds the registry's vault.
 */
async function resolveStack(chainId, signer) {
  const vault = await registryContract(chainId, VAULT_KIND, VAULT_ARTIFACT, signer);
  const zapper = await registryContract(chainId, ZAPPER_KIND, ZAPPER_ARTIFACT, signer);
  const distributor = await registryContract(chainId, DISTRIBUTOR_KIND, DISTRIBUTOR_ARTIFACT, signer);

  if (!sameValue(await zapper.vault(), vault.target)) {
    throw new Error(`The zapper ${zapper.target} feeds the vault ${await zapper.vault()}, not the registry's ${vault.target}`);
  }
  const poolAddress = hre.ethers.getAddress(await vault.pool());
  if (!sameValue(await zapper.pool(), poolAddress)) throw new Error(`The zapper reads pool ${await zapper.pool()}, the vault ${poolAddress}`);
  const npmAddress = hre.ethers.getAddress(await vault.positionManager());
  if (!sameValue(await zapper.positionManager(), npmAddress)) {
    throw new Error(`The zapper mints through ${await zapper.positionManager()}, the vault custodies ${npmAddress}`);
  }

  const token0 = await describeToken(await vault.token0(), signer);
  const token1 = await describeToken(await vault.token1(), signer);
  const usdcIsToken0 = await zapper.usdcIsToken0();
  const usdc = usdcIsToken0 ? token0 : token1;
  const asset = usdcIsToken0 ? token1 : token0;
  if (!sameValue(await zapper.usdc(), usdc.address)) throw new Error(`The zapper's usdc() ${await zapper.usdc()} is neither pool token`);

  const pool = new hre.ethers.Contract(poolAddress, POOL_ABI, signer);
  return {
    vault,
    zapper,
    distributor,
    pool,
    npm: new hre.ethers.Contract(npmAddress, NPM_ABI, signer),
    npmAddress,
    token0,
    token1,
    usdc,
    asset,
    usdcIsToken0,
    fee: Number(await vault.fee()),
    tickSpacing: Number(await pool.tickSpacing()),
  };
}

async function readPool(stack) {
  const slot0 = await stack.pool.slot0();
  return { sqrtPriceX96: slot0.sqrtPriceX96, tick: Number(slot0.tick), liquidity: await stack.pool.liquidity() };
}

/** The zapper's own spot-vs-TWAP guard, as `previewTwap()` reports it; null when the read reverts. */
async function readTwap(stack) {
  try {
    const [currentTick, twapTick, maxDeviationTicks, withinBounds] = await stack.zapper.previewTwap();
    return { currentTick: Number(currentTick), twapTick: Number(twapTick), maxDeviationTicks: Number(maxDeviationTicks), withinBounds };
  } catch (error) {
    return { error: describeRevert(error, [stack.zapper]) };
  }
}

function twapLine(twap) {
  if (twap.error) return `zapper TWAP guard: previewTwap() reverts (${twap.error})`;
  return (
    `zapper TWAP guard: spot ${twap.currentTick}, TWAP ${twap.twapTick}, ` +
    `deviation ${Math.abs(twap.currentTick - twap.twapTick)} of max ${twap.maxDeviationTicks} — ` +
    (twap.withinBounds ? "a swap passes" : "TRIPPED, a swap reverts TwapDeviationTooHigh")
  );
}

async function readRewardTokens(stack, signer) {
  const out = [];
  for (const address of await stack.distributor.rewardTokens()) {
    const token = await describeToken(address, signer);
    token.info = await stack.distributor.rewardToken(address);
    out.push(token);
  }
  return out;
}

async function requireDepositsOpen(stack) {
  if (await stack.vault.depositsPaused()) {
    throw new Error(`The vault ${stack.vault.target} has depositsPaused = true: every stake path reverts DepositsArePaused`);
  }
}

/** Approves the NFT to the vault (unless already approved), preflights and sends `stake`. */
async function stakeNft(stack, signer, tokenId) {
  const [approved, forAll] = await Promise.all([
    stack.npm.getApproved(tokenId),
    stack.npm.isApprovedForAll(signer.address, stack.vault.target),
  ]);
  const needsApproval = !forAll && !sameValue(approved, stack.vault.target);
  console.log(
    `\nPlanned:\n` +
      (needsApproval ? `  ${stack.npmAddress}.approve(${stack.vault.target}, ${tokenId})\n` : `  (the vault is already approved for token ${tokenId})\n`) +
      `  ${stack.vault.target}.stake(${tokenId})   — staker = ${signer.address}`
  );
  let approveReceipt = null;
  if (needsApproval) {
    approveReceipt = await pools.send(`Approving token ${tokenId} to the vault`, signer, (o) => stack.npm.approve(stack.vault.target, tokenId, o));
  }
  await preflight(`vault.stake(${tokenId})`, [stack.vault], () => stack.vault.stake.staticCall(tokenId));
  const stakeReceipt = await pools.send(`Staking token ${tokenId}`, signer, (o) => stack.vault.stake(tokenId, o));
  const staked = findEvent(stakeReceipt, stack.vault, "Staked");
  const staker = await stack.vault.stakerOf(tokenId);
  if (!sameValue(staker, signer.address)) throw new Error(`stakerOf(${tokenId}) is ${staker} after the stake, not ${signer.address}`);
  return { approveReceipt, stakeReceipt, staked };
}

// ──────────────────────── phases ────────────────────────

async function runZap({ signer, stack }) {
  const { zapper, vault, usdc, asset } = stack;
  if (!sameValue(await vault.zapper(), zapper.target)) {
    throw new Error(`The vault's zapper is ${await vault.zapper()}, not ${zapper.target}: zapIn would revert NotZapper`);
  }
  await requireDepositsOpen(stack);

  const usdcAmount = readWholeAmount("LP_USER_USDC", usdc.decimals, DEFAULT_USDC);
  const balance = await usdc.contract.balanceOf(signer.address);
  if (balance < usdcAmount) throw new Error(`The signer holds ${fmt(usdc, balance)}, the zap needs ${fmt(usdc, usdcAmount)}`);
  const slippageBps = readSlippageBps();

  const reading = await readPool(stack);
  const [tickLower, tickUpper] = readRange(reading.tick, stack.tickSpacing);
  const split = estimateSwapToRatio({
    amount0: stack.usdcIsToken0 ? usdcAmount : 0n,
    amount1: stack.usdcIsToken0 ? 0n : usdcAmount,
    sqrtPriceX96: reading.sqrtPriceX96,
    liquidity: reading.liquidity,
    tickLower,
    tickUpper,
    feePips: BigInt(stack.fee),
  });
  if (split.amountIn > 0n && split.zeroForOne !== stack.usdcIsToken0) {
    throw new Error("The model asks to sell $ASSET; a zap can only sell USDC. Pick a range that needs $ASSET.");
  }
  if (split.amountIn > 0n && split.expectedOut === 0n) {
    throw new Error(`The model expects no ${asset.symbol} out of the swap: the pool has no in-range liquidity (${reading.liquidity})`);
  }
  const minimums = mintMinimums({
    amount0Desired: split.amount0After,
    amount1Desired: split.amount1After,
    sqrtPriceX96: split.sqrtPriceAfter,
    tickLower,
    tickUpper,
    slippageBps,
  });
  const swap = {
    // Only consulted when amountIn > 0; then it must be "sell USDC", which is usdcIsToken0.
    zeroForOne: stack.usdcIsToken0,
    amountIn: split.amountIn,
    amountOutMin: split.amountIn > 0n ? withSlippage(split.expectedOut, slippageBps) : 0n,
    amount0Min: minimums.amount0Min,
    amount1Min: minimums.amount1Min,
  };

  const twap = await readTwap(stack);
  console.log(`\nPool: ${reading.liquidity} in-range liquidity; ${twapLine(twap)}`);
  if (swap.amountIn > 0n && (twap.error || !twap.withinBounds)) {
    throw new Error(
      "The zap needs a swap and the zapper's TWAP guard would revert it. Wait until spot and TWAP are back " +
        "within the deviation, or use LP_USER_PHASE=stake-nft (no swap, no guard)."
    );
  }

  const deadline = BigInt((await latestTimestamp()) + DEADLINE_SECONDS);
  const t0 = stack.token0;
  const t1 = stack.token1;
  console.log(
    `\nPlanned zap (slippage ${slippageBps} bps, deadline ${deadline} = latest block + ${DEADLINE_SECONDS} s):\n` +
      `  range     ${describeRange(stack, tickLower, tickUpper, reading.tick)}\n` +
      `  input     ${fmt(usdc, usdcAmount)}\n` +
      (swap.amountIn > 0n
        ? `  swap      ${fmt(usdc, swap.amountIn)} -> ${fmt(asset, split.expectedOut)} expected, ` +
          `${fmt(asset, swap.amountOutMin)} minimum (model impact ${split.priceImpactBps} bps)\n`
        : `  swap      none (the range takes the input as it is)\n`) +
      `  mint      ~${fmt(t0, minimums.amount0)} + ~${fmt(t1, minimums.amount1)} expected, ` +
      `minimums ${fmt(t0, swap.amount0Min)} / ${fmt(t1, swap.amount1Min)}; the rest is refunded\n` +
      `  staked    for ${signer.address} (zapIn credits msg.sender)\n` +
      `Planned transactions:\n` +
      `  ${usdc.address}.approve(${zapper.target}, ${usdcAmount})   — only if the allowance is short\n` +
      `  ${zapper.target}.zapIn(${usdcAmount}, ${tickLower}, ${tickUpper}, ` +
      `{zeroForOne: ${swap.zeroForOne}, amountIn: ${swap.amountIn}, amountOutMin: ${swap.amountOutMin}, ` +
      `amount0Min: ${swap.amount0Min}, amount1Min: ${swap.amount1Min}}, ${deadline})\n`
  );

  await pools.ensureAllowance(usdc.contract, signer, zapper.target, usdcAmount, `${usdc.symbol} -> LPZapper`);
  const contracts = [zapper, vault];
  await preflight("zapIn", contracts, () => zapper.zapIn.staticCall(usdcAmount, tickLower, tickUpper, swap, deadline));
  const receipt = await pools.send(`Zapping ${fmt(usdc, usdcAmount)} into [${tickLower}, ${tickUpper}]`, signer, (o) =>
    zapper.zapIn(usdcAmount, tickLower, tickUpper, swap, deadline, o)
  );

  const zapped = findEvent(receipt, zapper, "ZappedIn");
  const staked = findEvent(receipt, vault, "Staked");
  const added = findEvent(receipt, stack.npm, "IncreaseLiquidity");
  if (!zapped || !staked) throw new Error(`No ZappedIn / Staked event in ${receipt.hash}`);
  const tokenId = zapped.tokenId;
  const staker = await vault.stakerOf(tokenId);
  console.log(
    `\nZapped: token ${tokenId}, staked for ${staker}${sameValue(staker, signer.address) ? "" : "  <-- NOT the signer"}\n` +
      `  range [${staked.tickLower}, ${staked.tickUpper}], liquidity ${staked.liquidity}\n` +
      (added ? `  deposited ${fmt(t0, added.amount0)} + ${fmt(t1, added.amount1)}\n` : "") +
      `  ${fmt(usdc, zapped.usdcIn)} in; refunded ${fmt(usdc, zapped.usdcRefunded)} + ${fmt(asset, zapped.assetRefunded)}\n` +
      `  tx ${receipt.hash}`
  );
}

async function runStakeNft({ signer, stack }) {
  await requireDepositsOpen(stack);
  const t0 = stack.token0;
  const t1 = stack.token1;

  let tokenId = readTokenId("LP_USER_TOKEN_ID");
  let mintReceipt = null;
  if (tokenId !== null) {
    const owner = await stack.npm.ownerOf(tokenId);
    if (!sameValue(owner, signer.address)) throw new Error(`Token ${tokenId} belongs to ${owner}, not to the signer ${signer.address}`);
    const p = await stack.npm.positions(tokenId);
    if (!sameValue(p.token0, t0.address) || !sameValue(p.token1, t1.address) || Number(p.fee) !== stack.fee) {
      throw new Error(`Token ${tokenId} is a position on another pool (${p.token0}/${p.token1}/${p.fee}); the vault reverts PositionPoolMismatch`);
    }
    if (p.liquidity === 0n) throw new Error(`Token ${tokenId} holds no liquidity; the vault reverts EmptyPosition`);
    console.log(`\nStaking the existing token ${tokenId}: [${p.tickLower}, ${p.tickUpper}], liquidity ${p.liquidity}`);
  } else {
    const slippageBps = readSlippageBps();
    const reading = await readPool(stack);
    const [tickLower, tickUpper] = readRange(reading.tick, stack.tickSpacing);
    const given0 = readWholeAmount("LP_USER_AMOUNT0", t0.decimals);
    const given1 = readWholeAmount("LP_USER_AMOUNT1", t1.decimals);
    let desired;
    let sizing;
    if (given0 !== null && given1 !== null) {
      desired = { amount0: given0, amount1: given1 };
      sizing = "both amounts as given";
    } else if (given0 !== null || given1 !== null) {
      desired = matchingPair({ amount0: given0, amount1: given1, sqrtPriceX96: reading.sqrtPriceX96, tickLower, tickUpper });
      sizing = `${given0 !== null ? t1.symbol : t0.symbol} matched to the given ${given0 !== null ? t0.symbol : t1.symbol}`;
    } else {
      const valueUsdc = readWholeAmount("LP_USER_USDC", stack.usdc.decimals, DEFAULT_USDC);
      desired = pairWorth({ valueUsdc, usdcIsToken0: stack.usdcIsToken0, sqrtPriceX96: reading.sqrtPriceX96, tickLower, tickUpper });
      sizing = `a pair worth ${fmt(stack.usdc, valueUsdc)} at the pool price`;
    }
    const minimums = mintMinimums({
      amount0Desired: desired.amount0,
      amount1Desired: desired.amount1,
      sqrtPriceX96: reading.sqrtPriceX96,
      tickLower,
      tickUpper,
      slippageBps,
    });
    if (minimums.liquidity === 0n) {
      throw new Error(`These amounts mint no liquidity on [${tickLower}, ${tickUpper}] at tick ${reading.tick}: the range needs the other token`);
    }
    const [balance0, balance1] = await Promise.all([t0.contract.balanceOf(signer.address), t1.contract.balanceOf(signer.address)]);
    if (balance0 < desired.amount0 || balance1 < desired.amount1) {
      throw new Error(
        `The signer holds ${fmt(t0, balance0)} + ${fmt(t1, balance1)}; the mint asks for ${fmt(t0, desired.amount0)} + ${fmt(t1, desired.amount1)}`
      );
    }
    const deadline = BigInt((await latestTimestamp()) + DEADLINE_SECONDS);
    const params = [
      t0.address,
      t1.address,
      stack.fee,
      tickLower,
      tickUpper,
      desired.amount0,
      desired.amount1,
      minimums.amount0Min,
      minimums.amount1Min,
      signer.address,
      deadline,
    ];
    console.log(
      `\nPlanned mint (${sizing}; slippage ${slippageBps} bps, deadline ${deadline} = latest block + ${DEADLINE_SECONDS} s):\n` +
        `  range     ${describeRange(stack, tickLower, tickUpper, reading.tick)}\n` +
        `  desired   ${fmt(t0, desired.amount0)} + ${fmt(t1, desired.amount1)}\n` +
        `  expected  ${fmt(t0, minimums.amount0)} + ${fmt(t1, minimums.amount1)} taken, liquidity ${minimums.liquidity}\n` +
        `  minimums  ${fmt(t0, minimums.amount0Min)} / ${fmt(t1, minimums.amount1Min)}\n` +
        `Planned transactions:\n` +
        `  ${t0.address}.approve(${stack.npmAddress}, ${desired.amount0})   — only if the allowance is short\n` +
        `  ${t1.address}.approve(${stack.npmAddress}, ${desired.amount1})   — only if the allowance is short\n` +
        `  ${stack.npmAddress}.mint([${params.join(", ")}])\n` +
        `  then approve + stake, printed before they are sent`
    );
    await pools.ensureAllowance(t0.contract, signer, stack.npmAddress, desired.amount0, `${t0.symbol} -> NonfungiblePositionManager`);
    await pools.ensureAllowance(t1.contract, signer, stack.npmAddress, desired.amount1, `${t1.symbol} -> NonfungiblePositionManager`);
    await preflight("NonfungiblePositionManager.mint", [stack.npm], () => stack.npm.mint.staticCall(params));
    mintReceipt = await pools.send(`Minting on [${tickLower}, ${tickUpper}]`, signer, (o) => stack.npm.mint(params, o));
    const minted = findEvent(mintReceipt, stack.npm, "IncreaseLiquidity");
    if (!minted) throw new Error(`No IncreaseLiquidity event in ${mintReceipt.hash}`);
    tokenId = minted.tokenId;
    console.log(
      `  minted token ${tokenId}: ${fmt(t0, minted.amount0)} + ${fmt(t1, minted.amount1)}, liquidity ${minted.liquidity}\n` +
        `  (if the stake below fails, stake it later with LP_USER_TOKEN_ID=${tokenId})`
    );
  }

  const { approveReceipt, stakeReceipt, staked } = await stakeNft(stack, signer, tokenId);
  console.log(
    `\nStaked: token ${tokenId} for ${signer.address}` +
      (staked ? `, range [${staked.tickLower}, ${staked.tickUpper}], liquidity ${staked.liquidity}` : "") +
      `\n` +
      (mintReceipt ? `  mint tx    ${mintReceipt.hash}\n` : "") +
      (approveReceipt ? `  approve tx ${approveReceipt.hash}\n` : "") +
      `  stake tx   ${stakeReceipt.hash}`
  );
}

function resolveRewardToken(rewardTokens) {
  const raw = (process.env.LP_USER_TOKEN || DEFAULT_TOKEN).trim();
  const listed = rewardTokens.map((t) => `${t.symbol} ${t.address}`).join(", ");
  let matches;
  if (/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    matches = rewardTokens.filter((t) => sameValue(t.address, raw));
  } else {
    const wanted = raw.replace(/^\$/, "").toUpperCase();
    matches = rewardTokens.filter((t) => t.symbol.toUpperCase() === wanted);
  }
  if (matches.length === 0) throw new Error(`LP_USER_TOKEN=${raw} is not a reward token of the distributor. Registered: ${listed}`);
  if (matches.length > 1) throw new Error(`LP_USER_TOKEN=${raw} names ${matches.length} reward tokens; pass the address. Registered: ${listed}`);
  return matches[0];
}

function printBackendPositions(positions) {
  if (positions.length === 0) {
    console.log("  (the backend lists no positions for this wallet yet — it mirrors finalized blocks only)");
    return;
  }
  for (const p of positions) {
    console.log(
      `  token ${p.token_id}: lineage ${p.lineage_id ?? p.chain_id}, status ${p.status}, ` +
        `finalized ${p.finalized}, range [${p.tick_lower}, ${p.tick_upper}]`
    );
  }
}

async function runClaim({ chainId, signer, stack }) {
  const api = (process.env.LP_USER_API || DEFAULT_API).trim().replace(/\/+$/, "");
  const wallet = signer.address;
  const distributor = stack.distributor;
  const token = resolveRewardToken(await readRewardTokens(stack, signer));
  console.log(`\nReward token ${token.symbol} ${token.address}: claimsEnabled ${token.info.claimsEnabled}, enabled ${token.info.enabled}`);
  if (await distributor.paused()) throw new Error(`The distributor ${distributor.target} is paused: every claim reverts ClaimsPaused`);
  if (!token.info.claimsEnabled) throw new Error(`Claims of ${token.symbol} are disabled on the distributor: claim reverts TokenClaimsDisabled`);

  const positionsUrl = `${api}/api/lp/positions/${wallet}`;
  console.log(`GET ${positionsUrl}`);
  const listing = await httpJson("GET", positionsUrl);
  const positions = listing.positions || [];
  const tokenId = readTokenId("LP_USER_TOKEN_ID");
  if (tokenId === null) {
    printBackendPositions(positions);
    throw new Error("Set LP_USER_TOKEN_ID to the position to claim for (one of the token ids above)");
  }
  const matches = positions.filter((p) => String(p.token_id) === tokenId.toString());
  if (matches.length === 0) {
    printBackendPositions(positions);
    throw new Error(`The backend lists no position with token id ${tokenId} for ${wallet}`);
  }
  // A token unstaked and staked again has two episodes; the open one is the one to claim for.
  const episode = matches.find((p) => p.status === "active") || matches[matches.length - 1];
  const lineageId = episode.lineage_id ?? episode.chain_id;
  console.log(`  token ${tokenId}: lineage ${lineageId}, status ${episode.status}, finalized ${episode.finalized}`);

  const onchainClaimed = await distributor.claimed(token.address, wallet);
  const body = {
    wallet,
    token: token.address.toLowerCase(),
    lineage_id: String(lineageId),
    onchain_claimed_wei: onchainClaimed.toString(),
  };
  const voucherUrl = `${api}/api/lp/claim-voucher`;
  console.log(`claimed(${token.symbol}, wallet) on chain: ${fmt(token, onchainClaimed)}\nPOST ${voucherUrl} ${JSON.stringify(body)}`);
  const voucher = await httpJson("POST", voucherUrl, body);
  console.log(
    `  voucher: cumulative ${voucher.cumulative_amount_wei}, claimable ${voucher.claimable_wei}, ` +
      `base ${voucher.base_claimed_wei}, amount ${voucher.amount_wei}, deadline ${voucher.deadline}, lineage ${voucher.lineage_id}`
  );

  // The voucher is checked here, field by field, before a transaction is built on it.
  const mismatches = [];
  if (voucher.function !== undefined && voucher.function !== "claim") mismatches.push(`function ${voucher.function} (expected claim)`);
  if (!sameValue(voucher.token, token.address)) mismatches.push(`token ${voucher.token} (asked ${token.address})`);
  if (voucher.wallet !== undefined && !sameValue(voucher.wallet, wallet)) mismatches.push(`wallet ${voucher.wallet} (signer ${wallet})`);
  if (voucher.distributor !== undefined && !sameValue(voucher.distributor, distributor.target)) {
    mismatches.push(`distributor ${voucher.distributor} (this stack's is ${distributor.target}) — the backend serves another stack`);
  }
  if (voucher.chain_id !== undefined && Number(voucher.chain_id) !== chainId) mismatches.push(`chain ${voucher.chain_id} (this run is on ${chainId})`);
  if (mismatches.length > 0) throw new Error(`The voucher does not fit this claim: ${mismatches.join("; ")}`);

  const cumulative = BigInt(voucher.cumulative_amount_wei);
  const deadline = BigInt(voucher.deadline);
  const now = await latestTimestamp();
  if (deadline < BigInt(now)) throw new Error(`The voucher expired at ${deadline}; the latest block is at ${now}. Request a new one.`);
  if (cumulative <= onchainClaimed) throw new Error(`The voucher's cumulative ${cumulative} is not above claimed ${onchainClaimed}: claim reverts NothingToClaim`);
  const recovered = hre.ethers.verifyTypedData(
    { ...VOUCHER_DOMAIN, chainId, verifyingContract: distributor.target },
    VOUCHER_TYPES,
    { token: token.address, user: wallet, cumulativeAmount: cumulative, deadline },
    voucher.signature
  );
  const expectedSigner = await distributor.getFunction("signer")();
  if (!sameValue(recovered, expectedSigner)) {
    throw new Error(`The voucher's signature recovers to ${recovered}; the distributor expects ${expectedSigner}: claim reverts InvalidSignature`);
  }
  const willPay = cumulative - onchainClaimed;
  console.log(
    `  signature recovers to the distributor's signer ${recovered}\n` +
      `\nPlanned transaction:\n` +
      `  ${distributor.target}.claim(${token.address}, ${cumulative}, ${deadline}, ${voucher.signature})\n` +
      `  pays ${fmt(token, willPay)} to ${wallet} (cumulative - claimed)`
  );

  const balanceBefore = await token.contract.balanceOf(wallet);
  await preflight("distributor.claim", [distributor], () => distributor.claim.staticCall(token.address, cumulative, deadline, voucher.signature));
  const receipt = await pools.send(`Claiming ${fmt(token, willPay)} for token ${tokenId}`, signer, (o) =>
    distributor.claim(token.address, cumulative, deadline, voucher.signature, o)
  );
  const claimed = findEvent(receipt, distributor, "Claimed");
  const balanceAfter = await token.contract.balanceOf(wallet);
  console.log(
    `\nClaimed for token ${tokenId} (lineage ${lineageId}):\n` +
      `  claimable ${fmt(token, BigInt(voucher.claimable_wei))} (the voucher)\n` +
      `  paid      ${claimed ? fmt(token, claimed.paidAmount) : "? (no Claimed event)"} (the Claimed event); ` +
      `wallet balance +${fmt(token, balanceAfter - balanceBefore)}\n` +
      `  claimed(${token.symbol}, wallet) now ${fmt(token, await distributor.claimed(token.address, wallet))}\n` +
      `  tx ${receipt.hash}`
  );
}

/** The vault's NFTs as the position manager enumerates them, kept when `stakerOf` is the wallet. */
async function stakedPositionsOf(stack, wallet) {
  const count = await stack.npm.balanceOf(stack.vault.target);
  const out = [];
  for (let i = 0n; i < count; i++) {
    const tokenId = await stack.npm.tokenOfOwnerByIndex(stack.vault.target, i);
    const staker = await stack.vault.stakerOf(tokenId);
    if (!sameValue(staker, wallet)) continue;
    out.push({ tokenId, staker, position: await stack.npm.positions(tokenId) });
  }
  return { count, positions: out };
}

/** The wallet's own NFTs on THIS pool (not staked), newest first, at most HELD_LIST_LIMIT read. */
async function heldPositionsOf(stack, wallet) {
  const count = await stack.npm.balanceOf(wallet);
  const out = [];
  const stop = count > BigInt(HELD_LIST_LIMIT) ? count - BigInt(HELD_LIST_LIMIT) : 0n;
  for (let i = count; i > stop; i--) {
    const tokenId = await stack.npm.tokenOfOwnerByIndex(wallet, i - 1n);
    const position = await stack.npm.positions(tokenId);
    if (sameValue(position.token0, stack.token0.address) && sameValue(position.token1, stack.token1.address) && Number(position.fee) === stack.fee) {
      out.push({ tokenId, position });
    }
  }
  return { count, read: count - stop, positions: out };
}

async function runStatus({ signer, stack }) {
  const wallet = signer.address;
  const reading = await readPool(stack);
  console.log(
    `\nPool ${stack.pool.target}: tick ${reading.tick} (${priceText(usdcPerAsset(stack, reading.tick))} ${stack.usdc.symbol} per ` +
      `${stack.asset.symbol}), in-range liquidity ${reading.liquidity}\n${twapLine(await readTwap(stack))}\n` +
      `vault depositsPaused ${await stack.vault.depositsPaused()}, vault.zapper() ${await stack.vault.zapper()}`
  );

  const [b0, b1, eth] = await Promise.all([
    stack.token0.contract.balanceOf(wallet),
    stack.token1.contract.balanceOf(wallet),
    hre.ethers.provider.getBalance(wallet),
  ]);
  console.log(`\nWallet ${wallet}: ${fmt(stack.token0, b0)}, ${fmt(stack.token1, b1)}, ${hre.ethers.formatEther(eth)} ETH`);

  const staked = await stakedPositionsOf(stack, wallet);
  console.log(`\nStaked in the vault for this wallet: ${staked.positions.length} (of ${staked.count} NFTs the vault holds)`);
  for (const { tokenId, staker, position: p } of staked.positions) {
    const inRange = reading.tick >= Number(p.tickLower) && reading.tick < Number(p.tickUpper);
    console.log(
      `  token ${tokenId}: [${p.tickLower}, ${p.tickUpper}] ${inRange ? "in range" : "OUT of range"}, ` +
        `liquidity ${p.liquidity}, staker ${staker}, NPM owner = the vault`
    );
  }

  const held = await heldPositionsOf(stack, wallet);
  console.log(
    `\nHeld by the wallet on this pool, NOT staked: ${held.positions.length}` +
      (held.read < held.count ? ` (read the newest ${held.read} of ${held.count} NFTs)` : ` (of ${held.count} NFTs it owns)`)
  );
  for (const { tokenId, position: p } of held.positions) {
    console.log(`  token ${tokenId}: [${p.tickLower}, ${p.tickUpper}], liquidity ${p.liquidity}`);
  }

  console.log(`\nRewards distributor ${stack.distributor.target} (paused ${await stack.distributor.paused()}):`);
  for (const token of await readRewardTokens(stack, signer)) {
    const [claimed, funded] = await Promise.all([
      stack.distributor.claimed(token.address, wallet),
      token.contract.balanceOf(stack.distributor.target),
    ]);
    console.log(
      `  ${token.symbol} ${token.address}: claimed(token, wallet) ${fmt(token, claimed)}; ` +
        `claimsEnabled ${token.info.claimsEnabled}, enabled ${token.info.enabled}, conditional ${token.info.conditional}; ` +
        `distributor holds ${fmt(token, funded)}`
    );
  }
}

async function main() {
  const chainId = await pools.chainId();
  if (pools.isMainnet(chainId)) {
    throw new Error("lp-user-rehearsal.js refuses to run on mainnet: it zaps, mints and stakes test positions and claims test rewards.");
  }
  const phase = readPhase();
  const signer = await pools.getSigner();
  const expected = (process.env.LP_USER_EXPECTED_WALLET || "").trim();
  if (expected !== "" && !sameValue(expected, signer.address)) {
    throw new Error(`LP_USER_EXPECTED_WALLET is ${expected} but the signer is ${signer.address}: set PRIVATE_KEY to that wallet's key`);
  }
  console.log(`LP user rehearsal — phase ${phase} on chain ${chainId} (${hre.network.name}), wallet ${signer.address}`);

  const stack = await resolveStack(chainId, signer);
  console.log(
    `Vault ${stack.vault.target}, zapper ${stack.zapper.target}, distributor ${stack.distributor.target}\n` +
      `Pool ${stack.pool.target} (${stack.token0.symbol}/${stack.token1.symbol}, fee ${stack.fee}, spacing ${stack.tickSpacing}), ` +
      `position manager ${stack.npmAddress}`
  );
  const context = { chainId, signer, stack };
  if (phase === "zap") return runZap(context);
  if (phase === "stake-nft") return runStakeNft(context);
  if (phase === "claim") return runClaim(context);
  return runStatus(context);
}

module.exports = {
  PHASES,
  readPhase,
  getSqrtRatioAtTick,
  estimateSwapToRatio,
  mintMinimums,
  pairWorth,
  matchingPair,
  alignDown,
  alignUp,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
