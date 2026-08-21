/**
 * Starts and supervises a long-lived `npx hardhat node --fork` child process.
 *
 * The in-process fork suite (test/lp-staking/fork/LPStakingFork.test.js) forks with
 * `hardhat_reset` inside the test runner. This suite needs a real JSON-RPC server instead,
 * because the deploy scripts run as separate processes against it — that is the whole
 * point of the exercise: the repo's own scripts, unmodified, against a real endpoint.
 *
 * ── Skip vs fail ──────────────────────────────────────────────────────────────────────
 *
 * Identical to the in-process suite's rule, and {@link decideOnForkFailure} is the single
 * place it is decided. Establishing the fork is the ONE phase that may skip, and it fails
 * instead when the profile's RPC variable (MAINNET_RPC_URL / SEPOLIA_RPC_URL) or
 * INFURA_API_KEY is set: an operator who configured an endpoint asked for these tests, so
 * silence would be a lie. Everything after the fork is up is a defect and fails the run.
 *
 * ── Profiles ──────────────────────────────────────────────────────────────────────────
 *
 * Which chain is forked, which block is pinned and which facts prove the fork is real all
 * come from a profile object (see helpers/profiles.js). Every entry point takes it as an
 * optional parameter defaulting to `profiles.mainnet`, so the shipped suite behaves exactly
 * as it did before profiles existed.
 *
 * ── No orphan nodes ───────────────────────────────────────────────────────────────────
 *
 * A `hardhat node` that outlives the test run holds its port and its fork cache lock.
 * Every child is registered here and killed from `stop()`, from `process.on("exit")`, and
 * from the SIGINT/SIGTERM handlers, so an interrupted run leaves nothing behind.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");
const ethers = require("ethers");

const { POOL_ABI, ERC20_ABI } = require("./constants");
const profiles = require("./profiles");

/**
 * Every function below takes the profile as its LAST parameter and defaults it to the
 * mainnet one, so the shipped suite — which passes nothing — keeps the exact behaviour it
 * was approved with, while the Sepolia suite passes `profiles.sepolia` and gets the same
 * code driven by different facts.
 */
const DEFAULT_PROFILE = profiles.mainnet;

/** Tick spacing Uniswap V3 assigns to each fee tier. Both profiles use 3000 -> 60. */
const TICK_SPACING_BY_FEE = { 100: 1, 500: 10, 3000: 60, 10000: 200 };

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const HARDHAT_CLI = require.resolve("hardhat/internal/cli/cli.js");

/**
 * Provider options every connection to the node uses.
 *
 * `cacheTimeout: -1` is load-bearing, not a tidy-up. Ethers memoises `_perform` results —
 * `eth_getTransactionCount` among them — for 250 ms by default, so two transactions sent
 * from the same account inside that window are both built with the same pending nonce and
 * the second one is rejected with "Nonce too low". This suite sends dozens of
 * back-to-back transactions per account against a local node that answers in single-digit
 * milliseconds, so the cache has to be off.
 *
 * `staticNetwork: true` skips the chain-id re-check on every call; the node cannot change
 * chains under us.
 */
const PROVIDER_OPTIONS = { staticNetwork: true, cacheTimeout: -1 };

/** How long the node gets to answer its first `eth_chainId`. */
const READY_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 250;
/** How long a killed node gets to exit before SIGKILL. */
const STOP_TIMEOUT_MS = 10_000;

// ─────────────────────────── child bookkeeping ───────────────────────────

/** Every node this module started and has not reaped yet. */
const liveChildren = new Set();
let handlersInstalled = false;

function installExitHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;

  // Synchronous: `exit` handlers cannot await.
  process.on("exit", () => {
    for (const child of liveChildren) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      for (const child of liveChildren) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
      // Re-raise with the default handler so the exit status stays truthful.
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    });
  }
}

// ─────────────────────────── RPC resolution ───────────────────────────

