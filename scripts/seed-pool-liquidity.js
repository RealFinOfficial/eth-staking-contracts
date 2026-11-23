const hre = require("hardhat");
const pools = require("./lib/pools");
const uniswapByChain = require("./lib/uniswap");
const { getSqrtRatioAtTick, alignDown, alignUp } = require("./lp-user-rehearsal");

// The FIRST liquidity of a new $ASSET / USDC Uniswap v3 pool on a TEST network: ONE `mint` from the
// deployer, on the range from (1 - LP_SEED_DOWN_PCT %) to (1 + LP_SEED_UP_PCT %) of the pool's
// current price, in USDC per $ASSET.
//
// `create-sepolia-pool.js` creates the pool and records it, then lists "Seed liquidity in range of
// the current price" as the next step; this script is that step. It refuses chains 1 and 43114: on
// the mainnets the first liquidity is not ours to deploy.
//
// ──────────────────────── what it does ────────────────────────
//
//   1. Reads the pool's registry entry (`UniswapV3Pool`, recorded by create-sepolia-pool.js) for the
//      pool and its two tokens, and the position manager from scripts/lib/uniswap.js. $ASSET and
//      USDC are told apart by their decimals (18 and 6) unless LP_ASSET / LP_USDC name them.
//   2. Refuses to run when the registry records a seed position of this pool that the deployer
//      still holds: a rerun never mints twice.
//   3. Reads the price from `slot0().sqrtPriceX96` and computes the two ticks for the token order
//      of the pool: with $ASSET as token0 the raw price grows with the USDC price, with USDC as
//      token0 it shrinks, so the lower price bound becomes the upper tick. The lower tick is
//      rounded DOWN and the upper tick UP to the pool's tick spacing (the band only widens).
//   4. Computes, with the pool's own formulas, the liquidity the two desired amounts give and the
//      amounts that liquidity takes; the mint's minimums are 99 % of those amounts.
//   5. Approves exactly the two desired amounts to the position manager, sends ONE `mint` with the
//      deployer as the recipient and a deadline 20 minutes ahead, then sets both approvals back to
//      zero.
//   6. Records `seedTokenId`, `seedTickLower`, `seedTickUpper`, `seedUsdc`, `seedAsset` (raw units
//      taken) in the pool's registry entry, keeping its other keys, and prints the token id, the
//      ticks, the amounts taken and the pool's liquidity after the mint.
//
// ──────────────────────── environment ────────────────────────
//
//   LP_SEED_USDC          required: USDC to put in, in whole tokens (decimals read from the token)
//   LP_SEED_ASSET         required: $ASSET to put in, in whole tokens
//   LP_SEED_DOWN_PCT      required: the lower bound, percent below the current price (0 < x < 100)
//   LP_SEED_UP_PCT        required: the upper bound, percent above the current price (x > 0)
//   LP_SEED_DRY_RUN       1 = print the ticks and the expected amounts, send nothing
//   LP_POOL               the pool (default: the UniswapV3Pool entry in deployments.json)
//   LP_NPM                NonfungiblePositionManager (per-chain default, scripts/lib/uniswap.js)
//   LP_ASSET / LP_USDC    name the two tokens instead of telling them apart by decimals
//
//     LP_SEED_USDC=50 LP_SEED_ASSET=250 LP_SEED_DOWN_PCT=50 LP_SEED_UP_PCT=100 \
//       npx hardhat run scripts/seed-pool-liquidity.js --network avalanche-fuji

const REFUSED_CHAIN_IDS = new Set([1, 43114]);
const POOL_KIND = "UniswapV3Pool";
const Q96 = 1n << 96n;
const MIN_TICK = -887272;
const MAX_TICK = 887272;
const DEADLINE_SECONDS = 1200;
const LN_TICK = Math.log(1.0001);

const POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
];
const NPM_ABI = [
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
];
const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
];

// ──────────────────────── pure functions ────────────────────────

