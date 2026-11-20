// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.38;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

import "../lp-staking/libraries/LiquidityAmounts.sol";
import "../lp-staking/libraries/TickMath.sol";
import "./StakingMigratorBase.sol";

/**
 * @title StakingMigratorDeliveries
 * @notice The bodies of the `StakingMigrator`'s three transition delivery entries ({compoundFor},
 *         {moveToLpFor}, {claimRestakeFor}, spec 01 §9.4). The migrator's constructor creates this
 *         contract and keeps its address as an immutable; the migrator's three entries of the same
 *         names forward their calldata here with `delegatecall`, so this code runs in the migrator
 *         PROXY's context: `msg.sender` is the migrator's caller, `address(this)` is the proxy, and
 *         every read and write lands in the proxy's storage. Events are emitted by the proxy.
 *
 *  Called directly (not through the migrator) it does nothing: its own storage was never
 *  initialized, so its `transitionReceiver` is zero and every entry reverts {NotTransitionReceiver}.
 *  It has no initializer, no setter, no `selfdestruct` and no `delegatecall`.
 */
contract StakingMigratorDeliveries is StakingMigratorBase {
    using SafeERC20 for IERC20;

    /// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
    constructor(address lpVault_, address usdc_, address asset_) StakingMigratorBase(lpVault_, usdc_, asset_) {}

    /**
     * @notice Route 1 for a transition holder: the receiver hands over what arrived at the holder's
     *         route-1 receiving address; the USDC is swapped into $ASSET under the swap floor and
     *         everything is staked in v3 for `holder`. The {transitionReceiver} only.
     * @dev First delivery: both amounts above zero ({UsdcNotArrived}, {AssetNotArrived}). Later: any
     *      of the two above zero ({ZeroAmount}). With USDC the compound pause and the TWAP guard
     *      apply and the swap's minimum is `max(limits.minAssetOut, usdcInAsset(usdcAmount) *
     *      (10,000 - swapLimitBps) / 10,000)`; without USDC there is no swap, no pause check and no
     *      TWAP read.
     */
    function compoundFor(
        address holder,
        uint256 assetAmount,
        uint256 usdcAmount,
        ITransitionMigrator.DeliveryLimits calldata limits,
        ITransitionMigrator.DeliveryVoucher calldata v
    ) external nonReentrant returns (ITransitionMigrator.DeliveryResult memory r) {
        Delivery storage d = _checkDelivery(holder, limits);
        if (d.nextNonce == 0) {
            if (usdcAmount == 0) revert UsdcNotArrived();
            if (assetAmount == 0) revert AssetNotArrived();
        } else if (assetAmount == 0 && usdcAmount == 0) {
            revert ZeroAmount();
        }
        MigratorStorage storage $ = _migratorStorage();
        if (usdcAmount > 0 && $.compoundPaused) revert CompoundIsPaused();
        _useDelivery(holder, ROUTE_COMPOUND, assetAmount, usdcAmount, v, d);
        _pullFromReceiver(assetAmount, usdcAmount);

        uint256 valued;
        if (usdcAmount > 0) {
            valued = usdcInAsset(usdcAmount);
            uint256 floor = Math.mulDiv(valued, BPS - $.swapLimitBps, BPS);
            r.assetBought = _swapUsdcForAsset(usdcAmount, Math.max(limits.minAssetOut, floor));
        }
        r.staked = assetAmount + r.assetBought;
        uint64 unlockAt = _stakeV3(holder, r.staked);
        if (_burnedBeforeCutoff(v.burnTime)) {
            r.v3Bonus = Math.mulDiv(assetAmount + Math.min(r.assetBought, valued), $.compoundBps, BPS);
        }
        _reserve(holder, r.v3Bonus, unlockAt, ROUTE_COMPOUND);
        _emitDelivered(holder, ROUTE_COMPOUND, v, assetAmount, usdcAmount, r);
    }

    /**
     * @notice Route 2 for a transition holder. The first delivery mints ONE position on {lpRange}
     *         from the whole USDC and the matching $ASSET, stakes it in the LP vault for `holder`,
     *         stakes the other $ASSET in v3 and refunds the USDC dust to `holder`; every later
     *         delivery stakes $ASSET in v3 only. The {transitionReceiver} only.
     * @dev First delivery: both amounts above zero, the compound pause, the TWAP guard, and at least
     *      the matching $ASSET of the whole USDC at the pool's current price
     *      ({MatchingAssetNotArrived} otherwise). Later: no USDC ({UsdcNotAccepted}), $ASSET above
     *      zero, no pause check and no call to the Uniswap v3 pool.
     */
    function moveToLpFor(
        address holder,
        uint256 assetAmount,
        uint256 usdcAmount,
        ITransitionMigrator.DeliveryLimits calldata limits,
        ITransitionMigrator.DeliveryVoucher calldata v
    ) external nonReentrant returns (ITransitionMigrator.DeliveryResult memory r) {
        Delivery storage d = _checkDelivery(holder, limits);
        bool first = !d.lpCreated;
        if (first) {
            if (usdcAmount == 0) revert UsdcNotArrived();
            if (assetAmount == 0) revert AssetNotArrived();
            if (_migratorStorage().compoundPaused) revert CompoundIsPaused();
            _checkTwapDeviation();
            uint256 needed = _matchingAsset(usdcAmount);
            if (assetAmount < needed) revert MatchingAssetNotArrived(needed, assetAmount);
        } else {
            if (usdcAmount != 0) revert UsdcNotAccepted();
            if (assetAmount == 0) revert ZeroAmount();
        }
        _useDelivery(holder, ROUTE_LP, assetAmount, usdcAmount, v, d);
        _pullFromReceiver(assetAmount, usdcAmount);

        bool bonusOpen = _burnedBeforeCutoff(v.burnTime);
        if (first) {
            (r.lpTokenId, r.usdcToLp, r.assetToLp) =
                _mintBand(usdcAmount, assetAmount, limits.amount0Min, limits.amount1Min, limits.deadline);
            positionManager.approve(address(lpVault), r.lpTokenId);
            lpVault.stakeFor(holder, r.lpTokenId);
            _assertCustody(r.lpTokenId, holder);
            d.lpCreated = true;
            d.lpTokenId = r.lpTokenId;
            _settleLp(holder, usdcAmount, assetAmount, bonusOpen, r);
        } else {
            r.staked = assetAmount;
            r.v3Bonus = _stakeTopUp(holder, assetAmount, _migratorStorage().lpBps, ROUTE_LP, bonusOpen);
        }
        _emitDelivered(holder, ROUTE_LP, v, assetAmount, usdcAmount, r);
    }

    /**
     * @notice Route 3 for a transition holder: the $ASSET is staked in v3 for `holder`. Never
     *         paused, never touches the Uniswap v3 pool. The {transitionReceiver} only.
     */
    function claimRestakeFor(
        address holder,
        uint256 assetAmount,
        ITransitionMigrator.DeliveryLimits calldata limits,
        ITransitionMigrator.DeliveryVoucher calldata v
    ) external nonReentrant returns (ITransitionMigrator.DeliveryResult memory r) {
        Delivery storage d = _checkDelivery(holder, limits);
        if (assetAmount == 0) revert ZeroAmount();
        _useDelivery(holder, ROUTE_RESTAKE, assetAmount, 0, v, d);
        _pullFromReceiver(assetAmount, 0);

        r.staked = assetAmount;
        r.v3Bonus = _stakeTopUp(
            holder, assetAmount, _migratorStorage().restakeBps, ROUTE_RESTAKE, _burnedBeforeCutoff(v.burnTime)
        );
        _emitDelivered(holder, ROUTE_RESTAKE, v, assetAmount, 0, r);
    }

    // ──────────────────────── Delivery helpers ─────────────────

    /// @dev Steps 1 to 4 of every delivery entry: the receiver, the holder, the end of v3, the call's
    ///      deadline. Returns the holder's record.
    function _checkDelivery(address holder, ITransitionMigrator.DeliveryLimits calldata limits)
        private
        view
        returns (Delivery storage d)
    {
        MigratorStorage storage $ = _migratorStorage();
        address receiver_ = $.transitionReceiver;
        if (msg.sender != receiver_) revert NotTransitionReceiver(msg.sender, receiver_);
        if (holder == address(0)) revert ZeroAddress();
        uint256 end = IWeightedStakingPoolV3Migration($.stakingPool).endEpoch();
        if (block.timestamp >= end) revert StakingEnded(end);
        _checkDeadline(limits.deadline);
        d = $.deliveries[holder];
    }

    /// @dev Step 6 (the delivery voucher) and step 7 (the effects, before any token moves).
    function _useDelivery(
        address holder,
        uint8 route,
        uint256 assetAmount,
        uint256 usdcAmount,
        ITransitionMigrator.DeliveryVoucher calldata v,
        Delivery storage d
    ) private {
        if (v.route != route) revert WrongRoute(route, v.route);
        if (block.timestamp > v.deadline) revert VoucherExpired(v.deadline, block.timestamp);
        if (v.assetLimit > v.eligiblePrincipal || v.usdcLimit > v.eligibleReward) {
            revert InvalidDeliveryLimits(v.assetLimit, v.eligiblePrincipal, v.usdcLimit, v.eligibleReward);
        }
        if (v.burnTime == 0 || v.burnTime > block.timestamp) revert InvalidBurnTime(v.burnTime);

        MigratorStorage storage $ = _migratorStorage();
        uint256 nonce = d.nextNonce;
        if (nonce == 0) {
            if ($.migrated[holder]) revert AlreadyMigrated(holder);
        } else if (d.route != route) {
            revert RouteMismatch(holder, d.route, route);
        }
        if (v.nonce != nonce) revert DeliveryNonceMismatch(holder, nonce, v.nonce);
        uint256 principal = d.principalDelivered + assetAmount;
        if (principal > v.assetLimit) revert PrincipalExceedsEligible(principal, v.assetLimit);
        uint256 reward = d.rewardDelivered + usdcAmount;
        if (reward > v.usdcLimit) revert RewardExceedsEligible(reward, v.usdcLimit);
        _checkDeliverySignature(holder, route, v);

        d.nextNonce = nonce + 1;
        d.principalDelivered = principal;
        d.rewardDelivered = reward;
        if (nonce == 0) {
            d.route = route;
            $.migrated[holder] = true;
        }
        emit DeliveryVoucherUsed(holder, nonce, route, v.burnTime);
    }

    function _checkDeliverySignature(address holder, uint8 route, ITransitionMigrator.DeliveryVoucher calldata v)
        private
        view
    {
        bytes32 digest = deliveryVoucherDigest(
            holder, route, v.eligiblePrincipal, v.eligibleReward, v.assetLimit, v.usdcLimit, v.burnTime, v.nonce, v.deadline
        );
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, v.signature);
        if (err != ECDSA.RecoverError.NoError || recovered != _migratorStorage().signer) {
            revert InvalidVoucherSignature();
        }
    }

    /// @dev Pulls the delivered amounts from the receiver (no permit: the receiver approved them).
    function _pullFromReceiver(uint256 assetAmount, uint256 usdcAmount) private {
        if (assetAmount > 0) IERC20(asset).safeTransferFrom(msg.sender, address(this), assetAmount);
        if (usdcAmount > 0) IERC20(usdc).safeTransferFrom(msg.sender, address(this), usdcAmount);
    }

    /// @dev A top-up into v3 (route 2 after its position, route 3): stakes `amount` for `holder` and
    ///      reserves `bps` of it when the burn was before the cutoff.
    function _stakeTopUp(address holder, uint256 amount, uint16 bps, uint8 route, bool bonusOpen)
        private
        returns (uint256 bonus)
    {
        uint64 unlockAt = _stakeV3(holder, amount);
        if (bonusOpen) bonus = Math.mulDiv(amount, bps, BPS);
        _reserve(holder, bonus, unlockAt, route);
    }

    /// @dev The $ASSET the position on {lpRange} takes together with the whole `usdcAmount` at the
    ///      pool's current price (spec 01 §9.4.5): the liquidity of the USDC alone on its side of the
    ///      band, then the $ASSET of that liquidity, rounded up as the pool charges it.
    function _matchingAsset(uint256 usdcAmount) private view returns (uint256) {
        (uint160 sqrtP,,,,,,) = pool.slot0();
        (int24 tickLower, int24 tickUpper) = lpRange();
        uint160 sqrtA = TickMath.getSqrtRatioAtTick(tickLower);
        uint160 sqrtB = TickMath.getSqrtRatioAtTick(tickUpper);
        if (assetIsToken0) {
            // USDC is token1: its liquidity lives on [lower, price], the $ASSET of it on [price, upper].
            uint128 liquidity = LiquidityAmounts.getLiquidityForAmount1(sqrtA, sqrtP, usdcAmount);
            return LiquidityAmounts.getAmount0ForLiquidityRoundingUp(sqrtP, sqrtB, liquidity);
        }
        uint128 liquidity0 = LiquidityAmounts.getLiquidityForAmount0(sqrtP, sqrtB, usdcAmount);
        return LiquidityAmounts.getAmount1ForLiquidityRoundingUp(sqrtA, sqrtP, liquidity0);
    }

    /// @dev The bonus rule of a delivery: the burn was strictly before the v3 pool's `bonusCutoff()`.
    function _burnedBeforeCutoff(uint256 burnTime) private view returns (bool) {
        return burnTime < IWeightedStakingPoolV3Migration(_migratorStorage().stakingPool).bonusCutoff();
    }

    function _emitDelivered(
        address holder,
        uint8 route,
        ITransitionMigrator.DeliveryVoucher calldata v,
        uint256 assetIn,
        uint256 usdcIn,
        ITransitionMigrator.DeliveryResult memory r
    ) private {
        emit TransitionDelivered(
            holder, route, v.nonce, v.burnTime, assetIn, usdcIn, r.assetBought, r.staked, r.lpTokenId, r.lpBonus, r.v3Bonus
        );
    }
}
