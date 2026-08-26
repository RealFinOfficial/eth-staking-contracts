# REAL Finance — ERC20 Delegators Staking Contract

## Overview

Staking pool contracts for REAL Finance. Users stake ASSET tokens on Ethereum (or EVM chain). The contract tracks each staker's time-weighted share and distributes USDC rewards proportionally. Forfeited rewards from early leavers are redistributed to remaining participants.

Two pool contracts live side by side:

- **`StakingPool.sol`** — the original pool. Weight is `amount × seconds`. No signatures.
- **`WeightedStakingPool.sol`** — the current deployment target. Weight is `amount × multiplier × seconds`, where the multiplier is attested off-chain via an EIP-712 signature. Same lifecycle, penalty and forfeiture model as `StakingPool`.

### Lifecycle

1. **Deploy** with `activationEpoch` and `endEpoch` — staking is possible immediately
2. **Before `activationEpoch`** — users can stake and withdraw freely (no penalty, no rewards accrue)
3. **`activationEpoch` → `endEpoch`** (active period) — weight accumulates, `withdraw()` forfeits weight + linear penalty
4. **After `endEpoch`** — `unstake()` returns staked tokens + proportional USDC rewards
5. Owner calls `addRewards(amount)` to set the reward pool size; USDC is transferred from the caller via `safeTransferFrom`

### Key Functions (WeightedStakingPool)

| Function | When | Effect |
|---|---|---|
| `stake(amount, weight, deadline, signature)` | Before `endEpoch` | Deposit tokens; weight starts at `max(stakeTime, activationEpoch)`. Signature **mandatory** |
| `withdraw(amount, weight, deadline, signature)` | Before `endEpoch` | Before activation: free exit. During active: forfeit weight + penalty. Signature optional — `0x` resets the multiplier to `BASE_WEIGHT` |
| `updateWeight(weight, deadline, signature)` | Before `endEpoch`, stake > 0 | Change the multiplier without moving tokens. Signature **mandatory** |
| `unstake()` | After `endEpoch`, `totalRewards > 0` | Returns tokens + proportional USDC rewards |
| `emergencyUnstake()` | After `endEpoch` | Returns tokens, forfeits all rewards |
| `addRewards(amount)` | Any time (owner) | Transfers USDC from caller and increases reward counter |
| `setSigner(address)` | Any time (owner) | Rotate the attestation signer; invalidates outstanding signatures |

`StakingPool` exposes the same set minus `updateWeight`/`setSigner`, with `stake(amount)` and `withdraw(amount)`.

## LP Staking (V1)

A second stack, independent of the pools above: users provide Uniswap V3 ASSET-USDC
liquidity and are rewarded in TokenX. It shares no contract, no owner and no token with
`StakingPool` / `WeightedStakingPool`.

- **`LPStakingVault.sol`** — custody only. Holds staked position NFTs, records who staked
  each one, and lets the staker `rebalance` (pull all liquidity and fees, optional swap,
  mint a new range, refund dust, burn the emptied NFT) without ever losing custody. It
  computes no rewards and stores no dollar values — scoring is off-chain, from the
  full-state events. `unstake` is never gated by a pause switch, a signature or backend
  liveness. Deposits and `rebalance` have one owner switch each — `setDepositsPaused`
  (which also stops zaps, because `zapIn` ends in `stakeFor`) and `setRebalancePaused`,
  the incident switch for the one complex path in an immutable contract
- **`LPZapper.sol`** — replaceable periphery. Sequences USDC → swap → mint →
  `vault.stakeFor` in one transaction and refunds every leftover in the same call. Holds
  no funds and no NFTs between transactions. The vault must whitelist it with `setZapper`
  before zapping works. Zap-out is out of scope for V1 — `unstake` returns the NFT
- **`TokenX.sol`** — the reward token. 18 decimals, EIP-2612 permit, burnable. Exactly one
  `minter` (the distributor), re-pointable by the owner as the escape hatch, plus a
  per-epoch mint cap the token enforces itself. That cap is defense in depth: a
  compromised or broken distributor can never mint past what the owner armed for the
  running epoch
