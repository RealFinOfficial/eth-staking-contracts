const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const pools = require("./pools");
const { prepareSchedule, tokenBook, iso, REGISTRY_ABI, DISTRIBUTOR_ABI } = require("../lp-epoch");

// Shared logic of `scripts/lp-epoch-batch.js` and `scripts/lp-epoch-batch-with-asset.js`: build
// ONE Safe batch that arms an epoch, print it, and write it as a Safe Transaction Builder file.
// The two scripts differ only in `withAsset` (whether the $ASSET transfer leg is included).
// Nothing here ever sends a transaction. See the header of either script for the env keys.

const DISTRIBUTOR_BATCH_ABI = [
  "function operator() view returns (address)",
  "function mintRewardToken(address token, address to, uint256 amount)",
];
const TOKEN_ABI = [
  "function minter() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

const same = (a, b) => a.toLowerCase() === b.toLowerCase();

/** Smallest units -> whole tokens, without a trailing `.0`. */
function whole(amount, decimals) {
  const s = hre.ethers.formatUnits(amount, decimals);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

/**
 * The batch's calls from a `prepareSchedule` result, PURE: no chain call, no env.
 * Order: `mintRewardToken`, then (with `withAsset`) the $ASSET `transfer`, then `scheduleEpoch`.
 * The mint amount IS the epoch's $OVTR amount and the transfer amount IS its $ASSET amount.
 * Refuses a token other than $OVTR and $ASSET, a missing or zero $OVTR amount, and (with
 * `withAsset`) a missing or zero $ASSET amount.
 */
function buildCalls({ withAsset, schedule, ovtrAddress, assetAddress, distributorAddress, registryAddress }) {
  const { id, startsAt, endsAt, parsed } = schedule;
  const distributor = hre.ethers.getAddress(distributorAddress);
  let ovtr = null;
  let asset = null;
  parsed.entries.forEach((entry, i) => {
    const amount = parsed.amounts[i];
    if (same(entry.address, ovtrAddress)) ovtr = { entry, amount };
    else if (assetAddress && same(entry.address, assetAddress)) asset = { entry, amount };
    else {
      throw new Error(
        `Refused: EPOCH_AMOUNTS names ${entry.symbol} (${entry.address}). These batch scripts fund only $OVTR and $ASSET. ` +
          "Schedule this epoch with scripts/lp-epoch.js and fund that token separately.",
      );
    }
  });
  if (!ovtr || ovtr.amount === 0n) {
    throw new Error(
      `Refused: epoch ${id} emits no $OVTR (${hre.ethers.getAddress(ovtrAddress)}): EPOCH_AMOUNTS has no $OVTR amount, or it is 0, ` +
        "so there is nothing to mint. Schedule this epoch with scripts/lp-epoch.js instead.",
    );
  }
  if (withAsset && (!asset || asset.amount === 0n)) {
    throw new Error(
      `Refused: epoch ${id} emits no $ASSET (${assetAddress ? hre.ethers.getAddress(assetAddress) : "LP_ASSET unset"}): ` +
        "EPOCH_AMOUNTS has no $ASSET amount, or it is 0, so there is nothing to transfer. Use scripts/lp-epoch-batch.js instead.",
    );
  }

  const calls = [
    {
      name: "mintRewardToken",
      label: "RewardsDistributor.mintRewardToken",
      description: `RewardsDistributor.mintRewardToken: mint ${whole(ovtr.amount, ovtr.entry.decimals)} ${ovtr.entry.symbol} into the distributor ${distributor}`,
      to: distributor,
      value: "0",
      data: new hre.ethers.Interface(DISTRIBUTOR_BATCH_ABI).encodeFunctionData("mintRewardToken", [
        ovtr.entry.address,
        distributor,
        ovtr.amount,
      ]),
    },
  ];
  if (withAsset) {
    calls.push({
      name: "transfer",
      label: `${asset.entry.symbol}.transfer`,
      description: `${asset.entry.symbol}.transfer: move ${whole(asset.amount, asset.entry.decimals)} ${asset.entry.symbol} from the operator to the distributor ${distributor}`,
      to: hre.ethers.getAddress(asset.entry.address),
      value: "0",
      data: new hre.ethers.Interface(TOKEN_ABI).encodeFunctionData("transfer", [distributor, asset.amount]),
    });
  }
  const amounts = parsed.entries.map((e, i) => `${whole(parsed.amounts[i], e.decimals)} ${e.symbol}`).join(", ");
  calls.push({
    name: "scheduleEpoch",
    label: "LPEpochRegistry.scheduleEpoch",
    description: `LPEpochRegistry.scheduleEpoch: epoch ${id}, ${iso(startsAt)} -> ${iso(endsAt)}, ${amounts}`,
    to: hre.ethers.getAddress(registryAddress),
    value: "0",
    data: new hre.ethers.Interface(REGISTRY_ABI).encodeFunctionData("scheduleEpoch", schedule.call[1]),
  });
  return { calls, ovtrAmount: ovtr.amount, assetAmount: asset ? asset.amount : 0n, asset: asset ? asset.entry : null };
}

/** `mintRewardToken` reverts inside the token unless the distributor proxy is its minter. */
function requireDistributorIsMinter(minter, distributorAddress) {
  if (same(minter, distributorAddress)) return;
  const d = hre.ethers.getAddress(distributorAddress);
  throw new Error(
    `Refused: TokenOverture.minter() is ${hre.ethers.getAddress(minter)}, not the RewardsDistributor proxy ${d}, ` +
      `so mintRewardToken would revert with NotMinter(${d}). Finish the activation first: TokenOverture.setMinter(${d}) through the timelock.`,
  );
}

/**
 * The NOTE (no-$ASSET variant, the epoch emits $ASSET) or the WARNING (with-asset variant, the
 * operator holds less $ASSET than the transfer). PURE. Returns the lines to print.
 */
function fundingNotes({ withAsset, id, assetAmount, asset, operator, operatorBalance, distributorAddress }) {
  if (assetAmount === 0n) return [];
  const fmt = (n) => `${whole(n, asset.decimals)} ${asset.symbol}`;
  if (!withAsset) {
    return [
      `NOTE: this batch does not fund $ASSET. Epoch ${id} emits ${fmt(assetAmount)}. ` +
        `The distributor ${distributorAddress} must hold it before $ASSET claims are opened.`,
    ];
  }
  if (operatorBalance >= assetAmount) return [];
  return [
    `WARNING: the operator ${operator} holds ${fmt(operatorBalance)}, the transfer needs ${fmt(assetAmount)}, ` +
      `short by ${fmt(assetAmount - operatorBalance)}.\n` +
      "  The Safe must hold the full amount before it executes the batch. The batch is atomic, so none of its calls executes while the Safe is short.",
  ];
}

// ──────────────────────── Safe Transaction Builder file ────────────────────────
//
// The format and the checksum follow the Safe Transaction Builder app, safe-global/safe-react-apps
// on GitHub: apps/tx-builder/src/typings/models.ts (`BatchFile`, `BatchTransaction`),
// apps/tx-builder/src/lib/checksum.ts (`serializeJSONObject`, `calculateChecksum`,
// `validateChecksum`) and apps/tx-builder/src/store/transactionLibraryContext.tsx (the import:
// it deletes `meta.checksum`, recomputes and warns on a mismatch; a transaction with `data` is
// taken raw). The checksum is keccak256 of a key-sorted serialisation with `meta.name` set to
// null, so renaming the batch in the app keeps it valid.

const stringifyReplacer = (_, value) => (value === undefined ? null : value);

function serializeJSONObject(json) {
  if (Array.isArray(json)) return `[${json.map((el) => serializeJSONObject(el)).join(",")}]`;
  if (typeof json === "object" && json !== null) {
    const keys = Object.keys(json).sort();
    let acc = `{${JSON.stringify(keys, stringifyReplacer)}`;
    for (const key of keys) acc += `${serializeJSONObject(json[key])},`;
    return `${acc}}`;
  }
  return `${JSON.stringify(json, stringifyReplacer)}`;
}

/** The app's `calculateChecksum`: over the file as given, with `meta.name` nulled. */
function batchChecksum(file) {
  return hre.ethers.id(serializeJSONObject({ ...file, meta: { ...file.meta, name: null } }));
}

/** The app's `validateChecksum`: drop `meta.checksum`, recompute, compare. */
function validateBatchChecksum(file) {
  const { checksum, ...meta } = file.meta;
  return batchChecksum({ ...file, meta }) === checksum;
}

/** A Safe Transaction Builder `BatchFile`: one raw `{ to, value, data }` per call, in order. */
function safeBatchFile({ chainId, operator, name, description, calls, createdAt = Date.now() }) {
  const file = {
    version: "1.0",
    chainId: String(chainId),
    createdAt,
    meta: { name, description, createdFromSafeAddress: operator, createdFromOwnerAddress: "" },
    transactions: calls.map((c) => ({ to: c.to, value: c.value, data: c.data })),
  };
  file.meta.checksum = batchChecksum(file);
  return file;
}

/** `LP_EPOCH_BATCH_FILE`, else `lp-epoch-<id>-batch[-with-asset].json` beside the deployments registry. */
function batchFilePath(id, withAsset) {
  if (process.env.LP_EPOCH_BATCH_FILE) return path.resolve(process.env.LP_EPOCH_BATCH_FILE);
  const registryPath = process.env.DEPLOYMENTS_FILE
    ? path.resolve(process.env.DEPLOYMENTS_FILE)
    : path.join(__dirname, "..", "..", "deployments.json");
  return path.join(path.dirname(registryPath), `lp-epoch-${id}-batch${withAsset ? "-with-asset" : ""}.json`);
}

// ──────────────────────── simulation ────────────────────────

let errorsIface;
/** Every custom error of the three contracts the batch calls, for decoding a revert. */
function errorsInterface() {
  if (errorsIface) return errorsIface;
  const seen = new Set();
  const fragments = [];
  for (const name of ["RewardsDistributor", "LPEpochRegistry", "TokenOverture"]) {
    for (const f of hre.artifacts.readArtifactSync(name).abi) {
      if (f.type !== "error") continue;
      const sig = `${f.name}(${f.inputs.map((i) => i.type).join(",")})`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      fragments.push(f);
    }
  }
  errorsIface = new hre.ethers.Interface(fragments);
  return errorsIface;
}

function revertData(error) {
  for (const candidate of [error.data, error.error && error.error.data, error.info && error.info.error && error.info.error.data]) {
    if (typeof candidate === "string" && /^0x[0-9a-fA-F]{8}/.test(candidate)) return candidate;
    if (candidate && typeof candidate.data === "string") return candidate.data;
  }
  return undefined;
}

/** A revert as `ErrorName(arg, ...)` when the ABI knows it, else the provider's message. */
function decodeRevert(error) {
  const data = revertData(error);
  if (data) {
    try {
      const parsed = errorsInterface().parseError(data);
      if (parsed) return `${parsed.name}(${parsed.args.map(String).join(", ")})`;
    } catch (_) {
      // not a known custom error: fall through
    }
  }
  if (error.reason) return error.reason;
  return error.shortMessage || error.message;
}

/** `provider.call` from the operator; a revert is a refusal with the decoded reason. */
async function simulate(operator, call) {
  try {
    await hre.ethers.provider.call({ from: operator, to: call.to, data: call.data });
  } catch (error) {
    throw new Error(`Refused: ${call.label} would revert when the operator ${operator} sends it: ${decodeRevert(error)}`);
  }
}

// ──────────────────────── the script flow ────────────────────────

/** The $OVTR token: LP_OVERTURE_ADDRESS, else TokenOverture in deployments.json (as lp-fund-rewards.js). */
function overtureAddress(chainId) {
  if (process.env.LP_OVERTURE_ADDRESS) return hre.ethers.getAddress(process.env.LP_OVERTURE_ADDRESS);
  const address = pools.registryAddress(chainId, "TokenOverture");
  if (!address) throw new Error(`No TokenOverture for chain ${chainId} — set LP_OVERTURE_ADDRESS`);
  return hre.ethers.getAddress(address);
}

/**
 * Reads the chain, refuses what would revert, prints the batch and writes the batch file.
 * Sends nothing. Returns `{ calls, file, filePath }`.
 */
async function run({ withAsset, log = console.log }) {
  const provider = hre.ethers.provider;
  const chainId = await pools.chainId();
  const registryAddress = process.env.LP_REGISTRY_ADDRESS || pools.registryAddress(chainId, "LPEpochRegistry");
  if (!registryAddress) throw new Error(`No LPEpochRegistry for chain ${chainId} — set LP_REGISTRY_ADDRESS`);
  const registry = new hre.ethers.Contract(registryAddress, REGISTRY_ABI, provider);
  const distributorAddress = hre.ethers.getAddress(await registry.distributor());
  const distributor = new hre.ethers.Contract(distributorAddress, DISTRIBUTOR_ABI, provider);
  const operator = hre.ethers.getAddress(await registry.operator());
  const ovtrAddress = overtureAddress(chainId);

  let signer;
  try {
    signer = (await pools.getSigner()).address;
  } catch (_) {
    signer = "(none configured; not needed, this script sends nothing)";
  }
  log(`Network:     ${hre.network.name} (chain id ${chainId})`);
  log(`Registry:    ${hre.ethers.getAddress(registryAddress)}`);
  log(`Distributor: ${distributorAddress}`);
  log(`Operator:    ${operator}`);
  log(`Signer:      ${signer}`);
  log("This script reads the chain and writes a batch file. It never sends a transaction.");

  const tokens = await tokenBook(distributor, chainId);
  const now = BigInt((await provider.getBlock("latest")).timestamp);
  const count = await registry.epochCount();
  const lastLiveId = await registry.lastLiveId();
  const schedule = await prepareSchedule({ registry, distributor, tokens, count, lastLiveId, now });

  const built = buildCalls({
    withAsset,
    schedule,
    ovtrAddress,
    assetAddress: tokens.assetAddress,
    distributorAddress,
    registryAddress,
  });
  const overture = new hre.ethers.Contract(ovtrAddress, TOKEN_ABI, provider);
  requireDistributorIsMinter(await overture.minter(), distributorAddress);
  // The $ASSET transfer is not simulated: the operator's balance is checked instead (WARNING).
  for (const call of built.calls) if (call.name !== "transfer") await simulate(operator, call);

  let operatorBalance;
  if (withAsset) {
    operatorBalance = await new hre.ethers.Contract(built.asset.address, TOKEN_ABI, provider).balanceOf(operator);
  }
  const notes = fundingNotes({
    withAsset,
    id: schedule.id,
    assetAmount: built.assetAmount,
    asset: built.asset,
    operator,
    operatorBalance,
    distributorAddress,
  });

  log(`\n${schedule.summary}`);
  for (const warning of schedule.warnings) log(`\n${warning}`);
  log(`\nBatch for the operator ${operator}: ${built.calls.length} calls, in this order:`);
  built.calls.forEach((c, i) => {
    log(`  ${i + 1}. ${c.description}\n     to:    ${c.to}\n     value: 0\n     data:  ${c.data}`);
  });
  for (const note of notes) log(`\n${note}`);

  const filePath = batchFilePath(schedule.id, withAsset);
  const file = safeBatchFile({
    chainId,
    operator,
    name: `LP epoch ${schedule.id}: ${withAsset ? "mint $OVTR, transfer $ASSET, schedule" : "mint $OVTR, schedule"}`,
    description: built.calls.map((c, i) => `${i + 1}. ${c.description}`).join("\n"),
    calls: built.calls,
  });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(file, null, 2) + "\n");
  log(`\nBatch file: ${filePath}`);
  log(
    `Nothing was sent. Import the batch file into the Safe's Transaction Builder of the operator ${operator} ` +
      `(or paste the ${built.calls.length} calls above in this order) and propose it as one batch.`,
  );
  return { calls: built.calls, file, filePath };
}

/** The entry point of both scripts. */
function main(withAsset) {
  run({ withAsset }).catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  buildCalls,
  requireDistributorIsMinter,
  fundingNotes,
  batchChecksum,
  validateBatchChecksum,
  safeBatchFile,
  batchFilePath,
  decodeRevert,
  simulate,
  run,
  main,
};
