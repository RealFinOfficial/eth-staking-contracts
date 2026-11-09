const fs = require("fs");
const os = require("os");
const path = require("path");

const hre = require("hardhat");
const pools = require("./lib/pools");
const { deployProxyPair } = require("./lib/proxies");
const lpTimelock = require("./lp-timelock");

// Deploys the staking v3 campaign beside a LIVE LP stack: the three UUPS proxies
// `WeightedStakingPoolV3`, `V3BonusVault` and `StakingMigrator`, wires what the deployer may wire
// while it still owns them (nothing that opens a route), nominates the `LPTimelock` as their owner,
// and writes the ONE timelock batch that finishes the job. No route works before that batch: the
// pool's and the bonus vault's `migrator` stay zero until the timelock owns all three.
//
// ──────────────────────── what it does, in order ────────────────────────
//
//   1. config and the on-chain checks: the LP vault's pool pair must be exactly {V3_ASSET, V3_USDC},
//      the activation must be before the end, the end in the future
//   2. `WeightedStakingPoolV3` + `LPProxy`, `initialize(deployer, $ASSET, USDC, activation, end,
//      weightSigner, rewardsWaived)` — the USDC reward slot is kept and never funded (decision of
//      2026-11-09); `rewardsWaived = true` makes `unstake` after the end pay the principal with a
//      zero reward and refuses `addRewards`
//   3. `V3BonusVault` + `LPProxy`, `initialize(deployer, $ASSET, migrator = 0, pool, lpVault,
//      maxTotalReserved)` — the cap on what all reservations together may owe
//   4. `StakingMigrator(lpVault, USDC, $ASSET)` + `LPProxy`, `initialize(deployer, pool, bonusVault,
//      migratorSigner, twapWindow, maxDeviationTicks, valuationWindow)` — born with routes 1 and 2
//      PAUSED (`compoundPaused = true`) and the rates 1000 / 1000 / 500 bps
//   5. the DIRECT wiring, sent by the deployer while it owns the three proxies (skipped when
//      already on chain): `pool.setBonusVault(bonusVault)`; then `transferOwnership(timelock)` on
//      all three — a NOMINATION (Ownable2Step), the deployer stays owner until the timelock accepts
//   6. the TIMELOCK batch (owner tier, one operation, in this order), written to a file
//      `lp-timelock.js` reads:
//        WeightedStakingPoolV3.acceptOwnership()
//        V3BonusVault.acceptOwnership()
//        StakingMigrator.acceptOwnership()
//        WeightedStakingPoolV3.setMigrator(migrator)   the routes open only here, after the timelock
//        V3BonusVault.setMigrator(migrator)            owns all three contracts
//        LPStakingVault.upgradeToAndCall(V3_VAULT_IMPLEMENTATION, 0x)   only when the live vault
//                                                                       has no bonusListener() yet
//        LPStakingVault.setBonusListener(bonusVault)
//        LPStakingVault.setStakeOperator(migrator, true)
//   7. the operator's steps after the batch: fund the bonus vault with $ASSET any time before the
//      end (`V3BonusVault.fund`), and `StakingMigrator.unpauseCompound()` once the pool has the
//      liquidity routes 1 and 2 need (the vault's operator)
//
// The three proxies are recorded in deployments.json (kinds `WeightedStakingPoolV3`,
// `V3BonusVault`, `StakingMigrator`) as each one exists, so a failed run loses no address. A run
// RESUMES: every kind already recorded for the chain (with code at its address) is reused and
// printed as "recorded" instead of being deployed again, and every wiring step and batch call is
// skipped when its effect is already on chain. To deploy afresh, remove the three entries first.
//
// ──────────────────────── environment ────────────────────────
//
//   V3_ACTIVATION_EPOCH       required, unix seconds: start of the v3 active period
//   V3_END_EPOCH              required, unix seconds: end of the v3 period = the bonus unlock time
//   V3_WEIGHT_SIGNER          required: the v3 pool's weight-voucher signer (a backend key)
//   V3_MIGRATOR_SIGNER        the TransitionVoucher signer; defaults to V3_WEIGHT_SIGNER
//   V3_ASSET / V3_USDC        default: the LPZapper entry's `asset` / `usdc` in deployments.json
//   V3_LP_VAULT               default: the LPStakingVault entry
//   V3_TIMELOCK               default: the TimelockController entry
//   V3_TWAP_WINDOW            the migrator's swap guard window, default 300 (the zapper's)
//   V3_TWAP_MAX_DEVIATION_TICKS  default 953 (the zapper's 1000 bps)
//   V3_VALUATION_WINDOW       default 1800 (the adapter's): the mean tick valuing the LP USDC leg
//   V3_MAX_TOTAL_RESERVED     whole $ASSET: the bonus vault's cap on all reservations together;
//                             REQUIRED on mainnet, default 100000 on test networks
//   V3_REWARDS_WAIVED         true | false, default true: the pool pays no USDC reward
//   V3_VAULT_IMPLEMENTATION   the new LPStakingVault implementation (deploy-implementation.js,
//                             IMPL_TARGET=LPStakingVault) when the live vault predates the listener
//   V3_BATCH_FILE             where to write the timelock batch; default a file in the OS temp dir
//   CONFIRM=yes               required on mainnet
//
//     V3_ACTIVATION_EPOCH=… V3_END_EPOCH=… V3_WEIGHT_SIGNER=0x… \
//       npx hardhat run scripts/deploy-staking-v3.js --network sepolia

