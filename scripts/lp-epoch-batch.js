// Arm the next LP epoch in ONE Safe batch of two calls, when the $ASSET funding comes later:
//
//   1. RewardsDistributor.mintRewardToken($OVTR, distributor, the epoch's $OVTR amount)
//   2. LPEpochRegistry.scheduleEpoch(id, startsAt, endsAt, tokens, amounts)
//
// The epoch may still emit $ASSET: that is allowed, because $ASSET claims start closed on chain.
// The script then prints a NOTE that the distributor must hold that $ASSET before $ASSET claims
// are opened. To fund the $ASSET in the same batch, use scripts/lp-epoch-batch-with-asset.js.
//
// This script NEVER sends a transaction, whoever the signer is, and needs no CONFIRM. It reads
// the chain, refuses what would revert, prints each call (`to`, `value: 0`, `data`) and writes the
// batch as a Safe Transaction Builder file for the operator Safe to import.
//
// It applies every check of `lp-epoch.js` with EPOCH_ACTION=schedule (the same refusals and the
// same GAP warning), and refuses besides: an epoch with no or zero $OVTR (nothing to mint: use
// lp-epoch.js), a token other than $OVTR and $ASSET in EPOCH_AMOUNTS, and a $OVTR token whose
// minter is not the distributor proxy. The mint and the `scheduleEpoch` call are simulated from
// the operator's address; a call that would revert is refused with its decoded reason.
//
// ──────────────────────── environment ────────────────────────
//
//   EPOCH_ID             the epoch id; must be epochCount + 1 (defaults to it)
//   EPOCH_STARTS_AT      unix seconds or ISO-8601 UTC (e.g. 2026-11-17T12:00:00Z)
//   EPOCH_ENDS_AT        unix seconds or ISO-8601 UTC; or EPOCH_DURATION (seconds) instead
//   EPOCH_AMOUNTS        whole tokens, `OVTR=amount,ASSET=amount`, exactly as for lp-epoch.js. The
//                        $OVTR amount is also the amount minted. For epoch 1 without it, the
//                        fallbacks LP_EPOCH1_OVTR_AMOUNT and LP_EPOCH1_ASSET_AMOUNT are used.
//   LP_REGISTRY_ADDRESS  overrides the deployments.json lookup of LPEpochRegistry
//   LP_OVERTURE_ADDRESS  overrides the deployments.json lookup of TokenOverture
//   LP_ASSET             overrides the deployments.json lookup of $ASSET (LPZapper.asset)
//   LP_EPOCH_BATCH_FILE  where the batch file goes; default lp-epoch-<id>-batch.json beside
//                        deployments.json
//
//     EPOCH_STARTS_AT=2026-11-17T12:00:00Z EPOCH_DURATION=604800 EPOCH_AMOUNTS="OVTR=7500,ASSET=3000" \
//       npx hardhat run scripts/lp-epoch-batch.js --network mainnet

require("./lib/lp-epoch-batch").main(false);
