// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm, VmSafe} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";

import {ApeBondHarness} from "../utils/ApeBondHarness.sol";
import {BonusEscrow} from "../../../contracts/lp-staking/BonusEscrow.sol";
import {ApeBondPositionAdapter} from "../../../contracts/lp-staking/ApeBondPositionAdapter.sol";
import {LPStakingVault} from "../../../contracts/lp-staking/LPStakingVault.sol";
import {IBonusEscrowHooks} from "../../../contracts/lp-staking/interfaces/IBonusEscrowHooks.sol";

/**
 * @notice The ApeBond bonus through the REAL vault: the escrow linked by `setBonusEscrow`, the
 *         adapter allowlisted by `setStakeOperator`, purchases made by a SoulZap double, and every
 *         exit and re-range reported by the vault's own hooks (B.3 decision document §6.1).
 *
 *  What each block proves:
 *    - THE LOOP (P2): buy and unstake in one transaction -> the bonus is forfeited, `totalReserved`
 *      drops, and a claim after the cliff reverts `Forfeited`.
 *    - THE WITHDRAWAL (P3): the document's two no-swap rebalances, on real liquidity math at
 *      $0.25 -> the bonus falls to ~50 %, then to ~0.3 %. A value-keeping rebalance keeps the
 *      amount; a rebalance that compounds fees does not raise it.
 *    - AFTER THE CLIFF (D3): unstake -> claim, rebalance -> claim under the OLD id,
 *      unstake -> stake -> claim — all pay the full amount.
 *    - THE ORACLE: a position with no reservation (or a matured one) rebalances with `observe`
 *      reverting; one with an active reservation fails closed and can still exit.
 *    - FUNDING (override O2): a reservation needs no balance; a claim reverts `InsufficientFunds`
 *      until the escrow holds the whole amount, then pays exactly it; `recoverSurplus` reverts
 *      `NoSurplus` while more is owed than held.
 *    - GAS: the real escrow's `onUnstake`, measured from the caller, against the vault's
 *      `BONUS_HOOK_GAS` (100,000).
 */
