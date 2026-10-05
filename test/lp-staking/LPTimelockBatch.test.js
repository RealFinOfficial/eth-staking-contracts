const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const lpTimelock = require("../../scripts/lp-timelock");
const { UUPS_UNSAFE_ALLOW } = require("../../scripts/deploy-implementation");

/**
 * The BATCH half of `scripts/lp-timelock.js`, run against a real `LPTimelock` this suite
 * deploys itself.
 *
 * A batch exists for one reason, and this suite is built around it: activating the ApeBond
 * route on a LIVE vault proxy is `upgradeToAndCall(newImplementation, 0x)` followed by
 * `setStakeOperator(adapter, true)`, and the second call DOES NOT EXIST on the implementation
 * the proxy runs before the first one. As two separate timelock operations the second would
 * be scheduled against code without that function and would revert after the whole delay. As
 * one batch the timelock runs both in order, in one transaction, all or nothing.
 *
 * What is measured here:
 *
 *   - the id `buildBatch` computes off-chain is the id the deployed contract computes, so an
 *     operator can quote it before any transaction exists and a third party can recompute it;
 *   - the derived salt is the documented one, is stable across calls, and moves when the tag,
 *     a payload, a target or the ORDER of the calls moves;
 *   - an empty batch, a function outside `OWNER_TIER` and a function aimed at the wrong kind
 *     are refused by the builder rather than after the delay;
 *   - the full round trip on a real timelock: schedule, premature execute reverts, execute
 *     after `minDelay` and BOTH calls took effect;
 *   - the calldata `encodeScheduleBatch` / `encodeExecuteBatch` hand a Safe decodes back to
 *     the same arguments, and really drives the timelock when sent as raw calldata.
 *
 * `LPStakingVaultV2Mock` is the "next revision" here, the same mock the upgrade tests in
 * LPStakingVault.test.js and DeployImplementation.test.js use: one Solidity source cannot be
 * compiled at two revisions in one run, so a genuinely different implementation has to be a
 * different contract. It declares a `reinitializer(2)` and no `initializer` of its own, which
 * is what `missing-initializer` allows.
 */
