# Scripts

Every script works on any configured network and against either pool. Nothing is
hardcoded: the pool address comes from `deployments.json` or the `POOL` env var,
and token decimals and symbols are read from the chain.

## Choosing the pool

| Variable | Effect |
|---|---|
| `POOL` | Explicit pool address. The kind is detected on-chain, so a wrong `POOL_KIND` is caught rather than silently mis-encoded. |
| `POOL_KIND` | `StakingPool` or `WeightedStakingPool`. Used to look the address up in `deployments.json`. Defaults to `WeightedStakingPool`. |

```bash
# current mainnet pool, from deployments.json
npx hardhat run scripts/status.js --network mainnet

# a specific pool by address
POOL=0x1234... npx hardhat run scripts/status.js --network sepolia
```

`deployments.json` is written automatically by the deploy scripts, keyed by chain id.

## Mainnet safety

Every script that sends a transaction refuses to run on chain 1 unless
`CONFIRM=yes` is set. The parameters are printed before the check, so the
intended flow is to run once without it, read the summary, then re-run with it.

Transactions supply their own nonce. `hardhat-ledger` resolves the nonce with
the `pending` block tag without retrying, and Infura returns an intermittent
`-32603` for that tag, which aborts the transaction before it reaches the
device. `lib/pools.js` resolves it with retries and a `latest` fallback.

## Running against a local fork

`networks.localhost` exists so the LP-staking scripts can be exercised against a
`hardhat node` — a real JSON-RPC endpoint with real Uniswap contracts on it, which is what
`test/lp-staking/integration/LPStakingLocalFork.test.js` does on every run.

```bash
# terminal 1 — a node forked at the block the test suites pin
npx hardhat node --fork "$MAINNET_RPC_URL" --fork-block-number 25750000 --port 8545

# terminal 2 — the scripts, pointed at it
export LOCALHOST_RPC_URL=http://127.0.0.1:8545
export LOCALHOST_GAS_PRICE=10000000000          # 10 gwei, see below
export DEPLOYMENTS_FILE=/tmp/local-fork/deployments.json

LP_ASSET=0x… LP_USDC=0x… LP_FACTORY=0x1F98431c8aD98523631AE4a59f267346ea31F984 \
LP_NPM=0xC36442b4a4522E871399CD717aBDD847Ab11FE88 LP_INITIAL_SQRT_PRICE_X96=… \
  npx hardhat run scripts/create-sepolia-pool.js --network localhost
```

| Variable | Effect |
|---|---|
| `LOCALHOST_RPC_URL` | The node's URL. Unset means `http://127.0.0.1:8545` |
| `LOCALHOST_GAS_PRICE` | Fixed gas price in wei. A forked node inherits mainnet's base fee at the pinned block, so leaving Hardhat to estimate can undershoot the next block and the transaction is rejected. These scripts do not pin fees themselves |
| `DEPLOYMENTS_FILE` | Where `recordDeployment` writes. Point it at a scratch file so a throwaway chain-31337 deploy never rewrites the tracked `deployments.json` |
| `LP_DEPLOYER_IMPERSONATE` | The ADDRESS every state-changing script should send from, played WITHOUT its private key by impersonating it on the node. **Chain 31337 only** — on any other chain id the run stops with an error instead of sending (`scripts/lib/pools.js:impersonatedSignerFromEnv`) |

A fork reports chain id **31337**, which neither LP script has Uniswap defaults for, so
`LP_FACTORY`, `LP_NPM` and `LP_ROUTER` all have to be passed explicitly — the mainnet
values, since that is what the fork carries. See `.env.example` for the addresses.

## User actions

| Script | Pools | Required env |
|---|---|---|
| `stake.js` | both | `AMOUNT`; Weighted also needs an attestation |
| `withdraw.js` | both | `AMOUNT`; attestation optional on Weighted |
| `unstake.js` | both | — |
| `emergency-unstake.js` | both | — |
| `update-weight.js` | Weighted only | `WEIGHT` + attestation |

```bash
AMOUNT=100 WEIGHT=1500 WEIGHT_SIGNER_KEY=0x… \
  npx hardhat run scripts/stake.js --network sepolia

AMOUNT=50 npx hardhat run scripts/withdraw.js --network sepolia   # unsigned exit
```

### Attestations (WeightedStakingPool)

Weight-setting calls carry an EIP-712 signature from the pool's `signer`. Supply
it one of two ways:

- `SIGNATURE` + `DEADLINE` + `WEIGHT` — an attestation already issued by the backend
- `WEIGHT_SIGNER_KEY` + `WEIGHT` — sign locally. Convenience for testnets; the
  script checks the key matches the pool's on-chain `signer` and refuses otherwise.

`withdraw.js` is the exception: with no `WEIGHT` set it sends an unsigned
withdraw, which always succeeds and resets the multiplier to `BASE_WEIGHT`. That
is the deliberate escape hatch for when the backend is down.

