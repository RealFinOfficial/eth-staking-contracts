const fs = require("fs");

const hre = require("hardhat");
const pools = require("./lib/pools");

// The staking v3 rehearsal on Sepolia, step by step, for four wallets: A (the deployer), B, C and D
// (fresh keys kept in a JSON file OUTSIDE the repo). The deployer key (PRIVATE_KEY) signs both
// the sw2 test pool's (v2) weight vouchers and the migrator's TransitionVouchers (no weight since
// 2026-11-10), so it must be the signer of both (`WeightedStakingPoolTest.signer()`,
// `StakingMigrator.signer()`).
//
//   V3R_WALLETS   path to {"B": {"address", "privateKey"}, "C": {...}, "D": {...}}; created by `fund`
//                 when missing, D appended by `fund-d` (the file stays mode 0600)
//   V3R_STATE     path to a JSON file the steps append their results to (addresses and hashes only)
//   V3R_ACTION    fund | sw2-stake | sw2-unstake | routes | withdraw | rebalance | status |
//                 fund-d | move-d | rebalance-d
//
// Every route call carries `deadline == 0` permits (the test tokens have no EIP-2612), so each
// wallet approves the migrator first. Roles: A compound, B moveToLp (+ rebalance), C claimRestake
// (+ an early withdraw of 1 tREAL). Refuses mainnet.
//
// D proves the owner-set hook gas (audit notes item 20) after the vault upgrade of 2026-11-10: a
// fresh LP reservation rebalanced, so the listener's `onRebalance` writes a NEW row. D never stakes
// in sw2-test (the migrator does not read it; eligibility is the signed voucher alone):
//   fund-d       generates D when missing, prints A's balances, sends D 0.05 ETH, 20,000 tREAL,
//                2,000 tUSDC (as B and C)
//   move-d       moveToLp(300 tUSDC, 10,000 tREAL) with a voucher of eligiblePrincipal 10,000
//                tREAL, eligibleReward 300 tUSDC, nonce 1
//   rebalance-d  the no-swap band rebalance of D's tokenId; checks LpBonusMoved, the new row
//                active for D, the old row gone, totalLpReserved and stakerOf(newId)
//
//   V3R_ACTION=fund V3R_WALLETS=/tmp/w.json V3R_STATE=/tmp/s.json \
//     npx hardhat run scripts/v3-rehearsal.js --network sepolia

const E = hre.ethers;
const STAKE = E.parseUnits("10000", 18);
const WEIGHT = 1500n; // the sw2 test pool's (v2) weight voucher only
const FUND_ETH = E.parseEther("0.05");
const FUND_ASSET = E.parseUnits("20000", 18);
const FUND_USDC = E.parseUnits("2000", 6);
const D_REWARD = E.parseUnits("300", 6);
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
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };
  const value = { user, route, eligiblePrincipal: principal, eligibleReward: reward, nonce, deadline };
  const signature = await ctx.wallets.A.signTypedData(domain, types, value);
  return { route, eligiblePrincipal: principal, eligibleReward: reward, nonce, deadline, signature };
}

