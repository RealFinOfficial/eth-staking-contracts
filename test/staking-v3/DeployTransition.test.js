// scripts/deploy-staking-v3.js and the transition (spec 01 §9.10), in-process against the math-rung
// LP vault of helpers/transitionWorld.js and a scratch registry (never the tracked deployments.json):
// the fresh deploy links the receiver while the deployer owns the migrator and nominates the timelock
// for all four proxies; a LIVE migrator that predates the transition gets one batch call,
// upgradeToAndCall(newImplementation, initializeTransition(receiver)).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployWorld } = require("./helpers/transitionWorld");

const TRACKED_REGISTRY = path.join(__dirname, "..", "..", "deployments.json");

function scriptWithRegistry(registryFile) {
  const modules = ["../../scripts/lib/pools", "../../scripts/lib/proxies", "../../scripts/deploy-staking-v3"].map((m) =>
    require.resolve(m)
  );
  const previous = process.env.DEPLOYMENTS_FILE;
  process.env.DEPLOYMENTS_FILE = registryFile;
  try {
    for (const m of modules) delete require.cache[m];
    return require("../../scripts/deploy-staking-v3");
  } finally {
    if (previous === undefined) delete process.env.DEPLOYMENTS_FILE;
    else process.env.DEPLOYMENTS_FILE = previous;
    for (const m of modules) delete require.cache[m];
  }
}

