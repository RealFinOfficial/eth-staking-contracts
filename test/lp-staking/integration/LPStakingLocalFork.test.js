/**
 * Local-fork integration suite for the LP staking stack.
 *
 * A long-lived `hardhat node --fork <mainnet> --fork-block-number 25750000` is started by
 * the suite itself and driven over HTTP. On it the suite deploys two mock tokens, creates
 * a FRESH Uniswap V3 pool for them through the real factory and position manager, and then
 * deploys and wires the whole stack by running the repo's own scripts as child processes —
 * `scripts/create-sepolia-pool.js` and `scripts/deploy-lp-staking.js`, unmodified, through
 * `hardhat run --network localhost`.
 *
 * ── What this covers that the in-process fork suite does not ──────────────────────────
 *
 * test/lp-staking/fork/LPStakingFork.test.js proves the contracts behave against the real
 * mainnet pool. It cannot exercise the deployment scripts (they need a JSON-RPC endpoint,
 * not an in-process provider), and it restores a snapshot before every test, so it never
 * produces a chain. This one produces one: forty-five scenario steps, each in its own
 * block, and then asserts that everything they emitted is stored on that chain and
 * retrievable from it — by address, by indexed topic, by block hash, in chunks, and from
 * receipts. That is the contract the indexer consumes, so it is asserted here.
 *
 * ── Scenario (mirrored by the indexer repo's e2e suite) ───────────────────────────────
 *
 *   S1/S2  deploy MockERC20Permit tASSET (18) and tUSDC (6)
 *   S3     fund alice/bob/carol/dave with 100k tASSET + 50k tUSDC
 *   S4     MaxUint256 approvals to the position manager and the router
 *   S5     create + initialize the pool at 0.50 tUSDC per tASSET   [pool script]
 *   S6     deployer seeds a wide position, 1e24 tASSET / 5e11 tUSDC
 *   S7     deploy + wire + hand to the multisig + grow the oracle  [deploy script]
 *   S8     warm the oracle: 8 round trips, 60 s apart
 *
 *   A1  alice mints P1                 A22 carol claims 1750 TokenX (pays 750)
 *   A2  alice approves the vault       A23 multisig arms epoch 2
 *   A3  alice stakes P1                A24 multisig cancels it
 *   A4  bob mints P2                   A25 multisig arms it again
 *   A5  bob stakes P2 by NFT permit    A26 clock jumps past the boundary
 *   A6  carol approves the zapper      A27 dave's claim rolls epoch 2 in
 *   A7  carol zaps in -> P3            A28 multisig enables the ASSET leg
 *   A8  dave zaps in by permit -> P4   A29 deployer funds the distributor
 *   A9  trading generates real fees    A30 bob claims 3000 tASSET
 *   A10 alice rebalances P1 -> P5      A31 multisig recovers 1000 tASSET
 *   A11 bob rebalances P2 -> P6        A32 multisig pauses claims
 *   A12 alice unstakes P5              A33 bob's claim reverts ClaimsPaused
 *   A13 alice re-approves P5           A34 multisig unpauses
 *   A14 alice re-stakes P5             A35 multisig rotates the signer
 *   A15 multisig pauses deposits       A36 multisig rotates it back
 *   A16 carol's stake reverts          A37 stray NFT rescued from the vault
 *   A17 multisig unpauses deposits     A38 stray NFT rescued from the zapper
 *   A18 carol stakes P7                A39 stray tUSDC swept from the zapper
 *   A19 multisig retunes the vault     A40 snapshot, stake P10, revert, re-mine
 *   A20 multisig retunes the zapper    A41 multisig cycles the zapper wiring
 *   A21 carol claims 1000 TokenX       A42 multisig cycles the minter wiring
 *                                      A43 multisig pauses rebalance
 *                                      A44 alice's rebalance reverts
 *                                      A45 multisig resumes rebalance
 *
 * ── Skip vs fail ──────────────────────────────────────────────────────────────────────
 *
 * Exactly one phase may skip: establishing the fork, and only when no endpoint could serve
 * archive state at the pinned block AND no endpoint was configured. That decision lives in
 * `helpers/fork-node.js:decideOnForkFailure`, is shared with nothing else, and is unit
 * tested at the bottom of this file. Everything after the fork is up fails the run.
 *
 * ── The tracked deployments.json is never touched ─────────────────────────────────────
 *
 * The scripts record into `DEPLOYMENTS_FILE`, a scratch file. The tracked registry's
 * sha256 is captured when this file loads and asserted again at the end.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const { expect } = require("chai");
const ethers = require("ethers");
const hre = require("hardhat");

const C = require("../helpers/constants");
const forkNode = require("../helpers/fork-node");
const rpc = require("../helpers/rpc");
const chain = require("../helpers/chain");
const uni = require("../helpers/uniswap");
const signing = require("../helpers/signing");
const runner = require("../helpers/scripts");
const { Ledger } = require("../helpers/ledger");

/**
 * Captured at file load, before a single test has run. Asserted again at the very end:
 * a chain-31337 deploy that rewrote the tracked mainnet registry would be a silent,
 * committable side effect of running the tests.
 */
const TRACKED_REGISTRY_SHA256 = runner.sha256File(runner.TRACKED_REGISTRY);

