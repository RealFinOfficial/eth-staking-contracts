const hre = require("hardhat");
const pools = require("./pools");
const { deployContract, deployProxyPair } = require("./proxies");

// The ApeBond route's deployment pieces, shared by the two scripts that deploy it:
//
//   - `scripts/deploy-lp-staking.js` with `LP_APEBOND_ENABLED=1` — a FRESH stack, whose vault
//     already carries the stake-operator allowlist and the escrow hooks;
//   - `scripts/deploy-apebond.js` — a stack that is ALREADY live (a lane-1 vault, as mainnet
//     deploys it on 7 Oct, has the hooks but not the allowlist, so it is upgraded first).
//
// Both produce the same shape (B.3 decision document, 2026-10-01, with the overrides of
// 2026-10-05):
//
//   1. `BonusEscrow` implementation(bonusToken, vault) + `LPProxy`, `initialize(owner = timelock,
//      adapter = address(0))` — born owned by the timelock, reserve path CLOSED;
//   2. `ApeBondPositionAdapter(positionManager, vault, escrow, owner = DEPLOYER, guardian,
//      minCliffSeconds = LP_APEBOND_MIN_CLIFF_SECONDS)` — the immutable floor under every campaign
//      cliff (audit C-14; default one day, never below one day on mainnet);
//   3. wiring while the deployer still owns the adapter: `setSoulZapCaller` per caller,
//      `setCampaign`, `setCampaignCaller` per caller — then `transferOwnership(timelock)`.
//      The adapter is `Ownable2Step` (audit L-03), so that call only NOMINATES the timelock:
//      the adapter is then in a THIRD state, `owner() == deployer` and `pendingOwner() ==
//      timelock`, until the batch below executes `acceptOwnership()`;
//   4. ONE timelock batch, which is the whole activation and is atomic:
//         adapter.acceptOwnership()                      (exactly while the third state holds)
//        [vault.upgradeToAndCall(newImpl, 0x)]          (live lane-1 vault only)
//         vault.setBonusEscrow(escrow)
//         vault.setStakeOperator(adapter, true)
//         escrow.setAdapter(adapter)
//      Until it executes, no purchase can be made (the vault refuses the adapter's `stakeFor`
//      and the escrow refuses its `reserve`), and once it executes the vault reports every exit
//      and re-range to the escrow from the same block.
//   5. the post-checks, of which two are MANDATORY because a wrong link fails OPEN silently —
//      a vault pointed at the wrong escrow lets every exit keep its bonus:
//        vault.bonusEscrow() == escrow   and   escrow.vault() == vault.
//
// There is no purchase signer and no signing key anywhere in this flow (B.3 P1).

const ESCROW_KIND = "BonusEscrow";
const ADAPTER_KIND = "ApeBondPositionAdapter";

const MIN_TICK = -887272;
const MAX_TICK = 887272;
const MAX_BPS = 10_000;

/**
 * The campaign band's defaults (Vladimir's decision of 14 Oct 2026): every new position spans
 * -50 % and +100 % around the $ASSET price at the moment of the purchase, each NFT edge within
 * 500 ticks of the expected edge.
 */
const DEFAULT_DOWN_PCT = "50";
const DEFAULT_UP_PCT = "100";
const DEFAULT_TOLERANCE_TICKS = 500n;
const LN_TICK_BASE = Math.log(1.0001);
const MAX_INT24 = (1n << 23n) - 1n;
const MAX_UINT64 = (1n << 64n) - 1n;

/** The adapter's cliff floor when LP_APEBOND_MIN_CLIFF_SECONDS is unset: one day. */
const DEFAULT_MIN_CLIFF_SECONDS = 86_400n;
/** The lowest cliff floor a mainnet adapter may be deployed with (audit C-14): one day. */
const MAINNET_MIN_CLIFF_SECONDS = 86_400n;

/** The view surface the route's checks read. Nothing else is called on these contracts. */
const VAULT_LINK_ABI = [
  "function bonusEscrow() view returns (address)",
  "function isStakeOperator(address account) view returns (bool)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function pool() view returns (address)",
  "function positionManager() view returns (address)",
];
const ESCROW_ABI = [
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function adapter() view returns (address)",
  "function vault() view returns (address)",
  "function bonusToken() view returns (address)",
  "function bonusIsToken0() view returns (bool)",
  "function totalReserved() view returns (uint256)",
];
const ADAPTER_ABI = [
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function vault() view returns (address)",
  "function escrow() view returns (address)",
  "function positionManager() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function bonusIsToken0() view returns (bool)",
  "function guardian() view returns (address)",
  "function depositsPaused() view returns (bool)",
  "function soulZapCallers(address caller) view returns (bool)",
  "function campaignCallers(bytes32 campaignId, address caller) view returns (bool)",
  "function campaigns(bytes32 campaignId) view returns (bool enabled, int24 downTicks, int24 upTicks, int24 toleranceTicks, uint64 bonusCliffSeconds, uint16 bonusBps, uint256 minBonusAmount)",
  "function campaignRange(bytes32 campaignId) view returns (int24 tickLower, int24 tickUpper, int24 currentTick)",
  "function minCliffSeconds() view returns (uint64)",
];
const POOL_ABI = [
  "function tickSpacing() view returns (int24)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
];
const ERC20_DECIMALS_ABI = ["function decimals() view returns (uint8)", "function symbol() view returns (string)"];