- **`RewardsDistributor.sol`** — cumulative-voucher claims. `claimTokenX` mints the
  difference between the voucher's lifetime figure and what the user already claimed;
  `claimAsset` pays ASSET out of a pre-funded balance and stays off until the owner
  enables it. One typehash per leg so a voucher cannot be spent on the other, and the
  signed `user` is always `msg.sender`, never an argument

Both `LPStakingVault` and `LPZapper` inherit `TwapGuard`: a swap leg reverts when spot
deviates from the pool TWAP by more than `maxTwapDeviationTicks`. Callers still carry their
own `amountOutMin` / `amount0Min` / `amount1Min` — the guard is a manipulation circuit
breaker, not a pricing oracle, and the exact protection is those minimums. The parameter is
a tick count, not bps: the window is bounded to 300–3600 s and the ceiling to 1823 ticks
(`floor(ln 1.2 / ln 1.0001)`, a 20% move). `scripts/deploy-lp-staking.js` keeps the human
knob in bps and converts with `floor(ln(1 + bps/1e4) / ln(1.0001))` — 500 bps = 487 ticks,
1000 = 953, 2000 = 1823 — logging both numbers. `amountIn == 0` skips the swap and therefore
the guard, deliberately: a no-swap range move must stay available at any price.

Both also refuse unsolicited position NFTs: `onERC721Received` accepts a safe transfer only
inside their own mint/stake flow. A plain `transferFrom` bypasses the hook entirely, so both
carry an owner `rescuePosition(tokenId)` that sends a stranded NFT to `owner()`. The vault's
is restricted to `stakerOf(tokenId) == address(0)`; since record and custody are always
created and destroyed in the same transaction, a staked position can never be reached by it.

Deliberate design choices an auditor is expected to question — the `recoverExcessAsset`
timing, the tick-vs-bps bound, one-step `Ownable`, the whole-balance mint/refund and the
epoch cap's role — are written up in `docs/lp-staking-audit-notes.md`.

### Deploy order

`scripts/deploy-lp-staking.js` does all of it in one run:

1. `TokenX(name, symbol, deployer)`
2. `RewardsDistributor(tokenX, asset, signer, deployer)`
3. `LPStakingVault(positionManager, pool, token0, token1, fee, router, deployer, twapWindow, maxDeviationTicks)`
4. `LPZapper(vault, positionManager, pool, token0, token1, fee, router, usdc, asset, deployer, twapWindow, maxDeviationTicks)`
5. Wire: `tokenX.setMinter(distributor)`, `vault.setZapper(zapper)`
6. Arm the first epoch: `tokenX.setEpochCap(epochId, cap)`
7. `transferOwnership(multisig)` on all four
8. `pool.increaseObservationCardinalityNext(target)` — permissionless, so it runs last

The deployer owns all four through steps 5–6 because that wiring is `onlyOwner`; ownership
moves only at step 7. Etherscan verification replays the **deployer** address, not the
multisig — that is what the constructors actually saw.

The script fails before spending gas when `pool.token0/token1/fee` disagree with the sorted
`(LP_ASSET, LP_USDC, LP_FEE)`, or when the token decimals are not ASSET 18 / USDC 6. The
decimals check exists because the zapper cannot tell the two roles apart on-chain — both
are just "one side of the pair" — so a swapped pair would deploy and mint with the legs
reversed without reverting anywhere.

### Operational gotchas

- **Arm an epoch before the first claim.** TokenX starts on `currentEpochId = 0` with a
  zero cap, so every `claimTokenX` reverts with `EpochMintCapExceeded` until the owner
  calls `setEpochCap(epochId, cap)`. Tallies are keyed by epoch id and are never reset, so
  re-selecting an earlier id keeps that epoch's existing total
- **Grow the oracle, then wait.** `increaseObservationCardinalityNext` only allocates
  observation slots; they fill one per block that trades. Until the pool holds `twapWindow`
  seconds of history, `observe()` reverts with `OLD` and every TWAP-guarded path (`zapIn`,
  and any `rebalance` carrying a swap leg) reverts with it. Paths without a swap work from
  block one. A pool at cardinality 1 therefore needs roughly a window's worth of trading
  after the bump before the guarded paths become usable