function refuseMainnet(chainId) {
  if (REFUSED_CHAIN_IDS.has(Number(chainId)) || pools.isMainnet(chainId)) {
    throw new Error(
      `seed-pool-liquidity.js is a test tool, never on chain ${chainId}: on the mainnets the first liquidity is not ours to deploy`
    );
  }
}

function readPct(env, name, { below } = {}) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") throw new Error(`Set ${name}`);
  if (!/^[0-9]+(\.[0-9]+)?$/.test(String(raw).trim())) throw new Error(`${name} must be a number — got ${raw}`);
  const value = Number(raw);
  if (!(value > 0) || (below !== undefined && !(value < below))) {
    throw new Error(`${name} must be above 0${below !== undefined ? ` and below ${below}` : ""} — got ${raw}`);
  }
  return value;
}

function readAmount(env, name) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") throw new Error(`Set ${name} (whole tokens)`);
  if (!/^[0-9]+(\.[0-9]+)?$/.test(String(raw).trim()) || Number(raw) <= 0) {
    throw new Error(`${name} must be a positive amount of whole tokens — got ${raw}`);
  }
  return String(raw).trim();
}

/** The four required inputs; refuses chains 1 and 43114 first. Pure. */
function readInputs(chainId, env) {
  refuseMainnet(chainId);
  return {
    usdc: readAmount(env, "LP_SEED_USDC"),
    asset: readAmount(env, "LP_SEED_ASSET"),
    downPct: readPct(env, "LP_SEED_DOWN_PCT", { below: 100 }),
    upPct: readPct(env, "LP_SEED_UP_PCT"),
    dryRun: env.LP_SEED_DRY_RUN === "1",
  };
}

/**
 * The seed band's two ticks for the current `sqrtPriceX96`: USDC per $ASSET x (1 - down %) and
 * x (1 + up %), mapped onto the pool's raw price (token1 per token0) for the token order, then the
 * lower tick rounded down and the upper tick rounded up to `spacing`.
 */
function seedTicks({ sqrtPriceX96, assetIsToken0, downPct, upPct, spacing }) {
  const priceTick = (2 * Math.log(Number(BigInt(sqrtPriceX96)) / Number(Q96))) / LN_TICK;
  const downTicks = Math.log(1 - downPct / 100) / LN_TICK; // negative
  const upTicks = Math.log(1 + upPct / 100) / LN_TICK; // positive
  // $ASSET token0: raw = USDC per $ASSET x 1e-12, so the bounds keep their sides.
  // USDC token0: raw = 1e12 / (USDC per $ASSET), so the lower USDC price is the higher tick.
  const lowerExact = assetIsToken0 ? priceTick + downTicks : priceTick - upTicks;
  const upperExact = assetIsToken0 ? priceTick + upTicks : priceTick - downTicks;
  const tickLower = alignDown(lowerExact, spacing) + 0; // + 0 turns a -0 into 0
  const tickUpper = alignUp(upperExact, spacing) + 0;
  if (tickLower < MIN_TICK || tickUpper > MAX_TICK || tickLower >= tickUpper) {
    throw new Error(`The seed band [${tickLower}, ${tickUpper}) is outside the pool's tick range`);
  }
  return { tickLower, tickUpper };
}

function liquidityForAmount0(lo, hi, amount0) {
  return (amount0 * ((lo * hi) / Q96)) / (hi - lo);
}

function liquidityForAmount1(lo, hi, amount1) {
  return (amount1 * Q96) / (hi - lo);
}

function amount0ForLiquidity(lo, hi, liquidity) {
  return ((liquidity << 96n) * (hi - lo)) / hi / lo;
}

function amount1ForLiquidity(lo, hi, liquidity) {
  return (liquidity * (hi - lo)) / Q96;
}

/**
 * v3-periphery LiquidityAmounts: the liquidity the two desired amounts give on the band at the
 * current price (the side that runs out first binds), the amounts that liquidity takes, and the
 * mint's minimums, 99 % of each.
 */
