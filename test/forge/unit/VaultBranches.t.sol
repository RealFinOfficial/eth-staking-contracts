// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {LocalHarness} from "../utils/LocalHarness.sol";
import {LPStakingVault} from "../../../contracts/lp-staking/LPStakingVault.sol";
import {SwapParams} from "../../../contracts/lp-staking/libraries/TwapGuard.sol";
import {INonfungiblePositionManager} from "../../../contracts/lp-staking/interfaces/INonfungiblePositionManager.sol";
import {MockUniswapV3Pool} from "../../../contracts/lp-staking/mocks/MockUniswapV3Pool.sol";
import {MockPositionManager} from "../../../contracts/lp-staking/mocks/MockPositionManager.sol";
import {MockSwapRouter} from "../../../contracts/lp-staking/mocks/MockSwapRouter.sol";
import {ContractStakerNoReceiver} from "../../../contracts/lp-staking/mocks/ContractStakerNoReceiver.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
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

    // ──────────────────────── Constructor ──────────────────────

    function test_Constructor_RejectsAZeroPositionManager() public {
        vm.expectRevert(LPStakingVault.ZeroAddress.selector);
        new LPStakingVault(
            address(0), address(poolMock), token0, token1, FEE, address(routerMock), address(this), MIN_TWAP_WINDOW, 500
        );
    }

    function test_Constructor_RejectsAZeroSwapRouter() public {
        vm.expectRevert(LPStakingVault.ZeroAddress.selector);
        new LPStakingVault(
            address(npmMock), address(poolMock), token0, token1, FEE, address(0), address(this), MIN_TWAP_WINDOW, 500
        );
    }

    function test_Constructor_RejectsAZeroToken0() public {
        vm.expectRevert(LPStakingVault.ZeroAddress.selector);
        new LPStakingVault(
            address(npmMock),
            address(poolMock),
            address(0),
            token1,
            FEE,
            address(routerMock),
            address(this),
            MIN_TWAP_WINDOW,
            500
        );
    }

    function test_Constructor_RejectsAZeroToken1() public {
        vm.expectRevert(LPStakingVault.ZeroAddress.selector);
        new LPStakingVault(
            address(npmMock),
            address(poolMock),
            token0,
            address(0),
            FEE,
            address(routerMock),
            address(this),
            MIN_TWAP_WINDOW,
            500
        );
    }

    /// @dev The `>=` in `_token0 >= _token1` has two arms; this is the strictly-greater one.
    function test_Constructor_RejectsAnUnsortedPair() public {
        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.TokensNotSorted.selector, token1, token0));
        new LPStakingVault(
            address(npmMock),
            address(poolMock),
            token1,
            token0,
            FEE,
            address(routerMock),
            address(this),
            MIN_TWAP_WINDOW,
            500
        );
    }

    /// @dev ...and this is the equal one, which a `>` alone would have let through.
    function test_Constructor_RejectsTheSameTokenTwice() public {
        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.TokensNotSorted.selector, token0, token0));
        new LPStakingVault(
            address(npmMock),
            address(poolMock),
            token0,
            token0,
            FEE,
            address(routerMock),
            address(this),
            MIN_TWAP_WINDOW,
            500
        );
    }

    function test_Constructor_RejectsAPoolWhoseToken0Differs() public {
        MockUniswapV3Pool wrong = new MockUniswapV3Pool(token0, token1, FEE);
        wrong.setTokens(address(0xdead), token1);

        vm.expectRevert(
            abi.encodeWithSelector(LPStakingVault.PoolMismatch.selector, address(0xdead), token1, uint24(FEE))
        );
        new LPStakingVault(
            address(npmMock),
            address(wrong),
            token0,
            token1,
            FEE,
            address(routerMock),
            address(this),
            MIN_TWAP_WINDOW,
            500
        );
    }

    function test_Constructor_RejectsAPoolWhoseToken1Differs() public {
        MockUniswapV3Pool wrong = new MockUniswapV3Pool(token0, token1, FEE);
        wrong.setTokens(token0, address(0xbeef));

        vm.expectRevert(
            abi.encodeWithSelector(LPStakingVault.PoolMismatch.selector, token0, address(0xbeef), uint24(FEE))
        );
        new LPStakingVault(
            address(npmMock),
            address(wrong),
            token0,
            token1,
            FEE,
            address(routerMock),
            address(this),
            MIN_TWAP_WINDOW,
            500
        );
    }

    function test_Constructor_RejectsAPoolWhoseFeeDiffers() public {
        MockUniswapV3Pool wrong = new MockUniswapV3Pool(token0, token1, FEE);
        wrong.setFee(500);

        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.PoolMismatch.selector, token0, token1, uint24(500)));
        new LPStakingVault(
            address(npmMock),
            address(wrong),
            token0,
            token1,
            FEE,
            address(routerMock),
            address(this),
            MIN_TWAP_WINDOW,
            500
        );
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

    function test_RescuePosition_SendsAnUnrecordedPositionToTheOwner() public {
        uint256 tokenId = _createPosition(alice, TICK_LOWER, TICK_UPPER, LIQUIDITY);
        vm.prank(alice);
        npmMock.transferFrom(alice, address(vault), tokenId);

        vault.rescuePosition(tokenId);
        assertEq(npmMock.ownerOf(tokenId), address(this), "the rescue must land on owner(), not on a caller argument");
    }

    /// @dev `renounceOwnership` is live and one-way. What dies with the owner, measured on
    ///      the vault: every admin setter and the rescue path. What survives: the exits.
    function test_RenounceOwnership_KillsTheAdminSurfaceButNotTheExits() public {
        uint256 tokenId = _stakePosition(alice);
        vault.renounceOwnership();
        assertEq(vault.owner(), address(0), "ownership really is gone");

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        vault.setZapper(address(1));

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        vault.setDepositsPaused(true);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        vault.setRebalancePaused(true);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        vault.setTwapParams(600, 100);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        vault.rescuePosition(1);

        vm.prank(alice);
        vault.unstake(tokenId);
        assertEq(npmMock.ownerOf(tokenId), alice, "the exit must survive the loss of the owner");
    }

    // ──────────────────────── Helpers ──────────────────────────

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
