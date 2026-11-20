// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {TransitionHarness} from "../utils/TransitionHarness.sol";

import {StakingMigrator} from "../../../contracts/staking-v3/StakingMigrator.sol";
import {StakingMigratorBase} from "../../../contracts/staking-v3/StakingMigratorBase.sol";
import {StakingMigratorDeliveries} from "../../../contracts/staking-v3/StakingMigratorDeliveries.sol";
import {ITransitionMigrator} from "../../../contracts/staking-v3/interfaces/ITransition.sol";

/**
 * @notice The safety of the migrator's size split (accepted 2026-11-20): the delivery entries' bodies
 *         live in {StakingMigratorDeliveries}, which each migrator implementation creates in its
 *         constructor and reaches with `delegatecall`.
 *
 *  (a) Called DIRECTLY on its own address, the module changes nothing anywhere, for any caller and
 *      any calldata, and it holds no token, no approval and no role.
 *  (b) The module's runtime has no SELFDESTRUCT and no DELEGATECALL; the migrator's runtime has
 *      exactly one DELEGATECALL, and the only module address it carries is the one its constructor
 *      created (the AST half of this check is in test/staking-v3/Transition.test.js).
 *  (c) A new implementation brings a new module, and an upgrade in the middle of a holder's
 *      deliveries keeps `deliveryOf` and continues the nonce sequence.
 */
