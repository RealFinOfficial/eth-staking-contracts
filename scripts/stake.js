const hre = require("hardhat");
const pools = require("./lib/pools");

// Stake into either pool on any network.
//   AMOUNT  — whole tokens, e.g. "100" (required)
//   POOL / POOL_KIND — see scripts/README.md
//   WeightedStakingPool also needs an attestation: WEIGHT plus either
//   SIGNATURE + DEADLINE, or WEIGHT_SIGNER_KEY to sign locally.
async function main() {
  const amountArg = process.env.AMOUNT;
  if (!amountArg) throw new Error("Set AMOUNT in whole tokens, e.g. AMOUNT=100");

  const { pool, kind, address, chainId, weighted } = await pools.getPool();
  const signer = await pools.getSigner();

  const token = await pools.getErc20(await pool.stakingToken());
  const decimals = await token.decimals();
  const symbol = await token.symbol();
  const amount = hre.ethers.parseUnits(amountArg, decimals);

  const balance = await token.balanceOf(signer.address);

  console.log(`Pool:    ${kind} @ ${address}`);
  console.log(`Network: chain ${chainId}`);
  console.log(`From:    ${signer.address}`);
  console.log(`Amount:  ${amountArg} ${symbol}`);
  console.log(`Balance: ${hre.ethers.formatUnits(balance, decimals)} ${symbol}`);

  if (balance < amount) {
    throw new Error(`Insufficient ${symbol}: need ${amountArg}, have ${hre.ethers.formatUnits(balance, decimals)}`);
  }

  const endEpoch = await pool.endEpoch();
  const now = (await hre.ethers.provider.getBlock("latest")).timestamp;
  if (BigInt(now) >= endEpoch) throw new Error("Pool has ended — staking is closed");

  let attestation;
  if (weighted) {
    attestation = await pools.resolveAttestation({
      pool,
      action: "Stake",
      user: signer.address,
      amount,
    });
    console.log(`Weight:  ${attestation.weight} (${Number(attestation.weight) / 1000}x)`);
  }

  pools.requireConfirmation(chainId, `stake ${amountArg} ${symbol}`);

  await pools.ensureAllowance(token, signer, address, amount, symbol);

  await pools.send("Staking", signer, (o) =>
    weighted
      ? pool
          .connect(signer)
          .stake(amount, attestation.weight, attestation.deadline, attestation.signature, o)
      : pool.connect(signer).stake(amount, o)
  );

  const info = await pool.stakes(signer.address);
  console.log(`Staked. Position: ${hre.ethers.formatUnits(info.amount, decimals)} ${symbol}`);
  if (weighted) console.log(`Multiplier: ${info.weight}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
