const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

/**
 * TokenOverture — the Overture token ($OVTR), one of the LP staking reward tokens.
 *
 * Every test runs against the PROXY, because the proxy address is the token address: users hold
 * balances there, the permit domain names it, and `RewardsDistributor` is funded there. The
 * implementation behind it burns its own initializers and holds nothing.
 *
 * The token has no cap of any kind. The minter — at launch the `RewardsDistributor` PROXY, which
 * the operator drives with `mintRewardToken` — mints $OVTR INTO the distributor (which pays
 * claims by transfer) or to any other wallet; the owner (the timelock) upgrades the token and
 * moves the minter role. Here the `minter` signer stands in for the distributor: what is
 * measured is the token's own rule, "one address mints", whoever that address is.
 */
describe("TokenOverture", function () {
  let token, tokenAddr, deployTx;
  let owner, minter, alice, bob, stranger;

  const NAME = "Overture";
  const SYMBOL = "OVTR";
  const TOKENS = (n) => ethers.parseEther(String(n));
  const FAR_DEADLINE = 10n ** 12n;

  // `constructor`: the implementation constructor runs `_disableInitializers()`.
  // `missing-initializer`: V2 upgrades an already-initialized proxy and declares only a
  // `reinitializer(2)`.
  const V1_UNSAFE_ALLOW = ["constructor"];
  const V2_UNSAFE_ALLOW = ["constructor", "missing-initializer"];

  /**
   * The production shape, spelled out: the implementation, then an `LPProxy` whose constructor
   * delegatecalls `initialize(name, symbol, owner, minter)` in the same transaction.
   */
  async function deployTokenProxy(name, symbol, ownerAddress, minterAddress) {
    const Token = await ethers.getContractFactory("TokenOverture");
    const impl = await Token.deploy();
    await impl.waitForDeployment();
    const Proxy = await ethers.getContractFactory("LPProxy");
    const proxy = await Proxy.deploy(
      await impl.getAddress(),
      Token.interface.encodeFunctionData("initialize", [name, symbol, ownerAddress, minterAddress])
    );
    await proxy.waitForDeployment();
    const contract = await ethers.getContractAt("TokenOverture", await proxy.getAddress());
    return { contract, impl, tx: proxy.deploymentTransaction() };
  }

  async function permitSignature(from, spender, value, opts = {}) {
    const domain = {
      name: opts.domainName ?? NAME,
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: opts.verifyingContract ?? tokenAddr,
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
    [owner, minter, alice, bob, stranger] = await ethers.getSigners();
    const deployed = await deployTokenProxy(NAME, SYMBOL, owner.address, minter.address);
    token = deployed.contract;
    tokenAddr = await token.getAddress();
    deployTx = deployed.tx;
  });

  // ─────────────────────────────────────────────────────────────
  describe("Deployment through the proxy", function () {
    it("takes name and symbol from initialize, fixes 18 decimals and starts with no supply", async function () {
      expect(await token.name()).to.equal(NAME);
      expect(await token.symbol()).to.equal(SYMBOL);
      expect(await token.decimals()).to.equal(18n);
      expect(await token.totalSupply()).to.equal(0n);
      expect(await token.owner()).to.equal(owner.address);
      expect(await token.pendingOwner()).to.equal(ethers.ZeroAddress);
      expect(await token.minter()).to.equal(minter.address);
    });

    it("announces its whole initial state in the proxy's own deploy tx, in order", async function () {
      const receipt = await deployTx.wait();
      const ours = receipt.logs
        .filter((log) => log.address === tokenAddr)
        .map((log) => token.interface.parseLog(log))
        .filter((parsed) => parsed !== null)
        .map((parsed) => parsed.name);

      expect(ours).to.deep.equal([
        "Upgraded", // ERC-1967, naming the implementation the proxy's constructor installed
        "OwnershipTransferred", // OZ, from __Ownable_init(owner)
        "MinterChanged",
        "Initialized", // OZ, closing the initializer
      ]);
      await expect(deployTx).to.emit(token, "MinterChanged").withArgs(ethers.ZeroAddress, minter.address);
      await expect(deployTx)
        .to.emit(token, "OwnershipTransferred")
        .withArgs(ethers.ZeroAddress, owner.address);
    });

    it("brands a different deployment independently, and may start with minting off", async function () {
      const { contract: other } = await deployTokenProxy(
        "Real Rewards",
        "REALR",
        bob.address,
        ethers.ZeroAddress
      );
      expect(await other.name()).to.equal("Real Rewards");
      expect(await other.symbol()).to.equal("REALR");
      expect(await other.owner()).to.equal(bob.address);
      expect(await other.minter()).to.equal(ethers.ZeroAddress);
    });

    it("rejects a zero owner in initialize", async function () {
      await expect(deployTokenProxy(NAME, SYMBOL, ethers.ZeroAddress, minter.address))
        .to.be.revertedWithCustomError(token, "OwnableInvalidOwner")
        .withArgs(ethers.ZeroAddress);
    });

    it("cannot initialise the bare implementation, which stays empty", async function () {
      const implAddr = await upgrades.erc1967.getImplementationAddress(tokenAddr);
      const impl = await ethers.getContractAt("TokenOverture", implAddr);

      await expect(
        impl.initialize(NAME, SYMBOL, alice.address, alice.address)
      ).to.be.revertedWithCustomError(impl, "InvalidInitialization");
      expect(await impl.owner()).to.equal(ethers.ZeroAddress);
      expect(await impl.name()).to.equal("");
    });

    it("cannot initialise the proxy a second time", async function () {
      await expect(
        token.initialize("Other", "OTH", alice.address, alice.address)
      ).to.be.revertedWithCustomError(token, "InvalidInitialization");
      expect(await token.owner()).to.equal(owner.address);
      expect(await token.minter()).to.equal(minter.address);
    });

    it("leaves the ERC-1967 admin slot empty: the upgrade authority lives in the implementation", async function () {
      expect(await upgrades.erc1967.getAdminAddress(tokenAddr)).to.equal(ethers.ZeroAddress);
    });

    it("passes the plugin's UUPS implementation-safety check", async function () {
      await upgrades.validateImplementation(await ethers.getContractFactory("TokenOverture"), {
        kind: "uups",
        unsafeAllow: V1_UNSAFE_ALLOW,
      });
    });

    it("keeps the minter in the pinned ERC-7201 namespace real.lp.storage.TokenOverture", async function () {
      const namespace =
        ethers.toBigInt(
          ethers.keccak256(
            ethers.AbiCoder.defaultAbiCoder().encode(
              ["uint256"],
              [ethers.toBigInt(ethers.keccak256(ethers.toUtf8Bytes("real.lp.storage.TokenOverture"))) - 1n]
            )
          )
        ) & ~0xffn;
      expect(ethers.toBeHex(namespace, 32)).to.equal(
        "0x7ca9f8db09cacc7881e534e068295c46832e8cbf76a90cb6e2f245c9bf51b600"
      );
      const slot0 = await ethers.provider.getStorage(tokenAddr, namespace);
      expect(ethers.getAddress(ethers.dataSlice(slot0, 12))).to.equal(minter.address);
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

      await expect(token.connect(bob).setMinter(bob.address))
        .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount")
        .withArgs(bob.address);

      // ...and the standing owner still holds the whole admin surface.
      await expect(token.setMinter(alice.address)).to.emit(token, "MinterChanged");
    });

    it("moves the owner only when the nominee accepts", async function () {
      await token.transferOwnership(bob.address);

      await expect(token.connect(bob).acceptOwnership())
        .to.emit(token, "OwnershipTransferred")
        .withArgs(owner.address, bob.address);

      expect(await token.owner()).to.equal(bob.address);
      expect(await token.pendingOwner()).to.equal(ethers.ZeroAddress);

      await expect(token.setMinter(alice.address))
        .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount")
        .withArgs(owner.address);
      await expect(token.connect(bob).setMinter(alice.address)).to.emit(token, "MinterChanged");
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
      // An ownerless token could never be upgraded nor have its minter moved.
      await expect(token.renounceOwnership()).to.be.revertedWithCustomError(token, "RenounceDisabled");
      expect(await token.owner()).to.equal(owner.address);

      await expect(token.connect(alice).renounceOwnership())
        .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount")
        .withArgs(alice.address);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("setMinter", function () {
    it("is owner only — the minter cannot move its own role", async function () {
      await expect(token.connect(alice).setMinter(alice.address))
        .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount")
        .withArgs(alice.address);
      await expect(token.connect(minter).setMinter(alice.address))
        .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount")
        .withArgs(minter.address);
    });

    it("emits MinterChanged carrying the previous and the new minter", async function () {
      await expect(token.setMinter(bob.address))
        .to.emit(token, "MinterChanged")
        .withArgs(minter.address, bob.address);
      expect(await token.minter()).to.equal(bob.address);

      await expect(token.setMinter(alice.address))
        .to.emit(token, "MinterChanged")
        .withArgs(bob.address, alice.address);
      expect(await token.minter()).to.equal(alice.address);
    });

    it("re-points minting rights, and the old minter is out at once", async function () {
      await token.connect(minter).mint(alice.address, TOKENS(10));
      await token.setMinter(bob.address);

      await expect(token.connect(minter).mint(alice.address, TOKENS(1)))
        .to.be.revertedWithCustomError(token, "NotMinter")
        .withArgs(minter.address);

      await token.connect(bob).mint(alice.address, TOKENS(90));
      expect(await token.balanceOf(alice.address)).to.equal(TOKENS(100));
    });

    it("accepts address(0) and that disables minting entirely", async function () {
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
      await expect(token.connect(alice).mint(alice.address, TOKENS(1)))
        .to.be.revertedWithCustomError(token, "NotMinter")
        .withArgs(alice.address);

      await expect(token.mint(alice.address, TOKENS(1)))
        .to.be.revertedWithCustomError(token, "NotMinter")
        .withArgs(owner.address);
    });

    it("mints to the named recipient, not to the minter, and emits Transfer from zero", async function () {
      await expect(token.connect(minter).mint(alice.address, TOKENS(40)))
        .to.emit(token, "Transfer")
        .withArgs(ethers.ZeroAddress, alice.address, TOKENS(40));

      expect(await token.balanceOf(alice.address)).to.equal(TOKENS(40));
      expect(await token.balanceOf(minter.address)).to.equal(0n);
      expect(await token.totalSupply()).to.equal(TOKENS(40));
    });

    it("rejects a zero amount instead of emitting a zero-value Transfer", async function () {
      await expect(token.connect(minter).mint(alice.address, 0n)).to.be.revertedWithCustomError(
        token,
        "ZeroAmount"
      );
      expect(await token.totalSupply()).to.equal(0n);
    });

    it("checks the minter before the amount", async function () {
      await expect(token.connect(alice).mint(alice.address, 0n))
        .to.be.revertedWithCustomError(token, "NotMinter")
        .withArgs(alice.address);
    });

    it("carries the IMintableRewardToken shape: mint(address,uint256), selector 0x40c10f19", async function () {
      // Every reward token this program deploys exposes exactly this call, so the distributor's
      // `mintRewardToken` can reach any of them through the one interface.
      const shaped = await ethers.getContractAt("IMintableRewardToken", tokenAddr);
      expect(shaped.interface.getFunction("mint").selector).to.equal("0x40c10f19");
      expect(token.interface.getFunction("mint").selector).to.equal("0x40c10f19");

      await shaped.connect(minter).mint(alice.address, TOKENS(3));
      expect(await token.balanceOf(alice.address)).to.equal(TOKENS(3));
      await expect(shaped.connect(stranger).mint(alice.address, 1n))
        .to.be.revertedWithCustomError(token, "NotMinter")
        .withArgs(stranger.address);
    });

    it("has no cap of any kind: repeated large mints all go through", async function () {
      // No per-epoch cap, no total cap, no schedule: the minter decides the supply.
      const big = TOKENS(1_000_000_000_000); // 1e12 tokens per call
      for (let i = 0; i < 5; i++) {
        await token.connect(minter).mint(bob.address, big);
      }
      expect(await token.totalSupply()).to.equal(big * 5n);

      // Far beyond any program budget, still no bound below the ERC-20's own uint256 supply.
      const huge = 10n ** 60n;
      await token.connect(minter).mint(alice.address, huge);
      expect(await token.balanceOf(alice.address)).to.equal(huge);
    });

    it("mints INTO a distributor-like holder, which then pays by transfer", async function () {
      // The launch flow: the operator calls RewardsDistributor.mintRewardToken, the distributor
      // (the minter) mints $OVTR into its own balance, and claims pay out of that balance. Here
      // `bob` stands in for the distributor's balance.
      await token.connect(minter).mint(bob.address, TOKENS(1_000));
      await token.connect(bob).transfer(alice.address, TOKENS(250));
      expect(await token.balanceOf(alice.address)).to.equal(TOKENS(250));
      expect(await token.balanceOf(bob.address)).to.equal(TOKENS(750));
      expect(await token.totalSupply()).to.equal(TOKENS(1_000));
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("ERC20Permit through the proxy", function () {
    beforeEach(async function () {
      await token.connect(minter).mint(alice.address, TOKENS(100));
    });

    it("uses the deployed name as the EIP-712 domain name and the PROXY as verifying contract", async function () {
      const [, name, version, chainId, verifyingContract] = await token.eip712Domain();
      expect(name).to.equal(NAME);
      expect(version).to.equal("1");
      expect(chainId).to.equal((await ethers.provider.getNetwork()).chainId);
      expect(verifyingContract).to.equal(tokenAddr);

      const implAddr = await upgrades.erc1967.getImplementationAddress(tokenAddr);
      expect(verifyingContract).to.not.equal(implAddr);

      const expectedSeparator = ethers.TypedDataEncoder.hashDomain({
        name: NAME,
        version: "1",
        chainId,
        verifyingContract: tokenAddr,
      });
      expect(await token.DOMAIN_SEPARATOR()).to.equal(expectedSeparator);
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

    it("rejects a permit signed against the implementation's address", async function () {
      const implAddr = await upgrades.erc1967.getImplementationAddress(tokenAddr);
      const { v, r, s } = await permitSignature(alice, bob, TOKENS(25), { verifyingContract: implAddr });

      await expect(
        token.connect(bob).permit(alice.address, bob.address, TOKENS(25), FAR_DEADLINE, v, r, s)
      ).to.be.revertedWithCustomError(token, "ERC2612InvalidSigner");
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

    it("burning neither gives the minter anything back nor takes anything away", async function () {
      await token.connect(alice).burn(TOKENS(100));
      expect(await token.totalSupply()).to.equal(0n);
      // Minting is unaffected: there is no tally for a burn to touch.
      await token.connect(minter).mint(alice.address, TOKENS(5));
      expect(await token.totalSupply()).to.equal(TOKENS(5));
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("Upgradeability", function () {
    async function deployV2Impl() {
      const V2 = await ethers.getContractFactory("TokenOvertureV2Mock");
      const impl = await V2.deploy();
      await impl.waitForDeployment();
      return impl;
    }

    it("passes the plugin's implementation-safety check for the V2", async function () {
      await upgrades.validateImplementation(await ethers.getContractFactory("TokenOvertureV2Mock"), {
        kind: "uups",
        unsafeAllow: V2_UNSAFE_ALLOW,
      });
    });

    it("rejects upgradeToAndCall from a stranger and from the minter", async function () {
      const implAddr = await (await deployV2Impl()).getAddress();
      for (const caller of [stranger, minter]) {
        await expect(token.connect(caller).upgradeToAndCall(implAddr, "0x"))
          .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount")
          .withArgs(caller.address);
      }
    });

    it("keeps balances, allowances, permit nonces, the minter, the owner and the branding across the owner's upgrade", async function () {
      await token.connect(minter).mint(alice.address, TOKENS(100));
      await token.connect(alice).approve(bob.address, TOKENS(30));
      const first = await permitSignature(alice, stranger, TOKENS(7));
      await token
        .connect(stranger)
        .permit(alice.address, stranger.address, TOKENS(7), FAR_DEADLINE, first.v, first.r, first.s);
      // A permit signed BEFORE the upgrade, spent AFTER it: the domain and the nonce survive.
      const pending = await permitSignature(alice, bob, TOKENS(11));

      const impl = await deployV2Impl();
      const implAddr = await impl.getAddress();
      const data = impl.interface.encodeFunctionData("initializeV2", [77n]);
      await expect(token.upgradeToAndCall(implAddr, data)).to.emit(token, "Upgraded").withArgs(implAddr);

      const v2 = await ethers.getContractAt("TokenOvertureV2Mock", tokenAddr);
      expect(await v2.version()).to.equal(2n);
      expect(await v2.upgradeMarker()).to.equal(77n);
      expect(await upgrades.erc1967.getImplementationAddress(tokenAddr)).to.equal(implAddr);

      expect(await v2.balanceOf(alice.address)).to.equal(TOKENS(100));
      expect(await v2.totalSupply()).to.equal(TOKENS(100));
      expect(await v2.allowance(alice.address, bob.address)).to.equal(TOKENS(30));
      expect(await v2.allowance(alice.address, stranger.address)).to.equal(TOKENS(7));
      expect(await v2.nonces(alice.address)).to.equal(1n);
      expect(await v2.minter()).to.equal(minter.address);
      expect(await v2.owner()).to.equal(owner.address);
      expect(await v2.name()).to.equal(NAME);
      expect(await v2.symbol()).to.equal(SYMBOL);

      await v2.connect(bob).permit(alice.address, bob.address, TOKENS(11), FAR_DEADLINE, pending.v, pending.r, pending.s);
      expect(await v2.allowance(alice.address, bob.address)).to.equal(TOKENS(11));

      // The minter still mints through the new code; the reinitializer runs once.
      await v2.connect(minter).mint(bob.address, TOKENS(1));
      expect(await v2.balanceOf(bob.address)).to.equal(TOKENS(1));
      await expect(v2.initializeV2(1n)).to.be.revertedWithCustomError(v2, "InvalidInitialization");
    });

    it("upgrades through the plugin's upgradeProxy with the V2 validation flags", async function () {
      // `upgradeProxy` needs the proxy in the plugin's manifest; `forceImport` records the one
      // this suite deployed by hand, exactly as the deploy script does after its own deploy.
      await upgrades.forceImport(tokenAddr, await ethers.getContractFactory("TokenOverture"), {
        kind: "uups",
      });
      await token.connect(minter).mint(alice.address, TOKENS(3));

      const upgraded = await upgrades.upgradeProxy(
        tokenAddr,
        await ethers.getContractFactory("TokenOvertureV2Mock"),
        { kind: "uups", unsafeAllow: V2_UNSAFE_ALLOW }
      );
      expect(await upgraded.version()).to.equal(2n);
      expect(await upgraded.balanceOf(alice.address)).to.equal(TOKENS(3));
    });

    describe("under a TimelockController", function () {
      const MIN_DELAY = 60n;
      const PREDECESSOR = ethers.ZeroHash;
      const SALT = ethers.ZeroHash;
      let timelock, timelockAddr;

      beforeEach(async function () {
        // `stranger` stands in for the multisig: proposer, executor and canceller.
        const Timelock = await ethers.getContractFactory("LPTimelock");
        timelock = await Timelock.deploy(MIN_DELAY, [stranger.address], [stranger.address], ethers.ZeroAddress);
        timelockAddr = await timelock.getAddress();

        await token.transferOwnership(timelockAddr);
        const accept = token.interface.encodeFunctionData("acceptOwnership", []);
        await timelock.connect(stranger).schedule(tokenAddr, 0, accept, PREDECESSOR, SALT, MIN_DELAY);
        await time.increase(Number(MIN_DELAY) + 1);
        await timelock.connect(stranger).execute(tokenAddr, 0, accept, PREDECESSOR, SALT);
        expect(await token.owner()).to.equal(timelockAddr);
      });

      it("moves the minter only through a scheduled operation, after the delay", async function () {
        const data = token.interface.encodeFunctionData("setMinter", [bob.address]);
        const salt = ethers.id("set-minter");
        await timelock.connect(stranger).schedule(tokenAddr, 0, data, PREDECESSOR, salt, MIN_DELAY);

        await expect(
          timelock.connect(stranger).execute(tokenAddr, 0, data, PREDECESSOR, salt)
        ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");

        await time.increase(Number(MIN_DELAY) + 1);
        await expect(timelock.connect(stranger).execute(tokenAddr, 0, data, PREDECESSOR, salt))
          .to.emit(token, "MinterChanged")
          .withArgs(minter.address, bob.address);
      });

      it("upgrades only through the timelock, which keeps the balances", async function () {
        await token.connect(minter).mint(alice.address, TOKENS(9));
        const implAddr = await (await deployV2Impl()).getAddress();

        await expect(token.connect(stranger).upgradeToAndCall(implAddr, "0x"))
          .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount")
          .withArgs(stranger.address);

        const data = token.interface.encodeFunctionData("upgradeToAndCall", [implAddr, "0x"]);
        const salt = ethers.id("upgrade");
        await timelock.connect(stranger).schedule(tokenAddr, 0, data, PREDECESSOR, salt, MIN_DELAY);
        await time.increase(Number(MIN_DELAY) + 1);
        await expect(timelock.connect(stranger).execute(tokenAddr, 0, data, PREDECESSOR, salt))
          .to.emit(token, "Upgraded")
          .withArgs(implAddr);

        const v2 = await ethers.getContractAt("TokenOvertureV2Mock", tokenAddr);
        expect(await v2.version()).to.equal(2n);
        expect(await v2.balanceOf(alice.address)).to.equal(TOKENS(9));
        expect(await v2.minter()).to.equal(minter.address);
      });

      it("leaves the minter's mint undelayed while the timelock owns the token", async function () {
        await token.connect(minter).mint(alice.address, TOKENS(4));
        expect(await token.balanceOf(alice.address)).to.equal(TOKENS(4));
      });
    });
  });
});
