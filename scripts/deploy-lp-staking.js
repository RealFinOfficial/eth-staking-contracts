const hre = require("hardhat");
const pools = require("./lib/pools");

// Deploy the full LP staking stack and record every address in deployments.json.
//
// Deploy order is fixed by the wiring: TokenX first (nothing depends on it),
// then RewardsDistributor (needs TokenX), then LPStakingVault, then LPZapper
// (needs the vault). The deployer owns all four until the wiring is done, then
// ownership moves to LP_MULTISIG in the same run.
//
// Required env
//   LP_ASSET       — ASSET token (18 decimals), one side of the pool
//   LP_USDC        — USDC token (6 decimals), the other side and the zap-in token
//   LP_POOL        — the Uniswap V3 ASSET-USDC pool this stack is bound to
//   LP_SIGNER      — backend voucher signer for RewardsDistributor; MUST NOT be
//                    the deployer or the multisig — it signs EIP-712 payloads on
//                    every claim, which a Ledger cannot serve
//   LP_MULTISIG    — final owner of all four contracts
//   LP_TOKENX_NAME / LP_TOKENX_SYMBOL — TokenX branding, decided at deploy time
//
// Optional env (defaults in parentheses)
//   LP_NPM                    — NonfungiblePositionManager (per-chain default, see UNISWAP_BY_CHAIN)
//   LP_ROUTER                 — SwapRouter02 (per-chain default, see UNISWAP_BY_CHAIN)
//   LP_FEE                    — pool fee tier in hundredths of a bip (3000)
//   LP_TWAP_WINDOW            — TWAP lookback in seconds, 300..3600 (300)
//   LP_TWAP_MAX_DEVIATION_BPS — spot-vs-TWAP ceiling in BPS, <= 2000 (1000). The contract
//                               stores TICKS; this script converts exactly with
//                               floor(ln(1 + bps/1e4) / ln(1.0001)) and logs both numbers.
//                               500 bps = 487 ticks, 1000 = 953, 2000 = 1823
//   LP_EPOCH_ID               — first epoch id to arm on TokenX (none)
//   LP_EPOCH_CAP              — that epoch's mint cap, in whole TokenX (none)
//   LP_OBSERVATION_CARDINALITY — oracle slots to grow the pool into (150). Must be at least
//                               2 * ceil(LP_TWAP_WINDOW / 12): one slot per block in the
//                               worst case, doubled for margin. 300 s needs >= 50, 3600 s
//                               needs >= 600
//
// Mainnet needs CONFIRM=yes, like every other state-changing script here.

// Uniswap V3 is NOT at one address across chains. Sepolia got its own deployment,
// and the mainnet addresses have zero code there. Keyed by chain id; a chain that
// is not listed has no default, so LP_NPM / LP_ROUTER become required for it —
// including a local fork, which reports 31337 rather than the forked chain id.
// The getCode() check below is the backstop: a wrong address here fails there.
const UNISWAP_BY_CHAIN = {
  // mainnet
  1: {
    positionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
    swapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
  },
  // sepolia
  11155111: {
    positionManager: "0x1238536071E1c677A632429e3655c799b22cDA52",
    swapRouter02: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E",
  },
};

const VALID_FEE_TIERS = [100, 500, 3000, 10000];
const MIN_TWAP_WINDOW = 300; // TwapGuard.MIN_TWAP_WINDOW
const MAX_TWAP_WINDOW = 3600; // TwapGuard.MAX_TWAP_WINDOW
const MAX_TWAP_DEVIATION_TICKS = 1823; // TwapGuard.MAX_TWAP_DEVIATION_TICKS
// The guard's defaults, decided 2026-08-26 from the spec review: a WIDE circuit breaker.
// 300 s of lookback clears within ~1-2.5 minutes even after a 20% crash, and 1000 bps never
// trips below a 10% instantaneous move — so `rebalance` stays available exactly when a
// position has fallen out of range and needs it. The caller's own minimums remain the
// primary protection; see `libraries/TwapGuard.sol`.
const DEFAULT_TWAP_WINDOW = 300;
const DEFAULT_TWAP_MAX_DEVIATION_BPS = 1000;

