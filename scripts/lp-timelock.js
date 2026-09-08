// Operator front end for the `LPTimelock` that owns the two UUPS proxies.
//
// Every owner-tier call on `LPStakingVault` and `RewardsDistributor` — an upgrade, the zapper
// wiring, the stake-operator allowlist, the guardian, the operator, the ASSET leg, and the
// timelock's own delay — has to go through this contract: schedule it, wait out `minDelay`,
// execute it. The TWAP calibration is NOT here: since the 2026-09-09 role split
// `setTwapParams` is operator-tier, sent directly by the multisig with no delay. This script
// is the one place that builds those three transactions, so the calldata a Safe signs and the
// calldata the fork suites send are produced by the same code.
//
// ──────────────────────── how to run it ────────────────────────
//
// `hardhat run` accepts no positional arguments of its own (it rewrites `process.argv` to
// `[node, script]`), so the subcommand and its operands arrive as environment variables —
// the same convention every other script in this repo uses for its inputs:
//
//   TIMELOCK_ACTION=schedule TIMELOCK_TARGET=LPStakingVault TIMELOCK_FN=setGuardian \
//     TIMELOCK_ARGS=0xNewGuardian npx hardhat run scripts/lp-timelock.js --network sepolia
//
//   TIMELOCK_ACTION=execute  TIMELOCK_TARGET=LPStakingVault TIMELOCK_FN=setGuardian \
//     TIMELOCK_ARGS=0xNewGuardian npx hardhat run scripts/lp-timelock.js --network sepolia
//
//   TIMELOCK_ACTION=status  TIMELOCK_ID=0x… npx hardhat run scripts/lp-timelock.js --network sepolia
//   TIMELOCK_ACTION=cancel  TIMELOCK_ID=0x… npx hardhat run scripts/lp-timelock.js --network sepolia
//   TIMELOCK_ACTION=pending                 npx hardhat run scripts/lp-timelock.js --network sepolia
//
// `schedule` and `execute` take the SAME operands. That is deliberate: the operation id is a
// hash of the whole call tuple, so an execute that names a different argument than its
// schedule cannot be a typo that goes through — it is a different operation that does not
// exist.
//
// ──────────────────────── environment ────────────────────────
//
//   TIMELOCK_ACTION           schedule | execute | cancel | status | pending
//   TIMELOCK_TARGET           registry kind (LPStakingVault, RewardsDistributor,
//                             TimelockController) or a raw address
//   TIMELOCK_TARGET_ADDRESS   overrides the registry lookup for the target
//   TIMELOCK_FN               one of the owner-tier functions listed in OWNER_TIER below
//   TIMELOCK_ARGS             comma-separated arguments, in the function's own order
//   TIMELOCK_SALT_TAG         distinguishes two otherwise identical operations (see below)
//   TIMELOCK_DELAY            schedule only; defaults to the timelock's `getMinDelay()`
//   TIMELOCK_ID               cancel / status
//   TIMELOCK_ADDRESS          overrides the registry lookup for the timelock itself
//   CONFIRM=yes               required on mainnet, like every other state-changing script
//
// ──────────────────────── the salt, and why it is derived ────────────────────────
//
// OpenZeppelin identifies an operation by `keccak256(abi.encode(target, value, data,
// predecessor, salt))`. Deriving the salt from the call itself
//
//     salt = keccak256(abi.encode("real.lp.timelock.v1", target, keccak256(data), tag))
//
// makes the id reproducible from nothing but the operands: schedule and execute agree without
// anyone having to write the salt down, and a third party can recompute the id of a pending
// operation from the public calldata alone. `predecessor` is always zero — this repo has no
// ordered operation chains.
//
// The cost of a derived salt is that the SAME call cannot be scheduled twice: once an
// operation is executed its state is `Done`, and OZ refuses to schedule a `Done` id again.
// `TIMELOCK_SALT_TAG` is the escape hatch — any string that has not been used before for that
// exact call produces a fresh id. Set it whenever an identical call has to run a second time
// (rotating the guardian back, re-pausing a leg, re-applying a parameter).

const ethers = require("ethers");

// ──────────────────────── the operations this script can build ────────────────────────