- **The oracle is sized, not guessed.** `LP_OBSERVATION_CARDINALITY` defaults to 150 and the
  deploy script refuses anything below `2 × ceil(LP_TWAP_WINDOW / 12)` — one slot per 12 s
  block in the worst case, doubled for the burst of trading a crash produces, which is
  exactly when the guard is read. 300 s needs ≥ 50, 3600 s needs ≥ 600
- **Guard defaults are wide on purpose.** `LP_TWAP_WINDOW=300`, `LP_TWAP_MAX_DEVIATION_BPS=1000`
  (= 953 ticks). A narrow guard locks `rebalance` out exactly when a position has fallen out
  of range and needs re-ranging; the caller's own minimums are the primary protection

## Project Structure

```
contracts/           — Solidity source files
  StakingPool.sol           — Original time-weighted staking contract
  WeightedStakingPool.sol   — Staking with EIP-712 attested weight multipliers
  MockERC20.sol             — Test-only 18-decimal ERC20 mock
  MockERC20Decimals.sol     — Test-only ERC20 mock with configurable decimals (6-dec USDC-like)
  lp-staking/          — The LP staking stack; imports stay relative inside this folder
    LPStakingVault.sol        — Custody and atomic re-ranging for Uniswap V3 LP positions
    LPZapper.sol              — USDC in, staked position out; replaceable periphery
    TokenX.sol                — LP reward token; one minter, per-epoch mint cap
    RewardsDistributor.sol    — EIP-712 cumulative-voucher claims (TokenX and ASSET legs)
    interfaces/               — Vendored Uniswap V3 interfaces (position manager, router, pool)
    libraries/TwapGuard.sol   — Shared spot-vs-TWAP check and the SwapParams struct
    mocks/                    — Test-only Uniswap doubles, permit token and reentrancy attackers
test/                — Hardhat test files (Mocha + Chai). 536 tests, 0 pending
  StakingPool.test.js         — 88 tests
  WeightedStakingPool.test.js — 40 tests
  lp-staking/
    LPStakingVault.test.js      — 76 tests
    RewardsDistributor.test.js  — 46 tests
    TokenX.test.js              — 47 tests
    LPZapper.test.js            — 45 tests
    fork/LPStakingFork.test.js  — 19 mainnet-fork tests; skip themselves without MAINNET_RPC_URL
    helpers/                    — fork harness: fork-node, chain, rpc, uniswap, signing,
                                  scripts, ledger, constants, profiles
    helpers/profiles.js         — the network profile (sepolia default, mainnet phase 2)
    integration/LPStakingLocalFork.test.js
                                — 86 tests on a spawned `hardhat node --fork`, mainnet-pinned;
                                  deploys via the repo's own scripts. Same skip rule as fork/
    integration/LPStakingSepoliaFork.test.js
                                — 89 tests, the same scenario driven through the profile
test-live/           — REAL transactions. Never in CI, never in `npx hardhat test`
  sepolia/SepoliaLive.test.js — gated smoke run against live Sepolia; see "Test tiers"
test/forge/          — Foundry tier. 352 tests: 100 fork, 213 unit, 21 fuzz, 18 invariant
  utils/                      — plain .sol scaffolding; forge ignores it as non-test
    BaseForge.sol               — constants, the active profile, the skip-vs-fail rule
    ForkHarness.sol             — the stack against real Uniswap on a pinned fork
    LocalHarness.sol            — the stack against the repo's own mocks, deterministic
    Profiles.sol                — the same network facts as helpers/profiles.js
    RawTickPool.sol             — a pool whose `observe` returns raw, caller-chosen cumulatives
    attackers/                  — hostile tokens, malicious NPM, reentrant router, receivers
  fork/ unit/ fuzz/ invariant/  — *.t.sol; the taxonomy is the directory
foundry.toml         — solc/evm/optimizer mirror hardhat.config.js; profiles, fmt, lint
remappings.txt       — @openzeppelin -> node_modules, forge-std -> lib/forge-std
lib/forge-std        — git submodule; CI must check out with `submodules: recursive`
.solcover.js         — solidity-coverage skipFiles: mocks, interfaces, the two legacy pools
docs/                — Design and review notes
  lp-staking-audit-notes.md — Deliberate properties of the LP stack an auditor will flag,
                              plus the five SEC-0x findings and the behaviours tests now pin
scripts/             — Deployment and interaction scripts (see scripts/README.md)
  lib/pools.js              — Shared: address resolution, pool-kind detection,
                              mainnet CONFIRM guard, Ledger nonce workaround
  deploy-lp-staking.js      — Deploys and wires the whole LP stack, then hands it to the multisig
  create-sepolia-pool.js    — Creates the integration ASSET-USDC pool; refuses to run on mainnet
  run-forge.mjs             — forge wrapper: loads .env, resolves the fork endpoint, runs forge
  check-coverage.mjs        — Blocking coverage gate; check-coverage.test.mjs tests it
abi/                 — Checked-in ABIs for both pools and the four LP contracts
deployments.json     — Deployed addresses keyed by chain id
.env.example         — Every variable hardhat.config.js and the scripts read
.github/workflows/ci.yml — Two jobs: hardhat (unit + three fork suites) and forge
```

