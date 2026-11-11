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
// cancel only on the last live epoch. Every refusal names the contract error the transaction
// would revert with (NotOnGrid, InvalidBounds, StartTooSoon, OverlapsPreviousEpoch, and
// DuplicateToken / UnknownRewardToken for a token listed twice or registered but not enabled). A start
// LATER than the previous live epoch's end is accepted, but prints a GAP warning: no rewards
// accrue to users in a gap, and that time can never be paid later.
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
//                     For `schedule` of epoch 1 without EPOCH_AMOUNTS the fallbacks
//                     LP_EPOCH1_OVTR_AMOUNT and LP_EPOCH1_ASSET_AMOUNT are used. They carry the
//                     decided first-mainnet-epoch figures, 7,500 $OVTR and 3,000 $ASSET, in
//                     whole tokens; the script converts them with each token's decimals.
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

/**
 * `SYMBOL=amount,...` -> parallel token / amount arrays in smallest units, plus the resolved
 * token-book `entries`. A token named twice (by symbol, address or the ASSET alias) is refused.
 */
function parseAmounts(raw, tokens) {
  const out = { tokens: [], amounts: [], rows: [], entries: [] };
  for (const part of raw.split(",").map((p) => p.trim()).filter(Boolean)) {
    const [key, value] = part.split("=");
    if (value === undefined) throw new Error(`EPOCH_AMOUNTS entry "${part}" is not SYMBOL=amount`);
    const token = findToken(tokens, key);
    if (out.tokens.some((a) => a.toLowerCase() === token.address.toLowerCase())) {
      throw new Error(`EPOCH_AMOUNTS names ${token.symbol} (${token.address}) more than once. The contract would revert with DuplicateToken.`);
    }
    const amount = hre.ethers.parseUnits(value.trim(), token.decimals);
    out.tokens.push(token.address);
    out.amounts.push(amount);
    out.rows.push(`${token.symbol} ${value.trim()} (${amount} in smallest units, ${token.address})`);
    out.entries.push(token);
  }
  return out;
}

/**
 * The registry accepts only tokens the distributor's `isRewardToken` approves (registered AND
 * enabled); the token book lists every registered one. Refuses all disabled entries in one error.
 */
async function requireEnabledRewardTokens(distributor, entries) {
  const problems = [];
  for (const entry of entries) {
    if (!(await distributor.isRewardToken(entry.address))) {
      problems.push(
        `${entry.symbol} (${entry.address}) is registered on the distributor but not enabled as a reward token. ` +
          "The contract would revert with UnknownRewardToken.",
      );
    }
  }
  if (problems.length > 0) throw new Error(`Refused before sending:\n  - ${problems.join("\n  - ")}`);
}

/** Seconds as `1 day 3 hours 15 minutes`; zero parts are omitted. */
function formatDuration(seconds) {
  const units = [
    ["day", 86400n],
    ["hour", 3600n],
    ["minute", 60n],
    ["second", 1n],
  ];
  const parts = [];
  let rest = seconds;
  for (const [name, size] of units) {
    const n = rest / size;
    rest %= size;
    if (n > 0n) parts.push(`${n} ${name}${n === 1n ? "" : "s"}`);
  }
  return parts.length > 0 ? parts.join(" ") : "0 seconds";
}

/** The first grid point the contract accepts as a start at chain time `now`. */
function earliestStart(now) {
  const min = now + SCHEDULE_MARGIN;
  return ((min + INTERVAL - 1n) / INTERVAL) * INTERVAL;
}

/**
 * The registry's bounds rules (`LPEpochRegistry._checkBounds`), PURE: no chain call, no env.
 * All times are BigInt unix seconds; `now` is the chain time; `prev` is `null` or the previous
 * live epoch `{ id, endsAt }`. Every problem names the custom error the contract would revert
 * with. A start later than `prev.endsAt` is accepted by the contract and returned as a GAP
 * warning: no rewards accrue to users in a gap and it can never be paid later.
 */
