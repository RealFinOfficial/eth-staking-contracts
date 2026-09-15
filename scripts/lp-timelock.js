// Operator front end for the `LPTimelock` that owns the stack.
//
// Every owner-tier call on `LPStakingVault`, `RewardsDistributor`, `BonusEscrow` and
// `ApeBondPositionAdapter` — an upgrade, the zapper wiring, the stake-operator allowlist, the
// guardians, the operator, the ASSET leg, the escrow's adapter and its surplus, the SoulZap
// allowlist, and the timelock's own delay — has to go through this contract: schedule it, wait
// out `minDelay`, execute it. The TWAP calibration is NOT here: since the 2026-09-09 role split
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
// ──────────────────────── batches ────────────────────────
//
// Two more actions schedule and execute SEVERAL owner-tier calls as ONE timelock operation,
// which the contract runs in order, all or nothing. The calls come from a JSON file — an
// array of `{target, fn, args}` objects, where `target` is a registry kind or a raw address
// and `args` is an array in the function's own order:
//
//     [
//       { "target": "LPStakingVault", "fn": "upgradeToAndCall", "args": ["0xNewImpl", "0x"] },
//       { "target": "LPStakingVault", "fn": "setStakeOperator", "args": ["0xAdapter", "true"] }
//     ]
//
//   TIMELOCK_ACTION=schedule-batch TIMELOCK_BATCH=./activation.json \
//     npx hardhat run scripts/lp-timelock.js --network sepolia
//
//   TIMELOCK_ACTION=execute-batch  TIMELOCK_BATCH=./activation.json \
//     npx hardhat run scripts/lp-timelock.js --network sepolia
//
// Order and atomicity are the whole point. Activating the ApeBond route on a LIVE vault proxy
// is `upgradeToAndCall(newImplementation, 0x)` followed by `setStakeOperator(adapter, true)`,
// and the second call DOES NOT EXIST on the implementation the proxy runs before the first
// one: as two separate operations the second would be scheduled against code that has no such
// function and would revert after the delay. Inside one batch the upgrade lands first and the
// allowlist entry is written against the new code, in the same transaction.
//
// `status` and `cancel` need no batch variant — both take an id, and a batch id is an id.
// `pending` lists a batch as one row with every call under it.
//
// ──────────────────────── environment ────────────────────────
//
//   TIMELOCK_ACTION           schedule | execute | schedule-batch | execute-batch |
//                             cancel | status | pending
//   TIMELOCK_TARGET           registry kind (LPStakingVault, RewardsDistributor,
//                             TimelockController) or a raw address
//   TIMELOCK_TARGET_ADDRESS   overrides the registry lookup for the target
//   TIMELOCK_FN               one of the owner-tier functions listed in OWNER_TIER below
//   TIMELOCK_ARGS             comma-separated arguments, in the function's own order
//   TIMELOCK_BATCH            schedule-batch / execute-batch; path to the JSON file above
//   TIMELOCK_SALT_TAG         distinguishes two otherwise identical operations (see below);
//                             applies to a batch too
//   TIMELOCK_DELAY            schedule / schedule-batch; defaults to `getMinDelay()`
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
//
// A batch derives its salt the same way, from the whole list rather than from one call:
//
//     salt = keccak256(abi.encode("real.lp.timelock.v1.batch",
//                                 keccak256(abi.encode(targets, payloads)), tag))
//
// A different namespace string, so a one-call batch and the single operation that makes the
// same call can never share a salt; every value is zero, so they are not folded in.

const fs = require("fs");
const ethers = require("ethers");

// ──────────────────────── the operations this script can build ────────────────────────

