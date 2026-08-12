const hre = require("hardhat");

// Read-only preflight: checks network, deployer balance and deploy cost before
// any gas is spent. Sends no transaction.
//
// Note: this does NOT reach the device — hardhat-ledger answers eth_accounts
// from config alone. Set LEDGER_PING=1 to also sign a throwaway message, which
// is free but does exercise the USB connection, derivation path and app state.
async function main() {
  const { chainId, name } = await hre.ethers.provider.getNetwork();
  console.log("Network:", hre.network.name, "chainId:", chainId.toString(), `(${name})`);

  const signers = await hre.ethers.getSigners();
  if (signers.length === 0) throw new Error("No signer available — is LEDGER_ACCOUNT set?");

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
      console.log("WARNING: WEIGHT_SIGNER is unset — the Ledger address would become the attestation signer.");
    }
  } else {
    console.log("Deploy params incomplete — skipping gas estimate.");
  }

  if (process.env.LEDGER_PING === "1") {
    console.log("\nAsking the Ledger to sign a throwaway message — confirm on the device...");
    const sig = await deployer.signMessage("WeightedStakingPool preflight");
    const recovered = hre.ethers.verifyMessage("WeightedStakingPool preflight", sig);
    console.log("Signed. Recovered:", recovered);
    console.log(
      recovered.toLowerCase() === deployer.address.toLowerCase()
        ? "Device OK — matches LEDGER_ACCOUNT."
        : "MISMATCH — the device signed with a different address."
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
