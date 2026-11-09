// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {console} from "forge-std/console.sol";

import {StakingV3Harness} from "../utils/StakingV3Harness.sol";
import {LPStakingVault} from "../../../contracts/lp-staking/LPStakingVault.sol";
import {StakingMigrator} from "../../../contracts/staking-v3/StakingMigrator.sol";
import {V3BonusVault} from "../../../contracts/staking-v3/V3BonusVault.sol";
import {IBonusEscrowHooks} from "../../../contracts/lp-staking/interfaces/IBonusEscrowHooks.sol";
import {SwapParams} from "../../../contracts/lp-staking/libraries/TwapGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @dev A listener that owes nothing and rejects every notification.
contract RevertingListener {
    uint256 public totalReserved;

    function setTotalReserved(uint256 value) external {
        totalReserved = value;
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

/**
 * @notice The vault's staking v3 bonus listener ({LPStakingVault-setBonusListener}): the owner-tier
 *         link with its code and reservation rules, the two FAIL-OPEN notifications with their gas
 *         floor, and the real flows on the math rung — a position joined through the migrator,
 *         re-ranged (the LP reservation moves and scales down) and unstaked (forfeited before the
 *         unlock, kept after it).
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
        uint256 owed = bonusVault.totalReserved();
        assertGt(lpAmount, 0);
        vm.expectRevert(
            abi.encodeWithSelector(LPStakingVault.ListenerHasReservations.selector, address(bonusVault), owed)
        );
        mathVault.setBonusListener(address(0));
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
        uint256 totalBefore = bonusVault.totalReserved();
        vm.expectEmit(address(bonusVault));
        emit V3BonusVault.LpBonusForfeited(tokenId, alice, owedLp);
        vm.prank(alice);
        mathVault.unstake(tokenId);
        assertEq(bonusVault.totalReserved(), totalBefore - owedLp);
        assertEq(mathNpm.ownerOf(tokenId), alice);
    }

    function test_Unstake_AfterTheUnlockKeepsItClaimable() public {
        uint256 tokenId = _join();
        (, uint256 owedLp,,,) = bonusVault.lpReservation(tokenId);
        (uint256 owedV3,) = bonusVault.reservedOf(alice);
        vm.warp(v3End);
        vm.prank(alice);
        mathVault.unstake(tokenId);
        asset.approve(address(bonusVault), type(uint256).max);
        bonusVault.fund(owedLp + owedV3);
        vm.prank(alice);
        assertEq(bonusVault.claim(), owedLp + owedV3);
    }

    // ──────────────────────── Fail open ────────────────────────

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

    function test_FailOpen_ARebalanceCompletesWhenTheListenerReverts() public {
        uint256 tokenId = _join();
        RevertingListener bad = new RevertingListener();
        vm.etch(address(bonusVault), address(bad).code);
        vm.expectEmit(address(mathVault));
        emit LPStakingVault.BonusListenerFailed(tokenId);
        vm.prank(alice);
        uint256 newId =
            mathVault.rebalance(tokenId, PRICE_TICK - 6932, PRICE_TICK + 6932, _noSwapParams(), FAR_DEADLINE);
        assertEq(mathVault.stakerOf(newId), alice, "the rebalance completed");
    }

    function test_FailOpen_TheGasFloorRefusesAStarvedUnstake() public {
        uint256 tokenId = _join();
        mathVault.setBonusEscrow(address(0)); // the escrow owes nothing on the math rung
        vm.prank(alice);
        vm.expectRevert(LPStakingVault.InsufficientGasForBonusHook.selector);
        mathVault.unstake{gas: 108_000}(tokenId);
    }

    function test_FailOpen_TheGasFloorRefusesAStarvedRebalance() public {
        uint256 tokenId = _join();
        mathVault.setBonusEscrow(address(0));
        // Enough for the whole rebalance up to the listener, not for the listener's floor.
        uint256 gasForAll = _rebalanceGasUpToListener(tokenId);
        vm.prank(alice);
        vm.expectRevert(LPStakingVault.InsufficientGasForBonusHook.selector);
        mathVault.rebalance{gas: gasForAll}(
            tokenId, PRICE_TICK - 6932, PRICE_TICK + 6932, _noSwapParams(), FAR_DEADLINE
        );
    }

    /// @dev The gas a whole rebalance needs with the listener off. Given exactly that, the call
    ///      reaches the listener with only what the steps after it need, far below the floor.
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

    /// @dev The listener's two hooks, measured from the caller, against the allowance the vault
    ///      forwards. The rebalance one reads the vault's TWAP and values two positions.
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
        assertLt(usedRebalance, mathVault.BONUS_LISTENER_GAS() / 2, "rebalance hook inside the allowance with room");
        assertLt(usedUnstake, mathVault.BONUS_LISTENER_GAS() / 10, "unstake hook far inside the allowance");
    }
}
