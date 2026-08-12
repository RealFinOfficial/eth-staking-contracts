const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, mine } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

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

  async function stakeSigned(user, amount, weight = BASE) {
    const sig = await signWeight("Stake", user, amount, weight);
    return staking.connect(user).stake(amount, weight, FAR_DEADLINE, sig);
  }

  async function withdrawSigned(user, amount, weight = BASE) {
    const sig = await signWeight("Withdraw", user, amount, weight);
    return staking.connect(user).withdraw(amount, weight, FAR_DEADLINE, sig);
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
    it("emits PoolInitialized carrying the penalty curve constants", async function () {
      await expect(staking.deploymentTransaction())
        .to.emit(staking, "PoolInitialized")
        .withArgs(
          await token.getAddress(),
          await rewardToken.getAddress(),
          activationEpoch,
          endEpoch,
          5000n,
          500n,
          10000n
        );

      // the emitted bounds must match the public constants an indexer could also read
      expect(await staking.MAX_PENALTY_BPS()).to.equal(5000n);
      expect(await staking.MIN_PENALTY_BPS()).to.equal(500n);
      expect(await staking.BPS_DENOMINATOR()).to.equal(10000n);
    });

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
  describe("Signature is mandatory", function () {
    it("rejects stake with empty signature, even at base weight", async function () {
      await expect(
        staking.connect(alice).stake(TOKENS(100), BASE, FAR_DEADLINE, NO_SIG)
      ).to.be.revertedWith("Signature required");
    });

    it("allows unsigned withdraw as the only exception (permissionless exit)", async function () {
      await stakeSigned(alice, TOKENS(100));
      await staking.connect(alice).withdraw(TOKENS(50), 0, 0, NO_SIG);
      expect((await staking.stakes(alice.address)).amount).to.equal(TOKENS(50));
    });

    it("rejects updateWeight with empty signature, even at base weight", async function () {
      await stakeSigned(alice, TOKENS(100), MAX);
      await expect(
        staking.connect(alice).updateWeight(BASE, FAR_DEADLINE, NO_SIG)
      ).to.be.revertedWith("Signature required");
    });

    it("rejects base-weight stake with a wrong-signer signature", async function () {
      const sig = await signWeight("Stake", alice, TOKENS(100), BASE, { signer: bob });
      await expect(
        staking.connect(alice).stake(TOKENS(100), BASE, FAR_DEADLINE, sig)
      ).to.be.revertedWith("Invalid signature");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Staking", function () {
    it("accepts a signed base-weight stake", async function () {
      await stakeSigned(alice, TOKENS(100));
      const info = await staking.stakes(alice.address);
      expect(info.amount).to.equal(TOKENS(100));
      expect(info.weight).to.equal(BASE);
      expect(await staking.totalWeightedStaked()).to.equal(TOKENS(100) * BASE);
      expect(await staking.nonces(alice.address)).to.equal(1n);
    });

    it("sets a boosted weight with a valid signature", async function () {
      await expect(stakeSigned(alice, TOKENS(100), MAX))
        .to.emit(staking, "WeightUpdated")
        .withArgs(alice.address, 0, MAX);
      expect((await staking.stakes(alice.address)).weight).to.equal(MAX);
      expect(await staking.totalWeightedStaked()).to.equal(TOKENS(100) * MAX);
    });

    it("replaces the old weight on a subsequent signed stake", async function () {
      await stakeSigned(alice, TOKENS(100), 1500n);
      await stakeSigned(alice, TOKENS(100), MAX);
      expect((await staking.stakes(alice.address)).weight).to.equal(MAX);
      expect(await staking.totalWeightedStaked()).to.equal(TOKENS(200) * MAX);
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

    it("does not accept a Withdraw-typed signature for stake", async function () {
      const sig = await signWeight("Withdraw", alice, TOKENS(100), 1500);
      await expect(
        staking.connect(alice).stake(TOKENS(100), 1500, FAR_DEADLINE, sig)
      ).to.be.revertedWith("Invalid signature");
    });

    it("emits NonceUsed with the consumed nonce on every signed call", async function () {
      await expect(stakeSigned(alice, TOKENS(10)))
        .to.emit(staking, "NonceUsed")
        .withArgs(alice.address, 0n);

      await expect(stakeSigned(alice, TOKENS(10), 1500n))
        .to.emit(staking, "NonceUsed")
        .withArgs(alice.address, 1n);

      const updSig = await signWeight("UpdateWeight", alice, TOKENS(20), MAX);
      await expect(staking.connect(alice).updateWeight(MAX, FAR_DEADLINE, updSig))
        .to.emit(staking, "NonceUsed")
        .withArgs(alice.address, 2n);

      await expect(withdrawSigned(alice, TOKENS(5)))
        .to.emit(staking, "NonceUsed")
        .withArgs(alice.address, 3n);

      expect(await staking.nonces(alice.address)).to.equal(4n);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Weighted reward distribution", function () {
    it("gives a x2 staker twice the reward of a x1 staker (equal amounts)", async function () {
      await stakeSigned(alice, TOKENS(100), BASE);
      await stakeSigned(bob, TOKENS(100), MAX);

      await setupRewards(TOKENS(3000));
      await time.increaseTo(endEpoch + 1);

      await staking.connect(alice).unstake();
      await staking.connect(bob).unstake();

      expect(await staking.claimedRewards(alice.address)).to.be.closeTo(TOKENS(1000), TOKENS(1));
      expect(await staking.claimedRewards(bob.address)).to.be.closeTo(TOKENS(2000), TOKENS(1));
    });

    it("checkpoints accrual at the old weight when the weight changes mid-period", async function () {
      // alice: x1 for first half, x2 for second half => 1.5x average
      // bob:   x1 for the whole period
      await stakeSigned(alice, TOKENS(100), BASE);
      await stakeSigned(bob, TOKENS(100), BASE);

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
    it("resets the weight to BASE on partial unsigned withdraw (weight param ignored)", async function () {
      await stakeSigned(alice, TOKENS(200), 1500n);

      await expect(staking.connect(alice).withdraw(TOKENS(50), 123456789, 0, NO_SIG))
        .to.emit(staking, "WeightUpdated")
        .withArgs(alice.address, 1500n, BASE);
      const info = await staking.stakes(alice.address);
      expect(info.amount).to.equal(TOKENS(150));
      expect(info.weight).to.equal(BASE);
      expect(await staking.totalWeightedStaked()).to.equal(TOKENS(150) * BASE);
      expect(await staking.nonces(alice.address)).to.equal(1n); // no nonce consumed
    });

    it("cannot keep a boosted weight by withdrawing most of the stake unsigned", async function () {
      // attested x2 for 1000 tokens, then free pre-activation withdraw of 999
      await stakeSigned(alice, TOKENS(1000), MAX);

      await staking.connect(alice).withdraw(TOKENS(999), 0, 0, NO_SIG);
      expect((await staking.stakes(alice.address)).weight).to.equal(BASE);
      expect(await staking.totalWeightedStaked()).to.equal(TOKENS(1) * BASE);
    });

    it("applies the signed weight to the remaining stake", async function () {
      await stakeSigned(alice, TOKENS(200), MAX);

      await withdrawSigned(alice, TOKENS(100), 1500n);
      const info = await staking.stakes(alice.address);
      expect(info.amount).to.equal(TOKENS(100));
      expect(info.weight).to.equal(1500n);
      expect(await staking.totalWeightedStaked()).to.equal(TOKENS(100) * 1500n);
    });

    it("rejects a withdraw signature bound to a different amount", async function () {
      await stakeSigned(alice, TOKENS(200), MAX);
      const sig = await signWeight("Withdraw", alice, TOKENS(100), BASE);
      await expect(
        staking.connect(alice).withdraw(TOKENS(150), BASE, FAR_DEADLINE, sig)
      ).to.be.revertedWith("Invalid signature");
    });

    it("resets the weight on full withdraw; a new stake sets it fresh", async function () {
      await stakeSigned(alice, TOKENS(100), MAX);

      await withdrawSigned(alice, TOKENS(100), BASE);
      expect((await staking.stakes(alice.address)).weight).to.equal(0n);
      expect(await staking.totalWeightedStaked()).to.equal(0n);

      await stakeSigned(alice, TOKENS(50), 1500n);
      expect((await staking.stakes(alice.address)).weight).to.equal(1500n);
      expect(await staking.totalWeightedStaked()).to.equal(TOKENS(50) * 1500n);
    });

    it("still applies penalty and weight forfeiture during the active period", async function () {
      await stakeSigned(alice, TOKENS(100), MAX);

      await time.increaseTo(activationEpoch + POOL_DURATION / 2);
      const balBefore = await token.balanceOf(alice.address);
      await withdrawSigned(alice, TOKENS(100), BASE);
      const received = (await token.balanceOf(alice.address)) - balBefore;

      // ~27.5% penalty at half-time (50% -> 5% decay)
      expect(received).to.be.closeTo(TOKENS(72.5), TOKENS(1));
      expect(await staking.totalForfeitedWeight()).to.be.gt(0n);
      expect(await staking.getUserWeight(alice.address)).to.equal(0n);
    });

    it("decays the penalty from 50% to a 5% floor across the active period", async function () {
      expect(await staking.getCurrentPenaltyPct()).to.equal(0n); // before activation

      await time.setNextBlockTimestamp(activationEpoch);
      await mine();
      expect(await staking.getCurrentPenaltyPct()).to.equal(5000n);

      await time.setNextBlockTimestamp(activationEpoch + POOL_DURATION / 2);
      await mine();
      expect(await staking.getCurrentPenaltyPct()).to.equal(2750n);

      // one second before the end the floor still applies — exiting early is never free
      await time.setNextBlockTimestamp(endEpoch - 1);
      await mine();
      expect(await staking.getCurrentPenaltyPct()).to.equal(500n);

      await time.setNextBlockTimestamp(endEpoch);
      await mine();
      expect(await staking.getCurrentPenaltyPct()).to.equal(0n); // withdraw closed, unstake is free
    });

    it("charges the 5% floor on a withdraw at the very end of the active period", async function () {
      await stakeSigned(alice, TOKENS(100), BASE);

      const balBefore = await token.balanceOf(alice.address);
      await time.setNextBlockTimestamp(endEpoch - 1);
      await staking.connect(alice).withdraw(TOKENS(100), 0, 0, NO_SIG);

      // remaining = 1s, so the rate is a hair above the 5% floor rather than exactly on it
      expect((await token.balanceOf(alice.address)) - balBefore).to.be.closeTo(TOKENS(95), TOKENS(0.01));
      expect(await staking.totalPenalized()).to.be.closeTo(TOKENS(5), TOKENS(0.01));
    });

    it("zeroes the penalty and its view once ownership is renounced", async function () {
      await stakeSigned(alice, TOKENS(100), BASE);
      await time.increaseTo(activationEpoch + POOL_DURATION / 2);
      await staking.renounceOwnership();

      expect(await staking.getCurrentPenaltyPct()).to.equal(0n);
      expect(await staking.getCurrentPenalty(alice.address)).to.equal(0n);

      const balBefore = await token.balanceOf(alice.address);
      await staking.connect(alice).withdraw(TOKENS(100), 0, 0, NO_SIG);
      expect((await token.balanceOf(alice.address)) - balBefore).to.equal(TOKENS(100));
      expect(await staking.totalPenalized()).to.equal(0n);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("updateWeight", function () {
    it("updates the weight with a valid signature and no token movement", async function () {
      await stakeSigned(alice, TOKENS(100), BASE);
      const sig = await signWeight("UpdateWeight", alice, TOKENS(100), 1500);
      await expect(staking.connect(alice).updateWeight(1500, FAR_DEADLINE, sig))
        .to.emit(staking, "WeightUpdated")
        .withArgs(alice.address, BASE, 1500n);
      expect(await staking.totalWeightedStaked()).to.equal(TOKENS(100) * 1500n);
    });

    it("reverts without a stake", async function () {
      const sig = await signWeight("UpdateWeight", alice, 0, 1500);
      await expect(
        staking.connect(alice).updateWeight(1500, FAR_DEADLINE, sig)
      ).to.be.revertedWith("Nothing staked");
    });

    it("binds the signature to the user's current staked amount", async function () {
      await stakeSigned(alice, TOKENS(100), BASE);
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
  describe("Unstake and emergency unstake (no signature needed)", function () {
    it("clears weight state on unstake", async function () {
      await stakeSigned(alice, TOKENS(100), MAX);
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
      await stakeSigned(alice, TOKENS(100), MAX);
      await setupRewards(TOKENS(1000));
      await time.increaseTo(endEpoch + 1);

      const balBefore = await token.balanceOf(alice.address);
      await staking.connect(alice).emergencyUnstake();
      expect((await token.balanceOf(alice.address)) - balBefore).to.equal(TOKENS(100));
      expect(await staking.totalWeightedStaked()).to.equal(0n);
      expect(await rewardToken.balanceOf(alice.address)).to.equal(0n);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Event checkpoints (offchain indexing)", function () {
    // StakeUpdated(user, amount, weight, accumulatedWeight, timestamp) and
    // GlobalUpdated(totalStaked, totalWeightedStaked, totalAccumulatedWeight,
    //               totalForfeitedWeight, totalPenalized, totalRewardsClaimed, timestamp)
    // must be full state overwrites; timestamps are clamped to [activationEpoch, endEpoch].

    it("stake emits full user and global checkpoints (pre-activation timestamp clamped)", async function () {
      await expect(stakeSigned(alice, TOKENS(100), MAX))
        .to.emit(staking, "StakeUpdated")
        .withArgs(alice.address, TOKENS(100), MAX, 0n, activationEpoch)
        .and.to.emit(staking, "GlobalUpdated")
        .withArgs(TOKENS(100), TOKENS(100) * MAX, 0n, 0n, 0n, 0n, activationEpoch);
    });

    it("unsigned withdraw checkpoints the reset weight; full exit checkpoints weight 0", async function () {
      await stakeSigned(alice, TOKENS(200), MAX);

      await expect(staking.connect(alice).withdraw(TOKENS(50), 0, 0, NO_SIG))
        .to.emit(staking, "StakeUpdated")
        .withArgs(alice.address, TOKENS(150), BASE, 0n, activationEpoch)
        .and.to.emit(staking, "GlobalUpdated")
        .withArgs(TOKENS(150), TOKENS(150) * BASE, 0n, 0n, 0n, 0n, activationEpoch);

      await expect(staking.connect(alice).withdraw(TOKENS(150), 0, 0, NO_SIG))
        .to.emit(staking, "StakeUpdated")
        .withArgs(alice.address, 0n, 0n, 0n, activationEpoch)
        .and.to.emit(staking, "GlobalUpdated")
        .withArgs(0n, 0n, 0n, 0n, 0n, 0n, activationEpoch);
    });

    it("penalized mid-period withdraw carries absolute totalPenalized and forfeited weight", async function () {
      await stakeSigned(alice, TOKENS(100), BASE);

      const mid = activationEpoch + POOL_DURATION / 2;
      await time.setNextBlockTimestamp(mid);
      const accrued = TOKENS(100) * BASE * BigInt(POOL_DURATION / 2);

      // full exit at half-time: 27.5% penalty, entire accrued weight forfeited
      await expect(staking.connect(alice).withdraw(TOKENS(100), 0, 0, NO_SIG))
        .to.emit(staking, "StakeUpdated")
        .withArgs(alice.address, 0n, 0n, 0n, mid)
        .and.to.emit(staking, "GlobalUpdated")
        .withArgs(0n, 0n, accrued, accrued, TOKENS(27.5), 0n, mid);
    });

    it("updateWeight checkpoints accrual at the old weight and reports the new multiplier", async function () {
      await stakeSigned(alice, TOKENS(100), BASE);

      const mid = activationEpoch + POOL_DURATION / 2;
      const sig = await signWeight("UpdateWeight", alice, TOKENS(100), MAX);
      await time.setNextBlockTimestamp(mid);
      const accrued = TOKENS(100) * BASE * BigInt(POOL_DURATION / 2);

      await expect(staking.connect(alice).updateWeight(MAX, FAR_DEADLINE, sig))
        .to.emit(staking, "StakeUpdated")
        .withArgs(alice.address, TOKENS(100), MAX, accrued, mid)
        .and.to.emit(staking, "GlobalUpdated")
        .withArgs(TOKENS(100), TOKENS(100) * MAX, accrued, 0n, 0n, 0n, mid);
    });

    it("unstake emits absolute claimedRewards and zeroed user checkpoint at endEpoch", async function () {
      await stakeSigned(alice, TOKENS(100), MAX);
      await setupRewards(TOKENS(1000));
      await time.increaseTo(endEpoch + 1);

      const userW = TOKENS(100) * MAX * BigInt(POOL_DURATION);
      await expect(staking.connect(alice).unstake())
        .to.emit(staking, "Unstaked")
        .withArgs(alice.address, TOKENS(100), TOKENS(1000), TOKENS(1000), userW, userW)
        .and.to.emit(staking, "StakeUpdated")
        .withArgs(alice.address, 0n, 0n, 0n, endEpoch)
        .and.to.emit(staking, "GlobalUpdated")
        .withArgs(0n, 0n, userW, 0n, 0n, TOKENS(1000), endEpoch);
    });

    it("emergencyUnstake emits zeroed checkpoints clamped to endEpoch", async function () {
      await stakeSigned(alice, TOKENS(100), MAX);
      await time.increaseTo(endEpoch + 5);

      const userW = TOKENS(100) * MAX * BigInt(POOL_DURATION);
      await expect(staking.connect(alice).emergencyUnstake())
        .to.emit(staking, "StakeUpdated")
        .withArgs(alice.address, 0n, 0n, 0n, endEpoch)
        .and.to.emit(staking, "GlobalUpdated")
        .withArgs(0n, 0n, userW, 0n, 0n, 0n, endEpoch);
    });
  });
});
