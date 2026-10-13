// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MockUniswapV3Pool
 * @notice Test-only stand-in for a Uniswap V3 pool: the immutable triple the vault and the
 *         zapper validate at deploy time, plus a fully settable oracle.
 *
 *  The oracle is synthetic. `observe` returns a tick-cumulative series built from a single
 *  settable `twapTick` so that the arithmetic-mean tick over any window is exactly that
 *  value:
 *
 *      tickCumulative(secondsAgo) = twapTick * (ANCHOR - secondsAgo)
 *      => tickCumulatives[1] - tickCumulatives[0] = twapTick * window
 *
 *  `slot0().tick` is settable independently, so a test can put spot at any distance from
 *  the TWAP and drive {TwapGuard} to either side of its bound.
 *
 *  That synthetic series always divides the window exactly, so it can never hand the guard
 *  a remainder. {setTickCumulatives} is the escape hatch: it switches `observe` into a raw
 *  mode that returns two caller-chosen cumulatives verbatim, which is the only way to reach
 *  the floor correction in {TwapGuard-_twapAndSpotTicks}.
 */
contract MockUniswapV3Pool {
    // ──────────────────────── State ────────────────────────────

    address private _token0;
    address private _token1;
    uint24 private _fee;

    /// @notice Spot tick returned by `slot0`.
    int24 public currentTick;
    /// @notice Mean tick the `observe` series encodes.
    int24 public twapTick;
    /// @notice Spot price returned by `slot0`, defaulted to 1:1.
    uint160 public sqrtPriceX96 = 79228162514264337593543950336;
    /// @notice Last value passed to `increaseObservationCardinalityNext`.
    uint16 public observationCardinalityNext = 1;
    /// @notice When true, `observe` reverts the way an under-provisioned pool does.
    bool public observeReverts;
    /// @notice When true, `observe` returns {rawTickCumulatives} verbatim instead of the
    ///         series derived from `twapTick`.
    bool public useRawCumulatives;
    /// @notice The two cumulatives raw mode hands back: index 0 answers `secondsAgos[0]`,
    ///         index 1 answers `secondsAgos[1]`.
    int56[2] public rawTickCumulatives;

    /// @dev Arbitrary anchor keeping the synthetic cumulative series away from zero.
    int56 private constant ANCHOR = 1_000_000;

    // ──────────────────────── Constructor ──────────────────────

    constructor(address token0_, address token1_, uint24 fee_) {
        _token0 = token0_;
        _token1 = token1_;
        _fee = fee_;
    }

    // ──────────────────────── Test setters ─────────────────────

    function setTokens(address token0_, address token1_) external {
        _token0 = token0_;
        _token1 = token1_;
    }

    function setFee(uint24 fee_) external {
        _fee = fee_;
    }

    /// @notice Sets the spot tick only.
    function setCurrentTick(int24 tick_) external {
        currentTick = tick_;
    }

    /// @notice Sets the mean tick the `observe` series encodes.
    function setTwapTick(int24 tick_) external {
        twapTick = tick_;
    }

    /// @notice Sets both ticks in one call: spot first, mean second.
    function setTicks(int24 spot_, int24 mean_) external {
        currentTick = spot_;
        twapTick = mean_;
    }

    function setSqrtPriceX96(uint160 sqrtPriceX96_) external {
        sqrtPriceX96 = sqrtPriceX96_;
    }

    function setObserveReverts(bool value) external {
        observeReverts = value;
    }

    /**
     * @notice Pins the two tick cumulatives `observe` returns, and switches the oracle into
     *         raw mode in the same call.
     * @dev Setting the values IS the mode switch — a test that wants specific cumulatives
     *      always wants them served. Use {setUseRawCumulatives} to go back to the series
     *      derived from `twapTick` without discarding them.
     *
     *      Raw mode exists for one branch: {TwapGuard} floors its mean tick toward negative
     *      infinity, and the correction only runs when `tickCumulatives[1] - tickCumulatives[0]`
     *      leaves a remainder over the window. The derived series never leaves one.
     * @param cumulatives [0] is returned for `secondsAgos[0]`, [1] for `secondsAgos[1]`.
     */
    function setTickCumulatives(int56[2] calldata cumulatives) external {
        rawTickCumulatives = cumulatives;
        useRawCumulatives = true;
    }

    /// @notice Switches raw mode on or off without changing the pinned cumulatives.
    function setUseRawCumulatives(bool value) external {
        useRawCumulatives = value;
    }

    // ──────────────────────── Pool surface ─────────────────────

    function token0() external view returns (address) {
        return _token0;
    }

    function token1() external view returns (address) {
        return _token1;
    }

    function fee() external view returns (uint24) {
        return _fee;
    }

    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96_,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext_,
            uint8 feeProtocol,
            bool unlocked
        )
    {
        return (sqrtPriceX96, currentTick, 0, 2, observationCardinalityNext, 0, true);
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        if (observeReverts) revert("OLD");

        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);

        if (useRawCumulatives) {
            require(secondsAgos.length == 2, "raw mode serves 2 observations");
            tickCumulatives[0] = rawTickCumulatives[0];
            tickCumulatives[1] = rawTickCumulatives[1];
            secondsPerLiquidityCumulativeX128s[0] = uint160(uint56(ANCHOR));
            secondsPerLiquidityCumulativeX128s[1] = uint160(uint56(ANCHOR));
            return (tickCumulatives, secondsPerLiquidityCumulativeX128s);
        }

        for (uint256 i = 0; i < secondsAgos.length; i++) {
            int56 age = int56(uint56(secondsAgos[i]));
            tickCumulatives[i] = int56(twapTick) * (ANCHOR - age);
            secondsPerLiquidityCumulativeX128s[i] = uint160(uint56(ANCHOR - age));
        }
    }

    function increaseObservationCardinalityNext(uint16 observationCardinalityNext_) external {
        if (observationCardinalityNext_ > observationCardinalityNext) {
            observationCardinalityNext = observationCardinalityNext_;
        }
    }
}
