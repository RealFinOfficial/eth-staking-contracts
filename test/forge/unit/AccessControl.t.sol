// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LocalHarness} from "../utils/LocalHarness.sol";
import {LPStakingVault} from "../../../contracts/lp-staking/LPStakingVault.sol";
import {LPZapper} from "../../../contracts/lp-staking/LPZapper.sol";
import {RewardsDistributor} from "../../../contracts/lp-staking/RewardsDistributor.sol";
import {TokenX} from "../../../contracts/lp-staking/TokenX.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {RejectingReceiver} from "../utils/attackers/Receivers.sol";

/**
 * @notice Why this file exists: `docs/lp-staking-audit-notes.md` §3 states what each
 *         contract's ownership can and cannot do to it — and since the 2026-08-26 revision
 *         the stack has TWO shapes of that claim. `TokenX` and `LPZapper` keep one-step
 *         `Ownable` with a live `renounceOwnership`, where a wrong address bricks every admin
 *         path permanently. The two proxies (`LPStakingVault`, `RewardsDistributor`) are
 *         `Ownable2Step` with `renounceOwnership` disabled and a second, undelayed `guardian`
 *         tier beside the owner. A claim of that shape is only worth what its assertions are
 *         worth.
 *
 *  The matrix is stated per contract: what DIES with the owner, and — the half that matters
 *  to a staker — what SURVIVES. The design promise is that exits are unconditional, so a
 *  stack whose owners are all gone or unreachable must still let every user out with their
 *  position and their rewards.
 */
