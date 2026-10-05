#!/usr/bin/env node
/**
 * Blocking coverage gate for the five LP-staking contracts plus the guard they share.
 *
 * Reads the lcov file `forge coverage --report lcov` writes and enforces three things:
 *
 *   (a) the MEASUREMENT BASIS is the pinned one. Floors mean nothing if the run that
 *       produced them can be quietly reconfigured — dropping `--ir-minimum` alone moves
 *       every line number in the report — so the npm script passes the basis in through
 *       `LP_COVERAGE_BASIS` and this checker refuses to grade a run it does not recognise.
 *   (b) the DENOMINATORS still match. A file whose measurable line or branch count has moved
 *       is a different file, or was measured a different way; either way its old floor no
 *       longer describes it, and the gate says so rather than grading the new number against
 *       the old bar.
 *   (c) the per-file line and branch FLOORS are met, expressed as a minimum number of
 *       covered entities rather than a percentage so no rounding can creep in.
 *
 * Scope is `contracts/lp-staking/{the five contracts}` + `libraries/TwapGuard.sol`. The mocks,
 * the interfaces and the two legacy staking pools are deliberately out of scope: they are
 * test scaffolding and frozen pre-LP code, and including them would dilute the number in both
 * directions.
 *
 * Usage:
 *   npm run coverage:forge:check                     # measure, then grade (the CI form)
 *   node scripts/check-coverage.mjs [lcov.info]      # grade an lcov already on disk
 *   node scripts/check-coverage.mjs --config-check   # basis only, no lcov needed
 *
 * Exit 0 = pass. Exit 1 = at least one violation; ALL of them are listed, not just the first.
 */

import fs from "node:fs";
import path from "node:path";
import {pathToFileURL} from "node:url";

// ── Pinned measurement basis ────────────────────────────────────────────────────────────────
//
// `forge coverage` cannot run under the optimizer, and without `--ir-minimum` the un-optimized
// build fails outright with "Stack too deep" in `WeightedStakingPool.sol`. `--ir-minimum` is
// therefore not a tuning knob but the only way this repo measures at all — and it is also what
// costs the ten uncovered lines named below. Changing this string is a deliberate
// re-ratification of the floors, not a configuration tweak.
//
// The `forge-1.7` half names the TOOLCHAIN, and it is a real dependency: a newer forge
// attributes `--ir-minimum` coverage differently (it moved the former reward token's line
// denominator from 42 to 43). `.github/workflows/ci.yml` therefore pins the toolchain to `v1.7.1` rather than
// `stable`. Bump the pin and this string together, never one alone.
export const PINNED_BASIS = "forge-1.7-ir-minimum";

