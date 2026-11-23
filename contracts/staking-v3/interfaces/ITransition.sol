// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.38;

/**
 * @title ITransitionMigrator
 * @notice What the `TransitionReceiver` calls on the `StakingMigrator`, and the three types the two
 *         contracts share (spec 01 §9.4). Declared once here, the `IStakingV3.sol` convention, so the
 *         receiver imports no implementation.
 *
 *  The three delivery entries are open ONLY to the migrator's `transitionReceiver`. Each pulls the
 *  amounts it is given from the caller with `safeTransferFrom` and stakes them for `holder` under
 *  the route of the entry, checked against a `DeliveryVoucher` signed by the migrator's voucher
 *  signer.
 */
interface ITransitionMigrator {
    /// @notice The caller's own limits for one delivery.
    struct DeliveryLimits {
        /// Route 1: the caller's own swap minimum (may be 0; the migrator's swap limit sets the floor).
        uint256 minAssetOut;
        /// Route 2, first delivery: the mint's token0 minimum.
        uint256 amount0Min;
        /// Route 2, first delivery: the mint's token1 minimum.
        uint256 amount1Min;
        /// The call's own expiry (`DeadlineExpired`).
        uint256 deadline;
    }

    /// @notice The backend's EIP-712 `DeliveryVoucher` for one delivery, with its signature.
    struct DeliveryVoucher {
        uint8 route;
        /// $ASSET of the holder's ONE eligible `unstake()` record.
        uint256 eligiblePrincipal;
        /// USDC of the same record.
        uint256 eligibleReward;
        /// Cumulative $ASSET this voucher lets be delivered, at most `eligiblePrincipal`.
        uint256 assetLimit;
        /// Cumulative USDC this voucher lets be delivered, at most `eligibleReward`.
        uint256 usdcLimit;
        /// Unix seconds: the time of the burn the delivery came from (the bonus rule).
        uint256 burnTime;
        /// Must equal `deliveryOf(holder).nextNonce`.
        uint256 nonce;
        uint256 deadline;
        bytes signature;
    }

    /// @notice What one delivery did.
    struct DeliveryResult {
        /// $ASSET staked in Testnet Staking by this call (the bought $ASSET included).
        uint256 staked;
        /// Route 1: $ASSET bought with the USDC.
        uint256 assetBought;
        /// Route 2: the position created by this delivery, else 0.
        uint256 lpTokenId;
        /// Route 2, first delivery: the USDC the position took.
        uint256 usdcToLp;
        /// Route 2, first delivery: the $ASSET the position took.
        uint256 assetToLp;
        /// Route 2, first delivery: the bonus reserved under the position.
        uint256 lpBonus;
        /// The bonus reserved in the holder's Testnet Staking reservation.
        uint256 v3Bonus;
    }

    /// @notice Route 1: swap the USDC into $ASSET and stake everything for `holder`.
    function compoundFor(
        address holder,
        uint256 assetAmount,
        uint256 usdcAmount,
        DeliveryLimits calldata limits,
        DeliveryVoucher calldata v
    ) external returns (DeliveryResult memory);

    /// @notice Route 2: one LP position on the first delivery, Testnet Staking for the rest. The
    ///         first delivery must carry exactly the voucher's `usdcLimit` of USDC
    ///         (`UsdcBelowVoucher` below it); later deliveries carry no USDC.
    function moveToLpFor(
        address holder,
        uint256 assetAmount,
        uint256 usdcAmount,
        DeliveryLimits calldata limits,
        DeliveryVoucher calldata v
    ) external returns (DeliveryResult memory);

    /// @notice Route 3: stake the $ASSET for `holder`.
    function claimRestakeFor(
        address holder,
        uint256 assetAmount,
        DeliveryLimits calldata limits,
        DeliveryVoucher calldata v
    ) external returns (DeliveryResult memory);

    /// @notice The holder's delivery record.
    function deliveryOf(address holder)
        external
        view
        returns (
            uint8 route,
            bool lpCreated,
            uint256 lpTokenId,
            uint256 principalDelivered,
            uint256 rewardDelivered,
            uint256 nextNonce
        );
}

/// @dev The migrator views the receiver's constructor reads (the migrator's public immutables).
interface ITransitionMigratorMarket {
    function asset() external view returns (address);

    function usdc() external view returns (address);

    function lpVault() external view returns (address);
}

/// @dev The one LP vault read of the receiver: its operator, read live.
interface ITransitionLpVault {
    function operator() external view returns (address);
}

/// @dev The holding contract placed at a receiving address.
interface ITransitionHolder {
    function pull(address token, uint256 amount) external;
}
