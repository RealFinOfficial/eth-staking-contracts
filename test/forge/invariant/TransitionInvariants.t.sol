// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";

import {TransitionHarness} from "../utils/TransitionHarness.sol";
import {LPStakingVault} from "../../../contracts/lp-staking/LPStakingVault.sol";
import {MockERC20Permit} from "../../../contracts/lp-staking/mocks/MockERC20Permit.sol";
import {StakingMigrator} from "../../../contracts/staking-v3/StakingMigrator.sol";
import {TransitionHolder} from "../../../contracts/staking-v3/TransitionHolder.sol";
import {TransitionReceiver} from "../../../contracts/staking-v3/TransitionReceiver.sol";
import {V3BonusVault} from "../../../contracts/staking-v3/V3BonusVault.sol";
import {WeightedStakingPoolV3} from "../../../contracts/staking-v3/WeightedStakingPoolV3.sol";
import {ITransitionMigrator} from "../../../contracts/staking-v3/interfaces/ITransition.sol";

/**
 * @title TransitionHandler
 * @notice Drives a random sequence of every external function the transition touches, by every
 *         role: payments into the nine receiving addresses (three holders, three routes), `deliver`
 *         with fresh vouchers whose limits are random up to the eligible amount, `release` by the
 *         holder (while the operator's release switch is on) or the operator, the switch itself, and "noise": `pull` on a holding contract, the three delivery
 *         entries, the migrator's direct routes and admin, Testnet Staking's withdraw, the bonus
 *         vault's claims and the receiver's admin, each by a random actor. Around every call it
 *         compares the balances of all nine addresses and flags any decrease that is not the exact
 *         hand-over of a successful `deliver` or the payout of a successful `release` to the holder.
 */
