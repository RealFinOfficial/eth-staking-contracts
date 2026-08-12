# REAL Finance — Staking Pool Contracts

Staking pools for the REAL Finance ecosystem. Users stake ERC-20 ASSET tokens and earn USDC rewards proportional to their **time-weighted share**. Each pool has a fixed active period defined at deployment — rewards accrue only during this window and are paid out in USDC when users unstake after it ends.

The repository contains two pool contracts:

| Contract | Weight formula | Signature required |
|----------|----------------|--------------------|
| `StakingPool.sol` | `amount * seconds` | No |
| `WeightedStakingPool.sol` | `amount * multiplier * seconds` | Yes — EIP-712 attestation from an off-chain signer |

`WeightedStakingPool` is the current deployment target. It keeps the entire lifecycle, penalty and forfeiture model of `StakingPool` and adds a per-user weight multiplier that an off-chain backend attests to with an EIP-712 signature.

## How It Works

### Weight Calculation

Every staker accumulates weight proportional to the amount staked, their multiplier, and for how long they stay in during the **active period** (`activationEpoch` to `endEpoch`):

```
StakingPool:          weight = staked_amount * seconds_in_active_period
WeightedStakingPool:  weight = staked_amount * multiplier * seconds_in_active_period
```

A user who stakes 1 000 tokens for 30 days earns the same weight as one who stakes 30 000 tokens for 1 day. This mechanism rewards both larger stakes and longer commitment.

Stakes made before `activationEpoch` begin accumulating weight from the moment the pool activates — not from the time of staking.

### Weight Multipliers (WeightedStakingPool)

Each user has **one multiplier for their entire stake**, expressed in `BASE_WEIGHT` units:

| Constant | Value | Meaning |
|----------|-------|---------|
| `BASE_WEIGHT` | `1000` | x1.0 — the minimum, no boost |
| `MAX_WEIGHT` | `2000` | x2.0 — the maximum boost |

Any attested weight outside `[BASE_WEIGHT, MAX_WEIGHT]` is rejected with `Invalid weight`. Because weights are stored in `BASE_WEIGHT` units, all accrued weights in this contract are 1000x larger than the equivalent `StakingPool` values — this is a unit scale, not a bonus, and it cancels out in the reward ratio.

Whenever the multiplier changes, the weight accrued so far is **checkpointed at the old multiplier** before the new one takes effect. A user boosted from x1 to x2 halfway through keeps x1 accrual for the first half and gets x2 only from that point on — retroactive boosting is not possible.

`stakes[user].weight` is `0` when the user has no active stake; the next stake sets it anew from a fresh attestation.

### Off-Chain Weight Attestation (EIP-712)

The multiplier is never chosen by the user. Every weight-setting call must carry a signature from the contract's `signer` address over an EIP-712 typed payload.

**Domain**

```js
{ name: "WeightedStakingPool", version: "1", chainId, verifyingContract: poolAddress }
```

**Types** — three structs with identical fields, one per action:

```
Stake(address user,uint256 amount,uint256 weight,uint256 nonce,uint256 deadline)
Withdraw(address user,uint256 amount,uint256 weight,uint256 nonce,uint256 deadline)
UpdateWeight(address user,uint256 amount,uint256 weight,uint256 nonce,uint256 deadline)
```

| Field | Meaning |
|-------|---------|
| `user` | The address that will send the transaction — signatures are not transferable |
| `amount` | For `stake` / `withdraw`: the amount in that call. For `updateWeight`: the user's **current** staked amount |
| `weight` | The multiplier to apply, in `BASE_WEIGHT` units |
| `nonce` | The user's current `nonces(user)` value |
| `deadline` | Unix timestamp after which the signature is rejected (`Signature expired`) |

Because the struct name is part of the EIP-712 hash, a `Stake` signature cannot be replayed as a `Withdraw` or `UpdateWeight`.

**Signing example** (ethers v6, backend side):

```js
const domain = {
  name: "WeightedStakingPool",
  version: "1",
  chainId: (await provider.getNetwork()).chainId,
  verifyingContract: poolAddress,
};
const types = {
  Stake: [
    { name: "user",     type: "address" },
    { name: "amount",   type: "uint256" },
    { name: "weight",   type: "uint256" },
    { name: "nonce",    type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};
const value = {
  user: userAddress,
  amount,
  weight: 1500n,                              // x1.5
  nonce: await pool.nonces(userAddress),
  deadline: Math.floor(Date.now() / 1000) + 3600,
};
const signature = await signerWallet.signTypedData(domain, types, value);
// user then calls: pool.stake(amount, 1500n, deadline, signature)
```

**Nonces** — one counter per user, shared across all three actions. It is consumed by every successful signature verification, so signatures are strictly single-use and must be issued in order. An unsigned `withdraw` does not consume a nonce. Every consumption emits `NonceUsed(user, nonce)`, so a backend can track the next nonce from events instead of polling `eth_call`.

**Which calls need a signature**

