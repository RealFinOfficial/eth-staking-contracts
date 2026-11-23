const hre = require("hardhat");
const pools = require("./pools");

// The TARGETED stake commands of `scripts/v3-rehearsal.js` (2026-11-23): fund and stake the rehearsal
// wallets in ONE named test staking contract, with that contract's OWN staking token (its
// `stakingToken()`, read on chain), never the registry's `LPZapper.asset`.
//
//   V3R_STAKING   the target staking contract. Turns `fund` and `sw2-stake` into their targeted form;
//                 required by `v1-stake`
//   V3R_WHO       the wallets, comma-separated (A, B, C, D as in the wallets file). Defaults: fund B,C;
//                 sw2-stake A,B,C; v1-stake has no default. `fund` refuses A (A is the sender)
//   V3R_AMOUNT    whole tokens of the staking token (its own decimals), default 10000
//   V3R_DRY_RUN   1 | yes | true: print every transaction that would be sent (who, to which contract,
//                 which token, how much) and send nothing. The checks run in a dry run too
//
//   fund       from A to each chosen wallet: the staking token up to V3R_AMOUNT (only the shortfall;
//              nothing when the wallet already holds it or already has a stake in the target), and
//              Sepolia ETH only when the wallet holds less than GAS_BUDGET gas at the current
//              maxFeePerGas (it then gets the difference). No USDC
//   sw2-stake  each chosen wallet: approve exactly V3R_AMOUNT to the v2.0-type contract
//              (WeightedStakingPool) when the allowance is short, then stake(V3R_AMOUNT, 1500,
//              deadline, signature) with the weight voucher signed by PRIVATE_KEY (it must be the
//              contract's `signer()`). A wallet that already has a stake there is skipped
//   v1-stake   each chosen wallet: approve exactly V3R_AMOUNT to the v1-type contract (StakingPool)
//              when short, then stake(V3R_AMOUNT). StakingPool.stake needs: the owner not renounced
//              ("Staking disabled"), block time < endEpoch ("Pool has ended"), amount > 0 and the
//              allowance; a stake before activationEpoch is allowed. A wallet that already has a
//              stake there is skipped
//
// Each command refuses a target of the wrong type, a closed window and a short token balance (in a
// dry run the short balance is printed as a NOTE instead, so the stake commands can be dry-run
// before `fund`).

const E = hre.ethers;

const WEIGHT = 1500n; // the weight of the earlier sw2 rehearsal
const DEFAULT_AMOUNT = "10000";
/**
 * Gas units a staker needs for one approve and one stake, with margin. Measured locally: approve
 * 46,390; WeightedStakingPool.stake 229,554 (first staker) / 194,034; StakingPool.stake 139,539.
 */
const GAS_BUDGET = 400_000n;
const COMMANDS = ["fund", "sw2-stake", "v1-stake"];
const NEW_SETTINGS = ["V3R_WHO", "V3R_AMOUNT", "V3R_DRY_RUN"];
const DEFAULT_WHO = { fund: "B,C", "sw2-stake": "A,B,C" };
const KIND = { "sw2-stake": "WeightedStakingPool", "v1-stake": "StakingPool" };
const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

function isSet(env, name) {
  return env[name] !== undefined && String(env[name]).trim() !== "";
}

/**
 * True when `action` runs in its targeted form (this file); false for the original form. Throws
 * when the new settings are set where they do not apply, so they are never silently ignored.
 */
function isTargeted(action, env) {
  const named = NEW_SETTINGS.filter((n) => isSet(env, n));
  if (!COMMANDS.includes(action)) {
    const stray = isSet(env, "V3R_STAKING") ? ["V3R_STAKING", ...named] : named;
    if (stray.length) throw new Error(`${stray.join(", ")} apply only to ${COMMANDS.join(", ")}`);
    return false;
  }
  if (isSet(env, "V3R_STAKING")) return true;
  if (action === "v1-stake") throw new Error("v1-stake needs V3R_STAKING (the v1-type StakingPool)");
  if (named.length) throw new Error(`${named.join(", ")} need V3R_STAKING (the target staking contract)`);
  return false;
}

function dryRun(env) {
  if (!isSet(env, "V3R_DRY_RUN")) return false;
  const v = String(env.V3R_DRY_RUN).trim().toLowerCase();
  if (["1", "yes", "true"].includes(v)) return true;
  if (["0", "no", "false"].includes(v)) return false;
  throw new Error(`V3R_DRY_RUN must be 1 | yes | true (or 0 | no | false), not ${env.V3R_DRY_RUN}`);
}

