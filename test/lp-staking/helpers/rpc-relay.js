/**
 * A local JSON-RPC relay that sits between a forked `hardhat node` and its upstream archive
 * endpoint.
 *
 * ── Why it exists ─────────────────────────────────────────────────────────────────────
 *
 * The repository has no GitHub secrets, so CI forks through the PUBLIC endpoints the
 * profiles list (helpers/profiles.js). Those gateways rate-limit per IP, and GitHub's hosted
 * runners share their IPs. A forked node reads every account and storage slot it touches
 * from the upstream the first time it needs it, so the first heavy transaction of a fresh
 * fork (a swap through a pool nobody has read yet) fires a burst of reads. When one of those
 * reads is answered with HTTP 429, a 5xx, or no answer at all, the node either surfaces a
 * revert it cannot explain or blocks until its caller gives up ("Headers Timeout Error").
 * Locally the same suites pass every time, because a developer's IP is not throttled.
 *
 * The relay is an `http.createServer` inside the test process. The forked node is pointed
 * at the relay's URL instead of the upstream, and the relay forwards each request body
 * unchanged to the upstream. It changes no answer, only how hard and how often it asks:
 *
 *   (a) a request that fails with HTTP 429, an HTTP 5xx, a network error or a per-attempt
 *       timeout is retried with exponential backoff (300 ms, 600 ms, 1.2 s, 2.4 s, capped at
 *       5 s), and a `Retry-After` header, when the upstream sends one, is honoured;
 *   (b) at most `maxInFlight` (default 4) requests are outstanding upstream at once; the
 *       rest wait in a queue, so a burst from the node does not trip the per-IP limit;
 *   (c) a JSON-RPC error body that signals rate limiting (HTTP 200 with an `error` whose
 *       message says "rate", "limit", "too many" or "capacity", or code 429 / -32005) is
 *       retried like an HTTP 429;
 *   (d) every retry prints one line (method and attempt), and `stop()` prints one summary
 *       line with the counts.
 *
 * ── Failure stays failure ─────────────────────────────────────────────────────────────
 *
 * The relay never turns a dead endpoint into a working one. When every attempt failed, the
 * node receives HTTP 502 with a JSON-RPC error naming the last cause, exactly the kind of
 * answer a dead upstream gives it directly, so a misconfigured endpoint still fails phase 1
 * of the suite (or makes it skip when nothing was configured) through
 * `decideOnForkFailure`, as before. A JSON-RPC error the upstream keeps returning after the
 * retries is passed through as the upstream's own answer.
 *
 * The relay's URL carries no credentials, so the upstream's key never reaches the node's
 * command line or its log through it.
 */

const http = require("http");

const DEFAULTS = Object.freeze({
  maxAttempts: 5,
  baseDelayMs: 300,
  maxDelayMs: 5_000,
  /** Upper bound on a `Retry-After` the relay will wait for. */
  maxRetryAfterMs: 30_000,
  maxInFlight: 4,
  /**
   * One attempt's budget. Five attempts plus the backoff stay well below undici's
   * 300-second headers timeout, which is what a script talking to the node hits when the
   * node waits on an upstream that never answers.
   */
  attemptTimeoutMs: 20_000,
});

/** JSON-RPC error messages that mean "slow down", not "your request is wrong". */
const RATE_LIMIT_MESSAGE = /rate|limit|too many|capacity/i;
/** JSON-RPC error codes gateways use for the same thing (429 echoed, Infura's -32005). */
const RATE_LIMIT_CODES = new Set([429, -32005]);

/** Whether a parsed JSON-RPC response (object or batch array) signals rate limiting. */
function isRateLimitedBody(parsed) {
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.some((item) => {
    const error = item && typeof item === "object" ? item.error : null;
    if (!error || typeof error !== "object") return false;
    if (RATE_LIMIT_CODES.has(Number(error.code))) return true;
    return typeof error.message === "string" && RATE_LIMIT_MESSAGE.test(error.message);
  });
}

/** A short name for a request body: `eth_getStorageAt`, or `batch[3] eth_getBalance,…`. */
function describeRequest(parsed) {
  if (Array.isArray(parsed)) {
    const methods = [...new Set(parsed.map((item) => item && item.method))].join(",");
    return `batch[${parsed.length}] ${methods}`;
  }
  return (parsed && parsed.method) || "<unparsed>";
}

/** `Retry-After` in milliseconds (seconds or an HTTP date), or null when absent/unusable. */
function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined || value === "") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return null;
}

/** The backoff before attempt `attempt + 1` (attempt counts from 1). */
function backoffDelay(attempt, options) {
  return Math.min(options.baseDelayMs * 2 ** (attempt - 1), options.maxDelayMs);
}

/**
 * A port derived from the upstream's host, in [20000, 39999].
 *
 * Hardhat's on-disk fork cache (`cache/hardhat-network-fork/rpc_cache/<host>_<port>/`) is
 * keyed by the fork URL's host AND port, so a random relay port would make every run start
 * cold and leave one dead cache directory behind per run. A port that is the same for the
 * same upstream keeps the cache working. Only the host goes in, so a credential in the
 * path never influences anything observable. A port already in use falls back to a random one.
 */
