// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";

import {TransitionHarness} from "../utils/TransitionHarness.sol";

import {LPProxy} from "../../../contracts/lp-staking/deploy/LPProxy.sol";
import {TwapGuard} from "../../../contracts/lp-staking/libraries/TwapGuard.sol";
import {StakingMigrator} from "../../../contracts/staking-v3/StakingMigrator.sol";
import {StakingMigratorBase} from "../../../contracts/staking-v3/StakingMigratorBase.sol";
import {StakingMigratorDeliveries} from "../../../contracts/staking-v3/StakingMigratorDeliveries.sol";
import {TransitionReceiver} from "../../../contracts/staking-v3/TransitionReceiver.sol";
import {V3BonusVault} from "../../../contracts/staking-v3/V3BonusVault.sol";
import {WeightedStakingPoolV3} from "../../../contracts/staking-v3/WeightedStakingPoolV3.sol";
import {ITransitionMigrator} from "../../../contracts/staking-v3/interfaces/ITransition.sol";

import {LPStakingVault} from "../../../contracts/lp-staking/LPStakingVault.sol";
import {MockHookERC20} from "../../../contracts/lp-staking/mocks/MockHookERC20.sol";
import {MockMathPositionManager} from "../../../contracts/lp-staking/mocks/MockMathPositionManager.sol";
import {MockUniswapV3Pool} from "../../../contracts/lp-staking/mocks/MockUniswapV3Pool.sol";
import {TickMath} from "../../../contracts/lp-staking/libraries/TickMath.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";

/**
 * @notice The `StakingMigrator`'s three delivery entries (spec 01 §9.4 to §9.6, §9.9): only the
 *         receiver may call them, the check order with each revert, the delivery voucher (spent
 *         once, in sequence, within its limits), the three routes in parts, route 2's one position
 *         and its matching amount, the swap floor and its bounds, the bonus by the time of the burn,
 *         one option per wallet, the end of Testnet Staking, the stolen service key, the admin
 *         additions, the upgrade with `initializeTransition` and the pinned storage slots.
 */
