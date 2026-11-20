const fs = require("fs");
const path = require("path");

const { buildVectors, exportedAbis } = require("./lib/transition-vectors");

// Writes the transition's artifacts for the other repositories, from the compiled contracts:
//
//   test/vectors/transition.json   HOLDER_INIT_CODE_HASH, the holder creation code, CREATE2 vectors
//                                  (receiver, holder, route -> receiving address) and DeliveryVoucher
//                                  typed-data vectors for chains 43114 and 43113 (spec 01 §9.3.1, §9.4.1)
//   abi/TransitionReceiver.json    the ABIs the indexer reads, as plain arrays like the other abi/*.json
//   abi/StakingMigrator.json
//   abi/BurnStandIn.json
//   abi/PayoutStandIn.json
//
// In-process only (no network, nothing sent). Run after any change to these contracts and commit
// the result; test/staking-v3/TransitionVectors.test.js fails while the committed files are stale.
//
//     npx hardhat run scripts/export-transition-artifacts.js

const ROOT = path.join(__dirname, "..");
const VECTOR_FILE = path.join(ROOT, "test", "vectors", "transition.json");

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
  console.log(`wrote ${path.relative(ROOT, file)}`);
}

async function main() {
  write(VECTOR_FILE, await buildVectors());
  for (const [name, abi] of Object.entries(await exportedAbis())) write(path.join(ROOT, "abi", `${name}.json`), abi);
}

module.exports = { VECTOR_FILE };

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