function stablePort(upstream) {
  let host = "";
  try {
    host = new URL(upstream).host;
  } catch {
    host = String(upstream);
  }
  let hash = 0x811c9dc5;
  for (const char of host) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return 20_000 + (hash % 20_000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A counting semaphore: at most `limit` holders at once, FIFO for the rest. */
function createLimiter(limit) {
  let active = 0;
  const waiting = [];
  return {
    get active() {
      return active;
    },
    async acquire() {
      if (active < limit) {
        active += 1;
        return;
      }
      await new Promise((resolve) => waiting.push(resolve));
      // The releaser handed its slot over without decrementing.
    },
    release() {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    },
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** The id(s) to echo in a relay-made error, so the node can match it to its request. */
function errorBody(parsed, message) {
  const one = (item) => ({
    jsonrpc: "2.0",
    id: item && item.id !== undefined ? item.id : null,
    error: { code: -32603, message },
  });
  return JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed));
}

/**
 * Starts a relay in front of `upstream`.
 *
 * @param {object} options
 * @param {string} options.upstream The real endpoint, credentials included.
 * @param {string} [options.label] Prefix for the log lines, e.g. "sepolia-fork".
 * @param {(line: string) => void} [options.log] Where log lines go; console.log by default.
 * @param {number} [options.port] Port to bind; defaults to {@link stablePort}, 0 = any.
 * @returns {Promise<{url: string, port: number, stats: object, stop: () => Promise<void>}>}
 */
async function startRpcRelay(options) {
  const opts = { ...DEFAULTS, ...options };
  if (!opts.upstream) throw new Error("startRpcRelay: `upstream` is required");
  const label = opts.label ? `[${opts.label} relay]` : "[rpc relay]";
  const log = opts.log || ((line) => console.log(`  ${line}`));
  const limiter = createLimiter(opts.maxInFlight);

  const stats = {
    requests: 0,
    upstreamAttempts: 0,
    retries: 0,
    failed: 0,
    maxInFlight: 0,
    lastError: null,
  };

  /** One upstream attempt. Resolves to a verdict, never rejects. */
  async function attemptOnce(body) {
    await limiter.acquire();
    stats.upstreamAttempts += 1;
    stats.maxInFlight = Math.max(stats.maxInFlight, limiter.active);
    try {
      const response = await fetch(opts.upstream, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body,
        signal: AbortSignal.timeout(opts.attemptTimeoutMs),
      });
      const text = await response.text();
      const retryAfter = parseRetryAfter(response.headers.get("retry-after"));

      if (response.status === 429 || response.status >= 500) {
        return { retry: true, reason: `HTTP ${response.status}`, retryAfter, status: response.status, text };
      }
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* not JSON: passed through as the upstream's answer */
      }
      if (parsed !== null && isRateLimitedBody(parsed)) {
        const first = (Array.isArray(parsed) ? parsed : [parsed]).find((i) => i && i.error);
        return {
          retry: true,
          reason: `JSON-RPC error ${first.error.code}: ${String(first.error.message).slice(0, 120)}`,
          retryAfter,
          status: response.status,
          text,
        };
      }
      return { retry: false, status: response.status, text };
    } catch (error) {
      const reason =
        error && (error.name === "TimeoutError" || error.name === "AbortError")
          ? `timeout after ${opts.attemptTimeoutMs} ms`
          : `network error: ${(error && error.cause && error.cause.code) || (error && error.message) || error}`;
      return { retry: true, reason, retryAfter: null, status: null, text: null };
    } finally {
      limiter.release();
    }
  }

  async function forward(body, parsed) {
    const name = describeRequest(parsed);
    let last = null;
    for (let attempt = 1; attempt <= opts.maxAttempts; attempt += 1) {
      last = await attemptOnce(body);
      if (!last.retry) return { status: last.status, text: last.text };
      if (attempt === opts.maxAttempts) break;

      const backoff = backoffDelay(attempt, opts);
      const wait =
        last.retryAfter === null ? backoff : Math.min(Math.max(backoff, last.retryAfter), opts.maxRetryAfterMs);
      stats.retries += 1;
      log(`${label} retry ${attempt + 1}/${opts.maxAttempts} ${name}: ${last.reason}, waiting ${wait} ms`);
      await sleep(wait);
    }

    stats.failed += 1;
    stats.lastError = `${name}: ${last.reason} (after ${opts.maxAttempts} attempts)`;
    log(`${label} FAILED ${stats.lastError}`);
    // A JSON-RPC error the upstream insisted on is its own answer; pass it through.
    if (last.status !== null && last.status < 500 && last.status !== 429 && last.text !== null) {
      return { status: last.status, text: last.text };
    }
    return {
      status: 502,
      text: errorBody(parsed, `rpc relay: upstream failed ${opts.maxAttempts} times, last: ${last.reason}`),
    };
  }

  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    let parsed = null;
    try {
      const body = await readBody(req);
      stats.requests += 1;
      try {
        parsed = JSON.parse(body);
      } catch {
        /* forwarded as-is; the upstream answers malformed input itself */
      }
      const { status, text } = await forward(body, parsed);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(text);
    } catch (error) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(errorBody(parsed, `rpc relay: ${error && error.message}`));
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  const listen = (port) =>
    new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", onError);
        resolve();
      });
    });
  const preferred = opts.port === undefined ? stablePort(opts.upstream) : opts.port;
  try {
    await listen(preferred);
  } catch (error) {
    if (preferred === 0 || error.code !== "EADDRINUSE") throw error;
    await listen(0);
  }
  // The test process must not stay alive for the relay alone.
  server.unref();
  const { port } = server.address();

  let stopped = false;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    stats,
    stop() {
      if (stopped) return Promise.resolve();
      stopped = true;
      log(
        `${label} ${stats.requests} requests, ${stats.upstreamAttempts} upstream attempts, ` +
          `${stats.retries} retries, ${stats.failed} failed, at most ${stats.maxInFlight} in flight`
      );
      return new Promise((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      });
    },
  };
}

module.exports = {
  DEFAULTS,
  startRpcRelay,
  isRateLimitedBody,
  parseRetryAfter,
  backoffDelay,
  describeRequest,
  stablePort,
};