/**
 * The owner tier, in full. Everything here is `onlyOwner` on a contract the timelock owns, so
 * everything here can ONLY be reached through a scheduled operation. The guardian tier (both
 * vault pauses, the distributor's `setPaused`) and the operator tier (`setTwapParams`,
 * `rescuePosition`, `setSigner`, `recoverExcessAsset`, and those same pauses) are deliberately
 * absent: those are one-transaction calls the hot key and the multisig send directly, and
 * routing them through here would defeat the reason they exist.
 *
 * `kinds` is the set of registry entries the function is legal on, which is what turns a
 * mistyped target into an error rather than a transaction that reverts after the delay.
 */
const OWNER_TIER = {
  acceptOwnership: {
    signature: "function acceptOwnership()",
    kinds: ["LPStakingVault", "RewardsDistributor"],
    note: "the second half of the Ownable2Step handover; the timelock's first operation",
  },
  setZapper: {
    signature: "function setZapper(address newZapper)",
    kinds: ["LPStakingVault"],
    note: "points the deposit path at a new periphery contract, or at address(0) to close it",
  },
  setStakeOperator: {
    signature: "function setStakeOperator(address stakeOperator, bool allowed)",
    kinds: ["LPStakingVault"],
    note: "adds or removes one trusted periphery contract on the `stakeFor` allowlist",
  },
  setGuardian: {
    signature: "function setGuardian(address newGuardian)",
    kinds: ["LPStakingVault", "RewardsDistributor"],
    note: "moves the undelayed pause tier to another hot key",
  },
  setOperator: {
    signature: "function setOperator(address newOperator)",
    kinds: ["LPStakingVault", "RewardsDistributor"],
    note: "moves the undelayed routine-operations tier to another multisig",
  },
  setAssetClaimsEnabled: {
    signature: "function setAssetClaimsEnabled(bool enabled)",
    kinds: ["RewardsDistributor"],
    note: "switches the whole ASSET reward leg on or off",
  },
  upgradeToAndCall: {
    signature: "function upgradeToAndCall(address newImplementation, bytes data)",
    kinds: ["LPStakingVault", "RewardsDistributor"],
    note: "the upgrade itself; `data` is the reinitializer call, or 0x for none",
  },
  updateDelay: {
    signature: "function updateDelay(uint256 newDelay)",
    kinds: ["TimelockController"],
    note: "shortening the delay is itself a delayed, publicly visible operation",
  },
};

const OWNER_TIER_INTERFACE = new ethers.Interface(
  Object.values(OWNER_TIER).map((spec) => spec.signature)
);

/** The timelock surface this script sends and reads. Stock OZ v5; `LPTimelock` adds nothing. */
const TIMELOCK_INTERFACE = new ethers.Interface([
  "function schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay)",
  "function execute(address target, uint256 value, bytes payload, bytes32 predecessor, bytes32 salt) payable",
  "function cancel(bytes32 id)",
  "function getMinDelay() view returns (uint256)",
  "function getTimestamp(bytes32 id) view returns (uint256)",
  "function isOperation(bytes32 id) view returns (bool)",
  "function isOperationPending(bytes32 id) view returns (bool)",
  "function isOperationReady(bytes32 id) view returns (bool)",
  "function isOperationDone(bytes32 id) view returns (bool)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function PROPOSER_ROLE() view returns (bytes32)",
  "function EXECUTOR_ROLE() view returns (bytes32)",
  "function CANCELLER_ROLE() view returns (bytes32)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)",
  "event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)",
  "event Cancelled(bytes32 indexed id)",
  "event MinDelayChange(uint256 oldDuration, uint256 newDuration)",
]);

/** This repo schedules no ordered chains, so an operation never waits on another one. */
const PREDECESSOR = ethers.ZeroHash;

/** Namespaced so a salt from this repo can never collide with one from another tool. */
const SALT_NAMESPACE = "real.lp.timelock.v1";

/** The registry key the timelock records itself under. */
const TIMELOCK_KIND = "TimelockController";

const ACTIONS = ["schedule", "execute", "cancel", "status", "pending"];

// ──────────────────────── builders (pure; the suites import these) ────────────────────────

/**
 * Coerces string operands — everything that arrives through the environment is a string —
 * into the types the fragment declares. Anything already typed is passed through untouched,
 * which is how the fork suites hand in a BigInt or an address object.
 */
