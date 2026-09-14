const hre = require("hardhat");
const pools = require("./lib/pools");

// Deploy ONE new UUPS implementation for a proxy that is already live, and print the two
// `lp-timelock.js` command lines that activate it.
//
// ──────────────────────── what this script is for ────────────────────────
//
// Activating a contract change on a live proxy is three separate steps, and this script is
// the FIRST of them:
//
//   1. deploy the new implementation and register it in the `hardhat-upgrades` manifest
//      — this script. One transaction, and it touches nothing that is live.
//   2. schedule `upgradeToAndCall(newImplementation, 0x)` on the proxy through the
//      `LPTimelock`, wait out `getMinDelay()`, then execute it — `lp-timelock.js`.
//   3. record the new implementation address in `deployments.json` and hand it to whoever
//      pins it (the backend pins both, see scripts/README.md).
//
// Until this script existed the repo could do step 2 and not step 1: `deploy-lp-staking.js`
// deploys implementations, but only as half of a full stack bootstrap, and it writes six new
// registry entries while doing it. There was no way to put a SECOND implementation of an
// existing proxy on chain.
//
// ──────────────────────── what it does, in order ────────────────────────
//
//   1. resolves the proxy: `IMPL_PROXY_ADDRESS`, else `deployments.json` for this chain and
//      `IMPL_TARGET`
//   2. reads the proxy's CURRENT implementation out of the ERC-1967 slot
//   3. derives the implementation's constructor arguments — see the next section
//   4. `upgrades.prepareUpgrade(proxy, Factory, { kind: "uups", constructorArgs, unsafeAllow })`,
//      which validates the new implementation against the DEPLOYED proxy's storage layout,
//      deploys it, and records it in `.openzeppelin/<network>.json`
//   5. prints the addresses, the deploy transaction, the runtime code size, and the exact
//      schedule / execute command lines for step 2
//   6. with `RECORD=1`, writes `pendingImplementation` into the proxy's registry entry
//
// It sends exactly one transaction — the implementation deploy — and it is the only one it
// can send: it never calls the timelock and never calls the proxy. An implementation sitting
// on chain that no proxy points at is inert; nothing about the live stack changes until the
// timelock executes step 2.
//
// ──────────────────────── where the constructor arguments come from ────────────────────────
//
// Both implementations carry `immutable` protocol references set in their constructor, and
// the new implementation must carry EXACTLY the values the deployed one carries: they are
// bytecode, not proxy storage, so an upgrade replaces them wholesale. A vault implementation
// built with the wrong `pool` would silently repoint the TWAP guard at another market for
// every position already in custody.
//
// The authority for those values is therefore the LIVE PROXY, read through its own public
// getters — `positionManager()`, `pool()`, `token0()`, `token1()`, `fee()`, `swapRouter()` on
// the vault, `tokenX()` and `asset()` on the distributor. Each one is a view call that
// delegates into the current implementation and returns the immutable out of its bytecode, so
// what comes back IS what the deployed implementation was built with.
//
// `deployments.json` is then used as the CROSS-CHECK rather than as the source: the registry
// records four of the vault's six values (pool, token0, token1, fee) and both of the
// distributor's, and a disagreement between the registry and the chain means the registry
// entry describes a different deployment than the one about to be upgraded. That is fatal
// here, because every other number in this run would be read off the wrong stack.
//
// The registry is not the source because it does not hold `positionManager` or `swapRouter`
// at all, and an env var is not the source because a typo in one would be indistinguishable
// from an intended value — while a wrong value read back from the proxy is impossible.
//
// ──────────────────────── environment ────────────────────────
//
//   IMPL_TARGET              LPStakingVault | RewardsDistributor. One kind per run, because
//                            each is a separate implementation, a separate deploy and a
//                            separate timelock operation
//   IMPL_PROXY_ADDRESS       overrides the registry lookup of the proxy
//   IMPL_CONTRACT            artifact name to compile and deploy; defaults to IMPL_TARGET.
//                            Only for a next revision that lives under a different contract
//                            name — the storage layout is still validated against the
//                            deployed proxy, but the run says loudly what it is doing
//   IMPL_UNSAFE_ALLOW_EXTRA  comma-separated extra `unsafeAllow` flags on top of the spec's
//                            two. `missing-initializer` is the one a real V2 needs: a second
//                            version declares a `reinitializer(2)` and no `initializer` of
//                            its own, which the plugin flags by default
//   RECORD=1                 write `pendingImplementation` / `pendingImplementationBlock`
//                            into the proxy's entry in deployments.json
//   CONFIRM=yes              required on mainnet, like every other state-changing script here
//
//     IMPL_TARGET=LPStakingVault npx hardhat run scripts/deploy-implementation.js --network sepolia
//     IMPL_TARGET=RewardsDistributor RECORD=1 \
//       npx hardhat run scripts/deploy-implementation.js --network sepolia
//
// The full runbook — validate, schedule, wait, execute, post-check, record, hand over — is in
// scripts/README.md under "Activating a new implementation (Sepolia test stack #5)".

