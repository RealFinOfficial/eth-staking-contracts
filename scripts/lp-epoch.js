const hre = require("hardhat");
const pools = require("./lib/pools");

// Operator front end for `LPEpochRegistry`: read the emission schedule, schedule the next
// epoch, change a quantity, move the bounds of the last epoch, or cancel it.
//
// The registry is the program's on-chain emission SCHEDULE: for each epoch its start, its end,
// and the quantity of each reward token it emits. The backend mirrors it and spreads every
// quantity over the epoch's 15-minute intervals. It bounds nothing — the distributor pays valid
// vouchers whatever the schedule says.
//
// Every write is an OPERATOR call with no timelock delay. When the configured signer IS the
// registry's operator the script sends it; otherwise (the mainnet Safe) it prints the `to` and
// `data` for the Safe and sends nothing.
//
// The contract's rules are checked here first, against the CHAIN's clock, so a Safe transaction
// is never proposed that would revert: every bound on the 900-second grid; `endsAt > startsAt`;
// `startsAt >= now + 30 minutes` (a Safe transaction can sit for hours — check the time you
// expect it to EXECUTE, and leave margin); no overlap with the last live epoch; bounds and
// cancel only on the last live epoch.
//
// ──────────────────────── environment ────────────────────────
//
//   EPOCH_ACTION      show (default) | schedule | set-amount | update-bounds | cancel
//   EPOCH_ID          the epoch id; for `schedule` it must be epochCount + 1 (defaults to it)
//   EPOCH_STARTS_AT   unix seconds or ISO-8601 UTC (e.g. 2026-10-07T12:00:00Z)
//   EPOCH_ENDS_AT     unix seconds or ISO-8601 UTC; or EPOCH_DURATION (seconds) instead
//   EPOCH_AMOUNTS     quantities in WHOLE tokens, `SYMBOL=amount,SYMBOL=amount` (symbols as the
//                     tokens report them, case-insensitive) or `0xToken=amount`. `ASSET` also
//                     resolves to the registry's $ASSET (LPZapper.asset) whatever its symbol.
//                     For `schedule` of epoch 1 without EPOCH_AMOUNTS the placeholders
//                     LP_EPOCH1_OVTR_AMOUNT and LP_EPOCH1_ASSET_AMOUNT are used (to be decided
//                     with Brandon before 7 Oct).
//   EPOCH_TOKEN       set-amount: the token (symbol or address)
//   EPOCH_AMOUNT      set-amount: the quantity in whole tokens (0 allowed)
//   LP_REGISTRY_ADDRESS overrides the deployments.json lookup
//   CONFIRM=yes       required on mainnet before anything is sent
//
//     EPOCH_ACTION=schedule EPOCH_STARTS_AT=2026-10-07T12:00:00Z EPOCH_DURATION=604800 \
//       EPOCH_AMOUNTS="OVTR=1000000,ASSET=3000" npx hardhat run scripts/lp-epoch.js --network sepolia

const INTERVAL = 900n;
const SCHEDULE_MARGIN = 1800n;
const ACTIONS = ["show", "schedule", "set-amount", "update-bounds", "cancel"];

const REGISTRY_ABI = [
  "function distributor() view returns (address)",
  "function operator() view returns (address)",
  "function epochCount() view returns (uint256)",
  "function lastLiveId() view returns (uint256)",
  "function currentEpoch() view returns (uint256)",
  "function epoch(uint256 id) view returns ((uint64 startsAt, uint64 endsAt, uint64 prevLiveId, bool cancelled))",
  "function epochAmount(uint256 id, address token) view returns (uint256)",
  "function epochTokens(uint256 id) view returns (address[])",
  "function scheduleEpoch(uint256 id, uint64 startsAt, uint64 endsAt, address[] tokens, uint256[] amounts)",
  "function setEpochAmount(uint256 id, address token, uint256 amount)",
  "function updateEpochBounds(uint256 id, uint64 startsAt, uint64 endsAt)",
  "function cancelEpoch(uint256 id)",
];
const DISTRIBUTOR_ABI = [
  "function rewardTokens() view returns (address[])",
  "function isRewardToken(address token) view returns (bool)",
];
const ERC20_ABI = ["function symbol() view returns (string)", "function decimals() view returns (uint8)"];

/** Unix seconds from either a number or an ISO-8601 string. */
function parseTime(name, raw) {
  if (!raw) throw new Error(`Set ${name}`);
  if (/^\d+$/.test(raw)) return BigInt(raw);
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) throw new Error(`${name} is neither unix seconds nor ISO-8601: ${raw}`);
  return BigInt(Math.floor(ms / 1000));
}

const iso = (seconds) => new Date(Number(seconds) * 1000).toISOString();