function coerceArgs(fn, args) {
  const fragment = OWNER_TIER_INTERFACE.getFunction(fn);
  if (args.length !== fragment.inputs.length) {
    throw new Error(
      `${fn} takes ${fragment.inputs.length} argument(s) ` +
        `(${fragment.inputs.map((i) => `${i.type} ${i.name}`).join(", ") || "none"}) — got ${args.length}`
    );
  }
  return fragment.inputs.map((input, index) => {
    const raw = args[index];
    if (typeof raw !== "string") return raw;
    if (input.type === "bool") {
      if (raw === "true") return true;
      if (raw === "false") return false;
      throw new Error(`${fn} argument ${index} (${input.name}) must be true or false — got ${raw}`);
    }
    if (input.type.startsWith("uint") || input.type.startsWith("int")) return BigInt(raw);
    return raw;
  });
}

/** ABI-encodes one owner-tier call. */
function encodeOwnerCall(fn, args = []) {
  if (!OWNER_TIER[fn]) {
    throw new Error(`${fn} is not an owner-tier function — one of ${Object.keys(OWNER_TIER).join(", ")}`);
  }
  return OWNER_TIER_INTERFACE.encodeFunctionData(fn, coerceArgs(fn, args));
}

/**
 * The salt this repo uses, documented at the top of the file: a hash of the call itself plus
 * an optional tag, so schedule and execute agree without carrying a value between them.
 */
function deriveSalt({ target, data, tag = "" }) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "address", "bytes32", "string"],
      [SALT_NAMESPACE, ethers.getAddress(target), ethers.keccak256(data), tag]
    )
  );
}

/**
 * OZ's own `hashOperation`, recomputed off-chain: `keccak256(abi.encode(target, value, data,
 * predecessor, salt))`. Recomputing rather than calling the contract means an id can be
 * quoted before the timelock exists — which the deploy script needs, since it prints the
 * mainnet Safe payloads in the same run that deploys the timelock.
 */
function operationId({ target, value = 0n, data, predecessor = PREDECESSOR, salt }) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256", "bytes", "bytes32", "bytes32"],
      [ethers.getAddress(target), value, data, predecessor, salt]
    )
  );
}

/**
 * Everything one operation is: the call, its salt, and its id. The single object that
 * `schedule`, `execute` and `cancel` all read from, so the three can never disagree.
 *
 * @param {{target: string, fn: string, args?: Array<unknown>, tag?: string, value?: bigint}} spec
 */
function buildOperation({ target, fn, args = [], tag = "", value = 0n }) {
  const data = encodeOwnerCall(fn, args);
  const salt = deriveSalt({ target, data, tag });
  return {
    fn,
    args,
    tag,
    target: ethers.getAddress(target),
    value,
    data,
    predecessor: PREDECESSOR,
    salt,
    id: operationId({ target, value, data, salt }),
  };
}

/** The `schedule(...)` calldata a Safe signs. */
function encodeSchedule(op, delay) {
  return TIMELOCK_INTERFACE.encodeFunctionData("schedule", [
    op.target,
    op.value,
    op.data,
    op.predecessor,
    op.salt,
    delay,
  ]);
}

/** The `execute(...)` calldata a Safe signs once the delay has elapsed. */
function encodeExecute(op) {
  return TIMELOCK_INTERFACE.encodeFunctionData("execute", [
    op.target,
    op.value,
    op.data,
    op.predecessor,
    op.salt,
  ]);
}

/** The `cancel(id)` calldata. Any canceller — here, the multisig — may send it. */
function encodeCancel(id) {
  return TIMELOCK_INTERFACE.encodeFunctionData("cancel", [id]);
}

/** Human-readable one-liner for an operation, used by the CLI and by the deploy script. */
function describeOperation(op) {
  const rendered = coerceArgs(op.fn, op.args).map((value) => String(value));
  return `${op.fn}(${rendered.join(", ")}) on ${op.target}` + (op.tag ? ` [tag ${op.tag}]` : "");
}

// ──────────────────────── the CLI ────────────────────────