const POOL_KIND = lpTimelock.V3_POOL_KIND;
const BONUS_KIND = lpTimelock.V3_BONUS_KIND;
const MIGRATOR_KIND = lpTimelock.MIGRATOR_KIND;

const VAULT_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function pool() view returns (address)",
  "function owner() view returns (address)",
  "function bonusListener() view returns (address)",
  "function isStakeOperator(address) view returns (bool)",
];

function sameAddress(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function readAddress(name, fallback) {
  const raw = process.env[name] || fallback;
  if (!raw) throw new Error(`Set ${name}`);
  if (!hre.ethers.isAddress(raw)) throw new Error(`${name} is not an address: ${raw}`);
  return hre.ethers.getAddress(raw);
}

function readBoolean(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false — got ${raw}`);
}

function readInteger(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    if (fallback === undefined) throw new Error(`Set ${name}`);
    return fallback;
  }
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${name} must be a whole number — got ${raw}`);
  return Number(raw);
}

/** The configuration, from the environment and the registry. Pure apart from the registry read. */
function readConfig(chainId) {
  const mainnet = pools.isMainnet(Number(chainId));
  const registry = pools.readRegistry()[String(chainId)] || {};
  const zapper = registry.LPZapper || {};
  const weightSigner = readAddress("V3_WEIGHT_SIGNER");
  const config = {
    activationEpoch: readInteger("V3_ACTIVATION_EPOCH"),
    endEpoch: readInteger("V3_END_EPOCH"),
    weightSigner,
    migratorSigner: readAddress("V3_MIGRATOR_SIGNER", weightSigner),
    asset: readAddress("V3_ASSET", zapper.asset),
    usdc: readAddress("V3_USDC", zapper.usdc),
    lpVault: readAddress("V3_LP_VAULT", registry.LPStakingVault && registry.LPStakingVault.address),
    timelock: readAddress("V3_TIMELOCK", registry.TimelockController && registry.TimelockController.address),
    twapWindow: readInteger("V3_TWAP_WINDOW", 300),
    maxDeviationTicks: readInteger("V3_TWAP_MAX_DEVIATION_TICKS", 953),
    valuationWindow: readInteger("V3_VALUATION_WINDOW", 1800),
    maxTotalReservedTokens: BigInt(readInteger("V3_MAX_TOTAL_RESERVED", mainnet ? undefined : 100000)),
    rewardsWaived: readBoolean("V3_REWARDS_WAIVED", true),
    vaultImplementation: process.env.V3_VAULT_IMPLEMENTATION
      ? readAddress("V3_VAULT_IMPLEMENTATION")
      : null,
  };
  if (config.endEpoch <= config.activationEpoch) {
    throw new Error(`V3_END_EPOCH (${config.endEpoch}) must be after V3_ACTIVATION_EPOCH (${config.activationEpoch})`);
  }
  return config;
}

