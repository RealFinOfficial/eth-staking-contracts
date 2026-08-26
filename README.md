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

Early withdrawals via `withdraw()` during the active period incur a penalty that **linearly decays from 50% to a 5% floor** over the pool duration — an early exit is never free. Both pools use the same curve:

```
penalty = amount * (4500 * remaining_time + 500 * pool_duration) / (pool_duration * 10000)
```

| When | Penalty |
|------|---------|
| Before `activationEpoch` | 0% (free withdrawal) |
| At `activationEpoch` | 50% |
| Midway through active period | 27.5% |
| Just before `endEpoch` | 5% (floor) |
| At/after `endEpoch` | `withdraw()` is closed — use `unstake()`, which is free |

The floor holds right up until `endEpoch`; it does not taper to zero. The curve constants are public — `MAX_PENALTY_BPS` (5000), `MIN_PENALTY_BPS` (500) and `BPS_DENOMINATOR` (10000) — and are also emitted in `PoolInitialized`, so an indexer can reproduce the curve from logs alone or read it back over `eth_call`.

Once ownership is renounced the penalty drops to 0 — both `_calculatePenalty` and `getCurrentPenaltyPct` honour this, so the view never disagrees with what a withdrawal actually charges.

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

Every script runs on any configured network and against either pool. No addresses
are hardcoded: the pool comes from `deployments.json` (written by the deploy
scripts, keyed by chain id) or an explicit `POOL=0x…`, and its kind is detected
on-chain. `POOL_KIND` picks between `StakingPool` and `WeightedStakingPool` when
resolving from the registry; it defaults to `WeightedStakingPool`.

| Script | Pools | Purpose |
|--------|-------|---------|
| `deploy.js` / `deploy-weighted.js` | — | Deploy a pool and record it in `deployments.json` |
| `deploy-mock-usd.js` | — | 6-decimal mock reward token; refuses to run on mainnet |
| `stake.js` | both | Approve + stake; Weighted needs a weight attestation |
| `withdraw.js` | both | Early exit with penalty; attestation optional on Weighted |
| `unstake.js` | both | Full exit with rewards after `endEpoch` |
| `emergency-unstake.js` | both | Exit forfeiting all rewards |
| `update-weight.js` | Weighted | Change the multiplier without moving tokens |
| `fund-rewards.js` | both | Owner: approve + `addRewards()` |
| `set-signer.js` | Weighted | Owner: rotate the attestation signer |
| `recover-excess.js` | both | Owner: sweep unclaimed rewards after the pool ends |
| `status.js` | both | Read-only overview; `USERS=0x…,0x…` adds per-user detail |
| `post-deploy-check.js` | both | Assert every constructor-set value after deploying |
| `token-check.js` / `ledger-check.js` | — | Pre-deploy checks for token addresses, epochs and the Ledger |

Scripts that send a transaction refuse to run on mainnet unless `CONFIRM=yes` is
set, after printing what they are about to do.

```bash
npx hardhat run scripts/status.js --network mainnet
AMOUNT=100 WEIGHT=1500 WEIGHT_SIGNER_KEY=0x… npx hardhat run scripts/stake.js --network sepolia
REWARD_AMOUNT=50000 CONFIRM=yes npx hardhat run scripts/fund-rewards.js --network mainnet
```

`scripts/README.md` documents every variable, the attestation options and the
historical Sepolia addresses. Compiled ABIs for both pools are checked in under
`abi/`.

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
| `PoolInitialized(stakingToken, rewardToken, activationEpoch, endEpoch, maxPenaltyBps, minPenaltyBps, bpsDenominator)` | constructor | Carries the penalty curve constants so an indexer can compute the penalty off-chain from logs alone |

## Tech Stack

- **Solidity** — pragma `^0.8.20`, compiled with 0.8.28 (optimizer on, 200 runs, cancun)
- **Hardhat** 2.x — unit suites, the fork suites, the 45-step scenario, the deploy scripts
- **Foundry** 1.7 — the adversarial tier: fork, unit, fuzz and invariant, plus the coverage gate
- **OpenZeppelin Contracts** v5 — Ownable, IERC20, SafeERC20, ReentrancyGuard, EIP712, ECDSA
- **Ethers.js** v6

