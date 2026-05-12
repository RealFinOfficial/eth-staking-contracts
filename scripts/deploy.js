const hre = require("hardhat");

async function main() {
  const stakingToken = process.env.STAKING_TOKEN;
  if (!stakingToken) {
    throw new Error("Set STAKING_TOKEN in .env");
  }

  console.log("Deploying StakingPool...");
  console.log("Network:", hre.network.name);
  console.log("Staking token:", stakingToken);

  const StakingPool = await hre.ethers.getContractFactory("StakingPool");
  const contract = await StakingPool.deploy(stakingToken);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log("StakingPool deployed to:", address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