/** The pair check: the LP vault's pool must be exactly {asset, usdc}. */
async function checkMarket(config) {
  const vault = new hre.ethers.Contract(config.lpVault, VAULT_ABI, hre.ethers.provider);
  const token0 = hre.ethers.getAddress(await vault.token0());
  const token1 = hre.ethers.getAddress(await vault.token1());
  const pair = [token0, token1];
  if (!pair.some((t) => sameAddress(t, config.asset)) || !pair.some((t) => sameAddress(t, config.usdc))) {
    throw new Error(
      `The LP vault ${config.lpVault} trades ${token0} / ${token1}, not V3_ASSET ${config.asset} / ` +
        `V3_USDC ${config.usdc}`
    );
  }
  return { token0, token1, pool: hre.ethers.getAddress(await vault.pool()) };
}

/** Whether the live vault already carries `bonusListener()` (the staking v3 vault revision). */
async function vaultHasListener(vaultAddress) {
  const vault = new hre.ethers.Contract(vaultAddress, VAULT_ABI, hre.ethers.provider);
  try {
    await vault.bonusListener();
    return true;
  } catch {
    return false;
  }
}

/**
 * A kind the registry already records for this chain, with code at its address, or `null`.
 * Reused instead of deployed again (the resume path); printed as "recorded".
 */
async function recordedProxy(chainId, kind) {
  const address = pools.registryAddress(chainId, kind);
  if (!address) return null;
  const code = await hre.ethers.provider.getCode(address);
  if (code === "0x") {
    throw new Error(
      `deployments.json records ${kind} at ${address} for chain ${chainId}, but there is no code there — ` +
        "remove the stale entry or fix the network"
    );
  }
  console.log(`${kind}: recorded at ${address}, reused (not deployed again)`);
  return { address: hre.ethers.getAddress(address), recorded: true };
}

/** `config.maxTotalReservedTokens` whole $ASSET in wei, at the token's own decimals. */
async function maxTotalReservedWei(config) {
  const token = new hre.ethers.Contract(config.asset, ["function decimals() view returns (uint8)"], hre.ethers.provider);
  return BigInt(config.maxTotalReservedTokens) * 10n ** BigInt(await token.decimals());
}

/**
 * Steps 2-4. Each proxy is recorded as soon as it exists; a kind already recorded is reused.
 * @returns {{pool, bonusVault, migrator}} `deployProxyPair` results, or `{address, recorded}`
 */
async function deployContracts({ chainId, deployer, config }) {
  const pool = (await recordedProxy(chainId, POOL_KIND)) || (await deployPool({ chainId, deployer, config }));
  const bonusVault =
    (await recordedProxy(chainId, BONUS_KIND)) || (await deployBonusVault({ chainId, deployer, config, pool }));
  const migrator =
    (await recordedProxy(chainId, MIGRATOR_KIND)) ||
    (await deployMigrator({ chainId, deployer, config, pool, bonusVault }));
  return { pool, bonusVault, migrator };
}

