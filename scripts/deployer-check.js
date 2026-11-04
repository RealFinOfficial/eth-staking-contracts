const hre = require("hardhat");

// Read-only preflight: checks network, deployer address, balance and deploy cost
// before any gas is spent. Sends no transaction.
//
// The deployer is the first signer the network config produces: PRIVATE_KEY on
// sepolia, MAINNET_PRIVATE_KEY on mainnet. The key itself is never printed, only
// the address it controls. Compare that address with the intended deployer first.
async function main() {
  const { chainId, name } = await hre.ethers.provider.getNetwork();
  console.log("Network:", hre.network.name, "chainId:", chainId.toString(), `(${name})`);

  const signers = await hre.ethers.getSigners();
  if (signers.length === 0) {
    throw new Error("No signer available — set PRIVATE_KEY (testnet) or MAINNET_PRIVATE_KEY (mainnet)");
  }

  const [deployer] = signers;
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  const fee = await hre.ethers.provider.getFeeData();

  console.log("Deployer:", deployer.address);
  console.log("Balance:", hre.ethers.formatEther(balance), "ETH");
  console.log("Nonce:", await hre.ethers.provider.getTransactionCount(deployer.address));
  if (fee.maxFeePerGas) {
    console.log("maxFeePerGas:", hre.ethers.formatUnits(fee.maxFeePerGas, "gwei"), "gwei");
  }

  // Estimate the actual deployment so the gas cost is known up front.
  const { STAKING_TOKEN, REWARD_TOKEN, ACTIVATION_EPOCH, END_EPOCH } = process.env;
  const weightSigner = process.env.WEIGHT_SIGNER || deployer.address;
  if (STAKING_TOKEN && REWARD_TOKEN && ACTIVATION_EPOCH && END_EPOCH) {
    const factory = await hre.ethers.getContractFactory("WeightedStakingPool");
    const tx = await factory.getDeployTransaction(
      STAKING_TOKEN,
      REWARD_TOKEN,
      ACTIVATION_EPOCH,
      END_EPOCH,
      weightSigner
    );
    const gas = await hre.ethers.provider.estimateGas({ ...tx, from: deployer.address });
    console.log("Estimated deploy gas:", gas.toString());
    if (fee.maxFeePerGas) {
      console.log("Estimated cost:", hre.ethers.formatEther(gas * fee.maxFeePerGas), "ETH (at maxFeePerGas)");
    }
    if (weightSigner === deployer.address) {
      console.log("WARNING: WEIGHT_SIGNER is unset — the deployer address would become the attestation signer.");
    }
  } else {
    console.log("Deploy params incomplete — skipping gas estimate.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
