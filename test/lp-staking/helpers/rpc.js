/**
 * Raw JSON-RPC calls against the spawned node.
 *
 * The suite talks to a real HTTP endpoint, not to `hre.network.provider`, so
 * `@nomicfoundation/hardhat-network-helpers` is unavailable: it is bound to the in-process
 * Hardhat Network. These are the handful of methods the scenario needs, each a direct
 * `provider.send`, so the request that reaches the node is visible at the call site.
 */

/** Mines `count` empty blocks. Automine is on, so this is only for deliberate gaps. */
async function mine(provider, count = 1) {
  for (let i = 0; i < count; i++) {
    await provider.send("evm_mine", []);
  }
  return provider.getBlockNumber();
}

/**
 * Offsets the clock for the NEXT block. Deliberately does not mine: the transaction that
 * follows carries the offset, which keeps "one transaction, one block" true.
 */
async function increaseTime(provider, seconds) {
  await provider.send("evm_increaseTime", [seconds]);
}

/** Offsets the clock and mines an empty block to make the jump visible immediately. */
async function advance(provider, seconds) {
  await increaseTime(provider, seconds);
  return mine(provider, 1);
}

async function snapshot(provider) {
  return provider.send("evm_snapshot", []);
}

async function revertTo(provider, id) {
  const ok = await provider.send("evm_revert", [id]);
  if (ok !== true) throw new Error(`evm_revert(${id}) returned ${ok}`);
  return ok;
}

/** `eth_getBlockByNumber` with the raw tag, so "safe"/"finalized"/"pending" work. */
async function getBlockByTag(provider, tag, withTxs = false) {
  return provider.send("eth_getBlockByNumber", [tag, withTxs]);
}

async function getBlockByNumber(provider, number, withTxs = false) {
  return provider.send("eth_getBlockByNumber", ["0x" + Number(number).toString(16), withTxs]);
}

/**
 * `eth_getLogs` with the filter passed through untouched. Block numbers are hex-encoded
 * here so call sites can pass plain numbers.
 */
async function getLogs(provider, filter) {
  const encoded = { ...filter };
  for (const key of ["fromBlock", "toBlock"]) {
    if (typeof encoded[key] === "number") {
      encoded[key] = "0x" + encoded[key].toString(16);
    }
  }
  return provider.send("eth_getLogs", [encoded]);
}

async function getTransactionReceipt(provider, hash) {
  return provider.send("eth_getTransactionReceipt", [hash]);
}

module.exports = {
  mine,
  increaseTime,
  advance,
  snapshot,
  revertTo,
  getBlockByTag,
  getBlockByNumber,
  getLogs,
  getTransactionReceipt,
};
