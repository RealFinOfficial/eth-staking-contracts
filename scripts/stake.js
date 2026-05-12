const hre = require("hardhat");

const CONTRACT_ADDRESS = "0x652C0A31A19F3a6F4680173bae7f344C94Fe7aFC";
const AMOUNT = hre.ethers.parseEther("100");

async function main() {
  const [signer] = await hre.ethers.getSigners();
  console.log("Staking with:", signer.address);

  const token = await hre.ethers.getContractAt("IERC20", process.env.STAKING_TOKEN);
  const staking = await hre.ethers.getContractAt("StakingPool", CONTRACT_ADDRESS);

  console.log("Approving 100 tokens...");
  const approveTx = await token.approve(CONTRACT_ADDRESS, AMOUNT);
  await approveTx.wait();
  console.log("Approved.");

  console.log("Staking 100 tokens...");
  const stakeTx = await staking.stake(AMOUNT);
  await stakeTx.wait();
  console.log("Staked successfully!");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
