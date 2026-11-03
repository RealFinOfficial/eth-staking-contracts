// One chunked `eth_getLogs` loop for every script that scans events.
//
// The Infura plan this repo runs on refuses an `eth_getLogs` call whose block range is wider than
// 10,000 blocks (a provider policy, not on Infura's public docs page). Every log scan in `scripts/`
// therefore walks the range in chunks of at most {@link MAX_LOG_CHUNK} blocks through this one
// helper: `post-launch-check.js`, `deploy-apebond.js` (the adapter history) and `lp-timelock.js`
// (`pending`, `cancellers`, the `withdraw-offer` hint).

/** The widest block range one `eth_getLogs` call asks for. */
const MAX_LOG_CHUNK = 10_000;

/**
 * Every log on `address` matching `topics` in the blocks [fromBlock, toBlock], in order, fetched
 * in chunks of `chunk` blocks (default {@link MAX_LOG_CHUNK}, which no caller exceeds). `onChunk`, when
 * given, is called after each chunk with `{ start, end, toBlock, found }`, so a long scan can
 * print its progress.
 *
 * @param {import("ethers").Provider} provider
 * @param {{address: string, topics: Array, fromBlock: number, toBlock: number, chunk?: number,
 *          onChunk?: function}} options
 */
async function scanLogs(provider, { address, topics, fromBlock, toBlock, chunk = MAX_LOG_CHUNK, onChunk }) {
  // Each caller validates or clamps its own configured chunk exactly as it did before this helper
  // existed, so the helper adds no check of its own and changes no caller's behaviour.
  const logs = [];
  for (let start = fromBlock; start <= toBlock; start += chunk) {
    const end = Math.min(start + chunk - 1, toBlock);
    logs.push(...(await provider.getLogs({ address, topics, fromBlock: start, toBlock: end })));
    if (onChunk) onChunk({ start, end, toBlock, found: logs.length });
  }
  return logs;
}

module.exports = { MAX_LOG_CHUNK, scanLogs };