## Owner actions

| Script | Pools | Required env |
|---|---|---|
| `fund-rewards.js` | both | `REWARD_AMOUNT` |
| `set-signer.js` | Weighted only | `NEW_SIGNER` |
| `recover-excess.js` | both | — |

```bash
REWARD_AMOUNT=50000 CONFIRM=yes \
  npx hardhat run scripts/fund-rewards.js --network mainnet
```

`fund-rewards.js` takes `REWARD_DECIMALS` to override the token's reported
decimals — the sepolia mUSDC mock reports 18 but is used as a 6-decimal token.

## Deployment and inspection

| Script | Purpose |
|---|---|
| `deploy.js` | Deploy `StakingPool`, record it in `deployments.json` |
| `deploy-weighted.js` | Deploy `WeightedStakingPool`, record it |
| `deploy-mock-usd.js` | 6-decimal mock reward token; refuses to run on mainnet |
| `post-deploy-check.js` | Read a deployment back and assert every constructor value |
| `status.js` | Read-only pool overview; `USERS=0x…,0x…` adds per-user detail. Needs no signer |
| `token-check.js` | Confirm token addresses and epochs before deploying |
| `ledger-check.js` | Mainnet preflight: address, balance, gas estimate. `LEDGER_PING=1` also signs a throwaway message to exercise the USB channel |

```bash
npx hardhat run scripts/token-check.js --network mainnet
LEDGER_PING=1 npx hardhat run scripts/ledger-check.js --network mainnet
CONFIRM=yes npx hardhat run scripts/deploy-weighted.js --network mainnet
DEPLOY_TX=0x… npx hardhat run scripts/post-deploy-check.js --network mainnet
```

## The LP staking stack

Five UUPS proxies behind `LPProxy`, every one of them owned by the `LPTimelock` from its own
deployment transaction: `LPStakingVault`, `RewardsDistributor`, `LPEpochRegistry`,
`TokenOverture` (the Overture token, ticker `$OVTR`) and `LPZapper`. The timelock is a plain
OpenZeppelin `TimelockController`; the multisig (`LP_MULTISIG`) is its only proposer, executor
and canceller.

On Sepolia test stack #6 only (mainnet launches without it, `vault.bonusEscrow() == 0`), the
ApeBond route adds a sixth proxy, `BonusEscrow`, and one plain contract,
`ApeBondPositionAdapter` — see "The ApeBond route" below and audit notes items 16 and 17.

