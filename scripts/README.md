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
| `LP_DEPLOYER_IMPERSONATE` | The ADDRESS every state-changing script should send from, played WITHOUT its private key by impersonating it on the node. **Chain 31337 only** — on any other chain id the run stops with an error instead of sending, because there the transaction would be signed by whatever key the network config holds and would therefore come from a different account than the one named |
| `LP_REHEARSAL_CALLER_IMPERSONATE` | The same thing for the one wallet `apebond-rehearsal.js` does not take from `getSigner()`: the SoulZap seat. Same 31337-only rule, same refusal elsewhere, and mutually exclusive with `LP_REHEARSAL_CALLER_KEY` |

The two impersonation variables exist for the ApeBond fork dry-run (below). They are read in
`scripts/lib/pools.js:impersonatedSignerFromEnv`, which checks the chain id first, then calls
`hardhat_impersonateAccount`, then tops the account up with `hardhat_setBalance` only when it
holds less than 1 ETH — a forked account usually carries real ETH already, and overwriting a
balance that is sufficient would erase a fact the run may be asserting.

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
| `lp-timelock.js` | Operate the timelock: `schedule`, `execute`, `schedule-batch`, `execute-batch`, `cancel`, `status`, `pending` |
| `deploy-implementation.js` | Deploy ONE new UUPS implementation for a proxy that is already live, and print the two `lp-timelock.js` command lines that activate it. `IMPL_TARGET=LPStakingVault\|RewardsDistributor`, one kind per run. It sends exactly one transaction — the implementation deploy — and never calls the timelock or the proxy |
| `deploy-apebond.js` | Activate the ApeBond route on a stack that is ALREADY deployed: a new vault implementation, the `BonusEscrow` proxy and the `ApeBondPositionAdapter`, then ONE timelock batch that upgrades the proxy and allowlists the adapter in that order. Every phase reads the chain first and skips what is already there, so an interrupted run is resumed by running the same command again. `LP_APEBOND_MODE` also offers `replace-adapter` (swap the adapter, keep the escrow) and `upgrade-vault` (the plain upgrade, nothing ApeBond-shaped touched) |
| `set-purchase-signer.js` | GUARDIAN tier: point `ApeBondPositionAdapter.purchaseSigner` at the backend key that signs purchases, which is what OPENS the deposit path `deploy-apebond.js` deliberately leaves closed. Takes the address (`LP_APEBOND_PURCHASE_SIGNER`) or the private key it belongs to (`LP_APEBOND_PURCHASE_SIGNER_KEY`, never printed). Checks the tier on chain and names it rather than reverting, sends nothing when the signer is already that address, and refuses `address(0)` — which closes the route outright — unless `LP_APEBOND_ALLOW_CLOSE=1` |
| `fund-escrow.js` | Transfer the escrow's own `bonusToken()` into the `BonusEscrow` proxy. A plain ERC-20 transfer, because the escrow has no funding function: what makes a reservation possible is the proxy's balance covering `totalReserved`. `LP_APEBOND_FUND_AMOUNT` sends exactly that much; `LP_APEBOND_FUND_TARGET` tops the FREE balance (`balance - totalReserved`) up to that much and sends nothing when it is already there, so the same command is safe to repeat. Prints both sides' balances before and after, and refuses an amount the sender cannot cover |
| `apebond-rehearsal.js` | The live rehearsal, TEST STACKS ONLY (it refuses chain 1 with no `CONFIRM` escape). `LP_REHEARSAL_PHASE=deposit` mints the campaign's position from the wallet playing the SoulZap seat, builds and signs the 14-field `PurchaseAuthorization`, calls `depositFor`, and asserts the vault has custody, the BENEFICIARY is the credited staker, the escrow holds a matching unclaimed reservation and `ApeBondPositionDeposited` is in the receipt. `LP_REHEARSAL_PHASE=claim`, after the cliff, claims the bonus from a wallet that is NOT the beneficiary and asserts the beneficiary's balance grew by exactly the bonus. Writes `apebond-rehearsal-<chainId>.json` beside the registry, which is what lets the two phases run in different shells on different days |
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
`LP_MULTISIG` or onto the deploying key, which is what the test stack deliberately does.

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
timelock and `execute` would revert on the proxy. The upgrade and the allowlist entry therefore
have to be ONE timelock batch, in that order, and `scripts/deploy-apebond.js` is the script that
builds it — see **"Activating ApeBond on an existing stack (Sepolia test stack #5)"** below. It
does the whole thing in one command: the new implementation (through the very same
`deploy-implementation.js` code), the escrow and the adapter, the wiring, the batch, the wait and
the execute, then the post-checks and the registry. Nothing about it is a second copy of the
fresh-stack script — it reuses that script's own `deployContract` and `deployProxyPair`, so both
paths produce the same shapes.

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

