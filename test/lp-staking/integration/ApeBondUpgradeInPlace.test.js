const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { expect } = require("chai");
const ethers = require("ethers");

const profiles = require("../helpers/profiles");
const forkNode = require("../helpers/fork-node");
const chain = require("../helpers/chain");
const runner = require("../helpers/scripts");

/**
 * The ApeBond live-day sequence, rehearsed end to end against a FORK OF LIVE SEPOLIA.
 *
 * ── What this is ──────────────────────────────────────────────────────────────────────
 *
 * Every other ApeBond tier in this repo proves the code. `DeployApeBond.test.js` runs
 * `scripts/deploy-apebond.js` as a child process, and `ApeBondOperatorScripts.test.js` runs
 * the three scripts that follow it — but both build their world out of mocks on an empty
 * `hardhat node`, so what they prove is that the SCRIPTS are correct. Neither can prove
 * anything about **Sepolia test stack #5**, which is a specific set of contracts, deployed
 * on specific days, holding a specific staked position (NFT 231913) and owned by a specific
 * timelock with a 300-second `minDelay`.
 *
 * This suite proves that. It forks live Sepolia at the CHAIN HEAD, impersonates the two
 * seats the live sequence uses, and then runs the repo's own four scripts, unmodified, as
 * child processes, in the exact order and with the exact environment the runbook in
 * `scripts/README.md` prescribes:
 *
 *   1. `scripts/deploy-apebond.js`     the in-place UUPS upgrade + escrow + adapter + the
 *                                      timelock batch, waited out and executed
 *   2. `scripts/set-purchase-signer.js` the guardian's one undelayed transaction
 *   3. `scripts/fund-escrow.js`         10,000 tASSET into the escrow proxy
 *   4. `scripts/apebond-rehearsal.js`   one real purchase against the REAL Uniswap Sepolia
 *                                       position manager and the REAL tASSET/tUSDC pool,
 *                                       then the claim after the cliff
 *
 * Nothing about the live chain is written: every transaction lands on the local fork, and
 * the only traffic that reaches the endpoint is the READS the fork needs to answer.
 *
 * ── Opt-in, and NOT a CI gate ─────────────────────────────────────────────────────────
 *
 * Two conditions, both required, or the suite skips and says which one is missing:
 *
 *   * `LP_APEBOND_DRYRUN=1` — the explicit request;
 *   * an endpoint for the sepolia profile (`SEPOLIA_RPC_URL` or `INFURA_API_KEY`).
 *
 * The flag is what keeps this out of CI, and the reason it has to is the fork block. Every
 * other fork suite here pins its block, which is what makes it deterministic: the same
 * block serves the same state today and in a year. This one CANNOT pin, because stack #5
 * was deployed long after every pinned block in this repo — at block 11,562,000 the vault
 * proxy has no code at all. So it forks the head, and the head is a moving target: the pool
 * price, the staked position, the operator's balances and the timelock's configuration are
 * all whatever Sepolia happens to hold at the minute the node starts. A gate that can go
 * red because somebody else moved the pool is not a gate. `.github/workflows/ci.yml` never
 * sets `LP_APEBOND_DRYRUN`, so `npx hardhat test` in CI reports this suite as pending.
 *
 * Note the interaction with the repo's fail-closed rule: once `LP_APEBOND_DRYRUN=1` IS set
 * and an endpoint IS configured, a fork that cannot be established FAILS the run rather
 * than skipping it, exactly as `fork-node.decideOnForkFailure` decides for every other
 * suite. The opt-in flag is the only thing this suite adds to that rule.
 *
 *     LP_APEBOND_DRYRUN=1 npx hardhat test test/lp-staking/integration/ApeBondUpgradeInPlace.test.js
 *
 * ── Impersonation instead of keys ─────────────────────────────────────────────────────
 *
 * The sequence needs two live accounts: the operator `0x5576bD37…`, which is the deployer,
 * the timelock's proposer and executor, and the adapter's guardian, and the SoulZap seat
 * `0x2b9818c8…`, which mints the campaign position and calls `depositFor`. Their private
 * keys are not here and must not be. On a fork they are not needed: the node unlocks any
 * account on `hardhat_impersonateAccount`, and two new environment variables —
 * `LP_DEPLOYER_IMPERSONATE` and `LP_REHEARSAL_CALLER_IMPERSONATE` — let the scripts send as
 * those accounts. Both are honoured on chain id 31337 ONLY and throw loudly anywhere else;
 * the rule and its reasoning live in `scripts/lib/pools.js:impersonatedSignerFromEnv`.
 *
 * ── Nothing in the repository is written ──────────────────────────────────────────────
 *
 * The scripts record into `DEPLOYMENTS_FILE`, a scratch copy of the tracked registry with
 * the live stack's entry ALSO recorded under chain 31337 — which is what the fork is: the
 * state of Sepolia, on a node that reports 31337. The tracked registry's sha256 and the
 * committed `.openzeppelin/sepolia.json`'s sha256 are captured before the run and asserted
 * after it, and `git status --porcelain` must read exactly what it read at the start.
 *
 * The `hardhat-upgrades` manifest deserves a sentence of its own, because it is the one
 * file that could plausibly be rewritten. On a forked development node the plugin does not
 * use `.openzeppelin/sepolia.json` as its manifest at all: `Manifest.forNetwork` detects a
 * Hardhat dev instance, writes to `<os.tmpdir()>/openzeppelin-upgrades/hardhat-31337-<id>.json`,
 * and keeps the FORKED chain's committed file as a read-only PARENT. So the storage layout
 * the upgrade is validated against is the real one recorded for the live vault
 * implementation `0xEac50B6B…`, and every write lands in the OS temp directory.
 */

