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

    it("fails closed: with the cap unarmed even 1 wei cannot be minted", async function () {
      await token.setMinter(minter.address);

      await expect(token.connect(minter).mint(alice.address, 1n))
        .to.be.revertedWithCustomError(token, "EpochMintCapExceeded")
        .withArgs(0n, 0n, 0n, 1n);

      expect(await token.totalSupply()).to.equal(0n);
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

    it("treats a zero-amount mint as a no-op that succeeds even with no headroom", async function () {
      // documents current behaviour: `amount > remaining` is false for 0 > 0
      await token.setMinter(minter.address);

      await expect(token.connect(minter).mint(alice.address, 0n))
        .to.emit(token, "Transfer")
        .withArgs(ethers.ZeroAddress, alice.address, 0n);

      expect(await token.totalSupply()).to.equal(0n);
      expect(await token.mintedInEpoch(0)).to.equal(0n);
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
