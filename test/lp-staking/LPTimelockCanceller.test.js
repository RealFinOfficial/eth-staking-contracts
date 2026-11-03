const { expect } = require("chai");
const { ethers } = require("hardhat");

const lpTimelock = require("../../scripts/lp-timelock");

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
      await run(ape, { TIMELOCK_ACTION: "cancel", TIMELOCK_ID: during });
      expect(await timelock.isOperation(during), "cancelled by the term canceller").to.equal(false);

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

      await run(multisig, { TIMELOCK_ACTION: "cancel", TIMELOCK_ID: after });
      expect(await timelock.isOperation(after), "REAL cancels anything pending").to.equal(false);

      const gone = await run(multisig, { TIMELOCK_ACTION: "cancel", TIMELOCK_ID: after });
      expect(gone).to.include("is not pending");
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
});
