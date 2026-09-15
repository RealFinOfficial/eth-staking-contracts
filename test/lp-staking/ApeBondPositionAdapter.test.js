const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const {
  signPurchaseAuthorization,
  purchaseAuthorizationTypeHash,
  PURCHASE_AUTHORIZATION_FIELDS,
} = require("./helpers/signing");

describe("ApeBondPositionAdapter", function () {
  let adapter, vault, escrow, soulZap, nfpm, pool, router;
  let token0, token1, bonus, usdt;
  let owner, guardian, purchaseSigner, alice, bob, stranger;

  let adapterAddr, vaultAddr, escrowAddr, soulZapAddr, nfpmAddr, poolAddr, routerAddr;
  let token0Addr, token1Addr, bonusAddr, usdtAddr;

  // The two admin tiers are DIFFERENT accounts here, and so is the purchase signer, so "is
  // this owner-only, guardian-only or signed" is never answered by two of them happening to
  // be the same address. In production `owner` is the TimelockController, `guardian` is the
  // multisig and `purchaseSigner` is a backend key that holds nothing.
  const asGuardian = () => adapter.connect(guardian);

  const FEE = 3000;
  const OTHER_FEE = 500;
  const TWAP_WINDOW = 600;
  const MAX_DEVIATION_TICKS = 500;
  const TICK_LOWER = -600;
  const TICK_UPPER = 600;
  const LIQUIDITY = 1_000_000n;
  const MIN_LIQUIDITY = 500_000n;
  const FAR_DEADLINE = 10n ** 12n;
  const ZERO = ethers.ZeroAddress;

  const TOKENS = (n) => ethers.parseEther(String(n));
  const ID = (label) => ethers.id(label);

  const PURCHASE = ID("apebond-purchase-1");
  const CAMPAIGN = ID("apebond-campaign-1");
  const REQUEST = ID("soulzap-request-1");
  const BONUS = TOKENS(100);
  const ESCROW_FUNDING = TOKENS(1_000);
  const GROSS_INPUT = 1_000_000_000n; // 1,000 USDT, 6 decimals
  const NET_INPUT = 990_000_000n; //     after SoulZap's fee

  // MockSoulZapCaller.Approval
  const APPROVE_PER_TOKEN = 0;
  const APPROVE_FOR_ALL = 1;
  const APPROVE_NONE = 2;

  // ── deployment helpers ─────────────────────────────────────────

  /// Deploys a vault UUPS proxy exactly as LPStakingVault.test.js does; `unsafeAllow` names
  /// the two patterns the spec chose deliberately.
  ///
  /// The vault's three tiers are collapsed onto two keys here on purpose: `owner` holds the
  /// owner AND operator tiers (nothing in this file calls the operator's functions) while
  /// `guardian` holds the pause tier, which section "depositFor" uses. `zapper` starts at
  /// address(0) — the ApeBond route is a stake OPERATOR, beside the zapper and never it.
  async function deployVaultProxy() {
    const Vault = await ethers.getContractFactory("LPStakingVault");
    return upgrades.deployProxy(
      Vault,
      [owner.address, guardian.address, owner.address, ZERO, TWAP_WINDOW, MAX_DEVIATION_TICKS],
      {
        kind: "uups",
        constructorArgs: [nfpmAddr, poolAddr, token0Addr, token1Addr, FEE, routerAddr],
        unsafeAllow: ["constructor", "state-variable-immutable"],
      }
    );
  }

  /// Deploys a BonusEscrow UUPS proxy, as BonusEscrow.test.js does. The adapter is wired in
  /// afterwards with `setAdapter` because this fixture owns the escrow; the deploy script,
  /// which does not, passes a pre-computed adapter address to `initialize` instead.
  async function deployEscrowProxy() {
    const Escrow = await ethers.getContractFactory("BonusEscrow");
    return upgrades.deployProxy(Escrow, [owner.address, ZERO], {
      kind: "uups",
      constructorArgs: [bonusAddr],
      unsafeAllow: ["constructor", "state-variable-immutable"],
    });
  }

  function adapterArgs(overrides = {}) {
    return {
      positionManager: nfpmAddr,
      vault: vaultAddr,
      escrow: escrowAddr,
      token0: token0Addr,
      token1: token1Addr,
      fee: FEE,
      initialOwner: owner.address,
      guardian: guardian.address,
      purchaseSigner: purchaseSigner.address,
      ...overrides,
    };
  }

  async function deployAdapter(overrides = {}) {
    const args = adapterArgs(overrides);
    const Adapter = await ethers.getContractFactory("ApeBondPositionAdapter");
    return Adapter.deploy(
      args.positionManager,
      args.vault,
      args.escrow,
      args.token0,
      args.token1,
      args.fee,
      args.initialOwner,
      args.guardian,
      args.purchaseSigner
    );
  }

  // ── authorization helpers ──────────────────────────────────────

  async function authDomain(verifyingContract = adapterAddr) {
    return {
      name: "RealApeBondPurchase",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract,
    };
  }

  /// One campaign purchase, with every field at its default unless a test moves it.
  async function makeAuth(overrides = {}) {
    return {
      purchaseId: PURCHASE,
      campaignId: CAMPAIGN,
      soulZapRequestId: REQUEST,
      beneficiary: alice.address,
      soulZapCaller: soulZapAddr,
      inputToken: usdtAddr,
      grossInputAmount: GROSS_INPUT,
      netInputAmount: NET_INPUT,
      guaranteedBonusAmount: BONUS,
      bonusUnlockAt: BigInt(await time.latest()) + 30n * 24n * 3600n,
      minLiquidity: MIN_LIQUIDITY,
      expectedTickLower: TICK_LOWER,
      expectedTickUpper: TICK_UPPER,
      nonce: 1n,
      deadline: FAR_DEADLINE,
      ...overrides,
    };
  }

  async function sign(authorization, opts = {}) {
    return signPurchaseAuthorization({
      signer: opts.signer ?? purchaseSigner,
      domain: opts.domain ?? (await authDomain()),
      authorization,
    });
  }

  /// Fabricates a position NFT for `holder`. The adapter reads `positions()` and nothing
  /// else, so the principal only has to be there for the vault's own later paths.
  async function createPosition(holder, opts = {}) {
    const {
      tickLower = TICK_LOWER,
      tickUpper = TICK_UPPER,
      liquidity = LIQUIDITY,
      poolToken0 = token0Addr,
      poolToken1 = token1Addr,
      poolFee = FEE,
    } = opts;

    await nfpm.mintFake(holder, poolToken0, poolToken1, poolFee, tickLower, tickUpper, liquidity, 0, 0);
    return nfpm.lastMintedId();
  }

  /// The whole production shape in one call: SoulZap holds the NFT, approves the adapter and
  /// calls `depositFor` in the same transaction.
  async function deposit(opts = {}) {
    const tokenId = opts.tokenId ?? (await createPosition(soulZapAddr, opts.position ?? {}));
    const authorization = opts.authorization ?? (await makeAuth(opts.auth ?? {}));
    const signature = opts.signature ?? (await sign(authorization, opts.signOpts ?? {}));
    const tx = soulZap.deposit(adapterAddr, nfpmAddr, tokenId, authorization, signature);
    return { tx, tokenId, authorization, signature };
  }

  async function txTimestamp(tx) {
    const receipt = await tx.wait();
    return (await ethers.provider.getBlock(receipt.blockNumber)).timestamp;
  }

  beforeEach(async function () {
    [owner, guardian, purchaseSigner, alice, bob, stranger] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockERC20Decimals");
    const usdc = await Token.deploy("USD Coin", "USDC", 1_000_000n * 10n ** 6n, 6);
    const asset = await Token.deploy("Asset", "ASSET", 1_000_000n * 10n ** 18n, 18);

    // Uniswap sorts the pair ascending by address, so which of the two ends up as token0 is
    // an accident of deployment order. The adapter is token-agnostic and only ever compares
    // what `positions()` reports against its own immutables.
    const sorted =
      (await usdc.getAddress()).toLowerCase() < (await asset.getAddress()).toLowerCase()
        ? [usdc, asset]
        : [asset, usdc];
    token0 = sorted[0];
    token1 = sorted[1];
    token0Addr = await token0.getAddress();
    token1Addr = await token1.getAddress();

    // The bonus is a token of its own: §6.3 forbids the escrow from sharing balances with the
    // vault or the distributor, and a separate token is how a test can tell them apart.
    bonus = await Token.deploy("Bonus", "BONUS", TOKENS(10_000_000), 18);
    bonusAddr = await bonus.getAddress();

    // What the buyer paid with. Never moved on-chain by anything in this stack — the
    // authorization carries it as an audit trail (§7).
    usdt = await Token.deploy("Tether USD", "USDT", 1_000_000n * 10n ** 6n, 6);
    usdtAddr = await usdt.getAddress();

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
    await bonus.transfer(escrowAddr, ESCROW_FUNDING);

    adapter = await deployAdapter();
    adapterAddr = await adapter.getAddress();

    const SoulZap = await ethers.getContractFactory("MockSoulZapCaller");
    soulZap = await SoulZap.deploy();
    soulZapAddr = await soulZap.getAddress();

    // The three wiring transactions the deploy runbook performs, and nothing else: the
    // adapter is a stake operator on the vault, the reserving adapter on the escrow, and the
    // SoulZap contract is on its own allowlist.
    await vault.setStakeOperator(adapterAddr, true);
    await escrow.setAdapter(adapterAddr);
    await adapter.setSoulZapCaller(soulZapAddr, true);
  });

  // ─────────────────────────────────────────────────────────────
  describe("Deployment", function () {
    it("stores every immutable, the two roles and the signer, and starts with an empty book", async function () {
      expect(await adapter.positionManager()).to.equal(nfpmAddr);
      expect(await adapter.vault()).to.equal(vaultAddr);
      expect(await adapter.escrow()).to.equal(escrowAddr);
      expect(await adapter.token0()).to.equal(token0Addr);
      expect(await adapter.token1()).to.equal(token1Addr);
      expect(await adapter.fee()).to.equal(FEE);
      expect(await adapter.owner()).to.equal(owner.address);
      expect(await adapter.guardian()).to.equal(guardian.address);
      expect(await adapter.purchaseSigner()).to.equal(purchaseSigner.address);
      expect(await adapter.depositsPaused()).to.equal(false);
      expect(await adapter.consumedPurchaseIds(PURCHASE)).to.equal(false);
      expect(await adapter.consumedNonces(1n)).to.equal(false);
    });

    it("announces the guardian and the purchase signer from block one", async function () {
      const fresh = await deployAdapter();

      await expect(fresh.deploymentTransaction())
        .to.emit(fresh, "GuardianSet")
        .withArgs(ZERO, guardian.address);
      await expect(fresh.deploymentTransaction())
        .to.emit(fresh, "PurchaseSignerSet")
        .withArgs(ZERO, purchaseSigner.address);
    });

    it("rejects a zero position manager, vault, escrow, pool token or guardian", async function () {
      for (const overrides of [
        { positionManager: ZERO },
        { vault: ZERO },
        { escrow: ZERO },
        { token0: ZERO },
        { token1: ZERO },
        { guardian: ZERO },
      ]) {
        await expect(deployAdapter(overrides)).to.be.revertedWithCustomError(adapter, "ZeroAddress");
      }
    });

    it("rejects an unsorted pool pair", async function () {
      await expect(deployAdapter({ token0: token1Addr, token1: token0Addr }))
        .to.be.revertedWithCustomError(adapter, "TokensNotSorted")
        .withArgs(token1Addr, token0Addr);
    });

    it("deploys with the path CLOSED when no purchase signer is given", async function () {
      // Zero is allowed here and nowhere else in the constructor: it is the wind-down state
      // the guardian can also return to, not a misconfiguration.
      const closed = await deployAdapter({ purchaseSigner: ZERO });
      expect(await closed.purchaseSigner()).to.equal(ZERO);
    });

    it("has no rescue, sweep or arbitrary-call surface at all", async function () {
      // The claim in the contract note, asserted rather than asserted-in-prose: nothing on
      // this ABI moves a token, so there is no owner path to misuse and no stray to recover.
      const names = adapter.interface.fragments
        .filter((f) => f.type === "function")
        .map((f) => f.name);
      for (const forbidden of ["rescuePosition", "sweep", "recover", "execute", "call", "multicall"]) {
        expect(names).to.not.include(forbidden);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("The typed data", function () {
    it("uses the type hash the struct defines, field for field", async function () {
      expect(await adapter.PURCHASE_AUTHORIZATION_TYPEHASH()).to.equal(purchaseAuthorizationTypeHash());
      expect(PURCHASE_AUTHORIZATION_FIELDS).to.have.lengthOf(15);
    });

    it("reports the RealApeBondPurchase domain, distinct from the rewards voucher domain", async function () {
      const domain = await adapter.eip712Domain();
      expect(domain.name).to.equal("RealApeBondPurchase");
      expect(domain.version).to.equal("1");
      expect(domain.verifyingContract).to.equal(adapterAddr);
      expect(domain.chainId).to.equal((await ethers.provider.getNetwork()).chainId);
      expect(domain.name).to.not.equal("RealLPRewards");
    });

    it("hashes an authorization exactly as ethers does", async function () {
      // The split `abi.encode` inside `_structHash` is byte-identical to the one-call form —
      // this is the assertion that says so, against an independent implementation.
      const authorization = await makeAuth();
      const expected = ethers.TypedDataEncoder.hash(
        await authDomain(),
        { PurchaseAuthorization: PURCHASE_AUTHORIZATION_FIELDS },
        authorization
      );
      expect(await adapter.hashPurchaseAuthorization(authorization)).to.equal(expected);
    });

    it("binds the digest to this adapter, so a sibling deployment's signature is worthless", async function () {
      const sibling = await deployAdapter();
      const authorization = await makeAuth();

      expect(await sibling.hashPurchaseAuthorization(authorization)).to.not.equal(
        await adapter.hashPurchaseAuthorization(authorization)
      );

      const foreign = await sign(authorization, { domain: await authDomain(await sibling.getAddress()) });
      await expect(deposit({ authorization, signature: foreign }).then((d) => d.tx)).to.be.revertedWithCustomError(
        adapter,
        "InvalidSignature"
      );
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("depositFor — the happy path", function () {
    it("stakes the position for the beneficiary, reserves the bonus and keeps nothing", async function () {
      const { tx, tokenId, authorization } = await deposit();
      const receipt = await (await tx).wait();

      // Custody and attribution, the two facts the whole call exists to produce.
      expect(await nfpm.ownerOf(tokenId)).to.equal(vaultAddr);
      expect(await vault.stakerOf(tokenId)).to.equal(alice.address);

      // The bonus is recorded against the purchase id, not against the tokenId — a rebalance
      // replaces the NFT and must not touch the entitlement (§4.4).
      const reservation = await escrow.reservationOf(PURCHASE);
      expect(reservation.beneficiary).to.equal(alice.address);
      expect(reservation.amount).to.equal(BONUS);
      expect(reservation.unlockAt).to.equal(authorization.bonusUnlockAt);
      expect(reservation.claimed).to.equal(false);
      expect(await escrow.totalReserved()).to.equal(BONUS);

      // The id and the nonce are spent.
      expect(await adapter.consumedPurchaseIds(PURCHASE)).to.equal(true);
      expect(await adapter.consumedNonces(1n)).to.equal(true);

      // And the adapter itself ends the transaction holding nothing at all.
      expect(await nfpm.balanceOf(adapterAddr)).to.equal(0n);
      expect(await bonus.balanceOf(adapterAddr)).to.equal(0n);
      expect(await token0.balanceOf(adapterAddr)).to.equal(0n);
      expect(await token1.balanceOf(adapterAddr)).to.equal(0n);
      expect(await ethers.provider.getBalance(adapterAddr)).to.equal(0n);
      expect(receipt.status).to.equal(1);
    });

    it("emits ApeBondPositionDeposited with all thirteen fields of spec §9", async function () {
      const { tx, tokenId, authorization } = await deposit();

      await expect(tx)
        .to.emit(adapter, "ApeBondPositionDeposited")
        .withArgs(
          PURCHASE,
          CAMPAIGN,
          alice.address,
          REQUEST,
          tokenId,
          LIQUIDITY,
          TICK_LOWER,
          TICK_UPPER,
          usdtAddr,
          GROSS_INPUT,
          NET_INPUT,
          BONUS,
          authorization.bonusUnlockAt
        );
    });

    it("makes the vault and the escrow speak in the same transaction", async function () {
      const { tx, tokenId } = await deposit();
      const ts = await txTimestamp(await tx);

      await expect(tx)
        .to.emit(vault, "Staked")
        .withArgs(alice.address, tokenId, TICK_LOWER, TICK_UPPER, LIQUIDITY, ts);
      await expect(tx).to.emit(escrow, "BonusReserved").withArgs(PURCHASE, alice.address, BONUS, anyUint64());
    });

    it("accepts an operator-for-all approval as well as a per-token one", async function () {
      await soulZap.setApprovalMode(APPROVE_FOR_ALL);
      const { tx, tokenId } = await deposit();
      await tx;

      expect(await vault.stakerOf(tokenId)).to.equal(alice.address);
      expect(await nfpm.isApprovedForAll(soulZapAddr, adapterAddr)).to.equal(true);
    });

    it("stakes a zero-bonus purchase without touching the escrow", async function () {
      // A campaign that promises no extra payout still has to be routable: `reserve` rejects
      // a zero amount, so the leg is skipped rather than made impossible.
      const { tx, tokenId } = await deposit({ auth: { guaranteedBonusAmount: 0n } });

      await expect(tx).to.not.emit(escrow, "BonusReserved");
      expect(await vault.stakerOf(tokenId)).to.equal(alice.address);
      expect(await escrow.totalReserved()).to.equal(0n);
      expect((await escrow.reservationOf(PURCHASE)).beneficiary).to.equal(ZERO);

      // ...and the id is spent all the same, so the purchase cannot be presented twice.
      expect(await adapter.consumedPurchaseIds(PURCHASE)).to.equal(true);
    });

    it("lets a second purchase through with its own id and nonce", async function () {
      await (await deposit()).tx;

      const second = await deposit({
        auth: { purchaseId: ID("apebond-purchase-2"), beneficiary: bob.address, nonce: 2n },
      });
      await second.tx;

      expect(await vault.stakerOf(second.tokenId)).to.equal(bob.address);
      expect(await escrow.totalReserved()).to.equal(BONUS * 2n);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("depositFor — the checklist rejections", function () {
    it("1. refuses while the adapter's own deposits are paused", async function () {
      await asGuardian().setDepositsPaused(true);

      await expect((await deposit()).tx).to.be.revertedWithCustomError(adapter, "DepositsArePaused");
    });

    it("2. refuses a caller that is not on the SoulZap allowlist", async function () {
      await adapter.setSoulZapCaller(soulZapAddr, false);

      await expect((await deposit()).tx)
        .to.be.revertedWithCustomError(adapter, "NotSoulZapCaller")
        .withArgs(soulZapAddr);
    });

    it("3. refuses when the authorization names a different SoulZap caller", async function () {
      await adapter.setSoulZapCaller(stranger.address, true);

      await expect((await deposit({ auth: { soulZapCaller: stranger.address } })).tx)
        .to.be.revertedWithCustomError(adapter, "CallerMismatch")
        .withArgs(stranger.address, soulZapAddr);
    });

    it("4a. refuses a zero beneficiary", async function () {
      await expect((await deposit({ auth: { beneficiary: ZERO } })).tx)
        .to.be.revertedWithCustomError(adapter, "InvalidBeneficiary")
        .withArgs(ZERO);
    });

    it("4b. refuses the adapter itself as beneficiary (SEC-05)", async function () {
      await expect((await deposit({ auth: { beneficiary: adapterAddr } })).tx)
        .to.be.revertedWithCustomError(adapter, "InvalidBeneficiary")
        .withArgs(adapterAddr);
    });

    it("4c. refuses the vault as beneficiary (SEC-05)", async function () {
      // The finding itself: `stakeFor(vault)` writes a staker record that `unstake` cannot
      // reach and `rescuePosition` refuses to touch, stranding the NFT until an upgrade.
      await expect((await deposit({ auth: { beneficiary: vaultAddr } })).tx)
        .to.be.revertedWithCustomError(adapter, "InvalidBeneficiary")
        .withArgs(vaultAddr);
    });

    it("4d. refuses the position manager as beneficiary (SEC-05)", async function () {
      await expect((await deposit({ auth: { beneficiary: nfpmAddr } })).tx)
        .to.be.revertedWithCustomError(adapter, "InvalidBeneficiary")
        .withArgs(nfpmAddr);
    });

    it("5. refuses an expired authorization", async function () {
      const deadline = BigInt(await time.latest()) + 60n;
      await time.increaseTo(deadline + 1n);

      await expect((await deposit({ auth: { deadline } })).tx)
        .to.be.revertedWithCustomError(adapter, "AuthorizationExpired")
        .withArgs(deadline, anyUint());
    });

    it("6a. refuses a signature from any other key", async function () {
      await expect((await deposit({ signOpts: { signer: bob } })).tx)
        .to.be.revertedWithCustomError(adapter, "InvalidSignature")
        .withArgs(bob.address, purchaseSigner.address);
    });

    it("6b. refuses everything once the signer is unset — the path is closed", async function () {
      await asGuardian().setPurchaseSigner(ZERO);

      await expect((await deposit()).tx)
        .to.be.revertedWithCustomError(adapter, "InvalidSignature")
        .withArgs(purchaseSigner.address, ZERO);
    });

    it("6c. refuses an authorization whose fields were edited after signing", async function () {
      const authorization = await makeAuth();
      const signature = await sign(authorization);
      const tampered = { ...authorization, guaranteedBonusAmount: BONUS * 10n };

      await expect(
        (await deposit({ authorization: tampered, signature })).tx
      ).to.be.revertedWithCustomError(adapter, "InvalidSignature");
    });

    it("7a. refuses a replayed purchase id", async function () {
      await (await deposit()).tx;

      await expect((await deposit({ auth: { nonce: 2n } })).tx)
        .to.be.revertedWithCustomError(adapter, "PurchaseAlreadyProcessed")
        .withArgs(PURCHASE);
    });

    it("7b. refuses a replayed nonce under a fresh purchase id", async function () {
      await (await deposit()).tx;

      await expect((await deposit({ auth: { purchaseId: ID("apebond-purchase-2") } })).tx)
        .to.be.revertedWithCustomError(adapter, "NonceAlreadyUsed")
        .withArgs(1n);
    });

    it("7c. refuses the replay even inside ONE transaction", async function () {
      // Two `depositFor` calls in the same outer call: no revert separates them, so only the
      // spent-id book written before the transfers can stop the second one.
      const tokenId = await createPosition(soulZapAddr);
      const authorization = await makeAuth();
      const signature = await sign(authorization);

      await expect(
        soulZap.depositTwice(adapterAddr, nfpmAddr, tokenId, authorization, signature)
      ).to.be.revertedWithCustomError(adapter, "PurchaseAlreadyProcessed");
    });

    it("8a. refuses an NFT the caller does not own", async function () {
      // No approval step, because a non-owner cannot make one: the position manager itself
      // rejects it, and the check under test is the adapter's, one call later.
      await soulZap.setApprovalMode(APPROVE_NONE);
      const tokenId = await createPosition(alice.address);

      await expect((await deposit({ tokenId })).tx)
        .to.be.revertedWithCustomError(adapter, "NftNotHeldByCaller")
        .withArgs(tokenId, alice.address, soulZapAddr);
    });

    it("8b. refuses an NFT the adapter was never approved for", async function () {
      await soulZap.setApprovalMode(APPROVE_NONE);
      const { tx, tokenId } = await deposit();

      await expect(tx)
        .to.be.revertedWithCustomError(adapter, "NftNotApproved")
        .withArgs(tokenId, soulZapAddr);
    });

    it("9a. refuses a position on another pair", async function () {
      const foreign = await (await ethers.getContractFactory("MockERC20Decimals")).deploy(
        "Foreign",
        "FRGN",
        TOKENS(1),
        18
      );
      const foreignAddr = await foreign.getAddress();
      const [a, b] =
        foreignAddr.toLowerCase() < token1Addr.toLowerCase()
          ? [foreignAddr, token1Addr]
          : [token1Addr, foreignAddr];

      const { tx, tokenId } = await deposit({ position: { poolToken0: a, poolToken1: b } });

      await expect(tx)
        .to.be.revertedWithCustomError(adapter, "PositionPoolMismatch")
        .withArgs(tokenId, a, b, FEE);
    });

    it("9b. refuses a position on another fee tier of the same pair", async function () {
      const { tx, tokenId } = await deposit({ position: { poolFee: OTHER_FEE } });

      await expect(tx)
        .to.be.revertedWithCustomError(adapter, "PositionPoolMismatch")
        .withArgs(tokenId, token0Addr, token1Addr, OTHER_FEE);
    });

    it("9c. refuses a range that is not the exact signed one, even a wider one", async function () {
      // Wider is not better: the campaign priced the bonus against one range, so anything
      // else is a different product.
      const { tx } = await deposit({ position: { tickLower: TICK_LOWER - 60, tickUpper: TICK_UPPER + 60 } });

      await expect(tx)
        .to.be.revertedWithCustomError(adapter, "TickRangeMismatch")
        .withArgs(TICK_LOWER - 60, TICK_UPPER + 60, TICK_LOWER, TICK_UPPER);
    });

    it("9d. refuses an empty position", async function () {
      const { tx, tokenId } = await deposit({ position: { liquidity: 0n }, auth: { minLiquidity: 0n } });

      await expect(tx).to.be.revertedWithCustomError(adapter, "EmptyPosition").withArgs(tokenId);
    });

    it("9e. refuses a position under the authorization's liquidity floor", async function () {
      const thin = MIN_LIQUIDITY - 1n;
      const { tx } = await deposit({ position: { liquidity: thin } });

      await expect(tx)
        .to.be.revertedWithCustomError(adapter, "InsufficientLiquidity")
        .withArgs(thin, MIN_LIQUIDITY);
    });

    it("9f. accepts a position exactly at the floor", async function () {
      const { tx, tokenId } = await deposit({ position: { liquidity: MIN_LIQUIDITY } });
      await tx;

      expect(await vault.stakerOf(tokenId)).to.equal(alice.address);
    });

    it("takes the vault's own deposit pause with it", async function () {
      await vault.connect(guardian).setDepositsPaused(true);

      await expect((await deposit()).tx).to.be.revertedWithCustomError(vault, "DepositsArePaused");
    });

    it("reverts the whole purchase when the adapter is not a stake operator", async function () {
      await vault.setStakeOperator(adapterAddr, false);

      await expect((await deposit()).tx)
        .to.be.revertedWithCustomError(vault, "NotZapper")
        .withArgs(adapterAddr, ZERO);
    });

    it("reverts the whole purchase when the escrow cannot fund the bonus", async function () {
      const { tx, tokenId } = await deposit({ auth: { guaranteedBonusAmount: ESCROW_FUNDING + 1n } });

      await expect(tx)
        .to.be.revertedWithCustomError(escrow, "Underfunded")
        .withArgs(ESCROW_FUNDING, ESCROW_FUNDING + 1n);

      // Atomicity, stated as the two facts a half-completed purchase would break. The id IS
      // written before the transfers — and the revert rolls that write back with everything
      // else, which is exactly why there is no recovery workflow to write (§10).
      expect(await nfpm.ownerOf(tokenId)).to.equal(soulZapAddr);
      expect(await adapter.consumedPurchaseIds(PURCHASE)).to.equal(false);
      expect(await adapter.consumedNonces(1n)).to.equal(false);
      expect(await escrow.totalReserved()).to.equal(0n);
    });

    it("reverts the whole purchase when the escrow no longer accepts this adapter", async function () {
      await escrow.setAdapter(ZERO);

      await expect((await deposit()).tx)
        .to.be.revertedWithCustomError(escrow, "NotAdapter")
        .withArgs(adapterAddr, ZERO);
    });

    it("leaves nothing behind after a failed deposit", async function () {
      await asGuardian().setDepositsPaused(true);
      const { tx, tokenId } = await deposit();
      await expect(tx).to.be.reverted;

      expect(await nfpm.ownerOf(tokenId)).to.equal(soulZapAddr);
      expect(await nfpm.balanceOf(adapterAddr)).to.equal(0n);
      expect(await vault.stakerOf(tokenId)).to.equal(ZERO);
      expect(await escrow.totalReserved()).to.equal(0n);
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
      await other.mintFake(alice.address, token0Addr, token1Addr, FEE, TICK_LOWER, TICK_UPPER, LIQUIDITY, 0, 0);
      const tokenId = await other.lastMintedId();

      await expect(
        other.connect(alice)["safeTransferFrom(address,address,uint256)"](alice.address, adapterAddr, tokenId)
      )
        .to.be.revertedWithCustomError(adapter, "UnexpectedNftSender")
        .withArgs(await other.getAddress());
    });

    it("closes the window again after a deposit", async function () {
      const { tx } = await deposit();
      await tx;

      const stray = await createPosition(alice.address);
      await expect(
        nfpm.connect(alice)["safeTransferFrom(address,address,uint256)"](alice.address, adapterAddr, stray)
      ).to.be.revertedWithCustomError(adapter, "UnsolicitedPosition");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Administration", function () {
    it("allowlists and removes a SoulZap caller, owner only, both sides logged", async function () {
      await expect(adapter.connect(stranger).setSoulZapCaller(stranger.address, true))
        .to.be.revertedWithCustomError(adapter, "OwnableUnauthorizedAccount")
        .withArgs(stranger.address);

      // Admitting a caller is a code change in all but name, so it waits out the timelock;
      // stopping one that is already admitted is the guardian's pause.
      await expect(asGuardian().setSoulZapCaller(stranger.address, true))
        .to.be.revertedWithCustomError(adapter, "OwnableUnauthorizedAccount")
        .withArgs(guardian.address);

      await expect(adapter.setSoulZapCaller(ZERO, true)).to.be.revertedWithCustomError(
        adapter,
        "ZeroAddress"
      );

      await expect(adapter.setSoulZapCaller(stranger.address, true))
        .to.emit(adapter, "SoulZapCallerSet")
        .withArgs(stranger.address, true);
      expect(await adapter.soulZapCallers(stranger.address)).to.equal(true);

      await expect(adapter.setSoulZapCaller(stranger.address, false))
        .to.emit(adapter, "SoulZapCallerSet")
        .withArgs(stranger.address, false);
      expect(await adapter.soulZapCallers(stranger.address)).to.equal(false);

      // One address's allowance says nothing about another's — this is a mapping, not a slot.
      expect(await adapter.soulZapCallers(soulZapAddr)).to.equal(true);
    });

    it("rotates the purchase signer, guardian only, and accepts zero to close the path", async function () {
      await expect(adapter.setPurchaseSigner(bob.address))
        .to.be.revertedWithCustomError(adapter, "NotGuardian")
        .withArgs(owner.address, guardian.address);

      await expect(asGuardian().setPurchaseSigner(bob.address))
        .to.emit(adapter, "PurchaseSignerSet")
        .withArgs(purchaseSigner.address, bob.address);
      expect(await adapter.purchaseSigner()).to.equal(bob.address);

      await expect(asGuardian().setPurchaseSigner(ZERO))
        .to.emit(adapter, "PurchaseSignerSet")
        .withArgs(bob.address, ZERO);
      expect(await adapter.purchaseSigner()).to.equal(ZERO);
    });

    it("makes a rotation invalidate every outstanding authorization at once", async function () {
      const authorization = await makeAuth();
      const stale = await sign(authorization);

      await asGuardian().setPurchaseSigner(bob.address);
      await expect((await deposit({ authorization, signature: stale })).tx)
        .to.be.revertedWithCustomError(adapter, "InvalidSignature")
        .withArgs(purchaseSigner.address, bob.address);

      // ...and the new key's signatures work at once.
      const fresh = await sign(authorization, { signer: bob });
      const { tx, tokenId } = await deposit({ authorization, signature: fresh });
      await tx;
      expect(await vault.stakerOf(tokenId)).to.equal(alice.address);
    });

    it("pauses and resumes deposits, guardian only, full state logged", async function () {
      await expect(adapter.setDepositsPaused(true))
        .to.be.revertedWithCustomError(adapter, "NotGuardian")
        .withArgs(owner.address, guardian.address);

      await expect(asGuardian().setDepositsPaused(true))
        .to.emit(adapter, "DepositsPausedSet")
        .withArgs(true);
      expect(await adapter.depositsPaused()).to.equal(true);

      await expect(asGuardian().setDepositsPaused(false))
        .to.emit(adapter, "DepositsPausedSet")
        .withArgs(false);

      const { tx, tokenId } = await deposit();
      await tx;
      expect(await vault.stakerOf(tokenId)).to.equal(alice.address);
    });

    it("leaves ordinary REAL stakers alone while the ApeBond route is paused", async function () {
      // The whole reason this switch exists beside the vault's: one route stops, the other
      // does not.
      await asGuardian().setDepositsPaused(true);

      const own = await createPosition(bob.address);
      await nfpm.connect(bob).approve(vaultAddr, own);
      await vault.connect(bob).stake(own);

      expect(await vault.stakerOf(own)).to.equal(bob.address);
      expect(await adapter.depositsPaused()).to.equal(true);
    });

    it("rotates the guardian, owner only, non-zero, both sides logged", async function () {
      await expect(asGuardian().setGuardian(bob.address))
        .to.be.revertedWithCustomError(adapter, "OwnableUnauthorizedAccount")
        .withArgs(guardian.address);

      await expect(adapter.setGuardian(ZERO)).to.be.revertedWithCustomError(adapter, "ZeroAddress");

      await expect(adapter.setGuardian(bob.address))
        .to.emit(adapter, "GuardianSet")
        .withArgs(guardian.address, bob.address);

      // The old guardian is out in the same transaction, and the new one is in.
      await expect(asGuardian().setDepositsPaused(true))
        .to.be.revertedWithCustomError(adapter, "NotGuardian")
        .withArgs(guardian.address, bob.address);
      await adapter.connect(bob).setDepositsPaused(true);
      expect(await adapter.depositsPaused()).to.equal(true);
    });

    it("keeps the guardian out of the owner's tier and the owner out of the guardian's", async function () {
      // Two tiers, stated as the matrix in the contract note and asserted as one.
      await expect(adapter.setDepositsPaused(true)).to.be.revertedWithCustomError(adapter, "NotGuardian");
      await expect(adapter.setPurchaseSigner(bob.address)).to.be.revertedWithCustomError(
        adapter,
        "NotGuardian"
      );
      await expect(asGuardian().setSoulZapCaller(bob.address, true)).to.be.revertedWithCustomError(
        adapter,
        "OwnableUnauthorizedAccount"
      );
      await expect(asGuardian().setGuardian(bob.address)).to.be.revertedWithCustomError(
        adapter,
        "OwnableUnauthorizedAccount"
      );
    });

    it("gives a SoulZap caller no admin power of any kind", async function () {
      await expect(
        soulZap.execute(
          adapterAddr,
          adapter.interface.encodeFunctionData("setDepositsPaused", [true])
        )
      ).to.be.revertedWithCustomError(adapter, "NotGuardian");

      await expect(
        soulZap.execute(
          adapterAddr,
          adapter.interface.encodeFunctionData("setSoulZapCaller", [soulZapAddr, true])
        )
      ).to.be.revertedWithCustomError(adapter, "OwnableUnauthorizedAccount");

      expect(await adapter.soulZapCallers(soulZapAddr)).to.equal(true);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Lifecycle after the purchase", function () {
    it("lets the buyer unstake straight from the vault, with nobody's permission", async function () {
      // §4.5: no hard lock. The adapter is not in this path at all.
      const { tx, tokenId } = await deposit();
      await tx;

      await vault.connect(alice).unstake(tokenId);

      expect(await nfpm.ownerOf(tokenId)).to.equal(alice.address);
      expect(await vault.stakerOf(tokenId)).to.equal(ZERO);
    });

    it("keeps the bonus reserved after the buyer unstakes, and pays it at the cliff", async function () {
      const { tx, tokenId, authorization } = await deposit();
      await tx;
      await vault.connect(alice).unstake(tokenId);

      expect(await escrow.claimable(PURCHASE)).to.equal(0n); // still locked
      await time.increaseTo(authorization.bonusUnlockAt);
      expect(await escrow.claimable(PURCHASE)).to.equal(BONUS);

      const before = await bonus.balanceOf(alice.address);
      await expect(escrow.connect(alice).claim(PURCHASE))
        .to.emit(escrow, "BonusClaimed")
        .withArgs(PURCHASE, alice.address, BONUS);

      expect(await bonus.balanceOf(alice.address)).to.equal(before + BONUS);
      expect(await escrow.totalReserved()).to.equal(0n);
    });

    it("keeps the bonus claimable while new deposits are paused", async function () {
      // §6.3: a pause may never withhold money the escrow has already been paid to hold.
      const { tx, authorization } = await deposit();
      await tx;

      await asGuardian().setDepositsPaused(true);
      await vault.connect(guardian).setDepositsPaused(true);
      await time.increaseTo(authorization.bonusUnlockAt);

      await escrow.connect(stranger).claim(PURCHASE);
      expect(await bonus.balanceOf(alice.address)).to.equal(BONUS);
    });

    it("does not treat the adapter as authoritative for the tokenId afterwards", async function () {
      // §8: the adapter stores no position state. `purchaseId` is what stays stable; the
      // tokenId lives in the vault and the indexer follows it from there.
      const { tx, tokenId } = await deposit();
      await tx;

      const names = adapter.interface.fragments
        .filter((f) => f.type === "function")
        .map((f) => f.name);
      expect(names).to.not.include("positionOf");
      expect(names).to.not.include("tokenIdOf");
      expect(await vault.stakerOf(tokenId)).to.equal(alice.address);
      expect(await adapter.consumedPurchaseIds(PURCHASE)).to.equal(true);
    });
  });
});

/// `withArgs` matcher for a value the test does not pin — the block timestamp, and the cliff
/// derived from it.
function anyUint() {
  return (value) => typeof value === "bigint" && value > 0n;
}

function anyUint64() {
  return anyUint();
}