`schedule-batch` and `execute-batch` send SEVERAL owner-tier calls as ONE operation, which the
timelock runs in order, all or nothing. The calls come from a JSON file named by
`TIMELOCK_BATCH` — an array of `{target, fn, args}`, where `target` is a registry kind or a raw
address and `args` is an array in the function's own order:

```json
[
  { "target": "LPStakingVault", "fn": "upgradeToAndCall", "args": ["0xNewImpl", "0x"] },
  { "target": "LPStakingVault", "fn": "setStakeOperator", "args": ["0xAdapter", "true"] }
]
```

```bash
TIMELOCK_ACTION=schedule-batch TIMELOCK_BATCH=./activation.json \
  npx hardhat run scripts/lp-timelock.js --network sepolia

TIMELOCK_ACTION=execute-batch  TIMELOCK_BATCH=./activation.json \
  npx hardhat run scripts/lp-timelock.js --network sepolia
```

That pair is exactly the ApeBond activation on a live vault proxy, and it has to be one
operation: `setStakeOperator` does not exist on the implementation the proxy runs before the
upgrade, so as two separate operations the second would be scheduled against code without that
function and would revert after the whole delay. The same `OWNER_TIER` table, kind check,
argument parsing and `CONFIRM=yes` rule apply per call; every value is zero and the predecessor
is zero, as for a single operation. The salt is derived the same way under its own namespace —
`keccak256(abi.encode("real.lp.timelock.v1.batch", keccak256(abi.encode(targets, payloads)),
tag))` — so a repeat again needs `TIMELOCK_SALT_TAG`. `status` and `cancel` need no batch
variant, both taking an id; `pending` lists a batch as one row with every call under it.

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

### Activating ApeBond on an existing stack (Sepolia test stack #5)

`deploy-lp-staking.js` with `LP_APEBOND_ENABLED=1` deploys the route as part of a FRESH stack.
On a stack that is already live and already holds staked positions none of that is available:
the vault proxy exists, it runs an implementation that has no `setStakeOperator`, and the only
way to give it one is an in-place UUPS upgrade through the timelock that owns it.
`scripts/deploy-apebond.js` is that second path, and this is how it is run.

The stack it is run against: vault proxy `0x6Ed8b565A61807591616e42263D91eBfA67Ddd56`, timelock
`0x591c51A6EE2ef571C44dF2339A7c92b57850C082` with a **300 second** `minDelay`, distributor proxy
`0x1D6aB18aFeF3196B4E3F883C7aD36F49b003C8DA`. All three come out of `deployments.json`, so no
command below carries an address.

1. **Prove the endpoint before anything else.** Every phase reads the chain, and a run that
   loses the endpoint halfway through leaves an implementation on chain that nothing points at.
   One read is enough to know the Infura project id in `.env` is still serving Sepolia:

   ```bash
   TIMELOCK_ACTION=pending npx hardhat run scripts/lp-timelock.js --network sepolia
   ```

   It prints the timelock's address and its `minDelay` before it does anything else, and those
   two lines are the probe. A `402` here is the company Infura key over quota — switch to the
   configured fallback endpoint rather than starting the run.