## Development

```bash
npm install                      # Install dependencies
npx hardhat compile              # Compile contracts

npx hardhat test                 # 536 tests: unit suites + three fork suites
npm run test:integration         # Just the mainnet-pinned local-fork integration suite
npm run test:integration:sepolia # Just the profile-driven fork integration suite
npm run test:sepolia:live        # Gated live-Sepolia smoke; REAL transactions, never CI

npm run test:forge               # 352 Foundry tests: fork, unit, fuzz, invariant
npm run test:forge:ci            # Same, ci profile (fuzz 1024, invariants 512 sequences)
npm run coverage:forge:check     # forge coverage + the blocking per-file floors gate

npx hardhat coverage             # solidity-coverage over everything under test/
npm run test:coverage:unit       # solidity-coverage over the four LP unit suites only
```

### Test tiers

Nine tiers across two toolchains. Hardhat owns the 45-step scenario and the deployment
scripts; Foundry adds the adversarial and branch-coverage work, because `forge coverage`
reports real per-branch numbers and `vm.createSelectFork` reaches live Uniswap without
spawning a node.

| tier | where | run by | needs |
|---|---|---|---|
| Hardhat unit (mocks) | `test/lp-staking/*.test.js` | `npx hardhat test` | nothing |
| Hardhat in-process mainnet fork | `test/lp-staking/fork/` | `npx hardhat test` | mainnet archive RPC |
| Hardhat local-fork integration, mainnet-pinned | `test/lp-staking/integration/LPStakingLocalFork.test.js` | `npm run test:integration` | mainnet archive RPC |
| Hardhat fork integration, profile-driven | `test/lp-staking/integration/LPStakingSepoliaFork.test.js` | `npm run test:integration:sepolia` | archive RPC for the profile's chain |
| Live Sepolia smoke — gated, **never CI** | `test-live/sepolia/SepoliaLive.test.js` | `npm run test:sepolia:live` | `SEPOLIA_LIVE=1` + `PRIVATE_KEY` + endpoint |
| Foundry fork (real state) | `test/forge/fork/` | `npm run test:forge` | archive RPC for the profile's chain |
| Foundry unit (deterministic) | `test/forge/unit/` | `npm run test:forge` | nothing |
| Foundry fuzz (properties) | `test/forge/fuzz/` | `npm run test:forge` | nothing |
| Foundry invariant (campaigns) | `test/forge/invariant/` | `npm run test:forge` | nothing |

`npx hardhat test` runs the first four (`paths.tests` is `./test`). It never runs
`test-live/`, and neither does CI.

The three mainnet-pinned suites fork block 25,750,000; everything on the default profile
forks Sepolia at block 11,562,000.

- `test/lp-staking/fork/LPStakingFork.test.js` forks in-process with `hardhat_reset` and runs
  the contracts against the real Uniswap V3 pool.
- `test/lp-staking/integration/LPStakingLocalFork.test.js` starts its own `hardhat node --fork`
  on a free port, creates a fresh pool from mock tokens, deploys the stack with the repo's own
  scripts (`hardhat run --network localhost`), drives a forty-five step scenario one transaction
  per block, and asserts the resulting logs are retrievable from the chain. It writes to a
  scratch registry, never to `deployments.json`.
- `test/lp-staking/integration/LPStakingSepoliaFork.test.js` is the same scenario driven
  through the network profile — the same 45 steps against the team's real tREAL/tUSDC and the
  Uniswap Sepolia deployment.

### Test maps

- Contracts test map (every tier, new tests and audit-finding tests marked): https://claude.ai/code/artifact/d04fc2cb-8da8-42c8-b91b-86ffcec1576b
- Indexer test map (companion, evm-indexer): https://claude.ai/code/artifact/319b99b2-ccd0-48d9-93bc-fbef9c263c92
- Expansion report (what landed, verification, audit findings SEC-01..05, open decisions): https://claude.ai/code/artifact/0ac9c23a-25bd-4fb3-8152-5673f6cac322