// Observation slots. A pool fills at most one per block, so `window / 12` seconds of history
// is `ceil(window / 12)` slots in the worst case (every block trading); doubling that leaves
// room for the burst of activity a crash produces, which is exactly when the guard is read.
const DEFAULT_OBSERVATION_CARDINALITY = 150;
const SECONDS_PER_BLOCK = 12;
const CARDINALITY_MARGIN = 2;

/** Smallest cardinality that can hold `window` seconds of history with margin. */
function requiredCardinality(window) {
  return CARDINALITY_MARGIN * Math.ceil(window / SECONDS_PER_BLOCK);
}

/**
 * Exact basis-points -> ticks conversion, the one the guard's NatSpec states.
 *
 * A tick is a 1.0001x price step and steps compound, so a deviation of `bps` basis points
 * is `floor(ln(1 + bps/1e4) / ln(1.0001))` ticks. The human-facing knob stays in bps
 * because that is how a risk limit is discussed; the contract stores the tick count,
 * because that is what it compares against. Doing the log here rather than on-chain keeps
 * an immutable contract free of a fixed-point logarithm it would only use for a circuit
 * breaker.
 */
function bpsToTicks(bps) {
  return Math.floor(Math.log(1 + bps / 1e4) / Math.log(1.0001));
}

const ASSET_DECIMALS = 18;
const USDC_DECIMALS = 6;
const TOKENX_DECIMALS = 18;

/** Reads an address env var, applies a default and normalises the checksum. */
function readAddress(name, fallback) {
  const raw = process.env[name] || fallback;
  if (!raw) throw new Error(`Set ${name}`);
  try {
    return hre.ethers.getAddress(raw);
  } catch {
    throw new Error(`${name} is not a valid address: ${raw}`);
  }
}

/** Deploys one contract with an explicit nonce and returns it with its receipt. */
async function deployContract(name, args, deployer) {
  const nonce = await pools.resolveNonce(deployer.address);
  console.log(`\nDeploying ${name}... (nonce ${nonce})`);
  const factory = await hre.ethers.getContractFactory(name);
  const contract = await factory.deploy(...args, { nonce });
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  const tx = contract.deploymentTransaction();
  const receipt = await hre.ethers.provider.getTransactionReceipt(tx.hash);

  console.log(`  ${name}: ${address}`);
  console.log(`  ${pools.explorerAddress(await pools.chainId(), address)}`);
  console.log(`  deploy tx: ${tx.hash}`);
  return { contract, address, tx, receipt };
}

