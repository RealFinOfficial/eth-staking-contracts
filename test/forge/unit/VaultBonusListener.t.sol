// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {console} from "forge-std/console.sol";
import {VmSafe} from "forge-std/Vm.sol";

import {StakingV3Harness} from "../utils/StakingV3Harness.sol";
import {LPStakingVault} from "../../../contracts/lp-staking/LPStakingVault.sol";
import {StakingMigrator} from "../../../contracts/staking-v3/StakingMigrator.sol";
import {V3BonusVault} from "../../../contracts/staking-v3/V3BonusVault.sol";
import {IBonusEscrowHooks} from "../../../contracts/lp-staking/interfaces/IBonusEscrowHooks.sol";
import {SwapParams} from "../../../contracts/lp-staking/libraries/TwapGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @dev A listener that owes nothing and rejects every notification.
contract RevertingListener {
    uint256 public totalLpReserved;

    function setTotalLpReserved(uint256 value) external {
        totalLpReserved = value;
    }

    function onUnstake(uint256) external pure {
        revert("listener down");
    }

    function onRebalance(uint256, uint256, IBonusEscrowHooks.Snapshot calldata, IBonusEscrowHooks.Snapshot calldata)
        external
        pure
    {
        revert("listener down");
    }
}

/// @dev A listener that accepts every notification and does nothing: the state it leaves is the
///      state the PRE-FIX vault (listener `onRebalance` fail open, before 2026-11-10) left when the
///      call ran out of gas inside its `try` — Sepolia stack #6, position 234214 on 2026-11-09.
contract SilentListener {
    uint256 public totalLpReserved;

    function onUnstake(uint256) external {}

    function onRebalance(uint256, uint256, IBonusEscrowHooks.Snapshot calldata, IBonusEscrowHooks.Snapshot calldata)
        external {}
}

/// @dev An idle listener bound to whatever vault it is told (the {setBonusListener} guard).
contract BoundListener {
    uint256 public totalLpReserved;
    address public vault;

    constructor(address vault_) {
        vault = vault_;
    }

    function onUnstake(uint256) external {}

    function onRebalance(uint256, uint256, IBonusEscrowHooks.Snapshot calldata, IBonusEscrowHooks.Snapshot calldata)
        external {}
}

/**
 * @notice The vault's staking v3 bonus listener ({LPStakingVault-setBonusListener}): the owner-tier
 *         link with its code and reservation rules, the FAIL-OPEN `onUnstake` with its gas floor,
 *         the FAIL-CLOSED `onRebalance` (since 2026-11-10), and the real flows on the math rung — a
 *         position joined through the migrator, re-ranged (the LP reservation moves and scales
 *         down, or is settled after the unlock) and unstaked (forfeited before the unlock, settled
 *         after it), plus the stale record a missed notification leaves (never paid, reconciled).
 */
