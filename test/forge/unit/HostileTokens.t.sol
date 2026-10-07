// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LocalHarness} from "../utils/LocalHarness.sol";
import {LPStakingVault} from "../../../contracts/lp-staking/LPStakingVault.sol";
import {LPZapper} from "../../../contracts/lp-staking/LPZapper.sol";
import {RewardsDistributor} from "../../../contracts/lp-staking/RewardsDistributor.sol";
import {IRewardsDistributor} from "../../../contracts/lp-staking/interfaces/IRewardsDistributor.sol";
import {SwapParams} from "../../../contracts/lp-staking/libraries/TwapGuard.sol";
import {MockUniswapV3Pool} from "../../../contracts/lp-staking/mocks/MockUniswapV3Pool.sol";
import {MockPositionManager} from "../../../contracts/lp-staking/mocks/MockPositionManager.sol";
import {MockSwapRouter} from "../../../contracts/lp-staking/mocks/MockSwapRouter.sol";
import {MockERC20Permit} from "../../../contracts/lp-staking/mocks/MockERC20Permit.sol";
import {
    FeeOnTransferToken,
    ReturnsFalseToken,
    BlocklistUSDC,
    ClaimReentrantToken,
    DecimalsRevertsToken,
    Bytes32SymbolToken
} from "../utils/attackers/HostileTokens.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @notice Why this file exists: the stack takes its two pool tokens as immutable constructor
 *         arguments, so for the vault and the zapper "what if the token misbehaves" is a
 *         deployment-time question with a permanent answer. The distributor is different since
 *         v1: its REWARD tokens are proxy storage, and the owner (the timelock) can add one at
 *         any time with `addRewardToken`. `LPZapper.sweep` and `RewardsDistributor.recoverExcess`
 *         additionally touch tokens nobody chose in advance.
 *
 *  Each token below models one real class. None of them can appear as the live pair on a
 *  correct deployment — the constructors check the pool triple and the deploy script checks
 *  decimals — and `addRewardToken`'s NatSpec restricts reward tokens to plain ERC-20s, so these
 *  are answers to a reviewer's question, recorded as measurements rather than as arguments.
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

    /// @dev ...and this is the reward side, where a silent failure would mark a claim paid. The
    ///      token is added as a reward token through the owner, funded, and claimed.
    function test_ReturnsFalse_ARewardClaimRevertsAndLeavesTheLedgerUntouched() public {
        ReturnsFalseToken liar = new ReturnsFalseToken();
        distributor.addRewardToken(address(liar), false, true);
        liar.mint(address(distributor), 1_000_000e18);

        bytes memory sig = _signVoucher(voucherSignerPk, address(liar), alice, 1_000e18, FAR_DEADLINE);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(liar)));
        distributor.claim(address(liar), 1_000e18, FAR_DEADLINE, sig);

        assertEq(
            distributor.claimed(address(liar), alice), 0, "a failed payout must never leave the ledger marked paid"
        );
    }

    function test_ReturnsFalse_RecoverExcessRevertsThroughSafeErc20() public {
        ReturnsFalseToken liar = new ReturnsFalseToken();
        liar.mint(address(distributor), 1_000e18);

        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(liar)));
        distributor.recoverExcess(address(liar), 1_000e18);
    }

    // ──────────────────────── Non-plain reward tokens ──────────

    /**
     * @dev Fee-on-transfer is NOT a supported reward token (`addRewardToken` NatSpec). Measured,
     *      so the consequence is known if one is added anyway: the ledger and the `Claimed` event
     *      record the voucher's amount, while the claimer receives that amount minus the token's
     *      fee. The distributor's own accounting is still exact — it sent what the ledger says.
     */
    function test_FeeOnTransfer_ARewardTokenPaysLessThanTheLedgerRecords() public {
        FeeOnTransferToken fee = new FeeOnTransferToken("Fee Reward", "FEER", 18, FEE_BPS);
        distributor.addRewardToken(address(fee), false, true);
        fee.mint(address(distributor), 1_000_000e18);

        bytes memory sig = _signVoucher(voucherSignerPk, address(fee), alice, 1_000e18, FAR_DEADLINE);
        vm.expectEmit(true, true, false, true, address(distributor));
        emit IRewardsDistributor.Claimed(alice, address(fee), 1_000e18, 1_000e18, block.timestamp);
        vm.prank(alice);
        uint256 paid = distributor.claim(address(fee), 1_000e18, FAR_DEADLINE, sig);

        assertEq(paid, 1_000e18, "the distributor reports the voucher's delta as paid");
        assertEq(distributor.claimed(address(fee), alice), 1_000e18, "and records it on the ledger");
        assertEq(fee.balanceOf(alice), 990e18, "but the claimer receives the amount minus the token's 1% fee");
        assertEq(fee.balanceOf(address(distributor)), 1_000_000e18 - 1_000e18, "the distributor sent the full amount");
    }

    /**
     * @dev A reward token whose own transfer re-enters `claim` while the distributor is paying out
     *      of it. The guard rejects the reentrant call with its own error, the outer claim
     *      completes, and the claimer is paid exactly once.
     */
    function test_ReentrantTransfer_ARewardTokenCannotReenterClaim() public {
        ClaimReentrantToken evil = new ClaimReentrantToken();
        distributor.addRewardToken(address(evil), false, true);
        evil.mint(address(distributor), 1_000_000e18);

        bytes memory sig = _signVoucher(voucherSignerPk, address(evil), alice, 1_000e18, FAR_DEADLINE);
        evil.arm(
            address(distributor), abi.encodeCall(RewardsDistributor.claim, (address(evil), 1_000e18, FAR_DEADLINE, sig))
        );

        vm.prank(alice);
        uint256 paid = distributor.claim(address(evil), 1_000e18, FAR_DEADLINE, sig);

        assertEq(evil.attempts(), 1, "the payout transfer must really have re-entered");
        assertFalse(evil.lastReenterSucceeded(), "the reentrant claim must be rejected");
        assertEq(
            evil.lastReturnData(),
            abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector),
            "by the reentrancy guard's own error"
        );
        assertEq(paid, 1_000e18, "the outer claim completes");
        assertEq(evil.balanceOf(alice), 1_000e18, "and the claimer is paid exactly once");
    }

    /// @dev `addRewardToken` reads `decimals()` and `symbol()`; a token that cannot answer either
    ///      as a plain ERC-20 does is refused, and nothing is registered.
    function test_Metadata_ATokenWhoseDecimalsRevertIsRefused() public {
        DecimalsRevertsToken noDecimals = new DecimalsRevertsToken();
        vm.expectRevert(bytes("no decimals"));
        distributor.addRewardToken(address(noDecimals), false, true);
        assertFalse(distributor.rewardToken(address(noDecimals)).registered, "nothing registered");
    }

    function test_Metadata_ABytes32SymbolTokenIsRefused() public {
        Bytes32SymbolToken mkrLike = new Bytes32SymbolToken();
        vm.expectRevert();
        distributor.addRewardToken(address(mkrLike), false, true);
        assertFalse(distributor.rewardToken(address(mkrLike)).registered, "nothing registered");
        assertEq(distributor.rewardTokens().length, 2, "the list does not grow");
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
    ///      the entitlement spent. A 6-decimal blocklisting token added as a reward token.
    function test_Blocklist_AFrozenClaimerCannotBePaidAndKeepsTheEntitlement() public {
        BlocklistUSDC blocked = new BlocklistUSDC();
        distributor.addRewardToken(address(blocked), false, true);
        assertEq(distributor.rewardToken(address(blocked)).decimals, 6, "stored with its own 6 decimals");
        blocked.mint(address(distributor), 1_000_000e6);
        blocked.setBlocked(alice, true);

        bytes memory sig = _signVoucher(voucherSignerPk, address(blocked), alice, 1_000e6, FAR_DEADLINE);
        vm.prank(alice);
        vm.expectRevert(bytes("USDC: recipient blocklisted"));
        distributor.claim(address(blocked), 1_000e6, FAR_DEADLINE, sig);
        assertEq(distributor.claimed(address(blocked), alice), 0, "the entitlement is not marked spent");

        blocked.setBlocked(alice, false);
        vm.prank(alice);
        assertEq(
            distributor.claim(address(blocked), 1_000e6, FAR_DEADLINE, sig),
            1_000e6,
            "unfreezing must restore the same entitlement"
        );
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
            _vaultParams(
                address(npm2),
                address(p),
                address(t0),
                address(t1),
                address(new MockSwapRouter()),
                address(this),
                MIN_TWAP_WINDOW,
                500
            )
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
            _vaultParams(
                address(npm2), address(p), t0, t1, address(new MockSwapRouter()), address(this), MIN_TWAP_WINDOW, 500
            )
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
}
