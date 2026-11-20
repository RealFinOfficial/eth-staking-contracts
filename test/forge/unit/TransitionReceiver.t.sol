// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {TransitionHarness} from "../utils/TransitionHarness.sol";
import {OperatorOnlyVault, ScriptedMigrator} from "../utils/attackers/TransitionAttackers.sol";

import {LPProxy} from "../../../contracts/lp-staking/deploy/LPProxy.sol";
import {MockERC20Permit} from "../../../contracts/lp-staking/mocks/MockERC20Permit.sol";
import {MockHookERC20} from "../../../contracts/lp-staking/mocks/MockHookERC20.sol";
import {TransitionHolder} from "../../../contracts/staking-v3/TransitionHolder.sol";
import {TransitionReceiver} from "../../../contracts/staking-v3/TransitionReceiver.sol";
import {TransitionReceiverV2Mock} from "../../../contracts/staking-v3/mocks/TransitionReceiverV2Mock.sol";
import {ITransitionMigrator} from "../../../contracts/staking-v3/interfaces/ITransition.sol";
import {V3BonusVault} from "../../../contracts/staking-v3/V3BonusVault.sol";

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @dev The holder code checks shared by both suites.
library HolderCode {
    /// @dev The literal of `TransitionReceiver.HOLDER_INIT_CODE_HASH`, pinned here a second time.
    bytes32 internal constant PINNED_HASH = 0xc9fdfcb43183a49244ffe584d9e69edfb144922f0930ecd33fd099814b33579b;

    /// @dev `code` without the compiler's CBOR metadata tail (its length is the last two bytes).
    function stripMetadata(bytes memory code) internal pure returns (bytes memory out) {
        uint256 tail = (uint256(uint8(code[code.length - 2])) << 8) | uint256(uint8(code[code.length - 1]));
        uint256 n = code.length - tail - 2;
        out = new bytes(n);
        for (uint256 i = 0; i < n; ++i) {
            out[i] = code[i];
        }
    }
}

/**
 * @notice {TransitionReceiver} on the full stack: the holding contract and its fixed creation code,
 *         the receiving addresses, who may call what, `deliver` and `release` as the only two ways
 *         out of a receiving address, the deliverer key, and the upgrade that keeps every address.
 */
