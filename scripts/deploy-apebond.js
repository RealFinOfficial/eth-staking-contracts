const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const pools = require("./lib/pools");
const apebond = require("./lib/apebond");
const { deployContract } = require("./lib/proxies");
const { deployImplementation } = require("./deploy-implementation");
const {
  TIMELOCK_KIND,
  TIMELOCK_INTERFACE,
  buildBatch,
  encodeScheduleBatch,
  encodeExecuteBatch,
  describeCall,
} = require("./lp-timelock");

// Activate the ApeBond route on a stack that is ALREADY DEPLOYED — or finish activating it.
//
// ──────────────────────── what this script is ────────────────────────
//
// The route is two contracts beside the vault (B.3 decision document, 2026-10-01, with the
// overrides of 2026-10-05): the `BonusEscrow` proxy, which holds the whole life of a bonus, and
// the `ApeBondPositionAdapter`, the gate SoulZap deposits through, which COMPUTES the bonus from
// the position (no purchase signer exists anywhere). It goes live with ONE timelock batch:
//
//     [vault.upgradeToAndCall(newImplementation, 0x)]   only when the live vault lacks the route
//      vault.setBonusEscrow(escrow)                      the vault reports exits and re-ranges
//      vault.setStakeOperator(adapter, true)             the adapter may stakeFor its buyers
//      escrow.setAdapter(adapter)                        the escrow takes the adapter's reservations
//
// Atomic: until it executes no purchase can be made, and once it executes every exit before a
// cliff forfeits and every re-range scales from the same block.
//
// Two kinds of stack reach this script:
//   - Sepolia test stack #6, deployed by `deploy-lp-staking.js` with LP_APEBOND_ENABLED=1: the
//     vault already carries the route, the escrow and the adapter are already deployed, wired
//     and recorded, and this run builds the three-call batch, drives it, and asserts the link;
//   - a lane-1 vault (mainnet as deployed on 7 Oct, `bonusEscrow = 0`, no stake-operator
//     allowlist): this run deploys a new vault implementation, the escrow and the adapter, wires
//     the adapter, and the batch starts with the upgrade.
//
// ──────────────────────── the phases, in order (mode activate) ────────────────────────
//
//   1. RESOLVE the vault proxy and the `LPTimelock` from `deployments.json`; read the vault's
//      immutables through its own getters; read the "before" state for the preservation check.
//   2. NEW VAULT IMPLEMENTATION (`deployImplementation`), only when the live vault does not answer
//      `isStakeOperator` — probed with a call, because the question is about CODE.
//   3. ESCROW + ADAPTER, unless the registry already records both with code on chain.
//      `BonusEscrow(bonusToken, vault)` + LPProxy `initialize(timelock, adapter = 0)`, then
//      `ApeBondPositionAdapter(positionManager, vault, escrow, owner = deployer, guardian)`.
//   4. WIRING while the deployer owns the adapter: callers, the campaign, the callers permitted
//      for it, then `transferOwnership(timelock)`.
//   5. THE BATCH, built from only the calls whose effect is not on chain yet (a resumed run
//      computes the same id; a finished one an empty batch). On a non-mainnet chain where the
//      deployer holds PROPOSER and EXECUTOR it schedules, waits out `getMinDelay()` in CHAIN
//      time, and executes; anywhere else it prints the Safe calldata and stops.
//   6. POST-CHECKS — the two MANDATORY ones first, because a wrong link fails OPEN silently:
//      `vault.bonusEscrow() == escrow` and `escrow.vault() == vault`; then the allowlist, the
//      escrow's adapter, the adapter's immutables, owner, callers and campaign; then the vault
//      state that must be untouched (owner, roles, zapper, TWAP, pauses, named positions).
//   7. RECORD the vault's new implementation and the escrow's adapter in `deployments.json`.
//
// ──────────────────────── the other modes ────────────────────────
//
//   LP_APEBOND_MODE=replace-adapter  B.3 §5.5: a new adapter against the EXISTING escrow,
//                                    configured and handed to the timelock, then ONE batch
//                                    `vault.setStakeOperator(new, true)`,
//                                    `vault.setStakeOperator(old, false)`, `escrow.setAdapter(new)`.
//                                    Nothing is migrated: the adapter holds configuration only.
//                                    Resumable through `pendingAdapter` on the registry entry.
//   LP_APEBOND_MODE=upgrade-vault    the plain vault upgrade, a one-call batch.
//   LP_APEBOND_MODE=verify           READ-ONLY: the post-checks of phase 6 against the recorded
//                                    pair, no deploy and no transaction.
//
// ──────────────────────── environment ────────────────────────
//
//   LP_APEBOND_MODE              activate | replace-adapter | upgrade-vault | verify (activate)
//   LP_APEBOND_BONUS_TOKEN       the escrow's immutable; one of the vault's two pool tokens
//                                (the vault's token0, read from the proxy)
//   LP_APEBOND_GUARDIAN          the adapter's pause key (the vault's guardian())
//   LP_APEBOND_SOULZAP_CALLERS   comma-separated SoulZap contracts (none)
//   LP_APEBOND_CAMPAIGN_ID …     the campaign: see `readCampaign` in scripts/lib/apebond.js
//   LP_APEBOND_ASSERT_POSITIONS  comma-separated token ids whose staker must read the same
//                                before and after (none)
//   LP_APEBOND_BATCH_FILE        where the batch is filed (apebond-<mode>-batch.json beside the
//                                registry)
//   LP_APEBOND_WAIT_POLL_MS      how often the wait re-reads the chain (5000)
//   LP_APEBOND_WAIT_TIMEOUT_MS   wall-clock ceiling on that wait (4 x minDelay, >= 2 minutes)
//   IMPL_CONTRACT                vault implementation artifact (LPStakingVault); setting it
//                                FORCES phase 2
//   IMPL_UNSAFE_ALLOW_EXTRA      extra `unsafeAllow` flags for `deployImplementation`
//   TIMELOCK_SALT_TAG            distinguishes two otherwise identical batches
//   DEPLOYMENTS_FILE             redirects the registry, like every other script here
//   CONFIRM=yes                  required on mainnet
//
//     LP_APEBOND_SOULZAP_CALLERS=0xRouter LP_APEBOND_CAMPAIGN_ID=campaign-1 \
//       LP_APEBOND_HALF_WIDTH_TICKS=1200 LP_APEBOND_CLIFF_SECONDS=300 LP_APEBOND_BONUS_BPS=1000 \
//       npx hardhat run scripts/deploy-apebond.js --network sepolia