async function main() {
  const hre = require("hardhat");
  const pools = require("./lib/pools");

  const chainId = await pools.chainId();
  const action = process.env.TIMELOCK_ACTION;
  if (!ACTIONS.includes(action)) {
    throw new Error(`Set TIMELOCK_ACTION to one of ${ACTIONS.join(", ")}`);
  }

  const timelockAddress =
    process.env.TIMELOCK_ADDRESS || pools.registryAddress(chainId, TIMELOCK_KIND);
  if (!timelockAddress) {
    throw new Error(
      `No ${TIMELOCK_KIND} recorded for chain ${chainId} in deployments.json — ` +
        `set TIMELOCK_ADDRESS=<address> instead`
    );
  }
  const code = await hre.ethers.provider.getCode(timelockAddress);
  if (code === "0x") throw new Error(`No contract code at ${timelockAddress} on chain ${chainId}`);

  const timelock = new hre.ethers.Contract(
    timelockAddress,
    TIMELOCK_INTERFACE,
    hre.ethers.provider
  );
  const minDelay = await timelock.getMinDelay();

  console.log(`Timelock:  ${timelockAddress}`);
  console.log(`  ${pools.explorerAddress(chainId, timelockAddress)}`);
  console.log(`minDelay:  ${minDelay}s`);

  if (action === "pending") return listPending(hre, pools, timelock, chainId);
  if (action === "status") return reportStatus(timelock, requireId(), minDelay);

  if (action === "cancel") {
    const id = requireId();
    await reportStatus(timelock, id, minDelay);
    pools.requireConfirmation(chainId, `cancel timelock operation ${id}`);
    const signer = await pools.getSigner();
    await pools.send(`Cancelling ${id}`, signer, (o) =>
      timelock.connect(signer).cancel(id, o)
    );
    return;
  }

  // schedule / execute — same operands, same operation.
  const op = buildOperation({
    target: await resolveTarget(hre, pools, chainId),
    fn: requireFunction(),
    args: splitArgs(process.env.TIMELOCK_ARGS),
    tag: process.env.TIMELOCK_SALT_TAG || "",
  });

  console.log(`\nOperation: ${describeOperation(op)}`);
  console.log(`  calldata:    ${op.data}`);
  console.log(`  predecessor: ${op.predecessor}`);
  console.log(`  salt:        ${op.salt}`);
  console.log(`  id:          ${op.id}`);

  const signer = await pools.getSigner();

  if (action === "schedule") {
    const delay = process.env.TIMELOCK_DELAY ? BigInt(process.env.TIMELOCK_DELAY) : minDelay;
    if (delay < minDelay) {
      throw new Error(`TIMELOCK_DELAY ${delay} is below the timelock's minDelay ${minDelay}`);
    }
    console.log(`  schedule calldata: ${encodeSchedule(op, delay)}`);
    pools.requireConfirmation(chainId, `schedule ${describeOperation(op)}`);
    await pools.send(`Scheduling ${op.fn} (delay ${delay}s)`, signer, (o) =>
      timelock.connect(signer).schedule(op.target, op.value, op.data, op.predecessor, op.salt, delay, o)
    );
    await reportStatus(timelock, op.id, minDelay);
    return;
  }

  console.log(`  execute calldata:  ${encodeExecute(op)}`);
  await reportStatus(timelock, op.id, minDelay);
  pools.requireConfirmation(chainId, `execute ${describeOperation(op)}`);
  await pools.send(`Executing ${op.fn}`, signer, (o) =>
    timelock.connect(signer).execute(op.target, op.value, op.data, op.predecessor, op.salt, o)
  );
}

function requireId() {
  const id = process.env.TIMELOCK_ID;
  if (!id || !/^0x[0-9a-fA-F]{64}$/.test(id)) {
    throw new Error("Set TIMELOCK_ID to the 32-byte operation id");
  }
  return id.toLowerCase();
}

function requireFunction() {
  const fn = process.env.TIMELOCK_FN;
  if (!fn) throw new Error(`Set TIMELOCK_FN to one of ${Object.keys(OWNER_TIER).join(", ")}`);
  if (!OWNER_TIER[fn]) {
    throw new Error(`TIMELOCK_FN ${fn} is not owner-tier — one of ${Object.keys(OWNER_TIER).join(", ")}`);
  }
  return fn;
}

/** Empty string means no arguments, not one empty argument. */
function splitArgs(raw) {
  if (!raw) return [];
  return raw.split(",").map((value) => value.trim());
}

/**
 * The target, by registry kind or by address. The kind is checked against the function's own
 * `kinds` list, so `setAssetClaimsEnabled` aimed at the vault fails here rather than after
 * the delay.
 */