function chosenWallets(action, env, wallets) {
  const raw = isSet(env, "V3R_WHO") ? env.V3R_WHO : DEFAULT_WHO[action];
  if (!raw) throw new Error(`${action} needs V3R_WHO (one or more of ${Object.keys(wallets).join(", ")})`);
  const who = [...new Set(String(raw).split(",").map((w) => w.trim().toUpperCase()).filter(Boolean))];
  for (const w of who) {
    if (!wallets[w]) throw new Error(`V3R_WHO names ${w}, which is not in the wallets (${Object.keys(wallets).join(", ")})`);
  }
  if (action === "fund" && who.includes("A")) throw new Error("fund sends from A, so V3R_WHO cannot name A");
  if (!who.length) throw new Error("V3R_WHO is empty");
  return who;
}

/** Reads the target, its staking token and the settings; prints them. */
async function load(ctx) {
  const { action, env } = ctx;
  const target = E.getAddress(String(env.V3R_STAKING).trim());
  if ((await E.provider.getCode(target)) === "0x") throw new Error(`No contract code at ${target}`);
  const kind = await pools.detectKind(target);
  if (KIND[action] && KIND[action] !== kind) {
    throw new Error(`${action} needs a ${KIND[action]}, but ${target} is a ${kind}`);
  }
  const pool = await E.getContractAt(kind, target);
  const token = new E.Contract(await pool.stakingToken(), ERC20, E.provider);
  const decimals = Number(await token.decimals());
  let symbol = "?";
  try {
    symbol = await token.symbol();
  } catch {
    /* a token without symbol() */
  }
  const amount = E.parseUnits(isSet(env, "V3R_AMOUNT") ? String(env.V3R_AMOUNT).trim() : DEFAULT_AMOUNT, decimals);
  if (amount <= 0n) throw new Error("V3R_AMOUNT must be above 0");
  const o = {
    target,
    kind,
    pool,
    token,
    tokenAddress: await token.getAddress(),
    decimals,
    symbol,
    amount,
    who: chosenWallets(action, env, ctx.wallets),
    dryRun: dryRun(env),
    planned: [],
  };
  o.fmt = (v) => `${E.formatUnits(v, decimals)} ${symbol}`;
  console.log(
    `${o.dryRun ? "DRY RUN " : ""}${action}: target ${kind} ${target}, staking token ${symbol} ${o.tokenAddress} ` +
      `(${decimals} decimals), amount ${o.fmt(amount)}, wallets ${o.who.join(",")}`
  );
  return o;
}

/** Refuses a renounced owner and a closed window; prints the window. */
async function requireOpen(o) {
  const [owner, activation, end, block] = await Promise.all([
    o.pool.owner(),
    o.pool.activationEpoch(),
    o.pool.endEpoch(),
    E.provider.getBlock("latest"),
  ]);
  const iso = (s) => pools.epochToIso(s);
  console.log(`  window: activation ${iso(activation)}, end ${iso(end)}, chain time ${iso(block.timestamp)}`);
  if (owner === E.ZeroAddress) throw new Error(`${o.target}: staking disabled (owner renounced)`);
  if (BigInt(block.timestamp) >= end) throw new Error(`${o.target}: the staking window closed at ${iso(end)}`);
}

/** Sends one transaction through ctx.send, or in a dry run only prints and records it. */
async function tx(ctx, o, entry, build) {
  const from = ctx.wallets[entry.who].address;
  const line = `[${entry.who} ${from}] ${entry.what} -> ${entry.to}${entry.token ? `, token ${entry.token}` : ""}, amount ${entry.shown}`;
  o.planned.push({ ...entry, from, amount: entry.amount.toString() });
  if (o.dryRun) {
    console.log(`  WOULD SEND ${line}`);
    return null;
  }
  return ctx.send(entry.who, `${entry.what} ${entry.shown} -> ${entry.to}`, build);
}

async function feePerGas() {
  const fee = await E.provider.getFeeData();
  return fee.maxFeePerGas ?? fee.gasPrice;
}

/** The token balance check of a staker: throws in a real run, a NOTE in a dry run. */
async function requireBalance(ctx, o, who) {
  const balance = await o.token.balanceOf(ctx.wallets[who].address);
  if (balance >= o.amount) return true;
  const msg = `${who} holds ${o.fmt(balance)}, needs ${o.fmt(o.amount)} (run fund first)`;
  if (!o.dryRun) throw new Error(msg);
  console.log(`  NOTE ${msg}`);
  return false;
}

async function approveExact(ctx, o, who) {
  const current = await o.token.allowance(ctx.wallets[who].address, o.target);
  if (current >= o.amount) return;
  await tx(ctx, o, { who, what: "approve", to: o.tokenAddress, token: o.tokenAddress, amount: o.amount, shown: `${o.fmt(o.amount)} (spender ${o.target})` }, (s, opts) =>
    o.token.connect(s).approve(o.target, o.amount, opts)
  );
}