contract TransitionHandler is Test {
    TransitionReceiver internal receiver;
    StakingMigrator internal migrator;
    MockERC20Permit internal asset;
    MockERC20Permit internal usdc;
    WeightedStakingPoolV3 internal poolV3;
    V3BonusVault internal bonusVault;
    address internal deliverer;
    address internal operator;
    uint256 internal signerPk;

    address[3] internal holders;
    address[5] internal actors;
    uint256 internal constant ELIGIBLE_P = 50_000e18;
    uint256 internal constant ELIGIBLE_R = 2_000e6;

    // Ghosts
    bool public illegalDecrease;
    bool public releasePaidAnother;
    mapping(address => uint256) public lastAssetLimit;
    mapping(address => uint256) public lastUsdcLimit;
    uint256 public deliveries;
    uint256 public releases;

    constructor(
        TransitionReceiver receiver_,
        StakingMigrator migrator_,
        MockERC20Permit asset_,
        MockERC20Permit usdc_,
        WeightedStakingPoolV3 poolV3_,
        V3BonusVault bonusVault_,
        address deliverer_,
        address operator_,
        uint256 signerPk_,
        address[3] memory holders_
    ) {
        receiver = receiver_;
        migrator = migrator_;
        asset = asset_;
        usdc = usdc_;
        poolV3 = poolV3_;
        bonusVault = bonusVault_;
        deliverer = deliverer_;
        operator = operator_;
        signerPk = signerPk_;
        holders = holders_;
        actors = [holders_[0], holders_[1], deliverer_, operator_, makeAddr("noise")];
    }

    // ──────────────────────── Snapshots ────────────────────────

    struct Snap {
        uint256[9] a;
        uint256[9] u;
    }

    function _snap() internal view returns (Snap memory s) {
        for (uint256 h = 0; h < 3; ++h) {
            for (uint8 r = 1; r <= 3; ++r) {
                address at_ = receiver.receivingAddressOf(holders[h], r);
                s.a[h * 3 + r - 1] = asset.balanceOf(at_);
                s.u[h * 3 + r - 1] = usdc.balanceOf(at_);
            }
        }
    }

    /// @dev No address lost anything, except index `allowed` by exactly (`da`, `du`).
    function _check(Snap memory b, Snap memory a, uint256 allowed, uint256 da, uint256 du) internal {
        for (uint256 i = 0; i < 9; ++i) {
            if (i == allowed) {
                if (b.a[i] - a.a[i] != da || b.u[i] - a.u[i] != du) illegalDecrease = true;
            } else if (a.a[i] < b.a[i] || a.u[i] < b.u[i]) {
                illegalDecrease = true;
            }
        }
    }

    // ──────────────────────── Payments ─────────────────────────

    function pay(uint256 h, uint256 r, uint256 assetAmount, uint256 usdcAmount) public {
        address at_ = receiver.receivingAddressOf(holders[h % 3], uint8(r % 3 + 1));
        assetAmount = bound(assetAmount, 0, 20_000e18);
        usdcAmount = bound(usdcAmount, 0, 1_000e6);
        if (assetAmount > 0) asset.transfer(at_, assetAmount);
        if (usdcAmount > 0) usdc.transfer(at_, usdcAmount);
    }

    // ──────────────────────── The two ways out ─────────────────

    /// @dev A part arrives and is delivered at once (the common path), so deliveries really happen.
    function payThenDeliver(uint256 h, uint256 r, uint256 assetAmount, uint256 usdcAmount, uint256 limitSeed) external {
        this.pay(h, r, assetAmount, usdcAmount);
        this.deliver(h, r, ELIGIBLE_P - (limitSeed % 1000) * 1e18, ELIGIBLE_R, limitSeed % 2 == 0);
    }

    function deliver(uint256 h, uint256 r, uint256 assetLimitSeed, uint256 usdcLimitSeed, bool byHolder) public {
        address holder = holders[h % 3];
        uint8 route = uint8(r % 3 + 1);
        ITransitionMigrator.DeliveryVoucher memory v = _voucher(holder, route, assetLimitSeed, usdcLimitSeed);
        ITransitionMigrator.DeliveryLimits memory l = ITransitionMigrator.DeliveryLimits(0, 0, 0, block.timestamp);
        Snap memory b = _snap();
        Pre memory pre;
        pre.idx = (h % 3) * 3 + route - 1;
        pre.staked0 = poolV3.stakes(holder);
        (,,, pre.p0, pre.r0,) = migrator.deliveryOf(holder);
        vm.prank(byHolder ? holder : deliverer);
        try receiver.deliver(holder, route, l, v) {
            _afterDeliver(b, holder, pre, v);
        } catch {
            _check(b, _snap(), type(uint256).max, 0, 0);
        }
    }

    function _voucher(address holder, uint8 route, uint256 assetLimitSeed, uint256 usdcLimitSeed)
        internal
        view
        returns (ITransitionMigrator.DeliveryVoucher memory v)
    {
        v.route = route;
        v.eligiblePrincipal = ELIGIBLE_P;
        v.eligibleReward = ELIGIBLE_R;
        v.assetLimit = bound(assetLimitSeed, 0, ELIGIBLE_P);
        v.usdcLimit = bound(usdcLimitSeed, 0, ELIGIBLE_R);
        v.burnTime = block.timestamp - 1;
        (,,,,, v.nonce) = migrator.deliveryOf(holder);
        v.deadline = block.timestamp + 1 days;
        bytes32 digest = migrator.deliveryVoucherDigest(
            holder, route, ELIGIBLE_P, ELIGIBLE_R, v.assetLimit, v.usdcLimit, v.burnTime, v.nonce, v.deadline
        );
        (uint8 sv, bytes32 sr, bytes32 ss) = vm.sign(signerPk, digest);
        v.signature = abi.encodePacked(sr, ss, sv);
    }

    struct Pre {
        uint256 idx;
        uint256 p0;
        uint256 r0;
        uint256 staked0;
    }

    function _afterDeliver(Snap memory b, address holder, Pre memory pre, ITransitionMigrator.DeliveryVoucher memory v)
        internal
    {
        (,,, uint256 p1, uint256 r1,) = migrator.deliveryOf(holder);
        _check(b, _snap(), pre.idx, p1 - pre.p0, r1 - pre.r0);
        if (poolV3.stakes(holder) < pre.staked0) illegalDecrease = true;
        lastAssetLimit[holder] = v.assetLimit;
        lastUsdcLimit[holder] = v.usdcLimit;
        ++deliveries;
    }

    function release(uint256 h, uint256 r, bool byOperator) external {
        address holder = holders[h % 3];
        uint8 route = uint8(r % 3 + 1);
        Snap memory b = _snap();
        uint256 idx = (h % 3) * 3 + route - 1;
        uint256 ha = asset.balanceOf(holder);
        uint256 hu = usdc.balanceOf(holder);
        uint256 oa = asset.balanceOf(operator);
        vm.prank(byOperator ? operator : holder);
        try receiver.release(holder, route) {
            _check(b, _snap(), idx, b.a[idx], b.u[idx]);
            if (asset.balanceOf(holder) != ha + b.a[idx] || usdc.balanceOf(holder) != hu + b.u[idx]) {
                releasePaidAnother = true;
            }
            if (byOperator && asset.balanceOf(operator) != oa) releasePaidAnother = true;
            ++releases;
        } catch {
            _check(b, _snap(), type(uint256).max, 0, 0);
        }
    }

    /// @dev The operator's switch for the holder's own release (the holder's `release` above reverts
    ///      `HolderReleaseClosed` while it is off, and moves nothing).
    function setHolderRelease(bool open) external {
        Snap memory b = _snap();
        vm.prank(operator);
        receiver.setHolderRelease(open);
        _check(b, _snap(), type(uint256).max, 0, 0);
    }

    // ──────────────────────── Noise ────────────────────────────

    function noise(uint256 which, uint256 actorSeed, uint256 h, uint256 r, uint256 amount) external {
        address actor = actors[actorSeed % actors.length];
        address holder = holders[h % 3];
        uint8 route = uint8(r % 3 + 1);
        address at_ = receiver.receivingAddressOf(holder, route);
        amount = bound(amount, 1, 1_000e18);
        ITransitionMigrator.DeliveryLimits memory l = ITransitionMigrator.DeliveryLimits(0, 0, 0, block.timestamp);
        ITransitionMigrator.DeliveryVoucher memory v;
        Snap memory b = _snap();
        vm.startPrank(actor);
        uint256 w = which % 12;
        if (w == 0 && at_.code.length > 0) {
            try TransitionHolder(at_).pull(address(asset), amount) {} catch {}
        } else if (w == 1) {
            try migrator.claimRestakeFor(holder, amount, l, v) {} catch {}
        } else if (w == 2) {
            try migrator.compoundFor(holder, amount, amount, l, v) {} catch {}
        } else if (w == 3) {
            try migrator.moveToLpFor(holder, amount, amount, l, v) {} catch {}
        } else if (w == 4) {
            try poolV3.withdraw(amount) {} catch {}
        } else if (w == 5) {
            try bonusVault.claim() {} catch {}
        } else if (w == 6) {
            try migrator.setSwapLimitBps(uint16(amount % 1001)) {} catch {}
        } else if (w == 7) {
            try migrator.pauseCompound() {} catch {}
        } else if (w == 8) {
            try migrator.unpauseCompound() {} catch {}
        } else if (w == 9) {
            try receiver.setDeliverer(actor == operator ? deliverer : actor) {} catch {}
        } else if (w == 10 && actor != operator) {
            // The owner (here also the operator) is the timelock in production; a stranger's attempt.
            try migrator.setTransitionReceiver(actor) {} catch {}
        } else {
            try poolV3.unstake() {} catch {}
        }
        vm.stopPrank();
        _check(b, _snap(), type(uint256).max, 0, 0);
    }
}

