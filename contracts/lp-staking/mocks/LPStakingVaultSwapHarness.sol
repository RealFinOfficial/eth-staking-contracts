// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../LPStakingVault.sol";

/**
 * @title LPStakingVaultSwapHarness
 * @notice Test-only subclass that exposes {LPStakingVault-_executeSwap} as an external call.
 *
 *  It exists for one assertion: `_executeSwap` rejects `amountIn == 0` before it touches
 *  SwapRouter02, which reads a zero amount as its `Constants.CONTRACT_BALANCE` sentinel
 *  ("swap the router's whole balance of `tokenIn`") rather than as "nothing to swap".
 *
 *  That arm is unreachable from the production surface: `rebalance` is the only caller and it
 *  gates the swap leg behind `swap.amountIn > 0`. The guard is there precisely so a later
 *  refactor cannot drop that gate silently — an invariant one function away from the call it
 *  protects is an invariant nobody is testing. This harness is what turns it into a measured
 *  branch instead of an unexecuted one.
 *
 *  Nothing else is changed: custody, the rebalance math and every admin tier are inherited
 *  untouched, and the contract is deployed BARE (no proxy) because the branch under test
 *  fires before any namespaced storage is read.
 */
contract LPStakingVaultSwapHarness is LPStakingVault {
    constructor(
        address _positionManager,
        address _pool,
        address _token0,
        address _token1,
        uint24 _fee,
        address _swapRouter
    ) LPStakingVault(_positionManager, _pool, _token0, _token1, _fee, _swapRouter) {}

    /// @notice Calls the internal swap leg directly, with no `rebalance` around it.
    /// @param swap The swap parameters `rebalance` would have passed through.
    function exposedExecuteSwap(SwapParams calldata swap) external {
        _executeSwap(swap);
    }
}
