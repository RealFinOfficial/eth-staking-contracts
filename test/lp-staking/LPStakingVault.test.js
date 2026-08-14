const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("LPStakingVault", function () {
  let vault, pool, nfpm, router;
  let token0, token1;
  let owner, alice, bob, zapper, stranger;

  let vaultAddr, poolAddr, nfpmAddr, routerAddr, token0Addr, token1Addr;
  let unit0, unit1;
  let P0, P1, FEES0, FEES1;

  const FEE = 3000;
  const OTHER_FEE = 500;
  const TWAP_WINDOW = 600;
  const MAX_DEVIATION_BPS = 500;
  const TICK_LOWER = -600;
  const TICK_UPPER = 600;
  const NEW_TICK_LOWER = -1200;
  const NEW_TICK_UPPER = -600;
  const LIQUIDITY = 1_000_000n;
  const FAR_DEADLINE = 10n ** 12n;
  const ZERO = ethers.ZeroAddress;

  // ReentrantAttacker.Mode
  const MODE_UNSTAKE = 1;
  const MODE_REBALANCE = 2;

  const NO_SWAP = {
    zeroForOne: true,
    amountIn: 0n,
    amountOutMin: 0n,
    amount0Min: 0n,
    amount1Min: 0n,
  };

  async function txTimestamp(tx) {
    const receipt = await tx.wait();
    return (await ethers.provider.getBlock(receipt.blockNumber)).timestamp;
  }

  async function deployVault(overrides = {}) {
    const args = {
      positionManager: nfpmAddr,
      pool: poolAddr,
      token0: token0Addr,
      token1: token1Addr,
      fee: FEE,
      swapRouter: routerAddr,
      initialOwner: owner.address,
      twapWindow: TWAP_WINDOW,
      maxDeviationBps: MAX_DEVIATION_BPS,
      ...overrides,
    };
    const Vault = await ethers.getContractFactory("LPStakingVault");
    return Vault.deploy(
      args.positionManager,
      args.pool,
      args.token0,
      args.token1,
      args.fee,
      args.swapRouter,
      args.initialOwner,
      args.twapWindow,
      args.maxDeviationBps
    );
  }

  /// Fabricates a position NFT for `holder` and funds the position manager so a later
  /// collect can really pay the principal out.
  async function createPosition(holder, opts = {}) {
    const {
      tickLower = TICK_LOWER,
      tickUpper = TICK_UPPER,
      liquidity = LIQUIDITY,
      principal0 = P0,
      principal1 = P1,
      poolToken0 = token0Addr,
      poolToken1 = token1Addr,
      poolFee = FEE,
      approve = true,
    } = opts;

    await nfpm.mintFake(
      holder.address,
      poolToken0,
      poolToken1,
      poolFee,
      tickLower,
      tickUpper,
      liquidity,
      principal0,
      principal1
    );
    const tokenId = await nfpm.lastMintedId();

    if (poolToken0 === token0Addr && principal0 > 0n) await token0.transfer(nfpmAddr, principal0);
    if (poolToken1 === token1Addr && principal1 > 0n) await token1.transfer(nfpmAddr, principal1);
    if (approve) await nfpm.connect(holder).approve(vaultAddr, tokenId);

    return tokenId;
  }

  async function stakePosition(holder, opts = {}) {
    const tokenId = await createPosition(holder, opts);
    await vault.connect(holder).stake(tokenId);
    return tokenId;
  }

  beforeEach(async function () {
    [owner, alice, bob, zapper, stranger] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockERC20Decimals");
    const usdc = await Token.deploy("USD Coin", "USDC", 1_000_000n * 10n ** 6n, 6);
    const asset = await Token.deploy("Asset", "ASSET", 1_000_000n * 10n ** 18n, 18);

    // Uniswap sorts the pair ascending by address, so which of USDC(6) and ASSET(18) ends up
    // as token0 is an accident of deployment order. The vault is token-agnostic, so the
    // tests speak token0/token1 and derive every amount from that token's own decimals.
    const sorted =
      (await usdc.getAddress()).toLowerCase() < (await asset.getAddress()).toLowerCase()
        ? [usdc, asset]
        : [asset, usdc];
    token0 = sorted[0];
    token1 = sorted[1];
    token0Addr = await token0.getAddress();
    token1Addr = await token1.getAddress();

    unit0 = 10n ** BigInt(await token0.decimals());
    unit1 = 10n ** BigInt(await token1.decimals());
    P0 = 1000n * unit0;
    P1 = 1000n * unit1;
    FEES0 = 10n * unit0;
    FEES1 = 10n * unit1;

    const Pool = await ethers.getContractFactory("MockUniswapV3Pool");
    pool = await Pool.deploy(token0Addr, token1Addr, FEE);
    poolAddr = await pool.getAddress();

    const Nfpm = await ethers.getContractFactory("MockPositionManager");
    nfpm = await Nfpm.deploy();
    nfpmAddr = await nfpm.getAddress();

    const Router = await ethers.getContractFactory("MockSwapRouter");
    router = await Router.deploy();
    routerAddr = await router.getAddress();

    // 1:1 in whole units, in both directions, plus inventory to pay from.
    await router.setRate(token0Addr, token1Addr, unit1, unit0);
    await router.setRate(token1Addr, token0Addr, unit0, unit1);
    await token0.transfer(routerAddr, 100_000n * unit0);
    await token1.transfer(routerAddr, 100_000n * unit1);

    vault = await deployVault();
    vaultAddr = await vault.getAddress();
  });

  // ─────────────────────────────────────────────────────────────
  describe("Deployment", function () {
    it("stores the pool triple and emits TwapParamsSet with the initial parameters", async function () {
      expect(await vault.positionManager()).to.equal(nfpmAddr);
      expect(await vault.swapRouter()).to.equal(routerAddr);
      expect(await vault.pool()).to.equal(poolAddr);
      expect(await vault.token0()).to.equal(token0Addr);
      expect(await vault.token1()).to.equal(token1Addr);
      expect(await vault.fee()).to.equal(FEE);
      expect(await vault.owner()).to.equal(owner.address);
      expect(await vault.twapWindow()).to.equal(TWAP_WINDOW);
      expect(await vault.maxTwapDeviationBps()).to.equal(MAX_DEVIATION_BPS);
      expect(await vault.depositsPaused()).to.equal(false);
      expect(await vault.zapper()).to.equal(ZERO);

      await expect(vault.deploymentTransaction())
        .to.emit(vault, "TwapParamsSet")
        .withArgs(TWAP_WINDOW, MAX_DEVIATION_BPS);
    });

    it("rejects a zero position manager, swap router or pool token", async function () {
      await expect(deployVault({ positionManager: ZERO })).to.be.revertedWithCustomError(
        vault,
        "ZeroAddress"
      );
      await expect(deployVault({ swapRouter: ZERO })).to.be.revertedWithCustomError(
        vault,
        "ZeroAddress"
      );
      await expect(deployVault({ token0: ZERO })).to.be.revertedWithCustomError(vault, "ZeroAddress");
      await expect(deployVault({ token1: ZERO })).to.be.revertedWithCustomError(vault, "ZeroAddress");
    });

    it("rejects a zero pool in the TWAP guard, which runs before the vault's own checks", async function () {
      await expect(deployVault({ pool: ZERO })).to.be.revertedWithCustomError(vault, "InvalidPool");
    });

    it("rejects an unsorted token pair", async function () {
      await expect(deployVault({ token0: token1Addr, token1: token0Addr }))
        .to.be.revertedWithCustomError(vault, "TokensNotSorted")
        .withArgs(token1Addr, token0Addr);
    });

    it("rejects a pool whose triple is not the configured one", async function () {
      const Pool = await ethers.getContractFactory("MockUniswapV3Pool");

      const wrongFeePool = await Pool.deploy(token0Addr, token1Addr, OTHER_FEE);
      await expect(deployVault({ pool: await wrongFeePool.getAddress() }))
        .to.be.revertedWithCustomError(vault, "PoolMismatch")
        .withArgs(token0Addr, token1Addr, OTHER_FEE);

      const Token = await ethers.getContractFactory("MockERC20Decimals");
      const other = await Token.deploy("Other", "OTHER", 1000n, 18);
      const wrongTokenPool = await Pool.deploy(token0Addr, await other.getAddress(), FEE);
      await expect(deployVault({ pool: await wrongTokenPool.getAddress() }))
        .to.be.revertedWithCustomError(vault, "PoolMismatch")
        .withArgs(token0Addr, await other.getAddress(), FEE);
    });

    it("enforces the TWAP window floor", async function () {
      await expect(deployVault({ twapWindow: 299 }))
        .to.be.revertedWithCustomError(vault, "InvalidTwapWindow")
        .withArgs(299, 300);

      const atFloor = await deployVault({ twapWindow: 300 });
      expect(await atFloor.twapWindow()).to.equal(300);
    });

    it("enforces the TWAP deviation bounds on both sides", async function () {
      await expect(deployVault({ maxDeviationBps: 0 }))
        .to.be.revertedWithCustomError(vault, "InvalidTwapDeviation")
        .withArgs(0, 2000);

      await expect(deployVault({ maxDeviationBps: 2001 }))
        .to.be.revertedWithCustomError(vault, "InvalidTwapDeviation")
        .withArgs(2001, 2000);

      const atCeiling = await deployVault({ maxDeviationBps: 2000 });
      expect(await atCeiling.maxTwapDeviationBps()).to.equal(2000);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("stake", function () {
    it("takes custody, records the staker and emits the full range state", async function () {
      const tokenId = await createPosition(alice);

      const tx = await vault.connect(alice).stake(tokenId);
      const ts = await txTimestamp(tx);

      await expect(tx)
        .to.emit(vault, "Staked")
        .withArgs(alice.address, tokenId, TICK_LOWER, TICK_UPPER, LIQUIDITY, ts);

      expect(await nfpm.ownerOf(tokenId)).to.equal(vaultAddr);
      expect(await vault.stakerOf(tokenId)).to.equal(alice.address);
    });

    it("rejects a position from another fee tier", async function () {
      const tokenId = await createPosition(alice, { poolFee: OTHER_FEE });

      await expect(vault.connect(alice).stake(tokenId))
        .to.be.revertedWithCustomError(vault, "PositionPoolMismatch")
        .withArgs(tokenId, token0Addr, token1Addr, OTHER_FEE);
    });

    it("rejects a position from another token pair", async function () {
      const Token = await ethers.getContractFactory("MockERC20Decimals");
      const other = await Token.deploy("Other", "OTHER", 1000n, 18);
      const otherAddr = await other.getAddress();

      const tokenId = await createPosition(alice, {
        poolToken1: otherAddr,
        principal0: 0n,
        principal1: 0n,
      });

      await expect(vault.connect(alice).stake(tokenId))
        .to.be.revertedWithCustomError(vault, "PositionPoolMismatch")
        .withArgs(tokenId, token0Addr, otherAddr, FEE);
    });

    it("rejects an empty position", async function () {
      const tokenId = await createPosition(alice, { liquidity: 0n });

      await expect(vault.connect(alice).stake(tokenId))
        .to.be.revertedWithCustomError(vault, "EmptyPosition")
        .withArgs(tokenId);
    });

    it("rejects a second stake of the same tokenId", async function () {
      const tokenId = await stakePosition(alice);

      await expect(vault.connect(bob).stake(tokenId))
        .to.be.revertedWithCustomError(vault, "AlreadyStaked")
        .withArgs(tokenId, alice.address);
    });

    it("rejects a stake while deposits are paused", async function () {
      const tokenId = await createPosition(alice);
      await vault.setDepositsPaused(true);

      await expect(vault.connect(alice).stake(tokenId)).to.be.revertedWithCustomError(
        vault,
        "DepositsArePaused"
      );
    });

    it("reverts when the vault was never approved for the NFT", async function () {
      const tokenId = await createPosition(alice, { approve: false });

      await expect(vault.connect(alice).stake(tokenId)).to.be.revertedWithCustomError(
        nfpm,
        "ERC721InsufficientApproval"
      );
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("stakeWithPermit", function () {
    it("consumes the permit and then stakes with no prior approval", async function () {
      const tokenId = await createPosition(alice, { approve: false });

      const tx = await vault
        .connect(alice)
        .stakeWithPermit(tokenId, FAR_DEADLINE, 27, ethers.ZeroHash, ethers.ZeroHash);
      const ts = await txTimestamp(tx);

      await expect(tx)
        .to.emit(vault, "Staked")
        .withArgs(alice.address, tokenId, TICK_LOWER, TICK_UPPER, LIQUIDITY, ts);

      expect(await nfpm.permitCalls()).to.equal(1n);
      expect(await vault.stakerOf(tokenId)).to.equal(alice.address);
      expect(await nfpm.ownerOf(tokenId)).to.equal(vaultAddr);
    });

    it("bubbles a failing permit", async function () {
      const tokenId = await createPosition(alice, { approve: false });
      await nfpm.setPermitShouldFail(true);

      await expect(
        vault.connect(alice).stakeWithPermit(tokenId, FAR_DEADLINE, 27, ethers.ZeroHash, ethers.ZeroHash)
      ).to.be.revertedWith("Permit failed");

      expect(await vault.stakerOf(tokenId)).to.equal(ZERO);
      expect(await nfpm.ownerOf(tokenId)).to.equal(alice.address);
    });

    it("bubbles an expired permit", async function () {
      const tokenId = await createPosition(alice, { approve: false });

      await expect(
        vault.connect(alice).stakeWithPermit(tokenId, 1, 27, ethers.ZeroHash, ethers.ZeroHash)
      ).to.be.revertedWith("Permit expired");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("stakeFor", function () {
    it("rejects every caller while no zapper is configured", async function () {
      const tokenId = await createPosition(alice);

      await expect(vault.connect(alice).stakeFor(alice.address, tokenId))
        .to.be.revertedWithCustomError(vault, "NotZapper")
        .withArgs(alice.address, ZERO);
    });

    it("rejects a caller that is not the configured zapper", async function () {
      await vault.setZapper(zapper.address);
      const tokenId = await createPosition(bob);

      await expect(vault.connect(bob).stakeFor(bob.address, tokenId))
        .to.be.revertedWithCustomError(vault, "NotZapper")
        .withArgs(bob.address, zapper.address);
    });

    it("rejects a zero user", async function () {
      await vault.setZapper(zapper.address);
      const tokenId = await createPosition(zapper);

      await expect(vault.connect(zapper).stakeFor(ZERO, tokenId)).to.be.revertedWithCustomError(
        vault,
        "ZeroAddress"
      );
    });

    it("credits the passed user rather than the calling zapper", async function () {
      await vault.setZapper(zapper.address);
      const tokenId = await createPosition(zapper);

      const tx = await vault.connect(zapper).stakeFor(alice.address, tokenId);
      const ts = await txTimestamp(tx);

      await expect(tx)
        .to.emit(vault, "Staked")
        .withArgs(alice.address, tokenId, TICK_LOWER, TICK_UPPER, LIQUIDITY, ts);

      expect(await vault.stakerOf(tokenId)).to.equal(alice.address);
      expect(await nfpm.ownerOf(tokenId)).to.equal(vaultAddr);
    });

    it("is gated by the deposit pause like every other stake path", async function () {
      await vault.setZapper(zapper.address);
      const tokenId = await createPosition(zapper);
      await vault.setDepositsPaused(true);

      await expect(
        vault.connect(zapper).stakeFor(alice.address, tokenId)
      ).to.be.revertedWithCustomError(vault, "DepositsArePaused");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("unstake", function () {
    it("returns the NFT to its staker and clears the record", async function () {
      const tokenId = await stakePosition(alice);

      const tx = await vault.connect(alice).unstake(tokenId);
      const ts = await txTimestamp(tx);

      await expect(tx).to.emit(vault, "Unstaked").withArgs(alice.address, tokenId, ts);
      expect(await nfpm.ownerOf(tokenId)).to.equal(alice.address);
      expect(await vault.stakerOf(tokenId)).to.equal(ZERO);
    });

    it("rejects a caller that is not the staker", async function () {
      const tokenId = await stakePosition(alice);

      await expect(vault.connect(bob).unstake(tokenId))
        .to.be.revertedWithCustomError(vault, "NotStaker")
        .withArgs(tokenId, bob.address, alice.address);
    });

    it("rejects a tokenId that was never staked here", async function () {
      await expect(vault.connect(alice).unstake(999))
        .to.be.revertedWithCustomError(vault, "NotStaker")
        .withArgs(999, alice.address, ZERO);
    });

    it("stays open while deposits are paused (exits are never gated)", async function () {
      const tokenId = await stakePosition(alice);
      await vault.setDepositsPaused(true);

      await expect(vault.connect(alice).unstake(tokenId)).to.emit(vault, "Unstaked");
      expect(await nfpm.ownerOf(tokenId)).to.equal(alice.address);
    });

    it("cannot be replayed after the NFT has left", async function () {
      const tokenId = await stakePosition(alice);
      await vault.connect(alice).unstake(tokenId);

      await expect(vault.connect(alice).unstake(tokenId))
        .to.be.revertedWithCustomError(vault, "NotStaker")
        .withArgs(tokenId, alice.address, ZERO);
    });

    // A contract can always stake: the receipt hook is checked on the vault, not on the
    // depositor. The exit must therefore never demand a hook the depositor was never
    // required to have, or the position would be locked in the vault forever.
    describe("contract staker with no onERC721Received", function () {
      let staker, stakerAddr;

      beforeEach(async function () {
        const Staker = await ethers.getContractFactory("ContractStakerNoReceiver");
        staker = await Staker.deploy();
        stakerAddr = await staker.getAddress();
      });

      it("really has no receiver hook, so a safeTransferFrom to it reverts", async function () {
        const tokenId = await createPosition(alice);

        await expect(
          nfpm
            .connect(alice)
            ["safeTransferFrom(address,address,uint256)"](alice.address, stakerAddr, tokenId)
        )
          .to.be.revertedWithCustomError(nfpm, "ERC721InvalidReceiver")
          .withArgs(stakerAddr);
      });

      it("stakes and then unstakes, so the exit can never be blocked", async function () {
        const tokenId = await createPosition({ address: stakerAddr }, { approve: false });

        await staker.approveAndStake(vaultAddr, nfpmAddr, tokenId);
        expect(await nfpm.ownerOf(tokenId)).to.equal(vaultAddr);
        expect(await vault.stakerOf(tokenId)).to.equal(stakerAddr);

        const tx = await staker.unstake(vaultAddr, tokenId);
        const ts = await txTimestamp(tx);

        await expect(tx).to.emit(vault, "Unstaked").withArgs(stakerAddr, tokenId, ts);
        expect(await nfpm.ownerOf(tokenId)).to.equal(stakerAddr);
        expect(await vault.stakerOf(tokenId)).to.equal(ZERO);
      });
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("rebalance", function () {
    const CONSUME_BPS = 9000n;

    // Numbers for the happy path, all derived from the mock's own arithmetic.
    let swapIn, swapOut, collected0, collected1, preMint0, preMint1;
    let used0, used1, refund0, refund1, newLiquidity;

    async function primeHappyPath(tokenId) {
      await nfpm.setPendingFees(tokenId, FEES0, FEES1);
      await token0.transfer(nfpmAddr, FEES0);
      await token1.transfer(nfpmAddr, FEES1);
      await nfpm.setMintConsumeBps(CONSUME_BPS);
    }

    beforeEach(function () {
      swapIn = 500n * unit0;
      swapOut = (swapIn * unit1) / unit0;
      collected0 = P0 + FEES0;
      collected1 = P1 + FEES1;
      preMint0 = collected0 - swapIn;
      preMint1 = collected1 + swapOut;
      used0 = (preMint0 * CONSUME_BPS) / 10_000n;
      used1 = (preMint1 * CONSUME_BPS) / 10_000n;
      refund0 = preMint0 - used0;
      refund1 = preMint1 - used1;
      newLiquidity = used0 + used1;
    });

    function swapParams(overrides = {}) {
      return {
        zeroForOne: true,
        amountIn: swapIn,
        amountOutMin: swapOut,
        amount0Min: used0,
        amount1Min: used1,
        ...overrides,
      };
    }

    it("empties the old position, swaps, mints, refunds dust and burns the old NFT", async function () {
      const tokenId = await stakePosition(alice);
      await primeHappyPath(tokenId);

      const balance0Before = await token0.balanceOf(alice.address);
      const balance1Before = await token1.balanceOf(alice.address);

      const newTokenId = await vault
        .connect(alice)
        .rebalance.staticCall(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, swapParams(), FAR_DEADLINE);

      const tx = await vault
        .connect(alice)
        .rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, swapParams(), FAR_DEADLINE);
      const ts = await txTimestamp(tx);

      await expect(tx)
        .to.emit(vault, "Rebalanced")
        .withArgs(
          alice.address,
          tokenId,
          newTokenId,
          NEW_TICK_LOWER,
          NEW_TICK_UPPER,
          newLiquidity,
          refund0,
          refund1,
          ts
        );

      // the staker record moved, the old NFT no longer exists
      expect(await vault.stakerOf(tokenId)).to.equal(ZERO);
      expect(await vault.stakerOf(newTokenId)).to.equal(alice.address);
      expect(await nfpm.ownerOf(newTokenId)).to.equal(vaultAddr);
      await expect(nfpm.ownerOf(tokenId)).to.be.revertedWithCustomError(
        nfpm,
        "ERC721NonexistentToken"
      );

      // the new position carries the requested range and the compounded liquidity
      const position = await nfpm.positions(newTokenId);
      expect(position.token0).to.equal(token0Addr);
      expect(position.token1).to.equal(token1Addr);
      expect(position.fee).to.equal(FEE);
      expect(position.tickLower).to.equal(NEW_TICK_LOWER);
      expect(position.tickUpper).to.equal(NEW_TICK_UPPER);
      expect(position.liquidity).to.equal(newLiquidity);

      // dust of both tokens went back to the staker, nothing stayed behind
      expect((await token0.balanceOf(alice.address)) - balance0Before).to.equal(refund0);
      expect((await token1.balanceOf(alice.address)) - balance1Before).to.equal(refund1);
      expect(refund0).to.be.gt(0n);
      expect(refund1).to.be.gt(0n);
      expect(await token0.balanceOf(vaultAddr)).to.equal(0n);
      expect(await token1.balanceOf(vaultAddr)).to.equal(0n);
    });

    it("forwards the swap leg to the router with the configured pool fee", async function () {
      const tokenId = await stakePosition(alice);
      await primeHappyPath(tokenId);

      await vault
        .connect(alice)
        .rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, swapParams(), FAR_DEADLINE);

      expect(await router.swapCalls()).to.equal(1n);
      expect(await router.lastTokenIn()).to.equal(token0Addr);
      expect(await router.lastTokenOut()).to.equal(token1Addr);
      expect(await router.lastFee()).to.equal(FEE);
      expect(await router.lastRecipient()).to.equal(vaultAddr);
      expect(await router.lastAmountIn()).to.equal(swapIn);
      expect(await router.lastAmountOutMinimum()).to.equal(swapOut);
      expect(await router.lastSqrtPriceLimitX96()).to.equal(0n);

      // the router keeps no approval once the leg is done
      expect(await token0.allowance(vaultAddr, routerAddr)).to.equal(0n);
      expect(await token1.allowance(vaultAddr, routerAddr)).to.equal(0n);
    });

    it("swaps token1 for token0 when zeroForOne is false", async function () {
      const tokenId = await stakePosition(alice);
      await nfpm.setMintConsumeBps(10_000n);

      const amountIn = 400n * unit1;
      await vault.connect(alice).rebalance(
        tokenId,
        NEW_TICK_LOWER,
        NEW_TICK_UPPER,
        {
          zeroForOne: false,
          amountIn,
          amountOutMin: 0n,
          amount0Min: 0n,
          amount1Min: 0n,
        },
        FAR_DEADLINE
      );

      expect(await router.lastTokenIn()).to.equal(token1Addr);
      expect(await router.lastTokenOut()).to.equal(token0Addr);
      expect(await router.lastAmountIn()).to.equal(amountIn);
    });

    it("skips the router entirely when amountIn is zero", async function () {
      const tokenId = await stakePosition(alice);
      await nfpm.setMintConsumeBps(10_000n);

      const tx = await vault
        .connect(alice)
        .rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, NO_SWAP, FAR_DEADLINE);
      const ts = await txTimestamp(tx);
      const newTokenId = await nfpm.lastMintedId();

      expect(await router.swapCalls()).to.equal(0n);
      await expect(tx)
        .to.emit(vault, "Rebalanced")
        .withArgs(
          alice.address,
          tokenId,
          newTokenId,
          NEW_TICK_LOWER,
          NEW_TICK_UPPER,
          P0 + P1,
          0n,
          0n,
          ts
        );
      expect(await vault.stakerOf(newTokenId)).to.equal(alice.address);
    });

    it("skips the TWAP guard when there is no swap, even at a manipulated spot", async function () {
      const tokenId = await stakePosition(alice);
      await nfpm.setMintConsumeBps(10_000n);
      await pool.setTicks(50_000, 0);

      await expect(
        vault.connect(alice).rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, NO_SWAP, FAR_DEADLINE)
      ).to.emit(vault, "Rebalanced");
    });

    it("stays open while deposits are paused", async function () {
      const tokenId = await stakePosition(alice);
      await primeHappyPath(tokenId);
      await vault.setDepositsPaused(true);

      await expect(
        vault.connect(alice).rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, swapParams(), FAR_DEADLINE)
      ).to.emit(vault, "Rebalanced");
    });

    it("rejects a caller that is not the staker", async function () {
      const tokenId = await stakePosition(alice);

      await expect(
        vault.connect(bob).rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, NO_SWAP, FAR_DEADLINE)
      )
        .to.be.revertedWithCustomError(vault, "NotStaker")
        .withArgs(tokenId, bob.address, alice.address);
    });

    it("reverts when spot has drifted further from the TWAP than the ceiling allows", async function () {
      const tokenId = await stakePosition(alice);
      await primeHappyPath(tokenId);
      await pool.setTicks(MAX_DEVIATION_BPS + 1, 0);

      await expect(
        vault.connect(alice).rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, swapParams(), FAR_DEADLINE)
      )
        .to.be.revertedWithCustomError(vault, "TwapDeviationTooHigh")
        .withArgs(MAX_DEVIATION_BPS + 1, 0, MAX_DEVIATION_BPS);
    });

    it("passes at exactly the deviation ceiling, on both sides of the TWAP", async function () {
      await pool.setTicks(1000 + MAX_DEVIATION_BPS, 1000);
      const above = await stakePosition(alice);
      await primeHappyPath(above);
      await expect(
        vault.connect(alice).rebalance(above, NEW_TICK_LOWER, NEW_TICK_UPPER, swapParams(), FAR_DEADLINE)
      ).to.emit(vault, "Rebalanced");

      await pool.setTicks(1000 - MAX_DEVIATION_BPS, 1000);
      const below = await stakePosition(bob);
      await primeHappyPath(below);
      await expect(
        vault.connect(bob).rebalance(below, NEW_TICK_LOWER, NEW_TICK_UPPER, swapParams(), FAR_DEADLINE)
      ).to.emit(vault, "Rebalanced");
    });

    it("reverts before touching the router when the swap exceeds the withdrawn balance", async function () {
      const tokenId = await stakePosition(alice);
      await primeHappyPath(tokenId);
      const tooMuch = collected0 + 1n;

      await expect(
        vault
          .connect(alice)
          .rebalance(
            tokenId,
            NEW_TICK_LOWER,
            NEW_TICK_UPPER,
            swapParams({ amountIn: tooMuch }),
            FAR_DEADLINE
          )
      )
        .to.be.revertedWithCustomError(vault, "SwapAmountExceedsBalance")
        .withArgs(token0Addr, tooMuch, collected0);

      expect(await router.swapCalls()).to.equal(0n);
    });

    it("reverts when the swap output is below the caller's minimum", async function () {
      const tokenId = await stakePosition(alice);
      await primeHappyPath(tokenId);

      await expect(
        vault
          .connect(alice)
          .rebalance(
            tokenId,
            NEW_TICK_LOWER,
            NEW_TICK_UPPER,
            swapParams({ amountOutMin: swapOut + 1n }),
            FAR_DEADLINE
          )
      ).to.be.revertedWith("Too little received");
    });

    it("reverts when the mint consumes less than the caller's minimums", async function () {
      const tokenId = await stakePosition(alice);
      await primeHappyPath(tokenId);

      await expect(
        vault
          .connect(alice)
          .rebalance(
            tokenId,
            NEW_TICK_LOWER,
            NEW_TICK_UPPER,
            swapParams({ amount0Min: used0 + 1n }),
            FAR_DEADLINE
          )
      ).to.be.revertedWith("Price slippage check");
    });

    it("reverts on an expired deadline", async function () {
      const tokenId = await stakePosition(alice);

      await expect(
        vault.connect(alice).rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, NO_SWAP, 1)
      ).to.be.revertedWith("Transaction too old");
    });

    it("keeps the new position unstakeable by anyone but the staker", async function () {
      const tokenId = await stakePosition(alice);
      await nfpm.setMintConsumeBps(10_000n);
      await vault.connect(alice).rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, NO_SWAP, FAR_DEADLINE);
      const newTokenId = await nfpm.lastMintedId();

      await expect(vault.connect(bob).unstake(newTokenId))
        .to.be.revertedWithCustomError(vault, "NotStaker")
        .withArgs(newTokenId, bob.address, alice.address);

      await vault.connect(alice).unstake(newTokenId);
      expect(await nfpm.ownerOf(newTokenId)).to.equal(alice.address);
    });

    it("compounds the accrued fees into the new position instead of paying them out", async function () {
      const tokenId = await stakePosition(alice);
      await nfpm.setPendingFees(tokenId, FEES0, FEES1);
      await token0.transfer(nfpmAddr, FEES0);
      await token1.transfer(nfpmAddr, FEES1);
      await nfpm.setMintConsumeBps(10_000n);

      const balance0Before = await token0.balanceOf(alice.address);
      const balance1Before = await token1.balanceOf(alice.address);

      await vault.connect(alice).rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, NO_SWAP, FAR_DEADLINE);
      const newTokenId = await nfpm.lastMintedId();

      // fees never reach the staker: the whole principal + fees went back into liquidity
      expect(await token0.balanceOf(alice.address)).to.equal(balance0Before);
      expect(await token1.balanceOf(alice.address)).to.equal(balance1Before);
      expect((await nfpm.positions(newTokenId)).liquidity).to.equal(P0 + FEES0 + P1 + FEES1);
    });

    it("treats any balance already sitting in the vault as the rebalancer's own", async function () {
      const tokenId = await stakePosition(alice);
      await nfpm.setMintConsumeBps(10_000n);

      // a stray transfer, or dust a previous refund failed to move
      const stranded = 7n * unit0;
      await token0.transfer(vaultAddr, stranded);

      await vault.connect(alice).rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, NO_SWAP, FAR_DEADLINE);
      const newTokenId = await nfpm.lastMintedId();

      // the mint desires the whole token0/token1 balance, so the stranded amount is minted
      // into this caller's new position rather than staying in the vault
      expect((await nfpm.positions(newTokenId)).liquidity).to.equal(P0 + stranded + P1);
      expect(await token0.balanceOf(vaultAddr)).to.equal(0n);
      expect(await token1.balanceOf(vaultAddr)).to.equal(0n);
    });

    it("works against a position manager whose mint calls back into the receiver", async function () {
      const tokenId = await stakePosition(alice);
      await nfpm.setMintConsumeBps(10_000n);
      await nfpm.setSafeMintEnabled(true);

      await expect(
        vault.connect(alice).rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, NO_SWAP, FAR_DEADLINE)
      ).to.emit(vault, "Rebalanced");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("onERC721Received", function () {
    it("rejects a direct call from anything but the position manager", async function () {
      await expect(vault.connect(alice).onERC721Received(alice.address, alice.address, 1, "0x"))
        .to.be.revertedWithCustomError(vault, "UnexpectedNftSender")
        .withArgs(alice.address);
    });

    it("rejects a position pushed in outside a stake flow", async function () {
      const tokenId = await createPosition(alice);

      await expect(
        nfpm
          .connect(alice)
          ["safeTransferFrom(address,address,uint256)"](alice.address, vaultAddr, tokenId)
      )
        .to.be.revertedWithCustomError(vault, "UnsolicitedPosition")
        .withArgs(alice.address, alice.address, tokenId);
    });

    it("closes the receipt window again after a stake", async function () {
      const first = await stakePosition(alice);
      expect(await vault.stakerOf(first)).to.equal(alice.address);

      const second = await createPosition(bob);
      await expect(
        nfpm.connect(bob)["safeTransferFrom(address,address,uint256)"](bob.address, vaultAddr, second)
      ).to.be.revertedWithCustomError(vault, "UnsolicitedPosition");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Reentrancy", function () {
    let attacker, attackerAddr, hostileVault, hostileVaultAddr;

    beforeEach(async function () {
      const Attacker = await ethers.getContractFactory("ReentrantAttacker");
      attacker = await Attacker.deploy();
      attackerAddr = await attacker.getAddress();

      hostileVault = await deployVault({ swapRouter: attackerAddr });
      hostileVaultAddr = await hostileVault.getAddress();
    });

    async function stakeIntoHostileVault(user) {
      await nfpm.mintFake(user.address, token0Addr, token1Addr, FEE, TICK_LOWER, TICK_UPPER, LIQUIDITY, P0, P1);
      const tokenId = await nfpm.lastMintedId();
      await token0.transfer(nfpmAddr, P0);
      await token1.transfer(nfpmAddr, P1);
      await nfpm.connect(user).approve(hostileVaultAddr, tokenId);
      await hostileVault.connect(user).stake(tokenId);
      return tokenId;
    }

    it("stops a router that re-enters unstake during the swap leg", async function () {
      const tokenId = await stakeIntoHostileVault(alice);
      await attacker.configure(hostileVaultAddr, tokenId, MODE_UNSTAKE);

      await expect(
        hostileVault.connect(alice).rebalance(
          tokenId,
          NEW_TICK_LOWER,
          NEW_TICK_UPPER,
          { zeroForOne: true, amountIn: 1n * unit0, amountOutMin: 0n, amount0Min: 0n, amount1Min: 0n },
          FAR_DEADLINE
        )
      ).to.be.revertedWithCustomError(hostileVault, "ReentrancyGuardReentrantCall");
    });

    it("stops a router that re-enters rebalance during the swap leg", async function () {
      const tokenId = await stakeIntoHostileVault(alice);
      await attacker.configure(hostileVaultAddr, tokenId, MODE_REBALANCE);

      await expect(
        hostileVault.connect(alice).rebalance(
          tokenId,
          NEW_TICK_LOWER,
          NEW_TICK_UPPER,
          { zeroForOne: true, amountIn: 1n * unit0, amountOutMin: 0n, amount0Min: 0n, amount1Min: 0n },
          FAR_DEADLINE
        )
      ).to.be.revertedWithCustomError(hostileVault, "ReentrancyGuardReentrantCall");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Admin", function () {
    it("retunes the TWAP parameters, owner only and within bounds", async function () {
      await expect(vault.connect(alice).setTwapParams(1200, 100)).to.be.revertedWithCustomError(
        vault,
        "OwnableUnauthorizedAccount"
      );

      await expect(vault.setTwapParams(1200, 100))
        .to.emit(vault, "TwapParamsSet")
        .withArgs(1200, 100);
      expect(await vault.twapWindow()).to.equal(1200);
      expect(await vault.maxTwapDeviationBps()).to.equal(100);

      await expect(vault.setTwapParams(299, 100))
        .to.be.revertedWithCustomError(vault, "InvalidTwapWindow")
        .withArgs(299, 300);
      await expect(vault.setTwapParams(1200, 0))
        .to.be.revertedWithCustomError(vault, "InvalidTwapDeviation")
        .withArgs(0, 2000);
      await expect(vault.setTwapParams(1200, 2001))
        .to.be.revertedWithCustomError(vault, "InvalidTwapDeviation")
        .withArgs(2001, 2000);
    });

    it("toggles the deposit pause, owner only", async function () {
      await expect(vault.connect(alice).setDepositsPaused(true)).to.be.revertedWithCustomError(
        vault,
        "OwnableUnauthorizedAccount"
      );

      await expect(vault.setDepositsPaused(true)).to.emit(vault, "DepositsPausedSet").withArgs(true);
      expect(await vault.depositsPaused()).to.equal(true);

      await expect(vault.setDepositsPaused(false)).to.emit(vault, "DepositsPausedSet").withArgs(false);
      expect(await vault.depositsPaused()).to.equal(false);
    });

    it("sets and clears the zapper, owner only, carrying both sides", async function () {
      await expect(vault.connect(alice).setZapper(alice.address)).to.be.revertedWithCustomError(
        vault,
        "OwnableUnauthorizedAccount"
      );

      await expect(vault.setZapper(zapper.address)).to.emit(vault, "ZapperSet").withArgs(ZERO, zapper.address);
      expect(await vault.zapper()).to.equal(zapper.address);

      await expect(vault.setZapper(stranger.address))
        .to.emit(vault, "ZapperSet")
        .withArgs(zapper.address, stranger.address);

      await expect(vault.setZapper(ZERO)).to.emit(vault, "ZapperSet").withArgs(stranger.address, ZERO);
      expect(await vault.zapper()).to.equal(ZERO);
    });

    it("previewTwap reports the guard inputs and the verdict on both sides", async function () {
      await pool.setTicks(1000 + MAX_DEVIATION_BPS, 1000);
      let preview = await vault.previewTwap();
      expect(preview.currentTick).to.equal(1000 + MAX_DEVIATION_BPS);
      expect(preview.twapTick).to.equal(1000);
      expect(preview.maxDeviationTicks).to.equal(MAX_DEVIATION_BPS);
      expect(preview.withinBounds).to.equal(true);

      await pool.setTicks(1000 + MAX_DEVIATION_BPS + 1, 1000);
      preview = await vault.previewTwap();
      expect(preview.withinBounds).to.equal(false);

      await pool.setTicks(-(MAX_DEVIATION_BPS + 1), 0);
      preview = await vault.previewTwap();
      expect(preview.currentTick).to.equal(-(MAX_DEVIATION_BPS + 1));
      expect(preview.twapTick).to.equal(0);
      expect(preview.withinBounds).to.equal(false);

      await pool.setTicks(-MAX_DEVIATION_BPS, 0);
      preview = await vault.previewTwap();
      expect(preview.withinBounds).to.equal(true);
    });

    it("reads the TWAP over the configured window", async function () {
      await pool.setTicks(0, -250);
      await vault.setTwapParams(1800, 500);

      const preview = await vault.previewTwap();
      expect(preview.twapTick).to.equal(-250);
      expect(preview.maxDeviationTicks).to.equal(500);
      expect(preview.withinBounds).to.equal(true);
    });
  });
});
