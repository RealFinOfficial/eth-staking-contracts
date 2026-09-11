const hre = require("hardhat");
const pools = require("./lib/pools");
const uniswapByChain = require("./lib/uniswap");

// Create the ASSET-USDC Uniswap V3 pool for the integration environment.
//
// Mainnet already has its pool, so this script refuses to run on chain 1. It is
// for Sepolia and local forks: it asks the canonical factory whether the
// (ASSET, USDC, fee) pool exists and, if it does not, creates and initializes it
// through the position manager.
//
// Required env
//   LP_ASSET                  — ASSET token (18 decimals)
//   LP_USDC                   — USDC token (6 decimals)
//   LP_INITIAL_SQRT_PRICE_X96 — starting price, only used when the pool is created
//
// Optional env (defaults in parentheses)
//   LP_FEE     — fee tier in hundredths of a bip (3000)
//   LP_NPM     — NonfungiblePositionManager (per-chain default, see scripts/lib/uniswap.js)
//   LP_FACTORY — UniswapV3Factory (per-chain default, see scripts/lib/uniswap.js)
//
// ──────────────────────── computing LP_INITIAL_SQRT_PRICE_X96 ────────────────────────
//
// Uniswap stores the price as a Q64.96 square root of the RAW-unit ratio:
//
//     sqrtPriceX96 = sqrt(raw_token1_per_raw_token0) * 2**96
//
// "Raw" means smallest units, so the decimals of both tokens are baked in. With
// ASSET at 18 decimals and USDC at 6, the raw ratio is 1e12 away from the human
// price, and which way depends on which token sorted lower.
//
// Human price P = USDC per ASSET (e.g. 0.50 means one ASSET costs 50 cents).
//
//   ASSET is token0 (ASSET address < USDC address):
//       raw = P * 1e6 / 1e18 = P * 1e-12
//   USDC is token0 (USDC address < ASSET address):
//       raw = (1 / P) * 1e18 / 1e6 = 1e12 / P
//
// then sqrtPriceX96 = sqrt(raw) * 2**96.
//
// Worked example, P = 0.50 USDC per ASSET:
//
//   ASSET is token0:  raw = 0.5 * 1e-12 = 5e-13
//                     sqrt(raw)    = 7.0711e-7
//                     sqrtPriceX96 = 7.0711e-7 * 7.9228e28
//                                  = 56022770974786135785472                (~5.6023e22)
//   USDC is token0:   raw = 1e12 / 0.5 = 2e12
//                     sqrt(raw)    = 1.41421e6
//                     sqrtPriceX96 = 1.41421e6 * 7.9228e28
//                                  = 112045541949572272737260854768041984   (~1.1205e35)
//
// (2**96 = 79228162514264337593543950336. Both results fit uint160, whose
//  ceiling is ~1.46e48.)
//
// One-liner to produce it (node, no dependencies) — set P and the sort order:
//
//   node -e '
//     const P = 0.5, assetIsToken0 = true;
//     const raw = assetIsToken0 ? P * 1e-12 : 1e12 / P;
//     console.log(BigInt(Math.floor(Math.sqrt(raw) * 2 ** 96)).toString());
//   '
//
// The script prints the human price this value decodes back to before sending
// anything, so a wrong sort order or a missing 1e12 is visible before the tx.

const VALID_FEE_TIERS = [100, 500, 3000, 10000];

// Neither call lives in our vendored interfaces — the vault and the zapper never
// create pools — so the two fragments are inlined here.
const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
];
const POSITION_MANAGER_ABI = [
  "function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) payable returns (address pool)",
];
const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
];

function readAddress(name, fallback) {
  const raw = process.env[name] || fallback;
  if (!raw) throw new Error(`Set ${name}`);
  try {
    return hre.ethers.getAddress(raw);
  } catch {
    throw new Error(`${name} is not a valid address: ${raw}`);
  }
}

/**
 * Decodes sqrtPriceX96 back to a human price, for the pre-send sanity print.
 * Returns USDC per ASSET. Float math is fine here — this value is only shown.
 */
function decodeUsdcPerAsset(sqrtPriceX96, assetIsToken0) {
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  const raw = ratio * ratio; // raw token1 per raw token0
  return assetIsToken0 ? raw * 1e12 : 1e12 / raw;
}

