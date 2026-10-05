const fs = require("fs");
const path = require("path");

const { expect } = require("chai");
const ethers = require("ethers");

const runner = require("./helpers/scripts");
const lpTimelock = require("../../scripts/lp-timelock");
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

    it("refuses a campaign range off the pool's tick grid", async function () {
      await refused(
        { LP_APEBOND_TICK_LOWER: "-1201", LP_APEBOND_TICK_UPPER: "1200" },
        /is not a range a position on this pool can have \(tick spacing 60/
      );
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

    it("wired the adapter's callers and campaign, then handed it to the timelock", async function () {
      expect(await adapter.owner()).to.equal(timelockAddr);
      expect(await adapter.guardian()).to.equal(w.guardian.address);
      for (const caller of [w.soulZapCaller.address, w.signer2.address]) {
        expect(await adapter.soulZapCallers(caller)).to.equal(true);
        expect(await adapter.campaignCallers(CAMPAIGN_ID, caller)).to.equal(true);
      }
      const c = await adapter.campaigns(CAMPAIGN_ID);
      expect([
        c.enabled,
        c.tickLower,
        c.tickUpper,
        c.bonusCliffSeconds,
        c.bonusBps,
        c.minBonusAmount,
      ]).to.deep.equal([true, -1200n, 1200n, 300n, 1000n, 10n ** 18n]);
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
          "owner",
          "positionManager",
          "soulZapCallers",
          "tickSpacing",
          "token0",
          "token1",
          "vault",
        ].sort()
      );
      expect(a.owner).to.equal(timelockAddr);
      expect(a.tickSpacing).to.equal(60);
      expect(a.soulZapCallers).to.deep.equal([w.soulZapCaller.address, w.signer2.address]);
      expect(a.campaigns).to.deep.equal([
        {
          id: CAMPAIGN_ID,
          label: "deploy-suite-campaign",
          enabled: true,
          tickLower: -1200,
          tickUpper: 1200,
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
      expect(filed).to.deep.equal([
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
      expect(await timelock.isOperationDone(batch.id)).to.equal(true);
      expect(run.stdout).to.match(/waiting: \d+s of CHAIN time left/);
      // schedule + execute, and nothing else
      expect((await nonceOf(w.deployer.address)) - nonceBefore).to.equal(2);
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

    it("swapped the rights in ONE batch: new on, old off, escrow re-pointed — in that order", async function () {
      const calls = [
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
