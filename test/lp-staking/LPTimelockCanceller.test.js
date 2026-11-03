const { expect } = require("chai");
const { ethers } = require("hardhat");

const lpTimelock = require("../../scripts/lp-timelock");
const lpSwitch = require("../../scripts/lp-switch-timelock");
const { scanLogs } = require("../../scripts/lib/logs");

/**
 * The CANCELLER half of `scripts/lp-timelock.js`, run end to end against a real `LPTimelock` this
 * suite deploys itself.
 *
 * `LPTimelock` lets REAL's Safe appoint a second canceller (ApeBonds' Safe) for a term written on
 * chain. The appointment is two steps: REAL's Safe offers the role through a call of the timelock
 * on itself (scheduled, then executed after `minDelay`), and the offered address accepts it inside
 * a seven day window, naming the offered term. The script drives every step:
 *
 *   offer-canceller   schedules `offerCancellerRole(CANCELLER_ADDRESS, CANCELLER_TERM_DAYS)` on the
 *                     timelock itself, and executes it when the same command runs after the delay;
 *   withdraw-offer    the same flow for `withdrawCancellerOffer(CANCELLER_ADDRESS)`;
 *   revoke-canceller  the same flow for `revokeRole(CANCELLER_ROLE, CANCELLER_ADDRESS)`;
 *   accept-canceller  sends `acceptCancellerRole(CANCELLER_TERM_DAYS)` when the signer is the
 *                     appointee, and prints the calldata for the appointee's Safe otherwise;
 *   cancellers        prints every canceller and every offer;
 *   cancel            checks `canCancel(signer, id)` first and prints the reason instead of
 *                     sending a transaction that would revert.
 *
 * The script's `main()` runs in this process, on the Hardhat network, with its inputs in
 * environment variables exactly as an operator sets them. The signer is chosen through
 * `LP_DEPLOYER_IMPERSONATE`, which `scripts/lib/pools.js` honours on chain 31337 only: `multisig`
 * stands for REAL's Safe (the only proposer and executor), `ape` for ApeBonds' Safe and `other`
 * for an address that holds no role. Time moves with `evm_increaseTime`.
 */
