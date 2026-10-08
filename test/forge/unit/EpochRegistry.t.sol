// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LocalHarness} from "../utils/LocalHarness.sol";
import {LPEpochRegistry} from "../../../contracts/lp-staking/LPEpochRegistry.sol";
import {ILPEpochRegistry} from "../../../contracts/lp-staking/interfaces/ILPEpochRegistry.sol";
import {LPEpochRegistryV2Mock} from "../../../contracts/lp-staking/mocks/LPEpochRegistryV2Mock.sol";
import {MockERC20Permit} from "../../../contracts/lp-staking/mocks/MockERC20Permit.sol";
import {LPProxy} from "../../../contracts/lp-staking/deploy/LPProxy.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";

/**
 * @notice Why this file exists: {LPEpochRegistry} is the program's emission SCHEDULE, written by
 *         the operator multisig with no delay and mirrored by the backend, which spreads each
 *         epoch's quantities over its 15-minute scoring intervals. Every one of its rules exists
 *         so that what the backend scores is final before it is scored:
 *
 *    - ids are issued in order and never reused, so a missed log shows as a gap;
 *    - every bound sits on the 900-second grid, so no interval is split between two epochs;
 *    - nothing is scheduled or changed less than 30 minutes before it starts, so the backend
 *      has seen it finalized before the first interval is scored — and the edge of that rule,
 *      `startsAt == now + SCHEDULE_MARGIN`, is accepted while one second later is refused;
 *    - live epochs never overlap; bounds move and epochs cancel only at the END of the live
 *      chain, so every check compares against exactly one neighbour;
 *    - every amount names a token the distributor accepts at the moment it is written.
 *
 *  Each gate is one or two assertions here, each error with its exact arguments. The schedule
 *  bounds nothing on-chain; that half of the design is asserted in the distributor's suites.
 *
 *  Time base: {setUp} warps to {T0}, a multiple of 900, so `now + SCHEDULE_MARGIN` is itself on
 *  the grid and the margin edge can be hit exactly.
 */
