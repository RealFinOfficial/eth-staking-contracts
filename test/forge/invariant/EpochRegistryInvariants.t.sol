// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LocalHarness} from "../utils/LocalHarness.sol";
import {LPEpochRegistry} from "../../../contracts/lp-staking/LPEpochRegistry.sol";
import {RewardsDistributor} from "../../../contracts/lp-staking/RewardsDistributor.sol";
import {ILPEpochRegistry} from "../../../contracts/lp-staking/interfaces/ILPEpochRegistry.sol";
import {MockERC20Permit} from "../../../contracts/lp-staking/mocks/MockERC20Permit.sol";

/**
 * @notice Bounded operator driving {LPEpochRegistry} through arbitrary interleavings of
 *         schedules, quantity changes, bound moves, cancellations and the passage of time — plus
 *         the timelock switching reward tokens on and off the schedule at the distributor.
 *
 *  Every write is a real attempt: most are built to be legal against the registry's current
 *  state (so the chain actually grows), the rest are deliberately wrong (an id that is not the
 *  next, a start inside the margin or off the grid, an overlap, an unregistered token). Every
 *  revert is swallowed, so the invariants judge only what the registry ACCEPTED.
 *
 *  Two ghosts carry the time-dependent half of the argument:
 *    - a FROZEN record per epoch, taken the first time the handler sees the epoch inside its
 *      margin (`startsAt < now + 1800`) and again at the moment it is cancelled. Time only
 *      moves inside {warp}, and the handler re-freezes before and after every action, so no
 *      write can slip between an epoch locking and its record being taken;
 *    - a flag set if any accepted write named a token that `isRewardToken` refused at the
 *      moment of the write.
 */