const VAULT_KIND = "LPStakingVault";
const DISTRIBUTOR_KIND = "RewardsDistributor";
const { ESCROW_KIND, ADAPTER_KIND, ESCROW_ABI, ADAPTER_ABI, sameValue } = apebond;

const MODES = ["activate", "replace-adapter", "upgrade-vault", "verify"];
const DEFAULT_MODE = "activate";

const DEFAULT_WAIT_POLL_MS = 5000;
const MIN_WAIT_TIMEOUT_MS = 120_000;
const WAIT_TIMEOUT_DELAY_FACTOR = 4;

/** ERC-1967 implementation slot: keccak256("eip1967.proxy.implementation") - 1. */
const ERC1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

/** The vault's view surface this script reads. */
const VAULT_ABI = [
  "function positionManager() view returns (address)",
  "function pool() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
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
  "function bonusEscrow() view returns (address)",
];

// ──────────────────────── small helpers ────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The mode, read strictly: a typo must not silently run the full activation. */
function readMode() {
  const raw = process.env.LP_APEBOND_MODE;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MODE;
  if (!MODES.includes(raw)) throw new Error(`LP_APEBOND_MODE must be one of ${MODES.join(", ")} — got ${raw}`);
  return raw;
}

/** The token ids whose staker must survive, from LP_APEBOND_ASSERT_POSITIONS. */
function readAssertPositions() {
  const raw = process.env.LP_APEBOND_ASSERT_POSITIONS;
  if (raw === undefined || raw.trim() === "") return [];
  return raw.split(",").map((entry, index) => {
    const value = entry.trim();
    if (!/^[0-9]+$/.test(value)) throw new Error(`LP_APEBOND_ASSERT_POSITIONS entry ${index} is not a token id: ${value}`);
    return value;
  });
}

/** The ERC-1967 implementation slot of `proxy`, read from storage rather than trusted. */
async function implementationOf(proxy) {
  const word = await hre.ethers.provider.getStorage(proxy, ERC1967_IMPLEMENTATION_SLOT);
  return hre.ethers.getAddress("0x" + word.slice(-40));
}