/** Compares two on-chain values the way Solidity would: addresses case-insensitively. */
function sameValue(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

/**
 * The adapter's ownership, read from the chain, as one of three states (audit L-03, the adapter
 * is `Ownable2Step`):
 *
 *   "timelock"  owner() == timelock: handed over and accepted, configuration is owner-tier;
 *   "pending"   owner() == deployer and pendingOwner() == timelock: nominated, NOT accepted —
 *               the activation (or replacement) batch must open with `acceptOwnership()`;
 *   "deployer"  owner() == deployer and nothing pending to the timelock: not handed over;
 *   "other"     anyone else owns it.
 *
 * An adapter without `pendingOwner()` (a plain-Ownable adapter deployed before audit L-03) reads
 * as nothing pending.
 */
async function adapterOwnership(adapterAddress, { deployer, timelock }) {
  const adapter = new hre.ethers.Contract(adapterAddress, ADAPTER_ABI, hre.ethers.provider);
  const owner = hre.ethers.getAddress(await adapter.owner());
  let pendingOwner = hre.ethers.ZeroAddress;
  try {
    pendingOwner = hre.ethers.getAddress(await adapter.pendingOwner());
  } catch {
    // plain Ownable: no nomination can exist
  }
  // Without a `deployer` to compare against (a read-only caller), any owner with the timelock
  // nominated counts as the third state.
  const ownerIsDeployer = deployer ? sameValue(owner, deployer) : true;
  let state = "other";
  if (sameValue(owner, timelock)) state = "timelock";
  else if (ownerIsDeployer && sameValue(pendingOwner, timelock)) state = "pending";
  else if (deployer && ownerIsDeployer) state = "deployer";
  return { state, owner, pendingOwner };
}

/**
 * The `acceptOwnership()` call that must OPEN the activation or replacement batch, or null. It is
 * added exactly while the adapter is nominated to the timelock and has not accepted: without it
 * the batch would execute and leave the deploying key as the owner of a live adapter, and with it
 * while `pendingOwner() != timelock` the whole batch would revert.
 */
async function acceptOwnershipOp(adapterAddress, timelockAddress) {
  const { owner, pendingOwner } = await adapterOwnership(adapterAddress, { timelock: timelockAddress });
  if (sameValue(owner, timelockAddress) || !sameValue(pendingOwner, timelockAddress)) return null;
  return { target: adapterAddress, kind: ADAPTER_KIND, fn: "acceptOwnership", args: [] };
}

// ──────────────────────── environment ────────────────────────

/**
 * The ApeBond section's master switch, read strictly. Only "1" turns it on and only "0" or an
 * absent value turn it off; anything else throws — a typo must not silently skip the escrow on
 * the run that was supposed to carry it.
 */
function readApeBondFlag() {
  const raw = process.env.LP_APEBOND_ENABLED;
  if (raw === undefined || raw.trim() === "" || raw === "0") return false;
  if (raw === "1") return true;
  throw new Error(`LP_APEBOND_ENABLED must be 1, 0 or unset — got ${raw}`);
}

/** Reads an address env var, applies a default and normalises the checksum. */
function readAddress(name, fallback) {
  const raw = process.env[name] || fallback;
  if (!raw) throw new Error(`Set ${name}`);
  try {
    return hre.ethers.getAddress(raw);
  } catch {
    throw new Error(`${name} is not a valid address: ${raw}`);
  }
}

/**
 * Reads a comma-separated address list. Unset and empty both mean the EMPTY list; every entry
 * is checksummed, an empty entry and a repeat are refused.
 */
function readAddressList(name) {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return [];
  const seen = new Set();
  return raw.split(",").map((entry, index) => {
    const value = entry.trim();
    if (!value) throw new Error(`${name} has an empty entry at position ${index}`);
    let address;
    try {
      address = hre.ethers.getAddress(value);
    } catch {
      throw new Error(`${name} entry ${index} is not a valid address: ${value}`);
    }
    if (seen.has(address)) throw new Error(`${name} lists ${address} twice`);
    seen.add(address);
    return address;
  });
}

function readInteger(name, { min, max, required = true, fallback } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    if (fallback !== undefined) return fallback;
    if (required) throw new Error(`Set ${name}`);
    return undefined;
  }
  if (!/^-?[0-9]+$/.test(raw.trim())) throw new Error(`${name} must be an integer — got ${raw}`);
  const value = BigInt(raw.trim());
  if (min !== undefined && value < BigInt(min)) throw new Error(`${name} must be >= ${min} — got ${raw}`);
  if (max !== undefined && value > BigInt(max)) throw new Error(`${name} must be <= ${max} — got ${raw}`);
  return value;
}

