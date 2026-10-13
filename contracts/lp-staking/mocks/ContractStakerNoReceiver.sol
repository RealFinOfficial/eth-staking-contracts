// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/INonfungiblePositionManager.sol";

/// @dev The vault entry points the helper drives.
interface IStakingVaultEntry {
    function stake(uint256 tokenId) external;

    function unstake(uint256 tokenId) external;
}

/**
 * @title ContractStakerNoReceiver
 * @notice Test-only contract staker that deliberately does NOT implement
 *         `onERC721Received`.
 *
 *  It is the counter-example the vault's exit path has to survive: the deposit leg checks
 *  the receipt hook on the vault, not on the depositor, so a contract like this can stake.
 *  If the exit leg used `safeTransferFrom`, the return transfer would revert with
 *  `ERC721InvalidReceiver` and the position would be locked in the vault forever. With a
 *  plain `transferFrom` the exit stays unconditional.
 *
 *  It holds the NFT through `_mint` (no receipt hook fires), so a test can fabricate a
 *  position straight to this address.
 */
contract ContractStakerNoReceiver {
    /// @notice Approves the vault for `tokenId` and stakes it in one call.
    /// @param vault The LPStakingVault.
    /// @param npm The position manager holding `tokenId`.
    /// @param tokenId The position NFT this contract owns.
    function approveAndStake(address vault, address npm, uint256 tokenId) external {
        INonfungiblePositionManager(npm).approve(vault, tokenId);
        IStakingVaultEntry(vault).stake(tokenId);
    }

    /// @notice Withdraws a position this contract staked.
    /// @param vault The LPStakingVault.
    /// @param tokenId The staked position NFT.
    function unstake(address vault, uint256 tokenId) external {
        IStakingVaultEntry(vault).unstake(tokenId);
    }
}