| Script | Purpose |
|---|---|
| `create-sepolia-pool.js` | Create the ASSET-USDC Uniswap V3 pool, or report the existing one. Refuses to run on mainnet |
| `deploy-lp-staking.js` | Deploy the whole stack: the `LPTimelock` first, then the five proxies, each born owned by that timelock with its final roles and links. Before spending any gas it asks the Uniswap V3 **factory** whether `LP_POOL` really is the canonical pool for `(token0, token1, fee)` and refuses to deploy against anything else — the pool triple check only proves the contract CLAIMS those tokens |
| `lp-fund-rewards.js` | Fund the distributor: the operator mints `$OVTR` into it (it is the Overture minter) and transfers `$ASSET` into it. `LP_FUND_OVTR_AMOUNT` / `LP_FUND_ASSET_AMOUNT` in whole tokens. Sends when the signer is the minter / holds the `$ASSET`; prints the Safe transaction otherwise |
| `lp-epoch.js` | Drive the emission schedule in `LPEpochRegistry`: `EPOCH_ACTION=show\|schedule\|set-amount\|update-bounds\|cancel`. Quantities in whole tokens per symbol (`EPOCH_AMOUNTS="OVTR=1000000,ASSET=3000"`); the grid, the 30-minute margin and the overlap rule are checked against chain time before anything is proposed. Sends when the signer is the registry operator; prints the Safe transaction otherwise |
| `add-reward-token.js` | Prepare a NEW reward token: deploy an Overture-shaped token proxy (or take `REWARD_TOKEN_ADDRESS`), record `RewardToken:<SYMBOL>` in `deployments.json`, and print the `addRewardToken(token, conditional, claimsEnabled)` timelock operation and the follow-ups. Sends nothing to the timelock |
| `lp-timelock.js` | Operate the timelock: `schedule`, `execute`, `schedule-batch`, `execute-batch`, `cancel`, `status`, `pending`. Also exports the operation and batch builders the other scripts and the suites use |
| `lp-switch-timelock.js` | Move all five proxies to a NEW timelock (planned switch): `SWITCH_ACTION=deploy\|schedule\|execute\|accept\|raise-delay\|verify`. See "Replacing the timelock" below |
| `deploy-implementation.js` | Deploy ONE new UUPS implementation for a proxy that is already live, and print the two `lp-timelock.js` command lines that activate it. `IMPL_TARGET=LPStakingVault\|RewardsDistributor\|LPEpochRegistry\|TokenOverture\|LPZapper\|BonusEscrow`, one kind per run. It sends exactly one transaction — the implementation deploy — and never calls the timelock or the proxy |
| `validate-upgrade-safety.js` | UUPS implementation safety for the six (the five and `BonusEscrow`; network-free) plus, against a committed manifest, the storage-layout check. CI runs it on every push |
| `deploy-apebond.js` | The ApeBond route on a stack that is ALREADY live. `LP_APEBOND_MODE=activate` (default): a new vault implementation when the live vault lacks the route (a lane-1 vault), the escrow and the adapter unless already recorded, the adapter's callers and campaign, then ONE timelock batch (`[upgradeToAndCall]`, `setBonusEscrow`, `setStakeOperator`, `setAdapter`) — driven end to end when the deploying key holds both timelock roles on a test chain, printed as Safe calldata otherwise — and the post-checks, of which `vault.bonusEscrow() == escrow` and `escrow.vault() == vault` are mandatory. `replace-adapter`, `upgrade-vault`, and the read-only `verify` |
| `fund-escrow.js` | Send `$ASSET` into the escrow. Reservations need no balance; claims revert `InsufficientFunds` until the escrow holds them. `LP_APEBOND_FUND_AMOUNT` sends exactly that; `LP_APEBOND_FUND_TARGET` makes `balance − totalReserved` equal it (0 = cover exactly what is owed) and sends nothing when already there |
| `apebond-rehearsal.js` | TEST STACKS ONLY (refuses chain 1): `LP_REHEARSAL_PHASE=caller\|deposit\|loop\|withdrawal\|claim\|status` — deploy a `MockSoulZapCaller`, buy through it, show the P2 loop forfeited, show the P3 two-rebalance withdrawal scaled, claim after the cliff |
| `lp-user-rehearsal.js` | TEST STACKS ONLY (refuses chain 1): the ordinary USER actions, from the configured signer. `LP_USER_PHASE=zap\|stake-nft\|claim\|status` (default `status`, read-only) — `zap`: approve tUSDC to the `LPZapper` and `zapIn` (`LP_USER_USDC`, default 500; the swap split computed like the frontend's, minimums at `LP_USER_SLIPPAGE_BPS`, default 100), staked for the signer; `stake-nft`: mint a Uniswap V3 position on the stack's pool, approve it to the vault, `stake` (`LP_USER_AMOUNT0` / `_AMOUNT1`, or `LP_USER_TOKEN_ID` to stake an NFT the signer owns); `claim`: one reward token (`LP_USER_TOKEN`, default `OVTR`) for one position (`LP_USER_TOKEN_ID`) through the backend voucher (`POST <LP_USER_API>/api/lp/claim-voucher`), checked locally before `distributor.claim`; `status`: the signer's staked and unstaked positions and `claimed(token, wallet)` per reward token. Range `LP_USER_TICKS="lower,upper"`, default the price tick ± 6000 aligned outward. Every transaction is printed and preflighted with an `eth_call` before it is sent |
| `lib/apebond.js` | The ApeBond pair's shared pieces: env and campaign parsing, escrow + adapter deploy, adapter wiring, the link batch, the link checks |
| `lib/proxies.js` | `deployContract` and `deployProxyPair` (validate, implementation, `LPProxy` with the `initialize` calldata, `forceImport`): the one code path every proxy in the stack is born through |
| `lib/uniswap.js` | The per-chain Uniswap V3 addresses — `factory`, `positionManager`, `swapRouter02` — for chain 1 and chain 11155111. Plain Node, no network. `deploy-lp-staking.js` and `create-sepolia-pool.js` both import it, so the two cannot drift apart; `LP_FACTORY` / `LP_NPM` / `LP_ROUTER` override it, and a chain the map does not list (a local fork reports 31337) must set them |

### What `deploy-lp-staking.js` deploys, in order

1. `LPTimelock(LP_TIMELOCK_MIN_DELAY, [multisig], [multisig], address(0))`.
2. `TokenOverture` proxy, `initialize(LP_OVERTURE_NAME ("Overture"), LP_OVERTURE_SYMBOL ("OVTR"), owner = timelock, minter = LP_OPERATOR)`.
3. `RewardsDistributor` proxy, `initialize(owner = timelock, guardian, operator, signer, [{ASSET, conditional, claims = LP_ASSET_CLAIMS_ENABLED (default closed)}, {OVTR, unconditional, claims open}])`.
4. `LPEpochRegistry` proxy (implementation bound to the distributor), `initialize(owner = timelock, operator)`.
5. `LPStakingVault` proxy, `initialize(owner = timelock, guardian, operator, zapper = predicted, window, ticks)`; `bonusEscrow` stays zero.
6. `LPZapper` proxy, `initialize(owner = timelock, operator, window, ticks)`.

Nothing is wired or handed over afterwards: no `setMinter`, no `transferOwnership`, no
`acceptOwnership`. The vault is born pointing at the zapper because the script predicts the
zapper PROXY's CREATE address from the deployer's nonce (vault implementation at N, vault proxy
N + 1, zapper implementation N + 2, zapper proxy N + 3), passes it in, deploys the zapper, records
it, and only then asserts it landed there. If it did not, the run throws and names the repair:
`setZapper` through the timelock. Everything else already works.

The post-deploy checks cover all five proxies: the ERC-1967 implementation slot, an EMPTY admin
slot, `owner == timelock` and `pendingOwner == 0`; the Overture token's name, symbol, minter and
zero supply; the distributor's `rewardTokens()` and each token's flags and decimals, and
`REWARD_CLAIM_TYPEHASH`; the registry's distributor, operator, `epochCount == 0`, `INTERVAL` and
`SCHEDULE_MARGIN`; `vault.bonusEscrow() == 0`; the zapper's operator. The run ends by printing
the two operator steps it does not do: funding (`lp-fund-rewards.js`) and epoch 1
(`lp-epoch.js`).

Three role variables are read and all three are printed before anything is deployed.
`LP_GUARDIAN` (the hot pause key) and `LP_OPERATOR` (multisig B — also the Overture minter and
the registry's scheduler) are both REQUIRED and have no defaults; the script THROWS when they
are equal and WARNS when either collapses onto `LP_MULTISIG` or onto the deploying key, which is
what staging deliberately does.

### The ApeBond route (`LP_APEBOND_ENABLED=1`; Sepolia test stack #6 only)

With the flag, after the zapper, `deploy-lp-staking.js` adds (B.3 decision document, overrides of
2026-10-05; there is NO purchase signer anywhere):

7. `BonusEscrow` proxy: implementation `(bonusToken = LP_APEBOND_BONUS_TOKEN (LP_ASSET), vault)`,
   `initialize(owner = timelock, adapter = 0)` — born owned by the timelock, reserve path closed.
8. `ApeBondPositionAdapter(positionManager, vault, escrow, owner = deployer, guardian =
   LP_APEBOND_GUARDIAN (LP_GUARDIAN))`; then, from the deployer, `setSoulZapCaller` for every
   `LP_APEBOND_SOULZAP_CALLERS` entry, `setCampaign` for the `LP_APEBOND_CAMPAIGN_*` campaign (its
   exact range, cliff, rate and minimum — nothing else exists), `setCampaignCaller` for each
   caller, and `transferOwnership(timelock)`.
9. The link — ONE timelock batch, PRINTED and FILED (`apebond-link-batch.json` beside the
   registry), not sent, because every proxy is born owned by the timelock:

   ```
   0. LPStakingVault.setBonusEscrow(escrow)
   1. LPStakingVault.setStakeOperator(adapter, true)
   2. BonusEscrow.setAdapter(adapter)
   ```

   Until it executes no purchase can be made (the vault refuses the adapter's `stakeFor`, the
   escrow its `reserve`); the run's post-checks pass everything but the link and say so as a WARN.
   Drive it with `deploy-apebond.js` (default mode: it finds the pair recorded, builds the same
   batch, and on a test chain where the deploying key holds both timelock roles schedules, waits
   in chain time, executes and asserts the link), or from the multisig with
   `TIMELOCK_ACTION=schedule-batch` / `execute-batch` and the filed batch.

A vault proxy that does NOT carry the route (lane 1's vault, as mainnet deploys it) is activated
in place by `deploy-apebond.js`: phase 2 deploys the current `LPStakingVault` implementation
(hardhat-upgrades validates the lane-1 → current layout: `stakeOperators` is appended after
`bonusEscrow`), and the batch starts with `upgradeToAndCall(newImplementation, 0x)` — it has to be
one operation, because `setStakeOperator` does not exist before the upgrade. Replacing the adapter
later is `LP_APEBOND_MODE=replace-adapter`: a new adapter configured and handed over, then one
batch `setStakeOperator(new, true)`, `setStakeOperator(old, false)`, `escrow.setAdapter(new)`.
`LP_APEBOND_MODE=verify` re-runs the link checks read-only at any time — a wrong link fails OPEN
(exits would keep their bonus), so run it after any owner-tier change touching the route.

### The timelock

`hardhat run` accepts no positional arguments, so `lp-timelock.js` takes its subcommand and
operands from the environment. `schedule` and `execute` take the SAME operands — the operation
id is a hash of the whole call, so an execute that names a different argument is a different
operation rather than a typo that goes through:

```bash
TIMELOCK_ACTION=schedule TIMELOCK_TARGET=RewardsDistributor TIMELOCK_FN=setClaimsEnabled \
  TIMELOCK_ARGS=0xAssetToken,true npx hardhat run scripts/lp-timelock.js --network sepolia

TIMELOCK_ACTION=execute  TIMELOCK_TARGET=RewardsDistributor TIMELOCK_FN=setClaimsEnabled \
  TIMELOCK_ARGS=0xAssetToken,true npx hardhat run scripts/lp-timelock.js --network sepolia

TIMELOCK_ACTION=pending npx hardhat run scripts/lp-timelock.js --network sepolia
```

`schedule-batch` and `execute-batch` send SEVERAL owner-tier calls as ONE operation, which the
timelock runs in order, all or nothing. The calls come from a JSON file named by
`TIMELOCK_BATCH` — an array of `{target, fn, args}`, `target` a registry kind or a raw address,
`args` in the function's own order (a tuple such as `setCampaign`'s config as a nested array or
an object; a bool component must be `true`/`false`, never left to truthiness):

```bash
TIMELOCK_ACTION=schedule-batch TIMELOCK_BATCH=./apebond-link-batch.json \
  npx hardhat run scripts/lp-timelock.js --network sepolia
TIMELOCK_ACTION=execute-batch  TIMELOCK_BATCH=./apebond-link-batch.json \
  npx hardhat run scripts/lp-timelock.js --network sepolia
```

Owner tier, and therefore routable: `acceptOwnership` and `transferOwnership` and
`upgradeToAndCall` (all five proxies), `setZapper` and `setBonusEscrow` (vault), `setGuardian`
(vault, distributor), `setOperator` (vault, distributor, registry, zapper), `addRewardToken`,
`setRewardTokenEnabled`, `setClaimsEnabled` (distributor), `setMinter` (Overture token),
`updateDelay` (the timelock itself); with the ApeBond route also `setStakeOperator` (vault),
`upgradeToAndCall` / `acceptOwnership` / `transferOwnership` / `setAdapter` / `recoverSurplus`
(escrow) and `setCampaign` / `setCampaignEnabled` / `setCampaignCaller` / `setSoulZapCaller` /
`setGuardian` / `transferOwnership` (adapter). The other two tiers are deliberately NOT here, because
routing them through a delay would defeat the reason they exist: the guardian tier is the three
pause switches (`setDepositsPaused`, `setRebalancePaused`, `setPaused`), sent directly by the hot
key; the operator tier is `setTwapParams` and `rescuePosition` (vault, zapper), `sweep` (zapper),
`setSigner` and `recoverExcess` (distributor), the registry's four epoch functions, the
Overture `mint`, plus the three pauses as the cold fallback and `setGuardian` — sent directly by
the operator multisig.

`setGuardian` is the one call that is on BOTH sides. It stayed routable here because the owner
can still send it, but since 2026-09-14 it is owner OR operator, so a revocation that cannot
wait is sent DIRECTLY by the operator multisig: `setGuardian(address(0))` removes a compromised
hot key in one transaction. `setOperator` is owner-only, so the operator cannot rotate itself.
The salt is derived from the call (`keccak256(abi.encode("real.lp.timelock.v1", target,
keccak256(calldata), tag))`), which is why the two commands above need no shared secret; an
identical call cannot be scheduled twice, so a repeat needs `TIMELOCK_SALT_TAG=<something-new>`.
A batch derives its salt the same way from all of its calls (`"real.lp.timelock.v1.batch"`).
The full runbook is in `docs/lp-staking-audit-notes.md` item 14.

### Sepolia stack #6 runbook (rehearsal of the mainnet launch)

Stack #5 (`0x6Ed8…dd56` vault, `0x1D6a…C8DA` distributor) runs the pre-v1 contracts and is
abandoned, not upgraded: the distributor v1 is a fresh storage layout. Stack #6 is a new deploy.
Nothing below is run without the owner's word.

```bash
# 1. deploy (Sepolia rehearses a 300 s delay; mainnet runs 172800)
LP_TIMELOCK_MIN_DELAY=300 npx hardhat run scripts/deploy-lp-staking.js --network sepolia
# 2. fund the distributor (amounts in whole tokens)
LP_FUND_OVTR_AMOUNT=… LP_FUND_ASSET_AMOUNT=… npx hardhat run scripts/lp-fund-rewards.js --network sepolia
# 3. schedule epoch 1, at least 30 minutes ahead, on the 15-minute grid
EPOCH_ACTION=schedule EPOCH_STARTS_AT=2026-10-06T12:00:00Z EPOCH_DURATION=604800 \
  EPOCH_AMOUNTS="OVTR=…,ASSET=…" npx hardhat run scripts/lp-epoch.js --network sepolia
EPOCH_ACTION=show npx hardhat run scripts/lp-epoch.js --network sepolia
# 4. a third test token through the timelock: prepare, schedule, wait 300 s, execute, fund
REWARD_TOKEN_NAME="Test Reward" REWARD_TOKEN_SYMBOL=TRW REWARD_TOKEN_CONDITIONAL=0 \
  REWARD_TOKEN_CLAIMS_ENABLED=1 npx hardhat run scripts/add-reward-token.js --network sepolia
# …then the two lp-timelock.js commands it prints, then mint/transfer TRW into the distributor
```

Then hand the five proxy addresses, the timelock and the block numbers to the indexer module
and the backend (`deployments.json` holds them all), and check one `$OVTR` claim end to end.

Stack #6 also carries the ApeBond route (lane 2's head; mainnet does not). Steps 0 and 1 replace
step 1 above:

```bash
# 0. the SoulZap stand-in the rehearsal buys through (its address goes into step 1)
LP_REHEARSAL_PHASE=caller npx hardhat run scripts/apebond-rehearsal.js --network sepolia
# 1. the stack WITH the route: escrow + adapter + one campaign (300 s cliff, 10 %, min 1 $ASSET)
LP_TIMELOCK_MIN_DELAY=300 LP_APEBOND_ENABLED=1 LP_APEBOND_SOULZAP_CALLERS=<caller>,<Doublo router> \
  LP_APEBOND_CAMPAIGN_ID=apebond-sepolia-1 LP_APEBOND_HALF_WIDTH_TICKS=1200 \
  LP_APEBOND_CLIFF_SECONDS=300 LP_APEBOND_BONUS_BPS=1000 LP_APEBOND_MIN_BONUS=1 \
  npx hardhat run scripts/deploy-lp-staking.js --network sepolia
# 5. the link batch (printed by step 1): schedule, wait 300 s, execute, assert the link
npx hardhat run scripts/deploy-apebond.js --network sepolia
LP_APEBOND_MODE=verify npx hardhat run scripts/deploy-apebond.js --network sepolia
# 6. the rehearsal: a purchase, the loop (forfeited), the two-rebalance withdrawal (scaled)
LP_REHEARSAL_PHASE=deposit    npx hardhat run scripts/apebond-rehearsal.js --network sepolia
LP_REHEARSAL_PHASE=loop       npx hardhat run scripts/apebond-rehearsal.js --network sepolia
LP_REHEARSAL_PHASE=withdrawal npx hardhat run scripts/apebond-rehearsal.js --network sepolia
# 7. after the cliff: claim (reverts InsufficientFunds while the escrow is short), fund, claim
LP_REHEARSAL_PHASE=claim npx hardhat run scripts/apebond-rehearsal.js --network sepolia
LP_APEBOND_FUND_TARGET=0 npx hardhat run scripts/fund-escrow.js --network sepolia
LP_REHEARSAL_PHASE=claim npx hardhat run scripts/apebond-rehearsal.js --network sepolia
```

Step 5 needs the deploying key to hold the timelock's proposer and executor roles (it does when
`LP_MULTISIG` is that key, the test-stack arrangement). Otherwise the multisig sends the filed
batch with `lp-timelock.js schedule-batch` / `execute-batch`, and `verify` asserts the link after.

### Replacing the timelock

**Case 1 — the timelock works, the switch is planned.** No contract stores the timelock address
immutably; each proxy's owner is Ownable2Step storage. `lp-switch-timelock.js` performs the
switch in six runs:

```bash
SWITCH_ACTION=deploy      npx hardhat run scripts/lp-switch-timelock.js --network <net>  # new LPTimelock, delay 0
SWITCH_ACTION=schedule    npx hardhat run scripts/lp-switch-timelock.js --network <net>  # OLD timelock: one batch, transferOwnership(new) x5
#   … wait the OLD timelock's minDelay (48 h on mainnet) …
SWITCH_ACTION=execute     npx hardhat run scripts/lp-switch-timelock.js --network <net>  # pendingOwner = new on all five
SWITCH_ACTION=accept      npx hardhat run scripts/lp-switch-timelock.js --network <net>  # NEW timelock: acceptOwnership x5
SWITCH_ACTION=raise-delay npx hardhat run scripts/lp-switch-timelock.js --network <net>  # NEW timelock: updateDelay(48 h) on itself
SWITCH_ACTION=verify      npx hardhat run scripts/lp-switch-timelock.js --network <net>  # owner() x5, minDelay; updates deployments.json
```

The new timelock is deployed with delay 0 so the acceptances and the delay increase run at once,
and `raise-delay` restores 48 h before `verify` passes. When the signer does not hold the
timelock role a step needs (the mainnet Safe), the script prints the Safe transaction instead of
sending. Mainnet needs `CONFIRM=1`. Rehearsed end to end on a mainnet fork; to be rehearsed on
Sepolia #6.

**Case 2 — the timelock is dead or compromised.** There is no on-chain way out, by design: the
owner tier is frozen (no upgrade, no `addRewardToken`, no `setClaimsEnabled`, no `setOperator`).
Users keep stake, unstake, rebalance and claim; the operator tier keeps working. The way out is a
new deployment and a migration (new proxies; the backend signs vouchers net of the old
distributor's claimed ledger; users unstake from the old vault and stake into the new; the
registry restarts; the operator funds the new distributor) — days, not hours.

### Activating a new implementation (written for Sepolia test stack #5; the same steps apply to #6 and mainnet)

A contract change is not live until a NEW implementation of each changed proxy is on chain and
the timelock has pointed the proxy at it. Nothing about this is automatic: the implementation
deploy and the upgrade are separate transactions, sent by different scripts, with the
timelock's `getMinDelay()` between them. On Sepolia test stack #5 that delay is **300 seconds**
(mainnet is 172,800 — 48 hours).

The stack: vault proxy `0x6Ed8b565A61807591616e42263D91eBfA67Ddd56`, distributor proxy
`0x1D6aB18aFeF3196B4E3F883C7aD36F49b003C8DA`, both owned by `LPTimelock`
`0x591c51A6EE2ef571C44dF2339A7c92b57850C082`. All three addresses are read out of
`deployments.json`, so no command below carries one.

1. **Deploy the new implementations, one kind per run.** Each run deploys one contract and
   prints the two timelock commands for it. Do both, and keep both addresses.

   ```bash
   IMPL_TARGET=LPStakingVault \
     npx hardhat run scripts/deploy-implementation.js --network sepolia
   IMPL_TARGET=RewardsDistributor \
     npx hardhat run scripts/deploy-implementation.js --network sepolia
   ```

   If a run reports that the implementation was already deployed and is the one the proxy
   already runs, that contract did not change in this build: it has nothing to activate, and
   steps 3 to 8 do not apply to it.

   Each run also strips the deploy transaction hash out of the entry the plugin writes into
   `.openzeppelin/sepolia.json`, so the committed manifest carries NO `txHash` under `impls`.
   That file is not read only by Sepolia runs: a Hardhat node forked from Sepolia opens it as
   the parent manifest for its own throwaway one, and there an entry that has a hash is
   validated with `eth_getTransactionByHash` against a chain pinned at block 11,562,000 — which
   has never seen a transaction mined at 11,703,208, so the plugin throws `InvalidDeployment`
   and the fork suite fails. An entry with no hash is only checked for code, and on a
   development network an entry that fails that check is discarded and the implementation is
   redeployed on the fork. Nothing is lost by dropping it: step 1 prints the hash, and it is
   the value `deployments.json` carries as the proxy's `implementationTx`.

2. **Run the upgrade-safety gate against the network.** Named with `--network sepolia` it adds
   the storage-layout half, which grades the new layout against the committed
   `.openzeppelin/sepolia.json`. It must pass BEFORE anything is scheduled — an incompatible
   layout that reaches `execute` has already destroyed the ledger it moved.

   ```bash
   npx hardhat run scripts/validate-upgrade-safety.js --network sepolia
   ```

3. **Schedule both upgrades.** Paste the command each run of step 1 printed, or write it out:

   ```bash
   TIMELOCK_ACTION=schedule TIMELOCK_TARGET=LPStakingVault TIMELOCK_FN=upgradeToAndCall \
     TIMELOCK_ARGS=<newVaultImplementation>,0x \
     npx hardhat run scripts/lp-timelock.js --network sepolia

   TIMELOCK_ACTION=schedule TIMELOCK_TARGET=RewardsDistributor TIMELOCK_FN=upgradeToAndCall \
     TIMELOCK_ARGS=<newDistributorImplementation>,0x \
     npx hardhat run scripts/lp-timelock.js --network sepolia
   ```

   `0x` is the `data` argument and means "no reinitializer call". Each command prints its
   operation id; keep them, `TIMELOCK_ACTION=status TIMELOCK_ID=<id>` reads one back.

4. **Wait out `getMinDelay()`** — 300 s on this stack. `TIMELOCK_ACTION=pending` lists every
   scheduled operation with its state and its ready-at timestamp, measured against the chain's
   own latest block, not the local clock.

5. **Execute both.** Same operands as the schedule, `TIMELOCK_ACTION=execute`. The operation id
   is a hash of the whole call, so an execute that names a different implementation address is
   not a typo that goes through — it is a different operation that was never scheduled and the
   timelock rejects it.

6. **Post checks.** All three must hold, on each proxy:

   - the ERC-1967 implementation slot equals the new implementation. Re-running step 1 for
     that kind reads it out and labels it `Current impl`, and then reports that the
     implementation it would deploy is the one the proxy already runs — that pair of lines IS
     the check, and the re-run sends nothing, because an unchanged contract with unchanged
     constructor arguments resolves to the implementation already on chain;
   - `owner()` is still the timelock, and `guardian()` and `operator()` are unchanged — an
     upgrade replaces code, never the admin tiers, and a change in any of them means the wrong
     implementation landed;
   - `npx hardhat run scripts/validate-upgrade-safety.js --network sepolia` still passes.

7. **Record the new implementations in `deployments.json` and commit.** `RECORD=1` on step 1
   writes the address under the proxy's entry as `pendingImplementation` (plus
   `pendingImplementationBlock`) and touches nothing else in the file. Moving it into
   `implementation` after the execute is a manual edit: the only writer of that field is
   `deploy-lp-staking.js`, which writes it as one part of a full stack bootstrap and would
   create seven new entries if it were run for this.

