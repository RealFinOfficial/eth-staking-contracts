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

## Project Structure

```
contracts/           — Solidity source files
  StakingPool.sol           — Original time-weighted staking contract
  WeightedStakingPool.sol   — Staking with EIP-712 attested weight multipliers
  MockERC20.sol             — Test-only 18-decimal ERC20 mock
  MockERC20Decimals.sol     — Test-only ERC20 mock with configurable decimals (6-dec USDC-like)
test/                — Hardhat test files (Mocha + Chai)
  StakingPool.test.js         — 85 tests
  WeightedStakingPool.test.js — 36 tests
scripts/             — Deployment and interaction scripts
abi/                 — Checked-in ABIs for both pools
```

## Commands

```bash
npx hardhat compile      # Compile contracts
npx hardhat test         # Run all tests (121)
npx hardhat coverage     # Run tests with coverage report
```

## Tech Stack

- Solidity pragma ^0.8.20, compiled with 0.8.28 (optimizer 200 runs, cancun)
- Hardhat 2.x
- OpenZeppelin Contracts v5 (Ownable, IERC20, SafeERC20, ReentrancyGuard, EIP712, ECDSA)
- Ethers.js v6 (via hardhat-toolbox)

## Key Design Decisions

### Shared by both pools

- **Weight** = `amount × seconds_in_active_period` — proportional to both stake size and duration within [activationEpoch, endEpoch]
- **On-chain reward distribution** — USDC rewards are paid out during `unstake()`, calculated as `totalRewards × userWeight / totalEffectiveWeight`
- **Forfeiture mechanism** — early withdrawers lose their weight, automatically increasing remaining stakers' reward shares
- **`_effectiveTime()`** clamps to `[activationEpoch, endEpoch]` — no weight accumulation outside the active period
- **Withdrawal penalty** — linearly decays from 50% to 0% over the active period (`activationEpoch` → `endEpoch`). Penalized tokens go to `PENALTY_RECEIVER`. No penalty before activation
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
