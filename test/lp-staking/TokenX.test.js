const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("TokenX", function () {
  let token;
  let owner, minter, alice, bob;

  const NAME = "Token X";
  const SYMBOL = "TKX";
  const TOKENS = (n) => ethers.parseEther(String(n));
  const FAR_DEADLINE = 10n ** 12n;

  const EPOCH = 1n;

  async function deployToken(initialOwner) {
    const TokenX = await ethers.getContractFactory("TokenX");
    return TokenX.deploy(NAME, SYMBOL, initialOwner);
  }

  /// Point minting at `minter` and arm the running epoch with `cap`.
  async function armMinter(cap, epochId = EPOCH) {
    await token.setMinter(minter.address);
    await token.setEpochCap(epochId, cap);
  }

  async function permitSignature(from, spender, value, opts = {}) {
    const domain = {
      name: NAME,
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await token.getAddress(),
    };
    const types = {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };
    const message = {
      owner: from.address,
      spender: spender.address,
      value,
      nonce: opts.nonce ?? (await token.nonces(from.address)),
      deadline: opts.deadline ?? FAR_DEADLINE,
    };
    const sig = await (opts.signer ?? from).signTypedData(domain, types, message);
    return ethers.Signature.from(sig);
  }

  beforeEach(async function () {
    [owner, minter, alice, bob] = await ethers.getSigners();
    token = await deployToken(owner.address);
  });

  // ─────────────────────────────────────────────────────────────
  describe("Deployment", function () {
    it("takes name and symbol from the constructor and fixes 18 decimals", async function () {
      expect(await token.name()).to.equal(NAME);
      expect(await token.symbol()).to.equal(SYMBOL);
      expect(await token.decimals()).to.equal(18n);
      expect(await token.totalSupply()).to.equal(0n);
      expect(await token.owner()).to.equal(owner.address);
    });

    it("brands a different deployment independently", async function () {
      const TokenX = await ethers.getContractFactory("TokenX");
      const other = await TokenX.deploy("Real Rewards", "REALX", bob.address);
      expect(await other.name()).to.equal("Real Rewards");
      expect(await other.symbol()).to.equal("REALX");
      expect(await other.owner()).to.equal(bob.address);
    });

    it("starts with no minter, epoch 0 and a zero cap", async function () {
      expect(await token.minter()).to.equal(ethers.ZeroAddress);
      expect(await token.currentEpochId()).to.equal(0n);
      expect(await token.epochCap(0)).to.equal(0n);
      expect(await token.mintedInEpoch(0)).to.equal(0n);
    });

    it("logs its whole initial state in the deployment transaction", async function () {
      // C-7: the token starts with no minter, epoch 0 and a zero cap — all three the type's
      // default, none of them written by the constructor — so without these two emissions an
      // indexer would have to hardcode them. Order matters: `Ownable` logs the owner first.
      const TokenX = await ethers.getContractFactory("TokenX");
      const fresh = await TokenX.deploy(NAME, SYMBOL, owner.address);
      await fresh.waitForDeployment();
      const freshAddr = await fresh.getAddress();
      const receipt = await fresh.deploymentTransaction().wait();

      const events = receipt.logs
        .filter((log) => log.address === freshAddr)
        .map((log) => fresh.interface.parseLog(log))
        .filter((parsed) => parsed !== null);

      expect(events.map((e) => e.name)).to.deep.equal([
        "OwnershipTransferred",
        "MinterChanged",
        "EpochCapSet",
      ]);
      expect(events[0].args[0]).to.equal(ethers.ZeroAddress);
      expect(events[0].args[1]).to.equal(owner.address);
      expect(events[1].args[0]).to.equal(ethers.ZeroAddress);
      expect(events[1].args[1]).to.equal(ethers.ZeroAddress);
      expect(events[2].args[0]).to.equal(0n);
      expect(events[2].args[1]).to.equal(0n);
    });

    it("fails closed: with the cap unarmed even 1 wei cannot be minted", async function () {
      await token.setMinter(minter.address);

      await expect(token.connect(minter).mint(alice.address, 1n))
        .to.be.revertedWithCustomError(token, "EpochMintCapExceeded")
        .withArgs(0n, 0n, 0n, 1n);

      expect(await token.totalSupply()).to.equal(0n);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Ownership", function () {
    it("only nominates on transferOwnership, and the nominee holds nothing yet", async function () {
      await expect(token.transferOwnership(bob.address))
        .to.emit(token, "OwnershipTransferStarted")
        .withArgs(owner.address, bob.address);

      expect(await token.owner()).to.equal(owner.address);
      expect(await token.pendingOwner()).to.equal(bob.address);

      await expect(token.connect(bob).setEpochCap(EPOCH, TOKENS(100)))
        .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount")
        .withArgs(bob.address);

      // ...and the standing owner still holds the whole admin surface.
      await expect(token.setEpochCap(EPOCH, TOKENS(100))).to.emit(token, "EpochCapSet");
    });

    it("moves the owner only when the nominee accepts", async function () {
      await token.transferOwnership(bob.address);

      await expect(token.connect(bob).acceptOwnership())
        .to.emit(token, "OwnershipTransferred")
        .withArgs(owner.address, bob.address);

      expect(await token.owner()).to.equal(bob.address);
      expect(await token.pendingOwner()).to.equal(ethers.ZeroAddress);

      await expect(token.setMinter(minter.address))
        .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount")
        .withArgs(owner.address);
      await expect(token.connect(bob).setMinter(minter.address)).to.emit(token, "MinterChanged");
    });

    it("lets nobody but the nominee accept, the standing owner included", async function () {
      await token.transferOwnership(bob.address);

      await expect(token.connect(alice).acceptOwnership())
        .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount")
        .withArgs(alice.address);
      await expect(token.acceptOwnership())
        .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount")
        .withArgs(owner.address);

      expect(await token.pendingOwner()).to.equal(bob.address);
      expect(await token.owner()).to.equal(owner.address);
    });

    it("withdraws a mistyped nomination with transferOwnership(0)", async function () {
      await token.transferOwnership(bob.address);
      await token.transferOwnership(ethers.ZeroAddress);

      expect(await token.pendingOwner()).to.equal(ethers.ZeroAddress);
      expect(await token.owner()).to.equal(owner.address);

      await expect(token.connect(bob).acceptOwnership())
        .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount")
        .withArgs(bob.address);
    });

    it("refuses to be renounced, and refuses a stranger for a different reason", async function () {
      // An ownerless TokenX could never arm another epoch, so minting would die with the
      // running cap. The call reverts rather than being discouraged in a runbook.
      await expect(token.renounceOwnership()).to.be.revertedWithCustomError(token, "RenounceDisabled");
      expect(await token.owner()).to.equal(owner.address);

      await expect(token.connect(alice).renounceOwnership())
        .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount")
        .withArgs(alice.address);

      // And the schedule is still administrable afterwards.
      await token.setEpochCap(EPOCH, TOKENS(100));
      expect(await token.epochCap(EPOCH)).to.equal(TOKENS(100));
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("setMinter", function () {
    it("is owner only", async function () {
      await expect(token.connect(alice).setMinter(alice.address))
        .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount")
        .withArgs(alice.address);
    });

    it("emits MinterChanged carrying the previous and the new minter", async function () {
      await expect(token.setMinter(minter.address))
        .to.emit(token, "MinterChanged")
        .withArgs(ethers.ZeroAddress, minter.address);
      expect(await token.minter()).to.equal(minter.address);

      await expect(token.setMinter(bob.address))
        .to.emit(token, "MinterChanged")
        .withArgs(minter.address, bob.address);
      expect(await token.minter()).to.equal(bob.address);
    });

    it("re-points minting rights at a replacement distributor", async function () {
      await armMinter(TOKENS(100));
      await token.connect(minter).mint(alice.address, TOKENS(10));

      await token.setMinter(bob.address);

      await expect(token.connect(minter).mint(alice.address, TOKENS(1)))
        .to.be.revertedWithCustomError(token, "NotMinter")
        .withArgs(minter.address);

      // the tally is carried over — rotating the minter does not reopen headroom
      await token.connect(bob).mint(alice.address, TOKENS(90));
      await expect(token.connect(bob).mint(alice.address, 1n))
        .to.be.revertedWithCustomError(token, "EpochMintCapExceeded")
        .withArgs(EPOCH, TOKENS(100), TOKENS(100), 1n);
    });

    it("accepts address(0) and that disables minting entirely", async function () {
      await armMinter(TOKENS(100));
      await token.connect(minter).mint(alice.address, TOKENS(1));

      await expect(token.setMinter(ethers.ZeroAddress))
        .to.emit(token, "MinterChanged")
        .withArgs(minter.address, ethers.ZeroAddress);
      expect(await token.minter()).to.equal(ethers.ZeroAddress);

      await expect(token.connect(minter).mint(alice.address, TOKENS(1)))
        .to.be.revertedWithCustomError(token, "NotMinter")
        .withArgs(minter.address);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("mint", function () {
    it("rejects every caller that is not the minter, the owner included", async function () {
      await armMinter(TOKENS(100));

      await expect(token.connect(alice).mint(alice.address, TOKENS(1)))
        .to.be.revertedWithCustomError(token, "NotMinter")
        .withArgs(alice.address);

      await expect(token.mint(alice.address, TOKENS(1)))
        .to.be.revertedWithCustomError(token, "NotMinter")
        .withArgs(owner.address);
    });

    it("mints to the named recipient, not to the minter", async function () {
      await armMinter(TOKENS(100));
      await token.connect(minter).mint(alice.address, TOKENS(40));

      expect(await token.balanceOf(alice.address)).to.equal(TOKENS(40));
      expect(await token.balanceOf(minter.address)).to.equal(0n);
      expect(await token.totalSupply()).to.equal(TOKENS(40));
    });

    it("accumulates the tally across mints inside one epoch", async function () {
      await armMinter(TOKENS(100));

      await token.connect(minter).mint(alice.address, TOKENS(10));
      expect(await token.mintedInEpoch(EPOCH)).to.equal(TOKENS(10));

      await token.connect(minter).mint(bob.address, TOKENS(25));
      expect(await token.mintedInEpoch(EPOCH)).to.equal(TOKENS(35));

      await token.connect(minter).mint(alice.address, TOKENS(5));
      expect(await token.mintedInEpoch(EPOCH)).to.equal(TOKENS(40));
      expect(await token.totalSupply()).to.equal(TOKENS(40));
    });

    it("mints exactly up to the cap and rejects the next wei", async function () {
      await armMinter(TOKENS(100));
      await token.connect(minter).mint(alice.address, TOKENS(30));

      // remaining is exactly 70 — 71 is one token too many
      await expect(token.connect(minter).mint(alice.address, TOKENS(71)))
        .to.be.revertedWithCustomError(token, "EpochMintCapExceeded")
        .withArgs(EPOCH, TOKENS(100), TOKENS(30), TOKENS(71));

      // remaining + 1 wei is still too many
      await expect(token.connect(minter).mint(alice.address, TOKENS(70) + 1n))
        .to.be.revertedWithCustomError(token, "EpochMintCapExceeded")
        .withArgs(EPOCH, TOKENS(100), TOKENS(30), TOKENS(70) + 1n);

      // amount == remaining lands
      await token.connect(minter).mint(alice.address, TOKENS(70));
      expect(await token.mintedInEpoch(EPOCH)).to.equal(TOKENS(100));
      expect(await token.totalSupply()).to.equal(TOKENS(100));

      // and the epoch is now closed for any positive amount
      await expect(token.connect(minter).mint(alice.address, 1n))
        .to.be.revertedWithCustomError(token, "EpochMintCapExceeded")
        .withArgs(EPOCH, TOKENS(100), TOKENS(100), 1n);
    });

    it("carries (epochId, cap, minted, requested) in the cap error", async function () {
      await token.setMinter(minter.address);
      await token.setEpochCap(7n, TOKENS(50));
      await token.connect(minter).mint(alice.address, TOKENS(12));

      await expect(token.connect(minter).mint(bob.address, TOKENS(39)))
        .to.be.revertedWithCustomError(token, "EpochMintCapExceeded")
        .withArgs(7n, TOKENS(50), TOKENS(12), TOKENS(39));
    });

    it("rejects a zero amount instead of emitting a zero-value Transfer", async function () {
      await armMinter(TOKENS(100));

      await expect(token.connect(minter).mint(alice.address, 0n)).to.be.revertedWithCustomError(
        token,
        "ZeroAmount"
      );

      expect(await token.totalSupply()).to.equal(0n);
      expect(await token.mintedInEpoch(EPOCH)).to.equal(0n);
    });

    it("checks the zero amount before the cap but after the minter gate", async function () {
      // unarmed epoch: a positive amount fails on the cap, zero still fails on ZeroAmount
      await token.setMinter(minter.address);
      await expect(token.connect(minter).mint(alice.address, 0n)).to.be.revertedWithCustomError(
        token,
        "ZeroAmount"
      );

      // a stranger passing zero is still rejected as a stranger
      await expect(token.connect(alice).mint(alice.address, 0n))
        .to.be.revertedWithCustomError(token, "NotMinter")
        .withArgs(alice.address);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("setEpochCap", function () {
    it("is owner only", async function () {
      await expect(token.connect(alice).setEpochCap(1n, TOKENS(1)))
        .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount")
        .withArgs(alice.address);
    });

    it("selects the running epoch and emits EpochCapSet", async function () {
      await expect(token.setEpochCap(3n, TOKENS(500)))
        .to.emit(token, "EpochCapSet")
        .withArgs(3n, TOKENS(500));

      expect(await token.currentEpochId()).to.equal(3n);
      expect(await token.epochCap(3n)).to.equal(TOKENS(500));
    });

    it("gives a fresh epoch fresh headroom", async function () {
      await armMinter(TOKENS(100));
      await token.connect(minter).mint(alice.address, TOKENS(100));
      await expect(token.connect(minter).mint(alice.address, 1n)).to.be.revertedWithCustomError(
        token,
        "EpochMintCapExceeded"
      );

      await token.setEpochCap(2n, TOKENS(100));
      expect(await token.mintedInEpoch(2n)).to.equal(0n);

      await token.connect(minter).mint(alice.address, TOKENS(100));
      expect(await token.mintedInEpoch(2n)).to.equal(TOKENS(100));
      expect(await token.mintedInEpoch(EPOCH)).to.equal(TOKENS(100));
      expect(await token.totalSupply()).to.equal(TOKENS(200));
    });

    it("keeps an old epoch's tally when that epoch id is re-selected", async function () {
      await armMinter(TOKENS(100));
      await token.connect(minter).mint(alice.address, TOKENS(60));

      // switch away, mint elsewhere, then switch back to epoch 1 with the same cap
      await token.setEpochCap(2n, TOKENS(100));
      await token.connect(minter).mint(alice.address, TOKENS(100));

      await token.setEpochCap(EPOCH, TOKENS(100));
      expect(await token.mintedInEpoch(EPOCH)).to.equal(TOKENS(60));

      // only the original 40 of headroom is left — rotation cannot reset the tally
      await expect(token.connect(minter).mint(alice.address, TOKENS(41)))
        .to.be.revertedWithCustomError(token, "EpochMintCapExceeded")
        .withArgs(EPOCH, TOKENS(100), TOKENS(60), TOKENS(41));

      await token.connect(minter).mint(alice.address, TOKENS(40));
      expect(await token.mintedInEpoch(EPOCH)).to.equal(TOKENS(100));
    });

    it("lowering the cap below what is already minted blocks all further mints", async function () {
      await armMinter(TOKENS(100));
      await token.connect(minter).mint(alice.address, TOKENS(80));

      await token.setEpochCap(EPOCH, TOKENS(10));
      expect(await token.epochCap(EPOCH)).to.equal(TOKENS(10));
      expect(await token.mintedInEpoch(EPOCH)).to.equal(TOKENS(80));

      // no underflow panic — the typed error survives cap < minted
      await expect(token.connect(minter).mint(alice.address, 1n))
        .to.be.revertedWithCustomError(token, "EpochMintCapExceeded")
        .withArgs(EPOCH, TOKENS(10), TOKENS(80), 1n);

      // raising it again reopens exactly the new headroom
      await token.setEpochCap(EPOCH, TOKENS(90));
      await token.connect(minter).mint(alice.address, TOKENS(10));
      await expect(token.connect(minter).mint(alice.address, 1n))
        .to.be.revertedWithCustomError(token, "EpochMintCapExceeded")
        .withArgs(EPOCH, TOKENS(90), TOKENS(90), 1n);
    });

    it("a zero cap on the running epoch stops minting without touching the minter", async function () {
      await armMinter(TOKENS(100));
      await token.setEpochCap(EPOCH, 0n);

      expect(await token.minter()).to.equal(minter.address);
      await expect(token.connect(minter).mint(alice.address, 1n))
        .to.be.revertedWithCustomError(token, "EpochMintCapExceeded")
        .withArgs(EPOCH, 0n, 0n, 1n);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("scheduled epoch rollover", function () {
    const NEXT = 2n;
    const HOUR = 3600;

    /// A timestamp `secondsAhead` in the future, for use as `activatesAt`.
    async function future(secondsAhead = HOUR) {
      return BigInt(await time.latest()) + BigInt(secondsAhead);
    }

    beforeEach(async function () {
      // minter armed, epoch 1 running with a cap of 100
      await armMinter(TOKENS(100));
    });

    it("starts with nothing armed", async function () {
      const other = await deployToken(owner.address);
      const pending = await other.pendingEpoch();
      expect(pending.epochId).to.equal(0n);
      expect(pending.cap).to.equal(0n);
      expect(pending.activatesAt).to.equal(0n);
    });

    it("armNextEpoch and cancelNextEpoch are owner only", async function () {
      const at = await future();

      await expect(token.connect(alice).armNextEpoch(NEXT, TOKENS(50), at))
        .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount")
        .withArgs(alice.address);

      await token.armNextEpoch(NEXT, TOKENS(50), at);

      await expect(token.connect(alice).cancelNextEpoch())
        .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount")
        .withArgs(alice.address);
    });

    it("parks one pending epoch and emits NextEpochArmed", async function () {
      const at = await future();

      await expect(token.armNextEpoch(NEXT, TOKENS(50), at))
        .to.emit(token, "NextEpochArmed")
        .withArgs(NEXT, TOKENS(50), at);

      const pending = await token.pendingEpoch();
      expect(pending.epochId).to.equal(NEXT);
      expect(pending.cap).to.equal(TOKENS(50));
      expect(pending.activatesAt).to.equal(at);

      // arming alone changes nothing about the running epoch
      expect(await token.currentEpochId()).to.equal(EPOCH);
      expect(await token.epochCap(NEXT)).to.equal(0n);
    });

    it("rejects an activation time that is not strictly in the future", async function () {
      const now = BigInt(await time.latest()) + 100n;

      // in the past
      await time.setNextBlockTimestamp(now);
      await expect(token.armNextEpoch(NEXT, TOKENS(50), now - 10n))
        .to.be.revertedWithCustomError(token, "ActivationNotInFuture")
        .withArgs(now - 10n, now);

      // exactly now — it would be due on the very next mint, which is setEpochCap's job
      await time.setNextBlockTimestamp(now + 100n);
      await expect(token.armNextEpoch(NEXT, TOKENS(50), now + 100n))
        .to.be.revertedWithCustomError(token, "ActivationNotInFuture")
        .withArgs(now + 100n, now + 100n);

      // one second later is accepted
      await time.setNextBlockTimestamp(now + 200n);
      await token.armNextEpoch(NEXT, TOKENS(50), now + 201n);
      expect((await token.pendingEpoch()).activatesAt).to.equal(now + 201n);
    });

    it("accepts a zero cap, which schedules a freeze", async function () {
      const at = await future();
      await token.armNextEpoch(NEXT, 0n, at);
      await time.increaseTo(at);

      await expect(token.connect(minter).mint(alice.address, 1n))
        .to.be.revertedWithCustomError(token, "EpochMintCapExceeded")
        .withArgs(NEXT, 0n, 0n, 1n);
    });

    it("does not roll before the boundary", async function () {
      const at = await future();
      await token.armNextEpoch(NEXT, TOKENS(50), at);

      await time.setNextBlockTimestamp(at - 1n);
      await expect(token.connect(minter).mint(alice.address, TOKENS(10))).to.not.emit(
        token,
        "EpochActivated"
      );

      expect(await token.currentEpochId()).to.equal(EPOCH);
      expect(await token.mintedInEpoch(EPOCH)).to.equal(TOKENS(10));
      expect(await token.mintedInEpoch(NEXT)).to.equal(0n);
      expect((await token.pendingEpoch()).activatesAt).to.equal(at);
    });

    it("rolls on the first mint at the boundary and clears the slot", async function () {
      const at = await future();
      await token.armNextEpoch(NEXT, TOKENS(50), at);

      // exactly at activatesAt: `>=` makes it due
      await time.setNextBlockTimestamp(at);
      await expect(token.connect(minter).mint(alice.address, TOKENS(10)))
        .to.emit(token, "EpochActivated")
        .withArgs(NEXT, TOKENS(50), at, at);

      expect(await token.currentEpochId()).to.equal(NEXT);
      expect(await token.epochCap(NEXT)).to.equal(TOKENS(50));
      expect(await token.mintedInEpoch(NEXT)).to.equal(TOKENS(10));
      expect(await token.mintedInEpoch(EPOCH)).to.equal(0n);

      // the slot is consumed, so a later mint cannot activate it twice
      const pending = await token.pendingEpoch();
      expect(pending.epochId).to.equal(0n);
      expect(pending.cap).to.equal(0n);
      expect(pending.activatesAt).to.equal(0n);

      await expect(token.connect(minter).mint(alice.address, TOKENS(10))).to.not.emit(
        token,
        "EpochActivated"
      );
      expect(await token.mintedInEpoch(NEXT)).to.equal(TOKENS(20));
    });

    it("carries both the scheduled and the actual activation time when the mint comes late", async function () {
      const at = await future();
      await token.armNextEpoch(NEXT, TOKENS(50), at);

      const late = at + 5000n;
      await time.setNextBlockTimestamp(late);
      await expect(token.connect(minter).mint(alice.address, TOKENS(1)))
        .to.emit(token, "EpochActivated")
        .withArgs(NEXT, TOKENS(50), at, late);
    });

    it("enforces the new epoch's cap on the very mint that rolls it", async function () {
      const at = await future();
      await token.armNextEpoch(NEXT, TOKENS(50), at);
      await time.increaseTo(at);

      // 60 has headroom under the old cap of 100 but not under the new one of 50
      await expect(token.connect(minter).mint(alice.address, TOKENS(60)))
        .to.be.revertedWithCustomError(token, "EpochMintCapExceeded")
        .withArgs(NEXT, TOKENS(50), 0n, TOKENS(60));

      // the whole transaction reverted, so the rollover did not stick either
      expect(await token.currentEpochId()).to.equal(EPOCH);
      expect((await token.pendingEpoch()).activatesAt).to.equal(at);

      // and the next mint that fits still rolls it in
      await token.connect(minter).mint(alice.address, TOKENS(50));
      expect(await token.currentEpochId()).to.equal(NEXT);
      expect(await token.mintedInEpoch(NEXT)).to.equal(TOKENS(50));
    });

    it("a second arming overwrites the first, and only the last one activates", async function () {
      const first = await future(HOUR);
      const second = await future(2 * HOUR);

      await token.armNextEpoch(NEXT, TOKENS(50), first);
      await expect(token.armNextEpoch(3n, TOKENS(70), second))
        .to.emit(token, "NextEpochArmed")
        .withArgs(3n, TOKENS(70), second);

      const pending = await token.pendingEpoch();
      expect(pending.epochId).to.equal(3n);
      expect(pending.cap).to.equal(TOKENS(70));
      expect(pending.activatesAt).to.equal(second);

      // the discarded arming's boundary passes without doing anything
      await time.increaseTo(first + 60n);
      await token.connect(minter).mint(alice.address, TOKENS(10));
      expect(await token.currentEpochId()).to.equal(EPOCH);
      expect(await token.epochCap(NEXT)).to.equal(0n);

      // the surviving one lands at its own boundary
      await time.increaseTo(second);
      await token.connect(minter).mint(alice.address, TOKENS(10));
      expect(await token.currentEpochId()).to.equal(3n);
      expect(await token.epochCap(3n)).to.equal(TOKENS(70));
    });

    it("cancelNextEpoch clears the slot, logs what was discarded and stops the rollover", async function () {
      const at = await future();
      await token.armNextEpoch(NEXT, TOKENS(50), at);

      await expect(token.cancelNextEpoch())
        .to.emit(token, "NextEpochCancelled")
        .withArgs(NEXT, TOKENS(50), at);

      expect((await token.pendingEpoch()).activatesAt).to.equal(0n);

      await time.increaseTo(at + 60n);
      await expect(token.connect(minter).mint(alice.address, TOKENS(10))).to.not.emit(
        token,
        "EpochActivated"
      );

      // the running epoch and its cap were left exactly as they were
      expect(await token.currentEpochId()).to.equal(EPOCH);
      expect(await token.epochCap(EPOCH)).to.equal(TOKENS(100));
      expect(await token.mintedInEpoch(EPOCH)).to.equal(TOKENS(10));
      expect(await token.epochCap(NEXT)).to.equal(0n);
    });

    it("cancelNextEpoch reverts when nothing is armed, activation included", async function () {
      await expect(token.cancelNextEpoch()).to.be.revertedWithCustomError(token, "NoPendingEpoch");

      const at = await future();
      await token.armNextEpoch(NEXT, TOKENS(50), at);
      await time.increaseTo(at);
      await token.connect(minter).mint(alice.address, TOKENS(1));

      // the mint consumed the slot — a cancel arriving afterwards must not pretend to work
      await expect(token.cancelNextEpoch()).to.be.revertedWithCustomError(token, "NoPendingEpoch");
    });

    it("setEpochCap does not clear a pending epoch, so the schedule still fires later", async function () {
      const at = await future();
      await token.armNextEpoch(NEXT, TOKENS(50), at);

      // an immediate switch made while epoch 2 is armed
      await token.setEpochCap(9n, TOKENS(200));
      expect(await token.currentEpochId()).to.equal(9n);
      expect((await token.pendingEpoch()).epochId).to.equal(NEXT);

      await token.connect(minter).mint(alice.address, TOKENS(150));
      expect(await token.mintedInEpoch(9n)).to.equal(TOKENS(150));

      // at the boundary the scheduled epoch supersedes the manual switch
      await time.increaseTo(at);
      await expect(token.connect(minter).mint(alice.address, TOKENS(10))).to.emit(
        token,
        "EpochActivated"
      );

      expect(await token.currentEpochId()).to.equal(NEXT);
      expect(await token.mintedInEpoch(9n)).to.equal(TOKENS(150));
      expect(await token.mintedInEpoch(NEXT)).to.equal(TOKENS(10));

      // epoch 2's cap of 50 is what binds now, not epoch 9's 200
      await expect(token.connect(minter).mint(alice.address, TOKENS(41)))
        .to.be.revertedWithCustomError(token, "EpochMintCapExceeded")
        .withArgs(NEXT, TOKENS(50), TOKENS(10), TOKENS(41));
    });

    it("cancelNextEpoch leaves an immediate setEpochCap switch as the last word", async function () {
      const at = await future();
      await token.armNextEpoch(NEXT, TOKENS(50), at);
      await token.setEpochCap(9n, TOKENS(200));
      await token.cancelNextEpoch();

      await time.increaseTo(at + 60n);
      await token.connect(minter).mint(alice.address, TOKENS(150));
      expect(await token.currentEpochId()).to.equal(9n);
      expect(await token.mintedInEpoch(9n)).to.equal(TOKENS(150));
    });

    it("scheduling an epoch id that already has a tally resumes it instead of resetting it", async function () {
      await token.connect(minter).mint(alice.address, TOKENS(60));
      await token.setEpochCap(5n, TOKENS(100));

      // schedule a return to epoch 1, which already carries 60
      const at = await future();
      await token.armNextEpoch(EPOCH, TOKENS(100), at);
      await time.increaseTo(at);

      // only the original 40 of headroom is left
      await token.connect(minter).mint(alice.address, TOKENS(40));
      expect(await token.currentEpochId()).to.equal(EPOCH);
      expect(await token.mintedInEpoch(EPOCH)).to.equal(TOKENS(100));

      await expect(token.connect(minter).mint(alice.address, 1n))
        .to.be.revertedWithCustomError(token, "EpochMintCapExceeded")
        .withArgs(EPOCH, TOKENS(100), TOKENS(100), 1n);
    });

    it("effectiveEpoch reports the running epoch until the boundary, then the pending one", async function () {
      let effective = await token.effectiveEpoch();
      expect(effective.epochId).to.equal(EPOCH);
      expect(effective.cap).to.equal(TOKENS(100));

      const at = await future();
      await token.armNextEpoch(NEXT, TOKENS(50), at);

      // armed but not due yet
      effective = await token.effectiveEpoch();
      expect(effective.epochId).to.equal(EPOCH);
      expect(effective.cap).to.equal(TOKENS(100));

      await time.increaseTo(at);

      // due, but no mint has rolled it in: storage still reads the old epoch and a
      // zero cap for the new id, which is exactly why the view returns both fields
      expect(await token.currentEpochId()).to.equal(EPOCH);
      expect(await token.epochCap(NEXT)).to.equal(0n);
      effective = await token.effectiveEpoch();
      expect(effective.epochId).to.equal(NEXT);
      expect(effective.cap).to.equal(TOKENS(50));

      // after the rollover the view and storage agree
      await token.connect(minter).mint(alice.address, TOKENS(1));
      effective = await token.effectiveEpoch();
      expect(effective.epochId).to.equal(NEXT);
      expect(effective.cap).to.equal(TOKENS(50));
      expect(await token.currentEpochId()).to.equal(NEXT);
    });

    it("effectiveEpoch follows setEpochCap and cancellation too", async function () {
      const at = await future();
      await token.armNextEpoch(NEXT, TOKENS(50), at);

      await token.setEpochCap(9n, TOKENS(200));
      let effective = await token.effectiveEpoch();
      expect(effective.epochId).to.equal(9n);
      expect(effective.cap).to.equal(TOKENS(200));

      await token.cancelNextEpoch();
      await time.increaseTo(at + 60n);
      effective = await token.effectiveEpoch();
      expect(effective.epochId).to.equal(9n);
      expect(effective.cap).to.equal(TOKENS(200));
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("ERC20Permit", function () {
    beforeEach(async function () {
      await armMinter(TOKENS(1000));
      await token.connect(minter).mint(alice.address, TOKENS(100));
    });

    it("uses the deployed name as the EIP-712 domain name", async function () {
      const [, name, version, chainId, verifyingContract] = await token.eip712Domain();
      expect(name).to.equal(NAME);
      expect(version).to.equal("1");
      expect(chainId).to.equal((await ethers.provider.getNetwork()).chainId);
      expect(verifyingContract).to.equal(await token.getAddress());
    });

    it("grants an allowance from an off-chain signature and lets the spender pull", async function () {
      const value = TOKENS(25);
      const { v, r, s } = await permitSignature(alice, bob, value);

      expect(await token.nonces(alice.address)).to.equal(0n);
      await token.connect(bob).permit(alice.address, bob.address, value, FAR_DEADLINE, v, r, s);

      expect(await token.allowance(alice.address, bob.address)).to.equal(value);
      expect(await token.nonces(alice.address)).to.equal(1n);

      await token.connect(bob).transferFrom(alice.address, bob.address, value);
      expect(await token.balanceOf(bob.address)).to.equal(value);
      expect(await token.balanceOf(alice.address)).to.equal(TOKENS(75));
    });

    it("consumes the nonce, so the same permit cannot be replayed", async function () {
      const value = TOKENS(25);
      const { v, r, s } = await permitSignature(alice, bob, value);
      await token.connect(bob).permit(alice.address, bob.address, value, FAR_DEADLINE, v, r, s);

      await expect(
        token.connect(bob).permit(alice.address, bob.address, value, FAR_DEADLINE, v, r, s)
      ).to.be.revertedWithCustomError(token, "ERC2612InvalidSigner");
    });

    it("rejects an expired permit", async function () {
      const deadline = BigInt(await time.latest()) - 1n;
      const { v, r, s } = await permitSignature(alice, bob, TOKENS(25), { deadline });

      await expect(
        token.connect(bob).permit(alice.address, bob.address, TOKENS(25), deadline, v, r, s)
      )
        .to.be.revertedWithCustomError(token, "ERC2612ExpiredSignature")
        .withArgs(deadline);
    });

    it("rejects a permit signed by somebody other than the owner", async function () {
      const { v, r, s } = await permitSignature(alice, bob, TOKENS(25), { signer: bob });

      await expect(
        token.connect(bob).permit(alice.address, bob.address, TOKENS(25), FAR_DEADLINE, v, r, s)
      ).to.be.revertedWithCustomError(token, "ERC2612InvalidSigner");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("ERC20Burnable", function () {
    beforeEach(async function () {
      await armMinter(TOKENS(1000));
      await token.connect(minter).mint(alice.address, TOKENS(100));
    });

    it("burns the caller's own balance", async function () {
      await expect(token.connect(alice).burn(TOKENS(40)))
        .to.emit(token, "Transfer")
        .withArgs(alice.address, ethers.ZeroAddress, TOKENS(40));

      expect(await token.balanceOf(alice.address)).to.equal(TOKENS(60));
      expect(await token.totalSupply()).to.equal(TOKENS(60));
    });

    it("burnFrom spends the allowance", async function () {
      await token.connect(alice).approve(bob.address, TOKENS(50));

      await token.connect(bob).burnFrom(alice.address, TOKENS(30));
      expect(await token.balanceOf(alice.address)).to.equal(TOKENS(70));
      expect(await token.allowance(alice.address, bob.address)).to.equal(TOKENS(20));
      expect(await token.totalSupply()).to.equal(TOKENS(70));
    });

    it("burnFrom without allowance reverts", async function () {
      await expect(token.connect(bob).burnFrom(alice.address, TOKENS(1)))
        .to.be.revertedWithCustomError(token, "ERC20InsufficientAllowance")
        .withArgs(bob.address, 0n, TOKENS(1));
    });

    it("burning does not give back epoch headroom", async function () {
      await token.setEpochCap(EPOCH, TOKENS(100));
      expect(await token.mintedInEpoch(EPOCH)).to.equal(TOKENS(100));

      await token.connect(alice).burn(TOKENS(100));
      expect(await token.totalSupply()).to.equal(0n);
      expect(await token.mintedInEpoch(EPOCH)).to.equal(TOKENS(100));

      await expect(token.connect(minter).mint(alice.address, 1n))
        .to.be.revertedWithCustomError(token, "EpochMintCapExceeded")
        .withArgs(EPOCH, TOKENS(100), TOKENS(100), 1n);
    });
  });
});