const actions = {
  async fund(ctx) {
    for (const who of ["B", "C"]) await fundWallet(ctx, who);
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
    const receipt = await send(ctx, "C", "poolV3.withdraw(1 tREAL)", (s, o) =>
      ctx.poolV3.connect(s).withdraw(E.parseUnits("1", 18), o)
    );
    const forfeited = parse(ctx.bonus, receipt, "BonusForfeited");
    const after = { reserved: (await ctx.bonus.reservedOf(ctx.wallets.C.address))[0], total: await ctx.bonus.totalReserved() };
    ctx.state.withdraw = { before, after, forfeited: forfeited ? forfeited.args[1].toString() : null, withdrawn: namedArgs(parse(ctx.poolV3, receipt, "Withdrawn")) };
    fs.writeFileSync(ctx.stateFile, json(ctx.state) + "\n");
    console.log(json(ctx.state.withdraw));
  },

  async rebalance(ctx) {
    ctx.state.rebalance = await rebalanceBand(ctx, "B", BigInt(ctx.state.routes.B.tokenId));
    fs.writeFileSync(ctx.stateFile, json(ctx.state) + "\n");
    console.log(json(ctx.state.rebalance));
  },

  async "fund-d"(ctx) {
    const a = ctx.wallets.A.address;
    const balances = {
      ETH: E.formatEther(await E.provider.getBalance(a)),
      tREAL: E.formatUnits(await ctx.asset.balanceOf(a), 18),
      tUSDC: E.formatUnits(await ctx.usdc.balanceOf(a), 6),
    };
    console.log(`A balances before funding D: ${json(balances)}`);
    ctx.state.fundD = { aBefore: balances, d: ctx.wallets.D.address };
    fs.writeFileSync(ctx.stateFile, json(ctx.state) + "\n");
    await fundWallet(ctx, "D");
  },

  async "move-d"(ctx) {
    const m = ctx.migrator;
    const d = ctx.wallets.D.address;
    if (await m.migrated(d)) throw new Error(`D ${d} has already migrated`);
    const mAddr = await m.getAddress();
    await approve(ctx, "D", ctx.asset, mAddr, E.MaxUint256, "tREAL -> migrator");
    await approve(ctx, "D", ctx.usdc, mAddr, E.MaxUint256, "tUSDC -> migrator");
    const deadline = BigInt((await E.provider.getBlock("latest")).timestamp + 3600);
    const v = await signVoucher(ctx, d, 2, STAKE, D_REWARD, 1n, deadline);
    const range = await m.lpRange();
    console.log(`D: lpRange ${range[0]} .. ${range[1]}`);
    const receipt = await send(ctx, "D", "migrator.moveToLp", (s, o) =>
      m.connect(s).moveToLp(D_REWARD, STAKE, 0, 0, deadline, NO_PERMIT, NO_PERMIT, v, o)
    );
    const ev = parse(m, receipt, "MovedToLp");
    const tokenId = ev.args.tokenId;
    const r = await ctx.bonus.lpReservation(tokenId);
    ctx.state.routes = ctx.state.routes || {};
    ctx.state.routes.D = {
      usdcOffered: D_REWARD.toString(),
      ...namedArgs(ev),
      lpReservation: { user: r.user, amount: r.amount.toString() },
      stakerOf: await ctx.vault.stakerOf(tokenId),
      totalLpReserved: (await ctx.bonus.totalLpReserved()).toString(),
      totalReserved: (await ctx.bonus.totalReserved()).toString(),
    };
    fs.writeFileSync(ctx.stateFile, json(ctx.state) + "\n");
    console.log(json(ctx.state.routes.D));
  },

  async "rebalance-d"(ctx) {
    if (!ctx.state.routes || !ctx.state.routes.D) throw new Error("run move-d first");
    const result = await rebalanceBand(ctx, "D", BigInt(ctx.state.routes.D.tokenId));
    ctx.state.rebalanceD = result;
    fs.writeFileSync(ctx.stateFile, json(ctx.state) + "\n");
    console.log(json(result));
    const d = ctx.wallets.D.address.toLowerCase();
    const problems = [];
    if (result.listenerFailed) problems.push("BonusListenerFailed emitted");
    if (!result.moved) problems.push("no LpBonusMoved");
    else if (BigInt(result.moved.newAmount) > BigInt(result.moved.oldAmount)) problems.push("newAmount > amount");
    if (result.newAfter.user.toLowerCase() !== d || BigInt(result.newAfter.amount) === 0n) problems.push("new row not active for D");
    if (BigInt(result.oldAfter.amount) !== 0n) problems.push("old row still holds an amount");
    if (result.stakerOfNew.toLowerCase() !== d) problems.push("stakerOf(newId) is not D");
    if (result.moved && BigInt(result.totalLpReservedBefore) - BigInt(result.totalLpReservedAfter) !== BigInt(result.moved.oldAmount) - BigInt(result.moved.newAmount)) {
      problems.push("totalLpReserved did not fall by amount - newAmount");
    }
    if (problems.length) throw new Error(`rebalance-d checks FAILED: ${problems.join("; ")}`);
    console.log("rebalance-d checks: all OK");
  },

  async status(ctx) {
    const out = {};
    for (const who of Object.keys(ctx.wallets)) {
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
        v3Stake: (await ctx.poolV3.stakes(user)).toString(),
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

/** Tops a wallet up from A to 0.05 ETH, 20,000 tREAL and 2,000 tUSDC (each sent only when short). */
async function fundWallet(ctx, who) {
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

/** Rebalances `tokenId` of `who` to a 60-spacing band above the price (tREAL only, no swap leg). */
async function rebalanceBand(ctx, who, tokenId) {
  const before = await ctx.bonus.lpReservation(tokenId);
  const totalLpReservedBefore = await ctx.bonus.totalLpReserved();
  const tick = Number((await ctx.uniPool.slot0())[1]);
  const spacing = 60;
  const newLower = Math.ceil((tick + 120) / spacing) * spacing; // the band above the price: tREAL only
  const newUpper = newLower + 60 * spacing;
  const noSwap = { zeroForOne: true, amountIn: 0n, amountOutMin: 0n, amount0Min: 0n, amount1Min: 0n };
  const deadline = BigInt((await E.provider.getBlock("latest")).timestamp + 3600);
  console.log(`${who}: rebalance ${tokenId} to ${newLower} .. ${newUpper} (spot tick ${tick}), no swap leg`);
  const receipt = await send(ctx, who, `vault.rebalance(${tokenId})`, (s, o) =>
    ctx.vault.connect(s).rebalance(tokenId, newLower, newUpper, noSwap, deadline, o)
  );
  const failed = parse(ctx.vault, receipt, "BonusListenerFailed");
  const newId = parse(ctx.vault, receipt, "Rebalanced").args.newTokenId;
  const moved = parse(ctx.bonus, receipt, "LpBonusMoved");
  const newRow = await ctx.bonus.lpReservation(newId);
  const old = await ctx.bonus.lpReservation(tokenId);
  return {
    oldTokenId: tokenId.toString(),
    newTokenId: newId.toString(),
    range: [newLower, newUpper],
    hash: receipt.hash,
    block: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    listenerFailed: Boolean(failed),
    moved: moved ? namedArgs(moved) : null,
    before: { user: before.user, amount: before.amount.toString() },
    oldAfter: { user: old.user, amount: old.amount.toString() },
    newAfter: { user: newRow.user, amount: newRow.amount.toString() },
    stakerOfNew: await ctx.vault.stakerOf(newId),
    totalLpReservedBefore: totalLpReservedBefore.toString(),
    totalLpReservedAfter: (await ctx.bonus.totalLpReserved()).toString(),
  };
}

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
  if (!keys.D && action === "fund-d") {
    const w = E.Wallet.createRandom();
    keys.D = { address: w.address, privateKey: w.privateKey };
    fs.writeFileSync(walletsFile, JSON.stringify(keys, null, 2) + "\n", { mode: 0o600 });
    fs.chmodSync(walletsFile, 0o600);
    console.log(`Generated D ${keys.D.address} (key in ${walletsFile})`);
  }
  if (!keys.D && action.endsWith("-d")) throw new Error(`${walletsFile} has no D; run V3R_ACTION=fund-d first`);
  const deployer = await pools.getSigner();
  const wallets = {
    A: deployer,
    B: new E.Wallet(keys.B.privateKey, E.provider),
    C: new E.Wallet(keys.C.privateKey, E.provider),
  };
  if (keys.D) wallets.D = new E.Wallet(keys.D.privateKey, E.provider);

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
  console.log(`Action ${action}; ${Object.entries(wallets).map(([who, w]) => `${who} ${w.address}`).join(", ")}`);
  await actions[action](ctx);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