/**
 * The owner tier, in full. Everything here is `onlyOwner` on a contract the timelock owns, so
 * everything here can ONLY be reached through a scheduled operation. The guardian tier (both
 * vault pauses, the distributor's `setPaused`, and the adapter's `setPurchaseSigner` and
 * `setDepositsPaused`) and the operator tier (`setTwapParams`, `rescuePosition`, `setSigner`,
 * `recoverExcessAsset`, and those same pauses) are deliberately absent: those are
 * one-transaction calls the hot key and the multisig send directly, and routing them through
 * here would defeat the reason they exist.
 *
 * `kinds` is the set of registry entries the function is legal on, which is what turns a
 * mistyped target into an error rather than a transaction that reverts after the delay.
 *
 * The same table is the whole vocabulary of a BATCH: every call in a `TIMELOCK_BATCH` file is
 * one entry from here, resolved and encoded exactly as a single operation would be, and a
 * batch may mix targets freely — the ApeBond activation is two calls on the vault, a later
 * adapter replacement is two on the vault and one on the escrow. Nothing in a batch may carry
 * ether: every value is zero, like every single operation this script builds.
 */
const OWNER_TIER = {
  acceptOwnership: {
    signature: "function acceptOwnership()",
    kinds: ["LPStakingVault", "RewardsDistributor", "BonusEscrow"],
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
    kinds: ["LPStakingVault", "RewardsDistributor", "ApeBondPositionAdapter"],
    note: "moves the undelayed pause tier to another hot key (on the adapter, its whole fast "
      + "path); on the two proxies it is owner OR operator since 2026-09-14 and takes "
      + "address(0) to revoke, on the adapter it is owner-only and zero is rejected",
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
  setAdapter: {
    signature: "function setAdapter(address newAdapter)",
    kinds: ["BonusEscrow"],
    note: "points the escrow at the adapter allowed to reserve, or at address(0) to close it",
  },
  recoverSurplus: {
    signature: "function recoverSurplus(address to)",
    kinds: ["BonusEscrow"],
    note: "moves `balance - totalReserved` out; no amount argument, so no reservation is reachable",
  },
  setSoulZapCaller: {
    signature: "function setSoulZapCaller(address caller, bool allowed)",
    kinds: ["ApeBondPositionAdapter"],
    note: "adds or removes one SoulZap contract on the depositFor allowlist",
  },
  transferOwnership: {
    signature: "function transferOwnership(address newOwner)",
    kinds: ["ApeBondPositionAdapter"],
    note:
      "hands the adapter on. Listed for the adapter ONLY: it is plain `Ownable`, so this is " +
      "the whole handover, while the Ownable2Step proxies pair it with `acceptOwnership`",
  },
  upgradeToAndCall: {
    signature: "function upgradeToAndCall(address newImplementation, bytes data)",
    kinds: ["LPStakingVault", "RewardsDistributor", "BonusEscrow"],
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
  "function scheduleBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt, uint256 delay)",
  "function executeBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt) payable",
  "function hashOperationBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt) pure returns (bytes32)",
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

/** Its own namespace, so a one-call batch and the same call alone are different operations. */
const BATCH_SALT_NAMESPACE = "real.lp.timelock.v1.batch";

/** The registry key the timelock records itself under. */
const TIMELOCK_KIND = "TimelockController";

const ACTIONS = [
  "schedule",
  "execute",
  "schedule-batch",
  "execute-batch",
  "cancel",
  "status",
  "pending",
];

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

/** Empty string means no arguments, not one empty argument. */
function splitArgs(raw) {
  if (!raw) return [];
  return raw.split(",").map((value) => value.trim());
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

// ──────────────────────── batch builders ────────────────────────

/**
 * The batch salt, documented at the top of the file: a hash of the whole call list plus an
 * optional tag, under its own namespace string. The values are not folded in because every
 * value this script builds is zero; the targets and the payloads are the operation.
 */
function deriveBatchSalt({ targets, payloads, tag = "" }) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const calls = coder.encode(
    ["address[]", "bytes[]"],
    [targets.map((target) => ethers.getAddress(target)), payloads]
  );
  return ethers.keccak256(
    coder.encode(
      ["string", "bytes32", "string"],
      [BATCH_SALT_NAMESPACE, ethers.keccak256(calls), tag]
    )
  );
}

/**
 * OZ's own `hashOperationBatch`, recomputed off-chain: `keccak256(abi.encode(targets, values,
 * payloads, predecessor, salt))`. Same reason as {operationId}: an id has to be quotable
 * before any transaction is sent, and by a third party who only has the public calldata.
 */
function batchOperationId({ targets, values, payloads, predecessor = PREDECESSOR, salt }) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address[]", "uint256[]", "bytes[]", "bytes32", "bytes32"],
      [targets.map((target) => ethers.getAddress(target)), values, payloads, predecessor, salt]
    )
  );
}