8. **Hand both addresses to the backend owner (krumbgf).** The backend pins the implementation
   it expects to see behind each proxy, in two environment keys:

   | Key | Value |
   |---|---|
   | `LP_EXPECTED_IMPLEMENTATION_VAULT` | the new `LPStakingVault` implementation |
   | `LP_EXPECTED_IMPLEMENTATION_DISTRIBUTOR` | the new `RewardsDistributor` implementation |

   Both must be updated and the api and worker containers RECREATED (a restart does not reread
   the environment). Until that happens the backend raises
   `lp.upgrade.unexpected_implementation`, because what it reads from the ERC-1967 slot no
   longer matches what it was told to expect. The indexer needs nothing: it already handles the
   `Upgraded` event, and the proxy addresses it indexes do not change.

## Test tooling (plain Node, not `hardhat run`)

Two scripts here are not deployment scripts at all. They take no network and no signer; run
them with `node`, or through the npm scripts that already pass their arguments.

| Script | Purpose |
|---|---|
| `run-forge.mjs` | Wraps `forge`. Forge does not read `.env`, so this loads it, resolves the fork endpoint and hands the rest of the argv straight through |
| `check-coverage.mjs` | The blocking coverage gate: per-file line and branch floors for the five LP contracts and `libraries/TwapGuard.sol` |
| `check-coverage.test.mjs` | Tests the gate itself, by running it as a subprocess against synthetic lcov. Node builtins only — no forge, no network |

