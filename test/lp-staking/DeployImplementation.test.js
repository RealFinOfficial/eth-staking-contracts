const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const lpTimelock = require("../../scripts/lp-timelock");
const {
  IMPL_KINDS,
  UUPS_UNSAFE_ALLOW,
  resolveProxyAddress,
  pendingImplementationRecord,
  deployImplementation,
} = require("../../scripts/deploy-implementation");

/**
 * `scripts/deploy-implementation.js`, run against a stack this suite deploys itself.
 *
 * The script's one job is to put a NEW implementation of a live proxy on chain, validated
 * against that proxy's storage layout, and to hand the operator the two timelock commands
 * that activate it. Both halves are exercised here end to end: the function deploys the
 * implementation, and the operation `scripts/lp-timelock.js` builds from the very same
 * arguments is scheduled, waited out and executed on a real `LPTimelock` — so what the
 * script PRINTS and what this suite SENDS are produced by one builder and cannot drift.
 *
 * Two things differ from a Sepolia run, and only two:
 *
 *   - the proxy address is passed in rather than looked up in `deployments.json`, because
 *     chain 31337 has no entry there. That is the script's own `IMPL_PROXY_ADDRESS` path,
 *     and the registry branch is covered by its error message below. The tracked registry is
 *     never written to by this suite.
 *   - the "next revision" is `LPStakingVaultV2Mock` / `RewardsDistributorV2Mock`, handed in
 *     through the script's `contractName`. One Solidity source cannot be compiled at two
 *     revisions in one run, so a genuinely different implementation has to be a different
 *     contract. Both mocks declare a `reinitializer(2)` and no `initializer` of their own,
 *     which is what `missing-initializer` in `unsafeAllowExtra` allows — the same flag the
 *     upgrade tests in LPStakingVault.test.js and RewardsDistributor.test.js pass.
 *
 * The `hardhat-upgrades` manifest lands in the OS temp directory on a development chain
 * (os.tmpdir()/openzeppelin-upgrades/hardhat-31337-<instanceId>.json), never in the repo's
 * committed `.openzeppelin/`, so these runs leave nothing behind to clean up.
 */
