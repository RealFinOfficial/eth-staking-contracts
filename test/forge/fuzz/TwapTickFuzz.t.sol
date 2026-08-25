// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LocalHarness} from "../utils/LocalHarness.sol";
import {RawTickPool} from "../utils/RawTickPool.sol";
import {LPStakingVault} from "../../../contracts/lp-staking/LPStakingVault.sol";
import {TwapGuard} from "../../../contracts/lp-staking/libraries/TwapGuard.sol";

/**
 * @notice Why this file exists: `test/forge/unit/TwapGuardMath.t.sol` pins the guard's tick
 *         arithmetic at hand-picked points. These are the same behaviours stated as
 *         PROPERTIES over the whole input domain, which is where an off-by-one in the floor
 *         correction or in a bound check would actually hide.
 *
 *  Two deliberate choices about how the properties are written:
 *
 *    * The mean tick is never compared against a re-implementation of the contract's own
 *      division. It is compared against the DEFINITION of a floor — `tick * window <= delta`
 *      and `(tick + 1) * window > delta` — so a copied bug in the expectation cannot make
 *      the assertion pass.
 *    * The oracle is {RawTickPool}, not the repo's pool mock. The mock derives its
 *      cumulatives from a chosen mean and so can never hand the guard a remainder, which is
 *      exactly the input that makes the floor correction observable.
 *
 *  Domain: ticks are bounded to Uniswap's own usable range (+/-887272) and windows to
 *  [MIN_TWAP_WINDOW, 1 day]. Outside that range the guard's `int56 -> int24` cast wraps and
 *  the `currentTick - twapTick` subtraction can panic; both are single, named behaviours and
 *  belong in the unit file, not in a property whose domain would then be self-contradictory.
 */
