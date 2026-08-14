/**
 * Mainnet-fork integration tests for the LP staking stack.
 *
 * These tests run the real contracts against the real Uniswap V3 ASSET/USDC 0.30% pool,
 * the real NonfungiblePositionManager and the real SwapRouter02, funded by an impersonated
 * USDC whale. Everything the unit suite fakes with mocks is real here: tick spacing,
 * fee accrual, the oracle, EIP-2612 and EIP-4494 domains.
 *
 * The suite is self-contained. It never edits hardhat.config.js: it forks with
 * `hardhat_reset` inside `before` and resets back to a clean local network in `after`, so
 * running it alongside the unit suite is order-independent.
 *
 * No RPC, no problem: when the fork cannot be established (no endpoint reachable, archive
 * state gated, rate limit) the whole suite is skipped, not failed, so `npx hardhat test`
 * stays green on a machine with no .env.
 */

const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const { takeSnapshot } = require("@nomicfoundation/hardhat-network-helpers");

// ─────────────────────────── Mainnet constants ───────────────────────────

/** Verified mainnet addresses, in canonical EIP-55 checksummed form. */
const NPM_ADDR = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const ROUTER_ADDR = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const POOL_ADDR = "0xe76532bae172876B6c7170Ce02309715502c360B";
const ASSET_ADDR = "0x99E980265Bf36516C442be982df1772a6cCb3233"; // "REAL", 18 decimals, EIP-2612 v"1"
const USDC_ADDR = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"; // 6 decimals, EIP-2612 v"2"

const FEE = 3000;
const TICK_SPACING = 60;
const MIN_TICK_ALIGNED = -887220; // floor(-887272 / 60) * 60
const MAX_TICK_ALIGNED = 887220;

/** Pinned so every run sees the same pool state, the same liquidity and the same price. */
const PINNED_BLOCK = 25750000;

/**
 * RPC resolution, in the order the runbook specifies:
 *   MAINNET_RPC_URL -> INFURA_API_KEY -> public fallback.
 *
 * When neither env var is set the public default is tried first and, only then, a few
 * further public endpoints. The default (`ethereum-rpc.publicnode.com`) serves head state
 * but rejects historical state with "Archive requests require a personal token", which a
 * pinned-block fork needs on its very first read, so without the extra candidates the
 * suite could only ever skip. An explicitly configured endpoint is always used alone.
 */
const PUBLIC_FALLBACK_RPC = "https://ethereum-rpc.publicnode.com";
const EXTRA_PUBLIC_ARCHIVE_RPCS = [
  "https://eth-mainnet.public.blastapi.io",
  "https://eth-pokt.nodies.app",
  "https://eth.drpc.org",
  "https://eth.merkle.io",
];

function resolveRpcCandidates() {
  if (process.env.MAINNET_RPC_URL) return [process.env.MAINNET_RPC_URL];
  if (process.env.INFURA_API_KEY) {
    return [`https://mainnet.infura.io/v3/${process.env.INFURA_API_KEY}`];
  }
  return [PUBLIC_FALLBACK_RPC, ...EXTRA_PUBLIC_ARCHIVE_RPCS];
}

/**
 * USDC holders at {@link PINNED_BLOCK}, largest first. The first one whose balance covers
 * the test budget is used; the assertion below fails loudly if none does.
 */
const USDC_WHALES = [
  "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf", // Polygon (Matic) ERC20 bridge
  "0xA9D1e08C7793af67e9d92fe308d5697FB81d3E43", // Coinbase 10
  "0xcEe284F754E854890e311e3280b767F80797180d", // Arbitrum One bridge
  "0x55FE002aefF02F77364de339a1292923A15844B8", // Circle
  "0xf89d7b9c864f589bbF53a82105107622B35EaA40", // Bybit
];

// ─────────────────────────── Test parameters ───────────────────────────

const USDC = (n) => BigInt(Math.round(n * 1e6));
const ASSET = (n) => ethers.parseUnits(String(n), 18);

/** Total USDC the suite needs the whale to be able to hand out and to trade with. */
const WHALE_BUDGET = USDC(1_000_000);
/** Handed to each test signer up front. */
const USER_USDC = USDC(50_000);
/** Each LP swaps this much USDC into ASSET so it can mint a two-sided position. */
const ASSET_FUNDING_USDC = USDC(1_500);

const TWAP_WINDOW = 300; // TwapGuard.MIN_TWAP_WINDOW — shortest legal window, shortest warm-up
const MAX_DEVIATION_BPS = 500;

const WARMUP_STEPS = 8;
const WARMUP_STEP_SECONDS = 60; // 8 * 60 = 480s of history for a 300s window
const WARMUP_SWAP_USDC = USDC(25);

/** How far past the guard's ceiling the manipulation test pushes spot. */
const MANIPULATION_TICKS = MAX_DEVIATION_BPS + 500;
/** Hard ceiling on the manipulation swap; the price limit normally stops it well before. */
const MANIPULATION_MAX_USDC = USDC(2_000_000);

const FAR_DEADLINE = 10n ** 12n;
const MAX_UINT128 = (1n << 128n) - 1n;
const ZERO = ethers.ZeroAddress;

// ─────────────────────────── Minimal ABIs ───────────────────────────

const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function nonces(address) view returns (uint256)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function permit(address owner,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)",
];

const POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives,uint160[] secondsPerLiquidityCumulativeX128s)",
  "function increaseObservationCardinalityNext(uint16)",
];