/** Captured before a single test runs; asserted again at the very end. */
const TRACKED_REGISTRY_SHA256 = runner.sha256File(runner.TRACKED_REGISTRY);

/** The world: Sepolia, at the head rather than at the profile's pinned block. */
const P = profiles.sepolia;

/** The registry key the live stack is recorded under, and the one the fork reports. */
const LIVE_CHAIN_KEY = "11155111";
const FORK_CHAIN_KEY = "31337";
const FORK_CHAIN_ID = 31337;

/**
 * The two live seats. Both are read back off the registry entry as well, and the suite
 * refuses to run if the registry disagrees — naming them here is what makes a silent
 * registry edit fail loudly rather than redirect the rehearsal at some other account.
 */
const OPERATOR = "0x5576bD37419dadAab305cca998E16BcD73318A35";
const GUARDIAN = "0x2b9818c80E82363f5Cf21aD5DEEf1948D5F9bBEA";

/** The one live staked position on stack #5, staked by the operator on 2026-09-14. */
const STAKED_TOKEN_ID = "231913";

/**
 * The campaign range: the seed position's own range on the tASSET/tUSDC 0.30% pool, stated
 * outright rather than derived from the current tick. Both bounds sit on the 60-tick grid
 * the 3000 fee tier uses (-297120 / 60 = -4952, -283260 / 60 = -4721), and the range
 * straddles the pool's ~0.25 tUSDC-per-tASSET price, so the mint needs both tokens.
 */
const TICK_LOWER = "-297120";
const TICK_UPPER = "-283260";

/** The rehearsal's cliff. Short enough to push past with one `evm_increaseTime`. */
const CLIFF_SECONDS = 600;
const CLIFF_PUMP_SECONDS = 601;

/** What the escrow is funded with, in whole bonus tokens. The sample bonus is 495. */
const ESCROW_FUNDING_WHOLE = "10000";

/** What the SoulZap seat is given to mint with, in whole tokens of each side. */
const CALLER_ASSET_WHOLE = 10_000n;
const CALLER_USDC_WHOLE = 2_500n;

/** Plenty of ETH for gas on the fork, for every account this suite sends from. */
const FORK_ETH = ethers.parseEther("10000");

/** Child-process ceilings. A fork at the head is cold, so the first run is the slow one. */
const DEPLOY_TIMEOUT_MS = 20 * 60 * 1000;
const SCRIPT_TIMEOUT_MS = 10 * 60 * 1000;

/** ERC-1967 implementation slot: keccak256("eip1967.proxy.implementation") - 1. */
const ERC1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const VAULT_IFACE = new ethers.Interface([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function guardian() view returns (address)",
  "function operator() view returns (address)",
  "function zapper() view returns (address)",
  "function twapWindow() view returns (uint32)",
  "function maxTwapDeviationTicks() view returns (uint24)",
  "function depositsPaused() view returns (bool)",
  "function rebalancePaused() view returns (bool)",
  "function stakerOf(uint256 tokenId) view returns (address)",
  "function isStakeOperator(address account) view returns (bool)",
  "function positionManager() view returns (address)",
  "function pool() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function unstake(uint256 tokenId)",
]);

const ESCROW_IFACE = new ethers.Interface([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function adapter() view returns (address)",
  "function bonusToken() view returns (address)",
  "function totalReserved() view returns (uint256)",
  "function reservationOf(bytes32 purchaseId) view returns (address beneficiary,uint256 amount,uint64 unlockAt,bool claimed)",
  "function claimable(bytes32 purchaseId) view returns (uint256)",
]);

const ADAPTER_IFACE = new ethers.Interface([
  "function owner() view returns (address)",
  "function vault() view returns (address)",
  "function escrow() view returns (address)",
  "function guardian() view returns (address)",
  "function purchaseSigner() view returns (address)",
  "function depositsPaused() view returns (bool)",
  "function soulZapCallers(address caller) view returns (bool)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
]);

const ERC20_IFACE = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to,uint256 value) returns (bool)",
]);

const NPM_IFACE = new ethers.Interface([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function positions(uint256 tokenId) view returns (uint96 nonce,address operator,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128,uint128 tokensOwed0,uint128 tokensOwed1)",
]);

