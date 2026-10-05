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
liquidity and are rewarded in `$ASSET` and the Overture token (`$OVTR`, contract
`TokenOverture`), and in any further reward token the timelock adds. It shares no contract, no
owner and no token with `StakingPool` / `WeightedStakingPool`.

ALL FIVE LP contracts are UUPS implementations behind `deploy/LPProxy.sol` (OZ `ERC1967Proxy`,
nothing added), and every proxy is owned by the `LPTimelock` (`deploy/LPTimelock.sol`, a plain
OZ `TimelockController`, 48 h on mainnet) from its own deployment transaction onwards. Ownership
is two-step on all five and `renounceOwnership` reverts. The timelock is replaceable by a
planned switch (`scripts/lp-switch-timelock.js`), because each proxy's owner is storage.

- **`LPStakingVault.sol`** — custody only. Holds staked position NFTs, records who staked each
  one, and lets the staker `rebalance` (pull all liquidity and fees, optional swap, mint a new
  range, refund dust, burn the emptied NFT) without ever losing custody. It computes no rewards
  and stores no dollar values — scoring is off-chain, from the full-state events. `unstake` is
  never gated by a pause switch, a signature or backend liveness. Deposits and `rebalance` have
  one pause switch each — `setDepositsPaused` (which also stops zaps) and `setRebalancePaused`.
  It is upgradeable because `stakers[tokenId]` is the only record of who owns each custodied
  NFT. THREE admin tiers — **owner** (the timelock): upgrades, `setZapper`, `setBonusEscrow`,
  `setGuardian`, `setOperator`; **guardian** (a hot key, no delay): the two pauses and nothing
  else; **operator** (a multisig, no delay): `setTwapParams`, `rescuePosition` (the NFT goes to
  the operator), `setGuardian`, and the two pauses as the cold fallback. **Bonus-escrow
  notifications** (`bonusEscrow`, zero = off, zero at mainnet launch; audit notes item 15):
  `unstake` calls `onUnstake(tokenId)` FAIL OPEN (inside `try`, 100,000 gas, a 106,587 gas
  floor, `BonusHookFailed` on revert); `rebalance` calls `onRebalance(old, new, oldSnapshot,
  newSnapshot)` FAIL CLOSED (no `try`)
- **`LPZapper.sol`** — periphery behind a proxy. Sequences USDC → swap → mint →
  `vault.stakeFor` in one transaction and refunds every leftover in the same call. Holds no
  funds and no NFTs between transactions. Its fixed references stay `immutable` in the
  implementation. Owner (the timelock): upgrades, `setOperator`; **operator** (the multisig):
  `setTwapParams`, `sweep`, `rescuePosition` (to the operator). The vault whitelists the PROXY
  address, which never changes across upgrades. `_zapIn` reads `vault.depositsPaused()` and
  reverts `DepositsArePaused` before any USDC moves. Zap-out is out of scope for V1
- **`TokenOverture.sol`** — the Overture token. ERC-20, 18 decimals, EIP-2612 permit (domain =
  the token PROXY), burnable. ERC-20 name "Overture", symbol "OVTR" (`LP_OVERTURE_NAME` /
  `LP_OVERTURE_SYMBOL`). Exactly one `minter` (the operator multisig at launch), moved by the
  owner (the timelock) with `setMinter`. NO cap of any kind: the operator mints `$OVTR` INTO the
  distributor, which pays it out by transfer
- **`RewardsDistributor.sol`** — cumulative-voucher claims for any number of reward tokens. One
  EIP-712 type for every token, `RewardClaim(address token,address user,uint256
  cumulativeAmount,uint256 deadline)` (typehash `0x746a03cb…0c63`, domain `("RealLPRewards",
  "1")`). `claim(token, cumulativeAmount, deadline, signature)` pays `cumulativeAmount -
  claimed[token][user]` by TRANSFER out of the distributor's own pre-funded balance; check
  order paused → `UnknownRewardToken` → `TokenClaimsDisabled` → `ClaimExpired` →
  `NothingToClaim` → `InvalidSignature` → `InsufficientFunds(token, needed, balance)`. There is
  NO cap, budget or running total: a short balance reverts the claim until the company funds the
  contract, nothing else limits it. The signed `user` is always `msg.sender`. It is upgradeable
  because `claimed[token][user]` must survive a fix — the proxy is UPGRADED, never REPLACED
  (SEC-04). Tiers — **owner** (the timelock): upgrades, `addRewardToken(token, conditional,
  claimsEnabled)`, `setRewardTokenEnabled`, `setClaimsEnabled`, `setGuardian`, `setOperator`;
  **guardian**: `setPaused`; **operator**: `setSigner`, `recoverExcess(token, amount)` (to the
  operator), `setGuardian`, `setPaused`. Launch tokens: `$ASSET` (conditional, claims CLOSED,
  opened later by the timelock) and `$OVTR` (unconditional, claims open). `enabled` only decides
  whether the registry may schedule a token; `claimsEnabled` gates `claim`. A leaked signer key
  can take the funded balances until the guardian pauses — keep the guardian hot