describe("lp-timelock.js — the canceller actions", function () {
  let deployer, multisig, ape, other;
  let timelock, timelockAddr;

  const MIN_DELAY = 60n;
  const DAY = 86_400;
  const ENV_KEYS = [
    "TIMELOCK_ACTION",
    "TIMELOCK_ADDRESS",
    "TIMELOCK_ID",
    "TIMELOCK_SALT_TAG",
    "TIMELOCK_DELAY",
    "CANCELLER_ADDRESS",
    "CANCELLER_TERM_DAYS",
    "LP_DEPLOYER_IMPERSONATE",
    "CONFIRM",
    "TIMELOCK_TARGET_ADDRESS",
    "TIMELOCK_FN",
    "TIMELOCK_ARGS",
    "CONFIRM_REVOKE_PERMANENT",
  ];

  /**
   * Runs the CLI in this process as `signer` with `env`, and returns everything it printed.
   * The environment is restored afterwards, so one run never leaks into the next.
   */
  async function run(signer, env) {
    const saved = {};
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    Object.assign(process.env, {
      TIMELOCK_ADDRESS: timelockAddr,
      LP_DEPLOYER_IMPERSONATE: signer.address,
      ...env,
    });
    const lines = [];
    const log = console.log;
    console.log = (...parts) => lines.push(parts.join(" "));
    try {
      await lpTimelock.main();
    } finally {
      console.log = log;
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
    return lines.join("\n");
  }

  async function increase(seconds) {
    await ethers.provider.send("evm_increaseTime", [Number(seconds)]);
    await ethers.provider.send("evm_mine", []);
  }

  const now = async () => BigInt((await ethers.provider.getBlock("latest")).timestamp);
  const nonceOf = (address) => ethers.provider.getTransactionCount(address);

  /** The operation the self-call actions build, rebuilt here from the documented operands. */
  const selfCall = (fn, args) => lpTimelock.buildOperation({ target: timelockAddr, fn, args });

  const offerEnv = (account, termDays) => ({
    TIMELOCK_ACTION: "offer-canceller",
    CANCELLER_ADDRESS: account.address,
    CANCELLER_TERM_DAYS: String(termDays),
  });

  /** Offer (schedule, wait, execute) and accept, all through the script. */
  async function appoint(account, termDays) {
    await run(multisig, offerEnv(account, termDays));
    await increase(MIN_DELAY);
    await run(multisig, offerEnv(account, termDays));
    await run(account, { TIMELOCK_ACTION: "accept-canceller", CANCELLER_TERM_DAYS: String(termDays) });
    return timelock.cancellerTermEnd(account.address);
  }

  /** A harmless operation scheduled directly by REAL's Safe; returns its id. */
  async function scheduleNoop(salt, delay = MIN_DELAY) {
    const saltHash = ethers.id(salt);
    await (await timelock.connect(multisig).schedule(other.address, 0, "0x", ethers.ZeroHash, saltHash, delay)).wait();
    return timelock.hashOperation(other.address, 0, "0x", ethers.ZeroHash, saltHash);
  }

  beforeEach(async function () {
    [deployer, multisig, ape, other] = await ethers.getSigners();
    const Timelock = await ethers.getContractFactory("LPTimelock");
    timelock = await Timelock.deploy(MIN_DELAY, [multisig.address], [multisig.address], ethers.ZeroAddress);
    timelockAddr = await timelock.getAddress();
  });

  // ─────────────────────────────────────────────────────────────
  describe("offer-canceller", function () {
    it("schedules the self-call, reports it pending, then executes it into an offer", async function () {
      const op = selfCall("offerCancellerRole", [ape.address, "180"]);

      const scheduled = await run(multisig, offerEnv(ape, 180));
      expect(scheduled).to.include(`offerCancellerRole(${ape.address}, 180) on ${timelockAddr}`);
      expect(scheduled).to.include(`id:          ${op.id}`);
      expect(scheduled).to.include(`schedule calldata: ${lpTimelock.encodeSchedule(op, MIN_DELAY)}`);
      expect(await timelock.isOperationPending(op.id)).to.equal(true);
      expect(await timelock.scheduledAt(op.id)).to.equal(await now());

      const nonce = await nonceOf(multisig.address);
      const early = await run(multisig, offerEnv(ape, 180));
      expect(early).to.include("state:   PENDING");
      expect(early).to.include("Not ready yet");
      expect(await nonceOf(multisig.address), "nothing sent while pending").to.equal(nonce);

      const listed = await run(multisig, { TIMELOCK_ACTION: "pending" });
      expect(listed).to.include(`offerCancellerRole(${ape.address}, 180)`);

      await increase(MIN_DELAY);
      const executed = await run(multisig, offerEnv(ape, 180));
      expect(executed).to.include(`execute calldata:  ${lpTimelock.encodeExecute(op)}`);
      expect(await timelock.isOperationDone(op.id)).to.equal(true);
      const offer = await timelock.cancellerOffer(ape.address);
      expect(offer.termDays).to.equal(180n);
      expect(offer.expiresAt).to.equal((await now()) + 7n * BigInt(DAY));
      expect(await timelock.hasRole(lpTimelock.CANCELLER_ROLE, ape.address)).to.equal(false);

      const again = await run(multisig, offerEnv(ape, 180));
      expect(again).to.include("state:   DONE");
      expect(again).to.include("TIMELOCK_SALT_TAG");
    });

    it("prints the Safe transaction for the proposer and sends nothing from another signer", async function () {
      const op = selfCall("offerCancellerRole", [ape.address, "180"]);
      const nonce = await nonceOf(other.address);

      const out = await run(other, offerEnv(ape, 180));

      expect(out).to.include(`Safe transaction for the proposer (LPTimelock.schedule)`);
      expect(out).to.include(`to:    ${timelockAddr}`);
      expect(out).to.include(`data:  ${lpTimelock.encodeSchedule(op, MIN_DELAY)}`);
      expect(await nonceOf(other.address)).to.equal(nonce);
      expect(await timelock.isOperation(op.id)).to.equal(false);
    });

    it("refuses what the contract would refuse after the delay, before anything is sent", async function () {
      const nonce = await nonceOf(multisig.address);
      await expect(run(multisig, offerEnv(ape, 0))).to.be.rejectedWith(/CANCELLER_TERM_DAYS 0 is outside 1\.\.180/);
      await expect(run(multisig, offerEnv(ape, 181))).to.be.rejectedWith(/CANCELLER_TERM_DAYS 181 is outside 1\.\.180/);
      await expect(
        run(multisig, { ...offerEnv(ape, 180), CANCELLER_ADDRESS: ethers.ZeroAddress })
      ).to.be.rejectedWith(/zero address/);
      await expect(
        run(multisig, { ...offerEnv(ape, 180), CANCELLER_ADDRESS: timelockAddr })
      ).to.be.rejectedWith(/the timelock itself/);
      await expect(run(multisig, offerEnv(multisig, 180))).to.be.rejectedWith(/permanent canceller/);
      await expect(run(multisig, { TIMELOCK_ACTION: "offer-canceller", CANCELLER_ADDRESS: ape.address })).to.be.rejectedWith(
        /Set CANCELLER_TERM_DAYS/
      );
      await expect(run(multisig, { TIMELOCK_ACTION: "offer-canceller", CANCELLER_TERM_DAYS: "180" })).to.be.rejectedWith(
        /Set CANCELLER_ADDRESS/
      );
      expect(await nonceOf(multisig.address)).to.equal(nonce);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("accept-canceller", function () {
    it("sends the acceptance from the appointee and writes the term end", async function () {
      await run(multisig, offerEnv(ape, 180));
      await increase(MIN_DELAY);
      await run(multisig, offerEnv(ape, 180));

      const out = await run(ape, { TIMELOCK_ACTION: "accept-canceller", CANCELLER_TERM_DAYS: "180" });

      const termEnd = (await now()) + 180n * BigInt(DAY);
      expect(await timelock.hasRole(lpTimelock.CANCELLER_ROLE, ape.address)).to.equal(true);
      expect(await timelock.cancellerTermEnd(ape.address)).to.equal(termEnd);
      expect(out).to.include(`term end:             ${termEnd}`);
      expect((await timelock.cancellerOffer(ape.address)).expiresAt).to.equal(0n);
    });

    it("prints the calldata for the appointee's Safe when the signer is someone else", async function () {
      await run(multisig, offerEnv(ape, 180));
      await increase(MIN_DELAY);
      await run(multisig, offerEnv(ape, 180));
      const nonce = await nonceOf(multisig.address);

      const out = await run(multisig, {
        TIMELOCK_ACTION: "accept-canceller",
        CANCELLER_ADDRESS: ape.address,
        CANCELLER_TERM_DAYS: "180",
      });

      const data = lpTimelock.TIMELOCK_INTERFACE.encodeFunctionData("acceptCancellerRole", [180]);
      expect(out).to.include(`Safe transaction for the appointee ${ape.address} (LPTimelock.acceptCancellerRole)`);
      expect(out).to.include(`to:    ${timelockAddr}`);
      expect(out).to.include(`data:  ${data}`);
      expect(await nonceOf(multisig.address)).to.equal(nonce);
      expect(await timelock.hasRole(lpTimelock.CANCELLER_ROLE, ape.address)).to.equal(false);

      // The printed calldata is the acceptance: sent from the appointee it grants the role.
      await (await ape.sendTransaction({ to: timelockAddr, data })).wait();
      expect(await timelock.hasRole(lpTimelock.CANCELLER_ROLE, ape.address)).to.equal(true);
    });

    it("explains a missing offer, a wrong term and an expired offer instead of reverting", async function () {
      const nonce = await nonceOf(ape.address);
      const accept = (term) => run(ape, { TIMELOCK_ACTION: "accept-canceller", CANCELLER_TERM_DAYS: String(term) });

      expect(await accept(180)).to.include("has no offer");

      await run(multisig, offerEnv(ape, 180));
      await increase(MIN_DELAY);
      await run(multisig, offerEnv(ape, 180));
      expect(await accept(90)).to.include("the offer is for 180 days, not 90");

      await increase(7 * DAY);
      expect(await accept(180)).to.include("the offer expired");

      expect(await nonceOf(ape.address), "nothing was sent").to.equal(nonce);
      expect(await timelock.hasRole(lpTimelock.CANCELLER_ROLE, ape.address)).to.equal(false);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("cancellers", function () {
    it("lists the permanent canceller, a term canceller and an open offer", async function () {
      const termEnd = await appoint(ape, 180);
      await run(multisig, offerEnv(other, 30));
      await increase(MIN_DELAY);
      await run(multisig, offerEnv(other, 30));
      const offer = await timelock.cancellerOffer(other.address);

      const out = await run(deployer, { TIMELOCK_ACTION: "cancellers" });

      // This timelock is in no registry: the scan starts at block 0, says so, and still finds all three.
      expect(out).to.include(`WARNING: no deploy block recorded for ${timelockAddr.toLowerCase()}`);
      expect(out).to.include("3 canceller address(es) since block 0");

      const block = (address) => out.split(`Canceller ${address}`)[1].split("Canceller ")[0];
      expect(block(multisig.address)).to.include("holds CANCELLER_ROLE: yes");
      expect(block(multisig.address)).to.include("term end:             0 (permanent, no term)");
      expect(block(multisig.address)).to.include("isCancellerActive:    yes");
      expect(block(multisig.address)).to.include("pending offer:        none");

      expect(block(ape.address)).to.include("holds CANCELLER_ROLE: yes");
      expect(block(ape.address)).to.include(`term end:             ${termEnd}`);
      expect(block(ape.address)).to.include("isCancellerActive:    yes");

      expect(block(other.address)).to.include("holds CANCELLER_ROLE: no");
      expect(block(other.address)).to.include("isCancellerActive:    no");
      expect(block(other.address)).to.include(`pending offer:        30 days, expiresAt ${offer.expiresAt}`);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("cancel", function () {
    it("cancels inside the rule, explains a refusal, and prints the Safe calldata for a non-holder", async function () {
      const termEnd = await appoint(ape, 1);

      const during = await scheduleNoop("during");
      const byApe = await run(ape, { TIMELOCK_ACTION: "cancel", TIMELOCK_ID: during });
      expect(await timelock.isOperation(during), "cancelled by the term canceller").to.equal(false);
      expect(byApe).to.include(`cancelled by ${ape.address}`);
      const [apeEvent] = await timelock.queryFilter(timelock.filters.OperationCancelled(during));
      expect(apeEvent.args.canceller, "the receipt names the term canceller").to.equal(ape.address);

      await increase(DAY);
      const after = await scheduleNoop("after");
      expect(await timelock.scheduledAt(after)).to.be.greaterThanOrEqual(termEnd);

      const nonce = await nonceOf(ape.address);
      const refused = await run(ape, { TIMELOCK_ACTION: "cancel", TIMELOCK_ID: after });
      expect(refused).to.include(`at or after the signer's term end ${termEnd}`);
      expect(refused).to.include("CancellerTermEnded");
      expect(await nonceOf(ape.address), "nothing sent").to.equal(nonce);
      expect(await timelock.isOperationPending(after)).to.equal(true);

      const printed = await run(other, { TIMELOCK_ACTION: "cancel", TIMELOCK_ID: after });
      expect(printed).to.include("Safe transaction for the canceller (LPTimelock.cancel)");
      expect(printed).to.include(`data:  ${lpTimelock.encodeCancel(after)}`);

      const byReal = await run(multisig, { TIMELOCK_ACTION: "cancel", TIMELOCK_ID: after });
      expect(await timelock.isOperation(after), "REAL cancels anything pending").to.equal(false);
      expect(byReal).to.include(`cancelled by ${multisig.address}`);
      const [realEvent] = await timelock.queryFilter(timelock.filters.OperationCancelled(after));
      expect(realEvent.args.canceller, "the receipt names REAL's Safe").to.equal(multisig.address);

      const gone = await run(multisig, { TIMELOCK_ACTION: "cancel", TIMELOCK_ID: after });
      expect(gone).to.include("is not pending");
    });

    it("prints no Safe transaction for an operation that is no longer pending, whoever the signer is", async function () {
      const id = await scheduleNoop("executed");
      await increase(MIN_DELAY);
      await (await timelock.connect(multisig).execute(other.address, 0, "0x", ethers.ZeroHash, ethers.id("executed"))).wait();

      const out = await run(other, { TIMELOCK_ACTION: "cancel", TIMELOCK_ID: id });

      expect(out).to.include(`Operation ${id} is not pending (never scheduled, cancelled or executed): nothing to cancel.`);
      expect(out).to.not.include("Safe transaction");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("revoke-canceller and withdraw-offer", function () {
    it("refuses to execute a revocation inside the term and executes it after the term", async function () {
      const termEnd = await appoint(ape, 1);
      const revokeEnv = { TIMELOCK_ACTION: "revoke-canceller", CANCELLER_ADDRESS: ape.address };
      const op = selfCall("revokeRole", [lpTimelock.CANCELLER_ROLE, ape.address]);

      await run(multisig, revokeEnv);
      expect(await timelock.isOperationPending(op.id)).to.equal(true);
      await increase(MIN_DELAY);

      const nonce = await nonceOf(multisig.address);
      const early = await run(multisig, revokeEnv);
      expect(early).to.include(`term of ${ape.address} is active until ${termEnd}`);
      expect(early).to.include("CancellerTermActive");
      expect(await nonceOf(multisig.address)).to.equal(nonce);
      expect(await timelock.hasRole(lpTimelock.CANCELLER_ROLE, ape.address)).to.equal(true);

      await increase(DAY);
      await run(multisig, revokeEnv);
      expect(await timelock.isOperationDone(op.id)).to.equal(true);
      expect(await timelock.hasRole(lpTimelock.CANCELLER_ROLE, ape.address)).to.equal(false);
      expect(await timelock.cancellerTermEnd(ape.address)).to.equal(0n);
    });

    it("says the appointee CAN cancel a revocation scheduled just before its term end and ready after it", async function () {
      const termEnd = await appoint(ape, 1);
      // Scheduled 30 s before the term end, ready 60 s later, so ready AFTER the term end. The
      // contract compares the schedule time with the term end, so the appointee keeps its veto.
      await increase(termEnd - (await now()) - 30n);
      const revokeEnv = { TIMELOCK_ACTION: "revoke-canceller", CANCELLER_ADDRESS: ape.address };
      const op = selfCall("revokeRole", [lpTimelock.CANCELLER_ROLE, ape.address]);

      const scheduled = await run(multisig, revokeEnv);
      expect(scheduled).to.include("scheduled DURING the term, so the appointee can cancel it");
      expect(await timelock.getTimestamp(op.id)).to.be.greaterThan(termEnd);
      expect(await timelock.scheduledAt(op.id)).to.be.lessThan(termEnd);

      await increase(MIN_DELAY);
      await run(ape, { TIMELOCK_ACTION: "cancel", TIMELOCK_ID: op.id });
      expect(await timelock.isOperation(op.id), "the appointee cancelled it after its term end").to.equal(false);
    });

    it("says the appointee cannot cancel a revocation scheduled after its term end", async function () {
      await appoint(ape, 1);
      await increase(DAY);
      const out = await run(multisig, { TIMELOCK_ACTION: "revoke-canceller", CANCELLER_ADDRESS: ape.address });
      expect(out).to.include("scheduled after the term end, so the appointee cannot cancel it");
    });

    it("sends no revocation for an address that no longer holds the role", async function () {
      await appoint(ape, 1);
      const revokeEnv = { TIMELOCK_ACTION: "revoke-canceller", CANCELLER_ADDRESS: ape.address };
      const op = selfCall("revokeRole", [lpTimelock.CANCELLER_ROLE, ape.address]);
      await run(multisig, revokeEnv);
      await (await timelock.connect(ape).renounceRole(lpTimelock.CANCELLER_ROLE, ape.address)).wait();
      await increase(MIN_DELAY);

      const nonce = await nonceOf(multisig.address);
      const out = await run(multisig, revokeEnv);
      expect(out).to.include(`${ape.address} holds no canceller role: nothing to revoke`);
      expect(await nonceOf(multisig.address)).to.equal(nonce);
      expect(await timelock.isOperationReady(op.id), "left ready, not executed").to.equal(true);
    });

    it("refuses to revoke a permanent canceller, the zero address or the timelock before scheduling", async function () {
      const nonce = await nonceOf(multisig.address);
      const revoke = (address) => run(multisig, { TIMELOCK_ACTION: "revoke-canceller", CANCELLER_ADDRESS: address });
      await expect(revoke(multisig.address)).to.be.rejectedWith(
        /is a permanent canceller .*no permanent canceller can ever be granted again without a timelock switch.*CONFIRM_REVOKE_PERMANENT=1/
      );
      await expect(revoke(ethers.ZeroAddress)).to.be.rejectedWith(/zero address: there is no canceller to revoke/);
      await expect(revoke(timelockAddr)).to.be.rejectedWith(/the timelock itself: there is no canceller to revoke/);
      expect(await nonceOf(multisig.address)).to.equal(nonce);
      const op = selfCall("revokeRole", [lpTimelock.CANCELLER_ROLE, multisig.address]);
      expect(await timelock.isOperation(op.id)).to.equal(false);
    });

    it("refuses a hand-built revokeRole of the permanent canceller on the generic schedule path too", async function () {
      const env = {
        TIMELOCK_ACTION: "schedule",
        TIMELOCK_TARGET_ADDRESS: timelockAddr,
        TIMELOCK_FN: "revokeRole",
        TIMELOCK_ARGS: `${lpTimelock.CANCELLER_ROLE},${multisig.address}`,
      };
      const nonce = await nonceOf(multisig.address);
      await expect(run(multisig, env)).to.be.rejectedWith(/is a permanent canceller .*CONFIRM_REVOKE_PERMANENT=1/);
      expect(await nonceOf(multisig.address)).to.equal(nonce);

      // The override lets the deliberate revocation through, and the contract allows it.
      await run(multisig, { ...env, CONFIRM_REVOKE_PERMANENT: "1" });
      await increase(MIN_DELAY);
      await run(multisig, { ...env, TIMELOCK_ACTION: "execute", CONFIRM_REVOKE_PERMANENT: "1" });
      expect(await timelock.hasRole(lpTimelock.CANCELLER_ROLE, multisig.address)).to.equal(false);
    });

    it("revokes the permanent canceller through revoke-canceller only with the override", async function () {
      const env = { TIMELOCK_ACTION: "revoke-canceller", CANCELLER_ADDRESS: multisig.address, CONFIRM_REVOKE_PERMANENT: "1" };
      const scheduled = await run(multisig, env);
      expect(scheduled).to.include("CONFIRM_REVOKE_PERMANENT=1: the revocation of the permanent canceller");
      await increase(MIN_DELAY);
      await expect(run(multisig, { ...env, CONFIRM_REVOKE_PERMANENT: "" })).to.be.rejectedWith(
        /is a permanent canceller/
      );
      await run(multisig, env);
      expect(await timelock.hasRole(lpTimelock.CANCELLER_ROLE, multisig.address)).to.equal(false);
    });

    it("schedules no revocation for an address that holds no canceller role", async function () {
      const nonce = await nonceOf(multisig.address);
      const out = await run(multisig, { TIMELOCK_ACTION: "revoke-canceller", CANCELLER_ADDRESS: other.address });
      expect(out).to.include(`${other.address} holds no canceller role: nothing to schedule.`);
      expect(await nonceOf(multisig.address)).to.equal(nonce);
      const op = selfCall("revokeRole", [lpTimelock.CANCELLER_ROLE, other.address]);
      expect(await timelock.isOperation(op.id)).to.equal(false);
    });

    it("refuses to schedule or execute a withdrawal of an expired offer", async function () {
      const withdrawEnv = { TIMELOCK_ACTION: "withdraw-offer", CANCELLER_ADDRESS: ape.address };
      const withdrawOp = selfCall("withdrawCancellerOffer", [ape.address]);
      await run(multisig, offerEnv(ape, 180));
      await increase(MIN_DELAY);
      await run(multisig, offerEnv(ape, 180));
      const { expiresAt } = await timelock.cancellerOffer(ape.address);

      // Scheduled while a withdrawal could still execute in time, then left until the offer expired:
      // the execute is refused, and the command that cancels the pending withdrawal is printed.
      await increase(7 * DAY - 120);
      await run(multisig, withdrawEnv);
      expect(await timelock.isOperationPending(withdrawOp.id)).to.equal(true);
      await increase(MIN_DELAY + 120n);
      const nonce = await nonceOf(multisig.address);
      const atExecute = await run(multisig, withdrawEnv);
      expect(atExecute).to.include(`The offer expired at ${expiresAt}`);
      expect(atExecute).to.include("withdrawing it changes nothing. Nothing sent.");
      expect(atExecute).to.include(`TIMELOCK_ACTION=cancel TIMELOCK_ID=${withdrawOp.id}`);
      expect(await nonceOf(multisig.address)).to.equal(nonce);

      // A fresh withdrawal of the expired offer is not even scheduled.
      const atSchedule = await run(multisig, { ...withdrawEnv, TIMELOCK_SALT_TAG: "again" });
      expect(atSchedule).to.include("withdrawing it changes nothing. Nothing scheduled.");
      expect(await nonceOf(multisig.address)).to.equal(nonce);
    });

    it("refuses to schedule a withdrawal that could only execute after the offer expires", async function () {
      const withdrawOp = selfCall("withdrawCancellerOffer", [ape.address]);
      await run(multisig, offerEnv(ape, 180));
      await increase(MIN_DELAY);
      await run(multisig, offerEnv(ape, 180));
      await increase(7 * DAY - 30);

      const nonce = await nonceOf(multisig.address);
      const out = await run(multisig, { TIMELOCK_ACTION: "withdraw-offer", CANCELLER_ADDRESS: ape.address });
      expect(out).to.include("before a withdrawal could execute: let it lapse. Nothing scheduled.");
      expect(await nonceOf(multisig.address)).to.equal(nonce);
      expect(await timelock.isOperation(withdrawOp.id)).to.equal(false);
    });

    it("names a pending offer inside a batch with its call count, and ignores the selector on another target", async function () {
      const withdrawEnv = { TIMELOCK_ACTION: "withdraw-offer", CANCELLER_ADDRESS: ape.address };
      const offerData = timelock.interface.encodeFunctionData("offerCancellerRole", [ape.address, 180]);

      // The same calldata aimed at another address is not an offer.
      await (await timelock.connect(multisig).schedule(other.address, 0, offerData, ethers.ZeroHash, ethers.id("foreign"), MIN_DELAY)).wait();
      expect(await run(multisig, withdrawEnv)).to.include("there is nothing to withdraw");

      const targets = [timelockAddr, other.address];
      const payloads = [offerData, "0x"];
      const salt = ethers.id("offer-batch");
      await (await timelock.connect(multisig).scheduleBatch(targets, [0, 0], payloads, ethers.ZeroHash, salt, MIN_DELAY)).wait();
      const id = await timelock.hashOperationBatch(targets, [0, 0], payloads, ethers.ZeroHash, salt);

      const out = await run(multisig, withdrawEnv);
      expect(out).to.include(`Its offer operation ${id} is still pending. It is a batch of 2 calls: cancelling it drops all 2.`);
      expect(out).to.match(/scanned to block \d+ of \d+ \(\d+ CallScheduled log\(s\)\)/);
      expect(out.match(/Its offer operation/g)).to.have.length(1);
    });

    it("points a withdrawal of a still-pending offer at cancel, and schedules nothing", async function () {
      const offerOp = selfCall("offerCancellerRole", [ape.address, "180"]);
      const withdrawEnv = { TIMELOCK_ACTION: "withdraw-offer", CANCELLER_ADDRESS: ape.address };
      const withdrawOp = selfCall("withdrawCancellerOffer", [ape.address]);

      const none = await run(multisig, withdrawEnv);
      expect(none).to.include("there is nothing to withdraw");

      await run(multisig, offerEnv(ape, 180));
      const nonce = await nonceOf(multisig.address);
      const out = await run(multisig, withdrawEnv);
      expect(out).to.include(`${ape.address} has no executed offer`);
      expect(out).to.include(`Its offer operation ${offerOp.id} is still pending`);
      expect(out).to.include(`TIMELOCK_ACTION=cancel TIMELOCK_ID=${offerOp.id}`);
      expect(await nonceOf(multisig.address)).to.equal(nonce);
      expect(await timelock.isOperation(withdrawOp.id)).to.equal(false);
    });

    it("withdraws an executed offer through the same schedule and execute flow", async function () {
      await run(multisig, offerEnv(ape, 180));
      await increase(MIN_DELAY);
      await run(multisig, offerEnv(ape, 180));
      const withdrawEnv = { TIMELOCK_ACTION: "withdraw-offer", CANCELLER_ADDRESS: ape.address };
      const op = selfCall("withdrawCancellerOffer", [ape.address]);

      const scheduled = await run(multisig, withdrawEnv);
      expect(scheduled).to.include(`withdrawCancellerOffer(${ape.address}) on ${timelockAddr}`);
      await increase(MIN_DELAY);
      await run(multisig, withdrawEnv);

      expect(await timelock.isOperationDone(op.id)).to.equal(true);
      expect((await timelock.cancellerOffer(ape.address)).expiresAt).to.equal(0n);
      const out = await run(ape, { TIMELOCK_ACTION: "accept-canceller", CANCELLER_TERM_DAYS: "180" });
      expect(out).to.include("has no offer");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("grantRole through the timelock (a rotated Safe)", function () {
    const grantEnv = (step, role, account) => ({
      TIMELOCK_ACTION: step,
      TIMELOCK_TARGET_ADDRESS: timelockAddr,
      TIMELOCK_FN: "grantRole",
      TIMELOCK_ARGS: `${role},${account}`,
    });

    it("schedules and executes grantRole(PROPOSER_ROLE, x)", async function () {
      const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
      await run(multisig, grantEnv("schedule", PROPOSER_ROLE, other.address));
      await increase(MIN_DELAY);
      await run(multisig, grantEnv("execute", PROPOSER_ROLE, other.address));
      expect(await timelock.hasRole(PROPOSER_ROLE, other.address)).to.equal(true);
    });

    it("refuses grantRole(CANCELLER_ROLE, x) before anything is scheduled", async function () {
      const nonce = await nonceOf(multisig.address);
      await expect(
        run(multisig, grantEnv("schedule", lpTimelock.CANCELLER_ROLE, other.address))
      ).to.be.rejectedWith(/CancellerGrantOnlyByAcceptance.*offer-canceller/);
      expect(await nonceOf(multisig.address)).to.equal(nonce);
    });

    it("refuses grantRole(DEFAULT_ADMIN_ROLE, x), naming the only-the-timelock invariant", async function () {
      const nonce = await nonceOf(multisig.address);
      await expect(
        run(multisig, grantEnv("schedule", ethers.ZeroHash, other.address))
      ).to.be.rejectedWith(/timelock must stay the ONLY holder of DEFAULT_ADMIN_ROLE/);
      expect(await nonceOf(multisig.address)).to.equal(nonce);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("lp-switch-timelock.js: record, then check", function () {
    function recorder() {
      const calls = { recorded: [], removed: 0 };
      return {
        calls,
        record: (address, info) => calls.recorded.push({ address, info }),
        remove: () => (calls.removed += 1),
      };
    }
    const quiet = async (fn) => {
      const log = console.log;
      console.log = () => {};
      try {
        return await fn();
      } finally {
        console.log = log;
      }
    };

    it("keeps a timelock that passes, recorded once", async function () {
      const r = recorder();
      await quiet(() =>
        lpSwitch.recordCheckedTimelock({
          address: timelockAddr, info: {}, multisig: multisig.address, deployer: deployer.address,
          provider: ethers.provider, record: r.record, remove: r.remove,
        })
      );
      expect(r.calls.recorded).to.have.length(1);
      expect(r.calls.removed).to.equal(0);
    });

    it("removes the entry on a genuine shape failure and says Not recorded", async function () {
      const r = recorder();
      // Checked against the wrong multisig: CANCELLER_ROLE[multisig] reads false.
      await expect(
        quiet(() =>
          lpSwitch.recordCheckedTimelock({
            address: timelockAddr, info: {}, multisig: other.address, deployer: deployer.address,
            provider: ethers.provider, record: r.record, remove: r.remove,
          })
        )
      ).to.be.rejectedWith(new RegExp(`${timelockAddr} failed its role checks: .*CANCELLER_ROLE\\[multisig\\].*Not recorded`));
      expect(r.calls.recorded).to.have.length(1);
      expect(r.calls.removed).to.equal(1);
    });

    it("keeps the entry when the checks cannot run, and names SWITCH_ACTION=check", async function () {
      const r = recorder();
      // No contract at this address: the first read throws, which is not a verdict.
      await expect(
        quiet(() =>
          lpSwitch.recordCheckedTimelock({
            address: other.address, info: {}, multisig: multisig.address, deployer: deployer.address,
            provider: ethers.provider, record: r.record, remove: r.remove,
          })
        )
      ).to.be.rejectedWith(/is deployed and recorded .*Re-run them with SWITCH_ACTION=check\. A second deploy is refused while this entry exists\./);
      expect(r.calls.recorded).to.have.length(1);
      expect(r.calls.removed).to.equal(0);
    });

    describe("SWITCH_ACTION=check (checkAction), report-only", function () {
      const old = () => ({ proposers: [multisig.address] });
      const next = (proposer, extra = {}) => ({
        address: timelockAddr,
        proposers: [proposer],
        deployer: deployer.address,
        ...extra,
      });
      const check = (nextEntry, env = {}, fallbackDeployer = async () => deployer.address) =>
        quiet(() => lpSwitch.checkAction({ next: nextEntry, old: old(), env, provider: ethers.provider, fallbackDeployer }));

      it("checks against the recorded proposer and deployer, and passes", async function () {
        let asked = 0;
        await check(next(multisig.address), {}, async () => (asked += 1, deployer.address));
        expect(asked, "the recorded deployer is used, not the signer").to.equal(0);
      });

      it("refuses to run when LP_MULTISIG disagrees with the recorded proposer, printing both", async function () {
        await expect(check(next(multisig.address), { LP_MULTISIG: other.address })).to.be.rejectedWith(
          new RegExp(`LP_MULTISIG ${other.address} disagrees .* ${multisig.address}\\. Nothing checked`)
        );
      });

      it("reports a genuine failure and keeps the entry: it has no way to remove it", async function () {
        await expect(check(next(other.address))).to.be.rejectedWith(
          /failed its role checks: .*The registry entry is kept \(check is report-only\)\./
        );
      });

      it("falls back to the signer only for an entry without a recorded deployer", async function () {
        let asked = 0;
        await check(next(multisig.address, { deployer: undefined }), {}, async () => (asked += 1, deployer.address));
        expect(asked).to.equal(1);
      });
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("scripts/lib/logs.js scanLogs", function () {
    it("coerces string block numbers once, so the chunks stay chunks", async function () {
      await scheduleNoop("logs-a");
      await scheduleNoop("logs-b");
      const latest = await ethers.provider.getBlockNumber();
      const topic = timelock.interface.getEvent("CallScheduled").topicHash;
      const chunks = [];
      const logs = await scanLogs(ethers.provider, {
        address: timelockAddr,
        topics: [topic],
        fromBlock: "0",
        toBlock: String(latest),
        chunk: "2",
        onChunk: ({ start, end }) => chunks.push([start, end]),
      });
      expect(logs).to.have.length(2);
      expect(chunks[0]).to.deep.equal([0, 1]);
      expect(chunks).to.have.length(Math.ceil((latest + 1) / 2));
    });

    it("refuses a non-finite bound and a chunk below one block", async function () {
      const base = { address: timelockAddr, topics: [], fromBlock: 0, toBlock: 10 };
      await expect(scanLogs(ethers.provider, { ...base, fromBlock: "abc" })).to.be.rejectedWith(
        /fromBlock must be a finite number of blocks — got abc/
      );
      await expect(scanLogs(ethers.provider, { ...base, toBlock: undefined })).to.be.rejectedWith(/toBlock must be a finite/);
      await expect(scanLogs(ethers.provider, { ...base, chunk: 0 })).to.be.rejectedWith(/chunk must be at least 1 block — got 0/);
    });
  });
});
