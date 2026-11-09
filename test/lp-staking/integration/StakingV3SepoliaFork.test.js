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
 *      the fail-open listener did NOT fail on the real pool's `observe`; its gas is recorded
 *   7. dave joins LP and unstakes before the unlock: his LP reservation is forfeited on the real
 *      pool; the listener's unstake gas is recorded
 *   8. carol withdraws from v3 early: her whole v3 reservation is forfeited
 *   9. after the end: an unfunded claim reverts, a funded one pays; bob unstakes his LP after the
 *      unlock and still claims it; the v3 exit is `unstake`, the principal with a ZERO reward
 *      (the pool's rewards are waived)
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
const WEIGHT = 1500n;
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

  let deployer, alice, bob, carol, multisig, guardian, weightSigner, dave;
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
    return weightSigner.signTypedData(
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
  async function voucher(user, route, principal, reward, nonce, weight = WEIGHT) {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const signature = await weightSigner.signTypedData(
      { name: "StakingMigrator", version: "1", chainId, verifyingContract: await migrator.getAddress() },
      {
        TransitionVoucher: [
          { name: "user", type: "address" },
          { name: "route", type: "uint8" },
          { name: "eligiblePrincipal", type: "uint256" },
          { name: "eligibleReward", type: "uint256" },
          { name: "weight", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      { user: user.address, route, eligiblePrincipal: principal, eligibleReward: reward, weight, nonce, deadline: FAR }
    );
    return { route, eligiblePrincipal: principal, eligibleReward: reward, weight, nonce, deadline: FAR, signature };
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
    [deployer, alice, bob, carol, multisig, guardian, weightSigner, dave] = (await ethers.getSigners()).map(pin);

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
    for (const user of [alice, bob, carol, dave]) {
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
    sw2 = await Sw2.deploy(P.asset.address, P.usdc.address, start, start + 3600n, weightSigner.address);
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
      weightSigner: weightSigner.address,
      migratorSigner: weightSigner.address,
      asset: P.asset.address,
      usdc: P.usdc.address,
      lpVault: await vault.getAddress(),
      timelock: await timelock.getAddress(),
      twapWindow: 300,
      maxDeviationTicks: 953,
      valuationWindow: 1800,
      maxTotalReservedTokens: 100000n,
      rewardsWaived: true,
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
    expect(await poolV3.rewardsWaived()).to.equal(true);
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
    expect((await poolV3.stakes(carol.address)).amount).to.equal(PRINCIPAL);
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
    expect((await poolV3.stakes(alice.address)).amount).to.equal(staked);
    expect(await poolV3.getUserMultiplier(alice.address)).to.equal(WEIGHT);
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
    expect((await poolV3.stakes(bob.address)).amount).to.equal(event.args.restaked);
    const lpRes = await bonusVault.lpReservation(bobTokenId);
    expect(lpRes.user).to.equal(bob.address);
    expect(lpRes.amount).to.equal(event.args.lpBonus);
    const expected = ((event.args.assetToLp + (await migrator.usdcInAsset(event.args.usdcIn))) * 1000n) / 10_000n;
    expect(lpRes.amount).to.equal(expected);
    notes.push(`route 2: LP ${ethers.formatUnits(event.args.assetToLp, 18)} tREAL + ${ethers.formatUnits(event.args.usdcIn, 6)} tUSDC, v3 ${ethers.formatUnits(event.args.restaked, 18)} tREAL, refund ${ethers.formatUnits(refunded, 6)} tUSDC`);
  });

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
    bobTokenId = newId;
    notes.push(
      `rebalance: LP bonus ${ethers.formatUnits(before, 18)} -> ${ethers.formatUnits(moved.amount, 18)} tREAL, ` +
        `tx gas ${receipt.gasUsed}, listener onRebalance ${hookGas} gas (eth_estimateGas from the vault, incl. ` +
        `the 21,000 intrinsic; allowance ${await vault.bonusListenerGas()})`
    );
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

  it("carol withdraws from v3 before the end: her whole v3 reservation is forfeited", async function () {
    const owed = (await bonusVault.reservedOf(carol.address))[0];
    expect(owed).to.be.greaterThan(0n);
    await expect(poolV3.connect(carol).withdraw(ASSET(1), 0, 0, "0x"))
      .to.emit(bonusVault, "BonusForfeited")
      .withArgs(carol.address, owed);
    expect((await bonusVault.reservedOf(carol.address))[0]).to.equal(0n);
  });

  it("after the end: unfunded claims revert, funded ones pay; an LP unstaked after the unlock still pays", async function () {
    await expect(bonusVault.connect(alice).claim()).to.be.revertedWithCustomError(bonusVault, "NothingToClaim");
    await advance(3600 + 30 * 86400 + 10);

    const aliceDue = await bonusVault.claimable(alice.address);
    await expect(bonusVault.connect(alice).claim())
      .to.be.revertedWithCustomError(bonusVault, "InsufficientFunds")
      .withArgs(aliceDue, 0n);

    await (await vault.connect(bob).unstake(bobTokenId)).wait();
    const bobDue = await bonusVault.claimable(bob.address);
    const lpPart = (await bonusVault.lpReservation(bobTokenId)).amount;
    expect(bobDue).to.equal((await bonusVault.reservedOf(bob.address))[0] + lpPart);

    await (await asset.approve(await bonusVault.getAddress(), aliceDue + bobDue)).wait();
    await (await bonusVault.fund(aliceDue + bobDue)).wait();
    await expect(bonusVault.connect(alice).claim()).to.emit(bonusVault, "BonusClaimed").withArgs(alice.address, aliceDue);
    await expect(bonusVault.connect(bob).claim()).to.emit(bonusVault, "BonusClaimed").withArgs(bob.address, bobDue);
    // What is left owed is dave's v3 remainder reservation alone (his LP one was forfeited).
    expect(await bonusVault.totalReserved()).to.equal((await bonusVault.reservedOf(dave.address))[0]);
    expect(await bonusVault.totalLpReserved()).to.equal(0n);

    // v3 pays no USDC: the rewards are waived, so `unstake` pays the principal with a zero reward.
    const staked = (await poolV3.stakes(alice.address)).amount;
    const usdcBefore = await usdc.balanceOf(alice.address);
    const unstaked = await (await poolV3.connect(alice).unstake()).wait();
    const ev = unstaked.logs.map((l) => { try { return poolV3.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "Unstaked");
    expect(ev.args.user).to.equal(alice.address);
    expect(ev.args.amount).to.equal(staked);
    expect(ev.args.reward).to.equal(0n);
    expect(await asset.balanceOf(alice.address)).to.equal(staked + aliceDue);
    expect(await usdc.balanceOf(alice.address)).to.equal(usdcBefore);
  });

  it("never wrote the tracked deployments.json", function () {
    expect(sha256(TRACKED_REGISTRY)).to.equal(registryBefore);
  });
});
