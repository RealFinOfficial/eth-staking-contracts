// Arm the next LP epoch in ONE Safe batch of three calls, when the $ASSET is sent the same day:
//
//   1. RewardsDistributor.mintRewardToken($OVTR, distributor, the epoch's $OVTR amount)
//   2. $ASSET.transfer(distributor, the epoch's $ASSET amount)
//   3. LPEpochRegistry.scheduleEpoch(id, startsAt, endsAt, tokens, amounts)
//
// When the $ASSET funding comes later, use scripts/lp-epoch-batch.js (calls 1 and 3 only).
//
// This script NEVER sends a transaction, whoever the signer is, and needs no CONFIRM. It reads
// the chain, refuses what would revert, prints each call (`to`, `value: 0`, `data`) and writes the
// batch as a Safe Transaction Builder file for the operator Safe to import.
//
// It applies every check of `lp-epoch.js` with EPOCH_ACTION=schedule (the same refusals and the
// same GAP warning), and refuses besides: an epoch with no or zero $OVTR (nothing to mint: use
// lp-epoch.js), an epoch with no or zero $ASSET (nothing to transfer: use lp-epoch-batch.js), a
// token other than $OVTR and $ASSET in EPOCH_AMOUNTS, and a $OVTR token whose minter is not the
// distributor proxy. The mint and the `scheduleEpoch` call are simulated from the operator's
// address; a call that would revert is refused with its decoded reason. The $ASSET transfer is
// not simulated: when the operator holds less $ASSET than the transfer, a WARNING names the
// balance, the amount and the shortfall. The batch is atomic, so the Safe must hold the full
// amount before it executes the batch.
//
// ──────────────────────── environment ────────────────────────
//
//   EPOCH_ID             the epoch id; must be epochCount + 1 (defaults to it)
//   EPOCH_STARTS_AT      unix seconds or ISO-8601 UTC (e.g. 2026-11-17T12:00:00Z)
//   EPOCH_ENDS_AT        unix seconds or ISO-8601 UTC; or EPOCH_DURATION (seconds) instead
//   EPOCH_AMOUNTS        whole tokens, `OVTR=amount,ASSET=amount`, exactly as for lp-epoch.js. The
//                        $OVTR amount is the amount minted, the $ASSET amount the amount
//                        transferred. For epoch 1 without it, the fallbacks LP_EPOCH1_OVTR_AMOUNT
//                        and LP_EPOCH1_ASSET_AMOUNT are used.
//   LP_REGISTRY_ADDRESS  overrides the deployments.json lookup of LPEpochRegistry
//   LP_OVERTURE_ADDRESS  overrides the deployments.json lookup of TokenOverture
//   LP_ASSET             overrides the deployments.json lookup of $ASSET (LPZapper.asset)
//   LP_EPOCH_BATCH_FILE  where the batch file goes; default lp-epoch-<id>-batch-with-asset.json
//                        beside deployments.json
//
//     EPOCH_STARTS_AT=2026-11-17T12:00:00Z EPOCH_DURATION=604800 EPOCH_AMOUNTS="OVTR=7500,ASSET=3000" \
//       npx hardhat run scripts/lp-epoch-batch-with-asset.js --network mainnet

require("./lib/lp-epoch-batch").main(true);