contract DeliveryModuleSafetyTest is TransitionHarness {
    bytes32 internal constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bytes32 internal constant MIGRATOR_STORAGE = 0xa846ed032583543a4fbe67f8b477f1a29883d2f8c76050d7d3635994b7226e00;
    uint256 internal constant P = 20_000e18;

    StakingMigratorDeliveries internal module;

    function setUp() public {
        _deployTransition();
        module = StakingMigratorDeliveries(_moduleOf(_implementationOf(address(migrator))));
        _approveMigrator(alice);
        // State worth protecting: a delivery done, tokens waiting, a direct transition made.
        _payAsset(alice, R3, P);
        _deliver(alice, R3, _dv(alice, R3, 2 * P, 0));
        _payAsset(alice, R3, P);
        _payUsdc(bob, R1, 1_000e6);
    }

    function _implementationOf(address proxy) internal view returns (address) {
        return address(uint160(uint256(vm.load(proxy, IMPLEMENTATION_SLOT))));
    }

    /// @dev The module is the implementation's first CREATE (its nonce starts at 1).
    function _moduleOf(address implementation) internal pure returns (address) {
        return vm.computeCreateAddress(implementation, 1);
    }

    function _record(address holder) internal view returns (bytes memory) {
        (uint8 r, bool c, uint256 id, uint256 p, uint256 u, uint256 n) = migrator.deliveryOf(holder);
        return abi.encode(r, c, id, p, u, n);
    }

    // ──────────────────────── (a) direct calls change nothing ──

    struct World {
        bytes32 migratorState;
        bytes32 migratorSlot2;
        bytes32 migratorSlot5;
        uint256 poolTotal;
        uint256 aliceStake;
        uint256 bonusTotal;
        uint256 lpTotal;
        uint256[8] balances;
    }

    function _world() internal view returns (World memory w) {
        w.migratorState = keccak256(_record(alice));
        w.migratorSlot2 = vm.load(address(migrator), bytes32(uint256(MIGRATOR_STORAGE) + 2));
        w.migratorSlot5 = vm.load(address(migrator), bytes32(uint256(MIGRATOR_STORAGE) + 5));
        w.poolTotal = poolV3.totalStaked();
        w.aliceStake = poolV3.stakes(alice);
        w.bonusTotal = bonusVault.totalReserved();
        w.lpTotal = bonusVault.totalLpReserved();
        address[4] memory holders = [_at(alice, R3), _at(bob, R1), address(receiver), address(migrator)];
        for (uint256 i = 0; i < 4; ++i) {
            w.balances[i] = asset.balanceOf(holders[i]);
            w.balances[i + 4] = usdcToken.balanceOf(holders[i]);
        }
    }

    function _assertUnchanged(World memory before) internal view {
        World memory after_ = _world();
        assertEq(abi.encode(after_), abi.encode(before), "a direct call on the module changed something");
        _assertModuleHoldsNothing();
    }

    function _assertModuleHoldsNothing() internal view {
        address m = address(module);
        assertEq(asset.balanceOf(m), 0);
        assertEq(usdcToken.balanceOf(m), 0);
        address[6] memory spenders = [
            address(migrator),
            address(poolV3),
            address(bonusVault),
            address(mathVault),
            address(mathNpm),
            address(routerMock)
        ];
        for (uint256 i = 0; i < spenders.length; ++i) {
            assertEq(asset.allowance(m, spenders[i]), 0, "no $ASSET approval");
            assertEq(usdcToken.allowance(m, spenders[i]), 0, "no USDC approval");
            assertEq(asset.allowance(spenders[i], m), 0, "nobody approved the module");
        }
        assertFalse(mathVault.isStakeOperator(m), "not a stake operator of the LP vault");
        assertTrue(poolV3.migrator() != m, "not Testnet Staking's migrator");
        assertTrue(bonusVault.migrator() != m, "not the bonus vault's migrator");
        assertEq(migrator.transitionReceiver() == m, false);
        // Its own storage was never initialized: no receiver, no signer.
        assertEq(vm.load(m, bytes32(uint256(MIGRATOR_STORAGE) + 5)), bytes32(0), "module: no transitionReceiver");
        assertEq(vm.load(m, bytes32(uint256(MIGRATOR_STORAGE) + 2)), bytes32(0), "module: no signer");
    }

    function test_Module_ExistsWhereTheImplementationCreatedIt() public view {
        assertGt(address(module).code.length, 0);
        assertEq(module.asset(), address(asset));
        assertEq(address(module.lpVault()), address(mathVault));
        _assertModuleHoldsNothing();
    }

    /// @dev Any calldata from any caller, the receiver and every role included.
    function testFuzz_Module_AnyCalldataFromAnyCallerChangesNothing(uint256 callerSeed, bytes calldata data) public {
        address[7] memory callers =
            [address(receiver), address(migrator), address(this), deliverer, migratorSigner, alice, stranger];
        World memory before = _world();
        vm.prank(callers[callerSeed % callers.length]);
        (bool ok,) = address(module).call(data);
        ok;
        _assertUnchanged(before);
    }

    /// @dev The three entries with well-formed arguments, a valid voucher and real tokens ready:
    ///      every one reverts on the module's own address, whoever calls.
    function testFuzz_Module_TheThreeEntriesRevertForEveryCaller(
        uint256 callerSeed,
        uint256 assetAmount,
        uint256 usdcAmount
    ) public {
        address[7] memory callers = [
            address(receiver), address(migrator), address(this), deliverer, migratorSigner, alice, stranger
        ];
        address caller = callers[callerSeed % callers.length];
        assetAmount = bound(assetAmount, 1, P);
        usdcAmount = bound(usdcAmount, 1, 1_000e6);
        ITransitionMigrator.DeliveryVoucher memory v = _dv(alice, R3, 2 * P, 1_000e6);
        ITransitionMigrator.DeliveryVoucher memory v1 = _dv(alice, R1, 2 * P, 1_000e6);
        // The caller has the tokens and has approved the module: still nothing may move.
        asset.transfer(caller, assetAmount);
        usdcToken.transfer(caller, usdcAmount);
        vm.startPrank(caller);
        asset.approve(address(module), assetAmount);
        usdcToken.approve(address(module), usdcAmount);
        vm.stopPrank();
        World memory before = _world();
        uint256 callerAsset = asset.balanceOf(caller);

        vm.startPrank(caller);
        vm.expectRevert();
        module.claimRestakeFor(alice, assetAmount, _limits(), v);
        vm.expectRevert();
        module.compoundFor(alice, assetAmount, usdcAmount, _limits(), v1);
        vm.expectRevert();
        module.moveToLpFor(alice, assetAmount, usdcAmount, _limits(), v1);
        // The test's own allowance is withdrawn before the module's holdings are checked.
        asset.approve(address(module), 0);
        usdcToken.approve(address(module), 0);
        vm.stopPrank();

        _assertUnchanged(before);
        assertEq(asset.balanceOf(caller), callerAsset, "the caller's tokens stay");
    }

    // ──────────────────────── (b) the bytecode ──────────────────

    /// @dev Counts `opcode` in `code`, skipping PUSH data and the compiler's CBOR metadata tail.
    function _count(bytes memory code, uint8 opcode) internal pure returns (uint256 n) {
        uint256 tail = (uint256(uint8(code[code.length - 2])) << 8) | uint256(uint8(code[code.length - 1]));
        uint256 end = code.length - tail - 2;
        for (uint256 i = 0; i < end; ++i) {
            uint8 op = uint8(code[i]);
            if (op == opcode) ++n;
            if (op >= 0x60 && op <= 0x7f) i += op - 0x5f; // PUSH1..PUSH32 data
        }
    }

    function test_Bytecode_TheModuleHasNoSelfdestructAndNoDelegatecall() public view {
        bytes memory code = address(module).code;
        assertEq(_count(code, 0xff), 0, "no SELFDESTRUCT");
        assertEq(_count(code, 0xf4), 0, "no DELEGATECALL");
        assertEq(_count(code, 0xf2), 0, "no CALLCODE");
    }

    function test_Bytecode_TheMigratorDelegatesOnlyToItsOwnModule() public view {
        address implementation = _implementationOf(address(migrator));
        bytes memory code = implementation.code;
        // Two: OpenZeppelin's `upgradeToAndCall` (ERC1967Utils, to the new implementation) and
        // `_delegateToDeliveries`. The source-level check that ours targets `deliveryModule` and nothing
        // else is the AST test in test/staking-v3/Transition.test.js.
        assertEq(_count(code, 0xf4), 2, "upgradeToAndCall's and the forwarder's DELEGATECALL only");
        assertEq(_count(code, 0xff), 0, "no SELFDESTRUCT");
        // The module address appears in the runtime (the immutable) and nothing else can be the target:
        // the DELEGATECALL's address comes from that immutable (the AST check names the variable).
        assertTrue(_contains(code, abi.encodePacked(address(module))), "the immutable is the created module");
    }

    function _contains(bytes memory hay, bytes memory needle) internal pure returns (bool) {
        for (uint256 i = 0; i + needle.length <= hay.length; ++i) {
            bool same = true;
            for (uint256 j = 0; j < needle.length && same; ++j) {
                same = hay[i + j] == needle[j];
            }
            if (same) return true;
        }
        return false;
    }

    function test_Delegation_ReplacingTheModuleCodeChangesTheMigratorsBehaviour() public {
        // Proof by intervention that the migrator delegates to exactly that address: with the
        // module's code removed, the three entries stop working and the rest of the migrator does not.
        vm.etch(address(module), "");
        ITransitionMigrator.DeliveryVoucher memory v = _dv(alice, R3, 2 * P, 0);
        vm.prank(address(receiver));
        (bool ok, bytes memory ret) =
            address(migrator).call(abi.encodeCall(StakingMigrator.claimRestakeFor, (alice, 1, _limits(), v)));
        assertTrue(ok, "a delegatecall to an empty account succeeds with no effect");
        assertEq(ret.length, 0, "and returns nothing: nothing ran");
        (,,, uint256 pd,, uint256 nonce) = migrator.deliveryOf(alice);
        assertEq(pd, P);
        assertEq(nonce, 1, "nothing was recorded");
        assertEq(migrator.signer(), migratorSigner, "the migrator's own functions are untouched");
    }

    // ──────────────────────── (c) upgrades ─────────────────────

    function test_Upgrade_ANewImplementationBringsANewModule() public {
        StakingMigrator a = new StakingMigrator(address(mathVault), address(usdcToken), address(asset));
        StakingMigrator b = new StakingMigrator(address(mathVault), address(usdcToken), address(asset));
        address ma = _moduleOf(address(a));
        address mb = _moduleOf(address(b));
        assertTrue(ma != mb && ma != address(module) && mb != address(module));
        assertGt(ma.code.length, 0);
        assertGt(mb.code.length, 0);
        assertEq(keccak256(ma.code), keccak256(address(module).code), "the same module code");
    }

    function test_Upgrade_MidDeliveriesKeepsTheRecordAndContinuesTheNonces() public {
        bytes memory recordBefore = _record(alice);
        ITransitionMigrator.DeliveryVoucher memory oldNonce =
            _dvFull(migratorSignerPk, alice, R3, 2 * P, 0, 2 * P, 0, block.timestamp - 1, 0, FAR_DEADLINE);

        StakingMigrator next = new StakingMigrator(address(mathVault), address(usdcToken), address(asset));
        migrator.upgradeToAndCall(address(next), "");
        assertEq(_implementationOf(address(migrator)), address(next));
        assertEq(_record(alice), recordBefore, "deliveryOf survives the upgrade");
        assertEq(migrator.transitionReceiver(), address(receiver));

        // The spent nonce stays spent, a skipped nonce is refused, the next one runs.
        ITransitionMigrator.DeliveryLimits memory l = _limits();
        vm.prank(deliverer);
        vm.expectRevert(abi.encodeWithSelector(StakingMigratorBase.DeliveryNonceMismatch.selector, alice, 1, 0));
        receiver.deliver(alice, R3, l, oldNonce);
        ITransitionMigrator.DeliveryVoucher memory skipped =
            _dvFull(migratorSignerPk, alice, R3, 2 * P, 0, 2 * P, 0, block.timestamp - 1, 2, FAR_DEADLINE);
        vm.prank(deliverer);
        vm.expectRevert(abi.encodeWithSelector(StakingMigratorBase.DeliveryNonceMismatch.selector, alice, 1, 2));
        receiver.deliver(alice, R3, l, skipped);
        _deliver(alice, R3, _dv(alice, R3, 2 * P, 0));
        (,,, uint256 pd,, uint256 nonce) = migrator.deliveryOf(alice);
        assertEq(pd, 2 * P);
        assertEq(nonce, 2);
        assertEq(poolV3.stakes(alice), 2 * P, "both parts staked across the upgrade");
    }
}
