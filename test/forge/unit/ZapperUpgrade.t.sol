// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LocalHarness} from "../utils/LocalHarness.sol";
import {LPZapper} from "../../../contracts/lp-staking/LPZapper.sol";
import {LPZapperV2Mock} from "../../../contracts/lp-staking/mocks/LPZapperV2Mock.sol";
import {LPProxy} from "../../../contracts/lp-staking/deploy/LPProxy.sol";
import {TwapGuard} from "../../../contracts/lp-staking/libraries/TwapGuard.sol";
import {MockUniswapV3Pool} from "../../../contracts/lp-staking/mocks/MockUniswapV3Pool.sol";
import {MockERC20Permit} from "../../../contracts/lp-staking/mocks/MockERC20Permit.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";

/**
 * @notice Why this file exists: `LPZapper` became a UUPS proxy owned by the timelock, with a
 *         new OPERATOR tier holding the three immediate levers (`setTwapParams`, `sweep`,
 *         `rescuePosition`). Three things changed shape at once and each is stated here: the
 *         split between the two tiers, the proxy's one-time initialisation (which now carries
 *         what the old constructor did — the owner, the TWAP parameters — plus the operator and
 *         the NFT receive guard), and the upgrade itself, which must keep every one of those
 *         and leave the vault pointing at the same proxy address.
 *
 *  The zapper under test is a second proxy whose owner (this contract) and operator
 *  ({operatorSafe}) are two different addresses — the harness collapses them — and the vault
 *  is pointed at it so a real zap can run through it.
 */
