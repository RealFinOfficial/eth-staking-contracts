// The transition's scripts, unit-tested in-process (they send nothing to a real network here):
//   - scripts/deploy-bridge-standins.js   refuses chains 1 and 43114; deploys and records each stand-in
//   - scripts/transition-access-file.js   the access signatures the burn stand-in accepts
//   - scripts/lib/transition-rehearsal.js the two-chain commands of scripts/v3-rehearsal.js, end to end
//     on ONE in-process chain: the "Sepolia" side is a burn stand-in over MockRealToken, a mock
//     TokenMessengerV2 and an unstake() source; the "Fuji" side is helpers/transitionWorld.js with the
//     payout stand-in and a mock MessageTransmitterV2.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployWorld } = require("./helpers/transitionWorld");

const P = 20_000n * 10n ** 18n;
const R = 1_000n * 10n ** 6n;

function withRegistry(registryFile, modulePath) {
  const modules = ["../../scripts/lib/pools", "../../scripts/lib/proxies", modulePath].map((m) => require.resolve(m));
  const previous = process.env.DEPLOYMENTS_FILE;
  process.env.DEPLOYMENTS_FILE = registryFile;
  try {
    for (const m of modules) delete require.cache[m];
    return require(modulePath);
  } finally {
    if (previous === undefined) delete process.env.DEPLOYMENTS_FILE;
    else process.env.DEPLOYMENTS_FILE = previous;
    for (const m of modules) delete require.cache[m];
  }
}

