const { expect } = require("chai");
const { ethers } = require("hardhat");
const { tokenOrder, usdcFirst, deployOrderedPair } = require("./helpers/tokenOrder");

/**
 * The switch every LP and staking v3 suite runs under: `LP_TOKEN_ORDER=asset-first` (the default,
 * the Ethereum order) or `usdc-first` (the Avalanche C-Chain order). CI runs the Hardhat suite once
 * per value.
 */
describe("helpers/tokenOrder.js", function () {
  it("reads LP_TOKEN_ORDER, asset-first by default, and refuses an unknown value", function () {
    const saved = process.env.LP_TOKEN_ORDER;
    try {
      delete process.env.LP_TOKEN_ORDER;
      expect(tokenOrder()).to.equal("asset-first");
      expect(usdcFirst()).to.equal(false);
      process.env.LP_TOKEN_ORDER = "usdc-first";
      expect(usdcFirst()).to.equal(true);
      process.env.LP_TOKEN_ORDER = "sideways";
      expect(() => tokenOrder()).to.throw(/LP_TOKEN_ORDER must be asset-first or usdc-first — got sideways/);
    } finally {
      if (saved === undefined) delete process.env.LP_TOKEN_ORDER;
      else process.env.LP_TOKEN_ORDER = saved;
    }
  });

  it("deploys the pair so it sorts in the chosen order", async function () {
    const Token = await ethers.getContractFactory("MockERC20Decimals");
    const { asset, usdc } = await deployOrderedPair(
      () => Token.deploy("Asset", "ASSET", 1n, 18),
      () => Token.deploy("USD Coin", "USDC", 1n, 6)
    );
    const assetBelow = (await asset.getAddress()).toLowerCase() < (await usdc.getAddress()).toLowerCase();
    expect(assetBelow).to.equal(!usdcFirst());
    expect(await asset.decimals()).to.equal(18n);
    expect(await usdc.decimals()).to.equal(6n);
  });
});