/**
 * @notice The transition's standing properties (spec 01 §9.9 items 2 and 3) under the handler above:
 *         nothing but `deliver` and `release` lowers a receiving address, `release` pays only the
 *         holder, the delivered totals never pass the last voucher's limits and the limits never pass
 *         the eligible amounts, and the receiver and the migrator end every call with no tokens and
 *         no allowance.
 */
contract TransitionInvariantsTest is TransitionHarness {
    TransitionHandler internal handler;

    function setUp() public {
        _deployTransition();
        address[3] memory hs = [alice, bob, carol];
        handler = new TransitionHandler(
            receiver, migrator, asset, usdcToken, poolV3, bonusVault, deliverer, address(this), migratorSignerPk, hs
        );
        asset.transfer(address(handler), 10_000_000e18);
        usdcToken.transfer(address(handler), 10_000_000e6);
        targetContract(address(handler));
    }

    function invariant_NothingButDeliverAndReleaseLowersAReceivingAddress() public view {
        assertFalse(handler.illegalDecrease());
    }

    function invariant_ReleasePaysOnlyTheHolder() public view {
        assertFalse(handler.releasePaidAnother());
    }

    function invariant_DeliveriesNeverExceedTheVoucher() public view {
        address[3] memory hs = [alice, bob, carol];
        for (uint256 i = 0; i < 3; ++i) {
            (,,, uint256 p, uint256 r, uint256 n) = migrator.deliveryOf(hs[i]);
            if (n == 0) continue;
            assertLe(p, handler.lastAssetLimit(hs[i]));
            assertLe(r, handler.lastUsdcLimit(hs[i]));
            assertLe(handler.lastAssetLimit(hs[i]), 50_000e18);
            assertLe(handler.lastUsdcLimit(hs[i]), 2_000e6);
        }
    }

    function invariant_ReceiverAndMigratorHoldNothing() public view {
        assertEq(asset.balanceOf(address(receiver)), 0);
        assertEq(usdcToken.balanceOf(address(receiver)), 0);
        assertEq(asset.balanceOf(address(migrator)), 0);
        assertEq(usdcToken.balanceOf(address(migrator)), 0);
        assertEq(asset.allowance(address(receiver), address(migrator)), 0);
        assertEq(usdcToken.allowance(address(receiver), address(migrator)), 0);
    }
}