function checkEpochBounds({ startsAt, endsAt, now, prev }) {
  const problems = [];
  const warnings = [];
  const earliest = earliestStart(now);
  if (startsAt % INTERVAL !== 0n) {
    problems.push(`the start ${iso(startsAt)} is not on the 15-minute grid (900 s). The contract would revert with NotOnGrid.`);
  }
  if (endsAt % INTERVAL !== 0n) {
    problems.push(`the end ${iso(endsAt)} is not on the 15-minute grid (900 s). The contract would revert with NotOnGrid.`);
  }
  if (endsAt <= startsAt) {
    problems.push(`the end ${iso(endsAt)} is not after the start ${iso(startsAt)}. The contract would revert with InvalidBounds.`);
  }
  if (startsAt < now + SCHEDULE_MARGIN) {
    problems.push(
      `the start ${iso(startsAt)} is less than 30 minutes after chain time ${iso(now)}. ` +
        `The earliest start the contract accepts now is ${iso(earliest)}. The contract would revert with StartTooSoon.`,
    );
  }
  if (prev) {
    if (startsAt < prev.endsAt) {
      problems.push(
        `the start ${iso(startsAt)} is earlier than the end of epoch ${prev.id} (${iso(prev.endsAt)}). ` +
          "The contract would revert with OverlapsPreviousEpoch.",
      );
    } else if (startsAt > prev.endsAt) {
      const gap = startsAt - prev.endsAt;
      const intervals = (gap + INTERVAL - 1n) / INTERVAL;
      const advice =
        prev.endsAt >= now + SCHEDULE_MARGIN
          ? `  To schedule with no gap, set EPOCH_STARTS_AT=${iso(prev.endsAt)}.`
          : `  The end of epoch ${prev.id} is less than 30 minutes ahead or already past, so a gap can no longer be avoided. ` +
            `The earliest start the contract accepts now is ${iso(earliest)}.`;
      warnings.push(
        `WARNING: GAP of ${formatDuration(gap)} (${intervals} interval${intervals === 1n ? "" : "s"} of 15 minutes) ` +
          `between the end of epoch ${prev.id} (${iso(prev.endsAt)}) and this start (${iso(startsAt)}).\n` +
          "  No rewards accrue to users in the gap, and they can never be paid later.\n" +
          advice,
      );
    }
  }
  return { problems, warnings };
}

/** The registry's own rules, against chain time, before anything is proposed. Returns the warnings. */
async function checkBounds(registry, startsAt, endsAt, prevLiveId, now) {
  let prev = null;
  if (prevLiveId !== 0n) prev = { id: prevLiveId, endsAt: (await registry.epoch(prevLiveId)).endsAt };
  const { problems, warnings } = checkEpochBounds({ startsAt, endsAt, now, prev });
  if (problems.length > 0) throw new Error(`Refused before sending:\n  - ${problems.join("\n  - ")}`);
  return warnings;
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
  let warnings = [];

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
    await requireEnabledRewardTokens(distributor, parsed.entries);
    warnings = await checkBounds(registry, startsAt, endsAt, lastLiveId, now);
    call = ["scheduleEpoch", [id, startsAt, endsAt, parsed.tokens, parsed.amounts]];
    summary = `schedule epoch ${id}: ${iso(startsAt)} -> ${iso(endsAt)}\n  ${parsed.rows.join("\n  ") || "(no token amounts yet)"}`;
  } else if (action === "set-amount") {
    const id = BigInt(process.env.EPOCH_ID || 0);
    const e = await registry.epoch(id);
    if (id === 0n || id > count) throw new Error(`EPOCH_ID ${id} does not exist (epochCount ${count})`);
    if (e.cancelled) throw new Error(`epoch ${id} is cancelled`);
    if (e.startsAt < now + SCHEDULE_MARGIN) throw new Error(`epoch ${id} is frozen: it starts ${iso(e.startsAt)}`);
    const token = findToken(tokens, process.env.EPOCH_TOKEN || "");
    await requireEnabledRewardTokens(distributor, [token]);
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
      warnings = await checkBounds(registry, startsAt, endsAt, e.prevLiveId, now);
      call = ["updateEpochBounds", [id, startsAt, endsAt]];
      summary = `move epoch ${id} to ${iso(startsAt)} -> ${iso(endsAt)}`;
    }
  }

  const data = registry.interface.encodeFunctionData(call[0], call[1]);
  console.log(`\n${summary}\n  to:   ${registryAddress}\n  data: ${data}`);
  for (const warning of warnings) console.log(`\n${warning}`);

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

module.exports = { checkEpochBounds, formatDuration, earliestStart, parseAmounts, requireEnabledRewardTokens };

// `hardhat run` executes this file as the entry point; a `require` from the unit test must only
// pick up the pure check above.
if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
