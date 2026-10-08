// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkHarness} from "../utils/ForkHarness.sol";
import {RewardsDistributor} from "../../../contracts/lp-staking/RewardsDistributor.sol";
import {IRewardsDistributor} from "../../../contracts/lp-staking/interfaces/IRewardsDistributor.sol";
import {RewardsDistributorV2Mock} from "../../../contracts/lp-staking/mocks/RewardsDistributorV2Mock.sol";
import {IERC20Like} from "../utils/Interfaces.sol";

/**
 * @notice Why this file exists: every reward voucher is EIP-712 over a domain that includes the
 *         live chain id and the deployed distributor PROXY, and every reward token is paid out of
 *         a balance the company funds. Both are properties of a REAL deployment on a REAL chain id
 *         against the REAL $ASSET token, and the ledger-survival claim (SEC-04) is only
 *         meaningful when the proxy really is upgraded in place on that chain.
 *
 *  The fork stack is the deploy script's shape: $ASSET registered conditional with claims CLOSED,
 *  $OVTR (the Overture token) with claims open, both pre-funded by the multisig — which stands in
 *  for the timelock as owner, and is also the operator, the guardian and the $OVTR minter.
 *
 *  SEC-04 lives here.
 */
contract RewardVoucherForkTest is ForkHarness {
    uint256 internal constant AWARD = 1_000e18;

    address internal ovtr;
    address internal assetToken;

    function setUp() public {
        _deployForkedStack();
        ovtr = address(overture);
        assetToken = profile.asset;
    }

    // ──────────────────────── $OVTR ────────────────────────────

    /// @dev Paid by TRANSFER out of the funded balance: the claimer gains, the distributor loses,
    ///      and the token's supply does not move — nothing is minted at claim time.
    function test_ClaimOverture_PaysOutOfTheFundedBalanceAndMintsNothing() public {
        uint256 supplyBefore = overture.totalSupply();
        uint256 floatBefore = overture.balanceOf(address(distributor));

        bytes memory voucher = _sign(ovtr, alice, AWARD);
        vm.prank(alice);
        uint256 paid = distributor.claim(ovtr, AWARD, FAR_DEADLINE, voucher);

        assertEq(paid, AWARD, "the first claim pays the whole cumulative entitlement");
        assertEq(overture.balanceOf(alice), AWARD, "the $OVTR reaches the claimer");
        assertEq(floatBefore - overture.balanceOf(address(distributor)), AWARD, "out of the distributor's balance");
        assertEq(overture.totalSupply(), supplyBefore, "and nothing is minted at claim time");
        assertEq(distributor.claimed(ovtr, alice), AWARD, "the ledger records the cumulative, not the delta");
    }

    /// @dev The vouchers are CUMULATIVE, so a later one pays only what has been added since.
    function test_ClaimOverture_ASecondVoucherPaysOnlyTheDelta() public {
        _claim(ovtr, alice, AWARD);

        bytes memory voucher = _sign(ovtr, alice, AWARD * 3);
        vm.prank(alice);
        uint256 paid = distributor.claim(ovtr, AWARD * 3, FAR_DEADLINE, voucher);

        assertEq(paid, AWARD * 2, "the second claim must pay only the increase");
        assertEq(overture.balanceOf(alice), AWARD * 3, "the balance must equal the latest cumulative");
    }

    function test_ClaimOverture_RevertsWhenTheCumulativeHasNotGrown() public {
        _claim(ovtr, alice, AWARD);

        bytes memory voucher = _sign(ovtr, alice, AWARD);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IRewardsDistributor.NothingToClaim.selector, AWARD, AWARD));
        distributor.claim(ovtr, AWARD, FAR_DEADLINE, voucher);
    }

    // ──────────────────────── Voucher binding ──────────────────

    /// @dev A voucher names its claimer, so it is worthless in anyone else's hands.
    function test_Voucher_IsBoundToTheAddressItNames() public {
        bytes memory sig = _sign(ovtr, alice, AWARD);

        vm.prank(bob);
        vm.expectPartialRevert(IRewardsDistributor.InvalidSignature.selector);
        distributor.claim(ovtr, AWARD, FAR_DEADLINE, sig);
    }

    /// @dev A voucher names its TOKEN: an $OVTR voucher presented for the real $ASSET (claims
    ///      opened, balance funded) recovers to a stranger and moves nothing.
    function test_Voucher_IsBoundToTheTokenItNames() public {
        vm.prank(multisig);
        distributor.setClaimsEnabled(assetToken, true);
        uint256 assetBefore = IERC20Like(assetToken).balanceOf(alice);

        bytes memory voucher = _sign(ovtr, alice, AWARD);
        vm.prank(alice);
        vm.expectPartialRevert(IRewardsDistributor.InvalidSignature.selector);
        distributor.claim(assetToken, AWARD, FAR_DEADLINE, voucher);

        assertEq(distributor.claimed(assetToken, alice), 0, "the $ASSET ledger stays empty");
        assertEq(IERC20Like(assetToken).balanceOf(alice), assetBefore, "and no real $ASSET moves");
    }

    function test_Voucher_RevertsOnAnExpiredDeadline() public {
        uint256 deadline = block.timestamp - 1;
        bytes memory sig = _signVoucher(voucherSignerPk, ovtr, alice, AWARD, deadline);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IRewardsDistributor.ClaimExpired.selector, deadline, block.timestamp));
        distributor.claim(ovtr, AWARD, deadline, sig);
    }

    function test_Voucher_PausingBlocksEveryToken() public {
        vm.startPrank(multisig);
        distributor.setClaimsEnabled(assetToken, true);
        distributor.setPaused(true);
        vm.stopPrank();

        bytes memory voucher = _sign(ovtr, alice, AWARD);
        vm.prank(alice);
        vm.expectRevert(IRewardsDistributor.ClaimsPaused.selector);
        distributor.claim(ovtr, AWARD, FAR_DEADLINE, voucher);

        bytes memory voucher2 = _sign(assetToken, alice, AWARD);
        vm.prank(alice);
        vm.expectRevert(IRewardsDistributor.ClaimsPaused.selector);
        distributor.claim(assetToken, AWARD, FAR_DEADLINE, voucher2);
    }

    /**
     * @dev V-21: rotating the signer invalidates every voucher signed by the previous one — and
     *      rotating BACK revalidates them, because nothing about a voucher records which signer
     *      was current when it was issued. Vouchers are valid whenever their signer is.
     */
    function test_Voucher_SignerRotationInvalidatesAndRotatingBackRevalidates() public {
        bytes memory sig = _sign(ovtr, alice, AWARD);
        (address newSigner,) = makeAddrAndKey("rotatedSigner");

        vm.prank(multisig);
        distributor.setSigner(newSigner);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IRewardsDistributor.InvalidSignature.selector, voucherSigner, newSigner));
        distributor.claim(ovtr, AWARD, FAR_DEADLINE, sig);

        vm.prank(multisig);
        distributor.setSigner(voucherSigner);

        vm.prank(alice);
        assertEq(distributor.claim(ovtr, AWARD, FAR_DEADLINE, sig), AWARD, "rotating back makes it spendable again");
    }

    // ──────────────────────── $ASSET ───────────────────────────

    /// @dev $ASSET's claims are CLOSED at launch and opened by the owner (the timelock) later.
    function test_ClaimAsset_IsClosedAtLaunchUntilTheOwnerOpensIt() public {
        bytes memory sig = _sign(assetToken, alice, AWARD);
        assertFalse(distributor.rewardToken(assetToken).claimsEnabled, "a fresh deployment must not pay $ASSET");
        assertTrue(distributor.rewardToken(assetToken).conditional, "and $ASSET is the conditional token");

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IRewardsDistributor.TokenClaimsDisabled.selector, assetToken));
        distributor.claim(assetToken, AWARD, FAR_DEADLINE, sig);

        vm.prank(multisig);
        distributor.setClaimsEnabled(assetToken, true);

        uint256 before = IERC20Like(assetToken).balanceOf(alice);
        vm.prank(alice);
        uint256 paid = distributor.claim(assetToken, AWARD, FAR_DEADLINE, sig);

        assertEq(paid, AWARD, "the opened token must pay the whole entitlement");
        assertEq(IERC20Like(assetToken).balanceOf(alice) - before, AWARD, "and the real $ASSET reaches the claimer");
    }

    /// @dev The two ledgers are independent: spending one token leaves the other whole.
    function test_Claim_KeepsSeparateLedgersPerToken() public {
        vm.prank(multisig);
        distributor.setClaimsEnabled(assetToken, true);

        _claim(ovtr, alice, AWARD);
        _claim(assetToken, alice, AWARD * 2);

        assertEq(distributor.claimed(ovtr, alice), AWARD, "the $OVTR ledger is unchanged by the $ASSET claim");
        assertEq(distributor.claimed(assetToken, alice), AWARD * 2, "the $ASSET ledger records its own cumulative");
    }

    // ──────────────────────── Funding is the only bound ────────

    /**
     * @dev Drained through `recoverExcess`, a token's claims revert with the exact numbers until
     *      the company funds the distributor again; then the same voucher pays. On the real $ASSET.
     */
    function test_InsufficientFunds_UntilRefundedThenPays() public {
        vm.startPrank(multisig);
        distributor.setClaimsEnabled(assetToken, true);
        uint256 held = IERC20Like(assetToken).balanceOf(address(distributor));
        distributor.recoverExcess(assetToken, held);
        vm.stopPrank();
        assertGe(IERC20Like(assetToken).balanceOf(multisig), held, "the recovery landed on the operator");

        bytes memory sig = _sign(assetToken, alice, AWARD);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IRewardsDistributor.InsufficientFunds.selector, assetToken, AWARD, uint256(0))
        );
        distributor.claim(assetToken, AWARD, FAR_DEADLINE, sig);
        assertEq(distributor.claimed(assetToken, alice), 0, "a short balance writes nothing");

        vm.prank(multisig);
        IERC20Like(assetToken).transfer(address(distributor), AWARD);

        vm.prank(alice);
        assertEq(distributor.claim(assetToken, AWARD, FAR_DEADLINE, sig), AWARD, "refunded, the same voucher pays");
        assertEq(IERC20Like(assetToken).balanceOf(address(distributor)), 0, "out of exactly the refund");
    }

    /// @dev No cap and no budget: a single claim of fifty million $OVTR pays as soon as the minter
    ///      has funded that much — far beyond any epoch quantity the schedule could name.
    function test_NoBound_AClaimFarBeyondAnyScheduleQuantityPaysWhenFunded() public {
        uint256 huge = 50_000_000e18;
        vm.prank(multisig);
        overture.mint(address(distributor), huge);

        bytes memory voucher = _sign(ovtr, alice, huge);
        vm.prank(alice);
        assertEq(distributor.claim(ovtr, huge, FAR_DEADLINE, voucher), huge, "paid in full");
    }

    // ──────────────────────── SEC-04 ───────────────────────────

    /**
     * @dev SEC-04, the rule that remains: the distributor proxy is UPGRADED, never replaced.
     *      `claimed[token][user]` is the only record of what was paid, and it lives in the proxy.
     *      This upgrades the live proxy on the fork, through its owner, after payouts in BOTH
     *      tokens, and shows every per-token ledger survives, every old voucher is still a no-op,
     *      and a larger voucher still pays only its delta.
     */
    function test_SEC04_AnUpgradeKeepsThePerTokenLedgers() public {
        vm.prank(multisig);
        distributor.setClaimsEnabled(assetToken, true);
        _claim(ovtr, alice, AWARD);
        _claim(assetToken, alice, AWARD * 2);
        _claim(ovtr, bob, AWARD * 5);

        address v2 = address(new RewardsDistributorV2Mock());
        vm.prank(multisig);
        distributor.upgradeToAndCall(v2, "");
        assertEq(RewardsDistributorV2Mock(address(distributor)).version(), 2, "the new code is running");

        assertEq(distributor.claimed(ovtr, alice), AWARD, "alice's $OVTR ledger survives the upgrade");
        assertEq(distributor.claimed(assetToken, alice), AWARD * 2, "alice's $ASSET ledger survives the upgrade");
        assertEq(distributor.claimed(ovtr, bob), AWARD * 5, "bob's $OVTR ledger survives the upgrade");

        bytes memory voucher = _sign(ovtr, alice, AWARD);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IRewardsDistributor.NothingToClaim.selector, AWARD, AWARD));
        distributor.claim(ovtr, AWARD, FAR_DEADLINE, voucher);

        bytes memory voucher2 = _sign(assetToken, alice, AWARD * 2);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IRewardsDistributor.NothingToClaim.selector, AWARD * 2, AWARD * 2));
        distributor.claim(assetToken, AWARD * 2, FAR_DEADLINE, voucher2);

        bytes memory voucher3 = _sign(ovtr, alice, AWARD * 4);
        vm.prank(alice);
        assertEq(
            distributor.claim(ovtr, AWARD * 4, FAR_DEADLINE, voucher3),
            AWARD * 3,
            "a larger voucher still pays only its delta after the upgrade"
        );
    }

    /**
     * @dev Why the rule exists, measured: a REPLACEMENT proxy starts with an empty ledger, so the
     *      same lifetime voucher (re-signed for the new verifying contract) pays a second time
     *      out of whatever the new contract is funded with. Nothing in the contract can stop
     *      that; the only defence is never to deploy a replacement and point users at it.
     */
    function test_SEC04_AReplacementProxyWouldReplayEveryLifetimeEntitlement() public {
        _claim(ovtr, alice, AWARD);

        RewardsDistributor replacement = _deployDistributorProxy(
            address(this), multisig, multisig, voucherSigner, _launchRewardTokens(assetToken, false, ovtr)
        );
        vm.prank(multisig);
        overture.mint(address(replacement), AWARD);

        assertEq(replacement.claimed(ovtr, alice), 0, "the replacement starts with an empty ledger");

        bytes32 digest = _rewardClaimDigest(replacement, ovtr, alice, AWARD, FAR_DEADLINE);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(voucherSignerPk, digest);
        vm.prank(alice);
        uint256 paid = replacement.claim(ovtr, AWARD, FAR_DEADLINE, abi.encodePacked(r, s, v));

        assertEq(paid, AWARD, "the same lifetime entitlement is payable a second time");
        assertEq(overture.balanceOf(alice), AWARD * 2, "so the user ends up with twice what they earned");
    }

    // ──────────────────────── Helpers ──────────────────────────

    function _sign(address token, address user, uint256 cumulative) private view returns (bytes memory) {
        return _signVoucher(voucherSignerPk, token, user, cumulative, FAR_DEADLINE);
    }

    function _claim(address token, address user, uint256 cumulative) private {
        bytes memory sig = _sign(token, user, cumulative);
        vm.prank(user);
        distributor.claim(token, cumulative, FAR_DEADLINE, sig);
    }
}
