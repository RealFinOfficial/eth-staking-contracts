// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ApeBondHarness} from "../utils/ApeBondHarness.sol";
import {ApeBondPositionAdapter} from "../../../contracts/lp-staking/ApeBondPositionAdapter.sol";
import {BonusEscrow} from "../../../contracts/lp-staking/BonusEscrow.sol";
import {LPStakingVault} from "../../../contracts/lp-staking/LPStakingVault.sol";
import {PositionValue} from "../../../contracts/lp-staking/libraries/PositionValue.sol";
import {TickMath} from "../../../contracts/lp-staking/libraries/TickMath.sol";
import {MockSoulZapCaller} from "../../../contracts/lp-staking/mocks/MockSoulZapCaller.sol";
import {MockPositionManager} from "../../../contracts/lp-staking/mocks/MockPositionManager.sol";
import {MisreportingVault} from "../utils/attackers/MisreportingVault.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @dev An escrow double that names the right vault but a bonus token outside the pool — the one
///      combination the real {BonusEscrow} constructor already refuses, so the adapter's own check
///      can only be reached with a stand-in.
contract FakeEscrow {
    address public vault;
    address public bonusToken;

    constructor(address vault_, address bonusToken_) {
        vault = vault_;
        bonusToken = bonusToken_;
    }
}

/**
 * @notice Why this file exists: {ApeBondPositionAdapter-depositFor} is one ordered checklist
 *         followed by one formula. Every rejection on the checklist is a boundary a happy-path
 *         test steps over, so each is asserted here by selector AND by the values the error
 *         carries; the formula — `valueAt(position, TWAP) x bonusBps / 10,000`, zero below the
 *         campaign minimum — is recomputed here with the same library and compared to the wei.
 *
 *  The local rung of {ApeBondHarness}: the adapter, the escrow and the vault are linked exactly as
 *  the deploy scripts' timelock batch links them, one campaign on [-1200, 1200] around the pool
 *  mock's tick 0 at 10 % with a 1 ASSET minimum and a 30-day cliff, and a {MockSoulZapCaller}
 *  permitted for it. The escrow holds NOTHING (override O2: a reservation needs no balance).
 *  `alice` is the beneficiary throughout, so "the buyer got it" is never satisfied by the buyer
 *  happening to be the caller.
 */
