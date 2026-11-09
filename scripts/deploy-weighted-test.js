const hre = require("hardhat");
const pools = require("./lib/pools");

// Deploys a SHORT-WINDOW `WeightedStakingPool` (the v2 contract, byte for byte what sw2 runs) for the
// staking v3 rehearsal on Sepolia: activation now, end one hour later by default, so a tester can
// stake, wait out the window, `unstake()` and then run the three migrator routes the same day.
// Optionally funds its USDC reward pool in the same run, so `unstake()` pays a reward.
//
// It refuses to run on mainnet, records the pool under the registry kind `WeightedStakingPoolTest`
// (never `WeightedStakingPool`, which on chain 1 is sw2 itself), and prints the backend's facts.
//
// ──────────────────────── environment ────────────────────────
//
//   STAKING_TOKEN        $ASSET (tREAL on Sepolia); default: the LPZapper entry's `asset`
//   REWARD_TOKEN         USDC (tUSDC on Sepolia); default: the LPZapper entry's `usdc`
//   WEIGHT_SIGNER        the weight-voucher signer (a backend key); default: the deployer
//   SW2_TEST_START_DELAY seconds from now to activationEpoch, default 0 (activation now)
//   SW2_TEST_DURATION    seconds from activationEpoch to endEpoch, default 3600 (one hour)
//   SW2_TEST_REWARD      whole USDC to fund with `addRewards` after the deploy; default 0 (none)
//
//     SW2_TEST_REWARD=1000 npx hardhat run scripts/deploy-weighted-test.js --network sepolia

const KIND = "WeightedStakingPoolTest";

function readWhole(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${name} must be a whole number — got ${raw}`);
  return BigInt(raw);
}

async function main() {
  const chainId = await pools.chainId();
  if (pools.isMainnet(chainId)) {
    throw new Error("deploy-weighted-test.js deploys a rehearsal pool and refuses to run on mainnet");
  }
  const registry = pools.readRegistry()[String(chainId)] || {};
  const zapper = registry.LPZapper || {};
  const stakingToken = process.env.STAKING_TOKEN || zapper.asset;
  const rewardToken = process.env.REWARD_TOKEN || zapper.usdc;
  if (!stakingToken || !rewardToken) throw new Error("Set STAKING_TOKEN and REWARD_TOKEN");

  const deployer = await pools.getSigner();
  const weightSigner = process.env.WEIGHT_SIGNER || deployer.address;
  const now = BigInt((await hre.ethers.provider.getBlock("latest")).timestamp);
  const activationEpoch = now + readWhole("SW2_TEST_START_DELAY", 0n);
  const endEpoch = activationEpoch + readWhole("SW2_TEST_DURATION", 3600n);
  const rewardWhole = readWhole("SW2_TEST_REWARD", 0n);
  if (endEpoch <= activationEpoch) throw new Error("SW2_TEST_DURATION must be above zero");

  console.log("Deploying a short-window WeightedStakingPool (sw2 rehearsal)...");
  console.log(`Network:        chain ${chainId}`);
  console.log(`Deployer:       ${deployer.address}`);
  console.log(`Staking token:  ${stakingToken}`);
  console.log(`Reward token:   ${rewardToken}`);
  console.log(`Activation:     ${activationEpoch} (${pools.epochToIso(activationEpoch)})`);
  console.log(`End:            ${endEpoch} (${pools.epochToIso(endEpoch)})`);
  console.log(`Weight signer:  ${weightSigner}`);

  const nonce = await pools.resolveNonce(deployer.address);
  const factory = await hre.ethers.getContractFactory("WeightedStakingPool", deployer);
  const contract = await factory.deploy(stakingToken, rewardToken, activationEpoch, endEpoch, weightSigner, { nonce });
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  const tx = contract.deploymentTransaction();
  const receipt = await hre.ethers.provider.getTransactionReceipt(tx.hash);
  console.log(`\nWeightedStakingPool (test) deployed to: ${address}`);
  console.log(pools.explorerAddress(chainId, address));

  pools.recordDeployment(chainId, KIND, address, {
    deployTx: tx.hash,
    block: receipt.blockNumber,
    stakingToken,
    rewardToken,
    activationEpoch: Number(activationEpoch),
    endEpoch: Number(endEpoch),
    signer: weightSigner,
  });

  if (rewardWhole > 0n) {
    const usdc = await pools.getErc20(rewardToken);
    const decimals = await usdc.decimals();
    const amount = rewardWhole * 10n ** BigInt(decimals);
    await pools.ensureAllowance(usdc, deployer, address, amount, "the reward token for the test pool");
    await pools.send(`addRewards(${rewardWhole} whole)`, deployer, (o) => contract.addRewards(amount, o));
  }

  console.log(
    `\nStake before ${pools.epochToIso(endEpoch)}, then unstake() after it; the migrator routes take ` +
      "the principal and the reward from the wallet from there."
  );
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