/** The two UUPS proxies. Each name is both a registry kind and an artifact name. */
const IMPL_KINDS = ["LPStakingVault", "RewardsDistributor"];

/**
 * The two exceptions the spec grants the proxies (`docs/specs/01-contracts.md` §1): both
 * implementations keep their fixed protocol references `immutable`, set in a constructor that
 * ends with `_disableInitializers()`. Identical to the list `deploy-lp-staking.js` and
 * `validate-upgrade-safety.js` use — the three must never drift apart, or a contract one of
 * them accepts is rejected by the next.
 */
const UUPS_UNSAFE_ALLOW = ["constructor", "state-variable-immutable"];

/** EIP-170: a runtime code size above this cannot be deployed at all. */
const MAX_RUNTIME_CODE_SIZE = 24576;

/**
 * How each kind's constructor arguments are read back from its live proxy, and which of them
 * `deployments.json` also records.
 *
 * `getters` is in constructor order — that order IS the deployment, so it is written out once
 * here and never rebuilt anywhere else. `registryKeys` maps the same positions onto the
 * registry's field names, with `null` where the registry holds nothing to compare against.
 */
const CONSTRUCTOR_SOURCES = {
  LPStakingVault: {
    // constructor(positionManager, pool, token0, token1, fee, swapRouter)
    getters: ["positionManager", "pool", "token0", "token1", "fee", "swapRouter"],
    registryKeys: [null, "pool", "token0", "token1", "fee", null],
  },
  RewardsDistributor: {
    // constructor(tokenX, asset)
    getters: ["tokenX", "asset"],
    registryKeys: ["tokenX", "asset"],
  },
};

/** The view surface the constructor arguments are read through. Nothing else is called. */
const IMMUTABLE_ABI = {
  LPStakingVault: [
    "function positionManager() view returns (address)",
    "function pool() view returns (address)",
    "function token0() view returns (address)",
    "function token1() view returns (address)",
    "function fee() view returns (uint24)",
    "function swapRouter() view returns (address)",
  ],
  RewardsDistributor: [
    "function tokenX() view returns (address)",
    "function asset() view returns (address)",
  ],
};

