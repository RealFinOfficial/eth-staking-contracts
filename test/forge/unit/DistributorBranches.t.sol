// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LocalHarness} from "../utils/LocalHarness.sol";
import {RewardsDistributor} from "../../../contracts/lp-staking/RewardsDistributor.sol";
import {RewardsDistributorV2Mock} from "../../../contracts/lp-staking/mocks/RewardsDistributorV2Mock.sol";
import {LPProxy} from "../../../contracts/lp-staking/deploy/LPProxy.sol";
import {TokenX} from "../../../contracts/lp-staking/TokenX.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";

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

    // ──────────────────────── Implementation constructor ───────
    //
    // The two immutables are the implementation's only constructor work, so their zero
    // checks fire on the IMPLEMENTATION deploy — before any proxy exists.

    function test_Constructor_RejectsAZeroTokenX() public {
        vm.expectRevert(RewardsDistributor.ZeroAddress.selector);
        new RewardsDistributor(address(0), address(asset));
    }

    function test_Constructor_RejectsAZeroAsset() public {
        vm.expectRevert(RewardsDistributor.ZeroAddress.selector);
        new RewardsDistributor(address(tokenX), address(0));
    }

    /// @dev A bare implementation must be inert: its initializers are burnt in its own
    ///      constructor, so nobody can take ownership of the code the proxy delegates to.
    function test_Constructor_DisablesTheImplementationsInitializers() public {
        RewardsDistributor impl = new RewardsDistributor(address(tokenX), address(asset));

        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(address(this), multisig, operatorSafe, voucherSigner);
    }

    // ──────────────────────── Initializer ──────────────────────

    function test_Initialize_RejectsAZeroOwner() public {
        address impl = address(new RewardsDistributor(address(tokenX), address(asset)));

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new LPProxy(
            impl, abi.encodeCall(RewardsDistributor.initialize, (address(0), multisig, operatorSafe, voucherSigner))
        );
    }

    function test_Initialize_RejectsAZeroGuardian() public {
        address impl = address(new RewardsDistributor(address(tokenX), address(asset)));

        vm.expectRevert(RewardsDistributor.ZeroAddress.selector);
        new LPProxy(
            impl,
            abi.encodeCall(RewardsDistributor.initialize, (address(this), address(0), operatorSafe, voucherSigner))
        );
    }

    /// @dev The operator's zero check shares the `||` with the guardian's, so it needs its own
    ///      arm: a zero operator would leave `setSigner` and `recoverExcessAsset` callable by
    ///      nobody and the pause switch held by the guardian alone.
    function test_Initialize_RejectsAZeroOperator() public {
        address impl = address(new RewardsDistributor(address(tokenX), address(asset)));

        vm.expectRevert(RewardsDistributor.ZeroAddress.selector);
        new LPProxy(
            impl, abi.encodeCall(RewardsDistributor.initialize, (address(this), multisig, address(0), voucherSigner))
        );
    }

    function test_Initialize_RejectsAZeroSigner() public {
        address impl = address(new RewardsDistributor(address(tokenX), address(asset)));

        vm.expectRevert(RewardsDistributor.ZeroAddress.selector);
        new LPProxy(
            impl, abi.encodeCall(RewardsDistributor.initialize, (address(this), multisig, operatorSafe, address(0)))
        );
    }

    /**
     * @dev Every mutable field must be followable from logs alone, from block one — the two
     *      flags whose initial value is `false` included, so an indexer never has to hardcode
     *      a default. This asserts the FULL ordered list of §6 of the change request, and the
     *      order is the one `initialize` writes it in.
     */
    function test_Initialize_AnnouncesEveryInitialFieldInOrder() public {
        RewardsDistributor impl = new RewardsDistributor(address(tokenX), address(asset));

        vm.expectEmit(false, false, false, true);
        emit RewardsDistributor.GuardianSet(address(0), multisig);
        vm.expectEmit(false, false, false, true);
        emit RewardsDistributor.OperatorSet(address(0), operatorSafe);
        vm.expectEmit(false, false, false, true);
        emit RewardsDistributor.SignerChanged(address(0), voucherSigner);
        vm.expectEmit(false, false, false, true);
        emit RewardsDistributor.Paused(false);
        vm.expectEmit(false, false, false, true);
        emit RewardsDistributor.AssetClaimsEnabled(false);
        RewardsDistributor fresh = RewardsDistributor(
            address(
                new LPProxy(
                    address(impl),
                    abi.encodeCall(
                        RewardsDistributor.initialize, (address(this), multisig, operatorSafe, voucherSigner)
                    )
                )
            )
        );

        // The events are the whole state, so the state has to agree with them.
        assertEq(fresh.guardian(), multisig, "the guardian must be what GuardianSet announced");
        assertEq(fresh.operator(), operatorSafe, "the operator must be what OperatorSet announced");
        assertEq(fresh.signer(), voucherSigner, "the signer must be what SignerChanged announced");
        assertFalse(fresh.paused(), "the pause flag must be what Paused announced");
        assertFalse(fresh.assetClaimsEnabled(), "the ASSET leg must be what AssetClaimsEnabled announced");
    }

    /// @dev A proxy is initialised exactly once; a second call cannot re-seat the owner.
    function test_Initialize_CannotRunTwiceOnTheProxy() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        distributor.initialize(alice, alice, alice, alice);
    }

    function test_Initialize_StartsPausedOffAndWithAssetClaimsDisabled() public view {
        assertFalse(distributor.paused(), "claims must be live from deployment");
        assertFalse(distributor.assetClaimsEnabled(), "the ASSET leg must be off until the owner enables it");
        assertEq(distributor.signer(), voucherSigner, "the configured signer must be stored");
        assertEq(distributor.guardian(), address(this), "the configured guardian must be stored");
        assertEq(distributor.operator(), address(this), "the configured operator must be stored");
    }

    /**
     * @dev The ledger's address, pinned. `REWARDS_DISTRIBUTOR_STORAGE` is a literal in the
     *      contract because it must never move: if it did, every user's `claimed[user]` would
     *      read zero after an upgrade and every lifetime voucher would pay out again. This
     *      recomputes the ERC-7201 derivation and checks the literal against it.
     */
    function test_Storage_LivesAtThePinnedErc7201Slot() public {
        bytes32 expected = keccak256(abi.encode(uint256(keccak256("real.lp.storage.RewardsDistributor")) - 1))
            & ~bytes32(uint256(0xff));

        distributor.setPaused(true);
        distributor.setAssetClaimsEnabled(true);

        // Slot 0 of the namespace packs `signer` (20 bytes) with the two flags that follow it.
        uint256 slot0 = uint256(vm.load(address(distributor), expected));
        assertEq(address(uint160(slot0)), voucherSigner, "namespace slot 0 must start with `signer`");
        assertEq((slot0 >> 160) & 0xff, 1, "`paused` must sit right after `signer`");
        assertEq((slot0 >> 168) & 0xff, 1, "`assetClaimsEnabled` must sit right after `paused`");

        // `guardian` no longer fits in slot 0, so it opens slot 1.
        uint256 slot1 = uint256(vm.load(address(distributor), bytes32(uint256(expected) + 1)));
        assertEq(address(uint160(slot1)), address(this), "namespace slot 1 must be `guardian`");

        // Slots 2 and 3 are the two mappings' bases; `operator` was APPENDED after them, so it
        // opens slot 4 and nothing that was already there moved.
        uint256 slot4 = uint256(vm.load(address(distributor), bytes32(uint256(expected) + 4)));
        assertEq(address(uint160(slot4)), address(this), "namespace slot 4 must be `operator`");
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

    // ──────────────────────── Admin surface ────────────────────

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

    /**
     * @dev The destination is `operator()` and there is no argument to mistype — not
     *      `owner()`, which after the deploy script is a timelock contract with no way to
     *      forward an ERC-20, and not `guardian()`, which is a hot key that must never move
     *      value. Measured on a twin whose three roles are DIFFERENT addresses, so the
     *      assertion cannot pass by two of them being the same account.
     */
    function test_RecoverExcessAsset_AlwaysSendsToTheOperator() public {
        RewardsDistributor twin = _guardedTwin();
        asset.transfer(address(twin), 1_000e18);
        uint256 before = asset.balanceOf(operatorSafe);
        uint256 guardianBefore = asset.balanceOf(multisig);

        vm.expectEmit(false, false, false, true, address(twin));
        emit RewardsDistributor.ExcessAssetRecovered(operatorSafe, 1_000e18, block.timestamp);
        vm.prank(operatorSafe);
        twin.recoverExcessAsset(1_000e18);

        assertEq(asset.balanceOf(operatorSafe) - before, 1_000e18, "the recovery must land on operator()");
        assertEq(asset.balanceOf(multisig), guardianBefore, "and the guardian must have received nothing");
        assertEq(twin.owner(), address(this), "nor the owner");
    }

    function test_RecoverExcessAsset_RevertsBeyondTheHeldBalance() public {
        uint256 held = asset.balanceOf(address(distributor));

        vm.expectRevert();
        distributor.recoverExcessAsset(held + 1);
    }

    /// @dev A stranger holds none of the three tiers. Every rejection names the caller, and
    ///      each names the tier it failed.
    function test_AdminFunctions_RejectAStranger() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        distributor.setAssetClaimsEnabled(true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        distributor.setGuardian(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        distributor.setOperator(alice);
        vm.expectRevert(abi.encodeWithSelector(RewardsDistributor.NotOperator.selector, alice, address(this)));
        distributor.setSigner(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardsDistributor.NotGuardianOrOperator.selector, alice, address(this), address(this)
            )
        );
        distributor.setPaused(true);
        vm.expectRevert(abi.encodeWithSelector(RewardsDistributor.NotOperator.selector, alice, address(this)));
        distributor.recoverExcessAsset(1);
        vm.stopPrank();
    }

    /**
     * @dev The split is real in EVERY direction, which is the whole point of three tiers: the
     *      owner reaches neither undelayed tier, the guardian reaches only the pause switch,
     *      and the operator reaches its own calls plus the pause. Measured on a twin whose
     *      three roles are three different addresses.
     */
    function test_AdminFunctions_TheThreeTiersDoNotOverlap() public {
        RewardsDistributor twin = _guardedTwin();

        // The OWNER is rejected on the pause switch and on every operator function.
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardsDistributor.NotGuardianOrOperator.selector, address(this), multisig, operatorSafe
            )
        );
        twin.setPaused(true);
        vm.expectRevert(abi.encodeWithSelector(RewardsDistributor.NotOperator.selector, address(this), operatorSafe));
        twin.setSigner(carol);
        vm.expectRevert(abi.encodeWithSelector(RewardsDistributor.NotOperator.selector, address(this), operatorSafe));
        twin.recoverExcessAsset(1);

        // The GUARDIAN is rejected on every owner function AND on every operator function.
        vm.startPrank(multisig);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, multisig));
        twin.setAssetClaimsEnabled(true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, multisig));
        twin.setGuardian(multisig);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, multisig));
        twin.setOperator(multisig);
        vm.expectRevert(abi.encodeWithSelector(RewardsDistributor.NotOperator.selector, multisig, operatorSafe));
        twin.setSigner(carol);
        vm.stopPrank();

        // The OPERATOR is rejected on every owner function.
        vm.startPrank(operatorSafe);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operatorSafe));
        twin.setAssetClaimsEnabled(true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operatorSafe));
        twin.setGuardian(operatorSafe);
        vm.stopPrank();

        // Each tier does work from its own address, and the pause takes either of two.
        vm.prank(multisig);
        twin.setPaused(true);
        assertTrue(twin.paused(), "the guardian must be able to pause");
        vm.prank(operatorSafe);
        twin.setPaused(false);
        assertFalse(twin.paused(), "and so must the operator, as the cold fallback");
        vm.prank(operatorSafe);
        twin.setSigner(carol);
        assertEq(twin.signer(), carol, "the operator must be able to rotate the signer");
        twin.setAssetClaimsEnabled(true);
        assertTrue(twin.assetClaimsEnabled(), "the owner must be able to switch the ASSET leg on");
    }

    function test_SetGuardian_RejectsZeroAndAnnouncesBothSides() public {
        vm.expectRevert(RewardsDistributor.ZeroAddress.selector);
        distributor.setGuardian(address(0));

        vm.expectEmit(false, false, false, true, address(distributor));
        emit RewardsDistributor.GuardianSet(address(this), carol);
        distributor.setGuardian(carol);
        assertEq(distributor.guardian(), carol, "the new guardian must be stored");

        // The old guardian loses the tier immediately. This contract is still the OPERATOR
        // here, so the rejection has to be measured from an address that is neither.
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(RewardsDistributor.NotGuardianOrOperator.selector, alice, carol, address(this))
        );
        distributor.setPaused(true);
    }

    /// @dev The operator rotates the same way the guardian does: owner tier, zero rejected,
    ///      both sides announced, and the old holder loses the tier in the same transaction.
    function test_SetOperator_RejectsZeroAndAnnouncesBothSides() public {
        vm.expectRevert(RewardsDistributor.ZeroAddress.selector);
        distributor.setOperator(address(0));

        vm.expectEmit(false, false, false, true, address(distributor));
        emit RewardsDistributor.OperatorSet(address(this), carol);
        distributor.setOperator(carol);
        assertEq(distributor.operator(), carol, "the new operator must be stored");

        // The old operator loses the tier immediately.
        vm.expectRevert(abi.encodeWithSelector(RewardsDistributor.NotOperator.selector, address(this), carol));
        distributor.setSigner(bob);

        // ...and the new one holds it.
        vm.prank(carol);
        distributor.setSigner(bob);
        assertEq(distributor.signer(), bob, "the new operator must be able to rotate the signer");
    }

    /**
     * @dev Renouncing is disabled outright. Under a UUPS proxy an ownerless contract can
     *      never be upgraded again, so the audit note's old "renounce freezes the program"
     *      matrix has been replaced by making the call impossible.
     */
    function test_RenounceOwnership_IsDisabled() public {
        vm.expectRevert(RewardsDistributor.RenounceDisabled.selector);
        distributor.renounceOwnership();

        assertEq(distributor.owner(), address(this), "the owner must be exactly where it was");

        // A stranger still gets the standard Ownable rejection, not the reason.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        distributor.renounceOwnership();
    }

    // ──────────────────────── Upgrades ─────────────────────────

    /**
     * @dev The reason the proxy exists (SEC-04, audit notes §10): the claim ledger must
     *      survive a code change. This upgrades a proxy that has already paid out and checks
     *      that every field is exactly where it was, with new code behind it.
     */
    function test_Upgrade_PreservesTheLedgerAndTheRoles() public {
        _claim(alice, AWARD);
        distributor.setAssetClaimsEnabled(true);

        address v2 = address(new RewardsDistributorV2Mock(address(tokenX), address(asset)));
        distributor.upgradeToAndCall(v2, "");

        assertEq(_implementationOf(address(distributor)), v2, "the ERC-1967 slot must name the new code");
        assertEq(RewardsDistributorV2Mock(address(distributor)).version(), 2, "the new code must be the one running");
        assertEq(distributor.claimedTokenX(alice), AWARD, "the TokenX ledger must survive the upgrade");
        assertEq(distributor.signer(), voucherSigner, "the signer must survive the upgrade");
        assertEq(distributor.guardian(), address(this), "the guardian must survive the upgrade");
        assertEq(distributor.owner(), address(this), "the owner must survive the upgrade");
        assertTrue(distributor.assetClaimsEnabled(), "the ASSET switch must survive the upgrade");

        // And the ledger still governs: the same lifetime voucher pays nothing twice.
        bytes memory sig = _sign(distributor.TOKENX_CLAIM_TYPEHASH(), alice, AWARD, FAR_DEADLINE);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RewardsDistributor.NothingToClaim.selector, AWARD, AWARD));
        distributor.claimTokenX(AWARD, FAR_DEADLINE, sig);
    }

    /// @dev V2 writes its own ERC-7201 namespace, so new state cannot collide with V1's.
    function test_Upgrade_V2StateLivesInItsOwnNamespace() public {
        _claim(alice, AWARD);
        address v2 = address(new RewardsDistributorV2Mock(address(tokenX), address(asset)));
        distributor.upgradeToAndCall(v2, "");

        RewardsDistributorV2Mock upgraded = RewardsDistributorV2Mock(address(distributor));
        upgraded.setUpgradeMarker(42);

        assertEq(upgraded.upgradeMarker(), 42, "V2 state must be readable");
        assertEq(distributor.claimedTokenX(alice), AWARD, "and must not have touched V1's namespace");
        assertEq(distributor.signer(), voucherSigner, "and must not have touched V1's namespace");
    }

    /// @dev Only the owner tier upgrades. Not a stranger, and not the guardian.
    function test_Upgrade_RejectsEveryoneButTheOwner() public {
        RewardsDistributor twin = _guardedTwin();
        address v2 = address(new RewardsDistributorV2Mock(address(tokenX), address(asset)));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        twin.upgradeToAndCall(v2, "");

        vm.prank(multisig);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, multisig));
        twin.upgradeToAndCall(v2, "");

        twin.upgradeToAndCall(v2, "");
        assertEq(_implementationOf(address(twin)), v2, "the owner must be able to upgrade");
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

    /// @dev A second proxy whose owner (this contract), guardian (`multisig`) and operator
    ///      (`operatorSafe`) are THREE DIFFERENT addresses, which the shared harness
    ///      deliberately collapses into one.
    function _guardedTwin() private returns (RewardsDistributor) {
        return
            _deployDistributorProxy(
                address(tokenX), address(asset), address(this), multisig, operatorSafe, voucherSigner
            );
    }

    /// @dev Reads the ERC-1967 implementation slot straight off the proxy.
    function _implementationOf(address proxy) private view returns (address) {
        return address(uint160(uint256(vm.load(proxy, ERC1967Utils.IMPLEMENTATION_SLOT))));
    }

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
