const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const {
  APEBOND_CAMPAIGN_ID,
  APEBOND_BONUS_BPS,
  APEBOND_MIN_BONUS,
  APEBOND_CLIFF_SECONDS,
} = require("./helpers/constants");
const { valueAt, bonusFor } = require("./helpers/positionValue");

/**
 * ApeBondPositionAdapter — the gate between SoulZap and the vault, after the B.3 refactor
 * (decision document 2026-10-01, overrides 2026-10-05).
 *
 * What this suite proves:
 *   - THE CONTRACT COMPUTES THE BONUS (P1). There is no signature, no purchase id and no bonus
 *     number in the call: `depositFor(tokenId, campaignId, beneficiary)` values the position at
 *     the vault's TWAP and takes the campaign's rate of it, zero below the campaign's minimum
 *     (D6). The expected figure is computed here, independently, from `helpers/positionValue.js`
 *     (a BigInt port of the Uniswap math), and cross-checked against `previewBonus`.
 *   - A campaign carries exactly range, cliff, rate and minimum — no cap of any kind (O2) — and
 *     the escrow records the bonus whatever its balance is.
 *   - The order of the twelve steps: every rejection fires with the values its error names, and
 *     a failed purchase leaves nothing behind.
 *   - THE LOOP (P2): buy and unstake in one transaction forfeits the bonus.
 *   - The two admin tiers (timelock owner: campaigns, callers, guardian; guardian: the pause) and
 *     the NFT receipt window.
 *   - `depositFor` writes nothing to the adapter's own storage.
 *
 * The local stack is the repo's mocks: the pool mock's spot and TWAP are both tick 0 unless a
 * test moves them, and the position manager mock fabricates positions with `mintFake`.
 */
