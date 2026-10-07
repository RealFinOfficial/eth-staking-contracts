// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../LPStakingVault.sol";

/**
 * @title LPStakingVaultV2Mock
 * @notice Test-only second implementation for the vault proxy. It exists to make the upgrade
 *         claims measurable: that `upgradeToAndCall` really swaps the code, that the staker
 *         ledger and both admin tiers survive it, and that a V2 may add state without
 *         touching V1's.
 *
 *  It changes nothing about custody or the rebalance math. The only additions are a
 *  `version()` marker and one new variable, which lives in its OWN ERC-7201 namespace
 *  (`real.lp.storage.LPStakingVaultV2`) rather than inside V1's struct. That is the pattern a
 *  real upgrade would follow when it needs state the first version never had: appending to
 *  V1's struct is also legal, but a separate namespace cannot get the offset wrong.
 */
contract LPStakingVaultV2Mock is LPStakingVault {
    /// @custom:storage-location erc7201:real.lp.storage.LPStakingVaultV2
    struct V2Storage {
        uint256 upgradeMarker;
    }

    /// @dev `keccak256(abi.encode(uint256(keccak256("real.lp.storage.LPStakingVaultV2")) - 1)) & ~bytes32(uint256(0xff))`
    bytes32 private constant V2_STORAGE = 0x6e440554da1be5fdca22101f6189d75d0e5709816090a1a2d9d2a5fc0f839d00;

    function _v2Storage() private pure returns (V2Storage storage $) {
        assembly {
            $.slot := V2_STORAGE
        }
    }

    constructor(
        address _positionManager,
        address _pool,
        address _token0,
        address _token1,
        uint24 _fee,
        address _swapRouter
    ) LPStakingVault(_positionManager, _pool, _token0, _token1, _fee, _swapRouter) {}

    /// @notice Tells the two implementations apart from the proxy's own address.
    function version() external pure returns (uint256) {
        return 2;
    }

    /// @notice The V2 half of the setup, run once via `upgradeToAndCall`. `reinitializer(2)`
    ///         is what lets a second version seed state the first version never had, without
    ///         re-running V1's `initialize`.
    function initializeV2(uint256 marker) external reinitializer(2) {
        _v2Storage().upgradeMarker = marker;
    }

    /// @notice V2-only state, in a namespace V1 never wrote to.
    function upgradeMarker() external view returns (uint256) {
        return _v2Storage().upgradeMarker;
    }

    function setUpgradeMarker(uint256 marker) external onlyOwner {
        _v2Storage().upgradeMarker = marker;
    }
}