- **`LPEpochRegistry.sol`** — the on-chain emission SCHEDULE: per epoch `startsAt`, `endsAt` and
  the quantity of each reward token. The OPERATOR writes it with no delay (`scheduleEpoch`,
  `setEpochAmount`, `updateEpochBounds`, `cancelEpoch`); the owner upgrades it and moves the
  operator. Rules: ids `epochCount + 1`, never reused; bounds on the 900-s grid; nothing is
  scheduled or changed less than 30 minutes before its start (`SCHEDULE_MARGIN`); live epochs
  never overlap; bounds and cancel only on the last live epoch; every amount names a registered,
  enabled reward token. It bounds nothing — the backend spreads each quantity over the epoch's
  15-minute intervals

The ApeBond route (B.3 decision document 2026-10-01, overrides 2026-10-05) is two more contracts
and three libraries beside the stack above, deployed only when `LP_APEBOND_ENABLED=1` (or later
by `scripts/deploy-apebond.js`) — on **Sepolia test stack #6 only** until ApeBond goes to mainnet.
An un-flagged run is byte-for-byte the stack above, and mainnet launches with `bonusEscrow = 0`:

- **`BonusEscrow.sol`** — the whole life of a bonus, behind a **UUPS proxy**: reserve, move,
  scale, forfeit, pay. Reservations are keyed by the position's `tokenId` (no purchase id);
  `bonusToken` ($ASSET), `vault` and `bonusIsToken0` are implementation immutables. **Reserve now,
  fund later, no ceiling**: `reserve` (adapter only) records the bonus whatever the balance is,
  and `claim(tokenId)` (anyone; pays the recorded beneficiary) reverts
  `InsufficientFunds(needed, balance)` until the company funds the escrow — all or nothing. The
  bonus is **conditional on staying staked through the cliff**: the vault's `onUnstake` forfeits an
  active reservation (exists, not claimed, not forfeited, before `unlockAt`), and `onRebalance`
  moves it to the new `tokenId` scaled by `min(1, valueNew / valueOld)` at the vault's TWAP; after
  the cliff both hooks return at once and nothing can touch the bonus (a post-cliff rebalance
  leaves it under the OLD id). `recoverSurplus` moves `balance − totalReserved` and reverts
  `NoSurplus` while more is owed than held. **No pause, no guardian, no admin function that
  touches a reservation.** Owner (the timelock): upgrades, `setAdapter`, `recoverSurplus`
- **`ApeBondPositionAdapter.sol`** — the gate SoulZap deposits through, plain `Ownable`, REPLACED
  rather than upgraded (one timelock batch: `vault.setStakeOperator(new, true)`,
  `vault.setStakeOperator(old, false)`, `escrow.setAdapter(new)`). **It computes the bonus**:
  `depositFor(tokenId, campaignId, beneficiary)` values the position with
  `PositionValue.valueAt` at the vault's TWAP (reverting when spot is outside the TWAP bounds),
  takes the campaign's `bonusBps` of it, and reserves nothing below the campaign's
  `minBonusAmount` (the purchase is still staked). **No signature, no purchase id, no limit of any
  kind**: a campaign is exactly its range (exact ticks), cliff, rate and minimum. `depositFor`
  writes no storage (transient reentrancy lock and receive window). No rescue, no sweep, no
  arbitrary call. Owner (the timelock): `setCampaign`, `setCampaignEnabled`, `setCampaignCaller`,
  `setSoulZapCaller`, `setGuardian`; guardian (a pause key): `setDepositsPaused`
- **`libraries/TickMath.sol`, `libraries/LiquidityAmounts.sol`** (vendored from Uniswap's 0.8
  branches, GPL-2.0-or-later headers kept — open item O6) and **`libraries/PositionValue.sol`**
  (ours): the ONE valuation the adapter and the escrow share

The vault's side (lane 1, present on mainnet but switched off) is item 15 of the audit notes;
lane 2 adds the **stake-operator allowlist** (`setStakeOperator`, owner tier), appended after
`bonusEscrow` in the vault's namespace, which is what lets the adapter call `stakeFor`.

