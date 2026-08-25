// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkHarness} from "../utils/ForkHarness.sol";
import {LPStakingVault} from "../../../contracts/lp-staking/LPStakingVault.sol";
import {INonfungiblePositionManager} from "../../../contracts/lp-staking/interfaces/INonfungiblePositionManager.sol";
import {INpmExtras, IUniswapV3PoolLike, IERC20Like} from "../utils/Interfaces.sol";

/**
 * @notice Why this file exists: the vault takes tick bounds straight from the caller and
 *         hands them to Uniswap without validating them, and it accepts or rejects a
 *         position purely on the `(token0, token1, fee)` triple the position manager
 *         reports. Both of those are only meaningful against the real tick bitmap, the real
 *         spacing table and a real second fee tier — a mock accepts whatever it is told.
 *
 *  SEC-05 lives here: `stakeFor` validates only `user != 0`, so crediting the vault or the
 *  zapper itself produces a position nothing on-chain can ever move again.
 */
contract TickSpacingTest is ForkHarness {
    function setUp() public {
        _deployForkedStack();
    }

    // ──────────────────────── Tick validity ────────────────────

    /// @dev Every bound must be a multiple of the tier's spacing. The pool enforces it in
    ///      `TickBitmap.flipTick` with a bare `require`, so the caller gets no message at all.
    function test_Ticks_RebalanceIntoAMisalignedRangeRevertsWithoutAMessage() public {
        uint256 tokenId = _mintAndStake(alice, 600);
        int24 tick = _alignDown(_currentTick());

        vm.prank(alice);
        vm.expectRevert();
        vault.rebalance(tokenId, tick - 601, tick + 600, _noSwap(), FAR_DEADLINE);

        assertEq(vault.stakerOf(tokenId), alice, "a rejected rebalance must leave the record untouched");
    }

    function test_Ticks_RebalanceIntoAnInvertedRangeReverts() public {
        uint256 tokenId = _mintAndStake(alice, 600);
        int24 tick = _alignDown(_currentTick());

        vm.prank(alice);
        vm.expectRevert(bytes("TLU"));
        vault.rebalance(tokenId, tick + 600, tick - 600, _noSwap(), FAR_DEADLINE);
    }

    /// @dev A zero-width range never reaches the pool's own `TLU` check: the periphery
    ///      divides by `sqrtRatioB - sqrtRatioA` first and `FullMath.mulDiv` rejects a zero
    ///      denominator with a bare `require`, so this one also carries no message.
    function test_Ticks_RebalanceIntoAZeroWidthRangeRevertsWithoutAMessage() public {
        uint256 tokenId = _mintAndStake(alice, 600);
        int24 tick = _alignDown(_currentTick());

        vm.prank(alice);
        vm.expectRevert();
        vault.rebalance(tokenId, tick, tick, _noSwap(), FAR_DEADLINE);
    }

    /// @dev Out-of-range bounds are caught by `TickMath.getSqrtRatioAtTick` in the periphery
    ///      (bare `T`) before the pool's own `TLM`/`TUM` checks ever run. Measured, not assumed.
    function test_Ticks_RebalanceBelowTheMinimumTickRevertsInTickMath() public {
        uint256 tokenId = _mintAndStake(alice, 600);

        vm.prank(alice);
        vm.expectRevert(bytes("T"));
        vault.rebalance(tokenId, MIN_TICK_ALIGNED - TICK_SPACING * 2000, MAX_TICK_ALIGNED, _noSwap(), FAR_DEADLINE);
    }

    function test_Ticks_RebalanceAboveTheMaximumTickRevertsInTickMath() public {
        uint256 tokenId = _mintAndStake(alice, 600);

        vm.prank(alice);
        vm.expectRevert(bytes("T"));
        vault.rebalance(tokenId, MIN_TICK_ALIGNED, MAX_TICK_ALIGNED + TICK_SPACING * 2000, _noSwap(), FAR_DEADLINE);
    }

    /// @dev The widest range the 60-spacing tier admits really is stakeable and re-rangeable.
    function test_Ticks_FullRangeIsAcceptedAndStakeable() public {
        uint256 tokenId = _mintPositionFor(alice, MIN_TICK_ALIGNED, MAX_TICK_ALIGNED, 10_000e18, 10_000e6);
        _stakeAs(alice, tokenId);

        (,,,,, int24 lower, int24 upper,,,,,) = npm.positions(tokenId);
        assertEq(lower, MIN_TICK_ALIGNED, "the aligned minimum tick must survive the round trip");
        assertEq(upper, MAX_TICK_ALIGNED, "the aligned maximum tick must survive the round trip");
        assertEq(vault.stakerOf(tokenId), alice, "a full-range position must be stakeable");
    }

    // ──────────────────────── Pool identity ────────────────────

    /**
     * @dev A position on the SAME pair but a different fee tier is a different market. The
     *      vault must refuse it, and the real second pool is the only way to prove that with
     *      a genuinely different `tickSpacing` (10 rather than 60) behind it.
     */
    function test_Stake_RejectsAPositionFromAnotherFeeTier() public {
        uint24 otherFee = 500;
        address otherPool =
            npmExtras.createAndInitializePoolIfNecessary(token0, token1, otherFee, profile.initialSqrtPriceX96);
        assertEq(IUniswapV3PoolLike(otherPool).tickSpacing(), 10, "the 0.05% tier must use 10-tick spacing");

        (, int24 tick,,,,,) = IUniswapV3PoolLike(otherPool).slot0();
        int24 lower = (tick / 10) * 10 - 1000;
        int24 upper = (tick / 10) * 10 + 1000;

        vm.startPrank(alice);
        IERC20Like(token0).approve(profile.npm, 10_000e18);
        IERC20Like(token1).approve(profile.npm, 10_000e6);
        (uint256 tokenId,,,) = npm.mint(
            INonfungiblePositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: otherFee,
                tickLower: lower,
                tickUpper: upper,
                amount0Desired: 10_000e18,
                amount1Desired: 10_000e6,
                amount0Min: 0,
                amount1Min: 0,
                recipient: alice,
                deadline: block.timestamp + 1
            })
        );
        npm.approve(address(vault), tokenId);

        vm.expectRevert(
            abi.encodeWithSelector(LPStakingVault.PositionPoolMismatch.selector, tokenId, token0, token1, otherFee)
        );
        vault.stake(tokenId);
        vm.stopPrank();
    }

    /// @dev A position whose liquidity has already been withdrawn carries nothing to score.
    function test_Stake_RejectsAnEmptyPosition() public {
        uint256 tokenId = _mintAroundSpot(alice, 600);
        (,,,,,,, uint128 liquidity,,,,) = npm.positions(tokenId);

        vm.startPrank(alice);
        npm.decreaseLiquidity(
            INonfungiblePositionManager.DecreaseLiquidityParams({
                tokenId: tokenId, liquidity: liquidity, amount0Min: 0, amount1Min: 0, deadline: block.timestamp + 1
            })
        );
        npm.approve(address(vault), tokenId);

        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.EmptyPosition.selector, tokenId));
        vault.stake(tokenId);
        vm.stopPrank();
    }

    function test_Stake_RejectsATokenThatIsAlreadyStaked() public {
        uint256 tokenId = _mintAndStake(alice, 600);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.AlreadyStaked.selector, tokenId, alice));
        vault.stake(tokenId);
    }

    /**
     * @dev `increaseLiquidity` is permissionless on the canonical position manager — it does
     *      not check ownership. Anyone can therefore top up a STAKED position, and the value
     *      lands under the existing staker's record. Not a vulnerability (the donor simply
     *      gives their tokens away), but it is a fact the off-chain scoring has to expect:
     *      a position's liquidity can grow with no vault event behind it.
     */
    function test_ThirdParty_CanIncreaseLiquidityOnAStakedPosition() public {
        uint256 tokenId = _mintAndStake(alice, 600);
        (,,,,,,, uint128 before,,,,) = npm.positions(tokenId);

        vm.startPrank(bob);
        IERC20Like(token0).approve(profile.npm, 5_000e18);
        IERC20Like(token1).approve(profile.npm, 5_000e6);
        npmExtras.increaseLiquidity(
            INpmExtras.IncreaseLiquidityParams({
                tokenId: tokenId,
                amount0Desired: 5_000e18,
                amount1Desired: 5_000e6,
                amount0Min: 0,
                amount1Min: 0,
                deadline: block.timestamp + 1
            })
        );
        vm.stopPrank();

        (,,,,,,, uint128 afterTopUp,,,,) = npm.positions(tokenId);
        assertGt(afterTopUp, before, "a third party really can grow a staked position");
        assertEq(vault.stakerOf(tokenId), alice, "the donated liquidity accrues to the existing staker");

        vm.prank(alice);
        vault.unstake(tokenId);
        assertEq(npm.ownerOf(tokenId), alice, "and the staker keeps the whole, larger position on exit");
    }

    // ──────────────────────── SEC-05 ───────────────────────────

    /**
     * @dev FINDING SEC-05 (P-19/P-20): `stakeFor` rejects only `user == address(0)`. Crediting
     *      the VAULT ITSELF produces a position that:
     *        * `unstake` will not release, because the recorded staker is a contract with no
     *          call path that reaches `vault.unstake`, and
     *        * `rescuePosition` will not release either, because it refuses any tokenId with
     *          a non-zero staker record.
     *      Nothing on-chain can move it again. Asserted as the CURRENT behaviour; the fix
     *      would be a `user != address(this) && user != zapper` check in `stakeFor`.
     */
    function test_SEC05_StakeForTheVaultItselfStrandsThePositionForever() public {
        uint256 tokenId = _stakeForThroughZapper(address(vault));

        assertEq(vault.stakerOf(tokenId), address(vault), "the vault is recorded as its own staker");
        assertEq(npm.ownerOf(tokenId), address(vault), "and custody is real");

        // The owner's recovery path is closed by the record it just wrote.
        vm.prank(multisig);
        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.PositionIsStaked.selector, tokenId, address(vault)));
        vault.rescuePosition(tokenId);

        // And nobody else is the staker.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.NotStaker.selector, tokenId, alice, address(vault)));
        vault.unstake(tokenId);
    }

    /// @dev FINDING SEC-05, second arm: the zapper is equally fatal as a credited staker —
    ///      it exposes no function that calls `vault.unstake`.
    function test_SEC05_StakeForTheZapperStrandsThePositionForever() public {
        uint256 tokenId = _stakeForThroughZapper(address(zapper));

        assertEq(vault.stakerOf(tokenId), address(zapper), "the zapper is recorded as the staker");

        vm.prank(multisig);
        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.PositionIsStaked.selector, tokenId, address(zapper)));
        vault.rescuePosition(tokenId);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.NotStaker.selector, tokenId, alice, address(zapper)));
        vault.unstake(tokenId);
    }

    /// @dev The one address `stakeFor` does reject.
    function test_StakeFor_RejectsTheZeroUser() public {
        uint256 tokenId = _mintPositionForZapper();

        vm.prank(address(zapper));
        vm.expectRevert(LPStakingVault.ZeroAddress.selector);
        vault.stakeFor(address(0), tokenId);
    }

    function test_StakeFor_RejectsACallerThatIsNotTheZapper() public {
        uint256 tokenId = _mintAroundSpot(alice, 600);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.NotZapper.selector, alice, address(zapper)));
        vault.stakeFor(alice, tokenId);
    }

    /// @dev With the zapper unset the path closes entirely, rather than opening to everyone.
    function test_StakeFor_IsClosedWhenNoZapperIsConfigured() public {
        vm.prank(multisig);
        vault.setZapper(address(0));

        uint256 tokenId = _mintAroundSpot(alice, 600);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.NotZapper.selector, alice, address(0)));
        vault.stakeFor(alice, tokenId);
    }

    // ──────────────────────── Helpers ──────────────────────────

    /// @dev Mints a position owned by the zapper, so `stakeFor` can pull custody from it the
    ///      way a real zap does.
    function _mintPositionForZapper() private returns (uint256 tokenId) {
        _fund(profile.asset, address(zapper), 50_000e18);
        _fund(profile.usdc, address(zapper), 50_000e6);
        int24 tick = _currentTick();
        tokenId = _mintPositionFor(address(zapper), _alignDown(tick) - 600, _alignUp(tick) + 600, 10_000e18, 10_000e6);
    }

    function _stakeForThroughZapper(address creditTo) private returns (uint256 tokenId) {
        tokenId = _mintPositionForZapper();
        vm.startPrank(address(zapper));
        npm.approve(address(vault), tokenId);
        vault.stakeFor(creditTo, tokenId);
        vm.stopPrank();
    }
}
