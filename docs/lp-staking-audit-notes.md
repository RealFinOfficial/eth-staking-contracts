# LP staking — audit notes

Known and deliberate properties of the V1 LP staking stack (`LPStakingVault`, `LPZapper`,
`TokenX`, `RewardsDistributor`, `libraries/TwapGuard`). Each item is something a reviewer
is expected to flag; each is recorded here with the reasoning behind the decision so the
answer does not have to be reconstructed from the diff.

Nothing here is an open bug. Items that need a decision before deployment say so.

---

## 1. `recoverExcessAsset` has no timing restriction

`RewardsDistributor.recoverExcessAsset(amount)` transfers ASSET out at any time, in any
amount up to the contract's balance, including ASSET that pre-funds vouchers users have not
claimed yet. There is no "only after the program ends" gate — unlike
`StakingPool.recoverExcessRewards()`, which requires `block.timestamp >= endEpoch`.

Deliberate. The ASSET leg is funded ad hoc by the treasury and its vouchers are cumulative
with no program end date on-chain, so there is no schedule a timing rule could key off; any
threshold would be an arbitrary number that also blocks legitimate cleanup. Two properties
bound the exposure:

- **The recipient is fixed to `owner()`.** The function takes no destination argument, so a
  compromised or mistaken owner call cannot route funds to a third party — it can only move
  them to the multisig that already controls the contract.
- **The balance held here is the damage cap for the ASSET leg**, as the contract header
  states. The TokenX leg is unaffected: it mints, and minting is bounded separately by the
  token's epoch cap.

Net effect: the ASSET leg's solvency reduces to trust in the owner multisig. Accepted, and
since the 2026-08-26 review the same sentence is in the function's own NatSpec, so a reader
of the contract meets the assumption without opening this file.

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
would be audit surface in an immutable contract, used only by a circuit breaker.

What has not changed is what the guard is for. It is a manipulation circuit breaker, not a
pricing oracle: it caps the damage of a compromised frontend feeding `amountOutMin ~ 0` on a
custodied position, and no slippage protection rests on it. The exact bounds are the
caller's own `amountOutMin`, `amount0Min` and `amount1Min`.

## 3. Ownership is one-step on the non-upgradeable contracts, and `renounceOwnership` is live there

**Changed 2026-08-26 for `RewardsDistributor`** (see item 14): that contract is now a UUPS
proxy with `Ownable2StepUpgradeable`, a separate `guardian` tier, and `renounceOwnership`
disabled. The note below therefore describes `TokenX`, `LPStakingVault` and `LPZapper`; the
distributor's row is kept for contrast and marked.

The three non-upgradeable contracts use OpenZeppelin `Ownable` (not `Ownable2Step`).
`transferOwnership` takes effect immediately with no acceptance from the new owner, and the
inherited `renounceOwnership()` is callable and sets the owner to `address(0)`. A wrong address
in either call bricks every admin path permanently. There is no recovery.

What dies with the owner, per contract:

| Contract | Lost | Survives |
|---|---|---|
| `TokenX` | `setMinter`, `setEpochCap`, `armNextEpoch`, `cancelNextEpoch` | transfers, `permit`, `burn`; `mint` keeps working until the running epoch's cap is reached, then reverts `EpochMintCapExceeded` forever — **minting dies when the cap runs out** |
| `LPStakingVault` | `setTwapParams`, `setDepositsPaused`, `setRebalancePaused`, `setZapper`, `rescuePosition` | `stake` and `unstake` — **the exit is never gated by the owner**, by design; `rebalance` too unless the owner left it paused (see item 13) |
| `LPZapper` | `setTwapParams`, `sweep`, `rescuePosition` | `zapIn` / `zapInWithPermit` |
| `RewardsDistributor` | **not applicable** — `renounceOwnership` reverts `RenounceDisabled()`, and a handover needs the new owner to call `acceptOwnership` | everything; the two tiers are independent slots, so an ownership handover leaves the guardian's pauses and signer rotation untouched, and a guardian rotation leaves the owner's tier untouched |

The staker-facing consequence is limited: no staked position can be trapped by a lost owner,
because `unstake` is permissionless and unpausable. A renounce with `rebalancePaused` left on
freezes re-ranging forever, which is why the ops runbook must read the flag before renouncing;
the exit still works, so no position is trapped. The program-facing consequence is
severe: rewards stop when the armed cap is exhausted and no new one can be armed.

