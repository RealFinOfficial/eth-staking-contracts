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
 *         `Ownable2Step` with `renounceOwnership` disabled and TWO further undelayed tiers
 *         beside the owner. A claim of that shape is only worth what its assertions are worth.
 *
 *  The proxies' three tiers, as of the 2026-09-09 role split:
 *
 *    | tier               | vault                                    | distributor                     |
 *    |--------------------|------------------------------------------|---------------------------------|
 *    | owner (timelock)   | upgrade, setZapper, setGuardian, setOperator | upgrade, setAssetClaimsEnabled, setGuardian, setOperator |
 *    | guardian (hot key) | setDepositsPaused, setRebalancePaused    | setPaused                       |
 *    | operator (multisig)| setTwapParams, rescuePosition, both pauses | setSigner, recoverExcessAsset, setPaused |
 *
 *  Two rules follow from it and are asserted in both directions below: the three pause
 *  switches take the guardian OR the operator and reject the owner; everything else on the
 *  operator tier takes the operator alone, so nothing the hot guardian key can call moves
 *  value or installs a key.
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
    ///      not the owner tier, not the operator tier, not even the pause tier.
    function test_Roles_TheVoucherSignerHasNoAdminPowerAnywhere() public {
        vm.startPrank(voucherSigner);
        vm.expectRevert(abi.encodeWithSelector(RewardsDistributor.NotOperator.selector, voucherSigner, address(this)));
        distributor.setSigner(voucherSigner);
        vm.expectRevert(abi.encodeWithSelector(RewardsDistributor.NotOperator.selector, voucherSigner, address(this)));
        distributor.recoverExcessAsset(1);
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardsDistributor.NotGuardianOrOperator.selector, voucherSigner, address(this), address(this)
            )
        );
        distributor.setPaused(true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, voucherSigner));
        distributor.setAssetClaimsEnabled(true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, voucherSigner));
        distributor.setOperator(voucherSigner);
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

    /// @dev The zapper is a stakeFor right, not an admin right — in NONE of the three tiers.
    function test_Roles_TheZapperHasNoAdminPowerOverTheVault() public {
        bytes memory pauseRejection = abi.encodeWithSelector(
            LPStakingVault.NotGuardianOrOperator.selector, address(zapper), address(this), address(this)
        );
        bytes memory operatorRejection =
            abi.encodeWithSelector(LPStakingVault.NotOperator.selector, address(zapper), address(this));

        vm.startPrank(address(zapper));
        vm.expectRevert(pauseRejection);
        vault.setDepositsPaused(true);
        vm.expectRevert(pauseRejection);
        vault.setRebalancePaused(true);
        vm.expectRevert(operatorRejection);
        vault.setTwapParams(600, 100);
        vm.expectRevert(operatorRejection);
        vault.rescuePosition(1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(zapper)));
        vault.setZapper(address(zapper));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(zapper)));
        vault.setGuardian(address(zapper));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(zapper)));
        vault.setOperator(address(zapper));
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
     *      "what a HANDOVER costs the old holder". Three tiers, measured separately: the old
     *      owner loses three calls when ownership is accepted elsewhere, the old guardian
     *      loses the two pause switches when the guardian is rotated, and the old operator
     *      loses four when the operator is rotated.
     */
    function test_Renounce_VaultOwnerLosesThreeAdminCallsOnHandover() public {
        vault.transferOwnership(multisig);
        vm.prank(multisig);
        vault.acceptOwnership();

        _expectUnauthorized(address(vault), abi.encodeCall(LPStakingVault.setZapper, (address(1))));
        _expectUnauthorized(address(vault), abi.encodeCall(LPStakingVault.setGuardian, (carol)));
        _expectUnauthorized(address(vault), abi.encodeCall(LPStakingVault.setOperator, (carol)));

        // The other two tiers are separate slots and are untouched by the ownership move.
        vault.setDepositsPaused(true);
        assertTrue(vault.depositsPaused(), "the pause tier survives an ownership handover");
        vault.setTwapParams(600, 100);
        assertEq(vault.twapWindow(), 600, "the operator tier survives an ownership handover");
    }

    function test_Renounce_VaultGuardianLosesBothPauseSwitchesOnRotation() public {
        // The harness collapses owner, guardian and operator onto this contract, so the loss
        // is only visible on a proxy whose three roles are three addresses.
        LPStakingVault twin = _threeTierVault();

        vm.prank(multisig);
        twin.setDepositsPaused(true);
        assertTrue(twin.depositsPaused(), "precondition: the guardian holds the pause tier");

        twin.setGuardian(carol);

        _expectNotGuardianOrOperator(
            address(twin), abi.encodeCall(LPStakingVault.setDepositsPaused, (false)), multisig, carol, operatorSafe
        );
        _expectNotGuardianOrOperator(
            address(twin), abi.encodeCall(LPStakingVault.setRebalancePaused, (true)), multisig, carol, operatorSafe
        );

        // The owner tier is a separate slot and is untouched by the guardian move.
        twin.setZapper(address(1));
        assertEq(twin.zapper(), address(1), "the owner keeps its tier across a guardian rotation");
    }

    function test_Renounce_VaultOperatorLosesFourAdminCallsOnRotation() public {
        LPStakingVault twin = _threeTierVault();

        vm.prank(operatorSafe);
        twin.setTwapParams(600, 100);
        assertEq(twin.twapWindow(), 600, "precondition: the operator holds the calibration");

        twin.setOperator(carol);

        _expectNotOperator(address(twin), abi.encodeCall(LPStakingVault.setTwapParams, (900, 100)), operatorSafe, carol);
        _expectNotOperator(address(twin), abi.encodeCall(LPStakingVault.rescuePosition, (1)), operatorSafe, carol);
        _expectNotGuardianOrOperator(
            address(twin), abi.encodeCall(LPStakingVault.setDepositsPaused, (true)), operatorSafe, multisig, carol
        );
        _expectNotGuardianOrOperator(
            address(twin), abi.encodeCall(LPStakingVault.setRebalancePaused, (true)), operatorSafe, multisig, carol
        );

        // The guardian tier is a separate slot and is untouched by the operator move.
        vm.prank(multisig);
        twin.setDepositsPaused(true);
        assertTrue(twin.depositsPaused(), "the guardian keeps its tier across an operator rotation");
    }

    function test_Renounce_ZapperLosesThreeAdminCallsAndNothingElse() public {
        zapper.renounceOwnership();

        _expectUnauthorized(address(zapper), abi.encodeCall(LPZapper.setTwapParams, (600, 100)));
        _expectUnauthorized(address(zapper), abi.encodeCall(LPZapper.sweep, (address(usdcToken), 0, carol)));
        _expectUnauthorized(address(zapper), abi.encodeCall(LPZapper.rescuePosition, (1)));
    }

    /**
     * @dev The distributor cannot be renounced at all, so the matrix entry is not "what dies"
     *      but "what a HANDOVER costs the old holder". Three tiers, measured separately: the
     *      old owner loses three calls when ownership is accepted elsewhere, the old guardian
     *      loses `setPaused` when the guardian is rotated, and the old operator loses three
     *      when the operator is rotated.
     */
    function test_Renounce_DistributorOwnerLosesThreeAdminCallsOnHandover() public {
        distributor.transferOwnership(multisig);
        vm.prank(multisig);
        distributor.acceptOwnership();

        _expectUnauthorized(address(distributor), abi.encodeCall(RewardsDistributor.setAssetClaimsEnabled, (true)));
        _expectUnauthorized(address(distributor), abi.encodeCall(RewardsDistributor.setGuardian, (carol)));
        _expectUnauthorized(address(distributor), abi.encodeCall(RewardsDistributor.setOperator, (carol)));

        // The other two tiers are separate slots and are untouched by the ownership move.
        distributor.setPaused(true);
        assertTrue(distributor.paused(), "the pause tier survives an ownership handover");
        distributor.setSigner(carol);
        assertEq(distributor.signer(), carol, "the operator tier survives an ownership handover");
    }

    function test_Renounce_DistributorGuardianLosesThePauseSwitchOnRotation() public {
        RewardsDistributor twin = _threeTierDistributor();

        vm.prank(multisig);
        twin.setPaused(true);
        assertTrue(twin.paused(), "precondition: the guardian holds the pause tier");

        twin.setGuardian(carol);

        _expectNotGuardianOrOperator(
            address(twin), abi.encodeCall(RewardsDistributor.setPaused, (false)), multisig, carol, operatorSafe
        );

        // The owner tier is a separate slot and is untouched by the guardian move.
        twin.setAssetClaimsEnabled(true);
        assertTrue(twin.assetClaimsEnabled(), "the owner keeps its tier across a guardian rotation");
    }

    function test_Renounce_DistributorOperatorLosesThreeAdminCallsOnRotation() public {
        RewardsDistributor twin = _threeTierDistributor();

        vm.prank(operatorSafe);
        twin.setSigner(carol);
        assertEq(twin.signer(), carol, "precondition: the operator holds the signer rotation");

        twin.setOperator(carol);

        _expectNotOperator(address(twin), abi.encodeCall(RewardsDistributor.setSigner, (bob)), operatorSafe, carol);
        _expectNotOperator(
            address(twin), abi.encodeCall(RewardsDistributor.recoverExcessAsset, (1)), operatorSafe, carol
        );
        _expectNotGuardianOrOperator(
            address(twin), abi.encodeCall(RewardsDistributor.setPaused, (true)), operatorSafe, multisig, carol
        );

        // The guardian tier is a separate slot and is untouched by the operator move.
        vm.prank(multisig);
        twin.setPaused(true);
        assertTrue(twin.paused(), "the guardian keeps its tier across an operator rotation");
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
        // holding all three tiers, having accepted the handover.
        RejectingReceiver blackHole = new RejectingReceiver();
        vault.setGuardian(address(blackHole));
        vault.setOperator(address(blackHole));
        vault.transferOwnership(address(blackHole));
        vm.prank(address(blackHole));
        vault.acceptOwnership();

        distributor.setGuardian(address(blackHole));
        distributor.setOperator(address(blackHole));
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

    // ──────────────────────── The three-tier matrix ────────────

    /**
     * @dev Rule one of §1 of the change request, owner side: the timelock has no undelayed
     *      switch at all. It is rejected on both pause switches AND on every operator-tier
     *      call, on both proxies. Measured on twins whose three roles are three addresses.
     */
    function test_Tiers_TheOwnerIsRejectedOnEveryGuardianAndOperatorFunction() public {
        LPStakingVault v = _threeTierVault();
        RewardsDistributor d = _threeTierDistributor();

        assertEq(v.owner(), address(this), "precondition: this contract owns the vault twin");
        assertEq(d.owner(), address(this), "precondition: this contract owns the distributor twin");

        _expectNotGuardianOrOperator(
            address(v), abi.encodeCall(LPStakingVault.setDepositsPaused, (true)), address(this), multisig, operatorSafe
        );
        _expectNotGuardianOrOperator(
            address(v), abi.encodeCall(LPStakingVault.setRebalancePaused, (true)), address(this), multisig, operatorSafe
        );
        _expectNotOperator(
            address(v), abi.encodeCall(LPStakingVault.setTwapParams, (600, 100)), address(this), operatorSafe
        );
        _expectNotOperator(address(v), abi.encodeCall(LPStakingVault.rescuePosition, (1)), address(this), operatorSafe);

        _expectNotGuardianOrOperator(
            address(d), abi.encodeCall(RewardsDistributor.setPaused, (true)), address(this), multisig, operatorSafe
        );
        _expectNotOperator(
            address(d), abi.encodeCall(RewardsDistributor.setSigner, (carol)), address(this), operatorSafe
        );
        _expectNotOperator(
            address(d), abi.encodeCall(RewardsDistributor.recoverExcessAsset, (1)), address(this), operatorSafe
        );
    }

    /**
     * @dev Rule two of §1: the hot guardian key holds the pause switches and NOTHING else.
     *      Nothing it can call moves value or installs a key, which is what makes it safe to
     *      keep hot — so it is rejected on every operator-tier call and on every owner call.
     */
    function test_Tiers_TheGuardianHoldsThePausesAndNothingElse() public {
        LPStakingVault v = _threeTierVault();
        RewardsDistributor d = _threeTierDistributor();

        // What it CAN do: all three pause switches, in one transaction each.
        vm.prank(multisig);
        v.setDepositsPaused(true);
        vm.prank(multisig);
        v.setRebalancePaused(true);
        vm.prank(multisig);
        d.setPaused(true);
        assertTrue(v.depositsPaused() && v.rebalancePaused() && d.paused(), "the guardian must be able to pause");

        // What it CANNOT do: anything on the operator tier...
        _expectNotOperator(address(v), abi.encodeCall(LPStakingVault.setTwapParams, (600, 100)), multisig, operatorSafe);
        _expectNotOperator(address(v), abi.encodeCall(LPStakingVault.rescuePosition, (1)), multisig, operatorSafe);
        _expectNotOperator(address(d), abi.encodeCall(RewardsDistributor.setSigner, (carol)), multisig, operatorSafe);
        _expectNotOperator(
            address(d), abi.encodeCall(RewardsDistributor.recoverExcessAsset, (1)), multisig, operatorSafe
        );

        // ...and nothing on the owner tier.
        vm.startPrank(multisig);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, multisig));
        v.setZapper(address(1));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, multisig));
        v.setGuardian(multisig);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, multisig));
        v.setOperator(multisig);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, multisig));
        d.setAssetClaimsEnabled(true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, multisig));
        d.setOperator(multisig);
        vm.stopPrank();
    }

    /**
     * @dev The operator holds its own calls AND the pause switches — the cold fallback for a
     *      lost guardian key, so a pause is never stuck for the 48 h a guardian rotation
     *      through the timelock takes. It still holds nothing on the owner tier.
     */
    function test_Tiers_TheOperatorHoldsItsOwnCallsAndThePauses() public {
        LPStakingVault v = _threeTierVault();
        RewardsDistributor d = _threeTierDistributor();

        // The pause switches, from the operator rather than from the guardian.
        vm.prank(operatorSafe);
        v.setDepositsPaused(true);
        vm.prank(operatorSafe);
        v.setRebalancePaused(true);
        vm.prank(operatorSafe);
        d.setPaused(true);
        assertTrue(v.depositsPaused() && v.rebalancePaused() && d.paused(), "the operator must be able to pause too");

        // Its own tier: calibration, signer rotation, and the two recovery hatches.
        vm.prank(operatorSafe);
        v.setTwapParams(600, 100);
        assertEq(v.twapWindow(), 600, "the operator must be able to recalibrate the guard");

        uint256 stray = _createPosition(alice, TICK_LOWER, TICK_UPPER, LIQUIDITY);
        vm.prank(alice);
        npmMock.transferFrom(alice, address(v), stray);
        vm.prank(operatorSafe);
        v.rescuePosition(stray);
        assertEq(npmMock.ownerOf(stray), operatorSafe, "the rescue must land on operator(), not on the guardian");

        vm.prank(operatorSafe);
        d.setSigner(carol);
        assertEq(d.signer(), carol, "the operator must be able to rotate the signer");

        asset.transfer(address(d), 1_000e18);
        vm.prank(operatorSafe);
        d.recoverExcessAsset(1_000e18);
        assertEq(asset.balanceOf(operatorSafe), 1_000e18, "the recovery must land on operator()");

        // And nothing on the owner tier.
        vm.startPrank(operatorSafe);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operatorSafe));
        v.setZapper(address(1));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operatorSafe));
        v.setOperator(operatorSafe);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operatorSafe));
        d.setAssetClaimsEnabled(true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operatorSafe));
        d.setGuardian(operatorSafe);
        vm.stopPrank();
    }

    /// @dev A stranger holds no tier at all, and each rejection names the tier it failed.
    function test_Tiers_AStrangerIsRejectedEverywhere() public {
        LPStakingVault v = _threeTierVault();
        RewardsDistributor d = _threeTierDistributor();

        _expectNotGuardianOrOperator(
            address(v), abi.encodeCall(LPStakingVault.setDepositsPaused, (true)), stranger, multisig, operatorSafe
        );
        _expectNotGuardianOrOperator(
            address(v), abi.encodeCall(LPStakingVault.setRebalancePaused, (true)), stranger, multisig, operatorSafe
        );
        _expectNotGuardianOrOperator(
            address(d), abi.encodeCall(RewardsDistributor.setPaused, (true)), stranger, multisig, operatorSafe
        );

        _expectNotOperator(address(v), abi.encodeCall(LPStakingVault.setTwapParams, (600, 100)), stranger, operatorSafe);
        _expectNotOperator(address(v), abi.encodeCall(LPStakingVault.rescuePosition, (1)), stranger, operatorSafe);
        _expectNotOperator(address(d), abi.encodeCall(RewardsDistributor.setSigner, (stranger)), stranger, operatorSafe);
        _expectNotOperator(
            address(d), abi.encodeCall(RewardsDistributor.recoverExcessAsset, (1)), stranger, operatorSafe
        );

        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        v.setGuardian(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        v.setOperator(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        d.setGuardian(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        d.setOperator(stranger);
        vm.stopPrank();
    }

    // ──────────────────────── Helpers ──────────────────────────

    /// @dev A vault proxy whose owner (this contract), guardian ({multisig}) and operator
    ///      ({operatorSafe}) are THREE different addresses, which the shared harness
    ///      deliberately collapses into one.
    function _threeTierVault() private returns (LPStakingVault) {
        return _deployVaultProxy(
            VaultProxyParams({
                positionManager: address(npmMock),
                pool: address(poolMock),
                token0: token0,
                token1: token1,
                fee: FEE,
                swapRouter: address(routerMock),
                owner: address(this),
                guardian: multisig,
                operator: operatorSafe,
                zapper: address(0),
                twapWindow: MIN_TWAP_WINDOW,
                maxDeviationTicks: 500
            })
        );
    }

    /// @dev The distributor's twin of {_threeTierVault}.
    function _threeTierDistributor() private returns (RewardsDistributor) {
        return
            _deployDistributorProxy(
                address(tokenX), address(asset), address(this), multisig, operatorSafe, voucherSigner
            );
    }

    /// @dev Calls `data` on `target` as `caller` and requires the operator rejection, naming
    ///      `expectedOperator` as the address that would have been allowed. Both proxies
    ///      declare `NotOperator(address,address)`, so one selector serves both.
    function _expectNotOperator(address target, bytes memory data, address caller, address expectedOperator) private {
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.NotOperator.selector, caller, expectedOperator));
        (bool ok,) = target.call(data);
        ok; // the cheatcode asserts; the boolean is only here to satisfy the compiler
    }

    /// @dev The same for a pause switch, which names BOTH addresses that would have been
    ///      allowed. Both proxies declare `NotGuardianOrOperator(address,address,address)`.
    function _expectNotGuardianOrOperator(
        address target,
        bytes memory data,
        address caller,
        address expectedGuardian,
        address expectedOperator
    ) private {
        vm.prank(caller);
        vm.expectRevert(
            abi.encodeWithSelector(
                LPStakingVault.NotGuardianOrOperator.selector, caller, expectedGuardian, expectedOperator
            )
        );
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
