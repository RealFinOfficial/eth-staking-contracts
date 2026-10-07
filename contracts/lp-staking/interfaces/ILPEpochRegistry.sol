// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

/**
 * @title ILPEpochRegistry
 * @notice The external surface of `LPEpochRegistry`, frozen for the indexer, the backend
 *         mirror and the operator scripts.
 *
 *  The registry is the on-chain EMISSION SCHEDULE of the LP program: for every epoch, its
 *  start, its end, and the quantity of each reward token it emits. The backend reads it and
 *  spreads each quantity over the epoch's 15-minute scoring intervals. It bounds nothing: no
 *  contract reads it to limit a payment, and `RewardsDistributor` pays a valid voucher whatever
 *  the schedule says.
 *
 *  Rules (enforced on every write):
 *    - ids are issued in order (`epochCount + 1`) and never reused, a cancelled id included;
 *    - `startsAt` and `endsAt` sit on the 900-second grid, `endsAt > startsAt`;
 *    - an epoch is scheduled, or changed, only while `startsAt >= block.timestamp + 30 minutes`
 *      (`SCHEDULE_MARGIN`). From then on it is frozen;
 *    - live (not cancelled) epochs never overlap and are ordered by id; gaps are allowed;
 *    - every amount names a token `RewardsDistributor.isRewardToken` accepts at write time;
 *    - bounds can be updated, and an epoch cancelled, only for the LAST live epoch.
 *
 *  Ownable2Step / UUPS members are inherited from OpenZeppelin and are not repeated here.
 */
interface ILPEpochRegistry {
    // ──────────────────────── Types ────────────────────────────

    /// @notice One epoch. All timestamps are unix seconds on the 900-second grid.
    /// @param startsAt   First second of the epoch (inclusive).
    /// @param endsAt     End of the epoch (exclusive).
    /// @param prevLiveId The live epoch scheduled before this one at the time it was scheduled,
    ///                   0 for none. `cancelEpoch` uses it to relink `lastLiveId`.
    /// @param cancelled  True once `cancelEpoch` removed it from the schedule. A cancelled
    ///                   epoch emits nothing; its record and amounts stay readable.
    struct Epoch {
        uint64 startsAt;
        uint64 endsAt;
        uint64 prevLiveId;
        bool cancelled;
    }

    // ──────────────────────── Events ───────────────────────────

    /// @notice A new epoch entered the schedule. Its amounts follow as {EpochAmountSet}, one
    ///         per token, in the same transaction.
    event EpochScheduled(uint256 indexed id, uint64 startsAt, uint64 endsAt);

    /// @notice The quantity of `token` emitted by epoch `id` was set (zero included).
    event EpochAmountSet(uint256 indexed id, address indexed token, uint256 amount);

    /// @notice The bounds of epoch `id` changed. Full new state.
    event EpochUpdated(uint256 indexed id, uint64 startsAt, uint64 endsAt);

    /// @notice Epoch `id` left the schedule. `lastLiveId` now points at its predecessor.
    event EpochCancelled(uint256 indexed id);

    /// @notice The operator tier changed. Carries both sides.
    event OperatorSet(address previousOperator, address newOperator);

    // ──────────────────────── Errors ───────────────────────────

    error ZeroAddress();
    error NotOperator(address caller, address operator);
    error RenounceDisabled();

    /// @dev `scheduleEpoch` was given an id other than `epochCount + 1`.
    error UnexpectedEpochId(uint256 id, uint256 expected);

    /// @dev A timestamp is not a multiple of `INTERVAL`.
    error NotOnGrid(uint64 timestamp);

    /// @dev `endsAt` is not after `startsAt`.
    error InvalidBounds(uint64 startsAt, uint64 endsAt);

    /// @dev The epoch would start, or does start, less than `SCHEDULE_MARGIN` from now.
    error StartTooSoon(uint64 startsAt, uint256 earliestStart);

    /// @dev The epoch would start before the previous live epoch ends.
    error OverlapsPreviousEpoch(uint64 startsAt, uint64 previousEndsAt);

    /// @dev `tokens` and `amounts` differ in length.
    error LengthMismatch(uint256 tokens, uint256 amounts);

    /// @dev A token is not a registered, enabled reward token of the distributor.
    error UnknownRewardToken(address token);

    /// @dev The same token appears twice in one `scheduleEpoch`.
    error DuplicateToken(address token);

    /// @dev No epoch carries this id.
    error UnknownEpoch(uint256 id);

    /// @dev The epoch was cancelled and can no longer change.
    error EpochIsCancelled(uint256 id);

    /// @dev Bounds can be updated, and an epoch cancelled, only for the last live epoch.
    error NotLastLiveEpoch(uint256 id, uint256 lastLiveId);

    // ──────────────────────── Operator (the multisig, no delay) ─

    function scheduleEpoch(
        uint256 id,
        uint64 startsAt,
        uint64 endsAt,
        address[] calldata tokens,
        uint256[] calldata amounts
    ) external;

    function setEpochAmount(uint256 id, address token, uint256 amount) external;

    function updateEpochBounds(uint256 id, uint64 startsAt, uint64 endsAt) external;

    function cancelEpoch(uint256 id) external;

    // ──────────────────────── Owner (the timelock) ─────────────

    function setOperator(address newOperator) external;

    // ──────────────────────── Views ────────────────────────────

    /// @notice The scoring interval, in seconds: 900 (15 minutes). Every bound sits on it.
    function INTERVAL() external view returns (uint64);

    /// @notice How far ahead of its start an epoch must be scheduled or changed: 1800 s.
    function SCHEDULE_MARGIN() external view returns (uint64);

    /// @notice The `RewardsDistributor` whose registered tokens the schedule may name.
    function distributor() external view returns (address);

    function operator() external view returns (address);

    /// @notice The highest id ever issued, cancelled ids included. Ids run 1..epochCount.
    function epochCount() external view returns (uint256);

    /// @notice The live epoch scheduled last, 0 when none is live.
    function lastLiveId() external view returns (uint256);

    function epoch(uint256 id) external view returns (Epoch memory);

    function epochAmount(uint256 id, address token) external view returns (uint256);

    /// @notice Tokens with an amount set on epoch `id`, in the order they were first set.
    function epochTokens(uint256 id) external view returns (address[] memory);

    /// @notice The live epoch whose `[startsAt, endsAt)` contains `block.timestamp`, 0 for none.
    function currentEpoch() external view returns (uint256);
}
