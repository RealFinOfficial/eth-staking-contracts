const hre = require("hardhat");
const pools = require("./lib/pools");

// Owner: transfer reward tokens into the pool and raise the reward counter.
// Works on both pools and both networks.
//   REWARD_AMOUNT   — whole tokens, e.g. "50000" (required)
//   REWARD_DECIMALS — override if the token misreports decimals (the sepolia
//                     mUSDC mock reports 18 but is used as a 6-decimal token)
async function main() {
  const rewardAmount = process.env.REWARD_AMOUNT;
  if (!rewardAmount) throw new Error("Set REWARD_AMOUNT in whole tokens, e.g. REWARD_AMOUNT=50000");

  const { pool, kind, address, chainId } = await pools.getPool();
  const signer = await pools.getSigner();

  const owner = await pool.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`Only the owner can add rewards. Owner is ${owner}, you are ${signer.address}`);
  }

  const rewardTokenAddress = await pool.rewardToken();
  const rewardToken = await pools.getErc20(rewardTokenAddress);
  const decimals = process.env.REWARD_DECIMALS
    ? parseInt(process.env.REWARD_DECIMALS, 10)
    : Number(await rewardToken.decimals());
  const symbol = await rewardToken.symbol();
  const amount = hre.ethers.parseUnits(rewardAmount, decimals);

  const balance = await rewardToken.balanceOf(signer.address);

  console.log(`Pool:     ${kind} @ ${address}`);
  console.log(`Network:  chain ${chainId}`);
  console.log(`Token:    ${symbol} @ ${rewardTokenAddress} (${decimals} decimals)`);
  console.log(`From:     ${signer.address}`);
  console.log(`Amount:   ${rewardAmount} ${symbol}`);
  console.log(`Balance:  ${hre.ethers.formatUnits(balance, decimals)} ${symbol}`);
  console.log(`Existing totalRewards: ${hre.ethers.formatUnits(await pool.totalRewards(), decimals)}`);

  if (balance < amount) {
    throw new Error(`Insufficient ${symbol}: need ${rewardAmount}, have ${hre.ethers.formatUnits(balance, decimals)}`);
  }

  pools.requireConfirmation(chainId, `send ${rewardAmount} ${symbol} into the pool`);

  await pools.ensureAllowance(rewardToken, signer, address, amount, symbol);

  await pools.send("Adding rewards", signer, (o) => pool.connect(signer).addRewards(amount, o));

  console.log(`totalRewards now: ${hre.ethers.formatUnits(await pool.totalRewards(), decimals)} ${symbol}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