/**
 * Everything one BATCH operation is: the ordered calls, their salt, and the single id all of
 * them share. The timelock runs the calls in this order inside one transaction and reverts
 * the whole operation if any of them reverts, which is what makes an upgrade followed by a
 * call that only exists AFTER that upgrade a legal thing to schedule.
 *
 * Each op is `{target, fn, args}` — the same three operands a single operation takes — plus an
 * optional `kind`, the registry entry the target was resolved from. When a kind is given it is
 * checked against the function's own `kinds` list, exactly as the single actions check
 * `TIMELOCK_TARGET`, so a call aimed at the wrong contract is refused here rather than after
 * the delay.
 *
 * @param {Array<{target: string, fn: string, args?: Array<unknown>|string, kind?: string}>} ops
 * @param {string} tag
 */
function buildBatch(ops, tag = "") {
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new Error("A batch needs at least one call — got none");
  }

  const calls = ops.map((op, index) => {
    if (!op || typeof op !== "object" || Array.isArray(op)) {
      throw new Error(`Batch call ${index} must be an object {target, fn, args}`);
    }
    const { fn, kind } = op;
    if (!fn || !OWNER_TIER[fn]) {
      throw new Error(
        `Batch call ${index}: ${fn || "(no fn)"} is not an owner-tier function — ` +
          `one of ${Object.keys(OWNER_TIER).join(", ")}`
      );
    }
    if (kind && !OWNER_TIER[fn].kinds.includes(kind)) {
      throw new Error(
        `Batch call ${index}: ${fn} is not a function of ${kind} — ` +
          `it is legal on ${OWNER_TIER[fn].kinds.join(", ")}`
      );
    }
    if (typeof op.target !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(op.target)) {
      throw new Error(`Batch call ${index}: target must be an address — got ${op.target}`);
    }
    const args = typeof op.args === "string" ? splitArgs(op.args) : op.args || [];
    return {
      fn,
      args,
      kind,
      target: ethers.getAddress(op.target),
      value: 0n,
      data: encodeOwnerCall(fn, args),
    };
  });

  const targets = calls.map((call) => call.target);
  const values = calls.map((call) => call.value);
  const payloads = calls.map((call) => call.data);
  const salt = deriveBatchSalt({ targets, payloads, tag });

  return {
    calls,
    tag,
    targets,
    values,
    payloads,
    predecessor: PREDECESSOR,
    salt,
    id: batchOperationId({ targets, values, payloads, salt }),
  };
}

/** The `scheduleBatch(...)` calldata a Safe signs. */
function encodeScheduleBatch(batch, delay) {
  return TIMELOCK_INTERFACE.encodeFunctionData("scheduleBatch", [
    batch.targets,
    batch.values,
    batch.payloads,
    batch.predecessor,
    batch.salt,
    delay,
  ]);
}

/** The `executeBatch(...)` calldata a Safe signs once the delay has elapsed. */
function encodeExecuteBatch(batch) {
  return TIMELOCK_INTERFACE.encodeFunctionData("executeBatch", [
    batch.targets,
    batch.values,
    batch.payloads,
    batch.predecessor,
    batch.salt,
  ]);
}

