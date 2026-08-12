const hre = require("hardhat");
const pools = require("./lib/pools");

// Escape hatch after endEpoch: returns the staked tokens and FORFEITS every
// reward. Only worth using when rewards were never funded.
async function main() {
  const { pool, kind, address, chainId } = await pools.getPool();
  const signer = await pools.getSigner();

  const stakingToken = await pools.getErc20(await pool.stakingToken());
  const rewardToken = await pools.getErc20(await pool.rewardToken());
  const stakeDecimals = await stakingToken.decimals();

  const info = await pool.stakes(signer.address);
  if (info.amount === 0n) throw new Error("No stake to recover");

  const endEpoch = await pool.endEpoch();
  const now = (await hre.ethers.provider.getBlock("latest")).timestamp;
  if (BigInt(now) < endEpoch) {
    throw new Error(`Pool ends at ${pools.epochToIso(endEpoch)} — emergencyUnstake is not open yet`);
  }

  const totalRewards = await pool.totalRewards();
  const pending = await pool.getPendingReward(signer.address);

  console.log(`Pool:    ${kind} @ ${address}`);
  console.log(`Network: chain ${chainId}`);
  console.log(`From:    ${signer.address}`);
  console.log(`Returns: ${hre.ethers.formatUnits(info.amount, stakeDecimals)} ${await stakingToken.symbol()}`);
  console.log(
    `FORFEITS: ${hre.ethers.formatUnits(pending, await rewardToken.decimals())} ${await rewardToken.symbol()}`
  );

  if (totalRewards > 0n && pending > 0n) {
    console.log("\nRewards ARE funded — unstake.js would pay this out instead. Continue only on purpose.");
  }

  pools.requireConfirmation(chainId, "emergency unstake and forfeit all rewards");

  await pools.send("Emergency unstaking", signer, (o) => pool.connect(signer).emergencyUnstake(o));
  console.log("Tokens returned, rewards forfeited.");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
