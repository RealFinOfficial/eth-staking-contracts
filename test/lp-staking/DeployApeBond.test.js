const fs = require("fs");
const os = require("os");
const path = require("path");

const { expect } = require("chai");
const ethers = require("ethers");
const hre = require("hardhat");

const forkNode = require("./helpers/fork-node");
const chain = require("./helpers/chain");
const runner = require("./helpers/scripts");
const lpTimelock = require("../../scripts/lp-timelock");

/**
 * `scripts/deploy-apebond.js`, run as a CHILD PROCESS against a stack this suite deploys with
 * `scripts/deploy-lp-staking.js` — also as a child process, also unmodified.
 *
 * ── Why a spawned node and not the in-process Hardhat network ─────────────────────────────
 *
 * The script under test is an OPERATOR script: it is `hardhat run`, it reads its inputs from the
 * environment, it writes `deployments.json`, and — the part no in-process test can reach — it
 * SCHEDULES a timelock operation, waits out `getMinDelay()` and then executes it. A child
 * process needs a JSON-RPC endpoint, so this suite starts a plain `hardhat node` (no fork, no
 * archive endpoint, so unlike the two integration suites it can never skip) and points both
 * children at it with `LOCALHOST_RPC_URL`.
 *
 * ── How the 60-second wait is driven ──────────────────────────────────────────────────────
 *
 * The script's wait is CHAIN time: it polls the timelock's `isOperationReady` and prints the
 * remaining seconds against the latest block's own timestamp, never against the local clock.
 * That is what makes it drivable from here. While each child runs, {withTimePump} pushes the
 * node's clock forward — `evm_increaseTime(5)` plus `evm_mine`, every 150 ms — so the 60-second
 * `minDelay` this stack is deployed with elapses in chain time within a second or two of wall
 * clock. The only knob the script needed for that is `LP_APEBOND_WAIT_POLL_MS`, which this suite
 * sets to 200 ms so the child notices quickly; its default is 5000 ms.
 *
 * ── The world ─────────────────────────────────────────────────────────────────────────────
 *
 * Mocks, not real Uniswap: `MockERC20Decimals` (18 and 6 decimals, which the deploy script
 * checks), `MockUniswapV3Pool`, `MockPositionManager`, `MockSwapRouter`, and
 * `MockUniswapV3Factory` — the last one exists for exactly one reason, the deploy script's
 * canonical-pool check, which asks the factory whether `LP_POOL` really is the pool for
 * `(token0, token1, fee)` and has no bypass.
 *
 * One position is staked before the activation runs, so "state preservation" has a subject: the
 * vault's `stakerOf(tokenId)` is read before the upgrade and asserted after it, by this suite
 * AND by the script's own post-check list through `LP_APEBOND_ASSERT_POSITIONS`.
 *
 * ── What the four runs prove ──────────────────────────────────────────────────────────────
 *
 *   run 1  LP_APEBOND_MODE unset (activate) with IMPL_CONTRACT=LPStakingVaultV2Mock: a genuinely
 *          different implementation is deployed, the escrow and the adapter are deployed born
 *          owned by the timelock, the adapter's allowlist is written and it is handed over, and
 *          ONE batch upgrades the proxy and allowlists the adapter in that order.
 *   run 2  the same command again: nothing is deployed, nothing is scheduled, not one
 *          transaction is sent, and every address is the same.
 *   run 3  LP_APEBOND_MODE=replace-adapter: a new adapter, and one batch of three that takes the
 *          old one off the vault's allowlist, puts the new one on, and re-points the escrow.
 *   run 4  LP_APEBOND_MODE=upgrade-vault: the plain upgrade, a ONE-call batch, with the ApeBond
 *          wiring and the staked position both untouched by it.
 *
 * The tracked `deployments.json` is never written: every child gets `DEPLOYMENTS_FILE` pointing
 * at a scratch file, and the tracked registry's sha256 is captured at load and asserted at the
 * end.
 */

/** Captured before a single test runs; asserted again at the very end. */
const TRACKED_REGISTRY_SHA256 = runner.sha256File(runner.TRACKED_REGISTRY);

/** ERC-1967 implementation slot: keccak256("eip1967.proxy.implementation") - 1. */
const ERC1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const FEE = 3000;
const TWAP_WINDOW = 300;
const TICK_LOWER = -600;
const TICK_UPPER = 600;
const LIQUIDITY = 1_000_000n;
const MIN_DELAY = 60;

