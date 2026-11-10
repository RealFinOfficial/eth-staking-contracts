// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.38;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";

import "../lp-staking/interfaces/IBonusEscrowHooks.sol";
import "../lp-staking/libraries/PositionValue.sol";
import "./interfaces/IStakingV3.sol";

/// @dev The LP-vault reads the bonus vault makes: its pool pair (to orient the valuation), its
///      TWAP (to value a rebalanced position), exactly as `BonusEscrow` reads them, the staker of a
///      position, and when the vault's fail-open `onUnstake` notification to this contract was
///      first missed for a tokenId ({V3BonusVault-reconcileLp}, {V3BonusVault-claim}).
interface IV3BonusLpVault {
    function stakerOf(uint256 tokenId) external view returns (address);

    function listenerMissedAt(uint256 tokenId) external view returns (uint64);

    function token0() external view returns (address);

    function token1() external view returns (address);

    function previewTwap()
        external
        view
        returns (int24 currentTick, int24 twapTick, int24 maxDeviationTicks, bool withinBounds);
}

/**
 * @title V3BonusVault
 * @notice The staking v3 transition bonus: reserved at the transition, paid in $ASSET after the v3
 *         pool's `endEpoch`. UUPS, owned by the `LPTimelock`.
 *
 *  TWO KINDS OF RESERVATION, both written only by the migrator:
 *    - the v3 reservation of a user ({reserve}): one running amount per user and the latest unlock
 *      time. A `withdraw` from the v3 pool before its end calls {onEarlyExit} and forfeits the WHOLE
 *      amount; a stake that stays to the end keeps it.
 *    - the LP reservation of one position ({reserveLp}), keyed by the position's tokenId, with the
 *      exact semantics of `BonusEscrow`: the LP vault's {onRebalance} moves it to the new tokenId,
 *      scaled by min(1, valueNew / valueOld) at the vault's TWAP, so it never grows; the vault's
 *      {onUnstake} before the unlock forfeits it; after the unlock either hook SETTLES it
 *      ({LpBonusSettled}: the user left or re-ranged after the unlock, the bonus is theirs) and
 *      touches nothing else. After its unlock an LP reservation pays only when it is SETTLED,
 *      MISSED-AFTER (the vault's `onUnstake` failed at or after the unlock) or still HELD by the
 *      vault for its user, and never when it is DEAD (a failed `onUnstake` before the unlock);
 *      see "A MISSED NOTIFICATION" below.
 *
 *  RESERVE NOW, FUND LATER. No tokens move at the transition and no balance is checked there. The
 *  company funds this contract with $ASSET ({fund}, or a plain transfer) any time before the end.
 *  {claim} pays everything of the caller's that is unlocked, from the balance, and reverts
 *  {InsufficientFunds} — all or nothing — while the balance is short.
 *
 *  ACCOUNTING. `totalReserved` is the sum of every reservation that is neither claimed nor
 *  forfeited; `totalLpReserved` is the LP part of it (the amount the LP vault's listener link
 *  protects). A forfeiture or a down-scaling lowers them and leaves the tokens here, so the surplus
 *  (`balance - totalReserved`) grows and only {recoverSurplus} (owner) can move it.
 *
 *  THE BUDGET. `maxTotalReserved` caps `totalReserved`: {reserve} and {reserveLp} revert
 *  {BudgetExceeded} when a reservation would take it above the cap, so the migrator's route call
 *  reverts with them. Set by the initializer and by the owner ({setMaxTotalReserved}).
 *
 *  A MISSED NOTIFICATION. The LP vault's `onRebalance` to this contract fails CLOSED (since
 *  2026-11-10; a revert reverts the rebalance), its `onUnstake` fails OPEN: when that one reverts
 *  the vault emits `BonusListenerFailed(tokenId)`, the LP reservation stays where it was, and the
 *  vault records the FIRST such moment per tokenId (`vault.listenerMissedAt(tokenId)`, never
 *  overwritten). Against a record's unlock that timestamp tells what was missed:
 *    - DEAD: `missedAt != 0 && missedAt < unlockAt`. The forfeit was missed: the user left before
 *      the unlock. The record never pays, even if the same NFT is staked again by the same user.
 *    - MISSED-AFTER: `missedAt != 0 && missedAt >= unlockAt`. The settle was missed: the user left
 *      after the unlock, legitimately. The record pays as if it had been settled.
 *
 *  WHEN AN LP RESERVATION PAYS. {claim} pays an unlocked, unclaimed, unforfeited LP reservation
 *  that is not dead and is either SETTLED (a vault notification after the unlock), MISSED-AFTER, or
 *  still HELD by the LP vault for its user (`stakerOf(tokenId) == user`). Any other record is
 *  STALE and pays nothing. An after-unlock notification never settles a dead record: it forfeits
 *  it; a before-unlock re-range never moves a dead record: it forfeits it.
 *
 *  {reconcileLp} (permissionless) makes the state explicit. The backend sends no transaction: for
 *  every `BonusListenerFailed` it raises the alert `lp.vault.bonus_listener_failed` with the action
 *  "call V3BonusVault.reconcileLp(tokenId) from any wallet", and the operator (or anyone) sends it,
 *  before or after the unlock. It does this: before the unlock it forfeits a dead record or one the vault no longer holds for its
 *  user; after the unlock it settles a missed-after record and forfeits any record that is neither
 *  settled, nor missed-after, nor held (a dead one included), so `totalLpReserved` never stays
 *  inflated by a stale record. A settled record is never touched.
 *
 *  ADMIN: owner (the timelock) only — upgrades, `setMigrator`, `setPool`, `setVault`,
 *  `setMaxTotalReserved`, `recoverSurplus`. No pause and no function that raises a reservation.
 */