function expectedAmounts({ sqrtPriceX96, tickLower, tickUpper, amount0Desired, amount1Desired }) {
  const sqrtP = BigInt(sqrtPriceX96);
  const lo = getSqrtRatioAtTick(tickLower);
  const hi = getSqrtRatioAtTick(tickUpper);
  const a0 = BigInt(amount0Desired);
  const a1 = BigInt(amount1Desired);
  let liquidity;
  let amount0 = 0n;
  let amount1 = 0n;
  if (sqrtP <= lo) {
    liquidity = liquidityForAmount0(lo, hi, a0);
    amount0 = amount0ForLiquidity(lo, hi, liquidity);
  } else if (sqrtP < hi) {
    const l0 = liquidityForAmount0(sqrtP, hi, a0);
    const l1 = liquidityForAmount1(lo, sqrtP, a1);
    liquidity = l0 < l1 ? l0 : l1;
    amount0 = amount0ForLiquidity(sqrtP, hi, liquidity);
    amount1 = amount1ForLiquidity(lo, sqrtP, liquidity);
  } else {
    liquidity = liquidityForAmount1(lo, hi, a1);
    amount1 = amount1ForLiquidity(lo, hi, liquidity);
  }
  return { liquidity, amount0, amount1, amount0Min: (amount0 * 99n) / 100n, amount1Min: (amount1 * 99n) / 100n };
}

// ──────────────────────── the run ────────────────────────

