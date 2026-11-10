// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.38;

/**
 * @title IStakingV3
 * @notice The calls the three staking-v3 contracts make on each other. Declared once here so no
 *         contract imports another one's implementation.
 *
 *  - {IWeightedStakingPoolV3Migration}: what the migrator calls on the v3 pool.
 *  - {IV3BonusVaultReservations}: what the migrator calls on the bonus vault.
 *  - {IV3BonusVaultEarlyExit}: what the v3 pool calls on the bonus vault when a stake leaves early.
 */
interface IWeightedStakingPoolV3Migration {
    /// @notice Stakes `amount`, pulled from the caller (the registered migrator), for `user`.
    function stakeFor(address user, uint256 amount) external;

    /// @notice The end of the pool's active period; the bonus unlock time.
    function endEpoch() external view returns (uint256);

    /// @notice The staked token ($ASSET).
    function stakingToken() external view returns (address);
}

interface IV3BonusVaultReservations {
    /// @notice Adds `amount` to `user`'s v3 bonus reservation, unlocked at `unlockAt`.
    function reserve(address user, uint256 amount, uint64 unlockAt, uint8 route) external;

    /// @notice Records the bonus of one LP position, keyed by its tokenId.
    function reserveLp(uint256 tokenId, address user, uint256 amount, uint64 unlockAt) external;

    /// @notice The bonus token ($ASSET).
    function bonusToken() external view returns (address);
}

interface IV3BonusVaultEarlyExit {
    /// @notice `user` withdrew from the v3 pool before its end.
    function onEarlyExit(address user) external;
}
