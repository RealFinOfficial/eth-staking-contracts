const hre = require("hardhat");
const pools = require("./lib/pools");
const { deployContract } = require("./lib/proxies");

// Deploys ONE of the two TEST-ONLY stand-ins of the bridge (spec 01 §9.7), never on a mainnet:
//
//   STANDIN=burn     BurnStandIn on the source test chain (Sepolia): the bridge's burn interface,
//                    owned by the deploying test wallet. `constructor(token, owner, accessSigner,
//                    closeAt)`; opened by the owner with `setOpened(true)` (STANDIN_OPEN=yes does it
//                    right after the deploy)
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
//   STANDIN_CLOSE_AT         burn only, required, unix seconds: the last second a burn is accepted.
//                            No default on purpose: the window length is the operator's decision
//   STANDIN_OPEN=yes         burn only: send setOpened(true) after the deploy (the deployer must own it)
//
//     STANDIN=burn STANDIN_ACCESS_SIGNER=0x… STANDIN_CLOSE_AT=… \
//       npx hardhat run scripts/deploy-bridge-standins.js --network sepolia
//     STANDIN=payout npx hardhat run scripts/deploy-bridge-standins.js --network avalanche-fuji
//
// Records `BurnStandIn` / `PayoutStandIn` in deployments.json under the chain.

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
    const closeAt = env.STANDIN_CLOSE_AT;
    if (!closeAt || !/^[0-9]+$/.test(closeAt)) throw new Error("Set STANDIN_CLOSE_AT (unix seconds)");
    config.closeAt = Number(closeAt);
    config.open = env.STANDIN_OPEN === "yes";
  }
  return config;
}

/** Deploys and records the stand-in; returns its address. */
async function deployStandIn({ config, deployer }) {
  const chainId = await pools.chainId();
  refuseMainnet(chainId);
  const args =
    config.which === "burn" ? [config.token, config.owner, config.accessSigner, config.closeAt] : [config.token, config.owner];
  const { contract, address, tx, receipt } = await deployContract(config.kind, args, deployer);
  const extra = { deployTx: tx.hash, block: receipt.blockNumber, token: config.token, owner: config.owner };
  if (config.which === "burn") Object.assign(extra, { accessSigner: config.accessSigner, closeAt: config.closeAt });
  // Recorded before the optional opening, so a failed setOpened never loses the address.
  pools.recordDeployment(chainId, config.kind, address, extra);
  if (config.which === "burn" && config.open) {
    await pools.send("BurnStandIn.setOpened(true)", deployer, (o) => contract.connect(deployer).setOpened(true, o));
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
    console.log(`  access signer ${config.accessSigner}, closeAt ${config.closeAt} (${pools.epochToIso(config.closeAt)})`);
  }
  const address = await deployStandIn({ config, deployer });
  console.log(`${config.kind}: ${address}`);
}

module.exports = { REFUSED_CHAIN_IDS, TEST_ASSET, refuseMainnet, readConfig, deployStandIn };

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
