# REAL Finance — Staking Pool Contract

Staking pool for the REAL Finance ecosystem. Users stake ERC-20 ASSET tokens and earn USDC rewards proportional to their **time-weighted share** (`amount * time`). The pool has a fixed active period defined at deployment — rewards accrue only during this window and are paid out in USDC when users unstake after it ends.

## How It Works

### Weight Calculation

Every staker accumulates weight proportional to the amount they have staked and for how long during the **active period** (`activationEpoch` to `endEpoch`):

```
weight = staked_amount * seconds_in_active_period
```

A user who stakes 1 000 tokens for 30 days earns the same weight as one who stakes 30 000 tokens for 1 day. This mechanism rewards both larger stakes and longer commitment.

Stakes made before `activationEpoch` begin accumulating weight from the moment the pool activates — not from the time of staking.

### Reward Distribution

Rewards are denominated in a separate ERC-20 token (USDC). When a user unstakes after the pool ends, they receive:

```
reward = totalRewards * userWeight / totalEffectiveWeight
```

Where `totalEffectiveWeight` is the sum of all weights minus any forfeited weight from early withdrawals. Forfeited rewards are automatically redistributed to remaining stakers — their shares grow as others leave.

### Contract Lifecycle

The pool follows a time-based lifecycle defined at deployment:

| Phase | Timeframe | What happens |
|-------|-----------|--------------|
| **Pre-activation** | Before `activationEpoch` | Users can stake and withdraw freely. No weight accrues, no penalty applies. |
| **Active period** | `activationEpoch` to `endEpoch` | Weight accumulates. Withdrawals forfeit weight and incur a linearly decaying penalty. New stakes are accepted. |
| **Post-end** | After `endEpoch` | No more staking. Users call `unstake()` to retrieve tokens + USDC rewards, or `emergencyUnstake()` to retrieve tokens only (forfeiting rewards). |

### Withdraw vs Unstake

There are three ways to exit, depending on timing:

- **`withdraw(amount)`** — available **before `endEpoch`**. Before activation: free exit, no penalty. During active period: the user receives their tokens minus a withdrawal penalty and forfeits proportional weight.

- **`unstake()`** — available **after `endEpoch`**. The user gets all their staked tokens back plus their proportional share of USDC rewards. No penalty.

- **`emergencyUnstake()`** — available **after `endEpoch`**. The user gets all their staked tokens back but **forfeits all rewards**. Intended as a safety exit when the user cannot or does not want to wait for reward token availability.

### Withdrawal Penalty

Early withdrawals via `withdraw()` during the active period incur a penalty that **linearly decays from 50% to 0%** over the pool duration:

```
penalty = amount * remaining_time / (pool_duration * 2)
```

| When | Penalty |
|------|---------|
| At `activationEpoch` | 50% |
| Midway through active period | 25% |
| At `endEpoch` | 0% |
| Before `activationEpoch` | 0% (free withdrawal) |

Penalized tokens are sent to a fixed `PENALTY_RECEIVER` address.

### Forfeiture Mechanism

When a user withdraws early (via `withdraw()` during the active period), their proportional weight is marked as forfeited:

- The departing staker loses accumulated weight proportional to the amount withdrawn.
- Remaining stakers benefit — their shares of the total effective weight increase, meaning they receive a larger portion of the reward pool.
- Partial withdrawals are supported: withdrawing 40% of a stake forfeits ~40% of that user's weight.

When a user calls `emergencyUnstake()` after the pool ends, their weight remains in the total but can never be claimed. The unclaimed rewards can be recovered by the owner via `recoverExcessRewards()` once all stakers have exited.

### Reward Funding

The owner funds the reward pool by calling `addRewards(amount)`, which transfers USDC from the caller into the contract. This can be called multiple times to incrementally increase the reward pool. All rewards should ideally be added before `endEpoch` so that stakers can see their full pending reward before deciding to unstake.

## Deployment

The constructor takes four parameters:

```solidity
constructor(
    address _stakingToken,    // ERC-20 token users stake (ASSET)
    address _rewardToken,     // ERC-20 token for rewards (USDC)
    uint256 _activationEpoch, // Unix timestamp — weight accumulation begins
    uint256 _endEpoch         // Unix timestamp — weight accumulation ends
)
```

The staking token and reward token must be different addresses.

## Functions

### User Functions

| Function | When | Description |
|----------|------|-------------|
| `stake(amount)` | Before `endEpoch` | Deposit staking tokens into the pool |
| `withdraw(amount)` | Before `endEpoch` | Exit early — free before activation, penalty + forfeit during active period |
| `unstake()` | After `endEpoch` | Exit with full stake + USDC rewards |
| `emergencyUnstake()` | After `endEpoch` | Exit with full stake, forfeit all rewards |

### Owner Functions

| Function | Description |
|----------|-------------|
| `addRewards(amount)` | Transfer USDC into the contract and increase the reward pool |
| `recoverERC20(token, amount)` | Recover accidentally sent tokens (not staking or reward token) |
| `recoverExcessRewards()` | After pool ends — recover overfunded or unclaimed USDC |

### View Functions

| Function | Returns |
|----------|---------|
| `getUserWeight(user)` | Current accumulated weight for a user |
| `getTotalEffectiveWeight()` | Total weight excluding forfeited |
| `getPendingReward(user)` | Projected USDC reward based on current weight and total rewards |
| `getCurrentPenaltyPct()` | Current penalty in basis points (0–5000) |
| `getCurrentPenalty(user)` | Current penalty in wei for user's full stake |

## Tech Stack

- **Solidity** ^0.8.20
- **Hardhat** 2.x
- **OpenZeppelin Contracts** v5 — Ownable, IERC20, SafeERC20, ReentrancyGuard
- **Ethers.js** v6

## Development

```bash
npm install               # Install dependencies
npx hardhat compile       # Compile contracts
npx hardhat test          # Run tests (83 tests)
```