describe("deploy-implementation.js", function () {
  let deployer, multisig, guardian, operatorSafe, voucherSigner, alice;
  let timelock, timelockAddr;
  let vault, vaultAddr, distributor, distributorAddr;
  let tokenX, tokenXAddr, assetToken, assetAddr;
  let pool, poolAddr, nfpm, nfpmAddr, router, routerAddr;
  let token0, token1, token0Addr, token1Addr;

  const FEE = 3000;
  const TWAP_WINDOW = 600;
  const MAX_DEVIATION_TICKS = 500;
  const TICK_LOWER = -600;
  const TICK_UPPER = 600;
  const LIQUIDITY = 1_000_000n;
  const MIN_DELAY = 60n;
  const EPOCH = 1n;
  const TOKENS = (n) => ethers.parseEther(String(n));
  const FAR_DEADLINE = 10n ** 12n;

  /// The V2 mocks are upgrades of an ALREADY-initialized proxy, so they declare no
  /// `initializer` of their own. Everything else is the script's own fixed flag list.
  const V2_UNSAFE_ALLOW_EXTRA = ["missing-initializer"];

  /// One owner-tier operation, built by scripts/lp-timelock.js and sent by the multisig.
  /// The salt is the derived one, so this is byte-for-byte the call the printed command makes.
  async function scheduleAndExecute(target, fn, args) {
    const op = lpTimelock.buildOperation({ target, fn, args });
    await timelock
      .connect(multisig)
      .schedule(op.target, op.value, op.data, op.predecessor, op.salt, MIN_DELAY);
    await time.increase(Number(MIN_DELAY) + 1);
    return timelock
      .connect(multisig)
      .execute(op.target, op.value, op.data, op.predecessor, op.salt);
  }

  /// Fabricates a position NFT for `holder` and stakes it, so the vault has a ledger entry
  /// that has to survive the upgrade.
  async function stakePosition(holder) {
    await nfpm.mintFake(
      holder.address,
      token0Addr,
      token1Addr,
      FEE,
      TICK_LOWER,
      TICK_UPPER,
      LIQUIDITY,
      0n,
      0n
    );
    const tokenId = await nfpm.lastMintedId();
    await nfpm.connect(holder).approve(vaultAddr, tokenId);
    await vault.connect(holder).stake(tokenId);
    return tokenId;
  }

  /// A TokenX voucher signed by the distributor's signer, so the claim ledger has an entry
  /// that has to survive the upgrade.
  async function claimTokenX(user, cumulativeAmount) {
    const signature = await voucherSigner.signTypedData(
      {
        name: "RealLPRewards",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: distributorAddr,
      },
      {
        TokenXClaim: [
          { name: "user", type: "address" },
          { name: "cumulativeAmount", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      { user: user.address, cumulativeAmount, deadline: FAR_DEADLINE }
    );
    return distributor.connect(user).claimTokenX(cumulativeAmount, FAR_DEADLINE, signature);
  }

  beforeEach(async function () {
    [deployer, multisig, guardian, operatorSafe, voucherSigner, alice] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockERC20Decimals");
    const usdc = await Token.deploy("USD Coin", "USDC", 1_000_000n * 10n ** 6n, 6);
    assetToken = await Token.deploy("Asset", "ASSET", 1_000_000n * 10n ** 18n, 18);
    assetAddr = await assetToken.getAddress();

    // Uniswap sorts the pair ascending by address, so which of the two ends up as token0 is
    // an accident of deployment order; the vault only ever sees the sorted pair.
    const sorted =
      (await usdc.getAddress()).toLowerCase() < assetAddr.toLowerCase()
        ? [usdc, assetToken]
        : [assetToken, usdc];
    [token0, token1] = sorted;
    token0Addr = await token0.getAddress();
    token1Addr = await token1.getAddress();

    const Pool = await ethers.getContractFactory("MockUniswapV3Pool");
    pool = await Pool.deploy(token0Addr, token1Addr, FEE);
    poolAddr = await pool.getAddress();

    const Nfpm = await ethers.getContractFactory("MockPositionManager");
    nfpm = await Nfpm.deploy();
    nfpmAddr = await nfpm.getAddress();

    const Router = await ethers.getContractFactory("MockSwapRouter");
    router = await Router.deploy();
    routerAddr = await router.getAddress();

    const TokenXFactory = await ethers.getContractFactory("TokenX");
    tokenX = await TokenXFactory.deploy("Token X", "TKX", deployer.address);
    tokenXAddr = await tokenX.getAddress();

    // The multisig is the timelock's only proposer, executor and canceller, and the timelock
    // is its own admin — the production shape, and the one deploy-lp-staking.js deploys.
    const Timelock = await ethers.getContractFactory("LPTimelock");
    timelock = await Timelock.deploy(
      MIN_DELAY,
      [multisig.address],
      [multisig.address],
      ethers.ZeroAddress
    );
    timelockAddr = await timelock.getAddress();

    // Both proxies are born owned by the timelock, exactly as on Sepolia test stack #5: no
    // key ever holds the owner tier, so an upgrade can only be a scheduled operation.
    const Vault = await ethers.getContractFactory("LPStakingVault");
    vault = await upgrades.deployProxy(
      Vault,
      [
        timelockAddr,
        guardian.address,
        operatorSafe.address,
        ethers.ZeroAddress,
        TWAP_WINDOW,
        MAX_DEVIATION_TICKS,
      ],
      {
        kind: "uups",
        constructorArgs: [nfpmAddr, poolAddr, token0Addr, token1Addr, FEE, routerAddr],
        unsafeAllow: UUPS_UNSAFE_ALLOW,
      }
    );
    vaultAddr = await vault.getAddress();

    const Distributor = await ethers.getContractFactory("RewardsDistributor");
    distributor = await upgrades.deployProxy(
      Distributor,
      [timelockAddr, guardian.address, operatorSafe.address, voucherSigner.address],
      {
        kind: "uups",
        constructorArgs: [tokenXAddr, assetAddr],
        unsafeAllow: UUPS_UNSAFE_ALLOW,
      }
    );
    distributorAddr = await distributor.getAddress();

    await tokenX.setMinter(distributorAddr);
    await tokenX.setEpochCap(EPOCH, TOKENS(1_000_000));
  });

  // ─────────────────────────────────────────────────────────────
  describe("deploying a new implementation", function () {
    it("deploys a vault implementation the timelock upgrades onto, ledger intact", async function () {
      const tokenId = await stakePosition(alice);
      const before = await upgrades.erc1967.getImplementationAddress(vaultAddr);

      const result = await deployImplementation({
        kind: "LPStakingVault",
        proxyAddress: vaultAddr,
        contractName: "LPStakingVaultV2Mock",
        unsafeAllowExtra: V2_UNSAFE_ALLOW_EXTRA,
        deployer,
        quiet: true,
      });

      // A real deploy, at a new address, with code on it.
      expect(result.reused).to.equal(false);
      expect(result.currentImplementation).to.equal(ethers.getAddress(before));
      expect(result.implementation).to.not.equal(result.currentImplementation);
      expect(await ethers.provider.getCode(result.implementation)).to.not.equal("0x");
      expect(result.codeSize).to.be.greaterThan(0);
      expect(result.deployTxHash).to.match(/^0x[0-9a-f]{64}$/);
      expect(result.blockNumber).to.be.a("number");

      // Read back off the live proxy, in constructor order, not from a hardcoded list.
      expect(result.constructorArgs).to.deep.equal([
        nfpmAddr,
        poolAddr,
        token0Addr,
        token1Addr,
        FEE,
        routerAddr,
      ]);

      // Nothing is live yet: the script sends the deploy and NOTHING else.
      expect(await upgrades.erc1967.getImplementationAddress(vaultAddr)).to.equal(before);
      expect(await vault.owner()).to.equal(timelockAddr);

      await expect(scheduleAndExecute(vaultAddr, "upgradeToAndCall", [result.implementation, "0x"]))
        .to.emit(vault, "Upgraded")
        .withArgs(result.implementation);

      expect(await upgrades.erc1967.getImplementationAddress(vaultAddr)).to.equal(
        result.implementation
      );

      const upgraded = await ethers.getContractAt("LPStakingVaultV2Mock", vaultAddr);
      expect(await upgraded.version()).to.equal(2n);
      expect(await upgraded.stakerOf(tokenId)).to.equal(alice.address);
      expect(await nfpm.ownerOf(tokenId)).to.equal(vaultAddr);
      expect(await upgraded.owner()).to.equal(timelockAddr);
      expect(await upgraded.guardian()).to.equal(guardian.address);
      expect(await upgraded.operator()).to.equal(operatorSafe.address);
      expect(await upgraded.twapWindow()).to.equal(TWAP_WINDOW);
      expect(await upgraded.maxTwapDeviationTicks()).to.equal(MAX_DEVIATION_TICKS);

      // And the exit still works against the new code.
      await vault.connect(alice).unstake(tokenId);
      expect(await nfpm.ownerOf(tokenId)).to.equal(alice.address);
    });

    it("deploys a distributor implementation the timelock upgrades onto, ledger kept", async function () {
      await claimTokenX(alice, TOKENS(100));
      const before = await upgrades.erc1967.getImplementationAddress(distributorAddr);

      const result = await deployImplementation({
        kind: "RewardsDistributor",
        proxyAddress: distributorAddr,
        contractName: "RewardsDistributorV2Mock",
        unsafeAllowExtra: V2_UNSAFE_ALLOW_EXTRA,
        deployer,
        quiet: true,
      });

      expect(result.reused).to.equal(false);
      expect(result.currentImplementation).to.equal(ethers.getAddress(before));
      expect(result.implementation).to.not.equal(result.currentImplementation);
      expect(await ethers.provider.getCode(result.implementation)).to.not.equal("0x");
      expect(result.constructorArgs).to.deep.equal([tokenXAddr, assetAddr]);
      expect(await upgrades.erc1967.getImplementationAddress(distributorAddr)).to.equal(before);

      await expect(
        scheduleAndExecute(distributorAddr, "upgradeToAndCall", [result.implementation, "0x"])
      )
        .to.emit(distributor, "Upgraded")
        .withArgs(result.implementation);

      expect(await upgrades.erc1967.getImplementationAddress(distributorAddr)).to.equal(
        result.implementation
      );

      const upgraded = await ethers.getContractAt("RewardsDistributorV2Mock", distributorAddr);
      expect(await upgraded.version()).to.equal(2n);
      expect(await upgraded.claimedTokenX(alice.address)).to.equal(TOKENS(100));
      expect(await tokenX.balanceOf(alice.address)).to.equal(TOKENS(100));
      expect(await upgraded.signer()).to.equal(voucherSigner.address);
      expect(await upgraded.owner()).to.equal(timelockAddr);
      expect(await upgraded.guardian()).to.equal(guardian.address);
      expect(await upgraded.operator()).to.equal(operatorSafe.address);

      // The EIP-712 domain is the proxy's own address, so a voucher signed after the upgrade
      // still spends against the same ledger.
      await claimTokenX(alice, TOKENS(150));
      expect(await upgraded.claimedTokenX(alice.address)).to.equal(TOKENS(150));
    });

    it("prints the two timelock commands for the address it deployed", async function () {
      const result = await deployImplementation({
        kind: "LPStakingVault",
        proxyAddress: vaultAddr,
        contractName: "LPStakingVaultV2Mock",
        unsafeAllowExtra: V2_UNSAFE_ALLOW_EXTRA,
        deployer,
        quiet: true,
      });

      for (const command of [result.scheduleCommand, result.executeCommand]) {
        expect(command).to.include("scripts/lp-timelock.js");
        expect(command).to.include("TIMELOCK_TARGET=LPStakingVault");
        expect(command).to.include("TIMELOCK_FN=upgradeToAndCall");
        expect(command).to.include(`TIMELOCK_ARGS=${result.implementation},0x`);
      }
      expect(result.scheduleCommand).to.include("TIMELOCK_ACTION=schedule");
      expect(result.executeCommand).to.include("TIMELOCK_ACTION=execute");

      // The operands in those commands are the ones lp-timelock.js turns into the operation,
      // so the printed line and the call this suite sends are the same operation id.
      const fromCommand = lpTimelock.buildOperation({
        target: vaultAddr,
        fn: "upgradeToAndCall",
        args: [result.implementation, "0x"],
      });
      expect(fromCommand.data).to.equal(
        vault.interface.encodeFunctionData("upgradeToAndCall", [result.implementation, "0x"])
      );
    });

    it("reuses an identical implementation instead of deploying a second copy", async function () {
      for (const [kind, proxyAddress] of [
        ["LPStakingVault", vaultAddr],
        ["RewardsDistributor", distributorAddr],
      ]) {
        // Same contract, same constructor arguments, so the plugin's (bytecode, args) key
        // resolves to the implementation the proxy already runs: nothing is deployed, and the
        // script says there is nothing to upgrade to.
        const result = await deployImplementation({ kind, proxyAddress, deployer, quiet: true });

        expect(result.reused).to.equal(true);
        expect(result.implementation).to.equal(result.currentImplementation);
        expect(await upgrades.erc1967.getImplementationAddress(proxyAddress)).to.equal(
          result.implementation
        );
      }
    });

    it("deploys once for a second run of the same new implementation", async function () {
      const options = {
        kind: "LPStakingVault",
        proxyAddress: vaultAddr,
        contractName: "LPStakingVaultV2Mock",
        unsafeAllowExtra: V2_UNSAFE_ALLOW_EXTRA,
        deployer,
        quiet: true,
      };

      const first = await deployImplementation(options);
      const second = await deployImplementation(options);

      expect(first.reused).to.equal(false);
      expect(second.reused).to.equal(true);
      expect(second.implementation).to.equal(first.implementation);
      expect(second.currentImplementation).to.equal(first.currentImplementation);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("inputs", function () {
    it("rejects a target that is not one of the two proxies", async function () {
      await expect(
        deployImplementation({ kind: "LPZapper", proxyAddress: vaultAddr, deployer, quiet: true })
      ).to.be.rejectedWith(`IMPL_TARGET must be one of ${IMPL_KINDS.join(", ")}`);
    });

    it("names the override when the chain has no entry in deployments.json", async function () {
      // Chain 31337 is in no registry, which is the lookup's whole failure mode: say which
      // variable answers it rather than carrying an undefined address forward.
      await expect(
        deployImplementation({ kind: "LPStakingVault", deployer, quiet: true })
      ).to.be.rejectedWith(/No LPStakingVault recorded for chain 31337 .*IMPL_PROXY_ADDRESS/s);

      expect(() => resolveProxyAddress(31337, "RewardsDistributor", undefined)).to.throw(
        /IMPL_PROXY_ADDRESS/
      );
      expect(resolveProxyAddress(31337, "RewardsDistributor", distributorAddr)).to.equal(
        distributorAddr
      );
    });

    it("refuses a proxy with no code", async function () {
      await expect(
        deployImplementation({
          kind: "LPStakingVault",
          proxyAddress: alice.address,
          deployer,
          quiet: true,
        })
      ).to.be.rejectedWith(/No contract code at LPStakingVault proxy/);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("RECORD=1", function () {
    // The writer itself is `pools.recordDeployment`, which REPLACES an entry rather than
    // merging into it; this is the shape handed to it, and the only thing that decides
    // whether the rest of deployments.json survives the write.
    const entry = {
      address: "0x6Ed8b565A61807591616e42263D91eBfA67Ddd56",
      deployTx: "0x04c37e8dd0581542ef5e7b29b37cb710a58f0b2ccc723feb77d04209cb5d6d01",
      block: 11680396,
      implementation: "0xdA1FF637E277087404f08b26cc376Daf9C551aD8",
      owner: "0x591c51A6EE2ef571C44dF2339A7c92b57850C082",
    };

    it("appends the two pending keys and leaves every other field alone", function () {
      const { address, extra } = pendingImplementationRecord(entry, {
        implementation: "0x1111111111111111111111111111111111111111",
        block: 11700000,
      });

      expect(address).to.equal(entry.address);
      expect(extra.deployTx).to.equal(entry.deployTx);
      expect(extra.block).to.equal(entry.block);
      expect(extra.owner).to.equal(entry.owner);
      // The live implementation is NOT moved: the proxy still runs it until the timelock has
      // executed.
      expect(extra.implementation).to.equal(entry.implementation);
      expect(extra.pendingImplementation).to.equal("0x1111111111111111111111111111111111111111");
      expect(extra.pendingImplementationBlock).to.equal(11700000);

      // What `recordDeployment` writes is `{address, ...extra}` — the entry plus two keys,
      // and nothing removed.
      expect(Object.keys({ address, ...extra })).to.deep.equal([
        ...Object.keys(entry),
        "pendingImplementation",
        "pendingImplementationBlock",
      ]);
      // The caller's entry is never mutated.
      expect(entry).to.not.have.property("pendingImplementation");
    });

    it("overwrites a pending implementation in place on a second run", function () {
      const first = pendingImplementationRecord(entry, {
        implementation: "0x1111111111111111111111111111111111111111",
        block: 11700000,
      });
      const second = pendingImplementationRecord(
        { address: first.address, ...first.extra },
        { implementation: "0x2222222222222222222222222222222222222222", block: 11700100 }
      );

      expect(second.extra.pendingImplementation).to.equal(
        "0x2222222222222222222222222222222222222222"
      );
      expect(second.extra.pendingImplementationBlock).to.equal(11700100);
      expect(Object.keys({ address: second.address, ...second.extra })).to.deep.equal(
        Object.keys({ address: first.address, ...first.extra })
      );
    });
  });
});
