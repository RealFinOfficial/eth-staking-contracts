// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../LPZapper.sol";

/**
 * @title LPZapperSwapHarness
 * @notice Test-only subclass that exposes {LPZapper-_executeSwap} as an external call.
 *
 *  The twin of `LPStakingVaultSwapHarness`, for the periphery's copy of the same guard:
 *  `_executeSwap` rejects `amountIn == 0` before it touches SwapRouter02, which reads a zero
 *  amount as its `Constants.CONTRACT_BALANCE` sentinel ("swap the router's whole balance of
 *  `tokenIn`") rather than as "nothing to swap".
 *
 *  That arm is unreachable from the production surface: `_zapIn` is the only caller and it
 *  gates the swap leg behind `swap.amountIn > 0`. The guard is there precisely so a later
 *  refactor cannot drop that gate silently — an invariant one function away from the call it
 *  protects is an invariant nobody is testing. This harness is what turns it into a measured
 *  branch instead of an unexecuted one.
 *
 *  Nothing else is changed: the zap flow, the refunds and the owner surface are inherited
 *  untouched, and the constructor's checks run exactly as they do in production.
 */
contract LPZapperSwapHarness is LPZapper {
    constructor(
        address _vault,
        address _positionManager,
        address _pool,
        address _token0,
        address _token1,
        uint24 _fee,
        address _swapRouter,
        address _usdc,
        address _asset,
        address _initialOwner,
        uint32 _twapWindow,
        uint24 _maxTwapDeviationTicks
    )
        LPZapper(
            _vault,
            _positionManager,
            _pool,
            _token0,
            _token1,
            _fee,
            _swapRouter,
            _usdc,
            _asset,
            _initialOwner,
            _twapWindow,
            _maxTwapDeviationTicks
        )
    {}

    /// @notice Calls the internal swap leg directly, with no `_zapIn` around it.
    /// @param swap The swap parameters `_zapIn` would have passed through.
    function exposedExecuteSwap(SwapParams calldata swap) external {
        _executeSwap(swap);
    }
}
