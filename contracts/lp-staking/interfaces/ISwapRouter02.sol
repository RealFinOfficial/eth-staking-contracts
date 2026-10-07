// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ISwapRouter02
 * @notice Minimal vendored interface for the Uniswap SwapRouter02
 *         (0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45 on mainnet).
 *
 *  IMPORTANT — SwapRouter02 is NOT the same ABI as the original V3 `SwapRouter`:
 *  its `ExactInputSingleParams` has **no `deadline` field**. SwapRouter02 moved deadline
 *  enforcement into the `Multicall` wrapper (`multicall(deadline, data)`). Encoding a
 *  V1-shaped struct against SwapRouter02 shifts every field after `recipient` and either
 *  reverts or swaps with nonsense parameters, so the struct below must stay as is.
 *
 *  The npm package uniswap/swap-router-contracts is pinned to `pragma 0.7.6`, hence the
 *  vendored copy.
 */
interface ISwapRouter02 {
    // ──────────────────────── Structures ────────────────────────

    /// @dev No `deadline` member — see the contract-level note above.
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    // ──────────────────────── Swaps ─────────────────────────────

    /// @notice Swaps `amountIn` of one token for as much as possible of another, single pool hop.
    /// @param params Swap parameters, see {ExactInputSingleParams}.
    /// @return amountOut Amount of `tokenOut` received.
    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}
