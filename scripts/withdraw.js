const hre = require("hardhat");
const pools = require("./lib/pools");

// Early exit before endEpoch — forfeits weight and pays the penalty.
//   AMOUNT — whole tokens (required)
// On WeightedStakingPool the attestation is OPTIONAL: with no WEIGHT set the
// script sends an unsigned withdraw, which always works and resets the
// multiplier to BASE_WEIGHT (or 0 on a full exit).
async function main() {
  const amountArg = process.env.AMOUNT;
  if (!amountArg) throw new Error("Set AMOUNT in whole tokens, e.g. AMOUNT=50");

  const { pool, kind, address, chainId, weighted } = await pools.getPool();
  const signer = await pools.getSigner();

  const token = await pools.getErc20(await pool.stakingToken());
  const decimals = await token.decimals();
  const symbol = await token.symbol();
  const amount = hre.ethers.parseUnits(amountArg, decimals);

  const info = await pool.stakes(signer.address);
  if (info.amount < amount) {
    throw new Error(
      `Staked balance is ${hre.ethers.formatUnits(info.amount, decimals)} ${symbol}, cannot withdraw ${amountArg}`
    );
  }

  const penaltyPct = await pool.getCurrentPenaltyPct();
  const penalty = (amount * penaltyPct) / 10000n;

  console.log(`Pool:     ${kind} @ ${address}`);
  console.log(`Network:  chain ${chainId}`);
  console.log(`From:     ${signer.address}`);
  console.log(`Staked:   ${hre.ethers.formatUnits(info.amount, decimals)} ${symbol}`);
  console.log(`Withdraw: ${amountArg} ${symbol}`);
  console.log(`Penalty:  ${Number(penaltyPct) / 100}% ≈ ${hre.ethers.formatUnits(penalty, decimals)} ${symbol}`);
  console.log(`You keep: ≈ ${hre.ethers.formatUnits(amount - penalty, decimals)} ${symbol}`);
  console.log("All accrued weight on the withdrawn portion is forfeited.");

  let attestation = null;
  if (weighted && process.env.WEIGHT) {
    attestation = await pools.resolveAttestation({
      pool,
      action: "Withdraw",
      user: signer.address,
      amount,
    });
    console.log(`New multiplier: ${attestation.weight}`);
  } else if (weighted) {
    console.log("No WEIGHT set — sending an unsigned withdraw, multiplier resets to BASE_WEIGHT.");
  }

  pools.requireConfirmation(chainId, `withdraw ${amountArg} ${symbol} and pay the penalty`);

  await pools.send("Withdrawing", signer, (o) =>
    weighted
      ? pool
          .connect(signer)
          .withdraw(
            amount,
            attestation ? attestation.weight : 0,
            attestation ? attestation.deadline : 0,
            attestation ? attestation.signature : "0x",
            o
          )
      : pool.connect(signer).withdraw(amount, o)
  );

  const after = await pool.stakes(signer.address);
  console.log(`Remaining stake: ${hre.ethers.formatUnits(after.amount, decimals)} ${symbol}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