contract VaultBonusListenerTest is StakingV3Harness {
    uint256 internal constant PRINCIPAL = 20_000e18;
    uint256 internal constant REWARD = 1_000e6;

    function setUp() public {
        _deployStakingV3();
        _approveMigrator(alice);
    }

    function _join() internal returns (uint256 tokenId) {
        StakingMigrator.Voucher memory v = _voucher(migrator, alice, 2, PRINCIPAL, REWARD, 1);
        vm.prank(alice);
        tokenId = migrator.moveToLp(REWARD, PRINCIPAL, 0, 0, FAR_DEADLINE, _noPermit(), _noPermit(), v);
    }

    function _noSwapParams() internal pure returns (SwapParams memory) {
        return SwapParams({zeroForOne: true, amountIn: 0, amountOutMin: 0, amount0Min: 0, amount1Min: 0});
    }

    // ──────────────────────── setBonusListener ─────────────────

    function test_SetBonusListener_OwnerOnlyCodeOnlyAndAnnounced() public {
        assertEq(mathVault.bonusListener(), address(bonusVault));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        mathVault.setBonusListener(address(0));
        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.NotAContract.selector, stranger));
        mathVault.setBonusListener(stranger);

        vm.expectEmit(address(mathVault));
        emit LPStakingVault.BonusListenerSet(address(bonusVault), address(0));
        mathVault.setBonusListener(address(0));
        assertEq(mathVault.bonusListener(), address(0));
    }

    function test_SetBonusListener_AListenerThatOwesIsPermanent() public {
        uint256 tokenId = _join();
        (, uint256 lpAmount,,,) = bonusVault.lpReservation(tokenId);
        uint256 owed = bonusVault.totalLpReserved();
        assertEq(owed, lpAmount, "the guard reads the LP part only");
        assertGt(bonusVault.totalReserved(), owed, "the v3 remainder is reserved too");
        vm.expectRevert(
            abi.encodeWithSelector(LPStakingVault.ListenerHasReservations.selector, address(bonusVault), owed)
        );
        mathVault.setBonusListener(address(0));
    }

    function test_SetBonusListener_AV3OnlyReservationDoesNotHoldTheLink() public {
        StakingMigrator.Voucher memory v = _voucher(migrator, alice, 3, PRINCIPAL, 0, 1);
        vm.prank(alice);
        migrator.claimRestake(PRINCIPAL, FAR_DEADLINE, _noPermit(), v);
        assertGt(bonusVault.totalReserved(), 0);
        assertEq(bonusVault.totalLpReserved(), 0);
        mathVault.setBonusListener(address(0));
        assertEq(mathVault.bonusListener(), address(0));
    }

    /// @dev The listener must be bound to this vault: another vault reverts, zero is allowed, the
    ///      right one passes (review closure 2026-11-10).
    function test_SetBonusListener_RefusesAListenerBoundToAnotherVault() public {
        BoundListener elsewhere = new BoundListener(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(LPStakingVault.ListenerVaultMismatch.selector, address(elsewhere), stranger)
        );
        mathVault.setBonusListener(address(elsewhere));

        BoundListener unbound = new BoundListener(address(0));
        vm.expectRevert(
            abi.encodeWithSelector(LPStakingVault.ListenerVaultMismatch.selector, address(unbound), address(0))
        );
        mathVault.setBonusListener(address(unbound));

        // A contract with no `vault()` at all cannot be linked either.
        vm.expectRevert();
        mathVault.setBonusListener(address(asset));

        mathVault.setBonusListener(address(0));
        assertEq(mathVault.bonusListener(), address(0), "zero is allowed");

        BoundListener here = new BoundListener(address(mathVault));
        mathVault.setBonusListener(address(here));
        assertEq(mathVault.bonusListener(), address(here));
        mathVault.setBonusListener(address(bonusVault));
        assertEq(mathVault.bonusListener(), address(bonusVault), "the real bonus vault is bound to this vault");
    }

    // ──────────────────────── reconcileLp after a failed notification ─

    /// @dev Runs `action` with the listener's code swapped for {RevertingListener}, then restores
    ///      it: the storage behind the proxy is untouched, exactly like a listener that was down.
    function _withListenerDown() internal returns (bytes memory saved) {
        saved = address(bonusVault).code;
        vm.etch(address(bonusVault), address(new RevertingListener()).code);
    }

    /// @dev Swaps a {SilentListener} under the listener's address (storage untouched), runs the
    ///      rebalance, restores the real code: the pre-fix stranded reservation, reproduced.
    function _strandedRebalance(uint256 tokenId) internal returns (uint256 newId) {
        bytes memory saved = address(bonusVault).code;
        vm.etch(address(bonusVault), address(new SilentListener()).code);
        vm.prank(alice);
        newId = mathVault.rebalance(tokenId, PRICE_TICK - 6932, PRICE_TICK + 6932, _noSwapParams(), FAR_DEADLINE);
        vm.etch(address(bonusVault), saved);
    }

    /// @dev The Sepolia stack #6 bug end to end (wallet B, 234214 -> 234216, 2026-11-09): the
    ///      reservation stays under the burned id, active. After the fix it never pays — not
    ///      even after the unlock — and `reconcileLp` forfeits it.
    function test_StaleRecord_APreFixStrandedReservationNeverPaysAndIsReconciled() public {
        uint256 tokenId = _join();
        (, uint256 owedLp,,,) = bonusVault.lpReservation(tokenId);
        (uint256 owedV3,) = bonusVault.reservedOf(alice);
        uint256 totalBefore = bonusVault.totalReserved();

        uint256 newId = _strandedRebalance(tokenId);

        (address user, uint256 stale,,, bool forfeited) = bonusVault.lpReservation(tokenId);
        assertEq(user, alice, "the record stayed under the burned id");
        assertEq(stale, owedLp);
        assertFalse(forfeited);
        assertEq(mathVault.stakerOf(tokenId), address(0));
        assertEq(mathVault.stakerOf(newId), alice);
        (address newUser,,,,) = bonusVault.lpReservation(newId);
        assertEq(newUser, address(0), "the new position has no record");

        // After the unlock, with alice still staked on the NEW id: the stale record pays nothing.
        vm.warp(v3End);
        assertEq(bonusVault.claimable(alice), owedV3, "only the v3 part");
        asset.approve(address(bonusVault), type(uint256).max);
        bonusVault.fund(owedLp + owedV3);
        vm.prank(alice);
        assertEq(bonusVault.claim(), owedV3, "the stale LP record is skipped");
        (,,, bool claimed,) = bonusVault.lpReservation(tokenId);
        assertFalse(claimed);
        assertFalse(bonusVault.lpSettled(tokenId));
        vm.prank(alice);
        vm.expectRevert(V3BonusVault.NothingToClaim.selector);
        bonusVault.claim();

        // Anyone cleans it after the unlock too; the tokens stay as surplus.
        vm.expectEmit(address(bonusVault));
        emit V3BonusVault.LpBonusForfeited(tokenId, alice, owedLp);
        vm.prank(stranger);
        assertTrue(bonusVault.reconcileLp(tokenId));
        assertEq(bonusVault.totalReserved(), totalBefore - owedLp - owedV3);
        assertEq(bonusVault.totalLpReserved(), 0);
        assertEq(asset.balanceOf(address(bonusVault)), owedLp, "the LP part stays here");
        assertFalse(bonusVault.reconcileLp(newId), "the new tokenId carries no reservation");
    }

    function test_StaleRecord_ReconciledBeforeTheUnlockToo() public {
        uint256 tokenId = _join();
        (, uint256 owedLp,,,) = bonusVault.lpReservation(tokenId);
        _strandedRebalance(tokenId);
        vm.prank(stranger);
        assertTrue(bonusVault.reconcileLp(tokenId));
        (, uint256 amount,,, bool forfeited) = bonusVault.lpReservation(tokenId);
        assertEq(amount, 0);
        assertTrue(forfeited);
        assertEq(bonusVault.totalLpReserved(), 0);
        assertGt(owedLp, 0);
    }

    /// @dev Unstakes `tokenId` as alice with the listener's code swapped for {RevertingListener}
    ///      (fail open: `BonusListenerFailed`, `listenerMissedAt` written once), then restores it.
    function _unstakeWithListenerDown(uint256 tokenId) internal {
        bytes memory saved = _withListenerDown();
        vm.expectEmit(address(mathVault));
        emit LPStakingVault.BonusListenerFailed(tokenId);
        vm.prank(alice);
        mathVault.unstake(tokenId);
        vm.etch(address(bonusVault), saved);
    }

    function _restake(uint256 tokenId) internal {
        vm.startPrank(alice);
        mathNpm.approve(address(mathVault), tokenId);
        mathVault.stake(tokenId);
        vm.stopPrank();
        assertEq(mathVault.stakerOf(tokenId), alice, "re-staked by the same user");
    }

    /// @dev (3) A missed `onUnstake` AFTER the unlock is a legitimate exit: `listenerMissedAt` is at
    ///      or after the unlock, `claim()` pays it, `reconcileLp` settles it (event), paid once.
    function test_MissedAfter_AFailedUnstakeAfterTheUnlockPaysAndIsSettled() public {
        uint256 tokenId = _join();
        (, uint256 owedLp, uint64 unlockAt,,) = bonusVault.lpReservation(tokenId);
        (uint256 owedV3,) = bonusVault.reservedOf(alice);
        vm.warp(v3End);
        _unstakeWithListenerDown(tokenId);

        assertEq(mathVault.listenerMissedAt(tokenId), uint64(block.timestamp));
        assertGe(mathVault.listenerMissedAt(tokenId), unlockAt, "missed after the unlock");
        assertFalse(bonusVault.lpSettled(tokenId));
        assertEq(bonusVault.claimable(alice), owedLp + owedV3, "missed-after pays");

        vm.expectEmit(address(bonusVault));
        emit V3BonusVault.LpBonusSettled(tokenId, alice);
        vm.prank(stranger);
        assertFalse(bonusVault.reconcileLp(tokenId), "settled, not forfeited");
        assertTrue(bonusVault.lpSettled(tokenId));
        assertEq(bonusVault.totalLpReserved(), owedLp, "still owed");

        asset.approve(address(bonusVault), type(uint256).max);
        bonusVault.fund(owedLp + owedV3);
        vm.prank(alice);
        assertEq(bonusVault.claim(), owedLp + owedV3);
        vm.prank(alice);
        vm.expectRevert(V3BonusVault.NothingToClaim.selector);
        bonusVault.claim();
        assertEq(bonusVault.totalLpReserved(), 0);
    }

    /// @dev (1) An EARLY exit whose forfeit failed, then a re-stake of the same NFT: the record is
    ///      DEAD — not payable after the unlock, and `reconcileLp` forfeits it while re-staked.
    function test_Dead_AnEarlyExitWithAFailedListenerThenARestakeIsNotPayable() public {
        uint256 tokenId = _join();
        (, uint256 owedLp, uint64 unlockAt,,) = bonusVault.lpReservation(tokenId);
        (uint256 owedV3,) = bonusVault.reservedOf(alice);
        _unstakeWithListenerDown(tokenId);
        assertLt(mathVault.listenerMissedAt(tokenId), unlockAt, "missed before the unlock");
        _restake(tokenId);

        vm.warp(v3End);
        assertEq(bonusVault.claimable(alice), owedV3, "the dead LP record counts zero");
        asset.approve(address(bonusVault), type(uint256).max);
        bonusVault.fund(owedLp + owedV3);
        vm.prank(alice);
        assertEq(bonusVault.claim(), owedV3, "only the v3 part");

        vm.expectEmit(address(bonusVault));
        emit V3BonusVault.LpBonusForfeited(tokenId, alice, owedLp);
        vm.prank(stranger);
        assertTrue(bonusVault.reconcileLp(tokenId), "forfeited while re-staked");
        assertEq(mathVault.stakerOf(tokenId), alice);
        assertEq(bonusVault.totalLpReserved(), 0);
    }

    /// @dev (1, before the unlock) `reconcileLp` forfeits the dead record while it is re-staked.
    function test_Dead_ReconciledBeforeTheUnlockWhileRestaked() public {
        uint256 tokenId = _join();
        (, uint256 owedLp,,,) = bonusVault.lpReservation(tokenId);
        _unstakeWithListenerDown(tokenId);
        _restake(tokenId);
        vm.expectEmit(address(bonusVault));
        emit V3BonusVault.LpBonusForfeited(tokenId, alice, owedLp);
        assertTrue(bonusVault.reconcileLp(tokenId));
        assertEq(bonusVault.totalLpReserved(), 0);
    }

    /// @dev (1, re-range) A dead record re-staked and re-ranged before the unlock is forfeited,
    ///      not moved to the new tokenId; the rebalance itself completes.
    function test_Dead_ARestakedRebalanceBeforeTheUnlockForfeitsInsteadOfMoving() public {
        uint256 tokenId = _join();
        (, uint256 owedLp,,,) = bonusVault.lpReservation(tokenId);
        _unstakeWithListenerDown(tokenId);
        _restake(tokenId);
        vm.expectEmit(address(bonusVault));
        emit V3BonusVault.LpBonusForfeited(tokenId, alice, owedLp);
        vm.prank(alice);
        uint256 newId =
            mathVault.rebalance(tokenId, PRICE_TICK - 6932, PRICE_TICK + 6932, _noSwapParams(), FAR_DEADLINE);
        (address moved,,,,) = bonusVault.lpReservation(newId);
        assertEq(moved, address(0));
        assertEq(mathVault.stakerOf(newId), alice);
        assertEq(bonusVault.totalLpReserved(), 0);
    }

    /// @dev (2) The same dead record, then an unstake AFTER the unlock with a WORKING listener:
    ///      not settled, forfeited, no payment.
    function test_Dead_ALaterUnstakeAfterTheUnlockForfeitsInsteadOfSettling() public {
        uint256 tokenId = _join();
        (, uint256 owedLp,,,) = bonusVault.lpReservation(tokenId);
        (uint256 owedV3,) = bonusVault.reservedOf(alice);
        _unstakeWithListenerDown(tokenId);
        _restake(tokenId);

        vm.warp(v3End);
        vm.expectEmit(address(bonusVault));
        emit V3BonusVault.LpBonusForfeited(tokenId, alice, owedLp);
        vm.prank(alice);
        mathVault.unstake(tokenId);
        assertFalse(bonusVault.lpSettled(tokenId), "a dead record is never settled");
        (, uint256 amount,,, bool forfeited) = bonusVault.lpReservation(tokenId);
        assertEq(amount, 0);
        assertTrue(forfeited);

        asset.approve(address(bonusVault), type(uint256).max);
        bonusVault.fund(owedLp + owedV3);
        vm.prank(alice);
        assertEq(bonusVault.claim(), owedV3, "no LP payment");
    }

    /// @dev (4) Never overwritten: a tokenId missed before the unlock and missed again after it
    ///      stays "missed before", so the record stays dead.
    function test_ListenerMissedAt_IsNeverOverwritten() public {
        uint256 tokenId = _join();
        (, uint256 owedLp, uint64 unlockAt,,) = bonusVault.lpReservation(tokenId);
        _unstakeWithListenerDown(tokenId);
        uint64 first = mathVault.listenerMissedAt(tokenId);
        assertEq(first, uint64(block.timestamp));
        assertLt(first, unlockAt);
        _restake(tokenId);

        vm.warp(v3End);
        _unstakeWithListenerDown(tokenId);
        assertEq(mathVault.listenerMissedAt(tokenId), first, "still the first miss");
        (uint256 owedV3,) = bonusVault.reservedOf(alice);
        assertEq(bonusVault.claimable(alice), owedV3, "still dead: the LP part counts zero");
        assertTrue(bonusVault.reconcileLp(tokenId));
    }

    /// @dev `listenerMissedAt` is APPENDED in slot 9 of the vault namespace, after the gas slot 8:
    ///      the entry for `tokenId` lives at keccak256(tokenId . (base + 9)).
    function test_Storage_ListenerMissedAtIsAppendedInSlotNine() public {
        uint256 tokenId = _join();
        _unstakeWithListenerDown(tokenId);
        bytes32 base = 0x4c835a63e69815f7352ca18e845a5d8023cea9abbc2e923eb7a3a481844a6500;
        bytes32 entry = keccak256(abi.encode(tokenId, uint256(base) + 9));
        assertEq(uint256(vm.load(address(mathVault), entry)), block.timestamp, "slot 9 = listenerMissedAt");
        assertGt(uint256(vm.load(address(mathVault), bytes32(uint256(base) + 8))), 0, "slot 8 = the gas fields");
    }

    /// @dev A successful notification records nothing.
    function test_ListenerMissedAt_StaysZeroWhenTheNotificationSucceeds() public {
        uint256 tokenId = _join();
        vm.prank(alice);
        mathVault.unstake(tokenId);
        assertEq(mathVault.listenerMissedAt(tokenId), 0);
    }

    function test_ReconcileLp_AFailedUnstakeIsForfeitedByReconcile() public {
        uint256 tokenId = _join();
        (, uint256 owedLp,,,) = bonusVault.lpReservation(tokenId);
        bytes memory saved = _withListenerDown();
        vm.prank(alice);
        mathVault.unstake(tokenId);
        vm.etch(address(bonusVault), saved);
        assertEq(bonusVault.totalLpReserved(), owedLp, "the failed notification left it owed");

        assertTrue(bonusVault.reconcileLp(tokenId));
        assertEq(bonusVault.totalLpReserved(), 0);
    }

    function test_ReconcileLp_AStillStakedPositionIsANoOp() public {
        uint256 tokenId = _join();
        (, uint256 owedLp,,,) = bonusVault.lpReservation(tokenId);
        assertFalse(bonusVault.reconcileLp(tokenId));
        (, uint256 amount,,, bool forfeited) = bonusVault.lpReservation(tokenId);
        assertEq(amount, owedLp);
        assertFalse(forfeited);
    }

    // ──────────────────────── The real flows ───────────────────

    function test_Rebalance_MovesTheLpReservationAndScalesItDown() public {
        uint256 tokenId = _join();
        (, uint256 before,,,) = bonusVault.lpReservation(tokenId);
        // A band entirely above the price holds only $ASSET: the USDC leg is refunded, value drops.
        vm.prank(alice);
        uint256 newId = mathVault.rebalance(tokenId, PRICE_TICK + 10, PRICE_TICK + 6932, _noSwapParams(), FAR_DEADLINE);

        (address oldUser,,,,) = bonusVault.lpReservation(tokenId);
        assertEq(oldUser, address(0));
        (address user, uint256 amount,,, bool forfeited) = bonusVault.lpReservation(newId);
        assertEq(user, alice);
        assertFalse(forfeited);
        assertLt(amount, before, "scaled down with the value");
        assertGt(amount, before / 3, "roughly the $ASSET half");
        uint256[] memory ids = bonusVault.lpTokensOf(alice);
        assertEq(ids[0], newId);
    }

    function test_Rebalance_NeverScalesUp() public {
        uint256 tokenId = _join();
        (, uint256 before,,,) = bonusVault.lpReservation(tokenId);
        (,,,,, int24 lower, int24 upper,,,,,) = mathNpm.positions(tokenId);
        vm.prank(alice);
        uint256 newId = mathVault.rebalance(tokenId, lower + 100, upper - 100, _noSwapParams(), FAR_DEADLINE);
        (, uint256 amount,,,) = bonusVault.lpReservation(newId);
        assertLe(amount, before);
    }

    function test_Unstake_BeforeTheUnlockForfeitsTheLpReservation() public {
        uint256 tokenId = _join();
        (, uint256 owedLp,,,) = bonusVault.lpReservation(tokenId);
        (uint256 owedV3,) = bonusVault.reservedOf(alice);
        uint256 totalBefore = bonusVault.totalReserved();
        vm.expectEmit(address(bonusVault));
        emit V3BonusVault.LpBonusForfeited(tokenId, alice, owedLp);
        vm.prank(alice);
        mathVault.unstake(tokenId);
        assertEq(bonusVault.totalReserved(), totalBefore - owedLp);
        assertEq(mathNpm.ownerOf(tokenId), alice);
        assertFalse(bonusVault.lpSettled(tokenId), "an early exit is forfeited, never settled");
        vm.warp(v3End);
        assertEq(bonusVault.claimable(alice), owedV3, "the LP part is gone for good");
    }

    /// @dev Rule of 2026-11-12, end to end: alice joins LP through the migrator (an LP part and a v3
    ///      remainder part), then withdraws the remainder from the v3 pool before its end. Both
    ///      parts are forfeited in the withdrawal; her later LP unstake neither reverts nor moves
    ///      a total, and nothing pays at the end.
    function test_V3EarlyExit_ForfeitsTheJoinedLpPartToo() public {
        uint256 tokenId = _join();
        (, uint256 owedLp,,,) = bonusVault.lpReservation(tokenId);
        (uint256 owedV3,) = bonusVault.reservedOf(alice);
        uint256 staked = poolV3.stakes(alice);
        assertGt(owedV3, 0);
        assertGt(staked, 0);
        uint256 totalBefore = bonusVault.totalReserved();

        vm.expectEmit(address(bonusVault));
        emit V3BonusVault.BonusForfeited(alice, owedV3);
        vm.expectEmit(address(bonusVault));
        emit V3BonusVault.LpBonusForfeited(tokenId, alice, owedLp);
        vm.prank(alice);
        poolV3.withdraw(staked / 2);
        assertEq(bonusVault.totalReserved(), totalBefore - owedLp - owedV3);
        assertEq(bonusVault.totalLpReserved(), 0);
        assertEq(mathVault.stakerOf(tokenId), alice, "the position itself stays staked");

        vm.recordLogs();
        vm.prank(alice);
        mathVault.unstake(tokenId);
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; ++i) {
            assertTrue(logs[i].emitter != address(bonusVault), "the forfeited record is not touched again");
            assertTrue(logs[i].topics[0] != LPStakingVault.BonusListenerFailed.selector, "the hook did not revert");
        }
        assertEq(mathVault.listenerMissedAt(tokenId), 0);
        assertFalse(bonusVault.reconcileLp(tokenId));
        vm.warp(v3End);
        assertEq(bonusVault.claimable(alice), 0);
        assertFalse(bonusVault.lpSettled(tokenId));
        assertEq(bonusVault.totalLpReserved(), 0, "dropped exactly once");
    }

    /// @dev The same exit, then a re-range of the still-staked position (fail closed in the vault):
    ///      it must not revert, and the forfeited record is neither moved nor revived.
    function test_V3EarlyExit_ThenARebalanceNeitherRevertsNorRevives() public {
        uint256 tokenId = _join();
        uint256 staked = poolV3.stakes(alice);
        vm.prank(alice);
        poolV3.withdraw(staked);
        vm.prank(alice);
        uint256 newId = mathVault.rebalance(tokenId, PRICE_TICK + 10, PRICE_TICK + 6932, _noSwapParams(), FAR_DEADLINE);
        (address moved,,,,) = bonusVault.lpReservation(newId);
        assertEq(moved, address(0), "nothing moved to the new id");
        (,,,, bool forfeited) = bonusVault.lpReservation(tokenId);
        assertTrue(forfeited);
        assertEq(bonusVault.totalLpReserved(), 0);
        assertEq(bonusVault.totalReserved(), 0);
        vm.warp(v3End);
        vm.prank(alice);
        mathVault.unstake(newId);
        assertEq(bonusVault.claimable(alice), 0);
    }

    /// @dev The new-stake bonus (2026-11-12) on the real flow: alice joins LP through the
    ///      migrator, then stakes more directly in the v3 pool with the backend's voucher. The
    ///      direct stake reserves `previewStakeBonus` (route 4) on top of the route bonus, and an
    ///      early withdraw forfeits the whole v3 part with the LP part.
    function test_DirectStake_ReservesItsBonusAndAnEarlyExitForfeitsItWithTheRest() public {
        uint256 tokenId = _join();
        (, uint256 owedLp,,,) = bonusVault.lpReservation(tokenId);
        (uint256 routeV3,) = bonusVault.reservedOf(alice);
        vm.warp(v3Start + 43 days); // 47 of 90 days left
        uint256 amount = 1_000e18;
        uint256 preview = poolV3.previewStakeBonus(amount);
        assertEq(preview, 26_111_111_111_111_111_111, "1,000 x 5 % x 47 / 90");
        vm.prank(alice);
        asset.approve(address(poolV3), amount);
        bytes memory sig = _signStake(poolV3, alice, FAR_DEADLINE);
        vm.expectEmit(address(bonusVault));
        emit V3BonusVault.BonusReserved(alice, preview, uint64(v3End), 4);
        vm.prank(alice);
        poolV3.stake(amount, FAR_DEADLINE, sig);
        (uint256 v3,) = bonusVault.reservedOf(alice);
        assertEq(v3, routeV3 + preview);

        vm.expectEmit(address(bonusVault));
        emit V3BonusVault.BonusForfeited(alice, routeV3 + preview);
        vm.expectEmit(address(bonusVault));
        emit V3BonusVault.LpBonusForfeited(tokenId, alice, owedLp);
        vm.prank(alice);
        poolV3.withdraw(amount);
        assertEq(bonusVault.totalReserved(), 0);
    }

    function test_Unstake_AfterTheUnlockSettlesAndPays() public {
        uint256 tokenId = _join();
        (, uint256 owedLp,,,) = bonusVault.lpReservation(tokenId);
        (uint256 owedV3,) = bonusVault.reservedOf(alice);
        vm.warp(v3End);
        vm.expectEmit(address(bonusVault));
        emit V3BonusVault.LpBonusSettled(tokenId, alice);
        vm.prank(alice);
        mathVault.unstake(tokenId);
        assertTrue(bonusVault.lpSettled(tokenId));
        assertEq(mathVault.stakerOf(tokenId), address(0));
        assertFalse(bonusVault.reconcileLp(tokenId), "a settled record is never reconciled");
        asset.approve(address(bonusVault), type(uint256).max);
        bonusVault.fund(owedLp + owedV3);
        vm.prank(alice);
        assertEq(bonusVault.claim(), owedLp + owedV3);
        assertEq(bonusVault.totalLpReserved(), 0);
    }

    function test_Rebalance_AfterTheUnlockSettlesUnderTheOldIdAndPays() public {
        uint256 tokenId = _join();
        (, uint256 owedLp,,,) = bonusVault.lpReservation(tokenId);
        (uint256 owedV3,) = bonusVault.reservedOf(alice);
        vm.warp(v3End);
        vm.expectEmit(address(bonusVault));
        emit V3BonusVault.LpBonusSettled(tokenId, alice);
        vm.prank(alice);
        uint256 newId = mathVault.rebalance(tokenId, PRICE_TICK + 10, PRICE_TICK + 6932, _noSwapParams(), FAR_DEADLINE);

        (address user, uint256 amount,,,) = bonusVault.lpReservation(tokenId);
        assertEq(user, alice, "the record stays under the old id");
        assertEq(amount, owedLp, "not scaled after the unlock");
        assertTrue(bonusVault.lpSettled(tokenId));
        (address newUser,,,,) = bonusVault.lpReservation(newId);
        assertEq(newUser, address(0));

        // Leaving the new position afterwards changes nothing: the settled record pays.
        vm.prank(alice);
        mathVault.unstake(newId);
        asset.approve(address(bonusVault), type(uint256).max);
        bonusVault.fund(owedLp + owedV3);
        vm.prank(alice);
        assertEq(bonusVault.claim(), owedLp + owedV3);
    }

    function test_Claim_AStillStakedPositionPaysAfterTheUnlock() public {
        uint256 tokenId = _join();
        (, uint256 owedLp,,,) = bonusVault.lpReservation(tokenId);
        (uint256 owedV3,) = bonusVault.reservedOf(alice);
        vm.warp(v3End);
        asset.approve(address(bonusVault), type(uint256).max);
        bonusVault.fund(owedLp + owedV3);
        vm.prank(alice);
        assertEq(bonusVault.claim(), owedLp + owedV3);
        // A later unstake of a claimed record neither settles nor forfeits it.
        vm.prank(alice);
        mathVault.unstake(tokenId);
        assertFalse(bonusVault.lpSettled(tokenId));
        (,,, bool claimed, bool forfeited) = bonusVault.lpReservation(tokenId);
        assertTrue(claimed);
        assertFalse(forfeited);
    }

    // ──────────────────────── Fail open (unstake) / fail closed (rebalance) ─

    function test_FailOpen_AnUnstakeCompletesWhenTheListenerReverts() public {
        uint256 tokenId = _join();
        RevertingListener bad = new RevertingListener();
        // The owing listener cannot be swapped out, so this test swaps the bytecode under it.
        vm.etch(address(bonusVault), address(bad).code);
        vm.expectEmit(address(mathVault));
        emit LPStakingVault.BonusListenerFailed(tokenId);
        vm.prank(alice);
        mathVault.unstake(tokenId);
        assertEq(mathNpm.ownerOf(tokenId), alice, "the exit completed");
    }

    function test_FailClosed_ARebalanceRevertsWhenTheListenerReverts() public {
        uint256 tokenId = _join();
        (address user, uint256 owedLp, uint64 unlockAt,,) = bonusVault.lpReservation(tokenId);
        uint256 totalBefore = bonusVault.totalReserved();
        bytes memory saved = _withListenerDown();
        vm.prank(alice);
        vm.expectRevert(bytes("listener down"));
        mathVault.rebalance(tokenId, PRICE_TICK - 6932, PRICE_TICK + 6932, _noSwapParams(), FAR_DEADLINE);
        vm.etch(address(bonusVault), saved);

        // Vault and reservation untouched.
        assertEq(mathVault.stakerOf(tokenId), alice);
        assertEq(mathNpm.ownerOf(tokenId), address(mathVault));
        (address u, uint256 a, uint64 t, bool claimed, bool forfeited) = bonusVault.lpReservation(tokenId);
        assertEq(u, user);
        assertEq(a, owedLp);
        assertEq(t, unlockAt);
        assertFalse(claimed);
        assertFalse(forfeited);
        assertEq(bonusVault.totalReserved(), totalBefore);
    }

    function test_FailOpen_TheGasFloorRefusesAStarvedUnstake() public {
        uint256 tokenId = _join();
        mathVault.setBonusEscrow(address(0)); // the escrow owes nothing on the math rung
        vm.prank(alice);
        vm.expectRevert(LPStakingVault.InsufficientGasForBonusHook.selector);
        mathVault.unstake{gas: 108_000}(tokenId);
    }

    /// @dev A starved listener `onRebalance` (the Sepolia out-of-gas) now reverts the whole
    ///      rebalance instead of completing it with the reservation stranded.
    function test_FailClosed_AStarvedRebalanceReverts() public {
        uint256 tokenId = _join();
        (, uint256 owedLp,,,) = bonusVault.lpReservation(tokenId);
        mathVault.setBonusEscrow(address(0));
        // Enough for the whole rebalance without the listener, not for the listener's work.
        uint256 gasForAll = _rebalanceGasUpToListener(tokenId);
        vm.prank(alice);
        vm.expectRevert();
        mathVault.rebalance{gas: gasForAll}(
            tokenId, PRICE_TICK - 6932, PRICE_TICK + 6932, _noSwapParams(), FAR_DEADLINE
        );
        assertEq(mathVault.stakerOf(tokenId), alice);
        (address user, uint256 amount,,,) = bonusVault.lpReservation(tokenId);
        assertEq(user, alice);
        assertEq(amount, owedLp);
    }

    /// @dev The gas a whole rebalance needs with the listener off.
    function _rebalanceGasUpToListener(uint256 tokenId) internal returns (uint256) {
        uint256 snap = vm.snapshotState();
        // The real listener still owes and cannot be unlinked: put an idle one under its address.
        vm.etch(address(bonusVault), address(new RevertingListener()).code);
        mathVault.setBonusListener(address(0));
        vm.prank(alice);
        uint256 before = gasleft();
        mathVault.rebalance(tokenId, PRICE_TICK - 6932, PRICE_TICK + 6932, _noSwapParams(), FAR_DEADLINE);
        uint256 used = before - gasleft();
        vm.revertToState(snap);
        return used;
    }

    function test_Unlinked_NoNotification() public {
        StakingMigrator.Voucher memory v = _voucher(migrator, alice, 2, PRINCIPAL, REWARD, 1);
        vm.prank(alice);
        uint256 tokenId = migrator.moveToLp(REWARD, PRINCIPAL, 0, 0, FAR_DEADLINE, _noPermit(), _noPermit(), v);
        // Unlink by etching an empty-owing listener first, then clearing.
        RevertingListener idle = new RevertingListener();
        vm.etch(address(bonusVault), address(idle).code);
        mathVault.setBonusListener(address(0));
        vm.recordLogs();
        vm.prank(alice);
        mathVault.unstake(tokenId);
        assertEq(mathNpm.ownerOf(tokenId), alice);
    }

    // ──────────────────────── Gas measurement ──────────────────

    /// @dev The listener's two hooks, measured from the caller. `onUnstake` runs inside the
    ///      allowance the vault forwards; `onRebalance` (fail closed since 2026-11-10, all the
    ///      remaining gas) is still held to the old figure as a cost regression guard. The
    ///      rebalance one reads the vault's TWAP and values two positions.
    function test_HookGas_TheListenerFitsTheAllowance() public {
        uint256 tokenId = _join();
        (,,,,, int24 lower, int24 upper, uint128 liq,,,,) = mathNpm.positions(tokenId);
        IBonusEscrowHooks.Snapshot memory o = IBonusEscrowHooks.Snapshot(lower, upper, liq);
        IBonusEscrowHooks.Snapshot memory n = IBonusEscrowHooks.Snapshot(lower, upper, liq / 2);

        uint256 snap = vm.snapshotState();
        vm.prank(address(mathVault));
        uint256 before = gasleft();
        bonusVault.onRebalance(tokenId, 999_999, o, n);
        uint256 usedRebalance = before - gasleft();
        vm.revertToState(snap);

        vm.prank(address(mathVault));
        before = gasleft();
        bonusVault.onUnstake(tokenId);
        uint256 usedUnstake = before - gasleft();

        console.log("listener onRebalance gas (caller-measured)", usedRebalance);
        console.log("listener onUnstake gas (caller-measured)", usedUnstake);
        // The coverage build is unoptimized and instrumented (measured 180,550 there): it only has
        // to stay inside the allowance; the optimized build has to leave half of it free.
        bool coverage = vm.isContext(VmSafe.ForgeContext.Coverage);
        // Held to the OLD fixed 250,000: Foundry prices gas by the pre-Glamsterdam schedule and
        // cannot reproduce EIP-8037 (audit notes item 20); the live vault forwards
        // `bonusListenerGas()` (default 1,000,000) and `scripts/measure-hook-gas.js` measures it.
        uint256 allowance = 250_000;
        assertLt(usedRebalance, coverage ? allowance * 4 / 5 : allowance / 2, "rebalance hook inside the allowance");
        assertLt(usedUnstake, allowance / 10, "unstake hook far inside the allowance");
    }
}
