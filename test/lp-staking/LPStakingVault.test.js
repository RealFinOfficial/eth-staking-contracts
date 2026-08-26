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
  const MODE_STAKE = 3;

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
      expect(await vault.rebalancePaused()).to.equal(false);
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

    it("rejects a pair whose two tokens are the same address", async function () {
      // `_token0 >= _token1` folds two mistakes into one error: the equal case here, and the
      // out-of-order case below. Both are caught before the pool is ever read.
      await expect(deployVault({ token0: token0Addr, token1: token0Addr }))
        .to.be.revertedWithCustomError(vault, "TokensNotSorted")
        .withArgs(token0Addr, token0Addr);

      await expect(deployVault({ token0: token1Addr, token1: token0Addr }))
        .to.be.revertedWithCustomError(vault, "TokensNotSorted")
        .withArgs(token1Addr, token0Addr);
    });

    it("rejects the pool on a wrong token0, a wrong token1 or a wrong fee, each on its own", async function () {
      const Token = await ethers.getContractFactory("MockERC20Decimals");
      const other = await Token.deploy("Other", "OTHER", 1000n, 18);
      const otherAddr = await other.getAddress();

      await pool.setTokens(otherAddr, token1Addr);
      await expect(deployVault())
        .to.be.revertedWithCustomError(vault, "PoolMismatch")
        .withArgs(otherAddr, token1Addr, FEE);

      await pool.setTokens(token0Addr, otherAddr);
      await expect(deployVault())
        .to.be.revertedWithCustomError(vault, "PoolMismatch")
        .withArgs(token0Addr, otherAddr, FEE);

      await pool.setTokens(token0Addr, token1Addr);
      await pool.setFee(OTHER_FEE);
      await expect(deployVault())
        .to.be.revertedWithCustomError(vault, "PoolMismatch")
        .withArgs(token0Addr, token1Addr, OTHER_FEE);

      // and the same triple restored deploys, so each arm above was the only difference
      await pool.setFee(FEE);
      expect(await (await deployVault()).pool()).to.equal(poolAddr);
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

    it("stays open while rebalance is paused (the exit is the fallback)", async function () {
      const tokenId = await stakePosition(alice);
      await vault.setRebalancePaused(true);
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

    it("reverts while rebalance is paused, and works again once it is lifted", async function () {
      const tokenId = await stakePosition(alice);
      await primeHappyPath(tokenId);
      await vault.setRebalancePaused(true);

      // the pause is the first statement, so it fires even for the staker's own position
      await expect(
        vault.connect(alice).rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, swapParams(), FAR_DEADLINE)
      ).to.be.revertedWithCustomError(vault, "RebalanceIsPaused");
      // nothing moved: the position is still staked, still under the same staker
      expect(await vault.stakerOf(tokenId)).to.equal(alice.address);

      await vault.setRebalancePaused(false);
      await expect(
        vault.connect(alice).rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, swapParams(), FAR_DEADLINE)
      ).to.emit(vault, "Rebalanced");
    });

    it("is blocked by the rebalance pause even with no swap leg", async function () {
      const tokenId = await stakePosition(alice);
      await nfpm.setMintConsumeBps(10_000n);
      await vault.setRebalancePaused(true);

      await expect(
        vault.connect(alice).rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, NO_SWAP, FAR_DEADLINE)
      ).to.be.revertedWithCustomError(vault, "RebalanceIsPaused");
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

    it("refunds only the side that carries dust, one arm at a time", async function () {
      await nfpm.setMintConsumeBps(CONSUME_BPS);

      // A position with nothing behind its token1 side. The mint desires zero token1, so the
      // refund can only have a token0 leg — the "token0 only" arm of `_refundDust`.
      const only0 = await stakePosition(alice, { principal1: 0n });
      const used0Only = (P0 * CONSUME_BPS) / 10_000n;
      const dust0 = P0 - used0Only;
      const token1Before = await token1.balanceOf(alice.address);

      let newTokenId = await vault
        .connect(alice)
        .rebalance.staticCall(only0, NEW_TICK_LOWER, NEW_TICK_UPPER, NO_SWAP, FAR_DEADLINE);
      let tx = await vault
        .connect(alice)
        .rebalance(only0, NEW_TICK_LOWER, NEW_TICK_UPPER, NO_SWAP, FAR_DEADLINE);

      await expect(tx)
        .to.emit(vault, "Rebalanced")
        .withArgs(
          alice.address,
          only0,
          newTokenId,
          NEW_TICK_LOWER,
          NEW_TICK_UPPER,
          used0Only,
          dust0,
          0n,
          await txTimestamp(tx)
        );
      expect(dust0).to.be.gt(0n);
      expect(await token1.balanceOf(alice.address)).to.equal(token1Before);

      // The mirror image: nothing behind token0, so only the token1 leg can fire.
      const only1 = await stakePosition(bob, { principal0: 0n });
      const used1Only = (P1 * CONSUME_BPS) / 10_000n;
      const dust1 = P1 - used1Only;
      const token0Before = await token0.balanceOf(bob.address);

      newTokenId = await vault
        .connect(bob)
        .rebalance.staticCall(only1, NEW_TICK_LOWER, NEW_TICK_UPPER, NO_SWAP, FAR_DEADLINE);
      tx = await vault.connect(bob).rebalance(only1, NEW_TICK_LOWER, NEW_TICK_UPPER, NO_SWAP, FAR_DEADLINE);

      await expect(tx)
        .to.emit(vault, "Rebalanced")
        .withArgs(
          bob.address,
          only1,
          newTokenId,
          NEW_TICK_LOWER,
          NEW_TICK_UPPER,
          used1Only,
          0n,
          dust1,
          await txTimestamp(tx)
        );
      expect(dust1).to.be.gt(0n);
      expect(await token0.balanceOf(bob.address)).to.equal(token0Before);
    });

    it("bubbles the pool's own revert when the oracle cannot serve the window", async function () {
      const tokenId = await stakePosition(alice);
      await nfpm.setMintConsumeBps(10_000n);
      await pool.setObserveReverts(true);

      await expect(
        vault
          .connect(alice)
          .rebalance(
            tokenId,
            NEW_TICK_LOWER,
            NEW_TICK_UPPER,
            swapParams({ amountOutMin: 0n, amount0Min: 0n, amount1Min: 0n }),
            FAR_DEADLINE
          )
      ).to.be.revertedWith("OLD");

      // the very same position re-ranges without a swap: the oracle is read for the swap leg
      // and for nothing else, so a dead oracle never blocks an exit
      await expect(
        vault.connect(alice).rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, NO_SWAP, FAR_DEADLINE)
      ).to.emit(vault, "Rebalanced");
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
  describe("rescuePosition", function () {
    /// A plain `transferFrom` never consults `onERC721Received`, so this is the one way an
    /// NFT can still land in the vault without a staker record behind it.
    async function pushStrayPosition(holder) {
      const tokenId = await createPosition(holder);
      await nfpm.connect(holder).transferFrom(holder.address, vaultAddr, tokenId);
      expect(await nfpm.ownerOf(tokenId)).to.equal(vaultAddr);
      expect(await vault.stakerOf(tokenId)).to.equal(ZERO);
      return tokenId;
    }

    it("sends an unrecorded position NFT to the owner and logs it", async function () {
      const tokenId = await pushStrayPosition(alice);

      const tx = await vault.rescuePosition(tokenId);
      const ts = await txTimestamp(tx);

      await expect(tx).to.emit(vault, "PositionRescued").withArgs(tokenId, owner.address, ts);
      expect(await nfpm.ownerOf(tokenId)).to.equal(owner.address);
    });

    it("refuses to move a staked position — the record is what makes custody legitimate", async function () {
      const tokenId = await stakePosition(alice);

      await expect(vault.rescuePosition(tokenId))
        .to.be.revertedWithCustomError(vault, "PositionIsStaked")
        .withArgs(tokenId, alice.address);

      // custody and the record are both untouched, and the staker can still walk out
      expect(await nfpm.ownerOf(tokenId)).to.equal(vaultAddr);
      expect(await vault.stakerOf(tokenId)).to.equal(alice.address);
      await expect(vault.connect(alice).unstake(tokenId)).to.emit(vault, "Unstaked");
    });

    it("refuses the position a rebalance just minted, and lets the burned old id go", async function () {
      const tokenId = await stakePosition(alice);
      const newTokenId = await vault
        .connect(alice)
        .rebalance.staticCall(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, NO_SWAP, FAR_DEADLINE);
      await vault.connect(alice).rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, NO_SWAP, FAR_DEADLINE);

      // the record moved with the position, so the live id is still out of reach
      await expect(vault.rescuePosition(newTokenId))
        .to.be.revertedWithCustomError(vault, "PositionIsStaked")
        .withArgs(newTokenId, alice.address);

      // the old id has no record any more, but it was burned, so there is nothing to move
      expect(await vault.stakerOf(tokenId)).to.equal(ZERO);
      await expect(vault.rescuePosition(tokenId)).to.be.revertedWithCustomError(nfpm, "ERC721NonexistentToken");
    });

    it("is owner only", async function () {
      const tokenId = await pushStrayPosition(alice);

      await expect(vault.connect(alice).rescuePosition(tokenId)).to.be.revertedWithCustomError(
        vault,
        "OwnableUnauthorizedAccount"
      );
      expect(await nfpm.ownerOf(tokenId)).to.equal(vaultAddr);
    });

    it("cannot pull in an NFT the vault does not hold, even one approved to it", async function () {
      // `createPosition` leaves the vault approved for the token, which is what a user does
      // before `stake`. The rescue transfers out of the vault rather than pulling into it,
      // so the standing approval buys the owner nothing.
      const tokenId = await createPosition(alice);

      await expect(vault.rescuePosition(tokenId))
        .to.be.revertedWithCustomError(nfpm, "ERC721IncorrectOwner")
        .withArgs(vaultAddr, tokenId, alice.address);
    });

    it("still works after the staker of another position unstakes", async function () {
      const stray = await pushStrayPosition(bob);
      const staked = await stakePosition(alice);
      await vault.connect(alice).unstake(staked);

      await expect(vault.rescuePosition(stray)).to.emit(vault, "PositionRescued");
      expect(await nfpm.ownerOf(stray)).to.equal(owner.address);
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

    it("stops a router that re-enters stake during the swap leg", async function () {
      const tokenId = await stakeIntoHostileVault(alice);

      // A position that is NOT staked yet, so `AlreadyStaked` cannot be the reason the
      // re-entrant call fails. `nonReentrant` runs before anything in `stake`'s body.
      await nfpm.mintFake(alice.address, token0Addr, token1Addr, FEE, TICK_LOWER, TICK_UPPER, LIQUIDITY, 0n, 0n);
      const fresh = await nfpm.lastMintedId();
      await nfpm.connect(alice).approve(hostileVaultAddr, fresh);
      await attacker.configure(hostileVaultAddr, fresh, MODE_STAKE);

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
  describe("Hostile ERC-20 pool tokens", function () {
    const ALT_SUPPLY = 1_000_000n * 10n ** 18n;
    const ALT_PRINCIPAL = 1000n * 10n ** 18n;

    /// Deploys a second vault whose pool pair is `factoryName`, with one position staked in
    /// it by alice and the router primed to trade the pair 1:1. Both tokens carry 18
    /// decimals, so every amount here is in whole units.
    async function deployAltVault(factoryName, opts = {}) {
      const Token = await ethers.getContractFactory(factoryName);
      const a = await Token.deploy("Alt A", "ALTA", ALT_SUPPLY, 18);
      const b = await Token.deploy("Alt B", "ALTB", ALT_SUPPLY, 18);
      const [alt0, alt1] =
        (await a.getAddress()).toLowerCase() < (await b.getAddress()).toLowerCase() ? [a, b] : [b, a];
      const alt0Addr = await alt0.getAddress();
      const alt1Addr = await alt1.getAddress();

      const Pool = await ethers.getContractFactory("MockUniswapV3Pool");
      const altPool = await Pool.deploy(alt0Addr, alt1Addr, FEE);

      const altVault = await deployVault({
        pool: await altPool.getAddress(),
        token0: alt0Addr,
        token1: alt1Addr,
        initialOwner: opts.ownerIsToken0 ? alt0Addr : owner.address,
      });
      const altVaultAddr = await altVault.getAddress();

      await router.setRate(alt0Addr, alt1Addr, 10n ** 18n, 10n ** 18n);
      await router.setRate(alt1Addr, alt0Addr, 10n ** 18n, 10n ** 18n);
      await alt0.transfer(routerAddr, 100_000n * 10n ** 18n);
      await alt1.transfer(routerAddr, 100_000n * 10n ** 18n);

      await nfpm.mintFake(
        alice.address,
        alt0Addr,
        alt1Addr,
        FEE,
        TICK_LOWER,
        TICK_UPPER,
        LIQUIDITY,
        ALT_PRINCIPAL,
        ALT_PRINCIPAL
      );
      const tokenId = await nfpm.lastMintedId();
      await alt0.transfer(nfpmAddr, ALT_PRINCIPAL);
      await alt1.transfer(nfpmAddr, ALT_PRINCIPAL);
      await nfpm.connect(alice).approve(altVaultAddr, tokenId);
      await altVault.connect(alice).stake(tokenId);

      return { altVault, altVaultAddr, alt0, alt1, alt0Addr, alt1Addr, tokenId };
    }

    it("re-ranges through a stale non-zero allowance a plain approve could never clear", async function () {
      const { altVault, altVaultAddr, alt0, tokenId } = await deployAltVault(
        "MockNonZeroApproveRevertsERC20"
      );

      // the token really is stuck once an allowance stands — this is the state `forceApprove`
      // exists to get out of
      await alt0.approve(bob.address, 1n);
      await expect(alt0.approve(bob.address, 2n))
        .to.be.revertedWithCustomError(alt0, "ApproveFromNonZeroAllowance")
        .withArgs(bob.address, 1n, 2n);

      // a leftover allowance on both spenders a rebalance approves
      await alt0.seedAllowance(altVaultAddr, nfpmAddr, 1n);
      await alt0.seedAllowance(altVaultAddr, routerAddr, 1n);

      await expect(
        altVault.connect(alice).rebalance(
          tokenId,
          NEW_TICK_LOWER,
          NEW_TICK_UPPER,
          {
            zeroForOne: true,
            amountIn: 100n * 10n ** 18n,
            amountOutMin: 0n,
            amount0Min: 0n,
            amount1Min: 0n,
          },
          FAR_DEADLINE
        )
      ).to.emit(altVault, "Rebalanced");

      // both approvals went out through the zero-first fallback and came back to zero
      expect(await alt0.allowance(altVaultAddr, nfpmAddr)).to.equal(0n);
      expect(await alt0.allowance(altVaultAddr, routerAddr)).to.equal(0n);
    });

    it("cannot be re-entered by a token hook calling stakeFor during a rebalance", async function () {
      const { altVault, altVaultAddr, alt0, alt0Addr, tokenId } = await deployAltVault("MockHookERC20");

      // the token itself is the whitelisted zapper, so the re-entrant call is one that would
      // otherwise clear `stakeFor`'s caller gate
      await altVault.setZapper(alt0Addr);

      const payload = altVault.interface.encodeFunctionData("stakeFor", [bob.address, tokenId]);
      await alt0.setRecipientHook(altVaultAddr, altVaultAddr, payload);

      // the hook fires inside `collect`, i.e. inside the rebalance
      await expect(
        altVault.connect(alice).rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, NO_SWAP, FAR_DEADLINE)
      ).to.be.revertedWithCustomError(altVault, "ReentrancyGuardReentrantCall");

      // outside a rebalance the identical call reaches `stakeFor`'s own checks, which proves
      // the hook is wired and that the guard is what rejected it above
      await expect(alt0.fireRecipientHook(altVaultAddr))
        .to.be.revertedWithCustomError(altVault, "AlreadyStaked")
        .withArgs(tokenId, alice.address);
    });

    it("cannot be re-entered by a token hook calling rescuePosition during a rebalance", async function () {
      // the vault's owner is the token itself, so the re-entrant call clears `onlyOwner` —
      // which runs before `nonReentrant` — and the guard is all that is left to stop it
      const { altVault, altVaultAddr, alt0, alt0Addr, alt1Addr, tokenId } = await deployAltVault(
        "MockHookERC20",
        { ownerIsToken0: true }
      );

      // a stray NFT with no staker record: exactly what `rescuePosition` exists to move
      await nfpm.mintFake(bob.address, alt0Addr, alt1Addr, FEE, TICK_LOWER, TICK_UPPER, LIQUIDITY, 0n, 0n);
      const stray = await nfpm.lastMintedId();
      await nfpm.connect(bob).transferFrom(bob.address, altVaultAddr, stray);

      const payload = altVault.interface.encodeFunctionData("rescuePosition", [stray]);
      await alt0.setRecipientHook(altVaultAddr, altVaultAddr, payload);

      await expect(
        altVault.connect(alice).rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, NO_SWAP, FAR_DEADLINE)
      ).to.be.revertedWithCustomError(altVault, "ReentrancyGuardReentrantCall");

      // the identical call succeeds once no rebalance is in flight, so nothing but the guard
      // rejected it — the window the guard closes is real
      await expect(alt0.fireRecipientHook(altVaultAddr)).to.emit(altVault, "PositionRescued");
      expect(await nfpm.ownerOf(stray)).to.equal(alt0Addr);
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

    it("toggles the rebalance pause, owner only", async function () {
      await expect(vault.connect(alice).setRebalancePaused(true)).to.be.revertedWithCustomError(
        vault,
        "OwnableUnauthorizedAccount"
      );

      await expect(vault.setRebalancePaused(true)).to.emit(vault, "RebalancePausedSet").withArgs(true);
      expect(await vault.rebalancePaused()).to.equal(true);
      // the two switches are independent
      expect(await vault.depositsPaused()).to.equal(false);

      await expect(vault.setRebalancePaused(false)).to.emit(vault, "RebalancePausedSet").withArgs(false);
      expect(await vault.rebalancePaused()).to.equal(false);
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

    it("floors a negative TWAP tick that does not divide the window evenly", async function () {
      // The pool's derived series always divides the window exactly, so the guard's floor
      // correction is unreachable through it. Raw cumulatives put a remainder in front of it:
      // -301 tick-seconds over 300 s is a true mean of -1.0033.
      await vault.setTwapParams(300, MAX_DEVIATION_BPS);

      await pool.setTickCumulatives([0, -301]);
      expect((await vault.previewTwap()).twapTick).to.equal(-2);

      // exact division leaves nothing to correct
      await pool.setTickCumulatives([0, -300]);
      expect((await vault.previewTwap()).twapTick).to.equal(-1);

      // and a positive remainder is truncated, never floored — flooring only applies below zero
      await pool.setTickCumulatives([0, 301]);
      expect((await vault.previewTwap()).twapTick).to.equal(1);
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
