#!/usr/bin/env node
/**
 * Blocking coverage gate for the four LP-staking contracts plus the guard they share.
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
 * Scope is `contracts/lp-staking/{the four contracts}` + `libraries/TwapGuard.sol`. The mocks,
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
// costs the three uncovered lines named below. Changing this string is a deliberate
// re-ratification of the floors, not a configuration tweak.
//
// The `forge-1.7` half names the TOOLCHAIN, and it is a real dependency: a newer forge
// attributes `--ir-minimum` coverage differently (it moved TokenX's line denominator from 42
// to 43). `.github/workflows/ci.yml` therefore pins the toolchain to `v1.7.1` rather than
// `stable`. Bump the pin and this string together, never one alone.
export const PINNED_BASIS = "forge-1.7-ir-minimum";

// ── Pinned floors, re-measured 2026-08-26 (LPStakingVault behind a UUPS proxy) ─────────────
//
// | file                    | lines            | branches        |
// |-------------------------|------------------|-----------------|
// | LPStakingVault.sol      |  97.26% (142/146)| 100.00% (24/24) |
// | LPZapper.sol            |  98.67% (74/75)  | 100.00% (15/15) |
// | RewardsDistributor.sol  |  96.34% (79/82)  | 100.00% (13/13) |
// | TokenX.sol              |  97.62% (41/42)  | 100.00% (7/7)   |
// | libraries/TwapGuard.sol |  97.67% (42/43)  | 100.00% (7/7)   |
//
// Branch coverage is 100% on all five, so every branch floor is the ceiling: one newly
// uncovered branch fails the gate. The vault's branch count moved 21 -> 24 with the guardian
// tier: both arms of `onlyGuardian`, the `setGuardian` zero check and the `initialize`
// guardian check are each asserted, and `renounceOwnership` reverts for the owner while a
// stranger still gets the Ownable rejection.
//
// The vault's line denominator moved 109 -> 146 because the proxy split its state into an
// ERC-7201 struct behind five getters, added `initialize`, `setGuardian`, `_authorizeUpgrade`
// and the renounce override, and gave every storage read an explicit `$` handle. TwapGuard
// moved 37 -> 43 for the same reason (a namespace, its accessor and two getters), and the
// zapper 74 -> 75 for the `_setTwapParams` call its constructor now makes itself.
//
// The seven uncovered LINES are all an `--ir-minimum` line attribution artefact rather than a
// gap. Each is a call site or an assembly body whose callee reports 100% coverage in the same
// run, so all seven are demonstrably executed; the inlined site simply loses its own mapping:
//
//   * `contracts/lp-staking/LPStakingVault.sol:147`     `$.slot := LP_STAKING_VAULT_STORAGE`
//     — every getter and every stake reaches it; `test_Storage_LivesAtThePinnedErc7201Slot`
//     reads the resulting slot directly.
//   * `contracts/lp-staking/LPStakingVault.sol:274`     `_disableInitializers();` — asserted by
//     `test_Constructor_DisablesTheImplementationsInitializers`, which proves it ran.
//   * `contracts/lp-staking/LPStakingVault.sol:294`     `__Ownable2Step_init();` — an empty OZ
//     initializer, kept because the upgrades plugin validates the parent-initializer chain.
//   * `contracts/lp-staking/LPStakingVault.sol:751`     `_checkTwapDeviation();`
//   * `contracts/lp-staking/LPZapper.sol:396`           `_checkTwapDeviation();`
//   * `contracts/lp-staking/libraries/TwapGuard.sol:127` `$.slot := TWAP_GUARD_STORAGE`
//     — read by `twapWindow()` on both inheritors;
//     `test_Storage_TheTwapGuardHasItsOwnPinnedNamespace` reads the slot directly.
//   * `contracts/lp-staking/TokenX.sol:155`             `_rollPendingEpoch();`
//   * `contracts/lp-staking/RewardsDistributor.sol:160` `$.slot := REWARDS_DISTRIBUTOR_STORAGE`
//   * `contracts/lp-staking/RewardsDistributor.sol:206` `_disableInitializers();`
//   * `contracts/lp-staking/RewardsDistributor.sol:217` `__Ownable2Step_init();`
//
// They are named here, and in `docs/lp-staking-audit-notes.md`, instead of being chased with
// contrived tests that could not move them.
export const PER_FILE_FLOORS = {
  "contracts/lp-staking/LPStakingVault.sol": {
    lines: {found: 146, minHit: 142},
    branches: {found: 24, minHit: 24},
  },
  "contracts/lp-staking/LPZapper.sol": {
    lines: {found: 75, minHit: 74},
    branches: {found: 15, minHit: 15},
  },
  "contracts/lp-staking/RewardsDistributor.sol": {
    lines: {found: 82, minHit: 79},
    branches: {found: 13, minHit: 13},
  },
  "contracts/lp-staking/TokenX.sol": {
    lines: {found: 42, minHit: 41},
    branches: {found: 7, minHit: 7},
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
