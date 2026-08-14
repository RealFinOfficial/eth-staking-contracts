// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IUniswapV3Pool.sol";

// ──────────────────────── Shared types ─────────────────────────

/**
 * @notice Caller-supplied swap leg for a rebalance or a zap.
 * @dev Declared at file level here — and not inside either contract — because
 *      `LPStakingVault` and `LPZapper` must speak the exact same calldata shape and both
 *      already depend on this file for {TwapGuard}. Keeping the type next to the guard
 *      avoids a periphery -> core type dependency.
 *
 *      The frontend computes the split; the contracts only enforce TWAP sanity plus the
 *      caller's own minimums. `amountIn == 0` skips the swap step entirely.
 * @param zeroForOne  Swap direction: true swaps token0 -> token1, false token1 -> token0.
 * @param amountIn    Exact input amount for the swap leg. Zero means "no swap".
 * @param amountOutMin Minimum acceptable swap output (caller slippage bound on the swap).
 * @param amount0Min  Minimum token0 the mint must consume (caller slippage bound on the mint).
 * @param amount1Min  Minimum token1 the mint must consume (caller slippage bound on the mint).
 */
struct SwapParams {
    bool zeroForOne;
    uint256 amountIn;
    uint256 amountOutMin;
    uint256 amount0Min;
    uint256 amount1Min;
}

/**
 * @title TwapGuard
 * @notice Shared spot-vs-TWAP deviation check for the LP staking stack.
 *
 *  Implemented as an abstract contract rather than a `library` on purpose: the guard owns
 *  mutable, owner-tunable parameters plus their change event, and a stateless library
 *  cannot hold those. Inheriting contracts get the immutable pool reference, the
 *  parameters, the event and the errors in one piece, and only have to expose their own
 *  `onlyOwner` setter (the guard deliberately knows nothing about access control).
 *
 *  Mechanics:
 *    - Arithmetic-mean tick over `twapWindow` from `pool.observe([window, 0])`.
 *    - Spot tick from `pool.slot0()`.
 *    - Revert when the absolute difference exceeds `maxTwapDeviationBps` ticks.
 *
 *  Bps-to-ticks approximation: one tick is a 1.0001x price step, i.e. +1.00 bps per tick.
 *  Deviations compound (`1.0001^n`), so `n` ticks is slightly more than `n` bps — at the
 *  2000 bps ceiling the true bound is ~2214 bps rather than 2000. The guard is a
 *  manipulation circuit breaker, not a pricing oracle, and the error is conservative in
 *  the direction that matters (the bound is never tighter than requested), so ticks are
 *  used as a 1:1 stand-in for bps. Callers still carry their own `amountOutMin` /
 *  `amount0Min` / `amount1Min` for exact slippage control.
 */
