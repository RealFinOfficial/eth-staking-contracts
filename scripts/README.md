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

## Historical Sepolia deployments

Not in `deployments.json` — these predate the 5% penalty floor and run the old
50% → 0% curve. Both pools have ended. Reach them with `POOL=<address>`.

| Address | Kind | Ended |
|---|---|---|
| `0xce6Fc294ed168FFa04C8eBA189dC3060562cdE63` | StakingPool | 2026-06-08 |
| `0xF65326EbF16195890730cAd411786374c4D9E314` | StakingPool | 2026-08-11 |
| `0x8e65d19BE4bA1CC61005B4c70f21cd179512e33f` | tREAL, 18 dec | — |
| `0x45e1Dca1B4b68f649c731B0f6FDf680F389d4213` | mUSDC mock, reports 18 dec | — |
