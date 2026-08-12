const hre = require("hardhat");
const pools = require("./lib/pools");

// Deploy StakingPool on any network and record it in deployments.json.
//   STAKING_TOKEN — required
//   REWARD_TOKEN  — required on mainnet; on a testnet a MockERC20 is deployed
//                   when omitted
//   ACTIVATION_EPOCH / END_EPOCH — default to now+1h and now+30d on testnets,
//                                  required on mainnet
async function main() {
  const stakingToken = process.env.STAKING_TOKEN;
  if (!stakingToken) throw new Error("Set STAKING_TOKEN");

  const chainId = await pools.chainId();
  const deployer = await pools.getSigner();
  const mainnet = pools.isMainnet(chainId);

  let rewardTokenAddress = process.env.REWARD_TOKEN;
  if (!rewardTokenAddress) {
    if (mainnet) throw new Error("REWARD_TOKEN is required on mainnet — refusing to deploy a mock");
    console.log("REWARD_TOKEN not set — deploying MockERC20 as reward token...");
    const MockERC20 = await hre.ethers.getContractFactory("MockERC20");
    const mock = await MockERC20.deploy("Mock USDC", "mUSDC", hre.ethers.parseUnits("1000000", 6));
    await mock.waitForDeployment();
    rewardTokenAddress = await mock.getAddress();
    console.log("MockERC20 (mUSDC) deployed to:", rewardTokenAddress);
  }

  const now = (await hre.ethers.provider.getBlock("latest")).timestamp;
  if (mainnet && (!process.env.ACTIVATION_EPOCH || !process.env.END_EPOCH)) {
    throw new Error("Set ACTIVATION_EPOCH and END_EPOCH explicitly on mainnet");
  }
  const activation = Number(process.env.ACTIVATION_EPOCH || now + 3600);
  const end = Number(process.env.END_EPOCH || now + 30 * 24 * 3600);

  console.log("Deploying StakingPool...");
  console.log(`Network:       chain ${chainId}`);
  console.log(`Deployer:      ${deployer.address}`);
  console.log(`Staking token: ${stakingToken}`);
  console.log(`Reward token:  ${rewardTokenAddress}`);
  console.log(`Activation:    ${activation} (${pools.epochToIso(activation)})`);
  console.log(`End:           ${end} (${pools.epochToIso(end)})`);

  if (activation <= now) {
    console.log("\nWARNING: activationEpoch is already in the past — no penalty-free entry window.");
  }

  pools.requireConfirmation(chainId, "deploy StakingPool");

  const nonce = await pools.resolveNonce(deployer.address);
  console.log(`\nNonce: ${nonce}`);
  if (mainnet) console.log("Confirm on the Ledger...");

  const factory = await hre.ethers.getContractFactory("StakingPool");
  const contract = await factory.deploy(stakingToken, rewardTokenAddress, activation, end, { nonce });
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  const tx = contract.deploymentTransaction();
  const receipt = await hre.ethers.provider.getTransactionReceipt(tx.hash);

  console.log(`\nStakingPool deployed to: ${address}`);
  console.log(pools.explorerAddress(chainId, address));
  console.log(`Deploy tx: ${tx.hash}`);

  pools.recordDeployment(chainId, "StakingPool", address, {
    deployTx: tx.hash,
    block: receipt.blockNumber,
    activationEpoch: activation,
    endEpoch: end,
  });

  console.log(
    `\nVerify with:\nnpx hardhat verify --network ${hre.network.name} ${address} ` +
      `${stakingToken} ${rewardTokenAddress} ${activation} ${end}`
  );
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
