const hre = require("hardhat");

const CONTRACT_ADDRESS = "0xce6Fc294ed168FFa04C8eBA189dC3060562cdE63";
const REWARD_TOKEN_ADDRESS = "0x45e1Dca1B4b68f649c731B0f6FDf680F389d4213";
const AMOUNT = hre.ethers.parseUnits("50000", 6);

async function main() {
  const [signer] = await hre.ethers.getSigners();
  console.log("Adding rewards with:", signer.address);

  const rewardToken = await hre.ethers.getContractAt("IERC20", REWARD_TOKEN_ADDRESS);
  const staking = await hre.ethers.getContractAt("StakingPool", CONTRACT_ADDRESS);

  console.log("Approving 50000 mUSDC...");
  const approveTx = await rewardToken.approve(CONTRACT_ADDRESS, AMOUNT);
  await approveTx.wait();

  console.log("Adding rewards...");
  const tx = await staking.addRewards(AMOUNT);
  await tx.wait();
  console.log("50000 mUSDC rewards added!");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
