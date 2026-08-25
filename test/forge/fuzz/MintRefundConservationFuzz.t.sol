// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LocalHarness} from "../utils/LocalHarness.sol";
import {SwapParams} from "../../../contracts/lp-staking/libraries/TwapGuard.sol";

/**
 * @notice Why this file exists: both the vault and the zapper mint with their WHOLE balance
 *         and refund whatever the mint did not take, across a pair whose two sides are 18 and
 *         6 decimals. That design is only safe if one arithmetic sentence holds on every
 *         input: **what the user paid equals what the position took plus what came back**,
 *         per token, with no wei stranded on either contract.
 *
 *  These properties assert that sentence over fuzzed inputs — the pulled amount, the split
 *  between the swap leg and the mint leg, and how much of the desired amounts the position
 *  manager actually consumes (`mintConsumeBps`, which is what manufactures the dust the
 *  refund path exists for).
 *
 *  Measurement is by BALANCE DELTA on every party (caller, position manager, router, vault,
 *  zapper) rather than by reading the emitted refund figures back. An event can agree with a
 *  buggy transfer; balances cannot.
 */
contract MintRefundConservationFuzzTest is LocalHarness {
    /// @dev Both zap legs are USDC-denominated. Kept well inside alice's 1,000,000 USDC.
    uint256 internal constant MAX_ZAP_USDC = 100_000e6;
    /// @dev Floor on the consumed share: below ~10% a 6-decimal leg can round to zero and the
    ///      position manager's own `liquidity > 0` guard, not the refund path, becomes the
    ///      subject of the test.
    uint256 internal constant MIN_CONSUME_BPS = 1_000;

    function setUp() public {
        _deployLocalStack();
    }

    // ──────────────────────── Zap-in ───────────────────────────

    /**
     * @dev Zap-in conservation, stated per token because the two sides have different
     *      decimals and a mixed-decimal bug would net out to zero if they were summed:
     *
     *        USDC  : what the caller paid  == what the mint took + what the swap consumed
     *        ASSET : what the swap produced == what the mint took + what was refunded
     */
    function testFuzz_ZapIn_InputEqualsPrincipalPlusRefundOnBothLegs(
        uint256 usdcSeed,
        uint256 swapSeed,
        uint256 consumeSeed
    ) public {
        uint256 usdcAmount = bound(usdcSeed, 1e6, MAX_ZAP_USDC);
        uint256 swapIn = bound(swapSeed, 0, usdcAmount);
        uint256 consumeBps = bound(consumeSeed, MIN_CONSUME_BPS, 10_000);

        npmMock.setMintConsumeBps(consumeBps);

        uint256 aliceUsdcBefore = usdcToken.balanceOf(alice);
        uint256 aliceAssetBefore = asset.balanceOf(alice);
        uint256 npmUsdcBefore = usdcToken.balanceOf(address(npmMock));
        uint256 npmAssetBefore = asset.balanceOf(address(npmMock));
        uint256 routerUsdcBefore = usdcToken.balanceOf(address(routerMock));
        uint256 routerAssetBefore = asset.balanceOf(address(routerMock));

        _zapIn(alice, usdcAmount, swapIn);

        uint256 usdcPaid = aliceUsdcBefore - usdcToken.balanceOf(alice);
        uint256 usdcIntoPosition = usdcToken.balanceOf(address(npmMock)) - npmUsdcBefore;
        uint256 usdcIntoRouter = usdcToken.balanceOf(address(routerMock)) - routerUsdcBefore;

        assertEq(usdcPaid, usdcIntoPosition + usdcIntoRouter, "USDC paid == USDC into the position + into the swap");
        assertEq(usdcIntoRouter, swapIn, "the swap consumes exactly the amount the caller allocated to it");

        uint256 assetFromSwap = routerAssetBefore - asset.balanceOf(address(routerMock));
        uint256 assetIntoPosition = asset.balanceOf(address(npmMock)) - npmAssetBefore;
        uint256 assetRefunded = asset.balanceOf(alice) - aliceAssetBefore;

        assertEq(assetFromSwap, assetIntoPosition + assetRefunded, "ASSET bought == ASSET into the position + refunded");

        _assertNoResidue();
    }

    /**
     * @dev Neither the zapper nor the vault may keep a wei of either token after a zap — not
     *      even a wei that was pushed in from outside beforehand. The stray joins the mint
     *      and leaves with this caller; what it may never do is stay.
     */
    function testFuzz_ZapIn_LeavesNoResidueWhateverWasPushedInBeforehand(
        uint256 usdcSeed,
        uint256 strayUsdcSeed,
        uint256 strayAssetSeed
    ) public {
        uint256 usdcAmount = bound(usdcSeed, 1e6, MAX_ZAP_USDC);
        uint256 strayUsdc = bound(strayUsdcSeed, 0, 1_000e6);
        uint256 strayAsset = bound(strayAssetSeed, 0, 1_000e18);

        if (strayUsdc > 0) usdcToken.transfer(address(zapper), strayUsdc);
        if (strayAsset > 0) asset.transfer(address(zapper), strayAsset);

        uint256 aliceUsdcBefore = usdcToken.balanceOf(alice);
        uint256 aliceAssetBefore = asset.balanceOf(alice);

        _zapIn(alice, usdcAmount, 0);

        _assertNoResidue();
        // The stray is not destroyed: whatever the mint did not take came back to this caller,
        // so the caller can never have paid more than the amount they pulled in.
        assertLe(aliceUsdcBefore - usdcToken.balanceOf(alice), usdcAmount, "a zap never costs more than its input");
        assertGe(asset.balanceOf(alice), aliceAssetBefore, "and never leaves the caller with less ASSET than before");
    }

    // ──────────────────────── Rebalance ────────────────────────

    /**
     * @dev Rebalance conservation. Everything the position manager pays out on the withdraw
     *      leg is either consumed by the new mint or refunded to the staker in the same
     *      transaction, per token — so the position manager's NET balance change is exactly
     *      the negative of the staker's, and the vault ends flat.
     *
     *      The refund is asserted against its exact expected value, not merely against
     *      "something came back": `collected - floor(collected * bps / 10000)`, which is
     *      where a rounding error in the whole-balance mint would show up.
     */
    function testFuzz_Rebalance_WithdrawnEqualsMintedPlusRefunded(
        uint256 fee0Seed,
        uint256 fee1Seed,
        uint256 consumeSeed
    ) public {
        uint128 fees0 = uint128(bound(fee0Seed, 0, 100e18));
        uint128 fees1 = uint128(bound(fee1Seed, 0, 100e6));
        uint256 consumeBps = bound(consumeSeed, MIN_CONSUME_BPS, 10_000);

        uint256 tokenId = _stakePosition(alice);

        // Fees accrued while the liquidity was live. They must be funded on the mock, which
        // pays every `collect` out of its own balance.
        npmMock.setPendingFees(tokenId, fees0, fees1);
        if (fees0 > 0) asset.transfer(address(npmMock), fees0);
        if (fees1 > 0) usdcToken.transfer(address(npmMock), fees1);
        npmMock.setMintConsumeBps(consumeBps);

        uint256 collected0 = P_ASSET + fees0;
        uint256 collected1 = P_USDC + fees1;

        uint256 aliceAssetBefore = asset.balanceOf(alice);
        uint256 aliceUsdcBefore = usdcToken.balanceOf(alice);
        uint256 npmAssetBefore = asset.balanceOf(address(npmMock));
        uint256 npmUsdcBefore = usdcToken.balanceOf(address(npmMock));

        vm.prank(alice);
        vault.rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, _noSwap(), FAR_DEADLINE);

        uint256 refund0 = asset.balanceOf(alice) - aliceAssetBefore;
        uint256 refund1 = usdcToken.balanceOf(alice) - aliceUsdcBefore;

        assertEq(refund0, collected0 - (collected0 * consumeBps) / 10_000, "the ASSET refund is exactly the residue");
        assertEq(refund1, collected1 - (collected1 * consumeBps) / 10_000, "the USDC refund is exactly the residue");
        assertEq(npmAssetBefore - asset.balanceOf(address(npmMock)), refund0, "every ASSET wei that left is refunded");
        assertEq(npmUsdcBefore - usdcToken.balanceOf(address(npmMock)), refund1, "and every USDC wei likewise");

        _assertNoResidue();
    }

    // ──────────────────────── Helpers ──────────────────────────

    /// @dev A USDC -> ASSET zap. `usdcIsToken0` is false on this harness, so the only legal
    ///      swap direction is token1 -> token0.
    function _zapIn(address user, uint256 usdcAmount, uint256 swapIn) private returns (uint256 tokenId) {
        SwapParams memory swap =
            SwapParams({zeroForOne: false, amountIn: swapIn, amountOutMin: 0, amount0Min: 0, amount1Min: 0});

        vm.startPrank(user);
        usdcToken.approve(address(zapper), usdcAmount);
        tokenId = zapper.zapIn(usdcAmount, TICK_LOWER, TICK_UPPER, swap, FAR_DEADLINE);
        vm.stopPrank();
    }

    /// @dev Neither contract is allowed to hold either pool token between transactions.
    function _assertNoResidue() private view {
        assertEq(usdcToken.balanceOf(address(zapper)), 0, "the zapper keeps no USDC between transactions");
        assertEq(asset.balanceOf(address(zapper)), 0, "the zapper keeps no ASSET between transactions");
        assertEq(usdcToken.balanceOf(address(vault)), 0, "the vault keeps no USDC between transactions");
        assertEq(asset.balanceOf(address(vault)), 0, "the vault keeps no ASSET between transactions");
    }
}
