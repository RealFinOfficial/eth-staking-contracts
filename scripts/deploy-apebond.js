const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const pools = require("./lib/pools");
const {
  ERC1967_IMPLEMENTATION_SLOT,
  readAddress,
  readAddressList,
  deployContract,
  deployProxyPair,
} = require("./deploy-lp-staking");
const { deployImplementation } = require("./deploy-implementation");
const {
  TIMELOCK_KIND,
  TIMELOCK_INTERFACE,
  buildBatch,
  encodeScheduleBatch,
  encodeExecuteBatch,
  describeCall,
} = require("./lp-timelock");

// Activate the ApeBond route on a stack that is ALREADY DEPLOYED.
//
// ──────────────────────── what this script is, and what it is not ────────────────────────
//
// `scripts/deploy-lp-staking.js` with `LP_APEBOND_ENABLED=1` deploys the route as part of a
// FRESH stack: the vault does not exist yet, so its implementation is the current one by
// construction and its `initialize` can name anything. None of that is available on a stack
// that is already live and already holds staked positions. There the same end state has to be
// reached by an IN-PLACE UUPS UPGRADE through the timelock that owns the proxy, next to two
// brand-new contracts, without moving a single field of the vault's existing state.
//
// This script is that second path. It deploys nothing the fresh-stack script does not deploy,
// wires nothing differently, and reuses the fresh-stack script's own `deployContract` /
// `deployProxyPair` so the two produce byte-identical shapes.
//
// ──────────────────────── the phases, in order ────────────────────────
//
//   1. RESOLVE. The vault proxy and the `LPTimelock` come out of `deployments.json` for this
//      chain and nowhere else — this script refuses to invent a stack. Every other value is
//      read back off the LIVE VAULT through its own getters (`positionManager()`, `pool()`,
//      `token0()`, `token1()`, `fee()`, `swapRouter()`), exactly as `deploy-implementation.js`
//      derives constructor arguments, because those getters return the deployed bytecode's
//      immutables and cannot disagree with the contract about to be upgraded. `getMinDelay()`
//      is read from the timelock; it is never assumed.
//
//   2. NEW VAULT IMPLEMENTATION. `deployImplementation({ kind: "LPStakingVault" })` — the same
//      exported function `scripts/deploy-implementation.js` runs, so the validation, the
//      manifest entry and the stripped `txHash` are identical. It is SKIPPED when the live
//      proxy already runs an implementation that HAS `setStakeOperator`; see
//      {vaultHasStakeOperator} for how that is probed and why the probe is a call rather than
//      a registry lookup.
//
//   3. ESCROW + ADAPTER, born-owned, the fresh-stack design applied to an existing vault. The
//      adapter's CREATE address is pre-computed from the deployer's nonce (escrow
//      implementation at N, escrow proxy at N + 1, adapter at N + 2) and handed to
//      `BonusEscrow.initialize(timelock, predictedAdapter)`, so the escrow is born owned by
//      the timelock AND born pointing at its adapter and no key holds its owner tier for even
//      one block. Both are recorded in `deployments.json` BEFORE the prediction is asserted: a
//      contract that is already on chain must never lose its address to a failing assertion.
//
//   4. WIRING, while the DEPLOYER still owns the adapter. `setSoulZapCaller(c, true)` per
//      configured caller, then `transferOwnership(timelock)` — the adapter is plain `Ownable`,
//      so that one transaction IS the handover, with no `acceptOwnership` to wait for.
//
//   5. THE TIMELOCK BATCH. The owner-tier calls this run cannot make itself, as ONE operation
//      the timelock runs in order, all or nothing. For the default mode that is
//      `upgradeToAndCall(newImplementation, 0x)` followed by `setStakeOperator(adapter, true)`,
//      and it HAS to be one operation: `setStakeOperator` does not exist on the implementation
//      the proxy runs before the upgrade, so as two separate operations the second would be
//      scheduled against code without that function and would revert after the whole delay.
//
//      On a non-mainnet chain whose timelock grants this deployer both PROPOSER_ROLE and
//      EXECUTOR_ROLE the script drives it end to end: `scheduleBatch`, wait out `getMinDelay()`
//      against the CHAIN's own latest block timestamp, `executeBatch`. On mainnet — and on any
//      chain where the deployer holds neither role — it prints the operands, the id and the
//      `scheduleBatch` / `executeBatch` calldata, asserts the interim state and STOPS, because
//      those two transactions are the Safe's to send.
//
//   6. POST-CHECKS, including STATE PRESERVATION. Every field of the live vault that the run
//      must not have touched is read BEFORE phase 2 and compared after phase 5: owner,
//      guardian, operator, zapper, TWAP window and deviation, both pause flags, and the staker
//      credited with every token id in `LP_APEBOND_ASSERT_POSITIONS`. The distributor's own
//      ERC-1967 implementation slot is read the same way — this run must not have moved it.
//
//   7. RECORD. `LPStakingVault.implementation` moves to the new implementation (the entry is
//      spread, so nothing else in it is lost, and the two `pendingImplementation` keys
//      `deploy-implementation.js` may have written are dropped, because they are no longer
//      pending). `BonusEscrow` and `ApeBondPositionAdapter` were recorded in phase 3.
//
// ──────────────────────── resume safety ────────────────────────
//
// Every phase reads the chain and the registry first and skips what is already in place. A run
// interrupted anywhere — a dropped RPC connection, a Ctrl-C during the delay — is resumed by
// running the SAME command again: it never redeploys a proxy, never re-schedules an operation
// and never sends a transaction whose effect is already on chain.
//
// The batch is what makes that work. It is assembled from only the calls whose effect is NOT
// already present, and the salt `lp-timelock.js` derives is a pure function of the calls, so a
// resumed run that still needs the same calls computes the SAME operation id and finds it
// `isOperationPending` (wait, then execute) or `isOperationDone` (skip). When every call's
// effect is already on chain the batch is empty and phase 5 is skipped entirely.
//
// ──────────────────────── the three modes ────────────────────────
//
//   LP_APEBOND_MODE=activate         (default) phases 1-7 above: the full activation.
//   LP_APEBOND_MODE=replace-adapter  Vladimir's decision C, 2026-09-09 (audit notes item 15):
//                                    the adapter is REPLACEABLE, not upgradeable. Deploys a new
//                                    adapter against the EXISTING escrow, wires its callers,
//                                    hands it to the timelock, and then ONE batch of three —
//                                    `setStakeOperator(old, false)`, `setStakeOperator(new,
//                                    true)`, `escrow.setAdapter(new)` — so the old adapter
//                                    loses the reserve right in the same transaction the new
//                                    one gains it. No migration: the only state the old adapter
//                                    holds is the spent-id book, and every entry in it belongs
//                                    to a purchase that already completed.
//   LP_APEBOND_MODE=upgrade-vault    Phase 2 plus a ONE-call batch, `upgradeToAndCall`. The
//                                    plain vault upgrade, with no ApeBond contract touched.
//
// `replace-adapter` is resume-safe but NOT idempotent across COMPLETED runs, and that is
// deliberate: the new adapter is recorded as `pendingAdapter` on the registry entry before it
// is activated, so an interrupted run resumes the SAME replacement, while a run started after
// the previous one completed is a NEW replacement and deploys another adapter. Replacing is an
// explicit act; the script does not second-guess an operator who asked for it twice.
//
// ──────────────────────── environment ────────────────────────
//
//   LP_APEBOND_MODE              activate | replace-adapter | upgrade-vault (activate)
//   LP_APEBOND_BONUS_TOKEN       the escrow's one immutable — the token every campaign bonus is
//                                denominated and paid in. No upgrade can change it. Defaults to
//                                the VAULT's own `token0()`, read from the proxy
//   LP_APEBOND_GUARDIAN          the adapter's undelayed fast path: `setPurchaseSigner` and
//                                `setDepositsPaused`. Defaults to the deploying key, which is
//                                the test-stack arrangement; on mainnet name the multisig
//   LP_APEBOND_SOULZAP_CALLERS   comma-separated SoulZap contracts allowed to present an
//                                authorization to `depositFor`. Empty allowlists nobody (none)
//   LP_APEBOND_PURCHASE_SIGNER   backend key whose EIP-712 signature authorizes a purchase.
//                                Unset leaves `address(0)`, which is the deposit path CLOSED:
//                                every `depositFor` reverts until the guardian opens it with
//                                one undelayed `setPurchaseSigner` (none)
//   LP_APEBOND_ASSERT_POSITIONS  comma-separated token ids whose `stakerOf` must read the same
//                                before and after the upgrade. Defaults to the one live
//                                position on Sepolia test stack #5 (231913 on chain 11155111,
//                                none on any other chain)
//   LP_APEBOND_BATCH_FILE        where the `TIMELOCK_BATCH` JSON is written, so the operator can
//                                drive the same batch by hand with `lp-timelock.js`. Defaults
//                                to `apebond-<mode>-batch.json` beside the registry file
//   LP_APEBOND_WAIT_POLL_MS      how often the wait re-reads the chain (5000)
//   LP_APEBOND_WAIT_TIMEOUT_MS   wall-clock ceiling on that wait; on expiry the run stops with
//                                the operation SCHEDULED and names the execute command
//                                (4 * minDelay seconds, and never less than two minutes)
//   IMPL_CONTRACT                artifact name for the vault implementation; defaults to
//                                `LPStakingVault`. Setting it also FORCES phase 2 — naming an
//                                implementation is an instruction, so the probe does not get to
//                                overrule it
//   IMPL_UNSAFE_ALLOW_EXTRA      comma-separated extra `unsafeAllow` flags, handed straight to
//                                `deployImplementation`. `missing-initializer` is the one a
//                                real V2 needs
//   TIMELOCK_SALT_TAG            distinguishes two otherwise identical batches, exactly as it
//                                does for `lp-timelock.js`. Needed only to re-run a batch that
//                                already executed once
//   DEPLOYMENTS_FILE             redirects the registry, like every other script here
//   CONFIRM=yes                  required on mainnet
//
//     LP_APEBOND_SOULZAP_CALLERS=0xSoulZap LP_APEBOND_GUARDIAN=0xMultisig \
//       npx hardhat run scripts/deploy-apebond.js --network sepolia
//
// The full runbook — Infura probe, the indexer's ABI, the run, the post-checks, the commit — is
// in scripts/README.md under "Activating ApeBond on an existing stack (Sepolia test stack #5)".