async function resolveTarget(hre, pools, chainId) {
  const fn = requireFunction();
  const explicit = process.env.TIMELOCK_TARGET_ADDRESS;
  if (explicit) return hre.ethers.getAddress(explicit);

  const kind = process.env.TIMELOCK_TARGET;
  if (!kind) {
    throw new Error(
      `Set TIMELOCK_TARGET to one of ${OWNER_TIER[fn].kinds.join(", ")}, ` +
        `or TIMELOCK_TARGET_ADDRESS to a raw address`
    );
  }
  if (!OWNER_TIER[fn].kinds.includes(kind)) {
    throw new Error(`${fn} is not a function of ${kind} — it is legal on ${OWNER_TIER[fn].kinds.join(", ")}`);
  }
  const address = kind === TIMELOCK_KIND
    ? pools.registryAddress(chainId, TIMELOCK_KIND)
    : pools.registryAddress(chainId, kind);
  if (!address) {
    throw new Error(
      `No ${kind} recorded for chain ${chainId} in deployments.json — ` +
        `set TIMELOCK_TARGET_ADDRESS=<address> instead`
    );
  }
  return hre.ethers.getAddress(address);
}

/**
 * `getTimestamp` tells the whole story: 0 unset, 1 done, anything else is the ready-at.
 *
 * The countdown is measured against the CHAIN's latest block timestamp, not the local clock:
 * that is the value `execute` compares against, and on a fork the two can be days apart.
 */
async function reportStatus(timelock, id, minDelay) {
  const timestamp = await timelock.getTimestamp(id);
  console.log(`\nOperation ${id}`);
  if (timestamp === 0n) {
    console.log("  state:   UNSET — never scheduled, or cancelled");
    return { state: "unset", readyAt: null };
  }
  if (timestamp === 1n) {
    console.log("  state:   DONE — already executed");
    return { state: "done", readyAt: null };
  }
  const ready = await timelock.isOperationReady(id);
  const readyAt = new Date(Number(timestamp) * 1000).toISOString();
  console.log(`  state:   ${ready ? "READY" : "PENDING"}`);
  console.log(`  readyAt: ${timestamp} (${readyAt})`);
  if (!ready) {
    const now = (await timelock.runner.provider.getBlock("latest")).timestamp;
    console.log(
      `  waits:   ${Number(timestamp) - now}s more (chain time ${now}, minDelay ${minDelay}s)`
    );
  }
  return { state: ready ? "ready" : "pending", readyAt: timestamp };
}

/**
 * Every operation the timelock has ever been told about, with its current state.
 *
 * OZ stores one timestamp per id and enumerates nothing, so the list has to come from the
 * logs: `CallScheduled` from the timelock's own deploy block forward, then one `getTimestamp`
 * per id. The deploy block comes out of the registry; without it the scan starts at 0, which
 * a public endpoint may refuse for a wide range.
 */
async function listPending(hre, pools, timelock, chainId) {
  const entry = pools.readRegistry()[String(chainId)] || {};
  const fromBlock = entry[TIMELOCK_KIND] ? entry[TIMELOCK_KIND].block : 0;
  const logs = await timelock.queryFilter("CallScheduled", fromBlock, "latest");

  if (logs.length === 0) {
    console.log(`\nNo CallScheduled logs since block ${fromBlock}.`);
    return;
  }

  console.log(`\n${logs.length} scheduled operation(s) since block ${fromBlock}:`);
  const seen = new Set();
  for (const log of logs) {
    const id = log.args.id;
    if (seen.has(id)) continue; // a batch schedules one log per call, all under one id
    seen.add(id);

    const timestamp = await timelock.getTimestamp(id);
    const state =
      timestamp === 0n ? "CANCELLED" : timestamp === 1n ? "DONE" : (await timelock.isOperationReady(id)) ? "READY" : "PENDING";
    let label = "unknown call";
    try {
      const parsed = OWNER_TIER_INTERFACE.parseTransaction({ data: log.args.data });
      if (parsed) label = `${parsed.name}(${parsed.args.map(String).join(", ")})`;
    } catch {
      label = `raw ${log.args.data.slice(0, 10)}`;
    }
    console.log(
      `  ${state.padEnd(9)} ${id}\n` +
        `    ${label}\n` +
        `    target ${log.args.target}  scheduled in block ${log.blockNumber}` +
        (timestamp > 1n ? `  readyAt ${timestamp} (${new Date(Number(timestamp) * 1000).toISOString()})` : "")
    );
  }
}

module.exports = {
  OWNER_TIER,
  OWNER_TIER_INTERFACE,
  TIMELOCK_INTERFACE,
  TIMELOCK_KIND,
  PREDECESSOR,
  SALT_NAMESPACE,
  encodeOwnerCall,
  deriveSalt,
  operationId,
  buildOperation,
  encodeSchedule,
  encodeExecute,
  encodeCancel,
  describeOperation,
};

// `hardhat run` executes this file as the entry point; a `require` from the fork suites must
// only pick up the builders above.
if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