/**
 * Whether the implementation the proxy RUNS carries the stake-operator allowlist (and with it,
 * on every vault that has it, the escrow hooks). A call that returns is proof; a revert is proof
 * it does not.
 */
async function vaultHasRoute(vaultAddress) {
  const probe = new hre.ethers.Contract(vaultAddress, VAULT_ABI, hre.ethers.provider);
  try {
    await probe.isStakeOperator(hre.ethers.ZeroAddress);
    await probe.bonusEscrow();
    return true;
  } catch {
    return false;
  }
}

async function requireCode(label, address) {
  const code = await hre.ethers.provider.getCode(address);
  if (code === "0x") throw new Error(`No contract code at ${label} ${address}`);
}

async function hasCode(address) {
  return (await hre.ethers.provider.getCode(address)) !== "0x";
}

/** A registry entry minus its `address`, ready to be spread back into `recordDeployment`. */
function stripAddress(entry) {
  const { address, ...rest } = entry;
  return rest;
}

/** Where the batch file goes: the override, else beside the registry this run writes. */
function resolveBatchFile(mode) {
  if (process.env.LP_APEBOND_BATCH_FILE) return path.resolve(process.env.LP_APEBOND_BATCH_FILE);
  const registryPath = process.env.DEPLOYMENTS_FILE
    ? path.resolve(process.env.DEPLOYMENTS_FILE)
    : path.join(__dirname, "..", "deployments.json");
  return path.join(path.dirname(registryPath), `apebond-${mode}-batch.json`);
}

/**
 * Waits until the timelock reports the operation READY, measured against the CHAIN's latest
 * block timestamp — what `executeBatch` compares against. The wall-clock ceiling is a liveness
 * guard: on expiry the operation is still scheduled and the caller is told how to finish.
 */
async function waitForReady(timelock, id, { pollMs, timeoutMs }) {
  const startedAt = Date.now();
  for (;;) {
    if (await timelock.isOperationReady(id)) return;
    const readyAt = await timelock.getTimestamp(id);
    if (readyAt === 0n) throw new Error(`Operation ${id} is no longer scheduled — it was cancelled`);
    const block = await hre.ethers.provider.getBlock("latest");
    console.log(
      `  waiting: ${Number(readyAt) - block.timestamp}s of CHAIN time left ` +
        `(block ${block.number}, chain timestamp ${block.timestamp}, readyAt ${readyAt})`
    );
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(
        `The batch did not become executable within ${Math.round(timeoutMs / 1000)}s of wall clock. ` +
          `It IS scheduled (id ${id}): re-run this script to resume, or execute it by hand once the ` +
          `chain's timestamp passes ${readyAt}.`
      );
    }
    await sleep(pollMs);
  }
}

// ──────────────────────── the run ────────────────────────

