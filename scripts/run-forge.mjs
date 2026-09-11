#!/usr/bin/env node
/**
 * `forge` wrapper that resolves the fork RPC endpoints before handing over.
 *
 * Forge does not read `.env` — it only expands `${VAR}` in foundry.toml from the
 * environment it is given. The Hardhat fork suites resolve their endpoint in a fixed
 * order and fail (never skip) once an operator has configured one; this wrapper applies
 * the same rule to the Foundry tier so both toolchains behave identically:
 *
 *     <NETWORK>_RPC_URL  ->  INFURA_API_KEY  ->  first public archive endpoint that
 *                                                actually serves the pinned block
 *
 * An explicitly configured endpoint is used alone and never probed: if the operator
 * pointed the suite at a node, a failure there is a real failure, not a reason to look
 * elsewhere. Every public candidate IS probed, on every run, with three distinct historical
 * reads at the pinned block — a pinned-block fork needs archive state on its very first read,
 * and whether a given host serves it depends both on where the request comes from and, for a
 * load-balanced pool, on which backend that particular request happens to reach.
 *
 * The wrapper exports, into forge's environment only:
 *   SEPOLIA_RPC_URL / MAINNET_RPC_URL  — the resolved endpoints ([rpc_endpoints]).
 *   LP_FORK_RPC_REQUIRED               — "true" when an operator explicitly configured an
 *                                        endpoint (env var or INFURA_API_KEY). The fork
 *                                        tier reads it to decide whether "no endpoint" is
 *                                        an environment fact (skip) or a defect (fail).
 *                                        See test/forge/utils/BaseForge.sol.
 *
 * The Infura project id is never printed: only the endpoint host is ever logged.
 */

import {spawn} from "node:child_process";
import process from "node:process";
import {pathToFileURL} from "node:url";
import dotenv from "dotenv";

dotenv.config({quiet: true});

/** Pinned fork block per network. Must match test/forge/utils/Profiles.sol. */
const PINNED_BLOCK = {
  sepolia: 11562000,
  mainnet: 25750000,
};

/**
 * Public archive candidates, probed in order. The mainnet list is the one the shipped
 * Hardhat fork suite uses (test/lp-staking/fork/LPStakingFork.test.js).
 *
 * The order is a preference, not a guarantee: whether a host serves ARCHIVE STATE depends on
 * where the request comes from, so every candidate is probed for state on every run rather
 * than trusted from a previous probe. See {servesArchiveStateAtPinnedBlock}.
 */
const PUBLIC_RPCS = {
  sepolia: [
    // tenderly FIRST, and publicnode only behind it, because publicnode is a LOAD-BALANCED
    // POOL whose backends do not agree about Sepolia archive state: a probe can land on a
    // backend that has it and the very next request land on one that does not. Both halves
    // were observed the same day —
    //   * run 32845136586: the probe hit a pruned backend, publicnode was rejected, tenderly
    //     served the whole fork tier, green.
    //   * run 32845141961: the probe hit a backend that HAD the state and passed, publicnode
    //     was accepted, and the fork tier then failed on its first read of a different
    //     account with `-32000: historical state 996e...7774 is not available`.
    // No single sample can tell those two runs apart, so the order is the first defence and
    // the three-read probe below is the second.
    "https://sepolia.gateway.tenderly.co",
    "https://ethereum-sepolia-rpc.publicnode.com",
    // Deliberately NOT listed, re-probe before re-adding: `https://sepolia.drpc.org` answers
    // `35: chain is not available on free plan`, and `https://rpc.sepolia.org` returns an HTML
    // 404 page rather than JSON-RPC at all. A known-dead candidate only adds a timeout.
  ],
  mainnet: [
    "https://ethereum-rpc.publicnode.com",
    "https://eth-mainnet.public.blastapi.io",
    "https://eth-pokt.nodies.app",
    "https://eth.drpc.org",
    "https://eth.merkle.io",
  ],
};

const PROBE_TIMEOUT_MS = 8000;

/** `totalSupply()`. Cheap, present on every ERC-20, and its result is a full 32-byte word. */
const TOTAL_SUPPLY_SELECTOR = "0x18160ddd";

/**
 * What the probe reads AT the pinned block. Three different addresses through three different
 * methods, because one read proves less than it looks like it does.
 *
 * `eth_getBlockByNumber` proves only that the node kept the header, which a pruned node does.
 * A single `eth_getBalance` is better but still one sample, and publicnode is a load-balanced
 * pool: run 32845141961 saw that one sample PASS and the fork tier then fail on its first read
 * of a different account. Three separate HTTP requests sample the pool three times and touch
 * three separate pieces of historical state — an account balance, a contract's code, and a
 * storage-dependent `eth_call` — which is what a forked test actually does.
 */
const ARCHIVE_PROBE = {
  sepolia: {
    balanceOf: "0xBb7403aAF82342A0d987A8603aAf881136B5D125", // the tREAL/tUSDC funder
    codeOf: "0x1238536071E1c677A632429e3655c799b22cDA52", // NonfungiblePositionManager
    totalSupplyOf: "0x8e65d19BE4bA1CC61005B4c70f21cd179512e33f", // tREAL
  },
  mainnet: {
    balanceOf: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88", // NonfungiblePositionManager
    codeOf: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
    totalSupplyOf: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
  },
};

/** Host only — the Infura project id must never reach a log. */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "<unparseable url>";
  }
}