contract EpochRegistryHandler is Test {
    LPEpochRegistry internal immutable registry;
    RewardsDistributor internal immutable distributor;
    /// @dev The registry's operator and the distributor's owner (the test contract in the
    ///      local harness), impersonated per call.
    address internal immutable operator;
    address internal immutable distributorOwner;

    /// @dev $ASSET, $OVTR (both registered) and a token the distributor never heard of.
    address[3] internal tokens;

    uint64 internal constant INTERVAL = 900;
    uint64 internal constant MARGIN = 1800;

    // ──────────────────────── Ghosts ───────────────────────────

    uint256 public calls;
    uint256 public schedules;
    uint256 public amountWrites;
    uint256 public updates;
    uint256 public cancels;
    /// @notice Ids the registry accepted, in order. Equal to `epochCount` if no id is reused.
    uint256 public issued;
    /// @notice Set if an accepted write named a token `isRewardToken` refused at write time.
    bool public wroteForANonRewardToken;
    /// @notice Schedules built to be legal in every respect (next id, legal window, only
    ///         accepted tokens). Every one of them must be accepted.
    uint256 public legalScheduleAttempts;
    /// @notice Set if a schedule built to be legal was refused — the liveness half: the rules
    ///         must not refuse what they claim to allow.
    bool public legalScheduleRefused;

    struct Frozen {
        bool taken;
        uint64 startsAt;
        uint64 endsAt;
        uint64 prevLiveId;
        bool cancelled;
        uint256 tokenCount;
        uint256[3] amounts;
    }

    mapping(uint256 => Frozen) internal frozen;
    mapping(uint256 => bool) public everCancelled;

    constructor(
        LPEpochRegistry registry_,
        RewardsDistributor distributor_,
        address operator_,
        address distributorOwner_,
        address[3] memory tokens_
    ) {
        registry = registry_;
        distributor = distributor_;
        operator = operator_;
        distributorOwner = distributorOwner_;
        tokens = tokens_;
    }

    modifier step() {
        calls++;
        _freezeLocked();
        _;
        _freezeLocked();
    }

    // ──────────────────────── Actions ──────────────────────────

    function schedule(uint256 seed) external step {
        uint256 count = registry.epochCount();
        uint256 id = seed % 8 == 0 ? bound(seed >> 8, 0, count + 3) : count + 1;

        (uint64 startsAt, uint64 endsAt, bool legalWindow) = _bounds(seed, registry.lastLiveId());
        (address[] memory list, uint256[] memory amounts, bool anyRefused) = _tokenList(seed >> 128);
        bool legal = legalWindow && id == count + 1 && !anyRefused;
        if (legal) legalScheduleAttempts++;

        vm.prank(operator);
        try registry.scheduleEpoch(id, startsAt, endsAt, list, amounts) {
            schedules++;
            issued++;
            if (anyRefused) wroteForANonRewardToken = true;
        } catch {
            if (legal) legalScheduleRefused = true;
        }
    }

    function setAmount(uint256 idSeed, uint256 tokenSeed, uint256 amount) external step {
        // Mostly the last live epoch (the one most likely still outside its margin), sometimes
        // any id at all; mostly a reward token, sometimes the unregistered one.
        uint256 id = idSeed % 10 < 7 ? registry.lastLiveId() : bound(idSeed >> 8, 0, registry.epochCount() + 1);
        address token = tokens[tokenSeed % 5 == 0 ? 2 : tokenSeed % 2];
        bool refused = !distributor.isRewardToken(token);
        amount = bound(amount, 0, 1e30);

        vm.prank(operator);
        try registry.setEpochAmount(id, token, amount) {
            amountWrites++;
            if (refused) wroteForANonRewardToken = true;
        } catch {}
    }

    function updateBounds(uint256 seed) external step {
        uint256 last = registry.lastLiveId();
        uint256 id = seed % 6 == 0 ? bound(seed >> 8, 0, registry.epochCount() + 1) : last;
        uint64 prev = id == 0 ? 0 : registry.epoch(id).prevLiveId;
        (uint64 startsAt, uint64 endsAt,) = _bounds(seed >> 16, prev);

        vm.prank(operator);
        try registry.updateEpochBounds(id, startsAt, endsAt) {
            updates++;
        } catch {}
    }

    function cancel(uint256 seed) external step {
        uint256 id = seed % 6 == 0 ? bound(seed >> 8, 0, registry.epochCount() + 1) : registry.lastLiveId();

        vm.prank(operator);
        try registry.cancelEpoch(id) {
            cancels++;
            everCancelled[id] = true;
            _snapshot(id); // a cancelled epoch is frozen forever from this moment
        } catch {}
    }

    function warp(uint256 seed) external step {
        vm.warp(block.timestamp + bound(seed, 0, 12 hours));
    }

    /// @dev The timelock takes $ASSET or $OVTR off the schedule, or puts it back.
    function toggleEnabled(uint256 seed) external step {
        address token = tokens[seed % 2];
        bool enabledNow = distributor.isRewardToken(token);
        vm.prank(distributorOwner);
        distributor.setRewardTokenEnabled(token, !enabledNow);
    }

    // ──────────────────────── Views for the invariants ─────────

    function frozenOf(uint256 id) external view returns (Frozen memory) {
        return frozen[id];
    }

    function tokenAt(uint256 i) external view returns (address) {
        return tokens[i];
    }

    // ──────────────────────── Internals ────────────────────────

    /// @dev Mostly a legal next window (after `prevId`'s end and past the margin, on the grid),
    ///      sometimes one of the illegal shapes; `legal` says which.
    function _bounds(uint256 seed, uint256 prevId) internal view returns (uint64 startsAt, uint64 endsAt, bool legal) {
        uint64 earliest = _ceil(uint64(block.timestamp) + MARGIN);
        uint64 prevEnd = prevId == 0 ? 0 : registry.epoch(prevId).endsAt;
        uint64 floor_ = prevEnd > earliest ? prevEnd : earliest;
        // Anywhere from the earliest legal start to about two days later, so some epochs stay
        // open across several warps and others lock almost at once.
        startsAt = floor_ + uint64(seed % 192) * INTERVAL;
        endsAt = startsAt + uint64(1 + (seed >> 8) % 96) * INTERVAL;

        legal = true;
        uint256 shape = (seed >> 24) % 10;
        if (shape == 0) {
            startsAt += uint64(1 + (seed >> 32) % 899); // off the grid
            legal = false;
        } else if (shape == 1) {
            startsAt = earliest - 2 * INTERVAL; // inside the margin
            legal = false;
        } else if (shape == 2 && prevEnd > INTERVAL) {
            startsAt = prevEnd - INTERVAL; // overlap (or, if prev ended long ago, inside the margin)
            legal = false;
        } else if (shape == 3) {
            endsAt = startsAt; // empty window
            legal = false;
        }
    }

    function _tokenList(uint256 seed)
        internal
        view
        returns (address[] memory list, uint256[] memory amounts, bool anyRefused)
    {
        uint256 n = seed % 3; // 0, 1 or 2 tokens
        list = new address[](n);
        amounts = new uint256[](n);
        // One draw in five starts the list at the unregistered token.
        uint256 first = (seed >> 4) % 5 == 0 ? 2 : (seed >> 8) % 2;
        for (uint256 i = 0; i < n; ++i) {
            address token = tokens[(first + i) % 3];
            list[i] = token;
            amounts[i] = (seed >> (16 + 8 * i)) % 1e24;
            if (!distributor.isRewardToken(token)) anyRefused = true;
        }
    }

    /// @dev Records every issued epoch that has entered its margin and has no record yet.
    function _freezeLocked() internal {
        uint256 count = registry.epochCount();
        for (uint256 id = 1; id <= count; ++id) {
            if (frozen[id].taken) continue;
            if (uint256(registry.epoch(id).startsAt) < block.timestamp + MARGIN) _snapshot(id);
        }
    }

    function _snapshot(uint256 id) internal {
        ILPEpochRegistry.Epoch memory e = registry.epoch(id);
        Frozen storage f = frozen[id];
        f.taken = true;
        f.startsAt = e.startsAt;
        f.endsAt = e.endsAt;
        f.prevLiveId = e.prevLiveId;
        f.cancelled = e.cancelled;
        f.tokenCount = registry.epochTokens(id).length;
        for (uint256 i = 0; i < 3; ++i) {
            f.amounts[i] = registry.epochAmount(id, tokens[i]);
        }
    }

    function _ceil(uint64 t) internal pure returns (uint64) {
        return ((t + INTERVAL - 1) / INTERVAL) * INTERVAL;
    }
}

