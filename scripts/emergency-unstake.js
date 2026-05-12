const hre = require("hardhat");

const CONTRACT_ADDRESS = "0xce6Fc294ed168FFa04C8eBA189dC3060562cdE63";

async function main() {
  const [signer] = await hre.ethers.getSigners();
  console.log("Emergency unstaking with:", signer.address);

  const staking = await hre.ethers.getContractAt("StakingPool", CONTRACT_ADDRESS);

  const tx = await staking.emergencyUnstake();
  const receipt = await tx.wait();
  console.log("Emergency unstaked successfully. Tx:", receipt.hash);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
