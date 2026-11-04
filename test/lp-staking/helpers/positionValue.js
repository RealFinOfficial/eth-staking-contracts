/**
 * The ApeBond valuation, re-derived in JavaScript BigInt so the suites can state the bonus they
 * EXPECT without asking the contract under test for it.
 *
 * Three pieces, each a line-for-line port of the Solidity the contracts use:
 *   - `getSqrtRatioAtTick`  — `contracts/lp-staking/libraries/TickMath.sol` (Uniswap v3-core,
 *     branch 0.8), the same magic constants in the same order;
 *   - `getAmountsForLiquidity` and its two helpers — `libraries/LiquidityAmounts.sol`
 *     (v3-periphery), `mulDiv` being exact floor division on BigInt;
 *   - `valueAt` — `libraries/PositionValue.sol`: the token amounts of `liquidity` on the range at
 *     `tick`, converted into one token at that same price, rounded down at every step.
 *
 * Every function rounds exactly as the Solidity does, so a suite may compare with `equal`, not
 * `closeTo`. `bonusFor` adds the adapter's last step: `value * bps / 10,000`, zero below the
 * campaign's minimum.
 */

const Q96 = 1n << 96n;
const MAX_TICK = 887272;
const MAX_UINT256 = (1n << 256n) - 1n;

/** [bit, multiplier] pairs of TickMath.getSqrtRatioAtTick, in the upstream order. */
const RATIO_STEPS = [
  [0x2n, 0xfff97272373d413259a46990580e213an],
  [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20n, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200n, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000n, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000n, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000n, 0x48a170391f7dc42444e8fa2n],
];

function mulDiv(a, b, denominator) {
  return (a * b) / denominator;
}

/** sqrt(1.0001^tick) * 2^96, rounded up exactly as TickMath does. */
function getSqrtRatioAtTick(tick) {
  const t = Number(tick);
  const absTick = BigInt(Math.abs(t));
  if (absTick > BigInt(MAX_TICK)) throw new Error(`tick ${t} out of bounds`);

  let ratio =
    (absTick & 0x1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  for (const [bit, multiplier] of RATIO_STEPS) {
    if ((absTick & bit) !== 0n) ratio = (ratio * multiplier) >> 128n;
  }
  if (t > 0) ratio = MAX_UINT256 / ratio;

  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

function getAmount0ForLiquidity(sqrtA, sqrtB, liquidity) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return mulDiv(BigInt(liquidity) << 96n, sqrtB - sqrtA, sqrtB) / sqrtA;
}

function getAmount1ForLiquidity(sqrtA, sqrtB, liquidity) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return mulDiv(BigInt(liquidity), sqrtB - sqrtA, Q96);
}

function getAmountsForLiquidity(sqrtP, sqrtA, sqrtB, liquidity) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  if (sqrtP <= sqrtA) return [getAmount0ForLiquidity(sqrtA, sqrtB, liquidity), 0n];
  if (sqrtP < sqrtB) {
    return [getAmount0ForLiquidity(sqrtP, sqrtB, liquidity), getAmount1ForLiquidity(sqrtA, sqrtP, liquidity)];
  }
  return [0n, getAmount1ForLiquidity(sqrtA, sqrtB, liquidity)];
}

/** PositionValue.valueAt: the value of `liquidity` on [tickLower, tickUpper] at `tick`. */
function valueAt(liquidity, tickLower, tickUpper, tick, inToken0) {
  const sqrtP = getSqrtRatioAtTick(tick);
  const [amount0, amount1] = getAmountsForLiquidity(
    sqrtP,
    getSqrtRatioAtTick(tickLower),
    getSqrtRatioAtTick(tickUpper),
    liquidity
  );
  return inToken0
    ? amount0 + mulDiv(mulDiv(amount1, Q96, sqrtP), Q96, sqrtP)
    : amount1 + mulDiv(mulDiv(amount0, sqrtP, Q96), sqrtP, Q96);
}

/** The adapter's bonus: value * bps / 10,000, zero below the campaign's minimum. */
function bonusFor(value, bonusBps, minBonusAmount) {
  const bonus = (BigInt(value) * BigInt(bonusBps)) / 10_000n;
  return bonus < BigInt(minBonusAmount) ? 0n : bonus;
}

/** The escrow's rebalance scaling: min(amount, amount * new / old), zero when old is worth 0. */
function scaledAmount(amount, valueOld, valueNew) {
  if (valueOld === 0n) return 0n;
  if (valueNew >= valueOld) return amount;
  return (amount * valueNew) / valueOld;
}

module.exports = {
  Q96,
  MAX_TICK,
  getSqrtRatioAtTick,
  getAmountsForLiquidity,
  valueAt,
  bonusFor,
  scaledAmount,
};
