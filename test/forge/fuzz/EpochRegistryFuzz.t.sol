// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LocalHarness} from "../utils/LocalHarness.sol";
import {ILPEpochRegistry} from "../../../contracts/lp-staking/interfaces/ILPEpochRegistry.sol";

/**
 * @notice Why this file exists: the unit suite proves each of {LPEpochRegistry}'s accept/reject
 *         gates at hand-picked edges. This file proves the gates COMBINED, over random
 *         timestamps, against an independent model written from the rules alone:
 *
 *    - `scheduleEpoch` accepts `[startsAt, endsAt)` exactly when both bounds are on the 900-s
 *      grid, `endsAt > startsAt`, `startsAt >= now + 1800`, and `startsAt` is not before the end
 *      of the last live epoch — and when it refuses, it refuses with the FIRST failing rule, in
 *      the order grid(start), grid(end), bounds, margin, overlap;
 *    - `updateEpochBounds` adds one rule in front of those: the epoch's CURRENT start must
 *      itself still be outside the margin;
 *    - any sequence of schedules and cancellations keeps ids strictly increasing, never reuses
 *      one, and leaves `lastLiveId` / `prevLiveId` describing exactly the live chain the model
 *      holds.
 *
 *  The model never reads the registry to decide; it reads only the inputs and its own record.
 *  Inputs are built from grid slots plus an occasional jitter, so on-grid and off-grid values,
 *  overlaps, gaps and margin violations all occur at useful rates instead of almost never.
 */