contract TransitionReceiverTest is TransitionHarness {
    uint256 internal constant P = 20_000e18;
    uint256 internal constant R = 1_000e6;

    function setUp() public {
        _deployTransition();
    }

    // ──────────────────────── The holding contract ─────────────

    function test_HolderCode_TheHashIsThePinnedLiteralOfTheCreationCode() public view {
        assertEq(receiver.HOLDER_INIT_CODE_HASH(), HolderCode.PINNED_HASH, "the pinned literal");
        assertEq(keccak256(receiver.HOLDER_CREATION_CODE()), HolderCode.PINNED_HASH, "keccak256 of the literal");
    }

    function test_HolderCode_TheLiteralIsTheCompiledReadableSource() public view {
        // The metadata tail differs between compilers' settings (Forge vs Hardhat); the code does not.
        assertEq(
            keccak256(HolderCode.stripMetadata(_literal())),
            keccak256(HolderCode.stripMetadata(type(TransitionHolder).creationCode)),
            "TransitionHolder.sol compiles to the literal (metadata aside)"
        );
    }

    function test_HolderCode_TheLiteralDeploysTheSourcesRuntimeAndBehaviour() public {
        bytes memory code = _literal();
        address fromLiteral;
        assembly {
            fromLiteral := create(0, add(code, 0x20), mload(code))
        }
        address fromSource = address(new TransitionHolder());
        assertTrue(fromLiteral != address(0));
        assertEq(
            keccak256(HolderCode.stripMetadata(fromLiteral.code)),
            keccak256(HolderCode.stripMetadata(fromSource.code)),
            "the same runtime, the immutable receiver included"
        );

        // Behaviour: the deployer (here this test) is the receiver; everybody else is refused.
        asset.transfer(fromLiteral, 5e18);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(TransitionHolder.NotReceiver.selector, stranger));
        TransitionHolder(fromLiteral).pull(address(asset), 1);
        uint256 before = asset.balanceOf(address(this));
        TransitionHolder(fromLiteral).pull(address(asset), 5e18);
        assertEq(asset.balanceOf(address(this)), before + 5e18, "pull pays the receiver");
        assertEq(asset.balanceOf(fromLiteral), 0);
    }

    function test_HolderCode_APlacedHolderObeysOnlyTheReceiverProxy() public {
        _payAsset(alice, R3, 10e18);
        _payUsdc(alice, R3, 1e6); // placed by the release below
        vm.prank(alice);
        receiver.release(alice, R3);
        address at_ = _at(alice, R3);
        assertTrue(receiver.isPlaced(alice, R3));
        _payAsset(alice, R3, 10e18);

        address[5] memory callers = [address(this), deliverer, alice, address(migrator), stranger];
        for (uint256 i = 0; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(TransitionHolder.NotReceiver.selector, callers[i]));
            TransitionHolder(at_).pull(address(asset), 1);
        }
        // The holder has no other entry: a plain call and an ETH transfer both revert.
        (bool ok,) = at_.call(abi.encodeWithSignature("transfer(address,uint256)", stranger, 1));
        assertFalse(ok, "no fallback");
        (ok,) = at_.call{value: 1}("");
        assertFalse(ok, "no receive");
        assertEq(asset.balanceOf(at_), 10e18, "nothing moved");
    }

    /// @dev The literal under test: the receiver's own constant.
    function _literal() internal view returns (bytes memory) {
        return receiver.HOLDER_CREATION_CODE();
    }

    // ──────────────────────── Receiving addresses ──────────────

    function test_ReceivingAddress_IsTheCreate2OfTheProxy() public view {
        address[3] memory holders = [alice, bob, carol];
        for (uint256 h = 0; h < holders.length; ++h) {
            for (uint8 route = 1; route <= 3; ++route) {
                bytes32 salt = keccak256(abi.encode(holders[h], route));
                address expected = vm.computeCreate2Address(salt, HolderCode.PINNED_HASH, address(receiver));
                assertEq(receiver.receivingAddressOf(holders[h], route), expected);
            }
        }
    }

    function test_ReceivingAddress_DiffersPerHolderAndRoute() public view {
        assertTrue(_at(alice, R1) != _at(alice, R2));
        assertTrue(_at(alice, R2) != _at(alice, R3));
        assertTrue(_at(alice, R1) != _at(bob, R1));
    }

    function test_ReceivingAddress_RejectsABadRouteAndAZeroHolder() public {
        vm.expectRevert(abi.encodeWithSelector(TransitionReceiver.InvalidRoute.selector, uint8(0)));
        receiver.receivingAddressOf(alice, 0);
        vm.expectRevert(abi.encodeWithSelector(TransitionReceiver.InvalidRoute.selector, uint8(4)));
        receiver.receivingAddressOf(alice, 4);
        vm.expectRevert(TransitionReceiver.ZeroAddress.selector);
        receiver.receivingAddressOf(address(0), 1);
        vm.expectRevert(abi.encodeWithSelector(TransitionReceiver.InvalidRoute.selector, uint8(9)));
        receiver.isPlaced(alice, 9);
    }

    function test_ReceivingAddress_IsPlacedOnlyByTheFirstDeliverOrRelease() public {
        assertFalse(receiver.isPlaced(alice, R3));
        assertEq(_at(alice, R3).code.length, 0);
        _payAsset(alice, R3, P);

        vm.expectEmit(address(receiver));
        emit TransitionReceiver.HolderPlaced(alice, R3, _at(alice, R3));
        _deliver(alice, R3, _dv(alice, R3, P, 0));
        assertTrue(receiver.isPlaced(alice, R3));

        // A second delivery does not place again.
        _payAsset(alice, R3, 1e18);
        vm.recordLogs();
        _deliver(alice, R3, _dvAt(alice, R3, P + 1e18, 0, P + 1e18, 0, block.timestamp - 1));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != TransitionReceiver.HolderPlaced.selector, "placed once");
        }
    }

    // ──────────────────────── deliver: who may call ────────────

    function test_Deliver_OnlyTheDelivererOrTheHolder() public {
        _payAsset(alice, R3, P);
        ITransitionMigrator.DeliveryVoucher memory v = _dv(alice, R3, P, 0);
        ITransitionMigrator.DeliveryLimits memory l = _limits();
        // The owner and the operator (the harness), the voucher signer, the migrator, another holder.
        address[5] memory callers = [address(this), migratorSigner, address(migrator), bob, stranger];
        for (uint256 i = 0; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(
                abi.encodeWithSelector(TransitionReceiver.NotDelivererOrHolder.selector, callers[i], deliverer, alice)
            );
            receiver.deliver(alice, R3, l, v);
        }
        vm.prank(alice);
        receiver.deliver(alice, R3, l, v);
        assertEq(poolV3.stakes(alice), P, "the holder delivers itself");
    }

    function test_Deliver_TheOwnerIsRefusedAfterTheHandOver() public {
        _handOverReceiver();
        _payAsset(alice, R3, P);
        ITransitionMigrator.DeliveryVoucher memory v = _dv(alice, R3, P, 0);
        ITransitionMigrator.DeliveryLimits memory l = _limits();
        vm.prank(receiverOwner);
        vm.expectRevert(
            abi.encodeWithSelector(TransitionReceiver.NotDelivererOrHolder.selector, receiverOwner, deliverer, alice)
        );
        receiver.deliver(alice, R3, l, v);
    }

    function test_Deliver_CheckOrderIsCallerThenRouteThenHolder() public {
        ITransitionMigrator.DeliveryVoucher memory v = _dv(alice, R3, P, 0);
        ITransitionMigrator.DeliveryLimits memory l = _limits();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(TransitionReceiver.NotDelivererOrHolder.selector, stranger, deliverer, alice)
        );
        receiver.deliver(alice, 7, l, v);
        vm.startPrank(deliverer);
        vm.expectRevert(abi.encodeWithSelector(TransitionReceiver.InvalidRoute.selector, uint8(7)));
        receiver.deliver(alice, 7, l, v);
        vm.expectRevert(TransitionReceiver.ZeroAddress.selector);
        receiver.deliver(address(0), R3, l, v);
        vm.stopPrank();
    }

    function test_Deliver_NothingToDeliverWithNoBalanceOrNoLimitLeft() public {
        ITransitionMigrator.DeliveryVoucher memory v = _dv(alice, R3, P, 0);
        ITransitionMigrator.DeliveryLimits memory l = _limits();
        vm.prank(deliverer);
        vm.expectRevert(abi.encodeWithSelector(TransitionReceiver.NothingToDeliver.selector, alice, R3));
        receiver.deliver(alice, R3, l, v);

        _payAsset(alice, R3, P + 5e18);
        _deliver(alice, R3, v); // takes P, leaves 5
        ITransitionMigrator.DeliveryVoucher memory again = _dv(alice, R3, P, 0); // nonce 1, the same limit
        vm.prank(deliverer);
        vm.expectRevert(abi.encodeWithSelector(TransitionReceiver.NothingToDeliver.selector, alice, R3));
        receiver.deliver(alice, R3, l, again);
        assertEq(asset.balanceOf(_at(alice, R3)), 5e18, "what the voucher does not allow stays");
    }

    function test_Deliver_TakesOnlyWhatTheVoucherAllowsAndTheRestWaits() public {
        _payAsset(alice, R3, P);
        _payUsdc(alice, R3, R); // route 3 never takes USDC
        ITransitionMigrator.DeliveryVoucher memory v = _dvAt(alice, R3, P, R, 12_000e18, R, block.timestamp - 1);
        ITransitionMigrator.DeliveryResult memory r = _deliver(alice, R3, v);
        assertEq(r.staked, 12_000e18);
        assertEq(asset.balanceOf(_at(alice, R3)), 8_000e18, "the rest waits");
        assertEq(usdcToken.balanceOf(_at(alice, R3)), R, "route 3 leaves the USDC");
        _assertReceiverClean();
    }

    function test_Deliver_EmitsDeliveredWithTheRunningTotals() public {
        _payAsset(alice, R3, P);
        uint256 burnTime = block.timestamp - 100;
        ITransitionMigrator.DeliveryVoucher memory v = _dvAt(alice, R3, P, 0, P, 0, burnTime);
        address at_ = _at(alice, R3);
        vm.expectEmit(address(receiver));
        emit TransitionReceiver.Delivered(alice, R3, at_, deliverer, 0, burnTime, P, 0, P, 0, P * 500 / 10_000, P, 0);
        _deliver(alice, R3, v);
    }

    function test_Deliver_LeavesNoAllowanceAndNoBalanceInTheReceiver() public {
        _payAsset(alice, R1, P);
        _payUsdc(alice, R1, R);
        _deliver(alice, R1, _dv(alice, R1, P, R));
        _assertReceiverClean();
        _payAsset(bob, R2, P);
        _payUsdc(bob, R2, R);
        _deliver(bob, R2, _dv(bob, R2, P, R));
        _assertReceiverClean();
    }

    function test_Deliver_WithTheDelivererClearedOnlyTheHolderDelivers() public {
        receiver.setDeliverer(address(0));
        _payAsset(alice, R3, P);
        ITransitionMigrator.DeliveryVoucher memory v = _dv(alice, R3, P, 0);
        ITransitionMigrator.DeliveryLimits memory l = _limits();
        vm.prank(deliverer);
        vm.expectRevert(
            abi.encodeWithSelector(TransitionReceiver.NotDelivererOrHolder.selector, deliverer, address(0), alice)
        );
        receiver.deliver(alice, R3, l, v);
        vm.prank(alice);
        receiver.deliver(alice, R3, l, v);
    }

    function test_Deliver_AMigratorRevertBubblesUpUnchanged() public {
        _payAsset(alice, R3, P);
        ITransitionMigrator.DeliveryVoucher memory v =
            _dvFull(voucherSignerPk, alice, R3, P, 0, P, 0, block.timestamp - 1, 0, FAR_DEADLINE);
        ITransitionMigrator.DeliveryLimits memory l = _limits();
        vm.prank(deliverer);
        vm.expectRevert(bytes4(keccak256("InvalidVoucherSignature()")));
        receiver.deliver(alice, R3, l, v);
        assertEq(asset.balanceOf(_at(alice, R3)), P, "nothing moved");
    }

    // ──────────────────────── release ──────────────────────────

    function test_Release_TheHolderTakesBothTokensBack() public {
        _payAsset(alice, R1, P);
        _payUsdc(alice, R1, R);
        uint256 a0 = asset.balanceOf(alice);
        uint256 u0 = usdcToken.balanceOf(alice);
        address at_ = _at(alice, R1);
        vm.expectEmit(address(receiver));
        emit TransitionReceiver.Released(alice, R1, at_, alice, P, R);
        vm.prank(alice);
        receiver.release(alice, R1);
        assertEq(asset.balanceOf(alice), a0 + P);
        assertEq(usdcToken.balanceOf(alice), u0 + R);
        assertEq(asset.balanceOf(at_), 0);
        assertEq(usdcToken.balanceOf(at_), 0);
        _assertReceiverClean();
    }

    function test_Release_TheOperatorReleasesToTheHolderNeverToItself() public {
        _payUsdc(alice, R2, R);
        uint256 u0 = usdcToken.balanceOf(alice);
        uint256 op0 = usdcToken.balanceOf(address(this));
        receiver.release(alice, R2); // the harness is the LP vault's operator
        assertEq(usdcToken.balanceOf(alice), u0 + R, "to the holder");
        assertEq(usdcToken.balanceOf(address(this)), op0, "never to the caller");
    }

    function test_Release_EveryoneElseIsRefused() public {
        _handOverReceiver();
        _payAsset(alice, R3, P);
        address[5] memory callers = [deliverer, receiverOwner, migratorSigner, bob, stranger];
        for (uint256 i = 0; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(
                abi.encodeWithSelector(
                    TransitionReceiver.NotHolderOrOperator.selector, callers[i], alice, address(this)
                )
            );
            receiver.release(alice, R3);
        }
    }

    function test_Release_ChecksTheRouteAndRefusesAnEmptyAddress() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TransitionReceiver.InvalidRoute.selector, uint8(0)));
        receiver.release(alice, 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TransitionReceiver.NothingToRelease.selector, alice, R1));
        receiver.release(alice, R1);
    }

    function test_Release_WorksAfterTheEndAndWhileTheTradingRoutesArePaused() public {
        _payAsset(alice, R1, P);
        _payUsdc(alice, R1, R);
        migrator.pauseCompound();
        vm.warp(v3End + 1);
        vm.prank(alice);
        receiver.release(alice, R1);
        assertEq(asset.balanceOf(_at(alice, R1)), 0);
    }

    function test_Release_TheRestAfterADeliveryGoesToTheHolder() public {
        _payAsset(alice, R3, P + 7e18);
        _deliver(alice, R3, _dv(alice, R3, P, 0));
        uint256 a0 = asset.balanceOf(alice);
        vm.prank(alice);
        receiver.release(alice, R3);
        assertEq(asset.balanceOf(alice), a0 + 7e18);
        assertEq(poolV3.stakes(alice), P, "the stake stays");
    }

    // ──────────────────────── setDeliverer ─────────────────────

    function test_SetDeliverer_OperatorOnlyTheOwnerIsRefused() public {
        _handOverReceiver();
        address next = makeAddr("nextDeliverer");
        vm.prank(receiverOwner);
        vm.expectRevert(abi.encodeWithSelector(TransitionReceiver.NotOperator.selector, receiverOwner, address(this)));
        receiver.setDeliverer(next);
        vm.prank(deliverer);
        vm.expectRevert(abi.encodeWithSelector(TransitionReceiver.NotOperator.selector, deliverer, address(this)));
        receiver.setDeliverer(next);

        vm.expectEmit(address(receiver));
        emit TransitionReceiver.DelivererSet(deliverer, next);
        receiver.setDeliverer(next);
        assertEq(receiver.deliverer(), next);
    }

    function test_SetDeliverer_ALeakedKeyIsReplacedAtOnce() public {
        address next = makeAddr("nextDeliverer");
        receiver.setDeliverer(next);
        _payAsset(alice, R3, P);
        ITransitionMigrator.DeliveryVoucher memory v = _dv(alice, R3, P, 0);
        ITransitionMigrator.DeliveryLimits memory l = _limits();
        vm.prank(deliverer);
        vm.expectRevert(
            abi.encodeWithSelector(TransitionReceiver.NotDelivererOrHolder.selector, deliverer, next, alice)
        );
        receiver.deliver(alice, R3, l, v);
        vm.prank(next);
        receiver.deliver(alice, R3, l, v);
    }

    // ──────────────────────── Construction and ownership ───────

    function test_Construction_ViewsAndTheInitializeEvent() public {
        assertEq(receiver.migrator(), address(migrator));
        assertEq(receiver.asset(), address(asset));
        assertEq(receiver.usdc(), address(usdcToken));
        assertEq(receiver.lpVault(), address(mathVault));
        assertEq(receiver.deliverer(), deliverer);
        assertEq(receiver.owner(), address(this));

        TransitionReceiver impl = new TransitionReceiver(address(migrator));
        vm.expectEmit();
        emit TransitionReceiver.DelivererSet(address(0), address(0));
        LPProxy proxy =
            new LPProxy(address(impl), abi.encodeCall(TransitionReceiver.initialize, (address(this), address(0))));
        assertEq(TransitionReceiver(address(proxy)).deliverer(), address(0), "no service is allowed");
    }

    function test_Construction_ImplementationIsLockedAndZeroRejected() public {
        TransitionReceiver impl = new TransitionReceiver(address(migrator));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(address(this), deliverer);
        vm.expectRevert(TransitionReceiver.ZeroAddress.selector);
        new TransitionReceiver(address(0));
        ScriptedMigrator broken = new ScriptedMigrator(address(0), address(usdcToken), address(mathVault));
        vm.expectRevert(TransitionReceiver.ZeroAddress.selector);
        new TransitionReceiver(address(broken));
    }

    function test_Ownership_RenounceIsDisabledAndUpgradeIsOwnerOnly() public {
        vm.expectRevert(TransitionReceiver.RenounceDisabled.selector);
        receiver.renounceOwnership();
        TransitionReceiverV2Mock v2 = new TransitionReceiverV2Mock(address(migrator));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        receiver.upgradeToAndCall(address(v2), "");
        vm.prank(deliverer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, deliverer));
        receiver.upgradeToAndCall(address(v2), "");
    }

    // ──────────────────────── Upgrade keeps every address ──────

    function test_Upgrade_KeepsEveryReceivingAddressAndAPlacedHolderStillPays() public {
        address[4] memory holders = [alice, bob, carol, stranger];
        address[12] memory before;
        for (uint256 h = 0; h < 4; ++h) {
            for (uint8 r = 1; r <= 3; ++r) {
                before[h * 3 + r - 1] = receiver.receivingAddressOf(holders[h], r);
            }
        }
        // A holder placed before the upgrade, with tokens waiting.
        _payAsset(alice, R3, P);
        vm.prank(alice);
        receiver.release(alice, R3);
        _payAsset(alice, R3, P);
        assertTrue(receiver.isPlaced(alice, R3));

        TransitionReceiverV2Mock v2 = new TransitionReceiverV2Mock(address(migrator));
        receiver.upgradeToAndCall(address(v2), abi.encodeCall(TransitionReceiverV2Mock.initializeV2, (42)));
        assertEq(TransitionReceiverV2Mock(address(receiver)).version(), 2);
        assertEq(TransitionReceiverV2Mock(address(receiver)).upgradeMarker(), 42);

        for (uint256 h = 0; h < 4; ++h) {
            for (uint8 r = 1; r <= 3; ++r) {
                assertEq(receiver.receivingAddressOf(holders[h], r), before[h * 3 + r - 1], "the same address");
            }
        }
        assertEq(receiver.HOLDER_INIT_CODE_HASH(), HolderCode.PINNED_HASH);
        assertEq(receiver.deliverer(), deliverer, "the deliverer survives");
        assertEq(receiver.owner(), address(this));

        _deliver(alice, R3, _dv(alice, R3, P, 0));
        assertEq(poolV3.stakes(alice), P, "the holder placed before the upgrade still hands its tokens over");
    }

    // ──────────────────────── Helpers ──────────────────────────

    function _handOverReceiver() internal {
        receiver.transferOwnership(receiverOwner);
        vm.prank(receiverOwner);
        receiver.acceptOwnership();
    }

    function _assertReceiverClean() internal view {
        assertEq(asset.balanceOf(address(receiver)), 0, "receiver holds no $ASSET");
        assertEq(usdcToken.balanceOf(address(receiver)), 0, "receiver holds no USDC");
        assertEq(asset.allowance(address(receiver), address(migrator)), 0, "no $ASSET allowance left");
        assertEq(usdcToken.allowance(address(receiver), address(migrator)), 0, "no USDC allowance left");
        assertEq(asset.balanceOf(address(migrator)), 0, "migrator holds no $ASSET");
        assertEq(usdcToken.balanceOf(address(migrator)), 0, "migrator holds no USDC");
    }
}