async function main() {
  const chainId = await pools.chainId();
  const mainnet = pools.isMainnet(chainId);
  const network = hre.network.name;
  const mode = readMode();
  const readOnly = mode === "verify";
  const deployer = readOnly ? null : await pools.getSigner();

  // ──────── phase 1: resolve the live stack ────────

  const registry = pools.readRegistry()[String(chainId)] || {};
  const vaultEntry = registry[VAULT_KIND];
  const timelockEntry = registry[TIMELOCK_KIND];
  if (!vaultEntry || !timelockEntry) {
    throw new Error(
      `Chain ${chainId} has no ${!vaultEntry ? VAULT_KIND : TIMELOCK_KIND} entry in the deployment ` +
        `registry. This script works on a stack that is ALREADY deployed and recorded; deploy it with ` +
        `scripts/deploy-lp-staking.js first, or point DEPLOYMENTS_FILE at the registry that records it.`
    );
  }
  const vaultAddress = hre.ethers.getAddress(vaultEntry.address);
  const timelockAddress = hre.ethers.getAddress(timelockEntry.address);
  await requireCode(`${VAULT_KIND} proxy`, vaultAddress);
  await requireCode(TIMELOCK_KIND, timelockAddress);

  const vault = new hre.ethers.Contract(vaultAddress, VAULT_ABI, hre.ethers.provider);
  const timelock = new hre.ethers.Contract(timelockAddress, TIMELOCK_INTERFACE, hre.ethers.provider);

  const positionManager = hre.ethers.getAddress(await vault.positionManager());
  const token0 = hre.ethers.getAddress(await vault.token0());
  const token1 = hre.ethers.getAddress(await vault.token1());

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
  const assertPositions = readAssertPositions();
  for (const tokenId of assertPositions) before.stakers[tokenId] = hre.ethers.getAddress(await vault.stakerOf(tokenId));
  const distributorEntry = registry[DISTRIBUTOR_KIND];
  if (distributorEntry) before.distributorImplementation = await implementationOf(distributorEntry.address);

  if (!sameValue(before.owner, timelockAddress)) {
    throw new Error(
      `${VAULT_KIND} ${vaultAddress} is owned by ${before.owner}, but the registry records the timelock as ` +
        `${timelockAddress}. Every call this script schedules is owner-tier.`
    );
  }

  const escrowEntry = registry[ESCROW_KIND];
  const adapterEntry = registry[ADAPTER_KIND];
  const bonusToken = apebond.readAddress(
    "LP_APEBOND_BONUS_TOKEN",
    escrowEntry && escrowEntry.bonusToken ? escrowEntry.bonusToken : token0
  );
  if (!sameValue(bonusToken, token0) && !sameValue(bonusToken, token1)) {
    throw new Error(`LP_APEBOND_BONUS_TOKEN ${bonusToken} is neither of the vault's pool tokens (${token0}, ${token1})`);
  }
  const apeBondGuardian = apebond.readAddress("LP_APEBOND_GUARDIAN", before.guardian);
  const soulZapCallers = apebond.readAddressList("LP_APEBOND_SOULZAP_CALLERS");
  const facts = await apebond.readPoolFacts(vaultAddress, bonusToken);
  const campaign = apebond.readCampaign(facts);

  const minDelay = await timelock.getMinDelay();
  const waitPollMs = Number(process.env.LP_APEBOND_WAIT_POLL_MS || DEFAULT_WAIT_POLL_MS);
  const waitTimeoutMs = Number(
    process.env.LP_APEBOND_WAIT_TIMEOUT_MS ||
      Math.max(MIN_WAIT_TIMEOUT_MS, Number(minDelay) * 1000 * WAIT_TIMEOUT_DELAY_FACTOR)
  );

  console.log(`ApeBond route on an existing stack (mode: ${mode})`);
  console.log(`Network:            ${network} (chain ${chainId})`);
  if (deployer) console.log(`Deployer:           ${deployer.address}`);
  console.log(`LPStakingVault:     ${vaultAddress} (proxy, implementation ${before.implementation})`);
  console.log(`LPTimelock:         ${timelockAddress} (minDelay ${minDelay}s, read from the contract)`);
  console.log(`Bonus token:        ${bonusToken} (${facts.bonusSymbol})`);
  console.log(`Adapter guardian:   ${apeBondGuardian}${sameValue(apeBondGuardian, before.guardian) ? " (= the vault's guardian)" : ""}`);
  console.log(`SoulZap callers:    ${soulZapCallers.length > 0 ? soulZapCallers.join(", ") : "none"}`);
  console.log(`Campaign:           ${apebond.describeCampaign(campaign, facts)}`);
  console.log(`Positions asserted: ${assertPositions.length > 0 ? assertPositions.join(", ") : "none"}`);

  const hasRoute = await vaultHasRoute(vaultAddress);
  console.log(
    `\nThe live vault implementation ${hasRoute ? "HAS" : "does NOT have"} the ApeBond route ` +
      `(probed with isStakeOperator / bonusEscrow through the proxy).`
  );

  // ──────── verify: read-only ────────

  if (readOnly) {
    if (!escrowEntry || !adapterEntry) throw new Error(`Chain ${chainId} records no ${ESCROW_KIND} / ${ADAPTER_KIND} pair to verify`);
    const failures = [];
    const check = reporter(failures);
    await apebond.checkRoute(check, {
      vaultAddress,
      escrowAddress: hre.ethers.getAddress(escrowEntry.address),
      adapterAddress: hre.ethers.getAddress(adapterEntry.address),
      timelockAddress,
      bonusToken,
      guardian: process.env.LP_APEBOND_GUARDIAN ? apeBondGuardian : null,
      soulZapCallers,
      campaign,
    });
    finish(failures, "verification");
    return;
  }

  pools.requireConfirmation(chainId, `run the ApeBond route (mode ${mode}) on chain ${chainId}`);
  if (mainnet) console.log("\nEvery transaction below needs a Ledger confirmation.");

  // ──────── phase 2: a new vault implementation, when the live one lacks the route ────────

  const implContract = process.env.IMPL_CONTRACT || undefined;
  const unsafeAllowExtra = (process.env.IMPL_UNSAFE_ALLOW_EXTRA || "")
    .split(",")
    .map((flag) => flag.trim())
    .filter((flag) => flag.length > 0);

  let wantsNewImplementation;
  if (mode === "upgrade-vault") wantsNewImplementation = true;
  else if (mode === "replace-adapter") wantsNewImplementation = false;
  else wantsNewImplementation = Boolean(implContract) || !hasRoute;

  if (mode === "replace-adapter" && !hasRoute) {
    throw new Error(
      `Mode replace-adapter needs a vault that already carries the route, and ${vaultAddress} does not. ` +
        `Run the default mode (LP_APEBOND_MODE=activate) first.`
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
    if (sameValue(newImplementation, before.implementation) && !hasRoute) {
      throw new Error(
        `The ${implContract || VAULT_KIND} in this build compiles to the implementation the proxy ALREADY ` +
          `RUNS (${newImplementation}), which lacks the route. Check out the branch that carries it and re-run.`
      );
    }
  } else {
    console.log("\n──────── phase 2: SKIPPED — the live vault already carries the route ────────");
  }

  // ──────── phase 3: the escrow and the adapter ────────

  let escrowAddress = escrowEntry ? hre.ethers.getAddress(escrowEntry.address) : null;
  let adapterAddress = adapterEntry ? hre.ethers.getAddress(adapterEntry.address) : null;
  let previousAdapter = null;

  if (mode === "upgrade-vault") {
    console.log("\n──────── phase 3: SKIPPED (mode upgrade-vault) ────────");
  } else if (mode === "replace-adapter") {
    if (!escrowEntry || !adapterEntry) {
      throw new Error(`Mode replace-adapter needs a recorded ${ESCROW_KIND} and ${ADAPTER_KIND} for chain ${chainId}`);
    }
    await requireCode(ESCROW_KIND, escrowAddress);
    previousAdapter = adapterAddress;
    if (adapterEntry.pendingAdapter) {
      adapterAddress = hre.ethers.getAddress(adapterEntry.pendingAdapter);
      await requireCode(`${ADAPTER_KIND} (pending)`, adapterAddress);
      console.log(`\n──────── phase 3: RESUMING a replacement — the pending adapter ${adapterAddress} ────────`);
    } else {
      console.log(`\n──────── phase 3: a replacement adapter for ${previousAdapter} ────────`);
      const replacement = await deployContract(
        ADAPTER_KIND,
        [positionManager, vaultAddress, escrowAddress, deployer.address, apeBondGuardian],
        deployer
      );
      adapterAddress = replacement.address;
      // Recorded as PENDING before it is activated: an interrupted replacement resumes rather
      // than deploying a second adapter.
      pools.recordDeployment(chainId, ADAPTER_KIND, adapterEntry.address, {
        ...stripAddress(adapterEntry),
        pendingAdapter: adapterAddress,
        pendingAdapterBlock: replacement.receipt.blockNumber,
        pendingAdapterTx: replacement.tx.hash,
      });
    }
  } else {
    const escrowLive = Boolean(escrowEntry && (await hasCode(escrowEntry.address)));
    const adapterLive = Boolean(adapterEntry && (await hasCode(adapterEntry.address)));
    if (escrowLive && adapterLive) {
      const recordedVault = await new hre.ethers.Contract(escrowAddress, ESCROW_ABI, hre.ethers.provider).vault();
      if (!sameValue(recordedVault, vaultAddress)) {
        throw new Error(
          `The recorded ${ESCROW_KIND} ${escrowAddress} belongs to vault ${recordedVault}, not ${vaultAddress}. ` +
            `It cannot be linked here; remove the stale entries and re-run to deploy a new pair.`
        );
      }
      console.log(`\n──────── phase 3: SKIPPED — ${ESCROW_KIND} ${escrowAddress} and ${ADAPTER_KIND} ${adapterAddress} are live ────────`);
    } else if (escrowLive !== adapterLive) {
      throw new Error(
        `The registry for chain ${chainId} records a live ${escrowLive ? ESCROW_KIND : ADAPTER_KIND} but no live ` +
          `${escrowLive ? ADAPTER_KIND : ESCROW_KIND}. Remove the stray entry and re-run.`
      );
    } else {
      console.log(`\n──────── phase 3: ${ESCROW_KIND} + ${ADAPTER_KIND} ────────`);
      const deployed = await apebond.deployEscrowAndAdapter({
        chainId,
        deployer,
        vaultAddress,
        timelockAddress,
        positionManager,
        bonusToken,
        guardian: apeBondGuardian,
      });
      escrowAddress = deployed.escrowDeploy.address;
      adapterAddress = deployed.adapterDeploy.address;
    }
  }

  // ──────── phase 4: wiring, while the deployer still owns the adapter ────────

  if (mode !== "upgrade-vault") {
    console.log("\n──────── phase 4: the adapter's callers, campaign and handover ────────");
    await apebond.wireAdapter({
      chainId,
      deployer,
      adapterAddress,
      timelockAddress,
      soulZapCallers,
      campaign,
      // a pending replacement is not the recorded adapter yet; it is recorded in phase 7
    });
  }

  // ──────── phase 5: the timelock batch ────────

  console.log("\n──────── phase 5: the timelock batch ────────");
  let ops = [];
  if (mode === "activate") {
    ops = await apebond.linkOps({
      vaultAddress,
      escrowAddress,
      adapterAddress,
      upgradeTo: sameValue(before.implementation, newImplementation) ? null : newImplementation,
      vaultHasRoute: hasRoute,
    });
  } else if (mode === "upgrade-vault") {
    if (!sameValue(before.implementation, newImplementation)) {
      ops.push({ target: vaultAddress, kind: VAULT_KIND, fn: "upgradeToAndCall", args: [newImplementation, "0x"] });
    }
  } else {
    // replace-adapter, in the order of B.3 §5.5: the new adapter gains the right first, the old
    // one loses it, the escrow follows — one operation, so there is no moment with two adapters
    // or with none.
    if (!(await vault.isStakeOperator(adapterAddress))) {
      ops.push({ target: vaultAddress, kind: VAULT_KIND, fn: "setStakeOperator", args: [adapterAddress, "true"] });
    }
    if (await vault.isStakeOperator(previousAdapter)) {
      ops.push({ target: vaultAddress, kind: VAULT_KIND, fn: "setStakeOperator", args: [previousAdapter, "false"] });
    }
    const escrow = new hre.ethers.Contract(escrowAddress, ESCROW_ABI, hre.ethers.provider);
    if (!sameValue(await escrow.adapter(), adapterAddress)) {
      ops.push({ target: escrowAddress, kind: ESCROW_KIND, fn: "setAdapter", args: [adapterAddress] });
    }
  }

  let batch = null;
  let batchFile = null;
  let executed = false;
  if (ops.length === 0) {
    console.log("Every owner-tier call this mode needs is ALREADY in place on chain; nothing was sent.");
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
    fs.writeFileSync(batchFile, JSON.stringify(apebond.batchFileContents(batch.calls), null, 2) + "\n");
    console.log(`\nThe same batch, as a file lp-timelock.js reads: ${batchFile}`);
    console.log(
      `  TIMELOCK_ACTION=schedule-batch TIMELOCK_BATCH=${batchFile} \\\n` +
        `    npx hardhat run scripts/lp-timelock.js --network ${network}\n` +
        `  TIMELOCK_ACTION=execute-batch  TIMELOCK_BATCH=${batchFile} \\\n` +
        `    npx hardhat run scripts/lp-timelock.js --network ${network}`
    );

    const canPropose = await timelock.hasRole(await timelock.PROPOSER_ROLE(), deployer.address);
    const canExecute = await timelock.hasRole(await timelock.EXECUTOR_ROLE(), deployer.address);
    if (mainnet || !canPropose || !canExecute) {
      console.log(`\n──────── the two transactions this run does NOT send ────────`);
      console.log(
        mainnet
          ? "This is mainnet: the timelock operation is the multisig's to schedule and execute."
          : `The deploying key lacks ${canPropose ? "" : "PROPOSER_ROLE "}${canExecute ? "" : "EXECUTOR_ROLE "}on this timelock.`
      );
      console.log(`Send both to the timelock at ${timelockAddress}, value 0:`);
      console.log(`\n  scheduleBatch calldata (delay ${minDelay}s):\n  ${encodeScheduleBatch(batch, minDelay)}`);
      console.log(`\n  ...wait out ${minDelay}s, then executeBatch calldata:\n  ${encodeExecuteBatch(batch)}`);
      if (!sameValue(before.implementation, newImplementation)) {
        const current = pools.readRegistry()[String(chainId)][VAULT_KIND];
        pools.recordDeployment(chainId, VAULT_KIND, current.address, {
          ...stripAddress(current),
          pendingImplementation: newImplementation,
          pendingImplementationTx: implementationTx,
        });
      }
      console.log(
        "\nThe pair is deployed, wired and recorded; the vault is untouched until the batch executes.\n" +
          "Re-run this script (or LP_APEBOND_MODE=verify) afterwards to assert the link."
      );
      return;
    }

    if (await timelock.isOperationDone(batch.id)) {
      console.log(`\nOperation ${batch.id} is already DONE.`);
      executed = true;
    } else {
      if (await timelock.isOperationPending(batch.id)) {
        console.log(`\nOperation ${batch.id} is already PENDING — not scheduled again.`);
      } else {
        await pools.send(`Scheduling the batch of ${batch.calls.length} (delay ${minDelay}s)`, deployer, (o) =>
          timelock
            .connect(deployer)
            .scheduleBatch(batch.targets, batch.values, batch.payloads, batch.predecessor, batch.salt, minDelay, o)
        );
      }
      console.log(`\nWaiting out the timelock in CHAIN time, polled every ${waitPollMs}ms.`);
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
  const check = reporter(failures);
  const after = await implementationOf(vaultAddress);
  check(`${VAULT_KIND}.implementation (ERC-1967 slot)`, after, newImplementation);

  if (mode !== "upgrade-vault") {
    await apebond.checkRoute(check, {
      vaultAddress,
      escrowAddress,
      adapterAddress,
      timelockAddress,
      bonusToken,
      guardian: apeBondGuardian,
      soulZapCallers,
      campaign,
    });
  }
  if (mode === "replace-adapter") {
    check(`${VAULT_KIND}.isStakeOperator(previous adapter ${previousAdapter})`, await vault.isStakeOperator(previousAdapter), false);
  }

  console.log("\n  — state preservation on the live vault —");
  check(`${VAULT_KIND}.owner`, await vault.owner(), before.owner);
  check(`${VAULT_KIND}.pendingOwner`, await vault.pendingOwner(), before.pendingOwner);
  check(`${VAULT_KIND}.guardian`, await vault.guardian(), before.guardian);
  check(`${VAULT_KIND}.operator`, await vault.operator(), before.operator);
  check(`${VAULT_KIND}.zapper`, await vault.zapper(), before.zapper);
  check(`${VAULT_KIND}.twapWindow`, await vault.twapWindow(), before.twapWindow);
  check(`${VAULT_KIND}.maxTwapDeviationTicks`, await vault.maxTwapDeviationTicks(), before.maxTwapDeviationTicks);
  check(`${VAULT_KIND}.depositsPaused`, await vault.depositsPaused(), before.depositsPaused);
  check(`${VAULT_KIND}.rebalancePaused`, await vault.rebalancePaused(), before.rebalancePaused);
  for (const tokenId of assertPositions) {
    check(`${VAULT_KIND}.stakerOf(${tokenId})`, await vault.stakerOf(tokenId), before.stakers[tokenId]);
  }
  if (before.distributorImplementation) {
    check(
      `${DISTRIBUTOR_KIND}.implementation (must be untouched)`,
      await implementationOf(distributorEntry.address),
      before.distributorImplementation
    );
  }

  // ──────── phase 7: record ────────

  console.log("\n──────── phase 7: deployments.json ────────");
  if (executed || ops.length === 0) {
    const chainRegistry = pools.readRegistry()[String(chainId)];
    if (!sameValue(after, before.implementation)) {
      const extra = stripAddress(chainRegistry[VAULT_KIND]);
      delete extra.pendingImplementation;
      delete extra.pendingImplementationTx;
      delete extra.pendingImplementationBlock;
      extra.implementation = after;
      if (implementationTx) extra.implementationTx = implementationTx;
      pools.recordDeployment(chainId, VAULT_KIND, vaultAddress, extra);
    }
    if (mode !== "upgrade-vault") {
      const vaultExtra = stripAddress(pools.readRegistry()[String(chainId)][VAULT_KIND]);
      pools.recordDeployment(chainId, VAULT_KIND, vaultAddress, { ...vaultExtra, bonusEscrow: escrowAddress });
      const escrow = new hre.ethers.Contract(escrowAddress, ESCROW_ABI, hre.ethers.provider);
      const escrowCurrent = pools.readRegistry()[String(chainId)][ESCROW_KIND];
      pools.recordDeployment(chainId, ESCROW_KIND, escrowCurrent.address, {
        ...stripAddress(escrowCurrent),
        adapter: hre.ethers.getAddress(await escrow.adapter()),
      });
    }
    if (mode === "replace-adapter") await recordReplacement({ chainId, adapterAddress, previousAdapter, soulZapCallers, campaign });
  } else {
    console.log("The batch has not executed, so nothing is recorded as live.");
  }

  console.log("\n──────── summary ────────");
  console.log(`mode:                 ${mode}`);
  console.log(`LPStakingVault:       ${vaultAddress} (implementation ${after})`);
  if (escrowAddress) console.log(`BonusEscrow:          ${escrowAddress} (proxy)`);
  if (adapterAddress) console.log(`ApeBondAdapter:       ${adapterAddress}`);
  if (previousAdapter) console.log(`  replaced:           ${previousAdapter}`);
  console.log(`LPTimelock:           ${timelockAddress}`);
  console.log(batch ? `batch:                ${batch.id} (${executed ? "EXECUTED" : "NOT SENT"})` : "batch:                none needed");

  finish(failures, "post-activation verification");
}

/** `check(label, actual, expected)` printing OK / FAIL and collecting failures. */
function reporter(failures) {
  return (label, actual, expected) => {
    const ok = sameValue(actual, expected);
    console.log(`${ok ? "OK  " : "FAIL"}  ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
    if (!ok) failures.push(label);
  };
}

function finish(failures, what) {
  if (failures.length > 0) {
    throw new Error(`The ${what} failed for: ${failures.join(", ")}.`);
  }
  console.log(`\nAll ${what} checks passed.`);
}

/**
 * `replace-adapter`'s record, once the batch's effects are on chain: the adapter entry is REBUILT
 * for the new adapter (its own deploy transaction and block, promoted from `pendingAdapter*`), and
 * names the adapter it replaced. The escrow entry's `adapter` was re-pointed just before.
 */
async function recordReplacement({ chainId, adapterAddress, previousAdapter, soulZapCallers, campaign }) {
  const current = pools.readRegistry()[String(chainId)][ADAPTER_KIND];
  const pending = sameValue(current.pendingAdapter, adapterAddress);
  const adapter = new hre.ethers.Contract(adapterAddress, ADAPTER_ABI, hre.ethers.provider);
  const callers = [];
  for (const caller of soulZapCallers) if (await adapter.soulZapCallers(caller)) callers.push(caller);
  const campaigns = [];
  if (campaign) {
    const permitted = [];
    for (const caller of soulZapCallers) if (await adapter.campaignCallers(campaign.id, caller)) permitted.push(caller);
    campaigns.push(apebond.campaignRecord(campaign, permitted));
  }
  pools.recordDeployment(chainId, ADAPTER_KIND, adapterAddress, {
    ...(pending && current.pendingAdapterTx ? { deployTx: current.pendingAdapterTx } : {}),
    ...(pending && current.pendingAdapterBlock !== undefined ? { block: current.pendingAdapterBlock } : {}),
    vault: hre.ethers.getAddress(await adapter.vault()),
    escrow: hre.ethers.getAddress(await adapter.escrow()),
    positionManager: hre.ethers.getAddress(await adapter.positionManager()),
    bonusToken: current.bonusToken,
    token0: hre.ethers.getAddress(await adapter.token0()),
    token1: hre.ethers.getAddress(await adapter.token1()),
    fee: Number(await adapter.fee()),
    tickSpacing: Number(await adapter.tickSpacing()),
    guardian: hre.ethers.getAddress(await adapter.guardian()),
    soulZapCallers: callers,
    campaigns,
    owner: hre.ethers.getAddress(await adapter.owner()),
    previousAdapter,
  });
}

module.exports = { MODES, DEFAULT_MODE, readMode, readAssertPositions, resolveBatchFile, vaultHasRoute, implementationOf, stripAddress };

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