describe("LP staking — local fork node (fresh Uniswap V3 pool, mock tokens)", function () {
  // A fork over a public endpoint plus ~150 real transactions plus two script children.
  this.timeout(30 * 60 * 1000);

  // ── run state ──────────────────────────────────────────────────────────
  let node = null;
  let provider = null;
  let rpcUsed = null;
  let scratchDir = null;
  let registryFile = null;
  let fees = null;
  let w = null; // named wallets

  let assetAddr, usdcAddr, poolAddr, vaultAddr, zapperAddr, tokenXAddr, distributorAddr;
  let asset, usdc, pool, npm, npmRead, router, factory;
  let vault, zapper, tokenX, distributor;
  let assetIsToken0, token0, token1, zeroForOne, initialSqrtPriceX96;
  let voucherDomain;

  let poolRun = null; // first `create-sepolia-pool.js` run
  let deployRun = null; // `deploy-lp-staking.js` run
  let deployFromBlock = null;
  let deployToBlock = null;
  let seedTokenId = null;

  const ledger = new Ledger();
  const notes = [];
  const positions = {}; // "P1" -> tokenId
  const reorg = {}; // observations A40 hands to the reorg tests
  const epochs = {}; // arming timestamps A23/A25 hand to A24/A27
  const blockTags = {};

  // ── small helpers bound to the run ──────────────────────────────────────

  const centre = async () => uni.alignDown(await uni.currentTick(pool));
  const head = async () => provider.getBlockNumber();
  const timestampOf = async (blockNumber) => (await provider.getBlock(blockNumber)).timestamp;
  const latestTimestamp = async () => (await provider.getBlock("latest")).timestamp;

  /** Mints a position for `role` and remembers it under `name`. */
  async function mintFor(role, name, halfWidth, assetAmount, usdcAmount) {
    const c = await centre();
    const { receipt, tokenId } = await uni.mintPosition({
      npm,
      npmAddress: C.NPM_ADDR,
      signer: w[role],
      token0,
      token1,
      fee: C.FEE,
      tickLower: c - halfWidth,
      tickUpper: c + halfWidth,
      assetIsToken0,
      assetAmount,
      usdcAmount,
      recipient: w[role].address,
    });
    positions[name] = tokenId;
    return { receipt, tokenId, tickLower: c - halfWidth, tickUpper: c + halfWidth };
  }

  /** A swap leg for the vault / the zapper. USDC -> ASSET is the only legal direction. */
  const swapLeg = (amountIn) => ({
    zeroForOne,
    amountIn,
    amountOutMin: 0n,
    amount0Min: 0n,
    amount1Min: 0n,
  });

  /** Splits a (principal, fees) preview into the USDC side, whichever index that is. */
  const usdcSide = (preview) =>
    assetIsToken0
      ? { principal: preview.principal1, fees: preview.fees1 }
      : { principal: preview.principal0, fees: preview.fees0 };

  async function swapUsdcForAsset(role, amountIn) {
    return uni.swapExactIn({
      router,
      signer: w[role],
      tokenIn: usdcAddr,
      tokenOut: assetAddr,
      fee: C.FEE,
      amountIn,
    });
  }

  async function swapAssetForUsdc(role, amountIn) {
    return uni.swapExactIn({
      router,
      signer: w[role],
      tokenIn: assetAddr,
      tokenOut: usdcAddr,
      fee: C.FEE,
      amountIn,
    });
  }

  const voucher = (leg, role, cumulativeAmount) =>
    signing.signVoucher({
      signer: w.backOffice,
      domain: voucherDomain,
      leg,
      user: w[role].address,
      cumulativeAmount,
    });

  // ─────────────────────────────────────────────────────────────
  before(async function () {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-localfork-"));
    registryFile = path.join(scratchDir, "deployments.json");

    // ── Phase 1: establish the fork. The one and only place a skip is legal. ──────────
    const established = await forkNode.establishFork({ logDir: scratchDir });
    if (established === null) {
      this.skip();
      return;
    }

    node = established.node;
    provider = established.provider;
    rpcUsed = established.url;

    // ── Phase 2: build the world. No catch — every failure below is a real defect. ────
    fees = await chain.derivePinnedFees(provider);
    w = chain.makeWallets(provider, fees);

    // S1 / S2 — the two mock tokens. Deployed from the compiled artifact, so a change to
    // MockERC20Permit.sol reaches this suite without anyone editing it.
    const mockArtifact = await hre.artifacts.readArtifact("MockERC20Permit");
    const MockToken = new ethers.ContractFactory(
      mockArtifact.abi,
      mockArtifact.bytecode,
      w.deployer
    );

    asset = await (
      await MockToken.deploy(C.ASSET_NAME, C.ASSET_SYMBOL, C.ASSET_SUPPLY, 18)
    ).waitForDeployment();
    assetAddr = await asset.getAddress();
    ledger.record("S1", "deploy tASSET", await asset.deploymentTransaction().wait(), []);

    usdc = await (
      await MockToken.deploy(C.USDC_NAME, C.USDC_SYMBOL, C.USDC_SUPPLY, 6)
    ).waitForDeployment();
    usdcAddr = await usdc.getAddress();
    ledger.record("S2", "deploy tUSDC", await usdc.deploymentTransaction().wait(), []);

    // The sort order is whatever CREATE gave us; everything downstream is derived from it.
    ({ assetIsToken0, token0, token1 } = uni.sortTokens(assetAddr, usdcAddr));
    zeroForOne = !assetIsToken0; // USDC -> ASSET, the only direction a zap may take
    initialSqrtPriceX96 = uni.initialSqrtPriceX96(assetIsToken0);

    npm = new ethers.Contract(C.NPM_ADDR, C.NPM_ABI, provider);
    npmRead = new ethers.Contract(C.NPM_ADDR, C.NPM_ABI, provider);
    router = new ethers.Contract(C.ROUTER_ADDR, C.ROUTER_ABI, provider);
    factory = new ethers.Contract(C.FACTORY_ADDR, C.FACTORY_ABI, provider);

    // S3 — fund the four users.
    for (const role of ["alice", "bob", "carol", "dave"]) {
      ledger.record(
        "S3",
        `fund ${role} with tASSET`,
        await chain.send(asset.connect(w.deployer).transfer(w[role].address, C.USER_ASSET))
      );
      ledger.record(
        "S3",
        `fund ${role} with tUSDC`,
        await chain.send(usdc.connect(w.deployer).transfer(w[role].address, C.USER_USDC))
      );
    }

    // S4 — standing approvals for the real position manager and router.
    for (const role of ["deployer", "alice", "bob", "carol", "dave"]) {
      for (const token of [asset, usdc]) {
        for (const spender of [C.NPM_ADDR, C.ROUTER_ADDR]) {
          ledger.record(
            "S4",
            `${role} approves ${spender}`,
            await chain.send(token.connect(w[role]).approve(spender, ethers.MaxUint256))
          );
        }
      }
    }

    // S5 — the pool, created by the repo's own script.
    poolRun = await runner.runHardhatScript("scripts/create-sepolia-pool.js", poolScriptEnv(), {
      logFile: path.join(scratchDir, "scripts.log"),
    });
    if (poolRun.code !== 0) {
      throw new Error(
        `scripts/create-sepolia-pool.js exited ${poolRun.code}\n${poolRun.stdout}\n${poolRun.stderr}`
      );
    }
    poolAddr = runner.registryEntry(registryFile, 31337, "UniswapV3Pool").address;
    pool = new ethers.Contract(poolAddr, C.POOL_ABI, provider);
    ledger.record(
      "S5",
      "create + initialize the pool",
      await provider.getTransactionReceipt(await poolCreationTxHash())
    );

    // S6 — the deployer's seed position. Wide, so every later swap stays in range.
    const seed = await mintFor(
      "deployer",
      "seed",
      C.SEED_HALF_WIDTH_TICKS,
      C.SEED_ASSET,
      C.SEED_USDC
    );
    seedTokenId = seed.tokenId;
    ledger.record("S6", "seed the pool with liquidity", seed.receipt);

    // S7 — deploy, wire, hand over and grow the oracle, by the repo's own script.
    deployFromBlock = (await head()) + 1;
    deployRun = await runner.runHardhatScript("scripts/deploy-lp-staking.js", deployScriptEnv(), {
      logFile: path.join(scratchDir, "scripts.log"),
    });
    if (deployRun.code !== 0) {
      throw new Error(
        `scripts/deploy-lp-staking.js exited ${deployRun.code}\n${deployRun.stdout}\n${deployRun.stderr}`
      );
    }
    deployToBlock = await head();

    const registry = runner.readRegistry(registryFile)["31337"];
    tokenXAddr = registry.TokenX.address;
    distributorAddr = registry.RewardsDistributor.address;
    vaultAddr = registry.LPStakingVault.address;
    zapperAddr = registry.LPZapper.address;

    vault = await contractAt("LPStakingVault", vaultAddr);
    zapper = await contractAt("LPZapper", zapperAddr);
    tokenX = await contractAt("TokenX", tokenXAddr);
    distributor = await contractAt("RewardsDistributor", distributorAddr);

    voucherDomain = await signing.readEip712Domain(distributor);

    // S8 — warm the oracle up past the TWAP window with real, small round trips.
    for (let i = 0; i < C.WARMUP_ROUNDS; i++) {
      await rpc.increaseTime(provider, C.WARMUP_STEP_SECONDS);
      const tickBefore = await uni.currentTick(pool);
      const assetBefore = await asset.balanceOf(w.deployer.address);
      ledger.record("S8", `warm-up buy ${i}`, await swapUsdcForAsset("deployer", C.WARMUP_SWAP_USDC));
      const tickMid = await uni.currentTick(pool);
      expect(tickMid, `warm-up buy ${i} did not move the tick`).to.not.equal(tickBefore);

      const gained = (await asset.balanceOf(w.deployer.address)) - assetBefore;
      expect(gained).to.be.greaterThan(0n);

      await rpc.increaseTime(provider, C.WARMUP_STEP_SECONDS);
      ledger.record("S8", `warm-up sell ${i}`, await swapAssetForUsdc("deployer", gained));
      const tickAfter = await uni.currentTick(pool);
      expect(tickAfter, `warm-up sell ${i} did not move the tick`).to.not.equal(tickMid);
    }

    // The oracle now holds enough history for the guard to read on both contracts.
    await pool.observe([C.TWAP_WINDOW, 0]);
    for (const target of [vault, zapper]) {
      const preview = await target.previewTwap();
      expect(preview.withinBounds).to.equal(true);
    }

    notes.push(
      `rpc=${rpcUsed} port=${node.port} block=${C.PINNED_BLOCK} scratch=${scratchDir}`,
      `pinned fees: baseFee=${fees.baseFee} maxFee=${fees.maxFeePerGas} priority=${fees.maxPriorityFeePerGas}`,
      `tASSET=${assetAddr} tUSDC=${usdcAddr} assetIsToken0=${assetIsToken0} zeroForOne=${zeroForOne}`,
      `pool=${poolAddr} sqrtPriceX96=${initialSqrtPriceX96} tick=${await uni.currentTick(pool)}`,
      `vault=${vaultAddr} zapper=${zapperAddr} tokenX=${tokenXAddr} distributor=${distributorAddr}`,
      `scripts: create-sepolia-pool ${poolRun.durationMs} ms, deploy-lp-staking ${deployRun.durationMs} ms`
    );
  });

  after(async function () {
    for (const note of notes) console.log(`  [local-fork] ${note}`);
    if (ledger.entries.length > 0) {
      console.log(
        `  [local-fork] ${ledger.entries.length} ledger entries, blocks ` +
          `${ledger.firstBlock}..${ledger.lastBlock}`
      );
    }
    if (scratchDir) console.log(`  [local-fork] node and script logs: ${scratchDir}`);
    if (provider) provider.destroy();
    if (node) await node.stop();
  });

  // ── environment for the two script children ────────────────────────────

  function baseScriptEnv() {
    return {
      LOCALHOST_RPC_URL: node.rpcUrl,
      // The scripts do not pin fees themselves and the fork inherits mainnet's base fee.
      LOCALHOST_GAS_PRICE: String(fees.maxFeePerGas),
      DEPLOYMENTS_FILE: registryFile,
    };
  }

  function poolScriptEnv(overrides = {}) {
    return {
      ...baseScriptEnv(),
      LP_ASSET: assetAddr,
      LP_USDC: usdcAddr,
      // A local fork reports chain 31337, which the scripts have no defaults for.
      LP_FACTORY: C.FACTORY_ADDR,
      LP_NPM: C.NPM_ADDR,
      LP_FEE: String(C.FEE),
      LP_INITIAL_SQRT_PRICE_X96: initialSqrtPriceX96.toString(),
      ...overrides,
    };
  }

  function deployScriptEnv(overrides = {}) {
    return {
      ...baseScriptEnv(),
      LP_ASSET: assetAddr,
      LP_USDC: usdcAddr,
      LP_POOL: poolAddr,
      LP_NPM: C.NPM_ADDR,
      LP_ROUTER: C.ROUTER_ADDR,
      LP_FEE: String(C.FEE),
      LP_SIGNER: w.backOffice.address,
      LP_MULTISIG: w.multisig.address,
      LP_TOKENX_NAME: C.TOKENX_NAME,
      LP_TOKENX_SYMBOL: C.TOKENX_SYMBOL,
      LP_TWAP_WINDOW: String(C.TWAP_WINDOW),
      LP_TWAP_MAX_DEVIATION_BPS: String(C.MAX_DEVIATION_BPS),
      LP_EPOCH_ID: "1",
      LP_EPOCH_CAP: "1000000",
      LP_OBSERVATION_CARDINALITY: String(C.OBSERVATION_CARDINALITY),
      ...overrides,
    };
  }

  async function contractAt(name, address) {
    const artifact = await hre.artifacts.readArtifact(name);
    return new ethers.Contract(address, artifact.abi, provider);
  }

  /** The pool script's only transaction: the `PoolCreated` log names it. */
  async function poolCreationTxHash() {
    const logs = await rpc.getLogs(provider, {
      address: C.FACTORY_ADDR,
      fromBlock: C.PINNED_BLOCK,
      toBlock: await head(),
      topics: [ethers.id("PoolCreated(address,address,uint24,int24,address)")],
    });
    expect(logs.length, "expected exactly one PoolCreated log on this chain").to.equal(1);
    return logs[0].transactionHash;
  }

  // ═══════════════════════════════════════════════════════════════════════
  describe("0. fork base", function () {
    it("runs a chain-31337 node forked at the pinned block", async function () {
      expect(await provider.send("eth_chainId", [])).to.equal("0x7a69");
      expect((await provider.getNetwork()).chainId).to.equal(C.LOCAL_CHAIN_ID);
      expect(await head()).to.be.greaterThan(C.PINNED_BLOCK);
    });

    it("serves block 25750000 exactly as the upstream endpoint does", async function () {
      const local = await rpc.getBlockByNumber(provider, C.PINNED_BLOCK);
      const upstream = await fetchUpstreamBlock(rpcUsed, C.PINNED_BLOCK);

      expect(local.hash).to.equal(upstream.hash);
      expect(local.parentHash).to.equal(upstream.parentHash);
      expect(local.timestamp).to.equal(upstream.timestamp);
      expect(local.stateRoot).to.equal(upstream.stateRoot);
      expect(Number(local.number)).to.equal(C.PINNED_BLOCK);
    });

    it("chains the first locally mined block onto the pinned one", async function () {
      const pinned = await rpc.getBlockByNumber(provider, C.PINNED_BLOCK);
      const first = await rpc.getBlockByNumber(provider, C.PINNED_BLOCK + 1);
      expect(first.parentHash).to.equal(pinned.hash);
      expect(Number(first.number)).to.equal(C.PINNED_BLOCK + 1);
    });

    it("inherited the real Uniswap deployment and Multicall3", async function () {
      for (const [label, address] of [
        ["factory", C.FACTORY_ADDR],
        ["positionManager", C.NPM_ADDR],
        ["router", C.ROUTER_ADDR],
        ["multicall3", C.MULTICALL3_ADDR],
      ]) {
        const code = await provider.getCode(address);
        expect(code, `${label} has no code on the fork`).to.not.equal("0x");
      }
    });

    it("reads the real REAL/USDC pool's immutables, proving archive state", async function () {
      const realPool = new ethers.Contract(C.REAL_POOL_ADDR, C.POOL_ABI, provider);
      expect(await realPool.token0()).to.equal(C.REAL_ASSET_ADDR);
      expect(await realPool.token1()).to.equal(C.REAL_USDC_ADDR);
      expect(await realPool.fee()).to.equal(BigInt(C.FEE));
      expect(await realPool.tickSpacing()).to.equal(BigInt(C.TICK_SPACING));
      expect(await realPool.liquidity()).to.be.greaterThan(0n);
    });

    it("records how the node answers each block tag", async function () {
      for (const tag of ["latest", "pending", "earliest", "safe", "finalized"]) {
        try {
          const block = await rpc.getBlockByTag(provider, tag);
          blockTags[tag] =
            block === null
              ? "null"
              : block.number === null
                ? `number=null hash=${block.hash === null ? "null" : "set"}`
                : String(Number(block.number));
        } catch (error) {
          blockTags[tag] = `error: ${error.shortMessage || error.message}`;
        }
      }
      notes.push(
        `block tags: ${Object.entries(blockTags)
          .map(([tag, value]) => `${tag}=${value}`)
          .join(" ")}`
      );

      // `latest` is the tag this suite actually depends on, so it is asserted exactly.
      expect(blockTags.latest).to.equal(String(await head()));
      // `earliest` is served by the UPSTREAM archive endpoint, not out of the fork node's own
      // state, which makes it an environment fact rather than a property of this stack: a
      // pruning public fallback can simply refuse genesis. Observed 2026-08-25 — block 0 over
      // Infura and over eth-mainnet.public.blastapi.io, an upstream error over
      // ethereum-sepolia-rpc.publicnode.com. The value is recorded either way (it is in the
      // `block tags:` note above); the assertion admits both shapes rather than failing a run
      // for which endpoint it happened to resolve.
      expect(
        blockTags.earliest === "0" || blockTags.earliest.startsWith("error: "),
        `earliest must be block 0 or an upstream error, got ${blockTags.earliest}`
      ).to.be.true;
      // safe/finalized may be a block or an error on a local node; both are acceptable,
      // which is why the observed value is reported rather than asserted.
      expect(blockTags.safe).to.be.a("string");
      expect(blockTags.finalized).to.be.a("string");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  describe("1. the repo's own scripts, run as children", function () {
    it("created and initialized the pool through the real factory and NPM", async function () {
      expect(poolRun.code).to.equal(0);
      expect(poolRun.stdout).to.include("Pool created:");
      expect(poolRun.stdout).to.include(`Recorded in ${path.basename(registryFile)}`);

      const entry = runner.registryEntry(registryFile, 31337, "UniswapV3Pool");
      expect(entry.address).to.equal(poolAddr);
      expect(entry.token0).to.equal(token0);
      expect(entry.token1).to.equal(token1);
      expect(entry.fee).to.equal(C.FEE);

      expect(await factory.getPool(token0, token1, C.FEE)).to.equal(poolAddr);
      expect(await pool.token0()).to.equal(token0);
      expect(await pool.token1()).to.equal(token1);
      expect(await pool.fee()).to.equal(BigInt(C.FEE));
      expect(await pool.tickSpacing()).to.equal(BigInt(C.TICK_SPACING));
    });

    it("emitted PoolCreated and Initialize in one transaction", async function () {
      const entry = ledger.txOf("S5");
      const receipt = await provider.getTransactionReceipt(entry.txHash);

      const created = chain.parseEvent(receipt, factory.interface, C.FACTORY_ADDR, "PoolCreated");
      expect(created.token0).to.equal(token0);
      expect(created.token1).to.equal(token1);
      expect(created.fee).to.equal(BigInt(C.FEE));
      expect(created.tickSpacing).to.equal(BigInt(C.TICK_SPACING));
      expect(created.pool).to.equal(poolAddr);

      const initialized = chain.parseEvent(receipt, pool.interface, poolAddr, "Initialize");
      expect(initialized.sqrtPriceX96).to.equal(initialSqrtPriceX96);

      // 0.50 tUSDC per tASSET across an 18/6 decimal gap is a raw ratio of 5e-13 or 2e12,
      // i.e. |tick| about 283,250. A missing 1e12 factor, or the wrong sort order, lands
      // three orders of magnitude away, so this is the assertion that the price is right.
      const tick = Number(initialized.tick);
      expect(Math.sign(tick)).to.equal(assetIsToken0 ? -1 : 1);
      expect(Math.abs(tick)).to.be.within(283_000, 283_500);
    });

    it("is idempotent: a second pool run reports the existing pool and mines nothing", async function () {
      const before = await head();
      const rerun = await runner.runHardhatScript("scripts/create-sepolia-pool.js", poolScriptEnv(), {
        logFile: path.join(scratchDir, "scripts.log"),
      });

      expect(rerun.code).to.equal(0);
      expect(rerun.stdout).to.include("Pool already exists");
      expect(rerun.stdout).to.include(`Nothing to do. Deploy against it with LP_POOL=${poolAddr}`);
      expect(await head(), "the idempotent path must not send a transaction").to.equal(before);
      expect(runner.registryEntry(registryFile, 31337, "UniswapV3Pool").address).to.equal(poolAddr);

      notes.push(`create-sepolia-pool.js rerun ${rerun.durationMs} ms (idempotent)`);
    });

    it("deployed and wired the stack, and its own post-deploy checks passed", async function () {
      expect(deployRun.code).to.equal(0);
      expect(deployRun.stdout).to.include("All post-deploy checks passed.");
      expect(deployRun.stdout).to.not.include("FAIL");

      const registry = runner.readRegistry(registryFile)["31337"];
      for (const kind of ["TokenX", "RewardsDistributor", "LPStakingVault", "LPZapper"]) {
        const entry = registry[kind];
        const receipt = await provider.getTransactionReceipt(entry.deployTx);
        expect(receipt, `${kind} deploy tx ${entry.deployTx} is not on chain`).to.not.equal(null);
        expect(receipt.blockNumber).to.equal(entry.block);
        expect(receipt.contractAddress).to.equal(entry.address);
        expect(await provider.getCode(entry.address)).to.not.equal("0x");
      }
    });

    it("handed all four contracts to the multisig and wired them together", async function () {
      for (const [label, contract] of [
        ["tokenX", tokenX],
        ["distributor", distributor],
        ["vault", vault],
        ["zapper", zapper],
      ]) {
        expect(await contract.owner(), `${label}.owner`).to.equal(w.multisig.address);
      }

      expect(await tokenX.minter()).to.equal(distributorAddr);
      expect(await tokenX.name()).to.equal(C.TOKENX_NAME);
      expect(await tokenX.symbol()).to.equal(C.TOKENX_SYMBOL);
      expect(await tokenX.totalSupply()).to.equal(0n);
      expect(await tokenX.currentEpochId()).to.equal(C.EPOCH_ONE);
      expect(await tokenX.epochCap(C.EPOCH_ONE)).to.equal(C.EPOCH_ONE_CAP);

      expect(await distributor.tokenX()).to.equal(tokenXAddr);
      expect(await distributor.asset()).to.equal(assetAddr);
      expect(await distributor.signer()).to.equal(w.backOffice.address);
      expect(await distributor.paused()).to.equal(false);
      expect(await distributor.assetClaimsEnabled()).to.equal(false);

      expect(await vault.pool()).to.equal(poolAddr);
      expect(await vault.positionManager()).to.equal(C.NPM_ADDR);
      expect(await vault.swapRouter()).to.equal(C.ROUTER_ADDR);
      expect(await vault.token0()).to.equal(token0);
      expect(await vault.token1()).to.equal(token1);
      expect(await vault.fee()).to.equal(BigInt(C.FEE));
      expect(await vault.zapper()).to.equal(zapperAddr);
      expect(await vault.depositsPaused()).to.equal(false);
      expect(await vault.twapWindow()).to.equal(BigInt(C.TWAP_WINDOW));
      expect(await vault.maxTwapDeviationTicks()).to.equal(BigInt(C.MAX_DEVIATION_TICKS));

      expect(await zapper.vault()).to.equal(vaultAddr);
      expect(await zapper.usdc()).to.equal(usdcAddr);
      expect(await zapper.asset()).to.equal(assetAddr);
      // The sort order is a runtime fact; the zapper must have read it the same way.
      expect(await zapper.usdcIsToken0()).to.equal(!assetIsToken0);
      expect(await zapper.usdcIsToken0()).to.equal(zeroForOne);
    });

    it("grew the oracle to the configured cardinality", async function () {
      const slot0 = await pool.slot0();
      expect(slot0.observationCardinalityNext).to.equal(BigInt(C.OBSERVATION_CARDINALITY));
      expect(slot0.observationCardinality).to.be.greaterThan(1n);

      const logs = chain.decodeLogs(
        await rpc.getLogs(provider, {
          address: poolAddr,
          fromBlock: deployFromBlock,
          toBlock: deployToBlock,
          topics: [ethers.id("IncreaseObservationCardinalityNext(uint16,uint16)")],
        }),
        { [poolAddr.toLowerCase()]: pool.interface }
      );
      expect(logs.length).to.equal(1);
      expect(logs[0].args.observationCardinalityNextOld).to.equal(1n);
      expect(logs[0].args.observationCardinalityNextNew).to.equal(
        BigInt(C.OBSERVATION_CARDINALITY)
      );
    });

    it("emitted the wiring events the runbook documents, in script order", async function () {
      const expectedPerContract = {
        [tokenXAddr.toLowerCase()]: [
          "OwnershipTransferred", // Ownable(deployer), in the constructor
          "MinterChanged",
          "EpochCapSet",
          "OwnershipTransferred", // -> multisig
        ],
        // The distributor is a UUPS proxy, so its deploy tx is the PROXY's: `Upgraded` names
        // the implementation the ERC-1967 slot got, then `initialize` runs inside the same
        // transaction (owner, guardian, signer) and `Initialized` closes it. There is no
        // second `OwnershipTransferred` because `initialize` names the multisig directly —
        // an Ownable2Step handover would need the multisig to send an `acceptOwnership`.
        [distributorAddr.toLowerCase()]: [
          "Upgraded",
          "OwnershipTransferred",
          "GuardianSet",
          "SignerChanged",
          "Initialized",
        ],
        [vaultAddr.toLowerCase()]: [
          "OwnershipTransferred",
          "TwapParamsSet",
          "ZapperSet",
          "OwnershipTransferred",
        ],
        [zapperAddr.toLowerCase()]: [
          "OwnershipTransferred",
          "TwapParamsSet",
          "OwnershipTransferred",
        ],
      };

      const ifaces = ifacesByAddress();
      for (const [address, expectedNames] of Object.entries(expectedPerContract)) {
        const decoded = chain.decodeLogs(
          await rpc.getLogs(provider, {
            address,
            fromBlock: deployFromBlock,
            toBlock: deployToBlock,
          }),
          ifaces
        );
        expect(decoded.map((d) => d.name), `${address} deploy-run log sequence`).to.deep.equal(
          expectedNames
        );
      }

      const tokenXLogs = chain.decodeLogs(
        await rpc.getLogs(provider, {
          address: tokenXAddr,
          fromBlock: deployFromBlock,
          toBlock: deployToBlock,
        }),
        ifaces
      );
      expect(tokenXLogs[0].args.previousOwner).to.equal(C.ZERO_ADDRESS);
      expect(tokenXLogs[0].args.newOwner).to.equal(w.deployer.address);
      expect(tokenXLogs[1].args.newMinter).to.equal(distributorAddr);
      expect(tokenXLogs[2].args.epochId).to.equal(C.EPOCH_ONE);
      expect(tokenXLogs[2].args.cap).to.equal(C.EPOCH_ONE_CAP);
      expect(tokenXLogs[3].args.newOwner).to.equal(w.multisig.address);
    });

    it("reports the EIP-712 domain and type hashes the back office must sign against", async function () {
      // The domain is a runtime fact of a contract deployed a minute ago: its chain id is
      // the fork's, and its verifying contract did not exist before this run.
      expect(voucherDomain.name).to.equal("RealLPRewards");
      expect(voucherDomain.version).to.equal("1");
      expect(voucherDomain.chainId).to.equal(C.LOCAL_CHAIN_ID);
      expect(voucherDomain.verifyingContract).to.equal(distributorAddr);

      // Recomputed from the struct strings signing.js signs with, so a change to either
      // type string in RewardsDistributor.sol fails here rather than at the first claim.
      expect(await distributor.TOKENX_CLAIM_TYPEHASH()).to.equal(
        signing.claimTypeHash("TokenXClaim")
      );
      expect(await distributor.ASSET_CLAIM_TYPEHASH()).to.equal(
        signing.claimTypeHash("AssetClaim")
      );
      // Distinct struct names are the whole reason a voucher for one leg cannot pay the other.
      expect(signing.claimTypeHash("TokenXClaim")).to.not.equal(
        signing.claimTypeHash("AssetClaim")
      );
    });

    it("refuses a swapped LP_ASSET / LP_USDC pair before spending any gas", async function () {
      const before = await head();
      const refused = await runner.runHardhatScript(
        "scripts/deploy-lp-staking.js",
        deployScriptEnv({ LP_ASSET: usdcAddr, LP_USDC: assetAddr }),
        { logFile: path.join(scratchDir, "scripts.log") }
      );

      expect(refused.code).to.not.equal(0);
      expect(`${refused.stdout}${refused.stderr}`).to.include("LP_ASSET and LP_USDC look swapped");
      expect(await head(), "the refusal must not send a transaction").to.equal(before);

      // And it recorded nothing: the registry still holds the good deployment.
      expect(runner.registryEntry(registryFile, 31337, "LPStakingVault").address).to.equal(
        vaultAddr
      );
    });

    it("left the tracked deployments.json untouched and wrote only to the override", async function () {
      expect(runner.sha256File(runner.TRACKED_REGISTRY)).to.equal(TRACKED_REGISTRY_SHA256);

      const override = runner.readRegistry(registryFile);
      expect(Object.keys(override)).to.deep.equal(["31337"]);
      expect(Object.keys(override["31337"]).sort()).to.deep.equal([
        "LPStakingVault",
        "LPZapper",
        "RewardsDistributor",
        "TokenX",
        "UniswapV3Pool",
      ]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  describe("2. the forty-five step scenario, one transaction per block", function () {
    it("A1: alice mints P1", async function () {
      const { receipt, tokenId, tickLower, tickUpper } = await mintFor(
        "alice",
        "P1",
        1200,
        C.ASSET(4_000),
        C.USDC(1_000)
      );
      ledger.record("A1", "alice mints P1", receipt);

      const position = await npm.positions(tokenId);
      expect(position.token0).to.equal(token0);
      expect(position.token1).to.equal(token1);
      expect(position.fee).to.equal(BigInt(C.FEE));
      expect(position.tickLower).to.equal(BigInt(tickLower));
      expect(position.tickUpper).to.equal(BigInt(tickUpper));
      expect(position.liquidity).to.be.greaterThan(0n);
      expect(await npm.ownerOf(tokenId)).to.equal(w.alice.address);
    });

    it("A2: alice approves the vault for P1", async function () {
      ledger.record(
        "A2",
        "alice approves the vault for P1",
        await chain.send(npm.connect(w.alice).approve(vaultAddr, positions.P1))
      );
      expect(await npm.getApproved(positions.P1)).to.equal(vaultAddr);
    });

    it("A3: alice stakes P1 and the vault takes custody", async function () {
      const liquidity = (await npm.positions(positions.P1)).liquidity;
      const receipt = await chain.send(vault.connect(w.alice).stake(positions.P1));
      ledger.record("A3", "alice stakes P1", receipt, [{ address: vaultAddr, name: "Staked" }]);

      const args = chain.parseEvent(receipt, vault.interface, vaultAddr, "Staked");
      expect(args.user).to.equal(w.alice.address);
      expect(args.tokenId).to.equal(positions.P1);
      expect(args.liquidity).to.equal(liquidity);
      expect(args.timestamp).to.equal(BigInt(await timestampOf(receipt.blockNumber)));

      expect(await npm.ownerOf(positions.P1)).to.equal(vaultAddr);
      expect(await vault.stakerOf(positions.P1)).to.equal(w.alice.address);
    });

    it("A4: bob mints P2", async function () {
      const { receipt, tokenId } = await mintFor("bob", "P2", 1200, C.ASSET(4_000), C.USDC(1_000));
      ledger.record("A4", "bob mints P2", receipt);
      expect(await npm.ownerOf(tokenId)).to.equal(w.bob.address);
      expect(await npm.getApproved(tokenId)).to.equal(C.ZERO_ADDRESS);
    });

    it("A5: bob stakes P2 from an ERC-721 permit, with no prior approval", async function () {
      const signature = await signing.signNftPermit({
        provider,
        npmAddress: C.NPM_ADDR,
        owner: w.bob,
        spender: vaultAddr,
        tokenId: positions.P2,
        deadline: C.FAR_DEADLINE,
      });
      expect((await npm.positions(positions.P2)).nonce).to.equal(0n);

      const receipt = await chain.send(
        vault
          .connect(w.bob)
          .stakeWithPermit(positions.P2, C.FAR_DEADLINE, signature.v, signature.r, signature.s)
      );
      ledger.record("A5", "bob stakes P2 by permit", receipt, [
        { address: vaultAddr, name: "Staked" },
      ]);

      const args = chain.parseEvent(receipt, vault.interface, vaultAddr, "Staked");
      expect(args.user).to.equal(w.bob.address);
      expect(args.tokenId).to.equal(positions.P2);
      expect(await npm.ownerOf(positions.P2)).to.equal(vaultAddr);
      expect(await vault.stakerOf(positions.P2)).to.equal(w.bob.address);
      expect((await npm.positions(positions.P2)).nonce).to.equal(1n);
    });

    it("A6: carol approves the zapper for 5000 tUSDC", async function () {
      ledger.record(
        "A6",
        "carol approves the zapper",
        await chain.send(usdc.connect(w.carol).approve(zapperAddr, C.USDC(5_000)))
      );
      expect(await usdc.allowance(w.carol.address, zapperAddr)).to.equal(C.USDC(5_000));
    });

    it("A7: carol zaps 5000 tUSDC into a staked position P3", async function () {
      const c = await centre();
      const amount = C.USDC(5_000);
      const usdcBefore = await usdc.balanceOf(w.carol.address);
      const assetBefore = await asset.balanceOf(w.carol.address);

      const receipt = await chain.send(
        zapper
          .connect(w.carol)
          .zapIn(amount, c - 1200, c + 1200, swapLeg(amount / 3n), C.FAR_DEADLINE)
      );
      ledger.record("A7", "carol zaps in -> P3", receipt, [
        { address: vaultAddr, name: "Staked" },
        { address: zapperAddr, name: "ZappedIn" },
      ]);

      const zapped = chain.parseEvent(receipt, zapper.interface, zapperAddr, "ZappedIn");
      positions.P3 = zapped.tokenId;
      expect(zapped.user).to.equal(w.carol.address);
      expect(zapped.usdcIn).to.equal(amount);
      expect(zapped.usdcRefunded).to.be.greaterThan(0n);

      const staked = chain.parseEvent(receipt, vault.interface, vaultAddr, "Staked");
      expect(staked.user).to.equal(w.carol.address);
      expect(staked.tokenId).to.equal(zapped.tokenId);

      expect(await vault.stakerOf(zapped.tokenId)).to.equal(w.carol.address);
      expect(await npm.ownerOf(zapped.tokenId)).to.equal(vaultAddr);
      expect(usdcBefore - (await usdc.balanceOf(w.carol.address))).to.equal(
        amount - zapped.usdcRefunded
      );
      expect((await asset.balanceOf(w.carol.address)) - assetBefore).to.equal(zapped.assetRefunded);
      expect(await usdc.balanceOf(zapperAddr)).to.equal(0n);
      expect(await asset.balanceOf(zapperAddr)).to.equal(0n);
    });

    it("A8: dave zaps in with an EIP-2612 permit -> P4", async function () {
      expect(await usdc.allowance(w.dave.address, zapperAddr)).to.equal(0n);
      const c = await centre();
      const amount = C.USDC(5_000);
      const signature = await signing.signErc2612({
        provider,
        token: usdc,
        tokenName: C.USDC_NAME,
        tokenVersion: C.ERC2612_VERSION,
        owner: w.dave,
        spender: zapperAddr,
        value: amount,
        deadline: C.FAR_DEADLINE,
      });

      const receipt = await chain.send(
        zapper
          .connect(w.dave)
          .zapInWithPermit(amount, c - 1200, c + 1200, swapLeg(amount / 3n), C.FAR_DEADLINE, {
            value: amount,
            deadline: C.FAR_DEADLINE,
            v: signature.v,
            r: signature.r,
            s: signature.s,
          })
      );
      ledger.record("A8", "dave zaps in by permit -> P4", receipt, [
        { address: vaultAddr, name: "Staked" },
        { address: zapperAddr, name: "ZappedIn" },
      ]);

      const zapped = chain.parseEvent(receipt, zapper.interface, zapperAddr, "ZappedIn");
      positions.P4 = zapped.tokenId;
      expect(zapped.user).to.equal(w.dave.address);
      expect(await vault.stakerOf(zapped.tokenId)).to.equal(w.dave.address);
      expect(await npm.ownerOf(zapped.tokenId)).to.equal(vaultAddr);
      expect(await usdc.nonces(w.dave.address)).to.equal(1n);
    });

    it("A9: real trading accrues real fees on the staked positions", async function () {
      for (let i = 0; i < C.FEE_ROUNDS; i++) {
        const before = await asset.balanceOf(w.deployer.address);
        ledger.record("A9", `fee round ${i} buy`, await swapUsdcForAsset("deployer", C.FEE_SWAP_USDC));
        const gained = (await asset.balanceOf(w.deployer.address)) - before;
        await rpc.increaseTime(provider, C.FEE_STEP_SECONDS);
        ledger.record("A9", `fee round ${i} sell`, await swapAssetForUsdc("deployer", gained));
        await rpc.increaseTime(provider, C.FEE_STEP_SECONDS);
      }

      const preview = await uni.previewWithdraw({
        npm,
        npmRead,
        tokenId: positions.P1,
        owner: vaultAddr,
      });
      expect(
        preview.fees0 + preview.fees1,
        "no fees accrued — the fee generator missed the range"
      ).to.be.greaterThan(0n);
    });

    it("A10: alice rebalances P1 into a tighter range through a real swap", async function () {
      const before = await uni.previewWithdraw({
        npm,
        npmRead,
        tokenId: positions.P1,
        owner: vaultAddr,
      });
      const side = usdcSide(before);
      const amountIn = (side.principal + side.fees) / 5n;
      expect(amountIn).to.be.greaterThan(0n);

      const c = await centre();
      const assetBefore = await asset.balanceOf(w.alice.address);
      const usdcBefore = await usdc.balanceOf(w.alice.address);

      const receipt = await chain.send(
        vault
          .connect(w.alice)
          .rebalance(positions.P1, c - 600, c + 600, swapLeg(amountIn), C.FAR_DEADLINE)
      );
      ledger.record("A10", "alice rebalances P1 -> P5", receipt, [
        { address: vaultAddr, name: "Rebalanced" },
      ]);

      const args = chain.parseEvent(receipt, vault.interface, vaultAddr, "Rebalanced");
      positions.P5 = args.newTokenId;
      expect(args.user).to.equal(w.alice.address);
      expect(args.oldTokenId).to.equal(positions.P1);
      expect(args.tickLower).to.equal(BigInt(c - 600));
      expect(args.tickUpper).to.equal(BigInt(c + 600));
      expect(args.liquidity).to.be.greaterThan(0n);

      expect(await vault.stakerOf(positions.P1)).to.equal(C.ZERO_ADDRESS);
      await chain.expectReverted(npm.ownerOf(positions.P1), `ownerOf(P1) after the burn`);
      expect(await npm.ownerOf(args.newTokenId)).to.equal(vaultAddr);
      expect(await vault.stakerOf(args.newTokenId)).to.equal(w.alice.address);

      const [refundAsset, refundUsdc] = assetIsToken0
        ? [args.amount0Refunded, args.amount1Refunded]
        : [args.amount1Refunded, args.amount0Refunded];
      expect((await asset.balanceOf(w.alice.address)) - assetBefore).to.equal(refundAsset);
      expect((await usdc.balanceOf(w.alice.address)) - usdcBefore).to.equal(refundUsdc);
      expect(await asset.balanceOf(vaultAddr)).to.equal(0n);
      expect(await usdc.balanceOf(vaultAddr)).to.equal(0n);
    });

    it("A11: bob rebalances P2 without a swap leg, compounding his fees", async function () {
      const c = await centre();
      const before = await uni.previewWithdraw({
        npm,
        npmRead,
        tokenId: positions.P2,
        owner: vaultAddr,
      });

      const receipt = await chain.send(
        vault.connect(w.bob).rebalance(positions.P2, c - 1800, c + 1800, swapLeg(0n), C.FAR_DEADLINE)
      );
      ledger.record("A11", "bob rebalances P2 -> P6", receipt, [
        { address: vaultAddr, name: "Rebalanced" },
      ]);

      const args = chain.parseEvent(receipt, vault.interface, vaultAddr, "Rebalanced");
      positions.P6 = args.newTokenId;
      expect(args.oldTokenId).to.equal(positions.P2);
      expect(await vault.stakerOf(args.newTokenId)).to.equal(w.bob.address);

      // No swap leg, so nothing may leave: placed + refunded <= principal + fees, within
      // Uniswap's own rounding.
      const after = await uni.previewWithdraw({
        npm,
        npmRead,
        tokenId: args.newTokenId,
        owner: vaultAddr,
      });
      const available0 = before.principal0 + before.fees0;
      const available1 = before.principal1 + before.fees1;
      const placed0 = after.principal0 + args.amount0Refunded;
      const placed1 = after.principal1 + args.amount1Refunded;
      expect(placed0).to.be.lessThanOrEqual(available0);
      expect(placed1).to.be.lessThanOrEqual(available1);
      expect(available0 - placed0).to.be.lessThanOrEqual(available0 / 1_000_000n + 10n);
      expect(available1 - placed1).to.be.lessThanOrEqual(available1 / 1_000_000n + 10n);
    });

    it("A12: alice unstakes P5 and gets the NFT back", async function () {
      const receipt = await chain.send(vault.connect(w.alice).unstake(positions.P5));
      ledger.record("A12", "alice unstakes P5", receipt, [
        { address: vaultAddr, name: "Unstaked" },
      ]);

      const args = chain.parseEvent(receipt, vault.interface, vaultAddr, "Unstaked");
      expect(args.user).to.equal(w.alice.address);
      expect(args.tokenId).to.equal(positions.P5);
      expect(await npm.ownerOf(positions.P5)).to.equal(w.alice.address);
      expect(await vault.stakerOf(positions.P5)).to.equal(C.ZERO_ADDRESS);
    });

    it("A13: alice re-approves the vault for P5", async function () {
      ledger.record(
        "A13",
        "alice re-approves P5",
        await chain.send(npm.connect(w.alice).approve(vaultAddr, positions.P5))
      );
      expect(await npm.getApproved(positions.P5)).to.equal(vaultAddr);
    });

    it("A14: alice re-stakes P5", async function () {
      const receipt = await chain.send(vault.connect(w.alice).stake(positions.P5));
      ledger.record("A14", "alice re-stakes P5", receipt, [{ address: vaultAddr, name: "Staked" }]);
      expect(await vault.stakerOf(positions.P5)).to.equal(w.alice.address);
      expect(await npm.ownerOf(positions.P5)).to.equal(vaultAddr);
    });

    it("A15: the multisig pauses deposits", async function () {
      const receipt = await chain.send(vault.connect(w.multisig).setDepositsPaused(true));
      ledger.record("A15", "multisig pauses deposits", receipt, [
        { address: vaultAddr, name: "DepositsPausedSet" },
      ]);
      expect(
        chain.parseEvent(receipt, vault.interface, vaultAddr, "DepositsPausedSet").depositsPaused
      ).to.equal(true);
      expect(await vault.depositsPaused()).to.equal(true);
    });

    it("A16: carol's stake reverts with DepositsArePaused and mines nothing", async function () {
      const minted = await mintFor("carol", "P7", 1200, C.ASSET(4_000), C.USDC(1_000));
      ledger.record("A16", "carol mints P7", minted.receipt);
      ledger.record(
        "A16",
        "carol approves the vault for P7",
        await chain.send(npm.connect(w.carol).approve(vaultAddr, positions.P7))
      );

      const { headBefore } = await chain.expectCustomError(
        provider,
        vault.connect(w.carol).stake(positions.P7),
        vault.interface,
        "DepositsArePaused"
      );
      ledger.recordRevert("A16", "carol's stake is refused", headBefore, "DepositsArePaused");

      expect(await vault.stakerOf(positions.P7)).to.equal(C.ZERO_ADDRESS);
      expect(await npm.ownerOf(positions.P7)).to.equal(w.carol.address);
    });

    it("A17: the multisig resumes deposits", async function () {
      const receipt = await chain.send(vault.connect(w.multisig).setDepositsPaused(false));
      ledger.record("A17", "multisig resumes deposits", receipt, [
        { address: vaultAddr, name: "DepositsPausedSet" },
      ]);
      expect(await vault.depositsPaused()).to.equal(false);
    });

    it("A18: carol stakes P7 now that deposits are open", async function () {
      const receipt = await chain.send(vault.connect(w.carol).stake(positions.P7));
      ledger.record("A18", "carol stakes P7", receipt, [{ address: vaultAddr, name: "Staked" }]);
      expect(await vault.stakerOf(positions.P7)).to.equal(w.carol.address);
    });

    it("A19: the multisig retunes the vault's TWAP guard", async function () {
      const receipt = await chain.send(
        vault
          .connect(w.multisig)
          .setTwapParams(C.RETUNED_TWAP_WINDOW, C.RETUNED_MAX_DEVIATION_TICKS)
      );
      ledger.record("A19", "multisig retunes the vault", receipt, [
        { address: vaultAddr, name: "TwapParamsSet" },
      ]);

      const args = chain.parseEvent(receipt, vault.interface, vaultAddr, "TwapParamsSet");
      expect(args.window).to.equal(BigInt(C.RETUNED_TWAP_WINDOW));
      expect(args.maxDeviationTicks).to.equal(BigInt(C.RETUNED_MAX_DEVIATION_TICKS));
      expect(await vault.twapWindow()).to.equal(BigInt(C.RETUNED_TWAP_WINDOW));
      expect(await vault.maxTwapDeviationTicks()).to.equal(BigInt(C.RETUNED_MAX_DEVIATION_TICKS));

      // The warm-up left more than the new window's worth of history, so the guard still reads.
      const preview = await vault.previewTwap();
      expect(preview.maxDeviationTicks).to.equal(BigInt(C.RETUNED_MAX_DEVIATION_TICKS));
      expect(preview.withinBounds).to.equal(true);
    });

    it("A20: the multisig retunes the zapper's TWAP guard", async function () {
      const receipt = await chain.send(
        zapper
          .connect(w.multisig)
          .setTwapParams(C.RETUNED_TWAP_WINDOW, C.RETUNED_MAX_DEVIATION_TICKS)
      );
      ledger.record("A20", "multisig retunes the zapper", receipt, [
        { address: zapperAddr, name: "TwapParamsSet" },
      ]);
      expect(await zapper.twapWindow()).to.equal(BigInt(C.RETUNED_TWAP_WINDOW));
      expect((await zapper.previewTwap()).withinBounds).to.equal(true);
    });

    it("A21: carol redeems a 1000 TokenX voucher", async function () {
      const amount = C.TOKENS(1_000);
      const signature = await voucher("TokenXClaim", "carol", amount);
      const receipt = await chain.send(
        distributor.connect(w.carol).claimTokenX(amount, C.FAR_DEADLINE, signature)
      );
      ledger.record("A21", "carol claims 1000 TokenX", receipt, [
        { address: tokenXAddr, name: "Transfer" },
        { address: distributorAddr, name: "Claimed" },
      ]);

      const args = chain.parseEvent(receipt, distributor.interface, distributorAddr, "Claimed");
      expect(args.user).to.equal(w.carol.address);
      expect(args.token).to.equal(tokenXAddr);
      expect(args.cumulativeAmount).to.equal(amount);
      expect(args.paidAmount).to.equal(amount);
      expect(args.timestamp).to.equal(BigInt(await timestampOf(receipt.blockNumber)));

      expect(await tokenX.balanceOf(w.carol.address)).to.equal(amount);
      expect(await distributor.claimedTokenX(w.carol.address)).to.equal(amount);
      expect(await tokenX.mintedInEpoch(C.EPOCH_ONE)).to.equal(amount);
    });

    it("A22: carol's second voucher pays only the difference", async function () {
      const cumulative = C.TOKENS(1_750);
      const delta = cumulative - C.TOKENS(1_000);
      const signature = await voucher("TokenXClaim", "carol", cumulative);
      const receipt = await chain.send(
        distributor.connect(w.carol).claimTokenX(cumulative, C.FAR_DEADLINE, signature)
      );
      ledger.record("A22", "carol claims 1750 TokenX cumulative", receipt, [
        { address: tokenXAddr, name: "Transfer" },
        { address: distributorAddr, name: "Claimed" },
      ]);

      const args = chain.parseEvent(receipt, distributor.interface, distributorAddr, "Claimed");
      expect(args.cumulativeAmount).to.equal(cumulative);
      expect(args.paidAmount).to.equal(delta);
      expect(await tokenX.balanceOf(w.carol.address)).to.equal(cumulative);
      expect(await tokenX.mintedInEpoch(C.EPOCH_ONE)).to.equal(cumulative);
    });

    it("A23: the multisig arms epoch 2", async function () {
      const activatesAt = BigInt((await latestTimestamp()) + C.EPOCH_ROLLOVER_DELAY);
      const receipt = await chain.send(
        tokenX.connect(w.multisig).armNextEpoch(C.EPOCH_TWO, C.EPOCH_TWO_CAP, activatesAt)
      );
      ledger.record("A23", "multisig arms epoch 2", receipt, [
        { address: tokenXAddr, name: "NextEpochArmed" },
      ]);

      const args = chain.parseEvent(receipt, tokenX.interface, tokenXAddr, "NextEpochArmed");
      expect(args.epochId).to.equal(C.EPOCH_TWO);
      expect(args.cap).to.equal(C.EPOCH_TWO_CAP);
      expect(args.activatesAt).to.equal(activatesAt);
      epochs.firstArming = activatesAt;
      expect((await tokenX.pendingEpoch()).activatesAt).to.equal(activatesAt);
    });

    it("A24: the multisig cancels the armed epoch", async function () {
      const receipt = await chain.send(tokenX.connect(w.multisig).cancelNextEpoch());
      ledger.record("A24", "multisig cancels epoch 2", receipt, [
        { address: tokenXAddr, name: "NextEpochCancelled" },
      ]);

      const args = chain.parseEvent(receipt, tokenX.interface, tokenXAddr, "NextEpochCancelled");
      expect(args.epochId).to.equal(C.EPOCH_TWO);
      expect(args.cap).to.equal(C.EPOCH_TWO_CAP);
      expect(args.activatesAt).to.equal(epochs.firstArming);
      expect((await tokenX.pendingEpoch()).activatesAt).to.equal(0n);
    });

    it("A25: the multisig arms epoch 2 again", async function () {
      const activatesAt = BigInt((await latestTimestamp()) + C.EPOCH_ROLLOVER_DELAY);
      const receipt = await chain.send(
        tokenX.connect(w.multisig).armNextEpoch(C.EPOCH_TWO, C.EPOCH_TWO_CAP, activatesAt)
      );
      ledger.record("A25", "multisig re-arms epoch 2", receipt, [
        { address: tokenXAddr, name: "NextEpochArmed" },
      ]);
      epochs.secondArming = activatesAt;
      expect((await tokenX.pendingEpoch()).activatesAt).to.equal(activatesAt);
    });

    it("A26: the clock jumps past the boundary without activating anything", async function () {
      const blockNumber = await rpc.advance(provider, C.EPOCH_ROLLOVER_OVERSHOOT);
      ledger.recordBlock("A26", "clock jumps past the epoch boundary", blockNumber);

      expect(BigInt(await latestTimestamp())).to.be.greaterThanOrEqual(epochs.secondArming);
      // Lazy by design: the running epoch still reads stale, `effectiveEpoch()` does not.
      expect(await tokenX.currentEpochId()).to.equal(C.EPOCH_ONE);
      const effective = await tokenX.effectiveEpoch();
      expect(effective.epochId).to.equal(C.EPOCH_TWO);
      expect(effective.cap).to.equal(C.EPOCH_TWO_CAP);
    });

    it("A27: dave's claim rolls epoch 2 in and is charged to it", async function () {
      const amount = C.TOKENS(2_000);
      const signature = await voucher("TokenXClaim", "dave", amount);
      const receipt = await chain.send(
        distributor.connect(w.dave).claimTokenX(amount, C.FAR_DEADLINE, signature)
      );
      ledger.record("A27", "dave's claim activates epoch 2", receipt, [
        { address: tokenXAddr, name: "EpochActivated" },
        { address: tokenXAddr, name: "Transfer" },
        { address: distributorAddr, name: "Claimed" },
      ]);

      const activated = chain.parseEvent(receipt, tokenX.interface, tokenXAddr, "EpochActivated");
      expect(activated.epochId).to.equal(C.EPOCH_TWO);
      expect(activated.cap).to.equal(C.EPOCH_TWO_CAP);
      expect(activated.scheduledFor).to.equal(epochs.secondArming);
      expect(activated.activatedAt).to.equal(BigInt(await timestampOf(receipt.blockNumber)));

      const claimed = chain.parseEvent(receipt, distributor.interface, distributorAddr, "Claimed");
      expect(claimed.user).to.equal(w.dave.address);
      expect(claimed.paidAmount).to.equal(amount);

      expect(await tokenX.currentEpochId()).to.equal(C.EPOCH_TWO);
      expect(await tokenX.mintedInEpoch(C.EPOCH_TWO)).to.equal(amount);
      expect(await tokenX.mintedInEpoch(C.EPOCH_ONE)).to.equal(C.TOKENS(1_750));
      expect((await tokenX.pendingEpoch()).activatesAt).to.equal(0n);
    });

    it("A28: the multisig enables the ASSET reward leg", async function () {
      const receipt = await chain.send(distributor.connect(w.multisig).setAssetClaimsEnabled(true));
      ledger.record("A28", "multisig enables the ASSET leg", receipt, [
        { address: distributorAddr, name: "AssetClaimsEnabled" },
      ]);
      expect(await distributor.assetClaimsEnabled()).to.equal(true);
    });

    it("A29: the treasury funds the distributor with 10000 tASSET", async function () {
      const receipt = await chain.send(
        asset.connect(w.deployer).transfer(distributorAddr, C.ASSET(10_000))
      );
      ledger.record("A29", "fund the distributor", receipt, [
        { address: assetAddr, name: "Transfer" },
      ]);
      expect(await asset.balanceOf(distributorAddr)).to.equal(C.ASSET(10_000));
    });

    it("A30: bob claims 3000 tASSET", async function () {
      const amount = C.ASSET(3_000);
      const signature = await voucher("AssetClaim", "bob", amount);
      const balanceBefore = await asset.balanceOf(w.bob.address);

      const receipt = await chain.send(
        distributor.connect(w.bob).claimAsset(amount, C.FAR_DEADLINE, signature)
      );
      ledger.record("A30", "bob claims 3000 tASSET", receipt, [
        { address: assetAddr, name: "Transfer" },
        { address: distributorAddr, name: "Claimed" },
      ]);

      const args = chain.parseEvent(receipt, distributor.interface, distributorAddr, "Claimed");
      expect(args.user).to.equal(w.bob.address);
      expect(args.token).to.equal(assetAddr);
      expect(args.paidAmount).to.equal(amount);
      expect((await asset.balanceOf(w.bob.address)) - balanceBefore).to.equal(amount);
      expect(await distributor.claimedAsset(w.bob.address)).to.equal(amount);
      expect(await asset.balanceOf(distributorAddr)).to.equal(C.ASSET(7_000));
    });

    it("A31: the multisig recovers 1000 tASSET of overfunding", async function () {
      const amount = C.ASSET(1_000);
      const balanceBefore = await asset.balanceOf(w.multisig.address);
      const receipt = await chain.send(distributor.connect(w.multisig).recoverExcessAsset(amount));
      ledger.record("A31", "multisig recovers 1000 tASSET", receipt, [
        { address: assetAddr, name: "Transfer" },
        { address: distributorAddr, name: "ExcessAssetRecovered" },
      ]);

      const args = chain.parseEvent(
        receipt,
        distributor.interface,
        distributorAddr,
        "ExcessAssetRecovered"
      );
      expect(args.to).to.equal(w.multisig.address);
      expect(args.amount).to.equal(amount);
      expect(args.timestamp).to.equal(BigInt(await timestampOf(receipt.blockNumber)));
      expect((await asset.balanceOf(w.multisig.address)) - balanceBefore).to.equal(amount);
      expect(await asset.balanceOf(distributorAddr)).to.equal(C.ASSET(6_000));
    });

    it("A32: the multisig pauses claims", async function () {
      const receipt = await chain.send(distributor.connect(w.multisig).setPaused(true));
      ledger.record("A32", "multisig pauses claims", receipt, [
        { address: distributorAddr, name: "Paused" },
      ]);
      expect(await distributor.paused()).to.equal(true);
    });

    it("A33: bob's next claim reverts with ClaimsPaused and mines nothing", async function () {
      const amount = C.ASSET(4_000);
      const signature = await voucher("AssetClaim", "bob", amount);
      const { headBefore } = await chain.expectCustomError(
        provider,
        distributor.connect(w.bob).claimAsset(amount, C.FAR_DEADLINE, signature),
        distributor.interface,
        "ClaimsPaused"
      );
      ledger.recordRevert("A33", "bob's claim is refused", headBefore, "ClaimsPaused");
      expect(await distributor.claimedAsset(w.bob.address)).to.equal(C.ASSET(3_000));
    });

    it("A34: the multisig unpauses claims", async function () {
      const receipt = await chain.send(distributor.connect(w.multisig).setPaused(false));
      ledger.record("A34", "multisig unpauses claims", receipt, [
        { address: distributorAddr, name: "Paused" },
      ]);
      expect(await distributor.paused()).to.equal(false);
    });

    it("A35: the multisig rotates the voucher signer", async function () {
      const receipt = await chain.send(distributor.connect(w.multisig).setSigner(w.signer2.address));
      ledger.record("A35", "multisig rotates the signer", receipt, [
        { address: distributorAddr, name: "SignerChanged" },
      ]);

      const args = chain.parseEvent(receipt, distributor.interface, distributorAddr, "SignerChanged");
      expect(args.previousSigner).to.equal(w.backOffice.address);
      expect(args.newSigner).to.equal(w.signer2.address);
      expect(await distributor.signer()).to.equal(w.signer2.address);
    });

    it("A36: the multisig rotates it back to the back office", async function () {
      const receipt = await chain.send(
        distributor.connect(w.multisig).setSigner(w.backOffice.address)
      );
      ledger.record("A36", "multisig restores the signer", receipt, [
        { address: distributorAddr, name: "SignerChanged" },
      ]);
      expect(await distributor.signer()).to.equal(w.backOffice.address);
    });

    it("A37: a stray NFT pushed into the vault is rescued to the multisig", async function () {
      const minted = await mintFor("dave", "P8", 1200, C.ASSET(100), C.USDC(25));
      ledger.record("A37", "dave mints P8", minted.receipt);

      // A plain `transferFrom` never consults `onERC721Received`, which is how an NFT can
      // land here without going through a stake path.
      ledger.record(
        "A37",
        "dave pushes P8 into the vault",
        await chain.send(npm.connect(w.dave).transferFrom(w.dave.address, vaultAddr, positions.P8))
      );
      expect(await npm.ownerOf(positions.P8)).to.equal(vaultAddr);
      expect(await vault.stakerOf(positions.P8)).to.equal(C.ZERO_ADDRESS);

      const receipt = await chain.send(vault.connect(w.multisig).rescuePosition(positions.P8));
      ledger.record("A37", "multisig rescues P8", receipt, [
        { address: vaultAddr, name: "PositionRescued" },
      ]);

      const args = chain.parseEvent(receipt, vault.interface, vaultAddr, "PositionRescued");
      expect(args.tokenId).to.equal(positions.P8);
      expect(args.to).to.equal(w.multisig.address);
      expect(await npm.ownerOf(positions.P8)).to.equal(w.multisig.address);
    });

    it("A38: a stray NFT pushed into the zapper is rescued to the multisig", async function () {
      const minted = await mintFor("dave", "P9", 1200, C.ASSET(100), C.USDC(25));
      ledger.record("A38", "dave mints P9", minted.receipt);
      ledger.record(
        "A38",
        "dave pushes P9 into the zapper",
        await chain.send(npm.connect(w.dave).transferFrom(w.dave.address, zapperAddr, positions.P9))
      );
      expect(await npm.ownerOf(positions.P9)).to.equal(zapperAddr);

      const receipt = await chain.send(zapper.connect(w.multisig).rescuePosition(positions.P9));
      ledger.record("A38", "multisig rescues P9", receipt, [
        { address: zapperAddr, name: "PositionRescued" },
      ]);

      const args = chain.parseEvent(receipt, zapper.interface, zapperAddr, "PositionRescued");
      expect(args.tokenId).to.equal(positions.P9);
      expect(args.to).to.equal(w.multisig.address);
      expect(await npm.ownerOf(positions.P9)).to.equal(w.multisig.address);
    });

    it("A39: stray tUSDC on the zapper is swept to the multisig", async function () {
      const amount = C.USDC(5);
      ledger.record(
        "A39",
        "stray tUSDC lands on the zapper",
        await chain.send(usdc.connect(w.deployer).transfer(zapperAddr, amount)),
        [{ address: usdcAddr, name: "Transfer" }]
      );
      expect(await usdc.balanceOf(zapperAddr)).to.equal(amount);

      const balanceBefore = await usdc.balanceOf(w.multisig.address);
      const receipt = await chain.send(
        zapper.connect(w.multisig).sweep(usdcAddr, amount, w.multisig.address)
      );
      ledger.record("A39", "multisig sweeps the zapper", receipt, [
        { address: usdcAddr, name: "Transfer" },
        { address: zapperAddr, name: "Swept" },
      ]);

      const args = chain.parseEvent(receipt, zapper.interface, zapperAddr, "Swept");
      expect(args.token).to.equal(usdcAddr);
      expect(args.to).to.equal(w.multisig.address);
      expect(args.amount).to.equal(amount);
      expect((await usdc.balanceOf(w.multisig.address)) - balanceBefore).to.equal(amount);
      expect(await usdc.balanceOf(zapperAddr)).to.equal(0n);
    });

    it("A40: a staked position is undone by a snapshot revert", async function () {
      reorg.snapshotId = await rpc.snapshot(provider);
      reorg.headBeforeSnapshot = await head();

      const minted = await mintFor("carol", "P10", 1200, C.ASSET(4_000), C.USDC(1_000));
      await chain.send(npm.connect(w.carol).approve(vaultAddr, positions.P10));
      const staked = await chain.send(vault.connect(w.carol).stake(positions.P10));

      // Everything is real and visible before the revert.
      reorg.stakeTxHash = staked.hash;
      reorg.stakeBlockNumber = staked.blockNumber;
      reorg.stakeBlockHash = staked.blockHash;
      reorg.headAfterStake = await head();
      reorg.stakedBefore = await vault.stakerOf(positions.P10);
      reorg.logsBefore = await rpc.getLogs(provider, {
        address: vaultAddr,
        fromBlock: staked.blockNumber,
        toBlock: staked.blockNumber,
        topics: [
          ethers.id("Staked(address,uint256,int24,int24,uint128,uint256)"),
          chain.addressTopic(w.carol.address),
          chain.uintTopic(positions.P10),
        ],
      });

      await rpc.revertTo(provider, reorg.snapshotId);
      reorg.headAfterRevert = await head();

      reorg.remineHeight = await rpc.mine(provider, 1);
      reorg.remineBlock = await rpc.getBlockByNumber(provider, reorg.remineHeight);
      reorg.orphanedBlock = await rpc.getBlockByNumber(provider, reorg.stakeBlockNumber);
      reorg.receiptAfterRevert = await rpc.getTransactionReceipt(provider, reorg.stakeTxHash);
      reorg.stakedAfter = await vault.stakerOf(positions.P10);
      reorg.logsAfter = await rpc.getLogs(provider, {
        address: vaultAddr,
        fromBlock: reorg.headBeforeSnapshot,
        toBlock: reorg.remineHeight,
        topics: [ethers.id("Staked(address,uint256,int24,int24,uint128,uint256)")],
      });

      ledger.recordBlock("A40", "re-mine after the snapshot revert", reorg.remineHeight);
      expect(reorg.headAfterRevert).to.equal(reorg.headBeforeSnapshot);
    });

    it("A41: the multisig cycles the zapper wiring off and back on", async function () {
      const off = await chain.send(vault.connect(w.multisig).setZapper(C.ZERO_ADDRESS));
      ledger.record("A41", "multisig disables the zapper", off, [
        { address: vaultAddr, name: "ZapperSet" },
      ]);
      let args = chain.parseEvent(off, vault.interface, vaultAddr, "ZapperSet");
      expect(args.previousZapper).to.equal(zapperAddr);
      expect(args.newZapper).to.equal(C.ZERO_ADDRESS);
      expect(await vault.zapper()).to.equal(C.ZERO_ADDRESS);

      const on = await chain.send(vault.connect(w.multisig).setZapper(zapperAddr));
      ledger.record("A41", "multisig re-enables the zapper", on, [
        { address: vaultAddr, name: "ZapperSet" },
      ]);
      args = chain.parseEvent(on, vault.interface, vaultAddr, "ZapperSet");
      expect(args.previousZapper).to.equal(C.ZERO_ADDRESS);
      expect(args.newZapper).to.equal(zapperAddr);
      expect(await vault.zapper()).to.equal(zapperAddr);
    });

    it("A42: the multisig cycles the minter off the distributor and back", async function () {
      const away = await chain.send(tokenX.connect(w.multisig).setMinter(w.signer2.address));
      ledger.record("A42", "multisig repoints the minter", away, [
        { address: tokenXAddr, name: "MinterChanged" },
      ]);
      let args = chain.parseEvent(away, tokenX.interface, tokenXAddr, "MinterChanged");
      expect(args.previousMinter).to.equal(distributorAddr);
      expect(args.newMinter).to.equal(w.signer2.address);

      const back = await chain.send(tokenX.connect(w.multisig).setMinter(distributorAddr));
      ledger.record("A42", "multisig restores the minter", back, [
        { address: tokenXAddr, name: "MinterChanged" },
      ]);
      args = chain.parseEvent(back, tokenX.interface, tokenXAddr, "MinterChanged");
      expect(args.previousMinter).to.equal(w.signer2.address);
      expect(args.newMinter).to.equal(distributorAddr);
      expect(await tokenX.minter()).to.equal(distributorAddr);
    });

    it("A43: the multisig pauses rebalance", async function () {
      const receipt = await chain.send(vault.connect(w.multisig).setRebalancePaused(true));
      ledger.record("A43", "multisig pauses rebalance", receipt, [
        { address: vaultAddr, name: "RebalancePausedSet" },
      ]);
      expect(
        chain.parseEvent(receipt, vault.interface, vaultAddr, "RebalancePausedSet").rebalancePaused
      ).to.equal(true);
      expect(await vault.rebalancePaused()).to.equal(true);
      // the other switch is untouched, and so is the exit
      expect(await vault.depositsPaused()).to.equal(false);
    });

    it("A44: alice's rebalance reverts with RebalanceIsPaused and mines nothing", async function () {
      const c = await centre();
      const { headBefore } = await chain.expectCustomError(
        provider,
        vault
          .connect(w.alice)
          .rebalance(positions.P5, c - 600, c + 600, swapLeg(0n), C.FAR_DEADLINE),
        vault.interface,
        "RebalanceIsPaused"
      );
      ledger.recordRevert("A44", "alice's rebalance is refused", headBefore, "RebalanceIsPaused");

      // the position is exactly where it was: same id, same staker, same custody
      expect(await vault.stakerOf(positions.P5)).to.equal(w.alice.address);
      expect(await npm.ownerOf(positions.P5)).to.equal(vaultAddr);
    });

    it("A45: the multisig resumes rebalance", async function () {
      const receipt = await chain.send(vault.connect(w.multisig).setRebalancePaused(false));
      ledger.record("A45", "multisig resumes rebalance", receipt, [
        { address: vaultAddr, name: "RebalancePausedSet" },
      ]);
      expect(
        chain.parseEvent(receipt, vault.interface, vaultAddr, "RebalancePausedSet").rebalancePaused
      ).to.equal(false);
      expect(await vault.rebalancePaused()).to.equal(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  describe("3. block progression", function () {
    it("mined every ledger entry into its own block, strictly after the pinned one", async function () {
      let previous = C.PINNED_BLOCK;
      for (const entry of ledger.entries) {
        if (entry.kind === "revert") {
          expect(entry.blockNumber, `${entry.step} reverted after the head moved`).to.be.at.least(
            previous
          );
          continue;
        }
        expect(entry.blockNumber, `${entry.step} (${entry.label}) is not after ${previous}`).to.be.greaterThan(
          previous
        );
        previous = entry.blockNumber;
      }
      expect(previous).to.be.greaterThan(C.PINNED_BLOCK);
    });

    it("put exactly one transaction — ours — in each recorded block", async function () {
      for (const entry of ledger.transactions) {
        // The A40 blocks were orphaned by the revert; they are asserted in section 5.
        if (entry.step === "A40") continue;
        const block = await rpc.getBlockByNumber(provider, entry.blockNumber);
        expect(block.transactions.length, `block ${entry.blockNumber} (${entry.label})`).to.equal(1);
        expect(block.transactions[0]).to.equal(entry.txHash);
      }
    });

    it("mined nothing for any of the three reverted calls", async function () {
      const reverts = ledger.reverts;
      expect(reverts.map((r) => r.step)).to.deep.equal(["A16", "A33", "A44"]);
      expect(reverts.map((r) => r.errorName)).to.deep.equal([
        "DepositsArePaused",
        "ClaimsPaused",
        "RebalanceIsPaused",
      ]);
    });

    it("chains every block from the head back to the pinned block", async function () {
      const latest = await head();
      let block = await rpc.getBlockByNumber(provider, latest);
      for (let number = latest; number > C.PINNED_BLOCK; number--) {
        const parent = await rpc.getBlockByNumber(provider, number - 1);
        expect(block.parentHash, `block ${number} does not chain onto ${number - 1}`).to.equal(
          parent.hash
        );
        expect(Number(parent.number)).to.equal(number - 1);
        block = parent;
      }
      expect(block.hash).to.equal(
        (await rpc.getBlockByNumber(provider, C.PINNED_BLOCK)).hash
      );
    });

    it("advanced the clock monotonically, with the gaps the scenario asked for", async function () {
      const timestamps = [];
      for (const entry of ledger.entries) {
        if (entry.kind === "revert" || entry.step === "A40") continue;
        const block = await rpc.getBlockByNumber(provider, entry.blockNumber);
        timestamps.push({ step: entry.step, ts: Number(block.timestamp) });
      }
      for (let i = 1; i < timestamps.length; i++) {
        expect(
          timestamps[i].ts,
          `${timestamps[i].step} is not after ${timestamps[i - 1].step}`
        ).to.be.greaterThan(timestamps[i - 1].ts);
      }

      // The warm-up round trips are at least 60 s apart, which is what fills the oracle.
      const warmup = timestamps.filter((t) => t.step === "S8").map((t) => t.ts);
      expect(warmup.length).to.equal(C.WARMUP_ROUNDS * 2);
      for (let i = 1; i < warmup.length; i++) {
        expect(warmup[i] - warmup[i - 1]).to.be.at.least(C.WARMUP_STEP_SECONDS);
      }

      // A27 crossed the epoch boundary, so it is at least the rollover delay after A25.
      const a25 = timestamps.find((t) => t.step === "A25").ts;
      const a27 = timestamps.find((t) => t.step === "A27").ts;
      expect(a27 - a25).to.be.at.least(C.EPOCH_ROLLOVER_OVERSHOOT);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  describe("4. log storage and retrieval", function () {
    /** Every log this run's contracts emitted, from the first mock deploy to the head. */
    async function logsFrom(address, extra = {}) {
      return rpc.getLogs(provider, {
        address,
        fromBlock: ledger.firstBlock,
        toBlock: await head(),
        ...extra,
      });
    }

    it("returns each contract's whole event sequence in ledger order", async function () {
      const ifaces = ifacesByAddress();
      for (const address of [vaultAddr, zapperAddr, tokenXAddr, distributorAddr]) {
        const decoded = chain.decodeLogs(await logsFrom(address), ifaces);
        const scenarioNames = decoded
          .filter((d) => d.blockNumber > deployToBlock)
          .map((d) => d.name);
        const expected = ledger
          .expectedFrom(address)
          .filter((e) => e.blockNumber > deployToBlock)
          .map((e) => e.name);
        expect(scenarioNames, `scenario log sequence from ${address}`).to.deep.equal(expected);
        expect(decoded.every((d) => d.name !== null), `undecodable log from ${address}`).to.equal(
          true
        );
      }
    });

    it("includes the deploy run's own events in the same query", async function () {
      const ifaces = ifacesByAddress();
      const decoded = chain.decodeLogs(await logsFrom(vaultAddr), ifaces);
      const deployTime = decoded.filter((d) => d.blockNumber <= deployToBlock).map((d) => d.name);
      expect(deployTime).to.deep.equal([
        "OwnershipTransferred",
        "TwapParamsSet",
        "ZapperSet",
        "OwnershipTransferred",
      ]);
    });

    it("filters Staked by the indexed staker", async function () {
      const topic = ethers.id("Staked(address,uint256,int24,int24,uint128,uint256)");
      const ifaces = ifacesByAddress();

      const alice = chain.decodeLogs(
        await logsFrom(vaultAddr, { topics: [topic, chain.addressTopic(w.alice.address)] }),
        ifaces
      );
      expect(alice.map((l) => l.args.tokenId)).to.deep.equal([positions.P1, positions.P5]);

      // Carol staked P3 through the zapper and P7 directly. P10 was reverted away.
      const carol = chain.decodeLogs(
        await logsFrom(vaultAddr, { topics: [topic, chain.addressTopic(w.carol.address)] }),
        ifaces
      );
      expect(carol.map((l) => l.args.tokenId)).to.deep.equal([positions.P3, positions.P7]);
    });

    it("filters Staked by the indexed tokenId", async function () {
      const topic = ethers.id("Staked(address,uint256,int24,int24,uint128,uint256)");
      const logs = await logsFrom(vaultAddr, {
        topics: [topic, null, chain.uintTopic(positions.P7)],
      });
      expect(logs.length).to.equal(1);
      const decoded = chain.decodeLogs(logs, ifacesByAddress())[0];
      expect(decoded.args.user).to.equal(w.carol.address);
      expect(decoded.args.tokenId).to.equal(positions.P7);
    });

    it("filters Claimed by the indexed user and by the indexed token", async function () {
      const topic = ethers.id("Claimed(address,address,uint256,uint256,uint256)");
      const ifaces = ifacesByAddress();

      const carol = chain.decodeLogs(
        await logsFrom(distributorAddr, { topics: [topic, chain.addressTopic(w.carol.address)] }),
        ifaces
      );
      expect(carol.length).to.equal(2);
      expect(carol.map((l) => l.args.paidAmount)).to.deep.equal([C.TOKENS(1_000), C.TOKENS(750)]);

      const assetLeg = chain.decodeLogs(
        await logsFrom(distributorAddr, { topics: [topic, null, chain.addressTopic(assetAddr)] }),
        ifaces
      );
      expect(assetLeg.length).to.equal(1);
      expect(assetLeg[0].args.user).to.equal(w.bob.address);
      expect(assetLeg[0].args.paidAmount).to.equal(C.ASSET(3_000));
    });

    it("filters Rebalanced by the indexed old tokenId", async function () {
      const topic = ethers.id(
        "Rebalanced(address,uint256,uint256,int24,int24,uint128,uint256,uint256,uint256)"
      );
      const logs = await logsFrom(vaultAddr, {
        topics: [topic, null, chain.uintTopic(positions.P1)],
      });
      expect(logs.length).to.equal(1);
      const decoded = chain.decodeLogs(logs, ifacesByAddress())[0];
      expect(decoded.args.newTokenId).to.equal(positions.P5);
      expect(decoded.args.user).to.equal(w.alice.address);
    });

    it("filters PositionRescued by the indexed tokenId, per contract", async function () {
      const topic = ethers.id("PositionRescued(uint256,address,uint256)");
      const fromVault = await logsFrom(vaultAddr, {
        topics: [topic, chain.uintTopic(positions.P8)],
      });
      const fromZapper = await logsFrom(zapperAddr, {
        topics: [topic, chain.uintTopic(positions.P8)],
      });
      expect(fromVault.length).to.equal(1);
      expect(fromZapper.length).to.equal(0);
      expect(
        (await logsFrom(zapperAddr, { topics: [topic, chain.uintTopic(positions.P9)] })).length
      ).to.equal(1);
    });

    it("returns the same logs in seven-block chunks as in one range", async function () {
      const from = ledger.firstBlock;
      const to = await head();
      const addresses = [vaultAddr, zapperAddr, tokenXAddr, distributorAddr];

      const whole = await rpc.getLogs(provider, { address: addresses, fromBlock: from, toBlock: to });

      const chunked = [];
      for (let start = from; start <= to; start += 7) {
        const end = Math.min(start + 6, to);
        chunked.push(
          ...(await rpc.getLogs(provider, { address: addresses, fromBlock: start, toBlock: end }))
        );
      }

      const key = (log) => `${log.blockNumber}:${log.transactionHash}:${log.logIndex}`;
      expect(chunked.length).to.equal(whole.length);
      expect(chunked.map(key)).to.deep.equal(whole.map(key));
      expect(new Set(chunked.map(key)).size).to.equal(chunked.length);
    });

    it("matches receipt logs against eth_getLogs for the same block", async function () {
      for (const entry of ledger.transactions) {
        if (entry.step === "A40" || entry.logCount === 0) continue;
        const receipt = await rpc.getTransactionReceipt(provider, entry.txHash);
        const byBlock = await rpc.getLogs(provider, {
          fromBlock: entry.blockNumber,
          toBlock: entry.blockNumber,
        });
        expect(byBlock.length, `block ${entry.blockNumber} (${entry.label})`).to.equal(
          receipt.logs.length
        );
        expect(byBlock.map((l) => l.logIndex)).to.deep.equal(receipt.logs.map((l) => l.logIndex));
        expect(byBlock.every((l) => l.transactionHash === entry.txHash)).to.equal(true);
      }
    });

    it("returns the same logs by blockHash as by block number", async function () {
      const sample = ledger.transactions.filter((e) => e.step !== "A40" && e.logCount > 0).slice(-8);
      expect(sample.length).to.be.greaterThan(0);
      for (const entry of sample) {
        const byNumber = await rpc.getLogs(provider, {
          fromBlock: entry.blockNumber,
          toBlock: entry.blockNumber,
        });
        const byHash = await rpc.getLogs(provider, { blockHash: entry.blockHash });
        expect(byHash.map((l) => l.logIndex)).to.deep.equal(byNumber.map((l) => l.logIndex));
        expect(byHash.every((l) => l.blockHash === entry.blockHash)).to.equal(true);
      }
    });

    it("returns the pool's own Swap/Mint/Burn stream alongside the stack's", async function () {
      const decoded = chain.decodeLogs(await logsFrom(poolAddr), ifacesByAddress());
      const counts = decoded.reduce((acc, log) => {
        acc[log.name] = (acc[log.name] || 0) + 1;
        return acc;
      }, {});
      expect(counts.Initialize).to.equal(1);
      expect(counts.IncreaseObservationCardinalityNext).to.equal(1);
      // 16 warm-up swaps + 6 fee swaps + one swap leg each in A7, A8 and A10.
      expect(counts.Swap).to.equal(C.WARMUP_ROUNDS * 2 + C.FEE_ROUNDS * 2 + 3);
      expect(counts.Mint).to.be.greaterThan(0);
      expect(counts.Burn).to.be.greaterThan(0);
      expect(decoded.every((d) => d.name !== null)).to.equal(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  describe("5. the snapshot revert really removed the block", function () {
    it("had the staked position and its log before the revert", async function () {
      expect(reorg.stakedBefore).to.equal(w.carol.address);
      expect(reorg.logsBefore.length).to.equal(1);
      expect(reorg.logsBefore[0].transactionHash).to.equal(reorg.stakeTxHash);
      expect(reorg.headAfterStake).to.equal(reorg.headBeforeSnapshot + 3);
    });

    it("rolled the head back to the snapshot height", async function () {
      expect(reorg.headAfterRevert).to.equal(reorg.headBeforeSnapshot);
    });

    it("dropped the transaction, its receipt and its log", async function () {
      expect(reorg.receiptAfterRevert).to.equal(null);
      expect(reorg.logsAfter.length).to.equal(0);
      expect(reorg.stakedAfter).to.equal(C.ZERO_ADDRESS);
      expect(await vault.stakerOf(positions.P10)).to.equal(C.ZERO_ADDRESS);
      // The NFT itself is gone with the block that minted it.
      await chain.expectReverted(npm.ownerOf(positions.P10), `ownerOf(P10) after the revert`);
    });

    it("re-mined the same height with a different, empty block", async function () {
      expect(reorg.remineHeight).to.equal(reorg.stakeBlockNumber - 2);
      expect(Number(reorg.remineBlock.number)).to.equal(reorg.remineHeight);
      expect(reorg.remineBlock.transactions.length).to.equal(0);
    });

    it("no longer serves the orphaned block at its old height", async function () {
      // The orphaned block sat above the snapshot, so the height itself is gone for now.
      expect(reorg.orphanedBlock).to.equal(null);
      expect(reorg.stakeBlockHash).to.not.equal(reorg.remineBlock.hash);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  describe("6. the fail-closed rule", function () {
    it("skips only when nothing was configured", function () {
      const decision = forkNode.decideOnForkFailure(["https://a: boom"], {});
      expect(decision.action).to.equal("skip");
      expect(decision.message).to.include("[local-fork]");
      expect(decision.message).to.include("skipping");
      expect(decision.message).to.include(String(C.PINNED_BLOCK));
      expect(decision.message).to.include("https://a: boom");
    });

    it("fails, never skips, once MAINNET_RPC_URL is set", function () {
      const decision = forkNode.decideOnForkFailure(["https://a: boom"], {
        MAINNET_RPC_URL: "https://configured",
      });
      expect(decision.action).to.equal("throw");
      expect(decision.message).to.include("must run");
      expect(decision.message).to.not.include("skipping");
    });

    it("fails, never skips, once INFURA_API_KEY is set", function () {
      const decision = forkNode.decideOnForkFailure([], { INFURA_API_KEY: "key" });
      expect(decision.action).to.equal("throw");
    });

    it("resolves an explicitly configured endpoint alone, and the public list otherwise", function () {
      expect(forkNode.resolveRpcCandidates({ MAINNET_RPC_URL: "https://x" })).to.deep.equal([
        "https://x",
      ]);
      expect(forkNode.resolveRpcCandidates({ INFURA_API_KEY: "k" })).to.deep.equal([
        "https://mainnet.infura.io/v3/k",
      ]);
      expect(forkNode.resolveRpcCandidates({})).to.deep.equal([
        forkNode.PUBLIC_FALLBACK_RPC,
        ...forkNode.EXTRA_PUBLIC_ARCHIVE_RPCS,
      ]);
    });
  });

  // ── shared decoding map ────────────────────────────────────────────────

  function ifacesByAddress() {
    return {
      [vaultAddr.toLowerCase()]: vault.interface,
      [zapperAddr.toLowerCase()]: zapper.interface,
      [tokenXAddr.toLowerCase()]: tokenX.interface,
      [distributorAddr.toLowerCase()]: distributor.interface,
      [poolAddr.toLowerCase()]: pool.interface,
      [assetAddr.toLowerCase()]: asset.interface,
      [usdcAddr.toLowerCase()]: usdc.interface,
      [C.NPM_ADDR.toLowerCase()]: npm.interface,
      [C.FACTORY_ADDR.toLowerCase()]: factory.interface,
    };
  }
});

/**
 * Reads a block straight from the upstream endpoint, bypassing the fork, so the local
 * block can be compared against the source of truth. Retried, because the fork itself may
 * have been served entirely from the on-disk RPC cache and a public endpoint can throttle
 * a cold request.
 */
async function fetchUpstreamBlock(url, blockNumber, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getBlockByNumber",
          params: ["0x" + blockNumber.toString(16), false],
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const body = await response.json();
      if (body.error) throw new Error(`${body.error.code}: ${body.error.message}`);
      if (!body.result) throw new Error("upstream returned no block");
      return body.result;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  throw new Error(
    `could not read block ${blockNumber} from ${url}: ${lastError.message}`
  );
}
