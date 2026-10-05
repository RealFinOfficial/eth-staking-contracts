// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {TickMath} from "../../../contracts/lp-staking/libraries/TickMath.sol";
import {LiquidityAmounts} from "../../../contracts/lp-staking/libraries/LiquidityAmounts.sol";
import {PositionValue} from "../../../contracts/lp-staking/libraries/PositionValue.sol";

/**
 * @dev The three libraries are `internal`, so an external call — the only thing `vm.expectRevert`
 *      can watch, and the only way to give every branch its own frame — needs a contract around
 *      them. This one adds nothing: each function forwards its arguments verbatim.
 */
contract PositionValueLibs {
    function sqrtAt(int24 tick) external pure returns (uint160) {
        return TickMath.getSqrtRatioAtTick(tick);
    }

    function amount0(uint160 a, uint160 b, uint128 liquidity) external pure returns (uint256) {
        return LiquidityAmounts.getAmount0ForLiquidity(a, b, liquidity);
    }

    function amount1(uint160 a, uint160 b, uint128 liquidity) external pure returns (uint256) {
        return LiquidityAmounts.getAmount1ForLiquidity(a, b, liquidity);
    }

    function amounts(uint160 p, uint160 a, uint160 b, uint128 liquidity) external pure returns (uint256, uint256) {
        return LiquidityAmounts.getAmountsForLiquidity(p, a, b, liquidity);
    }

    function valueAt(uint128 liquidity, int24 lower, int24 upper, int24 tick, bool inToken0)
        external
        pure
        returns (uint256)
    {
        return PositionValue.valueAt(liquidity, lower, upper, tick, inToken0);
    }
}

/**
 * @notice Why this file exists: `PositionValue.valueAt` is the ONE number every ApeBond bonus is
 *         a share of — the adapter prices the bonus with it at deposit and the escrow scales the
 *         bonus with it at every rebalance before the cliff (B.3 decision document, A2). Two of
 *         the three libraries under it are vendored Uniswap code with one substitution
 *         (`FullMath.mulDiv` -> OpenZeppelin `Math.mulDiv`), so this file pins:
 *
 *    - TickMath against exact constants and against an independent high-precision reference
 *      (`sqrt(1.0001^tick) * 2^96`, computed outside Solidity at 80 digits), and its revert at
 *      both ends of the tick range;
 *    - LiquidityAmounts on every branch, the argument-swap branches included;
 *    - valueAt below, inside and above the range, in both token orders, rounding DOWN against a
 *      rounding-UP twin, monotone and linear in liquidity, zero for zero liquidity;
 *    - that valueAt can NOT overflow anywhere in its domain — every intermediate is at most
 *      about 6.3e57, far below 2^256 — so the fuzz runs over the whole of `uint128` liquidity
 *      and the whole tick range;
 *    - the B.3 document's starting position: 20,000 ASSET + 5,000 USDC on 0.2000-0.3125 at
 *      $0.25 is worth 40,000 ASSET.
 */
