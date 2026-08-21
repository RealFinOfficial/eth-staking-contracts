/**
 * Live Sepolia smoke suite — real network, real gas, real transactions.
 *
 * Everything else in this repo runs against a fork. This one does not: it signs with the
 * wallet behind `PRIVATE_KEY`, spends real SepoliaETH and leaves permanent state on a public
 * chain. That is the point — a fork cannot prove that the RPC, the explorer, the funded
 * wallet, the gas market and the deployed stack all work together, and the spec's Sepolia
 * staging deployment is exactly that rehearsal.
 *
 * ── Why it lives outside test/ ────────────────────────────────────────────────────────
 *
 * `hardhat test` with no arguments runs `paths.tests`, which is `./test`. This file is under
 * `test-live/`, so it is invisible to the default run and to CI. It can only be reached the
 * one way that names it:
 *
 *     npm run test:sepolia:live
 *
 * ── Gates ─────────────────────────────────────────────────────────────────────────────
 *
 * Three, all required, and the suite reports which one is missing rather than failing
 * obscurely later:
 *   SEPOLIA_LIVE=1                       explicit opt-in; nothing here runs by accident
 *   PRIVATE_KEY                          the funded wallet that signs
 *   SEPOLIA_RPC_URL or INFURA_API_KEY    the endpoint hardhat.config.js builds `sepolia` from
 *
 * Two further gates guard the two irreversible, one-time actions. Both are off by default,
 * because each one writes a fact the team then has to live with:
 *   SEPOLIA_LIVE_CREATE_POOL=1   create the tREAL/tUSDC pool (one real tx, forever)
 *   SEPOLIA_LIVE_DEPLOY=1        deploy the four contracts and RECORD them in the tracked
 *                                deployments.json under chain 11155111
 * Without them, a run with nothing deployed fails and says which flag to add. A run with
 * everything already deployed reuses it and touches neither.
 *
 * ── Idempotence ───────────────────────────────────────────────────────────────────────
 *
 * Safe to run repeatedly: addresses come from `deployments.json`, every position is a fresh
 * NFT with its own tokenId, and the journey unstakes what it staked, so the wallet ends
 * where it started minus gas.
 *
 * ── The claim leg needs a key we may not have ─────────────────────────────────────────
 *
 * `RewardsDistributor` only honours vouchers from its configured signer, which is a backend
 * key and deliberately NOT the deployer. When `LP_SIGNER_KEY` is set and matches
 * `distributor.signer()`, the suite redeems a real 1-wei-TokenX voucher. When it is not, it
 * proves the other half of the same property — that a voucher from any other key is refused
 * — with a static call that spends nothing. Both arms assert real contract behaviour; the
 * test title says which one ran.
 */

const fs = require("fs");
const path = require("path");

const { expect } = require("chai");
const ethers = require("ethers");
const hre = require("hardhat");

const runner = require("../../test/lp-staking/helpers/scripts");
const profiles = require("../../test/lp-staking/helpers/profiles");
const signing = require("../../test/lp-staking/helpers/signing");
const uni = require("../../test/lp-staking/helpers/uniswap");

const P = profiles.sepolia;
const CHAIN_ID = 11155111;
const EXPLORER = "https://sepolia.etherscan.io";

/** Deliberately tiny: this spends the team's real test tokens. */
const JOURNEY_ASSET = 10n ** 18n; // 1 tREAL
const JOURNEY_USDC = 2n * 10n ** 6n; // 2 tUSDC for the mint
const ZAP_USDC = 1n * 10n ** 6n; // 1 tUSDC through the zapper
const RANGE_HALF_WIDTH_TICKS = 1200;
const FAR_DEADLINE = 10n ** 12n;

/** A real deploy on a real network is nothing like a fork's; give the scripts room. */
const LIVE_SCRIPT_TIMEOUT_MS = 20 * 60 * 1000;

const missing = [];
if (process.env.SEPOLIA_LIVE !== "1") missing.push("SEPOLIA_LIVE=1");
if (!process.env.PRIVATE_KEY) missing.push("PRIVATE_KEY");
if (!process.env.SEPOLIA_RPC_URL && !process.env.INFURA_API_KEY) {
  missing.push("SEPOLIA_RPC_URL or INFURA_API_KEY");
}