2. **Bring the indexer's stored vault ABI to 15 events FIRST — before `executeBatch`, not
   after.** This is the one step whose order cannot be recovered from. The indexer decodes a log
   by looking its `topic0` up in the ABI it has STORED for that address; a log whose `topic0` is
   not in that ABI is dropped, and it is dropped for good, because the indexer never re-reads a
   block it has already passed. The upgraded vault emits `StakeOperatorSet`, which is the
   fifteenth event and the one the fourteen-event ABI deployed before this round does not
   carry — and the very first transaction the new implementation is involved in, the
   `executeBatch` itself, emits it. Register the 15-event ABI (`abi/LPStakingVault.json` in
   this repo is that ABI), confirm the indexer reports 15, and only then run step 3.

   Every file under `abi/` is the bare `abi` array of the compiled artifact, 2-space JSON with a
   trailing newline, and there is no generator script. After a contract change, regenerate the
   file from the repo root with this one line (the argument is the contract name; the path
   assumes a contract under `contracts/lp-staking/`):

   ```bash
   npx hardhat compile && node -e 'const n=process.argv[1];require("fs").writeFileSync(`abi/${n}.json`,JSON.stringify(require(`./artifacts/contracts/lp-staking/${n}.sol/${n}.json`).abi,null,2)+"\n")' ApeBondPositionAdapter
   ```

3. **Run the script.** One command. It deploys the implementation, the escrow and the adapter,
   writes the adapter's SoulZap allowlist, hands the adapter to the timelock, schedules the
   batch, waits out the 300 seconds and executes it.

   ```bash
   LP_APEBOND_GUARDIAN=<the multisig> \
   LP_APEBOND_SOULZAP_CALLERS=<the SoulZap router> \
     npx hardhat run scripts/deploy-apebond.js --network sepolia
   ```

   `LP_APEBOND_PURCHASE_SIGNER` is deliberately left unset: the route is activated CLOSED, and
   the guardian opens it with one undelayed `setPurchaseSigner` when the campaign starts. The
   run says so as a WARN rather than a failure. `LP_APEBOND_BONUS_TOKEN` defaults to the vault's
   own `token0()`, read off the proxy.

   The run also writes `apebond-activate-batch.json` beside `deployments.json`. That file is the
   same batch in the shape `lp-timelock.js` reads, so the operation can be driven by hand if the
   script is interrupted between the schedule and the execute:

   ```bash
   TIMELOCK_ACTION=execute-batch TIMELOCK_BATCH=./apebond-activate-batch.json \
     npx hardhat run scripts/lp-timelock.js --network sepolia
   ```

   Re-running the script does the same thing and is the preferred repair: it recomputes the same
   operation id, finds it pending, waits and executes.

4. **Read the post-checks.** The run prints them and throws if any of them fails. The ones that
   matter most are the state-preservation block — `owner`, `guardian`, `operator`, `zapper`, the
   TWAP parameters, both pause flags and `stakerOf` for every id in
   `LP_APEBOND_ASSERT_POSITIONS` (NFT 231913 on this stack, by default) — plus the distributor's
   ERC-1967 implementation slot, which this run must not have moved.

5. **Commit `deployments.json`.** The run has already written it: `LPStakingVault.implementation`
   now names the new implementation, and the two new kinds `BonusEscrow` and
   `ApeBondPositionAdapter` carry their addresses, their owner and their configuration. Record
   the commit that was deployed from, so the implementation on chain can be traced back to a
   build.

6. **The backend needs nothing on a test stack.** `LP_EXPECTED_IMPLEMENTATION_VAULT` and
   `LP_EXPECTED_IMPLEMENTATION_DISTRIBUTOR` are empty on the test stacks, so nothing there pins
   an implementation and nothing raises `lp.upgrade.unexpected_implementation`. Whether mainnet
   pins them at all is still open — see the env-keys note sent to krumbgf on 2026-09-14.

7. **The route is deployed, not open.** `purchaseSigner` is `address(0)` and the escrow holds no
   bonus tokens, so nothing can be bought yet. The next section is how that is turned into a
   working campaign and proved with one real purchase.

