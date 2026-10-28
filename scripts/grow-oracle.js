const hre = require("hardhat");
const pools = require("./lib/pools");
const uniswapByChain = require("./lib/uniswap");

// Grow a Uniswap V3 pool's oracle to LP_ORACLE_TARGET slots and make the new size take effect.
//
// ──────────────────────── why this exists (audit L-04) ────────────────────────
//
// The vault's and the zapper's `initialize` / `setTwapParams`, and the ApeBond adapter's
// constructor / `setValuationWindow`, revert unless the pool's CURRENT `observationCardinality`
// is at least ceil(window / 6) + 1 (`contracts/lp-staking/libraries/OracleHistory.sol`). 1800 s,
// the adapter's default valuation window, needs 301 slots.
//
// Growing is two separate facts on a Uniswap V3 pool:
//   1. `increaseObservationCardinalityNext(target)` only PRE-PAYS the slots: it raises
//      `observationCardinalityNext`, not `observationCardinality`;
//   2. the pool switches to the grown size only when its write index wraps the CURRENT buffer.
//      A pool writes at most one observation per block, on a swap that moves the tick or on a
//      liquidity change of an in-range position. From index i in a buffer of c slots that takes
//      (c - i) more writes, each in its own block.
//
// This script does both: it settles a warm-up position (refusing, before anything is sent, a seed
// the signer does not hold or one that would give too little liquidity), sends the growth when
// `observationCardinalityNext` is below the target, then forces the writes itself, one per block, with the cheapest write the signer can
// make without moving the price — `decreaseLiquidity` by ONE unit of liquidity on a tiny in-range
// position it owns (minted once, recorded as `oracleWarmupTokenId` on the pool's registry entry,
// and reused on every later run). It stops as soon as `observationCardinality` reaches the target.
// Other traders' writes count too, so it re-reads slot0 before every write.
//
// It is idempotent: a pool already at the target sends nothing, and an interrupted run resumes
// from wherever the pool is. LP_ORACLE_DRY_RUN=1 prints the plan and sends nothing.
//
// After the size took effect, the pool still has to HOLD the window's worth of history: the
// script prints whether `observe([LP_ORACLE_WINDOW, 0])` answers yet.
//
// ──────────────────────── environment ────────────────────────
//
//   LP_POOL               the pool (default: the UniswapV3Pool entry in deployments.json)
//   LP_ORACLE_TARGET      the observation count to reach (301 = ceil(1800 / 6) + 1)
//   LP_ORACLE_WINDOW      the window to report observe() for (1800)
//   LP_ORACLE_DRY_RUN     1 = print the plan, send nothing
//   LP_ORACLE_SEED_HALF_WIDTH  half-width of the warm-up position, in tick spacings (10)
//   LP_ORACLE_SEED_AMOUNT0 / LP_ORACLE_SEED_AMOUNT1  raw token amounts the warm-up position is
//                         minted with (default: one millionth of the signer's balance of each)
//   LP_NPM                NonfungiblePositionManager (per-chain default, scripts/lib/uniswap.js)
//   CONFIRM=yes           required on mainnet
//
//     LP_ORACLE_TARGET=301 npx hardhat run scripts/grow-oracle.js --network sepolia

const DEFAULT_TARGET = 301;
const DEFAULT_WINDOW = 1800;
const DEFAULT_SEED_HALF_WIDTH = 10;
/** The warm-up position takes this share of the signer's balance of each token by default. */
const DEFAULT_SEED_DIVISOR = 1_000_000n;
const MIN_SECONDS_PER_SLOT = 6; // OracleHistory.MIN_SECONDS_PER_SLOT

const POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)",
  "function increaseObservationCardinalityNext(uint16 observationCardinalityNext)",
];
const NPM_ABI = [
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) payable returns (uint256 amount0, uint256 amount1)",
  "event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
];
const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
];

function readInt(name, fallback, { min, max } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^[0-9]+$/.test(raw.trim())) throw new Error(`${name} must be a non-negative integer — got ${raw}`);
  const value = BigInt(raw.trim());
  if (min !== undefined && value < BigInt(min)) throw new Error(`${name} must be >= ${min} — got ${raw}`);
  if (max !== undefined && value > BigInt(max)) throw new Error(`${name} must be <= ${max} — got ${raw}`);
  return typeof fallback === "bigint" ? value : Number(value);
}

function floorToSpacing(tick, spacing) {
  const rounded = tick - (tick % spacing);
  return rounded > tick ? rounded - spacing : rounded;
}

/** Writes still needed before the pool's index wraps its current buffer of `cardinality`. */
function writesToWrap(slot0) {
  return Number(slot0.observationCardinality) - Number(slot0.observationIndex);
}

/**
 * The liquidity an in-range mint of `amount0` and `amount1` on [lower, upper) gets at the current
 * price, as Uniswap's LiquidityAmounts computes it (the smaller of the two sides), in floating
 * point: an estimate good enough to refuse a seed that gives none.
 */
