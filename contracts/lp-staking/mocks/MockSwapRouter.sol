// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "../interfaces/ISwapRouter02.sol";

/**
 * @title MockSwapRouter
 * @notice Test-only stand-in for SwapRouter02's `exactInputSingle`.
 *
 *  Pulls `amountIn` of `tokenIn` from the caller and pays `amountIn * num / den` of
 *  `tokenOut` out of its own pre-funded balance. The rate is set per ordered pair, so a
 *  test can express a price across two different decimalities. Output below
 *  `amountOutMinimum` reverts with the router's own message, which is how a caller's
 *  slippage bound is exercised without a real pool.
 *
 *  The struct type comes from {ISwapRouter02} rather than being redeclared, so the
 *  calldata the contracts under test encode is exactly the calldata decoded here.
 */
contract MockSwapRouter {
    using SafeERC20 for IERC20;

    // ──────────────────────── State ────────────────────────────

    /// @notice Rate numerator per ordered pair: amountOut = amountIn * num / den.
    mapping(address => mapping(address => uint256)) public rateNum;
    /// @notice Rate denominator per ordered pair. Zero means "no rate configured".
    mapping(address => mapping(address => uint256)) public rateDen;

    /// @notice Number of swaps executed, so a test can prove the swap was skipped.
    uint256 public swapCalls;

    // Last-call record, for asserting the vault forwarded the right parameters.
    address public lastTokenIn;
    address public lastTokenOut;
    uint24 public lastFee;
    address public lastRecipient;
    uint256 public lastAmountIn;
    uint256 public lastAmountOutMinimum;
    uint160 public lastSqrtPriceLimitX96;

    // ──────────────────────── Test setters ─────────────────────

    function setRate(address tokenIn, address tokenOut, uint256 num, uint256 den) external {
        require(den > 0, "Zero denominator");
        rateNum[tokenIn][tokenOut] = num;
        rateDen[tokenIn][tokenOut] = den;
    }

    // ──────────────────────── Router surface ───────────────────

    function exactInputSingle(ISwapRouter02.ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut)
    {
        swapCalls++;
        lastTokenIn = params.tokenIn;
        lastTokenOut = params.tokenOut;
        lastFee = params.fee;
        lastRecipient = params.recipient;
        lastAmountIn = params.amountIn;
        lastAmountOutMinimum = params.amountOutMinimum;
        lastSqrtPriceLimitX96 = params.sqrtPriceLimitX96;

        uint256 den = rateDen[params.tokenIn][params.tokenOut];
        require(den > 0, "Rate not set");

        amountOut = (params.amountIn * rateNum[params.tokenIn][params.tokenOut]) / den;
        require(amountOut >= params.amountOutMinimum, "Too little received");

        IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);
        IERC20(params.tokenOut).safeTransfer(params.recipient, amountOut);
    }
}