Every script is network- and pool-agnostic: the address comes from
`deployments.json` or `POOL=0x…`, the kind is detected on-chain by probing
`BASE_WEIGHT()`, and token decimals are read from the token. State-changing
scripts refuse to run on chain 1 without `CONFIRM=yes`.

## Commands

```bash
npx hardhat compile                 # Compile contracts (Hardhat)
npx hardhat test                    # Everything Hardhat owns: unit + three fork suites
npm run test:integration            # Just the mainnet-pinned local-fork integration suite
npm run test:integration:sepolia    # Just the profile-driven fork integration suite
npm run test:sepolia:live           # Gated live-Sepolia smoke; REAL transactions, never CI

npm run test:forge                  # Foundry: fork + unit + fuzz + invariant
npm run test:forge:ci               # Same, ci profile (fuzz 1024, invariants 512 sequences)
npm run coverage:forge              # forge coverage: lcov + a summary table
npm run coverage:forge:check        # Same, then the blocking per-file floors gate
node --test scripts/check-coverage.test.mjs   # The gate's own tests (no forge, no network)

npx hardhat coverage                # solidity-coverage over everything under test/
npm run test:coverage:unit          # solidity-coverage over the four unit suites only
```

## Test tiers

Nine tiers, two toolchains. Hardhat owns the scenario and the deployment scripts; Foundry owns
the adversarial and branch-coverage work, because `forge coverage` reports real per-branch
numbers and `vm.createSelectFork` reaches live Uniswap without spawning a node.

| tier | where | run by | needs |
|---|---|---|---|
| Hardhat unit (mocks) | `test/lp-staking/*.test.js` | `npx hardhat test` | nothing |
| Hardhat in-process mainnet fork | `test/lp-staking/fork/LPStakingFork.test.js` | `npx hardhat test` | mainnet archive RPC |
| Hardhat local-fork integration, mainnet-pinned | `test/lp-staking/integration/LPStakingLocalFork.test.js` | `npm run test:integration` | mainnet archive RPC |
| Hardhat fork integration, profile-driven | `test/lp-staking/integration/LPStakingSepoliaFork.test.js` | `npm run test:integration:sepolia` | archive RPC for the profile's chain |
| Live Sepolia smoke — gated, **never CI** | `test-live/sepolia/SepoliaLive.test.js` | `npm run test:sepolia:live` | `SEPOLIA_LIVE=1` + `PRIVATE_KEY` + endpoint |
| Foundry fork (real state) | `test/forge/fork/` | `npm run test:forge` | archive RPC for the profile's chain |
| Foundry unit (deterministic) | `test/forge/unit/` | `npm run test:forge` | nothing |
| Foundry fuzz (properties) | `test/forge/fuzz/` | `npm run test:forge` | nothing |
| Foundry invariant (campaigns) | `test/forge/invariant/` | `npm run test:forge` | nothing |

