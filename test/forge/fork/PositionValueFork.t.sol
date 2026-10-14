// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/console.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ForkHarness} from "../utils/ForkHarness.sol";
import {INonfungiblePositionManager} from "../../../contracts/lp-staking/interfaces/INonfungiblePositionManager.sol";
import {TickMath} from "../../../contracts/lp-staking/libraries/TickMath.sol";
import {LiquidityAmounts} from "../../../contracts/lp-staking/libraries/LiquidityAmounts.sol";
import {PositionValue} from "../../../contracts/lp-staking/libraries/PositionValue.sol";

/**
 * @notice Why this file exists: `PositionValue.valueAt` is the number every ApeBond bonus is a
 *         share of, and the unit tier can only check it against itself. Here it is checked
 *         against what REAL Uniswap pays out: a position minted on the fork's real pool through
 *         the real position manager, then emptied with `decreaseLiquidity`, whose return values
 *         are the amounts the pool actually releases.
 *
 *  The comparison is made with spot EQUAL to the vault's TWAP — no trade for longer than the
 *  TWAP window, so the arithmetic-mean tick is the current tick exactly — because that is the
 *  price the adapter and the escrow value at, and the only price at which "the value at the
 *  TWAP" and "what the position is worth right now" are the same question. Two comparisons:
 *
 *    (a) `LiquidityAmounts.getAmountsForLiquidity` at the pool's REAL `sqrtPriceX96` against the
 *        amounts `decreaseLiquidity` returns. Uniswap's burn rounds down with the same
 *        formulas, so these are expected to be equal to the wei.
 *    (b) `valueAt` at the TWAP tick against the burned amounts valued at that same tick. The
 *        library prices at `getSqrtRatioAtTick(tick)`, the bottom of the tick the real price
 *        sits in, so the two differ by less than one tick of price: < 1e-4 relative.
 */
contract PositionValueForkTest is ForkHarness {
    uint256 internal constant Q96 = 1 << 96;

    function setUp() public {
        _deployForkedStack();
    }

    /// @dev A two-sided position around spot.
    function test_ValueAt_MatchesWhatDecreaseLiquidityReturns_InRange() public {
        uint256 tokenId = _mintAroundSpot(alice, 1200);
        _compare(tokenId, "in range");
    }

    /// @dev A position wholly above spot holds only token0; one wholly below holds only token1.
    ///      Both are exact for the side they hold, whatever the price.
    function test_ValueAt_MatchesWhatDecreaseLiquidityReturns_OutOfRange() public {
        int24 tick = _alignDown(_currentTick());
        uint256 above = _mintPositionFor(alice, tick + 1200, tick + 2400, 10_000e18, 10_000e6);
        uint256 below = _mintPositionFor(alice, tick - 2400, tick - 1200, 10_000e18, 10_000e6);
        _compare(above, "wholly above spot (token0 only)");
        _compare(below, "wholly below spot (token1 only)");
    }

    // ──────────────────────── The comparison ───────────────────

    /// @dev One position's figures, in memory: more than the stack holds without via-IR.
    struct Burn {
        int24 lower;
        int24 upper;
        int24 twapTick;
        uint128 liquidity;
        uint256 burned0;
        uint256 burned1;
    }

    function _compare(uint256 tokenId, string memory label) private {
        console.log(label);
        Burn memory b = _quietWindowThenBurn(tokenId);
        _checkValue(b);
    }

    /// @dev Quiet window, then (a): the library's amounts at the real price vs. the released ones.
    function _quietWindowThenBurn(uint256 tokenId) private returns (Burn memory b) {
        // No trade for longer than the window: the TWAP is the current tick exactly.
        _advance(uint256(profile.twapWindow) + 1);
        (uint160 sqrtP, int24 spot,,,,,) = poolRef.slot0();
        (int24 currentTick, int24 twapTick,, bool withinBounds) = vault.previewTwap();
        assertEq(currentTick, spot, "the vault reads the pool's spot");
        assertEq(twapTick, spot, "spot equals the TWAP after a quiet window");
        assertTrue(withinBounds, "inside the guard");
        b.twapTick = twapTick;

        (,,,,, b.lower, b.upper, b.liquidity,,,,) = npm.positions(tokenId);
        (uint256 expected0, uint256 expected1) = LiquidityAmounts.getAmountsForLiquidity(
            sqrtP, TickMath.getSqrtRatioAtTick(b.lower), TickMath.getSqrtRatioAtTick(b.upper), b.liquidity
        );

        vm.prank(alice);
        (b.burned0, b.burned1) = npm.decreaseLiquidity(
            INonfungiblePositionManager.DecreaseLiquidityParams({
                tokenId: tokenId, liquidity: b.liquidity, amount0Min: 0, amount1Min: 0, deadline: block.timestamp
            })
        );

        console.log("  token0: library vs decreaseLiquidity, wei difference", _diff(expected0, b.burned0));
        console.log("  token1: library vs decreaseLiquidity, wei difference", _diff(expected1, b.burned1));
        assertEq(expected0, b.burned0, "token0: getAmountsForLiquidity == decreaseLiquidity");
        assertEq(expected1, b.burned1, "token1: getAmountsForLiquidity == decreaseLiquidity");
    }

    /// @dev (b): valueAt at the TWAP tick vs. the released amounts valued at that same tick.
    function _checkValue(Burn memory b) private pure {
        uint160 sqrtTick = TickMath.getSqrtRatioAtTick(b.twapTick);
        uint256 released0 = b.burned0 + Math.mulDiv(Math.mulDiv(b.burned1, Q96, sqrtTick), Q96, sqrtTick);
        uint256 released1 = b.burned1 + Math.mulDiv(Math.mulDiv(b.burned0, sqrtTick, Q96), sqrtTick, Q96);
        uint256 value0 = PositionValue.valueAt(b.liquidity, b.lower, b.upper, b.twapTick, true);
        uint256 value1 = PositionValue.valueAt(b.liquidity, b.lower, b.upper, b.twapTick, false);
        console.log("  value in token0: relative difference, parts per 1e18", _relDiff(value0, released0));
        console.log("  value in token1: relative difference, parts per 1e18", _relDiff(value1, released1));
        assertApproxEqRel(value0, released0, 1e14, "in token0: within one tick (1e-4)");
        assertApproxEqRel(value1, released1, 1e14, "in token1: within one tick (1e-4)");
    }

    function _diff(uint256 a, uint256 b) private pure returns (uint256) {
        return a > b ? a - b : b - a;
    }

    function _relDiff(uint256 a, uint256 b) private pure returns (uint256) {
        if (a == b) return 0;
        return Math.mulDiv(_diff(a, b), 1e18, a > b ? a : b);
    }
}
