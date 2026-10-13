const hre = require("hardhat");
const pools = require("./lib/pools");
const { deployContract } = require("./lib/proxies");
const {
  PROXY_KINDS,
  TIMELOCK_KIND,
  TIMELOCK_INTERFACE,
  buildBatch,
  buildOperation,
  encodeScheduleBatch,
  encodeExecuteBatch,
  encodeSchedule,
  encodeExecute,
} = require("./lp-timelock");

// Replace the LPTimelock that owns the five proxies with a new one — the planned switch
// (decision T19, case 1). The old timelock must still work; a dead or compromised timelock
// cannot be replaced from the chain (case 2 in scripts/README.md: redeploy and migrate).
//
// Why it is possible at all: the owner of every proxy (vault, distributor, registry, Overture
// token, zapper) is Ownable2Step STORAGE, not an immutable, so ownership moves by one
// `transferOwnership(newTimelock)` per proxy — sent BY the old timelock, because it is the
// owner — followed by one `acceptOwnership()` per proxy — sent BY the new timelock, because it
// is the nominee.
//
// The five steps, one SWITCH_ACTION each, in order:
//
//   deploy       deploy the new LPTimelock(minDelay = NEW_TIMELOCK_MIN_DELAY (default 0),
//                proposers = executors = [multisig], admin = address(0)). The multisig is also
//                its canceller. Recorded as `TimelockControllerNext` in deployments.json.
//   schedule     ONE batch on the OLD timelock: transferOwnership(new) on all five proxies,
//                scheduled with the old timelock's minDelay (48 h on mainnet).
//   execute      after that delay: execute the batch. The five proxies now name the new
//                timelock as pendingOwner; the old timelock is still the owner.
//   accept       on the NEW timelock: one batch acceptOwnership() on all five, scheduled and —
//                because its delay is still 0 — executed in the same run. With a non-zero
//                delay the run schedules it and a second `accept` run executes it.
//   raise-delay  on the NEW timelock: updateDelay(NEW_TIMELOCK_FINAL_DELAY, default 48 h),
//                scheduled on itself and executed (same rule as `accept`).
//   verify       owner() == new timelock and pendingOwner() == 0 on all five, the new minDelay,
//                the roles; on success, deployments.json moves the new timelock into
//                `TimelockController` and keeps the old one as `TimelockControllerRetired`.
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
const ACTIONS = ["deploy", "schedule", "execute", "accept", "raise-delay", "verify"];
const OWNABLE_ABI = ["function owner() view returns (address)", "function pendingOwner() view returns (address)"];

function confirmMainnet(chainId, action) {
  if (!pools.isMainnet(chainId)) return;
  if (process.env.CONFIRM === "1" || process.env.CONFIRM === "yes") return;
  throw new Error(`Refusing to ${action} on mainnet without CONFIRM=1.`);
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
  const proxies = PROXY_KINDS.map((kind) => {
    if (!entries[kind]) throw new Error(`No ${kind} for chain ${chainId} in deployments.json`);
    return { kind, address: hre.ethers.getAddress(entries[kind].address) };
  });
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

  // The one batch on the OLD timelock: five nominations, executed atomically.
  const transferBatch = buildBatch({
    calls: proxies.map((p) => ({ target: p.address, fn: "transferOwnership", args: [newAddress] })),
    tag,
  });

  if (action === "schedule" || action === "execute") {
    const [PROPOSER, EXECUTOR] = await Promise.all([oldTimelock.PROPOSER_ROLE(), oldTimelock.EXECUTOR_ROLE()]);
    const delay = await oldTimelock.getMinDelay();
    console.log(`Old timelock ${old.address} (minDelay ${delay}s), batch id ${transferBatch.id}`);
    for (const p of proxies) console.log(`  ${p.kind}.transferOwnership(${newAddress}) on ${p.address}`);
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
    const acceptBatch = buildBatch({ calls: proxies.map((p) => ({ target: p.address, fn: "acceptOwnership" })), tag });
    return scheduleThenExecute({ chainId, timelock: newTimelock, signer, batch: acceptBatch, label: "acceptOwnership x5 on the NEW timelock" });
  }

  if (action === "raise-delay") {
    const finalDelay = BigInt(process.env.NEW_TIMELOCK_FINAL_DELAY || 172800);
    const op = buildOperation({ target: newAddress, fn: "updateDelay", args: [finalDelay], tag });
    // A single call, wrapped as a one-call batch so `scheduleThenExecute` serves both steps.
    const batch = buildBatch({ calls: [{ target: newAddress, fn: "updateDelay", args: [finalDelay] }], tag });
    console.log(`(single-call form for a Safe: schedule ${encodeSchedule(op, await newTimelock.getMinDelay())}, execute ${encodeExecute(op)})`);
    return scheduleThenExecute({ chainId, timelock: newTimelock, signer, batch, label: `updateDelay(${finalDelay}) on the NEW timelock` });
  }

  // verify
  const failures = [];
  for (const p of proxies) {
    const c = new hre.ethers.Contract(p.address, OWNABLE_ABI, hre.ethers.provider);
    const [owner, pending] = [await c.owner(), await c.pendingOwner()];
    const ok = owner.toLowerCase() === newAddress.toLowerCase() && pending === hre.ethers.ZeroAddress;
    console.log(`${ok ? "OK  " : "FAIL"}  ${p.kind}.owner ${owner} pendingOwner ${pending}`);
    if (!ok) failures.push(p.kind);
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
  for (const p of proxies) {
    const { address, ...rest } = pools.readRegistry()[String(chainId)][p.kind];
    pools.recordDeployment(chainId, p.kind, address, { ...rest, owner: newAddress });
  }
  pools.removeDeployment(chainId, NEXT_KIND);
  console.log(`\nAll five proxies are owned by ${newAddress}; deployments.json updated.`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
