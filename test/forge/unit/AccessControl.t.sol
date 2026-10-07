// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LocalHarness} from "../utils/LocalHarness.sol";
import {LPStakingVault} from "../../../contracts/lp-staking/LPStakingVault.sol";
import {LPZapper} from "../../../contracts/lp-staking/LPZapper.sol";
import {RewardsDistributor} from "../../../contracts/lp-staking/RewardsDistributor.sol";
import {LPEpochRegistry} from "../../../contracts/lp-staking/LPEpochRegistry.sol";
import {TokenOverture} from "../../../contracts/lp-staking/TokenOverture.sol";
import {IRewardsDistributor} from "../../../contracts/lp-staking/interfaces/IRewardsDistributor.sol";
import {ILPEpochRegistry} from "../../../contracts/lp-staking/interfaces/ILPEpochRegistry.sol";
import {MockBonusEscrow} from "../../../contracts/lp-staking/mocks/MockBonusEscrow.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {RejectingReceiver} from "../utils/attackers/Receivers.sol";

/**
 * @notice Why this file exists: `docs/lp-staking-audit-notes.md` §3 states what each
 *         contract's ownership can and cannot do to it, and all FIVE LP contracts — the vault,
 *         the distributor, the epoch registry, the Overture token and the zapper, every one a
 *         UUPS proxy owned by the timelock — state the same thing: ownership is
 *         `Ownable2Step` (a transfer only nominates, and the nominee has to accept before it
 *         holds anything) and `renounceOwnership` reverts `RenounceDisabled`. Beside the owner,
 *         each contract carries the undelayed tiers listed below. A claim of that shape is only
 *         worth what its assertions are worth.
 *
 *    | contract     | owner (timelock, delayed)                                         | operator (multisig, immediate)                     | guardian (hot key)                    | other            |
 *    |--------------|-------------------------------------------------------------------|----------------------------------------------------|---------------------------------------|------------------|
 *    | vault        | upgrade, setZapper, setBonusEscrow, setGuardian, setOperator      | setTwapParams, rescuePosition, setGuardian, pauses | setDepositsPaused, setRebalancePaused | —                |
 *    | distributor  | upgrade, initializeV2 (once), addRewardToken, setRewardTokenEnabled, setClaimsEnabled, setGuardian, setOperator | setSigner, recoverExcess, mintRewardToken (never $ASSET), setGuardian, setPaused | setPaused | signer (vouchers); asset() public |
 *    | registry     | upgrade, setOperator                                              | scheduleEpoch, setEpochAmount, updateEpochBounds, cancelEpoch | —                         | —                |
 *    | Overture     | upgrade, setMinter                                                | —                                                  | —                                     | minter (the distributor proxy): mint |
 *    | zapper       | upgrade, setOperator                                              | setTwapParams, sweep, rescuePosition               | —                                     | —                |
 *
 *  Rules asserted in both directions below. First, every pause switch takes the guardian OR
 *  the operator and rejects the owner: the timelock holds no undelayed switch. Second,
 *  everything else on an operator tier takes the operator alone, so nothing the hot guardian
 *  key can call moves value or installs a key. Third, `setGuardian` takes the owner OR the
 *  operator: an undelayed hot key must be revocable without the timelock's delay. Fourth,
 *  `setOperator` (and `setMinter`) stay owner-only, so no undelayed tier rotates itself. Fifth,
 *  the Overture token's minter is the distributor PROXY, and the only road to it is the
 *  distributor operator's `mintRewardToken`, which refuses $ASSET by address for every caller.
 *
 *  The matrix is stated per contract: what DIES with the owner, and — the half that matters to
 *  a staker — what SURVIVES. The design promise is that exits are unconditional, so a stack
 *  whose admins are all gone or unreachable must still let every user out with their position
 *  and their funded rewards.
 */