### After the activation: opening the route (Sepolia test stack #5)

The activation leaves the route DEPLOYED and CLOSED on purpose: `purchaseSigner` is
`address(0)`, so every `depositFor` reverts, and the escrow holds no bonus tokens, so the first
purchase that got past the signature would revert at the reserve step anyway. Four commands turn
that into a proven, working campaign, in this order. Each one refuses to run when the one before
it has not happened, so the order is enforced rather than remembered.

1. **Open the deposit path.** Guardian tier — `setPurchaseSigner` carries `onlyGuardian`, not
   `onlyOwner`, so the timelock that OWNS the adapter cannot make this call at all and there is
   no scheduled route to it. Run it from the guardian key:

   ```bash
   LP_APEBOND_PURCHASE_SIGNER=<the backend key's address> \
     npx hardhat run scripts/set-purchase-signer.js --network sepolia
   ```

   `LP_APEBOND_PURCHASE_SIGNER_KEY=<the private key>` is the alternative when the operator holds
   the key itself: the address is derived from it and the key is never printed. The run reads
   `purchaseSigner()` before and after, sends nothing when it is already that address, refuses a
   contract (the adapter verifies with `ECDSA.recover`, which only ever returns an EOA), and
   refuses `address(0)` unless `LP_APEBOND_ALLOW_CLOSE=1` — because zero CLOSES the route, which
   repudiates every authorization the backend has issued and is a deliberate act.

   Rotating the signer later is the same command. Every outstanding authorization stops working
   the moment it lands, so switch the backend over in the same window.

2. **Fund the escrow.** The escrow has no funding function: a bonus can be reserved only while
   the proxy's own `bonusToken` balance covers `totalReserved` plus the new amount, so funding it
   is an ordinary ERC-20 transfer to the proxy.

   ```bash
   LP_APEBOND_FUND_TARGET=10000 npx hardhat run scripts/fund-escrow.js --network sepolia
   ```

   `LP_APEBOND_FUND_TARGET` is the FREE balance to reach — `balance - totalReserved`, which is
   what a new purchase can actually reserve against. The run sends the difference and sends
   nothing when the free balance is already there, so the command is safe to repeat and safe to
   run while purchases are landing. `LP_APEBOND_FUND_AMOUNT=10000` is the other form: send
   exactly that much, once. Either way the run prints both sides' balances before and after,
   `totalReserved` (which funding must not move, and the run fails if it did), and the free
   balance the escrow ends up with.

3. **Buy one position for real — the deposit phase.** SoulZap is not deployed on a test stack, so
   its seat is played by a wallet the operator holds, allowlisted on the adapter at activation
   through `LP_APEBOND_SOULZAP_CALLERS`. That wallet needs both pool tokens and some Sepolia ETH.

   ```bash
   LP_REHEARSAL_CALLER_KEY=<the SoulZap-seat wallet's private key> \
   LP_REHEARSAL_BENEFICIARY=<the buyer's address> \
   LP_APEBOND_PURCHASE_SIGNER_KEY=<the backend key from step 1> \
   LP_REHEARSAL_CLIFF_SECONDS=300 \
     npx hardhat run scripts/apebond-rehearsal.js --network sepolia
   ```

   Before it spends a single unit of gas the run checks the six things that have to be true — the
   caller is allowlisted, the key matches `adapter.purchaseSigner()`, neither pause flag is on,
   the vault has the adapter as a stake operator, the escrow points back at the adapter, and the
   escrow can back the bonus — and stops with all of them printed if any fails. Then it approves
   the position manager, mints the campaign's range around the pool's current tick, reads the
   minted liquidity back, signs the 14-field `PurchaseAuthorization` under the
   `RealApeBondPurchase`/`1` domain, approves the adapter for the NFT and calls `depositFor`.

   The figures are the SAMPLE campaign from `test/lp-staking/helpers/constants.js` — 10,000
   gross, 9,900 net after a 1% SoulZap fee, a 495 guaranteed bonus — overridable with
   `LP_REHEARSAL_GROSS` / `_NET` / `_BONUS` in whole tokens. The mint amounts are computed
   value-balanced at the pool's own price for the chosen range and sized to fit the caller's
   balances; `LP_REHEARSAL_AMOUNT0` / `_AMOUNT1` state them outright instead.

   Afterwards the run asserts what the purchase was supposed to produce: the position manager
   reports the VAULT as the NFT's owner, the vault credits the BENEFICIARY (not the caller) as
   its staker, `escrow.reservationOf(purchaseId)` holds the beneficiary, the bonus, the unlock
   timestamp and `claimed = false`, `claimable` is still 0 because the cliff has not passed, and
   `ApeBondPositionDeposited` is in the receipt with the same purchase id.