Both `LPStakingVault` and `LPZapper` inherit `TwapGuard`: a swap leg reverts when spot
deviates from the pool TWAP by more than `maxTwapDeviationTicks`. The guard's `pool` is
`immutable` on both; its two parameters live in an ERC-7201 namespace that each proxy's
`initialize` seeds. Callers still carry their own `amountOutMin` / `amount0Min` / `amount1Min`
— the guard is a manipulation circuit breaker, not a pricing oracle. The parameter is a tick
count, not bps: the window is bounded to 300–3600 s and the ceiling to 1823 ticks.
`scripts/deploy-lp-staking.js` keeps the human knob in bps and converts with
`floor(ln(1 + bps/1e4) / ln(1.0001))` — 500 bps = 487 ticks, 1000 = 953, 2000 = 1823.
`amountIn == 0` skips the swap and therefore the guard, deliberately.

Both also refuse unsolicited position NFTs: `onERC721Received` accepts a safe transfer only
inside their own mint/stake flow, and both carry a `rescuePosition(tokenId)` that sends a
stranded NFT to their `operator()`. The vault's is restricted to `stakerOf(tokenId) ==
address(0)`, so a staked position can never be reached by it.

Deliberate design choices an auditor is expected to question are written up in
`docs/lp-staking-audit-notes.md`: `recoverExcess` timing (item 1), two-step ownership on all
five (item 3), no cap and funding (item 5), the schedule bounds nothing (item 6), SEC-04
(item 10), upgradeability and the tiers (item 14), the vault's escrow notifications (item 15),
the ApeBond adapter (item 16) and the bonus escrow (item 17).

### Deploy order

`scripts/deploy-lp-staking.js` does all of it in one run, schedules nothing, waits out no delay
and leaves nothing to hand over:

1. Config, local validation and the on-chain checks: the pool triple, the token decimals
   (ASSET 18 / USDC 6), and the **factory check** — `factory.getPool(token0, token1, fee) ==
   LP_POOL`
2. `LPTimelock(LP_TIMELOCK_MIN_DELAY, [multisig], [multisig], address(0))`
3. `TokenOverture` implementation + `LPProxy`, `initialize(name, symbol, timelock, operator)`
4. `RewardsDistributor` implementation (no constructor arguments) + `LPProxy`,
   `initialize(timelock, guardian, operator, signer, [{ASSET, conditional, claims =
   LP_ASSET_CLAIMS_ENABLED (default 0)}, {OVTR, unconditional, claims open}])`
5. `LPEpochRegistry(distributor)` implementation + `LPProxy`, `initialize(timelock, operator)`
6. Predict the zapper PROXY: `getCreateAddress({from: deployer, nonce: N + 3})` — vault
   implementation N, vault proxy N + 1, zapper implementation N + 2, zapper proxy N + 3
7. `LPStakingVault(positionManager, pool, token0, token1, fee, router)` + `LPProxy`,
   `initialize(timelock, guardian, operator, predictedZapper, twapWindow, maxDeviationTicks)`;
   `bonusEscrow` stays zero
8. `LPZapper(vault, positionManager, pool, token0, token1, fee, router, usdc, asset)` +
   `LPProxy`, `initialize(timelock, operator, twapWindow, maxDeviationTicks)`; recorded FIRST,
   then asserted equal to the prediction (the repair if not: `setZapper` through the timelock)
9. `pool.increaseObservationCardinalityNext(target)` — permissionless
10. Post-deploy verification of all five proxies (ERC-1967 implementation slot, EMPTY admin
    slot, owner == timelock, pendingOwner == 0), the token's name/symbol/minter/zero supply,
    the distributor's `rewardTokens()` and flags and `REWARD_CLAIM_TYPEHASH`, the registry's
    distributor/operator/`epochCount == 0`/constants, `vault.bonusEscrow() == 0`, the zapper's
    operator, the timelock's roles; the address summary, the verify commands (two per proxy),
    and the operator's next steps

Every proxy is born through `scripts/lib/proxies.js` `deployProxyPair`:
`upgrades.validateImplementation`, the implementation, the `LPProxy` with the `initialize`
calldata, and `upgrades.forceImport`, which records the storage layout in
`.openzeppelin/<network>.json` (committed on named networks; OS temp dir on dev chains).

After the deploy the operator multisig, with no delay: funds the distributor
(`scripts/lp-fund-rewards.js`: `LP_FUND_OVTR_AMOUNT`, `LP_FUND_ASSET_AMOUNT`, placeholders to be
decided with Brandon) and schedules epoch 1 at least 30 minutes ahead (`scripts/lp-epoch.js`).
A new reward token later: `scripts/add-reward-token.js` + the `addRewardToken` timelock
operation, then funding and `lp-epoch.js set-amount`.

### Operational gotchas

- **Fund before claims.** A claim of a token the distributor does not hold enough of reverts
  `InsufficientFunds(token, needed, balance)`; nothing pays partially and nothing else limits a
  claim. Keep the funded balance close to what is owed: it is also what a leaked signer key
  could take before the guardian pauses
- **Schedule at least 30 minutes ahead, on the grid.** `LPEpochRegistry` refuses a start less
  than `SCHEDULE_MARGIN` (1800 s) away and any bound off the 900-s grid. A Safe transaction can
  sit for hours: check the time it will EXECUTE. To change an earlier future epoch, cancel back
  to it and schedule again
- **`$ASSET` claims are closed at launch** and opened by the timelock
  (`setClaimsEnabled(ASSET, true)`, 48 h). `$OVTR` claims are open from the deploy
- **Grow the oracle, then wait.** `increaseObservationCardinalityNext` only allocates
  observation slots; they fill one per block that trades. Until the pool holds `twapWindow`
  seconds of history, `observe()` reverts with `OLD` and every TWAP-guarded path (`zapIn`,
  and any `rebalance` carrying a swap leg) reverts with it. Paths without a swap work from
  block one
- **The oracle is sized, not guessed.** `LP_OBSERVATION_CARDINALITY` defaults to 150 and the
  deploy script refuses anything below `2 × ceil(LP_TWAP_WINDOW / 12)`
- **Guard defaults are wide on purpose.** `LP_TWAP_WINDOW=300`, `LP_TWAP_MAX_DEVIATION_BPS=1000`
  (= 953 ticks). A narrow guard locks `rebalance` out exactly when a position has fallen out
  of range and needs re-ranging; the caller's own minimums are the primary protection
- **`BonusHookFailed` must be alerted on** whenever a bonus escrow is linked: it means an exit
  completed while the escrow's forfeiture failed

## Project Structure

```
contracts/           — Solidity source files
  StakingPool.sol           — Original time-weighted staking contract
  WeightedStakingPool.sol   — Staking with EIP-712 attested weight multipliers
  MockERC20.sol             — Test-only 18-decimal ERC20 mock
  MockERC20Decimals.sol     — Test-only ERC20 mock with configurable decimals (6-dec USDC-like)
  lp-staking/          — The LP staking stack; imports stay relative inside this folder
    LPStakingVault.sol        — Custody and atomic re-ranging for Uniswap V3 LP positions, and
                                the bonus-escrow notifications (off at launch); UUPS
    LPZapper.sol              — USDC in, staked position out; UUPS, operator tier
    TokenOverture.sol         — The Overture token ($OVTR): one minter, no cap; UUPS
    RewardsDistributor.sol    — EIP-712 `RewardClaim` cumulative claims for any number of
                                pre-funded reward tokens; UUPS
    LPEpochRegistry.sol       — The on-chain emission schedule, operator-run; UUPS
    BonusEscrow.sol           — ApeBond bonuses keyed by tokenId: reserve, forfeit, scale, pay;
                                UUPS (lane 2, Sepolia #6 only)
    ApeBondPositionAdapter.sol — The SoulZap gate; computes the bonus at the vault's TWAP;
                                plain Ownable, replaceable (lane 2, Sepolia #6 only)
    deploy/LPProxy.sol        — OZ ERC1967Proxy, nothing added; the repo's own artifact
    deploy/LPTimelock.sol     — OZ TimelockController, nothing added; owner of the five proxies
    interfaces/               — Vendored Uniswap V3 interfaces (position manager, router, pool),
                                IRewardsDistributor, ILPEpochRegistry, IBonusEscrowHooks
    libraries/TwapGuard.sol   — Shared spot-vs-TWAP check and the SwapParams struct
    libraries/TickMath.sol, LiquidityAmounts.sol — Uniswap math, vendored and trimmed (GPL headers)
    libraries/PositionValue.sol — The one position valuation the adapter and the escrow share
    mocks/                    — Test-only Uniswap doubles, permit token, reentrancy attackers,
                                the five V2 mocks (upgrade tests), three bonus-escrow mocks
                                (MockBonusEscrow, MockLightBonusEscrow, MockForfeitingBonusEscrow),
                                BonusEscrowV2Mock, LPStakingVaultV3Mock, the SoulZap caller double,
                                MockUniswapV3Factory, MockMathPositionManager (real liquidity math,
                                for the B.3 vector), LPStakingVaultLane1Mock (lane 1's mainnet
                                vault verbatim, for the in-place activation suite)
                                and the two swap harnesses LPStakingVaultSwapHarness.sol /
                                LPZapperSwapHarness.sol, which expose their parent's internal
                                `_executeSwap` so the ZeroAmount arm can be reached
test/                — Hardhat test files (Mocha + Chai). 714 tests, 0 pending
  StakingPool.test.js         — 88 tests
  WeightedStakingPool.test.js — 40 tests
  lp-staking/
    LPStakingVault.test.js      — 115 tests, incl. the upgrade, timelock and escrow-hook paths
    RewardsDistributor.test.js  — 91 tests, per token, incl. the upgrade and timelock paths
    LPEpochRegistry.test.js     — 50 tests
    TokenOverture.test.js       — 41 tests, through the proxy
    LPZapper.test.js            — 63 tests, through the proxy, incl. the operator tier
    DeployImplementation.test.js — 16 tests, the five implementation kinds
    fork/LPStakingFork.test.js  — 21 mainnet-fork tests; skip themselves without MAINNET_RPC_URL
    helpers/                    — fork harness: fork-node, chain, rpc, uniswap, signing
                                  (`signRewardClaim`), scripts, ledger, constants, profiles
    helpers/profiles.js         — the network profile (sepolia default, mainnet phase 2)
    integration/LPStakingLocalFork.test.js
                                — 95 tests on a spawned `hardhat node --fork`, mainnet-pinned;
                                  deploys via the repo's own scripts and ends with the planned
                                  timelock switch. Same skip rule as fork/
    integration/LPStakingSepoliaFork.test.js
                                — 94 tests, the same scenario driven through the profile
test-live/           — REAL transactions. Never in CI, never in `npx hardhat test`
  sepolia/SepoliaLive.test.js — gated smoke run against live Sepolia; see "Test tiers"
test/forge/          — Foundry tier. 546 tests in 28 suites: 102 fork, 401 unit, 21 fuzz,
                       22 invariant
  utils/                      — plain .sol scaffolding; forge ignores it as non-test
    BaseForge.sol               — constants, the active profile, the skip-vs-fail rule
    ForkHarness.sol             — the stack against real Uniswap on a pinned fork
    LocalHarness.sol            — the stack against the repo's own mocks, deterministic
    Profiles.sol                — the same network facts as helpers/profiles.js
    RawTickPool.sol             — a pool whose `observe` returns raw, caller-chosen cumulatives
    attackers/                  — hostile tokens, malicious NPM, reentrant router, receivers,
                                  a vault that misreports its custody
  fork/ unit/ fuzz/ invariant/  — *.t.sol; the taxonomy is the directory
foundry.toml         — solc/evm/optimizer mirror hardhat.config.js; profiles, fmt, lint
remappings.txt       — @openzeppelin -> node_modules, forge-std -> lib/forge-std
lib/forge-std        — git submodule; CI must check out with `submodules: recursive`
.solcover.js         — solidity-coverage skipFiles: mocks, interfaces, the two legacy pools
docs/                — Design and review notes
  lp-staking-audit-notes.md — Deliberate properties of the LP stack an auditor will flag,
                              plus the five SEC-0x findings, the behaviours tests now pin, and
                              the ApeBond route's two contracts (items 16 and 17)
scripts/             — Deployment and interaction scripts (see scripts/README.md)
  lib/pools.js              — Shared: address resolution, pool-kind detection,
                              mainnet CONFIRM guard, Ledger nonce workaround
  lib/uniswap.js            — Per-chain Uniswap V3 addresses (factory, positionManager,
                              swapRouter02) for chain 1 and 11155111; imported by
                              deploy-lp-staking.js and create-sepolia-pool.js so they cannot
                              drift apart
  lib/proxies.js            — deployContract / deployProxyPair: the one code path every proxy is
                              born through (validate, implementation, LPProxy, forceImport)
  deploy-lp-staking.js      — Deploys the whole LP stack: the timelock first, then the five
                              proxies, each born owned by it with its final roles and links
  lp-fund-rewards.js        — Operator funds the distributor: mints $OVTR into it, sends $ASSET
  lp-epoch.js               — Operator drives LPEpochRegistry: show / schedule / set-amount /
                              update-bounds / cancel, from whole-token quantities
  add-reward-token.js       — Prepares a new reward token and prints its addRewardToken
                              timelock operation
  lp-timelock.js            — Operator front end for the timelock: schedule / execute / cancel /
                              status / pending, plus the operation and batch builders
  lp-switch-timelock.js     — Planned switch of all five proxies to a new timelock
  lib/apebond.js            — The ApeBond pair's deploy, wiring, link batch and link checks,
                              shared by the two scripts below
  deploy-apebond.js         — The ApeBond route on a LIVE stack: activate (upgrading a lane-1
                              vault first) | replace-adapter | upgrade-vault | verify
  fund-escrow.js            — Sends $ASSET into the escrow; TARGET=0 covers what is owed
  apebond-rehearsal.js      — Test-stack rehearsal: caller, deposit, loop, withdrawal, claim
  deploy-implementation.js  — One new implementation for a live proxy (six kinds, BonusEscrow incl.)
  validate-upgrade-safety.js — UUPS implementation safety (network-free) and, against a
                              committed manifest, the storage-layout check. CI runs it
  create-sepolia-pool.js    — Creates the integration ASSET-USDC pool; refuses to run on mainnet
  run-forge.mjs             — forge wrapper: loads .env, resolves the fork endpoint, runs forge
  check-coverage.mjs        — Blocking coverage gate; check-coverage.test.mjs tests it
abi/                 — Checked-in ABIs for both pools, the five LP contracts and the ApeBond pair
deployments.json     — Deployed addresses keyed by chain id
.env.example         — Every variable hardhat.config.js and the scripts read
.github/workflows/ci.yml — Two jobs: hardhat (compile, upgrade-safety, unit + three fork
                           suites) and forge
```

Every script is network- and pool-agnostic: the address comes from
`deployments.json` or `POOL=0x…`, the kind is detected on-chain by probing
`BASE_WEIGHT()`, and token decimals are read from the token. State-changing
scripts refuse to run on chain 1 without `CONFIRM=yes`.

## Commands

```bash
npx hardhat compile                 # Compile contracts (Hardhat)
npm run validate:upgrades           # UUPS implementation safety + layout vs the manifest
npx hardhat test                    # Everything Hardhat owns: unit + three fork suites
npm run test:integration            # Just the mainnet-pinned local-fork integration suite
npm run test:integration:sepolia    # Just the profile-driven fork integration suite
npm run test:sepolia:live           # Gated live-Sepolia smoke; REAL transactions, never CI

# The ApeBond activation on a live (lane-1, mainnet-shaped) stack, on a plain spawned node.
npx hardhat test test/lp-staking/integration/ApeBondUpgradeInPlace.test.js

npm run test:forge                  # Foundry: fork + unit + fuzz + invariant
npm run test:forge:ci               # Same, ci profile (fuzz 1024, invariants 512 sequences)
npm run coverage:forge              # forge coverage: lcov + a summary table
npm run coverage:forge:check        # Same, then the blocking per-file floors gate
node --test scripts/check-coverage.test.mjs   # The gate's own tests (no forge, no network)

npx hardhat coverage                # solidity-coverage over everything under test/
npm run test:coverage:unit          # solidity-coverage over the five LP unit suites only
```

## Test tiers

Nine tiers, two toolchains. Hardhat owns the scenario and the deployment scripts; Foundry owns
the adversarial and branch-coverage work, because `forge coverage` reports real per-branch
numbers and `vm.createSelectFork` reaches live Uniswap without spawning a node.

| tier | where | run by | needs |
|---|---|---|---|
| Hardhat unit (mocks) | `test/lp-staking/*.test.js` | `npx hardhat test` | nothing |
| Hardhat script suite on a spawned local node | `test/lp-staking/DeployApeBond.test.js`, `test/lp-staking/ApeBondOperatorScripts.test.js`, `test/lp-staking/integration/ApeBondUpgradeInPlace.test.js` | `npx hardhat test` | nothing (a plain `hardhat node`, no fork) |
| Hardhat in-process mainnet fork | `test/lp-staking/fork/LPStakingFork.test.js` | `npx hardhat test` | mainnet archive RPC |
| Hardhat local-fork integration, mainnet-pinned | `test/lp-staking/integration/LPStakingLocalFork.test.js` | `npm run test:integration` | mainnet archive RPC |
| Hardhat fork integration, profile-driven | `test/lp-staking/integration/LPStakingSepoliaFork.test.js` | `npm run test:integration:sepolia` | archive RPC for the profile's chain |
| Live Sepolia smoke — gated, **never CI** | `test-live/sepolia/SepoliaLive.test.js` | `npm run test:sepolia:live` | `SEPOLIA_LIVE=1` + `PRIVATE_KEY` + endpoint |
| Foundry fork (real state) | `test/forge/fork/` | `npm run test:forge` | archive RPC for the profile's chain |
| Foundry unit (deterministic) | `test/forge/unit/` | `npm run test:forge` | nothing |
| Foundry fuzz (properties) | `test/forge/fuzz/` | `npm run test:forge` | nothing |
| Foundry invariant (campaigns) | `test/forge/invariant/` | `npm run test:forge` | nothing |

`npx hardhat test` runs the first five (`paths.tests` is `./test`). It does **not** and must
never run `test-live/`.

The **ApeBond route has no tier of its own.** Its unit coverage sits in the Hardhat unit tier
(`ApeBondPositionAdapter.test.js`, `BonusEscrow.test.js`) and the Foundry tiers
(`ApeBondAdapterBranches.t.sol`, `BonusEscrowBranches.t.sol`, `BonusEscrowHooks.t.sol` through the
real vault, `PositionValue.t.sol`, `fork/PositionValueFork.t.sol`,
`invariant/BonusEscrowInvariants.t.sol`); its deploy and link scripts are `DeployApeBond.test.js`;
the operator scripts that follow (`fund-escrow.js`, `apebond-rehearsal.js`) are
`ApeBondOperatorScripts.test.js`; the in-place activation of a lane-1 (mainnet-shaped) vault is
`integration/ApeBondUpgradeInPlace.test.js`; and the end-to-end scenario on real Uniswap is the
ApeBond section of the two fork-integration suites, which deploy a SECOND stack with
`LP_APEBOND_ENABLED=1`, link it with `deploy-apebond.js`, and assert that the first, un-flagged
stack has no ApeBond route at all.

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

This is the spec's Sepolia test stack #5 rehearsal. It sends REAL transactions and, on a first
run, records the deployment in the **tracked** `deployments.json` under chain `11155111`.

Gates (all three, or the suite skips and names what is missing): `SEPOLIA_LIVE=1`,
`PRIVATE_KEY`, and `SEPOLIA_RPC_URL` or `INFURA_API_KEY`. Two further one-time gates, off by
default: `SEPOLIA_LIVE_CREATE_POOL=1` creates the pool (**permanent** — the address is fixed
forever; needs an explicit go the first time), `SEPOLIA_LIVE_DEPLOY=1` deploys the stack — the
`LPTimelock` and the five proxies — and writes it into the tracked registry. There is no
handover to wait for: every proxy comes out of that run already owned by the timelock. Optional
`LP_SIGNER_KEY` redeems a real 1-wei `$OVTR` voucher; without it the suite proves a foreign
voucher is refused by static call. The suite targets the stack it deploys; the abandoned stack
#5 entries in `deployments.json` run the pre-v1 contracts and are not a valid target.
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
npm run test:coverage:unit     # solidity-coverage over the five Hardhat LP unit suites
```

`scripts/check-coverage.mjs` is the blocking one. It recomputes totals from the raw `DA:` /
`BRDA:` records (never from the optional `LF` / `BRF` summary lines), scopes to the five LP
contracts plus `libraries/TwapGuard.sol`, and pins both the floors and their DENOMINATORS —
so a moved measurement basis fails loudly instead of being graded against a bar that no longer
describes it. `--ir-minimum` is not optional: coverage disables the optimizer and the
un-optimized build hits "Stack too deep" in `WeightedStakingPool.sol` without it. The npm
script passes `LP_COVERAGE_BASIS=forge-1.7-ir-minimum` and the checker refuses to grade a run
without it. The `forge-1.7` half names the toolchain, which is why CI pins
`foundry-rs/foundry-toolchain` to `v1.7.1` instead of `stable` — a newer forge attributes
`--ir-minimum` coverage differently. Bump the pin and the basis together, never one alone.

Re-measured 2026-10-05 — branch coverage is 100% on all six files, so every branch floor is
also the ceiling:

| file | lines | branches |
|---|---|---|
| `LPStakingVault.sol` | 97.91% (187/191) | 100.00% (34/34) |
| `LPZapper.sol` | 96.08% (98/102) | 100.00% (20/20) |
| `RewardsDistributor.sol` | 97.54% (119/122) | 100.00% (18/18) |
| `LPEpochRegistry.sol` | 96.46% (109/113) | 100.00% (21/21) |
| `TokenOverture.sol` | 84.62% (22/26) | 100.00% (2/2) |
| `libraries/TwapGuard.sol` | 97.67% (42/43) | 100.00% (7/7) |

The twenty uncovered lines are the six ERC-7201 accessor bodies, the five implementations'
`_disableInitializers();`, the empty OZ initializers (`__Ownable2Step_init();` ×5,
`__ERC20Burnable_init();`), the two `_checkTwapDeviation();` call sites and one `break;` in
`LPEpochRegistry.setEpochAmount`. All are demonstrably executed — this is `--ir-minimum` losing
the mapping, not a gap. They are named with their line numbers in the checker and in the audit
notes instead of being chased with contrived tests.

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
`hardhat run --network localhost`; the operator then funds the distributor with
`scripts/lp-fund-rewards.js` and schedules epoch 1 with `scripts/lp-epoch.js`. Forty-eight
scenario steps follow, one transaction per block — among them epochs scheduled, cancelled and
frozen on the registry, `$OVTR` and `$ASSET` claims per token, the `$ASSET` claims opened
through the timelock, and a third reward token added through the timelock that reverts
`InsufficientFunds` until it is funded — and the next sections assert that everything they
emitted is stored on that chain and retrievable from it: by address, by indexed topic, by block
hash, in chunked ranges, and from receipts. A snapshot revert proves an orphaned block really
disappears. The last section runs `scripts/lp-switch-timelock.js` end to end and moves all
five proxies to a new timelock.

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

## ApeBond activation on a live stack

`test/lp-staking/integration/ApeBondUpgradeInPlace.test.js` rehearses the day ApeBond reaches a
stack that is ALREADY live — mainnet as it launches on 7 Oct, with lane 1's vault: the escrow
hooks present, `bonusEscrow = 0`, and no stake-operator allowlist. It runs on a plain spawned
`hardhat node` (no fork, no RPC), so it is part of `npx hardhat test`. It deploys the core stack
with `LP_VAULT_CONTRACT=LPStakingVaultLane1Mock` (lane 1's vault verbatim, a test-only copy),
stakes a position, and runs `scripts/deploy-apebond.js` unmodified as a child process: a new
`LPStakingVault` implementation (hardhat-upgrades validates the lane-1 → current layout,
`stakeOperators` appended after `bonusEscrow`), the escrow and the adapter, the adapter's campaign
and callers, and ONE timelock batch — `upgradeToAndCall`, `setBonusEscrow`, `setStakeOperator`,
`setAdapter` — waited out in chain time and executed, then the mandatory link checks and the
state-preservation checks.

The purchases that follow pin the B.3 decisions: a buyer who unstakes the moment the purchase
lands **forfeits the bonus** (`BonusForfeited`; a claim after the cliff reverts `Forfeited`) —
the inverse of what the signature-era suite asserted — while a buyer who stays past the cliff is
paid once `fund-escrow.js` covers the reservation (`InsufficientFunds` before).

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

### LP staking — the ApeBond route (2026-09-08, refactored 2026-10-05 per the B.3 decisions)

- **The escrow is upgradeable and the adapter is not** — team decision, vikinatora, 2026-09-08.
  The split is by what a contract HOLDS. `BonusEscrow` holds the ledger of who is owed what, so it
  is a UUPS proxy behind the same `TimelockController`. `ApeBondPositionAdapter` holds only
  configuration (campaigns and callers; no id book since the refactor), so it is REPLACED with one
  timelock batch — `vault.setStakeOperator(new, true)`, `vault.setStakeOperator(old, false)`,
  `escrow.setAdapter(new)`. The vault's `stakeFor` allowlist exists so that never takes the
  zapper's slot
- **The contract computes the bonus** (B.3 P1): value of the position at the vault's TWAP ×
  `bonusBps`, nothing below `minBonusAmount`. No signature, no purchase id, no backend number; the
  backend's `bonus-quote` is an estimate of this formula
- **No limit of any kind** (override O2, 2026-10-05): reserve now, fund later. No per-purchase,
  per-campaign, daily or total cap; `reserve` checks no balance; `claim` reverts
  `InsufficientFunds` until the company funds the escrow; the backend alerts when owed > balance
- **The bonus is lost by an exit before the cliff and follows a rebalance, scaled** (D1–D3): the
  vault notifies the escrow on every `unstake` (fail open) and `rebalance` (fail closed). A buyer
  who unstakes the position before the cliff is NOT paid
- **The campaign numbers are samples** until ApeBond and the business close open items O3 and O5:
  `test/lp-staking/helpers/constants.js` carries a 1,000 bps rate, a 1-ASSET minimum, a 300-second
  cliff (test stacks; production TBD) and a ±1200-tick range. Nothing on-chain hard-codes any of
  them — each is a campaign field the timelock sets
