const hre = require("hardhat");
const pools = require("./lib/pools");
const { deployContract } = require("./lib/proxies");
const {
  PROXY_KINDS,
  ESCROW_KIND,
  ADAPTER_KIND,
  TIMELOCK_KIND,
  TIMELOCK_INTERFACE,
  buildBatch,
  buildOperation,
  encodeScheduleBatch,
  encodeExecuteBatch,
  encodeSchedule,
  encodeExecute,
} = require("./lp-timelock");

// Replace the LPTimelock that owns the stack with a new one — the planned switch (decision T19,
// case 1). The old timelock must still work; a dead or compromised timelock cannot be replaced
// from the chain (case 2 in scripts/README.md: redeploy and migrate).
//
// What moves (audit row C-15, 7 Oct 2026: every contract the old timelock owns, not only the
// five proxies), in this batch order, each read from deployments.json for the chain:
//
//   - the five LP proxies (vault, distributor, registry, Overture token, zapper) — required;
//   - `BonusEscrow`, a UUPS proxy, Ownable2Step like the five;
//   - `ApeBondPositionAdapter`, plain `Ownable`: its `transferOwnership` IS the whole handover,
//     effective when the old timelock's batch executes, with nothing to accept;
//   - every `RewardToken:<SYMBOL>` entry, Overture-shaped UUPS proxies, Ownable2Step.
//
// An optional entry (the escrow, the adapter, a reward token) moves when it is in the registry
// AND the registry records the old timelock as its owner. Otherwise it is skipped with a printed
// `skip` line: a stack without the ApeBond route has no escrow or adapter, and a reward token
// added by address (`REWARD_TOKEN_ADDRESS`) is not ours to move — a `transferOwnership` the old
// timelock cannot make would revert the whole batch.
//
// Why it is possible at all: every owner above is STORAGE, not an immutable, so ownership moves
// by one `transferOwnership(newTimelock)` per contract — sent BY the old timelock, because it is
// the owner — followed, on the Ownable2Step ones, by one `acceptOwnership()` — sent BY the new
// timelock, because it is the nominee.
//
// The six steps, one SWITCH_ACTION each, in order:
//
//   deploy       deploy the new LPTimelock(minDelay = NEW_TIMELOCK_MIN_DELAY (default 0),
//                proposers = executors = [multisig], admin = address(0)). The multisig is also
//                its canceller. Recorded as `TimelockControllerNext` in deployments.json.
//   schedule     ONE batch on the OLD timelock: transferOwnership(new) on every contract that
//                moves, scheduled with the old timelock's minDelay (48 h on mainnet).
//   execute      after that delay: execute the batch. The Ownable2Step contracts now name the
//                new timelock as pendingOwner (the old timelock is still their owner); the
//                adapter is the new timelock's already.
//   accept       on the NEW timelock: one batch acceptOwnership() on every Ownable2Step contract
//                that moves, scheduled and — because its delay is still 0 — executed in the same
//                run. With a non-zero delay the run schedules it and a second `accept` run
//                executes it.
//   raise-delay  on the NEW timelock: updateDelay(NEW_TIMELOCK_FINAL_DELAY, default 48 h),
//                scheduled on itself and executed (same rule as `accept`).
//   verify       prints owner() of every contract that moved — and pendingOwner() of the
//                Ownable2Step ones — and requires owner == new timelock and pendingOwner == 0;
//                then the new minDelay; on success, deployments.json records the new owner on
//                each moved entry, moves the new timelock into `TimelockController` and keeps the
//                old one as `TimelockControllerRetired`.
//
// Every transaction is sent only when the configured signer holds the timelock role it needs
// (the multisig's proposer/executor role); otherwise the script prints the `to` and `data`
// for the Safe and sends nothing. Mainnet never sends without CONFIRM=1 (or CONFIRM=yes).
//
// ──────────────────────── environment ────────────────────────
//
//   SWITCH_ACTION              deploy | schedule | execute | accept | raise-delay | verify
//   NEW_TIMELOCK_ADDRESS       the new timelock (default: TimelockControllerNext in the registry)
//   NEW_TIMELOCK_MIN_DELAY     delay of the new timelock at deploy, seconds (0)
//   NEW_TIMELOCK_FINAL_DELAY   delay `raise-delay` installs, seconds (172800 = 48 h)
//   LP_MULTISIG                proposer/executor/canceller of the new timelock (default: the
//                              old timelock's recorded proposer)
//   TIMELOCK_SALT_TAG          distinguishes a repeat of the same batch (see lp-timelock.js)
//   CONFIRM=1                  required on mainnet

