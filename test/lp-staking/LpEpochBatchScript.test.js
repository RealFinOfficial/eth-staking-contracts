const fs = require("fs");
const os = require("os");
const path = require("path");

const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const batch = require("../../scripts/lib/lp-epoch-batch");
const { REGISTRY_ABI } = require("../../scripts/lp-epoch");

/**
 * `scripts/lib/lp-epoch-batch.js`, the shared logic of `scripts/lp-epoch-batch.js` (mint $OVTR,
 * schedule the epoch) and `scripts/lp-epoch-batch-with-asset.js` (mint $OVTR, transfer $ASSET,
 * schedule the epoch): ONE Safe Transaction Builder batch per run, never a sent transaction.
 *
 * The first part is pure (fake addresses, no network). The second part runs the whole script
 * flow on the in-process Hardhat network and then EXECUTES the printed calls from the operator.
 */
const iso = (s) => new Date(Number(s) * 1000).toISOString();
const TOKENS = (n) => ethers.parseEther(String(n));

const DISTRIBUTOR = "0x00000000000000000000000000000000000000d1";
const REGISTRY = "0x00000000000000000000000000000000000000e1";
const OPERATOR = "0x00000000000000000000000000000000000000a1";
const OVTR = { address: ethers.getAddress("0x1111111111111111111111111111111111111111"), symbol: "OVTR", decimals: 18 };
const ASSET = { address: ethers.getAddress("0x2222222222222222222222222222222222222222"), symbol: "ASSET", decimals: 18 };
const OTHER = { address: ethers.getAddress("0x3333333333333333333333333333333333333333"), symbol: "tUSD", decimals: 6 };

const DIST_IFACE = new ethers.Interface(["function mintRewardToken(address token, address to, uint256 amount)"]);
const ERC20_IFACE = new ethers.Interface(["function transfer(address to, uint256 amount) returns (bool)"]);
const REG_IFACE = new ethers.Interface(REGISTRY_ABI);

/** A `prepareSchedule` result for epoch 2 with the given token entries and whole amounts. */
function schedule(rows) {
  const startsAt = 1_800_000_000n;
  const endsAt = startsAt + 604_800n;
  const parsed = {
    tokens: rows.map(([t]) => t.address),
    amounts: rows.map(([t, n]) => ethers.parseUnits(String(n), t.decimals)),
    entries: rows.map(([t]) => t),
  };
  return { id: 2n, startsAt, endsAt, parsed, call: ["scheduleEpoch", [2n, startsAt, endsAt, parsed.tokens, parsed.amounts]] };
}

const build = (withAsset, rows) =>
  batch.buildCalls({
    withAsset,
    schedule: schedule(rows),
    ovtrAddress: OVTR.address,
    assetAddress: ASSET.address,
    distributorAddress: DISTRIBUTOR,
    registryAddress: REGISTRY,
  });

