// The transition on Avalanche (spec 01 §9), the Hardhat half: the receiver and the migrator's three
// delivery entries in-process, in the token order LP_TOKEN_ORDER names, with every delivery voucher
// signed by ethers' EIP-712 signer (`signTypedData`), i.e. the way the backend signs it, so the
// typed-data definition here and the contract's DELIVERY_VOUCHER_TYPEHASH must agree.
//
// The adversarial depth (every check of the order, fuzzed parts, the invariants, re-entrancy) lives
// in Forge: test/forge/unit/{TransitionReceiver,MigratorDelivery}.t.sol, test/forge/fuzz/TransitionFuzz.t.sol,
// test/forge/invariant/TransitionInvariants.t.sol.

const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { deployWorld, DELIVERY_TYPES } = require("./helpers/transitionWorld");

const P = 20_000n * 10n ** 18n;
const R = 1_000n * 10n ** 6n;
const BOUGHT = 4_000n * 10n ** 18n;
const PINNED_HASH = "0xc9fdfcb43183a49244ffe584d9e69edfb144922f0930ecd33fd099814b33579b";

/** `code` without the compiler's CBOR metadata tail (its length is the last two bytes). */
function stripMetadata(code) {
  const hex = code.startsWith("0x") ? code.slice(2) : code;
  const tail = parseInt(hex.slice(-4), 16);
  return "0x" + hex.slice(0, hex.length - (tail + 2) * 2);
}

