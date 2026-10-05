const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("BonusEscrow", function () {
  let escrow, escrowAddr, bonus, bonusAddr;
  let owner, adapter, alice, bob, keeper, treasury;

  const TOKENS = (n) => ethers.parseEther(String(n));

  /// Purchase ids are opaque bytes32 in the escrow; the adapter derives them from the
  /// ApeBond purchase. Any distinct value is a distinct reservation.
  const ID = (label) => ethers.id(label);

  const SUPPLY = TOKENS(10_000_000);
  const FUNDING = TOKENS(1_000);
  const BONUS = TOKENS(100);

  /// Deploys an escrow UUPS proxy. `constructorArgs` is the implementation's one immutable;
  /// `unsafeAllow` names exactly the two patterns the spec chose deliberately.
  ///
  /// `adapterAddress` is what `initialize` writes. It defaults to address(0) — the reserve
  /// path closed, which is what every test below that calls `setAdapter` itself wants — and is
  /// passed explicitly by the born-pointing test, which is the shape the deploy script uses.
  async function deployEscrowProxy(tokenAddress, ownerAddress, adapterAddress = ethers.ZeroAddress) {
    const Escrow = await ethers.getContractFactory("BonusEscrow");
    return upgrades.deployProxy(Escrow, [ownerAddress, adapterAddress], {
      kind: "uups",
      constructorArgs: [tokenAddress],
      unsafeAllow: ["constructor", "state-variable-immutable"],
    });
  }

  const asAdapter = () => escrow.connect(adapter);

  /// A cliff `secs` into the future, measured from the chain's own clock.
  async function cliffIn(secs) {
    return BigInt(await time.latest()) + BigInt(secs);
  }

  async function reserve(id, beneficiary, amount = BONUS, unlockAt) {
    const cliff = unlockAt ?? (await cliffIn(3600));
    await asAdapter().reserve(id, beneficiary.address ?? beneficiary, amount, cliff);
    return cliff;
  }

  beforeEach(async function () {
    [owner, adapter, alice, bob, keeper, treasury] = await ethers.getSigners();

    const BonusFactory = await ethers.getContractFactory("MockERC20Decimals");
    bonus = await BonusFactory.deploy("Bonus Token", "BONUS", SUPPLY, 18);
    bonusAddr = await bonus.getAddress();

    escrow = await deployEscrowProxy(bonusAddr, owner.address);
    escrowAddr = await escrow.getAddress();

    // The campaign is funded FIRST and pointed at an adapter second — the order the escrow
    // is designed around, since a reservation may never outrun the money behind it.
    await bonus.transfer(escrowAddr, FUNDING);
  });

  // ─────────────────────────────────────────────────────────────
  describe("Deployment", function () {
    it("exposes the bonus token, the owner and an empty book", async function () {
      expect(await escrow.bonusToken()).to.equal(bonusAddr);
      expect(await escrow.owner()).to.equal(owner.address);
      expect(await escrow.pendingOwner()).to.equal(ethers.ZeroAddress);
      expect(await escrow.adapter()).to.equal(ethers.ZeroAddress);
      expect(await escrow.totalReserved()).to.equal(0n);
    });

    it("starts with the reserve path closed, and says so in the proxy's own deploy tx", async function () {
      // `initialize` runs inside the proxy's deployment transaction, so its events are that
      // transaction's events — there is no second block to look in, and the `AdapterSet`
      // history is complete from block one.
      await expect(escrow.deploymentTransaction())
        .to.emit(escrow, "AdapterSet")
        .withArgs(ethers.ZeroAddress, ethers.ZeroAddress);

      await expect(asAdapter().reserve(ID("p1"), alice.address, BONUS, await cliffIn(3600)))
        .to.be.revertedWithCustomError(escrow, "NotAdapter")
        .withArgs(adapter.address, ethers.ZeroAddress);
    });

    it("can instead be BORN pointing at an adapter, which is what the deploy script does", async function () {
      // Production's escrow is born owned by the timelock and `setAdapter` is owner-tier, so
      // the deploying key never gets a chance to wire it: the adapter's address is predicted
      // from the deployer's nonce and passed to `initialize`. This is that shape, with the
      // adapter address known in advance because the test picks it.
      const born = await deployEscrowProxy(bonusAddr, owner.address, adapter.address);
      const bornAddr = await born.getAddress();

      await expect(born.deploymentTransaction())
        .to.emit(born, "AdapterSet")
        .withArgs(ethers.ZeroAddress, adapter.address);
      expect(await born.adapter()).to.equal(adapter.address);

      // And it works with no owner transaction at all: fund it, and the adapter can reserve.
      await bonus.transfer(bornAddr, FUNDING);
      await born.connect(adapter).reserve(ID("born"), alice.address, BONUS, await cliffIn(3600));
      expect(await born.totalReserved()).to.equal(BONUS);
    });

    it("rejects a zero bonus token on the IMPLEMENTATION, before any proxy exists", async function () {
      const Escrow = await ethers.getContractFactory("BonusEscrow");

      await expect(Escrow.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        Escrow,
        "ZeroAddress"
      );
    });

    it("rejects a zero owner in initialize, through the proxy", async function () {
      const Escrow = await ethers.getContractFactory("BonusEscrow");

      await expect(deployEscrowProxy(bonusAddr, ethers.ZeroAddress))
        .to.be.revertedWithCustomError(Escrow, "OwnableInvalidOwner")
        .withArgs(ethers.ZeroAddress);
    });

    it("cannot be initialised a second time, on the proxy or on the implementation", async function () {
      await expect(
        escrow.initialize(alice.address, adapter.address)
      ).to.be.revertedWithCustomError(escrow, "InvalidInitialization");

      const implAddr = await upgrades.erc1967.getImplementationAddress(escrowAddr);
      const impl = await ethers.getContractAt("BonusEscrow", implAddr);
      await expect(
        impl.initialize(alice.address, adapter.address)
      ).to.be.revertedWithCustomError(impl, "InvalidInitialization");
    });

    it("refuses renounceOwnership, so the upgrade path can never be frozen", async function () {
      await expect(escrow.renounceOwnership()).to.be.revertedWithCustomError(
        escrow,
        "RenounceDisabled"
      );
      expect(await escrow.owner()).to.equal(owner.address);

      // A stranger still gets the standard Ownable rejection, not the reason.
      await expect(escrow.connect(alice).renounceOwnership())
        .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount")
        .withArgs(alice.address);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("setAdapter", function () {
    it("stores the adapter and announces both sides", async function () {
      await expect(escrow.setAdapter(adapter.address))
        .to.emit(escrow, "AdapterSet")
        .withArgs(ethers.ZeroAddress, adapter.address);
      expect(await escrow.adapter()).to.equal(adapter.address);

      await expect(escrow.setAdapter(keeper.address))
        .to.emit(escrow, "AdapterSet")
        .withArgs(adapter.address, keeper.address);
      expect(await escrow.adapter()).to.equal(keeper.address);
    });

    it("is owner-only — not the adapter's own call to make", async function () {
      await escrow.setAdapter(adapter.address);

      for (const caller of [adapter, alice]) {
        await expect(escrow.connect(caller).setAdapter(caller.address))
          .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount")
          .withArgs(caller.address);
      }
      expect(await escrow.adapter()).to.equal(adapter.address);
    });

    it("revokes the old adapter the moment a new one is pointed at", async function () {
      await escrow.setAdapter(adapter.address);
      await escrow.setAdapter(keeper.address);

      await expect(asAdapter().reserve(ID("p1"), alice.address, BONUS, await cliffIn(3600)))
        .to.be.revertedWithCustomError(escrow, "NotAdapter")
        .withArgs(adapter.address, keeper.address);

      await escrow.connect(keeper).reserve(ID("p1"), alice.address, BONUS, await cliffIn(3600));
      expect(await escrow.totalReserved()).to.equal(BONUS);
    });

    it("closes the reserve path on zero, and leaves standing reservations untouched", async function () {
      await escrow.setAdapter(adapter.address);
      const cliff = await reserve(ID("p1"), alice);

      await expect(escrow.setAdapter(ethers.ZeroAddress))
        .to.emit(escrow, "AdapterSet")
        .withArgs(adapter.address, ethers.ZeroAddress);

      await expect(asAdapter().reserve(ID("p2"), bob.address, BONUS, await cliffIn(3600)))
        .to.be.revertedWithCustomError(escrow, "NotAdapter")
        .withArgs(adapter.address, ethers.ZeroAddress);

      // The bonus already promised is still owed, and still payable on time.
      expect(await escrow.totalReserved()).to.equal(BONUS);
      await time.increaseTo(cliff);
      await expect(escrow.connect(keeper).claim(ID("p1")))
        .to.emit(escrow, "BonusClaimed")
        .withArgs(ID("p1"), alice.address, BONUS);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("reserve", function () {
    beforeEach(async function () {
      await escrow.setAdapter(adapter.address);
    });

    it("records the reservation and emits its four fields", async function () {
      const cliff = await cliffIn(3600);

      await expect(asAdapter().reserve(ID("p1"), alice.address, BONUS, cliff))
        .to.emit(escrow, "BonusReserved")
        .withArgs(ID("p1"), alice.address, BONUS, cliff);

      const [beneficiary, amount, unlockAt, claimed] = await escrow.reservationOf(ID("p1"));
      expect(beneficiary).to.equal(alice.address);
      expect(amount).to.equal(BONUS);
      expect(unlockAt).to.equal(cliff);
      expect(claimed).to.equal(false);
      expect(await escrow.totalReserved()).to.equal(BONUS);
    });

    it("is callable by the adapter alone — the owner included", async function () {
      for (const caller of [owner, alice]) {
        await expect(
          escrow.connect(caller).reserve(ID("p1"), alice.address, BONUS, await cliffIn(3600))
        )
          .to.be.revertedWithCustomError(escrow, "NotAdapter")
          .withArgs(caller.address, adapter.address);
      }
    });

    it("sums every outstanding reservation into totalReserved", async function () {
      await reserve(ID("p1"), alice, TOKENS(100));
      await reserve(ID("p2"), bob, TOKENS(250));
      await reserve(ID("p3"), alice, TOKENS(25));

      expect(await escrow.totalReserved()).to.equal(TOKENS(375));
      expect((await escrow.reservationOf(ID("p2")))[0]).to.equal(bob.address);
    });

    it("spends a purchase id exactly once", async function () {
      await reserve(ID("p1"), alice);

      await expect(asAdapter().reserve(ID("p1"), bob.address, TOKENS(1), await cliffIn(3600)))
        .to.be.revertedWithCustomError(escrow, "DuplicateReservation")
        .withArgs(ID("p1"));

      // Not even for the same beneficiary and the same amount.
      await expect(asAdapter().reserve(ID("p1"), alice.address, BONUS, await cliffIn(3600)))
        .to.be.revertedWithCustomError(escrow, "DuplicateReservation")
        .withArgs(ID("p1"));

      expect(await escrow.totalReserved()).to.equal(BONUS);
    });

    it("rejects a zero beneficiary and a zero amount", async function () {
      await expect(
        asAdapter().reserve(ID("p1"), ethers.ZeroAddress, BONUS, await cliffIn(3600))
      ).to.be.revertedWithCustomError(escrow, "ZeroAddress");

      await expect(
        asAdapter().reserve(ID("p1"), alice.address, 0n, await cliffIn(3600))
      ).to.be.revertedWithCustomError(escrow, "ZeroAmount");

      expect(await escrow.totalReserved()).to.equal(0n);
    });

    it("reserves the whole unreserved balance, and not one wei more", async function () {
      // The exact boundary: `available == amount` is fundable, `available + 1` is not.
      await expect(asAdapter().reserve(ID("p1"), alice.address, FUNDING + 1n, await cliffIn(3600)))
        .to.be.revertedWithCustomError(escrow, "Underfunded")
        .withArgs(FUNDING, FUNDING + 1n);

      await asAdapter().reserve(ID("p1"), alice.address, FUNDING, await cliffIn(3600));
      expect(await escrow.totalReserved()).to.equal(FUNDING);
    });

    it("never funds two reservations from the same wei", async function () {
      await reserve(ID("p1"), alice, FUNDING - TOKENS(10));

      await expect(asAdapter().reserve(ID("p2"), bob.address, TOKENS(11), await cliffIn(3600)))
        .to.be.revertedWithCustomError(escrow, "Underfunded")
        .withArgs(TOKENS(10), TOKENS(11));

      // Topping the escrow up is all it takes; nothing about the first reservation moved.
      await bonus.transfer(escrowAddr, TOKENS(1));
      await asAdapter().reserve(ID("p2"), bob.address, TOKENS(11), await cliffIn(3600));
      expect(await escrow.totalReserved()).to.equal(FUNDING + TOKENS(1));
    });

    it("reports a fully committed escrow as having nothing available", async function () {
      await reserve(ID("p1"), alice, FUNDING);

      await expect(asAdapter().reserve(ID("p2"), bob.address, TOKENS(1), await cliffIn(3600)))
        .to.be.revertedWithCustomError(escrow, "Underfunded")
        .withArgs(0n, TOKENS(1));
    });

    it("accepts a cliff already in the past — the adapter decides the schedule", async function () {
      const past = BigInt(await time.latest()) - 1n;
      await asAdapter().reserve(ID("p1"), alice.address, BONUS, past);

      expect(await escrow.claimable(ID("p1"))).to.equal(BONUS);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("claim", function () {
    beforeEach(async function () {
      await escrow.setAdapter(adapter.address);
    });

    it("reverts before the cliff, naming the cliff and the current time", async function () {
      const cliff = await reserve(ID("p1"), alice);
      const now = BigInt(await time.latest());

      await time.setNextBlockTimestamp(cliff - 1n);
      await expect(escrow.claim(ID("p1")))
        .to.be.revertedWithCustomError(escrow, "CliffNotReached")
        .withArgs(cliff, cliff - 1n);
      expect(now).to.be.lt(cliff);
    });

    it("pays at the exact cliff timestamp, not one second later", async function () {
      const cliff = await reserve(ID("p1"), alice);
      const before = await bonus.balanceOf(alice.address);

      await time.setNextBlockTimestamp(cliff);
      await expect(escrow.connect(alice).claim(ID("p1")))
        .to.emit(escrow, "BonusClaimed")
        .withArgs(ID("p1"), alice.address, BONUS);

      expect(await bonus.balanceOf(alice.address)).to.equal(before + BONUS);
      expect(await escrow.totalReserved()).to.equal(0n);
      expect((await escrow.reservationOf(ID("p1")))[3]).to.equal(true);
    });

    it("pays the recorded beneficiary even when a stranger triggers it", async function () {
      const cliff = await reserve(ID("p1"), alice);
      await time.increaseTo(cliff);

      const aliceBefore = await bonus.balanceOf(alice.address);
      const keeperBefore = await bonus.balanceOf(keeper.address);

      await expect(escrow.connect(keeper).claim(ID("p1")))
        .to.emit(escrow, "BonusClaimed")
        .withArgs(ID("p1"), alice.address, BONUS);

      expect(await bonus.balanceOf(alice.address)).to.equal(aliceBefore + BONUS);
      expect(await bonus.balanceOf(keeper.address)).to.equal(keeperBefore);
    });

    it("leaves every other reservation alone", async function () {
      const cliff = await reserve(ID("p1"), alice, TOKENS(100));
      await reserve(ID("p2"), bob, TOKENS(250), await cliffIn(86_400));
      await time.increaseTo(cliff);

      await escrow.claim(ID("p1"));

      expect(await escrow.totalReserved()).to.equal(TOKENS(250));
      expect(await escrow.claimable(ID("p2"))).to.equal(0n); // still locked
      expect(await bonus.balanceOf(bob.address)).to.equal(0n);
    });

    it("spends a reservation exactly once", async function () {
      const cliff = await reserve(ID("p1"), alice);
      await time.increaseTo(cliff);
      await escrow.claim(ID("p1"));

      await expect(escrow.claim(ID("p1")))
        .to.be.revertedWithCustomError(escrow, "AlreadyClaimed")
        .withArgs(ID("p1"));
      expect(await bonus.balanceOf(alice.address)).to.equal(BONUS);
    });

    it("rejects an id that was never reserved", async function () {
      await expect(escrow.claim(ID("never-happened")))
        .to.be.revertedWithCustomError(escrow, "UnknownReservation")
        .withArgs(ID("never-happened"));
    });

    it("returns the amount paid to its caller", async function () {
      const cliff = await reserve(ID("p1"), alice, TOKENS(42));
      await time.increaseTo(cliff);

      expect(await escrow.claim.staticCall(ID("p1"))).to.equal(TOKENS(42));
    });

    it("keeps working after the reserve path is closed — a bonus owed is never withheld", async function () {
      const cliff = await reserve(ID("p1"), alice);
      await escrow.setAdapter(ethers.ZeroAddress);
      await time.increaseTo(cliff);

      await expect(escrow.claim(ID("p1"))).to.emit(escrow, "BonusClaimed");
      expect(await bonus.balanceOf(alice.address)).to.equal(BONUS);
    });

    it("marks the reservation spent BEFORE the transfer, so a token hook cannot re-enter", async function () {
      // A callback token (ERC-777 shaped) whose hook fires inside the payout itself.
      const HookFactory = await ethers.getContractFactory("MockHookERC20");
      const hookToken = await HookFactory.deploy("Hook Bonus", "hBONUS", SUPPLY, 18);
      const hookAddr = await hookToken.getAddress();

      const hooked = await deployEscrowProxy(hookAddr, owner.address);
      const hookedAddr = await hooked.getAddress();
      await hookToken.transfer(hookedAddr, FUNDING);
      await hooked.setAdapter(adapter.address);

      const cliff = await cliffIn(3600);
      await hooked.connect(adapter).reserve(ID("p1"), alice.address, BONUS, cliff);
      await time.increaseTo(cliff);

      // The hook fires on the transfer that pays alice, and calls straight back into `claim`.
      const payload = hooked.interface.encodeFunctionData("claim", [ID("p1")]);
      await hookToken.setRecipientHook(alice.address, hookedAddr, payload);

      await expect(hooked.claim(ID("p1"))).to.be.revertedWithCustomError(
        hooked,
        "ReentrancyGuardReentrantCall"
      );

      // The same hook, aimed at a harmless read, proves it really fires inside the payout —
      // so the rejection above was the guard and not a mis-wired test.
      const benign = hooked.interface.encodeFunctionData("claimable", [ID("p1")]);
      await hookToken.setRecipientHook(alice.address, hookedAddr, benign);

      await expect(hooked.claim(ID("p1"))).to.emit(hooked, "BonusClaimed");
      expect(await hookToken.hookCalls()).to.equal(1n);
      expect(await hookToken.balanceOf(alice.address)).to.equal(BONUS);
      expect(await hooked.totalReserved()).to.equal(0n);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("claimable", function () {
    beforeEach(async function () {
      await escrow.setAdapter(adapter.address);
    });

    it("is zero for an id nobody reserved", async function () {
      expect(await escrow.claimable(ID("never-happened"))).to.equal(0n);
    });

    it("is zero while locked and the full amount from the cliff onwards", async function () {
      const cliff = await reserve(ID("p1"), alice, TOKENS(7));

      expect(await escrow.claimable(ID("p1"))).to.equal(0n);

      await time.increaseTo(cliff);
      expect(await escrow.claimable(ID("p1"))).to.equal(TOKENS(7));
    });

    it("falls back to zero once the bonus has been paid", async function () {
      const cliff = await reserve(ID("p1"), alice);
      await time.increaseTo(cliff);
      await escrow.claim(ID("p1"));

      expect(await escrow.claimable(ID("p1"))).to.equal(0n);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("recoverSurplus", function () {
    beforeEach(async function () {
      await escrow.setAdapter(adapter.address);
    });

    it("moves exactly the unreserved balance", async function () {
      await reserve(ID("p1"), alice, TOKENS(400));
      const before = await bonus.balanceOf(treasury.address);

      await expect(escrow.recoverSurplus(treasury.address))
        .to.emit(escrow, "SurplusRecovered")
        .withArgs(treasury.address, FUNDING - TOKENS(400));

      expect(await bonus.balanceOf(treasury.address)).to.equal(before + FUNDING - TOKENS(400));
      expect(await bonus.balanceOf(escrowAddr)).to.equal(TOKENS(400));
      expect(await escrow.totalReserved()).to.equal(TOKENS(400));
    });

    it("cannot reach a reserved wei, and the bonus still pays in full afterwards", async function () {
      const cliff = await reserve(ID("p1"), alice, TOKENS(400));
      await escrow.recoverSurplus(treasury.address);

      // Everything left is spoken for, so a second sweep has nothing to take.
      await expect(escrow.recoverSurplus(treasury.address)).to.be.revertedWithCustomError(
        escrow,
        "NoSurplus"
      );

      await time.increaseTo(cliff);
      await escrow.claim(ID("p1"));
      expect(await bonus.balanceOf(alice.address)).to.equal(TOKENS(400));
      expect(await bonus.balanceOf(escrowAddr)).to.equal(0n);
    });

    it("reverts rather than emitting an empty recovery", async function () {
      await reserve(ID("p1"), alice, FUNDING);

      await expect(escrow.recoverSurplus(treasury.address)).to.be.revertedWithCustomError(
        escrow,
        "NoSurplus"
      );
    });

    it("is owner-only, and refuses to burn the surplus at address zero", async function () {
      for (const caller of [adapter, alice]) {
        await expect(escrow.connect(caller).recoverSurplus(caller.address))
          .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount")
          .withArgs(caller.address);
      }

      await expect(escrow.recoverSurplus(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        escrow,
        "ZeroAddress"
      );
      expect(await bonus.balanceOf(escrowAddr)).to.equal(FUNDING);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Upgradeability", function () {
    // `constructor` / `state-variable-immutable`: the two patterns the spec chose on purpose
    // (an immutable protocol reference, `_disableInitializers()` in the implementation ctor).
    // `missing-initializer`: V2 upgrades an ALREADY-initialized proxy, so it declares no
    // `initializer` of its own — its `initializeV2` is a `reinitializer(2)`.
    const V2_ARGS = {
      unsafeAllow: ["constructor", "state-variable-immutable", "missing-initializer"],
    };

    async function v2Factory() {
      return ethers.getContractFactory("BonusEscrowV2Mock");
    }

    beforeEach(async function () {
      await escrow.setAdapter(adapter.address);
    });

    it("passes the plugin's own implementation-safety check", async function () {
      const V2 = await v2Factory();
      await upgrades.validateImplementation(V2, {
        kind: "uups",
        constructorArgs: [bonusAddr],
        ...V2_ARGS,
      });
    });

    it("keeps every reservation, the running total and the roles across upgradeProxy", async function () {
      const cliff = await reserve(ID("p1"), alice, TOKENS(100));
      await reserve(ID("p2"), bob, TOKENS(250));

      const V2 = await v2Factory();
      const upgraded = await upgrades.upgradeProxy(escrowAddr, V2, {
        kind: "uups",
        constructorArgs: [bonusAddr],
        ...V2_ARGS,
      });

      expect(await upgraded.version()).to.equal(2n);
      expect(await upgraded.getAddress()).to.equal(escrowAddr);
      expect(await upgraded.totalReserved()).to.equal(TOKENS(350));
      expect(await upgraded.owner()).to.equal(owner.address);
      expect(await upgraded.adapter()).to.equal(adapter.address);
      expect(await upgraded.bonusToken()).to.equal(bonusAddr);

      const [beneficiary, amount, unlockAt, claimed] = await upgraded.reservationOf(ID("p1"));
      expect(beneficiary).to.equal(alice.address);
      expect(amount).to.equal(TOKENS(100));
      expect(unlockAt).to.equal(cliff);
      expect(claimed).to.equal(false);

      // ...and the obligation is still payable through the new code.
      await time.increaseTo(cliff);
      await expect(upgraded.claim(ID("p1")))
        .to.emit(upgraded, "BonusClaimed")
        .withArgs(ID("p1"), alice.address, TOKENS(100));
      expect(await upgraded.totalReserved()).to.equal(TOKENS(250));
    });

    it("seeds V2-only state in a namespace V1 never wrote to", async function () {
      await reserve(ID("p1"), alice, TOKENS(100));

      const V2 = await v2Factory();
      const upgraded = await upgrades.upgradeProxy(escrowAddr, V2, {
        kind: "uups",
        constructorArgs: [bonusAddr],
        call: { fn: "initializeV2", args: [42] },
        ...V2_ARGS,
      });

      expect(await upgraded.upgradeMarker()).to.equal(42n);
      expect(await upgraded.totalReserved()).to.equal(TOKENS(100));
      expect((await upgraded.reservationOf(ID("p1")))[0]).to.equal(alice.address);
      expect(await upgraded.adapter()).to.equal(adapter.address);
    });

    it("rejects upgradeToAndCall from anyone but the owner", async function () {
      const V2 = await v2Factory();
      const impl = await V2.deploy(bonusAddr);
      await impl.waitForDeployment();
      const implAddr = await impl.getAddress();

      for (const caller of [alice, adapter, treasury]) {
        await expect(escrow.connect(caller).upgradeToAndCall(implAddr, "0x"))
          .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount")
          .withArgs(caller.address);
      }

      await expect(escrow.upgradeToAndCall(implAddr, "0x"))
        .to.emit(escrow, "Upgraded")
        .withArgs(implAddr);
    });
  });
});
