// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, stdError} from "forge-std/Test.sol";
import {BaseForge} from "../utils/BaseForge.sol";
import {RawTickPool} from "../utils/RawTickPool.sol";
import {LPStakingVault} from "../../../contracts/lp-staking/LPStakingVault.sol";
import {TwapGuard} from "../../../contracts/lp-staking/libraries/TwapGuard.sol";
import {MockERC20Permit} from "../../../contracts/lp-staking/mocks/MockERC20Permit.sol";
import {MockPositionManager} from "../../../contracts/lp-staking/mocks/MockPositionManager.sol";
import {MockSwapRouter} from "../../../contracts/lp-staking/mocks/MockSwapRouter.sol";

/**
 * @notice Why this file exists: `TwapGuard._twapAndSpotTicks` does arithmetic the real pool
 *         can only ever exercise in one narrow band — its `tickCumulatives` always divide
 *         out to a tick inside +/-887272, and always with the sign the market happens to
 *         have. The floor correction, the truncation of the int56 quotient into an int24,
 *         and the unchecked int24 subtraction that follows it are therefore invisible on a
 *         fork, and equally invisible to the repo's existing pool mock, which derives its
 *         cumulatives from a chosen mean and so can never produce a remainder.
 *
 *  {RawTickPool} hands the guard raw cumulatives instead, which is the only way to state
 *  these properties as assertions rather than as reasoning about the code.
 */