describe("lp-epoch-batch buildCalls", function () {
  it("lp-epoch-batch.js: mintRewardToken, then scheduleEpoch", function () {
    const s = schedule([
      [OVTR, 7500],
      [ASSET, 3000],
    ]);
    const { calls } = build(false, [
      [OVTR, 7500],
      [ASSET, 3000],
    ]);
    expect(calls.map((c) => c.name)).to.deep.equal(["mintRewardToken", "scheduleEpoch"]);
    expect(calls.map((c) => c.to)).to.deep.equal([DISTRIBUTOR, REGISTRY]);
    expect(calls.every((c) => c.value === "0")).to.equal(true);

    const mint = DIST_IFACE.parseTransaction({ data: calls[0].data });
    expect(mint.name).to.equal("mintRewardToken");
    expect([...mint.args]).to.deep.equal([OVTR.address, ethers.getAddress(DISTRIBUTOR), TOKENS(7500)]);

    const sched = REG_IFACE.parseTransaction({ data: calls[1].data });
    expect(sched.name).to.equal("scheduleEpoch");
    expect(sched.args[0]).to.equal(2n);
    expect(sched.args[1]).to.equal(s.startsAt);
    expect(sched.args[2]).to.equal(s.endsAt);
    expect([...sched.args[3]]).to.deep.equal([OVTR.address, ASSET.address]);
    expect([...sched.args[4]]).to.deep.equal([TOKENS(7500), TOKENS(3000)]);
  });

  it("lp-epoch-batch-with-asset.js: mintRewardToken, transfer, then scheduleEpoch", function () {
    const { calls } = build(true, [
      [ASSET, 3000],
      [OVTR, 7500],
    ]);
    expect(calls.map((c) => c.name)).to.deep.equal(["mintRewardToken", "transfer", "scheduleEpoch"]);
    expect(calls.map((c) => c.to)).to.deep.equal([DISTRIBUTOR, ASSET.address, REGISTRY]);

    const mint = DIST_IFACE.parseTransaction({ data: calls[0].data });
    expect([...mint.args]).to.deep.equal([OVTR.address, ethers.getAddress(DISTRIBUTOR), TOKENS(7500)]);
    const transfer = ERC20_IFACE.parseTransaction({ data: calls[1].data });
    expect(transfer.name).to.equal("transfer");
    expect([...transfer.args]).to.deep.equal([ethers.getAddress(DISTRIBUTOR), TOKENS(3000)]);
    const sched = REG_IFACE.parseTransaction({ data: calls[2].data });
    expect([...sched.args[3]]).to.deep.equal([ASSET.address, OVTR.address]);
    expect([...sched.args[4]]).to.deep.equal([TOKENS(3000), TOKENS(7500)]);
  });

  it("describes each call in whole tokens with symbols and ISO-8601 times", function () {
    const { calls } = build(true, [
      [OVTR, 7500],
      [ASSET, 3000],
    ]);
    expect(calls[0].description).to.equal(`RewardsDistributor.mintRewardToken: mint 7500 OVTR into the distributor ${ethers.getAddress(DISTRIBUTOR)}`);
    expect(calls[1].description).to.equal(`ASSET.transfer: move 3000 ASSET from the operator to the distributor ${ethers.getAddress(DISTRIBUTOR)}`);
    expect(calls[2].description).to.equal(
      `LPEpochRegistry.scheduleEpoch: epoch 2, ${iso(1_800_000_000n)} -> ${iso(1_800_604_800n)}, 7500 OVTR, 3000 ASSET`,
    );
  });

  it("an epoch with only $OVTR builds the two-call batch", function () {
    const { calls, assetAmount } = build(false, [[OVTR, 50]]);
    expect(calls.map((c) => c.name)).to.deep.equal(["mintRewardToken", "scheduleEpoch"]);
    expect(assetAmount).to.equal(0n);
  });

  describe("refusals", function () {
    const noOvtr =
      `Refused: epoch 2 emits no $OVTR (${OVTR.address}): EPOCH_AMOUNTS has no $OVTR amount, or it is 0, so there is nothing to mint. ` +
      "Schedule this epoch with scripts/lp-epoch.js instead.";
    const noAsset =
      `Refused: epoch 2 emits no $ASSET (${ASSET.address}): EPOCH_AMOUNTS has no $ASSET amount, or it is 0, so there is nothing to transfer. ` +
      "Use scripts/lp-epoch-batch.js instead.";

    it("no $OVTR amount", function () {
      expect(() => build(false, [[ASSET, 3000]])).to.throw(noOvtr);
      expect(() => build(true, [[ASSET, 3000]])).to.throw(noOvtr);
    });

    it("$OVTR amount zero", function () {
      expect(() => build(false, [[OVTR, 0]])).to.throw(noOvtr);
    });

    it("with-asset: no $ASSET amount, or zero", function () {
      expect(() => build(true, [[OVTR, 7500]])).to.throw(noAsset);
      expect(() =>
        build(true, [
          [OVTR, 7500],
          [ASSET, 0],
        ]),
      ).to.throw(noAsset);
    });

    it("a token other than $OVTR and $ASSET", function () {
      const line =
        `Refused: EPOCH_AMOUNTS names tUSD (${OTHER.address}). These batch scripts fund only $OVTR and $ASSET. ` +
        "Schedule this epoch with scripts/lp-epoch.js and fund that token separately.";
      expect(() =>
        build(false, [
          [OVTR, 7500],
          [OTHER, 10],
        ]),
      ).to.throw(line);
      expect(() =>
        build(true, [
          [OVTR, 7500],
          [ASSET, 1],
          [OTHER, 10],
        ]),
      ).to.throw(line);
    });

    it("the $OVTR minter is not the distributor proxy", function () {
      const minter = "0x00000000000000000000000000000000000000bb";
      expect(() => batch.requireDistributorIsMinter(minter, DISTRIBUTOR)).to.throw(
        `Refused: TokenOverture.minter() is ${ethers.getAddress(minter)}, not the RewardsDistributor proxy ${ethers.getAddress(DISTRIBUTOR)}, ` +
          `so mintRewardToken would revert with NotMinter(${ethers.getAddress(DISTRIBUTOR)}). ` +
          `Finish the activation first: TokenOverture.setMinter(${ethers.getAddress(DISTRIBUTOR)}) through the timelock.`,
      );
      expect(() => batch.requireDistributorIsMinter(DISTRIBUTOR.toUpperCase().replace("0X", "0x"), DISTRIBUTOR)).to.not.throw();
    });
  });
});

