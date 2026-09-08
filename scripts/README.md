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

| Script | Purpose |
|---|---|
| `create-sepolia-pool.js` | Create the ASSET-USDC Uniswap V3 pool, or report the existing one. Refuses to run on mainnet |
| `deploy-lp-staking.js` | Deploy and wire the whole stack: the `LPTimelock` first, then TokenX, the two UUPS proxies (born owned by that timelock) and the zapper — plus, with `LP_APEBOND_ENABLED=1`, the `BonusEscrow` proxy (born owned by the timelock and born pointing at its adapter) and the `ApeBondPositionAdapter` in front of it. Before spending any gas it asks the Uniswap V3 **factory** whether `LP_POOL` really is the canonical pool for `(token0, token1, fee)` and refuses to deploy against anything else — the pool triple check only proves the contract CLAIMS those tokens |
| `lp-timelock.js` | Operate the timelock: `schedule`, `execute`, `cancel`, `status`, `pending` |
| `deploy-implementation.js` | Deploy ONE new UUPS implementation for a proxy that is already live, and print the two `lp-timelock.js` command lines that activate it. `IMPL_TARGET=LPStakingVault\|RewardsDistributor`, one kind per run. It sends exactly one transaction — the implementation deploy — and never calls the timelock or the proxy |
| `validate-upgrade-safety.js` | UUPS implementation safety (network-free) plus, against a committed manifest, the storage-layout check. CI runs it on every push |
| `lib/uniswap.js` | The per-chain Uniswap V3 addresses — `factory`, `positionManager`, `swapRouter02` — for chain 1 and chain 11155111. Plain Node, no network. `deploy-lp-staking.js` and `create-sepolia-pool.js` both import it, so the two cannot drift apart; `LP_FACTORY` / `LP_NPM` / `LP_ROUTER` override it, and a chain the map does not list (a local fork reports 31337) must set them |

`deploy-lp-staking.js` deploys the `LPTimelock` FIRST and both proxies are born owned by it:
`initialize` names the timelock inside each proxy's own deployment transaction, so no key ever
holds the owner tier, the run schedules nothing and waits out no delay. That works because the
one owner-only bootstrap call — `vault.setZapper(zapper)` — became an `initialize` argument. The
script predicts the zapper's CREATE address from the deployer's nonce (vault implementation at
N, vault proxy at N + 1, zapper at N + 2), passes it in, deploys the zapper, records it, and
only then asserts it landed there. If it did not, the run throws and names the repair:
`setZapper` through the timelock. Everything else already works.

Three role variables are read and all three are printed before anything is deployed.
`LP_GUARDIAN` (the hot pause key) and `LP_OPERATOR` (multisig B) are both REQUIRED and have no
defaults; the script THROWS when they are equal and WARNS when either collapses onto
`LP_MULTISIG` or onto the deploying key, which is what staging deliberately does.

What the run does NOT finish: `TokenX` and `LPZapper` are deployed deployer-owned (the deployer
has to call `setMinter` and the epoch cap) and are then NOMINATED to `LP_OPERATOR`. Being
`Ownable2Step`, the operator multisig completes each with one plain transaction —
`TokenX.acceptOwnership()` and `LPZapper.acceptOwnership()`, no timelock, no delay. The step is
skipped entirely when the operator is the deploying key.

`LP_APEBOND_ENABLED=1` adds a third proxy to exactly that flow — the `BonusEscrow`, born owned
by the timelock like the other two — and one plain `Ownable` contract, the
`ApeBondPositionAdapter`, which the deployer hands to the timelock in a single transaction. The
escrow needs its adapter's address in `initialize` for the same reason the vault needs the
zapper's (`setAdapter` is owner-tier and the owner is the timelock from birth), so the script
runs the prediction a second time: escrow implementation at nonce M, escrow proxy at M + 1,
adapter at M + 2, and it asserts the adapter landed there.

The route is deployed CLOSED: with `LP_APEBOND_PURCHASE_SIGNER` unset the adapter's signer is
`address(0)` and every `depositFor` reverts, and with `LP_APEBOND_SOULZAP_CALLERS` empty no
caller is allowlisted. Opening it is two deliberate acts afterwards — the guardian's undelayed
`setPurchaseSigner`, and the timelock's delayed `setSoulZapCaller`.

