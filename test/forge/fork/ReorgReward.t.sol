// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkHarness} from "../utils/ForkHarness.sol";
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

    /// @dev $OVTR is paid by transfer out of the funded balance, so the rollback has to undo the
    ///      ledger write AND the move between the two balances — and nothing else may have changed.
    function test_Reorg_RollingBackAClaimRestoresTheLedgerAndBothBalances() public {
        address ovtr = address(overture);
        bytes memory sig = _signVoucher(voucherSignerPk, ovtr, alice, AWARD, FAR_DEADLINE);
        uint256 floatBefore = overture.balanceOf(address(distributor));
        uint256 supplyBefore = overture.totalSupply();

        uint256 snap = vm.snapshotState();

        vm.prank(alice);
        distributor.claim(ovtr, AWARD, FAR_DEADLINE, sig);
        assertEq(distributor.claimed(ovtr, alice), AWARD, "anti-vacuity: the claim must really have landed");
        assertEq(overture.balanceOf(alice), AWARD, "anti-vacuity: the payout must really have happened");

        vm.revertToState(snap);

        assertEq(distributor.claimed(ovtr, alice), 0, "the ledger must return to its pre-claim value");
        assertEq(overture.balanceOf(alice), 0, "the claimer's balance must be undone with the block");
        assertEq(overture.balanceOf(address(distributor)), floatBefore, "and the distributor's balance restored");
        assertEq(overture.totalSupply(), supplyBefore, "the supply never moved: claims mint nothing");
    }

    /// @dev The voucher is not consumed by a rolled-back claim, so the replay after a reorg
    ///      pays exactly the same amount — no double-pay, no lost entitlement.
    function test_Reorg_ReplayingAClaimAfterARollbackPaysTheSameAmountOnce() public {
        address ovtr = address(overture);
        bytes memory sig = _signVoucher(voucherSignerPk, ovtr, alice, AWARD, FAR_DEADLINE);

        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        uint256 firstPaid = distributor.claim(ovtr, AWARD, FAR_DEADLINE, sig);
        vm.revertToState(snap);

        vm.prank(alice);
        uint256 replayPaid = distributor.claim(ovtr, AWARD, FAR_DEADLINE, sig);

        assertEq(replayPaid, firstPaid, "the replayed claim must pay exactly what the orphaned one did");
        assertEq(overture.balanceOf(alice), AWARD, "and the user must end up paid once, not twice");
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

    /// @dev The real $ASSET: once its claims are opened, the rollback has to undo a transfer out
    ///      of the distributor's balance as well as the ledger write.
    function test_Reorg_RollingBackAnAssetClaimRestoresBothBalances() public {
        vm.prank(multisig);
        distributor.setClaimsEnabled(profile.asset, true);
        bytes memory sig = _signVoucher(voucherSignerPk, profile.asset, alice, AWARD, FAR_DEADLINE);

        uint256 aliceBefore = IERC20Like(profile.asset).balanceOf(alice);
        uint256 distributorBefore = IERC20Like(profile.asset).balanceOf(address(distributor));

        uint256 snap = vm.snapshotState();

        vm.prank(alice);
        distributor.claim(profile.asset, AWARD, FAR_DEADLINE, sig);
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
        assertEq(distributor.claimed(profile.asset, alice), 0, "and the $ASSET ledger must be back to zero");
    }

    /// @dev A rolled-back ADMIN action is undone too: nothing in the stack latches a parameter
    ///      change outside ordinary storage. (`setTwapParams` is operator tier; the multisig is
    ///      the operator on the fork.)
    function test_Reorg_RollingBackAnOwnerActionRestoresTheParameters() public {
        uint32 windowBefore = vault.twapWindow();
        uint24 devBefore = vault.maxTwapDeviationTicks();

        uint256 snap = vm.snapshotState();

        vm.prank(multisig);
        vault.setTwapParams(1200, 111);
        assertEq(vault.twapWindow(), 1200, "anti-vacuity: the parameter change must really have landed");

        vm.revertToState(snap);

        assertEq(vault.twapWindow(), windowBefore, "the window must be restored by the rollback");
        assertEq(vault.maxTwapDeviationTicks(), devBefore, "the deviation ceiling must be restored by the rollback");
    }
}
