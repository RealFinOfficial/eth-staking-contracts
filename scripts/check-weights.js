const hre = require("hardhat");

const CONTRACT_ADDRESS = "0xce6Fc294ed168FFa04C8eBA189dC3060562cdE63";

const USER1 = "0xBb7403aAF82342A0d987A8603aAf881136B5D125";
const USER2 = "0xF1F6720d4515934328896D37D356627522D97B49";

async function main() {
  const staking = await hre.ethers.getContractAt("StakingPool", CONTRACT_ADDRESS);

  const weight1 = await staking.getUserWeight(USER1);
  const weight2 = await staking.getUserWeight(USER2);
  const totalWeight = await staking.getTotalEffectiveWeight();

  console.log("User 1:", USER1);
  console.log("User 1 weight:", weight1.toString());
  console.log("");
  console.log("User 2:", USER2);
  console.log("User 2 weight:", weight2.toString());
  console.log("");
  console.log("Total effective weight:", totalWeight.toString());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