`npx hardhat test` runs the first four (`paths.tests` is `./test`). It does **not** and must
never run `test-live/`.

**Test maps** — generated from the test files at the branch head on 2026-08-25; private
artifacts, shared by the repository owner on request.

- Contracts test map (every tier, new tests and audit-finding tests marked): https://claude.ai/code/artifact/d04fc2cb-8da8-42c8-b91b-86ffcec1576b
- Indexer test map (companion, evm-indexer): https://claude.ai/code/artifact/319b99b2-ccd0-48d9-93bc-fbef9c263c92
- Expansion report (what landed, verification, audit findings SEC-01..05, open decisions): https://claude.ai/code/artifact/0ac9c23a-25bd-4fb3-8152-5673f6cac322

### The network profile

`test/lp-staking/helpers/profiles.js` (Hardhat) and `test/forge/utils/Profiles.sol` (Foundry)
each hold one object per world the fork suites can run in. `LP_TEST_PROFILE` selects it, the
default is `sepolia`, and an unknown value **throws** — there is no silent fallback. Phase 1 is
Sepolia; phase 2 is `LP_TEST_PROFILE=mainnet` re-running the same test bodies against real
ASSET/USDC. The profile is wired for it, not yet proven on it.

Facts the sepolia profile is pinned to, verified live on 2026-08-25 and re-asserted on every
run by `fork-node.probeFork`:

- pinned block **11562000**
- tREAL `0x8e65d19BE4bA1CC61005B4c70f21cd179512e33f` — 18 dec, "Test REAL", **token0**
- tUSDC `0x9E0F2263c0Cb67Ee08B8c8A42be8770870b05215` — 6 dec, "TestUSDC", token1
- funder `0xBb7403aAF82342A0d987A8603aAf881136B5D125` — holds ~95% of both supplies
- factory `0x0227628f3F023bb0B980b67D528571c95c6DaC1c`, NPM
  `0x1238536071E1c677A632429e3655c799b22cDA52`, SwapRouter02
  `0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E`
- **no tREAL/tUSDC pool exists on live Sepolia** at any fee tier — the fork creates one with
  `scripts/create-sepolia-pool.js`
- **neither token has `DOMAIN_SEPARATOR()`**, so neither can sign an EIP-2612 permit. The
  permit steps therefore prove the zapper's `allowance >= permit.value -> skip permit` branch;
  the true EIP-2612 branch stays covered by the unit suites and graduates with the profile.

### Skip vs fail, per profile

`fork-node.decideOnForkFailure(failures, env, profile)` takes the profile, and
`test/forge/utils/BaseForge.sol` implements the same rule for Foundry. Substance unchanged:
establishing the fork is the ONLY phase that may skip, and it fails instead once the profile's
RPC variable or `INFURA_API_KEY` is set. Message prefix is the profile's `logLabel` —
`[local-fork]` for mainnet, `[sepolia-fork]` for Sepolia.

Manual spot checks, worth running whenever the rule is touched:

```bash
SEPOLIA_RPC_URL=http://127.0.0.1:9 npm run test:integration:sepolia   # must FAIL, not skip
MAINNET_RPC_URL=http://127.0.0.1:9 npm run test:integration           # must FAIL, not skip
SEPOLIA_RPC_URL=http://127.0.0.1:9 npm run test:forge                 # must FAIL, not skip
```

### Live Sepolia smoke — runbook

This is the spec's Sepolia staging rehearsal. It sends REAL transactions and, on a first run,
records the deployment in the **tracked** `deployments.json` under chain `11155111`.

Gates (all three, or the suite skips and names what is missing): `SEPOLIA_LIVE=1`,
`PRIVATE_KEY`, and `SEPOLIA_RPC_URL` or `INFURA_API_KEY`. Two further one-time gates, off by
default: `SEPOLIA_LIVE_CREATE_POOL=1` creates the pool (**permanent** — the address is fixed
forever; needs an explicit go the first time), `SEPOLIA_LIVE_DEPLOY=1` deploys the four
contracts and writes them into the tracked registry. Optional `LP_SIGNER_KEY` redeems a real
1-wei TokenX voucher; without it the suite proves a foreign voucher is refused by static call.
Both arms are real assertions and the test title says which one ran.