const NPM_ABI = [
  "function positions(uint256) view returns (uint96 nonce,address operator,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128,uint128 tokensOwed0,uint128 tokensOwed1)",
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
  "function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline)) payable returns (uint256 amount0,uint256 amount1)",
  "function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) payable returns (uint256 amount0,uint256 amount1)",
  "function ownerOf(uint256) view returns (address)",
  "function getApproved(uint256) view returns (address)",
  "function approve(address,uint256)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)",
];

const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
];

// ─────────────────────────── Suite ───────────────────────────

describe("LP staking — mainnet fork (Uniswap V3 ASSET/USDC 0.30%)", function () {
  // Public RPCs are slow and the setup runs dozens of real transactions.
  this.timeout(30 * 60 * 1000);

  let forked = false;
  let rpcUsed = null;
  let chainId;
  let snapshot;

  let deployer, alice, bob, carol, dave;
  let whale, whaleAddr;

  let pool, npm, npmRead, router, asset, usdc;
  let vault, zapper, vaultAddr, zapperAddr;

  // Reported by the manipulation test, printed at the end of the run.
  const notes = [];

  // ── helpers ────────────────────────────────────────────────────────────

  async function rpcSend(method, params = []) {
    return network.provider.request({ method, params });
  }

  async function resetToLocal() {
    await rpcSend("hardhat_reset", []);
  }

  /** Forks at the pinned block and proves archive state really is served. */
  async function tryFork(url) {
    await rpcSend("hardhat_reset", [{ forking: { jsonRpcUrl: url, blockNumber: PINNED_BLOCK } }]);

    const probe = new ethers.Contract(POOL_ADDR, POOL_ABI, ethers.provider);
    const [t0, t1, f, spacing] = await Promise.all([
      probe.token0(),
      probe.token1(),
      probe.fee(),
      probe.tickSpacing(),
    ]);
    expect(t0).to.equal(ASSET_ADDR);
    expect(t1).to.equal(USDC_ADDR);
    expect(f).to.equal(FEE);
    expect(spacing).to.equal(TICK_SPACING);

    const block = await ethers.provider.getBlockNumber();
    expect(block).to.equal(PINNED_BLOCK);
  }

  async function impersonate(addr) {
    await rpcSend("hardhat_impersonateAccount", [addr]);
    await rpcSend("hardhat_setBalance", [addr, "0x21e19e0c9bab2400000"]); // 10_000 ETH for gas
    return ethers.getSigner(addr);
  }

  async function advance(seconds) {
    await rpcSend("evm_increaseTime", [seconds]);
    await rpcSend("evm_mine", []);
  }

  async function currentTick() {
    const s = await pool.slot0();
    return Number(s.tick);
  }

  function alignDown(tick) {
    return Math.floor(tick / TICK_SPACING) * TICK_SPACING;
  }

  /**
   * sqrtPriceX96 for a tick, as a float approximation. Only ever used as a swap stop
   * price, never as a value assertion, so the last few digits do not matter.
   */
  function sqrtPriceX96AtTick(tick) {
    return BigInt(Math.floor(Math.pow(1.0001, tick / 2) * 2 ** 96));
  }

  async function swapUsdcForAsset(signer, amountIn, sqrtPriceLimitX96 = 0n) {
    return router.connect(signer).exactInputSingle({
      tokenIn: USDC_ADDR,
      tokenOut: ASSET_ADDR,
      fee: FEE,
      recipient: await signer.getAddress(),
      amountIn,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96,
    });
  }

  async function swapAssetForUsdc(signer, amountIn) {
    return router.connect(signer).exactInputSingle({
      tokenIn: ASSET_ADDR,
      tokenOut: USDC_ADDR,
      fee: FEE,
      recipient: await signer.getAddress(),
      amountIn,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n,
    });
  }

  function mintedTokenId(receipt) {
    const topic = ethers.id("Transfer(address,address,uint256)");
    for (const log of receipt.logs) {
      if (
        log.address.toLowerCase() === NPM_ADDR.toLowerCase() &&
        log.topics[0] === topic &&
        log.topics.length === 4 &&
        BigInt(log.topics[1]) === 0n
      ) {
        return BigInt(log.topics[3]);
      }
    }
    throw new Error("no NFT mint Transfer log in receipt");
  }

  function parseEvent(receipt, contract, address, name) {
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== address.toLowerCase()) continue;
      let parsed = null;
      try {
        parsed = contract.interface.parseLog(log);
      } catch {
        continue;
      }
      if (parsed && parsed.name === name) return parsed.args;
    }
    throw new Error(`no ${name} event in receipt`);
  }

  /** Mints a real Uniswap V3 position for `signer` and returns its tokenId. */
  async function mintPosition(signer, tickLower, tickUpper, amount0Desired, amount1Desired) {
    const receipt = await (
      await npm.connect(signer).mint({
        token0: ASSET_ADDR,
        token1: USDC_ADDR,
        fee: FEE,
        tickLower,
        tickUpper,
        amount0Desired,
        amount1Desired,
        amount0Min: 0n,
        amount1Min: 0n,
        recipient: await signer.getAddress(),
        deadline: FAR_DEADLINE,
      })
    ).wait();
    return mintedTokenId(receipt);
  }

  /** Mints a position centred on spot, approves the vault and stakes it. */
  async function stakeFreshPosition(signer, halfWidthSpacings = 20) {
    const centre = alignDown(await currentTick());
    const width = halfWidthSpacings * TICK_SPACING;
    const tickLower = centre - width;
    const tickUpper = centre + width;
    const tokenId = await mintPosition(signer, tickLower, tickUpper, ASSET(4000), USDC(1000));
    await (await npm.connect(signer).approve(vaultAddr, tokenId)).wait();
    await (await vault.connect(signer).stake(tokenId)).wait();
    return { tokenId, tickLower, tickUpper };
  }

  /** Round-trips real volume through the pool so staked positions accrue real fees. */
  async function generateTradingFees(rounds = 3, sizeUsdc = USDC(2_000)) {
    for (let i = 0; i < rounds; i++) {
      const before = await asset.balanceOf(whaleAddr);
      await (await swapUsdcForAsset(whale, sizeUsdc)).wait();
      const gained = (await asset.balanceOf(whaleAddr)) - before;
      await advance(30);
      await (await swapAssetForUsdc(whale, gained)).wait();
      await advance(30);
    }
  }

  /**
   * Resolves the EIP-712 domain a token actually uses by matching a candidate against its
   * on-chain DOMAIN_SEPARATOR. Needed because the fork reports chainId 31337 while some
   * tokens (USDC) keep a separator cached from chainId 1 and others (ASSET, the position
   * manager) recompute it from `block.chainid`. Throws when neither candidate matches,
   * which is exactly the signal that the documented name/version is wrong.
   */
  async function resolveDomain(address, name, version) {
    const token = new ethers.Contract(address, ERC20_ABI, ethers.provider);
    const onChain = await token.DOMAIN_SEPARATOR();
    for (const candidate of [chainId, 1n]) {
      const domain = { name, version, chainId: candidate, verifyingContract: address };
      if (ethers.TypedDataEncoder.hashDomain(domain) === onChain) return { domain, onChain };
    }
    throw new Error(
      `EIP-712 domain mismatch at ${address} for name="${name}" version="${version}": on-chain ${onChain}`
    );
  }

  async function signErc2612(token, tokenName, tokenVersion, owner, spender, value, deadline) {
    const { domain } = await resolveDomain(await token.getAddress(), tokenName, tokenVersion);
    const nonce = await token.nonces(owner.address);
    const types = {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };
    const sig = await owner.signTypedData(domain, types, {
      owner: owner.address,
      spender,
      value,
      nonce,
      deadline,
    });
    return ethers.Signature.from(sig);
  }

  async function signNftPermit(owner, spender, tokenId, deadline) {
    const { domain } = await resolveDomain(NPM_ADDR, "Uniswap V3 Positions NFT-V1", "1");
    const nonce = (await npm.positions(tokenId)).nonce;
    const types = {
      Permit: [
        { name: "spender", type: "address" },
        { name: "tokenId", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };
    const sig = await owner.signTypedData(domain, types, { spender, tokenId, nonce, deadline });
    return ethers.Signature.from(sig);
  }

  /** What the vault would pull out of a position: principal, then accrued fees. */
  async function previewWithdraw(tokenId) {
    const position = await npm.positions(tokenId);
    const [principal0, principal1] = await npmRead.decreaseLiquidity.staticCall(
      {
        tokenId,
        liquidity: position.liquidity,
        amount0Min: 0n,
        amount1Min: 0n,
        deadline: FAR_DEADLINE,
      },
      { from: vaultAddr }
    );
    const [fees0, fees1] = await npmRead.collect.staticCall(
      { tokenId, recipient: vaultAddr, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 },
      { from: vaultAddr }
    );
    return { principal0, principal1, fees0, fees1, liquidity: position.liquidity };
  }

  /**
   * Pushes spot up by {@link MANIPULATION_TICKS} using a price-limited whale swap, so the
   * pool stops the swap itself and the size stays bounded no matter how the liquidity is
   * distributed. Returns what it cost and what it achieved.
   */
  async function manipulateSpotUpwards() {
    const spotBefore = await currentTick();
    const poolAssetBefore = await asset.balanceOf(POOL_ADDR);
    const limit = sqrtPriceX96AtTick(spotBefore + MANIPULATION_TICKS);

    const usdcBefore = await usdc.balanceOf(whaleAddr);
    await (await swapUsdcForAsset(whale, MANIPULATION_MAX_USDC, limit)).wait();
    const spent = usdcBefore - (await usdc.balanceOf(whaleAddr));

    const spotAfter = await currentTick();
    const poolAssetAfter = await asset.balanceOf(POOL_ADDR);

    expect(spent).to.be.lessThan(MANIPULATION_MAX_USDC); // the price limit, not the cap, stopped it
    expect(poolAssetAfter).to.be.greaterThan(0n); // the pool survived

    return {
      spent,
      spotBefore,
      spotAfter,
      assetDrainedPct: Number(((poolAssetBefore - poolAssetAfter) * 10000n) / poolAssetBefore) / 100,
    };
  }

  // ── setup ──────────────────────────────────────────────────────────────

  before(async function () {
    const candidates = resolveRpcCandidates();
    const failures = [];

    for (const url of candidates) {
      try {
        await tryFork(url);
        rpcUsed = url;
        forked = true;
        break;
      } catch (error) {
        failures.push(`${url}: ${error.shortMessage || error.message}`);
      }
    }

    if (!forked) {
      console.warn(
        `\n  [fork] skipping mainnet-fork suite — no usable RPC for block ${PINNED_BLOCK}:\n    ` +
          failures.join("\n    ") +
          "\n  Set MAINNET_RPC_URL (archive access required) to run it.\n"
      );
      await resetToLocal().catch(() => {});
      this.skip();
      return;
    }

    try {
      chainId = (await ethers.provider.getNetwork()).chainId;
      [deployer, alice, bob, carol, dave] = await ethers.getSigners();

      pool = new ethers.Contract(POOL_ADDR, POOL_ABI, deployer);
      npm = new ethers.Contract(NPM_ADDR, NPM_ABI, deployer);
      // Provider-connected twin: a signer-connected contract refuses a `from` override,
      // and the withdraw preview has to be simulated as the vault.
      npmRead = new ethers.Contract(NPM_ADDR, NPM_ABI, ethers.provider);
      router = new ethers.Contract(ROUTER_ADDR, ROUTER_ABI, deployer);
      asset = new ethers.Contract(ASSET_ADDR, ERC20_ABI, deployer);
      usdc = new ethers.Contract(USDC_ADDR, ERC20_ABI, deployer);

      // 1. Pick a USDC whale that can actually cover the budget.
      const balances = [];
      for (const candidate of USDC_WHALES) {
        const balance = await usdc.balanceOf(candidate);
        balances.push(`${candidate} ${(balance / 10n ** 6n).toString()}`);
        if (balance >= WHALE_BUDGET) {
          whaleAddr = candidate;
          break;
        }
      }
      expect(whaleAddr, `no USDC holder covers ${WHALE_BUDGET} at block ${PINNED_BLOCK}: ${balances.join(", ")}`)
        .to.not.equal(undefined);
      whale = await impersonate(whaleAddr);
      expect(await usdc.balanceOf(whaleAddr)).to.be.greaterThanOrEqual(WHALE_BUDGET);

      // 2. Fund the test signers.
      for (const user of [deployer, alice, bob, carol, dave]) {
        await (await usdc.connect(whale).transfer(user.address, USER_USDC)).wait();
      }

      // 3. Grow the oracle. The live pool sits at cardinality 1, so `observe([300, 0])`
      //    reverts "OLD" until this runs — exactly as the deployment runbook describes.
      await (await pool.increaseObservationCardinalityNext(100)).wait();

      // 4. Standing approvals for the real router and position manager.
      for (const user of [deployer, alice, bob, carol, dave, whale]) {
        await (await usdc.connect(user).approve(ROUTER_ADDR, ethers.MaxUint256)).wait();
        await (await asset.connect(user).approve(ROUTER_ADDR, ethers.MaxUint256)).wait();
        await (await usdc.connect(user).approve(NPM_ADDR, ethers.MaxUint256)).wait();
        await (await asset.connect(user).approve(NPM_ADDR, ethers.MaxUint256)).wait();
      }

      // 5. Give the LPs an ASSET side to mint with.
      for (const user of [alice, bob]) {
        await (await swapUsdcForAsset(user, ASSET_FUNDING_USDC)).wait();
        await advance(30);
      }

      // 6. Warm the oracle up past the TWAP window with real, tiny swaps.
      for (let i = 0; i < WARMUP_STEPS; i++) {
        await advance(WARMUP_STEP_SECONDS);
        await (await swapUsdcForAsset(deployer, WARMUP_SWAP_USDC)).wait();
      }

      // 7. Deploy the stack against the real pool.
      const Vault = await ethers.getContractFactory("LPStakingVault");
      vault = await Vault.deploy(
        NPM_ADDR,
        POOL_ADDR,
        ASSET_ADDR,
        USDC_ADDR,
        FEE,
        ROUTER_ADDR,
        deployer.address,
        TWAP_WINDOW,
        MAX_DEVIATION_BPS
      );
      await vault.waitForDeployment();
      vaultAddr = await vault.getAddress();

      const Zapper = await ethers.getContractFactory("LPZapper");
      zapper = await Zapper.deploy(
        vaultAddr,
        NPM_ADDR,
        POOL_ADDR,
        ASSET_ADDR,
        USDC_ADDR,
        FEE,
        ROUTER_ADDR,
        USDC_ADDR,
        ASSET_ADDR,
        deployer.address,
        TWAP_WINDOW,
        MAX_DEVIATION_BPS
      );
      await zapper.waitForDeployment();
      zapperAddr = await zapper.getAddress();
      await (await vault.setZapper(zapperAddr)).wait();

      // 8. The guard must be readable before any guarded path is exercised.
      const preview = await vault.previewTwap();
      expect(preview.withinBounds).to.equal(true);

      notes.push(
        `rpc=${rpcUsed} block=${PINNED_BLOCK} chainId=${chainId} whale=${whaleAddr}`,
        `spot tick after warm-up=${preview.currentTick} twap=${preview.twapTick} pool liquidity=${await pool.liquidity()}`
      );

      snapshot = await takeSnapshot();
    } catch (error) {
      console.warn(
        `\n  [fork] skipping mainnet-fork suite — setup failed against ${rpcUsed}:\n    ` +
          (error.stack || error.message) +
          "\n"
      );
      forked = false;
      await resetToLocal().catch(() => {});
      this.skip();
    }
  });

  beforeEach(async function () {
    await snapshot.restore();
    // Impersonation is node state, not EVM state; re-arm it after every revert.
    whale = await impersonate(whaleAddr);
  });

  after(async function () {
    for (const note of notes) console.log(`  [fork] ${note}`);
    if (forked) await resetToLocal();
  });

  // ─────────────────────────────────────────────────────────────
  describe("fork environment", function () {
    it("runs against the real pool, position manager and router at the pinned block", async function () {
      expect(await ethers.provider.getBlockNumber()).to.be.greaterThanOrEqual(PINNED_BLOCK);
      expect(await vault.pool()).to.equal(POOL_ADDR);
      expect(await vault.token0()).to.equal(ASSET_ADDR);
      expect(await vault.token1()).to.equal(USDC_ADDR);
      expect(await vault.fee()).to.equal(FEE);
      expect(await vault.positionManager()).to.equal(NPM_ADDR);
      expect(await vault.swapRouter()).to.equal(ROUTER_ADDR);
      expect(await vault.zapper()).to.equal(zapperAddr);

      // USDC is token1 on this pool, so the only legal zap direction is token1 -> token0.
      expect(await zapper.usdcIsToken0()).to.equal(false);
      expect(await asset.symbol()).to.equal("ASSET");
      expect(await asset.name()).to.equal("REAL");
      expect(await asset.decimals()).to.equal(18n);
      expect(await usdc.decimals()).to.equal(6n);
    });

    it("has a warmed-up oracle, so previewTwap() reads on both contracts", async function () {
      const slot0 = await pool.slot0();
      expect(slot0.observationCardinality).to.be.greaterThan(1n);

      for (const target of [vault, zapper]) {
        const preview = await target.previewTwap();
        expect(preview.maxDeviationTicks).to.equal(MAX_DEVIATION_BPS);
        expect(preview.withinBounds).to.equal(true);
        const deviation =
          preview.currentTick > preview.twapTick
            ? preview.currentTick - preview.twapTick
            : preview.twapTick - preview.currentTick;
        expect(deviation).to.be.lessThanOrEqual(BigInt(MAX_DEVIATION_BPS));
      }
      expect(await vault.twapWindow()).to.equal(TWAP_WINDOW);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("1. lifecycle: stake -> rebalance (real swap leg) -> unstake", function () {
    it("takes custody of a real position and emits Staked with the real range", async function () {
      const centre = alignDown(await currentTick());
      const tickLower = centre - 1200;
      const tickUpper = centre + 1200;
      const tokenId = await mintPosition(alice, tickLower, tickUpper, ASSET(4000), USDC(1000));

      const position = await npm.positions(tokenId);
      expect(position.token0).to.equal(ASSET_ADDR);
      expect(position.token1).to.equal(USDC_ADDR);
      expect(position.fee).to.equal(FEE);
      expect(position.liquidity).to.be.greaterThan(0n);
      expect(await npm.ownerOf(tokenId)).to.equal(alice.address);

      await (await npm.connect(alice).approve(vaultAddr, tokenId)).wait();
      await expect(vault.connect(alice).stake(tokenId))
        .to.emit(vault, "Staked")
        .withArgs(alice.address, tokenId, tickLower, tickUpper, position.liquidity, anyValue);

      expect(await npm.ownerOf(tokenId)).to.equal(vaultAddr);
      expect(await vault.stakerOf(tokenId)).to.equal(alice.address);
    });

    it("rebalances through a real swap: burns the old NFT, moves the record, refunds dust", async function () {
      const { tokenId } = await stakeFreshPosition(alice, 20);
      await generateTradingFees(3);

      const before = await previewWithdraw(tokenId);
      expect(before.fees0 + before.fees1, "no fees accrued — the fee generator missed the range")
        .to.be.greaterThan(0n);

      // Swap a fifth of the recovered USDC into ASSET on the way into the new range.
      const swapIn = (before.principal1 + before.fees1) / 5n;
      expect(swapIn).to.be.greaterThan(0n);

      const centre = alignDown(await currentTick());
      const newLower = centre - 600;
      const newUpper = centre + 600;

      const aliceAsset0 = await asset.balanceOf(alice.address);
      const aliceUsdc0 = await usdc.balanceOf(alice.address);

      const receipt = await (
        await vault.connect(alice).rebalance(
          tokenId,
          newLower,
          newUpper,
          {
            zeroForOne: false, // USDC (token1) -> ASSET (token0)
            amountIn: swapIn,
            amountOutMin: 0n,
            amount0Min: 0n,
            amount1Min: 0n,
          },
          FAR_DEADLINE
        )
      ).wait();

      const args = parseEvent(receipt, vault, vaultAddr, "Rebalanced");
      const newTokenId = args.newTokenId;

      expect(args.user).to.equal(alice.address);
      expect(args.oldTokenId).to.equal(tokenId);
      expect(args.tickLower).to.equal(newLower);
      expect(args.tickUpper).to.equal(newUpper);
      expect(args.liquidity).to.be.greaterThan(0n);

      // Old NFT is gone.
      expect(await vault.stakerOf(tokenId)).to.equal(ZERO);
      await expect(npm.ownerOf(tokenId)).to.be.reverted;

      // New NFT is live, in custody, under the same staker.
      expect(await npm.ownerOf(newTokenId)).to.equal(vaultAddr);
      expect(await vault.stakerOf(newTokenId)).to.equal(alice.address);
      const newPosition = await npm.positions(newTokenId);
      expect(newPosition.tickLower).to.equal(newLower);
      expect(newPosition.tickUpper).to.equal(newUpper);
      expect(newPosition.liquidity).to.equal(args.liquidity);

      // Dust went back to the staker and the vault kept nothing.
      expect((await asset.balanceOf(alice.address)) - aliceAsset0).to.equal(args.amount0Refunded);
      expect((await usdc.balanceOf(alice.address)) - aliceUsdc0).to.equal(args.amount1Refunded);
      expect(await asset.balanceOf(vaultAddr)).to.equal(0n);
      expect(await usdc.balanceOf(vaultAddr)).to.equal(0n);

      // The swap leg really executed: more ASSET and less USDC came out of the round trip
      // than principal + fees alone could have supplied.
      const after = await previewWithdraw(newTokenId);
      expect(after.principal0 + args.amount0Refunded).to.be.greaterThan(
        before.principal0 + before.fees0
      );
      expect(after.principal1 + args.amount1Refunded).to.be.lessThan(
        before.principal1 + before.fees1
      );
    });

    it("compounds accrued trading fees into the new position", async function () {
      const { tokenId } = await stakeFreshPosition(alice, 20);
      await generateTradingFees(3);

      const before = await previewWithdraw(tokenId);
      expect(before.fees0 + before.fees1).to.be.greaterThan(0n);

      const centre = alignDown(await currentTick());
      const receipt = await (
        await vault.connect(alice).rebalance(
          tokenId,
          centre - 1800,
          centre + 1800,
          { zeroForOne: false, amountIn: 0n, amountOutMin: 0n, amount0Min: 0n, amount1Min: 0n },
          FAR_DEADLINE
        )
      ).wait();

      const args = parseEvent(receipt, vault, vaultAddr, "Rebalanced");
      const after = await previewWithdraw(args.newTokenId);

      // No swap leg, so every wei must be accounted for: what the new position holds plus
      // what was refunded equals principal + fees, minus at most Uniswap's rounding.
      const available0 = before.principal0 + before.fees0;
      const available1 = before.principal1 + before.fees1;
      const placed0 = after.principal0 + args.amount0Refunded;
      const placed1 = after.principal1 + args.amount1Refunded;

      expect(placed0).to.be.lessThanOrEqual(available0);
      expect(placed1).to.be.lessThanOrEqual(available1);
      expect(available0 - placed0).to.be.lessThanOrEqual(available0 / 1_000_000n + 10n);
      expect(available1 - placed1).to.be.lessThanOrEqual(available1 / 1_000_000n + 10n);

      // And the fees really were compounded, not paid out: on every side that earned a
      // fee, what ends up placed strictly exceeds the principal that was withdrawn.
      if (before.fees0 > 10n) expect(placed0).to.be.greaterThan(before.principal0);
      if (before.fees1 > 10n) expect(placed1).to.be.greaterThan(before.principal1);
    });

    it("returns the NFT to its staker on unstake", async function () {
      const { tokenId } = await stakeFreshPosition(alice, 20);

      await expect(vault.connect(alice).unstake(tokenId))
        .to.emit(vault, "Unstaked")
        .withArgs(alice.address, tokenId, anyValue);

      expect(await npm.ownerOf(tokenId)).to.equal(alice.address);
      expect(await vault.stakerOf(tokenId)).to.equal(ZERO);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("2. stakeWithPermit against the real position manager", function () {
    it("stakes in one transaction from an ERC-721 permit, with no prior approval", async function () {
      const centre = alignDown(await currentTick());
      const tickLower = centre - 1200;
      const tickUpper = centre + 1200;
      const tokenId = await mintPosition(bob, tickLower, tickUpper, ASSET(4000), USDC(1000));

      expect(await npm.getApproved(tokenId)).to.equal(ZERO);

      const { v, r, s } = await signNftPermit(bob, vaultAddr, tokenId, FAR_DEADLINE);
      const liquidity = (await npm.positions(tokenId)).liquidity;

      await expect(vault.connect(bob).stakeWithPermit(tokenId, FAR_DEADLINE, v, r, s))
        .to.emit(vault, "Staked")
        .withArgs(bob.address, tokenId, tickLower, tickUpper, liquidity, anyValue);

      expect(await npm.ownerOf(tokenId)).to.equal(vaultAddr);
      expect(await vault.stakerOf(tokenId)).to.equal(bob.address);
      expect((await npm.positions(tokenId)).nonce).to.equal(1n);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("3. zap lifecycle through the real router", function () {
    let tickLower, tickUpper, zapAmount, swapLeg;

    beforeEach(async function () {
      const centre = alignDown(await currentTick());
      tickLower = centre - 1200;
      tickUpper = centre + 1200;
      zapAmount = USDC(5_000);
      // Deliberately under-swap so a USDC refund is guaranteed to be non-zero.
      swapLeg = {
        zeroForOne: false, // USDC is token1 on this pool
        amountIn: zapAmount / 3n,
        amountOutMin: 0n,
        amount0Min: 0n,
        amount1Min: 0n,
      };
    });

    it("zapInWithPermit: real USDC EIP-2612 permit, position minted, staked and refunded", async function () {
      expect(await usdc.allowance(carol.address, zapperAddr)).to.equal(0n);

      const usdcName = await usdc.name();
      const { v, r, s } = await signErc2612(
        usdc,
        usdcName,
        "2", // USDC's EIP-712 version is "2", not "1"
        carol,
        zapperAddr,
        zapAmount,
        FAR_DEADLINE
      );

      const usdc0 = await usdc.balanceOf(carol.address);
      const asset0 = await asset.balanceOf(carol.address);

      const receipt = await (
        await zapper.connect(carol).zapInWithPermit(
          zapAmount,
          tickLower,
          tickUpper,
          swapLeg,
          FAR_DEADLINE,
          { value: zapAmount, deadline: FAR_DEADLINE, v, r, s }
        )
      ).wait();

      const args = parseEvent(receipt, zapper, zapperAddr, "ZappedIn");
      expect(args.user).to.equal(carol.address);
      expect(args.usdcIn).to.equal(zapAmount);
      expect(args.usdcRefunded).to.be.greaterThan(0n);

      expect(await npm.ownerOf(args.tokenId)).to.equal(vaultAddr);
      expect(await vault.stakerOf(args.tokenId)).to.equal(carol.address);

      const position = await npm.positions(args.tokenId);
      expect(position.tickLower).to.equal(tickLower);
      expect(position.tickUpper).to.equal(tickUpper);
      expect(position.liquidity).to.be.greaterThan(0n);

      // Refunds landed and the zapper kept nothing.
      expect(usdc0 - (await usdc.balanceOf(carol.address))).to.equal(zapAmount - args.usdcRefunded);
      expect((await asset.balanceOf(carol.address)) - asset0).to.equal(args.assetRefunded);
      expect(await usdc.balanceOf(zapperAddr)).to.equal(0n);
      expect(await asset.balanceOf(zapperAddr)).to.equal(0n);
    });

    it("zapIn: plain approval path credits the caller as staker", async function () {
      await (await usdc.connect(dave).approve(zapperAddr, zapAmount)).wait();

      const receipt = await (
        await zapper
          .connect(dave)
          .zapIn(zapAmount, tickLower, tickUpper, swapLeg, FAR_DEADLINE)
      ).wait();

      const args = parseEvent(receipt, zapper, zapperAddr, "ZappedIn");
      expect(await vault.stakerOf(args.tokenId)).to.equal(dave.address);
      expect(await npm.ownerOf(args.tokenId)).to.equal(vaultAddr);
      expect(await usdc.balanceOf(zapperAddr)).to.equal(0n);
      expect(await asset.balanceOf(zapperAddr)).to.equal(0n);

      // The vault's own Staked event is what the indexer keys off.
      const staked = parseEvent(receipt, vault, vaultAddr, "Staked");
      expect(staked.user).to.equal(dave.address);
      expect(staked.tokenId).to.equal(args.tokenId);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("4. ASSET EIP-2612 domain sanity", function () {
    it("accepts a permit signed against domain version \"1\"", async function () {
      // V1 contracts never consume an ASSET permit; this pins the domain facts the
      // frontend has to sign with.
      const { domain, onChain } = await resolveDomain(ASSET_ADDR, "REAL", "1");
      expect(domain.name).to.equal("REAL");
      expect(domain.version).to.equal("1");
      expect(ethers.TypedDataEncoder.hashDomain(domain)).to.equal(onChain);

      // The mainnet (chainId 1) separator is a fixed fact — assert it explicitly so a
      // change to the token's name or version cannot slip past unnoticed.
      expect(
        ethers.TypedDataEncoder.hashDomain({
          name: "REAL",
          version: "1",
          chainId: 1n,
          verifyingContract: ASSET_ADDR,
        })
      ).to.equal("0xc862074813df5eff139642969761c4b1b21216647307909b1693b167c9e1f10d");

      const value = ASSET(1234);
      const nonce0 = await asset.nonces(alice.address);
      const { v, r, s } = await signErc2612(asset, "REAL", "1", alice, bob.address, value, FAR_DEADLINE);

      // Submitted by a third party, as a relayer would.
      await (
        await asset.connect(deployer).permit(alice.address, bob.address, value, FAR_DEADLINE, v, r, s)
      ).wait();

      expect(await asset.allowance(alice.address, bob.address)).to.equal(value);
      expect(await asset.nonces(alice.address)).to.equal(nonce0 + 1n);
    });

    it("rejects an ASSET permit signed against the wrong domain version", async function () {
      const badDomain = {
        name: "REAL",
        version: "2",
        chainId: (await resolveDomain(ASSET_ADDR, "REAL", "1")).domain.chainId,
        verifyingContract: ASSET_ADDR,
      };
      const types = {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      };
      const sig = ethers.Signature.from(
        await alice.signTypedData(badDomain, types, {
          owner: alice.address,
          spender: bob.address,
          value: 1n,
          nonce: await asset.nonces(alice.address),
          deadline: FAR_DEADLINE,
        })
      );

      await expect(
        asset.connect(deployer).permit(alice.address, bob.address, 1n, FAR_DEADLINE, sig.v, sig.r, sig.s)
      ).to.be.reverted;
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("5. TWAP guard vs spot manipulation", function () {
    let tokenId, swapLeg, zapLeg, newLower, newUpper, zapLower, zapUpper;

    beforeEach(async function () {
      ({ tokenId } = await stakeFreshPosition(alice, 20));

      const centre = alignDown(await currentTick());
      newLower = centre - 600;
      newUpper = centre + 600;
      zapLower = centre - 1200;
      zapUpper = centre + 1200;

      const preview = await previewWithdraw(tokenId);
      swapLeg = {
        zeroForOne: false,
        amountIn: preview.principal1 / 5n,
        amountOutMin: 0n,
        amount0Min: 0n,
        amount1Min: 0n,
      };
      zapLeg = {
        zeroForOne: false,
        amountIn: USDC(1_000),
        amountOutMin: 0n,
        amount0Min: 0n,
        amount1Min: 0n,
      };
      await (await usdc.connect(dave).approve(zapperAddr, USDC(3_000))).wait();
    });

    it("lets rebalance and zapIn through while spot tracks the TWAP", async function () {
      expect((await vault.previewTwap()).withinBounds).to.equal(true);
      expect((await zapper.previewTwap()).withinBounds).to.equal(true);

      await expect(
        vault.connect(alice).rebalance(tokenId, newLower, newUpper, swapLeg, FAR_DEADLINE)
      ).to.emit(vault, "Rebalanced");

      await expect(
        zapper.connect(dave).zapIn(USDC(3_000), zapLower, zapUpper, zapLeg, FAR_DEADLINE)
      ).to.emit(zapper, "ZappedIn");
    });

    it("blocks rebalance and zapIn once a whale pushes spot off the TWAP", async function () {
      const poolLiquidity = await pool.liquidity();
      expect(poolLiquidity).to.be.greaterThan(0n);

      const result = await manipulateSpotUpwards();
      const preview = await vault.previewTwap();
      const deviation = Number(preview.currentTick - preview.twapTick);

      notes.push(
        `manipulation: spent ${(result.spent / 10n ** 6n).toString()} USDC, ` +
          `tick ${result.spotBefore} -> ${result.spotAfter}, ` +
          `spot-vs-TWAP deviation ${deviation} ticks (ceiling ${MAX_DEVIATION_BPS}), ` +
          `pool ASSET drained ${result.assetDrainedPct}%, pool liquidity before ${poolLiquidity}`
      );

      expect(Math.abs(deviation)).to.be.greaterThan(MAX_DEVIATION_BPS);
      expect(preview.withinBounds).to.equal(false);
      expect((await zapper.previewTwap()).withinBounds).to.equal(false);

      await expect(
        vault.connect(alice).rebalance(tokenId, newLower, newUpper, swapLeg, FAR_DEADLINE)
      ).to.be.revertedWithCustomError(vault, "TwapDeviationTooHigh");

      await expect(
        zapper.connect(dave).zapIn(USDC(3_000), zapLower, zapUpper, zapLeg, FAR_DEADLINE)
      ).to.be.revertedWithCustomError(zapper, "TwapDeviationTooHigh");

      // The guard only gates the swap leg — an unconditional exit still works.
      await expect(
        vault.connect(alice).rebalance(
          tokenId,
          newLower,
          newUpper,
          { zeroForOne: false, amountIn: 0n, amountOutMin: 0n, amount0Min: 0n, amount1Min: 0n },
          FAR_DEADLINE
        )
      ).to.emit(vault, "Rebalanced");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("6. real tick-spacing math", function () {
    it("rebalances into a single-spacing-wide range straddling spot", async function () {
      const { tokenId } = await stakeFreshPosition(alice, 20);
      const centre = alignDown(await currentTick());
      const tight = { lower: centre, upper: centre + TICK_SPACING };

      const receipt = await (
        await vault.connect(alice).rebalance(
          tokenId,
          tight.lower,
          tight.upper,
          { zeroForOne: false, amountIn: 0n, amountOutMin: 0n, amount0Min: 0n, amount1Min: 0n },
          FAR_DEADLINE
        )
      ).wait();

      const args = parseEvent(receipt, vault, vaultAddr, "Rebalanced");
      const position = await npm.positions(args.newTokenId);
      expect(position.tickLower).to.equal(tight.lower);
      expect(position.tickUpper).to.equal(tight.upper);
      expect(position.liquidity).to.be.greaterThan(0n);
      expect(Number(position.tickUpper - position.tickLower)).to.equal(TICK_SPACING);
      expect(await asset.balanceOf(vaultAddr)).to.equal(0n);
      expect(await usdc.balanceOf(vaultAddr)).to.equal(0n);
    });

    it("rebalances into the full range", async function () {
      const { tokenId } = await stakeFreshPosition(alice, 20);

      const receipt = await (
        await vault.connect(alice).rebalance(
          tokenId,
          MIN_TICK_ALIGNED,
          MAX_TICK_ALIGNED,
          { zeroForOne: false, amountIn: 0n, amountOutMin: 0n, amount0Min: 0n, amount1Min: 0n },
          FAR_DEADLINE
        )
      ).wait();

      const args = parseEvent(receipt, vault, vaultAddr, "Rebalanced");
      const position = await npm.positions(args.newTokenId);
      expect(position.tickLower).to.equal(MIN_TICK_ALIGNED);
      expect(position.tickUpper).to.equal(MAX_TICK_ALIGNED);
      expect(position.liquidity).to.be.greaterThan(0n);
      expect(Number(position.tickLower) % TICK_SPACING).to.equal(0);
      expect(Number(position.tickUpper) % TICK_SPACING).to.equal(0);
    });

    it("reverts when the new ticks are not multiples of the pool tick spacing", async function () {
      const { tokenId } = await stakeFreshPosition(alice, 20);
      const centre = alignDown(await currentTick());

      await expect(
        vault.connect(alice).rebalance(
          tokenId,
          centre + 1,
          centre + TICK_SPACING + 1,
          { zeroForOne: false, amountIn: 0n, amountOutMin: 0n, amount0Min: 0n, amount1Min: 0n },
          FAR_DEADLINE
        )
      ).to.be.reverted;

      // The revert left the stake untouched.
      expect(await vault.stakerOf(tokenId)).to.equal(alice.address);
      expect(await npm.ownerOf(tokenId)).to.equal(vaultAddr);
    });
  });
});