function seedLiquidity(sqrtPriceX96, lower, upper, amount0, amount1) {
  const q96 = 2 ** 96;
  const sqrtP = Number(sqrtPriceX96) / q96;
  const sqrtA = Math.pow(1.0001, lower / 2);
  const sqrtB = Math.pow(1.0001, upper / 2);
  const l0 = (Number(amount0) * sqrtP * sqrtB) / (sqrtB - sqrtP);
  const l1 = Number(amount1) / (sqrtP - sqrtA);
  return Math.floor(Math.min(l0, l1));
}

async function observeAnswers(pool, window) {
  try {
    await pool.observe([window, 0]);
    return true;
  } catch {
    return false;
  }
}

/** The recorded warm-up position, when the signer still owns it with liquidity left in range. */
async function recordedWarmup(npm, chainId, poolAddress, owner, slot0) {
  const entry = (pools.readRegistry()[String(chainId)] || {}).UniswapV3Pool;
  if (!entry || entry.address.toLowerCase() !== poolAddress.toLowerCase() || !entry.oracleWarmupTokenId) return null;
  const tokenId = BigInt(entry.oracleWarmupTokenId);
  try {
    if ((await npm.ownerOf(tokenId)).toLowerCase() !== owner.toLowerCase()) return null;
    const p = await npm.positions(tokenId);
    const inRange = Number(slot0.tick) >= Number(p.tickLower) && Number(slot0.tick) < Number(p.tickUpper);
    if (p.liquidity === 0n || !inRange) return null;
    return tokenId;
  } catch {
    return null;
  }
}

