// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import "../interfaces/IBonusEscrowHooks.sol";

/// @dev The two vault views the mock reads at hook time, to prove WHEN the vault calls it.
interface IVaultViewsForEscrowMock {
    function stakerOf(uint256 tokenId) external view returns (address);
    function positionManager() external view returns (address);
}

/**
 * @title MockBonusEscrow
 * @notice Test-only escrow for the vault's two notifications. It records what the vault sends
 *         and, on demand, misbehaves in each of the ways the vault must survive or must not:
 *
 *    | mode               | `onUnstake`                    | `onRebalance`          |
 *    |--------------------|--------------------------------|------------------------|
 *    | Record             | records                        | records                |
 *    | RevertOnUnstake    | reverts                        | records                |
 *    | RevertOnRebalance  | records                        | reverts                |
 *    | BurnGasOnUnstake   | spins until its gas runs out   | records                |
 *    | RevertBoth         | reverts                        | reverts                |
 *
 *  At every call it also reads, from the vault and the position manager, the staker record and
 *  the NFT owner of the ids it was given, so a test can assert the ORDER the vault promises:
 *  `onUnstake` after the record is deleted and before the NFT leaves; `onRebalance` after the
 *  record has moved to the new NFT.
 */
contract MockBonusEscrow is IBonusEscrowHooks {
    enum Mode {
        Record,
        RevertOnUnstake,
        RevertOnRebalance,
        BurnGasOnUnstake,
        RevertBoth
    }

    error NotVault(address caller);
    error EscrowRejects();

    address public immutable vault;
    Mode public mode;

    uint256 public unstakeCalls;
    uint256 public lastUnstakeTokenId;
    /// @dev `gasleft()` at the first instruction of the last `onUnstake`.
    uint256 public lastUnstakeGasLeft;
    address public stakerAtUnstake;
    address public nftOwnerAtUnstake;

    uint256 public rebalanceCalls;
    uint256 public lastOldTokenId;
    uint256 public lastNewTokenId;
    address public oldStakerAtRebalance;
    address public newStakerAtRebalance;
    Snapshot internal _lastOld;
    Snapshot internal _lastNew;

    constructor(address vault_) {
        vault = vault_;
    }

    function setMode(Mode mode_) external {
        mode = mode_;
    }

    function onUnstake(uint256 tokenId) external {
        uint256 gasAtEntry = gasleft();
        if (msg.sender != vault) revert NotVault(msg.sender);
        Mode m = mode;
        if (m == Mode.RevertOnUnstake || m == Mode.RevertBoth) revert EscrowRejects();
        if (m == Mode.BurnGasOnUnstake) {
            // Burns every unit of the allowance the vault forwarded; ends in an out-of-gas
            // revert inside this frame, which the vault's `try` must catch.
            uint256 sink;
            while (true) {
                unchecked {
                    ++sink;
                }
            }
        }
        unstakeCalls += 1;
        lastUnstakeTokenId = tokenId;
        lastUnstakeGasLeft = gasAtEntry;
        stakerAtUnstake = IVaultViewsForEscrowMock(vault).stakerOf(tokenId);
        nftOwnerAtUnstake = IERC721(IVaultViewsForEscrowMock(vault).positionManager()).ownerOf(tokenId);
    }

    function onRebalance(uint256 oldTokenId, uint256 newTokenId, Snapshot calldata old_, Snapshot calldata new_)
        external
    {
        if (msg.sender != vault) revert NotVault(msg.sender);
        Mode m = mode;
        if (m == Mode.RevertOnRebalance || m == Mode.RevertBoth) revert EscrowRejects();
        rebalanceCalls += 1;
        lastOldTokenId = oldTokenId;
        lastNewTokenId = newTokenId;
        _lastOld = old_;
        _lastNew = new_;
        oldStakerAtRebalance = IVaultViewsForEscrowMock(vault).stakerOf(oldTokenId);
        newStakerAtRebalance = IVaultViewsForEscrowMock(vault).stakerOf(newTokenId);
    }

    function lastOld() external view returns (Snapshot memory) {
        return _lastOld;
    }

    function lastNew() external view returns (Snapshot memory) {
        return _lastNew;
    }
}
