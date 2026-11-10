# LP staking — audit notes

Known and deliberate properties of the V1 LP staking stack (`LPStakingVault`, `LPZapper`,
`TokenOverture`, `RewardsDistributor`, `LPEpochRegistry`, `libraries/TwapGuard`) and of the
ApeBond route beside it (`ApeBondPositionAdapter`, `BonusEscrow`, `libraries/TickMath`,
`libraries/LiquidityAmounts`, `libraries/PositionValue` — items 17 and 18). Each item is
something a reviewer is expected to flag; each is recorded here with the reasoning behind the
decision so the answer does not have to be reconstructed from the diff.

Revision 2026-10-05 (Wednesday launch, tracks M / P / R / U): the pre-v1 reward token is replaced
by the Overture token (`TokenOverture`, ticker `$OVTR`), which carries no cap of any kind;
`RewardsDistributor` v1 pays any number of pre-funded reward tokens against one `RewardClaim`
voucher type; the emission schedule moved on-chain into `LPEpochRegistry`; all five LP
contracts are UUPS proxies owned by the timelock; the vault gained the bonus-escrow
notifications, OFF at launch (item 15). Items 1, 3, 5, 6, 10 and 14 were rewritten for it.

Revision 2026-10-05, lane 2 (the B.3 ApeBond refactor; on Sepolia test stack #6 since 6 Oct, and
part of the mainnet launch deploy since the decision of 14 Oct 2026): the adapter computes the
bonus from the position (no signature), the escrow keys reservations by `tokenId`, records them
with no balance check and forfeits or scales them through the vault's notifications, and the
vault gained the stake-operator allowlist after `bonusEscrow`. Items 17 and 18 were rewritten for
it.

Revision 2026-10-07: the Overture token's minter is the `RewardsDistributor` PROXY, and the
operator mints through the distributor's new operator-only `mintRewardToken(token, to, amount)`
— to a user's wallet or into the distributor — outside the claim flow. `$ASSET` is refused there
by address (`AssetNotMintable`), from a new `asset` field appended to the distributor's
namespace; a live v1 proxy gets it from `initializeV2` inside the upgrade. New item 16; items 1,
3, 5, 10 and 14 were touched for it.

Revision 2026-10-14 (audit rows C-12 to C-15 and C-29 of 7 Oct 2026, and Vladimir's decision of
14 Oct 2026 on the campaign band): `depositFor` first checks that `vault.bonusEscrow()` is the
adapter's escrow and reverts `EscrowNotLinked` otherwise, so no bonus is reserved that an early
exit could not forfeit (C-12). The vault's `setBonusEscrow` reverts `EscrowHasReservations` while
the current escrow's `totalReserved()` is above zero, so no live reservation loses its exit
reports (C-13). The adapter takes an immutable `minCliffSeconds` (zero refused with
`ZeroMinCliff`) and `setCampaign` refuses a shorter cliff with `CliffBelowMinimum`, which the
deploy scripts set to 86,400 s by default and never lower on mainnet (C-14).
`scripts/lp-switch-timelock.js` moves `BonusEscrow`, the adapter and every recorded reward token
the old timelock owns together with the five proxies (C-15). The adapter's `setGuardian` takes the
owner OR `vault.operator()` (`NotOwnerOrOperator` otherwise), so a leaked pause key is replaced
without the 48 h timelock delay (C-29). A campaign no longer stores an exact tick range:
`CampaignConfig{enabled, downTicks, upTicks, toleranceTicks, bonusCliffSeconds, bonusBps,
minBonusAmount}` places the band around the pool's spot tick at each purchase (`campaignRange`,
defaults 6932 / 6932 / 500 ticks), and an NFT edge further than `toleranceTicks` from the band's
edge reverts `TickRangeOutsideTolerance`. Item 17 was touched for it.

Revision 2026-11-09 (the staking v3 campaign): three new UUPS contracts under
`contracts/staking-v3/` (`WeightedStakingPoolV3`, `V3BonusVault`, `StakingMigrator`) and the vault's
owner-tier `setBonusListener`, whose two notifications fail open with their own 250,000 gas
allowance (owner-configurable since the same evening, default 1,000,000: item 20). New item 19 is the scope note for the audit. Its "Changes after the internal security
review" block lists the fix round of the same day.

Revision 2026-11-09, evening (Glamsterdam): the vault's two fail-open hook allowances are no longer
constants. `setBonusHookGas(escrowGas, listenerGas)` (owner, 100,000..3,000,000 each, event
`BonusHookGasSet`), defaults 400,000 / 1,000,000 written by `initialize` or, on a live vault, by
`initializeV2()` inside the upgrade. New item 20; items 15 and 19 and the I-01 operator note point
to it.

Revision 2026-11-10 (stale LP record): the vault's notification of the listener's `onRebalance` is
FAIL CLOSED like the escrow's (no `try`, no allowance); `onUnstake` stays fail open. `V3BonusVault`
pays an LP record only while the vault holds the position for its user or once settled by a
notification after the unlock (`lpSettled`, appended; `LpBonusSettled`), and `reconcileLp` cleans a
stale record after the unlock too. Items 19 ("Change of 2026-11-10") and 20 ("Follow-up").

Nothing here is an open bug. Items that need a decision before deployment say so.

---

## 1. `recoverExcess` has no timing restriction

`RewardsDistributor.recoverExcess(token, amount)` transfers any token out at any time, in any
amount up to the contract's balance, including tokens that pre-fund vouchers users have not
claimed yet. There is no "only after the program ends" gate — unlike
`StakingPool.recoverExcessRewards()`, which requires `block.timestamp >= endEpoch`.

Deliberate. Every reward token is funded ad hoc by the company (the operator mints `$OVTR` into
the distributor through `mintRewardToken` and transfers `$ASSET` into it) and the vouchers are cumulative with no program
end date on-chain, so there is no schedule a timing rule could key off; any threshold would be an
arbitrary number that also blocks legitimate cleanup — overfunding, a retired reward token, a
stray transfer of an unrelated token. Two properties bound the exposure:

- **The recipient is fixed to `operator()`.** The function takes no destination argument, so a
  compromised or mistaken call cannot route funds to a third party — it can only move them to
  the operator multisig, which is also the party that funds the balances.
- **A short balance never pays partially.** A claim whose token balance is below the payment
  reverts `InsufficientFunds(token, needed, balance)` and writes nothing, so a recovery that
  over-reaches leaves claims REVERTING until the operator funds the contract again — it cannot
  make a user lose an entitlement, because `claimed[token][user]` only moves on a full payment.

Net effect: each token's solvency reduces to trust in the operator multisig. Accepted, and the
same sentence is in the function's own NatSpec, so a reader of the contract meets the assumption
without opening this file.

## 2. The TWAP ceiling is measured in ticks (fixed 2026-08-26)

**Was:** `_checkTwapDeviation` compared the tick difference against `maxTwapDeviationBps`
taken as a tick count, one bp read as one tick. A tick is a 1.0001x price step and steps
compound, so the guard admitted up to ~11% more price movement than the number said —
2000 bps configured let ~2214 bps through. The 2026-08-26 review asked for an exact
conversion.

**Now:** the parameter IS a tick count. `maxTwapDeviationTicks` is what the owner stores and
what the guard compares against; nothing converts anything on-chain, so there is no error
left to describe. The bound is `MAX_TWAP_DEVIATION_TICKS = 1823`.

The conversion an operator needs to size the parameter in basis points is exact and lives
off-chain, in `scripts/deploy-lp-staking.js`:

```
ticks(bps) = floor( ln(1 + bps / 1e4) / ln(1.0001) )
```

| bps | ticks | note |
|---|---|---|
| 500 | 487 | |
| 1000 | 953 | the deployed default (10% price move) |
| 2000 | 1823 | `MAX_TWAP_DEVIATION_TICKS`, a 20% price move |

The deploy script keeps `LP_TWAP_MAX_DEVIATION_BPS` as the human-facing knob, converts with
that formula and logs both numbers. A logarithm was deliberately NOT added on-chain: it
would be audit surface in the custody contract, used only by a circuit breaker.

What has not changed is what the guard is for. It is a manipulation circuit breaker, not a
pricing oracle: it caps the damage of a compromised frontend feeding `amountOutMin ~ 0` on a
custodied position, and no slippage protection rests on it. The exact bounds are the
caller's own `amountOutMin`, `amount0Min` and `amount1Min`.

## 3. Ownership: all five contracts are two-step and non-renounceable

**Fixed 2026-09-10 (finding N-1), extended 2026-10-05.** Every LP contract — `LPStakingVault`,
`RewardsDistributor`, `LPEpochRegistry`, `TokenOverture`, `LPZapper` — is
`Ownable2StepUpgradeable` behind a proxy and overrides `renounceOwnership()` to revert
`RenounceDisabled()`, so all five behave identically:

- `transferOwnership(newOwner)` only NOMINATES. `owner()` does not move, `pendingOwner()` is
  set, and the handover completes only when the nominee itself calls `acceptOwnership()`. A
  mistyped address is recoverable for as long as nobody accepts it — nominate again, or
  `transferOwnership(address(0))` to clear the nomination.
- `renounceOwnership()` reverts `RenounceDisabled()` for the owner and
  `OwnableUnauthorizedAccount` for anybody else. No contract in this stack can be left
  ownerless, by accident or on purpose.

The original finding, kept for the record: the two then non-upgradeable contracts (the reward
pre-v1 reward token, and the zapper) used plain `Ownable`, so `transferOwnership` took
effect immediately with no acceptance from the new owner and the inherited
`renounceOwnership()` was callable and set the owner to `address(0)`. A wrong address in either
call bricked every admin path permanently, with no recovery.

Who owns what after a deployment — item 14 holds the full matrix: all five proxies are owned by
the `LPTimelock` from their own deployment transaction onwards. Nothing is handed over after the
deploy; the operator multisig holds the operator tier by `initialize`, not by ownership — and
with it `mintRewardToken`, its only road to minting `$OVTR`, since the Overture token's minter is
the distributor proxy (item 16).

**What a LOST owner (a dead timelock, decision T19 case 2) still costs, per contract.**
Renouncing is impossible, but the timelock can still become unusable, so this table is the
failure analysis:

| Contract | Lost | Survives |
|---|---|---|
| `TokenOverture` | the upgrade path, `setMinter` | transfers, `permit`, `burn`; `mint` by the standing minter — the distributor, driven by the operator's `mintRewardToken` — keeps working |
| `LPZapper` | the upgrade path, `setOperator` | `zapIn` / `zapInWithPermit`; the operator's `setTwapParams`, `sweep`, `rescuePosition` |
| `LPEpochRegistry` | the upgrade path, `setOperator` | the operator's whole schedule (`scheduleEpoch`, `setEpochAmount`, `updateEpochBounds`, `cancelEpoch`) — the program keeps running for every token already registered |
| `LPStakingVault` | the upgrade path, `setZapper`, `setBonusEscrow`, `setStakeOperator` (lane 2), `setOperator` | everything else; the three tiers are independent slots, so the guardian's pauses and the operator's `setTwapParams` / `rescuePosition` / `setGuardian` stay. `stake` and `unstake` were never the owner's to lose |
| `RewardsDistributor` | the upgrade path, `addRewardToken`, `setRewardTokenEnabled`, `setClaimsEnabled`, `setOperator` | `claim` for every registered token whose claims are open; the guardian keeps `pause`, the operator keeps `unpause`, `setSigner`, `recoverExcess`, `mintRewardToken` and `setGuardian` |

The staker-facing consequence is limited: no staked position can be trapped by a lost owner,
because `unstake` is permissionless and unpausable, and claims of open tokens keep paying. The
program-facing consequence is the frozen owner tier: no upgrade, no new reward token, `$ASSET`
claims cannot be opened if they were still closed. The way out is the migration of decision T19
case 2 (`scripts/README.md`, "Replacing the timelock") — a planned switch to a new timelock
(case 1) is only possible while the old one works.

**Before deployment:** confirm every role address by executing a no-op transaction from it
first.

Tests: `test/forge/unit/AccessControl.t.sol` — the tier matrix per contract, plus
`test_Ownership_TransferOnlyNominatesOnAllFiveContracts`,
`test_Ownership_AcceptanceIsWhatMovesTheOwnerOnAllFive`,
`test_Ownership_OnlyTheNomineeCanAcceptOnAllFive`,
`test_Ownership_TransferToZeroClearsThePendingOwnerOnAllFive`,
`test_Ownership_AnUnacceptedTransferIsRecoverableOnAllFive`,
`test_Ownership_NoneOfTheFiveCanBeRenounced`,
`test_Ownership_AStrangerIsRejectedOnRenounceByTheOwnershipCheck`,
`test_Ownership_EveryUpgradeIsOwnerOnlyOnAllFive`, the `test_Renounce_*` handover-cost cases for
each contract and tier, `test_Renounce_AFullyOwnerlessStackStillServesEveryUserPath`,
`test_Renounce_AnAbandonedStackCanNeverOpenAddScheduleOrMint` and
`test_Tiers_TheOperatorCanRevokeTheGuardianWithNoDelay`. Hardhat: the two-step and
`RenounceDisabled` cases in `test/lp-staking/TokenOverture.test.js`,
`test/lp-staking/LPEpochRegistry.test.js` and `test/lp-staking/LPZapper.test.js`.

## 4. Whole-balance mint and refund award stray ERC-20 balances to the next caller

`LPStakingVault._mintPosition` and `LPZapper._mintPosition` pass the contract's **entire**
token0/token1 balance as the mint's desired amounts, and `_refundDust` sends the **entire**
remaining balance to the caller. Neither tracks what the current call itself brought in.

Consequence: if someone transfers token0 or token1 straight to the vault or the zapper, that
balance is minted into — and refunded to — whoever calls `rebalance` or `zapIn` next. The
owner cannot sweep it back; it is gone with the next caller. Two existing tests pin the
behaviour: *"treats any balance already sitting in the vault as the rebalancer's own"* and
*"refunds any stranded balance to whoever zaps next"*.

**Deliberate — implementer decision, 2026-08-19.** The reasoning:

- **Only misdirected funds are ever at risk.** Both contracts are drained of both tokens at
  the end of every call, so a pre-existing balance can only be a mistaken transfer. Staked
  value lives inside the position NFTs and no ERC-20 balance path can reach it.
- **Per-call tracking buys stakers nothing** and would leave the dust stranded on every pass,
  turning a self-clearing state into a permanent one.
- **Anything else is recoverable.** Tokens other than the pool pair have no such path and are
  recovered by the owner — `LPZapper.sweep` for ERC-20s, `rescuePosition` on both contracts
  for position NFTs. The whole-balance rule is scoped to exactly the two pool tokens.

The trade is: mistaken transfers of the two pool tokens go to the next user instead of back
to the sender. Documented in natspec at all four functions.

## 5. No cap: a claim pays the voucher, or reverts until the token is funded

Decision T7/T8 (2026-10-05): there is NO cap, throttle, budget, running total or schedule bound
on what the distributor pays, for any token. The per-epoch mint cap of the pre-v1 reward token is
gone — `setEpochCap`, `armNextEpoch`, `cancelNextEpoch`, `effectiveEpoch`, `EpochMintCapExceeded`
and the pending-epoch machinery no longer exist — and a claim never mints. (Minting happens only
outside the claim flow, when the operator calls `mintRewardToken`, item 16.)

How a claim is paid now:

- Every reward token is PRE-FUNDED. The operator mints `$OVTR` INTO the distributor through
  `RewardsDistributor.mintRewardToken` (the distributor proxy is the Overture minter) and
  transfers `$ASSET` into it (`scripts/lp-fund-rewards.js`).
- `claim(token, cumulativeAmount, deadline, signature)` pays exactly
  `cumulativeAmount - claimed[token][user]` by `safeTransfer` out of the distributor's own balance.
- When that balance is short the claim reverts `InsufficientFunds(token, needed, balance)` —
  after every other check, and before anything is written — until the company funds the
  contract. A user who earned in epoch 1 and in epoch 2 can claim everything at any time; nothing
  about epochs is consulted.

What follows for operations:

- **Funding is a liveness dependency, not a safety one.** An underfunded token stops ITS claims
  and nothing else. The backend alerts when what it has signed but not yet seen claimed exceeds
  the distributor's balance of that token (`lp.distributor.underfunded`, alert only).
- **The trust note that replaces the cap.** With no bound anywhere, a leaked SIGNER key can sign
  vouchers that take the whole funded balance of every token, in one block per token, until the
  guardian pauses claims (`pause()`, one transaction, hot key). The guardian key must
  therefore stay hot and watched, and the operator rotates the signer (`setSigner`) right after
  the pause. Keeping the funded balance close to what is owed is the only lever that limits the
  exposure, and it is an operational one.