/**
 * LP_APEBOND_MIN_CLIFF_SECONDS: the adapter's immutable floor under every campaign cliff, in
 * seconds (audit C-14, 7 Oct 2026). Default one day. Never zero — a zero cliff records a bonus
 * no exit can forfeit — and never below one day on mainnet. Read before anything is deployed.
 */
function readMinCliff(chainId) {
  const value = readInteger("LP_APEBOND_MIN_CLIFF_SECONDS", {
    min: 1,
    max: MAX_UINT64,
    fallback: DEFAULT_MIN_CLIFF_SECONDS,
  });
  if (pools.isMainnet(chainId) && value < MAINNET_MIN_CLIFF_SECONDS) {
    throw new Error(
      `LP_APEBOND_MIN_CLIFF_SECONDS is ${value} — on mainnet the adapter's cliff floor must be at least ` +
        `${MAINNET_MIN_CLIFF_SECONDS} s (one day)`
    );
  }
  return value;
}

/**
 * A percentage env var: a positive decimal number ("50", "33.3"), `fallback` when unset. Returned
 * as a Number; `below` (exclusive) is the ceiling where one applies.
 */
function readPercent(name, fallback, { below } = {}) {
  const raw = process.env[name];
  const text = raw === undefined || raw.trim() === "" ? fallback : raw.trim();
  if (!/^[0-9]+(\.[0-9]+)?$/.test(text)) throw new Error(`${name} must be a positive number of percent — got ${raw}`);
  const value = Number(text);
  if (!(value > 0)) throw new Error(`${name} must be above 0 — got ${raw}`);
  if (below !== undefined && !(value < below)) throw new Error(`${name} must be below ${below} — got ${raw}`);
  return value;
}

/**
 * A fall of the $ASSET price by `pct` percent, in ticks: round(ln(1 / (1 - pct/100)) / ln(1.0001)).
 * 50 % is 6932 ticks (the price halves).
 */
function downPctToTicks(pct) {
  return Math.round(Math.log(1 / (1 - pct / 100)) / LN_TICK_BASE);
}

/**
 * A rise of the $ASSET price by `pct` percent, in ticks: round(ln(1 + pct/100) / ln(1.0001)).
 * 100 % is 6932 ticks too (the price doubles; ln 2 / ln 1.0001 = 6931.8).
 */
function upPctToTicks(pct) {
  return Math.round(Math.log(1 + pct / 100) / LN_TICK_BASE);
}

/** The price move `ticks` stand for, as a percentage with two decimals: down, then up. */
function downTicksToPct(ticks) {
  return ((1 - Math.pow(1.0001, -Number(ticks))) * 100).toFixed(2);
}
function upTicksToPct(ticks) {
  return ((Math.pow(1.0001, Number(ticks)) - 1) * 100).toFixed(2);
}

/**
 * The adapter's `setCampaign` offset rules, applied before anything is sent, each refused with
 * its own reason: both offsets above zero, a tolerance of at least one tick spacing, and a band
 * narrower than Uniswap's whole tick range.
 */
function checkOffsets({ downTicks, upTicks, toleranceTicks }, tickSpacing) {
  if (!(downTicks > 0)) throw new Error(`The campaign's downTicks must be above zero — got ${downTicks}`);
  if (!(upTicks > 0)) throw new Error(`The campaign's upTicks must be above zero — got ${upTicks}`);
  if (toleranceTicks < tickSpacing) {
    throw new Error(
      `LP_APEBOND_TOLERANCE_TICKS ${toleranceTicks} is below the pool's tick spacing ${tickSpacing}: every NFT ` +
        `edge sits on the spacing, so the adapter refuses a tolerance below it`
    );
  }
  if (downTicks + upTicks >= MAX_TICK - MIN_TICK) {
    throw new Error(
      `The campaign band is too wide: downTicks + upTicks = ${downTicks + upTicks} must be below ` +
        `${MAX_TICK - MIN_TICK} (Uniswap's whole tick range)`
    );
  }
}

/** A campaign id: a 32-byte hex value as given, or keccak256 of any other label. */
function campaignIdFrom(raw) {
  const value = raw.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) return value.toLowerCase();
  return hre.ethers.id(value);
}

