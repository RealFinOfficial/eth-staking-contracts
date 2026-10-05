const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const { rewardClaimTypeHash } = require("./helpers/signing");
const { REWARD_CLAIM_TYPEHASH } = require("./helpers/constants");

/**
 * RewardsDistributor v1 — any number of pre-funded reward tokens, one voucher type.
 *
 * Every reward token is paid by TRANSFER out of the distributor's own balance; nothing is
 * minted at claim time. A claim pays exactly `cumulativeAmount - claimed(token, user)` and,
 * when the balance of that token is short, reverts with `InsufficientFunds(token, needed,
 * balance)` until the company funds the contract. There is no cap, budget or running total.
 *
 * The suite's launch configuration mirrors the deploy script: $ASSET conditional with claims
 * CLOSED, $OVTR unconditional with claims OPEN, both pre-funded.
 */
describe("RewardsDistributor", function () {
  let distributor, overture, asset;
  let owner, guardian, voucherSigner, alice, bob, treasury, operatorSafe, minter;
  let distributorAddr, overtureAddr, assetAddr;

  // The three admin tiers are DIFFERENT accounts in this suite, so "is this owner-only,
  // guardian-only or operator-only" is never answered by two of them happening to be the same
  // address. In production `owner` is a TimelockController, `guardian` is a hot pause-only key
  // and `operator` is the multisig (which is also the Overture token's minter; a separate
  // `minter` signer is used here so the token's tier never stands in for the distributor's).
  const asGuardian = () => distributor.connect(guardian);
  const asOperator = () => distributor.connect(operatorSafe);

  const TOKENS = (n) => ethers.parseEther(String(n));
  const USDC = (n) => ethers.parseUnits(String(n), 6);
  const FAR_DEADLINE = 10n ** 12n;
  const FUNDING = TOKENS(1_000_000);

  // `constructor`: the implementation constructor runs `_disableInitializers()`. The
  // distributor has no immutables any more, but the flag list stays the repo-wide one
  // (deploy-lp-staking.js / validate-upgrade-safety.js / deploy-implementation.js).
  const UNSAFE_ALLOW = ["constructor", "state-variable-immutable"];

  /// The launch list the deploy script passes.
  function launchTokens(assetAddress, overtureAddress, assetClaimsEnabled = false) {
    return [
      { token: assetAddress, conditional: true, claimsEnabled: assetClaimsEnabled },
      { token: overtureAddress, conditional: false, claimsEnabled: true },
    ];
  }

  /// Deploys a distributor UUPS proxy. The implementation takes no constructor arguments.
  async function deployDistributorProxy(ownerAddress, guardianAddress, operatorAddress, signerAddress, tokens) {
    const Distributor = await ethers.getContractFactory("RewardsDistributor");
    return upgrades.deployProxy(
      Distributor,
      [ownerAddress, guardianAddress, operatorAddress, signerAddress, tokens],
      { kind: "uups", unsafeAllow: UNSAFE_ALLOW }
    );
  }

  async function deployOverture(minterAddress) {
    const Token = await ethers.getContractFactory("TokenOverture");
    return upgrades.deployProxy(Token, ["Overture", "OVTR", owner.address, minterAddress], {
      kind: "uups",
      unsafeAllow: ["constructor"],
    });
  }

  // ── EIP-712 helpers ────────────────────────────────────────────
  // Field names and order must match the on-chain type string exactly:
  // RewardClaim(address token,address user,uint256 cumulativeAmount,uint256 deadline)
  const REWARD_CLAIM_TYPES = {
    RewardClaim: [
      { name: "token", type: "address" },
      { name: "user", type: "address" },
      { name: "cumulativeAmount", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };

  async function voucherDomain(verifyingContract = distributorAddr) {
    return {
      name: "RealLPRewards",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract,
    };
  }

  /// Signs a voucher for `token`. `opts.boundTo` overrides the signed `user`, `opts.signer`
  /// the signing key, `opts.signedToken` the token named inside the signature.
  async function signVoucher(token, user, cumulativeAmount, opts = {}) {
    const value = {
      token: opts.signedToken ?? token,
      user: (opts.boundTo ?? user).address,
      cumulativeAmount,
      deadline: opts.deadline ?? FAR_DEADLINE,
    };
    return (opts.signer ?? voucherSigner).signTypedData(
      opts.domain ?? (await voucherDomain()),
      REWARD_CLAIM_TYPES,
      value
    );
  }

  /// Address the contract will recover for a voucher redeemed by `submitter` for `token`.
  async function recoverFor(token, submitter, cumulativeAmount, signature, deadline = FAR_DEADLINE) {
    return ethers.verifyTypedData(
      await voucherDomain(),
      REWARD_CLAIM_TYPES,
      { token, user: submitter.address, cumulativeAmount, deadline },
      signature
    );
  }

  async function txTimestamp(tx) {
    const receipt = await tx.wait();
    return (await ethers.provider.getBlock(receipt.blockNumber)).timestamp;
  }

  async function claim(token, user, cumulativeAmount, opts = {}) {
    const sig = opts.signature ?? (await signVoucher(token, user, cumulativeAmount, opts));
    return distributor.connect(user).claim(token, cumulativeAmount, opts.deadline ?? FAR_DEADLINE, sig);
  }

  const claimOverture = (user, cumulativeAmount, opts) => claim(overtureAddr, user, cumulativeAmount, opts);
  const claimAsset = (user, cumulativeAmount, opts) => claim(assetAddr, user, cumulativeAmount, opts);

  /// Opens the $ASSET claims, as the timelock will after maturity.
  async function openAssetClaims() {
    await distributor.setClaimsEnabled(assetAddr, true);
  }

  beforeEach(async function () {
    [owner, guardian, voucherSigner, alice, bob, treasury, operatorSafe, minter] = await ethers.getSigners();

    const AssetFactory = await ethers.getContractFactory("MockERC20Decimals");
    asset = await AssetFactory.deploy("Asset", "ASSET", TOKENS(100_000_000), 18);
    assetAddr = await asset.getAddress();

    overture = await deployOverture(minter.address);
    overtureAddr = await overture.getAddress();

    distributor = await deployDistributorProxy(
      owner.address,
      guardian.address,
      operatorSafe.address,
      voucherSigner.address,
      launchTokens(assetAddr, overtureAddr)
    );
    distributorAddr = await distributor.getAddress();

    // Funding, as the operator does it: $OVTR minted INTO the distributor, $ASSET transferred
    // into it. Claims pay out of these balances.
    await overture.connect(minter).mint(distributorAddr, FUNDING);
    await asset.transfer(distributorAddr, FUNDING);
  });

  // ─────────────────────────────────────────────────────────────
  describe("Deployment", function () {
    it("stores the roles, the launch token list and the default switches", async function () {
      expect(await distributor.signer()).to.equal(voucherSigner.address);
      expect(await distributor.owner()).to.equal(owner.address);
      expect(await distributor.guardian()).to.equal(guardian.address);
      expect(await distributor.operator()).to.equal(operatorSafe.address);
      expect(await distributor.pendingOwner()).to.equal(ethers.ZeroAddress);
      expect(await distributor.paused()).to.equal(false);

      expect(await distributor.rewardTokens()).to.deep.equal([assetAddr, overtureAddr]);

      const assetEntry = await distributor.rewardToken(assetAddr);
      expect(assetEntry.registered).to.equal(true);
      expect(assetEntry.enabled).to.equal(true);
      expect(assetEntry.conditional).to.equal(true);
      expect(assetEntry.claimsEnabled).to.equal(false);
      expect(assetEntry.decimals).to.equal(18n);

      const overtureEntry = await distributor.rewardToken(overtureAddr);
      expect(overtureEntry.registered).to.equal(true);
      expect(overtureEntry.enabled).to.equal(true);
      expect(overtureEntry.conditional).to.equal(false);
      expect(overtureEntry.claimsEnabled).to.equal(true);
      expect(overtureEntry.decimals).to.equal(18n);

      expect(await distributor.isRewardToken(assetAddr)).to.equal(true);
      expect(await distributor.isRewardToken(overtureAddr)).to.equal(true);

      // A token never registered reads as all zeros.
      const none = await distributor.rewardToken(alice.address);
      expect(none.registered).to.equal(false);
      expect(none.decimals).to.equal(0n);
      expect(await distributor.isRewardToken(alice.address)).to.equal(false);
    });

    it("pins ONE voucher type hash for every token, as the contract, the helper and the constant agree", async function () {
      const expected = ethers.keccak256(
        ethers.toUtf8Bytes(
          "RewardClaim(address token,address user,uint256 cumulativeAmount,uint256 deadline)"
        )
      );
      expect(expected).to.equal("0x746a03cb3aaddb17f8408279b7ff5133a65d78143d19fbd50c05d05bca850c63");
      expect(await distributor.REWARD_CLAIM_TYPEHASH()).to.equal(expected);
      expect(rewardClaimTypeHash()).to.equal(expected);
      expect(REWARD_CLAIM_TYPEHASH).to.equal(expected);
    });

    it("announces every initial field in the deploy tx, in order, one RewardTokenAdded per token", async function () {
      // An indexer must be able to rebuild the whole state from this one transaction's logs,
      // so even the pause flag whose initial value is `false` is emitted.
      const receipt = await distributor.deploymentTransaction().wait();

      const ours = receipt.logs
        .filter((log) => log.address === distributorAddr)
        .map((log) => distributor.interface.parseLog(log))
        .filter((parsed) => parsed !== null)
        .map((parsed) => parsed.name);

      expect(ours).to.deep.equal([
        "Upgraded", // ERC-1967, naming the implementation the proxy's constructor installed
        "OwnershipTransferred", // OZ, from __Ownable_init(owner)
        "GuardianSet",
        "OperatorSet",
        "SignerChanged",
        "Paused",
        "RewardTokenAdded", // $ASSET
        "RewardTokenAdded", // $OVTR
        "Initialized", // OZ, closing the initializer
      ]);

      const deployTx = distributor.deploymentTransaction();
      await expect(deployTx).to.emit(distributor, "SignerChanged").withArgs(ethers.ZeroAddress, voucherSigner.address);
      await expect(deployTx).to.emit(distributor, "GuardianSet").withArgs(ethers.ZeroAddress, guardian.address);
      await expect(deployTx).to.emit(distributor, "OperatorSet").withArgs(ethers.ZeroAddress, operatorSafe.address);
      await expect(deployTx).to.emit(distributor, "Paused").withArgs(false);
      await expect(deployTx)
        .to.emit(distributor, "RewardTokenAdded")
        .withArgs(assetAddr, true, false, 18, "ASSET");
      await expect(deployTx)
        .to.emit(distributor, "RewardTokenAdded")
        .withArgs(overtureAddr, false, true, 18, "OVTR");
    });

    it("accepts an empty launch list", async function () {
      const bare = await deployDistributorProxy(
        owner.address,
        guardian.address,
        operatorSafe.address,
        voucherSigner.address,
        []
      );
      expect(await bare.rewardTokens()).to.deep.equal([]);
    });

    it("rejects a zero owner, guardian, operator or signer in initialize, through the proxy", async function () {
      const Distributor = await ethers.getContractFactory("RewardsDistributor");
      const tokens = launchTokens(assetAddr, overtureAddr);

      await expect(
        deployDistributorProxy(ethers.ZeroAddress, guardian.address, operatorSafe.address, voucherSigner.address, tokens)
      )
        .to.be.revertedWithCustomError(Distributor, "OwnableInvalidOwner")
        .withArgs(ethers.ZeroAddress);

      await expect(
        deployDistributorProxy(owner.address, ethers.ZeroAddress, operatorSafe.address, voucherSigner.address, tokens)
      ).to.be.revertedWithCustomError(Distributor, "ZeroAddress");

      // A zero operator would leave `setSigner` and `recoverExcess` callable by nobody, and the
      // pause switch held by the guardian alone.
      await expect(
        deployDistributorProxy(owner.address, guardian.address, ethers.ZeroAddress, voucherSigner.address, tokens)
      ).to.be.revertedWithCustomError(Distributor, "ZeroAddress");

      await expect(
        deployDistributorProxy(owner.address, guardian.address, operatorSafe.address, ethers.ZeroAddress, tokens)
      ).to.be.revertedWithCustomError(Distributor, "ZeroAddress");
    });

    it("rejects a zero or duplicated token in the launch list", async function () {
      const Distributor = await ethers.getContractFactory("RewardsDistributor");

      await expect(
        deployDistributorProxy(owner.address, guardian.address, operatorSafe.address, voucherSigner.address, [
          { token: ethers.ZeroAddress, conditional: false, claimsEnabled: true },
        ])
      ).to.be.revertedWithCustomError(Distributor, "ZeroAddress");

      await expect(
        deployDistributorProxy(owner.address, guardian.address, operatorSafe.address, voucherSigner.address, [
          { token: overtureAddr, conditional: false, claimsEnabled: true },
          { token: overtureAddr, conditional: true, claimsEnabled: false },
        ])
      )
        .to.be.revertedWithCustomError(Distributor, "RewardTokenAlreadyAdded")
        .withArgs(overtureAddr);
    });

    it("keeps the EIP-712 domain on the PROXY, which is what every voucher is signed against", async function () {
      const [, name, version, chainId, verifyingContract] = await distributor.eip712Domain();
      expect(name).to.equal("RealLPRewards");
      expect(version).to.equal("1");
      expect(verifyingContract).to.equal(distributorAddr);
      expect(chainId).to.equal((await ethers.provider.getNetwork()).chainId);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("claim — the cumulative model, per token", function () {
    it("pays the full cumulative amount on a first claim, by transfer out of the funded balance", async function () {
      const tx = await claimOverture(alice, TOKENS(100));
      const ts = await txTimestamp(tx);

      await expect(tx)
        .to.emit(distributor, "Claimed")
        .withArgs(alice.address, overtureAddr, TOKENS(100), TOKENS(100), ts);
      await expect(tx)
        .to.emit(overture, "Transfer")
        .withArgs(distributorAddr, alice.address, TOKENS(100));

      expect(await overture.balanceOf(alice.address)).to.equal(TOKENS(100));
      expect(await overture.balanceOf(distributorAddr)).to.equal(FUNDING - TOKENS(100));
      expect(await distributor.claimed(overtureAddr, alice.address)).to.equal(TOKENS(100));
      // Nothing was minted: the supply is what the minter put into the distributor.
      expect(await overture.totalSupply()).to.equal(FUNDING);
    });

    it("returns the paid amount", async function () {
      const sig = await signVoucher(overtureAddr, alice, TOKENS(100));
      expect(
        await distributor.connect(alice).claim.staticCall(overtureAddr, TOKENS(100), FAR_DEADLINE, sig)
      ).to.equal(TOKENS(100));
    });

    it("pays to the caller, never to a third party", async function () {
      await claimOverture(alice, TOKENS(100));
      expect(await overture.balanceOf(bob.address)).to.equal(0n);
    });

    it("pays only the difference on the next voucher", async function () {
      await claimOverture(alice, TOKENS(100));

      const tx = await claimOverture(alice, TOKENS(150));
      const ts = await txTimestamp(tx);

      await expect(tx)
        .to.emit(distributor, "Claimed")
        .withArgs(alice.address, overtureAddr, TOKENS(150), TOKENS(50), ts);

      expect(await overture.balanceOf(alice.address)).to.equal(TOKENS(150));
      expect(await distributor.claimed(overtureAddr, alice.address)).to.equal(TOKENS(150));
    });

    it("rejects a replay of the voucher just spent", async function () {
      await claimOverture(alice, TOKENS(150));

      await expect(claimOverture(alice, TOKENS(150)))
        .to.be.revertedWithCustomError(distributor, "NothingToClaim")
        .withArgs(TOKENS(150), TOKENS(150));
    });

    it("rejects an older voucher once a larger one has been claimed", async function () {
      const stale = await signVoucher(overtureAddr, alice, TOKENS(100));
      await claimOverture(alice, TOKENS(150));

      await expect(claimOverture(alice, TOKENS(100), { signature: stale }))
        .to.be.revertedWithCustomError(distributor, "NothingToClaim")
        .withArgs(TOKENS(100), TOKENS(150));

      expect(await overture.balanceOf(alice.address)).to.equal(TOKENS(150));
    });

    it("lets a user who earned across epochs collect everything in one call, with no per-epoch bound", async function () {
      // A lifetime entitlement far above any single epoch's emission: the distributor knows
      // nothing about epochs and pays it in one transaction.
      const tx = await claimOverture(alice, TOKENS(420_000));
      const ts = await txTimestamp(tx);

      await expect(tx)
        .to.emit(distributor, "Claimed")
        .withArgs(alice.address, overtureAddr, TOKENS(420_000), TOKENS(420_000), ts);
      expect(await overture.balanceOf(alice.address)).to.equal(TOKENS(420_000));
    });

    it("keeps per-user ledgers apart", async function () {
      await claimOverture(alice, TOKENS(100));
      await claimOverture(bob, TOKENS(30));

      expect(await distributor.claimed(overtureAddr, alice.address)).to.equal(TOKENS(100));
      expect(await distributor.claimed(overtureAddr, bob.address)).to.equal(TOKENS(30));
      expect(await overture.balanceOf(distributorAddr)).to.equal(FUNDING - TOKENS(130));
    });

    it("keeps per-token ledgers apart for the same user", async function () {
      await openAssetClaims();

      await claimOverture(alice, TOKENS(100));
      await claimAsset(alice, TOKENS(700));

      expect(await distributor.claimed(overtureAddr, alice.address)).to.equal(TOKENS(100));
      expect(await distributor.claimed(assetAddr, alice.address)).to.equal(TOKENS(700));

      // a further $OVTR claim does not disturb the $ASSET ledger and vice versa
      await claimOverture(alice, TOKENS(160));
      expect(await distributor.claimed(assetAddr, alice.address)).to.equal(TOKENS(700));
      await claimAsset(alice, TOKENS(800));
      expect(await distributor.claimed(overtureAddr, alice.address)).to.equal(TOKENS(160));

      expect(await overture.balanceOf(alice.address)).to.equal(TOKENS(160));
      expect(await asset.balanceOf(alice.address)).to.equal(TOKENS(800));
    });

    it("pays exactly the remaining balance, leaving the distributor at zero", async function () {
      const tx = await claimOverture(alice, FUNDING);
      await expect(tx).to.emit(distributor, "Claimed");
      expect(await overture.balanceOf(distributorAddr)).to.equal(0n);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("claim — InsufficientFunds until funded", function () {
    it("reverts with the token, the amount needed and the balance, and books nothing", async function () {
      await asOperator().recoverExcess(overtureAddr, FUNDING - TOKENS(40));
      expect(await overture.balanceOf(distributorAddr)).to.equal(TOKENS(40));

      await expect(claimOverture(alice, TOKENS(100)))
        .to.be.revertedWithCustomError(distributor, "InsufficientFunds")
        .withArgs(overtureAddr, TOKENS(100), TOKENS(40));

      expect(await distributor.claimed(overtureAddr, alice.address)).to.equal(0n);
      expect(await overture.balanceOf(alice.address)).to.equal(0n);
    });

    it("pays the SAME voucher in full once the company funds the contract — never partially", async function () {
      await asOperator().recoverExcess(overtureAddr, FUNDING);
      const sig = await signVoucher(overtureAddr, alice, TOKENS(100));

      await expect(claimOverture(alice, TOKENS(100), { signature: sig }))
        .to.be.revertedWithCustomError(distributor, "InsufficientFunds")
        .withArgs(overtureAddr, TOKENS(100), 0n);

      // One wei short is still short.
      await overture.connect(minter).mint(distributorAddr, TOKENS(100) - 1n);
      await expect(claimOverture(alice, TOKENS(100), { signature: sig }))
        .to.be.revertedWithCustomError(distributor, "InsufficientFunds")
        .withArgs(overtureAddr, TOKENS(100), TOKENS(100) - 1n);

      await overture.connect(minter).mint(distributorAddr, 1n);
      await claimOverture(alice, TOKENS(100), { signature: sig });
      expect(await overture.balanceOf(alice.address)).to.equal(TOKENS(100));
      expect(await overture.balanceOf(distributorAddr)).to.equal(0n);
    });

    it("compares against the payable DIFFERENCE, not the cumulative figure", async function () {
      await claimOverture(alice, TOKENS(100));
      await asOperator().recoverExcess(overtureAddr, await overture.balanceOf(distributorAddr) - TOKENS(30));

      // cumulative 150 means a 50 payout against 30 held
      await expect(claimOverture(alice, TOKENS(150)))
        .to.be.revertedWithCustomError(distributor, "InsufficientFunds")
        .withArgs(overtureAddr, TOKENS(50), TOKENS(30));

      // cumulative 130 means a 30 payout against 30 held: paid
      await claimOverture(alice, TOKENS(130));
      expect(await overture.balanceOf(alice.address)).to.equal(TOKENS(130));
    });

    it("a short balance of one token never blocks the other", async function () {
      await openAssetClaims();
      await asOperator().recoverExcess(assetAddr, FUNDING);

      await expect(claimAsset(alice, TOKENS(10)))
        .to.be.revertedWithCustomError(distributor, "InsufficientFunds")
        .withArgs(assetAddr, TOKENS(10), 0n);
      await claimOverture(alice, TOKENS(10));
      expect(await overture.balanceOf(alice.address)).to.equal(TOKENS(10));
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("claim — the check order", function () {
    // paused -> UnknownRewardToken -> TokenClaimsDisabled -> ClaimExpired -> NothingToClaim
    // -> InvalidSignature -> InsufficientFunds. Each test sets two hostile conditions at once
    // and asserts the earlier one wins, which is what makes the order a real order.

    it("ClaimsPaused beats UnknownRewardToken", async function () {
      await asGuardian().setPaused(true);
      await expect(claim(alice.address, alice, TOKENS(1))).to.be.revertedWithCustomError(
        distributor,
        "ClaimsPaused"
      );
    });

    it("UnknownRewardToken beats ClaimExpired, with the token named", async function () {
      const Token = await ethers.getContractFactory("MockERC20Decimals");
      const stray = await Token.deploy("Stray", "STRAY", TOKENS(1), 18);
      const strayAddr = await stray.getAddress();

      await expect(distributor.connect(alice).claim(strayAddr, TOKENS(1), 0n, "0x"))
        .to.be.revertedWithCustomError(distributor, "UnknownRewardToken")
        .withArgs(strayAddr);
    });

    it("TokenClaimsDisabled beats ClaimExpired — $ASSET is closed at launch", async function () {
      await expect(distributor.connect(alice).claim(assetAddr, TOKENS(1), 0n, "0x"))
        .to.be.revertedWithCustomError(distributor, "TokenClaimsDisabled")
        .withArgs(assetAddr);
    });

    it("ClaimExpired beats NothingToClaim", async function () {
      const now = BigInt(await time.latest());
      await expect(distributor.connect(alice).claim(overtureAddr, 0n, now - 1n, "0x"))
        .to.be.revertedWithCustomError(distributor, "ClaimExpired");
    });

    it("NothingToClaim beats InvalidSignature", async function () {
      await expect(distributor.connect(alice).claim(overtureAddr, 0n, FAR_DEADLINE, "0x"))
        .to.be.revertedWithCustomError(distributor, "NothingToClaim")
        .withArgs(0n, 0n);
    });

    it("InvalidSignature beats InsufficientFunds", async function () {
      await asOperator().recoverExcess(overtureAddr, FUNDING);
      const forged = await signVoucher(overtureAddr, alice, TOKENS(100), { signer: bob });

      await expect(claimOverture(alice, TOKENS(100), { signature: forged }))
        .to.be.revertedWithCustomError(distributor, "InvalidSignature")
        .withArgs(bob.address, voucherSigner.address);
    });

    it("InsufficientFunds is last: a valid voucher on an empty balance", async function () {
      await asOperator().recoverExcess(overtureAddr, FUNDING);
      await expect(claimOverture(alice, TOKENS(100)))
        .to.be.revertedWithCustomError(distributor, "InsufficientFunds")
        .withArgs(overtureAddr, TOKENS(100), 0n);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Voucher forgery and misuse", function () {
    it("a voucher signed for A cannot be redeemed by B — the digest binds msg.sender", async function () {
      const sig = await signVoucher(overtureAddr, alice, TOKENS(100));
      const recovered = await recoverFor(overtureAddr, bob, TOKENS(100), sig);

      await expect(distributor.connect(bob).claim(overtureAddr, TOKENS(100), FAR_DEADLINE, sig))
        .to.be.revertedWithCustomError(distributor, "InvalidSignature")
        .withArgs(recovered, voucherSigner.address);

      expect(recovered).to.not.equal(voucherSigner.address);
      expect(await overture.balanceOf(bob.address)).to.equal(0n);
    });

    it("a voucher signed with the wrong key is rejected, and names the recovered address", async function () {
      const sig = await signVoucher(overtureAddr, alice, TOKENS(100), { signer: bob });

      await expect(claimOverture(alice, TOKENS(100), { signature: sig }))
        .to.be.revertedWithCustomError(distributor, "InvalidSignature")
        .withArgs(bob.address, voucherSigner.address);
    });

    it("a tampered cumulative amount is rejected", async function () {
      const sig = await signVoucher(overtureAddr, alice, TOKENS(100));

      await expect(claimOverture(alice, TOKENS(100) + 1n, { signature: sig })).to.be.revertedWithCustomError(
        distributor,
        "InvalidSignature"
      );
      await expect(claimOverture(alice, TOKENS(100_000), { signature: sig })).to.be.revertedWithCustomError(
        distributor,
        "InvalidSignature"
      );
    });

    it("a tampered deadline is rejected", async function () {
      const sig = await signVoucher(overtureAddr, alice, TOKENS(100));

      await expect(
        distributor.connect(alice).claim(overtureAddr, TOKENS(100), FAR_DEADLINE + 1n, sig)
      ).to.be.revertedWithCustomError(distributor, "InvalidSignature");
    });

    it("an expired voucher is rejected with the deadline and the block timestamp", async function () {
      const now = await time.latest();
      const deadline = BigInt(now);
      const sig = await signVoucher(overtureAddr, alice, TOKENS(100), { deadline });

      await time.setNextBlockTimestamp(now + 10);
      await expect(distributor.connect(alice).claim(overtureAddr, TOKENS(100), deadline, sig))
        .to.be.revertedWithCustomError(distributor, "ClaimExpired")
        .withArgs(deadline, BigInt(now + 10));
    });

    it("a voucher is still good on the exact deadline second", async function () {
      const deadline = BigInt(await time.latest()) + 100n;
      const sig = await signVoucher(overtureAddr, alice, TOKENS(100), { deadline });

      await time.setNextBlockTimestamp(Number(deadline));
      await distributor.connect(alice).claim(overtureAddr, TOKENS(100), deadline, sig);
      expect(await overture.balanceOf(alice.address)).to.equal(TOKENS(100));
    });

    it("a $OVTR voucher is worthless for $ASSET, and leaves the $ASSET ledger untouched", async function () {
      await openAssetClaims();
      const sig = await signVoucher(overtureAddr, alice, TOKENS(100));

      await expect(
        distributor.connect(alice).claim(assetAddr, TOKENS(100), FAR_DEADLINE, sig)
      ).to.be.revertedWithCustomError(distributor, "InvalidSignature");

      expect(await distributor.claimed(assetAddr, alice.address)).to.equal(0n);
      expect(await asset.balanceOf(alice.address)).to.equal(0n);

      // ...and the same signature still spends on the token it names.
      await distributor.connect(alice).claim(overtureAddr, TOKENS(100), FAR_DEADLINE, sig);
      expect(await overture.balanceOf(alice.address)).to.equal(TOKENS(100));
    });

    it("a $ASSET voucher is worthless for $OVTR", async function () {
      const sig = await signVoucher(assetAddr, alice, TOKENS(100));

      await expect(
        distributor.connect(alice).claim(overtureAddr, TOKENS(100), FAR_DEADLINE, sig)
      ).to.be.revertedWithCustomError(distributor, "InvalidSignature");
      expect(await distributor.claimed(overtureAddr, alice.address)).to.equal(0n);
    });

    it("a voucher for another verifying contract is rejected", async function () {
      const twin = await deployDistributorProxy(
        owner.address,
        guardian.address,
        operatorSafe.address,
        voucherSigner.address,
        launchTokens(assetAddr, overtureAddr)
      );
      const sig = await signVoucher(overtureAddr, alice, TOKENS(100), {
        domain: await voucherDomain(await twin.getAddress()),
      });

      await expect(
        distributor.connect(alice).claim(overtureAddr, TOKENS(100), FAR_DEADLINE, sig)
      ).to.be.revertedWithCustomError(distributor, "InvalidSignature");
    });

    it("a zero-cumulative voucher pays nothing", async function () {
      await expect(claimOverture(alice, 0n))
        .to.be.revertedWithCustomError(distributor, "NothingToClaim")
        .withArgs(0n, 0n);
    });

    it("a malformed signature is rejected by ECDSA, not by the signer check", async function () {
      // documents the error surface a caller sees: OZ ECDSA throws on a bad encoding before
      // `InvalidSignature` can ever be reached
      await expect(distributor.connect(alice).claim(overtureAddr, TOKENS(100), FAR_DEADLINE, "0x"))
        .to.be.revertedWithCustomError(distributor, "ECDSAInvalidSignatureLength")
        .withArgs(0n);

      const garbage = "0x" + "11".repeat(65);
      await expect(
        distributor.connect(alice).claim(overtureAddr, TOKENS(100), FAR_DEADLINE, garbage)
      ).to.be.revertedWithCustomError(distributor, "ECDSAInvalidSignature");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("$ASSET: closed at launch, opened by the owner", function () {
    it("is closed by default with TokenClaimsDisabled", async function () {
      await expect(claimAsset(alice, TOKENS(500)))
        .to.be.revertedWithCustomError(distributor, "TokenClaimsDisabled")
        .withArgs(assetAddr);
    });

    it("is opened by the owner only — guardian and operator are rejected — with the full state in the event", async function () {
      for (const caller of [alice, guardian, operatorSafe]) {
        await expect(distributor.connect(caller).setClaimsEnabled(assetAddr, true))
          .to.be.revertedWithCustomError(distributor, "OwnableUnauthorizedAccount")
          .withArgs(caller.address);
      }

      await expect(distributor.setClaimsEnabled(assetAddr, true))
        .to.emit(distributor, "RewardTokenUpdated")
        .withArgs(assetAddr, true, true);
      expect((await distributor.rewardToken(assetAddr)).claimsEnabled).to.equal(true);

      await expect(distributor.setClaimsEnabled(assetAddr, false))
        .to.emit(distributor, "RewardTokenUpdated")
        .withArgs(assetAddr, true, false);
      await expect(claimAsset(alice, TOKENS(500)))
        .to.be.revertedWithCustomError(distributor, "TokenClaimsDisabled")
        .withArgs(assetAddr);
    });

    it("once open, pays out of the pre-funded balance by transfer and follows the cumulative model", async function () {
      await openAssetClaims();

      const tx = await claimAsset(alice, TOKENS(600));
      await expect(tx)
        .to.emit(distributor, "Claimed")
        .withArgs(alice.address, assetAddr, TOKENS(600), TOKENS(600), await txTimestamp(tx));
      expect(await asset.balanceOf(distributorAddr)).to.equal(FUNDING - TOKENS(600));

      const tx2 = await claimAsset(alice, TOKENS(900));
      await expect(tx2)
        .to.emit(distributor, "Claimed")
        .withArgs(alice.address, assetAddr, TOKENS(900), TOKENS(300), await txTimestamp(tx2));
      expect(await asset.balanceOf(alice.address)).to.equal(TOKENS(900));
      expect(await distributor.claimed(assetAddr, alice.address)).to.equal(TOKENS(900));
    });

    it("a voucher signed while closed spends once the claims open — closing never voids an entitlement", async function () {
      const sig = await signVoucher(assetAddr, alice, TOKENS(250));
      await expect(claimAsset(alice, TOKENS(250), { signature: sig })).to.be.revertedWithCustomError(
        distributor,
        "TokenClaimsDisabled"
      );
      await openAssetClaims();
      await claimAsset(alice, TOKENS(250), { signature: sig });
      expect(await asset.balanceOf(alice.address)).to.equal(TOKENS(250));
    });

    it("setClaimsEnabled names an unknown token in its rejection", async function () {
      await expect(distributor.setClaimsEnabled(alice.address, true))
        .to.be.revertedWithCustomError(distributor, "UnknownRewardToken")
        .withArgs(alice.address);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Reward tokens: addRewardToken and setRewardTokenEnabled", function () {
    let usdc, usdcAddr;

    beforeEach(async function () {
      const Token = await ethers.getContractFactory("MockERC20Decimals");
      usdc = await Token.deploy("USD Coin", "USDC", USDC(10_000_000), 6);
      usdcAddr = await usdc.getAddress();
    });

    it("is owner only — guardian, operator and a stranger are rejected", async function () {
      for (const caller of [alice, guardian, operatorSafe]) {
        await expect(distributor.connect(caller).addRewardToken(usdcAddr, false, true))
          .to.be.revertedWithCustomError(distributor, "OwnableUnauthorizedAccount")
          .withArgs(caller.address);
      }
    });

    it("adds a third token with its decimals and symbol read from chain, enabled on arrival", async function () {
      await expect(distributor.addRewardToken(usdcAddr, false, true))
        .to.emit(distributor, "RewardTokenAdded")
        .withArgs(usdcAddr, false, true, 6, "USDC");

      expect(await distributor.rewardTokens()).to.deep.equal([assetAddr, overtureAddr, usdcAddr]);
      const entry = await distributor.rewardToken(usdcAddr);
      expect(entry.registered).to.equal(true);
      expect(entry.enabled).to.equal(true);
      expect(entry.conditional).to.equal(false);
      expect(entry.claimsEnabled).to.equal(true);
      expect(entry.decimals).to.equal(6n);
      expect(await distributor.isRewardToken(usdcAddr)).to.equal(true);
    });

    it("a new token's claims revert InsufficientFunds until it is funded, then pay", async function () {
      await distributor.addRewardToken(usdcAddr, false, true);

      const sig = await signVoucher(usdcAddr, alice, USDC(1_234));
      await expect(claim(usdcAddr, alice, USDC(1_234), { signature: sig }))
        .to.be.revertedWithCustomError(distributor, "InsufficientFunds")
        .withArgs(usdcAddr, USDC(1_234), 0n);

      await usdc.transfer(distributorAddr, USDC(5_000));
      const tx = await claim(usdcAddr, alice, USDC(1_234), { signature: sig });
      await expect(tx)
        .to.emit(distributor, "Claimed")
        .withArgs(alice.address, usdcAddr, USDC(1_234), USDC(1_234), await txTimestamp(tx));
      expect(await usdc.balanceOf(alice.address)).to.equal(USDC(1_234));
      expect(await distributor.claimed(usdcAddr, alice.address)).to.equal(USDC(1_234));
    });

    it("can arrive conditional with claims closed, in one owner call", async function () {
      await expect(distributor.addRewardToken(usdcAddr, true, false))
        .to.emit(distributor, "RewardTokenAdded")
        .withArgs(usdcAddr, true, false, 6, "USDC");
      await expect(claim(usdcAddr, alice, USDC(1)))
        .to.be.revertedWithCustomError(distributor, "TokenClaimsDisabled")
        .withArgs(usdcAddr);
    });

    it("rejects a zero address and a duplicate", async function () {
      await expect(distributor.addRewardToken(ethers.ZeroAddress, false, true)).to.be.revertedWithCustomError(
        distributor,
        "ZeroAddress"
      );
      await expect(distributor.addRewardToken(assetAddr, false, true))
        .to.be.revertedWithCustomError(distributor, "RewardTokenAlreadyAdded")
        .withArgs(assetAddr);
    });

    it("rejects an address that is not an ERC-20 (decimals() cannot be read)", async function () {
      await expect(distributor.addRewardToken(alice.address, false, true)).to.be.reverted;
      expect(await distributor.rewardTokens()).to.deep.equal([assetAddr, overtureAddr]);
    });

    it("setRewardTokenEnabled is owner only, emits the full state and only takes the token off the schedule", async function () {
      for (const caller of [alice, guardian, operatorSafe]) {
        await expect(distributor.connect(caller).setRewardTokenEnabled(overtureAddr, false))
          .to.be.revertedWithCustomError(distributor, "OwnableUnauthorizedAccount")
          .withArgs(caller.address);
      }

      await expect(distributor.setRewardTokenEnabled(overtureAddr, false))
        .to.emit(distributor, "RewardTokenUpdated")
        .withArgs(overtureAddr, false, true);
      expect(await distributor.isRewardToken(overtureAddr)).to.equal(false);
      expect((await distributor.rewardToken(overtureAddr)).registered).to.equal(true);
      // Never removed from the list.
      expect(await distributor.rewardTokens()).to.deep.equal([assetAddr, overtureAddr]);

      // `enabled` gates the schedule, not the claims: what was earned stays claimable.
      await claimOverture(alice, TOKENS(10));
      expect(await overture.balanceOf(alice.address)).to.equal(TOKENS(10));

      await expect(distributor.setRewardTokenEnabled(overtureAddr, true))
        .to.emit(distributor, "RewardTokenUpdated")
        .withArgs(overtureAddr, true, true);
      expect(await distributor.isRewardToken(overtureAddr)).to.equal(true);
    });

    it("setClaimsEnabled keeps the enabled flag in its event, whichever setter ran last", async function () {
      await distributor.setRewardTokenEnabled(assetAddr, false);
      await expect(distributor.setClaimsEnabled(assetAddr, true))
        .to.emit(distributor, "RewardTokenUpdated")
        .withArgs(assetAddr, false, true);
    });

    it("setRewardTokenEnabled names an unknown token in its rejection", async function () {
      await expect(distributor.setRewardTokenEnabled(usdcAddr, true))
        .to.be.revertedWithCustomError(distributor, "UnknownRewardToken")
        .withArgs(usdcAddr);
    });

    it("an unregistered token never pays, even with a funded balance and a valid signature", async function () {
      await usdc.transfer(distributorAddr, USDC(1_000));
      await expect(claim(usdcAddr, alice, USDC(10)))
        .to.be.revertedWithCustomError(distributor, "UnknownRewardToken")
        .withArgs(usdcAddr);
      expect(await usdc.balanceOf(distributorAddr)).to.equal(USDC(1_000));
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Pause", function () {
    it("is guardian OR operator — the owner is rejected — and emits Paused", async function () {
      await expect(distributor.connect(alice).setPaused(true))
        .to.be.revertedWithCustomError(distributor, "NotGuardianOrOperator")
        .withArgs(alice.address, guardian.address, operatorSafe.address);

      // The pause is an incident switch. Routing it through the timelock would mean waiting
      // out the delay before a live bug can be stopped, so the OWNER does not hold it.
      await expect(distributor.setPaused(true))
        .to.be.revertedWithCustomError(distributor, "NotGuardianOrOperator")
        .withArgs(owner.address, guardian.address, operatorSafe.address);

      await expect(asGuardian().setPaused(true)).to.emit(distributor, "Paused").withArgs(true);
      expect(await distributor.paused()).to.equal(true);

      // The operator holds the same switch, as the cold fallback for a lost guardian key.
      await expect(asOperator().setPaused(false)).to.emit(distributor, "Paused").withArgs(false);
      expect(await distributor.paused()).to.equal(false);
    });

    it("blocks every token while paused and restores them all on unpause", async function () {
      await openAssetClaims();
      await asGuardian().setPaused(true);

      await expect(claimOverture(alice, TOKENS(100))).to.be.revertedWithCustomError(distributor, "ClaimsPaused");
      await expect(claimAsset(alice, TOKENS(500))).to.be.revertedWithCustomError(distributor, "ClaimsPaused");

      await expect(asGuardian().setPaused(false)).to.emit(distributor, "Paused").withArgs(false);

      await claimOverture(alice, TOKENS(100));
      await claimAsset(alice, TOKENS(500));
      expect(await overture.balanceOf(alice.address)).to.equal(TOKENS(100));
      expect(await asset.balanceOf(alice.address)).to.equal(TOKENS(500));
    });

    it("leaves the admin functions usable while paused", async function () {
      await asGuardian().setPaused(true);

      await asOperator().setSigner(bob.address);
      expect(await distributor.signer()).to.equal(bob.address);

      await distributor.setClaimsEnabled(assetAddr, true);
      expect((await distributor.rewardToken(assetAddr)).claimsEnabled).to.equal(true);

      await asOperator().recoverExcess(overtureAddr, TOKENS(1));
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Signer rotation", function () {
    it("is operator only — the owner and the guardian are rejected — rejects address(0) and emits SignerChanged", async function () {
      await expect(distributor.connect(alice).setSigner(alice.address))
        .to.be.revertedWithCustomError(distributor, "NotOperator")
        .withArgs(alice.address, operatorSafe.address);

      // Key-compromise recovery cannot wait out a timelock, so the OWNER does not hold it.
      await expect(distributor.setSigner(treasury.address))
        .to.be.revertedWithCustomError(distributor, "NotOperator")
        .withArgs(owner.address, operatorSafe.address);

      // And whoever holds this call can install a signer of their own and take the funded
      // balances, so it belongs to a multisig, not to the hot GUARDIAN key. The guardian's
      // `setPaused` is the one-transaction containment; this is the follow-up.
      await expect(asGuardian().setSigner(treasury.address))
        .to.be.revertedWithCustomError(distributor, "NotOperator")
        .withArgs(guardian.address, operatorSafe.address);

      await expect(asOperator().setSigner(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        distributor,
        "ZeroAddress"
      );

      await expect(asOperator().setSigner(treasury.address))
        .to.emit(distributor, "SignerChanged")
        .withArgs(voucherSigner.address, treasury.address);
      expect(await distributor.signer()).to.equal(treasury.address);
    });

    it("invalidates every outstanding voucher of the compromised key, for every token", async function () {
      await openAssetClaims();
      const oldOverture = await signVoucher(overtureAddr, alice, TOKENS(100));
      const oldAsset = await signVoucher(assetAddr, alice, TOKENS(100));

      await asOperator().setSigner(treasury.address);

      await expect(claimOverture(alice, TOKENS(100), { signature: oldOverture }))
        .to.be.revertedWithCustomError(distributor, "InvalidSignature")
        .withArgs(voucherSigner.address, treasury.address);
      await expect(claimAsset(alice, TOKENS(100), { signature: oldAsset }))
        .to.be.revertedWithCustomError(distributor, "InvalidSignature")
        .withArgs(voucherSigner.address, treasury.address);

      const newSig = await signVoucher(overtureAddr, alice, TOKENS(100), { signer: treasury });
      await claimOverture(alice, TOKENS(100), { signature: newSig });
      expect(await overture.balanceOf(alice.address)).to.equal(TOKENS(100));
    });

    it("rotation does not disturb what was already paid", async function () {
      await claimOverture(alice, TOKENS(100));
      await asOperator().setSigner(treasury.address);

      const newSig = await signVoucher(overtureAddr, alice, TOKENS(150), { signer: treasury });
      await claimOverture(alice, TOKENS(150), { signature: newSig });

      expect(await overture.balanceOf(alice.address)).to.equal(TOKENS(150));
      expect(await distributor.claimed(overtureAddr, alice.address)).to.equal(TOKENS(150));
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("recoverExcess", function () {
    it("is operator only — the owner and the guardian are rejected too", async function () {
      await expect(distributor.connect(alice).recoverExcess(overtureAddr, 1n))
        .to.be.revertedWithCustomError(distributor, "NotOperator")
        .withArgs(alice.address, operatorSafe.address);

      // The owner is a timelock contract, which has no way to forward an ERC-20 anyway.
      await expect(distributor.recoverExcess(overtureAddr, 1n))
        .to.be.revertedWithCustomError(distributor, "NotOperator")
        .withArgs(owner.address, operatorSafe.address);

      // And this moves treasury money, which the hot GUARDIAN key must never be able to do.
      await expect(asGuardian().recoverExcess(overtureAddr, 1n))
        .to.be.revertedWithCustomError(distributor, "NotOperator")
        .withArgs(guardian.address, operatorSafe.address);
    });

    it("rejects a zero amount", async function () {
      await expect(asOperator().recoverExcess(overtureAddr, 0n)).to.be.revertedWithCustomError(
        distributor,
        "ZeroAmount"
      );
    });

    it("moves the token to the operator, never to the owner or the guardian, and emits ExcessRecovered", async function () {
      const operatorBefore = await asset.balanceOf(operatorSafe.address);
      const guardianBefore = await asset.balanceOf(guardian.address);
      const ownerBefore = await asset.balanceOf(owner.address);

      const tx = await asOperator().recoverExcess(assetAddr, TOKENS(400));
      await expect(tx)
        .to.emit(distributor, "ExcessRecovered")
        .withArgs(assetAddr, operatorSafe.address, TOKENS(400), await txTimestamp(tx));

      expect((await asset.balanceOf(operatorSafe.address)) - operatorBefore).to.equal(TOKENS(400));
      expect(await asset.balanceOf(guardian.address)).to.equal(guardianBefore);
      expect(await asset.balanceOf(owner.address)).to.equal(ownerBefore);
      expect(await asset.balanceOf(distributorAddr)).to.equal(FUNDING - TOKENS(400));
    });

    it("recovers any token, a stray unregistered one included", async function () {
      const Token = await ethers.getContractFactory("MockERC20Decimals");
      const stray = await Token.deploy("Stray", "STRAY", TOKENS(10), 18);
      const strayAddr = await stray.getAddress();
      await stray.transfer(distributorAddr, TOKENS(3));

      await expect(asOperator().recoverExcess(strayAddr, TOKENS(3)))
        .to.emit(distributor, "ExcessRecovered")
        .withArgs(strayAddr, operatorSafe.address, TOKENS(3), (v) => v > 0n);
      expect(await stray.balanceOf(operatorSafe.address)).to.equal(TOKENS(3));
    });

    it("cannot pull more than the contract holds", async function () {
      await expect(asOperator().recoverExcess(overtureAddr, FUNDING + 1n))
        .to.be.revertedWithCustomError(overture, "ERC20InsufficientBalance")
        .withArgs(distributorAddr, FUNDING, FUNDING + 1n);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("setGuardian", function () {
    it("takes the owner or the operator, and names all three in the rejection", async function () {
      // The guardian cannot rotate itself, so a leaked hot key cannot keep itself installed.
      await expect(asGuardian().setGuardian(alice.address))
        .to.be.revertedWithCustomError(distributor, "NotOwnerOrOperator")
        .withArgs(guardian.address, owner.address, operatorSafe.address);

      await expect(distributor.connect(alice).setGuardian(alice.address))
        .to.be.revertedWithCustomError(distributor, "NotOwnerOrOperator")
        .withArgs(alice.address, owner.address, operatorSafe.address);

      await expect(distributor.setGuardian(treasury.address))
        .to.emit(distributor, "GuardianSet")
        .withArgs(guardian.address, treasury.address);
      expect(await distributor.guardian()).to.equal(treasury.address);
    });

    it("lets the OPERATOR revoke the guardian in one transaction with address(0)", async function () {
      await expect(asOperator().setGuardian(ethers.ZeroAddress))
        .to.emit(distributor, "GuardianSet")
        .withArgs(guardian.address, ethers.ZeroAddress);
      expect(await distributor.guardian()).to.equal(ethers.ZeroAddress);

      // address(0) is the explicit "no guardian" state: the former guardian loses the pause
      // switch at once.
      await expect(asGuardian().setPaused(true))
        .to.be.revertedWithCustomError(distributor, "NotGuardianOrOperator")
        .withArgs(guardian.address, ethers.ZeroAddress, operatorSafe.address);

      // The operator still holds the switch itself.
      await asOperator().setPaused(true);
      expect(await distributor.paused()).to.equal(true);

      // And the owner can re-appoint afterwards, from the vacant state.
      await expect(distributor.setGuardian(treasury.address))
        .to.emit(distributor, "GuardianSet")
        .withArgs(ethers.ZeroAddress, treasury.address);
      await distributor.connect(treasury).setPaused(false);
      expect(await distributor.paused()).to.equal(false);
    });

    it("lets the OPERATOR appoint a replacement guardian, not only revoke", async function () {
      await expect(asOperator().setGuardian(treasury.address))
        .to.emit(distributor, "GuardianSet")
        .withArgs(guardian.address, treasury.address);
      await distributor.connect(treasury).setPaused(true);
      expect(await distributor.paused()).to.equal(true);
    });

    it("does not take the signer rotation or the recovery with it", async function () {
      await distributor.setGuardian(treasury.address);

      await expect(distributor.connect(treasury).setSigner(alice.address))
        .to.be.revertedWithCustomError(distributor, "NotOperator")
        .withArgs(treasury.address, operatorSafe.address);

      await expect(distributor.connect(treasury).recoverExcess(overtureAddr, 1n))
        .to.be.revertedWithCustomError(distributor, "NotOperator")
        .withArgs(treasury.address, operatorSafe.address);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("setOperator", function () {
    it("is owner only, rejects address(0) and emits OperatorSet", async function () {
      await expect(asOperator().setOperator(alice.address))
        .to.be.revertedWithCustomError(distributor, "OwnableUnauthorizedAccount")
        .withArgs(operatorSafe.address);

      // The operator cannot rotate itself, so losing the multisig is recoverable through the
      // timelock rather than terminal.
      await expect(asGuardian().setOperator(alice.address))
        .to.be.revertedWithCustomError(distributor, "OwnableUnauthorizedAccount")
        .withArgs(guardian.address);

      await expect(distributor.setOperator(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        distributor,
        "ZeroAddress"
      );

      await expect(distributor.setOperator(treasury.address))
        .to.emit(distributor, "OperatorSet")
        .withArgs(operatorSafe.address, treasury.address);
      expect(await distributor.operator()).to.equal(treasury.address);
    });

    it("moves the whole operator tier in one call, recovery destination included", async function () {
      await distributor.setOperator(treasury.address);

      await expect(asOperator().setSigner(alice.address))
        .to.be.revertedWithCustomError(distributor, "NotOperator")
        .withArgs(operatorSafe.address, treasury.address);

      await distributor.connect(treasury).setSigner(alice.address);
      expect(await distributor.signer()).to.equal(alice.address);

      const before = await asset.balanceOf(treasury.address);
      await distributor.connect(treasury).recoverExcess(assetAddr, TOKENS(400));
      expect((await asset.balanceOf(treasury.address)) - before).to.equal(TOKENS(400));

      // ...and the pause tier follows the operator too, because the operator holds it.
      await distributor.connect(treasury).setPaused(true);
      expect(await distributor.paused()).to.equal(true);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Hostile reward tokens", function () {
    /// Registers `token` on the standing distributor with claims open, through the owner.
    async function register(token) {
      await distributor.addRewardToken(await token.getAddress(), false, true);
    }

    it("rejects a token whose transfer returns false instead of reverting, and books nothing", async function () {
      const Silent = await ethers.getContractFactory("MockReturnsFalseERC20");
      const silent = await Silent.deploy("Silent", "SILENT", TOKENS(1_000_000), 18);
      const silentAddr = await silent.getAddress();
      await register(silent);

      // This mock cannot transfer at all, so the distributor's balance is written directly:
      // OpenZeppelin ERC20 keeps `_balances` at slot 0, keyed by the holder.
      const balanceSlot = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [distributorAddr, 0n])
      );
      await ethers.provider.send("hardhat_setStorageAt", [
        silentAddr,
        balanceSlot,
        ethers.toBeHex(TOKENS(1_000), 32),
      ]);
      expect(await silent.balanceOf(distributorAddr)).to.equal(TOKENS(1_000));

      // The payout is after the ledger write, so an unchecked return value would leave the
      // ledger saying "paid" with nothing sent. SafeERC20 turns it into a revert.
      await expect(claim(silentAddr, alice, TOKENS(500)))
        .to.be.revertedWithCustomError(distributor, "SafeERC20FailedOperation")
        .withArgs(silentAddr);

      expect(await distributor.claimed(silentAddr, alice.address)).to.equal(0n);
    });

    it("books the amount sent, so a fee-on-transfer token shorts the claimer for good (unsupported, documented)", async function () {
      const FeeToken = await ethers.getContractFactory("MockFeeOnTransferERC20");
      const feeToken = await FeeToken.deploy("Fee Coin", "FEE", USDC(1_000_000), 6, 100);
      const feeTokenAddr = await feeToken.getAddress();
      await register(feeToken);

      // the 1% cut applies to the funding transfer too
      await feeToken.transfer(distributorAddr, USDC(10_000));
      expect(await feeToken.balanceOf(distributorAddr)).to.equal(USDC(9_900));

      const tx = await claim(feeTokenAddr, alice, USDC(500));
      // the event and the ledger both state the amount sent, not the amount that arrived
      await expect(tx)
        .to.emit(distributor, "Claimed")
        .withArgs(alice.address, feeTokenAddr, USDC(500), USDC(500), await txTimestamp(tx));
      expect(await distributor.claimed(feeTokenAddr, alice.address)).to.equal(USDC(500));
      expect(await feeToken.balanceOf(alice.address)).to.equal(USDC(495));

      // and the shortfall is unrecoverable: the cumulative ledger already counts it as paid
      await expect(claim(feeTokenAddr, alice, USDC(500)))
        .to.be.revertedWithCustomError(distributor, "NothingToClaim")
        .withArgs(USDC(500), USDC(500));
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Property: out-of-order vouchers never overpay", function () {
    // Deterministic PRNG (mulberry32). No Math.random — the sequence must be reproducible so
    // a failure is replayable.
    function makeRng(seed) {
      let s = seed >>> 0;
      return function next() {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    it("pays each user, per token, exactly the highest cumulative figure they ever landed", async function () {
      await openAssetClaims();
      const signers = await ethers.getSigners();
      const users = [signers[10], signers[11], signers[12]];
      const tokens = [overtureAddr, assetAddr];
      const tokenContract = { [overtureAddr]: overture, [assetAddr]: asset };

      const rng = makeRng(0xc0ffee);
      const VOUCHERS = 30;

      const key = (u, t) => `${u}:${t}`;
      const state = new Map();
      for (const u of users) {
        for (const t of tokens) {
          state.set(key(u.address, t), { paid: 0n, maxSigned: 0n, maxLanded: 0n, landed: 0, reverted: 0 });
        }
      }

      for (let i = 0; i < VOUCHERS; i++) {
        const user = users[Math.floor(rng() * users.length)];
        const token = tokens[Math.floor(rng() * tokens.length)];
        // 1..200 whole tokens, deliberately non-monotonic
        const cumulative = TOKENS(Math.floor(rng() * 200) + 1);
        const book = state.get(key(user.address, token));
        if (cumulative > book.maxSigned) book.maxSigned = cumulative;

        const sig = await signVoucher(token, user, cumulative);
        const before = await tokenContract[token].balanceOf(user.address);

        try {
          await (await distributor.connect(user).claim(token, cumulative, FAR_DEADLINE, sig)).wait();
        } catch (err) {
          book.reverted += 1;
          // the only legitimate rejection in this sequence is a stale voucher
          expect(err.message).to.match(/NothingToClaim/);
          expect(await tokenContract[token].balanceOf(user.address)).to.equal(before);
          continue;
        }

        book.paid += (await tokenContract[token].balanceOf(user.address)) - before;
        book.landed += 1;
        if (cumulative > book.maxLanded) book.maxLanded = cumulative;
      }

      let totalLanded = 0;
      let totalReverted = 0;
      for (const user of users) {
        for (const token of tokens) {
          const book = state.get(key(user.address, token));
          totalLanded += book.landed;
          totalReverted += book.reverted;

          // the sum of every payout equals the highest cumulative that landed
          expect(book.paid).to.equal(book.maxLanded);
          // and never exceeds the highest figure the signer ever authorised
          expect(book.paid).to.be.lte(book.maxSigned);
          // on-chain ledger and the off-chain tally agree
          expect(await distributor.claimed(token, user.address)).to.equal(book.maxLanded);
        }
      }

      // sanity: the sequence really did exercise both branches
      expect(totalLanded).to.be.gt(0);
      expect(totalReverted).to.be.gt(0);
      expect(totalLanded + totalReverted).to.equal(VOUCHERS);

      // Second pass: empty the $OVTR balance and sign a voucher above every landed figure. It
      // must never pay — the funded balance is the only thing between a valid voucher and its
      // payment — so "paid <= highest figure signed" now carries real slack.
      await asOperator().recoverExcess(overtureAddr, await overture.balanceOf(distributorAddr));
      for (const user of users) {
        const book = state.get(key(user.address, overtureAddr));
        const oversized = book.maxSigned + TOKENS(500);
        book.maxSigned = oversized;

        const sig = await signVoucher(overtureAddr, user, oversized);
        await expect(
          distributor.connect(user).claim(overtureAddr, oversized, FAR_DEADLINE, sig)
        ).to.be.revertedWithCustomError(distributor, "InsufficientFunds");

        expect(book.paid).to.be.lt(book.maxSigned);
        expect(await distributor.claimed(overtureAddr, user.address)).to.equal(book.maxLanded);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Golden vector (ethers v6 RewardClaim signature)", function () {
    // The vector backend, indexer and frontend reproduce. It is verified against the contract
    // in Foundry (chain id 1, distributor at 0x1111…); Hardhat cannot run a proxy at that
    // address on chain id 1, so here the digest and the signature are checked with ethers, and
    // the type hash against the deployed contract.
    const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    const DOMAIN = {
      name: "RealLPRewards",
      version: "1",
      chainId: 1n,
      verifyingContract: "0x1111111111111111111111111111111111111111",
    };
    const MESSAGE = {
      token: "0x2222222222222222222222222222222222222222",
      user: "0x3333333333333333333333333333333333333333",
      cumulativeAmount: 1234500000000000000000n,
      deadline: 1791331200n,
    };
    const SIGNATURE =
      "0xbf7b1e4944b2063978769fd2859cb15b8f458299b89a2d2c05be3bf5d58b9aa21562c9a4700a2db4e1a86c42932e26b9c32cc5c90afbfffcedf0d784549262f61c";

    it("reproduces the published signature, digest and struct hash", async function () {
      const wallet = new ethers.Wallet(KEY);
      expect(wallet.address).to.equal("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");

      expect(await wallet.signTypedData(DOMAIN, REWARD_CLAIM_TYPES, MESSAGE)).to.equal(SIGNATURE);
      expect(ethers.TypedDataEncoder.hashDomain(DOMAIN)).to.equal(
        "0x85b58a2464a6bbaeeaa741942d9fe25cdc3afca3c56c86fe12d8527ea9a792c5"
      );
      expect(ethers.TypedDataEncoder.hashStruct("RewardClaim", REWARD_CLAIM_TYPES, MESSAGE)).to.equal(
        "0x4eaf64b4fe0098dd640da7a5c528f85f6e5d8ed6f65f292b60a9d9065bfef584"
      );
      expect(ethers.TypedDataEncoder.hash(DOMAIN, REWARD_CLAIM_TYPES, MESSAGE)).to.equal(
        "0x97f5d34cfb470872d8a84efb208bb80e466482eaf92e8f73e341d6e948383352"
      );
      expect(ethers.verifyTypedData(DOMAIN, REWARD_CLAIM_TYPES, MESSAGE, SIGNATURE)).to.equal(wallet.address);
    });

    it("the struct hash is keccak(typehash, token, user, amount, deadline) with the contract's typehash", async function () {
      const onChainTypehash = await distributor.REWARD_CLAIM_TYPEHASH();
      const manual = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "address", "address", "uint256", "uint256"],
          [onChainTypehash, MESSAGE.token, MESSAGE.user, MESSAGE.cumulativeAmount, MESSAGE.deadline]
        )
      );
      expect(manual).to.equal(ethers.TypedDataEncoder.hashStruct("RewardClaim", REWARD_CLAIM_TYPES, MESSAGE));
      expect(onChainTypehash).to.equal(rewardClaimTypeHash());
    });

    it("the same signing code is accepted by the deployed contract on this chain", async function () {
      // Hardhat account #0 IS the golden key, so a distributor whose signer is that address
      // redeems a voucher made exactly as above, with this chain's domain.
      expect(owner.address).to.equal("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
      await asOperator().setSigner(owner.address);
      const wallet = new ethers.Wallet(KEY);
      const sig = await wallet.signTypedData(await voucherDomain(), REWARD_CLAIM_TYPES, {
        token: overtureAddr,
        user: alice.address,
        cumulativeAmount: TOKENS(1_234.5),
        deadline: FAR_DEADLINE,
      });
      await distributor.connect(alice).claim(overtureAddr, TOKENS(1_234.5), FAR_DEADLINE, sig);
      expect(await overture.balanceOf(alice.address)).to.equal(TOKENS(1_234.5));
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Upgradeability", function () {
    // `missing-initializer`: V2 is an upgrade of an ALREADY-initialized proxy, so it declares
    // no `initializer` of its own — its `initializeV2` is a `reinitializer(2)`, and re-running
    // V1's `initialize` is precisely what must not happen.
    const V2_ARGS = {
      unsafeAllow: ["constructor", "state-variable-immutable", "missing-initializer"],
    };

    async function v2Factory() {
      return ethers.getContractFactory("RewardsDistributorV2Mock");
    }

    it("passes the plugin's own implementation-safety check, V1 and V2", async function () {
      await upgrades.validateImplementation(await ethers.getContractFactory("RewardsDistributor"), {
        kind: "uups",
        constructorArgs: [],
        unsafeAllow: UNSAFE_ALLOW,
      });
      await upgrades.validateImplementation(await v2Factory(), {
        kind: "uups",
        constructorArgs: [],
        ...V2_ARGS,
      });
    });

    it("keeps the per-token ledgers, the token list, the signer and every role across upgradeProxy", async function () {
      await openAssetClaims();
      await claimOverture(alice, TOKENS(100));
      await claimAsset(bob, TOKENS(250));

      const upgraded = await upgrades.upgradeProxy(distributorAddr, await v2Factory(), {
        kind: "uups",
        ...V2_ARGS,
      });

      expect(await upgraded.version()).to.equal(2n);
      expect(await upgraded.getAddress()).to.equal(distributorAddr);
      expect(await upgraded.claimed(overtureAddr, alice.address)).to.equal(TOKENS(100));
      expect(await upgraded.claimed(assetAddr, bob.address)).to.equal(TOKENS(250));
      expect(await upgraded.claimed(assetAddr, alice.address)).to.equal(0n);
      expect(await upgraded.rewardTokens()).to.deep.equal([assetAddr, overtureAddr]);
      expect((await upgraded.rewardToken(assetAddr)).claimsEnabled).to.equal(true);
      expect((await upgraded.rewardToken(assetAddr)).conditional).to.equal(true);
      expect(await upgraded.signer()).to.equal(voucherSigner.address);
      expect(await upgraded.guardian()).to.equal(guardian.address);
      expect(await upgraded.operator()).to.equal(operatorSafe.address);
      expect(await upgraded.owner()).to.equal(owner.address);

      // A replayed voucher is still a replay after the upgrade: the ledger moved with the proxy.
      await expect(claimOverture(alice, TOKENS(100)))
        .to.be.revertedWithCustomError(distributor, "NothingToClaim")
        .withArgs(TOKENS(100), TOKENS(100));
    });

    it("keeps the EIP-712 domain, so vouchers signed before the upgrade still spend", async function () {
      const sig = await signVoucher(overtureAddr, alice, TOKENS(100));

      await upgrades.upgradeProxy(distributorAddr, await v2Factory(), { kind: "uups", ...V2_ARGS });

      const [, name, version, , verifyingContract] = await distributor.eip712Domain();
      expect(name).to.equal("RealLPRewards");
      expect(version).to.equal("1");
      expect(verifyingContract).to.equal(distributorAddr);

      await claimOverture(alice, TOKENS(100), { signature: sig });
      expect(await overture.balanceOf(alice.address)).to.equal(TOKENS(100));
    });

    it("runs the V2 reinitializer once through upgradeToAndCall", async function () {
      const V2 = await v2Factory();
      const impl = await V2.deploy();
      await impl.waitForDeployment();
      const data = impl.interface.encodeFunctionData("initializeV2", [99n]);

      await distributor.upgradeToAndCall(await impl.getAddress(), data);
      const v2 = await ethers.getContractAt("RewardsDistributorV2Mock", distributorAddr);
      expect(await v2.upgradeMarker()).to.equal(99n);
      await expect(v2.initializeV2(1n)).to.be.revertedWithCustomError(v2, "InvalidInitialization");
    });

    it("cannot initialise the implementation behind the proxy", async function () {
      const implAddr = await upgrades.erc1967.getImplementationAddress(distributorAddr);
      const impl = await ethers.getContractAt("RewardsDistributor", implAddr);

      await expect(
        impl.initialize(alice.address, alice.address, alice.address, alice.address, [])
      ).to.be.revertedWithCustomError(impl, "InvalidInitialization");
    });

    it("cannot initialise the proxy a second time", async function () {
      await expect(
        distributor.initialize(alice.address, alice.address, alice.address, alice.address, [])
      ).to.be.revertedWithCustomError(distributor, "InvalidInitialization");
    });

    it("rejects upgradeToAndCall from a stranger, from the guardian and from the operator", async function () {
      const V2 = await v2Factory();
      const impl = await V2.deploy();
      await impl.waitForDeployment();
      const implAddr = await impl.getAddress();

      for (const caller of [alice, guardian, operatorSafe, treasury]) {
        await expect(distributor.connect(caller).upgradeToAndCall(implAddr, "0x"))
          .to.be.revertedWithCustomError(distributor, "OwnableUnauthorizedAccount")
          .withArgs(caller.address);
      }

      // ...and the owner can.
      await expect(distributor.upgradeToAndCall(implAddr, "0x"))
        .to.emit(distributor, "Upgraded")
        .withArgs(implAddr);
    });

    it("refuses renounceOwnership, so the upgrade path can never be frozen", async function () {
      await expect(distributor.renounceOwnership()).to.be.revertedWithCustomError(
        distributor,
        "RenounceDisabled"
      );
      expect(await distributor.owner()).to.equal(owner.address);

      // A stranger still gets the standard Ownable rejection, not the reason.
      await expect(distributor.connect(alice).renounceOwnership())
        .to.be.revertedWithCustomError(distributor, "OwnableUnauthorizedAccount")
        .withArgs(alice.address);
    });

    it("keeps the ledger in the pinned ERC-7201 namespace, claimed[token][user] at keccak(user, keccak(token, base + 5))", async function () {
      const base =
        ethers.toBigInt(
          ethers.keccak256(
            ethers.AbiCoder.defaultAbiCoder().encode(
              ["uint256"],
              [ethers.toBigInt(ethers.keccak256(ethers.toUtf8Bytes("real.lp.storage.RewardsDistributor"))) - 1n]
            )
          )
        ) & ~0xffn;
      expect(ethers.toBeHex(base, 32)).to.equal(
        "0x111abb03172b09f746748b28040854f0c669e7caa9373080b8bbaa7c3af02e00"
      );

      await claimOverture(alice, TOKENS(77));
      const coder = ethers.AbiCoder.defaultAbiCoder();
      const inner = ethers.keccak256(coder.encode(["address", "uint256"], [overtureAddr, base + 5n]));
      const slot = ethers.keccak256(coder.encode(["address", "bytes32"], [alice.address, inner]));
      expect(ethers.toBigInt(await ethers.provider.getStorage(distributorAddr, slot))).to.equal(TOKENS(77));

      // slot 0: signer, then `paused` packed right after it
      const slot0 = await ethers.provider.getStorage(distributorAddr, base);
      expect(ethers.getAddress(ethers.dataSlice(slot0, 12))).to.equal(voucherSigner.address);
    });

    describe("under a TimelockController", function () {
      const MIN_DELAY = 60n;
      let timelock, timelockAddr;

      // OZ operation ids are keccak of the whole call tuple; the helper keeps schedule and
      // execute reading from the same arguments so they can never drift apart.
      const PREDECESSOR = ethers.ZeroHash;

      async function schedule(target, data, salt = ethers.ZeroHash) {
        return timelock.connect(treasury).schedule(target, 0, data, PREDECESSOR, salt, MIN_DELAY);
      }

      async function execute(target, data, salt = ethers.ZeroHash) {
        return timelock.connect(treasury).execute(target, 0, data, PREDECESSOR, salt);
      }

      async function handOverToTimelock() {
        const accept = distributor.interface.encodeFunctionData("acceptOwnership", []);
        await distributor.transferOwnership(timelockAddr);
        await schedule(distributorAddr, accept);
        await time.increase(Number(MIN_DELAY) + 1);
        await execute(distributorAddr, accept);
      }

      beforeEach(async function () {
        // `treasury` stands in for the multisig here: proposer, executor and canceller.
        // admin = address(0) leaves the timelock self-administered from block one.
        const Timelock = await ethers.getContractFactory("LPTimelock");
        timelock = await Timelock.deploy(MIN_DELAY, [treasury.address], [treasury.address], ethers.ZeroAddress);
        timelockAddr = await timelock.getAddress();
      });

      it("takes ownership only through a scheduled acceptOwnership, after the delay", async function () {
        await distributor.transferOwnership(timelockAddr);
        expect(await distributor.owner()).to.equal(owner.address);
        expect(await distributor.pendingOwner()).to.equal(timelockAddr);

        const accept = distributor.interface.encodeFunctionData("acceptOwnership", []);
        await schedule(distributorAddr, accept);

        // Ready-at has not arrived: the operation exists but cannot run.
        await expect(execute(distributorAddr, accept)).to.be.revertedWithCustomError(
          timelock,
          "TimelockUnexpectedOperationState"
        );

        await time.increase(Number(MIN_DELAY) + 1);
        await execute(distributorAddr, accept);

        expect(await distributor.owner()).to.equal(timelockAddr);
        expect(await distributor.pendingOwner()).to.equal(ethers.ZeroAddress);
      });

      it("adds a reward token only through a scheduled operation, after the delay", async function () {
        await handOverToTimelock();
        const Token = await ethers.getContractFactory("MockERC20Decimals");
        const usdc = await Token.deploy("USD Coin", "USDC", USDC(1_000_000), 6);
        const usdcAddr = await usdc.getAddress();

        // The multisig itself holds no owner-tier right — only the timelock does.
        await expect(distributor.connect(treasury).addRewardToken(usdcAddr, false, true))
          .to.be.revertedWithCustomError(distributor, "OwnableUnauthorizedAccount")
          .withArgs(treasury.address);

        const add = distributor.interface.encodeFunctionData("addRewardToken", [usdcAddr, false, true]);
        const salt = ethers.id("add-usdc");
        await schedule(distributorAddr, add, salt);
        await expect(execute(distributorAddr, add, salt)).to.be.revertedWithCustomError(
          timelock,
          "TimelockUnexpectedOperationState"
        );

        await time.increase(Number(MIN_DELAY) + 1);
        await expect(execute(distributorAddr, add, salt))
          .to.emit(distributor, "RewardTokenAdded")
          .withArgs(usdcAddr, false, true, 6, "USDC");
        expect(await distributor.isRewardToken(usdcAddr)).to.equal(true);
      });

      it("upgrades only through the timelock once it owns the proxy", async function () {
        await handOverToTimelock();

        const V2 = await v2Factory();
        const impl = await V2.deploy();
        await impl.waitForDeployment();
        const implAddr = await impl.getAddress();

        await expect(distributor.connect(treasury).upgradeToAndCall(implAddr, "0x"))
          .to.be.revertedWithCustomError(distributor, "OwnableUnauthorizedAccount")
          .withArgs(treasury.address);

        const upgrade = distributor.interface.encodeFunctionData("upgradeToAndCall", [implAddr, "0x"]);
        await schedule(distributorAddr, upgrade);
        await expect(execute(distributorAddr, upgrade)).to.be.revertedWithCustomError(
          timelock,
          "TimelockUnexpectedOperationState"
        );

        await time.increase(Number(MIN_DELAY) + 1);
        await expect(execute(distributorAddr, upgrade)).to.emit(distributor, "Upgraded").withArgs(implAddr);

        expect(
          await (await ethers.getContractAt("RewardsDistributorV2Mock", distributorAddr)).version()
        ).to.equal(2n);
      });

      it("leaves the guardian and operator tiers undelayed while the timelock owns the proxy", async function () {
        await handOverToTimelock();

        // No schedule, no delay: the incident switch still works in one transaction.
        await asGuardian().setPaused(true);
        expect(await distributor.paused()).to.equal(true);

        // And so does the operator tier: rotating a compromised signing key must not wait out
        // 48 h.
        await asOperator().setSigner(treasury.address);
        expect(await distributor.signer()).to.equal(treasury.address);
        await asOperator().setPaused(false);
        expect(await distributor.paused()).to.equal(false);
      });

      it("shortens its own delay only through itself", async function () {
        // Not even the proposer/executor: shortening the delay is itself a delayed operation.
        await expect(timelock.connect(treasury).updateDelay(1))
          .to.be.revertedWithCustomError(timelock, "TimelockUnauthorizedCaller")
          .withArgs(treasury.address);

        const update = timelock.interface.encodeFunctionData("updateDelay", [1]);
        await schedule(timelockAddr, update);
        await time.increase(Number(MIN_DELAY) + 1);
        await expect(execute(timelockAddr, update)).to.emit(timelock, "MinDelayChange").withArgs(MIN_DELAY, 1n);
      });
    });
  });
});
