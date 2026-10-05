const fs = require("fs");
const path = require("path");

const { expect } = require("chai");
const ethers = require("ethers");

const chain = require("./helpers/chain");
const runner = require("./helpers/scripts");
const PV = require("./helpers/positionValue");
const { CHAIN_ID, campaignEnv, startWorld } = require("./helpers/apebondWorld");

/**
 * The two operator scripts that follow the ApeBond activation, run as CHILD PROCESSES against a
 * stack this suite deploys with the repo's own scripts (B.3 decision document, 2026-10-05):
 *
 *   scripts/fund-escrow.js        $ASSET into the BonusEscrow proxy — a fixed amount, or up to a
 *                                 TARGET over what is owed. Since reservations need no balance
 *                                 (override O2), the escrow can be SHORT, and TARGET=0 covers
 *                                 exactly what is owed.
 *   scripts/apebond-rehearsal.js  the test-stack rehearsal: deploys a MockSoulZapCaller (phase
 *                                 `caller`), buys through it (`deposit`), shows the buy-and-unstake
 *                                 loop forfeited (`loop`), shows the two-rebalance withdrawal scaled
 *                                 (`withdrawal`), claims after the cliff (`claim`), reports (`status`).
 *
 * There is no purchase signer anywhere: the adapter computes every bonus from the position.
 *
 * ── The order of the story ────────────────────────────────────────────────────────────────
 *
 * The rehearsal's `caller` phase runs BEFORE the route is activated, so `deploy-apebond.js` can
 * allowlist the caller (globally and for the campaign) while the deployer still owns the adapter.
 * Every purchase then lands on an EMPTY escrow: the reservations are recorded anyway, the claims
 * after the cliff revert `InsufficientFunds` and send nothing, and only `fund-escrow.js` with
 * TARGET=0 makes them payable. That is the reserve-now-fund-later flow, end to end.
 *
 * The mock position manager records `liquidity = amount0 + amount1` of what a mint consumed, so a
 * position's VALUE here is the contract formula applied to that number at the pool mock's tick 0.
 * The suite recomputes every bonus and every rebalance scaling with `helpers/positionValue.js` (a
 * BigInt port of the contract math) and asserts the escrow's figures equal it to the wei.
 *
 * The tracked `deployments.json` is never written: every child gets a scratch DEPLOYMENTS_FILE,
 * and the tracked registry's sha256 is captured at load and asserted at the end.
 */

const TRACKED_REGISTRY_SHA256 = runner.sha256File(runner.TRACKED_REGISTRY);

const CLIFF_SECONDS = 600;
const BONUS_BPS = 1000n;
const MIN_BONUS = 10n ** 18n;

