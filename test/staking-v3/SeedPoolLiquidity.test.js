// scripts/seed-pool-liquidity.js: the ONE first-liquidity mint of a new Uniswap v3 pool on a test
// network, in-process against the math-rung fixture (MockUniswapV3Pool + MockMathPositionManager,
// the real Uniswap v3 liquidity formulas) and a scratch registry, in the token order LP_TOKEN_ORDER
// selects: the ticks of -50 % / +100 % around 0.20 USDC per $ASSET, the expected amounts, the mint,
// the approvals back to zero, the refusal of a second mint and of chains 1 and 43114.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployOrderedPair, usdcFirst } = require("../lp-staking/helpers/tokenOrder");

const Q192 = 1n << 192n;

function isqrt(n) {
  // Newton's method on BigInt: floor(sqrt(n)), exact at any size.
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/** sqrtPriceX96 of 0.20 USDC per $ASSET (18 / 6 decimals) for the given token order. */
function sqrtPriceAt020(assetIsToken0) {
  // asset token0: raw token1/token0 = 0.2 * 1e6 / 1e18 = 2 / 1e13; usdc token0: 5 * 1e12.
  return assetIsToken0 ? isqrt((2n * Q192) / 10n ** 13n) : isqrt(5n * 10n ** 12n * Q192);
}

function scriptWithRegistry(registryFile) {
  const modules = ["../../scripts/lib/pools", "../../scripts/seed-pool-liquidity"].map((m) => require.resolve(m));
  const previous = process.env.DEPLOYMENTS_FILE;
  process.env.DEPLOYMENTS_FILE = registryFile;
  try {
    for (const m of modules) delete require.cache[m];
    return require("../../scripts/seed-pool-liquidity");
  } finally {
    if (previous === undefined) delete process.env.DEPLOYMENTS_FILE;
    else process.env.DEPLOYMENTS_FILE = previous;
    for (const m of modules) delete require.cache[m];
  }
}

const PLAN = { LP_SEED_USDC: "50", LP_SEED_ASSET: "250", LP_SEED_DOWN_PCT: "50", LP_SEED_UP_PCT: "100" };

describe(`seed-pool-liquidity.js (${usdcFirst() ? "USDC" : "$ASSET"} is token0)`, function () {
  const assetIsToken0 = !usdcFirst();

  describe("the pure functions", function () {
    const s = require("../../scripts/seed-pool-liquidity");

    it("the ticks of 0.20 USDC per $ASSET at -50 % / +100 %, spacing 60", function () {
      const ticks = s.seedTicks({
        sqrtPriceX96: sqrtPriceAt020(assetIsToken0),
        assetIsToken0,
        downPct: 50,
        upPct: 100,
        spacing: 60,
      });
      // asset token0: raw price 2e-13 (tick -292,419.2), x0.5 -> -299,351.0 down to -299,400,
      // x2 -> -285,487.4 up to -285,480. usdc token0: raw 5e12 (tick 292,419.2), /2 -> 285,487.4
      // down to 285,480, /0.5 -> 299,351.0 up to 299,400. The same band, mirrored.
      expect(ticks).to.deep.equal(
        assetIsToken0 ? { tickLower: -299400, tickUpper: -285480 } : { tickLower: 285480, tickUpper: 299400 }
      );
    });

    it("the expected amounts: 50 USDC takes 250 $ASSET within the tick rounding", function () {
      const sqrtPriceX96 = sqrtPriceAt020(assetIsToken0);
      const { tickLower, tickUpper } = s.seedTicks({ sqrtPriceX96, assetIsToken0, downPct: 50, upPct: 100, spacing: 60 });
      const usdc = 50n * 10n ** 6n;
      const asset = 250n * 10n ** 18n;
      const e = s.expectedAmounts({
        sqrtPriceX96,
        tickLower,
        tickUpper,
        amount0Desired: assetIsToken0 ? asset : usdc,
        amount1Desired: assetIsToken0 ? usdc : asset,
      });
      const usdcTaken = assetIsToken0 ? e.amount1 : e.amount0;
      const assetTaken = assetIsToken0 ? e.amount0 : e.amount1;
      expect(usdcTaken <= usdc && assetTaken <= asset, "never more than desired").to.equal(true);
      // One side binds (taken within a wei of desired); the other within 1 % of the plan, the
      // widening of the band to the tick grid.
      const usdcGap = usdc - usdcTaken;
      const assetGap = asset - assetTaken;
      expect(usdcGap <= 1n || assetGap <= 10n ** 6n, "one side binds").to.equal(true);
      expect(usdcGap * 100n <= usdc, "USDC within 1 %").to.equal(true);
      expect(assetGap * 100n <= asset, "$ASSET within 1 %").to.equal(true);
      expect(e.amount0Min).to.equal((e.amount0 * 99n) / 100n);
      expect(e.amount1Min).to.equal((e.amount1 * 99n) / 100n);
      expect(e.liquidity > 0n).to.equal(true);
    });

    it("refuses chains 1 and 43114 whatever is set, and bad inputs", function () {
      for (const chain of [1, 43114]) {
        expect(() => s.refuseMainnet(chain)).to.throw(/never on chain/);
        expect(() => s.readInputs(chain, PLAN)).to.throw(/never on chain/);
      }
      expect(() => s.refuseMainnet(43113)).to.not.throw();
      expect(() => s.refuseMainnet(11155111)).to.not.throw();
      expect(() => s.readInputs(43113, { ...PLAN, LP_SEED_USDC: undefined })).to.throw(/LP_SEED_USDC/);
      expect(() => s.readInputs(43113, { ...PLAN, LP_SEED_ASSET: "" })).to.throw(/LP_SEED_ASSET/);
      expect(() => s.readInputs(43113, { ...PLAN, LP_SEED_DOWN_PCT: "100" })).to.throw(/LP_SEED_DOWN_PCT/);
      expect(() => s.readInputs(43113, { ...PLAN, LP_SEED_UP_PCT: "0" })).to.throw(/LP_SEED_UP_PCT/);
      expect(s.readInputs(43113, PLAN)).to.deep.include({ usdc: "50", asset: "250", downPct: 50, upPct: 100 });
    });
  });

  describe("against the fixture", function () {
    let s;
    let deployer;
    let asset;
    let usdc;
    let pool;
    let npm;
    let registryFile;
    let env;

    beforeEach(async function () {
      [deployer] = await ethers.getSigners();
      const factory = await ethers.getContractFactory("MockERC20Permit");
      ({ asset, usdc } = await deployOrderedPair(
        () => factory.deploy("Test Asset", "tASSET", 10n ** 30n, 18),
        () => factory.deploy("Test USDC", "tUSDC", 10n ** 18n, 6)
      ));
      const assetAddr = await asset.getAddress();
      const usdcAddr = await usdc.getAddress();
      const [token0, token1] = assetIsToken0 ? [assetAddr, usdcAddr] : [usdcAddr, assetAddr];
      pool = await (await ethers.getContractFactory("MockUniswapV3Pool")).deploy(token0, token1, 3000);
      await pool.setSqrtPriceX96(sqrtPriceAt020(assetIsToken0));
      await pool.setCurrentTick(assetIsToken0 ? -292420 : 292419);
      npm = await (await ethers.getContractFactory("MockMathPositionManager")).deploy(await pool.getAddress());

      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "seed-pool-"));
      registryFile = path.join(scratch, "deployments.json");
      fs.writeFileSync(
        registryFile,
        JSON.stringify(
          { 31337: { UniswapV3Pool: { address: await pool.getAddress(), token0, token1, fee: 3000, oracleWarmupTokenId: "7" } } },
          null,
          2
        )
      );
      s = scriptWithRegistry(registryFile);
      env = { ...PLAN, LP_NPM: await npm.getAddress() };
    });

    async function seed(extra = {}) {
      const previous = process.env.DEPLOYMENTS_FILE;
      process.env.DEPLOYMENTS_FILE = registryFile;
      try {
        return await s.seedPool({ env: { ...env, ...extra }, deployer });
      } finally {
        if (previous === undefined) delete process.env.DEPLOYMENTS_FILE;
        else process.env.DEPLOYMENTS_FILE = previous;
      }
    }

    it("a dry run computes the plan and sends nothing", async function () {
      const nonce = await ethers.provider.getTransactionCount(deployer.address);
      const r = await seed({ LP_SEED_DRY_RUN: "1" });
      expect(r.dryRun).to.equal(true);
      expect(r.tickLower).to.equal(assetIsToken0 ? -299400 : 285480);
      expect(await ethers.provider.getTransactionCount(deployer.address)).to.equal(nonce);
      expect(JSON.parse(fs.readFileSync(registryFile, "utf8"))["31337"].UniswapV3Pool).to.not.have.property("seedTokenId");
    });

    it("mints ONE position to the deployer, sets the approvals back to zero, records it", async function () {
      const a0 = await asset.balanceOf(deployer.address);
      const u0 = await usdc.balanceOf(deployer.address);
      const r = await seed();
      const npmAddr = await npm.getAddress();

      expect(await npm.ownerOf(r.tokenId)).to.equal(deployer.address);
      const p = await npm.positions(r.tokenId);
      expect(p.tickLower).to.equal(BigInt(r.tickLower));
      expect(p.tickUpper).to.equal(BigInt(r.tickUpper));
      expect(r.tickLower).to.equal(assetIsToken0 ? -299400 : 285480);
      expect(r.tickUpper).to.equal(assetIsToken0 ? -285480 : 299400);
      expect(r.usdcTaken).to.equal(r.expected.usdc);
      expect(r.assetTaken).to.equal(r.expected.asset);
      expect(u0 - (await usdc.balanceOf(deployer.address))).to.equal(r.usdcTaken);
      expect(a0 - (await asset.balanceOf(deployer.address))).to.equal(r.assetTaken);
      expect(r.usdcTaken * 100n >= 50n * 10n ** 6n * 99n).to.equal(true);
      expect(r.assetTaken * 100n >= 250n * 10n ** 18n * 99n).to.equal(true);
      expect(await asset.allowance(deployer.address, npmAddr)).to.equal(0n);
      expect(await usdc.allowance(deployer.address, npmAddr)).to.equal(0n);

      const entry = JSON.parse(fs.readFileSync(registryFile, "utf8"))["31337"].UniswapV3Pool;
      expect(entry.seedTokenId).to.equal(r.tokenId.toString());
      expect(entry.seedTickLower).to.equal(r.tickLower);
      expect(entry.seedTickUpper).to.equal(r.tickUpper);
      expect(entry.seedUsdc).to.equal(r.usdcTaken.toString());
      expect(entry.seedAsset).to.equal(r.assetTaken.toString());
      expect(entry.oracleWarmupTokenId).to.equal("7", "the other keys of the entry stay");
      expect(entry.fee).to.equal(3000);
    });

    it("a rerun refuses to mint a second time", async function () {
      const r = await seed();
      const nonce = await ethers.provider.getTransactionCount(deployer.address);
      await expect(seed()).to.be.rejectedWith(new RegExp(`already holds the seed position #${r.tokenId}`));
      await expect(seed({ LP_SEED_DRY_RUN: "1" })).to.be.rejectedWith(/already holds the seed position/);
      expect(await ethers.provider.getTransactionCount(deployer.address)).to.equal(nonce);
    });
  });
});
