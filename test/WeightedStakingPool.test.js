const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("WeightedStakingPool", function () {
  let staking, token, rewardToken;
  let owner, weightSigner, alice, bob, charlie;

  const TOKENS = (n) => ethers.parseEther(String(n));
  const BASE = 1000n;
  const MAX = 2000n;
  const POOL_DURATION = 8000;
  const ACTIVATION_DELAY = 2000;
  const NO_SIG = "0x";
  const FAR_DEADLINE = 10n ** 12n;

  let activationEpoch, endEpoch;

  async function signWeight(structName, user, amount, weight, opts = {}) {
    const domain = {
      name: "WeightedStakingPool",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await staking.getAddress(),
    };
    const types = {
      [structName]: [
        { name: "user", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "weight", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };
    const value = {
      user: user.address,
      amount,
      weight,
      nonce: opts.nonce ?? (await staking.nonces(user.address)),
      deadline: opts.deadline ?? FAR_DEADLINE,
    };
    return (opts.signer ?? weightSigner).signTypedData(domain, types, value);
  }

  async function setupRewards(amount) {
    await rewardToken.approve(await staking.getAddress(), amount);
    await staking.addRewards(amount);
  }

  beforeEach(async function () {
    [owner, weightSigner, alice, bob, charlie] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockERC20");
    token = await Token.deploy("ASSET", "ASSET", TOKENS(1_000_000));
    rewardToken = await Token.deploy("USDC", "USDC", TOKENS(1_000_000));

    const now = await time.latest();
    activationEpoch = now + ACTIVATION_DELAY;
    endEpoch = activationEpoch + POOL_DURATION;

    const Staking = await ethers.getContractFactory("WeightedStakingPool");
    staking = await Staking.deploy(
      await token.getAddress(),
      await rewardToken.getAddress(),
      activationEpoch,
      endEpoch,
      weightSigner.address
    );

    const stakingAddr = await staking.getAddress();
    for (const user of [alice, bob, charlie]) {
      await token.transfer(user.address, TOKENS(10_000));
      await token.connect(user).approve(stakingAddr, ethers.MaxUint256);
    }
  });

  // ─────────────────────────────────────────────────────────────
  describe("Deployment", function () {
    it("sets the signer and reverts on zero signer", async function () {
      expect(await staking.signer()).to.equal(weightSigner.address);

      const Staking = await ethers.getContractFactory("WeightedStakingPool");
      await expect(
        Staking.deploy(
          await token.getAddress(),
          await rewardToken.getAddress(),
          activationEpoch,
          endEpoch,
          ethers.ZeroAddress
        )
      ).to.be.revertedWith("Invalid signer");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Staking without signature (base weight)", function () {
    it("accepts first stake with weight == BASE and empty signature", async function () {
      await staking.connect(alice).stake(TOKENS(100), BASE, 0, NO_SIG);
      const info = await staking.stakes(alice.address);
      expect(info.amount).to.equal(TOKENS(100));
      expect(info.weight).to.equal(BASE);
      expect(await staking.totalWeightedStaked()).to.equal(TOKENS(100) * BASE);
    });

    it("rejects first stake with weight != BASE and empty signature", async function () {
      await expect(
        staking.connect(alice).stake(TOKENS(100), 1500, 0, NO_SIG)
      ).to.be.revertedWith("Signature required");
    });

    it("keeps current weight on subsequent unsigned stakes (weight param ignored)", async function () {
      const sig = await signWeight("Stake", alice, TOKENS(100), 1500);
      await staking.connect(alice).stake(TOKENS(100), 1500, FAR_DEADLINE, sig);

      // weight param is arbitrary and ignored when signature is empty
      await staking.connect(alice).stake(TOKENS(50), 123456789, 0, NO_SIG);
      const info = await staking.stakes(alice.address);
      expect(info.amount).to.equal(TOKENS(150));
      expect(info.weight).to.equal(1500n);
      expect(await staking.totalWeightedStaked()).to.equal(TOKENS(150) * 1500n);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Staking with signed weight", function () {
    it("sets a boosted weight with a valid signature", async function () {
      const sig = await signWeight("Stake", alice, TOKENS(100), MAX);
      await expect(staking.connect(alice).stake(TOKENS(100), MAX, FAR_DEADLINE, sig))
        .to.emit(staking, "WeightUpdated")
        .withArgs(alice.address, 0, MAX);
      expect((await staking.stakes(alice.address)).weight).to.equal(MAX);
      expect(await staking.totalWeightedStaked()).to.equal(TOKENS(100) * MAX);
      expect(await staking.nonces(alice.address)).to.equal(1n);
    });

    it("replaces the old weight on a subsequent signed stake", async function () {
      let sig = await signWeight("Stake", alice, TOKENS(100), 1500);
      await staking.connect(alice).stake(TOKENS(100), 1500, FAR_DEADLINE, sig);

      sig = await signWeight("Stake", alice, TOKENS(100), MAX);
      await staking.connect(alice).stake(TOKENS(100), MAX, FAR_DEADLINE, sig);

      expect((await staking.stakes(alice.address)).weight).to.equal(MAX);
      expect(await staking.totalWeightedStaked()).to.equal(TOKENS(200) * MAX);
    });

    it("rejects a signature from a non-signer", async function () {
      const sig = await signWeight("Stake", alice, TOKENS(100), 1500, { signer: bob });
      await expect(
        staking.connect(alice).stake(TOKENS(100), 1500, FAR_DEADLINE, sig)
      ).to.be.revertedWith("Invalid signature");
    });

    it("rejects a signature bound to a different amount", async function () {
      const sig = await signWeight("Stake", alice, TOKENS(100), 1500);
      await expect(
        staking.connect(alice).stake(TOKENS(1), 1500, FAR_DEADLINE, sig)
      ).to.be.revertedWith("Invalid signature");
    });

    it("rejects a signature bound to a different user", async function () {
      const sig = await signWeight("Stake", alice, TOKENS(100), 1500);
      await expect(
        staking.connect(bob).stake(TOKENS(100), 1500, FAR_DEADLINE, sig)
      ).to.be.revertedWith("Invalid signature");
    });

    it("rejects an expired signature", async function () {
      const deadline = BigInt(await time.latest()) - 1n;
      const sig = await signWeight("Stake", alice, TOKENS(100), 1500, { deadline });
      await expect(
        staking.connect(alice).stake(TOKENS(100), 1500, deadline, sig)
      ).to.be.revertedWith("Signature expired");
    });

    it("rejects signature replay (nonce is consumed)", async function () {
      const sig = await signWeight("Stake", alice, TOKENS(100), 1500);
      await staking.connect(alice).stake(TOKENS(100), 1500, FAR_DEADLINE, sig);
      await expect(
        staking.connect(alice).stake(TOKENS(100), 1500, FAR_DEADLINE, sig)
      ).to.be.revertedWith("Invalid signature");
    });

    it("rejects weight above MAX_WEIGHT or below BASE_WEIGHT", async function () {
      let sig = await signWeight("Stake", alice, TOKENS(100), 2001);
      await expect(
        staking.connect(alice).stake(TOKENS(100), 2001, FAR_DEADLINE, sig)
      ).to.be.revertedWith("Invalid weight");

      sig = await signWeight("Stake", alice, TOKENS(100), 999);
      await expect(
        staking.connect(alice).stake(TOKENS(100), 999, FAR_DEADLINE, sig)
      ).to.be.revertedWith("Invalid weight");
    });

    it("skips signature verification when weight == BASE", async function () {
      const sig = await signWeight("Stake", alice, TOKENS(100), 1500);
      await staking.connect(alice).stake(TOKENS(100), 1500, FAR_DEADLINE, sig);
      // downgrade to base with a garbage signature — allowed, no verification
      await staking.connect(alice).stake(TOKENS(10), BASE, 0, "0x01");
      expect((await staking.stakes(alice.address)).weight).to.equal(BASE);
      expect(await staking.nonces(alice.address)).to.equal(1n);
    });

    it("emits NonceUsed exactly when a nonce is consumed", async function () {
      // unsigned base stake — no nonce consumed
      await expect(staking.connect(alice).stake(TOKENS(10), BASE, 0, NO_SIG))
        .to.not.emit(staking, "NonceUsed");

      // signed boosted stake — nonce 0 consumed
      let sig = await signWeight("Stake", alice, TOKENS(10), 1500);
      await expect(staking.connect(alice).stake(TOKENS(10), 1500, FAR_DEADLINE, sig))
        .to.emit(staking, "NonceUsed")
        .withArgs(alice.address, 0n);

      // base-weight stake with garbage signature — verification skipped, no nonce
      await expect(staking.connect(alice).stake(TOKENS(10), BASE, 0, "0x01"))
        .to.not.emit(staking, "NonceUsed");

      // signed updateWeight — nonce 1 consumed (no Staked/Withdrawn here)
      sig = await signWeight("UpdateWeight", alice, TOKENS(30), 1500);
      await expect(staking.connect(alice).updateWeight(1500, FAR_DEADLINE, sig))
        .to.emit(staking, "NonceUsed")
        .withArgs(alice.address, 1n);

      // unsigned withdraw — resets to base, no nonce
      await expect(staking.connect(alice).withdraw(TOKENS(5), 0, 0, NO_SIG))
        .to.not.emit(staking, "NonceUsed");

      // signed withdraw — nonce 2 consumed
      sig = await signWeight("Withdraw", alice, TOKENS(5), 1500);
      await expect(staking.connect(alice).withdraw(TOKENS(5), 1500, FAR_DEADLINE, sig))
        .to.emit(staking, "NonceUsed")
        .withArgs(alice.address, 2n);

      expect(await staking.nonces(alice.address)).to.equal(3n);
    });

    it("does not accept a Withdraw-typed signature for stake", async function () {
      const sig = await signWeight("Withdraw", alice, TOKENS(100), 1500);
      await expect(
        staking.connect(alice).stake(TOKENS(100), 1500, FAR_DEADLINE, sig)
      ).to.be.revertedWith("Invalid signature");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Weighted reward distribution", function () {
    it("gives a x2 staker twice the reward of a x1 staker (equal amounts)", async function () {
      await staking.connect(alice).stake(TOKENS(100), BASE, 0, NO_SIG);
      const sig = await signWeight("Stake", bob, TOKENS(100), MAX);
      await staking.connect(bob).stake(TOKENS(100), MAX, FAR_DEADLINE, sig);

      await setupRewards(TOKENS(3000));
      await time.increaseTo(endEpoch + 1);

      await staking.connect(alice).unstake();
      await staking.connect(bob).unstake();

      const aliceReward = await staking.claimedRewards(alice.address);
      const bobReward = await staking.claimedRewards(bob.address);
      expect(aliceReward).to.be.closeTo(TOKENS(1000), TOKENS(1));
      expect(bobReward).to.be.closeTo(TOKENS(2000), TOKENS(1));
    });

    it("checkpoints accrual at the old weight when the weight changes mid-period", async function () {
      // alice: x1 for first half, x2 for second half => 1.5x average
      // bob:   x1 for the whole period
      await staking.connect(alice).stake(TOKENS(100), BASE, 0, NO_SIG);
      await staking.connect(bob).stake(TOKENS(100), BASE, 0, NO_SIG);

      await time.increaseTo(activationEpoch + POOL_DURATION / 2);
      const sig = await signWeight("UpdateWeight", alice, TOKENS(100), MAX);
      await staking.connect(alice).updateWeight(MAX, FAR_DEADLINE, sig);

      await setupRewards(TOKENS(5000));
      await time.increaseTo(endEpoch + 1);

      await staking.connect(alice).unstake();
      await staking.connect(bob).unstake();

      // alice weight : bob weight = (1000*4000 + 2000*4000) : (1000*8000) = 3 : 2
      expect(await staking.claimedRewards(alice.address)).to.be.closeTo(TOKENS(3000), TOKENS(2));
      expect(await staking.claimedRewards(bob.address)).to.be.closeTo(TOKENS(2000), TOKENS(2));
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Withdraw", function () {
    it("resets the weight to BASE on partial unsigned withdraw", async function () {
      const sig = await signWeight("Stake", alice, TOKENS(200), 1500);
      await staking.connect(alice).stake(TOKENS(200), 1500, FAR_DEADLINE, sig);

      await expect(staking.connect(alice).withdraw(TOKENS(50), 0, 0, NO_SIG))
        .to.emit(staking, "WeightUpdated")
        .withArgs(alice.address, 1500n, BASE);
      const info = await staking.stakes(alice.address);
      expect(info.amount).to.equal(TOKENS(150));
      expect(info.weight).to.equal(BASE);
      expect(await staking.totalWeightedStaked()).to.equal(TOKENS(150) * BASE);
    });

    it("cannot keep a boosted weight by withdrawing most of the stake unsigned", async function () {
      // attested x2 for 1000 tokens, then free pre-activation withdraw of 999
      const sig = await signWeight("Stake", alice, TOKENS(1000), MAX);
      await staking.connect(alice).stake(TOKENS(1000), MAX, FAR_DEADLINE, sig);

      await staking.connect(alice).withdraw(TOKENS(999), 0, 0, NO_SIG);
      expect((await staking.stakes(alice.address)).weight).to.equal(BASE);
      expect(await staking.totalWeightedStaked()).to.equal(TOKENS(1) * BASE);
    });

    it("applies a signed new weight on withdraw", async function () {
      const stakeSig = await signWeight("Stake", alice, TOKENS(200), MAX);
      await staking.connect(alice).stake(TOKENS(200), MAX, FAR_DEADLINE, stakeSig);

      const wSig = await signWeight("Withdraw", alice, TOKENS(100), 1500);
      await staking.connect(alice).withdraw(TOKENS(100), 1500, FAR_DEADLINE, wSig);

      const info = await staking.stakes(alice.address);
      expect(info.amount).to.equal(TOKENS(100));
      expect(info.weight).to.equal(1500n);
      expect(await staking.totalWeightedStaked()).to.equal(TOKENS(100) * 1500n);
    });

    it("resets the weight on full withdraw; next stake is a first stake again", async function () {
      const sig = await signWeight("Stake", alice, TOKENS(100), MAX);
      await staking.connect(alice).stake(TOKENS(100), MAX, FAR_DEADLINE, sig);

      await staking.connect(alice).withdraw(TOKENS(100), 0, 0, NO_SIG);
      expect((await staking.stakes(alice.address)).weight).to.equal(0n);
      expect(await staking.totalWeightedStaked()).to.equal(0n);

      // cannot reclaim the boosted weight without a fresh signature
      await expect(
        staking.connect(alice).stake(TOKENS(1), MAX, 0, NO_SIG)
      ).to.be.revertedWith("Signature required");
      await staking.connect(alice).stake(TOKENS(1), BASE, 0, NO_SIG);
      expect((await staking.stakes(alice.address)).weight).to.equal(BASE);
    });

    it("still applies penalty and weight forfeiture during the active period", async function () {
      const sig = await signWeight("Stake", alice, TOKENS(100), MAX);
      await staking.connect(alice).stake(TOKENS(100), MAX, FAR_DEADLINE, sig);

      await time.increaseTo(activationEpoch + POOL_DURATION / 2);
      const balBefore = await token.balanceOf(alice.address);
      await staking.connect(alice).withdraw(TOKENS(100), 0, 0, NO_SIG);
      const received = (await token.balanceOf(alice.address)) - balBefore;

      // ~25% penalty at half-time
      expect(received).to.be.closeTo(TOKENS(75), TOKENS(1));
      expect(await staking.totalForfeitedWeight()).to.be.gt(0n);
      expect(await staking.getUserWeight(alice.address)).to.equal(0n);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("updateWeight", function () {
    it("updates the weight with a valid signature and no token movement", async function () {
      await staking.connect(alice).stake(TOKENS(100), BASE, 0, NO_SIG);
      const sig = await signWeight("UpdateWeight", alice, TOKENS(100), 1500);
      await expect(staking.connect(alice).updateWeight(1500, FAR_DEADLINE, sig))
        .to.emit(staking, "WeightUpdated")
        .withArgs(alice.address, BASE, 1500n);
      expect(await staking.totalWeightedStaked()).to.equal(TOKENS(100) * 1500n);
    });

    it("allows unsigned downgrade to BASE", async function () {
      const sig = await signWeight("Stake", alice, TOKENS(100), MAX);
      await staking.connect(alice).stake(TOKENS(100), MAX, FAR_DEADLINE, sig);
      await staking.connect(alice).updateWeight(BASE, 0, NO_SIG);
      expect((await staking.stakes(alice.address)).weight).to.equal(BASE);
    });

    it("reverts without a stake or without a signature for boosted weight", async function () {
      await expect(
        staking.connect(alice).updateWeight(BASE, 0, NO_SIG)
      ).to.be.revertedWith("Nothing staked");

      await staking.connect(alice).stake(TOKENS(100), BASE, 0, NO_SIG);
      await expect(
        staking.connect(alice).updateWeight(1500, 0, NO_SIG)
      ).to.be.revertedWith("Signature required");
    });

    it("binds the signature to the user's current staked amount", async function () {
      await staking.connect(alice).stake(TOKENS(100), BASE, 0, NO_SIG);
      const sig = await signWeight("UpdateWeight", alice, TOKENS(999), 1500);
      await expect(
        staking.connect(alice).updateWeight(1500, FAR_DEADLINE, sig)
      ).to.be.revertedWith("Invalid signature");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Signer management", function () {
    it("owner can change the signer; old signatures become invalid", async function () {
      const oldSig = await signWeight("Stake", alice, TOKENS(100), 1500);

      await expect(staking.setSigner(charlie.address))
        .to.emit(staking, "SignerChanged")
        .withArgs(weightSigner.address, charlie.address);

      await expect(
        staking.connect(alice).stake(TOKENS(100), 1500, FAR_DEADLINE, oldSig)
      ).to.be.revertedWith("Invalid signature");

      const newSig = await signWeight("Stake", alice, TOKENS(100), 1500, { signer: charlie });
      await staking.connect(alice).stake(TOKENS(100), 1500, FAR_DEADLINE, newSig);
      expect((await staking.stakes(alice.address)).weight).to.equal(1500n);
    });

    it("non-owner cannot change the signer, zero address rejected", async function () {
      await expect(
        staking.connect(alice).setSigner(alice.address)
      ).to.be.revertedWithCustomError(staking, "OwnableUnauthorizedAccount");
      await expect(staking.setSigner(ethers.ZeroAddress)).to.be.revertedWith("Invalid signer");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Unstake and emergency unstake", function () {
    it("clears weight state on unstake", async function () {
      const sig = await signWeight("Stake", alice, TOKENS(100), MAX);
      await staking.connect(alice).stake(TOKENS(100), MAX, FAR_DEADLINE, sig);
      await setupRewards(TOKENS(1000));
      await time.increaseTo(endEpoch + 1);

      await staking.connect(alice).unstake();
      const info = await staking.stakes(alice.address);
      expect(info.amount).to.equal(0n);
      expect(info.weight).to.equal(0n);
      expect(await staking.totalWeightedStaked()).to.equal(0n);
      expect(await staking.claimedRewards(alice.address)).to.be.closeTo(TOKENS(1000), TOKENS(1));
    });

    it("clears weight state on emergencyUnstake and forfeits rewards", async function () {
      const sig = await signWeight("Stake", alice, TOKENS(100), MAX);
      await staking.connect(alice).stake(TOKENS(100), MAX, FAR_DEADLINE, sig);
      await setupRewards(TOKENS(1000));
      await time.increaseTo(endEpoch + 1);

      const balBefore = await token.balanceOf(alice.address);
      await staking.connect(alice).emergencyUnstake();
      expect((await token.balanceOf(alice.address)) - balBefore).to.equal(TOKENS(100));
      expect(await staking.totalWeightedStaked()).to.equal(0n);
      expect(await rewardToken.balanceOf(alice.address)).to.equal(0n);
    });
  });
});