/**
 * The one campaign this run configures, or `null` when `LP_APEBOND_CAMPAIGN_ID` is unset.
 *
 * A campaign carries its band, its cliff, its rate and its minimum bonus (override O2: no limit of
 * any kind). The band is not a fixed range: the adapter places it around the pool's spot tick at
 * each purchase (Vladimir's decision of 14 Oct 2026), `downTicks` below and `upTicks` above the
 * $ASSET price — the two swap sides on the tick axis when $ASSET is token1 — and accepts an NFT
 * whose two edges are each within `toleranceTicks` of the band's.
 *
 *   LP_APEBOND_CAMPAIGN_ID        32-byte hex, or a label hashed with keccak256 (required)
 *   LP_APEBOND_DOWN_PCT           how far below the $ASSET price at the purchase the band starts,
 *                                 in percent, above 0 and below 100 (50): downTicks =
 *                                 round(ln(1 / (1 - pct/100)) / ln(1.0001)), 50 -> 6932
 *   LP_APEBOND_UP_PCT             how far above it the band ends, in percent, above 0 (100):
 *                                 upTicks = round(ln(1 + pct/100) / ln(1.0001)), 100 -> 6932
 *   LP_APEBOND_DOWN_TICKS         downTicks given directly; overrides LP_APEBOND_DOWN_PCT
 *   LP_APEBOND_UP_TICKS           upTicks given directly; overrides LP_APEBOND_UP_PCT
 *   LP_APEBOND_TOLERANCE_TICKS    the largest accepted distance of each NFT edge from the band's
 *                                 edge, in ticks, at least the pool's tick spacing (500)
 *   LP_APEBOND_CLIFF_SECONDS      seconds from the deposit to the unlock (required); at least
 *                                 `minCliffSeconds` (LP_APEBOND_MIN_CLIFF_SECONDS, see readMinCliff)
 *   LP_APEBOND_BONUS_BPS          the bonus as basis points of the position's value, <= 10,000
 *   LP_APEBOND_MIN_BONUS          whole bonus tokens (decimals allowed); below it a purchase is
 *                                 staked without a bonus (0)
 *   LP_APEBOND_CAMPAIGN_ENABLED   1 to accept deposits at once, 0 to configure it switched off (1)
 *
 * @param {{tickSpacing: number, bonusDecimals: number}} pool
 * @param {bigint} minCliffSeconds the adapter's cliff floor, from {@link readMinCliff}
 */
function readCampaign({ tickSpacing, bonusDecimals }, minCliffSeconds) {
  const rawId = process.env.LP_APEBOND_CAMPAIGN_ID;
  if (!rawId || rawId.trim() === "") return null;
  const id = campaignIdFrom(rawId);

  const downOverride = readInteger("LP_APEBOND_DOWN_TICKS", { required: false });
  const upOverride = readInteger("LP_APEBOND_UP_TICKS", { required: false });
  const downTicks =
    downOverride !== undefined
      ? Number(downOverride)
      : downPctToTicks(readPercent("LP_APEBOND_DOWN_PCT", DEFAULT_DOWN_PCT, { below: 100 }));
  const upTicks =
    upOverride !== undefined ? Number(upOverride) : upPctToTicks(readPercent("LP_APEBOND_UP_PCT", DEFAULT_UP_PCT));
  // int24 on chain: a larger value would fail to encode after the escrow and adapter exist.
  const toleranceTicks = Number(
    readInteger("LP_APEBOND_TOLERANCE_TICKS", { max: MAX_INT24, fallback: DEFAULT_TOLERANCE_TICKS })
  );
  checkOffsets({ downTicks, upTicks, toleranceTicks }, Number(tickSpacing));

  const bonusCliffSeconds = readInteger("LP_APEBOND_CLIFF_SECONDS", { min: 0, max: (1n << 64n) - 1n });
  if (bonusCliffSeconds < minCliffSeconds) {
    throw new Error(
      `LP_APEBOND_CLIFF_SECONDS ${bonusCliffSeconds} is below LP_APEBOND_MIN_CLIFF_SECONDS ${minCliffSeconds}: ` +
        `the adapter refuses a campaign cliff below its floor (audit C-14)`
    );
  }
  const bonusBps = readInteger("LP_APEBOND_BONUS_BPS", { min: 0, max: MAX_BPS });
  const minRaw = process.env.LP_APEBOND_MIN_BONUS;
  const minBonusAmount =
    minRaw === undefined || minRaw.trim() === "" ? 0n : hre.ethers.parseUnits(minRaw.trim(), bonusDecimals);
  const enabledRaw = process.env.LP_APEBOND_CAMPAIGN_ENABLED;
  if (enabledRaw !== undefined && !["", "0", "1"].includes(enabledRaw.trim())) {
    throw new Error(`LP_APEBOND_CAMPAIGN_ENABLED must be 1 or 0 — got ${enabledRaw}`);
  }
  const enabled = enabledRaw === undefined || enabledRaw.trim() === "" || enabledRaw.trim() === "1";

  return {
    id,
    label: rawId.trim(),
    config: { enabled, downTicks, upTicks, toleranceTicks, bonusCliffSeconds, bonusBps, minBonusAmount },
  };
}