// ── Pinned floors, re-measured 2026-10-05 (Wednesday launch: tracks M / P / R / U) ──────────
//
// | file                     | lines             | branches        |
// |--------------------------|-------------------|-----------------|
// | LPStakingVault.sol       |  97.91% (187/191) | 100.00% (34/34) |
// | LPZapper.sol             |  96.08% (98/102)  | 100.00% (20/20) |
// | RewardsDistributor.sol   |  97.54% (119/122) | 100.00% (18/18) |
// | LPEpochRegistry.sol      |  96.46% (109/113) | 100.00% (21/21) |
// | TokenOverture.sol        |  84.62% (22/26)   | 100.00% (2/2)   |
// | libraries/TwapGuard.sol  |  97.67% (42/43)   | 100.00% (7/7)   |
//
// Branch coverage is 100% on all six, so every branch floor is the ceiling: one newly uncovered
// branch fails the gate. Measured on 546 Foundry tests in 28 suites.
//
// The 2026-10-05 round moved every denominator except TwapGuard's:
//
//   * RewardsDistributor (lines 103 -> 122, branches 15 -> 18) is a rewrite: v1 pays any number
//     of pre-funded reward tokens against one `RewardClaim` voucher (`claim(token, …)`, the
//     seven-gate check order ending in `InsufficientFunds`), with `addRewardToken`,
//     `setRewardTokenEnabled`, `setClaimsEnabled`, `recoverExcess(token, amount)` and the
//     token-list views; the immutables and the two-leg functions are gone.
//   * TokenOverture.sol replaces the former reward token (47 lines, 7 branches): a UUPS token
//     with a minter and no cap, 26 lines and 2 branches.
//   * LPEpochRegistry.sol is new: 113 lines, 21 branches.
//   * The vault (lines 171 -> 191, branches 28 -> 34): the bonus-escrow link (`setBonusEscrow`
//     with its code check, the `bonusEscrow()` view, the init announcement), the fail-open
//     `onUnstake` notification with its gas floor, the fail-closed `onRebalance` notification
//     and the old-position snapshot.
//   * The zapper (lines 79 -> 102, branches 17 -> 20) became a UUPS proxy: `initialize`, the
//     namespaced storage accessor, the `operator` tier (`onlyOperator`, `setOperator`,
//     `operator()`), `_authorizeUpgrade`.
//
// The twenty uncovered LINES are all an `--ir-minimum` line attribution artefact rather than a
// gap. Each is a call site, an assembly body, an empty OZ initializer or a jump whose effect is
// asserted by a test that passes in the same run; the inlined site simply loses its mapping:
//
//   * the ERC-7201 accessor bodies `$.slot := …` — `LPStakingVault.sol:207`,
//     `LPZapper.sol:147`, `RewardsDistributor.sol:147`, `LPEpochRegistry.sol:93`,
//     `TokenOverture.sol:82`, `libraries/TwapGuard.sol:126`; every getter reaches them and each
//     file's `test_Storage_*` test reads the pinned slot directly.
//   * `_disableInitializers();` in each implementation constructor — `LPStakingVault.sol:396`,
//     `LPZapper.sol:257`, `RewardsDistributor.sol:194`, `LPEpochRegistry.sol:112`,
//     `TokenOverture.sol:90`; each `test_Constructor_DisablesTheImplementationsInitializers`
//     proves it ran.
//   * the empty OpenZeppelin initializers — `__Ownable2Step_init();` at
//     `LPStakingVault.sol:427`, `LPZapper.sol:276`, `RewardsDistributor.sol:217`,
//     `LPEpochRegistry.sol:120`, `TokenOverture.sol:108`, and `__ERC20Burnable_init();` at
//     `TokenOverture.sol:105` — kept because the upgrades plugin validates the parent-initializer
//     chain.
//   * `_checkTwapDeviation();` — `LPStakingVault.sol:1003`, `LPZapper.sol:545`.
//   * `break;` in the token scan of `setEpochAmount` — `LPEpochRegistry.sol:186`; executed by
//     `test_SetEpochAmount_ChangesALiveNotStartedEpochAndAnnouncesIt` and
//     `test_SetEpochAmount_AppendsANewTokenExactlyOnce`, both arms of its `if` are covered.
//
// They are named here, and in `docs/lp-staking-audit-notes.md`, instead of being chased with
// contrived tests that could not move them.
export const PER_FILE_FLOORS = {
  "contracts/lp-staking/LPStakingVault.sol": {
    lines: {found: 191, minHit: 187},
    branches: {found: 34, minHit: 34},
  },
  "contracts/lp-staking/LPZapper.sol": {
    lines: {found: 102, minHit: 98},
    branches: {found: 20, minHit: 20},
  },
  "contracts/lp-staking/RewardsDistributor.sol": {
    lines: {found: 122, minHit: 119},
    branches: {found: 18, minHit: 18},
  },
  "contracts/lp-staking/LPEpochRegistry.sol": {
    lines: {found: 113, minHit: 109},
    branches: {found: 21, minHit: 21},
  },
  "contracts/lp-staking/TokenOverture.sol": {
    lines: {found: 26, minHit: 22},
    branches: {found: 2, minHit: 2},
  },
  "contracts/lp-staking/libraries/TwapGuard.sol": {
    lines: {found: 43, minHit: 42},
    branches: {found: 7, minHit: 7},
  },
};

// ── lcov parsing ────────────────────────────────────────────────────────────────────────────

/** Repo-relative POSIX form, so a Windows-produced lcov compares equal to a Linux one. */
const normalizePath = (p) => p.trim().replace(/\\/g, "/").replace(/^\.\//, "");

/**
 * Parse lcov into per-file records.
 *
 * Totals are recomputed from the raw `DA:` / `BRDA:` entries and the `LF` / `LH` / `BRF` /
 * `BRH` summary lines are ignored: those lines are optional in the format, so a truncated or
 * hand-edited writer that omitted them would otherwise read as a perfect score.
 *
 * @returns {Map<string, {lines:{found:number,hit:number}, branches:{found:number,hit:number}}>}
 */
export function parseLcov(text) {
  const records = new Map();
  let current = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line.startsWith("SF:")) {
      const file = normalizePath(line.slice(3));
      // One file may legitimately carry several records (one per contract in the file);
      // merge them rather than letting the last one win.
      current = records.get(file);
      if (!current) {
        current = {lines: {found: 0, hit: 0}, branches: {found: 0, hit: 0}};
        records.set(file, current);
      }
      continue;
    }
    if (!current) continue;

    if (line.startsWith("DA:")) {
      // DA:<line>,<hits>
      const hits = Number(line.slice(3).split(",")[1]);
      current.lines.found += 1;
      if (Number.isFinite(hits) && hits > 0) current.lines.hit += 1;
    } else if (line.startsWith("BRDA:")) {
      // BRDA:<line>,<block>,<branch>,<taken>  — `taken` is "-" when the block was never entered
      const taken = line.slice(5).split(",")[3];
      current.branches.found += 1;
      if (taken !== undefined && taken !== "-" && Number(taken) > 0) current.branches.hit += 1;
    } else if (line === "end_of_record") {
      current = null;
    }
  }
  return records;
}

