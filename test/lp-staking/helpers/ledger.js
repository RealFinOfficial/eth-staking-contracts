/**
 * The run's own record of what it did: one entry per step, in the order the steps ran.
 *
 * The scenario tests write into it; the block-progression and log-retrieval tests read it
 * back. That split is what lets the last two assert against the whole run — "every event
 * the scenario produced is retrievable from the chain, in this exact order" — instead of
 * re-deriving expectations from the same prose that produced the steps.
 */

class Ledger {
  constructor() {
    /** @type {Array<object>} */
    this.entries = [];
  }

  /**
   * Records a mined transaction.
   *
   * @param {string} step Step id, e.g. "A3".
   * @param {string} label What the step did, for failure messages.
   * @param {object} receipt Ethers transaction receipt.
   * @param {Array<{address: string, name: string}>} expected Events the step must have
   *   produced, in the order they appear in the receipt. Addresses are stored lowercase.
   */
  record(step, label, receipt, expected = []) {
    const entry = {
      kind: "tx",
      step,
      label,
      blockNumber: Number(receipt.blockNumber),
      blockHash: receipt.blockHash,
      txHash: receipt.hash,
      gasUsed: receipt.gasUsed,
      expected: expected.map((e) => ({
        address: e.address.toLowerCase(),
        name: e.name,
      })),
      logCount: receipt.logs.length,
    };
    this.entries.push(entry);
    return entry;
  }

  /** Records a block that carries no transaction of ours (an explicit `evm_mine`). */
  recordBlock(step, label, blockNumber) {
    const entry = {
      kind: "block",
      step,
      label,
      blockNumber: Number(blockNumber),
      expected: [],
    };
    this.entries.push(entry);
    return entry;
  }

  /** Records a call that reverted, so the progression test can assert it mined nothing. */
  recordRevert(step, label, headBefore, errorName) {
    const entry = {
      kind: "revert",
      step,
      label,
      blockNumber: Number(headBefore),
      errorName,
      expected: [],
    };
    this.entries.push(entry);
    return entry;
  }

  get transactions() {
    return this.entries.filter((e) => e.kind === "tx");
  }

  get reverts() {
    return this.entries.filter((e) => e.kind === "revert");
  }

  byStep(step) {
    const found = this.entries.filter((e) => e.step === step);
    if (found.length === 0) throw new Error(`no ledger entry for step ${step}`);
    return found;
  }

  /** The single transaction entry of a step; throws when the step recorded several. */
  txOf(step) {
    const found = this.byStep(step).filter((e) => e.kind === "tx");
    if (found.length !== 1) {
      throw new Error(`step ${step} recorded ${found.length} transactions, expected 1`);
    }
    return found[0];
  }

  /** Every expected event from an address, flattened in step order. */
  expectedFrom(address) {
    const wanted = address.toLowerCase();
    const out = [];
    for (const entry of this.entries) {
      for (const expected of entry.expected) {
        if (expected.address === wanted) {
          out.push({ step: entry.step, blockNumber: entry.blockNumber, name: expected.name });
        }
      }
    }
    return out;
  }

  get firstBlock() {
    const blocks = this.entries.filter((e) => e.kind !== "revert").map((e) => e.blockNumber);
    return Math.min(...blocks);
  }

  get lastBlock() {
    const blocks = this.entries.filter((e) => e.kind !== "revert").map((e) => e.blockNumber);
    return Math.max(...blocks);
  }
}

module.exports = { Ledger };
