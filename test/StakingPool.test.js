const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("StakingPool", function () {
  let staking, token, rewardToken;
  let owner, alice, bob, charlie, dave;

  const TOKENS = (n) => ethers.parseEther(String(n));
  const POOL_DURATION = 8000;
  const POOL_DURATION_BN = BigInt(POOL_DURATION);
  const ACTIVATION_DELAY = 2000;

  let activationEpoch, endEpoch;

  async function txTs(txPromise) {
    const receipt = await (await txPromise).wait();
    return BigInt((await ethers.provider.getBlock(receipt.blockNumber)).timestamp);
  }

  function expectedPenalty(amount, elapsedSinceActivation) {
    const elapsed = BigInt(elapsedSinceActivation);
    if (elapsed >= POOL_DURATION_BN) return 0n;
    const remaining = POOL_DURATION_BN - elapsed;
    // decays 50% -> 5% floor across the active period
    return (
      (amount * (4500n * remaining + 500n * POOL_DURATION_BN)) / (POOL_DURATION_BN * 10000n)
    );
  }

  async function setupRewards(amount) {
    await rewardToken.approve(await staking.getAddress(), amount);
    await staking.addRewards(amount);
  }

  async function advanceToActivation() {
    await time.increaseTo(activationEpoch);
  }

  async function advancePastEnd() {
    await time.increaseTo(endEpoch + 1);
  }

  beforeEach(async function () {
    [owner, alice, bob, charlie, dave] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockERC20");
    token = await Token.deploy("ASSET", "ASSET", TOKENS(1_000_000));
    rewardToken = await Token.deploy("USDC", "USDC", TOKENS(1_000_000));

    const now = await time.latest();
    activationEpoch = now + ACTIVATION_DELAY;
    endEpoch = activationEpoch + POOL_DURATION;

    const Staking = await ethers.getContractFactory("StakingPool");
    staking = await Staking.deploy(
      await token.getAddress(),
      await rewardToken.getAddress(),
      activationEpoch,
      endEpoch
    );

    await token.transfer(alice.address, TOKENS(10_000));
    await token.transfer(bob.address, TOKENS(10_000));
    await token.transfer(charlie.address, TOKENS(10_000));
    await token.transfer(dave.address, TOKENS(10_000));

    const stakingAddr = await staking.getAddress();
    await token.connect(alice).approve(stakingAddr, ethers.MaxUint256);
    await token.connect(bob).approve(stakingAddr, ethers.MaxUint256);
    await token.connect(charlie).approve(stakingAddr, ethers.MaxUint256);
    await token.connect(dave).approve(stakingAddr, ethers.MaxUint256);
  });

  // ─────────────────────────────────────────────────────────────
  describe("Staking", function () {
    it("should accept stakes before activation", async function () {
      await staking.connect(alice).stake(TOKENS(100));
      expect(await staking.totalStaked()).to.equal(TOKENS(100));
      const info = await staking.stakes(alice.address);
      expect(info.amount).to.equal(TOKENS(100));
    });

    it("should accept stakes during active period", async function () {
      await advanceToActivation();
      await staking.connect(alice).stake(TOKENS(100));
      expect(await staking.totalStaked()).to.equal(TOKENS(100));
    });

    it("should reject zero amount", async function () {
      await expect(staking.connect(alice).stake(0)).to.be.revertedWith("Amount must be > 0");
    });

    it("should reject staking after endEpoch", async function () {
      await advancePastEnd();
      await expect(staking.connect(alice).stake(TOKENS(100))).to.be.revertedWith("Pool has ended");
    });

    it("should allow multiple stakes from same user", async function () {
      await staking.connect(alice).stake(TOKENS(100));
      await staking.connect(alice).stake(TOKENS(200));
      const info = await staking.stakes(alice.address);
      expect(info.amount).to.equal(TOKENS(300));
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Weight calculation", function () {
    it("should accumulate weight over time during active period", async function () {
      await advanceToActivation();
      await staking.connect(alice).stake(TOKENS(100));
      await time.increase(3600);
      const weight = await staking.getUserWeight(alice.address);
      expect(weight).to.be.closeTo(TOKENS(100) * 3600n, TOKENS(100) * 2n);
    });

    it("should not accumulate weight before activation", async function () {
      await staking.connect(alice).stake(TOKENS(100));
      await time.increase(1000);
      const weight = await staking.getUserWeight(alice.address);
      expect(weight).to.equal(0n);
    });

    it("should freeze weight after endEpoch", async function () {
      await advanceToActivation();
      await staking.connect(alice).stake(TOKENS(100));
      await time.increase(3600);

      await advancePastEnd();
      const weightAtEnd = await staking.getUserWeight(alice.address);
      await time.increase(3600);
      const weightLater = await staking.getUserWeight(alice.address);
      expect(weightAtEnd).to.equal(weightLater);
    });

    it("should start weight from activationEpoch for pre-activation stakers", async function () {
      await staking.connect(alice).stake(TOKENS(100));
      await advancePastEnd();
      const weight = await staking.getUserWeight(alice.address);
      expect(weight).to.equal(TOKENS(100) * POOL_DURATION_BN);
    });

    it("should calculate proportional weights for two stakers", async function () {
      await advanceToActivation();
      await staking.connect(alice).stake(TOKENS(100));
      await staking.connect(bob).stake(TOKENS(100));
      await time.increase(3600);

      const wAlice = await staking.getUserWeight(alice.address);
      const wBob = await staking.getUserWeight(bob.address);
      expect(wAlice).to.be.greaterThan(wBob);
    });

    it("should verify weights for 3 stakers with different amounts (ratio 1:2:3)", async function () {
      await advanceToActivation();

      const tA = await txTs(staking.connect(alice).stake(TOKENS(100)));
      const tB = await txTs(staking.connect(bob).stake(TOKENS(200)));
      const tC = await txTs(staking.connect(charlie).stake(TOKENS(300)));

      await advancePastEnd();

      const expectedAlice = TOKENS(100) * (BigInt(endEpoch) - tA);
      const expectedBob = TOKENS(200) * (BigInt(endEpoch) - tB);
      const expectedCharlie = TOKENS(300) * (BigInt(endEpoch) - tC);

      const aliceW = await staking.getUserWeight(alice.address);
      const bobW = await staking.getUserWeight(bob.address);
      const charlieW = await staking.getUserWeight(charlie.address);
      const totalW = await staking.getTotalEffectiveWeight();

      expect(aliceW).to.equal(expectedAlice);
      expect(bobW).to.equal(expectedBob);
      expect(charlieW).to.equal(expectedCharlie);
      expect(aliceW + bobW + charlieW).to.equal(totalW);

      expect(bobW * 1000n / aliceW).to.be.closeTo(2000n, 5n);
      expect(charlieW * 1000n / aliceW).to.be.closeTo(3000n, 5n);
    });

    it("should calculate correct weights when stakers join at different times", async function () {
      await advanceToActivation();

      const tA = await txTs(staking.connect(alice).stake(TOKENS(100)));
      await time.increase(1000);
      const tB = await txTs(staking.connect(bob).stake(TOKENS(200)));
      await time.increase(1000);
      const tC = await txTs(staking.connect(charlie).stake(TOKENS(300)));

      await advancePastEnd();

      const expectedAlice = TOKENS(100) * (BigInt(endEpoch) - tA);
      const expectedBob = TOKENS(200) * (BigInt(endEpoch) - tB);
      const expectedCharlie = TOKENS(300) * (BigInt(endEpoch) - tC);

      const aliceW = await staking.getUserWeight(alice.address);
      const bobW = await staking.getUserWeight(bob.address);
      const charlieW = await staking.getUserWeight(charlie.address);
      const totalW = await staking.getTotalEffectiveWeight();

      expect(aliceW).to.equal(expectedAlice);
      expect(bobW).to.equal(expectedBob);
      expect(charlieW).to.equal(expectedCharlie);
      expect(aliceW + bobW + charlieW).to.equal(totalW);
    });

    it("should redistribute effective weight when one staker forfeits", async function () {
      await advanceToActivation();

      const tA = await txTs(staking.connect(alice).stake(TOKENS(100)));
      const tB = await txTs(staking.connect(bob).stake(TOKENS(100)));
      await staking.connect(charlie).stake(TOKENS(100));

      await time.increase(1800);

      const withdrawTx = await staking.connect(charlie).withdraw(TOKENS(100));
      const withdrawReceipt = await withdrawTx.wait();
      const withdrawLog = withdrawReceipt.logs.find(
        (l) => staking.interface.parseLog(l)?.name === "Withdrawn"
      );
      const parsed = staking.interface.parseLog(withdrawLog);
      expect(parsed.args.amount).to.equal(TOKENS(100));
      expect(parsed.args.forfeitedWeight).to.be.greaterThan(0n);

      await advancePastEnd();

      const expectedAlice = TOKENS(100) * (BigInt(endEpoch) - tA);
      const expectedBob = TOKENS(100) * (BigInt(endEpoch) - tB);

      const aliceW = await staking.getUserWeight(alice.address);
      const bobW = await staking.getUserWeight(bob.address);
      const charlieW = await staking.getUserWeight(charlie.address);
      const totalW = await staking.getTotalEffectiveWeight();

      expect(aliceW).to.equal(expectedAlice);
      expect(bobW).to.equal(expectedBob);
      expect(charlieW).to.equal(0n);
      expect(aliceW + bobW).to.equal(totalW);

      expect(aliceW * 1000n / totalW).to.be.closeTo(500n, 5n);
      expect(bobW * 1000n / totalW).to.be.closeTo(500n, 5n);
    });

    it("should handle multiple forfeits at different times correctly", async function () {
      await advanceToActivation();

      const tA = await txTs(staking.connect(alice).stake(TOKENS(200)));
      const tB = await txTs(staking.connect(bob).stake(TOKENS(200)));
      await staking.connect(charlie).stake(TOKENS(200));
      await staking.connect(dave).stake(TOKENS(200));

      await time.increase(1000);
      await staking.connect(charlie).withdraw(TOKENS(200));

      await time.increase(1000);
      await staking.connect(dave).withdraw(TOKENS(200));

      await advancePastEnd();

      const expectedAlice = TOKENS(200) * (BigInt(endEpoch) - tA);
      const expectedBob = TOKENS(200) * (BigInt(endEpoch) - tB);

      const aliceW = await staking.getUserWeight(alice.address);
      const bobW = await staking.getUserWeight(bob.address);
      const charlieW = await staking.getUserWeight(charlie.address);
      const daveW = await staking.getUserWeight(dave.address);
      const totalW = await staking.getTotalEffectiveWeight();

      expect(aliceW).to.equal(expectedAlice);
      expect(bobW).to.equal(expectedBob);
      expect(charlieW).to.equal(0n);
      expect(daveW).to.equal(0n);
      expect(aliceW + bobW).to.equal(totalW);
    });

    it("should give 100% share to remaining staker when big staker forfeits", async function () {
      await advanceToActivation();

      const tA = await txTs(staking.connect(alice).stake(TOKENS(100)));
      await staking.connect(bob).stake(TOKENS(900));

      await time.increase(2000);
      await staking.connect(bob).withdraw(TOKENS(900));

      await advancePastEnd();

      const expectedAlice = TOKENS(100) * (BigInt(endEpoch) - tA);
      const aliceW = await staking.getUserWeight(alice.address);
      const totalW = await staking.getTotalEffectiveWeight();

      expect(aliceW).to.equal(expectedAlice);
      expect(aliceW).to.equal(totalW);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Withdraw (before activation)", function () {
    it("should allow free withdraw before activation", async function () {
      const balBefore = await token.balanceOf(alice.address);
      await staking.connect(alice).stake(TOKENS(100));
      await staking.connect(alice).withdraw(TOKENS(100));
      expect(await token.balanceOf(alice.address)).to.equal(balBefore);
      expect(await staking.totalStaked()).to.equal(0);
    });

    it("should not forfeit weight before activation", async function () {
      await staking.connect(alice).stake(TOKENS(100));
      const tx = await staking.connect(alice).withdraw(TOKENS(100));
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (log) => staking.interface.parseLog(log)?.name === "Withdrawn"
      );
      const parsed = staking.interface.parseLog(event);
      expect(parsed.args.forfeitedWeight).to.equal(0n);
      expect(parsed.args.penalty).to.equal(0n);
    });

    it("should allow partial withdraw before activation", async function () {
      const balBefore = await token.balanceOf(alice.address);
      await staking.connect(alice).stake(TOKENS(100));
      await staking.connect(alice).withdraw(TOKENS(40));
      const info = await staking.stakes(alice.address);
      expect(info.amount).to.equal(TOKENS(60));
      expect(await token.balanceOf(alice.address)).to.equal(balBefore - TOKENS(60));
    });

    it("should reject withdraw with no stake", async function () {
      await expect(staking.connect(alice).withdraw(TOKENS(1))).to.be.revertedWith("Nothing to withdraw");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Withdraw (during active period)", function () {
    it("should forfeit proportional weight", async function () {
      await advanceToActivation();
      await staking.connect(alice).stake(TOKENS(100));
      await time.increase(3600);

      const tx = await staking.connect(alice).withdraw(TOKENS(100));
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (log) => staking.interface.parseLog(log)?.name === "Withdrawn"
      );
      const parsed = staking.interface.parseLog(event);
      expect(parsed.args.forfeitedWeight).to.be.greaterThan(0n);
    });

    it("should return tokens minus penalty on withdraw", async function () {
      await advanceToActivation();
      const balBefore = await token.balanceOf(alice.address);
      const tS = await txTs(staking.connect(alice).stake(TOKENS(100)));
      const tW = await txTs(staking.connect(alice).withdraw(TOKENS(100)));

      const penalty = expectedPenalty(TOKENS(100), tW - BigInt(activationEpoch));
      const balAfter = await token.balanceOf(alice.address);
      expect(balAfter).to.equal(balBefore - penalty);
    });

    it("should reject zero amount", async function () {
      await advanceToActivation();
      await staking.connect(alice).stake(TOKENS(100));
      await expect(staking.connect(alice).withdraw(0)).to.be.revertedWith("Amount must be > 0");
    });

    it("should reject exceeding staked amount", async function () {
      await advanceToActivation();
      await staking.connect(alice).stake(TOKENS(100));
      await expect(staking.connect(alice).withdraw(TOKENS(101))).to.be.revertedWith("Amount exceeds stake");
    });

    it("should not allow withdraw after endEpoch", async function () {
      await staking.connect(alice).stake(TOKENS(100));
      await advancePastEnd();
      await expect(staking.connect(alice).withdraw(TOKENS(100))).to.be.revertedWith("Use unstake after pool ends");
    });

    it("should allow partial withdraw and update remaining stake", async function () {
      await advanceToActivation();
      const balBefore = await token.balanceOf(alice.address);
      await staking.connect(alice).stake(TOKENS(100));
      const tW = await txTs(staking.connect(alice).withdraw(TOKENS(30)));

      const penalty = expectedPenalty(TOKENS(30), tW - BigInt(activationEpoch));
      const info = await staking.stakes(alice.address);
      expect(info.amount).to.equal(TOKENS(70));
      expect(await staking.totalStaked()).to.equal(TOKENS(70));
      expect(await token.balanceOf(alice.address)).to.equal(balBefore - TOKENS(70) - penalty);
    });

    it("should forfeit only proportional weight on partial withdraw", async function () {
      await advanceToActivation();

      const tA = await txTs(staking.connect(alice).stake(TOKENS(100)));
      await time.increase(1000);
      const tW = await txTs(staking.connect(alice).withdraw(TOKENS(40)));

      await advancePastEnd();

      const weightAtWithdraw = TOKENS(100) * (tW - tA);
      const forfeited = weightAtWithdraw * 40n / 100n;
      const kept = weightAtWithdraw - forfeited;
      const additional = TOKENS(60) * (BigInt(endEpoch) - tW);
      const expectedWeight = kept + additional;

      const aliceW = await staking.getUserWeight(alice.address);
      expect(aliceW).to.equal(expectedWeight);
      expect(await staking.getTotalEffectiveWeight()).to.equal(aliceW);
    });

    it("should allow multiple partial withdraws", async function () {
      await advanceToActivation();

      const tA = await txTs(staking.connect(alice).stake(TOKENS(100)));
      await time.increase(1000);

      const t1 = await txTs(staking.connect(alice).withdraw(TOKENS(30)));
      const weightAt1 = TOKENS(100) * (t1 - tA);
      const forfeited1 = weightAt1 * 30n / 100n;
      const remaining1 = weightAt1 - forfeited1;

      await time.increase(1000);

      const t2 = await txTs(staking.connect(alice).withdraw(TOKENS(20)));
      const weightAt2 = remaining1 + TOKENS(70) * (t2 - t1);
      const forfeited2 = weightAt2 * 20n / 70n;
      const remaining2 = weightAt2 - forfeited2;

      await advancePastEnd();

      const expectedWeight = remaining2 + TOKENS(50) * (BigInt(endEpoch) - t2);
      const aliceW = await staking.getUserWeight(alice.address);
      expect(aliceW).to.equal(expectedWeight);

      const info = await staking.stakes(alice.address);
      expect(info.amount).to.equal(TOKENS(50));
    });

    it("should not affect other stakers when one partially withdraws", async function () {
      await advanceToActivation();

      const tA = await txTs(staking.connect(alice).stake(TOKENS(100)));
      const tB = await txTs(staking.connect(bob).stake(TOKENS(100)));

      await time.increase(1000);
      const tW = await txTs(staking.connect(alice).withdraw(TOKENS(50)));

      await advancePastEnd();

      const expectedBob = TOKENS(100) * (BigInt(endEpoch) - tB);
      const bobW = await staking.getUserWeight(bob.address);
      expect(bobW).to.equal(expectedBob);

      const aliceWeightAtW = TOKENS(100) * (tW - tA);
      const forfeitedAlice = aliceWeightAtW * 50n / 100n;
      const keptAlice = aliceWeightAtW - forfeitedAlice;
      const additionalAlice = TOKENS(50) * (BigInt(endEpoch) - tW);
      const expectedAlice = keptAlice + additionalAlice;
      const aliceW = await staking.getUserWeight(alice.address);
      expect(aliceW).to.equal(expectedAlice);

      const totalW = await staking.getTotalEffectiveWeight();
      expect(totalW).to.equal(aliceW + bobW);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Unstake (after pool ends)", function () {
    it("should not allow unstake before endEpoch", async function () {
      await staking.connect(alice).stake(TOKENS(100));
      await advanceToActivation();
      await expect(staking.connect(alice).unstake()).to.be.revertedWith("Pool not ended yet");
    });

    it("should unstake full amount and return tokens", async function () {
      const balBefore = await token.balanceOf(alice.address);
      await setupRewards(TOKENS(1000));
      await staking.connect(alice).stake(TOKENS(100));
      await advancePastEnd();
      await staking.connect(alice).unstake();
      expect(await token.balanceOf(alice.address)).to.equal(balBefore);
      expect(await staking.totalStaked()).to.equal(0);
    });

    it("should reject unstake with no stake", async function () {
      await setupRewards(TOKENS(1000));
      await advancePastEnd();
      await expect(staking.connect(alice).unstake()).to.be.revertedWith("Nothing to unstake");
    });

    it("should reject unstake before rewards are funded", async function () {
      await staking.connect(alice).stake(TOKENS(100));
      await advancePastEnd();
      await expect(staking.connect(alice).unstake()).to.be.revertedWith("Rewards not funded");
    });

    it("should allow unstake once rewards are funded after endEpoch", async function () {
      await staking.connect(alice).stake(TOKENS(100));
      await advancePastEnd();
      await expect(staking.connect(alice).unstake()).to.be.revertedWith("Rewards not funded");
      await setupRewards(TOKENS(1000));
      await staking.connect(alice).unstake();
      expect(await staking.totalStaked()).to.equal(0);
    });

    it("should zero out user stake data", async function () {
      await setupRewards(TOKENS(1000));
      await staking.connect(alice).stake(TOKENS(100));
      await advancePastEnd();
      await staking.connect(alice).unstake();
      const info = await staking.stakes(alice.address);
      expect(info.amount).to.equal(0n);
      expect(info.accumulatedWeight).to.equal(0n);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Reward distribution", function () {
    it("should distribute equal rewards to equal stakers (staked before activation)", async function () {
      await setupRewards(TOKENS(1000));

      await staking.connect(alice).stake(TOKENS(100));
      await staking.connect(bob).stake(TOKENS(100));

      await advancePastEnd();

      const aliceRewardBefore = await rewardToken.balanceOf(alice.address);
      await staking.connect(alice).unstake();
      const aliceReward = (await rewardToken.balanceOf(alice.address)) - aliceRewardBefore;

      const bobRewardBefore = await rewardToken.balanceOf(bob.address);
      await staking.connect(bob).unstake();
      const bobReward = (await rewardToken.balanceOf(bob.address)) - bobRewardBefore;

      expect(aliceReward).to.equal(TOKENS(500));
      expect(bobReward).to.equal(TOKENS(500));
    });

    it("should distribute proportional rewards based on weight (2:1 amounts)", async function () {
      await setupRewards(TOKENS(900));

      await staking.connect(alice).stake(TOKENS(200));
      await staking.connect(bob).stake(TOKENS(100));

      await advancePastEnd();

      const aliceRewardBefore = await rewardToken.balanceOf(alice.address);
      await staking.connect(alice).unstake();
      const aliceReward = (await rewardToken.balanceOf(alice.address)) - aliceRewardBefore;

      const bobRewardBefore = await rewardToken.balanceOf(bob.address);
      await staking.connect(bob).unstake();
      const bobReward = (await rewardToken.balanceOf(bob.address)) - bobRewardBefore;

      expect(aliceReward).to.equal(TOKENS(600));
      expect(bobReward).to.equal(TOKENS(300));
    });

    it("should redistribute forfeited rewards to remaining stakers", async function () {
      await setupRewards(TOKENS(1000));

      await staking.connect(alice).stake(TOKENS(100));
      await staking.connect(bob).stake(TOKENS(100));

      await advanceToActivation();
      await time.increase(2000);

      await staking.connect(bob).withdraw(TOKENS(100));

      await advancePastEnd();

      const aliceRewardBefore = await rewardToken.balanceOf(alice.address);
      await staking.connect(alice).unstake();
      const aliceReward = (await rewardToken.balanceOf(alice.address)) - aliceRewardBefore;

      expect(aliceReward).to.equal(TOKENS(1000));
    });

    it("should give full reward to sole staker", async function () {
      await setupRewards(TOKENS(1000));

      await staking.connect(alice).stake(TOKENS(100));

      await advancePastEnd();

      const rewardBefore = await rewardToken.balanceOf(alice.address);
      await staking.connect(alice).unstake();
      const reward = (await rewardToken.balanceOf(alice.address)) - rewardBefore;

      expect(reward).to.equal(TOKENS(1000));
    });

    it("should revert unstake when no rewards added (emergencyUnstake still exits)", async function () {
      await staking.connect(alice).stake(TOKENS(100));
      await advancePastEnd();

      await expect(staking.connect(alice).unstake()).to.be.revertedWith("Rewards not funded");
      await staking.connect(alice).emergencyUnstake();
      expect(await staking.totalStaked()).to.equal(0n);
    });

    it("should emit Unstaked with correct reward info", async function () {
      await setupRewards(TOKENS(1000));
      await staking.connect(alice).stake(TOKENS(100));
      await advancePastEnd();

      const tx = await staking.connect(alice).unstake();
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (log) => staking.interface.parseLog(log)?.name === "Unstaked"
      );
      const parsed = staking.interface.parseLog(event);
      expect(parsed.args.amount).to.equal(TOKENS(100));
      expect(parsed.args.reward).to.equal(TOKENS(1000));
      expect(parsed.args.userWeight).to.be.greaterThan(0n);
      expect(parsed.args.totalEffectiveWeight).to.be.greaterThan(0n);
    });

    it("should track claimedRewards per user", async function () {
      await setupRewards(TOKENS(1000));

      await staking.connect(alice).stake(TOKENS(100));
      await staking.connect(bob).stake(TOKENS(100));
      await advancePastEnd();

      await staking.connect(alice).unstake();
      expect(await staking.claimedRewards(alice.address)).to.equal(TOKENS(500));
      expect(await staking.totalRewardsClaimed()).to.equal(TOKENS(500));

      await staking.connect(bob).unstake();
      expect(await staking.claimedRewards(bob.address)).to.equal(TOKENS(500));
      expect(await staking.totalRewardsClaimed()).to.equal(TOKENS(1000));
    });

    it("should handle complex scenario: different times, amounts, and forfeits", async function () {
      await setupRewards(TOKENS(10_000));

      await staking.connect(alice).stake(TOKENS(100));

      await advanceToActivation();
      await time.increase(2000);

      await staking.connect(bob).stake(TOKENS(200));
      await time.increase(1000);

      await staking.connect(charlie).stake(TOKENS(300));
      await time.increase(1000);

      await staking.connect(charlie).withdraw(TOKENS(300));

      await advancePastEnd();

      const aliceW = await staking.getUserWeight(alice.address);
      const bobW = await staking.getUserWeight(bob.address);
      const totalW = await staking.getTotalEffectiveWeight();

      expect(aliceW + bobW).to.equal(totalW);

      const aliceRewardBefore = await rewardToken.balanceOf(alice.address);
      await staking.connect(alice).unstake();
      const aliceReward = (await rewardToken.balanceOf(alice.address)) - aliceRewardBefore;

      const bobRewardBefore = await rewardToken.balanceOf(bob.address);
      await staking.connect(bob).unstake();
      const bobReward = (await rewardToken.balanceOf(bob.address)) - bobRewardBefore;

      const expectedAliceReward = (TOKENS(10_000) * aliceW) / totalW;
      const expectedBobReward = (TOKENS(10_000) * bobW) / totalW;

      expect(aliceReward).to.equal(expectedAliceReward);
      expect(bobReward).to.equal(expectedBobReward);
      expect(aliceReward + bobReward).to.be.closeTo(TOKENS(10_000), TOKENS(1));
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Emergency unstake", function () {
    it("should return full stake without rewards", async function () {
      await setupRewards(TOKENS(1000));
      await staking.connect(alice).stake(TOKENS(100));
      await advancePastEnd();

      const stakeBefore = await token.balanceOf(alice.address);
      const rewardBefore = await rewardToken.balanceOf(alice.address);
      await staking.connect(alice).emergencyUnstake();
      expect(await token.balanceOf(alice.address)).to.equal(stakeBefore + TOKENS(100));
      expect(await rewardToken.balanceOf(alice.address)).to.equal(rewardBefore);
      expect(await staking.totalStaked()).to.equal(0);
    });

    it("should zero out user stake data", async function () {
      await staking.connect(alice).stake(TOKENS(100));
      await advancePastEnd();

      await staking.connect(alice).emergencyUnstake();
      const info = await staking.stakes(alice.address);
      expect(info.amount).to.equal(0n);
      expect(info.accumulatedWeight).to.equal(0n);
    });

    it("should not allow calling unstake after emergencyUnstake", async function () {
      await setupRewards(TOKENS(1000));
      await staking.connect(alice).stake(TOKENS(100));
      await advancePastEnd();

      await staking.connect(alice).emergencyUnstake();
      await expect(staking.connect(alice).unstake()).to.be.revertedWith("Nothing to unstake");
    });

    it("should leave other stakers rewards unchanged", async function () {
      await setupRewards(TOKENS(1000));
      await staking.connect(alice).stake(TOKENS(100));
      await staking.connect(bob).stake(TOKENS(100));
      await advancePastEnd();

      await staking.connect(alice).emergencyUnstake();

      const bobRewardBefore = await rewardToken.balanceOf(bob.address);
      await staking.connect(bob).unstake();
      const bobReward = (await rewardToken.balanceOf(bob.address)) - bobRewardBefore;
      expect(bobReward).to.equal(TOKENS(500));
    });

    it("should allow owner to recover unclaimed rewards after everyone leaves", async function () {
      await setupRewards(TOKENS(1000));
      await staking.connect(alice).stake(TOKENS(100));
      await staking.connect(bob).stake(TOKENS(100));
      await advancePastEnd();

      await staking.connect(alice).emergencyUnstake();
      await staking.connect(bob).unstake();

      const ownerBefore = await rewardToken.balanceOf(owner.address);
      await staking.recoverExcessRewards();
      const ownerAfter = await rewardToken.balanceOf(owner.address);
      expect(ownerAfter - ownerBefore).to.equal(TOKENS(500));
    });

    it("should not allow before endEpoch", async function () {
      await staking.connect(alice).stake(TOKENS(100));
      await advanceToActivation();
      await expect(staking.connect(alice).emergencyUnstake()).to.be.revertedWith("Pool not ended yet");
    });

    it("should reject with no stake", async function () {
      await advancePastEnd();
      await expect(staking.connect(alice).emergencyUnstake()).to.be.revertedWith("Nothing to unstake");
    });

    it("should emit EmergencyUnstaked event", async function () {
      await staking.connect(alice).stake(TOKENS(100));
      await advancePastEnd();

      await expect(staking.connect(alice).emergencyUnstake())
        .to.emit(staking, "EmergencyUnstaked")
        .withArgs(alice.address, TOKENS(100));
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Owner functions", function () {
    it("should allow owner to addRewards", async function () {
      await rewardToken.approve(await staking.getAddress(), TOKENS(800));
      await staking.addRewards(TOKENS(500));
      expect(await staking.totalRewards()).to.equal(TOKENS(500));

      await staking.addRewards(TOKENS(300));
      expect(await staking.totalRewards()).to.equal(TOKENS(800));
    });

    it("should reject addRewards with zero amount", async function () {
      await expect(staking.addRewards(0)).to.be.revertedWith("Amount must be > 0");
    });

    it("should only allow owner to addRewards", async function () {
      await expect(staking.connect(alice).addRewards(TOKENS(100))).to.be.reverted;
    });

    it("should emit RewardsAdded", async function () {
      await rewardToken.approve(await staking.getAddress(), TOKENS(500));
      await expect(staking.addRewards(TOKENS(500)))
        .to.emit(staking, "RewardsAdded")
        .withArgs(TOKENS(500), TOKENS(500));
    });

    it("should recover random ERC20 tokens", async function () {
      const Token = await ethers.getContractFactory("MockERC20");
      const randomToken = await Token.deploy("RAND", "RAND", TOKENS(1000));

      await randomToken.transfer(await staking.getAddress(), TOKENS(100));
      await staking.recoverERC20(await randomToken.getAddress(), TOKENS(100));
      expect(await randomToken.balanceOf(owner.address)).to.equal(TOKENS(1000));
    });

    it("should not recover staking token", async function () {
      await expect(
        staking.recoverERC20(await token.getAddress(), TOKENS(1))
      ).to.be.revertedWith("Cannot recover staking token");
    });

    it("should not recover reward token", async function () {
      await expect(
        staking.recoverERC20(await rewardToken.getAddress(), TOKENS(1))
      ).to.be.revertedWith("Cannot recover reward token");
    });

    it("should recover excess rewards after pool ends", async function () {
      await setupRewards(TOKENS(1000));
      await rewardToken.transfer(await staking.getAddress(), TOKENS(500));

      await staking.connect(alice).stake(TOKENS(100));
      await advancePastEnd();
      await staking.connect(alice).unstake();

      const ownerBefore = await rewardToken.balanceOf(owner.address);
      await staking.recoverExcessRewards();
      const ownerAfter = await rewardToken.balanceOf(owner.address);
      expect(ownerAfter - ownerBefore).to.equal(TOKENS(500));
    });

    it("should recover all rewards if no one staked during active period", async function () {
      await setupRewards(TOKENS(1000));

      await advancePastEnd();

      const ownerBefore = await rewardToken.balanceOf(owner.address);
      await staking.recoverExcessRewards();
      const ownerAfter = await rewardToken.balanceOf(owner.address);
      expect(ownerAfter - ownerBefore).to.equal(TOKENS(1000));
    });

    it("should not allow recoverExcessRewards before pool ends", async function () {
      await expect(staking.recoverExcessRewards()).to.be.revertedWith("Pool not ended yet");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Withdraw penalty", function () {
    it("should apply ~50% penalty at activation", async function () {
      await advanceToActivation();
      await staking.connect(alice).stake(TOKENS(1000));
      const tW = await txTs(staking.connect(alice).withdraw(TOKENS(1000)));

      const penalty = expectedPenalty(TOKENS(1000), tW - BigInt(activationEpoch));
      expect(penalty).to.be.closeTo(TOKENS(500), TOKENS(1));
      expect(await staking.totalPenalized()).to.equal(penalty);
    });

    it("should apply ~27.5% penalty at midpoint", async function () {
      await advanceToActivation();
      await staking.connect(alice).stake(TOKENS(1000));
      await time.increase(POOL_DURATION / 2);

      const tW = await txTs(staking.connect(alice).withdraw(TOKENS(1000)));
      const penalty = expectedPenalty(TOKENS(1000), tW - BigInt(activationEpoch));
      expect(penalty).to.be.closeTo(TOKENS(275), TOKENS(1));
    });

    it("should apply 0% penalty after pool ends", async function () {
      await setupRewards(TOKENS(1000));
      await staking.connect(alice).stake(TOKENS(1000));
      await advancePastEnd();
      await staking.connect(alice).unstake();
      expect(await staking.totalPenalized()).to.equal(0n);
    });

    it("should send penalty tokens to PENALTY_RECEIVER", async function () {
      await advanceToActivation();
      await staking.connect(alice).stake(TOKENS(1000));
      const receiverBefore = await token.balanceOf(await staking.PENALTY_RECEIVER());
      const tW = await txTs(staking.connect(alice).withdraw(TOKENS(1000)));

      const penalty = expectedPenalty(TOKENS(1000), tW - BigInt(activationEpoch));
      const receiverAfter = await token.balanceOf(await staking.PENALTY_RECEIVER());
      expect(receiverAfter).to.equal(receiverBefore + penalty);
    });

    it("should track totalPenalized across multiple withdrawals", async function () {
      await advanceToActivation();
      await staking.connect(alice).stake(TOKENS(1000));
      await staking.connect(bob).stake(TOKENS(1000));

      const tW1 = await txTs(staking.connect(alice).withdraw(TOKENS(500)));
      const penalty1 = expectedPenalty(TOKENS(500), tW1 - BigInt(activationEpoch));

      await time.increase(POOL_DURATION / 4);

      const tW2 = await txTs(staking.connect(bob).withdraw(TOKENS(500)));
      const penalty2 = expectedPenalty(TOKENS(500), tW2 - BigInt(activationEpoch));

      expect(await staking.totalPenalized()).to.equal(penalty1 + penalty2);
      expect(penalty1).to.be.greaterThan(penalty2);
    });

    it("should emit Withdrawn event with correct penalty", async function () {
      await advanceToActivation();
      await staking.connect(alice).stake(TOKENS(1000));

      const tx = await staking.connect(alice).withdraw(TOKENS(1000));
      const receipt = await tx.wait();
      const tW = BigInt((await ethers.provider.getBlock(receipt.blockNumber)).timestamp);

      const event = receipt.logs.find(
        (log) => staking.interface.parseLog(log)?.name === "Withdrawn"
      );
      const parsed = staking.interface.parseLog(event);

      const penalty = expectedPenalty(TOKENS(1000), tW - BigInt(activationEpoch));
      expect(parsed.args.penalty).to.equal(penalty);
      expect(parsed.args.amount).to.equal(TOKENS(1000));
    });

    it("should calculate penalty on gross amount", async function () {
      await advanceToActivation();
      const balBefore = await token.balanceOf(alice.address);
      await staking.connect(alice).stake(TOKENS(1000));
      const tW = await txTs(staking.connect(alice).withdraw(TOKENS(400)));

      const penalty = expectedPenalty(TOKENS(400), tW - BigInt(activationEpoch));
      expect(penalty).to.be.closeTo(TOKENS(200), TOKENS(1));

      const balAfter = await token.balanceOf(alice.address);
      const balExpected = balBefore - TOKENS(1000) + TOKENS(400) - penalty;
      expect(balAfter).to.equal(balExpected);
    });

    it("should apply no penalty before activation", async function () {
      await staking.connect(alice).stake(TOKENS(1000));
      await staking.connect(alice).withdraw(TOKENS(1000));
      expect(await staking.totalPenalized()).to.equal(0n);
    });

    it("should hold the 5% floor at the very end of the active period", async function () {
      await advanceToActivation();
      await staking.connect(alice).stake(TOKENS(1000));

      await time.setNextBlockTimestamp(endEpoch - 1);
      await staking.connect(alice).withdraw(TOKENS(1000));

      // remaining = 1s, so a hair above the floor rather than exactly on it
      expect(await staking.totalPenalized()).to.be.closeTo(TOKENS(50), TOKENS(0.1));
    });

    it("should zero the penalty and its view once ownership is renounced", async function () {
      await advanceToActivation();
      await staking.connect(alice).stake(TOKENS(1000));
      await staking.renounceOwnership();

      expect(await staking.getCurrentPenaltyPct()).to.equal(0n);
      expect(await staking.getCurrentPenalty(alice.address)).to.equal(0n);

      const balBefore = await token.balanceOf(alice.address);
      await staking.connect(alice).withdraw(TOKENS(1000));
      expect((await token.balanceOf(alice.address)) - balBefore).to.equal(TOKENS(1000));
      expect(await staking.totalPenalized()).to.equal(0n);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("View functions", function () {
    it("getPendingReward should return expected reward", async function () {
      await setupRewards(TOKENS(1000));
      await staking.connect(alice).stake(TOKENS(100));
      await staking.connect(bob).stake(TOKENS(100));

      await advancePastEnd();

      const pending = await staking.getPendingReward(alice.address);
      expect(pending).to.equal(TOKENS(500));
    });

    it("getPendingReward should return 0 when no rewards", async function () {
      await staking.connect(alice).stake(TOKENS(100));
      await advancePastEnd();
      expect(await staking.getPendingReward(alice.address)).to.equal(0n);
    });

    it("getPendingReward should return 0 for user with no stake", async function () {
      await setupRewards(TOKENS(1000));
      await advancePastEnd();
      expect(await staking.getPendingReward(alice.address)).to.equal(0n);
    });

    it("getTotalEffectiveWeight should exclude forfeited", async function () {
      await advanceToActivation();
      await staking.connect(alice).stake(TOKENS(100));
      await staking.connect(bob).stake(TOKENS(100));
      await time.increase(3600);

      const totalBefore = await staking.getTotalEffectiveWeight();
      await staking.connect(alice).withdraw(TOKENS(100));
      const totalAfter = await staking.getTotalEffectiveWeight();
      expect(totalAfter).to.be.lessThan(totalBefore);
    });

    it("getCurrentPenaltyPct should return 0 before activation", async function () {
      expect(await staking.getCurrentPenaltyPct()).to.equal(0n);
    });

    it("getCurrentPenaltyPct should return ~5000 at activation", async function () {
      await advanceToActivation();
      expect(await staking.getCurrentPenaltyPct()).to.be.closeTo(5000n, 2n);
    });

    it("getCurrentPenaltyPct should return ~2750 at midpoint", async function () {
      await time.increaseTo(activationEpoch + POOL_DURATION / 2);
      expect(await staking.getCurrentPenaltyPct()).to.be.closeTo(2750n, 2n);
    });

    it("getCurrentPenaltyPct should return 0 after endEpoch", async function () {
      await advancePastEnd();
      expect(await staking.getCurrentPenaltyPct()).to.equal(0n);
    });

    it("getCurrentPenalty should return 0 for user with no stake", async function () {
      expect(await staking.getCurrentPenalty(alice.address)).to.equal(0n);
    });

    it("getCurrentPenalty should return 0 before activation", async function () {
      await staking.connect(alice).stake(TOKENS(1000));
      expect(await staking.getCurrentPenalty(alice.address)).to.equal(0n);
    });

    it("getCurrentPenalty should return ~50% at activation", async function () {
      await staking.connect(alice).stake(TOKENS(1000));
      await advanceToActivation();
      expect(await staking.getCurrentPenalty(alice.address)).to.be.closeTo(TOKENS(500), TOKENS(1));
    });

    it("getCurrentPenalty should return ~27.5% at midpoint", async function () {
      await staking.connect(alice).stake(TOKENS(1000));
      await time.increaseTo(activationEpoch + POOL_DURATION / 2);
      expect(await staking.getCurrentPenalty(alice.address)).to.be.closeTo(TOKENS(275), TOKENS(1));
    });

    it("getCurrentPenalty should return 0 after endEpoch", async function () {
      await staking.connect(alice).stake(TOKENS(1000));
      await advancePastEnd();
      expect(await staking.getCurrentPenalty(alice.address)).to.equal(0n);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Constructor validation", function () {
    it("should emit PoolInitialized carrying the penalty curve constants", async function () {
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

    it("should reject invalid staking token", async function () {
      const Staking = await ethers.getContractFactory("StakingPool");
      await expect(
        Staking.deploy(ethers.ZeroAddress, await rewardToken.getAddress(), activationEpoch, endEpoch)
      ).to.be.revertedWith("Invalid staking token");
    });

    it("should reject invalid reward token", async function () {
      const Staking = await ethers.getContractFactory("StakingPool");
      await expect(
        Staking.deploy(await token.getAddress(), ethers.ZeroAddress, activationEpoch, endEpoch)
      ).to.be.revertedWith("Invalid reward token");
    });

    it("should reject same staking and reward token", async function () {
      const Staking = await ethers.getContractFactory("StakingPool");
      const addr = await token.getAddress();
      await expect(Staking.deploy(addr, addr, activationEpoch, endEpoch)).to.be.revertedWith(
        "Tokens must be different"
      );
    });

    it("should reject end before activation", async function () {
      const Staking = await ethers.getContractFactory("StakingPool");
      await expect(
        Staking.deploy(await token.getAddress(), await rewardToken.getAddress(), endEpoch, activationEpoch)
      ).to.be.revertedWith("End must be after activation");
    });
  });
});
