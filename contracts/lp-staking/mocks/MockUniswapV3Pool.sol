// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.38;

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
 *  The history is settable too (audit L-04): `slot0()` reports {observationCardinality}
 *  (65,535 unless a test lowers it, so a pool serves every window by default), and `observe`
 *  reverts `OLD`, as the real pool does, for any `secondsAgo` beyond {historySeconds}
 *  (unlimited by default). {OracleHistory} reads both when a window is set.
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
    /// @notice The CURRENT observation count `slot0()` reports (field 4). Settable; it does not
    ///         follow {observationCardinalityNext}, exactly like a real pool before its wrap.
    uint16 public observationCardinality = type(uint16).max;
    /// @notice The oldest `secondsAgo` `observe` can serve; beyond it `observe` reverts `OLD`.
    uint32 public historySeconds = type(uint32).max;
    /// @notice The tick the pool sat at during the last {recentSeconds} (zero seconds: never).
    ///         Before that it sat at {twapTick}, so two windows can see two different means.
    int24 public recentTick;
    /// @notice How long the pool has sat at {recentTick}, in seconds.
    uint32 public recentSeconds;
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

    /// @notice Sets the CURRENT observation count `slot0()` reports.
    function setObservationCardinality(uint16 cardinality_) external {
        observationCardinality = cardinality_;
    }

    /// @notice Sets how far back `observe` can see; older `secondsAgo` values revert `OLD`.
    function setHistorySeconds(uint32 historySeconds_) external {
        historySeconds = historySeconds_;
    }

    /**
     * @notice A price HELD for the last `seconds_`: the pool sat at `tick_` for that long and at
     *         {twapTick} before. The mean over a window `w` is then
     *         `(tick_ * min(w, seconds_) + twapTick * max(0, w - seconds_)) / w`, so a short
     *         window and a long one see different means (audit L-02). Zero seconds switches it off.
     */
    function setRecentTick(int24 tick_, uint32 seconds_) external {
        recentTick = tick_;
        recentSeconds = seconds_;
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

    /// @notice The factory's spacing for the fee tier, as `UniswapV3Factory.feeAmountTickSpacing`
    ///         enables it (100 -> 1, 500 -> 10, 3000 -> 60, 10000 -> 200). Read by the ApeBond
    ///         adapter, which validates every campaign range against it.
    function tickSpacing() external view returns (int24) {
        if (_fee == 100) return 1;
        if (_fee == 500) return 10;
        if (_fee == 10000) return 200;
        return 60;
    }

    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96_,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality_,
            uint16 observationCardinalityNext_,
            uint8 feeProtocol,
            bool unlocked
        )
    {
        return (sqrtPriceX96, currentTick, 0, observationCardinality, observationCardinalityNext, 0, true);
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        if (observeReverts) revert("OLD");
        for (uint256 i = 0; i < secondsAgos.length; i++) {
            if (secondsAgos[i] > historySeconds) revert("OLD");
        }

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
            // The tick integral over the last `age` seconds: {recentTick} for the most recent
            // {recentSeconds} of them, {twapTick} for the rest. With no recent period this is
            // the plain series `twapTick * (ANCHOR - age)`.
            int56 recent = int56(uint56(recentSeconds));
            int56 recentPart = age < recent ? age : recent;
            int56 integral = int56(recentTick) * recentPart + int56(twapTick) * (age - recentPart);
            tickCumulatives[i] = int56(twapTick) * ANCHOR - integral;
            secondsPerLiquidityCumulativeX128s[i] = uint160(uint56(ANCHOR - age));
        }
    }

    function increaseObservationCardinalityNext(uint16 observationCardinalityNext_) external {
        if (observationCardinalityNext_ > observationCardinalityNext) {
            observationCardinalityNext = observationCardinalityNext_;
        }
    }
}