const NEXT_KIND = "TimelockControllerNext";
const RETIRED_KIND = "TimelockControllerRetired";
const REWARD_TOKEN_PREFIX = "RewardToken:";
const ACTIONS = ["deploy", "schedule", "execute", "accept", "raise-delay", "verify"];
const OWNABLE_ABI = ["function owner() view returns (address)", "function pendingOwner() view returns (address)"];

function confirmMainnet(chainId, action) {
  if (!pools.isMainnet(chainId)) return;
  if (process.env.CONFIRM === "1" || process.env.CONFIRM === "yes") return;
  throw new Error(`Refusing to ${action} on mainnet without CONFIRM=1.`);
}

/**
 * Every contract this switch moves, in batch order — the five proxies, then the escrow, the
 * adapter and the reward tokens the registry records as owned by the old timelock — and one
 * line per optional entry it skips, saying why. `twoStep` is false only for the plain-Ownable
 * adapter, which has no `pendingOwner` and nothing to accept.
 */
function contractsToMove(entries, chainId, oldAddress) {
  const move = PROXY_KINDS.map((kind) => {
    if (!entries[kind]) throw new Error(`No ${kind} for chain ${chainId} in deployments.json`);
    return { kind, address: hre.ethers.getAddress(entries[kind].address), twoStep: true };
  });
  const rewardKinds = Object.keys(entries)
    .filter((kind) => kind.startsWith(REWARD_TOKEN_PREFIX))
    .sort();
  const optional = [
    { kind: ESCROW_KIND, twoStep: true },
    { kind: ADAPTER_KIND, twoStep: false },
    ...rewardKinds.map((kind) => ({ kind, twoStep: true })),
  ];
  const skipped = [];
  for (const { kind, twoStep } of optional) {
    const entry = entries[kind];
    if (!entry) {
      skipped.push(`${kind}: not in deployments.json for chain ${chainId}`);
    } else if (!entry.owner || entry.owner.toLowerCase() !== oldAddress.toLowerCase()) {
      skipped.push(`${kind} ${entry.address}: the registry records owner ${entry.owner || "(none)"}, not the old timelock`);
    } else {
      move.push({ kind, address: hre.ethers.getAddress(entry.address), twoStep });
    }
  }
  if (rewardKinds.length === 0) skipped.push(`${REWARD_TOKEN_PREFIX}*: none in deployments.json for chain ${chainId}`);
  return { move, skipped };
}

/** Sends `data` to `to` when `signer` holds `role` on `timelock`; prints the Safe payload otherwise. */
async function sendOrPrint({ chainId, label, timelock, role, signer, to, data }) {
  console.log(`\n${label}\n  to:   ${to}\n  data: ${data}`);
  if (!(await timelock.hasRole(role, signer.address))) {
    console.log(`  ${signer.address} does not hold that role: propose it from the multisig Safe (value 0).`);
    return false;
  }
  confirmMainnet(chainId, label);
  await pools.send(label, signer, (o) => signer.sendTransaction({ to, data, ...o }));
  return true;
}

/** Schedules a batch on `timelock` if it is not known yet, then executes it if it is ready. */
async function scheduleThenExecute({ chainId, timelock, signer, batch, label }) {
  const delay = await timelock.getMinDelay();
  const [PROPOSER, EXECUTOR] = await Promise.all([timelock.PROPOSER_ROLE(), timelock.EXECUTOR_ROLE()]);
  if (!(await timelock.isOperation(batch.id))) {
    const sent = await sendOrPrint({
      chainId, label: `schedule ${label} (delay ${delay}s)`, timelock, role: PROPOSER, signer,
      to: await timelock.getAddress(), data: encodeScheduleBatch(batch, delay),
    });
    if (!sent) return;
  }
  if (await timelock.isOperationDone(batch.id)) return console.log(`  ${label}: already executed`);
  if (!(await timelock.isOperationReady(batch.id))) {
    return console.log(`  ${label}: scheduled, ready at ${await timelock.getTimestamp(batch.id)} — re-run after that`);
  }
  await sendOrPrint({
    chainId, label: `execute ${label}`, timelock, role: EXECUTOR, signer,
    to: await timelock.getAddress(), data: encodeExecuteBatch(batch),
  });
}

