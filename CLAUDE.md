# REAL Finance — ERC20 Delegators Staking Contract

## Overview

Staking pool contract for REAL Finance. Users stake ASSET tokens on Ethereum (or EVM chain). The contract tracks each staker's time-weighted share and distributes USDC rewards proportionally. Forfeited rewards from early leavers are redistributed to remaining participants.

### Lifecycle

1. **Deploy** with `activationEpoch` and `endEpoch` — staking is possible immediately
2. **Before `activationEpoch`** — users can stake and withdraw freely (no penalty, no rewards accrue)
3. **`activationEpoch` → `endEpoch`** (active period) — weight accumulates, `withdraw()` forfeits weight + linear penalty
4. **After `endEpoch`** — `unstake()` returns staked tokens + proportional USDC rewards
5. Owner calls `addRewards(amount)` to set the reward pool size; USDC is sent to the contract via regular ERC20 transfer

### Key Functions

| Function | When | Effect |
|---|---|---|
| `stake(amount)` | Before `endEpoch` | Deposit tokens; weight starts at `max(stakeTime, activationEpoch)` |
| `withdraw(amount)` | Before `endEpoch` | Before activation: free exit. During active: forfeit weight + penalty |
| `unstake(amount)` | After `endEpoch` | Returns tokens + proportional USDC rewards |
| `addRewards(amount)` | Any time (owner) | Transfers USDC from caller and increases reward counter |

## Project Structure

```
contracts/           — Solidity source files
  StakingPool.sol        — Main staking contract
  MockERC20.sol          — Test-only ERC20 mock
test/                — Hardhat test files (Mocha + Chai)
scripts/             — Deployment scripts
```

## Commands

```bash
npx hardhat compile      # Compile contracts
npx hardhat test         # Run all tests
npx hardhat coverage     # Run tests with coverage report
```

## Tech Stack

- Solidity ^0.8.20
- Hardhat 2.x
- OpenZeppelin Contracts v5 (Ownable, IERC20, SafeERC20, ReentrancyGuard)
- Ethers.js v6 (via hardhat-toolbox)

## Key Design Decisions

- **Weight** = `amount × seconds_in_active_period` — proportional to both stake size and duration within [activationEpoch, endEpoch]
- **On-chain reward distribution** — USDC rewards are paid out during `unstake()`, calculated as `totalRewards × userWeight / totalEffectiveWeight`
- **Forfeiture mechanism** — early withdrawers lose their weight, automatically increasing remaining stakers' reward shares
- **`_effectiveTime()`** clamps to `[activationEpoch, endEpoch]` — no weight accumulation outside the active period
- **Withdrawal penalty** — linearly decays from 50% to 0% over the active period (`activationEpoch` → `endEpoch`). Penalized tokens go to `PENALTY_RECEIVER`. No penalty before activation.
- **Reward funding** — `addRewards(amount)` transfers USDC from the caller via `safeTransferFrom` and increases the reward counter
- **`recoverExcessRewards()`** — owner can recover overfunded or unclaimed USDC after pool ends
- **Two separate tokens** — `stakingToken` (ASSET) and `rewardToken` (USDC) must be different addresses
