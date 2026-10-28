// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkHarness} from "../utils/ForkHarness.sol";
import {TwapGuard, SwapParams} from "../../../contracts/lp-staking/libraries/TwapGuard.sol";
import {LPStakingVault} from "../../../contracts/lp-staking/LPStakingVault.sol";
import {LPZapper} from "../../../contracts/lp-staking/LPZapper.sol";
import {OracleHistory} from "../../../contracts/lp-staking/libraries/OracleHistory.sol";
import {LPProxy} from "../../../contracts/lp-staking/deploy/LPProxy.sol";

/**
 * @notice Why this file exists: the spot-vs-TWAP guard is the only on-chain manipulation
 *         circuit breaker in the stack, and everything about it — whether it can be read at
 *         all, where it trips, what it does not cover, and what an owner can do to it — is a
 *         property of the REAL pool oracle, not of a mock that returns a chosen tick.
 *
 *  Two contracts, because the oracle's state is the subject:
 *    * {TwapColdOracleTest} runs on a freshly made market whose pool still stores ONE
 *      observation. SEC-01 lived there: a vault born on such a pool reverted a bare `OLD` on
 *      every guarded path. Since audit L-04 the vault cannot be born there at all
 *      ({OracleHistory}): this contract asserts that refusal against the real pool, and the
 *      real `OLD` behind it.
 *    * {TwapManipulationTest} runs on a warmed oracle and pushes real money through the real
 *      router to move spot away from the TWAP.
 */
contract TwapColdOracleTest is ForkHarness {
    uint32 internal constant WINDOW = 300;

    /// @dev Deliberately the COLD rung: a market and funded actors, no growth, no history, no stack.
    function setUp() public {
        _forkMarket();
    }

    /// @dev A vault proxy on the real pool, the implementation deployed first so the expected
    ///      revert binds to the proxy's construction, which runs `initialize`.
    function _expectVaultRefused(bytes memory reason) internal {
        LPStakingVault impl = new LPStakingVault(profile.npm, address(poolRef), token0, token1, FEE, profile.router);
        bytes memory init =
            abi.encodeCall(LPStakingVault.initialize, (address(this), multisig, multisig, address(0), WINDOW, 953));
        vm.expectRevert(reason);
        new LPProxy(address(impl), init);
    }

    /**
     * @dev SEC-01, closed by audit L-04: a freshly created pool stores exactly one observation,
     *      and `initialize` refuses it — the CURRENT cardinality 1 is below ceil(300 / 6) + 1.
     */
    function test_L04_AColdPoolRefusesTheVaultAtInitialize() public {
        (,,, uint16 cardinality,,,) = poolRef.slot0();
        assertEq(cardinality, 1, "a freshly created pool stores exactly one observation");
        _expectVaultRefused(abi.encodeWithSelector(OracleHistory.CardinalityTooLow.selector, uint16(1), uint256(51)));
    }

    /// @dev Growing `observationCardinalityNext` alone does not count: the grown slots are used
    ///      only after the pool's index wraps, so the CURRENT cardinality is what is read.
    function test_L04_GrowingNextAloneDoesNotSatisfyTheCheck() public {
        poolRef.increaseObservationCardinalityNext(OBSERVATION_CARDINALITY);
        (,,, uint16 cardinality, uint16 cardinalityNext,,) = poolRef.slot0();
        assertEq(cardinalityNext, OBSERVATION_CARDINALITY, "next is grown");
        assertEq(cardinality, 1, "current is not, until the next write");
        _expectVaultRefused(abi.encodeWithSelector(OracleHistory.CardinalityTooLow.selector, uint16(1), uint256(51)));
    }

    /**
     * @dev The real `OLD`: the pool is grown and written once, so its current cardinality is
     *      the grown one, but its history is only a minute old. `observe([300, 0])` reverts
     *      `OLD` on the real pool, and `initialize` turns that into {OracleHistory-HistoryTooShort}.
     */
    function test_L04_AGrownPoolWithShortHistoryRevertsHistoryTooShort() public {
        poolRef.increaseObservationCardinalityNext(OBSERVATION_CARDINALITY);
        _forceObservationWrite();
        (,,, uint16 cardinality,,,) = poolRef.slot0();
        assertEq(cardinality, OBSERVATION_CARDINALITY, "the first write after the growth switched the size");

        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = WINDOW;
        vm.expectRevert(bytes("OLD"));
        poolRef.observe(secondsAgos);

        _expectVaultRefused(abi.encodeWithSelector(OracleHistory.HistoryTooShort.selector, WINDOW));
    }

    /// @dev And the operational fix really is sufficient: grow the array, trade past the
    ///      window, and the stack is born with a guard that reads.
    function test_L04_AGrownAndWarmedPoolAcceptsTheStack() public {
        _warmPoolOracle();
        _deployStack();

        (,,, uint16 cardinality,,,) = poolRef.slot0();
        assertEq(cardinality, OBSERVATION_CARDINALITY, "warm-up must have switched the stored observation count");
        (,,, bool withinBounds) = vault.previewTwap();
        assertTrue(withinBounds, "a warmed oracle must give the guard a readable, passing answer");
        (,,, bool zapperWithin) = zapper.previewTwap();
        assertTrue(zapperWithin, "and the zapper's too");
    }

    /// @dev On a live stack the setter applies the same rule against the real pool: 150 slots
    ///      serve 300 s, not 1800 s (301 needed) and not 3600 s (601 needed).
    function test_L04_SetTwapParamsRefusesAWindowTheRealPoolCannotServe() public {
        _warmPoolOracle();
        _deployStack();

        vm.startPrank(multisig);
        vm.expectRevert(
            abi.encodeWithSelector(OracleHistory.CardinalityTooLow.selector, OBSERVATION_CARDINALITY, uint256(301))
        );
        vault.setTwapParams(1800, 953);
        vm.expectRevert(
            abi.encodeWithSelector(OracleHistory.CardinalityTooLow.selector, OBSERVATION_CARDINALITY, uint256(601))
        );
        zapper.setTwapParams(3600, 953);
        vault.setTwapParams(WINDOW, 953);
        vm.stopPrank();
        assertEq(vault.twapWindow(), WINDOW, "a window the pool serves is accepted");
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

        // and the boundary itself passes the bounds, so the bound is exactly where it claims to
        // be: what refuses it on this pool is the history check that follows (audit L-04),
        // since 150 slots cannot serve 3600 s (601 needed). The unit tier accepts it on a mock
        // pool that can.
        vm.prank(multisig);
        vm.expectRevert(
            abi.encodeWithSelector(OracleHistory.CardinalityTooLow.selector, OBSERVATION_CARDINALITY, uint256(601))
        );
        vault.setTwapParams(MAX_TWAP_WINDOW, 500);
        assertEq(vault.twapWindow(), before_, "a window the pool cannot serve must leave the stored one untouched");
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

    /// @dev Both guards are retuned by the OPERATOR multisig (immediate lever), on the vault and
    ///      on the zapper proxy alike; anyone else is turned away with the operator-tier error.
    function test_Guard_OnlyTheOperatorCanRetuneIt() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.NotOperator.selector, alice, multisig));
        vault.setTwapParams(600, 250);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LPZapper.NotOperator.selector, alice, multisig));
        zapper.setTwapParams(600, 250);
    }
}
