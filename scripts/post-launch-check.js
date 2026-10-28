const hre = require("hardhat");
const pools = require("./lib/pools");

// The three checks before launch (krumbgf's item 12 of 27 Oct 2026, the mainnet bootstrap with a
// short timelock delay). READ-ONLY: it sends nothing and needs no key.
//
// The mainnet LPTimelock may be deployed with a short LP_TIMELOCK_MIN_DELAY so every batch runs
// in minutes, and `updateDelay(172800)` is then the LAST operation. Before the frontend points to
// mainnet, before the ApeBond route goes live and before any announcement, three facts must hold:
//
//   1. NO PENDING OPERATION. Every `CallScheduled` id on the timelock has a `CallExecuted` or a
//      `Cancelled`. OpenZeppelin operations never expire and keep the short ready time they were
//      scheduled with, even after `updateDelay`, so a leftover one could execute later without the
//      48 h notice. The logs are scanned from the timelock's deployment block in chunks of at most
//      10,000 blocks (the Infura `eth_getLogs` cap), and every id that looks pending is confirmed
//      with `isOperationPending`.
//   2. `getMinDelay() == LP_EXPECTED_MIN_DELAY` (172800 = 48 h). The `MinDelayChange` event is the
//      proof for ApeBond; the script prints the last one.
//   3. THE DEPLOYER KEY HOLDS NOTHING. It has no timelock role (proposer, executor, canceller,
//      admin), and it is not `owner`, `pendingOwner`, `guardian` or `operator` of any LP contract:
//      the five proxies, the escrow, the adapter and every recorded reward token.
//
// ──────────────────────── environment ────────────────────────
//
//   LP_DEPLOYER             the deploying key's ADDRESS (default: the configured signer's address)
//   LP_EXPECTED_MIN_DELAY   the delay the timelock must have (172800)
//   LP_LOG_CHUNK_BLOCKS     log scan chunk, at most 10,000 (10000)
//   LP_LOG_FROM_BLOCK       first block to scan (default: the timelock's recorded deployment block)
//   DEPLOYMENTS_FILE        redirects the registry, like every other script here
//
//     LP_DEPLOYER=0x… npx hardhat run scripts/post-launch-check.js --network mainnet

const TIMELOCK_KIND = "TimelockController";
const LP_KINDS = ["TokenOverture", "RewardsDistributor", "LPEpochRegistry", "LPStakingVault", "LPZapper"];
const OPTIONAL_KINDS = ["BonusEscrow", "ApeBondPositionAdapter"];
const REWARD_TOKEN_PREFIX = "RewardToken:";
const DEFAULT_MIN_DELAY = 172800n;
const MAX_LOG_CHUNK = 10_000;

const TIMELOCK_ABI = [
  "function getMinDelay() view returns (uint256)",
  "function isOperationPending(bytes32 id) view returns (bool)",
  "function getTimestamp(bytes32 id) view returns (uint256)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function PROPOSER_ROLE() view returns (bytes32)",
  "function EXECUTOR_ROLE() view returns (bytes32)",
  "function CANCELLER_ROLE() view returns (bytes32)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)",
  "event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)",
  "event Cancelled(bytes32 indexed id)",
  "event MinDelayChange(uint256 oldDuration, uint256 newDuration)",
];
const ROLE_GETTERS = ["owner", "pendingOwner", "guardian", "operator"];
const ROLE_ABI = ROLE_GETTERS.map((name) => `function ${name}() view returns (address)`);

function readBig(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^[0-9]+$/.test(raw.trim())) throw new Error(`${name} must be a non-negative integer — got ${raw}`);
  return BigInt(raw.trim());
}

/** Every log of `topic` on `address` in [from, to], in chunks of at most `chunk` blocks. */
async function scanLogs(address, topic, from, to, chunk) {
  const logs = [];
  for (let start = from; start <= to; start += chunk) {
    const end = Math.min(start + chunk - 1, to);
    logs.push(...(await hre.ethers.provider.getLogs({ address, topics: [topic], fromBlock: start, toBlock: end })));
  }
  return logs;
}