contract AccessControlTest is LocalHarness {
    uint256 internal constant AWARD = 1_000e18;

    function setUp() public {
        _deployLocalStack();
    }

    // ──────────────────────── Ownership mechanics ──────────────

    function test_Ownership_AllFourAreOwnedByTheDeployerBeforeHandover() public view {
        assertEq(vault.owner(), address(this), "the vault starts under the deployer");
        assertEq(zapper.owner(), address(this), "the zapper starts under the deployer");
        assertEq(distributor.owner(), address(this), "the distributor starts under the deployer");
        assertEq(tokenX.owner(), address(this), "TokenX starts under the deployer");
    }

    /**
     * @dev Two shapes in one stack. The two PROXIES are `Ownable2Step`: a transfer only
     *      nominates, and the nominee has to accept before it can do anything. `TokenX` and
     *      `LPZapper` stay plain `Ownable`, where the new owner is in force immediately.
     */
    function test_Ownership_TransferRequiresAcceptanceForTheProxies() public {
        vault.transferOwnership(multisig);

        assertEq(vault.owner(), address(this), "a nomination must not move the vault's owner");
        assertEq(vault.pendingOwner(), multisig, "the nominee must be recorded");

        // The nominee is still not the owner until it says so.
        vm.prank(multisig);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, multisig));
        vault.setZapper(address(1));

        vm.prank(multisig);
        vault.acceptOwnership();

        assertEq(vault.owner(), multisig, "accepting is what moves the owner");
        assertEq(vault.pendingOwner(), address(0), "and it clears the nomination");
        vm.prank(multisig);
        vault.setZapper(address(1));
        assertEq(vault.zapper(), address(1), "the new owner can act");

        // ...and the plain half of the stack has no such step.
        zapper.transferOwnership(multisig);
        assertEq(zapper.owner(), multisig, "the zapper's new owner is in force at once");
        tokenX.transferOwnership(multisig);
        assertEq(tokenX.owner(), multisig, "and so is TokenX's");
    }

    /**
     * @dev `Ownable2Step` does not reject the zero address the way plain `Ownable` does, and
     *      it does not have to: on a proxy a zero transfer is a CANCELLATION — it clears the
     *      standing nomination and leaves the owner exactly where it is. Plain `Ownable`
     *      still reverts, because there the same call would take effect immediately.
     */
    function test_Ownership_TransferToZeroClearsThePendingOwnerOnTheProxies() public {
        vault.transferOwnership(multisig);
        distributor.transferOwnership(multisig);
        assertEq(vault.pendingOwner(), multisig, "precondition: the vault has a nomination");
        assertEq(distributor.pendingOwner(), multisig, "precondition: the distributor has one too");

        vault.transferOwnership(address(0));
        assertEq(vault.pendingOwner(), address(0), "a zero transfer clears the nomination");
        assertEq(vault.owner(), address(this), "and leaves the owner untouched");

        distributor.transferOwnership(address(0));
        assertEq(distributor.pendingOwner(), address(0), "the distributor behaves the same way");
        assertEq(distributor.owner(), address(this), "and keeps its owner too");

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        tokenX.transferOwnership(address(0));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        zapper.transferOwnership(address(0));
    }

    /**
     * @dev The audit note's "a wrong address bricks every admin path permanently" now holds
     *      only for the plain contracts. On a proxy a mistyped nominee never becomes the
     *      owner unless it accepts, so the mistake is undone by nominating again — which is
     *      the whole reason the two-step handshake is there.
     */
    function test_Ownership_AnUnacceptedTransferIsRecoverable() public {
        RejectingReceiver blackHole = new RejectingReceiver();

        vault.transferOwnership(address(blackHole));
        assertEq(vault.owner(), address(this), "the vault's owner has not moved");

        vault.setZapper(address(1)); // the old owner still acts
        vault.transferOwnership(multisig); // and can re-nominate
        assertEq(vault.pendingOwner(), multisig, "the mistake is undone by nominating again");

        // The zapper has no such step, so the same mistake there is terminal.
        zapper.transferOwnership(address(blackHole));

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        zapper.transferOwnership(address(this));

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        zapper.setTwapParams(600, 100);

        assertEq(zapper.owner(), address(blackHole), "and the owner stays where it was mistyped to");
    }

    /// @dev The four owners are independent slots; moving one must not move any other.
    function test_Ownership_EachContractIsOwnedIndependently() public {
        vault.transferOwnership(multisig);
        vm.prank(multisig);
        vault.acceptOwnership();

        assertEq(vault.owner(), multisig, "only the vault's owner moved");
        assertEq(zapper.owner(), address(this), "the zapper's owner is untouched");
        assertEq(distributor.owner(), address(this), "the distributor's owner is untouched");
        assertEq(tokenX.owner(), address(this), "TokenX's owner is untouched");
    }

    function test_Ownership_RenouncingOneLeavesTheOtherThreeIntact() public {
        zapper.renounceOwnership();

        assertEq(zapper.owner(), address(0), "the zapper is ownerless");
        assertEq(vault.owner(), address(this), "the vault still has its owner");
        assertEq(distributor.owner(), address(this), "the distributor still has its owner");
        assertEq(tokenX.owner(), address(this), "TokenX still has its owner");

        vault.setTwapParams(600, 100);
        distributor.setPaused(true);
        tokenX.setEpochCap(2, 1e18);
    }

    /**
     * @dev The two proxies are the exception to the matrix above: renouncing would leave
     *      `_authorizeUpgrade` with no caller and freeze the implementation forever, so the
     *      call is disabled outright rather than merely discouraged in a runbook.
     */
    function test_Ownership_TheProxiesCannotBeRenounced() public {
        vm.expectRevert(LPStakingVault.RenounceDisabled.selector);
        vault.renounceOwnership();
        assertEq(vault.owner(), address(this), "the vault keeps its owner");

        vm.expectRevert(RewardsDistributor.RenounceDisabled.selector);
        distributor.renounceOwnership();
        assertEq(distributor.owner(), address(this), "the distributor keeps its owner");

        // The plain half can still be renounced, which is what makes this a real difference.
        zapper.renounceOwnership();
        tokenX.renounceOwnership();
        assertEq(zapper.owner(), address(0), "the zapper can still be renounced");
        assertEq(tokenX.owner(), address(0), "and so can TokenX");
    }

    /// @dev The distributor's handover is two-step in the same way the vault's is.
    function test_Ownership_TheDistributorHandoverNeedsAcceptance() public {
        distributor.transferOwnership(multisig);

        assertEq(distributor.owner(), address(this), "a nomination must not move the owner");
        assertEq(distributor.pendingOwner(), multisig, "the nominee must be recorded");

        // The nominee is still not the owner until it says so.
        vm.prank(multisig);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, multisig));
        distributor.setAssetClaimsEnabled(true);

        vm.prank(multisig);
        distributor.acceptOwnership();

        assertEq(distributor.owner(), multisig, "accepting is what moves the owner");
        assertEq(distributor.pendingOwner(), address(0), "and it clears the nomination");
        vm.prank(multisig);
        distributor.setAssetClaimsEnabled(true);
        assertTrue(distributor.assetClaimsEnabled(), "the new owner can act");
    }

    // ──────────────────────── Non-owner roles ──────────────────

    /// @dev The voucher signer is a signing key, not an admin. It holds nothing on-chain —
    ///      neither the owner tier nor the guardian tier.
    function test_Roles_TheVoucherSignerHasNoAdminPowerAnywhere() public {
        vm.startPrank(voucherSigner);
        vm.expectRevert(abi.encodeWithSelector(RewardsDistributor.NotGuardian.selector, voucherSigner, address(this)));
        distributor.setSigner(voucherSigner);
        vm.expectRevert(abi.encodeWithSelector(RewardsDistributor.NotGuardian.selector, voucherSigner, address(this)));
        distributor.setPaused(true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, voucherSigner));
        distributor.setAssetClaimsEnabled(true);
        vm.expectRevert(abi.encodeWithSelector(TokenX.NotMinter.selector, voucherSigner));
        tokenX.mint(voucherSigner, 1);
        vm.stopPrank();
    }

    /// @dev The minter is a mint right, not an admin right.
    function test_Roles_TheMinterHasNoAdminPowerOverTokenX() public {
        vm.startPrank(address(distributor));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(distributor)));
        tokenX.setEpochCap(2, 1e18);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(distributor)));
        tokenX.setMinter(address(distributor));
        vm.stopPrank();
    }

    /// @dev The zapper is a stakeFor right, not an admin right — in NEITHER tier.
    function test_Roles_TheZapperHasNoAdminPowerOverTheVault() public {
        vm.startPrank(address(zapper));
        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.NotGuardian.selector, address(zapper), address(this)));
        vault.setDepositsPaused(true);
        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.NotGuardian.selector, address(zapper), address(this)));
        vault.setRebalancePaused(true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(zapper)));
        vault.setZapper(address(zapper));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(zapper)));
        vault.setGuardian(address(zapper));
        vm.stopPrank();
    }

    /// @dev And the owner is not the zapper: the whitelist is an address, not a permission
    ///      level, so even the multisig cannot call `stakeFor`.
    function test_Roles_TheOwnerCannotCallStakeForWithoutBeingTheZapper() public {
        uint256 tokenId = _createPosition(address(this), TICK_LOWER, TICK_UPPER, LIQUIDITY);
        npmMock.approve(address(vault), tokenId);

        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.NotZapper.selector, address(this), address(zapper)));
        vault.stakeFor(alice, tokenId);
    }

    // ──────────────────────── Renounce matrix ──────────────────

    /**
     * @dev The vault cannot be renounced at all, so its matrix entry is not "what dies" but
     *      "what a HANDOVER costs the old holder". Two tiers, measured separately: the old
     *      owner loses three calls when ownership is accepted elsewhere, and the old guardian
     *      loses three when the guardian is rotated.
     */
    function test_Renounce_VaultOwnerLosesThreeAdminCallsOnHandover() public {
        vault.transferOwnership(multisig);
        vm.prank(multisig);
        vault.acceptOwnership();

        _expectUnauthorized(address(vault), abi.encodeCall(LPStakingVault.setZapper, (address(1))));
        _expectUnauthorized(address(vault), abi.encodeCall(LPStakingVault.setTwapParams, (600, 100)));
        _expectUnauthorized(address(vault), abi.encodeCall(LPStakingVault.setGuardian, (carol)));

        // The guardian tier is a separate slot and is untouched by the ownership move.
        vault.setDepositsPaused(true);
        assertTrue(vault.depositsPaused(), "the guardian keeps its tier across an ownership handover");
    }

    function test_Renounce_VaultGuardianLosesThreeAdminCallsOnRotation() public {
        vault.setGuardian(carol);

        _expectNotGuardian(address(vault), abi.encodeCall(LPStakingVault.setDepositsPaused, (true)), carol);
        _expectNotGuardian(address(vault), abi.encodeCall(LPStakingVault.setRebalancePaused, (true)), carol);
        _expectNotGuardian(address(vault), abi.encodeCall(LPStakingVault.rescuePosition, (1)), carol);

        // The owner tier is a separate slot and is untouched by the guardian move.
        vault.setZapper(address(1));
        assertEq(vault.zapper(), address(1), "the owner keeps its tier across a guardian rotation");
    }

    function test_Renounce_ZapperLosesThreeAdminCallsAndNothingElse() public {
        zapper.renounceOwnership();

        _expectUnauthorized(address(zapper), abi.encodeCall(LPZapper.setTwapParams, (600, 100)));
        _expectUnauthorized(address(zapper), abi.encodeCall(LPZapper.sweep, (address(usdcToken), 0, carol)));
        _expectUnauthorized(address(zapper), abi.encodeCall(LPZapper.rescuePosition, (1)));
    }

    /**
     * @dev The distributor cannot be renounced at all, so the matrix entry is not "what dies"
     *      but "what a HANDOVER costs the old holder". Two tiers, measured separately: the
     *      old owner loses two calls when ownership is accepted elsewhere, and the old
     *      guardian loses three when the guardian is rotated.
     */
    function test_Renounce_DistributorOwnerLosesTwoAdminCallsOnHandover() public {
        distributor.transferOwnership(multisig);
        vm.prank(multisig);
        distributor.acceptOwnership();

        _expectUnauthorized(address(distributor), abi.encodeCall(RewardsDistributor.setAssetClaimsEnabled, (true)));
        _expectUnauthorized(address(distributor), abi.encodeCall(RewardsDistributor.setGuardian, (carol)));

        // The guardian tier is a separate slot and is untouched by the ownership move.
        distributor.setPaused(true);
        assertTrue(distributor.paused(), "the guardian keeps its tier across an ownership handover");
    }

    function test_Renounce_DistributorGuardianLosesThreeAdminCallsOnRotation() public {
        distributor.setGuardian(carol);

        _expectNotGuardian(address(distributor), abi.encodeCall(RewardsDistributor.setSigner, (carol)), carol);
        _expectNotGuardian(address(distributor), abi.encodeCall(RewardsDistributor.setPaused, (true)), carol);
        _expectNotGuardian(address(distributor), abi.encodeCall(RewardsDistributor.recoverExcessAsset, (1)), carol);

        // The owner tier is a separate slot and is untouched by the guardian move.
        distributor.setAssetClaimsEnabled(true);
        assertTrue(distributor.assetClaimsEnabled(), "the owner keeps its tier across a guardian rotation");
    }

    function test_Renounce_TokenXLosesFourAdminCalls() public {
        tokenX.renounceOwnership();

        _expectUnauthorized(address(tokenX), abi.encodeCall(TokenX.setMinter, (carol)));
        _expectUnauthorized(address(tokenX), abi.encodeCall(TokenX.setEpochCap, (2, 1e18)));
        _expectUnauthorized(
            address(tokenX), abi.encodeCall(TokenX.armNextEpoch, (2, 1e18, uint64(block.timestamp + 1)))
        );
        _expectUnauthorized(address(tokenX), abi.encodeCall(TokenX.cancelNextEpoch, ()));
    }

    /**
     * @dev The load-bearing half of the matrix: with every owner gone, every user
     *      path still works. Staking, zapping, re-ranging, exiting and claiming are gated by
     *      the staker record, the zapper whitelist and the voucher signature — never by the
     *      owner. This is what makes "exits are unconditional" a measured property.
     */
    function test_Renounce_AFullyOwnerlessStackStillServesEveryUserPath() public {
        uint256 aliceToken = _stakePosition(alice);

        zapper.renounceOwnership();
        tokenX.renounceOwnership();
        // Neither proxy can be renounced (see {test_Ownership_TheProxiesCannotBeRenounced}),
        // so the closest equivalent is a set of roles that will never act again: a black hole
        // holding both tiers, having accepted the handover.
        RejectingReceiver blackHole = new RejectingReceiver();
        vault.setGuardian(address(blackHole));
        vault.transferOwnership(address(blackHole));
        vm.prank(address(blackHole));
        vault.acceptOwnership();

        distributor.setGuardian(address(blackHole));
        distributor.transferOwnership(address(blackHole));
        vm.prank(address(blackHole));
        distributor.acceptOwnership();

        // A brand-new deposit still works.
        uint256 bobToken = _stakePosition(bob);
        assertEq(vault.stakerOf(bobToken), bob, "staking must survive a fully ownerless stack");

        // Zapping still works.
        vm.startPrank(carol);
        usdcToken.approve(address(zapper), 1_000e6);
        uint256 carolToken = zapper.zapIn(1_000e6, TICK_LOWER, TICK_UPPER, _noSwap(), FAR_DEADLINE);
        vm.stopPrank();
        assertEq(vault.stakerOf(carolToken), carol, "zapping must survive a fully ownerless stack");

        // Re-ranging still works.
        vm.prank(alice);
        uint256 rebalanced = vault.rebalance(aliceToken, NEW_TICK_LOWER, NEW_TICK_UPPER, _noSwap(), FAR_DEADLINE);
        assertEq(vault.stakerOf(rebalanced), alice, "re-ranging must survive a fully ownerless stack");

        // Exiting still works.
        vm.prank(alice);
        vault.unstake(rebalanced);
        assertEq(npmMock.ownerOf(rebalanced), alice, "exiting must survive a fully ownerless stack");

        // And claiming still works, because the signer is fixed, not administered.
        bytes memory sig = _signVoucher(voucherSignerPk, distributor.TOKENX_CLAIM_TYPEHASH(), bob, AWARD, FAR_DEADLINE);
        vm.prank(bob);
        assertEq(
            distributor.claimTokenX(AWARD, FAR_DEADLINE, sig), AWARD, "claiming must survive a fully ownerless stack"
        );
    }

    /// @dev The one thing a renounced stack can never do again: raise the epoch cap. Once the
    ///      standing epoch is exhausted, the TokenX leg stops permanently.
    function test_Renounce_TheTokenXLegEndsWhenTheStandingEpochIsExhausted() public {
        tokenX.setEpochCap(EPOCH_ONE, AWARD);
        tokenX.renounceOwnership();

        bytes memory sig =
            _signVoucher(voucherSignerPk, distributor.TOKENX_CLAIM_TYPEHASH(), alice, AWARD, FAR_DEADLINE);
        vm.prank(alice);
        distributor.claimTokenX(AWARD, FAR_DEADLINE, sig);

        bytes memory bobSig = _signVoucher(voucherSignerPk, distributor.TOKENX_CLAIM_TYPEHASH(), bob, 1, FAR_DEADLINE);
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(TokenX.EpochMintCapExceeded.selector, EPOCH_ONE, AWARD, AWARD, uint256(1))
        );
        distributor.claimTokenX(1, FAR_DEADLINE, bobSig);

        _expectUnauthorized(address(tokenX), abi.encodeCall(TokenX.setEpochCap, (EPOCH_ONE, AWARD * 2)));
    }

    // ──────────────────────── Helpers ──────────────────────────

    /// @dev Calls `data` on `target` from this contract and requires the guardian rejection,
    ///      naming `expectedGuardian` as the address that would have been allowed. Both
    ///      proxies declare `NotGuardian(address,address)`, so one selector serves both.
    function _expectNotGuardian(address target, bytes memory data, address expectedGuardian) private {
        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.NotGuardian.selector, address(this), expectedGuardian));
        (bool ok,) = target.call(data);
        ok; // the cheatcode asserts; the boolean is only here to satisfy the compiler
    }

    /// @dev Calls `data` on `target` from this contract and requires the Ownable rejection.
    function _expectUnauthorized(address target, bytes memory data) private {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        (bool ok,) = target.call(data);
        ok; // the cheatcode asserts; the boolean is only here to satisfy the compiler
    }
}
