// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";

import "./interfaces/ILPEpochRegistry.sol";
import "./interfaces/IRewardsDistributor.sol";

/**
 * @title LPEpochRegistry
 * @notice The on-chain emission SCHEDULE of the LP staking program: per epoch, its start, its
 *         end, and the quantity of every reward token it emits.
 *
 *  Who reads it: the backend mirrors every finalized epoch and spreads each token's quantity
 *  evenly over the epoch's 15-minute scoring intervals (`INTERVAL`). Nothing on-chain reads it to
 *  limit a payment: it is a schedule, not a budget, and it bounds nothing. `RewardsDistributor`
 *  pays a valid voucher whatever this contract says.
 *
 *  Who writes it: the OPERATOR multisig, immediately, with no timelock delay — scheduling the
 *  next epoch and setting its quantities is routine operations. The owner (the timelock) only
 *  upgrades the contract and moves the operator role.
 *
 *  The rules, and why each one exists:
 *    - Ids are issued in order (`id == epochCount + 1`) and are never reused, a cancelled id
 *      included. The backend and the indexer detect a missed log by a gap in the ids.
 *    - Every bound sits on the 900-second grid. Scoring runs in 15-minute intervals, and an
 *      epoch that started or ended mid-interval would split one interval between two epochs.
 *    - `SCHEDULE_MARGIN` (30 minutes): an epoch is scheduled, or changed, only while it starts
 *      at least 30 minutes from now; from then on it is frozen. The backend scores only
 *      FINALIZED chain data (about 13 minutes on Ethereum) and mirrors the registry once a
 *      minute, so the margin guarantees the start, the end and every quantity are final and
 *      known to the backend before the epoch's first interval is scored. Example: at 10:00 an
 *      epoch starting 10:15 is refused, one starting 10:30 is accepted.
 *    - Live epochs never overlap and are ordered by id; gaps between them are allowed.
 *    - Every amount names a token that `RewardsDistributor.isRewardToken` accepts when the
 *      amount is written. Adding a NEW reward token is a timelock operation on the distributor;
 *      once it is there the operator can schedule it here.
 *    - Quantities may change on ANY live epoch that has not reached its margin. Bounds may be
 *      updated, and an epoch cancelled, only on the LAST live epoch: that keeps every check
 *      O(1) (one neighbour to compare against). To change an earlier future epoch the operator
 *      cancels back to it and schedules again.
 *
 *  UPGRADEABILITY. Implementation behind a UUPS (ERC-1967) proxy (`deploy/LPProxy.sol`), owner =
 *  the timelock. State lives in the ERC-7201 namespace `real.lp.storage.LPEpochRegistry`.
 *  `distributor` is `immutable` (implementation bytecode): a different distributor would be a
 *  different program, and an upgrade can change it if one ever is. The constructor disables
 *  the implementation's initializers.
 */