/**
 * A campaign as `deployments.json` records it: every number a string or a plain number, nothing
 * a BigInt. `downPct` / `upPct` are the price moves the two offsets stand for, for the reader only.
 */
function campaignRecord(campaign, callers) {
  const c = campaign.config;
  return {
    id: campaign.id,
    label: campaign.label,
    enabled: c.enabled,
    downTicks: c.downTicks,
    upTicks: c.upTicks,
    toleranceTicks: c.toleranceTicks,
    downPct: downTicksToPct(c.downTicks),
    upPct: upTicksToPct(c.upTicks),
    bonusCliffSeconds: c.bonusCliffSeconds.toString(),
    bonusBps: Number(c.bonusBps),
    minBonusAmount: c.minBonusAmount.toString(),
    callers,
  };
}

/** The campaign config as the adapter's `setCampaign` takes it (tuple order). */
function campaignTuple(config) {
  return [
    config.enabled,
    config.downTicks,
    config.upTicks,
    config.toleranceTicks,
    config.bonusCliffSeconds,
    config.bonusBps,
    config.minBonusAmount,
  ];
}

/** The pool facts the campaign parser needs, read from the vault's own pool. */
async function readPoolFacts(vaultAddress, bonusToken) {
  const vault = new hre.ethers.Contract(vaultAddress, VAULT_LINK_ABI, hre.ethers.provider);
  const pool = new hre.ethers.Contract(await vault.pool(), POOL_ABI, hre.ethers.provider);
  const token = new hre.ethers.Contract(bonusToken, ERC20_DECIMALS_ABI, hre.ethers.provider);
  const slot0 = await pool.slot0();
  return {
    currentTick: Number(slot0.tick),
    tickSpacing: Number(await pool.tickSpacing()),
    bonusDecimals: Number(await token.decimals()),
    bonusSymbol: await token.symbol(),
  };
}

// ──────────────────────── deploy and wire ────────────────────────

/**
 * Steps 1 and 2: the escrow proxy (born owned by the timelock, reserve path closed) and the
 * adapter (owned by the deployer until the wiring is done). Both are recorded in
 * `deployments.json` as soon as each exists, so a later failure never loses an address.
 */
async function deployEscrowAndAdapter({
  chainId,
  deployer,
  vaultAddress,
  timelockAddress,
  positionManager,
  bonusToken,
  guardian,
  minCliffSeconds,
}) {
  const escrowDeploy = await deployProxyPair(
    ESCROW_KIND,
    [bonusToken, vaultAddress],
    [timelockAddress, hre.ethers.ZeroAddress],
    deployer
  );
  pools.recordDeployment(chainId, ESCROW_KIND, escrowDeploy.address, {
    deployTx: escrowDeploy.tx.hash,
    block: escrowDeploy.receipt.blockNumber,
    implementation: escrowDeploy.impl.address,
    implementationTx: escrowDeploy.impl.tx.hash,
    bonusToken,
    vault: vaultAddress,
    owner: timelockAddress,
    adapter: hre.ethers.ZeroAddress,
  });

  const adapterDeploy = await deployContract(
    ADAPTER_KIND,
    [positionManager, vaultAddress, escrowDeploy.address, deployer.address, guardian, minCliffSeconds],
    deployer
  );
  const adapter = new hre.ethers.Contract(adapterDeploy.address, ADAPTER_ABI, hre.ethers.provider);
  pools.recordDeployment(chainId, ADAPTER_KIND, adapterDeploy.address, {
    deployTx: adapterDeploy.tx.hash,
    block: adapterDeploy.receipt.blockNumber,
    vault: vaultAddress,
    escrow: escrowDeploy.address,
    positionManager,
    bonusToken,
    token0: hre.ethers.getAddress(await adapter.token0()),
    token1: hre.ethers.getAddress(await adapter.token1()),
    fee: Number(await adapter.fee()),
    tickSpacing: Number(await adapter.tickSpacing()),
    minCliffSeconds: (await adapter.minCliffSeconds()).toString(),
    guardian,
    soulZapCallers: [],
    campaigns: [],
    owner: deployer.address,
  });

  return { escrowDeploy, adapterDeploy };
}