describe("Transition scripts", function () {
  let scratch;
  beforeEach(function () {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "transition-scripts-"));
  });

  describe("deploy-bridge-standins.js", function () {
    it("refuses Ethereum and Avalanche C-Chain whatever is set", function () {
      const s = require("../../scripts/deploy-bridge-standins");
      for (const chain of [1, 43114]) {
        expect(() => s.refuseMainnet(chain)).to.throw(/never deployed on chain/);
        expect(() =>
          s.readConfig(chain, { STANDIN: "payout", STANDIN_TOKEN: ethers.ZeroAddress.replace(/0$/, "1") }, ethers.ZeroAddress)
        ).to.throw(/never deployed/);
      }
      expect(() => s.refuseMainnet(11155111)).to.not.throw();
      expect(() => s.refuseMainnet(43113)).to.not.throw();
    });

    it("needs the access signer and an explicit closeAt for the burn stand-in", function () {
      const s = require("../../scripts/deploy-bridge-standins");
      const owner = "0x0000000000000000000000000000000000000001";
      expect(() => s.readConfig(11155111, { STANDIN: "nope" }, owner)).to.throw(/burn or payout/);
      expect(() => s.readConfig(11155111, { STANDIN: "burn" }, owner)).to.throw(/STANDIN_ACCESS_SIGNER/);
      expect(() => s.readConfig(11155111, { STANDIN: "burn", STANDIN_ACCESS_SIGNER: owner }, owner)).to.throw(
        /STANDIN_CLOSE_AT/
      );
      const c = s.readConfig(11155111, { STANDIN: "burn", STANDIN_ACCESS_SIGNER: owner, STANDIN_CLOSE_AT: "1800000000" }, owner);
      expect(c.token).to.equal(s.TEST_ASSET[11155111]);
      expect(c.closeAt).to.equal(1800000000);
      expect(s.readConfig(43113, { STANDIN: "payout" }, owner).token).to.equal(s.TEST_ASSET[43113]);
    });

    it("deploys and records both stand-ins on a test chain", async function () {
      const [deployer, accessSigner] = await ethers.getSigners();
      const token = await (await ethers.getContractFactory("MockRealToken")).deploy(deployer.address, P);
      const registryFile = path.join(scratch, "deployments.json");
      const s = withRegistry(registryFile, "../../scripts/deploy-bridge-standins");
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      const burnAddr = await s.deployStandIn({
        config: s.readConfig(
          31337,
          {
            STANDIN: "burn",
            STANDIN_TOKEN: await token.getAddress(),
            STANDIN_ACCESS_SIGNER: accessSigner.address,
            STANDIN_CLOSE_AT: String(now + 86400),
            STANDIN_OPEN: "yes",
          },
          deployer.address
        ),
        deployer,
      });
      const payoutAddr = await s.deployStandIn({
        config: s.readConfig(31337, { STANDIN: "payout", STANDIN_TOKEN: await token.getAddress() }, deployer.address),
        deployer,
      });
      const burn = await ethers.getContractAt("BurnStandIn", burnAddr);
      expect(await burn.opened()).to.equal(true);
      expect(await burn.accessSigner()).to.equal(accessSigner.address);
      const recorded = JSON.parse(fs.readFileSync(registryFile, "utf8"))["31337"];
      expect(recorded.BurnStandIn.address).to.equal(burnAddr);
      expect(recorded.BurnStandIn.closeAt).to.equal(now + 86400);
      expect(recorded.PayoutStandIn.address).to.equal(payoutAddr);
    });
  });

  describe("transition-access-file.js", function () {
    it("writes signatures the burn stand-in accepts for exactly the named wallet", async function () {
      const access = require("../../scripts/transition-access-file");
      const [deployer, alice, bob] = await ethers.getSigners();
      const signerWallet = ethers.Wallet.createRandom();
      const token = await (await ethers.getContractFactory("MockRealToken")).deploy(deployer.address, 10n * P);
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      const burn = await (await ethers.getContractFactory("BurnStandIn")).deploy(
        await token.getAddress(),
        deployer.address,
        signerWallet.address,
        now + 86400
      );
      await burn.setOpened(true);
      await burn.setRequireSignature(true);
      await token.transfer(alice.address, P);
      await token.transfer(bob.address, P);

      const keyFile = path.join(scratch, "access.json");
      fs.writeFileSync(keyFile, JSON.stringify({ privateKey: signerWallet.privateKey }), { mode: 0o600 });
      const walletsFile = path.join(scratch, "wallets.txt");
      fs.writeFileSync(walletsFile, `${alice.address}\n${alice.address.toLowerCase()}\n`);
      const wallets = access.parseWallets(walletsFile);
      expect(wallets).to.deep.equal([alice.address], "de-duplicated and checksummed");
      const wallet = access.readSignerKey({ ACCESS_SIGNER_KEY_FILE: keyFile });
      expect(wallet.address).to.equal(signerWallet.address);

      const deadline = now + 3600;
      const entries = await access.buildAccessFile({
        chainId: 31337,
        standIn: await burn.getAddress(),
        wallet,
        wallets,
        deadline,
      });
      expect(entries).to.deep.equal([{ address: alice.address, deadline, signature: entries[0].signature }]);
      expect(await burn.accessDigest(alice.address, deadline)).to.equal(
        ethers.TypedDataEncoder.hash(access.accessDomain(31337, await burn.getAddress()), access.ACCESS_TYPES, {
          account: alice.address,
          deadline,
        })
      );

      const dest = "0x00000000000000000000000000000000000000d1";
      await token.connect(alice).approve(await burn.getAddress(), P);
      await expect(burn.connect(alice)["migrate(uint256,address,uint256,bytes)"](P, dest, deadline, entries[0].signature)).to.emit(
        burn,
        "Migrated"
      );
      await token.connect(bob).approve(await burn.getAddress(), P);
      await expect(
        burn.connect(bob)["migrate(uint256,address,uint256,bytes)"](P, dest, deadline, entries[0].signature)
      ).to.be.revertedWithCustomError(burn, "InvalidAccessSignature");
    });
  });

  describe("the two-chain rehearsal commands (v3-rehearsal.js tr-…)", function () {
    it("unstake, USDC, burn, Circle mint, a payout in parts, deliver, a top-up, release", async function () {
      const { actions, receivingAddress } = require("../../scripts/lib/transition-rehearsal");
      const w = await deployWorld();
      const [deployer] = await ethers.getSigners();
      const staker = w.bob;

      // "Sepolia": the burned token, the unstake() source, Circle's TokenMessengerV2, the burn stand-in.
      const sepAsset = await (await ethers.getContractFactory("MockRealToken")).deploy(deployer.address, 10n * P);
      const source = await (await ethers.getContractFactory("MockUnstakeSource")).deploy(
        await sepAsset.getAddress(),
        await w.usdc.getAddress(),
        P,
        R
      );
      await sepAsset.transfer(await source.getAddress(), P);
      await w.usdc.transfer(await source.getAddress(), R);
      const messenger = await (await ethers.getContractFactory("MockTokenMessengerV2")).deploy();
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      const burn = await (await ethers.getContractFactory("BurnStandIn")).deploy(
        await sepAsset.getAddress(),
        deployer.address,
        deployer.address,
        now + 30 * 86400
      );
      await burn.setOpened(true);

      // "Fuji": the payout stand-in (owned by A = the migrator's voucher signer) and Circle's transmitter.
      const payout = await (await ethers.getContractFactory("PayoutStandIn")).deploy(await w.asset.getAddress(), w.signer.address);
      await w.asset.transfer(await payout.getAddress(), P);
      const transmitter = await (await ethers.getContractFactory("MockMessageTransmitterV2")).deploy(await w.usdc.getAddress());
      await w.usdc.transfer(await transmitter.getAddress(), R);

      const stateFile = path.join(scratch, "state.json");
      const ctx = {
        chainId: 31337,
        wallets: { A: w.signer, B: staker },
        state: { txs: [] },
        stateFile,
        registry: {},
        env: {},
        send: async (who, label, build) => {
          const tx = await build(ctx.wallets[who], {});
          return tx.wait();
        },
      };
      const run = (action, env) => {
        ctx.env = { TR_WHO: "B", TR_ROUTE: "1", TR_RECEIVER: w.receiver.target, ...env };
        return actions[action](ctx);
      };
      const at = receivingAddress(w.receiver.target, staker.address, 1);
      expect(at).to.equal(await w.receiver.receivingAddressOf(staker.address, 1), "off-chain = on-chain");

      const u = await run("tr-unstake", { TR_STAKING: source.target });
      expect(u.principal).to.equal(P.toString());
      expect(u.reward).to.equal(R.toString());

      await run("tr-usdc", { TR_USDC: w.usdc.target, TR_TOKEN_MESSENGER: messenger.target });
      const dep = await messenger.last();
      expect(dep.amount).to.equal(R);
      expect(dep.destinationDomain).to.equal(1n);
      expect(dep.mintRecipient).to.equal(ethers.zeroPadValue(at, 32));
      expect(dep.burnToken).to.equal(w.usdc.target);
      expect(dep.destinationCaller).to.equal(ethers.ZeroHash);
      expect(dep.maxFee).to.equal(0n);
      expect(dep.minFinalityThreshold).to.equal(2000n);
      expect(dep.sender).to.equal(staker.address);
      expect(await w.usdc.allowance(staker.address, messenger.target)).to.equal(0n, "exactly R was approved");

      const b = await run("tr-burn", { TR_BURN_STANDIN: burn.target });
      expect(b.burn.destination).to.equal(at);
      expect(b.burn.amount).to.equal(P.toString());
      expect(b.burn.seq).to.equal("0");

      const message = ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [at, R]);
      await run("tr-mint-usdc", { TR_MESSAGE: message, TR_ATTESTATION: "0x01", TR_MESSAGE_TRANSMITTER: transmitter.target });
      expect(await w.usdc.balanceOf(at)).to.equal(R);

      await run("tr-pay", { TR_PART: String(P / 2n), TR_PAYOUT_STANDIN: payout.target });
      await run("tr-deliver", {});
      expect(await w.poolV3.stakes(staker.address)).to.equal(P / 2n + 4_000n * 10n ** 18n, "half of P + the bought $ASSET");

      await run("tr-pay", { TR_PART: String(P / 2n), TR_PAYOUT_STANDIN: payout.target });
      const top = await run("tr-deliver", {});
      expect(top.deliveries).to.have.length(2);
      expect(await w.poolV3.stakes(staker.address)).to.equal(P + 4_000n * 10n ** 18n);
      expect(await payout.paidTotal(b.burn.id)).to.equal(P);

      const status = await run("tr-status", {});
      expect(status.delivery.principalDelivered).to.equal(P.toString());
      expect(status.delivery.nextNonce).to.equal("2");

      await w.usdc.transfer(at, 5n); // a stray transfer to the address
      const before = await w.usdc.balanceOf(staker.address);
      await run("tr-release", {});
      expect(await w.usdc.balanceOf(staker.address)).to.equal(before + 5n);

      const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      expect(saved.transition.B.burn.id).to.equal(b.burn.id);
    });
  });
});
