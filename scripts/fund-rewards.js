const hre = require("hardhat");

// Generic reward funding: approves and calls addRewards on any pool.
//   POOL            — pool contract address (required)
//   REWARD_AMOUNT   — amount in whole tokens, e.g. "100" (required)
//   REWARD_DECIMALS — override token decimals (the sepolia mUSDC mock reports 18
//                     but is minted and used as a 6-decimal token)
async function main() {
  const pool = process.env.POOL;
  const rewardAmount = process.env.REWARD_AMOUNT;
  if (!pool || !rewardAmount) throw new Error("Set POOL and REWARD_AMOUNT");

  const [signer] = await hre.ethers.getSigners();
  const staking = await hre.ethers.getContractAt("StakingPool", pool);
  const rewardTokenAddress = await staking.rewardToken();
  const rewardToken = await hre.ethers.getContractAt("MockERC20", rewardTokenAddress);

  const decimals = process.env.REWARD_DECIMALS
    ? parseInt(process.env.REWARD_DECIMALS, 10)
    : await rewardToken.decimals();
  const amount = hre.ethers.parseUnits(rewardAmount, decimals);

  console.log("Funding pool:", pool);
  console.log("Reward token:", rewardTokenAddress, `(${decimals} decimals)`);
  console.log("Amount:", rewardAmount);
  console.log("From:", signer.address);

  const approveTx = await rewardToken.approve(pool, amount);
  await approveTx.wait();
  console.log("Approved.");

  const tx = await staking.addRewards(amount);
  await tx.wait();
  console.log("Rewards added. totalRewards:", (await staking.totalRewards()).toString());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
