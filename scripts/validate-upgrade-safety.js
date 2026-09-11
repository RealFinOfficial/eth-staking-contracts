const fs = require("fs");
const path = require("path");

const hre = require("hardhat");

// Upgrade-safety gate for the two UUPS proxies. Runs in CI on every push, with no secrets and
// no network access of its own.
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
//      the mistakes that make `claimedTokenX[user]` or `stakers[tokenId]` read as something
//      else after an upgrade. This half runs only for networks whose manifest is checked in,
//      because that manifest IS the baseline.
//
// Both contracts carry `immutable` protocol references set in the implementation constructor,
// which the plugin flags by default — `unsafeAllow: ['constructor', 'state-variable-immutable']`
// is the spec's own deliberate exception (`docs/specs/01-contracts.md` §1), not a silencer.
//
//     npx hardhat run scripts/validate-upgrade-safety.js
//     npx hardhat run scripts/validate-upgrade-safety.js --network sepolia
//     npm run validate:upgrades
//
// The default (in-process `hardhat` network) does half 1 for both contracts and reports which
// manifests exist. Naming a network adds half 2 against that network's manifest.

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
    // (tokenX, asset)
    constructorArgs: [DUMMY.address, DUMMY.address],
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

async function main() {
  const networkName = hre.network.name;
  const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);

  console.log("Validating the two UUPS implementations...");
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
    for (const { name, constructorArgs } of CONTRACTS) {
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

  if (failures.length > 0) {
    throw new Error(`Upgrade-safety validation failed for: ${failures.join(", ")}`);
  }
  console.log("\nAll upgrade-safety checks passed.");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
