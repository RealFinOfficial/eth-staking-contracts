const hre = require("hardhat");
const pools = require("./lib/pools");

// Deploy WeightedStakingPool on any network and record it in deployments.json.
//   STAKING_TOKEN, REWARD_TOKEN, ACTIVATION_EPOCH, END_EPOCH — required
//   WEIGHT_SIGNER — attestation signer; MUST be a backend key, not the deployer
async function main() {
  const stakingToken = process.env.STAKING_TOKEN;
  const rewardToken = process.env.REWARD_TOKEN;
  const activationEpoch = process.env.ACTIVATION_EPOCH;
  const endEpoch = process.env.END_EPOCH;

  if (!stakingToken || !rewardToken) throw new Error("Set STAKING_TOKEN and REWARD_TOKEN");
  if (!activationEpoch || !endEpoch) throw new Error("Set ACTIVATION_EPOCH and END_EPOCH");

  const chainId = await pools.chainId();
  const deployer = await pools.getSigner();
  const weightSigner = process.env.WEIGHT_SIGNER || deployer.address;

  const now = (await hre.ethers.provider.getBlock("latest")).timestamp;

  console.log("Deploying WeightedStakingPool...");
  console.log(`Network:        chain ${chainId}`);
  console.log(`Deployer:       ${deployer.address}`);
  console.log(`Staking token:  ${stakingToken}`);
  console.log(`Reward token:   ${rewardToken}`);
  console.log(`Activation:     ${activationEpoch} (${pools.epochToIso(activationEpoch)})`);
  console.log(`End:            ${endEpoch} (${pools.epochToIso(endEpoch)})`);
  console.log(`Weight signer:  ${weightSigner}`);

  if (weightSigner === deployer.address) {
    console.log(
      "\nWARNING: WEIGHT_SIGNER is unset, so the deployer becomes the attestation signer.\n" +
        "         The signer must sign EIP-712 messages on every stake — a Ledger cannot serve that role."
    );
  }
  if (Number(activationEpoch) <= now) {
    console.log(
      "\nWARNING: activationEpoch is already in the past — there will be no penalty-free entry window."
    );
  }

  pools.requireConfirmation(chainId, "deploy WeightedStakingPool");

  const nonce = await pools.resolveNonce(deployer.address);
  console.log(`\nNonce: ${nonce}`);
  if (pools.isMainnet(chainId)) console.log("Confirm on the Ledger...");

  const factory = await hre.ethers.getContractFactory("WeightedStakingPool");
  const contract = await factory.deploy(
    stakingToken,
    rewardToken,
    activationEpoch,
    endEpoch,
    weightSigner,
    { nonce }
  );
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  const tx = contract.deploymentTransaction();
  const receipt = await hre.ethers.provider.getTransactionReceipt(tx.hash);

  console.log(`\nWeightedStakingPool deployed to: ${address}`);
  console.log(pools.explorerAddress(chainId, address));
  console.log(`Deploy tx: ${tx.hash}`);

  pools.recordDeployment(chainId, "WeightedStakingPool", address, {
    deployTx: tx.hash,
    block: receipt.blockNumber,
    activationEpoch: Number(activationEpoch),
    endEpoch: Number(endEpoch),
  });

  console.log(
    `\nVerify with:\nnpx hardhat verify --network ${hre.network.name} ${address} ` +
      `${stakingToken} ${rewardToken} ${activationEpoch} ${endEpoch} ${weightSigner}`
  );
  console.log(`Check state with:\nDEPLOY_TX=${tx.hash} npx hardhat run scripts/post-deploy-check.js --network ${hre.network.name}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
