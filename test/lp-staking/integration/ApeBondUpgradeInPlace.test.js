const fs = require("fs");
const path = require("path");

const { expect } = require("chai");
const ethers = require("ethers");

const chain = require("../helpers/chain");
const runner = require("../helpers/scripts");
const lpTimelock = require("../../../scripts/lp-timelock");
const { CHAIN_ID, FEE, campaignEnv, startWorld, withTimePump } = require("../helpers/apebondWorld");

/**
 * Activating the ApeBond route on a LIVE stack — the mainnet sequence, rehearsed end to end.
 *
 * ── What this is ──────────────────────────────────────────────────────────────────────
 *
 * Mainnet launches on 7 Oct 2026 with lane 1's vault: the bonus-escrow hooks are in it, the
 * escrow link is zero, and there is NO stake-operator allowlist. When ApeBond goes live, that
 * vault has to be upgraded IN PLACE — it already holds staked positions — and the escrow and the
 * adapter put beside it, all through the timelock. `scripts/deploy-apebond.js` is the one command
 * that does it, and this suite runs it, unmodified, as a child process against exactly that shape:
 *
 *   1. `deploy-lp-staking.js` with LP_VAULT_CONTRACT=LPStakingVaultLane1Mock — a verbatim copy of
 *      lane 1's vault — so the proxy runs the mainnet code and `.openzeppelin` records ITS layout;
 *   2. one position staked before anything ApeBond-shaped exists;
 *   3. `deploy-apebond.js`: a new vault implementation (hardhat-upgrades validates lane 1's layout
 *      → the current one, `stakeOperators` appended after `bonusEscrow`), the escrow, the adapter,
 *      its callers and campaign, and ONE batch — upgradeToAndCall, setBonusEscrow,
 *      setStakeOperator, setAdapter — waited out in chain time and executed;
 *   4. purchases through a MockSoulZapCaller, and what the B.3 decision document changed:
 *      INVERTED from the signature era, a buyer who unstakes the moment the purchase lands is NOT
 *      paid — the vault reports the exit and the escrow forfeits the bonus (D1, P2). A buyer who
 *      stays past the cliff is paid, once the company funds the escrow (reserve now, fund later);
 *   5. the adapter replaced (B.3 §5.5) on the live stack, and a final read-only `verify`.
 *
 * It replaces the signature-era dry-run against Sepolia test stack #5, which is abandoned. It needs
 * no endpoint: the world is a plain spawned `hardhat node` with the repo's mock market, so it runs
 * in every `npx hardhat test`. The tracked `deployments.json` is never written.
 */

const TRACKED_REGISTRY_SHA256 = runner.sha256File(runner.TRACKED_REGISTRY);
const ERC1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const CLIFF_SECONDS = 600;
const CAMPAIGN = campaignEnv({ id: "live-activation-campaign", cliffSeconds: CLIFF_SECONDS });
const CAMPAIGN_ID = ethers.id("live-activation-campaign");

