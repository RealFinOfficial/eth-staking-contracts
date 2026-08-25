// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LocalHarness} from "../utils/LocalHarness.sol";
import {RewardsDistributor} from "../../../contracts/lp-staking/RewardsDistributor.sol";
import {TokenX} from "../../../contracts/lp-staking/TokenX.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @notice Why this file exists: {RewardsDistributor} is a signature verifier with a ledger,
 *         and both halves have boundaries that a happy-path test never reaches — the exact
 *         order its three gates fire in, the `<=` that separates "nothing to claim" from a
 *         one-wei increment, and the three distinct ways an ECDSA signature can be malformed.
 *         Each of those is one branch, and each is one assertion here.
 */
contract DistributorBranchesTest is LocalHarness {
    uint256 internal constant AWARD = 1_000e18;
    /// @dev secp256k1 group order; `N - s` is the malleable twin of any valid signature.
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    function setUp() public {
        _deployLocalStack();
    }

    // ──────────────────────── Constructor ──────────────────────

    function test_Constructor_RejectsAZeroTokenX() public {
        vm.expectRevert(RewardsDistributor.ZeroAddress.selector);
        new RewardsDistributor(address(0), address(asset), voucherSigner, address(this));
    }

    function test_Constructor_RejectsAZeroAsset() public {
        vm.expectRevert(RewardsDistributor.ZeroAddress.selector);
        new RewardsDistributor(address(tokenX), address(0), voucherSigner, address(this));
    }

    function test_Constructor_RejectsAZeroSigner() public {
        vm.expectRevert(RewardsDistributor.ZeroAddress.selector);
        new RewardsDistributor(address(tokenX), address(asset), address(0), address(this));
    }

    /// @dev The signer must be followable from logs alone, from block one.
    function test_Constructor_AnnouncesTheInitialSigner() public {
        vm.expectEmit(false, false, false, true);
        emit RewardsDistributor.SignerChanged(address(0), voucherSigner);
        new RewardsDistributor(address(tokenX), address(asset), voucherSigner, address(this));
    }

    function test_Constructor_StartsPausedOffAndWithAssetClaimsDisabled() public view {
        assertFalse(distributor.paused(), "claims must be live from deployment");
        assertFalse(distributor.assetClaimsEnabled(), "the ASSET leg must be off until the owner enables it");
        assertEq(distributor.signer(), voucherSigner, "the configured signer must be stored");
    }

    // ──────────────────────── Gate ordering ────────────────────

    /**
     * @dev `claimAsset` checks `assetClaimsEnabled` BEFORE calling `_verifyClaim`, which is
     *      where the pause check lives. With both switches hostile the caller therefore sees
     *      `AssetClaimsDisabled`, never `ClaimsPaused` — an ordering a reader cannot infer
     *      from the two functions in isolation.
     */
    function test_ClaimAsset_AssetsDisabledBeatsPausedWhenBothAreSet() public {
        distributor.setPaused(true);
        bytes memory sig = _sign(distributor.ASSET_CLAIM_TYPEHASH(), alice, AWARD, FAR_DEADLINE);

        vm.prank(alice);
        vm.expectRevert(RewardsDistributor.AssetClaimsDisabled.selector);
        distributor.claimAsset(AWARD, FAR_DEADLINE, sig);
    }

    /// @dev With the ASSET leg enabled the pause becomes visible again, which is what makes
    ///      the ordering above a real ordering rather than a missing check.
    function test_ClaimAsset_ShowsPausedOnceTheAssetLegIsEnabled() public {
        distributor.setAssetClaimsEnabled(true);
        distributor.setPaused(true);
        bytes memory sig = _sign(distributor.ASSET_CLAIM_TYPEHASH(), alice, AWARD, FAR_DEADLINE);

        vm.prank(alice);
        vm.expectRevert(RewardsDistributor.ClaimsPaused.selector);
        distributor.claimAsset(AWARD, FAR_DEADLINE, sig);
    }

    /// @dev Inside `_verifyClaim` the order is pause -> deadline -> amount -> signature. An
    ///      expired deadline on a paused contract must therefore still report the pause.
    function test_Verify_PausedBeatsAnExpiredDeadline() public {
        distributor.setPaused(true);
        bytes memory sig = _sign(distributor.TOKENX_CLAIM_TYPEHASH(), alice, AWARD, 0);

        vm.prank(alice);
        vm.expectRevert(RewardsDistributor.ClaimsPaused.selector);
        distributor.claimTokenX(AWARD, 0, sig);
    }

    /// @dev And an expired deadline beats a bad signature — the cheap check runs first.
    function test_Verify_ExpiredDeadlineBeatsABadSignature() public {
        vm.warp(1_000_000);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RewardsDistributor.ClaimExpired.selector, uint256(0), block.timestamp));
        distributor.claimTokenX(AWARD, 0, hex"deadbeef");
    }

    // ──────────────────────── Deadline boundary ────────────────

    /// @dev `block.timestamp > deadline` — equality is still inside the window.
    function test_Verify_ADeadlineEqualToNowIsStillValid() public {
        vm.warp(1_000_000);
        bytes memory sig = _sign(distributor.TOKENX_CLAIM_TYPEHASH(), alice, AWARD, block.timestamp);

        vm.prank(alice);
        uint256 paid = distributor.claimTokenX(AWARD, block.timestamp, sig);
        assertEq(paid, AWARD, "a deadline exactly at the current timestamp must be honoured");
    }

    function test_Verify_OneSecondPastTheDeadlineReverts() public {
        vm.warp(1_000_000);
        uint256 deadline = block.timestamp - 1;
        bytes memory sig = _sign(distributor.TOKENX_CLAIM_TYPEHASH(), alice, AWARD, deadline);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RewardsDistributor.ClaimExpired.selector, deadline, block.timestamp));
        distributor.claimTokenX(AWARD, deadline, sig);
    }

    // ──────────────────────── Amount boundary ──────────────────

    /// @dev `cumulativeAmount <= alreadyClaimed` has two arms. This is the equal one.
    function test_Claim_RevertsWhenTheCumulativeIsUnchanged() public {
        _claim(alice, AWARD);

        bytes memory sig = _sign(distributor.TOKENX_CLAIM_TYPEHASH(), alice, AWARD, FAR_DEADLINE);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RewardsDistributor.NothingToClaim.selector, AWARD, AWARD));
        distributor.claimTokenX(AWARD, FAR_DEADLINE, sig);
    }

    /// @dev ...and this is the strictly-smaller one: a stale voucher can never claw back.
    function test_Claim_RevertsOnAStaleSmallerCumulative() public {
        _claim(alice, AWARD);

        bytes memory sig = _sign(distributor.TOKENX_CLAIM_TYPEHASH(), alice, AWARD - 1, FAR_DEADLINE);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RewardsDistributor.NothingToClaim.selector, AWARD - 1, AWARD));
        distributor.claimTokenX(AWARD - 1, FAR_DEADLINE, sig);
    }

    /// @dev One wei more is a valid claim, and pays exactly one wei.
    function test_Claim_AOneWeiIncrementIsPayable() public {
        _claim(alice, AWARD);

        bytes memory sig = _sign(distributor.TOKENX_CLAIM_TYPEHASH(), alice, AWARD + 1, FAR_DEADLINE);
        vm.prank(alice);
        uint256 paid = distributor.claimTokenX(AWARD + 1, FAR_DEADLINE, sig);
        assertEq(paid, 1, "the payout must be exactly the increment, not the cumulative");
    }

    /// @dev A cumulative at the top of the type still subtracts cleanly. The epoch cap is the
    ///      only thing that would normally stop it, so it is opened for this one test.
    function test_Claim_HandlesACumulativeAtTheTopOfUint256() public {
        tokenX.setEpochCap(EPOCH_ONE, type(uint256).max);

        bytes memory sig = _sign(distributor.TOKENX_CLAIM_TYPEHASH(), alice, type(uint256).max, FAR_DEADLINE);
        vm.prank(alice);
        uint256 paid = distributor.claimTokenX(type(uint256).max, FAR_DEADLINE, sig);

        assertEq(paid, type(uint256).max, "a maximal cumulative must pay out in full on the first claim");
        assertEq(distributor.claimedTokenX(alice), type(uint256).max, "and the ledger must record it");

        bytes memory again = _sign(distributor.TOKENX_CLAIM_TYPEHASH(), alice, type(uint256).max, FAR_DEADLINE);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(RewardsDistributor.NothingToClaim.selector, type(uint256).max, type(uint256).max)
        );
        distributor.claimTokenX(type(uint256).max, FAR_DEADLINE, again);
    }

    // ──────────────────────── Signature shapes ─────────────────

    /// @dev The malleable twin (N - s, flipped v) recovers the same key on raw `ecrecover`.
    ///      OpenZeppelin's `ECDSA` rejects it outright, which is what stops a second, equally
    ///      valid encoding of the same voucher from existing.
    function test_Signature_HighSMalleableTwinIsRejected() public {
        bytes32 digest = _voucherDigest(distributor.TOKENX_CLAIM_TYPEHASH(), alice, AWARD, FAR_DEADLINE);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(voucherSignerPk, digest);

        bytes32 flippedS = bytes32(SECP256K1_N - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;
        bytes memory malleable = abi.encodePacked(r, flippedS, flippedV);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureS.selector, flippedS));
        distributor.claimTokenX(AWARD, FAR_DEADLINE, malleable);
    }

    function test_Signature_WrongLengthIsRejectedWithTheLength() public {
        bytes memory tooShort = new bytes(64);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureLength.selector, uint256(64)));
        distributor.claimTokenX(AWARD, FAR_DEADLINE, tooShort);
    }

    function test_Signature_AnImpossibleVIsRejected() public {
        bytes32 digest = _voucherDigest(distributor.TOKENX_CLAIM_TYPEHASH(), alice, AWARD, FAR_DEADLINE);
        (, bytes32 r, bytes32 s) = vm.sign(voucherSignerPk, digest);
        bytes memory badV = abi.encodePacked(r, s, uint8(29));

        vm.prank(alice);
        vm.expectRevert(ECDSA.ECDSAInvalidSignature.selector);
        distributor.claimTokenX(AWARD, FAR_DEADLINE, badV);
    }

    function test_Signature_AVoucherSignedByAnybodyElseIsRejected() public {
        (address impostor, uint256 impostorPk) = makeAddrAndKey("impostor");
        bytes memory sig = _signAs(impostorPk, distributor.TOKENX_CLAIM_TYPEHASH(), alice, AWARD, FAR_DEADLINE);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RewardsDistributor.InvalidSignature.selector, impostor, voucherSigner));
        distributor.claimTokenX(AWARD, FAR_DEADLINE, sig);
    }

    /**
     * @dev The EIP-712 domain carries `block.chainid`, and OpenZeppelin's `EIP712` recomputes
     *      the separator whenever the chain id moves away from the one it cached at
     *      construction. A voucher signed on one chain is therefore worthless on a fork of it.
     */
    function test_Signature_IsNotReplayableOnAnotherChainId() public {
        bytes memory sig = _sign(distributor.TOKENX_CLAIM_TYPEHASH(), alice, AWARD, FAR_DEADLINE);

        vm.chainId(999);

        vm.prank(alice);
        vm.expectPartialRevert(RewardsDistributor.InvalidSignature.selector);
        distributor.claimTokenX(AWARD, FAR_DEADLINE, sig);
    }

    /// @dev The two legs are separated by their type hash alone, so this is the assertion
    ///      that keeps them separate.
    function test_Signature_TypeHashesKeepTheTwoLegsApart() public {
        assertTrue(
            distributor.TOKENX_CLAIM_TYPEHASH() != distributor.ASSET_CLAIM_TYPEHASH(),
            "the two legs must not share a type hash"
        );

        distributor.setAssetClaimsEnabled(true);
        bytes memory assetSig = _sign(distributor.ASSET_CLAIM_TYPEHASH(), alice, AWARD, FAR_DEADLINE);

        vm.prank(alice);
        vm.expectPartialRevert(RewardsDistributor.InvalidSignature.selector);
        distributor.claimTokenX(AWARD, FAR_DEADLINE, assetSig);
    }

    // ──────────────────────── Events + ledgers ─────────────────

    function test_Claim_EmitsTheCumulativeAndThePaidAmountSeparately() public {
        _claim(alice, AWARD);
        bytes memory sig = _sign(distributor.TOKENX_CLAIM_TYPEHASH(), alice, AWARD * 2, FAR_DEADLINE);

        vm.expectEmit(true, true, false, true, address(distributor));
        emit RewardsDistributor.Claimed(alice, address(tokenX), AWARD * 2, AWARD, block.timestamp);
        vm.prank(alice);
        distributor.claimTokenX(AWARD * 2, FAR_DEADLINE, sig);
    }

    function test_Claim_LedgersAreKeptPerUser() public {
        _claim(alice, AWARD);
        _claim(bob, AWARD * 2);

        assertEq(distributor.claimedTokenX(alice), AWARD, "alice's ledger must hold only her own cumulative");
        assertEq(distributor.claimedTokenX(bob), AWARD * 2, "bob's ledger must hold only his own cumulative");
        assertEq(tokenX.balanceOf(alice), AWARD, "and the mints must land per user");
        assertEq(tokenX.balanceOf(bob), AWARD * 2, "and the mints must land per user");
    }

    // ──────────────────────── Owner surface ────────────────────

    function test_SetSigner_RejectsZeroAndAnnouncesBothSides() public {
        vm.expectRevert(RewardsDistributor.ZeroAddress.selector);
        distributor.setSigner(address(0));

        vm.expectEmit(false, false, false, true, address(distributor));
        emit RewardsDistributor.SignerChanged(voucherSigner, carol);
        distributor.setSigner(carol);
        assertEq(distributor.signer(), carol, "the new signer must be stored");
    }

    function test_SetPaused_AndSetAssetClaimsEnabled_EmitTheFullNewState() public {
        vm.expectEmit(false, false, false, true, address(distributor));
        emit RewardsDistributor.Paused(true);
        distributor.setPaused(true);

        vm.expectEmit(false, false, false, true, address(distributor));
        emit RewardsDistributor.AssetClaimsEnabled(true);
        distributor.setAssetClaimsEnabled(true);
    }

    function test_RecoverExcessAsset_RejectsAZeroAmount() public {
        vm.expectRevert(RewardsDistributor.ZeroAmount.selector);
        distributor.recoverExcessAsset(0);
    }

    /// @dev The destination is `owner()` and there is no argument to mistype.
    function test_RecoverExcessAsset_AlwaysSendsToTheOwner() public {
        uint256 before = asset.balanceOf(address(this));

        vm.expectEmit(false, false, false, true, address(distributor));
        emit RewardsDistributor.ExcessAssetRecovered(address(this), 1_000e18, block.timestamp);
        distributor.recoverExcessAsset(1_000e18);

        assertEq(asset.balanceOf(address(this)) - before, 1_000e18, "the recovery must land on owner()");
    }

    function test_RecoverExcessAsset_RevertsBeyondTheHeldBalance() public {
        uint256 held = asset.balanceOf(address(distributor));

        vm.expectRevert();
        distributor.recoverExcessAsset(held + 1);
    }

    function test_OwnerFunctions_AreAllOwnerOnly() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        distributor.setSigner(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        distributor.setPaused(true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        distributor.setAssetClaimsEnabled(true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        distributor.recoverExcessAsset(1);
        vm.stopPrank();
    }

    /**
     * @dev Renouncing freezes the distributor in whatever state it was in. The dangerous
     *      combination is renouncing while PAUSED: claims can then never be resumed, and the
     *      ASSET balance can never be recovered either.
     */
    function test_RenounceOwnership_WhilePausedFreezesTheProgramForever() public {
        distributor.setPaused(true);
        distributor.renounceOwnership();

        bytes memory sig = _sign(distributor.TOKENX_CLAIM_TYPEHASH(), alice, AWARD, FAR_DEADLINE);
        vm.prank(alice);
        vm.expectRevert(RewardsDistributor.ClaimsPaused.selector);
        distributor.claimTokenX(AWARD, FAR_DEADLINE, sig);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        distributor.setPaused(false);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        distributor.recoverExcessAsset(1);
    }

    /// @dev Renouncing while UNpaused leaves the claim path working forever, which is the
    ///      benign half of the same switch.
    function test_RenounceOwnership_WhileLiveLeavesClaimsWorking() public {
        distributor.renounceOwnership();

        bytes memory sig = _sign(distributor.TOKENX_CLAIM_TYPEHASH(), alice, AWARD, FAR_DEADLINE);
        vm.prank(alice);
        assertEq(distributor.claimTokenX(AWARD, FAR_DEADLINE, sig), AWARD, "claims must outlive the owner");
    }

    // ──────────────────────── TokenX coupling ──────────────────

    /// @dev The distributor cannot mint unless TokenX still names it as the minter.
    function test_Claim_RevertsWhenTheDistributorIsNoLongerTheMinter() public {
        tokenX.setMinter(carol);

        bytes memory sig = _sign(distributor.TOKENX_CLAIM_TYPEHASH(), alice, AWARD, FAR_DEADLINE);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TokenX.NotMinter.selector, address(distributor)));
        distributor.claimTokenX(AWARD, FAR_DEADLINE, sig);
    }

    // ──────────────────────── Helpers ──────────────────────────

    function _sign(bytes32 typehash, address user, uint256 cumulative, uint256 deadline)
        private
        view
        returns (bytes memory)
    {
        return _signVoucher(voucherSignerPk, typehash, user, cumulative, deadline);
    }

    function _signAs(uint256 pk, bytes32 typehash, address user, uint256 cumulative, uint256 deadline)
        private
        view
        returns (bytes memory)
    {
        return _signVoucher(pk, typehash, user, cumulative, deadline);
    }

    function _claim(address user, uint256 cumulative) private {
        bytes memory sig = _sign(distributor.TOKENX_CLAIM_TYPEHASH(), user, cumulative, FAR_DEADLINE);
        vm.prank(user);
        distributor.claimTokenX(cumulative, FAR_DEADLINE, sig);
    }
}
