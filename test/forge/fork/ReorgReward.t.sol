// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkHarness} from "../utils/ForkHarness.sol";
import {RewardsDistributor} from "../../../contracts/lp-staking/RewardsDistributor.sol";
import {IERC20Like} from "../utils/Interfaces.sol";

/**
 * @notice Why this file exists: the indexer rewinds and replays on a reorg, and its whole
 *         reorg overlay rests on the assumption that the chain state it is rewinding really
 *         does return to what it was — nothing in the stack accumulates anything a rollback
 *         could not undo (no external accounting, no oracle write, no off-chain callback).
 *
 *  `vm.snapshotState` / `vm.revertToState` is a reorg in miniature: everything the block
 *  did, undone. Each test therefore asserts the same three things — the state MOVED, the
 *  rollback restored it EXACTLY, and the replay lands on the same result — which is also the
 *  anti-vacuity guard: a snapshot that changed nothing would prove nothing.
 */
contract ReorgRewardTest is ForkHarness {
    uint256 internal constant AWARD = 1_000e18;

    function setUp() public {
        _deployForkedStack();
    }

    function test_Reorg_RollingBackAClaimRestoresTheLedgerAndTheSupply() public {
        bytes memory sig =
            _signVoucher(voucherSignerPk, distributor.TOKENX_CLAIM_TYPEHASH(), alice, AWARD, FAR_DEADLINE);

        uint256 snap = vm.snapshotState();

        vm.prank(alice);
        distributor.claimTokenX(AWARD, FAR_DEADLINE, sig);
        assertEq(distributor.claimedTokenX(alice), AWARD, "anti-vacuity: the claim must really have landed");
        assertEq(tokenX.totalSupply(), AWARD, "anti-vacuity: the mint must really have happened");

        vm.revertToState(snap);

        assertEq(distributor.claimedTokenX(alice), 0, "the ledger must return to its pre-claim value");
        assertEq(tokenX.totalSupply(), 0, "the minted supply must be undone with the block");
        assertEq(tokenX.mintedInEpoch(EPOCH_ONE), 0, "the epoch tally must be undone too");
    }

    /// @dev The voucher is not consumed by a rolled-back claim, so the replay after a reorg
    ///      pays exactly the same amount — no double-pay, no lost entitlement.
    function test_Reorg_ReplayingAClaimAfterARollbackPaysTheSameAmountOnce() public {
        bytes memory sig =
            _signVoucher(voucherSignerPk, distributor.TOKENX_CLAIM_TYPEHASH(), alice, AWARD, FAR_DEADLINE);

        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        uint256 firstPaid = distributor.claimTokenX(AWARD, FAR_DEADLINE, sig);
        vm.revertToState(snap);

        vm.prank(alice);
        uint256 replayPaid = distributor.claimTokenX(AWARD, FAR_DEADLINE, sig);

        assertEq(replayPaid, firstPaid, "the replayed claim must pay exactly what the orphaned one did");
        assertEq(tokenX.balanceOf(alice), AWARD, "and the user must end up paid once, not twice");
    }

    function test_Reorg_RollingBackAStakeRestoresCustodyToTheStaker() public {
        uint256 tokenId = _mintAroundSpot(alice, 600);

        uint256 snap = vm.snapshotState();

        _stakeAs(alice, tokenId);
        assertEq(vault.stakerOf(tokenId), alice, "anti-vacuity: the stake must really have landed");
        assertEq(npm.ownerOf(tokenId), address(vault), "anti-vacuity: custody must really have moved");

        vm.revertToState(snap);

        assertEq(vault.stakerOf(tokenId), address(0), "the staker record must be gone after the rollback");
        assertEq(npm.ownerOf(tokenId), alice, "custody must be back with the original holder");
    }

    /// @dev A rebalance burns an NFT and mints another. A rollback must bring the burned one
    ///      back, or the indexer's rewind would point at a token that no longer exists.
    function test_Reorg_RollingBackARebalanceRestoresTheBurnedTokenId() public {
        uint256 tokenId = _mintAndStake(alice, 600);
        int24 tick = _alignDown(_currentTick());

        uint256 snap = vm.snapshotState();

        vm.prank(alice);
        uint256 newTokenId = vault.rebalance(tokenId, tick - 1200, tick + 1200, _noSwap(), FAR_DEADLINE);
        assertEq(vault.stakerOf(newTokenId), alice, "anti-vacuity: the rebalance must really have landed");

        vm.revertToState(snap);

        assertEq(npm.ownerOf(tokenId), address(vault), "the burned position must exist again after the rollback");
        assertEq(vault.stakerOf(tokenId), alice, "and be staked under its original staker");
        assertEq(vault.stakerOf(newTokenId), address(0), "the id the orphaned block minted must be unknown again");
    }

    /// @dev The ASSET leg moves real tokens rather than minting, so the rollback has to undo a
    ///      transfer out of the distributor's balance as well as the ledger write.
    function test_Reorg_RollingBackAnAssetClaimRestoresBothBalances() public {
        _fund(profile.asset, address(distributor), 1_000_000e18);
        vm.prank(multisig);
        distributor.setAssetClaimsEnabled(true);
        bytes memory sig = _signVoucher(voucherSignerPk, distributor.ASSET_CLAIM_TYPEHASH(), alice, AWARD, FAR_DEADLINE);

        uint256 aliceBefore = IERC20Like(profile.asset).balanceOf(alice);
        uint256 distributorBefore = IERC20Like(profile.asset).balanceOf(address(distributor));

        uint256 snap = vm.snapshotState();

        vm.prank(alice);
        distributor.claimAsset(AWARD, FAR_DEADLINE, sig);
        assertEq(
            IERC20Like(profile.asset).balanceOf(alice) - aliceBefore,
            AWARD,
            "anti-vacuity: the payout must really have happened"
        );

        vm.revertToState(snap);

        assertEq(IERC20Like(profile.asset).balanceOf(alice), aliceBefore, "the claimer's balance must be restored");
        assertEq(
            IERC20Like(profile.asset).balanceOf(address(distributor)),
            distributorBefore,
            "the distributor's balance must be restored"
        );
        assertEq(distributor.claimedAsset(alice), 0, "and the ASSET ledger must be back to zero");
    }

    /// @dev A rolled-back OWNER action is undone too: nothing in the stack latches a
    ///      parameter change outside ordinary storage.
    function test_Reorg_RollingBackAnOwnerActionRestoresTheParameters() public {
        uint32 windowBefore = vault.twapWindow();
        uint24 devBefore = vault.maxTwapDeviationBps();

        uint256 snap = vm.snapshotState();

        vm.prank(multisig);
        vault.setTwapParams(1200, 111);
        assertEq(vault.twapWindow(), 1200, "anti-vacuity: the parameter change must really have landed");

        vm.revertToState(snap);

        assertEq(vault.twapWindow(), windowBefore, "the window must be restored by the rollback");
        assertEq(vault.maxTwapDeviationBps(), devBefore, "the deviation ceiling must be restored by the rollback");
    }
}
