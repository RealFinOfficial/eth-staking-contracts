const hre = require("hardhat");
const pools = require("./lib/pools");

// Reads a freshly deployed pool back and asserts every constructor-set value,
// so a mistyped env var surfaces before anyone stakes. Works on both pools.
//   DEPLOY_TX — optional; when set, the constructor's PoolInitialized log is
//               checked too (it lives in the deploy tx block)
async function main() {
  const { pool, kind, address, chainId, weighted } = await pools.getPool();

  const expectedDuration = String(Number(process.env.END_EPOCH) - Number(process.env.ACTIVATION_EPOCH));

  const checks = [
    ["stakingToken", await pool.stakingToken(), process.env.STAKING_TOKEN],
    ["rewardToken", await pool.rewardToken(), process.env.REWARD_TOKEN],
    ["activationEpoch", (await pool.activationEpoch()).toString(), process.env.ACTIVATION_EPOCH],
    ["endEpoch", (await pool.endEpoch()).toString(), process.env.END_EPOCH],
    ["poolDuration", (await pool.poolDuration()).toString(), expectedDuration],
    ["globalLastUpdateTime", (await pool.globalLastUpdateTime()).toString(), process.env.ACTIVATION_EPOCH],
    ["MAX_PENALTY_BPS", (await pool.MAX_PENALTY_BPS()).toString(), "5000"],
    ["MIN_PENALTY_BPS", (await pool.MIN_PENALTY_BPS()).toString(), "500"],
    ["BPS_DENOMINATOR", (await pool.BPS_DENOMINATOR()).toString(), "10000"],
    ["totalStaked", (await pool.totalStaked()).toString(), "0"],
    ["totalRewards", (await pool.totalRewards()).toString(), "0"],
  ];

  if (process.env.EXPECTED_OWNER) {
    checks.push(["owner", await pool.owner(), process.env.EXPECTED_OWNER]);
  } else {
    console.log(`owner: ${await pool.owner()} (set EXPECTED_OWNER to assert it)`);
  }

  if (weighted) {
    checks.push(
      ["signer", await pool.signer(), process.env.WEIGHT_SIGNER],
      ["BASE_WEIGHT", (await pool.BASE_WEIGHT()).toString(), "1000"],
      ["MAX_WEIGHT", (await pool.MAX_WEIGHT()).toString(), "2000"]
    );
  }

  console.log(`\n${kind} @ ${address} on chain ${chainId}\n`);

  let failed = 0;
  for (const [name, got, want] of checks) {
    if (want === undefined || want === "") {
      console.log(`skip ${name.padEnd(21)} ${got}  (no expected value in env)`);
      continue;
    }
    const ok = String(got).toLowerCase() === String(want).toLowerCase();
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name.padEnd(21)} ${got}${ok ? "" : `  (expected ${want})`}`);
  }

  // PoolInitialized is emitted in the constructor, so it lives in the deploy tx
  // block. Public RPCs cap getLogs ranges, so query that one block only.
  const deployTx = process.env.DEPLOY_TX;
  if (deployTx) {
    const receipt = await hre.ethers.provider.getTransactionReceipt(deployTx);
    if (!receipt) throw new Error(`No receipt for ${deployTx}`);
    const logs = await pool.queryFilter(
      pool.filters.PoolInitialized(),
      receipt.blockNumber,
      receipt.blockNumber
    );
    if (logs.length === 1) {
      const a = logs[0].args;
      const bad = a.maxPenaltyBps !== 5000n || a.minPenaltyBps !== 500n || a.bpsDenominator !== 10000n;
      if (bad) failed++;
      console.log(
        `${bad ? "FAIL" : "ok  "} PoolInitialized       activation=${a.activationEpoch} end=${a.endEpoch} ` +
          `max=${a.maxPenaltyBps} min=${a.minPenaltyBps} denom=${a.bpsDenominator} (block ${logs[0].blockNumber})`
      );
    } else {
      failed++;
      console.log(`FAIL expected exactly 1 PoolInitialized log, found ${logs.length}`);
    }
  } else {
    console.log("\nSet DEPLOY_TX to also verify the constructor's PoolInitialized log.");
  }

  console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} CHECK(S) FAILED`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