**Known precondition, not a bug (item 7 in the audit notes):** a freshly created pool stores one
observation, so `pool.observe([twapWindow, 0])` reverts `OLD` and every TWAP-guarded path
reverts with it. The live suite detects this and asserts that `zapIn` reverts rather than
pretending the zap succeeded. Seed liquidity and trade the pool for at least `LP_TWAP_WINDOW`
seconds before expecting the zap leg to pass.

### Coverage

Two independent signals, both real:

```bash
npm run coverage:forge:check   # forge coverage -> lcov -> per-file line + branch floors
npm run test:coverage:unit     # solidity-coverage over the four Hardhat unit suites
```

`scripts/check-coverage.mjs` is the blocking one. It recomputes totals from the raw `DA:` /
`BRDA:` records (never from the optional `LF` / `BRF` summary lines), scopes to the four LP
contracts plus `libraries/TwapGuard.sol`, and pins both the floors and their DENOMINATORS —
so a moved measurement basis fails loudly instead of being graded against a bar that no longer
describes it. `--ir-minimum` is not optional: coverage disables the optimizer and the
un-optimized build hits "Stack too deep" in `WeightedStakingPool.sol` without it. The npm
script passes `LP_COVERAGE_BASIS=forge-1.7-ir-minimum` and the checker refuses to grade a run
without it.

Measured 2026-08-26 — branch coverage is 100% on all five files, so every branch floor is also
the ceiling:

| file | lines | branches |
|---|---|---|
| `LPStakingVault.sol` | 99.08% (108/109) | 100.00% (21/21) |
| `LPZapper.sol` | 98.65% (73/74) | 100.00% (15/15) |
| `RewardsDistributor.sol` | 100.00% (43/43) | 100.00% (10/10) |
| `TokenX.sol` | 97.62% (41/42) | 100.00% (7/7) |
| `libraries/TwapGuard.sol` | 100.00% (37/37) | 100.00% (7/7) |

The three uncovered lines are the call sites `_checkTwapDeviation();` (`LPStakingVault.sol:537`,
`LPZapper.sol:389`) and `_rollPendingEpoch();` (`TokenX.sol:155`). Every callee reports 100% of
its own body in the same run, so all three are demonstrably executed — this is `--ir-minimum`
losing the inlined call site's mapping, not a gap. They are named in the checker and in the
audit notes instead of being chased with contrived tests.

### Foundry beside Hardhat

Two settings keep the toolchains apart, both in `foundry.toml`: forge writes to `out/` and
`cache_forge/` (both gitignored) so it never touches Hardhat's `cache/`, and `forge fmt` is
scoped to `test/forge/` only — `contracts/` stays formatted the way the Hardhat side formats
it. Mocha loads only `.js`, so the `.t.sol` files are invisible to `npx hardhat test`, and
`npx hardhat compile` only ever reads `contracts/`. `[lint] exclude_lints = ["block-timestamp"]`
is set because every deadline, TWAP window and epoch activation compares against
`block.timestamp` on purpose.

Layout, following the reference repo's convention: `*.t.sol` has test functions and forge runs
it; a plain `.sol` under `test/forge/utils/` is scaffolding and forge ignores it. Invariant
`runs` and `depth` live in `foundry.toml` — `[profile.default]` pins 64 x 25 and
`[profile.ci]` overrides with 512 x 50 — because forge's own default for a profile with no
`[invariant]` section is 256 runs x depth 500, i.e. 128,000 handler calls per invariant, which
turns a bare `npm run test:forge` into a minutes-long wait.

`scripts/run-forge.mjs` wraps `forge`: it loads `.env` (forge does not), resolves the fork
endpoint as `<NETWORK>_RPC_URL -> INFURA_API_KEY -> the first public candidate that serves
ARCHIVE STATE at the pinned block`, exports it plus `LP_FORK_RPC_REQUIRED`, and runs forge.
Bare `forge test` works too — the fork tier then skips with a reason.