contract TwapGuardMathTest is BaseForge {
    RawTickPool internal pool;
    LPStakingVault internal guard;

    uint32 internal constant WINDOW = 300;
    uint24 internal constant CEILING = 500;

    function setUp() public {
        MockERC20Permit a = new MockERC20Permit("Asset", "ASSET", 1e24, 18);
        MockERC20Permit b = new MockERC20Permit("USD Coin", "USDC", 1e12, 6);
        (address t0, address t1) = address(a) < address(b) ? (address(a), address(b)) : (address(b), address(a));

        pool = new RawTickPool(t0, t1, FEE);
        // The guard is abstract; the vault is the smallest concrete carrier of it, and using
        // the real contract keeps the test honest about which code path is measured — as a
        // proxy, because that is the only shape in which the parameters are ever seeded.
        guard = _deployVaultProxy(
            address(new MockPositionManager()),
            address(pool),
            t0,
            t1,
            FEE,
            address(new MockSwapRouter()),
            address(this),
            address(this),
            WINDOW,
            CEILING
        );
    }

    // ──────────────────────── Mean tick arithmetic ─────────────

    function test_Twap_ExactPositiveQuotientIsTheMeanTick() public {
        _setCumulatives(0, int56(1000) * int56(uint56(WINDOW)));
        (, int24 twapTick,,) = guard.previewTwap();
        assertEq(twapTick, 1000, "an exactly-divisible positive delta is the mean tick unchanged");
    }

    function test_Twap_ExactNegativeQuotientIsNotFlooredTwice() public {
        _setCumulatives(0, -int56(1000) * int56(uint56(WINDOW)));
        (, int24 twapTick,,) = guard.previewTwap();
        assertEq(twapTick, -1000, "an exactly-divisible negative delta must NOT be decremented again");
    }

    /**
     * @dev The floor correction. Solidity truncates toward zero, Uniswap's own
     *      `OracleLibrary` floors toward negative infinity, and the guard corrects for that
     *      with `if (tickDelta < 0 && tickDelta % window != 0) twapTick--`. Reachable only
     *      with a negative delta that does NOT divide the window.
     */
    function test_Twap_NegativeQuotientWithARemainderFloorsDownwards() public {
        _setCumulatives(0, -301); // -301 / 300 truncates to -1; the floor is -2
        (, int24 twapTick,,) = guard.previewTwap();
        assertEq(twapTick, -2, "a negative delta with a remainder must floor, not truncate");
    }

    /// @dev The asymmetry that makes the correction necessary: the positive side is NOT
    ///      corrected, so +301/300 stays 1 while -301/300 becomes -2.
    function test_Twap_PositiveQuotientWithARemainderStaysTruncated() public {
        _setCumulatives(0, 301);
        (, int24 twapTick,,) = guard.previewTwap();
        assertEq(twapTick, 1, "a positive delta with a remainder truncates toward zero");
    }

    function test_Twap_MinusOneWeiOfCumulativeFloorsToMinusOne() public {
        _setCumulatives(0, -1);
        (, int24 twapTick,,) = guard.previewTwap();
        assertEq(twapTick, -1, "the smallest negative delta must already floor to -1");
    }

    function test_Twap_ZeroDeltaIsTickZero() public {
        _setCumulatives(12345, 12345);
        (, int24 twapTick,,) = guard.previewTwap();
        assertEq(twapTick, 0, "a flat cumulative window means a mean tick of zero");
    }

    /// @dev Only the DELTA matters; the absolute cumulative offset must cancel out.
    function test_Twap_OnlyTheDeltaBetweenObservationsMatters() public {
        _setCumulatives(0, int56(600) * int56(uint56(WINDOW)));
        (, int24 fromZero,,) = guard.previewTwap();

        _setCumulatives(type(int56).max / 2, type(int56).max / 2 + int56(600) * int56(uint56(WINDOW)));
        (, int24 fromOffset,,) = guard.previewTwap();

        assertEq(fromOffset, fromZero, "the oracle's absolute cumulative must not affect the mean");
    }

    /// @dev The window is the divisor, so retuning it re-reads the same oracle differently.
    function test_Twap_WideningTheWindowHalvesTheMeanForTheSameDelta() public {
        _setCumulatives(0, 600 * 300);
        (, int24 narrow,,) = guard.previewTwap();
        assertEq(narrow, 600, "300s over a 180000 delta is a mean tick of 600");

        guard.setTwapParams(600, CEILING);
        (, int24 wide,,) = guard.previewTwap();
        assertEq(wide, 300, "the same delta read over 600s is a mean tick of 300");
    }

    // ──────────────────────── int24 truncation ─────────────────

    /**
     * @dev The quotient is an `int56` and the guard casts it straight to `int24`. One tick
     *      past `type(int24).max` the cast WRAPS to `type(int24).min`, and the guard reports
     *      a mean at the opposite end of the tick range with no error at all.
     *
     *      Genuinely unreachable against a real Uniswap pool — `tickCumulative` moves by at
     *      most 887272 per second, so the quotient is bounded by the tick range — but it is
     *      the exact reason the guard must never be treated as a price oracle.
     */
    function test_Twap_QuotientPastInt24MaxWrapsSilently() public {
        int56 justPastMax = int56(int256(type(int24).max) + 1); // 8_388_608
        _setCumulatives(0, justPastMax * int56(uint56(WINDOW)));
        // Park spot at the wrapped value so the deviation subtraction below cannot overflow
        // and mask the property under test.
        pool.setCurrentTick(type(int24).min);

        (, int24 twapTick,,) = guard.previewTwap();
        assertEq(twapTick, type(int24).min, "a quotient one past int24 max wraps to int24 min, silently");
    }

    function test_Twap_QuotientAtInt24MaxIsStillExact() public {
        _setCumulatives(0, int56(type(int24).max) * int56(uint56(WINDOW)));
        pool.setCurrentTick(type(int24).max);

        (, int24 twapTick,,) = guard.previewTwap();
        assertEq(twapTick, type(int24).max, "the largest representable quotient must survive the cast");
    }

    /**
     * @dev And once the two ticks sit at opposite extremes, `currentTick - twapTick`
     *      overflows `int24` and the guard reverts with an arithmetic panic rather than any
     *      typed error. Also unreachable on a real pool, and recorded here so the panic is a
     *      known consequence of the cast above rather than a surprise in an incident.
     */
    function test_Twap_DeviationAtOppositeInt24ExtremesPanics() public {
        _setCumulatives(0, int56(type(int24).min) * int56(uint56(WINDOW)));
        pool.setCurrentTick(type(int24).max);

        vm.expectRevert(stdError.arithmeticError);
        guard.previewTwap();
    }

    // ──────────────────────── observe() failures ───────────────

    /// @dev A cold oracle's `OLD` is not caught or translated anywhere in the stack; it
    ///      reaches the caller exactly as the pool raised it.
    function test_Twap_ObserveRevertBubblesUpUnchanged() public {
        pool.setObserveReverts(true, "OLD");

        vm.expectRevert(bytes("OLD"));
        guard.previewTwap();
    }

    /// @dev Any other pool-side failure bubbles just as literally — the guard adds no
    ///      wrapping of its own on this path.
    function test_Twap_AnyOtherObserveRevertAlsoBubblesUnchanged() public {
        pool.setObserveReverts(true, "LOK");

        vm.expectRevert(bytes("LOK"));
        guard.previewTwap();
    }

    // ──────────────────────── The ceiling ──────────────────────

    /// @dev `deviation > maxDeviationTicks` — so equality is inside the bound.
    function test_Guard_DeviationEqualToTheCeilingIsWithinBounds() public {
        _setCumulatives(0, 0);
        pool.setCurrentTick(int24(uint24(CEILING)));

        (,,, bool withinBounds) = guard.previewTwap();
        assertTrue(withinBounds, "a deviation exactly equal to the ceiling must pass");
    }

    function test_Guard_OneTickPastTheCeilingIsOutOfBounds() public {
        _setCumulatives(0, 0);
        pool.setCurrentTick(int24(uint24(CEILING)) + 1);

        (,,, bool withinBounds) = guard.previewTwap();
        assertFalse(withinBounds, "one tick past the ceiling must fail");
    }

    /// @dev The ceiling is symmetric: the guard takes the absolute deviation.
    function test_Guard_IsSymmetricAboveAndBelowTheMean() public {
        _setCumulatives(0, 0);

        pool.setCurrentTick(int24(uint24(CEILING)) + 1);
        (,,, bool above) = guard.previewTwap();

        pool.setCurrentTick(-int24(uint24(CEILING)) - 1);
        (,,, bool below) = guard.previewTwap();

        assertEq(above, below, "the guard must treat an equal drift up and down identically");
        assertFalse(above, "and reject both");
    }

    /// @dev The stored parameter IS the tick count the preview reports and the guard
    ///      enforces — no conversion anywhere, and the ceiling on it is 1823 ticks.
    function test_Guard_ReportsTheConfiguredTickCount() public {
        _setCumulatives(0, 0);
        pool.setCurrentTick(0);

        (,, int24 maxDeviationTicks,) = guard.previewTwap();
        assertEq(maxDeviationTicks, int24(uint24(CEILING)), "the preview reports the stored tick count verbatim");

        guard.setTwapParams(WINDOW, MAX_TWAP_DEVIATION_TICKS);
        (,, int24 widest,) = guard.previewTwap();
        assertEq(widest, int24(uint24(MAX_TWAP_DEVIATION_TICKS)), "the widest setting is 1823 ticks");
        assertEq(widest, 1823, "and 1823 is floor(ln 1.2 / ln 1.0001), a 20% price move");
    }

    /// @dev The preview and the enforcing path must never disagree; the preview exists
    ///      precisely so a frontend can predict the revert.
    function test_Guard_PreviewAgreesWithTheEnforcedDecisionOnBothSides() public {
        _setCumulatives(0, 0);

        pool.setCurrentTick(int24(uint24(CEILING)));
        (int24 spot, int24 mean, int24 ceiling, bool ok) = guard.previewTwap();
        assertTrue(ok, "at the boundary the preview says pass");
        assertEq(_tickDistance(spot, mean), uint256(uint24(ceiling)), "and the distance really is the ceiling");

        pool.setCurrentTick(int24(uint24(CEILING)) + 1);
        (,,, bool ok2) = guard.previewTwap();
        assertFalse(ok2, "one tick further the preview says fail");
    }

    // ──────────────────────── Parameter bounds ─────────────────

    /// @dev The pool is an immutable, so its zero check belongs to — and fires on — the
    ///      IMPLEMENTATION deploy, before any proxy exists to initialise.
    function test_Guard_ImplementationConstructorRejectsTheZeroPool() public {
        // Deployed BEFORE the cheatcode is armed: `vm.expectRevert` binds to the very next
        // call frame, and a `new` is one.
        address npm = address(new MockPositionManager());
        address router = address(new MockSwapRouter());

        vm.expectRevert(TwapGuard.InvalidPool.selector);
        new LPStakingVault(npm, address(0), address(1), address(2), FEE, router);
    }

    function test_Guard_SetterRejectsAWindowOneSecondBelowTheMinimum() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                TwapGuard.InvalidTwapWindow.selector, MIN_TWAP_WINDOW - 1, MIN_TWAP_WINDOW, MAX_TWAP_WINDOW
            )
        );
        guard.setTwapParams(MIN_TWAP_WINDOW - 1, CEILING);
    }

    /// @dev The ceiling the 2026-08-26 review asked for: the window is bounded on BOTH
    ///      sides, so no owner transaction can set a lookback the oracle cannot serve.
    function test_Guard_SetterRejectsAWindowOneSecondAboveTheMaximum() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                TwapGuard.InvalidTwapWindow.selector, MAX_TWAP_WINDOW + 1, MIN_TWAP_WINDOW, MAX_TWAP_WINDOW
            )
        );
        guard.setTwapParams(MAX_TWAP_WINDOW + 1, CEILING);

        // and the extreme the old, unbounded setter used to accept
        vm.expectRevert(
            abi.encodeWithSelector(
                TwapGuard.InvalidTwapWindow.selector, type(uint32).max, MIN_TWAP_WINDOW, MAX_TWAP_WINDOW
            )
        );
        guard.setTwapParams(type(uint32).max, CEILING);

        assertEq(guard.twapWindow(), WINDOW, "a rejected window must leave the stored one untouched");
    }

    function test_Guard_SetterAcceptsExactlyTheMinimumWindow() public {
        guard.setTwapParams(MIN_TWAP_WINDOW, CEILING);
        assertEq(guard.twapWindow(), MIN_TWAP_WINDOW, "the minimum window itself must be accepted");
    }

    function test_Guard_SetterAcceptsExactlyTheMaximumWindow() public {
        guard.setTwapParams(MAX_TWAP_WINDOW, CEILING);
        assertEq(guard.twapWindow(), MAX_TWAP_WINDOW, "the maximum window itself must be accepted");
    }

    function test_Guard_SetterAcceptsExactlyTheMaximumDeviation() public {
        guard.setTwapParams(WINDOW, MAX_TWAP_DEVIATION_TICKS);
        assertEq(
            guard.maxTwapDeviationTicks(), MAX_TWAP_DEVIATION_TICKS, "the maximum deviation itself must be accepted"
        );
    }

    function test_Guard_SetterRejectsOneTickPastTheMaximumDeviation() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                TwapGuard.InvalidTwapDeviation.selector, MAX_TWAP_DEVIATION_TICKS + 1, MAX_TWAP_DEVIATION_TICKS
            )
        );
        guard.setTwapParams(WINDOW, MAX_TWAP_DEVIATION_TICKS + 1);
        assertEq(guard.maxTwapDeviationTicks(), CEILING, "a rejected ceiling must leave the stored one untouched");
    }

    function test_Guard_SetterEmitsTheFullNewState() public {
        vm.expectEmit(false, false, false, true, address(guard));
        emit TwapGuard.TwapParamsSet(900, 321);
        guard.setTwapParams(900, 321);
    }

    // ──────────────────────── Helpers ──────────────────────────

    /// @param older The cumulative the pool reports for `secondsAgos[0]` (window seconds ago).
    /// @param newer The cumulative it reports for `secondsAgos[1]` (now).
    function _setCumulatives(int56 older, int56 newer) private {
        int56[] memory c = new int56[](2);
        c[0] = older;
        c[1] = newer;
        pool.setTickCumulatives(c);
    }
}
