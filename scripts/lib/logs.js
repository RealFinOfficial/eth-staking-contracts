// One chunked `eth_getLogs` loop for every script that scans events.
//
// The Infura plan this repo runs on refuses an `eth_getLogs` call whose block range is wider than
// 10,000 blocks (a provider policy, not on Infura's public docs page). Every log scan in `scripts/`
// therefore walks the range in chunks of at most {@link MAX_LOG_CHUNK} blocks through this one
// helper: `post-launch-check.js`, `deploy-apebond.js` (the adapter history) and `lp-timelock.js`
// (`pending`, `cancellers`, the `withdraw-offer` hint).

/** The widest block range one `eth_getLogs` call asks for, on any chain. */
const MAX_LOG_CHUNK = 10_000;

/**
 * The chunk each chain is scanned in, never above {@link MAX_LOG_CHUNK}. Avalanche C-Chain makes a
 * block about every two seconds and its public endpoints refuse a range above 2,048 blocks, so both
 * Avalanche chains use 2,048. A chain that is not listed uses {@link MAX_LOG_CHUNK}.
 */
const LOG_CHUNK_BY_CHAIN = {
  1: 10_000,
  11155111: 10_000,
  43114: 2_048,
  43113: 2_048,
};

/** The `eth_getLogs` chunk for `chainId`. */
function logChunkFor(chainId) {
  return Math.min(LOG_CHUNK_BY_CHAIN[Number(chainId)] || MAX_LOG_CHUNK, MAX_LOG_CHUNK);
}

/**
 * Every log on `address` matching `topics` in the blocks [fromBlock, toBlock], in order, fetched
 * in chunks of `chunk` blocks (default: the provider's chain's {@link logChunkFor}; never above
 * {@link MAX_LOG_CHUNK}). `onChunk`, when
 * given, is called after each chunk with `{ start, end, toBlock, found }`, so a long scan can
 * print its progress.
 *
 * @param {import("ethers").Provider} provider
 * @param {{address: string, topics: Array, fromBlock: number, toBlock: number, chunk?: number,
 *          onChunk?: function}} options
 */
async function scanLogs(provider, { address, topics, fromBlock, toBlock, chunk, onChunk }) {
  if (chunk === undefined) chunk = logChunkFor((await provider.getNetwork()).chainId);
  // Coerced once here: a registry `block` stored as a string would otherwise make `start += chunk`
  // concatenate, and the first request would span the whole range. Each caller still clamps or
  // validates its own configured chunk the way it always has.
  const from = Number(fromBlock);
  const to = Number(toBlock);
  const size = Number(chunk);
  for (const [name, value, raw] of [["fromBlock", from, fromBlock], ["toBlock", to, toBlock], ["chunk", size, chunk]]) {
    if (!Number.isFinite(value)) throw new Error(`scanLogs: ${name} must be a finite number of blocks — got ${raw}`);
  }
  if (size < 1) throw new Error(`scanLogs: chunk must be at least 1 block — got ${size}`);
  if (size > MAX_LOG_CHUNK) throw new Error(`scanLogs: chunk must be at most ${MAX_LOG_CHUNK} blocks — got ${size}`);
  const logs = [];
  for (let start = from; start <= to; start += size) {
    const end = Math.min(start + size - 1, to);
    logs.push(...(await provider.getLogs({ address, topics, fromBlock: start, toBlock: end })));
    if (onChunk) onChunk({ start, end, toBlock: to, found: logs.length });
  }
  return logs;
}

module.exports = { MAX_LOG_CHUNK, LOG_CHUNK_BY_CHAIN, logChunkFor, scanLogs };