The public probe makes three distinct historical reads at the pinned block — a balance, a
contract's code, and an `eth_call` of `totalSupply()` — as three separate requests, and
requires all three. A header read proves only that the node kept the header; a single state
read proves only that ONE request reached a backend that has the state.
`ethereum-sepolia-rpc.publicnode.com` is a load-balanced pool whose backends disagree about
Sepolia archive availability, and both outcomes appeared the same day: run 32845136586
rejected it and ran green on tenderly, run 32845141961 accepted it on a single balance read
and then failed in `setUp()` on the first read of a different account
(`-32000: historical state ... is not available`). `sepolia.gateway.tenderly.co` is therefore
tried FIRST and publicnode sits behind it, in both `run-forge.mjs` and
`test/lp-staking/helpers/profiles.js`. Each rejected candidate is logged as `host: reason` so
a CI log says why a fallback was passed over. Host only — the Infura project id is never
printed.

## Local-fork integration suite

`test/lp-staking/integration/LPStakingLocalFork.test.js` starts its own
`hardhat node --fork <mainnet> --fork-block-number 25750000` on a free port and drives it
over HTTP. On that node it deploys two `MockERC20Permit` tokens (tASSET 18 dec, tUSDC
6 dec), creates a **fresh** Uniswap V3 pool for them through the real factory and position
manager, and then deploys the whole stack by running `scripts/create-sepolia-pool.js` and
`scripts/deploy-lp-staking.js` as child processes — unmodified, through
`hardhat run --network localhost`. Forty-five scenario steps follow, one transaction per
block, and the last three sections assert that everything they emitted is stored on that
chain and retrievable from it: by address, by indexed topic, by block hash, in chunked
ranges, and from receipts. A snapshot revert proves an orphaned block really disappears.

What it covers that `fork/LPStakingFork.test.js` cannot: the deployment scripts (they need
a JSON-RPC endpoint, not an in-process provider) and log retrieval across a real chain of
blocks (the in-process suite restores a snapshot before every test, so it never builds one).

- **Skip vs fail** is the same one-sided rule as the in-process fork suite, and it lives in
  one pure function, `helpers/fork-node.js:decideOnForkFailure`, which the suite unit-tests.
  Establishing the fork is the only phase that may skip; with `MAINNET_RPC_URL` or
  `INFURA_API_KEY` set it throws instead. Nothing after the fork is up can become a skip.
- **`deployments.json` is never written.** The scripts record into `DEPLOYMENTS_FILE`, a
  file in a per-run scratch directory. The tracked registry's sha256 is captured when the
  test file loads and asserted again at the end of the run.
- **No orphan nodes.** The spawned node is killed from `after`, from `process.on("exit")`
  and from the SIGINT/SIGTERM handlers.
- **Fees are pinned, never estimated** — `baseFee x100`, floor 10 gwei, priority 1 gwei —
  on every wallet, and passed to the script children as `LOCALHOST_GAS_PRICE`.

Env vars, all set by the harness for its children and all optional otherwise:

| Variable | Read by | Effect |
|---|---|---|
| `LOCALHOST_RPC_URL` | `hardhat.config.js` | Points `networks.localhost` at the port the harness picked. Default `http://127.0.0.1:8545` |
| `LOCALHOST_GAS_PRICE` | `hardhat.config.js` | Fixed gas price in wei for `--network localhost`. Unset means Hardhat estimates, which a pinned fork can make undershoot |
| `DEPLOYMENTS_FILE` | `scripts/lib/pools.js` | Redirects the deployment registry. Unset means the tracked `deployments.json` |

There is deliberately no `networks.hardhat` entry in `hardhat.config.js`: the in-process
fork suite resets with a bare `hardhat_reset`, and a config entry would change what that
resets to.

## Tech Stack

