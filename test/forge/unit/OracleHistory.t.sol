// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LocalHarness} from "../utils/LocalHarness.sol";
import {LPStakingVault} from "../../../contracts/lp-staking/LPStakingVault.sol";
import {LPZapper} from "../../../contracts/lp-staking/LPZapper.sol";
import {OracleHistory} from "../../../contracts/lp-staking/libraries/OracleHistory.sol";
import {LPProxy} from "../../../contracts/lp-staking/deploy/LPProxy.sol";

/**
 * @notice Audit L-04: every place that SETS a TWAP window checks that the pool can serve it now
 *         and forever after ({OracleHistory-requireServes}): the CURRENT observation cardinality
 *         is at least `ceil(window / 6) + 1`, and `observe([window, 0])` succeeds. Measured here
 *         on the vault and the zapper, at `initialize` and at `setTwapParams`, against the pool
 *         mock whose cardinality and history are settable. The real pool's `OLD` is asserted in
 *         `test/forge/fork/TwapManipulation.t.sol`. The adapter's valuation window is in
 *         `ApeBondAdapterBranches.t.sol`.
 */
contract OracleHistoryTest is LocalHarness {
    function setUp() public {
        _deployLocalStack();
    }

    // ──────────────────────── The rule ─────────────────────────

    /// @dev 150 slots serve a 300 s window (51 needed); 1800 s needs 301; 3600 s needs 601.
    function test_Rule_300sPassesOn150SlotsAnd1800sNeeds301() public {
        poolMock.setObservationCardinality(150);
        vault.setTwapParams(300, 500);
        assertEq(vault.twapWindow(), 300, "150 slots serve 300 s");

        vm.expectRevert(abi.encodeWithSelector(OracleHistory.CardinalityTooLow.selector, uint16(150), uint256(301)));
        vault.setTwapParams(1800, 500);

        poolMock.setObservationCardinality(300);
        vm.expectRevert(abi.encodeWithSelector(OracleHistory.CardinalityTooLow.selector, uint16(300), uint256(301)));
        vault.setTwapParams(1800, 500);

        poolMock.setObservationCardinality(301);
        vault.setTwapParams(1800, 500);
        assertEq(vault.twapWindow(), 1800, "301 slots serve 1800 s");

        poolMock.setObservationCardinality(600);
        vm.expectRevert(abi.encodeWithSelector(OracleHistory.CardinalityTooLow.selector, uint16(600), uint256(601)));
        vault.setTwapParams(3600, 500);
    }

    /// @dev The boundary of the rule: ceil(300 / 6) + 1 = 51, so 50 is refused and 51 accepted;
    ///      a window off the 6 s grid rounds UP (301 s needs ceil(301 / 6) + 1 = 52).
    function test_Rule_TheBoundaryIsCeilOfWindowOverSixPlusOne() public {
        poolMock.setObservationCardinality(50);
        vm.expectRevert(abi.encodeWithSelector(OracleHistory.CardinalityTooLow.selector, uint16(50), uint256(51)));
        vault.setTwapParams(300, 500);

        poolMock.setObservationCardinality(51);
        vault.setTwapParams(300, 500);
        vm.expectRevert(abi.encodeWithSelector(OracleHistory.CardinalityTooLow.selector, uint16(51), uint256(52)));
        vault.setTwapParams(301, 500);
    }

    /// @dev It reads the CURRENT cardinality, never `observationCardinalityNext`: grown slots
    ///      count only after the pool's index wraps.
    function test_Rule_GrowingNextDoesNotCount() public {
        poolMock.setObservationCardinality(2);
        poolMock.increaseObservationCardinalityNext(1000);
        vm.expectRevert(abi.encodeWithSelector(OracleHistory.CardinalityTooLow.selector, uint16(2), uint256(51)));
        vault.setTwapParams(300, 500);
    }

    /// @dev Enough slots, too little history: the pool's `OLD` becomes `HistoryTooShort`.
    function test_Rule_ShortHistoryRevertsHistoryTooShort() public {
        poolMock.setHistorySeconds(599);
        vm.expectRevert(abi.encodeWithSelector(OracleHistory.HistoryTooShort.selector, uint32(600)));
        vault.setTwapParams(600, 500);

        vm.expectRevert(abi.encodeWithSelector(OracleHistory.HistoryTooShort.selector, uint32(600)));
        zapper.setTwapParams(600, 500);

        poolMock.setHistorySeconds(600);
        vault.setTwapParams(600, 500);
        zapper.setTwapParams(600, 500);
        assertEq(vault.twapWindow(), 600, "the vault takes a window the history covers");
        assertEq(zapper.twapWindow(), 600, "and so does the zapper");
    }

    /// @dev A refused window leaves the stored parameters untouched.
    function test_Rule_ARefusedWindowChangesNothing() public {
        uint32 windowBefore = vault.twapWindow();
        uint24 ticksBefore = vault.maxTwapDeviationTicks();
        poolMock.setObservationCardinality(10);
        vm.expectRevert(abi.encodeWithSelector(OracleHistory.CardinalityTooLow.selector, uint16(10), uint256(51)));
        vault.setTwapParams(300, 777);
        assertEq(vault.twapWindow(), windowBefore, "window unchanged");
        assertEq(vault.maxTwapDeviationTicks(), ticksBefore, "ceiling unchanged");
    }

    // ──────────────────────── At initialize ────────────────────

    /// @dev The check runs inside `initialize`, so neither proxy can be born on a pool that
    ///      cannot serve its window.
    function test_Initialize_TheVaultAndTheZapperRefuseAPoolThatCannotServe() public {
        LPStakingVault vaultImpl =
            new LPStakingVault(address(npmMock), address(poolMock), token0, token1, FEE, address(routerMock));
        bytes memory vaultInit = abi.encodeCall(
            LPStakingVault.initialize, (address(this), address(this), address(this), address(0), 300, 500)
        );
        LPZapper zapperImpl = new LPZapper(
            address(vault),
            address(npmMock),
            address(poolMock),
            token0,
            token1,
            FEE,
            address(routerMock),
            address(usdcToken),
            address(asset)
        );
        bytes memory zapperInit = abi.encodeCall(LPZapper.initialize, (address(this), address(this), 300, 500));

        poolMock.setObservationCardinality(1);
        vm.expectRevert(abi.encodeWithSelector(OracleHistory.CardinalityTooLow.selector, uint16(1), uint256(51)));
        new LPProxy(address(vaultImpl), vaultInit);
        vm.expectRevert(abi.encodeWithSelector(OracleHistory.CardinalityTooLow.selector, uint16(1), uint256(51)));
        new LPProxy(address(zapperImpl), zapperInit);

        poolMock.setObservationCardinality(51);
        poolMock.setHistorySeconds(299);
        vm.expectRevert(abi.encodeWithSelector(OracleHistory.HistoryTooShort.selector, uint32(300)));
        new LPProxy(address(vaultImpl), vaultInit);
        vm.expectRevert(abi.encodeWithSelector(OracleHistory.HistoryTooShort.selector, uint32(300)));
        new LPProxy(address(zapperImpl), zapperInit);

        poolMock.setHistorySeconds(300);
        LPStakingVault born = LPStakingVault(address(new LPProxy(address(vaultImpl), vaultInit)));
        assertEq(born.twapWindow(), 300, "a pool that serves the window takes the vault");
        LPZapper bornZapper = LPZapper(address(new LPProxy(address(zapperImpl), zapperInit)));
        assertEq(bornZapper.twapWindow(), 300, "and the zapper");
    }

    // ──────────────────────── Read paths fail closed ───────────

    /// @dev No fallback on any read path: a pool whose history shrinks below the stored window
    ///      (a mock can, a real pool cannot) makes the read revert the pool's own `OLD`.
    function test_ReadPath_StaysFailClosed() public {
        poolMock.setHistorySeconds(299);
        vm.expectRevert(bytes("OLD"));
        vault.previewTwap();
        vm.expectRevert(bytes("OLD"));
        zapper.previewTwap();
    }
}
