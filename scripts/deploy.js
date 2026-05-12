const hre = require("hardhat");

async function main() {
  const stakingToken = process.env.STAKING_TOKEN;
  if (!stakingToken) throw new Error("Set STAKING_TOKEN in .env");

  const rewardToken = process.env.REWARD_TOKEN;
  const activationEpoch = process.env.ACTIVATION_EPOCH;
  const endEpoch = process.env.END_EPOCH;

  let rewardTokenAddress = rewardToken;

  if (!rewardTokenAddress) {
    console.log("REWARD_TOKEN not set — deploying MockERC20 as reward token...");
    const MockERC20 = await hre.ethers.getContractFactory("MockERC20");
    const mock = await MockERC20.deploy("Mock USDC", "mUSDC", hre.ethers.parseUnits("1000000", 6));
    await mock.waitForDeployment();
    rewardTokenAddress = await mock.getAddress();
    console.log("MockERC20 (mUSDC) deployed to:", rewardTokenAddress);
  }

  const now = Math.floor(Date.now() / 1000);
  const activation = activationEpoch || (now + 3600);
  const end = endEpoch || (now + 30 * 24 * 3600);

  console.log("Deploying StakingPool...");
  console.log("Network:", hre.network.name);
  console.log("Staking token:", stakingToken);
  console.log("Reward token:", rewardTokenAddress);
  console.log("Activation epoch:", activation);
  console.log("End epoch:", end);

  const StakingPool = await hre.ethers.getContractFactory("StakingPool");
  const contract = await StakingPool.deploy(stakingToken, rewardTokenAddress, activation, end);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log("StakingPool deployed to:", address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
