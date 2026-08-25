// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LocalHarness} from "../utils/LocalHarness.sol";
import {TokenX} from "../../../contracts/lp-staking/TokenX.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @notice Why this file exists: TokenX's epoch machinery is a two-slot state machine that
 *         rolls over lazily, inside `mint`, and its cap arithmetic deliberately uses a
 *         subtraction with a fallback rather than an addition. Both choices create arms that
 *         only appear at exact boundaries: a cap lowered BELOW what has already been minted,
 *         an activation timestamp equal to now, a pending epoch that is armed and then
 *         overtaken by another.
 *
 *  The minter is this test contract rather than the distributor — harness-local, so the mint
 *  boundaries can be driven directly. Production wires the distributor (`setMinter` in
 *  `scripts/deploy-lp-staking.js`), which the fork tier exercises.
 */
contract TokenXEpochsTest is LocalHarness {
    bytes32 internal constant ERC2612_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    function setUp() public {
        _deployLocalStack();
        tokenX.setMinter(address(this));
    }

    // ──────────────────────── Constructor ──────────────────────

    function test_Constructor_CarriesTheDeployTimeBranding() public view {
        assertEq(tokenX.name(), TOKENX_NAME, "the name is a deploy-time decision and must be stored as given");
        assertEq(tokenX.symbol(), TOKENX_SYMBOL, "the symbol likewise");
        assertEq(tokenX.decimals(), 18, "TokenX is an 18-decimal token");
        assertEq(tokenX.totalSupply(), 0, "nothing may be pre-minted");
    }

    // ──────────────────────── Mint gates ───────────────────────

    function test_Mint_RevertsForAnyoneButTheMinter() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TokenX.NotMinter.selector, alice));
        tokenX.mint(alice, 1);
    }

    /// @dev `amount == 0` is refused before the cap arithmetic runs, with TokenX's own error
    ///      rather than a silent no-op mint.
    function test_Mint_RevertsOnAZeroAmount() public {
        vm.expectRevert(TokenX.ZeroAmount.selector);
        tokenX.mint(alice, 0);
    }

    /// @dev The zero RECIPIENT is caught one layer down, by OpenZeppelin's `_mint`.
    function test_Mint_RevertsOnTheZeroRecipient() public {
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InvalidReceiver.selector, address(0)));
        tokenX.mint(address(0), 1);
    }

    // ──────────────────────── Cap boundary ─────────────────────

    function test_Mint_ExactlyTheRemainingHeadroomIsAllowed() public {
        uint256 cap = tokenX.epochCap(EPOCH_ONE);
        tokenX.mint(alice, cap);

        assertEq(tokenX.mintedInEpoch(EPOCH_ONE), cap, "the tally must reach the cap exactly");
        assertEq(tokenX.balanceOf(alice), cap, "and the whole cap must be mintable");
    }

    function test_Mint_OneWeiPastTheCapReverts() public {
        uint256 cap = tokenX.epochCap(EPOCH_ONE);

        vm.expectRevert(
            abi.encodeWithSelector(TokenX.EpochMintCapExceeded.selector, EPOCH_ONE, cap, uint256(0), cap + 1)
        );
        tokenX.mint(alice, cap + 1);
    }

    function test_Mint_HeadroomShrinksWithEachMint() public {
        uint256 cap = tokenX.epochCap(EPOCH_ONE);
        tokenX.mint(alice, cap - 10);

        vm.expectRevert(
            abi.encodeWithSelector(TokenX.EpochMintCapExceeded.selector, EPOCH_ONE, cap, cap - 10, uint256(11))
        );
        tokenX.mint(alice, 11);

        tokenX.mint(alice, 10);
        assertEq(tokenX.mintedInEpoch(EPOCH_ONE), cap, "the last ten wei of headroom must still be mintable");
    }

    /**
     * @dev The `cap > minted ? cap - minted : 0` fallback. Lowering a cap BELOW what has
     *      already been minted is legal (`setEpochCap` takes any number), and the subtraction
     *      would underflow-panic without the ternary. The contract must produce its own typed
     *      error instead — this is the `: 0` arm.
     */
    function test_Mint_ACapLoweredBelowTheTallyGivesTheTypedErrorNotAPanic() public {
        tokenX.mint(alice, 100e18);
        tokenX.setEpochCap(EPOCH_ONE, 50e18); // below the 100e18 already minted

        vm.expectRevert(
            abi.encodeWithSelector(TokenX.EpochMintCapExceeded.selector, EPOCH_ONE, 50e18, 100e18, uint256(1))
        );
        tokenX.mint(alice, 1);
    }

    /// @dev A cap of exactly the tally is the boundary of that same ternary: `cap > minted`
    ///      is false, so the headroom is zero rather than the difference.
    function test_Mint_ACapEqualToTheTallyLeavesNoHeadroom() public {
        tokenX.mint(alice, 100e18);
        tokenX.setEpochCap(EPOCH_ONE, 100e18);

        vm.expectRevert(
            abi.encodeWithSelector(TokenX.EpochMintCapExceeded.selector, EPOCH_ONE, 100e18, 100e18, uint256(1))
        );
        tokenX.mint(alice, 1);
    }

    /// @dev A zero cap is the default state a deployment starts in, and it blocks every mint.
    function test_Mint_RevertsUnderTheDefaultZeroCap() public {
        tokenX.setEpochCap(7, 0);

        vm.expectRevert(
            abi.encodeWithSelector(TokenX.EpochMintCapExceeded.selector, uint256(7), uint256(0), uint256(0), uint256(1))
        );
        tokenX.mint(alice, 1);
    }

    // ──────────────────────── setEpochCap ──────────────────────

    function test_SetEpochCap_MovesTheCurrentEpochAndEmitsIt() public {
        vm.expectEmit(false, false, false, true, address(tokenX));
        emit TokenX.EpochCapSet(42, 5e18);
        tokenX.setEpochCap(42, 5e18);

        assertEq(tokenX.currentEpochId(), 42, "setEpochCap must switch the current epoch outright");
        assertEq(tokenX.epochCap(42), 5e18, "and store its cap");
        assertEq(tokenX.mintedInEpoch(42), 0, "a new epoch starts with an empty tally");
    }

    /// @dev Each epoch keeps its own tally, so switching back does not reopen headroom.
    function test_SetEpochCap_TalliesAreKeptPerEpoch() public {
        tokenX.mint(alice, 100e18);
        tokenX.setEpochCap(2, 200e18);
        tokenX.mint(alice, 200e18);

        assertEq(tokenX.mintedInEpoch(EPOCH_ONE), 100e18, "epoch 1's tally must be untouched by epoch 2");
        assertEq(tokenX.mintedInEpoch(2), 200e18, "epoch 2 must keep its own tally");

        tokenX.setEpochCap(EPOCH_ONE, tokenX.epochCap(EPOCH_ONE));
        vm.expectRevert();
        tokenX.mint(alice, EPOCH_ONE_CAP);
    }

    // ──────────────────────── armNextEpoch ─────────────────────

    function test_ArmNextEpoch_RejectsATimestampInThePast() public {
        vm.warp(1_000_000);
        uint64 past = uint64(block.timestamp - 1);

        vm.expectRevert(abi.encodeWithSelector(TokenX.ActivationNotInFuture.selector, past, block.timestamp));
        tokenX.armNextEpoch(2, 1e18, past);
    }

    /// @dev The comparison is `<=`, so "now" is already too late.
    function test_ArmNextEpoch_RejectsATimestampEqualToNow() public {
        vm.warp(1_000_000);
        uint64 now_ = uint64(block.timestamp);

        vm.expectRevert(abi.encodeWithSelector(TokenX.ActivationNotInFuture.selector, now_, block.timestamp));
        tokenX.armNextEpoch(2, 1e18, now_);
    }

    function test_ArmNextEpoch_AcceptsTheVeryNextSecond() public {
        vm.warp(1_000_000);
        uint64 soon = uint64(block.timestamp + 1);

        vm.expectEmit(false, false, false, true, address(tokenX));
        emit TokenX.NextEpochArmed(2, 1e18, soon);
        tokenX.armNextEpoch(2, 1e18, soon);

        (uint256 id, uint256 cap, uint64 at) = tokenX.pendingEpoch();
        assertEq(id, 2, "the pending epoch id must be stored");
        assertEq(cap, 1e18, "the pending cap must be stored");
        assertEq(at, soon, "the activation timestamp must be stored");
    }

    /// @dev Arming the epoch that is ALREADY current is not rejected. On activation it resets
    ///      that epoch's cap while its tally survives, which is the only way to raise a live
    ///      epoch's cap on a schedule. Recorded because the name suggests otherwise.
    function test_ArmNextEpoch_AcceptsTheCurrentEpochIdAndRewritesItsCapOnActivation() public {
        vm.warp(1_000_000);
        tokenX.mint(alice, 100e18);

        tokenX.armNextEpoch(EPOCH_ONE, 500e18, uint64(block.timestamp + 3600));
        vm.warp(block.timestamp + 3600);
        tokenX.mint(alice, 1);

        assertEq(tokenX.currentEpochId(), EPOCH_ONE, "the epoch id is unchanged");
        assertEq(tokenX.epochCap(EPOCH_ONE), 500e18, "but its cap has been rewritten by the activation");
        assertEq(tokenX.mintedInEpoch(EPOCH_ONE), 100e18 + 1, "and the tally carried straight through");
    }

    /// @dev `uint64` is wide enough that an activation can be parked effectively forever.
    function test_ArmNextEpoch_AcceptsTheMaximumUint64Timestamp() public {
        tokenX.armNextEpoch(2, 1e18, type(uint64).max);

        (,, uint64 at) = tokenX.pendingEpoch();
        assertEq(at, type(uint64).max, "the widest representable activation must be storable");

        // ...and it never fires, so the live epoch keeps its own cap.
        tokenX.mint(alice, 1);
        assertEq(tokenX.currentEpochId(), EPOCH_ONE, "an epoch parked at uint64 max must never activate");
    }

    /// @dev Arming twice simply replaces the pending epoch; there is no queue.
    function test_ArmNextEpoch_ReplacesAnyEpochAlreadyPending() public {
        vm.warp(1_000_000);
        tokenX.armNextEpoch(2, 1e18, uint64(block.timestamp + 100));
        tokenX.armNextEpoch(3, 2e18, uint64(block.timestamp + 200));

        (uint256 id, uint256 cap, uint64 at) = tokenX.pendingEpoch();
        assertEq(id, 3, "the second arming must overwrite the first");
        assertEq(cap, 2e18, "including its cap");
        assertEq(at, uint64(block.timestamp + 200), "and its activation time");
    }

    function test_ArmNextEpoch_IsOwnerOnly() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        tokenX.armNextEpoch(2, 1e18, uint64(block.timestamp + 100));
    }

    // ──────────────────────── cancelNextEpoch ──────────────────

    function test_CancelNextEpoch_RevertsWithNothingPending() public {
        vm.expectRevert(TokenX.NoPendingEpoch.selector);
        tokenX.cancelNextEpoch();
    }

    function test_CancelNextEpoch_ClearsThePendingEpochAndEchoesIt() public {
        vm.warp(1_000_000);
        uint64 at = uint64(block.timestamp + 100);
        tokenX.armNextEpoch(2, 1e18, at);

        vm.expectEmit(false, false, false, true, address(tokenX));
        emit TokenX.NextEpochCancelled(2, 1e18, at);
        tokenX.cancelNextEpoch();

        (uint256 id, uint256 cap, uint64 storedAt) = tokenX.pendingEpoch();
        assertEq(id, 0, "the pending id must be cleared");
        assertEq(cap, 0, "the pending cap must be cleared");
        assertEq(storedAt, 0, "the pending activation must be cleared");

        vm.expectRevert(TokenX.NoPendingEpoch.selector);
        tokenX.cancelNextEpoch();
    }

    /// @dev Cancelling after the activation time has passed but before any mint rolls it:
    ///      the epoch never activates at all.
    function test_CancelNextEpoch_StillWorksAfterTheActivationTimeHasPassed() public {
        vm.warp(1_000_000);
        tokenX.armNextEpoch(2, 1e18, uint64(block.timestamp + 100));
        vm.warp(block.timestamp + 200);

        tokenX.cancelNextEpoch();
        tokenX.mint(alice, 1);

        assertEq(tokenX.currentEpochId(), EPOCH_ONE, "a cancelled epoch must never activate, even when due");
    }

    // ──────────────────────── Rollover ─────────────────────────

    /// @dev `activatesAt == 0` — the "nothing armed" early return.
    function test_Rollover_DoesNothingWhenNothingIsArmed() public {
        tokenX.mint(alice, 1);
        assertEq(tokenX.currentEpochId(), EPOCH_ONE, "an unarmed token must stay on its current epoch");
    }

    /// @dev `block.timestamp < activatesAt` — the "not yet due" early return.
    function test_Rollover_DoesNothingBeforeTheActivationTime() public {
        vm.warp(1_000_000);
        tokenX.armNextEpoch(2, 5e18, uint64(block.timestamp + 3600));

        tokenX.mint(alice, 1);
        assertEq(tokenX.currentEpochId(), EPOCH_ONE, "a pending epoch must not activate early");
    }

    /// @dev The boundary itself: `block.timestamp >= activatesAt` fires on the exact second.
    function test_Rollover_FiresOnTheExactActivationSecond() public {
        vm.warp(1_000_000);
        uint64 at = uint64(block.timestamp + 3600);
        tokenX.armNextEpoch(2, 5e18, at);
        vm.warp(at);

        vm.expectEmit(false, false, false, true, address(tokenX));
        emit TokenX.EpochActivated(2, 5e18, at, block.timestamp);
        tokenX.mint(alice, 1);

        assertEq(tokenX.currentEpochId(), 2, "the epoch must be current from the activation second");
        assertEq(tokenX.epochCap(2), 5e18, "and carry its armed cap");
        assertEq(tokenX.mintedInEpoch(2), 1, "the mint that triggered the roll must count against the NEW epoch");
    }

    /// @dev Two rollovers in sequence, so the second arming after an activation is exercised
    ///      rather than assumed to behave like the first.
    function test_Rollover_ChainsThroughTwoScheduledEpochs() public {
        vm.warp(1_000_000);

        uint64 firstAt = uint64(block.timestamp + 3600);
        tokenX.armNextEpoch(2, 5e18, firstAt);
        vm.warp(firstAt);
        tokenX.mint(alice, 1e18);
        assertEq(tokenX.currentEpochId(), 2, "the first scheduled epoch must activate");

        uint64 secondAt = uint64(block.timestamp + 3600);
        tokenX.armNextEpoch(3, 9e18, secondAt);
        vm.warp(secondAt);
        tokenX.mint(alice, 2e18);

        assertEq(tokenX.currentEpochId(), 3, "the second scheduled epoch must activate too");
        assertEq(tokenX.mintedInEpoch(2), 1e18, "epoch 2 keeps the tally it accrued");
        assertEq(tokenX.mintedInEpoch(3), 2e18, "epoch 3 starts its own");
        (,, uint64 pendingAt) = tokenX.pendingEpoch();
        assertEq(pendingAt, 0, "no epoch may stay pending after activation");
    }

    /// @dev `effectiveEpoch` is the view a backend reads BEFORE minting, so it must show the
    ///      pending epoch as soon as it is due — before any mint has rolled it.
    function test_EffectiveEpoch_PreviewsTheDueEpochBeforeAnyMintRollsIt() public {
        vm.warp(1_000_000);
        uint64 at = uint64(block.timestamp + 3600);
        tokenX.armNextEpoch(2, 5e18, at);

        (uint256 idBefore, uint256 capBefore) = tokenX.effectiveEpoch();
        assertEq(idBefore, EPOCH_ONE, "before the activation time the current epoch is effective");
        assertEq(capBefore, EPOCH_ONE_CAP, "with its own cap");

        vm.warp(at);
        (uint256 idAfter, uint256 capAfter) = tokenX.effectiveEpoch();
        assertEq(idAfter, 2, "once due, the pending epoch is the effective one");
        assertEq(capAfter, 5e18, "with the armed cap");
        assertEq(tokenX.currentEpochId(), EPOCH_ONE, "even though storage has not rolled yet");
    }

    // ──────────────────────── ERC-20 surface ───────────────────

    function test_Burn_ReducesTheSupplyButNotTheEpochTally() public {
        tokenX.mint(alice, 100e18);

        vm.prank(alice);
        tokenX.burn(40e18);

        assertEq(tokenX.totalSupply(), 60e18, "burning must reduce the supply");
        assertEq(tokenX.mintedInEpoch(EPOCH_ONE), 100e18, "but must NOT give the epoch its headroom back");
    }

    function test_Burn_RevertsBeyondTheBalance() public {
        tokenX.mint(alice, 10e18);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice, 10e18, 10e18 + 1));
        tokenX.burn(10e18 + 1);
    }

    function test_BurnFrom_SpendsTheAllowance() public {
        tokenX.mint(alice, 100e18);
        vm.prank(alice);
        tokenX.approve(bob, 40e18);

        vm.prank(bob);
        tokenX.burnFrom(alice, 40e18);

        assertEq(tokenX.balanceOf(alice), 60e18, "the burn must come out of the owner's balance");
        assertEq(tokenX.allowance(alice, bob), 0, "and consume the allowance");
    }

    function test_Permit_RejectsAMalleableHighSSignature() public {
        bytes32 digest = _tokenXPermitDigest(alice, bob, 1e18, FAR_DEADLINE);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(alicePk, digest);
        bytes32 flippedS = bytes32(SECP256K1_N - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;

        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureS.selector, flippedS));
        tokenX.permit(alice, bob, 1e18, FAR_DEADLINE, flippedV, r, flippedS);
    }

    function test_Permit_RejectsAnImpossibleV() public {
        bytes32 digest = _tokenXPermitDigest(alice, bob, 1e18, FAR_DEADLINE);
        (, bytes32 r, bytes32 s) = vm.sign(alicePk, digest);

        vm.expectRevert(ECDSA.ECDSAInvalidSignature.selector);
        tokenX.permit(alice, bob, 1e18, FAR_DEADLINE, 29, r, s);
    }

    function test_Permit_AcceptsAWellFormedSignatureAndMovesTheNonce() public {
        bytes32 digest = _tokenXPermitDigest(alice, bob, 1e18, FAR_DEADLINE);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(alicePk, digest);

        tokenX.permit(alice, bob, 1e18, FAR_DEADLINE, v, r, s);

        assertEq(tokenX.allowance(alice, bob), 1e18, "the permit must set the allowance");
        assertEq(tokenX.nonces(alice), 1, "and consume the nonce so it cannot be replayed");
    }

    // ──────────────────────── Owner surface ────────────────────

    function test_SetMinter_AnnouncesBothSidesAndTakesEffectAtOnce() public {
        vm.expectEmit(false, false, false, true, address(tokenX));
        emit TokenX.MinterChanged(address(this), carol);
        tokenX.setMinter(carol);

        vm.expectRevert(abi.encodeWithSelector(TokenX.NotMinter.selector, address(this)));
        tokenX.mint(alice, 1);

        vm.prank(carol);
        tokenX.mint(alice, 1);
        assertEq(tokenX.balanceOf(alice), 1, "the new minter must be able to mint immediately");
    }

    /// @dev The zero address is accepted, and that is the only way to stop minting entirely.
    function test_SetMinter_AcceptsZeroToDisableMintingCompletely() public {
        tokenX.setMinter(address(0));

        vm.expectRevert(abi.encodeWithSelector(TokenX.NotMinter.selector, address(this)));
        tokenX.mint(alice, 1);
    }

    /**
     * @dev Renouncing freezes the epoch schedule but NOT the mint: whoever is the minter at
     *      that moment keeps minting up to the current epoch's cap, forever, and no one can
     *      ever arm another epoch, change the cap, or replace them.
     */
    function test_RenounceOwnership_FreezesTheScheduleButNotTheStandingMinter() public {
        tokenX.renounceOwnership();

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        tokenX.setEpochCap(2, 1e18);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        tokenX.setMinter(carol);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        tokenX.armNextEpoch(2, 1e18, uint64(block.timestamp + 1));

        tokenX.mint(alice, 1e18);
        assertEq(tokenX.balanceOf(alice), 1e18, "the standing minter keeps its right after a renounce");
    }

    // ──────────────────────── Helpers ──────────────────────────

    function _tokenXPermitDigest(address owner_, address spender, uint256 value, uint256 deadline)
        private
        view
        returns (bytes32)
    {
        bytes32 structHash =
            keccak256(abi.encode(ERC2612_TYPEHASH, owner_, spender, value, tokenX.nonces(owner_), deadline));
        return keccak256(abi.encodePacked("\x19\x01", tokenX.DOMAIN_SEPARATOR(), structHash));
    }
}
