// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {StakingV3Harness} from "../utils/StakingV3Harness.sol";
import {V3BonusVault} from "../../../contracts/staking-v3/V3BonusVault.sol";
import {LPProxy} from "../../../contracts/lp-staking/deploy/LPProxy.sol";
import {IBonusEscrowHooks} from "../../../contracts/lp-staking/interfaces/IBonusEscrowHooks.sol";
import {PositionValue} from "../../../contracts/lp-staking/libraries/PositionValue.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @notice {V3BonusVault} as a book: every gate (who may reserve, report, fund, recover), every
 *         boundary (`now < unlockAt`, `balance >= amount`, `balance > totalReserved`) and the
 *         rebalance scaling, with hand-built snapshots valued at the math rung's TWAP.
 *
 *  The book under test has `carol` as its migrator and `poolStub` as its pool, so both callers are
 *  plain pranks; its vault is the real math-rung vault, whose `previewTwap` the scaling reads.
 */
contract V3BonusVaultTest is StakingV3Harness {
    V3BonusVault internal book;
    address internal poolStub;

    uint256 internal constant BONUS = 100e18;
    uint64 internal constant UNLOCK = 1_000_000;
    uint256 internal constant ID1 = 101;
    uint256 internal constant ID2 = 102;
    uint256 internal constant ID3 = 103;
    uint128 internal constant L = 1e20;

    function setUp() public {
        _deployStakingV3();
        poolStub = makeAddr("poolStub");
        book = _deployBonusVault(address(asset), carol, poolStub, address(mathVault));
        vm.warp(1);
        asset.approve(address(book), type(uint256).max);
    }

    function _snap(uint128 liquidity) internal pure returns (IBonusEscrowHooks.Snapshot memory) {
        return IBonusEscrowHooks.Snapshot({tickLower: START_LOWER, tickUpper: START_UPPER, liquidity: liquidity});
    }

    function _value(uint128 liquidity) internal pure returns (uint256) {
        return PositionValue.valueAt(liquidity, START_LOWER, START_UPPER, PRICE_TICK, true);
    }

    function _reserveLp(uint256 id, address user, uint256 amount) internal {
        vm.prank(carol);
        book.reserveLp(id, user, amount, UNLOCK);
    }

    /// @dev The math vault reports `user` as the staker of `id` (the book's LP records pay only
    ///      while the vault holds the position for their user, or once settled).
    function _holdFor(uint256 id, address user) internal {
        vm.mockCall(address(mathVault), abi.encodeCall(mathVault.stakerOf, (id)), abi.encode(user));
    }

    /// @dev The math vault reports that its fail-open `onUnstake` to the listener was first missed
    ///      for `id` at `at` (`listenerMissedAt`, review closure 2026-11-10).
    function _missedAt(uint256 id, uint64 at) internal {
        vm.mockCall(address(mathVault), abi.encodeCall(mathVault.listenerMissedAt, (id)), abi.encode(at));
    }

    function _reserve(address user, uint256 amount) internal {
        vm.prank(carol);
        book.reserve(user, amount, UNLOCK, 3);
    }

    // ──────────────────────── Initialization ───────────────────

    function test_Initialize_RecordsEverythingAndAnnouncesIt() public view {
        assertEq(book.bonusToken(), address(asset));
        assertEq(book.migrator(), carol);
        assertEq(book.pool(), poolStub);
        assertEq(book.vault(), address(mathVault));
        assertEq(book.owner(), address(this));
        assertEq(book.totalReserved(), 0);
        assertEq(book.totalLpReserved(), 0);
        assertEq(book.maxTotalReserved(), DEFAULT_BUDGET);
    }

    function test_Initialize_AnnouncesTheBudget() public {
        V3BonusVault impl = new V3BonusVault();
        vm.expectEmit();
        emit V3BonusVault.MaxTotalReservedSet(0, 5 * BONUS);
        V3BonusVault b = V3BonusVault(
            address(
                new LPProxy(
                    address(impl),
                    abi.encodeCall(
                        V3BonusVault.initialize, (address(this), address(asset), carol, poolStub, address(0), 5 * BONUS)
                    )
                )
            )
        );
        assertEq(b.maxTotalReserved(), 5 * BONUS);
    }

    function test_Initialize_RejectsZeroTokenOrPool() public {
        V3BonusVault impl = new V3BonusVault();
        vm.expectRevert(V3BonusVault.ZeroAddress.selector);
        new LPProxy(
            address(impl),
            abi.encodeCall(
                V3BonusVault.initialize, (address(this), address(0), carol, poolStub, address(0), DEFAULT_BUDGET)
            )
        );
        vm.expectRevert(V3BonusVault.ZeroAddress.selector);
        new LPProxy(
            address(impl),
            abi.encodeCall(
                V3BonusVault.initialize, (address(this), address(asset), carol, address(0), address(0), DEFAULT_BUDGET)
            )
        );
    }

    function test_Initialize_ImplementationIsLocked() public {
        V3BonusVault impl = new V3BonusVault();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(address(this), address(asset), carol, poolStub, address(0), DEFAULT_BUDGET);
    }

    function test_SetVault_RejectsAVaultWithoutTheBonusToken() public {
        V3BonusVault other = _deployBonusVault(address(overture), carol, poolStub, address(0));
        vm.expectRevert(
            abi.encodeWithSelector(V3BonusVault.BonusTokenNotInPool.selector, address(overture), token0, token1)
        );
        other.setVault(address(mathVault));
    }

    function test_SetVault_OrientsTheValuation() public {
        _deployFlippedRung();
        V3BonusVault flipped = _deployBonusVault(address(flippedAsset), carol, poolStub, address(0));
        vm.expectEmit(address(flipped));
        emit V3BonusVault.VaultSet(address(0), address(flippedVault));
        flipped.setVault(address(flippedVault));
        assertEq(flipped.vault(), address(flippedVault));
        // $ASSET as token1: a rebalance to a smaller position scales down by the token1 valuation.
        vm.prank(carol);
        flipped.reserveLp(ID1, alice, BONUS, UNLOCK);
        IBonusEscrowHooks.Snapshot memory o =
            IBonusEscrowHooks.Snapshot({tickLower: -START_UPPER, tickUpper: -START_LOWER, liquidity: L});
        IBonusEscrowHooks.Snapshot memory n =
            IBonusEscrowHooks.Snapshot({tickLower: -START_UPPER, tickUpper: -START_LOWER, liquidity: L / 4});
        vm.prank(address(flippedVault));
        flipped.onRebalance(ID1, ID2, o, n);
        (, uint256 amount,,,) = flipped.lpReservation(ID2);
        uint256 vo = PositionValue.valueAt(L, -START_UPPER, -START_LOWER, -PRICE_TICK, false);
        uint256 vn = PositionValue.valueAt(L / 4, -START_UPPER, -START_LOWER, -PRICE_TICK, false);
        assertEq(amount, Math.mulDiv(BONUS, vn, vo));
    }

    function test_Setters_AreOwnerOnlyAndAnnounced() public {
        vm.expectEmit(address(book));
        emit V3BonusVault.MigratorSet(carol, bob);
        book.setMigrator(bob);
        vm.expectEmit(address(book));
        emit V3BonusVault.PoolSet(poolStub, bob);
        book.setPool(bob);
        vm.expectRevert(V3BonusVault.ZeroAddress.selector);
        book.setPool(address(0));
        book.setVault(address(0));
        assertEq(book.vault(), address(0));

        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        book.setMigrator(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        book.setPool(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        book.setVault(stranger);
        vm.stopPrank();
    }

    function test_Owner_RenounceDisabledUpgradeOwnerOnly() public {
        vm.expectRevert(V3BonusVault.RenounceDisabled.selector);
        book.renounceOwnership();
        V3BonusVault impl = new V3BonusVault();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        book.upgradeToAndCall(address(impl), "");
        _reserve(alice, BONUS);
        book.upgradeToAndCall(address(impl), "");
        (uint256 amount,) = book.reservedOf(alice);
        assertEq(amount, BONUS, "reservations survive the upgrade");
    }

    // ──────────────────────── reserve / reserveLp ──────────────

    function test_Reserve_OnlyTheMigrator() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(V3BonusVault.NotMigrator.selector, stranger, carol));
        book.reserve(alice, BONUS, UNLOCK, 1);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(V3BonusVault.NotMigrator.selector, stranger, carol));
        book.reserveLp(ID1, alice, BONUS, UNLOCK);
    }

    function test_Reserve_RejectsZeroUserOrAmount() public {
        vm.startPrank(carol);
        vm.expectRevert(V3BonusVault.ZeroAddress.selector);
        book.reserve(address(0), BONUS, UNLOCK, 1);
        vm.expectRevert(V3BonusVault.ZeroAmount.selector);
        book.reserve(alice, 0, UNLOCK, 1);
        vm.expectRevert(V3BonusVault.ZeroAddress.selector);
        book.reserveLp(ID1, address(0), BONUS, UNLOCK);
        vm.expectRevert(V3BonusVault.ZeroAmount.selector);
        book.reserveLp(ID1, alice, 0, UNLOCK);
        vm.stopPrank();
    }

    function test_Reserve_AccumulatesAndTheUnlockOnlyMovesLater() public {
        vm.startPrank(carol);
        vm.expectEmit(address(book));
        emit V3BonusVault.BonusReserved(alice, BONUS, UNLOCK, 1);
        book.reserve(alice, BONUS, UNLOCK, 1);
        book.reserve(alice, BONUS, UNLOCK - 10, 3);
        (uint256 amount, uint64 unlockAt) = book.reservedOf(alice);
        assertEq(amount, 2 * BONUS);
        assertEq(unlockAt, UNLOCK, "an earlier unlock never shortens it");
        book.reserve(alice, BONUS, UNLOCK + 10, 2);
        (, unlockAt) = book.reservedOf(alice);
        assertEq(unlockAt, UNLOCK + 10);
        vm.stopPrank();
        assertEq(book.totalReserved(), 3 * BONUS);
    }

    function test_ReserveLp_OnePerTokenId() public {
        vm.expectEmit(address(book));
        emit V3BonusVault.LpBonusReserved(ID1, alice, BONUS, UNLOCK);
        _reserveLp(ID1, alice, BONUS);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(V3BonusVault.DuplicateReservation.selector, ID1));
        book.reserveLp(ID1, bob, BONUS, UNLOCK);
        assertEq(book.totalReserved(), BONUS);
    }

    // ──────────────────────── onEarlyExit ──────────────────────

    function test_EarlyExit_OnlyThePool() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(V3BonusVault.NotPool.selector, stranger, poolStub));
        book.onEarlyExit(alice);
    }

    function test_EarlyExit_ForfeitsTheWholeV3ReservationButNoLpOne() public {
        _reserve(alice, BONUS);
        _reserve(alice, BONUS);
        _reserveLp(ID1, alice, BONUS);
        vm.expectEmit(address(book));
        emit V3BonusVault.BonusForfeited(alice, 2 * BONUS);
        vm.prank(poolStub);
        book.onEarlyExit(alice);
        (uint256 amount,) = book.reservedOf(alice);
        assertEq(amount, 0);
        assertEq(book.totalReserved(), BONUS, "the LP reservation is untouched");
        (, uint256 lpAmount,,, bool forfeited) = book.lpReservation(ID1);
        assertEq(lpAmount, BONUS);
        assertFalse(forfeited);
    }

    function test_EarlyExit_IsANoOpWithoutReservationOrAfterTheUnlock() public {
        vm.prank(poolStub);
        book.onEarlyExit(alice);
        _reserve(alice, BONUS);
        vm.warp(UNLOCK);
        vm.prank(poolStub);
        book.onEarlyExit(alice);
        (uint256 amount,) = book.reservedOf(alice);
        assertEq(amount, BONUS, "at the unlock it is no longer forfeitable");
    }

    // ──────────────────────── onUnstake ────────────────────────

    function test_OnUnstake_OnlyTheVault() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(V3BonusVault.NotVault.selector, stranger, address(mathVault)));
        book.onUnstake(ID1);
    }

    function test_OnUnstake_ForfeitsAnActiveReservation() public {
        _reserveLp(ID1, alice, BONUS);
        vm.expectEmit(address(book));
        emit V3BonusVault.LpBonusForfeited(ID1, alice, BONUS);
        vm.prank(address(mathVault));
        book.onUnstake(ID1);
        (address user, uint256 amount,,, bool forfeited) = book.lpReservation(ID1);
        assertEq(user, alice);
        assertEq(amount, 0);
        assertTrue(forfeited);
        assertEq(book.totalReserved(), 0);
        // A second report changes nothing.
        vm.prank(address(mathVault));
        book.onUnstake(ID1);
        assertEq(book.totalReserved(), 0);
    }

    function test_OnUnstake_UnknownIsANoOpMaturedSettles() public {
        vm.recordLogs();
        vm.prank(address(mathVault));
        book.onUnstake(ID3);
        assertEq(vm.getRecordedLogs().length, 0, "unknown: nothing");
        assertFalse(book.lpSettled(ID3));
        _reserveLp(ID1, alice, BONUS);
        vm.warp(UNLOCK);
        vm.expectEmit(address(book));
        emit V3BonusVault.LpBonusSettled(ID1, alice);
        vm.prank(address(mathVault));
        book.onUnstake(ID1);
        assertTrue(book.lpSettled(ID1));
        assertEq(book.totalLpReserved(), BONUS, "a settlement moves no total");
        assertEq(book.claimable(alice), BONUS, "after the unlock an unstake settles it: claimable");
        // A second report does not settle twice.
        vm.recordLogs();
        vm.prank(address(mathVault));
        book.onUnstake(ID1);
        assertEq(vm.getRecordedLogs().length, 0, "settled once");
    }

    function test_OnUnstake_AClaimedOrForfeitedRecordIsNeverSettled() public {
        _reserveLp(ID1, alice, BONUS);
        _reserveLp(ID2, alice, BONUS);
        vm.prank(address(mathVault));
        book.onUnstake(ID2); // forfeited before the unlock
        _holdFor(ID1, alice);
        book.fund(BONUS);
        vm.warp(UNLOCK);
        vm.prank(alice);
        book.claim();
        vm.recordLogs();
        vm.startPrank(address(mathVault));
        book.onUnstake(ID1);
        book.onUnstake(ID2);
        book.onRebalance(ID1, ID3, _snap(L), _snap(L));
        vm.stopPrank();
        assertEq(vm.getRecordedLogs().length, 0);
        assertFalse(book.lpSettled(ID1));
        assertFalse(book.lpSettled(ID2));
    }

    // ──────────────────────── onRebalance ──────────────────────

    function test_OnRebalance_OnlyTheVault() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(V3BonusVault.NotVault.selector, stranger, address(mathVault)));
        book.onRebalance(ID1, ID2, _snap(L), _snap(L));
    }

    function test_OnRebalance_MovesAndScalesDown() public {
        _reserveLp(ID1, alice, BONUS);
        uint256 expected = Math.mulDiv(BONUS, _value(L / 3), _value(L));
        vm.expectEmit(address(book));
        emit V3BonusVault.LpBonusMoved(ID1, ID2, alice, BONUS, expected);
        vm.prank(address(mathVault));
        book.onRebalance(ID1, ID2, _snap(L), _snap(L / 3));

        (address oldUser,,,,) = book.lpReservation(ID1);
        assertEq(oldUser, address(0), "the old id is gone");
        (address user, uint256 amount, uint64 unlockAt,, bool forfeited) = book.lpReservation(ID2);
        assertEq(user, alice);
        assertEq(amount, expected);
        assertEq(unlockAt, UNLOCK);
        assertFalse(forfeited);
        assertEq(book.totalReserved(), expected);
        uint256[] memory ids = book.lpTokensOf(alice);
        assertEq(ids.length, 1);
        assertEq(ids[0], ID2, "the list entry is rewritten in place");
    }

    function test_OnRebalance_NeverScalesAboveTheOriginal() public {
        _reserveLp(ID1, alice, BONUS);
        vm.prank(address(mathVault));
        book.onRebalance(ID1, ID2, _snap(L), _snap(L * 5));
        (, uint256 amount,,,) = book.lpReservation(ID2);
        assertEq(amount, BONUS);
    }

    function test_OnRebalance_AWorthlessOldPositionForfeits() public {
        _reserveLp(ID1, alice, BONUS);
        vm.prank(address(mathVault));
        book.onRebalance(ID1, ID2, _snap(0), _snap(L));
        (, uint256 amount,,, bool forfeited) = book.lpReservation(ID2);
        assertEq(amount, 0);
        assertTrue(forfeited);
        assertEq(book.totalReserved(), 0);
    }

    function test_OnRebalance_RefusesToOverwriteAReservation() public {
        _reserveLp(ID1, alice, BONUS);
        _reserveLp(ID2, bob, BONUS);
        vm.prank(address(mathVault));
        vm.expectRevert(abi.encodeWithSelector(V3BonusVault.DuplicateReservation.selector, ID2));
        book.onRebalance(ID1, ID2, _snap(L), _snap(L));
    }

    function test_OnRebalance_UnknownIsANoOpMaturedSettlesUnderTheOldId() public {
        vm.prank(address(mathVault));
        book.onRebalance(ID3, ID2, _snap(L), _snap(L));
        assertFalse(book.lpSettled(ID3));
        _reserveLp(ID1, alice, BONUS);
        vm.warp(UNLOCK);
        vm.expectEmit(address(book));
        emit V3BonusVault.LpBonusSettled(ID1, alice);
        vm.prank(address(mathVault));
        book.onRebalance(ID1, ID2, _snap(L), _snap(1));
        (, uint256 amount,,,) = book.lpReservation(ID1);
        assertEq(amount, BONUS, "a post-unlock rebalance leaves it under the old id, unscaled");
        (address moved,,,,) = book.lpReservation(ID2);
        assertEq(moved, address(0));
        assertTrue(book.lpSettled(ID1));
        assertEq(book.claimable(alice), BONUS, "settled: pays without the vault");
    }

    function test_OnRebalance_KeepsTheOtherEntriesOfTheList() public {
        _reserveLp(ID1, alice, BONUS);
        _reserveLp(ID2, alice, BONUS);
        vm.prank(address(mathVault));
        book.onRebalance(ID1, ID3, _snap(L), _snap(L));
        uint256[] memory ids = book.lpTokensOf(alice);
        assertEq(ids.length, 2);
        assertEq(ids[0], ID3);
        assertEq(ids[1], ID2);
    }

    // ──────────────────────── fund / claim ─────────────────────

    function test_Fund_AnyoneAndAnnounced() public {
        vm.expectRevert(V3BonusVault.ZeroAmount.selector);
        book.fund(0);
        vm.expectEmit(address(book));
        emit V3BonusVault.Funded(address(this), BONUS, BONUS);
        book.fund(BONUS);
        assertEq(asset.balanceOf(address(book)), BONUS);
    }

    function test_Claim_PaysV3AndLpOnceUnlocked() public {
        _reserve(alice, BONUS);
        _reserveLp(ID1, alice, 2 * BONUS);
        _reserveLp(ID2, alice, 3 * BONUS);
        vm.prank(address(mathVault));
        book.onUnstake(ID2); // forfeited before the unlock
        _holdFor(ID1, alice);
        book.fund(10 * BONUS);

        vm.prank(alice);
        vm.expectRevert(V3BonusVault.NothingToClaim.selector);
        book.claim();
        assertEq(book.claimable(alice), 0);

        vm.warp(UNLOCK);
        assertEq(book.claimable(alice), 3 * BONUS);
        uint256 before = asset.balanceOf(alice);
        vm.expectEmit(address(book));
        emit V3BonusVault.BonusClaimed(alice, 3 * BONUS);
        vm.prank(alice);
        assertEq(book.claim(), 3 * BONUS);
        assertEq(asset.balanceOf(alice) - before, 3 * BONUS);
        assertEq(book.totalReserved(), 0);
        (,,, bool claimed,) = book.lpReservation(ID1);
        assertTrue(claimed);

        vm.prank(alice);
        vm.expectRevert(V3BonusVault.NothingToClaim.selector);
        book.claim();
        assertEq(book.claimable(alice), 0);
    }

    function test_Claim_RevertsAllOrNothingWhenShort() public {
        _reserve(alice, BONUS);
        _reserveLp(ID1, alice, BONUS);
        _holdFor(ID1, alice);
        book.fund(BONUS);
        vm.warp(UNLOCK);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(V3BonusVault.InsufficientFunds.selector, 2 * BONUS, BONUS));
        book.claim();
        (uint256 amount,) = book.reservedOf(alice);
        assertEq(amount, BONUS, "nothing changed");
        book.fund(BONUS);
        vm.prank(alice);
        book.claim();
    }

    function test_Claim_AStaleLpRecordPaysNothing() public {
        // ID1 is not staked in the math vault (stakerOf == 0) and was never settled: stale.
        _reserve(alice, BONUS);
        _reserveLp(ID1, alice, 2 * BONUS);
        _reserveLp(ID2, alice, 3 * BONUS);
        _holdFor(ID2, bob); // held, but for someone else: stale too
        book.fund(10 * BONUS);
        vm.warp(UNLOCK);
        assertEq(book.claimable(alice), BONUS, "only the v3 part");
        vm.prank(alice);
        assertEq(book.claim(), BONUS);
        (,,, bool claimed1,) = book.lpReservation(ID1);
        (,,, bool claimed2,) = book.lpReservation(ID2);
        assertFalse(claimed1);
        assertFalse(claimed2);
        assertEq(book.totalLpReserved(), 5 * BONUS, "left for reconcileLp");
        vm.prank(alice);
        vm.expectRevert(V3BonusVault.NothingToClaim.selector);
        book.claim();
    }

    function test_Claim_AnUnlinkedBookPaysOnlySettledRecords() public {
        V3BonusVault unlinked = _deployBonusVault(address(asset), carol, poolStub, address(0));
        vm.prank(carol);
        unlinked.reserveLp(ID1, alice, BONUS, UNLOCK);
        vm.warp(UNLOCK);
        assertEq(unlinked.claimable(alice), 0, "no vault to say who holds it");
    }

    function test_Claim_OnlyTheCallersReservations() public {
        _reserve(alice, BONUS);
        book.fund(BONUS);
        vm.warp(UNLOCK);
        vm.prank(bob);
        vm.expectRevert(V3BonusVault.NothingToClaim.selector);
        book.claim();
    }

    // ──────────────────────── recoverSurplus ───────────────────

    function test_RecoverSurplus_OnlyTheSurplus() public {
        _reserve(alice, BONUS);
        vm.expectRevert(V3BonusVault.NoSurplus.selector);
        book.recoverSurplus(bob, 1);
        book.fund(3 * BONUS);
        vm.expectRevert(abi.encodeWithSelector(V3BonusVault.SurplusExceeded.selector, 2 * BONUS + 1, 2 * BONUS));
        book.recoverSurplus(bob, 2 * BONUS + 1);
        vm.expectRevert(V3BonusVault.ZeroAddress.selector);
        book.recoverSurplus(address(0), 1);
        vm.expectRevert(V3BonusVault.ZeroAmount.selector);
        book.recoverSurplus(bob, 0);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        book.recoverSurplus(bob, 1);

        vm.expectEmit(address(book));
        emit V3BonusVault.SurplusRecovered(bob, 2 * BONUS);
        book.recoverSurplus(bob, 2 * BONUS);
        assertEq(asset.balanceOf(bob), USER_ASSET + 2 * BONUS);
        vm.expectRevert(V3BonusVault.NoSurplus.selector);
        book.recoverSurplus(bob, 1);
    }

    function test_RecoverSurplus_AForfeitureBecomesSurplus() public {
        _reserve(alice, BONUS);
        book.fund(BONUS);
        vm.prank(poolStub);
        book.onEarlyExit(alice);
        book.recoverSurplus(bob, BONUS);
        assertEq(asset.balanceOf(address(book)), 0);
    }

    // ──────────────────────── The budget (maxTotalReserved) ───

    function test_Budget_ReserveAndReserveLpStopAtTheCap() public {
        V3BonusVault capped = _deployBonusVault(address(asset), carol, poolStub, address(mathVault), 2 * BONUS);
        vm.startPrank(carol);
        capped.reserve(alice, BONUS, UNLOCK, 1);
        capped.reserveLp(ID1, alice, BONUS, UNLOCK);
        assertEq(capped.totalReserved(), 2 * BONUS, "exactly the cap is allowed");
        vm.expectRevert(abi.encodeWithSelector(V3BonusVault.BudgetExceeded.selector, 1, 0));
        capped.reserve(bob, 1, UNLOCK, 3);
        vm.expectRevert(abi.encodeWithSelector(V3BonusVault.BudgetExceeded.selector, 1, 0));
        capped.reserveLp(ID2, bob, 1, UNLOCK);
        vm.stopPrank();
    }

    function test_Budget_ReportsTheRemainingRoom() public {
        V3BonusVault capped = _deployBonusVault(address(asset), carol, poolStub, address(mathVault), 2 * BONUS);
        vm.startPrank(carol);
        capped.reserve(alice, BONUS + 1, UNLOCK, 1);
        vm.expectRevert(abi.encodeWithSelector(V3BonusVault.BudgetExceeded.selector, BONUS, BONUS - 1));
        capped.reserveLp(ID1, alice, BONUS, UNLOCK);
        vm.stopPrank();
    }

    function test_Budget_AForfeitureFreesRoom() public {
        V3BonusVault capped = _deployBonusVault(address(asset), carol, poolStub, address(mathVault), BONUS);
        vm.prank(carol);
        capped.reserveLp(ID1, alice, BONUS, UNLOCK);
        vm.prank(address(mathVault));
        capped.onUnstake(ID1);
        vm.prank(carol);
        capped.reserve(bob, BONUS, UNLOCK, 3);
        assertEq(capped.totalReserved(), BONUS);
    }

    function test_SetMaxTotalReserved_OwnerOnlyAnnouncedAndBelowTheTotalStopsNewOnes() public {
        _reserve(alice, BONUS);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        book.setMaxTotalReserved(0);

        vm.expectEmit(address(book));
        emit V3BonusVault.MaxTotalReservedSet(DEFAULT_BUDGET, BONUS / 2);
        book.setMaxTotalReserved(BONUS / 2);
        assertEq(book.maxTotalReserved(), BONUS / 2);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(V3BonusVault.BudgetExceeded.selector, 1, 0));
        book.reserve(bob, 1, UNLOCK, 3);
        (uint256 amount,) = book.reservedOf(alice);
        assertEq(amount, BONUS, "an existing reservation is untouched");

        book.setMaxTotalReserved(2 * BONUS);
        _reserve(bob, BONUS);
        assertEq(book.totalReserved(), 2 * BONUS);
    }

    // ──────────────────────── totalLpReserved ──────────────────

    function test_TotalLpReserved_FollowsEveryLpWriteAndOnlyThose() public {
        _reserve(alice, BONUS);
        assertEq(book.totalLpReserved(), 0, "a v3 reservation is not LP");
        _reserveLp(ID1, alice, BONUS);
        _reserveLp(ID2, bob, BONUS);
        assertEq(book.totalLpReserved(), 2 * BONUS);

        uint256 scaled = Math.mulDiv(BONUS, _value(L / 2), _value(L));
        vm.prank(address(mathVault));
        book.onRebalance(ID1, ID3, _snap(L), _snap(L / 2));
        assertEq(book.totalLpReserved(), BONUS + scaled, "a down-scaling lowers it");
        _holdFor(ID3, alice);

        vm.prank(address(mathVault));
        book.onUnstake(ID2);
        assertEq(book.totalLpReserved(), scaled, "a forfeiture lowers it");

        book.fund(10 * BONUS);
        vm.warp(UNLOCK);
        vm.prank(alice);
        book.claim();
        assertEq(book.totalLpReserved(), 0, "a claim lowers it by the LP part only");
        assertEq(book.totalReserved(), 0);
    }

    // ──────────────────────── setVault while LP is owed ────────

    function test_SetVault_RefusedWhileAnLpReservationIsOutstanding() public {
        _reserveLp(ID1, alice, BONUS);
        vm.expectRevert(abi.encodeWithSelector(V3BonusVault.LpReservationsOutstanding.selector, BONUS));
        book.setVault(address(0));
        vm.expectRevert(abi.encodeWithSelector(V3BonusVault.LpReservationsOutstanding.selector, BONUS));
        book.setVault(address(mathVault));

        vm.prank(address(mathVault));
        book.onUnstake(ID1);
        book.setVault(address(0));
        assertEq(book.vault(), address(0));
    }

    function test_SetVault_AV3ReservationDoesNotHoldIt() public {
        _reserve(alice, BONUS);
        book.setVault(address(0));
        assertEq(book.vault(), address(0));
    }

    // ──────────────────────── reconcileLp ──────────────────────

    function test_ReconcileLp_ForfeitsAReservationTheVaultNoLongerHolds() public {
        // ID1 is not staked in the math vault: stakerOf(ID1) == 0 != alice.
        _reserveLp(ID1, alice, BONUS);
        vm.expectEmit(address(book));
        emit V3BonusVault.LpBonusForfeited(ID1, alice, BONUS);
        vm.prank(stranger);
        assertTrue(book.reconcileLp(ID1), "anyone may call");
        (, uint256 amount,,, bool forfeited) = book.lpReservation(ID1);
        assertEq(amount, 0);
        assertTrue(forfeited);
        assertEq(book.totalReserved(), 0);
        assertEq(book.totalLpReserved(), 0);
        assertFalse(book.reconcileLp(ID1), "a second call is a no-op");
    }

    function test_ReconcileLp_NoOpForUnknownHeldSettledOrUnlinked() public {
        assertFalse(book.reconcileLp(ID3), "no reservation");
        _reserveLp(ID1, alice, BONUS);
        _holdFor(ID1, alice);
        assertFalse(book.reconcileLp(ID1), "held before the unlock");
        vm.warp(UNLOCK);
        assertFalse(book.reconcileLp(ID1), "held after the unlock");
        assertEq(book.totalLpReserved(), BONUS);

        _reserveLp(ID2, alice, BONUS);
        vm.prank(address(mathVault));
        book.onUnstake(ID2); // after the unlock: settled
        assertFalse(book.reconcileLp(ID2), "a settled record is never touched");
        assertEq(book.totalLpReserved(), 2 * BONUS);

        V3BonusVault unlinked = _deployBonusVault(address(asset), carol, poolStub, address(0));
        vm.prank(carol);
        unlinked.reserveLp(ID2, alice, BONUS, UNLOCK + 1);
        assertFalse(unlinked.reconcileLp(ID2), "no vault to ask");
        assertEq(unlinked.totalLpReserved(), BONUS);
    }

    function test_ReconcileLp_AfterTheUnlockForfeitsAStaleRecord() public {
        _reserveLp(ID1, alice, BONUS);
        book.fund(BONUS);
        vm.warp(UNLOCK);
        vm.expectEmit(address(book));
        emit V3BonusVault.LpBonusForfeited(ID1, alice, BONUS);
        vm.prank(stranger);
        assertTrue(book.reconcileLp(ID1));
        assertEq(book.totalReserved(), 0);
        assertEq(book.totalLpReserved(), 0);
        assertEq(asset.balanceOf(address(book)), BONUS, "the tokens stay, as surplus");
        assertFalse(book.reconcileLp(ID1));
        assertFalse(book.lpSettled(ID1));
    }

    // ──────────────────────── listenerMissedAt: dead / missed-after ─

    /// @dev DEAD (missed before the unlock): never pays, even while the vault holds the NFT for
    ///      the user again; MISSED-AFTER (missed at or after the unlock): pays without the vault.
    function test_MissedAt_DeadNeverPaysMissedAfterPays() public {
        _reserveLp(ID1, alice, BONUS);
        _reserveLp(ID2, alice, BONUS);
        _holdFor(ID1, alice); // re-staked by the same user
        _missedAt(ID1, UNLOCK - 1);
        _missedAt(ID2, UNLOCK); // the boundary counts as "after"
        book.fund(2 * BONUS);
        vm.warp(UNLOCK);
        assertEq(book.claimable(alice), BONUS, "only the missed-after record");
        vm.prank(alice);
        assertEq(book.claim(), BONUS);
        (,,, bool claimed1,) = book.lpReservation(ID1);
        (,,, bool claimed2,) = book.lpReservation(ID2);
        assertFalse(claimed1, "the dead record is skipped");
        assertTrue(claimed2);
    }

    function test_MissedAt_AnAfterUnlockNotificationForfeitsADeadRecord() public {
        _reserveLp(ID1, alice, BONUS);
        _reserveLp(ID2, alice, BONUS);
        _missedAt(ID1, UNLOCK - 1);
        _missedAt(ID2, UNLOCK - 1);
        vm.warp(UNLOCK);
        vm.expectEmit(address(book));
        emit V3BonusVault.LpBonusForfeited(ID1, alice, BONUS);
        vm.prank(address(mathVault));
        book.onUnstake(ID1);
        vm.expectEmit(address(book));
        emit V3BonusVault.LpBonusForfeited(ID2, alice, BONUS);
        vm.prank(address(mathVault));
        book.onRebalance(ID2, ID3, _snap(L), _snap(L));
        assertFalse(book.lpSettled(ID1), "never settled");
        assertFalse(book.lpSettled(ID2));
        assertEq(book.totalLpReserved(), 0);
        assertEq(book.claimable(alice), 0);
    }

    function test_MissedAt_ARebalanceBeforeTheUnlockForfeitsADeadRecordInsteadOfMovingIt() public {
        _reserveLp(ID1, alice, BONUS);
        _missedAt(ID1, 1);
        vm.expectEmit(address(book));
        emit V3BonusVault.LpBonusForfeited(ID1, alice, BONUS);
        vm.prank(address(mathVault));
        book.onRebalance(ID1, ID2, _snap(L), _snap(L));
        (address moved,,,,) = book.lpReservation(ID2);
        assertEq(moved, address(0), "nothing moved to the new id");
        (, uint256 amount,,, bool forfeited) = book.lpReservation(ID1);
        assertEq(amount, 0);
        assertTrue(forfeited);
        assertEq(book.totalReserved(), 0);
    }

    function test_ReconcileLp_BeforeTheUnlockForfeitsADeadRecordEvenWhileHeld() public {
        _reserveLp(ID1, alice, BONUS);
        _holdFor(ID1, alice);
        _missedAt(ID1, 1);
        vm.expectEmit(address(book));
        emit V3BonusVault.LpBonusForfeited(ID1, alice, BONUS);
        assertTrue(book.reconcileLp(ID1));
        assertEq(book.totalLpReserved(), 0);
    }

    function test_ReconcileLp_AfterTheUnlockForfeitsDeadSettlesMissedAfter() public {
        _reserveLp(ID1, alice, BONUS);
        _reserveLp(ID2, alice, BONUS);
        _holdFor(ID1, alice);
        _missedAt(ID1, UNLOCK - 1);
        _missedAt(ID2, UNLOCK + 5);
        vm.warp(UNLOCK + 10);

        assertTrue(book.reconcileLp(ID1), "dead: forfeited whoever holds the NFT");

        vm.expectEmit(address(book));
        emit V3BonusVault.LpBonusSettled(ID2, alice);
        vm.prank(stranger);
        assertFalse(book.reconcileLp(ID2), "missed-after: settled, not forfeited");
        assertTrue(book.lpSettled(ID2));
        vm.recordLogs();
        assertFalse(book.reconcileLp(ID2));
        assertEq(vm.getRecordedLogs().length, 0, "settled once, then never touched");

        book.fund(BONUS);
        vm.prank(alice);
        assertEq(book.claim(), BONUS);
        vm.prank(alice);
        vm.expectRevert(V3BonusVault.NothingToClaim.selector);
        book.claim();
    }

    // ──────────────────────── Storage ──────────────────────────

    function test_Storage_TheNamespaceIsPinned() public view {
        bytes32 slot = keccak256(abi.encode(uint256(keccak256("real.staking.storage.V3BonusVault")) - 1))
            & ~bytes32(uint256(0xff));
        assertEq(slot, 0x7ee3db96cd3f5364376de98c276fd460a05b617c20412712666abb0adcc73b00);
        assertEq(address(uint160(uint256(vm.load(address(book), slot)))), address(asset), "field 0 is the token");
    }

    /// @dev `lpSettled` is APPENDED in slot 10 of the namespace, after `totalLpReserved` in slot 9
    ///      (`vault` and `bonusIsToken0` share slot 3): the mapping's entry for `tokenId` lives at
    ///      keccak256(tokenId . (base + 10)).
    function test_Storage_LpSettledIsAppendedLast() public {
        bytes32 base = 0x7ee3db96cd3f5364376de98c276fd460a05b617c20412712666abb0adcc73b00;
        _reserveLp(ID1, alice, BONUS);
        _reserveLp(ID2, alice, 2 * BONUS);
        assertEq(uint256(vm.load(address(book), bytes32(uint256(base) + 9))), 3 * BONUS, "slot 9 = totalLpReserved");
        vm.warp(UNLOCK);
        vm.prank(address(mathVault));
        book.onUnstake(ID1);
        bytes32 entry = keccak256(abi.encode(ID1, uint256(base) + 10));
        assertEq(uint256(vm.load(address(book), entry)), 1, "slot 10 = lpSettled");
    }
}