**Before deployment:** confirm the multisig address by executing a no-op transaction from it
first, and treat `renounceOwnership` as forbidden in the ops runbook for the three contracts
that still allow it. `LPStakingVault` moves to the same 2-step + timelock + guardian model as
the distributor in the next commit; `TokenX` and `LPZapper` stay plain `Ownable` on purpose —
TokenX's escape hatch is minter re-pointing and the zapper is replaceable periphery.

Tests: `test/forge/unit/AccessControl.t.sol` — the matrix per contract, plus
`test_Ownership_TheDistributorProxyCannotBeRenounced`,
`test_Ownership_TheDistributorHandoverNeedsAcceptance`,
`test_Renounce_DistributorOwnerLosesTwoAdminCallsOnHandover`,
`test_Renounce_DistributorGuardianLosesThreeAdminCallsOnRotation`.

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

## 5. The epoch cap is an issuance throttle, not an emissions ledger

`TokenX.epochCap` bounds how much can be **minted** in an epoch. It does not describe what
users are **owed**. Claims are cumulative vouchers with no expiry, and
`RewardsDistributor.claimTokenX` mints the outstanding difference against whichever epoch is
effective **at claim time** — not the epoch the rewards were earned in. A user who skips
three epochs and claims in the fourth draws the whole backlog from the fourth epoch's
headroom.

Sizing rule for ops, per epoch:

```
cap  >=  expected new emissions for the epoch  +  outstanding unclaimed backlog
cap  >=  largest single outstanding payout                        (hard floor)
```

The floor matters because a claim is atomic: a payout larger than the remaining headroom does
not partially fill, it reverts with `EpochMintCapExceeded` and that user simply cannot claim
until the cap is raised.

**Backend requirement:** a cap exhaustion is not self-healing. After the owner raises the cap
or arms a new epoch, the backend must re-issue vouchers to the affected users, because the
failed claims left `claimed[user]` untouched and the users are holding vouchers that reverted.
Monitor `EpochMintCapExceeded` reverts and `mintedInEpoch(currentEpochId)` against
`epochCap(currentEpochId)`; use `effectiveEpoch()` rather than `currentEpochId` when a
scheduled rollover is armed, since the rollover is lazy and `currentEpochId` reads stale until
the next mint.

## 6. Emergency freeze must account for an armed scheduled epoch

With the lazy rollover live, `setEpochCap(id, 0)` alone is **not** a durable freeze: if a
scheduled epoch is armed, the first mint past its boundary rolls over and re-arms that
epoch's cap, silently un-freezing the token. The correct emergency-freeze sequence is
`cancelNextEpoch()` **then** `setEpochCap(id, 0)` — or `setMinter(address(0))`, which
disables minting regardless of epoch state. (Reviewer-confirmed ops consequence of the
setEpochCap-does-not-clear-pending semantics; belongs in the deploy/ops runbook.)

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

## 10. SEC-04 — replacing the distributor replays every lifetime entitlement

The claim ledger (`claimedTokenX`) lives on `RewardsDistributor`, not on `TokenX`.
`TokenX.setMinter` is the migration escape hatch, and a replacement distributor starts with an
EMPTY ledger — so after a migration every user can re-spend their entire lifetime entitlement
against the new contract. Measured: a user paid once by v1 is paid a second time, in full, by
v2. The epoch cap is the only thing that bounds the total.

The old distributor loses its mint right the moment the minter moves, so this is an addition,
never a doubling through both at once.

**Operational mitigation, required before any migration:** either seed the new distributor's
ledger with the old cumulatives, or arm a fresh epoch whose cap reflects what is genuinely
still owed. There is no on-chain guard.

Tests: `test/forge/fork/RewardVoucherFork.t.sol` —
`test_SEC04_AReplacementDistributorReplaysEveryLifetimeEntitlement`,
`test_SEC04_TheReplacedDistributorLosesItsMintRightImmediately`.

## 11. SEC-05 — `stakeFor(vault)` / `stakeFor(zapper)` strands the position permanently

`LPStakingVault.stakeFor` validates only `user != address(0)`. Crediting the vault itself, or
the zapper, produces a position that:

* `unstake` will not release — the recorded staker is a contract, and neither contract exposes
  any call path that reaches `vault.unstake`; and
* `rescuePosition` will not release either — it refuses any tokenId whose staker record is
  non-zero, which is exactly what `stakeFor` just wrote.

Nothing on-chain can move that NFT again. Only the whitelisted zapper can call `stakeFor`, so
the trigger is a bug in the zapper (or its successor), not an outside attack — but the zapper
is explicitly described as replaceable periphery, which is where the risk sits.

