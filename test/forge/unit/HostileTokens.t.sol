// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LocalHarness} from "../utils/LocalHarness.sol";
import {LPStakingVault} from "../../../contracts/lp-staking/LPStakingVault.sol";
import {LPZapper} from "../../../contracts/lp-staking/LPZapper.sol";
import {RewardsDistributor} from "../../../contracts/lp-staking/RewardsDistributor.sol";
import {SwapParams} from "../../../contracts/lp-staking/libraries/TwapGuard.sol";
import {MockUniswapV3Pool} from "../../../contracts/lp-staking/mocks/MockUniswapV3Pool.sol";
import {MockPositionManager} from "../../../contracts/lp-staking/mocks/MockPositionManager.sol";
import {MockSwapRouter} from "../../../contracts/lp-staking/mocks/MockSwapRouter.sol";
import {MockERC20Permit} from "../../../contracts/lp-staking/mocks/MockERC20Permit.sol";
import {FeeOnTransferToken, ReturnsFalseToken, BlocklistUSDC} from "../utils/attackers/HostileTokens.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @notice Why this file exists: the stack takes its two pool tokens as immutable constructor
 *         arguments and its ASSET as an immutable on the distributor, so "what if the token
 *         misbehaves" is a deployment-time question with a permanent answer. `LPZapper.sweep`
 *         and `RewardsDistributor.recoverExcessAsset` additionally touch tokens nobody chose
 *         in advance.
 *
 *  Each token below models one real class. None of them can appear as the live pair on a
 *  correct deployment — the constructors check the pool triple and the deploy script checks
 *  decimals — so these are answers to a reviewer's question, recorded as measurements rather
 *  than as arguments.
 */
