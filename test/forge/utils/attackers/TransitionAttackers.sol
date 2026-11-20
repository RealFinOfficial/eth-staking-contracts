// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ITransitionMigrator} from "../../../../contracts/staking-v3/interfaces/ITransition.sol";

/// @notice An LP vault stub that only answers `operator()`.
contract OperatorOnlyVault {
    address public operator;

    constructor(address operator_) {
        operator = operator_;
    }
}

/**
 * @title ScriptedMigrator
 * @notice A stand-in for the `StakingMigrator` in the receiver's isolated suites. It answers the
 *         three views the receiver's constructor reads, keeps a settable {deliveryOf} record, and its
 *         three delivery entries pull `pullBps` of what they are handed (10,000 = all of it, the
 *         real migrator's behaviour) and then, when armed, make one call back into a target (the
 *         receiver), recording whether it reverted and with what.
 *
 *  It holds the authority of a migrator over the receiver only in the sense that the receiver calls
 *  it: the receiver gives it allowances for exactly the delivered amounts and nothing else.
 */
contract ScriptedMigrator {
    address public asset;
    address public usdc;
    address public lpVault;

    uint8 public route;
    bool public lpCreated;
    uint256 public principalDelivered;
    uint256 public rewardDelivered;
    uint256 public nextNonce;

    uint256 public pullBps = 10_000;
    address public reenterTarget;
    bytes public reenterData;
    bool public reentered;
    bytes public reenterRevert;

    uint256 public lastAsset;
    uint256 public lastUsdc;
    uint8 public lastEntry;

    constructor(address asset_, address usdc_, address lpVault_) {
        asset = asset_;
        usdc = usdc_;
        lpVault = lpVault_;
    }

    function setRecord(uint8 route_, bool lpCreated_, uint256 principal, uint256 reward, uint256 nonce) external {
        (route, lpCreated, principalDelivered, rewardDelivered, nextNonce) =
        (route_, lpCreated_, principal, reward, nonce);
    }

    function setPullBps(uint256 bps) external {
        pullBps = bps;
    }

    function arm(address target, bytes calldata data) external {
        reenterTarget = target;
        reenterData = data;
    }

    function deliveryOf(address) external view returns (uint8, bool, uint256, uint256, uint256, uint256) {
        return (route, lpCreated, 0, principalDelivered, rewardDelivered, nextNonce);
    }

    function compoundFor(
        address,
        uint256 assetAmount,
        uint256 usdcAmount,
        ITransitionMigrator.DeliveryLimits calldata,
        ITransitionMigrator.DeliveryVoucher calldata
    ) external returns (ITransitionMigrator.DeliveryResult memory r) {
        r = _take(1, assetAmount, usdcAmount);
    }

    function moveToLpFor(
        address,
        uint256 assetAmount,
        uint256 usdcAmount,
        ITransitionMigrator.DeliveryLimits calldata,
        ITransitionMigrator.DeliveryVoucher calldata
    ) external returns (ITransitionMigrator.DeliveryResult memory r) {
        r = _take(2, assetAmount, usdcAmount);
    }

    function claimRestakeFor(
        address,
        uint256 assetAmount,
        ITransitionMigrator.DeliveryLimits calldata,
        ITransitionMigrator.DeliveryVoucher calldata
    ) external returns (ITransitionMigrator.DeliveryResult memory r) {
        r = _take(3, assetAmount, 0);
    }

    function _take(uint8 entry, uint256 assetAmount, uint256 usdcAmount)
        private
        returns (ITransitionMigrator.DeliveryResult memory r)
    {
        lastEntry = entry;
        lastAsset = assetAmount;
        lastUsdc = usdcAmount;
        uint256 a = assetAmount * pullBps / 10_000;
        uint256 u = usdcAmount * pullBps / 10_000;
        if (a > 0) IERC20(asset).transferFrom(msg.sender, address(this), a);
        if (u > 0) IERC20(usdc).transferFrom(msg.sender, address(this), u);
        principalDelivered += assetAmount;
        rewardDelivered += usdcAmount;
        nextNonce += 1;
        if (reenterTarget != address(0)) {
            (bool ok, bytes memory ret) = reenterTarget.call(reenterData);
            reentered = ok;
            reenterRevert = ret;
        }
        r.staked = a;
    }
}
