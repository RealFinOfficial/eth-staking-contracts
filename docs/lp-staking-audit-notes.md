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

Net effect: the ASSET leg's solvency reduces to trust in the owner multisig. Accepted.

## 2. TwapGuard compares bps against ticks, and errs loose

`TwapGuard._checkTwapDeviation` compares the spot-vs-TWAP tick difference against
`maxTwapDeviationBps` taken as a tick count. One tick is a 1.0001x price step and steps
compound, so `n` ticks is always **more** price movement than `n` bps:

| Configured `maxTwapDeviationBps` | Real deviation admitted (`1.0001^n - 1`) |
|---|---|
| 500 | ~513 bps |
| 2000 (`MAX_TWAP_DEVIATION_BPS`) | ~2214 bps |

The circuit breaker is therefore up to ~11% **looser** than the number it is configured
with, never tighter. It trips later than a strict bps reading suggests. Operators must read
the parameter as a floor on what gets through, not a ceiling.

Accepted rather than corrected: an exact conversion needs a logarithm on-chain, and the
guard is a manipulation circuit breaker, not a pricing oracle. No slippage protection rests
on it — the exact bounds are the caller's own `amountOutMin`, `amount0Min` and `amount1Min`,
which cap the value that can actually be lost regardless of where the guard trips.

## 3. Ownership is one-step everywhere, and `renounceOwnership` is live

All four contracts use OpenZeppelin `Ownable` (not `Ownable2Step`). `transferOwnership` takes
effect immediately with no acceptance from the new owner, and the inherited
`renounceOwnership()` is callable and sets the owner to `address(0)`. A wrong address in
either call bricks every admin path permanently. There is no recovery.

What dies with the owner, per contract:

| Contract | Lost | Survives |
|---|---|---|
| `TokenX` | `setMinter`, `setEpochCap`, `armNextEpoch`, `cancelNextEpoch` | transfers, `permit`, `burn`; `mint` keeps working until the running epoch's cap is reached, then reverts `EpochMintCapExceeded` forever — **minting dies when the cap runs out** |
| `RewardsDistributor` | `setSigner`, `setPaused`, `setAssetClaimsEnabled`, `recoverExcessAsset` | claims against already-signed vouchers, for as long as the signer key and the TokenX cap allow |
| `LPStakingVault` | `setTwapParams`, `setDepositsPaused`, `setZapper`, `rescuePosition` | `stake`, `unstake` and `rebalance` — **user exits are never gated by the owner**, by design |
| `LPZapper` | `setTwapParams`, `sweep`, `rescuePosition` | `zapIn` / `zapInWithPermit` |

The staker-facing consequence is limited: no staked position can be trapped by a lost owner,
because `unstake` and `rebalance` are permissionless. The program-facing consequence is
severe: rewards stop when the armed cap is exhausted and no new one can be armed.

**Before deployment:** confirm the multisig address by executing a no-op transaction from it
first, and treat `renounceOwnership` as forbidden in the ops runbook. One-step `Ownable` was
kept for consistency with the existing pool contracts; moving the LP stack to `Ownable2Step`
is the alternative if the team prefers the extra handshake.

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