describe("lp-epoch-batch fundingNotes", function () {
  const base = { id: 2n, distributorAddress: DISTRIBUTOR, operator: OPERATOR, asset: ASSET };

  it("lp-epoch-batch.js with $ASSET in the epoch: one NOTE line", function () {
    const lines = batch.fundingNotes({ ...base, withAsset: false, assetAmount: TOKENS(3000) });
    expect(lines).to.deep.equal([
      `NOTE: this batch does not fund $ASSET. Epoch 2 emits 3000 ASSET. ` +
        `The distributor ${DISTRIBUTOR} must hold it before $ASSET claims are opened.`,
    ]);
  });

  it("lp-epoch-batch.js without $ASSET in the epoch: nothing", function () {
    expect(batch.fundingNotes({ ...base, withAsset: false, assetAmount: 0n })).to.deep.equal([]);
  });

  it("with-asset, the operator holds enough: nothing", function () {
    expect(batch.fundingNotes({ ...base, withAsset: true, assetAmount: TOKENS(3000), operatorBalance: TOKENS(3000) })).to.deep.equal([]);
  });

  it("with-asset, the operator is short: a WARNING with balance, amount and shortfall", function () {
    const lines = batch.fundingNotes({ ...base, withAsset: true, assetAmount: TOKENS(3000), operatorBalance: TOKENS(1000.5) });
    expect(lines).to.deep.equal([
      `WARNING: the operator ${OPERATOR} holds 1000.5 ASSET, the transfer needs 3000 ASSET, short by 1999.5 ASSET.\n` +
        "  The Safe must hold the full amount before it executes the batch. The batch is atomic, so none of its calls executes while the Safe is short.",
    ]);
  });
});