/** The registry kinds this script reads, writes, or refuses to run without. */
const VAULT_KIND = "LPStakingVault";
const DISTRIBUTOR_KIND = "RewardsDistributor";
const ESCROW_KIND = "BonusEscrow";
const ADAPTER_KIND = "ApeBondPositionAdapter";

const MODES = ["activate", "replace-adapter", "upgrade-vault"];
const DEFAULT_MODE = "activate";

/**
 * Token ids whose staker must read the same before and after, per chain.
 *
 * State preservation is only a claim until something is named: an upgrade that wiped the
 * vault's ledger would pass every role check and every slot check and fail only here. Chain
 * 11155111 carries the one live position on Sepolia test stack #5, NFT 231913, staked by the
 * operator key on 2026-09-14. Any other chain names nothing, because nothing is known about it.
 */
const DEFAULT_ASSERT_POSITIONS = { 11155111: ["231913"] };

/** How often the wait re-reads the chain, and the wall-clock ceiling on it. */
const DEFAULT_WAIT_POLL_MS = 5000;
const MIN_WAIT_TIMEOUT_MS = 120_000;
const WAIT_TIMEOUT_DELAY_FACTOR = 4;

/** The view surface every read below goes through. Nothing else is called on these contracts. */
const VAULT_ABI = [
  "function positionManager() view returns (address)",
  "function pool() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function swapRouter() view returns (address)",
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function guardian() view returns (address)",
  "function operator() view returns (address)",
  "function zapper() view returns (address)",
  "function twapWindow() view returns (uint32)",
  "function maxTwapDeviationTicks() view returns (uint24)",
  "function depositsPaused() view returns (bool)",
  "function rebalancePaused() view returns (bool)",
  "function stakerOf(uint256 tokenId) view returns (address)",
  "function isStakeOperator(address account) view returns (bool)",
];

const ESCROW_ABI = [
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function adapter() view returns (address)",
  "function bonusToken() view returns (address)",
  "function totalReserved() view returns (uint256)",
];

const ADAPTER_ABI = [
  "function owner() view returns (address)",
  "function vault() view returns (address)",
  "function escrow() view returns (address)",
  "function positionManager() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function guardian() view returns (address)",
  "function purchaseSigner() view returns (address)",
  "function depositsPaused() view returns (bool)",
  "function soulZapCallers(address caller) view returns (bool)",
];

/** The one probe that decides whether the live vault needs the upgrade at all. */
const STAKE_OPERATOR_PROBE_ABI = ["function isStakeOperator(address account) view returns (bool)"];

