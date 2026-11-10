/**
 * Staking v3 on a Sepolia fork: the whole transition, end to end, against the REAL Uniswap V3
 * deployment on Sepolia (factory, position manager, SwapRouter02) and the team's two test tokens
 * (tREAL = $ASSET, tUSDC = USDC), at the profile's pinned block.
 *
 * The world: a fresh tREAL / tUSDC 0.30 % pool created on the real factory at 0.50 USDC per
 * $ASSET, a full-range seed position, an oracle grown and warmed past 1,800 s; the `LPTimelock`
 * and an `LPStakingVault` proxy it owns, running the PREVIOUS vault implementation (the verbatim
 * 746b22c copy `LPStakingVaultPreListenerMock`, no `bonusListener`); a SHORT-WINDOW sw2 test pool
 * (`WeightedStakingPool`, the v2 contract) funded with tUSDC. Then `scripts/deploy-staking-v3.js`
 * (in-process, its exported `deployStakingV3`) deploys the three v3 proxies and writes the timelock
 * batch — the three acceptOwnership calls, the two migrator links, the vault's `upgradeToAndCall`
 * to the current implementation, the listener, the stake operator — which the multisig schedules
 * and executes.
 *
 * The scenario, in order (each step one `it`, sharing the chain):
 *   1. three stakers stake in sw2, the window closes, each one `unstake()`s (principal + reward)
 *   2. route 3 (claim and restake) works while routes 1 and 2 are still paused; 1 reverts paused
 *   3. the operator unpauses; route 1 (compound) swaps on the real pool and stakes for alice
 *   4. a replayed voucher is rejected
 *   5. route 2 (join LP) mints on the real band, stakes the NFT in the vault for bob, refunds the
 *      USDC dust and stakes the remainder in v3
 *   6. bob re-ranges his position: the LP reservation moves to the new tokenId, scaled down, and
 *      the listener ran on the real pool's `observe`; its gas is recorded
 *   7. a reverting listener reverts bob's next re-range (fail closed since 2026-11-10): the vault
 *      and the reservation are untouched
 *   8. erin's re-range under a silent listener reproduces the pre-fix stranded record (Sepolia
 *      stack #6, 234214): the reservation stays under the burned id; frank joins LP too
 *   9. dave joins LP and unstakes before the unlock: his LP reservation is forfeited on the real
 *      pool; the listener's unstake gas is recorded
 *  10. george exits early while the listener reverts (fail open, `listenerMissedAt` before the
 *      unlock) and re-stakes the same NFT: the record is DEAD and `reconcileLp` forfeits it while
 *      re-staked; henry reaches the same state (kept for step 12); ivan joins LP
 *  11. a direct v3 stake with the backend's `StakeVoucher` (no weight): the replay is rejected;
 *      carol withdraws from v3 early: the principal back in full (no penalty in v3) and her whole
 *      v3 reservation forfeited
 *  12. after the end: an unfunded claim reverts, a funded one pays; bob unstakes his LP after the
 *      unlock (settled) and claims it; frank re-ranges after the unlock (settled under the old id)
 *      and claims it; henry's dead record is forfeited (not settled) by his after-unlock unstake;
 *      ivan's after-unlock unstake with the listener down is MISSED-AFTER: it pays and
 *      `reconcileLp` settles it; erin's stale record pays nothing and `reconcileLp` forfeits it; the v3 exit
 *      is `unstake` (the principal; the minimal pool pays no reward) and `emergencyUnstake`
 *
 * Skip vs fail: the fork phase may skip ONLY when no endpoint could be reached and none was
 * configured (SEPOLIA_RPC_URL / INFURA_API_KEY). Everything after the fork fails, never skips.
 * The tracked deployments.json is never written: the script runs against a scratch registry.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const C = require("../helpers/constants");
const profiles = require("../helpers/profiles");
const uni = require("../helpers/uniswap");
const { redactRpc, redactRpcText } = require("../helpers/redact");
const lpTimelock = require("../../../scripts/lp-timelock");

const P = profiles.resolveProfile();
const RUN = P.name === "sepolia" ? describe : describe.skip;

const FUNDER = "0xBb7403aAF82342A0d987A8603aAf881136B5D125";
const FEE = 3000;
const SPACING = 60;
const FULL_LOWER = -887220;
const FULL_UPPER = 887220;
const ASSET = (n) => ethers.parseUnits(String(n), 18);
const USDC = (n) => ethers.parseUnits(String(n), 6);
const FAR = 10n ** 12n;
const WEIGHT = 1500n; // sw2 (the v2 contract) only: the v3 pool has no weight
const PRINCIPAL = ASSET(20_000);
const SW2_REWARD = USDC(3_000);

const TRACKED_REGISTRY = path.join(__dirname, "..", "..", "..", "deployments.json");
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function candidates() {
  if (process.env.SEPOLIA_RPC_URL) return [process.env.SEPOLIA_RPC_URL];
  if (process.env.INFURA_API_KEY) return [`https://sepolia.infura.io/v3/${process.env.INFURA_API_KEY}`];
  return P.rpc.publicCandidates;
}

/** `deploy-staking-v3.js` against a scratch registry, never the tracked file (see DeployImplementation.test.js). */
function scriptWithRegistry(registryFile) {
  const modules = ["../../../scripts/lib/pools", "../../../scripts/lib/proxies", "../../../scripts/deploy-staking-v3"].map(
    (m) => require.resolve(m)
  );
  const previous = process.env.DEPLOYMENTS_FILE;
  process.env.DEPLOYMENTS_FILE = registryFile;
  try {
    for (const m of modules) delete require.cache[m];
    return require("../../../scripts/deploy-staking-v3");
  } finally {
    if (previous === undefined) delete process.env.DEPLOYMENTS_FILE;
    else process.env.DEPLOYMENTS_FILE = previous;
    for (const m of modules) delete require.cache[m];
  }
}

