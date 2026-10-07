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
 * The stack is the five-proxy one: `TokenOverture`, `RewardsDistributor` (multi-token,
 * pre-funded, `claim(token, …)`), `LPEpochRegistry` (the operator's emission schedule),
 * `LPStakingVault` and `LPZapper`, all born owned by the `LPTimelock`. The operator scripts
 * `lp-fund-rewards.js`, `lp-epoch.js` and `add-reward-token.js` are run as children too,
 * and the timelock replacement (`lp-switch-timelock.js`) closes the file in section 7.
 *
 * ── Scenario (mirrored by the indexer repo's e2e suite) ───────────────────────────────
 *
 *   S1/S2  deploy MockERC20Permit tASSET (18) and tUSDC (6)
 *   S3     fund alice/bob/carol/dave with 100k tASSET + 50k tUSDC
 *   S4     MaxUint256 approvals to the position manager and the router
 *   S5     create + initialize the pool at 0.50 tUSDC per tASSET   [pool script]
 *   S6     deployer seeds a wide position, 1e24 tASSET / 5e11 tUSDC
 *   S7     deploy the whole stack, five proxies born owned by the timelock [deploy script]
 *   S8     warm the oracle: 8 round trips, 60 s apart
 *   S9     fund the distributor: 10000 tASSET + 2,000,000 $OVTR   [lp-fund-rewards.js]
 *   S10    the operator schedules epoch 1 on the registry          [lp-epoch.js]
 *
 *   A1  alice mints P1                 A22 carol claims 1750 $OVTR (pays 750)
 *   A2  alice approves the vault       A23 operator schedules epoch 2
 *   A3  alice stakes P1                A24 operator cancels it
 *   A4  bob mints P2                   A25 operator schedules epoch 3, adjusts it
 *   A5  bob stakes P2 by NFT permit    A26 clock jumps into epoch 1
 *   A6  carol approves the zapper      A27 dave claims 2000 $OVTR inside epoch 1
 *   A7  carol zaps in -> P3            A28 $ASSET claims closed, opened via timelock
 *   A8  dave zaps in by permit -> P4   A29 a third reward token joins via timelock
 *   A9  trading generates real fees    A30 bob claims 3000 tASSET
 *   A10 alice rebalances P1 -> P5      A31 operator recovers 1000 tASSET
 *   A11 bob rebalances P2 -> P6        A32 guardian pauses claims
 *   A12 alice unstakes P5              A33 bob's claim reverts ClaimsPaused
 *   A13 alice re-approves P5           A34 guardian unpauses
 *   A14 alice re-stakes P5             A35 operator rotates the signer
 *   A15 guardian pauses deposits       A36 operator rotates it back
 *   A16 carol's stake reverts          A37 stray NFT rescued from the vault
 *   A17 guardian resumes deposits      A38 stray NFT rescued from the zapper
 *   A18 carol stakes P7                A39 stray tUSDC swept from the zapper
 *   A19 operator retunes the vault     A40 snapshot, stake P10, revert, re-mine
 *   A20 operator retunes the zapper    A41 zapper wiring cycled via the timelock
 *   A21 carol claims 1000 $OVTR        A42 Overture minter cycled via the timelock
 *                                      A43 guardian pauses rebalance
 *                                      A44 alice's rebalance reverts
 *                                      A45 guardian resumes rebalance
 *                                      A46 upgrade to V2 scheduled
 *                                      A47 premature execute reverts
 *                                      A48 upgrade executes; state survives
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
const lpTimelock = require("../../../scripts/lp-timelock");
const { Ledger } = require("../helpers/ledger");
const redact = require("../helpers/redact");

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

  let assetAddr, usdcAddr, poolAddr, vaultAddr, zapperAddr, overtureAddr, distributorAddr;
  let registryAddr, timelockAddr, vaultV2ImplAddr, thirdTokenAddr;
  let asset, usdc, pool, npm, npmRead, router, factory;
  let vault, zapper, overture, distributor, registry, timelock, thirdToken;
  /** The scheduled vault upgrade, built in A46 and re-used by A47 and A48. */
  let upgradeOperation = null;
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
  const epochs = {}; // the schedule S10/A23/A25 write and A24/A26 read
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

  /** The back office's `RewardClaim` voucher for `role`, in `token`. */
  const voucher = (token, role, cumulativeAmount) =>
    signing.signRewardClaim({
      signer: w.backOffice,
      domain: voucherDomain,
      token,
      user: w[role].address,
      cumulativeAmount,
    });

  /** The next 900-second grid point at or after `seconds`. */
  const onGrid = (seconds) =>
    BigInt(Math.ceil(Number(seconds) / C.REGISTRY_INTERVAL) * C.REGISTRY_INTERVAL);

  /**
   * Every `to` / `data` pair a script printed for a Safe to send. The operator scripts send
   * only when the key they run with holds the role the call needs; in these suites they run
   * with the DEPLOYER's key, so they print the payload instead — exactly what the operator
   * multisig gets on mainnet. The suite then sends each payload from the role's own key.
   */
  function safePayloads(stdout) {
    const out = [];
    const pattern = /to:\s+(0x[0-9a-fA-F]{40})[\s\S]*?data:\s+(0x[0-9a-fA-F]*)/g;
    let match;
    while ((match = pattern.exec(stdout)) !== null) out.push({ to: match[1], data: match[2] });
    return out;
  }

  /** The transaction hashes a script reported as sent (`pools.send` prints `done: <hash>`). */
  function sentHashes(stdout) {
    return [...stdout.matchAll(/done: (0x[0-9a-f]{64})/g)].map((m) => m[1]);
  }

  /** Runs an operator script as a child and fails loudly on a non-zero exit. */
  async function runScript(script, env) {
    const run = await runner.runHardhatScript(script, env, {
      logFile: path.join(scratchDir, "scripts.log"),
    });
    if (run.code !== 0) throw new Error(`${script} exited ${run.code}\n${run.stdout}\n${run.stderr}`);
    return run;
  }

  /**
   * Runs one owner-tier call the only way it can be run once the timelock owns the proxy:
   * schedule it, let `minDelay` elapse, execute it.
   *
   * Two transactions in two blocks, both recorded, so the block-progression and log-retrieval
   * sections see the timelock's own `CallScheduled`/`CallExecuted` pair alongside the target's
   * event. `execute` emits the target's events FIRST and `CallExecuted` last (OZ v5 calls
   * `_execute` before it emits), which is the order `expected` states.
   *
   * The salt comes from scripts/lp-timelock.js, so the suite and the operator script derive
   * the same operation id from the same call — an execute that named different arguments than
   * its schedule would be a different operation, not a typo that goes through.
   */
  async function throughTimelock(step, label, { target, fn, args = [], tag = "", expected = [] }) {
    const op = lpTimelock.buildOperation({ target, fn, args, tag });

    const scheduled = await chain.send(
      timelock
        .connect(w.multisig)
        .schedule(op.target, op.value, op.data, op.predecessor, op.salt, C.TIMELOCK_MIN_DELAY)
    );
    ledger.record(step, `${label} (schedule)`, scheduled, [
      { address: timelockAddr, name: "CallScheduled" },
      // OZ v5 emits `CallSalt(id, salt)` alongside `CallScheduled` whenever the salt is not
      // zero, and every salt this repo derives is non-zero. Two logs per schedule, one per
      // execute — an indexer that registers only `CallScheduled` sees half the story.
      { address: timelockAddr, name: "CallSalt" },
    ]);
    expect(await timelock.isOperationPending(op.id), `${label} is not pending`).to.equal(true);
    expect(await timelock.isOperationReady(op.id), `${label} is ready too early`).to.equal(false);

    await rpc.increaseTime(provider, C.TIMELOCK_MIN_DELAY + 1);

    const executed = await chain.send(
      timelock.connect(w.multisig).execute(op.target, op.value, op.data, op.predecessor, op.salt)
    );
    ledger.record(step, `${label} (execute)`, executed, [
      ...expected,
      { address: timelockAddr, name: "CallExecuted" },
    ]);
    expect(await timelock.isOperationDone(op.id), `${label} is not done`).to.equal(true);

    return { op, scheduled, executed };
  }

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
    // The node's log opens with its `--fork <url>` line; mask the endpoint's key in place.
    redact.scrubDirectory(scratchDir);

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

    // S7 — deploy the whole stack and grow the oracle, by the repo's own script. All five
    //      proxies come out of it owned by the timelock already: `initialize` names the
    //      timelock inside each proxy's own deployment transaction, the Overture token is born
    //      with the distributor PROXY as its minter (its address predicted from the deployer's
    //      nonce), the distributor with $ASSET recorded and both launch reward tokens,
    //      and the vault pointing at the zapper PROXY whose address the script predicted from
    //      the deployer's nonce. Nothing is left to wire or to hand over.
    deployFromBlock = (await head()) + 1;
    deployRun = await runner.runHardhatScript("scripts/deploy-lp-staking.js", deployScriptEnv(), {
      logFile: path.join(scratchDir, "scripts.log"),
    });
    if (deployRun.code !== 0) {
      throw new Error(
        `scripts/deploy-lp-staking.js exited ${deployRun.code}\n${deployRun.stdout}\n${deployRun.stderr}`
      );
    }
    const entries = runner.readRegistry(registryFile)["31337"];
    overtureAddr = entries.TokenOverture.address;
    distributorAddr = entries.RewardsDistributor.address;
    registryAddr = entries.LPEpochRegistry.address;
    vaultAddr = entries.LPStakingVault.address;
    zapperAddr = entries.LPZapper.address;
    timelockAddr = entries.TimelockController.address;

    vault = await contractAt("LPStakingVault", vaultAddr);
    zapper = await contractAt("LPZapper", zapperAddr);
    overture = await contractAt("TokenOverture", overtureAddr);
    distributor = await contractAt("RewardsDistributor", distributorAddr);
    registry = await contractAt("LPEpochRegistry", registryAddr);
    timelock = await contractAt("LPTimelock", timelockAddr);

    // Nothing follows the script inside the deploy window: every proxy was born owned by the
    // timelock, so there is no `acceptOwnership` left for anyone to send.
    for (const [label, contract] of [
      ["TokenOverture", overture],
      ["RewardsDistributor", distributor],
      ["LPEpochRegistry", registry],
      ["LPStakingVault", vault],
      ["LPZapper", zapper],
    ]) {
      if ((await contract.owner()) !== timelockAddr) {
        throw new Error(`${label} was not born owned by the timelock`);
      }
    }

    deployToBlock = await head();

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

    // S9 — the operator funds the distributor, through scripts/lp-fund-rewards.js. Claims pay
    //      out of the distributor's own balance by transfer; nothing is minted at claim time.
    //      The script runs with the deployer's key: the deployer holds the tASSET here (the
    //      treasury), so the script sends that leg itself; it is NOT the distributor's
    //      operator, so it prints `RewardsDistributor.mintRewardToken(ovtr, distributor,
    //      amount)` for the operator's Safe (the distributor proxy is the Overture minter), and
    //      the operator sends it.
    const fundRun = await runScript("scripts/lp-fund-rewards.js", {
      ...baseScriptEnv(),
      LP_ASSET: assetAddr,
      LP_FUND_OVTR_AMOUNT: ethers.formatUnits(C.FUND_OVTR, 18),
      LP_FUND_ASSET_AMOUNT: ethers.formatUnits(C.FUND_ASSET, 18),
    });
    const [assetFundingHash] = sentHashes(fundRun.stdout);
    ledger.record("S9", "the treasury transfers tASSET into the distributor", await provider.getTransactionReceipt(assetFundingHash), [
      { address: assetAddr, name: "Transfer" },
    ]);
    expect(fundRun.stdout).to.include("path: RewardsDistributor.mintRewardToken");
    const [mintPayload] = safePayloads(fundRun.stdout);
    expect(mintPayload.to).to.equal(distributorAddr);
    expect(mintPayload.data).to.equal(
      distributor.interface.encodeFunctionData("mintRewardToken", [overtureAddr, distributorAddr, C.FUND_OVTR])
    );
    ledger.record(
      "S9",
      "the operator mints $OVTR into the distributor through mintRewardToken",
      await chain.send(w.operator.sendTransaction({ to: mintPayload.to, data: mintPayload.data })),
      [
        { address: overtureAddr, name: "Transfer" },
        { address: distributorAddr, name: "RewardTokenMinted" },
      ]
    );
    expect(await overture.balanceOf(distributorAddr)).to.equal(C.FUND_OVTR);
    expect(await asset.balanceOf(distributorAddr)).to.equal(C.FUND_ASSET);

    // S10 — the operator schedules epoch 1 through scripts/lp-epoch.js: 7 days, on the
    //       900-second grid, starting at least 30 minutes after the chain's clock. The script
    //       validates all of it against chain time and prints the Safe payload; the operator
    //       sends it.
    epochs.oneStartsAt = onGrid((await latestTimestamp()) + C.REGISTRY_SCHEDULE_MARGIN + C.REGISTRY_INTERVAL);
    epochs.oneEndsAt = epochs.oneStartsAt + BigInt(C.EPOCH_LENGTH);
    const epochRun = await runScript("scripts/lp-epoch.js", {
      ...baseScriptEnv(),
      LP_ASSET: assetAddr,
      EPOCH_ACTION: "schedule",
      EPOCH_ID: "1",
      EPOCH_STARTS_AT: String(epochs.oneStartsAt),
      EPOCH_ENDS_AT: String(epochs.oneEndsAt),
      EPOCH_AMOUNTS: `${C.OVERTURE_SYMBOL}=${ethers.formatUnits(C.EPOCH_ONE_OVTR, 18)},ASSET=${ethers.formatUnits(C.EPOCH_ONE_ASSET, 18)}`,
    });
    const [schedulePayload] = safePayloads(epochRun.stdout);
    expect(schedulePayload.to).to.equal(registryAddr);
    ledger.record(
      "S10",
      "the operator schedules epoch 1",
      await chain.send(w.operator.sendTransaction({ to: schedulePayload.to, data: schedulePayload.data })),
      [
        { address: registryAddr, name: "EpochScheduled" },
        { address: registryAddr, name: "EpochAmountSet" },
        { address: registryAddr, name: "EpochAmountSet" },
      ]
    );
    expect(await registry.epochCount()).to.equal(C.EPOCH_ONE);
    expect(await registry.epochAmount(C.EPOCH_ONE, overtureAddr)).to.equal(C.EPOCH_ONE_OVTR);
    expect(await registry.epochAmount(C.EPOCH_ONE, assetAddr)).to.equal(C.EPOCH_ONE_ASSET);

    notes.push(
      `rpc=${redact.redactRpc(rpcUsed)} port=${node.port} block=${C.PINNED_BLOCK} scratch=${scratchDir}`,
      `pinned fees: baseFee=${fees.baseFee} maxFee=${fees.maxFeePerGas} priority=${fees.maxPriorityFeePerGas}`,
      `tASSET=${assetAddr} tUSDC=${usdcAddr} assetIsToken0=${assetIsToken0} zeroForOne=${zeroForOne}`,
      `pool=${poolAddr} sqrtPriceX96=${initialSqrtPriceX96} tick=${await uni.currentTick(pool)}`,
      `vault=${vaultAddr} zapper=${zapperAddr} overture=${overtureAddr} distributor=${distributorAddr} registry=${registryAddr}`,
      `timelock=${timelockAddr} minDelay=${C.TIMELOCK_MIN_DELAY}s`,
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
    // Again once the node has stopped writing, whatever happened above — a failed fork included.
    if (scratchDir) redact.scrubDirectory(scratchDir);
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
      // The fork reports chain 31337, which scripts/lib/uniswap.js has no defaults for, so
      // the factory the canonical-pool check reads has to be named explicitly.
      LP_FACTORY: C.FACTORY_ADDR,
      LP_FEE: String(C.FEE),
      LP_SIGNER: w.backOffice.address,
      LP_MULTISIG: w.multisig.address,
      // helpers/scripts.js strips every LP_* key out of the child's environment, so every
      // role has to be supplied here like everything else. All three are DIFFERENT keys, the
      // shape the model assumes: the script throws when the guardian equals the operator and
      // warns when either collapses onto the multisig or onto the deploying key, so this run
      // is also the proof that the strict path deploys without a single warning.
      //
      // The guardian tier is the three pause switches and nothing else (A15/A17, A32/A34,
      // A43/A45 send from `w.guardian`).
      LP_GUARDIAN: w.guardian.address,
      // The operator tier is the vault's and the zapper's setTwapParams and rescuePosition, the
      // zapper's sweep, the distributor's setSigner and recoverExcess, the registry's epoch
      // schedule, and the distributor's `mintRewardToken` (S9/S10, A19/A20, A23-A25, A29, A31,
      // A35-A39 send from `w.operator`).
      LP_OPERATOR: w.operator.address,
      LP_TIMELOCK_MIN_DELAY: String(C.TIMELOCK_MIN_DELAY),
      LP_OVERTURE_NAME: C.OVERTURE_NAME,
      LP_OVERTURE_SYMBOL: C.OVERTURE_SYMBOL,
      // $ASSET claims closed at launch, as on mainnet: A28 opens them through the timelock.
      LP_ASSET_CLAIMS_ENABLED: "0",
      LP_TWAP_WINDOW: String(C.TWAP_WINDOW),
      LP_TWAP_MAX_DEVIATION_BPS: String(C.MAX_DEVIATION_BPS),
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

      const entries = runner.readRegistry(registryFile)["31337"];
      for (const kind of [
        "TokenOverture",
        "RewardsDistributor",
        "LPEpochRegistry",
        "LPStakingVault",
        "LPZapper",
        "TimelockController",
      ]) {
        const entry = entries[kind];
        const receipt = await provider.getTransactionReceipt(entry.deployTx);
        expect(receipt, `${kind} deploy tx ${entry.deployTx} is not on chain`).to.not.equal(null);
        expect(receipt.blockNumber).to.equal(entry.block);
        expect(receipt.contractAddress).to.equal(entry.address);
        expect(await provider.getCode(entry.address)).to.not.equal("0x");
        if (kind === "TimelockController") continue;
        // Every proxy also records the implementation it was born with.
        const implReceipt = await provider.getTransactionReceipt(entry.implementationTx);
        expect(implReceipt.contractAddress, `${kind} implementation`).to.equal(entry.implementation);
      }
    });

    it("five proxies born owned by the timelock, each delegating to its recorded implementation", async function () {
      const entries = runner.readRegistry(registryFile)["31337"];
      // All five are UUPS proxies owned by the timelock — the only address that can upgrade
      // them — and they were born that way: `initialize` named it inside each proxy's own
      // deployment transaction, so no key ever held the owner tier, not for one block.
      // `pendingOwner` is zero because nothing was ever nominated. The ERC-1967 implementation
      // slot names the implementation deployments.json records, and the ADMIN slot is empty
      // (UUPS: no ProxyAdmin, no second upgrade path).
      for (const [kind, contract, address] of [
        ["TokenOverture", overture, overtureAddr],
        ["RewardsDistributor", distributor, distributorAddr],
        ["LPEpochRegistry", registry, registryAddr],
        ["LPStakingVault", vault, vaultAddr],
        ["LPZapper", zapper, zapperAddr],
      ]) {
        expect(await contract.owner(), `${kind}.owner`).to.equal(timelockAddr);
        expect(await contract.pendingOwner(), `${kind}.pendingOwner`).to.equal(C.ZERO_ADDRESS);
        const implSlot = await provider.getStorage(address, C.ERC1967_IMPLEMENTATION_SLOT);
        expect(ethers.getAddress("0x" + implSlot.slice(-40)), `${kind} implementation slot`).to.equal(
          entries[kind].implementation
        );
        const adminSlot = await provider.getStorage(address, C.ERC1967_ADMIN_SLOT);
        expect(BigInt(adminSlot), `${kind} admin slot`).to.equal(0n);
      }

      // Beside the owner sit the two undelayed tiers, on two different keys: `guardian` (the
      // pause switches, nothing else) and `operator` (calibration, rescue, key rotation, the
      // schedule, the zapper's sweep, and those same pause switches).
      for (const [label, contract] of [
        ["distributor", distributor],
        ["vault", vault],
      ]) {
        expect(await contract.guardian(), `${label}.guardian`).to.equal(w.guardian.address);
        expect(await contract.operator(), `${label}.operator`).to.equal(w.operator.address);
      }
      expect(await registry.operator(), "registry.operator").to.equal(w.operator.address);
      expect(await zapper.operator(), "zapper.operator").to.equal(w.operator.address);
      // The Overture token's minter is the distributor PROXY, from birth: the script predicted
      // the proxy's address from the deployer's nonce, so no `setMinter` transaction exists in
      // this run. The operator mints through `mintRewardToken`; a claim still pays by transfer.
      expect(await overture.minter(), "overture.minter").to.equal(distributorAddr);
      expect(deployRun.stdout).to.include(`Predicted RewardsDistributor proxy address: ${distributorAddr}`);
      // $ASSET is recorded as the one registered token mintRewardToken refuses by address.
      expect(await distributor.asset(), "distributor.asset").to.equal(assetAddr);

      // The zapper's PROXY landed on the address the script predicted from the deployer's
      // nonce, and the vault was initialized with it: no `setZapper` transaction exists here.
      expect(await vault.zapper(), "vault.zapper").to.equal(zapperAddr);
      expect(deployRun.stdout).to.include(`Predicted LPZapper proxy address: ${zapperAddr}`);
      // The ApeBond escrow hooks ship OFF.
      expect(await vault.bonusEscrow(), "vault.bonusEscrow").to.equal(C.ZERO_ADDRESS);

      // The timelock itself: the multisig proposes, executes and cancels; nobody else does,
      // and the timelock is its own admin, so even a role change is a scheduled operation.
      expect(await timelock.getMinDelay()).to.equal(BigInt(C.TIMELOCK_MIN_DELAY));
      const roles = {
        PROPOSER_ROLE: await timelock.PROPOSER_ROLE(),
        EXECUTOR_ROLE: await timelock.EXECUTOR_ROLE(),
        CANCELLER_ROLE: await timelock.CANCELLER_ROLE(),
      };
      for (const [name, role] of Object.entries(roles)) {
        expect(await timelock.hasRole(role, w.multisig.address), `multisig ${name}`).to.equal(true);
        expect(await timelock.hasRole(role, w.deployer.address), `deployer ${name}`).to.equal(false);
      }
      const adminRole = await timelock.DEFAULT_ADMIN_ROLE();
      expect(await timelock.hasRole(adminRole, timelockAddr)).to.equal(true);
      expect(await timelock.hasRole(adminRole, w.deployer.address)).to.equal(false);
      expect(await timelock.hasRole(adminRole, w.multisig.address)).to.equal(false);

      expect(await overture.name()).to.equal(C.OVERTURE_NAME);
      expect(await overture.symbol()).to.equal(C.OVERTURE_SYMBOL);
      expect(await overture.decimals()).to.equal(18n);

      // The two launch reward tokens, in order: $ASSET conditional with claims CLOSED, $OVTR
      // unconditional with claims open. deployments.json records the same list.
      expect(await distributor.rewardTokens()).to.deep.equal([assetAddr, overtureAddr]);
      const assetState = await distributor.rewardToken(assetAddr);
      expect([assetState.registered, assetState.enabled, assetState.conditional, assetState.claimsEnabled]).to.deep.equal([
        true,
        true,
        true,
        false,
      ]);
      expect(assetState.decimals).to.equal(18n);
      const overtureState = await distributor.rewardToken(overtureAddr);
      expect([
        overtureState.registered,
        overtureState.enabled,
        overtureState.conditional,
        overtureState.claimsEnabled,
      ]).to.deep.equal([true, true, false, true]);
      expect(entries.RewardsDistributor.rewardTokens.map((t) => [t.address, t.conditional, t.claimsEnabled])).to.deep.equal([
        [assetAddr, true, false],
        [overtureAddr, false, true],
      ]);
      expect(await distributor.signer()).to.equal(w.backOffice.address);
      expect(await distributor.paused()).to.equal(false);

      expect(await registry.distributor()).to.equal(distributorAddr);
      expect(await registry.INTERVAL()).to.equal(BigInt(C.REGISTRY_INTERVAL));
      expect(await registry.SCHEDULE_MARGIN()).to.equal(BigInt(C.REGISTRY_SCHEDULE_MARGIN));

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

    it("emitted the initialization events the runbook documents, in script order", async function () {
      // Every contract below was deployed by the script and touched by nothing else inside
      // the deploy window. Each proxy's deploy transaction is the PROXY's: `Upgraded` names the
      // implementation the ERC-1967 slot got, then `initialize` runs inside the same
      // transaction — its single `OwnershipTransferred` names the TIMELOCK, because every
      // proxy is born owned by it — and `Initialized` closes it. `initialize` announces EVERY
      // mutable field, the ones whose initial value is the type's default included, so an
      // indexer needs no hardcoded defaults. There is no later `OwnershipTransferStarted` /
      // `OwnershipTransferred` pair anywhere: nothing is handed over.
      const expectedPerContract = {
        // name/symbol/permit domain are OZ storage writes with no event; the minter is ours.
        [overtureAddr.toLowerCase()]: [
          "Upgraded",
          "OwnershipTransferred",
          "MinterChanged",
          "Initialized",
        ],
        // The launch reward tokens are announced one `RewardTokenAdded` each, in list order.
        [distributorAddr.toLowerCase()]: [
          "Upgraded",
          "OwnershipTransferred",
          "GuardianSet",
          "OperatorSet",
          "SignerChanged",
          "Paused",
          "AssetSet",
          "RewardTokenAdded",
          "RewardTokenAdded",
          "Initialized",
        ],
        [registryAddr.toLowerCase()]: ["Upgraded", "OwnershipTransferred", "OperatorSet", "Initialized"],
        // Exactly ONE `ZapperSet`, `initialize`'s own, carrying the predicted zapper proxy:
        // the owner-only `setZapper` is not part of the bootstrap. `BonusEscrowSet(0, 0)`
        // announces that the escrow hooks start off.
        [vaultAddr.toLowerCase()]: [
          "Upgraded",
          "OwnershipTransferred",
          "GuardianSet",
          "OperatorSet",
          "ZapperSet",
          "BonusEscrowSet",
          "DepositsPausedSet",
          "RebalancePausedSet",
          "TwapParamsSet",
          "Initialized",
        ],
        [zapperAddr.toLowerCase()]: [
          "Upgraded",
          "OwnershipTransferred",
          "OperatorSet",
          "TwapParamsSet",
          "Initialized",
        ],
        // The timelock is deployed FIRST, because every proxy names it in its own deployment
        // transaction. Its constructor grants four roles — DEFAULT_ADMIN to itself, PROPOSER
        // and CANCELLER to the multisig (OZ grants both to every proposer), EXECUTOR to the
        // multisig — and closes with `MinDelayChange(0, minDelay)`. That is the whole list: the
        // bootstrap schedules and executes nothing. The first operation this timelock ever runs
        // is A28's, in the scenario below.
        [timelockAddr.toLowerCase()]: [
          "RoleGranted",
          "RoleGranted",
          "RoleGranted",
          "RoleGranted",
          "MinDelayChange",
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

      const logsOf = async (address) =>
        chain.decodeLogs(
          await rpc.getLogs(provider, { address, fromBlock: deployFromBlock, toBlock: deployToBlock }),
          ifaces
        );

      // The Overture token: born owned by the timelock, with the distributor proxy as its minter.
      const overtureLogs = await logsOf(overtureAddr);
      expect(overtureLogs[1].args.previousOwner).to.equal(C.ZERO_ADDRESS);
      expect(overtureLogs[1].args.newOwner).to.equal(timelockAddr);
      expect(overtureLogs[2].args.previousMinter).to.equal(C.ZERO_ADDRESS);
      expect(overtureLogs[2].args.newMinter).to.equal(distributorAddr);

      // The distributor announces $ASSET, then both launch tokens with their full state.
      const distributorLogs = await logsOf(distributorAddr);
      expect(distributorLogs.find((l) => l.name === "AssetSet").args.asset).to.equal(assetAddr);
      const [assetAdded, overtureAdded] = distributorLogs.filter((l) => l.name === "RewardTokenAdded");
      expect(assetAdded.args.token).to.equal(assetAddr);
      expect(assetAdded.args.conditional).to.equal(true);
      expect(assetAdded.args.claimsEnabled).to.equal(false);
      expect(assetAdded.args.decimals).to.equal(18n);
      expect(assetAdded.args.symbol).to.equal(C.ASSET_SYMBOL);
      expect(overtureAdded.args.token).to.equal(overtureAddr);
      expect(overtureAdded.args.conditional).to.equal(false);
      expect(overtureAdded.args.claimsEnabled).to.equal(true);
      expect(overtureAdded.args.symbol).to.equal(C.OVERTURE_SYMBOL);

      // The vault's escrow link is announced as off.
      const escrowSet = (await logsOf(vaultAddr)).find((l) => l.name === "BonusEscrowSet");
      expect(escrowSet.args.previousEscrow).to.equal(C.ZERO_ADDRESS);
      expect(escrowSet.args.newEscrow).to.equal(C.ZERO_ADDRESS);
    });

    it("reports the EIP-712 domain and type hashes the back office must sign against", async function () {
      // The domain is a runtime fact of a contract deployed a minute ago: its chain id is
      // the fork's, and its verifying contract did not exist before this run.
      expect(voucherDomain.name).to.equal("RealLPRewards");
      expect(voucherDomain.version).to.equal("1");
      expect(voucherDomain.chainId).to.equal(C.LOCAL_CHAIN_ID);
      expect(voucherDomain.verifyingContract).to.equal(distributorAddr);

      // Recomputed from the struct string signing.js signs with, so a change to the type
      // string in RewardsDistributor.sol fails here rather than at the first claim. One type
      // for every reward token: the token is a SIGNED field, which is what makes a voucher
      // for one token worthless for another.
      expect(await distributor.REWARD_CLAIM_TYPEHASH()).to.equal(signing.rewardClaimTypeHash());
      expect(signing.rewardClaimTypeHash()).to.equal(C.REWARD_CLAIM_TYPEHASH);
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

    it("refuses a guardian that is also the operator, before spending any gas", async function () {
      // The one FATAL role rule (§11.2): a hot pause key and the multisig that can move value
      // must not be the same address. It is checked in the local-validation phase, before the
      // first on-chain read, so the refusal costs nothing and names both variables.
      const before = await head();
      const refused = await runner.runHardhatScript(
        "scripts/deploy-lp-staking.js",
        deployScriptEnv({ LP_GUARDIAN: w.operator.address }),
        { logFile: path.join(scratchDir, "scripts.log") }
      );

      expect(refused.code).to.not.equal(0);
      expect(`${refused.stdout}${refused.stderr}`).to.include(
        "LP_GUARDIAN and LP_OPERATOR must be different addresses"
      );
      expect(await head(), "the refusal must not send a transaction").to.equal(before);
    });

    it("left the tracked deployments.json untouched and wrote only to the override", async function () {
      expect(runner.sha256File(runner.TRACKED_REGISTRY)).to.equal(TRACKED_REGISTRY_SHA256);

      const override = runner.readRegistry(registryFile);
      expect(Object.keys(override)).to.deep.equal(["31337"]);
      expect(Object.keys(override["31337"]).sort()).to.deep.equal([
        "LPEpochRegistry",
        "LPStakingVault",
        "LPZapper",
        "RewardsDistributor",
        "TimelockController",
        "TokenOverture",
        "UniswapV3Pool",
      ]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  describe("2. the forty-eight step scenario, one transaction per block", function () {
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

    it("A15: the guardian pauses deposits", async function () {
      // The pause switches are the guardian's whole tier: one hot key, one transaction, no
      // delay. The operator can send the same call as the cold fallback (A32 proves the
      // distributor's), and the OWNER cannot send it at all.
      const receipt = await chain.send(vault.connect(w.guardian).setDepositsPaused(true));
      ledger.record("A15", "guardian pauses deposits", receipt, [
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

    it("A17: the guardian resumes deposits", async function () {
      const receipt = await chain.send(vault.connect(w.guardian).setDepositsPaused(false));
      ledger.record("A17", "guardian resumes deposits", receipt, [
        { address: vaultAddr, name: "DepositsPausedSet" },
      ]);
      expect(await vault.depositsPaused()).to.equal(false);
    });

    it("A18: carol stakes P7 now that deposits are open", async function () {
      const receipt = await chain.send(vault.connect(w.carol).stake(positions.P7));
      ledger.record("A18", "carol stakes P7", receipt, [{ address: vaultAddr, name: "Staked" }]);
      expect(await vault.stakerOf(positions.P7)).to.equal(w.carol.address);
    });

    it("A19: the vault's TWAP guard is retuned by the operator, directly, and the owner is rejected", async function () {
      // Since the 2026-09-09 role split `setTwapParams` is OPERATOR tier, not owner tier: the
      // calibration is a routine parameter whose misuse can only grief the swap legs — the
      // contract's own MIN/MAX bounds cap it — and can never move value, so it needs a
      // multisig but not a delay. LP_OPERATOR is its own key in this run, so the operator
      // sends the call itself, in one transaction, with no schedule and no wait.
      //
      // The owner is the timelock, and it is rejected. Two proofs, one off-chain and one on:
      // first, the operator front end refuses to build the operation at all, because
      // `setTwapParams` was removed from scripts/lp-timelock.js's OWNER_TIER allow-list — a
      // scheduled call that would revert `NotOperator` after the delay is caught here, at the
      // point of typing it, instead.
      expect(() =>
        lpTimelock.buildOperation({
          target: vaultAddr,
          fn: "setTwapParams",
          args: [C.RETUNED_TWAP_WINDOW, C.RETUNED_MAX_DEVIATION_TICKS],
        })
      ).to.throw(/not an owner-tier function/);

      // Second, the timelock as a CALLER is rejected by the contract itself. The revert data
      // comes out of `eth_estimateGas`, so nothing is signed, sent or mined — which is also
      // why no key for the timelock address is needed.
      await chain.expectCustomError(
        provider,
        vault
          .connect(new ethers.JsonRpcSigner(provider, timelockAddr))
          .setTwapParams(C.RETUNED_TWAP_WINDOW, C.RETUNED_MAX_DEVIATION_TICKS),
        vault.interface,
        "NotOperator"
      );

      const receipt = await chain.send(
        vault
          .connect(w.operator)
          .setTwapParams(C.RETUNED_TWAP_WINDOW, C.RETUNED_MAX_DEVIATION_TICKS)
      );
      ledger.record("A19", "the operator retunes the vault", receipt, [
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

    it("A20: the operator retunes the zapper's TWAP guard directly", async function () {
      // The zapper is a UUPS proxy owned by the timelock, and like the vault it keeps its
      // immediate levers on the OPERATOR tier: `setTwapParams`, `sweep`, `rescuePosition`.
      // Same call, same guard, one transaction, no schedule. The owner (the timelock) holds
      // only upgrades and `setOperator`, and is rejected here exactly as on the vault.
      await chain.expectCustomError(
        provider,
        zapper
          .connect(new ethers.JsonRpcSigner(provider, timelockAddr))
          .setTwapParams(C.RETUNED_TWAP_WINDOW, C.RETUNED_MAX_DEVIATION_TICKS),
        zapper.interface,
        "NotOperator"
      );
      const receipt = await chain.send(
        zapper
          .connect(w.operator)
          .setTwapParams(C.RETUNED_TWAP_WINDOW, C.RETUNED_MAX_DEVIATION_TICKS)
      );
      ledger.record("A20", "operator retunes the zapper", receipt, [
        { address: zapperAddr, name: "TwapParamsSet" },
      ]);
      expect(await zapper.twapWindow()).to.equal(BigInt(C.RETUNED_TWAP_WINDOW));
      expect((await zapper.previewTwap()).withinBounds).to.equal(true);
    });

    it("A21: carol redeems a 1000 $OVTR voucher", async function () {
      const amount = C.TOKENS(1_000);
      const signature = await voucher(overtureAddr, "carol", amount);
      const fundedBefore = await overture.balanceOf(distributorAddr);
      const receipt = await chain.send(
        distributor.connect(w.carol).claim(overtureAddr, amount, C.FAR_DEADLINE, signature)
      );
      // Paid by TRANSFER out of the funded balance: the Transfer is from the distributor.
      ledger.record("A21", "carol claims 1000 $OVTR", receipt, [
        { address: overtureAddr, name: "Transfer" },
        { address: distributorAddr, name: "Claimed" },
      ]);

      const args = chain.parseEvent(receipt, distributor.interface, distributorAddr, "Claimed");
      expect(args.user).to.equal(w.carol.address);
      expect(args.token).to.equal(overtureAddr);
      expect(args.cumulativeAmount).to.equal(amount);
      expect(args.paidAmount).to.equal(amount);
      expect(args.timestamp).to.equal(BigInt(await timestampOf(receipt.blockNumber)));
      const transfer = chain.parseEvent(receipt, overture.interface, overtureAddr, "Transfer");
      expect(transfer.from).to.equal(distributorAddr);
      expect(transfer.to).to.equal(w.carol.address);

      expect(await overture.balanceOf(w.carol.address)).to.equal(amount);
      expect(await distributor.claimed(overtureAddr, w.carol.address)).to.equal(amount);
      expect(await overture.balanceOf(distributorAddr)).to.equal(fundedBefore - amount);
      // Nothing was minted: the supply is still exactly what S9 minted.
      expect(await overture.totalSupply()).to.equal(C.FUND_OVTR);
    });

    it("A22: carol's second voucher pays only the difference", async function () {
      const cumulative = C.TOKENS(1_750);
      const delta = cumulative - C.TOKENS(1_000);
      const signature = await voucher(overtureAddr, "carol", cumulative);
      const receipt = await chain.send(
        distributor.connect(w.carol).claim(overtureAddr, cumulative, C.FAR_DEADLINE, signature)
      );
      ledger.record("A22", "carol claims 1750 $OVTR cumulative", receipt, [
        { address: overtureAddr, name: "Transfer" },
        { address: distributorAddr, name: "Claimed" },
      ]);

      const args = chain.parseEvent(receipt, distributor.interface, distributorAddr, "Claimed");
      expect(args.cumulativeAmount).to.equal(cumulative);
      expect(args.paidAmount).to.equal(delta);
      expect(await overture.balanceOf(w.carol.address)).to.equal(cumulative);
      expect(await distributor.claimed(overtureAddr, w.carol.address)).to.equal(cumulative);
    });

    it("A23: the operator schedules epoch 2 on the registry", async function () {
      // Directly, with no timelock: the schedule is the operator's immediate lever. Epoch 2
      // starts exactly where epoch 1 ends — back to back is legal, overlap is not.
      epochs.twoStartsAt = epochs.oneEndsAt;
      epochs.twoEndsAt = epochs.twoStartsAt + BigInt(C.EPOCH_LENGTH);
      const receipt = await chain.send(
        registry
          .connect(w.operator)
          .scheduleEpoch(
            C.EPOCH_TWO,
            epochs.twoStartsAt,
            epochs.twoEndsAt,
            [overtureAddr, assetAddr],
            [C.EPOCH_TWO_OVTR, C.EPOCH_TWO_ASSET]
          )
      );
      ledger.record("A23", "operator schedules epoch 2", receipt, [
        { address: registryAddr, name: "EpochScheduled" },
        { address: registryAddr, name: "EpochAmountSet" },
        { address: registryAddr, name: "EpochAmountSet" },
      ]);

      const args = chain.parseEvent(receipt, registry.interface, registryAddr, "EpochScheduled");
      expect(args.id).to.equal(C.EPOCH_TWO);
      expect(args.startsAt).to.equal(epochs.twoStartsAt);
      expect(args.endsAt).to.equal(epochs.twoEndsAt);
      expect(await registry.epochCount()).to.equal(C.EPOCH_TWO);
      expect(await registry.lastLiveId()).to.equal(C.EPOCH_TWO);
      expect((await registry.epoch(C.EPOCH_TWO)).prevLiveId).to.equal(C.EPOCH_ONE);
    });

    it("A24: the operator cancels epoch 2 before its margin", async function () {
      const receipt = await chain.send(registry.connect(w.operator).cancelEpoch(C.EPOCH_TWO));
      ledger.record("A24", "operator cancels epoch 2", receipt, [
        { address: registryAddr, name: "EpochCancelled" },
      ]);

      expect(chain.parseEvent(receipt, registry.interface, registryAddr, "EpochCancelled").id).to.equal(
        C.EPOCH_TWO
      );
      expect((await registry.epoch(C.EPOCH_TWO)).cancelled).to.equal(true);
      // `lastLiveId` falls back to epoch 1; the id 2 is spent for good.
      expect(await registry.lastLiveId()).to.equal(C.EPOCH_ONE);
      expect(await registry.epochCount()).to.equal(C.EPOCH_TWO);
    });

    it("A25: the operator schedules epoch 3 in its place, then adjusts it", async function () {
      // Ids are never reused: the replacement for the cancelled epoch 2 is epoch 3.
      const three = C.EPOCH_TWO + 1n;
      epochs.threeStartsAt = epochs.oneEndsAt;
      epochs.threeEndsAt = epochs.threeStartsAt + BigInt(C.EPOCH_LENGTH);
      const scheduled = await chain.send(
        registry
          .connect(w.operator)
          .scheduleEpoch(three, epochs.threeStartsAt, epochs.threeEndsAt, [overtureAddr], [C.EPOCH_TWO_OVTR])
      );
      ledger.record("A25", "operator schedules epoch 3", scheduled, [
        { address: registryAddr, name: "EpochScheduled" },
        { address: registryAddr, name: "EpochAmountSet" },
      ]);
      expect((await registry.epoch(three)).prevLiveId).to.equal(C.EPOCH_ONE);

      // A quantity for a token the epoch did not name yet: it joins the epoch's token list.
      const amount = await chain.send(
        registry.connect(w.operator).setEpochAmount(three, assetAddr, C.EPOCH_TWO_ASSET)
      );
      ledger.record("A25", "operator adds the $ASSET quantity of epoch 3", amount, [
        { address: registryAddr, name: "EpochAmountSet" },
      ]);
      expect(await registry.epochTokens(three)).to.deep.equal([overtureAddr, assetAddr]);

      // The last live epoch's bounds may still move: two weeks instead of one.
      epochs.threeEndsAt = epochs.threeStartsAt + 2n * BigInt(C.EPOCH_LENGTH);
      const moved = await chain.send(
        registry.connect(w.operator).updateEpochBounds(three, epochs.threeStartsAt, epochs.threeEndsAt)
      );
      ledger.record("A25", "operator stretches epoch 3", moved, [
        { address: registryAddr, name: "EpochUpdated" },
      ]);
      const updated = chain.parseEvent(moved, registry.interface, registryAddr, "EpochUpdated");
      expect(updated.endsAt).to.equal(epochs.threeEndsAt);
      expect(await registry.lastLiveId()).to.equal(three);
    });

    it("A26: the clock jumps into epoch 1, which is now frozen", async function () {
      const now = await latestTimestamp();
      const blockNumber = await rpc.advance(provider, Number(epochs.oneStartsAt) - now + 60);
      ledger.recordBlock("A26", "clock jumps into epoch 1", blockNumber);

      expect(BigInt(await latestTimestamp())).to.be.greaterThanOrEqual(epochs.oneStartsAt);
      expect(await registry.currentEpoch()).to.equal(C.EPOCH_ONE);
      // Inside its own margin nothing about epoch 1 can change any more. Read-only proof:
      // the refusal comes out of `eth_estimateGas`, so nothing is mined.
      await chain.expectCustomError(
        provider,
        registry.connect(w.operator).setEpochAmount(C.EPOCH_ONE, overtureAddr, 0n),
        registry.interface,
        "StartTooSoon"
      );
    });

    it("A27: dave claims 2000 $OVTR inside epoch 1; the schedule bounds nothing", async function () {
      const amount = C.TOKENS(2_000);
      const signature = await voucher(overtureAddr, "dave", amount);
      const receipt = await chain.send(
        distributor.connect(w.dave).claim(overtureAddr, amount, C.FAR_DEADLINE, signature)
      );
      ledger.record("A27", "dave claims 2000 $OVTR", receipt, [
        { address: overtureAddr, name: "Transfer" },
        { address: distributorAddr, name: "Claimed" },
      ]);

      const claimed = chain.parseEvent(receipt, distributor.interface, distributorAddr, "Claimed");
      expect(claimed.user).to.equal(w.dave.address);
      expect(claimed.paidAmount).to.equal(amount);
      expect(await overture.balanceOf(w.dave.address)).to.equal(amount);
      // The claim touched the schedule in no way.
      expect(await registry.epochAmount(C.EPOCH_ONE, overtureAddr)).to.equal(C.EPOCH_ONE_OVTR);
    });

    it("A28: $ASSET claims stay closed until the timelock opens them", async function () {
      // Closed at launch: a perfectly valid $ASSET voucher is refused, and nothing is mined.
      const amount = C.ASSET(3_000);
      const signature = await voucher(assetAddr, "bob", amount);
      const { headBefore, args } = await chain.expectCustomError(
        provider,
        distributor.connect(w.bob).claim(assetAddr, amount, C.FAR_DEADLINE, signature),
        distributor.interface,
        "TokenClaimsDisabled"
      );
      expect(args.token).to.equal(assetAddr);
      ledger.recordRevert("A28", "bob's $ASSET claim is refused", headBefore, "TokenClaimsDisabled");

      // Opening a token's claims is owner-tier: visible on-chain for the delay before it can
      // happen, like every other program decision.
      const { executed } = await throughTimelock("A28", "open $ASSET claims", {
        target: distributorAddr,
        fn: "setClaimsEnabled",
        args: [assetAddr, true],
        expected: [{ address: distributorAddr, name: "RewardTokenUpdated" }],
      });
      const updated = chain.parseEvent(executed, distributor.interface, distributorAddr, "RewardTokenUpdated");
      expect(updated.token).to.equal(assetAddr);
      expect(updated.enabled).to.equal(true);
      expect(updated.claimsEnabled).to.equal(true);
      expect((await distributor.rewardToken(assetAddr)).claimsEnabled).to.equal(true);
    });

    it("A29: a third reward token joins through the timelock and pays once it is funded", async function () {
      // The token: an Overture-shaped proxy deployed by scripts/add-reward-token.js (owner =
      // the timelock, minter = the distributor proxy — the script's default, the rule for every
      // reward token we deploy), recorded as RewardToken:TRW. The script sends nothing to the
      // timelock; it prints the operation, which the multisig runs below.
      const addRun = await runScript("scripts/add-reward-token.js", {
        ...baseScriptEnv(),
        REWARD_TOKEN_NAME: "Third Reward",
        REWARD_TOKEN_SYMBOL: "TRW",
        REWARD_TOKEN_CONDITIONAL: "0",
        REWARD_TOKEN_CLAIMS_ENABLED: "1",
      });
      const entry = runner.registryEntry(registryFile, 31337, "RewardToken:TRW");
      thirdTokenAddr = entry.address;
      thirdToken = await contractAt("TokenOverture", thirdTokenAddr);
      ledger.record("A29", "deploy the TRW implementation", await provider.getTransactionReceipt(entry.implementationTx));
      // The proxy's deploy transaction carries its whole initialization, as S7 did for $OVTR.
      ledger.record("A29", "deploy the TRW proxy", await provider.getTransactionReceipt(entry.deployTx), [
        { address: thirdTokenAddr, name: "Upgraded" },
        { address: thirdTokenAddr, name: "OwnershipTransferred" },
        { address: thirdTokenAddr, name: "MinterChanged" },
        { address: thirdTokenAddr, name: "Initialized" },
      ]);
      expect(await thirdToken.owner()).to.equal(timelockAddr);
      expect(await thirdToken.minter()).to.equal(distributorAddr);
      expect(addRun.stdout).to.include("TIMELOCK_FN=addRewardToken");

      const { executed } = await throughTimelock("A29", "add TRW as a reward token", {
        target: distributorAddr,
        fn: "addRewardToken",
        args: [thirdTokenAddr, false, true],
        expected: [{ address: distributorAddr, name: "RewardTokenAdded" }],
      });
      const added = chain.parseEvent(executed, distributor.interface, distributorAddr, "RewardTokenAdded");
      expect(added.token).to.equal(thirdTokenAddr);
      expect(added.symbol).to.equal("TRW");
      expect(await distributor.isRewardToken(thirdTokenAddr)).to.equal(true);

      // Registered but not funded: a valid voucher reverts with the exact shortfall, and
      // nothing is paid partially. There is no cap anywhere; the balance is the only bound.
      const amount = C.TOKENS(500);
      const signature = await voucher(thirdTokenAddr, "alice", amount);
      const { headBefore, args } = await chain.expectCustomError(
        provider,
        distributor.connect(w.alice).claim(thirdTokenAddr, amount, C.FAR_DEADLINE, signature),
        distributor.interface,
        "InsufficientFunds"
      );
      expect(args.token).to.equal(thirdTokenAddr);
      expect(args.needed).to.equal(amount);
      expect(args.balance).to.equal(0n);
      ledger.recordRevert("A29", "alice's TRW claim reverts: not funded", headBefore, "InsufficientFunds");

      // The operator funds it through scripts/lp-mint-reward.js — RewardsDistributor.mintRewardToken,
      // which needs the token registered, hence after the execute. The script runs with the
      // deployer's key, which is not the operator, so it prints the Safe payload; the operator
      // sends it. The very same voucher then pays.
      const mintRun = await runScript("scripts/lp-mint-reward.js", {
        ...baseScriptEnv(),
        MINT_TOKEN: "TRW",
        MINT_TO: "distributor",
        MINT_AMOUNT: ethers.formatUnits(amount, 18),
      });
      const [trwPayload] = safePayloads(mintRun.stdout);
      expect(trwPayload.to).to.equal(distributorAddr);
      expect(trwPayload.data).to.equal(
        distributor.interface.encodeFunctionData("mintRewardToken", [thirdTokenAddr, distributorAddr, amount])
      );
      ledger.record(
        "A29",
        "operator mints TRW into the distributor through mintRewardToken",
        await chain.send(w.operator.sendTransaction({ to: trwPayload.to, data: trwPayload.data })),
        [
          { address: thirdTokenAddr, name: "Transfer" },
          { address: distributorAddr, name: "RewardTokenMinted" },
        ]
      );
      const receipt = await chain.send(
        distributor.connect(w.alice).claim(thirdTokenAddr, amount, C.FAR_DEADLINE, signature)
      );
      ledger.record("A29", "alice claims 500 TRW", receipt, [
        { address: thirdTokenAddr, name: "Transfer" },
        { address: distributorAddr, name: "Claimed" },
      ]);
      expect(await thirdToken.balanceOf(w.alice.address)).to.equal(amount);
      expect(await distributor.claimed(thirdTokenAddr, w.alice.address)).to.equal(amount);
    });

    it("A30: bob claims 3000 tASSET", async function () {
      const amount = C.ASSET(3_000);
      const signature = await voucher(assetAddr, "bob", amount);
      const balanceBefore = await asset.balanceOf(w.bob.address);

      const receipt = await chain.send(
        distributor.connect(w.bob).claim(assetAddr, amount, C.FAR_DEADLINE, signature)
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
      expect(await distributor.claimed(assetAddr, w.bob.address)).to.equal(amount);
      expect(await asset.balanceOf(distributorAddr)).to.equal(C.FUND_ASSET - amount);
    });

    it("A31: the operator recovers 1000 tASSET of overfunding", async function () {
      const amount = C.ASSET(1_000);
      const balanceBefore = await asset.balanceOf(w.operator.address);
      const receipt = await chain.send(distributor.connect(w.operator).recoverExcess(assetAddr, amount));
      ledger.record("A31", "operator recovers 1000 tASSET", receipt, [
        { address: assetAddr, name: "Transfer" },
        { address: distributorAddr, name: "ExcessRecovered" },
      ]);

      const args = chain.parseEvent(receipt, distributor.interface, distributorAddr, "ExcessRecovered");
      expect(args.token).to.equal(assetAddr);
      expect(args.to).to.equal(w.operator.address);
      expect(args.amount).to.equal(amount);
      expect(args.timestamp).to.equal(BigInt(await timestampOf(receipt.blockNumber)));
      expect((await asset.balanceOf(w.operator.address)) - balanceBefore).to.equal(amount);
      expect(await asset.balanceOf(distributorAddr)).to.equal(C.FUND_ASSET - C.ASSET(4_000));
    });

    it("A32: the guardian pauses claims", async function () {
      const receipt = await chain.send(distributor.connect(w.guardian).setPaused(true));
      ledger.record("A32", "guardian pauses claims", receipt, [
        { address: distributorAddr, name: "Paused" },
      ]);
      expect(await distributor.paused()).to.equal(true);
    });

    it("A33: bob's next claim reverts with ClaimsPaused and mines nothing", async function () {
      const amount = C.ASSET(4_000);
      const signature = await voucher(assetAddr, "bob", amount);
      const { headBefore } = await chain.expectCustomError(
        provider,
        distributor.connect(w.bob).claim(assetAddr, amount, C.FAR_DEADLINE, signature),
        distributor.interface,
        "ClaimsPaused"
      );
      ledger.recordRevert("A33", "bob's claim is refused", headBefore, "ClaimsPaused");
      expect(await distributor.claimed(assetAddr, w.bob.address)).to.equal(C.ASSET(3_000));
    });

    it("A34: the guardian unpauses claims", async function () {
      const receipt = await chain.send(distributor.connect(w.guardian).setPaused(false));
      ledger.record("A34", "guardian unpauses claims", receipt, [
        { address: distributorAddr, name: "Paused" },
      ]);
      expect(await distributor.paused()).to.equal(false);
    });

    it("A35: the operator rotates the voucher signer", async function () {
      const receipt = await chain.send(distributor.connect(w.operator).setSigner(w.signer2.address));
      ledger.record("A35", "operator rotates the signer", receipt, [
        { address: distributorAddr, name: "SignerChanged" },
      ]);

      const args = chain.parseEvent(receipt, distributor.interface, distributorAddr, "SignerChanged");
      expect(args.previousSigner).to.equal(w.backOffice.address);
      expect(args.newSigner).to.equal(w.signer2.address);
      expect(await distributor.signer()).to.equal(w.signer2.address);
    });

    it("A36: the operator rotates it back to the back office", async function () {
      const receipt = await chain.send(
        distributor.connect(w.operator).setSigner(w.backOffice.address)
      );
      ledger.record("A36", "operator restores the signer", receipt, [
        { address: distributorAddr, name: "SignerChanged" },
      ]);
      expect(await distributor.signer()).to.equal(w.backOffice.address);
    });

    it("A37: a stray NFT pushed into the vault is rescued to the operator", async function () {
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

      const receipt = await chain.send(vault.connect(w.operator).rescuePosition(positions.P8));
      ledger.record("A37", "operator rescues P8", receipt, [
        { address: vaultAddr, name: "PositionRescued" },
      ]);

      const args = chain.parseEvent(receipt, vault.interface, vaultAddr, "PositionRescued");
      expect(args.tokenId).to.equal(positions.P8);
      expect(args.to).to.equal(w.operator.address);
      expect(await npm.ownerOf(positions.P8)).to.equal(w.operator.address);
    });

    it("A38: a stray NFT pushed into the zapper is rescued to the operator", async function () {
      const minted = await mintFor("dave", "P9", 1200, C.ASSET(100), C.USDC(25));
      ledger.record("A38", "dave mints P9", minted.receipt);
      ledger.record(
        "A38",
        "dave pushes P9 into the zapper",
        await chain.send(npm.connect(w.dave).transferFrom(w.dave.address, zapperAddr, positions.P9))
      );
      expect(await npm.ownerOf(positions.P9)).to.equal(zapperAddr);

      const receipt = await chain.send(zapper.connect(w.operator).rescuePosition(positions.P9));
      ledger.record("A38", "operator rescues P9", receipt, [
        { address: zapperAddr, name: "PositionRescued" },
      ]);

      const args = chain.parseEvent(receipt, zapper.interface, zapperAddr, "PositionRescued");
      expect(args.tokenId).to.equal(positions.P9);
      expect(args.to).to.equal(w.operator.address);
      expect(await npm.ownerOf(positions.P9)).to.equal(w.operator.address);
    });

    it("A39: stray tUSDC on the zapper is swept to the operator", async function () {
      const amount = C.USDC(5);
      ledger.record(
        "A39",
        "stray tUSDC lands on the zapper",
        await chain.send(usdc.connect(w.deployer).transfer(zapperAddr, amount)),
        [{ address: usdcAddr, name: "Transfer" }]
      );
      expect(await usdc.balanceOf(zapperAddr)).to.equal(amount);

      const balanceBefore = await usdc.balanceOf(w.operator.address);
      const receipt = await chain.send(
        zapper.connect(w.operator).sweep(usdcAddr, amount, w.operator.address)
      );
      ledger.record("A39", "operator sweeps the zapper", receipt, [
        { address: usdcAddr, name: "Transfer" },
        { address: zapperAddr, name: "Swept" },
      ]);

      const args = chain.parseEvent(receipt, zapper.interface, zapperAddr, "Swept");
      expect(args.token).to.equal(usdcAddr);
      expect(args.to).to.equal(w.operator.address);
      expect(args.amount).to.equal(amount);
      expect((await usdc.balanceOf(w.operator.address)) - balanceBefore).to.equal(amount);
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

    it("A41: the zapper wiring is cycled off and back on through the timelock", async function () {
      // Two full round trips. The salt scripts/lp-timelock.js derives folds the arguments in,
      // so "point the vault at nothing" and "point it back at the zapper" are two different
      // operation ids rather than one id that cannot be scheduled twice.
      const { executed: off } = await throughTimelock("A41", "disable the zapper", {
        target: vaultAddr,
        fn: "setZapper",
        args: [C.ZERO_ADDRESS],
        expected: [{ address: vaultAddr, name: "ZapperSet" }],
      });
      let args = chain.parseEvent(off, vault.interface, vaultAddr, "ZapperSet");
      expect(args.previousZapper).to.equal(zapperAddr);
      expect(args.newZapper).to.equal(C.ZERO_ADDRESS);
      expect(await vault.zapper()).to.equal(C.ZERO_ADDRESS);

      const { executed: on } = await throughTimelock("A41", "re-enable the zapper", {
        target: vaultAddr,
        fn: "setZapper",
        args: [zapperAddr],
        expected: [{ address: vaultAddr, name: "ZapperSet" }],
      });
      args = chain.parseEvent(on, vault.interface, vaultAddr, "ZapperSet");
      expect(args.previousZapper).to.equal(C.ZERO_ADDRESS);
      expect(args.newZapper).to.equal(zapperAddr);
      expect(await vault.zapper()).to.equal(zapperAddr);
    });

    it("A42: the Overture minter is cycled away and back through the timelock", async function () {
      // `setMinter` is owner-tier on the Overture token proxy, so moving the minter is a
      // scheduled, public operation: two full round trips, two different operation ids.
      const { executed: away } = await throughTimelock("A42", "move the minter away", {
        target: overtureAddr,
        fn: "setMinter",
        args: [w.signer2.address],
        expected: [{ address: overtureAddr, name: "MinterChanged" }],
      });
      let args = chain.parseEvent(away, overture.interface, overtureAddr, "MinterChanged");
      expect(args.previousMinter).to.equal(distributorAddr);
      expect(args.newMinter).to.equal(w.signer2.address);

      const { executed: back } = await throughTimelock("A42", "restore the minter", {
        target: overtureAddr,
        fn: "setMinter",
        args: [distributorAddr],
        expected: [{ address: overtureAddr, name: "MinterChanged" }],
      });
      args = chain.parseEvent(back, overture.interface, overtureAddr, "MinterChanged");
      expect(args.previousMinter).to.equal(w.signer2.address);
      expect(args.newMinter).to.equal(distributorAddr);
      expect(await overture.minter()).to.equal(distributorAddr);
    });

    it("A43: the guardian pauses rebalance", async function () {
      const receipt = await chain.send(vault.connect(w.guardian).setRebalancePaused(true));
      ledger.record("A43", "guardian pauses rebalance", receipt, [
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

    it("A45: the guardian resumes rebalance", async function () {
      const receipt = await chain.send(vault.connect(w.guardian).setRebalancePaused(false));
      ledger.record("A45", "guardian resumes rebalance", receipt, [
        { address: vaultAddr, name: "RebalancePausedSet" },
      ]);
      expect(
        chain.parseEvent(receipt, vault.interface, vaultAddr, "RebalancePausedSet").rebalancePaused
      ).to.equal(false);
      expect(await vault.rebalancePaused()).to.equal(false);
    });

    it("A46: the multisig schedules an upgrade of the vault to V2", async function () {
      // A rehearsal of the real thing, on a chain that already holds four staked positions.
      // The V2 mock adds a `version()` marker and one variable in its own ERC-7201 namespace;
      // it changes nothing about custody, which is exactly what makes A48's assertions mean
      // something.
      const artifact = await hre.artifacts.readArtifact("LPStakingVaultV2Mock");
      const V2 = new ethers.ContractFactory(artifact.abi, artifact.bytecode, w.deployer);
      const impl = await (
        await V2.deploy(C.NPM_ADDR, poolAddr, token0, token1, C.FEE, C.ROUTER_ADDR)
      ).waitForDeployment();
      vaultV2ImplAddr = await impl.getAddress();
      ledger.record(
        "A46",
        "deploy the V2 implementation",
        await impl.deploymentTransaction().wait()
      );

      // Not even the multisig can upgrade: `_authorizeUpgrade` is onlyOwner and the owner is
      // the timelock. This is the whole point of the revision.
      await chain.expectCustomError(
        provider,
        vault.connect(w.multisig).upgradeToAndCall(vaultV2ImplAddr, "0x"),
        vault.interface,
        "OwnableUnauthorizedAccount"
      );

      upgradeOperation = lpTimelock.buildOperation({
        target: vaultAddr,
        fn: "upgradeToAndCall",
        args: [vaultV2ImplAddr, "0x"],
      });
      const scheduled = await chain.send(
        timelock
          .connect(w.multisig)
          .schedule(
            upgradeOperation.target,
            upgradeOperation.value,
            upgradeOperation.data,
            upgradeOperation.predecessor,
            upgradeOperation.salt,
            C.TIMELOCK_MIN_DELAY
          )
      );
      ledger.record("A46", "multisig schedules the vault upgrade", scheduled, [
        { address: timelockAddr, name: "CallScheduled" },
        { address: timelockAddr, name: "CallSalt" },
      ]);

      // The whole calldata is in the log, which is what makes an upgrade public before it can
      // run: anyone watching the timelock sees which implementation is coming.
      const args = chain.parseEvent(scheduled, timelock.interface, timelockAddr, "CallScheduled");
      expect(args.id).to.equal(upgradeOperation.id);
      expect(args.target).to.equal(vaultAddr);
      expect(args.data).to.equal(upgradeOperation.data);
      expect(args.delay).to.equal(BigInt(C.TIMELOCK_MIN_DELAY));

      expect(await timelock.isOperationPending(upgradeOperation.id)).to.equal(true);
      expect(await timelock.isOperationReady(upgradeOperation.id)).to.equal(false);
    });

    it("A47: executing it early reverts TimelockUnexpectedOperationState and mines nothing", async function () {
      const { headBefore } = await chain.expectCustomError(
        provider,
        timelock
          .connect(w.multisig)
          .execute(
            upgradeOperation.target,
            upgradeOperation.value,
            upgradeOperation.data,
            upgradeOperation.predecessor,
            upgradeOperation.salt
          ),
        timelock.interface,
        "TimelockUnexpectedOperationState"
      );
      ledger.recordRevert(
        "A47",
        "the upgrade is not ready yet",
        headBefore,
        "TimelockUnexpectedOperationState"
      );

      // The code behind the proxy is untouched: V1 has no `version()`, so the call finds no
      // selector and the proxy reverts rather than answering 2.
      const asV2 = await contractAt("LPStakingVaultV2Mock", vaultAddr);
      await chain.expectReverted(asV2.version(), "version() before the upgrade executes");
      expect(await timelock.isOperationDone(upgradeOperation.id)).to.equal(false);
    });

    it("A48: after the delay the upgrade executes and every staked position survives it", async function () {
      const stakedBefore = {
        P5: await vault.stakerOf(positions.P5),
        P3: await vault.stakerOf(positions.P3),
        P7: await vault.stakerOf(positions.P7),
      };
      expect(stakedBefore.P5).to.equal(w.alice.address);

      await rpc.increaseTime(provider, C.TIMELOCK_MIN_DELAY + 1);
      const executed = await chain.send(
        timelock
          .connect(w.multisig)
          .execute(
            upgradeOperation.target,
            upgradeOperation.value,
            upgradeOperation.data,
            upgradeOperation.predecessor,
            upgradeOperation.salt
          )
      );
      ledger.record("A48", "multisig executes the vault upgrade", executed, [
        { address: vaultAddr, name: "Upgraded" },
        { address: timelockAddr, name: "CallExecuted" },
      ]);

      const upgraded = chain.parseEvent(executed, vault.interface, vaultAddr, "Upgraded");
      expect(upgraded.implementation).to.equal(vaultV2ImplAddr);
      expect(await timelock.isOperationDone(upgradeOperation.id)).to.equal(true);

      const asV2 = await contractAt("LPStakingVaultV2Mock", vaultAddr);
      expect(await asV2.version()).to.equal(2n);

      // The reason the vault is a proxy at all: the staker ledger and custody are the same
      // after the code changed as they were before it.
      expect(await vault.stakerOf(positions.P5)).to.equal(stakedBefore.P5);
      expect(await vault.stakerOf(positions.P3)).to.equal(stakedBefore.P3);
      expect(await vault.stakerOf(positions.P7)).to.equal(stakedBefore.P7);
      expect(await npm.ownerOf(positions.P5)).to.equal(vaultAddr);
      // And so are the admin tiers and the guard's calibration.
      expect(await vault.owner()).to.equal(timelockAddr);
      expect(await vault.guardian()).to.equal(w.guardian.address);
      expect(await vault.operator()).to.equal(w.operator.address);
      expect(await vault.zapper()).to.equal(zapperAddr);
      expect(await vault.twapWindow()).to.equal(BigInt(C.RETUNED_TWAP_WINDOW));
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

    it("mined nothing for any of the six reverted calls", async function () {
      const reverts = ledger.reverts;
      expect(reverts.map((r) => r.step)).to.deep.equal(["A16", "A28", "A29", "A33", "A44", "A47"]);
      expect(reverts.map((r) => r.errorName)).to.deep.equal([
        "DepositsArePaused",
        "TokenClaimsDisabled",
        "InsufficientFunds",
        "ClaimsPaused",
        "RebalanceIsPaused",
        "TimelockUnexpectedOperationState",
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

      // S10 scheduled epoch 1 at least SCHEDULE_MARGIN ahead of the chain's clock, and A27
      // claims inside it: the schedule was final long before the epoch began.
      const s10 = timestamps.find((t) => t.step === "S10").ts;
      const a27 = timestamps.find((t) => t.step === "A27").ts;
      expect(Number(epochs.oneStartsAt) - s10).to.be.at.least(C.REGISTRY_SCHEDULE_MARGIN);
      expect(a27).to.be.at.least(Number(epochs.oneStartsAt));
      expect(a27).to.be.below(Number(epochs.oneEndsAt));
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
      for (const address of [
        vaultAddr,
        zapperAddr,
        overtureAddr,
        distributorAddr,
        registryAddr,
        timelockAddr,
        thirdTokenAddr,
      ]) {
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
        "Upgraded",
        "OwnershipTransferred",
        "GuardianSet",
        "OperatorSet",
        "ZapperSet",
        "BonusEscrowSet",
        "DepositsPausedSet",
        "RebalancePausedSet",
        "TwapParamsSet",
        "Initialized",
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

      // One topic per token, one ledger per token: the three tokens never mix.
      const overtureLeg = chain.decodeLogs(
        await logsFrom(distributorAddr, { topics: [topic, null, chain.addressTopic(overtureAddr)] }),
        ifaces
      );
      expect(overtureLeg.map((l) => l.args.user)).to.deep.equal([
        w.carol.address,
        w.carol.address,
        w.dave.address,
      ]);
      const thirdLeg = chain.decodeLogs(
        await logsFrom(distributorAddr, { topics: [topic, null, chain.addressTopic(thirdTokenAddr)] }),
        ifaces
      );
      expect(thirdLeg.map((l) => l.args.user)).to.deep.equal([w.alice.address]);
    });

    it("filters the schedule by the indexed epoch id and by the indexed token", async function () {
      const scheduledTopic = ethers.id("EpochScheduled(uint256,uint64,uint64)");
      const amountTopic = ethers.id("EpochAmountSet(uint256,address,uint256)");
      const ifaces = ifacesByAddress();

      // Three ids were issued — 1, 2 (cancelled) and 3 — and every one of them is in the log.
      const scheduled = chain.decodeLogs(await logsFrom(registryAddr, { topics: [scheduledTopic] }), ifaces);
      expect(scheduled.map((l) => l.args.id)).to.deep.equal([C.EPOCH_ONE, C.EPOCH_TWO, C.EPOCH_TWO + 1n]);

      const forEpochThree = chain.decodeLogs(
        await logsFrom(registryAddr, { topics: [amountTopic, chain.uintTopic(C.EPOCH_TWO + 1n)] }),
        ifaces
      );
      expect(forEpochThree.map((l) => l.args.token)).to.deep.equal([overtureAddr, assetAddr]);

      const assetAmounts = chain.decodeLogs(
        await logsFrom(registryAddr, { topics: [amountTopic, null, chain.addressTopic(assetAddr)] }),
        ifaces
      );
      expect(assetAmounts.map((l) => l.args.id)).to.deep.equal([C.EPOCH_ONE, C.EPOCH_TWO, C.EPOCH_TWO + 1n]);
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
      const addresses = [vaultAddr, zapperAddr, overtureAddr, distributorAddr, registryAddr];

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

  // ═══════════════════════════════════════════════════════════════════════
  describe("7. the timelock is replaced by scripts/lp-switch-timelock.js", function () {
    // Runs LAST, after every ledger-based section, so the scenario above keeps the timelock
    // it was born with. The script runs with the DEPLOYER's key, which holds no role on either
    // timelock: every schedule and execute comes out of it as a Safe payload, and the
    // multisig sends it — the mainnet shape. Only the new timelock's own deploy is sent by
    // the script itself.
    const FINAL_DELAY = 120; // the suite's stand-in for the 48 h the runbook installs
    let newTimelockAddr;

    function switchEnv(action, extra = {}) {
      return {
        ...baseScriptEnv(),
        SWITCH_ACTION: action,
        // Named explicitly: the child loads the private .env, where LP_MULTISIG may hold
        // another network's Safe.
        LP_MULTISIG: w.multisig.address,
        NEW_TIMELOCK_FINAL_DELAY: String(FINAL_DELAY),
        ...extra,
      };
    }

    /** Sends every payload a run printed, from the multisig. */
    async function sendPayloads(run, expectedCount) {
      const payloads = safePayloads(run.stdout);
      expect(payloads.length, run.stdout).to.equal(expectedCount);
      for (const payload of payloads) {
        await chain.send(w.multisig.sendTransaction({ to: payload.to, data: payload.data }));
      }
      return payloads;
    }

    it("deploys the new timelock governed by the same multisig, with no delay yet", async function () {
      const run = await runScript("scripts/lp-switch-timelock.js", switchEnv("deploy"));
      expect(run.stdout).to.not.include("WARNING");
      newTimelockAddr = runner.registryEntry(registryFile, 31337, "TimelockControllerNext").address;
      const next = await contractAt("LPTimelock", newTimelockAddr);
      expect(await next.getMinDelay()).to.equal(0n);
      expect(await next.hasRole(await next.PROPOSER_ROLE(), w.multisig.address)).to.equal(true);
      expect(await next.hasRole(await next.EXECUTOR_ROLE(), w.multisig.address)).to.equal(true);
      expect(await next.hasRole(await next.DEFAULT_ADMIN_ROLE(), newTimelockAddr)).to.equal(true);
    });

    it("moves all five proxies with ONE batch through the old timelock", async function () {
      const [schedule] = await sendPayloads(
        await runScript("scripts/lp-switch-timelock.js", switchEnv("schedule")),
        1
      );
      expect(schedule.to).to.equal(timelockAddr);

      // Mined, not only shifted: the script reads `isOperationReady` with a view call.
      await rpc.advance(provider, C.TIMELOCK_MIN_DELAY + 1);
      const [execute] = await sendPayloads(
        await runScript("scripts/lp-switch-timelock.js", switchEnv("execute")),
        1
      );
      expect(execute.to).to.equal(timelockAddr);

      // Ownable2Step: the old timelock is still the owner; the new one is the nominee.
      for (const contract of [overture, distributor, registry, vault, zapper]) {
        expect(await contract.owner()).to.equal(timelockAddr);
        expect(await contract.pendingOwner()).to.equal(newTimelockAddr);
      }
    });

    it("accepts all five from the new timelock, then raises its delay", async function () {
      // `accept` schedules the acceptOwnership batch on the NEW timelock; its delay is still
      // 0, so a second run finds it ready and prints the execute.
      await sendPayloads(await runScript("scripts/lp-switch-timelock.js", switchEnv("accept")), 1);
      await sendPayloads(await runScript("scripts/lp-switch-timelock.js", switchEnv("accept")), 1);
      for (const contract of [overture, distributor, registry, vault, zapper]) {
        expect(await contract.owner()).to.equal(newTimelockAddr);
        expect(await contract.pendingOwner()).to.equal(C.ZERO_ADDRESS);
      }

      // The new timelock raises its own delay through itself: schedule, then execute.
      await sendPayloads(await runScript("scripts/lp-switch-timelock.js", switchEnv("raise-delay")), 1);
      await sendPayloads(await runScript("scripts/lp-switch-timelock.js", switchEnv("raise-delay")), 1);
      const next = await contractAt("LPTimelock", newTimelockAddr);
      expect(await next.getMinDelay()).to.equal(BigInt(FINAL_DELAY));
    });

    it("verifies the five owners and rewrites the registry entries", async function () {
      const run = await runScript("scripts/lp-switch-timelock.js", switchEnv("verify"));
      expect(run.stdout).to.include(`All five proxies are owned by ${newTimelockAddr}`);
      expect(run.stdout).to.not.include("FAIL");

      const entries = runner.readRegistry(registryFile)["31337"];
      expect(entries.TimelockController.address).to.equal(newTimelockAddr);
      expect(entries.TimelockController.minDelay).to.equal(FINAL_DELAY);
      expect(entries.TimelockControllerRetired.address).to.equal(timelockAddr);
      expect(entries).to.not.have.property("TimelockControllerNext");
      for (const kind of ["TokenOverture", "RewardsDistributor", "LPEpochRegistry", "LPStakingVault", "LPZapper"]) {
        expect(entries[kind].owner, kind).to.equal(newTimelockAddr);
      }

      // The old timelock lost the owner tier for good: an upgrade it executes would revert.
      const old = timelock.connect(w.multisig);
      const op = lpTimelock.buildOperation({
        target: vaultAddr,
        fn: "setOperator",
        args: [w.signer2.address],
        tag: "after-the-switch",
      });
      await chain.send(old.schedule(op.target, op.value, op.data, op.predecessor, op.salt, C.TIMELOCK_MIN_DELAY));
      await rpc.advance(provider, C.TIMELOCK_MIN_DELAY + 1);
      await chain.expectCustomError(
        provider,
        old.execute(op.target, op.value, op.data, op.predecessor, op.salt),
        vault.interface,
        "OwnableUnauthorizedAccount"
      );
      expect(await vault.operator()).to.equal(w.operator.address);
    });
  });

  // ── shared decoding map ────────────────────────────────────────────────

  function ifacesByAddress() {
    return {
      [vaultAddr.toLowerCase()]: vault.interface,
      [zapperAddr.toLowerCase()]: zapper.interface,
      [overtureAddr.toLowerCase()]: overture.interface,
      [distributorAddr.toLowerCase()]: distributor.interface,
      [registryAddr.toLowerCase()]: registry.interface,
      // The third reward token is an Overture-shaped proxy: the same ABI decodes it.
      ...(thirdTokenAddr ? { [thirdTokenAddr.toLowerCase()]: overture.interface } : {}),
      [timelockAddr.toLowerCase()]: timelock.interface,
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
    `could not read block ${blockNumber} from ${redact.redactRpc(url)}: ${redact.redactRpcText(lastError.message)}`
  );
}