/**
 * The mainnet public list, still exported under these two names because the shipped suite
 * asserts on them. It now lives in `profiles.mainnet.rpc.publicCandidates`, so the copy
 * that test/lp-staking/fork/LPStakingFork.test.js L75–89 keeps in sync has exactly one
 * counterpart here instead of two.
 *
 * RPC resolution, in the order the runbook specifies:
 *   <profile>_RPC_URL -> INFURA_API_KEY -> public fallback.
 *
 * The mainnet default (`ethereum-rpc.publicnode.com`) serves head state but rejects
 * historical state with "Archive requests require a personal token", which a pinned-block
 * fork needs on its very first read, so without the extra candidates the suite could only
 * ever skip. An explicitly configured endpoint is always used alone.
 */
const [PUBLIC_FALLBACK_RPC, ...EXTRA_PUBLIC_ARCHIVE_RPCS] = profiles.mainnet.rpc.publicCandidates;

function resolveRpcCandidates(env = process.env, profile = DEFAULT_PROFILE) {
  return profiles.resolveRpcCandidates(profile, env);
}

/**
 * The fail-closed rule, as a pure function so it can be unit-tested without a network.
 *
 * Mirrors test/lp-staking/fork/LPStakingFork.test.js L570–606 — keep in sync.
 *
 * @param {string[]} failures One `url: reason` line per candidate that was tried.
 * @param {object} env Environment to read the profile's RPC variable / INFURA_API_KEY from.
 * @param {object} profile Network profile; defaults to mainnet, for which the strings below
 *   render exactly as they did before profiles existed.
 * @returns {{action: "throw"|"skip", message: string}}
 */
function decideOnForkFailure(failures, env = process.env, profile = DEFAULT_PROFILE) {
  const configured = profiles.isConfigured(profile, env);
  const label = profile.logLabel;
  const envUrl = profile.rpc.envUrl;
  const detail = `no usable RPC for block ${profile.pinnedBlock}:\n    ${failures.join("\n    ")}`;

  if (configured) {
    return {
      action: "throw",
      message:
        `[${label}] ${envUrl} / INFURA_API_KEY is set, so the ${label} ` +
        `integration suite must run, but the fork could not be established — ${detail}`,
    };
  }

  return {
    action: "skip",
    message:
      `[${label}] skipping ${label} integration suite — ${detail}` +
      `\n  Set ${envUrl} (archive access required) to run it.`,
  };
}

// ─────────────────────────── ports ───────────────────────────

/** Asks the OS for an unused TCP port and releases it again. */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// ─────────────────────────── node lifecycle ───────────────────────────

/** `process.env` minus every HARDHAT_* key, which would redirect the child's config. */
function childEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("HARDHAT_")) continue;
    env[key] = value;
  }
  return { ...env, HARDHAT_DISABLE_TELEMETRY_PROMPT: "true", ...extra };
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      liveChildren.delete(child);
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, STOP_TIMEOUT_MS);

    child.once("exit", () => {
      clearTimeout(timer);
      liveChildren.delete(child);
      resolve();
    });

    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(timer);
      liveChildren.delete(child);
      resolve();
    }
  });
}

/**
 * Spawns the node and resolves once it answers `eth_chainId`, or rejects with whatever
 * killed it. Never resolves a half-started node: a fork URL the endpoint refuses makes
 * `hardhat node` exit before it binds, and that exit is what is reported.
 */
