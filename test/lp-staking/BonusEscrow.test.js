const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const {
  time,
  impersonateAccount,
  setBalance,
  stopImpersonatingAccount,
} = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const { valueAt, scaledAmount } = require("./helpers/positionValue");

/**
 * BonusEscrow — the whole life of an ApeBond bonus: reserve, move, scale, forfeit, pay.
 *
 * What this suite proves, against the B.3 decision document (2026-10-01) with the overrides of
 * 2026-10-05:
 *   - the implementation binds itself to ONE vault and refuses a bonus token that is not one of
 *     that vault's pool tokens (a position's value can only be expressed in one of them);
 *   - reservations are keyed by the position's `tokenId`, one per NFT, ever;
 *   - RESERVE NOW, FUND LATER (override O2): `reserve` makes no balance check of any kind, and
 *     `claim` pays the whole amount or reverts `InsufficientFunds` and changes nothing until the
 *     escrow is funded;
 *   - the vault's two notifications are the vault's alone, and follow one rule: an ACTIVE
 *     reservation (exists, not claimed, not forfeited, before its cliff) is forfeited by
 *     `onUnstake` and moved + scaled by `min(1, valueNew / valueOld)` at the vault's TWAP by
 *     `onRebalance`; anything else returns at once without reading the oracle (D3);
 *   - the same rules hold through a REAL `LPStakingVault` proxy linked with `setBonusEscrow`;
 *   - `recoverSurplus` reaches only `balance - totalReserved`, and nothing while more is owed
 *     than held;
 *   - the proxy upgrades in place — directly and through an `LPTimelock` — with the book intact.
 *
 * The expected scaled amounts are computed in JavaScript from `helpers/positionValue.js`, a
 * line-for-line BigInt port of the Uniswap math the contract uses, never read back from the
 * contract under test.
 */
