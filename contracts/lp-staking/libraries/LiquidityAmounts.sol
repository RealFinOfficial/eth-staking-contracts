// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.38;

import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";

// Vendored from Uniswap v3-periphery, branch `0.8`, `contracts/libraries/LiquidityAmounts.sol`
// (https://github.com/Uniswap/v3-periphery/blob/0.8/contracts/libraries/LiquidityAmounts.sol), and
// TRIMMED to `getAmountsForLiquidity` and the two helpers it calls, `getAmount0ForLiquidity` and
// `getAmount1ForLiquidity`. The liquidity-for-amounts direction and `toUint128` are left out
// because nothing here calls them. Two substitutions, both value-preserving:
//   - v3-core's `FullMath.mulDiv` is replaced by OpenZeppelin's `Math.mulDiv` (OpenZeppelin
//     5.6.1 is already a dependency). Both compute floor(a * b / denominator) with a 512-bit
//     intermediate and revert when the result does not fit in 256 bits or the denominator is
//     zero; only the revert data differs.
//   - `FixedPoint96.Q96` / `FixedPoint96.RESOLUTION` are written as the local constants below.
// The `pragma` is raised from `>=0.5.0` to `^0.8.20` because the OpenZeppelin import requires it.
// The original licence header is kept as upstream wrote it: this file is GPL-2.0-or-later
// inside an MIT repository, which is an open question for the owner (B.3 decision document, open
// item O6). Used through {PositionValue}.
//
// Added 2026-11-20 for the `StakingMigrator`'s matching amount of a transition delivery (spec 01
// §9.4.5): `getLiquidityForAmount0` and `getLiquidityForAmount1`, verbatim from the same upstream
// file apart from the `toUint128` cast (OpenZeppelin `SafeCast.toUint128`, which reverts on
// overflow instead of truncating), and two rounding-up amount functions, which upstream keeps in
// v3-core's `SqrtPriceMath.getAmount0Delta` / `getAmount1Delta` with `roundUp = true`: the amounts
// a pool charges a mint of `liquidity`.

