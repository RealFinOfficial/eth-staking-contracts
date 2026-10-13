// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IBonusEscrowHooks.sol";

/**
 * @title MockForfeitingBonusEscrow
 * @notice Test-only escrow whose `onUnstake` does the work the real `BonusEscrow` does on an
 *         exit before the cliff, in the real storage shape, so the vault's {BONUS_HOOK_GAS} can
 *         be sized from a measurement rather than a guess. Deployed behind an `LPProxy` in the
 *         measurement, like the real escrow, so the delegatecall is in the figure too.
 *
 *  `onUnstake` for an active reservation: one storage read of `vault` (a storage field in the
 *  real escrow, set by its reinitializer), two cold slots of the reservation, a
 *  `totalReserved` read and write, the forfeiture writes (`amount = 0`, `forfeited = true`),
 *  and `BonusForfeited`. That is the whole of B.3 document section 5.3 for this hook.
 *  `onRebalance` does nothing here; the vault does not cap its gas.
 */
contract MockForfeitingBonusEscrow is IBonusEscrowHooks {
    struct Reservation {
        address beneficiary;
        uint64 unlockAt;
        bool claimed;
        bool forfeited;
        uint256 amount;
    }

    /// @custom:storage-location erc7201:real.lp.storage.MockBonusEscrow
    struct EscrowStorage {
        address adapter;
        uint256 totalReserved;
        mapping(bytes32 => Reservation) reservations;
        address vault;
    }

    /// @dev `keccak256(abi.encode(uint256(keccak256("real.lp.storage.MockBonusEscrow")) - 1)) & ~bytes32(uint256(0xff))`
    bytes32 private constant ESCROW_STORAGE = 0xb4a76a95901762a762f8d37ef0b76824431b438b1e9866d054d06e53069a8a00;

    event BonusForfeited(uint256 indexed tokenId, address indexed beneficiary, uint256 amount);

    error NotVault(address caller);
    error AlreadyInitialized();

    function _s() private pure returns (EscrowStorage storage $) {
        assembly {
            $.slot := ESCROW_STORAGE
        }
    }

    function initialize(address vault_) external {
        EscrowStorage storage $ = _s();
        if ($.vault != address(0)) revert AlreadyInitialized();
        $.vault = vault_;
    }

    /// @notice Test helper: records a reservation the way the adapter's `reserve` would.
    function reserve(uint256 tokenId, address beneficiary, uint256 amount, uint64 unlockAt) external {
        EscrowStorage storage $ = _s();
        $.reservations[bytes32(tokenId)] =
            Reservation({beneficiary: beneficiary, unlockAt: unlockAt, claimed: false, forfeited: false, amount: amount});
        $.totalReserved += amount;
    }

    function onUnstake(uint256 tokenId) external {
        EscrowStorage storage $ = _s();
        if (msg.sender != $.vault) revert NotVault(msg.sender);
        Reservation storage r = $.reservations[bytes32(tokenId)];
        if (r.beneficiary == address(0) || r.claimed || r.forfeited || block.timestamp >= r.unlockAt) return;
        uint256 amount = r.amount;
        $.totalReserved -= amount;
        r.amount = 0;
        r.forfeited = true;
        emit BonusForfeited(tokenId, r.beneficiary, amount);
    }

    function onRebalance(uint256, uint256, Snapshot calldata, Snapshot calldata) external view {
        if (msg.sender != _s().vault) revert NotVault(msg.sender);
    }

    function totalReserved() external view returns (uint256) {
        return _s().totalReserved;
    }

    function reservationOf(uint256 tokenId)
        external
        view
        returns (address beneficiary, uint256 amount, uint64 unlockAt, bool claimed, bool forfeited)
    {
        Reservation storage r = _s().reservations[bytes32(tokenId)];
        return (r.beneficiary, r.amount, r.unlockAt, r.claimed, r.forfeited);
    }
}