/** Human-readable one-liner for one call inside a batch. */
function describeCall(call) {
  const rendered = coerceArgs(call.fn, call.args).map((value) => String(value));
  return `${call.fn}(${rendered.join(", ")}) on ${call.target}`;
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

  if (action === "schedule-batch" || action === "execute-batch") {
    // schedule-batch / execute-batch — same file, same operation, same rules as the single
    // pair above: print the operands and the calldata a Safe would sign, then send.
    const batch = buildBatch(
      readBatchFile().map((entry, index) => resolveBatchEntry(pools, chainId, entry, index)),
      process.env.TIMELOCK_SALT_TAG || ""
    );

    console.log(
      `\nBatch of ${batch.calls.length} call(s)` + (batch.tag ? ` [tag ${batch.tag}]` : "")
    );
    batch.calls.forEach((call, index) => {
      console.log(`  ${index}. ${describeCall(call)}`);
      console.log(`     calldata: ${call.data}`);
    });
    console.log(`  predecessor: ${batch.predecessor}`);
    console.log(`  salt:        ${batch.salt}`);
    console.log(`  id:          ${batch.id}`);

    const batchSigner = await pools.getSigner();

    if (action === "schedule-batch") {
      const delay = resolveDelay(minDelay);
      console.log(`  scheduleBatch calldata: ${encodeScheduleBatch(batch, delay)}`);
      pools.requireConfirmation(chainId, `schedule batch ${batch.id}`);
      await pools.send(
        `Scheduling a batch of ${batch.calls.length} (delay ${delay}s)`,
        batchSigner,
        (o) =>
          timelock
            .connect(batchSigner)
            .scheduleBatch(
              batch.targets,
              batch.values,
              batch.payloads,
              batch.predecessor,
              batch.salt,
              delay,
              o
            )
      );
      await reportStatus(timelock, batch.id, minDelay);
      return;
    }

    console.log(`  executeBatch calldata:  ${encodeExecuteBatch(batch)}`);
    await reportStatus(timelock, batch.id, minDelay);
    pools.requireConfirmation(chainId, `execute batch ${batch.id}`);
    await pools.send(`Executing a batch of ${batch.calls.length}`, batchSigner, (o) =>
      timelock
        .connect(batchSigner)
        .executeBatch(batch.targets, batch.values, batch.payloads, batch.predecessor, batch.salt, o)
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
    const delay = resolveDelay(minDelay);
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

/** The delay a schedule asks for: the timelock's own minimum unless told otherwise, never less. */
function resolveDelay(minDelay) {
  const delay = process.env.TIMELOCK_DELAY ? BigInt(process.env.TIMELOCK_DELAY) : minDelay;
  if (delay < minDelay) {
    throw new Error(`TIMELOCK_DELAY ${delay} is below the timelock's minDelay ${minDelay}`);
  }
  return delay;
}

/** The `TIMELOCK_BATCH` file, parsed and checked to be the array of call objects it must be. */
function readBatchFile() {
  const filePath = process.env.TIMELOCK_BATCH;
  if (!filePath) {
    throw new Error(
      'Set TIMELOCK_BATCH to a JSON file holding [{"target": …, "fn": …, "args": [ … ]}, …]'
    );
  }
  if (!fs.existsSync(filePath)) throw new Error(`No batch file at ${filePath}`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${filePath} is not valid JSON — ${error.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${filePath} must hold a JSON ARRAY of {target, fn, args} objects`);
  }
  if (parsed.length === 0) throw new Error(`${filePath} holds no calls — a batch needs at least one`);
  return parsed;
}

/**
 * One entry of the batch file, turned into the `{target, fn, args, kind}` shape {@link
 * buildBatch} takes. `target` is a registry kind or a raw address, the same choice
 * `TIMELOCK_TARGET` / `TIMELOCK_TARGET_ADDRESS` offer a single operation — a value that looks
 * like a 20-byte address is used as one, anything else is looked up in the registry and is
 * checked against the function's own `kinds` list first.
 */
function resolveBatchEntry(pools, chainId, entry, index) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`Batch call ${index} must be an object {target, fn, args}`);
  }
  const fn = entry.fn;
  if (!fn || !OWNER_TIER[fn]) {
    throw new Error(
      `Batch call ${index}: ${fn || "(no fn)"} is not an owner-tier function — ` +
        `one of ${Object.keys(OWNER_TIER).join(", ")}`
    );
  }
  const target = entry.target;
  if (typeof target !== "string" || target.length === 0) {
    throw new Error(
      `Batch call ${index}: set "target" to one of ${OWNER_TIER[fn].kinds.join(", ")} ` +
        `or to a raw address`
    );
  }
  if (/^0x[0-9a-fA-F]{40}$/.test(target)) {
    return { target: ethers.getAddress(target), fn, args: entry.args };
  }
  if (!OWNER_TIER[fn].kinds.includes(target)) {
    throw new Error(
      `Batch call ${index}: ${fn} is not a function of ${target} — ` +
        `it is legal on ${OWNER_TIER[fn].kinds.join(", ")}`
    );
  }
  const address = pools.registryAddress(chainId, target);
  if (!address) {
    throw new Error(
      `Batch call ${index}: no ${target} recorded for chain ${chainId} in deployments.json — ` +
        `put a raw address in "target" instead`
    );
  }
  return { target: ethers.getAddress(address), fn, args: entry.args, kind: target };
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

  // A batch emits one `CallScheduled` per call, all carrying the SAME id and an `index` that
  // counts them, so the logs are grouped by id first: one row per operation, every call of it
  // listed underneath in the order the timelock will run them.
  const byId = new Map();
  for (const log of logs) {
    if (!byId.has(log.args.id)) byId.set(log.args.id, []);
    byId.get(log.args.id).push(log);
  }

  console.log(`\n${byId.size} scheduled operation(s) since block ${fromBlock}:`);
  for (const [id, calls] of byId) {
    const timestamp = await timelock.getTimestamp(id);
    const state =
      timestamp === 0n ? "CANCELLED" : timestamp === 1n ? "DONE" : (await timelock.isOperationReady(id)) ? "READY" : "PENDING";
    const first = calls[0];
    console.log(
      `  ${state.padEnd(9)} ${id}` +
        (calls.length > 1 ? `  (batch of ${calls.length})` : "") +
        `\n    scheduled in block ${first.blockNumber}` +
        (timestamp > 1n ? `  readyAt ${timestamp} (${new Date(Number(timestamp) * 1000).toISOString()})` : "")
    );
    for (const log of calls) {
      let label = "unknown call";
      try {
        const parsed = OWNER_TIER_INTERFACE.parseTransaction({ data: log.args.data });
        if (parsed) label = `${parsed.name}(${parsed.args.map(String).join(", ")})`;
      } catch {
        label = `raw ${log.args.data.slice(0, 10)}`;
      }
      console.log(`    ${log.args.index}. ${label}\n       target ${log.args.target}`);
    }
  }
}

module.exports = {
  OWNER_TIER,
  OWNER_TIER_INTERFACE,
  TIMELOCK_INTERFACE,
  TIMELOCK_KIND,
  PREDECESSOR,
  SALT_NAMESPACE,
  BATCH_SALT_NAMESPACE,
  encodeOwnerCall,
  deriveSalt,
  operationId,
  buildOperation,
  encodeSchedule,
  encodeExecute,
  encodeCancel,
  describeOperation,
  deriveBatchSalt,
  batchOperationId,
  buildBatch,
  encodeScheduleBatch,
  encodeExecuteBatch,
  describeCall,
  resolveBatchEntry,
};

// `hardhat run` executes this file as the entry point; a `require` from the fork suites must
// only pick up the builders above.
if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