async function main() {
  const chainId = await pools.chainId();
  if (pools.isMainnet(chainId)) {
    throw new Error("Refusing to create a pool on mainnet — the mainnet pool already exists");
  }

  // A local fork reports its own chain id (31337), not the forked one, so it
  // lands here with no default and must pass LP_FACTORY / LP_NPM explicitly.
  const uniswap = uniswapByChain.forChain(chainId);

  const asset = readAddress("LP_ASSET");
  const usdc = readAddress("LP_USDC");
  const factoryAddress = readAddress("LP_FACTORY", uniswap.factory);
  const positionManagerAddress = readAddress("LP_NPM", uniswap.positionManager);
  const fee = Number(process.env.LP_FEE || 3000);

  if (asset === usdc) throw new Error("LP_ASSET and LP_USDC must be different tokens");
  if (!VALID_FEE_TIERS.includes(fee)) {
    throw new Error(`LP_FEE must be one of ${VALID_FEE_TIERS.join(", ")} — got ${fee}`);
  }

  const assetIsToken0 = asset.toLowerCase() < usdc.toLowerCase();
  const [token0, token1] = assetIsToken0 ? [asset, usdc] : [usdc, asset];

  const deployer = await pools.getSigner();

  console.log(`Network:  chain ${chainId}`);
  console.log(`Caller:   ${deployer.address}`);
  console.log(`ASSET:    ${asset}`);
  console.log(`USDC:     ${usdc}`);
  console.log(`token0:   ${token0}${assetIsToken0 ? "  (ASSET)" : "  (USDC)"}`);
  console.log(`token1:   ${token1}${assetIsToken0 ? "  (USDC)" : "  (ASSET)"}`);
  console.log(`fee:      ${fee}`);
  console.log(`factory:  ${factoryAddress}`);
  console.log(`NPM:      ${positionManagerAddress}`);

  // Decimals are only a warning here so an odd mock can still get a pool created;
  // deploy-lp-staking.js enforces 18/6 before it deploys against one. For LP
  // staking on Sepolia that means tREAL (18) and tUSDC (6) — the older mUSDC mock
  // reports 18 decimals and is rejected, since it would put the sqrt price out by
  // 1e24 while every call still succeeds.
  const assetDecimals = Number(await (await pools.getErc20(asset)).decimals());
  const usdcDecimals = Number(await (await pools.getErc20(usdc)).decimals());
  console.log(`decimals: ASSET ${assetDecimals}, USDC ${usdcDecimals}`);
  if (assetDecimals !== 18 || usdcDecimals !== 6) {
    console.log(
      "\nWARNING: expected ASSET 18 / USDC 6 decimals. If these are real tokens, LP_ASSET and\n" +
        "         LP_USDC are probably swapped, and the sqrt price below is off by 1e24."
    );
  }

  const factory = new hre.ethers.Contract(factoryAddress, FACTORY_ABI, hre.ethers.provider);
  const existing = await factory.getPool(token0, token1, fee);

  if (existing !== hre.ethers.ZeroAddress) {
    const pool = new hre.ethers.Contract(existing, POOL_ABI, hre.ethers.provider);
    const slot0 = await pool.slot0();
    console.log(`\nPool already exists: ${existing}`);
    console.log(pools.explorerAddress(chainId, existing));
    console.log(`  sqrtPriceX96:  ${slot0.sqrtPriceX96}`);
    console.log(`  tick:          ${slot0.tick}`);
    console.log(`  price:         ${decodeUsdcPerAsset(slot0.sqrtPriceX96, assetIsToken0)} USDC per ASSET`);
    console.log(`  cardinality:   ${slot0.observationCardinality} (next ${slot0.observationCardinalityNext})`);
    console.log(`\nNothing to do. Deploy against it with LP_POOL=${existing}`);
    pools.recordDeployment(chainId, "UniswapV3Pool", existing, { token0, token1, fee });
    return;
  }

  const sqrtPriceRaw = process.env.LP_INITIAL_SQRT_PRICE_X96;
  if (!sqrtPriceRaw) {
    throw new Error(
      "No pool for this (ASSET, USDC, fee) yet — set LP_INITIAL_SQRT_PRICE_X96 to create it.\n" +
        "  See the header of this script for how to compute it."
    );
  }
  const sqrtPriceX96 = BigInt(sqrtPriceRaw);
  if (sqrtPriceX96 <= 0n) throw new Error("LP_INITIAL_SQRT_PRICE_X96 must be positive");

  console.log(`\nNo pool yet. Creating it at sqrtPriceX96 ${sqrtPriceX96}`);
  console.log(
    `  that is ${decodeUsdcPerAsset(sqrtPriceX96, assetIsToken0)} USDC per ASSET — check this before continuing`
  );

  const positionManager = new hre.ethers.Contract(
    positionManagerAddress,
    POSITION_MANAGER_ABI,
    deployer
  );

  await pools.send("Creating and initializing the pool", deployer, (o) =>
    positionManager.createAndInitializePoolIfNecessary(token0, token1, fee, sqrtPriceX96, o)
  );

  const created = await factory.getPool(token0, token1, fee);
  if (created === hre.ethers.ZeroAddress) {
    throw new Error("Factory still reports no pool after createAndInitializePoolIfNecessary");
  }

  const pool = new hre.ethers.Contract(created, POOL_ABI, hre.ethers.provider);
  const slot0 = await pool.slot0();

  console.log(`\nPool created: ${created}`);
  console.log(pools.explorerAddress(chainId, created));
  console.log(`  sqrtPriceX96: ${slot0.sqrtPriceX96}`);
  console.log(`  tick:         ${slot0.tick}`);
  console.log(`  cardinality:  ${slot0.observationCardinality} (next ${slot0.observationCardinalityNext})`);

  pools.recordDeployment(chainId, "UniswapV3Pool", created, { token0, token1, fee });

  console.log(
    `\nNext:\n` +
      `  1. LP_POOL=${created} npx hardhat run scripts/deploy-lp-staking.js --network ${hre.network.name}\n` +
      `     (it also grows the oracle to LP_OBSERVATION_CARDINALITY, default 150, which it\n` +
      `     refuses to leave below 2 * ceil(LP_TWAP_WINDOW / 12))\n` +
      `  2. Seed liquidity and trade the pool for at least LP_TWAP_WINDOW seconds (default\n` +
      `     300) — a brand-new pool stores one observation, so pool.observe() reverts with\n` +
      `     'OLD' and every TWAP-guarded path reverts with it until the window fills.`
  );
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