/**
 * @notice Why this file exists: the unit and fuzz suites prove the registry's gates call by
 *         call. Only a campaign proves the SCHEDULE they are meant to produce survives an
 *         arbitrary interleaving of every operator write and the passage of time:
 *
 *    1. live epochs (walked from `lastLiveId` through `prevLiveId`) never overlap and are
 *       strictly ordered by id and by time;
 *    2. ids are never reused: `epochCount` equals the number of accepted schedules, and an id
 *       once cancelled stays cancelled;
 *    3. nothing about an epoch changes once it is inside its margin (`now > startsAt - 1800`) —
 *       nor after it was cancelled;
 *    4. every bound of every issued epoch sits on the 900-second grid;
 *    5. every quantity ever written named a token the distributor accepted at that moment, and
 *       every token listed on an epoch is one the distributor registered.
 */
contract EpochRegistryInvariantsTest is LocalHarness {
    EpochRegistryHandler internal handler;
    MockERC20Permit internal foreign;

    uint64 internal constant T0 = 1_800_000_000;
    uint256 internal constant ANTI_VACUITY_MIN_CALLS = 10;

    function setUp() public {
        _deployLocalStack();
        vm.warp(T0);
        foreign = new MockERC20Permit("Foreign", "FRN", 1e30, 18);

        handler = new EpochRegistryHandler(
            registry,
            distributor,
            registry.operator(),
            distributor.owner(),
            [address(asset), address(overture), address(foreign)]
        );

        bytes4[] memory selectors = new bytes4[](9);
        selectors[0] = EpochRegistryHandler.schedule.selector;
        selectors[1] = EpochRegistryHandler.schedule.selector; // the chain must grow, x2
        selectors[2] = EpochRegistryHandler.setAmount.selector;
        selectors[3] = EpochRegistryHandler.setAmount.selector;
        selectors[4] = EpochRegistryHandler.updateBounds.selector;
        selectors[5] = EpochRegistryHandler.cancel.selector;
        selectors[6] = EpochRegistryHandler.warp.selector;
        selectors[7] = EpochRegistryHandler.warp.selector;
        selectors[8] = EpochRegistryHandler.toggleEnabled.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// @dev (1) The live chain is a strictly increasing sequence of disjoint windows.
    function invariant_LiveEpochsAreOrderedAndNeverOverlap() public view {
        uint256 id = registry.lastLiveId();
        while (id != 0) {
            ILPEpochRegistry.Epoch memory e = registry.epoch(id);
            assertFalse(e.cancelled, "a cancelled epoch is never on the live chain");
            assertLt(e.startsAt, e.endsAt, "every live epoch is a non-empty window");
            uint256 prev = e.prevLiveId;
            if (prev != 0) {
                assertLt(prev, id, "the live chain is ordered by id");
                assertLe(registry.epoch(prev).endsAt, e.startsAt, "live epochs never overlap and are ordered in time");
            }
            id = prev;
        }
    }

    /// @dev (2) Ids are issued once each; cancellation is permanent.
    function invariant_IdsAreNeverReused() public view {
        uint256 count = registry.epochCount();
        assertEq(count, handler.issued(), "epochCount is exactly the number of accepted schedules");
        assertLe(registry.lastLiveId(), count, "lastLiveId is an issued id");
        for (uint256 id = 1; id <= count; ++id) {
            if (handler.everCancelled(id)) {
                assertTrue(registry.epoch(id).cancelled, "a cancelled id stays cancelled forever");
            }
        }
    }

    /// @dev (3) Inside the margin — or once cancelled — an epoch is frozen: bounds, link, flag,
    ///      token list and every quantity read exactly as they did when the record was taken.
    function invariant_NothingChangesInsideTheMargin() public view {
        uint256 count = registry.epochCount();
        for (uint256 id = 1; id <= count; ++id) {
            EpochRegistryHandler.Frozen memory f = handler.frozenOf(id);
            if (!f.taken) continue;
            ILPEpochRegistry.Epoch memory e = registry.epoch(id);
            assertEq(e.startsAt, f.startsAt, "a frozen epoch's start never moves");
            assertEq(e.endsAt, f.endsAt, "a frozen epoch's end never moves");
            assertEq(e.prevLiveId, f.prevLiveId, "a frozen epoch's link never moves");
            if (f.cancelled) assertTrue(e.cancelled, "a frozen cancellation is permanent");
            // A live frozen epoch can never be cancelled: cancelling needs it outside the margin.
            if (!f.cancelled) assertFalse(e.cancelled, "an epoch inside its margin cannot be cancelled");
            assertEq(registry.epochTokens(id).length, f.tokenCount, "a frozen epoch gains no token");
            for (uint256 i = 0; i < 3; ++i) {
                assertEq(registry.epochAmount(id, handler.tokenAt(i)), f.amounts[i], "a frozen quantity never moves");
            }
        }
    }

    /// @dev (4) The grid holds for every issued epoch, cancelled ones included.
    function invariant_EveryBoundIsOnTheGrid() public view {
        uint256 count = registry.epochCount();
        for (uint256 id = 1; id <= count; ++id) {
            ILPEpochRegistry.Epoch memory e = registry.epoch(id);
            assertEq(e.startsAt % 900, 0, "startsAt is on the 900-s grid");
            assertEq(e.endsAt % 900, 0, "endsAt is on the 900-s grid");
        }
    }

    /// @dev (5) No accepted write ever named a token the distributor refused at that moment, and
    ///      every token on every epoch is a registered reward token.
    function invariant_EveryAmountNamesARegisteredToken() public view {
        assertFalse(handler.wroteForANonRewardToken(), "an amount was accepted for a non-reward token");
        uint256 count = registry.epochCount();
        for (uint256 id = 1; id <= count; ++id) {
            address[] memory listed = registry.epochTokens(id);
            for (uint256 i = 0; i < listed.length; ++i) {
                assertTrue(distributor.rewardToken(listed[i]).registered, "every listed token is registered");
                assertTrue(listed[i] != address(foreign), "the unregistered token never reaches an epoch");
            }
        }
    }

    /// @dev The liveness half, and the anti-vacuity gate in one: every schedule the handler built
    ///      to be legal in every respect was accepted. Without it, a registry that refused every
    ///      write would satisfy the five invariants above vacuously. Past the warm-up, a legal
    ///      schedule is drawn in most runs (two of nine selectors, most of them legal), and then
    ///      at least one must have landed.
    function invariant_LegalSchedulesAreAccepted() public view {
        assertFalse(handler.legalScheduleRefused(), "a schedule legal in every respect was refused");
        if (handler.calls() < ANTI_VACUITY_MIN_CALLS || handler.legalScheduleAttempts() == 0) return;
        assertGt(handler.schedules(), 0, "legal schedules were attempted but none was accepted");
    }
}
