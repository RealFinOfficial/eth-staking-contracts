const hre = require("hardhat");
const pools = require("./lib/pools");

// Owner: sweep overfunded or unclaimed reward tokens after the pool has ended.
// Available on both pools.
async function main() {
  const { pool, kind, address, chainId } = await pools.getPool();
  const signer = await pools.getSigner();

  const owner = await pool.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`Only the owner can recover rewards. Owner is ${owner}, you are ${signer.address}`);
  }

  const rewardToken = await pools.getErc20(await pool.rewardToken());
  const decimals = Number(await rewardToken.decimals());
  const symbol = await rewardToken.symbol();

  const endEpoch = await pool.endEpoch();
  const now = (await hre.ethers.provider.getBlock("latest")).timestamp;
  if (BigInt(now) < endEpoch) {
    throw new Error(`Pool ends at ${pools.epochToIso(endEpoch)} — recovery is not open yet`);
  }

  const held = await rewardToken.balanceOf(address);
  const totalRewards = await pool.totalRewards();
  const claimed = await pool.totalRewardsClaimed();
  const stillOwed = totalRewards - claimed;

  console.log(`Pool:      ${kind} @ ${address}`);
  console.log(`Network:   chain ${chainId}`);
  console.log(`Held:      ${hre.ethers.formatUnits(held, decimals)} ${symbol}`);
  console.log(`Funded:    ${hre.ethers.formatUnits(totalRewards, decimals)} ${symbol}`);
  console.log(`Claimed:   ${hre.ethers.formatUnits(claimed, decimals)} ${symbol}`);
  console.log(`Still owed to stakers who have not exited: ${hre.ethers.formatUnits(stillOwed, decimals)} ${symbol}`);
  console.log(`Total staked still in the pool: ${await pool.totalStaked()}`);

  if ((await pool.totalStaked()) > 0n) {
    console.log("\nStakers have not all exited yet — recovering now can strand their rewards.");
  }

  pools.requireConfirmation(chainId, "recover excess rewards");

  await pools.send("Recovering", signer, (o) => pool.connect(signer).recoverExcessRewards(o));

  console.log(
    `Pool now holds: ${hre.ethers.formatUnits(await rewardToken.balanceOf(address), decimals)} ${symbol}`
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
