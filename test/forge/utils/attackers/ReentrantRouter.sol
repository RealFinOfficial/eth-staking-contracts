// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISwapRouter02} from "../../../../contracts/lp-staking/interfaces/ISwapRouter02.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @notice A SwapRouter02 stand-in that calls an arbitrary target back from inside
 *         `exactInputSingle`.
 *
 * @dev Why it gets this authority: `LPStakingVault._executeSwap` and `LPZapper._executeSwap`
 *      hand control to the configured router mid-flow, after the position has been emptied
 *      and before the new one is minted. That is the deepest reentrancy window in the stack,
 *      and the router address is an immutable set at deploy time — so a compromised or
 *      malicious router is the honest threat model for it, not a contrived one. The router
 *      is deliberately given no other power: it does not need one.
 *
 *      It also settles the swap for real (pull `tokenIn`, push `tokenOut` at a configured
 *      rate) so the surrounding flow keeps working and the reentrancy is the ONLY difference.
 */
contract ReentrantRouter {
    /// @notice Call replayed into `target` from inside the swap. Empty calldata disables it.
    address public target;
    bytes public payload;
    /// @notice Number of times the reentrant call was attempted.
    uint256 public attempts;
    /// @notice Whether the last reentrant call reverted, and with what.
    bool public lastReenterSucceeded;
    bytes public lastReturnData;

    /// @notice amountOut = amountIn * rateNum / rateDen.
    uint256 public rateNum = 1;
    uint256 public rateDen = 1;

    function configure(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
    }

    function setRate(uint256 num, uint256 den) external {
        require(den > 0, "zero denominator");
        rateNum = num;
        rateDen = den;
    }

    function exactInputSingle(ISwapRouter02.ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut)
    {
        if (target != address(0) && payload.length > 0) {
            attempts++;
            (bool ok, bytes memory ret) = target.call(payload);
            lastReenterSucceeded = ok;
            lastReturnData = ret;
        }

        amountOut = (params.amountIn * rateNum) / rateDen;
        require(amountOut >= params.amountOutMinimum, "Too little received");
        IERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn);
        IERC20(params.tokenOut).transfer(params.recipient, amountOut);
    }
}