describe("lp-epoch-batch Safe Transaction Builder file", function () {
  // The test vector of the Safe Transaction Builder itself:
  // safe-global/safe-react-apps, apps/tx-builder/src/lib/checksum.test.js.
  const VECTOR = {
    version: "1.0",
    chainId: "4",
    createdAt: 1646321521061,
    meta: {
      name: "test batch file",
      txBuilderVersion: "1.4.0",
      checksum: "",
      createdFromSafeAddress: "0xDF8a1Ce35c9a6ACE153B4e0767942f1E2291a1Aa",
      createdFromOwnerAddress: "0x49d4450977E2c95362C13D3a31a09311E0Ea26A6",
    },
    transactions: [
      {
        to: "0x49d4450977E2c95362C13D3a31a09311E0Ea26A6",
        value: "0",
        contractMethod: {
          inputs: [{ internalType: "address", name: "paramAddress", type: "address" }],
          name: "testAddress",
          payable: false,
        },
        contractInputsValues: { paramAddress: "0x49d4450977E2c95362C13D3a31a09311E0Ea26A6" },
      },
      {
        to: "0x49d4450977E2c95362C13D3a31a09311E0Ea26A6",
        value: "0",
        contractMethod: {
          inputs: [{ internalType: "bool", name: "paramBool", type: "bool" }],
          name: "testBool",
          payable: false,
        },
        contractInputsValues: { paramAddress: "", paramBool: "false" },
      },
      {
        to: "0x49d4450977E2c95362C13D3a31a09311E0Ea26A6",
        value: "2000000000000000000",
        data: "0x42f4579000000000000000000000000049d4450977e2c95362c13d3a31a09311e0ea26a6",
      },
    ],
  };

  it("the checksum reproduces the Transaction Builder's own test vector", function () {
    expect(batch.batchChecksum(VECTOR)).to.equal("0x4ecbfd364aa6759983915644e73f8bd411e85a2dc306f252a387c2728c4db64c");
  });

  it("has the BatchFile shape, raw data per call, and a checksum the importer accepts", function () {
    const { calls } = build(true, [
      [OVTR, 7500],
      [ASSET, 3000],
    ]);
    const file = batch.safeBatchFile({
      chainId: 1,
      operator: OPERATOR,
      name: "LP epoch 2",
      description: "three calls",
      calls,
      createdAt: 1_800_000_000_000,
    });
    expect(Object.keys(file).sort()).to.deep.equal(["chainId", "createdAt", "meta", "transactions", "version"]);
    expect(file.version).to.equal("1.0");
    expect(file.chainId).to.equal("1");
    expect(file.createdAt).to.equal(1_800_000_000_000);
    expect(file.meta).to.deep.include({
      name: "LP epoch 2",
      description: "three calls",
      createdFromSafeAddress: OPERATOR,
      createdFromOwnerAddress: "",
    });
    expect(file.meta.checksum).to.match(/^0x[0-9a-f]{64}$/);
    expect(file.transactions).to.deep.equal(calls.map((c) => ({ to: c.to, value: "0", data: c.data })));
    // What the importer does: parse the JSON, delete meta.checksum, recompute, compare.
    const reread = JSON.parse(JSON.stringify(file, null, 2));
    expect(batch.validateBatchChecksum(reread)).to.equal(true);
    // A renamed batch still validates (the app nulls the name); a changed call does not.
    expect(batch.validateBatchChecksum({ ...reread, meta: { ...reread.meta, name: "renamed" } })).to.equal(true);
    const tampered = JSON.parse(JSON.stringify(file));
    tampered.transactions.reverse();
    expect(batch.validateBatchChecksum(tampered)).to.equal(false);
  });

  it("the default file path sits beside the deployments registry, LP_EPOCH_BATCH_FILE overrides it", function () {
    const saved = process.env.LP_EPOCH_BATCH_FILE;
    try {
      delete process.env.LP_EPOCH_BATCH_FILE;
      const registryDir = process.env.DEPLOYMENTS_FILE
        ? path.dirname(path.resolve(process.env.DEPLOYMENTS_FILE))
        : path.join(__dirname, "..", "..");
      expect(batch.batchFilePath(2n, false)).to.equal(path.join(registryDir, "lp-epoch-2-batch.json"));
      expect(batch.batchFilePath(2n, true)).to.equal(path.join(registryDir, "lp-epoch-2-batch-with-asset.json"));
      process.env.LP_EPOCH_BATCH_FILE = "some/where.json";
      expect(batch.batchFilePath(2n, true)).to.equal(path.resolve("some/where.json"));
    } finally {
      if (saved === undefined) delete process.env.LP_EPOCH_BATCH_FILE;
      else process.env.LP_EPOCH_BATCH_FILE = saved;
    }
  });
});

/**
 * The whole script flow on the in-process Hardhat network, with the fixture of
 * LPEpochRegistry.test.js (distributor, registry, $OVTR minted by the distributor proxy, $ASSET
 * mock). The run sends nothing; the test then executes the printed calls from the operator.
 */