async function deployPool({ chainId, deployer, config }) {
  const pool = await deployProxyPair(
    POOL_KIND,
    [],
    [
      deployer.address,
      config.asset,
      config.usdc,
      config.activationEpoch,
      config.endEpoch,
      config.weightSigner,
      config.rewardsWaived,
    ],
    deployer
  );
  pools.recordDeployment(chainId, POOL_KIND, pool.address, {
    deployTx: pool.tx.hash,
    block: pool.receipt.blockNumber,
    implementation: pool.impl.address,
    implementationTx: pool.impl.tx.hash,
    stakingToken: config.asset,
    rewardToken: config.usdc,
    activationEpoch: config.activationEpoch,
    endEpoch: config.endEpoch,
    signer: config.weightSigner,
    rewardsWaived: config.rewardsWaived,
    owner: deployer.address,
  });
  return pool;
}

async function deployBonusVault({ chainId, deployer, config, pool }) {
  const maxTotalReserved = await maxTotalReservedWei(config);
  const bonusVault = await deployProxyPair(
    BONUS_KIND,
    [],
    [deployer.address, config.asset, hre.ethers.ZeroAddress, pool.address, config.lpVault, maxTotalReserved],
    deployer
  );
  pools.recordDeployment(chainId, BONUS_KIND, bonusVault.address, {
    deployTx: bonusVault.tx.hash,
    block: bonusVault.receipt.blockNumber,
    implementation: bonusVault.impl.address,
    implementationTx: bonusVault.impl.tx.hash,
    bonusToken: config.asset,
    pool: pool.address,
    vault: config.lpVault,
    maxTotalReserved: maxTotalReserved.toString(),
    owner: deployer.address,
  });
  return bonusVault;
}

async function deployMigrator({ chainId, deployer, config, pool, bonusVault }) {
  const migrator = await deployProxyPair(
    MIGRATOR_KIND,
    [config.lpVault, config.usdc, config.asset],
    [
      deployer.address,
      pool.address,
      bonusVault.address,
      config.migratorSigner,
      config.twapWindow,
      config.maxDeviationTicks,
      config.valuationWindow,
    ],
    deployer
  );
  pools.recordDeployment(chainId, MIGRATOR_KIND, migrator.address, {
    deployTx: migrator.tx.hash,
    block: migrator.receipt.blockNumber,
    implementation: migrator.impl.address,
    implementationTx: migrator.impl.tx.hash,
    lpVault: config.lpVault,
    usdc: config.usdc,
    asset: config.asset,
    stakingPool: pool.address,
    bonusVault: bonusVault.address,
    signer: config.migratorSigner,
    twapWindow: config.twapWindow,
    maxTwapDeviationTicks: config.maxDeviationTicks,
    valuationWindow: config.valuationWindow,
    owner: deployer.address,
  });
  return migrator;
}

/**
 * Step 5: what the deployer sends while it owns the three proxies, then the nominations. Every
 * call is skipped when its effect is already on chain, so a resumed run sends nothing twice. The
 * two `setMigrator` calls are NOT here: they open the routes, so they go in the timelock batch.
 */
async function wireDirect({ deployer, addresses, timelock }) {
  const pool = await hre.ethers.getContractAt(POOL_KIND, addresses.pool, deployer);
  const bonusVault = await hre.ethers.getContractAt(BONUS_KIND, addresses.bonusVault, deployer);
  const migrator = await hre.ethers.getContractAt(MIGRATOR_KIND, addresses.migrator, deployer);

  if (!sameAddress(await pool.bonusVault(), addresses.bonusVault)) {
    await pools.send("pool.setBonusVault(bonusVault)", deployer, (o) => pool.setBonusVault(addresses.bonusVault, o));
  }
  for (const [label, contract] of [
    [POOL_KIND, pool],
    [BONUS_KIND, bonusVault],
    [MIGRATOR_KIND, migrator],
  ]) {
    const owner = await contract.owner();
    const pending = await contract.pendingOwner();
    if (sameAddress(owner, timelock)) continue;
    if (sameAddress(pending, timelock)) continue;
    await pools.send(`${label} -> timelock (nomination)`, deployer, (o) => contract.transferOwnership(timelock, o));
  }
}

/**
 * Step 6: the batch, only the calls whose effect is NOT already on chain (a finished run computes
 * an empty batch).
 */
