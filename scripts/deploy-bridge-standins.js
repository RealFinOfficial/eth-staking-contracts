const hre = require("hardhat");
const pools = require("./lib/pools");
const { deployContract } = require("./lib/proxies");

// Deploys ONE of the two TEST-ONLY stand-ins of the bridge (spec 01 §9.7), never on a mainnet:
//
//   STANDIN=burn     BurnStandIn on the source test chain (Sepolia): the bridge's burn interface
//                    (the bridge owner's state of 2026-11-23), owned by the deploying test wallet.
//                    `constructor(token, owner, accessSigner)`; closeAt is 0 until `open()`, which
//                    sets it to the opening time + 90 days. The bridge's order is followed: the
//                    access signature requirement is turned on BEFORE `open()`
//   STANDIN=payout   PayoutStandIn on the LP test chain (Fuji): emits the bridge's `Paid` event while
//                    the owner pays a burn in parts. `constructor(token, owner)`; the owner funds it with
//                    a plain transfer of the test $ASSET
//
// Refused on chain 1 (Ethereum) and chain 43114 (Avalanche C-Chain), whatever else is set: these
// contracts have test-only owner setters and must never exist on a mainnet. The constructors do not
// check the chain themselves (a Foundry fork test of Ethereum runs with chain id 1).
//
// ──────────────────────── environment ────────────────────────
//
//   STANDIN                  burn | payout
//   STANDIN_TOKEN            the test $ASSET; default the bridge owner's test token of the chain
//                            (Sepolia 0x0A5BCe3bc08608C9B4A4d88bA216fe203DA74861, Fuji
//                            0x8972F308997a18152283a4b65e8FE026d8cB7724)
//   STANDIN_OWNER            default the deployer
//   STANDIN_ACCESS_SIGNER    burn only, required: the key that signs the access signatures
//                            (scripts/transition-access-file.js signs with it)
//   STANDIN_REQUIRE_SIGNATURE  burn only, yes (default) | no: send setRequireSignature(true) after
//                            the deploy and before open()
//   STANDIN_OPEN=yes         burn only: send open() after that (closeAt = then + 90 days)
//   (STANDIN_CLOSE_AT is removed: the stand-in sets closeAt itself; setting it is refused)
//   The deployer must own the stand-in for the two sends (STANDIN_OWNER unset).
//
//     STANDIN=burn STANDIN_ACCESS_SIGNER=0x… STANDIN_OPEN=yes \
//       npx hardhat run scripts/deploy-bridge-standins.js --network sepolia
//     STANDIN=payout npx hardhat run scripts/deploy-bridge-standins.js --network avalanche-fuji
//
// Records `BurnStandIn` / `PayoutStandIn` in deployments.json under the chain: the address, the
// deployment transaction and block, and (burn) `closeAt`, `opened` and `requireSignature` read back
// after the sends. An entry the chain already holds under that key is kept as `BurnStandInRetired` /
// `PayoutStandInRetired` (with `retiredInFavourOf`, the registry's convention; an earlier retired
// entry of the same kind is replaced, git keeps it). The record is written right after the deploy,
// before the sends, so a failed send never loses the address.

/** The chains where a stand-in may never be deployed. */
const REFUSED_CHAIN_IDS = new Set([1, 43114]);

/** The bridge owner's test $ASSET per test chain (spec 01 §9.7.2, §9.7.3). */
const TEST_ASSET = {
  11155111: "0x0A5BCe3bc08608C9B4A4d88bA216fe203DA74861",
  43113: "0x8972F308997a18152283a4b65e8FE026d8cB7724",
};

const KINDS = { burn: "BurnStandIn", payout: "PayoutStandIn" };

function refuseMainnet(chainId) {
  if (REFUSED_CHAIN_IDS.has(Number(chainId)) || pools.isMainnet(chainId)) {
    throw new Error(`The bridge stand-ins are TEST ONLY and are never deployed on chain ${chainId}`);
  }
}

function readAddress(env, name, fallback) {
  const raw = env[name] || fallback;
  if (!raw) throw new Error(`Set ${name}`);
  if (!hre.ethers.isAddress(raw)) throw new Error(`${name} is not an address: ${raw}`);
  return hre.ethers.getAddress(raw);
}

