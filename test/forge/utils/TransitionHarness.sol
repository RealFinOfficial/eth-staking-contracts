// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {StakingV3Harness} from "./StakingV3Harness.sol";

import {LPProxy} from "../../../contracts/lp-staking/deploy/LPProxy.sol";
import {StakingMigrator} from "../../../contracts/staking-v3/StakingMigrator.sol";
import {TransitionReceiver} from "../../../contracts/staking-v3/TransitionReceiver.sol";
import {ITransitionMigrator} from "../../../contracts/staking-v3/interfaces/ITransition.sol";
import {INonfungiblePositionManager} from "../../../contracts/lp-staking/interfaces/INonfungiblePositionManager.sol";

/**
 * @title TransitionHarness
 * @notice {StakingV3Harness}'s math rung plus the transition (spec 01 §9): a `TransitionReceiver`
 *         behind its own `LPProxy`, linked to the migrator with `initializeTransition`, the way
 *         `scripts/deploy-staking-v3.js` does it on a fresh deploy.
 *
 *  Roles: the harness is the owner of every contract and the LP vault's operator (as in
 *  {StakingV3Harness}); `deliverer` is the receiver's service key; `migratorSigner` signs the
 *  delivery vouchers. Tests about a role split move the receiver's ownership to `receiverOwner`.
 *
 *  Prices: the pool sits at $0.25 per $ASSET (4 $ASSET per USDC at the TWAP), the router mock swaps
 *  at exactly that rate, so a route-1 swap passes every floor unless a test lowers the router rate.
 */
