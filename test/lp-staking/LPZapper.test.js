const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("LPZapper", function () {
  let zap, vault, pool, nfpm, router;
  let usdc, asset, token0, token1;
  let owner, alice, bob, stranger;

  let zapAddr, vaultAddr, poolAddr, nfpmAddr, routerAddr;
  let usdcAddr, assetAddr, token0Addr, token1Addr;
  let usdcIsToken0;

  const FEE = 3000;
  const OTHER_FEE = 500;
  const TWAP_WINDOW = 600;
  const MAX_DEVIATION_BPS = 500;
  const TICK_LOWER = -600;
  const TICK_UPPER = 600;
  const FAR_DEADLINE = 10n ** 12n;
  const ZERO = ethers.ZeroAddress;
  const CONSUME_BPS = 9000n;

  const USDC = (n) => BigInt(n) * 10n ** 6n;
  const ASSET = (n) => BigInt(n) * 10n ** 18n;

  // Happy-path split: 1000 USDC in, 400 of it swapped 1:1 into ASSET, mint consumes 90%
  // of each side, the remaining 10% of each goes back to the caller.
  const USDC_IN = USDC(1000);
  const SWAP_IN = USDC(400);
  const SWAP_OUT = ASSET(400);
  const USDC_USED = ((USDC_IN - SWAP_IN) * CONSUME_BPS) / 10_000n;
  const ASSET_USED = (SWAP_OUT * CONSUME_BPS) / 10_000n;
  const USDC_REFUND = USDC_IN - SWAP_IN - USDC_USED;
  const ASSET_REFUND = SWAP_OUT - ASSET_USED;

  async function txTimestamp(tx) {
    const receipt = await tx.wait();
    return (await ethers.provider.getBlock(receipt.blockNumber)).timestamp;
  }

  async function deployZapper(overrides = {}) {
    const args = {
      vault: vaultAddr,
      positionManager: nfpmAddr,
      pool: poolAddr,
      token0: token0Addr,
      token1: token1Addr,
      fee: FEE,
      swapRouter: routerAddr,
      usdc: usdcAddr,
      asset: assetAddr,
      initialOwner: owner.address,
      twapWindow: TWAP_WINDOW,
      maxDeviationBps: MAX_DEVIATION_BPS,
      ...overrides,
    };
    const Zapper = await ethers.getContractFactory("LPZapper");
    return Zapper.deploy(
      args.vault,
      args.positionManager,
      args.pool,
      args.token0,
      args.token1,
      args.fee,
      args.swapRouter,
      args.usdc,
      args.asset,
      args.initialOwner,
      args.twapWindow,
      args.maxDeviationBps
    );
  }

  /// Swap leg that agrees with the pool's token ordering, i.e. the only legal direction.
  function swapParams(overrides = {}) {
    return {
      zeroForOne: usdcIsToken0,
      amountIn: SWAP_IN,
      amountOutMin: SWAP_OUT,
      amount0Min: 0n,
      amount1Min: 0n,
      ...overrides,
    };
  }

  async function signPermit(account, spender, value, deadline) {
    const domain = {
      name: "USD Coin",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: usdcAddr,
    };
    const types = {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };
    const value_ = {
      owner: account.address,
      spender,
      value,
      nonce: await usdc.nonces(account.address),
      deadline,
    };
    return ethers.Signature.from(await account.signTypedData(domain, types, value_));
  }

  async function expectZapperDrained() {
    expect(await usdc.balanceOf(zapAddr)).to.equal(0n);
    expect(await asset.balanceOf(zapAddr)).to.equal(0n);
  }

  /// Fabricates a position NFT owned by `holder`. No principal is booked behind it: these
  /// are only ever moved around, never decreased or collected.
  async function createPosition(holder) {
    await nfpm.mintFake(holder.address, token0Addr, token1Addr, FEE, TICK_LOWER, TICK_UPPER, 1_000_000n, 0n, 0n);
    return nfpm.lastMintedId();
  }

  beforeEach(async function () {
    [owner, alice, bob, stranger] = await ethers.getSigners();

    // USDC carries a real EIP-2612 permit so `zapInWithPermit` can be driven end to end.
    const Permit = await ethers.getContractFactory("MockERC20Permit");
    usdc = await Permit.deploy("USD Coin", "USDC", USDC(10_000_000), 6);
    const Token = await ethers.getContractFactory("MockERC20Decimals");
    asset = await Token.deploy("Asset", "ASSET", ASSET(10_000_000), 18);

    usdcAddr = await usdc.getAddress();
    assetAddr = await asset.getAddress();

    // The pool sorts its pair ascending by address, so which side USDC lands on is an
    // accident of deployment order. Every direction-sensitive assertion derives from this.
    usdcIsToken0 = usdcAddr.toLowerCase() < assetAddr.toLowerCase();
    [token0, token1] = usdcIsToken0 ? [usdc, asset] : [asset, usdc];
    token0Addr = await token0.getAddress();
    token1Addr = await token1.getAddress();

    const Pool = await ethers.getContractFactory("MockUniswapV3Pool");
    pool = await Pool.deploy(token0Addr, token1Addr, FEE);
    poolAddr = await pool.getAddress();

    const Nfpm = await ethers.getContractFactory("MockPositionManager");
    nfpm = await Nfpm.deploy();
    nfpmAddr = await nfpm.getAddress();

    const Router = await ethers.getContractFactory("MockSwapRouter");
    router = await Router.deploy();
    routerAddr = await router.getAddress();
    // 1 USDC buys 1 ASSET; the router pays out of its own inventory.
    await router.setRate(usdcAddr, assetAddr, 10n ** 18n, 10n ** 6n);
    await router.setRate(assetAddr, usdcAddr, 10n ** 6n, 10n ** 18n);
    await asset.transfer(routerAddr, ASSET(1_000_000));
    await usdc.transfer(routerAddr, USDC(1_000_000));

    const Vault = await ethers.getContractFactory("LPStakingVault");
    vault = await Vault.deploy(
      nfpmAddr,
      poolAddr,
      token0Addr,
      token1Addr,
      FEE,
      routerAddr,
      owner.address,
      TWAP_WINDOW,
      MAX_DEVIATION_BPS
    );
    vaultAddr = await vault.getAddress();

    zap = await deployZapper();
    zapAddr = await zap.getAddress();
    await vault.setZapper(zapAddr);

    await nfpm.setMintConsumeBps(CONSUME_BPS);

    await usdc.transfer(alice.address, USDC(100_000));
    await usdc.connect(alice).approve(zapAddr, ethers.MaxUint256);
  });

  // ─────────────────────────────────────────────────────────────
  describe("Deployment", function () {
    it("stores the pair, the pool triple and the swap direction", async function () {
      expect(await zap.vault()).to.equal(vaultAddr);
      expect(await zap.positionManager()).to.equal(nfpmAddr);
      expect(await zap.swapRouter()).to.equal(routerAddr);
      expect(await zap.pool()).to.equal(poolAddr);
      expect(await zap.token0()).to.equal(token0Addr);
      expect(await zap.token1()).to.equal(token1Addr);
      expect(await zap.fee()).to.equal(FEE);
      expect(await zap.usdc()).to.equal(usdcAddr);
      expect(await zap.asset()).to.equal(assetAddr);
      expect(await zap.usdcIsToken0()).to.equal(usdcIsToken0);
      expect(await zap.owner()).to.equal(owner.address);

      await expect(zap.deploymentTransaction())
        .to.emit(zap, "TwapParamsSet")
        .withArgs(TWAP_WINDOW, MAX_DEVIATION_BPS);
    });

    it("rejects a zero vault, position manager, swap router or pool token", async function () {
      await expect(deployZapper({ vault: ZERO })).to.be.revertedWithCustomError(zap, "ZeroAddress");
      await expect(deployZapper({ positionManager: ZERO })).to.be.revertedWithCustomError(
        zap,
        "ZeroAddress"
      );
      await expect(deployZapper({ swapRouter: ZERO })).to.be.revertedWithCustomError(zap, "ZeroAddress");
      await expect(deployZapper({ token0: ZERO })).to.be.revertedWithCustomError(zap, "ZeroAddress");
      await expect(deployZapper({ token1: ZERO })).to.be.revertedWithCustomError(zap, "ZeroAddress");
    });

    it("rejects a zero pool in the TWAP guard, which runs before the zapper's own checks", async function () {
      await expect(deployZapper({ pool: ZERO })).to.be.revertedWithCustomError(zap, "InvalidPool");
    });

    it("rejects an unsorted token pair", async function () {
      await expect(deployZapper({ token0: token1Addr, token1: token0Addr }))
        .to.be.revertedWithCustomError(zap, "TokensNotSorted")
        .withArgs(token1Addr, token0Addr);
    });

    it("rejects a pool whose triple is not the configured one", async function () {
      const Pool = await ethers.getContractFactory("MockUniswapV3Pool");
      const wrongFeePool = await Pool.deploy(token0Addr, token1Addr, OTHER_FEE);

      await expect(deployZapper({ pool: await wrongFeePool.getAddress() }))
        .to.be.revertedWithCustomError(zap, "PoolMismatch")
        .withArgs(token0Addr, token1Addr, OTHER_FEE);
    });

    it("rejects the pool on a wrong token0, a wrong token1 or a wrong fee, each on its own", async function () {
      const Token = await ethers.getContractFactory("MockERC20Decimals");
      const other = await Token.deploy("Other", "OTHER", ASSET(1), 18);
      const otherAddr = await other.getAddress();

      await pool.setTokens(otherAddr, token1Addr);
      await expect(deployZapper())
        .to.be.revertedWithCustomError(zap, "PoolMismatch")
        .withArgs(otherAddr, token1Addr, FEE);

      await pool.setTokens(token0Addr, otherAddr);
      await expect(deployZapper())
        .to.be.revertedWithCustomError(zap, "PoolMismatch")
        .withArgs(token0Addr, otherAddr, FEE);

      await pool.setTokens(token0Addr, token1Addr);
      await pool.setFee(OTHER_FEE);
      await expect(deployZapper())
        .to.be.revertedWithCustomError(zap, "PoolMismatch")
        .withArgs(token0Addr, token1Addr, OTHER_FEE);

      // the restored triple deploys, so each arm above was the only difference
      await pool.setFee(FEE);
      expect(await (await deployZapper()).pool()).to.equal(poolAddr);
    });

    it("rejects a usdc/asset pair that is not the pool's pair", async function () {
      const Token = await ethers.getContractFactory("MockERC20Decimals");
      const other = await Token.deploy("Other", "OTHER", ASSET(1), 18);
      const otherAddr = await other.getAddress();

      await expect(deployZapper({ asset: otherAddr }))
        .to.be.revertedWithCustomError(zap, "TokenPairMismatch")
        .withArgs(usdcAddr, otherAddr, token0Addr, token1Addr);

      await expect(deployZapper({ usdc: otherAddr }))
        .to.be.revertedWithCustomError(zap, "TokenPairMismatch")
        .withArgs(otherAddr, assetAddr, token0Addr, token1Addr);

      // both sides naming the same token is still not the pair
      await expect(deployZapper({ asset: usdcAddr }))
        .to.be.revertedWithCustomError(zap, "TokenPairMismatch")
        .withArgs(usdcAddr, usdcAddr, token0Addr, token1Addr);
    });

    it("accepts the pair in the reversed role assignment", async function () {
      // usdc and asset swapped: still one on each side of the pool, so the constructor
      // takes it and only flips the recorded direction.
      const reversed = await deployZapper({ usdc: assetAddr, asset: usdcAddr });
      expect(await reversed.usdcIsToken0()).to.equal(!usdcIsToken0);
    });

    it("enforces the TWAP bounds", async function () {
      await expect(deployZapper({ twapWindow: 299 }))
        .to.be.revertedWithCustomError(zap, "InvalidTwapWindow")
        .withArgs(299, 300);
      await expect(deployZapper({ maxDeviationBps: 0 }))
        .to.be.revertedWithCustomError(zap, "InvalidTwapDeviation")
        .withArgs(0, 2000);
      await expect(deployZapper({ maxDeviationBps: 2001 }))
        .to.be.revertedWithCustomError(zap, "InvalidTwapDeviation")
        .withArgs(2001, 2000);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("zapIn", function () {
    it("pulls USDC, swaps, mints, stakes for the caller and refunds both leftovers", async function () {
      const usdcBefore = await usdc.balanceOf(alice.address);
      const assetBefore = await asset.balanceOf(alice.address);

      const tokenId = await zap
        .connect(alice)
        .zapIn.staticCall(USDC_IN, TICK_LOWER, TICK_UPPER, swapParams(), FAR_DEADLINE);

      const tx = await zap
        .connect(alice)
        .zapIn(USDC_IN, TICK_LOWER, TICK_UPPER, swapParams(), FAR_DEADLINE);
      const ts = await txTimestamp(tx);

      await expect(tx)
        .to.emit(zap, "ZappedIn")
        .withArgs(alice.address, tokenId, USDC_IN, USDC_REFUND, ASSET_REFUND, ts);

      // the position is staked in the vault, credited to the caller and not to the zapper
      await expect(tx).to.emit(vault, "Staked").withArgs(
        alice.address,
        tokenId,
        TICK_LOWER,
        TICK_UPPER,
        USDC_USED + ASSET_USED,
        ts
      );
      expect(await vault.stakerOf(tokenId)).to.equal(alice.address);
      expect(await nfpm.ownerOf(tokenId)).to.equal(vaultAddr);

      // exactly `USDC_IN` left the caller, minus what came straight back
      expect(usdcBefore - (await usdc.balanceOf(alice.address))).to.equal(USDC_IN - USDC_REFUND);
      expect((await asset.balanceOf(alice.address)) - assetBefore).to.equal(ASSET_REFUND);
      expect(USDC_REFUND).to.be.gt(0n);
      expect(ASSET_REFUND).to.be.gt(0n);

      // the minted range carries both sides
      const position = await nfpm.positions(tokenId);
      expect(position.tickLower).to.equal(TICK_LOWER);
      expect(position.tickUpper).to.equal(TICK_UPPER);
      expect(position.fee).to.equal(FEE);

      await expectZapperDrained();
    });

    it("routes the swap USDC -> ASSET through the configured fee tier", async function () {
      await zap.connect(alice).zapIn(USDC_IN, TICK_LOWER, TICK_UPPER, swapParams(), FAR_DEADLINE);

      expect(await router.swapCalls()).to.equal(1n);
      expect(await router.lastTokenIn()).to.equal(usdcAddr);
      expect(await router.lastTokenOut()).to.equal(assetAddr);
      expect(await router.lastFee()).to.equal(FEE);
      expect(await router.lastRecipient()).to.equal(zapAddr);
      expect(await router.lastAmountIn()).to.equal(SWAP_IN);
      expect(await router.lastAmountOutMinimum()).to.equal(SWAP_OUT);
      expect(await usdc.allowance(zapAddr, routerAddr)).to.equal(0n);
    });

    it("mints single-sided and never calls the router when amountIn is zero", async function () {
      const usdcBefore = await usdc.balanceOf(alice.address);
      const singleSidedUsed = (USDC_IN * CONSUME_BPS) / 10_000n;

      const tokenId = await zap
        .connect(alice)
        .zapIn.staticCall(
          USDC_IN,
          TICK_LOWER,
          TICK_UPPER,
          swapParams({ amountIn: 0n, amountOutMin: 0n }),
          FAR_DEADLINE
        );
      const tx = await zap
        .connect(alice)
        .zapIn(USDC_IN, TICK_LOWER, TICK_UPPER, swapParams({ amountIn: 0n, amountOutMin: 0n }), FAR_DEADLINE);
      const ts = await txTimestamp(tx);

      expect(await router.swapCalls()).to.equal(0n);
      await expect(tx)
        .to.emit(zap, "ZappedIn")
        .withArgs(alice.address, tokenId, USDC_IN, USDC_IN - singleSidedUsed, 0n, ts);
      expect(await vault.stakerOf(tokenId)).to.equal(alice.address);
      expect(usdcBefore - (await usdc.balanceOf(alice.address))).to.equal(singleSidedUsed);
      await expectZapperDrained();
    });

    it("rejects a zero amount", async function () {
      await expect(
        zap.connect(alice).zapIn(0, TICK_LOWER, TICK_UPPER, swapParams(), FAR_DEADLINE)
      ).to.be.revertedWithCustomError(zap, "ZeroAmount");
    });

    it("rejects a swap larger than the pulled amount, before any value moves", async function () {
      const tooMuch = USDC_IN + 1n;

      await expect(
        zap
          .connect(alice)
          .zapIn(USDC_IN, TICK_LOWER, TICK_UPPER, swapParams({ amountIn: tooMuch }), FAR_DEADLINE)
      )
        .to.be.revertedWithCustomError(zap, "SwapAmountExceedsInput")
        .withArgs(tooMuch, USDC_IN);

      expect(await usdc.balanceOf(zapAddr)).to.equal(0n);
      expect(await router.swapCalls()).to.equal(0n);
    });

    it("rejects the wrong swap direction", async function () {
      await expect(
        zap
          .connect(alice)
          .zapIn(USDC_IN, TICK_LOWER, TICK_UPPER, swapParams({ zeroForOne: !usdcIsToken0 }), FAR_DEADLINE)
      )
        .to.be.revertedWithCustomError(zap, "InvalidSwapDirection")
        .withArgs(!usdcIsToken0, usdcIsToken0);
    });

    it("blocks the zap when spot has drifted too far from the TWAP", async function () {
      await pool.setTicks(MAX_DEVIATION_BPS + 1, 0);

      await expect(
        zap.connect(alice).zapIn(USDC_IN, TICK_LOWER, TICK_UPPER, swapParams(), FAR_DEADLINE)
      )
        .to.be.revertedWithCustomError(zap, "TwapDeviationTooHigh")
        .withArgs(MAX_DEVIATION_BPS + 1, 0, MAX_DEVIATION_BPS);

      // ...and lets it through again once spot is back inside the band
      await pool.setTicks(MAX_DEVIATION_BPS, 0);
      await expect(
        zap.connect(alice).zapIn(USDC_IN, TICK_LOWER, TICK_UPPER, swapParams(), FAR_DEADLINE)
      ).to.emit(zap, "ZappedIn");
    });

    it("enforces the caller's swap and mint minimums", async function () {
      await expect(
        zap
          .connect(alice)
          .zapIn(
            USDC_IN,
            TICK_LOWER,
            TICK_UPPER,
            swapParams({ amountOutMin: SWAP_OUT + 1n }),
            FAR_DEADLINE
          )
      ).to.be.revertedWith("Too little received");

      const usdcMinKey = usdcIsToken0 ? "amount0Min" : "amount1Min";
      await expect(
        zap
          .connect(alice)
          .zapIn(
            USDC_IN,
            TICK_LOWER,
            TICK_UPPER,
            swapParams({ [usdcMinKey]: USDC_USED + 1n }),
            FAR_DEADLINE
          )
      ).to.be.revertedWith("Price slippage check");
    });

    it("bubbles NotZapper when the vault has not whitelisted this zapper", async function () {
      await vault.setZapper(ZERO);

      await expect(zap.connect(alice).zapIn(USDC_IN, TICK_LOWER, TICK_UPPER, swapParams(), FAR_DEADLINE))
        .to.be.revertedWithCustomError(vault, "NotZapper")
        .withArgs(zapAddr, ZERO);
    });

    it("bubbles DepositsArePaused from the vault", async function () {
      await vault.setDepositsPaused(true);

      await expect(
        zap.connect(alice).zapIn(USDC_IN, TICK_LOWER, TICK_UPPER, swapParams(), FAR_DEADLINE)
      ).to.be.revertedWithCustomError(vault, "DepositsArePaused");
    });

    it("reverts without a USDC allowance", async function () {
      await usdc.connect(alice).approve(zapAddr, 0);

      await expect(
        zap.connect(alice).zapIn(USDC_IN, TICK_LOWER, TICK_UPPER, swapParams(), FAR_DEADLINE)
      ).to.be.revertedWithCustomError(usdc, "ERC20InsufficientAllowance");
    });

    it("refunds any stranded balance to whoever zaps next", async function () {
      // dust the owner would otherwise recover through `sweep`
      const stranded = USDC(5);
      await usdc.transfer(zapAddr, stranded);

      const before = await usdc.balanceOf(alice.address);
      await zap.connect(alice).zapIn(USDC_IN, TICK_LOWER, TICK_UPPER, swapParams(), FAR_DEADLINE);

      // the mint consumes a share of the stranded amount too, and the rest is refunded to
      // this caller rather than staying available to `sweep`
      const consumed = ((USDC_IN - SWAP_IN + stranded) * CONSUME_BPS) / 10_000n;
      expect(before - (await usdc.balanceOf(alice.address))).to.equal(USDC_IN - (USDC_IN - SWAP_IN + stranded - consumed));
      await expectZapperDrained();
    });

    it("refunds only the ASSET side when the whole input is swapped", async function () {
      // Nothing is left on the USDC side to refund, so `_refundDust` takes its ASSET-only
      // arm — the mirror of the amountIn == 0 case above, which takes the USDC-only arm.
      const swapAll = swapParams({ amountIn: USDC_IN, amountOutMin: ASSET(1000) });
      const assetRefund = ASSET(1000) - (ASSET(1000) * CONSUME_BPS) / 10_000n;

      const tokenId = await zap
        .connect(alice)
        .zapIn.staticCall(USDC_IN, TICK_LOWER, TICK_UPPER, swapAll, FAR_DEADLINE);
      const tx = await zap.connect(alice).zapIn(USDC_IN, TICK_LOWER, TICK_UPPER, swapAll, FAR_DEADLINE);
      const ts = await txTimestamp(tx);

      await expect(tx)
        .to.emit(zap, "ZappedIn")
        .withArgs(alice.address, tokenId, USDC_IN, 0n, assetRefund, ts);

      expect(assetRefund).to.be.gt(0n);
      expect(await vault.stakerOf(tokenId)).to.equal(alice.address);
      await expectZapperDrained();
    });

    it("bubbles the pool's own revert when the swap leg cannot read the oracle", async function () {
      await pool.setObserveReverts(true);

      await expect(
        zap.connect(alice).zapIn(USDC_IN, TICK_LOWER, TICK_UPPER, swapParams(), FAR_DEADLINE)
      ).to.be.revertedWith("OLD");

      // a zap with no swap leg never asks the oracle, so a dead oracle does not close the door
      await expect(
        zap
          .connect(alice)
          .zapIn(
            USDC_IN,
            TICK_LOWER,
            TICK_UPPER,
            swapParams({ amountIn: 0n, amountOutMin: 0n }),
            FAR_DEADLINE
          )
      ).to.emit(zap, "ZappedIn");
    });

    it("measures the deviation against the floored TWAP tick, not the truncated one", async function () {
      // -301 tick-seconds over a 300 s window is a true mean of -1.0033: floored it is -2,
      // truncated it is -1. At spot 499 the two readings give opposite verdicts, so this
      // pins which one the guard actually used.
      await zap.setTwapParams(300, MAX_DEVIATION_BPS);
      await pool.setTickCumulatives([0, -301]);

      await pool.setCurrentTick(499);
      await expect(zap.connect(alice).zapIn(USDC_IN, TICK_LOWER, TICK_UPPER, swapParams(), FAR_DEADLINE))
        .to.be.revertedWithCustomError(zap, "TwapDeviationTooHigh")
        .withArgs(499, -2, MAX_DEVIATION_BPS);

      // one tick closer is exactly the ceiling away from -2, and the ceiling is inclusive
      await pool.setCurrentTick(498);
      await expect(
        zap.connect(alice).zapIn(USDC_IN, TICK_LOWER, TICK_UPPER, swapParams(), FAR_DEADLINE)
      ).to.emit(zap, "ZappedIn");
    });

    it("holds no USDC or ASSET across repeated zaps", async function () {
      for (let i = 0; i < 3; i++) {
        await zap.connect(alice).zapIn(USDC_IN, TICK_LOWER, TICK_UPPER, swapParams(), FAR_DEADLINE);
        await expectZapperDrained();
      }
      expect(await nfpm.balanceOf(zapAddr)).to.equal(0n);
      expect(await nfpm.balanceOf(vaultAddr)).to.equal(3n);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("zapInWithPermit", function () {
    it("grants the allowance from the signature and then zaps", async function () {
      await usdc.connect(alice).approve(zapAddr, 0);
      const signature = await signPermit(alice, zapAddr, USDC_IN, FAR_DEADLINE);

      const tokenId = await zap
        .connect(alice)
        .zapInWithPermit.staticCall(USDC_IN, TICK_LOWER, TICK_UPPER, swapParams(), FAR_DEADLINE, {
          value: USDC_IN,
          deadline: FAR_DEADLINE,
          v: signature.v,
          r: signature.r,
          s: signature.s,
        });

      const tx = await zap
        .connect(alice)
        .zapInWithPermit(USDC_IN, TICK_LOWER, TICK_UPPER, swapParams(), FAR_DEADLINE, {
          value: USDC_IN,
          deadline: FAR_DEADLINE,
          v: signature.v,
          r: signature.r,
          s: signature.s,
        });

      await expect(tx).to.emit(zap, "ZappedIn");
      expect(await vault.stakerOf(tokenId)).to.equal(alice.address);
      expect(await usdc.nonces(alice.address)).to.equal(1n);
      await expectZapperDrained();
    });

    it("skips the permit when the allowance already covers it", async function () {
      // alice keeps her standing MaxUint256 approval from the fixture, so a garbage
      // signature must never be submitted — the griefing front-run case.
      const garbage = { value: USDC_IN, deadline: FAR_DEADLINE, v: 27, r: ethers.ZeroHash, s: ethers.ZeroHash };

      await expect(
        zap
          .connect(alice)
          .zapInWithPermit(USDC_IN, TICK_LOWER, TICK_UPPER, swapParams(), FAR_DEADLINE, garbage)
      ).to.emit(zap, "ZappedIn");

      expect(await usdc.nonces(alice.address)).to.equal(0n);
      await expectZapperDrained();
    });

    it("submits the permit, and fails on it, when the allowance is short", async function () {
      await usdc.connect(alice).approve(zapAddr, USDC_IN - 1n);
      const garbage = { value: USDC_IN, deadline: FAR_DEADLINE, v: 27, r: ethers.ZeroHash, s: ethers.ZeroHash };

      await expect(
        zap
          .connect(alice)
          .zapInWithPermit(USDC_IN, TICK_LOWER, TICK_UPPER, swapParams(), FAR_DEADLINE, garbage)
      ).to.be.revertedWithCustomError(usdc, "ECDSAInvalidSignature");
    });

    it("bubbles an expired permit", async function () {
      await usdc.connect(alice).approve(zapAddr, 0);
      const deadline = BigInt(await time.latest()) - 1n;
      const signature = await signPermit(alice, zapAddr, USDC_IN, deadline);

      await expect(
        zap.connect(alice).zapInWithPermit(USDC_IN, TICK_LOWER, TICK_UPPER, swapParams(), FAR_DEADLINE, {
          value: USDC_IN,
          deadline,
          v: signature.v,
          r: signature.r,
          s: signature.s,
        })
      ).to.be.revertedWithCustomError(usdc, "ERC2612ExpiredSignature");
    });

    it("bubbles NotZapper when the vault has not whitelisted this zapper", async function () {
      await vault.setZapper(ZERO);
      await usdc.connect(alice).approve(zapAddr, 0);
      const signature = await signPermit(alice, zapAddr, USDC_IN, FAR_DEADLINE);

      await expect(
        zap.connect(alice).zapInWithPermit(USDC_IN, TICK_LOWER, TICK_UPPER, swapParams(), FAR_DEADLINE, {
          value: USDC_IN,
          deadline: FAR_DEADLINE,
          v: signature.v,
          r: signature.r,
          s: signature.s,
        })
      )
        .to.be.revertedWithCustomError(vault, "NotZapper")
        .withArgs(zapAddr, ZERO);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("onERC721Received", function () {
    it("rejects a direct call from anything but the position manager", async function () {
      await expect(zap.connect(alice).onERC721Received(alice.address, alice.address, 1, "0x"))
        .to.be.revertedWithCustomError(zap, "UnexpectedNftSender")
        .withArgs(alice.address);
    });

    it("accepts a mint that calls back, so a callback-ing position manager still works", async function () {
      await nfpm.setSafeMintEnabled(true);

      await expect(
        zap.connect(alice).zapIn(USDC_IN, TICK_LOWER, TICK_UPPER, swapParams(), FAR_DEADLINE)
      ).to.emit(zap, "ZappedIn");
    });

    it("rejects a genuine position pushed in outside a zap", async function () {
      const tokenId = await createPosition(alice);

      await expect(
        nfpm.connect(alice)["safeTransferFrom(address,address,uint256)"](alice.address, zapAddr, tokenId)
      )
        .to.be.revertedWithCustomError(zap, "UnsolicitedPosition")
        .withArgs(alice.address, alice.address, tokenId);
    });

    it("closes the receipt window again after a zap", async function () {
      await nfpm.setSafeMintEnabled(true);
      await zap.connect(alice).zapIn(USDC_IN, TICK_LOWER, TICK_UPPER, swapParams(), FAR_DEADLINE);

      const tokenId = await createPosition(bob);
      await expect(
        nfpm.connect(bob)["safeTransferFrom(address,address,uint256)"](bob.address, zapAddr, tokenId)
      ).to.be.revertedWithCustomError(zap, "UnsolicitedPosition");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Admin", function () {
    it("retunes the TWAP parameters, owner only and within bounds", async function () {
      await expect(zap.connect(alice).setTwapParams(1200, 100)).to.be.revertedWithCustomError(
        zap,
        "OwnableUnauthorizedAccount"
      );

      await expect(zap.setTwapParams(1200, 100)).to.emit(zap, "TwapParamsSet").withArgs(1200, 100);
      expect(await zap.twapWindow()).to.equal(1200);
      expect(await zap.maxTwapDeviationBps()).to.equal(100);

      await expect(zap.setTwapParams(299, 100))
        .to.be.revertedWithCustomError(zap, "InvalidTwapWindow")
        .withArgs(299, 300);
      await expect(zap.setTwapParams(1200, 2001))
        .to.be.revertedWithCustomError(zap, "InvalidTwapDeviation")
        .withArgs(2001, 2000);
    });

    it("sweeps stranded dust, owner only and never to the zero address", async function () {
      await usdc.transfer(zapAddr, USDC(5));

      await expect(zap.connect(alice).sweep(usdcAddr, USDC(5), alice.address)).to.be.revertedWithCustomError(
        zap,
        "OwnableUnauthorizedAccount"
      );
      await expect(zap.sweep(usdcAddr, USDC(5), ZERO)).to.be.revertedWithCustomError(zap, "ZeroAddress");

      const before = await usdc.balanceOf(bob.address);
      await expect(zap.sweep(usdcAddr, USDC(5), bob.address))
        .to.emit(zap, "Swept")
        .withArgs(usdcAddr, bob.address, USDC(5));

      expect((await usdc.balanceOf(bob.address)) - before).to.equal(USDC(5));
      await expectZapperDrained();
    });

    it("sweeps a zero amount and logs it, because sweep guards only the recipient", async function () {
      // The only stated guard is `to == address(0)`; a zero amount is a no-op transfer that
      // still emits, unlike `RewardsDistributor.recoverExcessAsset`, which rejects zero.
      const before = await usdc.balanceOf(bob.address);

      await expect(zap.sweep(usdcAddr, 0n, bob.address))
        .to.emit(zap, "Swept")
        .withArgs(usdcAddr, bob.address, 0n);

      expect(await usdc.balanceOf(bob.address)).to.equal(before);
    });

    it("refuses to sweep an address with no code, or a token whose transfer returns false", async function () {
      // `sweep` takes any address, so SafeERC20 is the whole defence here.
      await expect(zap.sweep(ZERO, USDC(1), bob.address))
        .to.be.revertedWithCustomError(zap, "SafeERC20FailedOperation")
        .withArgs(ZERO);

      const Silent = await ethers.getContractFactory("MockReturnsFalseERC20");
      const silent = await Silent.deploy("Silent", "SILENT", USDC(1000), 6);
      const silentAddr = await silent.getAddress();

      await expect(zap.sweep(silentAddr, USDC(1), bob.address))
        .to.be.revertedWithCustomError(zap, "SafeERC20FailedOperation")
        .withArgs(silentAddr);
    });

    it("cannot sweep more than the contract holds", async function () {
      await expect(zap.sweep(usdcAddr, USDC(1), stranger.address)).to.be.revertedWithCustomError(
        usdc,
        "ERC20InsufficientBalance"
      );
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("rescuePosition", function () {
    /// A plain `transferFrom` never consults `onERC721Received`, so this is the one way an
    /// NFT can still land on the zapper now that the hook rejects unsolicited receipts.
    async function pushStrayPosition(holder) {
      const tokenId = await createPosition(holder);
      await nfpm.connect(holder).transferFrom(holder.address, zapAddr, tokenId);
      expect(await nfpm.ownerOf(tokenId)).to.equal(zapAddr);
      return tokenId;
    }

    it("sends a stray position NFT to the owner and logs it", async function () {
      const tokenId = await pushStrayPosition(alice);

      const tx = await zap.rescuePosition(tokenId);
      const ts = await txTimestamp(tx);

      await expect(tx).to.emit(zap, "PositionRescued").withArgs(tokenId, owner.address, ts);
      expect(await nfpm.ownerOf(tokenId)).to.equal(owner.address);
      expect(await nfpm.balanceOf(zapAddr)).to.equal(0n);
    });

    it("goes to the owner and nowhere else, even after ownership moves", async function () {
      const tokenId = await pushStrayPosition(alice);
      await zap.transferOwnership(bob.address);

      await expect(zap.rescuePosition(tokenId)).to.be.revertedWithCustomError(
        zap,
        "OwnableUnauthorizedAccount"
      );

      const tx = await zap.connect(bob).rescuePosition(tokenId);
      await expect(tx).to.emit(zap, "PositionRescued").withArgs(tokenId, bob.address, await txTimestamp(tx));
      expect(await nfpm.ownerOf(tokenId)).to.equal(bob.address);
    });

    it("is owner only", async function () {
      const tokenId = await pushStrayPosition(alice);

      await expect(zap.connect(alice).rescuePosition(tokenId)).to.be.revertedWithCustomError(
        zap,
        "OwnableUnauthorizedAccount"
      );
      expect(await nfpm.ownerOf(tokenId)).to.equal(zapAddr);
    });

    it("reverts when the zapper does not hold the NFT", async function () {
      // the zapper holds no position between transactions, so this is the normal state
      const tokenId = await createPosition(alice);

      await expect(zap.rescuePosition(tokenId))
        .to.be.revertedWithCustomError(nfpm, "ERC721InsufficientApproval")
        .withArgs(zapAddr, tokenId);
    });

    it("cannot reach a position the zap already handed to the vault", async function () {
      const tokenId = await zap
        .connect(alice)
        .zapIn.staticCall(USDC_IN, TICK_LOWER, TICK_UPPER, swapParams(), FAR_DEADLINE);
      await zap.connect(alice).zapIn(USDC_IN, TICK_LOWER, TICK_UPPER, swapParams(), FAR_DEADLINE);

      expect(await nfpm.ownerOf(tokenId)).to.equal(vaultAddr);
      await expect(zap.rescuePosition(tokenId)).to.be.revertedWithCustomError(
        nfpm,
        "ERC721InsufficientApproval"
      );
    });
  });
});
