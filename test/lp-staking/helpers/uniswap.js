/**
 * Uniswap V3 arithmetic and call wrappers for the local-fork suite.
 *
 * The pool is created by the suite from two mock tokens, so which of them sorts lower is
 * decided by CREATE and is unknown until the run. Everything that depends on the token
 * order — the initial sqrt price, the mint amounts, the legal zap direction — is derived
 * here at runtime rather than assumed.
 */

const ethers = require("ethers");

const {
  TICK_SPACING,
  ASSET_DECIMALS,
  USDC_DECIMALS,
  PRICE_USDC_PER_ASSET_NUM,
  PRICE_USDC_PER_ASSET_DEN,
  FAR_DEADLINE,
  MAX_UINT128,
} = require("./constants");

const Q96 = 2n ** 96n;

/** Integer square root by Newton's method; exact, unlike the float form. */
function isqrt(value) {
  if (value < 0n) throw new Error("isqrt of a negative value");
  if (value < 2n) return value;
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

/** `floor(sqrt(numerator / denominator) * 2**96)`, computed without floating point. */
function encodeSqrtPriceX96(numerator, denominator) {
  if (denominator <= 0n) throw new Error("encodeSqrtPriceX96: denominator must be positive");
  return isqrt((numerator * Q96 * Q96) / denominator);
}

/**
 * The pool's starting price, as Uniswap stores it: the Q64.96 square root of the RAW-unit
 * ratio token1/token0. See the header of scripts/create-sepolia-pool.js for the derivation.
 *
 *   ASSET is token0: raw = P * 10**usdcDecimals / 10**assetDecimals
 *   USDC  is token0: raw = (1/P) * 10**assetDecimals / 10**usdcDecimals
 *
 * The decimals and the price fraction default to the mock pair the shipped suite builds.
 * A profile passes its own, which is what lets one implementation serve a pool made of
 * mock tokens and one made of the real ones.
 *
 * @param {boolean} assetIsToken0
 * @param {{assetDecimals?: bigint, usdcDecimals?: bigint, num?: bigint, den?: bigint}} [price]
 */
function initialSqrtPriceX96(assetIsToken0, price = {}) {
  const assetDecimals = price.assetDecimals ?? ASSET_DECIMALS;
  const usdcDecimals = price.usdcDecimals ?? USDC_DECIMALS;
  const num = price.num ?? PRICE_USDC_PER_ASSET_NUM;
  const den = price.den ?? PRICE_USDC_PER_ASSET_DEN;

  const assetUnit = 10n ** assetDecimals;
  const usdcUnit = 10n ** usdcDecimals;
  return assetIsToken0
    ? encodeSqrtPriceX96(num * usdcUnit, den * assetUnit)
    : encodeSqrtPriceX96(den * assetUnit, num * usdcUnit);
}

/** Which of the two tokens Uniswap will call token0, and the sorted pair. */
function sortTokens(assetAddress, usdcAddress) {
  const assetIsToken0 = assetAddress.toLowerCase() < usdcAddress.toLowerCase();
  const [token0, token1] = assetIsToken0
    ? [assetAddress, usdcAddress]
    : [usdcAddress, assetAddress];
  return { assetIsToken0, token0, token1 };
}

/** Rounds a tick down to the pool's tick spacing, the way Uniswap requires. */
function alignDown(tick, spacing = TICK_SPACING) {
  return Math.floor(Number(tick) / spacing) * spacing;
}

async function currentTick(pool) {
  return Number((await pool.slot0()).tick);
}

/**
 * The tokenId of the position an NPM `mint` created.
 *
 * Copied from test/lp-staking/fork/LPStakingFork.test.js L359–372 — keep in sync.
 */
function mintedTokenId(receipt, npmAddress) {
  const topic = ethers.id("Transfer(address,address,uint256)");
  for (const log of receipt.logs) {
    if (
      log.address.toLowerCase() === npmAddress.toLowerCase() &&
      log.topics[0] === topic &&
      log.topics.length === 4 &&
      BigInt(log.topics[1]) === 0n
    ) {
      return BigInt(log.topics[3]);
    }
  }
  throw new Error("no NFT mint Transfer log in receipt");
}

/**
 * Mints a real Uniswap V3 position. `assetAmount` / `usdcAmount` are stated by role and
 * mapped onto amount0/amount1 here, so no call site has to know the sort order.
 */
async function mintPosition({
  npm,
  npmAddress,
  signer,
  token0,
  token1,
  fee,
  tickLower,
  tickUpper,
  assetIsToken0,
  assetAmount,
  usdcAmount,
  recipient,
  deadline = FAR_DEADLINE,
}) {
  const [amount0Desired, amount1Desired] = assetIsToken0
    ? [assetAmount, usdcAmount]
    : [usdcAmount, assetAmount];

  const tx = await npm.connect(signer).mint({
    token0,
    token1,
    fee,
    tickLower,
    tickUpper,
    amount0Desired,
    amount1Desired,
    amount0Min: 0n,
    amount1Min: 0n,
    recipient: recipient || (await signer.getAddress()),
    deadline,
  });
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw new Error(`mint reverted: ${receipt.hash}`);
  return { receipt, tokenId: mintedTokenId(receipt, npmAddress) };
}

/** A single-hop exact-input swap through the real SwapRouter02. */
async function swapExactIn({
  router,
  signer,
  tokenIn,
  tokenOut,
  fee,
  amountIn,
  recipient,
  sqrtPriceLimitX96 = 0n,
}) {
  const tx = await router.connect(signer).exactInputSingle({
    tokenIn,
    tokenOut,
    fee,
    recipient: recipient || (await signer.getAddress()),
    amountIn,
    amountOutMinimum: 0n,
    sqrtPriceLimitX96,
  });
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw new Error(`swap reverted: ${receipt.hash}`);
  return receipt;
}

/**
 * What the vault would pull out of a position: principal, then accrued fees.
 *
 * Both legs are simulated as the vault, because only the position's owner may call them.
 * `npmRead` must be provider-connected — a signer-connected contract refuses a `from`
 * override.
 */
async function previewWithdraw({ npm, npmRead, tokenId, owner }) {
  const position = await npm.positions(tokenId);
  const [principal0, principal1] = await npmRead.decreaseLiquidity.staticCall(
    {
      tokenId,
      liquidity: position.liquidity,
      amount0Min: 0n,
      amount1Min: 0n,
      deadline: FAR_DEADLINE,
    },
    { from: owner }
  );
  const [fees0, fees1] = await npmRead.collect.staticCall(
    { tokenId, recipient: owner, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 },
    { from: owner }
  );
  return { principal0, principal1, fees0, fees1, liquidity: position.liquidity };
}

module.exports = {
  Q96,
  isqrt,
  encodeSqrtPriceX96,
  initialSqrtPriceX96,
  sortTokens,
  alignDown,
  currentTick,
  mintedTokenId,
  mintPosition,
  swapExactIn,
  previewWithdraw,
};
