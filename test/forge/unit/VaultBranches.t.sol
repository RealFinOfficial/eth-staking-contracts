// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {LocalHarness} from "../utils/LocalHarness.sol";
import {LPStakingVault} from "../../../contracts/lp-staking/LPStakingVault.sol";
import {LPStakingVaultV2Mock} from "../../../contracts/lp-staking/mocks/LPStakingVaultV2Mock.sol";
import {LPStakingVaultSwapHarness} from "../../../contracts/lp-staking/mocks/LPStakingVaultSwapHarness.sol";
import {LPProxy} from "../../../contracts/lp-staking/deploy/LPProxy.sol";
import {LPZapper} from "../../../contracts/lp-staking/LPZapper.sol";
import {SwapParams, TwapGuard} from "../../../contracts/lp-staking/libraries/TwapGuard.sol";
import {INonfungiblePositionManager} from "../../../contracts/lp-staking/interfaces/INonfungiblePositionManager.sol";
import {MockUniswapV3Pool} from "../../../contracts/lp-staking/mocks/MockUniswapV3Pool.sol";
import {MockPositionManager} from "../../../contracts/lp-staking/mocks/MockPositionManager.sol";
import {MockSwapRouter} from "../../../contracts/lp-staking/mocks/MockSwapRouter.sol";
import {ContractStakerNoReceiver} from "../../../contracts/lp-staking/mocks/ContractStakerNoReceiver.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/**
 * @notice Why this file exists: every comparison, every revert selector and every
 *         single-sided arm in {LPStakingVault}, stated as an assertion and taken to its
 *         exact boundary. The fork tier proves the vault works against real Uniswap; this
 *         one proves there is no branch in it nobody has ever executed.
 *
 *  Deterministic on purpose. Reaching a `PoolMismatch` sub-branch, a zero-liquidity
 *  `_withdrawAll`, or a mint that consumes exactly half of one side needs a market that does
 *  what the test says — which is what the repo's mocks are for.
 */
