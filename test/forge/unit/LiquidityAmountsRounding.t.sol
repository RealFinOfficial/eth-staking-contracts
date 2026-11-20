// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {LiquidityAmounts} from "../../../contracts/lp-staking/libraries/LiquidityAmounts.sol";
import {TickMath} from "../../../contracts/lp-staking/libraries/TickMath.sol";

/// @dev Exposes the library's internal functions.
contract LiquidityAmountsHarness {
    function l0(uint160 a, uint160 b, uint256 x) external pure returns (uint128) {
        return LiquidityAmounts.getLiquidityForAmount0(a, b, x);
    }

    function l1(uint160 a, uint160 b, uint256 x) external pure returns (uint128) {
        return LiquidityAmounts.getLiquidityForAmount1(a, b, x);
    }

    function a0(uint160 a, uint160 b, uint128 l) external pure returns (uint256) {
        return LiquidityAmounts.getAmount0ForLiquidity(a, b, l);
    }

    function a1(uint160 a, uint160 b, uint128 l) external pure returns (uint256) {
        return LiquidityAmounts.getAmount1ForLiquidity(a, b, l);
    }

    function a0Up(uint160 a, uint160 b, uint128 l) external pure returns (uint256) {
        return LiquidityAmounts.getAmount0ForLiquidityRoundingUp(a, b, l);
    }

    function a1Up(uint160 a, uint160 b, uint128 l) external pure returns (uint256) {
        return LiquidityAmounts.getAmount1ForLiquidityRoundingUp(a, b, l);
    }
}

/**
 * @notice The 2026-11-20 additions to `LiquidityAmounts` (the migrator's matching amount, spec 01
 *         §9.4.5) in both argument orders: the liquidity of one token's amount, and the amounts a
 *         pool charges for a liquidity, rounded up (never below the rounded-down figure, at most one
 *         wei above it), so the matching amount is enough for the whole USDC in either token order.
 */
contract LiquidityAmountsRoundingTest is Test {
    LiquidityAmountsHarness internal h = new LiquidityAmountsHarness();

    function testFuzz_RoundingUpIsTheFloorOrOneMore(int24 lowerSeed, int24 width, uint128 liquidity) public view {
        int24 lower = int24(bound(lowerSeed, -400_000, 400_000));
        int24 upper = lower + int24(bound(width, 1, 20_000));
        uint160 a = TickMath.getSqrtRatioAtTick(lower);
        uint160 b = TickMath.getSqrtRatioAtTick(upper);
        liquidity = uint128(bound(liquidity, 1, type(uint96).max));
        // Both argument orders give the same result.
        assertEq(h.a0Up(a, b, liquidity), h.a0Up(b, a, liquidity));
        assertEq(h.a1Up(a, b, liquidity), h.a1Up(b, a, liquidity));
        uint256 d0 = h.a0Up(a, b, liquidity) - h.a0(a, b, liquidity);
        uint256 d1 = h.a1Up(a, b, liquidity) - h.a1(a, b, liquidity);
        assertLe(d0, 2, "token0: the floor, or a wei or two above it");
        assertLe(d1, 1, "token1: the floor or one wei above it");
    }

    function testFuzz_LiquidityOfAnAmountRoundTrips(int24 lowerSeed, int24 width, uint96 amount) public view {
        int24 lower = int24(bound(lowerSeed, -300_000, 300_000));
        int24 upper = lower + int24(bound(width, 10, 20_000));
        uint160 a = TickMath.getSqrtRatioAtTick(lower);
        uint160 b = TickMath.getSqrtRatioAtTick(upper);
        uint256 x = bound(amount, 1e6, type(uint96).max);
        uint128 l0 = h.l0(a, b, x);
        uint128 l1 = h.l1(a, b, x);
        assertEq(l0, h.l0(b, a, x), "order-independent");
        assertEq(l1, h.l1(b, a, x), "order-independent");
        // The amount a pool charges for that liquidity never exceeds what was offered.
        assertLe(h.a0Up(a, b, l0), x);
        assertLe(h.a1Up(a, b, l1), x);
    }

    function test_LiquidityOfAnAmountRefusesAnOverflow() public {
        uint160 a = TickMath.getSqrtRatioAtTick(0);
        uint160 b = TickMath.getSqrtRatioAtTick(1);
        vm.expectRevert();
        h.l1(a, b, type(uint256).max / 2 ** 96);
    }
}