describe("BonusEscrow", function () {
  let escrow, escrowAddr, vault, vaultAddr, pool, poolAddr, nfpm, nfpmAddr, router, routerAddr;
  let asset, assetAddr, usdc, usdcAddr, token0Addr, token1Addr, other, otherAddr;
  let bonusIsToken0;
  let owner, adapter, alice, bob, keeper, treasury, guardian;

  const FEE = 3000;
  const TWAP_WINDOW = 600;
  const MAX_DEVIATION_TICKS = 500;
  const TICK_LOWER = -600;
  const TICK_UPPER = 600;
  const NEW_TICK_LOWER = -1200;
  const NEW_TICK_UPPER = -600;
  const FAR_DEADLINE = 10n ** 12n;
  const ZERO = ethers.ZeroAddress;
  const UNSAFE_ALLOW = ["constructor", "state-variable-immutable"];

  const TOKENS = (n) => ethers.parseEther(String(n));
  const SUPPLY = TOKENS(10_000_000);
  const FUNDING = TOKENS(1_000);
  const BONUS = TOKENS(100);
  const HOUR = 3600;

  const NO_SWAP = { zeroForOne: true, amountIn: 0n, amountOutMin: 0n, amount0Min: 0n, amount1Min: 0n };

  // ── deployment helpers ─────────────────────────────────────────

  async function deployVaultProxy(npm, poolAddress, t0, t1) {
    const Vault = await ethers.getContractFactory("LPStakingVault");
    return upgrades.deployProxy(
      Vault,
      [owner.address, guardian.address, owner.address, ZERO, TWAP_WINDOW, MAX_DEVIATION_TICKS],
      {
        kind: "uups",
        constructorArgs: [npm, poolAddress, t0, t1, FEE, routerAddr],
        unsafeAllow: UNSAFE_ALLOW,
      }
    );
  }

  /// An escrow UUPS proxy bound to `vaultAddress`, paying in `tokenAddress`. `adapterAddress`
  /// is what `initialize` writes; address(0) is the closed path the deploy scripts start from.
  async function deployEscrowProxy(tokenAddress, vaultAddress, ownerAddress, adapterAddress = ZERO) {
    const Escrow = await ethers.getContractFactory("BonusEscrow");
    return upgrades.deployProxy(Escrow, [ownerAddress, adapterAddress], {
      kind: "uups",
      constructorArgs: [tokenAddress, vaultAddress],
      unsafeAllow: UNSAFE_ALLOW,
    });
  }

  const asAdapter = () => escrow.connect(adapter);

  /// A cliff `secs` into the future, measured from the chain's own clock.
  async function cliffIn(secs) {
    return BigInt(await time.latest()) + BigInt(secs);
  }

  async function reserve(tokenId, beneficiary, amount = BONUS, unlockAt) {
    const cliff = unlockAt ?? (await cliffIn(HOUR));
    await asAdapter().reserve(tokenId, beneficiary.address ?? beneficiary, amount, cliff);
    return cliff;
  }

  /// Runs `fn` with the vault proxy's own address as `msg.sender`, so a hook can be called
  /// directly — the shape of every notification the real vault sends.
  async function asVault(fn) {
    await impersonateAccount(vaultAddr);
    await setBalance(vaultAddr, 10n ** 18n);
    const signer = await ethers.getSigner(vaultAddr);
    try {
      return await fn(escrow.connect(signer));
    } finally {
      await stopImpersonatingAccount(vaultAddr);
    }
  }

  const snap = (tickLower, tickUpper, liquidity) => ({ tickLower, tickUpper, liquidity });

  /// The value the escrow must compute for a snapshot at the pool's TWAP tick.
  async function valueOf(s) {
    return valueAt(s.liquidity, s.tickLower, s.tickUpper, Number(await pool.twapTick()), bonusIsToken0);
  }

  /// Fabricates a position NFT for `holder` with funded principal and the vault approved.
  async function createPosition(holder, liquidity, principal0 = TOKENS(1_000), principal1 = TOKENS(1_000)) {
    await nfpm.mintFake(
      holder.address,
      token0Addr,
      token1Addr,
      FEE,
      TICK_LOWER,
      TICK_UPPER,
      liquidity,
      principal0,
      principal1
    );
    const tokenId = await nfpm.lastMintedId();
    const t0 = await ethers.getContractAt("MockERC20Decimals", token0Addr);
    const t1 = await ethers.getContractAt("MockERC20Decimals", token1Addr);
    await t0.transfer(nfpmAddr, principal0);
    await t1.transfer(nfpmAddr, principal1);
    await nfpm.connect(holder).approve(vaultAddr, tokenId);
    return tokenId;
  }

  beforeEach(async function () {
    [owner, adapter, alice, bob, keeper, treasury, guardian] = await ethers.getSigners();

    // Both pool tokens at 18 decimals, so every principal below is in one unit. The bonus token
    // is `asset`, whichever side the addresses happen to sort it onto.
    const Token = await ethers.getContractFactory("MockERC20Decimals");
    asset = await Token.deploy("Asset", "ASSET", SUPPLY, 18);
    usdc = await Token.deploy("Quote", "QUOTE", SUPPLY, 18);
    other = await Token.deploy("Other", "OTHER", SUPPLY, 18);
    assetAddr = await asset.getAddress();
    usdcAddr = await usdc.getAddress();
    otherAddr = await other.getAddress();
    [token0Addr, token1Addr] =
      assetAddr.toLowerCase() < usdcAddr.toLowerCase() ? [assetAddr, usdcAddr] : [usdcAddr, assetAddr];
    bonusIsToken0 = token0Addr === assetAddr;

    const Pool = await ethers.getContractFactory("MockUniswapV3Pool");
    pool = await Pool.deploy(token0Addr, token1Addr, FEE);
    poolAddr = await pool.getAddress();

    const Nfpm = await ethers.getContractFactory("MockPositionManager");
    nfpm = await Nfpm.deploy();
    nfpmAddr = await nfpm.getAddress();

    const Router = await ethers.getContractFactory("MockSwapRouter");
    router = await Router.deploy();
    routerAddr = await router.getAddress();

    vault = await deployVaultProxy(nfpmAddr, poolAddr, token0Addr, token1Addr);
    vaultAddr = await vault.getAddress();

    escrow = await deployEscrowProxy(assetAddr, vaultAddr, owner.address);
    escrowAddr = await escrow.getAddress();
  });

  // ─────────────────────────────────────────────────────────────
  describe("Deployment", function () {
    it("exposes the bonus token, the vault, the token side, the owner and an empty book", async function () {
      expect(await escrow.bonusToken()).to.equal(assetAddr);
      expect(await escrow.vault()).to.equal(vaultAddr);
      expect(await escrow.bonusIsToken0()).to.equal(bonusIsToken0);
      expect(await escrow.owner()).to.equal(owner.address);
      expect(await escrow.pendingOwner()).to.equal(ZERO);
      expect(await escrow.adapter()).to.equal(ZERO);
      expect(await escrow.totalReserved()).to.equal(0n);
    });

    it("starts with the reserve path closed, and says so in the proxy's own deploy tx", async function () {
      await expect(escrow.deploymentTransaction()).to.emit(escrow, "AdapterSet").withArgs(ZERO, ZERO);

      await expect(asAdapter().reserve(1n, alice.address, BONUS, await cliffIn(HOUR)))
        .to.be.revertedWithCustomError(escrow, "NotAdapter")
        .withArgs(adapter.address, ZERO);
    });

    it("can instead be born pointing at an adapter", async function () {
      const born = await deployEscrowProxy(assetAddr, vaultAddr, owner.address, adapter.address);
      await expect(born.deploymentTransaction()).to.emit(born, "AdapterSet").withArgs(ZERO, adapter.address);
      await born.connect(adapter).reserve(7n, alice.address, BONUS, await cliffIn(HOUR));
      expect(await born.totalReserved()).to.equal(BONUS);
    });

    it("records which pool side the bonus token is, for both sides", async function () {
      const Escrow = await ethers.getContractFactory("BonusEscrow");
      const on0 = await Escrow.deploy(token0Addr, vaultAddr);
      const on1 = await Escrow.deploy(token1Addr, vaultAddr);
      expect(await on0.bonusIsToken0()).to.equal(true);
      expect(await on1.bonusIsToken0()).to.equal(false);
    });

    it("rejects a zero bonus token or a zero vault on the IMPLEMENTATION", async function () {
      const Escrow = await ethers.getContractFactory("BonusEscrow");
      await expect(Escrow.deploy(ZERO, vaultAddr)).to.be.revertedWithCustomError(Escrow, "ZeroAddress");
      await expect(Escrow.deploy(assetAddr, ZERO)).to.be.revertedWithCustomError(Escrow, "ZeroAddress");
    });

    it("rejects a bonus token that is neither of the vault's pool tokens", async function () {
      const Escrow = await ethers.getContractFactory("BonusEscrow");
      await expect(Escrow.deploy(otherAddr, vaultAddr))
        .to.be.revertedWithCustomError(Escrow, "BonusTokenNotInPool")
        .withArgs(otherAddr, token0Addr, token1Addr);
    });

    it("rejects a zero owner in initialize, through the proxy", async function () {
      const Escrow = await ethers.getContractFactory("BonusEscrow");
      await expect(deployEscrowProxy(assetAddr, vaultAddr, ZERO))
        .to.be.revertedWithCustomError(Escrow, "OwnableInvalidOwner")
        .withArgs(ZERO);
    });

    it("cannot be initialised a second time, on the proxy or on the implementation", async function () {
      await expect(escrow.initialize(alice.address, adapter.address)).to.be.revertedWithCustomError(
        escrow,
        "InvalidInitialization"
      );

      const implAddr = await upgrades.erc1967.getImplementationAddress(escrowAddr);
      const impl = await ethers.getContractAt("BonusEscrow", implAddr);
      await expect(impl.initialize(alice.address, adapter.address)).to.be.revertedWithCustomError(
        impl,
        "InvalidInitialization"
      );
    });

    it("refuses renounceOwnership, so the upgrade path can never be frozen", async function () {
      await expect(escrow.renounceOwnership()).to.be.revertedWithCustomError(escrow, "RenounceDisabled");
      expect(await escrow.owner()).to.equal(owner.address);

      await expect(escrow.connect(alice).renounceOwnership())
        .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount")
        .withArgs(alice.address);
    });

    it("has no funding check, no cap, no pause and no admin path into a reservation", async function () {
      // Override O2 and Q5, asserted on the ABI rather than in prose.
      for (const error of ["Underfunded"]) {
        expect(escrow.interface.getError(error)).to.equal(null);
      }
      const names = escrow.interface.fragments.filter((f) => f.type === "function").map((f) => f.name);
      for (const forbidden of [
        "pause",
        "setPaused",
        "setGuardian",
        "voidReservation",
        "cancelReservation",
        "setReservation",
        "maxTotalBonus",
        "maxBonusPerPurchase",
      ]) {
        expect(names).to.not.include(forbidden);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("setAdapter", function () {
    it("stores the adapter and announces both sides", async function () {
      await expect(escrow.setAdapter(adapter.address))
        .to.emit(escrow, "AdapterSet")
        .withArgs(ZERO, adapter.address);
      await expect(escrow.setAdapter(keeper.address))
        .to.emit(escrow, "AdapterSet")
        .withArgs(adapter.address, keeper.address);
      expect(await escrow.adapter()).to.equal(keeper.address);
    });

    it("is owner-only", async function () {
      for (const caller of [adapter, alice]) {
        await expect(escrow.connect(caller).setAdapter(caller.address))
          .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount")
          .withArgs(caller.address);
      }
    });

    it("revokes the old adapter the moment a new one is pointed at", async function () {
      await escrow.setAdapter(adapter.address);
      await escrow.setAdapter(keeper.address);

      await expect(asAdapter().reserve(1n, alice.address, BONUS, await cliffIn(HOUR)))
        .to.be.revertedWithCustomError(escrow, "NotAdapter")
        .withArgs(adapter.address, keeper.address);
      await escrow.connect(keeper).reserve(1n, alice.address, BONUS, await cliffIn(HOUR));
      expect(await escrow.totalReserved()).to.equal(BONUS);
    });

    it("closes the reserve path on zero, and leaves standing reservations payable", async function () {
      await escrow.setAdapter(adapter.address);
      const cliff = await reserve(1n, alice);
      await escrow.setAdapter(ZERO);

      await expect(asAdapter().reserve(2n, bob.address, BONUS, await cliffIn(HOUR)))
        .to.be.revertedWithCustomError(escrow, "NotAdapter")
        .withArgs(adapter.address, ZERO);

      await asset.transfer(escrowAddr, BONUS);
      await time.increaseTo(cliff);
      await expect(escrow.connect(keeper).claim(1n))
        .to.emit(escrow, "BonusClaimed")
        .withArgs(1n, alice.address, BONUS);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("reserve", function () {
    beforeEach(async function () {
      await escrow.setAdapter(adapter.address);
    });

    it("records the reservation under the tokenId and emits its four fields", async function () {
      const cliff = await cliffIn(HOUR);
      await expect(asAdapter().reserve(42n, alice.address, BONUS, cliff))
        .to.emit(escrow, "BonusReserved")
        .withArgs(42n, alice.address, BONUS, cliff);

      const r = await escrow.reservationOf(42n);
      expect(r.beneficiary).to.equal(alice.address);
      expect(r.amount).to.equal(BONUS);
      expect(r.unlockAt).to.equal(cliff);
      expect(r.claimed).to.equal(false);
      expect(r.forfeited).to.equal(false);
      expect(await escrow.isActive(42n)).to.equal(true);
      expect(await escrow.totalReserved()).to.equal(BONUS);
    });

    it("is callable by the adapter alone — the owner and the vault included", async function () {
      for (const caller of [owner, alice]) {
        await expect(escrow.connect(caller).reserve(1n, alice.address, BONUS, await cliffIn(HOUR)))
          .to.be.revertedWithCustomError(escrow, "NotAdapter")
          .withArgs(caller.address, adapter.address);
      }
      await asVault(async (e) => {
        await expect(e.reserve(1n, alice.address, BONUS, await cliffIn(HOUR)))
          .to.be.revertedWithCustomError(escrow, "NotAdapter")
          .withArgs(vaultAddr, adapter.address);
      });
    });

    it("records a bonus whatever the balance is — reserve now, fund later, no ceiling", async function () {
      expect(await asset.balanceOf(escrowAddr)).to.equal(0n);

      await reserve(1n, alice, TOKENS(5_000_000));
      await reserve(2n, bob, TOKENS(4_000_000));

      expect(await escrow.totalReserved()).to.equal(TOKENS(9_000_000));
      expect(await asset.balanceOf(escrowAddr)).to.equal(0n);
    });

    it("sums every outstanding reservation into totalReserved", async function () {
      await reserve(1n, alice, TOKENS(100));
      await reserve(2n, bob, TOKENS(250));
      await reserve(3n, alice, TOKENS(25));
      expect(await escrow.totalReserved()).to.equal(TOKENS(375));
    });

    it("allows one reservation per tokenId, ever", async function () {
      await reserve(1n, alice);

      await expect(asAdapter().reserve(1n, alice.address, BONUS, await cliffIn(HOUR)))
        .to.be.revertedWithCustomError(escrow, "DuplicateReservation")
        .withArgs(1n);
      await expect(asAdapter().reserve(1n, bob.address, TOKENS(1), await cliffIn(HOUR)))
        .to.be.revertedWithCustomError(escrow, "DuplicateReservation")
        .withArgs(1n);
      expect(await escrow.totalReserved()).to.equal(BONUS);
    });

    it("still refuses the tokenId after the bonus was forfeited or claimed", async function () {
      await reserve(1n, alice);
      await asVault((e) => e.onUnstake(1n));
      await expect(asAdapter().reserve(1n, alice.address, BONUS, await cliffIn(HOUR)))
        .to.be.revertedWithCustomError(escrow, "DuplicateReservation")
        .withArgs(1n);

      const cliff = await reserve(2n, bob);
      await asset.transfer(escrowAddr, BONUS);
      await time.increaseTo(cliff);
      await escrow.claim(2n);
      await expect(asAdapter().reserve(2n, bob.address, BONUS, await cliffIn(HOUR)))
        .to.be.revertedWithCustomError(escrow, "DuplicateReservation")
        .withArgs(2n);
    });

    it("rejects a zero beneficiary and a zero amount", async function () {
      await expect(asAdapter().reserve(1n, ZERO, BONUS, await cliffIn(HOUR))).to.be.revertedWithCustomError(
        escrow,
        "ZeroAddress"
      );
      await expect(
        asAdapter().reserve(1n, alice.address, 0n, await cliffIn(HOUR))
      ).to.be.revertedWithCustomError(escrow, "ZeroAmount");
      expect(await escrow.totalReserved()).to.equal(0n);
    });

    it("accepts a cliff already in the past — matured at once, never active", async function () {
      const past = BigInt(await time.latest()) - 1n;
      await asAdapter().reserve(1n, alice.address, BONUS, past);
      expect(await escrow.isActive(1n)).to.equal(false);
      expect(await escrow.claimable(1n)).to.equal(BONUS);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("claim", function () {
    beforeEach(async function () {
      await escrow.setAdapter(adapter.address);
      await asset.transfer(escrowAddr, FUNDING);
    });

    it("reverts before the cliff, naming the cliff and the current time", async function () {
      const cliff = await reserve(1n, alice);
      await time.setNextBlockTimestamp(cliff - 1n);
      await expect(escrow.claim(1n))
        .to.be.revertedWithCustomError(escrow, "CliffNotReached")
        .withArgs(cliff, cliff - 1n);
    });

    it("pays at the exact cliff timestamp", async function () {
      const cliff = await reserve(1n, alice);
      const before = await asset.balanceOf(alice.address);

      await time.setNextBlockTimestamp(cliff);
      await expect(escrow.connect(alice).claim(1n))
        .to.emit(escrow, "BonusClaimed")
        .withArgs(1n, alice.address, BONUS);

      expect(await asset.balanceOf(alice.address)).to.equal(before + BONUS);
      expect(await escrow.totalReserved()).to.equal(0n);
      expect((await escrow.reservationOf(1n)).claimed).to.equal(true);
    });

    it("pays the recorded beneficiary even when a stranger triggers it", async function () {
      const cliff = await reserve(1n, alice);
      await time.increaseTo(cliff);
      const keeperBefore = await asset.balanceOf(keeper.address);

      await expect(escrow.connect(keeper).claim(1n))
        .to.emit(escrow, "BonusClaimed")
        .withArgs(1n, alice.address, BONUS);
      expect(await asset.balanceOf(alice.address)).to.equal(BONUS);
      expect(await asset.balanceOf(keeper.address)).to.equal(keeperBefore);
    });

    it("leaves every other reservation alone", async function () {
      const cliff = await reserve(1n, alice, TOKENS(100));
      await reserve(2n, bob, TOKENS(250), await cliffIn(86_400));
      await time.increaseTo(cliff);
      await escrow.claim(1n);

      expect(await escrow.totalReserved()).to.equal(TOKENS(250));
      expect(await escrow.claimable(2n)).to.equal(0n);
      expect(await asset.balanceOf(bob.address)).to.equal(0n);
    });

    it("spends a reservation exactly once", async function () {
      const cliff = await reserve(1n, alice);
      await time.increaseTo(cliff);
      await escrow.claim(1n);
      await expect(escrow.claim(1n)).to.be.revertedWithCustomError(escrow, "AlreadyClaimed").withArgs(1n);
      expect(await asset.balanceOf(alice.address)).to.equal(BONUS);
    });

    it("rejects a tokenId that was never reserved", async function () {
      await expect(escrow.claim(999n))
        .to.be.revertedWithCustomError(escrow, "UnknownReservation")
        .withArgs(999n);
    });

    it("rejects a forfeited reservation, even after the cliff and with the escrow funded", async function () {
      const cliff = await reserve(1n, alice);
      await asVault((e) => e.onUnstake(1n));
      await time.increaseTo(cliff);

      await expect(escrow.claim(1n)).to.be.revertedWithCustomError(escrow, "Forfeited").withArgs(1n);
      expect(await asset.balanceOf(alice.address)).to.equal(0n);
    });

    it("returns the amount paid to its caller", async function () {
      const cliff = await reserve(1n, alice, TOKENS(42));
      await time.increaseTo(cliff);
      expect(await escrow.claim.staticCall(1n)).to.equal(TOKENS(42));
    });

    it("keeps working after the reserve path is closed — a bonus owed is never withheld", async function () {
      const cliff = await reserve(1n, alice);
      await escrow.setAdapter(ZERO);
      await time.increaseTo(cliff);
      await expect(escrow.claim(1n)).to.emit(escrow, "BonusClaimed");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("claim — funding (override O2)", function () {
    beforeEach(async function () {
      await escrow.setAdapter(adapter.address);
    });

    it("reverts InsufficientFunds while the escrow is empty, and changes nothing", async function () {
      const cliff = await reserve(1n, alice);
      await time.increaseTo(cliff);

      await expect(escrow.claim(1n))
        .to.be.revertedWithCustomError(escrow, "InsufficientFunds")
        .withArgs(BONUS, 0n);
      const r = await escrow.reservationOf(1n);
      expect(r.claimed).to.equal(false);
      expect(r.amount).to.equal(BONUS);
      expect(await escrow.totalReserved()).to.equal(BONUS);
    });

    it("pays nothing in part: one wei short is still a revert", async function () {
      const cliff = await reserve(1n, alice);
      await time.increaseTo(cliff);
      await asset.transfer(escrowAddr, BONUS - 1n);

      await expect(escrow.claim(1n))
        .to.be.revertedWithCustomError(escrow, "InsufficientFunds")
        .withArgs(BONUS, BONUS - 1n);
      expect(await asset.balanceOf(alice.address)).to.equal(0n);
    });

    it("pays exactly the amount once the company funds the escrow", async function () {
      const cliff = await reserve(1n, alice);
      await time.increaseTo(cliff);
      await expect(escrow.claim(1n)).to.be.revertedWithCustomError(escrow, "InsufficientFunds");

      await asset.transfer(escrowAddr, BONUS);
      await expect(escrow.claim(1n)).to.emit(escrow, "BonusClaimed").withArgs(1n, alice.address, BONUS);
      expect(await asset.balanceOf(alice.address)).to.equal(BONUS);
      expect(await asset.balanceOf(escrowAddr)).to.equal(0n);
      expect(await escrow.totalReserved()).to.equal(0n);
    });

    it("pays claims in any order while the balance lasts, and refuses the next one after it", async function () {
      const cliff = await reserve(1n, alice, TOKENS(60));
      await reserve(2n, bob, TOKENS(60), cliff);
      await asset.transfer(escrowAddr, TOKENS(100));
      await time.increaseTo(cliff);

      await escrow.claim(2n);
      await expect(escrow.claim(1n))
        .to.be.revertedWithCustomError(escrow, "InsufficientFunds")
        .withArgs(TOKENS(60), TOKENS(40));

      await asset.transfer(escrowAddr, TOKENS(20));
      await escrow.claim(1n);
      expect(await asset.balanceOf(alice.address)).to.equal(TOKENS(60));
    });

    it("marks the reservation spent BEFORE the transfer, so a token hook cannot re-enter", async function () {
      // A callback token on its own pool and vault: the escrow only accepts a pool token.
      const Hook = await ethers.getContractFactory("MockHookERC20");
      const hookToken = await Hook.deploy("Hook Bonus", "hBONUS", SUPPLY, 18);
      const hookAddr = await hookToken.getAddress();
      const [h0, h1] =
        hookAddr.toLowerCase() < usdcAddr.toLowerCase() ? [hookAddr, usdcAddr] : [usdcAddr, hookAddr];
      const Pool = await ethers.getContractFactory("MockUniswapV3Pool");
      const hookPool = await Pool.deploy(h0, h1, FEE);
      const hookVault = await deployVaultProxy(nfpmAddr, await hookPool.getAddress(), h0, h1);

      const hooked = await deployEscrowProxy(
        hookAddr,
        await hookVault.getAddress(),
        owner.address,
        adapter.address
      );
      const hookedAddr = await hooked.getAddress();
      await hookToken.transfer(hookedAddr, FUNDING);

      const cliff = await cliffIn(HOUR);
      await hooked.connect(adapter).reserve(1n, alice.address, BONUS, cliff);
      await time.increaseTo(cliff);

      const payload = hooked.interface.encodeFunctionData("claim", [1n]);
      await hookToken.setRecipientHook(alice.address, hookedAddr, payload);
      await expect(hooked.claim(1n)).to.be.revertedWithCustomError(hooked, "ReentrancyGuardReentrantCall");

      const benign = hooked.interface.encodeFunctionData("claimable", [1n]);
      await hookToken.setRecipientHook(alice.address, hookedAddr, benign);
      await expect(hooked.claim(1n)).to.emit(hooked, "BonusClaimed");
      expect(await hookToken.hookCalls()).to.equal(1n);
      expect(await hookToken.balanceOf(alice.address)).to.equal(BONUS);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("claimable and isActive", function () {
    beforeEach(async function () {
      await escrow.setAdapter(adapter.address);
    });

    it("are zero / false for a tokenId nobody reserved", async function () {
      expect(await escrow.claimable(1n)).to.equal(0n);
      expect(await escrow.isActive(1n)).to.equal(false);
    });

    it("report a locked bonus as active and not yet claimable, then the reverse at the cliff", async function () {
      const cliff = await reserve(1n, alice, TOKENS(7));
      expect(await escrow.isActive(1n)).to.equal(true);
      expect(await escrow.claimable(1n)).to.equal(0n);

      await time.increaseTo(cliff);
      expect(await escrow.isActive(1n)).to.equal(false);
      expect(await escrow.claimable(1n)).to.equal(TOKENS(7));
    });

    it("report the owed amount even while the escrow cannot pay it — blind to the balance", async function () {
      const cliff = await reserve(1n, alice);
      await time.increaseTo(cliff);
      expect(await asset.balanceOf(escrowAddr)).to.equal(0n);
      expect(await escrow.claimable(1n)).to.equal(BONUS);
    });

    it("fall back to zero once forfeited or paid", async function () {
      const cliff = await reserve(1n, alice);
      await reserve(2n, bob, BONUS, cliff);
      await asVault((e) => e.onUnstake(1n));
      await asset.transfer(escrowAddr, BONUS);
      await time.increaseTo(cliff);
      await escrow.claim(2n);

      expect(await escrow.claimable(1n)).to.equal(0n);
      expect(await escrow.claimable(2n)).to.equal(0n);
      expect(await escrow.isActive(1n)).to.equal(false);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("onUnstake (called as the vault)", function () {
    beforeEach(async function () {
      await escrow.setAdapter(adapter.address);
    });

    it("is the vault's alone", async function () {
      for (const caller of [owner, adapter, alice]) {
        await expect(escrow.connect(caller).onUnstake(1n))
          .to.be.revertedWithCustomError(escrow, "NotVault")
          .withArgs(caller.address, vaultAddr);
      }
    });

    it("forfeits an active reservation: amount gone, record kept, total released", async function () {
      await reserve(1n, alice, TOKENS(100));
      await reserve(2n, bob, TOKENS(50));

      await asVault(async (e) => {
        await expect(e.onUnstake(1n))
          .to.emit(escrow, "BonusForfeited")
          .withArgs(1n, alice.address, TOKENS(100));
      });

      const r = await escrow.reservationOf(1n);
      expect(r.beneficiary).to.equal(alice.address);
      expect(r.amount).to.equal(0n);
      expect(r.forfeited).to.equal(true);
      expect(await escrow.totalReserved()).to.equal(TOKENS(50));
    });

    it("does nothing for a tokenId with no reservation", async function () {
      await reserve(2n, bob);
      await asVault(async (e) => {
        await expect(e.onUnstake(1n)).to.not.emit(escrow, "BonusForfeited");
      });
      expect(await escrow.totalReserved()).to.equal(BONUS);
    });

    it("does nothing once the cliff has passed (D3)", async function () {
      const cliff = await reserve(1n, alice);
      await time.increaseTo(cliff);
      await asVault(async (e) => {
        await expect(e.onUnstake(1n)).to.not.emit(escrow, "BonusForfeited");
      });
      const r = await escrow.reservationOf(1n);
      expect(r.amount).to.equal(BONUS);
      expect(r.forfeited).to.equal(false);
    });

    it("forfeits one second before the cliff", async function () {
      const cliff = await reserve(1n, alice);
      await time.setNextBlockTimestamp(cliff - 1n);
      await asVault(async (e) => {
        await expect(e.onUnstake(1n)).to.emit(escrow, "BonusForfeited");
      });
    });

    it("does nothing to a forfeited or a claimed reservation", async function () {
      const cliff = await reserve(1n, alice);
      await asVault((e) => e.onUnstake(1n));
      await asVault(async (e) => {
        await expect(e.onUnstake(1n)).to.not.emit(escrow, "BonusForfeited");
      });

      await reserve(2n, bob, BONUS, cliff);
      await asset.transfer(escrowAddr, BONUS);
      await time.increaseTo(cliff);
      await escrow.claim(2n);
      await asVault(async (e) => {
        await expect(e.onUnstake(2n)).to.not.emit(escrow, "BonusForfeited");
      });
      expect((await escrow.reservationOf(2n)).claimed).to.equal(true);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("onRebalance (called as the vault)", function () {
    const OLD = snap(TICK_LOWER, TICK_UPPER, 1_000_000n);

    beforeEach(async function () {
      await escrow.setAdapter(adapter.address);
    });

    it("is the vault's alone", async function () {
      for (const caller of [owner, adapter, alice]) {
        await expect(escrow.connect(caller).onRebalance(1n, 2n, OLD, OLD))
          .to.be.revertedWithCustomError(escrow, "NotVault")
          .withArgs(caller.address, vaultAddr);
      }
    });

    it("moves a value-keeping rebalance's reservation with the same amount", async function () {
      const cliff = await reserve(1n, alice, BONUS);
      await asVault(async (e) => {
        await expect(e.onRebalance(1n, 2n, OLD, OLD))
          .to.emit(escrow, "BonusMoved")
          .withArgs(1n, 2n, alice.address, BONUS, BONUS);
      });

      const moved = await escrow.reservationOf(2n);
      expect(moved.beneficiary).to.equal(alice.address);
      expect(moved.amount).to.equal(BONUS);
      expect(moved.unlockAt).to.equal(cliff);
      expect(moved.forfeited).to.equal(false);
      expect((await escrow.reservationOf(1n)).beneficiary).to.equal(ZERO);
      expect(await escrow.totalReserved()).to.equal(BONUS);
    });

    it("scales the amount by the share of value that stayed staked", async function () {
      await reserve(1n, alice, BONUS);
      const NEW = snap(TICK_LOWER, TICK_UPPER, 300_000n);
      const expected = scaledAmount(BONUS, await valueOf(OLD), await valueOf(NEW));
      expect(expected).to.be.lt(BONUS);

      await asVault(async (e) => {
        await expect(e.onRebalance(1n, 2n, OLD, NEW))
          .to.emit(escrow, "BonusMoved")
          .withArgs(1n, 2n, alice.address, BONUS, expected);
      });
      expect((await escrow.reservationOf(2n)).amount).to.equal(expected);
      expect(await escrow.totalReserved()).to.equal(expected);
    });

    it("never raises the amount, whatever the new position is worth", async function () {
      await reserve(1n, alice, BONUS);
      const NEW = snap(TICK_LOWER, TICK_UPPER, 5_000_000n);
      expect(await valueOf(NEW)).to.be.gt(await valueOf(OLD));

      await asVault((e) => e.onRebalance(1n, 2n, OLD, NEW));
      expect((await escrow.reservationOf(2n)).amount).to.equal(BONUS);
    });

    it("values both positions at the TWAP tick, not at spot", async function () {
      await reserve(1n, alice, BONUS);
      // A range whose value relative to OLD differs between tick 0 and tick 400.
      const NEW = snap(0, 1200, 600_000n);
      await pool.setTicks(400, 0); // spot 400, TWAP 0 — deviation not consulted by the escrow

      const atTwap = scaledAmount(
        BONUS,
        valueAt(OLD.liquidity, OLD.tickLower, OLD.tickUpper, 0, bonusIsToken0),
        valueAt(NEW.liquidity, NEW.tickLower, NEW.tickUpper, 0, bonusIsToken0)
      );
      const atSpot = scaledAmount(
        BONUS,
        valueAt(OLD.liquidity, OLD.tickLower, OLD.tickUpper, 400, bonusIsToken0),
        valueAt(NEW.liquidity, NEW.tickLower, NEW.tickUpper, 400, bonusIsToken0)
      );
      expect(atTwap).to.not.equal(atSpot);

      await asVault((e) => e.onRebalance(1n, 2n, OLD, NEW));
      expect((await escrow.reservationOf(2n)).amount).to.equal(atTwap);
    });

    it("forfeits at the new id when the new position is worth nothing", async function () {
      const cliff = await reserve(1n, alice, BONUS);
      await asVault(async (e) => {
        await expect(e.onRebalance(1n, 2n, OLD, snap(TICK_LOWER, TICK_UPPER, 0n)))
          .to.emit(escrow, "BonusMoved")
          .withArgs(1n, 2n, alice.address, BONUS, 0n);
      });
      const r = await escrow.reservationOf(2n);
      expect(r.forfeited).to.equal(true);
      expect(r.amount).to.equal(0n);
      expect(await escrow.totalReserved()).to.equal(0n);

      await asset.transfer(escrowAddr, BONUS);
      await time.increaseTo(cliff);
      await expect(escrow.claim(2n)).to.be.revertedWithCustomError(escrow, "Forfeited").withArgs(2n);
    });

    it("keeps nothing when the OLD position was worth nothing at the TWAP", async function () {
      await reserve(1n, alice, BONUS);
      await asVault((e) => e.onRebalance(1n, 2n, snap(TICK_LOWER, TICK_UPPER, 0n), OLD));
      const r = await escrow.reservationOf(2n);
      expect(r.amount).to.equal(0n);
      expect(r.forfeited).to.equal(true);
    });

    it("refuses to move onto a tokenId that already carries a reservation", async function () {
      await reserve(1n, alice);
      await reserve(2n, bob);
      await asVault(async (e) => {
        await expect(e.onRebalance(1n, 2n, OLD, OLD))
          .to.be.revertedWithCustomError(escrow, "DuplicateReservation")
          .withArgs(2n);
      });
    });

    it("returns without reading the oracle when there is no reservation", async function () {
      await pool.setObserveReverts(true);
      await asVault(async (e) => {
        await expect(e.onRebalance(1n, 2n, OLD, OLD)).to.not.emit(escrow, "BonusMoved");
      });
    });

    it("leaves a matured reservation under the OLD id, oracle or not (D3)", async function () {
      const cliff = await reserve(1n, alice);
      await time.increaseTo(cliff);
      await pool.setObserveReverts(true);

      await asVault(async (e) => {
        await expect(e.onRebalance(1n, 2n, OLD, snap(TICK_LOWER, TICK_UPPER, 1n))).to.not.emit(
          escrow,
          "BonusMoved"
        );
      });
      expect((await escrow.reservationOf(1n)).amount).to.equal(BONUS);
      expect((await escrow.reservationOf(2n)).beneficiary).to.equal(ZERO);
    });

    it("fails closed when the oracle cannot serve an active reservation", async function () {
      await reserve(1n, alice);
      await pool.setObserveReverts(true);
      await asVault(async (e) => {
        await expect(e.onRebalance(1n, 2n, OLD, OLD)).to.be.revertedWith("OLD");
      });
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Through a real LPStakingVault", function () {
    beforeEach(async function () {
      await escrow.setAdapter(adapter.address);
      await vault.setBonusEscrow(escrowAddr);
    });

    it("forfeits the bonus when the staker exits before the cliff, and the exit completes", async function () {
      const tokenId = await createPosition(alice, 1_000_000n);
      await vault.connect(alice).stake(tokenId);
      await reserve(tokenId, alice);

      const tx = vault.connect(alice).unstake(tokenId);
      await expect(tx).to.emit(escrow, "BonusForfeited").withArgs(tokenId, alice.address, BONUS);
      await expect(tx).to.not.emit(vault, "BonusHookFailed");
      expect(await nfpm.ownerOf(tokenId)).to.equal(alice.address);
      expect(await escrow.totalReserved()).to.equal(0n);
    });

    it("keeps the bonus when the exit comes after the cliff, and pays it", async function () {
      const tokenId = await createPosition(alice, 1_000_000n);
      await vault.connect(alice).stake(tokenId);
      const cliff = await reserve(tokenId, alice);
      await asset.transfer(escrowAddr, BONUS);
      await time.increaseTo(cliff);

      await expect(vault.connect(alice).unstake(tokenId)).to.not.emit(escrow, "BonusForfeited");
      await expect(escrow.claim(tokenId))
        .to.emit(escrow, "BonusClaimed")
        .withArgs(tokenId, alice.address, BONUS);
    });

    it("moves the bonus to the new NFT on a value-keeping rebalance", async function () {
      // The mock re-mints amount0 + amount1, so liquidity = principal sum keeps it exactly.
      const liquidity = TOKENS(1_000) * 2n;
      const tokenId = await createPosition(alice, liquidity);
      await vault.connect(alice).stake(tokenId);
      await reserve(tokenId, alice);

      const newId = await vault
        .connect(alice)
        .rebalance.staticCall(tokenId, TICK_LOWER, TICK_UPPER, NO_SWAP, FAR_DEADLINE);
      await expect(vault.connect(alice).rebalance(tokenId, TICK_LOWER, TICK_UPPER, NO_SWAP, FAR_DEADLINE))
        .to.emit(escrow, "BonusMoved")
        .withArgs(tokenId, newId, alice.address, BONUS, BONUS);
      expect(await vault.stakerOf(newId)).to.equal(alice.address);
      expect((await escrow.reservationOf(newId)).amount).to.equal(BONUS);
    });

    it("scales the bonus when the rebalance returns half the tokens to the staker", async function () {
      const liquidity = TOKENS(1_000) * 2n;
      const tokenId = await createPosition(alice, liquidity);
      await vault.connect(alice).stake(tokenId);
      await reserve(tokenId, alice);
      await nfpm.setMintConsumeBps(5_000); // the new mint keeps half, the rest is refunded

      const newId = await vault
        .connect(alice)
        .rebalance.staticCall(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, NO_SWAP, FAR_DEADLINE);
      await vault.connect(alice).rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, NO_SWAP, FAR_DEADLINE);

      const [, , , , , , , newLiquidity] = await nfpm.positions(newId);
      const expected = scaledAmount(
        BONUS,
        valueAt(liquidity, TICK_LOWER, TICK_UPPER, 0, bonusIsToken0),
        valueAt(newLiquidity, NEW_TICK_LOWER, NEW_TICK_UPPER, 0, bonusIsToken0)
      );
      expect(expected).to.be.lt(BONUS);
      expect((await escrow.reservationOf(newId)).amount).to.equal(expected);
      expect(await escrow.totalReserved()).to.equal(expected);
    });

    it("lets a position with no reservation rebalance while the oracle is down", async function () {
      const tokenId = await createPosition(alice, 1_000_000n);
      await vault.connect(alice).stake(tokenId);
      await pool.setObserveReverts(true);

      await expect(
        vault.connect(alice).rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, NO_SWAP, FAR_DEADLINE)
      ).to.emit(vault, "Rebalanced");
    });

    it("fails a bonus position's rebalance closed without the oracle, and the exit stays open", async function () {
      const tokenId = await createPosition(alice, 1_000_000n);
      await vault.connect(alice).stake(tokenId);
      await reserve(tokenId, alice);
      await pool.setObserveReverts(true);

      await expect(
        vault.connect(alice).rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, NO_SWAP, FAR_DEADLINE)
      ).to.be.revertedWith("OLD");
      await expect(vault.connect(alice).unstake(tokenId)).to.emit(escrow, "BonusForfeited");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("recoverSurplus", function () {
    beforeEach(async function () {
      await escrow.setAdapter(adapter.address);
    });

    it("moves exactly the unreserved balance", async function () {
      await asset.transfer(escrowAddr, FUNDING);
      await reserve(1n, alice, TOKENS(400));

      await expect(escrow.recoverSurplus(treasury.address))
        .to.emit(escrow, "SurplusRecovered")
        .withArgs(treasury.address, FUNDING - TOKENS(400));
      expect(await asset.balanceOf(treasury.address)).to.equal(FUNDING - TOKENS(400));
      expect(await asset.balanceOf(escrowAddr)).to.equal(TOKENS(400));
    });

    it("reverts NoSurplus when every wei is owed", async function () {
      await asset.transfer(escrowAddr, BONUS);
      await reserve(1n, alice, BONUS);
      await expect(escrow.recoverSurplus(treasury.address)).to.be.revertedWithCustomError(
        escrow,
        "NoSurplus"
      );
    });

    it("reverts NoSurplus while more is owed than held", async function () {
      await asset.transfer(escrowAddr, TOKENS(50));
      await reserve(1n, alice, TOKENS(100));
      await expect(escrow.recoverSurplus(treasury.address)).to.be.revertedWithCustomError(
        escrow,
        "NoSurplus"
      );
      expect(await asset.balanceOf(escrowAddr)).to.equal(TOKENS(50));
    });

    it("returns a forfeited bonus to the recoverable surplus", async function () {
      await asset.transfer(escrowAddr, BONUS);
      await reserve(1n, alice, BONUS);
      await asVault((e) => e.onUnstake(1n));

      await expect(escrow.recoverSurplus(treasury.address))
        .to.emit(escrow, "SurplusRecovered")
        .withArgs(treasury.address, BONUS);
    });

    it("is owner-only, and refuses address zero", async function () {
      await asset.transfer(escrowAddr, FUNDING);
      for (const caller of [adapter, alice]) {
        await expect(escrow.connect(caller).recoverSurplus(caller.address))
          .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount")
          .withArgs(caller.address);
      }
      await expect(escrow.recoverSurplus(ZERO)).to.be.revertedWithCustomError(escrow, "ZeroAddress");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Upgradeability", function () {
    const V2_ARGS = { unsafeAllow: [...UNSAFE_ALLOW, "missing-initializer"] };

    async function v2Factory() {
      return ethers.getContractFactory("BonusEscrowV2Mock");
    }

    beforeEach(async function () {
      await escrow.setAdapter(adapter.address);
    });

    it("passes the plugin's own implementation-safety check", async function () {
      await upgrades.validateImplementation(await v2Factory(), {
        kind: "uups",
        constructorArgs: [assetAddr, vaultAddr],
        ...V2_ARGS,
      });
    });

    it("keeps every reservation — forfeited ones included — the total and the roles", async function () {
      const cliff = await reserve(1n, alice, TOKENS(100));
      await reserve(2n, bob, TOKENS(250));
      await asVault((e) => e.onUnstake(2n));

      const upgraded = await upgrades.upgradeProxy(escrowAddr, await v2Factory(), {
        kind: "uups",
        constructorArgs: [assetAddr, vaultAddr],
        call: { fn: "initializeV2", args: [42] },
        ...V2_ARGS,
      });

      expect(await upgraded.version()).to.equal(2n);
      expect(await upgraded.upgradeMarker()).to.equal(42n);
      expect(await upgraded.totalReserved()).to.equal(TOKENS(100));
      expect(await upgraded.adapter()).to.equal(adapter.address);
      expect(await upgraded.vault()).to.equal(vaultAddr);
      expect((await upgraded.reservationOf(2n)).forfeited).to.equal(true);

      await asset.transfer(escrowAddr, TOKENS(100));
      await time.increaseTo(cliff);
      await expect(upgraded.claim(1n))
        .to.emit(upgraded, "BonusClaimed")
        .withArgs(1n, alice.address, TOKENS(100));
    });

    it("rejects upgradeToAndCall from anyone but the owner", async function () {
      const V2 = await v2Factory();
      const impl = await V2.deploy(assetAddr, vaultAddr);
      const implAddr = await impl.getAddress();

      for (const caller of [alice, adapter, treasury]) {
        await expect(escrow.connect(caller).upgradeToAndCall(implAddr, "0x"))
          .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount")
          .withArgs(caller.address);
      }
      await expect(escrow.upgradeToAndCall(implAddr, "0x")).to.emit(escrow, "Upgraded").withArgs(implAddr);
    });

    it("upgrades in place through an LPTimelock that owns it, after the delay, book intact", async function () {
      const DELAY = 60;
      const Timelock = await ethers.getContractFactory("LPTimelock");
      const timelock = await Timelock.deploy(DELAY, [owner.address], [owner.address], ZERO);
      const timelockAddr = await timelock.getAddress();

      const owned = await deployEscrowProxy(assetAddr, vaultAddr, timelockAddr, adapter.address);
      const ownedAddr = await owned.getAddress();
      const cliff = await cliffIn(HOUR);
      await owned.connect(adapter).reserve(5n, alice.address, BONUS, cliff);

      const implAddr = await upgrades.prepareUpgrade(ownedAddr, await v2Factory(), {
        kind: "uups",
        constructorArgs: [assetAddr, vaultAddr],
        ...V2_ARGS,
      });

      // The owner key itself is NOT the owner any more: only the timelock may upgrade.
      await expect(owned.upgradeToAndCall(implAddr, "0x"))
        .to.be.revertedWithCustomError(owned, "OwnableUnauthorizedAccount")
        .withArgs(owner.address);

      const data = owned.interface.encodeFunctionData("upgradeToAndCall", [implAddr, "0x"]);
      const salt = ethers.id("bonus-escrow-upgrade");
      await timelock.schedule(ownedAddr, 0, data, ethers.ZeroHash, salt, DELAY);
      await expect(timelock.execute(ownedAddr, 0, data, ethers.ZeroHash, salt)).to.be.reverted;

      await time.increase(DELAY + 1);
      await timelock.execute(ownedAddr, 0, data, ethers.ZeroHash, salt);

      const upgraded = await ethers.getContractAt("BonusEscrowV2Mock", ownedAddr);
      expect(await upgraded.version()).to.equal(2n);
      expect(await upgraded.owner()).to.equal(timelockAddr);
      expect(await upgraded.totalReserved()).to.equal(BONUS);
      const r = await upgraded.reservationOf(5n);
      expect(r.beneficiary).to.equal(alice.address);
      expect(r.unlockAt).to.equal(cliff);
    });
  });
});
