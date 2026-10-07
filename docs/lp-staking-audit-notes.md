# LP staking — audit notes

Known and deliberate properties of the V1 LP staking stack (`LPStakingVault`, `LPZapper`,
`TokenOverture`, `RewardsDistributor`, `LPEpochRegistry`, `libraries/TwapGuard`). Each item is
something a reviewer is expected to flag; each is recorded here with the reasoning behind the
decision so the answer does not have to be reconstructed from the diff.

Revision 2026-10-05 (Wednesday launch, tracks M / P / R / U): the pre-v1 reward token is replaced
by the Overture token (`TokenOverture`, ticker `$OVTR`), which carries no cap of any kind;
`RewardsDistributor` v1 pays any number of pre-funded reward tokens against one `RewardClaim`
voucher type; the emission schedule moved on-chain into `LPEpochRegistry`; all five LP
contracts are UUPS proxies owned by the timelock; the vault gained the bonus-escrow
notifications, OFF at launch (item 15). Items 1, 3, 5, 6, 10 and 14 were rewritten for it.

Revision 2026-10-07: the Overture token's minter is the `RewardsDistributor` PROXY, and the
operator mints through the distributor's new operator-only `mintRewardToken(token, to, amount)`
— to a user's wallet or into the distributor — outside the claim flow. `$ASSET` is refused there
by address (`AssetNotMintable`), from a new `asset` field appended to the distributor's
namespace; a live v1 proxy gets it from `initializeV2` inside the upgrade. New item 16; items 1,
3, 5, 10 and 14 were touched for it.

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
| `LPStakingVault` | the upgrade path, `setZapper`, `setBonusEscrow`, `setOperator` | everything else; the three tiers are independent slots, so the guardian's pauses and the operator's `setTwapParams` / `rescuePosition` / `setGuardian` stay. `stake` and `unstake` were never the owner's to lose |
| `RewardsDistributor` | the upgrade path, `addRewardToken`, `setRewardTokenEnabled`, `setClaimsEnabled`, `setOperator` | `claim` for every registered token whose claims are open; the guardian keeps `setPaused`, the operator keeps `setSigner`, `recoverExcess`, `mintRewardToken` and `setGuardian` |

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
  guardian pauses claims (`setPaused(true)`, one transaction, hot key). The guardian key must
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

Tests: `test/forge/fork/TwapManipulation.t.sol`, `TwapColdOracleTest` — five `test_SEC01_*`
cases including the working-paths arm (`…ColdOracleLeavesStakeUnstakeAndSwapFreeRebalanceWorking`)
and the warm-up remedy (`…GrowingAndWarmingTheOracleMakesTheGuardReadable`).

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
| `setDepositsPaused(bool)` | guardian OR operator | `stake`, `stakeWithPermit`, `stakeFor` — and therefore the whole `LPZapper.zapIn` flow, which ends in `stakeFor` | `unstake`, `rebalance` |
| `setRebalancePaused(bool)` | guardian OR operator | `rebalance`, with or without a swap leg | `unstake`, deposits |

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
- `contracts/lp-staking/deploy/LPTimelock.sol` — OZ `TimelockController`, nothing added, for the
  same two reasons. Constructed with `(LP_TIMELOCK_MIN_DELAY, [multisig], [multisig],
  address(0))`: the multisig is the only proposer, the only executor — execution is
  deliberately NOT open — and, because the OZ constructor grants it alongside `PROPOSER_ROLE`,
  the only canceller. `admin = address(0)` leaves the timelock its own `DEFAULT_ADMIN_ROLE`
  holder, so even a role change is a scheduled, publicly visible operation.
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

### Three-tier admin

The 2026-09-09 role split (change-request item R) replaced the original two tiers with three.
The owner is still the timelock. What changed is that the old guardian tier was doing two
different jobs — stopping an incident, and moving value or rotating a key — and only the first
of those needs a hot key somebody can reach at three in the morning. They are separate roles
now.

| tier | holder | delay | what it is for |
|---|---|---|---|
| **owner** | the `TimelockController` (`deploy/LPTimelock.sol`; 48 h on mainnet, 300 s on staging) | `minDelay`, and the call is public for the whole of it | changing code, and changing who holds the other two tiers |
| **guardian** | a HOT key that holds nothing else | none | stopping an incident: the pause switches, and nothing that moves value or sets a key |
| **operator** | a multisig ("multisig B"), distinct from the timelock's proposer | none | routine operations: calibration, key rotation, the recovery hatches — plus the pause switches again, as the cold fallback |

`RewardsDistributor`:

| tier | functions | why |
|---|---|---|
| owner | `_authorizeUpgrade`, `initializeV2` (once, inside the v1 -> v2 upgrade), `addRewardToken`, `setRewardTokenEnabled`, `setClaimsEnabled`, `setGuardian`, `setOperator` | a code change, a new reward token, opening or closing a token's claims, and changing who may pause or rotate the signer should all be visible on-chain before they can run |
| guardian | `setPaused` | a bug in the claim path — or a leaked signer key — has to be stoppable in minutes |
| operator | `setSigner`, `recoverExcess`, `mintRewardToken` (never `$ASSET`), **plus `setPaused` and `setGuardian`** | a leaked signing key is rotated by the multisig, not by the hot key, a token leaves the contract only towards the operator, minting is treasury work the hot key must never do, and a hot guardian key has to be revocable without a delay |

`LPStakingVault`:

| tier | functions | why |
|---|---|---|
| owner | `_authorizeUpgrade`, `setZapper`, `setBonusEscrow`, `setGuardian`, `setOperator` | code, pointing the deposit path at a new periphery contract, linking the bonus escrow every exit notifies (item 15), and the tier assignments are program decisions |
| guardian | `setDepositsPaused`, `setRebalancePaused` | the two incident switches (item 13) have to act in one transaction |
| operator | `setTwapParams`, `rescuePosition`, **plus both pause switches and `setGuardian`** | calibrating the guard is an operations decision, not an emergency one, a stranded NFT leaves the contract only towards the operator, and a hot guardian key has to be revocable without a delay |

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
  rather than `upgrades.deployProxy`, because mainnet signs through a Ledger and every
  transaction in that script carries an explicit nonce. The proxy's `initialize` runs in the
  proxy's deployment transaction — an uninitialized proxy is one `initialize` race away from
  belonging to whoever calls it first.
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
  `LP_MULTISIG` or onto the deploying key — staging deliberately collapses them, mainnet must
  not. All three addresses are printed in the config block before anything is deployed.
  `LP_TIMELOCK_MIN_DELAY` (default 172800 = 48 h) is the timelock's own delay; Sepolia staging
  runs 300 and the fork suites 60.
- The post-deploy checks read the ERC-1967 implementation slot off each proxy, so "the
  registry's proxy really delegates to the registry's implementation" is asserted rather than
  assumed, and the ERC-1967 ADMIN slot is asserted EMPTY — a value there would mean a second,
  unowned upgrade path. Each proxy needs TWO `hardhat verify` commands — implementation, then
  proxy (implementation address + the `initialize` calldata) — and the script prints both,
  plus one for the timelock's four constructor arguments.
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
```

The owner tier is exactly: `acceptOwnership`, `transferOwnership`, `upgradeToAndCall` (all five
proxies), `setZapper`, `setBonusEscrow` (vault), `setGuardian` (vault, distributor),
`setOperator` (vault, distributor, registry, zapper), `addRewardToken`,
`setRewardTokenEnabled`, `setClaimsEnabled` (distributor), `setMinter` (Overture token),
`updateDelay` (the timelock). Nothing else is routable, and nothing else needs to be. `setGuardian` stays on this list because the owner can still send it,
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
| `LPStakingVault` (implementation) | 16,516 | 8,060 |
| `LPZapper` (implementation) | 12,360 | 12,216 |
| `RewardsDistributor` (implementation) | 10,593 | 13,983 |
| `TokenOverture` (implementation) | 7,981 | 16,595 |
| `LPEpochRegistry` (implementation) | 7,766 | 16,810 |
| `LPTimelock` | 6,550 | 18,026 |
| `LPProxy` | 163 | 24,413 |

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
(lane 2: `BonusEscrow`, `ApeBondPositionAdapter`, Sepolia only for now) can be forfeited on an
exit before its cliff (P2) and scaled when a rebalance takes value out of the position (P3). The
vault knows nothing else about bonuses (decision A3 of the B.3 document).

- **Off at launch.** `bonusEscrow` is a storage field appended at the end of the vault's
  namespace, zero by default, announced at `initialize` (`BonusEscrowSet(0, 0)`), and changed
  only by the owner (the timelock) with `setBonusEscrow(address)`, which rejects a non-zero
  address without code. Mainnet deploys with zero: no notification is sent, and the only cost is
  one storage read per `unstake` / `rebalance`.
- **`unstake` fails OPEN** (A4: the exit stays unconditional). After `delete stakers[tokenId]`
  and before the NFT leaves, the vault requires `gasleft() >= BONUS_HOOK_GAS_FLOOR` (106,587) —
  else `InsufficientGasForBonusHook()` — and calls `onUnstake(tokenId)` inside `try` with
  `BONUS_HOOK_GAS` (100,000). If the escrow reverts, the exit completes and
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