contract VaultBranchesTest is LocalHarness {
    function setUp() public {
        _deployLocalStack();
    }

    // ──────────────────────── Implementation constructor ───────
    //
    // The six immutables are the implementation's only constructor work, so their checks —
    // including the live pool triple check, which compares three of them against the pool —
    // fire on the IMPLEMENTATION deploy, before any proxy exists.

    function test_Constructor_RejectsAZeroPositionManager() public {
        vm.expectRevert(LPStakingVault.ZeroAddress.selector);
        new LPStakingVault(address(0), address(poolMock), token0, token1, FEE, address(routerMock));
    }

    function test_Constructor_RejectsAZeroSwapRouter() public {
        vm.expectRevert(LPStakingVault.ZeroAddress.selector);
        new LPStakingVault(address(npmMock), address(poolMock), token0, token1, FEE, address(0));
    }

    function test_Constructor_RejectsAZeroToken0() public {
        vm.expectRevert(LPStakingVault.ZeroAddress.selector);
        new LPStakingVault(address(npmMock), address(poolMock), address(0), token1, FEE, address(routerMock));
    }

    function test_Constructor_RejectsAZeroToken1() public {
        vm.expectRevert(LPStakingVault.ZeroAddress.selector);
        new LPStakingVault(address(npmMock), address(poolMock), token0, address(0), FEE, address(routerMock));
    }

    /// @dev The `>=` in `_token0 >= _token1` has two arms; this is the strictly-greater one.
    function test_Constructor_RejectsAnUnsortedPair() public {
        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.TokensNotSorted.selector, token1, token0));
        new LPStakingVault(address(npmMock), address(poolMock), token1, token0, FEE, address(routerMock));
    }

    /// @dev ...and this is the equal one, which a `>` alone would have let through.
    function test_Constructor_RejectsTheSameTokenTwice() public {
        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.TokensNotSorted.selector, token0, token0));
        new LPStakingVault(address(npmMock), address(poolMock), token0, token0, FEE, address(routerMock));
    }

    function test_Constructor_RejectsAPoolWhoseToken0Differs() public {
        MockUniswapV3Pool wrong = new MockUniswapV3Pool(token0, token1, FEE);
        wrong.setTokens(address(0xdead), token1);

        vm.expectRevert(
            abi.encodeWithSelector(LPStakingVault.PoolMismatch.selector, address(0xdead), token1, uint24(FEE))
        );
        new LPStakingVault(address(npmMock), address(wrong), token0, token1, FEE, address(routerMock));
    }

    function test_Constructor_RejectsAPoolWhoseToken1Differs() public {
        MockUniswapV3Pool wrong = new MockUniswapV3Pool(token0, token1, FEE);
        wrong.setTokens(token0, address(0xbeef));

        vm.expectRevert(
            abi.encodeWithSelector(LPStakingVault.PoolMismatch.selector, token0, address(0xbeef), uint24(FEE))
        );
        new LPStakingVault(address(npmMock), address(wrong), token0, token1, FEE, address(routerMock));
    }

    function test_Constructor_RejectsAPoolWhoseFeeDiffers() public {
        MockUniswapV3Pool wrong = new MockUniswapV3Pool(token0, token1, FEE);
        wrong.setFee(500);

        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.PoolMismatch.selector, token0, token1, uint24(500)));
        new LPStakingVault(address(npmMock), address(wrong), token0, token1, FEE, address(routerMock));
    }

    /// @dev A bare implementation must be inert: its initializers are burnt in its own
    ///      constructor, so nobody can take ownership of the code the proxy delegates to.
    function test_Constructor_DisablesTheImplementationsInitializers() public {
        LPStakingVault impl =
            new LPStakingVault(address(npmMock), address(poolMock), token0, token1, FEE, address(routerMock));

        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(address(this), multisig, operatorSafe, address(0), MIN_TWAP_WINDOW, 500);
    }

    function test_Constructor_StoresTheWholeConfiguration() public view {
        assertEq(address(vault.positionManager()), address(npmMock), "the position manager must be stored");
        assertEq(address(vault.swapRouter()), address(routerMock), "the router must be stored");
        assertEq(address(vault.pool()), address(poolMock), "the pool must be stored");
        assertEq(vault.token0(), token0, "token0 must be stored");
        assertEq(vault.token1(), token1, "token1 must be stored");
        assertEq(vault.fee(), FEE, "the fee tier must be stored");
        assertFalse(vault.depositsPaused(), "a fresh vault must accept deposits");
        assertFalse(vault.rebalancePaused(), "a fresh vault must allow rebalancing");
    }

    // ──────────────────────── Initializer ──────────────────────

    function test_Initialize_RejectsAZeroOwner() public {
        address impl = address(_vaultImplementation());

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new LPProxy(
            impl,
            abi.encodeCall(
                LPStakingVault.initialize, (address(0), multisig, operatorSafe, address(0), MIN_TWAP_WINDOW, 500)
            )
        );
    }

    function test_Initialize_RejectsAZeroGuardian() public {
        address impl = address(_vaultImplementation());

        vm.expectRevert(LPStakingVault.ZeroAddress.selector);
        new LPProxy(
            impl,
            abi.encodeCall(
                LPStakingVault.initialize, (address(this), address(0), operatorSafe, address(0), MIN_TWAP_WINDOW, 500)
            )
        );
    }

    /// @dev The operator's zero check shares the `||` with the guardian's, so it needs its own
    ///      arm: a zero operator would leave `setTwapParams` and `rescuePosition` callable by
    ///      nobody, and the two pause switches held by the guardian alone.
    function test_Initialize_RejectsAZeroOperator() public {
        address impl = address(_vaultImplementation());

        vm.expectRevert(LPStakingVault.ZeroAddress.selector);
        new LPProxy(
            impl,
            abi.encodeCall(
                LPStakingVault.initialize, (address(this), multisig, address(0), address(0), MIN_TWAP_WINDOW, 500)
            )
        );
    }

    /**
     * @dev The zapper is an `initialize` argument now, which is what lets the deploy script
     *      hand the proxy straight to the timelock with the zap path already open: nobody has
     *      to send an owner-tier `setZapper` at bootstrap. This reproduces the script's own
     *      move — pre-compute the CREATE address of a contract that does not exist yet, pass
     *      it to `initialize`, and check the deployment lands exactly there.
     */
    function test_Initialize_AcceptsAPreComputedZapperAddress() public {
        address impl = address(_vaultImplementation());

        // The proxy is the NEXT deployment from this address, and the zapper the one after
        // it — the same (deployer, nonce) arithmetic `hre.ethers.getCreateAddress` does in
        // scripts/deploy-lp-staking.js, where every transaction carries an explicit nonce.
        uint64 nonce = vm.getNonce(address(this));
        address predictedZapper = vm.computeCreateAddress(address(this), nonce + 1);

        LPStakingVault born = LPStakingVault(
            address(
                new LPProxy(
                    impl,
                    abi.encodeCall(
                        LPStakingVault.initialize,
                        (address(this), multisig, operatorSafe, predictedZapper, MIN_TWAP_WINDOW, 500)
                    )
                )
            )
        );

        LPZapper deployed = new LPZapper(
            address(born),
            address(npmMock),
            address(poolMock),
            token0,
            token1,
            FEE,
            address(routerMock),
            address(usdcToken),
            address(asset),
            address(this),
            MIN_TWAP_WINDOW,
            500
        );

        assertEq(address(deployed), predictedZapper, "the zapper must land on the pre-computed address");
        assertEq(born.zapper(), address(deployed), "and the vault must have been born already pointing at it");

        // The proof that matters: the zap path is open with no `setZapper` transaction in
        // between, so the proxy could have been owned by the timelock from block one.
        vm.startPrank(carol);
        usdcToken.approve(address(deployed), 1_000e6);
        uint256 tokenId = deployed.zapIn(1_000e6, TICK_LOWER, TICK_UPPER, _noSwap(), FAR_DEADLINE);
        vm.stopPrank();
        assertEq(born.stakerOf(tokenId), carol, "a zap must go through with no post-deploy wiring at all");
    }

    /// @dev The TWAP bounds moved out of the constructor with the parameters themselves, so
    ///      both arms of each bound now fire through the proxy's initialisation.
    function test_Initialize_EnforcesTheTwapBounds() public {
        address impl = address(_vaultImplementation());

        vm.expectRevert(
            abi.encodeWithSelector(
                TwapGuard.InvalidTwapWindow.selector, MIN_TWAP_WINDOW - 1, MIN_TWAP_WINDOW, MAX_TWAP_WINDOW
            )
        );
        new LPProxy(
            impl,
            abi.encodeCall(
                LPStakingVault.initialize, (address(this), multisig, operatorSafe, address(0), MIN_TWAP_WINDOW - 1, 500)
            )
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                TwapGuard.InvalidTwapWindow.selector, MAX_TWAP_WINDOW + 1, MIN_TWAP_WINDOW, MAX_TWAP_WINDOW
            )
        );
        new LPProxy(
            impl,
            abi.encodeCall(
                LPStakingVault.initialize, (address(this), multisig, operatorSafe, address(0), MAX_TWAP_WINDOW + 1, 500)
            )
        );

        vm.expectRevert(
            abi.encodeWithSelector(TwapGuard.InvalidTwapDeviation.selector, uint24(0), MAX_TWAP_DEVIATION_TICKS)
        );
        new LPProxy(
            impl,
            abi.encodeCall(
                LPStakingVault.initialize, (address(this), multisig, operatorSafe, address(0), MIN_TWAP_WINDOW, 0)
            )
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                TwapGuard.InvalidTwapDeviation.selector, MAX_TWAP_DEVIATION_TICKS + 1, MAX_TWAP_DEVIATION_TICKS
            )
        );
        new LPProxy(
            impl,
            abi.encodeCall(
                LPStakingVault.initialize,
                (address(this), multisig, operatorSafe, address(0), MIN_TWAP_WINDOW, MAX_TWAP_DEVIATION_TICKS + 1)
            )
        );
    }

    /**
     * @dev Every mutable field must be followable from logs alone, from block one — the two
     *      pause flags whose initial value is `false` and the zapper included, so an indexer
     *      never has to hardcode a default. This asserts the FULL ordered list of §6 of the
     *      change request, and the order is the one `initialize` writes it in.
     */
    function test_Initialize_AnnouncesEveryInitialFieldInOrder() public {
        LPStakingVault impl = _vaultImplementation();

        vm.expectEmit(false, false, false, true);
        emit LPStakingVault.GuardianSet(address(0), multisig);
        vm.expectEmit(false, false, false, true);
        emit LPStakingVault.OperatorSet(address(0), operatorSafe);
        vm.expectEmit(false, false, false, true);
        emit LPStakingVault.ZapperSet(address(0), address(0xcafe));
        vm.expectEmit(false, false, false, true);
        emit LPStakingVault.DepositsPausedSet(false);
        vm.expectEmit(false, false, false, true);
        emit LPStakingVault.RebalancePausedSet(false);
        vm.expectEmit(false, false, false, true);
        emit TwapGuard.TwapParamsSet(MIN_TWAP_WINDOW, 500);
        LPStakingVault fresh = LPStakingVault(
            address(
                new LPProxy(
                    address(impl),
                    abi.encodeCall(
                        LPStakingVault.initialize,
                        (address(this), multisig, operatorSafe, address(0xcafe), MIN_TWAP_WINDOW, 500)
                    )
                )
            )
        );

        // The events are the whole state, so the state has to agree with them.
        assertEq(fresh.guardian(), multisig, "the guardian must be what GuardianSet announced");
        assertEq(fresh.operator(), operatorSafe, "the operator must be what OperatorSet announced");
        assertEq(fresh.zapper(), address(0xcafe), "the zapper must be what ZapperSet announced");
        assertFalse(fresh.depositsPaused(), "the deposit switch must be what DepositsPausedSet announced");
        assertFalse(fresh.rebalancePaused(), "the rebalance switch must be what RebalancePausedSet announced");
        assertEq(fresh.twapWindow(), MIN_TWAP_WINDOW, "the window must be what TwapParamsSet announced");
    }

    /// @dev A proxy is initialised exactly once; a second call cannot re-seat the owner.
    function test_Initialize_CannotRunTwiceOnTheProxy() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        vault.initialize(alice, alice, alice, alice, MIN_TWAP_WINDOW, 500);
    }

    /**
     * @dev The receive guard is the one field whose inline initializer the proxy would have
     *      swallowed. Left at zero it equals neither {RECEIVING} nor NOT_RECEIVING, and
     *      `onERC721Received` — which rejects anything that is not RECEIVING — would still
     *      reject, but a stake would then be the thing that breaks. This proves the seeding:
     *      an unsolicited safe transfer is rejected AND a stake goes through.
     */
    function test_Initialize_SeedsTheReceiveGuard() public {
        uint256 stray = _createPosition(bob, TICK_LOWER, TICK_UPPER, LIQUIDITY);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.UnsolicitedPosition.selector, bob, bob, stray));
        npmMock.safeTransferFrom(bob, address(vault), stray);

        uint256 tokenId = _stakePosition(alice);
        assertEq(vault.stakerOf(tokenId), alice, "and the guard still opens for a real stake");
    }

    /**
     * @dev The custody ledger's address, pinned. `LP_STAKING_VAULT_STORAGE` is a literal in
     *      the contract because it must never move: if it did, every `stakerOf` would read
     *      zero after an upgrade, and a zero record is exactly the state `rescuePosition` is
     *      allowed to act on. This recomputes the ERC-7201 derivation and checks the literal
     *      against it, through the slot's actual contents.
     */
    function test_Storage_LivesAtThePinnedErc7201Slot() public {
        bytes32 expected =
            keccak256(abi.encode(uint256(keccak256("real.lp.storage.LPStakingVault")) - 1)) & ~bytes32(uint256(0xff));

        vault.setDepositsPaused(true);
        vault.setRebalancePaused(true);

        // Namespace slot 0 is `zapper` alone (20 bytes, and `guardian` needs another 20).
        assertEq(
            address(uint160(uint256(vm.load(address(vault), expected)))),
            address(zapper),
            "namespace slot 0 must be `zapper`"
        );

        // Slot 1 packs `guardian` with the two pause flags that follow it.
        uint256 slot1 = uint256(vm.load(address(vault), bytes32(uint256(expected) + 1)));
        assertEq(address(uint160(slot1)), address(this), "namespace slot 1 must start with `guardian`");
        assertEq((slot1 >> 160) & 0xff, 1, "`depositsPaused` must sit right after `guardian`");
        assertEq((slot1 >> 168) & 0xff, 1, "`rebalancePaused` must sit right after `depositsPaused`");

        // Slot 2 is `receiveGuard` and slot 3 the `stakers` mapping's base; `operator` was
        // APPENDED after them, so it opens slot 4 and the custody ledger did not move.
        uint256 slot4 = uint256(vm.load(address(vault), bytes32(uint256(expected) + 4)));
        assertEq(address(uint160(slot4)), address(this), "namespace slot 4 must be `operator`");
    }

    /// @dev {TwapGuard}'s parameters have a namespace of their own, shared with the zapper.
    ///      Same pin, same reason: an upgrade must not move them either.
    function test_Storage_TheTwapGuardHasItsOwnPinnedNamespace() public view {
        bytes32 expected =
            keccak256(abi.encode(uint256(keccak256("real.lp.storage.TwapGuard")) - 1)) & ~bytes32(uint256(0xff));

        uint256 packed = uint256(vm.load(address(vault), expected));
        assertEq(uint32(packed), MIN_TWAP_WINDOW, "namespace slot 0 must start with `twapWindow`");
        assertEq(uint24(packed >> 32), 500, "`maxTwapDeviationTicks` must sit right after it");

        // And the plain zapper reads the very same slot on its own storage.
        uint256 zapperPacked = uint256(vm.load(address(zapper), expected));
        assertEq(uint32(zapperPacked), MIN_TWAP_WINDOW, "the zapper shares the namespace, not the storage");
    }

    // ──────────────────────── Stake validation ─────────────────

    function test_Stake_RevertsWhileDepositsArePaused() public {
        uint256 tokenId = _createPosition(alice, TICK_LOWER, TICK_UPPER, LIQUIDITY);
        vault.setDepositsPaused(true);

        vm.startPrank(alice);
        npmMock.approve(address(vault), tokenId);
        vm.expectRevert(LPStakingVault.DepositsArePaused.selector);
        vault.stake(tokenId);
        vm.stopPrank();
    }

    function test_Stake_RevertsOnAPositionWithAForeignToken0() public {
        uint256 tokenId =
            _createPositionOn(alice, address(0xdead), token1, FEE, TICK_LOWER, TICK_UPPER, LIQUIDITY, 0, 0);

        vm.startPrank(alice);
        npmMock.approve(address(vault), tokenId);
        vm.expectRevert(
            abi.encodeWithSelector(
                LPStakingVault.PositionPoolMismatch.selector, tokenId, address(0xdead), token1, uint24(FEE)
            )
        );
        vault.stake(tokenId);
        vm.stopPrank();
    }

    function test_Stake_RevertsOnAPositionWithAForeignToken1() public {
        uint256 tokenId =
            _createPositionOn(alice, token0, address(0xbeef), FEE, TICK_LOWER, TICK_UPPER, LIQUIDITY, 0, 0);

        vm.startPrank(alice);
        npmMock.approve(address(vault), tokenId);
        vm.expectRevert(
            abi.encodeWithSelector(
                LPStakingVault.PositionPoolMismatch.selector, tokenId, token0, address(0xbeef), uint24(FEE)
            )
        );
        vault.stake(tokenId);
        vm.stopPrank();
    }

    function test_Stake_RevertsOnAPositionFromAnotherFeeTier() public {
        uint256 tokenId = _createPositionOn(alice, token0, token1, 500, TICK_LOWER, TICK_UPPER, LIQUIDITY, 0, 0);

        vm.startPrank(alice);
        npmMock.approve(address(vault), tokenId);
        vm.expectRevert(
            abi.encodeWithSelector(LPStakingVault.PositionPoolMismatch.selector, tokenId, token0, token1, uint24(500))
        );
        vault.stake(tokenId);
        vm.stopPrank();
    }

    /// @dev `liquidity == 0` is the exact boundary; one wei of liquidity is enough.
    function test_Stake_RevertsOnZeroLiquidityButAcceptsOne() public {
        uint256 empty = _createPositionOn(alice, token0, token1, FEE, TICK_LOWER, TICK_UPPER, 0, 0, 0);
        vm.startPrank(alice);
        npmMock.approve(address(vault), empty);
        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.EmptyPosition.selector, empty));
        vault.stake(empty);
        vm.stopPrank();

        uint256 minimal = _createPositionOn(alice, token0, token1, FEE, TICK_LOWER, TICK_UPPER, 1, 0, 0);
        vm.startPrank(alice);
        npmMock.approve(address(vault), minimal);
        vault.stake(minimal);
        vm.stopPrank();
        assertEq(vault.stakerOf(minimal), alice, "one wei of liquidity is a real position");
    }

    function test_Stake_RevertsWhenTheTokenIsAlreadyStaked() public {
        uint256 tokenId = _stakePosition(alice);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.AlreadyStaked.selector, tokenId, alice));
        vault.stake(tokenId);
    }

    function test_StakeWithPermit_TakesCustodyWithNoPriorApproval() public {
        uint256 tokenId = _createPosition(alice, TICK_LOWER, TICK_UPPER, LIQUIDITY);

        vm.prank(alice);
        vault.stakeWithPermit(tokenId, FAR_DEADLINE, 27, bytes32(0), bytes32(0));

        assertEq(vault.stakerOf(tokenId), alice, "the permit alone must be enough");
        assertEq(npmMock.permitCalls(), 1, "the permit really was submitted");
    }

    function test_StakeWithPermit_BubblesTheManagersPermitFailure() public {
        uint256 tokenId = _createPosition(alice, TICK_LOWER, TICK_UPPER, LIQUIDITY);
        npmMock.setPermitShouldFail(true);

        vm.prank(alice);
        vm.expectRevert(bytes("Permit failed"));
        vault.stakeWithPermit(tokenId, FAR_DEADLINE, 27, bytes32(0), bytes32(0));
    }

    // ──────────────────────── stakeFor ─────────────────────────

    function test_StakeFor_RevertsForAnyCallerButTheZapper() public {
        uint256 tokenId = _createPosition(alice, TICK_LOWER, TICK_UPPER, LIQUIDITY);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.NotZapper.selector, alice, address(zapper)));
        vault.stakeFor(alice, tokenId);
    }

    function test_StakeFor_RevertsForTheZeroUser() public {
        uint256 tokenId = _createPosition(address(zapper), TICK_LOWER, TICK_UPPER, LIQUIDITY);

        vm.startPrank(address(zapper));
        npmMock.approve(address(vault), tokenId);
        vm.expectRevert(LPStakingVault.ZeroAddress.selector);
        vault.stakeFor(address(0), tokenId);
        vm.stopPrank();
    }

    /// @dev With no zapper configured the whole path is closed rather than open to everyone —
    ///      the `zapper_ == address(0)` arm of the two-part check.
    function test_StakeFor_IsClosedWhenTheZapperIsUnset() public {
        vault.setZapper(address(0));
        uint256 tokenId = _createPosition(alice, TICK_LOWER, TICK_UPPER, LIQUIDITY);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.NotZapper.selector, alice, address(0)));
        vault.stakeFor(alice, tokenId);
    }

    function test_StakeFor_CreditsTheNamedUserNotTheZapper() public {
        uint256 tokenId = _createPosition(address(zapper), TICK_LOWER, TICK_UPPER, LIQUIDITY);

        vm.startPrank(address(zapper));
        npmMock.approve(address(vault), tokenId);
        vault.stakeFor(bob, tokenId);
        vm.stopPrank();

        assertEq(vault.stakerOf(tokenId), bob, "the credited user must be the one named, not the caller");
    }

    // ──────────────────────── stakeFor: stake operators ────────
    //
    // The second route in (integration spec §6.2). `carol` stands in for the ApeBond adapter:
    // the vault checks nothing about an operator but its address, so a plain account reaches
    // exactly the code the adapter will.

    /// @dev The allowlist sits BESIDE the zapper rather than replacing it — the OR's second
    ///      operand, with the first one false.
    function test_StakeFor_AcceptsAnAllowlistedOperator() public {
        vault.setStakeOperator(carol, true);
        uint256 tokenId = _createPosition(carol, TICK_LOWER, TICK_UPPER, LIQUIDITY);

        vm.startPrank(carol);
        npmMock.approve(address(vault), tokenId);
        vault.stakeFor(bob, tokenId);
        vm.stopPrank();

        assertEq(vault.stakerOf(tokenId), bob, "an operator credits the user it names");
        assertEq(npmMock.ownerOf(tokenId), address(vault), "and the vault takes custody from it");
        assertEq(vault.zapper(), address(zapper), "while the zapper's own route is untouched");
    }

    /// @dev Revoking is immediate: the same caller, the same NFT, the same call, rejected.
    function test_StakeFor_RevertsForADeAllowlistedOperator() public {
        vault.setStakeOperator(carol, true);
        vault.setStakeOperator(carol, false);
        uint256 tokenId = _createPosition(carol, TICK_LOWER, TICK_UPPER, LIQUIDITY);

        vm.startPrank(carol);
        npmMock.approve(address(vault), tokenId);
        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.NotZapper.selector, carol, address(zapper)));
        vault.stakeFor(bob, tokenId);
        vm.stopPrank();

        assertFalse(vault.isStakeOperator(carol), "and the allowlist reads false for it");
    }

    /// @dev The two routes are independent. With `zapper` at zero the whole zapper half is
    ///      false — see {test_StakeFor_IsClosedWhenTheZapperIsUnset} — and an operator still
    ///      gets in, which is what makes this an OR of two separate rights.
    function test_StakeFor_AnOperatorWorksWhileTheZapperIsUnset() public {
        vault.setZapper(address(0));
        vault.setStakeOperator(carol, true);
        uint256 tokenId = _createPosition(carol, TICK_LOWER, TICK_UPPER, LIQUIDITY);

        vm.startPrank(carol);
        npmMock.approve(address(vault), tokenId);
        vault.stakeFor(alice, tokenId);
        vm.stopPrank();

        assertEq(vault.stakerOf(tokenId), alice, "the operator route must not depend on the zapper");
    }

    /// @dev The pause lives inside `_stake`, so it gates every operator too — that is why an
    ///      operator needs no kill switch of its own.
    function test_StakeFor_TheOperatorPathIsGatedByTheDepositPause() public {
        vault.setStakeOperator(carol, true);
        uint256 tokenId = _createPosition(carol, TICK_LOWER, TICK_UPPER, LIQUIDITY);
        vault.setDepositsPaused(true);

        vm.startPrank(carol);
        npmMock.approve(address(vault), tokenId);
        vm.expectRevert(LPStakingVault.DepositsArePaused.selector);
        vault.stakeFor(alice, tokenId);
        vm.stopPrank();
    }

    /// @dev An operator gets no more leeway on the credited user than the zapper does.
    function test_StakeFor_AnOperatorCannotCreditTheZeroUser() public {
        vault.setStakeOperator(carol, true);
        uint256 tokenId = _createPosition(carol, TICK_LOWER, TICK_UPPER, LIQUIDITY);

        vm.startPrank(carol);
        npmMock.approve(address(vault), tokenId);
        vm.expectRevert(LPStakingVault.ZeroAddress.selector);
        vault.stakeFor(address(0), tokenId);
        vm.stopPrank();
    }

    // ──────────────────────── Exits ────────────────────────────

    function test_Unstake_RevertsForANonStakerAndForAnUnknownToken() public {
        uint256 tokenId = _stakePosition(alice);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.NotStaker.selector, tokenId, bob, alice));
        vault.unstake(tokenId);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.NotStaker.selector, uint256(9999), alice, address(0)));
        vault.unstake(9999);
    }

    /// @dev The exit uses a plain `transferFrom` precisely so a contract with no
    ///      `onERC721Received` can still get out. Deposit and withdrawal both, measured.
    function test_Unstake_WorksForAContractStakerWithNoReceiverHook() public {
        ContractStakerNoReceiver staker = new ContractStakerNoReceiver();
        uint256 tokenId = _createPosition(address(staker), TICK_LOWER, TICK_UPPER, LIQUIDITY);

        staker.approveAndStake(address(vault), address(npmMock), tokenId);
        assertEq(vault.stakerOf(tokenId), address(staker), "a hookless contract must be able to deposit");

        staker.unstake(address(vault), tokenId);
        assertEq(npmMock.ownerOf(tokenId), address(staker), "and must be able to get its position back");
    }

    // ──────────────────────── Rebalance ────────────────────────

    function test_Rebalance_RevertsForANonStaker() public {
        uint256 tokenId = _stakePosition(alice);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.NotStaker.selector, tokenId, bob, alice));
        vault.rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, _noSwap(), FAR_DEADLINE);
    }

    /// @dev `swap.amountIn > balance` — the equal case must pass, one wei more must not.
    function test_Rebalance_SwapAmountEqualToTheBalanceIsAllowed() public {
        uint256 tokenId = _stakePosition(alice);
        SwapParams memory swap =
            SwapParams({zeroForOne: true, amountIn: P_ASSET, amountOutMin: 0, amount0Min: 0, amount1Min: 0});

        vm.prank(alice);
        uint256 newTokenId = vault.rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, swap, FAR_DEADLINE);
        assertEq(vault.stakerOf(newTokenId), alice, "swapping the entire balance must be allowed");
    }

    function test_Rebalance_SwapAmountOneWeiOverTheBalanceReverts() public {
        uint256 tokenId = _stakePosition(alice);
        SwapParams memory swap =
            SwapParams({zeroForOne: true, amountIn: P_ASSET + 1, amountOutMin: 0, amount0Min: 0, amount1Min: 0});

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(LPStakingVault.SwapAmountExceedsBalance.selector, token0, P_ASSET + 1, P_ASSET)
        );
        vault.rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, swap, FAR_DEADLINE);
    }

    /// @dev The pause is the first statement of `rebalance`, so it fires before the staker
    ///      check and before a single position read — with and without a swap leg.
    function test_Rebalance_RevertsWhilePaused() public {
        uint256 tokenId = _stakePosition(alice);
        vault.setRebalancePaused(true);

        vm.prank(alice);
        vm.expectRevert(LPStakingVault.RebalanceIsPaused.selector);
        vault.rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, _noSwap(), FAR_DEADLINE);

        SwapParams memory swap =
            SwapParams({zeroForOne: true, amountIn: P_ASSET / 10, amountOutMin: 0, amount0Min: 0, amount1Min: 0});
        vm.prank(alice);
        vm.expectRevert(LPStakingVault.RebalanceIsPaused.selector);
        vault.rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, swap, FAR_DEADLINE);

        assertEq(vault.stakerOf(tokenId), alice, "a rejected rebalance must leave the record untouched");

        // and the identical call goes through once the switch is lifted, so nothing but the
        // pause rejected it
        vault.setRebalancePaused(false);
        vm.prank(alice);
        vault.rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, _noSwap(), FAR_DEADLINE);
    }

    /// @dev `amountIn == 0` skips `_executeSwap` entirely — no approval, no router call.
    function test_Rebalance_ZeroAmountInNeverTouchesTheRouter() public {
        uint256 tokenId = _stakePosition(alice);

        vm.prank(alice);
        vault.rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, _noSwap(), FAR_DEADLINE);

        assertEq(routerMock.swapCalls(), 0, "a zero-amount swap leg must not reach the router at all");
    }

    /// @dev `_withdrawAll`'s `liquidity > 0` false arm: a position already emptied out of band
    ///      must still collect and re-mint rather than reverting on a zero-liquidity decrease.
    function test_Rebalance_HandlesAPositionWhoseLiquidityIsAlreadyZero() public {
        uint256 tokenId = _stakePosition(alice);

        // Drain it from the vault's own address, the only account the manager authorises.
        vm.prank(address(vault));
        npmMock.decreaseLiquidity(
            INonfungiblePositionManager.DecreaseLiquidityParams({
                tokenId: tokenId, liquidity: LIQUIDITY, amount0Min: 0, amount1Min: 0, deadline: FAR_DEADLINE
            })
        );

        vm.prank(alice);
        uint256 newTokenId = vault.rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, _noSwap(), FAR_DEADLINE);
        assertEq(vault.stakerOf(newTokenId), alice, "an already-empty position must still re-range");
    }

    // ──────────────────────── Dust refunds ─────────────────────

    /// @dev Both `_refundDust` arms taken: the mint consumes everything, so neither transfer
    ///      fires and both reported refunds are zero.
    function test_RefundDust_ReportsZeroWhenTheMintConsumesEverything() public {
        uint256 tokenId = _stakePosition(alice);
        npmMock.setMintConsumeBps(10_000);

        vm.recordLogs();
        vm.prank(alice);
        vault.rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, _noSwap(), FAR_DEADLINE);

        (uint256 refund0, uint256 refund1) = _lastRebalanceRefunds();
        assertEq(refund0, 0, "nothing may be refunded on token0 when the mint takes it all");
        assertEq(refund1, 0, "nothing may be refunded on token1 when the mint takes it all");
    }

    /// @dev The token0-only arm: the position holds no token1 at all, so the second `if`
    ///      is false while the first is true.
    function test_RefundDust_TakesTheToken0OnlyArm() public {
        uint256 tokenId = _stakeWithPrincipal(alice, P_ASSET, 0);
        npmMock.setMintConsumeBps(5_000);
        uint256 before = asset.balanceOf(alice);

        vm.recordLogs();
        vm.prank(alice);
        vault.rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, _noSwap(), FAR_DEADLINE);

        (uint256 refund0, uint256 refund1) = _lastRebalanceRefunds();
        assertEq(refund0, P_ASSET / 2, "the unconsumed half of token0 must be refunded");
        assertEq(refund1, 0, "the token1 arm must not fire when there is no token1");
        assertEq(asset.balanceOf(alice) - before, P_ASSET / 2, "and the refund must reach the staker");
    }

    /// @dev The mirror arm: token1 only.
    function test_RefundDust_TakesTheToken1OnlyArm() public {
        uint256 tokenId = _stakeWithPrincipal(alice, 0, P_USDC);
        npmMock.setMintConsumeBps(5_000);
        uint256 before = usdcToken.balanceOf(alice);

        vm.recordLogs();
        vm.prank(alice);
        vault.rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, _noSwap(), FAR_DEADLINE);

        (uint256 refund0, uint256 refund1) = _lastRebalanceRefunds();
        assertEq(refund0, 0, "the token0 arm must not fire when there is no token0");
        assertEq(refund1, P_USDC / 2, "the unconsumed half of token1 must be refunded");
        assertEq(usdcToken.balanceOf(alice) - before, P_USDC / 2, "and the refund must reach the staker");
    }

    function test_RefundDust_TakesBothArmsAtOnce() public {
        uint256 tokenId = _stakePosition(alice);
        npmMock.setMintConsumeBps(5_000);

        vm.recordLogs();
        vm.prank(alice);
        vault.rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, _noSwap(), FAR_DEADLINE);

        (uint256 refund0, uint256 refund1) = _lastRebalanceRefunds();
        assertEq(refund0, P_ASSET / 2, "half of token0 must come back");
        assertEq(refund1, P_USDC / 2, "half of token1 must come back");
    }

    /**
     * @dev The documented "whole balance, not this call's amounts" decision: a stray transfer
     *      sitting on the vault joins the next rebalance's mint, and whatever the mint leaves
     *      goes to THAT rebalancer. Recorded as a measurement because it is a real transfer
     *      of misdirected value from whoever sent it to whoever rebalances next.
     */
    function test_RefundDust_SweepsAStrayBalanceToWhoeverRebalancesNext() public {
        uint256 tokenId = _stakePosition(alice);
        asset.transfer(address(vault), 500e18); // misdirected transfer from a third party
        npmMock.setMintConsumeBps(5_000);
        uint256 before = asset.balanceOf(alice);

        vm.prank(alice);
        vault.rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, _noSwap(), FAR_DEADLINE);

        // Without the stray the mint would have seen 1000e18 and refunded 500e18. It saw
        // 1500e18 instead, so the whole stray is split between this rebalancer's new
        // position and this rebalancer's refund. Either way it is gone from the sender.
        assertEq(
            asset.balanceOf(alice) - before,
            (P_ASSET + 500e18) / 2,
            "the stray joins the mint and its unconsumed half leaves with this rebalancer"
        );
        assertEq(asset.balanceOf(address(vault)), 0, "and nothing stays behind for the sender to reclaim");
    }

    // ──────────────────────── Receiver hook ────────────────────

    function test_Receiver_RejectsAnyNftFromAnotherCollection() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.UnexpectedNftSender.selector, alice));
        vault.onERC721Received(alice, alice, 1, "");
    }

    function test_Receiver_RejectsAGenuinePositionArrivingOutsideAStakeFlow() public {
        vm.prank(address(npmMock));
        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.UnsolicitedPosition.selector, alice, bob, uint256(7)));
        vault.onERC721Received(alice, bob, 7, "");
    }

    /// @dev And the window really does open during a stake: a manager that calls back is
    ///      accepted, which is what the defensive guard in `_stake` is for.
    function test_Receiver_AcceptsTheCallbackDuringAStake() public {
        npmMock.setSafeMintEnabled(true);
        uint256 tokenId = _stakePosition(alice);
        assertEq(vault.stakerOf(tokenId), alice, "a call-back-happy manager must not break staking");
        assertEq(
            IERC721Receiver(address(vault)).onERC721Received.selector,
            IERC721Receiver.onERC721Received.selector,
            "the hook must keep returning the ERC-721 magic value"
        );
    }

    // ──────────────────────── Owner surface ────────────────────

    function test_SetZapper_EmitsBothSidesOfTheChange() public {
        vm.expectEmit(false, false, false, true, address(vault));
        emit LPStakingVault.ZapperSet(address(zapper), address(0xcafe));
        vault.setZapper(address(0xcafe));
        assertEq(vault.zapper(), address(0xcafe), "the new zapper must be stored");
    }

    function test_SetStakeOperator_RejectsTheZeroOperator() public {
        vm.expectRevert(LPStakingVault.ZeroAddress.selector);
        vault.setStakeOperator(address(0), true);
    }

    function test_SetStakeOperator_EmitsTheFullNewStateBothWays() public {
        vm.expectEmit(true, false, false, true, address(vault));
        emit LPStakingVault.StakeOperatorSet(carol, true);
        vault.setStakeOperator(carol, true);
        assertTrue(vault.isStakeOperator(carol), "the grant must be readable");

        vm.expectEmit(true, false, false, true, address(vault));
        emit LPStakingVault.StakeOperatorSet(carol, false);
        vault.setStakeOperator(carol, false);
        assertFalse(vault.isStakeOperator(carol), "and so must the revocation");

        // One address's allowance says nothing about another's — this is a mapping, not a slot.
        assertFalse(vault.isStakeOperator(stranger), "an untouched address must stay off the allowlist");
    }

    function test_SetDepositsPaused_EmitsTheFullNewState() public {
        vm.expectEmit(false, false, false, true, address(vault));
        emit LPStakingVault.DepositsPausedSet(true);
        vault.setDepositsPaused(true);

        vm.expectEmit(false, false, false, true, address(vault));
        emit LPStakingVault.DepositsPausedSet(false);
        vault.setDepositsPaused(false);
    }

    function test_SetRebalancePaused_EmitsTheFullNewState() public {
        vm.expectEmit(false, false, false, true, address(vault));
        emit LPStakingVault.RebalancePausedSet(true);
        vault.setRebalancePaused(true);
        assertTrue(vault.rebalancePaused(), "the flag must follow the event");
        assertFalse(vault.depositsPaused(), "the deposit switch must be untouched by it");

        vm.expectEmit(false, false, false, true, address(vault));
        emit LPStakingVault.RebalancePausedSet(false);
        vault.setRebalancePaused(false);
        assertFalse(vault.rebalancePaused(), "the flag must follow the event back");
    }

    function test_RescuePosition_RefusesAStakedPosition() public {
        uint256 tokenId = _stakePosition(alice);

        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.PositionIsStaked.selector, tokenId, alice));
        vault.rescuePosition(tokenId);
    }

    /**
     * @dev The destination is `operator()` and there is no argument to mistype — not
     *      `owner()`, which after the deploy script is a timelock contract with no way to
     *      forward an ERC-721, and not `guardian()`, which is a hot key that must never move
     *      value. Measured on a twin whose three roles are DIFFERENT addresses, so the
     *      assertion cannot pass by two of them being the same account.
     */
    function test_RescuePosition_SendsAnUnrecordedPositionToTheOperator() public {
        LPStakingVault twin = _guardedTwin();

        uint256 tokenId = _createPosition(alice, TICK_LOWER, TICK_UPPER, LIQUIDITY);
        vm.prank(alice);
        npmMock.transferFrom(alice, address(twin), tokenId);

        vm.expectEmit(true, true, false, true, address(twin));
        emit LPStakingVault.PositionRescued(tokenId, operatorSafe, block.timestamp);
        vm.prank(operatorSafe);
        twin.rescuePosition(tokenId);

        assertEq(npmMock.ownerOf(tokenId), operatorSafe, "the rescue must land on operator(), not on a caller argument");
        assertEq(twin.owner(), address(this), "and the owner must have received nothing");
    }

    /**
     * @dev The split is real in EVERY direction, which is the whole point of three tiers: the
     *      owner reaches neither undelayed tier, the guardian reaches only the two pause
     *      switches, and the operator reaches its own calls plus those same two switches.
     *      Measured on a twin whose three roles are three different addresses.
     */
    function test_AdminFunctions_TheThreeTiersDoNotOverlap() public {
        LPStakingVault twin = _guardedTwin();

        bytes memory ownerPauseRejection = abi.encodeWithSelector(
            LPStakingVault.NotGuardianOrOperator.selector, address(this), multisig, operatorSafe
        );

        // The OWNER is rejected on both pause switches and on every operator function.
        vm.expectRevert(ownerPauseRejection);
        twin.setDepositsPaused(true);
        vm.expectRevert(ownerPauseRejection);
        twin.setRebalancePaused(true);
        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.NotOperator.selector, address(this), operatorSafe));
        twin.setTwapParams(600, 100);
        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.NotOperator.selector, address(this), operatorSafe));
        twin.rescuePosition(1);

        // The GUARDIAN is rejected on every owner function AND on every operator function.
        vm.startPrank(multisig);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, multisig));
        twin.setZapper(address(1));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, multisig));
        twin.setStakeOperator(address(1), true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, multisig));
        twin.setGuardian(multisig);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, multisig));
        twin.setOperator(multisig);
        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.NotOperator.selector, multisig, operatorSafe));
        twin.setTwapParams(600, 100);
        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.NotOperator.selector, multisig, operatorSafe));
        twin.rescuePosition(1);
        vm.stopPrank();

        // The OPERATOR is rejected on every owner function.
        vm.startPrank(operatorSafe);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operatorSafe));
        twin.setZapper(address(1));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operatorSafe));
        twin.setGuardian(operatorSafe);
        vm.stopPrank();

        // Each tier does work from its own address, and each pause takes either of two.
        vm.prank(multisig);
        twin.setDepositsPaused(true);
        assertTrue(twin.depositsPaused(), "the guardian must be able to pause deposits");
        vm.prank(operatorSafe);
        twin.setDepositsPaused(false);
        assertFalse(twin.depositsPaused(), "and so must the operator, as the cold fallback");
        vm.prank(operatorSafe);
        twin.setTwapParams(600, 100);
        assertEq(twin.twapWindow(), 600, "the operator must be able to recalibrate the guard");
        twin.setZapper(address(1));
        assertEq(twin.zapper(), address(1), "the owner must be able to point the zapper");
    }

    function test_SetGuardian_RejectsZeroAndAnnouncesBothSides() public {
        vm.expectRevert(LPStakingVault.ZeroAddress.selector);
        vault.setGuardian(address(0));

        vm.expectEmit(false, false, false, true, address(vault));
        emit LPStakingVault.GuardianSet(address(this), carol);
        vault.setGuardian(carol);
        assertEq(vault.guardian(), carol, "the new guardian must be stored");

        // The old guardian loses the tier immediately. This contract is still the OPERATOR
        // here, so the rejection has to be measured from an address that is neither.
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(LPStakingVault.NotGuardianOrOperator.selector, alice, carol, address(this))
        );
        vault.setDepositsPaused(true);
    }

    /// @dev The operator rotates the same way the guardian does: owner tier, zero rejected,
    ///      both sides announced, and the old holder loses the tier in the same transaction.
    function test_SetOperator_RejectsZeroAndAnnouncesBothSides() public {
        vm.expectRevert(LPStakingVault.ZeroAddress.selector);
        vault.setOperator(address(0));

        vm.expectEmit(false, false, false, true, address(vault));
        emit LPStakingVault.OperatorSet(address(this), carol);
        vault.setOperator(carol);
        assertEq(vault.operator(), carol, "the new operator must be stored");

        // The old operator loses the tier immediately...
        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.NotOperator.selector, address(this), carol));
        vault.setTwapParams(600, 100);

        // ...and the new one holds it, rescue destination included.
        vm.prank(carol);
        vault.setTwapParams(600, 100);
        assertEq(vault.twapWindow(), 600, "the new operator must be able to recalibrate the guard");

        uint256 stray = _createPosition(bob, TICK_LOWER, TICK_UPPER, LIQUIDITY);
        vm.prank(bob);
        npmMock.transferFrom(bob, address(vault), stray);
        vm.prank(carol);
        vault.rescuePosition(stray);
        assertEq(npmMock.ownerOf(stray), carol, "the rescue destination follows the operator");
    }

    /**
     * @dev Renouncing is disabled outright. Under a UUPS proxy an ownerless contract can
     *      never be upgraded again, so the old "what dies with the owner" matrix has been
     *      replaced by making the call impossible. The exits were never the owner's to lose.
     */
    function test_RenounceOwnership_IsDisabled() public {
        uint256 tokenId = _stakePosition(alice);

        vm.expectRevert(LPStakingVault.RenounceDisabled.selector);
        vault.renounceOwnership();
        assertEq(vault.owner(), address(this), "the owner must be exactly where it was");

        // A stranger still gets the standard Ownable rejection, not the reason.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vault.renounceOwnership();

        vm.prank(alice);
        vault.unstake(tokenId);
        assertEq(npmMock.ownerOf(tokenId), alice, "and the exit is unaffected either way");
    }

    // ──────────────────────── Swap leg ─────────────────────────

    /**
     * @dev N-5. SwapRouter02 reads `amountIn == 0` as `Constants.CONTRACT_BALANCE` — "swap the
     *      router's entire balance of `tokenIn`, paid by the router" — so a zero amount must
     *      never reach it. `rebalance` already gates the swap leg behind `swap.amountIn > 0`,
     *      which makes this arm unreachable from the production surface; the guard exists so
     *      no later refactor can drop that gate silently, and the harness is what makes it a
     *      measured branch rather than an unexecuted one.
     */
    function test_ExecuteSwap_RejectsAZeroAmountBeforeTheRouterSeesIt() public {
        LPStakingVaultSwapHarness harness = new LPStakingVaultSwapHarness(
            address(npmMock), address(poolMock), token0, token1, FEE, address(routerMock)
        );

        uint256 callsBefore = routerMock.swapCalls();

        vm.expectRevert(LPStakingVault.ZeroAmount.selector);
        harness.exposedExecuteSwap(
            SwapParams({zeroForOne: true, amountIn: 0, amountOutMin: 0, amount0Min: 0, amount1Min: 0})
        );

        assertEq(routerMock.swapCalls(), callsBefore, "the router must never have been called");
    }

    /// @dev The other arm, through the production path: a rebalance whose swap leg carries a
    ///      real amount reaches the router exactly once.
    function test_ExecuteSwap_AcceptsANonZeroAmountAndReachesTheRouter() public {
        uint256 tokenId = _stakePosition(alice);
        uint256 callsBefore = routerMock.swapCalls();

        vm.prank(alice);
        vault.rebalance(
            tokenId,
            NEW_TICK_LOWER,
            NEW_TICK_UPPER,
            SwapParams({zeroForOne: true, amountIn: P_ASSET / 2, amountOutMin: 0, amount0Min: 0, amount1Min: 0}),
            FAR_DEADLINE
        );

        assertEq(routerMock.swapCalls(), callsBefore + 1, "a non-zero amount must reach the router once");
    }

    // ──────────────────────── Upgrades ─────────────────────────

    /**
     * @dev The reason the proxy exists: the custody ledger must survive a code change. This
     *      upgrades a proxy that already holds a position and checks that every field is
     *      exactly where it was, with new code behind it — and that the staker can still
     *      walk out afterwards.
     */
    function test_Upgrade_PreservesTheStakerLedgerAndBothTiers() public {
        uint256 tokenId = _stakePosition(alice);
        vault.setZapper(address(0xcafe));
        vault.setRebalancePaused(true);

        address v2 = address(_v2Implementation());
        vault.upgradeToAndCall(v2, "");

        assertEq(_implementationOf(address(vault)), v2, "the ERC-1967 slot must name the new code");
        assertEq(LPStakingVaultV2Mock(address(vault)).version(), 2, "the new code must be the one running");
        assertEq(vault.stakerOf(tokenId), alice, "the staker ledger must survive the upgrade");
        assertEq(npmMock.ownerOf(tokenId), address(vault), "and custody with it");
        assertEq(vault.zapper(), address(0xcafe), "the zapper must survive the upgrade");
        assertTrue(vault.rebalancePaused(), "the rebalance pause must survive the upgrade");
        assertFalse(vault.depositsPaused(), "and so must the deposit switch's OFF state");
        assertEq(vault.guardian(), address(this), "the guardian must survive the upgrade");
        assertEq(vault.operator(), address(this), "the operator must survive the upgrade");
        assertEq(vault.owner(), address(this), "the owner must survive the upgrade");
        assertEq(vault.twapWindow(), MIN_TWAP_WINDOW, "the TWAP namespace must survive the upgrade");
        assertEq(vault.maxTwapDeviationTicks(), 500, "the TWAP namespace must survive the upgrade");

        vm.prank(alice);
        vault.unstake(tokenId);
        assertEq(npmMock.ownerOf(tokenId), alice, "and the exit still works against the new code");
    }

    /// @dev V2 writes its own ERC-7201 namespace, so new state cannot collide with V1's.
    function test_Upgrade_V2StateLivesInItsOwnNamespace() public {
        uint256 tokenId = _stakePosition(alice);
        vault.upgradeToAndCall(address(_v2Implementation()), "");

        LPStakingVaultV2Mock upgraded = LPStakingVaultV2Mock(address(vault));
        upgraded.setUpgradeMarker(42);

        assertEq(upgraded.upgradeMarker(), 42, "V2 state must be readable");
        assertEq(vault.stakerOf(tokenId), alice, "and must not have touched V1's namespace");
        assertEq(vault.twapWindow(), MIN_TWAP_WINDOW, "nor the guard's");
    }

    /// @dev Only the owner tier upgrades. Not a stranger, not the guardian, not the operator.
    function test_Upgrade_RejectsEveryoneButTheOwner() public {
        LPStakingVault twin = _guardedTwin();
        address v2 = address(_v2Implementation());

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        twin.upgradeToAndCall(v2, "");

        vm.prank(multisig);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, multisig));
        twin.upgradeToAndCall(v2, "");

        vm.prank(operatorSafe);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operatorSafe));
        twin.upgradeToAndCall(v2, "");

        twin.upgradeToAndCall(v2, "");
        assertEq(_implementationOf(address(twin)), v2, "the owner must be able to upgrade");
    }

    // ──────────────────────── Helpers ──────────────────────────

    /// @dev A bare implementation with the harness's own market wired into its immutables.
    function _vaultImplementation() private returns (LPStakingVault) {
        return new LPStakingVault(address(npmMock), address(poolMock), token0, token1, FEE, address(routerMock));
    }

    function _v2Implementation() private returns (LPStakingVaultV2Mock) {
        return new LPStakingVaultV2Mock(address(npmMock), address(poolMock), token0, token1, FEE, address(routerMock));
    }

    /// @dev A second proxy whose owner (this contract), guardian (`multisig`) and operator
    ///      (`operatorSafe`) are THREE DIFFERENT addresses, which the shared harness
    ///      deliberately collapses into one.
    function _guardedTwin() private returns (LPStakingVault) {
        return _deployVaultProxy(
            VaultProxyParams({
                positionManager: address(npmMock),
                pool: address(poolMock),
                token0: token0,
                token1: token1,
                fee: FEE,
                swapRouter: address(routerMock),
                owner: address(this),
                guardian: multisig,
                operator: operatorSafe,
                zapper: address(0),
                twapWindow: MIN_TWAP_WINDOW,
                maxDeviationTicks: 500
            })
        );
    }

    /// @dev Reads the ERC-1967 implementation slot straight off the proxy.
    function _implementationOf(address proxy) private view returns (address) {
        return address(uint160(uint256(vm.load(proxy, ERC1967Utils.IMPLEMENTATION_SLOT))));
    }

    function _stakeWithPrincipal(address holder, uint256 principal0, uint256 principal1)
        private
        returns (uint256 tokenId)
    {
        tokenId = _createPositionOn(
            holder, token0, token1, FEE, TICK_LOWER, TICK_UPPER, LIQUIDITY, principal0, principal1
        );
        vm.startPrank(holder);
        npmMock.approve(address(vault), tokenId);
        vault.stake(tokenId);
        vm.stopPrank();
    }

    /// @dev Reads `amount0Refunded` / `amount1Refunded` out of the last `Rebalanced` event.
    function _lastRebalanceRefunds() private returns (uint256 refund0, uint256 refund1) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256("Rebalanced(address,uint256,uint256,int24,int24,uint128,uint256,uint256,uint256)");
        for (uint256 i = logs.length; i > 0; --i) {
            Vm.Log memory entry = logs[i - 1];
            if (entry.emitter == address(vault) && entry.topics[0] == topic) {
                (,,, refund0, refund1,) = abi.decode(entry.data, (int24, int24, uint128, uint256, uint256, uint256));
                return (refund0, refund1);
            }
        }
        revert("no Rebalanced event recorded");
    }
}