- Solidity pragma ^0.8.20, compiled with 0.8.28 (optimizer 200 runs, cancun)
- Hardhat 2.x — unit suites, the fork suites, the 45-step scenario, the deploy scripts
- Foundry 1.7 — fork, unit, fuzz and invariant tiers, plus the blocking coverage gate
- OpenZeppelin Contracts v5 (Ownable, IERC20, SafeERC20, ReentrancyGuard, EIP712, ECDSA)
- Ethers.js v6 (via hardhat-toolbox)

## Key Design Decisions

### Shared by both pools

- **Weight** = `amount × seconds_in_active_period` — proportional to both stake size and duration within [activationEpoch, endEpoch]
- **On-chain reward distribution** — USDC rewards are paid out during `unstake()`, calculated as `totalRewards × userWeight / totalEffectiveWeight`
- **Forfeiture mechanism** — early withdrawers lose their weight, automatically increasing remaining stakers' reward shares
- **`_effectiveTime()`** clamps to `[activationEpoch, endEpoch]` — no weight accumulation outside the active period
- **Withdrawal penalty** — linearly decays from `MAX_PENALTY_BPS` (5000 = 50%) to a floor of `MIN_PENALTY_BPS` (500 = 5%) over the active period (`activationEpoch` → `endEpoch`); early exit is never free, and the floor holds until `endEpoch` rather than tapering to zero. Penalized tokens go to `PENALTY_RECEIVER`. No penalty before activation, after `endEpoch`, or once ownership is renounced — `getCurrentPenaltyPct` mirrors all three cases. `MAX_PENALTY_BPS`, `MIN_PENALTY_BPS` and `BPS_DENOMINATOR` are public constants and are also emitted in `PoolInitialized`, so the indexer can compute the penalty from logs alone or read them back over `eth_call`
- **Reward funding** — `addRewards(amount)` transfers USDC from the caller via `safeTransferFrom` and increases the reward counter
- **`unstake()` requires funding** — reverts with `Rewards not funded` while `totalRewards == 0`; `emergencyUnstake()` is the unfunded escape hatch
- **`recoverExcessRewards()`** — owner can recover overfunded or unclaimed USDC after pool ends
- **Two separate tokens** — `stakingToken` (ASSET) and `rewardToken` (USDC) must be different addresses
- **Renouncing ownership** disables new stakes (`Staking disabled`) and zeroes the penalty — a wind-down switch, existing stakers can still exit

### WeightedStakingPool only

- **One multiplier per user**, in `BASE_WEIGHT` units: `BASE_WEIGHT = 1000` (x1.0) to `MAX_WEIGHT = 2000` (x2.0). Applies to the user's whole stake, not per-deposit
- **Weights are attested, never self-chosen** — every weight-setting call carries an EIP-712 signature from `signer` over `(user, amount, weight, nonce, deadline)`, with a distinct typehash per action (`Stake` / `Withdraw` / `UpdateWeight`) so signatures cannot be cross-replayed
- **Nonces** — one counter per user (`nonces(user)`), shared across all three actions, consumed on every successful verification. Signatures are single-use and must be issued in order. `NonceUsed` is emitted so the backend can follow nonces from logs
- **Checkpoint before re-weighting** — `_updateGlobal()` + `_updateUser()` run before `_applyWeight()`, so accrual up to that point is locked in at the old multiplier. Boosts are never retroactive
- **Unsigned withdraw is permissionless** — the deliberate exception so users can always exit if the backend is down. It ignores the `weight`/`deadline` args and resets the multiplier to `BASE_WEIGHT`, since the boost was attested for the pre-withdraw amount. A full withdraw clears the multiplier to `0`
- **`totalWeightedStaked`** tracks `Σ(amount × multiplier)` and drives global accrual, mirroring the role `totalStaked` plays in `StakingPool`
- **Weight scale** — accrued weights are 1000x the `StakingPool` equivalents because multipliers are stored in `BASE_WEIGHT` units; the factor cancels in the reward ratio
- **Full state checkpoints in events** — `StakeUpdated` and `GlobalUpdated` carry absolute post-call state (not deltas) with a clamped timestamp, so an indexer can rebuild pool state from logs alone