describe("lp-timelock.js — batches", function () {
  let deployer, multisig, guardian, operatorSafe, adapter, other;
  let timelock, timelockAddr;
  let vault, vaultAddr, v2Implementation, v1Implementation;
  let pool, poolAddr, nfpm, nfpmAddr, router, routerAddr;
  let token0Addr, token1Addr;

  const FEE = 3000;
  const TWAP_WINDOW = 600;
  const MAX_DEVIATION_TICKS = 500;
  const MIN_DELAY = 60n;

  /// The V2 mock upgrades an ALREADY-initialized proxy, so it declares no `initializer`.
  const V2_UNSAFE_ALLOW = [...UUPS_UNSAFE_ALLOW, "missing-initializer"];

  /// The batch this whole file is about: upgrade the vault, then allowlist the adapter on the
  /// implementation that upgrade just installed.
  function activationBatch(tag = "") {
    return lpTimelock.buildBatch(
      [
        { target: vaultAddr, fn: "upgradeToAndCall", args: [v2Implementation, "0x"] },
        { target: vaultAddr, fn: "setStakeOperator", args: [adapter.address, "true"] },
      ],
      tag
    );
  }

  const send = (name, batch, ...tail) =>
    timelock
      .connect(multisig)
      [name](batch.targets, batch.values, batch.payloads, batch.predecessor, batch.salt, ...tail);

  beforeEach(async function () {
    [deployer, multisig, guardian, operatorSafe, adapter, other] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockERC20Decimals");
    const usdc = await Token.deploy("USD Coin", "USDC", 1_000_000n * 10n ** 6n, 6);
    const asset = await Token.deploy("Asset", "ASSET", 1_000_000n * 10n ** 18n, 18);

    // Uniswap sorts the pair ascending by address; the vault only ever sees the sorted pair.
    const sorted =
      (await usdc.getAddress()).toLowerCase() < (await asset.getAddress()).toLowerCase()
        ? [usdc, asset]
        : [asset, usdc];
    token0Addr = await sorted[0].getAddress();
    token1Addr = await sorted[1].getAddress();

    const Pool = await ethers.getContractFactory("MockUniswapV3Pool");
    pool = await Pool.deploy(token0Addr, token1Addr, FEE);
    poolAddr = await pool.getAddress();

    const Nfpm = await ethers.getContractFactory("MockPositionManager");
    nfpm = await Nfpm.deploy();
    nfpmAddr = await nfpm.getAddress();

    const Router = await ethers.getContractFactory("MockSwapRouter");
    router = await Router.deploy();
    routerAddr = await router.getAddress();

    // The multisig is the timelock's only proposer, executor and canceller, and the timelock
    // is its own admin — the production shape deploy-lp-staking.js deploys.
    const Timelock = await ethers.getContractFactory("LPTimelock");
    timelock = await Timelock.deploy(
      MIN_DELAY,
      [multisig.address],
      [multisig.address],
      ethers.ZeroAddress
    );
    timelockAddr = await timelock.getAddress();

    const constructorArgs = [nfpmAddr, poolAddr, token0Addr, token1Addr, FEE, routerAddr];
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
      { kind: "uups", constructorArgs, unsafeAllow: UUPS_UNSAFE_ALLOW }
    );
    vaultAddr = await vault.getAddress();
    v1Implementation = await upgrades.erc1967.getImplementationAddress(vaultAddr);

    const VaultV2 = await ethers.getContractFactory("LPStakingVaultV2Mock");
    v2Implementation = await upgrades.deployImplementation(VaultV2, {
      kind: "uups",
      constructorArgs,
      unsafeAllow: V2_UNSAFE_ALLOW,
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("the id and the call tuple", function () {
    it("computes the id the deployed timelock computes", async function () {
      const batch = activationBatch();

      expect(batch.id).to.equal(
        await timelock.hashOperationBatch(
          batch.targets,
          batch.values,
          batch.payloads,
          batch.predecessor,
          batch.salt
        )
      );
      expect(batch.id).to.match(/^0x[0-9a-f]{64}$/);
    });

    it("encodes each call exactly as a single operation would", async function () {
      const batch = activationBatch();

      expect(batch.targets).to.deep.equal([vaultAddr, vaultAddr]);
      expect(batch.values).to.deep.equal([0n, 0n]);
      expect(batch.predecessor).to.equal(ethers.ZeroHash);
      expect(batch.payloads).to.deep.equal([
        vault.interface.encodeFunctionData("upgradeToAndCall", [v2Implementation, "0x"]),
        vault.interface.encodeFunctionData("setStakeOperator", [adapter.address, true]),
      ]);

      // Byte for byte what `buildOperation` produces from the same operands — the batch
      // changes how the calls are grouped, never what they say.
      expect(batch.payloads[1]).to.equal(
        lpTimelock.buildOperation({
          target: vaultAddr,
          fn: "setStakeOperator",
          args: [adapter.address, "true"],
        }).data
      );
    });

    it("keeps a one-call batch distinct from the same call scheduled alone", function () {
      const args = [adapter.address, "true"];
      const batch = lpTimelock.buildBatch([
        { target: vaultAddr, fn: "setStakeOperator", args },
      ]);
      const single = lpTimelock.buildOperation({
        target: vaultAddr,
        fn: "setStakeOperator",
        args,
      });

      // Same calldata, different salt namespace, therefore different ids: scheduling one
      // never blocks the other, and `status` on one can never answer for the other.
      expect(batch.payloads[0]).to.equal(single.data);
      expect(batch.salt).to.not.equal(single.salt);
      expect(batch.id).to.not.equal(single.id);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("the derived salt", function () {
    const coder = ethers.AbiCoder.defaultAbiCoder();

    /// The convention written at the top of scripts/lp-timelock.js, recomputed here from
    /// nothing but the documented formula, so the file's own helper cannot quietly redefine it.
    function documentedSalt(targets, payloads, tag) {
      const calls = ethers.keccak256(coder.encode(["address[]", "bytes[]"], [targets, payloads]));
      return ethers.keccak256(
        coder.encode(["string", "bytes32", "string"], ["real.lp.timelock.v1.batch", calls, tag])
      );
    }

    it("is the documented hash of the targets, the payloads and the tag", function () {
      for (const tag of ["", "retry-2"]) {
        const batch = activationBatch(tag);
        expect(batch.salt).to.equal(documentedSalt(batch.targets, batch.payloads, tag));
        expect(batch.tag).to.equal(tag);
      }
    });

    it("is stable across calls with the same operands", function () {
      const first = activationBatch();
      const second = activationBatch();

      expect(second.salt).to.equal(first.salt);
      expect(second.id).to.equal(first.id);
    });

    it("moves with the tag", function () {
      const untagged = activationBatch();
      const tagged = activationBatch("second-attempt");

      expect(tagged.salt).to.not.equal(untagged.salt);
      expect(tagged.id).to.not.equal(untagged.id);
      // The calls themselves are untouched — only the salt distinguishes the two.
      expect(tagged.payloads).to.deep.equal(untagged.payloads);
    });

    it("moves with any payload, any target and the order of the calls", function () {
      const base = activationBatch();

      // One argument of one call.
      const otherOperator = lpTimelock.buildBatch([
        { target: vaultAddr, fn: "upgradeToAndCall", args: [v2Implementation, "0x"] },
        { target: vaultAddr, fn: "setStakeOperator", args: [other.address, "true"] },
      ]);
      expect(otherOperator.salt).to.not.equal(base.salt);
      expect(otherOperator.id).to.not.equal(base.id);

      // One boolean of one call: allow, not remove.
      const removing = lpTimelock.buildBatch([
        { target: vaultAddr, fn: "upgradeToAndCall", args: [v2Implementation, "0x"] },
        { target: vaultAddr, fn: "setStakeOperator", args: [adapter.address, "false"] },
      ]);
      expect(removing.salt).to.not.equal(base.salt);

      // One target.
      const elsewhere = lpTimelock.buildBatch([
        { target: vaultAddr, fn: "upgradeToAndCall", args: [v2Implementation, "0x"] },
        { target: other.address, fn: "setStakeOperator", args: [adapter.address, "true"] },
      ]);
      expect(elsewhere.salt).to.not.equal(base.salt);

      // And the order, which for a batch is part of what the operation MEANS.
      const reversed = lpTimelock.buildBatch([
        { target: vaultAddr, fn: "setStakeOperator", args: [adapter.address, "true"] },
        { target: vaultAddr, fn: "upgradeToAndCall", args: [v2Implementation, "0x"] },
      ]);
      expect(reversed.salt).to.not.equal(base.salt);
      expect(reversed.id).to.not.equal(base.id);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("refusals", function () {
    it("refuses a batch with no calls", function () {
      expect(() => lpTimelock.buildBatch([])).to.throw(/A batch needs at least one call/);
      expect(() => lpTimelock.buildBatch()).to.throw(/A batch needs at least one call/);
      expect(() => lpTimelock.buildBatch({ target: vaultAddr })).to.throw(
        /A batch needs at least one call/
      );
    });

    it("refuses a function that is not owner-tier", function () {
      // `setTwapParams` left OWNER_TIER on 2026-09-09 — it is operator-tier and undelayed, so
      // scheduling it would revert OwnableUnauthorizedAccount after the full delay.
      expect(() =>
        lpTimelock.buildBatch([{ target: vaultAddr, fn: "setTwapParams", args: ["600", "500"] }])
      ).to.throw(/Batch call 0: setTwapParams is not an owner-tier function/);

      expect(() => lpTimelock.buildBatch([{ target: vaultAddr, args: [] }])).to.throw(
        /Batch call 0: \(no fn\) is not an owner-tier function/
      );
    });

    it("refuses a function aimed at the wrong kind", function () {
      expect(() =>
        lpTimelock.buildBatch([
          {
            target: vaultAddr,
            kind: "RewardsDistributor",
            fn: "setZapper",
            args: [other.address],
          },
        ])
      ).to.throw(/setZapper is not a function of RewardsDistributor — it is legal on LPStakingVault/);

      // And through the CLI's own entry resolver, where the kind arrives as the target name.
      const registry = { registryAddress: () => vaultAddr };
      expect(() =>
        lpTimelock.resolveBatchEntry(registry, 31337, { target: "BonusEscrow", fn: "setZapper" }, 1)
      ).to.throw(/Batch call 1: setZapper is not a function of BonusEscrow/);
    });

    it("refuses a malformed entry", function () {
      expect(() => lpTimelock.buildBatch([{ target: "LPStakingVault", fn: "setZapper" }])).to.throw(
        /Batch call 0: target must be an address/
      );
      expect(() => lpTimelock.buildBatch(["setZapper"])).to.throw(/must be an object/);
      expect(() =>
        lpTimelock.buildBatch([{ target: vaultAddr, fn: "setStakeOperator", args: [other.address] }])
      ).to.throw(/setStakeOperator takes 2 argument\(s\)/);
    });

    it("names the override when the registry has no entry for a kind", function () {
      const empty = { registryAddress: () => undefined };
      expect(() =>
        lpTimelock.resolveBatchEntry(empty, 31337, { target: "LPStakingVault", fn: "setZapper" }, 0)
      ).to.throw(/no LPStakingVault recorded for chain 31337 .*put a raw address/s);

      // A raw address needs no registry at all, and comes back checksummed.
      expect(
        lpTimelock.resolveBatchEntry(
          empty,
          31337,
          { target: vaultAddr.toLowerCase(), fn: "setZapper", args: [other.address] },
          0
        )
      ).to.deep.equal({ target: vaultAddr, fn: "setZapper", args: [other.address] });
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("the round trip on a real timelock", function () {
    it("schedules, refuses an early execute, then runs both calls in order", async function () {
      const batch = activationBatch();

      // Nothing is true yet: the proxy runs V1, which has no allowlist entry for the adapter.
      expect(await upgrades.erc1967.getImplementationAddress(vaultAddr)).to.equal(v1Implementation);
      expect(await vault.isStakeOperator(adapter.address)).to.equal(false);

      // One operation, two `CallScheduled` logs under the same id, indexed in call order.
      await expect(send("scheduleBatch", batch, MIN_DELAY))
        .to.emit(timelock, "CallScheduled")
        .withArgs(batch.id, 0, vaultAddr, 0, batch.payloads[0], batch.predecessor, MIN_DELAY)
        .and.to.emit(timelock, "CallScheduled")
        .withArgs(batch.id, 1, vaultAddr, 0, batch.payloads[1], batch.predecessor, MIN_DELAY);

      expect(await timelock.isOperationPending(batch.id)).to.equal(true);
      expect(await timelock.isOperationReady(batch.id)).to.equal(false);

      // Before the delay the timelock refuses the whole operation, so neither call runs.
      await expect(send("executeBatch", batch)).to.be.revertedWithCustomError(
        timelock,
        "TimelockUnexpectedOperationState"
      );
      expect(await upgrades.erc1967.getImplementationAddress(vaultAddr)).to.equal(v1Implementation);
      expect(await vault.isStakeOperator(adapter.address)).to.equal(false);

      await time.increase(Number(MIN_DELAY) + 1);
      expect(await timelock.isOperationReady(batch.id)).to.equal(true);

      await expect(send("executeBatch", batch))
        .to.emit(vault, "Upgraded")
        .withArgs(v2Implementation)
        .and.to.emit(vault, "StakeOperatorSet")
        .withArgs(adapter.address, true)
        .and.to.emit(timelock, "CallExecuted")
        .withArgs(batch.id, 0, vaultAddr, 0, batch.payloads[0])
        .and.to.emit(timelock, "CallExecuted")
        .withArgs(batch.id, 1, vaultAddr, 0, batch.payloads[1]);

      // Both halves landed, in one transaction: the proxy runs the new code AND the new code
      // is the code that recorded the allowlist entry.
      expect(await upgrades.erc1967.getImplementationAddress(vaultAddr)).to.equal(v2Implementation);
      const upgraded = await ethers.getContractAt("LPStakingVaultV2Mock", vaultAddr);
      expect(await upgraded.version()).to.equal(2n);
      expect(await upgraded.isStakeOperator(adapter.address)).to.equal(true);

      // The admin tiers are untouched by either call.
      expect(await upgraded.owner()).to.equal(timelockAddr);
      expect(await upgraded.guardian()).to.equal(guardian.address);
      expect(await upgraded.operator()).to.equal(operatorSafe.address);

      expect(await timelock.isOperationDone(batch.id)).to.equal(true);
    });

    it("reverts the whole operation when one call in it reverts", async function () {
      // `setStakeOperator(address(0), true)` reverts `ZeroAddress`, so the upgrade in front of
      // it is rolled back with it: a batch is all or nothing.
      const batch = lpTimelock.buildBatch([
        { target: vaultAddr, fn: "upgradeToAndCall", args: [v2Implementation, "0x"] },
        { target: vaultAddr, fn: "setStakeOperator", args: [ethers.ZeroAddress, "true"] },
      ]);

      await send("scheduleBatch", batch, MIN_DELAY);
      await time.increase(Number(MIN_DELAY) + 1);

      await expect(send("executeBatch", batch)).to.be.revertedWithCustomError(
        vault,
        "ZeroAddress"
      );
      expect(await upgrades.erc1967.getImplementationAddress(vaultAddr)).to.equal(v1Implementation);
      expect(await timelock.isOperationDone(batch.id)).to.equal(false);
    });

    it("cancels and reports a batch id through the id-taking actions", async function () {
      const batch = activationBatch();
      await send("scheduleBatch", batch, MIN_DELAY);

      // `status` and `cancel` take an id and never look at the call tuple, so a batch id is
      // just an id to them — which is why neither needs a batch variant.
      expect(await timelock.getTimestamp(batch.id)).to.be.greaterThan(1n);

      const cancelData = lpTimelock.encodeCancel(batch.id);
      await multisig.sendTransaction({ to: timelockAddr, data: cancelData });

      expect(await timelock.getTimestamp(batch.id)).to.equal(0n);
      expect(await timelock.isOperation(batch.id)).to.equal(false);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("the calldata a Safe signs", function () {
    it("decodes back to the arguments it was built from", function () {
      const batch = activationBatch("safe-run");
      const iface = lpTimelock.TIMELOCK_INTERFACE;

      const scheduled = iface.decodeFunctionData(
        "scheduleBatch",
        lpTimelock.encodeScheduleBatch(batch, 172800n)
      );
      expect(scheduled[0].toArray()).to.deep.equal(batch.targets);
      expect(scheduled[1].toArray()).to.deep.equal(batch.values);
      expect(scheduled[2].toArray()).to.deep.equal(batch.payloads);
      expect(scheduled[3]).to.equal(batch.predecessor);
      expect(scheduled[4]).to.equal(batch.salt);
      expect(scheduled[5]).to.equal(172800n);

      const executed = iface.decodeFunctionData(
        "executeBatch",
        lpTimelock.encodeExecuteBatch(batch)
      );
      expect(executed[0].toArray()).to.deep.equal(batch.targets);
      expect(executed[1].toArray()).to.deep.equal(batch.values);
      expect(executed[2].toArray()).to.deep.equal(batch.payloads);
      expect(executed[3]).to.equal(batch.predecessor);
      expect(executed[4]).to.equal(batch.salt);
    });

    it("carries the selectors the deployed timelock answers to", async function () {
      const batch = activationBatch();

      expect(lpTimelock.encodeScheduleBatch(batch, MIN_DELAY).slice(0, 10)).to.equal(
        timelock.interface.getFunction("scheduleBatch").selector
      );
      expect(lpTimelock.encodeExecuteBatch(batch).slice(0, 10)).to.equal(
        timelock.interface.getFunction("executeBatch").selector
      );
    });

    it("drives the timelock when sent as raw calldata", async function () {
      const batch = activationBatch();

      // The whole point of exporting the encoders: what a Safe would sign is what the script
      // sends, so proving one proves the other.
      await multisig.sendTransaction({
        to: timelockAddr,
        data: lpTimelock.encodeScheduleBatch(batch, MIN_DELAY),
      });
      expect(await timelock.isOperationPending(batch.id)).to.equal(true);

      await time.increase(Number(MIN_DELAY) + 1);
      await multisig.sendTransaction({
        to: timelockAddr,
        data: lpTimelock.encodeExecuteBatch(batch),
      });

      expect(await timelock.isOperationDone(batch.id)).to.equal(true);
      expect(await upgrades.erc1967.getImplementationAddress(vaultAddr)).to.equal(v2Implementation);
      expect(await vault.isStakeOperator(adapter.address)).to.equal(true);
    });
  });
});
