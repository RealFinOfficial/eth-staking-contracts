// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.38;

import "../TransitionReceiver.sol";

/**
 * @title TransitionReceiverV2Mock
 * @notice TEST ONLY. A second implementation of the `TransitionReceiver` proxy that makes the
 *         upgrade claim of spec 01 §9.9 item 7 measurable: after `upgradeToAndCall` every receiving
 *         address is the same, a holding contract placed before still hands its tokens over, the
 *         deliverer and the owner survive, and a V2 may add state in a namespace of its own
 *         (`real.staking.storage.TransitionReceiverV2`). It is only ever reached by an upgrade of a
 *         proxy whose V1 `initialize` already ran, so its own entry is the reinitializer
 *         {initializeV2}; the validator's "missing initializer" rule is waived for that reason.
 * @custom:oz-upgrades-unsafe-allow missing-initializer
 */
contract TransitionReceiverV2Mock is TransitionReceiver {
    /// @custom:storage-location erc7201:real.staking.storage.TransitionReceiverV2
    struct V2Storage {
        uint256 upgradeMarker;
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("real.staking.storage.TransitionReceiverV2")) - 1)) & ~0xff
    bytes32 private constant V2_STORAGE = 0x640b08234c1a6b9124356e9376c5405616db94bec1594680b99787be8b128200;

    function _v2Storage() private pure returns (V2Storage storage $) {
        assembly {
            $.slot := V2_STORAGE
        }
    }

    /// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
    constructor(address migrator_) TransitionReceiver(migrator_) {}

    /// @notice Runs once, inside `upgradeToAndCall`.
    function initializeV2(uint256 marker) external reinitializer(2) onlyOwner {
        _v2Storage().upgradeMarker = marker;
    }

    /// @notice Tells the two implementations apart from the proxy's own address.
    function version() external pure returns (uint256) {
        return 2;
    }

    function upgradeMarker() external view returns (uint256) {
        return _v2Storage().upgradeMarker;
    }
}
