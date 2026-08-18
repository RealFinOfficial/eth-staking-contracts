const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("RewardsDistributor", function () {
  let distributor, tokenX, asset;
  let owner, voucherSigner, alice, bob, treasury;
  let distributorAddr, tokenXAddr, assetAddr;

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
    [owner, voucherSigner, alice, bob, treasury] = await ethers.getSigners();

    const TokenXFactory = await ethers.getContractFactory("TokenX");
    tokenX = await TokenXFactory.deploy("Token X", "TKX", owner.address);
    tokenXAddr = await tokenX.getAddress();

    const AssetFactory = await ethers.getContractFactory("MockERC20Decimals");
    asset = await AssetFactory.deploy("USD Coin", "USDC", USDC(10_000_000), 6);
    assetAddr = await asset.getAddress();

    const Distributor = await ethers.getContractFactory("RewardsDistributor");
    distributor = await Distributor.deploy(
      tokenXAddr,
      assetAddr,
      voucherSigner.address,
      owner.address
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

    it("emits SignerChanged(0, signer) so the signer is followable from block one", async function () {
      await expect(distributor.deploymentTransaction())
        .to.emit(distributor, "SignerChanged")
        .withArgs(ethers.ZeroAddress, voucherSigner.address);
    });

    it("reverts on a zero address for each live reference", async function () {
      const Distributor = await ethers.getContractFactory("RewardsDistributor");

      await expect(
        Distributor.deploy(ethers.ZeroAddress, assetAddr, voucherSigner.address, owner.address)
      ).to.be.revertedWithCustomError(Distributor, "ZeroAddress");

      await expect(
        Distributor.deploy(tokenXAddr, ethers.ZeroAddress, voucherSigner.address, owner.address)
      ).to.be.revertedWithCustomError(Distributor, "ZeroAddress");

      await expect(
        Distributor.deploy(tokenXAddr, assetAddr, ethers.ZeroAddress, owner.address)
      ).to.be.revertedWithCustomError(Distributor, "ZeroAddress");

      await expect(
        Distributor.deploy(tokenXAddr, assetAddr, voucherSigner.address, ethers.ZeroAddress)
      )
        .to.be.revertedWithCustomError(Distributor, "OwnableInvalidOwner")
        .withArgs(ethers.ZeroAddress);
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
      const Distributor = await ethers.getContractFactory("RewardsDistributor");
      const twin = await Distributor.deploy(
        tokenXAddr,
        assetAddr,
        voucherSigner.address,
        owner.address
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
    it("is owner only and emits Paused", async function () {
      await expect(distributor.connect(alice).setPaused(true))
        .to.be.revertedWithCustomError(distributor, "OwnableUnauthorizedAccount")
        .withArgs(alice.address);

      await expect(distributor.setPaused(true)).to.emit(distributor, "Paused").withArgs(true);
      expect(await distributor.paused()).to.equal(true);
    });

    it("blocks both legs while paused and restores both on unpause", async function () {
      await enableAssetLeg();
      await distributor.setPaused(true);

      await expect(claimTokenX(alice, TOKENS(100))).to.be.revertedWithCustomError(
        distributor,
        "ClaimsPaused"
      );
      await expect(claimAsset(alice, USDC(500))).to.be.revertedWithCustomError(
        distributor,
        "ClaimsPaused"
      );

      await expect(distributor.setPaused(false)).to.emit(distributor, "Paused").withArgs(false);

      await claimTokenX(alice, TOKENS(100));
      await claimAsset(alice, USDC(500));
      expect(await tokenX.balanceOf(alice.address)).to.equal(TOKENS(100));
      expect(await asset.balanceOf(alice.address)).to.equal(USDC(500));
    });

    it("leaves owner functions usable while paused", async function () {
      await distributor.setPaused(true);
      await distributor.setSigner(bob.address);
      expect(await distributor.signer()).to.equal(bob.address);
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

    it("is toggled by the owner only and emits AssetClaimsEnabled", async function () {
      await expect(distributor.connect(alice).setAssetClaimsEnabled(true))
        .to.be.revertedWithCustomError(distributor, "OwnableUnauthorizedAccount")
        .withArgs(alice.address);

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
    it("is owner only, rejects address(0) and emits SignerChanged", async function () {
      await expect(distributor.connect(alice).setSigner(alice.address))
        .to.be.revertedWithCustomError(distributor, "OwnableUnauthorizedAccount")
        .withArgs(alice.address);

      await expect(distributor.setSigner(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        distributor,
        "ZeroAddress"
      );

      await expect(distributor.setSigner(treasury.address))
        .to.emit(distributor, "SignerChanged")
        .withArgs(voucherSigner.address, treasury.address);
      expect(await distributor.signer()).to.equal(treasury.address);
    });

    it("invalidates every outstanding voucher of the compromised key", async function () {
      const oldSig = await signVoucher("TokenXClaim", alice, TOKENS(100));

      await distributor.setSigner(treasury.address);

      await expect(claimTokenX(alice, TOKENS(100), { signature: oldSig }))
        .to.be.revertedWithCustomError(distributor, "InvalidSignature")
        .withArgs(voucherSigner.address, treasury.address);

      const newSig = await signVoucher("TokenXClaim", alice, TOKENS(100), { signer: treasury });
      await claimTokenX(alice, TOKENS(100), { signature: newSig });
      expect(await tokenX.balanceOf(alice.address)).to.equal(TOKENS(100));
    });

    it("rotation does not disturb what was already paid", async function () {
      await claimTokenX(alice, TOKENS(100));
      await distributor.setSigner(treasury.address);

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
    it("is owner only", async function () {
      await asset.transfer(distributorAddr, USDC(1000));
      await expect(distributor.connect(alice).recoverExcessAsset(USDC(1)))
        .to.be.revertedWithCustomError(distributor, "OwnableUnauthorizedAccount")
        .withArgs(alice.address);
    });

    it("rejects a zero amount", async function () {
      await expect(distributor.recoverExcessAsset(0n)).to.be.revertedWithCustomError(
        distributor,
        "ZeroAmount"
      );
    });

    it("moves ASSET to the owner", async function () {
      await asset.transfer(distributorAddr, USDC(1000));
      const before = await asset.balanceOf(owner.address);

      await distributor.recoverExcessAsset(USDC(400));

      expect((await asset.balanceOf(owner.address)) - before).to.equal(USDC(400));
      expect(await asset.balanceOf(distributorAddr)).to.equal(USDC(600));
    });

    it("emits ExcessAssetRecovered with the owner and the amount", async function () {
      await asset.transfer(distributorAddr, USDC(1000));

      const tx = await distributor.recoverExcessAsset(USDC(400));
      const ts = await txTimestamp(tx);

      await expect(tx)
        .to.emit(distributor, "ExcessAssetRecovered")
        .withArgs(owner.address, USDC(400), ts);
    });

    it("cannot pull more than the contract holds", async function () {
      await asset.transfer(distributorAddr, USDC(100));
      await expect(distributor.recoverExcessAsset(USDC(101)))
        .to.be.revertedWithCustomError(asset, "ERC20InsufficientBalance")
        .withArgs(distributorAddr, USDC(100), USDC(101));
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
});