/** Chain 31337 — what `hardhat node` reports for itself. */
const CHAIN_ID = 31337;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `fn` while the node's clock is pushed forward, and stops pushing when it returns.
 *
 * The script's wait is chain-time based on purpose, so this is the whole harness it needs: five
 * seconds of chain time every 150 ms of wall clock, which clears a 60-second `minDelay` in about
 * two seconds. Errors from the pump are swallowed — the node may be mid-transaction, and a
 * missed tick simply means the next one advances further.
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

describe("deploy-apebond.js — activating ApeBond on an already-deployed stack", function () {
  // Two child processes per run, four runs, plus a node. Slow, but every second of it is the
  // real scripts against a real endpoint.
  this.timeout(15 * 60 * 1000);

  let scratchDir, registryFile, logFile;
  let node = null;
  let provider, fees, w;

  let assetAddr, usdcAddr, token0Addr, token1Addr;
  let poolAddr, nfpmAddr, routerAddr, factoryAddr;
  let nfpm, vault, timelock;

  let vaultAddr, timelockAddr, distributorAddr, zapperAddr;
  let stakedTokenId;

  /** The vault state that must survive every run, captured once before the first activation. */
  let baseline;

  /** Per-run records, so a later describe can assert against an earlier run's addresses. */
  const runs = {};

  const vaultIface = new ethers.Interface([
    "function stake(uint256 tokenId)",
    "function stakerOf(uint256 tokenId) view returns (address)",
    "function isStakeOperator(address account) view returns (bool)",
    "function owner() view returns (address)",
    "function guardian() view returns (address)",
    "function operator() view returns (address)",
    "function zapper() view returns (address)",
    "function twapWindow() view returns (uint32)",
    "function maxTwapDeviationTicks() view returns (uint24)",
    "function depositsPaused() view returns (bool)",
    "function rebalancePaused() view returns (bool)",
    "function version() view returns (uint256)",
  ]);
  const escrowIface = new ethers.Interface([
    "function owner() view returns (address)",
    "function pendingOwner() view returns (address)",
    "function adapter() view returns (address)",
    "function bonusToken() view returns (address)",
    "function totalReserved() view returns (uint256)",
  ]);
  const adapterIface = new ethers.Interface([
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

  const at = (address, iface) => new ethers.Contract(address, iface, provider);
  const entry = (kind) => runner.registryEntry(registryFile, CHAIN_ID, kind);

  async function implementationOf(proxy) {
    const word = await provider.getStorage(proxy, ERC1967_IMPLEMENTATION_SLOT);
    return ethers.getAddress("0x" + word.slice(-40));
  }

  /** Deploys one compiled artifact from the deployer account. */
  async function deployArtifact(name, args = []) {
    const artifact = await hre.artifacts.readArtifact(name);
    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, w.deployer);
    const contract = await (await factory.deploy(...args)).waitForDeployment();
    return contract;
  }

  /** The environment every child gets: the node, the scratch registry, and nothing else. */
  function baseEnv(extra = {}) {
    return {
      LOCALHOST_RPC_URL: node.rpcUrl,
      DEPLOYMENTS_FILE: registryFile,
      ...extra,
    };
  }

  /** One `deploy-apebond.js` run, with the clock pushed forward while it waits. */
  async function runApeBond(extra) {
    const result = await withTimePump(provider, () =>
      runner.runHardhatScript("scripts/deploy-apebond.js", baseEnv(extra), { logFile })
    );
    if (result.code !== 0) {
      throw new Error(
        `deploy-apebond.js exited ${result.code}\n--- stdout ---\n${result.stdout}\n` +
          `--- stderr ---\n${result.stderr}`
      );
    }
    return result;
  }

  /** The vault fields an upgrade must never move. */
  async function vaultState() {
    const v = at(vaultAddr, vaultIface);
    return {
      owner: await v.owner(),
      guardian: await v.guardian(),
      operator: await v.operator(),
      zapper: await v.zapper(),
      twapWindow: await v.twapWindow(),
      maxTwapDeviationTicks: await v.maxTwapDeviationTicks(),
      depositsPaused: await v.depositsPaused(),
      rebalancePaused: await v.rebalancePaused(),
      staker: await v.stakerOf(stakedTokenId),
    };
  }

  /** Rebuilds the batch from the JSON file the run wrote, which is the CLI's own input shape. */
  function batchFromFile(mode) {
    const file = path.join(scratchDir, `apebond-${mode}-batch.json`);
    const calls = JSON.parse(fs.readFileSync(file, "utf8"));
    return { file, calls, batch: lpTimelock.buildBatch(calls, "") };
  }

  // ─────────────────────────────────────────────────────────────
  before(async function () {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-apebond-"));
    registryFile = path.join(scratchDir, "deployments.json");
    logFile = path.join(scratchDir, "scripts.log");

    const port = await forkNode.getFreePort();
    node = await forkNode.spawnLocalNode({
      port,
      logFile: path.join(scratchDir, `hardhat-node-${port}.log`),
    });

    provider = new ethers.JsonRpcProvider(node.rpcUrl, undefined, forkNode.PROVIDER_OPTIONS);
    provider.pollingInterval = 50;
    fees = await chain.derivePinnedFees(provider);
    w = chain.makeWallets(provider, fees);

    // ── the world the deploy script validates against ───────────────────────────────────
    const asset = await deployArtifact("MockERC20Decimals", [
      "Asset",
      "ASSET",
      10n ** 24n,
      18,
    ]);
    const usdc = await deployArtifact("MockERC20Decimals", [
      "USD Coin",
      "USDC",
      10n ** 12n,
      6,
    ]);
    assetAddr = await asset.getAddress();
    usdcAddr = await usdc.getAddress();

    // Uniswap sorts the pair ascending by address; the pool, the vault and the adapter all see
    // the sorted pair, so the mock pool is created with it.
    [token0Addr, token1Addr] =
      assetAddr.toLowerCase() < usdcAddr.toLowerCase()
        ? [assetAddr, usdcAddr]
        : [usdcAddr, assetAddr];

    const pool = await deployArtifact("MockUniswapV3Pool", [token0Addr, token1Addr, FEE]);
    poolAddr = await pool.getAddress();

    nfpm = await deployArtifact("MockPositionManager");
    nfpmAddr = await nfpm.getAddress();

    const router = await deployArtifact("MockSwapRouter");
    routerAddr = await router.getAddress();

    const factory = await deployArtifact("MockUniswapV3Factory");
    factoryAddr = await factory.getAddress();
    await chain.send(factory.connect(w.deployer).setPool(token0Addr, token1Addr, FEE, poolAddr));

    // ── the stack, deployed by the repo's own script, WITHOUT the ApeBond route ──────────
    //
    // LP_MULTISIG is the deployer, so the deployer is the timelock's only proposer and
    // executor — which is what lets `deploy-apebond.js` drive the batch end to end instead of
    // printing it for a Safe. `minDelay` is 60 s, short enough to wait out and long enough that
    // a premature execute would revert if the script got the wait wrong.
    const deployed = await runner.runHardhatScript(
      "scripts/deploy-lp-staking.js",
      baseEnv({
        LP_ASSET: assetAddr,
        LP_USDC: usdcAddr,
        LP_POOL: poolAddr,
        LP_NPM: nfpmAddr,
        LP_ROUTER: routerAddr,
        LP_FACTORY: factoryAddr,
        LP_FEE: String(FEE),
        LP_SIGNER: w.backOffice.address,
        LP_MULTISIG: w.deployer.address,
        LP_GUARDIAN: w.guardian.address,
        LP_OPERATOR: w.operator.address,
        LP_TOKENX_NAME: "Token X",
        LP_TOKENX_SYMBOL: "TKX",
        LP_TIMELOCK_MIN_DELAY: String(MIN_DELAY),
        LP_TWAP_WINDOW: String(TWAP_WINDOW),
      }),
      { logFile }
    );
    if (deployed.code !== 0) {
      throw new Error(
        `deploy-lp-staking.js exited ${deployed.code}\n--- stdout ---\n${deployed.stdout}\n` +
          `--- stderr ---\n${deployed.stderr}`
      );
    }

    vaultAddr = entry("LPStakingVault").address;
    timelockAddr = entry("TimelockController").address;
    distributorAddr = entry("RewardsDistributor").address;
    zapperAddr = entry("LPZapper").address;

    vault = at(vaultAddr, vaultIface);
    timelock = new ethers.Contract(timelockAddr, lpTimelock.TIMELOCK_INTERFACE, provider);

    // ── one staked position, so state preservation has a subject ─────────────────────────
    await chain.send(
      nfpm
        .connect(w.deployer)
        .mintFake(w.alice.address, token0Addr, token1Addr, FEE, TICK_LOWER, TICK_UPPER, LIQUIDITY, 0n, 0n)
    );
    stakedTokenId = await nfpm.lastMintedId();
    await chain.send(nfpm.connect(w.alice).approve(vaultAddr, stakedTokenId));
    await chain.send(
      new ethers.Contract(vaultAddr, vaultIface, w.alice).stake(stakedTokenId)
    );

    baseline = {
      vaultImplementation: await implementationOf(vaultAddr),
      distributorImplementation: await implementationOf(distributorAddr),
      state: await vaultState(),
    };
  });

  after(async function () {
    if (node) await node.stop();
  });

  // ─────────────────────────────────────────────────────────────
  describe("the world this suite deploys", function () {
    it("has a stack with no ApeBond route on it", async function () {
      expect(entry("BonusEscrow"), "BonusEscrow must not exist yet").to.equal(undefined);
      expect(entry("ApeBondPositionAdapter")).to.equal(undefined);
      expect(await timelock.getMinDelay()).to.equal(BigInt(MIN_DELAY));
      expect(baseline.state.owner).to.equal(timelockAddr);
      expect(baseline.state.zapper).to.equal(zapperAddr);
    });

    it("has one position staked, credited to alice", async function () {
      expect(baseline.state.staker).to.equal(w.alice.address);
      expect(await nfpm.ownerOf(stakedTokenId)).to.equal(vaultAddr);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("the full activation (LP_APEBOND_MODE unset)", function () {
    before(async function () {
      runs.activate = await runApeBond({
        LP_APEBOND_GUARDIAN: w.guardian.address,
        LP_APEBOND_PURCHASE_SIGNER: w.apeBondSigner.address,
        LP_APEBOND_SOULZAP_CALLERS: w.soulZapCaller.address,
        LP_APEBOND_ASSERT_POSITIONS: String(stakedTokenId),
        LP_APEBOND_WAIT_POLL_MS: "200",
        IMPL_CONTRACT: "LPStakingVaultV2Mock",
        IMPL_UNSAFE_ALLOW_EXTRA: "missing-initializer",
      });
      runs.activateAddresses = {
        implementation: await implementationOf(vaultAddr),
        escrow: entry("BonusEscrow").address,
        adapter: entry("ApeBondPositionAdapter").address,
      };
    });

    it("upgrades the proxy onto the implementation it deployed (phase 2)", async function () {
      const recorded = entry("LPStakingVault");
      expect(runs.activateAddresses.implementation).to.not.equal(baseline.vaultImplementation);
      expect(recorded.implementation).to.equal(runs.activateAddresses.implementation);
      // `pendingImplementation` is what a prepared-but-not-live implementation is recorded as.
      // This one is live, so the key must be gone rather than stale.
      expect(recorded).to.not.have.property("pendingImplementation");
      expect(await vault.version()).to.equal(2n);
    });

    it("allowlists the adapter on the vault, in the same operation as the upgrade", async function () {
      expect(await vault.isStakeOperator(runs.activateAddresses.adapter)).to.equal(true);

      const { batch, calls } = batchFromFile("activate");
      expect(calls.map((call) => call.fn)).to.deep.equal([
        "upgradeToAndCall",
        "setStakeOperator",
      ]);
      // The file is the CLI's own input shape, so rebuilding the batch from it must reproduce
      // the operation the run actually executed — same targets, same payloads, same salt, same
      // id. That is what makes the file usable as a hand-driven fallback.
      expect(await timelock.isOperationDone(batch.id)).to.equal(true);
      expect(batch.calls[0].args[0]).to.equal(runs.activateAddresses.implementation);
      expect(batch.calls[1].args[0]).to.equal(runs.activateAddresses.adapter);
    });

    it("deploys the escrow born owned by the timelock and born pointing at the adapter", async function () {
      const escrow = at(runs.activateAddresses.escrow, escrowIface);
      expect(await escrow.owner()).to.equal(timelockAddr);
      expect(await escrow.pendingOwner()).to.equal(ethers.ZeroAddress);
      expect(await escrow.adapter()).to.equal(runs.activateAddresses.adapter);
      expect(await escrow.bonusToken()).to.equal(token0Addr);
      expect(await escrow.totalReserved()).to.equal(0n);
    });

    it("leaves the escrow's ERC-1967 admin slot empty, as UUPS requires", async function () {
      const admin = await provider.getStorage(
        runs.activateAddresses.escrow,
        "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"
      );
      expect(BigInt(admin)).to.equal(0n);
      expect(await implementationOf(runs.activateAddresses.escrow)).to.equal(
        ethers.getAddress(entry("BonusEscrow").implementation)
      );
    });

    it("hands the adapter to the timelock with its allowlist already written", async function () {
      const adapter = at(runs.activateAddresses.adapter, adapterIface);
      expect(await adapter.owner()).to.equal(timelockAddr);
      expect(await adapter.guardian()).to.equal(w.guardian.address);
      expect(await adapter.purchaseSigner()).to.equal(w.apeBondSigner.address);
      expect(await adapter.depositsPaused()).to.equal(false);
      expect(await adapter.soulZapCallers(w.soulZapCaller.address)).to.equal(true);
      expect(await adapter.vault()).to.equal(vaultAddr);
      expect(await adapter.escrow()).to.equal(runs.activateAddresses.escrow);
      expect(await adapter.token0()).to.equal(token0Addr);
      expect(await adapter.token1()).to.equal(token1Addr);
      expect(await adapter.fee()).to.equal(BigInt(FEE));
    });

    it("records both new kinds in the registry (phase 7)", async function () {
      const escrow = entry("BonusEscrow");
      expect(escrow.owner).to.equal(timelockAddr);
      expect(escrow.bonusToken).to.equal(token0Addr);
      expect(escrow.implementation).to.match(/^0x[0-9a-fA-F]{40}$/);
      expect(escrow.block).to.be.a("number");

      const adapter = entry("ApeBondPositionAdapter");
      expect(adapter.owner).to.equal(timelockAddr);
      expect(adapter.guardian).to.equal(w.guardian.address);
      expect(adapter.purchaseSigner).to.equal(w.apeBondSigner.address);
      expect(adapter.soulZapCallers).to.deep.equal([w.soulZapCaller.address]);
      expect(adapter.vault).to.equal(vaultAddr);
      expect(adapter.escrow).to.equal(escrow.address);
      expect(adapter.block).to.be.a("number");
    });

    it("preserves every vault field the upgrade must not have touched (phase 6)", async function () {
      expect(await vaultState()).to.deep.equal(baseline.state);
      expect(await nfpm.ownerOf(stakedTokenId)).to.equal(vaultAddr);
    });

    it("leaves the distributor's implementation slot alone", async function () {
      expect(await implementationOf(distributorAddr)).to.equal(
        baseline.distributorImplementation
      );
    });

    it("says in its own output that the checks passed", function () {
      expect(runs.activate.stdout).to.include("All post-activation checks passed.");
      expect(runs.activate.stdout).to.include("phase 5: the timelock batch");
      // The countdown the wait prints is chain time, which is the whole reason this suite can
      // drive it with evm_increaseTime.
      expect(runs.activate.stdout).to.match(/waiting: -?\d+s of CHAIN time left/);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("running the same command again (resume)", function () {
    let nonceBefore, blockBefore;

    before(async function () {
      nonceBefore = await provider.getTransactionCount(w.deployer.address, "latest");
      blockBefore = await provider.getBlockNumber();
      runs.resume = await runApeBond({
        LP_APEBOND_GUARDIAN: w.guardian.address,
        LP_APEBOND_PURCHASE_SIGNER: w.apeBondSigner.address,
        LP_APEBOND_SOULZAP_CALLERS: w.soulZapCaller.address,
        LP_APEBOND_ASSERT_POSITIONS: String(stakedTokenId),
        LP_APEBOND_WAIT_POLL_MS: "200",
        IMPL_CONTRACT: "LPStakingVaultV2Mock",
        IMPL_UNSAFE_ALLOW_EXTRA: "missing-initializer",
      });
    });

    it("sends no transaction at all", async function () {
      expect(await provider.getTransactionCount(w.deployer.address, "latest")).to.equal(
        nonceBefore
      );
    });

    it("schedules nothing new on the timelock", async function () {
      const scheduled = await timelock.queryFilter("CallScheduled", blockBefore + 1, "latest");
      expect(scheduled).to.have.lengthOf(0);
    });

    it("redeploys neither the escrow nor the adapter", async function () {
      expect(entry("BonusEscrow").address).to.equal(runs.activateAddresses.escrow);
      expect(entry("ApeBondPositionAdapter").address).to.equal(runs.activateAddresses.adapter);
      expect(await implementationOf(vaultAddr)).to.equal(runs.activateAddresses.implementation);
      expect(runs.resume.stdout).to.include("phase 3: SKIPPED");
    });

    it("reports that every call's effect is already on chain", function () {
      expect(runs.resume.stdout).to.include("ALREADY in place on chain");
      expect(runs.resume.stdout).to.include("All post-activation checks passed.");
    });

    it("leaves the staked position and the admin tiers where they were", async function () {
      expect(await vaultState()).to.deep.equal(baseline.state);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("LP_APEBOND_MODE=replace-adapter", function () {
    before(async function () {
      runs.replace = await runApeBond({
        LP_APEBOND_MODE: "replace-adapter",
        LP_APEBOND_GUARDIAN: w.guardian.address,
        LP_APEBOND_PURCHASE_SIGNER: w.apeBondSigner.address,
        LP_APEBOND_SOULZAP_CALLERS: w.soulZapCaller.address,
        LP_APEBOND_ASSERT_POSITIONS: String(stakedTokenId),
        LP_APEBOND_WAIT_POLL_MS: "200",
      });
      runs.replaceAdapter = entry("ApeBondPositionAdapter").address;
    });

    it("deploys a new adapter against the SAME escrow", async function () {
      expect(runs.replaceAdapter).to.not.equal(runs.activateAddresses.adapter);
      const adapter = at(runs.replaceAdapter, adapterIface);
      expect(await adapter.escrow()).to.equal(runs.activateAddresses.escrow);
      expect(await adapter.vault()).to.equal(vaultAddr);
      expect(await adapter.owner()).to.equal(timelockAddr);
      expect(await adapter.soulZapCallers(w.soulZapCaller.address)).to.equal(true);
    });

    it("swaps the allowlist entry and re-points the escrow in ONE batch", async function () {
      expect(await vault.isStakeOperator(runs.activateAddresses.adapter)).to.equal(false);
      expect(await vault.isStakeOperator(runs.replaceAdapter)).to.equal(true);
      expect(await at(runs.activateAddresses.escrow, escrowIface).adapter()).to.equal(
        runs.replaceAdapter
      );

      const { batch, calls } = batchFromFile("replace-adapter");
      expect(calls.map((call) => call.fn)).to.deep.equal([
        "setStakeOperator",
        "setStakeOperator",
        "setAdapter",
      ]);
      expect(calls[0].args).to.deep.equal([runs.activateAddresses.adapter, "false"]);
      expect(calls[1].args).to.deep.equal([runs.replaceAdapter, "true"]);
      expect(calls[2].args).to.deep.equal([runs.replaceAdapter]);
      expect(await timelock.isOperationDone(batch.id)).to.equal(true);
    });

    it("moves the registry entry across and drops the pending keys", function () {
      const adapter = entry("ApeBondPositionAdapter");
      expect(adapter.address).to.equal(runs.replaceAdapter);
      expect(adapter.previousAdapter).to.equal(runs.activateAddresses.adapter);
      expect(adapter).to.not.have.property("pendingAdapter");
      expect(adapter).to.not.have.property("pendingAdapterBlock");
      expect(adapter).to.not.have.property("pendingAdapterTx");
      expect(adapter.escrow).to.equal(runs.activateAddresses.escrow);
      expect(adapter.owner).to.equal(timelockAddr);
    });

    it("upgrades nothing: the vault implementation and the position are untouched", async function () {
      expect(await implementationOf(vaultAddr)).to.equal(runs.activateAddresses.implementation);
      expect(await vaultState()).to.deep.equal(baseline.state);
      expect(runs.replace.stdout).to.include("All post-activation checks passed.");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("LP_APEBOND_MODE=upgrade-vault", function () {
    before(async function () {
      // The third implementation, not the first. `prepareUpgrade` grades a candidate against
      // the layout of the implementation the proxy RUNS, and the proxy is on V2 by now, so
      // going back to the plain `LPStakingVault` would DELETE V2's ERC-7201 namespace and the
      // plugin would refuse it. A second upgrade has to move forward again.
      runs.upgradeOnly = await runApeBond({
        LP_APEBOND_MODE: "upgrade-vault",
        LP_APEBOND_ASSERT_POSITIONS: String(stakedTokenId),
        LP_APEBOND_WAIT_POLL_MS: "200",
        IMPL_CONTRACT: "LPStakingVaultV3Mock",
        IMPL_UNSAFE_ALLOW_EXTRA: "missing-initializer",
      });
      runs.upgradeOnlyImplementation = await implementationOf(vaultAddr);
    });

    it("installs the implementation the build compiles, in a ONE-call batch", async function () {
      expect(runs.upgradeOnlyImplementation).to.not.equal(
        runs.activateAddresses.implementation
      );
      expect(entry("LPStakingVault").implementation).to.equal(runs.upgradeOnlyImplementation);
      expect(await vault.version()).to.equal(3n);

      const { batch, calls } = batchFromFile("upgrade-vault");
      expect(calls).to.have.lengthOf(1);
      expect(calls[0].fn).to.equal("upgradeToAndCall");
      expect(calls[0].args).to.deep.equal([runs.upgradeOnlyImplementation, "0x"]);
      expect(await timelock.isOperationDone(batch.id)).to.equal(true);
    });

    it("touches no ApeBond contract: the allowlist and the escrow survive the upgrade", async function () {
      expect(await vault.isStakeOperator(runs.replaceAdapter)).to.equal(true);
      expect(await at(runs.activateAddresses.escrow, escrowIface).adapter()).to.equal(
        runs.replaceAdapter
      );
      expect(entry("ApeBondPositionAdapter").address).to.equal(runs.replaceAdapter);
    });

    it("keeps the staked position and every admin tier", async function () {
      expect(await vaultState()).to.deep.equal(baseline.state);
      expect(await nfpm.ownerOf(stakedTokenId)).to.equal(vaultAddr);
      expect(runs.upgradeOnly.stdout).to.include("All post-activation checks passed.");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("a stack whose timelock this key cannot drive (the mainnet shape)", function () {
    // The second stack names a DIFFERENT multisig as the timelock's proposer and executor, so
    // the deploying key holds neither role — which is exactly the mainnet arrangement, where
    // the two transactions belong to a Safe. The script must deploy and wire everything it can
    // and then STOP, with the vault untouched.
    let safeDir, safeRegistry, safeVault, safeTimelock, safeRun;

    const safeEntry = (kind) => runner.registryEntry(safeRegistry, CHAIN_ID, kind);

    before(async function () {
      safeDir = path.join(scratchDir, "safe-stack");
      fs.mkdirSync(safeDir, { recursive: true });
      safeRegistry = path.join(safeDir, "deployments.json");

      const deployed = await runner.runHardhatScript(
        "scripts/deploy-lp-staking.js",
        {
          LOCALHOST_RPC_URL: node.rpcUrl,
          DEPLOYMENTS_FILE: safeRegistry,
          LP_ASSET: assetAddr,
          LP_USDC: usdcAddr,
          LP_POOL: poolAddr,
          LP_NPM: nfpmAddr,
          LP_ROUTER: routerAddr,
          LP_FACTORY: factoryAddr,
          LP_FEE: String(FEE),
          LP_SIGNER: w.backOffice.address,
          LP_MULTISIG: w.multisig.address,
          LP_GUARDIAN: w.guardian.address,
          LP_OPERATOR: w.operator.address,
          LP_TOKENX_NAME: "Token X",
          LP_TOKENX_SYMBOL: "TKX",
          LP_TIMELOCK_MIN_DELAY: String(MIN_DELAY),
          LP_TWAP_WINDOW: String(TWAP_WINDOW),
        },
        { logFile }
      );
      expect(deployed.code, deployed.stderr).to.equal(0);

      safeVault = safeEntry("LPStakingVault").address;
      safeTimelock = safeEntry("TimelockController").address;

      safeRun = await runner.runHardhatScript(
        "scripts/deploy-apebond.js",
        {
          LOCALHOST_RPC_URL: node.rpcUrl,
          DEPLOYMENTS_FILE: safeRegistry,
          LP_APEBOND_GUARDIAN: w.guardian.address,
          LP_APEBOND_SOULZAP_CALLERS: w.soulZapCaller.address,
          LP_APEBOND_ASSERT_POSITIONS: "",
          IMPL_CONTRACT: "LPStakingVaultV2Mock",
          IMPL_UNSAFE_ALLOW_EXTRA: "missing-initializer",
        },
        { logFile }
      );
      expect(safeRun.code, safeRun.stderr).to.equal(0);
    });

    it("prints the scheduleBatch and executeBatch calldata instead of sending them", function () {
      expect(safeRun.stdout).to.include("the two transactions this run does NOT send");
      expect(safeRun.stdout).to.include("scheduleBatch calldata");
      expect(safeRun.stdout).to.include("executeBatch calldata");
      expect(safeRun.stdout).to.include("no PROPOSER_ROLE");

      // The printed calldata is the batch the file names, encoded by lp-timelock.js's own
      // builders — so a Safe pasting it sends the operation this run described.
      const calls = JSON.parse(fs.readFileSync(path.join(safeDir, "apebond-activate-batch.json"), "utf8"));
      const batch = lpTimelock.buildBatch(calls, "");
      expect(safeRun.stdout).to.include(lpTimelock.encodeScheduleBatch(batch, BigInt(MIN_DELAY)));
      expect(safeRun.stdout).to.include(lpTimelock.encodeExecuteBatch(batch));
      expect(safeRun.stdout).to.include(batch.id);
    });

    it("leaves the vault exactly as it found it", async function () {
      const vaultBefore = ethers.getAddress(safeEntry("LPStakingVault").implementation);
      expect(await implementationOf(safeVault)).to.equal(vaultBefore);
      expect(
        await at(safeVault, vaultIface).isStakeOperator(safeEntry("ApeBondPositionAdapter").address)
      ).to.equal(false);
      expect(await at(safeVault, vaultIface).owner()).to.equal(safeTimelock);
    });

    it("still deploys, wires and records the escrow and the adapter", async function () {
      const escrow = at(safeEntry("BonusEscrow").address, escrowIface);
      const adapter = at(safeEntry("ApeBondPositionAdapter").address, adapterIface);
      expect(await escrow.owner()).to.equal(safeTimelock);
      expect(await escrow.adapter()).to.equal(safeEntry("ApeBondPositionAdapter").address);
      expect(await adapter.owner()).to.equal(safeTimelock);
      expect(await adapter.soulZapCallers(w.soulZapCaller.address)).to.equal(true);
      expect(safeRun.stdout).to.include("the interim state, asserted");
      expect(safeRun.stdout).to.not.include("The interim state is wrong for");
    });

    it("records the implementation as PENDING, not as the one the proxy runs", function () {
      const recorded = safeEntry("LPStakingVault");
      expect(recorded.pendingImplementation).to.equal(
        runs.activateAddresses.implementation,
        "the V2 mock is byte-identical to the one the first stack already uses, so the plugin " +
          "reuses that deployment rather than sending a second one"
      );
      expect(recorded.implementation).to.not.equal(recorded.pendingImplementation);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("inputs it refuses", function () {
    it("refuses a chain whose registry holds no stack", async function () {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-apebond-empty-"));
      const result = await runner.runHardhatScript(
        "scripts/deploy-apebond.js",
        {
          LOCALHOST_RPC_URL: node.rpcUrl,
          DEPLOYMENTS_FILE: path.join(emptyDir, "deployments.json"),
        },
        { logFile }
      );
      expect(result.code).to.not.equal(0);
      expect(result.stdout + result.stderr).to.match(
        /has no LPStakingVault entry in the deployment registry/
      );
    });

    it("refuses a mode it does not know", async function () {
      const result = await runner.runHardhatScript(
        "scripts/deploy-apebond.js",
        {
          LOCALHOST_RPC_URL: node.rpcUrl,
          DEPLOYMENTS_FILE: registryFile,
          LP_APEBOND_MODE: "replace",
        },
        { logFile }
      );
      expect(result.code).to.not.equal(0);
      expect(result.stdout + result.stderr).to.include("LP_APEBOND_MODE must be one of");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("the tracked registry", function () {
    it("was never written by any of the four runs", function () {
      expect(runner.sha256File(runner.TRACKED_REGISTRY)).to.equal(TRACKED_REGISTRY_SHA256);
    });
  });
});
