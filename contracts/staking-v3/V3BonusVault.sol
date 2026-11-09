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
///      TWAP (to value a rebalanced position), exactly as `BonusEscrow` reads them, and the staker
///      of a position ({V3BonusVault-reconcileLp}).
interface IV3BonusLpVault {
    function stakerOf(uint256 tokenId) external view returns (address);

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
 *      {onUnstake} before the unlock forfeits it; after the unlock both hooks return at once and it
 *      stays claimable even if the position is unstaked later.
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
 *  A MISSED NOTIFICATION. The LP vault's notifications to this contract fail open: when one reverts
 *  the vault emits `BonusListenerFailed(tokenId)` and the LP reservation stays where it was, still
 *  active. {reconcileLp} (anyone; the backend calls it for every `BonusListenerFailed`) compares
 *  the reservation with the vault: when the position is no longer staked there by the reservation's
 *  user (unstaked, or re-ranged into a new tokenId), the stale reservation is forfeited.
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
        /// uint16 keeps the five fields in ONE slot (a cheaper fail-open rebalance hook).
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

    /// @notice The tokenIds whose LP reservations belong to `user` (a rebalance rewrites its entry).
    function lpTokensOf(address user) external view returns (uint256[] memory) {
        return _bonusStorage().lpTokens[user];
    }

    /// @notice What {claim} would pay `user` now, before the funding check.
    function claimable(address user) external view returns (uint256 amount) {
        V3BonusVaultStorage storage $ = _bonusStorage();
        UserReservation storage r = $.reservations[user];
        if (block.timestamp >= r.unlockAt) amount = r.amount;
        uint256[] storage ids = $.lpTokens[user];
        for (uint256 i = 0; i < ids.length; ++i) {
            amount += _lpClaimable($.lpReservations[ids[i]]);
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
    function onUnstake(uint256 tokenId) external onlyVault {
        V3BonusVaultStorage storage $ = _bonusStorage();
        LpReservation storage r = $.lpReservations[tokenId];
        if (!_isActive(r)) return;
        _forfeitLp($, r, tokenId);
    }

    /// @inheritdoc IBonusEscrowHooks
    function onRebalance(uint256 oldTokenId, uint256 newTokenId, Snapshot calldata old_, Snapshot calldata new_)
        external
        onlyVault
    {
        V3BonusVaultStorage storage $ = _bonusStorage();
        LpReservation storage r = $.lpReservations[oldTokenId];
        if (!_isActive(r)) return;

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
     * @notice Forfeits the LP reservation of `tokenId` when the LP vault no longer holds the
     *         position for the reservation's user — the state a failed (fail-open) `onUnstake` or
     *         `onRebalance` notification leaves behind. Anyone may call; the backend calls it for
     *         every `BonusListenerFailed(tokenId)` the vault emits.
     * @dev A no-op unless the reservation is active (recorded, not claimed, not forfeited, before
     *      its unlock) AND `vault.stakerOf(tokenId) != user`. After the unlock nothing is touched,
     *      exactly like {onUnstake}. No-op while no vault is linked.
     * @return forfeited True when the reservation was forfeited by this call.
     */
    function reconcileLp(uint256 tokenId) external nonReentrant returns (bool forfeited) {
        V3BonusVaultStorage storage $ = _bonusStorage();
        LpReservation storage r = $.lpReservations[tokenId];
        address vault_ = $.vault;
        if (vault_ == address(0) || !_isActive(r)) return false;
        if (IV3BonusLpVault(vault_).stakerOf(tokenId) == r.user) return false;
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
     *         unlock time has passed, plus every LP reservation that is unlocked, not claimed and not
     *         forfeited. All or nothing: reverts {InsufficientFunds} while the balance is short.
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
            LpReservation storage lp = $.lpReservations[ids[i]];
            uint256 lpAmount = _lpClaimable(lp);
            if (lpAmount > 0) {
                lpTotal += lpAmount;
                lp.claimed = true;
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

    /// @dev Recorded, not claimed, not forfeited, before its unlock.
    function _isActive(LpReservation storage r) private view returns (bool) {
        return r.user != address(0) && !r.claimed && !r.forfeited && block.timestamp < r.unlockAt;
    }

    function _lpClaimable(LpReservation storage r) private view returns (uint256) {
        if (r.claimed || r.forfeited || block.timestamp < r.unlockAt) return 0;
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