/** Compares two constructor values the way Solidity would: addresses case-insensitively. */
function sameValue(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

/**
 * The proxy this run acts on: the explicit override, else the registry entry for this chain.
 *
 * Pure apart from the registry read, so the failure mode ("nothing recorded, pass an address")
 * is one message rather than a lookup that returns undefined and fails three lines later.
 */
function resolveProxyAddress(chainId, kind, override) {
  if (override) return hre.ethers.getAddress(override);
  const address = pools.registryAddress(chainId, kind);
  if (!address) {
    throw new Error(
      `No ${kind} recorded for chain ${chainId} in deployments.json — ` +
        `set IMPL_PROXY_ADDRESS=<proxy address> instead`
    );
  }
  return hre.ethers.getAddress(address);
}

/**
 * Reads the implementation's constructor arguments back off the live proxy and grades them
 * against the registry entry. Returns the argument list in constructor order plus a printable
 * row per argument.
 *
 * A mismatch throws: the registry entry then describes a different deployment than the proxy
 * this run is pointed at, and nothing printed after that point would be about the same stack.
 */
async function readConstructorArgs(kind, proxyAddress, registryEntry) {
  const { getters, registryKeys } = CONSTRUCTOR_SOURCES[kind];
  const proxy = new hre.ethers.Contract(proxyAddress, IMMUTABLE_ABI[kind], hre.ethers.provider);

  const args = [];
  const rows = [];
  const mismatches = [];

  for (let index = 0; index < getters.length; index++) {
    const name = getters[index];
    const raw = await proxy[name]();
    // `fee` is a uint24 and arrives as a BigInt; every other value is an address.
    const value = typeof raw === "bigint" ? Number(raw) : hre.ethers.getAddress(raw);
    args.push(value);

    const registryKey = registryKeys[index];
    const recorded = registryKey && registryEntry ? registryEntry[registryKey] : undefined;
    let note = "";
    if (recorded === undefined) {
      note = registryKey
        ? "(no deployments.json entry to compare with)"
        : "(deployments.json does not record this field)";
    } else if (sameValue(recorded, value)) {
      note = `(matches deployments.json ${registryKey})`;
    } else {
      note = `(MISMATCH: deployments.json ${registryKey} = ${recorded})`;
      mismatches.push(`${name}: chain ${value}, registry ${recorded}`);
    }
    rows.push({ name, value, note });
  }

  if (mismatches.length > 0) {
    throw new Error(
      `The proxy at ${proxyAddress} disagrees with the ${kind} entry in deployments.json:\n` +
        mismatches.map((line) => `  ${line}`).join("\n") +
        `\nThe registry entry describes a different deployment. Fix it, or pass ` +
        `IMPL_PROXY_ADDRESS for the deployment you mean.`
    );
  }

  return { args, rows };
}

/**
 * The registry entry a successful `RECORD=1` writes: the existing entry with two keys added.
 *
 * Kept pure and exported so the "touches nothing else in the file" claim is testable without
 * writing to `deployments.json`. `pools.recordDeployment` REPLACES an entry rather than
 * merging into it, so the whole existing entry has to be handed back to it; spreading it
 * first also means a re-run overwrites the two keys in place instead of appending duplicates.
 */
function pendingImplementationRecord(entry, { implementation, block }) {
  const { address, ...rest } = entry;
  return {
    address,
    extra: {
      ...rest,
      pendingImplementation: implementation,
      pendingImplementationBlock: block,
    },
  };
}

/**
 * Deploys one implementation for one live proxy. The whole script, minus the environment
 * parsing and the printing; the suites call this directly.
 *
 * @param {object} options
 * @param {string} options.kind                 registry kind: LPStakingVault | RewardsDistributor
 * @param {string} [options.proxyAddress]       overrides the registry lookup
 * @param {string} [options.contractName]       artifact to deploy; defaults to `kind`
 * @param {string[]} [options.unsafeAllowExtra] extra plugin flags on top of the spec's two
 * @param {object} [options.deployer]           signer; defaults to `pools.getSigner()`
 * @param {boolean} [options.quiet]             suppress the console output
 */
async function deployImplementation(options) {
  const {
    kind,
    proxyAddress: proxyOverride,
    contractName = kind,
    unsafeAllowExtra = [],
    deployer: deployerOverride,
    quiet = false,
  } = options;

  const log = quiet ? () => {} : (line = "") => console.log(line);

  if (!IMPL_KINDS.includes(kind)) {
    throw new Error(`IMPL_TARGET must be one of ${IMPL_KINDS.join(", ")} — got ${kind}`);
  }

  const chainId = await pools.chainId();
  const deployer = deployerOverride || (await pools.getSigner());
  const network = hre.network.name;

  const registryEntry = (pools.readRegistry()[String(chainId)] || {})[kind];
  const proxyAddress = resolveProxyAddress(chainId, kind, proxyOverride);

  const proxyCode = await hre.ethers.provider.getCode(proxyAddress);
  if (proxyCode === "0x") {
    throw new Error(`No contract code at ${kind} proxy ${proxyAddress} on chain ${chainId}`);
  }

  // The ERC-1967 implementation slot of the proxy, read from chain. This is the "before"
  // side of the upgrade and the value the post-execute check compares against.
  const currentImplementation = hre.ethers.getAddress(
    await hre.upgrades.erc1967.getImplementationAddress(proxyAddress)
  );

  const { args: constructorArgs, rows } = await readConstructorArgs(
    kind,
    proxyAddress,
    registryEntry && sameValue(registryEntry.address, proxyAddress) ? registryEntry : undefined
  );

  const unsafeAllow = [...UUPS_UNSAFE_ALLOW, ...unsafeAllowExtra];

  log(`Deploying a new ${kind} implementation...`);
  log(`Network:        ${network} (chain ${chainId})`);
  log(`Deployer:       ${deployer.address}`);
  const contractNote = contractName === kind ? "" : "  <-- NOT the kind's own artifact";
  log(`Contract:       ${contractName}${contractNote}`);
  log(`Proxy:          ${proxyAddress}`);
  log(`  ${pools.explorerAddress(chainId, proxyAddress)}`);
  log(`Current impl:   ${currentImplementation} (ERC-1967 slot)`);
  log(`  ${pools.explorerAddress(chainId, currentImplementation)}`);
  log(`unsafeAllow:    ${unsafeAllow.join(", ")}`);
  if (unsafeAllowExtra.length > 0) {
    log(
      `  ${unsafeAllowExtra.join(", ")} is NOT one of the spec's two exceptions — it was asked\n` +
        `  for explicitly on this run.`
    );
  }
  log("Constructor arguments, read back from the live proxy:");
  for (const row of rows) {
    log(`  ${row.name.padEnd(16)} ${String(row.value).padEnd(44)} ${row.note}`);
  }

  pools.requireConfirmation(chainId, `deploy a new ${kind} implementation`);
  if (pools.isMainnet(chainId)) log("\nThe implementation deploy needs a Ledger confirmation.");

  const Factory = await hre.ethers.getContractFactory(contractName, deployer);

  // Explicit nonce, like every other transaction in this repo: hardhat-ledger resolves the
  // nonce with the "pending" block tag and does not retry, and Infura returns an intermittent
  // -32603 for that tag. `txOverrides` is handed straight to `factory.deploy`.
  const nonce = await pools.resolveNonce(deployer.address);
  const nonceBefore = await hre.ethers.provider.getTransactionCount(deployer.address, "latest");

  log(
    `\nprepareUpgrade: validating ${contractName} against the deployed layout, then deploying...`
  );
  log(`  (nonce ${nonce})`);

  // `prepareUpgrade` is the one plugin call that does all three things at once: it validates
  // the implementation on its own (selfdestruct, delegatecall, a constructor that writes
  // state, a missing `_authorizeUpgrade`), it validates its STORAGE LAYOUT against the layout
  // the manifest records for THIS proxy, and only then does it deploy and record the result.
  // `upgradeProxy` would do the same and then send `upgradeToAndCall` from the caller — which
  // is exactly what must not happen here: the proxy is owned by a timelock, and the upgrade
  // is a scheduled operation the multisig sends, not this script.
  //
  // `getTxResponse` swaps the return value from the implementation ADDRESS to the deployment's
  // TRANSACTION, which is the only way to learn the hash and the block; the address then comes
  // off that transaction's receipt. It falls back to the address when the plugin has no
  // transaction to hand over — a reused implementation whose recorded hash the node no longer
  // serves — so both shapes have to be handled.
  const prepared = await hre.upgrades.prepareUpgrade(proxyAddress, Factory, {
    kind: "uups",
    constructorArgs,
    unsafeAllow,
    getTxResponse: true,
    txOverrides: { nonce },
  });

  const nonceAfter = await hre.ethers.provider.getTransactionCount(deployer.address, "latest");
  // Nothing was sent when the nonce did not move. The plugin keys implementations by the hash
  // of (bytecode, constructor arguments), so an unchanged contract compiled with unchanged
  // arguments resolves to the implementation that is already on chain and no transaction is
  // made at all.
  const reused = nonceAfter === nonceBefore;

  let implementation;
  let deployTxHash = null;
  let blockNumber = null;
  if (typeof prepared === "string") {
    implementation = hre.ethers.getAddress(prepared);
  } else {
    deployTxHash = prepared.hash;
    const receipt = await hre.ethers.provider.getTransactionReceipt(prepared.hash);
    blockNumber = receipt ? receipt.blockNumber : null;
    // A CREATE address is a pure function of (sender, nonce), so the receipt and the
    // computation agree by construction; the computation is the fallback for a node that has
    // not served the receipt yet.
    implementation = hre.ethers.getAddress(
      (receipt && receipt.contractAddress) ||
        hre.ethers.getCreateAddress({ from: prepared.from, nonce: prepared.nonce })
    );
  }

  const code = await hre.ethers.provider.getCode(implementation);
  if (code === "0x") {
    throw new Error(`prepareUpgrade returned ${implementation}, but there is no code there`);
  }
  const codeSize = (code.length - 2) / 2;

  log("");
  if (reused) {
    log(
      `The implementation was ALREADY DEPLOYED at ${implementation} and was reused:\n` +
        `  ${contractName}'s bytecode and constructor arguments are byte-identical to a\n` +
        `  deployment the manifest already records, so nothing was sent and no gas was spent.`
    );
    if (sameValue(implementation, currentImplementation)) {
      log(
        `  It is the implementation the proxy ALREADY RUNS. There is nothing to upgrade to:\n` +
          `  this build carries no change for ${kind}. Do not schedule anything.`
      );
    }
  } else {
    log(`New implementation: ${implementation}`);
  }

  log("");
  log("──────── addresses ────────");
  log(`kind:           ${kind}`);
  log(`proxy:          ${proxyAddress}`);
  log(`current impl:   ${currentImplementation}`);
  log(`new impl:       ${implementation}`);
  log(`  ${pools.explorerAddress(chainId, implementation)}`);
  log(
    `deploy tx:      ${deployTxHash || "unknown — the implementation was already on chain"}` +
      (deployTxHash && reused ? "  (its ORIGINAL deploy; this run sent nothing)" : "")
  );
  if (deployTxHash) log(`  ${pools.explorerTx(chainId, deployTxHash)}`);
  log(`block:          ${blockNumber === null ? "unknown" : blockNumber}`);
  log(
    `runtime code:   ${codeSize} bytes ` +
      `(EIP-170 limit ${MAX_RUNTIME_CODE_SIZE}, ${MAX_RUNTIME_CODE_SIZE - codeSize} to spare)`
  );

  const scheduleCommand =
    `TIMELOCK_ACTION=schedule TIMELOCK_TARGET=${kind} TIMELOCK_FN=upgradeToAndCall \\\n` +
    `  TIMELOCK_ARGS=${implementation},0x \\\n` +
    `  npx hardhat run scripts/lp-timelock.js --network ${network}`;
  const executeCommand =
    `TIMELOCK_ACTION=execute TIMELOCK_TARGET=${kind} TIMELOCK_FN=upgradeToAndCall \\\n` +
    `  TIMELOCK_ARGS=${implementation},0x \\\n` +
    `  npx hardhat run scripts/lp-timelock.js --network ${network}`;

  log("");
  if (sameValue(implementation, currentImplementation)) {
    // Printing the commands here would invite an operation that spends the whole delay to
    // arrive exactly where the stack already is.
    log("──────── nothing to activate ────────");
    log(`The proxy already delegates to ${implementation}. No timelock operation is needed,`);
    log(`and none is printed. Re-run this once ${kind} has actually changed.`);
  } else {
    log("──────── activate it (nothing below has been done by this script) ────────");
    log(`First, the storage-layout gate must pass against this network's committed manifest:`);
    log(`  npx hardhat run scripts/validate-upgrade-safety.js --network ${network}`);
    log("");
    log("Then schedule the upgrade through the timelock that owns the proxy:");
    log(scheduleCommand);
    log("");
    log("Wait out the timelock's getMinDelay(), then execute the SAME operands:");
    log(executeCommand);
    log("");
    log(
      "`data` is 0x: this upgrade runs no reinitializer. If a future revision needs one, the\n" +
        "second argument is its encoded call and BOTH commands must carry the same value — the\n" +
        "operation id is a hash of the whole call, so an execute with different arguments is a\n" +
        "different operation that was never scheduled. If this exact upgrade was scheduled and\n" +
        "executed once before, add TIMELOCK_SALT_TAG=<something new> to both commands."
    );
  }

  return {
    kind,
    contractName,
    chainId,
    network,
    proxyAddress,
    currentImplementation,
    implementation,
    constructorArgs,
    reused,
    deployTxHash,
    blockNumber,
    codeSize,
    scheduleCommand,
    executeCommand,
  };
}

async function main() {
  const kind = process.env.IMPL_TARGET;
  if (!kind) throw new Error(`Set IMPL_TARGET to one of ${IMPL_KINDS.join(", ")}`);

  const unsafeAllowExtra = (process.env.IMPL_UNSAFE_ALLOW_EXTRA || "")
    .split(",")
    .map((flag) => flag.trim())
    .filter((flag) => flag.length > 0);

  const result = await deployImplementation({
    kind,
    proxyAddress: process.env.IMPL_PROXY_ADDRESS,
    contractName: process.env.IMPL_CONTRACT,
    unsafeAllowExtra,
  });

  if (sameValue(result.implementation, result.currentImplementation)) {
    console.log(
      `\nNothing to record: ${result.implementation} is the implementation the proxy already ` +
        `runs,\nso there is no pending one. deployments.json is unchanged.`
    );
    return;
  }

  if (process.env.RECORD !== "1") {
    console.log(
      `\nRECORD=1 would write pendingImplementation into the ${kind} entry of ` +
        `deployments.json.\nNothing was written.`
    );
    return;
  }

  // The registry keeps `implementation` pointing at the code the proxy RUNS. A prepared
  // implementation is not that until the timelock has executed, which is minutes away at
  // best, so it is recorded under its own key and the live one is left alone. Moving it into
  // `implementation` after the execute is a manual edit — the only writer of that field is
  // `deploy-lp-staking.js`, which writes it as part of a full stack bootstrap and would
  // create six new entries if it were run for this.
  const entry = (pools.readRegistry()[String(result.chainId)] || {})[kind];
  if (!entry) {
    throw new Error(
      `RECORD=1, but chain ${result.chainId} has no ${kind} entry in deployments.json to ` +
        `record against. The implementation is deployed at ${result.implementation}.`
    );
  }
  if (!sameValue(entry.address, result.proxyAddress)) {
    throw new Error(
      `RECORD=1, but this run acted on proxy ${result.proxyAddress} while deployments.json ` +
        `records ${entry.address} for ${kind}. Refusing to record a pending implementation ` +
        `against a proxy this run never read. The implementation is deployed at ` +
        `${result.implementation}.`
    );
  }

  const { address, extra } = pendingImplementationRecord(entry, {
    implementation: result.implementation,
    block: result.blockNumber,
  });
  pools.recordDeployment(result.chainId, kind, address, extra);
  console.log(
    `\npendingImplementation = ${result.implementation} recorded for ${kind}.\n` +
      `Everything else in the entry is unchanged, and "implementation" still names the code\n` +
      `the proxy runs today. Move it across by hand after the timelock has executed.`
  );
}

module.exports = {
  IMPL_KINDS,
  UUPS_UNSAFE_ALLOW,
  CONSTRUCTOR_SOURCES,
  resolveProxyAddress,
  pendingImplementationRecord,
  deployImplementation,
};

// `hardhat run` executes this file as the entry point; a `require` from the suites must only
// pick up the exports above.
if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
