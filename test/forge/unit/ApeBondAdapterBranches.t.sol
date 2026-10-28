// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {ApeBondHarness} from "../utils/ApeBondHarness.sol";
import {ApeBondPositionAdapter} from "../../../contracts/lp-staking/ApeBondPositionAdapter.sol";
import {BonusEscrow} from "../../../contracts/lp-staking/BonusEscrow.sol";
import {LPStakingVault} from "../../../contracts/lp-staking/LPStakingVault.sol";
import {PositionValue} from "../../../contracts/lp-staking/libraries/PositionValue.sol";
import {TickMath} from "../../../contracts/lp-staking/libraries/TickMath.sol";
import {OracleHistory} from "../../../contracts/lp-staking/libraries/OracleHistory.sol";
import {MockSoulZapCaller} from "../../../contracts/lp-staking/mocks/MockSoulZapCaller.sol";
import {MockPositionManager} from "../../../contracts/lp-staking/mocks/MockPositionManager.sol";
import {MisreportingVault} from "../utils/attackers/MisreportingVault.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

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
 *  the deploy scripts' timelock batch links them, one campaign 1200 ticks below and above the
 *  $ASSET price with a 120-tick tolerance (its band at the pool mock's tick 0 is [-1200, 1200]) at
 *  10 % with a 1 ASSET minimum and a 30-day cliff, and a {MockSoulZapCaller} permitted for it.
 *  The band is placed around the spot tick at each purchase (Vladimir's decision of 14 Oct 2026):
 *  its rounding on negative ticks, its flip when $ASSET is token1, its clamp at Uniswap's bounds
 *  and the tolerance on each edge are asserted here tick by tick. The escrow holds NOTHING (override O2: a reservation needs no balance).
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
        new ApeBondPositionAdapter(
            address(0), address(vault), address(escrow), address(this), apeGuardian, MIN_CLIFF, 1800
        );
        vm.expectRevert(ApeBondPositionAdapter.ZeroAddress.selector);
        new ApeBondPositionAdapter(
            address(npmMock), address(0), address(escrow), address(this), apeGuardian, MIN_CLIFF, 1800
        );
        vm.expectRevert(ApeBondPositionAdapter.ZeroAddress.selector);
        new ApeBondPositionAdapter(
            address(npmMock), address(vault), address(0), address(this), apeGuardian, MIN_CLIFF, 1800
        );
        vm.expectRevert(ApeBondPositionAdapter.ZeroAddress.selector);
        new ApeBondPositionAdapter(
            address(npmMock), address(vault), address(escrow), address(this), address(0), MIN_CLIFF, 1800
        );
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new ApeBondPositionAdapter(
            address(npmMock), address(vault), address(escrow), address(0), apeGuardian, MIN_CLIFF, 1800
        );
    }

    /// @dev Audit C-14: the cliff floor is immutable, so a zero floor would be a zero floor forever.
    function test_Constructor_RejectsAZeroCliffFloor() public {
        vm.expectRevert(ApeBondPositionAdapter.ZeroMinCliff.selector);
        new ApeBondPositionAdapter(
            address(npmMock), address(vault), address(escrow), address(this), apeGuardian, 0, 1800
        );
    }

    /// @dev The escrow must take its notifications from the very vault this adapter deposits
    ///      into; otherwise exits from this vault would never forfeit a bonus.
    function test_Constructor_RejectsAnEscrowLinkedToAnotherVault() public {
        MisreportingVault other = _misreportingVault();
        vm.expectRevert(
            abi.encodeWithSelector(ApeBondPositionAdapter.EscrowVaultMismatch.selector, address(vault), address(other))
        );
        new ApeBondPositionAdapter(
            address(npmMock), address(other), address(escrow), address(this), apeGuardian, MIN_CLIFF, 1800
        );
    }

    function test_Constructor_RejectsABonusTokenOutsideThePool() public {
        FakeEscrow fake = new FakeEscrow(address(vault), address(overture));
        vm.expectRevert(
            abi.encodeWithSelector(
                ApeBondPositionAdapter.BonusTokenNotInPool.selector, address(overture), token0, token1
            )
        );
        new ApeBondPositionAdapter(
            address(npmMock), address(vault), address(fake), address(this), apeGuardian, MIN_CLIFF, 1800
        );
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
        assertEq(adapter.minCliffSeconds(), MIN_CLIFF, "the cliff floor");
    }

    function test_Constructor_ValuesInToken1WhenTheBonusIsToken1() public {
        BonusEscrow usdcEscrow = _deployBonusEscrowProxy(address(usdcToken), address(vault), address(this), address(0));
        ApeBondPositionAdapter usdcAdapter = new ApeBondPositionAdapter(
            address(npmMock), address(vault), address(usdcEscrow), address(this), apeGuardian, MIN_CLIFF, 1800
        );
        assertFalse(usdcAdapter.bonusIsToken0(), "a USDC bonus values in token1");
    }

    /// @dev Both roles' initial state is in the logs from block one.
    function test_Constructor_AnnouncesTheGuardianAndThePause() public {
        vm.expectEmit(false, false, false, true);
        emit ApeBondPositionAdapter.GuardianSet(address(0), apeGuardian);
        vm.expectEmit(false, false, false, true);
        emit ApeBondPositionAdapter.DepositsPausedSet(false);
        new ApeBondPositionAdapter(
            address(npmMock), address(vault), address(escrow), address(this), apeGuardian, MIN_CLIFF, 1800
        );
    }

    // ──────────────────────── setCampaign ──────────────────────

    function test_SetCampaign_RejectsTheZeroId() public {
        vm.expectRevert(ApeBondPositionAdapter.ZeroCampaignId.selector);
        adapter.setCampaign(bytes32(0), _campaignConfig(CAMPAIGN_DOWN_TICKS, CAMPAIGN_UP_TICKS));
    }

    /// @dev Every set of offsets no band can be built from, each rule by name.
    function test_SetCampaign_RejectsEveryImpossibleOffset() public {
        int24[3][8] memory bad = [
            [int24(0), int24(1200), int24(120)], // down offset zero
            [int24(-60), int24(1200), int24(120)], // down offset negative
            [int24(1200), int24(0), int24(120)], // up offset zero
            [int24(1200), int24(-1), int24(120)], // up offset negative
            [int24(1200), int24(1200), int24(59)], // tolerance one tick below the 60-tick spacing
            [int24(1200), int24(1200), int24(0)], // no tolerance at all
            [int24(887272), int24(887272), int24(120)], // down + up == MAX_TICK - MIN_TICK
            [int24(type(int24).max), int24(type(int24).max), int24(120)] // the sum overflows int24
        ];
        for (uint256 i = 0; i < bad.length; ++i) {
            ApeBondPositionAdapter.CampaignConfig memory config = _campaignConfig(bad[i][0], bad[i][1]);
            config.toleranceTicks = bad[i][2];
            vm.expectRevert(
                abi.encodeWithSelector(
                    ApeBondPositionAdapter.InvalidCampaignOffsets.selector, bad[i][0], bad[i][1], bad[i][2], int24(60)
                )
            );
            adapter.setCampaign(OTHER_CAMPAIGN, config);
        }
    }

    /// @dev Each limit itself is legal: one tick each way with a one-spacing tolerance, and a band
    ///      one tick narrower than Uniswap's whole tick range.
    function test_SetCampaign_AcceptsTheLimitOfEachRule() public {
        ApeBondPositionAdapter.CampaignConfig memory config = _campaignConfig(1, 1);
        config.toleranceTicks = 60;
        adapter.setCampaign(OTHER_CAMPAIGN, config);
        (, int24 down, int24 up, int24 tolerance,,,) = adapter.campaigns(OTHER_CAMPAIGN);
        assertEq(down, 1, "one tick below");
        assertEq(up, 1, "one tick above");
        assertEq(tolerance, 60, "one tick spacing");

        adapter.setCampaign(OTHER_CAMPAIGN, _campaignConfig(887272, 887271));
        (, down, up,,,,) = adapter.campaigns(OTHER_CAMPAIGN);
        assertEq(int256(down) + int256(up), int256(TickMath.MAX_TICK) - int256(TickMath.MIN_TICK) - 1, "the widest");
    }

    /// @dev Audit C-14: a cliff below the immutable floor is refused — a zero cliff would record a
    ///      bonus that no exit can forfeit — and the floor itself is legal.
    function test_SetCampaign_RefusesACliffBelowTheFloor() public {
        ApeBondPositionAdapter.CampaignConfig memory config = _campaignConfig(CAMPAIGN_DOWN_TICKS, CAMPAIGN_UP_TICKS);
        config.bonusCliffSeconds = 0;
        vm.expectRevert(abi.encodeWithSelector(ApeBondPositionAdapter.CliffBelowMinimum.selector, uint64(0), MIN_CLIFF));
        adapter.setCampaign(OTHER_CAMPAIGN, config);

        config.bonusCliffSeconds = MIN_CLIFF - 1;
        vm.expectRevert(
            abi.encodeWithSelector(ApeBondPositionAdapter.CliffBelowMinimum.selector, MIN_CLIFF - 1, MIN_CLIFF)
        );
        adapter.setCampaign(OTHER_CAMPAIGN, config);

        config.bonusCliffSeconds = MIN_CLIFF;
        adapter.setCampaign(OTHER_CAMPAIGN, config);
        (,,,, uint64 cliff,,) = adapter.campaigns(OTHER_CAMPAIGN);
        assertEq(cliff, MIN_CLIFF, "the floor itself is accepted");
    }

    /// @dev A rate above the whole value is refused; exactly the whole value is legal.
    function test_SetCampaign_TheRateCeilingIsTheWholeValue() public {
        ApeBondPositionAdapter.CampaignConfig memory config = _campaignConfig(CAMPAIGN_DOWN_TICKS, CAMPAIGN_UP_TICKS);
        config.bonusBps = 10_001;
        vm.expectRevert(abi.encodeWithSelector(ApeBondPositionAdapter.BonusBpsTooHigh.selector, uint16(10_001)));
        adapter.setCampaign(OTHER_CAMPAIGN, config);

        config.bonusBps = 10_000;
        adapter.setCampaign(OTHER_CAMPAIGN, config);
        (,,,,, uint16 bps,) = adapter.campaigns(OTHER_CAMPAIGN);
        assertEq(bps, 10_000, "100 % is accepted");
    }

    /// @dev A reconfiguration is announced in full and affects only later deposits: a reservation
    ///      already in the escrow keeps its amount and its unlock time.
    function test_SetCampaign_OverwritesInFullAndLeavesReservationsAlone() public {
        uint256 tokenId = _buy(alice, BUY_LIQUIDITY);
        (, uint256 amountBefore, uint64 unlockBefore,,) = escrow.reservationOf(tokenId);

        ApeBondPositionAdapter.CampaignConfig memory config = ApeBondPositionAdapter.CampaignConfig({
            enabled: false,
            downTicks: 6932,
            upTicks: 6931,
            toleranceTicks: 500,
            bonusCliffSeconds: 7 days,
            bonusBps: 50,
            minBonusAmount: 5e18
        });
        vm.expectEmit(true, false, false, true, address(adapter));
        emit ApeBondPositionAdapter.CampaignSet(CAMPAIGN, false, 6932, 6931, 500, 7 days, 50, 5e18);
        adapter.setCampaign(CAMPAIGN, config);

        (bool enabled, int24 down, int24 up, int24 tolerance, uint64 cliff, uint16 bps, uint256 minBonus) =
            adapter.campaigns(CAMPAIGN);
        assertFalse(enabled, "every field is overwritten");
        assertEq(down, 6932, "down");
        assertEq(up, 6931, "up");
        assertEq(tolerance, 500, "tolerance");
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

    // ──────────────────────── Valuation window (audit L-02) ───

    /// @dev A new adapter on the local vault and escrow with the given valuation window.
    function _adapterWith(uint32 window) internal returns (ApeBondPositionAdapter) {
        return new ApeBondPositionAdapter(
            address(npmMock), address(vault), address(escrow), address(this), apeGuardian, MIN_CLIFF, window
        );
    }

    /// @dev The constructor stores the window and announces it with both sides (zero before).
    function test_ValuationWindow_TheConstructorSetsAndAnnouncesIt() public {
        vm.expectEmit(false, false, false, true);
        emit ApeBondPositionAdapter.ValuationWindowSet(0, 1800);
        ApeBondPositionAdapter fresh = _adapterWith(1800);
        assertEq(fresh.valuationWindow(), 1800, "the constructor stores the window");
        assertEq(adapter.valuationWindow(), 1800, "the harness adapter runs the deploy default");
        assertEq(fresh.MIN_VALUATION_WINDOW(), 300, "the floor mirrors the vault's TWAP floor");
        assertEq(fresh.MAX_VALUATION_WINDOW(), 3600, "the ceiling mirrors the vault's TWAP ceiling");
    }

    /// @dev Bounded to 300..3600 s, at construction and in the setter; both bounds accepted.
    function test_ValuationWindow_IsBoundedTo300Through3600() public {
        vm.expectRevert(
            abi.encodeWithSelector(ApeBondPositionAdapter.InvalidValuationWindow.selector, uint32(299), 300, 3600)
        );
        _adapterWith(299);
        vm.expectRevert(
            abi.encodeWithSelector(ApeBondPositionAdapter.InvalidValuationWindow.selector, uint32(3601), 300, 3600)
        );
        _adapterWith(3601);

        vm.expectRevert(
            abi.encodeWithSelector(ApeBondPositionAdapter.InvalidValuationWindow.selector, uint32(299), 300, 3600)
        );
        adapter.setValuationWindow(299);
        vm.expectRevert(
            abi.encodeWithSelector(ApeBondPositionAdapter.InvalidValuationWindow.selector, uint32(3601), 300, 3600)
        );
        adapter.setValuationWindow(3601);

        adapter.setValuationWindow(300);
        assertEq(adapter.valuationWindow(), 300, "the floor itself is accepted");
        adapter.setValuationWindow(3600);
        assertEq(adapter.valuationWindow(), 3600, "the ceiling itself is accepted");
    }

    /// @dev Owner tier (the timelock): the guardian, the vault's operator and a stranger are refused.
    function test_ValuationWindow_TheSetterIsOwnerOnlyAndAnnouncesBothSides() public {
        vault.setOperator(operatorSafe);
        address[3] memory refused = [apeGuardian, operatorSafe, stranger];
        for (uint256 i = 0; i < refused.length; ++i) {
            vm.prank(refused[i]);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, refused[i]));
            adapter.setValuationWindow(900);
        }
        vm.expectEmit(false, false, false, true, address(adapter));
        emit ApeBondPositionAdapter.ValuationWindowSet(1800, 900);
        adapter.setValuationWindow(900);
        assertEq(adapter.valuationWindow(), 900, "the owner moved the window");
    }

    /// @dev The history check (audit L-04) runs in the constructor and in the setter: 1800 s needs
    ///      ceil(1800 / 6) + 1 = 301 current slots, and 1800 s of history.
    function test_ValuationWindow_TheHistoryCheckRunsInTheConstructorAndTheSetter() public {
        poolMock.setObservationCardinality(300);
        vm.expectRevert(abi.encodeWithSelector(OracleHistory.CardinalityTooLow.selector, uint16(300), uint256(301)));
        _adapterWith(1800);
        vm.expectRevert(abi.encodeWithSelector(OracleHistory.CardinalityTooLow.selector, uint16(300), uint256(301)));
        adapter.setValuationWindow(1800);

        poolMock.setObservationCardinality(301);
        poolMock.setHistorySeconds(1799);
        vm.expectRevert(abi.encodeWithSelector(OracleHistory.HistoryTooShort.selector, uint32(1800)));
        _adapterWith(1800);
        vm.expectRevert(abi.encodeWithSelector(OracleHistory.HistoryTooShort.selector, uint32(1800)));
        adapter.setValuationWindow(1800);

        poolMock.setHistorySeconds(1800);
        assertEq(_adapterWith(1800).valuationWindow(), 1800, "a pool that serves the window takes the adapter");
        adapter.setValuationWindow(1800);
    }

    /// @dev The valuation tick is the mean over the adapter's OWN window, not the vault's TWAP:
    ///      the pool sat at -1000 for the last 300 s and at 0 before, so the vault's 300 s TWAP
    ///      reads -1000 while the adapter's 1800 s mean reads floor(-1000 x 300 / 1800) = -167.
    function test_ValuationWindow_TheBonusIsValuedAtTheAdaptersOwnMean() public {
        poolMock.setTicks(-1000, 0);
        poolMock.setRecentTick(-1000, 300);
        (, int24 vaultTwap,, bool withinBounds) = vault.previewTwap();
        assertEq(vaultTwap, -1000, "the vault's 300 s TWAP sees the held price");
        assertTrue(withinBounds, "spot sits on the vault's TWAP");

        (,, int24 valuedAt) = adapter.previewBonus(CAMPAIGN, BUY_LIQUIDITY);
        assertEq(valuedAt, -167, "the bonus is valued at the 1800 s mean, rounded down");

        adapter.setValuationWindow(300);
        (,, valuedAt) = adapter.previewBonus(CAMPAIGN, BUY_LIQUIDITY);
        assertEq(valuedAt, -1000, "a 300 s valuation window would see the held price in full");
    }

    /// @dev The mean is rounded toward negative infinity, like the vault's TWAP: a negative delta
    ///      with a remainder takes one more step down (raw cumulatives: -1 over 1800 s is -1, not 0).
    function test_ValuationWindow_TheMeanRoundsTowardNegativeInfinity() public {
        poolMock.setCurrentTick(-1);
        poolMock.setTickCumulatives([int56(0), int56(-1)]);
        (,, int24 valuedAt) = adapter.previewBonus(CAMPAIGN, BUY_LIQUIDITY);
        assertEq(valuedAt, -1, "a negative remainder floors");

        poolMock.setTickCumulatives([int56(0), int56(-3600)]);
        (,, valuedAt) = adapter.previewBonus(CAMPAIGN, BUY_LIQUIDITY);
        assertEq(valuedAt, -2, "an exact negative quotient is not floored twice");
    }

    /// @dev Krum's addition 2.1: the deposit still reverts when spot is outside the VAULT's TWAP
    ///      bounds, whatever the valuation window reads. Spot 600 ticks off a 0 TWAP, ceiling 500.
    function test_ValuationWindow_TheSpotCheckStillUsesTheVaultsTwap() public {
        poolMock.setTicks(600, 0);
        vm.expectRevert(
            abi.encodeWithSelector(
                ApeBondPositionAdapter.PriceOutsideTwapBounds.selector, int24(600), int24(0), int24(500)
            )
        );
        adapter.previewBonus(CAMPAIGN, BUY_LIQUIDITY);
    }

    /**
     * @dev Audit L-02's proof of concept, inverted. A buyer holds the $ASSET price 5 % down
     *      (513 ticks, ASSET is token0 on the math rung) for 5 minutes, spot included, so the
     *      vault's 300 s spot check passes. Valued over the adapter's 1800 s window the bonus
     *      rises by at most about 0.4 %; valued over 300 s it would rise by about 2.5 % (krumbgf's
     *      sensitivity table, band -50 % / +100 %).
     */
    function test_ValuationWindow_AHeldPriceMovesTheBonusByItsShareOfTheWindow() public {
        _deployMathRung();
        int24 lower = PRICE_TICK - 6932; // -50 %
        int24 upper = PRICE_TICK + 6932; // +100 %
        uint128 liquidity = 1e18;

        (, uint256 fair,) = mathAdapter.previewBonusAt(CAMPAIGN, liquidity, lower, upper);

        int24 held = PRICE_TICK - 513;
        mathPool.setTicks(held, PRICE_TICK);
        mathPool.setRecentTick(held, 300);
        (,,, bool withinBounds) = mathVault.previewTwap();
        assertTrue(withinBounds, "the held price passes the vault's own spot check");

        (, uint256 at1800,) = mathAdapter.previewBonusAt(CAMPAIGN, liquidity, lower, upper);
        mathAdapter.setValuationWindow(300);
        (, uint256 at300,) = mathAdapter.previewBonusAt(CAMPAIGN, liquidity, lower, upper);

        // In basis points of the fair bonus.
        uint256 gain1800 = (at1800 - fair) * 10_000 / fair;
        uint256 gain300 = (at300 - fair) * 10_000 / fair;
        emit log_named_uint("bonus gain at 1800 s, bps", gain1800);
        emit log_named_uint("bonus gain at 300 s, bps", gain300);
        assertGt(at1800, fair, "a lower valuation price raises the bonus");
        // Measured: +42 bps at 1800 s and +251 bps at 300 s (krumbgf's table: +0.4 % and +2.5 %).
        assertGe(gain1800, 35, "1800 s: about +0.4 %");
        assertLe(gain1800, 50, "1800 s: about +0.4 %");
        assertGe(gain300, 240, "300 s: about +2.5 %");
        assertLe(gain300, 260, "300 s: about +2.5 %");
    }

    // ──────────────────────── Ownership (audit L-03) ───────────

    /// @dev `transferOwnership` only NOMINATES, as on the five proxies: the owner does not move,
    ///      the nominee is recorded and holds nothing until it accepts.
    function test_Ownership_TransferOnlyNominates() public {
        vm.expectEmit(true, true, false, false, address(adapter));
        emit Ownable2Step.OwnershipTransferStarted(address(this), operatorSafe);
        adapter.transferOwnership(operatorSafe);

        assertEq(adapter.owner(), address(this), "a nomination must not move the owner");
        assertEq(adapter.pendingOwner(), operatorSafe, "the nominee is recorded");

        vm.prank(operatorSafe);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operatorSafe));
        adapter.setSoulZapCaller(bob, true);

        adapter.setSoulZapCaller(bob, true);
        assertTrue(adapter.soulZapCallers(bob), "the standing owner still holds the owner tier");
    }

    /// @dev Accepting is what moves the owner; it clears the nomination and the new owner acts.
    function test_Ownership_AcceptanceByTheNomineeMovesTheOwner() public {
        adapter.transferOwnership(operatorSafe);
        vm.prank(operatorSafe);
        adapter.acceptOwnership();

        assertEq(adapter.owner(), operatorSafe, "accepting moves the owner");
        assertEq(adapter.pendingOwner(), address(0), "and clears the nomination");

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        adapter.setSoulZapCaller(bob, true);
        vm.prank(operatorSafe);
        adapter.setSoulZapCaller(bob, true);
        assertTrue(adapter.soulZapCallers(bob), "the new owner acts at once");
    }

    /// @dev Only the nominee may accept: a stranger and the standing owner are refused.
    function test_Ownership_OnlyTheNomineeCanAccept() public {
        adapter.transferOwnership(operatorSafe);
        address[2] memory refused = [stranger, address(this)];
        for (uint256 i = 0; i < refused.length; ++i) {
            vm.prank(refused[i]);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, refused[i]));
            adapter.acceptOwnership();
        }
        assertEq(adapter.pendingOwner(), operatorSafe, "a refused acceptance leaves the nomination standing");
        assertEq(adapter.owner(), address(this), "and the owner where it was");
    }

    /// @dev `renounceOwnership` reverts `RenounceDisabled` for the owner and
    ///      `OwnableUnauthorizedAccount` for anybody else.
    function test_Ownership_RenounceIsDisabled() public {
        vm.expectRevert(ApeBondPositionAdapter.RenounceDisabled.selector);
        adapter.renounceOwnership();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        adapter.renounceOwnership();
        assertEq(adapter.owner(), address(this), "the adapter is never ownerless");
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
        vm.expectRevert(
            abi.encodeWithSelector(
                ApeBondPositionAdapter.NotGuardianOrOperator.selector, apeGuardian, bob, address(this)
            )
        );
        adapter.pauseDeposits();

        vm.expectEmit(false, false, false, true, address(adapter));
        emit ApeBondPositionAdapter.DepositsPausedSet(true);
        vm.prank(bob);
        adapter.pauseDeposits();
        assertTrue(adapter.depositsPaused(), "the new guardian paused");
    }

    /// @dev Audit C-29: the vault's operator replaces a leaked guardian with no timelock delay —
    ///      zero still refused — while a stranger and the standing guardian are refused. The
    ///      owner keeps the same right (test_SetGuardian_RotationMovesThePause).
    function test_SetGuardian_TheVaultOperatorRotatesItWithoutTheTimelock() public {
        // The local vault starts with this contract in every seat; the operator gets its own key.
        vault.setOperator(operatorSafe);
        address[2] memory refused = [stranger, apeGuardian];
        for (uint256 i = 0; i < refused.length; ++i) {
            vm.prank(refused[i]);
            vm.expectRevert(abi.encodeWithSelector(ApeBondPositionAdapter.NotOwnerOrOperator.selector, refused[i]));
            adapter.setGuardian(refused[i]);
        }

        vm.prank(operatorSafe);
        vm.expectRevert(ApeBondPositionAdapter.ZeroAddress.selector);
        adapter.setGuardian(address(0));

        vm.expectEmit(false, false, false, true, address(adapter));
        emit ApeBondPositionAdapter.GuardianSet(apeGuardian, bob);
        vm.prank(operatorSafe);
        adapter.setGuardian(bob);
        assertEq(adapter.guardian(), bob, "the operator moved the seat");
    }

    /// @dev Audit L-01. The timelock holds no undelayed switch: the owner is refused on the pause
    ///      and on the unpause, and so is a stranger. The guardian pauses and is refused on the
    ///      unpause. The vault's operator (read live) does both. The local vault starts with this
    ///      contract in every seat, so the operator gets its own key first.
    function test_PauseDeposits_GuardianOrVaultOperator_UnpauseVaultOperatorOnly() public {
        vault.setOperator(operatorSafe);
        address[2] memory refused = [address(this), stranger];
        for (uint256 i = 0; i < refused.length; ++i) {
            vm.prank(refused[i]);
            vm.expectRevert(
                abi.encodeWithSelector(
                    ApeBondPositionAdapter.NotGuardianOrOperator.selector, refused[i], apeGuardian, operatorSafe
                )
            );
            adapter.pauseDeposits();
        }
        address[3] memory notOperator = [address(this), stranger, apeGuardian];
        for (uint256 i = 0; i < notOperator.length; ++i) {
            vm.prank(notOperator[i]);
            vm.expectRevert(
                abi.encodeWithSelector(ApeBondPositionAdapter.NotOperator.selector, notOperator[i], operatorSafe)
            );
            adapter.unpauseDeposits();
        }

        vm.expectEmit(false, false, false, true, address(adapter));
        emit ApeBondPositionAdapter.DepositsPausedSet(true);
        vm.prank(apeGuardian);
        adapter.pauseDeposits();
        assertTrue(adapter.depositsPaused(), "the guardian paused");

        vm.expectEmit(false, false, false, true, address(adapter));
        emit ApeBondPositionAdapter.DepositsPausedSet(false);
        vm.prank(operatorSafe);
        adapter.unpauseDeposits();
        assertFalse(adapter.depositsPaused(), "the vault's operator unpaused");

        vm.prank(operatorSafe);
        adapter.pauseDeposits();
        assertTrue(adapter.depositsPaused(), "the vault's operator pauses too");
    }

    /// @dev Audit L-01 proof of concept, inverted: the operator pauses during an incident and a
    ///      leaked guardian key cannot lift that pause.
    function test_PauseDeposits_TheGuardianCannotLiftTheOperatorsPause() public {
        vault.setOperator(operatorSafe);
        vm.prank(operatorSafe);
        adapter.pauseDeposits();

        vm.prank(apeGuardian);
        vm.expectRevert(abi.encodeWithSelector(ApeBondPositionAdapter.NotOperator.selector, apeGuardian, operatorSafe));
        adapter.unpauseDeposits();
        assertTrue(adapter.depositsPaused(), "the operator's pause holds");
    }

    /// @dev Every configuration setter is owner (timelock) tier: the guardian, a caller and a
    ///      stranger are refused on each. The guardian seat also takes the vault's operator
    ///      (audit C-29), so its refusal names that tier.
    function test_Admin_EveryConfigurationSetterIsOwnerOnly() public {
        address[3] memory refused = [apeGuardian, address(soulZap), stranger];
        ApeBondPositionAdapter.CampaignConfig memory config = _campaignConfig(CAMPAIGN_DOWN_TICKS, CAMPAIGN_UP_TICKS);
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
            vm.expectRevert(abi.encodeWithSelector(ApeBondPositionAdapter.NotOwnerOrOperator.selector, refused[i]));
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
        ApeBondPositionAdapter.CampaignConfig memory config = _campaignConfig(CAMPAIGN_DOWN_TICKS, CAMPAIGN_UP_TICKS);
        config.bonusBps = 0;
        config.minBonusAmount = 0;
        adapter.setCampaign(CAMPAIGN, config);

        uint256 tokenId = _buy(alice, BUY_LIQUIDITY);
        assertEq(vault.stakerOf(tokenId), alice, "staked");
        (address beneficiary,,,,) = escrow.reservationOf(tokenId);
        assertEq(beneficiary, address(0), "a zero bonus skips the escrow");
    }

    /// @dev Audit C-14: the shortest cliff a campaign can have is the floor, and a bonus behind
    ///      it is ACTIVE — forfeited by an exit — from the purchase block until the floor passes.
    function test_DepositFor_ACliffAtTheFloorKeepsTheBonusActive() public {
        ApeBondPositionAdapter.CampaignConfig memory config = _campaignConfig(CAMPAIGN_DOWN_TICKS, CAMPAIGN_UP_TICKS);
        config.bonusCliffSeconds = MIN_CLIFF;
        adapter.setCampaign(CAMPAIGN, config);

        uint256 tokenId = _buy(alice, BUY_LIQUIDITY);
        (,, uint64 unlockAt,,) = escrow.reservationOf(tokenId);
        assertEq(unlockAt, block.timestamp + MIN_CLIFF, "unlocks one floor after the purchase");
        assertTrue(escrow.isActive(tokenId), "so an exit in the purchase block still forfeits it");
    }

    function test_DepositFor_AcceptsAnOperatorForAllApproval() public {
        soulZap.setApprovalMode(MockSoulZapCaller.Approval.OperatorForAll);
        uint256 tokenId = _buy(alice, BUY_LIQUIDITY);
        assertEq(vault.stakerOf(tokenId), alice, "a blanket approval is as good as a per-token one");
    }

    // ──────────────────────── depositFor: the checklist, in order ───

    /// @dev Audit C-12: a vault that reports to no escrow, or to another one, would never forfeit
    ///      this bonus on an early exit, so the purchase is refused — before the pause is read.
    function test_DepositFor_0_RevertsUnlessTheVaultReportsToThisEscrow() public {
        uint256 tokenId = _mintForSoulZap(BUY_LIQUIDITY);

        vault.setBonusEscrow(address(0));
        vm.prank(apeGuardian);
        adapter.pauseDeposits();
        vm.expectRevert(
            abi.encodeWithSelector(ApeBondPositionAdapter.EscrowNotLinked.selector, address(0), address(escrow))
        );
        soulZap.deposit(adapter, address(npmMock), tokenId, CAMPAIGN, alice);
        adapter.unpauseDeposits(); // this contract is the local vault's operator

        BonusEscrow other = _deployBonusEscrowProxy(address(asset), address(vault), address(this), address(0));
        vault.setBonusEscrow(address(other));
        vm.expectRevert(
            abi.encodeWithSelector(ApeBondPositionAdapter.EscrowNotLinked.selector, address(other), address(escrow))
        );
        soulZap.deposit(adapter, address(npmMock), tokenId, CAMPAIGN, alice);

        vault.setBonusEscrow(address(escrow));
        soulZap.deposit(adapter, address(npmMock), tokenId, CAMPAIGN, alice);
        assertEq(vault.stakerOf(tokenId), alice, "linked again, the same purchase goes through");
        (, uint256 amount,,,) = escrow.reservationOf(tokenId);
        assertGt(amount, 0, "and its bonus is reserved");
    }

    function test_DepositFor_1_RevertsWhileTheAdaptersDepositsArePaused() public {
        vm.prank(apeGuardian);
        adapter.pauseDeposits();
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
        adapter.setCampaign(OTHER_CAMPAIGN, _campaignConfig(CAMPAIGN_DOWN_TICKS, CAMPAIGN_UP_TICKS));
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

    /// @dev One tick beyond the tolerance on ONE edge, the other edge exact: refused with the
    ///      NFT's ticks, the band's and the tolerance — for each edge, from each side.
    function test_DepositFor_6_RevertsOneTickBeyondTheToleranceOnEachEdge() public {
        int24 t = CAMPAIGN_TOLERANCE_TICKS;
        int24[2][4] memory beyond = [
            [CAMPAIGN_TICK_LOWER - t - 1, CAMPAIGN_TICK_UPPER],
            [CAMPAIGN_TICK_LOWER + t + 1, CAMPAIGN_TICK_UPPER],
            [CAMPAIGN_TICK_LOWER, CAMPAIGN_TICK_UPPER - t - 1],
            [CAMPAIGN_TICK_LOWER, CAMPAIGN_TICK_UPPER + t + 1]
        ];
        for (uint256 i = 0; i < beyond.length; ++i) {
            uint256 tokenId = _createPositionOn(
                address(soulZap), token0, token1, FEE, beyond[i][0], beyond[i][1], BUY_LIQUIDITY, 0, 0
            );
            vm.expectRevert(
                abi.encodeWithSelector(
                    ApeBondPositionAdapter.TickRangeOutsideTolerance.selector,
                    beyond[i][0],
                    beyond[i][1],
                    CAMPAIGN_TICK_LOWER,
                    CAMPAIGN_TICK_UPPER,
                    t
                )
            );
            soulZap.deposit(adapter, address(npmMock), tokenId, CAMPAIGN, alice);
        }
    }

    /// @dev Exactly at the tolerance on one edge, the other edge exact: accepted, and the event and
    ///      the bonus are the NFT's own range, not the band's.
    function test_DepositFor_6_AcceptsExactlyAtTheToleranceOnEachEdge() public {
        int24 t = CAMPAIGN_TOLERANCE_TICKS;
        int24[2][4] memory atTolerance = [
            [CAMPAIGN_TICK_LOWER - t, CAMPAIGN_TICK_UPPER],
            [CAMPAIGN_TICK_LOWER + t, CAMPAIGN_TICK_UPPER],
            [CAMPAIGN_TICK_LOWER, CAMPAIGN_TICK_UPPER - t],
            [CAMPAIGN_TICK_LOWER, CAMPAIGN_TICK_UPPER + t]
        ];
        for (uint256 i = 0; i < atTolerance.length; ++i) {
            int24 lower = atTolerance[i][0];
            int24 upper = atTolerance[i][1];
            uint256 tokenId =
                _createPositionOn(address(soulZap), token0, token1, FEE, lower, upper, BUY_LIQUIDITY, 0, 0);
            uint256 value = PositionValue.valueAt(BUY_LIQUIDITY, lower, upper, int24(0), true);
            uint256 bonus = value * BONUS_BPS / 10_000;
            vm.expectEmit(true, true, true, true, address(adapter));
            emit ApeBondPositionAdapter.ApeBondPositionDeposited(
                tokenId,
                CAMPAIGN,
                alice,
                BUY_LIQUIDITY,
                lower,
                upper,
                int24(0),
                value,
                bonus,
                uint64(block.timestamp + CLIFF)
            );
            soulZap.deposit(adapter, address(npmMock), tokenId, CAMPAIGN, alice);
            assertEq(vault.stakerOf(tokenId), alice, "accepted at the tolerance");
        }
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
        vault.pauseDeposits();
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
        vm.expectRevert(abi.encodeWithSelector(ApeBondPositionAdapter.UnknownCampaign.selector, OTHER_CAMPAIGN));
        adapter.previewBonusAt(OTHER_CAMPAIGN, BUY_LIQUIDITY, CAMPAIGN_TICK_LOWER, CAMPAIGN_TICK_UPPER);

        poolMock.setTicks(-600, 0);
        bytes memory outside = abi.encodeWithSelector(
            ApeBondPositionAdapter.PriceOutsideTwapBounds.selector, int24(-600), int24(0), int24(500)
        );
        vm.expectRevert(outside);
        adapter.previewBonus(CAMPAIGN, BUY_LIQUIDITY);
        vm.expectRevert(outside);
        adapter.previewBonusAt(CAMPAIGN, BUY_LIQUIDITY, CAMPAIGN_TICK_LOWER, CAMPAIGN_TICK_UPPER);
    }

    /// @dev Spot places the band, the TWAP values it: with spot at 310 and the TWAP at 0 the quote
    ///      is the band [-900, 1560] valued at tick 0, and the explicit-ticks quote on that band
    ///      agrees with it.
    function test_PreviewBonus_ValuesTheLiveBandAtTheTwap() public {
        poolMock.setTicks(310, 0);
        (int24 lower, int24 upper, int24 spot) = adapter.campaignRange(CAMPAIGN);
        assertEq(lower, -900, "-890 rounded down to the grid");
        assertEq(upper, 1560, "1510 rounded up to the grid");
        assertEq(spot, 310, "the spot it was placed around");

        (uint256 value, uint256 bonus, int24 twapTick) = adapter.previewBonus(CAMPAIGN, BUY_LIQUIDITY);
        uint256 expectedValue = PositionValue.valueAt(BUY_LIQUIDITY, -900, 1560, int24(0), true);
        assertEq(value, expectedValue, "the band valued at the TWAP");
        assertEq(bonus, expectedValue * BONUS_BPS / 10_000, "the rate of it");
        assertEq(twapTick, int24(0), "at the TWAP");

        (uint256 atValue, uint256 atBonus,) = adapter.previewBonusAt(CAMPAIGN, BUY_LIQUIDITY, lower, upper);
        assertEq(atValue, value, "the same band, the same value");
        assertEq(atBonus, bonus, "and the same bonus");
    }

    /// @dev The explicit-ticks quote checks nothing against the band: a range far outside the
    ///      tolerance is valued as given.
    function test_PreviewBonusAt_ValuesTheTicksItIsGiven() public view {
        (uint256 value, uint256 bonus, int24 twapTick) = adapter.previewBonusAt(CAMPAIGN, BUY_LIQUIDITY, -6000, 6000);
        uint256 expectedValue = PositionValue.valueAt(BUY_LIQUIDITY, -6000, 6000, int24(0), true);
        assertEq(value, expectedValue, "valued as given");
        assertEq(bonus, expectedValue * BONUS_BPS / 10_000, "the rate of it");
        assertEq(twapTick, int24(0), "at the TWAP");
    }

    // ──────────────────────── campaignRange ────────────────────

    function test_CampaignRange_IsTheOffsetsAroundSpot() public view {
        (int24 lower, int24 upper, int24 spot) = adapter.campaignRange(CAMPAIGN);
        assertEq(lower, CAMPAIGN_TICK_LOWER, "1200 below tick 0");
        assertEq(upper, CAMPAIGN_TICK_UPPER, "1200 above tick 0");
        assertEq(spot, int24(0), "the pool mock's spot");
    }

    function test_CampaignRange_RevertsForAnUnknownCampaign() public {
        vm.expectRevert(abi.encodeWithSelector(ApeBondPositionAdapter.UnknownCampaign.selector, OTHER_CAMPAIGN));
        adapter.campaignRange(OTHER_CAMPAIGN);
    }

    /// @dev The lower edge rounds DOWN and the upper edge UP, negative ticks included: Solidity's
    ///      truncating division would round -1261 to -1260, the band must take -1320.
    function test_CampaignRange_RoundsOutwardOnNegativeAndPositiveTicks() public {
        int24[3][6] memory cases = [
            // spot, lower, upper
            [int24(-61), int24(-1320), int24(1140)], // -1261 -> -1320, 1139 -> 1140
            [int24(61), int24(-1140), int24(1320)], // -1139 -> -1140, 1261 -> 1320
            [int24(-120), int24(-1320), int24(1080)], // on the grid: unchanged
            [int24(-1), int24(-1260), int24(1200)], // -1201 -> -1260, 1199 -> 1200
            [int24(1), int24(-1200), int24(1260)], // -1199 -> -1200, 1201 -> 1260
            [int24(-5000), int24(-6240), int24(-3780)] // -6200 -> -6240, -3800 -> -3780
        ];
        for (uint256 i = 0; i < cases.length; ++i) {
            poolMock.setCurrentTick(cases[i][0]);
            (int24 lower, int24 upper, int24 spot) = adapter.campaignRange(CAMPAIGN);
            assertEq(lower, cases[i][1], "the lower edge, rounded down");
            assertEq(upper, cases[i][2], "the upper edge, rounded up");
            assertEq(spot, cases[i][0], "the spot");
        }
    }

    /// @dev Past MIN_TICK or MAX_TICK the band is clamped to the last grid tick inside the bounds.
    function test_CampaignRange_ClampsAtTheTickBounds() public {
        poolMock.setCurrentTick(-887000);
        (int24 lower, int24 upper,) = adapter.campaignRange(CAMPAIGN);
        assertEq(lower, -887220, "-888200 clamped to MIN_TICK rounded inward");
        assertEq(upper, -885780, "-885800 rounded up");

        poolMock.setCurrentTick(887000);
        (lower, upper,) = adapter.campaignRange(CAMPAIGN);
        assertEq(lower, 885780, "885800 rounded down");
        assertEq(upper, 887220, "888200 clamped to MAX_TICK rounded inward");

        // The widest legal campaign reaches past both bounds from tick 0.
        poolMock.setCurrentTick(0);
        adapter.setCampaign(OTHER_CAMPAIGN, _campaignConfig(887272, 887271));
        (lower, upper,) = adapter.campaignRange(OTHER_CAMPAIGN);
        assertEq(lower, -887220, "clamped low");
        assertEq(upper, 887220, "clamped high");
    }

    /// @dev A purchase at a clamped band goes through like any other: spot and TWAP both near
    ///      MIN_TICK, the NFT minted on the band `campaignRange` returns.
    function test_DepositFor_AcceptsAClampedBand() public {
        poolMock.setTicks(-887000, -887000);
        uint256 tokenId = _buy(alice, BUY_LIQUIDITY);
        (,,,,, int24 lower, int24 upper,,,,,) = npmMock.positions(tokenId);
        assertEq(lower, -887220, "the clamped lower edge");
        assertEq(vault.stakerOf(tokenId), alice, "staked");
    }

    /// @dev $ASSET as token1: its price FALLS as the tick rises, so "down" sits above spot and the
    ///      two offsets swap sides. A USDC-paying adapter on the same vault is that orientation; a
    ///      purchase through it accepts the flipped band, values in token1, and refuses the
    ///      unflipped one.
    function test_CampaignRange_FlipsWhenTheBonusIsToken1() public {
        (BonusEscrow usdcEscrow, ApeBondPositionAdapter usdcAdapter) = _usdcRoute();
        assertFalse(usdcAdapter.bonusIsToken0(), "a USDC bonus is token1");
        usdcAdapter.setCampaign(OTHER_CAMPAIGN, _campaignConfig(1200, 3000));
        adapter.setCampaign(OTHER_CAMPAIGN, _campaignConfig(1200, 3000));

        (int24 lower0, int24 upper0,) = adapter.campaignRange(OTHER_CAMPAIGN);
        (int24 lower1, int24 upper1,) = usdcAdapter.campaignRange(OTHER_CAMPAIGN);
        assertEq(lower0, -1200, "token0: down below spot");
        assertEq(upper0, 3000, "token0: up above spot");
        assertEq(lower1, -3000, "token1: up below spot");
        assertEq(upper1, 1200, "token1: down above spot");

        poolMock.setCurrentTick(-61);
        (lower1, upper1,) = usdcAdapter.campaignRange(OTHER_CAMPAIGN);
        assertEq(lower1, -3120, "-3061 rounded down");
        assertEq(upper1, 1140, "1139 rounded up");
        poolMock.setCurrentTick(0);

        usdcAdapter.setCampaignCaller(OTHER_CAMPAIGN, address(soulZap), true);
        uint256 flipped =
            _createPositionOn(address(soulZap), token0, token1, FEE, -3000, 1200, BUY_LIQUIDITY, P_ASSET, P_USDC);
        soulZap.deposit(usdcAdapter, address(npmMock), flipped, OTHER_CAMPAIGN, alice);
        uint256 value = PositionValue.valueAt(BUY_LIQUIDITY, -3000, 1200, int24(0), false);
        (address beneficiary, uint256 amount,,,) = usdcEscrow.reservationOf(flipped);
        assertEq(beneficiary, alice, "the flipped band is accepted");
        assertEq(amount, value * BONUS_BPS / 10_000, "valued in token1");

        uint256 unflipped =
            _createPositionOn(address(soulZap), token0, token1, FEE, -1200, 3000, BUY_LIQUIDITY, P_ASSET, P_USDC);
        vm.expectRevert(
            abi.encodeWithSelector(
                ApeBondPositionAdapter.TickRangeOutsideTolerance.selector,
                int24(-1200),
                int24(3000),
                int24(-3000),
                int24(1200),
                CAMPAIGN_TOLERANCE_TICKS
            )
        );
        soulZap.deposit(usdcAdapter, address(npmMock), unflipped, OTHER_CAMPAIGN, alice);
    }

    /// @dev The band follows the price: an NFT minted on the old band is refused once spot has
    ///      moved past the tolerance, and one minted on the new band passes with no campaign change.
    function test_DepositFor_TheBandMovesWithThePrice() public {
        uint256 old = _mintForSoulZap(BUY_LIQUIDITY); // [-1200, 1200]
        poolMock.setTicks(480, 480);
        vm.expectRevert(
            abi.encodeWithSelector(
                ApeBondPositionAdapter.TickRangeOutsideTolerance.selector,
                CAMPAIGN_TICK_LOWER,
                CAMPAIGN_TICK_UPPER,
                int24(-720),
                int24(1680),
                CAMPAIGN_TOLERANCE_TICKS
            )
        );
        soulZap.deposit(adapter, address(npmMock), old, CAMPAIGN, alice);

        uint256 fresh = _buy(alice, BUY_LIQUIDITY);
        (,,,,, int24 lower, int24 upper,,,,,) = npmMock.positions(fresh);
        assertEq(lower, -720, "minted on the band of the moment");
        assertEq(upper, 1680, "both edges");
        assertEq(vault.stakerOf(fresh), alice, "and accepted");
    }

    // ──────────────────────── Fuzz ─────────────────────────────

    /// @dev A range is accepted exactly when BOTH edges are within the tolerance of the band.
    function testFuzz_TickRange_AcceptedExactlyWithinTheTolerance(int24 lowerSeed, int24 upperSeed) public {
        int24 lower = int24(bound(lowerSeed, -1500, -900));
        int24 upper = int24(bound(upperSeed, 900, 1500));
        uint256 tokenId = _createPositionOn(address(soulZap), token0, token1, FEE, lower, upper, BUY_LIQUIDITY, 0, 0);

        bool lowerOk = _abs(int256(lower) - CAMPAIGN_TICK_LOWER) <= int256(CAMPAIGN_TOLERANCE_TICKS);
        bool upperOk = _abs(int256(upper) - CAMPAIGN_TICK_UPPER) <= int256(CAMPAIGN_TOLERANCE_TICKS);
        if (lowerOk && upperOk) {
            soulZap.deposit(adapter, address(npmMock), tokenId, CAMPAIGN, alice);
            assertEq(vault.stakerOf(tokenId), alice, "inside the tolerance is accepted");
        } else {
            vm.expectRevert(
                abi.encodeWithSelector(
                    ApeBondPositionAdapter.TickRangeOutsideTolerance.selector,
                    lower,
                    upper,
                    CAMPAIGN_TICK_LOWER,
                    CAMPAIGN_TICK_UPPER,
                    CAMPAIGN_TOLERANCE_TICKS
                )
            );
            soulZap.deposit(adapter, address(npmMock), tokenId, CAMPAIGN, alice);
        }
    }

    /// @dev The band against a reference built a different way — floor and ceil through the
    ///      non-negative remainder rather than truncation — for any spot, any offsets and both
    ///      token orders. Every edge is on the grid, inside the bounds, and outward of the raw one.
    function testFuzz_CampaignRange_MatchesAnIndependentRounding(int24 spotSeed, int24 downSeed, int24 upSeed) public {
        int24 spot = int24(bound(spotSeed, TickMath.MIN_TICK, TickMath.MAX_TICK - 1));
        int24 down = int24(bound(downSeed, 1, 300_000));
        int24 up = int24(bound(upSeed, 1, 300_000));
        poolMock.setCurrentTick(spot);
        adapter.setCampaign(OTHER_CAMPAIGN, _campaignConfig(down, up));
        (int24 lower, int24 upper,) = adapter.campaignRange(OTHER_CAMPAIGN);

        int256 maxUsable = 887220;
        int256 refLower = _refFloor(int256(spot) - down);
        int256 refUpper = _refCeil(int256(spot) + up);
        if (refLower < -maxUsable) refLower = -maxUsable;
        if (refUpper > maxUsable) refUpper = maxUsable;
        assertEq(int256(lower), refLower, "the lower edge");
        assertEq(int256(upper), refUpper, "the upper edge");
        assertEq(int256(lower) % 60, 0, "on the grid");
        assertEq(int256(upper) % 60, 0, "on the grid");
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
        ApeBondPositionAdapter.CampaignConfig memory config = _campaignConfig(CAMPAIGN_DOWN_TICKS, CAMPAIGN_UP_TICKS);
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
        a = new ApeBondPositionAdapter(
            address(npmMock), address(mv), address(e), address(this), apeGuardian, MIN_CLIFF, 1800
        );
        mv.setBonusEscrow(address(e));
        e.setAdapter(address(a));
        _openCampaign(a, soulZap, CAMPAIGN, CAMPAIGN_DOWN_TICKS, CAMPAIGN_UP_TICKS);
    }

    /// @dev A USDC-paying escrow and adapter on the local vault, linked in place of the ASSET pair
    ///      (the ASSET escrow owes nothing yet, so the vault may move its link), with the SoulZap
    ///      double allowlisted.
    function _usdcRoute() private returns (BonusEscrow e, ApeBondPositionAdapter a) {
        e = _deployBonusEscrowProxy(address(usdcToken), address(vault), address(this), address(0));
        a = new ApeBondPositionAdapter(
            address(npmMock), address(vault), address(e), address(this), apeGuardian, MIN_CLIFF, 1800
        );
        _link(vault, e, a);
        a.setSoulZapCaller(address(soulZap), true);
    }

    /// @dev Floor to the 60-tick grid through the non-negative remainder.
    function _refFloor(int256 tick) private pure returns (int256) {
        int256 rem = ((tick % 60) + 60) % 60;
        return tick - rem;
    }

    /// @dev Ceil to the 60-tick grid through the non-negative remainder.
    function _refCeil(int256 tick) private pure returns (int256) {
        int256 rem = ((tick % 60) + 60) % 60;
        return rem == 0 ? tick : tick + (60 - rem);
    }

    function _abs(int256 x) private pure returns (int256) {
        return x < 0 ? -x : x;
    }
}