contract HostileTokensTest is LocalHarness {
    uint256 internal constant FEE_BPS = 100; // 1% skimmed on every transfer

    function setUp() public {
        _deployLocalStack();
    }

    // ──────────────────────── Fee-on-transfer ─────────────────

    /**
     * @dev The refund event reports what the vault SENT, which a fee-on-transfer token makes
     *      strictly larger than what the staker RECEIVED. The vault itself is still drained,
     *      so its own invariant holds — but an indexer that reads `amount0Refunded` as
     *      "credited to the user" would over-count. Recorded as current behaviour.
     */
    function test_FeeOnTransfer_TheRefundEventOverstatesWhatTheStakerReceives() public {
        (LPStakingVault v, FeeOnTransferToken t0,, MockPositionManager npm2) = _feeOnTransferVault();
        uint256 tokenId = _stakeFeePosition(v, npm2, t0, alice);
        npm2.setMintConsumeBps(5_000);

        uint256 before = t0.balanceOf(alice);
        vm.prank(alice);
        v.rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, _noSwap(), FAR_DEADLINE);

        // The fee bites TWICE on one rebalance: once when `collect` moves the principal into
        // the vault, and again when `_refundDust` moves the leftover out to the staker.
        uint256 collected = P_ASSET - (P_ASSET * FEE_BPS) / 10_000;
        uint256 sent = collected / 2;
        uint256 received = t0.balanceOf(alice) - before;

        assertLt(received, sent, "the staker really does receive less than the vault sent");
        assertEq(received, sent - (sent * FEE_BPS) / 10_000, "and the shortfall is exactly the token's fee");
        assertEq(t0.balanceOf(address(v)), 0, "the vault is still drained, so its own invariant holds");
    }

    /**
     * @dev The worse consequence: the position manager credits the position with the amount
     *      it was ASKED to pull, but a fee-on-transfer token delivers less, so the manager
     *      ends up short of what it owes. The shortfall only surfaces on the NEXT withdrawal,
     *      as a plain insufficient-balance revert with no hint of the cause.
     */
    function test_FeeOnTransfer_BreaksThePositionManagersAccountingOnTheNextExit() public {
        (LPStakingVault v, FeeOnTransferToken t0,, MockPositionManager npm2) = _feeOnTransferVault();
        uint256 tokenId = _stakeFeePosition(v, npm2, t0, alice);

        vm.prank(alice);
        uint256 newTokenId = v.rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, _noSwap(), FAR_DEADLINE);

        // The manager now believes it holds the full principal but is short by the fee.
        vm.prank(alice);
        vm.expectRevert();
        v.rebalance(newTokenId, TICK_LOWER, TICK_UPPER, _noSwap(), FAR_DEADLINE);
    }

    function test_FeeOnTransfer_ASweepDeliversLessThanTheEventClaims() public {
        FeeOnTransferToken stray = new FeeOnTransferToken("Fee Token", "FEE", 18, FEE_BPS);
        stray.mint(address(zapper), 1_000e18);

        zapper.sweep(address(stray), 1_000e18, carol);

        assertEq(stray.balanceOf(carol), 990e18, "the recipient gets the amount minus the token's fee");
        assertEq(stray.balanceOf(address(zapper)), 0, "the zapper is still cleared");
    }

    // ──────────────────────── Returns-false tokens ─────────────

    /// @dev `SafeERC20` is what turns a silent `false` into a revert. This is the sweep leg.
    function test_ReturnsFalse_SweepRevertsThroughSafeErc20() public {
        ReturnsFalseToken liar = new ReturnsFalseToken();
        liar.mint(address(zapper), 1_000e18);

        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(liar)));
        zapper.sweep(address(liar), 1_000e18, carol);
    }

    /// @dev ...and this is the reward leg, where a silent failure would mark a claim paid.
    function test_ReturnsFalse_ClaimAssetRevertsAndLeavesTheLedgerUntouched() public {
        ReturnsFalseToken liar = new ReturnsFalseToken();
        RewardsDistributor d =
            _deployDistributorProxy(address(tokenX), address(liar), address(this), address(this), voucherSigner);
        d.setAssetClaimsEnabled(true);
        liar.mint(address(d), 1_000_000e18);

        bytes memory sig = _signAssetVoucherFor(d, alice, 1_000e18);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(liar)));
        d.claimAsset(1_000e18, FAR_DEADLINE, sig);

        assertEq(d.claimedAsset(alice), 0, "a failed payout must never leave the ledger marked paid");
    }

    function test_ReturnsFalse_RecoverExcessAssetRevertsThroughSafeErc20() public {
        ReturnsFalseToken liar = new ReturnsFalseToken();
        RewardsDistributor d =
            _deployDistributorProxy(address(tokenX), address(liar), address(this), address(this), voucherSigner);
        liar.mint(address(d), 1_000e18);

        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(liar)));
        d.recoverExcessAsset(1_000e18);
    }

    /// @dev The control arm: the same token telling the truth is accepted, so the assertions
    ///      above are about the return value and not about the token being unusual.
    function test_ReturnsFalse_TheSameTokenReturningTrueIsAccepted() public {
        ReturnsFalseToken liar = new ReturnsFalseToken();
        liar.setReturns(true, true, true);
        liar.mint(address(zapper), 1_000e18);

        zapper.sweep(address(liar), 1_000e18, carol);
        assertEq(liar.balanceOf(carol), 1_000e18, "an honest `true` must be accepted");
    }

    // ──────────────────────── Blocklists ───────────────────────

    /// @dev A token issuer can freeze any address. Sweeping to a frozen recipient fails, and
    ///      the owner's recovery path is simply blocked until another recipient is chosen.
    function test_Blocklist_ASweepToAFrozenRecipientReverts() public {
        BlocklistUSDC blocked = new BlocklistUSDC();
        blocked.mint(address(zapper), 1_000e6);
        blocked.setBlocked(carol, true);

        vm.expectRevert(bytes("USDC: recipient blocklisted"));
        zapper.sweep(address(blocked), 1_000e6, carol);

        zapper.sweep(address(blocked), 1_000e6, bob);
        assertEq(blocked.balanceOf(bob), 1_000e6, "an unfrozen recipient must still be servable");
    }

    /// @dev A frozen claimer cannot be paid, and the whole claim reverts rather than marking
    ///      the entitlement spent.
    function test_Blocklist_AFrozenClaimerCannotBePaidAndKeepsTheEntitlement() public {
        BlocklistUSDC blocked = new BlocklistUSDC();
        RewardsDistributor d =
            _deployDistributorProxy(address(tokenX), address(blocked), address(this), address(this), voucherSigner);
        d.setAssetClaimsEnabled(true);
        blocked.mint(address(d), 1_000_000e6);
        blocked.setBlocked(alice, true);

        bytes memory sig = _signAssetVoucherFor(d, alice, 1_000e6);
        vm.prank(alice);
        vm.expectRevert(bytes("USDC: recipient blocklisted"));
        d.claimAsset(1_000e6, FAR_DEADLINE, sig);

        blocked.setBlocked(alice, false);
        vm.prank(alice);
        assertEq(d.claimAsset(1_000e6, FAR_DEADLINE, sig), 1_000e6, "unfreezing must restore the same entitlement");
    }

    /// @dev Freezing the VAULT itself bricks the whole rebalance — the `collect` leg trips
    ///      first, as the RECIPIENT of the principal, before the refund leg is ever reached.
    ///      The unstake exit is unaffected, because it moves an NFT and not the token.
    function test_Blocklist_AFrozenVaultCannotRebalanceButCanStillBeExited() public {
        (LPStakingVault v, BlocklistUSDC usdcSide, MockPositionManager npm2) = _blocklistVault();
        uint256 tokenId = _stakeBlocklistPosition(v, npm2, usdcSide, alice);
        npm2.setMintConsumeBps(5_000);

        usdcSide.setBlocked(address(v), true);

        vm.prank(alice);
        vm.expectRevert(bytes("USDC: recipient blocklisted"));
        v.rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, _noSwap(), FAR_DEADLINE);

        vm.prank(alice);
        v.unstake(tokenId);
        assertEq(npm2.ownerOf(tokenId), alice, "the NFT exit must survive a frozen token");
    }

    /**
     * @dev USDC's other awkward rule: `approve` from a non-zero allowance to another non-zero
     *      allowance reverts. `forceApprove` exists for exactly that, and this proves it is
     *      doing work rather than being decorative — a stale allowance is planted first, and
     *      a plain `approve` on the same token is shown to fail on it.
     */
    function test_Blocklist_ForceApproveSurvivesTheNonZeroToNonZeroRule() public {
        BlocklistUSDC strict = new BlocklistUSDC();
        strict.mint(alice, 1_000e6);

        // The rule really is in force.
        vm.startPrank(alice);
        strict.approve(bob, 1);
        vm.expectRevert(bytes("USDC: approve from non-zero to non-zero"));
        strict.approve(bob, 2);
        vm.stopPrank();

        // And SafeERC20.forceApprove walks straight through it.
        vm.startPrank(alice);
        SafeERC20.forceApprove(IERC20(address(strict)), bob, 2);
        vm.stopPrank();
        assertEq(strict.allowance(alice, bob), 2, "forceApprove must overwrite a standing allowance");
    }

    /// @dev And the same rule inside a live swap: a stale allowance left on the router does
    ///      not brick the next swap, because the vault approves through `forceApprove`.
    function test_Blocklist_AStaleRouterAllowanceDoesNotBrickTheNextSwap() public {
        vm.prank(address(vault));
        asset.approve(address(routerMock), 1); // a stale, non-zero standing allowance

        uint256 tokenId = _stakePosition(alice);
        SwapParams memory swap =
            SwapParams({zeroForOne: true, amountIn: P_ASSET, amountOutMin: 0, amount0Min: 0, amount1Min: 0});

        vm.prank(alice);
        uint256 newTokenId = vault.rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, swap, FAR_DEADLINE);

        assertEq(vault.stakerOf(newTokenId), alice, "a stale allowance must not block the swap leg");
        assertEq(asset.allowance(address(vault), address(routerMock)), 0, "and the allowance must end back at zero");
    }

    // ──────────────────────── Helpers ──────────────────────────

    function _feeOnTransferVault()
        private
        returns (LPStakingVault v, FeeOnTransferToken t0, FeeOnTransferToken t1, MockPositionManager npm2)
    {
        FeeOnTransferToken a = new FeeOnTransferToken("Fee Asset", "fASSET", 18, FEE_BPS);
        FeeOnTransferToken b = new FeeOnTransferToken("Fee USDC", "fUSDC", 6, FEE_BPS);
        (t0, t1) = address(a) < address(b) ? (a, b) : (b, a);

        MockUniswapV3Pool p = new MockUniswapV3Pool(address(t0), address(t1), FEE);
        npm2 = new MockPositionManager();
        v = _deployVaultProxy(
            address(npm2),
            address(p),
            address(t0),
            address(t1),
            FEE,
            address(new MockSwapRouter()),
            address(this),
            address(this),
            MIN_TWAP_WINDOW,
            500
        );
    }

    function _stakeFeePosition(LPStakingVault v, MockPositionManager npm2, FeeOnTransferToken t0, address holder)
        private
        returns (uint256 tokenId)
    {
        npm2.mintFake(holder, v.token0(), v.token1(), FEE, TICK_LOWER, TICK_UPPER, LIQUIDITY, 0, 0);
        tokenId = npm2.lastMintedId();
        // The manager is funded WITHOUT a fee (mint from zero is exempt), so the shortfall
        // the test measures is caused by the vault's own refund, not by the setup.
        t0.mint(address(npm2), P_ASSET);
        _setPrincipal(npm2, tokenId, address(t0) == v.token0() ? P_ASSET : 0, address(t0) == v.token0() ? 0 : P_ASSET);

        vm.startPrank(holder);
        npm2.approve(address(v), tokenId);
        v.stake(tokenId);
        vm.stopPrank();
    }

    function _blocklistVault() private returns (LPStakingVault v, BlocklistUSDC usdcSide, MockPositionManager npm2) {
        usdcSide = new BlocklistUSDC();
        MockERC20Permit assetSide = new MockERC20Permit("Asset", "ASSET", 1e27, 18);
        (address t0, address t1) = address(usdcSide) < address(assetSide)
            ? (address(usdcSide), address(assetSide))
            : (address(assetSide), address(usdcSide));

        MockUniswapV3Pool p = new MockUniswapV3Pool(t0, t1, FEE);
        npm2 = new MockPositionManager();
        v = _deployVaultProxy(
            address(npm2),
            address(p),
            t0,
            t1,
            FEE,
            address(new MockSwapRouter()),
            address(this),
            address(this),
            MIN_TWAP_WINDOW,
            500
        );
    }

    function _stakeBlocklistPosition(LPStakingVault v, MockPositionManager npm2, BlocklistUSDC usdcSide, address holder)
        private
        returns (uint256 tokenId)
    {
        npm2.mintFake(holder, v.token0(), v.token1(), FEE, TICK_LOWER, TICK_UPPER, LIQUIDITY, 0, 0);
        tokenId = npm2.lastMintedId();
        usdcSide.mint(address(npm2), P_USDC);
        bool usdcIsToken0 = address(usdcSide) == v.token0();
        _setPrincipal(npm2, tokenId, usdcIsToken0 ? P_USDC : 0, usdcIsToken0 ? 0 : P_USDC);

        vm.startPrank(holder);
        npm2.approve(address(v), tokenId);
        v.stake(tokenId);
        vm.stopPrank();
    }

    function _setPrincipal(MockPositionManager npm2, uint256 tokenId, uint256 p0, uint256 p1) private {
        npm2.setPrincipal(tokenId, p0, p1);
    }

    function _signAssetVoucherFor(RewardsDistributor target, address user, uint256 cumulative)
        private
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(target.ASSET_CLAIM_TYPEHASH(), user, cumulative, FAR_DEADLINE));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparatorOf(target), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(voucherSignerPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _domainSeparatorOf(RewardsDistributor target) private view returns (bytes32) {
        (, string memory n, string memory ver, uint256 cid, address verifying,,) = target.eip712Domain();
        return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256(bytes(n)), keccak256(bytes(ver)), cid, verifying));
    }
}
