// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import "../TokenOverture.sol";

/**
 * @title TokenOvertureV2Mock
 * @notice Test-only second implementation for the Overture token proxy. It makes the upgrade
 *         claims measurable: `upgradeToAndCall` really swaps the code, balances, allowances,
 *         permit nonces, the owner and the minter survive it, and a V2 may add state in a
 *         namespace of its own (`real.lp.storage.TokenOvertureV2`) without touching V1's.
 */
contract TokenOvertureV2Mock is TokenOverture {
    /// @custom:storage-location erc7201:real.lp.storage.TokenOvertureV2
    struct V2Storage {
        uint256 upgradeMarker;
    }

    /// @dev `keccak256(abi.encode(uint256(keccak256("real.lp.storage.TokenOvertureV2")) - 1)) & ~bytes32(uint256(0xff))`
    bytes32 private constant V2_STORAGE = 0x813479c37f3e186a37e42fb4bc818ed4c90b402224b9bf5a3f5249cba0040000;

    function _v2Storage() private pure returns (V2Storage storage $) {
        assembly {
            $.slot := V2_STORAGE
        }
    }

    constructor() TokenOverture() {}

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
