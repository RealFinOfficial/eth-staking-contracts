const fs = require("fs");
const path = require("path");

const { expect } = require("chai");
const ethers = require("ethers");

const runner = require("./helpers/scripts");
const lpTimelock = require("../../scripts/lp-timelock");
const apebond = require("../../scripts/lib/apebond");
const { CHAIN_ID, campaignEnv, startWorld, withTimePump } = require("./helpers/apebondWorld");

/**
 * The two scripts that deploy the ApeBond route, run as CHILD PROCESSES against a plain spawned
 * `hardhat node` with the repo's mock market (B.3 decision document, 2026-10-01, with the
 * overrides of 2026-10-05):
 *
 *   scripts/deploy-lp-staking.js  with LP_APEBOND_ENABLED=1 — a FRESH stack plus the pair:
 *                                 `BonusEscrow(bonusToken, vault)` born owned by the timelock with
 *                                 its reserve path closed, the adapter wired (callers, campaign) and
 *                                 handed to the timelock, and the ONE link batch — setBonusEscrow,
 *                                 setStakeOperator, setAdapter — PRINTED and FILED, not sent.
 *   scripts/deploy-apebond.js     on that live stack: `activate` finds the pair, drives the same
 *                                 batch through the timelock (waiting its delay in CHAIN time) and
 *                                 asserts the link; `verify` asserts it read-only and fails loudly on
 *                                 a wrong link; `replace-adapter` swaps the adapter in one batch of
 *                                 three, resumably; `upgrade-vault` is the plain one-call upgrade.
 *
 * Why the link checks are MANDATORY: the vault's exit hook fails OPEN, so a vault pointed at the
 * wrong escrow (or at none) would let every exit before a cliff keep its bonus, with nothing
 * reverting anywhere. The only defence is to read `vault.bonusEscrow()` and `escrow.vault()` back
 * and compare them — every run here asserts the scripts do.
 *
 * The timelock is deployed with a 60-second delay; while a child waits it out, {withTimePump}
 * pushes the node's clock forward. Every child writes a scratch DEPLOYMENTS_FILE, and the tracked
 * `deployments.json` sha256 is asserted unchanged at the end.
 */

const TRACKED_REGISTRY_SHA256 = runner.sha256File(runner.TRACKED_REGISTRY);
const MIN_DELAY = "60";
const CAMPAIGN = campaignEnv({ id: "deploy-suite-campaign", cliffSeconds: 300 });
const CAMPAIGN_ID = ethers.id("deploy-suite-campaign");

