const hre = require("hardhat");

// Deploys a USDC-like 6-decimal mock reward token (1,000,000 mUSD to deployer).
async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const MockERC20Decimals = await hre.ethers.getContractFactory("MockERC20Decimals");
  const token = await MockERC20Decimals.deploy(
    "Mock USD",
    "mUSD",
    hre.ethers.parseUnits("1000000", 6),
    6
  );
  await token.waitForDeployment();

  console.log("MockERC20Decimals (mUSD, 6 decimals) deployed to:", await token.getAddress());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
