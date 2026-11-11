const { expect } = require("chai");

const { checkEpochBounds } = require("../../scripts/lp-epoch");

/**
 * The pure bounds check of `scripts/lp-epoch.js`, with fixed timestamps and no network.
 *
 * `checkEpochBounds` mirrors `LPEpochRegistry._checkBounds`: every refusal names the custom error
 * the contract would revert with. A start later than the previous live epoch's end is accepted
 * by the contract, so it is only a WARNING here: no rewards accrue to users in the gap.
 */
describe("lp-epoch.js checkEpochBounds", function () {
  const iso = (s) => new Date(Number(s) * 1000).toISOString();
  // 1_800_000_000 is a multiple of 900 (2,000,000 intervals).
  const NOW = 1_800_000_000n;
  const HOUR = 3600n;
  const DAY = 86400n;
  // A previous epoch that ends 2 hours after `NOW`: still usable as a start.
  const PREV = { id: 4n, endsAt: NOW + 2n * HOUR };

  it("a start exactly at the previous end: no problems, no warnings", function () {
    const r = checkEpochBounds({ startsAt: PREV.endsAt, endsAt: PREV.endsAt + DAY, now: NOW, prev: PREV });
    expect(r.problems).to.deep.equal([]);
    expect(r.warnings).to.deep.equal([]);
  });

  it("no previous epoch: no gap warning", function () {
    const startsAt = NOW + DAY;
    const r = checkEpochBounds({ startsAt, endsAt: startsAt + DAY, now: NOW, prev: null });
    expect(r.problems).to.deep.equal([]);
    expect(r.warnings).to.deep.equal([]);
  });

  it("a start off the grid names NotOnGrid", function () {
    const startsAt = NOW + DAY + 1n;
    const r = checkEpochBounds({ startsAt, endsAt: NOW + 2n * DAY, now: NOW, prev: null });
    expect(r.problems).to.have.length(1);
    expect(r.problems[0]).to.equal(
      `the start ${iso(startsAt)} is not on the 15-minute grid (900 s). The contract would revert with NotOnGrid.`,
    );
  });

  it("an end off the grid names NotOnGrid", function () {
    const endsAt = NOW + 2n * DAY + 7n;
    const r = checkEpochBounds({ startsAt: NOW + DAY, endsAt, now: NOW, prev: null });
    expect(r.problems).to.have.length(1);
    expect(r.problems[0]).to.equal(
      `the end ${iso(endsAt)} is not on the 15-minute grid (900 s). The contract would revert with NotOnGrid.`,
    );
  });

  it("an end not after the start names InvalidBounds", function () {
    const startsAt = NOW + DAY;
    const r = checkEpochBounds({ startsAt, endsAt: startsAt, now: NOW, prev: null });
    expect(r.problems).to.have.length(1);
    expect(r.problems[0]).to.equal(
      `the end ${iso(startsAt)} is not after the start ${iso(startsAt)}. The contract would revert with InvalidBounds.`,
    );
  });

  it("a start under 30 minutes ahead names StartTooSoon and the earliest start", function () {
    // now is 100 s past a grid point: now + 1800 = grid + 1900, so the earliest start is grid + 2700.
    const now = NOW + 100n;
    const startsAt = NOW + 900n;
    const r = checkEpochBounds({ startsAt, endsAt: startsAt + DAY, now, prev: null });
    expect(r.problems).to.have.length(1);
    expect(r.problems[0]).to.equal(
      `the start ${iso(startsAt)} is less than 30 minutes after chain time ${iso(now)}. ` +
        `The earliest start the contract accepts now is ${iso(NOW + 2700n)}. The contract would revert with StartTooSoon.`,
    );
  });

  it("a start before the previous end names OverlapsPreviousEpoch", function () {
    const startsAt = PREV.endsAt - 900n;
    const r = checkEpochBounds({ startsAt, endsAt: startsAt + DAY, now: NOW, prev: PREV });
    expect(r.problems).to.have.length(1);
    expect(r.problems[0]).to.equal(
      `the start ${iso(startsAt)} is earlier than the end of epoch 4 (${iso(PREV.endsAt)}). ` +
        "The contract would revert with OverlapsPreviousEpoch.",
    );
    expect(r.warnings).to.deep.equal([]);
  });

  it("several problems at once are all listed", function () {
    const startsAt = NOW + 1n; // off grid, too soon, overlaps PREV
    const endsAt = NOW; // on grid, but not after the start
    const r = checkEpochBounds({ startsAt, endsAt, now: NOW, prev: PREV });
    expect(r.problems).to.have.length(4);
    expect(r.problems[0]).to.include("NotOnGrid");
    expect(r.problems[1]).to.include("InvalidBounds");
    expect(r.problems[2]).to.include("StartTooSoon");
    expect(r.problems[3]).to.include("OverlapsPreviousEpoch");
  });

  it("a gap of 900 s: 15 minutes, 1 interval, and the no-gap start", function () {
    const startsAt = PREV.endsAt + 900n;
    const r = checkEpochBounds({ startsAt, endsAt: startsAt + DAY, now: NOW, prev: PREV });
    expect(r.problems).to.deep.equal([]);
    expect(r.warnings).to.have.length(1);
    expect(r.warnings[0]).to.equal(
      `WARNING: GAP of 15 minutes (1 interval of 15 minutes) between the end of epoch 4 (${iso(PREV.endsAt)}) ` +
        `and this start (${iso(startsAt)}).\n` +
        "  No rewards accrue to users in the gap, and they can never be paid later.\n" +
        `  To schedule with no gap, set EPOCH_STARTS_AT=${iso(PREV.endsAt)}.`,
    );
  });

  it("a gap of 1 day: 1 day and 96 intervals", function () {
    const startsAt = PREV.endsAt + DAY;
    const r = checkEpochBounds({ startsAt, endsAt: startsAt + DAY, now: NOW, prev: PREV });
    expect(r.problems).to.deep.equal([]);
    expect(r.warnings).to.have.length(1);
    expect(r.warnings[0]).to.include("GAP of 1 day (96 intervals of 15 minutes)");
    expect(r.warnings[0]).to.include("No rewards accrue to users in the gap");
  });

  it("a compound gap prints every non-zero part", function () {
    const startsAt = PREV.endsAt + DAY + 3n * HOUR + 900n;
    const r = checkEpochBounds({ startsAt, endsAt: startsAt + DAY, now: NOW, prev: PREV });
    expect(r.warnings[0]).to.include("GAP of 1 day 3 hours 15 minutes (109 intervals of 15 minutes)");
  });

  it("a previous end already past: the gap can no longer be avoided", function () {
    const prev = { id: 7n, endsAt: NOW - HOUR };
    const now = NOW + 100n; // earliest = NOW + 2700
    const startsAt = NOW + 2n * HOUR;
    const r = checkEpochBounds({ startsAt, endsAt: startsAt + DAY, now, prev });
    expect(r.problems).to.deep.equal([]);
    expect(r.warnings).to.have.length(1);
    expect(r.warnings[0]).to.include("GAP of 3 hours (12 intervals of 15 minutes)");
    expect(r.warnings[0]).to.include(
      "  The end of epoch 7 is less than 30 minutes ahead or already past, so a gap can no longer be avoided. " +
        `The earliest start the contract accepts now is ${iso(NOW + 2700n)}.`,
    );
    expect(r.warnings[0]).to.not.include("EPOCH_STARTS_AT");
  });
});