| Call | Signature |
|------|-----------|
| `stake` | **Mandatory** — even for base weight. Empty signature reverts with `Signature required` |
| `updateWeight` | **Mandatory** — same rule |
| `withdraw` | **Optional** — see below |
| `unstake` | Not needed |
| `emergencyUnstake` | Not needed |

**Unsigned withdraw** is the deliberate exception: users must always be able to exit even if the backend is down. Passing `0x` as the signature makes the `weight` and `deadline` arguments ignored and **resets the multiplier to `BASE_WEIGHT`** — the boost was attested for the pre-withdraw stake size, so keeping it on a smaller stake requires a fresh signature. A signed withdraw applies the attested weight to the remaining stake instead. A full withdraw clears the multiplier to `0` in either case.

The `signer` is set in the constructor and can be rotated by the owner via `setSigner()`. Rotation invalidates every signature issued by the previous signer.

### Reward Distribution

Rewards are denominated in a separate ERC-20 token (USDC). When a user unstakes after the pool ends, they receive:

```
reward = totalRewards * userWeight / totalEffectiveWeight
```

Where `totalEffectiveWeight` is the sum of all weights minus any forfeited weight from early withdrawals. Forfeited rewards are automatically redistributed to remaining stakers — their shares grow as others leave.

`unstake()` reverts with `Rewards not funded` while `totalRewards` is still `0`. Until the owner funds the pool, the only way out is `emergencyUnstake()`.

### Contract Lifecycle

The pool follows a time-based lifecycle defined at deployment:

| Phase | Timeframe | What happens |
|-------|-----------|--------------|
| **Pre-activation** | Before `activationEpoch` | Users can stake and withdraw freely. No weight accrues, no penalty applies. |
| **Active period** | `activationEpoch` to `endEpoch` | Weight accumulates. Withdrawals forfeit weight and incur a linearly decaying penalty. New stakes and weight updates are accepted. |
| **Post-end** | After `endEpoch` | No more staking or weight updates. Users call `unstake()` to retrieve tokens + USDC rewards, or `emergencyUnstake()` to retrieve tokens only (forfeiting rewards). |

### Withdraw vs Unstake

There are three ways to exit, depending on timing:

- **`withdraw(amount, ...)`** — available **before `endEpoch`**. Before activation: free exit, no penalty. During active period: the user receives their tokens minus a withdrawal penalty and forfeits proportional weight.

- **`unstake()`** — available **after `endEpoch`**, once rewards are funded. The user gets all their staked tokens back plus their proportional share of USDC rewards. No penalty.

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

Penalized tokens are sent to a fixed `PENALTY_RECEIVER` address. The penalty is calculated on the token amount only — the multiplier does not affect it.

### Forfeiture Mechanism

When a user withdraws early (via `withdraw()` during the active period), their proportional weight is marked as forfeited:

- The departing staker loses accumulated weight proportional to the amount withdrawn.
- Remaining stakers benefit — their shares of the total effective weight increase, meaning they receive a larger portion of the reward pool.
- Partial withdrawals are supported: withdrawing 40% of a stake forfeits ~40% of that user's weight.

When a user calls `emergencyUnstake()` after the pool ends, their weight remains in the total but can never be claimed. The unclaimed rewards can be recovered by the owner via `recoverExcessRewards()` once all stakers have exited.

### Reward Funding

The owner funds the reward pool by calling `addRewards(amount)`, which transfers USDC from the caller into the contract. This can be called multiple times to incrementally increase the reward pool. All rewards should ideally be added before `endEpoch` so that stakers can see their full pending reward before deciding to unstake — and because `unstake()` stays blocked until the first funding lands.

## Deployment

### WeightedStakingPool

```solidity
constructor(
    address _stakingToken,    // ERC-20 token users stake (ASSET)
    address _rewardToken,     // ERC-20 token for rewards (USDC)
    uint256 _activationEpoch, // Unix timestamp — weight accumulation begins
    uint256 _endEpoch,        // Unix timestamp — weight accumulation ends
    address _signer           // Address authorized to sign weight attestations
)
```

### StakingPool

```solidity
constructor(
    address _stakingToken,
    address _rewardToken,
    uint256 _activationEpoch,
    uint256 _endEpoch
)
```

In both cases the staking token and reward token must be different, non-zero addresses, and `_endEpoch` must be after `_activationEpoch`. `_signer` must be non-zero.

### Scripts

All scripts read configuration from `.env` / environment variables:

| Script | Env vars | Purpose |
|--------|----------|---------|
| `deploy-weighted.js` | `STAKING_TOKEN`, `REWARD_TOKEN`, `ACTIVATION_EPOCH`, `END_EPOCH`, `WEIGHT_SIGNER` (optional, defaults to deployer) | Deploy `WeightedStakingPool` |
| `deploy.js` | `STAKING_TOKEN`, `REWARD_TOKEN`, `ACTIVATION_EPOCH`, `END_EPOCH` | Deploy the plain `StakingPool` |
| `deploy-mock-usd.js` | — | Deploy a 6-decimal USDC-like mock reward token for testnets |
| `fund-rewards.js` | `POOL`, `REWARD_AMOUNT`, `REWARD_DECIMALS` (optional) | Approve + `addRewards()` on any pool |
| `add-rewards.js`, `stake.js`, `withdraw.js`, `unstake.js`, `emergency-unstake.js`, `check-weights.js` | see each file | Ad-hoc interaction helpers (hardcoded pool addresses) |

