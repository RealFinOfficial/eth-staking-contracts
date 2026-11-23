const fs = require("fs");

const hre = require("hardhat");

// The two-chain transition rehearsal (spec 01 §9.2, §9.10): the commands `scripts/v3-rehearsal.js`
// runs as V3R_ACTION=tr-…, one transaction (or one pair) per command, every Ethereum step sent by the
// staker's own wallet, one after another, never in a batch.
//
// On the SOURCE test chain (Sepolia):
//   tr-unstake     the staker's `unstake()` on the v1 or the v2.0 test staking contract (TR_STAKING);
//                  records P (principal) and R (USDC reward) from the `Unstaked` event
//   tr-usdc        routes 1 and 2: `approve` of exactly R to Circle's TokenMessengerV2, then
//                  `depositForBurn(R, 1, bytes32(receivingAddress), USDC, bytes32(0), 0, 2000)`
//                  (domain 1 = Avalanche, standard transfer). Two transactions, in this order
//   tr-burn        the burn of P in the burn stand-in with `destination` = the receiving address:
//                  `approve` + `migrate`, with the access signature from TR_ACCESS_FILE when the
//                  stand-in requires one; records the burn id, seq and block time
// On the LP test chain (Fuji):
//   tr-mint-usdc   completes the Circle transfer: `receiveMessage(TR_MESSAGE, TR_ATTESTATION)` on
//                  MessageTransmitterV2 (the message and attestation from Circle's sandbox API)
//   tr-pay         one part of the payout: `PayoutStandIn.pay(id, destination, TR_PART, burnAmount)`
//                  by its owner (A), for the burn recorded by tr-burn
//   tr-deliver     `TransitionReceiver.deliver` by the holder itself, with a DeliveryVoucher signed by
//                  A (the migrator's voucher signer in the rehearsal) whose limits are what arrived so
//                  far, capped by P and R; run it again after a later tr-pay for a top-up
//   tr-release     `TransitionReceiver.release` by the holder
//   tr-status      read-only: the receiving address, its balances, deliveryOf, the stake
//
// The receiving address is a CREATE2 address of the Fuji receiver (TR_RECEIVER), computed off-chain
// from HOLDER_INIT_CODE_HASH on Sepolia (no Fuji call needed) and read from the receiver on Fuji.

const E = hre.ethers;

/** HOLDER_INIT_CODE_HASH of the TransitionReceiver (test/vectors/transition.json). */
const HOLDER_INIT_CODE_HASH = "0xc9fdfcb43183a49244ffe584d9e69edfb144922f0930ecd33fd099814b33579b";

/** Circle CCTP V2 on the test networks (the same addresses on Sepolia and Fuji; checked read-only 2026-11-20). */
const CCTP = {
  tokenMessengerV2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
  messageTransmitterV2: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
  usdc: { 11155111: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", 43113: "0x5425890298aed601595a70AB815c96711a31Bc65" },
  avalancheDomain: 1,
  standardFinality: 2000,
};

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];
const TOKEN_MESSENGER_ABI = [
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)",
];
const MESSAGE_TRANSMITTER_ABI = ["function receiveMessage(bytes message, bytes attestation) returns (bool)"];
const SOURCE_ABI = [
  "function unstake() returns (uint256)",
  "event Unstaked(address indexed user, uint256 amount, uint256 reward, uint256 userWeight, uint256 totalEffectiveWeight)",
  "event Unstaked(address indexed user, uint256 amount, uint256 reward, uint256 claimedRewards, uint256 userWeight, uint256 totalEffectiveWeight)",
];

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

function receivingAddress(receiver, holder, route) {
  const salt = E.keccak256(E.AbiCoder.defaultAbiCoder().encode(["address", "uint8"], [holder, route]));
  return E.getCreate2Address(E.getAddress(receiver), salt, HOLDER_INIT_CODE_HASH);
}

function readRoute(env) {
  const route = Number(env.TR_ROUTE);
  if (![1, 2, 3].includes(route)) throw new Error("Set TR_ROUTE to 1, 2 or 3");
  return route;
}

function readAddress(env, name, fallback) {
  const raw = env[name] || fallback;
  if (!raw || !E.isAddress(raw)) throw new Error(`Set ${name} to an address`);
  return E.getAddress(raw);
}

/** The state of one staker's transition, kept in ctx.state.transition[who]. */
function record(ctx, who) {
  ctx.state.transition = ctx.state.transition || {};
  ctx.state.transition[who] = ctx.state.transition[who] || {};
  return ctx.state.transition[who];
}

