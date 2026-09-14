/**
 * Runs the repo's own deployment scripts as child processes against the spawned node.
 *
 * This is the point of the suite: `scripts/create-sepolia-pool.js` and
 * `scripts/deploy-lp-staking.js` are executed unmodified, through the real
 * `hardhat run --network localhost` entry point, so their chain-31337 branches, their
 * on-chain guards and their post-deploy verification are all under test — not a
 * re-implementation of them.
 *
 * Three things make that work:
 *   - `LOCALHOST_RPC_URL` points `networks.localhost` at the port the harness picked.
 *   - `LOCALHOST_GAS_PRICE` pins the gas price, because a forked node inherits mainnet's
 *     base fee and the scripts do not pin fees themselves.
 *   - `DEPLOYMENTS_FILE` redirects the registry, so a throwaway chain-31337 deploy never
 *     rewrites the tracked deployments.json.
 *
 * Addresses are read back from that registry file, never scraped out of stdout.
 */

const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { REPO_ROOT, HARDHAT_CLI } = require("./fork-node");

/** A script that has not finished in this long is stuck, not slow. */
const SCRIPT_TIMEOUT_MS = 180_000;

/**
 * `process.env` minus every HARDHAT_* and LP_* key.
 *
 * HARDHAT_* would redirect the child's network or config. LP_* is stripped because the
 * suite must supply the complete set itself: a stray LP_POOL or LP_FACTORY inherited from
 * an operator's shell would silently point the run at another chain's Uniswap deployment,
 * which is the exact failure .env.example warns about.
 */
function scriptEnv(extra) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("HARDHAT_") || key.startsWith("LP_")) continue;
    env[key] = value;
  }
  return { ...env, HARDHAT_DISABLE_TELEMETRY_PROMPT: "true", ...extra };
}

/**
 * Spawns `hardhat run --no-compile --network <network> <script>` and waits for it.
 *
 * Never throws on a non-zero exit — the caller asserts the code, because two of the runs
 * in the fork suites are supposed to fail (the swapped-pair refusal).
 *
 * `network` defaults to `localhost`, the spawned fork node. The live Sepolia smoke suite
 * passes `sepolia` so the very same script runs against the real network, which is the only
 * difference between a rehearsal and the staging deployment.
 *
 * @param {string} relativeScript
 * @param {object} env
 * @param {{logFile?: string, network?: string, timeoutMs?: number}} [options]
 * @returns {Promise<{code:number, signal:string|null, stdout:string, stderr:string, durationMs:number}>}
 */
function runHardhatScript(relativeScript, env, { logFile, network = "localhost", timeoutMs = SCRIPT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(
      process.execPath,
      [HARDHAT_CLI, "run", "--no-compile", "--network", network, relativeScript],
      { cwd: REPO_ROOT, env: scriptEnv(env), stdio: ["ignore", "pipe", "pipe"] }
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${relativeScript} did not finish within ${timeoutMs} ms`));
    }, timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      if (logFile) {
        fs.appendFileSync(
          logFile,
          `\n===== ${relativeScript} (exit ${code}, ${durationMs} ms) =====\n` +
            `env: ${JSON.stringify(env, null, 2)}\n` +
            `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`
        );
      }
      resolve({ code, signal, stdout, stderr, durationMs });
    });
  });
}

/** Reads the registry the scripts wrote. Missing file reads as an empty registry. */
function readRegistry(file) {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * One entry of the registry, e.g. `registryEntry(file, 31337, "LPStakingVault")`.
 *
 * `chainId` is the chain the SCRIPT saw, which on a fork is always 31337 whatever chain is
 * being forked — the profile's own chain id belongs in the live suite, where the script
 * really did run on Sepolia and recorded itself under 11155111.
 */
function registryEntry(file, chainId, kind) {
  const chain = readRegistry(file)[String(chainId)];
  return chain ? chain[kind] : undefined;
}

/** sha256 of a file, used to prove the tracked registry was left byte-identical. */
function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const TRACKED_REGISTRY = path.join(REPO_ROOT, "deployments.json");

module.exports = {
  runHardhatScript,
  readRegistry,
  registryEntry,
  sha256File,
  TRACKED_REGISTRY,
};
