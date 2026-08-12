const pools = require("./lib/pools");

// Owner: rotate the EIP-712 attestation signer. WeightedStakingPool only.
// Every signature issued by the old signer becomes invalid immediately, so the
// backend must be switched over in the same window.
//   NEW_SIGNER — address (required)
async function main() {
  const newSigner = process.env.NEW_SIGNER;
  if (!newSigner) throw new Error("Set NEW_SIGNER to the new attestation signer address");

  const { pool, kind, address, chainId, weighted } = await pools.getPool();
  if (!weighted) throw new Error(`${kind} has no attestation signer`);

  const signer = await pools.getSigner();
  const owner = await pool.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`Only the owner can rotate the signer. Owner is ${owner}, you are ${signer.address}`);
  }

  const current = await pool.signer();
  if (current.toLowerCase() === newSigner.toLowerCase()) {
    console.log("Already the current signer — nothing to do.");
    return;
  }

  const code = await pool.runner.provider.getCode(newSigner);
  if (code !== "0x") {
    throw new Error(`${newSigner} is a contract — it cannot produce ECDSA signatures`);
  }

  console.log(`Pool:    ${kind} @ ${address}`);
  console.log(`Network: chain ${chainId}`);
  console.log(`Current: ${current}`);
  console.log(`New:     ${newSigner}`);
  console.log("\nAll outstanding signatures from the current signer stop working the moment this lands.");

  pools.requireConfirmation(chainId, `rotate the signer to ${newSigner}`);

  await pools.send("Setting signer", signer, (o) => pool.connect(signer).setSigner(newSigner, o));
  console.log(`Signer now: ${await pool.signer()}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