A fix would be one line in `stakeFor`: `if (user == address(this) || user == zapper_) revert`.

Tests: `test/forge/fork/TickSpacing.t.sol` —
`test_SEC05_StakeForTheVaultItselfStrandsThePositionForever`,
`test_SEC05_StakeForTheZapperStrandsThePositionForever`.

## 12. Smaller behaviours now pinned by tests

Not findings, but each surprised somebody during this work and each is now asserted by a named
test rather than left to be rediscovered.

* **EIP-4494 does not work for code-bearing owners.** Uniswap's `ERC721Permit` branches on
  `Address.isContract(owner)` and routes a code-bearing owner to ERC-1271. That covers contract
  wallets AND ordinary EOAs carrying an **EIP-7702 delegation** — at the pinned Sepolia block
  several plainly-derived addresses already do. `stakeWithPermit` is unusable from such an
  account and the revert carries no message; approve-then-`stake` still works.
  (`test/forge/fork/PermitDomains.t.sol:test_NftPermit_ACodeBearingOwnerCannotUseTheEip4494Path`)
* **`LPZapper.sweep` is the one external function with no `nonReentrant`.** A hostile owner
  sweeping a hook-bearing token really can reenter it and sweep again in the same transaction.
  It is `onlyOwner` and moves tokens the owner may already move freely, so it is a documented
  asymmetry rather than a vulnerability.
  (`test/forge/unit/Reentrancy.t.sol:test_Reentrancy_ZapperSweepIsUnguardedAndReallyDoesReenter`)
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
  this unreachable on a correct deployment; it is recorded because `sweep` /
  `recoverExcessAsset` touch arbitrary tokens.
