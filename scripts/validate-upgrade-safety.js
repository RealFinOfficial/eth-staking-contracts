const fs = require("fs");
const path = require("path");

const hre = require("hardhat");

// Upgrade-safety gate for the ten UUPS implementations: the five LP proxies (LPStakingVault,
// RewardsDistributor, LPEpochRegistry, TokenOverture, LPZapper), the ApeBond BonusEscrow, the
// three staking v3 proxies (WeightedStakingPoolV3, V3BonusVault, StakingMigrator) and the
// transition's TransitionReceiver (2026-11-20).
// Runs in CI on every push, with no secrets and no network access of its own.
//
// Two questions, and they are not the same question:
//
//   1. **Is this implementation safe to put behind a proxy at all?**
//      `upgrades.validateImplementation` answers it from the build info alone — no RPC, no
//      deployed contract, no manifest. It rejects the whole class of proxy-hostile code:
//      `selfdestruct`, `delegatecall`, a constructor that writes state, an uninitialized
//      immutable, a missing `_authorizeUpgrade`. This half always runs.
//
//   2. **Is this implementation a legal successor to the one that is DEPLOYED?**
//      `upgrades.validateUpgrade` answers it by comparing storage layouts against the
//      committed `.openzeppelin/<network>.json` manifest — the file the deploy script wrote
//      with `forceImport`. It catches a reordered field, a changed type, a deleted variable:
//      the mistakes that make `claimed[token][user]` or `stakers[tokenId]` read as something
//      else after an upgrade. This half runs only for networks whose manifest is checked in,
//      because that manifest IS the baseline.
//
//   3. **Is this implementation a legal successor of EVERY layout ever recorded for it?**
//      Network-free, always on: every committed `.openzeppelin/*.json` manifest keeps the storage
//      layout of each implementation it ever saw, keyed by its ERC-7201 namespace. A contract
//      with `recordedLayouts: true` is graded against each of those layouts with
//      `getStorageUpgradeReport`, offline. This is how the StakingMigrator's appended transition
//      fields (2026-11-20) are checked against all three implementations stack #6 has run.
//
// Four of the six carry `immutable` protocol references set in the implementation constructor
// (the vault's market, the registry's distributor, the zapper's market, the escrow's bonus
// token and vault), which the
// plugin flags by default — `unsafeAllow: ['constructor', 'state-variable-immutable']` is the
// spec's own deliberate exception (`docs/specs/01-contracts.md` §1), not a silencer. The same
// list is used by `lib/proxies.js` (the deploy path) and `deploy-implementation.js`; the three
// must never drift apart.
//
//     npx hardhat run scripts/validate-upgrade-safety.js
//     npx hardhat run scripts/validate-upgrade-safety.js --network sepolia
//     npm run validate:upgrades
//
// The default (in-process `hardhat` network) does half 1 for all five contracts and reports
// which manifests exist. Naming a network adds half 2 against that network's manifest.

const UNSAFE_ALLOW = ["constructor", "state-variable-immutable"];

/**
 * Constructor arguments only have to be SHAPED right: the plugin uses them to build the
 * deployment bytecode it validates, and never sends it anywhere. Real addresses would say
 * something untrue about which deployment this checks.
 */
const DUMMY = {
  address: "0x0000000000000000000000000000000000000001",
  fee: 3000,
};