/**
 * Step 3: the adapter's configuration, sent by the deployer while it still owns the adapter,
 * then the nomination of the timelock. Every call is skipped when its effect is already on
 * chain, so a resumed run sends nothing twice. A run that finds the adapter already nominated
 * (the third state, `owner == deployer`, `pendingOwner == timelock`) still completes the
 * configuration the deployer owns and sends no second `transferOwnership`.
 */
async function wireAdapter({ chainId, deployer, adapterAddress, timelockAddress, soulZapCallers, campaign }) {
  const adapter = await hre.ethers.getContractAt(ADAPTER_KIND, adapterAddress, deployer);
  const { state, owner } = await adapterOwnership(adapterAddress, {
    deployer: deployer.address,
    timelock: timelockAddress,
  });

  if (state === "deployer" || state === "pending") {
    if (state === "pending") {
      console.log(
        "The adapter is already NOMINATED to the timelock (owner = deployer, pendingOwner = timelock):\n" +
          "the activation batch opens with acceptOwnership(). The configuration is still the deployer's."
      );
    }
    for (const caller of soulZapCallers) {
      if (await adapter.soulZapCallers(caller)) {
        console.log(`SoulZap caller ${caller} is already allowlisted — skipped.`);
        continue;
      }
      await pools.send(`Allowlisting SoulZap caller ${caller}`, deployer, (o) => adapter.setSoulZapCaller(caller, true, o));
    }
    if (campaign) {
      const current = await adapter.campaigns(campaign.id);
      const wanted = campaign.config;
      const same =
        current.downTicks > 0n &&
        current.upTicks > 0n &&
        current.enabled === wanted.enabled &&
        Number(current.downTicks) === wanted.downTicks &&
        Number(current.upTicks) === wanted.upTicks &&
        Number(current.toleranceTicks) === wanted.toleranceTicks &&
        current.bonusCliffSeconds === wanted.bonusCliffSeconds &&
        current.bonusBps === wanted.bonusBps &&
        current.minBonusAmount === wanted.minBonusAmount;
      if (same) {
        console.log(`Campaign ${campaign.id} is already configured as asked — skipped.`);
      } else {
        await pools.send(`Configuring campaign ${campaign.label} (${campaign.id})`, deployer, (o) =>
          adapter.setCampaign(campaign.id, campaignTuple(wanted), o)
        );
      }
      for (const caller of soulZapCallers) {
        if (await adapter.campaignCallers(campaign.id, caller)) continue;
        await pools.send(`Permitting ${caller} for campaign ${campaign.label}`, deployer, (o) =>
          adapter.setCampaignCaller(campaign.id, caller, true, o)
        );
      }
    }
    // `Ownable2Step` (audit L-03): this only nominates the timelock. The deployer stays the
    // owner until the timelock batch executes `acceptOwnership()` (see {acceptOwnershipOp}).
    if (state === "deployer") {
      await pools.send(`${ADAPTER_KIND} -> timelock (nomination)`, deployer, (o) =>
        adapter.transferOwnership(timelockAddress, o)
      );
    }
  } else if (state === "timelock") {
    console.log("The adapter is already owned by the timelock — its configuration is owner-tier from here on.");
    const missing = [];
    for (const caller of soulZapCallers) if (!(await adapter.soulZapCallers(caller))) missing.push(`setSoulZapCaller(${caller}, true)`);
    if (campaign) {
      const current = await adapter.campaigns(campaign.id);
      if (!(current.downTicks > 0n && current.upTicks > 0n)) missing.push(`setCampaign(${campaign.id}, …)`);
      for (const caller of soulZapCallers) {
        if (!(await adapter.campaignCallers(campaign.id, caller))) missing.push(`setCampaignCaller(${campaign.id}, ${caller}, true)`);
      }
    }
    if (missing.length > 0) {
      console.log(
        "WARN  this configuration is NOT on the adapter and cannot be added by this run — schedule it\n" +
          "      through the timelock (lp-timelock.js, a TIMELOCK_BATCH file for setCampaign):\n" +
          missing.map((line) => `        ${line}`).join("\n")
      );
    }
  } else {
    throw new Error(
      `${ADAPTER_KIND} ${adapterAddress} is owned by ${owner} — neither the deployer (${deployer.address}) ` +
        `nor the timelock (${timelockAddress}). This run cannot wire it.`
    );
  }

  // The registry follows the chain, not the intention.
  const entry = pools.readRegistry()[String(chainId)][ADAPTER_KIND];
  if (entry && sameValue(entry.address, adapterAddress)) {
    const { address, ...rest } = entry;
    const callers = [];
    for (const caller of soulZapCallers) if (await adapter.soulZapCallers(caller)) callers.push(caller);
    const campaigns = (rest.campaigns || []).filter((c) => !campaign || c.id !== campaign.id);
    if (campaign) {
      const current = await adapter.campaigns(campaign.id);
      if (current.downTicks > 0n && current.upTicks > 0n) {
        const permitted = [];
        for (const caller of soulZapCallers) if (await adapter.campaignCallers(campaign.id, caller)) permitted.push(caller);
        campaigns.push(campaignRecord(campaign, permitted));
      }
    }
    pools.recordDeployment(chainId, ADAPTER_KIND, address, {
      ...rest,
      soulZapCallers: [...new Set([...(rest.soulZapCallers || []), ...callers])],
      campaigns,
      owner: hre.ethers.getAddress(await adapter.owner()),
      pendingOwner: (await adapterOwnership(adapterAddress, { timelock: timelockAddress })).pendingOwner,
    });
  }
}