* **A fee-on-transfer ASSET would short every claimer permanently.** `claimAsset` books
  `cumulativeAmount` into `claimedAsset` BEFORE the transfer, so the fee the token withholds can
  never be re-claimed — the ledger already says it was paid. This is a **deployment constraint
  on the ASSET token**, not a contract bug.
  (`test/lp-staking/RewardsDistributor.test.js`: "books the amount sent, so a fee-on-transfer
  ASSET shorts the claimer for good")
* **An ASSET whose `transfer` returns false instead of reverting is rejected, and books
  nothing.** `SafeERC20` turns the false into a revert, the whole claim reverts, and
  `claimedAsset` is left where it was — so the user can retry once the token is fixed.
  (`test/lp-staking/RewardsDistributor.test.js`: "rejects an ASSET whose transfer returns false
  instead of reverting, and books nothing")

## 13. Rebalance pause (review F6, 2026-08-26)

`rebalance` used to be unpausable, alongside `unstake`. The 2026-08-26 spec review (F6) called
that out: the exit invariant only requires `unstake` to be unstoppable, and `rebalance` is the
most complex function in an immutable contract (burn -> collect -> swap -> mint), so a bug
found after deploy had no mitigation at all.

`LPStakingVault` now carries a second switch:

| Switch | Gates | Never gates |
|---|---|---|
| `setDepositsPaused(bool)` | `stake`, `stakeWithPermit`, `stakeFor` — and therefore the whole `LPZapper.zapIn` flow, which ends in `stakeFor` | `unstake`, `rebalance` |
| `setRebalancePaused(bool)` | `rebalance`, with or without a swap leg | `unstake`, deposits |

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

## 14. Upgradeability (spec revision 2026-08-26) — `RewardsDistributor`

Management requirement, recorded in `docs/specs/00-architecture-overview.md` decision 5 and
`docs/specs/01-contracts.md` §1/§2.4: `RewardsDistributor` and `LPStakingVault` become UUPS
(ERC-1967) proxies owned by a `TimelockController`. **This item covers the distributor only;
the vault follows in the next commit.**

### Why the distributor, specifically

Item 10 (SEC-04) is the whole argument. `claimedTokenX[user]` and `claimedAsset[user]` are the
only record of what has already been paid, and the vouchers state a LIFETIME figure. Fixing a
bug by deploying a replacement contract starts those ledgers at zero, and every outstanding
voucher becomes payable a second time — bounded only by the TokenX epoch cap. A proxy is what
lets the code be replaced while the ledger stays exactly where it is. SEC-04 is therefore no
longer the mitigation of last resort; it is what happens if the escape hatch is used instead of
the upgrade path, and it stays documented for that reason.

### Shape

- `contracts/lp-staking/deploy/LPProxy.sol` — OZ `ERC1967Proxy`, nothing added. It exists so the
  repo owns the artifact (the indexer only vendors artifacts whose `sourceName` starts with
  `contracts/lp-staking/`) and so one name means one proxy across script, suites and explorer.
- `contracts/lp-staking/deploy/LPTimelock.sol` — OZ `TimelockController`, nothing added, for the
  same two reasons.
- The implementation constructor takes the two immutables (`tokenX`, `asset`), keeps their zero
  checks, and ends with `_disableInitializers()`. `initialize(owner_, guardian_, signer_)` runs
  on the proxy, inside the proxy's own deployment transaction.
- Mutable state lives in ONE ERC-7201 namespace,
  `erc7201:real.lp.storage.RewardsDistributor`, at
  `0x111abb03172b09f746748b28040854f0c669e7caa9373080b8bbaa7c3af02e00`. The literal is pinned in
  the contract and re-derived by `test_Storage_LivesAtThePinnedErc7201Slot`: if that slot ever
  moved, every `claimed[user]` would read zero and every lifetime voucher would pay out again.
- The EIP-712 domain is bound to the PROXY, so `verifyingContract` is stable across upgrades and
  no voucher is invalidated by one.
- `@openzeppelin/contracts/utils/ReentrancyGuard.sol` is used rather than a
  `ReentrancyGuardUpgradeable`: OZ v5.5 moved that guard to its own ERC-7201 namespace and
  marked it `@custom:stateless`, and v5.6 removed the upgradeable variant entirely. Its
  constructor seeds `NOT_ENTERED = 1`, which a proxy never runs — harmless, because
  `_reentrancyGuardEntered()` tests for `== ENTERED (2)`, so an unwritten slot reads as
  "not entered".

### Two-tier admin

| tier | holder | functions | why |
|---|---|---|---|
| owner | `TimelockController` (48 h on mainnet, short on staging) | `_authorizeUpgrade`, `setAssetClaimsEnabled`, `setGuardian` | a code change, or switching a whole reward leg on, should be visible on-chain before it can run |
| guardian | the multisig, directly, no delay | `setSigner`, `setPaused`, `recoverExcessAsset` | a leaked signing key or a bug in the claim path has to be stoppable in minutes |

The split is enforced in both directions and measured that way: the OWNER is rejected on every
guardian function (`NotGuardian(caller, guardian)`), and the GUARDIAN is rejected on every owner
function (`OwnableUnauthorizedAccount`). `recoverExcessAsset` now sends to `guardian()`, not to
`owner()` — the owner is a timelock contract with no way to forward an ERC-20, and the guardian
is the party that funded the balance in the first place. Item 1's trust note is unchanged
otherwise.

`renounceOwnership()` reverts `RenounceDisabled()`. A renounce would leave `_authorizeUpgrade`
with no caller and freeze the implementation forever, which is the exact failure the proxy
exists to avoid.

### What is NOT guarded

`recoverExcessAsset` carries no `nonReentrant`, exactly like `LPZapper.sweep` (item 12's
neighbour in `test/forge/unit/Reentrancy.t.sol`). A hostile guardian holding a hook-bearing
ASSET really can reenter it and recover twice in one transaction — recorded as behaviour, not a
vulnerability: it is `onlyGuardian`, the destination is the guardian itself, and the balance is
treasury money the guardian supplied. Measured by
`test_Reentrancy_RecoverExcessAssetIsUnguardedAndReallyDoesReenter`. A hostile OWNER is no
longer expressible at all: under `Ownable2Step` a contract that never calls `acceptOwnership`
never becomes the owner.

### Operator notes

- The deploy script deploys implementation + `LPProxy` as two nonce-controlled transactions
  rather than `upgrades.deployProxy`, because mainnet signs through a Ledger and every
  transaction in that script carries an explicit nonce. The proxy's `initialize` runs in the
  proxy's deployment transaction — an uninitialized proxy is one `initialize` race away from
  belonging to whoever calls it first.
- `LP_GUARDIAN` (default `LP_MULTISIG`) names the fast-path guardian.
- The post-deploy checks read the ERC-1967 implementation slot off the proxy, so "the registry's
  proxy really delegates to the registry's implementation" is asserted rather than assumed.
- Until the `TimelockController` lands, `initialize` names the multisig as the owner directly.
  The 2-step handover is exercised in the suites (`ForkHarness`, the Hardhat fork suite, and the
  `under a TimelockController` block in `test/lp-staking/RewardsDistributor.test.js`), which
  schedules `acceptOwnership`, proves a premature `execute` reverts
  `TimelockUnexpectedOperationState`, and then upgrades through the same path.