4. **Claim the bonus — after the cliff.** The cliff is 300 seconds on Sepolia test stack #5
   (`LP_REHEARSAL_CLIFF_SECONDS`, default 300); production is TBD with ApeBond, expected 2–3
   months. It is a FULL cliff with no vesting: the buyer's position is an NFT and cannot be
   split into time-released parts, so the whole bonus unlocks at once (decided 2026-09-15).
   Run it early and it prints the seconds remaining and exits non-zero without sending
   anything.

   ```bash
   LP_REHEARSAL_PHASE=claim npx hardhat run scripts/apebond-rehearsal.js --network sepolia
   ```

   `claim` takes no role and no permission: it is triggered here by the DEPLOYER, deliberately
   not the beneficiary, and the money still goes to the beneficiary recorded at purchase time.
   The run asserts the beneficiary's bonus-token balance grew by exactly the bonus, that
   `totalReserved` fell by exactly the same, that the reservation is marked claimed, and that a
   second claim reverts.

**The record file.** The deposit phase writes `apebond-rehearsal-<chainId>.json` beside
`deployments.json` — token id, purchase id, campaign id, the figures, the unlock timestamp and
every transaction hash — and the claim phase reads it and appends its own hash. That is what lets
the two phases run in different shells on different days with no arguments carried between them;
`LP_REHEARSAL_PURCHASE_ID` names a purchase directly when there is no record to read. Like
`apebond-*-batch.json` it is a run artifact and is gitignored: everything durable about the
deployment is already in `deployments.json`.

`scripts/apebond-rehearsal.js` REFUSES chain 1, with no `CONFIRM=yes` escape. It mints liquidity,
signs an authorization with a key read out of the environment and spends a purchase id; on
mainnet the purchase comes from SoulZap and the signature from the backend, and neither is driven
from a script in this repo.

### Rehearsing the whole sequence on a fork first (the dry-run)

The four commands above are the live day. Before running them against Sepolia test stack #5
for real, the same four can be run against a **fork of that stack**, in the same order, with
the same environment, by the same scripts — as one opt-in test:

```bash
LP_APEBOND_DRYRUN=1 \
  npx hardhat test test/lp-staking/integration/ApeBondUpgradeInPlace.test.js
```

`test/lp-staking/integration/ApeBondUpgradeInPlace.test.js` starts a
`hardhat node --fork <sepolia>` with **no `--fork-block-number`**, so the node forks the chain
head and the world it serves is stack #5 exactly as it stands right now: the vault proxy on
implementation `0xEac50B6B…`, the 300-second timelock, NFT 231913 staked by the operator, the
real tASSET/tUSDC pool and the real Uniswap Sepolia position manager. It then runs
`deploy-apebond.js`, `set-purchase-signer.js`, `fund-escrow.js` and both phases of
`apebond-rehearsal.js` as child processes against that node.

**What it proves, that no other tier can.** Every other ApeBond test builds its world out of
mocks, so what it proves is that the scripts are correct. This one proves that the LIVE STACK
can be activated by them: that the new `LPStakingVault` compiled from this branch passes the
storage-layout check against the layout recorded for the implementation the live proxy
actually runs, that the deployer key really holds both timelock roles, that the batch really
clears a 300-second `minDelay` and executes, that NFT 231913's staker survives the upgrade,
that the distributor's implementation slot does not move, and that a purchase minted on the
REAL position manager in the real campaign range lands in the vault, credits the buyer and
pays its bonus after the cliff.