async function main() {
  const chainId = await pools.chainId();
  const mainnet = pools.isMainnet(chainId);
  const deployer = await pools.getSigner();

  // ──────────────────────── config ────────────────────────

  const uniswap = UNISWAP_BY_CHAIN[chainId] || {};

  const asset = readAddress("LP_ASSET");
  const usdc = readAddress("LP_USDC");
  const poolAddress = readAddress("LP_POOL");
  const positionManager = readAddress("LP_NPM", uniswap.positionManager);
  const swapRouter = readAddress("LP_ROUTER", uniswap.swapRouter02);
  const signer = readAddress("LP_SIGNER");
  const multisig = readAddress("LP_MULTISIG");

  const fee = Number(process.env.LP_FEE || 3000);
  const twapWindow = Number(process.env.LP_TWAP_WINDOW || DEFAULT_TWAP_WINDOW);
  const twapMaxDeviationBps = Number(
    process.env.LP_TWAP_MAX_DEVIATION_BPS || DEFAULT_TWAP_MAX_DEVIATION_BPS
  );
  const twapMaxDeviationTicks = bpsToTicks(twapMaxDeviationBps);
  const observationCardinality = Number(
    process.env.LP_OBSERVATION_CARDINALITY || DEFAULT_OBSERVATION_CARDINALITY
  );

  const tokenXName = process.env.LP_TOKENX_NAME;
  const tokenXSymbol = process.env.LP_TOKENX_SYMBOL;
  if (!tokenXName || !tokenXSymbol) throw new Error("Set LP_TOKENX_NAME and LP_TOKENX_SYMBOL");

  const epochId = process.env.LP_EPOCH_ID;
  const epochCapRaw = process.env.LP_EPOCH_CAP;
  if (Boolean(epochId) !== Boolean(epochCapRaw)) {
    throw new Error("LP_EPOCH_ID and LP_EPOCH_CAP must be set together, or neither");
  }
  // LP_EPOCH_CAP is given in whole TokenX, not wei — the same convention as
  // REWARD_AMOUNT in fund-rewards.js.
  const epochCap = epochCapRaw ? hre.ethers.parseUnits(epochCapRaw, TOKENX_DECIMALS) : undefined;

  // ──────────────────────── local validation ────────────────────────

  if (asset === usdc) throw new Error("LP_ASSET and LP_USDC must be different tokens");
  if (!VALID_FEE_TIERS.includes(fee)) {
    throw new Error(`LP_FEE must be one of ${VALID_FEE_TIERS.join(", ")} — got ${fee}`);
  }
  if (!Number.isInteger(twapWindow) || twapWindow < MIN_TWAP_WINDOW || twapWindow > MAX_TWAP_WINDOW) {
    throw new Error(
      `LP_TWAP_WINDOW must be an integer in ${MIN_TWAP_WINDOW}..${MAX_TWAP_WINDOW} — got ${twapWindow}`
    );
  }
  if (
    !Number.isInteger(twapMaxDeviationBps) ||
    twapMaxDeviationBps <= 0 ||
    twapMaxDeviationTicks < 1 ||
    twapMaxDeviationTicks > MAX_TWAP_DEVIATION_TICKS
  ) {
    throw new Error(
      `LP_TWAP_MAX_DEVIATION_BPS must convert into 1..${MAX_TWAP_DEVIATION_TICKS} ticks — ` +
        `got ${twapMaxDeviationBps} bps = ${twapMaxDeviationTicks} ticks`
    );
  }
  if (!Number.isInteger(observationCardinality) || observationCardinality < 1 || observationCardinality > 65535) {
    throw new Error(`LP_OBSERVATION_CARDINALITY must be a uint16 — got ${observationCardinality}`);
  }
  // Sizing the oracle is a liveness dependency, not a nicety: a buffer too small for the
  // window makes `observe()` revert `OLD` and takes both swap legs down with it, and a burst
  // of trading wraps a small buffer fastest.
  const minimumCardinality = requiredCardinality(twapWindow);
  if (observationCardinality < minimumCardinality) {
    throw new Error(
      `LP_OBSERVATION_CARDINALITY ${observationCardinality} is too small for a ${twapWindow}s ` +
        `window: at one observation per 12s block it needs at least ` +
        `${CARDINALITY_MARGIN} * ceil(${twapWindow} / ${SECONDS_PER_BLOCK}) = ${minimumCardinality} slots`
    );
  }

  // The constructors take the pair pre-sorted; sorting here removes one way to
  // get it wrong. Address comparison is on the lowercase hex, as Solidity does.
  const [token0, token1] =
    asset.toLowerCase() < usdc.toLowerCase() ? [asset, usdc] : [usdc, asset];

  console.log("Deploying the LP staking stack...");
  console.log(`Network:            chain ${chainId}`);
  console.log(`Deployer:           ${deployer.address}`);
  console.log(`ASSET:              ${asset}`);
  console.log(`USDC:               ${usdc}`);
  console.log(`Pool:               ${poolAddress}`);
  console.log(`  token0:           ${token0}`);
  console.log(`  token1:           ${token1}`);
  console.log(`  fee:              ${fee}`);
  console.log(`PositionManager:    ${positionManager}`);
  console.log(`SwapRouter02:       ${swapRouter}`);
  console.log(`Voucher signer:     ${signer}`);
  console.log(`Final owner:        ${multisig}`);
  console.log(`TokenX:             ${tokenXName} (${tokenXSymbol})`);
  console.log(`TWAP window:        ${twapWindow}s`);
  console.log(
    `TWAP max deviation: ${twapMaxDeviationBps} bps = ${twapMaxDeviationTicks} ticks (what the contract stores)`
  );
  console.log(
    `Initial epoch:      ${epochId ? `${epochId} capped at ${epochCapRaw} TokenX` : "NOT ARMED"}`
  );
  console.log(
    `Observation target: ${observationCardinality} (>= ${minimumCardinality} for a ${twapWindow}s window)`
  );

  // ──────────────────────── on-chain safety checks ────────────────────────

  console.log("\nChecking the configuration on-chain...");

  for (const [label, address] of [
    ["LP_POOL", poolAddress],
    ["LP_NPM", positionManager],
    ["LP_ROUTER", swapRouter],
    ["LP_ASSET", asset],
    ["LP_USDC", usdc],
  ]) {
    const code = await hre.ethers.provider.getCode(address);
    if (code === "0x") throw new Error(`No contract code at ${label} ${address} on chain ${chainId}`);
  }

  // The vault and the zapper both re-check the pool triple in their constructors,
  // so a mismatch would revert there anyway — but failing here costs no gas and
  // says which of the three values is wrong.
  const pool = await hre.ethers.getContractAt("IUniswapV3Pool", poolAddress);
  const poolToken0 = hre.ethers.getAddress(await pool.token0());
  const poolToken1 = hre.ethers.getAddress(await pool.token1());
  const poolFee = Number(await pool.fee());
  if (poolToken0 !== token0 || poolToken1 !== token1 || poolFee !== fee) {
    throw new Error(
      `Pool mismatch at ${poolAddress}:\n` +
        `  pool says token0=${poolToken0} token1=${poolToken1} fee=${poolFee}\n` +
        `  config says token0=${token0} token1=${token1} fee=${fee}`
    );
  }
  console.log(`  pool triple matches (token0/token1/fee)`);

  // The zapper cannot tell ASSET from USDC on-chain: both are just "one side of
  // the pair", and swapping the two roles produces a stack that mints positions
  // with the legs reversed and no revert anywhere. Decimals are the one cheap
  // discriminator, so they are asserted before a single byte is deployed.
  const assetToken = await pools.getErc20(asset);
  const usdcToken = await pools.getErc20(usdc);
  const assetDecimals = Number(await assetToken.decimals());
  const usdcDecimals = Number(await usdcToken.decimals());
  if (usdcDecimals !== USDC_DECIMALS) {
    throw new Error(
      `LP_USDC ${usdc} reports ${usdcDecimals} decimals, expected ${USDC_DECIMALS} — ` +
        `LP_ASSET and LP_USDC look swapped`
    );
  }
  if (assetDecimals !== ASSET_DECIMALS) {
    throw new Error(
      `LP_ASSET ${asset} reports ${assetDecimals} decimals, expected ${ASSET_DECIMALS} — ` +
        `LP_ASSET and LP_USDC look swapped`
    );
  }
  console.log(
    `  decimals match (${await assetToken.symbol()} 18 / ${await usdcToken.symbol()} 6)`
  );

  const slot0 = await pool.slot0();
  const cardinality = Number(slot0.observationCardinality);
  const cardinalityNext = Number(slot0.observationCardinalityNext);
  console.log(`  oracle: cardinality ${cardinality}, next ${cardinalityNext}`);

  if (signer === deployer.address || signer === multisig) {
    console.log(
      "\nWARNING: LP_SIGNER is the deployer or the multisig.\n" +
        "         The signer signs an EIP-712 voucher on every claim — it must be a hot\n" +
        "         backend key, and a Ledger cannot serve that role."
    );
  }
  if (multisig === deployer.address) {
    console.log(
      "\nWARNING: LP_MULTISIG is the deployer — ownership will not actually move off the\n" +
        "         deploying key. Set it to the multisig before a production run."
    );
  }
  if (!epochId) {
    console.log(
      "\nWARNING: LP_EPOCH_ID / LP_EPOCH_CAP are unset, so TokenX starts on epoch 0 with a\n" +
        "         zero cap. Every claimTokenX will revert with EpochMintCapExceeded until\n" +
        "         the owner arms an epoch with setEpochCap(epochId, cap). Arm it from the\n" +
        "         multisig before announcing claims."
    );
  }

  pools.requireConfirmation(chainId, "deploy the LP staking stack");
  if (mainnet) console.log("\nEvery transaction below needs a Ledger confirmation.");

  // ──────────────────────── deploy ────────────────────────

  const tokenXDeploy = await deployContract(
    "TokenX",
    [tokenXName, tokenXSymbol, deployer.address],
    deployer
  );
  pools.recordDeployment(chainId, "TokenX", tokenXDeploy.address, {
    deployTx: tokenXDeploy.tx.hash,
    block: tokenXDeploy.receipt.blockNumber,
    name: tokenXName,
    symbol: tokenXSymbol,
  });

  const distributorDeploy = await deployContract(
    "RewardsDistributor",
    [tokenXDeploy.address, asset, signer, deployer.address],
    deployer
  );
  pools.recordDeployment(chainId, "RewardsDistributor", distributorDeploy.address, {
    deployTx: distributorDeploy.tx.hash,
    block: distributorDeploy.receipt.blockNumber,
    tokenX: tokenXDeploy.address,
    asset,
    signer,
  });

  const vaultDeploy = await deployContract(
    "LPStakingVault",
    [
      positionManager,
      poolAddress,
      token0,
      token1,
      fee,
      swapRouter,
      deployer.address,
      twapWindow,
      twapMaxDeviationTicks,
    ],
    deployer
  );
  pools.recordDeployment(chainId, "LPStakingVault", vaultDeploy.address, {
    deployTx: vaultDeploy.tx.hash,
    block: vaultDeploy.receipt.blockNumber,
    pool: poolAddress,
    token0,
    token1,
    fee,
    twapWindow,
    maxTwapDeviationTicks: twapMaxDeviationTicks,
  });

  const zapperDeploy = await deployContract(
    "LPZapper",
    [
      vaultDeploy.address,
      positionManager,
      poolAddress,
      token0,
      token1,
      fee,
      swapRouter,
      usdc,
      asset,
      deployer.address,
      twapWindow,
      twapMaxDeviationTicks,
    ],
    deployer
  );
  pools.recordDeployment(chainId, "LPZapper", zapperDeploy.address, {
    deployTx: zapperDeploy.tx.hash,
    block: zapperDeploy.receipt.blockNumber,
    vault: vaultDeploy.address,
    usdc,
    asset,
    twapWindow,
    maxTwapDeviationTicks: twapMaxDeviationTicks,
  });

  const tokenX = tokenXDeploy.contract;
  const distributor = distributorDeploy.contract;
  const vault = vaultDeploy.contract;
  const zapper = zapperDeploy.contract;

  // ──────────────────────── wiring ────────────────────────
  // All of this is onlyOwner, so it must happen while the deployer still owns
  // the contracts — hence before the ownership transfers below.

  console.log("\nWiring the stack...");
  await pools.send("Setting TokenX minter to the distributor", deployer, (o) =>
    tokenX.setMinter(distributorDeploy.address, o)
  );
  await pools.send("Whitelisting the zapper on the vault", deployer, (o) =>
    vault.setZapper(zapperDeploy.address, o)
  );

  if (epochId) {
    await pools.send(`Arming epoch ${epochId} with cap ${epochCapRaw} TokenX`, deployer, (o) =>
      tokenX.setEpochCap(epochId, epochCap, o)
    );
  } else {
    console.log("Skipping setEpochCap — no epoch armed, claims will revert (see the warning above).");
  }

  // ──────────────────────── ownership ────────────────────────

  console.log("\nTransferring ownership to the multisig...");
  await pools.send("TokenX -> multisig", deployer, (o) => tokenX.transferOwnership(multisig, o));
  await pools.send("RewardsDistributor -> multisig", deployer, (o) =>
    distributor.transferOwnership(multisig, o)
  );
  await pools.send("LPStakingVault -> multisig", deployer, (o) =>
    vault.transferOwnership(multisig, o)
  );
  await pools.send("LPZapper -> multisig", deployer, (o) => zapper.transferOwnership(multisig, o));

  // ──────────────────────── oracle warm-up ────────────────────────
  // Permissionless, so it works after the ownership transfers.

  console.log("\nGrowing the pool oracle...");
  if (cardinalityNext >= observationCardinality) {
    console.log(
      `Skipping increaseObservationCardinalityNext — already ${cardinalityNext} >= ${observationCardinality}.`
    );
  } else {
    const poolAsDeployer = await hre.ethers.getContractAt("IUniswapV3Pool", poolAddress, deployer);
    await pools.send(
      `increaseObservationCardinalityNext(${observationCardinality})`,
      deployer,
      (o) => poolAsDeployer.increaseObservationCardinalityNext(observationCardinality, o)
    );
  }

  // The pool is not deployed by this script, but the size the stack was armed with is a
  // deployment fact of the same kind as the guard parameters, so it goes in the registry
  // beside them. The other three keys are the ones create-sepolia-pool.js writes.
  pools.recordDeployment(chainId, "UniswapV3Pool", poolAddress, {
    token0,
    token1,
    fee,
    observationCardinality: Math.max(observationCardinality, cardinalityNext),
  });

  if (cardinality <= 1) {
    console.log(
      `\nNOTE: the pool still stores ${cardinality} observation. Growing the array only\n` +
        `      allocates slots — they fill one per block that trades. Until the oracle holds\n` +
        `      at least ${twapWindow}s of history, pool.observe() reverts with 'OLD' and every\n` +
        `      TWAP-guarded path (zapIn, and any rebalance with a swap leg) reverts with it.\n` +
        `      Unguarded paths (stake, unstake, swap-free rebalance) work from block one.\n` +
        `      On a fresh pool: seed liquidity, trade it for ~${twapWindow}s, then re-check\n` +
        `      with pool.observe([${twapWindow}, 0]).`
    );
  }

  // ──────────────────────── verification ────────────────────────

  console.log("\n──────── post-deploy verification ────────");
  const failures = [];
  const check = (label, actual, expected) => {
    const ok = String(actual).toLowerCase() === String(expected).toLowerCase();
    console.log(`${ok ? "OK  " : "FAIL"}  ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
    if (!ok) failures.push(label);
  };

  check("TokenX.name", await tokenX.name(), tokenXName);
  check("TokenX.symbol", await tokenX.symbol(), tokenXSymbol);
  check("TokenX.decimals", await tokenX.decimals(), TOKENX_DECIMALS);
  check("TokenX.minter", await tokenX.minter(), distributorDeploy.address);
  check("TokenX.owner", await tokenX.owner(), multisig);
  check("TokenX.totalSupply", await tokenX.totalSupply(), 0);
  if (epochId) {
    check("TokenX.currentEpochId", await tokenX.currentEpochId(), epochId);
    check("TokenX.epochCap[current]", await tokenX.epochCap(epochId), epochCap);
  } else {
    console.log(`WARN  TokenX.currentEpochId: ${await tokenX.currentEpochId()} with cap ${await tokenX.epochCap(0)} — claims revert until an epoch is armed`);
  }

  check("RewardsDistributor.tokenX", await distributor.tokenX(), tokenXDeploy.address);
  check("RewardsDistributor.asset", await distributor.asset(), asset);
  check("RewardsDistributor.signer", await distributor.signer(), signer);
  check("RewardsDistributor.owner", await distributor.owner(), multisig);
  check("RewardsDistributor.paused", await distributor.paused(), false);
  check("RewardsDistributor.assetClaimsEnabled", await distributor.assetClaimsEnabled(), false);

  check("LPStakingVault.pool", await vault.pool(), poolAddress);
  check("LPStakingVault.positionManager", await vault.positionManager(), positionManager);
  check("LPStakingVault.swapRouter", await vault.swapRouter(), swapRouter);
  check("LPStakingVault.token0", await vault.token0(), token0);
  check("LPStakingVault.token1", await vault.token1(), token1);
  check("LPStakingVault.fee", await vault.fee(), fee);
  check("LPStakingVault.zapper", await vault.zapper(), zapperDeploy.address);
  check("LPStakingVault.depositsPaused", await vault.depositsPaused(), false);
  check("LPStakingVault.rebalancePaused", await vault.rebalancePaused(), false);
  check("LPStakingVault.twapWindow", await vault.twapWindow(), twapWindow);
  check("LPStakingVault.maxTwapDeviationTicks", await vault.maxTwapDeviationTicks(), twapMaxDeviationTicks);
  check("LPStakingVault.owner", await vault.owner(), multisig);

  check("LPZapper.vault", await zapper.vault(), vaultDeploy.address);
  check("LPZapper.pool", await zapper.pool(), poolAddress);
  check("LPZapper.positionManager", await zapper.positionManager(), positionManager);
  check("LPZapper.swapRouter", await zapper.swapRouter(), swapRouter);
  check("LPZapper.token0", await zapper.token0(), token0);
  check("LPZapper.token1", await zapper.token1(), token1);
  check("LPZapper.fee", await zapper.fee(), fee);
  check("LPZapper.usdc", await zapper.usdc(), usdc);
  check("LPZapper.asset", await zapper.asset(), asset);
  check("LPZapper.usdcIsToken0", await zapper.usdcIsToken0(), usdc === token0);
  check("LPZapper.twapWindow", await zapper.twapWindow(), twapWindow);
  check("LPZapper.maxTwapDeviationTicks", await zapper.maxTwapDeviationTicks(), twapMaxDeviationTicks);
  check("LPZapper.owner", await zapper.owner(), multisig);

  // ──────────────────────── summary ────────────────────────

  console.log("\n──────── deployed addresses ────────");
  console.log(`TokenX:             ${tokenXDeploy.address}`);
  console.log(`RewardsDistributor: ${distributorDeploy.address}`);
  console.log(`LPStakingVault:     ${vaultDeploy.address}`);
  console.log(`LPZapper:           ${zapperDeploy.address}`);

  const network = hre.network.name;
  console.log("\n──────── verify on the explorer ────────");
  console.log(
    `npx hardhat verify --network ${network} ${tokenXDeploy.address} ` +
      `"${tokenXName}" "${tokenXSymbol}" ${deployer.address}`
  );
  console.log(
    `npx hardhat verify --network ${network} ${distributorDeploy.address} ` +
      `${tokenXDeploy.address} ${asset} ${signer} ${deployer.address}`
  );
  console.log(
    `npx hardhat verify --network ${network} ${vaultDeploy.address} ` +
      `${positionManager} ${poolAddress} ${token0} ${token1} ${fee} ${swapRouter} ` +
      `${deployer.address} ${twapWindow} ${twapMaxDeviationTicks}`
  );
  console.log(
    `npx hardhat verify --network ${network} ${zapperDeploy.address} ` +
      `${vaultDeploy.address} ${positionManager} ${poolAddress} ${token0} ${token1} ${fee} ` +
      `${swapRouter} ${usdc} ${asset} ${deployer.address} ${twapWindow} ${twapMaxDeviationTicks}`
  );
  console.log(
    "\nThe constructor argument is the DEPLOYER, not the multisig — ownership moved " +
      "afterwards,\nso verification must replay the value the constructor actually saw."
  );

  if (failures.length > 0) {
    throw new Error(
      `Post-deploy verification failed for: ${failures.join(", ")}. ` +
        `The contracts are deployed and recorded in deployments.json — fix the state from the multisig.`
    );
  }
  console.log("\nAll post-deploy checks passed.");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