describe("Transition (spec 01 §9)", function () {
  let w;

  beforeEach(async function () {
    w = await deployWorld();
  });

  describe("the holding contract and the receiving addresses", function () {
    it("pins HOLDER_INIT_CODE_HASH and it is keccak256 of the creation code literal", async function () {
      expect(await w.receiver.HOLDER_INIT_CODE_HASH()).to.equal(PINNED_HASH);
      expect(ethers.keccak256(await w.receiver.HOLDER_CREATION_CODE())).to.equal(PINNED_HASH);
    });

    it("the literal is the compiled TransitionHolder.sol, metadata aside", async function () {
      const artifact = await hre.artifacts.readArtifact("TransitionHolder");
      expect(stripMetadata(await w.receiver.HOLDER_CREATION_CODE())).to.equal(stripMetadata(artifact.bytecode));
    });

    it("receivingAddressOf is the CREATE2 address of the proxy for (holder, route)", async function () {
      const receiverAddr = await w.receiver.getAddress();
      for (const holder of [w.alice, w.bob, w.carol]) {
        for (const route of [1, 2, 3]) {
          const salt = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint8"], [holder.address, route]));
          expect(await w.receiver.receivingAddressOf(holder.address, route)).to.equal(
            ethers.getCreate2Address(receiverAddr, salt, PINNED_HASH)
          );
        }
      }
      await expect(w.receiver.receivingAddressOf(w.alice.address, 4))
        .to.be.revertedWithCustomError(w.receiver, "InvalidRoute")
        .withArgs(4);
      await expect(w.receiver.receivingAddressOf(ethers.ZeroAddress, 1)).to.be.revertedWithCustomError(
        w.receiver,
        "ZeroAddress"
      );
    });

    it("a placed holder runs the source's runtime and obeys only the receiver", async function () {
      await w.payAsset(w.alice, 3, 10n);
      await w.payUsdc(w.alice, 3, 1n);
      await expect(w.receiver.connect(w.alice).release(w.alice.address, 3)).to.emit(w.receiver, "HolderPlaced");
      const at = await w.at(w.alice, 3);
      const holder = await ethers.getContractAt("TransitionHolder", at);
      await expect(holder.connect(w.stranger).pull(await w.asset.getAddress(), 1))
        .to.be.revertedWithCustomError(holder, "NotReceiver")
        .withArgs(w.stranger.address);
      // The same runtime as TransitionHolder.sol deployed by the same deployer (the immutable aside).
      const artifact = await hre.artifacts.readArtifact("TransitionHolder");
      const placed = await ethers.provider.getCode(at);
      const receiverWord = (await w.receiver.getAddress()).slice(2).toLowerCase().padStart(64, "0");
      const source = stripMetadata(artifact.deployedBytecode).replaceAll("0".repeat(64), receiverWord);
      expect(stripMetadata(placed)).to.equal(source);
    });
  });

  describe("the delivery voucher (EIP-712, signed with signTypedData)", function () {
    it("deliveryVoucherDigest is the typed-data hash of the DeliveryVoucher struct", async function () {
      const v = await w.voucher(w.alice, 3, { principal: P });
      const domain = await w.domain();
      const { signature, ...message } = v;
      expect(
        await w.migrator.deliveryVoucherDigest(
          message.holder,
          message.route,
          message.eligiblePrincipal,
          message.eligibleReward,
          message.assetLimit,
          message.usdcLimit,
          message.burnTime,
          message.nonce,
          message.deadline
        )
      ).to.equal(ethers.TypedDataEncoder.hash(domain, DELIVERY_TYPES, message));
      expect(await w.migrator.DELIVERY_VOUCHER_TYPEHASH()).to.equal(
        ethers.id(
          "DeliveryVoucher(address holder,uint8 route,uint256 eligiblePrincipal,uint256 eligibleReward,uint256 assetLimit,uint256 usdcLimit,uint256 burnTime,uint256 nonce,uint256 deadline)"
        )
      );
    });

    it("a voucher is spent once and only in sequence", async function () {
      await w.payAsset(w.alice, 3, 2n * P);
      const first = await w.voucher(w.alice, 3, { principal: 2n * P, assetLimit: P });
      await w.deliver(w.alice, 3, first);
      const replay = { ...first, assetLimit: 2n * P };
      const resigned = await w.voucher(w.alice, 3, { principal: 2n * P, assetLimit: 2n * P, nonce: 0n });
      await expect(w.deliver(w.alice, 3, resigned))
        .to.be.revertedWithCustomError(w.migrator, "DeliveryNonceMismatch")
        .withArgs(w.alice.address, 1, 0);
      await expect(w.deliver(w.alice, 3, replay)).to.be.revertedWithCustomError(w.migrator, "DeliveryNonceMismatch");
      const second = await w.voucher(w.alice, 3, { principal: 2n * P });
      await w.deliver(w.alice, 3, second);
      expect((await w.migrator.deliveryOf(w.alice.address)).nextNonce).to.equal(2n);
    });

    it("refuses limits above the eligible amounts, another key and another chain", async function () {
      await w.payAsset(w.alice, 3, P);
      const above = await w.voucher(w.alice, 3, { principal: P, assetLimit: P + 1n });
      await expect(w.deliver(w.alice, 3, above))
        .to.be.revertedWithCustomError(w.migrator, "InvalidDeliveryLimits")
        .withArgs(P + 1n, P, 0, 0);
      const forged = await w.voucher(w.alice, 3, { principal: P, by: w.deliverer });
      await expect(w.deliver(w.alice, 3, forged)).to.be.revertedWithCustomError(w.migrator, "InvalidVoucherSignature");
      const domain = { ...(await w.domain()), chainId: 43113n };
      const message = { ...(await w.voucher(w.alice, 3, { principal: P })) };
      delete message.signature;
      const otherChain = { ...message, signature: await w.signer.signTypedData(domain, DELIVERY_TYPES, message) };
      await expect(w.deliver(w.alice, 3, otherChain)).to.be.revertedWithCustomError(w.migrator, "InvalidVoucherSignature");
    });
  });

  describe("the three routes", function () {
    it("route 1: the USDC is swapped under the 3 % floor and everything is staked for the holder", async function () {
      await w.payAsset(w.alice, 1, P);
      await w.payUsdc(w.alice, 1, R);
      const v = await w.voucher(w.alice, 1, { principal: P, reward: R });
      const valued = await w.migrator.usdcInAsset(R);
      const bonus = ((P + (BOUGHT < valued ? BOUGHT : valued)) * 1000n) / 10_000n;
      await expect(w.deliver(w.alice, 1, v))
        .to.emit(w.migrator, "TransitionDelivered")
        .withArgs(w.alice.address, 1, 0, v.burnTime, P, R, BOUGHT, P + BOUGHT, 0, 0, bonus);
      expect(await w.poolV3.stakes(w.alice.address)).to.equal(P + BOUGHT);
      expect(await w.router.lastAmountOutMinimum()).to.equal((valued * 9700n) / 10_000n);
      expect(await w.asset.allowance(await w.receiver.getAddress(), await w.migrator.getAddress())).to.equal(0n);
      expect(await w.usdc.allowance(await w.receiver.getAddress(), await w.migrator.getAddress())).to.equal(0n);
    });

    it("route 2: one position only once the matching $ASSET is there, then top-ups into Testnet Staking", async function () {
      await w.payUsdc(w.alice, 2, R);
      await w.payAsset(w.alice, 2, 1_000n * 10n ** 18n);
      const v = await w.voucher(w.alice, 2, { principal: P, reward: R });
      await expect(w.deliver(w.alice, 2, v)).to.be.revertedWithCustomError(w.migrator, "MatchingAssetNotArrived");
      await w.payAsset(w.alice, 2, 9_000n * 10n ** 18n);
      const tx = await w.deliver(w.alice, 2, v);
      const record = await w.migrator.deliveryOf(w.alice.address);
      expect(record.lpCreated).to.equal(true);
      expect(await w.vault.stakerOf(record.lpTokenId)).to.equal(w.alice.address);
      await expect(tx).to.emit(w.receiver, "Delivered");
      await w.payAsset(w.alice, 2, 500n * 10n ** 18n);
      await w.payUsdc(w.alice, 2, 7n);
      const staked0 = await w.poolV3.stakes(w.alice.address);
      await w.deliver(w.alice, 2, await w.voucher(w.alice, 2, { principal: P, reward: R + 7n }));
      expect(await w.poolV3.stakes(w.alice.address)).to.equal(staked0 + 500n * 10n ** 18n);
      expect(await w.usdc.balanceOf(await w.at(w.alice, 2))).to.equal(7n, "later USDC waits for release");
      expect(await w.bonusVault.lpTokensOf(w.alice.address)).to.have.length(1);
    });

    it("route 3: three parts as one delivery and two top-ups stake the sum, each with 5 %", async function () {
      for (const part of [9_000n, 6_000n, 5_000n]) {
        await w.payAsset(w.alice, 3, part * 10n ** 18n);
        await w.deliver(w.alice, 3, await w.voucher(w.alice, 3, { principal: P }));
      }
      expect(await w.poolV3.stakes(w.alice.address)).to.equal(P);
      expect((await w.bonusVault.reservedOf(w.alice.address)).amount).to.equal((P * 500n) / 10_000n);
    });

    it("the bonus follows the burn time: before the cutoff full, at it nothing", async function () {
      const cutoff = await w.poolV3.bonusCutoff();
      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(cutoff + 86400n)]);
      await ethers.provider.send("evm_mine", []);
      await w.payAsset(w.alice, 3, P);
      await w.deliver(w.alice, 3, await w.voucher(w.alice, 3, { principal: P, burnTime: cutoff - 1n }));
      expect((await w.bonusVault.reservedOf(w.alice.address)).amount).to.equal((P * 500n) / 10_000n);
      await w.payAsset(w.bob, 3, P);
      await w.deliver(w.bob, 3, await w.voucher(w.bob, 3, { principal: P, burnTime: cutoff }));
      expect((await w.bonusVault.reservedOf(w.bob.address)).amount).to.equal(0n);
    });
  });

  describe("roles and the two ways out", function () {
    it("only the receiver calls the delivery entries; only the deliverer or the holder calls deliver", async function () {
      const v = await w.voucher(w.alice, 3, { principal: P });
      for (const s of [w.owner, w.signer, w.alice, w.deliverer]) {
        await expect(w.migrator.connect(s).claimRestakeFor(w.alice.address, P, w.limits(), v))
          .to.be.revertedWithCustomError(w.migrator, "NotTransitionReceiver")
          .withArgs(s.address, await w.receiver.getAddress());
      }
      await w.payAsset(w.alice, 3, P);
      for (const s of [w.owner, w.signer, w.stranger]) {
        await expect(w.deliver(w.alice, 3, v, w.limits(), s))
          .to.be.revertedWithCustomError(w.receiver, "NotDelivererOrHolder")
          .withArgs(s.address, w.deliverer.address, w.alice.address);
      }
      await w.deliver(w.alice, 3, v, w.limits(), w.alice);
      expect(await w.poolV3.stakes(w.alice.address)).to.equal(P);
    });

    it("release pays the holder only, by the holder or the operator, also after the end", async function () {
      await w.payAsset(w.alice, 1, P);
      await w.payUsdc(w.alice, 1, R);
      await expect(w.receiver.connect(w.deliverer).release(w.alice.address, 1))
        .to.be.revertedWithCustomError(w.receiver, "NotHolderOrOperator")
        .withArgs(w.deliverer.address, w.alice.address, w.owner.address);
      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(w.v3End + 10n)]);
      await ethers.provider.send("evm_mine", []);
      const before = await w.asset.balanceOf(w.alice.address);
      await w.receiver.connect(w.owner).release(w.alice.address, 1); // the operator
      expect(await w.asset.balanceOf(w.alice.address)).to.equal(before + P);
      expect(await w.usdc.balanceOf(await w.at(w.alice, 1))).to.equal(0n);
    });

    it("setDeliverer and setSwapLimitBps are the operator's, setTransitionReceiver the owner's", async function () {
      await expect(w.receiver.connect(w.stranger).setDeliverer(w.stranger.address))
        .to.be.revertedWithCustomError(w.receiver, "NotOperator")
        .withArgs(w.stranger.address, w.owner.address);
      await expect(w.migrator.connect(w.stranger).setSwapLimitBps(500))
        .to.be.revertedWithCustomError(w.migrator, "NotOperator")
        .withArgs(w.stranger.address, w.owner.address);
      await expect(w.migrator.connect(w.owner).setSwapLimitBps(1001))
        .to.be.revertedWithCustomError(w.migrator, "InvalidSwapLimit")
        .withArgs(1001, 1000);
      await expect(w.migrator.connect(w.stranger).setTransitionReceiver(w.stranger.address)).to.be.revertedWithCustomError(
        w.migrator,
        "OwnableUnauthorizedAccount"
      );
      await expect(w.migrator.initializeTransition(w.stranger.address)).to.be.revertedWithCustomError(
        w.migrator,
        "InvalidInitialization"
      );
    });
  });

  describe("upgrades", function () {
    it("the receiver's V2 is a legal successor and keeps every receiving address", async function () {
      const Current = await ethers.getContractFactory("TransitionReceiver");
      const Next = await ethers.getContractFactory("TransitionReceiverV2Mock");
      const unsafeAllow = ["constructor", "state-variable-immutable"];
      const constructorArgs = [await w.migrator.getAddress()];
      await upgrades.validateImplementation(Current, { kind: "uups", unsafeAllow, constructorArgs });
      await upgrades.validateUpgrade(Current, Next, { kind: "uups", unsafeAllow, constructorArgs });

      const before = [];
      for (const h of [w.alice, w.bob]) for (const r of [1, 2, 3]) before.push(await w.at(h, r));
      const v2 = await Next.deploy(await w.migrator.getAddress());
      await w.receiver.upgradeToAndCall(await v2.getAddress(), v2.interface.encodeFunctionData("initializeV2", [7]));
      const after = [];
      for (const h of [w.alice, w.bob]) for (const r of [1, 2, 3]) after.push(await w.at(h, r));
      expect(after).to.deep.equal(before);
      expect(await (await ethers.getContractAt("TransitionReceiverV2Mock", await w.receiver.getAddress())).version()).to.equal(2n);
      expect(await w.receiver.HOLDER_INIT_CODE_HASH()).to.equal(PINNED_HASH);
    });

    it("the split's AST: one delegatecall, to the constructor-set immutable; none in the module", async function () {
      const walk = (node, visit, stack = []) => {
        if (!node || typeof node !== "object") return;
        if (node.nodeType || node.nodeType === undefined) visit(node, stack);
        for (const value of Object.values(node)) {
          if (Array.isArray(value)) value.forEach((v) => walk(v, visit, [...stack, node]));
          else if (value && typeof value === "object") walk(value, visit, [...stack, node]);
        }
      };
      const find = async (source) => {
        const name = source.split("/").pop().replace(".sol", "");
        const info = await hre.artifacts.getBuildInfo(`${source}:${name}`);
        const ast = info.output.sources[source].ast;
        const hits = { delegatecall: [], callcode: [], selfdestruct: [], assignments: [] };
        walk(ast, (n, stack) => {
          if (n.nodeType === "MemberAccess" && ["delegatecall", "callcode"].includes(n.memberName)) {
            hits[n.memberName].push(n);
          }
          if (n.nodeType === "YulFunctionCall" && ["delegatecall", "callcode", "selfdestruct"].includes(n.functionName.name)) {
            hits[n.functionName.name].push(n);
          }
          if (n.nodeType === "Identifier" && n.name === "selfdestruct") hits.selfdestruct.push(n);
          if (n.nodeType === "Assignment" && n.leftHandSide.name === "deliveryModule") {
            hits.assignments.push(stack.filter((s) => s.nodeType === "FunctionDefinition").pop());
          }
        });
        return { ast, hits };
      };
      for (const source of ["contracts/staking-v3/StakingMigratorDeliveries.sol", "contracts/staking-v3/StakingMigratorBase.sol"]) {
        const { hits } = await find(source);
        expect(hits.delegatecall, source).to.have.length(0);
        expect(hits.callcode, source).to.have.length(0);
        expect(hits.selfdestruct, source).to.have.length(0);
      }
      const { ast, hits } = await find("contracts/staking-v3/StakingMigrator.sol");
      expect(hits.callcode).to.have.length(0);
      expect(hits.selfdestruct).to.have.length(0);
      expect(hits.delegatecall).to.have.length(1);
      expect(hits.delegatecall[0].expression.nodeType).to.equal("Identifier");
      expect(hits.delegatecall[0].expression.name).to.equal("deliveryModule");
      let declaration;
      walk(ast, (n) => {
        if (n.nodeType === "VariableDeclaration" && n.name === "deliveryModule" && n.stateVariable) declaration = n;
      });
      expect(declaration.mutability).to.equal("immutable");
      expect(hits.assignments).to.have.length(1);
      expect(hits.assignments[0].kind).to.equal("constructor");
    });

    it("the migrator fits EIP-170 and so does its delivery module", async function () {
      for (const name of ["StakingMigrator", "StakingMigratorDeliveries", "TransitionReceiver"]) {
        const artifact = await hre.artifacts.readArtifact(name);
        expect((artifact.deployedBytecode.length - 2) / 2).to.be.at.most(24576, name);
        expect((artifact.bytecode.length - 2) / 2).to.be.at.most(49152, `${name} init code (EIP-3860)`);
      }
    });
  });
});