/** Every registered reward token with its symbol and decimals, plus the ASSET alias. */
async function tokenBook(distributor, chainId) {
  const book = [];
  for (const address of await distributor.rewardTokens()) {
    const token = new hre.ethers.Contract(address, ERC20_ABI, hre.ethers.provider);
    book.push({ address, symbol: await token.symbol(), decimals: Number(await token.decimals()) });
  }
  const zapper = (pools.readRegistry()[String(chainId)] || {}).LPZapper;
  const assetAddress = process.env.LP_ASSET || (zapper && zapper.asset);
  return { book, assetAddress: assetAddress ? hre.ethers.getAddress(assetAddress) : undefined };
}

function findToken({ book, assetAddress }, key) {
  const k = key.trim();
  let entry;
  if (/^0x[0-9a-fA-F]{40}$/.test(k)) entry = book.find((t) => t.address.toLowerCase() === k.toLowerCase());
  else if (k.toUpperCase() === "ASSET" && assetAddress) {
    entry = book.find((t) => t.address.toLowerCase() === assetAddress.toLowerCase());
  }
  if (!entry) entry = book.find((t) => t.symbol.toLowerCase() === k.toLowerCase());
  if (!entry) {
    throw new Error(`${k} is not a reward token of the distributor (${book.map((t) => t.symbol).join(", ")})`);
  }
  return entry;
}

/** `SYMBOL=amount,...` -> parallel token / amount arrays in smallest units. */
function parseAmounts(raw, tokens) {
  const out = { tokens: [], amounts: [], rows: [] };
  for (const part of raw.split(",").map((p) => p.trim()).filter(Boolean)) {
    const [key, value] = part.split("=");
    if (value === undefined) throw new Error(`EPOCH_AMOUNTS entry "${part}" is not SYMBOL=amount`);
    const token = findToken(tokens, key);
    const amount = hre.ethers.parseUnits(value.trim(), token.decimals);
    out.tokens.push(token.address);
    out.amounts.push(amount);
    out.rows.push(`${token.symbol} ${value.trim()} (${amount} in smallest units, ${token.address})`);
  }
  return out;
}

/** The registry's own rules, against chain time, before anything is proposed. */
async function checkBounds(registry, startsAt, endsAt, prevLiveId, now) {
  const problems = [];
  if (startsAt % INTERVAL !== 0n) problems.push(`startsAt ${startsAt} is not on the 900-s grid`);
  if (endsAt % INTERVAL !== 0n) problems.push(`endsAt ${endsAt} is not on the 900-s grid`);
  if (endsAt <= startsAt) problems.push("endsAt must be after startsAt");
  if (startsAt < now + SCHEDULE_MARGIN) {
    problems.push(`startsAt ${iso(startsAt)} is less than 30 minutes after chain time ${iso(now)}`);
  }
  if (prevLiveId !== 0n) {
    const prev = await registry.epoch(prevLiveId);
    if (startsAt < prev.endsAt) problems.push(`starts before epoch ${prevLiveId} ends (${iso(prev.endsAt)})`);
  }
  if (problems.length > 0) throw new Error(`Refused before sending:\n  - ${problems.join("\n  - ")}`);
}

async function show(registry, tokens, now) {
  const count = await registry.epochCount();
  console.log(`epochCount ${count}, lastLiveId ${await registry.lastLiveId()}, currentEpoch ${await registry.currentEpoch()}`);
  console.log(`chain time ${iso(now)}`);
  for (let id = 1n; id <= count; id++) {
    const e = await registry.epoch(id);
    const state = e.cancelled ? "CANCELLED" : now >= e.endsAt ? "ended" : now >= e.startsAt ? "RUNNING" : now + SCHEDULE_MARGIN > e.startsAt ? "frozen" : "editable";
    console.log(`\nepoch ${id}  ${iso(e.startsAt)} -> ${iso(e.endsAt)}  [${state}]  prevLiveId ${e.prevLiveId}`);
    for (const address of await registry.epochTokens(id)) {
      const t = tokens.book.find((x) => x.address.toLowerCase() === address.toLowerCase()) || { symbol: address, decimals: 18 };
      console.log(`  ${t.symbol.padEnd(8)} ${hre.ethers.formatUnits(await registry.epochAmount(id, address), t.decimals)}`);
    }
  }
}