**No key is used and no transaction reaches Sepolia.** The two live seats — the operator
`0x5576bD37…` and the SoulZap seat `0x2b9818c8…` — are impersonated through
`LP_DEPLOYER_IMPERSONATE` and `LP_REHEARSAL_CALLER_IMPERSONATE`, which are honoured on chain
31337 only. The only traffic the endpoint sees is the reads the fork needs to answer.

**It is NOT a CI gate, and it cannot become one.** A fork at the chain head is not
deterministic: the pool price, the operator's balances and the staked position are whatever
Sepolia holds at the minute the node starts, so a run could go red because somebody else moved
the pool. `.github/workflows/ci.yml` never sets `LP_APEBOND_DRYRUN`, so `npx hardhat test`
reports the suite as pending. Both gates are one-sided in the usual way: without the flag it
skips and says so, and with the flag AND an endpoint set it FAILS rather than skips when the
fork cannot be established.

**Nothing in the repository is written.** The children record into a scratch
`DEPLOYMENTS_FILE` — a copy of the tracked registry with the live stack's entry ALSO recorded
under chain 31337, which is what a fork is: Sepolia's state on a node that reports 31337. The
tracked `deployments.json` and the committed `.openzeppelin/sepolia.json` are compared by
sha256 before and after, `git status --porcelain -- deployments.json .openzeppelin` must be
empty, and the whole-tree `git status --porcelain` must have gained no entry over the run (so
run it on a tree nobody else is editing). The `hardhat-upgrades` manifest is safe by
construction: on a forked development node
the plugin writes to `<os.tmpdir()>/openzeppelin-upgrades/hardhat-31337-<instance>.json` and
keeps the committed `.openzeppelin/sepolia.json` as a read-only PARENT, which is exactly why
the layout check grades against the real deployed layout.

At the end the run prints one block with every address and every transaction hash it produced
on the fork. That block is the rehearsal record for the round's notes.

### Replacing the adapter, and upgrading the vault alone

The same script, with `LP_APEBOND_MODE`:

```bash
LP_APEBOND_MODE=replace-adapter LP_APEBOND_SOULZAP_CALLERS=<the SoulZap router> \
  npx hardhat run scripts/deploy-apebond.js --network sepolia

LP_APEBOND_MODE=upgrade-vault \
  npx hardhat run scripts/deploy-apebond.js --network sepolia
```

`replace-adapter` is the runbook of `docs/lp-staking-audit-notes.md` item 15, automated: the
adapter is REPLACEABLE, not upgradeable, because everything it stores is spent state and nothing
is owed at its address. It deploys a new adapter against the EXISTING escrow, wires its
allowlist, hands it to the timelock, and then runs ONE batch of three —
`setStakeOperator(old, false)`, `setStakeOperator(new, true)`, `BonusEscrow.setAdapter(new)` — so
the old adapter loses the reserve right in the same transaction the new one gains it. The new
adapter is recorded as `pendingAdapter` on the registry entry BEFORE it is activated, which is
what lets an interrupted replacement resume rather than deploy a third one; a run started after
the previous one completed is a NEW replacement and deploys another adapter, which is the point
of the command.

`upgrade-vault` is the plain UUPS upgrade as a one-call batch, with no ApeBond contract deployed
or touched. It is the same end state step 3 of "Activating a new implementation" reaches, done
in one command instead of four.

On mainnet — and on any chain where the deploying key is not the timelock's proposer AND
executor — neither mode sends the timelock transactions. The run deploys and wires everything it
can, prints the targets, the payloads, the predecessor, the salt, the operation id and the
`scheduleBatch` / `executeBatch` calldata, asserts that the vault is still exactly as it found
it, and stops. The Safe sends the two transactions.

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