async function main() {
  const chainId = await pools.chainId();
  const network = hre.network.name;
  const target = readInt("LP_ORACLE_TARGET", DEFAULT_TARGET, { min: 2, max: 65535 });
  const window = readInt("LP_ORACLE_WINDOW", DEFAULT_WINDOW, { min: 1, max: 2 ** 32 - 1 });
  const dryRun = process.env.LP_ORACLE_DRY_RUN === "1";
  const halfWidth = readInt("LP_ORACLE_SEED_HALF_WIDTH", DEFAULT_SEED_HALF_WIDTH, { min: 1, max: 1000 });

  const registry = pools.readRegistry()[String(chainId)] || {};
  const poolAddress = hre.ethers.getAddress(
    process.env.LP_POOL || (registry.UniswapV3Pool && registry.UniswapV3Pool.address) || ""
  );
  const npmAddress = hre.ethers.getAddress(
    process.env.LP_NPM || uniswapByChain.forChain(chainId).positionManager || ""
  );
  const pool = new hre.ethers.Contract(poolAddress, POOL_ABI, hre.ethers.provider);

  let slot0 = await pool.slot0();
  const rule = (target - 1) * MIN_SECONDS_PER_SLOT;
  console.log(`Pool oracle on ${network} (chain ${chainId})`);
  console.log(`Pool:               ${poolAddress}`);
  console.log(`Target:             ${target} slots (the rule ceil(w / 6) + 1 serves windows up to ${rule}s)`);
  console.log(
    `Now:                cardinality ${slot0.observationCardinality}, next ${slot0.observationCardinalityNext}, ` +
      `index ${slot0.observationIndex}`
  );

  if (Number(slot0.observationCardinality) >= target) {
    console.log(`\nAlready at ${slot0.observationCardinality} >= ${target}: nothing to send.`);
    console.log(`observe([${window}, 0]): ${(await observeAnswers(pool, window)) ? "answers" : "reverts (history shorter than the window)"}`);
    return;
  }

  const needsGrowth = Number(slot0.observationCardinalityNext) < target;
  const writes = writesToWrap(slot0);
  console.log(
    `Plan:               ${needsGrowth ? `increaseObservationCardinalityNext(${target}), then ` : ""}` +
      `up to ${writes} forced write(s), one per block, until the index wraps the buffer of ` +
      `${slot0.observationCardinality} (fewer if others trade meanwhile)`
  );
  if (dryRun) {
    console.log("\nLP_ORACLE_DRY_RUN=1: nothing was sent.");
    return;
  }

  pools.requireConfirmation(chainId, `grow the oracle of ${poolAddress} to ${target} slots`);
  const signer = await pools.getSigner();
  const npm = new hre.ethers.Contract(npmAddress, NPM_ABI, signer);

  // The warm-up position: reused when recorded, minted (dust, in range) otherwise.
  let tokenId = await recordedWarmup(npm, chainId, poolAddress, signer.address, slot0);
  if (tokenId === null) {
    const token0 = await pool.token0();
    const token1 = await pool.token1();
    // Dust: both amounts depend on which token is which, so the default is a share of what the
    // signer holds of each.
    const balance0 = await new hre.ethers.Contract(token0, ERC20_ABI, hre.ethers.provider).balanceOf(signer.address);
    const balance1 = await new hre.ethers.Contract(token1, ERC20_ABI, hre.ethers.provider).balanceOf(signer.address);
    const seed0 = readInt("LP_ORACLE_SEED_AMOUNT0", balance0 / DEFAULT_SEED_DIVISOR + 1n);
    const seed1 = readInt("LP_ORACLE_SEED_AMOUNT1", balance1 / DEFAULT_SEED_DIVISOR + 1n);
    const spacing = Number(await pool.tickSpacing());
    const lower = floorToSpacing(Number(slot0.tick), spacing) - halfWidth * spacing;
    const upper = floorToSpacing(Number(slot0.tick), spacing) + (halfWidth + 1) * spacing;
    // Refused BEFORE any approval is paid: the signer must hold the seed, and the seed must give
    // the position at least one unit of liquidity per write still needed (each forced write
    // removes one), or the pool would reject the mint with an opaque revert.
    if (balance0 < seed0 || balance1 < seed1) {
      throw new Error(
        `The signer holds ${balance0} of token0 and ${balance1} of token1, less than the warm-up seed ` +
          `(${seed0} and ${seed1}). Fund the signer with both pool tokens, or set LP_ORACLE_SEED_AMOUNT0 / ` +
          `LP_ORACLE_SEED_AMOUNT1 to amounts it holds.`
      );
    }
    const liquidity = seedLiquidity(slot0.sqrtPriceX96, lower, upper, seed0, seed1);
    const writesNeeded = writesToWrap(slot0);
    if (liquidity < writesNeeded) {
      throw new Error(
        `The warm-up seed (${seed0} of token0, ${seed1} of token1 on [${lower}, ${upper})) gives about ` +
          `${liquidity} unit(s) of liquidity, fewer than the ${writesNeeded} forced writes still needed (one ` +
          `unit each). Set LP_ORACLE_SEED_AMOUNT0 and LP_ORACLE_SEED_AMOUNT1 higher.`
      );
    }
    for (const [address, amount] of [
      [token0, seed0],
      [token1, seed1],
    ]) {
      const token = new hre.ethers.Contract(address, ERC20_ABI, signer);
      await pools.ensureAllowance(token, signer, npmAddress, amount, `${address} -> position manager`);
    }
    const fee = await pool.fee();
    const receipt = await pools.send(`Minting the warm-up position [${lower}, ${upper})`, signer, (o) =>
      npm.mint(
        {
          token0,
          token1,
          fee,
          tickLower: lower,
          tickUpper: upper,
          amount0Desired: seed0,
          amount1Desired: seed1,
          amount0Min: 0,
          amount1Min: 0,
          recipient: signer.address,
          deadline: Math.floor(Date.now() / 1000) + 3600,
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
    tokenId = event.args.tokenId;
    const { address: _ignored, ...rest } = (pools.readRegistry()[String(chainId)] || {}).UniswapV3Pool || {};
    pools.recordDeployment(chainId, "UniswapV3Pool", poolAddress, { ...rest, oracleWarmupTokenId: tokenId.toString() });
    slot0 = await pool.slot0();
  }
  console.log(`Warm-up position:   #${tokenId} (decreaseLiquidity by 1 per forced write)`);

  // The growth comes after the warm-up position is settled, so a seed that cannot work is
  // refused with nothing sent at all.
  if (needsGrowth) {
    await pools.send(`increaseObservationCardinalityNext(${target})`, signer, (o) =>
      pool.connect(signer).increaseObservationCardinalityNext(target, o)
    );
    slot0 = await pool.slot0();
  }

  // One write per block until the grown size took effect.
  let forced = 0;
  while (Number(slot0.observationCardinality) < target) {
    const position = await npm.positions(tokenId);
    if (position.liquidity === 0n) throw new Error(`Warm-up position #${tokenId} has no liquidity left; re-run to mint another`);
    // Out of range, a liquidity change writes no observation: stop instead of spending gas.
    if (Number(slot0.tick) < Number(position.tickLower) || Number(slot0.tick) >= Number(position.tickUpper)) {
      throw new Error(
        `The price left the warm-up position #${tokenId} [${position.tickLower}, ${position.tickUpper}) at tick ` +
          `${slot0.tick}; re-run to mint one around the current price`
      );
    }
    await pools.send(
      `write ${forced + 1}: index ${slot0.observationIndex} of ${slot0.observationCardinality} ` +
        `(${writesToWrap(slot0)} to the wrap, next ${slot0.observationCardinalityNext})`,
      signer,
      (o) =>
        npm.decreaseLiquidity(
          { tokenId, liquidity: 1, amount0Min: 0, amount1Min: 0, deadline: Math.floor(Date.now() / 1000) + 3600 },
          o
        )
    );
    forced += 1;
    slot0 = await pool.slot0();
  }

  console.log(
    `\nDone: cardinality ${slot0.observationCardinality} (target ${target}) after ${forced} forced write(s).`
  );
  console.log(
    `observe([${window}, 0]): ${(await observeAnswers(pool, window)) ? "answers" : "reverts — the pool must still hold " + window + "s of history; wait and re-check"}`
  );
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