const CONTRACTS = [
  {
    name: "RewardsDistributor",
    // no constructor arguments: every reward token is proxy storage
    constructorArgs: [],
  },
  {
    name: "LPEpochRegistry",
    // (distributor)
    constructorArgs: [DUMMY.address],
  },
  {
    name: "TokenOverture",
    // no constructor arguments
    constructorArgs: [],
  },
  {
    name: "LPStakingVault",
    // (positionManager, pool, token0, token1, fee, swapRouter)
    constructorArgs: [
      DUMMY.address,
      DUMMY.address,
      DUMMY.address,
      "0x0000000000000000000000000000000000000002",
      DUMMY.fee,
      DUMMY.address,
    ],
  },
  {
    name: "BonusEscrow",
    // (bonusToken, vault) — the ApeBond escrow (on Sepolia test stack #6 since 6 Oct, and part
    // of the mainnet launch deploy since the decision of 14 Oct 2026). The constructor reads the
    // vault's pool tokens, which only matters when it runs; `validateImplementation` never runs it.
    constructorArgs: [DUMMY.address, "0x0000000000000000000000000000000000000002"],
  },
  {
    name: "LPZapper",
    // (vault, positionManager, pool, token0, token1, fee, swapRouter, usdc, asset). The
    // constructor reads the pool triple from chain, so `validateImplementation` (which never
    // deploys) is the only half that can use dummies — it does not run the constructor.
    constructorArgs: [
      DUMMY.address,
      DUMMY.address,
      DUMMY.address,
      DUMMY.address,
      "0x0000000000000000000000000000000000000002",
      DUMMY.fee,
      DUMMY.address,
      DUMMY.address,
      "0x0000000000000000000000000000000000000002",
    ],
  },
  // The staking v3 proxies (scripts/deploy-staking-v3.js). `newKind: true`: their layout half
  // runs only on a network whose deployments.json records the kind, because before their first
  // deploy the manifest holds no proxy of theirs to grade against.
  {
    name: "WeightedStakingPoolV3",
    // no constructor arguments: every value is proxy storage
    constructorArgs: [],
    newKind: true,
  },
  {
    name: "V3BonusVault",
    // no constructor arguments
    constructorArgs: [],
    newKind: true,
  },
  {
    name: "StakingMigrator",
    // (lpVault, usdc, asset). The constructor reads the vault's market; never run here. Its one
    // `delegatecall` (to the delivery module its own constructor creates) is allowed by the
    // `@custom:oz-upgrades-unsafe-allow delegatecall` annotation on that function, not here.
    constructorArgs: [DUMMY.address, DUMMY.address, "0x0000000000000000000000000000000000000002"],
    newKind: true,
    namespace: "erc7201:real.staking.storage.StakingMigrator",
    recordedLayouts: true,
  },
  {
    name: "TransitionReceiver",
    // (migrator). The constructor reads the migrator's asset, usdc and lpVault; never run here.
    constructorArgs: [DUMMY.address],
    newKind: true,
    namespace: "erc7201:real.staking.storage.TransitionReceiver",
    recordedLayouts: true,
  },
];

const MANIFEST_DIR = path.join(__dirname, "..", ".openzeppelin");

/**
 * The COMMITTED manifest for the selected network, if there is one.
 *
 * `unknown-<chainId>.json` is deliberately never used: those files are written by every fork
 * run and every ephemeral node, they are gitignored, and the proxies they record do not exist
 * on the network this process is talking to. Grading a new layout against them would compare
 * against whatever the last local test run happened to deploy.
 */
function manifestFor(networkName) {
  const named = path.join(MANIFEST_DIR, `${networkName}.json`);
  return fs.existsSync(named) ? named : null;
}

/** The registry kinds deployments.json records for `chainId` (an empty set when none). */
function readRecordedKinds(chainId) {
  const file = path.join(__dirname, "..", "deployments.json");
  if (!fs.existsSync(file)) return new Set();
  const entry = JSON.parse(fs.readFileSync(file, "utf8"))[String(chainId)] || {};
  return new Set(Object.keys(entry));
}

/**
 * Half 3: grades each `recordedLayouts` contract against every layout the committed manifests
 * recorded under its namespace. Offline: the layouts are in the manifests, the new one in the
 * build info.
 * @returns {Promise<Array<{name: string, address: string, ok: boolean, line: string}>>}
 */
async function checkRecordedLayouts(contracts = CONTRACTS, manifestDir = MANIFEST_DIR) {
  const core = require("@openzeppelin/upgrades-core");
  const { readValidations } = require("@openzeppelin/hardhat-upgrades/dist/utils/validations");
  const validations = await readValidations(hre);
  const manifests = fs.existsSync(manifestDir)
    ? fs.readdirSync(manifestDir).filter((f) => f.endsWith(".json") && !f.startsWith("unknown-"))
    : [];
  const results = [];
  for (const { name, namespace, recordedLayouts } of contracts) {
    if (!recordedLayouts) continue;
    const factory = await hre.ethers.getContractFactory(name);
    const updated = core.getStorageLayout(validations, core.getVersion(factory.bytecode));
    let seen = 0;
    for (const file of manifests) {
      const recorded = JSON.parse(fs.readFileSync(path.join(manifestDir, file), "utf8"));
      for (const impl of Object.values(recorded.impls || {})) {
        if (!impl.layout || !(impl.layout.namespaces || {})[namespace]) continue;
        seen += 1;
        const report = core.getStorageUpgradeReport(impl.layout, updated, core.withValidationDefaults({}));
        results.push({
          name,
          address: impl.address,
          ok: report.ok,
          line: report.ok
            ? `OK    ${name}: a legal successor of the layout recorded for ${impl.address} (${file})`
            : `FAIL  ${name}: not a successor of the layout recorded for ${impl.address} (${file})\n${report.explain()}`,
        });
      }
    }
    if (seen === 0) {
      results.push({ name, address: "-", ok: true, line: `SKIP  ${name}: no recorded layout of ${namespace} yet` });
    }
  }
  return results;
}

