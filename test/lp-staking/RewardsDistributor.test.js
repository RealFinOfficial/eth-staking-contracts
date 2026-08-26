const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("RewardsDistributor", function () {
  let distributor, tokenX, asset;
  let owner, guardian, voucherSigner, alice, bob, treasury;
  let distributorAddr, tokenXAddr, assetAddr;

  // The two admin tiers are DIFFERENT accounts in this suite, so "is this owner-only or
  // guardian-only" is never answered by them happening to be the same address. In production
  // `owner` is a TimelockController and `guardian` is the multisig.
  const asGuardian = () => distributor.connect(guardian);

  /// Deploys a distributor UUPS proxy. `constructorArgs` are the implementation's two
  /// immutables; `unsafeAllow` names exactly the two patterns the spec chose deliberately.
  async function deployDistributorProxy(
    tokenXAddress,
    assetAddress,
    ownerAddress,
    guardianAddress,
    signerAddress
  ) {
    const Distributor = await ethers.getContractFactory("RewardsDistributor");
    return upgrades.deployProxy(
      Distributor,
      [ownerAddress, guardianAddress, signerAddress],
      {
        kind: "uups",
        constructorArgs: [tokenXAddress, assetAddress],
        unsafeAllow: ["constructor", "state-variable-immutable"],
      }
    );
  }

  const TOKENS = (n) => ethers.parseEther(String(n));
  const USDC = (n) => ethers.parseUnits(String(n), 6);
  const FAR_DEADLINE = 10n ** 12n;

  const EPOCH = 1n;
  const HUGE_CAP = TOKENS(1_000_000_000);

  // ── EIP-712 helpers ────────────────────────────────────────────
  // Field names and order must match the on-chain type strings exactly.
  const CLAIM_FIELDS = [
    { name: "user", type: "address" },
    { name: "cumulativeAmount", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ];

  async function voucherDomain() {
    return {
      name: "RealLPRewards",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: distributorAddr,
    };
  }

  function voucherTypes(structName) {
    return { [structName]: CLAIM_FIELDS };
  }

  /// Sign a voucher. `structName` picks the leg ("TokenXClaim" / "AssetClaim").
  /// `opts.boundTo` overrides the signed `user` field, `opts.signer` the signing key.
  async function signVoucher(structName, user, cumulativeAmount, opts = {}) {
    const value = {
      user: (opts.boundTo ?? user).address,
      cumulativeAmount,
      deadline: opts.deadline ?? FAR_DEADLINE,
    };
    return (opts.signer ?? voucherSigner).signTypedData(
      await voucherDomain(),
      voucherTypes(structName),
      value
    );
  }

  /// Address the contract will recover for a voucher redeemed by `submitter`.
  async function recoverFor(structName, submitter, cumulativeAmount, signature, deadline = FAR_DEADLINE) {
    return ethers.verifyTypedData(
      await voucherDomain(),
      voucherTypes(structName),
      { user: submitter.address, cumulativeAmount, deadline },
      signature
    );
  }

  async function txTimestamp(tx) {
    const receipt = await tx.wait();
    return (await ethers.provider.getBlock(receipt.blockNumber)).timestamp;
  }

  async function claimTokenX(user, cumulativeAmount, opts = {}) {
    const sig = opts.signature ?? (await signVoucher("TokenXClaim", user, cumulativeAmount, opts));
    return distributor
      .connect(user)
      .claimTokenX(cumulativeAmount, opts.deadline ?? FAR_DEADLINE, sig);
  }

  async function claimAsset(user, cumulativeAmount, opts = {}) {
    const sig = opts.signature ?? (await signVoucher("AssetClaim", user, cumulativeAmount, opts));
    return distributor
      .connect(user)
      .claimAsset(cumulativeAmount, opts.deadline ?? FAR_DEADLINE, sig);
  }

  async function enableAssetLeg(funding = USDC(1_000_000)) {
    await distributor.setAssetClaimsEnabled(true);
    await asset.transfer(distributorAddr, funding);
  }

  beforeEach(async function () {
    [owner, guardian, voucherSigner, alice, bob, treasury] = await ethers.getSigners();

    const TokenXFactory = await ethers.getContractFactory("TokenX");
    tokenX = await TokenXFactory.deploy("Token X", "TKX", owner.address);
    tokenXAddr = await tokenX.getAddress();

    const AssetFactory = await ethers.getContractFactory("MockERC20Decimals");
    asset = await AssetFactory.deploy("USD Coin", "USDC", USDC(10_000_000), 6);
    assetAddr = await asset.getAddress();

    distributor = await deployDistributorProxy(
      tokenXAddr,
      assetAddr,
      owner.address,
      guardian.address,
      voucherSigner.address
    );
    distributorAddr = await distributor.getAddress();

    // The distributor is the only minter, and the epoch is armed wide open unless
    // a test deliberately narrows it.
    await tokenX.setMinter(distributorAddr);
    await tokenX.setEpochCap(EPOCH, HUGE_CAP);
  });

  // ─────────────────────────────────────────────────────────────
  describe("Deployment", function () {
    it("exposes the wired addresses and the default switches", async function () {
      expect(await distributor.tokenX()).to.equal(tokenXAddr);
      expect(await distributor.asset()).to.equal(assetAddr);
      expect(await distributor.signer()).to.equal(voucherSigner.address);
      expect(await distributor.owner()).to.equal(owner.address);
      expect(await distributor.guardian()).to.equal(guardian.address);
      expect(await distributor.pendingOwner()).to.equal(ethers.ZeroAddress);
      expect(await distributor.paused()).to.equal(false);
      expect(await distributor.assetClaimsEnabled()).to.equal(false);
    });

    it("pins the two type hashes to distinct struct names", async function () {
      const tokenXHash = ethers.keccak256(
        ethers.toUtf8Bytes("TokenXClaim(address user,uint256 cumulativeAmount,uint256 deadline)")
      );
      const assetHash = ethers.keccak256(
        ethers.toUtf8Bytes("AssetClaim(address user,uint256 cumulativeAmount,uint256 deadline)")
      );
      expect(await distributor.TOKENX_CLAIM_TYPEHASH()).to.equal(tokenXHash);
      expect(await distributor.ASSET_CLAIM_TYPEHASH()).to.equal(assetHash);
      expect(tokenXHash).to.not.equal(assetHash);
    });

    it("announces both roles in the proxy's own deploy tx, so they are followable from block one", async function () {
      // `initialize` runs inside the proxy's deployment transaction, so its events are that
      // transaction's events — there is no second block to look in.
      await expect(distributor.deploymentTransaction())
        .to.emit(distributor, "SignerChanged")
        .withArgs(ethers.ZeroAddress, voucherSigner.address);

      await expect(distributor.deploymentTransaction())
        .to.emit(distributor, "GuardianSet")
        .withArgs(ethers.ZeroAddress, guardian.address);
    });

    it("rejects a zero tokenX or asset on the IMPLEMENTATION, before any proxy exists", async function () {
      const Distributor = await ethers.getContractFactory("RewardsDistributor");

      await expect(Distributor.deploy(ethers.ZeroAddress, assetAddr)).to.be.revertedWithCustomError(
        Distributor,
        "ZeroAddress"
      );

      await expect(Distributor.deploy(tokenXAddr, ethers.ZeroAddress)).to.be.revertedWithCustomError(
        Distributor,
        "ZeroAddress"
      );
    });

    it("rejects a zero owner, guardian or signer in initialize, through the proxy", async function () {
      const Distributor = await ethers.getContractFactory("RewardsDistributor");

      await expect(
        deployDistributorProxy(
          tokenXAddr,
          assetAddr,
          ethers.ZeroAddress,
          guardian.address,
          voucherSigner.address
        )
      )
        .to.be.revertedWithCustomError(Distributor, "OwnableInvalidOwner")
        .withArgs(ethers.ZeroAddress);

      await expect(
        deployDistributorProxy(
          tokenXAddr,
          assetAddr,
          owner.address,
          ethers.ZeroAddress,
          voucherSigner.address
        )
      ).to.be.revertedWithCustomError(Distributor, "ZeroAddress");

      await expect(
        deployDistributorProxy(
          tokenXAddr,
          assetAddr,
          owner.address,
          guardian.address,
          ethers.ZeroAddress
        )
      ).to.be.revertedWithCustomError(Distributor, "ZeroAddress");
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
  describe("claimTokenX", function () {
    it("mints the full cumulative amount on a first claim", async function () {
      const tx = await claimTokenX(alice, TOKENS(100));
      const ts = await txTimestamp(tx);

      await expect(tx)
        .to.emit(distributor, "Claimed")
        .withArgs(alice.address, tokenXAddr, TOKENS(100), TOKENS(100), ts);

      expect(await tokenX.balanceOf(alice.address)).to.equal(TOKENS(100));
      expect(await distributor.claimedTokenX(alice.address)).to.equal(TOKENS(100));
      expect(await tokenX.mintedInEpoch(EPOCH)).to.equal(TOKENS(100));
    });

    it("mints to the caller, never to a third party", async function () {
      await claimTokenX(alice, TOKENS(100));
      expect(await tokenX.balanceOf(bob.address)).to.equal(0n);
      expect(await tokenX.balanceOf(distributorAddr)).to.equal(0n);
    });

    it("pays only the difference on the next voucher", async function () {
      await claimTokenX(alice, TOKENS(100));

      const tx = await claimTokenX(alice, TOKENS(150));
      const ts = await txTimestamp(tx);

      await expect(tx)
        .to.emit(distributor, "Claimed")
        .withArgs(alice.address, tokenXAddr, TOKENS(150), TOKENS(50), ts);

      expect(await tokenX.balanceOf(alice.address)).to.equal(TOKENS(150));
      expect(await distributor.claimedTokenX(alice.address)).to.equal(TOKENS(150));
    });

    it("rejects a replay of the voucher just spent", async function () {
      await claimTokenX(alice, TOKENS(150));

      await expect(claimTokenX(alice, TOKENS(150)))
        .to.be.revertedWithCustomError(distributor, "NothingToClaim")
        .withArgs(TOKENS(150), TOKENS(150));
    });

    it("rejects an older voucher once a larger one has been claimed", async function () {
      const stale = await signVoucher("TokenXClaim", alice, TOKENS(100));
      await claimTokenX(alice, TOKENS(150));

      await expect(claimTokenX(alice, TOKENS(100), { signature: stale }))
        .to.be.revertedWithCustomError(distributor, "NothingToClaim")
        .withArgs(TOKENS(100), TOKENS(150));

      expect(await tokenX.balanceOf(alice.address)).to.equal(TOKENS(150));
    });

    it("lets a user who skipped epochs collect everything in one call", async function () {
      const tx = await claimTokenX(alice, TOKENS(420));
      const ts = await txTimestamp(tx);

      await expect(tx)
        .to.emit(distributor, "Claimed")
        .withArgs(alice.address, tokenXAddr, TOKENS(420), TOKENS(420), ts);
      expect(await tokenX.balanceOf(alice.address)).to.equal(TOKENS(420));
    });

    it("keeps per-user ledgers apart", async function () {
      await claimTokenX(alice, TOKENS(100));
      await claimTokenX(bob, TOKENS(30));

      expect(await distributor.claimedTokenX(alice.address)).to.equal(TOKENS(100));
      expect(await distributor.claimedTokenX(bob.address)).to.equal(TOKENS(30));
      expect(await tokenX.totalSupply()).to.equal(TOKENS(130));
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Voucher forgery and misuse", function () {
    it("a voucher signed for A cannot be redeemed by B — the digest binds msg.sender", async function () {
      const sig = await signVoucher("TokenXClaim", alice, TOKENS(100));
      const recovered = await recoverFor("TokenXClaim", bob, TOKENS(100), sig);

      await expect(distributor.connect(bob).claimTokenX(TOKENS(100), FAR_DEADLINE, sig))
        .to.be.revertedWithCustomError(distributor, "InvalidSignature")
        .withArgs(recovered, voucherSigner.address);

      expect(recovered).to.not.equal(voucherSigner.address);
      expect(await tokenX.balanceOf(bob.address)).to.equal(0n);
    });

    it("a voucher signed with the wrong key is rejected, and names the recovered address", async function () {
      const sig = await signVoucher("TokenXClaim", alice, TOKENS(100), { signer: bob });

      await expect(claimTokenX(alice, TOKENS(100), { signature: sig }))
        .to.be.revertedWithCustomError(distributor, "InvalidSignature")
        .withArgs(bob.address, voucherSigner.address);
    });

    it("a tampered cumulative amount is rejected", async function () {
      const sig = await signVoucher("TokenXClaim", alice, TOKENS(100));

      await expect(claimTokenX(alice, TOKENS(100) + 1n, { signature: sig }))
        .to.be.revertedWithCustomError(distributor, "InvalidSignature");

      await expect(claimTokenX(alice, TOKENS(1_000_000), { signature: sig }))
        .to.be.revertedWithCustomError(distributor, "InvalidSignature");
    });

    it("a tampered deadline is rejected", async function () {
      const sig = await signVoucher("TokenXClaim", alice, TOKENS(100));

      await expect(
        distributor.connect(alice).claimTokenX(TOKENS(100), FAR_DEADLINE + 1n, sig)
      ).to.be.revertedWithCustomError(distributor, "InvalidSignature");
    });

    it("an expired voucher is rejected with the deadline and the block timestamp", async function () {
      const now = await time.latest();
      const deadline = BigInt(now);
      const sig = await signVoucher("TokenXClaim", alice, TOKENS(100), { deadline });

      await time.setNextBlockTimestamp(now + 10);
      await expect(
        distributor.connect(alice).claimTokenX(TOKENS(100), deadline, sig)
      )
        .to.be.revertedWithCustomError(distributor, "ClaimExpired")
        .withArgs(deadline, BigInt(now + 10));
    });

    it("a voucher is still good on the exact deadline second", async function () {
      const deadline = BigInt(await time.latest()) + 100n;
      const sig = await signVoucher("TokenXClaim", alice, TOKENS(100), { deadline });

      await time.setNextBlockTimestamp(Number(deadline));
      await distributor.connect(alice).claimTokenX(TOKENS(100), deadline, sig);
      expect(await tokenX.balanceOf(alice.address)).to.equal(TOKENS(100));
    });

    it("a TokenX voucher cannot be spent on the ASSET leg", async function () {
      await enableAssetLeg();
      const sig = await signVoucher("TokenXClaim", alice, TOKENS(100));

      await expect(
        distributor.connect(alice).claimAsset(TOKENS(100), FAR_DEADLINE, sig)
      ).to.be.revertedWithCustomError(distributor, "InvalidSignature");
    });

    it("an ASSET voucher cannot be spent on the TokenX leg", async function () {
      const sig = await signVoucher("AssetClaim", alice, TOKENS(100));

      await expect(
        distributor.connect(alice).claimTokenX(TOKENS(100), FAR_DEADLINE, sig)
      ).to.be.revertedWithCustomError(distributor, "InvalidSignature");
    });

    it("a voucher for another verifying contract is rejected", async function () {
      const twin = await deployDistributorProxy(
        tokenXAddr,
        assetAddr,
        owner.address,
        guardian.address,
        voucherSigner.address
      );

      const foreignDomain = {
        name: "RealLPRewards",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await twin.getAddress(),
      };
      const sig = await voucherSigner.signTypedData(foreignDomain, voucherTypes("TokenXClaim"), {
        user: alice.address,
        cumulativeAmount: TOKENS(100),
        deadline: FAR_DEADLINE,
      });

      await expect(
        distributor.connect(alice).claimTokenX(TOKENS(100), FAR_DEADLINE, sig)
      ).to.be.revertedWithCustomError(distributor, "InvalidSignature");
    });

    it("a zero-cumulative voucher pays nothing", async function () {
      await expect(claimTokenX(alice, 0n))
        .to.be.revertedWithCustomError(distributor, "NothingToClaim")
        .withArgs(0n, 0n);
    });

    it("a malformed signature is rejected by ECDSA, not by the signer check", async function () {
      // documents the error surface a caller sees: OZ ECDSA throws on a bad
      // encoding before `InvalidSignature` can ever be reached
      await expect(distributor.connect(alice).claimTokenX(TOKENS(100), FAR_DEADLINE, "0x"))
        .to.be.revertedWithCustomError(distributor, "ECDSAInvalidSignatureLength")
        .withArgs(0n);

      const garbage = "0x" + "11".repeat(65);
      await expect(
        distributor.connect(alice).claimTokenX(TOKENS(100), FAR_DEADLINE, garbage)
      ).to.be.revertedWithCustomError(distributor, "ECDSAInvalidSignature");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Pause", function () {
    it("is guardian only — the owner is rejected too — and emits Paused", async function () {
      await expect(distributor.connect(alice).setPaused(true))
        .to.be.revertedWithCustomError(distributor, "NotGuardian")
        .withArgs(alice.address, guardian.address);

      // The pause is an incident switch. Routing it through the timelock would mean waiting
      // out the delay before a live bug can be stopped, so the OWNER does not hold it.
      await expect(distributor.setPaused(true))
        .to.be.revertedWithCustomError(distributor, "NotGuardian")
        .withArgs(owner.address, guardian.address);

      await expect(asGuardian().setPaused(true)).to.emit(distributor, "Paused").withArgs(true);
      expect(await distributor.paused()).to.equal(true);
    });

    it("blocks both legs while paused and restores both on unpause", async function () {
      await enableAssetLeg();
      await asGuardian().setPaused(true);

      await expect(claimTokenX(alice, TOKENS(100))).to.be.revertedWithCustomError(
        distributor,
        "ClaimsPaused"
      );
      await expect(claimAsset(alice, USDC(500))).to.be.revertedWithCustomError(
        distributor,
        "ClaimsPaused"
      );

      await expect(asGuardian().setPaused(false)).to.emit(distributor, "Paused").withArgs(false);

      await claimTokenX(alice, TOKENS(100));
      await claimAsset(alice, USDC(500));
      expect(await tokenX.balanceOf(alice.address)).to.equal(TOKENS(100));
      expect(await asset.balanceOf(alice.address)).to.equal(USDC(500));
    });

    it("leaves the admin functions usable while paused", async function () {
      await asGuardian().setPaused(true);

      await asGuardian().setSigner(bob.address);
      expect(await distributor.signer()).to.equal(bob.address);

      await distributor.setAssetClaimsEnabled(true);
      expect(await distributor.assetClaimsEnabled()).to.equal(true);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("ASSET leg", function () {
    it("is off by default", async function () {
      await expect(claimAsset(alice, USDC(500))).to.be.revertedWithCustomError(
        distributor,
        "AssetClaimsDisabled"
      );
    });

    it("is toggled by the owner only — the guardian is rejected — and emits AssetClaimsEnabled", async function () {
      await expect(distributor.connect(alice).setAssetClaimsEnabled(true))
        .to.be.revertedWithCustomError(distributor, "OwnableUnauthorizedAccount")
        .withArgs(alice.address);

      // Switching a whole reward leg on is a program decision, not incident response, so it
      // takes the timelock's delay like an upgrade does.
      await expect(asGuardian().setAssetClaimsEnabled(true))
        .to.be.revertedWithCustomError(distributor, "OwnableUnauthorizedAccount")
        .withArgs(guardian.address);

      await expect(distributor.setAssetClaimsEnabled(true))
        .to.emit(distributor, "AssetClaimsEnabled")
        .withArgs(true);
      expect(await distributor.assetClaimsEnabled()).to.equal(true);

      await expect(distributor.setAssetClaimsEnabled(false))
        .to.emit(distributor, "AssetClaimsEnabled")
        .withArgs(false);
      await expect(claimAsset(alice, USDC(500))).to.be.revertedWithCustomError(
        distributor,
        "AssetClaimsDisabled"
      );
    });

    it("pays out of the pre-funded balance by transfer, not by minting", async function () {
      await enableAssetLeg(USDC(1000));

      const tx = await claimAsset(alice, USDC(600));
      const ts = await txTimestamp(tx);

      await expect(tx)
        .to.emit(distributor, "Claimed")
        .withArgs(alice.address, assetAddr, USDC(600), USDC(600), ts);

      expect(await asset.balanceOf(alice.address)).to.equal(USDC(600));
      expect(await asset.balanceOf(distributorAddr)).to.equal(USDC(400));
      expect(await distributor.claimedAsset(alice.address)).to.equal(USDC(600));
    });

    it("follows the same cumulative model", async function () {
      await enableAssetLeg(USDC(1000));
      await claimAsset(alice, USDC(600));

      const tx = await claimAsset(alice, USDC(900));
      const ts = await txTimestamp(tx);

      await expect(tx)
        .to.emit(distributor, "Claimed")
        .withArgs(alice.address, assetAddr, USDC(900), USDC(300), ts);
      expect(await asset.balanceOf(alice.address)).to.equal(USDC(900));

      await expect(claimAsset(alice, USDC(900)))
        .to.be.revertedWithCustomError(distributor, "NothingToClaim")
        .withArgs(USDC(900), USDC(900));
    });

    it("reverts when the distributor is underfunded — the balance is the damage cap", async function () {
      await enableAssetLeg(USDC(100));

      await expect(claimAsset(alice, USDC(500)))
        .to.be.revertedWithCustomError(asset, "ERC20InsufficientBalance")
        .withArgs(distributorAddr, USDC(100), USDC(500));

      // nothing was booked — the whole claim rolled back
      expect(await distributor.claimedAsset(alice.address)).to.equal(0n);
      expect(await asset.balanceOf(alice.address)).to.equal(0n);
    });

    it("keeps the two ledgers independent for the same user", async function () {
      await enableAssetLeg(USDC(1000));

      await claimTokenX(alice, TOKENS(100));
      await claimAsset(alice, USDC(700));

      expect(await distributor.claimedTokenX(alice.address)).to.equal(TOKENS(100));
      expect(await distributor.claimedAsset(alice.address)).to.equal(USDC(700));

      // a further TokenX claim does not disturb the ASSET ledger and vice versa
      await claimTokenX(alice, TOKENS(160));
      expect(await distributor.claimedAsset(alice.address)).to.equal(USDC(700));
      await claimAsset(alice, USDC(800));
      expect(await distributor.claimedTokenX(alice.address)).to.equal(TOKENS(160));

      expect(await tokenX.balanceOf(alice.address)).to.equal(TOKENS(160));
      expect(await asset.balanceOf(alice.address)).to.equal(USDC(800));
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Signer rotation", function () {
    it("is guardian only — the owner is rejected too — rejects address(0) and emits SignerChanged", async function () {
      await expect(distributor.connect(alice).setSigner(alice.address))
        .to.be.revertedWithCustomError(distributor, "NotGuardian")
        .withArgs(alice.address, guardian.address);

      // Key-compromise recovery cannot wait out a timelock, so the OWNER does not hold it.
      await expect(distributor.setSigner(treasury.address))
        .to.be.revertedWithCustomError(distributor, "NotGuardian")
        .withArgs(owner.address, guardian.address);

      await expect(asGuardian().setSigner(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        distributor,
        "ZeroAddress"
      );

      await expect(asGuardian().setSigner(treasury.address))
        .to.emit(distributor, "SignerChanged")
        .withArgs(voucherSigner.address, treasury.address);
      expect(await distributor.signer()).to.equal(treasury.address);
    });

    it("invalidates every outstanding voucher of the compromised key", async function () {
      const oldSig = await signVoucher("TokenXClaim", alice, TOKENS(100));

      await asGuardian().setSigner(treasury.address);

      await expect(claimTokenX(alice, TOKENS(100), { signature: oldSig }))
        .to.be.revertedWithCustomError(distributor, "InvalidSignature")
        .withArgs(voucherSigner.address, treasury.address);

      const newSig = await signVoucher("TokenXClaim", alice, TOKENS(100), { signer: treasury });
      await claimTokenX(alice, TOKENS(100), { signature: newSig });
      expect(await tokenX.balanceOf(alice.address)).to.equal(TOKENS(100));
    });

    it("rotation does not disturb what was already paid", async function () {
      await claimTokenX(alice, TOKENS(100));
      await asGuardian().setSigner(treasury.address);

      const newSig = await signVoucher("TokenXClaim", alice, TOKENS(150), { signer: treasury });
      await claimTokenX(alice, TOKENS(150), { signature: newSig });

      expect(await tokenX.balanceOf(alice.address)).to.equal(TOKENS(150));
      expect(await distributor.claimedTokenX(alice.address)).to.equal(TOKENS(150));
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("TokenX epoch cap interplay", function () {
    it("a valid voucher still reverts when the epoch has no headroom", async function () {
      await tokenX.setEpochCap(2n, TOKENS(10));

      await expect(claimTokenX(alice, TOKENS(25)))
        .to.be.revertedWithCustomError(tokenX, "EpochMintCapExceeded")
        .withArgs(2n, TOKENS(10), 0n, TOKENS(25));

      // the ledger was not advanced — the whole claim rolled back
      expect(await distributor.claimedTokenX(alice.address)).to.equal(0n);
      expect(await tokenX.balanceOf(alice.address)).to.equal(0n);
      expect(await tokenX.mintedInEpoch(2n)).to.equal(0n);
    });

    it("only the payable difference is charged against the cap", async function () {
      await tokenX.setEpochCap(2n, TOKENS(10));
      await claimTokenX(alice, TOKENS(8));
      expect(await tokenX.mintedInEpoch(2n)).to.equal(TOKENS(8));

      // cumulative 20 means a 12 payout against 2 of remaining headroom
      await expect(claimTokenX(alice, TOKENS(20)))
        .to.be.revertedWithCustomError(tokenX, "EpochMintCapExceeded")
        .withArgs(2n, TOKENS(10), TOKENS(8), TOKENS(12));

      expect(await distributor.claimedTokenX(alice.address)).to.equal(TOKENS(8));
      expect(await tokenX.balanceOf(alice.address)).to.equal(TOKENS(8));
    });

    it("the same voucher goes through once the owner arms a new epoch", async function () {
      await tokenX.setEpochCap(2n, TOKENS(10));
      const sig = await signVoucher("TokenXClaim", alice, TOKENS(25));
      await expect(
        claimTokenX(alice, TOKENS(25), { signature: sig })
      ).to.be.revertedWithCustomError(tokenX, "EpochMintCapExceeded");

      await tokenX.setEpochCap(3n, TOKENS(100));
      await claimTokenX(alice, TOKENS(25), { signature: sig });
      expect(await tokenX.balanceOf(alice.address)).to.equal(TOKENS(25));
    });

    it("a claim reverts once the distributor is no longer the minter", async function () {
      await tokenX.setMinter(ethers.ZeroAddress);

      await expect(claimTokenX(alice, TOKENS(100)))
        .to.be.revertedWithCustomError(tokenX, "NotMinter")
        .withArgs(distributorAddr);
      expect(await distributor.claimedTokenX(alice.address)).to.equal(0n);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("recoverExcessAsset", function () {
    it("is guardian only — the owner is rejected too", async function () {
      await asset.transfer(distributorAddr, USDC(1000));

      await expect(distributor.connect(alice).recoverExcessAsset(USDC(1)))
        .to.be.revertedWithCustomError(distributor, "NotGuardian")
        .withArgs(alice.address, guardian.address);

      // The owner is a timelock contract, which has no way to forward an ERC-20 anyway.
      await expect(distributor.recoverExcessAsset(USDC(1)))
        .to.be.revertedWithCustomError(distributor, "NotGuardian")
        .withArgs(owner.address, guardian.address);
    });

    it("rejects a zero amount", async function () {
      await expect(asGuardian().recoverExcessAsset(0n)).to.be.revertedWithCustomError(
        distributor,
        "ZeroAmount"
      );
    });

    it("moves ASSET to the guardian, never to the owner", async function () {
      await asset.transfer(distributorAddr, USDC(1000));
      const guardianBefore = await asset.balanceOf(guardian.address);
      const ownerBefore = await asset.balanceOf(owner.address);

      await asGuardian().recoverExcessAsset(USDC(400));

      expect((await asset.balanceOf(guardian.address)) - guardianBefore).to.equal(USDC(400));
      expect(await asset.balanceOf(owner.address)).to.equal(ownerBefore);
      expect(await asset.balanceOf(distributorAddr)).to.equal(USDC(600));
    });

    it("emits ExcessAssetRecovered with the guardian and the amount", async function () {
      await asset.transfer(distributorAddr, USDC(1000));

      const tx = await asGuardian().recoverExcessAsset(USDC(400));
      const ts = await txTimestamp(tx);

      await expect(tx)
        .to.emit(distributor, "ExcessAssetRecovered")
        .withArgs(guardian.address, USDC(400), ts);
    });

    it("cannot pull more than the contract holds", async function () {
      await asset.transfer(distributorAddr, USDC(100));
      await expect(asGuardian().recoverExcessAsset(USDC(101)))
        .to.be.revertedWithCustomError(asset, "ERC20InsufficientBalance")
        .withArgs(distributorAddr, USDC(100), USDC(101));
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("setGuardian", function () {
    it("is owner only, rejects address(0) and emits GuardianSet", async function () {
      await expect(asGuardian().setGuardian(alice.address))
        .to.be.revertedWithCustomError(distributor, "OwnableUnauthorizedAccount")
        .withArgs(guardian.address);

      await expect(distributor.setGuardian(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        distributor,
        "ZeroAddress"
      );

      await expect(distributor.setGuardian(treasury.address))
        .to.emit(distributor, "GuardianSet")
        .withArgs(guardian.address, treasury.address);
      expect(await distributor.guardian()).to.equal(treasury.address);
    });

    it("moves the whole fast-path tier in one call", async function () {
      await distributor.setGuardian(treasury.address);

      await expect(asGuardian().setPaused(true))
        .to.be.revertedWithCustomError(distributor, "NotGuardian")
        .withArgs(guardian.address, treasury.address);

      await distributor.connect(treasury).setPaused(true);
      expect(await distributor.paused()).to.equal(true);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Hostile ASSET tokens", function () {
    /// Re-points the suite at a distributor wired to `assetToken`. The EIP-712 helpers read
    /// `distributorAddr` when they sign, so the swap has to happen before any voucher is
    /// made; `beforeEach` puts the standard fixture back for the next test.
    async function useDistributorFor(assetToken) {
      distributor = await deployDistributorProxy(
        tokenXAddr,
        await assetToken.getAddress(),
        owner.address,
        guardian.address,
        voucherSigner.address
      );
      distributorAddr = await distributor.getAddress();
      await distributor.setAssetClaimsEnabled(true);
    }

    it("rejects an ASSET whose transfer returns false instead of reverting, and books nothing", async function () {
      const Silent = await ethers.getContractFactory("MockReturnsFalseERC20");
      const silent = await Silent.deploy("Silent", "SILENT", USDC(1_000_000), 6);
      const silentAddr = await silent.getAddress();
      await useDistributorFor(silent);

      // The payout is the last step of the claim, so an unchecked return value would leave
      // the ledger saying "paid" with nothing sent. SafeERC20 turns it into a revert.
      await expect(claimAsset(alice, USDC(500)))
        .to.be.revertedWithCustomError(distributor, "SafeERC20FailedOperation")
        .withArgs(silentAddr);

      expect(await distributor.claimedAsset(alice.address)).to.equal(0n);
    });

    it("books the amount sent, so a fee-on-transfer ASSET shorts the claimer for good", async function () {
      const FeeToken = await ethers.getContractFactory("MockFeeOnTransferERC20");
      const feeToken = await FeeToken.deploy("Fee Coin", "FEE", USDC(1_000_000), 6, 100);
      const feeTokenAddr = await feeToken.getAddress();
      await useDistributorFor(feeToken);

      // the 1% cut applies to the funding transfer too
      await feeToken.transfer(distributorAddr, USDC(10_000));
      expect(await feeToken.balanceOf(distributorAddr)).to.equal(USDC(9900));

      const tx = await claimAsset(alice, USDC(500));
      const ts = await txTimestamp(tx);

      // the event and the ledger both state the amount sent, not the amount that arrived
      await expect(tx)
        .to.emit(distributor, "Claimed")
        .withArgs(alice.address, feeTokenAddr, USDC(500), USDC(500), ts);
      expect(await distributor.claimedAsset(alice.address)).to.equal(USDC(500));
      expect(await feeToken.balanceOf(alice.address)).to.equal(USDC(495));

      // and the shortfall is unrecoverable: the cumulative ledger already counts it as paid
      await expect(claimAsset(alice, USDC(500)))
        .to.be.revertedWithCustomError(distributor, "NothingToClaim")
        .withArgs(USDC(500), USDC(500));
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Property: out-of-order vouchers never overpay", function () {
    // Deterministic PRNG (mulberry32). No Math.random — the sequence must be
    // reproducible so a failure is replayable.
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

    it("pays each user exactly the highest cumulative figure they ever landed", async function () {
      const signers = await ethers.getSigners();
      const users = [signers[10], signers[11], signers[12]];

      const rng = makeRng(0xc0ffee);
      const VOUCHERS = 21;

      const state = new Map(
        users.map((u) => [
          u.address,
          { paid: 0n, maxSigned: 0n, maxLanded: 0n, landed: 0, reverted: 0 },
        ])
      );

      for (let i = 0; i < VOUCHERS; i++) {
        const user = users[Math.floor(rng() * users.length)];
        // 1..200 whole tokens, deliberately non-monotonic
        const cumulative = TOKENS(Math.floor(rng() * 200) + 1);
        const book = state.get(user.address);
        if (cumulative > book.maxSigned) book.maxSigned = cumulative;

        const sig = await signVoucher("TokenXClaim", user, cumulative);
        const before = await tokenX.balanceOf(user.address);

        try {
          await (await distributor.connect(user).claimTokenX(cumulative, FAR_DEADLINE, sig)).wait();
        } catch (err) {
          book.reverted += 1;
          // the only legitimate rejection in this sequence is a stale voucher
          expect(err.message).to.match(/NothingToClaim/);
          expect(await tokenX.balanceOf(user.address)).to.equal(before);
          continue;
        }

        const paid = (await tokenX.balanceOf(user.address)) - before;
        book.paid += paid;
        book.landed += 1;
        if (cumulative > book.maxLanded) book.maxLanded = cumulative;
      }

      let totalLanded = 0;
      let totalReverted = 0;
      for (const user of users) {
        const book = state.get(user.address);
        totalLanded += book.landed;
        totalReverted += book.reverted;

        // the sum of every payout equals the highest cumulative that landed
        expect(book.paid).to.equal(book.maxLanded);
        // and never exceeds the highest figure the signer ever authorised
        expect(book.paid).to.be.lte(book.maxSigned);
        // on-chain ledger, wallet balance and the off-chain tally agree
        expect(await distributor.claimedTokenX(user.address)).to.equal(book.maxLanded);
        expect(await tokenX.balanceOf(user.address)).to.equal(book.paid);
      }

      // sanity: the sequence really did exercise both branches
      expect(totalLanded).to.be.gt(0);
      expect(totalReverted).to.be.gt(0);
      expect(totalLanded + totalReverted).to.equal(VOUCHERS);

      // Second pass: sign a voucher far above the epoch cap for every user. It must
      // never pay, so the "paid <= highest figure signed" bound now carries real
      // slack instead of collapsing into the equality above.
      await tokenX.setEpochCap(9n, TOKENS(1));
      for (const user of users) {
        const book = state.get(user.address);
        const oversized = book.maxSigned + TOKENS(500);
        book.maxSigned = oversized;

        const sig = await signVoucher("TokenXClaim", user, oversized);
        await expect(
          distributor.connect(user).claimTokenX(oversized, FAR_DEADLINE, sig)
        ).to.be.revertedWithCustomError(tokenX, "EpochMintCapExceeded");

        expect(book.paid).to.be.lt(book.maxSigned);
        expect(await tokenX.balanceOf(user.address)).to.equal(book.paid);
        expect(await distributor.claimedTokenX(user.address)).to.equal(book.maxLanded);
      }
      expect(await tokenX.mintedInEpoch(9n)).to.equal(0n);
    });
  });
  // ─────────────────────────────────────────────────────────────
  describe("Upgradeability", function () {
    // `constructor` / `state-variable-immutable`: the two patterns the spec chose on purpose
    // (immutable protocol references, `_disableInitializers()` in the implementation ctor).
    // `missing-initializer`: V2 is an upgrade of an ALREADY-initialized proxy, so it declares
    // no `initializer` of its own — its `initializeV2` is a `reinitializer(2)`, and re-running
    // V1's `initialize` is precisely what must not happen.
    const V2_ARGS = {
      unsafeAllow: ["constructor", "state-variable-immutable", "missing-initializer"],
    };

    async function v2Factory() {
      return ethers.getContractFactory("RewardsDistributorV2Mock");
    }

    it("passes the plugin's own implementation-safety check", async function () {
      const V2 = await v2Factory();
      await upgrades.validateImplementation(V2, {
        kind: "uups",
        constructorArgs: [tokenXAddr, assetAddr],
        ...V2_ARGS,
      });
    });

    it("keeps the claim ledger, the signer and both roles across upgradeProxy", async function () {
      await claimTokenX(alice, TOKENS(100));
      await enableAssetLeg(USDC(1000));
      await claimAsset(bob, USDC(250));

      const V2 = await v2Factory();
      const upgraded = await upgrades.upgradeProxy(distributorAddr, V2, {
        kind: "uups",
        constructorArgs: [tokenXAddr, assetAddr],
        ...V2_ARGS,
      });

      expect(await upgraded.version()).to.equal(2n);
      expect(await upgraded.getAddress()).to.equal(distributorAddr);
      expect(await upgraded.claimedTokenX(alice.address)).to.equal(TOKENS(100));
      expect(await upgraded.claimedAsset(bob.address)).to.equal(USDC(250));
      expect(await upgraded.signer()).to.equal(voucherSigner.address);
      expect(await upgraded.guardian()).to.equal(guardian.address);
      expect(await upgraded.owner()).to.equal(owner.address);
      expect(await upgraded.assetClaimsEnabled()).to.equal(true);
    });

    it("keeps the EIP-712 domain, so vouchers signed before the upgrade still spend", async function () {
      const sig = await signVoucher("TokenXClaim", alice, TOKENS(100));

      const V2 = await v2Factory();
      await upgrades.upgradeProxy(distributorAddr, V2, {
        kind: "uups",
        constructorArgs: [tokenXAddr, assetAddr],
        ...V2_ARGS,
      });

      const [, name, version, , verifyingContract] = await distributor.eip712Domain();
      expect(name).to.equal("RealLPRewards");
      expect(version).to.equal("1");
      expect(verifyingContract).to.equal(distributorAddr);

      await claimTokenX(alice, TOKENS(100), { signature: sig });
      expect(await tokenX.balanceOf(alice.address)).to.equal(TOKENS(100));
    });

    it("cannot initialise the implementation behind the proxy", async function () {
      const implAddr = await upgrades.erc1967.getImplementationAddress(distributorAddr);
      const impl = await ethers.getContractAt("RewardsDistributor", implAddr);

      await expect(
        impl.initialize(alice.address, alice.address, alice.address)
      ).to.be.revertedWithCustomError(impl, "InvalidInitialization");
    });

    it("cannot initialise the proxy a second time", async function () {
      await expect(
        distributor.initialize(alice.address, alice.address, alice.address)
      ).to.be.revertedWithCustomError(distributor, "InvalidInitialization");
    });

    it("rejects upgradeToAndCall from a stranger, from the guardian and from the raw multisig", async function () {
      const V2 = await v2Factory();
      const impl = await V2.deploy(tokenXAddr, assetAddr);
      await impl.waitForDeployment();
      const implAddr = await impl.getAddress();

      for (const caller of [alice, guardian, treasury]) {
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

    describe("under a TimelockController", function () {
      const MIN_DELAY = 60n;
      let timelock, timelockAddr;

      // OZ operation ids are keccak of the whole call tuple; the helper keeps schedule and
      // execute reading from the same arguments so they can never drift apart.
      const PREDECESSOR = ethers.ZeroHash;
      const SALT = ethers.ZeroHash;

      async function schedule(target, data) {
        return timelock.connect(treasury).schedule(target, 0, data, PREDECESSOR, SALT, MIN_DELAY);
      }

      async function execute(target, data) {
        return timelock.connect(treasury).execute(target, 0, data, PREDECESSOR, SALT);
      }

      beforeEach(async function () {
        // `treasury` stands in for the multisig here: proposer, executor and canceller.
        // admin = address(0) leaves the timelock self-administered from block one.
        const Timelock = await ethers.getContractFactory("LPTimelock");
        timelock = await Timelock.deploy(
          MIN_DELAY,
          [treasury.address],
          [treasury.address],
          ethers.ZeroAddress
        );
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

      it("upgrades only through the timelock once it owns the proxy", async function () {
        const accept = distributor.interface.encodeFunctionData("acceptOwnership", []);
        await distributor.transferOwnership(timelockAddr);
        await schedule(distributorAddr, accept);
        await time.increase(Number(MIN_DELAY) + 1);
        await execute(distributorAddr, accept);

        const V2 = await v2Factory();
        const impl = await V2.deploy(tokenXAddr, assetAddr);
        await impl.waitForDeployment();
        const implAddr = await impl.getAddress();

        // The multisig itself holds no upgrade right — only the timelock does.
        await expect(distributor.connect(treasury).upgradeToAndCall(implAddr, "0x"))
          .to.be.revertedWithCustomError(distributor, "OwnableUnauthorizedAccount")
          .withArgs(treasury.address);

        const upgrade = distributor.interface.encodeFunctionData("upgradeToAndCall", [
          implAddr,
          "0x",
        ]);
        await schedule(distributorAddr, upgrade);

        await expect(execute(distributorAddr, upgrade)).to.be.revertedWithCustomError(
          timelock,
          "TimelockUnexpectedOperationState"
        );

        await time.increase(Number(MIN_DELAY) + 1);
        await expect(execute(distributorAddr, upgrade))
          .to.emit(distributor, "Upgraded")
          .withArgs(implAddr);

        expect(
          await (await ethers.getContractAt("RewardsDistributorV2Mock", distributorAddr)).version()
        ).to.equal(2n);
      });

      it("leaves the guardian tier undelayed while the timelock owns the proxy", async function () {
        const accept = distributor.interface.encodeFunctionData("acceptOwnership", []);
        await distributor.transferOwnership(timelockAddr);
        await schedule(distributorAddr, accept);
        await time.increase(Number(MIN_DELAY) + 1);
        await execute(distributorAddr, accept);

        // No schedule, no delay: the incident switch still works in one transaction.
        await asGuardian().setPaused(true);
        expect(await distributor.paused()).to.equal(true);
      });

      it("shortens its own delay only through itself", async function () {
        // Not even the proposer/executor: shortening the delay is itself a delayed operation.
        await expect(timelock.connect(treasury).updateDelay(1))
          .to.be.revertedWithCustomError(timelock, "TimelockUnauthorizedCaller")
          .withArgs(treasury.address);

        const update = timelock.interface.encodeFunctionData("updateDelay", [1]);
        await schedule(timelockAddr, update);
        await time.increase(Number(MIN_DELAY) + 1);
        await expect(execute(timelockAddr, update))
          .to.emit(timelock, "MinDelayChange")
          .withArgs(MIN_DELAY, 1n);
      });
    });
  });
});
