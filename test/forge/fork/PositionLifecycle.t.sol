// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkHarness} from "../utils/ForkHarness.sol";
import {LPStakingVault} from "../../../contracts/lp-staking/LPStakingVault.sol";
import {LPZapper} from "../../../contracts/lp-staking/LPZapper.sol";
import {SwapParams} from "../../../contracts/lp-staking/libraries/TwapGuard.sol";
import {IERC20Like} from "../utils/Interfaces.sol";

/**
 * @notice Why this file exists: the day-to-day journey — stake, zap, re-range, exit — is the
 *         product. Everything the unit tier fakes is real here: the mint really consumes an
 *         asymmetric pair of amounts, the position really accrues trading fees, the burn
 *         really destroys the NFT, and the dust refund really is whatever Uniswap left over.
 */
contract PositionLifecycleTest is ForkHarness {
    uint256 internal constant ZAP_USDC = 20_000e6;

    function setUp() public {
        _deployForkedStack();
    }

    // ──────────────────────── Custody ──────────────────────────

    function test_Stake_TakesCustodyAndReportsTheFullRangeState() public {
        uint256 tokenId = _mintAroundSpot(alice, 600);
        (,,,,, int24 lower, int24 upper, uint128 liquidity,,,,) = npm.positions(tokenId);

        vm.startPrank(alice);
        npm.approve(address(vault), tokenId);
        vm.expectEmit(true, true, false, true, address(vault));
        emit LPStakingVault.Staked(alice, tokenId, lower, upper, liquidity, block.timestamp);
        vault.stake(tokenId);
        vm.stopPrank();

        assertEq(npm.ownerOf(tokenId), address(vault), "the vault must own the NFT after a stake");
        assertEq(vault.stakerOf(tokenId), alice, "the staker record must name the depositor");
    }

    function test_Unstake_ReturnsTheNftAndClearsTheRecord() public {
        uint256 tokenId = _mintAndStake(alice, 600);

        vm.expectEmit(true, true, false, true, address(vault));
        emit LPStakingVault.Unstaked(alice, tokenId, block.timestamp);
        vm.prank(alice);
        vault.unstake(tokenId);

        assertEq(npm.ownerOf(tokenId), alice, "the NFT must go back to the staker");
        assertEq(vault.stakerOf(tokenId), address(0), "the record must be cleared on exit");
    }

    function test_Unstake_RevertsForAnyoneButTheStaker() public {
        uint256 tokenId = _mintAndStake(alice, 600);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.NotStaker.selector, tokenId, bob, alice));
        vault.unstake(tokenId);
    }

    // ──────────────────────── Re-ranging ───────────────────────

    function test_Rebalance_MovesTheRangeBurnsTheOldNftAndKeepsCustody() public {
        uint256 tokenId = _mintAndStake(alice, 600);
        int24 tick = _alignDown(_currentTick());
        int24 lower = tick - 1200;
        int24 upper = tick + 1200;

        vm.prank(alice);
        uint256 newTokenId = vault.rebalance(tokenId, lower, upper, _noSwap(), FAR_DEADLINE);

        assertTrue(newTokenId != tokenId, "a rebalance must produce a new position id");
        assertEq(vault.stakerOf(tokenId), address(0), "the old id must stop being staked");
        assertEq(vault.stakerOf(newTokenId), alice, "the new id must carry the same staker");
        assertEq(npm.ownerOf(newTokenId), address(vault), "custody must never leave the vault");

        (,,,,, int24 newLower, int24 newUpper,,,,,) = npm.positions(newTokenId);
        assertEq(newLower, lower, "the new position must sit on the requested lower tick");
        assertEq(newUpper, upper, "the new position must sit on the requested upper tick");

        vm.expectRevert(); // the burned NFT no longer exists
        npm.ownerOf(tokenId);
    }

    /// @dev The compounding claim in the vault header, measured: `collect` sweeps accrued
    ///      trading fees into the vault before the re-mint, so a re-range into the SAME
    ///      ticks comes back with strictly more liquidity than it started with.
    function test_Rebalance_CompoundsAccruedTradingFeesIntoTheNewPosition() public {
        uint256 tokenId = _mintAndStake(alice, 600);
        (,,,,, int24 lower, int24 upper, uint128 liquidityBefore,,,,) = npm.positions(tokenId);

        // Real volume through alice's range, round-tripped so spot comes back.
        for (uint256 i = 0; i < 6; ++i) {
            _advance(60);
            uint256 out = _swap(whale, profile.usdc, profile.asset, 20_000e6, 0);
            _swap(whale, profile.asset, profile.usdc, out, 0);
        }

        vm.prank(alice);
        uint256 newTokenId = vault.rebalance(tokenId, lower, upper, _noSwap(), FAR_DEADLINE);

        (,,,,,,, uint128 liquidityAfter,,,,) = npm.positions(newTokenId);
        assertGt(liquidityAfter, liquidityBefore, "earned fees must compound into the re-ranged position");
    }

    /// @dev Whatever the mint does not consume leaves in the same transaction, to the staker.
    function test_Rebalance_RefundsEveryLeftoverWeiToTheStaker() public {
        uint256 tokenId = _mintAndStake(alice, 600);
        int24 tick = _alignDown(_currentTick());

        uint256 asset0Before = IERC20Like(token0).balanceOf(alice);
        uint256 usdcBefore = IERC20Like(token1).balanceOf(alice);

        // A range entirely below spot consumes token1 only, so the whole token0 side of the
        // withdrawal must come back as a refund — a large, unambiguous number.
        vm.prank(alice);
        vault.rebalance(tokenId, tick - 6000, tick - 60, _noSwap(), FAR_DEADLINE);

        assertGt(IERC20Like(token0).balanceOf(alice), asset0Before, "the unused token0 must reach the staker");
        assertEq(IERC20Like(token0).balanceOf(address(vault)), 0, "and none of it may stay in the vault");
        assertEq(IERC20Like(token1).balanceOf(address(vault)), 0, "nor any token1");
        assertGe(IERC20Like(token1).balanceOf(alice), usdcBefore, "the staker is never worse off in token1");
    }

    function test_Rebalance_ChainsAndKeepsTheSameStakerThroughout() public {
        uint256 tokenId = _mintAndStake(alice, 600);
        int24 tick = _alignDown(_currentTick());

        vm.prank(alice);
        uint256 second = vault.rebalance(tokenId, tick - 1200, tick + 1200, _noSwap(), FAR_DEADLINE);
        vm.prank(alice);
        uint256 third = vault.rebalance(second, tick - 2400, tick + 2400, _noSwap(), FAR_DEADLINE);

        assertEq(vault.stakerOf(second), address(0), "each rebalance must retire the previous id");
        assertEq(vault.stakerOf(third), alice, "the staker must survive an arbitrary chain of re-ranges");

        vm.prank(alice);
        vault.unstake(third);
        assertEq(npm.ownerOf(third), alice, "and the exit still works at the end of the chain");
    }

    function test_Rebalance_RevertsForAnyoneButTheStaker() public {
        uint256 tokenId = _mintAndStake(alice, 600);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.NotStaker.selector, tokenId, bob, alice));
        vault.rebalance(tokenId, MIN_TICK_ALIGNED, MAX_TICK_ALIGNED, _noSwap(), FAR_DEADLINE);
    }

    // ──────────────────────── Zapping ──────────────────────────

    function test_ZapIn_MintsStakesAndCreditsTheCaller() public {
        int24 tick = _currentTick();
        SwapParams memory swap =
            SwapParams({zeroForOne: false, amountIn: 10_000e6, amountOutMin: 0, amount0Min: 0, amount1Min: 0});

        vm.startPrank(alice);
        usdcToken.approve(address(zapper), ZAP_USDC);
        uint256 tokenId = zapper.zapIn(ZAP_USDC, _alignDown(tick) - 6000, _alignUp(tick) + 6000, swap, FAR_DEADLINE);
        vm.stopPrank();

        assertEq(vault.stakerOf(tokenId), alice, "a zap must credit the caller, not the zapper");
        assertEq(npm.ownerOf(tokenId), address(vault), "and custody must end up in the vault");
        assertEq(npm.ownerOf(tokenId), address(vault), "the zapper must not keep the NFT");
    }

    // ──────────────────────── Pause switch ─────────────────────

    function test_DepositsPaused_BlocksNewDepositsButNeverTheExits() public {
        uint256 tokenId = _mintAndStake(alice, 600);
        uint256 fresh = _mintAroundSpot(bob, 600);

        vm.prank(multisig);
        vault.setDepositsPaused(true);

        vm.startPrank(bob);
        npm.approve(address(vault), fresh);
        vm.expectRevert(LPStakingVault.DepositsArePaused.selector);
        vault.stake(fresh);
        vm.stopPrank();

        int24 tick = _alignDown(_currentTick());
        vm.prank(alice);
        uint256 rebalanced = vault.rebalance(tokenId, tick - 1200, tick + 1200, _noSwap(), FAR_DEADLINE);
        assertEq(vault.stakerOf(rebalanced), alice, "a pause must not block re-ranging");

        vm.prank(alice);
        vault.unstake(rebalanced);
        assertEq(npm.ownerOf(rebalanced), alice, "a pause must not block the exit");
    }

    /// @dev F6's mitigation, measured against real Uniswap: the rebalance switch stops the
    ///      complex path and touches nothing else. `unstake` is the fallback it leaves open.
    function test_RebalancePaused_BlocksRebalanceButNeverUnstake() public {
        uint256 tokenId = _mintAndStake(alice, 600);

        vm.prank(multisig);
        vault.setRebalancePaused(true);

        int24 tick = _alignDown(_currentTick());
        vm.prank(alice);
        vm.expectRevert(LPStakingVault.RebalanceIsPaused.selector);
        vault.rebalance(tokenId, tick - 1200, tick + 1200, _noSwap(), FAR_DEADLINE);

        assertEq(vault.stakerOf(tokenId), alice, "the rejected rebalance must leave the record intact");
        assertEq(npm.ownerOf(tokenId), address(vault), "and custody where it was");

        // the exit is unconditional, with BOTH switches on
        vm.prank(multisig);
        vault.setDepositsPaused(true);
        vm.prank(alice);
        vault.unstake(tokenId);
        assertEq(npm.ownerOf(tokenId), alice, "the exit must survive both pauses");
    }

    function test_DepositsPaused_BlocksTheZapPathToo() public {
        vm.prank(multisig);
        vault.setDepositsPaused(true);

        int24 tick = _currentTick();
        SwapParams memory swap =
            SwapParams({zeroForOne: false, amountIn: 10_000e6, amountOutMin: 0, amount0Min: 0, amount1Min: 0});

        vm.startPrank(alice);
        usdcToken.approve(address(zapper), ZAP_USDC);
        vm.expectRevert(LPStakingVault.DepositsArePaused.selector);
        zapper.zapIn(ZAP_USDC, _alignDown(tick) - 6000, _alignUp(tick) + 6000, swap, FAR_DEADLINE);
        vm.stopPrank();
    }

    // ──────────────────────── Stray assets ─────────────────────

    /// @dev A safe transfer arriving outside a stake flow is refused at the hook, so the
    ///      vault can never hold an NFT with no record behind it by that route.
    function test_Receiver_RejectsAnUnsolicitedSafeTransfer() public {
        uint256 tokenId = _mintAroundSpot(alice, 600);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.UnsolicitedPosition.selector, alice, alice, tokenId));
        npm.safeTransferFrom(alice, address(vault), tokenId);
    }

    /// @dev A PLAIN transfer never consults the hook, so this is the route that really can
    ///      strand an NFT — and the one `rescuePosition` exists to undo.
    function test_RescuePosition_RecoversAnNftPushedInWithAPlainTransfer() public {
        uint256 tokenId = _mintAroundSpot(alice, 600);

        vm.prank(alice);
        npm.transferFrom(alice, address(vault), tokenId);
        assertEq(vault.stakerOf(tokenId), address(0), "a pushed-in NFT carries no staker record");

        vm.expectEmit(true, true, false, true, address(vault));
        emit LPStakingVault.PositionRescued(tokenId, multisig, block.timestamp);
        vm.prank(multisig);
        vault.rescuePosition(tokenId);

        assertEq(npm.ownerOf(tokenId), multisig, "the rescue must send the NFT to the owner multisig");
    }

    function test_RescuePosition_IsOwnerOnly() public {
        uint256 tokenId = _mintAroundSpot(alice, 600);
        vm.prank(alice);
        npm.transferFrom(alice, address(vault), tokenId);

        vm.prank(alice);
        vm.expectRevert();
        vault.rescuePosition(tokenId);
    }

    function test_ZapperRescuePosition_RecoversAStrayNft() public {
        uint256 tokenId = _mintAroundSpot(alice, 600);

        vm.prank(alice);
        npm.transferFrom(alice, address(zapper), tokenId);

        vm.expectEmit(true, true, false, true, address(zapper));
        emit LPZapper.PositionRescued(tokenId, multisig, block.timestamp);
        vm.prank(multisig);
        zapper.rescuePosition(tokenId);

        assertEq(npm.ownerOf(tokenId), multisig, "the zapper's rescue must also land on the owner multisig");
    }

    function test_ZapperSweep_RecoversStrayTokens() public {
        uint256 carolBefore = IERC20Like(profile.usdc).balanceOf(carol);
        vm.prank(alice);
        IERC20Like(profile.usdc).transfer(address(zapper), 1_234e6);

        vm.expectEmit(true, true, false, true, address(zapper));
        emit LPZapper.Swept(profile.usdc, carol, 1_234e6);
        vm.prank(multisig);
        zapper.sweep(profile.usdc, 1_234e6, carol);

        assertEq(
            IERC20Like(profile.usdc).balanceOf(carol) - carolBefore,
            1_234e6,
            "the sweep must reach the named recipient in full"
        );
        assertEq(IERC20Like(profile.usdc).balanceOf(address(zapper)), 0, "and clear the zapper");
    }

    function test_ZapperSweep_IsOwnerOnlyAndRejectsTheZeroRecipient() public {
        vm.prank(alice);
        IERC20Like(profile.usdc).transfer(address(zapper), 10e6);

        vm.prank(alice);
        vm.expectRevert();
        zapper.sweep(profile.usdc, 10e6, alice);

        vm.prank(multisig);
        vm.expectRevert(LPZapper.ZeroAddress.selector);
        zapper.sweep(profile.usdc, 10e6, address(0));
    }
}