/** The configuration from `env` for `chainId`. Pure, so the unit suite can drive it. */
function readConfig(chainId, env, deployerAddress) {
  refuseMainnet(chainId);
  const which = env.STANDIN;
  if (!KINDS[which]) throw new Error(`STANDIN must be burn or payout — got ${which}`);
  const config = {
    which,
    kind: KINDS[which],
    token: readAddress(env, "STANDIN_TOKEN", TEST_ASSET[Number(chainId)]),
    owner: readAddress(env, "STANDIN_OWNER", deployerAddress),
  };
  if (which === "burn") {
    config.accessSigner = readAddress(env, "STANDIN_ACCESS_SIGNER");
    if (env.STANDIN_CLOSE_AT !== undefined && env.STANDIN_CLOSE_AT !== "") {
      throw new Error("STANDIN_CLOSE_AT is removed: closeAt is 0 until open(), which sets it to + 90 days");
    }
    const raw = env.STANDIN_REQUIRE_SIGNATURE;
    const wanted = raw === undefined || raw === "" ? "yes" : raw;
    if (!["yes", "no"].includes(wanted)) throw new Error(`STANDIN_REQUIRE_SIGNATURE must be yes or no — got ${wanted}`);
    config.requireSignature = wanted === "yes";
    config.open = env.STANDIN_OPEN === "yes";
  }
  return config;
}

/** Keeps the chain's current entry of `kind` (if any) as `<kind>Retired`, pointing at `newAddress`. */
function retireEntry(chainId, kind, newAddress) {
  const old = (pools.readRegistry()[String(chainId)] || {})[kind];
  if (!old) return;
  const { address: oldAddress, ...oldExtra } = old;
  pools.recordDeployment(chainId, `${kind}Retired`, oldAddress, { ...oldExtra, retiredInFavourOf: newAddress });
}

/** Deploys and records the stand-in, then (burn) the requirement and the opening; returns its address. */
async function deployStandIn({ config, deployer }) {
  const chainId = await pools.chainId();
  refuseMainnet(chainId);
  const args = config.which === "burn" ? [config.token, config.owner, config.accessSigner] : [config.token, config.owner];
  const { contract, address, tx, receipt } = await deployContract(config.kind, args, deployer);
  const extra = { deployTx: tx.hash, block: receipt.blockNumber, token: config.token, owner: config.owner };
  if (config.which === "burn") Object.assign(extra, { accessSigner: config.accessSigner, closeAt: 0, opened: false, requireSignature: false });
  // Recorded before the sends, so a failed send never loses the address.
  retireEntry(chainId, config.kind, address);
  pools.recordDeployment(chainId, config.kind, address, extra);
  if (config.which === "burn") {
    const burn = contract.connect(deployer);
    if (config.requireSignature) {
      await pools.send("BurnStandIn.setRequireSignature(true)", deployer, (o) => burn.setRequireSignature(true, o));
    }
    if (config.open) await pools.send("BurnStandIn.open()", deployer, (o) => burn.open(o));
    Object.assign(extra, {
      closeAt: Number(await contract.closeAt()),
      opened: await contract.opened(),
      requireSignature: await contract.requireSignature(),
    });
    pools.recordDeployment(chainId, config.kind, address, extra);
  }
  return address;
}

async function main() {
  const chainId = await pools.chainId();
  refuseMainnet(chainId);
  const deployer = await pools.getSigner();
  const config = readConfig(chainId, process.env, deployer.address);
  console.log(`Deploying ${config.kind} (TEST ONLY) on chain ${chainId}`);
  console.log(`  token ${config.token}, owner ${config.owner}`);
  if (config.which === "burn") {
    console.log(`  access signer ${config.accessSigner}, requireSignature ${config.requireSignature}, open ${config.open}`);
  }
  const address = await deployStandIn({ config, deployer });
  console.log(`${config.kind}: ${address}`);
  if (config.which === "burn") {
    const entry = pools.readRegistry()[String(chainId)][config.kind];
    const when = entry.closeAt ? ` (${pools.epochToIso(entry.closeAt)})` : "";
    console.log(`  opened ${entry.opened}, requireSignature ${entry.requireSignature}, closeAt ${entry.closeAt}${when}`);
  }
}

module.exports = { REFUSED_CHAIN_IDS, TEST_ASSET, refuseMainnet, readConfig, deployStandIn };

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