abstract contract TransitionHarness is StakingV3Harness {
    uint8 internal constant R1 = 1;
    uint8 internal constant R2 = 2;
    uint8 internal constant R3 = 3;

    TransitionReceiver internal receiver;
    address internal deliverer;
    address internal receiverOwner;

    /// @dev The harness clock starts here, so a burn "one second ago" has a non-zero time.
    uint256 internal constant T0 = 1_763_600_000;

    function _deployTransition() internal {
        vm.warp(T0);
        _deployStakingV3();
        deliverer = makeAddr("deliverer");
        receiverOwner = makeAddr("receiverOwner");
        receiver = _deployReceiver(migrator, address(this), deliverer);
        migrator.initializeTransition(address(receiver));
    }

    function _deployReceiver(StakingMigrator m, address owner_, address deliverer_)
        internal
        returns (TransitionReceiver)
    {
        TransitionReceiver impl = new TransitionReceiver(address(m));
        LPProxy proxy = new LPProxy(address(impl), abi.encodeCall(TransitionReceiver.initialize, (owner_, deliverer_)));
        return TransitionReceiver(address(proxy));
    }

    // ──────────────────────── Receiving addresses ──────────────

    function _at(address holder, uint8 route) internal view returns (address) {
        return receiver.receivingAddressOf(holder, route);
    }

    /// @dev A bridge payment (or Circle's mint): a plain transfer to the receiving address.
    function _payAsset(address holder, uint8 route, uint256 amount) internal {
        asset.transfer(_at(holder, route), amount);
    }

    function _payUsdc(address holder, uint8 route, uint256 amount) internal {
        usdcToken.transfer(_at(holder, route), amount);
    }

    // ──────────────────────── Delivery vouchers ────────────────

    function _limits() internal pure returns (ITransitionMigrator.DeliveryLimits memory) {
        return
            ITransitionMigrator.DeliveryLimits({minAssetOut: 0, amount0Min: 0, amount1Min: 0, deadline: FAR_DEADLINE});
    }

    /// @dev A voucher whose limits equal the eligible amounts, signed by the migrator's signer, with
    ///      the holder's current nonce and a burn one second ago.
    function _dv(address holder, uint8 route, uint256 principal, uint256 reward)
        internal
        view
        returns (ITransitionMigrator.DeliveryVoucher memory)
    {
        (,,,,, uint256 nonce) = migrator.deliveryOf(holder);
        return _dvFull(
            migratorSignerPk,
            holder,
            route,
            principal,
            reward,
            principal,
            reward,
            block.timestamp - 1,
            nonce,
            FAR_DEADLINE
        );
    }

    /// @dev {_dv} with explicit limits and burn time.
    function _dvAt(
        address holder,
        uint8 route,
        uint256 principal,
        uint256 reward,
        uint256 assetLimit,
        uint256 usdcLimit,
        uint256 burnTime
    ) internal view returns (ITransitionMigrator.DeliveryVoucher memory) {
        (,,,,, uint256 nonce) = migrator.deliveryOf(holder);
        return _dvFull(
            migratorSignerPk, holder, route, principal, reward, assetLimit, usdcLimit, burnTime, nonce, FAR_DEADLINE
        );
    }

    function _dvFull(
        uint256 pk,
        address holder,
        uint8 route,
        uint256 principal,
        uint256 reward,
        uint256 assetLimit,
        uint256 usdcLimit,
        uint256 burnTime,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (ITransitionMigrator.DeliveryVoucher memory v) {
        v.route = route;
        v.eligiblePrincipal = principal;
        v.eligibleReward = reward;
        v.assetLimit = assetLimit;
        v.usdcLimit = usdcLimit;
        v.burnTime = burnTime;
        v.nonce = nonce;
        v.deadline = deadline;
        v.signature = _signDelivery(pk, holder, v);
    }

    function _signDelivery(uint256 pk, address holder, ITransitionMigrator.DeliveryVoucher memory v)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = migrator.deliveryVoucherDigest(
            holder,
            v.route,
            v.eligiblePrincipal,
            v.eligibleReward,
            v.assetLimit,
            v.usdcLimit,
            v.burnTime,
            v.nonce,
            v.deadline
        );
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, sv);
    }

    /// @dev The deliverer delivers `holder`'s route with voucher `v`.
    function _deliver(address holder, uint8 route, ITransitionMigrator.DeliveryVoucher memory v)
        internal
        returns (ITransitionMigrator.DeliveryResult memory)
    {
        vm.prank(deliverer);
        return receiver.deliver(holder, route, _limits(), v);
    }

    // ──────────────────────── Reads ────────────────────────────

    function _delivered(address holder) internal view returns (uint256 principal, uint256 reward, uint256 nonce) {
        (,,, principal, reward, nonce) = migrator.deliveryOf(holder);
    }

    function _v3Reserved(address holder) internal view returns (uint256 amount) {
        (amount,) = bonusVault.reservedOf(holder);
    }

    /// @dev The matching $ASSET of `usdcAmount` on the band, computed independently of the
    ///      migrator: the two-sided mint of the math position manager with a huge $ASSET budget
    ///      tells how much $ASSET the whole USDC pairs with.
    function _assetNeededFor(uint256 usdcAmount) internal returns (uint256 needed) {
        uint256 snap = vm.snapshotState();
        address probe = makeAddr("matchingProbe");
        asset.transfer(probe, 10_000_000e18);
        usdcToken.transfer(probe, usdcAmount);
        (int24 lower, int24 upper) = migrator.lpRange();
        vm.startPrank(probe);
        asset.approve(address(mathNpm), type(uint256).max);
        usdcToken.approve(address(mathNpm), type(uint256).max);
        uint256 big = 10_000_000e18;
        (uint256 a0, uint256 a1) = _usdcFirst() ? (usdcAmount, big) : (big, usdcAmount);
        (,, uint256 used0, uint256 used1) = mathNpm.mint(
            INonfungiblePositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: MATH_FEE,
                tickLower: lower,
                tickUpper: upper,
                amount0Desired: a0,
                amount1Desired: a1,
                amount0Min: 0,
                amount1Min: 0,
                recipient: probe,
                deadline: block.timestamp
            })
        );
        vm.stopPrank();
        needed = _usdcFirst() ? used1 : used0;
        vm.revertToState(snap);
    }
}