contract EpochRegistryFuzzTest is LocalHarness {
    uint64 internal constant T0 = 1_800_000_000;
    uint64 internal constant INTERVAL = 900;
    uint64 internal constant MARGIN = 1800;

    function setUp() public {
        _deployLocalStack();
        vm.warp(T0);
    }

    // ──────────────────────── scheduleEpoch ────────────────────

    function testFuzz_ScheduleEpoch_MatchesTheModel(
        uint32 nowOffset,
        uint32 startSlot,
        uint16 startJitter,
        uint32 endSlot,
        uint16 endJitter,
        bool withPrevious,
        uint32 prevLenSlots
    ) public {
        uint64 prevEnd;
        uint256 id = 1;
        if (withPrevious) {
            prevEnd = T0 + MARGIN + uint64(1 + prevLenSlots % 1000) * INTERVAL;
            _schedule(1, T0 + MARGIN, prevEnd);
            id = 2;
        }

        uint64 now_ = T0 + uint64(nowOffset % 2 days);
        vm.warp(now_);

        uint64 startsAt = _value(startSlot, startJitter);
        uint64 endsAt = _value(endSlot, endJitter);

        bytes memory expected = _scheduleModel(now_, startsAt, endsAt, prevEnd);
        if (expected.length != 0) vm.expectRevert(expected);
        registry.scheduleEpoch(id, startsAt, endsAt, new address[](0), new uint256[](0));

        if (expected.length == 0) {
            ILPEpochRegistry.Epoch memory e = registry.epoch(id);
            assertEq(e.startsAt, startsAt, "the accepted start is stored");
            assertEq(e.endsAt, endsAt, "the accepted end is stored");
            assertEq(e.prevLiveId, id - 1, "linked to the previous live epoch");
            assertEq(registry.lastLiveId(), id, "the new epoch is the last live one");
            assertEq(registry.epochCount(), id, "exactly one id issued");
        } else {
            assertEq(registry.epochCount(), id - 1, "a refused schedule issues no id");
            assertEq(registry.lastLiveId(), id - 1, "and leaves the live chain alone");
        }
    }

    // ──────────────────────── updateEpochBounds ────────────────

    function testFuzz_UpdateEpochBounds_MatchesTheModel(
        uint32 nowOffset,
        uint32 currentStartSlot,
        uint32 startSlot,
        uint16 startJitter,
        uint32 endSlot,
        uint16 endJitter,
        bool withPrevious,
        uint32 prevLenSlots
    ) public {
        uint64 prevEnd;
        uint256 id = 1;
        uint64 floor_ = T0 + MARGIN;
        if (withPrevious) {
            prevEnd = T0 + MARGIN + uint64(1 + prevLenSlots % 1000) * INTERVAL;
            _schedule(1, T0 + MARGIN, prevEnd);
            id = 2;
            floor_ = prevEnd;
        }
        // The epoch being moved: anywhere legal from the floor, one interval to two weeks long.
        uint64 currentStart = floor_ + uint64(currentStartSlot % 2000) * INTERVAL;
        _schedule(id, currentStart, currentStart + uint64(1 + currentStartSlot % 1344) * INTERVAL);

        uint64 now_ = T0 + uint64(nowOffset % 3 days);
        vm.warp(now_);

        uint64 startsAt = _value(startSlot, startJitter);
        uint64 endsAt = _value(endSlot, endJitter);

        bytes memory expected;
        if (currentStart < now_ + MARGIN) {
            expected = abi.encodeWithSelector(ILPEpochRegistry.StartTooSoon.selector, currentStart, now_ + MARGIN);
        } else {
            expected = _scheduleModel(now_, startsAt, endsAt, prevEnd);
        }

        ILPEpochRegistry.Epoch memory before = registry.epoch(id);
        if (expected.length != 0) vm.expectRevert(expected);
        registry.updateEpochBounds(id, startsAt, endsAt);

        ILPEpochRegistry.Epoch memory afterwards = registry.epoch(id);
        if (expected.length == 0) {
            assertEq(afterwards.startsAt, startsAt, "the accepted start is stored");
            assertEq(afterwards.endsAt, endsAt, "the accepted end is stored");
        } else {
            assertEq(afterwards.startsAt, before.startsAt, "a refused update moves nothing");
            assertEq(afterwards.endsAt, before.endsAt, "a refused update moves nothing");
        }
        assertEq(afterwards.prevLiveId, before.prevLiveId, "an update never relinks");
    }

    // ──────────────────────── schedule / cancel sequences ──────

    /// @dev The model's live chain, kept in memory: ids in scheduling order.
    struct Model {
        uint256[] live;
        uint256 liveLen;
        uint256 count;
        uint64[] starts;
        uint64[] ends;
        bool[] cancelled;
    }

    function testFuzz_ScheduleCancelSequences_KeepIdsAndTheLiveChainConsistent(uint256 seed, uint8 steps) public {
        uint256 n = bound(steps, 1, 40);
        Model memory m;
        m.live = new uint256[](n + 1);
        m.starts = new uint64[](n + 1);
        m.ends = new uint64[](n + 1);
        m.cancelled = new bool[](n + 1);

        for (uint256 i = 0; i < n; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            uint256 op = r % 10;

            if (op < 6 || m.liveLen == 0) {
                _stepSchedule(m, r);
            } else if (op < 9) {
                _stepCancel(m);
            } else {
                // Time moves forward by up to a day; the next cancel may then hit the margin.
                vm.warp(block.timestamp + (r >> 8) % 1 days);
            }
            _assertChainMatches(m);
        }
    }

    function _stepSchedule(Model memory m, uint256 r) internal {
        uint64 earliest = _ceilToGrid(uint64(block.timestamp) + MARGIN);
        uint64 lastEnd = m.liveLen == 0 ? 0 : m.ends[m.live[m.liveLen - 1]];
        uint64 floor_ = lastEnd > earliest ? lastEnd : earliest;
        uint64 startsAt = floor_ + uint64((r >> 16) % 8) * INTERVAL;
        uint64 endsAt = startsAt + uint64(1 + (r >> 32) % 96) * INTERVAL;

        uint256 id = m.count + 1;
        registry.scheduleEpoch(id, startsAt, endsAt, new address[](0), new uint256[](0));

        m.count = id;
        m.starts[id] = startsAt;
        m.ends[id] = endsAt;
        m.live[m.liveLen++] = id;
    }

    function _stepCancel(Model memory m) internal {
        uint256 id = m.live[m.liveLen - 1];
        if (m.starts[id] < block.timestamp + MARGIN) {
            vm.expectRevert(
                abi.encodeWithSelector(ILPEpochRegistry.StartTooSoon.selector, m.starts[id], block.timestamp + MARGIN)
            );
            registry.cancelEpoch(id);
            return;
        }
        registry.cancelEpoch(id);
        m.cancelled[id] = true;
        m.liveLen--;
    }

    function _assertChainMatches(Model memory m) internal view {
        assertEq(registry.epochCount(), m.count, "epochCount is the number of ids ever issued");
        uint256 expectedLast = m.liveLen == 0 ? 0 : m.live[m.liveLen - 1];
        assertEq(registry.lastLiveId(), expectedLast, "lastLiveId is the top of the model's live chain");

        for (uint256 k = 0; k < m.liveLen; ++k) {
            uint256 id = m.live[k];
            ILPEpochRegistry.Epoch memory e = registry.epoch(id);
            assertEq(e.prevLiveId, k == 0 ? 0 : m.live[k - 1], "each live epoch links to the one before it");
            assertFalse(e.cancelled, "a live epoch is not cancelled");
            if (k > 0) assertGt(id, m.live[k - 1], "live ids increase along the chain");
        }
        for (uint256 id = 1; id <= m.count; ++id) {
            assertEq(registry.epoch(id).cancelled, m.cancelled[id], "cancellation flags match, forever");
        }
    }

    // ──────────────────────── The model ────────────────────────

    /// @dev The rules of `scheduleEpoch` (and of the second half of `updateEpochBounds`), in the
    ///      contract's order, from the inputs alone. Empty = accept.
    function _scheduleModel(uint64 now_, uint64 startsAt, uint64 endsAt, uint64 prevEnd)
        internal
        pure
        returns (bytes memory)
    {
        if (startsAt % INTERVAL != 0) return abi.encodeWithSelector(ILPEpochRegistry.NotOnGrid.selector, startsAt);
        if (endsAt % INTERVAL != 0) return abi.encodeWithSelector(ILPEpochRegistry.NotOnGrid.selector, endsAt);
        if (endsAt <= startsAt) {
            return abi.encodeWithSelector(ILPEpochRegistry.InvalidBounds.selector, startsAt, endsAt);
        }
        if (uint256(startsAt) < uint256(now_) + MARGIN) {
            return abi.encodeWithSelector(ILPEpochRegistry.StartTooSoon.selector, startsAt, uint256(now_) + MARGIN);
        }
        if (prevEnd != 0 && startsAt < prevEnd) {
            return abi.encodeWithSelector(ILPEpochRegistry.OverlapsPreviousEpoch.selector, startsAt, prevEnd);
        }
        return "";
    }

    /// @dev A timestamp around the interesting window: a grid slot within ~21 days of {T0}, with
    ///      an off-grid jitter one draw in three.
    function _value(uint32 slot, uint16 jitter) internal pure returns (uint64) {
        uint64 v = T0 + uint64(slot % 2000) * INTERVAL;
        if (jitter % 3 == 0) v += uint64(jitter % INTERVAL);
        return v;
    }

    function _ceilToGrid(uint64 t) internal pure returns (uint64) {
        return ((t + INTERVAL - 1) / INTERVAL) * INTERVAL;
    }

    function _schedule(uint256 id, uint64 startsAt, uint64 endsAt) internal {
        registry.scheduleEpoch(id, startsAt, endsAt, new address[](0), new uint256[](0));
    }
}
