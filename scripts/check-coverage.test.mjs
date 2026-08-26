// Fixture harness for the coverage gate.
//
// The checker is run as a SUBPROCESS, exactly the way `npm run coverage:forge:check` and CI
// run it, against synthetic lcov files in an OS temp dir. What is tested is therefore the
// contract CI depends on — argv + env in, exit code + stderr out — and not some inner function
// CI never calls. Node builtins only: no network, no forge, no fixtures on disk.
//
//     node --test scripts/check-coverage.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

import {PINNED_BASIS, PER_FILE_FLOORS} from "./check-coverage.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECKER = path.join(HERE, "check-coverage.mjs");
const GOOD_ENV = {LP_COVERAGE_BASIS: PINNED_BASIS};

// ── lcov fixture builder ────────────────────────────────────────────────────────────────────

/**
 * One lcov record with exactly the requested ratios.
 * `lines: [hit, found]`, `branches: [hit, found]`.
 *
 * The `LF` / `LH` / `BRF` / `BRH` summary lines are deliberately written WRONG (a perfect
 * score) so that any test which passes proves the checker recomputed from the raw records.
 */
const record = (file, {lines: [lineHit, lineFound], branches: [branchHit, branchFound]}) => {
  const out = ["TN:", `SF:${file}`];
  for (let i = 0; i < lineFound; i++) out.push(`DA:${i + 1},${i < lineHit ? 7 : 0}`);
  for (let i = 0; i < branchFound; i++) out.push(`BRDA:${i + 1},0,${i},${i < branchHit ? 3 : "-"}`);
  out.push(`BRF:${branchFound}`, `BRH:${branchFound}`, `LF:${lineFound}`, `LH:${lineFound}`, "end_of_record");
  return out.join("\n");
};

/** Every in-scope file exactly at its pinned floor — the shape a clean run produces. */
const cleanRecords = () => {
  const out = {};
  for (const [file, floors] of Object.entries(PER_FILE_FLOORS)) {
    out[file] = {
      lines: [floors.lines.minHit, floors.lines.found],
      branches: [floors.branches.minHit, floors.branches.found],
    };
  }
  // Out of scope, and deliberately terrible: the gate must not look at it at all.
  out["contracts/lp-staking/mocks/MockUniswapV3Pool.sol"] = {lines: [1, 100], branches: [0, 20]};
  return out;
};

const buildLcov = (overrides = {}, {drop = []} = {}) => {
  const merged = {...cleanRecords(), ...overrides};
  for (const key of drop) delete merged[key];
  return Object.entries(merged)
    .map(([file, spec]) => record(file, spec))
    .join("\n");
};

// ── harness ─────────────────────────────────────────────────────────────────────────────────

const runChecker = (lcovText, {env = GOOD_ENV, args = null} = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-covgate-"));
  try {
    let argv = args;
    if (argv === null) {
      const lcovPath = path.join(dir, "lcov.info");
      fs.writeFileSync(lcovPath, lcovText, "utf8");
      argv = [lcovPath];
    }
    const result = spawnSync(process.execPath, [CHECKER, ...argv], {
      encoding: "utf8",
      env: {PATH: process.env.PATH, ...env},
    });
    return {code: result.status, stdout: result.stdout, stderr: result.stderr};
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
};

// ── the happy path ──────────────────────────────────────────────────────────────────────────

test("a run exactly at every pinned floor passes", () => {
  const {code, stdout} = runChecker(buildLcov());
  assert.equal(code, 0, stdout);
  assert.match(stdout, /coverage gate PASSED/);
});

test("coverage above the floor passes, and the wrong LF/LH summary lines are ignored", () => {
  // One more line covered than the floor demands, on the file with the widest gap.
  const lcov = buildLcov({
    "contracts/lp-staking/LPStakingVault.sol": {lines: [143, 146], branches: [24, 24]},
  });
  assert.equal(runChecker(lcov).code, 0);
});

// ── floors ──────────────────────────────────────────────────────────────────────────────────

test("one newly uncovered line fails the gate and names the file", () => {
  const lcov = buildLcov({
    "contracts/lp-staking/TokenX.sol": {lines: [40, 42], branches: [7, 7]},
  });
  const {code, stderr} = runChecker(lcov);
  assert.equal(code, 1);
  assert.match(stderr, /TokenX\.sol: lines coverage 95\.24% \(40\/42\)/);
  assert.match(stderr, /below the floor 97\.62% \(41\/42\)/);
});

test("one newly uncovered branch fails the gate — every branch floor is the ceiling", () => {
  const lcov = buildLcov({
    "contracts/lp-staking/RewardsDistributor.sol": {lines: [79, 82], branches: [12, 13]},
  });
  const {code, stderr} = runChecker(lcov);
  assert.equal(code, 1);
  assert.match(stderr, /RewardsDistributor\.sol: branches coverage 92\.31% \(12\/13\)/);
});

test("all violations are reported, not just the first", () => {
  const lcov = buildLcov({
    "contracts/lp-staking/TokenX.sol": {lines: [40, 42], branches: [6, 7]},
    "contracts/lp-staking/LPZapper.sol": {lines: [70, 75], branches: [15, 15]},
  });
  const {code, stderr} = runChecker(lcov);
  assert.equal(code, 1);
  assert.match(stderr, /3 violation\(s\)/);
});

// ── the measurement basis ───────────────────────────────────────────────────────────────────

test("a moved denominator fails instead of being graded against the old bar", () => {
  const lcov = buildLcov({
    "contracts/lp-staking/LPZapper.sol": {lines: [80, 80], branches: [15, 15]},
  });
  const {code, stderr} = runChecker(lcov);
  assert.equal(code, 1);
  assert.match(stderr, /LPZapper\.sol: lines denominator moved — the run measured 80 where the pinned basis has 75/);
});

test("a file that vanished from the report fails instead of skipping its floor", () => {
  const lcov = buildLcov({}, {drop: ["contracts/lp-staking/libraries/TwapGuard.sol"]});
  const {code, stderr} = runChecker(lcov);
  assert.equal(code, 1);
  assert.match(stderr, /missing: contracts\/lp-staking\/libraries\/TwapGuard\.sol has no lcov record/);
});

test("an unset basis is refused before any number is looked at", () => {
  const {code, stderr} = runChecker(buildLcov(), {env: {}});
  assert.equal(code, 1);
  assert.match(stderr, /LP_COVERAGE_BASIS is not set/);
});

test("a basis the floors were not measured under is refused", () => {
  const {code, stderr} = runChecker(buildLcov(), {env: {LP_COVERAGE_BASIS: "forge-1.7-no-ir-minimum"}});
  assert.equal(code, 1);
  assert.match(stderr, /not comparable/);
});

test("--config-check grades the basis alone, with no lcov on disk", () => {
  const good = runChecker(null, {args: ["--config-check"]});
  assert.equal(good.code, 0);
  assert.match(good.stdout, /coverage config OK/);

  const bad = runChecker(null, {env: {}, args: ["--config-check"]});
  assert.equal(bad.code, 1);
});

// ── operator errors ─────────────────────────────────────────────────────────────────────────

test("a missing lcov file fails with the command that produces one", () => {
  const {code, stderr} = runChecker(null, {args: [path.join(os.tmpdir(), "definitely-not-here.info")]});
  assert.equal(code, 1);
  assert.match(stderr, /npm run coverage:forge:check/);
});
