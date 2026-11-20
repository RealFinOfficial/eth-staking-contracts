// The token order every LP and staking v3 suite runs under.
//
// On Ethereum $ASSET is the first token of the Uniswap V3 pool; on Avalanche C-Chain USDC is
// (2026-11-20). `LP_TOKEN_ORDER` picks one: `asset-first` (the default) or `usdc-first`. CI runs the
// Hardhat suite once per value, and the suites deploy their pair through {deployOrderedPair} so the
// order is a fact rather than an accident of deployment order. The Foundry tier reads the same
// variable (`BaseForge._usdcFirst`).

const ORDERS = ["asset-first", "usdc-first"];

/** `asset-first` or `usdc-first`; throws on anything else rather than silently defaulting. */
function tokenOrder() {
  const value = process.env.LP_TOKEN_ORDER || "asset-first";
  if (!ORDERS.includes(value)) {
    throw new Error(`LP_TOKEN_ORDER must be asset-first or usdc-first — got ${value}`);
  }
  return value;
}

/** True when USDC is the pool's token0. */
function usdcFirst() {
  return tokenOrder() === "usdc-first";
}

/**
 * Deploys the $ASSET side, then the USDC side, and deploys the pair again (every deployment moves
 * the deployer's nonce, so each try is two new addresses) until it sorts in the chosen order.
 * Redeploying only one side is not enough: an $ASSET that lands at the top of the address space
 * has no USDC above it. Each try succeeds with probability 1/2, so 32 tries fail with 2^-32.
 *
 * @param {() => Promise<object>} deployAsset
 * @param {() => Promise<object>} deployUsdc
 * @returns {Promise<{asset: object, usdc: object}>}
 */
async function deployOrderedPair(deployAsset, deployUsdc) {
  const wantUsdcFirst = usdcFirst();
  for (let i = 0; i < 32; i++) {
    const asset = await deployAsset();
    await asset.waitForDeployment();
    const usdc = await deployUsdc();
    await usdc.waitForDeployment();
    const usdcBelow = (await usdc.getAddress()).toLowerCase() < (await asset.getAddress()).toLowerCase();
    if (usdcBelow === wantUsdcFirst) return { asset, usdc };
  }
  throw new Error(`deployOrderedPair: no pair sorted ${wantUsdcFirst ? "USDC" : "the asset"} first`);
}

module.exports = { ORDERS, tokenOrder, usdcFirst, deployOrderedPair };