The pages are generated from the test files at the branch head on 2026-08-25 and are private
artifacts shared by the repository owner on request.

### The network profile

One object per world the fork suites can run in: `test/lp-staking/helpers/profiles.js` for
Hardhat, `test/forge/utils/Profiles.sol` for Foundry. `LP_TEST_PROFILE` selects it, the default
is `sepolia`, and an unknown value **throws** rather than falling back. Phase 2 is
`LP_TEST_PROFILE=mainnet`, which re-runs the same test bodies against real ASSET/USDC; the
profile is wired for it, not yet proven on it.

Sepolia facts the default profile pins, verified live on 2026-08-25 and re-asserted on every
run:

| what | value |
|---|---|
| pinned block | 11562000 |
| tREAL | `0x8e65d19BE4bA1CC61005B4c70f21cd179512e33f` — 18 dec, "Test REAL", **token0** |
| tUSDC | `0x9E0F2263c0Cb67Ee08B8c8A42be8770870b05215` — 6 dec, "TestUSDC", token1 |
| funder | `0xBb7403aAF82342A0d987A8603aAf881136B5D125` — ~95% of both supplies |
| factory | `0x0227628f3F023bb0B980b67D528571c95c6DaC1c` |
| position manager | `0x1238536071E1c677A632429e3655c799b22cDA52` |
| SwapRouter02 | `0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E` |

**No tREAL/tUSDC pool exists on live Sepolia** at any fee tier, so the fork creates one with
`scripts/create-sepolia-pool.js`. **Neither token has `DOMAIN_SEPARATOR()`**, so neither can
sign an EIP-2612 permit: under this profile the permit steps prove the zapper's
`allowance >= permit.value -> skip permit` branch instead, and the true EIP-2612 branch stays
covered by the unit suites.

### Skip vs fail

Every fork-dependent suite resolves its endpoint the same way — `<NETWORK>_RPC_URL`, then
`INFURA_API_KEY`, then the first public candidate that proves it serves ARCHIVE STATE at the
pinned block (a header read is not enough; see below) — and follows the same
one-sided rule: **failing to establish the fork is the only thing any of them may skip on, and
with the profile's RPC variable or `INFURA_API_KEY` set even that fails instead.** Nothing after
the fork is up is ever a skip. Setting a CI secret therefore makes the matching suites
mandatory.

Public fallbacks are probed for STATE, not for a header, and probed three times.
`scripts/run-forge.mjs` reads an account balance, a contract's code and an `eth_call` of
`totalSupply()` AT the pinned block, as three separate requests, and requires all three.
A header read proves only that the node kept the header, and a single state read proves only
that ONE request reached a backend that has the state: `ethereum-sepolia-rpc.publicnode.com`
is a load-balanced pool whose backends disagree about Sepolia archive availability. Both
outcomes were seen the same day — run 32845136586 found it pruned, fell through to
`sepolia.gateway.tenderly.co` and went green, while run 32845141961 saw a single balance read
PASS and the fork tier then fail on its first read of a different account with
`-32000: historical state ... is not available`. So tenderly is tried FIRST and publicnode
sits behind it as a fallback, in both `scripts/run-forge.mjs` and
`test/lp-staking/helpers/profiles.js`. Each rejected candidate is logged as `host: reason` —
host only, never a key.

Spot checks, worth running whenever the rule is touched — each must FAIL, not skip:

```bash
SEPOLIA_RPC_URL=http://127.0.0.1:9 npm run test:integration:sepolia
MAINNET_RPC_URL=http://127.0.0.1:9 npm run test:integration
SEPOLIA_RPC_URL=http://127.0.0.1:9 npm run test:forge
```

### Live Sepolia smoke

The spec's Sepolia staging rehearsal. It sends REAL transactions with real SepoliaETH and, on
a first run, records the deployment in the **tracked** `deployments.json` under chain
`11155111`.