contract MigratorDeliveryTest is TransitionHarness {
    uint256 internal constant P = 20_000e18;
    uint256 internal constant R = 1_000e6;
    /// @dev The router mock's fill: 4 $ASSET per USDC, the pool's TWAP price.
    uint256 internal constant BOUGHT = 4_000e18;

    address internal timelockOwner;

    function setUp() public {
        _deployTransition();
        timelockOwner = makeAddr("timelockOwner");
        _approveMigrator(alice);
        _approveMigrator(bob);
    }

    // ──────────────────────── Who may call ─────────────────────

    function test_Access_TheThreeEntriesRefuseEveryoneButTheReceiver() public {
        ITransitionMigrator.DeliveryLimits memory l = _limits();
        ITransitionMigrator.DeliveryVoucher memory v = _dv(alice, R1, P, R);
        // owner and operator (the harness), the voucher signer, the holder, the deliverer, a stranger.
        address[6] memory callers = [address(this), migratorSigner, alice, deliverer, stranger, address(poolV3)];
        for (uint256 i = 0; i < callers.length; ++i) {
            bytes memory err = abi.encodeWithSelector(
                StakingMigratorBase.NotTransitionReceiver.selector, callers[i], address(receiver)
            );
            vm.startPrank(callers[i]);
            vm.expectRevert(err);
            migrator.compoundFor(alice, P, R, l, v);
            vm.expectRevert(err);
            migrator.moveToLpFor(alice, P, R, l, v);
            vm.expectRevert(err);
            migrator.claimRestakeFor(alice, P, l, v);
            vm.stopPrank();
        }
    }

    function test_Access_TheModuleCalledDirectlyRefusesEveryone() public {
        StakingMigratorDeliveries module =
            new StakingMigratorDeliveries(address(mathVault), address(usdcToken), address(asset));
        ITransitionMigrator.DeliveryLimits memory l = _limits();
        ITransitionMigrator.DeliveryVoucher memory v = _dv(alice, R3, P, 0);
        vm.prank(address(receiver));
        vm.expectRevert(
            abi.encodeWithSelector(StakingMigratorBase.NotTransitionReceiver.selector, address(receiver), address(0))
        );
        module.claimRestakeFor(alice, P, l, v);
    }

    function test_Access_AZeroReceiverClosesTheEntries() public {
        vm.expectEmit(address(migrator));
        emit StakingMigratorBase.TransitionReceiverSet(address(receiver), address(0));
        migrator.setTransitionReceiver(address(0));
        _payAsset(alice, R3, P);
        ITransitionMigrator.DeliveryVoucher memory v = _dv(alice, R3, P, 0);
        ITransitionMigrator.DeliveryLimits memory l = _limits();
        vm.prank(deliverer);
        vm.expectRevert(
            abi.encodeWithSelector(StakingMigratorBase.NotTransitionReceiver.selector, address(receiver), address(0))
        );
        receiver.deliver(alice, R3, l, v);
        vm.prank(alice);
        receiver.release(alice, R3); // the exit stays
    }

    function test_Access_SetTransitionReceiverIsOwnerOnly() public {
        _handOverMigrator();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        migrator.setTransitionReceiver(stranger);
        vm.prank(timelockOwner);
        migrator.setTransitionReceiver(stranger);
        assertEq(migrator.transitionReceiver(), stranger);
    }

    function test_Access_SetSwapLimitBpsIsOperatorOnlyTheOwnerIsRefused() public {
        _handOverMigrator();
        vm.prank(timelockOwner);
        vm.expectRevert(abi.encodeWithSelector(StakingMigratorBase.NotOperator.selector, timelockOwner, address(this)));
        migrator.setSwapLimitBps(500);
        vm.prank(deliverer);
        vm.expectRevert(abi.encodeWithSelector(StakingMigratorBase.NotOperator.selector, deliverer, address(this)));
        migrator.setSwapLimitBps(500);
        vm.expectEmit(address(migrator));
        emit StakingMigratorBase.SwapLimitSet(300, 500);
        migrator.setSwapLimitBps(500);
        assertEq(migrator.swapLimitBps(), 500);
    }

    function test_SwapLimit_BoundsAreOneToOneThousand() public {
        vm.expectRevert(abi.encodeWithSelector(StakingMigratorBase.InvalidSwapLimit.selector, uint16(0), uint16(1000)));
        migrator.setSwapLimitBps(0);
        vm.expectRevert(
            abi.encodeWithSelector(StakingMigratorBase.InvalidSwapLimit.selector, uint16(1001), uint16(1000))
        );
        migrator.setSwapLimitBps(1001);
        migrator.setSwapLimitBps(1);
        migrator.setSwapLimitBps(1000);
        assertEq(migrator.MAX_SWAP_LIMIT_BPS(), 1000);
    }

    // ──────────────────────── initializeTransition and upgrade ─

    function test_InitializeTransition_OwnerOnlyNonZeroAndOnce() public {
        StakingMigrator fresh =
            _deployMigrator(address(mathVault), address(usdcToken), address(asset), poolV3, bonusVault);
        assertEq(fresh.transitionReceiver(), address(0));
        assertEq(fresh.swapLimitBps(), 0);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        fresh.initializeTransition(address(receiver));
        vm.expectRevert(StakingMigratorBase.ZeroAddress.selector);
        fresh.initializeTransition(address(0));

        vm.expectEmit(address(fresh));
        emit StakingMigratorBase.TransitionReceiverSet(address(0), address(receiver));
        vm.expectEmit(address(fresh));
        emit StakingMigratorBase.SwapLimitSet(0, 300);
        fresh.initializeTransition(address(receiver));
        assertEq(fresh.transitionReceiver(), address(receiver));
        assertEq(fresh.swapLimitBps(), 300);

        vm.expectRevert(Initializable.InvalidInitialization.selector);
        fresh.initializeTransition(stranger);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        migrator.initializeTransition(stranger);
    }

    function test_Upgrade_UpgradeToAndCallRunsInitializeTransitionAndKeepsTheState() public {
        // A live v1 migrator with a direct transition already made.
        StakingMigrator live =
            _deployMigrator(address(mathVault), address(usdcToken), address(asset), poolV3, bonusVault);
        poolV3.setMigrator(address(live));
        bonusVault.setMigrator(address(live));
        mathVault.setStakeOperator(address(live), true);
        live.unpauseCompound();
        live.setRates(900, 800, 400);
        vm.startPrank(bob);
        asset.approve(address(live), type(uint256).max);
        live.claimRestake(1_000e18, FAR_DEADLINE, _noPermit(), _voucher(live, bob, 3, 1_000e18, 0, 5));
        vm.stopPrank();

        TransitionReceiver r = _deployReceiver(live, address(this), deliverer);
        address newImpl = address(new StakingMigrator(address(mathVault), address(usdcToken), address(asset)));
        live.upgradeToAndCall(newImpl, abi.encodeCall(StakingMigrator.initializeTransition, (address(r))));

        assertEq(live.transitionReceiver(), address(r));
        assertEq(live.swapLimitBps(), 300);
        assertTrue(live.migrated(bob), "migrated survives");
        assertTrue(live.isNonceUsed(bob, 5), "the used nonce survives");
        assertEq(live.compoundBps(), 900);
        assertEq(live.lpBps(), 800);
        assertEq(live.restakeBps(), 400);
        assertEq(live.signer(), migratorSigner);
        assertEq(live.stakingPool(), address(poolV3));
        assertFalse(live.compoundPaused());
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        live.initializeTransition(address(r));

        // The upgraded proxy delivers through its receiver.
        asset.transfer(r.receivingAddressOf(alice, R3), P);
        bytes32 digest = live.deliveryVoucherDigest(alice, R3, P, 0, P, 0, block.timestamp - 1, 0, FAR_DEADLINE);
        (uint8 sv, bytes32 rr, bytes32 ss) = vm.sign(migratorSignerPk, digest);
        ITransitionMigrator.DeliveryVoucher memory v = ITransitionMigrator.DeliveryVoucher({
            route: R3,
            eligiblePrincipal: P,
            eligibleReward: 0,
            assetLimit: P,
            usdcLimit: 0,
            burnTime: block.timestamp - 1,
            nonce: 0,
            deadline: FAR_DEADLINE,
            signature: abi.encodePacked(rr, ss, sv)
        });
        vm.prank(alice);
        r.deliver(alice, R3, _limits(), v);
        assertEq(poolV3.stakes(alice), P);
    }

    /// @dev Every field of the layout before 2026-11-20 keeps its slot; the three appended fields
    ///      follow `migrated`.
    function test_Storage_EveryFieldKeepsItsSlot() public {
        bytes32 base = 0xa846ed032583543a4fbe67f8b477f1a29883d2f8c76050d7d3635994b7226e00;
        assertEq(
            base,
            keccak256(abi.encode(uint256(keccak256("real.staking.storage.StakingMigrator")) - 1))
                & ~bytes32(uint256(0xff))
        );
        // A direct transition and a delivery, so both mappings hold something.
        StakingMigrator.Voucher memory direct = _voucher(migrator, bob, 3, 1_000e18, 0, 9);
        vm.prank(bob);
        migrator.claimRestake(1_000e18, FAR_DEADLINE, _noPermit(), direct);
        _payAsset(alice, R3, P);
        _deliver(alice, R3, _dv(alice, R3, P, 0));
        migrator.setSwapLimitBps(450);

        address m = address(migrator);
        assertEq(address(uint160(uint256(vm.load(m, base)))), address(poolV3), "slot 0: stakingPool");
        assertEq(address(uint160(uint256(vm.load(m, _slot(base, 1))))), address(bonusVault), "slot 1: bonusVault");
        uint256 s2 = uint256(vm.load(m, _slot(base, 2)));
        assertEq(address(uint160(s2)), migratorSigner, "slot 2: signer");
        assertEq(uint16(s2 >> 160), 1000, "slot 2: compoundBps");
        assertEq(uint16(s2 >> 176), 1000, "slot 2: lpBps");
        assertEq(uint16(s2 >> 192), 500, "slot 2: restakeBps");
        assertEq(uint8(s2 >> 208), 0, "slot 2: compoundPaused");
        assertEq(uint32(s2 >> 216), VALUATION_WINDOW, "slot 2: valuationWindow");
        bytes32 usedNonce = keccak256(abi.encode(uint256(9), keccak256(abi.encode(bob, _slot(base, 3)))));
        assertEq(uint256(vm.load(m, usedNonce)), 1, "slot 3: usedNonces[bob][9]");
        assertEq(uint256(vm.load(m, keccak256(abi.encode(bob, _slot(base, 4))))), 1, "slot 4: migrated[bob]");
        uint256 s5 = uint256(vm.load(m, _slot(base, 5)));
        assertEq(address(uint160(s5)), address(receiver), "slot 5: transitionReceiver");
        assertEq(uint16(s5 >> 160), 450, "slot 5: swapLimitBps");
        bytes32 d = keccak256(abi.encode(alice, _slot(base, 6)));
        assertEq(uint8(uint256(vm.load(m, d))), R3, "slot 6: deliveries[alice].route");
        assertEq(uint256(vm.load(m, _slot(d, 2))), P, "deliveries[alice].principalDelivered");
        assertEq(uint256(vm.load(m, _slot(d, 4))), 1, "deliveries[alice].nextNonce");
    }

    function _slot(bytes32 base, uint256 n) internal pure returns (bytes32) {
        return bytes32(uint256(base) + n);
    }

    // ──────────────────────── The check order ──────────────────

    function test_Order_HolderZeroThenEndThenDeadline() public {
        _fundReceiver(P, R);
        ITransitionMigrator.DeliveryVoucher memory v = _dv(alice, R3, P, 0);
        vm.startPrank(address(receiver));
        vm.expectRevert(StakingMigratorBase.ZeroAddress.selector);
        migrator.claimRestakeFor(address(0), P, _limits(), v);

        ITransitionMigrator.DeliveryLimits memory late = _limits();
        late.deadline = block.timestamp - 1;
        vm.expectRevert(
            abi.encodeWithSelector(StakingMigratorBase.DeadlineExpired.selector, late.deadline, block.timestamp)
        );
        migrator.claimRestakeFor(alice, P, late, v);

        vm.warp(v3End);
        vm.expectRevert(abi.encodeWithSelector(StakingMigratorBase.StakingEnded.selector, v3End));
        migrator.claimRestakeFor(alice, P, late, v); // the end is checked before the deadline
        vm.stopPrank();
    }

    function test_Order_TheEndStopsEveryEntryAndReleaseStillWorks() public {
        _payAsset(alice, R1, P);
        _payUsdc(alice, R1, R);
        ITransitionMigrator.DeliveryVoucher memory v = _dv(alice, R1, P, R);
        vm.warp(v3End);
        ITransitionMigrator.DeliveryLimits memory l = _limits();
        vm.prank(deliverer);
        vm.expectRevert(abi.encodeWithSelector(StakingMigratorBase.StakingEnded.selector, v3End));
        receiver.deliver(alice, R1, l, v);
        vm.warp(v3End + 30 days);
        ITransitionMigrator.DeliveryVoucher memory v2 = _dv(alice, R2, P, R);
        ITransitionMigrator.DeliveryVoucher memory v3 = _dv(alice, R3, P, 0);
        vm.startPrank(address(receiver));
        vm.expectRevert(abi.encodeWithSelector(StakingMigratorBase.StakingEnded.selector, v3End));
        migrator.moveToLpFor(alice, P, R, l, v2);
        vm.expectRevert(abi.encodeWithSelector(StakingMigratorBase.StakingEnded.selector, v3End));
        migrator.claimRestakeFor(alice, P, l, v3);
        vm.stopPrank();
        vm.prank(alice);
        receiver.release(alice, R1);
        assertEq(asset.balanceOf(_at(alice, R1)), 0);
    }

    function test_Order_TheVoucherChecksEachWithItsOwnError() public {
        _fundReceiver(P, R);
        uint256 t = block.timestamp;
        ITransitionMigrator.DeliveryVoucher memory r1 = _dv(alice, R1, P, R);
        vm.startPrank(address(receiver));
        // WrongRoute
        vm.expectRevert(abi.encodeWithSelector(StakingMigratorBase.WrongRoute.selector, R3, R1));
        migrator.claimRestakeFor(alice, P, _limits(), r1);
        // VoucherExpired
        ITransitionMigrator.DeliveryVoucher memory v = _dvFull(migratorSignerPk, alice, R3, P, 0, P, 0, t - 1, 0, t - 1);
        vm.expectRevert(abi.encodeWithSelector(StakingMigratorBase.VoucherExpired.selector, t - 1, t));
        migrator.claimRestakeFor(alice, P, _limits(), v);
        // InvalidDeliveryLimits: the asset limit, then the USDC limit
        v = _dvAt(alice, R3, P, 0, P + 1, 0, t - 1);
        vm.expectRevert(abi.encodeWithSelector(StakingMigratorBase.InvalidDeliveryLimits.selector, P + 1, P, 0, 0));
        migrator.claimRestakeFor(alice, P, _limits(), v);
        v = _dvAt(alice, R1, P, R, P, R + 1, t - 1);
        vm.expectRevert(abi.encodeWithSelector(StakingMigratorBase.InvalidDeliveryLimits.selector, P, P, R + 1, R));
        migrator.compoundFor(alice, P, R, _limits(), v);
        // InvalidBurnTime: zero and in the future
        v = _dvAt(alice, R3, P, 0, P, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(StakingMigratorBase.InvalidBurnTime.selector, 0));
        migrator.claimRestakeFor(alice, P, _limits(), v);
        v = _dvAt(alice, R3, P, 0, P, 0, t + 1);
        vm.expectRevert(abi.encodeWithSelector(StakingMigratorBase.InvalidBurnTime.selector, t + 1));
        migrator.claimRestakeFor(alice, P, _limits(), v);
        // DeliveryNonceMismatch
        v = _dvFull(migratorSignerPk, alice, R3, P, 0, P, 0, t, 1, FAR_DEADLINE);
        vm.expectRevert(abi.encodeWithSelector(StakingMigratorBase.DeliveryNonceMismatch.selector, alice, 0, 1));
        migrator.claimRestakeFor(alice, P, _limits(), v);
        // PrincipalExceedsEligible / RewardExceedsEligible (against the voucher's limit)
        v = _dvAt(alice, R3, P, 0, P - 1, 0, t);
        vm.expectRevert(abi.encodeWithSelector(StakingMigratorBase.PrincipalExceedsEligible.selector, P, P - 1));
        migrator.claimRestakeFor(alice, P, _limits(), v);
        v = _dvAt(alice, R1, P, R, P, R - 1, t);
        vm.expectRevert(abi.encodeWithSelector(StakingMigratorBase.RewardExceedsEligible.selector, R, R - 1));
        migrator.compoundFor(alice, P, R, _limits(), v);
        // InvalidVoucherSignature: another key, another holder's voucher, another chain
        v = _dvFull(voucherSignerPk, alice, R3, P, 0, P, 0, t, 0, FAR_DEADLINE);
        vm.expectRevert(StakingMigratorBase.InvalidVoucherSignature.selector);
        migrator.claimRestakeFor(alice, P, _limits(), v);
        v = _dv(bob, R3, P, 0);
        vm.expectRevert(StakingMigratorBase.InvalidVoucherSignature.selector);
        migrator.claimRestakeFor(alice, P, _limits(), v);
        v = _dv(alice, R3, P, 0);
        uint256 chain = block.chainid;
        vm.chainId(43113);
        vm.expectRevert(StakingMigratorBase.InvalidVoucherSignature.selector);
        migrator.claimRestakeFor(alice, P, _limits(), v);
        vm.chainId(chain);
        v.signature = hex"1234";
        vm.expectRevert(StakingMigratorBase.InvalidVoucherSignature.selector);
        migrator.claimRestakeFor(alice, P, _limits(), v);
        vm.stopPrank();
    }

    function test_Order_AmountRulesComeBeforeTheVoucher() public {
        _fundReceiver(P, R);
        // An invalid voucher (wrong route): the amount rule still reports first.
        ITransitionMigrator.DeliveryVoucher memory wrong = _dv(alice, R3, P, 0);
        vm.startPrank(address(receiver));
        vm.expectRevert(StakingMigratorBase.UsdcNotArrived.selector);
        migrator.compoundFor(alice, P, 0, _limits(), wrong);
        vm.expectRevert(StakingMigratorBase.AssetNotArrived.selector);
        migrator.compoundFor(alice, 0, R, _limits(), wrong);
        vm.expectRevert(StakingMigratorBase.UsdcNotArrived.selector);
        migrator.moveToLpFor(alice, P, 0, _limits(), wrong);
        vm.expectRevert(StakingMigratorBase.AssetNotArrived.selector);
        migrator.moveToLpFor(alice, 0, R, _limits(), wrong);
        vm.expectRevert(StakingMigratorBase.ZeroAmount.selector);
        migrator.claimRestakeFor(alice, 0, _limits(), wrong);
        vm.stopPrank();
    }

    function test_Voucher_EffectsComeBeforeTheTokensMove() public {
        _payAsset(alice, R3, P);
        uint256 burnTime = block.timestamp - 3;
        ITransitionMigrator.DeliveryVoucher memory v = _dvAt(alice, R3, P, 0, P, 0, burnTime);
        vm.recordLogs();
        _deliver(alice, R3, v);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool used;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter != address(migrator)) continue;
            assertTrue(logs[i].topics[0] != StakingMigratorBase.VoucherUsed.selector, "VoucherUsed is not emitted");
            assertTrue(
                logs[i].topics[0] != StakingMigratorBase.ClaimRestaked.selector, "the direct event is not emitted"
            );
            if (logs[i].topics[0] == StakingMigratorBase.DeliveryVoucherUsed.selector) {
                assertEq(logs[i].topics[1], bytes32(uint256(uint160(alice))));
                (uint256 n, uint8 rt, uint256 bt) = abi.decode(logs[i].data, (uint256, uint8, uint256));
                assertEq(n, 0);
                assertEq(rt, R3);
                assertEq(bt, burnTime);
                used = true;
            }
        }
        assertTrue(used, "DeliveryVoucherUsed");
        (uint8 route, bool lpCreated, uint256 tokenId, uint256 pd, uint256 rd, uint256 nonce) =
            migrator.deliveryOf(alice);
        assertEq(route, R3);
        assertFalse(lpCreated);
        assertEq(tokenId, 0);
        assertEq(pd, P);
        assertEq(rd, 0);
        assertEq(nonce, 1);
        assertTrue(migrator.migrated(alice));
    }

    function test_Voucher_ASpentVoucherNeverRunsAgain() public {
        _payAsset(alice, R3, 2 * P);
        ITransitionMigrator.DeliveryVoucher memory v = _dvAt(alice, R3, 2 * P, 0, P, 0, block.timestamp - 1);
        _deliver(alice, R3, v);
        // The replay still has balance and limit left at the address, but its nonce is spent.
        v.assetLimit = P; // unchanged, for clarity
        ITransitionMigrator.DeliveryLimits memory l = _limits();
        vm.prank(deliverer);
        vm.expectRevert(abi.encodeWithSelector(TransitionReceiver.NothingToDeliver.selector, alice, R3));
        receiver.deliver(alice, R3, l, v); // the limit is used up: nothing left to hand over
        // With a higher limit the old nonce is refused by the migrator.
        ITransitionMigrator.DeliveryVoucher memory old =
            _dvFull(migratorSignerPk, alice, R3, 2 * P, 0, 2 * P, 0, block.timestamp - 1, 0, FAR_DEADLINE);
        vm.prank(deliverer);
        vm.expectRevert(abi.encodeWithSelector(StakingMigratorBase.DeliveryNonceMismatch.selector, alice, 1, 0));
        receiver.deliver(alice, R3, l, old);
        // Two vouchers for the same position: the first one wins, the second is refused.
        ITransitionMigrator.DeliveryVoucher memory a = _dvAt(alice, R3, 2 * P, 0, P + 1e18, 0, block.timestamp - 1);
        ITransitionMigrator.DeliveryVoucher memory b = _dvAt(alice, R3, 2 * P, 0, P + 2e18, 0, block.timestamp - 1);
        _deliver(alice, R3, a);
        vm.prank(deliverer);
        vm.expectRevert(abi.encodeWithSelector(StakingMigratorBase.DeliveryNonceMismatch.selector, alice, 2, 1));
        receiver.deliver(alice, R3, l, b);
        (uint256 pd,, uint256 nonce) = _delivered(alice);
        assertEq(pd, P + 1e18);
        assertEq(nonce, 2);
    }

    // ──────────────────────── One option per wallet ────────────

    function test_OneOption_AFirstDeliveryAfterADirectEntryReverts() public {
        StakingMigrator.Voucher memory direct = _voucher(migrator, alice, 3, 1_000e18, 0, 1);
        vm.prank(alice);
        migrator.claimRestake(1_000e18, FAR_DEADLINE, _noPermit(), direct);
        _payAsset(alice, R3, P);
        ITransitionMigrator.DeliveryVoucher memory v = _dv(alice, R3, P, 0);
        ITransitionMigrator.DeliveryLimits memory l = _limits();
        vm.prank(deliverer);
        vm.expectRevert(abi.encodeWithSelector(StakingMigratorBase.AlreadyMigrated.selector, alice));
        receiver.deliver(alice, R3, l, v);
        vm.prank(alice);
        receiver.release(alice, R3);
        assertEq(asset.balanceOf(_at(alice, R3)), 0, "the tokens wait for release");
    }

    function test_OneOption_ADirectEntryAfterADeliveryReverts() public {
        _payAsset(alice, R3, P);
        _deliver(alice, R3, _dv(alice, R3, P, 0));
        StakingMigrator.Voucher memory d3 = _voucher(migrator, alice, 3, 1e18, 0, 1);
        StakingMigrator.Voucher memory d1 = _voucher(migrator, alice, 1, 0, R, 2);
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(StakingMigratorBase.AlreadyMigrated.selector, alice));
        migrator.claimRestake(1e18, FAR_DEADLINE, _noPermit(), d3);
        vm.expectRevert(abi.encodeWithSelector(StakingMigratorBase.AlreadyMigrated.selector, alice));
        migrator.compound(R, 0, 1, FAR_DEADLINE, _noPermit(), _noPermit(), d1);
        vm.stopPrank();
    }

    function test_OneOption_AnotherRouteThanTheStoredOneReverts() public {
        _payAsset(alice, R3, P);
        _deliver(alice, R3, _dv(alice, R3, P, 0));
        // Tokens at alice's route-1 address with a route-1 voucher: the stored route is 3.
        _payAsset(alice, R1, P);
        _payUsdc(alice, R1, R);
        ITransitionMigrator.DeliveryVoucher memory v = _dv(alice, R1, P, R);
        ITransitionMigrator.DeliveryLimits memory l = _limits();
        vm.prank(deliverer);
        vm.expectRevert(abi.encodeWithSelector(StakingMigratorBase.RouteMismatch.selector, alice, R3, R1));
        receiver.deliver(alice, R1, l, v);
        // A voucher of another route at the route-3 address.
        _payAsset(alice, R3, 1e18);
        ITransitionMigrator.DeliveryVoucher memory other = _dvAt(alice, R1, 2 * P, R, 2 * P, R, block.timestamp - 1);
        vm.prank(deliverer);
        vm.expectRevert(abi.encodeWithSelector(StakingMigratorBase.WrongRoute.selector, R3, R1));
        receiver.deliver(alice, R3, l, other);
    }

    // ──────────────────────── Route 1: compound ────────────────

    function test_Compound_FirstDeliverySwapsAndStakesForTheHolder() public {
        _payAsset(alice, R1, P);
        _payUsdc(alice, R1, R);
        uint256 burnTime = block.timestamp - 60;
        ITransitionMigrator.DeliveryVoucher memory v = _dvAt(alice, R1, P, R, P, R, burnTime);
        uint256 valued = migrator.usdcInAsset(R);
        uint256 bonus = (P + (BOUGHT < valued ? BOUGHT : valued)) * 1000 / 10_000;

        vm.expectEmit(address(migrator));
        emit StakingMigratorBase.TransitionDelivered(alice, R1, 0, burnTime, P, R, BOUGHT, P + BOUGHT, 0, 0, bonus);
        ITransitionMigrator.DeliveryResult memory r = _deliver(alice, R1, v);

        assertEq(r.staked, P + BOUGHT);
        assertEq(r.assetBought, BOUGHT);
        assertEq(r.v3Bonus, bonus);
        assertEq(poolV3.stakes(alice), P + BOUGHT);
        assertEq(_v3Reserved(alice), bonus);
        assertEq(routerMock.lastAmountOutMinimum(), valued * 9700 / 10_000, "the 3 % floor");
        (uint256 pd, uint256 rd, uint256 nonce) = _delivered(alice);
        assertEq(pd, P);
        assertEq(rd, R);
        assertEq(nonce, 1);
    }

    function test_Compound_TheFloorAtOneThousandAndAtOneBasisPoint() public {
        migrator.setSwapLimitBps(1000);
        _payAsset(alice, R1, P);
        _payUsdc(alice, R1, R);
        _deliver(alice, R1, _dv(alice, R1, P, R));
        uint256 valued = migrator.usdcInAsset(R);
        assertEq(routerMock.lastAmountOutMinimum(), valued * 9000 / 10_000);

        migrator.setSwapLimitBps(1);
        _payAsset(bob, R1, P);
        _payUsdc(bob, R1, R);
        _deliver(bob, R1, _dv(bob, R1, P, R));
        assertEq(routerMock.lastAmountOutMinimum(), valued * 9999 / 10_000);
    }

    function test_Compound_TheCallersHigherMinimumWins() public {
        _payAsset(alice, R1, P);
        _payUsdc(alice, R1, R);
        ITransitionMigrator.DeliveryLimits memory l = _limits();
        l.minAssetOut = 3_999e18;
        ITransitionMigrator.DeliveryVoucher memory v = _dv(alice, R1, P, R);
        vm.prank(deliverer);
        receiver.deliver(alice, R1, l, v);
        assertEq(routerMock.lastAmountOutMinimum(), 3_999e18);
    }

    function test_Compound_ASwapBelowTheFloorRevertsAndTheTokensWait() public {
        routerMock.setRate(address(usdcToken), address(asset), 3.8e18, 1e6); // 5 % below the TWAP
        _payAsset(alice, R1, P);
        _payUsdc(alice, R1, R);
        ITransitionMigrator.DeliveryVoucher memory v = _dv(alice, R1, P, R);
        ITransitionMigrator.DeliveryLimits memory l = _limits();
        vm.prank(deliverer);
        vm.expectRevert(bytes("Too little received"));
        receiver.deliver(alice, R1, l, v);
        assertEq(asset.balanceOf(_at(alice, R1)), P, "the $ASSET waits");
        assertEq(usdcToken.balanceOf(_at(alice, R1)), R, "the USDC waits");

        // The operator raises the limit for this holder; the retry passes.
        migrator.setSwapLimitBps(600);
        vm.prank(deliverer);
        receiver.deliver(alice, R1, l, v);
        assertEq(poolV3.stakes(alice), P + 3_800e18);
        // The bonus never counts more than the TWAP value of the USDC, nor more than was bought.
        assertEq(_v3Reserved(alice), (P + 3_800e18) * 1000 / 10_000);
    }

    function test_Compound_ThePauseStopsUsdcButNotAnAssetTopUp() public {
        migrator.pauseCompound();
        _payAsset(alice, R1, P);
        _payUsdc(alice, R1, R);
        ITransitionMigrator.DeliveryVoucher memory v = _dv(alice, R1, P, R);
        ITransitionMigrator.DeliveryLimits memory l = _limits();
        vm.prank(deliverer);
        vm.expectRevert(StakingMigratorBase.CompoundIsPaused.selector);
        receiver.deliver(alice, R1, l, v);
        migrator.unpauseCompound();
        _deliver(alice, R1, v);

        migrator.pauseCompound();
        uint256 swaps = routerMock.swapCalls();
        _payAsset(alice, R1, 1_000e18);
        _deliver(alice, R1, _dvAt(alice, R1, P + 1_000e18, R, P + 1_000e18, R, block.timestamp - 1));
        assertEq(routerMock.swapCalls(), swaps, "no swap without USDC");
        assertEq(poolV3.stakes(alice), P + BOUGHT + 1_000e18);

        _payUsdc(alice, R1, 10e6);
        v = _dvAt(alice, R1, P + 1_000e18, R + 10e6, P + 1_000e18, R + 10e6, block.timestamp - 1);
        vm.prank(deliverer);
        vm.expectRevert(StakingMigratorBase.CompoundIsPaused.selector);
        receiver.deliver(alice, R1, l, v);
    }

    function test_Compound_TheTwapGuardStopsUsdcButNotAnAssetTopUp() public {
        _payAsset(alice, R1, P);
        _payUsdc(alice, R1, R);
        _deliver(alice, R1, _dv(alice, R1, P, R));
        int24 far = _tk(PRICE_TICK) + int24(SWAP_DEVIATION_TICKS) + 1;
        mathPool.setCurrentTick(far);

        _payAsset(alice, R1, 1_000e18);
        _deliver(alice, R1, _dvAt(alice, R1, 2 * P, 2 * R, P + 1_000e18, R, block.timestamp - 1));

        _payUsdc(alice, R1, 10e6);
        ITransitionMigrator.DeliveryVoucher memory v =
            _dvAt(alice, R1, 2 * P, 2 * R, P + 1_000e18, R + 10e6, block.timestamp - 1);
        ITransitionMigrator.DeliveryLimits memory l = _limits();
        vm.prank(deliverer);
        vm.expectRevert(
            abi.encodeWithSelector(
                TwapGuard.TwapDeviationTooHigh.selector, far, _tk(PRICE_TICK), int24(SWAP_DEVIATION_TICKS)
            )
        );
        receiver.deliver(alice, R1, l, v);
    }

    function test_Compound_AFirstDeliveryNeedsUsdcAndAsset() public {
        _payAsset(alice, R1, P); // the burn arrived, the USDC did not (case 2)
        ITransitionMigrator.DeliveryVoucher memory v = _dv(alice, R1, P, R);
        ITransitionMigrator.DeliveryLimits memory l = _limits();
        vm.prank(deliverer);
        vm.expectRevert(StakingMigratorBase.UsdcNotArrived.selector);
        receiver.deliver(alice, R1, l, v);

        _payUsdc(bob, R1, R); // the USDC arrived, the burn did not
        ITransitionMigrator.DeliveryVoucher memory vb = _dv(bob, R1, P, R);
        vm.prank(deliverer);
        vm.expectRevert(StakingMigratorBase.AssetNotArrived.selector);
        receiver.deliver(bob, R1, l, vb);
    }

    function test_Compound_ALaterDeliveryMayBeUsdcOnlyAndNeverZero() public {
        _payAsset(alice, R1, P);
        _payUsdc(alice, R1, R);
        _deliver(alice, R1, _dvAt(alice, R1, P, 2 * R, P, R, block.timestamp - 1));
        _payUsdc(alice, R1, R);
        ITransitionMigrator.DeliveryResult memory r = _deliver(alice, R1, _dv(alice, R1, P, 2 * R));
        assertEq(r.assetBought, BOUGHT);
        assertEq(poolV3.stakes(alice), P + 2 * BOUGHT);

        _fundReceiver(1, 1);
        ITransitionMigrator.DeliveryVoucher memory v = _dv(alice, R1, P, 2 * R);
        vm.prank(address(receiver));
        vm.expectRevert(StakingMigratorBase.ZeroAmount.selector);
        migrator.compoundFor(alice, 0, 0, _limits(), v);
    }

    // ──────────────────────── Route 2: join LP ─────────────────

    function test_Lp_ThePositionWaitsForTheMatchingAssetThenComesOnce() public {
        uint256 needed = _assetNeededFor(R);
        _payUsdc(alice, R2, R);
        _payAsset(alice, R2, 1_000e18);

        // First refusal: 1,000 $ASSET arrived.
        uint256 migNeeded = _neededFromRevert(alice, 1_000e18);
        assertGe(migNeeded, needed, "never below what the position really takes");
        assertLe(migNeeded - needed, 2, "rounded up by at most a couple of wei");

        // Second part, still short: refused again.
        _payAsset(alice, R2, 2_000e18);
        assertEq(_neededFromRevert(alice, 3_000e18), migNeeded);

        // Third part: enough. ONE position, the rest in v3, the USDC dust back to alice.
        _payAsset(alice, R2, 3_000e18);
        uint256 usdc0 = usdcToken.balanceOf(alice);
        ITransitionMigrator.DeliveryResult memory r = _deliver(alice, R2, _dv(alice, R2, P, R));
        assertGt(r.lpTokenId, 0);
        assertEq(mathVault.stakerOf(r.lpTokenId), alice, "staked in the LP vault for alice");
        assertEq(mathNpm.ownerOf(r.lpTokenId), address(mathVault));
        assertEq(r.assetToLp + r.staked, 6_000e18);
        assertEq(poolV3.stakes(alice), r.staked);
        assertEq(usdcToken.balanceOf(alice) - usdc0, R - r.usdcToLp, "the dust is refunded to the holder");
        _assertLpRecord(alice, r);
    }

    function _assertLpRecord(address holder, ITransitionMigrator.DeliveryResult memory r) internal view {
        uint256 lpBonus = (r.assetToLp + migrator.usdcInAsset(r.usdcToLp)) * 1000 / 10_000;
        assertEq(r.lpBonus, lpBonus);
        (address user, uint256 amount,,,) = bonusVault.lpReservation(r.lpTokenId);
        assertEq(user, holder);
        assertEq(amount, lpBonus);
        assertEq(r.v3Bonus, r.staked * 1000 / 10_000);
        (uint8 route, bool lpCreated, uint256 tokenId,, uint256 rd,) = migrator.deliveryOf(holder);
        assertEq(route, R2);
        assertTrue(lpCreated);
        assertEq(tokenId, r.lpTokenId);
        assertEq(rd, R, "the refunded dust counts as taken");
    }

    function test_Lp_TwoTopUpsGoToTestnetStakingNeverIntoThePosition() public {
        _payUsdc(alice, R2, R);
        _payAsset(alice, R2, P);
        _deliver(alice, R2, _dv(alice, R2, 2 * P, R));
        uint256 staked0 = poolV3.stakes(alice);
        _payAsset(alice, R2, 1_000e18);
        ITransitionMigrator.DeliveryResult memory t1 = _deliver(alice, R2, _dv(alice, R2, 2 * P, R));
        _payAsset(alice, R2, 500e18);
        ITransitionMigrator.DeliveryResult memory t2 = _deliver(alice, R2, _dv(alice, R2, 2 * P, R));
        assertEq(t1.lpTokenId, 0);
        assertEq(t2.lpTokenId, 0);
        assertEq(poolV3.stakes(alice), staked0 + 1_500e18);
        assertEq(t1.v3Bonus, 100e18);
        assertEq(t2.v3Bonus, 50e18);
        assertEq(bonusVault.lpTokensOf(alice).length, 1, "exactly one position");
    }

    function test_Lp_LaterUsdcIsNeverTaken() public {
        _payUsdc(alice, R2, R);
        _payAsset(alice, R2, P);
        _deliver(alice, R2, _dv(alice, R2, 2 * P, 2 * R));
        _payUsdc(alice, R2, 50e6);
        _payAsset(alice, R2, 1e18);
        _deliver(alice, R2, _dv(alice, R2, 2 * P, 2 * R));
        assertEq(usdcToken.balanceOf(_at(alice, R2)), 50e6, "the USDC waits for release");

        _fundReceiver(1e18, 1e6);
        ITransitionMigrator.DeliveryVoucher memory vu = _dv(alice, R2, 2 * P, 2 * R);
        ITransitionMigrator.DeliveryLimits memory l = _limits();
        vm.startPrank(address(receiver));
        vm.expectRevert(StakingMigratorBase.UsdcNotAccepted.selector);
        migrator.moveToLpFor(alice, 1e18, 1e6, l, vu);
        vm.expectRevert(StakingMigratorBase.ZeroAmount.selector);
        migrator.moveToLpFor(alice, 0, 0, l, vu);
        vm.stopPrank();
    }

    function _neededFromRevert(address holder, uint256 arrived) internal returns (uint256 needed) {
        ITransitionMigrator.DeliveryVoucher memory v = _dv(holder, R2, P, R);
        ITransitionMigrator.DeliveryLimits memory l = _limits();
        vm.prank(deliverer);
        try receiver.deliver(holder, R2, l, v) {
            revert("expected MatchingAssetNotArrived");
        } catch (bytes memory err) {
            bytes4 sel;
            assembly {
                sel := mload(add(err, 32))
            }
            assertEq(sel, StakingMigratorBase.MatchingAssetNotArrived.selector);
            uint256 got;
            assembly {
                needed := mload(add(err, 36))
                got := mload(add(err, 68))
            }
            assertEq(got, arrived);
        }
    }

    function test_Lp_FirstDeliveryPausedAndGuardedLaterPartsNever() public {
        _payUsdc(alice, R2, R);
        _payAsset(alice, R2, P);
        ITransitionMigrator.DeliveryVoucher memory v = _dv(alice, R2, P, R);
        ITransitionMigrator.DeliveryLimits memory l = _limits();
        migrator.pauseCompound();
        vm.prank(deliverer);
        vm.expectRevert(StakingMigratorBase.CompoundIsPaused.selector);
        receiver.deliver(alice, R2, l, v);
        migrator.unpauseCompound();
        int24 far = _tk(PRICE_TICK) - int24(SWAP_DEVIATION_TICKS) - 1;
        mathPool.setCurrentTick(far);
        vm.prank(deliverer);
        vm.expectRevert(
            abi.encodeWithSelector(
                TwapGuard.TwapDeviationTooHigh.selector, far, _tk(PRICE_TICK), int24(SWAP_DEVIATION_TICKS)
            )
        );
        receiver.deliver(alice, R2, l, v);
        mathPool.setCurrentTick(_tk(PRICE_TICK));
        _deliver(alice, R2, v);

        migrator.pauseCompound();
        mathPool.setCurrentTick(far);
        _payAsset(alice, R2, 1_000e18);
        _deliver(alice, R2, _dvAt(alice, R2, 2 * P, R, P + 1_000e18, R, block.timestamp - 1));
    }

    function test_Lp_TheMintMinimumsOfTheLimitsApply() public {
        _payUsdc(alice, R2, R);
        _payAsset(alice, R2, P);
        ITransitionMigrator.DeliveryLimits memory l = _limits();
        (l.amount0Min, l.amount1Min) = (type(uint128).max, 0);
        ITransitionMigrator.DeliveryVoucher memory v = _dv(alice, R2, P, R);
        vm.prank(deliverer);
        vm.expectRevert(bytes("Price slippage check"));
        receiver.deliver(alice, R2, l, v);
    }

    // ──────────────────────── Route 3 and parts ────────────────

    function test_Parts_ThreePartsAsOneDeliveryAndTwoTopUpsStakeTheSum() public {
        migrator.pauseCompound(); // route 3 is never paused
        uint256[3] memory parts = [uint256(9_000e18), 6_000e18, 5_000e18];
        uint256 sum;
        for (uint256 i = 0; i < 3; ++i) {
            _payAsset(alice, R3, parts[i]);
            ITransitionMigrator.DeliveryResult memory r = _deliver(alice, R3, _dv(alice, R3, P, 0));
            sum += parts[i];
            assertEq(r.staked, parts[i]);
            assertEq(r.v3Bonus, parts[i] * 500 / 10_000, "5 % of what this delivery staked");
        }
        assertEq(poolV3.stakes(alice), sum);
        assertEq(_v3Reserved(alice), sum * 500 / 10_000);
        (uint256 pd,, uint256 nonce) = _delivered(alice);
        assertEq(pd, P);
        assertEq(nonce, 3);
        // A fourth part above the eligible amount stays at the address.
        _payAsset(alice, R3, 1e18);
        ITransitionMigrator.DeliveryVoucher memory v = _dv(alice, R3, P, 0);
        ITransitionMigrator.DeliveryLimits memory l = _limits();
        vm.prank(deliverer);
        vm.expectRevert(abi.encodeWithSelector(TransitionReceiver.NothingToDeliver.selector, alice, R3));
        receiver.deliver(alice, R3, l, v);
    }

    function test_Parts_TokensAtAnotherHoldersAddressBelongToHim() public {
        _payAsset(bob, R3, P + 1e18); // sent to bob's address
        _deliver(bob, R3, _dv(bob, R3, P, 0));
        assertEq(poolV3.stakes(bob), P);
        assertEq(poolV3.stakes(alice), 0);
        vm.prank(bob);
        receiver.release(bob, R3);
        assertEq(asset.balanceOf(_at(bob, R3)), 0);
    }

    // ──────────────────────── The bonus by the burn time ───────

    function test_Bonus_RouteThreeBurnedBeforeTheCutoffEarnsTheFullRateAfterIt() public {
        uint256 cutoff = _afterTheCutoff();
        _payAsset(alice, R3, P);
        ITransitionMigrator.DeliveryResult memory r3 = _deliver(alice, R3, _dvAt(alice, R3, P, 0, P, 0, cutoff - 1));
        assertEq(r3.v3Bonus, P * 500 / 10_000);
    }

    function test_Bonus_RouteOneBurnedBeforeTheCutoffEarnsTheFullRateAfterIt() public {
        uint256 cutoff = _afterTheCutoff();
        _payAsset(bob, R1, P);
        _payUsdc(bob, R1, R);
        ITransitionMigrator.DeliveryResult memory r1 = _deliver(bob, R1, _dvAt(bob, R1, P, R, P, R, cutoff - 1));
        uint256 valued = migrator.usdcInAsset(R);
        assertEq(r1.v3Bonus, (P + (BOUGHT < valued ? BOUGHT : valued)) * 1000 / 10_000);
    }

    function test_Bonus_RouteTwoBurnedBeforeTheCutoffEarnsBothPartsAndTheTopUp() public {
        uint256 cutoff = _afterTheCutoff();
        _payAsset(carol, R2, P);
        _payUsdc(carol, R2, R);
        ITransitionMigrator.DeliveryResult memory r2 = _deliver(carol, R2, _dvAt(carol, R2, P, R, P, R, cutoff - 1));
        assertEq(r2.lpBonus, (r2.assetToLp + migrator.usdcInAsset(r2.usdcToLp)) * 1000 / 10_000);
        assertEq(r2.v3Bonus, r2.staked * 1000 / 10_000);
        _payAsset(carol, R2, 1_000e18);
        uint256 limit = P + 1_000e18;
        ITransitionMigrator.DeliveryResult memory t =
            _deliver(carol, R2, _dvAt(carol, R2, limit, R, limit, R, cutoff - 1));
        assertEq(t.v3Bonus, 100e18);
    }

    /// @dev Moves the clock ten days past the bonus cutoff (still before the end) and returns the cutoff.
    function _afterTheCutoff() internal returns (uint256 cutoff) {
        cutoff = poolV3.bonusCutoff();
        vm.warp(cutoff + 10 days);
    }

    function test_Bonus_ABurnAtOrAfterTheCutoffEarnsNothing() public {
        uint256 cutoff = poolV3.bonusCutoff();
        vm.warp(cutoff + 10 days);
        uint256 reserved0 = bonusVault.totalReserved();
        _payAsset(alice, R3, P);
        ITransitionMigrator.DeliveryResult memory a = _deliver(alice, R3, _dvAt(alice, R3, P, 0, P, 0, cutoff));
        assertEq(a.v3Bonus, 0, "at the cutoff");
        _payAsset(alice, R3, 1e18);
        ITransitionMigrator.DeliveryResult memory b =
            _deliver(alice, R3, _dvAt(alice, R3, P + 1e18, 0, P + 1e18, 0, cutoff + 1));
        assertEq(b.v3Bonus, 0, "after the cutoff");
        _payAsset(bob, R1, P);
        _payUsdc(bob, R1, R);
        assertEq(_deliver(bob, R1, _dvAt(bob, R1, P, R, P, R, cutoff)).v3Bonus, 0);
        _payAsset(carol, R2, P);
        _payUsdc(carol, R2, R);
        ITransitionMigrator.DeliveryResult memory c = _deliver(carol, R2, _dvAt(carol, R2, P, R, P, R, cutoff));
        assertEq(c.lpBonus, 0, "no LP part");
        assertEq(c.v3Bonus, 0);
        assertEq(bonusVault.totalReserved(), reserved0, "the bonus vault was never called");
        assertEq(poolV3.stakes(alice), P + 1e18, "the stake itself happens");
    }

    function test_Bonus_ABurnBeforeTheCutoffDeliveredBeforeItToo() public {
        uint256 cutoff = poolV3.bonusCutoff();
        vm.warp(cutoff - 1);
        _payAsset(alice, R3, P);
        assertEq(_deliver(alice, R3, _dvAt(alice, R3, P, 0, P, 0, cutoff - 2)).v3Bonus, P * 500 / 10_000);
    }

    // ──────────────────────── The stolen service key ───────────

    function test_StolenKey_TheDelivererAloneMovesNothing() public {
        (, uint256 thiefPk) = makeAddrAndKey("deliverer-as-signer");
        _payAsset(alice, R3, P);
        ITransitionMigrator.DeliveryVoucher memory forged =
            _dvFull(thiefPk, alice, R3, P, 0, P, 0, block.timestamp - 1, 0, FAR_DEADLINE);
        ITransitionMigrator.DeliveryLimits memory l = _limits();
        vm.prank(deliverer);
        vm.expectRevert(StakingMigratorBase.InvalidVoucherSignature.selector);
        receiver.deliver(alice, R3, l, forged);
        assertEq(asset.balanceOf(_at(alice, R3)), P);
        vm.prank(deliverer);
        vm.expectRevert(
            abi.encodeWithSelector(TransitionReceiver.NotHolderOrOperator.selector, deliverer, alice, address(this))
        );
        receiver.release(alice, R3);
    }

    function test_StolenKey_WithBothKeysItOnlyStakesForTheHolder() public {
        _payAsset(alice, R1, P);
        _payUsdc(alice, R1, R);
        uint256 dA = asset.balanceOf(deliverer);
        uint256 dU = usdcToken.balanceOf(deliverer);
        ITransitionMigrator.DeliveryLimits memory l = _limits();
        l.minAssetOut = 0; // the thief asks for no minimum: the floor still applies
        routerMock.setRate(address(usdcToken), address(asset), 3e18, 1e6);
        ITransitionMigrator.DeliveryVoucher memory v = _dv(alice, R1, P, R);
        vm.prank(deliverer);
        vm.expectRevert(bytes("Too little received"));
        receiver.deliver(alice, R1, l, v);
        routerMock.setRate(address(usdcToken), address(asset), 4e18, 1e6);
        vm.prank(deliverer);
        receiver.deliver(alice, R1, l, v);
        assertEq(poolV3.stakes(alice), P + BOUGHT, "staked for the holder");
        assertEq(poolV3.stakes(deliverer), 0);
        assertEq(asset.balanceOf(deliverer), dA);
        assertEq(usdcToken.balanceOf(deliverer), dU);
    }

    // ──────────────────────── Re-entrancy ──────────────────────

    /// @dev A market whose $ASSET hands control to a third party on every transfer it receives
    ///      (an ERC-777-like hook). The migrator's hand-over pull lands on the migrator and fires a
    ///      call back into the migrator: into the same entry, another delivery entry, and a direct
    ///      entry. All three meet the shared transient guard.
    function test_Reentrancy_AHookTokenCannotReenterTheMigrator() public {
        (MockHookERC20 hook, StakingMigrator m) = _hookMarket();
        address evilReceiver = makeAddr("evilReceiver");
        m.initializeTransition(evilReceiver);
        hook.transfer(evilReceiver, P);
        vm.prank(evilReceiver);
        hook.approve(address(m), P);

        bytes32 digest = m.deliveryVoucherDigest(alice, R3, P, 0, P, 0, block.timestamp - 1, 0, FAR_DEADLINE);
        (uint8 sv, bytes32 sr, bytes32 ss) = vm.sign(migratorSignerPk, digest);
        ITransitionMigrator.DeliveryVoucher memory v = ITransitionMigrator.DeliveryVoucher({
            route: R3,
            eligiblePrincipal: P,
            eligibleReward: 0,
            assetLimit: P,
            usdcLimit: 0,
            burnTime: block.timestamp - 1,
            nonce: 0,
            deadline: FAR_DEADLINE,
            signature: abi.encodePacked(sr, ss, sv)
        });
        ITransitionMigrator.DeliveryLimits memory l = _limits();
        bytes[3] memory inner = [
            abi.encodeCall(StakingMigrator.claimRestakeFor, (alice, 1, l, v)),
            abi.encodeCall(StakingMigrator.compoundFor, (alice, 1, 1, l, v)),
            abi.encodeCall(StakingMigrator.claimRestake, (1, FAR_DEADLINE, _noPermit(), _voucher(m, bob, 3, 1, 0, 1)))
        ];
        for (uint256 i = 0; i < 3; ++i) {
            hook.setRecipientHook(address(m), address(m), inner[i]);
            vm.prank(evilReceiver);
            vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
            m.claimRestakeFor(alice, P, l, v);
        }
        // Without the hook the same delivery goes through: the guard, not the voucher, refused it.
        hook.setRecipientHook(address(m), address(0), "");
        vm.prank(evilReceiver);
        m.claimRestakeFor(alice, P, l, v);
    }

    /// @dev The flipped rung's recipe with a hook token as $ASSET.
    function _hookMarket() internal returns (MockHookERC20 hook, StakingMigrator m) {
        hook = new MockHookERC20("Hook asset", "HOOK", 1e30, 18);
        (address t0, address t1) = address(hook) < address(usdcToken)
            ? (address(hook), address(usdcToken))
            : (address(usdcToken), address(hook));
        int24 tick = address(hook) < address(usdcToken) ? PRICE_TICK : -PRICE_TICK;
        MockUniswapV3Pool p = new MockUniswapV3Pool(t0, t1, MATH_FEE);
        p.setTicks(tick, tick);
        p.setSqrtPriceX96(TickMath.getSqrtRatioAtTick(tick));
        MockMathPositionManager npm = new MockMathPositionManager(address(p));
        VaultProxyParams memory params =
            _vaultParams(address(npm), address(p), t0, t1, address(routerMock), address(this), MIN_TWAP_WINDOW, 500);
        params.fee = MATH_FEE;
        LPStakingVault v = _deployVaultProxy(params);
        WeightedStakingPoolV3 pool3 = _deployPoolV3(address(hook), v3Start, v3End);
        V3BonusVault bonus = _deployBonusVault(address(hook), address(0), address(pool3), address(v));
        m = _deployMigrator(address(v), address(usdcToken), address(hook), pool3, bonus);
        _wireV3(v, pool3, bonus, m);
    }

    // ──────────────────────── Gas ──────────────────────────────

    function test_Gas_DeliverPerRouteAndRelease() public {
        _payAsset(alice, R1, P);
        _payUsdc(alice, R1, R);
        _payAsset(bob, R2, P);
        _payUsdc(bob, R2, R);
        _payAsset(carol, R3, P);
        ITransitionMigrator.DeliveryVoucher memory v1 = _dv(alice, R1, P, R);
        ITransitionMigrator.DeliveryVoucher memory v2 = _dv(bob, R2, P, R);
        ITransitionMigrator.DeliveryVoucher memory v3 = _dv(carol, R3, 2 * P, 0);
        ITransitionMigrator.DeliveryLimits memory l = _limits();

        vm.prank(deliverer);
        uint256 g = gasleft();
        receiver.deliver(alice, R1, l, v1);
        console.log("gas deliver route 1, first (holder placed, swap, stake, bonus):", g - gasleft());
        vm.prank(deliverer);
        g = gasleft();
        receiver.deliver(bob, R2, l, v2);
        console.log("gas deliver route 2, first (holder placed, mint, LP stake, v3 stake, bonuses):", g - gasleft());
        vm.prank(deliverer);
        g = gasleft();
        receiver.deliver(carol, R3, l, v3);
        console.log("gas deliver route 3, first (holder placed, stake, bonus):", g - gasleft());
        _payAsset(carol, R3, 1_000e18);
        ITransitionMigrator.DeliveryVoucher memory v3b = _dv(carol, R3, 2 * P, 0);
        vm.prank(deliverer);
        g = gasleft();
        receiver.deliver(carol, R3, l, v3b);
        console.log("gas deliver route 3, top-up (holder already placed):", g - gasleft());
        _payAsset(bob, R2, 1_000e18);
        ITransitionMigrator.DeliveryVoucher memory v2b = _dv(bob, R2, 2 * P, R);
        vm.prank(deliverer);
        g = gasleft();
        receiver.deliver(bob, R2, l, v2b);
        console.log("gas deliver route 2, top-up:", g - gasleft());

        _payAsset(alice, R3, P);
        _payUsdc(alice, R3, R);
        vm.prank(alice);
        g = gasleft();
        receiver.release(alice, R3);
        console.log("gas release, both tokens (holder placed):", g - gasleft());
        _payAsset(alice, R3, P);
        vm.prank(alice);
        g = gasleft();
        receiver.release(alice, R3);
        console.log("gas release, $ASSET only (holder already placed):", g - gasleft());
    }

    // ──────────────────────── Helpers ──────────────────────────

    function _handOverMigrator() internal {
        migrator.transferOwnership(timelockOwner);
        vm.prank(timelockOwner);
        migrator.acceptOwnership();
    }

    /// @dev Tokens in the receiver itself with the allowances a `deliver` gives, for the direct
    ///      calls of the check-order tests.
    function _fundReceiver(uint256 a, uint256 u) internal {
        asset.transfer(address(receiver), a);
        usdcToken.transfer(address(receiver), u);
        vm.startPrank(address(receiver));
        asset.approve(address(migrator), a);
        usdcToken.approve(address(migrator), u);
        vm.stopPrank();
    }
}