contract EpochRegistryTest is LocalHarness {
    /// @dev 2,000,000 x 900: on the grid, so `T0 + 1800` is a schedulable start.
    uint64 internal constant T0 = 1_800_000_000;
    uint64 internal constant INTERVAL = 900;
    uint64 internal constant MARGIN = 1800;
    uint64 internal constant WEEK = 7 days;

    /// @dev The first epoch most tests use: one day out, one week long.
    uint64 internal constant S1 = T0 + 1 days;
    uint64 internal constant E1 = S1 + WEEK;

    uint256 internal constant ASSET_AMOUNT = 3_000e18;
    uint256 internal constant OVTR_AMOUNT = 1_000_000e18;

    bytes32 internal constant REGISTRY_STORAGE = 0x9ecda8e3fad78b619c97eff816bc5317dd5b4101194b9333568095fc1dd01f00;

    MockERC20Permit internal foreign;

    function setUp() public {
        _deployLocalStack();
        foreign = new MockERC20Permit("Foreign", "FRN", 1e30, 18);
        vm.warp(T0);
    }

    // ──────────────────────── Constructor / initializer ────────

    function test_Constructor_RejectsAZeroDistributor() public {
        vm.expectRevert(ILPEpochRegistry.ZeroAddress.selector);
        new LPEpochRegistry(address(0));
    }

    function test_Constructor_DisablesTheImplementationsInitializers() public {
        LPEpochRegistry impl = new LPEpochRegistry(address(distributor));

        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(address(this), address(this));
    }

    function test_Initialize_RejectsAZeroOwner() public {
        address impl = address(new LPEpochRegistry(address(distributor)));

        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableInvalidOwner.selector, address(0)));
        new LPProxy(impl, abi.encodeCall(LPEpochRegistry.initialize, (address(0), operatorSafe)));
    }

    function test_Initialize_RejectsAZeroOperator() public {
        address impl = address(new LPEpochRegistry(address(distributor)));

        vm.expectRevert(ILPEpochRegistry.ZeroAddress.selector);
        new LPProxy(impl, abi.encodeCall(LPEpochRegistry.initialize, (multisig, address(0))));
    }

    /// @dev The operator is followable from logs alone, from block one.
    function test_Initialize_AnnouncesTheOperatorAndStoresTheRoles() public {
        address impl = address(new LPEpochRegistry(address(distributor)));

        vm.expectEmit(false, false, false, true);
        emit ILPEpochRegistry.OperatorSet(address(0), operatorSafe);
        LPEpochRegistry fresh = LPEpochRegistry(
            address(new LPProxy(impl, abi.encodeCall(LPEpochRegistry.initialize, (multisig, operatorSafe))))
        );

        assertEq(fresh.owner(), multisig, "the owner is stored");
        assertEq(fresh.operator(), operatorSafe, "the operator is stored");
    }

    function test_Initialize_CannotRunTwiceOnTheProxy() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        registry.initialize(stranger, stranger);
    }

    function test_Initialize_StartsEmptyWithTheDocumentedConstants() public view {
        assertEq(registry.INTERVAL(), 900, "the grid is 900 seconds");
        assertEq(registry.SCHEDULE_MARGIN(), 1800, "the margin is 30 minutes");
        assertEq(registry.distributor(), address(distributor), "bound to the stack's distributor");
        assertEq(registry.epochCount(), 0, "no epoch issued");
        assertEq(registry.lastLiveId(), 0, "no live epoch");
        assertEq(registry.currentEpoch(), 0, "no current epoch");
    }

    // ──────────────────────── scheduleEpoch: access ────────────

    function test_ScheduleEpoch_RejectsTheOwnerAndStrangers() public {
        LPEpochRegistry split = _deployRegistryProxy(address(distributor), multisig, operatorSafe);
        (address[] memory tokens, uint256[] memory amounts) = _two();

        address[2] memory callers = [multisig, stranger];
        for (uint256 i = 0; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.NotOperator.selector, callers[i], operatorSafe));
            split.scheduleEpoch(1, S1, E1, tokens, amounts);
        }

        vm.prank(operatorSafe);
        split.scheduleEpoch(1, S1, E1, tokens, amounts);
        assertEq(split.epochCount(), 1, "the operator schedules");
    }

    // ──────────────────────── scheduleEpoch: ids ───────────────

    function test_ScheduleEpoch_RejectsAnyIdButTheNext() public {
        (address[] memory tokens, uint256[] memory amounts) = _two();

        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.UnexpectedEpochId.selector, 0, 1));
        registry.scheduleEpoch(0, S1, E1, tokens, amounts);
        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.UnexpectedEpochId.selector, 2, 1));
        registry.scheduleEpoch(2, S1, E1, tokens, amounts);

        registry.scheduleEpoch(1, S1, E1, tokens, amounts);

        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.UnexpectedEpochId.selector, 1, 2));
        registry.scheduleEpoch(1, E1, E1 + WEEK, tokens, amounts);
        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.UnexpectedEpochId.selector, 3, 2));
        registry.scheduleEpoch(3, E1, E1 + WEEK, tokens, amounts);
    }

    function test_ScheduleEpoch_RejectsMismatchedLengths() public {
        address[] memory tokens = new address[](2);
        tokens[0] = address(asset);
        tokens[1] = address(overture);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 1;

        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.LengthMismatch.selector, 2, 1));
        registry.scheduleEpoch(1, S1, E1, tokens, amounts);
    }

    // ──────────────────────── scheduleEpoch: grid and bounds ───

    function test_ScheduleEpoch_RejectsAStartOffTheGrid() public {
        (address[] memory tokens, uint256[] memory amounts) = _two();

        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.NotOnGrid.selector, S1 + 1));
        registry.scheduleEpoch(1, S1 + 1, E1, tokens, amounts);
        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.NotOnGrid.selector, S1 + 899));
        registry.scheduleEpoch(1, S1 + 899, E1, tokens, amounts);
    }

    function test_ScheduleEpoch_RejectsAnEndOffTheGrid() public {
        (address[] memory tokens, uint256[] memory amounts) = _two();

        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.NotOnGrid.selector, E1 - 1));
        registry.scheduleEpoch(1, S1, E1 - 1, tokens, amounts);
    }

    function test_ScheduleEpoch_RejectsAnEndNotAfterTheStart() public {
        (address[] memory tokens, uint256[] memory amounts) = _two();

        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.InvalidBounds.selector, S1, S1));
        registry.scheduleEpoch(1, S1, S1, tokens, amounts);
        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.InvalidBounds.selector, S1, S1 - INTERVAL));
        registry.scheduleEpoch(1, S1, S1 - INTERVAL, tokens, amounts);

        // One interval is the shortest legal epoch.
        registry.scheduleEpoch(1, S1, S1 + INTERVAL, tokens, amounts);
        assertEq(registry.epoch(1).endsAt, S1 + INTERVAL, "a one-interval epoch is legal");
    }

    // ──────────────────────── scheduleEpoch: the margin ────────

    /// @dev The edge, both ways: at `now == T0` a start of exactly `T0 + 1800` is accepted.
    function test_ScheduleEpoch_AcceptsAStartExactlyAtTheMargin() public {
        (address[] memory tokens, uint256[] memory amounts) = _two();

        registry.scheduleEpoch(1, T0 + MARGIN, T0 + MARGIN + WEEK, tokens, amounts);
        assertEq(registry.epoch(1).startsAt, T0 + MARGIN, "now + SCHEDULE_MARGIN is accepted");
    }

    /// @dev ...and one second later the same start is refused: the earliest legal start has
    ///      moved to `T0 + 1801`, which is off the grid, so the next legal start is `T0 + 2700`.
    function test_ScheduleEpoch_RejectsAStartOneSecondInsideTheMargin() public {
        (address[] memory tokens, uint256[] memory amounts) = _two();
        vm.warp(T0 + 1);

        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.StartTooSoon.selector, T0 + MARGIN, T0 + 1 + MARGIN));
        registry.scheduleEpoch(1, T0 + MARGIN, T0 + MARGIN + WEEK, tokens, amounts);

        registry.scheduleEpoch(1, T0 + MARGIN + INTERVAL, T0 + MARGIN + WEEK, tokens, amounts);
        assertEq(registry.epoch(1).startsAt, T0 + MARGIN + INTERVAL, "the next grid point is accepted");
    }

    /// @dev The plain-language example of the rule: at 10:00 a 10:15 start is refused.
    function test_ScheduleEpoch_RejectsAStartFifteenMinutesOut() public {
        (address[] memory tokens, uint256[] memory amounts) = _two();

        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.StartTooSoon.selector, T0 + INTERVAL, T0 + MARGIN));
        registry.scheduleEpoch(1, T0 + INTERVAL, T0 + WEEK, tokens, amounts);
    }

    function test_ScheduleEpoch_RejectsAStartInThePast() public {
        (address[] memory tokens, uint256[] memory amounts) = _two();

        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.StartTooSoon.selector, T0 - WEEK, T0 + MARGIN));
        registry.scheduleEpoch(1, T0 - WEEK, T0 + WEEK, tokens, amounts);
    }

    // ──────────────────────── scheduleEpoch: overlap ───────────

    function test_ScheduleEpoch_RejectsAStartBeforeThePreviousEnd() public {
        _scheduleTwo(1, S1, E1);
        (address[] memory tokens, uint256[] memory amounts) = _two();

        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.OverlapsPreviousEpoch.selector, E1 - INTERVAL, E1));
        registry.scheduleEpoch(2, E1 - INTERVAL, E1 + WEEK, tokens, amounts);
    }

    /// @dev `[startsAt, endsAt)`: an epoch may start on the very second the previous one ends.
    function test_ScheduleEpoch_AcceptsAStartExactlyAtThePreviousEnd() public {
        _scheduleTwo(1, S1, E1);
        _scheduleTwo(2, E1, E1 + WEEK);

        assertEq(registry.epoch(2).startsAt, E1, "back-to-back epochs are legal");
        assertEq(registry.epoch(2).prevLiveId, 1, "linked to its predecessor");
        assertEq(registry.lastLiveId(), 2, "the new epoch is the last live one");
    }

    function test_ScheduleEpoch_AcceptsAGapAfterThePreviousEpoch() public {
        _scheduleTwo(1, S1, E1);
        _scheduleTwo(2, E1 + 3 days, E1 + 3 days + WEEK);

        assertEq(registry.epoch(2).startsAt, E1 + 3 days, "gaps are legal");
    }

    /// @dev The overlap check reads the previous end even when that epoch is already running.
    function test_ScheduleEpoch_ChecksOverlapAgainstARunningEpoch() public {
        _scheduleTwo(1, S1, E1);
        vm.warp(S1 + 1 days);
        (address[] memory tokens, uint256[] memory amounts) = _two();

        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.OverlapsPreviousEpoch.selector, S1 + 2 days, E1));
        registry.scheduleEpoch(2, S1 + 2 days, E1 + WEEK, tokens, amounts);

        registry.scheduleEpoch(2, E1, E1 + WEEK, tokens, amounts);
        assertEq(registry.lastLiveId(), 2, "the next epoch is scheduled while the first one runs");
    }

    // ──────────────────────── scheduleEpoch: tokens ────────────

    function test_ScheduleEpoch_RejectsAnUnregisteredToken() public {
        address[] memory tokens = new address[](2);
        tokens[0] = address(asset);
        tokens[1] = address(foreign);
        uint256[] memory amounts = new uint256[](2);

        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.UnknownRewardToken.selector, address(foreign)));
        registry.scheduleEpoch(1, S1, E1, tokens, amounts);
    }

    /// @dev `isRewardToken` is `registered && enabled`: a token the timelock took off the
    ///      schedule is refused even though the distributor still knows it.
    function test_ScheduleEpoch_RejectsARegisteredButDisabledToken() public {
        distributor.setRewardTokenEnabled(address(asset), false);
        (address[] memory tokens, uint256[] memory amounts) = _two();

        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.UnknownRewardToken.selector, address(asset)));
        registry.scheduleEpoch(1, S1, E1, tokens, amounts);
    }

    function test_ScheduleEpoch_RejectsADuplicateToken() public {
        address[] memory tokens = new address[](3);
        tokens[0] = address(asset);
        tokens[1] = address(overture);
        tokens[2] = address(asset);
        uint256[] memory amounts = new uint256[](3);

        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.DuplicateToken.selector, address(asset)));
        registry.scheduleEpoch(1, S1, E1, tokens, amounts);
    }

    function test_ScheduleEpoch_AcceptsAnEmptyTokenList() public {
        registry.scheduleEpoch(1, S1, E1, new address[](0), new uint256[](0));

        assertEq(registry.epochTokens(1).length, 0, "no token on the epoch");
        assertEq(registry.epochAmount(1, address(asset)), 0, "no quantity on the epoch");
        assertEq(registry.lastLiveId(), 1, "an empty epoch is still a live epoch");
    }

    /// @dev Zero quantities are legal at scheduling time too.
    function test_ScheduleEpoch_AcceptsZeroAmounts() public {
        address[] memory tokens = new address[](1);
        tokens[0] = address(overture);
        registry.scheduleEpoch(1, S1, E1, tokens, new uint256[](1));

        assertEq(registry.epochTokens(1).length, 1, "the token is listed");
        assertEq(registry.epochAmount(1, address(overture)), 0, "with a zero quantity");
    }

    // ──────────────────────── scheduleEpoch: effects ───────────

    /// @dev The event order the indexer rebuilds the schedule from: `EpochScheduled`, then one
    ///      `EpochAmountSet` per token in `tokens[]` order.
    function test_ScheduleEpoch_EmitsTheEpochThenOneAmountPerTokenInOrder() public {
        (address[] memory tokens, uint256[] memory amounts) = _two();

        vm.expectEmit(true, false, false, true, address(registry));
        emit ILPEpochRegistry.EpochScheduled(1, S1, E1);
        vm.expectEmit(true, true, false, true, address(registry));
        emit ILPEpochRegistry.EpochAmountSet(1, address(asset), ASSET_AMOUNT);
        vm.expectEmit(true, true, false, true, address(registry));
        emit ILPEpochRegistry.EpochAmountSet(1, address(overture), OVTR_AMOUNT);
        registry.scheduleEpoch(1, S1, E1, tokens, amounts);
    }

    function test_ScheduleEpoch_StoresTheWholeRecord() public {
        _scheduleTwo(1, S1, E1);
        _scheduleTwo(2, E1, E1 + WEEK);

        ILPEpochRegistry.Epoch memory e = registry.epoch(2);
        assertEq(e.startsAt, E1, "startsAt");
        assertEq(e.endsAt, E1 + WEEK, "endsAt");
        assertEq(e.prevLiveId, 1, "prevLiveId points at the live epoch before it");
        assertFalse(e.cancelled, "live");
        assertEq(registry.epoch(1).prevLiveId, 0, "the first epoch has no predecessor");

        assertEq(registry.epochAmount(2, address(asset)), ASSET_AMOUNT, "the $ASSET quantity");
        assertEq(registry.epochAmount(2, address(overture)), OVTR_AMOUNT, "the $OVTR quantity");
        address[] memory listed = registry.epochTokens(2);
        assertEq(listed.length, 2, "two tokens listed");
        assertEq(listed[0], address(asset), "in tokens[] order");
        assertEq(listed[1], address(overture), "in tokens[] order");

        assertEq(registry.epochCount(), 2, "two ids issued");
        assertEq(registry.lastLiveId(), 2, "the last scheduled is the last live");
    }

    // ──────────────────────── setEpochAmount ───────────────────

    function test_SetEpochAmount_ChangesALiveNotStartedEpochAndAnnouncesIt() public {
        _scheduleTwo(1, S1, E1);

        vm.expectEmit(true, true, false, true, address(registry));
        emit ILPEpochRegistry.EpochAmountSet(1, address(overture), 7e18);
        registry.setEpochAmount(1, address(overture), 7e18);

        assertEq(registry.epochAmount(1, address(overture)), 7e18, "the new quantity");
        assertEq(registry.epochTokens(1).length, 2, "an already-listed token is not listed again");
    }

    function test_SetEpochAmount_AcceptsZero() public {
        _scheduleTwo(1, S1, E1);
        registry.setEpochAmount(1, address(asset), 0);

        assertEq(registry.epochAmount(1, address(asset)), 0, "a quantity can go to zero");
        assertEq(registry.epochTokens(1).length, 2, "the token stays listed at zero");
    }

    function test_SetEpochAmount_AppendsANewTokenExactlyOnce() public {
        address[] memory tokens = new address[](1);
        tokens[0] = address(asset);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = ASSET_AMOUNT;
        registry.scheduleEpoch(1, S1, E1, tokens, amounts);

        registry.setEpochAmount(1, address(overture), OVTR_AMOUNT);
        registry.setEpochAmount(1, address(overture), OVTR_AMOUNT + 1);

        address[] memory listed = registry.epochTokens(1);
        assertEq(listed.length, 2, "the new token joined once");
        assertEq(listed[0], address(asset), "the scheduled token keeps its place");
        assertEq(listed[1], address(overture), "the new token is appended");
        assertEq(registry.epochAmount(1, address(overture)), OVTR_AMOUNT + 1, "the last write wins");
    }

    /// @dev Quantities may change on ANY live epoch before its margin — not only the last one.
    function test_SetEpochAmount_WorksOnAnEarlierEpochWhileALaterOneExists() public {
        _scheduleTwo(1, S1, E1);
        _scheduleTwo(2, E1, E1 + WEEK);

        registry.setEpochAmount(1, address(asset), 1);
        assertEq(registry.epochAmount(1, address(asset)), 1, "the earlier epoch changed");
        assertEq(registry.epochAmount(2, address(asset)), ASSET_AMOUNT, "the later epoch did not");
    }

    function test_SetEpochAmount_RejectsAnUnknownEpoch() public {
        _scheduleTwo(1, S1, E1);

        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.UnknownEpoch.selector, 0));
        registry.setEpochAmount(0, address(asset), 1);
        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.UnknownEpoch.selector, 2));
        registry.setEpochAmount(2, address(asset), 1);
    }

    function test_SetEpochAmount_RejectsACancelledEpoch() public {
        _scheduleTwo(1, S1, E1);
        registry.cancelEpoch(1);

        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.EpochIsCancelled.selector, 1));
        registry.setEpochAmount(1, address(asset), 1);
    }

    /// @dev The margin edge, both ways, on a quantity change.
    function test_SetEpochAmount_FreezesExactlyAtTheMargin() public {
        _scheduleTwo(1, S1, E1);

        vm.warp(S1 - MARGIN);
        registry.setEpochAmount(1, address(asset), 1);
        assertEq(registry.epochAmount(1, address(asset)), 1, "at startsAt - 1800 the quantity can still change");

        vm.warp(S1 - MARGIN + 1);
        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.StartTooSoon.selector, S1, S1 + 1));
        registry.setEpochAmount(1, address(asset), 2);

        vm.warp(S1 + 1 days);
        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.StartTooSoon.selector, S1, S1 + 1 days + MARGIN));
        registry.setEpochAmount(1, address(asset), 2);
    }

    function test_SetEpochAmount_RejectsAnUnregisteredOrDisabledToken() public {
        _scheduleTwo(1, S1, E1);

        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.UnknownRewardToken.selector, address(foreign)));
        registry.setEpochAmount(1, address(foreign), 1);

        distributor.setRewardTokenEnabled(address(overture), false);
        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.UnknownRewardToken.selector, address(overture)));
        registry.setEpochAmount(1, address(overture), 1);
    }

    function test_SetEpochAmount_RejectsEveryoneButTheOperator() public {
        LPEpochRegistry split = _deployRegistryProxy(address(distributor), multisig, operatorSafe);
        (address[] memory tokens, uint256[] memory amounts) = _two();
        vm.prank(operatorSafe);
        split.scheduleEpoch(1, S1, E1, tokens, amounts);

        vm.prank(multisig);
        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.NotOperator.selector, multisig, operatorSafe));
        split.setEpochAmount(1, address(asset), 1);
    }

    // ──────────────────────── updateEpochBounds ────────────────

    function test_UpdateEpochBounds_MovesTheLastEpochAndAnnouncesIt() public {
        _scheduleTwo(1, S1, E1);
        _scheduleTwo(2, E1, E1 + WEEK);

        vm.expectEmit(true, false, false, true, address(registry));
        emit ILPEpochRegistry.EpochUpdated(2, E1 + 1 days, E1 + 2 * WEEK);
        registry.updateEpochBounds(2, E1 + 1 days, E1 + 2 * WEEK);

        ILPEpochRegistry.Epoch memory e = registry.epoch(2);
        assertEq(e.startsAt, E1 + 1 days, "the new start");
        assertEq(e.endsAt, E1 + 2 * WEEK, "the new end");
        assertEq(e.prevLiveId, 1, "the link is unchanged");
        assertEq(registry.epochAmount(2, address(overture)), OVTR_AMOUNT, "quantities are unchanged");
    }

    /// @dev The only live epoch has no neighbour, so it may move anywhere past the margin —
    ///      earlier included.
    function test_UpdateEpochBounds_MovesTheOnlyEpochEarlier() public {
        _scheduleTwo(1, S1, E1);
        registry.updateEpochBounds(1, T0 + MARGIN, T0 + MARGIN + WEEK);

        assertEq(registry.epoch(1).startsAt, T0 + MARGIN, "moved earlier, to the margin edge");
    }

    function test_UpdateEpochBounds_RejectsAnyEpochButTheLastLiveOne() public {
        _scheduleTwo(1, S1, E1);
        _scheduleTwo(2, E1, E1 + WEEK);
        _scheduleTwo(3, E1 + WEEK, E1 + 2 * WEEK);
        registry.cancelEpoch(3);

        // An earlier live epoch.
        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.NotLastLiveEpoch.selector, 1, 2));
        registry.updateEpochBounds(1, S1, E1);
        // A cancelled epoch, even though it was the last ever scheduled.
        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.NotLastLiveEpoch.selector, 3, 2));
        registry.updateEpochBounds(3, E1 + WEEK, E1 + 2 * WEEK);
        // Id zero and an id never issued.
        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.NotLastLiveEpoch.selector, 0, 2));
        registry.updateEpochBounds(0, S1, E1);
        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.NotLastLiveEpoch.selector, 9, 2));
        registry.updateEpochBounds(9, S1, E1);
    }

    /// @dev Id zero is refused even when there is no live epoch at all (`lastLiveId == 0`).
    function test_UpdateEpochBounds_RejectsIdZeroWithNothingLive() public {
        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.NotLastLiveEpoch.selector, 0, 0));
        registry.updateEpochBounds(0, S1, E1);
    }

    /// @dev The lock on the CURRENT start: an epoch inside its margin cannot be moved, however
    ///      far out the new bounds would put it.
    function test_UpdateEpochBounds_FreezesOnTheCurrentStart() public {
        _scheduleTwo(1, S1, E1);
        vm.warp(S1 - MARGIN + 1);

        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.StartTooSoon.selector, S1, S1 + 1));
        registry.updateEpochBounds(1, S1 + WEEK, E1 + WEEK);
    }

    /// @dev ...and exactly at `startsAt - 1800` it can still move.
    function test_UpdateEpochBounds_StillMovesExactlyAtTheMargin() public {
        _scheduleTwo(1, S1, E1);
        vm.warp(S1 - MARGIN);

        registry.updateEpochBounds(1, S1 + INTERVAL, E1);
        assertEq(registry.epoch(1).startsAt, S1 + INTERVAL, "moved on the last legal second");
    }

    /// @dev The lock on the NEW start: an epoch far out cannot be pulled inside the margin.
    function test_UpdateEpochBounds_RejectsANewStartInsideTheMargin() public {
        _scheduleTwo(1, S1, E1);

        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.StartTooSoon.selector, T0 + INTERVAL, T0 + MARGIN));
        registry.updateEpochBounds(1, T0 + INTERVAL, E1);
    }

    function test_UpdateEpochBounds_EnforcesTheGridAndTheOrder() public {
        _scheduleTwo(1, S1, E1);

        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.NotOnGrid.selector, S1 + 5));
        registry.updateEpochBounds(1, S1 + 5, E1);
        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.NotOnGrid.selector, E1 + 5));
        registry.updateEpochBounds(1, S1, E1 + 5);
        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.InvalidBounds.selector, E1, S1));
        registry.updateEpochBounds(1, E1, S1);
    }

    function test_UpdateEpochBounds_RejectsOverlapWithThePreviousLiveEpoch() public {
        _scheduleTwo(1, S1, E1);
        _scheduleTwo(2, E1 + 1 days, E1 + WEEK);

        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.OverlapsPreviousEpoch.selector, E1 - INTERVAL, E1));
        registry.updateEpochBounds(2, E1 - INTERVAL, E1 + WEEK);

        registry.updateEpochBounds(2, E1, E1 + WEEK);
        assertEq(registry.epoch(2).startsAt, E1, "pulled back flush against the previous epoch");
    }

    function test_UpdateEpochBounds_RejectsEveryoneButTheOperator() public {
        LPEpochRegistry split = _deployRegistryProxy(address(distributor), multisig, operatorSafe);
        (address[] memory tokens, uint256[] memory amounts) = _two();
        vm.prank(operatorSafe);
        split.scheduleEpoch(1, S1, E1, tokens, amounts);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.NotOperator.selector, stranger, operatorSafe));
        split.updateEpochBounds(1, S1, E1 + WEEK);
    }

    // ──────────────────────── cancelEpoch ──────────────────────

    function test_CancelEpoch_RemovesTheLastEpochAndAnnouncesIt() public {
        _scheduleTwo(1, S1, E1);
        _scheduleTwo(2, E1, E1 + WEEK);

        vm.expectEmit(true, false, false, true, address(registry));
        emit ILPEpochRegistry.EpochCancelled(2);
        registry.cancelEpoch(2);

        assertTrue(registry.epoch(2).cancelled, "flagged cancelled");
        assertEq(registry.lastLiveId(), 1, "the chain falls back to its predecessor");
        assertEq(registry.epochCount(), 2, "the id stays issued");
        assertEq(registry.epochAmount(2, address(overture)), OVTR_AMOUNT, "its record stays readable");
    }

    /**
     * @dev The relinking, over a chain of three: cancelling 3 then 2 walks `lastLiveId` back to
     *      1; the next schedule takes id 4 (ids are never reused), links to 1, and may start
     *      where 1 ends — the window the two cancelled epochs held is free again.
     */
    function test_CancelEpoch_RelinksAndNeverReusesIds() public {
        _scheduleTwo(1, S1, E1);
        _scheduleTwo(2, E1, E1 + WEEK);
        _scheduleTwo(3, E1 + WEEK, E1 + 2 * WEEK);

        registry.cancelEpoch(3);
        assertEq(registry.lastLiveId(), 2, "after cancelling 3");
        registry.cancelEpoch(2);
        assertEq(registry.lastLiveId(), 1, "after cancelling 2");

        (address[] memory tokens, uint256[] memory amounts) = _two();
        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.UnexpectedEpochId.selector, 2, 4));
        registry.scheduleEpoch(2, E1, E1 + WEEK, tokens, amounts);
        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.UnexpectedEpochId.selector, 3, 4));
        registry.scheduleEpoch(3, E1, E1 + WEEK, tokens, amounts);

        registry.scheduleEpoch(4, E1, E1 + WEEK, tokens, amounts);
        assertEq(registry.epochCount(), 4, "id 4 issued");
        assertEq(registry.lastLiveId(), 4, "id 4 is the last live epoch");
        assertEq(registry.epoch(4).prevLiveId, 1, "linked past the two cancelled ids, to 1");
        assertTrue(registry.epoch(2).cancelled, "2 stays cancelled");
        assertTrue(registry.epoch(3).cancelled, "3 stays cancelled");
    }

    /// @dev Cancelling the only live epoch leaves nothing live; the next epoch has no
    ///      predecessor and may even start before the cancelled one would have.
    function test_CancelEpoch_TheOnlyEpochLeavesNothingLive() public {
        _scheduleTwo(1, S1, E1);
        registry.cancelEpoch(1);
        assertEq(registry.lastLiveId(), 0, "nothing live");

        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.NotLastLiveEpoch.selector, 1, 0));
        registry.cancelEpoch(1);

        (address[] memory tokens, uint256[] memory amounts) = _two();
        registry.scheduleEpoch(2, T0 + MARGIN, T0 + MARGIN + INTERVAL, tokens, amounts);
        assertEq(registry.epoch(2).prevLiveId, 0, "no predecessor");
    }

    function test_CancelEpoch_RejectsAnyEpochButTheLastLiveOne() public {
        _scheduleTwo(1, S1, E1);
        _scheduleTwo(2, E1, E1 + WEEK);

        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.NotLastLiveEpoch.selector, 1, 2));
        registry.cancelEpoch(1);
        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.NotLastLiveEpoch.selector, 0, 2));
        registry.cancelEpoch(0);
        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.NotLastLiveEpoch.selector, 3, 2));
        registry.cancelEpoch(3);
    }

    /// @dev The margin edge, both ways, on a cancellation.
    function test_CancelEpoch_FreezesExactlyAtTheMargin() public {
        _scheduleTwo(1, S1, E1);
        _scheduleTwo(2, E1, E1 + WEEK);

        vm.warp(E1 - MARGIN + 1);
        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.StartTooSoon.selector, E1, E1 + 1));
        registry.cancelEpoch(2);

        vm.warp(E1 - MARGIN);
        registry.cancelEpoch(2);
        assertTrue(registry.epoch(2).cancelled, "cancelled on the last legal second");
    }

    /// @dev A running epoch cannot be cancelled.
    function test_CancelEpoch_RejectsARunningEpoch() public {
        _scheduleTwo(1, S1, E1);
        vm.warp(S1 + 1);

        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.StartTooSoon.selector, S1, S1 + 1 + MARGIN));
        registry.cancelEpoch(1);
    }

    function test_CancelEpoch_RejectsEveryoneButTheOperator() public {
        LPEpochRegistry split = _deployRegistryProxy(address(distributor), multisig, operatorSafe);
        (address[] memory tokens, uint256[] memory amounts) = _two();
        vm.prank(operatorSafe);
        split.scheduleEpoch(1, S1, E1, tokens, amounts);

        vm.prank(multisig);
        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.NotOperator.selector, multisig, operatorSafe));
        split.cancelEpoch(1);
    }

    // ──────────────────────── currentEpoch ─────────────────────

    /// @dev `[startsAt, endsAt)` across a schedule with a gap: before the first epoch, at each
    ///      inclusive start, at each exclusive end, inside the gap, and after the last.
    function test_CurrentEpoch_FollowsTheScheduleAcrossAGap() public {
        uint64 s2 = E1 + 1 days;
        uint64 e2 = s2 + WEEK;
        _scheduleTwo(1, S1, E1);
        _scheduleTwo(2, s2, e2);

        _assertCurrentAt(T0, 0, "before the first epoch");
        _assertCurrentAt(S1 - 1, 0, "one second before the first start");
        _assertCurrentAt(S1, 1, "startsAt is inclusive");
        _assertCurrentAt(E1 - 1, 1, "the last second of epoch 1");
        _assertCurrentAt(E1, 0, "endsAt is exclusive: the gap starts");
        _assertCurrentAt(s2 - 1, 0, "the last second of the gap");
        _assertCurrentAt(s2, 2, "epoch 2 starts");
        _assertCurrentAt(e2 - 1, 2, "the last second of epoch 2");
        _assertCurrentAt(e2, 0, "after the last epoch");
        _assertCurrentAt(e2 + 365 days, 0, "long after the last epoch");
    }

    function test_CurrentEpoch_HandsOverAtABackToBackBoundary() public {
        _scheduleTwo(1, S1, E1);
        _scheduleTwo(2, E1, E1 + WEEK);

        _assertCurrentAt(E1 - 1, 1, "epoch 1 until its last second");
        _assertCurrentAt(E1, 2, "epoch 2 from the very second epoch 1 ends");
    }

    /// @dev Cancelled epochs are skipped by the walk: their window reads as no epoch, and a
    ///      later replacement is found through the relinked chain.
    function test_CurrentEpoch_SkipsCancelledEpochs() public {
        _scheduleTwo(1, S1, E1);
        _scheduleTwo(2, E1, E1 + WEEK);
        _scheduleTwo(3, E1 + WEEK, E1 + 2 * WEEK);
        registry.cancelEpoch(3);
        registry.cancelEpoch(2);
        _scheduleTwo(4, E1 + 3 * WEEK, E1 + 4 * WEEK);

        _assertCurrentAt(S1, 1, "epoch 1 is live");
        _assertCurrentAt(E1, 0, "cancelled epoch 2's window is no epoch");
        _assertCurrentAt(E1 + WEEK, 0, "cancelled epoch 3's window is no epoch");
        _assertCurrentAt(E1 + 3 * WEEK, 4, "the replacement is found through the relinked chain");
    }

    // ──────────────────────── Owner tier ───────────────────────

    function test_SetOperator_MovesTheRoleAndAnnouncesBothSides() public {
        LPEpochRegistry split = _deployRegistryProxy(address(distributor), multisig, operatorSafe);

        vm.expectEmit(false, false, false, true, address(split));
        emit ILPEpochRegistry.OperatorSet(operatorSafe, bob);
        vm.prank(multisig);
        split.setOperator(bob);
        assertEq(split.operator(), bob, "the role moved");

        (address[] memory tokens, uint256[] memory amounts) = _two();
        vm.prank(operatorSafe);
        vm.expectRevert(abi.encodeWithSelector(ILPEpochRegistry.NotOperator.selector, operatorSafe, bob));
        split.scheduleEpoch(1, S1, E1, tokens, amounts);

        vm.prank(bob);
        split.scheduleEpoch(1, S1, E1, tokens, amounts);
        assertEq(split.epochCount(), 1, "the new operator schedules");
    }

    /// @dev The operator cannot move its own role: losing the multisig is recovered through the
    ///      timelock, never by the multisig itself.
    function test_SetOperator_RejectsTheOperatorAndStrangers() public {
        LPEpochRegistry split = _deployRegistryProxy(address(distributor), multisig, operatorSafe);

        address[2] memory callers = [operatorSafe, stranger];
        for (uint256 i = 0; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, callers[i]));
            split.setOperator(callers[i]);
        }
    }

    function test_SetOperator_RejectsZero() public {
        vm.expectRevert(ILPEpochRegistry.ZeroAddress.selector);
        registry.setOperator(address(0));
    }

    function test_RenounceOwnership_IsDisabled() public {
        vm.expectRevert(ILPEpochRegistry.RenounceDisabled.selector);
        registry.renounceOwnership();

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, stranger));
        registry.renounceOwnership();
    }

    // ──────────────────────── Upgrade ──────────────────────────

    /**
     * @dev The upgrade claim, measured: every epoch, quantity, token list, cancellation, the
     *      count, the live chain and both roles read the same after the code is swapped, and the
     *      V2 reinitializer runs once inside the upgrade call.
     */
    function test_Upgrade_ByTheOwnerKeepsTheWholeSchedule() public {
        _scheduleTwo(1, S1, E1);
        _scheduleTwo(2, E1, E1 + WEEK);
        _scheduleTwo(3, E1 + WEEK, E1 + 2 * WEEK);
        registry.cancelEpoch(3);
        registry.setEpochAmount(2, address(asset), 11);

        LPEpochRegistryV2Mock v2 = new LPEpochRegistryV2Mock(address(distributor));
        registry.upgradeToAndCall(address(v2), abi.encodeCall(LPEpochRegistryV2Mock.initializeV2, (77)));

        LPEpochRegistryV2Mock upgraded = LPEpochRegistryV2Mock(address(registry));
        assertEq(
            address(uint160(uint256(vm.load(address(registry), ERC1967Utils.IMPLEMENTATION_SLOT)))),
            address(v2),
            "the ERC-1967 slot names V2"
        );
        assertEq(upgraded.version(), 2, "the proxy runs V2 code");
        assertEq(upgraded.upgradeMarker(), 77, "the reinitializer ran in the upgrade call");

        assertEq(registry.epochCount(), 3, "the count survives");
        assertEq(registry.lastLiveId(), 2, "the live chain survives");
        assertEq(registry.epoch(2).startsAt, E1, "epoch records survive");
        assertEq(registry.epoch(2).prevLiveId, 1, "links survive");
        assertTrue(registry.epoch(3).cancelled, "cancellations survive");
        assertEq(registry.epochAmount(2, address(asset)), 11, "quantities survive");
        assertEq(registry.epochAmount(1, address(overture)), OVTR_AMOUNT, "every quantity survives");
        assertEq(registry.epochTokens(2).length, 2, "token lists survive");
        assertEq(registry.operator(), address(this), "the operator survives");
        assertEq(registry.owner(), address(this), "the owner survives");
        assertEq(registry.distributor(), address(distributor), "V2 is bound to the same distributor");

        // The schedule keeps working under V2.
        _scheduleTwo(4, E1 + WEEK, E1 + 2 * WEEK);
        assertEq(registry.epoch(4).prevLiveId, 2, "scheduling continues from the surviving chain");

        vm.expectRevert(Initializable.InvalidInitialization.selector);
        upgraded.initializeV2(78);
    }

    function test_Upgrade_RejectsEveryoneButTheOwner() public {
        LPEpochRegistry split = _deployRegistryProxy(address(distributor), multisig, operatorSafe);
        LPEpochRegistryV2Mock v2 = new LPEpochRegistryV2Mock(address(distributor));

        address[2] memory callers = [operatorSafe, stranger];
        for (uint256 i = 0; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, callers[i]));
            split.upgradeToAndCall(address(v2), "");
        }
    }

    // ──────────────────────── Storage ──────────────────────────

    /**
     * @dev The namespace and its layout, pinned. The slot literal is recomputed from the
     *      ERC-7201 formula, and every field is read straight out of the proxy at the offset the
     *      layout puts it: `operator` + `epochCount` packed in slot 0, `lastLiveId` in slot 1,
     *      then the three mappings at slots 2, 3 and 4.
     */
    function test_Storage_LivesAtThePinnedErc7201Slot() public {
        bytes32 base =
            keccak256(abi.encode(uint256(keccak256("real.lp.storage.LPEpochRegistry")) - 1)) & ~bytes32(uint256(0xff));
        assertEq(base, REGISTRY_STORAGE, "the pinned literal is the ERC-7201 slot");

        _scheduleTwo(1, S1, E1);
        _scheduleTwo(2, E1, E1 + WEEK);
        _scheduleTwo(3, E1 + WEEK, E1 + 2 * WEEK);
        registry.cancelEpoch(3);
        uint256 b = uint256(base);

        uint256 slot0 = uint256(vm.load(address(registry), base));
        assertEq(address(uint160(slot0)), address(this), "slot 0, low 20 bytes: `operator`");
        assertEq(uint64(slot0 >> 160), 3, "slot 0, next 8 bytes: `epochCount`");

        uint256 slot1 = uint256(vm.load(address(registry), bytes32(b + 1)));
        assertEq(uint64(slot1), 2, "slot 1: `lastLiveId`");

        uint256 rec2 = uint256(vm.load(address(registry), keccak256(abi.encode(uint256(2), b + 2))));
        assertEq(uint64(rec2), E1, "epochs[2].startsAt, bytes 0-7");
        assertEq(uint64(rec2 >> 64), E1 + WEEK, "epochs[2].endsAt, bytes 8-15");
        assertEq(uint64(rec2 >> 128), 1, "epochs[2].prevLiveId, bytes 16-23");
        assertEq(uint8(rec2 >> 192), 0, "epochs[2].cancelled, byte 24: live");
        uint256 rec3 = uint256(vm.load(address(registry), keccak256(abi.encode(uint256(3), b + 2))));
        assertEq(uint8(rec3 >> 192), 1, "epochs[3].cancelled, byte 24: cancelled");

        bytes32 amountsOf2 = keccak256(abi.encode(uint256(2), b + 3));
        assertEq(
            uint256(vm.load(address(registry), keccak256(abi.encode(address(overture), amountsOf2)))),
            OVTR_AMOUNT,
            "amounts[2][$OVTR] at keccak(token, keccak(id, base + 3))"
        );

        bytes32 tokensOf2 = keccak256(abi.encode(uint256(2), b + 4));
        assertEq(uint256(vm.load(address(registry), tokensOf2)), 2, "tokens[2].length at keccak(id, base + 4)");
        assertEq(
            address(uint160(uint256(vm.load(address(registry), keccak256(abi.encode(tokensOf2)))))),
            address(asset),
            "tokens[2][0]"
        );
        assertEq(
            address(
                uint160(uint256(vm.load(address(registry), bytes32(uint256(keccak256(abi.encode(tokensOf2))) + 1))))
            ),
            address(overture),
            "tokens[2][1]"
        );
    }

    // ──────────────────────── Helpers ──────────────────────────

    function _two() internal view returns (address[] memory tokens, uint256[] memory amounts) {
        tokens = new address[](2);
        tokens[0] = address(asset);
        tokens[1] = address(overture);
        amounts = new uint256[](2);
        amounts[0] = ASSET_AMOUNT;
        amounts[1] = OVTR_AMOUNT;
    }

    function _scheduleTwo(uint256 id, uint64 startsAt, uint64 endsAt) internal {
        (address[] memory tokens, uint256[] memory amounts) = _two();
        registry.scheduleEpoch(id, startsAt, endsAt, tokens, amounts);
    }

    function _assertCurrentAt(uint64 timestamp, uint256 expected, string memory label) internal {
        vm.warp(timestamp);
        assertEq(registry.currentEpoch(), expected, label);
    }
}