RUN("staking v3 transition on a Sepolia fork", function () {
  this.timeout(600_000);

  const registryBefore = sha256(TRACKED_REGISTRY);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "staking-v3-fork-"));
  let forked = false;
  let fees;

  let deployer, alice, bob, carol, multisig, guardian, backendSigner, dave, erin, frank, george, henry, ivan;
  let erinStaleId, frankTokenId, henryDeadId, ivanTokenId;
  let asset, usdc, pool, npm, router, timelock, vault, sw2;
  let poolV3, bonusVault, migrator;
  let assetIsToken0;
  const tokens = {};
  const notes = [];
  let vaultImplementations;
  const ERC1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const implementationOf = async (proxy) =>
    ethers.getAddress("0x" + (await ethers.provider.getStorage(proxy, ERC1967_IMPLEMENTATION_SLOT)).slice(-40));

  /** The gas `fn` costs when the LP vault itself sends it to the listener (impersonated, estimated). */
  async function listenerGas(build) {
    const vaultSigner = await impersonate(await vault.getAddress());
    const gas = await build(bonusVault.connect(vaultSigner));
    await rpc("hardhat_stopImpersonatingAccount", [await vault.getAddress()]);
    return gas;
  }

  const rpc = (method, params = []) => network.provider.request({ method, params });
  const advance = async (seconds) => {
    await rpc("evm_increaseTime", [seconds]);
    await rpc("evm_mine", []);
  };
  const now = async () => (await ethers.provider.getBlock("latest")).timestamp;

  function pin(signer) {
    if (signer.__pinned) return signer;
    const send = signer.sendTransaction.bind(signer);
    signer.sendTransaction = (tx) => send({ maxFeePerGas: fees.max, maxPriorityFeePerGas: fees.tip, ...tx });
    signer.__pinned = true;
    return signer;
  }

  async function impersonate(address) {
    await rpc("hardhat_impersonateAccount", [address]);
    await rpc("hardhat_setBalance", [address, "0x21e19e0c9bab2400000"]);
    return pin(await ethers.getSigner(address));
  }

  async function swap(signer, tokenIn, tokenOut, amountIn) {
    return uni.swapExactIn({ router, signer, tokenIn, tokenOut, fee: FEE, amountIn });
  }

  /** sw2's v2 `Stake` voucher, signed by the backend key. */
  async function signSw2Stake(user, amount) {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    return backendSigner.signTypedData(
      { name: "WeightedStakingPool", version: "1", chainId, verifyingContract: await sw2.getAddress() },
      {
        Stake: [
          { name: "user", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "weight", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      { user: user.address, amount, weight: WEIGHT, nonce: await sw2.nonces(user.address), deadline: FAR }
    );
  }

  /** The backend's `TransitionVoucher` for `user`, as the migrator's `Voucher` struct. */
  async function voucher(user, route, principal, reward, nonce) {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const signature = await backendSigner.signTypedData(
      { name: "StakingMigrator", version: "1", chainId, verifyingContract: await migrator.getAddress() },
      {
        TransitionVoucher: [
          { name: "user", type: "address" },
          { name: "route", type: "uint8" },
          { name: "eligiblePrincipal", type: "uint256" },
          { name: "eligibleReward", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      { user: user.address, route, eligiblePrincipal: principal, eligibleReward: reward, nonce, deadline: FAR }
    );
    return { route, eligiblePrincipal: principal, eligibleReward: reward, nonce, deadline: FAR, signature };
  }

  /** The backend's `StakeVoucher` for a direct v3 `stake` (no amount, no weight). */
  async function signStakeVoucher(user, nonce, deadline = FAR) {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    return backendSigner.signTypedData(
      { name: "WeightedStakingPool", version: "1", chainId, verifyingContract: await poolV3.getAddress() },
      {
        StakeVoucher: [
          { name: "user", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      { user: user.address, nonce, deadline }
    );
  }

  const NO_PERMIT = { value: 0n, deadline: 0n, v: 0, r: ethers.ZeroHash, s: ethers.ZeroHash };

  before(async function () {
    // ── Phase 1: the fork. The only place a skip is legal. ──
    const configured = Boolean(process.env.SEPOLIA_RPC_URL || process.env.INFURA_API_KEY);
    const failures = [];
    for (const url of candidates()) {
      try {
        await rpc("hardhat_reset", [{ forking: { jsonRpcUrl: url, blockNumber: P.pinnedBlock } }]);
        const probe = new ethers.Contract(P.asset.address, C.ERC20_ABI, ethers.provider);
        expect(await probe.decimals()).to.equal(18n);
        forked = true;
        break;
      } catch (error) {
        failures.push(`${redactRpc(url)}: ${redactRpcText(error.shortMessage || error.message)}`);
      }
    }
    if (!forked) {
      await rpc("hardhat_reset", []).catch(() => {});
      const detail = `no usable Sepolia archive RPC for block ${P.pinnedBlock}:\n    ${failures.join("\n    ")}`;
      if (configured) {
        throw new Error(`[staking-v3-fork] SEPOLIA_RPC_URL / INFURA_API_KEY is set, so this suite must run — ${detail}`);
      }
      console.warn(`\n  [staking-v3-fork] skipping — ${detail}\n`);
      this.skip();
      return;
    }

    // ── Phase 2: the world. No catch below. ──
    const base = (await ethers.provider.getBlock("latest")).baseFeePerGas;
    const max = base * 100n > ethers.parseUnits("10", "gwei") ? base * 100n : ethers.parseUnits("10", "gwei");
    fees = { max, tip: ethers.parseUnits("1", "gwei") };
    [deployer, alice, bob, carol, multisig, guardian, backendSigner, dave, erin, frank, george, henry, ivan] = (
      await ethers.getSigners()
    ).map(pin);

    asset = new ethers.Contract(P.asset.address, C.ERC20_ABI, deployer);
    usdc = new ethers.Contract(P.usdc.address, C.ERC20_ABI, deployer);
    npm = new ethers.Contract(P.npm, C.NPM_ABI, deployer);
    router = new ethers.Contract(P.router, C.ROUTER_ABI, deployer);
    ({ assetIsToken0 } = uni.sortTokens(P.asset.address, P.usdc.address));
    tokens.token0 = assetIsToken0 ? P.asset.address : P.usdc.address;
    tokens.token1 = assetIsToken0 ? P.usdc.address : P.asset.address;

    // Funding: real transfers from the holder of both supplies.
    const funder = await impersonate(FUNDER);
    await (await asset.connect(funder).transfer(deployer.address, ASSET(3_000_000))).wait();
    await (await usdc.connect(funder).transfer(deployer.address, USDC(1_000_000))).wait();
    for (const user of [alice, bob, carol, dave, erin, frank, george, henry, ivan]) {
      await (await asset.connect(funder).transfer(user.address, PRINCIPAL)).wait();
    }
    for (const user of [deployer, alice, bob, carol]) {
      for (const token of [asset, usdc]) {
        await (await token.connect(user).approve(P.router, ethers.MaxUint256)).wait();
        await (await token.connect(user).approve(P.npm, ethers.MaxUint256)).wait();
      }
    }

    // The pool: created on the real factory at 0.50 USDC per $ASSET, seeded across the full range.
    const sqrtPrice = uni.initialSqrtPriceX96(assetIsToken0);
    await (await npm.createAndInitializePoolIfNecessary(tokens.token0, tokens.token1, FEE, sqrtPrice)).wait();
    const factory = new ethers.Contract(P.factory, C.FACTORY_ABI, ethers.provider);
    const poolAddress = await factory.getPool(tokens.token0, tokens.token1, FEE);
    pool = new ethers.Contract(poolAddress, C.POOL_ABI, deployer);
    await uni.mintPosition({
      npm,
      npmAddress: P.npm,
      signer: deployer,
      token0: tokens.token0,
      token1: tokens.token1,
      fee: FEE,
      tickLower: FULL_LOWER,
      tickUpper: FULL_UPPER,
      assetIsToken0,
      assetAmount: ASSET(1_000_000),
      usdcAmount: USDC(500_000),
    });

    // The oracle: 400 slots, then more than 1,800 s of history written by real round trips.
    await (await pool.increaseObservationCardinalityNext(400)).wait();
    for (let i = 0; i < 8; i++) {
      await advance(300);
      await swap(deployer, P.usdc.address, P.asset.address, USDC(500));
      await swap(deployer, P.asset.address, P.usdc.address, ASSET(1_000));
    }
    expect((await pool.slot0()).observationCardinality).to.equal(400n);

    // The LP stack's owner and vault. The proxy runs the PREVIOUS implementation (746b22c, no
    // listener); the batch upgrades it to the current one, exactly like the live stacks.
    const Timelock = await ethers.getContractFactory("LPTimelock", deployer);
    timelock = await Timelock.deploy(60, [multisig.address], [multisig.address], ethers.ZeroAddress);
    await timelock.waitForDeployment();
    const OldVault = await ethers.getContractFactory("LPStakingVaultPreListenerMock", deployer);
    const vaultImpl = await OldVault.deploy(P.npm, poolAddress, tokens.token0, tokens.token1, FEE, P.router);
    await vaultImpl.waitForDeployment();
    const Vault = await ethers.getContractFactory("LPStakingVault", deployer);
    const newVaultImpl = await Vault.deploy(P.npm, poolAddress, tokens.token0, tokens.token1, FEE, P.router);
    await newVaultImpl.waitForDeployment();
    vaultImplementations = { old: await vaultImpl.getAddress(), current: await newVaultImpl.getAddress() };
    const Proxy = await ethers.getContractFactory("LPProxy", deployer);
    const init = OldVault.interface.encodeFunctionData("initialize", [
      await timelock.getAddress(),
      guardian.address,
      multisig.address,
      ethers.ZeroAddress,
      300,
      953,
    ]);
    const vaultProxy = await Proxy.deploy(await vaultImpl.getAddress(), init);
    await vaultProxy.waitForDeployment();
    vault = await ethers.getContractAt("LPStakingVault", await vaultProxy.getAddress(), deployer);

    // The sw2 test pool: the v2 contract, a one-hour window, funded with tUSDC.
    const start = BigInt(await now());
    const Sw2 = await ethers.getContractFactory("WeightedStakingPool", deployer);
    sw2 = await Sw2.deploy(P.asset.address, P.usdc.address, start, start + 3600n, backendSigner.address);
    await sw2.waitForDeployment();
    await (await usdc.approve(await sw2.getAddress(), SW2_REWARD)).wait();
    await (await sw2.addRewards(SW2_REWARD)).wait();
  });

  after(async function () {
    for (const note of notes) console.log(`  [staking-v3-fork] ${note}`);
    if (forked) await rpc("hardhat_reset", []);
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("deploys the three v3 proxies with the script; the timelock batch upgrades the live vault and links them", async function () {
    const script = scriptWithRegistry(path.join(scratch, "deployments.json"));
    const start = BigInt(await now());
    const config = {
      activationEpoch: Number(start + 3600n),
      endEpoch: Number(start + 3600n + 30n * 86400n),
      stakeSigner: backendSigner.address,
      migratorSigner: backendSigner.address,
      asset: P.asset.address,
      usdc: P.usdc.address,
      lpVault: await vault.getAddress(),
      timelock: await timelock.getAddress(),
      twapWindow: 300,
      maxDeviationTicks: 953,
      valuationWindow: 1800,
      maxTotalReservedTokens: 100000n,
      vaultImplementation: vaultImplementations.current,
    };
    const vaultAddress = await vault.getAddress();
    expect(await implementationOf(vaultAddress)).to.equal(vaultImplementations.old);
    await expect(vault.bonusListener()).to.be.reverted; // the previous implementation has none

    const batchFile = path.join(scratch, "batch.json");
    const result = await script.deployStakingV3({ config, deployer, batchFile });
    expect(result.batch.calls.map((c) => c.fn)).to.deep.equal([
      "acceptOwnership",
      "acceptOwnership",
      "acceptOwnership",
      "setMigrator",
      "setMigrator",
      "upgradeToAndCall",
      "setBonusListener",
      "setStakeOperator",
    ]);
    expect(result.batch.calls.map((c) => c.target)).to.deep.equal([
      result.addresses.pool,
      result.addresses.bonusVault,
      result.addresses.migrator,
      result.addresses.pool,
      result.addresses.bonusVault,
      vaultAddress,
      vaultAddress,
      vaultAddress,
    ]);
    expect(JSON.parse(fs.readFileSync(batchFile, "utf8"))).to.have.length(8);
    expect(result.batch.calls[5].args[1]).to.equal(vault.interface.encodeFunctionData("initializeV2", []));

    const recorded = JSON.parse(fs.readFileSync(path.join(scratch, "deployments.json"), "utf8"));
    const chainKey = String((await ethers.provider.getNetwork()).chainId);
    expect(Object.keys(recorded[chainKey])).to.include.members(["WeightedStakingPoolV3", "V3BonusVault", "StakingMigrator"]);

    poolV3 = await ethers.getContractAt("WeightedStakingPoolV3", result.addresses.pool);
    bonusVault = await ethers.getContractAt("V3BonusVault", result.addresses.bonusVault);
    migrator = await ethers.getContractAt("StakingMigrator", result.addresses.migrator);
    expect(await poolV3.pendingOwner()).to.equal(await timelock.getAddress());
    // Before the batch no route can work: neither migrator link is set (M1).
    expect(await poolV3.migrator()).to.equal(ethers.ZeroAddress);
    expect(await bonusVault.migrator()).to.equal(ethers.ZeroAddress);
    expect(await poolV3.bonusVault()).to.equal(result.addresses.bonusVault);
    expect(await poolV3.signer()).to.equal(backendSigner.address);
    expect(await poolV3.stakingToken()).to.equal(P.asset.address);
    expect(await bonusVault.maxTotalReserved()).to.equal(ASSET(100_000));

    const batch = result.batch;
    await (await timelock.connect(multisig).getFunction("scheduleBatch")(
      batch.targets, batch.values, batch.payloads, batch.predecessor, batch.salt, 60
    )).wait();
    await advance(61);
    await (await timelock.connect(multisig).getFunction("executeBatch")(
      batch.targets, batch.values, batch.payloads, batch.predecessor, batch.salt
    )).wait();

    for (const c of [poolV3, bonusVault, migrator]) expect(await c.owner()).to.equal(await timelock.getAddress());
    expect(await implementationOf(vaultAddress)).to.equal(vaultImplementations.current, "upgraded in the batch");
    expect(await vault.owner()).to.equal(await timelock.getAddress(), "the vault's state survived the upgrade");
    expect(await vault.operator()).to.equal(multisig.address);
    expect(await vault.bonusListener()).to.equal(result.addresses.bonusVault);
    // The upgrade carried initializeV2(): the Glamsterdam gas defaults are stored, not just served.
    expect(await vault.bonusHookGas()).to.equal(400_000n);
    expect(await vault.bonusListenerGas()).to.equal(1_000_000n);
    await expect(vault.connect(multisig).initializeV2()).to.be.reverted; // runs once
    expect(await vault.isStakeOperator(result.addresses.migrator)).to.equal(true);
    expect(await poolV3.migrator()).to.equal(result.addresses.migrator);
    expect(await poolV3.bonusVault()).to.equal(result.addresses.bonusVault);
    expect(await bonusVault.migrator()).to.equal(result.addresses.migrator);
    expect(await migrator.compoundPaused()).to.equal(true);

    // A second run of the batch builder finds nothing left to do.
    const again = await script.timelockOps({
      addresses: result.addresses,
      lpVault: config.lpVault,
      timelock: config.timelock,
      vaultImplementation: null,
    });
    expect(again).to.have.length(0);

    // A resumed run reuses the three recorded proxies instead of deploying them again (L7).
    const chainNumber = Number((await ethers.provider.getNetwork()).chainId);
    const rerun = await script.deployContracts({ chainId: chainNumber, deployer, config });
    expect(rerun.pool.address).to.equal(result.addresses.pool);
    expect(rerun.bonusVault.address).to.equal(result.addresses.bonusVault);
    expect(rerun.migrator.address).to.equal(result.addresses.migrator);
    expect(rerun.pool.recorded && rerun.bonusVault.recorded && rerun.migrator.recorded).to.equal(true);
    expect(lpTimelock.OWNER_TIER.setBonusListener.kinds).to.deep.equal(["LPStakingVault"]);
  });

  it("setBonusListener refuses a listener bound to another vault; zero and the bonus vault pass", async function () {
    // A code-only listener whose `vault()` (every call) returns carol's address.
    const elsewhere = ethers.getAddress("0x" + "5e".repeat(20));
    const code = "0x73" + carol.address.slice(2).toLowerCase() + "60005260206000f3";
    await rpc("hardhat_setCode", [elsewhere, code]);
    const owner = await impersonate(await timelock.getAddress());
    expect(await bonusVault.totalLpReserved()).to.equal(0n);
    await expect(vault.connect(owner).setBonusListener(elsewhere))
      .to.be.revertedWithCustomError(vault, "ListenerVaultMismatch")
      .withArgs(elsewhere, carol.address);
    expect(await bonusVault.vault()).to.equal(await vault.getAddress(), "the deploy bound it before the batch");
    await (await vault.connect(owner).setBonusListener(ethers.ZeroAddress)).wait();
    await (await vault.connect(owner).setBonusListener(await bonusVault.getAddress())).wait();
    expect(await vault.bonusListener()).to.equal(await bonusVault.getAddress());
    await rpc("hardhat_stopImpersonatingAccount", [await timelock.getAddress()]);
  });

  it("sw2: three stakers stake, the window closes, each unstakes principal + USDC reward", async function () {
    for (const user of [alice, bob, carol]) {
      await (await asset.connect(user).approve(await sw2.getAddress(), PRINCIPAL)).wait();
      const sig = await signSw2Stake(user, PRINCIPAL);
      await (await sw2.connect(user).stake(PRINCIPAL, WEIGHT, FAR, sig)).wait();
    }
    await advance(3601);
    for (const user of [alice, bob, carol]) {
      await (await sw2.connect(user).unstake()).wait();
      expect(await asset.balanceOf(user.address)).to.equal(PRINCIPAL);
      expect(await usdc.balanceOf(user.address)).to.be.closeTo(USDC(1_000), USDC(5));
      await (await asset.connect(user).approve(await migrator.getAddress(), ethers.MaxUint256)).wait();
      await (await usdc.connect(user).approve(await migrator.getAddress(), ethers.MaxUint256)).wait();
    }
  });

  it("route 3 works while routes 1 and 2 are paused, and route 1 reverts paused", async function () {
    const carolUsdc = await usdc.balanceOf(carol.address);
    const v3 = await voucher(carol, 3, PRINCIPAL, carolUsdc, 1n);
    await (await migrator.connect(carol).claimRestake(PRINCIPAL, FAR, NO_PERMIT, v3)).wait();
    expect((await poolV3.stakes(carol.address))).to.equal(PRINCIPAL);
    expect((await bonusVault.reservedOf(carol.address))[0]).to.equal((PRINCIPAL * 500n) / 10_000n);
    expect(await usdc.balanceOf(carol.address)).to.equal(carolUsdc, "the USDC stays in the wallet");

    const aliceUsdc = await usdc.balanceOf(alice.address);
    const v1 = await voucher(alice, 1, PRINCIPAL, aliceUsdc, 1n);
    await expect(
      migrator.connect(alice).compound(aliceUsdc, PRINCIPAL, 0, FAR, NO_PERMIT, NO_PERMIT, v1)
    ).to.be.revertedWithCustomError(migrator, "CompoundIsPaused");
  });

  it("route 1: the operator unpauses, alice compounds through the real pool", async function () {
    await expect(migrator.connect(guardian).unpauseCompound()).to.be.revertedWithCustomError(migrator, "NotOperator");
    await (await migrator.connect(multisig).unpauseCompound()).wait();

    const aliceUsdc = await usdc.balanceOf(alice.address);
    const v1 = await voucher(alice, 1, PRINCIPAL, aliceUsdc, 1n);
    // ~2,000 $ASSET at 0.50; a 3 % floor below the quote is the caller's slippage guard.
    const minOut = (ASSET(2_000) * 97n) / 100n;
    const tx = await migrator.connect(alice).compound(aliceUsdc, PRINCIPAL, minOut, FAR, NO_PERMIT, NO_PERMIT, v1);
    const receipt = await tx.wait();
    const event = receipt.logs.map((l) => { try { return migrator.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "Compounded");
    const staked = event.args.staked;
    expect(event.args.assetBought).to.be.greaterThan(minOut);
    expect(staked).to.equal(PRINCIPAL + event.args.assetBought);
    expect(await poolV3.stakes(alice.address)).to.equal(staked);
    // The bonus base is the principal + the bought part at most at its TWAP value (L2).
    const atTwap = await migrator.usdcInAsset(aliceUsdc);
    const bought = event.args.assetBought;
    const expectedBonus = ((PRINCIPAL + (bought < atTwap ? bought : atTwap)) * 1000n) / 10_000n;
    expect(event.args.bonus).to.be.closeTo(expectedBonus, expectedBonus / 10_000n);
    expect(event.args.bonus).to.be.lessThanOrEqual((staked * 1000n) / 10_000n);
    expect((await bonusVault.reservedOf(alice.address))[0]).to.equal(event.args.bonus);
    expect(await usdc.balanceOf(alice.address)).to.equal(0n);
    notes.push(`route 1: ${ethers.formatUnits(aliceUsdc, 6)} tUSDC bought ${ethers.formatUnits(event.args.assetBought, 18)} tREAL`);
  });

  it("a replayed voucher is rejected, and a fresh one for a wallet that already moved", async function () {
    const v1 = await voucher(alice, 1, PRINCIPAL, USDC(1_000), 1n);
    await expect(
      migrator.connect(alice).compound(1n, 0n, 1n, FAR, NO_PERMIT, NO_PERMIT, v1)
    ).to.be.revertedWithCustomError(migrator, "VoucherNonceUsed");
    const fresh = await voucher(alice, 3, PRINCIPAL, 0n, 2n);
    await expect(migrator.connect(alice).claimRestake(1n, FAR, NO_PERMIT, fresh))
      .to.be.revertedWithCustomError(migrator, "AlreadyMigrated")
      .withArgs(alice.address);
    expect(await migrator.migrated(alice.address)).to.equal(true);
  });

  let bobTokenId;
  it("route 2: bob joins LP on the real band, the NFT is staked for him, the rest goes to v3", async function () {
    const bobUsdc = await usdc.balanceOf(bob.address);
    const v2 = await voucher(bob, 2, PRINCIPAL, bobUsdc, 1n);
    const [lower, upper] = await migrator.lpRange();
    const tick = Number((await pool.slot0()).tick);
    expect(Number(lower) % SPACING).to.equal(0);
    expect(Number(lower)).to.be.lessThanOrEqual(tick - 6932);
    expect(Number(upper)).to.be.greaterThanOrEqual(tick + 6932);

    const receipt = await (await migrator.connect(bob).moveToLp(bobUsdc, PRINCIPAL, 0, 0, FAR, NO_PERMIT, NO_PERMIT, v2)).wait();
    const event = receipt.logs.map((l) => { try { return migrator.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "MovedToLp");
    bobTokenId = event.args.tokenId;
    expect(await vault.stakerOf(bobTokenId)).to.equal(bob.address);
    const position = await npm.positions(bobTokenId);
    expect(position.tickLower).to.equal(lower);
    expect(position.tickUpper).to.equal(upper);

    const refunded = await usdc.balanceOf(bob.address);
    expect(event.args.usdcIn + refunded).to.equal(bobUsdc, "every USDC wei is in the LP or back in the wallet");
    expect(event.args.assetToLp + event.args.restaked).to.equal(PRINCIPAL, "every $ASSET wei is in the LP or in v3");
    expect((await poolV3.stakes(bob.address))).to.equal(event.args.restaked);
    const lpRes = await bonusVault.lpReservation(bobTokenId);
    expect(lpRes.user).to.equal(bob.address);
    expect(lpRes.amount).to.equal(event.args.lpBonus);
    const expected = ((event.args.assetToLp + (await migrator.usdcInAsset(event.args.usdcIn))) * 1000n) / 10_000n;
    expect(lpRes.amount).to.equal(expected);
    notes.push(`route 2: LP ${ethers.formatUnits(event.args.assetToLp, 18)} tREAL + ${ethers.formatUnits(event.args.usdcIn, 6)} tUSDC, v3 ${ethers.formatUnits(event.args.restaked, 18)} tREAL, refund ${ethers.formatUnits(refunded, 6)} tUSDC`);
  });

  /** Runs `fn` with `code` under the bonus vault's address (its storage untouched), then restores it. */
  async function withListenerCode(code, fn) {
    const address = await bonusVault.getAddress();
    const saved = await ethers.provider.getCode(address);
    await rpc("hardhat_setCode", [address, code]);
    try {
      return await fn();
    } finally {
      await rpc("hardhat_setCode", [address, saved]);
    }
  }
  const REVERT_ALL = "0x60006000fd"; // PUSH1 0 PUSH1 0 REVERT: every call reverts, empty data
  const ACCEPT_ALL = "0x00"; // STOP: every call succeeds and does nothing (the pre-fix swallowed failure)
  const NO_SWAP = { zeroForOne: true, amountIn: 0n, amountOutMin: 0n, amount0Min: 0n, amount1Min: 0n };

  /** Route 2 for a fresh wallet with 1,000 tUSDC; returns the staked tokenId. */
  async function joinLp(user) {
    await (await usdc.transfer(user.address, USDC(1_000))).wait();
    await (await asset.connect(user).approve(await migrator.getAddress(), ethers.MaxUint256)).wait();
    await (await usdc.connect(user).approve(await migrator.getAddress(), ethers.MaxUint256)).wait();
    const v2 = await voucher(user, 2, PRINCIPAL, USDC(1_000), 1n);
    const joined = await (await migrator.connect(user).moveToLp(USDC(1_000), PRINCIPAL, 0, 0, FAR, NO_PERMIT, NO_PERMIT, v2)).wait();
    return joined.logs.map((l) => { try { return migrator.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "MovedToLp").args.tokenId;
  }

  it("bob re-ranges: the LP reservation moves to the new tokenId, scaled down, and the listener did not fail", async function () {
    const before = (await bonusVault.lpReservation(bobTokenId)).amount;
    const tick = Number((await pool.slot0()).tick);
    const newLower = Math.ceil((tick + 120) / SPACING) * SPACING; // the band above the price: $ASSET only
    const newUpper = newLower + 60 * SPACING;
    const noSwap = { zeroForOne: true, amountIn: 0n, amountOutMin: 0n, amount0Min: 0n, amount1Min: 0n };
    expect(assetIsToken0, "tREAL sorts below tUSDC on Sepolia").to.equal(true);

    // The listener's own cost on the real pool (its `previewTwap` -> `observe`), as the vault
    // would send it: old = the live position, new = the same band at half the liquidity.
    const live = await npm.positions(bobTokenId);
    const snap = (liquidity) => ({ tickLower: live.tickLower, tickUpper: live.tickUpper, liquidity });
    const hookGas = await listenerGas((b) =>
      b.onRebalance.estimateGas(bobTokenId, 2n ** 64n, snap(live.liquidity), snap(live.liquidity / 2n))
    );
    // Fail closed since 2026-11-10 (all remaining gas): the 1,000,000 figure is a cost guard only.
    expect(hookGas).to.be.lessThan(await vault.bonusListenerGas());

    const tx = await vault.connect(bob).rebalance(bobTokenId, newLower, newUpper, noSwap, FAR);
    const receipt = await tx.wait();
    const parsed = receipt.logs.map((l) => { try { return vault.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
    expect(parsed.find((e) => e.name === "BonusListenerFailed")).to.equal(undefined);
    const newId = parsed.find((e) => e.name === "Rebalanced").args.newTokenId;

    expect((await bonusVault.lpReservation(bobTokenId)).user).to.equal(ethers.ZeroAddress);
    const moved = await bonusVault.lpReservation(newId);
    expect(moved.user).to.equal(bob.address);
    expect(moved.amount).to.be.lessThan(before);
    expect(moved.amount).to.be.greaterThan(0n);
    expect((await bonusVault.lpTokensOf(bob.address))[0]).to.equal(newId);
    expect(await bonusVault.lpSettled(newId)).to.equal(false);
    bobTokenId = newId;
    notes.push(
      `rebalance: LP bonus ${ethers.formatUnits(before, 18)} -> ${ethers.formatUnits(moved.amount, 18)} tREAL, ` +
        `tx gas ${receipt.gasUsed}, listener onRebalance ${hookGas} gas (eth_estimateGas from the vault, incl. ` +
        `the 21,000 intrinsic; fail closed, no allowance)`
    );
  });

  it("a reverting listener reverts bob's next re-range (fail closed): vault and reservation untouched", async function () {
    const before = await bonusVault.lpReservation(bobTokenId);
    const totalBefore = await bonusVault.totalReserved();
    const live = await npm.positions(bobTokenId);
    await withListenerCode(REVERT_ALL, async () => {
      await expect(
        vault.connect(bob).rebalance(bobTokenId, live.tickLower - 60n, live.tickUpper + 60n, NO_SWAP, FAR)
      ).to.be.reverted;
    });
    expect(await vault.stakerOf(bobTokenId)).to.equal(bob.address);
    expect(await npm.ownerOf(bobTokenId)).to.equal(await vault.getAddress());
    const after = await bonusVault.lpReservation(bobTokenId);
    expect(after.user).to.equal(before.user);
    expect(after.amount).to.equal(before.amount);
    expect(after.forfeited).to.equal(false);
    expect(await bonusVault.totalReserved()).to.equal(totalBefore);
  });

  it("erin's re-range under a silent listener strands her record under the burned id (the pre-fix state)", async function () {
    erinStaleId = await joinLp(erin);
    frankTokenId = await joinLp(frank);
    const owed = (await bonusVault.lpReservation(erinStaleId)).amount;
    expect(owed).to.be.greaterThan(0n);
    const live = await npm.positions(erinStaleId);
    const newId = await withListenerCode(ACCEPT_ALL, async () => {
      const receipt = await (await vault.connect(erin).rebalance(
        erinStaleId, live.tickLower + 60n, live.tickUpper - 60n, NO_SWAP, FAR
      )).wait();
      return receipt.logs.map((l) => { try { return vault.interface.parseLog(l); } catch { return null; } })
        .find((e) => e && e.name === "Rebalanced").args.newTokenId;
    });
    const stale = await bonusVault.lpReservation(erinStaleId);
    expect(stale.user).to.equal(erin.address, "the record stayed under the burned id");
    expect(stale.amount).to.equal(owed);
    expect(await vault.stakerOf(erinStaleId)).to.equal(ethers.ZeroAddress);
    expect(await vault.stakerOf(newId)).to.equal(erin.address);
    expect((await bonusVault.lpReservation(newId)).user).to.equal(ethers.ZeroAddress);
  });

  it("dave joins LP and unstakes before the unlock: the LP reservation is forfeited on the real pool", async function () {
    await (await usdc.transfer(dave.address, USDC(1_000))).wait();
    await (await asset.connect(dave).approve(await migrator.getAddress(), ethers.MaxUint256)).wait();
    await (await usdc.connect(dave).approve(await migrator.getAddress(), ethers.MaxUint256)).wait();
    const v2 = await voucher(dave, 2, PRINCIPAL, USDC(1_000), 1n);
    const joined = await (await migrator.connect(dave).moveToLp(USDC(1_000), PRINCIPAL, 0, 0, FAR, NO_PERMIT, NO_PERMIT, v2)).wait();
    const moved = joined.logs.map((l) => { try { return migrator.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "MovedToLp");
    const tokenId = moved.args.tokenId;
    const owed = (await bonusVault.lpReservation(tokenId)).amount;
    expect(owed).to.be.greaterThan(0n);
    const lpBefore = await bonusVault.totalLpReserved();
    const totalBefore = await bonusVault.totalReserved();

    const hookGas = await listenerGas((b) => b.onUnstake.estimateGas(tokenId));
    const receipt = await (await vault.connect(dave).unstake(tokenId)).wait();
    const parsed = receipt.logs.map((l) => { try { return vault.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
    expect(parsed.find((e) => e.name === "BonusListenerFailed")).to.equal(undefined);

    const res = await bonusVault.lpReservation(tokenId);
    expect(res.forfeited).to.equal(true);
    expect(res.amount).to.equal(0n);
    expect(await bonusVault.totalLpReserved()).to.equal(lpBefore - owed);
    expect(await bonusVault.totalReserved()).to.equal(totalBefore - owed);
    expect(await npm.ownerOf(tokenId)).to.equal(dave.address);
    // reconcileLp on an already forfeited reservation is a no-op (no second forfeiture event).
    const reconciled = await (await bonusVault.reconcileLp(tokenId)).wait();
    expect(reconciled.logs).to.have.length(0);
    expect(await bonusVault.totalLpReserved()).to.equal(lpBefore - owed);
    notes.push(
      `LP unstake before the unlock: ${ethers.formatUnits(owed, 18)} tREAL forfeited, tx gas ${receipt.gasUsed}, ` +
        `listener onUnstake ${hookGas} gas (eth_estimateGas from the vault, incl. the 21,000 intrinsic)`
    );
  });

  /** `user` unstakes `tokenId` with every listener call reverting: fail open, `listenerMissedAt` written. */
  async function unstakeWithListenerDown(user, tokenId) {
    return withListenerCode(REVERT_ALL, async () => {
      const receipt = await (await vault.connect(user).unstake(tokenId)).wait();
      const parsed = receipt.logs.map((l) => { try { return vault.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
      const failed = parsed.find((e) => e.name === "BonusListenerFailed");
      expect(failed.args.tokenId).to.equal(tokenId);
      return receipt;
    });
  }

  async function restake(user, tokenId) {
    await (await npm.connect(user).approve(await vault.getAddress(), tokenId)).wait();
    await (await vault.connect(user).stake(tokenId)).wait();
    expect(await vault.stakerOf(tokenId)).to.equal(user.address);
  }

  it("george exits early with a failing listener and re-stakes the NFT: the record is dead, reconcileLp forfeits it", async function () {
    const tokenId = await joinLp(george);
    const res = await bonusVault.lpReservation(tokenId);
    await unstakeWithListenerDown(george, tokenId);
    const missedAt = await vault.listenerMissedAt(tokenId);
    expect(missedAt).to.be.greaterThan(0n);
    expect(missedAt).to.be.lessThan(res.unlockAt, "missed before the unlock");
    await restake(george, tokenId);
    await expect(bonusVault.connect(carol).reconcileLp(tokenId))
      .to.emit(bonusVault, "LpBonusForfeited")
      .withArgs(tokenId, george.address, res.amount);
    expect(await vault.stakerOf(tokenId)).to.equal(george.address, "forfeited while re-staked");

    // henry: the same dead state, kept until after the unlock; ivan: a healthy LP position.
    henryDeadId = await joinLp(henry);
    await unstakeWithListenerDown(henry, henryDeadId);
    await restake(henry, henryDeadId);
    ivanTokenId = await joinLp(ivan);
  });

  it("a direct v3 stake carries the backend's StakeVoucher; a replay and another wallet's voucher fail", async function () {
    const amount = ASSET(500);
    await (await asset.connect(deployer).approve(await poolV3.getAddress(), ethers.MaxUint256)).wait();
    const totalBefore = await poolV3.totalStaked();
    expect(await poolV3.nonces(deployer.address)).to.equal(0n);
    const sig = await signStakeVoucher(deployer, 0n);
    await expect(poolV3.connect(deployer).stake(amount, FAR, sig))
      .to.emit(poolV3, "Staked")
      .withArgs(deployer.address, amount)
      .and.to.emit(poolV3, "NonceUsed")
      .withArgs(deployer.address, 0n);
    expect(await poolV3.stakes(deployer.address)).to.equal(amount);
    expect(await poolV3.totalStaked()).to.equal(totalBefore + amount);
    expect(await poolV3.nonces(deployer.address)).to.equal(1n);
    await expect(poolV3.connect(deployer).stake(amount, FAR, sig)).to.be.revertedWith("Invalid signature");
    const carolSig = await signStakeVoucher(carol, 0n);
    await expect(poolV3.connect(deployer).stake(amount, FAR, carolSig)).to.be.revertedWith("Invalid signature");
    const past = BigInt(await now()) - 1n;
    const expired = await signStakeVoucher(deployer, 1n, past);
    await expect(poolV3.connect(deployer).stake(amount, past, expired)).to.be.revertedWith("Signature expired");
  });

  it("carol withdraws from v3 before the end: the principal in full, her whole v3 reservation forfeited", async function () {
    // v2's penalty receiver: v3 has no principal penalty (decision of 2026-11-10) and never pays it.
    const V2_PENALTY_RECEIVER = "0xD6719Ce10F1b499Bd8FE022AB045b991b996dA6a";
    const owed = (await bonusVault.reservedOf(carol.address))[0];
    expect(owed).to.be.greaterThan(0n);
    const carolBefore = await asset.balanceOf(carol.address);
    const receiverBefore = await asset.balanceOf(V2_PENALTY_RECEIVER);
    const stakedBefore = await poolV3.stakes(carol.address);
    const tx = poolV3.connect(carol).withdraw(ASSET(1));
    await expect(tx).to.emit(bonusVault, "BonusForfeited").withArgs(carol.address, owed);
    const receipt = await (await tx).wait();
    const withdrawn = receipt.logs
      .map((l) => { try { return poolV3.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "Withdrawn");
    expect(withdrawn.args.user).to.equal(carol.address);
    expect(withdrawn.args.amount).to.equal(ASSET(1));
    expect((await asset.balanceOf(carol.address)) - carolBefore).to.equal(ASSET(1), "the principal in full");
    expect(await asset.balanceOf(V2_PENALTY_RECEIVER)).to.equal(receiverBefore, "nothing to a penalty receiver");
    expect(await poolV3.stakes(carol.address)).to.equal(stakedBefore - ASSET(1));
    expect((await bonusVault.reservedOf(carol.address))[0]).to.equal(0n);
  });

  it("after the end: unfunded claims revert, funded ones pay; settled LP records pay, a stale one does not", async function () {
    await expect(bonusVault.connect(alice).claim()).to.be.revertedWithCustomError(bonusVault, "NothingToClaim");
    await advance(3600 + 30 * 86400 + 10);

    const aliceDue = await bonusVault.claimable(alice.address);
    await expect(bonusVault.connect(alice).claim())
      .to.be.revertedWithCustomError(bonusVault, "InsufficientFunds")
      .withArgs(aliceDue, 0n);

    // bob unstakes after the unlock: settled, it pays without the vault.
    await expect(vault.connect(bob).unstake(bobTokenId))
      .to.emit(bonusVault, "LpBonusSettled")
      .withArgs(bobTokenId, bob.address);
    expect(await bonusVault.lpSettled(bobTokenId)).to.equal(true);
    const bobDue = await bonusVault.claimable(bob.address);
    const lpPart = (await bonusVault.lpReservation(bobTokenId)).amount;
    expect(bobDue).to.equal((await bonusVault.reservedOf(bob.address))[0] + lpPart);

    // frank re-ranges after the unlock: settled under the OLD id, unscaled.
    const frankLp = (await bonusVault.lpReservation(frankTokenId)).amount;
    const fl = await npm.positions(frankTokenId);
    await expect(vault.connect(frank).rebalance(frankTokenId, fl.tickLower + 60n, fl.tickUpper - 60n, NO_SWAP, FAR))
      .to.emit(bonusVault, "LpBonusSettled")
      .withArgs(frankTokenId, frank.address);
    const frankRes = await bonusVault.lpReservation(frankTokenId);
    expect(frankRes.user).to.equal(frank.address);
    expect(frankRes.amount).to.equal(frankLp);
    const frankDue = await bonusVault.claimable(frank.address);
    expect(frankDue).to.equal((await bonusVault.reservedOf(frank.address))[0] + frankLp);

    // henry's dead record (early exit missed, NFT re-staked): an unstake after the unlock with a
    // WORKING listener forfeits it instead of settling it; only his v3 part pays.
    const henryLp = (await bonusVault.lpReservation(henryDeadId)).amount;
    expect(await bonusVault.claimable(henry.address)).to.equal((await bonusVault.reservedOf(henry.address))[0]);
    await expect(vault.connect(henry).unstake(henryDeadId))
      .to.emit(bonusVault, "LpBonusForfeited")
      .withArgs(henryDeadId, henry.address, henryLp);
    expect(await bonusVault.lpSettled(henryDeadId)).to.equal(false);
    const henryDue = await bonusVault.claimable(henry.address);
    expect(henryDue).to.equal((await bonusVault.reservedOf(henry.address))[0]);

    // ivan unstakes after the unlock while the listener is down: missed-after, it pays, and
    // reconcileLp settles it (explicit state), never forfeits it.
    const ivanRes = await bonusVault.lpReservation(ivanTokenId);
    await unstakeWithListenerDown(ivan, ivanTokenId);
    expect(await vault.listenerMissedAt(ivanTokenId)).to.be.at.least(ivanRes.unlockAt);
    const ivanDue = await bonusVault.claimable(ivan.address);
    expect(ivanDue).to.equal((await bonusVault.reservedOf(ivan.address))[0] + ivanRes.amount);
    await expect(bonusVault.connect(carol).reconcileLp(ivanTokenId))
      .to.emit(bonusVault, "LpBonusSettled")
      .withArgs(ivanTokenId, ivan.address);
    expect(await bonusVault.lpSettled(ivanTokenId)).to.equal(true);

    // erin's stale record (pre-fix strand): only her v3 part is claimable.
    const erinLp = (await bonusVault.lpReservation(erinStaleId)).amount;
    const erinDue = await bonusVault.claimable(erin.address);
    expect(erinDue).to.equal((await bonusVault.reservedOf(erin.address))[0]);

    const due = aliceDue + bobDue + frankDue + erinDue + henryDue + ivanDue;
    await (await asset.approve(await bonusVault.getAddress(), due)).wait();
    await (await bonusVault.fund(due)).wait();
    await expect(bonusVault.connect(alice).claim()).to.emit(bonusVault, "BonusClaimed").withArgs(alice.address, aliceDue);
    await expect(bonusVault.connect(bob).claim()).to.emit(bonusVault, "BonusClaimed").withArgs(bob.address, bobDue);
    await expect(bonusVault.connect(frank).claim()).to.emit(bonusVault, "BonusClaimed").withArgs(frank.address, frankDue);
    await expect(bonusVault.connect(erin).claim()).to.emit(bonusVault, "BonusClaimed").withArgs(erin.address, erinDue);
    await expect(bonusVault.connect(henry).claim()).to.emit(bonusVault, "BonusClaimed").withArgs(henry.address, henryDue);
    await expect(bonusVault.connect(ivan).claim()).to.emit(bonusVault, "BonusClaimed").withArgs(ivan.address, ivanDue);
    await expect(bonusVault.connect(ivan).claim()).to.be.revertedWithCustomError(bonusVault, "NothingToClaim");
    expect((await bonusVault.lpReservation(erinStaleId)).claimed).to.equal(false);
    expect(await bonusVault.totalLpReserved()).to.equal(erinLp, "only the stale record is still counted");
    // Anyone cleans it after the unlock; the tokens stay as surplus.
    await expect(bonusVault.connect(carol).reconcileLp(erinStaleId))
      .to.emit(bonusVault, "LpBonusForfeited")
      .withArgs(erinStaleId, erin.address, erinLp);
    // What is left owed is the v3 remainder reservations of dave and george (their LP ones were forfeited).
    expect(await bonusVault.totalReserved()).to.equal(
      (await bonusVault.reservedOf(dave.address))[0] + (await bonusVault.reservedOf(george.address))[0]
    );
    expect(await bonusVault.totalLpReserved()).to.equal(0n);

    // The minimal pool pays no reward: `unstake` pays the principal, nothing in USDC.
    const staked = await poolV3.stakes(alice.address);
    const usdcBefore = await usdc.balanceOf(alice.address);
    const unstaked = await (await poolV3.connect(alice).unstake()).wait();
    const ev = unstaked.logs.map((l) => { try { return poolV3.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "Unstaked");
    expect(ev.args.user).to.equal(alice.address);
    expect(ev.args.amount).to.equal(staked);
    expect(await asset.balanceOf(alice.address)).to.equal(staked + aliceDue);
    expect(await usdc.balanceOf(alice.address)).to.equal(usdcBefore);
    expect(await poolV3.stakes(alice.address)).to.equal(0n);

    // `emergencyUnstake` after the end: the direct staker's principal, under its own event.
    const direct = await poolV3.stakes(deployer.address);
    expect(direct).to.equal(ASSET(500));
    const deployerBefore = await asset.balanceOf(deployer.address);
    await expect(poolV3.connect(deployer).emergencyUnstake())
      .to.emit(poolV3, "EmergencyUnstaked")
      .withArgs(deployer.address, direct);
    expect((await asset.balanceOf(deployer.address)) - deployerBefore).to.equal(direct);
    await expect(poolV3.connect(deployer).unstake()).to.be.revertedWith("Nothing to unstake");
  });

  it("never wrote the tracked deployments.json", function () {
    expect(sha256(TRACKED_REGISTRY)).to.equal(registryBefore);
  });
});
