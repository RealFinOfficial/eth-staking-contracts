const hre = require("hardhat");
const pools = require("./lib/pools");

// Read-only overview of any pool on any network, plus optional per-user detail.
// Needs no signer, so it runs against mainnet without a Ledger attached.
//   USERS — comma-separated addresses to inspect (optional)
async function main() {
  const { pool, kind, address, chainId, weighted } = await pools.getPool();

  const stakingToken = await pools.getErc20(await pool.stakingToken());
  const rewardToken = await pools.getErc20(await pool.rewardToken());
  const stakeDec = Number(await stakingToken.decimals());
  const rewardDec = Number(await rewardToken.decimals());
  const stakeSym = await stakingToken.symbol();
  const rewardSym = await rewardToken.symbol();

  const [activation, end, owner, totalStaked, totalRewards, claimed, penalized, forfeited, penaltyPct] =
    await Promise.all([
      pool.activationEpoch(),
      pool.endEpoch(),
      pool.owner(),
      pool.totalStaked(),
      pool.totalRewards(),
      pool.totalRewardsClaimed(),
      pool.totalPenalized(),
      pool.totalForfeitedWeight(),
      pool.getCurrentPenaltyPct(),
    ]);

  const now = BigInt((await hre.ethers.provider.getBlock("latest")).timestamp);
  const phase =
    now < activation ? "pre-activation (free entry and exit)" : now < end ? "active" : "ended";

  console.log(`${kind} @ ${address}`);
  console.log(pools.explorerAddress(chainId, address));
  console.log(`\nChain:      ${chainId}`);
  console.log(`Phase:      ${phase}`);
  console.log(`Now:        ${pools.epochToIso(now)}`);
  console.log(`Activation: ${pools.epochToIso(activation)}`);
  console.log(`End:        ${pools.epochToIso(end)}`);
  console.log(`Owner:      ${owner === hre.ethers.ZeroAddress ? "renounced (staking disabled)" : owner}`);
  if (weighted) console.log(`Signer:     ${await pool.signer()}`);

  console.log(`\nStaking token: ${stakeSym} @ ${await stakingToken.getAddress()}`);
  console.log(`Reward token:  ${rewardSym} @ ${await rewardToken.getAddress()}`);

  console.log(`\nTotal staked:     ${hre.ethers.formatUnits(totalStaked, stakeDec)} ${stakeSym}`);
  if (weighted) {
    console.log(`Weighted staked:  ${await pool.totalWeightedStaked()}`);
  }
  console.log(`Effective weight: ${await pool.getTotalEffectiveWeight()}`);
  console.log(`Forfeited weight: ${forfeited}`);
  console.log(`Penalized:        ${hre.ethers.formatUnits(penalized, stakeDec)} ${stakeSym}`);
  console.log(`Rewards funded:   ${hre.ethers.formatUnits(totalRewards, rewardDec)} ${rewardSym}`);
  console.log(`Rewards claimed:  ${hre.ethers.formatUnits(claimed, rewardDec)} ${rewardSym}`);
  console.log(`Pool holds:       ${hre.ethers.formatUnits(await rewardToken.balanceOf(address), rewardDec)} ${rewardSym}`);
  console.log(`Current penalty:  ${Number(penaltyPct) / 100}%`);

  if (totalRewards === 0n && now >= end) {
    console.log("\nRewards are NOT funded — unstake() reverts, only emergencyUnstake() works.");
  }

  const users = (process.env.USERS || "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);

  for (const user of users) {
    const info = await pool.stakes(user);
    console.log(`\n── ${user}`);
    console.log(`   Staked:    ${hre.ethers.formatUnits(info.amount, stakeDec)} ${stakeSym}`);
    if (weighted) {
      console.log(`   Multiplier: ${info.weight} (${Number(info.weight) / 1000}x)`);
      console.log(`   Nonce:      ${await pool.nonces(user)}`);
    }
    console.log(`   Weight:    ${await pool.getUserWeight(user)}`);
    console.log(`   Pending:   ${hre.ethers.formatUnits(await pool.getPendingReward(user), rewardDec)} ${rewardSym}`);
    console.log(`   Claimed:   ${hre.ethers.formatUnits(await pool.claimedRewards(user), rewardDec)} ${rewardSym}`);
    if (info.amount > 0n) {
      console.log(
        `   Penalty if exiting now: ${hre.ethers.formatUnits(await pool.getCurrentPenalty(user), stakeDec)} ${stakeSym}`
      );
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