describe("ApeBond activated on a live, mainnet-shaped stack (lane-1 vault)", function () {
  this.timeout(20 * 60 * 1000);

  let world, w, provider;
  let vaultAddr, timelockAddr, distributorAddr, escrowAddr, adapterAddr, callerAddr;
  let vault, escrow, adapter, timelock, asset, nfpm;
  let stakedTokenId, implBefore, distributorImplBefore;
  let activation;

  const implementationOf = async (proxy) =>
    ethers.getAddress("0x" + (await provider.getStorage(proxy, ERC1967_IMPLEMENTATION_SLOT)).slice(-40));
  const apebondEnv = (extra = {}) => world.baseEnv({ LP_APEBOND_WAIT_POLL_MS: "100", ...extra });
  const readRecord = () =>
    JSON.parse(fs.readFileSync(path.join(world.scratchDir, `apebond-rehearsal-${CHAIN_ID}.json`), "utf8"));

  /** One purchase through the rehearsal's MockSoulZapCaller; returns the new token id. */
  async function buyFor(beneficiary) {
    await world.runOk(
      "apebond-rehearsal.js",
      world.baseEnv({ LP_REHEARSAL_PHASE: "deposit", LP_REHEARSAL_BENEFICIARY: beneficiary })
    );
    return BigInt(readRecord().purchases.at(-1).tokenId);
  }

  before(async function () {
    world = await startWorld("lp-apebond-live");
    ({ w, provider } = world);
    asset = world.asset;
    nfpm = world.nfpm;

    // 1. the mainnet-shaped stack
    await world.runOk(
      "deploy-lp-staking.js",
      world.coreEnv({ LP_TIMELOCK_MIN_DELAY: "60", LP_VAULT_CONTRACT: "LPStakingVaultLane1Mock" })
    );
    vaultAddr = world.entry("LPStakingVault").address;
    timelockAddr = world.entry("TimelockController").address;
    distributorAddr = world.entry("RewardsDistributor").address;
    vault = await world.contractAt("LPStakingVault", vaultAddr);
    timelock = await world.contractAt("LPTimelock", timelockAddr);
    implBefore = await implementationOf(vaultAddr);
    distributorImplBefore = await implementationOf(distributorAddr);

    // 2. a position staked before ApeBond exists
    await chain.send(
      nfpm
        .connect(w.deployer)
        .mintFake(
          w.alice.address,
          world.token0Addr,
          world.token1Addr,
          FEE,
          -600,
          600,
          10n ** 6n,
          10n ** 18n,
          10n ** 18n
        )
    );
    stakedTokenId = await nfpm.lastMintedId();
    await chain.send(nfpm.connect(w.alice).approve(vaultAddr, stakedTokenId));
    await chain.send(vault.connect(w.alice).stake(stakedTokenId));

    // the rehearsal's router stand-in, deployed before the route so the activation allowlists it
    await world.runOk("apebond-rehearsal.js", world.baseEnv({ LP_REHEARSAL_PHASE: "caller" }));
    callerAddr = readRecord().caller;

    // 3. the activation
    activation = await withTimePump(provider, () =>
      world.runOk(
        "deploy-apebond.js",
        apebondEnv({
          LP_APEBOND_BONUS_TOKEN: world.assetAddr,
          LP_APEBOND_SOULZAP_CALLERS: callerAddr,
          LP_APEBOND_ASSERT_POSITIONS: String(stakedTokenId),
          ...CAMPAIGN,
        })
      )
    );
    escrowAddr = world.entry("BonusEscrow").address;
    adapterAddr = world.entry("ApeBondPositionAdapter").address;
    escrow = await world.contractAt("BonusEscrow", escrowAddr);
    adapter = await world.contractAt("ApeBondPositionAdapter", adapterAddr);
  });

  after(async function () {
    if (world) await world.stop();
  });

  // ─────────────────────────────────────────────────────────────
  describe("0. the live stack before the activation", function () {
    it("ran lane 1's vault: hooks present, escrow link zero, NO stake-operator allowlist", async function () {
      const lane1 = await world.contractAt("LPStakingVaultLane1Mock", implBefore);
      expect(lane1.interface.getFunction("setBonusEscrow")).to.not.equal(null);
      expect(lane1.interface.getFunction("setStakeOperator")).to.equal(null);
      expect(activation.stdout).to.include("The live vault implementation does NOT have the ApeBond route");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("1. deploy-apebond.js — the in-place activation", function () {
    it("deployed a new vault implementation and validated the layout against lane 1's", async function () {
      expect(activation.stdout).to.include("phase 2: a new LPStakingVault implementation");
      const implAfter = await implementationOf(vaultAddr);
      expect(implAfter).to.not.equal(implBefore);
      expect(world.entry("LPStakingVault").implementation).to.equal(implAfter);
      expect(world.entry("LPStakingVault")).to.not.have.property("pendingImplementation");
    });

    it("ran ONE batch: upgrade, link the escrow, allowlist the adapter, open the escrow — in that order", async function () {
      const batch = lpTimelock.buildBatch([
        { target: vaultAddr, fn: "upgradeToAndCall", args: [await implementationOf(vaultAddr), "0x"] },
        { target: vaultAddr, fn: "setBonusEscrow", args: [escrowAddr] },
        { target: vaultAddr, fn: "setStakeOperator", args: [adapterAddr, "true"] },
        { target: escrowAddr, fn: "setAdapter", args: [adapterAddr] },
      ]);
      expect(activation.stdout).to.include(`id:          ${batch.id}`);
      expect(await timelock.isOperationDone(batch.id)).to.equal(true);
      const filed = JSON.parse(
        fs.readFileSync(path.join(world.scratchDir, "apebond-activate-batch.json"), "utf8")
      );
      expect(filed.map((call) => call.fn)).to.deep.equal([
        "upgradeToAndCall",
        "setBonusEscrow",
        "setStakeOperator",
        "setAdapter",
      ]);
    });

    it("linked the pair, and its MANDATORY checks passed", async function () {
      expect(await vault.bonusEscrow()).to.equal(escrowAddr);
      expect(await escrow.vault()).to.equal(vaultAddr);
      expect(await vault.isStakeOperator(adapterAddr)).to.equal(true);
      expect(await escrow.adapter()).to.equal(adapterAddr);
      expect(await escrow.owner()).to.equal(timelockAddr);
      expect(await adapter.owner()).to.equal(timelockAddr);
      expect(await adapter.campaignCallers(CAMPAIGN_ID, callerAddr)).to.equal(true);
      expect(activation.stdout).to.include(
        "OK    LPStakingVault.bonusEscrow (MANDATORY: a wrong link fails open)"
      );
      expect(activation.stdout).to.include("All post-activation verification checks passed.");
      expect(activation.stdout).to.not.include("FAIL");
    });

    it("moved no field of the live vault's state, the staked position included", async function () {
      expect(activation.stdout).to.include(
        `OK    LPStakingVault.stakerOf(${stakedTokenId}): ${w.alice.address}`
      );
      expect(await vault.stakerOf(stakedTokenId)).to.equal(w.alice.address);
      expect(await nfpm.ownerOf(stakedTokenId)).to.equal(vaultAddr);
      expect(await vault.owner()).to.equal(timelockAddr);
      expect(await vault.guardian()).to.equal(w.guardian.address);
      expect(await vault.operator()).to.equal(w.operator.address);
      expect(await implementationOf(distributorAddr)).to.equal(distributorImplBefore);
    });

    it("lets the position staked before the activation exit, with nothing to forfeit", async function () {
      await chain.send(vault.connect(w.alice).unstake(stakedTokenId));
      expect(await nfpm.ownerOf(stakedTokenId)).to.equal(w.alice.address);
      const [beneficiary] = await escrow.reservationOf(stakedTokenId);
      expect(beneficiary).to.equal(ethers.ZeroAddress);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("2. a buyer who unstakes the moment the purchase lands is NOT paid (inverted)", function () {
    let tokenId, bonus;

    before(async function () {
      tokenId = await buyFor(w.bob.address);
      [, bonus] = await escrow.reservationOf(tokenId);
    });

    it("reserved a bonus for the buyer with an empty escrow", async function () {
      expect(bonus).to.be.greaterThan(0n);
      expect(await vault.stakerOf(tokenId)).to.equal(w.bob.address);
      expect(await asset.balanceOf(escrowAddr)).to.equal(0n);
    });

    it("forfeits the bonus on the immediate exit — the vault reports it, the escrow acts", async function () {
      const reserved = await escrow.totalReserved();
      const receipt = await chain.send(vault.connect(w.bob).unstake(tokenId));
      const forfeited = receipt.logs
        .filter((log) => log.address === escrowAddr)
        .map((log) => escrow.interface.parseLog(log))
        .find((event) => event && event.name === "BonusForfeited");
      expect(forfeited.args.tokenId).to.equal(tokenId);
      expect(forfeited.args.beneficiary).to.equal(w.bob.address);
      expect(forfeited.args.amount).to.equal(bonus);
      expect(await escrow.totalReserved()).to.equal(reserved - bonus);
      expect(await nfpm.ownerOf(tokenId)).to.equal(w.bob.address);
    });

    it("refuses the claim after the cliff even with the escrow funded", async function () {
      await world.runOk("fund-escrow.js", world.baseEnv({ LP_APEBOND_FUND_AMOUNT: "1000000" }));
      await world.advance(CLIFF_SECONDS + 1);
      const { args } = await chain.expectCustomError(
        provider,
        escrow.connect(w.bob).claim(tokenId),
        escrow.interface,
        "Forfeited"
      );
      expect(args[0]).to.equal(tokenId);
    });

    it("forfeits the same-transaction loop as well (rehearsal phase loop)", async function () {
      const result = await world.runOk("apebond-rehearsal.js", world.baseEnv({ LP_REHEARSAL_PHASE: "loop" }));
      const loop = readRecord().purchases.at(-1);
      expect(result.stdout).to.include(`OK: BonusForfeited(${loop.tokenId}`);
      const [, amount, , , forfeited] = await escrow.reservationOf(BigInt(loop.tokenId));
      expect(amount).to.equal(0n);
      expect(forfeited).to.equal(true);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("3. a buyer who stays past the cliff is paid once the escrow is funded", function () {
    let tokenId, bonus;

    before(async function () {
      // Drain the surplus the previous block left, so this one starts on an empty escrow.
      const surplus = (await asset.balanceOf(escrowAddr)) - (await escrow.totalReserved());
      if (surplus > 0n) {
        const op = lpTimelock.buildOperation({
          target: escrowAddr,
          fn: "recoverSurplus",
          args: [w.operator.address],
        });
        await chain.send(
          timelock.connect(w.deployer).schedule(op.target, op.value, op.data, op.predecessor, op.salt, 60)
        );
        await world.advance(61);
        await chain.send(
          timelock.connect(w.deployer).execute(op.target, op.value, op.data, op.predecessor, op.salt)
        );
      }
      tokenId = await buyFor(w.carol.address);
      [, bonus] = await escrow.reservationOf(tokenId);
    });

    it("reverts the claim with InsufficientFunds until the escrow holds the whole amount", async function () {
      await world.advance(CLIFF_SECONDS + 1);
      const balance = await asset.balanceOf(escrowAddr);
      expect(balance < bonus).to.equal(true);
      const { args } = await chain.expectCustomError(
        provider,
        escrow.connect(w.dave).claim(tokenId),
        escrow.interface,
        "InsufficientFunds"
      );
      expect([args[0], args[1]]).to.deep.equal([bonus, balance]);
    });

    it("pays exactly the bonus to the buyer after fund-escrow.js covers what is owed", async function () {
      await world.runOk("fund-escrow.js", world.baseEnv({ LP_APEBOND_FUND_TARGET: "0" }));
      const before = await asset.balanceOf(w.carol.address);
      // Anyone may trigger it; only the recorded beneficiary is paid.
      await chain.send(escrow.connect(w.dave).claim(tokenId));
      expect((await asset.balanceOf(w.carol.address)) - before).to.equal(bonus);
      const [, , , claimed] = await escrow.reservationOf(tokenId);
      expect(claimed).to.equal(true);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("4. the adapter replaced on the live stack (B.3 §5.5)", function () {
    let oldAdapter, newAdapter;

    before(async function () {
      oldAdapter = adapterAddr;
      await withTimePump(provider, () =>
        world.runOk(
          "deploy-apebond.js",
          apebondEnv({
            LP_APEBOND_MODE: "replace-adapter",
            LP_APEBOND_SOULZAP_CALLERS: callerAddr,
            ...CAMPAIGN,
          })
        )
      );
      newAdapter = world.entry("ApeBondPositionAdapter").address;
    });

    it("moved the deposit right and the reserve right to the new adapter in one operation", async function () {
      expect(newAdapter).to.not.equal(oldAdapter);
      expect(await vault.isStakeOperator(newAdapter)).to.equal(true);
      expect(await vault.isStakeOperator(oldAdapter)).to.equal(false);
      expect(await escrow.adapter()).to.equal(newAdapter);
      expect(world.entry("ApeBondPositionAdapter").previousAdapter).to.equal(oldAdapter);
    });

    it("buys through the new adapter, and the old one is shut", async function () {
      const tokenId = await buyFor(w.alice.address);
      const deposited = readRecord().purchases.at(-1);
      expect(deposited.depositTx).to.be.a("string");
      const receipt = await provider.getTransactionReceipt(deposited.depositTx);
      expect(receipt.logs.some((log) => log.address === newAdapter)).to.equal(true);
      const [beneficiary] = await escrow.reservationOf(tokenId);
      expect(beneficiary).to.equal(w.alice.address);

      // The old adapter's deposit reaches the vault, which no longer lets it stake.
      const old = await world.contractAt("ApeBondPositionAdapter", oldAdapter);
      const caller = await world.contractAt("MockSoulZapCaller", callerAddr, w.deployer);
      await chain.send(
        nfpm
          .connect(w.deployer)
          .mintFake(
            callerAddr,
            world.token0Addr,
            world.token1Addr,
            FEE,
            -1200,
            1200,
            10n ** 24n,
            10n ** 18n,
            10n ** 18n
          )
      );
      const stray = await nfpm.lastMintedId();
      const { args } = await chain.expectCustomError(
        provider,
        caller.deposit(oldAdapter, world.nfpmAddr, stray, CAMPAIGN_ID, w.alice.address),
        vault.interface,
        "NotZapper"
      );
      expect(args[0]).to.equal(oldAdapter);
      expect(await old.escrow()).to.equal(escrowAddr);
    });

    it("passes the read-only verify on the final state", async function () {
      const result = await world.runOk("deploy-apebond.js", apebondEnv({ LP_APEBOND_MODE: "verify" }));
      expect(result.stdout).to.include("All verification checks passed.");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("5. the repository is exactly as it was", function () {
    it("left the tracked deployments.json byte-identical", function () {
      expect(runner.sha256File(runner.TRACKED_REGISTRY)).to.equal(TRACKED_REGISTRY_SHA256);
    });
  });
});