contract V3BonusVault is
    Initializable,
    UUPSUpgradeable,
    Ownable2StepUpgradeable,
    ReentrancyGuardTransient,
    IBonusEscrowHooks
{
    using SafeERC20 for IERC20;

    // ──────────────────────── Storage ──────────────────────────

    struct UserReservation {
        uint256 amount;
        uint64 unlockAt;
    }

    struct LpReservation {
        address user;
        uint64 unlockAt;
        bool claimed;
        bool forfeited;
        /// Position of this tokenId in `lpTokens[user]`; the slot a rebalance rewrites in place.
        /// uint16 keeps the five fields in ONE slot (a cheaper rebalance hook).
        uint16 index;
        uint256 amount;
    }

    /// @custom:storage-location erc7201:real.staking.storage.V3BonusVault
    struct V3BonusVaultStorage {
        IERC20 bonusToken;
        address migrator;
        address pool;
        address vault;
        bool bonusIsToken0;
        uint256 totalReserved;
        mapping(address => UserReservation) reservations;
        mapping(uint256 => LpReservation) lpReservations;
        mapping(address => uint256[]) lpTokens;
        /// The cap on `totalReserved` ({reserve} and {reserveLp} revert above it).
        uint256 maxTotalReserved;
        /// The LP part of `totalReserved`: every LP reservation neither claimed nor forfeited.
        uint256 totalLpReserved;
        /// tokenId => the LP reservation was settled by a vault notification after its unlock
        /// (the user unstaked or re-ranged then): it pays even though the vault no longer holds
        /// the tokenId. APPENDED (stale-record fix, 2026-11-10); every field above stays put.
        mapping(uint256 => bool) lpSettled;
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("real.staking.storage.V3BonusVault")) - 1)) & ~0xff
    bytes32 private constant V3_BONUS_VAULT_STORAGE =
        0x7ee3db96cd3f5364376de98c276fd460a05b617c20412712666abb0adcc73b00;

    function _bonusStorage() private pure returns (V3BonusVaultStorage storage $) {
        assembly {
            $.slot := V3_BONUS_VAULT_STORAGE
        }
    }

    // ──────────────────────── Events ───────────────────────────

    event BonusReserved(address indexed user, uint256 amount, uint64 unlockAt, uint8 route);
    event LpBonusReserved(uint256 indexed tokenId, address indexed user, uint256 amount, uint64 unlockAt);
    event LpBonusMoved(
        uint256 indexed oldTokenId, uint256 indexed newTokenId, address indexed user, uint256 oldAmount, uint256 newAmount
    );
    event BonusForfeited(address indexed user, uint256 amount);
    event LpBonusForfeited(uint256 indexed tokenId, address indexed user, uint256 amount);
    /// @notice The LP reservation of `tokenId` was settled: the vault reported its unstake or
    ///         re-range after the unlock. It stays claimable under `tokenId`.
    event LpBonusSettled(uint256 indexed tokenId, address indexed user);
    event BonusClaimed(address indexed user, uint256 amount);
    event Funded(address indexed from, uint256 amount, uint256 balance);
    event SurplusRecovered(address indexed to, uint256 amount);
    event MigratorSet(address previousMigrator, address newMigrator);
    event PoolSet(address previousPool, address newPool);
    event VaultSet(address previousVault, address newVault);
    event MaxTotalReservedSet(uint256 previousMax, uint256 newMax);

    // ──────────────────────── Errors ───────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error NotMigrator(address caller, address migrator);
    error NotPool(address caller, address pool);
    error NotVault(address caller, address vault);
    error BonusTokenNotInPool(address bonusToken, address token0, address token1);
    error DuplicateReservation(uint256 tokenId);
    error NothingToClaim();
    error InsufficientFunds(uint256 requested, uint256 available);
    error NoSurplus();
    error SurplusExceeded(uint256 requested, uint256 available);
    error RenounceDisabled();
    error BudgetExceeded(uint256 requested, uint256 remaining);
    error LpReservationsOutstanding(uint256 totalLpReserved);

    // ──────────────────────── Modifiers ────────────────────────

    modifier onlyMigrator() {
        address migrator_ = _bonusStorage().migrator;
        if (msg.sender != migrator_) revert NotMigrator(msg.sender, migrator_);
        _;
    }

    modifier onlyVault() {
        address vault_ = _bonusStorage().vault;
        if (msg.sender != vault_) revert NotVault(msg.sender, vault_);
        _;
    }

    // ──────────────────────── Constructor / initializer ────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @param owner_ The deployer while the deploy script wires the v3 contracts, then the timelock.
     * @param bonusToken_ $ASSET.
     * @param migrator_ The `StakingMigrator` proxy, or zero when it is wired later.
     * @param pool_ The `WeightedStakingPoolV3` proxy (the {onEarlyExit} caller).
     * @param vault_ The `LPStakingVault` proxy (the {onUnstake} / {onRebalance} caller). Its pool
     *        must hold `bonusToken_`.
     * @param maxTotalReserved_ The cap on `totalReserved`, in bonus-token wei.
     */
    function initialize(
        address owner_,
        address bonusToken_,
        address migrator_,
        address pool_,
        address vault_,
        uint256 maxTotalReserved_
    ) external initializer {
        if (bonusToken_ == address(0) || pool_ == address(0)) revert ZeroAddress();
        __Ownable_init(owner_);
        __Ownable2Step_init();

        V3BonusVaultStorage storage $ = _bonusStorage();
        $.bonusToken = IERC20(bonusToken_);
        _setMigrator(migrator_);
        _setPool(pool_);
        _setVault(vault_);
        _setMaxTotalReserved(maxTotalReserved_);
    }

    // ──────────────────────── Views ────────────────────────────

    function bonusToken() external view returns (address) {
        return address(_bonusStorage().bonusToken);
    }

    function migrator() external view returns (address) {
        return _bonusStorage().migrator;
    }

    function pool() external view returns (address) {
        return _bonusStorage().pool;
    }

    function vault() external view returns (address) {
        return _bonusStorage().vault;
    }

    /// @notice The sum of every reservation neither claimed nor forfeited.
    function totalReserved() external view returns (uint256) {
        return _bonusStorage().totalReserved;
    }

    /// @notice The LP part of {totalReserved}: every LP reservation neither claimed nor forfeited.
    ///         The LP vault refuses to unlink this listener while it is above zero.
    function totalLpReserved() external view returns (uint256) {
        return _bonusStorage().totalLpReserved;
    }

    /// @notice The cap on {totalReserved}.
    function maxTotalReserved() external view returns (uint256) {
        return _bonusStorage().maxTotalReserved;
    }

    /// @notice `user`'s v3 reservation: the amount still owed and its unlock time.
    function reservedOf(address user) external view returns (uint256 amount, uint64 unlockAt) {
        UserReservation storage r = _bonusStorage().reservations[user];
        return (r.amount, r.unlockAt);
    }

    /// @notice The LP reservation of `tokenId`.
    function lpReservation(uint256 tokenId)
        external
        view
        returns (address user, uint256 amount, uint64 unlockAt, bool claimed, bool forfeited)
    {
        LpReservation storage r = _bonusStorage().lpReservations[tokenId];
        return (r.user, r.amount, r.unlockAt, r.claimed, r.forfeited);
    }

    /// @notice True when the LP reservation of `tokenId` was settled after its unlock (see
    ///         {LpBonusSettled}): it pays although the vault no longer holds the position.
    function lpSettled(uint256 tokenId) external view returns (bool) {
        return _bonusStorage().lpSettled[tokenId];
    }

    /// @notice The tokenIds whose LP reservations belong to `user` (a rebalance rewrites its entry).
    function lpTokensOf(address user) external view returns (uint256[] memory) {
        return _bonusStorage().lpTokens[user];
    }

    /// @notice What {claim} would pay `user` now, before the funding check. A dead or stale LP
    ///         record (see the header) counts zero, exactly as {claim} skips it.
    function claimable(address user) external view returns (uint256 amount) {
        V3BonusVaultStorage storage $ = _bonusStorage();
        UserReservation storage r = $.reservations[user];
        if (block.timestamp >= r.unlockAt) amount = r.amount;
        uint256[] storage ids = $.lpTokens[user];
        for (uint256 i = 0; i < ids.length; ++i) {
            amount += _lpClaimable($, ids[i]);
        }
    }

    // ──────────────────────── Migrator functions ───────────────

    /**
     * @notice Adds `amount` to `user`'s v3 reservation. The unlock time only ever moves later.
     * @param route The transition route that earned it (1 compound, 2 join LP, 3 restake); event only.
     */
    function reserve(address user, uint256 amount, uint64 unlockAt, uint8 route) external onlyMigrator {
        if (user == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        V3BonusVaultStorage storage $ = _bonusStorage();
        _checkBudget($, amount);
        UserReservation storage r = $.reservations[user];
        r.amount += amount;
        if (unlockAt > r.unlockAt) r.unlockAt = unlockAt;
        $.totalReserved += amount;
        emit BonusReserved(user, amount, r.unlockAt, route);
    }

    /// @notice Records the bonus of the LP position `tokenId`, credited to `user`. One per tokenId.
    function reserveLp(uint256 tokenId, address user, uint256 amount, uint64 unlockAt) external onlyMigrator {
        if (user == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        V3BonusVaultStorage storage $ = _bonusStorage();
        LpReservation storage r = $.lpReservations[tokenId];
        if (r.user != address(0)) revert DuplicateReservation(tokenId);
        _checkBudget($, amount);

        uint256[] storage ids = $.lpTokens[user];
        r.user = user;
        r.unlockAt = unlockAt;
        r.amount = amount;
        r.index = SafeCast.toUint16(ids.length);
        ids.push(tokenId);
        $.totalReserved += amount;
        $.totalLpReserved += amount;

        emit LpBonusReserved(tokenId, user, amount, unlockAt);
    }

    // ──────────────────────── Pool notification ────────────────

    /// @notice `user` withdrew from the v3 pool before its end: the whole v3 reservation is
    ///         forfeited while it is still locked. LP reservations are not touched.
    function onEarlyExit(address user) external {
        V3BonusVaultStorage storage $ = _bonusStorage();
        address pool_ = $.pool;
        if (msg.sender != pool_) revert NotPool(msg.sender, pool_);

        UserReservation storage r = $.reservations[user];
        uint256 amount = r.amount;
        if (amount == 0 || block.timestamp >= r.unlockAt) return;

        r.amount = 0;
        $.totalReserved -= amount;
        emit BonusForfeited(user, amount);
    }

    // ──────────────────────── Vault notifications ──────────────

    /// @inheritdoc IBonusEscrowHooks
    /// @dev Before the unlock: forfeits. After it: settles (the bonus is the user's), unless the
    ///      record is DEAD (a forfeit missed before the unlock), which is forfeited instead.
    function onUnstake(uint256 tokenId) external onlyVault {
        V3BonusVaultStorage storage $ = _bonusStorage();
        LpReservation storage r = $.lpReservations[tokenId];
        if (_isActive(r)) _forfeitLp($, r, tokenId);
        else _settleLp($, r, tokenId);
    }

    /// @inheritdoc IBonusEscrowHooks
    /// @dev Before the unlock: moves and scales, except a DEAD record (an early exit whose forfeit
    ///      was missed, then a re-stake of the same NFT), which is forfeited. After it: settles,
    ///      or forfeits a dead record.
    function onRebalance(uint256 oldTokenId, uint256 newTokenId, Snapshot calldata old_, Snapshot calldata new_)
        external
        onlyVault
    {
        V3BonusVaultStorage storage $ = _bonusStorage();
        LpReservation storage r = $.lpReservations[oldTokenId];
        if (!_isActive(r)) {
            // After the unlock the record stays under the old id, settled (pays without the vault).
            _settleLp($, r, oldTokenId);
            return;
        }
        if (_isDead(r, _missedAt($, oldTokenId))) {
            _forfeitLp($, r, oldTokenId);
            return;
        }

        LpReservation storage moved = $.lpReservations[newTokenId];
        if (moved.user != address(0)) revert DuplicateReservation(newTokenId);

        uint256 amount = r.amount;
        uint256 newAmount = _scaled(amount, old_, new_);

        address user = r.user;
        uint16 index = r.index;
        moved.user = user;
        moved.unlockAt = r.unlockAt;
        moved.amount = newAmount;
        moved.index = index;
        if (newAmount == 0) moved.forfeited = true;
        $.totalReserved -= amount - newAmount;
        $.totalLpReserved -= amount - newAmount;
        $.lpTokens[user][index] = newTokenId;

        delete $.lpReservations[oldTokenId];

        emit LpBonusMoved(oldTokenId, newTokenId, user, amount, newAmount);
    }

    // ──────────────────────── Reconciliation ───────────────────

    /**
     * @notice Makes the state of the LP reservation of `tokenId` explicit after a missed
     *         notification — a failed (fail-open) `onUnstake` of the vault, or a failed
     *         `onRebalance` of the vault before 2026-11-10. Anyone may call, before or after the
     *         unlock. The backend sends no transaction: for every `BonusListenerFailed(tokenId)`
     *         it raises the alert `lp.vault.bonus_listener_failed` with this call as the action,
     *         and the operator (or anyone) sends it. Forfeited tokens stay as surplus.
     * @dev A no-op for a missing, claimed, forfeited or settled record, and while no vault is
     *      linked. Otherwise, with `missedAt = vault.listenerMissedAt(tokenId)`:
     *        - before the unlock: forfeits when the record is DEAD (`missedAt != 0`, necessarily
     *          before the unlock) OR `vault.stakerOf(tokenId) != user` — the early exit
     *          {onUnstake} would have forfeited, even when the same NFT was staked again;
     *        - after the unlock: SETTLES a MISSED-AFTER record (`missedAt >= unlockAt`: the user
     *          left legitimately, {LpBonusSettled}, returns false); forfeits a DEAD record
     *          (`missedAt < unlockAt`) whoever holds the NFT now; otherwise forfeits when
     *          `stakerOf(tokenId) != user` (a stale record {claim} would never pay).
     * @return forfeited True when the reservation was forfeited by this call.
     */
    function reconcileLp(uint256 tokenId) external nonReentrant returns (bool forfeited) {
        V3BonusVaultStorage storage $ = _bonusStorage();
        LpReservation storage r = $.lpReservations[tokenId];
        address vault_ = $.vault;
        if (vault_ == address(0) || !_isOpen(r) || $.lpSettled[tokenId]) return false;
        uint64 missedAt = IV3BonusLpVault(vault_).listenerMissedAt(tokenId);
        if (_isMissedAfter(r, missedAt)) {
            _settleLp($, r, tokenId);
            return false;
        }
        if (!_isDead(r, missedAt) && IV3BonusLpVault(vault_).stakerOf(tokenId) == r.user) return false;
        _forfeitLp($, r, tokenId);
        return true;
    }

    // ──────────────────────── Funding and claim ────────────────

    /// @notice Moves `amount` $ASSET from the caller into the vault. Anyone may fund.
    function fund(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        IERC20 token = _bonusStorage().bonusToken;
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(msg.sender, amount, token.balanceOf(address(this)));
    }

    /**
     * @notice Pays the caller everything of theirs that is unlocked: the v3 reservation once its
     *         unlock time has passed, plus every LP reservation that is unlocked, not claimed, not
     *         forfeited, not DEAD, AND settled, missed-after or still held by the vault for the
     *         caller (see the header). A stale LP record is skipped (left for {reconcileLp}). All
     *         or nothing: reverts {InsufficientFunds} while the balance is short.
     */
    function claim() external nonReentrant returns (uint256 amount) {
        V3BonusVaultStorage storage $ = _bonusStorage();

        UserReservation storage r = $.reservations[msg.sender];
        if (r.amount > 0 && block.timestamp >= r.unlockAt) {
            amount = r.amount;
            r.amount = 0;
        }

        uint256 lpTotal;
        uint256[] storage ids = $.lpTokens[msg.sender];
        for (uint256 i = 0; i < ids.length; ++i) {
            uint256 lpAmount = _lpClaimable($, ids[i]);
            if (lpAmount > 0) {
                lpTotal += lpAmount;
                $.lpReservations[ids[i]].claimed = true;
            }
        }
        amount += lpTotal;

        if (amount == 0) revert NothingToClaim();
        uint256 balance = $.bonusToken.balanceOf(address(this));
        if (balance < amount) revert InsufficientFunds(amount, balance);

        $.totalReserved -= amount;
        $.totalLpReserved -= lpTotal;
        $.bonusToken.safeTransfer(msg.sender, amount);

        emit BonusClaimed(msg.sender, amount);
    }

    // ──────────────────────── Owner functions ──────────────────

    function setMigrator(address migrator_) external onlyOwner {
        _setMigrator(migrator_);
    }

    /// @notice Moves the {onEarlyExit} caller. Only TOGETHER with the pool's own `setBonusVault`
    ///         (one timelock batch): a pool that still notifies this contract while it is no
    ///         longer the registered pool has every early exit revert (fail closed), and a new pool
    ///         without the notification would let an early exit keep its bonus.
    function setPool(address pool_) external onlyOwner {
        if (pool_ == address(0)) revert ZeroAddress();
        _setPool(pool_);
    }

    /// @notice Moves (or clears) the LP vault whose notifications this contract accepts. Refused
    ///         while any LP reservation is outstanding ({LpReservationsOutstanding}): its exits and
    ///         re-ranges are reported only by the vault that holds the position.
    function setVault(address vault_) external onlyOwner {
        uint256 lpReserved = _bonusStorage().totalLpReserved;
        if (lpReserved != 0) revert LpReservationsOutstanding(lpReserved);
        _setVault(vault_);
    }

    /// @notice Sets the cap on {totalReserved}. A cap below the current total stops new
    ///         reservations and touches none of the existing ones.
    function setMaxTotalReserved(uint256 maxTotalReserved_) external onlyOwner {
        _setMaxTotalReserved(maxTotalReserved_);
    }

    /// @notice Moves `amount` of the surplus (`balance - totalReserved`) to `to`. No reservation
    ///         is reachable: above the surplus it reverts {SurplusExceeded}, with none {NoSurplus}.
    function recoverSurplus(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        V3BonusVaultStorage storage $ = _bonusStorage();
        uint256 balance = $.bonusToken.balanceOf(address(this));
        uint256 reserved = $.totalReserved;
        if (balance <= reserved) revert NoSurplus();
        uint256 available = balance - reserved;
        if (amount > available) revert SurplusExceeded(amount, available);
        $.bonusToken.safeTransfer(to, amount);
        emit SurplusRecovered(to, amount);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function renounceOwnership() public override onlyOwner {
        revert RenounceDisabled();
    }

    // ──────────────────────── Internal helpers ─────────────────

    function _setMigrator(address migrator_) private {
        V3BonusVaultStorage storage $ = _bonusStorage();
        emit MigratorSet($.migrator, migrator_);
        $.migrator = migrator_;
    }

    function _setMaxTotalReserved(uint256 maxTotalReserved_) private {
        V3BonusVaultStorage storage $ = _bonusStorage();
        emit MaxTotalReservedSet($.maxTotalReserved, maxTotalReserved_);
        $.maxTotalReserved = maxTotalReserved_;
    }

    /// @dev Reverts {BudgetExceeded} when `amount` more would take `totalReserved` above the cap.
    function _checkBudget(V3BonusVaultStorage storage $, uint256 amount) private view {
        uint256 reserved = $.totalReserved;
        uint256 cap = $.maxTotalReserved;
        if (reserved + amount > cap) revert BudgetExceeded(amount, cap > reserved ? cap - reserved : 0);
    }

    /// @dev Forfeits an active LP reservation: both totals drop, the tokens stay as surplus.
    function _forfeitLp(V3BonusVaultStorage storage $, LpReservation storage r, uint256 tokenId) private {
        uint256 amount = r.amount;
        $.totalReserved -= amount;
        $.totalLpReserved -= amount;
        r.amount = 0;
        r.forfeited = true;
        emit LpBonusForfeited(tokenId, r.user, amount);
    }

    function _setPool(address pool_) private {
        V3BonusVaultStorage storage $ = _bonusStorage();
        emit PoolSet($.pool, pool_);
        $.pool = pool_;
    }

    /// @dev Zero switches the LP side off (every hook call is then rejected). A non-zero vault must
    ///      trade the bonus token, which fixes the valuation's orientation.
    function _setVault(address vault_) private {
        V3BonusVaultStorage storage $ = _bonusStorage();
        if (vault_ != address(0)) {
            address token = address($.bonusToken);
            address token0_ = IV3BonusLpVault(vault_).token0();
            address token1_ = IV3BonusLpVault(vault_).token1();
            if (token != token0_ && token != token1_) revert BonusTokenNotInPool(token, token0_, token1_);
            $.bonusIsToken0 = token == token0_;
        }
        emit VaultSet($.vault, vault_);
        $.vault = vault_;
    }

    /// @dev Settles an open reservation after its unlock (once): the vault reported an unstake or
    ///      a re-range then, so the bonus pays without the vault holding the tokenId. A DEAD
    ///      record (its forfeit was missed before the unlock) is forfeited instead, never
    ///      settled. No-op for a missing, claimed, forfeited or already settled record.
    function _settleLp(V3BonusVaultStorage storage $, LpReservation storage r, uint256 tokenId) private {
        if (!_isOpen(r) || $.lpSettled[tokenId]) return;
        if (_isDead(r, _missedAt($, tokenId))) {
            _forfeitLp($, r, tokenId);
            return;
        }
        $.lpSettled[tokenId] = true;
        emit LpBonusSettled(tokenId, r.user);
    }

    /// @dev When the vault first missed its `onUnstake` notification for `tokenId` (zero = never).
    ///      Called only inside the two vault hooks ({onlyVault}), so `$.vault` is the caller and
    ///      never zero there.
    function _missedAt(V3BonusVaultStorage storage $, uint256 tokenId) private view returns (uint64) {
        return IV3BonusLpVault($.vault).listenerMissedAt(tokenId);
    }

    /// @dev DEAD: a notification was missed before the unlock, so the forfeit of an early exit
    ///      never ran. The record never pays.
    function _isDead(LpReservation storage r, uint64 missedAt) private view returns (bool) {
        return missedAt != 0 && missedAt < r.unlockAt;
    }

    /// @dev MISSED-AFTER: the first missed notification came at or after the unlock, so the
    ///      settlement of a legitimate exit never ran. The record pays as if settled.
    function _isMissedAfter(LpReservation storage r, uint64 missedAt) private view returns (bool) {
        return missedAt != 0 && missedAt >= r.unlockAt;
    }

    /// @dev Recorded, not claimed, not forfeited.
    function _isOpen(LpReservation storage r) private view returns (bool) {
        return r.user != address(0) && !r.claimed && !r.forfeited;
    }

    /// @dev Recorded, not claimed, not forfeited, before its unlock.
    function _isActive(LpReservation storage r) private view returns (bool) {
        return _isOpen(r) && block.timestamp < r.unlockAt;
    }

    /// @dev What the LP reservation of `tokenId` pays now: zero when it is claimed, forfeited,
    ///      before its unlock or DEAD; its amount when it is settled or MISSED-AFTER, or else while
    ///      the vault still holds it for its user; zero otherwise (a stale record pays nothing).
    ///      The vault reads come after the storage checks. With no vault linked only a settled
    ///      record pays.
    function _lpClaimable(V3BonusVaultStorage storage $, uint256 tokenId) private view returns (uint256) {
        LpReservation storage r = $.lpReservations[tokenId];
        if (r.claimed || r.forfeited || block.timestamp < r.unlockAt) return 0;
        address vault_ = $.vault;
        if (vault_ == address(0)) return $.lpSettled[tokenId] ? r.amount : 0;
        uint64 missedAt = IV3BonusLpVault(vault_).listenerMissedAt(tokenId);
        if (_isDead(r, missedAt)) return 0;
        if ($.lpSettled[tokenId] || _isMissedAfter(r, missedAt)) return r.amount;
        if (IV3BonusLpVault(vault_).stakerOf(tokenId) != r.user) return 0;
        return r.amount;
    }

    /// @dev `BonusEscrow._scaled`, verbatim in meaning: the reservation times min(1, valueNew /
    ///      valueOld), both positions valued at the vault's TWAP in the bonus token.
    function _scaled(uint256 amount, Snapshot calldata old_, Snapshot calldata new_) private view returns (uint256) {
        V3BonusVaultStorage storage $ = _bonusStorage();
        (, int24 twapTick,,) = IV3BonusLpVault($.vault).previewTwap();
        bool inToken0 = $.bonusIsToken0;

        uint256 valueOld = PositionValue.valueAt(old_.liquidity, old_.tickLower, old_.tickUpper, twapTick, inToken0);
        if (valueOld == 0) return 0;
        uint256 valueNew = PositionValue.valueAt(new_.liquidity, new_.tickLower, new_.tickUpper, twapTick, inToken0);
        if (valueNew >= valueOld) return amount;
        return Math.mulDiv(amount, valueNew, valueOld);
    }
}