contract ZapperUpgradeTest is LocalHarness {
    /// @dev `real.lp.storage.LPZapper`, the zapper's ERC-7201 base, pinned.
    bytes32 internal constant ZAPPER_STORAGE = 0x3f321486c4e46b59498f8814639a355cef7759e294075873ae5431d3955f3000;

    uint256 internal constant ZAP = 1_000e6;

    LPZapper internal split;

    function setUp() public {
        _deployLocalStack();
        split = _deploySplitZapper(address(this), operatorSafe);
        vault.setZapper(address(split));
    }

    // ──────────────────────── The two tiers ────────────────────

    function test_Roles_OwnerAndOperatorAreSeparateAddresses() public view {
        assertEq(split.owner(), address(this), "the owner is the upgrade authority (the timelock in production)");
        assertEq(split.operator(), operatorSafe, "the operator holds the immediate levers (the multisig)");
    }

    /// @dev The operator retunes the guard at once; the owner and a stranger are refused with
    ///      the operator-tier error, which names the operator that would have been allowed.
    function test_SetTwapParams_IsOperatorOnly() public {
        vm.expectRevert(abi.encodeWithSelector(LPZapper.NotOperator.selector, address(this), operatorSafe));
        split.setTwapParams(600, 100);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(LPZapper.NotOperator.selector, stranger, operatorSafe));
        split.setTwapParams(600, 100);

        vm.expectEmit(false, false, false, true, address(split));
        emit TwapGuard.TwapParamsSet(600, 100);
        vm.prank(operatorSafe);
        split.setTwapParams(600, 100);
        assertEq(split.twapWindow(), 600, "the operator's retune is stored");
        assertEq(split.maxTwapDeviationTicks(), 100, "both parameters");
    }

    function test_Sweep_IsOperatorOnly() public {
        vm.prank(alice);
        usdcToken.transfer(address(split), 250e6);

        vm.expectRevert(abi.encodeWithSelector(LPZapper.NotOperator.selector, address(this), operatorSafe));
        split.sweep(address(usdcToken), 250e6, carol);

        uint256 carolBefore = usdcToken.balanceOf(carol);
        vm.prank(operatorSafe);
        split.sweep(address(usdcToken), 250e6, carol);
        assertEq(usdcToken.balanceOf(carol) - carolBefore, 250e6, "the operator's sweep reaches the named recipient");
    }

    /// @dev The rescue goes to `operator()` — never to the owner, a timelock that has no way to
    ///      forward an ERC-721 — and only the operator may call it.
    function test_RescuePosition_IsOperatorOnlyAndLandsOnTheOperator() public {
        uint256 tokenId = _createPosition(alice, TICK_LOWER, TICK_UPPER, LIQUIDITY);
        vm.prank(alice);
        npmMock.transferFrom(alice, address(split), tokenId);

        vm.expectRevert(abi.encodeWithSelector(LPZapper.NotOperator.selector, address(this), operatorSafe));
        split.rescuePosition(tokenId);

        vm.expectEmit(true, true, false, true, address(split));
        emit LPZapper.PositionRescued(tokenId, operatorSafe, block.timestamp);
        vm.prank(operatorSafe);
        split.rescuePosition(tokenId);
        assertEq(npmMock.ownerOf(tokenId), operatorSafe, "the stray NFT lands on operator()");
    }

    /// @dev Moving the operator is owner-only, rejects zero, announces both sides, and moves
    ///      every lever in the same transaction.
    function test_SetOperator_IsOwnerOnlyRejectsZeroAndMovesTheLevers() public {
        vm.prank(operatorSafe);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operatorSafe));
        split.setOperator(operatorSafe);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        split.setOperator(stranger);

        vm.expectRevert(LPZapper.ZeroAddress.selector);
        split.setOperator(address(0));

        vm.expectEmit(false, false, false, true, address(split));
        emit LPZapper.OperatorSet(operatorSafe, carol);
        split.setOperator(carol);
        assertEq(split.operator(), carol, "the new operator is stored");

        vm.prank(operatorSafe);
        vm.expectRevert(abi.encodeWithSelector(LPZapper.NotOperator.selector, operatorSafe, carol));
        split.setTwapParams(600, 100);
        vm.prank(carol);
        split.setTwapParams(600, 100);
        assertEq(split.twapWindow(), 600, "the levers moved with the role");
    }

    // ──────────────────────── Initialisation ───────────────────

    /// @dev Every mutable field is written AND emitted by `initialize`, in this order, so the
    ///      state is rebuildable from the proxy's deployment logs alone.
    function test_Initialize_AnnouncesOwnerOperatorAndTwapParamsInOrder() public {
        address impl = _zapperImpl();

        vm.expectEmit(true, true, false, true);
        emit Ownable.OwnershipTransferred(address(0), address(this));
        vm.expectEmit(false, false, false, true);
        emit LPZapper.OperatorSet(address(0), operatorSafe);
        vm.expectEmit(false, false, false, true);
        emit TwapGuard.TwapParamsSet(MIN_TWAP_WINDOW, 500);
        LPZapper fresh = LPZapper(
            address(
                new LPProxy(
                    impl, abi.encodeCall(LPZapper.initialize, (address(this), operatorSafe, MIN_TWAP_WINDOW, 500))
                )
            )
        );

        assertEq(fresh.owner(), address(this), "the owner is what OwnershipTransferred announced");
        assertEq(fresh.operator(), operatorSafe, "the operator is what OperatorSet announced");
        assertEq(fresh.twapWindow(), MIN_TWAP_WINDOW, "the window is what TwapParamsSet announced");
        assertEq(fresh.maxTwapDeviationTicks(), 500, "and so is the deviation ceiling");
    }

    function test_Initialize_RejectsAZeroOperator() public {
        address impl = _zapperImpl();
        vm.expectRevert(LPZapper.ZeroAddress.selector);
        new LPProxy(impl, abi.encodeCall(LPZapper.initialize, (address(this), address(0), MIN_TWAP_WINDOW, 500)));
    }

    function test_Initialize_RejectsAZeroOwner() public {
        address impl = _zapperImpl();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new LPProxy(impl, abi.encodeCall(LPZapper.initialize, (address(0), operatorSafe, MIN_TWAP_WINDOW, 500)));
    }

    /// @dev The TWAP bounds moved out of the old constructor with the parameters themselves;
    ///      both bounds of both parameters still fire, now through the proxy's initialisation.
    function test_Initialize_EnforcesTheTwapBounds() public {
        address impl = _zapperImpl();

        vm.expectRevert(
            abi.encodeWithSelector(
                TwapGuard.InvalidTwapWindow.selector, MIN_TWAP_WINDOW - 1, MIN_TWAP_WINDOW, MAX_TWAP_WINDOW
            )
        );
        new LPProxy(impl, abi.encodeCall(LPZapper.initialize, (address(this), operatorSafe, MIN_TWAP_WINDOW - 1, 500)));

        vm.expectRevert(
            abi.encodeWithSelector(
                TwapGuard.InvalidTwapWindow.selector, MAX_TWAP_WINDOW + 1, MIN_TWAP_WINDOW, MAX_TWAP_WINDOW
            )
        );
        new LPProxy(impl, abi.encodeCall(LPZapper.initialize, (address(this), operatorSafe, MAX_TWAP_WINDOW + 1, 500)));

        vm.expectRevert(
            abi.encodeWithSelector(TwapGuard.InvalidTwapDeviation.selector, uint24(0), MAX_TWAP_DEVIATION_TICKS)
        );
        new LPProxy(impl, abi.encodeCall(LPZapper.initialize, (address(this), operatorSafe, MIN_TWAP_WINDOW, 0)));

        vm.expectRevert(
            abi.encodeWithSelector(
                TwapGuard.InvalidTwapDeviation.selector, MAX_TWAP_DEVIATION_TICKS + 1, MAX_TWAP_DEVIATION_TICKS
            )
        );
        new LPProxy(
            impl,
            abi.encodeCall(
                LPZapper.initialize, (address(this), operatorSafe, MIN_TWAP_WINDOW, MAX_TWAP_DEVIATION_TICKS + 1)
            )
        );
    }

    /// @dev A proxy is initialised exactly once: a second call cannot re-seat the owner or the
    ///      operator.
    function test_Initialize_CannotRunTwiceOnTheProxy() public {
        vm.prank(stranger);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        split.initialize(stranger, stranger, MIN_TWAP_WINDOW, 500);
    }

    /// @dev The bare implementation is inert: its initializers are burnt in its constructor,
    ///      so nobody can take ownership of the code the proxy delegates to.
    function test_Initialize_IsDisabledOnTheBareImplementation() public {
        LPZapper impl = LPZapper(_zapperImpl());
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(address(this), operatorSafe, MIN_TWAP_WINDOW, 500);
    }

    /// @dev The implementation constructor still runs every check on its nine immutables:
    ///      zero addresses, the token order, the live pool triple and the USDC/ASSET pair.
    function test_Constructor_StillChecksEveryImmutable() public {
        vm.expectRevert(LPZapper.ZeroAddress.selector);
        new LPZapper(
            address(0),
            address(npmMock),
            address(poolMock),
            token0,
            token1,
            FEE,
            address(routerMock),
            address(usdcToken),
            address(asset)
        );

        vm.expectRevert(abi.encodeWithSelector(LPZapper.TokensNotSorted.selector, token1, token0));
        new LPZapper(
            address(vault),
            address(npmMock),
            address(poolMock),
            token1,
            token0,
            FEE,
            address(routerMock),
            address(usdcToken),
            address(asset)
        );

        MockUniswapV3Pool wrong = new MockUniswapV3Pool(token0, token1, FEE);
        wrong.setFee(500);
        vm.expectRevert(abi.encodeWithSelector(LPZapper.PoolMismatch.selector, token0, token1, uint24(500)));
        new LPZapper(
            address(vault),
            address(npmMock),
            address(wrong),
            token0,
            token1,
            FEE,
            address(routerMock),
            address(usdcToken),
            address(asset)
        );

        MockERC20Permit outsider = new MockERC20Permit("Outsider", "OUT", 1e24, 18);
        vm.expectRevert(
            abi.encodeWithSelector(
                LPZapper.TokenPairMismatch.selector, address(outsider), address(asset), token0, token1
            )
        );
        new LPZapper(
            address(vault),
            address(npmMock),
            address(poolMock),
            token0,
            token1,
            FEE,
            address(routerMock),
            address(outsider),
            address(asset)
        );
    }

    // ──────────────────────── Storage ──────────────────────────

    /**
     * @dev The zapper's own namespace, pinned: recomputed from its ERC-7201 id and read through
     *      the slots' actual contents. Slot 0 is the operator; slot 1 is the NFT receive guard,
     *      which `initialize` must seed to NOT_RECEIVING (1) — an inline initializer would never
     *      have run behind the proxy, and a zero guard is a guard nobody designed.
     */
    function test_Storage_LivesAtThePinnedErc7201Slot() public view {
        bytes32 expected =
            keccak256(abi.encode(uint256(keccak256("real.lp.storage.LPZapper")) - 1)) & ~bytes32(uint256(0xff));
        assertEq(expected, ZAPPER_STORAGE, "the pinned literal matches the ERC-7201 derivation");

        assertEq(
            address(uint160(uint256(vm.load(address(split), ZAPPER_STORAGE)))),
            operatorSafe,
            "namespace slot 0 must be `operator`"
        );
        assertEq(
            uint256(vm.load(address(split), bytes32(uint256(ZAPPER_STORAGE) + 1))),
            1,
            "namespace slot 1 must be `receiveGuard`, seeded to NOT_RECEIVING"
        );
    }

    // ──────────────────────── Upgrade ──────────────────────────

    /**
     * @dev The upgrade the timelock would schedule: owner-only, through `upgradeToAndCall` with
     *      a reinitializer. Everything V1 held survives — owner, operator, both TWAP parameters,
     *      the receive guard — V2's own state lands in its own namespace, the vault still points
     *      at the SAME proxy address, and a real zap works through the upgraded code.
     */
    function test_Upgrade_KeepsEveryRoleAndParameterAndTheZapStillWorks() public {
        vm.prank(operatorSafe);
        split.setTwapParams(900, 300);

        address v2 = address(
            new LPZapperV2Mock(
                address(vault),
                address(npmMock),
                address(poolMock),
                token0,
                token1,
                FEE,
                address(routerMock),
                address(usdcToken),
                address(asset)
            )
        );

        split.upgradeToAndCall(v2, abi.encodeCall(LPZapperV2Mock.initializeV2, (42)));

        assertEq(
            address(uint160(uint256(vm.load(address(split), ERC1967Utils.IMPLEMENTATION_SLOT)))),
            v2,
            "the ERC-1967 slot names the new code"
        );
        assertEq(LPZapperV2Mock(address(split)).version(), 2, "the proxy runs V2");
        assertEq(LPZapperV2Mock(address(split)).upgradeMarker(), 42, "V2's reinitializer ran once");

        assertEq(split.owner(), address(this), "the owner survives the upgrade");
        assertEq(split.operator(), operatorSafe, "the operator survives the upgrade");
        assertEq(split.twapWindow(), 900, "the window survives the upgrade");
        assertEq(split.maxTwapDeviationTicks(), 300, "the deviation ceiling survives the upgrade");
        assertEq(
            uint256(vm.load(address(split), bytes32(uint256(ZAPPER_STORAGE) + 1))),
            1,
            "the receive guard survives at NOT_RECEIVING"
        );
        assertEq(vault.zapper(), address(split), "the vault still whitelists the same proxy address");

        vm.startPrank(alice);
        usdcToken.approve(address(split), ZAP);
        uint256 tokenId = split.zapIn(ZAP, TICK_LOWER, TICK_UPPER, _noSwap(), FAR_DEADLINE);
        vm.stopPrank();
        assertEq(vault.stakerOf(tokenId), alice, "a zap through the upgraded code stakes for the caller");

        // The reinitializer cannot run again, and V1's initializer is burnt for good.
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        LPZapperV2Mock(address(split)).initializeV2(7);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        split.initialize(stranger, stranger, MIN_TWAP_WINDOW, 500);
    }

    /// @dev Only the owner upgrades: the operator — which holds every immediate lever — and a
    ///      stranger are both refused, and the code does not move.
    function test_Upgrade_RejectsEveryoneButTheOwner() public {
        address v2 = address(
            new LPZapperV2Mock(
                address(vault),
                address(npmMock),
                address(poolMock),
                token0,
                token1,
                FEE,
                address(routerMock),
                address(usdcToken),
                address(asset)
            )
        );
        address before = address(uint160(uint256(vm.load(address(split), ERC1967Utils.IMPLEMENTATION_SLOT))));

        vm.prank(operatorSafe);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operatorSafe));
        split.upgradeToAndCall(v2, "");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        split.upgradeToAndCall(v2, "");

        assertEq(
            address(uint160(uint256(vm.load(address(split), ERC1967Utils.IMPLEMENTATION_SLOT)))),
            before,
            "a refused upgrade leaves the implementation where it was"
        );
    }

    /// @dev Renouncing is disabled: an ownerless zapper could never be upgraded nor have its
    ///      operator moved. A stranger meets the ownership check first.
    function test_RenounceOwnership_IsDisabled() public {
        vm.expectRevert(LPZapper.RenounceDisabled.selector);
        split.renounceOwnership();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        split.renounceOwnership();
        assertEq(split.owner(), address(this), "the owner stays");
    }

    // ──────────────────────── Helpers ──────────────────────────

    function _deploySplitZapper(address owner_, address operator_) private returns (LPZapper) {
        return _deployZapperProxy(
            ZapperProxyParams({
                vault: address(vault),
                positionManager: address(npmMock),
                pool: address(poolMock),
                token0: token0,
                token1: token1,
                fee: FEE,
                swapRouter: address(routerMock),
                usdc: address(usdcToken),
                asset: address(asset),
                owner: owner_,
                operator: operator_,
                twapWindow: MIN_TWAP_WINDOW,
                maxDeviationTicks: 500
            })
        );
    }

    /// @dev A bare zapper implementation on the harness market, never initialised.
    function _zapperImpl() private returns (address) {
        return address(
            new LPZapper(
                address(vault),
                address(npmMock),
                address(poolMock),
                token0,
                token1,
                FEE,
                address(routerMock),
                address(usdcToken),
                address(asset)
            )
        );
    }
}