contract AccessControlTest is LocalHarness {
    uint256 internal constant AWARD = 1_000e18;

    function setUp() public {
        _deployLocalStack();
    }

    // ──────────────────────── Ownership mechanics ──────────────

    function test_Ownership_AllFiveAreOwnedByTheDeployerBeforeHandover() public view {
        assertEq(vault.owner(), address(this), "the vault starts under the deployer");
        assertEq(zapper.owner(), address(this), "the zapper starts under the deployer");
        assertEq(distributor.owner(), address(this), "the distributor starts under the deployer");
        assertEq(registry.owner(), address(this), "the registry starts under the deployer");
        assertEq(overture.owner(), address(this), "the Overture token starts under the deployer");
    }

    /**
     * @dev One shape across the whole stack: a transfer only NOMINATES on all five contracts.
     *      The owner does not move, the nominee is recorded, and until it accepts it holds
     *      nothing — asserted here on an owner-tier call each contract really has.
     */
    function test_Ownership_TransferOnlyNominatesOnAllFiveContracts() public {
        _nominateAll(multisig);

        assertEq(vault.owner(), address(this), "a nomination must not move the vault's owner");
        assertEq(distributor.owner(), address(this), "nor the distributor's");
        assertEq(registry.owner(), address(this), "nor the registry's");
        assertEq(overture.owner(), address(this), "nor the Overture token's");
        assertEq(zapper.owner(), address(this), "nor the zapper's");

        assertEq(vault.pendingOwner(), multisig, "the vault records its nominee");
        assertEq(distributor.pendingOwner(), multisig, "so does the distributor");
        assertEq(registry.pendingOwner(), multisig, "so does the registry");
        assertEq(overture.pendingOwner(), multisig, "so does the Overture token");
        assertEq(zapper.pendingOwner(), multisig, "and so does the zapper");

        // The nominee is not the owner until it says so, on any of the five.
        vm.startPrank(multisig);
        bytes memory rejection = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, multisig);
        vm.expectRevert(rejection);
        vault.setZapper(address(1));
        vm.expectRevert(rejection);
        distributor.setClaimsEnabled(address(asset), true);
        vm.expectRevert(rejection);
        registry.setOperator(multisig);
        vm.expectRevert(rejection);
        overture.setMinter(multisig);
        vm.expectRevert(rejection);
        zapper.setOperator(multisig);
        vm.stopPrank();

        // ...and the standing owner still holds every one of them.
        vault.setZapper(address(1));
        distributor.setClaimsEnabled(address(asset), true);
        registry.setOperator(operatorSafe);
        overture.setMinter(operatorSafe);
        zapper.setOperator(operatorSafe);
    }

    /// @dev The second half of the handshake, on all five: accepting is what moves the owner,
    ///      it clears the nomination, and the new owner can act at once.
    function test_Ownership_AcceptanceIsWhatMovesTheOwnerOnAllFive() public {
        _nominateAll(multisig);

        vm.startPrank(multisig);
        vault.acceptOwnership();
        distributor.acceptOwnership();
        registry.acceptOwnership();
        overture.acceptOwnership();
        zapper.acceptOwnership();

        assertEq(vault.owner(), multisig, "accepting is what moves the vault's owner");
        assertEq(distributor.owner(), multisig, "and the distributor's");
        assertEq(registry.owner(), multisig, "and the registry's");
        assertEq(overture.owner(), multisig, "and the Overture token's");
        assertEq(zapper.owner(), multisig, "and the zapper's");

        assertEq(vault.pendingOwner(), address(0), "the vault's nomination is cleared");
        assertEq(distributor.pendingOwner(), address(0), "the distributor's too");
        assertEq(registry.pendingOwner(), address(0), "the registry's too");
        assertEq(overture.pendingOwner(), address(0), "the Overture token's too");
        assertEq(zapper.pendingOwner(), address(0), "and the zapper's too");

        vault.setZapper(address(1));
        distributor.setClaimsEnabled(address(asset), true);
        registry.setOperator(operatorSafe);
        overture.setMinter(operatorSafe);
        zapper.setOperator(operatorSafe);
        vm.stopPrank();

        assertEq(vault.zapper(), address(1), "the new owner can act on the vault");
        assertTrue(distributor.rewardToken(address(asset)).claimsEnabled, "and on the distributor");
        assertEq(registry.operator(), operatorSafe, "and on the registry");
        assertEq(overture.minter(), operatorSafe, "and on the Overture token");
        assertEq(zapper.operator(), operatorSafe, "and on the zapper");
    }

    /// @dev Only the nominee may accept. Anyone else — a stranger, and the standing owner
    ///      itself — is turned away by the same `OwnableUnauthorizedAccount` check.
    function test_Ownership_OnlyTheNomineeCanAcceptOnAllFive() public {
        _nominateAll(multisig);
        address[5] memory all = _allFive();

        for (uint256 i = 0; i < all.length; ++i) {
            vm.prank(stranger);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
            (bool ok,) = all[i].call(abi.encodeWithSignature("acceptOwnership()"));
            ok;
        }

        // Not even the address that made the nomination can complete it on the nominee's behalf.
        for (uint256 i = 0; i < all.length; ++i) {
            _expectUnauthorized(all[i], abi.encodeWithSignature("acceptOwnership()"));
        }

        assertEq(zapper.pendingOwner(), multisig, "a refused acceptance leaves the nomination standing");
        assertEq(overture.pendingOwner(), multisig, "on the Overture token too");
        assertEq(registry.pendingOwner(), multisig, "and on the registry");
    }

    /**
     * @dev `Ownable2Step` does not reject the zero address the way plain `Ownable` does, and it
     *      does not have to: a zero transfer is a CANCELLATION — it clears the standing
     *      nomination and leaves the owner exactly where it is. True on all five contracts,
     *      which is how a mistyped nomination is withdrawn.
     */
    function test_Ownership_TransferToZeroClearsThePendingOwnerOnAllFive() public {
        _nominateAll(multisig);
        address[5] memory all = _allFive();
        for (uint256 i = 0; i < all.length; ++i) {
            assertEq(Ownable2StepView(all[i]).pendingOwner(), multisig, "precondition: a nomination stands");
        }

        _nominateAll(address(0));

        for (uint256 i = 0; i < all.length; ++i) {
            assertEq(Ownable2StepView(all[i]).pendingOwner(), address(0), "a zero transfer clears the nomination");
            assertEq(Ownable(all[i]).owner(), address(this), "and the owner stays where it was");
        }

        // A withdrawn nomination is not acceptable afterwards.
        vm.prank(multisig);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, multisig));
        zapper.acceptOwnership();
    }

    /**
     * @dev A mistyped nominee never becomes the owner unless it accepts, so on all five
     *      contracts the mistake is undone by nominating again — which is the whole reason the
     *      two-step handshake is there.
     */
    function test_Ownership_AnUnacceptedTransferIsRecoverableOnAllFive() public {
        RejectingReceiver blackHole = new RejectingReceiver();
        _nominateAll(address(blackHole));

        address[5] memory all = _allFive();
        for (uint256 i = 0; i < all.length; ++i) {
            assertEq(Ownable(all[i]).owner(), address(this), "the owner has not moved");
        }

        // The old owner still acts, on every tier it held before the mistake...
        vault.setZapper(address(1));
        distributor.setClaimsEnabled(address(asset), true);
        registry.setOperator(operatorSafe);
        overture.setMinter(operatorSafe);
        zapper.setOperator(operatorSafe);

        // ...and can re-nominate, which is what undoes the mistake.
        _nominateAll(multisig);
        for (uint256 i = 0; i < all.length; ++i) {
            assertEq(Ownable2StepView(all[i]).pendingOwner(), multisig, "the mistake is undone by nominating again");
        }
    }

    /// @dev The five owners are independent slots; moving one must not move any other.
    function test_Ownership_EachContractIsOwnedIndependently() public {
        registry.transferOwnership(multisig);
        vm.prank(multisig);
        registry.acceptOwnership();

        assertEq(registry.owner(), multisig, "only the registry's owner moved");
        assertEq(vault.owner(), address(this), "the vault's owner is untouched");
        assertEq(zapper.owner(), address(this), "the zapper's owner is untouched");
        assertEq(distributor.owner(), address(this), "the distributor's owner is untouched");
        assertEq(overture.owner(), address(this), "the Overture token's owner is untouched");
    }

    /**
     * @dev There is no ownerless corner of this stack to reach. Renouncing would leave each
     *      proxy's `_authorizeUpgrade` with no caller and freeze its implementation forever;
     *      on the Overture token it would also freeze the minter role. All five therefore
     *      revert `RenounceDisabled` outright rather than merely discouraging the call.
     */
    function test_Ownership_NoneOfTheFiveCanBeRenounced() public {
        vm.expectRevert(LPStakingVault.RenounceDisabled.selector);
        vault.renounceOwnership();
        vm.expectRevert(IRewardsDistributor.RenounceDisabled.selector);
        distributor.renounceOwnership();
        vm.expectRevert(ILPEpochRegistry.RenounceDisabled.selector);
        registry.renounceOwnership();
        vm.expectRevert(TokenOverture.RenounceDisabled.selector);
        overture.renounceOwnership();
        vm.expectRevert(LPZapper.RenounceDisabled.selector);
        zapper.renounceOwnership();

        address[5] memory all = _allFive();
        for (uint256 i = 0; i < all.length; ++i) {
            assertEq(Ownable(all[i]).owner(), address(this), "every contract keeps its owner");
        }
    }

    /// @dev The override stays `onlyOwner`, so a stranger is stopped by the ownership check
    ///      before `RenounceDisabled` is ever reached. Two different rejections, on purpose:
    ///      the caller is told which of the two things it got wrong.
    function test_Ownership_AStrangerIsRejectedOnRenounceByTheOwnershipCheck() public {
        address[5] memory all = _allFive();
        for (uint256 i = 0; i < all.length; ++i) {
            vm.prank(stranger);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
            (bool ok,) = all[i].call(abi.encodeWithSignature("renounceOwnership()"));
            ok;
        }
    }

    /// @dev Every upgrade is owner-only on all five: the operator, the guardian and a stranger
    ///      are all refused by `_authorizeUpgrade` before any code moves.
    function test_Ownership_EveryUpgradeIsOwnerOnlyOnAllFive() public {
        address[5] memory all = _allFive();
        address[3] memory refused = [operatorSafe, multisig, stranger];
        for (uint256 i = 0; i < all.length; ++i) {
            for (uint256 j = 0; j < refused.length; ++j) {
                vm.prank(refused[j]);
                vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, refused[j]));
                (bool ok,) = all[i].call(_upgradeCall());
                ok;
            }
        }
    }

    /// @dev The distributor's handover is two-step in the same way the others are.
    function test_Ownership_TheDistributorHandoverNeedsAcceptance() public {
        distributor.transferOwnership(multisig);

        assertEq(distributor.owner(), address(this), "a nomination must not move the owner");
        assertEq(distributor.pendingOwner(), multisig, "the nominee must be recorded");

        vm.prank(multisig);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, multisig));
        distributor.setClaimsEnabled(address(asset), true);

        vm.prank(multisig);
        distributor.acceptOwnership();

        assertEq(distributor.owner(), multisig, "accepting is what moves the owner");
        assertEq(distributor.pendingOwner(), address(0), "and it clears the nomination");
        vm.prank(multisig);
        distributor.setClaimsEnabled(address(asset), true);
        assertTrue(distributor.rewardToken(address(asset)).claimsEnabled, "the new owner can act");
    }

    // ──────────────────────── Non-owner roles ──────────────────

    /// @dev The voucher signer is a signing key, not an admin. It holds nothing on-chain —
    ///      not an owner tier, not an operator tier, not the pause tier, not the mint right.
    function test_Roles_TheVoucherSignerHasNoAdminPowerAnywhere() public {
        vm.startPrank(voucherSigner);
        vm.expectRevert(abi.encodeWithSelector(IRewardsDistributor.NotOperator.selector, voucherSigner, address(this)));
        distributor.setSigner(voucherSigner);
        vm.expectRevert(abi.encodeWithSelector(IRewardsDistributor.NotOperator.selector, voucherSigner, address(this)));
        distributor.recoverExcess(address(asset), 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IRewardsDistributor.NotGuardianOrOperator.selector, voucherSigner, address(this), address(this)
            )
        );
        distributor.setPaused(true);
        bytes memory notOwner = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, voucherSigner);
        vm.expectRevert(notOwner);
        distributor.setClaimsEnabled(address(asset), true);
        vm.expectRevert(notOwner);
        distributor.addRewardToken(address(usdcToken), false, true);
        vm.expectRevert(notOwner);
        distributor.setOperator(voucherSigner);
        vm.expectRevert(abi.encodeWithSelector(TokenOverture.NotMinter.selector, voucherSigner));
        overture.mint(voucherSigner, 1);
        vm.expectRevert(abi.encodeWithSelector(IRewardsDistributor.NotOperator.selector, voucherSigner, address(this)));
        distributor.mintRewardToken(address(overture), voucherSigner, 1);
        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.NotOperator.selector, voucherSigner, address(this)));
        registry.cancelEpoch(1);
        vm.stopPrank();
    }

    /// @dev The minter is a mint right, not an admin right: it cannot move the role, nor
    ///      upgrade the token. Measured on a token whose owner and minter are two addresses.
    function test_Roles_TheMinterHasNoAdminPowerOverTheOvertureToken() public {
        TokenOverture split = _splitOverture();

        vm.prank(operatorSafe);
        split.mint(alice, 1e18);
        assertEq(split.balanceOf(alice), 1e18, "precondition: the minter can mint");

        vm.startPrank(operatorSafe);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operatorSafe));
        split.setMinter(carol);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operatorSafe));
        (bool ok,) = address(split).call(_upgradeCall());
        ok;
        vm.stopPrank();

        // And the owner is not the minter: the mint right is an address, not a permission level.
        vm.expectRevert(abi.encodeWithSelector(TokenOverture.NotMinter.selector, address(this)));
        split.mint(address(this), 1);
    }

    /// @dev The distributor proxy is the Overture token's minter, and that is ALL it is on the
    ///      token: it can neither move the minter role nor upgrade the token. Its mint right is
    ///      reached only through `mintRewardToken`, which is its operator's; a claim never mints.
    function test_Roles_TheDistributorMintsOnlyForItsOperatorAndAdministersNothing() public {
        assertEq(overture.minter(), address(distributor), "precondition: the distributor is the minter");

        vm.startPrank(address(distributor));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(distributor)));
        overture.setMinter(address(distributor));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(distributor)));
        (bool ok,) = address(overture).call(_upgradeCall());
        ok;
        vm.stopPrank();

        // The one road to the mint right is the operator's `mintRewardToken`...
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IRewardsDistributor.NotOperator.selector, stranger, address(this)));
        distributor.mintRewardToken(address(overture), stranger, 1);

        // ...and a claim pays by transfer out of the funded balance, never by minting.
        uint256 supply = overture.totalSupply();
        bytes memory sig = _signVoucher(voucherSignerPk, address(overture), alice, AWARD, FAR_DEADLINE);
        vm.prank(alice);
        distributor.claim(address(overture), AWARD, FAR_DEADLINE, sig);
        assertEq(overture.totalSupply(), supply, "a claim must never mint");
    }

    /// @dev The zapper is a stakeFor right, not an admin right — in NONE of the vault's tiers.
    function test_Roles_TheZapperHasNoAdminPowerOverTheVault() public {
        bytes memory pauseRejection = abi.encodeWithSelector(
            LPStakingVault.NotGuardianOrOperator.selector, address(zapper), address(this), address(this)
        );
        bytes memory operatorRejection =
            abi.encodeWithSelector(LPStakingVault.NotOperator.selector, address(zapper), address(this));
        bytes memory ownerRejection =
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(zapper));

        vm.startPrank(address(zapper));
        vm.expectRevert(pauseRejection);
        vault.setDepositsPaused(true);
        vm.expectRevert(pauseRejection);
        vault.setRebalancePaused(true);
        vm.expectRevert(operatorRejection);
        vault.setTwapParams(600, 100);
        vm.expectRevert(operatorRejection);
        vault.rescuePosition(1);
        vm.expectRevert(ownerRejection);
        vault.setZapper(address(zapper));
        vm.expectRevert(ownerRejection);
        vault.setBonusEscrow(address(0));
        vm.expectRevert(
            abi.encodeWithSelector(
                LPStakingVault.NotOwnerOrOperator.selector, address(zapper), address(this), address(this)
            )
        );
        vault.setGuardian(address(zapper));
        vm.expectRevert(ownerRejection);
        vault.setOperator(address(zapper));
        vm.stopPrank();
    }

    /// @dev And the owner is not the zapper: the whitelist is an address, not a permission
    ///      level, so even the owner cannot call `stakeFor`.
    function test_Roles_TheOwnerCannotCallStakeForWithoutBeingTheZapper() public {
        uint256 tokenId = _createPosition(address(this), TICK_LOWER, TICK_UPPER, LIQUIDITY);
        npmMock.approve(address(vault), tokenId);

        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.NotZapper.selector, address(this), address(zapper)));
        vault.stakeFor(alice, tokenId);
    }

    /// @dev The escrow link is owner-tier: neither the operator nor the guardian can point the
    ///      vault's exits at a contract of their choosing.
    function test_Roles_OnlyTheOwnerLinksTheBonusEscrow() public {
        LPStakingVault v = _threeTierVault();
        MockBonusEscrow escrow = new MockBonusEscrow(address(v));

        vm.prank(operatorSafe);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operatorSafe));
        v.setBonusEscrow(address(escrow));
        vm.prank(multisig);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, multisig));
        v.setBonusEscrow(address(escrow));

        v.setBonusEscrow(address(escrow));
        assertEq(v.bonusEscrow(), address(escrow), "the owner links the escrow");
    }

    // ──────────────────────── Handover matrix ──────────────────

    /**
     * @dev The vault cannot be renounced at all, so its matrix entry is not "what dies" but
     *      "what a HANDOVER costs the old holder". The old owner loses four calls when
     *      ownership is accepted elsewhere: `setZapper`, `setBonusEscrow`, `setOperator` and the
     *      upgrade.
     *
     *      `setGuardian` is NOT among them: it takes the owner OR the operator, and this
     *      harness leaves the old owner holding the operator tier, so the handover does not
     *      cost it that call — revoking a compromised hot key never waits out the timelock.
     */
    function test_Renounce_VaultOwnerLosesFourAdminCallsOnHandover() public {
        vault.transferOwnership(multisig);
        vm.prank(multisig);
        vault.acceptOwnership();

        _expectUnauthorized(address(vault), abi.encodeCall(LPStakingVault.setZapper, (address(1))));
        _expectUnauthorized(address(vault), abi.encodeCall(LPStakingVault.setBonusEscrow, (address(0))));
        _expectUnauthorized(address(vault), abi.encodeCall(LPStakingVault.setOperator, (carol)));
        _expectUnauthorized(address(vault), _upgradeCall());

        // Still held, through the operator tier this contract kept.
        vault.setGuardian(carol);
        assertEq(vault.guardian(), carol, "the operator tier keeps setGuardian across a handover");

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

    /// @dev The zapper's owner holds two calls — the upgrade and `setOperator` — and loses
    ///      exactly those on a handover. The operator's three levers are a separate slot.
    function test_Renounce_ZapperOwnerLosesTwoAdminCallsOnHandover() public {
        zapper.transferOwnership(multisig);
        vm.prank(multisig);
        zapper.acceptOwnership();

        _expectUnauthorized(address(zapper), abi.encodeCall(LPZapper.setOperator, (carol)));
        _expectUnauthorized(address(zapper), _upgradeCall());

        // The operator tier this contract kept is untouched by the ownership move.
        zapper.setTwapParams(600, 100);
        assertEq(zapper.twapWindow(), 600, "the operator keeps the calibration across a handover");
        zapper.sweep(address(usdcToken), 0, carol);
    }

    /// @dev Rotating the zapper's operator costs the old operator all three immediate levers.
    function test_Renounce_ZapperOperatorLosesThreeLeversOnRotation() public {
        LPZapper twin = _twoTierZapper();

        vm.prank(operatorSafe);
        twin.setTwapParams(600, 100);
        assertEq(twin.twapWindow(), 600, "precondition: the operator holds the calibration");

        twin.setOperator(carol);

        _expectNotOperator(address(twin), abi.encodeCall(LPZapper.setTwapParams, (900, 100)), operatorSafe, carol);
        _expectNotOperator(
            address(twin), abi.encodeCall(LPZapper.sweep, (address(usdcToken), 0, alice)), operatorSafe, carol
        );
        _expectNotOperator(address(twin), abi.encodeCall(LPZapper.rescuePosition, (1)), operatorSafe, carol);

        vm.prank(carol);
        twin.setTwapParams(900, 100);
        assertEq(twin.twapWindow(), 900, "the new operator holds the levers at once");
    }

    /**
     * @dev The distributor cannot be renounced at all, so the matrix entry is "what a HANDOVER
     *      costs the old holder". The old owner loses five calls when ownership is accepted
     *      elsewhere: the three reward-token switches, `setOperator` and the upgrade.
     *      `setGuardian` is NOT among them, for the same reason as on the vault.
     */
    function test_Renounce_DistributorOwnerLosesFiveAdminCallsOnHandover() public {
        distributor.transferOwnership(multisig);
        vm.prank(multisig);
        distributor.acceptOwnership();

        _expectUnauthorized(
            address(distributor), abi.encodeCall(RewardsDistributor.addRewardToken, (address(usdcToken), false, true))
        );
        _expectUnauthorized(
            address(distributor), abi.encodeCall(RewardsDistributor.setRewardTokenEnabled, (address(asset), false))
        );
        _expectUnauthorized(
            address(distributor), abi.encodeCall(RewardsDistributor.setClaimsEnabled, (address(asset), true))
        );
        _expectUnauthorized(address(distributor), abi.encodeCall(RewardsDistributor.setOperator, (carol)));
        _expectUnauthorized(address(distributor), _upgradeCall());

        // Still held, through the operator tier this contract kept.
        distributor.setGuardian(carol);
        assertEq(distributor.guardian(), carol, "the operator tier keeps setGuardian across a handover");

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
        twin.setClaimsEnabled(address(asset), true);
        assertTrue(
            twin.rewardToken(address(asset)).claimsEnabled, "the owner keeps its tier across a guardian rotation"
        );
    }

    function test_Renounce_DistributorOperatorLosesThreeAdminCallsOnRotation() public {
        RewardsDistributor twin = _threeTierDistributor();

        vm.prank(operatorSafe);
        twin.setSigner(carol);
        assertEq(twin.signer(), carol, "precondition: the operator holds the signer rotation");

        twin.setOperator(carol);

        _expectNotOperator(address(twin), abi.encodeCall(RewardsDistributor.setSigner, (bob)), operatorSafe, carol);
        _expectNotOperator(
            address(twin), abi.encodeCall(RewardsDistributor.recoverExcess, (address(asset), 1)), operatorSafe, carol
        );
        _expectNotGuardianOrOperator(
            address(twin), abi.encodeCall(RewardsDistributor.setPaused, (true)), operatorSafe, multisig, carol
        );

        // The guardian tier is a separate slot and is untouched by the operator move.
        vm.prank(multisig);
        twin.setPaused(true);
        assertTrue(twin.paused(), "the guardian keeps its tier across an operator rotation");
    }

    /// @dev The registry's owner holds two calls — `setOperator` and the upgrade — and loses
    ///      exactly those on a handover. The schedule itself was never the owner's.
    function test_Renounce_RegistryOwnerLosesTwoAdminCallsOnHandover() public {
        registry.transferOwnership(multisig);
        vm.prank(multisig);
        registry.acceptOwnership();

        _expectUnauthorized(address(registry), abi.encodeCall(LPEpochRegistry.setOperator, (carol)));
        _expectUnauthorized(address(registry), _upgradeCall());

        // The operator tier this contract kept still schedules.
        _scheduleNext(registry, address(this));
        assertEq(registry.epochCount(), 1, "the operator keeps the schedule across an ownership handover");
    }

    /// @dev Rotating the registry's operator costs the old operator all four schedule calls,
    ///      and hands them to the new one in the same transaction.
    function test_Renounce_RegistryOperatorLosesFourScheduleCallsOnRotation() public {
        LPEpochRegistry twin = _twoTierRegistry();
        (uint64 startsAt, uint64 endsAt) = _scheduleNext(twin, operatorSafe);

        twin.setOperator(carol);

        address[] memory tokens = new address[](0);
        uint256[] memory amounts = new uint256[](0);
        _expectNotOperator(
            address(twin),
            abi.encodeCall(LPEpochRegistry.scheduleEpoch, (2, endsAt, endsAt + 900, tokens, amounts)),
            operatorSafe,
            carol
        );
        _expectNotOperator(
            address(twin),
            abi.encodeCall(LPEpochRegistry.setEpochAmount, (1, address(overture), 1)),
            operatorSafe,
            carol
        );
        _expectNotOperator(
            address(twin),
            abi.encodeCall(LPEpochRegistry.updateEpochBounds, (1, startsAt, endsAt + 900)),
            operatorSafe,
            carol
        );
        _expectNotOperator(address(twin), abi.encodeCall(LPEpochRegistry.cancelEpoch, (1)), operatorSafe, carol);

        vm.prank(carol);
        twin.cancelEpoch(1);
        assertTrue(twin.epoch(1).cancelled, "the new operator holds the schedule at once");
    }

    /// @dev The Overture token's owner holds two calls — `setMinter` and the upgrade — and
    ///      loses exactly those on a handover. Minting is the minter's, a separate slot.
    function test_Renounce_OvertureOwnerLosesTwoAdminCallsOnHandover() public {
        overture.transferOwnership(multisig);
        vm.prank(multisig);
        overture.acceptOwnership();

        _expectUnauthorized(address(overture), abi.encodeCall(TokenOverture.setMinter, (carol)));
        _expectUnauthorized(address(overture), _upgradeCall());

        // The mint right — the distributor's, reached through its operator (this contract) — is
        // untouched by the ownership move.
        distributor.mintRewardToken(address(overture), alice, 1);
        assertEq(overture.balanceOf(alice), 1, "the minter keeps minting across an ownership handover");
    }

    /// @dev Moving the minter costs the old minter its one call, immediately.
    function test_Renounce_OvertureMinterLosesMintOnRotation() public {
        TokenOverture split = _splitOverture();

        split.setMinter(carol);

        vm.prank(operatorSafe);
        vm.expectRevert(abi.encodeWithSelector(TokenOverture.NotMinter.selector, operatorSafe));
        split.mint(operatorSafe, 1);

        vm.prank(carol);
        split.mint(carol, 1);
        assertEq(split.balanceOf(carol), 1, "the new minter mints at once");
    }

    /**
     * @dev The load-bearing half of the matrix: with every admin gone, every user path still
     *      works. Staking, zapping, re-ranging, exiting and claiming a funded reward are gated
     *      by the staker record, the zapper whitelist, the voucher signature and the
     *      distributor's balance — never by an admin. This is what makes "exits are
     *      unconditional" a measured property.
     *
     *      None of the five can be renounced (see {test_Ownership_NoneOfTheFiveCanBeRenounced}),
     *      so the closest reachable equivalent is a set of roles that will never act again: a
     *      black hole holding every tier on every contract, having accepted each handover.
     */
    function test_Renounce_AFullyOwnerlessStackStillServesEveryUserPath() public {
        uint256 aliceToken = _stakePosition(alice);
        RejectingReceiver blackHole = _abandonEverything();

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

        // And claiming a funded, open reward still works, because the signer is fixed, not
        // administered, and the payment comes out of the balance already in the contract.
        bytes memory sig = _signVoucher(voucherSignerPk, address(overture), bob, AWARD, FAR_DEADLINE);
        vm.prank(bob);
        assertEq(
            distributor.claim(address(overture), AWARD, FAR_DEADLINE, sig),
            AWARD,
            "claiming must survive a fully ownerless stack"
        );
        assertEq(overture.owner(), address(blackHole), "precondition held throughout: the admins are gone");
    }

    /**
     * @dev What an abandoned stack can never do again. A token whose claims were closed at
     *      launch ($ASSET) can never be opened, no new reward token can be added, no epoch can
     *      be scheduled, and no new $OVTR can be minted. Claims of an open token keep paying
     *      until its funded balance runs out, then revert with `InsufficientFunds` — and since
     *      funding is a plain transfer, anyone can still top it up.
     */
    function test_Renounce_AnAbandonedStackCanNeverOpenAddScheduleOrMint() public {
        RejectingReceiver blackHole = _abandonEverything();
        address hole = address(blackHole);
        assertFalse(distributor.rewardToken(address(asset)).claimsEnabled, "precondition: $ASSET claims closed");

        // The four things nobody can do any more.
        _expectUnauthorized(
            address(distributor), abi.encodeCall(RewardsDistributor.setClaimsEnabled, (address(asset), true))
        );
        _expectUnauthorized(
            address(distributor), abi.encodeCall(RewardsDistributor.addRewardToken, (address(usdcToken), false, true))
        );
        _expectNotOperator(address(registry), abi.encodeCall(LPEpochRegistry.cancelEpoch, (1)), address(this), hole);
        vm.expectRevert(abi.encodeWithSelector(TokenOverture.NotMinter.selector, address(this)));
        overture.mint(address(distributor), 1);
        _expectNotOperator(
            address(distributor),
            abi.encodeCall(RewardsDistributor.mintRewardToken, (address(overture), address(distributor), 1)),
            address(this),
            hole
        );

        // An $ASSET voucher can never pay.
        bytes memory assetSig = _signVoucher(voucherSignerPk, address(asset), alice, AWARD, FAR_DEADLINE);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IRewardsDistributor.TokenClaimsDisabled.selector, address(asset)));
        distributor.claim(address(asset), AWARD, FAR_DEADLINE, assetSig);

        // $OVTR pays until the balance runs out, then reverts until someone transfers more in.
        uint256 funded = overture.balanceOf(address(distributor));
        bytes memory bigSig = _signVoucher(voucherSignerPk, address(overture), alice, funded + 1, FAR_DEADLINE);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IRewardsDistributor.InsufficientFunds.selector, address(overture), funded + 1, funded
            )
        );
        distributor.claim(address(overture), funded + 1, FAR_DEADLINE, bigSig);

        bytes memory bobSig = _signVoucher(voucherSignerPk, address(overture), bob, AWARD, FAR_DEADLINE);
        vm.prank(bob);
        distributor.claim(address(overture), AWARD, FAR_DEADLINE, bobSig);
        assertEq(overture.balanceOf(bob), AWARD, "a voucher inside the balance still pays");
    }

    // ──────────────────────── The tier matrix ──────────────────

    /**
     * @dev Rule one, owner side: the timelock has no undelayed switch at all. It is rejected on
     *      every pause switch AND on every operator-tier call, on every contract that has one,
     *      and it does not hold the Overture mint right. Measured on twins whose roles are
     *      distinct addresses.
     */
    function test_Tiers_TheOwnerIsRejectedOnEveryGuardianAndOperatorFunction() public {
        LPStakingVault v = _threeTierVault();
        RewardsDistributor d = _threeTierDistributor();
        LPEpochRegistry r = _twoTierRegistry();
        LPZapper z = _twoTierZapper();
        TokenOverture t = _splitOverture();

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
            address(d),
            abi.encodeCall(RewardsDistributor.recoverExcess, (address(asset), 1)),
            address(this),
            operatorSafe
        );
        _expectNotOperator(
            address(d),
            abi.encodeCall(RewardsDistributor.mintRewardToken, (address(overture), address(this), 1)),
            address(this),
            operatorSafe
        );

        _expectRegistryOperatorTierRejects(r, address(this), operatorSafe);
        _expectZapperOperatorTierRejects(z, address(this), operatorSafe);

        vm.expectRevert(abi.encodeWithSelector(TokenOverture.NotMinter.selector, address(this)));
        t.mint(address(this), 1);
    }

    /**
     * @dev Rule two: the hot guardian key holds the pause switches and NOTHING else. Nothing it
     *      can call moves value or installs a key, which is what makes it safe to keep hot —
     *      so it is rejected on every operator-tier call and on every owner call.
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
            address(d), abi.encodeCall(RewardsDistributor.recoverExcess, (address(asset), 1)), multisig, operatorSafe
        );
        _expectNotOperator(
            address(d),
            abi.encodeCall(RewardsDistributor.mintRewardToken, (address(overture), multisig, 1)),
            multisig,
            operatorSafe
        );

        // ...and nothing on the owner tier.
        vm.startPrank(multisig);
        bytes memory rejection = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, multisig);
        vm.expectRevert(rejection);
        v.setZapper(address(1));
        vm.expectRevert(rejection);
        v.setBonusEscrow(address(0));
        vm.expectRevert(rejection);
        v.setOperator(multisig);
        vm.expectRevert(rejection);
        d.setClaimsEnabled(address(asset), true);
        vm.expectRevert(rejection);
        d.addRewardToken(address(usdcToken), false, true);
        vm.expectRevert(rejection);
        d.setOperator(multisig);
        vm.stopPrank();

        // ...and it cannot re-appoint or keep itself: `setGuardian` takes the owner or the
        // operator, never the standing guardian, so a leaked hot key cannot defend its seat.
        _expectNotOwnerOrOperator(
            address(v), abi.encodeCall(LPStakingVault.setGuardian, (multisig)), multisig, address(this), operatorSafe
        );
        _expectNotOwnerOrOperator(
            address(d),
            abi.encodeCall(RewardsDistributor.setGuardian, (multisig)),
            multisig,
            address(this),
            operatorSafe
        );
    }

    /**
     * @dev The operator holds its own calls on every contract AND the pause switches — the cold
     *      fallback for a lost guardian key, so a pause is never stuck for the 48 h a guardian
     *      rotation through the timelock takes. It still holds nothing on any owner tier.
     */
    function test_Tiers_TheOperatorHoldsItsOwnCallsAndThePauses() public {
        LPStakingVault v = _threeTierVault();
        RewardsDistributor d = _threeTierDistributor();
        LPEpochRegistry r = _twoTierRegistry();
        LPZapper z = _twoTierZapper();

        // The pause switches, from the operator rather than from the guardian.
        vm.prank(operatorSafe);
        v.setDepositsPaused(true);
        vm.prank(operatorSafe);
        v.setRebalancePaused(true);
        vm.prank(operatorSafe);
        d.setPaused(true);
        assertTrue(v.depositsPaused() && v.rebalancePaused() && d.paused(), "the operator must be able to pause too");

        // The vault's operator tier: calibration and the NFT recovery hatch.
        vm.prank(operatorSafe);
        v.setTwapParams(600, 100);
        assertEq(v.twapWindow(), 600, "the operator must be able to recalibrate the guard");

        uint256 stray = _createPosition(alice, TICK_LOWER, TICK_UPPER, LIQUIDITY);
        vm.prank(alice);
        npmMock.transferFrom(alice, address(v), stray);
        vm.prank(operatorSafe);
        v.rescuePosition(stray);
        assertEq(npmMock.ownerOf(stray), operatorSafe, "the rescue must land on operator(), not on the guardian");

        // The distributor's operator tier: signer rotation and treasury recovery, any token.
        vm.prank(operatorSafe);
        d.setSigner(carol);
        assertEq(d.signer(), carol, "the operator must be able to rotate the signer");

        asset.transfer(address(d), 1_000e18);
        vm.prank(operatorSafe);
        d.recoverExcess(address(asset), 1_000e18);
        assertEq(asset.balanceOf(operatorSafe), 1_000e18, "the recovery must land on operator()");

        // ...and minting a mintable reward token to a wallet, once the twin is that token's minter.
        overture.setMinter(address(d));
        vm.prank(operatorSafe);
        d.mintRewardToken(address(overture), alice, 1e18);
        assertEq(overture.balanceOf(alice), 1e18, "the operator must be able to mint through its distributor");

        // The registry's operator tier: the whole schedule, with no delay.
        _scheduleNext(r, operatorSafe);
        vm.prank(operatorSafe);
        r.setEpochAmount(1, address(overture), 2e18);
        assertEq(r.epochAmount(1, address(overture)), 2e18, "the operator must be able to set an amount");
        vm.prank(operatorSafe);
        r.cancelEpoch(1);
        assertTrue(r.epoch(1).cancelled, "the operator must be able to cancel");

        // The zapper's operator tier: the three immediate levers.
        vm.prank(operatorSafe);
        z.setTwapParams(600, 100);
        assertEq(z.twapWindow(), 600, "the operator must be able to recalibrate the zapper");
        vm.prank(operatorSafe);
        z.sweep(address(usdcToken), 0, alice);

        // And the guardian seat: appoint a replacement, on both proxies that have one.
        vm.prank(operatorSafe);
        v.setGuardian(carol);
        assertEq(v.guardian(), carol, "the operator must be able to appoint a new vault guardian");
        vm.prank(operatorSafe);
        d.setGuardian(carol);
        assertEq(d.guardian(), carol, "and a new distributor guardian");

        // And nothing on any owner tier — `setOperator` in particular is owner-only on every
        // contract, so the operator still cannot rotate itself.
        vm.startPrank(operatorSafe);
        bytes memory rejection = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operatorSafe);
        vm.expectRevert(rejection);
        v.setZapper(address(1));
        vm.expectRevert(rejection);
        v.setBonusEscrow(address(0));
        vm.expectRevert(rejection);
        v.setOperator(operatorSafe);
        vm.expectRevert(rejection);
        d.setClaimsEnabled(address(asset), true);
        vm.expectRevert(rejection);
        d.setRewardTokenEnabled(address(asset), false);
        vm.expectRevert(rejection);
        d.addRewardToken(address(usdcToken), false, true);
        vm.expectRevert(rejection);
        d.setOperator(operatorSafe);
        vm.expectRevert(rejection);
        r.setOperator(operatorSafe);
        vm.expectRevert(rejection);
        z.setOperator(operatorSafe);
        vm.stopPrank();
    }

    /**
     * @dev The guardian is a hot key: one externally owned account, kept online, holding pause
     *      switches that act in the transaction that calls them. If that key leaks, the owner
     *      cannot help for 48 hours, because the owner is a `TimelockController`. The operator
     *      multisig can act at once, so it can revoke.
     *
     *      Measured end to end on twins whose three roles are three addresses: the operator
     *      revokes by passing `address(0)`, `GuardianSet` announces `(previous, address(0))`,
     *      the former guardian's pause calls stop working immediately, the operator's own pause
     *      calls keep working, and the owner can re-appoint a guardian afterwards.
     */
    function test_Tiers_TheOperatorCanRevokeTheGuardianWithNoDelay() public {
        LPStakingVault v = _threeTierVault();
        RewardsDistributor d = _threeTierDistributor();

        // Precondition: the hot key holds all three switches.
        vm.startPrank(multisig);
        v.setDepositsPaused(true);
        v.setRebalancePaused(true);
        d.setPaused(true);
        vm.stopPrank();

        // The revocation itself, one transaction from the operator, announcing both sides.
        vm.expectEmit(false, false, false, true, address(v));
        emit LPStakingVault.GuardianSet(multisig, address(0));
        vm.prank(operatorSafe);
        v.setGuardian(address(0));
        assertEq(v.guardian(), address(0), "the vault's guardian seat must be vacant");

        vm.expectEmit(false, false, false, true, address(d));
        emit IRewardsDistributor.GuardianSet(multisig, address(0));
        vm.prank(operatorSafe);
        d.setGuardian(address(0));
        assertEq(d.guardian(), address(0), "the distributor's guardian seat must be vacant");

        // The former guardian is out in the same block, on all three switches.
        _expectNotGuardianOrOperator(
            address(v), abi.encodeCall(LPStakingVault.setDepositsPaused, (false)), multisig, address(0), operatorSafe
        );
        _expectNotGuardianOrOperator(
            address(v), abi.encodeCall(LPStakingVault.setRebalancePaused, (false)), multisig, address(0), operatorSafe
        );
        _expectNotGuardianOrOperator(
            address(d), abi.encodeCall(RewardsDistributor.setPaused, (false)), multisig, address(0), operatorSafe
        );

        // The operator keeps every switch the guardian held, so nothing was lost by revoking.
        vm.startPrank(operatorSafe);
        v.setDepositsPaused(false);
        v.setRebalancePaused(false);
        d.setPaused(false);
        vm.stopPrank();
        assertFalse(v.depositsPaused() || v.rebalancePaused() || d.paused(), "the operator must still unpause");

        // And the owner can appoint a replacement from the vacant state.
        vm.expectEmit(false, false, false, true, address(v));
        emit LPStakingVault.GuardianSet(address(0), carol);
        v.setGuardian(carol);
        d.setGuardian(carol);
        vm.startPrank(carol);
        v.setDepositsPaused(true);
        d.setPaused(true);
        vm.stopPrank();
        assertTrue(v.depositsPaused() && d.paused(), "the replacement guardian must hold the tier");
    }

    /// @dev A stranger holds no tier at all, on any of the five, and each rejection names the
    ///      tier it failed.
    function test_Tiers_AStrangerIsRejectedEverywhere() public {
        LPStakingVault v = _threeTierVault();
        RewardsDistributor d = _threeTierDistributor();
        LPEpochRegistry r = _twoTierRegistry();
        LPZapper z = _twoTierZapper();
        TokenOverture t = _splitOverture();

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
            address(d), abi.encodeCall(RewardsDistributor.recoverExcess, (address(asset), 1)), stranger, operatorSafe
        );
        _expectNotOperator(
            address(d),
            abi.encodeCall(RewardsDistributor.mintRewardToken, (address(overture), stranger, 1)),
            stranger,
            operatorSafe
        );
        _expectRegistryOperatorTierRejects(r, stranger, operatorSafe);
        _expectZapperOperatorTierRejects(z, stranger, operatorSafe);

        _expectNotOwnerOrOperator(
            address(v), abi.encodeCall(LPStakingVault.setGuardian, (stranger)), stranger, address(this), operatorSafe
        );
        _expectNotOwnerOrOperator(
            address(d),
            abi.encodeCall(RewardsDistributor.setGuardian, (stranger)),
            stranger,
            address(this),
            operatorSafe
        );

        vm.startPrank(stranger);
        bytes memory rejection = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger);
        vm.expectRevert(rejection);
        v.setOperator(stranger);
        vm.expectRevert(rejection);
        v.setBonusEscrow(address(0));
        vm.expectRevert(rejection);
        d.setOperator(stranger);
        vm.expectRevert(rejection);
        d.addRewardToken(address(usdcToken), false, true);
        vm.expectRevert(rejection);
        d.setRewardTokenEnabled(address(asset), false);
        vm.expectRevert(rejection);
        d.setClaimsEnabled(address(asset), true);
        vm.expectRevert(rejection);
        r.setOperator(stranger);
        vm.expectRevert(rejection);
        z.setOperator(stranger);
        vm.expectRevert(rejection);
        t.setMinter(stranger);
        vm.expectRevert(abi.encodeWithSelector(TokenOverture.NotMinter.selector, stranger));
        t.mint(stranger, 1);
        vm.stopPrank();
    }

    /**
     * @dev The v1 -> v2 migration is owner-tier like the upgrade it rides in: the operator, the
     *      guardian and a stranger get the Ownable rejection, the owner runs it. The field it
     *      writes is public: anyone reads `asset()`. And no tier mints $ASSET — the operator,
     *      the one tier that reaches `mintRewardToken`, is refused by address.
     */
    function test_Tiers_InitializeV2IsOwnerOnlyAssetIsPublicAndNobodyMintsAsset() public {
        RewardsDistributor d = _threeTierDistributor();
        address[3] memory refused = [operatorSafe, multisig, stranger];
        for (uint256 i = 0; i < refused.length; ++i) {
            vm.prank(refused[i]);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, refused[i]));
            d.initializeV2(address(asset));
        }
        d.initializeV2(address(asset));

        vm.prank(stranger);
        assertEq(d.asset(), address(asset), "asset() is a public view");

        vm.prank(operatorSafe);
        vm.expectRevert(abi.encodeWithSelector(IRewardsDistributor.AssetNotMintable.selector, address(asset)));
        d.mintRewardToken(address(asset), operatorSafe, 1);
        _expectNotOperator(
            address(d),
            abi.encodeCall(RewardsDistributor.mintRewardToken, (address(asset), address(this), 1)),
            address(this),
            operatorSafe
        );
    }

    // ──────────────────────── Helpers ──────────────────────────

    /// @dev The five contracts' proxy addresses, in deploy-script order.
    function _allFive() private view returns (address[5] memory) {
        return [address(overture), address(distributor), address(registry), address(vault), address(zapper)];
    }

    /// @dev Nominates `to` as the next owner of all five (a zero `to` cancels the nominations).
    function _nominateAll(address to) private {
        overture.transferOwnership(to);
        distributor.transferOwnership(to);
        registry.transferOwnership(to);
        vault.transferOwnership(to);
        zapper.transferOwnership(to);
    }

    /// @dev Calldata of an upgrade attempt. The implementation address never matters here:
    ///      `_authorizeUpgrade` rejects the caller before the target is looked at.
    function _upgradeCall() private pure returns (bytes memory) {
        return abi.encodeWithSignature("upgradeToAndCall(address,bytes)", address(1), bytes(""));
    }

    /**
     * @dev Hands every tier of every contract to a black hole that will never act again: the
     *      five owners (each handover accepted), the vault's and the distributor's guardian and
     *      operator, and the registry's and the zapper's operator. The Overture minter stays the
     *      distributor proxy, exactly as in production; with the distributor's operator gone,
     *      nobody can reach its `mintRewardToken` any more.
     */
    function _abandonEverything() private returns (RejectingReceiver blackHole) {
        blackHole = new RejectingReceiver();
        address hole = address(blackHole);

        vault.setGuardian(hole);
        vault.setOperator(hole);
        distributor.setGuardian(hole);
        distributor.setOperator(hole);
        registry.setOperator(hole);
        zapper.setOperator(hole);

        _nominateAll(hole);
        vm.startPrank(hole);
        overture.acceptOwnership();
        distributor.acceptOwnership();
        registry.acceptOwnership();
        vault.acceptOwnership();
        zapper.acceptOwnership();
        vm.stopPrank();
    }

    /// @dev Schedules the next epoch of `r` as `operator_`: on the grid, one margin plus one
    ///      interval ahead, one interval long, emitting 1 $OVTR.
    function _scheduleNext(LPEpochRegistry r, address operator_) private returns (uint64 startsAt, uint64 endsAt) {
        uint64 interval = r.INTERVAL();
        startsAt = uint64(((block.timestamp + r.SCHEDULE_MARGIN()) / interval + 1) * interval);
        endsAt = startsAt + interval;
        address[] memory tokens = new address[](1);
        tokens[0] = address(overture);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 1e18;
        // The id is read BEFORE the prank: a view call inside the argument list would consume it.
        uint256 id = r.epochCount() + 1;
        vm.prank(operator_);
        r.scheduleEpoch(id, startsAt, endsAt, tokens, amounts);
    }

    /// @dev All four schedule calls of `r` refuse `caller`, naming `expectedOperator`.
    function _expectRegistryOperatorTierRejects(LPEpochRegistry r, address caller, address expectedOperator) private {
        address[] memory tokens = new address[](0);
        uint256[] memory amounts = new uint256[](0);
        _expectNotOperator(
            address(r),
            abi.encodeCall(LPEpochRegistry.scheduleEpoch, (1, 3600, 4500, tokens, amounts)),
            caller,
            expectedOperator
        );
        _expectNotOperator(
            address(r),
            abi.encodeCall(LPEpochRegistry.setEpochAmount, (1, address(overture), 1)),
            caller,
            expectedOperator
        );
        _expectNotOperator(
            address(r), abi.encodeCall(LPEpochRegistry.updateEpochBounds, (1, 3600, 4500)), caller, expectedOperator
        );
        _expectNotOperator(address(r), abi.encodeCall(LPEpochRegistry.cancelEpoch, (1)), caller, expectedOperator);
    }

    /// @dev All three immediate levers of `z` refuse `caller`, naming `expectedOperator`.
    function _expectZapperOperatorTierRejects(LPZapper z, address caller, address expectedOperator) private {
        _expectNotOperator(address(z), abi.encodeCall(LPZapper.setTwapParams, (600, 100)), caller, expectedOperator);
        _expectNotOperator(
            address(z), abi.encodeCall(LPZapper.sweep, (address(usdcToken), 0, caller)), caller, expectedOperator
        );
        _expectNotOperator(address(z), abi.encodeCall(LPZapper.rescuePosition, (1)), caller, expectedOperator);
    }

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

    /// @dev The distributor's twin of {_threeTierVault}, registered with the launch tokens.
    function _threeTierDistributor() private returns (RewardsDistributor) {
        return _deployDistributorProxy(
            address(this),
            multisig,
            operatorSafe,
            voucherSigner,
            address(asset),
            _launchRewardTokens(address(asset), false, address(overture))
        );
    }

    /// @dev A registry proxy bound to the harness distributor, owner = this, operator = {operatorSafe}.
    function _twoTierRegistry() private returns (LPEpochRegistry) {
        return _deployRegistryProxy(address(distributor), address(this), operatorSafe);
    }

    /// @dev A zapper proxy on the harness market, owner = this, operator = {operatorSafe}.
    function _twoTierZapper() private returns (LPZapper) {
        return _deployZapperProxy(
            ZapperProxyParams({
                vault: address(vault),
                positionManager: address(npmMock),
                pool: address(poolMock),
                token0: token0,
                token1: token1,
                fee: FEE,
                swapRouter: address(routerMock),
                usdc: address(usdcToken),
                asset: address(asset),
                owner: address(this),
                operator: operatorSafe,
                twapWindow: MIN_TWAP_WINDOW,
                maxDeviationTicks: 500
            })
        );
    }

    /// @dev An Overture token proxy, owner = this, minter = {operatorSafe}.
    function _splitOverture() private returns (TokenOverture) {
        return _deployOvertureProxy(OVERTURE_NAME, OVERTURE_SYMBOL, address(this), operatorSafe);
    }

    /// @dev Calls `data` on `target` as `caller` and requires the operator rejection, naming
    ///      `expectedOperator` as the address that would have been allowed. The vault, the
    ///      distributor, the registry and the zapper all declare `NotOperator(address,address)`,
    ///      so one selector serves all four.
    function _expectNotOperator(address target, bytes memory data, address caller, address expectedOperator) private {
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.NotOperator.selector, caller, expectedOperator));
        (bool ok,) = target.call(data);
        ok; // the cheatcode asserts; the boolean is only here to satisfy the compiler
    }

    /// @dev The same for a pause switch, which names BOTH addresses that would have been
    ///      allowed. The vault and the distributor declare `NotGuardianOrOperator(address,address,address)`.
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

    /// @dev The same for `setGuardian`, which names both tiers that would have been allowed.
    function _expectNotOwnerOrOperator(
        address target,
        bytes memory data,
        address caller,
        address expectedOwner,
        address expectedOperator
    ) private {
        vm.prank(caller);
        vm.expectRevert(
            abi.encodeWithSelector(LPStakingVault.NotOwnerOrOperator.selector, caller, expectedOwner, expectedOperator)
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

/// @dev `pendingOwner()` of the five contracts, read without importing five types.
interface Ownable2StepView {
    function pendingOwner() external view returns (address);
}