contract BonusEscrowHooksTest is ApeBondHarness {
    uint256 internal constant ONE = 1e18;

    function setUp() public {
        _deployApeBond();
        _deployMathRung();
    }

    // ──────────────────────── The loop (P2) ────────────────────

    /// @dev Buy through the router, credit the router itself, unstake in the SAME transaction.
    ///      The escrow is funded, so nothing but the forfeiture can be what stops the claim.
    function test_Loop_BuyAndUnstakeInOneTransaction_ForfeitsTheBonus() public {
        _fundEscrow(escrow, 1_000_000e18);
        uint256 tokenId = _mintForSoulZap(BUY_LIQUIDITY);
        (, uint256 bonus) = _expectedBonus(BUY_LIQUIDITY);
        assertGt(bonus, 0, "the purchase earns a bonus");

        vm.expectEmit(true, true, false, true, address(escrow));
        emit BonusEscrow.BonusReserved(tokenId, address(soulZap), bonus, uint64(block.timestamp + CLIFF));
        vm.expectEmit(true, true, false, true, address(escrow));
        emit BonusEscrow.BonusForfeited(tokenId, address(soulZap), bonus);
        soulZap.depositAndUnstake(adapter, address(npmMock), tokenId, CAMPAIGN, address(vault));

        (address beneficiary, uint256 amount,,, bool forfeited) = escrow.reservationOf(tokenId);
        assertEq(beneficiary, address(soulZap), "the record stays");
        assertEq(amount, 0, "the amount is gone");
        assertTrue(forfeited, "the reservation is forfeited");
        assertEq(escrow.totalReserved(), 0, "totalReserved released the bonus");
        assertEq(npmMock.ownerOf(tokenId), address(soulZap), "the exit completed");

        vm.warp(block.timestamp + CLIFF);
        vm.expectRevert(abi.encodeWithSelector(BonusEscrow.Forfeited.selector, tokenId));
        escrow.claim(tokenId);
    }

    /// @dev The same NFT cannot come back for a second bonus: the forfeited record blocks it.
    function test_Loop_TheSameNftCannotBeBoughtInAgain() public {
        uint256 tokenId = _mintForSoulZap(BUY_LIQUIDITY);
        soulZap.depositAndUnstake(adapter, address(npmMock), tokenId, CAMPAIGN, address(vault));

        vm.expectRevert(abi.encodeWithSelector(BonusEscrow.DuplicateReservation.selector, tokenId));
        soulZap.deposit(adapter, address(npmMock), tokenId, CAMPAIGN, alice);
    }

    // ──────────────────────── The withdrawal (P3) ──────────────

    /**
     * @dev The B.3 document's worked example, through the real vault on real liquidity math:
     *      $10,000 at $0.25 on 0.2000-0.3125, then a no-swap rebalance to 0.1368-0.25075 (about
     *      half the value is refunded), then to 0.24925-0.4569 (nearly all the rest). The bonus
     *      follows the position each time, scaled by the share of value that stayed staked.
     */
    /// @dev The vector's figures, in memory: the test has more of them than the stack holds.
    struct Vector {
        uint256 id0;
        uint256 id1;
        uint256 id2;
        uint256 value0;
        uint256 bonus0;
        uint256 bonus1;
        uint256 bonus2;
        uint256 assetBefore;
        uint256 usdcBefore;
    }

    function test_P3_TheDocumentsTwoRebalanceWithdrawalScalesTheBonus() public {
        Vector memory v;
        v.id0 = _buyDocumentPosition(alice);
        v.value0 = _mathValue(v.id0);
        (, v.bonus0,,,) = mathEscrow.reservationOf(v.id0);
        assertApproxEqRel(v.value0, 40_000e18, 0.001e18, "the start position is worth $10,000 = 40,000 ASSET");
        assertApproxEqRel(v.bonus0, 4_000e18, 0.001e18, "and its bonus is 10 % of that");
        v.assetBefore = asset.balanceOf(alice);
        v.usdcBefore = usdcToken.balanceOf(alice);

        // Rebalance 1: the upper bound $0.00075 above the price. All USDC, almost no ASSET.
        vm.prank(alice);
        v.id1 = mathVault.rebalance(v.id0, R1_LOWER, R1_UPPER, _noSwap(), FAR_DEADLINE);
        v.bonus1 = _assertMoved(v.id0, v.id1);
        assertApproxEqRel(asset.balanceOf(alice) - v.assetBefore, 19_885e18, 0.001e18, "about 19,885 ASSET refunded");

        // Rebalance 2: the lower bound $0.00075 below the price. Almost all USDC is refunded.
        vm.prank(alice);
        v.id2 = mathVault.rebalance(v.id1, R2_LOWER, R2_UPPER, _noSwap(), FAR_DEADLINE);
        v.bonus2 = _assertMoved(v.id1, v.id2);
        // The document rounds its table (115 ASSET, 0.17 USDC left); the exact math leaves ~2.45 USDC.
        assertApproxEqRel(usdcToken.balanceOf(alice) - v.usdcBefore, 4_999.83e6, 0.001e18, "about 4,999.83 USDC refunded");

        _reportVector(v);
    }

    /// @dev The reservation left `fromId` for `toId`, still alice's and still live; its amount.
    function _assertMoved(uint256 fromId, uint256 toId) private view returns (uint256 amount) {
        address beneficiary;
        bool forfeited;
        (beneficiary, amount,,, forfeited) = mathEscrow.reservationOf(toId);
        (address gone,,,,) = mathEscrow.reservationOf(fromId);
        assertEq(beneficiary, alice, "the reservation followed the position");
        assertFalse(forfeited, "and is still live");
        assertEq(gone, address(0), "and left the burned id");
    }

    function _reportVector(Vector memory v) private view {
        uint256 ppm1 = v.bonus1 * 1e6 / v.bonus0;
        uint256 ppm2 = v.bonus2 * 1e6 / v.bonus0;
        console.log("P3 vector: bonus after rebalance 1, ppm of the original", ppm1);
        console.log("P3 vector: bonus after rebalance 2, ppm of the original", ppm2);
        console.log("P3 vector: value left after rebalance 2, ppm", _mathValue(v.id2) * 1e6 / v.value0);
        assertGe(ppm1, 495_000, "about 50 % after the first");
        assertLe(ppm1, 510_000, "about 50 % after the first");
        assertGe(ppm2, 2_500, "about 0.3 % after the second");
        assertLe(ppm2, 3_500, "about 0.3 % after the second");
        // The bonus tracks the value that stayed staked, to rounding.
        assertApproxEqRel(v.bonus2 * 10_000 / BONUS_BPS, _mathValue(v.id2), 0.001e18, "bonus = 10 % of what is left");
        assertEq(mathEscrow.totalReserved(), v.bonus2, "totalReserved is the scaled amount");
    }

    /// @dev Re-ranging into the same range with the same tokens keeps the value to rounding, and
    ///      the bonus with it (math rung: the round trip loses at most a few wei of liquidity).
    function test_Rebalance_KeepingTheValueKeepsTheAmount_MathRung() public {
        uint256 id0 = _buyDocumentPosition(alice);
        (, uint256 bonus0,,,) = mathEscrow.reservationOf(id0);

        vm.prank(alice);
        uint256 id1 = mathVault.rebalance(id0, START_LOWER, START_UPPER, _noSwap(), FAR_DEADLINE);
        (, uint256 bonus1,,,) = mathEscrow.reservationOf(id1);

        assertLe(bonus1, bonus0, "never more");
        // The round trip rounds the withdrawal and the re-mint down: measured 2e-10 relative.
        assertApproxEqRel(bonus1, bonus0, 1e10, "and equal to one part in 1e8");
    }

    /// @dev On the local rung a full re-mint reproduces the liquidity exactly, so the amount is
    ///      kept to the wei.
    function test_Rebalance_KeepingTheValueKeepsTheAmountExactly_LocalRung() public {
        uint128 liquidity = uint128(P_ASSET + P_USDC); // the mock re-mints amount0 + amount1
        uint256 id0 = _buy(alice, liquidity);
        (, uint256 bonus0,,,) = escrow.reservationOf(id0);

        vm.prank(alice);
        uint256 id1 = vault.rebalance(id0, CAMPAIGN_TICK_LOWER, CAMPAIGN_TICK_UPPER, _noSwap(), FAR_DEADLINE);
        (, uint256 bonus1,,,) = escrow.reservationOf(id1);
        assertEq(bonus1, bonus0, "same range, same liquidity, same bonus");
    }

    /// @dev Fees collected and compounded into the new position raise its value; the bonus does
    ///      NOT rise with it (I2).
    function test_Rebalance_CompoundingFeesDoesNotRaiseTheBonus() public {
        uint256 id0 = _buyDocumentPosition(alice);
        (, uint256 bonus0,,,) = mathEscrow.reservationOf(id0);
        uint256 value0 = _mathValue(id0);
        mathNpm.setPendingFees(id0, 2_000e18, 500e6);

        vm.prank(alice);
        uint256 id1 = mathVault.rebalance(id0, START_LOWER, START_UPPER, _noSwap(), FAR_DEADLINE);

        assertGt(_mathValue(id1), value0, "the compounded fees made the new position worth more");
        (, uint256 bonus1,,,) = mathEscrow.reservationOf(id1);
        assertEq(bonus1, bonus0, "the bonus never increases");
    }

    // ──────────────────────── After the cliff (D3) ─────────────

    function test_AfterTheCliff_UnstakeThenClaimPaysInFull() public {
        uint256 tokenId = _buy(alice, BUY_LIQUIDITY);
        (, uint256 bonus) = _expectedBonus(BUY_LIQUIDITY);
        _fundEscrow(escrow, bonus);
        vm.warp(block.timestamp + CLIFF);

        vm.prank(alice);
        vault.unstake(tokenId);
        (,,,, bool forfeited) = escrow.reservationOf(tokenId);
        assertFalse(forfeited, "an exit after the cliff forfeits nothing");

        uint256 before = asset.balanceOf(alice);
        escrow.claim(tokenId);
        assertEq(asset.balanceOf(alice) - before, bonus, "paid in full");
    }

    function test_AfterTheCliff_RebalanceThenClaimUnderTheOldIdPaysInFull() public {
        uint256 tokenId = _buy(alice, BUY_LIQUIDITY);
        (, uint256 bonus) = _expectedBonus(BUY_LIQUIDITY);
        _fundEscrow(escrow, bonus);
        vm.warp(block.timestamp + CLIFF);

        vm.prank(alice);
        uint256 newId = vault.rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, _noSwap(), FAR_DEADLINE);
        (address movedTo,,,,) = escrow.reservationOf(newId);
        assertEq(movedTo, address(0), "a matured reservation does not move");

        uint256 before = asset.balanceOf(alice);
        escrow.claim(tokenId);
        assertEq(asset.balanceOf(alice) - before, bonus, "paid in full under the old id");
    }

    function test_AfterTheCliff_UnstakeStakeAgainThenClaimPaysInFull() public {
        uint256 tokenId = _buy(alice, BUY_LIQUIDITY);
        (, uint256 bonus) = _expectedBonus(BUY_LIQUIDITY);
        _fundEscrow(escrow, bonus);
        vm.warp(block.timestamp + CLIFF);

        vm.startPrank(alice);
        vault.unstake(tokenId);
        npmMock.approve(address(vault), tokenId);
        vault.stake(tokenId);
        vault.unstake(tokenId);
        vm.stopPrank();

        uint256 before = asset.balanceOf(alice);
        escrow.claim(tokenId);
        assertEq(asset.balanceOf(alice) - before, bonus, "paid in full");
    }

    /// @dev One second before the cliff the exit still forfeits; at the cliff it does not.
    function test_TheCliffBoundary_ForfeitsBeforeAndNotAt() public {
        uint256 early = _buy(alice, BUY_LIQUIDITY);
        uint256 onTime = _buy(bob, BUY_LIQUIDITY);
        (,, uint64 unlockAt,,) = escrow.reservationOf(early);

        vm.warp(unlockAt - 1);
        vm.prank(alice);
        vault.unstake(early);
        vm.warp(unlockAt);
        vm.prank(bob);
        vault.unstake(onTime);

        (,,,, bool f1) = escrow.reservationOf(early);
        (,,,, bool f2) = escrow.reservationOf(onTime);
        assertTrue(f1, "one second early: forfeited");
        assertFalse(f2, "at the cliff: kept");
    }

    // ──────────────────────── The oracle ───────────────────────

    /// @dev An ordinary staker's no-swap rebalance needs no oracle: the escrow returns before
    ///      reading one when the position carries no reservation.
    function test_Rebalance_WithNoReservationWorksWithTheOracleDown() public {
        uint256 tokenId = _stakePosition(alice);
        poolMock.setObserveReverts(true);

        vm.prank(alice);
        uint256 newId = vault.rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, _noSwap(), FAR_DEADLINE);
        assertEq(vault.stakerOf(newId), alice, "the rebalance went through");
    }

    function test_Rebalance_WithAMaturedReservationWorksWithTheOracleDown() public {
        uint256 tokenId = _buy(alice, BUY_LIQUIDITY);
        vm.warp(block.timestamp + CLIFF);
        poolMock.setObserveReverts(true);

        vm.prank(alice);
        uint256 newId = vault.rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, _noSwap(), FAR_DEADLINE);
        assertEq(vault.stakerOf(newId), alice, "the rebalance went through");
    }

    /// @dev B.3 limit L2: before the cliff a rebalance of a position carrying a bonus needs the
    ///      oracle, and fails closed without it — while the exit stays open.
    function test_Rebalance_WithAnActiveReservationFailsClosedAndTheExitStaysOpen() public {
        uint256 tokenId = _buy(alice, BUY_LIQUIDITY);
        poolMock.setObserveReverts(true);

        vm.prank(alice);
        vm.expectRevert(bytes("OLD"));
        vault.rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, _noSwap(), FAR_DEADLINE);

        vm.prank(alice);
        vault.unstake(tokenId);
        (,,,, bool forfeited) = escrow.reservationOf(tokenId);
        assertTrue(forfeited, "the exit went through and forfeited the bonus");
    }

    // ──────────────────────── Funding (override O2) ────────────

    function test_Funding_ReserveNeedsNoBalanceAndClaimRevertsUntilFunded() public {
        assertEq(asset.balanceOf(address(escrow)), 0, "the escrow starts empty");
        uint256 tokenId = _buy(alice, BUY_LIQUIDITY);
        (, uint256 bonus) = _expectedBonus(BUY_LIQUIDITY);
        assertEq(escrow.totalReserved(), bonus, "reserved with nothing in the escrow");

        vm.warp(block.timestamp + CLIFF);
        vm.expectRevert(abi.encodeWithSelector(BonusEscrow.InsufficientFunds.selector, bonus, 0));
        escrow.claim(tokenId);

        _fundEscrow(escrow, bonus - 1);
        vm.expectRevert(abi.encodeWithSelector(BonusEscrow.InsufficientFunds.selector, bonus, bonus - 1));
        escrow.claim(tokenId);
        (,,, bool claimed,) = escrow.reservationOf(tokenId);
        assertFalse(claimed, "a failed claim changes nothing");
        assertEq(escrow.totalReserved(), bonus, "nothing at all");

        _fundEscrow(escrow, 1);
        uint256 before = asset.balanceOf(alice);
        escrow.claim(tokenId);
        assertEq(asset.balanceOf(alice) - before, bonus, "then it pays exactly the amount");
        assertEq(asset.balanceOf(address(escrow)), 0, "out of a balance that was exactly enough");
        assertEq(escrow.totalReserved(), 0, "and owes nothing more");
    }

    function test_Funding_RecoverSurplusRevertsWhileUnderfunded() public {
        _buy(alice, BUY_LIQUIDITY);
        _buy(bob, BUY_LIQUIDITY);
        uint256 owed = escrow.totalReserved();

        _fundEscrow(escrow, owed / 2);
        vm.expectRevert(BonusEscrow.NoSurplus.selector);
        escrow.recoverSurplus(operatorSafe);

        _fundEscrow(escrow, owed - owed / 2);
        vm.expectRevert(BonusEscrow.NoSurplus.selector);
        escrow.recoverSurplus(operatorSafe);

        _fundEscrow(escrow, 5);
        escrow.recoverSurplus(operatorSafe);
        assertEq(asset.balanceOf(operatorSafe), 5, "only the surplus over what is owed");
        assertEq(asset.balanceOf(address(escrow)), owed, "every owed wei stays");
    }

    // ──────────────────────── Gas: the real onUnstake ──────────

    /// @dev A live reservation forfeited by the REAL escrow behind its proxy, measured from the
    ///      caller with every slot cold (the reservation is created in this test's own setUp
    ///      chain, and forge starts each test with a fresh access list).
    function test_HookGas_TheRealEscrowForfeitsWithinTheAllowance() public {
        uint256 tokenId = _buy(alice, BUY_LIQUIDITY);
        vm.cool(address(escrow));

        vm.prank(address(vault));
        uint256 before = gasleft();
        escrow.onUnstake(tokenId);
        uint256 used = before - gasleft();

        (,,,, bool forfeited) = escrow.reservationOf(tokenId);
        assertTrue(forfeited, "the measured call really forfeited");
        console.log("BonusEscrow.onUnstake gas, forfeiting a live reservation (caller-measured)", used);
        assertLt(used, _measuredBound(), "a fraction of the vault's BONUS_HOOK_GAS");
    }

    function test_HookGas_NoReservationAndMaturedAreCheaper() public {
        uint256 tokenId = _buy(alice, BUY_LIQUIDITY);
        vm.warp(block.timestamp + CLIFF);
        vm.cool(address(escrow));

        vm.prank(address(vault));
        uint256 before = gasleft();
        escrow.onUnstake(tokenId + 1_000);
        uint256 usedNone = before - gasleft();

        vm.prank(address(vault));
        before = gasleft();
        escrow.onUnstake(tokenId);
        uint256 usedMatured = before - gasleft();

        console.log("BonusEscrow.onUnstake gas, no reservation (caller-measured)", usedNone);
        console.log("BonusEscrow.onUnstake gas, matured reservation (warm proxy)", usedMatured);
        assertLt(usedNone, _measuredBound(), "far inside the allowance");
        assertLt(usedMatured, _measuredBound(), "far inside the allowance");
    }

    /// @dev The real flow with the real escrow: the hook runs inside the vault's fixed allowance
    ///      and no `BonusHookFailed` is raised.
    function test_HookGas_TheRealFlowRaisesNoHookFailure() public {
        uint256 tokenId = _buy(alice, BUY_LIQUIDITY);

        vm.recordLogs();
        vm.prank(alice);
        vault.unstake(tokenId);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32 failed = LPStakingVault.BonusHookFailed.selector;
        for (uint256 i = 0; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != failed, "the hook fitted its allowance");
        }
        (,,,, bool forfeited) = escrow.reservationOf(tokenId);
        assertTrue(forfeited, "and forfeited");
    }

    /// @dev A third of the allowance in the optimized build; half under `forge coverage`, which
    ///      compiles without the optimizer (same bound lane 1 used for its measurement).
    function _measuredBound() private view returns (uint256) {
        return vm.isContext(VmSafe.ForgeContext.Coverage) ? vault.BONUS_HOOK_GAS() / 2 : vault.BONUS_HOOK_GAS() / 3;
    }
}
