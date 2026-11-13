// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {StakingV3Harness} from "../utils/StakingV3Harness.sol";
import {WeightedStakingPoolV3} from "../../../contracts/staking-v3/WeightedStakingPoolV3.sol";
import {
    WeightedStakingPoolV3WeightedMock
} from "../../../contracts/lp-staking/mocks/WeightedStakingPoolV3WeightedMock.sol";
import {V3BonusVault} from "../../../contracts/staking-v3/V3BonusVault.sol";
import {LPProxy} from "../../../contracts/lp-staking/deploy/LPProxy.sol";
import {MockERC20Permit} from "../../../contracts/lp-staking/mocks/MockERC20Permit.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {WeightedStakingPoolV3At5b1174c} from "../utils/WeightedStakingPoolV3At5b1174c.sol";
import {V3BonusVaultAt5b1174c} from "../utils/V3BonusVaultAt5b1174c.sol";
import {StakingMigrator} from "../../../contracts/staking-v3/StakingMigrator.sol";

/**
 * @notice {WeightedStakingPoolV3}: the minimal v3 pool of 2026-11-10. A direct `stake` behind the
 *         backend's `StakeVoucher` (no weight), the migrator's `stakeFor`, `withdraw` in full with
 *         the fail-closed bonus forfeit, `unstake` / `emergencyUnstake` after the end, the owner
 *         tier, and the storage pins: the namespace, every live member's slot, the deprecated
 *         slots left untouched, and an upgrade from the previous (weighted) implementation.
 *
 *  `p` is a fresh pool whose activation is one day ahead (so a withdrawal both before and during
 *  the window is reachable), with `carol` as its migrator and the harness bonus vault rebuilt
 *  around it (`book`, migrator `carol`), so a forfeiture is visible end to end.
 */
