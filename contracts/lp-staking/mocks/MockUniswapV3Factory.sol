// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MockUniswapV3Factory
 * @notice Test-only stand-in for `UniswapV3Factory`, exposing the ONE function the deploy
 *         scripts read: `getPool(tokenA, tokenB, fee)`.
 *
 *  `scripts/deploy-lp-staking.js` asks the factory whether `LP_POOL` really is the canonical
 *  pool for `(token0, token1, fee)` before it spends any gas — the pool triple check only
 *  proves the contract at that address CLAIMS those tokens, while the factory proves it IS
 *  the pool the router swaps against. That check has no bypass, so a suite that runs the
 *  deploy script against {MockUniswapV3Pool} needs something to answer it.
 *
 *  The registration is explicit rather than derived: the real factory returns `address(0)`
 *  for an unknown triple, and so does this one, so a suite that forgets to register its pool
 *  gets the same refusal from the deploy script that a wrong `LP_POOL` would produce.
 */
contract MockUniswapV3Factory {
    /// @dev token0 -> token1 -> fee -> pool, written under BOTH orderings of the pair so a
    ///      caller that has not sorted the two addresses reads the same answer.
    mapping(address => mapping(address => mapping(uint24 => address))) private _pools;

    /// @notice Registers `pool` as the canonical pool for the pair and fee tier.
    function setPool(address tokenA, address tokenB, uint24 fee, address pool) external {
        _pools[tokenA][tokenB][fee] = pool;
        _pools[tokenB][tokenA][fee] = pool;
    }

    /// @notice The canonical pool for the triple, or `address(0)` when none is registered.
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address) {
        return _pools[tokenA][tokenB][fee];
    }
}
