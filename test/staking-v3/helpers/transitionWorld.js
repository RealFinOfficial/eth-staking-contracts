// The in-process world of the transition suites (spec 01 §9): the staking v3 stack on the math
// rung (the real LPStakingVault over MockMathPositionManager, a pool mock at $0.25 per $ASSET, the
// router mock filling at exactly that price), the three v3 proxies wired the way
// scripts/deploy-staking-v3.js wires them, and the TransitionReceiver linked with
// `initializeTransition`. The pair sorts in the order LP_TOKEN_ORDER names (helpers/tokenOrder.js).
//
// Roles: `owner` owns every contract and is the LP vault's guardian and operator; `deliverer` is the
// receiver's service key; `signer` signs the delivery vouchers.

const { ethers } = require("hardhat");
const { deployOrderedPair } = require("../../lp-staking/helpers/tokenOrder");

const MATH_FEE = 100;
/** $0.25 per $ASSET with $ASSET as token0 (18 / 6 decimals); negated when USDC is token0. */
const PRICE_TICK = -290188;
const V3_DURATION = 90 * 86400;
const FAR = 10n ** 12n;

const DELIVERY_TYPES = {
  DeliveryVoucher: [
    { name: "holder", type: "address" },
    { name: "route", type: "uint8" },
    { name: "eligiblePrincipal", type: "uint256" },
    { name: "eligibleReward", type: "uint256" },
    { name: "assetLimit", type: "uint256" },
    { name: "usdcLimit", type: "uint256" },
    { name: "burnTime", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

async function deployProxy(name, ctorArgs, initArgs, signer) {
  const Impl = await ethers.getContractFactory(name, signer);
  const impl = await Impl.deploy(...ctorArgs);
  await impl.waitForDeployment();
  const data = impl.interface.encodeFunctionData("initialize", initArgs);
  const proxy = await (await ethers.getContractFactory("LPProxy", signer)).deploy(await impl.getAddress(), data);
  await proxy.waitForDeployment();
  return ethers.getContractAt(name, await proxy.getAddress(), signer);
}

async function deployWorld() {
  const [owner, deliverer, signer, alice, bob, carol, stranger] = await ethers.getSigners();
  const Token = await ethers.getContractFactory("MockERC20Permit", owner);
  const { asset, usdc } = await deployOrderedPair(
    () => Token.deploy("Asset", "ASSET", 10n ** 30n, 18),
    () => Token.deploy("USD Coin", "USDC", 10n ** 24n, 6)
  );
  const assetAddr = await asset.getAddress();
  const usdcAddr = await usdc.getAddress();
  const assetFirst = assetAddr.toLowerCase() < usdcAddr.toLowerCase();
  const [token0, token1] = assetFirst ? [assetAddr, usdcAddr] : [usdcAddr, assetAddr];
  const tick = assetFirst ? PRICE_TICK : -PRICE_TICK;

  const pool = await (await ethers.getContractFactory("MockUniswapV3Pool", owner)).deploy(token0, token1, MATH_FEE);
  await pool.setTicks(tick, tick);
  const tickMath = await (await ethers.getContractFactory("MockMathPositionManager", owner)).deploy(await pool.getAddress());
  await pool.setSqrtPriceX96(sqrtAtTick(tick));
  const npm = tickMath;
  const router = await (await ethers.getContractFactory("MockSwapRouter", owner)).deploy();
  await router.setRate(usdcAddr, assetAddr, 4n * 10n ** 18n, 10n ** 6n);
  await asset.transfer(await router.getAddress(), 10n ** 28n);
  await asset.transfer(await npm.getAddress(), 10n ** 25n);
  await usdc.transfer(await npm.getAddress(), 10n ** 12n);

  const vault = await deployProxy(
    "LPStakingVault",
    [await npm.getAddress(), await pool.getAddress(), token0, token1, MATH_FEE, await router.getAddress()],
    [owner.address, owner.address, owner.address, ethers.ZeroAddress, 300, 500, 400000, 1000000],
    owner
  );
  const now = BigInt((await ethers.provider.getBlock("latest")).timestamp);
  const v3End = now + BigInt(V3_DURATION);
  const poolV3 = await deployProxy("WeightedStakingPoolV3", [], [owner.address, assetAddr, now, v3End, signer.address], owner);
  const bonusVault = await deployProxy(
    "V3BonusVault",
    [],
    [owner.address, assetAddr, ethers.ZeroAddress, await poolV3.getAddress(), await vault.getAddress()],
    owner
  );
  const migrator = await deployProxy(
    "StakingMigrator",
    [await vault.getAddress(), usdcAddr, assetAddr],
    [owner.address, await poolV3.getAddress(), await bonusVault.getAddress(), signer.address, 300, 953, 1800],
    owner
  );
  await poolV3.setBonusVault(await bonusVault.getAddress());
  await poolV3.setMigrator(await migrator.getAddress());
  await bonusVault.setMigrator(await migrator.getAddress());
  await vault.setBonusListener(await bonusVault.getAddress());
  await vault.setStakeOperator(await migrator.getAddress(), true);
  await migrator.unpauseCompound();

  const receiver = await deployProxy(
    "TransitionReceiver",
    [await migrator.getAddress()],
    [owner.address, deliverer.address],
    owner
  );
  await migrator.initializeTransition(await receiver.getAddress());

  for (const s of [alice, bob, carol, stranger]) {
    await asset.transfer(s.address, 10n ** 24n);
    await usdc.transfer(s.address, 10n ** 12n);
  }

  const world = {
    owner,
    deliverer,
    signer,
    alice,
    bob,
    carol,
    stranger,
    asset,
    usdc,
    pool,
    npm,
    router,
    vault,
    poolV3,
    bonusVault,
    migrator,
    receiver,
    v3End,
    assetFirst,
  };

  world.at = (holder, route) => receiver.receivingAddressOf(holder.address || holder, route);
  world.payAsset = async (holder, route, amount) => asset.transfer(await world.at(holder, route), amount);
  world.payUsdc = async (holder, route, amount) => usdc.transfer(await world.at(holder, route), amount);
  world.limits = (over = {}) => ({ minAssetOut: 0n, amount0Min: 0n, amount1Min: 0n, deadline: FAR, ...over });

  /** A delivery voucher signed with ethers' EIP-712 signer, the backend's way of signing it. */
  world.voucher = async (holder, route, { principal, reward = 0n, assetLimit, usdcLimit, burnTime, nonce, deadline, by } = {}) => {
    const holderAddr = holder.address || holder;
    const record = await migrator.deliveryOf(holderAddr);
    const latest = BigInt((await ethers.provider.getBlock("latest")).timestamp);
    const message = {
      holder: holderAddr,
      route,
      eligiblePrincipal: principal,
      eligibleReward: reward,
      assetLimit: assetLimit === undefined ? principal : assetLimit,
      usdcLimit: usdcLimit === undefined ? reward : usdcLimit,
      burnTime: burnTime === undefined ? latest - 1n : burnTime,
      nonce: nonce === undefined ? record.nextNonce : nonce,
      deadline: deadline === undefined ? FAR : deadline,
    };
    const domain = await world.domain();
    const signature = await (by || signer).signTypedData(domain, DELIVERY_TYPES, message);
    return { ...message, signature };
  };
  world.domain = async () => ({
    name: "StakingMigrator",
    version: "1",
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await migrator.getAddress(),
  });
  world.deliver = async (holder, route, v, limits = world.limits(), from = deliverer) =>
    receiver.connect(from).deliver(holder.address || holder, route, limits, v);
  return world;
}

/** TickMath.getSqrtRatioAtTick, through a throwaway library harness would be overkill: compute it. */
function sqrtAtTick(tick) {
  // The pool mock only needs a consistent sqrt price; the math position manager reads it. The exact
  // Uniswap value is used so the band math matches Forge's harness.
  const absTick = BigInt(Math.abs(tick));
  let ratio = (absTick & 0x1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  const steps = [
    [0x2n, 0xfff97272373d413259a46990580e213an],
    [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
    [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
    [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
    [0x20n, 0xff973b41fa98c081472e6896dfb254c0n],
    [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
    [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n],
    [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
    [0x200n, 0xf987a7253ac413176f2b074cf7815e54n],
    [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
    [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n],
    [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
    [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n],
    [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
    [0x8000n, 0x31be135f97d08fd981231505542fcfa6n],
    [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
    [0x20000n, 0x5d6af8dedb81196699c329225ee604n],
    [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
    [0x80000n, 0x48a170391f7dc42444e8fa2n],
  ];
  for (const [bit, mul] of steps) if ((absTick & bit) !== 0n) ratio = (ratio * mul) >> 128n;
  if (tick > 0) ratio = ((1n << 256n) - 1n) / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

module.exports = { deployWorld, deployProxy, DELIVERY_TYPES, PRICE_TICK, MATH_FEE, FAR };
