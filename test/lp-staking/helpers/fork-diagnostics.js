/**
 * What a fork suite prints when it fails, so a CI run that cannot be reproduced locally
 * still leaves enough behind to find the cause.
 *
 *   - {@link reportFailedTest}, from an `afterEach`: when the failed test's error names a
 *     transaction (ethers' `txHash` in the node's error data, a receipt hash, or the
 *     "transaction 0x… reverted on chain" line of helpers/chain.js), it runs
 *     `debug_traceTransaction` on the spawned node and prints the revert reason, the opcode
 *     the execution stopped on, the call frames that were open at that point and the last
 *     steps of the trace.
 *   - {@link printNodeLogTail}, from the `after` hook when any test failed: the last 200
 *     lines of the spawned node's own log, passed through the RPC redaction first.
 *
 * Both only print. Neither may throw: a diagnostic that fails must never hide the failure
 * it was called for, so every error inside is reported as one line and swallowed.
 */

const fs = require("fs");
const ethers = require("ethers");

const { redactRpcText } = require("./redact");

const CALL_OPS = new Set(["CALL", "CALLCODE", "DELEGATECALL", "STATICCALL", "CREATE", "CREATE2"]);

/** Every transaction hash an error from ethers / helpers/chain.js names, first one first. */
function txHashesFromError(error) {
  if (!error) return [];
  const found = [];
  const push = (h) => {
    if (typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h) && !found.includes(h.toLowerCase())) {
      found.push(h.toLowerCase());
    }
  };
  push(error.receipt && error.receipt.hash);
  push(error.transactionHash);
  const text = `${error.message || ""} ${safeStringify(error.error)} ${safeStringify(error.info)}`;
  for (const m of text.matchAll(/"txHash"\s*:\s*"(0x[0-9a-fA-F]{64})"/g)) push(m[1]);
  for (const m of text.matchAll(/transaction (0x[0-9a-fA-F]{64}) reverted/g)) push(m[1]);
  return found;
}

function safeStringify(value) {
  try {
    return value === undefined ? "" : JSON.stringify(value);
  } catch {
    return "";
  }
}

/** `Error(string)` / `Panic(uint256)` decoded; anything else as raw hex. */
function decodeRevert(data) {
  if (!data || data === "0x") return "empty revert data (0x)";
  const hex = data.startsWith("0x") ? data : `0x${data}`;
  try {
    if (hex.startsWith("0x08c379a0")) {
      return `Error("${ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + hex.slice(10))[0]}")`;
    }
    if (hex.startsWith("0x4e487b71")) {
      return `Panic(0x${ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], "0x" + hex.slice(10))[0].toString(16)})`;
    }
  } catch {
    /* fall through to raw */
  }
  return `custom error / raw data ${hex.length > 138 ? hex.slice(0, 138) + "…" : hex}`;
}

/** The stack word at `fromTop` (0 = top) as an address, from a struct-log step. */
function stackAddress(step, fromTop) {
  const stack = step.stack || [];
  const word = stack[stack.length - 1 - fromTop];
  if (!word) return "?";
  const clean = word.replace(/^0x/, "").padStart(64, "0");
  return ethers.getAddress("0x" + clean.slice(24));
}

/**
 * Summarises a Hardhat struct-log trace: where the FIRST revert happened (the innermost
 * origin of a bubbled revert), the call frames open at that step, the opcode the whole
 * execution stopped on, and the last `tail` steps before the first revert.
 */
function summariseTrace(trace, tail = 12) {
  const logs = trace.structLogs || [];
  let revertIndex = logs.findIndex((step) => step.op === "REVERT" || step.op === "INVALID");
  // No REVERT/INVALID step: an out-of-gas or similar halt, which ends the trace.
  const focus = revertIndex === -1 ? logs.length - 1 : revertIndex;

  const frames = [];
  for (let i = 0; i <= focus && i < logs.length; i++) {
    const step = logs[i];
    while (frames.length > 0 && step.depth <= frames[frames.length - 1].callerDepth) frames.pop();
    if (i < focus && CALL_OPS.has(step.op)) {
      const to = step.op.startsWith("CREATE") ? "(new contract)" : stackAddress(step, 1);
      frames.push({ op: step.op, to, callerDepth: step.depth, pc: step.pc, gas: step.gas });
    }
  }
  const at = (step) => (step ? { op: step.op, pc: step.pc, depth: step.depth, gas: step.gas } : null);
  return {
    failed: Boolean(trace.failed),
    gas: trace.gas,
    returnValue: trace.returnValue,
    steps: logs.length,
    firstRevert: revertIndex === -1 ? null : at(logs[revertIndex]),
    stoppedOn: at(logs[logs.length - 1]),
    openFrames: frames.map(({ op, to, callerDepth, pc, gas }) => ({ op, to, depth: callerDepth + 1, pc, gas })),
    lastSteps: logs.slice(Math.max(0, focus - tail + 1), focus + 1).map((s) => `${s.depth}:${s.pc} ${s.op} gas=${s.gas}`),
  };
}

