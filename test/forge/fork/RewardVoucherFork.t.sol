// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkHarness} from "../utils/ForkHarness.sol";
import {RewardsDistributor} from "../../../contracts/lp-staking/RewardsDistributor.sol";
import {TokenX} from "../../../contracts/lp-staking/TokenX.sol";
import {IERC20Like} from "../utils/Interfaces.sol";

/**
 * @notice Why this file exists: the reward legs are EIP-712 over a domain that includes the
 *         live chain id and the deployed distributor address, and the TokenX leg is bounded
 *         by a cap the distributor cannot see. Both are properties of a REAL deployment on a
 *         REAL chain id, and the migration finding below is only visible when a second
 *         distributor can actually be deployed and wired in.
 *
 *  SEC-04 lives here.
 */
contract RewardVoucherForkTest is ForkHarness {
    uint256 internal constant AWARD = 1_000e18;

    function setUp() public {
        _deployForkedStack();
    }

    // ──────────────────────── TokenX leg ───────────────────────

    function test_ClaimTokenX_MintsAgainstAVoucherFromTheConfiguredSigner() public {
        bytes memory sig =
            _signVoucher(voucherSignerPk, distributor.TOKENX_CLAIM_TYPEHASH(), alice, AWARD, FAR_DEADLINE);

        vm.prank(alice);
        uint256 paid = distributor.claimTokenX(AWARD, FAR_DEADLINE, sig);

        assertEq(paid, AWARD, "the first claim pays the whole cumulative entitlement");
        assertEq(tokenX.balanceOf(alice), AWARD, "and the TokenX really is minted to the claimer");
        assertEq(distributor.claimedTokenX(alice), AWARD, "the ledger records the cumulative, not the delta");
    }

    /// @dev The vouchers are CUMULATIVE, so a later one pays only what has been added since.
    function test_ClaimTokenX_ASecondVoucherPaysOnlyTheDelta() public {
        _claimTokenX(alice, AWARD);

        bytes memory sig =
            _signVoucher(voucherSignerPk, distributor.TOKENX_CLAIM_TYPEHASH(), alice, AWARD * 3, FAR_DEADLINE);
        vm.prank(alice);
        uint256 paid = distributor.claimTokenX(AWARD * 3, FAR_DEADLINE, sig);

        assertEq(paid, AWARD * 2, "the second claim must pay only the increase");
        assertEq(tokenX.balanceOf(alice), AWARD * 3, "the balance must equal the latest cumulative");
    }

    function test_ClaimTokenX_RevertsWhenTheCumulativeHasNotGrown() public {
        _claimTokenX(alice, AWARD);

        bytes memory sig =
            _signVoucher(voucherSignerPk, distributor.TOKENX_CLAIM_TYPEHASH(), alice, AWARD, FAR_DEADLINE);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RewardsDistributor.NothingToClaim.selector, AWARD, AWARD));
        distributor.claimTokenX(AWARD, FAR_DEADLINE, sig);
    }

    /// @dev A voucher names its claimer, so it is worthless in anyone else's hands.
    function test_Voucher_IsBoundToTheAddressItNames() public {
        bytes memory sig =
            _signVoucher(voucherSignerPk, distributor.TOKENX_CLAIM_TYPEHASH(), alice, AWARD, FAR_DEADLINE);

        vm.prank(bob);
        vm.expectPartialRevert(RewardsDistributor.InvalidSignature.selector);
        distributor.claimTokenX(AWARD, FAR_DEADLINE, sig);
    }

    /// @dev The two legs use distinct type hashes, so a TokenX voucher cannot be spent on the
    ///      ASSET leg or the other way round.
    function test_Voucher_CannotBeReplayedAcrossTheTwoLegs() public {
        vm.prank(multisig);
        distributor.setAssetClaimsEnabled(true);
        _fund(profile.asset, address(distributor), 1_000_000e18);

        bytes memory tokenXSig =
            _signVoucher(voucherSignerPk, distributor.TOKENX_CLAIM_TYPEHASH(), alice, AWARD, FAR_DEADLINE);

        vm.prank(alice);
        vm.expectPartialRevert(RewardsDistributor.InvalidSignature.selector);
        distributor.claimAsset(AWARD, FAR_DEADLINE, tokenXSig);
    }

    function test_Voucher_RevertsOnAnExpiredDeadline() public {
        uint256 deadline = block.timestamp - 1;
        bytes memory sig = _signVoucher(voucherSignerPk, distributor.TOKENX_CLAIM_TYPEHASH(), alice, AWARD, deadline);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RewardsDistributor.ClaimExpired.selector, deadline, block.timestamp));
        distributor.claimTokenX(AWARD, deadline, sig);
    }

    function test_Voucher_PausingBlocksBothLegs() public {
        vm.startPrank(multisig);
        distributor.setAssetClaimsEnabled(true);
        distributor.setPaused(true);
        vm.stopPrank();
        _fund(profile.asset, address(distributor), 1_000_000e18);

        bytes memory tokenXSig =
            _signVoucher(voucherSignerPk, distributor.TOKENX_CLAIM_TYPEHASH(), alice, AWARD, FAR_DEADLINE);
        bytes memory assetSig =
            _signVoucher(voucherSignerPk, distributor.ASSET_CLAIM_TYPEHASH(), alice, AWARD, FAR_DEADLINE);

        vm.prank(alice);
        vm.expectRevert(RewardsDistributor.ClaimsPaused.selector);
        distributor.claimTokenX(AWARD, FAR_DEADLINE, tokenXSig);

        vm.prank(alice);
        vm.expectRevert(RewardsDistributor.ClaimsPaused.selector);
        distributor.claimAsset(AWARD, FAR_DEADLINE, assetSig);
    }

    /**
     * @dev V-21: rotating the signer invalidates every voucher signed by the previous one —
     *      and rotating BACK revalidates them, because nothing about a voucher records which
     *      signer was current when it was issued. Vouchers are therefore valid whenever their
     *      signer is, not when they were signed.
     */
    function test_Voucher_SignerRotationInvalidatesAndRotatingBackRevalidates() public {
        bytes memory sig =
            _signVoucher(voucherSignerPk, distributor.TOKENX_CLAIM_TYPEHASH(), alice, AWARD, FAR_DEADLINE);
        (address newSigner,) = makeAddrAndKey("rotatedSigner");

        vm.prank(multisig);
        distributor.setSigner(newSigner);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RewardsDistributor.InvalidSignature.selector, voucherSigner, newSigner));
        distributor.claimTokenX(AWARD, FAR_DEADLINE, sig);

        vm.prank(multisig);
        distributor.setSigner(voucherSigner);

        vm.prank(alice);
        uint256 paid = distributor.claimTokenX(AWARD, FAR_DEADLINE, sig);
        assertEq(paid, AWARD, "rotating the signer back makes the old voucher spendable again");
    }

    /**
     * @dev V-24, the cap-headroom race: the distributor knows nothing about TokenX's epoch
     *      cap, so two valid vouchers can add up to more than the epoch allows. The first
     *      claim through wins and the second reverts inside the token, with a signed,
     *      never-spent voucher left in the user's hands.
     */
    function test_Voucher_CapHeadroomRaceLeavesTheLoserWithAnUnspendableVoucher() public {
        uint256 cap = tokenX.epochCap(EPOCH_ONE);
        uint256 nearlyAll = cap - 1e18;

        _claimTokenX(alice, nearlyAll);

        bytes memory bobSig =
            _signVoucher(voucherSignerPk, distributor.TOKENX_CLAIM_TYPEHASH(), bob, 10e18, FAR_DEADLINE);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(TokenX.EpochMintCapExceeded.selector, EPOCH_ONE, cap, nearlyAll, 10e18));
        distributor.claimTokenX(10e18, FAR_DEADLINE, bobSig);

        assertEq(distributor.claimedTokenX(bob), 0, "the loser's ledger must stay untouched");
    }

    // ──────────────────────── ASSET leg ────────────────────────

    function test_ClaimAsset_IsDisabledUntilTheOwnerEnablesIt() public {
        _fund(profile.asset, address(distributor), 1_000_000e18);
        bytes memory sig = _signVoucher(voucherSignerPk, distributor.ASSET_CLAIM_TYPEHASH(), alice, AWARD, FAR_DEADLINE);

        assertFalse(distributor.assetClaimsEnabled(), "a fresh deployment must not pay ASSET");

        vm.prank(alice);
        vm.expectRevert(RewardsDistributor.AssetClaimsDisabled.selector);
        distributor.claimAsset(AWARD, FAR_DEADLINE, sig);

        vm.prank(multisig);
        distributor.setAssetClaimsEnabled(true);

        uint256 before = IERC20Like(profile.asset).balanceOf(alice);
        vm.prank(alice);
        uint256 paid = distributor.claimAsset(AWARD, FAR_DEADLINE, sig);

        assertEq(paid, AWARD, "the enabled leg must pay the whole entitlement");
        assertEq(
            IERC20Like(profile.asset).balanceOf(alice) - before, AWARD, "and the real ASSET must reach the claimer"
        );
    }

    /// @dev The two ledgers are independent: spending one leg leaves the other whole.
    function test_ClaimAsset_AndClaimTokenXKeepSeparateLedgers() public {
        _fund(profile.asset, address(distributor), 1_000_000e18);
        vm.prank(multisig);
        distributor.setAssetClaimsEnabled(true);

        _claimTokenX(alice, AWARD);

        bytes memory assetSig =
            _signVoucher(voucherSignerPk, distributor.ASSET_CLAIM_TYPEHASH(), alice, AWARD, FAR_DEADLINE);
        vm.prank(alice);
        uint256 paid = distributor.claimAsset(AWARD, FAR_DEADLINE, assetSig);

        assertEq(paid, AWARD, "the ASSET leg must be unaffected by TokenX claims");
        assertEq(distributor.claimedTokenX(alice), AWARD, "the TokenX ledger must be unchanged");
        assertEq(distributor.claimedAsset(alice), AWARD, "the ASSET ledger must record its own cumulative");
    }

    // ──────────────────────── SEC-04 ───────────────────────────

    /**
     * @dev FINDING SEC-04 (V-05): `TokenX.setMinter` is the migration escape hatch, and the
     *      claim ledger lives on the DISTRIBUTOR, not on the token. A replacement distributor
     *      therefore starts with an empty `claimedTokenX` mapping, so every user can re-spend
     *      their entire LIFETIME entitlement against it. Only the epoch cap bounds the damage.
     *      Asserted as the CURRENT behaviour; the mitigation is operational — a migration must
     *      seed the new ledger, or arm a fresh epoch whose cap reflects what is really owed.
     */
    function test_SEC04_AReplacementDistributorReplaysEveryLifetimeEntitlement() public {
        _claimTokenX(alice, AWARD);
        assertEq(tokenX.balanceOf(alice), AWARD, "precondition: the first distributor paid once");

        RewardsDistributor distributorV2 = _deployDistributorProxy(
            address(tokenX), profile.asset, address(this), address(this), address(this), voucherSigner
        );

        vm.prank(multisig);
        tokenX.setMinter(address(distributorV2));

        assertEq(distributorV2.claimedTokenX(alice), 0, "the replacement starts with an empty ledger");

        bytes memory sig = _signVoucherFor(
            distributorV2, voucherSignerPk, distributorV2.TOKENX_CLAIM_TYPEHASH(), alice, AWARD, FAR_DEADLINE
        );
        vm.prank(alice);
        uint256 paid = distributorV2.claimTokenX(AWARD, FAR_DEADLINE, sig);

        assertEq(paid, AWARD, "the same lifetime entitlement is payable a second time");
        assertEq(tokenX.balanceOf(alice), AWARD * 2, "so the user ends up with twice what they earned");
        assertEq(
            tokenX.mintedInEpoch(EPOCH_ONE), AWARD * 2, "the epoch cap is the only thing that ever bounded the replay"
        );
    }

    /// @dev The old distributor stops minting the moment the minter moves, so the replay is
    ///      an addition to the new one, never a doubling through both at once.
    function test_SEC04_TheReplacedDistributorLosesItsMintRightImmediately() public {
        RewardsDistributor distributorV2 = _deployDistributorProxy(
            address(tokenX), profile.asset, address(this), address(this), address(this), voucherSigner
        );
        vm.prank(multisig);
        tokenX.setMinter(address(distributorV2));

        bytes memory sig =
            _signVoucher(voucherSignerPk, distributor.TOKENX_CLAIM_TYPEHASH(), alice, AWARD, FAR_DEADLINE);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TokenX.NotMinter.selector, address(distributor)));
        distributor.claimTokenX(AWARD, FAR_DEADLINE, sig);
    }

    // ──────────────────────── Helpers ──────────────────────────

    function _claimTokenX(address user, uint256 cumulative) private {
        bytes memory sig =
            _signVoucher(voucherSignerPk, distributor.TOKENX_CLAIM_TYPEHASH(), user, cumulative, FAR_DEADLINE);
        vm.prank(user);
        distributor.claimTokenX(cumulative, FAR_DEADLINE, sig);
    }

    /// @dev {ForkHarness-_signVoucher} always signs for the harness's own distributor; the
    ///      migration test needs a voucher bound to a DIFFERENT verifying contract.
    function _signVoucherFor(
        RewardsDistributor target,
        uint256 pk,
        bytes32 typehash,
        address user,
        uint256 cumulativeAmount,
        uint256 deadline
    ) private view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(typehash, user, cumulativeAmount, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparatorOf(target), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _domainSeparatorOf(RewardsDistributor target) private view returns (bytes32) {
        (, string memory name_, string memory version_, uint256 chainId_, address verifying_,,) = target.eip712Domain();
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH, keccak256(bytes(name_)), keccak256(bytes(version_)), chainId_, verifying_
            )
        );
    }
}
