// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkHarness} from "../utils/ForkHarness.sol";
import {LPStakingVault} from "../../../contracts/lp-staking/LPStakingVault.sol";
import {LPZapper} from "../../../contracts/lp-staking/LPZapper.sol";
import {SwapParams} from "../../../contracts/lp-staking/libraries/TwapGuard.sol";
import {IERC20Like} from "../utils/Interfaces.sol";

/**
 * @notice Why this file exists: the audit notes claim that the caller's own `amountOutMin` /
 *         `amount0Min` / `amount1Min` are "the exact protection" and that the TWAP guard is
 *         only a circuit breaker. That is a testable claim about where value can be lost,
 *         and it can only be measured against a real pool with real price impact.
 *
 *  Two of the five findings live here:
 *    * SEC-02 — the guard is evaluated BEFORE the trade and skipped entirely when
 *      `amountIn == 0`, so neither the swap's own impact nor a no-swap rebalance is covered.
 *    * the corollary — everything inside the guard's tolerance is free MEV, and nothing
 *      on-chain forces a caller to pass non-zero minimums.
 */
contract SwapSlippageMEVTest is ForkHarness {
    /// @dev ~350 ticks at the seeded depth: a real sandwich that stays INSIDE the 500-tick
    ///      ceiling, which is the case the guard cannot help with.
    uint256 internal constant SANDWICH_USDC = 100_000e6;
    /// @dev ~700 ticks: outside the ceiling, used where the guard must trip.
    uint256 internal constant PUSH_UP_USDC = 500_000e6;

    uint256 internal constant ZAP_USDC = 20_000e6;

    function setUp() public {
        _deployForkedStack();
    }

    // ──────────────────────── SEC-02 ───────────────────────────

    /**
     * @dev FINDING SEC-02 (S-03), part 1: `_checkTwapDeviation` runs BEFORE
     *      `swapRouter.exactInputSingle`, so the guard sees the market as it was and the
     *      swap's own price impact is entirely outside it. Here the pre-trade deviation is
     *      inside the ceiling, the vault's own swap then pushes spot past it, and the
     *      transaction still succeeds. Asserted as the CURRENT behaviour; the caller's
     *      `amountOutMin` is the only thing that bounds it.
     */
    function test_SEC02_TheSwapsOwnImpactIsOutsideThePreTradeGuard() public {
        _fund(profile.asset, alice, 2_000_000e18);
        _fund(profile.usdc, alice, 2_000_000e6);

        int24 tick = _currentTick();
        uint256 tokenId =
            _mintPositionFor(alice, _alignDown(tick) - 600, _alignUp(tick) + 600, 1_000_000e18, 1_000_000e6);
        _stakeAs(alice, tokenId);

        (,,, bool withinBoundsBefore) = vault.previewTwap();
        assertTrue(withinBoundsBefore, "precondition: the guard passes on the market as it stands");

        // The vault's own swap, out of the position it just emptied.
        SwapParams memory swap =
            SwapParams({zeroForOne: false, amountIn: 400_000e6, amountOutMin: 0, amount0Min: 0, amount1Min: 0});
        vm.prank(alice);
        uint256 newTokenId = vault.rebalance(tokenId, MIN_TICK_ALIGNED, MAX_TICK_ALIGNED, swap, FAR_DEADLINE);

        assertEq(vault.stakerOf(newTokenId), alice, "the rebalance completed despite its own impact");
        assertGt(
            _deviationTicks(),
            uint256(profile.maxDevTicks),
            "the swap itself left spot further from the TWAP than the guard would ever admit"
        );
    }

    /**
     * @dev SEC-02, part 2 — and DELIBERATE since the 2026-08-26 review (recommendation 3),
     *      not a finding. `rebalance` only calls `_executeSwap` when `swap.amountIn > 0`, so
     *      a no-swap rebalance never touches the guard: a range move must stay available at
     *      any price, and it is the fallback the frontend offers while the guard is tripped
     *      ("move range now, optimize ratio later"). The price of that is stated in the
     *      {SwapParams} NatSpec: with `amountIn == 0` the mint minimums are the only
     *      protection on the mint, so they must be quoted tightly. Pinned here so the skip
     *      cannot be removed by accident.
     */
    function test_SEC02_NoSwapRebalanceNeverConsultsTheGuard() public {
        uint256 tokenId = _mintAndStake(alice, 600);
        _pushSpotUp(PUSH_UP_USDC);
        assertGt(_deviationTicks(), uint256(profile.maxDevTicks), "precondition: the guard is tripped");

        int24 tick = _currentTick();
        vm.prank(alice);
        uint256 newTokenId =
            vault.rebalance(tokenId, _alignDown(tick) - 6000, _alignDown(tick) - 60, _noSwap(), FAR_DEADLINE);

        assertEq(vault.stakerOf(newTokenId), alice, "the re-mint happened at a price the guard rejects for swaps");
        assertGt(_deviationTicks(), uint256(profile.maxDevTicks), "and the market was still manipulated when it did");
    }

    // ──────────────────────── Sandwiching ──────────────────────

    /**
     * @dev Everything inside the guard's tolerance is free. The identical zap-in, run
     *      against a market a whale has pushed by ~350 ticks — under the 500-tick ceiling —
     *      buys measurably less liquidity, and nothing reverts.
     */
    function test_Sandwich_InsideTheGuardsToleranceCostsTheZapperRealLiquidity() public {
        int24 tick = _currentTick();
        int24 lower = _alignDown(tick) - 6000;
        int24 upper = _alignUp(tick) + 6000;

        uint256 snap = vm.snapshotState();
        uint256 cleanLiquidity = _zapAndReadLiquidity(alice, lower, upper);
        vm.revertToState(snap);

        _pushSpotUp(SANDWICH_USDC);
        assertLe(_deviationTicks(), uint256(profile.maxDevTicks), "the sandwich must stay inside the guard's ceiling");
        uint256 sandwichedLiquidity = _zapAndReadLiquidity(alice, lower, upper);

        assertLt(sandwichedLiquidity, cleanLiquidity, "a sandwich inside the tolerance really does cost the zapper");
    }

    /// @dev And the stated remedy works: a realistic `amountOutMin`, quoted off the clean
    ///      market, turns the same sandwich into a revert instead of a loss.
    function test_Sandwich_AmountOutMinTurnsTheLossIntoARevert() public {
        uint256 snap = vm.snapshotState();
        uint256 cleanOut = _swap(dave, profile.usdc, profile.asset, 10_000e6, 0);
        vm.revertToState(snap);

        _pushSpotUp(SANDWICH_USDC);

        int24 tick = _currentTick();
        // 99.5% of the clean quote: tighter than the sandwich, looser than ordinary noise.
        SwapParams memory swap = SwapParams({
            zeroForOne: false, amountIn: 10_000e6, amountOutMin: (cleanOut * 995) / 1000, amount0Min: 0, amount1Min: 0
        });

        vm.startPrank(alice);
        usdcToken.approve(address(zapper), ZAP_USDC);
        vm.expectRevert(bytes("Too little received"));
        zapper.zapIn(ZAP_USDC, _alignDown(tick) - 6000, _alignUp(tick) + 6000, swap, FAR_DEADLINE);
        vm.stopPrank();
    }

    /// @dev The mint-side minimums are the other half of the caller's protection.
    function test_Sandwich_MintMinimumsRevertTheZapBeforeTheMintLands() public {
        int24 tick = _currentTick();
        SwapParams memory swap = SwapParams({
            zeroForOne: false,
            amountIn: 10_000e6,
            amountOutMin: 0,
            amount0Min: type(uint128).max, // unattainable on purpose
            amount1Min: 0
        });

        vm.startPrank(alice);
        usdcToken.approve(address(zapper), ZAP_USDC);
        vm.expectRevert(bytes("Price slippage check"));
        zapper.zapIn(ZAP_USDC, _alignDown(tick) - 6000, _alignUp(tick) + 6000, swap, FAR_DEADLINE);
        vm.stopPrank();
    }

    function test_Sandwich_MintMinimumsRevertTheRebalanceBeforeTheMintLands() public {
        uint256 tokenId = _mintAndStake(alice, 600);
        SwapParams memory swap = SwapParams({
            zeroForOne: false, amountIn: 1_000e6, amountOutMin: 0, amount0Min: type(uint128).max, amount1Min: 0
        });

        vm.prank(alice);
        vm.expectRevert(bytes("Price slippage check"));
        vault.rebalance(tokenId, MIN_TICK_ALIGNED, MAX_TICK_ALIGNED, swap, FAR_DEADLINE);
    }

    // ──────────────────────── Input bounds ─────────────────────

    /// @dev The vault can only swap what it actually holds, and says so with the numbers.
    function test_Rebalance_RevertsWhenSwapAmountExceedsTheVaultsBalance() public {
        uint256 tokenId = _mintAndStake(alice, 600);

        uint256 absurd = 1_000_000_000e6;
        SwapParams memory swap =
            SwapParams({zeroForOne: false, amountIn: absurd, amountOutMin: 0, amount0Min: 0, amount1Min: 0});

        vm.prank(alice);
        vm.expectPartialRevert(LPStakingVault.SwapAmountExceedsBalance.selector);
        vault.rebalance(tokenId, MIN_TICK_ALIGNED, MAX_TICK_ALIGNED, swap, FAR_DEADLINE);
    }

    /// @dev The zapper can only spend what it just pulled, and checks before any value moves.
    function test_ZapIn_RevertsWhenSwapAmountExceedsTheInput() public {
        int24 tick = _currentTick();
        SwapParams memory swap =
            SwapParams({zeroForOne: false, amountIn: ZAP_USDC + 1, amountOutMin: 0, amount0Min: 0, amount1Min: 0});

        vm.startPrank(alice);
        usdcToken.approve(address(zapper), ZAP_USDC);
        vm.expectRevert(abi.encodeWithSelector(LPZapper.SwapAmountExceedsInput.selector, ZAP_USDC + 1, ZAP_USDC));
        zapper.zapIn(ZAP_USDC, _alignDown(tick) - 6000, _alignUp(tick) + 6000, swap, FAR_DEADLINE);
        vm.stopPrank();
    }

    /// @dev A zap-in is USDC -> ASSET only; the direction is pinned by the pool's ordering.
    function test_ZapIn_RevertsOnTheWrongSwapDirection() public {
        int24 tick = _currentTick();
        bool wrongDirection = !zapper.usdcIsToken0();
        SwapParams memory swap =
            SwapParams({zeroForOne: wrongDirection, amountIn: 1_000e6, amountOutMin: 0, amount0Min: 0, amount1Min: 0});

        vm.startPrank(alice);
        usdcToken.approve(address(zapper), ZAP_USDC);
        vm.expectRevert(
            abi.encodeWithSelector(LPZapper.InvalidSwapDirection.selector, wrongDirection, zapper.usdcIsToken0())
        );
        zapper.zapIn(ZAP_USDC, _alignDown(tick) - 6000, _alignUp(tick) + 6000, swap, FAR_DEADLINE);
        vm.stopPrank();
    }

    function test_ZapIn_RevertsOnAZeroAmount() public {
        int24 tick = _currentTick();
        vm.prank(alice);
        vm.expectRevert(LPZapper.ZeroAmount.selector);
        zapper.zapIn(0, _alignDown(tick) - 6000, _alignUp(tick) + 6000, _noSwap(), FAR_DEADLINE);
    }

    /**
     * @dev A position that has drifted out of range holds ONE token, and a swap-free
     *      rebalance into a two-sided range therefore has nothing to put on the other leg:
     *      Uniswap refuses a zero-liquidity mint. Documented here because it is the reason a
     *      re-range of an out-of-range position needs a swap leg, and because the revert is
     *      a bare pool revert with no message to interpret.
     */
    function test_Rebalance_SingleSidedWithdrawalCannotFillATwoSidedRange() public {
        uint256 tokenId = _mintAndStake(alice, 600);
        _pushSpotUp(PUSH_UP_USDC); // spot leaves the range upward -> the position is pure token1

        vm.prank(alice);
        vm.expectRevert();
        vault.rebalance(tokenId, MIN_TICK_ALIGNED, MAX_TICK_ALIGNED, _noSwap(), FAR_DEADLINE);
    }

    function test_Rebalance_EnforcesTheCallersDeadline() public {
        uint256 tokenId = _mintAndStake(alice, 600);

        vm.prank(alice);
        vm.expectRevert(bytes("Transaction too old"));
        vault.rebalance(tokenId, MIN_TICK_ALIGNED, MAX_TICK_ALIGNED, _noSwap(), block.timestamp - 1);
    }

    // ──────────────────────── Residue ──────────────────────────

    /// @dev The vault's own claim: it holds no fungible balance between transactions.
    function test_Rebalance_LeavesNoTokenResidueInTheVault() public {
        uint256 tokenId = _mintAndStake(alice, 600);

        SwapParams memory swap =
            SwapParams({zeroForOne: false, amountIn: 1_000e6, amountOutMin: 0, amount0Min: 0, amount1Min: 0});
        vm.prank(alice);
        vault.rebalance(tokenId, MIN_TICK_ALIGNED, MAX_TICK_ALIGNED, swap, FAR_DEADLINE);

        assertEq(IERC20Like(token0).balanceOf(address(vault)), 0, "no token0 may stay in the vault");
        assertEq(IERC20Like(token1).balanceOf(address(vault)), 0, "no token1 may stay in the vault");
    }

    /// @dev And the zapper's, including that the leftovers really reach the user.
    function test_ZapIn_LeavesNoTokenResidueInTheZapper() public {
        int24 tick = _currentTick();
        uint256 usdcBefore = usdcToken.balanceOf(alice);
        uint256 assetBefore = asset.balanceOf(alice);

        SwapParams memory swap =
            SwapParams({zeroForOne: false, amountIn: 10_000e6, amountOutMin: 0, amount0Min: 0, amount1Min: 0});
        vm.startPrank(alice);
        usdcToken.approve(address(zapper), ZAP_USDC);
        zapper.zapIn(ZAP_USDC, _alignDown(tick) - 6000, _alignUp(tick) + 6000, swap, FAR_DEADLINE);
        vm.stopPrank();

        assertEq(IERC20Like(token0).balanceOf(address(zapper)), 0, "no token0 may stay in the zapper");
        assertEq(IERC20Like(token1).balanceOf(address(zapper)), 0, "no token1 may stay in the zapper");
        assertLt(usdcToken.balanceOf(alice), usdcBefore, "the zap must have consumed USDC");
        assertGe(asset.balanceOf(alice), assetBefore, "leftover ASSET must come back to the caller, never stay behind");
    }

    // ──────────────────────── Helpers ──────────────────────────

    /// @dev Runs one zap-in for `who` and returns the liquidity the resulting position holds.
    function _zapAndReadLiquidity(address who, int24 lower, int24 upper) private returns (uint128 liquidity) {
        SwapParams memory swap =
            SwapParams({zeroForOne: false, amountIn: 10_000e6, amountOutMin: 0, amount0Min: 0, amount1Min: 0});
        vm.startPrank(who);
        usdcToken.approve(address(zapper), ZAP_USDC);
        uint256 tokenId = zapper.zapIn(ZAP_USDC, lower, upper, swap, FAR_DEADLINE);
        vm.stopPrank();
        (,,,,,,, liquidity,,,,) = npm.positions(tokenId);
    }
}