// ──────────────────────── small helpers ────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Compares two on-chain values the way Solidity would: addresses case-insensitively. */
function sameValue(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

/** The mode, read strictly: a typo must not silently run the full activation. */
function readMode() {
  const raw = process.env.LP_APEBOND_MODE;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MODE;
  if (!MODES.includes(raw)) {
    throw new Error(`LP_APEBOND_MODE must be one of ${MODES.join(", ")} — got ${raw}`);
  }
  return raw;
}

/** The token ids whose staker must survive, per the env var or this chain's default. */
function readAssertPositions(chainId) {
  const raw = process.env.LP_APEBOND_ASSERT_POSITIONS;
  if (raw === undefined) return DEFAULT_ASSERT_POSITIONS[chainId] || [];
  if (raw.trim() === "") return [];
  return raw.split(",").map((entry, index) => {
    const value = entry.trim();
    if (!/^[0-9]+$/.test(value)) {
      throw new Error(
        `LP_APEBOND_ASSERT_POSITIONS entry ${index} is not a token id: ${value}`
      );
    }
    return value;
  });
}

/** Reads one address off a live proxy and checksums it. */
function readSlotAddress(word) {
  return hre.ethers.getAddress("0x" + word.slice(-40));
}

/** The ERC-1967 implementation slot of `proxy`, read from storage rather than trusted. */
async function implementationOf(proxy) {
  return readSlotAddress(
    await hre.ethers.provider.getStorage(proxy, ERC1967_IMPLEMENTATION_SLOT)
  );
}

/**
 * Whether the implementation the proxy RUNS carries `setStakeOperator`.
 *
 * It is probed with a view call rather than looked up in `deployments.json`, because the
 * registry records an address and this question is about CODE: the only authority on which
 * functions the proxy answers today is the proxy. `isStakeOperator(address)` is the read half
 * of the same feature — a vault without the stake-operator allowlist has neither — so a call
 * that returns is proof the upgrade already landed, whatever the registry says, and a call that
 * reverts (the proxy delegates into an implementation with no such selector and no fallback) is
 * proof it has not.
 */
async function vaultHasStakeOperator(vaultAddress) {
  const probe = new hre.ethers.Contract(
    vaultAddress,
    STAKE_OPERATOR_PROBE_ABI,
    hre.ethers.provider
  );
  try {
    await probe.isStakeOperator(hre.ethers.ZeroAddress);
    return true;
  } catch {
    return false;
  }
}

/** Refuses an address that carries no code — every one of them is load-bearing here. */
async function requireCode(label, address) {
  const code = await hre.ethers.provider.getCode(address);
  if (code === "0x") throw new Error(`No contract code at ${label} ${address}`);
}

/**
 * The batch as `lp-timelock.js`'s CLI would read it back: an array of `{target, fn, args}` with
 * raw addresses and string arguments, which `resolveBatchEntry` and `coerceArgs` accept
 * verbatim. Written on every run that builds a batch, so the operator can drive the very same
 * operation by hand — same targets, same payloads, same derived salt, same id.
 */
function batchFileContents(calls) {
  return calls.map((call) => ({
    target: call.target,
    fn: call.fn,
    args: call.args.map((value) => String(value)),
  }));
}

/**
 * Waits until the timelock reports the operation READY, measured against the CHAIN's own latest
 * block timestamp rather than the local clock — that is the value `executeBatch` compares
 * against, and the two can be far apart on a test chain.
 *
 * The wall-clock ceiling is a liveness guard, not a deadline: on expiry the operation is still
 * scheduled and still executable, and the caller is told exactly how.
 */
async function waitForReady(timelock, id, { pollMs, timeoutMs }) {
  const startedAt = Date.now();
  for (;;) {
    if (await timelock.isOperationReady(id)) return;

    const readyAt = await timelock.getTimestamp(id);
    if (readyAt === 0n) throw new Error(`Operation ${id} is no longer scheduled — it was cancelled`);

    const block = await hre.ethers.provider.getBlock("latest");
    const remaining = Number(readyAt) - block.timestamp;
    console.log(
      `  waiting: ${remaining}s of CHAIN time left ` +
        `(block ${block.number}, chain timestamp ${block.timestamp}, readyAt ${readyAt})`
    );

    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(
        `The batch did not become executable within ${Math.round(timeoutMs / 1000)}s of wall ` +
          `clock. It IS scheduled (id ${id}) and nothing is lost: re-run this script to resume, ` +
          `or execute it by hand once the chain's timestamp passes ${readyAt}.`
      );
    }
    await sleep(pollMs);
  }
}

// ──────────────────────── the run ────────────────────────

