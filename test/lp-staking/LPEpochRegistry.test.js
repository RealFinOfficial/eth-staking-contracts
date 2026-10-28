const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

/**
 * LPEpochRegistry — the on-chain emission SCHEDULE of the LP program.
 *
 * Per epoch: its start, its end, and the quantity of every reward token it emits. The operator
 * multisig writes it immediately (no timelock); the owner (the timelock) only upgrades it and
 * moves the operator. It bounds nothing: the distributor never reads it.
 *
 * Rules under test: ids issued in order and never reused; every bound on the 900-second grid;
 * an epoch is scheduled or changed only while it starts at least 30 minutes from now; live
 * epochs never overlap (gaps allowed); every amount names a token the distributor accepts;
 * bounds and cancellation only on the last live epoch.
 */
describe("LPEpochRegistry", function () {
  let registry, distributor, overture, asset;
  let owner, guardian, voucherSigner, operatorSafe, stranger, minter;
  let registryAddr, distributorAddr, overtureAddr, assetAddr;

  const INTERVAL = 900;
  const MARGIN = 1800;
  const DAY = 24 * 3600;
  const EPOCH_LENGTH = 7 * DAY; // 604,800 s = 672 intervals
  const TOKENS = (n) => ethers.parseEther(String(n));

  const UNSAFE_ALLOW = ["constructor", "state-variable-immutable"];
  const V2_UNSAFE_ALLOW = ["constructor", "state-variable-immutable", "missing-initializer"];

  const asOperator = () => registry.connect(operatorSafe);

  /// The first grid point that is at least `extra` seconds beyond the 30-minute margin. A 120 s
  /// buffer absorbs the wall-clock seconds Hardhat's automine adds between blocks.
  async function gridAfterMargin(extra = 0) {
    const now = await time.latest();
    const earliest = now + MARGIN + 120 + extra;
    return Math.ceil(earliest / INTERVAL) * INTERVAL;
  }

  async function scheduleWeek(id, startsAt, tokens = [overtureAddr, assetAddr], amounts = [TOKENS(1_000_000), TOKENS(3_000)]) {
    return asOperator().scheduleEpoch(id, startsAt, startsAt + EPOCH_LENGTH, tokens, amounts);
  }

  async function logNames(tx) {
    const receipt = await tx.wait();
    return receipt.logs
      .filter((log) => log.address === registryAddr)
      .map((log) => registry.interface.parseLog(log))
      .filter((parsed) => parsed !== null);
  }

  beforeEach(async function () {
    [owner, guardian, voucherSigner, operatorSafe, stranger, minter] = await ethers.getSigners();

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
        assetAddr, // the $ASSET the distributor's mintRewardToken refuses
        [
          { token: assetAddr, conditional: true, claimsEnabled: false },
          { token: overtureAddr, conditional: false, claimsEnabled: true },
        ],
      ],
      { kind: "uups", unsafeAllow: UNSAFE_ALLOW }
    );
    distributorAddr = await distributor.getAddress();

    const Registry = await ethers.getContractFactory("LPEpochRegistry");
    registry = await upgrades.deployProxy(Registry, [owner.address, operatorSafe.address], {
      kind: "uups",
      constructorArgs: [distributorAddr],
      unsafeAllow: UNSAFE_ALLOW,
    });
    registryAddr = await registry.getAddress();
  });

  // ─────────────────────────────────────────────────────────────
  describe("Deployment", function () {
    it("exposes the constants, the distributor, the roles and an empty schedule", async function () {
      expect(await registry.INTERVAL()).to.equal(BigInt(INTERVAL));
      expect(await registry.SCHEDULE_MARGIN()).to.equal(BigInt(MARGIN));
      expect(await registry.distributor()).to.equal(distributorAddr);
      expect(await registry.owner()).to.equal(owner.address);
      expect(await registry.pendingOwner()).to.equal(ethers.ZeroAddress);
      expect(await registry.operator()).to.equal(operatorSafe.address);
      expect(await registry.epochCount()).to.equal(0n);
      expect(await registry.lastLiveId()).to.equal(0n);
      expect(await registry.currentEpoch()).to.equal(0n);
    });

    it("announces its initial state in the proxy's own deploy tx, in order", async function () {
      const names = (await logNames(registry.deploymentTransaction())).map((p) => p.name);
      expect(names).to.deep.equal(["Upgraded", "OwnershipTransferred", "OperatorSet", "Initialized"]);
      await expect(registry.deploymentTransaction())
        .to.emit(registry, "OperatorSet")
        .withArgs(ethers.ZeroAddress, operatorSafe.address);
    });

    it("rejects a zero distributor on the IMPLEMENTATION", async function () {
      const Registry = await ethers.getContractFactory("LPEpochRegistry");
      await expect(Registry.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(Registry, "ZeroAddress");
    });

    it("rejects a zero owner or a zero operator in initialize, through the proxy", async function () {
      const Registry = await ethers.getContractFactory("LPEpochRegistry");
      await expect(
        upgrades.deployProxy(Registry, [ethers.ZeroAddress, operatorSafe.address], {
          kind: "uups",
          constructorArgs: [distributorAddr],
          unsafeAllow: UNSAFE_ALLOW,
        })
      )
        .to.be.revertedWithCustomError(Registry, "OwnableInvalidOwner")
        .withArgs(ethers.ZeroAddress);
      await expect(
        upgrades.deployProxy(Registry, [owner.address, ethers.ZeroAddress], {
          kind: "uups",
          constructorArgs: [distributorAddr],
          unsafeAllow: UNSAFE_ALLOW,
        })
      ).to.be.revertedWithCustomError(Registry, "ZeroAddress");
    });

    it("cannot initialise the bare implementation, nor the proxy twice", async function () {
      const implAddr = await upgrades.erc1967.getImplementationAddress(registryAddr);
      const impl = await ethers.getContractAt("LPEpochRegistry", implAddr);
      await expect(impl.initialize(stranger.address, stranger.address)).to.be.revertedWithCustomError(
        impl,
        "InvalidInitialization"
      );
      // The implementation carries the same immutable distributor in its bytecode.
      expect(await impl.distributor()).to.equal(distributorAddr);

      await expect(registry.initialize(stranger.address, stranger.address)).to.be.revertedWithCustomError(
        registry,
        "InvalidInitialization"
      );
    });

    it("keeps its state in the pinned ERC-7201 namespace real.lp.storage.LPEpochRegistry", async function () {
      const base =
        ethers.toBigInt(
          ethers.keccak256(
            ethers.AbiCoder.defaultAbiCoder().encode(
              ["uint256"],
              [ethers.toBigInt(ethers.keccak256(ethers.toUtf8Bytes("real.lp.storage.LPEpochRegistry"))) - 1n]
            )
          )
        ) & ~0xffn;
      expect(ethers.toBeHex(base, 32)).to.equal(
        "0x9ecda8e3fad78b619c97eff816bc5317dd5b4101194b9333568095fc1dd01f00"
      );

      await scheduleWeek(1n, await gridAfterMargin());

      // slot 0: operator (20 bytes) with epochCount (uint64) packed right after it
      const slot0 = ethers.toBigInt(await ethers.provider.getStorage(registryAddr, base));
      expect(ethers.getAddress(ethers.toBeHex(slot0 & ((1n << 160n) - 1n), 20))).to.equal(operatorSafe.address);
      expect((slot0 >> 160n) & ((1n << 64n) - 1n)).to.equal(1n);
      // slot 1: lastLiveId
      expect(ethers.toBigInt(await ethers.provider.getStorage(registryAddr, base + 1n))).to.equal(1n);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("scheduleEpoch", function () {
    it("schedules epoch 1 with its quantities, and emits EpochScheduled then one EpochAmountSet per token", async function () {
      const startsAt = await gridAfterMargin();
      const endsAt = startsAt + EPOCH_LENGTH;

      const tx = await asOperator().scheduleEpoch(
        1n,
        startsAt,
        endsAt,
        [overtureAddr, assetAddr],
        [TOKENS(1_000_000), TOKENS(3_000)]
      );

      const parsed = await logNames(tx);
      expect(parsed.map((p) => p.name)).to.deep.equal(["EpochScheduled", "EpochAmountSet", "EpochAmountSet"]);
      expect(parsed[0].args.id).to.equal(1n);
      expect(parsed[0].args.startsAt).to.equal(BigInt(startsAt));
      expect(parsed[0].args.endsAt).to.equal(BigInt(endsAt));
      expect(parsed[1].args.token).to.equal(overtureAddr);
      expect(parsed[1].args.amount).to.equal(TOKENS(1_000_000));
      expect(parsed[2].args.token).to.equal(assetAddr);
      expect(parsed[2].args.amount).to.equal(TOKENS(3_000));

      const e = await registry.epoch(1n);
      expect(e.startsAt).to.equal(BigInt(startsAt));
      expect(e.endsAt).to.equal(BigInt(endsAt));
      expect(e.prevLiveId).to.equal(0n);
      expect(e.cancelled).to.equal(false);
      expect(await registry.epochAmount(1n, overtureAddr)).to.equal(TOKENS(1_000_000));
      expect(await registry.epochAmount(1n, assetAddr)).to.equal(TOKENS(3_000));
      expect(await registry.epochTokens(1n)).to.deep.equal([overtureAddr, assetAddr]);
      expect(await registry.epochCount()).to.equal(1n);
      expect(await registry.lastLiveId()).to.equal(1n);
    });

    it("schedules epoch 2 directly after epoch 1, linked back to it", async function () {
      const start1 = await gridAfterMargin();
      await scheduleWeek(1n, start1);
      const start2 = start1 + EPOCH_LENGTH;
      await scheduleWeek(2n, start2, [overtureAddr, assetAddr], [TOKENS(500_000), TOKENS(3_000)]);

      const e2 = await registry.epoch(2n);
      expect(e2.startsAt).to.equal(BigInt(start2));
      expect(e2.prevLiveId).to.equal(1n);
      expect(await registry.epochCount()).to.equal(2n);
      expect(await registry.lastLiveId()).to.equal(2n);
      expect(await registry.epochAmount(2n, overtureAddr)).to.equal(TOKENS(500_000));
    });

    it("allows a gap between two epochs", async function () {
      const start1 = await gridAfterMargin();
      await scheduleWeek(1n, start1);
      const start2 = start1 + EPOCH_LENGTH + 3 * DAY;
      await scheduleWeek(2n, start2);
      expect((await registry.epoch(2n)).startsAt).to.equal(BigInt(start2));
    });

    it("accepts an empty token list (quantities can follow) and a zero amount", async function () {
      const start = await gridAfterMargin();
      await asOperator().scheduleEpoch(1n, start, start + EPOCH_LENGTH, [], []);
      expect(await registry.epochTokens(1n)).to.deep.equal([]);

      await asOperator().scheduleEpoch(2n, start + EPOCH_LENGTH, start + 2 * EPOCH_LENGTH, [overtureAddr], [0n]);
      expect(await registry.epochTokens(2n)).to.deep.equal([overtureAddr]);
      expect(await registry.epochAmount(2n, overtureAddr)).to.equal(0n);
    });

    it("is operator only — the owner (the timelock) and a stranger are rejected", async function () {
      const start = await gridAfterMargin();
      for (const caller of [owner, stranger, guardian]) {
        await expect(
          registry.connect(caller).scheduleEpoch(1n, start, start + EPOCH_LENGTH, [], [])
        )
          .to.be.revertedWithCustomError(registry, "NotOperator")
          .withArgs(caller.address, operatorSafe.address);
      }
    });

    it("issues ids in order: anything but epochCount + 1 is rejected", async function () {
      const start = await gridAfterMargin();
      for (const id of [0n, 2n, 7n]) {
        await expect(asOperator().scheduleEpoch(id, start, start + EPOCH_LENGTH, [], []))
          .to.be.revertedWithCustomError(registry, "UnexpectedEpochId")
          .withArgs(id, 1n);
      }
      await scheduleWeek(1n, start);
      // An id is never issued twice.
      await expect(
        asOperator().scheduleEpoch(1n, start + EPOCH_LENGTH, start + 2 * EPOCH_LENGTH, [], [])
      )
        .to.be.revertedWithCustomError(registry, "UnexpectedEpochId")
        .withArgs(1n, 2n);
    });

    it("rejects tokens and amounts of different lengths", async function () {
      const start = await gridAfterMargin();
      await expect(
        asOperator().scheduleEpoch(1n, start, start + EPOCH_LENGTH, [overtureAddr, assetAddr], [1n])
      )
        .to.be.revertedWithCustomError(registry, "LengthMismatch")
        .withArgs(2n, 1n);
    });

    it("keeps every bound on the 900-second grid", async function () {
      const start = await gridAfterMargin();
      await expect(asOperator().scheduleEpoch(1n, start + 1, start + EPOCH_LENGTH, [], []))
        .to.be.revertedWithCustomError(registry, "NotOnGrid")
        .withArgs(start + 1);
      await expect(asOperator().scheduleEpoch(1n, start, start + EPOCH_LENGTH - 60, [], []))
        .to.be.revertedWithCustomError(registry, "NotOnGrid")
        .withArgs(start + EPOCH_LENGTH - 60);
    });

    it("requires endsAt after startsAt", async function () {
      const start = await gridAfterMargin();
      await expect(asOperator().scheduleEpoch(1n, start, start, [], []))
        .to.be.revertedWithCustomError(registry, "InvalidBounds")
        .withArgs(start, start);
      await expect(asOperator().scheduleEpoch(1n, start, start - INTERVAL, [], []))
        .to.be.revertedWithCustomError(registry, "InvalidBounds")
        .withArgs(start, start - INTERVAL);
    });

    it("accepts a start exactly 30 minutes away and rejects one a second closer", async function () {
      // Pin the next block on a grid point T: then T + 1800 is on the grid too.
      const base = Math.ceil(((await time.latest()) + 600) / INTERVAL) * INTERVAL;
      const startsAt = base + MARGIN;

      // One second late: now = T + 1, earliest start = T + 1801 > T + 1800.
      await time.setNextBlockTimestamp(base + 1);
      await expect(asOperator().scheduleEpoch(1n, startsAt, startsAt + EPOCH_LENGTH, [], []))
        .to.be.revertedWithCustomError(registry, "StartTooSoon")
        .withArgs(startsAt, base + 1 + MARGIN);

      // Fresh registry, on time: now = T' with T' + 1800 = its start, exactly the margin.
      const base2 = base + INTERVAL;
      await time.setNextBlockTimestamp(base2);
      await asOperator().scheduleEpoch(1n, base2 + MARGIN, base2 + MARGIN + EPOCH_LENGTH, [], []);
      expect((await registry.epoch(1n)).startsAt).to.equal(BigInt(base2 + MARGIN));
    });

    it("rejects a start in the past", async function () {
      const past = Math.floor((await time.latest()) / INTERVAL) * INTERVAL;
      await expect(asOperator().scheduleEpoch(1n, past, past + EPOCH_LENGTH, [], [])).to.be.revertedWithCustomError(
        registry,
        "StartTooSoon"
      );
    });

    it("never lets live epochs overlap", async function () {
      // A day of room, so a start BEFORE epoch 1 is still outside the margin and the overlap
      // rule — not the margin — is what rejects it.
      const start1 = await gridAfterMargin(DAY);
      await scheduleWeek(1n, start1);
      const end1 = start1 + EPOCH_LENGTH;

      await expect(asOperator().scheduleEpoch(2n, end1 - INTERVAL, end1 + EPOCH_LENGTH, [], []))
        .to.be.revertedWithCustomError(registry, "OverlapsPreviousEpoch")
        .withArgs(end1 - INTERVAL, end1);
      // Starting before epoch 1 entirely is an overlap of the order, rejected the same way.
      await expect(asOperator().scheduleEpoch(2n, start1 - INTERVAL * 4, start1 - INTERVAL * 2, [], []))
        .to.be.revertedWithCustomError(registry, "OverlapsPreviousEpoch")
        .withArgs(start1 - INTERVAL * 4, end1);
    });

    it("rejects a token the distributor never registered, naming it", async function () {
      const start = await gridAfterMargin();
      await expect(asOperator().scheduleEpoch(1n, start, start + EPOCH_LENGTH, [stranger.address], [1n]))
        .to.be.revertedWithCustomError(registry, "UnknownRewardToken")
        .withArgs(stranger.address);
    });

    it("rejects a registered token the owner took off the schedule", async function () {
      await distributor.setRewardTokenEnabled(assetAddr, false);
      const start = await gridAfterMargin();
      await expect(asOperator().scheduleEpoch(1n, start, start + EPOCH_LENGTH, [assetAddr], [1n]))
        .to.be.revertedWithCustomError(registry, "UnknownRewardToken")
        .withArgs(assetAddr);
    });

    it("rejects the same token twice in one epoch", async function () {
      const start = await gridAfterMargin();
      await expect(
        asOperator().scheduleEpoch(1n, start, start + EPOCH_LENGTH, [overtureAddr, assetAddr, overtureAddr], [1n, 2n, 3n])
      )
        .to.be.revertedWithCustomError(registry, "DuplicateToken")
        .withArgs(overtureAddr);
    });

    it("schedules a token the distributor added later, once it is registered", async function () {
      const Token = await ethers.getContractFactory("MockERC20Decimals");
      const usdc = await Token.deploy("USD Coin", "USDC", 10n ** 12n, 6);
      const usdcAddr = await usdc.getAddress();
      const start = await gridAfterMargin();

      await expect(asOperator().scheduleEpoch(1n, start, start + EPOCH_LENGTH, [usdcAddr], [1n]))
        .to.be.revertedWithCustomError(registry, "UnknownRewardToken")
        .withArgs(usdcAddr);

      await distributor.addRewardToken(usdcAddr, false, true);
      await asOperator().scheduleEpoch(1n, start, start + EPOCH_LENGTH, [usdcAddr], [5_000n * 10n ** 6n]);
      expect(await registry.epochAmount(1n, usdcAddr)).to.equal(5_000n * 10n ** 6n);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("setEpochAmount", function () {
    let start1, start2;

    beforeEach(async function () {
      start1 = await gridAfterMargin(DAY);
      await scheduleWeek(1n, start1, [overtureAddr], [TOKENS(1_000_000)]);
      start2 = start1 + EPOCH_LENGTH;
      await scheduleWeek(2n, start2, [overtureAddr], [TOKENS(500_000)]);
    });

    it("changes a quantity on ANY live epoch not yet locked — not only the last", async function () {
      await expect(asOperator().setEpochAmount(1n, overtureAddr, TOKENS(1_200_000)))
        .to.emit(registry, "EpochAmountSet")
        .withArgs(1n, overtureAddr, TOKENS(1_200_000));
      expect(await registry.epochAmount(1n, overtureAddr)).to.equal(TOKENS(1_200_000));
      // The token list does not grow when an existing token is re-set.
      expect(await registry.epochTokens(1n)).to.deep.equal([overtureAddr]);
    });

    it("adds a token to an epoch that did not name it", async function () {
      await asOperator().setEpochAmount(2n, assetAddr, TOKENS(3_000));
      expect(await registry.epochTokens(2n)).to.deep.equal([overtureAddr, assetAddr]);
      expect(await registry.epochAmount(2n, assetAddr)).to.equal(TOKENS(3_000));
    });

    it("accepts zero", async function () {
      await asOperator().setEpochAmount(1n, overtureAddr, 0n);
      expect(await registry.epochAmount(1n, overtureAddr)).to.equal(0n);
      expect(await registry.epochTokens(1n)).to.deep.equal([overtureAddr]);
    });

    it("is operator only", async function () {
      await expect(registry.connect(owner).setEpochAmount(1n, overtureAddr, 1n))
        .to.be.revertedWithCustomError(registry, "NotOperator")
        .withArgs(owner.address, operatorSafe.address);
    });

    it("rejects an id that was never issued", async function () {
      for (const id of [0n, 3n]) {
        await expect(asOperator().setEpochAmount(id, overtureAddr, 1n))
          .to.be.revertedWithCustomError(registry, "UnknownEpoch")
          .withArgs(id);
      }
    });

    it("rejects an unregistered token", async function () {
      await expect(asOperator().setEpochAmount(1n, stranger.address, 1n))
        .to.be.revertedWithCustomError(registry, "UnknownRewardToken")
        .withArgs(stranger.address);
    });

    it("rejects a cancelled epoch", async function () {
      await asOperator().cancelEpoch(2n);
      await expect(asOperator().setEpochAmount(2n, overtureAddr, 1n))
        .to.be.revertedWithCustomError(registry, "EpochIsCancelled")
        .withArgs(2n);
    });

    it("freezes once the epoch is closer than the margin: exactly start − 1800 is the last accepted second", async function () {
      await time.setNextBlockTimestamp(start1 - MARGIN);
      await asOperator().setEpochAmount(1n, overtureAddr, TOKENS(1));
      expect(await registry.epochAmount(1n, overtureAddr)).to.equal(TOKENS(1));

      await time.setNextBlockTimestamp(start1 - MARGIN + 1);
      await expect(asOperator().setEpochAmount(1n, overtureAddr, TOKENS(2)))
        .to.be.revertedWithCustomError(registry, "StartTooSoon")
        .withArgs(start1, start1 - MARGIN + 1 + MARGIN);

      // Epoch 2 is still far enough out to change.
      await asOperator().setEpochAmount(2n, overtureAddr, TOKENS(2));
    });

    it("cannot touch a running epoch", async function () {
      await time.increaseTo(start1 + DAY);
      await expect(asOperator().setEpochAmount(1n, overtureAddr, 0n)).to.be.revertedWithCustomError(
        registry,
        "StartTooSoon"
      );
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("updateEpochBounds", function () {
    let start1, start2;

    beforeEach(async function () {
      start1 = await gridAfterMargin(DAY);
      await scheduleWeek(1n, start1);
      start2 = start1 + EPOCH_LENGTH;
      await scheduleWeek(2n, start2);
    });

    it("moves the bounds of the LAST live epoch and emits EpochUpdated with the full new state", async function () {
      const newStart = start2 + DAY;
      const newEnd = newStart + 14 * DAY;
      await expect(asOperator().updateEpochBounds(2n, newStart, newEnd))
        .to.emit(registry, "EpochUpdated")
        .withArgs(2n, newStart, newEnd);
      const e2 = await registry.epoch(2n);
      expect(e2.startsAt).to.equal(BigInt(newStart));
      expect(e2.endsAt).to.equal(BigInt(newEnd));
      expect(e2.prevLiveId).to.equal(1n);
      // Quantities are untouched by a bounds change.
      expect(await registry.epochAmount(2n, overtureAddr)).to.equal(TOKENS(1_000_000));
    });

    it("refuses any epoch but the last live one", async function () {
      await expect(asOperator().updateEpochBounds(1n, start1 + INTERVAL, start2))
        .to.be.revertedWithCustomError(registry, "NotLastLiveEpoch")
        .withArgs(1n, 2n);
      for (const id of [0n, 3n]) {
        await expect(asOperator().updateEpochBounds(id, start2, start2 + EPOCH_LENGTH))
          .to.be.revertedWithCustomError(registry, "NotLastLiveEpoch")
          .withArgs(id, 2n);
      }
    });

    it("applies the scheduling rules to the new bounds: grid, order, margin, no overlap", async function () {
      await expect(asOperator().updateEpochBounds(2n, start2 + 1, start2 + EPOCH_LENGTH))
        .to.be.revertedWithCustomError(registry, "NotOnGrid")
        .withArgs(start2 + 1);
      await expect(asOperator().updateEpochBounds(2n, start2, start2))
        .to.be.revertedWithCustomError(registry, "InvalidBounds")
        .withArgs(start2, start2);
      await expect(asOperator().updateEpochBounds(2n, start2 - INTERVAL, start2 + EPOCH_LENGTH))
        .to.be.revertedWithCustomError(registry, "OverlapsPreviousEpoch")
        .withArgs(start2 - INTERVAL, start2);
      const tooSoon = Math.ceil(((await time.latest()) + 60) / INTERVAL) * INTERVAL;
      await expect(asOperator().updateEpochBounds(1n, tooSoon, tooSoon + INTERVAL)).to.be.revertedWithCustomError(
        registry,
        "NotLastLiveEpoch"
      );
    });

    it("may pull the start earlier, as long as the margin and the previous end allow", async function () {
      // Cancel 2 so 1 is last; then pull 1 earlier to the first legal grid point.
      await asOperator().cancelEpoch(2n);
      const earlier = await gridAfterMargin();
      await asOperator().updateEpochBounds(1n, earlier, earlier + EPOCH_LENGTH);
      expect((await registry.epoch(1n)).startsAt).to.equal(BigInt(earlier));
    });

    it("freezes once the epoch is within the margin", async function () {
      await asOperator().cancelEpoch(2n);
      await time.setNextBlockTimestamp(start1 - MARGIN + 1);
      await expect(asOperator().updateEpochBounds(1n, start1 + DAY, start1 + DAY + EPOCH_LENGTH))
        .to.be.revertedWithCustomError(registry, "StartTooSoon")
        .withArgs(start1, start1 + 1);
    });

    it("is operator only", async function () {
      await expect(registry.connect(owner).updateEpochBounds(2n, start2, start2 + DAY))
        .to.be.revertedWithCustomError(registry, "NotOperator")
        .withArgs(owner.address, operatorSafe.address);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("cancelEpoch", function () {
    let start1, start2;

    beforeEach(async function () {
      start1 = await gridAfterMargin(DAY);
      await scheduleWeek(1n, start1);
      start2 = start1 + EPOCH_LENGTH;
      await scheduleWeek(2n, start2);
    });

    it("cancels the last live epoch and relinks lastLiveId to the one before it", async function () {
      await expect(asOperator().cancelEpoch(2n)).to.emit(registry, "EpochCancelled").withArgs(2n);

      const e2 = await registry.epoch(2n);
      expect(e2.cancelled).to.equal(true);
      expect(await registry.lastLiveId()).to.equal(1n);
      expect(await registry.epochCount()).to.equal(2n);
      // The record and its amounts stay readable.
      expect(await registry.epochAmount(2n, overtureAddr)).to.equal(TOKENS(1_000_000));
      expect(await registry.epochTokens(2n)).to.deep.equal([overtureAddr, assetAddr]);
    });

    it("never reuses an id: the replacement is epoch 3, linked to epoch 1", async function () {
      await asOperator().cancelEpoch(2n);

      await expect(scheduleWeek(2n, start2))
        .to.be.revertedWithCustomError(registry, "UnexpectedEpochId")
        .withArgs(2n, 3n);

      // Epoch 3 may take the slot epoch 2 held, because 2 is no longer live.
      await scheduleWeek(3n, start2);
      const e3 = await registry.epoch(3n);
      expect(e3.prevLiveId).to.equal(1n);
      expect(await registry.lastLiveId()).to.equal(3n);
    });

    it("refuses any epoch but the last live one, a cancelled one included", async function () {
      await expect(asOperator().cancelEpoch(1n))
        .to.be.revertedWithCustomError(registry, "NotLastLiveEpoch")
        .withArgs(1n, 2n);
      await asOperator().cancelEpoch(2n);
      await expect(asOperator().cancelEpoch(2n))
        .to.be.revertedWithCustomError(registry, "NotLastLiveEpoch")
        .withArgs(2n, 1n);
      await expect(asOperator().updateEpochBounds(2n, start2, start2 + DAY))
        .to.be.revertedWithCustomError(registry, "NotLastLiveEpoch")
        .withArgs(2n, 1n);
    });

    it("cancels back to an empty schedule, after which any future start is legal again", async function () {
      await asOperator().cancelEpoch(2n);
      await asOperator().cancelEpoch(1n);
      expect(await registry.lastLiveId()).to.equal(0n);
      await expect(asOperator().cancelEpoch(0n))
        .to.be.revertedWithCustomError(registry, "NotLastLiveEpoch")
        .withArgs(0n, 0n);

      // With no live epoch, an earlier start than the cancelled ones is fine.
      const earlier = await gridAfterMargin();
      await scheduleWeek(3n, earlier);
      expect((await registry.epoch(3n)).prevLiveId).to.equal(0n);
    });

    it("freezes once the epoch is within the margin", async function () {
      await asOperator().cancelEpoch(2n);
      await time.setNextBlockTimestamp(start1 - MARGIN + 1);
      await expect(asOperator().cancelEpoch(1n))
        .to.be.revertedWithCustomError(registry, "StartTooSoon")
        .withArgs(start1, start1 + 1);
    });

    it("is operator only", async function () {
      await expect(registry.connect(stranger).cancelEpoch(2n))
        .to.be.revertedWithCustomError(registry, "NotOperator")
        .withArgs(stranger.address, operatorSafe.address);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("currentEpoch", function () {
    it("follows the schedule across starts, ends, gaps and cancellations", async function () {
      const start1 = await gridAfterMargin();
      const end1 = start1 + EPOCH_LENGTH;
      await scheduleWeek(1n, start1);
      // Epoch 2 directly after 1, epoch 3 after a gap of one day.
      await scheduleWeek(2n, end1);
      const start3 = end1 + EPOCH_LENGTH + DAY;
      await scheduleWeek(3n, start3);
      // And a fourth one, cancelled: it must never be reported.
      await scheduleWeek(4n, start3 + EPOCH_LENGTH);
      await asOperator().cancelEpoch(4n);

      expect(await registry.currentEpoch()).to.equal(0n); // before epoch 1

      await time.increaseTo(start1 - 1);
      expect(await registry.currentEpoch()).to.equal(0n);
      await time.increaseTo(start1); // the first second is inside
      expect(await registry.currentEpoch()).to.equal(1n);
      await time.increaseTo(end1 - 1);
      expect(await registry.currentEpoch()).to.equal(1n);
      await time.increaseTo(end1); // end is exclusive; epoch 2 starts on the same second
      expect(await registry.currentEpoch()).to.equal(2n);
      await time.increaseTo(end1 + EPOCH_LENGTH); // the gap
      expect(await registry.currentEpoch()).to.equal(0n);
      await time.increaseTo(start3 + 1);
      expect(await registry.currentEpoch()).to.equal(3n);
      await time.increaseTo(start3 + EPOCH_LENGTH + 1); // where cancelled epoch 4 would have run
      expect(await registry.currentEpoch()).to.equal(0n);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Owner tier", function () {
    it("setOperator is owner only, rejects zero and moves every operator function", async function () {
      await expect(asOperator().setOperator(stranger.address))
        .to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount")
        .withArgs(operatorSafe.address);
      await expect(registry.setOperator(ethers.ZeroAddress)).to.be.revertedWithCustomError(registry, "ZeroAddress");

      await expect(registry.setOperator(stranger.address))
        .to.emit(registry, "OperatorSet")
        .withArgs(operatorSafe.address, stranger.address);
      expect(await registry.operator()).to.equal(stranger.address);

      const start = await gridAfterMargin();
      await expect(asOperator().scheduleEpoch(1n, start, start + EPOCH_LENGTH, [], []))
        .to.be.revertedWithCustomError(registry, "NotOperator")
        .withArgs(operatorSafe.address, stranger.address);
      await registry.connect(stranger).scheduleEpoch(1n, start, start + EPOCH_LENGTH, [], []);
    });

    it("refuses renounceOwnership", async function () {
      await expect(registry.renounceOwnership()).to.be.revertedWithCustomError(registry, "RenounceDisabled");
      await expect(registry.connect(stranger).renounceOwnership())
        .to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount")
        .withArgs(stranger.address);
    });

    it("is Ownable2Step: a nomination changes nothing until accepted", async function () {
      await registry.transferOwnership(stranger.address);
      expect(await registry.owner()).to.equal(owner.address);
      await registry.connect(stranger).acceptOwnership();
      expect(await registry.owner()).to.equal(stranger.address);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Upgradeability", function () {
    async function v2Factory() {
      return ethers.getContractFactory("LPEpochRegistryV2Mock");
    }

    it("passes the plugin's implementation-safety check, V1 and V2", async function () {
      await upgrades.validateImplementation(await ethers.getContractFactory("LPEpochRegistry"), {
        kind: "uups",
        constructorArgs: [distributorAddr],
        unsafeAllow: UNSAFE_ALLOW,
      });
      await upgrades.validateImplementation(await v2Factory(), {
        kind: "uups",
        constructorArgs: [distributorAddr],
        unsafeAllow: V2_UNSAFE_ALLOW,
      });
    });

    it("keeps every epoch, amount, token list, count, lastLiveId and role across upgradeProxy", async function () {
      const start1 = await gridAfterMargin(DAY);
      await scheduleWeek(1n, start1);
      await scheduleWeek(2n, start1 + EPOCH_LENGTH, [overtureAddr], [TOKENS(7)]);
      await scheduleWeek(3n, start1 + 2 * EPOCH_LENGTH);
      await asOperator().cancelEpoch(3n);

      const upgraded = await upgrades.upgradeProxy(registryAddr, await v2Factory(), {
        kind: "uups",
        constructorArgs: [distributorAddr],
        unsafeAllow: V2_UNSAFE_ALLOW,
      });

      expect(await upgraded.version()).to.equal(2n);
      expect(await upgraded.epochCount()).to.equal(3n);
      expect(await upgraded.lastLiveId()).to.equal(2n);
      expect((await upgraded.epoch(1n)).startsAt).to.equal(BigInt(start1));
      expect((await upgraded.epoch(3n)).cancelled).to.equal(true);
      expect(await upgraded.epochAmount(2n, overtureAddr)).to.equal(TOKENS(7));
      expect(await upgraded.epochTokens(1n)).to.deep.equal([overtureAddr, assetAddr]);
      expect(await upgraded.owner()).to.equal(owner.address);
      expect(await upgraded.operator()).to.equal(operatorSafe.address);
      expect(await upgraded.distributor()).to.equal(distributorAddr);

      // The schedule keeps working through the new code, ids continuing where they stopped.
      await upgraded
        .connect(operatorSafe)
        .scheduleEpoch(4n, start1 + 2 * EPOCH_LENGTH, start1 + 3 * EPOCH_LENGTH, [], []);
      expect((await upgraded.epoch(4n)).prevLiveId).to.equal(2n);
    });

    it("upgrades only through the owner, and runs the V2 reinitializer once", async function () {
      const V2 = await v2Factory();
      const impl = await V2.deploy(distributorAddr);
      await impl.waitForDeployment();
      const implAddr = await impl.getAddress();

      for (const caller of [operatorSafe, stranger]) {
        await expect(registry.connect(caller).upgradeToAndCall(implAddr, "0x"))
          .to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount")
          .withArgs(caller.address);
      }

      const data = impl.interface.encodeFunctionData("initializeV2", [5n]);
      await expect(registry.upgradeToAndCall(implAddr, data)).to.emit(registry, "Upgraded").withArgs(implAddr);
      const v2 = await ethers.getContractAt("LPEpochRegistryV2Mock", registryAddr);
      expect(await v2.upgradeMarker()).to.equal(5n);
      await expect(v2.initializeV2(6n)).to.be.revertedWithCustomError(v2, "InvalidInitialization");
    });
  });
});