describe("ApeBondPositionAdapter", function () {
  let adapter, vault, escrow, soulZap, nfpm, pool, router;
  let asset, quote;
  let owner, guardian, alice, bob, stranger, keeper;

  let adapterAddr, vaultAddr, escrowAddr, soulZapAddr, nfpmAddr, poolAddr, routerAddr;
  let assetAddr, quoteAddr, token0Addr, token1Addr;
  let bonusIsToken0;

  const asGuardian = () => adapter.connect(guardian);

  const FEE = 3000;
  const OTHER_FEE = 500;
  const TICK_SPACING = 60;
  const TWAP_WINDOW = 600;
  const MAX_DEVIATION_TICKS = 500;
  const TICK_LOWER = -600;
  const TICK_UPPER = 600;
  const LIQUIDITY = 10n ** 24n; // worth ~5.9e22 token units at tick 0: a bonus well above the minimum
  const SMALL_LIQUIDITY = 10n ** 18n; // its bonus is far below the 1-token minimum
  const FAR_DEADLINE = 10n ** 12n;
  const ZERO = ethers.ZeroAddress;
  const UNSAFE_ALLOW = ["constructor", "state-variable-immutable"];
  const CAMPAIGN = APEBOND_CAMPAIGN_ID;
  const OTHER_CAMPAIGN = ethers.id("apebond.campaign.other");
  const TOKENS = (n) => ethers.parseEther(String(n));

  // MockSoulZapCaller.Approval
  const APPROVE_FOR_ALL = 1;
  const APPROVE_NONE = 2;

  const NO_SWAP = { zeroForOne: true, amountIn: 0n, amountOutMin: 0n, amount0Min: 0n, amount1Min: 0n };

  function campaignConfig(overrides = {}) {
    return {
      enabled: true,
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      bonusCliffSeconds: BigInt(APEBOND_CLIFF_SECONDS),
      bonusBps: APEBOND_BONUS_BPS,
      minBonusAmount: APEBOND_MIN_BONUS,
      ...overrides,
    };
  }

  // ── deployment helpers ─────────────────────────────────────────

  async function deployVaultProxy(poolAddress = poolAddr) {
    const Vault = await ethers.getContractFactory("LPStakingVault");
    return upgrades.deployProxy(
      Vault,
      [owner.address, guardian.address, owner.address, ZERO, TWAP_WINDOW, MAX_DEVIATION_TICKS],
      {
        kind: "uups",
        constructorArgs: [nfpmAddr, poolAddress, token0Addr, token1Addr, FEE, routerAddr],
        unsafeAllow: UNSAFE_ALLOW,
      }
    );
  }

  async function deployEscrowProxy(bonusToken = assetAddr, forVault = vaultAddr) {
    const Escrow = await ethers.getContractFactory("BonusEscrow");
    return upgrades.deployProxy(Escrow, [owner.address, ZERO], {
      kind: "uups",
      constructorArgs: [bonusToken, forVault],
      unsafeAllow: UNSAFE_ALLOW,
    });
  }

  async function deployAdapter(overrides = {}) {
    const args = {
      positionManager: nfpmAddr,
      vault: vaultAddr,
      escrow: escrowAddr,
      initialOwner: owner.address,
      guardian: guardian.address,
      ...overrides,
    };
    const Adapter = await ethers.getContractFactory("ApeBondPositionAdapter");
    return Adapter.deploy(args.positionManager, args.vault, args.escrow, args.initialOwner, args.guardian);
  }

  /// Fabricates a position NFT for `holder`; principal is funded so the vault's later paths work.
  async function createPosition(holder, opts = {}) {
    const {
      tickLower = TICK_LOWER,
      tickUpper = TICK_UPPER,
      liquidity = LIQUIDITY,
      poolToken0 = token0Addr,
      poolToken1 = token1Addr,
      poolFee = FEE,
    } = opts;
    const principal = TOKENS(1_000);
    await nfpm.mintFake(
      holder,
      poolToken0,
      poolToken1,
      poolFee,
      tickLower,
      tickUpper,
      liquidity,
      principal,
      principal
    );
    await asset.transfer(nfpmAddr, principal);
    await quote.transfer(nfpmAddr, principal);
    return nfpm.lastMintedId();
  }

  /// The production shape in one call: SoulZap holds the NFT, approves the adapter and calls
  /// `depositFor` in the same transaction.
  async function deposit(opts = {}) {
    const tokenId = opts.tokenId ?? (await createPosition(soulZapAddr, opts.position ?? {}));
    const tx = soulZap.deposit(
      adapterAddr,
      nfpmAddr,
      tokenId,
      opts.campaignId ?? CAMPAIGN,
      opts.beneficiary ?? alice.address
    );
    return { tx, tokenId };
  }

  /// The bonus the adapter must compute for `liquidity` on the campaign range at `tick`.
  function expected(liquidity = LIQUIDITY, tick = 0, config = campaignConfig()) {
    const value = valueAt(liquidity, config.tickLower, config.tickUpper, tick, bonusIsToken0);
    return { value, bonus: bonusFor(value, config.bonusBps, config.minBonusAmount) };
  }

  async function txTimestamp(tx) {
    const receipt = await (await tx).wait();
    return BigInt((await ethers.provider.getBlock(receipt.blockNumber)).timestamp);
  }

  beforeEach(async function () {
    [owner, guardian, alice, bob, stranger, keeper] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockERC20Decimals");
    asset = await Token.deploy("Asset", "ASSET", TOKENS(100_000_000), 18);
    quote = await Token.deploy("Quote", "QUOTE", TOKENS(100_000_000), 18);
    assetAddr = await asset.getAddress();
    quoteAddr = await quote.getAddress();
    [token0Addr, token1Addr] =
      assetAddr.toLowerCase() < quoteAddr.toLowerCase() ? [assetAddr, quoteAddr] : [quoteAddr, assetAddr];
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

    vault = await deployVaultProxy();
    vaultAddr = await vault.getAddress();

    escrow = await deployEscrowProxy();
    escrowAddr = await escrow.getAddress();

    adapter = await deployAdapter();
    adapterAddr = await adapter.getAddress();

    const SoulZap = await ethers.getContractFactory("MockSoulZapCaller");
    soulZap = await SoulZap.deploy();
    soulZapAddr = await soulZap.getAddress();

    // The deploy scripts' timelock link batch, then the campaign wiring.
    await vault.setBonusEscrow(escrowAddr);
    await vault.setStakeOperator(adapterAddr, true);
    await escrow.setAdapter(adapterAddr);
    await adapter.setSoulZapCaller(soulZapAddr, true);
    await adapter.setCampaign(CAMPAIGN, campaignConfig());
    await adapter.setCampaignCaller(CAMPAIGN, soulZapAddr, true);
  });

  // ─────────────────────────────────────────────────────────────
  describe("Deployment", function () {
    it("reads the pool from the vault and the bonus side from the escrow", async function () {
      expect(await adapter.positionManager()).to.equal(nfpmAddr);
      expect(await adapter.vault()).to.equal(vaultAddr);
      expect(await adapter.escrow()).to.equal(escrowAddr);
      expect(await adapter.token0()).to.equal(token0Addr);
      expect(await adapter.token1()).to.equal(token1Addr);
      expect(await adapter.fee()).to.equal(FEE);
      expect(await adapter.tickSpacing()).to.equal(TICK_SPACING);
      expect(await adapter.bonusIsToken0()).to.equal(bonusIsToken0);
      expect(await adapter.BPS()).to.equal(10_000n);
      expect(await adapter.owner()).to.equal(owner.address);
      expect(await adapter.guardian()).to.equal(guardian.address);
      expect(await adapter.depositsPaused()).to.equal(false);
    });

    it("announces the guardian and the open deposit switch from block one", async function () {
      const fresh = await deployAdapter();
      await expect(fresh.deploymentTransaction())
        .to.emit(fresh, "GuardianSet")
        .withArgs(ZERO, guardian.address);
      await expect(fresh.deploymentTransaction()).to.emit(fresh, "DepositsPausedSet").withArgs(false);
    });

    it("values in token1 when the escrow pays in token1", async function () {
      const other = token0Addr === assetAddr ? token1Addr : token0Addr;
      const otherEscrow = await deployEscrowProxy(other);
      const otherAdapter = await deployAdapter({ escrow: await otherEscrow.getAddress() });
      expect(await otherAdapter.bonusIsToken0()).to.equal(other === token0Addr);
    });

    it("rejects a zero position manager, vault, escrow or guardian, and a zero owner", async function () {
      const Adapter = await ethers.getContractFactory("ApeBondPositionAdapter");
      for (const key of ["positionManager", "vault", "escrow", "guardian"]) {
        await expect(deployAdapter({ [key]: ZERO })).to.be.revertedWithCustomError(Adapter, "ZeroAddress");
      }
      await expect(deployAdapter({ initialOwner: ZERO }))
        .to.be.revertedWithCustomError(Adapter, "OwnableInvalidOwner")
        .withArgs(ZERO);
    });

    it("rejects an escrow linked to a different vault", async function () {
      const Adapter = await ethers.getContractFactory("ApeBondPositionAdapter");
      const otherVault = await deployVaultProxy();
      const otherVaultAddr = await otherVault.getAddress();
      const foreignEscrow = await deployEscrowProxy(assetAddr, otherVaultAddr);

      await expect(deployAdapter({ escrow: await foreignEscrow.getAddress() }))
        .to.be.revertedWithCustomError(Adapter, "EscrowVaultMismatch")
        .withArgs(otherVaultAddr, vaultAddr);
    });

    it("has no signature, purchase id, cap, rescue, sweep or arbitrary-call surface", async function () {
      const names = adapter.interface.fragments.filter((f) => f.type === "function").map((f) => f.name);
      for (const forbidden of [
        "purchaseSigner",
        "setPurchaseSigner",
        "hashPurchaseAuthorization",
        "PURCHASE_AUTHORIZATION_TYPEHASH",
        "consumedNonces",
        "consumedPurchaseIds",
        "campaignAllocatedBonus",
        "remainingCampaignBonus",
        "maxTotalBonus",
        "maxBonusPerPurchase",
        "rescuePosition",
        "sweep",
        "execute",
        "multicall",
        "eip712Domain",
      ]) {
        expect(names).to.not.include(forbidden);
      }
      // depositFor is the three-argument form: no struct, no signature.
      expect(adapter.interface.getFunction("depositFor").inputs.map((i) => i.type)).to.deep.equal([
        "uint256",
        "bytes32",
        "address",
      ]);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("depositFor — the contract computes the bonus", function () {
    it("stakes for the beneficiary and reserves value x rate under the tokenId", async function () {
      const { tx, tokenId } = await deposit();
      const ts = await txTimestamp(tx);
      const { bonus } = expected();

      expect(await nfpm.ownerOf(tokenId)).to.equal(vaultAddr);
      expect(await vault.stakerOf(tokenId)).to.equal(alice.address);

      const r = await escrow.reservationOf(tokenId);
      expect(r.beneficiary).to.equal(alice.address);
      expect(r.amount).to.equal(bonus);
      expect(r.unlockAt).to.equal(ts + BigInt(APEBOND_CLIFF_SECONDS));
      expect(r.forfeited).to.equal(false);
      expect(await escrow.totalReserved()).to.equal(bonus);

      // Nothing stays with the adapter, and the escrow did not need a balance (O2).
      expect(await nfpm.balanceOf(adapterAddr)).to.equal(0n);
      expect(await asset.balanceOf(adapterAddr)).to.equal(0n);
      expect(await asset.balanceOf(escrowAddr)).to.equal(0n);
    });

    it("emits ApeBondPositionDeposited with the position, the price, the value and the bonus", async function () {
      const { tx, tokenId } = await deposit();
      const ts = await txTimestamp(tx);
      const { value, bonus } = expected();

      await expect(tx)
        .to.emit(adapter, "ApeBondPositionDeposited")
        .withArgs(
          tokenId,
          CAMPAIGN,
          alice.address,
          LIQUIDITY,
          TICK_LOWER,
          TICK_UPPER,
          0,
          value,
          bonus,
          ts + BigInt(APEBOND_CLIFF_SECONDS)
        );
    });

    it("makes the vault and the escrow speak in the same transaction", async function () {
      const { tx, tokenId } = await deposit();
      const ts = await txTimestamp(tx);
      const { bonus } = expected();

      await expect(tx)
        .to.emit(vault, "Staked")
        .withArgs(alice.address, tokenId, TICK_LOWER, TICK_UPPER, LIQUIDITY, ts);
      await expect(tx)
        .to.emit(escrow, "BonusReserved")
        .withArgs(tokenId, alice.address, bonus, ts + BigInt(APEBOND_CLIFF_SECONDS));
    });

    it("agrees with previewBonus, which runs the same formula", async function () {
      const [value, bonus, twapTick] = await adapter.previewBonus(CAMPAIGN, LIQUIDITY);
      const ref = expected();
      expect(value).to.equal(ref.value);
      expect(bonus).to.equal(ref.bonus);
      expect(twapTick).to.equal(0n);

      await expect(adapter.previewBonus(OTHER_CAMPAIGN, LIQUIDITY))
        .to.be.revertedWithCustomError(adapter, "UnknownCampaign")
        .withArgs(OTHER_CAMPAIGN);
    });

    it("values the position at the vault's TWAP, not at spot", async function () {
      await pool.setTicks(100, 50); // spot 100, TWAP 50: inside the 500-tick bound
      const atTwap = expected(LIQUIDITY, 50);
      const atSpot = expected(LIQUIDITY, 100);
      expect(atTwap.bonus).to.not.equal(atSpot.bonus);

      const { tx, tokenId } = await deposit();
      await tx;
      expect((await escrow.reservationOf(tokenId)).amount).to.equal(atTwap.bonus);
      await expect(tx).to.emit(adapter, "ApeBondPositionDeposited");
    });

    it("stakes a purchase whose bonus is below the minimum, with no reservation (D6)", async function () {
      const { bonus } = expected(SMALL_LIQUIDITY);
      expect(bonus).to.equal(0n);

      const { tx, tokenId } = await deposit({ position: { liquidity: SMALL_LIQUIDITY } });
      await expect(tx).to.not.emit(escrow, "BonusReserved");
      await expect(tx)
        .to.emit(adapter, "ApeBondPositionDeposited")
        .withArgs(
          tokenId,
          CAMPAIGN,
          alice.address,
          SMALL_LIQUIDITY,
          TICK_LOWER,
          TICK_UPPER,
          0,
          expected(SMALL_LIQUIDITY).value,
          0n,
          0n
        );
      expect(await vault.stakerOf(tokenId)).to.equal(alice.address);
      expect((await escrow.reservationOf(tokenId)).beneficiary).to.equal(ZERO);
    });

    it("treats the minimum as inclusive: a bonus equal to it is reserved, one wei less is not", async function () {
      const raw = (expected().value * APEBOND_BONUS_BPS) / 10_000n;

      await adapter.setCampaign(CAMPAIGN, campaignConfig({ minBonusAmount: raw }));
      const { tx: atMin, tokenId: first } = await deposit();
      await atMin;
      expect((await escrow.reservationOf(first)).amount).to.equal(raw);

      await adapter.setCampaign(CAMPAIGN, campaignConfig({ minBonusAmount: raw + 1n }));
      const { tx: below, tokenId: second } = await deposit();
      await expect(below).to.not.emit(escrow, "BonusReserved");
      expect((await escrow.reservationOf(second)).beneficiary).to.equal(ZERO);
    });

    it("reserves nothing for a zero rate and everything for a 10,000-bps rate", async function () {
      await adapter.setCampaign(CAMPAIGN, campaignConfig({ bonusBps: 0, minBonusAmount: 0n }));
      const { tx, tokenId } = await deposit();
      await expect(tx).to.not.emit(escrow, "BonusReserved");
      expect(await vault.stakerOf(tokenId)).to.equal(alice.address);

      await adapter.setCampaign(CAMPAIGN, campaignConfig({ bonusBps: 10_000, minBonusAmount: 0n }));
      const { tx: whole, tokenId: id2 } = await deposit();
      await whole;
      expect((await escrow.reservationOf(id2)).amount).to.equal(expected().value);
    });

    it("unlocks at the deposit time when the cliff is zero — a bonus that can no longer be forfeited", async function () {
      await adapter.setCampaign(CAMPAIGN, campaignConfig({ bonusCliffSeconds: 0n }));
      const { tx, tokenId } = await deposit();
      const ts = await txTimestamp(tx);
      expect((await escrow.reservationOf(tokenId)).unlockAt).to.equal(ts);
      expect(await escrow.isActive(tokenId)).to.equal(false);
    });

    it("accepts an operator-for-all approval as well as a per-token one", async function () {
      await soulZap.setApprovalMode(APPROVE_FOR_ALL);
      const { tx, tokenId } = await deposit();
      await tx;
      expect(await vault.stakerOf(tokenId)).to.equal(alice.address);
    });

    it("gives every purchase its own reservation, keyed by its own NFT", async function () {
      const a = await deposit();
      await a.tx;
      const b = await deposit({ beneficiary: bob.address });
      await b.tx;
      expect((await escrow.reservationOf(b.tokenId)).beneficiary).to.equal(bob.address);
      expect(await escrow.totalReserved()).to.equal(expected().bonus * 2n);
    });

    it("writes nothing to the adapter's own storage", async function () {
      const slots = [];
      for (let i = 0; i < 8; i++) slots.push(await ethers.provider.getStorage(adapterAddr, i));
      const { tx } = await deposit();
      await tx;
      for (let i = 0; i < 8; i++) {
        expect(await ethers.provider.getStorage(adapterAddr, i)).to.equal(slots[i]);
      }
    });

    it("affects only later purchases when a campaign is reconfigured", async function () {
      const first = await deposit();
      const ts = await txTimestamp(first.tx);
      const before = await escrow.reservationOf(first.tokenId);

      await adapter.setCampaign(CAMPAIGN, campaignConfig({ bonusBps: 2_000, bonusCliffSeconds: 999n }));
      const r = await escrow.reservationOf(first.tokenId);
      expect(r.amount).to.equal(before.amount);
      expect(r.unlockAt).to.equal(ts + BigInt(APEBOND_CLIFF_SECONDS));

      const second = await deposit();
      await second.tx;
      expect((await escrow.reservationOf(second.tokenId)).amount).to.equal(
        expected(LIQUIDITY, 0, campaignConfig({ bonusBps: 2_000 })).bonus
      );
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("depositFor — the rejections, in order", function () {
    it("1. refuses while the adapter's own deposits are paused", async function () {
      await asGuardian().setDepositsPaused(true);
      const { tx } = await deposit();
      await expect(tx).to.be.revertedWithCustomError(adapter, "DepositsArePaused");
    });

    it("2a. refuses a caller that is not on the global allowlist", async function () {
      const tokenId = await createPosition(stranger.address);
      await nfpm.connect(stranger).approve(adapterAddr, tokenId);
      await expect(adapter.connect(stranger).depositFor(tokenId, CAMPAIGN, alice.address))
        .to.be.revertedWithCustomError(adapter, "NotSoulZapCaller")
        .withArgs(stranger.address);
    });

    it("2b. refuses a caller allowed globally but not for this campaign", async function () {
      await adapter.setCampaign(OTHER_CAMPAIGN, campaignConfig());
      const { tx } = await deposit({ campaignId: OTHER_CAMPAIGN });
      await expect(tx)
        .to.be.revertedWithCustomError(adapter, "NotCampaignCaller")
        .withArgs(OTHER_CAMPAIGN, soulZapAddr);
    });

    it("2c. refuses a caller removed from the campaign, and one removed from the allowlist", async function () {
      await adapter.setCampaignCaller(CAMPAIGN, soulZapAddr, false);
      await expect((await deposit()).tx)
        .to.be.revertedWithCustomError(adapter, "NotCampaignCaller")
        .withArgs(CAMPAIGN, soulZapAddr);

      await adapter.setCampaignCaller(CAMPAIGN, soulZapAddr, true);
      await adapter.setSoulZapCaller(soulZapAddr, false);
      await expect((await deposit()).tx)
        .to.be.revertedWithCustomError(adapter, "NotSoulZapCaller")
        .withArgs(soulZapAddr);
    });

    it("3a. refuses a campaign that was never configured, even for a pre-authorized caller", async function () {
      await adapter.setCampaignCaller(OTHER_CAMPAIGN, soulZapAddr, true);
      const { tx } = await deposit({ campaignId: OTHER_CAMPAIGN });
      await expect(tx).to.be.revertedWithCustomError(adapter, "UnknownCampaign").withArgs(OTHER_CAMPAIGN);
    });

    it("3b. refuses a disabled campaign, and accepts it again once re-enabled", async function () {
      await adapter.setCampaignEnabled(CAMPAIGN, false);
      await expect((await deposit()).tx)
        .to.be.revertedWithCustomError(adapter, "CampaignDisabled")
        .withArgs(CAMPAIGN);

      await adapter.setCampaignEnabled(CAMPAIGN, true);
      const { tx, tokenId } = await deposit();
      await tx;
      expect(await vault.stakerOf(tokenId)).to.equal(alice.address);
    });

    it("4. refuses a zero, adapter, vault or position-manager beneficiary (SEC-05)", async function () {
      for (const beneficiary of [ZERO, adapterAddr, vaultAddr, nfpmAddr]) {
        await expect((await deposit({ beneficiary })).tx)
          .to.be.revertedWithCustomError(adapter, "InvalidBeneficiary")
          .withArgs(beneficiary);
      }
    });

    it("5a. refuses an NFT the caller does not own", async function () {
      const tokenId = await createPosition(alice.address);
      // The caller cannot approve an NFT it does not own, so it skips the approval step and
      // the adapter's own ownership check is what refuses it.
      await soulZap.setApprovalMode(APPROVE_NONE);
      const { tx } = await deposit({ tokenId });
      await expect(tx)
        .to.be.revertedWithCustomError(adapter, "NftNotHeldByCaller")
        .withArgs(tokenId, alice.address, soulZapAddr);
    });

    it("5b. refuses an NFT the adapter was never approved for", async function () {
      await soulZap.setApprovalMode(APPROVE_NONE);
      const { tx, tokenId } = await deposit();
      await expect(tx)
        .to.be.revertedWithCustomError(adapter, "NftNotApproved")
        .withArgs(tokenId, soulZapAddr);
    });

    it("6a. refuses a position on another pair or another fee tier", async function () {
      const Token = await ethers.getContractFactory("MockERC20Decimals");
      const foreign = await Token.deploy("Foreign", "FRN", TOKENS(1), 18);
      const foreignAddr = await foreign.getAddress();

      const wrongPair = await deposit({ position: { poolToken1: foreignAddr } });
      await expect(wrongPair.tx)
        .to.be.revertedWithCustomError(adapter, "PositionPoolMismatch")
        .withArgs(wrongPair.tokenId, token0Addr, foreignAddr, FEE);

      const wrongFee = await deposit({ position: { poolFee: OTHER_FEE } });
      await expect(wrongFee.tx)
        .to.be.revertedWithCustomError(adapter, "PositionPoolMismatch")
        .withArgs(wrongFee.tokenId, token0Addr, token1Addr, OTHER_FEE);
    });

    it("6b. refuses a range that is not the campaign's exact one, even a wider one", async function () {
      const { tx } = await deposit({ position: { tickLower: TICK_LOWER - TICK_SPACING } });
      await expect(tx)
        .to.be.revertedWithCustomError(adapter, "TickRangeMismatch")
        .withArgs(TICK_LOWER - TICK_SPACING, TICK_UPPER, TICK_LOWER, TICK_UPPER);
    });

    it("6c. refuses an empty position", async function () {
      const { tx, tokenId } = await deposit({ position: { liquidity: 0n } });
      await expect(tx).to.be.revertedWithCustomError(adapter, "EmptyPosition").withArgs(tokenId);
    });

    it("7. refuses while spot is outside the vault's TWAP bounds", async function () {
      await pool.setTicks(MAX_DEVIATION_TICKS + 1, 0);
      const { tx } = await deposit();
      await expect(tx)
        .to.be.revertedWithCustomError(adapter, "PriceOutsideTwapBounds")
        .withArgs(MAX_DEVIATION_TICKS + 1, 0, MAX_DEVIATION_TICKS);

      await pool.setTicks(MAX_DEVIATION_TICKS, 0); // the bound itself is inside
      await (
        await deposit()
      ).tx;
    });

    it("takes the vault's own deposit pause with it", async function () {
      await vault.connect(guardian).setDepositsPaused(true);
      const { tx } = await deposit();
      await expect(tx).to.be.revertedWithCustomError(vault, "DepositsArePaused");
      expect(await adapter.depositsPaused()).to.equal(false);
    });

    it("reverts the whole purchase when the adapter is not a stake operator", async function () {
      await vault.setStakeOperator(adapterAddr, false);
      const { tx } = await deposit();
      await expect(tx).to.be.revertedWithCustomError(vault, "NotZapper").withArgs(adapterAddr, ZERO);
    });

    it("reverts the whole purchase when the escrow no longer accepts this adapter", async function () {
      await escrow.setAdapter(ZERO);
      const { tx } = await deposit();
      await expect(tx).to.be.revertedWithCustomError(escrow, "NotAdapter").withArgs(adapterAddr, ZERO);
    });

    it("refuses to carry a second bonus on the same NFT after an exit", async function () {
      const { tx, tokenId } = await deposit({ beneficiary: soulZapAddr });
      await tx;
      await soulZap.execute(vaultAddr, vault.interface.encodeFunctionData("unstake", [tokenId]));

      const again = await deposit({ tokenId, beneficiary: alice.address });
      await expect(again.tx).to.be.revertedWithCustomError(escrow, "DuplicateReservation").withArgs(tokenId);
    });

    it("refuses the same NFT twice inside one transaction", async function () {
      const tokenId = await createPosition(soulZapAddr);
      await expect(soulZap.depositTwice(adapterAddr, nfpmAddr, tokenId, CAMPAIGN, alice.address))
        .to.be.revertedWithCustomError(adapter, "NftNotHeldByCaller")
        .withArgs(tokenId, vaultAddr, soulZapAddr);
    });

    it("leaves nothing behind after a failed purchase", async function () {
      await escrow.setAdapter(ZERO);
      const { tx, tokenId } = await deposit();
      await expect(tx).to.be.reverted;

      expect(await nfpm.ownerOf(tokenId)).to.equal(soulZapAddr);
      expect(await nfpm.balanceOf(adapterAddr)).to.equal(0n);
      expect(await vault.stakerOf(tokenId)).to.equal(ZERO);
      expect(await escrow.totalReserved()).to.equal(0n);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("The loop and the bonus after the purchase", function () {
    it("forfeits the bonus when the buyer unstakes in the purchase transaction (P2)", async function () {
      const tokenId = await createPosition(soulZapAddr);
      const { bonus } = expected();
      await asset.transfer(escrowAddr, bonus); // funded: only the forfeiture can stop the claim

      const tx = soulZap.depositAndUnstake(adapterAddr, nfpmAddr, tokenId, CAMPAIGN, vaultAddr);
      await expect(tx).to.emit(escrow, "BonusReserved");
      await expect(tx).to.emit(escrow, "BonusForfeited").withArgs(tokenId, soulZapAddr, bonus);

      expect(await escrow.totalReserved()).to.equal(0n);
      expect(await nfpm.ownerOf(tokenId)).to.equal(soulZapAddr);
      await time.increase(APEBOND_CLIFF_SECONDS);
      await expect(escrow.claim(tokenId))
        .to.be.revertedWithCustomError(escrow, "Forfeited")
        .withArgs(tokenId);
    });

    it("pays the bonus to a buyer who stays staked through the cliff, once the escrow is funded", async function () {
      const { tx, tokenId } = await deposit();
      await tx;
      const { bonus } = expected();
      await time.increase(APEBOND_CLIFF_SECONDS);

      await expect(escrow.claim(tokenId))
        .to.be.revertedWithCustomError(escrow, "InsufficientFunds")
        .withArgs(bonus, 0n);

      await asset.transfer(escrowAddr, bonus);
      await vault.connect(alice).unstake(tokenId); // after the cliff: forfeits nothing
      await expect(escrow.connect(keeper).claim(tokenId))
        .to.emit(escrow, "BonusClaimed")
        .withArgs(tokenId, alice.address, bonus);
    });

    it("moves the bonus to the new NFT when the buyer rebalances before the cliff", async function () {
      const { tx, tokenId } = await deposit();
      await tx;
      const newId = await vault
        .connect(alice)
        .rebalance.staticCall(tokenId, TICK_LOWER, TICK_UPPER, NO_SWAP, FAR_DEADLINE);
      await expect(
        vault.connect(alice).rebalance(tokenId, TICK_LOWER, TICK_UPPER, NO_SWAP, FAR_DEADLINE)
      ).to.emit(escrow, "BonusMoved");
      expect((await escrow.reservationOf(newId)).beneficiary).to.equal(alice.address);
      expect((await escrow.reservationOf(tokenId)).beneficiary).to.equal(ZERO);
    });

    it("keeps the bonus claimable while new deposits are paused", async function () {
      const { tx, tokenId } = await deposit();
      await tx;
      await asset.transfer(escrowAddr, expected().bonus);
      await asGuardian().setDepositsPaused(true);
      await time.increase(APEBOND_CLIFF_SECONDS);
      await expect(escrow.claim(tokenId)).to.emit(escrow, "BonusClaimed");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("The NFT receipt hook", function () {
    it("refuses a position pushed in outside a deposit", async function () {
      const tokenId = await createPosition(alice.address);
      await expect(
        nfpm.connect(alice)["safeTransferFrom(address,address,uint256)"](alice.address, adapterAddr, tokenId)
      )
        .to.be.revertedWithCustomError(adapter, "UnsolicitedPosition")
        .withArgs(alice.address, alice.address, tokenId);
    });

    it("refuses a token from any collection but the configured position manager", async function () {
      const Other = await ethers.getContractFactory("MockPositionManager");
      const other = await Other.deploy();
      await other.mintFake(
        alice.address,
        token0Addr,
        token1Addr,
        FEE,
        TICK_LOWER,
        TICK_UPPER,
        LIQUIDITY,
        0,
        0
      );
      const tokenId = await other.lastMintedId();
      await expect(
        other.connect(alice)["safeTransferFrom(address,address,uint256)"](alice.address, adapterAddr, tokenId)
      )
        .to.be.revertedWithCustomError(adapter, "UnexpectedNftSender")
        .withArgs(await other.getAddress());
    });

    it("closes the window again after a deposit", async function () {
      await (
        await deposit()
      ).tx;
      const stray = await createPosition(alice.address);
      await expect(
        nfpm.connect(alice)["safeTransferFrom(address,address,uint256)"](alice.address, adapterAddr, stray)
      ).to.be.revertedWithCustomError(adapter, "UnsolicitedPosition");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Campaign administration (owner = timelock)", function () {
    it("stores a campaign and announces its full state", async function () {
      const config = campaignConfig({ bonusBps: 750, minBonusAmount: TOKENS(5), bonusCliffSeconds: 86_400n });
      await expect(adapter.setCampaign(OTHER_CAMPAIGN, config))
        .to.emit(adapter, "CampaignSet")
        .withArgs(OTHER_CAMPAIGN, true, TICK_LOWER, TICK_UPPER, 86_400n, 750, TOKENS(5));

      const stored = await adapter.campaigns(OTHER_CAMPAIGN);
      expect(stored.enabled).to.equal(true);
      expect(stored.tickLower).to.equal(TICK_LOWER);
      expect(stored.tickUpper).to.equal(TICK_UPPER);
      expect(stored.bonusCliffSeconds).to.equal(86_400n);
      expect(stored.bonusBps).to.equal(750n);
      expect(stored.minBonusAmount).to.equal(TOKENS(5));
    });

    it("rejects a zero campaign id", async function () {
      await expect(adapter.setCampaign(ethers.ZeroHash, campaignConfig())).to.be.revertedWithCustomError(
        adapter,
        "ZeroCampaignId"
      );
      await expect(
        adapter.setCampaignCaller(ethers.ZeroHash, soulZapAddr, true)
      ).to.be.revertedWithCustomError(adapter, "ZeroCampaignId");
    });

    it("rejects a range no position on the vault's pool could have", async function () {
      const bad = [
        [TICK_UPPER, TICK_LOWER], // lower above upper
        [TICK_LOWER, TICK_LOWER], // empty
        [TICK_LOWER + 1, TICK_UPPER], // off the 60-tick grid
        [TICK_LOWER, TICK_UPPER - 1],
        [-887280, TICK_UPPER], // below MIN_TICK, on the grid
        [TICK_LOWER, 887280], // above MAX_TICK, on the grid
      ];
      for (const [lower, upper] of bad) {
        await expect(
          adapter.setCampaign(OTHER_CAMPAIGN, campaignConfig({ tickLower: lower, tickUpper: upper }))
        )
          .to.be.revertedWithCustomError(adapter, "InvalidCampaignRange")
          .withArgs(lower, upper, TICK_SPACING);
      }
      // The widest grid range inside the bounds is accepted.
      await adapter.setCampaign(OTHER_CAMPAIGN, campaignConfig({ tickLower: -887220, tickUpper: 887220 }));
    });

    it("rejects a rate above the whole value, and accepts exactly the whole value", async function () {
      await expect(adapter.setCampaign(OTHER_CAMPAIGN, campaignConfig({ bonusBps: 10_001 })))
        .to.be.revertedWithCustomError(adapter, "BonusBpsTooHigh")
        .withArgs(10_001);
      await adapter.setCampaign(OTHER_CAMPAIGN, campaignConfig({ bonusBps: 10_000 }));
    });

    it("switches an existing campaign on and off, and refuses an unknown one", async function () {
      await expect(adapter.setCampaignEnabled(CAMPAIGN, false))
        .to.emit(adapter, "CampaignEnabledSet")
        .withArgs(CAMPAIGN, false);
      expect((await adapter.campaigns(CAMPAIGN)).enabled).to.equal(false);

      await expect(adapter.setCampaignEnabled(OTHER_CAMPAIGN, true))
        .to.be.revertedWithCustomError(adapter, "UnknownCampaign")
        .withArgs(OTHER_CAMPAIGN);
    });

    it("permits and removes a campaign caller, both ways logged, zero refused", async function () {
      await expect(adapter.setCampaignCaller(CAMPAIGN, bob.address, true))
        .to.emit(adapter, "CampaignCallerSet")
        .withArgs(CAMPAIGN, bob.address, true);
      expect(await adapter.campaignCallers(CAMPAIGN, bob.address)).to.equal(true);
      await expect(adapter.setCampaignCaller(CAMPAIGN, bob.address, false))
        .to.emit(adapter, "CampaignCallerSet")
        .withArgs(CAMPAIGN, bob.address, false);
      await expect(adapter.setCampaignCaller(CAMPAIGN, ZERO, true)).to.be.revertedWithCustomError(
        adapter,
        "ZeroAddress"
      );
    });

    it("allowlists and removes a SoulZap caller, both ways logged, zero refused", async function () {
      await expect(adapter.setSoulZapCaller(bob.address, true))
        .to.emit(adapter, "SoulZapCallerSet")
        .withArgs(bob.address, true);
      await expect(adapter.setSoulZapCaller(bob.address, false))
        .to.emit(adapter, "SoulZapCallerSet")
        .withArgs(bob.address, false);
      await expect(adapter.setSoulZapCaller(ZERO, true)).to.be.revertedWithCustomError(
        adapter,
        "ZeroAddress"
      );
    });

    it("keeps every configuration function owner-only — the guardian and a caller included", async function () {
      for (const caller of [guardian, stranger]) {
        const as = adapter.connect(caller);
        const calls = [
          as.setCampaign(OTHER_CAMPAIGN, campaignConfig()),
          as.setCampaignEnabled(CAMPAIGN, false),
          as.setCampaignCaller(CAMPAIGN, caller.address, true),
          as.setSoulZapCaller(caller.address, true),
          as.setGuardian(caller.address),
        ];
        for (const call of calls) {
          await expect(call)
            .to.be.revertedWithCustomError(adapter, "OwnableUnauthorizedAccount")
            .withArgs(caller.address);
        }
      }
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("The guardian", function () {
    it("pauses and resumes deposits, full state logged, and nobody else can", async function () {
      await expect(asGuardian().setDepositsPaused(true)).to.emit(adapter, "DepositsPausedSet").withArgs(true);
      expect(await adapter.depositsPaused()).to.equal(true);
      await expect(asGuardian().setDepositsPaused(false))
        .to.emit(adapter, "DepositsPausedSet")
        .withArgs(false);

      for (const caller of [owner, stranger]) {
        await expect(adapter.connect(caller).setDepositsPaused(true))
          .to.be.revertedWithCustomError(adapter, "NotGuardian")
          .withArgs(caller.address, guardian.address);
      }
    });

    it("is rotated by the owner, non-zero, both sides logged, and the switch moves with it", async function () {
      await expect(adapter.setGuardian(ZERO)).to.be.revertedWithCustomError(adapter, "ZeroAddress");
      await expect(adapter.setGuardian(bob.address))
        .to.emit(adapter, "GuardianSet")
        .withArgs(guardian.address, bob.address);

      await expect(asGuardian().setDepositsPaused(true))
        .to.be.revertedWithCustomError(adapter, "NotGuardian")
        .withArgs(guardian.address, bob.address);
      await adapter.connect(bob).setDepositsPaused(true);
      expect(await adapter.depositsPaused()).to.equal(true);
    });

    it("leaves ordinary stakers alone while the ApeBond route is paused", async function () {
      await asGuardian().setDepositsPaused(true);
      const tokenId = await createPosition(bob.address);
      await nfpm.connect(bob).approve(vaultAddr, tokenId);
      await vault.connect(bob).stake(tokenId);
      expect(await vault.stakerOf(tokenId)).to.equal(bob.address);
    });
  });
});