// ──────────────────────── the link batch ────────────────────────

/**
 * Step 4's calls, only those whose effect is NOT already on chain — which is what makes a resumed
 * run compute the same batch id as the run it resumes, and a finished one an empty batch. The
 * FIRST call is `adapter.acceptOwnership()`, exactly while the adapter is nominated to the
 * timelock and has not accepted (audit L-03, {acceptOwnershipOp}).
 *
 * @param {object} state  `{ vaultAddress, escrowAddress, adapterAddress, timelockAddress, upgradeTo }`
 *                        — `upgradeTo` is the new vault implementation when the live vault needs
 *                        one, else null.
 */
async function linkOps({ vaultAddress, escrowAddress, adapterAddress, timelockAddress, upgradeTo, vaultHasRoute }) {
  const ops = [];
  const accept = await acceptOwnershipOp(adapterAddress, timelockAddress);
  if (accept) ops.push(accept);
  if (upgradeTo) {
    ops.push({ target: vaultAddress, kind: "LPStakingVault", fn: "upgradeToAndCall", args: [upgradeTo, "0x"] });
  }
  const vault = new hre.ethers.Contract(vaultAddress, VAULT_LINK_ABI, hre.ethers.provider);
  const escrow = new hre.ethers.Contract(escrowAddress, ESCROW_ABI, hre.ethers.provider);
  // Before the upgrade the two vault reads may not exist; the answer is then "missing".
  const linked = vaultHasRoute ? sameValue(await vault.bonusEscrow(), escrowAddress) : false;
  const allowed = vaultHasRoute ? await vault.isStakeOperator(adapterAddress) : false;
  if (!linked) ops.push({ target: vaultAddress, kind: "LPStakingVault", fn: "setBonusEscrow", args: [escrowAddress] });
  if (!allowed) {
    ops.push({ target: vaultAddress, kind: "LPStakingVault", fn: "setStakeOperator", args: [adapterAddress, "true"] });
  }
  if (!sameValue(await escrow.adapter(), adapterAddress)) {
    ops.push({ target: escrowAddress, kind: ESCROW_KIND, fn: "setAdapter", args: [adapterAddress] });
  }
  return ops;
}

/**
 * The batch as `lp-timelock.js`'s CLI reads it back: `{target, fn, args}` with every scalar a
 * string and a tuple kept as a nested array, which `coerceArgs` accepts verbatim.
 */
function batchFileContents(calls) {
  const render = (value) => (Array.isArray(value) ? value.map(render) : String(value));
  return calls.map((call) => ({ target: call.target, fn: call.fn, args: call.args.map(render) }));
}

// ──────────────────────── checks ────────────────────────

/**
 * The route's post-checks. `check(label, actual, expected)` is the caller's reporter. The two
 * link assertions come first because they are the ones a silent misconfiguration fails.
 *
 * `expectLinked = false` is the state BEFORE the activation batch executes: the adapter is then
 * nominated, not owned, so the check is `pendingOwner() == timelock` (the pre-execute check of
 * audit L-03). With `expectLinked = true` it is `owner() == timelock` and nothing pending.
 */