async function report(ctx, o) {
  const staked = {};
  for (const who of o.who) staked[who] = (await o.pool.stakes(ctx.wallets[who].address)).amount.toString();
  if (!o.dryRun) for (const who of o.who) console.log(`  staked: ${who} ${o.fmt(BigInt(staked[who]))}`);
  return staked;
}

const actions = {
  async fund(ctx) {
    const o = await load(ctx);
    const a = ctx.wallets.A.address;
    const ethNeed = GAS_BUDGET * (await feePerGas());
    const tokensOut = [];
    for (const who of o.who) {
      const address = ctx.wallets[who].address;
      const eth = await E.provider.getBalance(address);
      if (eth < ethNeed) {
        const value = ethNeed - eth;
        await tx(ctx, o, { who: "A", what: `ETH to ${who}`, to: address, token: null, amount: value, shown: `${E.formatEther(value)} ETH` }, (s, opts) =>
          s.sendTransaction({ to: address, value, ...opts })
        );
      } else {
        console.log(`  ${who} holds ${E.formatEther(eth)} ETH >= ${E.formatEther(ethNeed)} ETH (${GAS_BUDGET} gas), no ETH sent`);
      }
      const staked = (await o.pool.stakes(address)).amount;
      if (staked > 0n) {
        console.log(`  ${who} already has ${o.fmt(staked)} staked in ${o.target}, no token sent`);
        continue;
      }
      const balance = await o.token.balanceOf(address);
      if (balance >= o.amount) {
        console.log(`  ${who} already holds ${o.fmt(balance)}, no token sent`);
        continue;
      }
      tokensOut.push({ who, address, value: o.amount - balance });
    }
    const total = tokensOut.reduce((s, t) => s + t.value, 0n);
    const aBalance = await o.token.balanceOf(a);
    if (aBalance < total) {
      const msg = `A holds ${o.fmt(aBalance)}, needs ${o.fmt(total)} to fund ${tokensOut.map((t) => t.who).join(",")}`;
      if (!o.dryRun) throw new Error(msg);
      console.log(`  NOTE ${msg}`);
    }
    for (const t of tokensOut) {
      await tx(ctx, o, { who: "A", what: `transfer to ${t.who} ${t.address}`, to: o.tokenAddress, token: o.tokenAddress, amount: t.value, shown: o.fmt(t.value) }, (s, opts) =>
        o.token.connect(s).transfer(t.address, t.value, opts)
      );
    }
    return { planned: o.planned };
  },

  async "sw2-stake"(ctx) {
    const o = await load(ctx);
    await requireOpen(o);
    const signerOnChain = await o.pool.signer();
    const signer = new E.Wallet(ctx.weightKey).address;
    if (signerOnChain.toLowerCase() !== signer.toLowerCase()) {
      throw new Error(`${o.target} signer() is ${signerOnChain}, not the PRIVATE_KEY wallet ${signer}`);
    }
    for (const who of o.who) {
      const user = ctx.wallets[who].address;
      const current = (await o.pool.stakes(user)).amount;
      if (current > 0n) {
        console.log(`  ${who} already has ${o.fmt(current)} staked, skipped`);
        continue;
      }
      await requireBalance(ctx, o, who);
      await approveExact(ctx, o, who);
      const deadline = BigInt((await E.provider.getBlock("latest")).timestamp + 3600);
      const signature = await pools.signWeight({
        pool: o.pool,
        action: "Stake",
        user,
        amount: o.amount,
        weight: WEIGHT,
        deadline,
        privateKey: ctx.weightKey,
      });
      await tx(ctx, o, { who, what: `stake (weight ${WEIGHT})`, to: o.target, token: o.tokenAddress, amount: o.amount, shown: o.fmt(o.amount) }, (s, opts) =>
        o.pool.connect(s).stake(o.amount, WEIGHT, deadline, signature, opts)
      );
    }
    return { planned: o.planned, staked: await report(ctx, o) };
  },

  async "v1-stake"(ctx) {
    const o = await load(ctx);
    await requireOpen(o);
    for (const who of o.who) {
      const user = ctx.wallets[who].address;
      const current = (await o.pool.stakes(user)).amount;
      if (current > 0n) {
        console.log(`  ${who} already has ${o.fmt(current)} staked, skipped`);
        continue;
      }
      await requireBalance(ctx, o, who);
      await approveExact(ctx, o, who);
      await tx(ctx, o, { who, what: "stake", to: o.target, token: o.tokenAddress, amount: o.amount, shown: o.fmt(o.amount) }, (s, opts) =>
        o.pool.connect(s).stake(o.amount, opts)
      );
    }
    return { planned: o.planned, staked: await report(ctx, o) };
  },
};

module.exports = { actions, isTargeted, COMMANDS, GAS_BUDGET, WEIGHT };