/** Prints the trace summary of one transaction on `provider`. Never throws. */
async function printTransactionTrace(provider, hash, label) {
  const p = (line) => console.log(`  [${label} diag] ${line}`);
  try {
    const receipt = await provider.send("eth_getTransactionReceipt", [hash]);
    const tx = await provider.send("eth_getTransactionByHash", [hash]);
    p(
      `tx ${hash}: from ${tx && tx.from} to ${tx && tx.to} gasLimit ${tx && BigInt(tx.gas)} ` +
        `status ${receipt && receipt.status} gasUsed ${receipt && BigInt(receipt.gasUsed)} block ${receipt && BigInt(receipt.blockNumber)}`
    );
    const trace = await provider.send("debug_traceTransaction", [
      hash,
      { disableMemory: true, disableStorage: true },
    ]);
    const s = summariseTrace(trace);
    p(`trace: failed=${s.failed} gas=${s.gas} steps=${s.steps} revert reason: ${decodeRevert(s.returnValue)}`);
    if (s.firstRevert) p(`first REVERT/INVALID at depth ${s.firstRevert.depth} pc ${s.firstRevert.pc} gas left ${s.firstRevert.gas}`);
    if (s.stoppedOn) p(`execution stopped on ${s.stoppedOn.op} at depth ${s.stoppedOn.depth} pc ${s.stoppedOn.pc} gas left ${s.stoppedOn.gas}`);
    p(`call frames open at the first revert (outermost first):`);
    if (s.openFrames.length === 0) p(`  (none: the top-level call itself)`);
    for (const f of s.openFrames) p(`  depth ${f.depth} ${f.op} -> ${f.to} (from pc ${f.pc}, gas ${f.gas})`);
    p(`last ${s.lastSteps.length} steps up to it: ${s.lastSteps.join(" | ")}`);
  } catch (error) {
    p(`could not trace ${hash}: ${error.shortMessage || error.message}`);
  }
}

/**
 * For an `afterEach`: when the test just run failed and its error names a transaction,
 * prints that transaction's trace. Never throws.
 */
async function reportFailedTest(test, provider, label) {
  try {
    if (!test || test.state !== "failed" || !provider) return;
    const hashes = txHashesFromError(test.err);
    for (const hash of hashes.slice(0, 2)) await printTransactionTrace(provider, hash, label);
  } catch (error) {
    console.log(`  [${label} diag] failure report itself failed: ${error.message}`);
  }
}

/** Prints the last `lines` lines of the node's log, redacted. Never throws. */
function printNodeLogTail(logFile, label, lines = 200) {
  try {
    if (!logFile || !fs.existsSync(logFile)) {
      console.log(`  [${label} diag] no node log to print (${logFile || "none"})`);
      return;
    }
    const text = fs.readFileSync(logFile, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
    console.log(`  [${label} diag] last ${lines} lines of ${logFile}:`);
    console.log(redactRpcText(text));
    console.log(`  [${label} diag] end of node log`);
  } catch (error) {
    console.log(`  [${label} diag] could not read the node log: ${error.message}`);
  }
}

/** Whether any test or hook in `suite` (recursively) failed. */
function suiteHasFailure(suite) {
  if (!suite) return false;
  const hooks = [
    ...(suite._beforeAll || []),
    ...(suite._beforeEach || []),
    ...(suite._afterEach || []),
    ...(suite._afterAll || []),
  ];
  if (hooks.some((h) => h.state === "failed")) return true;
  if ((suite.tests || []).some((t) => t.state === "failed")) return true;
  return (suite.suites || []).some(suiteHasFailure);
}

module.exports = {
  suiteHasFailure,
  txHashesFromError,
  decodeRevert,
  summariseTrace,
  printTransactionTrace,
  reportFailedTest,
  printNodeLogTail,
};