function sameAddress(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

/** Which of the pool's two tokens is $ASSET and which USDC: LP_ASSET / LP_USDC, else by decimals. */
async function identifyTokens(env, token0, token1) {
  const decimals0 = Number(await new hre.ethers.Contract(token0, ERC20_ABI, hre.ethers.provider).decimals());
  const decimals1 = Number(await new hre.ethers.Contract(token1, ERC20_ABI, hre.ethers.provider).decimals());
  let usdc;
  if (env.LP_USDC) usdc = hre.ethers.getAddress(env.LP_USDC);
  else if (env.LP_ASSET) usdc = sameAddress(env.LP_ASSET, token0) ? token1 : token0;
  else if (decimals0 === 6 && decimals1 === 18) usdc = token0;
  else if (decimals0 === 18 && decimals1 === 6) usdc = token1;
  else {
    throw new Error(
      `Cannot tell $ASSET from USDC by decimals (token0 ${decimals0}, token1 ${decimals1}); set LP_ASSET or LP_USDC`
    );
  }
  if (!sameAddress(usdc, token0) && !sameAddress(usdc, token1)) throw new Error(`LP_USDC ${usdc} is not a token of the pool`);
  if (env.LP_ASSET && sameAddress(env.LP_ASSET, usdc)) throw new Error("LP_ASSET and LP_USDC name the same token");
  const usdcIsToken0 = sameAddress(usdc, token0);
  return {
    assetIsToken0: !usdcIsToken0,
    usdc: usdcIsToken0 ? token0 : token1,
    asset: usdcIsToken0 ? token1 : token0,
    usdcDecimals: usdcIsToken0 ? decimals0 : decimals1,
    assetDecimals: usdcIsToken0 ? decimals1 : decimals0,
  };
}

/**
 * The whole step, in-process (main and the suite call it). Returns the plan, and after a mint the
 * token id and the amounts taken.
 */
async function seedPool({ env, deployer }) {
  const chainId = await pools.chainId();
  const inputs = readInputs(chainId, env);

  const entry = pools.readRegistry()[String(chainId)]?.[POOL_KIND] || {};
  const poolAddress = hre.ethers.getAddress(env.LP_POOL || entry.address || "");
  if (!poolAddress) throw new Error(`No ${POOL_KIND} recorded for chain ${chainId}; set LP_POOL`);
  const npmAddress = env.LP_NPM || uniswapByChain.forChain(chainId).positionManager;
  if (!npmAddress) throw new Error(`No position manager for chain ${chainId}; set LP_NPM`);
  const pool = new hre.ethers.Contract(poolAddress, POOL_ABI, hre.ethers.provider);
  const npm = new hre.ethers.Contract(npmAddress, NPM_ABI, deployer);

  const token0 = hre.ethers.getAddress(await pool.token0());
  const token1 = hre.ethers.getAddress(await pool.token1());
  const entryMatches = sameAddress(entry.address || "", poolAddress);
  if (entryMatches && entry.token0 && (!sameAddress(entry.token0, token0) || !sameAddress(entry.token1, token1))) {
    throw new Error(`The registry records ${entry.token0} / ${entry.token1} for ${poolAddress}, the pool reports ${token0} / ${token1}`);
  }

  // A rerun never mints twice.
  if (entryMatches && entry.seedTokenId) {
    let owner = null;
    try {
      owner = await npm.ownerOf(BigInt(entry.seedTokenId));
    } catch {
      owner = null;
    }
    if (owner && sameAddress(owner, deployer.address)) {
      throw new Error(
        `The deployer ${deployer.address} already holds the seed position #${entry.seedTokenId} of ${poolAddress} ` +
          "(recorded in the registry); the first liquidity is minted once"
      );
    }
  }

  const t = await identifyTokens(env, token0, token1);
  const fee = await pool.fee();
  const spacing = Number(await pool.tickSpacing());
  const slot0 = await pool.slot0();
  const usdcDesired = hre.ethers.parseUnits(inputs.usdc, t.usdcDecimals);
  const assetDesired = hre.ethers.parseUnits(inputs.asset, t.assetDecimals);
  const { tickLower, tickUpper } = seedTicks({
    sqrtPriceX96: slot0.sqrtPriceX96,
    assetIsToken0: t.assetIsToken0,
    downPct: inputs.downPct,
    upPct: inputs.upPct,
    spacing,
  });
  const [amount0Desired, amount1Desired] = t.assetIsToken0 ? [assetDesired, usdcDesired] : [usdcDesired, assetDesired];
  const e = expectedAmounts({ sqrtPriceX96: slot0.sqrtPriceX96, tickLower, tickUpper, amount0Desired, amount1Desired });
  const expected = {
    usdc: t.assetIsToken0 ? e.amount1 : e.amount0,
    asset: t.assetIsToken0 ? e.amount0 : e.amount1,
  };
  const price = (() => {
    const raw = (Number(slot0.sqrtPriceX96) / Number(Q96)) ** 2 * 10 ** (t.assetIsToken0 ? t.assetDecimals - t.usdcDecimals : t.usdcDecimals - t.assetDecimals);
    return t.assetIsToken0 ? raw : 1 / raw;
  })();

  console.log(`Seed liquidity on chain ${chainId}`);
  console.log(`Pool:               ${poolAddress} (fee ${fee}, tick spacing ${spacing})`);
  console.log(`Position manager:   ${npmAddress}`);
  console.log(`token0 / token1:    ${token0} (${t.assetIsToken0 ? "$ASSET" : "USDC"}) / ${token1} (${t.assetIsToken0 ? "USDC" : "$ASSET"})`);
  console.log(`Deployer:           ${deployer.address}`);
  console.log(`Price now:          ${price} USDC per $ASSET (tick ${slot0.tick})`);
  console.log(`Band:               -${inputs.downPct} % / +${inputs.upPct} % -> ticks [${tickLower}, ${tickUpper})`);
  console.log(`Desired:            ${inputs.usdc} USDC, ${inputs.asset} $ASSET`);
  console.log(
    `Expected taken:     ${hre.ethers.formatUnits(expected.usdc, t.usdcDecimals)} USDC, ` +
      `${hre.ethers.formatUnits(expected.asset, t.assetDecimals)} $ASSET (minimums 99 %), liquidity ${e.liquidity}`
  );

  const plan = { chainId, poolAddress, npmAddress, tickLower, tickUpper, expected, liquidity: e.liquidity };
  if (inputs.dryRun) {
    console.log("\nLP_SEED_DRY_RUN=1: nothing was sent.");
    return { ...plan, dryRun: true };
  }

  const asset = new hre.ethers.Contract(t.asset, ERC20_ABI, deployer);
  const usdc = new hre.ethers.Contract(t.usdc, ERC20_ABI, deployer);
  if ((await asset.balanceOf(deployer.address)) < assetDesired || (await usdc.balanceOf(deployer.address)) < usdcDesired) {
    throw new Error(`The deployer holds less than ${inputs.asset} $ASSET or ${inputs.usdc} USDC; nothing was sent`);
  }

  await pools.send(`Approving ${inputs.asset} $ASSET to the position manager`, deployer, (o) =>
    asset.approve(npmAddress, assetDesired, o)
  );
  await pools.send(`Approving ${inputs.usdc} USDC to the position manager`, deployer, (o) =>
    usdc.approve(npmAddress, usdcDesired, o)
  );
  const now = (await hre.ethers.provider.getBlock("latest")).timestamp;
  const receipt = await pools.send(`Minting the seed position [${tickLower}, ${tickUpper})`, deployer, (o) =>
    npm.mint(
      {
        token0,
        token1,
        fee,
        tickLower,
        tickUpper,
        amount0Desired,
        amount1Desired,
        amount0Min: e.amount0Min,
        amount1Min: e.amount1Min,
        recipient: deployer.address,
        deadline: now + DEADLINE_SECONDS,
      },
      o
    )
  );
  const event = receipt.logs
    .map((log) => {
      try {
        return npm.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed && parsed.name === "IncreaseLiquidity");
  // The math-rung test double emits no IncreaseLiquidity; it keeps the last id instead.
  let tokenId;
  let taken0;
  let taken1;
  if (event) {
    ({ tokenId, amount0: taken0, amount1: taken1 } = event.args);
  } else {
    const probe = new hre.ethers.Contract(npmAddress, ["function lastMintedId() view returns (uint256)"], hre.ethers.provider);
    tokenId = await probe.lastMintedId();
    ({ amount0: taken0, amount1: taken1 } = e);
  }

  // Both approvals back to zero, whatever the mint left of them.
  await pools.send("Resetting the $ASSET approval to zero", deployer, (o) => asset.approve(npmAddress, 0, o));
  await pools.send("Resetting the USDC approval to zero", deployer, (o) => usdc.approve(npmAddress, 0, o));

  const usdcTaken = t.assetIsToken0 ? taken1 : taken0;
  const assetTaken = t.assetIsToken0 ? taken0 : taken1;
  const current = pools.readRegistry()[String(chainId)]?.[POOL_KIND] || {};
  const { address: _ignored, ...rest } = sameAddress(current.address || "", poolAddress) ? current : { token0, token1, fee: Number(fee) };
  pools.recordDeployment(chainId, POOL_KIND, poolAddress, {
    ...rest,
    seedTokenId: tokenId.toString(),
    seedTickLower: tickLower,
    seedTickUpper: tickUpper,
    seedUsdc: usdcTaken.toString(),
    seedAsset: assetTaken.toString(),
  });

  let poolLiquidity;
  try {
    poolLiquidity = (await pool.liquidity()).toString();
  } catch {
    poolLiquidity = "not answered by this pool";
  }
  console.log(`\nSeed position:      #${tokenId}`);
  console.log(`Ticks:              [${tickLower}, ${tickUpper})`);
  console.log(
    `Taken:              ${hre.ethers.formatUnits(usdcTaken, t.usdcDecimals)} USDC, ` +
      `${hre.ethers.formatUnits(assetTaken, t.assetDecimals)} $ASSET`
  );
  console.log(`Pool liquidity:     ${poolLiquidity}`);
  return { ...plan, dryRun: false, tokenId, usdcTaken, assetTaken, poolLiquidity };
}

async function main() {
  const chainId = await pools.chainId();
  refuseMainnet(chainId);
  const deployer = await pools.getSigner();
  await seedPool({ env: process.env, deployer });
}

module.exports = { REFUSED_CHAIN_IDS, refuseMainnet, readInputs, seedTicks, expectedAmounts, seedPool };

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
