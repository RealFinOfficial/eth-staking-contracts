// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkHarness} from "../utils/ForkHarness.sol";
import {TwapGuard, SwapParams} from "../../../contracts/lp-staking/libraries/TwapGuard.sol";

/**
 * @notice Why this file exists: the spot-vs-TWAP guard is the only on-chain manipulation
 *         circuit breaker in the stack, and everything about it — whether it can be read at
 *         all, where it trips, what it does not cover, and what an owner can do to it — is a
 *         property of the REAL pool oracle, not of a mock that returns a chosen tick.
 *
 *  Two contracts, because the oracle's state is the subject:
 *    * {TwapColdOracleTest} runs on a freshly deployed stack whose pool still stores ONE
 *      observation. That is the state every production deployment starts in, and SEC-01
 *      lives there.
 *    * {TwapManipulationTest} runs on a warmed oracle and pushes real money through the real
 *      router to move spot away from the TWAP.
 */
contract TwapColdOracleTest is ForkHarness {
    /// @dev Deliberately the COLD rung: no `increaseObservationCardinalityNext`, no history.
    function setUp() public {
        _forkAndDeploy();
    }

    /**
     * @dev FINDING SEC-01 (O-01/O-15, deploy blocker): a Uniswap V3 pool stores ONE
     *      observation until someone grows the array AND blocks trade past it. Until then
     *      `pool.observe([twapWindow, 0])` reverts with the bare string `OLD`, which the
     *      guard does not catch and does not translate — so every swap-bearing rebalance
     *      reverts with an error no caller can interpret. Asserted as the CURRENT behaviour;
     *      the fix is operational (grow the array and warm it before announcing the program),
     *      not a contract change.
     */
    function test_SEC01_RebalanceWithSwapRevertsBareOldOnAColdOracle() public {
        uint256 tokenId = _mintAndStake(alice, 600);

        (,,,, uint16 cardinality,,) = poolRef.slot0();
        assertEq(cardinality, 1, "a freshly created pool stores exactly one observation");

        SwapParams memory swap =
            SwapParams({zeroForOne: false, amountIn: 1_000e6, amountOutMin: 0, amount0Min: 0, amount1Min: 0});
        // Read the tick BEFORE arming the cheatcode: `vm.expectRevert` binds to the very
        // next external call, and `_currentTick()` is one.
        int24 tick = _currentTick();

        vm.prank(alice);
        vm.expectRevert(bytes("OLD"));
        vault.rebalance(tokenId, _alignDown(tick) - 600, _alignUp(tick) + 600, swap, FAR_DEADLINE);
    }

    /// @dev FINDING SEC-01, zap leg: the same cold oracle blocks every zap-in that swaps.
    function test_SEC01_ZapInRevertsBareOldOnAColdOracle() public {
        int24 tick = _currentTick();
        SwapParams memory swap =
            SwapParams({zeroForOne: false, amountIn: 500e6, amountOutMin: 0, amount0Min: 0, amount1Min: 0});

        vm.startPrank(alice);
        usdcToken.approve(address(zapper), 1_000e6);
        vm.expectRevert(bytes("OLD"));
        zapper.zapIn(1_000e6, _alignDown(tick) - 600, _alignUp(tick) + 600, swap, FAR_DEADLINE);
        vm.stopPrank();
    }

    /// @dev The other half of the finding: only the GUARDED paths are blocked. Custody and
    ///      exits work from block one, which is what makes the finding operational.
    function test_SEC01_ColdOracleLeavesStakeUnstakeAndSwapFreeRebalanceWorking() public {
        uint256 tokenId = _mintAndStake(alice, 600);
        assertEq(vault.stakerOf(tokenId), alice, "stake must work with no oracle history");

        int24 tick = _currentTick();
        vm.prank(alice);
        uint256 newTokenId =
            vault.rebalance(tokenId, _alignDown(tick) - 1200, _alignUp(tick) + 1200, _noSwap(), FAR_DEADLINE);
        assertEq(vault.stakerOf(newTokenId), alice, "a swap-free rebalance must work with no oracle history");

        vm.prank(alice);
        vault.unstake(newTokenId);
        assertEq(npm.ownerOf(newTokenId), alice, "unstake must work with no oracle history");
    }

    /// @dev The frontend pre-check inherits the same coldness, so a user is told before
    ///      submitting rather than by a bare `OLD` in a failed transaction.
    function test_SEC01_PreviewTwapAlsoRevertsOnAColdOracle() public {
        vm.expectRevert(bytes("OLD"));
        vault.previewTwap();

        vm.expectRevert(bytes("OLD"));
        zapper.previewTwap();
    }

    /// @dev And the operational fix really is sufficient: grow the array, trade past the
    ///      window, and the same call becomes readable.
    function test_SEC01_GrowingAndWarmingTheOracleMakesTheGuardReadable() public {
        _warmOracle();

        (,,,, uint16 cardinality,,) = poolRef.slot0();
        assertGt(cardinality, 1, "warm-up must have grown the stored observation count");

        (,,, bool withinBounds) = vault.previewTwap();
        assertTrue(withinBounds, "a warmed oracle must give the guard a readable, passing answer");
    }
}