async function main() {
  const chainId = await pools.chainId();
  const registry = pools.readRegistry()[String(chainId)] || {};
  const timelockEntry = registry[TIMELOCK_KIND];
  if (!timelockEntry) throw new Error(`Chain ${chainId} has no ${TIMELOCK_KIND} entry in the deployment registry`);
  const timelockAddress = hre.ethers.getAddress(timelockEntry.address);
  const timelock = new hre.ethers.Contract(timelockAddress, TIMELOCK_ABI, hre.ethers.provider);

  let deployer = process.env.LP_DEPLOYER;
  if (!deployer) deployer = (await pools.getSigner()).address;
  deployer = hre.ethers.getAddress(deployer);
  const expectedDelay = readBig("LP_EXPECTED_MIN_DELAY", DEFAULT_MIN_DELAY);
  const chunk = Number(readBig("LP_LOG_CHUNK_BLOCKS", BigInt(MAX_LOG_CHUNK)));
  if (chunk < 1 || chunk > MAX_LOG_CHUNK) throw new Error(`LP_LOG_CHUNK_BLOCKS must be 1..${MAX_LOG_CHUNK} — got ${chunk}`);
  const latest = await hre.ethers.provider.getBlockNumber();
  const fromBlock = Number(readBig("LP_LOG_FROM_BLOCK", BigInt(timelockEntry.block || 0)));

  console.log(`Post-launch check on chain ${chainId} (read-only)`);
  console.log(`Timelock:   ${timelockAddress}`);
  console.log(`Deployer:   ${deployer}`);
  console.log(`Log scan:   blocks ${fromBlock}..${latest} in chunks of ${chunk}`);

  const failures = [];
  const report = (ok, label) => {
    console.log(`${ok ? "OK  " : "FAIL"}  ${label}`);
    if (!ok) failures.push(label);
  };

  // ──────── 1. no pending operation ────────
  console.log("\n1. No pending timelock operation");
  const iface = timelock.interface;
  const ids = (logs) => logs.map((log) => iface.parseLog(log).args.id);
  const scheduled = new Set(ids(await scanLogs(timelockAddress, iface.getEvent("CallScheduled").topicHash, fromBlock, latest, chunk)));
  const executed = new Set(ids(await scanLogs(timelockAddress, iface.getEvent("CallExecuted").topicHash, fromBlock, latest, chunk)));
  const cancelled = new Set(ids(await scanLogs(timelockAddress, iface.getEvent("Cancelled").topicHash, fromBlock, latest, chunk)));
  const open = [...scheduled].filter((id) => !executed.has(id) && !cancelled.has(id));
  console.log(
    `  ${scheduled.size} operation(s) scheduled, ${executed.size} executed, ${cancelled.size} cancelled`
  );
  for (const id of open) {
    const pending = await timelock.isOperationPending(id);
    console.log(`  open: ${id} (isOperationPending ${pending}, ready at ${await timelock.getTimestamp(id)})`);
  }
  report(open.length === 0, `every CallScheduled id has a CallExecuted or a Cancelled (${open.length} open)`);

  // ──────── 2. the delay ────────
  console.log("\n2. The timelock delay");
  const delay = await timelock.getMinDelay();
  const changes = await scanLogs(timelockAddress, iface.getEvent("MinDelayChange").topicHash, fromBlock, latest, chunk);
  if (changes.length > 0) {
    const last = changes[changes.length - 1];
    const args = iface.parseLog(last).args;
    console.log(`  last MinDelayChange: ${args.oldDuration} -> ${args.newDuration} (block ${last.blockNumber}, tx ${last.transactionHash})`);
  } else {
    console.log("  no MinDelayChange since the scanned block: the delay is the one the timelock was deployed with");
  }
  report(delay === expectedDelay, `getMinDelay() == ${expectedDelay} (is ${delay})`);

  // ──────── 3. the deployer key holds nothing ────────
  console.log("\n3. The deployer key holds nothing");
  for (const roleName of ["PROPOSER_ROLE", "EXECUTOR_ROLE", "CANCELLER_ROLE", "DEFAULT_ADMIN_ROLE"]) {
    const has = await timelock.hasRole(await timelock[roleName](), deployer);
    report(!has, `LPTimelock.${roleName} not held by the deployer`);
  }
  const kinds = [
    ...LP_KINDS,
    ...OPTIONAL_KINDS.filter((kind) => registry[kind]),
    ...Object.keys(registry).filter((kind) => kind.startsWith(REWARD_TOKEN_PREFIX)).sort(),
  ];
  for (const kind of kinds) {
    if (!registry[kind]) {
      report(false, `${kind}: not in the deployment registry`);
      continue;
    }
    const address = hre.ethers.getAddress(registry[kind].address);
    const contract = new hre.ethers.Contract(address, ROLE_ABI, hre.ethers.provider);
    for (const getter of ROLE_GETTERS) {
      let holder;
      try {
        holder = hre.ethers.getAddress(await contract[getter]());
      } catch {
        continue; // this contract has no such seat
      }
      report(holder !== deployer, `${kind}.${getter}() is not the deployer (${holder})`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`\nThe post-launch check failed for ${failures.length} item(s): ${failures.join("; ")}.`);
  }
  console.log("\nAll post-launch checks passed.");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
