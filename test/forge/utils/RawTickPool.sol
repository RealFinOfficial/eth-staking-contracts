// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title RawTickPool
 * @notice A pool mock whose `observe` returns **raw** `tickCumulatives` chosen by the test.
 *
 *  `contracts/lp-staking/mocks/MockUniswapV3Pool.sol` derives its cumulatives from a target
 *  TWAP tick (`tickCumulative[i] = twapTick * (ANCHOR - age)`), which can only ever produce
 *  a delta that divides the window exactly. That makes two branches of
 *  `TwapGuard._twapAndSpotTicks` unreachable from it:
 *
 *    * the floor correction `if (tickDelta < 0 && tickDelta % windowSigned != 0) twapTick--`,
 *      which needs a NEGATIVE delta with a non-zero remainder, and
 *    * the int56 -> int24 truncation at the edges of the tick range.
 *
 *  `contracts/**` is frozen for this tier, so the knob lives here instead. Setting the
 *  cumulatives directly is also the honest way to state the property under test: the guard
 *  must floor, whatever the oracle hands it.
 */
contract RawTickPool {
    address private _token0;
    address private _token1;
    uint24 private _fee;

    /// @notice Returned verbatim by {observe}, index-for-index with `secondsAgos`.
    int56[] private _cumulatives;
    uint160[] private _secondsPerLiquidity;

    int24 public currentTick;
    uint160 public sqrtPriceX96 = 79228162514264337593543950336; // 1:1
    uint16 public observationCardinality = 2;
    uint16 public observationCardinalityNext = 2;

    /// @notice When set, {observe} reverts with this exact string. `OLD` is Uniswap's own.
    string public observeRevertReason;
    bool public observeReverts;

    constructor(address token0_, address token1_, uint24 fee_) {
        _token0 = token0_;
        _token1 = token1_;
        _fee = fee_;
    }

    // ──────────────────────── Test setters ─────────────────────

    /// @param cumulatives Raw values, one per entry the guard asks for. The guard always
    ///                    asks for exactly two: `[window, 0]`.
    function setTickCumulatives(int56[] calldata cumulatives) external {
        delete _cumulatives;
        delete _secondsPerLiquidity;
        for (uint256 i = 0; i < cumulatives.length; ++i) {
            _cumulatives.push(cumulatives[i]);
            _secondsPerLiquidity.push(uint160(i + 1));
        }
    }

    function setCurrentTick(int24 tick) external {
        currentTick = tick;
    }

    function setObserveReverts(bool value, string calldata reason) external {
        observeReverts = value;
        observeRevertReason = reason;
    }

    function setTokens(address token0_, address token1_) external {
        _token0 = token0_;
        _token1 = token1_;
    }

    function setFee(uint24 fee_) external {
        _fee = fee_;
    }

    function setObservationCardinality(uint16 cardinality) external {
        observationCardinality = cardinality;
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

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (sqrtPriceX96, currentTick, 0, observationCardinality, observationCardinalityNext, 0, true);
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        if (observeReverts) revert(observeRevertReason);
        require(_cumulatives.length >= secondsAgos.length, "RawTickPool: cumulatives not set");
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);
        for (uint256 i = 0; i < secondsAgos.length; ++i) {
            tickCumulatives[i] = _cumulatives[i];
            secondsPerLiquidityCumulativeX128s[i] = _secondsPerLiquidity[i];
        }
    }

    function increaseObservationCardinalityNext(uint16 next) external {
        if (next > observationCardinalityNext) observationCardinalityNext = next;
    }
}
