// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../LPZapper.sol";

/**
 * @title LPZapperV2Mock
 * @notice Test-only second implementation for the zapper proxy. It makes the upgrade claims
 *         measurable: `upgradeToAndCall` really swaps the code, the owner, the operator, the
 *         TWAP parameters and the receive guard survive it, and a V2 may add state in a
 *         namespace of its own (`real.lp.storage.LPZapperV2`).
 */
contract LPZapperV2Mock is LPZapper {
    /// @custom:storage-location erc7201:real.lp.storage.LPZapperV2
    struct V2Storage {
        uint256 upgradeMarker;
    }

    /// @dev `keccak256(abi.encode(uint256(keccak256("real.lp.storage.LPZapperV2")) - 1)) & ~bytes32(uint256(0xff))`
    bytes32 private constant V2_STORAGE = 0x0136fd090b5380a5d6e1548d275239fdccf70ae762c39f885c501bbd9c32d500;

    function _v2Storage() private pure returns (V2Storage storage $) {
        assembly {
            $.slot := V2_STORAGE
        }
    }

    constructor(
        address _vault,
        address _positionManager,
        address _pool,
        address _token0,
        address _token1,
        uint24 _fee,
        address _swapRouter,
        address _usdc,
        address _asset
    ) LPZapper(_vault, _positionManager, _pool, _token0, _token1, _fee, _swapRouter, _usdc, _asset) {}

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
