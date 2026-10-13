const hre = require("hardhat");
const pools = require("./pools");

// Nonce-controlled deployment of plain contracts and of UUPS implementation + `LPProxy` pairs.
// Shared by `deploy-lp-staking.js` (the five proxies), `add-reward-token.js` (a new
// Overture-shaped reward token) and `lp-switch-timelock.js` (a replacement timelock), so every
// proxy in the stack is born through exactly one code path.

// The two exceptions the spec grants the proxies (§1): implementations keep their fixed
// protocol references `immutable`, set in a constructor that ends with `_disableInitializers()`.
// Identical to the lists in `validate-upgrade-safety.js` and `deploy-implementation.js` — the
// three must never drift apart, or a contract one of them accepts is rejected by the next.
const UUPS_UNSAFE_ALLOW = ["constructor", "state-variable-immutable"];

/** Deploys one contract with an explicit nonce and returns it with its receipt. */
async function deployContract(name, args, deployer) {
  const nonce = await pools.resolveNonce(deployer.address);
  console.log(`\nDeploying ${name}... (nonce ${nonce})`);
  const factory = await hre.ethers.getContractFactory(name);
  const contract = await factory.deploy(...args, { nonce });
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  const tx = contract.deploymentTransaction();
  const receipt = await hre.ethers.provider.getTransactionReceipt(tx.hash);

  console.log(`  ${name}: ${address}`);
  console.log(`  ${pools.explorerAddress(await pools.chainId(), address)}`);
  console.log(`  deploy tx: ${tx.hash}`);
  return { contract, address, tx, receipt };
}

/**
 * Deploys one UUPS implementation and the `LPProxy` in front of it, and registers the pair in
 * the `hardhat-upgrades` manifest.
 *
 * Three steps, each of which answers a different question:
 *
 *   - `validateImplementation` — is this contract safe behind a proxy at all? It reads the
 *     build info only, sends nothing, and rejects `selfdestruct`, `delegatecall`, state
 *     written from a constructor and a missing `_authorizeUpgrade`. Cheaper to fail here than
 *     to find out after the implementation is on chain.
 *   - two nonce-controlled deploys rather than `upgrades.deployProxy`, because mainnet signs
 *     through a Ledger and every transaction in this script carries an explicit nonce (see
 *     deployContract); the plugin sends its own un-nonce-able pair. `initialize` still runs
 *     inside the proxy's OWN deployment transaction — an uninitialized proxy is one
 *     `initialize` race away from belonging to whoever calls it first.
 *   - `forceImport` — writes `.openzeppelin/<network>.json`, which is the storage layout every
 *     future `validateUpgrade` grades a new implementation against. Skipping it would leave
 *     the deployed layout unrecorded, and the first upgrade with nothing to compare to.
 */
async function deployProxyPair(name, constructorArgs, initArgs, deployer) {
  const factory = await hre.ethers.getContractFactory(name);

  console.log(`\nValidating ${name} as a UUPS implementation...`);
  await hre.upgrades.validateImplementation(factory, {
    kind: "uups",
    constructorArgs,
    unsafeAllow: UUPS_UNSAFE_ALLOW,
  });
  console.log(`  ${name} passes the UUPS implementation checks`);

  const impl = await deployContract(name, constructorArgs, deployer);
  const initData = impl.contract.interface.encodeFunctionData("initialize", initArgs);
  const proxy = await deployContract("LPProxy", [impl.address, initData], deployer);

  await hre.upgrades.forceImport(proxy.address, factory, {
    kind: "uups",
    constructorArgs,
  });
  // Where that file lands is the plugin's call, not ours: a named network writes
  // `.openzeppelin/<network>.json` in the repo (committed — it is the layout baseline), while
  // a development chain (31337, anvil, a spawned `hardhat node`) writes into the OS temp
  // directory instead, so a fork run leaves nothing behind to clean up.
  console.log(`  recorded in the hardhat-upgrades manifest for network ${hre.network.name}`);

  return {
    impl,
    proxy,
    initData,
    address: proxy.address,
    tx: proxy.tx,
    receipt: proxy.receipt,
    contract: await hre.ethers.getContractAt(name, proxy.address, deployer),
  };
}

module.exports = { UUPS_UNSAFE_ALLOW, deployContract, deployProxyPair };
