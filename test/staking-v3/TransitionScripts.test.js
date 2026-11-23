// The transition's scripts, unit-tested in-process (they send nothing to a real network here):
//   - scripts/deploy-bridge-standins.js   refuses chains 1 and 43114; deploys and records each stand-in
//   - scripts/transition-access-file.js   the access signatures the burn stand-in accepts
//   - scripts/lib/transition-rehearsal.js the two-chain commands of scripts/v3-rehearsal.js, end to end
//     on ONE in-process chain: the "Sepolia" side is a burn stand-in over MockRealToken, a mock
//     TokenMessengerV2 and an unstake() source; the "Fuji" side is helpers/transitionWorld.js with the
//     payout stand-in and a mock MessageTransmitterV2.
//   - scripts/lib/stake-rehearsal.js      the targeted fund / sw2-stake / v1-stake of scripts/v3-rehearsal.js,
//     against a local WeightedStakingPool and StakingPool whose staking token is NOT the registry's
//     LPZapper.asset (a decoy token stands in for it); and the original fund / sw2-stake unchanged.

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

  describe("deploy-bridge-standins.js: the record comes first", function () {
    it("records the burn stand-in even when the optional setOpened(true) fails", async function () {
      const [deployer, accessSigner, otherOwner] = await ethers.getSigners();
      const token = await (await ethers.getContractFactory("MockRealToken")).deploy(deployer.address, P);
      const registryFile = path.join(scratch, "deployments.json");
      const s = withRegistry(registryFile, "../../scripts/deploy-bridge-standins");
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      // The stand-in is owned by another account, so the deployer's setOpened(true) reverts.
      const config = s.readConfig(
        31337,
        {
          STANDIN: "burn",
          STANDIN_TOKEN: await token.getAddress(),
          STANDIN_OWNER: otherOwner.address,
          STANDIN_ACCESS_SIGNER: accessSigner.address,
          STANDIN_CLOSE_AT: String(now + 86400),
          STANDIN_OPEN: "yes",
        },
        deployer.address
      );
      await expect(s.deployStandIn({ config, deployer })).to.be.rejected;
      const recorded = JSON.parse(fs.readFileSync(registryFile, "utf8"))["31337"];
      expect(recorded.BurnStandIn.address).to.match(/^0x[0-9a-fA-F]{40}$/);
      expect(recorded.BurnStandIn.owner).to.equal(otherOwner.address);
      const burn = await ethers.getContractAt("BurnStandIn", recorded.BurnStandIn.address);
      expect(await burn.opened()).to.equal(false);
    });
  });

  describe("grow-oracle.js: the target", function () {
    it("refuses a target below window + 1", function () {
      const g = require("../../scripts/grow-oracle");
      expect(() => g.checkTarget(1800, 1800)).to.throw(/LP_ORACLE_TARGET \(1800\) must be at least LP_ORACLE_WINDOW \+ 1 \(1801\)/);
      expect(() => g.checkTarget(300, 300)).to.throw(/at least LP_ORACLE_WINDOW \+ 1 \(301\)/);
      expect(() => g.checkTarget(1801, 1800)).to.not.throw();
      expect(() => g.checkTarget(411, 300)).to.not.throw();
    });
  });

  describe("transition-access-file.js: outside the repository", function () {
    const repo = fs.realpathSync(path.join(__dirname, "..", ".."));

    it("refuses a path inside the repository, also through a symbolic link", function () {
      const access = require("../../scripts/transition-access-file");
      expect(() => access.assertOutsideRepository(path.join(repo, "access.json"))).to.throw(/outside the repository/);
      expect(() => access.assertOutsideRepository(path.join(repo, "abi", "access.json"))).to.throw(/outside the repository/);
      const link = path.join(scratch, "into-repo");
      fs.symlinkSync(repo, link);
      expect(() => access.assertOutsideRepository(path.join(link, "access.json"))).to.throw(/outside the repository/);
    });

    it("accepts a sibling folder whose name only starts like the repository's", function () {
      const access = require("../../scripts/transition-access-file");
      const sibling = `${repo}-access-${process.pid}`;
      fs.mkdirSync(sibling);
      try {
        expect(() => access.assertOutsideRepository(path.join(sibling, "access.json"))).to.not.throw();
        expect(() => access.assertOutsideRepository(path.join(scratch, "access.json"))).to.not.throw();
      } finally {
        fs.rmSync(sibling, { recursive: true, force: true });
      }
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

  describe("the targeted stake commands (v3-rehearsal.js fund, sw2-stake, v1-stake)", function () {
    const TOKENS = (n) => BigInt(n) * 10n ** 18n;
    const DAY = 86400;

    async function stakeWorld() {
      const [deployer] = await ethers.getSigners();
      const [A, B, C] = [0, 1, 2].map(() => ethers.Wallet.createRandom().connect(ethers.provider));
      await deployer.sendTransaction({ to: A.address, value: ethers.parseEther("10") });
      await deployer.sendTransaction({ to: C.address, value: ethers.parseEther("1") });
      const ERC = await ethers.getContractFactory("MockERC20");
      const decoy = await ERC.deploy("registry LPZapper.asset", "tREAL", TOKENS(1_000_000)); // the old test token
      const asset = await ERC.deploy("bridge test asset", "ASSET", TOKENS(1_000_000)); // the contracts' own token
      const usdc = await (await ethers.getContractFactory("MockERC20Decimals")).deploy("USDC", "USDC", 10n ** 12n, 6);
      for (const t of [decoy, asset]) await t.transfer(A.address, TOKENS(100_000));
      await usdc.transfer(A.address, 10n ** 10n);
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      const W = await ethers.getContractFactory("WeightedStakingPool");
      const v2 = await W.deploy(asset.target, usdc.target, now, now + DAY, A.address);
      const v2Decoy = await W.deploy(decoy.target, usdc.target, now, now + DAY, A.address);
      const v1 = await (await ethers.getContractFactory("StakingPool")).deploy(asset.target, usdc.target, now, now + DAY);
      return { A, B, C, decoy, asset, usdc, v2, v2Decoy, v1, wallets: { A, B, C } };
    }

    function rehearsal() {
      return require("../../scripts/v3-rehearsal");
    }

    function run(w, action, env) {
      return rehearsal().runStakeCommand({
        action,
        chainId: 31337,
        wallets: w.wallets,
        env,
        weightKey: w.A.privateKey,
        stateFile: path.join(scratch, "state.json"),
      });
    }

    async function balances(w, token) {
      const out = {};
      for (const [who, s] of Object.entries(w.wallets)) out[who] = await token.balanceOf(s.address);
      return out;
    }

    it("chooses the targeted form only with V3R_STAKING and never ignores the new settings", function () {
      const { isTargeted } = require("../../scripts/lib/stake-rehearsal");
      expect(isTargeted("fund", {})).to.equal(false);
      expect(isTargeted("sw2-stake", {})).to.equal(false);
      expect(isTargeted("fund", { V3R_STAKING: "0x01" })).to.equal(true);
      expect(isTargeted("v1-stake", { V3R_STAKING: "0x01" })).to.equal(true);
      expect(() => isTargeted("v1-stake", {})).to.throw(/needs V3R_STAKING/);
      expect(() => isTargeted("fund", { V3R_WHO: "B" })).to.throw(/V3R_WHO need V3R_STAKING/);
      expect(() => isTargeted("sw2-stake", { V3R_DRY_RUN: "1" })).to.throw(/V3R_DRY_RUN need V3R_STAKING/);
      expect(() => isTargeted("sw2-unstake", { V3R_STAKING: "0x01" })).to.throw(/apply only to/);
    });

    it("fund sends exactly the amount of the contract's own staking token to exactly the chosen wallets", async function () {
      const w = await stakeWorld();
      const decoyBefore = await balances(w, w.decoy);
      const ethB0 = await ethers.provider.getBalance(w.B.address);
      const ethC0 = await ethers.provider.getBalance(w.C.address);

      await run(w, "fund", { V3R_STAKING: w.v2.target, V3R_WHO: "B,C", V3R_AMOUNT: "10000" });

      const after = await balances(w, w.asset);
      expect(after.B).to.equal(TOKENS(10_000));
      expect(after.C).to.equal(TOKENS(10_000));
      expect(after.A).to.equal(TOKENS(80_000));
      expect(await balances(w, w.decoy)).to.deep.equal(decoyBefore, "the registry's token is never touched");
      expect(await w.usdc.balanceOf(w.B.address)).to.equal(0n, "no USDC");
      expect(ethB0).to.equal(0n);
      expect(await ethers.provider.getBalance(w.B.address)).to.be.gt(0n, "B had no ETH, it got its gas");
      expect(await ethers.provider.getBalance(w.C.address)).to.equal(ethC0, "C had enough ETH, none sent");

      // a second run tops up nothing
      await run(w, "fund", { V3R_STAKING: w.v2.target, V3R_WHO: "B,C", V3R_AMOUNT: "10000" });
      expect((await balances(w, w.asset)).A).to.equal(TOKENS(80_000));

      // only the chosen wallet
      const w2 = await stakeWorld();
      await run(w2, "fund", { V3R_STAKING: w2.v1.target, V3R_WHO: "C", V3R_AMOUNT: "250" });
      const only = await balances(w2, w2.asset);
      expect(only.C).to.equal(TOKENS(250));
      expect(only.B).to.equal(0n);
      await expect(run(w2, "fund", { V3R_STAKING: w2.v1.target, V3R_WHO: "A" })).to.be.rejectedWith(/cannot name A/);
    });

    it("sw2-stake stakes exactly the chosen wallets with the weight signature and leaves the others untouched", async function () {
      const w = await stakeWorld();
      await run(w, "fund", { V3R_STAKING: w.v2.target, V3R_WHO: "B,C" });
      const res = await run(w, "sw2-stake", { V3R_STAKING: w.v2.target, V3R_WHO: "A,B", V3R_AMOUNT: "10000" });

      for (const s of [w.A, w.B]) {
        const st = await w.v2.stakes(s.address);
        expect(st.amount).to.equal(TOKENS(10_000));
        expect(st.weight).to.equal(1500n);
        expect(await w.v2.nonces(s.address)).to.equal(1n);
        expect(await w.asset.allowance(s.address, w.v2.target)).to.equal(0n, "exactly the amount was approved");
      }
      expect((await w.v2.stakes(w.C.address)).amount).to.equal(0n);
      expect(await w.asset.balanceOf(w.C.address)).to.equal(TOKENS(10_000), "C untouched");
      expect(await w.v2.totalStaked()).to.equal(TOKENS(20_000));
      expect(res.staked).to.deep.equal({ A: TOKENS(10_000).toString(), B: TOKENS(10_000).toString() });
      expect(await w.decoy.balanceOf(w.A.address)).to.equal(TOKENS(100_000));

      // a re-run skips the wallets that already staked
      await run(w, "sw2-stake", { V3R_STAKING: w.v2.target, V3R_WHO: "A,B" });
      expect(await w.v2.totalStaked()).to.equal(TOKENS(20_000));
      // the wrong contract type is refused
      await expect(run(w, "sw2-stake", { V3R_STAKING: w.v1.target, V3R_WHO: "B" })).to.be.rejectedWith(/needs a WeightedStakingPool/);
    });

    it("v1-stake stakes into the v1-type StakingPool from the chosen wallet, and refuses a closed window", async function () {
      const w = await stakeWorld();
      await run(w, "fund", { V3R_STAKING: w.v1.target, V3R_WHO: "C" });
      await run(w, "v1-stake", { V3R_STAKING: w.v1.target, V3R_WHO: "C", V3R_AMOUNT: "10000" });

      expect((await w.v1.stakes(w.C.address)).amount).to.equal(TOKENS(10_000));
      expect((await w.v1.stakes(w.A.address)).amount).to.equal(0n);
      expect((await w.v1.stakes(w.B.address)).amount).to.equal(0n);
      expect(await w.v1.totalStaked()).to.equal(TOKENS(10_000));
      expect(await w.asset.balanceOf(w.C.address)).to.equal(0n);

      await expect(run(w, "v1-stake", { V3R_STAKING: w.v2.target, V3R_WHO: "C" })).to.be.rejectedWith(/needs a StakingPool/);
      await expect(run(w, "v1-stake", { V3R_STAKING: w.v1.target })).to.be.rejectedWith(/needs V3R_WHO/);
      await expect(run(w, "v1-stake", { V3R_STAKING: w.v1.target, V3R_WHO: "B" })).to.be.rejectedWith(/B holds 0.0 ASSET/);
      await ethers.provider.send("evm_increaseTime", [DAY + 1]);
      await ethers.provider.send("evm_mine", []);
      await expect(run(w, "v1-stake", { V3R_STAKING: w.v1.target, V3R_WHO: "B" })).to.be.rejectedWith(/window closed/);
    });

    it("a dry run prints who, to which contract, which token and how much, and sends nothing", async function () {
      const w = await stakeWorld();
      const nonceA = await ethers.provider.getTransactionCount(w.A.address);
      const f = await run(w, "fund", { V3R_STAKING: w.v2.target, V3R_WHO: "B,C", V3R_DRY_RUN: "1" });
      const transfers = f.planned.filter((p) => p.what.startsWith("transfer"));
      expect(transfers.map((p) => [p.who, p.to, p.token, p.amount])).to.deep.equal([
        ["A", w.asset.target, w.asset.target, TOKENS(10_000).toString()],
        ["A", w.asset.target, w.asset.target, TOKENS(10_000).toString()],
      ]);
      expect(f.planned.filter((p) => p.what === "ETH to B")).to.have.length(1);
      expect(f.planned.filter((p) => p.what === "ETH to C")).to.have.length(0);

      const s = await run(w, "sw2-stake", { V3R_STAKING: w.v2.target, V3R_WHO: "A,B", V3R_DRY_RUN: "yes" });
      expect(s.planned.filter((p) => p.what.startsWith("stake")).map((p) => [p.who, p.to, p.token, p.amount])).to.deep.equal([
        ["A", w.v2.target, w.asset.target, TOKENS(10_000).toString()],
        ["B", w.v2.target, w.asset.target, TOKENS(10_000).toString()],
      ]);
      const v = await run(w, "v1-stake", { V3R_STAKING: w.v1.target, V3R_WHO: "C", V3R_DRY_RUN: "true" });
      expect(v.planned.map((p) => [p.who, p.what, p.to])).to.deep.equal([
        ["C", "approve", w.asset.target],
        ["C", "stake", w.v1.target],
      ]);

      expect(await ethers.provider.getTransactionCount(w.A.address)).to.equal(nonceA, "A sent nothing");
      expect(await ethers.provider.getBalance(w.B.address)).to.equal(0n);
      expect((await balances(w, w.asset)).A).to.equal(TOKENS(100_000));
      expect(await w.v2.totalStaked()).to.equal(0n);
      expect(await w.v1.totalStaked()).to.equal(0n);
      expect(fs.existsSync(path.join(scratch, "state.json"))).to.equal(false, "no state written");
    });

    it("without the new settings, fund and sw2-stake behave as before (registry token, fixed amounts, A B C)", async function () {
      const w = await stakeWorld();
      const stateFile = path.join(scratch, "old.json");
      const ctx = {
        action: "fund",
        chainId: 31337,
        wallets: w.wallets,
        stateFile,
        state: { txs: [] },
        asset: w.decoy,
        usdc: w.usdc,
        sw2: w.v2Decoy,
      };
      const { actions } = rehearsal();
      await actions.fund(ctx);
      expect(await w.decoy.balanceOf(w.B.address)).to.equal(TOKENS(20_000));
      expect(await w.decoy.balanceOf(w.C.address)).to.equal(TOKENS(20_000));
      expect(await w.usdc.balanceOf(w.B.address)).to.equal(2_000n * 10n ** 6n);
      expect(await w.usdc.balanceOf(w.C.address)).to.equal(2_000n * 10n ** 6n);
      expect(await ethers.provider.getBalance(w.B.address)).to.equal(ethers.parseEther("0.05"));
      expect(await w.asset.balanceOf(w.B.address)).to.equal(0n);

      const previous = process.env.PRIVATE_KEY;
      process.env.PRIVATE_KEY = w.A.privateKey;
      try {
        ctx.action = "sw2-stake";
        await actions["sw2-stake"](ctx);
      } finally {
        if (previous === undefined) delete process.env.PRIVATE_KEY;
        else process.env.PRIVATE_KEY = previous;
      }
      for (const s of [w.A, w.B, w.C]) expect((await w.v2Decoy.stakes(s.address)).amount).to.equal(TOKENS(10_000));
      expect(await w.v2.totalStaked()).to.equal(0n);
    });
  });
});