contract LPEpochRegistry is Initializable, UUPSUpgradeable, Ownable2StepUpgradeable, ILPEpochRegistry {
    // ──────────────────────── Constants ────────────────────────

    /// @inheritdoc ILPEpochRegistry
    uint64 public constant INTERVAL = 900;

    /// @inheritdoc ILPEpochRegistry
    uint64 public constant SCHEDULE_MARGIN = 30 minutes;

    // ──────────────────────── Immutables ───────────────────────

    /// @inheritdoc ILPEpochRegistry
    address public immutable distributor;

    // ──────────────────────── Storage ──────────────────────────

    /// @custom:storage-location erc7201:real.lp.storage.LPEpochRegistry
    struct LPEpochRegistryStorage {
        /// The multisig that schedules and edits epochs, with no delay.
        address operator;
        /// The highest id ever issued. Ids run 1..epochCount.
        uint64 epochCount;
        /// The live epoch scheduled last; 0 when none is live.
        uint64 lastLiveId;
        /// id => epoch record.
        mapping(uint256 => Epoch) epochs;
        /// id => token => quantity emitted by that epoch.
        mapping(uint256 => mapping(address => uint256)) amounts;
        /// id => tokens with an amount set, in first-set order.
        mapping(uint256 => address[]) tokens;
    }

    /**
     * @dev ERC-7201 slot for {LPEpochRegistryStorage}, computed as
     *      `keccak256(abi.encode(uint256(keccak256("real.lp.storage.LPEpochRegistry")) - 1)) & ~bytes32(uint256(0xff))`.
     *      `test/forge/unit/EpochRegistry.t.sol` recomputes it and fails if it drifts.
     */
    bytes32 private constant LP_EPOCH_REGISTRY_STORAGE =
        0x9ecda8e3fad78b619c97eff816bc5317dd5b4101194b9333568095fc1dd01f00;

    function _registryStorage() private pure returns (LPEpochRegistryStorage storage $) {
        assembly {
            $.slot := LP_EPOCH_REGISTRY_STORAGE
        }
    }

    // ──────────────────────── Modifiers ────────────────────────

    modifier onlyOperator() {
        address operator_ = _registryStorage().operator;
        if (msg.sender != operator_) revert NotOperator(msg.sender, operator_);
        _;
    }

    // ──────────────────────── Constructor / initializer ────────

    /// @notice Deploys the IMPLEMENTATION, bound to one distributor.
    /// @param distributor_ The `RewardsDistributor` proxy whose tokens the schedule may name.
    constructor(address distributor_) {
        if (distributor_ == address(0)) revert ZeroAddress();
        distributor = distributor_;
        _disableInitializers();
    }

    /// @notice One-time setup, executed on the PROXY in its own deployment transaction.
    /// @param owner_    Owner: the timelock. Upgrades and `setOperator`.
    /// @param operator_ Operator: the multisig that schedules epochs.
    function initialize(address owner_, address operator_) external initializer {
        __Ownable_init(owner_);
        __Ownable2Step_init();
        // No `__UUPSUpgradeable_init()` — see `RewardsDistributor.initialize`.

        if (operator_ == address(0)) revert ZeroAddress();
        _registryStorage().operator = operator_;
        emit OperatorSet(address(0), operator_);
    }

    // ──────────────────────── Operator functions ───────────────

    /// @notice Schedules the next epoch with its quantities.
    /// @param id       Must be `epochCount + 1`.
    /// @param startsAt First second of the epoch; on the grid, at least `SCHEDULE_MARGIN` from
    ///                 now, and not before the last live epoch ends.
    /// @param endsAt   End of the epoch (exclusive); on the grid, after `startsAt`.
    /// @param tokens   Reward tokens the epoch emits; each `isRewardToken`, no duplicates. May be
    ///                 empty (quantities can be added later with {setEpochAmount}).
    /// @param amounts  Quantity of each token, in its smallest unit. Zero allowed.
    function scheduleEpoch(
        uint256 id,
        uint64 startsAt,
        uint64 endsAt,
        address[] calldata tokens,
        uint256[] calldata amounts
    ) external onlyOperator {
        LPEpochRegistryStorage storage $ = _registryStorage();

        uint256 expected = uint256($.epochCount) + 1;
        if (id != expected) revert UnexpectedEpochId(id, expected);
        if (tokens.length != amounts.length) revert LengthMismatch(tokens.length, amounts.length);

        uint64 prevLiveId = $.lastLiveId;
        _checkBounds(startsAt, endsAt, prevLiveId);

        $.epochs[id] = Epoch({startsAt: startsAt, endsAt: endsAt, prevLiveId: prevLiveId, cancelled: false});
        $.epochCount = uint64(id);
        $.lastLiveId = uint64(id);

        emit EpochScheduled(id, startsAt, endsAt);

        for (uint256 i = 0; i < tokens.length; ++i) {
            address token = tokens[i];
            for (uint256 j = 0; j < i; ++j) {
                if (tokens[j] == token) revert DuplicateToken(token);
            }
            _requireRewardToken(token);
            $.tokens[id].push(token);
            $.amounts[id][token] = amounts[i];
            emit EpochAmountSet(id, token, amounts[i]);
        }
    }

    /// @notice Sets the quantity of `token` emitted by epoch `id`. Any live epoch that is still
    ///         at least `SCHEDULE_MARGIN` from its start; zero allowed. A token not yet on the
    ///         epoch joins it.
    function setEpochAmount(uint256 id, address token, uint256 amount) external onlyOperator {
        LPEpochRegistryStorage storage $ = _registryStorage();
        Epoch storage e = _liveEpoch(id);
        _requireNotLocked(e.startsAt);
        _requireRewardToken(token);

        address[] storage list = $.tokens[id];
        bool listed;
        for (uint256 i = 0; i < list.length; ++i) {
            if (list[i] == token) {
                listed = true;
                break;
            }
        }
        if (!listed) list.push(token);

        $.amounts[id][token] = amount;
        emit EpochAmountSet(id, token, amount);
    }

    /// @notice Moves the bounds of the LAST live epoch, before its margin. The new bounds obey
    ///         the same rules as {scheduleEpoch}.
    function updateEpochBounds(uint256 id, uint64 startsAt, uint64 endsAt) external onlyOperator {
        Epoch storage e = _lastLiveEpoch(id);
        _requireNotLocked(e.startsAt);
        _checkBounds(startsAt, endsAt, e.prevLiveId);

        e.startsAt = startsAt;
        e.endsAt = endsAt;
        emit EpochUpdated(id, startsAt, endsAt);
    }

    /// @notice Removes the LAST live epoch from the schedule, before its margin. `lastLiveId`
    ///         falls back to the epoch it was scheduled after; the id is never reused.
    function cancelEpoch(uint256 id) external onlyOperator {
        Epoch storage e = _lastLiveEpoch(id);
        _requireNotLocked(e.startsAt);

        e.cancelled = true;
        _registryStorage().lastLiveId = e.prevLiveId;
        emit EpochCancelled(id);
    }

    // ──────────────────────── Owner functions ──────────────────

    /// @notice Moves the operator role. Owner (timelock) tier, zero rejected.
    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert ZeroAddress();
        LPEpochRegistryStorage storage $ = _registryStorage();
        emit OperatorSet($.operator, newOperator);
        $.operator = newOperator;
    }

    /// @notice UUPS upgrade hook: the owner (the timelock) authorizes every code change.
    function _authorizeUpgrade(address) internal override onlyOwner {}

    /// @notice Disabled: an ownerless registry could never be upgraded nor have its operator moved.
    function renounceOwnership() public override onlyOwner {
        revert RenounceDisabled();
    }

    // ──────────────────────── Views ────────────────────────────

    /// @inheritdoc ILPEpochRegistry
    function operator() external view returns (address) {
        return _registryStorage().operator;
    }

    /// @inheritdoc ILPEpochRegistry
    function epochCount() external view returns (uint256) {
        return _registryStorage().epochCount;
    }

    /// @inheritdoc ILPEpochRegistry
    function lastLiveId() external view returns (uint256) {
        return _registryStorage().lastLiveId;
    }

    /// @inheritdoc ILPEpochRegistry
    function epoch(uint256 id) external view returns (Epoch memory) {
        return _registryStorage().epochs[id];
    }

    /// @inheritdoc ILPEpochRegistry
    function epochAmount(uint256 id, address token) external view returns (uint256) {
        return _registryStorage().amounts[id][token];
    }

    /// @inheritdoc ILPEpochRegistry
    function epochTokens(uint256 id) external view returns (address[] memory) {
        return _registryStorage().tokens[id];
    }

    /// @inheritdoc ILPEpochRegistry
    /// @dev Walks back from `lastLiveId` through `prevLiveId`. Live epochs are ordered and never
    ///      overlap, so the walk stops at the first epoch that ends at or before now. Its length
    ///      is the number of live epochs still in the future, plus one.
    function currentEpoch() external view returns (uint256) {
        LPEpochRegistryStorage storage $ = _registryStorage();
        uint256 id = $.lastLiveId;
        while (id != 0) {
            Epoch storage e = $.epochs[id];
            if (block.timestamp >= e.endsAt) return 0;
            if (block.timestamp >= e.startsAt) return id;
            id = e.prevLiveId;
        }
        return 0;
    }

    // ──────────────────────── Internal ─────────────────────────

    /// @dev The grid, the order of the bounds, the margin and the no-overlap rule.
    function _checkBounds(uint64 startsAt, uint64 endsAt, uint64 prevLiveId) private view {
        if (startsAt % INTERVAL != 0) revert NotOnGrid(startsAt);
        if (endsAt % INTERVAL != 0) revert NotOnGrid(endsAt);
        if (endsAt <= startsAt) revert InvalidBounds(startsAt, endsAt);
        _requireNotLocked(startsAt);
        if (prevLiveId != 0) {
            uint64 previousEndsAt = _registryStorage().epochs[prevLiveId].endsAt;
            if (startsAt < previousEndsAt) revert OverlapsPreviousEpoch(startsAt, previousEndsAt);
        }
    }

    /// @dev Reverts unless `startsAt` is at least `SCHEDULE_MARGIN` from now. Exactly
    ///      `now + SCHEDULE_MARGIN` is accepted.
    function _requireNotLocked(uint64 startsAt) private view {
        uint256 earliestStart = block.timestamp + SCHEDULE_MARGIN;
        if (startsAt < earliestStart) revert StartTooSoon(startsAt, earliestStart);
    }

    /// @dev A token the distributor has registered and enabled.
    function _requireRewardToken(address token) private view {
        if (!IRewardsDistributor(distributor).isRewardToken(token)) revert UnknownRewardToken(token);
    }

    /// @dev An issued, not cancelled epoch.
    function _liveEpoch(uint256 id) private view returns (Epoch storage e) {
        LPEpochRegistryStorage storage $ = _registryStorage();
        if (id == 0 || id > $.epochCount) revert UnknownEpoch(id);
        e = $.epochs[id];
        if (e.cancelled) revert EpochIsCancelled(id);
    }

    /// @dev The last live epoch, and only it.
    function _lastLiveEpoch(uint256 id) private view returns (Epoch storage e) {
        LPEpochRegistryStorage storage $ = _registryStorage();
        uint256 last = $.lastLiveId;
        if (id == 0 || id != last) revert NotLastLiveEpoch(id, last);
        e = $.epochs[id];
    }
}