async function main() {
  const networkName = hre.network.name;
  const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);

  console.log(`Validating the ${CONTRACTS.length} UUPS implementations...`);
  console.log(`Network:  ${networkName} (chain ${chainId})`);
  console.log(`unsafeAllow: ${UNSAFE_ALLOW.join(", ")} — the spec's deliberate exception`);

  const failures = [];

  // ── half 1: implementation safety, network-free ──────────────────────────────────────
  for (const { name, constructorArgs } of CONTRACTS) {
    const factory = await hre.ethers.getContractFactory(name);
    try {
      await hre.upgrades.validateImplementation(factory, {
        kind: "uups",
        constructorArgs,
        unsafeAllow: UNSAFE_ALLOW,
      });
      console.log(`OK    ${name}: valid UUPS implementation`);
    } catch (error) {
      console.log(`FAIL  ${name}: ${error.message}`);
      failures.push(`${name} (implementation)`);
    }
  }

  // ── half 2: storage layout against the deployed proxy, when a manifest exists ─────────
  const manifest = manifestFor(networkName);
  if (manifest === null) {
    console.log(
      `\nNo committed .openzeppelin/${networkName}.json, so the storage-layout half is skipped.\n` +
        `That manifest is written by scripts/deploy-lp-staking.js (forceImport) and committed for\n` +
        `the networks the stack is deployed on; run this with --network sepolia or --network\n` +
        `mainnet to grade a new implementation against the deployed one.`
    );
  } else {
    console.log(`\nManifest: ${path.relative(path.join(__dirname, ".."), manifest)}`);
    const recorded = JSON.parse(fs.readFileSync(manifest, "utf8"));
    const proxies = recorded.proxies || [];
    if (proxies.length === 0) {
      console.log("  the manifest records no proxies — nothing to compare against");
    }
    const recordedKinds = readRecordedKinds(chainId);
    for (const { name, constructorArgs, newKind } of CONTRACTS) {
      if (newKind && !recordedKinds.has(name)) {
        console.log(`SKIP  ${name}: not deployed on this network yet — no layout baseline`);
        continue;
      }
      // The manifest keys proxies by address, not by name, so each recorded proxy is tried
      // against each factory: the one it really implements validates, the other one does not
      // and is reported as a mismatch only when NO proxy matched.
      let validated = null;
      const errors = [];
      for (const proxy of proxies) {
        const factory = await hre.ethers.getContractFactory(name);
        try {
          await hre.upgrades.validateUpgrade(proxy.address, factory, {
            kind: "uups",
            constructorArgs,
            unsafeAllow: UNSAFE_ALLOW,
          });
          validated = proxy.address;
          break;
        } catch (error) {
          errors.push(`${proxy.address}: ${error.message.split("\n")[0]}`);
        }
      }
      if (validated) {
        console.log(`OK    ${name}: storage layout is a legal successor at ${validated}`);
      } else if (proxies.length > 0) {
        console.log(`FAIL  ${name}: no recorded proxy accepts this layout`);
        for (const line of errors) console.log(`        ${line}`);
        failures.push(`${name} (layout)`);
      }
    }
  }

  // ── half 3: every recorded layout of the namespace, network-free ─────────────────────
  console.log("");
  for (const result of await checkRecordedLayouts()) {
    console.log(result.line);
    if (!result.ok) failures.push(`${result.name} (recorded layout ${result.address})`);
  }

  if (failures.length > 0) {
    throw new Error(`Upgrade-safety validation failed for: ${failures.join(", ")}`);
  }
  console.log("\nAll upgrade-safety checks passed.");
}

module.exports = { CONTRACTS, checkRecordedLayouts };

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