describe("lp-epoch-batch on the in-process network", function () {
  const ENV_KEYS = [
    "LP_REGISTRY_ADDRESS",
    "LP_OVERTURE_ADDRESS",
    "LP_ASSET",
    "EPOCH_ID",
    "EPOCH_STARTS_AT",
    "EPOCH_ENDS_AT",
    "EPOCH_DURATION",
    "EPOCH_AMOUNTS",
    "LP_EPOCH1_OVTR_AMOUNT",
    "LP_EPOCH1_ASSET_AMOUNT",
    "LP_EPOCH_BATCH_FILE",
    "LP_DEPLOYER_IMPERSONATE",
  ];
  const UNSAFE_ALLOW = ["constructor", "state-variable-immutable"];
  const WEEK = 604_800;

  let saved;
  let owner, guardian, voucherSigner, operatorSafe, minter;
  let registry, distributor, overture, asset;
  let registryAddr, distributorAddr, overtureAddr, assetAddr;
  let tmpDir;

  async function startOnGrid() {
    const earliest = (await time.latest()) + 1800 + 120;
    return Math.ceil(earliest / 900) * 900;
  }

  async function runQuiet(withAsset) {
    const lines = [];
    const result = await batch.run({ withAsset, log: (...a) => lines.push(a.join(" ")) });
    return { ...result, output: lines.join("\n") };
  }

  async function execute(calls) {
    for (const c of calls) {
      await (await operatorSafe.sendTransaction({ to: c.to, value: 0, data: c.data })).wait();
    }
  }

  beforeEach(async function () {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];

    [owner, guardian, voucherSigner, operatorSafe, minter] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockERC20Decimals");
    asset = await Token.deploy("Asset", "ASSET", TOKENS(1_000_000), 18);
    assetAddr = await asset.getAddress();

    const Overture = await ethers.getContractFactory("TokenOverture");
    overture = await upgrades.deployProxy(Overture, ["Overture", "OVTR", owner.address, minter.address], {
      kind: "uups",
      unsafeAllow: ["constructor"],
    });
    overtureAddr = await overture.getAddress();

    const Distributor = await ethers.getContractFactory("RewardsDistributor");
    distributor = await upgrades.deployProxy(
      Distributor,
      [
        owner.address,
        guardian.address,
        operatorSafe.address,
        voucherSigner.address,
        assetAddr,
        [
          { token: assetAddr, conditional: true, claimsEnabled: false },
          { token: overtureAddr, conditional: false, claimsEnabled: true },
        ],
      ],
      { kind: "uups", unsafeAllow: UNSAFE_ALLOW },
    );
    distributorAddr = await distributor.getAddress();
    await (await overture.connect(owner).setMinter(distributorAddr)).wait();

    const Registry = await ethers.getContractFactory("LPEpochRegistry");
    registry = await upgrades.deployProxy(Registry, [owner.address, operatorSafe.address], {
      kind: "uups",
      constructorArgs: [distributorAddr],
      unsafeAllow: UNSAFE_ALLOW,
    });
    registryAddr = await registry.getAddress();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-epoch-batch-"));
    Object.assign(process.env, {
      LP_REGISTRY_ADDRESS: registryAddr,
      LP_OVERTURE_ADDRESS: overtureAddr,
      LP_ASSET: assetAddr,
      EPOCH_DURATION: String(WEEK),
      EPOCH_AMOUNTS: "OVTR=7500,ASSET=3000",
      LP_EPOCH_BATCH_FILE: path.join(tmpDir, "batch.json"),
    });
  });

  afterEach(function () {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lp-epoch-batch.js: sends nothing, writes the file, and the executed calls mint and schedule", async function () {
    const startsAt = await startOnGrid();
    process.env.EPOCH_STARTS_AT = String(startsAt);
    const blockBefore = await ethers.provider.getBlockNumber();

    const { calls, filePath, output } = await runQuiet(false);
    expect(await ethers.provider.getBlockNumber()).to.equal(blockBefore); // nothing was sent
    expect(await registry.epochCount()).to.equal(0n);
    expect(calls.map((c) => c.name)).to.deep.equal(["mintRewardToken", "scheduleEpoch"]);
    expect(output).to.include(`Batch for the operator ${operatorSafe.address}: 2 calls, in this order:`);
    expect(output).to.include(`schedule epoch 1: ${iso(startsAt)} -> ${iso(startsAt + WEEK)}`);
    expect(output).to.include("NOTE: this batch does not fund $ASSET. Epoch 1 emits 3000 ASSET.");
    expect(output).to.not.include("WARNING");

    const file = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(filePath).to.equal(path.join(tmpDir, "batch.json"));
    expect(file.chainId).to.equal("31337");
    expect(file.meta.createdFromSafeAddress).to.equal(operatorSafe.address);
    expect(file.transactions).to.have.length(2);
    expect(batch.validateBatchChecksum(file)).to.equal(true);

    const ovtrBefore = await overture.balanceOf(distributorAddr);
    await execute(file.transactions);
    expect((await overture.balanceOf(distributorAddr)) - ovtrBefore).to.equal(TOKENS(7500));
    expect(await asset.balanceOf(distributorAddr)).to.equal(0n);
    const e = await registry.epoch(1n);
    expect(e.startsAt).to.equal(BigInt(startsAt));
    expect(e.endsAt).to.equal(BigInt(startsAt + WEEK));
    expect(await registry.epochTokens(1n)).to.deep.equal([overtureAddr, assetAddr]);
    expect(await registry.epochAmount(1n, overtureAddr)).to.equal(TOKENS(7500));
    expect(await registry.epochAmount(1n, assetAddr)).to.equal(TOKENS(3000));
  });

  it("lp-epoch-batch-with-asset.js: the executed calls mint, transfer and schedule", async function () {
    const startsAt = await startOnGrid();
    process.env.EPOCH_STARTS_AT = String(startsAt);
    await (await asset.connect(owner).transfer(operatorSafe.address, TOKENS(3000))).wait();

    const { calls, output } = await runQuiet(true);
    expect(calls.map((c) => c.name)).to.deep.equal(["mintRewardToken", "transfer", "scheduleEpoch"]);
    expect(output).to.include(`Batch for the operator ${operatorSafe.address}: 3 calls, in this order:`);
    expect(output).to.not.include("WARNING");
    expect(output).to.not.include("NOTE");

    const ovtrBefore = await overture.balanceOf(distributorAddr);
    const assetBefore = await asset.balanceOf(distributorAddr);
    await execute(calls);
    expect((await overture.balanceOf(distributorAddr)) - ovtrBefore).to.equal(TOKENS(7500));
    expect((await asset.balanceOf(distributorAddr)) - assetBefore).to.equal(TOKENS(3000));
    const e = await registry.epoch(1n);
    expect(e.startsAt).to.equal(BigInt(startsAt));
    expect(e.endsAt).to.equal(BigInt(startsAt + WEEK));
    expect(await registry.epochTokens(1n)).to.deep.equal([overtureAddr, assetAddr]);
    expect(await registry.epochAmount(1n, assetAddr)).to.equal(TOKENS(3000));
  });

  it("with-asset and the operator short of $ASSET: a WARNING, not a refusal", async function () {
    process.env.EPOCH_STARTS_AT = String(await startOnGrid());
    await (await asset.connect(owner).transfer(operatorSafe.address, TOKENS(1000))).wait();
    const { output, calls } = await runQuiet(true);
    expect(calls).to.have.length(3);
    expect(output).to.include(`WARNING: the operator ${operatorSafe.address} holds 1000 ASSET, the transfer needs 3000 ASSET, short by 2000 ASSET.`);
  });

  it("the $OVTR minter is not the distributor: refused", async function () {
    process.env.EPOCH_STARTS_AT = String(await startOnGrid());
    await (await overture.connect(owner).setMinter(minter.address)).wait();
    let error;
    try {
      await runQuiet(false);
    } catch (e) {
      error = e;
    }
    expect(error && error.message).to.include(`Refused: TokenOverture.minter() is ${minter.address}`);
  });

  it("a call the simulation sees revert is refused with the decoded reason", async function () {
    process.env.EPOCH_STARTS_AT = String(await startOnGrid());
    // A registry whose operator is someone else: the mint simulation passes, scheduleEpoch reverts.
    const Registry = await ethers.getContractFactory("LPEpochRegistry");
    const other = await upgrades.deployProxy(Registry, [owner.address, guardian.address], {
      kind: "uups",
      constructorArgs: [distributorAddr],
      unsafeAllow: UNSAFE_ALLOW,
    });
    process.env.LP_REGISTRY_ADDRESS = await other.getAddress();
    // The batch's operator is the registry's (guardian here); the mint from it reverts first.
    let error;
    try {
      await runQuiet(false);
    } catch (e) {
      error = e;
    }
    expect(error && error.message).to.include(
      `RewardsDistributor.mintRewardToken would revert when the operator ${guardian.address} sends it: NotOperator(${guardian.address}, ${operatorSafe.address})`,
    );
  });
});
