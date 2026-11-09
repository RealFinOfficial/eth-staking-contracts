const fs = require("fs");

const hre = require("hardhat");
const pools = require("./lib/pools");

// The staking v3 rehearsal on Sepolia, step by step, for three wallets: A (the deployer), B and C
// (two fresh keys kept in a JSON file OUTSIDE the repo). The deployer key (PRIVATE_KEY) signs both
// the sw2 test pool's weight vouchers and the migrator's TransitionVouchers, so it must be the
// signer of both (`WeightedStakingPoolTest.signer()`, `StakingMigrator.signer()`).
//
//   V3R_WALLETS   path to {"B": {"address", "privateKey"}, "C": {...}}; created by `fund` when missing
//   V3R_STATE     path to a JSON file the steps append their results to (addresses and hashes only)
//   V3R_ACTION    fund | sw2-stake | sw2-unstake | routes | withdraw | rebalance | status
//
// Every route call carries `deadline == 0` permits (the test tokens have no EIP-2612), so each
// wallet approves the migrator first. Roles: A compound, B moveToLp (+ rebalance), C claimRestake
// (+ an early withdraw of 1 tREAL). Refuses mainnet.
//
//   V3R_ACTION=fund V3R_WALLETS=/tmp/w.json V3R_STATE=/tmp/s.json \
//     npx hardhat run scripts/v3-rehearsal.js --network sepolia

const E = hre.ethers;
const STAKE = E.parseUnits("10000", 18);
const WEIGHT = 1500n;
const FUND_ETH = E.parseEther("0.05");
const FUND_ASSET = E.parseUnits("20000", 18);
const FUND_USDC = E.parseUnits("2000", 6);
const NO_PERMIT = { value: 0n, deadline: 0n, v: 0, r: E.ZeroHash, s: E.ZeroHash };
const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
];

function readJson(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback;
}

function json(value) {
  return JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}

/** Prints what is about to be sent, sends it, waits, logs hash + gas, appends to the state file. */
async function send(ctx, who, label, build) {
  const signer = ctx.wallets[who];
  const nonce = await pools.resolveNonce(signer.address);
  console.log(`[${who} ${signer.address}] SENDING ${label} (nonce ${nonce})`);
  const tx = await build(signer, { nonce });
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw new Error(`${label} reverted: ${receipt.hash}`);
  const fee = receipt.gasUsed * receipt.gasPrice;
  console.log(`  ok block ${receipt.blockNumber} tx ${receipt.hash} gas ${receipt.gasUsed} fee ${E.formatEther(fee)} ETH`);
  ctx.state.txs.push({
    step: ctx.action,
    wallet: who,
    label,
    hash: receipt.hash,
    block: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    feeWei: fee.toString(),
  });
  fs.writeFileSync(ctx.stateFile, json(ctx.state) + "\n");
  return receipt;
}

function parse(contract, receipt, name) {
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed && parsed.name === name) return parsed;
    } catch {
      /* another contract's log */
    }
  }
  return null;
}

async function approve(ctx, who, token, spender, amount, label) {
  const current = await token.allowance(ctx.wallets[who].address, spender);
  if (current >= amount) return;
  await send(ctx, who, `approve ${label}`, (s, o) => token.connect(s).approve(spender, amount, o));
}