contract ApeBondAdapterBranchesTest is ApeBondHarness {
    uint24 internal constant OTHER_FEE = 500;

    function setUp() public {
        _deployApeBond();
        vm.warp(1_000_000);
    }

    // ──────────────────────── Constructor ──────────────────────

    function test_Constructor_RejectsEveryZeroReference() public {
        vm.expectRevert(ApeBondPositionAdapter.ZeroAddress.selector);
        new ApeBondPositionAdapter(address(0), address(vault), address(escrow), address(this), apeGuardian);
        vm.expectRevert(ApeBondPositionAdapter.ZeroAddress.selector);
        new ApeBondPositionAdapter(address(npmMock), address(0), address(escrow), address(this), apeGuardian);
        vm.expectRevert(ApeBondPositionAdapter.ZeroAddress.selector);
        new ApeBondPositionAdapter(address(npmMock), address(vault), address(0), address(this), apeGuardian);
        vm.expectRevert(ApeBondPositionAdapter.ZeroAddress.selector);
        new ApeBondPositionAdapter(address(npmMock), address(vault), address(escrow), address(this), address(0));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new ApeBondPositionAdapter(address(npmMock), address(vault), address(escrow), address(0), apeGuardian);
    }

    /// @dev The escrow must take its notifications from the very vault this adapter deposits
    ///      into; otherwise exits from this vault would never forfeit a bonus.
    function test_Constructor_RejectsAnEscrowLinkedToAnotherVault() public {
        MisreportingVault other = _misreportingVault();
        vm.expectRevert(
            abi.encodeWithSelector(ApeBondPositionAdapter.EscrowVaultMismatch.selector, address(vault), address(other))
        );
        new ApeBondPositionAdapter(address(npmMock), address(other), address(escrow), address(this), apeGuardian);
    }

    function test_Constructor_RejectsABonusTokenOutsideThePool() public {
        FakeEscrow fake = new FakeEscrow(address(vault), address(overture));
        vm.expectRevert(
            abi.encodeWithSelector(
                ApeBondPositionAdapter.BonusTokenNotInPool.selector, address(overture), token0, token1
            )
        );
        new ApeBondPositionAdapter(address(npmMock), address(vault), address(fake), address(this), apeGuardian);
    }

    /// @dev Everything about the pool is READ from the vault, never configured.
    function test_Constructor_ReadsThePoolFromTheVault() public view {
        assertEq(address(adapter.positionManager()), address(npmMock), "the position manager");
        assertEq(address(adapter.vault()), address(vault), "the vault");
        assertEq(address(adapter.escrow()), address(escrow), "the escrow");
        assertEq(adapter.token0(), token0, "token0 from the vault");
        assertEq(adapter.token1(), token1, "token1 from the vault");
        assertEq(adapter.fee(), FEE, "the fee from the vault");
        assertEq(adapter.tickSpacing(), int24(60), "the spacing from the vault's pool");
        assertTrue(adapter.bonusIsToken0(), "an ASSET bonus values in token0");
        assertEq(adapter.guardian(), apeGuardian, "the guardian");
        assertEq(adapter.owner(), address(this), "the owner");
        assertFalse(adapter.depositsPaused(), "open");
        assertEq(adapter.BPS(), 10_000, "the basis-point denominator");
    }

    function test_Constructor_ValuesInToken1WhenTheBonusIsToken1() public {
        BonusEscrow usdcEscrow = _deployBonusEscrowProxy(address(usdcToken), address(vault), address(this), address(0));
        ApeBondPositionAdapter usdcAdapter = new ApeBondPositionAdapter(
            address(npmMock), address(vault), address(usdcEscrow), address(this), apeGuardian
        );
        assertFalse(usdcAdapter.bonusIsToken0(), "a USDC bonus values in token1");
    }

    /// @dev Both roles' initial state is in the logs from block one.
    function test_Constructor_AnnouncesTheGuardianAndThePause() public {
        vm.expectEmit(false, false, false, true);
        emit ApeBondPositionAdapter.GuardianSet(address(0), apeGuardian);
        vm.expectEmit(false, false, false, true);
        emit ApeBondPositionAdapter.DepositsPausedSet(false);
        new ApeBondPositionAdapter(address(npmMock), address(vault), address(escrow), address(this), apeGuardian);
    }

    // ──────────────────────── setCampaign ──────────────────────

    function test_SetCampaign_RejectsTheZeroId() public {
        vm.expectRevert(ApeBondPositionAdapter.ZeroCampaignId.selector);
        adapter.setCampaign(bytes32(0), _campaignConfig(CAMPAIGN_TICK_LOWER, CAMPAIGN_TICK_UPPER));
    }

    /// @dev Every range no Uniswap position on the vault's pool can have, each by name.
    function test_SetCampaign_RejectsEveryImpossibleRange() public {
        int24[2][6] memory bad = [
            [int24(600), int24(600)], // lower == upper
            [int24(1200), int24(-1200)], // lower > upper
            [int24(-887280), int24(1200)], // below MIN_TICK (on the grid)
            [int24(-1200), int24(887280)], // above MAX_TICK (on the grid)
            [int24(-1230), int24(1200)], // lower off the 60-tick grid
            [int24(-1200), int24(1230)] // upper off the grid
        ];
        for (uint256 i = 0; i < bad.length; ++i) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    ApeBondPositionAdapter.InvalidCampaignRange.selector, bad[i][0], bad[i][1], int24(60)
                )
            );
            adapter.setCampaign(OTHER_CAMPAIGN, _campaignConfig(bad[i][0], bad[i][1]));
        }
    }

    /// @dev The widest ranges the grid allows inside Uniswap's bounds are accepted.
    function test_SetCampaign_AcceptsTheExtremeRangesOnTheGrid() public {
        adapter.setCampaign(OTHER_CAMPAIGN, _campaignConfig(-887220, 887220));
        (, int24 lower, int24 upper,,,) = adapter.campaigns(OTHER_CAMPAIGN);
        assertEq(lower, -887220, "the lowest usable tick on the grid");
        assertEq(upper, 887220, "the highest");
        assertLe(TickMath.MIN_TICK, lower, "inside the bounds");
    }

    /// @dev A rate above the whole value is refused; exactly the whole value is legal.
    function test_SetCampaign_TheRateCeilingIsTheWholeValue() public {
        ApeBondPositionAdapter.CampaignConfig memory config = _campaignConfig(CAMPAIGN_TICK_LOWER, CAMPAIGN_TICK_UPPER);
        config.bonusBps = 10_001;
        vm.expectRevert(abi.encodeWithSelector(ApeBondPositionAdapter.BonusBpsTooHigh.selector, uint16(10_001)));
        adapter.setCampaign(OTHER_CAMPAIGN, config);

        config.bonusBps = 10_000;
        adapter.setCampaign(OTHER_CAMPAIGN, config);
        (,,,, uint16 bps,) = adapter.campaigns(OTHER_CAMPAIGN);
        assertEq(bps, 10_000, "100 % is accepted");
    }

    /// @dev A reconfiguration is announced in full and affects only later deposits: a reservation
    ///      already in the escrow keeps its amount and its unlock time.
    function test_SetCampaign_OverwritesInFullAndLeavesReservationsAlone() public {
        uint256 tokenId = _buy(alice, BUY_LIQUIDITY);
        (, uint256 amountBefore, uint64 unlockBefore,,) = escrow.reservationOf(tokenId);

        ApeBondPositionAdapter.CampaignConfig memory config = ApeBondPositionAdapter.CampaignConfig({
            enabled: false,
            tickLower: -2400,
            tickUpper: 2400,
            bonusCliffSeconds: 7 days,
            bonusBps: 50,
            minBonusAmount: 5e18
        });
        vm.expectEmit(true, false, false, true, address(adapter));
        emit ApeBondPositionAdapter.CampaignSet(CAMPAIGN, false, -2400, 2400, 7 days, 50, 5e18);
        adapter.setCampaign(CAMPAIGN, config);

        (bool enabled, int24 lower, int24 upper, uint64 cliff, uint16 bps, uint256 minBonus) =
            adapter.campaigns(CAMPAIGN);
        assertFalse(enabled, "every field is overwritten");
        assertEq(lower, -2400, "lower");
        assertEq(upper, 2400, "upper");
        assertEq(cliff, 7 days, "cliff");
        assertEq(bps, 50, "rate");
        assertEq(minBonus, 5e18, "minimum");

        (, uint256 amountAfter, uint64 unlockAfter,,) = escrow.reservationOf(tokenId);
        assertEq(amountAfter, amountBefore, "the reservation keeps its amount");
        assertEq(unlockAfter, unlockBefore, "and its unlock time");
    }

    // ──────────────────────── setCampaignEnabled / Caller ──────

    function test_SetCampaignEnabled_RejectsAnUnknownCampaign() public {
        vm.expectRevert(abi.encodeWithSelector(ApeBondPositionAdapter.UnknownCampaign.selector, OTHER_CAMPAIGN));
        adapter.setCampaignEnabled(OTHER_CAMPAIGN, true);
    }

    function test_SetCampaignEnabled_DisablesAndReEnables() public {
        vm.expectEmit(true, false, false, true, address(adapter));
        emit ApeBondPositionAdapter.CampaignEnabledSet(CAMPAIGN, false);
        adapter.setCampaignEnabled(CAMPAIGN, false);

        uint256 tokenId = _mintForSoulZap(BUY_LIQUIDITY);
        vm.expectRevert(abi.encodeWithSelector(ApeBondPositionAdapter.CampaignDisabled.selector, CAMPAIGN));
        soulZap.deposit(adapter, address(npmMock), tokenId, CAMPAIGN, alice);

        adapter.setCampaignEnabled(CAMPAIGN, true);
        soulZap.deposit(adapter, address(npmMock), tokenId, CAMPAIGN, alice);
        assertEq(vault.stakerOf(tokenId), alice, "re-enabled, the same purchase goes through");
    }

    function test_SetCampaignCaller_RejectsTheZeroIdAndTheZeroCaller() public {
        vm.expectRevert(ApeBondPositionAdapter.ZeroCampaignId.selector);
        adapter.setCampaignCaller(bytes32(0), address(soulZap), true);
        vm.expectRevert(ApeBondPositionAdapter.ZeroAddress.selector);
        adapter.setCampaignCaller(CAMPAIGN, address(0), true);
    }

    /// @dev A caller may be permitted before its campaign exists, so one timelock batch can do
    ///      both in either order.
    function test_SetCampaignCaller_WorksBeforeTheCampaignExists() public {
        vm.expectEmit(true, true, false, true, address(adapter));
        emit ApeBondPositionAdapter.CampaignCallerSet(OTHER_CAMPAIGN, address(soulZap), true);
        adapter.setCampaignCaller(OTHER_CAMPAIGN, address(soulZap), true);
        assertTrue(adapter.campaignCallers(OTHER_CAMPAIGN, address(soulZap)), "permitted");

        adapter.setCampaignCaller(OTHER_CAMPAIGN, address(soulZap), false);
        assertFalse(adapter.campaignCallers(OTHER_CAMPAIGN, address(soulZap)), "and removed");
    }

    function test_SetSoulZapCaller_RejectsZeroAndAnnouncesTheNewState() public {
        vm.expectRevert(ApeBondPositionAdapter.ZeroAddress.selector);
        adapter.setSoulZapCaller(address(0), true);

        vm.expectEmit(true, false, false, true, address(adapter));
        emit ApeBondPositionAdapter.SoulZapCallerSet(bob, true);
        adapter.setSoulZapCaller(bob, true);
        assertTrue(adapter.soulZapCallers(bob), "allowlisted");
    }

    // ──────────────────────── Guardian ─────────────────────────

    function test_SetGuardian_RejectsZero() public {
        vm.expectRevert(ApeBondPositionAdapter.ZeroAddress.selector);
        adapter.setGuardian(address(0));
    }

    /// @dev The pause moves with the seat: the old guardian is refused, the new one answers.
    function test_SetGuardian_RotationMovesThePause() public {
        vm.expectEmit(false, false, false, true, address(adapter));
        emit ApeBondPositionAdapter.GuardianSet(apeGuardian, bob);
        adapter.setGuardian(bob);

        vm.prank(apeGuardian);
        vm.expectRevert(abi.encodeWithSelector(ApeBondPositionAdapter.NotGuardian.selector, apeGuardian, bob));
        adapter.setDepositsPaused(true);

        vm.expectEmit(false, false, false, true, address(adapter));
        emit ApeBondPositionAdapter.DepositsPausedSet(true);
        vm.prank(bob);
        adapter.setDepositsPaused(true);
        assertTrue(adapter.depositsPaused(), "the new guardian paused");
    }

    /// @dev The timelock holds no undelayed switch: the owner is refused on the pause, and so is
    ///      a stranger.
    function test_SetDepositsPaused_IsGuardianOnly() public {
        address[2] memory refused = [address(this), stranger];
        for (uint256 i = 0; i < refused.length; ++i) {
            vm.prank(refused[i]);
            vm.expectRevert(
                abi.encodeWithSelector(ApeBondPositionAdapter.NotGuardian.selector, refused[i], apeGuardian)
            );
            adapter.setDepositsPaused(true);
        }
        vm.prank(apeGuardian);
        adapter.setDepositsPaused(true);
        vm.prank(apeGuardian);
        adapter.setDepositsPaused(false);
        assertFalse(adapter.depositsPaused(), "and unpaused again");
    }

    /// @dev Every configuration setter is owner (timelock) tier: the guardian, a caller and a
    ///      stranger are refused on each.
    function test_Admin_EveryConfigurationSetterIsOwnerOnly() public {
        address[3] memory refused = [apeGuardian, address(soulZap), stranger];
        ApeBondPositionAdapter.CampaignConfig memory config = _campaignConfig(CAMPAIGN_TICK_LOWER, CAMPAIGN_TICK_UPPER);
        for (uint256 i = 0; i < refused.length; ++i) {
            bytes memory notOwner = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, refused[i]);
            vm.startPrank(refused[i]);
            vm.expectRevert(notOwner);
            adapter.setCampaign(OTHER_CAMPAIGN, config);
            vm.expectRevert(notOwner);
            adapter.setCampaignEnabled(CAMPAIGN, false);
            vm.expectRevert(notOwner);
            adapter.setCampaignCaller(CAMPAIGN, refused[i], true);
            vm.expectRevert(notOwner);
            adapter.setSoulZapCaller(refused[i], true);
            vm.expectRevert(notOwner);
            adapter.setGuardian(refused[i]);
            vm.stopPrank();
        }
    }

    // ──────────────────────── depositFor: the happy path ───────

    /**
     * @dev The whole call: the bonus is the PositionValue formula to the wei, the position is
     *      staked for the beneficiary, the reservation is recorded with an EMPTY escrow, the
     *      unlock is now + cliff, the event carries every figure, and the adapter keeps nothing.
     */
    function test_DepositFor_StakesComputesAndReservesWithAnEmptyEscrow() public {
        uint256 tokenId = _mintForSoulZap(BUY_LIQUIDITY);
        uint256 value = PositionValue.valueAt(BUY_LIQUIDITY, CAMPAIGN_TICK_LOWER, CAMPAIGN_TICK_UPPER, int24(0), true);
        uint256 bonus = value * BONUS_BPS / 10_000;
        uint64 unlockAt = uint64(block.timestamp + CLIFF);
        assertGt(bonus, MIN_BONUS, "above the minimum");
        assertEq(asset.balanceOf(address(escrow)), 0, "the escrow is empty");

        vm.expectEmit(true, true, false, true, address(escrow));
        emit BonusEscrow.BonusReserved(tokenId, alice, bonus, unlockAt);
        vm.expectEmit(true, true, true, true, address(adapter));
        emit ApeBondPositionAdapter.ApeBondPositionDeposited(
            tokenId,
            CAMPAIGN,
            alice,
            BUY_LIQUIDITY,
            CAMPAIGN_TICK_LOWER,
            CAMPAIGN_TICK_UPPER,
            int24(0),
            value,
            bonus,
            unlockAt
        );
        soulZap.deposit(adapter, address(npmMock), tokenId, CAMPAIGN, alice);

        assertEq(npmMock.ownerOf(tokenId), address(vault), "the vault holds the NFT");
        assertEq(vault.stakerOf(tokenId), alice, "credited to the beneficiary");
        (address beneficiary, uint256 amount, uint64 unlock, bool claimed, bool forfeited) =
            escrow.reservationOf(tokenId);
        assertEq(beneficiary, alice, "the bonus is the beneficiary's");
        assertEq(amount, bonus, "the formula, to the wei");
        assertEq(unlock, unlockAt, "now + the campaign cliff");
        assertFalse(claimed || forfeited, "live");
        assertEq(npmMock.balanceOf(address(adapter)), 0, "the adapter keeps no NFT");
        assertEq(asset.balanceOf(address(adapter)), 0, "and no token");
    }

    /// @dev D6: below the minimum the position is staked normally and gets NO reservation; the
    ///      event says so with a zero bonus and a zero unlock time. Nothing reverts.
    function test_DepositFor_BelowTheMinimumStakesWithoutABonus() public {
        uint128 small = 1e18;
        (uint256 value, uint256 expected) = _expectedBonus(small);
        assertEq(expected, 0, "the computed bonus is below the minimum");
        uint256 tokenId = _mintForSoulZap(small);

        vm.expectEmit(true, true, true, true, address(adapter));
        emit ApeBondPositionAdapter.ApeBondPositionDeposited(
            tokenId, CAMPAIGN, alice, small, CAMPAIGN_TICK_LOWER, CAMPAIGN_TICK_UPPER, int24(0), value, 0, 0
        );
        soulZap.deposit(adapter, address(npmMock), tokenId, CAMPAIGN, alice);

        assertEq(vault.stakerOf(tokenId), alice, "staked normally");
        (address beneficiary,,,,) = escrow.reservationOf(tokenId);
        assertEq(beneficiary, address(0), "no reservation");
        assertEq(escrow.totalReserved(), 0, "nothing owed");
    }

    function test_DepositFor_AZeroRateReservesNothing() public {
        ApeBondPositionAdapter.CampaignConfig memory config = _campaignConfig(CAMPAIGN_TICK_LOWER, CAMPAIGN_TICK_UPPER);
        config.bonusBps = 0;
        config.minBonusAmount = 0;
        adapter.setCampaign(CAMPAIGN, config);

        uint256 tokenId = _buy(alice, BUY_LIQUIDITY);
        assertEq(vault.stakerOf(tokenId), alice, "staked");
        (address beneficiary,,,,) = escrow.reservationOf(tokenId);
        assertEq(beneficiary, address(0), "a zero bonus skips the escrow");
    }

    /// @dev A cliff of zero is legal: the bonus unlocks in the deposit's own block, so it is
    ///      already matured — and therefore beyond the reach of the vault's notifications.
    function test_DepositFor_AZeroCliffUnlocksAtOnce() public {
        ApeBondPositionAdapter.CampaignConfig memory config = _campaignConfig(CAMPAIGN_TICK_LOWER, CAMPAIGN_TICK_UPPER);
        config.bonusCliffSeconds = 0;
        adapter.setCampaign(CAMPAIGN, config);

        uint256 tokenId = _buy(alice, BUY_LIQUIDITY);
        (,, uint64 unlockAt,,) = escrow.reservationOf(tokenId);
        assertEq(unlockAt, block.timestamp, "unlocks now");
        assertFalse(escrow.isActive(tokenId), "so it is already matured");
    }

    function test_DepositFor_AcceptsAnOperatorForAllApproval() public {
        soulZap.setApprovalMode(MockSoulZapCaller.Approval.OperatorForAll);
        uint256 tokenId = _buy(alice, BUY_LIQUIDITY);
        assertEq(vault.stakerOf(tokenId), alice, "a blanket approval is as good as a per-token one");
    }

    // ──────────────────────── depositFor: the checklist, in order ───

    function test_DepositFor_1_RevertsWhileTheAdaptersDepositsArePaused() public {
        vm.prank(apeGuardian);
        adapter.setDepositsPaused(true);
        uint256 tokenId = _mintForSoulZap(BUY_LIQUIDITY);
        vm.expectRevert(ApeBondPositionAdapter.DepositsArePaused.selector);
        soulZap.deposit(adapter, address(npmMock), tokenId, CAMPAIGN, alice);
    }

    function test_DepositFor_2_RevertsForACallerOffTheGlobalAllowlist() public {
        MockSoulZapCaller other = new MockSoulZapCaller();
        adapter.setCampaignCaller(CAMPAIGN, address(other), true);
        uint256 tokenId = _createPositionOn(
            address(other), token0, token1, FEE, CAMPAIGN_TICK_LOWER, CAMPAIGN_TICK_UPPER, BUY_LIQUIDITY, 0, 0
        );
        vm.expectRevert(abi.encodeWithSelector(ApeBondPositionAdapter.NotSoulZapCaller.selector, address(other)));
        other.deposit(adapter, address(npmMock), tokenId, CAMPAIGN, alice);
    }

    /// @dev Permitted for campaign A, used on campaign B: refused for B by name.
    function test_DepositFor_2_RevertsForACallerNotPermittedForTheCampaign() public {
        adapter.setCampaign(OTHER_CAMPAIGN, _campaignConfig(CAMPAIGN_TICK_LOWER, CAMPAIGN_TICK_UPPER));
        uint256 tokenId = _mintForSoulZap(BUY_LIQUIDITY);
        vm.expectRevert(
            abi.encodeWithSelector(ApeBondPositionAdapter.NotCampaignCaller.selector, OTHER_CAMPAIGN, address(soulZap))
        );
        soulZap.deposit(adapter, address(npmMock), tokenId, OTHER_CAMPAIGN, alice);
    }

    /// @dev Permitted ahead of time for an id nobody configured: the campaign check refuses it.
    function test_DepositFor_3_RevertsForAnUnconfiguredCampaign() public {
        adapter.setCampaignCaller(OTHER_CAMPAIGN, address(soulZap), true);
        uint256 tokenId = _mintForSoulZap(BUY_LIQUIDITY);
        vm.expectRevert(abi.encodeWithSelector(ApeBondPositionAdapter.UnknownCampaign.selector, OTHER_CAMPAIGN));
        soulZap.deposit(adapter, address(npmMock), tokenId, OTHER_CAMPAIGN, alice);
    }

    /// @dev Four addresses that would strand the position (SEC-05), each by name.
    function test_DepositFor_4_RevertsForEveryStrandingBeneficiary() public {
        address[4] memory bad = [address(0), address(adapter), address(vault), address(npmMock)];
        for (uint256 i = 0; i < bad.length; ++i) {
            uint256 tokenId = _mintForSoulZap(BUY_LIQUIDITY);
            vm.expectRevert(abi.encodeWithSelector(ApeBondPositionAdapter.InvalidBeneficiary.selector, bad[i]));
            soulZap.deposit(adapter, address(npmMock), tokenId, CAMPAIGN, bad[i]);
        }
    }

    function test_DepositFor_5_RevertsWhenTheCallerDoesNotOwnTheNft() public {
        soulZap.setApprovalMode(MockSoulZapCaller.Approval.None);
        uint256 tokenId = _createPositionOn(
            alice, token0, token1, FEE, CAMPAIGN_TICK_LOWER, CAMPAIGN_TICK_UPPER, BUY_LIQUIDITY, 0, 0
        );
        vm.expectRevert(
            abi.encodeWithSelector(ApeBondPositionAdapter.NftNotHeldByCaller.selector, tokenId, alice, address(soulZap))
        );
        soulZap.deposit(adapter, address(npmMock), tokenId, CAMPAIGN, alice);
    }

    function test_DepositFor_5_RevertsWithoutAnApproval() public {
        soulZap.setApprovalMode(MockSoulZapCaller.Approval.None);
        uint256 tokenId = _mintForSoulZap(BUY_LIQUIDITY);
        vm.expectRevert(
            abi.encodeWithSelector(ApeBondPositionAdapter.NftNotApproved.selector, tokenId, address(soulZap))
        );
        soulZap.deposit(adapter, address(npmMock), tokenId, CAMPAIGN, alice);
    }

    /// @dev The pair and the fee must be the vault's: each of the three is checked.
    function test_DepositFor_6_RevertsForAPositionOnAnotherPoolTripleMember() public {
        uint256 wrong0 = _createPositionOn(
            address(soulZap),
            address(overture),
            token1,
            FEE,
            CAMPAIGN_TICK_LOWER,
            CAMPAIGN_TICK_UPPER,
            BUY_LIQUIDITY,
            0,
            0
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                ApeBondPositionAdapter.PositionPoolMismatch.selector, wrong0, address(overture), token1, FEE
            )
        );
        soulZap.deposit(adapter, address(npmMock), wrong0, CAMPAIGN, alice);

        uint256 wrong1 = _createPositionOn(
            address(soulZap),
            token0,
            address(overture),
            FEE,
            CAMPAIGN_TICK_LOWER,
            CAMPAIGN_TICK_UPPER,
            BUY_LIQUIDITY,
            0,
            0
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                ApeBondPositionAdapter.PositionPoolMismatch.selector, wrong1, token0, address(overture), FEE
            )
        );
        soulZap.deposit(adapter, address(npmMock), wrong1, CAMPAIGN, alice);

        uint256 wrongFee = _createPositionOn(
            address(soulZap), token0, token1, OTHER_FEE, CAMPAIGN_TICK_LOWER, CAMPAIGN_TICK_UPPER, BUY_LIQUIDITY, 0, 0
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                ApeBondPositionAdapter.PositionPoolMismatch.selector, wrongFee, token0, token1, OTHER_FEE
            )
        );
        soulZap.deposit(adapter, address(npmMock), wrongFee, CAMPAIGN, alice);
    }

    function test_DepositFor_6_RevertsForAnotherRange() public {
        uint256 tokenId = _createPositionOn(
            address(soulZap), token0, token1, FEE, CAMPAIGN_TICK_LOWER, CAMPAIGN_TICK_UPPER + 60, BUY_LIQUIDITY, 0, 0
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                ApeBondPositionAdapter.TickRangeMismatch.selector,
                CAMPAIGN_TICK_LOWER,
                CAMPAIGN_TICK_UPPER + 60,
                CAMPAIGN_TICK_LOWER,
                CAMPAIGN_TICK_UPPER
            )
        );
        soulZap.deposit(adapter, address(npmMock), tokenId, CAMPAIGN, alice);
    }

    function test_DepositFor_6_RevertsForAnEmptyPosition() public {
        uint256 tokenId = _mintForSoulZap(0);
        vm.expectRevert(abi.encodeWithSelector(ApeBondPositionAdapter.EmptyPosition.selector, tokenId));
        soulZap.deposit(adapter, address(npmMock), tokenId, CAMPAIGN, alice);
    }

    /// @dev Spot further from the vault's TWAP than its ceiling (500 ticks): refused with the
    ///      three numbers, so a router can tell its user why.
    function test_DepositFor_7_RevertsWhenSpotIsOutsideTheTwapBounds() public {
        poolMock.setTicks(600, 0);
        uint256 tokenId = _mintForSoulZap(BUY_LIQUIDITY);
        vm.expectRevert(
            abi.encodeWithSelector(
                ApeBondPositionAdapter.PriceOutsideTwapBounds.selector, int24(600), int24(0), int24(500)
            )
        );
        soulZap.deposit(adapter, address(npmMock), tokenId, CAMPAIGN, alice);
    }

    /// @dev The value is taken at the TWAP, not the spot: with spot moved inside the bounds the
    ///      reservation is still the TWAP formula.
    function test_DepositFor_8_ValuesAtTheTwapNotTheSpot() public {
        poolMock.setTicks(480, 0);
        uint256 tokenId = _buy(alice, BUY_LIQUIDITY);
        (, uint256 expected) = _expectedBonus(BUY_LIQUIDITY); // valued at poolMock.twapTick() == 0
        (, uint256 amount,,,) = escrow.reservationOf(tokenId);
        assertEq(amount, expected, "the TWAP formula, not the spot");
    }

    // ──────────────────────── depositFor: interactions ─────────

    /// @dev The vault's own deposit pause reaches the purchase through `stakeFor` and unwinds it:
    ///      the NFT stays with the caller and nothing is reserved.
    function test_DepositFor_9_RevertsUnderTheVaultsPauseAndUnwinds() public {
        vault.setDepositsPaused(true);
        uint256 tokenId = _mintForSoulZap(BUY_LIQUIDITY);
        vm.expectRevert(LPStakingVault.DepositsArePaused.selector);
        soulZap.deposit(adapter, address(npmMock), tokenId, CAMPAIGN, alice);

        assertEq(npmMock.ownerOf(tokenId), address(soulZap), "the NFT is back with the caller");
        assertEq(escrow.totalReserved(), 0, "nothing reserved");
    }

    function test_DepositFor_9_RevertsWhenTheAdapterIsNoLongerAStakeOperator() public {
        vault.setStakeOperator(address(adapter), false);
        uint256 tokenId = _mintForSoulZap(BUY_LIQUIDITY);
        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.NotZapper.selector, address(adapter), address(zapper)));
        soulZap.deposit(adapter, address(npmMock), tokenId, CAMPAIGN, alice);
    }

    /// @dev With the escrow's reserve path closed the escrow's own refusal bubbles up and the
    ///      whole purchase unwinds.
    function test_DepositFor_10_RevertsWhenTheEscrowDoesNotAcceptThisAdapter() public {
        escrow.setAdapter(address(0));
        uint256 tokenId = _mintForSoulZap(BUY_LIQUIDITY);
        vm.expectRevert(abi.encodeWithSelector(BonusEscrow.NotAdapter.selector, address(adapter), address(0)));
        soulZap.deposit(adapter, address(npmMock), tokenId, CAMPAIGN, alice);
        assertEq(npmMock.ownerOf(tokenId), address(soulZap), "unwound");
    }

    /// @dev The same NFT cannot earn twice: after a forfeiting exit hands it back to the caller,
    ///      a second deposit is refused by the escrow's kept record.
    function test_DepositFor_10_RevertsOnASecondBonusForTheSameNft() public {
        uint256 tokenId = _mintForSoulZap(BUY_LIQUIDITY);
        soulZap.depositAndUnstake(adapter, address(npmMock), tokenId, CAMPAIGN, address(vault));
        assertEq(npmMock.ownerOf(tokenId), address(soulZap), "back with the caller");

        vm.expectRevert(abi.encodeWithSelector(BonusEscrow.DuplicateReservation.selector, tokenId));
        soulZap.deposit(adapter, address(npmMock), tokenId, CAMPAIGN, alice);
    }

    /// @dev Inside one transaction the second presentation of the same NFT fails on custody: the
    ///      vault already holds it.
    function test_DepositFor_RevertsOnTheSameNftTwiceInOneTransaction() public {
        uint256 tokenId = _mintForSoulZap(BUY_LIQUIDITY);
        vm.expectRevert(
            abi.encodeWithSelector(
                ApeBondPositionAdapter.NftNotHeldByCaller.selector, tokenId, address(vault), address(soulZap)
            )
        );
        soulZap.depositTwice(adapter, address(npmMock), tokenId, CAMPAIGN, alice);
    }

    /// @dev Step 11, both levers: a vault that does not take custody, and one that credits
    ///      somebody else. The custody assertion is the adapter's only defence against a vault
    ///      that is not the one anybody meant.
    function test_DepositFor_11_RevertsWhenTheVaultDoesNotEndUpWithTheNft() public {
        (MisreportingVault mv, ApeBondPositionAdapter a) = _misreportingRoute();
        mv.setTakeCustody(false);
        uint256 tokenId = _mintForSoulZap(BUY_LIQUIDITY);
        vm.expectRevert(
            abi.encodeWithSelector(ApeBondPositionAdapter.CustodyAssertFailed.selector, tokenId, address(a), alice)
        );
        soulZap.deposit(a, address(npmMock), tokenId, CAMPAIGN, alice);
    }

    function test_DepositFor_11_RevertsWhenTheVaultCreditsSomebodyElse() public {
        (MisreportingVault mv, ApeBondPositionAdapter a) = _misreportingRoute();
        mv.setReportedStaker(bob);
        uint256 tokenId = _mintForSoulZap(BUY_LIQUIDITY);
        vm.expectRevert(
            abi.encodeWithSelector(ApeBondPositionAdapter.CustodyAssertFailed.selector, tokenId, address(mv), bob)
        );
        soulZap.deposit(a, address(npmMock), tokenId, CAMPAIGN, alice);
    }

    // ──────────────────────── The receipt hook ─────────────────

    function test_OnERC721Received_RejectsAnUnsolicitedPosition() public {
        uint256 tokenId = _createPositionOn(alice, token0, token1, FEE, TICK_LOWER, TICK_UPPER, LIQUIDITY, 0, 0);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(ApeBondPositionAdapter.UnsolicitedPosition.selector, alice, alice, tokenId)
        );
        npmMock.safeTransferFrom(alice, address(adapter), tokenId);
    }

    function test_OnERC721Received_RejectsAForeignCollection() public {
        MockPositionManager other = new MockPositionManager();
        other.mintFake(alice, token0, token1, FEE, TICK_LOWER, TICK_UPPER, LIQUIDITY, 0, 0);
        uint256 tokenId = other.lastMintedId();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ApeBondPositionAdapter.UnexpectedNftSender.selector, address(other)));
        other.safeTransferFrom(alice, address(adapter), tokenId);
    }

    /// @dev The window is transient storage and closes after the pull, so a deposit leaves no
    ///      door open behind it.
    function test_OnERC721Received_ClosesTheWindowAfterADeposit() public {
        _buy(alice, BUY_LIQUIDITY);
        uint256 stray = _createPositionOn(alice, token0, token1, FEE, TICK_LOWER, TICK_UPPER, LIQUIDITY, 0, 0);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(ApeBondPositionAdapter.UnsolicitedPosition.selector, alice, alice, stray)
        );
        npmMock.safeTransferFrom(alice, address(adapter), stray);
    }

    // ──────────────────────── previewBonus ─────────────────────

    /// @dev The view computes exactly what the deposit then records.
    function test_PreviewBonus_EqualsTheDepositsFigures() public {
        (uint256 value, uint256 bonus, int24 twapTick) = adapter.previewBonus(CAMPAIGN, BUY_LIQUIDITY);
        uint256 tokenId = _buy(alice, BUY_LIQUIDITY);
        (, uint256 amount,,,) = escrow.reservationOf(tokenId);
        (uint256 expectedValue, uint256 expectedBonus) = _expectedBonus(BUY_LIQUIDITY);
        assertEq(value, expectedValue, "the value");
        assertEq(bonus, expectedBonus, "the bonus");
        assertEq(amount, bonus, "the same as what the deposit reserved");
        assertEq(twapTick, int24(0), "at the TWAP");
    }

    function test_PreviewBonus_RevertsLikeTheDeposit() public {
        vm.expectRevert(abi.encodeWithSelector(ApeBondPositionAdapter.UnknownCampaign.selector, OTHER_CAMPAIGN));
        adapter.previewBonus(OTHER_CAMPAIGN, BUY_LIQUIDITY);

        poolMock.setTicks(-600, 0);
        vm.expectRevert(
            abi.encodeWithSelector(
                ApeBondPositionAdapter.PriceOutsideTwapBounds.selector, int24(-600), int24(0), int24(500)
            )
        );
        adapter.previewBonus(CAMPAIGN, BUY_LIQUIDITY);
    }

    // ──────────────────────── Fuzz ─────────────────────────────

    /// @dev EXACT, not "inside": any range other than the campaign's is refused.
    function testFuzz_TickRange_OnlyTheExactCampaignRangeIsAccepted(int24 lowerSeed, int24 upperSeed) public {
        int24 lower = int24(bound(lowerSeed, -1260, -1140));
        int24 upper = int24(bound(upperSeed, 1140, 1260));
        uint256 tokenId = _createPositionOn(address(soulZap), token0, token1, FEE, lower, upper, BUY_LIQUIDITY, 0, 0);

        if (lower == CAMPAIGN_TICK_LOWER && upper == CAMPAIGN_TICK_UPPER) {
            soulZap.deposit(adapter, address(npmMock), tokenId, CAMPAIGN, alice);
            assertEq(vault.stakerOf(tokenId), alice, "the exact range is accepted");
        } else {
            vm.expectRevert(
                abi.encodeWithSelector(
                    ApeBondPositionAdapter.TickRangeMismatch.selector,
                    lower,
                    upper,
                    CAMPAIGN_TICK_LOWER,
                    CAMPAIGN_TICK_UPPER
                )
            );
            soulZap.deposit(adapter, address(npmMock), tokenId, CAMPAIGN, alice);
        }
    }

    /// @dev More liquidity on the same range never earns less.
    function testFuzz_Bonus_IsMonotoneInLiquidity(uint128 aSeed, uint128 bSeed) public view {
        uint128 a = uint128(bound(aSeed, 1, 1e30));
        uint128 b = uint128(bound(bSeed, a, 1e30));
        (uint256 valueA, uint256 bonusA,) = adapter.previewBonus(CAMPAIGN, a);
        (uint256 valueB, uint256 bonusB,) = adapter.previewBonus(CAMPAIGN, b);
        assertLe(valueA, valueB, "value grows with liquidity");
        assertLe(bonusA, bonusB, "and so does the bonus");
    }

    /// @dev The minimum is inclusive: a bonus exactly AT it is reserved, one wei below it is not.
    function testFuzz_MinBonus_TheBoundaryIsInclusive(uint128 liquiditySeed) public {
        uint128 liquidity = uint128(bound(liquiditySeed, 1e20, 1e27));
        ApeBondPositionAdapter.CampaignConfig memory config = _campaignConfig(CAMPAIGN_TICK_LOWER, CAMPAIGN_TICK_UPPER);
        config.minBonusAmount = 0;
        adapter.setCampaign(CAMPAIGN, config);
        (, uint256 bonus,) = adapter.previewBonus(CAMPAIGN, liquidity);
        vm.assume(bonus > 0);

        config.minBonusAmount = bonus;
        adapter.setCampaign(CAMPAIGN, config);
        uint256 atMin = _buy(alice, liquidity);
        (, uint256 reserved,,,) = escrow.reservationOf(atMin);
        assertEq(reserved, bonus, "a bonus equal to the minimum is reserved");

        config.minBonusAmount = bonus + 1;
        adapter.setCampaign(CAMPAIGN, config);
        uint256 belowMin = _buy(bob, liquidity);
        (address beneficiary,,,,) = escrow.reservationOf(belowMin);
        assertEq(beneficiary, address(0), "one wei short of the minimum is not");
        assertEq(vault.stakerOf(belowMin), bob, "but is staked all the same");
    }

    // ──────────────────────── Helpers ──────────────────────────

    function _misreportingVault() private returns (MisreportingVault) {
        return new MisreportingVault(address(npmMock), token0, token1, FEE, address(poolMock));
    }

    /// @dev An escrow and an adapter wired to a {MisreportingVault}, with the local campaign and
    ///      the SoulZap double permitted for it.
    function _misreportingRoute() private returns (MisreportingVault mv, ApeBondPositionAdapter a) {
        mv = _misreportingVault();
        BonusEscrow e = _deployBonusEscrowProxy(address(asset), address(mv), address(this), address(0));
        a = new ApeBondPositionAdapter(address(npmMock), address(mv), address(e), address(this), apeGuardian);
        e.setAdapter(address(a));
        _openCampaign(a, soulZap, CAMPAIGN, CAMPAIGN_TICK_LOWER, CAMPAIGN_TICK_UPPER);
    }
}