contract TwapManipulationTest is ForkHarness {
    /// @dev Whale trade sizes measured against the seeded depth: ~700 ticks each way.
    uint256 internal constant PUSH_UP_USDC = 500_000e6;
    uint256 internal constant PUSH_DOWN_ASSET = 1_000_000e18;

    function setUp() public {
        _deployForkedStack();
    }

    // ──────────────────────── Baseline ─────────────────────────

    function test_Guard_PassesWhileSpotSitsOnTheTwap() public view {
        (int24 spot, int24 twap, int24 maxDeviationTicks, bool withinBounds) = vault.previewTwap();
        assertTrue(withinBounds, "an unmanipulated market must pass the guard");
        assertLe(_tickDistance(spot, twap), uint256(uint24(maxDeviationTicks)), "deviation must sit inside the ceiling");
    }

    function test_Guard_VaultAndZapperReportTheSameOracle() public view {
        (int24 vSpot, int24 vTwap,,) = vault.previewTwap();
        (int24 zSpot, int24 zTwap,,) = zapper.previewTwap();
        assertEq(vSpot, zSpot, "both contracts must read spot from the same pool");
        assertEq(vTwap, zTwap, "both contracts must read the same TWAP over the same window");
    }

    // ──────────────────────── Manipulation ─────────────────────

    function test_Guard_RevertsRebalanceAfterSpotIsPushedAboveTheCeiling() public {
        uint256 tokenId = _mintAndStake(alice, 600);
        _pushSpotUp(PUSH_UP_USDC);

        assertGt(_deviationTicks(), uint256(profile.maxDevTicks), "the push must actually leave the ceiling behind");

        SwapParams memory swap =
            SwapParams({zeroForOne: false, amountIn: 1_000e6, amountOutMin: 0, amount0Min: 0, amount1Min: 0});
        vm.prank(alice);
        vm.expectPartialRevert(TwapGuard.TwapDeviationTooHigh.selector);
        vault.rebalance(tokenId, MIN_TICK_ALIGNED, MAX_TICK_ALIGNED, swap, FAR_DEADLINE);
    }

    function test_Guard_RevertsRebalanceAfterSpotIsPushedBelowTheCeiling() public {
        uint256 tokenId = _mintAndStake(alice, 600);
        _pushSpotDown(PUSH_DOWN_ASSET);

        assertGt(_deviationTicks(), uint256(profile.maxDevTicks), "the push must actually leave the ceiling behind");

        SwapParams memory swap =
            SwapParams({zeroForOne: true, amountIn: 1_000e18, amountOutMin: 0, amount0Min: 0, amount1Min: 0});
        vm.prank(alice);
        vm.expectPartialRevert(TwapGuard.TwapDeviationTooHigh.selector);
        vault.rebalance(tokenId, MIN_TICK_ALIGNED, MAX_TICK_ALIGNED, swap, FAR_DEADLINE);
    }

    function test_Guard_RevertsZapInAfterSpotIsPushedAboveTheCeiling() public {
        _pushSpotUp(PUSH_UP_USDC);

        SwapParams memory swap =
            SwapParams({zeroForOne: false, amountIn: 500e6, amountOutMin: 0, amount0Min: 0, amount1Min: 0});
        vm.startPrank(alice);
        usdcToken.approve(address(zapper), 1_000e6);
        vm.expectPartialRevert(TwapGuard.TwapDeviationTooHigh.selector);
        zapper.zapIn(1_000e6, MIN_TICK_ALIGNED, MAX_TICK_ALIGNED, swap, FAR_DEADLINE);
        vm.stopPrank();
    }

    /// @dev The error carries the three numbers an operator needs to size the parameter.
    function test_Guard_RevertCarriesSpotTwapAndTheCeiling() public {
        uint256 tokenId = _mintAndStake(alice, 600);
        _pushSpotUp(PUSH_UP_USDC);

        (int24 spot, int24 twap, int24 maxDeviationTicks,) = vault.previewTwap();
        SwapParams memory swap =
            SwapParams({zeroForOne: false, amountIn: 1_000e6, amountOutMin: 0, amount0Min: 0, amount1Min: 0});

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TwapGuard.TwapDeviationTooHigh.selector, spot, twap, maxDeviationTicks));
        vault.rebalance(tokenId, MIN_TICK_ALIGNED, MAX_TICK_ALIGNED, swap, FAR_DEADLINE);
    }

    /// @dev The comparison is `deviation > ceiling`, so a deviation EQUAL to the ceiling
    ///      passes. Proved by tuning the ceiling to the measured deviation rather than by
    ///      trying to land the pool on an exact tick.
    function test_Guard_DeviationExactlyAtTheCeilingIsAllowed() public {
        uint256 tokenId = _mintAndStake(alice, 600);
        _pushSpotUp(50_000e6);

        uint256 deviation = _deviationTicks();
        assertGt(deviation, 1, "the push must produce a measurable deviation to tune against");
        assertLe(deviation, MAX_TWAP_DEVIATION_TICKS, "the tuned ceiling must stay inside the contract's own bound");

        vm.prank(multisig);
        vault.setTwapParams(MIN_TWAP_WINDOW, uint24(deviation));

        SwapParams memory swap =
            SwapParams({zeroForOne: false, amountIn: 1_000e6, amountOutMin: 0, amount0Min: 0, amount1Min: 0});
        vm.prank(alice);
        uint256 newTokenId = vault.rebalance(tokenId, MIN_TICK_ALIGNED, MAX_TICK_ALIGNED, swap, FAR_DEADLINE);
        assertEq(vault.stakerOf(newTokenId), alice, "deviation == ceiling must pass the guard");
    }

    /// @dev One tick tighter and the same call reverts. Together with the test above this
    ///      pins the boundary to the exact tick.
    function test_Guard_OneTickTighterThanTheDeviationReverts() public {
        uint256 tokenId = _mintAndStake(alice, 600);
        _pushSpotUp(50_000e6);

        uint256 deviation = _deviationTicks();
        assertGt(deviation, 1, "the push must produce a deviation with room to tighten below it");

        vm.prank(multisig);
        vault.setTwapParams(MIN_TWAP_WINDOW, uint24(deviation - 1));

        SwapParams memory swap =
            SwapParams({zeroForOne: false, amountIn: 1_000e6, amountOutMin: 0, amount0Min: 0, amount1Min: 0});
        vm.prank(alice);
        vm.expectPartialRevert(TwapGuard.TwapDeviationTooHigh.selector);
        vault.rebalance(tokenId, MIN_TICK_ALIGNED, MAX_TICK_ALIGNED, swap, FAR_DEADLINE);
    }

    /// @dev The breaker is temporary by construction: the TWAP walks toward the manipulated
    ///      spot, and once a full window has passed at the new price the guard reopens.
    function test_Guard_ReopensOnceTheTwapCatchesUpWithSpot() public {
        uint256 tokenId = _mintAndStake(alice, 600);
        _pushSpotUp(PUSH_UP_USDC);
        assertGt(_deviationTicks(), uint256(profile.maxDevTicks), "precondition: the guard must be tripped");

        // Trade at the new price for longer than the window so the mean moves to it.
        for (uint256 i = 0; i < 12; ++i) {
            _advance(60);
            uint256 out = _swap(whale, profile.usdc, profile.asset, 10e6, 0);
            _swap(whale, profile.asset, profile.usdc, out, 0);
        }

        assertLe(
            _deviationTicks(),
            uint256(profile.maxDevTicks),
            "after a full window at the new price the guard must reopen"
        );

        SwapParams memory swap =
            SwapParams({zeroForOne: false, amountIn: 1_000e6, amountOutMin: 0, amount0Min: 0, amount1Min: 0});
        vm.prank(alice);
        uint256 newTokenId = vault.rebalance(tokenId, MIN_TICK_ALIGNED, MAX_TICK_ALIGNED, swap, FAR_DEADLINE);
        assertEq(vault.stakerOf(newTokenId), alice, "a re-converged market must let the swap leg through again");
    }

    /// @dev Exits are unconditional, including while the guard is tripped. This is the
    ///      property the vault header claims, measured against a manipulated market.
    function test_Guard_ExitsStayOpenWhileTheGuardIsTripped() public {
        uint256 tokenId = _mintAndStake(alice, 600);
        uint256 bobToken = _mintAndStake(bob, 600);
        _pushSpotUp(PUSH_UP_USDC);
        assertGt(_deviationTicks(), uint256(profile.maxDevTicks), "precondition: the guard must be tripped");

        vm.prank(alice);
        vault.unstake(tokenId);
        assertEq(npm.ownerOf(tokenId), alice, "unstake must ignore the guard");

        // Spot now sits above bob's old range, so the withdrawn position is pure token1. A
        // swap-free rebalance therefore has to target a range token1 alone can fill — one
        // entirely below spot. See
        // {SwapSlippageMEVTest-test_Rebalance_SingleSidedWithdrawalCannotFillATwoSidedRange}
        // for what happens when it does not.
        int24 tick = _currentTick();
        vm.prank(bob);
        uint256 rebalanced =
            vault.rebalance(bobToken, _alignDown(tick) - 6000, _alignDown(tick) - 60, _noSwap(), FAR_DEADLINE);
        assertEq(vault.stakerOf(rebalanced), bob, "a swap-free rebalance must ignore the guard");
    }

    // ──────────────────────── Owner-side parameters ────────────

    /**
     * @dev SEC-03, FIXED 2026-08-26 and inverted here. `_setTwapParams` used to bound the
     *      window only from below, so one owner transaction could set a lookback no oracle
     *      can serve. `MAX_TWAP_WINDOW` closes it: the window is now bounded on both sides
     *      and an oversize value is refused with the three numbers that explain why.
     */
    function test_TwapWindow_HasAnUpperBound() public {
        uint32 before_ = vault.twapWindow();

        vm.startPrank(multisig);
        vm.expectRevert(
            abi.encodeWithSelector(
                TwapGuard.InvalidTwapWindow.selector, MAX_TWAP_WINDOW + 1, MIN_TWAP_WINDOW, MAX_TWAP_WINDOW
            )
        );
        vault.setTwapParams(MAX_TWAP_WINDOW + 1, 500);

        vm.expectRevert(
            abi.encodeWithSelector(
                TwapGuard.InvalidTwapWindow.selector, type(uint32).max, MIN_TWAP_WINDOW, MAX_TWAP_WINDOW
            )
        );
        vault.setTwapParams(type(uint32).max, 500);
        vm.stopPrank();

        assertEq(vault.twapWindow(), before_, "a refused window must leave the stored one untouched");

        // and the boundary itself is accepted, so the bound is exactly where it claims to be
        vm.prank(multisig);
        vault.setTwapParams(MAX_TWAP_WINDOW, 500);
        assertEq(vault.twapWindow(), MAX_TWAP_WINDOW, "the maximum window itself must be accepted");
    }

    /// @dev SEC-03's consequence, now unreachable: the owner cannot brick either swap leg
    ///      with an unservable window, because no such window can be stored any more.
    function test_Owner_CannotBrickTheSwapLegsWithAnOversizeWindow() public {
        uint256 tokenId = _mintAndStake(alice, 600);

        // 1e9 seconds (~31 years) of lookback: the value the old, unbounded setter accepted.
        vm.startPrank(multisig);
        vm.expectRevert(
            abi.encodeWithSelector(
                TwapGuard.InvalidTwapWindow.selector, uint32(1_000_000_000), MIN_TWAP_WINDOW, MAX_TWAP_WINDOW
            )
        );
        vault.setTwapParams(1_000_000_000, 500);
        vm.expectRevert(
            abi.encodeWithSelector(
                TwapGuard.InvalidTwapWindow.selector, uint32(1_000_000_000), MIN_TWAP_WINDOW, MAX_TWAP_WINDOW
            )
        );
        zapper.setTwapParams(1_000_000_000, 500);
        vm.stopPrank();

        // Both legs still work at the parameters the deploy left behind.
        SwapParams memory swap =
            SwapParams({zeroForOne: false, amountIn: 1_000e6, amountOutMin: 0, amount0Min: 0, amount1Min: 0});

        vm.prank(alice);
        uint256 newTokenId = vault.rebalance(tokenId, MIN_TICK_ALIGNED, MAX_TICK_ALIGNED, swap, FAR_DEADLINE);
        assertEq(vault.stakerOf(newTokenId), alice, "the rebalance swap leg must still work");

        // Half the USDC is swapped so the mint gets both sides; a full-size swap would
        // leave the zapper with nothing to pair the ASSET against.
        SwapParams memory zapSwap =
            SwapParams({zeroForOne: false, amountIn: 500e6, amountOutMin: 0, amount0Min: 0, amount1Min: 0});
        vm.startPrank(bob);
        usdcToken.approve(address(zapper), 1_000e6);
        uint256 zapped = zapper.zapIn(1_000e6, MIN_TICK_ALIGNED, MAX_TICK_ALIGNED, zapSwap, FAR_DEADLINE);
        vm.stopPrank();
        assertEq(vault.stakerOf(zapped), bob, "and so must the zap leg");
    }

    function test_Guard_RejectsAWindowBelowTheMinimum() public {
        vm.prank(multisig);
        vm.expectRevert(
            abi.encodeWithSelector(
                TwapGuard.InvalidTwapWindow.selector, MIN_TWAP_WINDOW - 1, MIN_TWAP_WINDOW, MAX_TWAP_WINDOW
            )
        );
        vault.setTwapParams(MIN_TWAP_WINDOW - 1, 500);
    }

    function test_Guard_RejectsAZeroAndAnOversizeDeviation() public {
        vm.startPrank(multisig);
        vm.expectRevert(
            abi.encodeWithSelector(TwapGuard.InvalidTwapDeviation.selector, uint24(0), MAX_TWAP_DEVIATION_TICKS)
        );
        vault.setTwapParams(MIN_TWAP_WINDOW, 0);

        vm.expectRevert(
            abi.encodeWithSelector(
                TwapGuard.InvalidTwapDeviation.selector, MAX_TWAP_DEVIATION_TICKS + 1, MAX_TWAP_DEVIATION_TICKS
            )
        );
        vault.setTwapParams(MIN_TWAP_WINDOW, MAX_TWAP_DEVIATION_TICKS + 1);
        vm.stopPrank();
    }

    /// @dev The two guards are independent parameters on independent contracts; retuning one
    ///      must not move the other.
    function test_Guard_VaultAndZapperTuneIndependently() public {
        vm.prank(multisig);
        vault.setTwapParams(600, 250);

        assertEq(vault.twapWindow(), 600, "the vault takes the new window");
        assertEq(vault.maxTwapDeviationTicks(), 250, "the vault takes the new ceiling");
        assertEq(zapper.twapWindow(), profile.twapWindow, "the zapper's window is untouched");
        assertEq(zapper.maxTwapDeviationTicks(), profile.maxDevTicks, "the zapper's ceiling is untouched");
    }

    function test_Guard_OnlyTheOwnerCanRetuneIt() public {
        vm.prank(alice);
        vm.expectRevert();
        vault.setTwapParams(600, 250);

        vm.prank(alice);
        vm.expectRevert();
        zapper.setTwapParams(600, 250);
    }
}