const TIMELOCK_IFACE = new ethers.Interface([
  "function getMinDelay() view returns (uint256)",
  "function PROPOSER_ROLE() view returns (bytes32)",
  "function EXECUTOR_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role,address account) view returns (bool)",
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `git status --porcelain` in the repository this suite runs from, as a set of lines. */
function gitStatus() {
  const out = execFileSync("git", ["status", "--porcelain"], {
    cwd: forkNode.REPO_ROOT,
    encoding: "utf8",
  });
  return new Set(out.split("\n").filter((line) => line.trim() !== ""));
}

/**
 * Runs `fn` while the node's clock is pushed forward, and stops pushing when it returns.
 *
 * Same harness `DeployApeBond.test.js` uses, and for the same reason: `deploy-apebond.js`
 * measures its wait in CHAIN time — the latest block's own timestamp, which is what
 * `executeBatch` compares against — so five seconds of chain time every 150 ms of wall
 * clock clears stack #5's 300-second `minDelay` in about nine seconds. Errors are swallowed
 * because the node may be mid-transaction; the next tick makes up for the missed one.
 *
 * It is used for the activation ONLY. Nothing else in this suite may run under it: the
 * purchase authorization carries a one-hour `deadline` and a 600-second bonus cliff, and a
 * clock running at thirty times wall speed would expire the first and pass the second while
 * the run is still asserting that it has not.
 */
async function withTimePump(provider, fn) {
  let running = true;
  const pump = (async () => {
    while (running) {
      try {
        await provider.send("evm_increaseTime", [5]);
        await provider.send("evm_mine", []);
      } catch {
        /* the node is busy; the next tick makes up for it */
      }
      await sleep(150);
    }
  })();

  try {
    return await fn();
  } finally {
    running = false;
    await pump;
  }
}

describe("ApeBond activation, rehearsed on a fork of live Sepolia (stack #5)", function () {
  // A cold fork of the chain head, four script children, one real Uniswap mint and a
  // timelock batch. Slow, and every second of it is the real scripts against real state.
  this.timeout(45 * 60 * 1000);

  // ── run state ───────────────────────────────────────────────────────────
  let node = null;
  let provider = null;
  let scratchDir = null;
  let registryFile = null;
  let logFile = null;
  let recordFile = null;
  let fees = null;
  let rpcUsed = null;
  let forkHead = null;

  let gitStatusAtStart = null;
  let manifestSha256AtStart = null;
  const manifestFile = path.join(forkNode.REPO_ROOT, ".openzeppelin", "sepolia.json");

  /** The live stack, read out of the tracked registry. */
  let live = null;

  let vault, timelock, npm, token0, token1, escrow, adapter;
  let token0Address, token1Address, npmAddress, poolAddress;
  let decimals0, decimals1, symbol0, symbol1;

  let operatorSigner = null;
  let beneficiaryWallet = null;
  let beneficiarySigner = null;
  let purchaseSignerWallet = null;

  /** The vault state the whole sequence must leave exactly where it found it. */
  let baseline = null;

  /** Everything the summary table prints. */
  const summary = { addresses: {}, transactions: {}, facts: {} };

  /** Per-phase child-process results, so a later `it` can assert an earlier phase's output. */
  const runs = {};

  /** The rehearsal record the deposit phase wrote. */
  let record = null;
  const at = (address, iface) => new ethers.Contract(address, iface, provider);
  const entry = (kind) => runner.registryEntry(registryFile, FORK_CHAIN_ID, kind);

  async function implementationOf(proxy) {
    const word = await provider.getStorage(proxy, ERC1967_IMPLEMENTATION_SLOT);
    return ethers.getAddress("0x" + word.slice(-40));
  }

  /** Unlocks an account on the fork, gives it gas, and returns a signer that sends as it. */
  async function impersonate(address) {
    const checksummed = ethers.getAddress(address);
    await provider.send("hardhat_impersonateAccount", [checksummed]);
    await provider.send("hardhat_setBalance", [checksummed, ethers.toBeHex(FORK_ETH)]);
    return chain.pinFees(new ethers.JsonRpcSigner(provider, checksummed), fees);
  }

  /** Pushes chain time forward by `seconds` and mines one block, once. */
  async function pumpTime(seconds) {
    await provider.send("evm_increaseTime", [seconds]);
    await provider.send("evm_mine", []);
  }

  /** The environment every child gets: the node, the scratch registry, and nothing else. */
  function baseEnv(extra = {}) {
    return {
      LOCALHOST_RPC_URL: node.rpcUrl,
      LOCALHOST_GAS_PRICE: String(fees.maxFeePerGas),
      DEPLOYMENTS_FILE: registryFile,
      ...extra,
    };
  }

  /** Runs one script and refuses a non-zero exit, with the child's own output in the error. */
  async function runOk(script, extra, { timeoutMs = SCRIPT_TIMEOUT_MS, pump = false } = {}) {
    const invoke = () =>
      runner.runHardhatScript(`scripts/${script}`, baseEnv(extra), { logFile, timeoutMs });
    const result = pump ? await withTimePump(provider, invoke) : await invoke();
    if (result.code !== 0) {
      throw new Error(
        `scripts/${script} exited ${result.code}\n--- stdout ---\n${result.stdout}\n` +
          `--- stderr ---\n${result.stderr}`
      );
    }
    return result;
  }

  // ─────────────────────────────────────────────────────────────
  before(async function () {
    // ── Phase 0: the two opt-in gates. The only place a skip is legal. ────────────────
    if (process.env.LP_APEBOND_DRYRUN !== "1") {
      console.warn(
        "\n  [apebond-dryrun] skipping — this suite rehearses the ApeBond activation against a\n" +
          "  fork of live Sepolia at the CHAIN HEAD, which is not deterministic and is therefore\n" +
          "  not a CI gate. Ask for it explicitly:\n" +
          "    LP_APEBOND_DRYRUN=1 npx hardhat test " +
          "test/lp-staking/integration/ApeBondUpgradeInPlace.test.js\n"
      );
      this.skip();
      return;
    }
    if (!profiles.isConfigured(P)) {
      console.warn(
        `\n  [apebond-dryrun] skipping — LP_APEBOND_DRYRUN=1 asks for the dry-run, but no Sepolia\n` +
          `  endpoint is configured. Set ${P.rpc.envUrl} or INFURA_API_KEY and re-run.\n`
      );
      this.skip();
      return;
    }

    gitStatusAtStart = gitStatus();
    manifestSha256AtStart = runner.sha256File(manifestFile);

    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-apebond-dryrun-"));
    registryFile = path.join(scratchDir, "deployments.json");
    logFile = path.join(scratchDir, "scripts.log");
    recordFile = path.join(scratchDir, `apebond-rehearsal-${FORK_CHAIN_ID}.json`);

    // ── Phase 1: the registry the children read ──────────────────────────────────────
    //
    // The tracked file, copied, with the live stack's entry recorded under 31337 as well.
    // That is precisely what the fork is — Sepolia's state, on a node that calls itself
    // 31337 — and it is the one translation the scripts cannot make for themselves, since
    // every one of them resolves its addresses by `readRegistry()[String(chainId)]`.
    const tracked = JSON.parse(fs.readFileSync(runner.TRACKED_REGISTRY, "utf8"));
    live = tracked[LIVE_CHAIN_KEY];
    expect(live, `deployments.json has no chain ${LIVE_CHAIN_KEY} entry`).to.be.an("object");
    fs.writeFileSync(
      registryFile,
      JSON.stringify({ ...tracked, [FORK_CHAIN_KEY]: live }, null, 2) + "\n"
    );

    // The two seats, cross-checked against the registry. A registry that names anybody else
    // is a registry that describes another stack, and impersonating the wrong account would
    // rehearse a sequence nobody is going to run.
    expect(ethers.getAddress(live.LPStakingVault.operator)).to.equal(ethers.getAddress(OPERATOR));
    expect(ethers.getAddress(live.LPStakingVault.guardian)).to.equal(ethers.getAddress(GUARDIAN));
    expect(live.TimelockController.proposers.map(ethers.getAddress)).to.include(
      ethers.getAddress(OPERATOR)
    );
    expect(live.TimelockController.executors.map(ethers.getAddress)).to.include(
      ethers.getAddress(OPERATOR)
    );

    // ── Phase 2: the fork, at the head ───────────────────────────────────────────────
    const established = await forkNode.establishFork({
      logDir: scratchDir,
      profile: P,
      blockNumber: forkNode.LATEST_BLOCK,
    });
    // `establishFork` returns null only when nothing was configured, and phase 0 already
    // proved something is. A null here would be a defect in that rule, not an environment.
    expect(established, "the fork could not be established although an endpoint is set").to.not.equal(
      null
    );
    node = established.node;
    provider = established.provider;
    rpcUsed = established.url;
    forkHead = established.probe.head;

    fees = await chain.derivePinnedFees(provider);

    // ── Phase 3: the seats ───────────────────────────────────────────────────────────
    operatorSigner = await impersonate(OPERATOR);
    await impersonate(GUARDIAN);

    // A fresh buyer, so the rehearsal's beneficiary holds nothing before the claim and the
    // "grew by exactly the bonus" assertion has no other explanation. It needs gas of its
    // own because it unstakes the position itself.
    beneficiaryWallet = ethers.Wallet.createRandom();
    beneficiarySigner = await impersonate(beneficiaryWallet.address);

    // The backend's signing key, generated here and never written anywhere: the point of
    // `set-purchase-signer.js` is that the adapter ends up recovering to THIS key.
    purchaseSignerWallet = ethers.Wallet.createRandom();

    // ── Phase 4: bind to the live stack ──────────────────────────────────────────────
    vault = at(live.LPStakingVault.address, VAULT_IFACE);
    timelock = at(live.TimelockController.address, TIMELOCK_IFACE);

    npmAddress = ethers.getAddress(await vault.positionManager());
    poolAddress = ethers.getAddress(await vault.pool());
    token0Address = ethers.getAddress(await vault.token0());
    token1Address = ethers.getAddress(await vault.token1());
    npm = at(npmAddress, NPM_IFACE);
    token0 = at(token0Address, ERC20_IFACE);
    token1 = at(token1Address, ERC20_IFACE);
    [decimals0, decimals1, symbol0, symbol1] = await Promise.all([
      token0.decimals().then(Number),
      token1.decimals().then(Number),
      token0.symbol(),
      token1.symbol(),
    ]);

    // ── Phase 5: the "before" side, read off the live proxies ────────────────────────
    //
    // `isStakeOperator` is deliberately NOT read here: the implementation the proxy runs
    // today has no such function, so the call reverts, and "reverts" is the fact this run
    // is about to change.
    baseline = {
      vaultImplementation: await implementationOf(live.LPStakingVault.address),
      distributorImplementation: await implementationOf(live.RewardsDistributor.address),
      owner: ethers.getAddress(await vault.owner()),
      pendingOwner: ethers.getAddress(await vault.pendingOwner()),
      guardian: ethers.getAddress(await vault.guardian()),
      operator: ethers.getAddress(await vault.operator()),
      zapper: ethers.getAddress(await vault.zapper()),
      twapWindow: Number(await vault.twapWindow()),
      maxTwapDeviationTicks: Number(await vault.maxTwapDeviationTicks()),
      depositsPaused: await vault.depositsPaused(),
      rebalancePaused: await vault.rebalancePaused(),
      staker: ethers.getAddress(await vault.stakerOf(STAKED_TOKEN_ID)),
      nftOwner: ethers.getAddress(await npm.ownerOf(STAKED_TOKEN_ID)),
      minDelay: await timelock.getMinDelay(),
    };

    summary.facts.endpoint = redactRpc(rpcUsed);
    summary.facts.forkHead = String(forkHead);
    summary.facts["pool pair"] = `${symbol0} (${decimals0}) / ${symbol1} (${decimals1})`;
    summary.facts["vault impl (before)"] = baseline.vaultImplementation;
    summary.facts["timelock minDelay"] = `${baseline.minDelay}s`;
    summary.facts["staked NFT " + STAKED_TOKEN_ID] = baseline.staker;
    summary.addresses["LPStakingVault (proxy)"] = live.LPStakingVault.address;
    summary.addresses["LPTimelock"] = live.TimelockController.address;
    summary.addresses["RewardsDistributor (proxy)"] = live.RewardsDistributor.address;
    summary.addresses["UniswapV3Pool"] = poolAddress;
    summary.addresses["NonfungiblePositionManager"] = npmAddress;
    summary.addresses["operator / deployer (impersonated)"] = ethers.getAddress(OPERATOR);
    summary.addresses["SoulZap seat (impersonated)"] = ethers.getAddress(GUARDIAN);
    summary.addresses["beneficiary (fresh)"] = beneficiaryWallet.address;
    summary.addresses["purchase signer (generated)"] = purchaseSignerWallet.address;
  });

  after(async function () {
    if (node) await node.stop();
    if (provider) provider.destroy();
    if (Object.keys(summary.addresses).length > 0) printSummary(summary);
    if (scratchDir) fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  // ─────────────────────────────────────────────────────────────
  describe("0. the live stack the fork is standing on", function () {
    it("forks Sepolia ahead of the profile's pinned block", function () {
      expect(forkHead).to.be.greaterThan(P.pinnedBlock);
    });

    it("has the vault owned by the 300-second timelock", function () {
      expect(baseline.owner).to.equal(ethers.getAddress(live.TimelockController.address));
      expect(baseline.minDelay).to.equal(300n);
    });

    it("has the operator as both proposer and executor on that timelock", async function () {
      const [proposer, executor] = await Promise.all([
        timelock.PROPOSER_ROLE(),
        timelock.EXECUTOR_ROLE(),
      ]);
      expect(await timelock.hasRole(proposer, OPERATOR)).to.equal(true);
      expect(await timelock.hasRole(executor, OPERATOR)).to.equal(true);
    });

    it(`holds NFT ${STAKED_TOKEN_ID}, credited to the operator`, function () {
      expect(baseline.nftOwner).to.equal(ethers.getAddress(live.LPStakingVault.address));
      expect(baseline.staker).to.equal(ethers.getAddress(OPERATOR));
    });

    it("runs an implementation that has no setStakeOperator yet", async function () {
      expect(baseline.vaultImplementation).to.equal(
        ethers.getAddress(live.LPStakingVault.implementation)
      );
      let reverted = false;
      try {
        await vault.isStakeOperator(ethers.ZeroAddress);
      } catch {
        reverted = true;
      }
      expect(reverted, "the live implementation already has the stake-operator allowlist").to.equal(
        true
      );
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("1. scripts/deploy-apebond.js — the in-place activation", function () {
    before(async function () {
      runs.activate = await runOk(
        "deploy-apebond.js",
        {
          LP_DEPLOYER_IMPERSONATE: ethers.getAddress(OPERATOR),
          LP_APEBOND_SOULZAP_CALLERS: ethers.getAddress(GUARDIAN),
          LP_APEBOND_ASSERT_POSITIONS: STAKED_TOKEN_ID,
          LP_APEBOND_WAIT_POLL_MS: "200",
        },
        { timeoutMs: DEPLOY_TIMEOUT_MS, pump: true }
      );

      escrow = at(entry("BonusEscrow").address, ESCROW_IFACE);
      adapter = at(entry("ApeBondPositionAdapter").address, ADAPTER_IFACE);
      summary.addresses["BonusEscrow (proxy)"] = entry("BonusEscrow").address;
      summary.addresses["BonusEscrow implementation"] = entry("BonusEscrow").implementation;
      summary.addresses["ApeBondPositionAdapter"] = entry("ApeBondPositionAdapter").address;
      summary.addresses["LPStakingVault implementation (new)"] = await implementationOf(
        live.LPStakingVault.address
      );
      summary.transactions["vault implementation deploy"] = entry("LPStakingVault").implementationTx;
      summary.transactions["escrow implementation deploy"] =
        entry("BonusEscrow").implementationTx;
      summary.transactions["escrow proxy deploy"] = entry("BonusEscrow").deployTx;
      summary.transactions["adapter deploy"] = entry("ApeBondPositionAdapter").deployTx;
    });

    it("says its own post-checks passed", function () {
      expect(runs.activate.stdout).to.include("All post-activation checks passed.");
      expect(runs.activate.stdout).to.include("phase 5: the timelock batch");
      expect(runs.activate.stdout).to.match(/waiting: -?\d+s of CHAIN time left/);
      // The impersonation is the thing that made it possible to send anything at all, so
      // the run has to have said which account it was acting as.
      expect(runs.activate.stdout).to.include(
        `LP_DEPLOYER_IMPERSONATE: impersonating ${ethers.getAddress(OPERATOR)}`
      );
    });

    it("moved the proxy onto a NEW implementation", async function () {
      const now = await implementationOf(live.LPStakingVault.address);
      expect(now).to.not.equal(baseline.vaultImplementation);
      expect(now).to.equal(ethers.getAddress(entry("LPStakingVault").implementation));
      expect(entry("LPStakingVault")).to.not.have.property("pendingImplementation");
    });

    it("allowlisted the adapter as a stake operator on the vault", async function () {
      expect(await vault.isStakeOperator(await adapter.getAddress())).to.equal(true);
    });

    it("left the escrow born owned by the timelock and pointing at the adapter", async function () {
      expect(await escrow.owner()).to.equal(ethers.getAddress(live.TimelockController.address));
      expect(await escrow.pendingOwner()).to.equal(ethers.ZeroAddress);
      expect(await escrow.adapter()).to.equal(await adapter.getAddress());
      expect(await escrow.bonusToken()).to.equal(token0Address);
      expect(await escrow.totalReserved()).to.equal(0n);
    });

    it("handed the adapter to the timelock, guarded by the operator, with the route CLOSED", async function () {
      expect(await adapter.owner()).to.equal(ethers.getAddress(live.TimelockController.address));
      expect(await adapter.guardian()).to.equal(ethers.getAddress(OPERATOR));
      expect(await adapter.purchaseSigner()).to.equal(ethers.ZeroAddress);
      expect(await adapter.depositsPaused()).to.equal(false);
      expect(await adapter.vault()).to.equal(ethers.getAddress(live.LPStakingVault.address));
      expect(await adapter.escrow()).to.equal(await escrow.getAddress());
      expect(await adapter.token0()).to.equal(token0Address);
      expect(await adapter.token1()).to.equal(token1Address);
    });

    it("allowlisted the SoulZap seat on the adapter", async function () {
      expect(await adapter.soulZapCallers(GUARDIAN)).to.equal(true);
    });

    it("moved no field of the live vault's state", async function () {
      expect({
        owner: ethers.getAddress(await vault.owner()),
        pendingOwner: ethers.getAddress(await vault.pendingOwner()),
        guardian: ethers.getAddress(await vault.guardian()),
        operator: ethers.getAddress(await vault.operator()),
        zapper: ethers.getAddress(await vault.zapper()),
        twapWindow: Number(await vault.twapWindow()),
        maxTwapDeviationTicks: Number(await vault.maxTwapDeviationTicks()),
        depositsPaused: await vault.depositsPaused(),
        rebalancePaused: await vault.rebalancePaused(),
      }).to.deep.equal({
        owner: baseline.owner,
        pendingOwner: baseline.pendingOwner,
        guardian: baseline.guardian,
        operator: baseline.operator,
        zapper: baseline.zapper,
        twapWindow: baseline.twapWindow,
        maxTwapDeviationTicks: baseline.maxTwapDeviationTicks,
        depositsPaused: baseline.depositsPaused,
        rebalancePaused: baseline.rebalancePaused,
      });
    });

    it(`left NFT ${STAKED_TOKEN_ID} staked, credited to the same address`, async function () {
      expect(ethers.getAddress(await vault.stakerOf(STAKED_TOKEN_ID))).to.equal(baseline.staker);
      expect(ethers.getAddress(await npm.ownerOf(STAKED_TOKEN_ID))).to.equal(baseline.nftOwner);
    });

    it("left the distributor's implementation slot untouched", async function () {
      expect(await implementationOf(live.RewardsDistributor.address)).to.equal(
        baseline.distributorImplementation
      );
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("2. scripts/set-purchase-signer.js — the guardian opens the route", function () {
    before(async function () {
      runs.signer = await runOk("set-purchase-signer.js", {
        LP_DEPLOYER_IMPERSONATE: ethers.getAddress(OPERATOR),
        LP_APEBOND_PURCHASE_SIGNER_KEY: purchaseSignerWallet.privateKey,
      });
      summary.transactions["setPurchaseSigner"] = lastTxHash(runs.signer.stdout);
    });

    it("points the adapter at the generated key, without ever printing it", async function () {
      expect(await adapter.purchaseSigner()).to.equal(purchaseSignerWallet.address);
      expect(runs.signer.stdout).to.not.include(purchaseSignerWallet.privateKey);
      expect(runs.signer.stdout).to.include("The deposit path is OPEN");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("3. scripts/fund-escrow.js — bonus tokens into the escrow", function () {
    let escrowBefore;

    before(async function () {
      escrowBefore = await token0.balanceOf(await escrow.getAddress());
      runs.fund = await runOk("fund-escrow.js", {
        LP_DEPLOYER_IMPERSONATE: ethers.getAddress(OPERATOR),
        LP_APEBOND_FUND_AMOUNT: ESCROW_FUNDING_WHOLE,
      });
      summary.transactions["fund escrow"] = lastTxHash(runs.fund.stdout);
    });

    it(`moved exactly ${ESCROW_FUNDING_WHOLE} whole bonus tokens into the escrow`, async function () {
      const expected = ethers.parseUnits(ESCROW_FUNDING_WHOLE, decimals0);
      expect((await token0.balanceOf(await escrow.getAddress())) - escrowBefore).to.equal(expected);
      expect(await escrow.totalReserved()).to.equal(0n);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("4. scripts/apebond-rehearsal.js — one real purchase, deposit phase", function () {
    let callerAsset, callerUsdc;

    before(async function () {
      // The SoulZap seat holds nothing on Sepolia, so the operator — who holds millions of
      // both test tokens — funds it, exactly as an operator would before a live rehearsal.
      callerAsset = CALLER_ASSET_WHOLE * 10n ** BigInt(decimals0);
      callerUsdc = CALLER_USDC_WHOLE * 10n ** BigInt(decimals1);
      await chain.send(token0.connect(operatorSigner).transfer(GUARDIAN, callerAsset));
      await chain.send(token1.connect(operatorSigner).transfer(GUARDIAN, callerUsdc));

      runs.deposit = await runOk("apebond-rehearsal.js", {
        LP_REHEARSAL_CALLER_IMPERSONATE: ethers.getAddress(GUARDIAN),
        LP_REHEARSAL_BENEFICIARY: beneficiaryWallet.address,
        LP_APEBOND_PURCHASE_SIGNER_KEY: purchaseSignerWallet.privateKey,
        LP_REHEARSAL_CLIFF_SECONDS: String(CLIFF_SECONDS),
        LP_REHEARSAL_TICK_LOWER: TICK_LOWER,
        LP_REHEARSAL_TICK_UPPER: TICK_UPPER,
      });

      record = JSON.parse(fs.readFileSync(recordFile, "utf8"));
      summary.facts["purchase id"] = record.purchaseId;
      summary.facts["position minted"] = record.tokenId;
      summary.facts["campaign range"] = `[${record.tickLower}, ${record.tickUpper}]`;
      summary.facts["bonus"] = `${ethers.formatUnits(record.guaranteedBonusAmount, record.bonusDecimals)} ${record.bonusSymbol}`;
      summary.transactions["mint (real NPM)"] = record.deposit.mintTx;
      summary.transactions["approve adapter for the NFT"] = record.deposit.approveNftTx;
      summary.transactions["depositFor"] = record.deposit.depositTx;
    });

    it("says the deposit phase passed", function () {
      expect(runs.deposit.stdout).to.include("The deposit phase passed");
      expect(runs.deposit.stdout).to.not.include("FAIL");
      expect(runs.deposit.stdout).to.include(
        `LP_REHEARSAL_CALLER_IMPERSONATE: impersonating ${ethers.getAddress(GUARDIAN)}`
      );
    });

    it("minted the campaign range on the REAL position manager", async function () {
      const position = await npm.positions(record.tokenId);
      expect(Number(position.tickLower)).to.equal(Number(TICK_LOWER));
      expect(Number(position.tickUpper)).to.equal(Number(TICK_UPPER));
      expect(position.token0).to.equal(token0Address);
      expect(position.token1).to.equal(token1Address);
      expect(BigInt(position.liquidity)).to.equal(BigInt(record.liquidity));
      expect(BigInt(record.liquidity)).to.be.greaterThan(0n);
    });

    it("gave the VAULT custody and credited the BENEFICIARY, not the caller", async function () {
      expect(await npm.ownerOf(record.tokenId)).to.equal(
        ethers.getAddress(live.LPStakingVault.address)
      );
      expect(await vault.stakerOf(record.tokenId)).to.equal(beneficiaryWallet.address);
    });

    it("reserved the bonus for the beneficiary, unclaimable until the cliff", async function () {
      const reservation = await escrow.reservationOf(record.purchaseId);
      expect(reservation.beneficiary).to.equal(beneficiaryWallet.address);
      expect(reservation.amount).to.equal(BigInt(record.guaranteedBonusAmount));
      expect(reservation.unlockAt).to.equal(BigInt(record.bonusUnlockAt));
      expect(reservation.claimed).to.equal(false);
      expect(await escrow.totalReserved()).to.equal(BigInt(record.guaranteedBonusAmount));
      expect(await escrow.claimable(record.purchaseId)).to.equal(0n);
    });

    it("emitted ApeBondPositionDeposited with the purchase's own figures", async function () {
      const receipt = await provider.getTransactionReceipt(record.deposit.depositTx);
      const adapterAddress = await adapter.getAddress();
      const deposited = receipt.logs
        .filter((log) => log.address.toLowerCase() === adapterAddress.toLowerCase())
        .map((log) => {
          try {
            return DEPOSITED_IFACE.parseLog({ topics: [...log.topics], data: log.data });
          } catch {
            return null;
          }
        })
        .find((parsed) => parsed && parsed.name === "ApeBondPositionDeposited");

      expect(deposited, "no ApeBondPositionDeposited log in the depositFor receipt").to.not.equal(
        undefined
      );
      expect(deposited.args.purchaseId).to.equal(record.purchaseId);
      expect(deposited.args.beneficiary).to.equal(beneficiaryWallet.address);
      expect(deposited.args.tokenId).to.equal(BigInt(record.tokenId));
      expect(deposited.args.liquidity).to.equal(BigInt(record.liquidity));
      expect(deposited.args.guaranteedBonusAmount).to.equal(BigInt(record.guaranteedBonusAmount));
      expect(deposited.args.bonusUnlockAt).to.equal(BigInt(record.bonusUnlockAt));
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("5. the buyer walks away before the cliff", function () {
    // The bonus is an obligation of the escrow to a named address, not a property of the
    // position. A buyer who unstakes the moment the purchase lands must still be paid — and
    // must still have to wait out the cliff to be paid.
    before(async function () {
      const receipt = await chain.send(
        new ethers.Contract(live.LPStakingVault.address, VAULT_IFACE, beneficiarySigner).unstake(
          record.tokenId
        )
      );
      summary.transactions["beneficiary unstake"] = receipt.hash;
    });

    it("returns the NFT to the beneficiary and clears the vault's record", async function () {
      expect(await npm.ownerOf(record.tokenId)).to.equal(beneficiaryWallet.address);
      expect(await vault.stakerOf(record.tokenId)).to.equal(ethers.ZeroAddress);
    });

    it("leaves the bonus reserved and still unclaimable before the cliff", async function () {
      expect(await escrow.claimable(record.purchaseId)).to.equal(0n);
      expect((await escrow.reservationOf(record.purchaseId)).claimed).to.equal(false);
    });

    it(`makes the whole bonus claimable once ${CLIFF_PUMP_SECONDS}s of chain time pass`, async function () {
      await pumpTime(CLIFF_PUMP_SECONDS);
      expect(await escrow.claimable(record.purchaseId)).to.equal(
        BigInt(record.guaranteedBonusAmount)
      );
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("6. scripts/apebond-rehearsal.js — the claim phase", function () {
    let beneficiaryBefore;

    before(async function () {
      beneficiaryBefore = await token0.balanceOf(beneficiaryWallet.address);
      runs.claim = await runOk("apebond-rehearsal.js", {
        LP_REHEARSAL_PHASE: "claim",
        LP_DEPLOYER_IMPERSONATE: ethers.getAddress(OPERATOR),
      });
      record = JSON.parse(fs.readFileSync(recordFile, "utf8"));
      summary.transactions["claim"] = record.claim.tx;
    });

    it("pays the beneficiary exactly the bonus, triggered by the operator", async function () {
      expect(runs.claim.stdout).to.include("The claim phase passed");
      expect((await token0.balanceOf(beneficiaryWallet.address)) - beneficiaryBefore).to.equal(
        BigInt(record.guaranteedBonusAmount)
      );
      expect(ethers.getAddress(record.claim.trigger)).to.equal(ethers.getAddress(OPERATOR));
      expect(ethers.getAddress(record.claim.trigger)).to.not.equal(beneficiaryWallet.address);
    });

    it("marks the reservation claimed and leaves nothing claimable", async function () {
      expect((await escrow.reservationOf(record.purchaseId)).claimed).to.equal(true);
      expect(await escrow.claimable(record.purchaseId)).to.equal(0n);
      expect(await escrow.totalReserved()).to.equal(0n);
    });

    it("refuses a second claim of the same purchase, and sends nothing", async function () {
      const result = await runner.runHardhatScript(
        "scripts/apebond-rehearsal.js",
        baseEnv({
          LP_REHEARSAL_PHASE: "claim",
          LP_DEPLOYER_IMPERSONATE: ethers.getAddress(OPERATOR),
        }),
        { logFile, timeoutMs: SCRIPT_TIMEOUT_MS }
      );
      expect(result.code).to.not.equal(0);
      expect(result.stderr).to.include("already been claimed");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("7. the repository is exactly as it was", function () {
    it("left the tracked deployments.json byte-identical", function () {
      expect(runner.sha256File(runner.TRACKED_REGISTRY)).to.equal(TRACKED_REGISTRY_SHA256);
    });

    it("left the committed .openzeppelin/sepolia.json byte-identical", function () {
      // The plugin used a temp manifest with this file as its read-only parent; had it not,
      // the upgrade validation would have rewritten the layout baseline for the live stack.
      expect(runner.sha256File(manifestFile)).to.equal(manifestSha256AtStart);
    });

    it("changed nothing git can see", function () {
      // The two files the whole run could plausibly write, checked strictly: nothing at all,
      // tracked or untracked, may show up under either path.
      expect(
        execFileSync("git", ["status", "--porcelain", "--", "deployments.json", ".openzeppelin"], {
          cwd: forkNode.REPO_ROOT,
          encoding: "utf8",
        })
      ).to.equal("");

      // And then the whole tree, as a set difference rather than a string comparison: what
      // matters is that this run ADDED nothing to what git reports, and a working tree that
      // was already dirty when the suite started is not this run's doing. (A person editing
      // the repository while the suite runs will show up here, correctly: git cannot tell
      // two writers apart. Run it on a tree nobody is touching.)
      const appeared = [...gitStatus()].filter((line) => !gitStatusAtStart.has(line));
      expect(appeared, `these appeared in git status during the run:\n  ${appeared.join("\n  ")}`)
        .to.deep.equal([]);
    });

    it("wrote every run artifact into the scratch directory instead", function () {
      for (const file of [
        "apebond-activate-batch.json",
        `apebond-rehearsal-${FORK_CHAIN_ID}.json`,
      ]) {
        expect(fs.existsSync(path.join(scratchDir, file)), `${file} in the scratch dir`).to.equal(
          true
        );
        expect(
          fs.existsSync(path.join(forkNode.REPO_ROOT, file)),
          `${file} must not be in the repository`
        ).to.equal(false);
      }
      // The registry the children wrote is the scratch one, and it now records the route
      // under the chain the fork reports — which is the proof the tracked file was never it.
      expect(fs.existsSync(path.join(scratchDir, "deployments.json"))).to.equal(true);
      expect(entry("ApeBondPositionAdapter").address).to.equal(adapter.target);
    });
  });
});

/** Only the adapter's one event, so the receipt can be decoded without its whole ABI. */
const DEPOSITED_IFACE = new ethers.Interface([
  "event ApeBondPositionDeposited(bytes32 indexed purchaseId,bytes32 indexed campaignId,address indexed beneficiary,bytes32 soulZapRequestId,uint256 tokenId,uint128 liquidity,int24 tickLower,int24 tickUpper,address inputToken,uint256 grossInputAmount,uint256 netInputAmount,uint256 guaranteedBonusAmount,uint64 bonusUnlockAt)",
]);

/**
 * The last transaction hash a script printed. `pools.send` logs `  done: <explorer url or
 * hash>` for every transaction it sends, and on chain 31337 there is no explorer, so the
 * hash is printed bare.
 */
function lastTxHash(stdout) {
  const matches = [...stdout.matchAll(/done: .*?(0x[0-9a-fA-F]{64})/g)];
  return matches.length > 0 ? matches[matches.length - 1][1] : null;
}

/**
 * Strips the API key out of an endpoint before it is printed — for Infura that string ends
 * in the company project id.
 */
function redactRpc(url) {
  return String(url).replace(/\/v3\/[^/?#]+/, "/v3/<redacted>");
}

/** The rehearsal record for the notes: every address and every transaction hash, in one block. */
function printSummary({ addresses, transactions, facts }) {
  const rows = [
    ["── fork ──", ""],
    ...Object.entries(facts),
    ["── addresses ──", ""],
    ...Object.entries(addresses),
    ["── transactions (on the fork) ──", ""],
    ...Object.entries(transactions),
  ];
  const width = rows.reduce((max, [label]) => Math.max(max, label.length), 0);
  console.log("\n  ApeBond fork dry-run — Sepolia test stack #5");
  for (const [label, value] of rows) {
    console.log(`  ${label.padEnd(width)}  ${value === undefined || value === null ? "-" : value}`);
  }
  console.log("");
}