describe("deploy-staking-v3.js: the transition receiver", function () {
  let w;
  let scratch;
  let script;
  let config;
  const trackedBefore = fs.readFileSync(TRACKED_REGISTRY, "utf8");

  beforeEach(async function () {
    w = await deployWorld();
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-transition-"));
    script = scriptWithRegistry(path.join(scratch, "deployments.json"));
    const now = BigInt((await ethers.provider.getBlock("latest")).timestamp);
    config = {
      activationEpoch: Number(now + 60n),
      endEpoch: Number(now + 60n + 90n * 86400n),
      stakeSigner: w.signer.address,
      migratorSigner: w.signer.address,
      asset: await w.asset.getAddress(),
      usdc: await w.usdc.getAddress(),
      lpVault: await w.vault.getAddress(),
      timelock: w.carol.address, // a plain account stands in for the timelock
      twapWindow: 300,
      maxDeviationTicks: 953,
      valuationWindow: 1800,
      bonusHookGas: 400000,
      bonusListenerGas: 1000000,
      vaultImplementation: null,
      deliverer: w.deliverer.address,
      migratorImplementation: null,
    };
  });

  after(function () {
    expect(fs.readFileSync(TRACKED_REGISTRY, "utf8")).to.equal(trackedBefore, "the tracked registry is untouched");
  });

  it("a fresh deploy links the receiver, records it and hands all four proxies to the timelock", async function () {
    const result = await script.deployStakingV3({ config, deployer: w.owner, batchFile: path.join(scratch, "b.json") });
    const migrator = await ethers.getContractAt("StakingMigrator", result.addresses.migrator);
    const receiver = await ethers.getContractAt("TransitionReceiver", result.addresses.receiver);
    expect(await migrator.transitionReceiver()).to.equal(result.addresses.receiver);
    expect(await migrator.swapLimitBps()).to.equal(300n);
    expect(await receiver.migrator()).to.equal(result.addresses.migrator);
    expect(await receiver.deliverer()).to.equal(w.deliverer.address);
    expect(await receiver.pendingOwner()).to.equal(w.carol.address);

    const fns = result.batch.calls.map((c) => `${c.fn}@${c.target}`);
    expect(fns.slice(0, 4)).to.deep.equal([
      `acceptOwnership@${result.addresses.pool}`,
      `acceptOwnership@${result.addresses.bonusVault}`,
      `acceptOwnership@${result.addresses.migrator}`,
      `acceptOwnership@${result.addresses.receiver}`,
    ]);
    expect(result.batch.calls.some((c) => c.fn === "upgradeToAndCall" && c.target === result.addresses.migrator)).to.equal(
      false
    );

    const recorded = JSON.parse(fs.readFileSync(path.join(scratch, "deployments.json"), "utf8"))["31337"];
    expect(recorded.TransitionReceiver.address).to.equal(result.addresses.receiver);
    expect(recorded.TransitionReceiver.deliverer).to.equal(w.deliverer.address);
    expect(recorded.TransitionReceiver.holderInitCodeHash).to.equal(await receiver.HOLDER_INIT_CODE_HASH());
    expect(recorded.TransitionReceiver.block).to.be.a("number");
    expect(recorded.TransitionReceiver.implementation).to.match(/^0x[0-9a-fA-F]{40}$/);

    // The timelock (here carol) runs the batch: every owner is the timelock afterwards. The world's LP
    // vault is owned by `owner`, not by this stand-in timelock, so its own calls go from there.
    const vaultAddr = await w.vault.getAddress();
    for (const c of result.batch.calls) {
      const from = c.target === vaultAddr ? w.owner : w.carol;
      await (await from.sendTransaction({ to: c.target, data: c.data })).wait();
    }
    for (const a of Object.values(result.addresses)) {
      expect(await (await ethers.getContractAt("TransitionReceiver", a)).owner()).to.equal(w.carol.address);
    }
    // A second run finds nothing left for the receiver.
    const again = await script.timelockOps({ addresses: result.addresses, lpVault: config.lpVault, timelock: config.timelock });
    expect(again).to.have.length(0);
  });

  it("a live migrator without the transition gets upgradeToAndCall(impl, initializeTransition(receiver))", async function () {
    // The world's v3 pool stands in for a contract without transitionReceiver(), owned by the timelock.
    const addresses = {
      pool: await w.poolV3.getAddress(),
      bonusVault: await w.bonusVault.getAddress(),
      migrator: await w.poolV3.getAddress(),
      receiver: await w.receiver.getAddress(),
    };
    await expect(
      script.timelockOps({ addresses, lpVault: config.lpVault, timelock: w.owner.address })
    ).to.be.rejectedWith(/predates the transition/);
    const impl = w.stranger.address;
    const ops = await script.timelockOps({
      addresses,
      lpVault: config.lpVault,
      timelock: w.owner.address,
      migratorImplementation: impl,
    });
    const upgrade = ops.find((o) => o.fn === "upgradeToAndCall" && o.target === addresses.migrator);
    expect(upgrade.args[0]).to.equal(impl);
    expect(upgrade.args[1]).to.equal(w.migrator.interface.encodeFunctionData("initializeTransition", [addresses.receiver]));
  });

  it("refuses to relink a migrator already linked to another receiver", async function () {
    const addresses = {
      pool: await w.poolV3.getAddress(),
      bonusVault: await w.bonusVault.getAddress(),
      migrator: await w.migrator.getAddress(),
      receiver: await w.bonusVault.getAddress(), // a contract, but not the receiver the migrator knows
    };
    await expect(script.timelockOps({ addresses, lpVault: config.lpVault, timelock: w.owner.address })).to.be.rejectedWith(
      /is linked to the receiver/
    );
  });

  it("reads V3_TRANSITION_DELIVERER and V3_MIGRATOR_IMPLEMENTATION, zero deliverer by default", function () {
    const env = { ...process.env };
    try {
      Object.assign(process.env, {
        V3_ACTIVATION_EPOCH: "100",
        V3_END_EPOCH: "200",
        V3_STAKE_SIGNER: w.signer.address,
        V3_ASSET: config.asset,
        V3_USDC: config.usdc,
        V3_LP_VAULT: config.lpVault,
        V3_TIMELOCK: config.timelock,
      });
      delete process.env.V3_TRANSITION_DELIVERER;
      delete process.env.V3_MIGRATOR_IMPLEMENTATION;
      expect(script.readConfig(31337).deliverer).to.equal(ethers.ZeroAddress);
      expect(script.readConfig(31337).migratorImplementation).to.equal(null);
      process.env.V3_TRANSITION_DELIVERER = w.deliverer.address;
      process.env.V3_MIGRATOR_IMPLEMENTATION = w.stranger.address;
      expect(script.readConfig(31337).deliverer).to.equal(w.deliverer.address);
      expect(script.readConfig(31337).migratorImplementation).to.equal(w.stranger.address);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
      Object.assign(process.env, env);
    }
  });
});