async function signVoucher(ctx, user, route, principal, reward, nonce, deadline) {
  const domain = {
    name: "StakingMigrator",
    version: "1",
    chainId: ctx.chainId,
    verifyingContract: await ctx.migrator.getAddress(),
  };
  const types = {
    TransitionVoucher: [
      { name: "user", type: "address" },
      { name: "route", type: "uint8" },
      { name: "eligiblePrincipal", type: "uint256" },
      { name: "eligibleReward", type: "uint256" },
      { name: "weight", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };
  const value = { user, route, eligiblePrincipal: principal, eligibleReward: reward, weight: WEIGHT, nonce, deadline };
  const signature = await ctx.wallets.A.signTypedData(domain, types, value);
  return { route, eligiblePrincipal: principal, eligibleReward: reward, weight: WEIGHT, nonce, deadline, signature };
}

const actions = {
  async fund(ctx) {
    for (const who of ["B", "C"]) {
      const address = ctx.wallets[who].address;
      if ((await E.provider.getBalance(address)) < FUND_ETH) {
        await send(ctx, "A", `0.05 ETH -> ${who}`, (s, o) => s.sendTransaction({ to: address, value: FUND_ETH, ...o }));
      }
      if ((await ctx.asset.balanceOf(address)) < FUND_ASSET) {
        await send(ctx, "A", `20,000 tREAL -> ${who}`, (s, o) => ctx.asset.connect(s).transfer(address, FUND_ASSET, o));
      }
      if ((await ctx.usdc.balanceOf(address)) < FUND_USDC) {
        await send(ctx, "A", `2,000 tUSDC -> ${who}`, (s, o) => ctx.usdc.connect(s).transfer(address, FUND_USDC, o));
      }
    }
  },

  async "sw2-stake"(ctx) {
    const sw2 = ctx.sw2;
    const signerOnChain = await sw2.signer();
    if (signerOnChain.toLowerCase() !== ctx.wallets.A.address.toLowerCase()) {
      throw new Error(`sw2-test signer is ${signerOnChain}, not the deployer`);
    }
    for (const who of ["A", "B", "C"]) {
      const user = ctx.wallets[who].address;
      if ((await sw2.stakes(user)).amount > 0n) continue;
      await approve(ctx, who, ctx.asset, await sw2.getAddress(), STAKE, "tREAL -> sw2-test");
      const deadline = BigInt((await E.provider.getBlock("latest")).timestamp + 3600);
      const signature = await pools.signWeight({
        pool: sw2,
        action: "Stake",
        user,
        amount: STAKE,
        weight: WEIGHT,
        deadline,
        privateKey: process.env.PRIVATE_KEY,
      });
      await send(ctx, who, "sw2-test.stake(10,000 tREAL, weight 1500)", (s, o) =>
        sw2.connect(s).stake(STAKE, WEIGHT, deadline, signature, o)
      );
    }
  },

  async "sw2-unstake"(ctx) {
    ctx.state.sw2Reward = ctx.state.sw2Reward || {};
    for (const who of ["A", "B", "C"]) {
      const user = ctx.wallets[who].address;
      if ((await ctx.sw2.stakes(user)).amount === 0n) continue;
      const receipt = await send(ctx, who, "sw2-test.unstake()", (s, o) => ctx.sw2.connect(s).unstake(o));
      const ev = parse(ctx.sw2, receipt, "Unstaked");
      console.log(`  principal ${E.formatUnits(ev.args[1], 18)} tREAL, reward ${E.formatUnits(ev.args[2], 6)} tUSDC`);
      ctx.state.sw2Reward[who] = { principal: ev.args[1].toString(), reward: ev.args[2].toString() };
      fs.writeFileSync(ctx.stateFile, json(ctx.state) + "\n");
    }
  },

  async routes(ctx) {
    const m = ctx.migrator;
    const mAddr = await m.getAddress();
    const rewards = ctx.state.sw2Reward;
    if (!rewards || !rewards.A || !rewards.B || !rewards.C) throw new Error("run sw2-unstake first");
    for (const who of ["A", "B", "C"]) {
      await approve(ctx, who, ctx.asset, mAddr, E.MaxUint256, "tREAL -> migrator");
      if (who !== "C") await approve(ctx, who, ctx.usdc, mAddr, E.MaxUint256, "tUSDC -> migrator");
    }
    const deadline = BigInt((await E.provider.getBlock("latest")).timestamp + 3600);
    ctx.state.routes = ctx.state.routes || {};

    // A: route 1, compound.
    if (!(await m.migrated(ctx.wallets.A.address))) {
      const reward = BigInt(rewards.A.reward);
      const atTwap = await m.usdcInAsset(reward);
      const minOut = (atTwap * 97n) / 100n;
      console.log(`A: usdcInAsset(${E.formatUnits(reward, 6)} tUSDC) = ${E.formatUnits(atTwap, 18)} tREAL; minAssetOut ${E.formatUnits(minOut, 18)}`);
      const v = await signVoucher(ctx, ctx.wallets.A.address, 1, STAKE, reward, 1n, deadline);
      const receipt = await send(ctx, "A", "migrator.compound", (s, o) =>
        m.connect(s).compound(reward, STAKE, minOut, deadline, NO_PERMIT, NO_PERMIT, v, o)
      );
      const ev = parse(m, receipt, "Compounded");
      ctx.state.routes.A = { usdcIn: reward.toString(), atTwap: atTwap.toString(), minOut: minOut.toString(), ...namedArgs(ev) };
      fs.writeFileSync(ctx.stateFile, json(ctx.state) + "\n");
    }
    // B: route 2, moveToLp.
    if (!(await m.migrated(ctx.wallets.B.address))) {
      const reward = BigInt(rewards.B.reward);
      const v = await signVoucher(ctx, ctx.wallets.B.address, 2, STAKE, reward, 1n, deadline);
      const range = await m.lpRange();
      console.log(`B: lpRange ${range[0]} .. ${range[1]}`);
      const receipt = await send(ctx, "B", "migrator.moveToLp", (s, o) =>
        m.connect(s).moveToLp(reward, STAKE, 0, 0, deadline, NO_PERMIT, NO_PERMIT, v, o)
      );
      const ev = parse(m, receipt, "MovedToLp");
      ctx.state.routes.B = { usdcOffered: reward.toString(), usdcInAssetOfUsed: (await m.usdcInAsset(ev.args.usdcIn)).toString(), ...namedArgs(ev) };
      fs.writeFileSync(ctx.stateFile, json(ctx.state) + "\n");
    }
    // C: route 3, claimRestake.
    if (!(await m.migrated(ctx.wallets.C.address))) {
      const v = await signVoucher(ctx, ctx.wallets.C.address, 3, STAKE, BigInt(rewards.C.reward), 1n, deadline);
      const receipt = await send(ctx, "C", "migrator.claimRestake", (s, o) =>
        m.connect(s).claimRestake(STAKE, deadline, NO_PERMIT, v, o)
      );
      ctx.state.routes.C = namedArgs(parse(m, receipt, "ClaimRestaked"));
      fs.writeFileSync(ctx.stateFile, json(ctx.state) + "\n");
    }
  },

  async withdraw(ctx) {
    const before = { reserved: (await ctx.bonus.reservedOf(ctx.wallets.C.address))[0], total: await ctx.bonus.totalReserved() };
    const receipt = await send(ctx, "C", "poolV3.withdraw(1 tREAL, no weight voucher)", (s, o) =>
      ctx.poolV3.connect(s).withdraw(E.parseUnits("1", 18), 0, 0, "0x", o)
    );
    const forfeited = parse(ctx.bonus, receipt, "BonusForfeited");
    const after = { reserved: (await ctx.bonus.reservedOf(ctx.wallets.C.address))[0], total: await ctx.bonus.totalReserved() };
    ctx.state.withdraw = { before, after, forfeited: forfeited ? forfeited.args[1].toString() : null, withdrawn: namedArgs(parse(ctx.poolV3, receipt, "Withdrawn")) };
    fs.writeFileSync(ctx.stateFile, json(ctx.state) + "\n");
    console.log(json(ctx.state.withdraw));
  },

  async rebalance(ctx) {
    const tokenId = BigInt(ctx.state.routes.B.tokenId);
    const before = await ctx.bonus.lpReservation(tokenId);
    const tick = Number((await ctx.uniPool.slot0())[1]);
    const spacing = 60;
    const newLower = Math.ceil((tick + 120) / spacing) * spacing; // the band above the price: tREAL only
    const newUpper = newLower + 60 * spacing;
    const noSwap = { zeroForOne: true, amountIn: 0n, amountOutMin: 0n, amount0Min: 0n, amount1Min: 0n };
    const deadline = BigInt((await E.provider.getBlock("latest")).timestamp + 3600);
    console.log(`B: rebalance ${tokenId} to ${newLower} .. ${newUpper} (spot tick ${tick}), no swap leg`);
    const receipt = await send(ctx, "B", `vault.rebalance(${tokenId})`, (s, o) =>
      ctx.vault.connect(s).rebalance(tokenId, newLower, newUpper, noSwap, deadline, o)
    );
    const failed = parse(ctx.vault, receipt, "BonusListenerFailed");
    const newId = parse(ctx.vault, receipt, "Rebalanced").args.newTokenId;
    const moved = await ctx.bonus.lpReservation(newId);
    const old = await ctx.bonus.lpReservation(tokenId);
    ctx.state.rebalance = {
      oldTokenId: tokenId.toString(),
      newTokenId: newId.toString(),
      range: [newLower, newUpper],
      listenerFailed: Boolean(failed),
      before: { user: before.user, amount: before.amount.toString() },
      oldAfter: { user: old.user, amount: old.amount.toString() },
      newAfter: { user: moved.user, amount: moved.amount.toString() },
    };
    fs.writeFileSync(ctx.stateFile, json(ctx.state) + "\n");
    console.log(json(ctx.state.rebalance));
  },

  async status(ctx) {
    const out = {};
    for (const who of ["A", "B", "C"]) {
      const user = ctx.wallets[who].address;
      const [reserved, unlockAt] = await ctx.bonus.reservedOf(user);
      const lpIds = await ctx.bonus.lpTokensOf(user);
      const lp = [];
      for (const id of lpIds) {
        const r = await ctx.bonus.lpReservation(id);
        lp.push({ tokenId: id.toString(), user: r.user, amount: r.amount.toString(), stakerOf: await ctx.vault.stakerOf(id) });
      }
      out[who] = {
        address: user,
        v3Stake: (await ctx.poolV3.stakes(user)).amount.toString(),
        multiplier: (await ctx.poolV3.getUserMultiplier(user)).toString(),
        reservedOf: reserved.toString(),
        unlockAt: unlockAt.toString(),
        lp,
        migrated: await ctx.migrator.migrated(user),
        sw2Stake: (await ctx.sw2.stakes(user)).amount.toString(),
        tREAL: (await ctx.asset.balanceOf(user)).toString(),
        tUSDC: (await ctx.usdc.balanceOf(user)).toString(),
      };
    }
    out.totalReserved = (await ctx.bonus.totalReserved()).toString();
    out.totalLpReserved = (await ctx.bonus.totalLpReserved()).toString();
    out.bonusVaultBalance = (await ctx.asset.balanceOf(await ctx.bonus.getAddress())).toString();
    out.block = await E.provider.getBlockNumber();
    console.log(json(out));
    ctx.state.status = ctx.state.status || [];
    ctx.state.status.push(out);
    fs.writeFileSync(ctx.stateFile, json(ctx.state) + "\n");
  },
};

function namedArgs(ev) {
  if (!ev) return {};
  const out = {};
  ev.fragment.inputs.forEach((input, i) => (out[input.name] = ev.args[i].toString()));
  return out;
}

async function main() {
  const chainId = await pools.chainId();
  if (pools.isMainnet(chainId)) throw new Error("v3-rehearsal.js is a Sepolia rehearsal and refuses mainnet");
  const action = process.env.V3R_ACTION;
  if (!actions[action]) throw new Error(`V3R_ACTION must be one of ${Object.keys(actions).join(", ")}`);
  const walletsFile = process.env.V3R_WALLETS;
  const stateFile = process.env.V3R_STATE;
  if (!walletsFile || !stateFile) throw new Error("Set V3R_WALLETS and V3R_STATE (files outside the repo)");

  let keys = readJson(walletsFile, null);
  if (!keys) {
    if (action !== "fund") throw new Error(`${walletsFile} does not exist; run V3R_ACTION=fund first`);
    keys = {};
    for (const who of ["B", "C"]) {
      const w = E.Wallet.createRandom();
      keys[who] = { address: w.address, privateKey: w.privateKey };
    }
    fs.writeFileSync(walletsFile, JSON.stringify(keys, null, 2) + "\n", { mode: 0o600 });
    console.log(`Generated B ${keys.B.address} and C ${keys.C.address} (keys in ${walletsFile})`);
  }
  const deployer = await pools.getSigner();
  const wallets = {
    A: deployer,
    B: new E.Wallet(keys.B.privateKey, E.provider),
    C: new E.Wallet(keys.C.privateKey, E.provider),
  };

  const reg = pools.readRegistry()[String(chainId)];
  const need = (kind) => {
    if (!reg[kind]) throw new Error(`deployments.json has no ${kind} for chain ${chainId}`);
    return reg[kind].address;
  };
  const ctx = {
    action,
    chainId,
    wallets,
    stateFile,
    state: readJson(stateFile, { txs: [] }),
    asset: new E.Contract(reg.LPZapper.asset, ERC20, E.provider),
    usdc: new E.Contract(reg.LPZapper.usdc, ERC20, E.provider),
    sw2: reg.WeightedStakingPoolTest ? await E.getContractAt("WeightedStakingPool", need("WeightedStakingPoolTest")) : null,
    vault: await E.getContractAt("LPStakingVault", need("LPStakingVault")),
    uniPool: new E.Contract(need("UniswapV3Pool"), ["function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)"], E.provider),
  };
  if (reg.StakingMigrator) {
    ctx.poolV3 = await E.getContractAt("WeightedStakingPoolV3", need("WeightedStakingPoolV3"));
    ctx.bonus = await E.getContractAt("V3BonusVault", need("V3BonusVault"));
    ctx.migrator = await E.getContractAt("StakingMigrator", need("StakingMigrator"));
  }
  console.log(`Action ${action}; A ${wallets.A.address}, B ${wallets.B.address}, C ${wallets.C.address}`);
  await actions[action](ctx);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