contract PositionValueTest is Test {
    PositionValueLibs internal libs;

    uint256 internal constant Q96 = 1 << 96;
    int24 internal constant MIN_TICK = -887272;
    int24 internal constant MAX_TICK = 887272;
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    /// @dev The B.3 document's price and starting range (see test/forge/utils/ApeBondHarness.sol).
    int24 internal constant PRICE_TICK = -290188;
    int24 internal constant START_LOWER = -292419;
    int24 internal constant START_UPPER = -287956;

    function setUp() public {
        libs = new PositionValueLibs();
    }

    // ──────────────────────── TickMath ─────────────────────────

    function test_TickMath_TheExactAnchors() public view {
        assertEq(libs.sqrtAt(0), Q96, "tick 0 is price 1: sqrt = 2^96");
        assertEq(libs.sqrtAt(MIN_TICK), MIN_SQRT_RATIO, "MIN_TICK");
        assertEq(libs.sqrtAt(MAX_TICK), MAX_SQRT_RATIO, "MAX_TICK");
        // Uniswap v3-core's own test vectors for the two ticks inside the bounds.
        assertEq(libs.sqrtAt(MIN_TICK + 1), 4295343490, "MIN_TICK + 1");
        assertEq(libs.sqrtAt(MAX_TICK - 1), 1461373636630004318706518188784493106690254656249, "MAX_TICK - 1");
    }

    /**
     * @dev Against `floor(sqrt(1.0001^tick) * 2^96)` computed at 80 significant digits outside
     *      Solidity. The library rounds UP and its fixed-point constants are accurate to far
     *      better than a part in 1e15, so the result sits at the reference or one unit above it,
     *      plus at most one part in 1e15 (the one unit is what matters at 33-bit magnitudes).
     */
    function test_TickMath_MatchesAHighPrecisionReference() public view {
        int24[10] memory ticks = [int24(1), -1, 60, -60, 1000, -1000, 100000, -100000, -290188, -887271];
        uint256[10] memory reference_ = [
            uint256(79232123823359799118286999567),
            79224201403219477170569942573,
            79466191966197645195421774832,
            78990846045029531151608375685,
            83290069058676223003182343269,
            75364347830767020784054125654,
            11755562826496067164730007768449,
            533968626430936354154228407,
            39613414168084867927950,
            4295343489
        ];
        for (uint256 i = 0; i < ticks.length; ++i) {
            uint256 got = libs.sqrtAt(ticks[i]);
            assertGe(got, reference_[i], "rounds up, never below the true value");
            assertLe(got - reference_[i], 1 + reference_[i] / 1e15, "one unit, or one part in 1e15, above it");
        }
    }

    function testFuzz_TickMath_NeighboursDifferByTheSquareRootOfOneBasisPoint(int24 tick) public view {
        tick = int24(bound(tick, MIN_TICK, MAX_TICK - 1));
        uint256 low = libs.sqrtAt(tick);
        uint256 high = libs.sqrtAt(tick + 1);
        assertGt(high, low, "strictly increasing");
        // sqrt(1.0001) = 1.00004999875006249609...; the ratio is pinned to 1e-12 relative,
        // except at the very bottom of the range where a 33-bit value cannot resolve it.
        if (low > 1e15) {
            assertApproxEqRel(high * 1e18 / low, 1.000049998750062496e18, 1e6, "the neighbour ratio");
        }
    }

    function test_TickMath_RevertsOutsideTheTickRange() public {
        vm.expectRevert(TickMath.T.selector);
        libs.sqrtAt(MIN_TICK - 1);
        vm.expectRevert(TickMath.T.selector);
        libs.sqrtAt(MAX_TICK + 1);
        vm.expectRevert(TickMath.T.selector);
        libs.sqrtAt(type(int24).min);
        vm.expectRevert(TickMath.T.selector);
        libs.sqrtAt(type(int24).max);
    }

    // ──────────────────────── LiquidityAmounts ─────────────────

    /// @dev The two helpers sort their bounds themselves; the swapped call must be the same call.
    function testFuzz_LiquidityAmounts_TheBoundOrderDoesNotMatter(int24 tickA, int24 tickB, uint128 liquidity)
        public
        view
    {
        tickA = int24(bound(tickA, MIN_TICK, MAX_TICK));
        tickB = int24(bound(tickB, MIN_TICK, MAX_TICK));
        vm.assume(tickA != tickB);
        uint160 a = libs.sqrtAt(tickA);
        uint160 b = libs.sqrtAt(tickB);

        assertEq(libs.amount0(a, b, liquidity), libs.amount0(b, a, liquidity), "amount0 is symmetric");
        assertEq(libs.amount1(a, b, liquidity), libs.amount1(b, a, liquidity), "amount1 is symmetric");

        uint160 p = libs.sqrtAt(int24(bound(int256(tickA) + int256(tickB), MIN_TICK, MAX_TICK)) / 2);
        (uint256 x0, uint256 y0) = libs.amounts(p, a, b, liquidity);
        (uint256 x1, uint256 y1) = libs.amounts(p, b, a, liquidity);
        assertEq(x0, x1, "getAmountsForLiquidity amount0 is symmetric");
        assertEq(y0, y1, "getAmountsForLiquidity amount1 is symmetric");
    }

    /// @dev The three price regimes, each against its own helper.
    function test_LiquidityAmounts_TheThreeRegimes() public view {
        uint128 liquidity = 1e24;
        uint160 a = libs.sqrtAt(-600);
        uint160 b = libs.sqrtAt(600);

        (uint256 x, uint256 y) = libs.amounts(libs.sqrtAt(-1200), a, b, liquidity);
        assertEq(x, libs.amount0(a, b, liquidity), "below: all token0");
        assertEq(y, 0, "below: no token1");

        (x, y) = libs.amounts(a, a, b, liquidity);
        assertEq(x, libs.amount0(a, b, liquidity), "at the lower bound: still all token0");
        assertEq(y, 0, "at the lower bound: no token1");

        uint160 p = libs.sqrtAt(0);
        (x, y) = libs.amounts(p, a, b, liquidity);
        assertEq(x, libs.amount0(p, b, liquidity), "inside: token0 for [p, b]");
        assertEq(y, libs.amount1(a, p, liquidity), "inside: token1 for [a, p]");

        (x, y) = libs.amounts(b, a, b, liquidity);
        assertEq(x, 0, "at the upper bound: no token0");
        assertEq(y, libs.amount1(a, b, liquidity), "at the upper bound: all token1");

        (x, y) = libs.amounts(libs.sqrtAt(1200), a, b, liquidity);
        assertEq(x, 0, "above: no token0");
        assertEq(y, libs.amount1(a, b, liquidity), "above: all token1");
    }

    /// @dev At price 1 (tick 0) a symmetric range holds the same amount of each token, to rounding.
    function test_LiquidityAmounts_ASymmetricRangeAtPriceOneIsBalanced() public view {
        (uint256 x, uint256 y) = libs.amounts(libs.sqrtAt(0), libs.sqrtAt(-600), libs.sqrtAt(600), 1e24);
        assertApproxEqRel(x, y, 1e14, "token0 ~= token1 at price 1");
    }

    // ──────────────────────── valueAt: the regimes ─────────────

    /// @dev Below the range the position is all token0: its value in token0 is the amount itself,
    ///      and its value in token1 is that amount at the price, rounded down.
    function test_ValueAt_BelowTheRangeIsAllToken0() public view {
        uint128 liquidity = 5e23;
        int24 tick = -3000;
        uint160 p = libs.sqrtAt(tick);
        uint256 x = libs.amount0(libs.sqrtAt(-600), libs.sqrtAt(600), liquidity);

        assertEq(libs.valueAt(liquidity, -600, 600, tick, true), x, "in token0: exactly amount0");
        assertEq(
            libs.valueAt(liquidity, -600, 600, tick, false),
            Math.mulDiv(Math.mulDiv(x, p, Q96), p, Q96),
            "in token1: amount0 x price, rounded down"
        );
    }

    /// @dev Above the range the position is all token1.
    function test_ValueAt_AboveTheRangeIsAllToken1() public view {
        uint128 liquidity = 5e23;
        int24 tick = 3000;
        uint160 p = libs.sqrtAt(tick);
        uint256 y = libs.amount1(libs.sqrtAt(-600), libs.sqrtAt(600), liquidity);

        assertEq(libs.valueAt(liquidity, -600, 600, tick, false), y, "in token1: exactly amount1");
        assertEq(
            libs.valueAt(liquidity, -600, 600, tick, true),
            Math.mulDiv(Math.mulDiv(y, Q96, p), Q96, p),
            "in token0: amount1 / price, rounded down"
        );
    }

    /// @dev Inside the range both legs count, each converted at the same price.
    function test_ValueAt_InsideTheRangeCountsBothLegs() public view {
        uint128 liquidity = 5e23;
        int24 tick = 120;
        uint160 p = libs.sqrtAt(tick);
        (uint256 x, uint256 y) = libs.amounts(p, libs.sqrtAt(-600), libs.sqrtAt(600), liquidity);
        assertGt(x, 0, "both legs present");
        assertGt(y, 0, "both legs present");

        assertEq(
            libs.valueAt(liquidity, -600, 600, tick, true), x + Math.mulDiv(Math.mulDiv(y, Q96, p), Q96, p), "in token0"
        );
        assertEq(
            libs.valueAt(liquidity, -600, 600, tick, false),
            y + Math.mulDiv(Math.mulDiv(x, p, Q96), p, Q96),
            "in token1"
        );
    }

    /// @dev The B.3 document's worked example: $10,000 at $0.25 is 40,000 ASSET (ASSET = token0,
    ///      18 decimals; USDC = token1, 6 decimals). The liquidity is the one the position
    ///      manager mints for 20,000 ASSET + 5,000 USDC on 0.2000-0.3125.
    function test_ValueAt_TheDocumentsStartingPositionIsWorth40000Asset() public view {
        uint160 p = libs.sqrtAt(PRICE_TICK);
        uint128 liquidity =
            _liquidityForAmounts(p, libs.sqrtAt(START_LOWER), libs.sqrtAt(START_UPPER), 20_000e18, 5_000e6);
        (uint256 x, uint256 y) = libs.amounts(p, libs.sqrtAt(START_LOWER), libs.sqrtAt(START_UPPER), liquidity);
        assertApproxEqRel(x, 20_000e18, 0.001e18, "the position holds ~20,000 ASSET");
        assertApproxEqRel(y, 5_000e6, 0.001e18, "and ~5,000 USDC");

        uint256 inAsset = libs.valueAt(liquidity, START_LOWER, START_UPPER, PRICE_TICK, true);
        uint256 inUsdc = libs.valueAt(liquidity, START_LOWER, START_UPPER, PRICE_TICK, false);
        assertApproxEqRel(inAsset, 40_000e18, 0.001e18, "worth 40,000 ASSET");
        assertApproxEqRel(inUsdc, 10_000e6, 0.001e18, "worth $10,000");
    }

    function test_ValueAt_ZeroLiquidityIsWorthNothing() public view {
        assertEq(libs.valueAt(0, -600, 600, 0, true), 0, "in token0");
        assertEq(libs.valueAt(0, -600, 600, 0, false), 0, "in token1");
        assertEq(libs.valueAt(0, MIN_TICK, MAX_TICK, MIN_TICK, true), 0, "at the edge of the range");
    }

    /// @dev The corners of the domain, where the intermediates are largest, do not overflow.
    function test_ValueAt_TheCornersOfTheDomainDoNotOverflow() public view {
        uint128 maxL = type(uint128).max;
        int24[3] memory prices = [MIN_TICK, int24(0), MAX_TICK];
        for (uint256 i = 0; i < prices.length; ++i) {
            libs.valueAt(maxL, MIN_TICK, MAX_TICK, prices[i], true);
            libs.valueAt(maxL, MIN_TICK, MAX_TICK, prices[i], false);
            libs.valueAt(maxL, MIN_TICK, MIN_TICK + 1, prices[i], true);
            libs.valueAt(maxL, MIN_TICK, MIN_TICK + 1, prices[i], false);
            libs.valueAt(maxL, MAX_TICK - 1, MAX_TICK, prices[i], true);
            libs.valueAt(maxL, MAX_TICK - 1, MAX_TICK, prices[i], false);
        }
        // The largest single intermediate: everything in token1 at the bottom price, valued in
        // token0 — bounded by liquidity x 2^96 / MIN_SQRT_RATIO ~ 6.3e57.
        uint256 v = libs.valueAt(maxL, MIN_TICK, MIN_TICK + 1, MIN_TICK + 1, true);
        assertLe(v, uint256(maxL) * Q96 / MIN_SQRT_RATIO + 1, "within the analytic bound");
    }

    // ──────────────────────── valueAt: properties ──────────────

    /// @dev Over the WHOLE domain — any uint128 liquidity, any valid range and price — valueAt
    ///      never reverts, and it is exactly the conversion of the amounts at that price.
    function testFuzz_ValueAt_NeverRevertsAndIsTheAmountsAtThatPrice(
        uint128 liquidity,
        int24 tickA,
        int24 tickB,
        int24 tick
    ) public view {
        (int24 lower, int24 upper) = _range(tickA, tickB);
        tick = int24(bound(tick, MIN_TICK, MAX_TICK));
        uint160 p = libs.sqrtAt(tick);
        (uint256 x, uint256 y) = libs.amounts(p, libs.sqrtAt(lower), libs.sqrtAt(upper), liquidity);

        assertEq(
            libs.valueAt(liquidity, lower, upper, tick, true),
            x + Math.mulDiv(Math.mulDiv(y, Q96, p), Q96, p),
            "token0 value = the amounts at that price"
        );
        assertEq(
            libs.valueAt(liquidity, lower, upper, tick, false),
            y + Math.mulDiv(Math.mulDiv(x, p, Q96), p, Q96),
            "token1 value = the amounts at that price"
        );
    }

    /// @dev The two token orders agree: the token1 value is the token0 value at the price, to
    ///      rounding. Checked where both are large enough for a relative comparison to mean
    ///      something (a value of a few wei carries its rounding as a large fraction).
    function testFuzz_ValueAt_TheTwoTokenOrdersAgree(uint128 liquidity, int24 tickA, int24 tickB, int24 tick)
        public
        view
    {
        (int24 lower, int24 upper) = _range(tickA, tickB);
        tick = int24(bound(tick, -400_000, 400_000));
        uint160 p = libs.sqrtAt(tick);
        uint256 in0 = libs.valueAt(liquidity, lower, upper, tick, true);
        uint256 in1 = libs.valueAt(liquidity, lower, upper, tick, false);
        vm.assume(in0 > 1e12 && in1 > 1e12);

        assertApproxEqRel(
            Math.mulDiv(Math.mulDiv(in0, p, Q96), p, Q96), in1, 1e9, "token0 value x price ~= token1 value"
        );
    }

    /**
     * @dev Every step rounds DOWN: the result never exceeds the same computation rounded UP at
     *      every step, and stays within the rounding the two-step conversion can produce. That
     *      allowance is analytic, not a tolerance picked to pass: each amount loses at most two
     *      units to its floors, and converting a one-unit difference of the OTHER token moves the
     *      value by up to one unit of that token at the price — `price` token1 per token0 (or
     *      `1 / price` token0 per token1), which at the ends of the tick range is enormous.
     */
    function testFuzz_ValueAt_RoundsDown(uint128 liquidity, int24 tickA, int24 tickB, int24 tick, bool inToken0)
        public
        view
    {
        (int24 lower, int24 upper) = _range(tickA, tickB);
        tick = int24(bound(tick, MIN_TICK, MAX_TICK));
        uint256 down = libs.valueAt(liquidity, lower, upper, tick, inToken0);
        uint256 up = _valueRoundingUp(liquidity, lower, upper, tick, inToken0);

        assertLe(down, up, "never above the rounding-up twin");
        assertLe(up - down, _conversionSlack(libs.sqrtAt(tick), inToken0), "within the conversion's rounding");
    }

    function testFuzz_ValueAt_IsMonotoneInLiquidity(uint128 l1, uint128 l2, int24 tickA, int24 tickB, int24 tick)
        public
        view
    {
        (int24 lower, int24 upper) = _range(tickA, tickB);
        tick = int24(bound(tick, MIN_TICK, MAX_TICK));
        if (l1 > l2) (l1, l2) = (l2, l1);
        assertLe(libs.valueAt(l1, lower, upper, tick, true), libs.valueAt(l2, lower, upper, tick, true), "token0");
        assertLe(libs.valueAt(l1, lower, upper, tick, false), libs.valueAt(l2, lower, upper, tick, false), "token1");
    }

    /**
     * @dev Twice the liquidity is twice the value, to rounding (the escrow's scaling relies on
     *      value being proportional to liquidity for a fixed range and price). The allowance is
     *      analytic, not a tolerance picked to pass. `floor(2t)` is `2 floor(t)` or one more, so
     *      doubling the liquidity adds at most one unit to amount0 and at most one unit to amount1.
     *      The token1 -> token0 conversion then floors twice, through an intermediate worth
     *      `1 / sqrt(price)` token0 a unit: the extra unit of amount1 becomes at most
     *      `ceil(1 / sqrt(price))` intermediate units, worth at most `1 / price + 1 / sqrt(price)`,
     *      and the two floors add at most one intermediate unit and one unit of token0. In token0:
     *
     *          twice <= 2 x single + 2 + ceil(1 / price) + 2 x ceil(1 / sqrt(price))
     *
     *      A fixed RELATIVE tolerance cannot express this: the extra unit of token1 is a relative
     *      error of up to 1 / amount1, and amount1 can be small while the value is large — the
     *      regression case below is one.
     */
    function testFuzz_ValueAt_IsLinearInLiquidity(uint128 liquidity, int24 tickA, int24 tickB, int24 tick) public view {
        liquidity = uint128(bound(liquidity, 1e12, type(uint128).max / 2));
        (int24 lower, int24 upper) = _range(tickA, tickB);
        tick = int24(bound(tick, -400_000, 400_000));
        _assertLinearInLiquidity(liquidity, lower, upper, tick);
    }

    /**
     * @dev The counterexample CI found (run 37468143938), pinned so it no longer depends on the
     *      seed: the fuzzer's raw arguments (367569556997685, 8388604, 0, -1921617) are liquidity
     *      367,569,556,997,685 on [-484116, 0] at tick -321615 after `bound`. The price is inside
     *      the range and amount1 is 38,175,002.60 before its floor, so L keeps 38,175,002 and 2L
     *      keeps 76,350,005 — one unit more than twice. One unit of token1 is 92,653,888,003,283.67
     *      wei of token0 at this price; carried through the conversion it adds 92,653,888,364,002
     *      wei, and the conversion's floors on the rest add 9,625,690 (one intermediate unit). The
     *      excess, 92,653,897,989,692 wei, is 6.5e-9 of the value: above the old fixed 1e-9
     *      tolerance, and 9,264,972 wei inside the analytic bound.
     */
    function test_ValueAt_IsLinearInLiquidity_OneExtraUnitOfToken1AtALowPrice() public view {
        testFuzz_ValueAt_IsLinearInLiquidity(367569556997685, 8388604, 0, -1921617);

        uint128 liquidity = 367_569_556_997_685;
        uint160 p = libs.sqrtAt(-321_615);
        (, uint256 y1) = libs.amounts(p, libs.sqrtAt(-484_116), libs.sqrtAt(0), liquidity);
        (, uint256 y2) = libs.amounts(p, libs.sqrtAt(-484_116), libs.sqrtAt(0), liquidity * 2);
        assertEq(y1, 38_175_002, "amount1 for L");
        assertEq(y2, 2 * y1 + 1, "amount1 for 2L: one unit more than twice");

        (uint256 single, uint256 twice) = _assertLinearInLiquidity(liquidity, -484_116, 0, -321_615);
        assertEq(twice - 2 * single, 92_653_897_989_692, "the excess: one unit of token1, in token0");
        assertGt((twice - 2 * single) * 1e18 / (2 * single), 1e9, "above the old fixed 1e-9 relative tolerance");
    }

    // ──────────────────────── Helpers ──────────────────────────

    /// @dev A valid range from two fuzzed ticks: both inside the bounds, lower strictly below upper.
    function _range(int24 tickA, int24 tickB) private pure returns (int24 lower, int24 upper) {
        lower = int24(bound(tickA, MIN_TICK, MAX_TICK - 1));
        upper = int24(bound(tickB, int256(lower) + 1, MAX_TICK));
    }

    /// @dev {PositionValue-valueAt} with every division rounded UP — the twin the real one must
    ///      never exceed. Uniswap's own mint math (SqrtPriceMath, roundUp = true) has this shape.
    function _valueRoundingUp(uint128 liquidity, int24 lower, int24 upper, int24 tick, bool inToken0)
        private
        view
        returns (uint256)
    {
        uint160 p = libs.sqrtAt(tick);
        uint160 a = libs.sqrtAt(lower);
        uint160 b = libs.sqrtAt(upper);
        uint256 x;
        uint256 y;
        if (p <= a) {
            x = _amount0Up(a, b, liquidity);
        } else if (p < b) {
            x = _amount0Up(p, b, liquidity);
            y = Math.mulDiv(liquidity, p - a, Q96, Math.Rounding.Ceil);
        } else {
            y = Math.mulDiv(liquidity, b - a, Q96, Math.Rounding.Ceil);
        }
        return inToken0
            ? x + Math.mulDiv(Math.mulDiv(y, Q96, p, Math.Rounding.Ceil), Q96, p, Math.Rounding.Ceil)
            : y + Math.mulDiv(Math.mulDiv(x, p, Q96, Math.Rounding.Ceil), p, Q96, Math.Rounding.Ceil);
    }

    /// @dev The rounding a two-step conversion can add between the floor and the ceiling twins:
    ///      8 units of the target token, plus 4 units of the source token valued in the target
    ///      (`price` = p^2 / 2^192, or its inverse), plus 4 x sqrt(price) for the intermediate.
    function _conversionSlack(uint160 p, bool inToken0) private pure returns (uint256) {
        if (inToken0) {
            uint256 sqrtInverse = Math.mulDiv(Q96, 1, p, Math.Rounding.Ceil);
            uint256 inverse = Math.mulDiv(Math.mulDiv(Q96, Q96, p, Math.Rounding.Ceil), 1, p, Math.Rounding.Ceil);
            return 8 + 4 * inverse + 4 * sqrtInverse;
        }
        uint256 sqrtPrice = Math.mulDiv(p, 1, Q96, Math.Rounding.Ceil);
        uint256 price = Math.mulDiv(p, p, 1 << 192, Math.Rounding.Ceil);
        return 8 + 4 * price + 4 * sqrtPrice;
    }

    /// @dev The two sides of {testFuzz_ValueAt_IsLinearInLiquidity}, in token0.
    function _assertLinearInLiquidity(uint128 liquidity, int24 lower, int24 upper, int24 tick)
        private
        view
        returns (uint256 single, uint256 twice)
    {
        single = libs.valueAt(liquidity, lower, upper, tick, true);
        twice = libs.valueAt(liquidity * 2, lower, upper, tick, true);
        assertGe(twice + 2, 2 * single, "never less than twice, to rounding");
        assertLe(twice, 2 * single + _linearitySlack(libs.sqrtAt(tick)), "never more than twice, beyond its rounding");
    }

    /// @dev The most doubling the liquidity can add on top of twice the value, in token0, as
    ///      derived at {testFuzz_ValueAt_IsLinearInLiquidity}: 2 units of token0, one unit of
    ///      token1 (`1 / price` = 2^192 / p^2) and two units of the intermediate (`2^96 / p`),
    ///      each rounded up.
    function _linearitySlack(uint160 p) private pure returns (uint256) {
        uint256 sqrtInverse = Math.mulDiv(Q96, 1, p, Math.Rounding.Ceil);
        uint256 inverse = Math.mulDiv(Math.mulDiv(Q96, Q96, p, Math.Rounding.Ceil), 1, p, Math.Rounding.Ceil);
        return 2 + inverse + 2 * sqrtInverse;
    }

    function _amount0Up(uint160 a, uint160 b, uint128 liquidity) private pure returns (uint256) {
        return Math.ceilDiv(Math.mulDiv(uint256(liquidity) << 96, b - a, b, Math.Rounding.Ceil), a);
    }

    /// @dev v3-periphery `getLiquidityForAmounts`, test-only (the vendored library leaves it out).
    function _liquidityForAmounts(uint160 p, uint160 a, uint160 b, uint256 x, uint256 y)
        private
        pure
        returns (uint128)
    {
        if (p <= a) return uint128(Math.mulDiv(x, Math.mulDiv(a, b, Q96), b - a));
        if (p < b) {
            uint128 l0 = uint128(Math.mulDiv(x, Math.mulDiv(p, b, Q96), b - p));
            uint128 l1 = uint128(Math.mulDiv(y, Q96, p - a));
            return l0 < l1 ? l0 : l1;
        }
        return uint128(Math.mulDiv(y, Q96, b - a));
    }
}