async function main() {
  const chainId = await pools.chainId();
  const action = process.env.SWITCH_ACTION;
  if (!ACTIONS.includes(action)) throw new Error(`Set SWITCH_ACTION to one of ${ACTIONS.join(", ")}`);
  const entries = pools.readRegistry()[String(chainId)] || {};
  const old = entries[TIMELOCK_KIND];
  if (!old) throw new Error(`No ${TIMELOCK_KIND} for chain ${chainId} in deployments.json`);
  const { move, skipped } = contractsToMove(entries, chainId, old.address);
  const signer = await pools.getSigner();
  const tag = process.env.TIMELOCK_SALT_TAG || "";
  const oldTimelock = new hre.ethers.Contract(old.address, TIMELOCK_INTERFACE, signer);

  if (action === "deploy") {
    const multisig = hre.ethers.getAddress(process.env.LP_MULTISIG || old.proposers[0]);
    const minDelay = Number(process.env.NEW_TIMELOCK_MIN_DELAY || 0);
    console.log(`New timelock: proposer/executor/canceller ${multisig}, minDelay ${minDelay}s`);
    if (!old.proposers.map((a) => a.toLowerCase()).includes(multisig.toLowerCase())) {
      // Not fatal — moving the stack to a NEW multisig is a legitimate reason to switch — but it
      // must be deliberate: LP_MULTISIG is also read from .env, where a stale value would hand
      // the whole owner tier to the wrong Safe.
      console.log(
        `WARNING: ${multisig} is NOT a proposer of the current timelock (${old.proposers.join(", ")}).\n` +
          "         The new timelock will be governed by a DIFFERENT multisig. Check LP_MULTISIG."
      );
    }
    confirmMainnet(chainId, "deploy a new LPTimelock");
    const d = await deployContract("LPTimelock", [minDelay, [multisig], [multisig], hre.ethers.ZeroAddress], signer);
    pools.recordDeployment(chainId, NEXT_KIND, d.address, {
      deployTx: d.tx.hash, block: d.receipt.blockNumber, minDelay,
      proposers: [multisig], executors: [multisig], cancellers: [multisig], admin: hre.ethers.ZeroAddress,
    });
    return console.log(`\nNext: SWITCH_ACTION=schedule (one batch on the old timelock ${old.address}).`);
  }

  const nextAddress = process.env.NEW_TIMELOCK_ADDRESS || (entries[NEXT_KIND] && entries[NEXT_KIND].address);
  if (!nextAddress) throw new Error(`Set NEW_TIMELOCK_ADDRESS, or run SWITCH_ACTION=deploy first`);
  const newTimelock = new hre.ethers.Contract(hre.ethers.getAddress(nextAddress), TIMELOCK_INTERFACE, signer);
  const newAddress = await newTimelock.getAddress();
  for (const line of skipped) console.log(`skip  ${line}`);

  // The one batch on the OLD timelock: one nomination (the adapter: one handover) per contract,
  // executed atomically.
  const transferBatch = buildBatch(
    move.map((c) => ({ target: c.address, fn: "transferOwnership", args: [newAddress] })),
    tag
  );

  if (action === "schedule" || action === "execute") {
    const [PROPOSER, EXECUTOR] = await Promise.all([oldTimelock.PROPOSER_ROLE(), oldTimelock.EXECUTOR_ROLE()]);
    const delay = await oldTimelock.getMinDelay();
    console.log(`Old timelock ${old.address} (minDelay ${delay}s), batch id ${transferBatch.id}`);
    for (const c of move) {
      const note = c.twoStep ? "" : " (plain Ownable: effective at execute, nothing to accept)";
      console.log(`  ${c.kind}.transferOwnership(${newAddress}) on ${c.address}${note}`);
    }
    if (action === "schedule") {
      return sendOrPrint({ chainId, label: "scheduleBatch on the OLD timelock", timelock: oldTimelock, role: PROPOSER, signer,
        to: old.address, data: encodeScheduleBatch(transferBatch, delay) });
    }
    if (!(await oldTimelock.isOperationReady(transferBatch.id))) {
      throw new Error(`The batch is not ready (timestamp ${await oldTimelock.getTimestamp(transferBatch.id)}): wait out the delay`);
    }
    return sendOrPrint({ chainId, label: "executeBatch on the OLD timelock", timelock: oldTimelock, role: EXECUTOR, signer,
      to: old.address, data: encodeExecuteBatch(transferBatch) });
  }

  if (action === "accept") {
    const twoStep = move.filter((c) => c.twoStep);
    const acceptBatch = buildBatch(twoStep.map((c) => ({ target: c.address, fn: "acceptOwnership" })), tag);
    return scheduleThenExecute({
      chainId, timelock: newTimelock, signer, batch: acceptBatch,
      label: `acceptOwnership x${twoStep.length} on the NEW timelock`,
    });
  }

  if (action === "raise-delay") {
    const finalDelay = BigInt(process.env.NEW_TIMELOCK_FINAL_DELAY || 172800);
    const op = buildOperation({ target: newAddress, fn: "updateDelay", args: [finalDelay], tag });
    // A single call, wrapped as a one-call batch so `scheduleThenExecute` serves both steps.
    const batch = buildBatch([{ target: newAddress, fn: "updateDelay", args: [finalDelay] }], tag);
    console.log(`(single-call form for a Safe: schedule ${encodeSchedule(op, await newTimelock.getMinDelay())}, execute ${encodeExecute(op)})`);
    return scheduleThenExecute({ chainId, timelock: newTimelock, signer, batch, label: `updateDelay(${finalDelay}) on the NEW timelock` });
  }

  // verify
  const failures = [];
  for (const m of move) {
    const c = new hre.ethers.Contract(m.address, OWNABLE_ABI, hre.ethers.provider);
    const owner = await c.owner();
    // The adapter is plain Ownable: it has no pendingOwner to read.
    const pending = m.twoStep ? await c.pendingOwner() : hre.ethers.ZeroAddress;
    const ok = owner.toLowerCase() === newAddress.toLowerCase() && pending === hre.ethers.ZeroAddress;
    const detail = m.twoStep ? `pendingOwner ${pending}` : "(plain Ownable, nothing to accept)";
    console.log(`${ok ? "OK  " : "FAIL"}  ${m.kind}.owner ${owner} ${detail}`);
    if (!ok) failures.push(m.kind);
  }
  const finalDelay = BigInt(process.env.NEW_TIMELOCK_FINAL_DELAY || 172800);
  const delay = await newTimelock.getMinDelay();
  console.log(`${delay === finalDelay ? "OK  " : "FAIL"}  new timelock minDelay ${delay} (expected ${finalDelay})`);
  if (delay !== finalDelay) failures.push("minDelay");
  if (failures.length > 0) throw new Error(`Switch not complete: ${failures.join(", ")}. deployments.json unchanged.`);

  const next = entries[NEXT_KIND] || {};
  const { address: _ignored, ...nextExtra } = next;
  const { address: oldAddress, ...oldExtra } = old;
  pools.recordDeployment(chainId, RETIRED_KIND, oldAddress, { ...oldExtra, retiredInFavourOf: newAddress });
  pools.recordDeployment(chainId, TIMELOCK_KIND, newAddress, { ...nextExtra, minDelay: Number(delay) });
  for (const m of move) {
    const { address, ...rest } = pools.readRegistry()[String(chainId)][m.kind];
    pools.recordDeployment(chainId, m.kind, address, { ...rest, owner: newAddress });
  }
  pools.removeDeployment(chainId, NEXT_KIND);
  console.log(`\nAll ${move.length} moved contracts are owned by ${newAddress}; deployments.json updated.`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
