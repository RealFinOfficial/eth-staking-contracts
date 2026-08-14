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
  full-state events. `unstake` and `rebalance` are never gated by the pause switch, a
  signature or backend liveness; only new deposits can be paused
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
deviates from the pool TWAP by more than `maxTwapDeviationBps`. Callers still carry their
own `amountOutMin` / `amount0Min` / `amount1Min` — the guard is a manipulation circuit
breaker, not a pricing oracle.

### Deploy order

`scripts/deploy-lp-staking.js` does all of it in one run:

1. `TokenX(name, symbol, deployer)`
2. `RewardsDistributor(tokenX, asset, signer, deployer)`
3. `LPStakingVault(positionManager, pool, token0, token1, fee, router, deployer, twapWindow, maxDeviationBps)`
4. `LPZapper(vault, positionManager, pool, token0, token1, fee, router, usdc, asset, deployer, twapWindow, maxDeviationBps)`
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
test/                — Hardhat test files (Mocha + Chai)
  StakingPool.test.js         — 88 tests
  WeightedStakingPool.test.js — 40 tests
  lp-staking/
    LPStakingVault.test.js      — 56 tests
    RewardsDistributor.test.js  — 44 tests
    LPZapper.test.js            — 31 tests
    TokenX.test.js              — 29 tests
    fork/LPStakingFork.test.js  — 16 mainnet-fork tests; skip themselves without MAINNET_RPC_URL
scripts/             — Deployment and interaction scripts (see scripts/README.md)
  lib/pools.js              — Shared: address resolution, pool-kind detection,
                              mainnet CONFIRM guard, Ledger nonce workaround
  deploy-lp-staking.js      — Deploys and wires the whole LP stack, then hands it to the multisig
  create-sepolia-pool.js    — Creates the integration ASSET-USDC pool; refuses to run on mainnet
abi/                 — Checked-in ABIs for both pools and the four LP contracts
deployments.json     — Deployed addresses keyed by chain id
.env.example         — Every variable hardhat.config.js and the scripts read
.github/workflows/ci.yml — Compile and test on push and pull request
```

Every script is network- and pool-agnostic: the address comes from
`deployments.json` or `POOL=0x…`, the kind is detected on-chain by probing
`BASE_WEIGHT()`, and token decimals are read from the token. State-changing
scripts refuse to run on chain 1 without `CONFIRM=yes`.

## Commands

```bash
npx hardhat compile      # Compile contracts
npx hardhat test         # Run all tests (288)
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
