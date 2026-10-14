// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

/**
 * @title IBonusEscrowHooks
 * @notice The two notifications `LPStakingVault` sends to the bonus escrow it is linked to
 *         (`LPStakingVault.bonusEscrow()`). Nothing else in the vault knows the escrow exists.
 *
 *  - `onUnstake` is called by `unstake` after the staker record is deleted and before the NFT
 *    leaves the vault, inside `try`/`catch` and with a fixed gas allowance. It FAILS OPEN: if it
 *    reverts, the exit completes and the vault emits `BonusHookFailed(tokenId)`. An exit never
 *    depends on the escrow.
 *  - `onRebalance` is called by `rebalance` after the staker record has moved from the old NFT
 *    to the new one, with NO `try`. It FAILS CLOSED: if it reverts, the rebalance reverts.
 *    `rebalance` is not an exit — `unstake` stays available whatever the escrow does.
 *
 *  Both are sent only while `bonusEscrow != address(0)`. Mainnet ships with the escrow unset.
 */
interface IBonusEscrowHooks {
    /// @notice The range and liquidity of one position NFT, read by the vault.
    struct Snapshot {
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
    }

    /// @notice `tokenId` left the vault through `unstake`.
    function onUnstake(uint256 tokenId) external;

    /// @notice A staked position was re-ranged: `oldTokenId` (burned in the same transaction)
    ///         became `newTokenId` under the same staker.
    /// @param old_ The old position as it was BEFORE its liquidity was withdrawn.
    /// @param new_ The new position as minted.
    function onRebalance(uint256 oldTokenId, uint256 newTokenId, Snapshot calldata old_, Snapshot calldata new_)
        external;
}