if (missing.length > 0) {
  console.log(
    `\n  [sepolia-live] not running: set ${missing.join(", ")}.\n` +
      `  This suite sends REAL transactions on Sepolia and is never part of \`hardhat test\`.\n`
  );
}

/** `describe.skip` when a gate is missing, so the reason is stated and nothing is sent. */
const suite = missing.length > 0 ? describe.skip : describe;

suite("LP staking — LIVE Sepolia smoke (real transactions, real gas)", function () {
  // One real deploy plus a handful of confirmations at Sepolia block times.
  this.timeout(45 * 60 * 1000);

  let signer;
  let asset, usdc, npm, pool, factory;
  /** Minimal ERC-20 surface; declared here rather than resolved from an artifact name,
   *  which would be ambiguous across the OpenZeppelin interfaces the repo compiles. */
  const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
  ];
  let vault, zapper, tokenX, distributor;
  let vaultAddr, zapperAddr, tokenXAddr, distributorAddr, poolAddr;
  let assetIsToken0, token0, token1, zeroForOne;
  let tickSpacing;
  let oracleReady = false;
  let oracleProblem = null;

  const links = [];
  const positions = {};

  /** Records a mined transaction and its explorer link. Refuses a reverted one. */
  async function send(label, txPromise) {
    const tx = await txPromise;
    const receipt = await tx.wait();
    links.push(`${label}: ${EXPLORER}/tx/${receipt.hash}`);
    if (receipt.status !== 1) throw new Error(`${label} reverted: ${receipt.hash}`);
    return receipt;
  }

  function parseEvent(receipt, iface, address, name) {
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== address.toLowerCase()) continue;
      let parsed = null;
      try {
        parsed = iface.parseLog(log);
      } catch {
        continue;
      }
      if (parsed && parsed.name === name) return parsed.args;
    }
    throw new Error(`no ${name} event from ${address} in receipt ${receipt.hash}`);
  }

  /**
   * The LP_* environment a live script run needs.
   *
   * `helpers/scripts.js` strips every LP_* key out of the child's environment on purpose,
   * so a stray one cannot redirect a fork run. Here the operator's own values ARE the
   * intent, so they are forwarded deliberately and explicitly.
   */
  function liveScriptEnv(extra = {}) {
    const forwarded = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith("LP_")) forwarded[key] = value;
    }
    return { ...forwarded, ...extra };
  }

  function registryEntry(kind) {
    const file = runner.TRACKED_REGISTRY;
    if (!fs.existsSync(file)) return undefined;
    const chain = JSON.parse(fs.readFileSync(file, "utf8"))[String(CHAIN_ID)];
    return chain ? chain[kind] : undefined;
  }

  before(async function () {
    const network = await hre.ethers.provider.getNetwork();
    if (Number(network.chainId) !== CHAIN_ID) {
      throw new Error(
        `this suite must run with --network sepolia; the provider reports chain ${network.chainId}`
      );
    }

    [signer] = await hre.ethers.getSigners();
    if (!signer) throw new Error("no signer — PRIVATE_KEY is set but hardhat produced no account");

    asset = new ethers.Contract(P.asset.address, ERC20_ABI, signer);
    usdc = new ethers.Contract(P.usdc.address, ERC20_ABI, signer);

    // Same derivation the fork suites use, so the live run and the rehearsal cannot
    // disagree about which token Uniswap calls token0.
    ({ assetIsToken0, token0, token1 } = uni.sortTokens(P.asset.address, P.usdc.address));
    zeroForOne = !assetIsToken0; // USDC -> ASSET, the only direction a zap may take

    npm = new ethers.Contract(
      P.npm,
      [
        "function positions(uint256) view returns (uint96 nonce,address operator,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128,uint128 tokensOwed0,uint128 tokensOwed1)",
        "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
        "function ownerOf(uint256) view returns (address)",
        "function approve(address,uint256)",
        "function getApproved(uint256) view returns (address)",
      ],
      signer
    );
    factory = new ethers.Contract(
      P.factory,
      ["function getPool(address,address,uint24) view returns (address)"],
      hre.ethers.provider
    );

    console.log(`  [sepolia-live] signer  ${signer.address}`);
    console.log(`  [sepolia-live] ETH     ${ethers.formatEther(await hre.ethers.provider.getBalance(signer.address))}`);
  });

  after(function () {
    if (links.length === 0) return;
    console.log(`\n  [sepolia-live] ${links.length} transactions:`);
    for (const link of links) console.log(`    ${link}`);
  });

  it("1. reports the wallet and the token balances it is about to spend", async function () {
    const eth = await hre.ethers.provider.getBalance(signer.address);
    expect(eth, "the wallet has no SepoliaETH for gas").to.be.greaterThan(0n);

    const assetBalance = await asset.balanceOf(signer.address);
    const usdcBalance = await usdc.balanceOf(signer.address);
    console.log(
      `  [sepolia-live] ${P.asset.symbol} ${assetBalance}  ${P.usdc.symbol} ${usdcBalance}`
    );

    expect(
      assetBalance,
      `the wallet needs at least ${JOURNEY_ASSET} ${P.asset.symbol}`
    ).to.be.greaterThanOrEqual(JOURNEY_ASSET);
    expect(
      usdcBalance,
      `the wallet needs at least ${JOURNEY_USDC + ZAP_USDC} ${P.usdc.symbol}`
    ).to.be.greaterThanOrEqual(JOURNEY_USDC + ZAP_USDC);
  });

  it("2. has the tREAL/tUSDC pool, creating it only when explicitly asked", async function () {
    const recorded = registryEntry("UniswapV3Pool");
    const onChain = await factory.getPool(token0, token1, P.fee);

    if (onChain !== ethers.ZeroAddress) {
      poolAddr = onChain;
    } else {
      if (process.env.SEPOLIA_LIVE_CREATE_POOL !== "1") {
        throw new Error(
          `no ${P.asset.symbol}/${P.usdc.symbol} ${P.fee} pool exists on Sepolia yet. Creating one ` +
            "is a permanent, one-time act that fixes the pool address forever, so it needs an " +
            "explicit go: re-run with SEPOLIA_LIVE_CREATE_POOL=1."
        );
      }
      const run = await runner.runHardhatScript(
        "scripts/create-sepolia-pool.js",
        liveScriptEnv({ LP_ASSET: P.asset.address, LP_USDC: P.usdc.address, LP_FEE: String(P.fee) }),
        { network: "sepolia", timeoutMs: LIVE_SCRIPT_TIMEOUT_MS }
      );
      console.log(run.stdout);
      expect(run.code, run.stderr).to.equal(0);
      poolAddr = await factory.getPool(token0, token1, P.fee);
    }

    expect(poolAddr).to.not.equal(ethers.ZeroAddress);
    if (recorded) expect(recorded.address).to.equal(poolAddr);

    pool = new ethers.Contract(
      poolAddr,
      [
        "function token0() view returns (address)",
        "function token1() view returns (address)",
        "function fee() view returns (uint24)",
        "function tickSpacing() view returns (int24)",
        "function liquidity() view returns (uint128)",
        "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
        "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives,uint160[] secondsPerLiquidityCumulativeX128s)",
      ],
      hre.ethers.provider
    );
    expect(await pool.token0()).to.equal(token0);
    expect(await pool.token1()).to.equal(token1);
    expect(await pool.fee()).to.equal(BigInt(P.fee));
    tickSpacing = Number(await pool.tickSpacing());
    console.log(`  [sepolia-live] pool    ${EXPLORER}/address/${poolAddr}`);
  });

  it("3. has the four contracts, deploying them only when explicitly asked", async function () {
    const kinds = ["TokenX", "RewardsDistributor", "LPStakingVault", "LPZapper"];
    const recorded = Object.fromEntries(kinds.map((k) => [k, registryEntry(k)]));

    if (kinds.some((k) => !recorded[k])) {
      if (process.env.SEPOLIA_LIVE_DEPLOY !== "1") {
        const absent = kinds.filter((k) => !recorded[k]).join(", ");
        throw new Error(
          `deployments.json has no ${absent} for chain ${CHAIN_ID}. Deploying is the spec's ` +
            "Sepolia staging deployment and records itself in the tracked registry, so it needs " +
            "an explicit go: re-run with SEPOLIA_LIVE_DEPLOY=1."
        );
      }
      const run = await runner.runHardhatScript(
        "scripts/deploy-lp-staking.js",
        liveScriptEnv({
          LP_ASSET: P.asset.address,
          LP_USDC: P.usdc.address,
          LP_POOL: poolAddr,
          LP_FEE: String(P.fee),
        }),
        { network: "sepolia", timeoutMs: LIVE_SCRIPT_TIMEOUT_MS }
      );
      console.log(run.stdout);
      expect(run.code, run.stderr).to.equal(0);
      expect(run.stdout).to.include("All post-deploy checks passed.");
      for (const kind of kinds) recorded[kind] = registryEntry(kind);
    }

    tokenXAddr = recorded.TokenX.address;
    distributorAddr = recorded.RewardsDistributor.address;
    vaultAddr = recorded.LPStakingVault.address;
    zapperAddr = recorded.LPZapper.address;

    vault = await hre.ethers.getContractAt("LPStakingVault", vaultAddr, signer);
    zapper = await hre.ethers.getContractAt("LPZapper", zapperAddr, signer);
    tokenX = await hre.ethers.getContractAt("TokenX", tokenXAddr, signer);
    distributor = await hre.ethers.getContractAt("RewardsDistributor", distributorAddr, signer);

    for (const [label, address] of [
      ["TokenX", tokenXAddr],
      ["RewardsDistributor", distributorAddr],
      ["LPStakingVault", vaultAddr],
      ["LPZapper", zapperAddr],
    ]) {
      expect(await hre.ethers.provider.getCode(address), `${label} has no code`).to.not.equal("0x");
      console.log(`  [sepolia-live] ${label.padEnd(19)} ${EXPLORER}/address/${address}`);
    }

    expect(await vault.pool()).to.equal(poolAddr);
    expect(await zapper.vault()).to.equal(vaultAddr);
    expect(await zapper.usdcIsToken0()).to.equal(zeroForOne);
    expect(await distributor.tokenX()).to.equal(tokenXAddr);

    // Read once here so the zap step can state its precondition instead of guessing.
    try {
      const preview = await zapper.previewTwap();
      const liquidity = await pool.liquidity();
      oracleReady = preview.withinBounds && liquidity > 0n;
      if (!oracleReady) oracleProblem = `liquidity=${liquidity} withinBounds=${preview.withinBounds}`;
    } catch (error) {
      oracleProblem = error.shortMessage || error.message;
      oracleReady = false;
    }
  });

  it("4. approves the position manager and the zapper for this run's amounts", async function () {
    const assetAllowance = await asset.allowance(signer.address, P.npm);
    if (assetAllowance < JOURNEY_ASSET) {
      await send(
        "approve NPM for tREAL",
        asset.connect(signer).approve(P.npm, ethers.MaxUint256)
      );
    }
    const usdcAllowance = await usdc.allowance(signer.address, P.npm);
    if (usdcAllowance < JOURNEY_USDC) {
      await send("approve NPM for tUSDC", usdc.connect(signer).approve(P.npm, ethers.MaxUint256));
    }
    const zapAllowance = await usdc.allowance(signer.address, zapperAddr);
    if (zapAllowance < ZAP_USDC) {
      await send(
        "approve zapper for tUSDC",
        usdc.connect(signer).approve(zapperAddr, ethers.MaxUint256)
      );
    }

    expect(await asset.allowance(signer.address, P.npm)).to.be.greaterThanOrEqual(JOURNEY_ASSET);
    expect(await usdc.allowance(signer.address, P.npm)).to.be.greaterThanOrEqual(JOURNEY_USDC);
    expect(await usdc.allowance(signer.address, zapperAddr)).to.be.greaterThanOrEqual(ZAP_USDC);
  });

  it("5. mints a small position around the live pool price", async function () {
    const slot0 = await pool.slot0();
    const centre = Math.floor(Number(slot0.tick) / tickSpacing) * tickSpacing;
    const tickLower = centre - RANGE_HALF_WIDTH_TICKS;
    const tickUpper = centre + RANGE_HALF_WIDTH_TICKS;

    const [amount0Desired, amount1Desired] = assetIsToken0
      ? [JOURNEY_ASSET, JOURNEY_USDC]
      : [JOURNEY_USDC, JOURNEY_ASSET];

    const receipt = await send(
      "mint position",
      npm.mint({
        token0,
        token1,
        fee: P.fee,
        tickLower,
        tickUpper,
        amount0Desired,
        amount1Desired,
        amount0Min: 0n,
        amount1Min: 0n,
        recipient: signer.address,
        deadline: FAR_DEADLINE,
      })
    );

    const transferTopic = ethers.id("Transfer(address,address,uint256)");
    for (const log of receipt.logs) {
      if (
        log.address.toLowerCase() === P.npm.toLowerCase() &&
        log.topics[0] === transferTopic &&
        log.topics.length === 4 &&
        BigInt(log.topics[1]) === 0n
      ) {
        positions.minted = BigInt(log.topics[3]);
      }
    }
    expect(positions.minted, "no position NFT was minted").to.not.equal(undefined);

    const position = await npm.positions(positions.minted);
    expect(position.liquidity, "the mint produced no liquidity").to.be.greaterThan(0n);
    expect(await npm.ownerOf(positions.minted)).to.equal(signer.address);
  });

  it("6. stakes that position and the vault takes custody", async function () {
    await send("approve vault for the position", npm.approve(vaultAddr, positions.minted));
    const receipt = await send("stake", vault.stake(positions.minted));

    const args = parseEvent(receipt, vault.interface, vaultAddr, "Staked");
    expect(args.user).to.equal(signer.address);
    expect(args.tokenId).to.equal(positions.minted);
    expect(await npm.ownerOf(positions.minted)).to.equal(vaultAddr);
    expect(await vault.stakerOf(positions.minted)).to.equal(signer.address);
  });

  it(
    "7. zaps a small amount of tUSDC into a staked position, or reports the oracle precondition",
    async function () {
      const slot0 = await pool.slot0();
      const centre = Math.floor(Number(slot0.tick) / tickSpacing) * tickSpacing;
      const swap = {
        zeroForOne,
        amountIn: ZAP_USDC / 3n,
        amountOutMin: 0n,
        amount0Min: 0n,
        amount1Min: 0n,
      };

      if (!oracleReady) {
        // Not a skip and not a pass-by-omission: the zap MUST fail while the pool's oracle
        // is cold, and this asserts that it does, without spending gas. A fresh Uniswap V3
        // pool stores one observation, so `observe([twapWindow, 0])` reverts with "OLD"
        // until the pool has been traded for a whole window — the documented deploy gate.
        console.log(`  [sepolia-live] oracle not ready: ${oracleProblem}`);
        let reverted = false;
        try {
          await zapper.zapIn.staticCall(
            ZAP_USDC,
            centre - RANGE_HALF_WIDTH_TICKS,
            centre + RANGE_HALF_WIDTH_TICKS,
            swap,
            FAR_DEADLINE
          );
        } catch {
          reverted = true;
        }
        expect(
          reverted,
          "the oracle is cold but zapIn did not revert — the TWAP guard is not reading the pool"
        ).to.equal(true);
        return;
      }

      const receipt = await send(
        "zapIn",
        zapper.zapIn(
          ZAP_USDC,
          centre - RANGE_HALF_WIDTH_TICKS,
          centre + RANGE_HALF_WIDTH_TICKS,
          swap,
          FAR_DEADLINE
        )
      );

      const zapped = parseEvent(receipt, zapper.interface, zapperAddr, "ZappedIn");
      positions.zapped = zapped.tokenId;
      expect(zapped.user).to.equal(signer.address);
      expect(zapped.usdcIn).to.equal(ZAP_USDC);
      expect(await vault.stakerOf(zapped.tokenId)).to.equal(signer.address);
      expect(await npm.ownerOf(zapped.tokenId)).to.equal(vaultAddr);
      // Nothing may be left behind on the zapper.
      expect(await usdc.balanceOf(zapperAddr)).to.equal(0n);
      expect(await asset.balanceOf(zapperAddr)).to.equal(0n);
    }
  );

  it("8. redeems a TokenX voucher, or proves a foreign voucher is refused", async function () {
    const onChainSigner = await distributor.signer();
    const domain = await signing.readEip712Domain(distributor);
    expect(domain.chainId).to.equal(BigInt(CHAIN_ID));
    expect(domain.verifyingContract).to.equal(distributorAddr);

    const key = process.env.LP_SIGNER_KEY;
    const haveKey = Boolean(key) && new ethers.Wallet(key).address === onChainSigner;

    if (!haveKey) {
      // The other half of the same property, and the only half provable without the backend
      // key: a voucher the configured signer did not sign buys nothing. A static call, so
      // this branch costs no gas.
      console.log(
        `  [sepolia-live] LP_SIGNER_KEY is not the distributor's signer (${onChainSigner}); ` +
          "proving voucher rejection instead"
      );
      const stranger = ethers.Wallet.createRandom();
      const forged = await signing.signVoucher({
        signer: stranger,
        domain,
        leg: "TokenXClaim",
        user: signer.address,
        cumulativeAmount: 1n,
      });
      await expect(
        distributor.claimTokenX.staticCall(1n, FAR_DEADLINE, forged)
      ).to.be.revertedWithCustomError(distributor, "InvalidSignature");
      return;
    }

    const before = await distributor.claimedTokenX(signer.address);
    const cumulative = before + 1n;
    const voucher = await signing.signVoucher({
      signer: new ethers.Wallet(key),
      domain,
      leg: "TokenXClaim",
      user: signer.address,
      cumulativeAmount: cumulative,
    });

    const balanceBefore = await tokenX.balanceOf(signer.address);
    const receipt = await send("claimTokenX", distributor.claimTokenX(cumulative, FAR_DEADLINE, voucher));

    const args = parseEvent(receipt, distributor.interface, distributorAddr, "Claimed");
    expect(args.user).to.equal(signer.address);
    expect(args.token).to.equal(tokenXAddr);
    expect(args.paidAmount).to.equal(1n);
    expect(await distributor.claimedTokenX(signer.address)).to.equal(cumulative);
    expect((await tokenX.balanceOf(signer.address)) - balanceBefore).to.equal(1n);
  });

  it("9. unstakes everything it staked, leaving the wallet whole", async function () {
    for (const name of ["minted", "zapped"]) {
      const tokenId = positions[name];
      if (tokenId === undefined) continue;
      if ((await vault.stakerOf(tokenId)) !== signer.address) continue;

      const receipt = await send(`unstake ${name}`, vault.unstake(tokenId));
      const args = parseEvent(receipt, vault.interface, vaultAddr, "Unstaked");
      expect(args.tokenId).to.equal(tokenId);
      expect(await npm.ownerOf(tokenId)).to.equal(signer.address);
      expect(await vault.stakerOf(tokenId)).to.equal(ethers.ZeroAddress);
    }

    expect(await vault.stakerOf(positions.minted)).to.equal(ethers.ZeroAddress);
  });

  it("10. left the deployments registry consistent with what is on chain", async function () {
    // The live run is the ONE case where writing the tracked registry is correct: this is
    // the spec's Sepolia staging deployment, and the recorded addresses are the fact the
    // frontend, the backend and the indexer all read.
    for (const [kind, address] of [
      ["UniswapV3Pool", poolAddr],
      ["TokenX", tokenXAddr],
      ["RewardsDistributor", distributorAddr],
      ["LPStakingVault", vaultAddr],
      ["LPZapper", zapperAddr],
    ]) {
      const entry = registryEntry(kind);
      expect(entry, `deployments.json has no ${kind} for chain ${CHAIN_ID}`).to.not.equal(undefined);
      expect(entry.address, `${kind} address`).to.equal(address);
    }

    expect(path.basename(runner.TRACKED_REGISTRY)).to.equal("deployments.json");
    expect(links.length, "the journey sent no transactions").to.be.greaterThan(0);
  });
});
