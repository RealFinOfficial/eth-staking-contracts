const pools = require("./lib/pools");

// Change the multiplier without moving tokens. WeightedStakingPool only.
// Accrual up to this point is checkpointed at the OLD multiplier — boosts are
// never retroactive.
//   WEIGHT — 1000 (x1.0) … 2000 (x2.0), required
//   plus SIGNATURE + DEADLINE, or WEIGHT_SIGNER_KEY to sign locally
async function main() {
  const { pool, kind, address, chainId, weighted } = await pools.getPool();
  if (!weighted) throw new Error(`updateWeight does not exist on ${kind} — it has no multipliers`);

  const signer = await pools.getSigner();
  const info = await pool.stakes(signer.address);
  if (info.amount === 0n) throw new Error("No stake — updateWeight reverts without one");

  const attestation = await pools.resolveAttestation({
    pool,
    action: "UpdateWeight",
    user: signer.address,
    amount: info.amount, // the signature is bound to the current staked amount
  });

  console.log(`Pool:    ${kind} @ ${address}`);
  console.log(`Network: chain ${chainId}`);
  console.log(`From:    ${signer.address}`);
  console.log(`Current: ${info.weight} (${Number(info.weight) / 1000}x)`);
  console.log(`New:     ${attestation.weight} (${Number(attestation.weight) / 1000}x)`);

  pools.requireConfirmation(chainId, `change the multiplier to ${attestation.weight}`);

  await pools.send("Updating weight", signer, (o) =>
    pool.connect(signer).updateWeight(attestation.weight, attestation.deadline, attestation.signature, o)
  );

  console.log(`Multiplier now: ${(await pool.stakes(signer.address)).weight}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