/**
 * @notice {TransitionReceiver} against a scripted migrator: what `deliver` hands over per route,
 *         the approvals after a migrator that pulls less than it was given, and re-entrancy through
 *         a malicious migrator callback and through a token with a transfer hook.
 */
contract TransitionReceiverIsolatedTest is Test {
    uint256 internal constant FAR = 10 ** 12;

    MockERC20Permit internal assetToken;
    MockERC20Permit internal usdcToken;
    OperatorOnlyVault internal vault;
    ScriptedMigrator internal scripted;
    TransitionReceiver internal receiver;
    address internal deliverer = makeAddr("deliverer");
    address internal operator = makeAddr("operator");
    address internal holder = makeAddr("holder");

    function setUp() public {
        assetToken = new MockERC20Permit("Asset", "ASSET", 1e30, 18);
        usdcToken = new MockERC20Permit("USD Coin", "USDC", 1e30, 6);
        vault = new OperatorOnlyVault(operator);
        scripted = new ScriptedMigrator(address(assetToken), address(usdcToken), address(vault));
        receiver = _receiverFor(address(scripted));
    }

    function _receiverFor(address m) internal returns (TransitionReceiver) {
        TransitionReceiver impl = new TransitionReceiver(m);
        return TransitionReceiver(
            address(
                new LPProxy(address(impl), abi.encodeCall(TransitionReceiver.initialize, (address(this), deliverer)))
            )
        );
    }

    function _v(uint8 route, uint256 assetLimit, uint256 usdcLimit)
        internal
        pure
        returns (ITransitionMigrator.DeliveryVoucher memory v)
    {
        v.route = route;
        v.assetLimit = assetLimit;
        v.usdcLimit = usdcLimit;
        v.eligiblePrincipal = assetLimit;
        v.eligibleReward = usdcLimit;
        v.burnTime = 1;
        v.deadline = FAR;
    }

    function _l() internal pure returns (ITransitionMigrator.DeliveryLimits memory) {
        return ITransitionMigrator.DeliveryLimits(0, 0, 0, FAR);
    }

    function _fund(uint8 route, uint256 a, uint256 u) internal {
        address at_ = receiver.receivingAddressOf(holder, route);
        if (a > 0) assetToken.transfer(at_, a);
        if (u > 0) usdcToken.transfer(at_, u);
    }

    function test_Deliver_RouteOneHandsBothTokensToCompoundFor() public {
        _fund(1, 100, 50);
        vm.prank(deliverer);
        receiver.deliver(holder, 1, _l(), _v(1, 1000, 1000));
        assertEq(scripted.lastEntry(), 1);
        assertEq(scripted.lastAsset(), 100);
        assertEq(scripted.lastUsdc(), 50);
    }

    function test_Deliver_RouteTwoHandsUsdcOnlyBeforeThePositionExists() public {
        _fund(2, 100, 50);
        vm.prank(deliverer);
        receiver.deliver(holder, 2, _l(), _v(2, 1000, 1000));
        assertEq(scripted.lastEntry(), 2);
        assertEq(scripted.lastUsdc(), 50);

        scripted.setRecord(2, true, 100, 50, 1);
        _fund(2, 30, 20);
        vm.prank(deliverer);
        receiver.deliver(holder, 2, _l(), _v(2, 1000, 1000));
        assertEq(scripted.lastAsset(), 30);
        assertEq(scripted.lastUsdc(), 0, "no USDC once the position exists");
        assertEq(usdcToken.balanceOf(receiver.receivingAddressOf(holder, 2)), 20, "the USDC waits for release");
    }

    function test_Deliver_RouteThreeNeverHandsUsdc() public {
        _fund(3, 100, 50);
        vm.prank(deliverer);
        receiver.deliver(holder, 3, _l(), _v(3, 1000, 1000));
        assertEq(scripted.lastEntry(), 3);
        assertEq(scripted.lastAsset(), 100);
        assertEq(scripted.lastUsdc(), 0);
    }

    function test_Deliver_TheAllowanceIsTheRemainderOfTheVoucher() public {
        scripted.setRecord(1, false, 900, 990, 1);
        _fund(1, 500, 500);
        vm.prank(deliverer);
        receiver.deliver(holder, 1, _l(), _v(1, 1000, 1000));
        assertEq(scripted.lastAsset(), 100, "1,000 - 900 delivered");
        assertEq(scripted.lastUsdc(), 10, "1,000 - 990 delivered");

        // Limits below what was delivered allow nothing.
        scripted.setRecord(1, false, 2000, 2000, 2);
        vm.prank(deliverer);
        vm.expectRevert(abi.encodeWithSelector(TransitionReceiver.NothingToDeliver.selector, holder, uint8(1)));
        receiver.deliver(holder, 1, _l(), _v(1, 1000, 1000));
    }

    function test_Deliver_ApprovalsReturnToZeroEvenWhenTheMigratorPullsLess() public {
        scripted.setPullBps(5_000);
        _fund(1, 100, 50);
        vm.prank(deliverer);
        receiver.deliver(holder, 1, _l(), _v(1, 1000, 1000));
        assertEq(assetToken.allowance(address(receiver), address(scripted)), 0);
        assertEq(usdcToken.allowance(address(receiver), address(scripted)), 0);
    }

    function test_Reentrancy_AMigratorCallbackCannotReenterDeliverOrRelease() public {
        _fund(3, 100, 0);
        scripted.arm(address(receiver), abi.encodeCall(TransitionReceiver.release, (holder, 3)));
        vm.prank(deliverer);
        receiver.deliver(holder, 3, _l(), _v(3, 1000, 0));
        assertFalse(scripted.reentered());
        assertEq(
            scripted.reenterRevert(),
            abi.encodeWithSelector(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector)
        );

        _fund(3, 100, 0);
        scripted.arm(address(receiver), abi.encodeCall(TransitionReceiver.deliver, (holder, 3, _l(), _v(3, 1000, 0))));
        vm.prank(deliverer);
        receiver.deliver(holder, 3, _l(), _v(3, 1000, 0));
        assertFalse(scripted.reentered());
        assertEq(
            scripted.reenterRevert(),
            abi.encodeWithSelector(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector)
        );
    }

    function test_Reentrancy_AHookTokenCannotReenterDuringThePullOrThePayout() public {
        MockHookERC20 hook = new MockHookERC20("Hook", "HOOK", 1e30, 18);
        ScriptedMigrator m = new ScriptedMigrator(address(hook), address(usdcToken), address(vault));
        TransitionReceiver r = _receiverFor(address(m));
        address at_ = r.receivingAddressOf(holder, 3);
        hook.transfer(at_, 100);

        // The pull from the holding contract lands on the receiver and fires the hook.
        hook.setRecipientHook(address(r), address(r), abi.encodeCall(TransitionReceiver.release, (holder, 3)));
        vm.prank(deliverer);
        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        r.deliver(holder, 3, _l(), _v(3, 1000, 0));

        // The payout of a release lands on the holder and fires the hook.
        hook.setRecipientHook(address(r), address(0), "");
        hook.setRecipientHook(holder, address(r), abi.encodeCall(TransitionReceiver.release, (holder, 3)));
        vm.prank(holder);
        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        r.release(holder, 3);
        assertEq(hook.balanceOf(at_), 100, "nothing left the receiving address");
    }
}