describe("the ApeBond operator scripts — funding and the test-stack rehearsal", function () {
  this.timeout(15 * 60 * 1000);

  let world, w, provider;
  let recordFile;
  let vaultAddr, escrowAddr, adapterAddr, callerAddr;
  let vault, escrow, adapter, asset, nfpm;
  let campaignId;
  let activation;

  const readRecord = () => JSON.parse(fs.readFileSync(recordFile, "utf8"));
  const rehearsal = (phase, extra = {}) =>
    world.run("apebond-rehearsal.js", world.baseEnv({ LP_REHEARSAL_PHASE: phase, ...extra }));
  const rehearsalOk = (phase, extra = {}) =>
    world.runOk("apebond-rehearsal.js", world.baseEnv({ LP_REHEARSAL_PHASE: phase, ...extra }));
  const fund = (extra) => world.run("fund-escrow.js", world.baseEnv(extra));

  /** The bonus the adapter must compute for a position, by the contract formula. */
  async function expectedBonus(tokenId) {
    const position = await nfpm.positions(tokenId);
    const { twapTick } = await vault.previewTwap();
    const value = PV.valueAt(
      position.liquidity,
      Number(position.tickLower),
      Number(position.tickUpper),
      Number(twapTick),
      await escrow.bonusIsToken0()
    );
    return PV.bonusFor(value, BONUS_BPS, MIN_BONUS);
  }

  before(async function () {
    world = await startWorld("lp-apebond-ops");
    ({ w, provider } = world);
    recordFile = path.join(world.scratchDir, `apebond-rehearsal-${CHAIN_ID}.json`);
    asset = world.asset;
    nfpm = world.nfpm;

    await world.runOk("deploy-lp-staking.js", world.coreEnv());
    vaultAddr = world.entry("LPStakingVault").address;

    // The rehearsal's caller exists before the route, so the activation allowlists it.
    const callerRun = await rehearsalOk("caller");
    callerAddr = readRecord().caller;
    expect(callerRun.stdout).to.include(callerAddr);

    activation = await world.runOk(
      "deploy-apebond.js",
      world.baseEnv({
        LP_APEBOND_BONUS_TOKEN: world.assetAddr,
        LP_APEBOND_SOULZAP_CALLERS: callerAddr,
        LP_APEBOND_WAIT_POLL_MS: "200",
        ...campaignEnv({ id: "rehearsal-campaign", cliffSeconds: CLIFF_SECONDS }),
      })
    );
    escrowAddr = world.entry("BonusEscrow").address;
    adapterAddr = world.entry("ApeBondPositionAdapter").address;
    vault = await world.contractAt("LPStakingVault", vaultAddr);
    escrow = await world.contractAt("BonusEscrow", escrowAddr);
    adapter = await world.contractAt("ApeBondPositionAdapter", adapterAddr);
    campaignId = ethers.id("rehearsal-campaign");
  });

  after(async function () {
    if (world) await world.stop();
  });

  // ─────────────────────────────────────────────────────────────
  describe("the route this suite starts from", function () {
    it("was activated and linked by deploy-apebond.js, with the caller permitted for the campaign", async function () {
      expect(activation.stdout).to.include("All post-activation verification checks passed.");
      expect(await vault.bonusEscrow()).to.equal(escrowAddr);
      expect(await escrow.vault()).to.equal(vaultAddr);
      expect(await escrow.adapter()).to.equal(adapterAddr);
      expect(await vault.isStakeOperator(adapterAddr)).to.equal(true);
      expect(await adapter.soulZapCallers(callerAddr)).to.equal(true);
      expect(await adapter.campaignCallers(campaignId, callerAddr)).to.equal(true);
      expect(await asset.balanceOf(escrowAddr)).to.equal(0n);
    });

    it("recorded the MockSoulZapCaller the caller phase deployed", async function () {
      const record = readRecord();
      expect(record.caller).to.equal(callerAddr);
      expect(await provider.getCode(callerAddr)).to.not.equal("0x");
      const receipt = await provider.getTransactionReceipt(record.callerTx);
      expect(receipt.contractAddress).to.equal(callerAddr);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("apebond-rehearsal.js — deposit", function () {
    let purchase;

    it("refuses a caller that is not permitted for the campaign, before minting anything", async function () {
      const stranger = await world.deployArtifact("MockSoulZapCaller");
      const before = await nfpm.nextTokenId();
      const result = await rehearsal("deposit", { LP_REHEARSAL_CALLER: await stranger.getAddress() });
      expect(result.code).to.not.equal(0);
      expect(result.stderr + result.stdout).to.match(/is not allowlisted on the adapter for campaign/);
      expect(await nfpm.nextTokenId()).to.equal(before);
    });

    it("buys a position for the beneficiary and reserves the computed bonus with an EMPTY escrow", async function () {
      const result = await rehearsalOk("deposit", { LP_REHEARSAL_BENEFICIARY: w.alice.address });
      purchase = readRecord().purchases.at(-1);
      expect(purchase.kind).to.equal("deposit");
      expect(purchase.beneficiary).to.equal(w.alice.address);

      const tokenId = BigInt(purchase.tokenId);
      expect(await nfpm.ownerOf(tokenId)).to.equal(vaultAddr);
      expect(await vault.stakerOf(tokenId)).to.equal(w.alice.address);

      const [beneficiary, amount, unlockAt, claimed, forfeited] = await escrow.reservationOf(tokenId);
      const bonus = await expectedBonus(tokenId);
      expect(bonus).to.be.greaterThan(0n);
      expect(beneficiary).to.equal(w.alice.address);
      expect(amount).to.equal(bonus);
      expect(claimed).to.equal(false);
      expect(forfeited).to.equal(false);
      expect(purchase.bonus).to.equal(bonus.toString());
      expect(purchase.unlockAt).to.equal(Number(unlockAt));
      expect(await escrow.totalReserved()).to.equal(bonus);
      expect(await asset.balanceOf(escrowAddr)).to.equal(0n);

      const receipt = await provider.getTransactionReceipt(purchase.depositTx);
      const deposited = receipt.logs
        .filter((log) => log.address === adapterAddr)
        .map((log) => adapter.interface.parseLog(log))
        .find((event) => event && event.name === "ApeBondPositionDeposited");
      expect(deposited.args.tokenId).to.equal(tokenId);
      expect(deposited.args.campaignId).to.equal(campaignId);
      expect(deposited.args.bonusAmount).to.equal(bonus);
      expect(result.stdout).to.include("bonus ");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("apebond-rehearsal.js — loop (B.3 P2)", function () {
    it("buys and unstakes in one transaction, and the bonus is forfeited in it", async function () {
      const reservedBefore = await escrow.totalReserved();
      const result = await rehearsalOk("loop");
      const loop = readRecord().purchases.at(-1);
      expect(loop.kind).to.equal("loop");
      expect(result.stdout).to.include(`OK: BonusForfeited(${loop.tokenId}, ${callerAddr}`);

      const tokenId = BigInt(loop.tokenId);
      const [beneficiary, amount, , , forfeited] = await escrow.reservationOf(tokenId);
      expect(beneficiary).to.equal(callerAddr);
      expect(amount).to.equal(0n);
      expect(forfeited).to.equal(true);
      expect(await escrow.totalReserved()).to.equal(reservedBefore);
      expect(await nfpm.ownerOf(tokenId)).to.equal(callerAddr);
      expect(await vault.stakerOf(tokenId)).to.equal(ethers.ZeroAddress);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("apebond-rehearsal.js — withdrawal (B.3 P3)", function () {
    it("follows the bonus through two rebalances and never raises it", async function () {
      // The script's own two ranges, stated explicitly for the mock's tick-0 pool.
      await chain.send(nfpm.connect(w.deployer).setMintConsumeBps(10_000));
      const reservedBefore = await escrow.totalReserved();
      const result = await rehearsalOk("withdrawal", {
        LP_REHEARSAL_R1_TICKS: "-1200,600",
        LP_REHEARSAL_R2_TICKS: "-600,1800",
      });

      const record = readRecord().purchases.at(-1);
      expect(record.kind).to.equal("withdrawal");
      expect(record.steps).to.have.length(2);
      expect(result.stdout).to.match(/rebalance 1: bonus .* -> .* % of the original/);
      expect(result.stdout).to.match(/rebalance 2: bonus .* -> .* % of the original/);

      // The reservation follows the position: the first new id is burned by the second
      // rebalance, so only the last id carries it, at the amount the second step reported.
      let previous = BigInt(record.bonus);
      for (const step of record.steps) {
        const amount = BigInt(step.amount);
        expect(amount <= previous, "a rebalance never raises the bonus").to.equal(true);
        previous = amount;
      }
      const [gone] = await escrow.reservationOf(BigInt(record.steps[0].newTokenId));
      expect(gone).to.equal(ethers.ZeroAddress);
      const [beneficiary, amount, , , forfeited] = await escrow.reservationOf(
        BigInt(record.steps[1].newTokenId)
      );
      expect(beneficiary).to.equal(w.deployer.address);
      expect(amount.toString()).to.equal(record.steps[1].amount);
      expect(forfeited).to.equal(amount === 0n);
      expect(record.tokenId).to.equal(record.steps[1].newTokenId);
      const final = BigInt(record.steps[1].amount);
      expect(await escrow.totalReserved()).to.equal(reservedBefore + final);
    });

    it("scales exactly by the contract formula when the re-mint takes value out", async function () {
      // A second withdrawal, this time with the mock re-minting 20 % of the balance on each
      // rebalance, and every amount recomputed here from the on-chain snapshots.
      await chain.send(nfpm.connect(w.deployer).setMintConsumeBps(10_000));
      const caller = await world.contractAt("MockSoulZapCaller", callerAddr, w.deployer);
      // Mint the campaign position into the caller and deposit it for alice, by hand.
      const tokenAddr = [world.token0Addr, world.token1Addr];
      for (const t of tokenAddr) {
        const token = await world.contractAt("MockERC20Decimals", t, w.deployer);
        await chain.send(token.approve(world.nfpmAddr, ethers.MaxUint256));
      }
      const npmAsDeployer = nfpm.connect(w.deployer);
      await chain.send(
        npmAsDeployer.mint({
          token0: world.token0Addr,
          token1: world.token1Addr,
          fee: 3000,
          tickLower: -1200,
          tickUpper: 1200,
          amount0Desired: 10n ** 22n,
          amount1Desired: 10n ** 22n,
          amount0Min: 0,
          amount1Min: 0,
          recipient: callerAddr,
          deadline: 10n ** 12n,
        })
      );
      const id0 = await nfpm.lastMintedId();
      await chain.send(caller.deposit(adapterAddr, world.nfpmAddr, id0, campaignId, w.alice.address));
      const [, bonus0] = await escrow.reservationOf(id0);
      expect(bonus0).to.equal(await expectedBonus(id0));

      await chain.send(nfpm.connect(w.deployer).setMintConsumeBps(2_000));
      const { twapTick } = await vault.previewTwap();
      const inToken0 = await escrow.bonusIsToken0();
      const valueOf = async (id) => {
        const p = await nfpm.positions(id);
        return PV.valueAt(p.liquidity, Number(p.tickLower), Number(p.tickUpper), Number(twapTick), inToken0);
      };
      const before = await valueOf(id0);
      const vaultAsAlice = vault.connect(w.alice);
      await chain.send(vaultAsAlice.rebalance(id0, -1200, 1200, [false, 0, 0, 0, 0], 10n ** 12n));
      const id1 = await nfpm.lastMintedId();
      const [, bonus1] = await escrow.reservationOf(id1);
      expect(bonus1).to.equal(PV.scaledAmount(bonus0, before, await valueOf(id1)));
      expect(bonus1 < bonus0).to.equal(true);
      await chain.send(nfpm.connect(w.deployer).setMintConsumeBps(10_000));
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("apebond-rehearsal.js — claim before the cliff", function () {
    it("reports every purchase as locked or forfeited and sends nothing", async function () {
      const balanceBefore = await asset.balanceOf(escrowAddr);
      const result = await rehearsalOk("claim");
      expect(result.stdout).to.match(/locked until \d+/);
      expect(result.stdout).to.include("FORFEITED");
      expect(await asset.balanceOf(escrowAddr)).to.equal(balanceBefore);
      expect(readRecord().purchases.every((p) => !p.claimTx)).to.equal(true);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("after the cliff, with nothing in the escrow", function () {
    before(async function () {
      await world.advance(CLIFF_SECONDS + 1);
    });

    it("reports InsufficientFunds for every live claim and sends nothing", async function () {
      const owed = await escrow.totalReserved();
      expect(owed).to.be.greaterThan(0n);
      const result = await rehearsalOk("claim");
      expect(result.stdout).to.match(
        /claim reverts — InsufficientFunds: needs .* the escrow holds 0\.0 ASSET/
      );
      expect(await asset.balanceOf(escrowAddr)).to.equal(0n);
      expect(await escrow.totalReserved()).to.equal(owed);
      expect(readRecord().purchases.every((p) => !p.claimTx)).to.equal(true);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("fund-escrow.js", function () {
    it("refuses a run that states neither an amount nor a target", async function () {
      const result = await fund({});
      expect(result.code).to.not.equal(0);
      expect(result.stderr + result.stdout).to.include("Set LP_APEBOND_FUND_AMOUNT in whole tokens");
    });

    it("refuses both at once — they answer different questions", async function () {
      const result = await fund({ LP_APEBOND_FUND_AMOUNT: "1", LP_APEBOND_FUND_TARGET: "1" });
      expect(result.code).to.not.equal(0);
      expect(result.stderr + result.stdout).to.include("not both");
    });

    it("refuses an amount the sender cannot cover, and sends nothing", async function () {
      const result = await fund({ LP_APEBOND_FUND_AMOUNT: "1000000000000" });
      expect(result.code).to.not.equal(0);
      expect(result.stderr + result.stdout).to.match(/Insufficient ASSET .* Nothing was sent/);
      expect(await asset.balanceOf(escrowAddr)).to.equal(0n);
    });

    it("reports the SHORTFALL and covers exactly what is owed with TARGET=0", async function () {
      const owed = await escrow.totalReserved();
      const senderBefore = await asset.balanceOf(w.deployer.address);
      const result = await fund({ LP_APEBOND_FUND_TARGET: "0" });
      expect(result.code, result.stderr).to.equal(0);
      expect(result.stdout).to.include("SHORT — claims revert InsufficientFunds");
      expect(result.stdout).to.include("Every reservation");
      expect(await asset.balanceOf(escrowAddr)).to.equal(owed);
      expect(senderBefore - (await asset.balanceOf(w.deployer.address))).to.equal(owed);
      expect(await escrow.totalReserved()).to.equal(owed);
    });

    it("sends nothing when the target is already met", async function () {
      const before = await asset.balanceOf(escrowAddr);
      const result = await fund({ LP_APEBOND_FUND_TARGET: "0" });
      expect(result.code).to.equal(0);
      expect(result.stdout).to.include("nothing to send, nothing sent");
      expect(await asset.balanceOf(escrowAddr)).to.equal(before);
    });

    it("transfers a fixed amount and tops up to a surplus target with only the difference", async function () {
      const before = await asset.balanceOf(escrowAddr);
      await world.runOk("fund-escrow.js", world.baseEnv({ LP_APEBOND_FUND_AMOUNT: "3" }));
      expect(await asset.balanceOf(escrowAddr)).to.equal(before + 3n * 10n ** 18n);

      const owed = await escrow.totalReserved();
      const result = await world.runOk("fund-escrow.js", world.baseEnv({ LP_APEBOND_FUND_TARGET: "5" }));
      expect(result.stdout).to.include("surplus");
      expect(await asset.balanceOf(escrowAddr)).to.equal(owed + 5n * 10n ** 18n);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("apebond-rehearsal.js — claim once funded, and status", function () {
    it("pays every live reservation to its beneficiary, exactly", async function () {
      const live = [];
      for (const p of readRecord().purchases) {
        const [beneficiary, amount, , claimed, forfeited] = await escrow.reservationOf(BigInt(p.tokenId));
        if (beneficiary !== ethers.ZeroAddress && !claimed && !forfeited)
          live.push({ p, beneficiary, amount });
      }
      expect(live.length).to.be.greaterThan(0);
      const balances = {};
      for (const { beneficiary } of live) balances[beneficiary] = await asset.balanceOf(beneficiary);

      await rehearsalOk("claim");

      const paid = {};
      for (const { beneficiary, amount } of live) paid[beneficiary] = (paid[beneficiary] || 0n) + amount;
      for (const [beneficiary, amount] of Object.entries(paid)) {
        const delta = (await asset.balanceOf(beneficiary)) - balances[beneficiary];
        // The deployer also signs the claims (and pays gas in ETH, not ASSET), so the ASSET
        // delta is exactly the bonus for every beneficiary.
        expect(delta, beneficiary).to.equal(amount);
      }
      for (const { p } of live) {
        const [, , , claimed] = await escrow.reservationOf(BigInt(p.tokenId));
        expect(claimed).to.equal(true);
      }
      expect(readRecord().purchases.filter((p) => p.claimTx).length).to.equal(live.length);
    });

    it("sends nothing on a second claim run", async function () {
      const before = await asset.balanceOf(escrowAddr);
      await rehearsalOk("claim");
      expect(await asset.balanceOf(escrowAddr)).to.equal(before);
    });

    it("reports every recorded reservation", async function () {
      const result = await rehearsalOk("status");
      for (const p of readRecord().purchases)
        expect(result.stdout).to.include(`token ${p.tokenId} (${p.kind})`);
      expect(result.stdout).to.match(/totalReserved .* balance /);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("the tracked registry", function () {
    it("was never written by any of these runs", function () {
      expect(runner.sha256File(runner.TRACKED_REGISTRY)).to.equal(TRACKED_REGISTRY_SHA256);
    });
  });
});