async function timelockOps({ addresses, lpVault, timelock, vaultImplementation }) {
  const ops = [];
  for (const [kind, address] of [
    [POOL_KIND, addresses.pool],
    [BONUS_KIND, addresses.bonusVault],
    [MIGRATOR_KIND, addresses.migrator],
  ]) {
    const contract = await hre.ethers.getContractAt(kind, address);
    if (!sameAddress(await contract.owner(), timelock) && sameAddress(await contract.pendingOwner(), timelock)) {
      ops.push({ target: address, kind, fn: "acceptOwnership", args: [] });
    }
  }
  // The two links that open the routes, only once the timelock owns everything.
  const pool = await hre.ethers.getContractAt(POOL_KIND, addresses.pool);
  const bonusVault = await hre.ethers.getContractAt(BONUS_KIND, addresses.bonusVault);
  if (!sameAddress(await pool.migrator(), addresses.migrator)) {
    ops.push({ target: addresses.pool, kind: POOL_KIND, fn: "setMigrator", args: [addresses.migrator] });
  }
  if (!sameAddress(await bonusVault.migrator(), addresses.migrator)) {
    ops.push({ target: addresses.bonusVault, kind: BONUS_KIND, fn: "setMigrator", args: [addresses.migrator] });
  }
  const hasListener = await vaultHasListener(lpVault);
  if (!hasListener) {
    if (!vaultImplementation) {
      throw new Error(
        `The LP vault ${lpVault} predates the bonus listener (no bonusListener()). Deploy the new ` +
          "implementation first (IMPL_TARGET=LPStakingVault npx hardhat run scripts/deploy-implementation.js) " +
          "and pass it as V3_VAULT_IMPLEMENTATION; the batch upgrades the vault before linking."
      );
    }
    ops.push({ target: lpVault, kind: "LPStakingVault", fn: "upgradeToAndCall", args: [vaultImplementation, "0x"] });
  }
  const vault = new hre.ethers.Contract(lpVault, VAULT_ABI, hre.ethers.provider);
  const linked = hasListener && sameAddress(await vault.bonusListener(), addresses.bonusVault);
  const allowed = hasListener && (await vault.isStakeOperator(addresses.migrator));
  if (!linked) {
    ops.push({ target: lpVault, kind: "LPStakingVault", fn: "setBonusListener", args: [addresses.bonusVault] });
  }
  if (!allowed) {
    ops.push({ target: lpVault, kind: "LPStakingVault", fn: "setStakeOperator", args: [addresses.migrator, "true"] });
  }
  return ops;
}

function batchFileContents(ops) {
  return ops.map((op) => ({ target: op.target, fn: op.fn, args: op.args.map((a) => String(a)) }));
}

/**
 * The whole run, callable in-process (the fork suite does). Returns the three addresses and the
 * timelock batch, or `null` for the batch when nothing is left for the timelock to do.
 */
async function deployStakingV3({ config, deployer, batchFile = null }) {
  const chainId = await pools.chainId();
  await checkMarket(config);

  const deployed = await deployContracts({ chainId, deployer, config });
  const addresses = {
    pool: deployed.pool.address,
    bonusVault: deployed.bonusVault.address,
    migrator: deployed.migrator.address,
  };
  await wireDirect({ deployer, addresses, timelock: config.timelock });

  const ops = await timelockOps({
    addresses,
    lpVault: config.lpVault,
    timelock: config.timelock,
    vaultImplementation: config.vaultImplementation,
  });
  const batch = ops.length > 0 ? lpTimelock.buildBatch(ops, "staking-v3") : null;
  if (batch && batchFile) {
    fs.writeFileSync(batchFile, JSON.stringify(batchFileContents(ops), null, 2) + "\n");
  }
  return { addresses, ops, batch, batchFile: batch ? batchFile : null };
}