```bash
npm run test:forge                            # node scripts/run-forge.mjs test
npm run coverage:forge:check                  # measure, then grade
node scripts/check-coverage.mjs lcov.info     # grade an lcov already on disk
node scripts/check-coverage.mjs --config-check # basis only, no lcov needed
node --test scripts/check-coverage.test.mjs   # the gate's own tests
```

`run-forge.mjs` resolves the endpoint with the same one-sided rule the Hardhat fork suites
use — `<NETWORK>_RPC_URL`, then `INFURA_API_KEY`, then the first public candidate that proves
it serves ARCHIVE STATE at the pinned block — and exports `LP_FORK_RPC_REQUIRED` so
`test/forge/utils/BaseForge.sol` can tell an environment fact (skip) from a defect (fail). An
explicitly configured endpoint is used alone and never probed: if an operator pointed the
suite at a node, a failure there is a real failure. The Infura project id is never printed;
only the endpoint host is ever logged.

The public probe makes THREE historical reads at the pinned block — `eth_getBalance` of a
known account, `eth_getCode` of the position manager, and an `eth_call` of `totalSupply()` on
a token — as three separate requests, and requires all three. A pruned node answers the header
happily and then fails the first read a forked test makes; and one state read is one sample,
which is not enough against `ethereum-sepolia-rpc.publicnode.com`, a load-balanced pool whose
backends disagree about Sepolia archive availability (run 32845141961: probe passed, first
fork read failed; run 32845136586: probe failed, tenderly used, green). Three separate requests
sample the pool three times; a batch would land on one backend. `sepolia.gateway.tenderly.co`
is tried first for the same reason. Each rejected candidate is logged as `host: short reason`,
so the next CI log says which endpoints were tried and why they were passed over.

`check-coverage.mjs` refuses to grade a run whose measurement basis it does not recognise. The
npm script passes `LP_COVERAGE_BASIS=forge-1.7-ir-minimum`; do not set it by hand. It also
pins each file's DENOMINATOR, so a changed compiler, a changed flag or an edited contract
fails the gate with "denominator moved" instead of being quietly graded against a bar that no
longer describes it. See README.md for the measured table and for the three lines
`--ir-minimum` cannot attribute.

## Historical Sepolia deployments

Not in `deployments.json` — these predate the 5% penalty floor and run the old
50% → 0% curve. Both pools have ended. Reach them with `POOL=<address>`.

| Address | Kind | Ended |
|---|---|---|
| `0xce6Fc294ed168FFa04C8eBA189dC3060562cdE63` | StakingPool | 2026-06-08 |
| `0xF65326EbF16195890730cAd411786374c4D9E314` | StakingPool | 2026-08-11 |
| `0x8e65d19BE4bA1CC61005B4c70f21cd179512e33f` | tREAL, 18 dec | — |
| `0x45e1Dca1B4b68f649c731B0f6FDf680F389d4213` | mUSDC mock, reports 18 dec | — |