async function main() {
  const chainId = await pools.chainId();
  const mainnet = pools.isMainnet(chainId);
  const deployer = await pools.getSigner();
  const network = hre.network.name;
  const mode = readMode();

  // ──────── phase 1: resolve the live stack ────────

  const registry = pools.readRegistry()[String(chainId)] || {};
  const vaultEntry = registry[VAULT_KIND];
  const timelockEntry = registry[TIMELOCK_KIND];
  if (!vaultEntry || !timelockEntry) {
    throw new Error(
      `Chain ${chainId} has no ${!vaultEntry ? VAULT_KIND : TIMELOCK_KIND} entry in the ` +
        `deployment registry. This script activates ApeBond on a stack that is ALREADY ` +
        `deployed and recorded — it never invents one. Deploy the stack with ` +
        `scripts/deploy-lp-staking.js first, or point DEPLOYMENTS_FILE at the registry that ` +
        `records it.`
    );
  }

  const vaultAddress = hre.ethers.getAddress(vaultEntry.address);
  const timelockAddress = hre.ethers.getAddress(timelockEntry.address);
  await requireCode(`${VAULT_KIND} proxy`, vaultAddress);
  await requireCode(TIMELOCK_KIND, timelockAddress);

  const vault = new hre.ethers.Contract(vaultAddress, VAULT_ABI, hre.ethers.provider);
  const timelock = new hre.ethers.Contract(
    timelockAddress,
    TIMELOCK_INTERFACE,
    hre.ethers.provider
  );

  // Every constructor argument the adapter takes is read back off the LIVE vault, never from an
  // env var and never from the registry: these getters return the deployed implementation's own
  // immutables, so an adapter built from them is built against the same pool, pair and fee tier
  // the vault itself enforces.
  const positionManager = hre.ethers.getAddress(await vault.positionManager());
  const poolAddress = hre.ethers.getAddress(await vault.pool());
  const token0 = hre.ethers.getAddress(await vault.token0());
  const token1 = hre.ethers.getAddress(await vault.token1());
  const fee = Number(await vault.fee());
  const swapRouter = hre.ethers.getAddress(await vault.swapRouter());

  // The "before" side of the state-preservation check. Read here, BEFORE anything is deployed
  // or scheduled, and compared field by field after the batch has executed.
  const before = {
    implementation: await implementationOf(vaultAddress),
    owner: hre.ethers.getAddress(await vault.owner()),
    pendingOwner: hre.ethers.getAddress(await vault.pendingOwner()),
    guardian: hre.ethers.getAddress(await vault.guardian()),
    operator: hre.ethers.getAddress(await vault.operator()),
    zapper: hre.ethers.getAddress(await vault.zapper()),
    twapWindow: Number(await vault.twapWindow()),
    maxTwapDeviationTicks: Number(await vault.maxTwapDeviationTicks()),
    depositsPaused: await vault.depositsPaused(),
    rebalancePaused: await vault.rebalancePaused(),
    stakers: {},
    distributorImplementation: null,
  };

  const assertPositions = readAssertPositions(chainId);
  for (const tokenId of assertPositions) {
    before.stakers[tokenId] = hre.ethers.getAddress(await vault.stakerOf(tokenId));
  }

  const distributorEntry = registry[DISTRIBUTOR_KIND];
  if (distributorEntry) {
    before.distributorImplementation = await implementationOf(
      hre.ethers.getAddress(distributorEntry.address)
    );
  }

  // The batch is the only way an owner-tier call can be made here, so a vault the timelock does
  // not own cannot be activated by this script at all. Saying so now costs nothing; finding out
  // after two deploys costs two deploys.
  if (!sameValue(before.owner, timelockAddress)) {
    throw new Error(
      `${VAULT_KIND} ${vaultAddress} is owned by ${before.owner}, but the registry records the ` +
        `timelock as ${timelockAddress}. Every call this script schedules is owner-tier, so a ` +
        `vault owned by anything else cannot be activated from here.`
    );
  }

  const minDelay = await timelock.getMinDelay();

  const bonusToken = readAddress("LP_APEBOND_BONUS_TOKEN", token0);
  const apeBondGuardian = readAddress("LP_APEBOND_GUARDIAN", deployer.address);
  const purchaseSigner = process.env.LP_APEBOND_PURCHASE_SIGNER
    ? readAddress("LP_APEBOND_PURCHASE_SIGNER")
    : hre.ethers.ZeroAddress;
  const soulZapCallers = readAddressList("LP_APEBOND_SOULZAP_CALLERS");

  for (const [label, address] of [
    ["pool (from the vault)", poolAddress],
    ["positionManager (from the vault)", positionManager],
    ["swapRouter (from the vault)", swapRouter],
    ["token0 (from the vault)", token0],
    ["token1 (from the vault)", token1],
    ["LP_APEBOND_BONUS_TOKEN", bonusToken],
  ]) {
    await requireCode(label, address);
  }

  const waitPollMs = Number(process.env.LP_APEBOND_WAIT_POLL_MS || DEFAULT_WAIT_POLL_MS);
  const waitTimeoutMs = Number(
    process.env.LP_APEBOND_WAIT_TIMEOUT_MS ||
      Math.max(MIN_WAIT_TIMEOUT_MS, Number(minDelay) * 1000 * WAIT_TIMEOUT_DELAY_FACTOR)
  );

  console.log(`Activating the ApeBond route on an existing stack (mode: ${mode})`);
  console.log(`Network:            ${network} (chain ${chainId})`);
  console.log(`Deployer:           ${deployer.address}`);
  console.log(`LPStakingVault:     ${vaultAddress} (proxy)`);
  console.log(`  ${pools.explorerAddress(chainId, vaultAddress)}`);
  console.log(`  implementation:   ${before.implementation} (ERC-1967 slot)`);
  console.log(`  owner:            ${before.owner}`);
  console.log(`  guardian:         ${before.guardian}`);
  console.log(`  operator:         ${before.operator}`);
  console.log(`  zapper:           ${before.zapper}`);
  console.log(`  pool:             ${poolAddress}`);
  console.log(`  token0/token1:    ${token0} / ${token1}`);
  console.log(`  fee:              ${fee}`);
  console.log(`  positionManager:  ${positionManager}`);
  console.log(`  swapRouter:       ${swapRouter}`);
  console.log(`  TWAP:             ${before.twapWindow}s / ${before.maxTwapDeviationTicks} ticks`);
  console.log(
    `  paused:           deposits ${before.depositsPaused}, rebalance ${before.rebalancePaused}`
  );
  console.log(`LPTimelock:         ${timelockAddress}`);
  console.log(`  minDelay:         ${minDelay}s (read from the contract)`);
  console.log(`Bonus token:        ${bonusToken}${sameValue(bonusToken, token0) ? " (= the vault's token0)" : ""}`);
  console.log(
    `Adapter guardian:   ${apeBondGuardian}` +
      (sameValue(apeBondGuardian, deployer.address) ? " (= the deployer)" : "")
  );
  console.log(
    `Purchase signer:    ${
      purchaseSigner === hre.ethers.ZeroAddress
        ? "NOT SET — the deposit path is closed until the guardian opens it"
        : purchaseSigner
    }`
  );
  console.log(
    `SoulZap callers:    ${soulZapCallers.length > 0 ? soulZapCallers.join(", ") : "none"}`
  );
  console.log(
    `Positions asserted: ${assertPositions.length > 0 ? assertPositions.join(", ") : "none"}`
  );

  const hasStakeOperator = await vaultHasStakeOperator(vaultAddress);
  console.log(
    `\nThe live implementation ${hasStakeOperator ? "HAS" : "does NOT have"} setStakeOperator ` +
      `(probed with a static isStakeOperator call through the proxy).`
  );

  pools.requireConfirmation(chainId, `activate the ApeBond route (mode ${mode}) on chain ${chainId}`);
  if (mainnet) console.log("\nEvery transaction below needs a Ledger confirmation.");

  // ──────── phase 2: the new vault implementation ────────

  // Naming an artifact is an instruction, not a hint: a run that was told WHICH implementation
  // to install always deploys and always schedules the upgrade, and the probe only decides for
  // a run that was told nothing.
  const implContract = process.env.IMPL_CONTRACT || undefined;
  const unsafeAllowExtra = (process.env.IMPL_UNSAFE_ALLOW_EXTRA || "")
    .split(",")
    .map((flag) => flag.trim())
    .filter((flag) => flag.length > 0);

  let wantsNewImplementation;
  if (mode === "upgrade-vault") {
    wantsNewImplementation = true;
  } else if (mode === "replace-adapter") {
    wantsNewImplementation = false;
  } else {
    wantsNewImplementation = Boolean(implContract) || !hasStakeOperator;
  }

  if (mode === "replace-adapter" && !hasStakeOperator) {
    throw new Error(
      `Mode replace-adapter needs a vault that already carries the stake-operator allowlist, ` +
        `and ${vaultAddress} does not: its implementation ${before.implementation} has no ` +
        `setStakeOperator. Run the default mode (LP_APEBOND_MODE=activate) first.`
    );
  }

  let newImplementation = before.implementation;
  let implementationTx = null;
  if (wantsNewImplementation) {
    console.log("\n──────── phase 2: a new LPStakingVault implementation ────────");
    const prepared = await deployImplementation({
      kind: VAULT_KIND,
      proxyAddress: vaultAddress,
      contractName: implContract,
      unsafeAllowExtra,
      deployer,
    });
    newImplementation = prepared.implementation;
    implementationTx = prepared.deployTxHash;

    if (sameValue(newImplementation, before.implementation) && !hasStakeOperator) {
      throw new Error(
        `The ${implContract || VAULT_KIND} in this build compiles to the implementation the ` +
          `proxy ALREADY RUNS (${newImplementation}), and that implementation has no ` +
          `setStakeOperator. There is nothing to upgrade to and the allowlist call would ` +
          `revert after the whole delay. Check out the branch that carries the stake-operator ` +
          `change and re-run.`
      );
    }
  } else {
    console.log(
      `\n──────── phase 2: SKIPPED ────────\n` +
        `The proxy already runs an implementation with setStakeOperator (${before.implementation}), ` +
        `and no IMPL_CONTRACT was named, so no new implementation is deployed and the upgrade ` +
        `is not part of the batch.`
    );
  }

  // ──────── phase 3: the escrow and the adapter ────────

  const escrowEntry = registry[ESCROW_KIND];
  const adapterEntry = registry[ADAPTER_KIND];

  let escrowAddress = null;
  let escrowImplementation = escrowEntry ? escrowEntry.implementation : null;
  let adapterAddress = null;
  let previousAdapter = null;

  if (mode === "upgrade-vault") {
    // Nothing ApeBond-shaped is deployed or touched. The escrow and the adapter are only read,
    // and only so the summary can say what the stack holds.
    escrowAddress = escrowEntry ? hre.ethers.getAddress(escrowEntry.address) : null;
    adapterAddress = adapterEntry ? hre.ethers.getAddress(adapterEntry.address) : null;
    console.log(
      "\n──────── phase 3: SKIPPED (mode upgrade-vault) ────────\n" +
        "This mode upgrades the vault and nothing else: no escrow, no adapter, no wiring."
    );
  } else if (mode === "replace-adapter") {
    if (!escrowEntry || !adapterEntry) {
      throw new Error(
        `Mode replace-adapter needs both a ${ESCROW_KIND} and an ${ADAPTER_KIND} recorded for ` +
          `chain ${chainId}, and ${!escrowEntry ? ESCROW_KIND : ADAPTER_KIND} is missing. There ` +
          `is nothing to replace — run the default mode to deploy the route first.`
      );
    }
    escrowAddress = hre.ethers.getAddress(escrowEntry.address);
    await requireCode(ESCROW_KIND, escrowAddress);

    if (adapterEntry.pendingAdapter) {
      // An interrupted replacement. The new adapter is already on chain and already recorded;
      // this run picks up exactly where the last one stopped and deploys nothing.
      previousAdapter = hre.ethers.getAddress(adapterEntry.address);
      adapterAddress = hre.ethers.getAddress(adapterEntry.pendingAdapter);
      await requireCode(`${ADAPTER_KIND} (pending)`, adapterAddress);
      console.log(
        `\n──────── phase 3: RESUMING a replacement ────────\n` +
          `A pending adapter is already recorded and already on chain: ${adapterAddress}.\n` +
          `It replaces ${previousAdapter}. Nothing is deployed by this run.`
      );
    } else {
      previousAdapter = hre.ethers.getAddress(adapterEntry.address);
      await requireCode(`${ADAPTER_KIND} (the one being replaced)`, previousAdapter);
      console.log("\n──────── phase 3: a replacement adapter ────────");
      console.log(`Replacing ${previousAdapter} against the existing escrow ${escrowAddress}.`);

      const replacement = await deployContract(
        ADAPTER_KIND,
        [
          positionManager,
          vaultAddress,
          escrowAddress,
          token0,
          token1,
          fee,
          deployer.address,
          apeBondGuardian,
          purchaseSigner,
        ],
        deployer
      );
      adapterAddress = replacement.address;

      // Recorded as PENDING before it is activated, the same shape `deploy-implementation.js`
      // uses for an implementation that is on chain but not yet live. That is what makes an
      // interrupted replacement resumable rather than a second, silent deploy.
      pools.recordDeployment(chainId, ADAPTER_KIND, adapterEntry.address, {
        ...stripAddress(adapterEntry),
        pendingAdapter: adapterAddress,
        pendingAdapterBlock: replacement.receipt.blockNumber,
        pendingAdapterTx: replacement.tx.hash,
      });
    }
  } else {
    // Default mode. The escrow is deployed only when the registry does not already hold one
    // with code on it; a half-finished run must never produce a second escrow, because the
    // second one would be born pointing at a different adapter and hold none of the money.
    const escrowLive = Boolean(
      escrowEntry && (await hre.ethers.provider.getCode(escrowEntry.address)) !== "0x"
    );
    const adapterLive = Boolean(
      adapterEntry && (await hre.ethers.provider.getCode(adapterEntry.address)) !== "0x"
    );

    if (escrowLive && adapterLive) {
      escrowAddress = hre.ethers.getAddress(escrowEntry.address);
      adapterAddress = hre.ethers.getAddress(adapterEntry.address);
      escrowImplementation = await implementationOf(escrowAddress);
      console.log(
        `\n──────── phase 3: SKIPPED ────────\n` +
          `The registry already records a live ${ESCROW_KIND} (${escrowAddress}) and a live ` +
          `${ADAPTER_KIND} (${adapterAddress}). Neither is redeployed.`
      );
    } else if (escrowLive !== adapterLive) {
      throw new Error(
        `The registry for chain ${chainId} records a live ${escrowLive ? ESCROW_KIND : ADAPTER_KIND} ` +
          `but no live ${escrowLive ? ADAPTER_KIND : ESCROW_KIND}. The two are deployed together, ` +
          `in one nonce-controlled sequence, and cannot be completed separately: the escrow is ` +
          `born pointing at the adapter's pre-computed address. Remove the stray entry and ` +
          `re-run, or repair the pairing with BonusEscrow.setAdapter through the timelock.`
      );
    } else {
      console.log("\n──────── phase 3: BonusEscrow + ApeBondPositionAdapter ────────");

      // The fresh-stack prediction, applied to a live vault: escrow implementation at nonce N,
      // escrow proxy at N + 1, adapter at N + 2. A CREATE address is a pure function of
      // (deployer, nonce) and every transaction below carries an explicit nonce, so the
      // adapter's address is known before the escrow exists — which is what lets the escrow be
      // born owned by the timelock AND born pointing at its adapter.
      const escrowImplNonce = await pools.resolveNonce(deployer.address);
      const predictedAdapter = hre.ethers.getCreateAddress({
        from: deployer.address,
        nonce: escrowImplNonce + 2,
      });
      console.log(
        `Predicted ${ADAPTER_KIND} address: ${predictedAdapter} ` +
          `(deployer nonce ${escrowImplNonce + 2})`
      );

      const escrowDeploy = await deployProxyPair(
        ESCROW_KIND,
        [bonusToken],
        [timelockAddress, predictedAdapter],
        deployer
      );
      escrowAddress = escrowDeploy.address;
      escrowImplementation = escrowDeploy.impl.address;
      pools.recordDeployment(chainId, ESCROW_KIND, escrowAddress, {
        deployTx: escrowDeploy.tx.hash,
        block: escrowDeploy.receipt.blockNumber,
        implementation: escrowImplementation,
        implementationTx: escrowDeploy.impl.tx.hash,
        bonusToken,
        owner: timelockAddress,
        adapter: predictedAdapter,
      });

      const adapterDeploy = await deployContract(
        ADAPTER_KIND,
        [
          positionManager,
          vaultAddress,
          escrowAddress,
          token0,
          token1,
          fee,
          deployer.address,
          apeBondGuardian,
          purchaseSigner,
        ],
        deployer
      );
      adapterAddress = adapterDeploy.address;
      // Recorded BEFORE the prediction is checked, for the reason the fresh-stack script gives:
      // a contract that is already on chain must not lose its address to a failing assertion.
      pools.recordDeployment(chainId, ADAPTER_KIND, adapterAddress, {
        deployTx: adapterDeploy.tx.hash,
        block: adapterDeploy.receipt.blockNumber,
        vault: vaultAddress,
        escrow: escrowAddress,
        bonusToken,
        token0,
        token1,
        fee,
        guardian: apeBondGuardian,
        purchaseSigner,
        soulZapCallers,
        owner: timelockAddress,
      });

      if (!sameValue(adapterAddress, predictedAdapter)) {
        throw new Error(
          `${ADAPTER_KIND} landed at ${adapterAddress}, but ${ESCROW_KIND} was initialized with ` +
            `${predictedAdapter}. Both contracts are deployed and both are recorded; the ` +
            `escrow's reserve path points at the wrong address, so every depositFor would ` +
            `revert. Schedule BonusEscrow.setAdapter(${adapterAddress}) through the timelock ` +
            `(TIMELOCK_TARGET=BonusEscrow TIMELOCK_FN=setAdapter) and then re-run this script. ` +
            `The live stack is unaffected.`
        );
      }
      console.log(
        `  ${ADAPTER_KIND} landed on the predicted address; the escrow was born pointing at it`
      );
    }
  }

  const escrow = escrowAddress
    ? new hre.ethers.Contract(escrowAddress, ESCROW_ABI, hre.ethers.provider)
    : null;
  const adapter = adapterAddress
    ? new hre.ethers.Contract(adapterAddress, ADAPTER_ABI, hre.ethers.provider)
    : null;

  // ──────── phase 4: wiring, while the deployer still owns the adapter ────────

  if (mode !== "upgrade-vault" && adapter) {
    console.log("\n──────── phase 4: the adapter's allowlist and its handover ────────");
    const adapterOwner = hre.ethers.getAddress(await adapter.owner());
    const adapterAsDeployer = await hre.ethers.getContractAt(
      ADAPTER_KIND,
      adapterAddress,
      deployer
    );

    if (sameValue(adapterOwner, deployer.address)) {
      for (const caller of soulZapCallers) {
        if (await adapter.soulZapCallers(caller)) {
          console.log(`SoulZap caller ${caller} is already allowlisted — skipped.`);
          continue;
        }
        await pools.send(`Allowlisting SoulZap caller ${caller}`, deployer, (o) =>
          adapterAsDeployer.setSoulZapCaller(caller, true, o)
        );
      }
      // Plain `Ownable`: one transaction, no acceptance, owned by the timelock from this block.
      await pools.send(`${ADAPTER_KIND} -> timelock`, deployer, (o) =>
        adapterAsDeployer.transferOwnership(timelockAddress, o)
      );
    } else if (sameValue(adapterOwner, timelockAddress)) {
      console.log(
        `The adapter is already owned by the timelock — the handover is done and the allowlist\n` +
          `is owner-tier from here on.`
      );
      const missing = [];
      for (const caller of soulZapCallers) {
        if (!(await adapter.soulZapCallers(caller))) missing.push(caller);
      }
      if (missing.length > 0) {
        console.log(
          `WARN  these SoulZap callers are NOT allowlisted and cannot be added by this run:\n` +
            missing.map((caller) => `        ${caller}`).join("\n") +
            `\n      Schedule setSoulZapCaller through the timelock for each of them.`
        );
      }
    } else {
      throw new Error(
        `${ADAPTER_KIND} ${adapterAddress} is owned by ${adapterOwner} — neither the deployer ` +
          `(${deployer.address}) nor the timelock (${timelockAddress}). This run cannot wire it.`
      );
    }
  }

  // ──────── phase 5: the timelock batch ────────

  console.log("\n──────── phase 5: the timelock batch ────────");

  // Only the calls whose effect is NOT already on chain. That is what makes a resumed run
  // compute the same operation id as the run it is resuming (nothing landed, so nothing is
  // dropped) and an already-finished run build an empty batch and skip the phase.
  const ops = [];
  if (wantsNewImplementation && !sameValue(before.implementation, newImplementation)) {
    ops.push({
      target: vaultAddress,
      kind: VAULT_KIND,
      fn: "upgradeToAndCall",
      args: [newImplementation, "0x"],
    });
  }
  if (mode === "activate" && !(await vaultAllows(vault, adapterAddress, hasStakeOperator))) {
    ops.push({
      target: vaultAddress,
      kind: VAULT_KIND,
      fn: "setStakeOperator",
      args: [adapterAddress, "true"],
    });
  }
  if (mode === "replace-adapter") {
    if (await vault.isStakeOperator(previousAdapter)) {
      ops.push({
        target: vaultAddress,
        kind: VAULT_KIND,
        fn: "setStakeOperator",
        args: [previousAdapter, "false"],
      });
    }
    if (!(await vault.isStakeOperator(adapterAddress))) {
      ops.push({
        target: vaultAddress,
        kind: VAULT_KIND,
        fn: "setStakeOperator",
        args: [adapterAddress, "true"],
      });
    }
    if (!sameValue(await escrow.adapter(), adapterAddress)) {
      ops.push({
        target: escrowAddress,
        kind: ESCROW_KIND,
        fn: "setAdapter",
        args: [adapterAddress],
      });
    }
  }

  let batch = null;
  let batchFile = null;
  let executed = false;

  if (ops.length === 0) {
    console.log(
      "Every owner-tier call this mode needs is ALREADY in place on chain, so there is nothing\n" +
        "to schedule. Nothing was sent."
    );
  } else {
    batch = buildBatch(ops, process.env.TIMELOCK_SALT_TAG || "");

    console.log(`A batch of ${batch.calls.length} call(s)${batch.tag ? ` [tag ${batch.tag}]` : ""}:`);
    batch.calls.forEach((call, index) => {
      console.log(`  ${index}. ${describeCall(call)}`);
      console.log(`     calldata: ${call.data}`);
    });
    console.log(`  predecessor: ${batch.predecessor}`);
    console.log(`  salt:        ${batch.salt}`);
    console.log(`  id:          ${batch.id}`);

    batchFile = resolveBatchFile(mode);
    fs.writeFileSync(batchFile, JSON.stringify(batchFileContents(batch.calls), null, 2) + "\n");
    console.log(`\nThe same batch, as a file lp-timelock.js reads: ${batchFile}`);
    console.log(
      `  TIMELOCK_ACTION=schedule-batch TIMELOCK_BATCH=${batchFile} \\\n` +
        `    npx hardhat run scripts/lp-timelock.js --network ${network}\n` +
        `  TIMELOCK_ACTION=execute-batch  TIMELOCK_BATCH=${batchFile} \\\n` +
        `    npx hardhat run scripts/lp-timelock.js --network ${network}`
    );

    const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
    const EXECUTOR_ROLE = await timelock.EXECUTOR_ROLE();
    const canPropose = await timelock.hasRole(PROPOSER_ROLE, deployer.address);
    const canExecute = await timelock.hasRole(EXECUTOR_ROLE, deployer.address);
    const drivesItself = !mainnet && canPropose && canExecute;

    if (!drivesItself) {
      // Mainnet, or any chain where this key is not the timelock's proposer and executor. The
      // two transactions belong to the Safe, so this run prints them and stops — with the
      // escrow and the adapter deployed, wired and recorded, and the vault untouched.
      console.log(`\n──────── the two transactions this run does NOT send ────────`);
      console.log(
        mainnet
          ? "This is mainnet: the timelock operation is the multisig's to schedule and execute."
          : `The deploying key holds ${canPropose ? "" : "no PROPOSER_ROLE"}` +
              `${!canPropose && !canExecute ? " and " : ""}` +
              `${canExecute ? "" : "no EXECUTOR_ROLE"} on this timelock.`
      );
      console.log(`Send both to the timelock at ${timelockAddress}, value 0:`);
      console.log(`\n  scheduleBatch calldata (delay ${minDelay}s):`);
      console.log(`  ${encodeScheduleBatch(batch, minDelay)}`);
      console.log(`\n  ...wait out ${minDelay}s, then:`);
      console.log(`\n  executeBatch calldata:`);
      console.log(`  ${encodeExecuteBatch(batch)}`);

      await reportInterim({
        chainId,
        vault,
        vaultAddress,
        before,
        escrow,
        adapter,
        adapterAddress,
        timelockAddress,
        apeBondGuardian,
        purchaseSigner,
        soulZapCallers,
        bonusToken,
        mode,
        previousAdapter,
        assertPositions,
      });

      // The implementation is on chain but the proxy does not run it, which is exactly what
      // `deploy-implementation.js` records as PENDING. Written here for the same reason: the
      // address must survive this process, and `implementation` must keep naming the code the
      // proxy actually runs until the batch has executed.
      if (!sameValue(before.implementation, newImplementation)) {
        const current = pools.readRegistry()[String(chainId)][VAULT_KIND];
        pools.recordDeployment(chainId, VAULT_KIND, current.address, {
          ...stripAddress(current),
          pendingImplementation: newImplementation,
          pendingImplementationTx: implementationTx,
        });
        console.log(
          `\n${VAULT_KIND}.pendingImplementation = ${newImplementation} recorded; ` +
            `"implementation" still names the code the proxy runs.`
        );
      }

      printSummary({
        chainId,
        mode,
        vaultAddress,
        before,
        newImplementation: before.implementation,
        preparedImplementation: sameValue(before.implementation, newImplementation)
          ? null
          : newImplementation,
        implementationTx,
        escrowAddress,
        escrowImplementation,
        adapterAddress,
        previousAdapter,
        timelockAddress,
        batch,
        batchFile,
        executed: false,
      });
      return;
    }

    // The three states an operation can be in, and the one thing to do in each.
    if (await timelock.isOperationDone(batch.id)) {
      console.log(`\nOperation ${batch.id} is already DONE — neither scheduled nor executed again.`);
      executed = true;
    } else {
      if (await timelock.isOperationPending(batch.id)) {
        console.log(`\nOperation ${batch.id} is already PENDING — not scheduled again.`);
      } else {
        await pools.send(
          `Scheduling the batch of ${batch.calls.length} (delay ${minDelay}s)`,
          deployer,
          (o) =>
            timelock
              .connect(deployer)
              .scheduleBatch(
                batch.targets,
                batch.values,
                batch.payloads,
                batch.predecessor,
                batch.salt,
                minDelay,
                o
              )
        );
      }

      console.log(
        `\nWaiting out the timelock. The countdown is CHAIN time — the latest block's own ` +
          `timestamp,\nwhich is what executeBatch compares against — polled every ${waitPollMs}ms.`
      );
      await waitForReady(timelock, batch.id, { pollMs: waitPollMs, timeoutMs: waitTimeoutMs });

      await pools.send(`Executing the batch of ${batch.calls.length}`, deployer, (o) =>
        timelock
          .connect(deployer)
          .executeBatch(batch.targets, batch.values, batch.payloads, batch.predecessor, batch.salt, o)
      );
      executed = true;
    }
  }

  // ──────── phase 6: post-checks ────────

  console.log("\n──────── phase 6: post-deploy verification ────────");
  const failures = [];
  const check = (label, actual, expected) => {
    const ok = sameValue(actual, expected);
    console.log(`${ok ? "OK  " : "FAIL"}  ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
    if (!ok) failures.push(label);
  };

  const after = await implementationOf(vaultAddress);
  check(`${VAULT_KIND}.implementation (ERC-1967 slot)`, after, newImplementation);

  if (mode !== "upgrade-vault" && adapterAddress) {
    check(`${VAULT_KIND}.isStakeOperator(adapter)`, await vault.isStakeOperator(adapterAddress), true);
  }
  if (mode === "replace-adapter") {
    check(
      `${VAULT_KIND}.isStakeOperator(previous adapter ${previousAdapter})`,
      await vault.isStakeOperator(previousAdapter),
      false
    );
  }

  if (escrow && mode !== "upgrade-vault") {
    check(`${ESCROW_KIND}.owner`, await escrow.owner(), timelockAddress);
    check(`${ESCROW_KIND}.pendingOwner`, await escrow.pendingOwner(), hre.ethers.ZeroAddress);
    check(`${ESCROW_KIND}.bonusToken`, await escrow.bonusToken(), bonusToken);
    check(`${ESCROW_KIND}.adapter`, await escrow.adapter(), adapterAddress);
    check(
      `${ESCROW_KIND}.adminSlot (ERC-1967, must be empty for UUPS)`,
      await hre.upgrades.erc1967.getAdminAddress(escrowAddress),
      hre.ethers.ZeroAddress
    );
  }

  if (adapter && mode !== "upgrade-vault") {
    check(`${ADAPTER_KIND}.vault`, await adapter.vault(), vaultAddress);
    check(`${ADAPTER_KIND}.escrow`, await adapter.escrow(), escrowAddress);
    check(`${ADAPTER_KIND}.positionManager`, await adapter.positionManager(), positionManager);
    check(`${ADAPTER_KIND}.token0`, await adapter.token0(), token0);
    check(`${ADAPTER_KIND}.token1`, await adapter.token1(), token1);
    check(`${ADAPTER_KIND}.fee`, await adapter.fee(), fee);
    check(`${ADAPTER_KIND}.owner`, await adapter.owner(), timelockAddress);
    check(`${ADAPTER_KIND}.guardian`, await adapter.guardian(), apeBondGuardian);
    check(`${ADAPTER_KIND}.purchaseSigner`, await adapter.purchaseSigner(), purchaseSigner);
    check(`${ADAPTER_KIND}.depositsPaused`, await adapter.depositsPaused(), false);
    for (const caller of soulZapCallers) {
      check(`${ADAPTER_KIND}.soulZapCallers[${caller}]`, await adapter.soulZapCallers(caller), true);
    }
    if (purchaseSigner === hre.ethers.ZeroAddress) {
      console.log(
        `WARN  ${ADAPTER_KIND}.purchaseSigner is 0 — every depositFor reverts until the\n` +
          `      guardian (${apeBondGuardian}) calls setPurchaseSigner. That is the documented\n` +
          "      default; open the route when the campaign starts."
      );
    }
  }

  // State preservation. An upgrade replaces CODE; every one of these is storage the run must
  // have left exactly where it found it.
  console.log("\n  — state preservation on the live vault —");
  check(`${VAULT_KIND}.owner`, await vault.owner(), before.owner);
  check(`${VAULT_KIND}.pendingOwner`, await vault.pendingOwner(), before.pendingOwner);
  check(`${VAULT_KIND}.guardian`, await vault.guardian(), before.guardian);
  check(`${VAULT_KIND}.operator`, await vault.operator(), before.operator);
  check(`${VAULT_KIND}.zapper`, await vault.zapper(), before.zapper);
  check(`${VAULT_KIND}.twapWindow`, await vault.twapWindow(), before.twapWindow);
  check(
    `${VAULT_KIND}.maxTwapDeviationTicks`,
    await vault.maxTwapDeviationTicks(),
    before.maxTwapDeviationTicks
  );
  check(`${VAULT_KIND}.depositsPaused`, await vault.depositsPaused(), before.depositsPaused);
  check(`${VAULT_KIND}.rebalancePaused`, await vault.rebalancePaused(), before.rebalancePaused);
  for (const tokenId of assertPositions) {
    check(`${VAULT_KIND}.stakerOf(${tokenId})`, await vault.stakerOf(tokenId), before.stakers[tokenId]);
  }
  if (before.distributorImplementation) {
    check(
      `${DISTRIBUTOR_KIND}.implementation (ERC-1967 slot, must be untouched)`,
      await implementationOf(hre.ethers.getAddress(distributorEntry.address)),
      before.distributorImplementation
    );
  } else {
    console.log(
      `WARN  no ${DISTRIBUTOR_KIND} recorded for chain ${chainId}, so its implementation slot ` +
        `was not compared.`
    );
  }

  // ──────── phase 7: record ────────

  console.log("\n──────── phase 7: deployments.json ────────");
  if (executed || ops.length === 0) {
    if (!sameValue(after, before.implementation)) {
      const current = pools.readRegistry()[String(chainId)][VAULT_KIND];
      const extra = stripAddress(current);
      // No longer pending — the proxy runs it.
      delete extra.pendingImplementation;
      delete extra.pendingImplementationBlock;
      extra.implementation = after;
      if (implementationTx) extra.implementationTx = implementationTx;
      pools.recordDeployment(chainId, VAULT_KIND, current.address, extra);
      console.log(`${VAULT_KIND}.implementation -> ${after}`);
    } else {
      console.log(`${VAULT_KIND}.implementation is unchanged (${after}); nothing to rewrite.`);
    }

    if (mode === "replace-adapter" && executed) {
      const current = pools.readRegistry()[String(chainId)][ADAPTER_KIND];
      const extra = stripAddress(current);
      delete extra.pendingAdapter;
      delete extra.pendingAdapterBlock;
      const pendingTx = extra.pendingAdapterTx;
      delete extra.pendingAdapterTx;
      pools.recordDeployment(chainId, ADAPTER_KIND, adapterAddress, {
        ...extra,
        ...(pendingTx ? { deployTx: pendingTx } : {}),
        vault: vaultAddress,
        escrow: escrowAddress,
        guardian: apeBondGuardian,
        purchaseSigner,
        soulZapCallers,
        owner: timelockAddress,
        previousAdapter,
      });
      console.log(`${ADAPTER_KIND} -> ${adapterAddress} (replacing ${previousAdapter})`);
    }
  } else {
    console.log("The batch has not executed, so nothing is recorded as live.");
  }

  printSummary({
    chainId,
    mode,
    vaultAddress,
    before,
    newImplementation: after,
    implementationTx,
    escrowAddress,
    escrowImplementation,
    adapterAddress,
    previousAdapter,
    timelockAddress,
    batch,
    batchFile,
    executed,
  });

  if (failures.length > 0) {
    throw new Error(
      `Post-activation verification failed for: ${failures.join(", ")}. The contracts are ` +
        `deployed and recorded in the registry — fix the state from the operator, or through ` +
        `the timelock for an owner-tier field.`
    );
  }
  console.log("\nAll post-activation checks passed.");
}

/**
 * `isStakeOperator(adapter)` on a vault that may not have the function yet.
 *
 * Before the upgrade the call reverts, and "reverts" is not "false" — it is "this question
 * cannot be asked here". The answer the batch needs is the same either way (the allowlist entry
 * is missing), so the probe result decides whether it is safe to ask at all.
 */
async function vaultAllows(vault, adapterAddress, hasStakeOperator) {
  if (!hasStakeOperator) return false;
  return vault.isStakeOperator(adapterAddress);
}

/** A registry entry minus its `address`, ready to be spread back into `recordDeployment`. */
function stripAddress(entry) {
  const { address, ...rest } = entry;
  return rest;
}

/**
 * Where the `TIMELOCK_BATCH` file is written: the explicit override, else beside the registry
 * this run reads and writes. Putting it there rather than in the working directory means a run
 * driven by a scratch `DEPLOYMENTS_FILE` leaves the file in the scratch directory too.
 */
function resolveBatchFile(mode) {
  if (process.env.LP_APEBOND_BATCH_FILE) return path.resolve(process.env.LP_APEBOND_BATCH_FILE);
  const registryPath = process.env.DEPLOYMENTS_FILE
    ? path.resolve(process.env.DEPLOYMENTS_FILE)
    : path.join(__dirname, "..", "deployments.json");
  return path.join(path.dirname(registryPath), `apebond-${mode}-batch.json`);
}

/**
 * The interim state, asserted on the run that STOPS before the batch: everything this script
 * did send must be in place, and everything the batch would do must NOT be.
 */
async function reportInterim(context) {
  const {
    vault,
    before,
    escrow,
    adapter,
    adapterAddress,
    timelockAddress,
    apeBondGuardian,
    purchaseSigner,
    soulZapCallers,
    bonusToken,
    vaultAddress,
    mode,
    previousAdapter,
    assertPositions,
  } = context;

  console.log("\n──────── the interim state, asserted ────────");
  const problems = [];
  const state = (label, actual, expected) => {
    const ok = sameValue(actual, expected);
    console.log(`${ok ? "OK  " : "FAIL"}  ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
    if (!ok) problems.push(label);
  };

  state("LPStakingVault.implementation (still the OLD one)", await implementationOf(vaultAddress), before.implementation);
  state("LPStakingVault.owner", await vault.owner(), before.owner);
  state("LPStakingVault.guardian", await vault.guardian(), before.guardian);
  state("LPStakingVault.operator", await vault.operator(), before.operator);
  state("LPStakingVault.zapper", await vault.zapper(), before.zapper);
  for (const tokenId of assertPositions) {
    state(`LPStakingVault.stakerOf(${tokenId})`, await vault.stakerOf(tokenId), before.stakers[tokenId]);
  }
  if (escrow && mode !== "upgrade-vault") {
    state("BonusEscrow.owner", await escrow.owner(), timelockAddress);
    state("BonusEscrow.bonusToken", await escrow.bonusToken(), bonusToken);
    // Before the batch the escrow still accepts reservations from the adapter it was pointed at
    // when the run started — the OLD one in a replacement, the new one otherwise, because there
    // the escrow was born naming it.
    state(
      "BonusEscrow.adapter (not re-pointed yet)",
      await escrow.adapter(),
      previousAdapter || adapterAddress
    );
  }
  if (adapter && mode !== "upgrade-vault") {
    state("ApeBondPositionAdapter.owner", await adapter.owner(), timelockAddress);
    state("ApeBondPositionAdapter.guardian", await adapter.guardian(), apeBondGuardian);
    state("ApeBondPositionAdapter.purchaseSigner", await adapter.purchaseSigner(), purchaseSigner);
    for (const caller of soulZapCallers) {
      state(`ApeBondPositionAdapter.soulZapCallers[${caller}]`, await adapter.soulZapCallers(caller), true);
    }
  }

  if (problems.length > 0) {
    throw new Error(`The interim state is wrong for: ${problems.join(", ")}.`);
  }
  console.log(
    "\nThe route is deployed, wired and recorded; the vault is untouched and will stay that way\n" +
      "until the batch above is scheduled and executed."
  );
}

/** One block with every address and transaction hash this run produced or reused. */
function printSummary(context) {
  const {
    chainId,
    mode,
    vaultAddress,
    before,
    newImplementation,
    preparedImplementation = null,
    implementationTx,
    escrowAddress,
    escrowImplementation,
    adapterAddress,
    previousAdapter,
    timelockAddress,
    batch,
    batchFile,
    executed,
  } = context;

  console.log("\n──────── summary ────────");
  console.log(`mode:                 ${mode}`);
  console.log(`LPStakingVault:       ${vaultAddress} (proxy)`);
  console.log(`  implementation:     ${newImplementation}`);
  if (!sameValue(newImplementation, before.implementation)) {
    console.log(`  previous:           ${before.implementation}`);
  }
  if (preparedImplementation) {
    console.log(`  prepared (PENDING): ${preparedImplementation}  <-- the batch installs this`);
  }
  console.log(`  implementation tx:  ${implementationTx || "none sent by this run"}`);
  if (implementationTx) console.log(`  ${pools.explorerTx(chainId, implementationTx)}`);
  if (escrowAddress) {
    console.log(`BonusEscrow:          ${escrowAddress} (proxy)`);
    console.log(`  implementation:     ${escrowImplementation || "unknown"}`);
  }
  if (adapterAddress) {
    console.log(`ApeBondAdapter:       ${adapterAddress}`);
    console.log(`  ${pools.explorerAddress(chainId, adapterAddress)}`);
  }
  if (previousAdapter) console.log(`  replaced:           ${previousAdapter}`);
  console.log(`LPTimelock:           ${timelockAddress}`);
  if (batch) {
    console.log(`batch id:             ${batch.id}`);
    console.log(`batch file:           ${batchFile}`);
    console.log(`batch state:          ${executed ? "EXECUTED" : "NOT SENT BY THIS RUN"}`);
  } else {
    console.log(`batch:                none — every call's effect was already on chain`);
  }
}

module.exports = {
  MODES,
  DEFAULT_MODE,
  DEFAULT_ASSERT_POSITIONS,
  readMode,
  readAssertPositions,
  resolveBatchFile,
  batchFileContents,
  vaultHasStakeOperator,
  implementationOf,
  stripAddress,
};

// `hardhat run` executes this file as the entry point; a `require` from the suites must only
// pick up the exports above.
if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