async function spawnForkNode({ url, port, logFile, profile = DEFAULT_PROFILE }) {
  installExitHandlers();

  const pinnedBlock = profile.pinnedBlock;
  const out = fs.openSync(logFile, "a");
  fs.writeSync(
    out,
    `\n===== hardhat node --fork ${url} --fork-block-number ${pinnedBlock} --port ${port} =====\n`
  );

  const child = spawn(
    process.execPath,
    [
      HARDHAT_CLI,
      "node",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
      "--fork",
      url,
      "--fork-block-number",
      String(pinnedBlock),
    ],
    { cwd: REPO_ROOT, env: childEnv(), stdio: ["ignore", out, out] }
  );
  liveChildren.add(child);

  let exited = null;
  child.once("exit", (code, signal) => {
    exited = { code, signal };
    liveChildren.delete(child);
    // The child holds its own duplicate of this descriptor, so releasing ours once it is
    // gone keeps a run that walks several candidates from leaking one per attempt.
    try {
      fs.closeSync(out);
    } catch {
      /* already closed */
    }
  });

  const rpcUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + READY_TIMEOUT_MS;

  for (;;) {
    if (exited !== null) {
      const tail = readTail(logFile, 12);
      throw new Error(
        `hardhat node exited before it was ready (code ${exited.code}, signal ${exited.signal})` +
          (tail ? `\n      ${tail.split("\n").join("\n      ")}` : "")
      );
    }

    const probe = new ethers.JsonRpcProvider(rpcUrl, undefined, PROVIDER_OPTIONS);
    try {
      const chainId = await probe.send("eth_chainId", []);
      probe.destroy();
      if (BigInt(chainId) !== profile.localChainId) {
        throw new Error(
          `node reports chain id ${BigInt(chainId)}, expected ${profile.localChainId}`
        );
      }
      break;
    } catch (error) {
      probe.destroy();
      if (Date.now() > deadline) {
        await stopChild(child);
        throw new Error(
          `hardhat node did not become ready within ${READY_TIMEOUT_MS} ms: ${
            error.shortMessage || error.message
          }`
        );
      }
      await sleep(READY_POLL_MS);
    }
  }

  return {
    child,
    port,
    rpcUrl,
    url,
    logFile,
    stop: () => stopChild(child),
  };
}