function save(ctx) {
  if (ctx.stateFile) {
    fs.writeFileSync(
      ctx.stateFile,
      JSON.stringify(ctx.state, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n"
    );
  }
}

function who(ctx) {
  const w = ctx.env.TR_WHO || "A";
  if (!ctx.wallets[w]) throw new Error(`TR_WHO=${w} names no wallet (have ${Object.keys(ctx.wallets).join(", ")})`);
  return w;
}

function parseLog(iface, receipt, name, address) {
  for (const log of receipt.logs) {
    if (address && log.address.toLowerCase() !== address.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name === name) return parsed;
    } catch {
      /* another contract's log */
    }
  }
  return null;
}

async function blockTime(blockNumber) {
  return BigInt((await E.provider.getBlock(blockNumber)).timestamp);
}

const actions = {
  /** Source chain: the staker's own unstake() on the v1 or the v2.0 test staking contract. */
  async "tr-unstake"(ctx) {
    const w = who(ctx);
    const source = new E.Contract(readAddress(ctx.env, "TR_STAKING"), SOURCE_ABI, E.provider);
    const receipt = await ctx.send(w, "unstake() on the source staking contract", (s, o) => source.connect(s).unstake(o));
    const ev = parseLog(source.interface, receipt, "Unstaked", await source.getAddress());
    if (!ev) throw new Error("no Unstaked event in the receipt");
    Object.assign(record(ctx, w), {
      source: await source.getAddress(),
      principal: ev.args.amount.toString(),
      reward: ev.args.reward.toString(),
      unstakeTx: receipt.hash,
    });
    save(ctx);
    return record(ctx, w);
  },

  /** Source chain, routes 1 and 2: approve exactly R to TokenMessengerV2, then depositForBurn. */
  async "tr-usdc"(ctx) {
    const w = who(ctx);
    const route = readRoute(ctx.env);
    if (route === 3) throw new Error("Route 3 sends no USDC (Claim rewards and restake principal)");
    const rec = record(ctx, w);
    const amount = BigInt(ctx.env.TR_USDC_AMOUNT || rec.reward || 0);
    if (amount === 0n) throw new Error("No USDC reward recorded; run tr-unstake or set TR_USDC_AMOUNT");
    const holder = ctx.wallets[w].address;
    const destination = receivingAddress(readAddress(ctx.env, "TR_RECEIVER"), holder, route);
    const usdc = new E.Contract(readAddress(ctx.env, "TR_USDC", CCTP.usdc[ctx.chainId]), ERC20, E.provider);
    const messenger = new E.Contract(
      readAddress(ctx.env, "TR_TOKEN_MESSENGER", CCTP.tokenMessengerV2),
      TOKEN_MESSENGER_ABI,
      E.provider
    );
    await ctx.send(w, `approve ${amount} USDC -> TokenMessengerV2`, (s, o) =>
      usdc.connect(s).approve(messenger.getAddress(), amount, o)
    );
    const receipt = await ctx.send(w, `depositForBurn(${amount}, 1, ${destination})`, (s, o) =>
      messenger
        .connect(s)
        .depositForBurn(
          amount,
          CCTP.avalancheDomain,
          E.zeroPadValue(destination, 32),
          usdc.getAddress(),
          E.ZeroHash,
          0,
          CCTP.standardFinality,
          o
        )
    );
    Object.assign(rec, {
      route,
      receivingAddress: destination,
      usdcAmount: amount.toString(),
      usdcTx: receipt.hash,
      usdcTime: (await blockTime(receipt.blockNumber)).toString(),
    });
    save(ctx);
    return rec;
  },

  /** Source chain: the burn of P with destination = the receiving address (approve + migrate). */
  async "tr-burn"(ctx) {
    const w = who(ctx);
    const route = readRoute(ctx.env);
    const rec = record(ctx, w);
    const amount = BigInt(ctx.env.TR_BURN_AMOUNT || rec.principal || 0);
    if (amount === 0n) throw new Error("No principal recorded; run tr-unstake or set TR_BURN_AMOUNT");
    const holder = ctx.wallets[w].address;
    const destination = receivingAddress(readAddress(ctx.env, "TR_RECEIVER"), holder, route);
    const standIn = await E.getContractAt("BurnStandIn", readAddress(ctx.env, "TR_BURN_STANDIN", ctx.registry.BurnStandIn));
    const token = new E.Contract(await standIn.token(), ERC20, E.provider);
    await ctx.send(w, `approve ${amount} $ASSET -> burn stand-in`, (s, o) =>
      token.connect(s).approve(standIn.getAddress(), amount, o)
    );
    let entry = null;
    if (ctx.env.TR_ACCESS_FILE) {
      const all = JSON.parse(fs.readFileSync(ctx.env.TR_ACCESS_FILE, "utf8"));
      entry = all.find((e) => e.address.toLowerCase() === holder.toLowerCase()) || null;
    }
    if ((await standIn.requireSignature()) && !entry) throw new Error(`The stand-in requires an access signature; none for ${holder}`);
    const receipt = await ctx.send(w, `migrate(${amount}, ${destination})`, (s, o) =>
      entry
        ? standIn.connect(s)["migrate(uint256,address,uint256,bytes)"](amount, destination, entry.deadline, entry.signature, o)
        : standIn.connect(s)["migrate(uint256,address)"](amount, destination, o)
    );
    const ev = parseLog(standIn.interface, receipt, "Migrated", await standIn.getAddress());
    Object.assign(rec, {
      route,
      receivingAddress: destination,
      burn: {
        id: ev.args.id,
        seq: ev.args.seq.toString(),
        amount: ev.args.amount.toString(),
        destination: ev.args.destination,
        tx: receipt.hash,
        time: (await blockTime(receipt.blockNumber)).toString(),
      },
    });
    save(ctx);
    return rec;
  },

  /** LP chain: completes the Circle transfer with Circle's message and attestation. */
  async "tr-mint-usdc"(ctx) {
    const w = who(ctx);
    if (!ctx.env.TR_MESSAGE || !ctx.env.TR_ATTESTATION) throw new Error("Set TR_MESSAGE and TR_ATTESTATION");
    const mt = new E.Contract(
      readAddress(ctx.env, "TR_MESSAGE_TRANSMITTER", CCTP.messageTransmitterV2),
      MESSAGE_TRANSMITTER_ABI,
      E.provider
    );
    const receipt = await ctx.send(w, "receiveMessage(message, attestation)", (s, o) =>
      mt.connect(s).receiveMessage(ctx.env.TR_MESSAGE, ctx.env.TR_ATTESTATION, o)
    );
    return { tx: receipt.hash };
  },

  /** LP chain: one part of the payout, by the payout stand-in's owner (A). */
  async "tr-pay"(ctx) {
    const w = who(ctx);
    const rec = record(ctx, w);
    if (!rec.burn) throw new Error(`No burn recorded for ${w}; run tr-burn first (same V3R_STATE file)`);
    const part = BigInt(ctx.env.TR_PART || 0);
    if (part === 0n) throw new Error("Set TR_PART (wei of $ASSET for this part)");
    const payout = await E.getContractAt("PayoutStandIn", readAddress(ctx.env, "TR_PAYOUT_STANDIN", ctx.registry.PayoutStandIn));
    const receipt = await ctx.send("A", `pay(${rec.burn.id}, ${rec.burn.destination}, ${part})`, (s, o) =>
      payout.connect(s).pay(rec.burn.id, rec.burn.destination, part, BigInt(rec.burn.amount), o)
    );
    const ev = parseLog(payout.interface, receipt, "Paid", await payout.getAddress());
    rec.payments = rec.payments || [];
    rec.payments.push({ amount: part.toString(), paidTotal: ev.args.paidTotal.toString(), tx: receipt.hash });
    save(ctx);
    return rec;
  },

  /** LP chain: deliver by the holder, voucher signed by A, limits = what arrived so far (capped). */
  async "tr-deliver"(ctx) {
    const w = who(ctx);
    const route = readRoute(ctx.env);
    const rec = record(ctx, w);
    const holder = ctx.wallets[w].address;
    const receiver = await E.getContractAt("TransitionReceiver", readAddress(ctx.env, "TR_RECEIVER", ctx.registry.TransitionReceiver));
    const migrator = await E.getContractAt("StakingMigrator", await receiver.migrator());
    const at = await receiver.receivingAddressOf(holder, route);
    const asset = new E.Contract(await receiver.asset(), ERC20, E.provider);
    const usdc = new E.Contract(await receiver.usdc(), ERC20, E.provider);
    const d = await migrator.deliveryOf(holder);
    const principal = BigInt(ctx.env.TR_ELIGIBLE_PRINCIPAL || rec.principal || 0);
    const reward = route === 3 ? 0n : BigInt(ctx.env.TR_ELIGIBLE_REWARD || rec.reward || 0);
    const arrivedAsset = d.principalDelivered + (await asset.balanceOf(at));
    const arrivedUsdc = d.rewardDelivered + (await usdc.balanceOf(at));
    const min = (a, b) => (a < b ? a : b);
    const times = [rec.burn && rec.burn.time, route !== 3 && rec.usdcTime].filter(Boolean).map(BigInt);
    const burnTime = ctx.env.TR_BURN_TIME ? BigInt(ctx.env.TR_BURN_TIME) : times.reduce((a, b) => (a > b ? a : b), 0n);
    if (burnTime === 0n) throw new Error("No burn time recorded; run tr-burn (and tr-usdc) or set TR_BURN_TIME");
    const latest = BigInt((await E.provider.getBlock("latest")).timestamp);
    const message = {
      holder,
      route,
      eligiblePrincipal: principal,
      eligibleReward: reward,
      assetLimit: min(arrivedAsset, principal),
      usdcLimit: min(arrivedUsdc, reward),
      burnTime: burnTime > latest ? latest : burnTime,
      nonce: d.nextNonce,
      deadline: latest + 3600n,
    };
    const domain = {
      name: "StakingMigrator",
      version: "1",
      chainId: ctx.chainId,
      verifyingContract: await migrator.getAddress(),
    };
    const signature = await ctx.wallets.A.signTypedData(domain, DELIVERY_TYPES, message);
    const limits = { minAssetOut: 0n, amount0Min: 0n, amount1Min: 0n, deadline: latest + 3600n };
    const receipt = await ctx.send(w, `deliver(${holder}, ${route}) nonce ${message.nonce}`, (s, o) =>
      receiver.connect(s).deliver(holder, route, limits, { ...message, signature }, o)
    );
    const ev = parseLog(receiver.interface, receipt, "Delivered", await receiver.getAddress());
    rec.deliveries = rec.deliveries || [];
    rec.deliveries.push({
      nonce: message.nonce.toString(),
      assetIn: ev.args.assetIn.toString(),
      usdcIn: ev.args.usdcIn.toString(),
      staked: ev.args.staked.toString(),
      lpTokenId: ev.args.lpTokenId.toString(),
      bonus: ev.args.bonus.toString(),
      tx: receipt.hash,
      gasUsed: receipt.gasUsed.toString(),
    });
    save(ctx);
    return rec;
  },

  /** LP chain: release by the holder. */
  async "tr-release"(ctx) {
    const w = who(ctx);
    const route = readRoute(ctx.env);
    const receiver = await E.getContractAt("TransitionReceiver", readAddress(ctx.env, "TR_RECEIVER", ctx.registry.TransitionReceiver));
    const holder = ctx.wallets[w].address;
    const receipt = await ctx.send(w, `release(${holder}, ${route})`, (s, o) => receiver.connect(s).release(holder, route, o));
    const ev = parseLog(receiver.interface, receipt, "Released", await receiver.getAddress());
    const rec = record(ctx, w);
    rec.releases = rec.releases || [];
    rec.releases.push({ asset: ev.args.assetAmount.toString(), usdc: ev.args.usdcAmount.toString(), tx: receipt.hash });
    save(ctx);
    return rec;
  },

  /** LP chain, read-only. */
  async "tr-status"(ctx) {
    const w = who(ctx);
    const route = readRoute(ctx.env);
    const receiver = await E.getContractAt("TransitionReceiver", readAddress(ctx.env, "TR_RECEIVER", ctx.registry.TransitionReceiver));
    const migrator = await E.getContractAt("StakingMigrator", await receiver.migrator());
    const holder = ctx.wallets[w].address;
    const at = await receiver.receivingAddressOf(holder, route);
    const asset = new E.Contract(await receiver.asset(), ERC20, E.provider);
    const usdc = new E.Contract(await receiver.usdc(), ERC20, E.provider);
    const pool = await E.getContractAt("WeightedStakingPoolV3", await migrator.stakingPool());
    const d = await migrator.deliveryOf(holder);
    const out = {
      holder,
      route,
      receivingAddress: at,
      placed: await receiver.isPlaced(holder, route),
      asset: (await asset.balanceOf(at)).toString(),
      usdc: (await usdc.balanceOf(at)).toString(),
      delivery: {
        route: Number(d.route),
        lpCreated: d.lpCreated,
        lpTokenId: d.lpTokenId.toString(),
        principalDelivered: d.principalDelivered.toString(),
        rewardDelivered: d.rewardDelivered.toString(),
        nextNonce: d.nextNonce.toString(),
      },
      staked: (await pool.stakes(holder)).toString(),
    };
    console.log(JSON.stringify(out, null, 2));
    return out;
  },
};

module.exports = { actions, receivingAddress, CCTP, HOLDER_INIT_CODE_HASH, DELIVERY_TYPES };