async function checkRoute(check, { vaultAddress, escrowAddress, adapterAddress, timelockAddress, bonusToken, guardian, soulZapCallers = [], campaign = null, expectLinked = true }) {
  const vault = new hre.ethers.Contract(vaultAddress, VAULT_LINK_ABI, hre.ethers.provider);
  const escrow = new hre.ethers.Contract(escrowAddress, ESCROW_ABI, hre.ethers.provider);
  const adapter = new hre.ethers.Contract(adapterAddress, ADAPTER_ABI, hre.ethers.provider);

  check("BonusEscrow.vault (MANDATORY: the escrow accepts this vault's reports)", await escrow.vault(), vaultAddress);
  if (expectLinked) {
    check("LPStakingVault.bonusEscrow (MANDATORY: a wrong link fails open)", await vault.bonusEscrow(), escrowAddress);
    check("LPStakingVault.isStakeOperator(adapter)", await vault.isStakeOperator(adapterAddress), true);
    check("BonusEscrow.adapter", await escrow.adapter(), adapterAddress);
  }
  check("BonusEscrow.bonusToken", await escrow.bonusToken(), bonusToken);
  check("BonusEscrow.bonusIsToken0", await escrow.bonusIsToken0(), sameValue(bonusToken, await vault.token0()));
  check("BonusEscrow.owner", await escrow.owner(), timelockAddress);
  check("BonusEscrow.pendingOwner", await escrow.pendingOwner(), hre.ethers.ZeroAddress);
  check(
    "BonusEscrow.adminSlot (ERC-1967, must be empty for UUPS)",
    await hre.upgrades.erc1967.getAdminAddress(escrowAddress),
    hre.ethers.ZeroAddress
  );

  check("ApeBondPositionAdapter.vault", await adapter.vault(), vaultAddress);
  check("ApeBondPositionAdapter.escrow", await adapter.escrow(), escrowAddress);
  check("ApeBondPositionAdapter.positionManager", await adapter.positionManager(), await vault.positionManager());
  check("ApeBondPositionAdapter.token0", await adapter.token0(), await vault.token0());
  check("ApeBondPositionAdapter.token1", await adapter.token1(), await vault.token1());
  check("ApeBondPositionAdapter.fee", await adapter.fee(), await vault.fee());
  const ownership = await adapterOwnership(adapterAddress, { timelock: timelockAddress });
  if (expectLinked) {
    check("ApeBondPositionAdapter.owner", ownership.owner, timelockAddress);
    check("ApeBondPositionAdapter.pendingOwner", ownership.pendingOwner, hre.ethers.ZeroAddress);
  } else {
    check(
      "ApeBondPositionAdapter.pendingOwner (the activation batch opens with acceptOwnership)",
      ownership.pendingOwner,
      timelockAddress
    );
  }
  if (guardian) check("ApeBondPositionAdapter.guardian", await adapter.guardian(), guardian);
  for (const caller of soulZapCallers) {
    check(`ApeBondPositionAdapter.soulZapCallers[${caller}]`, await adapter.soulZapCallers(caller), true);
  }
  if (campaign) {
    const c = await adapter.campaigns(campaign.id);
    const w = campaign.config;
    check(`campaign ${campaign.label}.enabled`, c.enabled, w.enabled);
    check(`campaign ${campaign.label}.downTicks`, c.downTicks, w.downTicks);
    check(`campaign ${campaign.label}.upTicks`, c.upTicks, w.upTicks);
    check(`campaign ${campaign.label}.toleranceTicks`, c.toleranceTicks, w.toleranceTicks);
    check(`campaign ${campaign.label}.bonusCliffSeconds`, c.bonusCliffSeconds, w.bonusCliffSeconds);
    check(`campaign ${campaign.label}.bonusBps`, c.bonusBps, w.bonusBps);
    check(`campaign ${campaign.label}.minBonusAmount`, c.minBonusAmount, w.minBonusAmount);
    for (const caller of soulZapCallers) {
      check(`campaign ${campaign.label}.callers[${caller}]`, await adapter.campaignCallers(campaign.id, caller), true);
    }
  }
}

/** Prints the campaign in human units before anything is sent. */
function describeCampaign(campaign, facts) {
  if (!campaign) return "none configured by this run (set LP_APEBOND_CAMPAIGN_ID to add one)";
  const c = campaign.config;
  return (
    `${campaign.label} (${campaign.id})\n` +
    `    band around the ${facts.bonusSymbol} price at each purchase: ${c.downTicks} ticks below ` +
    `(-${downTicksToPct(c.downTicks)} %) to ${c.upTicks} ticks above (+${upTicksToPct(c.upTicks)} %), ` +
    `tolerance ${c.toleranceTicks} ticks per edge (spacing ${facts.tickSpacing}), ` +
    `cliff ${c.bonusCliffSeconds}s, rate ${c.bonusBps} bps, minimum ` +
    `${hre.ethers.formatUnits(c.minBonusAmount, facts.bonusDecimals)} ${facts.bonusSymbol}, ` +
    `${c.enabled ? "enabled" : "switched OFF"}`
  );
}

module.exports = {
  ESCROW_KIND,
  ADAPTER_KIND,
  VAULT_LINK_ABI,
  ESCROW_ABI,
  ADAPTER_ABI,
  sameValue,
  adapterOwnership,
  acceptOwnershipOp,
  readApeBondFlag,
  readMinCliff,
  readAddress,
  readAddressList,
  readCampaign,
  downPctToTicks,
  upPctToTicks,
  downTicksToPct,
  upTicksToPct,
  campaignIdFrom,
  campaignRecord,
  campaignTuple,
  readPoolFacts,
  deployEscrowAndAdapter,
  wireAdapter,
  linkOps,
  batchFileContents,
  checkRoute,
  describeCampaign,
};
