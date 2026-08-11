const hre = require("hardhat");

async function main() {
  const stakingToken = process.env.STAKING_TOKEN;
  if (!stakingToken) throw new Error("Set STAKING_TOKEN in .env");

  const rewardToken = process.env.REWARD_TOKEN;
  if (!rewardToken) throw new Error("Set REWARD_TOKEN in .env");

  const activationEpoch = process.env.ACTIVATION_EPOCH;
  const endEpoch = process.env.END_EPOCH;
  if (!activationEpoch || !endEpoch) throw new Error("Set ACTIVATION_EPOCH and END_EPOCH");

  const [deployer] = await hre.ethers.getSigners();
  // Weight attestation signer; defaults to the deployer, rotate later via setSigner()
  const weightSigner = process.env.WEIGHT_SIGNER || deployer.address;

  console.log("Deploying WeightedStakingPool...");
  console.log("Network:", hre.network.name);
  console.log("Deployer:", deployer.address);
  console.log("Staking token:", stakingToken);
  console.log("Reward token:", rewardToken);
  console.log("Activation epoch:", activationEpoch);
  console.log("End epoch:", endEpoch);
  console.log("Weight signer:", weightSigner);

  const WeightedStakingPool = await hre.ethers.getContractFactory("WeightedStakingPool");
  const contract = await WeightedStakingPool.deploy(
    stakingToken,
    rewardToken,
    activationEpoch,
    endEpoch,
    weightSigner
  );
  await contract.waitForDeployment();

  console.log("WeightedStakingPool deployed to:", await contract.getAddress());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
