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

On mainnet the deployer signs with the private key in `MAINNET_PRIVATE_KEY`
(decision of 2026-10-19). It is set on the operator's machine only and never
printed. It is a separate variable from the Sepolia `PRIVATE_KEY`, so the Sepolia
key that a repo `.env` holds can never become the mainnet deployer. The Safe needs
no signer here, the scripts print its calldata.

Transactions supply their own nonce. Hardhat's local-accounts signer resolves the
nonce with the `pending` block tag without retrying, and Infura returns an
intermittent `-32603` for that tag, which aborts the transaction before it is
signed. `lib/pools.js` resolves it with retries and a `latest` fallback.

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
| `deployer-check.js` | Preflight: deployer address, balance, gas estimate. On mainnet the address is the one `MAINNET_PRIVATE_KEY` controls, the key itself is never printed |

```bash
npx hardhat run scripts/token-check.js --network mainnet
npx hardhat run scripts/deployer-check.js --network mainnet
CONFIRM=yes npx hardhat run scripts/deploy-weighted.js --network mainnet
DEPLOY_TX=0x… npx hardhat run scripts/post-deploy-check.js --network mainnet
```

## The LP staking stack

Five UUPS proxies behind `LPProxy`, every one of them owned by the `LPTimelock` from its own
deployment transaction: `LPStakingVault`, `RewardsDistributor`, `LPEpochRegistry`,
`TokenOverture` (the Overture token, ticker `$OVTR`) and `LPZapper`. The timelock is
OpenZeppelin's `TimelockController` with one addition, a canceller role with a term. The multisig
(`LP_MULTISIG`, REAL's Safe) is its only proposer and its only executor, and a permanent canceller
with no term. The timelock is the only holder of `DEFAULT_ADMIN_ROLE`. A second canceller
(ApeBonds' Safe) is appointed only in two steps: REAL's Safe offers the role through a scheduled
call of the timelock on itself (`offer-canceller`, 48 h), and the appointee accepts it inside
seven days, naming the term (`accept-canceller`). The term is 1 to 180 days. A term canceller can
cancel only the operations scheduled before its term end, so a revocation scheduled after the term
end cannot be blocked by it. See "Appointing a canceller" below and the audit notes, item 14.

On Sepolia test stack #6, and in the mainnet launch deploy too, the ApeBond route adds a sixth
proxy, `BonusEscrow`, and one plain contract, `ApeBondPositionAdapter` — see "The ApeBond route"
below and audit notes items 17 and 18. Mainnet is path (a), the decision of 14 Oct 2026: the
launch deploy runs with `LP_APEBOND_ENABLED=1` and the production campaign —
`LP_APEBOND_CLIFF_SECONDS=7776000` (90 days), `LP_APEBOND_BONUS_BPS=1000` (10 %),
`LP_APEBOND_MIN_BONUS=1` (1 `$ASSET`), `LP_APEBOND_DOWN_PCT=50`, `LP_APEBOND_UP_PCT=100`,
`LP_APEBOND_TOLERANCE_TICKS=500` — on an adapter built with `LP_APEBOND_MIN_CLIFF_SECONDS=86400`.

| Script | Purpose |
|---|---|
| `create-sepolia-pool.js` | Create the ASSET-USDC Uniswap V3 pool, or report the existing one. Refuses to run on mainnet |
| `deploy-lp-staking.js` | Deploy the whole stack: the `LPTimelock` first, then the five proxies, each born owned by that timelock with its final roles and links. Before spending any gas it asks the Uniswap V3 **factory** whether `LP_POOL` really is the canonical pool for `(token0, token1, fee)` and refuses to deploy against anything else — the pool triple check only proves the contract CLAIMS those tokens |
| `lp-fund-rewards.js` | Fund the distributor: the operator mints `$OVTR` into it through `RewardsDistributor.mintRewardToken` (the distributor proxy is the Overture minter) and transfers `$ASSET` into it. `LP_FUND_OVTR_AMOUNT` / `LP_FUND_ASSET_AMOUNT` in whole tokens. Sends when the signer is the operator / holds the `$ASSET`; prints the Safe transaction otherwise. On a stack not yet activated (the signer is still the token's minter) it falls back to the direct `TokenOverture.mint` and prints `path: FALLBACK` |
| `lp-mint-reward.js` | Operator front end for `RewardsDistributor.mintRewardToken(token, to, amount)`: mint a mintable reward token to ONE wallet outside the claim flow — a user's wallet, or `MINT_TO=distributor` to pre-fund claims. `MINT_TOKEN` (kind, symbol or address), `MINT_TO`, `MINT_AMOUNT` in whole tokens. Simulates the call from the operator first; sends when the signer is the operator, prints the Safe transaction otherwise. See "Minting a reward token to a wallet" below |
| `lp-epoch.js` | Drive the emission schedule in `LPEpochRegistry`: `EPOCH_ACTION=show\|schedule\|set-amount\|update-bounds\|cancel`. Quantities in whole tokens per symbol (`EPOCH_AMOUNTS="OVTR=1000000,ASSET=3000"`); the grid, the 30-minute margin and the overlap rule are checked against chain time before anything is proposed, and every refusal names the contract error it would revert with, including a token listed twice (`DuplicateToken`) or registered but not enabled (`UnknownRewardToken`). A start later than the previous live epoch's end is accepted but prints a GAP warning: no rewards accrue to users in a gap, and that time can never be paid later. Sends when the signer is the registry operator; prints the Safe transaction otherwise |
| `lp-epoch-batch.js` | Arm the next epoch in ONE Safe batch of two calls, for when the `$ASSET` funding comes later: `RewardsDistributor.mintRewardToken($OVTR, distributor, the epoch's $OVTR amount)`, then `LPEpochRegistry.scheduleEpoch`. The same inputs, refusals and GAP warning as `lp-epoch.js` with `EPOCH_ACTION=schedule` (no `LP_FUND_*`: the mint amount is the epoch's `$OVTR` amount). Refuses an epoch with no `$OVTR`, a token other than `$OVTR` and `$ASSET`, and a `$OVTR` minter that is not the distributor proxy; simulates both calls from the operator. Prints a NOTE when the epoch emits `$ASSET` (the distributor must hold it before `$ASSET` claims are opened). NEVER sends: prints the calls and writes a Safe Transaction Builder file, `lp-epoch-<id>-batch.json` beside `deployments.json` (`LP_EPOCH_BATCH_FILE` overrides) |
| `lp-epoch-batch-with-asset.js` | The same batch with the `$ASSET.transfer(distributor, the epoch's $ASSET amount)` between the mint and the schedule, for when the `$ASSET` is sent the same day. Also refuses an epoch with no `$ASSET`. The transfer is not simulated: when the operator holds less `$ASSET` than the transfer, a WARNING names the balance, the amount and the shortfall (the batch is atomic, so the Safe must hold the amount before it executes). NEVER sends; the file is `lp-epoch-<id>-batch-with-asset.json` |
| `add-reward-token.js` | Prepare a NEW reward token: deploy an Overture-shaped token proxy (or take `REWARD_TOKEN_ADDRESS`), record `RewardToken:<SYMBOL>` in `deployments.json`, and print the `addRewardToken(token, conditional, claimsEnabled)` timelock operation and the follow-ups. Sends nothing to the timelock |
| `lp-timelock.js` | Operate the timelock: `schedule`, `execute`, `schedule-batch`, `execute-batch`, `cancel`, `status`, `pending`, and the canceller actions `offer-canceller`, `accept-canceller`, `withdraw-offer`, `revoke-canceller`, `cancellers`. The two schedules send when the signer holds `PROPOSER_ROLE`, the two executes when it holds `EXECUTOR_ROLE` and `cancel` when it holds `CANCELLER_ROLE`, otherwise they print the Safe transaction (`to` = the timelock, `value` 0, `data`) and send nothing. `cancel` checks `canCancel(signer, id)` first and prints the reason instead of sending a transaction that would revert. Also exports the operation and batch builders the other scripts and the suites use |
| `lp-switch-timelock.js` | Move everything the old timelock owns — the five proxies, and the escrow, the adapter and every reward token when recorded — to a NEW timelock (planned switch): `SWITCH_ACTION=deploy\|schedule\|execute\|accept\|raise-delay\|verify`. See "Replacing the timelock" below |
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

0. Before anything: the oracle check (audit L-04). The pool's CURRENT `observationCardinality` must
   be at least `ceil(w / 6) + 1` and `observe([w, 0])` must answer, where `w` is the longer of
   `LP_TWAP_WINDOW` and, with the ApeBond route, `LP_APEBOND_VALUATION_WINDOW` (1800 s: 301
   slots). Otherwise the run stops with nothing sent, because the vault's and the zapper's
   `initialize` (and the adapter's constructor) would revert. Then
   `increaseObservationCardinalityNext(LP_OBSERVATION_CARDINALITY)` when the next size is below it.
   Grow the pool first with `scripts/grow-oracle.js` (below).
1. `LPTimelock(LP_TIMELOCK_MIN_DELAY, [multisig], [multisig], address(0))`.
2. `TokenOverture` proxy, `initialize(LP_OVERTURE_NAME ("Overture"), LP_OVERTURE_SYMBOL ("OVTR"), owner = timelock, minter = the PREDICTED RewardsDistributor proxy)`.
3. `RewardsDistributor` proxy, `initialize(owner = timelock, guardian, operator, signer, asset = LP_ASSET, [{ASSET, conditional, claims = LP_ASSET_CLAIMS_ENABLED (default closed)}, {OVTR, unconditional, claims open}])`; the run stops if the proxy did not land on the predicted address.
4. `LPEpochRegistry` proxy (implementation bound to the distributor), `initialize(owner = timelock, operator)`.
5. `LPStakingVault` proxy, `initialize(owner = timelock, guardian, operator, zapper = predicted, window, ticks)`; `bonusEscrow` stays zero.
6. `LPZapper` proxy, `initialize(owner = timelock, operator, window, ticks)`.

Nothing is wired or handed over afterwards: no `setMinter`, no `transferOwnership`, no
`acceptOwnership`. Two addresses are PREDICTED from the deployer's nonce before their contracts
exist. The Overture token is born with the distributor PROXY as its minter (token implementation
at M, token proxy M + 1, distributor implementation M + 2, distributor proxy M + 3); if the
distributor lands elsewhere the run stops right after it, before the registry, and names the
repair. The vault is born pointing at the zapper PROXY (vault implementation at N, vault proxy
N + 1, zapper implementation N + 2, zapper proxy N + 3); the script deploys the zapper, records
it, and only then asserts it landed there. If it did not, the run throws and names the repair:
`setZapper` through the timelock. Everything else already works.

The post-deploy checks cover all five proxies: the ERC-1967 implementation slot, an EMPTY admin
slot, `owner == timelock` and `pendingOwner == 0`; the Overture token's name, symbol, minter
(`== the distributor proxy`) and zero supply; the distributor's `asset() == LP_ASSET`,
`rewardTokens()` and each token's flags and decimals, and `REWARD_CLAIM_TYPEHASH`; the registry's distributor, operator, `epochCount == 0`, `INTERVAL` and
`SCHEDULE_MARGIN`; `vault.bonusEscrow() == 0`; the zapper's operator. The run ends by printing
the operator steps it does not do: funding (`lp-fund-rewards.js`), epoch 1 (`lp-epoch.js`) and,
when `LP_TIMELOCK_MIN_DELAY` is not 172800, the schedule and execute commands of the timelock's
`updateDelay(172800)` (`lp-timelock.js`), which the multisig sends.

Three role variables are read and all three are printed before anything is deployed.
`LP_GUARDIAN` (the hot pause key) and `LP_OPERATOR` (a multisig that mints `$OVTR` through the
distributor's `mintRewardToken` and is the registry's scheduler) are both REQUIRED and have no
defaults. The script THROWS when they are equal and WARNS when either collapses onto
`LP_MULTISIG` or onto the deploying key, which is what staging deliberately does. On mainnet one
Safe is both `LP_MULTISIG` (the timelock's proposer and executor) and `LP_OPERATOR` (decision of
14 Oct 2026), so the deploy script's "staging arrangement" warning for the two being equal is
expected there.

### Growing the pool oracle (`scripts/grow-oracle.js`, audit L-04)

Every window setter refuses a window the pool cannot serve forever: the CURRENT
`observationCardinality` must be at least `ceil(w / 6) + 1` (300 s: 51, 1800 s: 301, 3600 s: 601)
and `observe([w, 0])` must answer. `increaseObservationCardinalityNext` only pre-pays slots; the
pool switches to the grown size when its write index wraps the current buffer, one write per block.
`grow-oracle.js` does both: it grows the next size to `LP_ORACLE_TARGET` (default 301) when needed,
then forces one observation write per block with `decreaseLiquidity` of ONE unit of liquidity on a
dust in-range position it mints once (recorded as `oracleWarmupTokenId` on the `UniswapV3Pool`
entry, reused on later runs), until `observationCardinality == LP_ORACLE_TARGET`. It prints its
progress, is idempotent (a pool at the target sends nothing; an interrupted run resumes), and
`LP_ORACLE_DRY_RUN=1` prints the plan and sends nothing. At the end it reports whether
`observe([LP_ORACLE_WINDOW (1800), 0])` answers: the size is in place, but the pool must still
hold that many seconds of history.

```bash
LP_ORACLE_DRY_RUN=1 npx hardhat run scripts/grow-oracle.js --network sepolia   # the plan only
LP_ORACLE_TARGET=301 npx hardhat run scripts/grow-oracle.js --network sepolia  # operator or deployer key
```

From 150 slots it takes up to 150 forced writes (about 30 minutes at 12 s blocks), fewer when the
pool trades meanwhile. Mainnet: grow at least a day before the deployment; `CONFIRM=yes`.

### The checks before launch (`scripts/post-launch-check.js`, krumbgf's item 12)

The mainnet timelock may be deployed with a short `LP_TIMELOCK_MIN_DELAY`, every batch run in
minutes, and `updateDelay(172800)` executed LAST. Before the frontend points to mainnet, before
the ApeBond route goes live and before any announcement, this read-only script asserts three facts
and exits non-zero when one fails:

1. **No pending timelock operation:** every `CallScheduled` id has a `CallExecuted` or a
   `Cancelled`. OpenZeppelin operations never expire and keep their short ready time after
   `updateDelay`, so a leftover one could execute later without 48 h notice. The logs are scanned
   from the timelock's recorded deployment block in chunks of at most 10,000 blocks
   (`LP_LOG_CHUNK_BLOCKS`), and each open id is printed with `isOperationPending` and its ready time.
2. **`getMinDelay() == 172800`** (`LP_EXPECTED_MIN_DELAY`). The last `MinDelayChange` event is
   printed: it is the proof for ApeBond.
3. **The deployer key holds nothing:** no timelock role (proposer, executor, canceller, admin), and
   it is not `owner`, `pendingOwner`, `guardian` or `operator` of the five proxies, the escrow, the
   adapter or any recorded reward token. `LP_DEPLOYER` names the key's address (default: the
   configured signer's). Also, **only the timelock holds `DEFAULT_ADMIN_ROLE`**: the timelock holds
   it, and no other account named in a `RoleGranted` log for that role still does.

```bash
LP_DEPLOYER=0x… npx hardhat run scripts/post-launch-check.js --network mainnet
```

### The ApeBond route (`LP_APEBOND_ENABLED=1`; Sepolia test stack #6 and the mainnet launch)

With the flag, after the zapper, `deploy-lp-staking.js` adds (B.3 decision document, overrides of
2026-10-05; there is NO purchase signer anywhere):

7. `BonusEscrow` proxy: implementation `(bonusToken = LP_APEBOND_BONUS_TOKEN (LP_ASSET), vault)`,
   `initialize(owner = timelock, adapter = 0)` — born owned by the timelock, reserve path closed.
8. `ApeBondPositionAdapter(positionManager, vault, escrow, owner = deployer, guardian =
   LP_APEBOND_GUARDIAN (LP_GUARDIAN), minCliffSeconds = LP_APEBOND_MIN_CLIFF_SECONDS (86400, at least 86400 on mainnet; a campaign cliff below it is refused), valuationWindow = LP_APEBOND_VALUATION_WINDOW (1800, 300..3600, audit L-02: the window whose mean tick values every bonus; the pool must already serve it))`; then, from the deployer, `setSoulZapCaller` for every
   `LP_APEBOND_SOULZAP_CALLERS` entry, `setCampaign` for the `LP_APEBOND_CAMPAIGN_*` campaign (its
   band, cliff, rate and minimum — nothing else exists), `setCampaignCaller` for each caller, and
   `transferOwnership(timelock)`, which only nominates the timelock (`Ownable2Step`, audit L-03):
   the link batch opens with `adapter.acceptOwnership()`.

   The campaign's band is not a fixed range (Vladimir's decision of 14 Oct 2026). At each purchase
   the adapter places it around the $ASSET price of that moment (the pool's spot tick) and accepts
   the NFT when each edge is within the tolerance of the band's edge; `campaignRange(campaignId)`
   returns the band right now. The run reads:

   | variable | meaning | default |
   |---|---|---|
   | `LP_APEBOND_DOWN_PCT` | how far below the $ASSET price the band starts, in percent (above 0, below 100); `downTicks = round(ln(1 / (1 - pct/100)) / ln(1.0001))` | 50 (6932 ticks) |
   | `LP_APEBOND_UP_PCT` | how far above it the band ends, in percent (above 0); `upTicks = round(ln(1 + pct/100) / ln(1.0001))` | 100 (6932 ticks) |
   | `LP_APEBOND_DOWN_TICKS` / `LP_APEBOND_UP_TICKS` | the offset in ticks, overriding its percentage | unset |
   | `LP_APEBOND_TOLERANCE_TICKS` | the accepted distance of each NFT edge from the band's edge, in ticks; at least the pool's tick spacing | 500 |

   The run refuses, before sending anything, what `setCampaign` would refuse: an offset at or
   below zero, a tolerance below the tick spacing, or `downTicks + upTicks` of 1,774,544 or more
   (Uniswap's whole tick range). "Down" always means a lower $ASSET price: when $ASSET is the
   pool's token1 the adapter puts it on the upper tick side. The registry records `downTicks`,
   `upTicks`, `toleranceTicks` and, for the reader, `downPct` / `upPct`.
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

A vault proxy that does NOT carry the route (lane 1's vault, deployed before the route existed) is
activated in place by `deploy-apebond.js`: phase 2 deploys the current `LPStakingVault`
implementation (hardhat-upgrades validates the lane-1 → current layout: `stakeOperators` is
appended after `bonusEscrow`), and the batch starts with `upgradeToAndCall(newImplementation, 0x)`
— it has to be one operation, because `setStakeOperator` does not exist before the upgrade.
Replacing the adapter later is `LP_APEBOND_MODE=replace-adapter`: a new adapter configured and
handed over, then one batch `setStakeOperator(new, true)`, `setStakeOperator(old, false)`,
`escrow.setAdapter(new)`. `LP_APEBOND_MODE=verify` re-runs the link checks read-only at any time —
a wrong link fails OPEN (exits would keep their bonus), so run it after any owner-tier change
touching the route.

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
`upgradeToAndCall` / `acceptOwnership` / `transferOwnership` / `setAdapter` / `recoverSurplus` /
`recoverSurplusAmount` (escrow, where the amount of `recoverSurplusAmount` is in wei, 18 decimals:
1,000 $ASSET = 1000000000000000000000) and `setCampaign` / `setCampaignEnabled` / `setCampaignCaller` / `setSoulZapCaller` /
`setGuardian` / `setValuationWindow` / `acceptOwnership` / `transferOwnership` (adapter). The other two tiers are deliberately NOT here, because
routing them through a delay would defeat the reason they exist: the guardian tier is the three
pauses (`pauseDeposits`, `pauseRebalance`, `pause`), sent directly by the hot key; the operator
tier is `setTwapParams` and `rescuePosition` (vault, zapper), `sweep` (zapper), `setSigner`,
`recoverExcess` and `mintRewardToken` (distributor), the registry's four epoch functions, plus the
three pauses as the cold fallback, the three unpauses (`unpauseDeposits`, `unpauseRebalance`,
`unpause`, the operator's alone since audit L-01) and `setGuardian` — sent directly by the
operator multisig.

`setGuardian` is the one call that is on BOTH sides. It stayed routable here because the owner
can still send it, but since 2026-09-14 it is owner OR operator, so a revocation that cannot
wait is sent DIRECTLY by the operator multisig: `setGuardian(address(0))` removes a compromised
hot key in one transaction. `setOperator` is owner-only, so the operator cannot rotate itself.
The salt is derived from the call (`keccak256(abi.encode("real.lp.timelock.v1", target,
keccak256(calldata), tag))`), which is why the two commands above need no shared secret; an
identical call cannot be scheduled twice, so a repeat needs `TIMELOCK_SALT_TAG=<something-new>`.
A batch derives its salt the same way from all of its calls (`"real.lp.timelock.v1.batch"`).
The full runbook is in `docs/lp-staking-audit-notes.md` item 14.

#### Appointing a canceller (ApeBonds' Safe)

The appointment is an offer by REAL's Safe and an acceptance by the appointee. `CANCELLER_TERM_DAYS`
is the term in whole days, 1 to 180.

```bash
# 1. The offer: a call of the timelock on itself. The first run schedules it, a run after the
#    delay (48 h on mainnet) executes it. A run in between prints the ready time and sends nothing.
TIMELOCK_ACTION=offer-canceller CANCELLER_ADDRESS=0xApeSafe CANCELLER_TERM_DAYS=180 \
  npx hardhat run scripts/lp-timelock.js --network sepolia

# 2. The acceptance, inside the 7 days after the offer executed, naming the same term. Sent when
#    the signer is the appointee. Otherwise the calldata for the appointee's Safe is printed.
TIMELOCK_ACTION=accept-canceller CANCELLER_ADDRESS=0xApeSafe CANCELLER_TERM_DAYS=180 \
  npx hardhat run scripts/lp-timelock.js --network sepolia

# 3. Check: every canceller and every offer, with term end, isCancellerActive and expiresAt.
TIMELOCK_ACTION=cancellers npx hardhat run scripts/lp-timelock.js --network sepolia
```

`withdraw-offer` (deletes an executed offer that was not accepted) and `revoke-canceller`
(`revokeRole(CANCELLER_ROLE, CANCELLER_ADDRESS)`) run the same way as the offer, through a
schedule and an execute. A revocation executes only after the appointee's term end: before it the
execute would revert `CancellerTermActive`, so the script refuses it and says until when.
`revoke-canceller` refuses the zero address, the timelock itself and a permanent canceller before
anything is scheduled, and `CONFIRM_REVOKE_PERMANENT=1` lets a deliberate revocation of a permanent
canceller through, on this action and on a hand-built `revokeRole` alike (after it no permanent
canceller can be granted again without a timelock switch). `revoke-canceller` also refuses, before
scheduling, an address that holds no canceller role ("nothing to schedule"). `withdraw-offer`
refuses an offer that has already expired, and an offer that would expire before the withdrawal
could execute ("let it lapse"). `grantRole` refuses `CANCELLER_ROLE` (only an offer and its
acceptance reach it) and `DEFAULT_ADMIN_ROLE` (the timelock must stay its only holder) before
anything is scheduled. `lp-switch-timelock.js` refuses `deploy` while a `TimelockControllerNext`
entry exists, unless `SWITCH_REPLACE_NEXT=1`. `SWITCH_ACTION=check` is report-only: it never removes
the registry entry.
A pending offer operation is stopped at once with `cancel` on its id. A renewal is a new offer and a
new acceptance, and the acceptance resets the term end to the acceptance time plus the new term.
The renewal has to start early enough that 48 h of delay, the Safe signatures on both sides and
the acceptance all fit before the term end. Before a re-appointment that follows a gap after a term
end, execute or cancel every pending operation first: operations scheduled in the gap and still
pending at the acceptance become cancellable by the appointee.

Rotating REAL's Safe and what it means for the canceller role: see `docs/lp-staking-audit-notes.md`
item 14, "Runbook — operating the timelock".

A timelock switch does not carry a canceller appointment over: see "Replacing the timelock".

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
# …then the two lp-timelock.js commands it prints, then fund TRW: a token deployed by this script
# has the distributor as its minter, so the operator mints it in with lp-mint-reward.js
MINT_TOKEN=TRW MINT_TO=distributor MINT_AMOUNT=… npx hardhat run scripts/lp-mint-reward.js --network sepolia
```

Then hand the nine targets and their block numbers to the indexer module and the backend: the
vault, distributor, registry and Overture proxies, the timelock, the pool, and when set the
position manager, the escrow and the adapter. `deployments.json` holds them, and the position
manager is the chain's Uniswap V3 `NonfungiblePositionManager`. Then check one `$OVTR` claim end
to end.

Stack #6 also carries the ApeBond route (lane 2's head), and the mainnet launch deploys it too
(path (a), decision of 14 Oct 2026). Steps 0 and 1 replace step 1 above:

```bash
# 0. the SoulZap stand-in the rehearsal buys through (its address goes into step 1)
LP_REHEARSAL_PHASE=caller npx hardhat run scripts/apebond-rehearsal.js --network sepolia
# 1. the stack WITH the route: escrow + adapter + one campaign (300 s cliff, 10 %, min 1 $ASSET)
LP_TIMELOCK_MIN_DELAY=300 LP_APEBOND_ENABLED=1 LP_APEBOND_SOULZAP_CALLERS=<caller>,<Doublo router> \
  LP_APEBOND_MIN_CLIFF_SECONDS=300 LP_APEBOND_CAMPAIGN_ID=apebond-sepolia-1 \
  LP_APEBOND_DOWN_PCT=50 LP_APEBOND_UP_PCT=100 LP_APEBOND_TOLERANCE_TICKS=500 \
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

### Minting a reward token to a wallet

Every reward token this program deploys (`$OVTR`, and any Overture-shaped token added later) has
ONE minter: the `RewardsDistributor` proxy. The operator multisig mints through the distributor's
operator-only `mintRewardToken(token, to, amount)` — no timelock delay — to one concrete wallet.
The claim flow is untouched: a claim still pays by transfer out of the funded balance, and tokens
minted to a wallet move no claim ledger. `$ASSET` is refused by address (`AssetNotMintable`),
whoever calls; it is funded by transfer only.

```bash
# to a user's wallet (whole tokens; MINT_TOKEN is a kind, a symbol or an address)
MINT_TOKEN=OVTR MINT_TO=0xUserWallet MINT_AMOUNT=250 \
  npx hardhat run scripts/lp-mint-reward.js --network sepolia
# into the distributor itself, to pre-fund claims (lp-fund-rewards.js does the same for $OVTR)
MINT_TOKEN=OVTR MINT_TO=distributor MINT_AMOUNT=2000000 \
  npx hardhat run scripts/lp-mint-reward.js --network sepolia
```

The script checks, in the contract's order and in words, that the token is not `$ASSET`, that it
is registered, that it has a `minter()`, and that the minter is the distributor; then it simulates the call FROM the
operator's address, so a Safe transaction that would revert is never printed. It prints the
recipient's balance before (and after, when it sends). With a key that is not the operator — the
mainnet Safe — it prints `to` / `value` / `data` and sends nothing. Mainnet needs `CONFIRM=yes`.

### Activating mintRewardToken on a live stack (Sepolia test stack #6)

Stack #6 was deployed before 2026-10-07: its distributor runs the v1 code (no `mintRewardToken`,
no `asset` field) and its Overture token's minter is the operator
`0x5576bD37419dadAab305cca998E16BcD73318A35`. Activating the change is ONE implementation deploy
and TWO timelock operations. Stack #6's timelock delay is 300 s (mainnet: 172,800). Stack #6 was
activated with this runbook on 2026-10-07 (the record is at the end of this section); the values
below are stack #6's from `deployments.json` as they were BEFORE it:

| what | address |
|---|---|
| `RewardsDistributor` proxy | `0xf839BE391803fe7104612bfd39A12EAde5DB7a04` |
| `TokenOverture` proxy | `0x49C5D5478e0DE581525Df80146C339A0cA9E4c89` |
| `$ASSET` (tREAL) | `0x8e65d19BE4bA1CC61005B4c70f21cd179512e33f` |
| `LPTimelock` | `0xfA92F00f9C944fb64Beee19ECAb3609f8C596a8D` |

The upgrade must run `initializeV2($ASSET)` INSIDE itself, as the `data` of `upgradeToAndCall`:
an upgrade with `0x` would leave the new `asset` field zero. For tREAL that calldata is

```
0x29b6eca90000000000000000000000008e65d19be4ba1cc61005b4c70f21cd179512e33f
```

(`initializeV2(address)`, selector `0x29b6eca9`; recompute with
`cast calldata "initializeV2(address)" 0x8e65d19BE4bA1CC61005B4c70f21cd179512e33f`).

1. **Deploy the new distributor implementation and record it.** `IMPL_UPGRADE_DATA` puts the
   calldata into the two commands the script prints. The plugin validates the new layout against
   the proxy's; no `IMPL_UNSAFE_ALLOW_EXTRA` is needed (measured: `prepareUpgrade` passes with the
   two default flags).

   ```bash
   IMPL_TARGET=RewardsDistributor RECORD=1 \
     IMPL_UPGRADE_DATA=0x29b6eca90000000000000000000000008e65d19be4ba1cc61005b4c70f21cd179512e33f \
     npx hardhat run scripts/deploy-implementation.js --network sepolia
   npx hardhat run scripts/validate-upgrade-safety.js --network sepolia
   ```

2. **Schedule both operations, wait `getMinDelay()`, execute both** — the upgrade FIRST, the
   minter second (the other order would leave a window in which the minter is a distributor that
   has no `mintRewardToken`). `<newImpl>` is the address step 1 printed.

   ```bash
   TIMELOCK_ACTION=schedule TIMELOCK_TARGET=RewardsDistributor TIMELOCK_FN=upgradeToAndCall \
     TIMELOCK_ARGS=<newImpl>,0x29b6eca90000000000000000000000008e65d19be4ba1cc61005b4c70f21cd179512e33f \
     npx hardhat run scripts/lp-timelock.js --network sepolia
   TIMELOCK_ACTION=schedule TIMELOCK_TARGET=TokenOverture TIMELOCK_FN=setMinter \
     TIMELOCK_ARGS=0xf839BE391803fe7104612bfd39A12EAde5DB7a04 \
     npx hardhat run scripts/lp-timelock.js --network sepolia

   TIMELOCK_ACTION=pending npx hardhat run scripts/lp-timelock.js --network sepolia   # both READY?

   TIMELOCK_ACTION=execute TIMELOCK_TARGET=RewardsDistributor TIMELOCK_FN=upgradeToAndCall \
     TIMELOCK_ARGS=<newImpl>,0x29b6eca90000000000000000000000008e65d19be4ba1cc61005b4c70f21cd179512e33f \
     npx hardhat run scripts/lp-timelock.js --network sepolia
   TIMELOCK_ACTION=execute TIMELOCK_TARGET=TokenOverture TIMELOCK_FN=setMinter \
     TIMELOCK_ARGS=0xf839BE391803fe7104612bfd39A12EAde5DB7a04 \
     npx hardhat run scripts/lp-timelock.js --network sepolia
   ```

   `onlyOwner` on `initializeV2` holds inside the execute: `upgradeToAndCall` delegatecalls it
   from the proxy, so `msg.sender` is the timelock — the owner. Optional third operation, only if
   `TRW` (`0x50566A6CBD1c080E0CBC3ae24b517bF5Aa22dDec`, minter still the operator) should be
   minted through the distributor too: the same `setMinter` with
   `TIMELOCK_TARGET_ADDRESS=0x50566A6CBD1c080E0CBC3ae24b517bF5Aa22dDec` instead of
   `TIMELOCK_TARGET=TokenOverture`.

3. **Post-checks.** The ERC-1967 implementation slot of the distributor equals `<newImpl>`
   (re-run step 1: it reports `Current impl` = the new one and sends nothing); `asset()` returns
   tREAL; `TokenOverture.minter()` returns the distributor proxy; `owner()`, `guardian()`,
   `operator()`, `signer()` and `rewardTokens()` are unchanged; then a 1-token rehearsal from the
   operator, and the `$ASSET` refusal by simulation:

   ```bash
   cast call 0xf839BE391803fe7104612bfd39A12EAde5DB7a04 "asset()(address)" --rpc-url $SEPOLIA_RPC_URL
   cast call 0x49C5D5478e0DE581525Df80146C339A0cA9E4c89 "minter()(address)" --rpc-url $SEPOLIA_RPC_URL
   MINT_TOKEN=OVTR MINT_TO=<a rehearsal wallet> MINT_AMOUNT=1 \
     npx hardhat run scripts/lp-mint-reward.js --network sepolia
   # must revert AssetNotMintable(0x8e65…33f) — a call simulated from the operator, nothing sent
   cast call 0xf839BE391803fe7104612bfd39A12EAde5DB7a04 "mintRewardToken(address,address,uint256)" \
     0x8e65d19BE4bA1CC61005B4c70f21cd179512e33f <a rehearsal wallet> 1 \
     --from 0x5576bD37419dadAab305cca998E16BcD73318A35 --rpc-url $SEPOLIA_RPC_URL
   ```

4. **Record and hand over.** Move `pendingImplementation` into `implementation` in the
   `RewardsDistributor` entry of `deployments.json`, set the `TokenOverture` entry's `minter` to
   the distributor proxy, add `asset` to the `RewardsDistributor` entry, and commit. Hand the new
   implementation address to the backend owner (krumbgf) for
   `LP_EXPECTED_IMPLEMENTATION_DISTRIBUTOR`, and recreate the api and worker containers. The
   indexer and the backend should learn the two new events, `RewardTokenMinted(token, to, amount,
   timestamp)` and `AssetSet(asset)` (the ABI is `abi/RewardsDistributor.json`); tokens minted
   to a wallet move no claim ledger.

Rehearsed on a LOCAL fork of Sepolia at block 11,861,835 (2026-10-07): with the timelock and the
operator impersonated, the upgrade with `initializeV2(tREAL)` and the `setMinter` both executed,
every v1 field kept its value, the operator minted 1 `$OVTR` to a fresh wallet and 5 into the
distributor, `mintRewardToken(tREAL, …)` reverted `AssetNotMintable(tREAL)`, and a second
`initializeV2` reverted.

**Activated on Sepolia test stack #6 on 2026-10-07** (10:20–10:29 UTC, all from the operator
`0x5576bD37419dadAab305cca998E16BcD73318A35`, the timelock's proposer and executor). The
distributor implementation moved from `0x31960c5129a39FfD5c05F34Db776924Ea9CbAd62` (v1) to
`0xF6f1377d68e3A7AdA590D3f1520c64B1738b1ecA` (v2, runtime code 11,585 bytes; the storage-layout
gate passed). The optional third operation (the TRW minter) was run too.

| step | operation id | transaction | block |
|---|---|---|---|
| deploy the v2 implementation | — | `0x74978593f7a109d96a8d42b3cbfd484394a626d34db48d89927d978d02e18219` | 11862351 |
| schedule `upgradeToAndCall(v2, initializeV2(tREAL))` | `0x7431d85b7a119d72c20b274e76b27763b30144abe1de22d2b2507f6b8f13ba94` | `0xef2fe23f007d3c85f68f0faef0234e1f1977ba8b851a642af9db87ae2d4633e7` | 11862357 |
| schedule `TokenOverture.setMinter(distributor)` | `0xe21baed11db480556e5ab8e040d5d5eed93d36cd44fc90396e7f539d34f45879` | `0x7f689e357d523101106b2a6ba51706c2e234186e9b66285e0b7244147dd6230d` | 11862358 |
| schedule TRW `setMinter(distributor)` | `0xdf8e2d93633608611b174a3c2636965193f0998c10a52ff3b4877c04aa888837` | `0xdcc12225d0eb301468be7b9381a8b948d15af4fec39e2bf211e3b312af78a428` | 11862359 |
| execute the upgrade (`Upgraded`, `AssetSet(tREAL)`, `Initialized(2)`) | `0x7431…ba94` | `0xf0b9d21ff1e272134a1b1c0bc871ecdda3736847077bfa05b46811bd4cfdc354` | 11862386 |
| execute the `$OVTR` minter move (`MinterChanged`) | `0xe21b…5879` | `0xa9172b15d10f6596b50eba32b10c4588e8f8c8c93958679b2b26081de6ad39f7` | 11862388 |
| execute the TRW minter move (`MinterChanged`) | `0xdf8e…8837` | `0xfac06cec9b25d11089cbca51a0e236a74655129bea16a443adf6852c732da6f9` | 11862389 |
| rehearsal: `mintRewardToken($OVTR, 0x2b98…bBEA, 1e18)` | — | `0xd9dbfda781270237b9b2f68464b181952718149ac612faf565407793a7b17cfc` | 11862392 |

Post-checks, read after the three executes: the ERC-1967 slot holds the v2 implementation;
`asset()` = tREAL; `TokenOverture.minter()` and TRW `minter()` = the distributor proxy;
`owner()` of all three = the timelock; `operator()`, `signer()`, `guardian()`, `paused()`
(false), `rewardTokens()` (tREAL, `$OVTR`, TRW) and every token's flags read the same as before
the upgrade, and `claimed(tREAL, operator)` stayed 0. `mintRewardToken(tREAL, …)` simulated from
the operator reverted `AssetNotMintable(tREAL)`. The rehearsal minted exactly 1 `$OVTR` to the
rehearsal wallet `0x2b9818c80E82363f5Cf21aD5DEEf1948D5F9bBEA` (balance 0 -> 1; event
`RewardTokenMinted(token $OVTR, to 0x2b98…bBEA, amount 1e18, timestamp 1791368940)`); the
distributor's own 70,000 `$OVTR` were not touched. The test server's
`LP_EXPECTED_IMPLEMENTATION_*` keys are left empty on purpose, so nothing was handed over.

### Replacing the timelock

**Case 1 — the timelock works, the switch is planned.** No contract stores the timelock address
immutably; every owner is storage. `lp-switch-timelock.js` moves everything the old timelock
owns (audit row C-15): the five proxies (Ownable2Step), `BonusEscrow` (a UUPS proxy,
Ownable2Step), `ApeBondPositionAdapter` (Ownable2Step since audit L-03: nominated at `execute`,
accepted by the new timelock's `accept` batch) and every `RewardToken:<SYMBOL>` entry
(Overture-shaped proxies, Ownable2Step). The escrow, the adapter and a reward token move only when
`deployments.json` records them for the chain with the old timelock as owner; otherwise the run
prints a `skip` line naming the entry (a stack without the ApeBond route, a reward token added by
address). The switch takes six runs:

```bash
SWITCH_ACTION=deploy      npx hardhat run scripts/lp-switch-timelock.js --network <net>  # new LPTimelock, delay 0
SWITCH_ACTION=schedule    npx hardhat run scripts/lp-switch-timelock.js --network <net>  # OLD timelock: one batch, transferOwnership(new) on each
#   … wait the OLD timelock's minDelay (48 h on mainnet) …
SWITCH_ACTION=execute     npx hardhat run scripts/lp-switch-timelock.js --network <net>  # pendingOwner = new on the two-step ones; the adapter moved
SWITCH_ACTION=accept      npx hardhat run scripts/lp-switch-timelock.js --network <net>  # NEW timelock: acceptOwnership on each two-step one
SWITCH_ACTION=raise-delay npx hardhat run scripts/lp-switch-timelock.js --network <net>  # NEW timelock: updateDelay(48 h) on itself
SWITCH_ACTION=verify      npx hardhat run scripts/lp-switch-timelock.js --network <net>  # owner() of each moved contract, minDelay; updates deployments.json
```

The new timelock is deployed with delay 0 so the acceptances and the delay increase run at once,
and `raise-delay` restores 48 h before `verify` passes. When the signer does not hold the
timelock role a step needs (the mainnet Safe), the script prints the Safe transaction instead of
sending. Mainnet needs `CONFIRM=1`. Rehearsed end to end on a mainnet fork; to be rehearsed on
Sepolia #6.

A canceller appointment does not move with a switch, and a switch batch can be cancelled by a term
canceller: see `docs/lp-staking-audit-notes.md` item 14, "Runbook — operating the timelock".
`SWITCH_ACTION=check` re-runs the new timelock's role checks when `deploy` could not finish them.

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

   - For a `BonusEscrow` upgrade (audit I-01): before scheduling an escrow upgrade, run the hook gas tests (`test/forge/unit/VaultBonusHooks.t.sol` `test_HookGas_*`) against the new escrow and confirm the forfeiture figure is under `BONUS_HOOK_GAS` (100,000); if not, raise the vault constant in a vault upgrade first. The vault calls
     `onUnstake` inside `try` with exactly that allowance, so an escrow whose forfeiture costs
     more fails open on every exit and keeps every bonus it should have forfeited.

3. **Schedule both upgrades.** Paste the command each run of step 1 printed, or write it out:

   ```bash
   TIMELOCK_ACTION=schedule TIMELOCK_TARGET=LPStakingVault TIMELOCK_FN=upgradeToAndCall \
     TIMELOCK_ARGS=<newVaultImplementation>,0x \
     npx hardhat run scripts/lp-timelock.js --network sepolia

   TIMELOCK_ACTION=schedule TIMELOCK_TARGET=RewardsDistributor TIMELOCK_FN=upgradeToAndCall \
     TIMELOCK_ARGS=<newDistributorImplementation>,0x \
     npx hardhat run scripts/lp-timelock.js --network sepolia
   ```

   `0x` is the `data` argument and means "no reinitializer call". The distributor's v1 -> v2
   upgrade of 2026-10-07 is the exception: its `data` is `initializeV2($ASSET)` — see
   "Activating mintRewardToken on a live stack". Each command prints its
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

## Staking v3

The staking v3 campaign (decisions of Brandon and Vladimir, 2026-11-09) moves stakers from the
closed $ASSET staking window sw2 (`WeightedStakingPool` v2, mainnet
`0xE570E438C1278A15305dE03f67E095fAcbF35A86`, immutable) into a new pool. The staker first calls
`unstake()` on sw2 (it pays principal and USDC reward to the staker only). Then ONE call on the
`StakingMigrator` runs one of three routes:

| Route | Function | What moves | Bonus reserved |
|---|---|---|---|
| 1. compound into v3 | `compound(usdcAmount, assetAmount, minAssetOut, deadline, usdcPermit, assetPermit, v)` | USDC swapped to $ASSET (SwapRouter02, the vault pool's fee, TWAP-guarded 300 s / 953 ticks; `minAssetOut` must be above zero, else `MinAssetOutZero`); principal + bought staked in v3 | `compoundBps` (1000) of (principal + min(bought, `usdcInAsset(usdcAmount)`)): the bought part counts at most at its 1,800 s TWAP value |
| 2. join LP and compound | `moveToLp(usdcAmount, assetAmount, amount0Min, amount1Min, deadline, usdcPermit, assetPermit, v)` | one position on the band 6,932 ticks each side of the spot tick (-50 % / +100 %), from the whole USDC and the matching $ASSET, staked in the LP vault for the caller (custody asserted after the stake: `CustodyAssertFailed(tokenId, owner, staker)` unless the NFT is the vault's and credited to the caller); USDC dust refunded; the rest of the $ASSET staked in v3 | `lpBps` (1000) of (LP $ASSET leg + LP USDC leg valued at the 1,800 s mean tick), keyed by the tokenId; `lpBps` of the v3 remainder |
| 3. claim and restake | `claimRestake(assetAmount, deadline, assetPermit, v)` | the principal only; the USDC stays in the wallet | `restakeBps` (500) of the principal |

Every route needs the backend's `TransitionVoucher(address user,uint8 route,uint256
eligiblePrincipal,uint256 eligibleReward,uint256 nonce,uint256 deadline)`, EIP-712 domain
`("StakingMigrator", "1", chainId, migrator proxy)`, signed by `migrator.signer()` (no `weight`
field since 2026-11-10). The migrator checks the route, the deadline, `assetAmount <=
eligiblePrincipal`, `usdcAmount <= eligibleReward`, the per-user nonce and the signature, then
stakes for the user with `pool.stakeFor(user, amount)`. A permit is optional: `deadline == 0` means "already approved" (the Sepolia
test tokens have no EIP-2612). Routes 1 and 2 are born PAUSED and are switched by the LP vault's
tiers: `pauseCompound` (guardian or operator), `unpauseCompound` (operator only). Route 3 is never
paused.

**One transition per wallet.** The first successful route call marks the caller
`migrated(user) = true`; every later route call by that wallet reverts `AlreadyMigrated(user)`,
whatever voucher it carries. A replayed nonce still reverts `VoucherNonceUsed` first. The backend
issues one voucher per sw2 claim and should read `migrated(user)` before it signs.

The bonus is a RESERVATION in `V3BonusVault`, unlocked at the v3 pool's `endEpoch`. Nothing is
paid or checked at the transition. The company funds the vault with $ASSET any time before the
end (`fund(amount)` or a plain transfer).

**Three claim functions (2026-11-12).** Each pays the caller only, from the vault's balance, under
the same rules: `NothingToClaim()` when it would pay zero, `InsufficientFunds(requested, available)`
while the balance is short (nothing changes then), `totalReserved()` lowered by exactly what is paid
and `totalLpReserved()` by exactly its LP part, and every paid record marked so it never pays twice.

| Call | What it pays |
|---|---|
| `claim()` | everything of the caller's that is unlocked: the v3 reservation plus every payable LP reservation (unchanged behaviour) |
| `claimV3()` | the caller's v3 reservation only, once unlocked |
| `claimLp(tokenId)` | the LP reservation of `tokenId` only, when it is the caller's and payable (the rule below); another wallet's record reverts `NotLpReservationUser(tokenId, caller, user)`, an unknown tokenId reverts `NothingToClaim()` |

Events, so an indexer can date each part: `V3BonusClaimed(user, amount)` for the v3 part a call pays,
`LpBonusClaimed(tokenId, user, amount)` for each LP record it pays, then `BonusClaimed(user, total)`
ONCE per call with the call's total (as before). A `claim()` that pays the v3 part and one LP record
therefore emits three events, in that order.

**Leaving v3 early (rule of 2026-11-12).** A `withdraw` from v3 before the end, of any amount
(partial or full), calls `onEarlyExit(user)` (fail closed) and forfeits BOTH parts of the caller:
the WHOLE v3 reservation (`BonusForfeited(user, amount)`) AND every LP reservation of the caller that
is still active, i.e. recorded, not claimed, not forfeited and before its unlock
(`LpBonusForfeited(tokenId, user, amount)` each). The LP position itself stays staked in the LP
vault; its record stays forfeited: a later `unstake` or `rebalance` of it, and `reconcileLp`, change
nothing, and it never pays. The reverse does not hold: an LP `unstake` before the unlock forfeits
only that LP reservation, and the v3 reservation still pays at the end. The `withdraw` returns the
principal in full: v3 has no principal penalty and pays nothing to a penalty receiver (decision of
2026-11-10). The LP
reservation follows the position: the vault's `rebalance` moves it to the new tokenId scaled by
min(1, valueNew / valueOld) (never up); an `unstake` before the unlock forfeits it; after the
unlock either one SETTLES it (`LpBonusSettled(tokenId, user)`, view `lpSettled(tokenId)`): it stays
under the tokenId it had, unscaled, and pays. After the unlock `claim()` (and `claimLp(tokenId)`) pays an LP reservation that
is SETTLED, MISSED-AFTER (the vault's `onUnstake` to the listener failed at or after the unlock) or
still HELD by the vault for its user (`stakerOf(tokenId) == user`), and never one that is DEAD (that
notification failed before the unlock); any other record is stale and pays nothing (2026-11-10, see
below). Forfeited amounts stay in the vault as surplus
(`recoverSurplus(to, amount)`, owner). `totalLpReserved()` is the LP part of `totalReserved()`.

**The budget.** `maxTotalReserved()` caps `totalReserved()`: `reserve` and `reserveLp` revert
`BudgetExceeded(requested, remaining)` above it, so the route call reverts with them. It is set at
deploy (`V3_MAX_TOTAL_RESERVED`) and by the owner (`setMaxTotalReserved`, event
`MaxTotalReservedSet(previousMax, newMax)`, a timelock operation).

**A failed listener notification (`BonusListenerFailed`).** Since 2026-11-10 the LP vault's
`onRebalance` notification to the listener FAILS CLOSED like the escrow's (no `try`, all the
remaining gas): a rebalance whose bonus re-scaling cannot run reverts, and the reservation never
stays behind under the burned tokenId. The `onUnstake` notification still fails OPEN (an exit is
never blocked): when it reverts, the vault emits `BonusListenerFailed(tokenId)`, the LP reservation
stays under that tokenId, and the vault records the FIRST such moment per tokenId
(`listenerMissedAt(tokenId)`, never overwritten). The bonus vault reads it against the record's
unlock:

- `missedAt < unlockAt`: DEAD. The forfeit of an early exit was missed. The record never pays, even
  when the same NFT is staked again by the same user; a later after-unlock unstake or re-range
  forfeits it instead of settling it, a before-unlock re-range forfeits it instead of moving it.
- `missedAt >= unlockAt`: MISSED-AFTER. The settlement of a legitimate exit was missed. The record
  pays as if it were settled.

The backend sends no transaction. For every `BonusListenerFailed` event it raises the alert
`lp.vault.bonus_listener_failed` with the action "call `V3BonusVault.reconcileLp(tokenId)` from any
wallet", and the operator (or anyone) sends that call, before or after the unlock. `reconcileLp`
(permissionless) makes the state explicit: before the unlock it forfeits a dead record or one the
vault no longer holds for its user (`LpBonusForfeited`); after the unlock it settles a missed-after
record (`LpBonusSettled`) and forfeits a record that is neither settled, nor missed-after, nor held;
a settled record is never touched. `totalLpReserved()` therefore does not stay inflated.

**The v3 pool, a separate minimal contract (decision of 2026-11-10).** `WeightedStakingPoolV3`
holds each wallet's $ASSET principal for the window and pays it back; it has no weight multiplier,
no USDC reward and no penalty. Its whole surface:

| Call | Who / when | What it does |
|---|---|---|
| `stake(amount, deadline, signature)` | anyone, before `endEpoch` | pulls `amount` from the caller; needs the backend's EIP-712 `StakeVoucher(address user,uint256 nonce,uint256 deadline)`, domain `("WeightedStakingPool", "1", chainId, pool proxy)`, signed by `signer()`, over the caller's next `nonces(user)`; the nonce is spent (`NonceUsed`). The voucher binds no amount |
| `stakeFor(user, amount)` | the `migrator()` only, before `endEpoch` | pulls from the migrator, credits `user` (`Staked` then `StakedFor`) |
| `withdraw(amount)` | a staker, before `endEpoch` | the principal back in full; `bonusVault().onEarlyExit(user)` forfeits the whole v3 reservation AND every active LP reservation of the user, for any amount withdrawn, fail closed (also before the activation) |
| `unstake()` / `emergencyUnstake()` | a staker, from `endEpoch` | the whole principal (`Unstaked` / `EmergencyUnstaked`); `emergencyUnstake` is kept on purpose and can be removed by a later upgrade |
| `setSigner`, `setMigrator`, `setBonusVault`, `recoverERC20`, `upgradeToAndCall`, `transferOwnership` | the owner (the timelock) | `renounceOwnership` reverts. `setBonusVault`: before `endEpoch` a linked vault can be neither unlinked nor replaced (`BonusVaultLocked(current, endEpoch)`); linking from zero is always allowed. If the bonus vault reverts, upgrade it, never unlink it. `recoverERC20`: any token in full; of $ASSET only `balanceOf(pool) - totalStaked` (`SurplusExceeded(requested, available)` above it) |

Views: `stakingToken()`, `activationEpoch()`, `endEpoch()`, `signer()`, `migrator()`, `bonusVault()`,
`totalStaked()`, `stakes(user)` (the principal, ONE word under the old selector: vendor the new ABI
with the upgrade), `nonces(user)`,
`STAKE_VOUCHER_TYPEHASH()`. `activationEpoch` gates nothing; it is shown for information only.
Events: `PoolInitialized(stakingToken, activationEpoch, endEpoch,
signer)`, `Staked(user, amount)`, `StakedFor(user, by, amount)`, `Withdrawn(user, amount)`,
`Unstaked(user, amount)`, `EmergencyUnstaked(user, amount)`, `NonceUsed(user, nonce)`,
`SignerChanged(oldSigner, newSigner)`, `MigratorSet(previous, new)`, `BonusVaultSet(previous, new)`.
What each wallet brought in per route stays in the migrator's events: `Compounded(user, principal,
usdcIn, assetBought, staked, bonus)`, `MovedToLp(user, tokenId, usdcIn, assetToLp, restaked,
lpBonus, v3Bonus)` (+ `UsdcRefunded(user, amount)` for the USDC the position did not take),
`ClaimRestaked(user, principal, bonus)`. The fields of the stack #6 layout the pool no longer uses
stay in storage as deprecated slots (audit notes item 19).

The LP vault refuses to unlink or replace the listener while its `totalLpReserved()` is above zero
(`ListenerHasReservations`); the v3-pool reservations do not hold the link. It also refuses a
listener bound to another vault (`ListenerVaultMismatch(listener, itsVault)` unless
`listener.vault()` is the LP vault): the listener's `onRebalance` fails closed and accepts its own
vault only, so a wrongly bound listener would revert every rebalance. Order of operations: link the
vault to the listener first (the listener's `setVault`, or its initializer), then
`setBonusListener(listener)`; to unlink, `setBonusListener(0)` first. The deploy below satisfies it:
`V3BonusVault.initialize` sets the vault before the batch runs `setBonusListener(bonusVault)`. The bonus vault itself
refuses `setVault` while `totalLpReserved()` is above zero (`LpReservationsOutstanding`), and
`setPool` is only ever sent in the same batch as the pool's `setBonusVault`.

### Deploying (`scripts/deploy-staking-v3.js`)

```bash
# 0. a live vault older than the listener needs the new implementation first
IMPL_TARGET=LPStakingVault npx hardhat run scripts/deploy-implementation.js --network sepolia

# 1. the three proxies, the direct wiring, the nominations and the timelock batch file
V3_ACTIVATION_EPOCH=<unix> V3_END_EPOCH=<unix> V3_STAKE_SIGNER=0xBackendKey \
  V3_VAULT_IMPLEMENTATION=0xNewVaultImpl V3_MAX_TOTAL_RESERVED=100000 \
  npx hardhat run scripts/deploy-staking-v3.js --network sepolia

# 2. the batch it printed: schedule, wait the delay, execute
TIMELOCK_ACTION=schedule-batch TIMELOCK_BATCH=<file> TIMELOCK_SALT_TAG=staking-v3 \
  npx hardhat run scripts/lp-timelock.js --network sepolia
TIMELOCK_ACTION=execute-batch  TIMELOCK_BATCH=<file> TIMELOCK_SALT_TAG=staking-v3 \
  npx hardhat run scripts/lp-timelock.js --network sepolia
```

The deployer owns the three proxies until the batch runs, and sends only the wiring that opens no
route: `pool.setBonusVault(bonusVault)`, then `transferOwnership(timelock)` on all three (a
nomination). The batch, in order: `acceptOwnership()` on the three,
`WeightedStakingPoolV3.setMigrator(migrator)`, `V3BonusVault.setMigrator(migrator)` (no route works
before these two, so none works before the timelock owns everything),
`LPStakingVault.upgradeToAndCall(V3_VAULT_IMPLEMENTATION, initializeV2())` (data `0x5cd8a76b`;
only when the vault has no `bonusHookGas()` yet: the 746b22c vault and the first v3 vault of
2026-11-09; `initializeV2` writes the hook gas defaults 400,000 / 1,000,000),
`LPStakingVault.setBonusHookGas(LP_BONUS_HOOK_GAS, LP_BONUS_LISTENER_GAS)` (only when those differ
from what the vault holds after the upgrade), `LPStakingVault.setBonusListener(bonusVault)`,
`LPStakingVault.setStakeOperator(migrator, true)`. A run RESUMES: a kind already recorded in
deployments.json for the chain is reused (printed "recorded at …, reused") instead of deployed again,
every wiring step and batch call already on chain is skipped, and an up-to-date stack yields no
batch. To deploy afresh, remove the three registry entries first. After the batch: fund the bonus vault, and
`StakingMigrator.unpauseCompound()` (the vault's operator) once the pool has the liquidity routes 1
and 2 need. Registry kinds: `WeightedStakingPoolV3`, `V3BonusVault`, `StakingMigrator`. `CONFIRM=yes`
on mainnet.

| Variable | Meaning | Default |
|---|---|---|
| `V3_ACTIVATION_EPOCH`, `V3_END_EPOCH` | the v3 active period; the end is the bonus unlock | required |
| `V3_STAKE_SIGNER` | the v3 pool's `StakeVoucher` signer (a direct `stake`) | required |
| `V3_MIGRATOR_SIGNER` | the `TransitionVoucher` signer | `V3_STAKE_SIGNER` |
| `V3_ASSET`, `V3_USDC` | the two tokens | the `LPZapper` entry's `asset`, `usdc` |
| `V3_LP_VAULT`, `V3_TIMELOCK` | the vault and the owner | the registry entries |
| `V3_TWAP_WINDOW`, `V3_TWAP_MAX_DEVIATION_TICKS` | the migrator's swap guard | 300, 953 |
| `V3_VALUATION_WINDOW` | the mean tick valuing the LP USDC leg (and capping the compound bonus) | 1800 |
| `V3_MAX_TOTAL_RESERVED` | the bonus vault's cap on all reservations, in whole $ASSET | required on mainnet; 100000 on test networks |
| `V3_VAULT_IMPLEMENTATION` | the vault implementation the batch upgrades to | none |
| `LP_BONUS_HOOK_GAS`, `LP_BONUS_LISTENER_GAS` | the vault's hook gas allowances (see "Measuring the hook gas" below) | 400000, 1000000 |
| `V3_BATCH_FILE` | where the batch file goes | a file in the OS temp dir |

Owner-tier calls on the new contracts go through `lp-timelock.js` (`setMigrator`, `setBonusVault`,
`setSigner` on the pool, `setPool`, `setVault`, `setMaxTotalReserved`, `recoverSurplusAmount` on
the bonus vault,
`setRates` on the migrator, `upgradeToAndCall`, `transferOwnership`, `acceptOwnership`, and
`setBonusListener` and `setBonusHookGas` on the vault). The migrator's `setSigner`, `setTwapParams`, `pauseCompound` and
`unpauseCompound` are operator / guardian tier and are sent directly. `deploy-implementation.js`
knows the three kinds (the migrator's constructor arguments are read back from `lpVault()`,
`usdc()`, `asset()`), and `validate-upgrade-safety.js` checks all three (their layout half only
where the registry records them).

### The sw2 rehearsal pool (`scripts/deploy-weighted-test.js`)

```bash
# a v2 pool on Sepolia, activation now, end in one hour, 1,000 tUSDC of rewards
SW2_TEST_REWARD=1000 WEIGHT_SIGNER=0xBackendKey \
  npx hardhat run scripts/deploy-weighted-test.js --network sepolia
```

`SW2_TEST_START_DELAY` (default 0) and `SW2_TEST_DURATION` (default 3600) move the window;
`STAKING_TOKEN` / `REWARD_TOKEN` default to the `LPZapper` entry's tokens. It refuses mainnet and
records the pool as `WeightedStakingPoolTest`.

### Staking v3 on stack #6, second set (2026-11-11)

A second staking v3 set was deployed on Sepolia test stack #6 on 2026-11-11 with
`scripts/deploy-staking-v3.js`, from commit 7c6a764, by the deployer
`0x5576bD37419dadAab305cca998E16BcD73318A35`. It replaces the first set of 2026-11-09 (the next
section), which cannot serve the test site. The registry kinds `WeightedStakingPoolV3`,
`V3BonusVault` and `StakingMigrator` in deployments.json (chain 11155111) now hold this set.

| What | Address | Block | Transaction |
|---|---|---|---|
| `WeightedStakingPoolV3` proxy (impl `0xE6077b572f218194333051F12D24eF6f63f3cC2c`) | `0xffE65d69154Bd0C9c521481524ADADE2b0fC48B6` | 12112123 | `0x5fc511e51c822617ac9b516fccaa7ed2accf8d46142cc8738110ed1c4bdbc623` |
| `V3BonusVault` proxy (impl `0x986a26368226c4d439660791a7a5fe177571755E` since 2026-11-12, previous `0xEe44bAE07AA5493108e1e0BEF92180D76CA8A8Da`) | `0x2Daa6bC6f7FC8cc71CB5676dbC84bFCCFD661fa1` | 12112125 | `0x1f1873da15c483724fa65adb896298afc752293aa2448b15d75315f6267f1d1d` |
| `StakingMigrator` proxy (impl `0x9EbdCD53AA954a8a880D05e17657Fbcaa1007A1A`) | `0x58a0464284020bF3368d3B629c5F693e94F8D893` | 12112127 | `0x96d588dbd3181c55ea813491aef280166fd3747a18b43beb4ae7a1a1e9fe25af` |
| `pool.setBonusVault(0x2Daa…1fa1)`, then the three `transferOwnership(0xf2F6…1E20)` nominations | | | `0x79b38f447f9b57c925a2122bed87768bce190f7fee55ad590eafb4241a3aa741` (the `setBonusVault`) |

Parameters: activation 1794404858 (2026-11-11 15:47:38 Sofia, 13:47:38 UTC), end = bonus unlock
1802180858 (2027-02-09 15:47:38 Sofia, 13:47:38 UTC), a window of 90 days (decided by Vladimir on
2026-11-11). Stake signer and migrator signer = the deployer `0x5576…8A35`. Swap guard 300 s and
953 ticks, valuation window 1,800 s, `maxTotalReserved` 100,000 $ASSET, vault hook gas 400,000 /
1,000,000 (all script defaults).

State: linked and funded on 2026-11-12. The timelock batch (`LPTimelock`
`0xf2F678AC5260BB297682D54DcD945BCB78901E20`, tag `staking-v3`, id
`0xd0d5bd916cc9885d17acc6f9cf1473bd4e59e78cd7f69ca072ebc58126ad1360`) holds 7 calls:
`acceptOwnership()` on the three proxies, `setMigrator(0x58a0…D893)` on the pool and on the bonus
vault, then on the LP vault `0x4B2f60D698d152ba1f5Aaf02acF42da8823B2eac`
`setBonusListener(0x2Daa…1fa1)` and `setStakeOperator(0x58a0…D893, true)`. It has no vault upgrade
and no `setBonusHookGas`, because the live vault already has both. A re-run of
`deploy-staking-v3.js` with the same `V3_*` values resumes (the three kinds are recorded) and writes
the same batch file again.

Order rule, satisfied first: the batch waited on purpose for the deploy-day order of the indexer.
The test server's indexer registered the three new proxies and refreshed the vault ABI on 2026-11-11
at 18:28 Sofia (16:28 UTC), and only then did the batch run.

Blocker, cleared on 2026-11-11: `LPStakingVault.setBonusListener` reverts with
`ListenerHasReservations` while the current listener, the first set's bonus vault
`0x72035F4BD96AcF498030E9A39eDc3546F3815221`, reports `totalLpReserved() != 0`, and it reported
106.027583613785831393 $ASSET (D's record under tokenId 234226). The retirement upgrade of that bonus
vault to `V3BonusVaultRetired` (timelock id
`0xf600788869b6879672584275945b86770fb189679c7ac4634c87ef8d2ad0cfd8`, executed in block 12112252, tx
`0x9e47c57cb648ba1ba98320c3a7b0790700fb372537a3bfa726f165c2769c2980`, see the first set's section
below) made it report 0.

The batch was scheduled in block 12117876 (2026-11-12 11:12:00 Sofia, 09:12:00 UTC), tx
`0x250bb168837e6a5ea3a2ec9117c9154dd9bd3e9615ba1210c75e4491ef07739f`, and executed in block
12117902 (11:17:12 Sofia, 09:17:12 UTC), tx
`0x6f64bd49ce4f0fb42e87b1d7998506efcd18ad6cb67a55db9dd849f8cd28da93`. Read back after it: `owner()`
of the three proxies is the timelock `0xf2F6…1E20` and `pendingOwner()` is the zero address. The
pool's and the bonus vault's `migrator()` are `0x58a0464284020bF3368d3B629c5F693e94F8D893`. The LP
vault's `bonusListener()` is `0x2Daa6bC6f7FC8cc71CB5676dbC84bFCCFD661fa1` and
`isStakeOperator(0x58a0…D893)` is true. The retired first-set migrator
`0x2e72f57f494daDc9fA266a518361F103cD1fc493` is still an allowed stake operator on the LP vault
(`isStakeOperator` true), because the batch added the new migrator and did not remove the old one.

The operator `0x5576bD37419dadAab305cca998E16BcD73318A35` then ran the two steps the script prints.
`StakingMigrator.unpauseCompound()` landed in block 12117908 (11:18:24 Sofia, 09:18:24 UTC), tx
`0x79da457340b722518e2390a72f19f1c2dfa71070a5aceee96cb15af04b103194`, and `compoundPaused()` is now
false. The tREAL `approve(0x2Daa…1fa1, 20,000)` landed in block 12117914, tx
`0xcdc4c576a783007e50a4ad28bb78b420370d99c94452be4457591dedbec0f48f` (gas used 128,310), and
`V3BonusVault.fund(20,000 test $ASSET)` (20000000000000000000000 wei) landed in block 12117920
(11:20:48 Sofia, 09:20:48 UTC), tx `0xd3def6cbff5652d9f2d640fbb9ae1b55d36c10e4b070469aad0ab4c84bd37f4d`
(gas used 155,992). The bonus vault's tREAL balance is now 20,000.

Upgrade of the bonus vault on 2026-11-12. The `V3BonusVault` proxy
`0x2Daa6bC6f7FC8cc71CB5676dbC84bFCCFD661fa1` was upgraded from the implementation
`0xEe44bAE07AA5493108e1e0BEF92180D76CA8A8Da` to the implementation
`0x986a26368226c4d439660791a7a5fe177571755E`, built from commits d922e70 and 224d228. The new
implementation was deployed with `IMPL_TARGET=V3BonusVault npx hardhat run
scripts/deploy-implementation.js --network sepolia` from commit 224d228 in block 12119277
(15:55:00 Sofia, 13:55:00 UTC), tx `0xe33343416d26634f3f2484d932ab7313525f30772dd0678f61d52ff455e79850`,
and its runtime code is 14,236 bytes. `prepareUpgrade` validated it against the deployed storage
layout, and `scripts/validate-upgrade-safety.js --network sepolia` passed ("All upgrade-safety
checks passed."). The `LPTimelock` `0xf2F678AC5260BB297682D54DcD945BCB78901E20` operation
`upgradeToAndCall(0x986a26368226c4d439660791a7a5fe177571755E, 0x)` on the proxy (id
`0xed2995d64867edbd81a0189a7de99b339689e181c206e6bd8bb2ab22be92af7a`, no salt tag) was scheduled in
block 12119287 (15:57:00 Sofia, 13:57:00 UTC), tx
`0x7c1e9024f29892ce7786e17053dffa636ba87290e8d0ecb49b2242703610645f`, and executed in block 12119313
(16:02:24 Sofia, 14:02:24 UTC), tx `0x8aed8274c8a3db01d88b56f041702caa9cf745a98077e9a8552bb0d5d08ea0f3`.
The new implementation changes two things. An early exit from the pool now forfeits both bonus
parts of the user: the whole v3 reservation and every LP reservation of the user that is still
active. Next to `claim()`, a user can now claim each part on its own with `claimV3()` and
`claimLp(tokenId)`. Read back after the upgrade: the ERC-1967 implementation of the proxy is
`0x986a26368226c4d439660791a7a5fe177571755E`. `owner()` is the timelock, `migrator()` is
`0x58a0464284020bF3368d3B629c5F693e94F8D893`, `pool()` is `0xffE65d69154Bd0C9c521481524ADADE2b0fC48B6`
and `vault()` is `0x4B2f60D698d152ba1f5Aaf02acF42da8823B2eac`. `maxTotalReserved()` is 100,000
$ASSET, `totalReserved()` and `totalLpReserved()` are 0, and the proxy's tREAL balance is 20,000. A
simulated `claimV3()` from a wallet without a reservation reverts with `NothingToClaim()` (selector
`0x969bf728`), which shows that the new function is live. No reservation existed at the time of the
upgrade, and no claim can be logged before the pool's end (2027-02-09 15:47:38 Sofia, 13:47:38 UTC).
The test server's indexer still runs the module version from before this change (evm-indexer
`staking-v3-campaign` 1cbbb4a). The matching module version is a7068b2. It needs the stored ABI
`LpStaking.V3BonusVault` refreshed and the engine restarted, at any time before the pool's end.

Two earlier attempts reverted and changed nothing: an `approve` sent with a fixed gas limit of
120,000 ran out of gas (block 12117906, tx
`0xab33c23502749ea76b4351557c571ff10e4fb11bc286cbc384c4b9adb3660db5`), and the `fund` right after it
reverted for lack of allowance (block 12117907, tx
`0xb73b5ba6da44bde277ac9727d3853f6c951fb62533959099421508f4780e00b4`). On Sepolia today an `approve`
that writes a new allowance used 128,310 gas, so writes should take the node's estimate instead of a
hand-picked limit.

### Staking v3 on stack #6, first set (2026-11-09, retired 2026-11-11)

Deployed and rehearsed on Sepolia test stack #6 on 2026-11-09 by the deployer / operator
`0x5576bD37419dadAab305cca998E16BcD73318A35`, owner = the live `LPTimelock`
`0xf2F678AC5260BB297682D54DcD945BCB78901E20` (300 s). The rehearsal STOPPED at the rebalance
(see "Open finding" below); nothing was claimed. The finding was resolved on 2026-11-10 by the vault
upgrade to the owner-set hook gas and proven with wallet D (see "Resolved" below the finding).

This first set was retired on 2026-11-11 in favour of the second set (the section above). Its window
ends on 2026-11-12 17:10:12 UTC, and the pool has no function to move its end. Its pool proxy also
ran the weighted build from its deployment block 12098916 until the upgrade to the minimal build at
block 12105079, and emitted 25 logs in the old shape (among them the event that seeds the pool's
window and every stake, 38,939.81 test $ASSET in four wallets), which an indexer that registers the
proxy from its deployment block with the minimal ABI cannot decode. The three contracts stay on
chain and keep their state. In deployments.json their entries are now the kinds
`WeightedStakingPoolV3Retired`, `V3BonusVaultRetired` and `StakingMigratorRetired` (each with
`retiredOn`, `retiredReason` and `retiredInFavourOf`, as `TimelockControllerRetired`).

The first bonus vault was retired by an upgrade on 2026-11-11, all transactions in the table below.
Its LP reservation of 106.027583613785831393 $ASSET (D's record under tokenId 234226) blocked the
vault's `setBonusListener` switch to the second set (`ListenerHasReservations`), and no one can clear
it, because the keys of the rehearsal wallets B, C and D are lost. The replacement implementation is
`V3BonusVaultRetired` (`contracts/lp-staking/mocks/V3BonusVaultRetired.sol`, 5 tests in
`test/forge/unit/V3BonusVaultRetired.t.sol`, in the repo since commit 31c0939). It is for a test
stack ONLY and must never be deployed on mainnet. It reports `totalLpReserved() == 0`, its
`onUnstake` and `onRebalance` do nothing, and it has no claim, no funding and no recovery. The
implementation `0x37a6ed1343Ec965e401801bD91678f494874d03a` (block 12112222) was deployed with
`IMPL_CONTRACT`, which picks the artifact while `IMPL_TARGET` stays the kind:

```bash
IMPL_TARGET=V3BonusVault IMPL_PROXY_ADDRESS=0x72035F4BD96AcF498030E9A39eDc3546F3815221 \
  IMPL_CONTRACT=V3BonusVaultRetired IMPL_UNSAFE_ALLOW_EXTRA=missing-initializer \
  npx hardhat run scripts/deploy-implementation.js --network sepolia
```

The timelock operation `upgradeToAndCall(0x37a6…d03a, 0x)` on the proxy
`0x72035F4BD96AcF498030E9A39eDc3546F3815221`, id
`0xf600788869b6879672584275945b86770fb189679c7ac4634c87ef8d2ad0cfd8`, was scheduled in block 12112225
(2026-11-11 16:09:36 Sofia, 14:09:36 UTC) and executed in block 12112252 (16:15:36 Sofia, 14:15:36
UTC). It was sent with `TIMELOCK_TARGET_ADDRESS=0x72035F4BD96AcF498030E9A39eDc3546F3815221` and no
`TIMELOCK_TARGET`, because the registry kind `V3BonusVault` now names the second set's bonus vault.
Read back after it: the proxy's implementation slot holds `0x37a6…d03a`, `totalLpReserved()` returns
0, `owner()` is still the timelock `0xf2F678AC5260BB297682D54DcD945BCB78901E20`, and a simulation of
`LPStakingVault.setBonusListener(0x2Daa6bC6f7FC8cc71CB5676dbC84bFCCFD661fa1)` from the timelock
passes. The LP vault's `bonusListener()` stays the first bonus vault until the second set's batch
runs. Consequences, on test tokens only: every reservation of the first bonus vault (v3 and LP) is
unreachable, and its 20,000 tREAL stay in the proxy. The first pool still holds 38,939.81 test $ASSET
of four wallets, and the three wallets B, C and D cannot take theirs back.

| What | Address | Block | Transaction |
|---|---|---|---|
| `LPStakingVault` implementation (new, with the listener) | `0xDa50c33088CD9d172480d85E9946AaF6A456D09c` | 12098887 | `0x44507de0d41d35b2185b00f8ab655d2839d20b74311a9a8bb05f9bda4b89b30f` |
| sw2-test (`WeightedStakingPoolTest`, the v2 contract, 60 min) | `0xdB382c591420C3b7F38FEf6BD9EFd23fCaFD0298` | 12098897 | `0x60fb621c064751e164ad75d6857e5d8d1b1d8b48b5766a0cc0c3a1d0f0a1c680` |
| sw2-test `addRewards(1,000 tUSDC)` | | 12098899 | `0x4f6e90eb241a2abcc47605379e8f99676ccec561cb4bb493fb9b26bb4a1807a0` |
| `WeightedStakingPoolV3` proxy (impl `0x19499B535E6F8A2200fA466Ef9BEFd04D5027E06`) | `0xB8F5aE06567E657F781eC7EB049E5c62646bfcb9` | 12098916 | `0x8134104f25c7c40a387ba7180ae03ecf4257a49005dc6151afb5066545b5b5ba` |
| `V3BonusVault` proxy (impl `0xB395ed72D08c072df4ED4900b80A0a78a30c1478`) | `0x72035F4BD96AcF498030E9A39eDc3546F3815221` | 12098918 | `0x43cf25b7cba5e850fc0055f4b1a19929635c020f5de59fdbb2108808f0865c25` |
| `StakingMigrator` proxy (impl `0x33c9d0298D99aa801Bfc9B0bc540F65E8e7F6E70`) | `0x2e72f57f494daDc9fA266a518361F103cD1fc493` | 12098920 | `0xee704ffbacb4c6de41ca4f8281f178295f3c32bd10bf0abf42abb41ae435561c` |
| `pool.setBonusVault`, then the three nominations | | 12098921-24 | `0x2c8dd859…5108`, `0xe55f7f07…335b`, `0x84da6a6d…88bf`, `0x69586ddc…0f0c` |
| timelock `scheduleBatch` (8 calls, tag `staking-v3`, id `0x2992fad9…c2a3`) | | 12098926 | `0x65e37625aee82e1f1dfa70b3cb9bd999c35736bf1d44b668adc33158ec4554da` |
| timelock `executeBatch` | | 12098956 | `0xb0060a7c96d7881decf3fcd7c273bbeae231b826520dea89a759e4e020831af2` |
| `V3BonusVault.fund(20,000 tREAL)` | | 12098960 | `0x8f2e011075fdfe89fb9610a8789c9f3c5d6f81d5b0998ed377adff7e3e995ad0` |
| `StakingMigrator.unpauseCompound()` | | 12098961 | `0x6f270141d6b085471672fa7a31448f86bee28bc2f82e02721d4e8dfa1e3f7052` |
| 2026-11-10: `LPStakingVault` implementation (owner-set hook gas, `setBonusHookGas`, `initializeV2()`; built from 5707a98) | `0x2eBABFe60b962D229fb7d1259984cFa6703886Ba` | 12103692 | `0x114e7b9df2b973385d4c1246cfc483e009e9a1fed3291c31384d19789dfa6955` |
| 2026-11-10: timelock `schedule` `upgradeToAndCall(0x2eBA…86Ba, 0x5cd8a76b)` (tag `vault-hook-gas`, id `0x855baaac…1cbd`) | | 12103703 | `0xecc7351c7baf78bff19094b74af5141ba5644751c7702fc69fb3d555f054065b` |
| 2026-11-10: timelock `execute` (emits `Upgraded`, `BonusHookGasSet(400000, 1000000)`, `Initialized(2)`) | | 12103729 | `0x52c8fb83c0a1a4fa201c1f86e8e7aca40ba6668fd95a3d869e7ccfbd2c769379` |
| 2026-11-10: wallet D funded by A: 0.05 ETH, 20,000 tREAL, 2,000 tUSDC | `0xdbE0379cC79bBD2Fa9719274D6cB30499829E251` | 12103750-52 | `0x70152d93…4e14`, `0x3492b531…ae13`, `0xe69fb8dc…bd83` |
| 2026-11-10: D `moveToLp(300 tUSDC, 10,000 tREAL)` -> tokenId 234225 | | 12103757 | `0x44ccb633e237b8b5e891610134ca4382063c7d59353384ed135ffb6b14910d93` |
| 2026-11-10: D `rebalance(234225)` -> tokenId 234226, `LpBonusMoved`, no `BonusListenerFailed` | | 12103759 | `0x78650e89be486d24b86042e611f5fe6011e6781fa31166ad6d224f0e24732111` |
| 2026-11-10: `V3BonusVault` implementation (review closure: `lpSettled`, dead / missed-after rule; built from 14104db) | `0xFC95A85622E68EDd006E380dB8dE458F0BB7f9C2` | 12104215 | `0x0e6c6e4d63ea317a41578c831d31c644c4c14365cccbbdcd935bc021df79634a` |
| 2026-11-10: `LPStakingVault` implementation (review closure: `listenerMissedAt`, fail-closed listener `onRebalance`, `setBonusListener` vault check; built from 14104db) | `0x5517F740a223808756f9CbDd25233BE46f840D73` | 12104217 | `0x85456262e26d75a1f454fbad61a0195935f5df887d4ebcfaa16df3f3e04acd8c` |
| 2026-11-10: timelock `scheduleBatch` (2 calls: bonus vault then vault `upgradeToAndCall(<impl>, 0x)`, tag `v3-review-closure`, id `0x29ebca62…efb8`) | | 12104236 | `0x0a5a5ddd4c993f3b9f8a662ada94f4a55f9c9ab26a6eaa152ebf89eb46623aec` |
| 2026-11-10: timelock `executeBatch` (two `Upgraded` events) | | 12104265 | `0x513c575e69b674188f2973f74ef6312c1af371109ab104f2368ebc7c0868df6e` |
| 2026-11-10: `V3BonusVault.reconcileLp(234214)` from the deployer -> `LpBonusForfeited(234214, B, 235.314762005877517222)` | | 12104270 | `0x0862b0256b4148576fdb58a0061d247fe32aad93c51b0e244ac0bfb33ee76730` |
| 2026-11-10: `WeightedStakingPoolV3` implementation (no principal penalty; built from 62f6165) | `0x2E7b8ACaE6e746371F2822A83A052e3eA579860A` | 12104529 | `0x8dc4e15b7cba9cca5b29089efedee6621e170646de4ef979d1cc9aeebd2f12b2` |
| 2026-11-10: timelock `schedule` pool `upgradeToAndCall(0x2E7b…860A, 0x)` (tag `v3-pool-no-penalty`, id `0x509e4c2b…df07`) | | 12104548 | `0xf1a62d8af73045335ae238fd7638972d68186d4a765cc66de0c01736e61d0745` |
| 2026-11-10: timelock `execute` (pool `Upgraded`) | | 12104575 | `0x0d8374fe444ae33f3a10c976b3186e7449d1a0d8c82d7e7896331e55df421e4d` |
| 2026-11-10: `WeightedStakingPoolV3` implementation (the minimal pool; built from bd31c48) | `0x2a486D9d9652f1436f1FaFf03b00FE93a4F60316` | 12104969 | `0xd8aaf8053588e3b8bb5ebefca6681a52569c316eddf89ad2c0106be0bc18883f` |
| 2026-11-10: `StakingMigrator` implementation (`TransitionVoucher` without `weight`; built from bd31c48) | `0x0c1522dE805cE814F776086Fa4B6dBfcEadFeB77` | 12104972 | `0x7d8d584ed4ae058ee2ee850379ef1758c2ca2a435f35d359b57000d34e42f17b` |
| 2026-11-10: timelock `scheduleBatch` (2 calls: pool then migrator `upgradeToAndCall(<impl>, 0x)`, tag `v3-minimal-pool`, id `0x0677e6ea…9fb9`) | | 12105001 | `0x526320429a8ebbb5e841ab84c1208e4bdb7ef09f22b36677b5e060df565dbd1a` |
| 2026-11-10: timelock `executeBatch` (two `Upgraded` events) | | 12105028 | `0x31c60f220690c43623a3b93522a5352a7947acea86450d946b6408b79d127076` |
| 2026-11-10: `WeightedStakingPoolV3` implementation (the two Low fixes: `BonusVaultLocked`, surplus-only `recoverERC20`; built from 8554d43 = ed33613 code; 9,840 B) | `0x6180487Bb4C0F7fCD63Fca79A45BBa27C0301A72` | 12105041 | `0x670be719c6d7428b65e1b49718cab97b540a5d67fc50901bfe0d375a37996f93` |
| 2026-11-10: timelock `schedule` pool `upgradeToAndCall(0x6180…1A72, 0x)` (tag `v3-pool-low-closure`, id `0x94888a62…979a`) | | 12105052 | `0x0a9ab2329237592d2fb46840d88b923dd12e6dbad492cdb37f08223f3bc31da5` |
| 2026-11-10: timelock `execute` (pool `Upgraded`; read back: links, window, `totalStaked` and the four stakes unchanged; `setBonusVault(0)` from the timelock reverts `BonusVaultLocked(0x7203…5221, 1794503412)`; `recoverERC20($ASSET, 1)` reverts `SurplusExceeded(1, 0)`, pool balance = `totalStaked`) | | 12105079 | `0x22f4794e642ecffbb8c49234961eded81bcfdd409a70a6946f32cf9ff14f7d65` |
| 2026-11-11: `V3BonusVaultRetired` implementation for the first bonus vault (test stack only) | `0x37a6ed1343Ec965e401801bD91678f494874d03a` | 12112222 | `0x930c03a330bb8591fea85e0fab02c8c6064dc2f27bf760a48fb523aa8ec2efab` |
| 2026-11-11: timelock `schedule` `V3BonusVault(0x7203…5221).upgradeToAndCall(0x37a6…d03a, 0x)` (id `0xf6007888…cfd8`) | | 12112225 | `0xcf6f65ff22d20de6eeac37aa7038f06938be67115ec463b0da322acb8e61670e` |
| 2026-11-11: timelock `execute` (the first bonus vault now reports `totalLpReserved()` 0) | | 12112252 | `0x9e47c57cb648ba1ba98320c3a7b0790700fb372537a3bfa726f165c2769c2980` |

Parameters: v3 activation 1794244212 (2026-11-09 17:10:12 UTC), end = bonus unlock 1794503412
(2026-11-12 17:10:12 UTC); `rewardsWaived = true`; `maxTotalReserved` 100,000 tREAL; weight and
migrator signer = the deployer (the backend's key is rotated in later by the operator); rates
1000 / 1000 / 500 bps; valuation window 1,800 s. sw2-test: activation 1794244008, end
1794247608, signer = the deployer. The batch, executed in this order: 3x `acceptOwnership`,
`pool.setMigrator`, `bonusVault.setMigrator`, `vault.upgradeToAndCall(0xDa50…D09c, 0x)`,
`vault.setBonusListener(bonusVault)`, `vault.setStakeOperator(migrator, true)`. Read back after
it: the three proxies' `owner()` = the timelock and `pendingOwner()` = 0; the vault's ERC-1967
slot = `0xDa50…D09c` (previous `0x5Ffee21075634aD6DC541EC66F8C169888602283`), its owner,
operator and guardian unchanged; `bonusListener()` = the bonus vault; `isStakeOperator(migrator)`;
`pool.migrator()`, `bonusVault.migrator()/pool()/vault()` as wired; `compoundPaused()` true
until the unpause; `rewardsWaived()` true. Before the unpause `usdcInAsset(1 tUSDC)` = 3.5252
tREAL (the 1,800 s mean tick served).

**The rehearsal** (`scripts/v3-rehearsal.js`, three wallets: A = the deployer, B =
`0x4C90A72Fc1f0f9CEC6434CA0db95b20f1B863796`, C = `0x70d9A745F9814816Fc1895d8D017aA3811825e27`,
each B and C funded with 0.05 ETH, 20,000 tREAL, 2,000 tUSDC). Each staked 10,000 tREAL in
sw2-test at weight 1500 (blocks 12098908-12), unstaked after the end (blocks 12099198-200:
rewards 335.672514 / 333.333333 / 330.994152 tUSDC), then ran one route with a TransitionVoucher
(nonce 1, weight 1500):

| Wallet | Route, tx | Result read back |
|---|---|---|
| A | `compound(335.672514 tUSDC, 10,000 tREAL, minAssetOut 1,147.81)`, block 12099207, `0xdd207076cc0a7519bff0be6da40d7073c44bc9e2acd1a3c1cc23618cd4a28986` | bought 1,179.170 tREAL (TWAP value 1,183.309); v3 stake 11,179.170; `reservedOf` 1,117.917 = 10 % |
| B | `moveToLp(333.333333 tUSDC, 10,000 tREAL)`, block 12099208, `0x28878643a36ceeb0a2c3eb04afeeb584d9fd07d126bcf3d5b68653c62ea4e6eb` | tokenId 234214 on -295860 .. -281940, `stakerOf` = B; LP leg 1,178.084 tREAL + 333.333333 tUSDC; `lpReservation` 235.315 = 10 %; v3 stake 8,821.916, `reservedOf` 882.192 = 10 % |
| C | `claimRestake(10,000 tREAL)`, block 12099209, `0x58d4fb165cf6889b951a63ae76244db8861cec16fff06e2fce8ac8437d2bef51` | v3 stake 10,000; `reservedOf` 500 = 5 %; tUSDC stayed in the wallet |

`migrated()` true for all three, `totalReserved()` 2,735.423 tREAL (`totalLpReserved` 235.315).
C's early `withdraw(1 tREAL)` (block 12099212, `0x4187b9e844267502a4ef218d0b757d592efa923c3d1ba4519179634d0348234a`):
`BonusForfeited(C, 500)`, `reservedOf(C)` = 0, `totalReserved` 2,235.423; penalty 0.4937 tREAL
(the v2 penalty the first v3 implementation still carried; removed by the decision of 2026-11-10,
see "Pool upgrade on stack #6" below).

**Open finding: the listener runs out of gas on Sepolia.** B's `rebalance(234214)` to
-288780 .. -285180, no swap (block 12099214, `0xf8406bc0c085fffb6da13e08b37074766c063a9abfb105b36c37aa33a4031f6a`)
succeeded and minted 234216 for B, but emitted `BonusListenerFailed(234214)`: the reservation
(235.315 tREAL) stayed under the burned id 234214 and nothing moved to 234216. Cause, measured by
`eth_call` of `onRebalance` from the vault on the state of block 12099213: it reverts with empty
data at 250,000 gas (`BONUS_LISTENER_GAS`) and succeeds at 1,000,000; `eth_estimateGas` 399,311.
Sepolia's gas costs are now about ten times the earlier ones (a plain ETH transfer used 204,600
gas), and the fork suite passed at its older pinned block. `reconcileLp(234214)` (anyone may call
it) would forfeit B's LP reservation; it was NOT called. Stopped here: no claim, no further step.

**Resolved (2026-11-10).** The vault proxy now runs `0x2eBABFe60b962D229fb7d1259984cFa6703886Ba`
(previous `0xDa50…D09c`), activated through the timelock with `upgradeToAndCall(<impl>, 0x5cd8a76b)`:
scheduled 11:20:12 Sofia (09:20:12 UTC, block 12103703), executed 11:25:36 Sofia (09:25:36 UTC,
block 12103729, gas 195,050). `prepareUpgrade` validated the layout against the stack #6 proxy and
`validate-upgrade-safety.js --network sepolia` passed. Read back after the execute: the ERC-1967
slot = `0x2eBA…86Ba`; `bonusHookGas()` 400,000, `bonusListenerGas()` 1,000,000,
`bonusHookGasFloor()` 411,349, `bonusListenerGasFloor()` 1,020,873; `bonusListener()` = the bonus
vault, `bonusEscrow()` `0xcd15…CaC1`, `owner()` = the timelock, operator `0x5576…8A35` and guardian
`0x2b98…BEA` unchanged; `isStakeOperator(migrator)` true; `stakerOf(234216)` = B.

`measure-hook-gas.js`, before (block 12103676, 11:13:48 Sofia, 09:13:48 UTC) and after (block
12103734, 11:26:36 Sofia, 09:26:36 UTC) the upgrade:

| Contract | Hook | tokenId | Estimate before | Allowance before | Verdict before | Estimate after | Allowance after | Verdict after |
|---|---|---|---|---|---|---|---|---|
| `BonusEscrow` | `onUnstake` | 233319 | 61,186 | 100,000 (1.63x) | OK | 61,186 | 400,000 (6.54x) | OK |
| `BonusEscrow` | `onRebalance` | 233319 | 318,754 | all gas | fail closed | 318,827 | all gas | fail closed |
| `V3BonusVault` | `onUnstake` | 234214 | 75,901 | 250,000 (3.29x) | OK | 75,901 | 1,000,000 (13.18x) | OK |
| `V3BonusVault` | `onRebalance` | 234214 | 339,336 | 250,000 (0.74x) | FAIL (out of gas) | 339,409 | 1,000,000 (2.95x) | OK |

The proof on chain, with a fresh LP reservation (`v3-rehearsal.js` actions `fund-d`, `move-d`,
`rebalance-d`; D never staked in sw2-test, its TransitionVoucher signed by the deployer: route 2,
eligiblePrincipal 10,000 tREAL, eligibleReward 300 tUSDC, nonce 1, weight 1500). A's balances
before funding D: 6.6665 ETH, 6,477,692.24 tREAL, 585,509.69 tUSDC. D's `moveToLp` (11:31:36
Sofia, gas 3,369,925) minted tokenId 234225 on -295860 .. -281940 with 1,060.276 tREAL + 300 tUSDC,
restaked 8,939.724 tREAL in v3 (`v3Bonus` 893.972) and reserved `lpBonus` 211.688 tREAL;
`totalLpReserved` 447.003. D's `rebalance(234225)` to -288780 .. -285180, no swap (11:32:00 Sofia,
09:32:00 UTC, block 12103759, gas used 1,247,912 of a 2,624,947 limit) minted 234226 and emitted
`LpBonusMoved(234225, 234226, D, 211.688153, 106.027584)` and NO `BonusListenerFailed`:
`lpReservation(234226)` = D, 106.028 tREAL (scaled to the tREAL-only band); `lpReservation(234225)`
deleted; `totalLpReserved` 447.003 -> 341.342 (down by exactly 211.688 - 106.028); `stakerOf(234226)`
= D. Afterwards `totalReserved` 3,235.423 tREAL, bonus vault balance 20,000 tREAL. B's stranded
reservation under 234214 (235.315 tREAL) is untouched; `reconcileLp(234214)` was NOT called here
(it was called after the upgrade, block 12104270, see the next section).

### Upgrade of the stack #6 bonus vault and vault (done 2026-11-10)

The 2026-11-10 fix and its review closure (audit notes items 19 and 20: the listener's
`onRebalance` fails closed; the vault records `listenerMissedAt`; `setBonusListener` checks the
listener's `vault()`; the bonus vault pays an LP record that is settled, missed-after or held, never
a dead one) replaced both implementations on Sepolia stack #6 in ONE timelock batch (the new bonus
vault reads `listenerMissedAt`, which only the new vault has). Neither upgrade needed a
reinitializer: `V3BonusVault` only APPENDS `lpSettled` (zero = not settled) and the vault only
APPENDS `listenerMissedAt` (slot base + 9; zero = never missed); the vault's hook gas slot was
already set, so `deploy-implementation.js` printed `data` = `0x` for both. `prepareUpgrade`
validated both layouts against the live proxies and `validate-upgrade-safety.js --network sepolia`
passed. Done by the deployer `0x5576…8A35` from HEAD 14104db, all transactions in the stack #6 table
above:

1. Implementations deployed with `deploy-implementation.js`: `V3BonusVault` `0xFC95A85622E68EDd006E380dB8dE458F0BB7f9C2`
   (13:04:36 Sofia, 11:04:36 UTC, block 12104215; 13,634 B runtime) and `LPStakingVault`
   `0x5517F740a223808756f9CbDd25233BE46f840D73` (13:05:00 Sofia, 11:05:00 UTC, block 12104217; 20,076 B).
2. Timelock batch (`LPTimelock` `0xf2F6…1E20`, 300 s, tag `v3-review-closure`, id
   `0x29ebca621fe7c3b42894ba92e3af9b297cc43e910f2d4b0903c0a1942e9fefb8`), in this order:
   `V3BonusVault(0x7203…5221).upgradeToAndCall(0xFC95…f9C2, 0x)`, then
   `LPStakingVault(0x4B2f…2eac).upgradeToAndCall(0x5517…0D73, 0x)`. Scheduled 13:08:48 Sofia
   (11:08:48 UTC, block 12104236, gas 261,950); executed 13:14:36 Sofia (11:14:36 UTC, block
   12104265, gas 104,536).
3. `V3BonusVault.reconcileLp(234214)` as a plain transaction from the deployer, 13:15:36 Sofia
   (11:15:36 UTC, block 12104270, gas 80,940): `LpBonusForfeited(234214, B, 235314762005877517222)`.

```json
[
  { "target": "V3BonusVault",   "fn": "upgradeToAndCall", "args": ["<new V3BonusVault impl>", "0x"] },
  { "target": "LPStakingVault", "fn": "upgradeToAndCall", "args": ["<new LPStakingVault impl>", "0x"] }
]
```

Read back after the execute: the ERC-1967 slots = `0xFC95…f9C2` (bonus vault, previous
`0xB395…1478`) and `0x5517…0D73` (vault, previous `0x2eBA…86Ba`); vault `bonusHookGas()` 400,000,
`bonusListenerGas()` 1,000,000, `bonusListener()` = the bonus vault, `bonusEscrow()` `0xcd15…CaC1`,
`owner()` = the timelock, operator `0x5576…8A35` and guardian `0x2b98…BEA` unchanged,
`isStakeOperator(migrator)` true, `listenerMissedAt(234214)` = 0 and `listenerMissedAt(234226)` = 0;
bonus vault `vault()`, `pool()`, `migrator()`, `owner()` unchanged, `totalReserved()`
3,235.423338696820762992 tREAL, `totalLpReserved()` 341.342345619663348615, `lpSettled(234214)` and
`lpSettled(234226)` false, `claimable(B)` 0 (before the unlock).

Read back after the reconcile: `lpReservation(234214)` = B, amount 0, unlock 1794503412, not claimed,
forfeited; `totalLpReserved()` 106.027583613785831393 tREAL (= D's record `lpReservation(234226)`,
active, `stakerOf(234226)` = D); `totalReserved()` 3,000.108576690943245770 tREAL (down by exactly
235.314762005877517222); `claimable(B)` 0.

`measure-hook-gas.js` before (block 12104201, 13:01:48 Sofia, 11:01:48 UTC) and after (block
12104272, 13:16:00 Sofia, 11:16:00 UTC); allowances 400,000 / 1,000,000 both times:

| Contract | Hook | tokenId | Estimate before | Verdict before | Estimate after | Verdict after |
|---|---|---|---|---|---|---|
| `BonusEscrow` | `onUnstake` | 233319 | 61,186 (6.54x) | OK | 61,186 (6.54x) | OK |
| `BonusEscrow` | `onRebalance` | 233319 | 318,827 | fail closed (no stipend) | 318,827 | fail closed (no stipend) |
| `V3BonusVault` | `onUnstake` | 234226 | 76,316 (13.10x) | OK | 75,935 (13.17x) | OK |
| `V3BonusVault` | `onRebalance` | 234226 | 338,486 | fail closed (no stipend) | 342,304 | fail closed (no stipend) |
| `V3BonusVault` | `onUnstake` | 234214 | 76,316 (13.10x) | OK | (forfeited, not measured) | |
| `V3BonusVault` | `onRebalance` | 234214 | 339,409 | fail closed (no stipend) | (forfeited, not measured) | |

D's record under 234226 (106.028 tREAL) is untouched and pays at the unlock (12 Nov 19:10 Sofia,
17:10 UTC) while D stays staked.

### Pool upgrade on stack #6 (no principal penalty): done 2026-11-10

This section and the next describe the first v3 set, retired on 2026-11-11 (the current set is in
"Staking v3 on stack #6, second set" above). The first set's v3 pool
`0xB8F5aE06567E657F781eC7EB049E5c62646bfcb9`, then the live one, ran v2's early-withdrawal penalty
under its first implementation `0x19499B535E6F8A2200fA466Ef9BEFd04D5027E06`. The new implementation
`0x2E7b8ACaE6e746371F2822A83A052e3eA579860A` (built from 62f6165) removes it (audit notes item 19,
"Decision of 2026-11-10"). Deployed with `deploy-implementation.js` (block 12104529, 14:07 Sofia,
12:07 UTC); `prepareUpgrade` validated it against the deployed layout and
`validate-upgrade-safety.js` printed "storage layout is a legal successor" for the pool. ONE timelock
operation `upgradeToAndCall(0x2E7b…860A, 0x)`, tag `v3-pool-no-penalty`, id
`0x509e4c2b6eb372a7ac2dc71d16329402d85a5c450684764c3668fcd1f746df07`: scheduled in block 12104548
(14:11 Sofia, 12:11 UTC), executed in block 12104575 (14:17 Sofia, 12:17 UTC). No reinitializer: the
layout is unchanged. Read back after it: the ERC-1967 slot = `0x2E7b…860A`; `owner()` = the
timelock; `migrator()`, `bonusVault()`, `signer()` (the deployer) and `rewardsWaived()` (true)
unchanged; `totalStaked()` 38,939.809930771574143787 tREAL and the four stakes (A 11,179.170023,
B 8,821.915741, C 9,999.000000, D 8,939.724166 tREAL) identical to the read before the upgrade;
`totalPenalized()` stays 0.493729166666666666 tREAL (C's rehearsal penalty, never grows again);
`PENALTY_RECEIVER()` and `getCurrentPenaltyPct()` now revert.

### Upgrade of the stack #6 v3 pool and migrator (the minimal v3 pool and the voucher without weight): done 2026-11-10

Done 2026-11-10 by the deployer `0x5576…8A35` from bd31c48 (the review fixes of ed33613, the
bonus vault lock and the surplus `recoverERC20`, are NOT in these implementations; they went live
in a second pool upgrade at block 12105079, 15:58 Sofia, 13:58 UTC, tag `v3-pool-low-closure`), all
transactions in the stack #6 table above. Implementations deployed with `deploy-implementation.js`:
pool `0x2a486D9d9652f1436f1FaFf03b00FE93a4F60316` (15:36:48 Sofia, 13:36:48 UTC, block 12104969;
9,609 B runtime) and migrator `0x0c1522dE805cE814F776086Fa4B6dBfcEadFeB77` (15:37:24 Sofia, 13:37:24
UTC, block 12104972; 21,446 B); `prepareUpgrade` validated both against the live proxies and
`validate-upgrade-safety.js --network sepolia` passed ("storage layout is a legal successor" for
both). ONE timelock batch, tag `v3-minimal-pool`, id
`0x0677e6ea74c7614462c3d4f0d8c16acaaad3f77ff256e3b09aa4096fe7839fb9`: scheduled 15:43:12 Sofia
(13:43:12 UTC, block 12105001, gas 261,950), executed 15:48:36 Sofia (13:48:36 UTC, block 12105028,
gas 104,538; `Upgraded` on the pool, then on the migrator). Read back after it: ERC-1967 slots =
`0x2a48…0316` (pool) and `0x0c15…eB77` (migrator); `owner()` = the timelock on both; pool
`signer()` and migrator `signer()` = the deployer, `migrator()` = `0x2e72…c493`, `bonusVault()` =
`0x7203…5221` on both, `stakingPool()` = the v3 pool, `activationEpoch()` 1794244212, `endEpoch()`
1794503412; `totalStaked()` 38,939.809930771574143787 tREAL and `stakes(user)` (one value) A
11,179.170023359140263473, B 8,821.915741301426174657, C 9,999, D 8,939.724166111007705657 tREAL,
identical to the read before; pool `nonces(A..D)` 0; migrator `isNonceUsed(A..D, 1)` true,
`migrated(A..D)` true; `compoundPaused()` false; `usdcInAsset(1000000)` 3.522019 tREAL;
`TRANSITION_VOUCHER_TYPEHASH()` `0x6ab4f966…dbd4` = keccak256 of the six-field type; the six-argument
`voucherDigest` answers and the old seven-argument one reverts; `rewardsWaived()`,
`totalPenalized()`, `getPendingReward(address)` and `getUserMultiplier(address)` revert.

The record of the plan as it was written before the upgrade:

The first set's v3 pool proxy
`0xB8F5aE06567E657F781eC7EB049E5c62646bfcb9` (implementation `0x2E7b8ACaE6e746371F2822A83A052e3eA579860A`)
moves to the minimal pool of 2026-11-10, and the first set's migrator proxy
`0x2e72f57f494daDc9fA266a518361F103cD1fc493` (implementation `0x33c9d0298D99aa801Bfc9B0bc540F65E8e7F6E70`)
to the `TransitionVoucher` without `weight`. The two MUST move in ONE timelock batch: the old
migrator calls `stakeFor(address,uint256,uint256)`, which the new pool no longer has, and the new
migrator calls `stakeFor(address,uint256)`, which the old pool does not have, so an upgrade of one
without the other breaks routes 1, 2 and 3 until the second lands.

```bash
# 1. the two implementations (the migrator's constructor arguments are read back from the proxy)
IMPL_TARGET=WeightedStakingPoolV3 npx hardhat run scripts/deploy-implementation.js --network sepolia
IMPL_TARGET=StakingMigrator       npx hardhat run scripts/deploy-implementation.js --network sepolia

# 2. ONE timelock batch, two calls, no reinitializer (data 0x): neither layout changes
#    [
#      {"target": "WeightedStakingPoolV3", "fn": "upgradeToAndCall", "args": ["<newPoolImpl>", "0x"]},
#      {"target": "StakingMigrator",       "fn": "upgradeToAndCall", "args": ["<newMigratorImpl>", "0x"]}
#    ]
TIMELOCK_ACTION=schedule-batch TIMELOCK_BATCH=<file> TIMELOCK_SALT_TAG=v3-minimal-pool \
  npx hardhat run scripts/lp-timelock.js --network sepolia
TIMELOCK_ACTION=execute-batch  TIMELOCK_BATCH=<file> TIMELOCK_SALT_TAG=v3-minimal-pool \
  npx hardhat run scripts/lp-timelock.js --network sepolia
```

No reinitializer on either proxy: the pool keeps every old field in place as a deprecated slot (it
is never written again; `totalPenalized` keeps C's 0.4937 tREAL, `rewardsWaived` keeps `true`, the
weight fields of A, B, C and D keep their values, all unread), and the migrator's storage is
untouched (only the calldata struct `Voucher` and the typehash change). The EIP-712 domains stay
("WeightedStakingPool" / "1" on the pool, "StakingMigrator" / "1" on the migrator), so the per-user
nonces continue. Read back after the batch: both ERC-1967 slots, `owner()` = the timelock on both,
`totalStaked()` and `stakes(A|B|C|D)` equal to the read before (the four principals above),
`migrator()` / `bonusVault()` / `signer()` unchanged, `TRANSITION_VOUCHER_TYPEHASH()` = keccak256 of
the six-field type, and the old getters (`getUserMultiplier`, `rewardsWaived`, `totalPenalized`)
reverting. From the batch on, the backend signs the new `TransitionVoucher` (six fields) and the
pool's `StakeVoucher`; a voucher of the old shape fails `InvalidVoucherSignature`.

### Measuring the hook gas (`scripts/measure-hook-gas.js`, Glamsterdam fix, audit notes item 20)

The vault calls the ApeBond `BonusEscrow.onUnstake` and the staking v3 listener's `onUnstake`
inside `try` with a gas allowance, and a hook that runs out of it fails OPEN: the exit completes and
the bonus is silently not forfeited (only `BonusHookFailed` / `BonusListenerFailed` says so). Both
`onRebalance` calls fail CLOSED with all the remaining gas (the listener's since 2026-11-10; it
failed open with the allowance before, which is how 234214 was stranded): they cannot fail
silently, their cost is gas the rebalance carries, and the script prints them as "fail closed (no
stipend)". Glamsterdam (EIP-8037, on Sepolia since
2026-10-06, on mainnet at a date not yet set) makes a new storage slot about ten times dearer, so
the allowances are owner-set since this fix: `setBonusHookGas(escrowGas, listenerGas)`, each
100,000..3,000,000, defaults 400,000 / 1,000,000 (`initialize` on a new vault, `initializeV2()` in
the upgrade of a live one). The script measures what the hooks really cost on the live chain,
read-only, and prints them next to the allowances:

```bash
npx hardhat run scripts/measure-hook-gas.js --network sepolia
npx hardhat run scripts/measure-hook-gas.js --network mainnet
# optional: MEASURE_VAULT, MEASURE_ESCROW, MEASURE_LISTENER, MEASURE_ESCROW_TOKEN_IDS=1,2,
#           MEASURE_LISTENER_TOKEN_IDS=3, MEASURE_FROM_BLOCK, MEASURE_MAX_IDS (3)
```

For each live reservation (found from the escrow's `BonusReserved` / `BonusMoved` and the
listener's `LpBonusReserved` / `LpBonusMoved`, newest first) it sends `eth_estimateGas` of each
hook with the VAULT as the sender (a node simulates any sender, nothing is signed or sent) and an
`eth_call` with the gas limit set to exactly the allowance. `onRebalance` gets the position as
staked (from the position manager, or from the vault's `Staked` / `Rebalanced` event when the NFT
is burned) and a tokenId nobody uses as the new id, so it writes a NEW reservation row. The
estimate includes the 21,000 intrinsic gas and the calldata, so it overstates the hook's need.
Verdict per row: OK at 1.5x or more, LOW from 1x, FAIL below; a LOW or FAIL row means
`setBonusHookGas` through `lp-timelock.js` BEFORE the operation. The escrow's and the listener's
`onRebalance` are fail closed (all remaining gas, no allowance) and are printed for the record.

Run it: before every mainnet operation that links, upgrades or re-sizes a hook, after every network
fork, and before every escrow or listener upgrade. The upgrade of a live vault is printed by
`deploy-implementation.js` with its reinitializer when the proxy needs it
(`upgradeToAndCall(<impl>, 0x5cd8a76b)`); `deploy-lp-staking.js` and `deploy-staking-v3.js` read
`LP_BONUS_HOOK_GAS` / `LP_BONUS_LISTENER_GAS` and print them.

```bash
# raising them on a live vault (owner tier: schedule, wait the delay, execute the same operands)
TIMELOCK_ACTION=schedule TIMELOCK_TARGET=LPStakingVault TIMELOCK_FN=setBonusHookGas \
  TIMELOCK_ARGS=400000,1000000 npx hardhat run scripts/lp-timelock.js --network mainnet
```

Measured on Sepolia, 2026-11-09 ~20:30 Sofia (block 12099306), against stack #6 still on the
pre-fix vault (allowances = the old fixed constants):

| Contract | Hook | tokenId | `eth_estimateGas` from the vault | Old allowance | At the old allowance | New default |
|---|---|---|---|---|---|---|
| `BonusEscrow` | `onUnstake` (forfeits, active reservation) | 233319 | 61,186 | 100,000 | completes (1.63x) | 400,000 (6.5x) |
| `BonusEscrow` | `onUnstake` (cliff passed, returns at once) | 234119, 234120 | 23,951 | 100,000 | completes | 400,000 |
| `BonusEscrow` | `onRebalance` (moves, new row) | 233319 | 318,754 | none: fail closed, all gas | n/a | n/a |
| `BonusEscrow` | `onRebalance` (cliff passed) | 234119, 234120 | 31,993 | fail closed | n/a | n/a |
| `V3BonusVault` | `onUnstake` (forfeits) | 234214 | 75,901 | 250,000 | completes (3.29x) | 1,000,000 (13x) |
| `V3BonusVault` | `onRebalance` (moves, new row) | 234214 | 339,336 | 250,000 | OUT OF GAS (0.74x) | 1,000,000 (2.9x) |

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
