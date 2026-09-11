// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/ISwapRouter02.sol";
import "../libraries/TwapGuard.sol";

/// @dev The vault entry points the attacker tries to re-enter.
interface IReentrancyTarget {
    function stake(uint256 tokenId) external;

    function unstake(uint256 tokenId) external;

    function rebalance(
        uint256 tokenId,
        int24 newTickLower,
        int24 newTickUpper,
        SwapParams calldata swap,
        uint256 deadline
    ) external returns (uint256);
}

/**
 * @title ReentrantAttacker
 * @notice Test-only malicious swap router. It has SwapRouter02's `exactInputSingle` ABI, so
 *         a vault can be deployed with it in the router slot; when the vault calls it in the
 *         middle of a `rebalance` it calls straight back into the vault instead of swapping.
 *
 *  The re-entrant call is not wrapped in a try/catch, so `ReentrancyGuardReentrantCall`
 *  bubbles all the way out and the whole rebalance reverts — which is the property under
 *  test.
 */
contract ReentrantAttacker {
    enum Mode {
        None,
        Unstake,
        Rebalance,
        Stake
    }

    address public target;
    uint256 public tokenId;
    Mode public mode;

    /// @notice Number of times the router leg was entered.
    uint256 public calls;

    function configure(address target_, uint256 tokenId_, Mode mode_) external {
        target = target_;
        tokenId = tokenId_;
        mode = mode_;
    }

    function exactInputSingle(ISwapRouter02.ExactInputSingleParams calldata)
        external
        payable
        returns (uint256 amountOut)
    {
        calls++;

        if (mode == Mode.Unstake) {
            IReentrancyTarget(target).unstake(tokenId);
        } else if (mode == Mode.Rebalance) {
            IReentrancyTarget(target).rebalance(
                tokenId,
                -60,
                60,
                SwapParams({zeroForOne: true, amountIn: 0, amountOutMin: 0, amount0Min: 0, amount1Min: 0}),
                block.timestamp + 1
            );
        } else if (mode == Mode.Stake) {
            IReentrancyTarget(target).stake(tokenId);
        }

        return 0;
    }
}
