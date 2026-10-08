const fs = require("fs");
const os = require("os");
const path = require("path");

const ethers = require("ethers");
const hre = require("hardhat");

const forkNode = require("./fork-node");
const chain = require("./chain");
const runner = require("./scripts");

/**
 * The world the ApeBond SCRIPT suites run their children against: a plain spawned `hardhat
 * node` (no fork, no endpoint, so it can never skip), the repo's mock market, and the runners
 * that start `hardhat run --network localhost <script>` with a scratch `DEPLOYMENTS_FILE`.
 *
 * Used by `DeployApeBond.test.js`, `ApeBondOperatorScripts.test.js` and
 * `integration/ApeBondUpgradeInPlace.test.js`. Each suite gets its own node, its own scratch
 * directory and its own registry, so none of them can see another's state.
 *
 * The market:
 *   - `MockERC20Decimals` ASSET (18) and USDC (6), minted to the deployer (account 0, which is
 *     also the key every `hardhat run --network localhost` child signs with);
 *   - `MockUniswapV3Pool` (spot = TWAP = tick 0, price 1:1 in raw units, tick spacing 60);
 *   - `MockPositionManager` (bookkeeping liquidity: amount0 + amount1 of what a mint consumes);
 *   - `MockSwapRouter`;
 *   - `MockUniswapV3Factory` with the pool registered, for the deploy script's canonical-pool
 *     check, which has no bypass.
 */

const CHAIN_ID = 31337;
const FEE = 3000;
const TWAP_WINDOW = 300;

/** A campaign every suite can configure: ±1200 ticks around the pool's tick 0, 10 %, 1 ASSET. */
function campaignEnv({ id = "apebond.suite.campaign", cliffSeconds = 600, bps = 1000, minBonus = "1" } = {}) {
  return {
    LP_APEBOND_CAMPAIGN_ID: id,
    LP_APEBOND_HALF_WIDTH_TICKS: "1200",
    LP_APEBOND_CLIFF_SECONDS: String(cliffSeconds),
    LP_APEBOND_BONUS_BPS: String(bps),
    LP_APEBOND_MIN_BONUS: minBonus,
  };
}

/** Starts the node and deploys the market. */
async function startWorld(prefix) {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const registryFile = path.join(scratchDir, "deployments.json");
  const logFile = path.join(scratchDir, "scripts.log");

  const port = await forkNode.getFreePort();
  const node = await forkNode.spawnLocalNode({
    port,
    logFile: path.join(scratchDir, `hardhat-node-${port}.log`),
  });
  const provider = new ethers.JsonRpcProvider(node.rpcUrl, undefined, forkNode.PROVIDER_OPTIONS);
  provider.pollingInterval = 50;
  const fees = await chain.derivePinnedFees(provider);
  const w = chain.makeWallets(provider, fees);

  async function deployArtifact(name, args = [], signer = w.deployer) {
    const artifact = await hre.artifacts.readArtifact(name);
    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
    return (await factory.deploy(...args)).waitForDeployment();
  }
  async function contractAt(name, address, signer = provider) {
    const artifact = await hre.artifacts.readArtifact(name);
    return new ethers.Contract(address, artifact.abi, signer);
  }

  const asset = await deployArtifact("MockERC20Decimals", ["Asset", "ASSET", 10n ** 27n, 18]);
  // The pool mock prices 1:1 in RAW units, so both sides get the same raw supply; the 6
  // decimals are only there for the deploy script's swapped-pair check.
  const usdc = await deployArtifact("MockERC20Decimals", ["USD Coin", "USDC", 10n ** 27n, 6]);
  const assetAddr = await asset.getAddress();
  const usdcAddr = await usdc.getAddress();
  const [token0Addr, token1Addr] =
    assetAddr.toLowerCase() < usdcAddr.toLowerCase() ? [assetAddr, usdcAddr] : [usdcAddr, assetAddr];

  const pool = await deployArtifact("MockUniswapV3Pool", [token0Addr, token1Addr, FEE]);
  const poolAddr = await pool.getAddress();
  const nfpm = await deployArtifact("MockPositionManager");
  const nfpmAddr = await nfpm.getAddress();
  const routerAddr = await (await deployArtifact("MockSwapRouter")).getAddress();
  const factory = await deployArtifact("MockUniswapV3Factory");
  const factoryAddr = await factory.getAddress();
  await chain.send(factory.connect(w.deployer).setPool(token0Addr, token1Addr, FEE, poolAddr));

  const world = {
    scratchDir,
    registryFile,
    logFile,
    node,
    provider,
    fees,
    w,
    deployArtifact,
    contractAt,
    asset,
    usdc,
    assetAddr,
    usdcAddr,
    token0Addr,
    token1Addr,
    pool,
    poolAddr,
    nfpm,
    nfpmAddr,
    routerAddr,
    factoryAddr,
  };

  /** The environment every child gets: the node, the scratch registry, and `extra`. */
  world.baseEnv = (extra = {}) => ({
    LOCALHOST_RPC_URL: node.rpcUrl,
    DEPLOYMENTS_FILE: registryFile,
    ...extra,
  });

  /** The deploy script's full input set for this world. The deployer is the multisig. */
  world.coreEnv = (extra = {}) =>
    world.baseEnv({
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
      LP_OVERTURE_NAME: "Overture",
      LP_OVERTURE_SYMBOL: "OVTR",
      LP_TIMELOCK_MIN_DELAY: "0",
      LP_TWAP_WINDOW: String(TWAP_WINDOW),
      ...extra,
    });

  /** Runs one script. Never throws on a non-zero exit — the tests assert it. */
  world.run = (script, env) => runner.runHardhatScript(`scripts/${script}`, env, { logFile });

  /** Runs a script that must succeed, and says why it did not. */
  world.runOk = async (script, env) => {
    const result = await world.run(script, env);
    if (result.code !== 0) {
      throw new Error(
        `${script} exited ${result.code}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`
      );
    }
    return result;
  };

  world.registry = () => runner.readRegistry(registryFile)[String(CHAIN_ID)] || {};
  world.entry = (kind) => runner.registryEntry(registryFile, CHAIN_ID, kind);

  /** Pushes chain time forward and mines a block. */
  world.advance = async (seconds) => {
    await provider.send("evm_increaseTime", [seconds]);
    await provider.send("evm_mine", []);
  };

  world.stop = async () => {
    await node.stop();
  };
  return world;
}

/**
 * Runs `fn` while the node's clock is pushed forward — five seconds of chain time every 150 ms
 * — so a child waiting out a timelock delay in CHAIN time sees it elapse within seconds.
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
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  })();
  try {
    return await fn();
  } finally {
    running = false;
    await pump;
  }
}

module.exports = { CHAIN_ID, FEE, TWAP_WINDOW, campaignEnv, startWorld, withTimePump };
