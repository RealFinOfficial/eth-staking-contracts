const hre = require("hardhat");
const pools = require("./lib/pools");

// Full exit after endEpoch: staked tokens plus the proportional USDC reward.
// Identical call on both pools — no signature is ever needed here.
async function main() {
  const { pool, kind, address, chainId } = await pools.getPool();
  const signer = await pools.getSigner();

  const stakingToken = await pools.getErc20(await pool.stakingToken());
  const rewardToken = await pools.getErc20(await pool.rewardToken());
  const stakeDecimals = await stakingToken.decimals();
  const rewardDecimals = await rewardToken.decimals();

  const info = await pool.stakes(signer.address);
  if (info.amount === 0n) throw new Error("No stake to unstake");

  const endEpoch = await pool.endEpoch();
  const now = (await hre.ethers.provider.getBlock("latest")).timestamp;
  if (BigInt(now) < endEpoch) {
    throw new Error(
      `Pool ends at ${pools.epochToIso(endEpoch)} — use withdraw.js for an early exit`
    );
  }

  const totalRewards = await pool.totalRewards();
  if (totalRewards === 0n) {
    throw new Error(
      "Rewards are not funded — unstake() reverts. Use emergency-unstake.js to recover tokens without rewards."
    );
  }

  const pending = await pool.getPendingReward(signer.address);

  console.log(`Pool:    ${kind} @ ${address}`);
  console.log(`Network: chain ${chainId}`);
  console.log(`From:    ${signer.address}`);
  console.log(`Stake:   ${hre.ethers.formatUnits(info.amount, stakeDecimals)} ${await stakingToken.symbol()}`);
  console.log(`Reward:  ${hre.ethers.formatUnits(pending, rewardDecimals)} ${await rewardToken.symbol()}`);

  pools.requireConfirmation(chainId, "unstake");

  await pools.send("Unstaking", signer, (o) => pool.connect(signer).unstake(o));

  console.log(
    `Claimed to date: ${hre.ethers.formatUnits(await pool.claimedRewards(signer.address), rewardDecimals)}`
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