| gate | effect |
|---|---|
| `SEPOLIA_LIVE=1` + `PRIVATE_KEY` + `SEPOLIA_RPC_URL` \| `INFURA_API_KEY` | all three required; without them the suite skips and names what is missing |
| `SEPOLIA_LIVE_CREATE_POOL=1` | one-time: creates the tREAL/tUSDC pool. **Permanent** — the address is fixed forever afterwards |
| `SEPOLIA_LIVE_DEPLOY=1` | one-time: deploys the four contracts and writes them into the tracked registry. That commit is the staging record |
| `LP_SIGNER_KEY` | optional: redeems a real 1-wei TokenX voucher. Without it the suite proves a foreign voucher is refused, by static call, costing no gas |

**Known precondition, not a bug:** a freshly created Uniswap V3 pool stores one observation, so
`pool.observe([twapWindow, 0])` reverts `OLD` and every TWAP-guarded path reverts with it. The
suite detects this and asserts that `zapIn` reverts rather than pretending the zap succeeded.
Seed liquidity and trade the pool for at least `LP_TWAP_WINDOW` seconds before expecting the
zap leg to pass. This is item 7 (SEC-01) in `docs/lp-staking-audit-notes.md`.

Growing the array is a separate step from filling it, and the deploy script sizes it rather
than guessing: `LP_OBSERVATION_CARDINALITY` defaults to 150 and the run fails before spending
gas if it is below `2 × ceil(LP_TWAP_WINDOW / 12)` — one observation per 12-second block in
the worst case, doubled for margin. The guard defaults are deliberately wide: 300 s of
lookback and 1000 bps (= 953 ticks) of tolerance, so a fast move never locks a staker out of
re-ranging.

### Coverage

```bash
npm run coverage:forge:check   # the blocking gate: lcov + per-file line and branch floors
npm run test:coverage:unit     # the Hardhat unit-only signal
```

`scripts/check-coverage.mjs` recomputes totals from the raw `DA:` / `BRDA:` records rather than
trusting the optional `LF` / `BRF` summary lines, scopes to the four LP contracts plus
`libraries/TwapGuard.sol`, and pins both the floors and their denominators — a moved
measurement basis fails loudly instead of being graded against a bar that no longer describes
it. `--ir-minimum` is not optional: coverage disables the optimizer and the un-optimized build
hits "Stack too deep" in `WeightedStakingPool.sol` without it, so the npm script passes
`LP_COVERAGE_BASIS=forge-1.7-ir-minimum` and the checker refuses to grade a run without it.
`node --test scripts/check-coverage.test.mjs` tests the gate itself, with no forge and no
network.

Measured 2026-08-26. Branch coverage is 100% on all five files, so every branch floor is also
the ceiling:

| file | lines | branches |
|---|---|---|
| `LPStakingVault.sol` | 99.08% (108/109) | 100.00% (21/21) |
| `LPZapper.sol` | 98.65% (73/74) | 100.00% (15/15) |
| `RewardsDistributor.sol` | 100.00% (43/43) | 100.00% (10/10) |
| `TokenX.sol` | 97.62% (41/42) | 100.00% (7/7) |
| `libraries/TwapGuard.sol` | 100.00% (37/37) | 100.00% (7/7) |

The three uncovered lines are the call sites `_checkTwapDeviation();`
(`LPStakingVault.sol:537`, `LPZapper.sol:389`) and `_rollPendingEpoch();` (`TokenX.sol:155`).
Each callee reports 100% of its own body in the same run, so all three are demonstrably
executed — `--ir-minimum` loses the inlined call site's mapping. They are named in the checker
and in the audit notes rather than chased with contrived tests.

### Foundry beside Hardhat

Foundry runs **beside** Hardhat, not instead of it. Two settings keep them apart: forge writes
to `out/` and `cache_forge/` (both gitignored) so it never touches Hardhat's `cache/`, and
`forge fmt` is scoped to `test/forge/` only — `contracts/` stays formatted the way the Hardhat
side formats it. Mocha loads only `.js`, so the `.t.sol` files are invisible to
`npx hardhat test`.

`lib/forge-std` is a git submodule: clone with `--recurse-submodules`, or run
`git submodule update --init --recursive`. `scripts/run-forge.mjs` wraps `forge` because forge
does not read `.env` — it resolves the fork endpoint, exports it, and runs forge. Bare
`forge test` works too; the fork tier then skips with a reason.