describe("deploy-lp-staking.js (LP_APEBOND_ENABLED=1) and deploy-apebond.js", function () {
  this.timeout(20 * 60 * 1000);

  let world, w, provider;
  let fresh;
  let vaultAddr, timelockAddr, escrowAddr, adapterAddr, batchFile;
  let vault, escrow, adapter, timelock;

  const apebondEnv = (extra = {}) =>
    world.baseEnv({ LP_APEBOND_WAIT_POLL_MS: "100", LP_APEBOND_ASSERT_POSITIONS: "", ...extra });
  const nonceOf = (address) => provider.getTransactionCount(address, "latest");

  before(async function () {
    world = await startWorld("lp-deploy-apebond");
    ({ w, provider } = world);
  });

  after(async function () {
    if (world) await world.stop();
  });

  // ─────────────────────────────────────────────────────────────
  describe("refusals, before anything is deployed", function () {
    async function refused(extra, pattern) {
      const scratch = path.join(world.scratchDir, `refused-${Date.now()}.json`);
      const nonce = await nonceOf(w.deployer.address);
      const result = await world.run(
        "deploy-lp-staking.js",
        world.coreEnv({ DEPLOYMENTS_FILE: scratch, LP_APEBOND_ENABLED: "1", ...CAMPAIGN, ...extra })
      );
      expect(result.code).to.not.equal(0);
      expect(result.stderr + result.stdout).to.match(pattern);
      expect(await nonceOf(w.deployer.address), "not one transaction was sent").to.equal(nonce);
      expect(fs.existsSync(scratch), "nothing was recorded").to.equal(false);
    }

    it("refuses the route on the pre-route (lane-1) vault, which deploy-apebond.js upgrades instead", async function () {
      await refused(
        { LP_VAULT_CONTRACT: "LPStakingVaultLane1Mock" },
        /LP_APEBOND_ENABLED=1 deploys the route onto a FRESH current vault/
      );
    });

    it("refuses a campaign tolerance below the pool's tick spacing", async function () {
      await refused(
        { LP_APEBOND_TOLERANCE_TICKS: "59" },
        /LP_APEBOND_TOLERANCE_TICKS 59 is below the pool's tick spacing 60/
      );
    });

    it("refuses a fall of 100 % or more, which no tick can express", async function () {
      await refused({ LP_APEBOND_DOWN_PCT: "100" }, /LP_APEBOND_DOWN_PCT must be below 100 — got 100/);
    });

    it("refuses a rate above the whole value", async function () {
      await refused({ LP_APEBOND_BONUS_BPS: "10001" }, /LP_APEBOND_BONUS_BPS must be <= 10000/);
    });

    it("refuses a bonus token that is not one of the pool's two tokens", async function () {
      await refused(
        { LP_APEBOND_BONUS_TOKEN: w.alice.address },
        /LP_APEBOND_BONUS_TOKEN .* is neither pool token/
      );
    });

    it("refuses a flag that is neither 1 nor 0", async function () {
      await refused({ LP_APEBOND_ENABLED: "true" }, /LP_APEBOND_ENABLED must be 1, 0 or unset — got true/);
    });

    it("refuses a campaign cliff below the adapter's floor, naming both variables (C-14)", async function () {
      await refused(
        { LP_APEBOND_MIN_CLIFF_SECONDS: "301" },
        /LP_APEBOND_CLIFF_SECONDS 300 is below LP_APEBOND_MIN_CLIFF_SECONDS 301/
      );
    });

    it("applies the one-day default floor when LP_APEBOND_MIN_CLIFF_SECONDS is unset (C-14)", async function () {
      await refused(
        { LP_APEBOND_MIN_CLIFF_SECONDS: "" },
        /LP_APEBOND_CLIFF_SECONDS 300 is below LP_APEBOND_MIN_CLIFF_SECONDS 86400/
      );
    });

    it("refuses a pool whose CURRENT cardinality cannot serve the window, before sending anything (L-04)", async function () {
      // 300 s needs ceil(300 / 6) + 1 = 51 slots. A grown next size does not count.
      await (await world.pool.setObservationCardinality(50)).wait();
      await (await world.pool.increaseObservationCardinalityNext(1000)).wait();
      try {
        // Without the route the longest window is the vault's own 300 s.
        await refused(
          { LP_APEBOND_ENABLED: "0" },
          /CURRENT observationCardinality is 50, below the 51 slots a 300s window needs .*nothing was sent/
        );
      } finally {
        await (await world.pool.setObservationCardinality(65535)).wait();
      }
    });

    it("refuses a pool whose history is shorter than the window, before sending anything (L-04)", async function () {
      await (await world.pool.setHistorySeconds(299)).wait();
      try {
        await refused(
          { LP_APEBOND_ENABLED: "0" },
          /pool\.observe\(\[300, 0\]\) reverts: the pool's stored history is shorter than 300s/
        );
      } finally {
        await (await world.pool.setHistorySeconds(4294967295n)).wait();
      }
    });

    it("refuses a valuation window outside 300..3600 s, before sending anything (L-02)", async function () {
      await refused({ LP_APEBOND_VALUATION_WINDOW: "299" }, /LP_APEBOND_VALUATION_WINDOW must be >= 300 — got 299/);
      await refused({ LP_APEBOND_VALUATION_WINDOW: "3601" }, /LP_APEBOND_VALUATION_WINDOW must be <= 3600 — got 3601/);
    });

    it("refuses a pool that cannot serve the valuation window, the longer of the two (L-04)", async function () {
      // The vault's 300 s needs 51 slots; the adapter's default 1800 s needs 301.
      await (await world.pool.setObservationCardinality(300)).wait();
      try {
        await refused({}, /CURRENT observationCardinality is 300, below the 301 slots a 1800s window needs/);
      } finally {
        await (await world.pool.setObservationCardinality(65535)).wait();
      }
    });

    it("refuses a zero floor in both scripts, before either sends anything (C-14)", async function () {
      await refused({ LP_APEBOND_MIN_CLIFF_SECONDS: "0" }, /LP_APEBOND_MIN_CLIFF_SECONDS must be >= 1 — got 0/);

      const nonce = await nonceOf(w.deployer.address);
      const result = await world.run("deploy-apebond.js", apebondEnv({ LP_APEBOND_MIN_CLIFF_SECONDS: "0" }));
      expect(result.code).to.not.equal(0);
      expect(result.stderr + result.stdout).to.match(/LP_APEBOND_MIN_CLIFF_SECONDS must be >= 1 — got 0/);
      expect(await nonceOf(w.deployer.address), "not one transaction was sent").to.equal(nonce);
    });

    it("refuses a floor below one day on mainnet, and only there (C-14)", function () {
      const saved = process.env.LP_APEBOND_MIN_CLIFF_SECONDS;
      try {
        process.env.LP_APEBOND_MIN_CLIFF_SECONDS = "86399";
        expect(() => apebond.readMinCliff(1)).to.throw(
          /LP_APEBOND_MIN_CLIFF_SECONDS is 86399 — on mainnet the adapter's cliff floor must be at least 86400 s/
        );
        expect(apebond.readMinCliff(11155111)).to.equal(86_399n);
        expect(apebond.readMinCliff(CHAIN_ID)).to.equal(86_399n);
        process.env.LP_APEBOND_MIN_CLIFF_SECONDS = "86400";
        expect(apebond.readMinCliff(1)).to.equal(86_400n);
        delete process.env.LP_APEBOND_MIN_CLIFF_SECONDS;
        expect(apebond.readMinCliff(1)).to.equal(86_400n);
      } finally {
        if (saved === undefined) delete process.env.LP_APEBOND_MIN_CLIFF_SECONDS;
        else process.env.LP_APEBOND_MIN_CLIFF_SECONDS = saved;
      }
    });
  });

  // ─────────────────────────────────────────────────────────────
  /**
   * The campaign's band variables, parsed in this process by `readCampaign` (the function both
   * deploy scripts call): percentages to ticks, the tick overrides, the defaults, and every
   * refusal the adapter's `setCampaign` would make.
   */
  describe("the campaign band variables (readCampaign)", function () {
    const KEYS = [
      "LP_APEBOND_CAMPAIGN_ID",
      "LP_APEBOND_DOWN_PCT",
      "LP_APEBOND_UP_PCT",
      "LP_APEBOND_DOWN_TICKS",
      "LP_APEBOND_UP_TICKS",
      "LP_APEBOND_TOLERANCE_TICKS",
      "LP_APEBOND_CLIFF_SECONDS",
      "LP_APEBOND_BONUS_BPS",
      "LP_APEBOND_MIN_BONUS",
      "LP_APEBOND_CAMPAIGN_ENABLED",
    ];
    const POOL = { tickSpacing: 60, bonusDecimals: 18 };
    let saved;

    /** readCampaign with exactly `env` (plus the three required campaign variables) set. */
    function parse(env, pool = POOL) {
      for (const key of KEYS) delete process.env[key];
      Object.assign(process.env, {
        LP_APEBOND_CAMPAIGN_ID: "band-test",
        LP_APEBOND_CLIFF_SECONDS: "300",
        LP_APEBOND_BONUS_BPS: "1000",
        ...env,
      });
      return apebond.readCampaign(pool, 300n);
    }
    const band = (c) => [c.config.downTicks, c.config.upTicks, c.config.toleranceTicks];

    beforeEach(function () {
      saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
    });
    afterEach(function () {
      for (const key of KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });

    it("defaults to -50 % / +100 % around the price at purchase, 500 ticks of tolerance", function () {
      expect(band(parse({}))).to.deep.equal([6932, 6932, 500]);
      // Both are ln 2 / ln 1.0001 = 6931.8: the price halves, the price doubles.
      expect(apebond.downPctToTicks(50)).to.equal(6932);
      expect(apebond.upPctToTicks(100)).to.equal(6932);
    });

    it("converts any percentage with round(ln(...) / ln(1.0001))", function () {
      // ln(1 / 0.75) / ln 1.0001 = 2876.96; ln 1.5 / ln 1.0001 = 4054.85;
      // ln(1 / 0.665) / ln 1.0001 = 4079.89; ln 1.1 / ln 1.0001 = 953.15
      expect(band(parse({ LP_APEBOND_DOWN_PCT: "25", LP_APEBOND_UP_PCT: "50" }))).to.deep.equal([2877, 4055, 500]);
      expect(band(parse({ LP_APEBOND_DOWN_PCT: "33.5", LP_APEBOND_UP_PCT: "10" }))).to.deep.equal([4080, 953, 500]);
      expect(apebond.downTicksToPct(2877)).to.equal("25.00");
      expect(apebond.upTicksToPct(4055)).to.equal("50.00");
    });

    it("takes LP_APEBOND_DOWN_TICKS / _UP_TICKS over the percentages, each on its own", function () {
      expect(
        band(parse({ LP_APEBOND_DOWN_PCT: "25", LP_APEBOND_DOWN_TICKS: "1200", LP_APEBOND_UP_TICKS: "3000" }))
      ).to.deep.equal([1200, 3000, 500]);
      expect(band(parse({ LP_APEBOND_UP_TICKS: "3000" }))).to.deep.equal([6932, 3000, 500]);
      expect(band(parse({ LP_APEBOND_DOWN_TICKS: "1", LP_APEBOND_UP_TICKS: "1", LP_APEBOND_TOLERANCE_TICKS: "60" })))
        .to.deep.equal([1, 1, 60]);
    });

    it("refuses a tolerance below the pool's tick spacing, on any spacing", function () {
      expect(() => parse({ LP_APEBOND_TOLERANCE_TICKS: "59" })).to.throw(
        /LP_APEBOND_TOLERANCE_TICKS 59 is below the pool's tick spacing 60/
      );
      expect(band(parse({ LP_APEBOND_TOLERANCE_TICKS: "60" }))).to.deep.equal([6932, 6932, 60]);
      // The 1 % tier's 200-tick spacing: the 500 default passes, 199 does not.
      expect(band(parse({}, { tickSpacing: 200, bonusDecimals: 18 }))).to.deep.equal([6932, 6932, 500]);
      expect(() => parse({ LP_APEBOND_TOLERANCE_TICKS: "199" }, { tickSpacing: 200, bonusDecimals: 18 })).to.throw(
        /LP_APEBOND_TOLERANCE_TICKS 199 is below the pool's tick spacing 200/
      );
    });

    it("refuses every offset the adapter would refuse, each by its own message", function () {
      const refusals = [
        [{ LP_APEBOND_DOWN_PCT: "0" }, /LP_APEBOND_DOWN_PCT must be above 0 — got 0/],
        [{ LP_APEBOND_DOWN_PCT: "100" }, /LP_APEBOND_DOWN_PCT must be below 100 — got 100/],
        [{ LP_APEBOND_UP_PCT: "-5" }, /LP_APEBOND_UP_PCT must be a positive number of percent — got -5/],
        [{ LP_APEBOND_UP_PCT: "ten" }, /LP_APEBOND_UP_PCT must be a positive number of percent — got ten/],
        [{ LP_APEBOND_DOWN_TICKS: "0" }, /The campaign's downTicks must be above zero — got 0/],
        [{ LP_APEBOND_UP_TICKS: "-60" }, /The campaign's upTicks must be above zero — got -60/],
        [{ LP_APEBOND_DOWN_TICKS: "1.5" }, /LP_APEBOND_DOWN_TICKS must be an integer — got 1\.5/],
        [{ LP_APEBOND_TOLERANCE_TICKS: "8388608" }, /LP_APEBOND_TOLERANCE_TICKS must be <= 8388607 — got 8388608/],
        [
          { LP_APEBOND_DOWN_TICKS: "887272", LP_APEBOND_UP_TICKS: "887272" },
          /downTicks \+ upTicks = 1774544 must be below 1774544/,
        ],
      ];
      for (const [env, pattern] of refusals) {
        expect(() => parse(env), JSON.stringify(env)).to.throw(pattern);
      }
      // One tick narrower than the whole tick range is legal, as on chain.
      expect(band(parse({ LP_APEBOND_DOWN_TICKS: "887272", LP_APEBOND_UP_TICKS: "887271" }))).to.deep.equal([
        887272, 887271, 500,
      ]);
    });

    it("records and describes the band in ticks and in percent", function () {
      const campaign = parse({ LP_APEBOND_DOWN_TICKS: "2877", LP_APEBOND_UP_PCT: "50" });
      const record = apebond.campaignRecord(campaign, []);
      expect(record).to.deep.include({
        downTicks: 2877,
        upTicks: 4055,
        toleranceTicks: 500,
        downPct: "25.00",
        upPct: "50.00",
      });
      expect(record).to.not.have.property("tickLower");
      expect(apebond.campaignTuple(campaign.config)).to.deep.equal([true, 2877, 4055, 500, 300n, 1000n, 0n]);
      const text = apebond.describeCampaign(campaign, { tickSpacing: 60, bonusDecimals: 18, bonusSymbol: "ASSET" });
      expect(text).to.include("2877 ticks below (-25.00 %) to 4055 ticks above (+50.00 %)");
      expect(text).to.include("tolerance 500 ticks per edge (spacing 60)");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("a fresh stack with the route (deploy-lp-staking.js)", function () {
    before(async function () {
      fresh = await world.runOk(
        "deploy-lp-staking.js",
        world.coreEnv({
          LP_TIMELOCK_MIN_DELAY: MIN_DELAY,
          LP_APEBOND_ENABLED: "1",
          LP_APEBOND_SOULZAP_CALLERS: `${w.soulZapCaller.address},${w.signer2.address}`,
          ...CAMPAIGN,
        })
      );
      vaultAddr = world.entry("LPStakingVault").address;
      timelockAddr = world.entry("TimelockController").address;
      escrowAddr = world.entry("BonusEscrow").address;
      adapterAddr = world.entry("ApeBondPositionAdapter").address;
      batchFile = path.join(world.scratchDir, "apebond-link-batch.json");
      vault = await world.contractAt("LPStakingVault", vaultAddr);
      escrow = await world.contractAt("BonusEscrow", escrowAddr);
      adapter = await world.contractAt("ApeBondPositionAdapter", adapterAddr);
      timelock = await world.contractAt("LPTimelock", timelockAddr);
    });

    it("deployed the pair, passed its checks, and said the link is pending", function () {
      expect(fresh.stdout).to.include("ApeBond route:      ENABLED (LP_APEBOND_ENABLED=1)");
      expect(fresh.stdout).to.include("All post-deploy checks passed.");
      expect(fresh.stdout).to.include("WARN  the route is NOT linked yet — PENDING TIMELOCK BATCH");
      expect(fresh.stdout).to.include(
        "OK    BonusEscrow.vault (MANDATORY: the escrow accepts this vault's reports)"
      );
      expect(fresh.stdout).to.not.include("FAIL");
      expect(fresh.stdout).to.not.match(/purchase signer/i);
    });

    it("left the vault and the escrow UNLINKED: no purchase can be made yet", async function () {
      expect(await vault.bonusEscrow()).to.equal(ethers.ZeroAddress);
      expect(await vault.isStakeOperator(adapterAddr)).to.equal(false);
      expect(await escrow.adapter()).to.equal(ethers.ZeroAddress);
      expect(await escrow.vault()).to.equal(vaultAddr);
      expect(await escrow.bonusToken()).to.equal(world.assetAddr);
      expect(await escrow.owner()).to.equal(timelockAddr);
    });

    it("wired the adapter's callers and campaign, then NOMINATED the timelock (the third state, L-03)", async function () {
      // Ownable2Step: the deployer stays the owner until the link batch accepts.
      expect(await adapter.owner()).to.equal(w.deployer.address);
      expect(await adapter.pendingOwner()).to.equal(timelockAddr);
      expect(fresh.stdout).to.include(
        `OK    ApeBondPositionAdapter.pendingOwner (the activation batch opens with acceptOwnership): ${timelockAddr}`
      );
      expect(await adapter.guardian()).to.equal(w.guardian.address);
      for (const caller of [w.soulZapCaller.address, w.signer2.address]) {
        expect(await adapter.soulZapCallers(caller)).to.equal(true);
        expect(await adapter.campaignCallers(CAMPAIGN_ID, caller)).to.equal(true);
      }
      // The default band: -50 % and +100 % (6932 ticks each way), a 500-tick tolerance.
      const c = await adapter.campaigns(CAMPAIGN_ID);
      expect([
        c.enabled,
        c.downTicks,
        c.upTicks,
        c.toleranceTicks,
        c.bonusCliffSeconds,
        c.bonusBps,
        c.minBonusAmount,
      ]).to.deep.equal([true, 6932n, 6932n, 500n, 300n, 1000n, 10n ** 18n]);
      // Placed around the mock pool's tick 0 and rounded outward to the 60-tick grid.
      expect([...(await adapter.campaignRange(CAMPAIGN_ID))]).to.deep.equal([-6960n, 6960n, 0n]);
      expect(fresh.stdout).to.match(
        /6932 ticks below \(-50\.00 %\) to 6932 ticks above \(\+100\.00 %\), tolerance 500 ticks per edge \(spacing 60\)/
      );
    });

    it("recorded both contracts in the new registry schema", function () {
      const registry = world.registry();
      expect(Object.keys(registry.BonusEscrow).sort()).to.deep.equal(
        [
          "address",
          "adapter",
          "block",
          "bonusToken",
          "deployTx",
          "implementation",
          "implementationTx",
          "owner",
          "vault",
        ].sort()
      );
      expect(registry.BonusEscrow.vault).to.equal(vaultAddr);
      expect(registry.BonusEscrow.adapter).to.equal(ethers.ZeroAddress);
      const a = registry.ApeBondPositionAdapter;
      expect(Object.keys(a).sort()).to.deep.equal(
        [
          "address",
          "block",
          "bonusToken",
          "campaigns",
          "deployTx",
          "escrow",
          "fee",
          "guardian",
          "minCliffSeconds",
          "owner",
          "pendingOwner",
          "positionManager",
          "soulZapCallers",
          "tickSpacing",
          "token0",
          "token1",
          "valuationWindow",
          "vault",
        ].sort()
      );
      expect(a.valuationWindow).to.equal(1800);
      expect(a.owner).to.equal(w.deployer.address);
      expect(a.pendingOwner).to.equal(timelockAddr);
      expect(a.tickSpacing).to.equal(60);
      expect(a.minCliffSeconds).to.equal("300");
      expect(a.soulZapCallers).to.deep.equal([w.soulZapCaller.address, w.signer2.address]);
      expect(a.campaigns).to.deep.equal([
        {
          id: CAMPAIGN_ID,
          label: "deploy-suite-campaign",
          enabled: true,
          downTicks: 6932,
          upTicks: 6932,
          toleranceTicks: 500,
          downPct: "50.00",
          upPct: "100.00",
          bonusCliffSeconds: "300",
          bonusBps: 1000,
          minBonusAmount: (10n ** 18n).toString(),
          callers: [w.soulZapCaller.address, w.signer2.address],
        },
      ]);
      expect(registry.LPStakingVault.bonusEscrow).to.equal(ethers.ZeroAddress);
    });

    it("filed the ONE link batch, in order, and printed its Safe calldata", function () {
      const filed = JSON.parse(fs.readFileSync(batchFile, "utf8"));
      // The FIRST call accepts the adapter's ownership: the third state holds (audit L-03).
      expect(filed).to.deep.equal([
        { target: adapterAddr, fn: "acceptOwnership", args: [] },
        { target: vaultAddr, fn: "setBonusEscrow", args: [escrowAddr] },
        { target: vaultAddr, fn: "setStakeOperator", args: [adapterAddr, "true"] },
        { target: escrowAddr, fn: "setAdapter", args: [adapterAddr] },
      ]);
      const batch = lpTimelock.buildBatch(filed);
      expect(fresh.stdout).to.include(`Batch id ${batch.id}`);
      expect(fresh.stdout).to.include(lpTimelock.encodeScheduleBatch(batch, BigInt(MIN_DELAY)));
      expect(fresh.stdout).to.include(lpTimelock.encodeExecuteBatch(batch));
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("deploy-apebond.js verify — before the activation executes (the pre-execute check)", function () {
    it("recognises the third state, prints the adapter's config and asserts pendingOwner == timelock", async function () {
      const nonce = await nonceOf(w.deployer.address);
      const result = await world.runOk("deploy-apebond.js", apebondEnv({ LP_APEBOND_MODE: "verify" }));
      expect(result.stdout).to.include("activation PENDING (nominated to the timelock, not accepted)");
      expect(result.stdout).to.include(`guardian():                     ${w.guardian.address}`);
      expect(result.stdout).to.include("valuationWindow():              1800");
      expect(result.stdout).to.include(`soulZapCallers(${w.soulZapCaller.address}): true`);
      expect(result.stdout).to.include(`campaigns(${CAMPAIGN_ID}):`);
      expect(result.stdout).to.include(`campaignCallers(${CAMPAIGN_ID}, ${w.soulZapCaller.address}): true`);
      expect(result.stdout).to.include(
        `OK    ApeBondPositionAdapter.pendingOwner (the activation batch opens with acceptOwnership): ${timelockAddr}`
      );
      expect(result.stdout).to.include("All pre-execute verification checks passed.");
      expect(result.stdout).to.not.include("FAIL");
      expect(await nonceOf(w.deployer.address)).to.equal(nonce);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("deploy-apebond.js activate — the link", function () {
    let run;
    let nonceBefore;

    before(async function () {
      nonceBefore = await nonceOf(w.deployer.address);
      run = await withTimePump(provider, () => world.runOk("deploy-apebond.js", apebondEnv()));
    });

    it("found the pair, deployed nothing, and drove the filed batch to execution", async function () {
      expect(run.stdout).to.include("phase 2: SKIPPED — the live vault already carries the route");
      expect(run.stdout).to.include(
        `phase 3: SKIPPED — BonusEscrow ${escrowAddr} and ApeBondPositionAdapter ${adapterAddr} are live`
      );
      const batch = lpTimelock.buildBatch(JSON.parse(fs.readFileSync(batchFile, "utf8")));
      expect(run.stdout).to.include(`id:          ${batch.id}`);
      expect(run.stdout).to.include(`0. acceptOwnership() on ${adapterAddr}`);
      expect(await timelock.isOperationDone(batch.id)).to.equal(true);
      expect(run.stdout).to.match(/waiting: \d+s of CHAIN time left/);
      // The resume recognised the third state: no second nomination was sent.
      expect(run.stdout).to.include("The adapter is already NOMINATED to the timelock");
      // schedule + execute, and nothing else
      expect((await nonceOf(w.deployer.address)) - nonceBefore).to.equal(2);
    });

    it("accepted the adapter's ownership in the batch: owned by the timelock, nothing pending", async function () {
      expect(await adapter.owner()).to.equal(timelockAddr);
      expect(await adapter.pendingOwner()).to.equal(ethers.ZeroAddress);
      expect(run.stdout).to.include(`OK    ApeBondPositionAdapter.owner: ${timelockAddr}`);
      expect(run.stdout).to.include(`OK    ApeBondPositionAdapter.pendingOwner: ${ethers.ZeroAddress}`);
      const entry = world.entry("ApeBondPositionAdapter");
      expect(entry.owner).to.equal(timelockAddr);
      expect(entry.pendingOwner).to.equal(ethers.ZeroAddress);
    });

    it("linked the vault and the escrow, and its MANDATORY checks passed", async function () {
      expect(await vault.bonusEscrow()).to.equal(escrowAddr);
      expect(await escrow.vault()).to.equal(vaultAddr);
      expect(await vault.isStakeOperator(adapterAddr)).to.equal(true);
      expect(await escrow.adapter()).to.equal(adapterAddr);
      expect(run.stdout).to.include("OK    LPStakingVault.bonusEscrow (MANDATORY: a wrong link fails open)");
      expect(run.stdout).to.include("All post-activation verification checks passed.");
      expect(run.stdout).to.not.include("FAIL");
    });

    it("recorded the link in the registry", function () {
      const registry = world.registry();
      expect(registry.LPStakingVault.bonusEscrow).to.equal(escrowAddr);
      expect(registry.BonusEscrow.adapter).to.equal(adapterAddr);
    });

    it("sends nothing at all when run again", async function () {
      const nonce = await nonceOf(w.deployer.address);
      const again = await world.runOk("deploy-apebond.js", apebondEnv());
      expect(again.stdout).to.include("ALREADY in place on chain; nothing was sent");
      expect(again.stdout).to.include("All post-activation verification checks passed.");
      expect(await nonceOf(w.deployer.address)).to.equal(nonce);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("post-launch-check.js — krumbgf's item 12 (read-only)", function () {
    const checkEnv = (extra = {}) => world.baseEnv({ LP_EXPECTED_MIN_DELAY: MIN_DELAY, ...extra });

    it("passes for a key that holds nothing, with no pending operation and the expected delay", async function () {
      const nonce = await nonceOf(w.deployer.address);
      const result = await world.runOk("post-launch-check.js", checkEnv({ LP_DEPLOYER: w.alice.address }));
      expect(result.stdout).to.match(/OK    every CallScheduled id has a CallExecuted or a Cancelled \(0 open\)/);
      expect(result.stdout).to.include(`OK    getMinDelay() == ${MIN_DELAY} (is ${MIN_DELAY})`);
      expect(result.stdout).to.include("OK    LPTimelock.PROPOSER_ROLE not held by the deployer");
      expect(result.stdout).to.include(`OK    ApeBondPositionAdapter.owner() is not the deployer (${timelockAddr})`);
      expect(result.stdout).to.include("All post-launch checks passed.");
      expect(await nonceOf(w.deployer.address), "read-only").to.equal(nonce);
    });

    it("fails on a key that still holds timelock roles, and on a delay other than 48 h", async function () {
      // Here the deploying key IS the multisig: proposer, executor and canceller.
      const result = await world.run("post-launch-check.js", world.baseEnv({ LP_DEPLOYER: w.deployer.address }));
      expect(result.code).to.not.equal(0);
      expect(result.stdout).to.include("FAIL  LPTimelock.PROPOSER_ROLE not held by the deployer");
      expect(result.stdout).to.include("FAIL  LPTimelock.EXECUTOR_ROLE not held by the deployer");
      expect(result.stdout).to.include("FAIL  LPTimelock.CANCELLER_ROLE not held by the deployer");
      expect(result.stdout).to.include(`FAIL  getMinDelay() == 172800 (is ${MIN_DELAY})`);
      expect(result.stderr + result.stdout).to.match(/The post-launch check failed for \d+ item\(s\)/);
    });

    it("fails on a key that is still a seat holder of an LP contract", async function () {
      // The vault's operator is a seat the check reads on every LP contract that has one.
      const result = await world.run("post-launch-check.js", checkEnv({ LP_DEPLOYER: w.operator.address }));
      expect(result.code).to.not.equal(0);
      expect(result.stdout).to.include(`FAIL  LPStakingVault.operator() is not the deployer (${w.operator.address})`);
    });

    it("fails while an operation is scheduled and neither executed nor cancelled", async function () {
      const asMultisig = timelock.connect(w.deployer);
      const salt = ethers.id("post-launch-check-pending");
      await (await asMultisig.schedule(vaultAddr, 0, "0x", ethers.ZeroHash, salt, BigInt(MIN_DELAY))).wait();
      const id = await asMultisig.hashOperation(vaultAddr, 0, "0x", ethers.ZeroHash, salt);
      try {
        const result = await world.run("post-launch-check.js", checkEnv({ LP_DEPLOYER: w.alice.address }));
        expect(result.code).to.not.equal(0);
        expect(result.stdout).to.include(`open: ${id} (isOperationPending true`);
        expect(result.stdout).to.include("FAIL  every CallScheduled id has a CallExecuted or a Cancelled (1 open)");
      } finally {
        await (await asMultisig.cancel(id)).wait();
      }
      const cleared = await world.runOk("post-launch-check.js", checkEnv({ LP_DEPLOYER: w.alice.address }));
      expect(cleared.stdout).to.include("All post-launch checks passed.");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("deploy-apebond.js verify", function () {
    it("passes read-only on the linked pair", async function () {
      const nonce = await nonceOf(w.deployer.address);
      const result = await world.runOk("deploy-apebond.js", apebondEnv({ LP_APEBOND_MODE: "verify" }));
      expect(result.stdout).to.include("All verification checks passed.");
      expect(await nonceOf(w.deployer.address)).to.equal(nonce);
    });

    it("FAILS loudly when the registry names an escrow the vault does not report to", async function () {
      // A second, perfectly valid escrow for the same vault — the kind of wrong address a
      // copy-paste puts in a registry. Nothing reverts on chain; only the check catches it.
      const impl = await world.deployArtifact("BonusEscrow", [world.assetAddr, vaultAddr]);
      const init = impl.interface.encodeFunctionData("initialize", [timelockAddr, ethers.ZeroAddress]);
      const proxy = await world.deployArtifact("LPProxy", [await impl.getAddress(), init]);
      const stray = await proxy.getAddress();

      const original = fs.readFileSync(world.registryFile, "utf8");
      const edited = JSON.parse(original);
      edited[String(CHAIN_ID)].BonusEscrow.address = stray;
      fs.writeFileSync(world.registryFile, JSON.stringify(edited, null, 2) + "\n");
      try {
        const result = await world.run("deploy-apebond.js", apebondEnv({ LP_APEBOND_MODE: "verify" }));
        expect(result.code).to.not.equal(0);
        expect(result.stdout).to.include(
          `FAIL  LPStakingVault.bonusEscrow (MANDATORY: a wrong link fails open): ${escrowAddr} (expected ${stray})`
        );
        expect(result.stderr + result.stdout).to.match(/The verification failed for: .*MANDATORY/);
      } finally {
        fs.writeFileSync(world.registryFile, original);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("deploy-apebond.js replace-adapter", function () {
    let oldAdapter, newAdapter, run;

    before(async function () {
      oldAdapter = adapterAddr;
      run = await withTimePump(provider, () =>
        world.runOk(
          "deploy-apebond.js",
          apebondEnv({
            LP_APEBOND_MODE: "replace-adapter",
            LP_APEBOND_SOULZAP_CALLERS: w.carol.address,
            ...CAMPAIGN,
          })
        )
      );
      newAdapter = world.entry("ApeBondPositionAdapter").address;
    });

    it("deployed a new adapter against the SAME escrow and configured it", async function () {
      expect(newAdapter).to.not.equal(oldAdapter);
      const a = await world.contractAt("ApeBondPositionAdapter", newAdapter);
      expect(await a.escrow()).to.equal(escrowAddr);
      expect(await a.vault()).to.equal(vaultAddr);
      expect(await a.owner()).to.equal(timelockAddr);
      expect(await a.soulZapCallers(w.carol.address)).to.equal(true);
      expect(await a.campaignCallers(CAMPAIGN_ID, w.carol.address)).to.equal(true);
      expect((await a.campaigns(CAMPAIGN_ID)).bonusBps).to.equal(1000n);
    });

    it("swapped the rights in ONE batch: accept, new on, old off, escrow re-pointed — in that order", async function () {
      const calls = [
        // The new adapter was nominated to the timelock; the batch accepts it first (L-03).
        { target: newAdapter, fn: "acceptOwnership", args: [] },
        { target: vaultAddr, fn: "setStakeOperator", args: [newAdapter, "true"] },
        { target: vaultAddr, fn: "setStakeOperator", args: [oldAdapter, "false"] },
        { target: escrowAddr, fn: "setAdapter", args: [newAdapter] },
      ];
      const batch = lpTimelock.buildBatch(calls);
      expect(run.stdout).to.include(`id:          ${batch.id}`);
      expect(await timelock.isOperationDone(batch.id)).to.equal(true);
      expect(await vault.isStakeOperator(newAdapter)).to.equal(true);
      expect(await vault.isStakeOperator(oldAdapter)).to.equal(false);
      expect(await escrow.adapter()).to.equal(newAdapter);
      expect(await vault.bonusEscrow()).to.equal(escrowAddr);
      expect(run.stdout).to.include("All post-activation verification checks passed.");
    });

    it("rebuilt the adapter record for the NEW adapter and named the one it replaced", async function () {
      const registry = world.registry();
      const a = registry.ApeBondPositionAdapter;
      expect(a.address).to.equal(newAdapter);
      expect(a.previousAdapter).to.equal(oldAdapter);
      expect(a).to.not.have.property("pendingAdapter");
      expect(a.soulZapCallers).to.deep.equal([w.carol.address]);
      expect(a.campaigns.map((c) => c.id)).to.deep.equal([CAMPAIGN_ID]);
      expect(a.minCliffSeconds).to.equal("300");
      const receipt = await provider.getTransactionReceipt(a.deployTx);
      expect(receipt.contractAddress).to.equal(newAdapter);
      expect(receipt.blockNumber).to.equal(a.block);
      expect(registry.BonusEscrow.adapter).to.equal(newAdapter);
    });

    it("resumes an interrupted replacement through pendingAdapter, without a second deploy", async function () {
      const current = newAdapter;
      // Interrupted: the wait gives up after scheduling (a 1 ms wall-clock ceiling, no pump).
      const cut = await world.run(
        "deploy-apebond.js",
        apebondEnv({ LP_APEBOND_MODE: "replace-adapter", LP_APEBOND_WAIT_TIMEOUT_MS: "1" })
      );
      expect(cut.code).to.not.equal(0);
      expect(cut.stderr + cut.stdout).to.include("It IS scheduled");
      const pending = world.entry("ApeBondPositionAdapter").pendingAdapter;
      expect(pending).to.be.a("string");
      expect(pending).to.not.equal(current);
      expect(await vault.isStakeOperator(pending)).to.equal(false);

      const resumed = await withTimePump(provider, () =>
        world.runOk("deploy-apebond.js", apebondEnv({ LP_APEBOND_MODE: "replace-adapter" }))
      );
      expect(resumed.stdout).to.include(`RESUMING a replacement — the pending adapter ${pending}`);
      expect(resumed.stdout).to.include("is already PENDING — not scheduled again");
      expect(resumed.stdout).to.not.include("Deploying ApeBondPositionAdapter");
      const entry = world.entry("ApeBondPositionAdapter");
      expect(entry.address).to.equal(pending);
      expect(entry.previousAdapter).to.equal(current);
      expect(entry).to.not.have.property("pendingAdapter");
      expect(await escrow.adapter()).to.equal(pending);
      expect(await vault.isStakeOperator(current)).to.equal(false);
      adapterAddr = pending;
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("deploy-apebond.js upgrade-vault", function () {
    it("upgrades the vault in a one-call batch and leaves the route untouched", async function () {
      const implBefore = await provider.getStorage(
        vaultAddr,
        "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
      );
      const run = await withTimePump(provider, () =>
        world.runOk(
          "deploy-apebond.js",
          apebondEnv({
            LP_APEBOND_MODE: "upgrade-vault",
            IMPL_CONTRACT: "LPStakingVaultV2Mock",
            IMPL_UNSAFE_ALLOW_EXTRA: "missing-initializer",
          })
        )
      );
      expect(run.stdout).to.include("A batch of 1 call(s)");
      expect(run.stdout).to.include("upgradeToAndCall(");
      const v2 = await world.contractAt("LPStakingVaultV2Mock", vaultAddr);
      expect(await v2.version()).to.equal(2n);
      const implAfter = await provider.getStorage(
        vaultAddr,
        "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
      );
      expect(implAfter).to.not.equal(implBefore);
      expect(world.entry("LPStakingVault").implementation.toLowerCase()).to.equal(
        "0x" + implAfter.slice(-40)
      );
      expect(await vault.bonusEscrow()).to.equal(escrowAddr);
      expect(await vault.isStakeOperator(adapterAddr)).to.equal(true);
      expect(await escrow.adapter()).to.equal(adapterAddr);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("the tracked registry", function () {
    it("was never written by any of these runs", function () {
      expect(runner.sha256File(runner.TRACKED_REGISTRY)).to.equal(TRACKED_REGISTRY_SHA256);
    });
  });
});