contract TwapTickFuzzTest is LocalHarness {
    /// @dev Uniswap's own usable tick bound. A real oracle mean can never sit outside it.
    int256 internal constant MAX_USABLE_TICK = 887272;
    /// @dev Widest window the properties explore. Production runs 1800.
    uint256 internal constant MAX_WINDOW = 1 days;

    RawTickPool internal rawPool;
    /// @dev {TwapGuard} is abstract; the vault is the smallest concrete carrier of it, and
    ///      using the production contract keeps the measured code path the real one.
    LPStakingVault internal guard;

    function setUp() public {
        _deployLocalStack();

        rawPool = new RawTickPool(token0, token1, FEE);
        guard = new LPStakingVault(
            address(npmMock),
            address(rawPool),
            token0,
            token1,
            FEE,
            address(routerMock),
            address(this),
            MIN_TWAP_WINDOW,
            500
        );
    }

    // ──────────────────────── Mean tick ────────────────────────

    /**
     * @dev The mean tick is the cumulative delta floored by the window — for every sign of
     *      the delta, and for every remainder. Asserted as the two inequalities that DEFINE
     *      a floor rather than against a second division.
     */
    function testFuzz_TwapGuard_MeanTickIsTheFlooredQuotient(uint256 windowSeed, int256 deltaSeed) public {
        uint32 window = uint32(bound(windowSeed, MIN_TWAP_WINDOW, MAX_WINDOW));
        int256 w = int256(uint256(window));
        int256 delta = bound(deltaSeed, -MAX_USABLE_TICK * w, MAX_USABLE_TICK * w);

        guard.setTwapParams(window, 500);
        _setCumulativeDelta(delta);

        (, int24 twapTick,,) = guard.previewTwap();

        assertLe(int256(twapTick) * w, delta, "the mean tick times the window never exceeds the cumulative delta");
        assertGt((int256(twapTick) + 1) * w, delta, "one tick higher would exceed it, so this is the floor");
    }

    /**
     * @dev The mean tick stays inside the usable tick range whenever the oracle's own
     *      reading does. This is what makes the `int56 -> int24` cast a no-op on every input
     *      a real pool can produce.
     */
    function testFuzz_TwapGuard_MeanTickStaysInTheUsableTickRange(uint256 windowSeed, int256 tickSeed) public {
        uint32 window = uint32(bound(windowSeed, MIN_TWAP_WINDOW, MAX_WINDOW));
        int256 meanTick = bound(tickSeed, -MAX_USABLE_TICK, MAX_USABLE_TICK);

        guard.setTwapParams(window, 500);
        _setCumulativeDelta(meanTick * int256(uint256(window)));

        (, int24 twapTick,,) = guard.previewTwap();

        assertEq(int256(twapTick), meanTick, "an exactly divisible delta reproduces the mean tick unchanged");
        assertLe(int256(twapTick), MAX_USABLE_TICK, "the mean tick is bounded above by the usable tick range");
        assertGe(int256(twapTick), -MAX_USABLE_TICK, "and bounded below by it");
    }

    // ──────────────────────── Deviation ────────────────────────

    /**
     * @dev The guard measures a DISTANCE: swapping which of the two ticks is spot and which
     *      is the mean can never change the verdict. A one-sided comparison would fail here.
     */
    function testFuzz_TwapGuard_DeviationIsSymmetricInSpotAndMean(int256 spotSeed, int256 meanSeed, uint256 ceilSeed)
        public
    {
        int24 spot = int24(bound(spotSeed, -MAX_USABLE_TICK, MAX_USABLE_TICK));
        int24 mean = int24(bound(meanSeed, -MAX_USABLE_TICK, MAX_USABLE_TICK));
        uint24 ceiling = uint24(bound(ceilSeed, 1, MAX_TWAP_DEVIATION_BPS));

        guard.setTwapParams(MIN_TWAP_WINDOW, ceiling);

        (uint256 distanceA, bool withinA) = _readGuard(spot, mean);
        (uint256 distanceB, bool withinB) = _readGuard(mean, spot);

        assertEq(distanceA, distanceB, "the spot-to-mean distance is symmetric in its two arguments");
        assertEq(withinA, withinB, "and so is the verdict the guard draws from it");
    }

    /**
     * @dev `withinBounds` is exactly `distance <= ceiling`, with the ceiling read in ticks.
     *      The `<=` is the assertion: the guard admits a deviation sitting exactly ON the
     *      ceiling and refuses the next tick out.
     */
    function testFuzz_TwapGuard_WithinBoundsIsExactlyTheCeilingComparison(
        int256 spotSeed,
        int256 meanSeed,
        uint256 ceilSeed
    ) public {
        int24 spot = int24(bound(spotSeed, -MAX_USABLE_TICK, MAX_USABLE_TICK));
        int24 mean = int24(bound(meanSeed, -MAX_USABLE_TICK, MAX_USABLE_TICK));
        uint24 ceiling = uint24(bound(ceilSeed, 1, MAX_TWAP_DEVIATION_BPS));

        guard.setTwapParams(MIN_TWAP_WINDOW, ceiling);
        (uint256 distance, bool within) = _readGuard(spot, mean);

        assertEq(within, distance <= uint256(ceiling), "withinBounds is in-range exactly when distance <= ceiling");
    }

    /**
     * @dev Widening the ceiling can only ever admit more: the verdict is monotonic in the
     *      parameter. A guard that flipped a pass back to a fail as the operator relaxed it
     *      would be unusable, and the bps-to-ticks approximation must not introduce one.
     */
    function testFuzz_TwapGuard_WideningTheCeilingNeverRevokesAPass(
        int256 spotSeed,
        int256 meanSeed,
        uint256 tightSeed,
        uint256 wideSeed
    ) public {
        int24 spot = int24(bound(spotSeed, -MAX_USABLE_TICK, MAX_USABLE_TICK));
        int24 mean = int24(bound(meanSeed, -MAX_USABLE_TICK, MAX_USABLE_TICK));
        uint24 tight = uint24(bound(tightSeed, 1, MAX_TWAP_DEVIATION_BPS));
        uint24 wide = uint24(bound(wideSeed, tight, MAX_TWAP_DEVIATION_BPS));

        guard.setTwapParams(MIN_TWAP_WINDOW, tight);
        (, bool withinTight) = _readGuard(spot, mean);

        guard.setTwapParams(MIN_TWAP_WINDOW, wide);
        (, bool withinWide) = _readGuard(spot, mean);

        if (withinTight) {
            assertTrue(withinWide, "a wider ceiling must never revoke a pass the tighter one gave");
        }
    }

    // ──────────────────────── Parameter bounds ─────────────────

    /**
     * @dev The window is bounded from BELOW only. The property states both halves in one
     *      pass: below the minimum the setter reverts and nothing is stored; at or above it
     *      the value is stored verbatim, however large.
     */
    function testFuzz_TwapParams_WindowIsAcceptedExactlyFromTheMinimumUp(uint256 windowSeed) public {
        uint32 window = uint32(bound(windowSeed, 0, uint256(MIN_TWAP_WINDOW) * 2));

        uint32 before_ = guard.twapWindow();
        if (window < MIN_TWAP_WINDOW) {
            vm.expectRevert(abi.encodeWithSelector(TwapGuard.InvalidTwapWindow.selector, window, MIN_TWAP_WINDOW));
            guard.setTwapParams(window, 500);
            assertEq(guard.twapWindow(), before_, "a rejected window must leave the stored one untouched");
        } else {
            guard.setTwapParams(window, 500);
            assertEq(guard.twapWindow(), window, "an accepted window is stored verbatim");
        }
    }

    /**
     * @dev The deviation ceiling is bounded on BOTH sides: zero is refused (it would brick
     *      every swap) and anything past {MAX_TWAP_DEVIATION_BPS} is refused too.
     */
    function testFuzz_TwapParams_DeviationIsAcceptedExactlyInsideItsCeiling(uint256 bpsSeed) public {
        uint24 bps = uint24(bound(bpsSeed, 0, uint256(MAX_TWAP_DEVIATION_BPS) * 2));

        uint24 before_ = guard.maxTwapDeviationBps();
        if (bps == 0 || bps > MAX_TWAP_DEVIATION_BPS) {
            vm.expectRevert(
                abi.encodeWithSelector(TwapGuard.InvalidTwapDeviation.selector, bps, MAX_TWAP_DEVIATION_BPS)
            );
            guard.setTwapParams(MIN_TWAP_WINDOW, bps);
            assertEq(guard.maxTwapDeviationBps(), before_, "a rejected ceiling must leave the stored one untouched");
        } else {
            guard.setTwapParams(MIN_TWAP_WINDOW, bps);
            assertEq(guard.maxTwapDeviationBps(), bps, "an accepted ceiling is stored verbatim");
        }
    }

    // ──────────────────────── Helpers ──────────────────────────

    /// @dev Puts spot at `spot` and the oracle mean at exactly `mean`, then reads the guard.
    function _readGuard(int24 spot, int24 mean) private returns (uint256 distance, bool within) {
        rawPool.setCurrentTick(spot);
        _setCumulativeDelta(int256(mean) * int256(uint256(guard.twapWindow())));

        (int24 currentTick, int24 twapTick,, bool withinBounds) = guard.previewTwap();
        return (_tickDistance(currentTick, twapTick), withinBounds);
    }

    /// @dev `observe([window, 0])` answers `[0, delta]`, so `tickCumulatives[1] - [0] == delta`.
    function _setCumulativeDelta(int256 delta) private {
        int56[] memory cumulatives = new int56[](2);
        cumulatives[0] = 0;
        cumulatives[1] = int56(delta);
        rawPool.setTickCumulatives(cumulatives);
    }
}