async function main() {
  const chainId = await pools.chainId();
  const action = process.env.EPOCH_ACTION || "show";
  if (!ACTIONS.includes(action)) throw new Error(`EPOCH_ACTION must be one of ${ACTIONS.join(", ")}`);

  const registryAddress = process.env.LP_REGISTRY_ADDRESS || pools.registryAddress(chainId, "LPEpochRegistry");
  if (!registryAddress) throw new Error(`No LPEpochRegistry for chain ${chainId} — set LP_REGISTRY_ADDRESS`);
  const registry = new hre.ethers.Contract(registryAddress, REGISTRY_ABI, hre.ethers.provider);
  const distributor = new hre.ethers.Contract(await registry.distributor(), DISTRIBUTOR_ABI, hre.ethers.provider);
  const tokens = await tokenBook(distributor, chainId);
  const now = BigInt((await hre.ethers.provider.getBlock("latest")).timestamp);

  console.log(`Registry: ${registryAddress}`);
  if (action === "show") return show(registry, tokens, now);

  const count = await registry.epochCount();
  const lastLiveId = await registry.lastLiveId();
  let call;
  let summary;

  if (action === "schedule") {
    const id = process.env.EPOCH_ID ? BigInt(process.env.EPOCH_ID) : count + 1n;
    if (id !== count + 1n) throw new Error(`EPOCH_ID must be epochCount + 1 = ${count + 1n} — got ${id}`);
    const startsAt = parseTime("EPOCH_STARTS_AT", process.env.EPOCH_STARTS_AT);
    const endsAt = process.env.EPOCH_ENDS_AT
      ? parseTime("EPOCH_ENDS_AT", process.env.EPOCH_ENDS_AT)
      : startsAt + BigInt(process.env.EPOCH_DURATION || 0);
    let raw = process.env.EPOCH_AMOUNTS;
    if (!raw && id === 1n && (process.env.LP_EPOCH1_OVTR_AMOUNT || process.env.LP_EPOCH1_ASSET_AMOUNT)) {
      raw = [
        process.env.LP_EPOCH1_OVTR_AMOUNT && `OVTR=${process.env.LP_EPOCH1_OVTR_AMOUNT}`,
        process.env.LP_EPOCH1_ASSET_AMOUNT && `ASSET=${process.env.LP_EPOCH1_ASSET_AMOUNT}`,
      ]
        .filter(Boolean)
        .join(",");
    }
    const parsed = parseAmounts(raw || "", tokens);
    await checkBounds(registry, startsAt, endsAt, lastLiveId, now);
    call = ["scheduleEpoch", [id, startsAt, endsAt, parsed.tokens, parsed.amounts]];
    summary = `schedule epoch ${id}: ${iso(startsAt)} -> ${iso(endsAt)}\n  ${parsed.rows.join("\n  ") || "(no token amounts yet)"}`;
  } else if (action === "set-amount") {
    const id = BigInt(process.env.EPOCH_ID || 0);
    const e = await registry.epoch(id);
    if (id === 0n || id > count) throw new Error(`EPOCH_ID ${id} does not exist (epochCount ${count})`);
    if (e.cancelled) throw new Error(`epoch ${id} is cancelled`);
    if (e.startsAt < now + SCHEDULE_MARGIN) throw new Error(`epoch ${id} is frozen: it starts ${iso(e.startsAt)}`);
    const token = findToken(tokens, process.env.EPOCH_TOKEN || "");
    const rawAmount = (process.env.EPOCH_AMOUNT || "").trim();
    if (rawAmount === "") throw new Error("Set EPOCH_AMOUNT (whole tokens; 0 allowed)");
    const amount = hre.ethers.parseUnits(rawAmount, token.decimals);
    call = ["setEpochAmount", [id, token.address, amount]];
    summary = `set epoch ${id} ${token.symbol} = ${process.env.EPOCH_AMOUNT} (${amount})`;
  } else {
    const id = BigInt(process.env.EPOCH_ID || 0);
    if (id === 0n || id !== lastLiveId) throw new Error(`only the last live epoch (${lastLiveId}) can be ${action === "cancel" ? "cancelled" : "moved"}`);
    const e = await registry.epoch(id);
    if (e.startsAt < now + SCHEDULE_MARGIN) throw new Error(`epoch ${id} is frozen: it starts ${iso(e.startsAt)}`);
    if (action === "cancel") {
      call = ["cancelEpoch", [id]];
      summary = `cancel epoch ${id} (${iso(e.startsAt)} -> ${iso(e.endsAt)}); lastLiveId falls back to ${e.prevLiveId}`;
    } else {
      const startsAt = parseTime("EPOCH_STARTS_AT", process.env.EPOCH_STARTS_AT);
      const endsAt = process.env.EPOCH_ENDS_AT
        ? parseTime("EPOCH_ENDS_AT", process.env.EPOCH_ENDS_AT)
        : startsAt + BigInt(process.env.EPOCH_DURATION || 0);
      await checkBounds(registry, startsAt, endsAt, e.prevLiveId, now);
      call = ["updateEpochBounds", [id, startsAt, endsAt]];
      summary = `move epoch ${id} to ${iso(startsAt)} -> ${iso(endsAt)}`;
    }
  }

  const data = registry.interface.encodeFunctionData(call[0], call[1]);
  console.log(`\n${summary}\n  to:   ${registryAddress}\n  data: ${data}`);

  const signer = await pools.getSigner();
  const operator = await registry.operator();
  if (operator.toLowerCase() !== signer.address.toLowerCase()) {
    console.log(`\nThe signer ${signer.address} is not the operator ${operator}: nothing sent.`);
    console.log("Propose the transaction above from the operator Safe (value 0).");
    return;
  }
  pools.requireConfirmation(chainId, summary.split("\n")[0]);
  await pools.send(summary.split("\n")[0], signer, (o) => signer.sendTransaction({ to: registryAddress, data, ...o }));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
