/**
 * Unit tests for the fork suites' JSON-RPC relay (helpers/rpc-relay.js), against fake
 * upstreams on 127.0.0.1. No network, no fork.
 */

const http = require("http");
const { expect } = require("chai");

const {
  startRpcRelay,
  isRateLimitedBody,
  parseRetryAfter,
  backoffDelay,
  stablePort,
  DEFAULTS,
} = require("./helpers/rpc-relay");

/** A fake upstream whose answer to the n-th request (from 1) is `handler(n, body, res)`. */
async function fakeUpstream(handler) {
  let count = 0;
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    count += 1;
    await handler(count, JSON.parse(body), res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    get count() {
      return count;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function ok(res, body) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x2a" }));
}

async function call(url, method = "eth_blockNumber", id = 1) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params: [] }),
  });
  return { status: response.status, body: await response.json() };
}

/** Fast timings so a test with five attempts finishes in well under a second. */
const FAST = { baseDelayMs: 5, maxDelayMs: 20, attemptTimeoutMs: 500 };

describe("rpc relay (fork suites' upstream retry + concurrency cap)", function () {
  let upstream;
  let relay;
  let lines;

  beforeEach(function () {
    lines = [];
  });

  afterEach(async function () {
    if (relay) await relay.stop();
    if (upstream) await upstream.close();
    relay = null;
    upstream = null;
  });

  it("retries HTTP 429 twice, then returns the upstream's 200 answer unchanged", async function () {
    upstream = await fakeUpstream((n, body, res) => {
      if (n <= 2) {
        res.writeHead(429, { "content-type": "text/plain" });
        res.end("Too Many Requests");
        return;
      }
      ok(res, body);
    });
    relay = await startRpcRelay({ upstream: upstream.url, label: "t", log: (l) => lines.push(l), ...FAST });

    const { status, body } = await call(relay.url, "eth_getStorageAt", 7);

    expect(status).to.equal(200);
    expect(body).to.deep.equal({ jsonrpc: "2.0", id: 7, result: "0x2a" });
    expect(upstream.count).to.equal(3);
    expect(relay.stats).to.include({ requests: 1, upstreamAttempts: 3, retries: 2, failed: 0 });
    const retries = lines.filter((l) => l.includes("retry"));
    expect(retries).to.have.length(2);
    expect(retries[0]).to.match(/\[t relay\] retry 2\/5 eth_getStorageAt: HTTP 429/);
    expect(retries[1]).to.match(/retry 3\/5 eth_getStorageAt: HTTP 429/);
  });

  it("retries a JSON-RPC rate-limit error body, but passes an ordinary JSON-RPC error through", async function () {
    upstream = await fakeUpstream((n, body, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      if (body.method === "eth_call") {
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: 3, message: "execution reverted" } }));
      } else if (n === 1) {
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32005, message: "daily request count exceeded" } }));
      } else {
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x2a" }));
      }
    });
    relay = await startRpcRelay({ upstream: upstream.url, log: (l) => lines.push(l), ...FAST });

    expect((await call(relay.url, "eth_getCode")).body.result).to.equal("0x2a");
    const reverted = await call(relay.url, "eth_call", 9);
    expect(reverted.body.error).to.deep.equal({ code: 3, message: "execution reverted" });
    expect(relay.stats.retries).to.equal(1);
    expect(upstream.count).to.equal(3);
  });

  it("fails hard after maxAttempts against an upstream that always fails", async function () {
    upstream = await fakeUpstream((n, body, res) => {
      res.writeHead(503);
      res.end("down");
    });
    relay = await startRpcRelay({ upstream: upstream.url, label: "t", log: (l) => lines.push(l), ...FAST });

    const { status, body } = await call(relay.url, "eth_chainId", 3);

    expect(status).to.equal(502);
    expect(body.id).to.equal(3);
    expect(body.error.message).to.match(/upstream failed 5 times, last: HTTP 503/);
    expect(upstream.count).to.equal(DEFAULTS.maxAttempts);
    expect(relay.stats).to.include({ failed: 1, retries: 4 });
    expect(relay.stats.lastError).to.match(/eth_chainId: HTTP 503 \(after 5 attempts\)/);
    expect(lines.some((l) => /FAILED eth_chainId/.test(l))).to.equal(true);
  });

  it("fails hard on an unreachable upstream and on one that never answers", async function () {
    const dead = await fakeUpstream(() => {});
    const deadUrl = dead.url;
    await dead.close();
    relay = await startRpcRelay({ upstream: deadUrl, log: (l) => lines.push(l), ...FAST, maxAttempts: 2 });
    const refused = await call(relay.url);
    expect(refused.status).to.equal(502);
    expect(refused.body.error.message).to.match(/network error/);
    await relay.stop();

    upstream = await fakeUpstream(() => {}); // accepts, never responds
    relay = await startRpcRelay({
      upstream: upstream.url,
      log: (l) => lines.push(l),
      ...FAST,
      attemptTimeoutMs: 50,
      maxAttempts: 2,
    });
    const hung = await call(relay.url);
    expect(hung.status).to.equal(502);
    expect(hung.body.error.message).to.match(/timeout after 50 ms/);
    expect(upstream.count).to.equal(2);
  });

  it("never has more than maxInFlight requests outstanding upstream", async function () {
    let inFlight = 0;
    let peak = 0;
    upstream = await fakeUpstream(async (n, body, res) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight -= 1;
      ok(res, body);
    });
    relay = await startRpcRelay({ upstream: upstream.url, log: (l) => lines.push(l), ...FAST, maxInFlight: 3 });

    const answers = await Promise.all(Array.from({ length: 12 }, (_, i) => call(relay.url, "eth_getBalance", i)));

    expect(answers.map((a) => a.body.id)).to.deep.equal([...Array(12).keys()]);
    expect(peak).to.equal(3);
    expect(relay.stats.maxInFlight).to.equal(3);
    expect(upstream.count).to.equal(12);
  });

  it("forwards a batch as one request and echoes every id in a hard failure", async function () {
    upstream = await fakeUpstream((n, body, res) => {
      res.writeHead(500);
      res.end();
    });
    relay = await startRpcRelay({ upstream: upstream.url, log: (l) => lines.push(l), ...FAST, maxAttempts: 2 });
    const response = await fetch(relay.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [] },
        { jsonrpc: "2.0", id: 2, method: "eth_getCode", params: [] },
      ]),
    });
    const body = await response.json();
    expect(response.status).to.equal(502);
    expect(body.map((b) => b.id)).to.deep.equal([1, 2]);
    expect(lines.some((l) => l.includes("batch[2] eth_getBalance,eth_getCode"))).to.equal(true);
  });

  it("honours Retry-After, and the pure helpers read what gateways send", async function () {
    upstream = await fakeUpstream((n, body, res) => {
      if (n === 1) {
        res.writeHead(429, { "retry-after": "0.2" });
        res.end();
        return;
      }
      ok(res, body);
    });
    relay = await startRpcRelay({ upstream: upstream.url, log: (l) => lines.push(l), ...FAST });
    const started = Date.now();
    expect((await call(relay.url)).status).to.equal(200);
    expect(Date.now() - started).to.be.at.least(190);
    expect(lines[0]).to.match(/waiting 200 ms/);

    expect(parseRetryAfter("3")).to.equal(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).to.equal(6000);
    expect(parseRetryAfter(null)).to.equal(null);
    expect(parseRetryAfter("soon")).to.equal(null);

    expect([1, 2, 3, 4, 5, 6].map((a) => backoffDelay(a, DEFAULTS))).to.deep.equal([
      300, 600, 1200, 2400, 4800, 5000,
    ]);

    expect(isRateLimitedBody({ error: { code: -32000, message: "Too Many Requests" } })).to.equal(true);
    expect(isRateLimitedBody({ error: { code: -32000, message: "over capacity" } })).to.equal(true);
    expect(isRateLimitedBody([{ result: "0x" }, { error: { code: 429, message: "x" } }])).to.equal(true);
    expect(isRateLimitedBody({ error: { code: 3, message: "execution reverted" } })).to.equal(false);
    expect(isRateLimitedBody({ result: "0x" })).to.equal(false);
  });

  it("binds the same port for the same upstream host, so Hardhat's fork cache stays warm", async function () {
    const a = stablePort("https://sepolia.infura.io/v3/KEY-ONE");
    expect(stablePort("https://sepolia.infura.io/v3/KEY-TWO")).to.equal(a);
    expect(stablePort("https://eth-mainnet.public.blastapi.io")).to.not.equal(a);
    expect(a).to.be.within(20_000, 39_999);

    upstream = await fakeUpstream((n, body, res) => ok(res, body));
    relay = await startRpcRelay({ upstream: upstream.url, log: (l) => lines.push(l), ...FAST });
    expect(relay.port).to.equal(stablePort(upstream.url));
    // The port is taken now, so a second relay for the same upstream falls back to a free one.
    const second = await startRpcRelay({ upstream: upstream.url, log: (l) => lines.push(l), ...FAST });
    try {
      expect(second.port).to.not.equal(relay.port);
      expect((await call(second.url)).body.result).to.equal("0x2a");
    } finally {
      await second.stop();
    }
  });
});