/// @title Liquidity amount functions
/// @notice Provides functions for computing liquidity amounts from token amounts and prices
library LiquidityAmounts {
    /// @dev `FixedPoint96.RESOLUTION` and `FixedPoint96.Q96` of v3-core.
    uint8 internal constant RESOLUTION = 96;
    uint256 internal constant Q96 = 0x1000000000000000000000000;

    /// @notice Computes the amount of token0 for a given amount of liquidity and a price range
    /// @param sqrtRatioAX96 A sqrt price representing the first tick boundary
    /// @param sqrtRatioBX96 A sqrt price representing the second tick boundary
    /// @param liquidity The liquidity being valued
    /// @return amount0 The amount of token0
    function getAmount0ForLiquidity(
        uint160 sqrtRatioAX96,
        uint160 sqrtRatioBX96,
        uint128 liquidity
    ) internal pure returns (uint256 amount0) {
        unchecked {
            if (sqrtRatioAX96 > sqrtRatioBX96) (sqrtRatioAX96, sqrtRatioBX96) = (sqrtRatioBX96, sqrtRatioAX96);

            return
                Math.mulDiv(
                    uint256(liquidity) << RESOLUTION,
                    sqrtRatioBX96 - sqrtRatioAX96,
                    sqrtRatioBX96
                ) / sqrtRatioAX96;
        }
    }

    /// @notice Computes the amount of token1 for a given amount of liquidity and a price range
    /// @param sqrtRatioAX96 A sqrt price representing the first tick boundary
    /// @param sqrtRatioBX96 A sqrt price representing the second tick boundary
    /// @param liquidity The liquidity being valued
    /// @return amount1 The amount of token1
    function getAmount1ForLiquidity(
        uint160 sqrtRatioAX96,
        uint160 sqrtRatioBX96,
        uint128 liquidity
    ) internal pure returns (uint256 amount1) {
        if (sqrtRatioAX96 > sqrtRatioBX96) (sqrtRatioAX96, sqrtRatioBX96) = (sqrtRatioBX96, sqrtRatioAX96);

        unchecked {
            return Math.mulDiv(liquidity, sqrtRatioBX96 - sqrtRatioAX96, Q96);
        }
    }

    /// @notice Computes the token0 and token1 value for a given amount of liquidity, the current
    /// pool prices and the prices at the tick boundaries
    /// @param sqrtRatioX96 A sqrt price representing the current pool prices
    /// @param sqrtRatioAX96 A sqrt price representing the first tick boundary
    /// @param sqrtRatioBX96 A sqrt price representing the second tick boundary
    /// @param liquidity The liquidity being valued
    /// @return amount0 The amount of token0
    /// @return amount1 The amount of token1
    function getAmountsForLiquidity(
        uint160 sqrtRatioX96,
        uint160 sqrtRatioAX96,
        uint160 sqrtRatioBX96,
        uint128 liquidity
    ) internal pure returns (uint256 amount0, uint256 amount1) {
        if (sqrtRatioAX96 > sqrtRatioBX96) (sqrtRatioAX96, sqrtRatioBX96) = (sqrtRatioBX96, sqrtRatioAX96);

        if (sqrtRatioX96 <= sqrtRatioAX96) {
            amount0 = getAmount0ForLiquidity(sqrtRatioAX96, sqrtRatioBX96, liquidity);
        } else if (sqrtRatioX96 < sqrtRatioBX96) {
            amount0 = getAmount0ForLiquidity(sqrtRatioX96, sqrtRatioBX96, liquidity);
            amount1 = getAmount1ForLiquidity(sqrtRatioAX96, sqrtRatioX96, liquidity);
        } else {
            amount1 = getAmount1ForLiquidity(sqrtRatioAX96, sqrtRatioBX96, liquidity);
        }
    }

    /// @notice Computes the amount of liquidity received for a given amount of token0 and price range
    /// @dev Calculates amount0 * (sqrt(upper) * sqrt(lower)) / (sqrt(upper) - sqrt(lower))
    /// @param sqrtRatioAX96 A sqrt price representing the first tick boundary
    /// @param sqrtRatioBX96 A sqrt price representing the second tick boundary
    /// @param amount0 The amount0 being sent in
    /// @return liquidity The amount of returned liquidity
    function getLiquidityForAmount0(
        uint160 sqrtRatioAX96,
        uint160 sqrtRatioBX96,
        uint256 amount0
    ) internal pure returns (uint128 liquidity) {
        if (sqrtRatioAX96 > sqrtRatioBX96) (sqrtRatioAX96, sqrtRatioBX96) = (sqrtRatioBX96, sqrtRatioAX96);
        uint256 intermediate = Math.mulDiv(sqrtRatioAX96, sqrtRatioBX96, Q96);
        unchecked {
            return SafeCast.toUint128(Math.mulDiv(amount0, intermediate, sqrtRatioBX96 - sqrtRatioAX96));
        }
    }

    /// @notice Computes the amount of liquidity received for a given amount of token1 and price range
    /// @dev Calculates amount1 / (sqrt(upper) - sqrt(lower)).
    /// @param sqrtRatioAX96 A sqrt price representing the first tick boundary
    /// @param sqrtRatioBX96 A sqrt price representing the second tick boundary
    /// @param amount1 The amount1 being sent in
    /// @return liquidity The amount of returned liquidity
    function getLiquidityForAmount1(
        uint160 sqrtRatioAX96,
        uint160 sqrtRatioBX96,
        uint256 amount1
    ) internal pure returns (uint128 liquidity) {
        if (sqrtRatioAX96 > sqrtRatioBX96) (sqrtRatioAX96, sqrtRatioBX96) = (sqrtRatioBX96, sqrtRatioAX96);
        unchecked {
            return SafeCast.toUint128(Math.mulDiv(amount1, Q96, sqrtRatioBX96 - sqrtRatioAX96));
        }
    }

    /// @notice {getAmount0ForLiquidity} rounded up: the token0 a pool charges a mint of `liquidity`
    ///         (v3-core `SqrtPriceMath.getAmount0Delta(..., roundUp = true)`).
    function getAmount0ForLiquidityRoundingUp(
        uint160 sqrtRatioAX96,
        uint160 sqrtRatioBX96,
        uint128 liquidity
    ) internal pure returns (uint256 amount0) {
        if (sqrtRatioAX96 > sqrtRatioBX96) (sqrtRatioAX96, sqrtRatioBX96) = (sqrtRatioBX96, sqrtRatioAX96);
        uint256 numerator = Math.mulDiv(
            uint256(liquidity) << RESOLUTION,
            sqrtRatioBX96 - sqrtRatioAX96,
            sqrtRatioBX96,
            Math.Rounding.Ceil
        );
        return Math.ceilDiv(numerator, sqrtRatioAX96);
    }

    /// @notice {getAmount1ForLiquidity} rounded up: the token1 a pool charges a mint of `liquidity`
    ///         (v3-core `SqrtPriceMath.getAmount1Delta(..., roundUp = true)`).
    function getAmount1ForLiquidityRoundingUp(
        uint160 sqrtRatioAX96,
        uint160 sqrtRatioBX96,
        uint128 liquidity
    ) internal pure returns (uint256 amount1) {
        if (sqrtRatioAX96 > sqrtRatioBX96) (sqrtRatioAX96, sqrtRatioBX96) = (sqrtRatioBX96, sqrtRatioAX96);
        return Math.mulDiv(liquidity, sqrtRatioBX96 - sqrtRatioAX96, Q96, Math.Rounding.Ceil);
    }
}