```bash
npx hardhat run scripts/deploy-weighted.js --network sepolia
POOL=0x... REWARD_AMOUNT=100 npx hardhat run scripts/fund-rewards.js --network sepolia
```

Compiled ABIs for both pools are checked in under `abi/`.

## Functions

### User Functions

| Function | When | Description |
|----------|------|-------------|
| `stake(amount, weight, deadline, signature)` | Before `endEpoch` | Deposit staking tokens; the attested `weight` becomes the user's multiplier |
| `withdraw(amount, weight, deadline, signature)` | Before `endEpoch` | Exit early — free before activation, penalty + forfeit during active period. `0x` signature resets the multiplier to `BASE_WEIGHT` |
| `updateWeight(weight, deadline, signature)` | Before `endEpoch`, with an active stake | Change the multiplier without moving tokens |
| `unstake()` | After `endEpoch`, once funded | Exit with full stake + USDC rewards |
| `emergencyUnstake()` | After `endEpoch` | Exit with full stake, forfeit all rewards |

In `StakingPool` the same functions exist without the signature arguments: `stake(amount)` and `withdraw(amount)`, and there is no `updateWeight`.

### Owner Functions

| Function | Description |
|----------|-------------|
| `addRewards(amount)` | Transfer USDC into the contract and increase the reward pool |
| `setSigner(address)` | Rotate the weight attestation signer (WeightedStakingPool only) |
| `recoverERC20(token, amount)` | Recover accidentally sent tokens (not staking or reward token) |
| `recoverExcessRewards()` | After pool ends — recover overfunded or unclaimed USDC |

Renouncing ownership permanently disables new stakes (`Staking disabled`) and drops the withdrawal penalty to zero, leaving existing stakers free to exit.

### View Functions

| Function | Returns |
|----------|---------|
| `getUserWeight(user)` | Current accumulated weight for a user (includes the multiplier) |
| `getUserMultiplier(user)` | Current multiplier in `BASE_WEIGHT` units, `0` if no stake (WeightedStakingPool only) |
| `getTotalEffectiveWeight()` | Total weight excluding forfeited |
| `getPendingReward(user)` | Projected USDC reward based on current weight and total rewards |
| `getCurrentPenaltyPct()` | Current penalty in basis points (0–5000) |
| `getCurrentPenalty(user)` | Current penalty in wei for user's full stake |
| `nonces(user)` | Next EIP-712 nonce to sign with (WeightedStakingPool only) |
| `stakes(user)` | Raw stake struct: `amount`, `weight`, `accumulatedWeight`, `lastUpdateTime` |

## Events

`WeightedStakingPool` emits full state checkpoints so an off-chain indexer can rebuild pool state from logs alone, without `eth_call`:

| Event | Emitted on | Contents |
|-------|-----------|----------|
| `StakeUpdated(user, amount, weight, accumulatedWeight, timestamp)` | every state-changing user call | The user's complete post-call state; `timestamp` is clamped to `[activationEpoch, endEpoch]` |
| `GlobalUpdated(totalStaked, totalWeightedStaked, totalAccumulatedWeight, totalForfeitedWeight, totalPenalized, totalRewardsClaimed, timestamp)` | every state-changing user call | Absolute pool totals, not deltas |
| `Staked(user, amount, weight, totalStaked)` | `stake` | |
| `Withdrawn(user, amount, forfeitedWeight, penalty)` | `withdraw` | |
| `Unstaked(user, amount, reward, claimedRewards, userWeight, totalEffectiveWeight)` | `unstake` | Includes the absolute claimed total and the ratio inputs used |
| `EmergencyUnstaked(user, amount)` | `emergencyUnstake` | |
| `WeightUpdated(user, oldWeight, newWeight)` | any multiplier change | Including resets to `BASE_WEIGHT` or `0` |
| `NonceUsed(user, nonce)` | every signature verification | |
| `SignerChanged(oldSigner, newSigner)` | constructor and `setSigner` | |
| `RewardsAdded(amount, totalRewards)` | `addRewards` | |
| `PoolInitialized(stakingToken, rewardToken, activationEpoch, endEpoch)` | constructor | |

## Tech Stack

- **Solidity** — pragma `^0.8.20`, compiled with 0.8.28 (optimizer on, 200 runs, cancun)
- **Hardhat** 2.x
- **OpenZeppelin Contracts** v5 — Ownable, IERC20, SafeERC20, ReentrancyGuard, EIP712, ECDSA
- **Ethers.js** v6

## Development

```bash
npm install               # Install dependencies
npx hardhat compile       # Compile contracts
npx hardhat test          # Run tests (121: 85 StakingPool + 36 WeightedStakingPool)
npx hardhat coverage      # Coverage report
```