function readTail(file, lines) {
  try {
    const text = fs.readFileSync(file, "utf8").trimEnd();
    return text.split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Proves the node really serves archive state at the pinned block.
 *
 * A `hardhat node --fork` starts happily against an endpoint that only serves head state;
 * the failure surfaces on the first historical read. So the probe reads facts that only a
 * real archive can answer, chosen per profile:
 *
 *   - always: the head is the pinned block, the four periphery contracts have code, and
 *     both of the profile's ERC-20s report the exact name / symbol / decimals recorded in
 *     the profile;
 *   - `totalSupply`, when the profile pins one (Sepolia's two tokens are fixed supply;
 *     mainnet's move between blocks, so nothing is asserted there);
 *   - the profile's pool immutables, when a real pool exists (mainnet). Under the Sepolia
 *     profile there IS no pool yet — the suite creates it — so the tokens carry the proof;
 *   - the funders: at least one must hold a non-zero balance of one of the two tokens,
 *     which is what makes the impersonation funding path viable at all.
 *
 * @param {object} provider
 * @param {object} [profile]
 */
async function probeFork(provider, profile = DEFAULT_PROFILE) {
  const head = await provider.getBlockNumber();
  if (head !== profile.pinnedBlock) {
    throw new Error(`node head is ${head}, expected the pinned block ${profile.pinnedBlock}`);
  }

  for (const [label, address] of [
    ["UniswapV3Factory", profile.factory],
    ["NonfungiblePositionManager", profile.npm],
    ["SwapRouter02", profile.router],
    ["Multicall3", profile.multicall3],
  ]) {
    const code = await provider.getCode(address);
    if (code === "0x") throw new Error(`no code at ${label} ${address} on the fork`);
  }

  const tokens = {};
  for (const [role, spec] of [
    ["asset", profile.asset],
    ["usdc", profile.usdc],
  ]) {
    const token = new ethers.Contract(spec.address, ERC20_ABI, provider);
    const [name, symbol, decimals, totalSupply] = await Promise.all([
      token.name(),
      token.symbol(),
      token.decimals(),
      token.totalSupply(),
    ]);
    if (name !== spec.name || symbol !== spec.symbol || BigInt(decimals) !== spec.decimals) {
      throw new Error(
        `${role} token ${spec.address} reads back as name="${name}" symbol="${symbol}" ` +
          `decimals=${decimals} — expected "${spec.name}"/"${spec.symbol}"/${spec.decimals}, ` +
          `so the endpoint is not serving state at ${profile.pinnedBlock}`
      );
    }
    if (spec.totalSupply !== null && spec.totalSupply !== undefined && totalSupply !== spec.totalSupply) {
      throw new Error(
        `${role} token ${spec.address} totalSupply is ${totalSupply}, expected ${spec.totalSupply}`
      );
    }
    tokens[role] = { name, symbol, decimals: Number(decimals), totalSupply };
  }

  let pool = null;
  if (profile.pool !== "create") {
    const poolContract = new ethers.Contract(profile.pool, POOL_ABI, provider);
    const [token0, token1, fee, spacing] = await Promise.all([
      poolContract.token0(),
      poolContract.token1(),
      poolContract.fee(),
      poolContract.tickSpacing(),
    ]);
    const expectedSpacing = TICK_SPACING_BY_FEE[profile.fee];
    if (
      token0 !== profile.asset.address ||
      token1 !== profile.usdc.address ||
      Number(fee) !== profile.fee ||
      Number(spacing) !== expectedSpacing
    ) {
      throw new Error(
        `real pool ${profile.pool} reads back as token0=${token0} token1=${token1} ` +
          `fee=${fee} spacing=${spacing} — the endpoint is not serving state at ${profile.pinnedBlock}`
      );
    }
    pool = { token0, token1, fee: Number(fee), tickSpacing: Number(spacing) };
  }

  const funders = [];
  for (const address of profile.funding.funders) {
    const asset = new ethers.Contract(profile.asset.address, ERC20_ABI, provider);
    const usdc = new ethers.Contract(profile.usdc.address, ERC20_ABI, provider);
    const [assetBalance, usdcBalance] = await Promise.all([
      asset.balanceOf(address),
      usdc.balanceOf(address),
    ]);
    funders.push({ address, asset: assetBalance, usdc: usdcBalance });
  }
  if (funders.length > 0 && funders.every((f) => f.asset === 0n && f.usdc === 0n)) {
    throw new Error(
      `none of the ${funders.length} configured funders holds any ${profile.asset.symbol} or ` +
        `${profile.usdc.symbol} at block ${profile.pinnedBlock} — impersonation funding cannot work`
    );
  }

  // `token0`/`token1`/`fee`/`tickSpacing` stay at the top level so the shipped suite's
  // caller, which reads them straight off the probe result, is unaffected.
  return { head, tokens, funders, pool, ...(pool || {}) };
}

/**
 * Tries every candidate endpoint in turn and returns the first working node.
 *
 * @param {{logDir: string, profile?: object}} options
 * @returns {Promise<{node: object, provider: object, url: string, probe: object, profile: object}|null>}
 *   `null` only when no endpoint worked AND no endpoint was configured — the single legal
 *   skip. When one was configured this throws instead.
 */
async function establishFork({ logDir, profile = DEFAULT_PROFILE }) {
  const candidates = resolveRpcCandidates(process.env, profile);
  const failures = [];

  for (const url of candidates) {
    let node = null;
    try {
      const port = await getFreePort();
      const logFile = path.join(logDir, `hardhat-node-${port}.log`);
      node = await spawnForkNode({ url, port, logFile, profile });

      const provider = new ethers.JsonRpcProvider(node.rpcUrl, undefined, PROVIDER_OPTIONS);
      provider.pollingInterval = 100;

      try {
        const probe = await probeFork(provider, profile);
        return { node, provider, url, probe, profile };
      } catch (error) {
        provider.destroy();
        throw error;
      }
    } catch (error) {
      if (node) await node.stop();
      failures.push(`${url}: ${error.shortMessage || error.message}`);
    }
  }

  const decision = decideOnForkFailure(failures, process.env, profile);
  if (decision.action === "throw") throw new Error(decision.message);
  console.warn(`\n  ${decision.message}\n`);
  return null;
}

module.exports = {
  PUBLIC_FALLBACK_RPC,
  EXTRA_PUBLIC_ARCHIVE_RPCS,
  DEFAULT_PROFILE,
  TICK_SPACING_BY_FEE,
  resolveRpcCandidates,
  decideOnForkFailure,
  probeFork,
  establishFork,
  REPO_ROOT,
  HARDHAT_CLI,
};
