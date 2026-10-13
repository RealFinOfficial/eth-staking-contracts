// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IUniswapV3Pool
 * @notice Minimal vendored interface for a Uniswap V3 pool — only the members the
 *         TWAP guard and the deploy scripts need.
 *
 *  Vendored because the npm package uniswap/v3-core is pinned to `pragma 0.7.6`.
 */
interface IUniswapV3Pool {
    // ──────────────────────── Oracle ────────────────────────────

    /// @notice Current pool state, packed in slot 0.
    /// @return sqrtPriceX96 Current price as a Q64.96 sqrt ratio.
    /// @return tick Current tick (spot; manipulable within a single block).
    /// @return observationIndex Index of the most recent oracle observation.
    /// @return observationCardinality Number of observations currently stored.
    /// @return observationCardinalityNext Number of observations the pool is growing into.
    /// @return feeProtocol Protocol fee for both tokens, packed.
    /// @return unlocked Whether the pool is currently unlocked for reentrancy.
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );

    /// @notice Returns cumulative values as of each `secondsAgos` timestamp.
    /// @dev Reverts with `OLD` when the requested window exceeds the stored observations —
    ///      run `increaseObservationCardinalityNext` on the pool before relying on it.
    /// @param secondsAgos Seconds before the current block to look back, ascending age.
    /// @return tickCumulatives Cumulative tick values as of each queried timestamp.
    /// @return secondsPerLiquidityCumulativeX128s Cumulative seconds per in-range liquidity.
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);

    /// @notice Grows the oracle observation array so longer TWAP windows become readable.
    /// @param observationCardinalityNext Target observation count.
    function increaseObservationCardinalityNext(uint16 observationCardinalityNext) external;

    // ──────────────────────── Immutables ────────────────────────

    /// @notice First token of the pool, sorted ascending by address.
    /// @return The token0 address.
    function token0() external view returns (address);

    /// @notice Second token of the pool.
    /// @return The token1 address.
    function token1() external view returns (address);

    /// @notice Pool fee tier in hundredths of a bip (3000 = 0.30%).
    /// @return The fee tier.
    function fee() external view returns (uint24);
}