One call the run CANNOT make: `vault.setStakeOperator(adapter, true)` is owner-tier on a vault
the timelock owns from birth. The script prints the exact `schedule`/`execute` line for the
multisig and reports the missing allowlist entry as a WARN, not a failure; until it executes,
`depositFor` reverts `NotZapper` and nothing else is affected. See the env table at the top of
the script; `.env.example` carries the same block commented out.

On a stack that is ALREADY deployed the adapter is added to an EXISTING vault, and that call has
a precondition: the live proxy has to be running an implementation that HAS `setStakeOperator`.
A vault proxy deployed before this round does not, so `schedule` would be accepted by the
timelock and `execute` would revert on the proxy. Deploying and activating that implementation
is an ordinary UUPS upgrade with a runbook already written — **"Activating a new implementation
(Sepolia test stack #5)"** below. Use it as written: `IMPL_TARGET=LPStakingVault npx hardhat run
scripts/deploy-implementation.js --network <net>` for the implementation,
`scripts/validate-upgrade-safety.js --network <net>` as the gate, then the timelock's
`upgradeToAndCall`. Only once the proxy runs the new implementation does the
`setStakeOperator(adapter, true)` operation above become executable.

`hardhat run` accepts no positional arguments, so `lp-timelock.js` takes its subcommand and
operands from the environment. `schedule` and `execute` take the SAME operands — the operation
id is a hash of the whole call, so an execute that names a different argument is a different
operation rather than a typo that goes through:

```bash
TIMELOCK_ACTION=schedule TIMELOCK_TARGET=LPStakingVault TIMELOCK_FN=setGuardian \
  TIMELOCK_ARGS=0xNewGuardian npx hardhat run scripts/lp-timelock.js --network sepolia

TIMELOCK_ACTION=execute  TIMELOCK_TARGET=LPStakingVault TIMELOCK_FN=setGuardian \
  TIMELOCK_ARGS=0xNewGuardian npx hardhat run scripts/lp-timelock.js --network sepolia

TIMELOCK_ACTION=pending npx hardhat run scripts/lp-timelock.js --network sepolia
```

Owner tier, and therefore routable: `acceptOwnership`, `setZapper`, `setStakeOperator`,
`setGuardian`, `setOperator`, `setAssetClaimsEnabled`, `setAdapter`, `recoverSurplus`,
`setSoulZapCaller`, `transferOwnership`, `upgradeToAndCall`, `updateDelay`. Each is legal only
on the registry kinds `OWNER_TIER` lists for it, so a mistyped `TIMELOCK_TARGET` is refused
before anything is scheduled. The other two tiers are deliberately NOT here, because routing
them through a delay would defeat the reason they exist: the guardian tier is the three pause
switches (`setDepositsPaused`, `setRebalancePaused`, `setPaused`) plus the adapter's
`setPurchaseSigner` and `setDepositsPaused`, sent directly by the hot key; the operator tier is
`setTwapParams`, `rescuePosition`, `setSigner`, `recoverExcessAsset` — plus those same three
pauses as the cold fallback, and `setGuardian` — sent directly by the operator multisig.
`setTwapParams` used to be owner-tier and left this list on 2026-09-09; scheduling it now would
revert `OwnableUnauthorizedAccount` after the full delay.

`setGuardian` is the one call that is on BOTH sides. It stayed routable here because the owner
can still send it, but since 2026-09-14 it is owner OR operator ON THE TWO PROXIES, so a
revocation that cannot wait is sent DIRECTLY by the operator multisig: `setGuardian(address(0))`
removes a compromised hot key in one transaction and leaves the guardian tier vacant, in which
state only the operator can pause. A live address in the same call appoints a replacement.
`setOperator` did not move and is still owner-only, so the operator cannot rotate itself. The
ApeBond adapter's own `setGuardian` did not move either — it is owner-only there and rejects
`address(0)`.
The salt is derived from the call (`keccak256(abi.encode("real.lp.timelock.v1", target,
keccak256(calldata), tag))`), which is why the two commands above need no shared secret; an
identical call cannot be scheduled twice, so a repeat needs `TIMELOCK_SALT_TAG=<something-new>`.
The full runbook is in `docs/lp-staking-audit-notes.md` item 14.

### Activating a new implementation (Sepolia test stack #5)

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
   create six new entries if it were run for this.

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
| `check-coverage.mjs` | The blocking coverage gate: per-file line and branch floors for the six LP contracts and `libraries/TwapGuard.sol` |
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