- **`$ASSET` claims are closed at launch** (`claimsEnabled = false`, decision Q-e) and opened later
  by the timelock with `setClaimsEnabled(ASSET, true)`; `$OVTR` claims are open from the deploy.

Tests: `test/forge/invariant/ClaimLedgerInvariants.t.sol` (per token: the ledger never decreases;
paid = funded − balance − recovered; cross-token isolation; nothing pays while paused, while a
token's claims are off, or for an unregistered token), the `InsufficientFunds` cases in
`test/forge/unit/DistributorBranches.t.sol` and `test/lp-staking/RewardsDistributor.test.js`, and
the integration scenarios' third-token flow (added through the timelock, `InsufficientFunds`,
funded, pays).

## 6. The emission schedule (`LPEpochRegistry`) bounds nothing

The per-epoch quantities of every reward token live on-chain in `LPEpochRegistry`: one record per
epoch (`startsAt`, `endsAt`, `prevLiveId`, `cancelled`) plus `epochAmount(id, token)`. The
OPERATOR multisig writes it with no delay (decision T9); the owner (timelock) only upgrades it and
moves the operator role. The backend mirrors finalized epochs and spreads each quantity evenly
over the epoch's 15-minute intervals.

It is a SCHEDULE, never a budget: no contract reads it to limit a payment, and a valid voucher
pays whatever the registry says. Its rules exist so the backend can never score against a
schedule that later changes:

- **The 30-minute margin** (`SCHEDULE_MARGIN = 1800`, decision T18): an epoch is scheduled or
  changed only while `startsAt >= block.timestamp + 1800`. The backend scores only FINALIZED chain
  data (~13 minutes on Ethereum) and mirrors the registry once a minute, so the margin guarantees
  the start, the end and every quantity are final before the first interval is scored. Exactly
  `now + 1800` is accepted; from `now > startsAt - 1800` on, the epoch is frozen.
- **The 900-second grid**: every bound is a multiple of `INTERVAL = 900`, so no scoring interval
  is split between two epochs.
- **Order and no overlap**: ids are `epochCount + 1` and never reused (a cancelled id included);
  live epochs are ordered and never overlap; gaps are allowed.
- **Last-live edits only for bounds and cancel** (decision Q-m): quantities may change on any
  live epoch before its margin, but `updateEpochBounds` and `cancelEpoch` act only on
  `lastLiveId`, which keeps every check O(1). `cancelEpoch` relinks `lastLiveId` to the epoch it
  was scheduled after.
- **Every amount names a registered reward token** (`distributor.isRewardToken(token)` — registered
  AND enabled — at write time). Adding a NEW token is the timelock's `addRewardToken` on the
  distributor; scheduling it is then the operator's.

What is NOT checked, deliberately: that the schedule's quantities are funded, or that they are
reasonable. Both are business decisions recorded in configuration (decision A6 of the B.3
document); the funded balance is item 5's concern, not the schedule's.

Tests: `test/forge/unit/EpochRegistry.t.sol` (every gate, both sides of the margin edge),
`test/forge/fuzz/EpochRegistryFuzz.t.sol` (an independent model of the accept/reject rule),
`test/forge/invariant/EpochRegistryInvariants.t.sol` (order, no overlap, ids never reused,
nothing changes inside the margin, grid, registered tokens), `test/lp-staking/LPEpochRegistry.test.js`.

## 7. SEC-01 — a fresh pool has one observation, so every swap-bearing path reverts `OLD`

A Uniswap V3 pool stores exactly **one** oracle observation until someone calls
`increaseObservationCardinalityNext` **and** trade fills the new slots. Until the array holds
at least `twapWindow` seconds of history, `pool.observe([twapWindow, 0])` reverts with the bare
string `OLD`. `TwapGuard` neither catches nor translates it, so it reaches the caller as an
uninterpretable revert.

Blocked on a fresh pool: `zapIn` with any swap leg, and `rebalance` with any swap leg. Also
`previewTwap()` on both the vault and the zapper, so the frontend cannot even pre-check.
Working from block one: `stake`, `stakeWithPermit`, `stakeFor`, `unstake`, and a swap-free
`rebalance`.

**Deploy blocker, operational.** `scripts/deploy-lp-staking.js` grows the array and prints
the warning; what it cannot do is create the history. Before announcing the program: seed
liquidity, trade the pool for at least `twapWindow` seconds, then confirm with
`pool.observe([twapWindow, 0])`.

**Sized since 2026-08-26** (review F5, which called an unsized cardinality a liveness
dependency). `LP_OBSERVATION_CARDINALITY` defaults to **150** and the script refuses to run
below the derived floor:

```
cardinality >= 2 * ceil(twapWindow / 12)
```

One observation per 12-second block is the worst case a pool can fill, so `ceil(window/12)`
slots is the bare minimum for a window's worth of history; the factor of 2 is margin for the
burst of trading a crash produces — which is precisely when the guard is read. A 300 s window
needs >= 50 slots, a 3600 s window >= 600. The error names the arithmetic, so an operator who
widens the window is told the new floor instead of discovering it as an `OLD` revert in
production. The size the stack was armed with is written into the `UniswapV3Pool` record in
`deployments.json`.

Note what this does NOT fix: allocating slots is not filling them. A swap-free `rebalance`
and every custody path still work from block one, and the swap legs still need the pool to
have been traded for a window.

**Closed on chain by audit L-04 (27 Oct 2026).** Every place that sets a window now calls
`OracleHistory.requireServes(pool, window)` (`libraries/OracleHistory.sol`): `TwapGuard._setTwapParams`
(so `initialize` and `setTwapParams` of the vault and the zapper) and the ApeBond adapter's
valuation window. It reverts `CardinalityTooLow(cardinality, needed)` unless the CURRENT
`observationCardinality` (not `observationCardinalityNext`) is at least `ceil(window / 6) + 1`, and
`HistoryTooShort(window)` unless `observe([window, 0])` succeeds. A pool's cardinality never
decreases and it writes at most one observation per block, so a window that passes can never
revert `OLD` afterwards. The cold state above is therefore unreachable for a stack: a vault cannot
be born on a fresh pool. The derived floor of the deploy script is that same rule (it replaced
`2 * ceil(twapWindow / 12)`), and the script checks it before it sends anything. The read paths are
unchanged and fail closed: there is no fallback on any of them.

Tests: `test/forge/fork/TwapManipulation.t.sol`, `TwapColdOracleTest` — five `test_L04_*` cases on
the real pool (the cold pool refused at `initialize`, a grown-but-unwrapped pool refused, the real
`OLD` turned into `HistoryTooShort`, a warmed pool accepting the stack, and `setTwapParams` refusing
a window the real pool cannot serve), and `test/forge/unit/OracleHistory.t.sol` on the mock.

## 8. SEC-02 — the TWAP guard is pre-trade only, and is skipped when `amountIn == 0`

`_checkTwapDeviation()` runs **before** `swapRouter.exactInputSingle`, so the swap's own price
impact is outside it: a rebalance can pass the guard and then leave spot further from the TWAP
than the guard would ever admit.

The second half — `rebalance` / `_zapIn` only call `_executeSwap` when `swap.amountIn > 0`, so
a no-swap rebalance never consults the guard at all — is **DELIBERATE since 2026-08-26**
(review recommendation 3), not a finding. A range move must remain available at any price: it
is the fallback the frontend offers while the guard is tripped, "move range now, optimize
ratio later". Closing it would turn the circuit breaker into a lock on the one action a staker
whose position has fallen out of range actually needs. See
`docs/reviews/spec-review-2026-08-26.md` in the lp-staking docs repo (F1, F2, rec. 3).

The price of that, stated in the `SwapParams` NatSpec: with `amountIn == 0` the mint minimums
are the ONLY protection on the mint, so they must be quoted tightly as a share of the
position's total value.

Everything inside the guard's tolerance is free MEV either way. A whale push that stays under
the ceiling measurably reduces the liquidity a zap-in buys, and nothing reverts.
**The caller's own `amountOutMin` / `amount0Min` / `amount1Min` are the only exact protection,
and nothing on-chain forces them to be non-zero.** Frontends must always quote them from a
fresh reading; a UI default of zero is a live loss.

Tests: `test/forge/fork/SwapSlippageMEV.t.sol` —
`test_SEC02_TheSwapsOwnImpactIsOutsideThePreTradeGuard`,
`test_SEC02_NoSwapRebalanceNeverConsultsTheGuard`, plus the four `test_Sandwich_*` cases that
measure the loss and then measure the remedy.

## 9. SEC-03 — `twapWindow` had no upper bound (FIXED 2026-08-26)

**Was:** `_setTwapParams` bounded the window only from below (`window < MIN_TWAP_WINDOW`), so
`setTwapParams(1_000_000_000, 500)` and even `type(uint32).max` were accepted. No oracle can
serve a 31-year lookback, so from that transaction on every `rebalance` with a swap leg and
every `zapIn` reverted with the bare `OLD` — griefing, not loss of funds, because the exits
stayed open and the owner could undo it (unless the owner had also renounced, item 3).

**Now:** `MAX_TWAP_WINDOW = 3600` closes it. The window is bounded on both sides and
`InvalidTwapWindow(window, minWindow, maxWindow)` carries all three numbers, so an operator
sees the band in the revert. One hour is long enough for any circuit breaker the program
would want and short enough that a warmed pool can always serve it.

Tests, inverted with the fix: `test/forge/fork/TwapManipulation.t.sol` —
`test_TwapWindow_HasAnUpperBound`, `test_Owner_CannotBrickTheSwapLegsWithAnOversizeWindow`;
`test/forge/fuzz/TwapTickFuzz.t.sol:testFuzz_TwapParams_NoWindowPastTheMaximumIsEverAccepted`;
`test/forge/unit/TwapGuardMath.t.sol:test_Guard_SetterRejectsAWindowOneSecondAboveTheMaximum`.

## 10. SEC-04 — replacing the distributor would replay every lifetime entitlement

The claim ledger `claimed[token][user]` lives in the distributor PROXY's storage, and the
vouchers state a LIFETIME figure per token. A replacement distributor would start with an EMPTY
ledger, so every user could re-spend their entire lifetime entitlement against it — paid out of
whatever the replacement is funded with.

The rule that remains, and the only one: **the distributor proxy is UPGRADED, never REPLACED.**
An upgrade (`upgradeToAndCall` through the timelock) keeps the per-token ledgers exactly where
they are, so every old voucher stays a no-op.

What changed with v1 (2026-10-05):

- **Fresh deploy, nothing to migrate.** v1 is a new storage layout in the same namespace; the
  Sepolia stack #5 proxy that carried the pre-v1 layout is abandoned, not upgraded, and mainnet
  starts empty.