const pct = (hit, found) => (found === 0 ? 100 : (hit / found) * 100);
const fmt = (n) => n.toFixed(2);

// ── checks ──────────────────────────────────────────────────────────────────────────────────

/**
 * The basis this checker will grade. Anything else is refused outright, because the floors
 * below only describe a run taken the pinned way.
 * @returns {string[]} violation messages (empty = pass)
 */
export function checkBasis(env) {
  const actual = env.LP_COVERAGE_BASIS;
  if (actual === undefined || actual === "") {
    return [
      `basis: LP_COVERAGE_BASIS is not set. Run \`npm run coverage:forge:check\`, which sets it to ` +
        `"${PINNED_BASIS}" and measures the way the floors were measured.`,
    ];
  }
  if (actual !== PINNED_BASIS) {
    return [
      `basis: LP_COVERAGE_BASIS is "${actual}" but the floors were measured under "${PINNED_BASIS}" — ` +
        `the numbers are not comparable. Re-measure and re-ratify the floors, or restore the basis.`,
    ];
  }
  return [];
}

/**
 * Per-file denominators and floors.
 * @returns {string[]} violation messages (empty = pass)
 */
export function checkFloors(records) {
  const violations = [];

  for (const [file, floors] of Object.entries(PER_FILE_FLOORS)) {
    const record = records.get(file);

    // A MISSING record is a violation, never a skip: a renamed, moved or excluded file must
    // not be able to drop its own floor silently.
    if (!record) {
      violations.push(
        `missing: ${file} has no lcov record — it was renamed, moved or excluded from the run, ` +
          `so its floor cannot be enforced`
      );
      continue;
    }

    for (const kind of ["lines", "branches"]) {
      const pinned = floors[kind];
      const measured = record[kind];

      if (measured.found !== pinned.found) {
        violations.push(
          `${file}: ${kind} denominator moved — the run measured ${measured.found} where the pinned ` +
            `basis has ${pinned.found}. The floor no longer describes this file; re-measure and re-ratify.`
        );
        continue;
      }
      if (measured.hit < pinned.minHit) {
        violations.push(
          `${file}: ${kind} coverage ${fmt(pct(measured.hit, measured.found))}% ` +
            `(${measured.hit}/${measured.found}) is below the floor ` +
            `${fmt(pct(pinned.minHit, pinned.found))}% (${pinned.minHit}/${pinned.found})`
        );
      }
    }
  }

  return violations;
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────

function main(argv, env) {
  const args = argv.slice(2);
  const configOnly = args.includes("--config-check");
  const positional = args.filter((a) => !a.startsWith("--"));

  const violations = checkBasis(env);

  if (!configOnly) {
    if (positional.length > 1) {
      console.error("usage: node scripts/check-coverage.mjs [lcov-file] | --config-check");
      return 1;
    }
    const lcovPath = path.resolve(positional[0] ?? "lcov.info");
    if (!fs.existsSync(lcovPath)) {
      console.error(
        `coverage gate FAILED: no lcov file at ${lcovPath}. ` +
          `Run \`npm run coverage:forge:check\`, which measures first.`
      );
      return 1;
    }
    violations.push(...checkFloors(parseLcov(fs.readFileSync(lcovPath, "utf8"))));
  }

  if (violations.length > 0) {
    console.error(`coverage gate FAILED — ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  - ${v}`);
    return 1;
  }

  console.log(
    configOnly
      ? `coverage config OK: the pinned measurement basis "${PINNED_BASIS}" is intact`
      : `coverage gate PASSED: basis "${PINNED_BASIS}" intact; all ${Object.keys(PER_FILE_FLOORS).length} ` +
        `LP-staking files meet their line and branch floors`
  );
  return 0;
}

// Only run as a CLI when invoked directly; the tests import the pure functions.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv, process.env));
}