/** Keeps a provider's error message to one readable log line. */
function shorten(text, limit = 120) {
  const oneLine = String(text).replace(/\s+/g, " ").trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit - 1)}\u2026` : oneLine;
}

/**
 * One JSON-RPC call, with every failure turned into a short, loggable reason.
 * @returns {Promise<{ok: true, result: string} | {ok: false, reason: string}>}
 */
async function rpcCall(url, method, params) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params}),
      signal: controller.signal,
    });

    if (!response.ok) return {ok: false, reason: `HTTP ${response.status}`};

    let body;
    try {
      body = await response.json();
    } catch {
      return {ok: false, reason: "response is not JSON-RPC"};
    }

    if (body?.error) {
      return {ok: false, reason: `JSON-RPC ${body.error.code}: ${shorten(body.error.message)}`};
    }
    if (typeof body?.result !== "string" || !body.result.startsWith("0x")) {
      return {ok: false, reason: "no hex result"};
    }
    return {ok: true, result: body.result};
  } catch (error) {
    if (error?.name === "AbortError") return {ok: false, reason: `no answer in ${PROBE_TIMEOUT_MS} ms`};
    // node's fetch reports every transport failure as the bare string "fetch failed"; the
    // useful part (ECONNREFUSED, ENOTFOUND, a TLS complaint) is only on `cause`.
    const cause = error?.cause?.message ?? error?.cause?.code;
    return {ok: false, reason: shorten(cause ? `${error.message} (${cause})` : (error?.message ?? String(error)))};
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probes whether `url` really serves ARCHIVE STATE at the pinned block — three distinct
 * historical reads, all of which must succeed, issued as three separate requests.
 *
 * Why three, and why not batched: a header read proves only that the node kept the header,
 * and a single state read proves only that ONE request reached a backend that has the state.
 * `ethereum-sepolia-rpc.publicnode.com` is a load-balanced pool whose backends disagree about
 * Sepolia archive availability, and both outcomes were seen on the same day — run 32845136586
 * rejected it and ran green on tenderly, while run 32845141961 saw the single balance read
 * PASS and then failed inside `setUp()` on the first read of a different account
 * (`-32000: historical state 996e...7774 is not available`). Three separate HTTP requests
 * sample the pool three times; a batch would land on one backend and prove no more than one.
 *
 * The reads short-circuit, so a dead endpoint still costs one timeout rather than three.
 *
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>} `reason` is short enough to log.
 */
export async function servesArchiveStateAtPinnedBlock(url, network) {
  const at = `0x${PINNED_BLOCK[network].toString(16)}`;
  const targets = ARCHIVE_PROBE[network];

  const balance = await rpcCall(url, "eth_getBalance", [targets.balanceOf, at]);
  if (!balance.ok) return {ok: false, reason: `balance: ${balance.reason}`};

  const code = await rpcCall(url, "eth_getCode", [targets.codeOf, at]);
  if (!code.ok) return {ok: false, reason: `code: ${code.reason}`};
  // A pruned backend can answer `eth_getCode` with an empty result instead of an error.
  if (code.result.length <= 2) return {ok: false, reason: "code: empty at the pinned block"};

  const call = await rpcCall(url, "eth_call", [{to: targets.totalSupplyOf, data: TOTAL_SUPPLY_SELECTOR}, at]);
  if (!call.ok) return {ok: false, reason: `totalSupply: ${call.reason}`};
  // Both probe tokens demonstrably have supply at the pinned block, so a zero word here means
  // the node answered from missing state rather than from the real thing.
  if (call.result.length !== 66 || /^0x0+$/.test(call.result)) {
    return {ok: false, reason: `totalSupply: ${shorten(call.result, 24)} is not a live supply`};
  }

  return {ok: true};
}

/**
 * @returns {Promise<{url: string|null, configured: boolean, source: string}>}
 */
async function resolve(network) {
  const explicit = process.env[`${network.toUpperCase()}_RPC_URL`];
  if (explicit) return {url: explicit, configured: true, source: `${network.toUpperCase()}_RPC_URL`};

  if (process.env.INFURA_API_KEY) {
    return {
      url: `https://${network}.infura.io/v3/${process.env.INFURA_API_KEY}`,
      configured: true,
      source: "INFURA_API_KEY",
    };
  }

  for (const candidate of PUBLIC_RPCS[network]) {
    // eslint-disable-next-line no-await-in-loop -- ordered fallback, first hit wins
    const probe = await servesArchiveStateAtPinnedBlock(candidate, network);
    if (probe.ok) return {url: candidate, configured: false, source: "public fallback"};
    // Host only, never a key. A CI log must say WHY a candidate was passed over.
    console.log(`forge fork RPC: ${network} candidate rejected — ${hostOf(candidate)}: ${probe.reason}`);
  }
  return {url: null, configured: false, source: "none"};
}

async function main() {
  const [sepolia, mainnet] = await Promise.all([resolve("sepolia"), resolve("mainnet")]);

  const env = {...process.env};
  if (sepolia.url) env.SEPOLIA_RPC_URL = sepolia.url;
  if (mainnet.url) env.MAINNET_RPC_URL = mainnet.url;
  env.LP_FORK_RPC_REQUIRED = String(sepolia.configured || mainnet.configured);

  console.log(
    `forge fork RPC: sepolia=${sepolia.url ? hostOf(sepolia.url) : "UNRESOLVED"} (${sepolia.source}), ` +
      `mainnet=${mainnet.url ? hostOf(mainnet.url) : "UNRESOLVED"} (${mainnet.source})`
  );

  const child = spawn("forge", process.argv.slice(2), {stdio: "inherit", env});
  child.on("error", (error) => {
    if (error.code === "ENOENT") {
      console.error(
        "forge not found on PATH. Install Foundry (https://getfoundry.sh) or add ~/.foundry/bin to PATH."
      );
      process.exit(127);
    }
    console.error(error.message);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}

// Only run as a CLI when invoked directly; the probe above is imported by hand when someone
// needs to ask an endpoint the same question this script asks it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