contract WeightedStakingPoolV3Test is StakingV3Harness {
    WeightedStakingPoolV3 internal p;
    V3BonusVault internal book;
    uint256 internal start;
    uint256 internal end;

    uint256 internal constant AMOUNT = 1_000e18;
    bytes32 internal constant NS = 0x2e7bda785777e966e24cba868272f146b3d9453f434083da348fd5d42a7a6e00;

    function setUp() public {
        _deployStakingV3();
        start = block.timestamp + 1 days;
        end = start + 30 days;
        p = _deployPoolV3(address(asset), start, end);
        book = _deployBonusVault(address(asset), carol, address(p), address(0));
        p.setMigrator(carol);
        p.setBonusVault(address(book));

        vm.prank(alice);
        asset.approve(address(p), type(uint256).max);
        vm.prank(bob);
        asset.approve(address(p), type(uint256).max);
        vm.prank(carol);
        asset.approve(address(p), type(uint256).max);
    }

    function _stake(address user, uint256 amount) internal {
        bytes memory sig = _signStake(p, user, FAR_DEADLINE);
        vm.prank(user);
        p.stake(amount, FAR_DEADLINE, sig);
    }

    function _stakeFor(address user, uint256 amount) internal {
        vm.prank(carol);
        p.stakeFor(user, amount);
    }

    // ──────────────────────── Initialization ───────────────────

    function test_Initialize_RecordsTheConfiguration() public {
        assertEq(p.stakingToken(), address(asset));
        assertEq(p.activationEpoch(), start);
        assertEq(p.endEpoch(), end);
        assertEq(p.signer(), voucherSigner);
        assertEq(p.owner(), address(this));
        assertEq(p.migrator(), carol);
        assertEq(p.bonusVault(), address(book));
        assertEq(p.totalStaked(), 0);
        assertEq(p.STAKE_VOUCHER_TYPEHASH(), keccak256("StakeVoucher(address user,uint256 nonce,uint256 deadline)"));

        WeightedStakingPoolV3 impl = new WeightedStakingPoolV3();
        vm.expectEmit();
        emit WeightedStakingPoolV3.PoolInitialized(address(asset), start, end, voucherSigner);
        vm.expectEmit();
        emit WeightedStakingPoolV3.SignerChanged(address(0), voucherSigner);
        new LPProxy(
            address(impl),
            abi.encodeCall(WeightedStakingPoolV3.initialize, (address(this), address(asset), start, end, voucherSigner))
        );
    }

    function test_Abi_TheWeightRewardAndPenaltySurfaceIsGone() public view {
        string[24] memory gone = [
            "BASE_WEIGHT()",
            "MAX_WEIGHT()",
            "BPS_DENOMINATOR()",
            "STAKE_TYPEHASH()",
            "WITHDRAW_TYPEHASH()",
            "UPDATE_WEIGHT_TYPEHASH()",
            "rewardToken()",
            "poolDuration()",
            "rewardsWaived()",
            "totalWeightedStaked()",
            "totalAccumulatedWeight()",
            "totalForfeitedWeight()",
            "globalLastUpdateTime()",
            "totalRewards()",
            "totalRewardsClaimed()",
            "totalPenalized()",
            "claimedRewards(address)",
            "getUserWeight(address)",
            "getUserMultiplier(address)",
            "getTotalEffectiveWeight()",
            "getPendingReward(address)",
            "recoverExcessRewards()",
            "addRewards(uint256)",
            "updateWeight(uint256,uint256,bytes)"
        ];
        for (uint256 i = 0; i < gone.length; i++) {
            (bool ok,) = address(p).staticcall(abi.encodeWithSignature(gone[i], alice));
            assertFalse(ok, gone[i]);
        }
        // The v2-shaped entry points with a weight are gone too.
        (bool okStake,) = address(p)
            .staticcall(abi.encodeWithSignature("stake(uint256,uint256,uint256,bytes)", AMOUNT, 1500, FAR_DEADLINE, ""));
        assertFalse(okStake);
        (bool okFor,) =
            address(p).staticcall(abi.encodeWithSignature("stakeFor(address,uint256,uint256)", alice, AMOUNT, 1500));
        assertFalse(okFor);
        (bool okWithdraw,) =
            address(p).staticcall(abi.encodeWithSignature("withdraw(uint256,uint256,uint256,bytes)", AMOUNT, 0, 0, ""));
        assertFalse(okWithdraw);
    }

    function test_Initialize_ValidatesEveryArgument() public {
        WeightedStakingPoolV3 impl = new WeightedStakingPoolV3();
        _expectInitRevert(impl, address(0), start, end, voucherSigner, "Invalid staking token");
        _expectInitRevert(impl, address(asset), end, end, voucherSigner, "End must be after activation");
        _expectInitRevert(impl, address(asset), start, end, address(0), "Invalid signer");
    }

    function _expectInitRevert(
        WeightedStakingPoolV3 impl,
        address staking,
        uint256 s,
        uint256 e,
        address signer_,
        bytes memory reason
    ) internal {
        vm.expectRevert(reason);
        new LPProxy(
            address(impl), abi.encodeCall(WeightedStakingPoolV3.initialize, (address(this), staking, s, e, signer_))
        );
    }

    function test_Initialize_ImplementationIsLocked() public {
        WeightedStakingPoolV3 impl = new WeightedStakingPoolV3();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(address(this), address(asset), start, end, voucherSigner);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        p.initialize(address(this), address(asset), start, end, voucherSigner);
    }

    // ──────────────────────── stake (the StakeVoucher) ─────────

    function test_Stake_WithAValidVoucher() public {
        bytes memory sig = _signStake(p, alice, FAR_DEADLINE);
        uint256 before = asset.balanceOf(alice);
        vm.expectEmit(address(p));
        emit WeightedStakingPoolV3.NonceUsed(alice, 0);
        vm.expectEmit(address(p));
        emit WeightedStakingPoolV3.Staked(alice, AMOUNT);
        vm.prank(alice);
        p.stake(AMOUNT, FAR_DEADLINE, sig);

        assertEq(p.stakes(alice), AMOUNT);
        assertEq(p.totalStaked(), AMOUNT);
        assertEq(p.nonces(alice), 1);
        assertEq(before - asset.balanceOf(alice), AMOUNT);
        assertEq(asset.balanceOf(address(p)), AMOUNT);
    }

    function test_Stake_TheVoucherCarriesNoAmount() public {
        // One voucher per call, any amount: the second stake needs a voucher over the next nonce.
        _stake(alice, 1);
        _stake(alice, AMOUNT);
        assertEq(p.stakes(alice), AMOUNT + 1);
        assertEq(p.nonces(alice), 2);
    }

    function test_Stake_AReplayedVoucherFails() public {
        bytes memory sig = _signStake(p, alice, FAR_DEADLINE);
        vm.startPrank(alice);
        p.stake(AMOUNT, FAR_DEADLINE, sig);
        vm.expectRevert(bytes("Invalid signature"));
        p.stake(AMOUNT, FAR_DEADLINE, sig);
        vm.stopPrank();
        assertEq(p.nonces(alice), 1, "a failed call spends no nonce");
    }

    function test_Stake_AVoucherForAFutureNonceFails() public {
        bytes memory sig = _signStakeAt(p, voucherSignerPk, alice, 1, FAR_DEADLINE);
        vm.prank(alice);
        vm.expectRevert(bytes("Invalid signature"));
        p.stake(AMOUNT, FAR_DEADLINE, sig);
    }

    function test_Stake_AnotherUsersVoucherFails() public {
        bytes memory sig = _signStake(p, alice, FAR_DEADLINE);
        vm.prank(bob);
        vm.expectRevert(bytes("Invalid signature"));
        p.stake(AMOUNT, FAR_DEADLINE, sig);
    }

    function test_Stake_AStrangersSignatureFails() public {
        bytes memory sig = _signStakeAt(p, alicePk, alice, 0, FAR_DEADLINE);
        vm.prank(alice);
        vm.expectRevert(bytes("Invalid signature"));
        p.stake(AMOUNT, FAR_DEADLINE, sig);
    }

    function test_Stake_AnAlteredDeadlineFails() public {
        bytes memory sig = _signStake(p, alice, FAR_DEADLINE);
        vm.prank(alice);
        vm.expectRevert(bytes("Invalid signature"));
        p.stake(AMOUNT, FAR_DEADLINE - 1, sig);
    }

    function test_Stake_AMalformedSignatureReverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureLength.selector, 2));
        p.stake(AMOUNT, FAR_DEADLINE, hex"1234");
    }

    function test_Stake_ARotatedSignerInvalidatesOldVouchers() public {
        bytes memory sig = _signStake(p, alice, FAR_DEADLINE);
        p.setSigner(bob);
        vm.prank(alice);
        vm.expectRevert(bytes("Invalid signature"));
        p.stake(AMOUNT, FAR_DEADLINE, sig);
    }

    function test_Stake_Rejections() public {
        bytes memory sig = _signStake(p, alice, FAR_DEADLINE);
        vm.startPrank(alice);
        vm.expectRevert(bytes("Amount must be > 0"));
        p.stake(0, FAR_DEADLINE, sig);
        vm.expectRevert(bytes("Signature required"));
        p.stake(AMOUNT, FAR_DEADLINE, "");
        vm.stopPrank();

        bytes memory expiring = _signStake(p, alice, block.timestamp);
        vm.warp(block.timestamp + 1);
        vm.prank(alice);
        vm.expectRevert(bytes("Signature expired"));
        p.stake(AMOUNT, block.timestamp - 1, expiring);

        vm.warp(end);
        vm.prank(alice);
        vm.expectRevert(bytes("Pool has ended"));
        p.stake(AMOUNT, FAR_DEADLINE, sig);
    }

    function test_Stake_AllowedDuringTheWindow() public {
        vm.warp(start + 10 days);
        _stake(alice, AMOUNT);
        assertEq(p.stakes(alice), AMOUNT);
    }

    // ──────────────────────── stakeFor ─────────────────────────

    function test_StakeFor_OnlyTheMigratorPullsFromItAndCreditsTheUser() public {
        uint256 carolBefore = asset.balanceOf(carol);
        vm.expectEmit(address(p));
        emit WeightedStakingPoolV3.Staked(alice, AMOUNT);
        vm.expectEmit(address(p));
        emit WeightedStakingPoolV3.StakedFor(alice, carol, AMOUNT);
        _stakeFor(alice, AMOUNT);
        assertEq(asset.balanceOf(carol), carolBefore - AMOUNT, "pulled from the migrator");
        assertEq(p.stakes(alice), AMOUNT);
        assertEq(p.totalStaked(), AMOUNT);
        assertEq(p.nonces(alice), 0, "no pool nonce is spent");

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(WeightedStakingPoolV3.NotMigrator.selector, stranger, carol));
        p.stakeFor(alice, AMOUNT);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(WeightedStakingPoolV3.NotMigrator.selector, alice, carol));
        p.stakeFor(alice, AMOUNT);
    }

    function test_StakeFor_AddsToADirectStake() public {
        _stake(alice, AMOUNT);
        _stakeFor(alice, AMOUNT);
        assertEq(p.stakes(alice), 2 * AMOUNT);
        assertEq(p.totalStaked(), 2 * AMOUNT);
    }

    function test_StakeFor_Rejections() public {
        vm.startPrank(carol);
        vm.expectRevert(bytes("Invalid user"));
        p.stakeFor(address(0), AMOUNT);
        vm.expectRevert(bytes("Amount must be > 0"));
        p.stakeFor(alice, 0);
        vm.warp(end);
        vm.expectRevert(bytes("Pool has ended"));
        p.stakeFor(alice, AMOUNT);
        vm.stopPrank();
    }

    function test_StakeFor_ClosedWhenTheMigratorIsZero() public {
        p.setMigrator(address(0));
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(WeightedStakingPoolV3.NotMigrator.selector, carol, address(0)));
        p.stakeFor(alice, AMOUNT);
    }

    // ──────────────────────── withdraw ─────────────────────────

    function test_Withdraw_BeforeActivationIsFreeButForfeitsTheBonus() public {
        _stakeFor(alice, AMOUNT);
        vm.prank(carol);
        book.reserve(alice, 50e18, uint64(end), 3);

        uint256 before = asset.balanceOf(alice);
        vm.expectEmit(address(book));
        emit V3BonusVault.BonusForfeited(alice, 50e18);
        vm.expectEmit(address(p));
        emit WeightedStakingPoolV3.Withdrawn(alice, AMOUNT / 2);
        vm.prank(alice);
        p.withdraw(AMOUNT / 2);
        assertEq(asset.balanceOf(alice) - before, AMOUNT / 2, "the principal in full");
        assertEq(p.stakes(alice), AMOUNT / 2);
        (uint256 reserved,) = book.reservedOf(alice);
        assertEq(reserved, 0, "the whole reservation is gone");
    }

    function test_Withdraw_DuringTheWindowReturnsThePrincipalInFull() public {
        _stakeFor(alice, AMOUNT);
        _stake(bob, AMOUNT);
        vm.prank(carol);
        book.reserve(alice, 50e18, uint64(end), 3);
        vm.warp(start + 15 days);

        uint256 before = asset.balanceOf(alice);
        vm.prank(alice);
        p.withdraw(AMOUNT);

        assertEq(asset.balanceOf(alice) - before, AMOUNT, "the principal in full");
        assertEq(asset.balanceOf(address(p)), AMOUNT, "only bob's principal stays");
        assertEq(p.stakes(alice), 0);
        assertEq(p.totalStaked(), AMOUNT);
        (uint256 reserved,) = book.reservedOf(alice);
        assertEq(reserved, 0, "the whole reservation is forfeited");
    }

    function test_Withdraw_PartialKeepsTheRest() public {
        _stake(alice, AMOUNT);
        vm.warp(start + 10 days);
        vm.prank(alice);
        p.withdraw(AMOUNT / 4);
        assertEq(p.stakes(alice), AMOUNT - AMOUNT / 4);
        assertEq(p.totalStaked(), AMOUNT - AMOUNT / 4);
    }

    /// @dev Rule of 2026-11-12: a withdrawal before the end, partial or full, forfeits the v3 part
    ///      AND every active LP part of the user.
    function _withdrawForfeitsBoth(uint256 amount) internal {
        _stakeFor(alice, AMOUNT);
        vm.startPrank(carol);
        book.reserve(alice, 50e18, uint64(end), 2);
        book.reserveLp(7, alice, 80e18, uint64(end));
        book.reserveLp(8, bob, 30e18, uint64(end));
        vm.stopPrank();
        vm.warp(start + 10 days);

        vm.expectEmit(address(book));
        emit V3BonusVault.BonusForfeited(alice, 50e18);
        vm.expectEmit(address(book));
        emit V3BonusVault.LpBonusForfeited(7, alice, 80e18);
        vm.expectEmit(address(p));
        emit WeightedStakingPoolV3.Withdrawn(alice, amount);
        vm.prank(alice);
        p.withdraw(amount);

        (uint256 reserved,) = book.reservedOf(alice);
        assertEq(reserved, 0);
        (, uint256 lp,,, bool forfeited) = book.lpReservation(7);
        assertEq(lp, 0);
        assertTrue(forfeited);
        assertEq(book.totalReserved(), 30e18, "only bob's LP part is left");
        assertEq(book.totalLpReserved(), 30e18);
    }

    function test_Withdraw_PartialForfeitsTheV3AndTheLpPart() public {
        _withdrawForfeitsBoth(AMOUNT / 4);
        assertEq(p.stakes(alice), AMOUNT - AMOUNT / 4);
    }

    function test_Withdraw_FullForfeitsTheV3AndTheLpPart() public {
        _withdrawForfeitsBoth(AMOUNT);
        assertEq(p.stakes(alice), 0);
    }

    /// @dev After the end the pool takes the principal back through `unstake`, which never calls
    ///      the hook: both parts stay owed.
    function test_Unstake_AfterTheEndKeepsTheV3AndTheLpPart() public {
        _stakeFor(alice, AMOUNT);
        vm.startPrank(carol);
        book.reserve(alice, 50e18, uint64(end), 2);
        book.reserveLp(7, alice, 80e18, uint64(end));
        vm.stopPrank();
        vm.warp(end);
        vm.recordLogs();
        vm.prank(alice);
        p.unstake();
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; ++i) {
            assertTrue(logs[i].emitter != address(book), "the bonus vault is not called");
        }
        assertEq(book.totalReserved(), 130e18);
        assertEq(book.totalLpReserved(), 80e18);
    }

    /// @dev A pool like `p` that was never linked to a bonus vault.
    function _unlinkedPool() internal returns (WeightedStakingPoolV3 q) {
        q = _deployPoolV3(address(asset), start, end);
        vm.prank(alice);
        asset.approve(address(q), type(uint256).max);
    }

    function test_Withdraw_AFailingBonusVaultBlocksTheExit() public {
        WeightedStakingPoolV3 q = _unlinkedPool();
        // Staked while unlinked: since 2026-11-12 a linked vault without the hooks would revert the
        // direct stake itself (its new-stake bonus call), so the failing vault is linked after.
        bytes memory sig = _signStake(q, alice, FAR_DEADLINE);
        vm.prank(alice);
        q.stake(AMOUNT, FAR_DEADLINE, sig);
        q.setBonusVault(address(new MockERC20Permit("NoHook", "NH", 0, 18)));
        vm.prank(alice);
        vm.expectRevert();
        q.withdraw(AMOUNT);
        assertEq(q.stakes(alice), AMOUNT, "fail closed: nothing moved");
    }

    function test_Withdraw_WithoutABonusVaultStillWorks() public {
        WeightedStakingPoolV3 q = _unlinkedPool();
        bytes memory sig = _signStake(q, alice, FAR_DEADLINE);
        vm.prank(alice);
        q.stake(AMOUNT, FAR_DEADLINE, sig);
        vm.prank(alice);
        q.withdraw(AMOUNT);
        assertEq(q.totalStaked(), 0);
    }

    function test_Withdraw_Rejections() public {
        vm.startPrank(alice);
        vm.expectRevert(bytes("Amount must be > 0"));
        p.withdraw(0);
        vm.expectRevert(bytes("Nothing to withdraw"));
        p.withdraw(1);
        vm.stopPrank();
        _stake(alice, AMOUNT);
        vm.prank(alice);
        vm.expectRevert(bytes("Amount exceeds stake"));
        p.withdraw(AMOUNT + 1);
        vm.warp(end);
        vm.prank(alice);
        vm.expectRevert(bytes("Use unstake after pool ends"));
        p.withdraw(1);
    }

    // ──────────────────────── After the end ────────────────────

    function test_Unstake_AfterTheEndPaysTheWholePrincipal() public {
        _stakeFor(alice, AMOUNT);
        _stake(alice, AMOUNT);
        vm.prank(carol);
        book.reserve(alice, 50e18, uint64(end), 3);

        vm.prank(alice);
        vm.expectRevert(bytes("Pool not ended yet"));
        p.unstake();

        vm.warp(end);
        uint256 before = asset.balanceOf(alice);
        vm.expectEmit(address(p));
        emit WeightedStakingPoolV3.Unstaked(alice, 2 * AMOUNT);
        vm.prank(alice);
        p.unstake();
        assertEq(asset.balanceOf(alice) - before, 2 * AMOUNT);
        assertEq(p.stakes(alice), 0);
        assertEq(p.totalStaked(), 0);
        (uint256 reserved,) = book.reservedOf(alice);
        // The route bonus of 50 plus the new-stake bonus of the direct stake before the
        // activation (5 % of 1,000, 2026-11-12).
        assertEq(reserved, 50e18 + FULL, "an exit after the end keeps the bonus");

        vm.prank(alice);
        vm.expectRevert(bytes("Nothing to unstake"));
        p.unstake();
    }

    function test_EmergencyUnstake_AfterTheEndPaysTheWholePrincipal() public {
        _stakeFor(alice, AMOUNT);
        vm.prank(alice);
        vm.expectRevert(bytes("Pool not ended yet"));
        p.emergencyUnstake();

        vm.warp(end + 1);
        uint256 before = asset.balanceOf(alice);
        vm.expectEmit(address(p));
        emit WeightedStakingPoolV3.EmergencyUnstaked(alice, AMOUNT);
        vm.prank(alice);
        p.emergencyUnstake();
        assertEq(asset.balanceOf(alice) - before, AMOUNT);
        assertEq(p.totalStaked(), 0);
        vm.prank(alice);
        vm.expectRevert(bytes("Nothing to unstake"));
        p.emergencyUnstake();
        vm.prank(alice);
        vm.expectRevert(bytes("Nothing to unstake"));
        p.unstake();
    }

    // ──────────────────────── The new-stake bonus (2026-11-12) ─

    /// @dev 5 % of 1,000 $ASSET: the full rate.
    uint256 internal constant FULL = 50e18;
    /// @dev 1,000 $ASSET x 5 % x 47 / 90, rounded down (2.61 %).
    uint256 internal constant AT_47_OF_90 = 26_111_111_111_111_111_111;
    /// @dev 1,000 $ASSET x 5 % x 1 / 90, rounded down.
    uint256 internal constant AT_1_OF_90 = 555_555_555_555_555_555;

    /// @dev A fresh 90-day campaign (or any window) with its own bonus vault (migrator `carol`, no
    ///      LP vault) and the approvals of alice, bob and carol.
    function _campaign(uint256 s, uint256 e) internal returns (WeightedStakingPoolV3 q, V3BonusVault b) {
        q = _deployPoolV3(address(asset), s, e);
        b = _deployBonusVault(address(asset), carol, address(q), address(0));
        q.setMigrator(carol);
        q.setBonusVault(address(b));
        vm.prank(alice);
        asset.approve(address(q), type(uint256).max);
        vm.prank(bob);
        asset.approve(address(q), type(uint256).max);
        vm.prank(carol);
        asset.approve(address(q), type(uint256).max);
    }

    function _campaign90() internal returns (WeightedStakingPoolV3 q, V3BonusVault b, uint256 s, uint256 e) {
        s = block.timestamp + 1 days;
        e = s + 90 days;
        (q, b) = _campaign(s, e);
    }

    function _stakeOn(WeightedStakingPoolV3 q, address user, uint256 amount) internal {
        bytes memory sig = _signStake(q, user, FAR_DEADLINE);
        vm.prank(user);
        q.stake(amount, FAR_DEADLINE, sig);
    }

    function _v3Of(V3BonusVault b, address user) internal view returns (uint256 amount) {
        (amount,) = b.reservedOf(user);
    }

    function test_StakeBonus_TheRateConstant() public view {
        assertEq(p.STAKE_BONUS_BPS(), 500);
    }

    function test_StakeBonus_TheFullRateOnTheFirstDay() public {
        (WeightedStakingPoolV3 q, V3BonusVault b, uint256 s, uint256 e) = _campaign90();
        vm.warp(s);
        vm.expectEmit(address(b));
        emit V3BonusVault.BonusReserved(alice, FULL, uint64(e), 4);
        _stakeOn(q, alice, AMOUNT);
        assertEq(_v3Of(b, alice), FULL);
        (, uint64 unlockAt) = b.reservedOf(alice);
        assertEq(unlockAt, uint64(e), "unlocks at the pool's end");
        vm.warp(s + 1 days - 1); // still the first day: 89 days and 1 second left, rounded up
        _stakeOn(q, bob, AMOUNT);
        assertEq(_v3Of(b, bob), FULL);
        assertEq(b.totalReserved(), 2 * FULL);
        assertEq(q.stakes(alice), AMOUNT, "the principal is credited in full");
    }

    function test_StakeBonus_47Of90DaysLeft() public {
        (WeightedStakingPoolV3 q, V3BonusVault b,, uint256 e) = _campaign90();
        vm.warp(e - 47 days);
        _stakeOn(q, alice, AMOUNT);
        assertEq(_v3Of(b, alice), AT_47_OF_90);
        vm.warp(e - 46 days - 1); // 46 days and 23:59:59 left: 47 whole days, rounded up
        _stakeOn(q, bob, AMOUNT);
        assertEq(_v3Of(b, bob), AT_47_OF_90);
    }

    function test_StakeBonus_TheLast24Hours() public {
        (WeightedStakingPoolV3 q, V3BonusVault b,, uint256 e) = _campaign90();
        vm.warp(e - 1 days);
        _stakeOn(q, alice, AMOUNT);
        assertEq(_v3Of(b, alice), AT_1_OF_90);
    }

    function test_StakeBonus_OneSecondBeforeTheEndIsOneDay() public {
        (WeightedStakingPoolV3 q, V3BonusVault b,, uint256 e) = _campaign90();
        vm.warp(e - 1);
        assertEq(q.previewStakeBonus(AMOUNT), AT_1_OF_90);
        _stakeOn(q, alice, AMOUNT);
        assertEq(_v3Of(b, alice), AT_1_OF_90);
        vm.warp(e);
        assertEq(q.previewStakeBonus(AMOUNT), 0, "zero from the end");
    }

    /// @dev 30 days and 1 hour count as 31 campaign days: the first hour pays the full rate, the
    ///      last 12 hours pay 1 / 31.
    function test_StakeBonus_AWindowThatIsNotWholeDays() public {
        uint256 s = block.timestamp + 1 days;
        uint256 e = s + 30 days + 1 hours;
        (WeightedStakingPoolV3 q, V3BonusVault b) = _campaign(s, e);
        vm.warp(s);
        _stakeOn(q, alice, AMOUNT);
        assertEq(_v3Of(b, alice), FULL, "31 of 31 days");
        vm.warp(e - 12 hours);
        _stakeOn(q, bob, AMOUNT);
        assertEq(_v3Of(b, bob), 1_612_903_225_806_451_612, "1,000 x 5 % x 1 / 31, rounded down");
    }

    /// @dev `p` opens one day ahead: 31 days left of a 30-day window, capped at the full rate.
    function test_StakeBonus_BeforeTheActivationIsCappedAtTheFullRate() public {
        assertLt(block.timestamp, start);
        assertEq(p.previewStakeBonus(AMOUNT), FULL);
        _stake(alice, AMOUNT);
        assertEq(_v3Of(book, alice), FULL);
    }

    /// @dev At 1 / 90, 1,799 wei rounds to zero: the stake goes through with no reservation and no
    ///      vault call (which would revert `ZeroAmount`); 1,800 wei earns 1 wei.
    function test_StakeBonus_ATinyAmountRoundsToZeroAndStillStakes() public {
        (WeightedStakingPoolV3 q, V3BonusVault b,, uint256 e) = _campaign90();
        vm.warp(e - 1 hours);
        _stakeOn(q, bob, 1800);
        assertEq(_v3Of(b, bob), 1);
        assertEq(q.previewStakeBonus(1799), 0);
        vm.expectCall(address(b), abi.encodeWithSelector(V3BonusVault.reserveStake.selector), 0);
        _stakeOn(q, alice, 1799);
        assertEq(q.stakes(alice), 1799);
        assertEq(_v3Of(b, alice), 0);
        assertEq(b.totalReserved(), 1);
    }

    function test_StakeBonus_TwoStakesAtDifferentTimesAddUp() public {
        (WeightedStakingPoolV3 q, V3BonusVault b, uint256 s, uint256 e) = _campaign90();
        vm.warp(s);
        _stakeOn(q, alice, AMOUNT);
        vm.warp(e - 47 days);
        _stakeOn(q, alice, AMOUNT);
        (uint256 amount, uint64 unlockAt) = b.reservedOf(alice);
        assertEq(amount, FULL + AT_47_OF_90);
        assertEq(unlockAt, uint64(e));
        assertEq(q.stakes(alice), 2 * AMOUNT);
    }

    function test_StakeBonus_ThePreviewIsWhatTheStakeReserves() public {
        (WeightedStakingPoolV3 q, V3BonusVault b, uint256 s,) = _campaign90();
        vm.warp(s + 10 days + 5 hours);
        uint256 preview = q.previewStakeBonus(777e18 + 3);
        assertEq(preview, Math.mulDiv(777e18 + 3, 500 * 80, 90 * 10_000), "80 of 90 days left");
        _stakeOn(q, alice, 777e18 + 3);
        assertEq(_v3Of(b, alice), preview);
    }

    function test_StakeBonus_StakeForReservesNothingByItself() public {
        (WeightedStakingPoolV3 q, V3BonusVault b, uint256 s,) = _campaign90();
        vm.warp(s);
        vm.expectCall(address(b), abi.encodeWithSelector(V3BonusVault.reserveStake.selector), 0);
        vm.prank(carol);
        q.stakeFor(alice, AMOUNT);
        assertEq(q.stakes(alice), AMOUNT);
        assertEq(_v3Of(b, alice), 0);
    }

    function test_StakeBonus_NoBonusVaultNoBonus() public {
        WeightedStakingPoolV3 q = _unlinkedPool();
        assertEq(q.previewStakeBonus(AMOUNT), 0, "nothing would be reserved");
        bytes memory sig = _signStake(q, alice, FAR_DEADLINE);
        vm.prank(alice);
        q.stake(AMOUNT, FAR_DEADLINE, sig);
        assertEq(q.stakes(alice), AMOUNT);
    }

    /// @dev A pool linked to a bonus vault whose own pool link is another address: the vault
    ///      answers `NotPool` and the direct stake reverts (fail closed). That is the same outcome
    ///      as an early `withdraw` on that pair, and the right one: a stake that cannot record its
    ///      bonus must not go through silently without it.
    function test_StakeBonus_AVaultLinkedToAnotherPoolRevertsTheStake() public {
        WeightedStakingPoolV3 q = _unlinkedPool();
        address other = makeAddr("otherPool");
        V3BonusVault b = _deployBonusVault(address(asset), carol, other, address(0));
        q.setBonusVault(address(b));
        bytes memory sig = _signStake(q, alice, FAR_DEADLINE);
        uint256 before = asset.balanceOf(alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(V3BonusVault.NotPool.selector, address(q), other));
        q.stake(AMOUNT, FAR_DEADLINE, sig);
        assertEq(q.stakes(alice), 0);
        assertEq(asset.balanceOf(alice), before);
    }

    /// @dev No cap (2026-11-12): a very large direct stake reserves its full bonus.
    function test_StakeBonus_AVeryLargeStakeIsNeverRefused() public {
        (WeightedStakingPoolV3 q, V3BonusVault b, uint256 s,) = _campaign90();
        uint256 huge = 1e40;
        deal(address(asset), alice, huge);
        vm.warp(s);
        _stakeOn(q, alice, huge);
        assertEq(q.stakes(alice), huge);
        assertEq(_v3Of(b, alice), huge / 20, "5 % of any amount");
        assertEq(b.totalReserved(), huge / 20);
    }

    /// @dev A mover (route bonus + LP part) who also stakes directly; an early withdraw, partial or
    ///      full, forfeits the direct-stake bonus with the rest.
    function _moverWithADirectStake() internal returns (WeightedStakingPoolV3 q, V3BonusVault b, uint256 e) {
        uint256 s;
        (q, b, s, e) = _campaign90();
        vm.startPrank(carol);
        q.stakeFor(alice, AMOUNT);
        b.reserve(alice, 100e18, uint64(e), 2);
        b.reserveLp(7, alice, 80e18, uint64(e));
        vm.stopPrank();
        vm.warp(s);
        _stakeOn(q, alice, AMOUNT);
        assertEq(_v3Of(b, alice), 100e18 + FULL, "a mover who stakes more gets both");
    }

    function test_StakeBonus_APartialWithdrawForfeitsItWithTheRouteAndTheLpPart() public {
        (WeightedStakingPoolV3 q, V3BonusVault b,) = _moverWithADirectStake();
        vm.expectEmit(address(b));
        emit V3BonusVault.BonusForfeited(alice, 100e18 + FULL);
        vm.expectEmit(address(b));
        emit V3BonusVault.LpBonusForfeited(7, alice, 80e18);
        vm.prank(alice);
        q.withdraw(1);
        assertEq(b.totalReserved(), 0);
        assertEq(b.totalLpReserved(), 0);
    }

    function test_StakeBonus_AFullWithdrawForfeitsItWithTheRouteAndTheLpPart() public {
        (WeightedStakingPoolV3 q, V3BonusVault b,) = _moverWithADirectStake();
        vm.prank(alice);
        q.withdraw(2 * AMOUNT);
        assertEq(_v3Of(b, alice), 0);
        assertEq(b.totalReserved(), 0);
        assertEq(b.totalLpReserved(), 0);
    }

    function test_StakeBonus_PaidAfterTheEndByClaimV3AndByClaim() public {
        (WeightedStakingPoolV3 q, V3BonusVault b, uint256 s, uint256 e) = _campaign90();
        vm.prank(carol);
        q.stakeFor(alice, AMOUNT);
        vm.prank(carol);
        b.reserve(alice, 100e18, uint64(e), 1);
        vm.warp(s);
        _stakeOn(q, alice, AMOUNT);
        vm.warp(e - 47 days);
        _stakeOn(q, bob, AMOUNT);
        asset.approve(address(b), type(uint256).max);
        b.fund(100e18 + FULL + AT_47_OF_90);
        vm.warp(e);
        vm.prank(alice);
        assertEq(b.claimV3(), 100e18 + FULL, "the route bonus and the stake bonus together");
        vm.prank(bob);
        assertEq(b.claim(), AT_47_OF_90);
        assertEq(b.totalReserved(), 0);
    }

    function test_StakeBonus_ARestakeAfterAForfeitingWithdrawEarnsOnlyTheNewBonus() public {
        (WeightedStakingPoolV3 q, V3BonusVault b, uint256 s, uint256 e) = _campaign90();
        vm.warp(s);
        _stakeOn(q, alice, AMOUNT);
        vm.warp(e - 47 days);
        vm.prank(alice);
        q.withdraw(AMOUNT);
        assertEq(_v3Of(b, alice), 0);
        _stakeOn(q, alice, AMOUNT);
        assertEq(_v3Of(b, alice), AT_47_OF_90, "only the new stake at 47 of 90");
        assertEq(b.totalReserved(), AT_47_OF_90);
    }

    /// @dev The pool and the bonus vault on the code live before the new-stake bonus (5b1174c,
    ///      verbatim copies in `test/forge/utils/`), state written, both upgraded: everything stored
    ///      reads the same and a direct stake then reserves the right bonus.
    function test_StakeBonus_UpgradeFromThePreviousPoolAndVault() public {
        uint256 s = block.timestamp + 1 days;
        uint256 e = s + 90 days;
        WeightedStakingPoolV3 q = WeightedStakingPoolV3(
            address(
                new LPProxy(
                    address(new WeightedStakingPoolV3At5b1174c()),
                    abi.encodeCall(
                        WeightedStakingPoolV3At5b1174c.initialize, (address(this), address(asset), s, e, voucherSigner)
                    )
                )
            )
        );
        V3BonusVault b = V3BonusVault(
            address(
                new LPProxy(
                    address(new V3BonusVaultAt5b1174c()),
                    abi.encodeCall(
                        V3BonusVaultAt5b1174c.initialize,
                        (address(this), address(asset), carol, address(q), address(0), OLD_CODE_CAP)
                    )
                )
            )
        );
        q.setMigrator(carol);
        q.setBonusVault(address(b));
        vm.prank(alice);
        asset.approve(address(q), type(uint256).max);
        vm.prank(bob);
        asset.approve(address(q), type(uint256).max);
        vm.prank(carol);
        asset.approve(address(q), type(uint256).max);

        vm.startPrank(carol);
        q.stakeFor(alice, AMOUNT);
        b.reserve(alice, 100e18, uint64(e), 2);
        b.reserveLp(7, alice, 80e18, uint64(e));
        vm.stopPrank();
        vm.warp(s);
        _stakeOn(q, bob, AMOUNT);
        assertEq(_v3Of(b, bob), 0, "the previous pool reserves no stake bonus");

        q.upgradeToAndCall(address(new WeightedStakingPoolV3()), "");
        b.upgradeToAndCall(address(new V3BonusVault()), "");

        assertEq(q.stakes(alice), AMOUNT);
        assertEq(q.stakes(bob), AMOUNT);
        assertEq(q.totalStaked(), 2 * AMOUNT);
        assertEq(q.nonces(bob), 1);
        assertEq(q.endEpoch(), e);
        assertEq(q.bonusVault(), address(b));
        assertEq(q.migrator(), carol);
        (uint256 v3, uint64 unlockAt) = b.reservedOf(alice);
        assertEq(v3, 100e18);
        assertEq(unlockAt, uint64(e));
        (address lpUser, uint256 lp,,,) = b.lpReservation(7);
        assertEq(lpUser, alice);
        assertEq(lp, 80e18);
        assertEq(b.totalReserved(), 180e18);
        assertEq(b.totalLpReserved(), 80e18);
        assertEq(b.lpTokensOf(alice).length, 1);

        vm.warp(e - 47 days);
        _stakeOn(q, bob, AMOUNT);
        assertEq(_v3Of(b, bob), AT_47_OF_90, "the upgraded pair reserves the stake bonus");
        assertEq(b.totalReserved(), 180e18 + AT_47_OF_90);
    }

    // ──────────────────────── No cap: routes and stakes together ─

    /// @dev No cap (2026-11-12), on the real harness stack: a very large route bonus (route 3,
    ///      `claimRestake`) and a very large direct stake both reserve in full, in either order,
    ///      and `totalReserved` is their sum.
    function test_NoCap_AVeryLargeRouteBonusAndAVeryLargeDirectStakeBothReserve() public {
        uint256 huge = 1e40;
        deal(address(asset), alice, huge);
        deal(address(asset), bob, 2 * huge);
        _approveMigrator(alice);
        vm.prank(bob);
        asset.approve(address(poolV3), type(uint256).max);

        _stakeOn(poolV3, bob, huge);
        StakingMigrator.Voucher memory v = _voucher(migrator, alice, 3, huge, 0, 1);
        vm.prank(alice);
        assertEq(migrator.claimRestake(huge, FAR_DEADLINE, _noPermit(), v), huge / 20, "the route after a stake");
        _stakeOn(poolV3, bob, huge); // and a stake after the route
        assertEq(_v3Of(bonusVault, alice), huge / 20);
        assertEq(_v3Of(bonusVault, bob), huge / 10);
        assertEq(bonusVault.totalReserved(), 3 * huge / 20, "grows without a limit");
    }

    // ──────────────────────── The upgrade order guard ──────────

    /// @dev A pool on the NEW code linked to a bonus vault still on the PREVIOUS code (5b1174c):
    ///      a direct stake that earns a bonus reverts, with EMPTY revert data (the old vault has
    ///      no `reserveStake` and no fallback, so the call fails at its selector dispatch), while
    ///      `stakeFor`, `withdraw`, `unstake` and a direct stake whose bonus rounds to zero keep
    ///      working. Why the pool and the bonus vault are upgraded in one timelock batch.
    function test_UpgradeOrder_ANewPoolOnAnOldVaultRevertsOnlyTheBonusStake() public {
        uint256 s = block.timestamp + 1 days;
        uint256 e = s + 90 days;
        WeightedStakingPoolV3 q = _deployPoolV3(address(asset), s, e);
        V3BonusVault old = V3BonusVault(
            address(
                new LPProxy(
                    address(new V3BonusVaultAt5b1174c()),
                    abi.encodeCall(
                        V3BonusVaultAt5b1174c.initialize,
                        (address(this), address(asset), carol, address(q), address(0), OLD_CODE_CAP)
                    )
                )
            )
        );
        q.setMigrator(carol);
        q.setBonusVault(address(old));
        vm.prank(alice);
        asset.approve(address(q), type(uint256).max);
        vm.prank(bob);
        asset.approve(address(q), type(uint256).max);
        vm.prank(carol);
        asset.approve(address(q), type(uint256).max);
        vm.warp(s);

        bytes memory sig = _signStake(q, alice, FAR_DEADLINE);
        vm.prank(alice);
        vm.expectRevert(bytes(""));
        q.stake(AMOUNT, FAR_DEADLINE, sig);
        assertEq(q.stakes(alice), 0, "the bonus stake reverted whole");

        // A direct stake whose bonus rounds to zero makes no vault call and goes through.
        assertEq(q.previewStakeBonus(1), 0);
        _stakeOn(q, bob, 1);
        assertEq(q.stakes(bob), 1);

        // The migrator's path, the early exit and the exit after the end are unaffected.
        vm.startPrank(carol);
        q.stakeFor(alice, AMOUNT);
        old.reserve(alice, 100e18, uint64(e), 2);
        q.stakeFor(bob, AMOUNT);
        vm.stopPrank();
        vm.prank(alice);
        q.withdraw(AMOUNT / 2);
        (uint256 v3,) = old.reservedOf(alice);
        assertEq(v3, 0, "the old vault still forfeits on an early exit");
        assertEq(q.stakes(alice), AMOUNT / 2);
        vm.warp(e);
        uint256 before = asset.balanceOf(bob);
        vm.prank(bob);
        q.unstake();
        assertEq(asset.balanceOf(bob) - before, AMOUNT + 1);
    }

    // ──────────────────────── Owner functions ──────────────────

    function test_Owner_SettersAndRecovery() public {
        vm.expectRevert(bytes("Invalid signer"));
        p.setSigner(address(0));
        vm.expectEmit(address(p));
        emit WeightedStakingPoolV3.SignerChanged(voucherSigner, bob);
        p.setSigner(bob);
        assertEq(p.signer(), bob);
        vm.expectEmit(address(p));
        emit WeightedStakingPoolV3.MigratorSet(carol, bob);
        p.setMigrator(bob);
        MockERC20Permit stray = new MockERC20Permit("Stray", "STR", 1e24, 18);
        stray.transfer(address(p), 5e18);
        p.recoverERC20(address(stray), 5e18);
        assertEq(stray.balanceOf(address(this)), 1e24);
        // USDC (the v2 reward token) is now an ordinary stray token.
        usdcToken.transfer(address(p), 3e6);
        uint256 usdcBefore = usdcToken.balanceOf(address(this));
        p.recoverERC20(address(usdcToken), 3e6);
        assertEq(usdcToken.balanceOf(address(this)) - usdcBefore, 3e6);
        vm.expectRevert(abi.encodeWithSelector(WeightedStakingPoolV3.SurplusExceeded.selector, 1, 0));
        p.recoverERC20(address(asset), 1);

        vm.startPrank(stranger);
        bytes memory unauthorized = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger);
        vm.expectRevert(unauthorized);
        p.setSigner(bob);
        vm.expectRevert(unauthorized);
        p.setMigrator(bob);
        vm.expectRevert(unauthorized);
        p.setBonusVault(bob);
        vm.expectRevert(unauthorized);
        p.recoverERC20(address(stray), 1);
        vm.stopPrank();
    }

    // ──────────────────────── The bonus vault lock ─────────────

    function test_BonusVault_LockedWhileTheWindowIsOpen() public {
        bytes memory locked =
            abi.encodeWithSelector(WeightedStakingPoolV3.BonusVaultLocked.selector, address(book), end);
        vm.expectRevert(locked);
        p.setBonusVault(address(0));
        vm.expectRevert(locked);
        p.setBonusVault(bob);

        vm.warp(start + 10 days);
        vm.expectRevert(locked);
        p.setBonusVault(address(0));

        vm.warp(end - 1); // the last second of the window
        vm.expectRevert(locked);
        p.setBonusVault(address(0));
        vm.expectRevert(locked);
        p.setBonusVault(bob);

        // Re-setting the same vault is no change and passes.
        vm.expectEmit(address(p));
        emit WeightedStakingPoolV3.BonusVaultSet(address(book), address(book));
        p.setBonusVault(address(book));
        assertEq(p.bonusVault(), address(book));
    }

    function test_BonusVault_FreeFromTheEnd() public {
        vm.warp(end); // the first second after the window
        vm.expectEmit(address(p));
        emit WeightedStakingPoolV3.BonusVaultSet(address(book), bob);
        p.setBonusVault(bob);
        vm.expectEmit(address(p));
        emit WeightedStakingPoolV3.BonusVaultSet(bob, address(0));
        p.setBonusVault(address(0));
        assertEq(p.bonusVault(), address(0));
    }

    function test_BonusVault_LinkingFromZeroIsAlwaysAllowed() public {
        WeightedStakingPoolV3 q = _unlinkedPool();
        vm.warp(start + 1 days);
        vm.expectEmit(address(q));
        emit WeightedStakingPoolV3.BonusVaultSet(address(0), address(book));
        q.setBonusVault(address(book));
        vm.expectRevert(abi.encodeWithSelector(WeightedStakingPoolV3.BonusVaultLocked.selector, address(book), end));
        q.setBonusVault(address(0));
    }

    // ──────────────────────── recoverERC20 surplus ─────────────

    function test_Recover_StrayAssetUpToTheSurplusNeverBelowTotalStaked() public {
        _stake(alice, AMOUNT);
        _stakeFor(bob, 2 * AMOUNT);
        asset.transfer(address(p), 7e18); // a plain transfer, not a stake

        vm.expectRevert(abi.encodeWithSelector(WeightedStakingPoolV3.SurplusExceeded.selector, 7e18 + 1, 7e18));
        p.recoverERC20(address(asset), 7e18 + 1);

        uint256 before = asset.balanceOf(address(this));
        p.recoverERC20(address(asset), 3e18);
        p.recoverERC20(address(asset), 4e18);
        assertEq(asset.balanceOf(address(this)) - before, 7e18);
        assertEq(asset.balanceOf(address(p)), p.totalStaked(), "exactly the principals stay");

        vm.expectRevert(abi.encodeWithSelector(WeightedStakingPoolV3.SurplusExceeded.selector, 1, 0));
        p.recoverERC20(address(asset), 1);

        // Every staker still exits in full after the recovery.
        vm.warp(end);
        vm.prank(alice);
        p.unstake();
        vm.prank(bob);
        p.unstake();
        assertEq(asset.balanceOf(address(p)), 0);
    }

    function test_Recover_ZeroAssetIsAllowedWithNoSurplus() public {
        _stake(alice, AMOUNT);
        p.recoverERC20(address(asset), 0);
        assertEq(asset.balanceOf(address(p)), AMOUNT);
    }

    /// @dev A proxy that still holds a USDC balance from the v2-era reward slot (the previous
    ///      implementation refused to recover it) gives it back after the upgrade.
    function test_Recover_TheV2EraUsdcBalanceAfterTheUpgrade() public {
        WeightedStakingPoolV3WeightedMock oldImpl = new WeightedStakingPoolV3WeightedMock();
        WeightedStakingPoolV3WeightedMock old = WeightedStakingPoolV3WeightedMock(
            address(
                new LPProxy(
                    address(oldImpl),
                    abi.encodeCall(
                        WeightedStakingPoolV3WeightedMock.initialize,
                        (address(this), address(asset), address(usdcToken), start, end, voucherSigner, false)
                    )
                )
            )
        );
        usdcToken.approve(address(old), type(uint256).max);
        old.addRewards(250e6);
        vm.expectRevert(bytes("Cannot recover reward token"));
        old.recoverERC20(address(usdcToken), 250e6);

        old.upgradeToAndCall(address(new WeightedStakingPoolV3()), "");
        WeightedStakingPoolV3 upgraded = WeightedStakingPoolV3(address(old));
        uint256 before = usdcToken.balanceOf(address(this));
        upgraded.recoverERC20(address(usdcToken), 250e6);
        assertEq(usdcToken.balanceOf(address(this)) - before, 250e6);
        assertEq(usdcToken.balanceOf(address(upgraded)), 0);
    }

    function test_Owner_RenounceDisabledUpgradeOwnerOnly() public {
        vm.expectRevert(WeightedStakingPoolV3.RenounceDisabled.selector);
        p.renounceOwnership();
        WeightedStakingPoolV3 impl = new WeightedStakingPoolV3();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        p.upgradeToAndCall(address(impl), "");
        _stake(alice, AMOUNT);
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

    // ──────────────────────── Storage pins ─────────────────────

    function _slot(uint256 offset) internal pure returns (bytes32) {
        return bytes32(uint256(NS) + offset);
    }

    function _mapSlot(address key, uint256 offset) internal pure returns (bytes32) {
        return keccak256(abi.encode(key, _slot(offset)));
    }

    function test_Storage_TheNamespaceIsPinned() public view {
        bytes32 slot = keccak256(abi.encode(uint256(keccak256("real.staking.storage.WeightedStakingPoolV3")) - 1))
            & ~bytes32(uint256(0xff));
        assertEq(slot, NS);
    }

    /// @dev The v2-shaped layout of the live stack #6 proxy, member by member: stakingToken 0,
    ///      rewardToken 1, activationEpoch 2, endEpoch 3, poolDuration 4, signer 5, totalStaked 6,
    ///      totalWeightedStaked 7, totalAccumulatedWeight 8, totalForfeitedWeight 9,
    ///      globalLastUpdateTime 10, totalRewards 11, totalRewardsClaimed 12, totalPenalized 13,
    ///      stakes 14 (StakeInfo: amount +0, weight +1, accumulatedWeight +2, lastUpdateTime +3),
    ///      claimedRewards 15, nonces 16, migrator 17, bonusVault 18 (bytes 0..19) + rewardsWaived
    ///      18 (byte 20).
    function test_Storage_EveryLiveMemberSitsInItsOldSlot() public {
        _stake(alice, AMOUNT);
        _stakeFor(bob, 2 * AMOUNT);

        assertEq(address(uint160(uint256(vm.load(address(p), _slot(0))))), address(asset), "stakingToken");
        assertEq(uint256(vm.load(address(p), _slot(2))), start, "activationEpoch");
        assertEq(uint256(vm.load(address(p), _slot(3))), end, "endEpoch");
        assertEq(address(uint160(uint256(vm.load(address(p), _slot(5))))), voucherSigner, "signer");
        assertEq(uint256(vm.load(address(p), _slot(6))), 3 * AMOUNT, "totalStaked");
        assertEq(uint256(vm.load(address(p), _mapSlot(alice, 14))), AMOUNT, "stakes[alice].amount");
        assertEq(uint256(vm.load(address(p), _mapSlot(bob, 14))), 2 * AMOUNT, "stakes[bob].amount");
        assertEq(uint256(vm.load(address(p), _mapSlot(alice, 16))), 1, "nonces[alice]");
        assertEq(address(uint160(uint256(vm.load(address(p), _slot(17))))), carol, "migrator");
        bytes32 word18 = vm.load(address(p), _slot(18));
        assertEq(address(uint160(uint256(word18))), address(book), "bonusVault");
        assertEq(uint256(word18) >> 160, 0, "rewardsWaived byte untouched");
    }

    function test_Storage_TheDeprecatedSlotsAreNeverWritten() public {
        uint256[10] memory deprecated = [uint256(1), 4, 7, 8, 9, 10, 11, 12, 13, 15];
        // Run the whole surface once.
        _stake(alice, AMOUNT);
        _stakeFor(alice, AMOUNT);
        vm.warp(start + 1 days);
        vm.prank(alice);
        p.withdraw(AMOUNT / 2);
        vm.warp(end);
        vm.prank(alice);
        p.unstake();
        _stakeForBeforeEnd();

        for (uint256 i = 0; i < 10; i++) {
            assertEq(vm.load(address(p), _slot(deprecated[i])), bytes32(0), "a deprecated pool slot was written");
        }
        bytes32 info = _mapSlot(alice, 14);
        for (uint256 j = 1; j < 4; j++) {
            assertEq(vm.load(address(p), bytes32(uint256(info) + j)), bytes32(0), "a deprecated StakeInfo slot");
        }
        assertEq(vm.load(address(p), _mapSlot(alice, 15)), bytes32(0), "claimedRewards[alice]");
    }

    /// @dev A second pool whose window is still open, to exercise `emergencyUnstake` on the same pins.
    function _stakeForBeforeEnd() internal {
        WeightedStakingPoolV3 q = _deployPoolV3(address(asset), block.timestamp, block.timestamp + 1 days);
        q.setMigrator(carol);
        vm.prank(carol);
        asset.approve(address(q), type(uint256).max);
        vm.prank(carol);
        q.stakeFor(alice, AMOUNT);
        vm.warp(block.timestamp + 1 days);
        vm.prank(alice);
        q.emergencyUnstake();
        uint256[10] memory deprecated = [uint256(1), 4, 7, 8, 9, 10, 11, 12, 13, 15];
        for (uint256 i = 0; i < 10; i++) {
            assertEq(vm.load(address(q), _slot(deprecated[i])), bytes32(0), "emergencyUnstake wrote a deprecated slot");
        }
    }

    /// @dev Leftovers of the previous implementation (as on stack #6) change nothing.
    function test_Storage_DirtyDeprecatedSlotsAreIgnored() public {
        _stake(alice, AMOUNT);
        for (uint256 i = 7; i <= 13; i++) {
            vm.store(address(p), _slot(i), bytes32(uint256(123_456e18)));
        }
        bytes32 info = _mapSlot(alice, 14);
        vm.store(address(p), bytes32(uint256(info) + 1), bytes32(uint256(2000)));
        vm.store(address(p), bytes32(uint256(info) + 2), bytes32(type(uint256).max));
        vm.store(address(p), _slot(18), vm.load(address(p), _slot(18)) | bytes32(uint256(1) << 160)); // rewardsWaived

        assertEq(p.stakes(alice), AMOUNT);
        assertEq(p.bonusVault(), address(book));
        vm.warp(end);
        uint256 before = asset.balanceOf(alice);
        vm.prank(alice);
        p.unstake();
        assertEq(asset.balanceOf(alice) - before, AMOUNT);
        assertEq(uint256(vm.load(address(p), bytes32(uint256(info) + 1))), 2000, "left as found");
    }

    /// @dev The stack #6 path: a proxy running the PREVIOUS (weighted) implementation, with a
    ///      direct weighted stake and a migrator stake, upgraded with `upgradeToAndCall(impl, 0x)`.
    function test_Storage_UpgradeFromThePreviousImplementationKeepsThePrincipal() public {
        WeightedStakingPoolV3WeightedMock oldImpl = new WeightedStakingPoolV3WeightedMock();
        WeightedStakingPoolV3WeightedMock old = WeightedStakingPoolV3WeightedMock(
            address(
                new LPProxy(
                    address(oldImpl),
                    abi.encodeCall(
                        WeightedStakingPoolV3WeightedMock.initialize,
                        (address(this), address(asset), address(usdcToken), start, end, voucherSigner, true)
                    )
                )
            )
        );
        V3BonusVault oldBook = _deployBonusVault(address(asset), carol, address(old), address(0));
        old.setMigrator(carol);
        old.setBonusVault(address(oldBook));
        vm.prank(alice);
        asset.approve(address(old), type(uint256).max);
        vm.prank(carol);
        asset.approve(address(old), type(uint256).max);

        bytes32 structHash = keccak256(abi.encode(old.STAKE_TYPEHASH(), alice, AMOUNT, uint256(1500), 0, FAR_DEADLINE));
        bytes memory sig = _signPoolDigest(WeightedStakingPoolV3(address(old)), voucherSignerPk, structHash);
        vm.prank(alice);
        old.stake(AMOUNT, 1500, FAR_DEADLINE, sig);
        vm.prank(carol);
        old.stakeFor(bob, 2 * AMOUNT, 1200);
        vm.warp(start + 5 days);

        old.upgradeToAndCall(address(new WeightedStakingPoolV3()), "");
        WeightedStakingPoolV3 upgraded = WeightedStakingPoolV3(address(old));

        assertEq(upgraded.stakingToken(), address(asset));
        assertEq(upgraded.activationEpoch(), start);
        assertEq(upgraded.endEpoch(), end);
        assertEq(upgraded.signer(), voucherSigner);
        assertEq(upgraded.migrator(), carol);
        assertEq(upgraded.bonusVault(), address(oldBook));
        assertEq(upgraded.owner(), address(this));
        assertEq(upgraded.stakes(alice), AMOUNT);
        assertEq(upgraded.stakes(bob), 2 * AMOUNT);
        assertEq(upgraded.totalStaked(), 3 * AMOUNT);
        assertEq(upgraded.nonces(alice), 1, "the nonce sequence continues");

        // The same EIP-712 domain: a StakeVoucher over the next nonce works on the upgraded proxy.
        bytes memory next = _signStake(upgraded, alice, FAR_DEADLINE);
        vm.prank(alice);
        upgraded.stake(AMOUNT, FAR_DEADLINE, next);
        assertEq(upgraded.stakes(alice), 2 * AMOUNT);
        vm.prank(carol);
        upgraded.stakeFor(bob, AMOUNT);

        vm.prank(carol);
        oldBook.reserve(bob, 30e18, uint64(end), 3);
        uint256 before = asset.balanceOf(bob);
        vm.expectEmit(address(oldBook));
        emit V3BonusVault.BonusForfeited(bob, 30e18);
        vm.prank(bob);
        upgraded.withdraw(AMOUNT);
        assertEq(asset.balanceOf(bob) - before, AMOUNT);

        vm.warp(end);
        vm.prank(alice);
        upgraded.unstake();
        vm.prank(bob);
        upgraded.emergencyUnstake();
        assertEq(upgraded.totalStaked(), 0);
        assertEq(asset.balanceOf(address(upgraded)), 0, "every principal paid back");
    }
}
