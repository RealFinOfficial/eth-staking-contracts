// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/math/Math.sol";

import "./LiquidityAmounts.sol";
import "./TickMath.sol";

/**
 * @title PositionValue
 * @notice The ONE valuation of a Uniswap V3 position used by the ApeBond contracts (B.3 decision
 *         document, A2: one valuation, one place). `ApeBondPositionAdapter` uses it to price the
 *         bonus at deposit, and `BonusEscrow` uses it to scale the bonus when a rebalance takes
 *         value out of the position. Two implementations of "what is this position worth" would
 *         drift; this library is the only one.
 *
 *  What it counts: the token amounts `liquidity` represents on `[tickLower, tickUpper]` at the
 *  price `tick`, converted into ONE of the pool's two tokens at that same price. Uncollected
 *  trading fees are NOT counted (a freshly minted position has none; B.3 limit L7). Every step
 *  rounds DOWN, so the result never exceeds the true value.
 *
 *  Why the price is a TICK (the vault's TWAP) and not the spot price: for a fixed liquidity, the
 *  value at the TWAP is never more than the TWAP value of the tokens that had to be supplied to
 *  mint it, at whatever spot price the mint happened (B.3 decision document §5.1). A price pushed
 *  inside the transaction therefore cannot inflate the result.
 *
 *  Overflow: the conversion multiplies by the price twice through `Math.mulDiv`, which reverts
 *  rather than wrapping when a result does not fit in 256 bits. That happens only for
 *  combinations no pool can hold (liquidity near `type(uint128).max` with a range spanning most
 *  of the tick space, valued at a price near one end of it); a position that reverts here cannot
 *  be deposited through the adapter, and a rebalance of one that carries an active bonus fails
 *  closed while `unstake` stays open.
 */
library PositionValue {
    uint256 internal constant Q96 = 1 << 96;

    /// @notice Value of `liquidity` on [tickLower, tickUpper] at price `tick`, expressed in one of
    ///         the pool's two tokens. Liquidity only: uncollected fees are not counted. Rounds down.
    /// @param liquidity The position's liquidity.
    /// @param tickLower The position's lower tick.
    /// @param tickUpper The position's upper tick.
    /// @param tick The price to value at (the vault's TWAP tick).
    /// @param inToken0 True to express the value in token0, false for token1.
    /// @return The value, in the smallest unit of the chosen token.
    function valueAt(uint128 liquidity, int24 tickLower, int24 tickUpper, int24 tick, bool inToken0)
        internal
        pure
        returns (uint256)
    {
        uint160 sqrtP = TickMath.getSqrtRatioAtTick(tick);
        (uint256 amount0, uint256 amount1) = LiquidityAmounts.getAmountsForLiquidity(
            sqrtP, TickMath.getSqrtRatioAtTick(tickLower), TickMath.getSqrtRatioAtTick(tickUpper), liquidity
        );
        // price (token1 per token0) = (sqrtP / 2^96)^2, so token1 -> token0 divides by it twice
        // and token0 -> token1 multiplies by it twice.
        return inToken0
            ? amount0 + Math.mulDiv(Math.mulDiv(amount1, Q96, sqrtP), Q96, sqrtP)
            : amount1 + Math.mulDiv(Math.mulDiv(amount0, sqrtP, Q96), sqrtP, Q96);
    }
}
