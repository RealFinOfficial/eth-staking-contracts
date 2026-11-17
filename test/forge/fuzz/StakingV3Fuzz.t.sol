// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {StakingV3Harness} from "../utils/StakingV3Harness.sol";
import {StakingMigrator} from "../../../contracts/staking-v3/StakingMigrator.sol";
import {V3BonusVault} from "../../../contracts/staking-v3/V3BonusVault.sol";
import {IBonusEscrowHooks} from "../../../contracts/lp-staking/interfaces/IBonusEscrowHooks.sol";
import {TickMath} from "../../../contracts/lp-staking/libraries/TickMath.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @notice Property fuzzing of the staking v3 math: the rebalance scaling never raises a bonus, the
 *         route bonuses are exactly their rate of the bonus base (the compound's bought part at
 *         most at its TWAP value), every v3.0 bonus is zero or its full rate on either side of
 *         the 30-day cutoff (direct stake and all three routes), the USDC valuation is monotonic,
 *         and the recommended band always contains the +-6,932-tick band on the spacing grid.
 */
contract StakingV3FuzzTest is StakingV3Harness {
    V3BonusVault internal book;

    function setUp() public {
        _deployStakingV3();
        book = _deployBonusVault(address(asset), carol, makeAddr("poolStub"), address(mathVault));
        _approveMigrator(alice);
    }

    function testFuzz_Scaling_NeverAboveTheOriginal(uint128 oldL, uint128 newL, uint256 amount) public {
        oldL = uint128(bound(oldL, 0, 1e24));
        newL = uint128(bound(newL, 0, 1e24));
        amount = bound(amount, 1, 1e30);
        vm.prank(carol);
        book.reserveLp(1, alice, amount, uint64(block.timestamp + 1));

        IBonusEscrowHooks.Snapshot memory o = IBonusEscrowHooks.Snapshot(START_LOWER, START_UPPER, oldL);
        IBonusEscrowHooks.Snapshot memory n = IBonusEscrowHooks.Snapshot(R1_LOWER, R1_UPPER, newL);
        vm.prank(address(mathVault));
        book.onRebalance(1, 2, o, n);

        (, uint256 moved,,,) = book.lpReservation(2);
        assertLe(moved, amount, "a rebalance never raises the bonus");
        assertEq(book.totalReserved(), moved, "the book tracks the moved amount");
    }

    function testFuzz_Compound_BonusIsTheRateOfTheStake(uint256 principal, uint256 reward, uint16 bps) public {
        principal = bound(principal, 0, 100_000e18);
        reward = bound(reward, 1, 100_000e6);
        bps = uint16(bound(bps, 0, 10_000));
        migrator.setRates(bps, 1000, 500);
        StakingMigrator.Voucher memory v = _voucher(migrator, alice, 1, principal, reward, 1);
        vm.prank(alice);
        (uint256 staked, uint256 bonus) =
            migrator.compound(reward, principal, 1, FAR_DEADLINE, _noPermit(), _noPermit(), v);
        uint256 bought = reward * 4e18 / 1e6;
        assertEq(staked, principal + bought);
        // The bought part enters the bonus base at most at its TWAP value.
        uint256 base = principal + Math.min(bought, migrator.usdcInAsset(reward));
        assertEq(bonus, Math.mulDiv(base, bps, 10_000));
        assertLe(bonus, Math.mulDiv(staked, bps, 10_000), "never above the rate of the stake");
        (uint256 reserved,) = bonusVault.reservedOf(alice);
        assertEq(reserved, bonus);
    }

    function testFuzz_ClaimRestake_BonusIsFivePercent(uint256 principal) public {
        principal = bound(principal, 1, 1_000_000e18);
        StakingMigrator.Voucher memory v = _voucher(migrator, alice, 3, principal, 0, 1);
        vm.prank(alice);
        uint256 bonus = migrator.claimRestake(principal, FAR_DEADLINE, _noPermit(), v);
        assertEq(bonus, principal * 500 / 10_000);
    }

    /// @dev The 30-day rule (2026-11-17): at any moment of the window a direct stake reserves
    ///      either nothing or exactly the full 5 %, never a scaled figure; the full rate exactly
    ///      while `block.timestamp < bonusCutoff()`, and always what `previewStakeBonus` said.
    function testFuzz_DirectStake_BonusIsZeroOrTheFullRate(uint256 amount, uint256 moment) public {
        amount = bound(amount, 1, 1_000_000e18);
        moment = bound(moment, v3Start, v3End - 1);
        vm.warp(moment);
        vm.prank(alice);
        asset.approve(address(poolV3), amount);
        uint256 preview = poolV3.previewStakeBonus(amount);
        bytes memory sig = _signStake(poolV3, alice, FAR_DEADLINE);
        vm.prank(alice);
        poolV3.stake(amount, FAR_DEADLINE, sig);
        (uint256 reserved,) = bonusVault.reservedOf(alice);
        uint256 full = Math.mulDiv(amount, 500, 10_000);
        assertEq(reserved, preview, "the preview is what the stake reserved");
        assertEq(reserved, moment < poolV3.bonusCutoff() ? full : 0);
        assertTrue(reserved == 0 || reserved == full, "zero or the full rate");
        assertEq(poolV3.stakes(alice), amount, "the stake always succeeds");
    }

    /// @dev The same rule on route 3: zero or exactly `restakeBps` of the principal.
    function testFuzz_ClaimRestake_BonusIsZeroOrTheFullRate(uint256 principal, uint256 moment) public {
        principal = bound(principal, 1, 1_000_000e18);
        moment = bound(moment, v3Start, v3End - 1);
        vm.warp(moment);
        StakingMigrator.Voucher memory v = _voucher(migrator, alice, 3, principal, 0, 1);
        vm.prank(alice);
        uint256 bonus = migrator.claimRestake(principal, FAR_DEADLINE, _noPermit(), v);
        uint256 full = principal * 500 / 10_000;
        assertEq(bonus, moment < poolV3.bonusCutoff() ? full : 0);
        (uint256 reserved,) = bonusVault.reservedOf(alice);
        assertEq(reserved, bonus);
        assertTrue(migrator.migrated(alice));
        assertEq(poolV3.stakes(alice), principal);
    }

    /// @dev The same rule on route 1: zero or exactly `compoundBps` of the TWAP-capped base.
    function testFuzz_Compound_BonusIsZeroOrTheFullRate(uint256 principal, uint256 reward, uint256 moment) public {
        principal = bound(principal, 0, 100_000e18);
        reward = bound(reward, 1, 100_000e6);
        moment = bound(moment, v3Start, v3End - 1);
        vm.warp(moment);
        StakingMigrator.Voucher memory v = _voucher(migrator, alice, 1, principal, reward, 1);
        vm.prank(alice);
        (uint256 staked, uint256 bonus) =
            migrator.compound(reward, principal, 1, FAR_DEADLINE, _noPermit(), _noPermit(), v);
        uint256 bought = reward * 4e18 / 1e6;
        uint256 full = Math.mulDiv(principal + Math.min(bought, migrator.usdcInAsset(reward)), 1000, 10_000);
        assertEq(bonus, moment < poolV3.bonusCutoff() ? full : 0);
        assertTrue(bonus == 0 || bonus == full, "zero or the full rate");
        (uint256 reserved,) = bonusVault.reservedOf(alice);
        assertEq(reserved, bonus);
        assertEq(staked, principal + bought, "the route always stakes in full");
        assertEq(poolV3.stakes(alice), staked);
        assertTrue(migrator.migrated(alice));
    }

    /// @dev The same rule on route 2, both parts: the LP reservation is zero or exactly `lpBps` of
    ///      (LP $ASSET leg + LP USDC leg at the mean tick), the v3 remainder's reservation zero or
    ///      exactly `lpBps` of the remainder, both on the same side of the cutoff.
    function testFuzz_MoveToLp_BothPartsAreZeroOrTheFullRate(uint256 principal, uint256 reward, uint256 moment) public {
        principal = bound(principal, 1_000e18, 100_000e18);
        reward = bound(reward, 1e6, 10_000e6);
        moment = bound(moment, v3Start, v3End - 1);
        vm.warp(moment);
        StakingMigrator.Voucher memory v = _voucher(migrator, alice, 2, principal, reward, 1);
        uint256 usdcBefore = usdcToken.balanceOf(alice);
        vm.prank(alice);
        uint256 tokenId = migrator.moveToLp(reward, principal, 0, 0, FAR_DEADLINE, _noPermit(), _noPermit(), v);
        uint256 usdcUsed = usdcBefore - usdcToken.balanceOf(alice);
        uint256 remainder = poolV3.stakes(alice);
        uint256 assetUsed = principal - remainder;
        bool open = moment < poolV3.bonusCutoff();

        uint256 fullLp = Math.mulDiv(assetUsed + migrator.usdcInAsset(usdcUsed), 1000, 10_000);
        (address user, uint256 lpBonus,,,) = bonusVault.lpReservation(tokenId);
        assertEq(lpBonus, open ? fullLp : 0, "the LP part");
        assertEq(user, open && fullLp > 0 ? alice : address(0), "an LP record only with a bonus");
        uint256 fullV3 = Math.mulDiv(remainder, 1000, 10_000);
        (uint256 v3Bonus,) = bonusVault.reservedOf(alice);
        assertEq(v3Bonus, open ? fullV3 : 0, "the v3 remainder");
        assertEq(bonusVault.totalReserved(), lpBonus + v3Bonus);
        assertEq(mathVault.stakerOf(tokenId), alice, "the position is always staked");
        assertTrue(migrator.migrated(alice));
    }

    function testFuzz_UsdcInAsset_IsMonotonic(uint256 a, uint256 b) public view {
        a = bound(a, 0, 1e15);
        b = bound(b, a, 1e15);
        assertLe(migrator.usdcInAsset(a), migrator.usdcInAsset(b));
    }

    function testFuzz_LpRange_ContainsTheBandOnTheGrid(int24 tick) public {
        tick = int24(bound(tick, -880_000, 880_000));
        StakingMigrator m = StakingMigrator(_deployMigratorImpl(address(vault), address(usdcToken), address(asset)));
        poolMock.setCurrentTick(tick);
        (int24 lower, int24 upper) = m.lpRange();
        assertEq(lower % 60, 0);
        assertEq(upper % 60, 0);
        int256 wantLower = int256(tick) - 6932;
        int256 wantUpper = int256(tick) + 6932;
        if (wantLower >= MIN_TICK_ALIGNED) {
            assertLe(int256(lower), wantLower);
            assertGt(int256(lower), wantLower - 60);
        } else {
            assertEq(lower, MIN_TICK_ALIGNED);
        }
        if (wantUpper <= MAX_TICK_ALIGNED) {
            assertGe(int256(upper), wantUpper);
            assertLt(int256(upper), wantUpper + 60);
        } else {
            assertEq(upper, MAX_TICK_ALIGNED);
        }
        assertGe(lower, TickMath.MIN_TICK);
        assertLe(upper, TickMath.MAX_TICK);
    }
}