abstract contract TwapGuard {
    // ──────────────────────── Constants ────────────────────────

    /// @notice Shortest permitted TWAP window, in seconds.
    uint32 public constant MIN_TWAP_WINDOW = 300;
    /// @notice Widest permitted deviation, in basis points.
    uint24 public constant MAX_TWAP_DEVIATION_BPS = 2000;

    // ──────────────────────── State ────────────────────────────

    /// @notice Uniswap V3 pool this contract reads its oracle from.
    IUniswapV3Pool public immutable pool;

    /// @notice TWAP lookback window in seconds.
    uint32 public twapWindow;
    /// @notice Maximum tolerated spot-vs-TWAP deviation, in basis points.
    uint24 public maxTwapDeviationBps;

    // ──────────────────────── Events ───────────────────────────

    /// @notice Emitted on deploy and on every parameter change, with the full new state.
    event TwapParamsSet(uint32 window, uint24 maxDeviationBps);

    // ──────────────────────── Errors ───────────────────────────

    error InvalidPool();
    error InvalidTwapWindow(uint32 window, uint32 minWindow);
    error InvalidTwapDeviation(uint24 maxDeviationBps, uint24 maxAllowedBps);
    error TwapDeviationTooHigh(int24 currentTick, int24 twapTick, int24 maxDeviationTicks);

    // ──────────────────────── Constructor ──────────────────────

    /**
     * @param _pool Uniswap V3 pool used as the price oracle.
     * @param _twapWindow Initial TWAP window in seconds (>= MIN_TWAP_WINDOW).
     * @param _maxTwapDeviationBps Initial deviation ceiling in bps (0 < x <= MAX_TWAP_DEVIATION_BPS).
     */
    constructor(address _pool, uint32 _twapWindow, uint24 _maxTwapDeviationBps) {
        if (_pool == address(0)) revert InvalidPool();
        pool = IUniswapV3Pool(_pool);
        _setTwapParams(_twapWindow, _maxTwapDeviationBps);
    }

    // ──────────────────────── Internal helpers ─────────────────

    /// @dev Bounds-checks and stores the TWAP parameters. Access control is the
    ///      inheriting contract's responsibility.
    function _setTwapParams(uint32 _window, uint24 _maxDeviationBps) internal {
        if (_window < MIN_TWAP_WINDOW) revert InvalidTwapWindow(_window, MIN_TWAP_WINDOW);
        if (_maxDeviationBps == 0 || _maxDeviationBps > MAX_TWAP_DEVIATION_BPS) {
            revert InvalidTwapDeviation(_maxDeviationBps, MAX_TWAP_DEVIATION_BPS);
        }
        twapWindow = _window;
        maxTwapDeviationBps = _maxDeviationBps;
        emit TwapParamsSet(_window, _maxDeviationBps);
    }

    /// @dev Arithmetic-mean tick over `twapWindow`, rounded toward negative infinity
    ///      (matching Uniswap's own OracleLibrary), plus the current spot tick.
    function _twapAndSpotTicks() internal view returns (int24 twapTick, int24 currentTick) {
        uint32 window = twapWindow;

        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = window;
        secondsAgos[1] = 0;

        (int56[] memory tickCumulatives, ) = pool.observe(secondsAgos);

        int56 tickDelta = tickCumulatives[1] - tickCumulatives[0];
        int56 windowSigned = int56(uint56(window));

        twapTick = int24(tickDelta / windowSigned);
        // Solidity truncates toward zero; the oracle convention floors.
        if (tickDelta < 0 && tickDelta % windowSigned != 0) {
            twapTick--;
        }

        (, currentTick, , , , , ) = pool.slot0();
    }

    /// @dev Reverts when spot has drifted further from the TWAP than the configured
    ///      ceiling allows. Called before every swap executed by this stack.
    function _checkTwapDeviation() internal view {
        (int24 twapTick, int24 currentTick) = _twapAndSpotTicks();

        // Safe: maxTwapDeviationBps is bounded by MAX_TWAP_DEVIATION_BPS (2000) << 2**23.
        int24 maxDeviationTicks = int24(maxTwapDeviationBps);

        int24 deviation = currentTick - twapTick;
        if (deviation < 0) deviation = -deviation;

        if (deviation > maxDeviationTicks) {
            revert TwapDeviationTooHigh(currentTick, twapTick, maxDeviationTicks);
        }
    }

    // ──────────────────────── View functions ───────────────────

    /**
     * @notice Reads the guard inputs without reverting, so a frontend can pre-check a
     *         transaction instead of discovering the revert on submission.
     * @return currentTick Spot tick from `slot0`.
     * @return twapTick Arithmetic-mean tick over `twapWindow`.
     * @return maxDeviationTicks Configured ceiling, expressed in ticks.
     * @return withinBounds True when a swap would pass the guard right now.
     */
    function previewTwap()
        external
        view
        returns (int24 currentTick, int24 twapTick, int24 maxDeviationTicks, bool withinBounds)
    {
        (twapTick, currentTick) = _twapAndSpotTicks();
        maxDeviationTicks = int24(maxTwapDeviationBps);

        int24 deviation = currentTick - twapTick;
        if (deviation < 0) deviation = -deviation;
        withinBounds = deviation <= maxDeviationTicks;
    }
}
