// solidity-coverage 0.8.17 configuration.
//
// Paths in `skipFiles` are relative to `contracts/`, and a folder skips everything under it.
// Only the LP staking production contracts are measured: `lp-staking/*.sol` plus
// `lp-staking/libraries/TwapGuard.sol`. Everything below is excluded for a stated reason —
// a file with no test of its own drags the reported percentage down without telling anyone
// anything about the code that ships.
//
// Note: `npx hardhat coverage` runs every file under `test/`, which includes the fork and
// integration suites. Point it at the unit suites (`--testfiles`) unless a fork node is
// wanted.
module.exports = {
  // solidity-coverage instruments the source and then compiles it with the optimizer OFF,
  // and the instrumented LPStakingVault no longer fits the EVM stack: solc reports
  // "Stack too deep ... Variable headStart is 1 slot(s) too deep". This flag is
  // solidity-coverage's own remedy — it re-enables the Yul optimizer for the instrumented
  // build only, which is enough to place those variables. Without it `hardhat coverage`
  // cannot compile this repo at all.
  configureYulOptimizer: true,

  skipFiles: [
    // Test-only mocks. They exist to drive the contracts under test and are never deployed.
    "lp-staking/mocks",
    "MockERC20.sol",
    "MockERC20Decimals.sol",

    // Interface declarations. No executable statements to cover.
    "lp-staking/interfaces",

    // Legacy staking pools, predating the LP staking stack and outside its scope. They keep
    // their own suites (test/StakingPool.test.js, test/WeightedStakingPool.test.js); neither
    // one is a dependency of anything under lp-staking/.
    "StakingPool.sol",
    "WeightedStakingPool.sol",
  ],
};
