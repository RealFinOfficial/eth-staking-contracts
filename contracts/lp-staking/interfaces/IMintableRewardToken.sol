// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IMintableRewardToken
 * @notice The one mint shape every reward token this program DEPLOYS carries, so that
 *         `RewardsDistributor.mintRewardToken` can mint any of them through a single call.
 *
 *  The rule (decision 2026-10-07):
 *    - Every reward token we deploy — the Overture token ($OVTR) and any later Overture-shaped
 *      token — exposes exactly this `mint(address to, uint256 amount)`, and exactly ONE address,
 *      its `minter`, may call it.
 *    - That minter is the `RewardsDistributor` PROXY. The operator multisig never holds the mint
 *      right itself: it mints through `RewardsDistributor.mintRewardToken`, which is operator-only.
 *    - `mint` creates `amount` new tokens in `to`'s balance and nothing else. This interface
 *      implies no cap. How a token refuses a caller that is not its minter, or a zero amount,
 *      is the token's own business (`TokenOverture` reverts `NotMinter(caller)` and `ZeroAmount()`).
 *    - A reward token we do NOT deploy ($ASSET) need not implement it. It is still a valid reward
 *      token: it is funded by transfer, and `mintRewardToken` on it reverts inside the token.
 *
 *  The interface pins the ABI shape only — selector `mint(address,uint256)` = `0x40c10f19`. A
 *  token contract that declares `is IMintableRewardToken` and drifts from that shape does not
 *  compile.
 */
interface IMintableRewardToken {
    /// @notice Mints `amount` new tokens to `to`. Callable by the token's single minter only.
    /// @param to     Recipient of the new tokens.
    /// @param amount Number of tokens to create, in the token's smallest unit.
    function mint(address to, uint256 amount) external;
}