async function main() {
  const chainId = await pools.chainId();
  const deployer = await pools.getSigner();
  const config = readConfig(chainId);
  const now = (await hre.ethers.provider.getBlock("latest")).timestamp;
  if (config.endEpoch <= now) throw new Error(`V3_END_EPOCH (${config.endEpoch}) is already in the past`);

  console.log("Deploying the staking v3 campaign...");
  console.log(`Network:            chain ${chainId}`);
  console.log(`Deployer:           ${deployer.address}`);
  console.log(`$ASSET / USDC:      ${config.asset} / ${config.usdc}`);
  console.log(`LP vault:           ${config.lpVault}`);
  console.log(`Timelock (owner):   ${config.timelock}`);
  console.log(`Activation:         ${config.activationEpoch} (${pools.epochToIso(config.activationEpoch)})`);
  console.log(`End (bonus unlock): ${config.endEpoch} (${pools.epochToIso(config.endEpoch)})`);
  console.log(`Weight signer:      ${config.weightSigner}`);
  console.log(`Migrator signer:    ${config.migratorSigner}`);
  console.log(`Swap guard:         ${config.twapWindow} s / ${config.maxDeviationTicks} ticks`);
  console.log(`Valuation window:   ${config.valuationWindow} s`);
  console.log(`Bonus budget:       ${config.maxTotalReservedTokens} $ASSET (maxTotalReserved)`);
  console.log(`Rewards waived:     ${config.rewardsWaived}`);
  if (config.vaultImplementation) console.log(`Vault upgrade to:   ${config.vaultImplementation}`);

  pools.requireConfirmation(chainId, "deploy the staking v3 campaign");

  const batchFile =
    process.env.V3_BATCH_FILE || path.join(os.tmpdir(), `staking-v3-batch-${chainId}-${Date.now()}.json`);
  const { addresses, batch } = await deployStakingV3({ config, deployer, batchFile });

  console.log("\n── Addresses ──");
  console.log(`WeightedStakingPoolV3: ${addresses.pool}`);
  console.log(`V3BonusVault:          ${addresses.bonusVault}`);
  console.log(`StakingMigrator:       ${addresses.migrator}`);

  if (batch) {
    console.log(`\n── The timelock batch (${batch.calls.length} calls, id ${batch.id}) ──`);
    for (const call of batch.calls) console.log(`  ${lpTimelock.describeCall(call)}`);
    console.log(`\nThe same batch, as a file lp-timelock.js reads: ${batchFile}`);
    console.log(
      `  TIMELOCK_ACTION=schedule-batch TIMELOCK_BATCH=${batchFile} TIMELOCK_SALT_TAG=staking-v3 \\\n` +
        `    npx hardhat run scripts/lp-timelock.js --network ${hre.network.name}\n` +
        `  TIMELOCK_ACTION=execute-batch  TIMELOCK_BATCH=${batchFile} TIMELOCK_SALT_TAG=staking-v3 \\\n` +
        `    npx hardhat run scripts/lp-timelock.js --network ${hre.network.name}`
    );
  } else {
    console.log("\nNothing is left for the timelock: every link is already on chain.");
  }

  console.log(
    "\n── After the batch executes (the operator, no delay) ──\n" +
      `  1. fund the bonus vault with $ASSET before the end: V3BonusVault(${addresses.bonusVault}).fund(amount)\n` +
      `  2. once the pool has the liquidity routes 1 and 2 need: StakingMigrator(${addresses.migrator}).unpauseCompound()\n` +
      "     (the LP vault's operator; route 3 is open from the batch onwards)\n" +
      "  3. for every BonusListenerFailed(tokenId) the LP vault emits, the backend calls\n" +
      `     V3BonusVault(${addresses.bonusVault}).reconcileLp(tokenId) (anyone may)`
  );
}

module.exports = {
  POOL_KIND,
  BONUS_KIND,
  MIGRATOR_KIND,
  readConfig,
  recordedProxy,
  checkMarket,
  deployContracts,
  wireDirect,
  timelockOps,
  deployStakingV3,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