- **The old mitigations are gone.** The per-epoch mint cap that used to bound a replay, and the
  "re-point the token's minter at a new distributor" escape hatch, no longer exist: the token has
  no cap, and a claim never mints. (Since 2026-10-07 the distributor IS the Overture minter, but
  only the operator's `mintRewardToken` reaches it, outside the claim flow — item 16. A
  replacement distributor would still need the timelock's `setMinter` before it could mint.)
- **The trust note that comes with it** (item 5): with no bound anywhere, a leaked signer key can
  take the funded balance of every token until the guardian pauses claims.

If a replacement ever becomes unavoidable (decision T19 case 2: the timelock is dead, so no
upgrade is possible), the backend must sign the new distributor's vouchers NET of the old
distributor's `claimed[token][user]` — there is no on-chain guard.

Tests: `test/forge/fork/RewardVoucherFork.t.sol` —
`test_SEC04_AnUpgradeKeepsThePerTokenLedgers` and, kept as the measured reason for the rule,
`test_SEC04_AReplacementProxyWouldReplayEveryLifetimeEntitlement` — plus the upgrade blocks of
`test/forge/unit/DistributorBranches.t.sol` and `test/lp-staking/RewardsDistributor.test.js`.

## 11. SEC-05 — `stakeFor(vault)` / `stakeFor(zapper)` stranded the position permanently (FIXED 2026-09-10)

**FIXED 2026-09-10 (finding C-1).** The guard below is in the deployed source; the description
is kept because it is what the guard exists to prevent.

`LPStakingVault.stakeFor` used to validate only `user != address(0)`. Crediting the vault itself,
or the zapper, produced a position that:

* `unstake` would not release — the recorded staker is a contract, and neither contract exposes
  any call path that reaches `vault.unstake`; and
* `rescuePosition` would not release it either — it refuses any tokenId whose staker record is
  non-zero, which is exactly what `stakeFor` had just written.

Nothing in the DEPLOYED code could have moved that NFT again. Only the whitelisted zapper can
call `stakeFor`, so the trigger was a bug in the zapper (or its successor), not an outside
attack — but the zapper is explicitly described as replaceable periphery, which is where the
risk sat.

**The fix** is one line in `stakeFor`, guarding both addresses before `_stake` writes anything:

```solidity
if (user == address(this) || user == zapper_) revert SelfCredit(user);
```

`SelfCredit(address user)` is a new custom error on the vault. The call now reverts, so no
record is written and no NFT is taken into custody — the failure mode is a reverted transaction
instead of a permanently stranded position. The upgrade path stays the second line of defence:
the vault is a UUPS proxy, so a position stranded by some other route could still be released
by an upgrade that adds a recovery path, after the timelock's public delay.

Tests (inverted from the two that used to assert the stranding): `test/forge/fork/TickSpacing.t.sol` —
`test_SEC05_StakeForTheVaultItselfReverts`,
`test_SEC05_StakeForTheZapperReverts`. Hardhat: the two `SelfCredit` cases in
`test/lp-staking/LPStakingVault.test.js`.

## 12. Smaller behaviours now pinned by tests

Not findings, but each surprised somebody during this work and each is now asserted by a named
test rather than left to be rediscovered.

* **EIP-4494 does not work for code-bearing owners.** Uniswap's `ERC721Permit` branches on
  `Address.isContract(owner)` and routes a code-bearing owner to ERC-1271. That covers contract
  wallets AND ordinary EOAs carrying an **EIP-7702 delegation** — at the pinned Sepolia block
  several plainly-derived addresses already do. `stakeWithPermit` is unusable from such an
  account and the revert carries no message; approve-then-`stake` still works.
  (`test/forge/fork/PermitDomains.t.sol:test_NftPermit_ACodeBearingOwnerCannotUseTheEip4494Path`)
* **A single-sided withdrawal cannot fill a two-sided range.** When spot has left a position's
  range the position holds ONE token, and a swap-free rebalance into a range that straddles
  spot reverts inside Uniswap with no message. Re-ranging an out-of-range position needs a swap
  leg.
  (`test/forge/fork/SwapSlippageMEV.t.sol:test_Rebalance_SingleSidedWithdrawalCannotFillATwoSidedRange`)
* **Out-of-range tick bounds revert with `T`, not `TLM` / `TUM`.** The periphery's
  `TickMath.getSqrtRatioAtTick` trips before the pool's own `checkTicks`. A zero-width range and
  a misaligned tick both revert with NO data at all (`FullMath` and `TickBitmap` use bare
  `require`s). Frontends cannot rely on a readable message for any tick error.
  (`test/forge/fork/TickSpacing.t.sol`, the five `test_Ticks_*` cases)
* **`increaseLiquidity` is permissionless on the canonical position manager.** Anyone can top up
  a STAKED position and the value accrues to the existing staker, with no vault event behind it.
  Off-chain scoring must expect a position's liquidity to grow without a `Staked` / `Rebalanced`
  event.
  (`test/forge/fork/TickSpacing.t.sol:test_ThirdParty_CanIncreaseLiquidityOnAStakedPosition`)
* **A fee-on-transfer token would break the position manager's accounting**, not just the refund
  event: the manager credits the amount it asked for and receives less, and the shortfall only
  surfaces as an insufficient-balance revert on the NEXT withdrawal. The pool triple check makes
  this unreachable on a correct deployment; it is recorded because `sweep` / `recoverExcess`
  touch arbitrary tokens.
* **A fee-on-transfer reward token would short every claimer permanently.** `claim` books
  `cumulativeAmount` into `claimed[token][user]` BEFORE the transfer, so the fee the token
  withholds can never be re-claimed — the ledger already says it was paid. This is a
  **constraint on every reward token** (`addRewardToken` NatSpec: plain ERC-20 only), not a
  contract bug.
  (`test/lp-staking/RewardsDistributor.test.js`: "books the amount sent, so a fee-on-transfer
  token shorts the claimer for good (unsupported, documented)"; the same numbers in
  `test/forge/unit/HostileTokens.t.sol`)
* **A reward token whose `transfer` returns false instead of reverting is rejected, and books
  nothing.** `SafeERC20` turns the false into a revert, the whole claim reverts, and
  `claimed[token][user]` is left where it was — so the user can retry once the token is fixed.
  (`test/lp-staking/RewardsDistributor.test.js`: "rejects a token whose transfer returns false
  instead of reverting, and books nothing")
* **A USDC-blacklisted staker cannot `rebalance`.** `_refundDust` sends the leftover USDC to
  the staker and Circle's blacklist reverts that transfer, so the whole rebalance reverts.
  `unstake` is unaffected — it moves the NFT, not USDC — so the position is never trapped; the
  staker withdraws it and manages it on Uniswap directly.

## 13. Rebalance pause (review F6, 2026-08-26)

`rebalance` used to be unpausable, alongside `unstake`. The 2026-08-26 spec review (F6) called
that out: the exit invariant only requires `unstake` to be unstoppable, and `rebalance` is the
most complex function in the stack (burn -> collect -> swap -> mint), so a bug found after
deploy had no mitigation at all. Since the 2026-08-26 upgradeability revision (item 14) the
code CAN be fixed, but only through the timelock's public delay, so the pause is still the
only mitigation that acts in one transaction — which is why it sits with the guardian, not
with the owner.

`LPStakingVault` now carries a second switch:

| Switch | Caller | Gates | Never gates |
|---|---|---|---|
| `pauseDeposits()` / `unpauseDeposits()` | pause: guardian OR operator; unpause: operator only (audit L-01) | `stake`, `stakeWithPermit`, `stakeFor` — and therefore the whole `LPZapper.zapIn` flow, which ends in `stakeFor` | `unstake`, `rebalance` |
| `pauseRebalance()` / `unpauseRebalance()` | pause: guardian OR operator; unpause: operator only (audit L-01) | `rebalance`, with or without a swap leg | `unstake`, deposits |

`if (rebalancePaused) revert RebalanceIsPaused();` is the first statement of `rebalance`, so a
paused call reads no storage past the flag and mines nothing. `RebalancePausedSet(bool)` carries
the full new state, like every other admin event here.

The zapper gets no state of its own (review recommendation 4 asks for "rebalance and zap
pausable"): the deposit pause already stops every zap through `stakeFor`, so a second flag
would only add a second thing to get wrong — and the zapper is replaceable periphery the vault
can also de-whitelist with `setZapper(address(0))`.

What this deliberately does NOT do is make the exit conditional. With both switches on, a
staker can still `unstake` and manage the position on Uniswap directly; that is asserted on the
fork (`test/forge/fork/PositionLifecycle.t.sol:test_RebalancePaused_BlocksRebalanceButNeverUnstake`)
and in both integration scenarios (steps A43-A45).

## 14. Upgradeability — all five LP contracts (spec revision 2026-08-26, extended 2026-10-05)

Management requirement, recorded in `docs/specs/00-architecture-overview.md` decision 5 and
`docs/specs/01-contracts.md` §1/§2.1/§2.4, extended on 2026-10-05 (decision T12/U: "make all
contracts upgradable UUPS for the LP (ALL)"): `LPStakingVault`, `RewardsDistributor`,
`LPEpochRegistry`, `TokenOverture` and `LPZapper` are UUPS (ERC-1967) proxies behind `LPProxy`,
every one owned by the `TimelockController` from its own deployment transaction. The
`TimelockController` itself stays a plain contract (decision T15/T17): it holds no funds, its
delay and roles change through operations scheduled on itself, and it is REPLACEABLE without any
lock — the owner of each proxy is Ownable2Step storage, so a new timelock takes over by one
scheduled `transferOwnership` per proxy plus `acceptOwnership` from the new one
(`scripts/lp-switch-timelock.js`, decision T19 case 1). A UUPS timelock would be circular (owned
by itself) and is not used. Fixed for real: the five PROXY addresses, the `LPProxy` shell code,
and external contracts (the Uniswap pool, the position manager, the `$ASSET` token). The runbook
for operating the timelock is at the end of this item.

### Why the distributor, specifically

Item 10 (SEC-04) is the whole argument. `claimed[token][user]` is the only record of what has
already been paid, and the vouchers state a LIFETIME figure per token. Fixing a bug by deploying
a replacement contract starts that ledger at zero, and every outstanding voucher becomes payable
a second time, out of whatever the replacement is funded with — there is no cap to bound it any
more (item 5). A proxy is what lets the code be replaced while the ledger stays exactly where it
is, which is why the rule is: upgrade, never replace.

### Why the registry, the Overture token and the zapper

Uniformity first (decision Q4 / T12), then a reason each:

- **`LPEpochRegistry`** holds the emission schedule the backend scores against. A replacement
  registry would restart the ids at 1 and the backend's mirror would have to be rebuilt; an
  upgrade keeps every epoch, amount and id. Its `distributor` reference is an `immutable` of the
  implementation, so the next implementation can change it if one ever has to.
- **`TokenOverture`** is a token with holders. A replacement token would be a different asset
  (new address, new balances, new permit domain); an upgrade keeps balances, allowances, permit
  nonces, the name/symbol and the minter. Name, symbol and the permit domain live in
  OpenZeppelin's namespaced storage, so even they can change by an upgrade with a reinitializer.
- **`LPZapper`** holds nothing between transactions, but the vault whitelists it by ADDRESS
  (`setZapper`, owner-tier, 48 h). Behind a proxy the address never changes, so a zapper fix is
  one upgrade instead of a new deploy plus a `setZapper` operation, and every frontend keeps its
  configured address. Its fixed references stay `immutable` in the implementation.

### Why the vault, specifically

A different argument with the same shape. `stakers[tokenId]` is the only record of who owns
each custodied position NFT, and the NFTs themselves sit at the vault's address. Fixing a bug
by deploying a replacement vault would leave every staked position behind at an address whose
code is the bug, with no way to move the record with it — and `rescuePosition` cannot help,
because it is restricted to positions with NO staker record. A proxy is what lets the code be
replaced while custody and the ledger stay exactly where they are.

Item 13's rebalance pause changes role because of this. It used to be the ONLY mitigation for a
bug in the most complex function in the stack; it is now the FAST one, and an upgrade is the
slow one. That is why both pause switches sit with the guardian — and, since the 2026-09-09
role split, with the operator as well, so a lost hot key cannot leave the stack un-pausable
(item 14). An upgrade cannot execute before the timelock's public delay, so the immediate
mitigation still has to be a switch a key outside the timelock can throw by itself.

### Shape

- `contracts/lp-staking/deploy/LPProxy.sol` — OZ `ERC1967Proxy`, nothing added. It exists so the
  repo owns the artifact (the indexer only vendors artifacts whose `sourceName` starts with
  `contracts/lp-staking/`) and so one name means one proxy across script, suites and explorer.
- `contracts/lp-staking/deploy/LPTimelock.sol` — OZ `TimelockController` for the same two
  reasons, with ONE addition since 2026-11-03: a canceller role with a term written on chain
  (Doublo's audit Q1, see "Q1 — the term-limited canceller role" below). Constructed with
  `(LP_TIMELOCK_MIN_DELAY, [multisig], [multisig], address(0))`: the multisig (REAL's Safe) is
  the only proposer and the only executor. Execution is deliberately NOT open. The OZ constructor
  also grants the multisig `CANCELLER_ROLE`, with no term (`cancellerTermEnd == 0`), so it is a
  permanent canceller. `admin` must be `address(0)`: any other value reverts
  `BootstrapAdminNotAllowed`, so the timelock is its only `DEFAULT_ADMIN_ROLE` holder from block
  one. That role is also the admin of `CANCELLER_ROLE`, so every role change, every canceller
  offer, withdrawal and revocation included, is a scheduled, publicly visible operation. A
  second canceller (ApeBonds' Safe) is reached only by an offer and its acceptance, and
  `grantRole(CANCELLER_ROLE, …)` reverts `CancellerGrantOnlyByAcceptance` for every caller. The
  constructor signature is OpenZeppelin's, so the explorer verification arguments are unchanged.
  `schedule` and `scheduleBatch` additionally record `scheduledAt[id]` (one extra storage write
  per schedule, about 22,000 gas). The contract is not behind a proxy, so its storage layout
  carries no upgrade concern.
- The distributor's implementation constructor takes NO arguments (every reward token is proxy
  storage) and only calls `_disableInitializers()`.
  `initialize(owner_, guardian_, operator_, signer_, asset_, RewardTokenInit[] tokens_)` runs on
  the proxy, inside the proxy's own deployment transaction, and `owner_` is the timelock from that
  transaction onwards — no key ever holds the owner tier on a proxy, not even for one block
  (finding N-7, 2026-09-10).
- The distributor's mutable state lives in ONE ERC-7201 namespace,
  `erc7201:real.lp.storage.RewardsDistributor`, at
  `0x111abb03172b09f746748b28040854f0c669e7caa9373080b8bbaa7c3af02e00`, in the v1 layout
  `signer`+`paused` | `guardian` | `operator` | `address[] rewardTokens` |
  `mapping(token => RewardToken)` | `mapping(token => mapping(user => claimed))`, and, APPENDED in
  v2 (2026-10-07) after every v1 field, `address asset` at base + 6 — the `$ASSET` token
  `mintRewardToken` refuses by address. The literal is pinned in the contract and re-derived by
  `test_Storage_TheV1LayoutLivesAtThePinnedErc7201Slot`, which also reads `claimed[token][user]`
  at `keccak(user, keccak(token, base + 5))` and `asset` at base + 6: if a slot ever moved,
  every ledger would read zero and every lifetime voucher would pay out again.
- **The distributor's v1 -> v2 migration.** A proxy deployed at v1 (Sepolia stack #6) never wrote
  base + 6. It is upgraded with ONE timelock operation,
  `upgradeToAndCall(newImplementation, abi.encodeCall(initializeV2, ($ASSET)))`:
  `initializeV2(address)` is `reinitializer(2) onlyOwner`, so it runs once, inside the upgrade,
  where the delegatecall keeps `msg.sender` = the timelock = the owner. Same check and event as
  `initialize` (zero -> `ZeroAddress`, then `AssetSet`). Upgrading WITHOUT that call would leave
  `asset` zero, and `mintRewardToken` would then compare against nothing — the runbook
  (`scripts/README.md`, "Activating mintRewardToken on a live stack") carries the calldata. On a
  proxy born at v2, `initialize` (version 1) already set the field and `initializeV2` stays
  callable once by the owner, where it would re-point it — an owner-tier change, public for the
  timelock delay. The appended field validates as a legal successor of the stack #6 layout
  recorded in `.openzeppelin/sepolia.json`.
- `LPEpochRegistry`: constructor `(distributor)` (immutable) + `_disableInitializers()`;
  `initialize(owner_, operator_)`; namespace `erc7201:real.lp.storage.LPEpochRegistry` at
  `0x9ecda8e3fad78b619c97eff816bc5317dd5b4101194b9333568095fc1dd01f00`.
- `TokenOverture`: no constructor arguments; `initialize(name, symbol, owner_, minter_)` with
  `__ERC20_init`, `__ERC20Burnable_init`, `__ERC20Permit_init(name)`, `__Ownable_init`,
  `__Ownable2Step_init`; `minter` in `erc7201:real.lp.storage.TokenOverture` at
  `0x7ca9f8db09cacc7881e534e068295c46832e8cbf76a90cb6e2f245c9bf51b600`. The permit domain's
  `verifyingContract` is the proxy.
- `LPZapper`: constructor `(vault, positionManager, pool, token0, token1, fee, swapRouter, usdc,
  asset)` — the same zero/sort/pool-triple/pair checks as before, all immutables — ending in
  `_disableInitializers()`; `initialize(owner_, operator_, twapWindow_, maxDeviationTicks_)`;
  `operator` and the ERC-721 receive guard in `erc7201:real.lp.storage.LPZapper` at
  `0x3f321486c4e46b59498f8814639a355cef7759e294075873ae5431d3955f3000`. Its owner (the
  timelock) holds `_authorizeUpgrade` and `setOperator`; the immediate levers `setTwapParams`,
  `sweep` and `rescuePosition` moved from the owner to the new `operator` tier (decision Q-d).
- The EIP-712 domain is bound to the PROXY, so `verifyingContract` is stable across upgrades and
  no voucher is invalidated by one.
- The vault's implementation constructor takes its six immutables (`positionManager`, `pool`,
  `token0`, `token1`, `fee`, `swapRouter`), keeps their zero/sort checks AND the live
  `pool.token0()/token1()/fee()` triple check — the three values it compares are immutables set
  in that same constructor, so the implementation deploy is the only place where checking them
  means anything — and ends with `_disableInitializers()`.
  `initialize(owner_, guardian_, operator_, zapper_, twapWindow_, maxDeviationTicks_)` runs on
  the proxy. `zapper_` is there so the vault can be born owned by the timelock: `setZapper` is
  owner-tier, so wiring the zapper after the fact would need a scheduled timelock operation at
  bootstrap. The deploy script predicts the zapper's CREATE address instead and passes it in.
- The vault's mutable state lives in `erc7201:real.lp.storage.LPStakingVault`, at
  `0x4c835a63e69815f7352ca18e845a5d8023cea9abbc2e923eb7a3a481844a6500`, re-derived by
  `test_Storage_LivesAtThePinnedErc7201Slot`: if that slot ever moved, every `stakerOf` would
  read zero after an upgrade — and a zero record is exactly the state `rescuePosition` is
  allowed to act on.
- `TwapGuard`'s two parameters have a namespace of their own,
  `erc7201:real.lp.storage.TwapGuard`, at
  `0xd1f904d9e9754969ffa2d33531f67fbdbb15fde03cb30a2cfdee997f4aa0c300`, because the guard is
  inherited by BOTH proxied contracts, the vault and the zapper; each seeds it from its own
  `initialize`. `TwapGuard`'s own constructor takes only the pool.
- **`initialize` seeds the vault's ERC-721 receive guard** (`receiveGuard = NOT_RECEIVING`). The
  old inline field initializer was constructor code, which a proxy never runs; left at zero the
  guard would still reject unsolicited transfers, but `_stake` would be writing a cold slot on
  every deposit. Measured by `test_Initialize_SeedsTheReceiveGuard`.
- **No `initialize` calls `__UUPSUpgradeable_init()`, and it is not an omission.**
  OpenZeppelin 5.6.1 turned `contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol` into a
  re-export of the plain, non-upgradeable `UUPSUpgradeable`, which declares no initializer at
  all — the symbol does not exist in the pinned dependency, and calling it would not compile.
  There is also nothing for it to seed: the module's only state is the ERC-1967 implementation
  slot, and the proxy's own constructor writes that before `initialize` runs. Both `initialize`
  bodies carry this as a comment so the next reader does not add the call back. The
  initializers that DO exist are called: `__Ownable_init(owner_)` and `__Ownable2Step_init()`
  everywhere, plus the ERC-20 ones on the Overture token.
- `@openzeppelin/contracts/utils/ReentrancyGuard.sol` is used rather than a
  `ReentrancyGuardUpgradeable`: OZ v5.5 moved that guard to its own ERC-7201 namespace and
  marked it `@custom:stateless`, and v5.6 removed the upgradeable variant entirely. Its
  constructor seeds `NOT_ENTERED = 1`, which a proxy never runs — harmless, because
  `_reentrancyGuardEntered()` tests for `== ENTERED (2)`, so an unwritten slot reads as
  "not entered".

### Q1 — the term-limited canceller role (Doublo's audit Q1, accepted by ApeBonds 2026-11-03)

Doublo's audit Q1 asks for `CANCELLER_ROLE` on the `LPTimelock` for ApeBonds' Safe, so ApeBonds
can cancel any owner-tier operation (an upgrade, a parameter change, a role change) during the
48 hour delay. A plain canceller would be a problem: it can cancel the operation that revokes its
own role, so a hacked canceller could never be removed. `LPTimelock` therefore binds the cancel
power to a term. A term canceller may cancel exactly the operations scheduled BEFORE its term end
(`scheduledAt[id] < cancellerTermEnd[account]`). After the term it can still cancel what was
proposed during the term, so every such operation keeps its full veto window, and it can never
cancel anything scheduled at or after the term end, including its own revocation.

The appointment has two steps. REAL's Safe schedules `offerCancellerRole(account, termDays)` on
the timelock itself and executes it after the delay. That stores an offer, acceptable for 7 days
from the execution (`CANCELLER_OFFER_WINDOW`), and grants nothing. The offered address then calls
`acceptCancellerRole(termDays)` inside the window, naming the offered term. The term end is the
acceptance time plus `termDays` days, with `termDays` in 1 to 180 (`MAX_CANCELLER_TERM_DAYS`). A
renewal is a new offer and a new acceptance, and the acceptance RESETS the term end to the
acceptance time plus the new term. During the term a revocation reverts at execution
(`CancellerTermActive`). The holder may `renounceRole` at any time. A revocation and a
renouncement both clear the term end and delete any unaccepted offer of that address, so no
stale offer can be accepted later, and the deletion of a stored offer (unaccepted, possibly
expired) emits `CancellerOfferWithdrawn`.

Who can do what:

| Function | Caller | Signatures | Delay |
|---|---|---|---|
| `offerCancellerRole(account, termDays)` | the timelock (scheduled by REAL's Safe) | 3 of 5, twice | 48 h. REAL or any canceller can cancel it while pending. Acceptable for 7 days after execution |
| `acceptCancellerRole(termDays)` | the offered address, inside the window | 3 of 5 of that Safe | none |
| `withdrawCancellerOffer(account)` | the timelock | 3 of 5, twice | 48 h (cancelling the pending offer operation is instant) |
| `revokeRole(CANCELLER_ROLE, a)` | the timelock | 3 of 5, twice | 48 h. Reverts at execute while `a`'s term is active. `a` cannot cancel it when it was scheduled after `a`'s term end |
| `renounceRole(CANCELLER_ROLE, self)` | the canceller | its own Safe | none, at any time |
| `grantRole(CANCELLER_ROLE, x)` | nobody (reverts) | | |
| `cancel(id)` | REAL's Safe: any pending id. Term canceller: ids scheduled before its term end | 3 of 5 | none |
| `schedule`, `execute`, `updateDelay`, other role changes | REAL's Safe through the 48 h path | 3 of 5, twice | 48 h |

Exploit table:

| Actor | Can | Cannot | Way out |
|---|---|---|---|
| ApeBonds' Safe hacked, during the term | cancel every pending owner-tier operation, which freezes the owner tier until the term end (at most 180 days from acceptance): no upgrade, no new reward token, no operator rotation, no `setClaimsEnabled` for `$ASSET` if day 90 falls inside | take funds, pause, schedule, block users (unstake is never pausable), be revoked early | wait for the term end, then propose again: operations scheduled after the term end cannot be cancelled by it. Or the lost-timelock path (new proxies, migration) |
| ApeBonds' Safe hacked, after the term | cancel only operations scheduled before its term end that are still pending | cancel anything scheduled after the term end, including its own revocation | propose again. Revocation is optional housekeeping |
| ApeBonds in bad faith (not hacked) | the same as a hacked ApeBonds during the term, as commercial leverage: block `setClaimsEnabled`, a bug-fix upgrade, `setOperator`, `setCampaignEnabled` | the same | the same. Business risk accepted by Vladimir (decision 11 of 2026-10-30) |
| offered address compromised before it accepts | accept inside the 7 day window | accept after the window | cancel the pending offer operation (instant) or withdraw it (48 h) |
| REAL's Safe hacked (listed for completeness) | schedule malicious operations (ApeBonds vetoes them during the term). Propose offers to its own addresses (ApeBonds can veto these too). Revoke REAL's own permanent canceller | remove ApeBonds during the term. Stop ApeBonds from cancelling anything scheduled during the term | as today: the timelock is lost, new proxies and a migration. Users exit |

Events `LPTimelock` adds to OpenZeppelin's:

| Event | Emitted by | What it carries |
|---|---|---|
| `CancellerOffered(account, termDays, expiresAt)` | the execution of `offerCancellerRole` | the offered term and the end of the 7 day window |
| `CancellerOfferWithdrawn(account)` | the execution of `withdrawCancellerOffer`, and every revoke or renounce of `CANCELLER_ROLE` that deletes a stored offer (unaccepted, possibly expired) | the address whose offer was deleted. So every change of an offer is visible on chain, also a renounce by an offeree that holds no role, where OpenZeppelin emits nothing. In a revoke or renounce of a holder it comes BEFORE OpenZeppelin's `RoleRevoked`, a contract fact the indexer relies on |
| `CancellerAccepted(account, termEnd)` | `acceptCancellerRole` | the new term end (next to OpenZeppelin's `RoleGranted` on a first acceptance) |
| `OperationCancelled(id, canceller)` | every `cancel` that went through, after OpenZeppelin's `Cancelled(id)` | who cancelled: REAL's Safe or a term canceller. For a Safe it is the Safe, not the key that submitted the Safe transaction |

OpenZeppelin's `Cancelled(id)` does not name the caller, and the indexer engine gives a handler only
the transaction hash, so the indexer reads the canceller from `OperationCancelled`. That event is
the only exact source of who cancelled an operation.

The veto covers the owner tier only. The operator tier (pauses, `setSigner`, `recoverExcess`,
`mintRewardToken`, `rescuePosition`, `setTwapParams`, the epoch functions, `sweep`) is sent
directly by the operator multisig and never passes through the timelock.

The rules are pinned by `test/forge/unit/LPTimelockCanceller.t.sol` (every revert with its exact
custom error and arguments) and the script actions by `test/lp-staking/LPTimelockCanceller.test.js`.

### Three-tier admin

The 2026-09-09 role split (change-request item R) replaced the original two tiers with three.
The owner is still the timelock. What changed is that the old guardian tier was doing two
different jobs — stopping an incident, and moving value or rotating a key — and only the first
of those needs a hot key somebody can reach at three in the morning. They are separate roles
now.

| tier | holder | delay | what it is for |
|---|---|---|---|
| **owner** | the `TimelockController` (`deploy/LPTimelock.sol`; 48 h on mainnet, 300 s on Sepolia test stack #5) | `minDelay`, and the call is public for the whole of it | changing code, and changing who holds the other two tiers |
| **guardian** | a HOT key that holds nothing else | none | stopping an incident: the pause switches, and nothing that moves value or sets a key |
| **operator** | a multisig ("multisig B"), distinct from the timelock's proposer | none | routine operations: calibration, key rotation, the recovery hatches — plus the pause switches again, as the cold fallback |

`RewardsDistributor`:

| tier | functions | why |
|---|---|---|
| owner | `_authorizeUpgrade`, `initializeV2` (once, inside the v1 -> v2 upgrade), `addRewardToken`, `setRewardTokenEnabled`, `setClaimsEnabled`, `setGuardian`, `setOperator` | a code change, a new reward token, opening or closing a token's claims, and changing who may pause or rotate the signer should all be visible on-chain before they can run |
| guardian | `pause` | a bug in the claim path — or a leaked signer key — has to be stoppable in minutes |
| operator | `setSigner`, `recoverExcess`, `mintRewardToken` (never `$ASSET`), **plus `pause`, `unpause` (the only tier that unpauses, audit L-01) and `setGuardian`** | a leaked signing key is rotated by the multisig, not by the hot key, a token leaves the contract only towards the operator, minting is treasury work the hot key must never do, and a hot guardian key has to be revocable without a delay |

`LPStakingVault`:

| tier | functions | why |
|---|---|---|
| owner | `_authorizeUpgrade`, `setZapper`, `setBonusEscrow`, `setStakeOperator` (lane 2), `setGuardian`, `setOperator` | code, pointing the deposit path at a new periphery contract, linking the bonus escrow every exit notifies (item 15), and the tier assignments are program decisions |
| guardian | `pauseDeposits`, `pauseRebalance` | the two incident switches (item 13) have to act in one transaction |
| operator | `setTwapParams`, `rescuePosition`, **plus both pauses, both unpauses (the only tier that unpauses, audit L-01) and `setGuardian`** | calibrating the guard is an operations decision, not an emergency one, a stranded NFT leaves the contract only towards the operator, and a hot guardian key has to be revocable without a delay |

`LPEpochRegistry`, `TokenOverture`, `LPZapper` (no guardian tier — nothing on them needs a
pause):

| contract | owner (timelock) | operator (multisig) |
|---|---|---|
| `LPEpochRegistry` | `_authorizeUpgrade`, `setOperator` | `scheduleEpoch`, `setEpochAmount`, `updateEpochBounds`, `cancelEpoch` (decision T9: arming the next epoch is immediate) |
| `TokenOverture` | `_authorizeUpgrade`, `setMinter` | — ; the **minter** role holds `mint`: the `RewardsDistributor` proxy since 2026-10-07, so the operator mints through `mintRewardToken` |
| `LPZapper` | `_authorizeUpgrade`, `setOperator` | `setTwapParams`, `sweep`, `rescuePosition` (decision Q-d) |

Three rules follow from the matrix, and each is asserted in both directions on the vault and the
distributor:

- **The three pause switches accept the guardian OR the operator** (`onlyGuardianOrOperator`).
  The guardian is the fast path; the operator is the cold fallback, so a lost hot key never
  leaves anything un-pausable while a replacement is arranged. The OWNER is rejected on all
  three: a pause routed through a 48 h delay is not a pause, and the timelock is not a party
  that can react to anything anyway.
- **Everything else on the operator tier is `onlyOperator`**, and the guardian is rejected there
  with `NotOperator(caller, operator)`. Nothing the hot key can call moves value or sets a key.
  That is the entire point of the split.
- **`setGuardian` accepts the owner OR the operator** (`onlyOwnerOrOperator`), decided
  2026-09-14. The reason is the shape of the guardian itself: it is a HOT key — one externally
  owned account, kept online — holding switches that take effect in the transaction that calls
  them. The owner is a `TimelockController` whose every call has to be scheduled and then waited
  out, 48 h on mainnet. If the owner were the only tier that could replace the guardian, a
  guardian key known to be leaked would keep those undelayed switches for the whole of those
  48 h and could re-pause in every block of them. A key that acts with no delay has to be
  revocable with no delay, and the operator multisig is the tier that can act with no delay. So
  the operator can revoke by passing `address(0)` and can appoint a replacement by passing a
  live address; the owner keeps exactly the same right through the timelock. This grants the
  operator no new power over the protocol, because the operator already holds every switch the
  guardian holds — removing the guardian leaves it with precisely what it had.
  **`setOperator` did NOT move**: it is still `onlyOwner` and still rejects `address(0)`, so the
  operator cannot rotate itself and the timelock stays the only tier that can change it.

**`address(0)` is a legal guardian, and only through `setGuardian`.** It is the explicit "no
guardian" state. With it stored, every guardian path is closed, because `msg.sender` can never
be the zero address, so `onlyGuardianOrOperator` admits the operator alone. `initialize` still
rejects a zero guardian — a stack is born with one — and `setOperator` still rejects a zero
operator. `GuardianSet(previous, new)` is emitted for a revocation exactly as for a rotation.

A stranger is rejected everywhere: `NotGuardianOrOperator(caller, guardian, operator)` on the
three pauses, `NotOperator(caller, operator)` on the operator-only functions,
`NotOwnerOrOperator(caller, owner, operator)` on `setGuardian`, and
`OwnableUnauthorizedAccount` on the remaining owner functions. `NotGuardian` no longer exists on
either contract.

`recoverExcess` sends to `operator()`, and so do both `rescuePosition`s. The owner is a
timelock contract with no way to forward an ERC-20 or an ERC-721; the guardian is a hot key that
should never hold value. The operator is the multisig that funded the one and would forward the
other off-chain. Item 1's trust note is unchanged otherwise.

`renounceOwnership()` reverts `RenounceDisabled()` on all five proxies (item 3). A renounce would
leave `_authorizeUpgrade` with no caller and freeze the implementation forever, which is the
exact failure the proxy exists to avoid.

Measured by `test/forge/unit/AccessControl.t.sol` —
`test_Tiers_TheOwnerIsRejectedOnEveryGuardianAndOperatorFunction`,
`test_Tiers_TheGuardianHoldsThePausesAndNothingElse`,
`test_Tiers_TheOperatorHoldsItsOwnCallsAndThePauses`,
`test_Tiers_AStrangerIsRejectedEverywhere` — and by
`test_AdminFunctions_TheThreeTiersDoNotOverlap` in both
`test/forge/unit/VaultBranches.t.sol` and `test/forge/unit/DistributorBranches.t.sol`.

### What is NOT guarded

`recoverExcess` is the ONE external function in the stack that carries no `nonReentrant`.
`LPZapper.sweep` used to be its neighbour in that list; it gained the modifier on 2026-09-10
(finding C-4), which closed the asymmetry item 12 used to record. What is left is deliberate: a
hostile OPERATOR recovering a hook-bearing token really can reenter `recoverExcess` and recover
twice in one transaction — recorded as behaviour, not a vulnerability. It is `onlyOperator`, the
destination is fixed to `operator()` and is not a caller-supplied argument, and the balance is
company money the operator itself supplied; the modifier would remove nothing the operator
cannot already do in two transactions. Measured by
`test_Reentrancy_RecoverExcessIsUnguardedAndReallyDoesReenter`. `claim` IS `nonReentrant`: a
hostile reward token whose transfer re-enters `claim` is rejected
(`test_Reentrancy_ARewardPayoutHookCannotReenterClaim`).

A hostile OWNER is not expressible at all: under `Ownable2Step` a contract that never calls
`acceptOwnership` never becomes the owner. That is why the vault's reentrancy tests hand the
hostile router the OPERATOR role — `rescuePosition` is the call they attack and it is
operator-tier. The vault's `rescuePosition` IS `nonReentrant`, and that is still asserted
(`test_Reentrancy_RouterCannotReenterRescuePositionMidRebalance`), as is the now-guarded sweep
(`test_Reentrancy_ZapperSweepIsGuarded`).

### Operator notes

- The deploy script deploys implementation + `LPProxy` as two nonce-controlled transactions
  rather than `upgrades.deployProxy`, because every transaction in that script carries an
  explicit nonce. The proxy's `initialize` runs in the proxy's deployment transaction — an
  uninitialized proxy is one `initialize` race away from belonging to whoever calls it first.
- Before each implementation deploy the script runs `upgrades.validateImplementation` (proxy
  safety, from the build info alone), and after each proxy deploy `upgrades.forceImport`, which
  writes the storage layout into the `hardhat-upgrades` manifest. On a named network that is
  `.openzeppelin/<network>.json` and it is **committed** — it is the baseline every future
  `validateUpgrade` grades a new implementation against. On a development chain (31337, a
  spawned `hardhat node`) the plugin writes into the OS temp directory instead, so fork runs
  leave nothing behind.
- **`LP_GUARDIAN` and `LP_OPERATOR` are both REQUIRED and neither has a default any more.**
  `LP_GUARDIAN` used to fall back to `LP_MULTISIG`; it does not, because a default would
  silently collapse the hot key onto the multisig and undo the split. The deploy script THROWS
  when `LP_OPERATOR == LP_GUARDIAN`, and WARNS (without stopping) when either collapses onto
  `LP_MULTISIG` or onto the deploying key — the test stacks deliberately collapse them, mainnet
  must not. All three addresses are printed in the config block before anything is deployed.
  `LP_TIMELOCK_MIN_DELAY` (default 172800 = 48 h) is the timelock's own delay; Sepolia test
  stack #5 runs 300 and the fork suites 60.
- The post-deploy checks read the ERC-1967 implementation slot off each proxy, so "the
  registry's proxy really delegates to the registry's implementation" is asserted rather than
  assumed, and the ERC-1967 ADMIN slot is asserted EMPTY — a value there would mean a second,
  unowned upgrade path. Each proxy needs TWO `hardhat verify` commands — implementation, then
  proxy (implementation address + the `initialize` calldata) — and the script prints both,
  plus one for the timelock's four constructor arguments.
- **Escrow upgrades (audit I-01, 27 Oct 2026; revised 2026-11-09 for item 20):** before scheduling an escrow or listener upgrade, run `scripts/measure-hook-gas.js` against the live chain (Foundry's `test_HookGas_*` cannot reproduce Glamsterdam pricing) and confirm the forfeiture figure is well under `bonusHookGas()` (default 400,000); if not, raise it with `setBonusHookGas` through the timelock first. The vault's
  `onUnstake` call is fail-open inside that allowance (item 15), so a heavier forfeiture would
  silently keep every bonus an early exit should forfeit; the backend alerts on `BonusHookFailed`.
- **The proxies have no bootstrap at all** since 2026-09-10 (finding N-7): `initialize` names
  the timelock as the owner inside each proxy's own deployment transaction, so no key ever
  holds the owner tier on a proxy, not for one block, and the run schedules nothing. What made
  that possible was moving the zapper address into `initialize` — see the runbook below for the
  nonce prediction it rests on and for what happens if the prediction misses.
- All five proxies are deployed timelock-owned; nothing is deployer-owned and nothing is
  nominated at the end of the run (until 2026-10-05 the reward token and the zapper were
  deployer-owned and nominated to the operator). The Overture token is born with the
  distributor PROXY as its minter — the script predicts the proxy's address from the deployer's
  nonce, exactly as it predicts the zapper's, and stops the run if the distributor lands
  elsewhere — and the distributor with `$ASSET` recorded and both launch reward tokens, so the
  deploy needs no wiring transaction at all.

### Runbook — operating the timelock

Everything owner-tier goes through `scripts/lp-timelock.js`. `hardhat run` takes no positional
arguments, so the subcommand and its operands arrive as environment variables, the same way
every other script in this repo reads its inputs:

```bash
# schedule, then (after minDelay) execute — the SAME operands both times
TIMELOCK_ACTION=schedule TIMELOCK_TARGET=LPStakingVault TIMELOCK_FN=setGuardian \
  TIMELOCK_ARGS=0xNewGuardian npx hardhat run scripts/lp-timelock.js --network mainnet
TIMELOCK_ACTION=execute  TIMELOCK_TARGET=LPStakingVault TIMELOCK_FN=setGuardian \
  TIMELOCK_ARGS=0xNewGuardian CONFIRM=yes npx hardhat run scripts/lp-timelock.js --network mainnet

TIMELOCK_ACTION=pending npx hardhat run scripts/lp-timelock.js --network mainnet
TIMELOCK_ACTION=status  TIMELOCK_ID=0x… npx hardhat run scripts/lp-timelock.js --network mainnet
TIMELOCK_ACTION=cancel  TIMELOCK_ID=0x… CONFIRM=yes npx hardhat run scripts/lp-timelock.js --network mainnet

# the canceller role: offer (run twice, schedule then execute), accept, check
TIMELOCK_ACTION=offer-canceller  CANCELLER_ADDRESS=0xApeSafe CANCELLER_TERM_DAYS=180 \
  CONFIRM=yes npx hardhat run scripts/lp-timelock.js --network mainnet
TIMELOCK_ACTION=accept-canceller CANCELLER_ADDRESS=0xApeSafe CANCELLER_TERM_DAYS=180 \
  npx hardhat run scripts/lp-timelock.js --network mainnet
TIMELOCK_ACTION=cancellers npx hardhat run scripts/lp-timelock.js --network mainnet

# withdraw an executed offer, revoke a canceller (each run twice, schedule then execute)
TIMELOCK_ACTION=withdraw-offer   CANCELLER_ADDRESS=0xApeSafe CONFIRM=yes \
  npx hardhat run scripts/lp-timelock.js --network mainnet
TIMELOCK_ACTION=revoke-canceller CANCELLER_ADDRESS=0xApeSafe CONFIRM=yes \
  npx hardhat run scripts/lp-timelock.js --network mainnet
```

**`cancel` checks first.** The script calls `canCancel(signer, id)` before it sends. When the
signer holds no canceller role it prints the `cancel` calldata for the canceller's Safe. When the
operation is not pending, or a term canceller's term ended before the operation was scheduled, it
prints the reason and sends nothing. REAL's Safe can cancel any pending operation.

**The canceller actions.** `offer-canceller`, `withdraw-offer` and `revoke-canceller` are calls of
the timelock on itself, so each is a scheduled operation. The same command runs twice: the first
run schedules, a run after the delay executes, and a run in between prints the ready time.
`offer-canceller` refuses the zero address, the timelock, a permanent canceller and a term outside
1 to 180 days before anything is scheduled. `revoke-canceller` refuses to execute before the
appointee's term end, where the execute would revert `CancellerTermActive`.
`revoke-canceller` refuses the zero address, the timelock itself and a permanent canceller before
anything is scheduled, and `CONFIRM_REVOKE_PERMANENT=1` lets a deliberate revocation of a permanent
canceller through, on this action and on a hand-built `revokeRole` alike (after it no permanent
canceller can be granted again without a timelock switch). `revoke-canceller` also refuses, before
scheduling, an address that holds no canceller role ("nothing to schedule"). `withdraw-offer`
refuses an offer that has already expired, and an offer that would expire before the withdrawal
could execute ("let it lapse"). `grantRole` refuses `CANCELLER_ROLE` (only an offer and its
acceptance reach it) and `DEFAULT_ADMIN_ROLE` (the timelock must stay its only holder) before
anything is scheduled. `lp-switch-timelock.js` refuses `deploy` while a `TimelockControllerNext`
entry exists, unless `SWITCH_REPLACE_NEXT=1`. `SWITCH_ACTION=check` is report-only: it never removes
the registry entry.
`accept-canceller` is
the appointee's own call, with no delay, inside the 7 days after the offer executed and naming the
offered term. It is sent when the signer is the appointee, and otherwise the calldata for the
appointee's Safe is printed. `cancellers` lists every canceller and every offer with its term end,
`isCancellerActive` and `expiresAt`. A renewal is a new offer and a new acceptance, scheduled at
least 48 h plus the signing time on both sides before the term end. Before a re-appointment after
a gap, REAL executes or cancels every pending operation, because operations scheduled in the gap
and still pending at the acceptance become cancellable by the appointee. A revocation after the
term is housekeeping: the veto on new operations already ended with the term.

**A canceller appointment does not move with a switch.** The role, the term end and any open
offer live in the old timelock's storage. After a switch the new timelock has REAL's Safe as its
only (permanent) canceller, so `offer-canceller` has to be run again on the new timelock: 48 h
for the offer, then up to 7 days for ApeBonds' acceptance. The switch batch on the OLD timelock
is itself an owner-tier operation, so a term canceller can cancel it while it is pending if it
was scheduled during the term. During a term the switch therefore needs ApeBonds' agreement, or
it waits until the term end and is scheduled after it.

**Rotating REAL's Safe and the canceller role.** `grantRole(CANCELLER_ROLE, x)` reverts for
every caller, the timelock's own scheduled call included, and `offerCancellerRole` caps every term
at 180 days. So after REAL rotates its Safe, the new Safe receives `PROPOSER_ROLE` and
`EXECUTOR_ROLE` through 48 h operations, but it can hold `CANCELLER_ROLE` only as a term canceller:
an offer, an acceptance, and a renewal at least every 180 days. The only road to a new permanent
canceller is a timelock switch (`scripts/lp-switch-timelock.js`), because the `LPTimelock`
constructor grants `CANCELLER_ROLE` with no term to every proposer. Operating rule: rotate REAL's
Safe together with a planned timelock switch, or run the new Safe as a term canceller and renew it
before every term end.

The owner tier is exactly: `acceptOwnership`, `transferOwnership`, `upgradeToAndCall` (all five
proxies), `setZapper`, `setBonusEscrow`, `setStakeOperator` (vault), `setGuardian` (vault, distributor),
`setOperator` (vault, distributor, registry, zapper), `addRewardToken`,
`setRewardTokenEnabled`, `setClaimsEnabled` (distributor), `setMinter` (Overture token),
`updateDelay`, `offerCancellerRole`, `withdrawCancellerOffer`, `grantRole` (never for `CANCELLER_ROLE`, which
the script refuses) and `revokeRole` (the timelock itself) — and, on a stack with the ApeBond route, `upgradeToAndCall`,
`acceptOwnership`, `transferOwnership`, `setAdapter`, `recoverSurplus` and `recoverSurplusAmount` (escrow) and
`setCampaign`, `setCampaignEnabled`, `setCampaignCaller`, `setSoulZapCaller`, `setGuardian`,
`setValuationWindow`, `acceptOwnership` and `transferOwnership` (adapter). `recoverSurplusAmount` is the
escrow's two-argument `recoverSurplus(to, amount)`: it moves a named amount of `balance − totalReserved`
(in wei, 18 decimals: 1,000 $ASSET = 1000000000000000000000), reverts
`SurplusExceeded(requested, available)` above the surplus and `NoSurplus` when nothing is free. Nothing else is routable, and nothing else needs to be. `setGuardian` stays on this list because the owner can still send it,
but since 2026-09-14 it is owner OR operator, so a guardian revocation or replacement that
cannot wait is sent DIRECTLY by the operator multisig instead of being scheduled here. `setTwapParams` LEFT this list on 2026-09-09 — it is operator-tier
now, sent directly by the multisig, and scheduling it here would revert
`OwnableUnauthorizedAccount` after the full delay. `setOperator` joined it, because moving the
tier that holds the recovery hatches is exactly the kind of decision that should be public
before it takes effect.

**Salt.** `salt = keccak256(abi.encode("real.lp.timelock.v1", target, keccak256(calldata),
tag))`, `predecessor = 0`. Deriving it from the call means schedule and execute agree without
anyone writing a value down, and a third party can recompute a pending operation's id from the
public calldata. The cost is that an identical call cannot be scheduled twice — once executed
its state is `Done` and OZ refuses to re-schedule that id — so a repeat needs
`TIMELOCK_SALT_TAG=<anything-new>`. OZ emits `CallSalt(id, salt)` next to every `CallScheduled`
whenever the salt is non-zero, which here is always.

**Mainnet bootstrap — there is nothing to schedule.** All five proxies are born owned by the
timelock: `initialize` names it inside each proxy's own deployment transaction, so the run ends
with `owner == timelock` and `pendingOwner == 0` on all five, on every network, with no
`acceptOwnership` operation anywhere. The deploy script builds no timelock operation at all.

That rests on one mechanism. The single owner-only call the old bootstrap needed was
`vault.setZapper(zapper)`, and it is now an `initialize` argument instead. A CREATE address is a
pure function of `(deployer, nonce)`, and every transaction in `deploy-lp-staking.js` carries an
explicit nonce, so the script can compute the zapper PROXY's address before the zapper exists:
the vault implementation takes nonce N, the vault proxy N + 1, the zapper implementation N + 2
and the zapper proxy N + 3. It passes `getCreateAddress({from: deployer, nonce: N + 3})` into
the vault's `initialize`, deploys the zapper, records it in `deployments.json`, and only then
asserts that its proxy landed on the predicted address.

**If the prediction misses.** Anything that consumes an unexpected nonce on the deploying key
between those transactions — a second process signing with the same key, a stuck replacement
transaction — puts the zapper somewhere else and the assertion throws. Nothing is lost: the
stack is deployed and every address is already recorded, staking, unstaking and rebalancing all
work, and the only casualty is the zap path, because the vault's `zapper` field names an address
with no code there. The repair is one owner-tier operation:

```bash
TIMELOCK_ACTION=schedule TIMELOCK_TARGET=LPStakingVault TIMELOCK_FN=setZapper \
  TIMELOCK_ARGS=<the address the zapper really landed on> npx hardhat run scripts/lp-timelock.js --network mainnet
# …wait out minDelay, then the same command with TIMELOCK_ACTION=execute CONFIRM=yes
```

The thrown error names that command and both addresses, so the repair does not have to be
reconstructed from the logs.

**What still needs the Safe after the deploy.** No ownership step. The operator multisig funds
the distributor (`scripts/lp-fund-rewards.js`: `mintRewardToken` `$OVTR` into it, transfer `$ASSET` into it)
and schedules epoch 1 at least 30 minutes ahead (`scripts/lp-epoch.js`). Both are operator
calls with no delay.

**Upgrades.** Build the new implementation, deploy it, then
`TIMELOCK_FN=upgradeToAndCall TIMELOCK_ARGS=<impl>,0x` (the second argument is the
reinitializer call, `0x` for none). The scheduled log carries the whole calldata, so the
implementation address is public for the full delay; `unstake` stays permissionless throughout,
which is what makes the delay an exit window rather than a formality. Run
`npm run validate:upgrades -- --network <net>` first: it grades the new layout against the
committed manifest and refuses a reordered or retyped field.

**Expected-implementation bookkeeping.** After an upgrade executes, update the recorded
`implementation` for that proxy in `deployments.json` (the deploy script writes it; an upgrade
does not) and re-commit `.openzeppelin/<network>.json`. The backend reconciler reads the same
figure and raises a CRITICAL alert when the indexed implementation is not the expected one, so
a stale record reads as an incident.

**Emergencies do not go through here.** Pausing deposits, pausing rebalance and pausing claims
are guardian-tier: one transaction from the hot key, no delay, no schedule — and the operator
multisig can send those same three calls whenever the guardian key is unreachable. Rotating the
voucher signer, rescuing a stranded NFT, `recoverExcess` and retuning the TWAP guard are
operator-tier: one transaction from the multisig, also undelayed. Revoking a compromised
guardian does not go through here either, since 2026-09-14: `setGuardian(address(0))` from the
operator multisig removes the hot key in one transaction, and a live address in the same call
appoints a replacement. If an incident needs a code change, the pause is the immediate
mitigation and the upgrade is the slow follow-up.

**`updateDelay` is self-only.** Shortening the delay is itself a scheduled operation on the
timelock's own address (`TIMELOCK_TARGET=TimelockController TIMELOCK_FN=updateDelay`), so it
cannot be used to escape the delay it is changing.

- The timelock path is exercised in the suites: the timelock-owned blocks in
  `test/lp-staking/RewardsDistributor.test.js`, `test/lp-staking/TokenOverture.test.js` and
  `test/lp-staking/LPStakingVault.test.js`, and both Hardhat integration suites, which route
  opening the `$ASSET` claims, adding a third reward token, cycling the zapper wiring and the
  rehearsal upgrade through `schedule -> increaseTime -> execute`; the local-fork suite also runs
  the whole planned timelock switch (`scripts/lp-switch-timelock.js`).
- The 2-step ownership mechanism itself is exercised on all five contracts in
  `test/forge/unit/AccessControl.t.sol` (item 3) and in the Hardhat unit suites.

### Sizes

`forge build --sizes`, 2026-10-05, optimizer as configured in `foundry.toml`:

| contract | runtime (B) | EIP-170 margin (B) |
|---|---|---|
| `LPStakingVault` (implementation; lane 2, with the stake-operator allowlist) | 16,897 | 7,679 |
| `LPStakingVault` as lane 1 ships it to mainnet (`LPStakingVaultLane1Mock`, test-only copy) | 16,516 | 8,060 |
| `LPZapper` (implementation) | 12,360 | 12,216 |
| `RewardsDistributor` (implementation) | 10,593 | 13,983 |
| `TokenOverture` (implementation) | 7,981 | 16,595 |
| `LPEpochRegistry` (implementation) | 7,766 | 16,810 |
| `LPTimelock` | 6,550 | 18,026 |
| `LPProxy` | 163 | 24,413 |
| `ApeBondPositionAdapter` (lane 2) | 10,180 | 14,396 |
| `BonusEscrow` (implementation, lane 2) | 9,086 | 15,490 |

The vault grew 15,256 -> 16,516 B for the bonus-escrow link and the two notifications (item 15);
the zapper 9,244 -> 12,360 B for the proxy machinery and the operator tier; the distributor
8,935 -> 10,593 B for the multi-token ledger and the token registry. 8,060 B of headroom against
the 24,576 B limit is the number to re-check before any future feature lands in the vault;
raising the optimizer runs is NOT the remedy if it ever gets close (Hardhat and Foundry must
produce identical bytecode) — refactoring is.

The V2 mocks (`*V2Mock`), `LPStakingVaultSwapHarness`, `LPZapperSwapHarness` and the three
escrow mocks appear in the same table and are NOT part of the deployment: they are test-only
contracts under `contracts/lp-staking/mocks/`.

## 15. Bonus-escrow notifications in the vault (B.3 P2/P3 vault side; OFF at launch)

`LPStakingVault` reports every exit and every re-range to a bonus escrow, so the ApeBond bonus
(lane 2: `BonusEscrow`, `ApeBondPositionAdapter`; on stack #6 since 6 Oct, and part of the
mainnet launch deploy since the decision of 14 Oct 2026) can be forfeited on an exit before its
cliff (P2) and scaled when a rebalance takes value out of the position (P3). The vault knows
nothing else about bonuses (decision A3 of the B.3 document).

- **Off at launch.** `bonusEscrow` is a storage field appended at the end of the vault's
  namespace, zero by default, announced at `initialize` (`BonusEscrowSet(0, 0)`), and changed
  only by the owner (the timelock) with `setBonusEscrow(address)`, which rejects a non-zero
  address without code. It also refuses to unlink or replace an escrow whose `totalReserved()` is
  above zero (`EscrowHasReservations`, audit C-13), so an escrow with live reservations is
  permanent until they are claimed or forfeited. Every deploy, mainnet included, creates the
  vault with zero; the ApeBond route's link batch, scheduled through the timelock after the
  deploy, then sets the escrow (the route is part of the mainnet launch deploy since the decision
  of 14 Oct 2026). While it is zero no notification is sent, and the only cost is one storage
  read per `unstake` / `rebalance`.
- **`unstake` fails OPEN** (A4: the exit stays unconditional). After `delete stakers[tokenId]`
  and before the NFT leaves, the vault requires `gasleft() >= bonusHookGasFloor()` (106,587 at the
  old fixed 100,000; 411,349 at today's default 400,000, item 20) —
  else `InsufficientGasForBonusHook()` — and calls `onUnstake(tokenId)` inside `try` with
  `bonusHookGas()` (100,000 fixed until item 20, now owner-set). If the escrow reverts, the exit completes and
  `BonusHookFailed(tokenId)` is emitted. That event means a bonus that should have been forfeited
  was not, so the backend's alert on it is MANDATORY whenever an escrow is linked. The floor is
  `100,000 × 64 / 63 + 5,000`: EIP-150 forwards at most 63/64 of the remaining gas, so without it
  a caller could pick a gas limit that starves the hook while the exit itself completes, and keep
  the bonus. `catch` copies no return data, so an escrow cannot turn its revert into a gas sink.
- **The allowance is measured, not guessed.** A realistic forfeiture (`MockForfeitingBonusEscrow`
  behind an `LPProxy`: the vault check from storage, two cold reservation slots,
  `totalReserved` read and write, the forfeiture writes, `BonusForfeited`) costs 29,941 gas
  measured from the caller (cold account included); a position with no reservation 14,628. The
  hook receives 99,764 gas at its first instruction. 100,000 is 3.3 times the forfeiture figure.
- **`rebalance` fails CLOSED.** The old position's `(tickLower, tickUpper, liquidity)` is read
  before its liquidity is withdrawn; after the staker record moves to the new NFT, the vault
  calls `onRebalance(oldTokenId, newTokenId, old, new)` with no `try`. A reverting escrow reverts
  the rebalance — failing open there would let a rebalance that takes value out of the position
  escape the escrow's scaling, which is P3 again. `unstake` stays available whatever the escrow
  does. `rebalance` keeps its refund behaviour; no refund limit was added (rejected 1 Oct).
- **P5, stated in the vault header:** no bonus check is made at claim time or by timestamp — "the
  position is staked when the bonus is claimed" is bypassed with a flash loan, "staked since time
  T" by a stake/unstake/stake inside one block — so the vault pushes each event as it happens.
- **P6, stated in the vault header — what rests on trust:** the adapter's router allowlist, the
  router's word for the beneficiary, and this vault's TWAP parameters (operator-tier, no delay,
  bounded to 300..3600 s and 1823 ticks), which the escrow reads to value a rebalanced position.

The backend half of P3/P4 (decision D9: scale every reward token's accrued-unclaimed amount on a
value-reducing `Rebalanced`, decision T13) does not depend on the escrow and runs from launch.

Tests: `test/forge/unit/VaultBonusHooks.t.sol` —
`test_Constants_TheFloorCoversTheAllowanceAfterTheSixtyFourthRule`,
`test_Unstake_WithNoEscrowMakesNoCall`, `test_Unstake_WithNoEscrowNeedsNoGasFloor`,
`test_Unstake_NotifiesTheEscrowAfterTheRecordIsDeletedAndBeforeTheNftLeaves`,
`test_Unstake_ForwardsTheFullAllowanceToTheHook`, `test_Unstake_ARevertingEscrowNeverBlocksTheExit`,
`test_Unstake_AnEscrowThatBurnsItsAllowanceNeverBlocksTheExit`,
`test_Unstake_RevertsBelowTheGasFloor`, `test_Rebalance_ReportsBothPositionsAndCallsAfterTheRecordMoved`,
`test_Rebalance_ARevertingEscrowRevertsTheRebalance`,
`test_Unstake_StillWorksWhileTheEscrowRefusesEveryRebalance`, the three `test_HookGas_*` cases and
`test_Storage_BonusEscrowSitsAtNamespaceSlotFive`; Hardhat: the "Bonus escrow hooks" block of
`test/lp-staking/LPStakingVault.test.js`.

## 16. `mintRewardToken`: the operator mints through the distributor; `$ASSET` never (2026-10-07)

Decision 2026-10-07 (Vladimir): every reward token the program DEPLOYS carries the same
`mint(address to, uint256 amount)` with exactly one minter, pinned as
`interfaces/IMintableRewardToken.sol` (`TokenOverture is IMintableRewardToken`; its bytecode is
unchanged). That minter is the `RewardsDistributor` PROXY, and the distributor gained one
operator-only function, `mintRewardToken(token, to, amount)`, which mints a registered reward token
to ONE concrete wallet: a user's wallet, or the distributor itself to pre-fund claims.

What a reviewer will ask, answered:

- **Did the operator gain power?** No. Before this change the operator multisig WAS the
  `$OVTR` minter and could mint any amount to any address with no delay. It still can, through
  the distributor, and nothing caps it — the same trust, one hop longer. What changed is WHO
  holds the mint right on the token: a contract whose only path to it is operator-gated.
- **Can a leaked signer or guardian key mint?** No. `mintRewardToken` is `onlyOperator`; the
  guardian and the owner are rejected with `NotOperator`. A claim never mints: it pays by transfer
  out of the funded balance, exactly as before (item 5).
- **`$ASSET` is refused by ADDRESS, whoever calls.** `$ASSET` is a token this program does not
  control. The distributor stores it (`asset`, appended to the namespace, item 14) and the FIRST
  check of `mintRewardToken`'s body is `token == asset -> AssetNotMintable(token)`, before the
  token is ever called — so even a `$ASSET` that exposed a `mint` the distributor could reach
  would never be asked. Measured on a twin whose recorded `asset` is a token that WOULD mint for
  it (`test_MintRewardToken_RefusesAssetEvenWhenTheTokenWouldMint`).
- **Any other token's refusal is not wrapped.** A registered token with no `mint` reverts inside
  the token; a token whose minter is not this proxy reverts with its own error
  (`TokenOverture.NotMinter(distributor)`). Check order: `NotOperator` -> `AssetNotMintable` ->
  `UnknownRewardToken` (registered is the gate; `enabled` and `claimsEnabled` are ignored) ->
  `ZeroAddress` (`to`) -> `ZeroAmount` -> the token's `mint` -> `RewardTokenMinted(token, to,
  amount, timestamp)`.
- **No `nonReentrant`.** The function writes no distributor storage; a token that calls back
  during `mint` finds no half-written state.
- **No ledger moves.** `claimed[token][user]` is written by `claim` alone; tokens minted to a
  user's wallet are outside the voucher accounting, and the backend must treat them that way.
- **The deploy.** `scripts/deploy-lp-staking.js` predicts the distributor proxy's CREATE address
  (token implementation at nonce M, token proxy M + 1, distributor implementation M + 2,
  distributor proxy M + 3), passes it to the token's `initialize` as the minter, and stops the
  run with the repair named if the distributor lands elsewhere. `scripts/add-reward-token.js`
  defaults a new token's minter to the distributor proxy.
- **A live stack** (stack #6 was deployed with the operator as minter) is activated by two
  timelock operations: `RewardsDistributor.upgradeToAndCall(newImpl, initializeV2($ASSET))` and
  `TokenOverture.setMinter(distributor proxy)` — `scripts/README.md`, "Activating mintRewardToken
  on a live stack". Until both have executed, `scripts/lp-fund-rewards.js` falls back to the
  direct `TokenOverture.mint` when the signer is still the minter, and says so.

Tests: `test/forge/unit/DistributorBranches.t.sol` — the `test_MintRewardToken_*` cases (every
branch: wallet, distributor, unregistered, zero recipient, zero amount, check order, switches
ignored, the token's `NotMinter` bubbling, `$ASSET` by address twice, a token without `mint`,
operator only) and the `test_InitializeV2_*` cases (the atomic upgrade from the v1 state, once,
owner only, zero rejected with the whole upgrade, a fresh proxy, the implementation);
`test/forge/unit/AccessControl.t.sol` — `mintRewardToken` and `initializeV2` across the tier
matrix; `test/forge/unit/TokenOverture.t.sol:test_Mint_CarriesTheIMintableRewardTokenShape`;
Hardhat: the `mintRewardToken` block and the timelock migration in
`test/lp-staking/RewardsDistributor.test.js`, the activation in
`test/lp-staking/DeployImplementation.test.js`, and S9 / A29 of both integration suites (funding
through `lp-fund-rewards.js` and `lp-mint-reward.js`).

## 17. `ApeBondPositionAdapter` — the gate that computes the bonus (B.3, stack #6 and the mainnet launch)

Lane 2, from the B.3 decision document (2026-10-01) with the overrides of 2026-10-05. Sepolia test
stack #6 carries it since 6 Oct, and it is part of the mainnet launch deploy since the decision of
14 Oct 2026 (path (a), `LP_APEBOND_ENABLED=1`).

**The contract computes the bonus (P1, A1).** SoulZap arrives with a finished Uniswap V3 position
and calls `depositFor(tokenId, campaignId, beneficiary)`. There is no signature, no `purchaseId`
and no bonus number from the router or from a backend: the adapter reads the position, values it
at the vault's TWAP — `PositionValue.valueAt(liquidity, tickLower, tickUpper, twapTick,
bonusIsToken0)` — and takes the campaign's rate of it, `bonus = value × bonusBps / 10,000`, zero
when below the campaign's `minBonusAmount` (D6: such a purchase is staked normally and gets no
reservation; nothing reverts). The deposit reverts when spot is outside the vault's TWAP bounds
(`PriceOutsideTwapBounds`), so a price pushed inside the transaction cannot be the valuation
price; and valuing at the TWAP is conservative whatever spot is (B.3 §5.1). **Since audit L-02
(27 Oct 2026) the valuation tick is the adapter's own:** the arithmetic-mean tick over
`valuationWindow` (`pool.observe([valuationWindow, 0])`, floored like the vault's TWAP; 1800 s at
deployment, owner-set through `setValuationWindow`, bounded 300..3600 s and checked against the
pool's history like every window setter). The spot check above stays on the vault's TWAP
(`vault.previewTwap()`), which keeps spot, and so the band, near the real price. A price HELD down
moves the bonus by its share of the window: a -5 % price for 5 minutes raises it by about 0.4 % at
1800 s against about 2.5 % at 300 s (measured: +42 and +251 bps,
`test_ValuationWindow_AHeldPriceMovesTheBonusByItsShareOfTheWindow`). There is no cap.
`BonusEscrow._scaled` stays on the vault's TWAP: it is a ratio of two values at one price. Uncollected fees are
not counted (L7). Removed with the signature: `EIP712`, `ECDSA`, the purchase struct and typehash,
`purchaseSigner` / `setPurchaseSigner`, the spent-id and nonce books, six errors and four
constructor arguments; the backend holds no purchase-signing key.

**No limit of any kind (override O2).** A campaign is its band, its cliff (`bonusCliffSeconds`),
its rate (`bonusBps ≤ 10,000`) and its minimum. The band is not a fixed range (Vladimir's decision
of 14 Oct 2026): the campaign stores two offsets around the $ASSET price at the purchase —
`downTicks` below it and `upTicks` above it (the deploy scripts default to −50 % and +100 %, 6932
ticks each) — and a `toleranceTicks` (default 500, at least the pool's tick spacing), validated in
`setCampaign` (`InvalidCampaignOffsets`). At each deposit `campaignRange` places the band around
the pool's spot tick, rounded outward to the tick spacing and clamped to Uniswap's usable bounds,
and the NFT is accepted when each of its edges is within the tolerance of the band's edge. There
is no per-purchase, per-campaign, daily or total cap, and the escrow records a bonus whatever its
balance is (item 18). The consequence is stated rather than mitigated: the total promise has no
ceiling on-chain, all campaigns share one escrow balance (L5), and what bounds the payout is the
company's funding — claims revert until it arrives. A zero cliff is no longer a configuration
choice: `setCampaign` refuses a cliff below the adapter's immutable `minCliffSeconds`
(`CliffBelowMinimum`, audit C-14; never zero, at least 86,400 s on mainnet as the deploy scripts
enforce, 300 s on Sepolia stack #6), so no bonus unlocks before an exit could forfeit it.

**Order inside `depositFor` (B.3 §5.4, with step 0 of audit C-12).** The vault reports to this
adapter's escrow (`vault.bonusEscrow() == escrow`, else `EscrowNotLinked`) → pause → global
allowlist AND campaign allowlist → campaign exists and is enabled → beneficiary not zero / adapter
/ vault / position manager (SEC-05, item 11) → caller owns the NFT and approved the adapter → pool,
fee, ticks within the tolerance of the band computed from the spot tick
(`TickRangeOutsideTolerance`), liquidity > 0 → TWAP within bounds → value and bonus → pull the
NFT in the receive window, `vault.stakeFor` → `escrow.reserve` when the bonus is above zero →
custody assertion → `ApeBondPositionDeposited(tokenId, campaignId, beneficiary, liquidity,
tickLower, tickUpper, twapTick, positionValue, bonusAmount, bonusUnlockAt)`. The three reported
input fields (`inputToken`, gross, net) are left out, the document's recommendation for open item
O4. A second deposit of the same NFT cannot earn a second bonus: the escrow keeps every record,
forfeited ones included, and refuses a duplicate.

**Writes nothing.** `depositFor` changes no storage of the adapter: the reentrancy lock
(`ReentrancyGuardTransient`) and the NFT receive window are EIP-1153 transient storage, so the
contract's storage is configuration set by the timelock and nothing else (pragma `0.8.38` since audit I-02).

**Pool facts are read, never configured.** `token0`, `token1`, `fee` and `tickSpacing` are read
from the vault (and its pool) at construction; `bonusIsToken0` from `escrow.bonusToken()`, which
must be a pool token; and the constructor refuses an escrow whose `vault()` is not this adapter's
vault (`EscrowVaultMismatch`) — a mis-paired deploy fails at once instead of reserving bonuses no
hook will ever forfeit.

**Replaceable, not upgradeable; no rescue, sweep or arbitrary call** — unchanged reasoning: the
adapter holds configuration only. Replacement (B.3 §5.5) is a new deployment, its campaigns and
callers, the nomination of the timelock, then ONE timelock batch `adapter.acceptOwnership()`,
`vault.setStakeOperator(new, true)`, `vault.setStakeOperator(old, false)`, `escrow.setAdapter(new)`
(`scripts/deploy-apebond.js LP_APEBOND_MODE=replace-adapter`).

**Two-step ownership (audit L-03).** The adapter is `Ownable2Step` and `renounceOwnership` reverts
`RenounceDisabled`, like the five proxies and the escrow. The deploying key configures it, then
`transferOwnership(timelock)` only nominates: until the activation batch executes, the adapter is
in a third state, `owner() == deployer` and `pendingOwner() == timelock`, and the batch's first call
is `adapter.acceptOwnership()`. The scripts add that call exactly in that state, resume from it and
check it (`LP_APEBOND_MODE=verify` asserts `pendingOwner() == timelock` before execution).

**Two tiers.** Owner (the timelock): `setCampaign`, `setCampaignEnabled`, `setCampaignCaller`,
`setSoulZapCaller`, `setGuardian`. `setGuardian` also accepts the vault's operator, read live from
`vault.operator()` (audit C-29; `NotOwnerOrOperator` for anyone else), so a leaked pause key is
replaced without the timelock delay. Guardian (a pause key, `LP_APEBOND_GUARDIAN`, default the
stack's `LP_GUARDIAN`): `pauseDeposits` only — narrower than the vault's deposit pause, which
stops every staker. With the signer gone, the guardian holds nothing but the pause. The vault's
operator (read live) also pauses, and it is the only tier that calls `unpauseDeposits` (audit
L-01), so a leaked guardian key cannot lift a pause set during an incident.

**What still rests on trust (P6).** The caller allowlists decide who can earn a bonus; after D1 a
compromised caller gains nothing unless real capital stays staked through the cliff. The
beneficiary is the router's word. The valuation window (owner-tier, the timelock, 300..3600 s) sets
the valuation price; the vault's TWAP parameters (operator-tier, no delay, 300..3600 s and ≤ 1823
ticks) bound spot at each deposit.

Tests: `test/forge/unit/ApeBondAdapterBranches.t.sol` (every revert by selector and arguments, the
order of the checks, the formula against `PositionValue`, the minimum's inclusive boundary, the
custody assertion through `MisreportingVault`), `test/forge/unit/BonusEscrowHooks.t.sol` (through
the real vault), `test/lp-staking/ApeBondPositionAdapter.test.js` (a BigInt port of the contract
math, `test/lp-staking/helpers/positionValue.js`), and the integration suites.

## 18. `BonusEscrow` — the whole life of a bonus (B.3, stack #6 and the mainnet launch)

**A clean version-1 layout.** Reservations are keyed by the position's `tokenId` (A5, D4) —
`Reservation{beneficiary, unlockAt, claimed, forfeited, amount}` in `mapping(uint256 =>
Reservation)` inside the ERC-7201 namespace `real.lp.storage.BonusEscrow`
(`0x206c24b6…05456200`, pinned and re-derived by a test) together with `adapter` and
`totalReserved`. `bonusToken`, `vault` and `bonusIsToken0` are implementation immutables; the
constructor proves the bonus token is one of the vault's pool tokens. Sepolia stack #5's escrow
(purchase-id keys) is abandoned, not upgraded, so no `reinitializer(2)` and no appended layout
were needed (the design agent's recommendation; the document's appended layout was the fallback).
UUPS, owned by the timelock, two-step, `renounceOwnership` disabled.

**Reserve now, fund later (override O2).** `reserve` (adapter only; `NotAdapter`, `ZeroAddress`,
`ZeroAmount`, `DuplicateReservation`) records the bonus whatever the balance is: the `Underfunded`
check is gone. `claim(tokenId)` (anyone; pays the RECORDED beneficiary) reverts in this order:
`UnknownReservation`, `AlreadyClaimed`, `Forfeited`, `CliffNotReached`, then
`InsufficientFunds(needed, balance)` while the escrow holds less than the amount — all or nothing,
nothing changes on a revert (I8). `totalReserved` may exceed the balance; the backend alerts when
it does (`lp.escrow.underfunded`). `recoverSurplus` moves `balance − totalReserved` and reverts
`NoSurplus` when nothing is free, including while more is owed than held. The two-argument
`recoverSurplus(to, amount)` moves a named amount of that surplus, reverts
`SurplusExceeded(requested, available)` above the surplus and `NoSurplus` when nothing is free.

**Conditional on staying staked through the cliff (D1, D3, D8).** A reservation is ACTIVE while
it exists, is neither claimed nor forfeited, and `block.timestamp < unlockAt`. The vault's two
notifications (item 15) act only on an active reservation:
- `onUnstake` FORFEITS it: `totalReserved −= amount`, `amount = 0`, `forfeited = true`,
  `BonusForfeited`. The record stays, so the NFT can never carry a second bonus. No external call
  and no transfer. Measured with the real escrow behind its proxy, from the caller with cold slots:
  **20,969 gas** forfeiting a live reservation, **5,647** for a position with no reservation —
  against the vault's fixed `BONUS_HOOK_GAS` of 100,000 (lane 1 sized it on a mock at 29,952).
- `onRebalance` MOVES it to the new `tokenId` and SCALES it: both snapshots valued with the same
  `PositionValue.valueAt` at the vault's `previewTwap()` tick (deviation flag not consulted — one
  price for both), `newAmount = amount` when the value did not fall, else `amount × valueNew /
  valueOld` (zero when the old position is worth nothing); never an increase (I2). The record is
  written under the new id (`forfeited` when zero) and deleted under the old one, which the vault
  burns in the same transaction; `BonusMoved(old, new, beneficiary, amount, newAmount)`.
- An INACTIVE reservation returns at once and reads no oracle: after the cliff nothing the vault
  reports can touch the bonus (a post-cliff rebalance leaves it under the OLD id, claimed with that
  id), and an ordinary staker's rebalance never depends on `observe` (L2 applies only to a position
  carrying an active bonus; its `unstake` stays open).

**The P3 vector, measured** (B.3 §3, through the real vault on real liquidity math,
`test_P3_TheDocumentsTwoRebalanceWithdrawalScalesTheBonus`): $10,000 at $0.25 on 0.2000–0.3125,
bonus 10 %; a no-swap rebalance to 0.1368–0.25075 refunds ≈19,885 ASSET and leaves the bonus at
**50.2773 %**; a second one to 0.24925–0.4569 refunds ≈4,997.5 USDC and leaves it at
**0.2895 %** — exactly the share of value still staked.

**No pause, no guardian, no admin function that touches a reservation (Q5).** A reservation changes
only by rule: `reserve`, the two notifications, `claim`.

**Invariants** I1–I7 of B.3 §5.6 plus I8 hold in `test/forge/invariant/BonusEscrowInvariants.t.sol`
(512 runs × depth 50 under the ci profile).

**Libraries and licence.** `TickMath` (only `getSqrtRatioAtTick`) and `LiquidityAmounts` (only
`getAmountsForLiquidity` and its two helpers, OpenZeppelin `Math.mulDiv` instead of `FullMath`) are
vendored from Uniswap's `0.8` branches with their GPL-2.0-or-later headers; whether that is
acceptable in this MIT repository is open item O6. `PositionValue` is ours. A Sepolia-fork test
(`test/forge/fork/PositionValueFork.t.sol`) shows the library's amounts equal what
`decreaseLiquidity` returns to the wei at spot = TWAP.

Tests: `test/forge/unit/BonusEscrowBranches.t.sol`, `test/forge/unit/BonusEscrowHooks.t.sol` (the
loop, P3, value-keeping and fee-compounding rebalances, the after-cliff orderings, the oracle,
funding, gas), `test/forge/unit/PositionValue.t.sol`, the invariant suite above,
`test/lp-staking/BonusEscrow.test.js`, and the integration suites.

## 19. Staking v3 — scope note for the audit (new contracts and the vault listener, 2026-11-09)

The staking v3 campaign (decisions of Brandon and Vladimir, 2026-11-09) adds three UUPS contracts
under `contracts/staking-v3/` and one owner-tier link on `LPStakingVault`. Everything else in this
document is unchanged; the rebalance logic and every valuation of the vault are untouched.

**In scope, new:**

| File | What it is |
|---|---|
| `contracts/staking-v3/WeightedStakingPoolV3.sol` | `WeightedStakingPool` (v2) as a UUPS implementation in one ERC-7201 namespace (`real.staking.storage.WeightedStakingPoolV3`): the same lifecycle, vouchers (domain `WeightedStakingPool` / `1`), exits and events, WITHOUT v2's principal penalty (decision of 2026-11-10, below); plus `stakeFor(user, amount, weight)` callable only by `migrator`, and a FAIL-CLOSED `bonusVault.onEarlyExit(user)` in `withdraw` (after the state changes, before the transfers). Ownership two-step, `renounceOwnership` reverts, so v2's "owner renounced" switch and its branches are gone |
| `contracts/staking-v3/V3BonusVault.sol` | The transition bonus book, namespace `real.staking.storage.V3BonusVault`: one v3 reservation per user (forfeited whole by `onEarlyExit` before the unlock) and one LP reservation per tokenId with `BonusEscrow`'s semantics (moved and scaled down only on `onRebalance`, forfeited on `onUnstake` before the unlock, untouchable after). Reserve now, fund later; `claim()` all or nothing, `InsufficientFunds(requested, available)` when short; `recoverSurplus(to, amount)` above `totalReserved` only |
| `contracts/staking-v3/StakingMigrator.sol` | The one-call transition after the staker's own sw2 `unstake()`: `compound` (USDC swapped through SwapRouter02 under its own `TwapGuard`, 300 s / 953 ticks), `moveToLp` (one position on spot ± 6,932 ticks rounded outward, the adapter's `_campaignRange` math, staked through `vault.stakeFor`; the USDC leg valued at the 1,800 s mean tick, `OracleHistory`), `claimRestake`. Each checks an EIP-712 `TransitionVoucher` (domain `StakingMigrator` / `1`) and spends its per-user nonce before any token moves. Routes 1 and 2 behind `pauseCompound` (vault guardian or operator) / `unpauseCompound` (operator), born paused; route 3 never paused. Namespace `real.staking.storage.StakingMigrator` |
| `contracts/staking-v3/interfaces/IStakingV3.sol` | The three cross-contract interfaces |

**In scope, changed:** `LPStakingVault.setBonusListener(address)` (owner), `bonusListener` appended
after `stakeOperators` in the vault namespace (layout validated against the live Sepolia stack #6
proxy), and two notifications to it in `unstake` and `rebalance`, right after the escrow's. They
follow the escrow's split since 2026-11-10 (see "Change of 2026-11-10" below): `onUnstake` FAILS
OPEN inside `try` with `bonusListenerGas()` (250,000 fixed at first, owner-set with default 1,000,000
since item 20), behind `bonusListenerGasFloor()` (`InsufficientGasForBonusHook` below it),
`BonusListenerFailed(tokenId)` on a revert; `onRebalance` FAILS CLOSED like the escrow's: no `try`,
all the remaining gas, a revert reverts the rebalance. (From 2026-11-09 to 2026-11-10 both failed
open.) `setBonusListener` refuses a code-less address (`NotAContract`), refuses a listener whose
`vault()` is not this vault (`ListenerVaultMismatch(listener, itsVault)`, since 2026-11-10) and, by
the C-13 rule, refuses to unlink or replace a listener whose `totalLpReserved()` is above zero
(`ListenerHasReservations`). Since 2026-11-10 the vault also records, per tokenId, the moment the
listener's `onUnstake` first failed (`listenerMissedAt(tokenId)`, see "Review closure" below).

**Deliberate properties a reviewer is expected to flag:**

- **The listener's `onUnstake` fails open; its `onRebalance` fails closed (since 2026-11-10).** An
  `onUnstake` that reverts or runs out of its allowance leaves the LP reservation under the
  unstaked tokenId, unsettled, and the vault writes `listenerMissedAt[tokenId] = block.timestamp`
  (only the FIRST miss per tokenId; never overwritten). The bonus vault compares that moment with
  the record's unlock: a miss BEFORE the unlock means the forfeit of an early exit was missed (the
  record is DEAD and never pays, even when the same NFT is staked again); a miss AT OR AFTER the
  unlock means the settlement of a legitimate exit was missed (the record is MISSED-AFTER and pays
  as if settled). `V3BonusVault.reconcileLp(tokenId)` (permissionless) makes that explicit:
  before the unlock it forfeits a dead record or one the vault no longer holds for its user; after
  the unlock it settles a missed-after record (`LpBonusSettled`) and forfeits any record that is
  neither settled, nor missed-after, nor held. The backend sends no transaction: for every
  `BonusListenerFailed` event it raises the alert `lp.vault.bonus_listener_failed` with the action
  "call V3BonusVault.reconcileLp(tokenId) from any wallet", and the operator (or anyone) sends it,
  before or after the unlock. An exit whose notification failed after the unlock therefore KEEPS
  its LP bonus (the rule of 2026-11-10, "an after-unlock `onUnstake` that fails open loses the
  bonus", is replaced by the review closure below). A rebalance cannot leave a stale record: its
  notification reverts the whole rebalance.
  The rebalance notification has no allowance any more (fail closed, all the remaining gas), so
  there is no margin to keep: its cost is gas the rebalance itself carries. Measured: 186,500 gas on
  the real Sepolia pool in the fork suite after the review closure (`eth_estimateGas` of
  `onRebalance` sent from the vault's address, including the 21,000 intrinsic gas; 182,405 before
  it; the extra read is `listenerMissedAt`), and 339,409 on live stack #6 after Glamsterdam (item
  20). `onUnstake` measures 52,197 on the fork basis against its 1,000,000 allowance.
  `BonusListenerFailed` must be alerted on, like `BonusHookFailed`.
- **The v3 pool trusts the migrator for the weight.** `stakeFor` verifies no pool voucher: a
  compound's amount is known only after its swap. The weight is the one the backend signed in the
  `TransitionVoucher`; the pool still bounds it to 1000..2000.
- **The migrator's `setSigner` is operator tier** (undelayed, the LP vault's operator), like the
  distributor's: a leaked voucher key must be replaceable without the 48 h delay. A leaked key lets
  its holder reserve bonuses on their own deposits only; the reservation still needs the tokens
  staked to the end and the vault funded.
- **`moveToLp` mints with the whole USDC and the whole $ASSET as desired amounts.** The position
  manager takes the matching pair at the spot price; the USDC it leaves is refunded, the $ASSET it
  leaves is staked in v3. The spot is bounded by the migrator's TWAP guard before the mint, and the
  caller's `amount0Min` / `amount1Min` bound the mint itself.
- **v3 holds no USDC.** The reward slot is kept, and the initializer flag `rewardsWaived` (set by
  the deploy script) makes `addRewards` revert "Rewards waived" and `unstake` after the end pay the
  principal with a zero reward. A pool initialized without the flag keeps v2's rule.
- **The bonus unlock is the v3 pool's `endEpoch`,** read by the migrator at each transition; the
  bonus vault keeps the latest unlock per user.

**Changes after the internal security review (2026-11-09, same day):**

| Finding | Change |
|---|---|
| The exit after the end needed funded rewards | `rewardsWaived` initializer flag (event `RewardsWaivedSet(bool)`): `unstake` requires `totalRewards > 0 \|\| rewardsWaived`, `addRewards` reverts "Rewards waived" when set |
| M1 — routes open before the timelock owns the contracts | `pool.setMigrator` and `bonusVault.setMigrator` moved from the deployer's direct wiring into the timelock batch, right after the three `acceptOwnership` calls |
| M2 — a failed listener notification left a stale reservation payable | permissionless `V3BonusVault.reconcileLp(tokenId)`: forfeits an active LP reservation when `vault.stakerOf(tokenId) != user`, else a no-op |
| M3 — several transitions per sw2 claim | `StakingMigrator.migrated(user)`: set by the first successful route call, later calls revert `AlreadyMigrated(user)`; the nonce check stays |
| M4 — no cap on what the vault may owe | `V3BonusVault.maxTotalReserved` (initializer + owner `setMaxTotalReserved`, event `MaxTotalReservedSet`): `reserve` / `reserveLp` revert `BudgetExceeded(requested, remaining)` above it |
| L1 — no custody check after `vault.stakeFor` | `moveToLp` asserts `ownerOf(tokenId) == vault && vault.stakerOf(tokenId) == caller`, else `CustodyAssertFailed(tokenId, owner, staker)` |
| L2 — a swap at a moved spot raised the compound bonus | bonus base = principal + min(bought, `usdcInAsset(usdcAmount)`); `minAssetOut == 0` reverts `MinAssetOutZero` |
| L3 — `setVault` could strand LP reservations | `setVault` reverts `LpReservationsOutstanding(totalLpReserved)` while any LP reservation is open; `setPool` only with the pool's `setBonusVault` |
| L4 — the vault's unlink guard counted v3-pool reservations | `V3BonusVault.totalLpReserved()`; `LPStakingVault.setBonusListener` reads it instead of `totalReserved()` |
| L5 — the migrator accepted a pool or vault on another token | `initialize` requires `stakingPool.stakingToken() == asset` and `bonusVault.bonusToken() == asset` (`TokenPairMismatch`) |
| L6 — the fork suite did not exercise the live upgrade | the suite starts from a proxy on the 746b22c vault (`LPStakingVaultPreListenerMock`) and executes `upgradeToAndCall` inside the batch; an LP unstake before the unlock forfeits on the real pool; both listener gas figures are printed |
| L7 — the deploy script claimed to resume but redeployed | recorded kinds are reused ("recorded at …, reused") |

**Change of 2026-11-10: a failed hook can no longer leave a record that pays.** Found on Sepolia
stack #6 on 2026-11-09 (item 20): wallet B's position 234214 carried an LP reservation of 235.315
tREAL; B rebalanced into 234216; the listener's fail-open `onRebalance` ran out of its 250,000 gas;
the vault emitted `BonusListenerFailed(234214)` and completed the rebalance. The reservation stayed
under the burned id 234214 (user B, active, unlock = the v3 end), 234216 got none, and `claim()` —
which then paid every record in `lpTokens[user]` that was unlocked, not claimed and not forfeited —
would have paid B the 235.315 tREAL after the unlock even if B had left the LP pool. Raising the
allowance (item 20) removed that one failure, not the design that let a failed hook leave a payable
record. Two changes:

1. `LPStakingVault`: the listener's `onRebalance` is FAIL CLOSED, exactly like the escrow's (item
   15): no `try`, no allowance, all the remaining gas, a revert reverts the rebalance. A re-range
   whose bonus re-scaling cannot run does not happen; `unstake` stays open whatever the listener
   does. `onUnstake` stays fail open with `bonusListenerGas` and its floor (an exit is never blocked
   by a bonus contract), so `BonusListenerFailed` is now emitted by `unstake` only. The allowance's
   storage field, bounds and floor are unchanged; the vault's storage layout is unchanged.
2. `V3BonusVault`: `claim()` pays an LP record only when the vault still holds the position for the
   record's user (`vault.stakerOf(tokenId) == r.user`) OR the record is SETTLED. A vault
   notification for a record whose unlock has passed (`onUnstake(tokenId)`, or
   `onRebalance(oldTokenId, …)`, which until now returned without touching anything) settles it:
   `lpSettled[tokenId] = true`, event `LpBonusSettled(tokenId, user)`; the record stays under its
   tokenId, unscaled, and pays. A record whose position the vault no longer holds for its user and
   that is not settled is stale and pays nothing; `reconcileLp(tokenId)` now forfeits it after the
   unlock too (before the unlock: unchanged), so `totalLpReserved` cannot stay inflated; a settled
   record is never touched. Storage: `mapping(uint256 => bool) lpSettled` APPENDED at the end of the
   ERC-7201 struct (slot base + 10); no existing field of `LpReservation` or of the struct moved
   (validated against the stack #6 proxy `0x7203…5221`). New view `lpSettled(tokenId)`; the
   `lpReservation(tokenId)` tuple is unchanged because the indexer vendors that ABI.

`claim()` and `claimable()` now make one `stakerOf` view call per unsettled unlocked LP record of
the caller (a user has one or two). With no vault linked an unsettled record is not payable; that
state is reachable only on a bonus vault that was never linked.

**Review closure (2026-11-10): what a failed `onUnstake` means is reconstructed from its time.**
An independent review of the change above found three Low findings.

1. and 2. (one mechanism). A failed fail-open `onUnstake` left the LP record unsettled with no trace
   in the bonus vault. (a) An EARLY exit whose forfeit notification failed could re-stake the same
   NFT (even in the same transaction from a contract wallet): `stakerOf(tokenId) == user` again,
   `reconcileLp` refused to forfeit, `claim()` paid after the unlock, and a later after-unlock
   unstake even SETTLED it. (b) A LEGITIMATE after-unlock exit whose settle notification failed paid
   nothing and anyone's `reconcileLp` forfeited it. Closure:
   - `LPStakingVault`: `mapping(uint256 => uint64) listenerMissedAt` APPENDED to the namespace
     after the gas slot (slot base + 9; base `0x4c83…6500`; layout validated against the live
     stack #6 proxy `0x4B2f…2eac`). The `catch` branch of the listener's `onUnstake` writes
     `block.timestamp` only while the entry is zero, then emits `BonusListenerFailed` as before.
     View `listenerMissedAt(tokenId)`. The write uses the caller's gas left after the allowance;
     when it does not fit, the whole `unstake` reverts and is retried with a higher gas limit.
   - `V3BonusVault`, with `missedAt = vault.listenerMissedAt(tokenId)` and the record's
     `unlockAt`: DEAD = `missedAt != 0 && missedAt < unlockAt`; MISSED-AFTER = `missedAt != 0 &&
     missedAt >= unlockAt`. `claim()` / `claimable()` pay nothing for a dead record and pay a
     settled or missed-after record, otherwise only while `stakerOf(tokenId) == user` (the
     claimed / forfeited / before-unlock checks first). An after-unlock `onUnstake` / `onRebalance`
     never settles a dead record: it forfeits it. A before-unlock `onRebalance` never moves a dead
     record: it forfeits it (and the rebalance completes). `reconcileLp` as described above;
     settled records are never touched.
3. `setBonusListener(newListener)` requires, for a non-zero listener, `newListener.vault() ==
   address(this)`, else `ListenerVaultMismatch(listener, itsVault)`: the listener's `onRebalance`
   is fail closed and accepts its own vault only (`NotVault`), so a listener bound to another vault
   would revert every rebalance. Order of operations: link the vault to the listener first (the
   listener's `setVault(vault)`, or its initializer), then `setBonusListener(listener)`; to unlink,
   `setBonusListener(0)` first. The staking v3 deploy already satisfies it: `V3BonusVault.initialize`
   sets the vault before the timelock batch runs `setBonusListener(bonusVault)` (the fork suite runs
   that batch).

Validated with `upgrades.validateUpgrade` against both live stack #6 proxies (vault `0x4B2f…2eac`,
implementation `0x2eBA…886Ba`; bonus vault `0x7203…5221`, implementation `0xB395…1478`): both new
implementations are valid upgrades (2026-11-10, Sepolia block 12104164). Sizes (`forge build
--sizes`): `LPStakingVault` 20,076 B runtime (4,500 B under EIP-170; was 19,717 B), `V3BonusVault`
13,634 B (was 12,988 B), `StakingMigrator` 21,487 B (unchanged).

Accepted residue: `listenerMissedAt` is keyed by tokenId and never cleared. A tokenId whose listener
`onUnstake` failed while it carried NO record, and which later receives a record, would read as dead
from the start. A no-record `onUnstake` returns at once and cannot fail inside a 1,000,000 allowance
behind its floor, so this needs a broken listener; it is noted, not handled.

The pending stack #6 record 234214 (B, 235.315 tREAL) has `listenerMissedAt(234214) == 0`: its
failure was the listener's `onRebalance` in the OLD vault code, which wrote nothing. The new rule
therefore falls back to `stakerOf(234214) == 0 != B` and `reconcileLp(234214)` FORFEITS it, before
the unlock and after it alike.

Live on stack #6 since block 12104265 (2026-11-10 13:14 Sofia, 11:14 UTC): bonus vault implementation
`0xFC95…f9C2`, vault implementation `0x5517…0D73`, one timelock batch; `reconcileLp(234214)` then
forfeited B's 235.314762005877517222 tREAL (block 12104270). Records: scripts/README.md.

Tests: `test/forge/unit/{WeightedStakingPoolV3,V3BonusVault,StakingMigrator,VaultBonusListener}.t.sol`,
`test/forge/fuzz/StakingV3Fuzz.t.sol`, `test/forge/invariant/V3BonusVaultInvariants.t.sol` (I1
`totalReserved` equals the sum of open reservations, I2 balance conservation, I3 scaling never raises,
I4 a claim pays exactly or the vault is short, I5 `totalLpReserved` equals the sum of open LP
reservations), and `test/lp-staking/integration/StakingV3SepoliaFork.test.js`
(the three routes end to end on the real Sepolia Uniswap deployment, the timelock batch, the
rebalance scaling, early-exit forfeiture, claims before and after funding).

**Decision of 2026-11-10: no principal penalty in v3.** `WeightedStakingPoolV3` is a separate
contract from v2 and does not carry v2's early-withdrawal penalty (5 % to 50 % of the withdrawn
amount, sent to `0xD6719Ce10F1b499Bd8FE022AB045b991b996dA6a`). A `withdraw` before `endEpoch` now
returns the withdrawn principal in full to the user. It has exactly two consequences: the
accumulated weight of the withdrawn share is forfeited (as before), and the bonus vault forfeits the
user's whole v3 bonus reservation through `onEarlyExit` (as before, fail closed). Nothing is ever
sent to a penalty receiver. Removed: `MAX_PENALTY_BPS`, `MIN_PENALTY_BPS`, `PENALTY_RECEIVER`,
`_calculatePenalty`, `getCurrentPenaltyPct()`, `getCurrentPenalty(address)`. Kept for compatibility,
never added to again: the storage field `totalPenalized` (same name and slot, so the live stack #6
proxy `0xB8F5…fcb9` accepts the upgrade; the upgrades validator refuses a renamed struct member) and
its view `totalPenalized()` (zero on a fresh deploy; stack #6 keeps the 0.493729166666666666 tREAL
of the 2026-11-09 rehearsal), and, always zero, `Withdrawn.penalty`, `GlobalUpdated.totalPenalized`, and
`PoolInitialized.maxPenaltyBps` / `minPenaltyBps` (emitted as 0, 0). The stack #6 pool upgrade is
one timelock operation, `WeightedStakingPoolV3.upgradeToAndCall(newImpl, 0x)`, no reinitializer.
Live on stack #6 since block 12104575 (2026-11-10 14:17 Sofia, 12:17 UTC), implementation `0x2E7b8ACaE6e746371F2822A83A052e3eA579860A`.

## 20. Glamsterdam: fixed hook stipends (found and fixed 2026-11-09)

**What happened.** The Glamsterdam fork is live on Sepolia since 2026-10-06. Its EIP-8037 reprices
state creation: writing a NEW storage slot costs about ten times more than before; reads, warm
writes and a plain 21,000 transfer are unchanged. The same timelock initcode estimates 2,228,923 gas
on mainnet and 15,332,029 on Sepolia (`eth_estimateGas`, measured 2026-11-09 ~21:00 Sofia). The vault
gave its two fail-open notifications FIXED allowances sized on pre-fork measurements: 100,000
(`BONUS_HOOK_GAS`) for the ApeBond escrow's `onUnstake`, 250,000 (`BONUS_LISTENER_GAS`) for each
of the v3 listener's `onUnstake` and `onRebalance`. On Sepolia stack #6 the rebalance of tokenId
234214 (tx `0xf8406bc0…1f6a`, block 12099214) emitted `BonusListenerFailed(234214)`: the listener's
`onRebalance` writes a new reservation row under the new tokenId, ran out of gas at 250,000
(`eth_estimateGas` from the vault on the state of block 12099213: 399,311; succeeds at 1,000,000),
and the LP reservation stayed under the burned id.

**Measured on Sepolia, read-only** (`scripts/measure-hook-gas.js`, `eth_estimateGas` sent from the
vault's address, the 21,000 intrinsic and the calldata included, so every figure overstates the
hook's own need; block 12099306, 2026-11-09 ~20:30 Sofia):

| Contract | Hook | tokenId | Estimate | Old allowance | Result at the old allowance |
|---|---|---|---|---|---|
| `BonusEscrow` | `onUnstake`, active reservation (forfeits) | 233319 | 61,186 | 100,000 | completes, 1.63x |
| `BonusEscrow` | `onUnstake`, cliff passed (returns at once) | 234119, 234120 | 23,951 | 100,000 | completes |
| `BonusEscrow` | `onRebalance`, active (new row) | 233319 | 318,754 | fail closed, all remaining gas | n/a |
| `BonusEscrow` | `onRebalance`, cliff passed | 234119, 234120 | 31,993 | fail closed | n/a |
| `V3BonusVault` | `onUnstake` (forfeits) | 234214 | 75,901 | 250,000 | completes, 3.29x |
| `V3BonusVault` | `onRebalance` (new row) | 234214 | 339,336 | 250,000 | OUT OF GAS, 0.74x |

The escrow's forfeiture measured 29,952 in Foundry before the fork (item 15) and 61,186 on Sepolia
after it; its margin fell from 3.3x to 1.6x. The escrow's `onRebalance` has no allowance (fail
closed, item 15), so it only raises the rebalance's own gas use (318,754 against 31,993 for a matured
one); it cannot fail silently.

**Consequence on mainnet.** Mainnet has no Glamsterdam date yet, but it will fork. With the old
100,000 / 250,000 the listener's `onRebalance` would run out on mainnet exactly as on Sepolia, and
the escrow's `onUnstake` would sit close to its limit: both fail OPEN, so the vault would silently
skip the LP bonus scaling and the bonus forfeiture, with only `BonusHookFailed` /
`BonusListenerFailed` to show it.

**The mitigation.** The two allowances are owner-set storage, appended in the vault namespace after
`bonusListener` (slot 8, `uint128 bonusHookGas | uint128 bonusListenerGas << 128`; layout validated
against the live stack #6 proxy):

- `setBonusHookGas(uint256 escrowGas, uint256 listenerGas)`, `onlyOwner` (the timelock), each value
  in [`MIN_BONUS_HOOK_GAS` = 100,000, `MAX_BONUS_HOOK_GAS` = 3,000,000], else
  `BonusHookGasOutOfBounds(escrowGas, listenerGas)`; event `BonusHookGasSet(escrowGas, listenerGas)`.
  The upper bound exists because each floor is a gas limit every `unstake` must carry.
- Views `bonusHookGas()`, `bonusListenerGas()` and the floors `bonusHookGasFloor()`,
  `bonusListenerGasFloor()` = `gas * 64 / 63 + 5,000`. The floor checks and the fail-open `try`
  are otherwise unchanged. The old `BONUS_HOOK_GAS_FLOOR` / `BONUS_LISTENER_GAS_FLOOR` constants are
  gone; `BONUS_HOOK_GAS` (now 400,000) and `BONUS_LISTENER_GAS` (now 1,000,000) are the DEFAULTS.
- `initialize` takes the two values (deploy scripts: `LP_BONUS_HOOK_GAS` / `LP_BONUS_LISTENER_GAS`,
  defaults 400000 / 1000000). A live vault gets them from `initializeV2()` (`reinitializer(2)`,
  `onlyOwner`, calldata `0x5cd8a76b`), which writes the default into each allowance that is still
  zero, inside `upgradeToAndCall(newImplementation, initializeV2())`: no second operation. A vault
  upgraded with `0x` still forwards the defaults (the views fall back to them while the slot is zero).
- Why 400,000 / 1,000,000: 6.5x the escrow's measured forfeiture and 2.5x the worst listener figure
  (399,311), with room for a further repricing. A larger allowance costs nothing when unused; it only
  raises the gas LIMIT an `unstake` or `rebalance` must carry (the listener's floor is 1,020,873).

**What the operator must do.** Re-measure with `scripts/measure-hook-gas.js --network mainnet` before
every mainnet operation that links, upgrades or re-sizes a hook, after every fork (Glamsterdam on
mainnet first of all), and before every escrow or listener upgrade; raise the allowance with
`setBonusHookGas` through the timelock when a row is LOW or FAIL. Foundry and the Hardhat network
price gas by the pre-Glamsterdam schedule and cannot reproduce this: the `test_HookGas_*` tests are
lower bounds only. Keep alerting on `BonusHookFailed` and `BonusListenerFailed`.

Size: `LPStakingVault` 19,932 B runtime (`forge build --sizes`), 4,644 B under EIP-170 (was 19,044 B).

Tests: `test/forge/unit/VaultBonusHookGas.t.sol` (owner only, bounds inclusive and refused on each
side, event, floors fuzzed, `initialize` refusing an out-of-range value, `initializeV2` on a pre-fix
proxy writing the defaults and running once, an upgrade without it using the defaults, values kept
when already set, slot 8 packing, the configured allowance forwarded behind its floor), the updated
`VaultBonusHooks.t.sol` / `VaultBranches.t.sol`, the "setBonusHookGas" block of
`test/lp-staking/LPStakingVault.test.js`, `DeployImplementation.test.js` (the default
`initializeV2()` data for a pre-fix vault) and `StakingV3SepoliaFork.test.js` (the batch's upgrade
carries `initializeV2()`; 400,000 / 1,000,000 stored afterwards).

**Verified on stack #6 (2026-11-10).** The Sepolia vault proxy `0x4B2f…2eac` was upgraded through
its timelock to `0x2eBABFe60b962D229fb7d1259984cFa6703886Ba` with `upgradeToAndCall(<impl>,
0x5cd8a76b)` (executed 11:25:36 Sofia, 09:25:36 UTC, block 12103729, tx `0x52c8fb83…9379`);
`initializeV2()` stored 400,000 / 1,000,000, floors 411,349 / 1,020,873. `measure-hook-gas.js` after
it: escrow `onUnstake` 61,186 against 400,000 (6.54x), listener `onUnstake` 75,901 against 1,000,000
(13.18x), listener `onRebalance` 339,409 against 1,000,000 (2.95x; it was 0.74x and FAIL at the old
250,000), every verdict OK. A fresh LP reservation (wallet D, tokenId 234225, 211.688 tREAL) was then
rebalanced (block 12103759, tx `0x78650e89…2111`, gas used 1,247,912): `LpBonusMoved(234225, 234226,
D, 211.688, 106.028)`, no `BonusListenerFailed`, the new row active for D, the old row deleted,
`totalLpReserved` down by exactly the scaled-away 105.661 tREAL. Records: scripts/README.md, "Staking
v3 on stack #6", "Resolved (2026-11-10)".

**Follow-up of 2026-11-10: the listener's `onRebalance` fails closed.** The larger allowance fixed
the measured failure, but a fail-open `onRebalance` still let any future failure (another repricing,
a listener upgrade that costs more) complete a rebalance and leave the LP reservation under the
burned id, where `claim()` would have paid it. The vault now calls the listener's `onRebalance`
without `try` and without an allowance, like the escrow's (item 19, "Change of 2026-11-10"), and the
bonus vault pays an LP record only while the vault holds the position for its user or after a
settlement (refined the same day by item 19's "Review closure": a dead record never pays, a
missed-after record pays). `bonusListenerGas` / `bonusListenerGasFloor` now govern the listener's `onUnstake` only;
`setBonusHookGas` keeps both parameters. In `scripts/measure-hook-gas.js` the listener's
`onRebalance` row reads "fail closed (no stipend)" like the escrow's, still measured and printed.
The cost of that hook now raises the gas a rebalance uses (about 340,000 on Sepolia for an active
record), it can no longer fail silently. Sizes after it (`forge build --sizes`): `LPStakingVault`
19,717 B runtime (4,859 B under EIP-170), `V3BonusVault` 12,988 B, `StakingMigrator` 21,487 B.
