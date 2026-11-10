// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {StakingV3Harness} from "../utils/StakingV3Harness.sol";
import {WeightedStakingPoolV3} from "../../../contracts/staking-v3/WeightedStakingPoolV3.sol";
import {V3BonusVault} from "../../../contracts/staking-v3/V3BonusVault.sol";
import {LPProxy} from "../../../contracts/lp-staking/deploy/LPProxy.sol";
import {MockERC20Permit} from "../../../contracts/lp-staking/mocks/MockERC20Permit.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";

/**
 * @notice {WeightedStakingPoolV3}: v2's lifecycle, vouchers and exits behind a UUPS proxy, WITHOUT
 *         v2's principal penalty (decision of 2026-11-10), plus the migrator's `stakeFor` and the
 *         fail-closed early-exit notification.
 *
 *  `p` is a fresh pool whose activation is one day ahead (so a withdrawal both before and during
 *  the active period is reachable), deployed WITHOUT the rewards waiver (v2's reward rules), with
 *  `carol` as its migrator and the harness bonus vault rebuilt
 *  around it (`book`, migrator `carol`), so a forfeiture is visible end to end.
 */
contract WeightedStakingPoolV3Test is StakingV3Harness {
    WeightedStakingPoolV3 internal p;
    V3BonusVault internal book;
    uint256 internal start;
    uint256 internal end;

    uint256 internal constant AMOUNT = 1_000e18;
    /// v2's penalty receiver: v3 must never send it anything.
    address internal constant V2_PENALTY_RECEIVER = 0xD6719Ce10F1b499Bd8FE022AB045b991b996dA6a;

    function setUp() public {
        _deployStakingV3();
        start = block.timestamp + 1 days;
        end = start + 30 days;
        p = _deployPoolV3(address(asset), address(usdcToken), start, end, false);
        book = _deployBonusVault(address(asset), carol, address(p), address(0));
        p.setMigrator(carol);
        p.setBonusVault(address(book));

        vm.prank(alice);
        asset.approve(address(p), type(uint256).max);
        vm.prank(carol);
        asset.approve(address(p), type(uint256).max);
        usdcToken.approve(address(p), type(uint256).max);
    }

    function _stake(address user, uint256 amount, uint256 weight) internal {
        bytes memory sig = _signStake(p, user, amount, weight, FAR_DEADLINE);
        vm.prank(user);
        p.stake(amount, weight, FAR_DEADLINE, sig);
    }

    function _stakeFor(address user, uint256 amount, uint256 weight) internal {
        vm.prank(carol);
        p.stakeFor(user, amount, weight);
    }

    // ──────────────────────── Initialization ───────────────────

    function test_Initialize_RecordsTheConfiguration() public view {
        assertEq(p.stakingToken(), address(asset));
        assertEq(p.rewardToken(), address(usdcToken));
        assertEq(p.activationEpoch(), start);
        assertEq(p.endEpoch(), end);
        assertEq(p.poolDuration(), 30 days);
        assertEq(p.signer(), voucherSigner);
        assertEq(p.globalLastUpdateTime(), start);
        assertEq(p.owner(), address(this));
        assertEq(p.migrator(), carol);
        assertEq(p.bonusVault(), address(book));
        assertFalse(p.rewardsWaived());
        assertEq(p.BASE_WEIGHT(), 1000);
        assertEq(p.MAX_WEIGHT(), 2000);
    }

    function test_Abi_ThePenaltyGettersAreGone() public view {
        string[5] memory gone = [
            "MAX_PENALTY_BPS()",
            "MIN_PENALTY_BPS()",
            "PENALTY_RECEIVER()",
            "getCurrentPenaltyPct()",
            "getCurrentPenalty(address)"
        ];
        for (uint256 i = 0; i < gone.length; i++) {
            (bool ok,) = address(p).staticcall(abi.encodeWithSignature(gone[i], alice));
            assertFalse(ok, gone[i]);
        }
        assertEq(p.totalPenalized(), 0, "the deprecated counter reads zero");
    }

    function test_Initialize_ValidatesEveryArgument() public {
        WeightedStakingPoolV3 impl = new WeightedStakingPoolV3();
        _expectInitRevert(impl, address(0), address(usdcToken), start, end, voucherSigner, "Invalid staking token");
        _expectInitRevert(impl, address(asset), address(0), start, end, voucherSigner, "Invalid reward token");
        _expectInitRevert(impl, address(asset), address(asset), start, end, voucherSigner, "Tokens must be different");
        _expectInitRevert(
            impl, address(asset), address(usdcToken), end, end, voucherSigner, "End must be after activation"
        );
        _expectInitRevert(impl, address(asset), address(usdcToken), start, end, address(0), "Invalid signer");
    }

    function _expectInitRevert(
        WeightedStakingPoolV3 impl,
        address staking,
        address reward,
        uint256 s,
        uint256 e,
        address signer_,
        bytes memory reason
    ) internal {
        vm.expectRevert(reason);
        new LPProxy(
            address(impl),
            abi.encodeCall(WeightedStakingPoolV3.initialize, (address(this), staking, reward, s, e, signer_, true))
        );
    }

    function test_Initialize_ImplementationIsLocked() public {
        WeightedStakingPoolV3 impl = new WeightedStakingPoolV3();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(address(this), address(asset), address(usdcToken), start, end, voucherSigner, true);
    }

    // ──────────────────────── stake ────────────────────────────

    function test_Stake_WithAValidVoucher() public {
        _stake(alice, AMOUNT, 1500);
        (uint256 amount, uint256 weight,,) = p.stakes(alice);
        assertEq(amount, AMOUNT);
        assertEq(weight, 1500);
        assertEq(p.nonces(alice), 1);
        assertEq(p.totalStaked(), AMOUNT);
        assertEq(p.totalWeightedStaked(), AMOUNT * 1500);
        assertEq(p.getUserMultiplier(alice), 1500);
    }

    function test_Stake_Rejections() public {
        bytes memory sig = _signStake(p, alice, AMOUNT, 1500, FAR_DEADLINE);
        vm.startPrank(alice);
        vm.expectRevert(bytes("Amount must be > 0"));
        p.stake(0, 1500, FAR_DEADLINE, sig);
        vm.expectRevert(bytes("Invalid weight"));
        p.stake(AMOUNT, 999, FAR_DEADLINE, sig);
        vm.expectRevert(bytes("Invalid weight"));
        p.stake(AMOUNT, 2001, FAR_DEADLINE, sig);
        vm.expectRevert(bytes("Signature required"));
        p.stake(AMOUNT, 1500, FAR_DEADLINE, "");
        vm.expectRevert(bytes("Signature expired"));
        p.stake(AMOUNT, 1500, block.timestamp - 1, sig);
        vm.expectRevert(bytes("Invalid signature"));
        p.stake(AMOUNT + 1, 1500, FAR_DEADLINE, sig);
        vm.stopPrank();

        vm.warp(end);
        vm.prank(alice);
        vm.expectRevert(bytes("Pool has ended"));
        p.stake(AMOUNT, 1500, FAR_DEADLINE, sig);
    }

    // ──────────────────────── stakeFor ─────────────────────────

    function test_StakeFor_OnlyTheMigratorPullsFromItAndCreditsTheUser() public {
        uint256 carolBefore = asset.balanceOf(carol);
        vm.expectEmit(address(p));
        emit WeightedStakingPoolV3.StakedFor(alice, carol, AMOUNT, 1200);
        _stakeFor(alice, AMOUNT, 1200);
        assertEq(asset.balanceOf(carol), carolBefore - AMOUNT, "pulled from the migrator");
        (uint256 amount, uint256 weight,,) = p.stakes(alice);
        assertEq(amount, AMOUNT);
        assertEq(weight, 1200);
        assertEq(p.nonces(alice), 0, "no pool nonce is spent");

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(WeightedStakingPoolV3.NotMigrator.selector, stranger, carol));
        p.stakeFor(alice, AMOUNT, 1200);
    }

    function test_StakeFor_ReplacesTheMultiplierOfAnExistingStake() public {
        _stake(alice, AMOUNT, 2000);
        _stakeFor(alice, AMOUNT, 1000);
        assertEq(p.totalWeightedStaked(), 2 * AMOUNT * 1000);
    }

    function test_StakeFor_Rejections() public {
        vm.startPrank(carol);
        vm.expectRevert(bytes("Invalid user"));
        p.stakeFor(address(0), AMOUNT, 1000);
        vm.expectRevert(bytes("Amount must be > 0"));
        p.stakeFor(alice, 0, 1000);
        vm.expectRevert(bytes("Invalid weight"));
        p.stakeFor(alice, AMOUNT, 2001);
        vm.warp(end);
        vm.expectRevert(bytes("Pool has ended"));
        p.stakeFor(alice, AMOUNT, 1000);
        vm.stopPrank();
    }

    function test_StakeFor_ClosedWhenTheMigratorIsZero() public {
        p.setMigrator(address(0));
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(WeightedStakingPoolV3.NotMigrator.selector, carol, address(0)));
        p.stakeFor(alice, AMOUNT, 1000);
    }

    // ──────────────────────── withdraw ─────────────────────────

    function test_Withdraw_BeforeActivationIsFreeButForfeitsTheBonus() public {
        _stakeFor(alice, AMOUNT, 1500);
        vm.prank(carol);
        book.reserve(alice, 50e18, uint64(end), 3);

        uint256 before = asset.balanceOf(alice);
        vm.expectEmit(address(book));
        emit V3BonusVault.BonusForfeited(alice, 50e18);
        vm.prank(alice);
        p.withdraw(AMOUNT / 2, 0, 0, "");
        assertEq(asset.balanceOf(alice) - before, AMOUNT / 2, "the principal in full");
        (uint256 reserved,) = book.reservedOf(alice);
        assertEq(reserved, 0, "the whole reservation is gone");
        assertEq(p.getUserMultiplier(alice), 1000, "an unsigned withdraw resets the boost");
    }

    function test_Withdraw_EarlyWithdrawReturnsThePrincipalInFull() public {
        _stakeFor(alice, AMOUNT, 1000);
        vm.prank(carol);
        book.reserve(alice, 50e18, uint64(end), 3);
        vm.warp(start + 15 days);
        uint256 accrued = p.getUserWeight(alice);
        assertGt(accrued, 0);

        uint256 before = asset.balanceOf(alice);
        uint256 receiverBefore = asset.balanceOf(V2_PENALTY_RECEIVER);
        vm.expectEmit(address(book));
        emit V3BonusVault.BonusForfeited(alice, 50e18);
        vm.expectEmit(address(p));
        emit WeightedStakingPoolV3.Withdrawn(alice, AMOUNT, accrued, 0);
        vm.prank(alice);
        p.withdraw(AMOUNT, 0, 0, "");

        assertEq(asset.balanceOf(alice) - before, AMOUNT, "the principal in full");
        assertEq(asset.balanceOf(V2_PENALTY_RECEIVER), receiverBefore, "nothing to a penalty receiver");
        assertEq(asset.balanceOf(address(p)), 0, "nothing kept by the pool");
        assertEq(p.totalPenalized(), 0);
        (uint256 reserved,) = book.reservedOf(alice);
        assertEq(reserved, 0, "the whole reservation is forfeited");
        assertEq(p.totalForfeitedWeight(), accrued, "the accrued weight is forfeited");
        assertEq(p.getUserWeight(alice), 0);
        assertEq(p.getUserMultiplier(alice), 0, "a full exit clears the multiplier");
    }

    function test_Withdraw_PartialDuringTheActivePeriodForfeitsTheShareOnly() public {
        _stake(alice, AMOUNT, 1000);
        vm.warp(start + 10 days);
        uint256 before = asset.balanceOf(alice);
        vm.prank(alice);
        p.withdraw(AMOUNT / 4, 0, 0, "");
        assertEq(asset.balanceOf(alice) - before, AMOUNT / 4, "the withdrawn share in full");
        assertEq(asset.balanceOf(V2_PENALTY_RECEIVER), 0);
        assertEq(p.totalStaked(), AMOUNT - AMOUNT / 4);
        assertGt(p.totalForfeitedWeight(), 0);
        assertGt(p.getUserWeight(alice), 0, "the kept share keeps its weight");
    }

    function test_Withdraw_ASignedWithdrawKeepsTheAttestedWeight() public {
        _stake(alice, AMOUNT, 1800);
        bytes memory sig = _signWithdraw(p, alice, AMOUNT / 4, 1600, FAR_DEADLINE);
        vm.prank(alice);
        p.withdraw(AMOUNT / 4, 1600, FAR_DEADLINE, sig);
        assertEq(p.getUserMultiplier(alice), 1600);
    }

    function test_Withdraw_WithoutABonusVaultStillWorks() public {
        p.setBonusVault(address(0));
        _stake(alice, AMOUNT, 1000);
        vm.prank(alice);
        p.withdraw(AMOUNT, 0, 0, "");
        assertEq(p.totalStaked(), 0);
    }

    function test_Withdraw_Rejections() public {
        vm.startPrank(alice);
        vm.expectRevert(bytes("Amount must be > 0"));
        p.withdraw(0, 0, 0, "");
        vm.expectRevert(bytes("Nothing to withdraw"));
        p.withdraw(1, 0, 0, "");
        vm.stopPrank();
        _stake(alice, AMOUNT, 1000);
        vm.prank(alice);
        vm.expectRevert(bytes("Amount exceeds stake"));
        p.withdraw(AMOUNT + 1, 0, 0, "");
        vm.warp(end);
        vm.prank(alice);
        vm.expectRevert(bytes("Use unstake after pool ends"));
        p.withdraw(1, 0, 0, "");
    }

    // ──────────────────────── updateWeight ─────────────────────

    function test_UpdateWeight_ChecksAndApplies() public {
        vm.prank(alice);
        vm.expectRevert(bytes("Nothing staked"));
        p.updateWeight(1500, FAR_DEADLINE, "");
        _stake(alice, AMOUNT, 1000);
        bytes memory sig = _signUpdateWeight(p, alice, AMOUNT, 1900, FAR_DEADLINE);
        vm.prank(alice);
        p.updateWeight(1900, FAR_DEADLINE, sig);
        assertEq(p.getUserMultiplier(alice), 1900);
        vm.warp(end);
        vm.prank(alice);
        vm.expectRevert(bytes("Pool has ended"));
        p.updateWeight(1900, FAR_DEADLINE, sig);
    }

    // ──────────────────────── After the end ────────────────────

    function test_Unstake_RevertsUnfundedAsInV2AndEmergencyUnstakeExits() public {
        _stakeFor(alice, AMOUNT, 1500);
        vm.prank(alice);
        vm.expectRevert(bytes("Pool not ended yet"));
        p.unstake();
        vm.prank(alice);
        vm.expectRevert(bytes("Pool not ended yet"));
        p.emergencyUnstake();

        vm.warp(end);
        vm.prank(alice);
        vm.expectRevert(bytes("Rewards not funded"));
        p.unstake();

        uint256 before = asset.balanceOf(alice);
        vm.prank(alice);
        p.emergencyUnstake();
        assertEq(asset.balanceOf(alice) - before, AMOUNT, "the whole stake, no penalty");
        vm.prank(alice);
        vm.expectRevert(bytes("Nothing to unstake"));
        p.emergencyUnstake();
    }

    // ──────────────────────── Rewards waived (the v3 campaign) ─

    function _waivedPool() internal returns (WeightedStakingPoolV3 w) {
        w = _deployPoolV3(address(asset), address(usdcToken), start, end, true);
        w.setMigrator(carol);
        vm.prank(carol);
        asset.approve(address(w), type(uint256).max);
    }

    function test_Waived_InitializeRecordsAndAnnouncesTheFlag() public {
        WeightedStakingPoolV3 impl = new WeightedStakingPoolV3();
        vm.expectEmit();
        emit WeightedStakingPoolV3.RewardsWaivedSet(true);
        WeightedStakingPoolV3 w = WeightedStakingPoolV3(
            address(
                new LPProxy(
                    address(impl),
                    abi.encodeCall(
                        WeightedStakingPoolV3.initialize,
                        (address(this), address(asset), address(usdcToken), start, end, voucherSigner, true)
                    )
                )
            )
        );
        assertTrue(w.rewardsWaived());
    }

    function test_Waived_UnstakeAfterTheEndPaysThePrincipalWithZeroUsdc() public {
        WeightedStakingPoolV3 w = _waivedPool();
        vm.prank(carol);
        w.stakeFor(alice, AMOUNT, 1500);
        vm.warp(end);

        uint256 assetBefore = asset.balanceOf(alice);
        uint256 usdcBefore = usdcToken.balanceOf(alice);
        uint256 userWeight = w.getUserWeight(alice);
        uint256 total = w.getTotalEffectiveWeight();
        vm.expectEmit(address(w));
        emit WeightedStakingPoolV3.Unstaked(alice, AMOUNT, 0, 0, userWeight, total);
        vm.prank(alice);
        uint256 reward = w.unstake();

        assertEq(reward, 0);
        assertEq(asset.balanceOf(alice) - assetBefore, AMOUNT, "the whole principal");
        assertEq(usdcToken.balanceOf(alice), usdcBefore, "no USDC");
        assertEq(w.totalStaked(), 0);
        vm.prank(alice);
        vm.expectRevert(bytes("Nothing to unstake"));
        w.unstake();
    }

    function test_Waived_AddRewardsReverts() public {
        WeightedStakingPoolV3 w = _waivedPool();
        usdcToken.approve(address(w), type(uint256).max);
        vm.expectRevert(bytes("Rewards waived"));
        w.addRewards(1_000e6);
        assertEq(w.totalRewards(), 0);
    }

    function test_NotWaived_UnstakeStillRevertsRewardsNotFunded() public {
        assertFalse(p.rewardsWaived());
        _stakeFor(alice, AMOUNT, 1500);
        vm.warp(end);
        vm.prank(alice);
        vm.expectRevert(bytes("Rewards not funded"));
        p.unstake();
    }

    function test_Unstake_WhenFundedPaysStakeAndReward() public {
        _stake(alice, AMOUNT, 1000);
        _stakeFor(bob, AMOUNT, 1000);
        p.addRewards(1_000e6);
        vm.warp(end);
        assertApproxEqAbs(p.getPendingReward(alice), 500e6, 1);
        assertEq(p.getUserWeight(alice), AMOUNT * 1000 * 30 days);
        assertEq(p.getTotalEffectiveWeight(), 2 * AMOUNT * 1000 * 30 days);

        uint256 usdcBefore = usdcToken.balanceOf(alice);
        vm.prank(alice);
        uint256 reward = p.unstake();
        assertEq(reward, 500e6);
        assertEq(p.totalRewards(), 1_000e6);
        assertEq(usdcToken.balanceOf(alice) - usdcBefore, 500e6);
        assertEq(p.claimedRewards(alice), 500e6);
        assertEq(p.totalRewardsClaimed(), 500e6);
        vm.prank(alice);
        vm.expectRevert(bytes("Nothing to unstake"));
        p.unstake();
    }

    function test_Views_BeforeAnythingIsStaked() public view {
        assertEq(p.getPendingReward(alice), 0);
        assertEq(p.getUserWeight(alice), 0);
        assertEq(p.totalAccumulatedWeight(), 0);
    }

    // ──────────────────────── Owner functions ──────────────────

    function test_Owner_SettersAndRecoveries() public {
        vm.expectRevert(bytes("Invalid signer"));
        p.setSigner(address(0));
        vm.expectEmit(address(p));
        emit WeightedStakingPoolV3.SignerChanged(voucherSigner, bob);
        p.setSigner(bob);
        vm.expectEmit(address(p));
        emit WeightedStakingPoolV3.MigratorSet(carol, bob);
        p.setMigrator(bob);
        vm.expectEmit(address(p));
        emit WeightedStakingPoolV3.BonusVaultSet(address(book), bob);
        p.setBonusVault(bob);

        vm.expectRevert(bytes("Amount must be > 0"));
        p.addRewards(0);

        MockERC20Permit stray = new MockERC20Permit("Stray", "STR", 1e24, 18);
        stray.transfer(address(p), 5e18);
        p.recoverERC20(address(stray), 5e18);
        assertEq(stray.balanceOf(address(this)), 1e24);
        vm.expectRevert(bytes("Cannot recover staking token"));
        p.recoverERC20(address(asset), 1);
        vm.expectRevert(bytes("Cannot recover reward token"));
        p.recoverERC20(address(usdcToken), 1);

        vm.startPrank(stranger);
        bytes memory unauthorized = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger);
        vm.expectRevert(unauthorized);
        p.setSigner(bob);
        vm.expectRevert(unauthorized);
        p.setMigrator(bob);
        vm.expectRevert(unauthorized);
        p.setBonusVault(bob);
        vm.expectRevert(unauthorized);
        p.addRewards(1);
        vm.expectRevert(unauthorized);
        p.recoverERC20(address(stray), 1);
        vm.expectRevert(unauthorized);
        p.recoverExcessRewards();
        vm.stopPrank();
    }

    function test_RecoverExcessRewards_BothArms() public {
        vm.expectRevert(bytes("Pool not ended yet"));
        p.recoverExcessRewards();

        // Nobody staked: everything is recoverable.
        p.addRewards(100e6);
        vm.warp(end);
        uint256 before = usdcToken.balanceOf(address(this));
        p.recoverExcessRewards();
        assertEq(usdcToken.balanceOf(address(this)) - before, 100e6);
        vm.expectRevert(bytes("Nothing to recover"));
        p.recoverExcessRewards();
    }

    function test_RecoverExcessRewards_KeepsWhatIsOwed() public {
        _stake(alice, AMOUNT, 1000);
        p.addRewards(100e6);
        usdcToken.transfer(address(p), 7e6); // an over-funding
        vm.warp(end);
        uint256 before = usdcToken.balanceOf(address(this));
        p.recoverExcessRewards();
        assertEq(usdcToken.balanceOf(address(this)) - before, 7e6);
        vm.expectRevert(bytes("Nothing to recover"));
        p.recoverExcessRewards();
    }

    function test_Owner_RenounceDisabledUpgradeOwnerOnly() public {
        vm.expectRevert(WeightedStakingPoolV3.RenounceDisabled.selector);
        p.renounceOwnership();
        WeightedStakingPoolV3 impl = new WeightedStakingPoolV3();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        p.upgradeToAndCall(address(impl), "");
        _stake(alice, AMOUNT, 1000);
        p.upgradeToAndCall(address(impl), "");
        assertEq(p.totalStaked(), AMOUNT, "state survives");
    }

    function test_Owner_TwoStepHandover() public {
        p.transferOwnership(bob);
        assertEq(p.owner(), address(this));
        vm.prank(bob);
        p.acceptOwnership();
        assertEq(p.owner(), bob);
    }

    function test_Storage_TheNamespaceIsPinned() public view {
        bytes32 slot = keccak256(abi.encode(uint256(keccak256("real.staking.storage.WeightedStakingPoolV3")) - 1))
            & ~bytes32(uint256(0xff));
        assertEq(slot, 0x2e7bda785777e966e24cba868272f146b3d9453f434083da348fd5d42a7a6e00);
        assertEq(address(uint160(uint256(vm.load(address(p), slot)))), address(asset));
    }
}
