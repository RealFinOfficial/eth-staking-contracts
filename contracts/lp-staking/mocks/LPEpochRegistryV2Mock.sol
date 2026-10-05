// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../LPEpochRegistry.sol";

/**
 * @title LPEpochRegistryV2Mock
 * @notice Test-only second implementation for the registry proxy. It makes the upgrade claims
 *         measurable: `upgradeToAndCall` really swaps the code, every epoch, amount, token list,
 *         `epochCount`, `lastLiveId`, the owner and the operator survive it, and a V2 may add
 *         state in a namespace of its own (`real.lp.storage.LPEpochRegistryV2`).
 */
contract LPEpochRegistryV2Mock is LPEpochRegistry {
    /// @custom:storage-location erc7201:real.lp.storage.LPEpochRegistryV2
    struct V2Storage {
        uint256 upgradeMarker;
    }

    /// @dev `keccak256(abi.encode(uint256(keccak256("real.lp.storage.LPEpochRegistryV2")) - 1)) & ~bytes32(uint256(0xff))`
    bytes32 private constant V2_STORAGE = 0x8759fda2ccd33deb949080a3721cdc1916db78aa671d1009e0865e45b191a000;

    function _v2Storage() private pure returns (V2Storage storage $) {
        assembly {
            $.slot := V2_STORAGE
        }
    }

    constructor(address distributor_) LPEpochRegistry(distributor_) {}

    /// @notice Tells the two implementations apart from the proxy's own address.
    function version() external pure returns (uint256) {
        return 2;
    }

    /// @notice The V2 half of the setup, run once via `upgradeToAndCall`.
    function initializeV2(uint256 marker) external reinitializer(2) {
        _v2Storage().upgradeMarker = marker;
    }

    /// @notice V2-only state, in a namespace V1 never wrote to.
    function upgradeMarker() external view returns (uint256) {
        return _v2Storage().upgradeMarker;
    }
}
