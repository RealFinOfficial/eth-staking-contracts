// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";

import "./interfaces/IBonusEscrowHooks.sol";
import "./libraries/PositionValue.sol";

/// @dev The three calls the escrow makes into the vault. Declared locally, like the adapter's own
///      copy, so the escrow never imports the core contract.
interface IBonusEscrowVault {
    function token0() external view returns (address);

    function token1() external view returns (address);

    function previewTwap()
        external
        view
        returns (int24 currentTick, int24 twapTick, int24 maxDeviationTicks, bool withinBounds);
}

/**
 * @title BonusEscrow
 * @notice The whole life of an ApeBond campaign bonus, and nothing else: reserve, move, scale,
 *         forfeit, pay (B.3 decision document, 2026-10-01, with the overrides of 2026-10-05).
 *
 *  WHAT A RESERVATION IS. The adapter (`ApeBondPositionAdapter`) computes a bonus when it stakes a
 *  freshly bought position for its buyer, and records it here under the position's `tokenId` —
 *  an identity the Uniswap position manager issues once and never reuses (A5). The record holds
 *  the beneficiary, the amount, the cliff (`unlockAt`) and two flags, `claimed` and `forfeited`.
 *  There is no purchase id and no number from a backend anywhere in it (D4).
 *
 *  RESERVE NOW, FUND LATER — NO CEILING (override O2, 2026-10-05). {reserve} records the bonus
 *  WHATEVER the escrow's balance is: there is no funding check, no per-purchase cap, no
 *  per-campaign cap and no total cap of any kind. The balance is checked only when the money
 *  moves: {claim} pays the whole amount, or reverts with {InsufficientFunds} and changes nothing
 *  until the company funds this contract. `totalReserved` is the sum of every amount still owed
 *  (neither claimed nor forfeited); the backend alerts when it exceeds the balance.
 *
 *  THE BONUS IS CONDITIONAL ON STAYING STAKED THROUGH THE CLIFF (D1, D8). The vault reports every
 *  `unstake` and every `rebalance` to this contract AT THE MOMENT IT HAPPENS (P5), through
 *  {IBonusEscrowHooks}. A reservation is ACTIVE while it exists, is not claimed, is not forfeited
 *  and `block.timestamp < unlockAt`:
 *    - {onUnstake} of an active reservation FORFEITS it: `totalReserved` drops by the amount, the
 *      amount becomes zero and `forfeited` is set. The record stays, so the same NFT can never
 *      carry a second bonus ({DuplicateReservation}).
 *    - {onRebalance} of an active reservation MOVES it to the new `tokenId` and SCALES it by
 *      `min(1, valueNew / valueOld)`, both positions valued with {PositionValue-valueAt} at the
 *      vault's TWAP tick (P3; the deviation flag is not consulted — both are valued at the same
 *      price). The bonus never increases. A rebalance that keeps the value keeps the amount; one
 *      that returns tokens to the staker reduces it in proportion; one that leaves nothing
 *      forfeits it.
 *    - On a reservation that is NOT active both hooks return at once and read no oracle. That one
 *      rule is D3: after the cliff nothing the vault reports can touch the bonus — a rebalance
 *      after the cliff leaves the reservation under the OLD `tokenId`, and {claim} is called with
 *      that id. It also keeps an ordinary staker's rebalance free of any oracle dependency.
 *
 *  ANYONE MAY TRIGGER A CLAIM, but only the RECORDED beneficiary is ever paid: the payout address
 *  comes from storage written at reserve time and is never an argument.
 *
 *  NO PAUSE, NO GUARDIAN, NO ADMIN FUNCTION THAT TOUCHES A RESERVATION (Q5). A reservation changes
 *  only by rule — through the adapter at {reserve}, through the vault's two notifications, and
 *  through {claim}. The owner holds exactly three things: `_authorizeUpgrade`, {setAdapter} and
 *  {recoverSurplus}, and the last one is bounded by arithmetic to `balance - totalReserved`.
 *
 *  UPGRADEABILITY. This contract is the implementation behind a UUPS (ERC-1967) proxy
 *  (`deploy/LPProxy.sol`), owned by the `LPTimelock`; ownership is two-step and
 *  `renounceOwnership` is disabled. Mutable state lives in ONE ERC-7201 namespaced struct. This is
 *  a CLEAN version-1 layout (`reservations` keyed by `uint256 tokenId`, a `forfeited` flag): the
 *  Sepolia test stack #5 escrow, which keyed by purchase id, is abandoned rather than upgraded,
 *  so nothing had to be appended around an old layout.
 *
 *  IMMUTABLES. `bonusToken`, `vault` and `bonusIsToken0` live in the implementation's bytecode. The
 *  constructor proves the bonus token is one of the vault's two pool tokens — the value of a
 *  position can only be expressed in one of them — and an upgrade that changed any of the three
 *  would be a different program, not a fix.
 *
 *  INVARIANTS (B.3 document §5.6, plus I8):
 *    I1 `totalReserved` = sum of `amount` over reservations neither claimed nor forfeited.
 *    I2 a reservation's `amount` never increases after {reserve}.
 *    I3 before its cliff, an active reservation sits under a `tokenId` the vault holds for its
 *       beneficiary (the vault reports every exit and every re-range).
 *    I4 no state of this contract can make `unstake` revert, given gas above the vault's floor
 *       ({onUnstake} makes no external call and is called inside the vault's `try`).
 *    I5 at {reserve}, amount <= positionValue x bonusBps / 10,000 at the TWAP (the adapter's).
 *    I6 at most one reservation is ever created for a given `tokenId`.
 *    I7 after `unlockAt`, only {claim} changes a reservation.
 *    I8 a claim pays exactly `amount` from a balance >= `amount`, or reverts and changes nothing.
 */
contract BonusEscrow is
    Initializable,
    UUPSUpgradeable,
    Ownable2StepUpgradeable,
    ReentrancyGuard,
    IBonusEscrowHooks
{
    using SafeERC20 for IERC20;

    // ──────────────────────── Errors ───────────────────────────

    /// @dev An argument that must reference a live address was address(0).
    error ZeroAddress();

    /// @dev A zero amount was passed where a positive one is required.
    error ZeroAmount();

    /// @dev The bonus token is neither of the vault's two pool tokens.
    error BonusTokenNotInPool(address bonusToken, address token0, address token1);

    /// @dev {reserve} was called by someone other than the configured adapter — the owner
    ///      included. `adapter` is address(0) when the reserve path is closed.
    error NotAdapter(address caller, address adapter);

    /// @dev A hook was called by someone other than the vault.
    error NotVault(address caller, address vault);

    /// @dev `tokenId` already carries a reservation (active, claimed or forfeited). One per NFT.
    error DuplicateReservation(uint256 tokenId);

    /// @dev No reservation was ever recorded under `tokenId`.
    error UnknownReservation(uint256 tokenId);

    /// @dev The reservation under `tokenId` has already been paid out.
    error AlreadyClaimed(uint256 tokenId);

    /// @dev The reservation under `tokenId` was forfeited (an exit before the cliff, or a
    ///      rebalance that left the position with no value).
    error Forfeited(uint256 tokenId);

    /// @dev The cliff has not passed yet. `unlockAt` is the reservation's own.
    error CliffNotReached(uint256 unlockAt, uint256 blockTimestamp);

    /// @dev The escrow holds less of the bonus token than this claim pays. The claim succeeds
    ///      once the company funds the escrow; nothing is paid in part.
    error InsufficientFunds(uint256 needed, uint256 balance);

    /// @dev Every wei held is owed (or more is owed than is held), so there is nothing to recover.
    error NoSurplus();

    /// @dev `renounceOwnership` is disabled: it would freeze the upgrade path forever.
    error RenounceDisabled();

    // ──────────────────────── Immutables ───────────────────────

    /// @notice The token every bonus is denominated and paid in ($ASSET).
    /// @dev Implementation bytecode, not proxy storage — see the contract note.
    IERC20 public immutable bonusToken;

    /// @notice The vault (the PROXY) whose notifications this escrow accepts, and whose TWAP it
    ///         values a rebalanced position at.
    /// @dev Implementation bytecode, not proxy storage — see the contract note.
    address public immutable vault;

    /// @notice True when the bonus token is the pool's token0; positions are valued in it.
    bool public immutable bonusIsToken0;

    // ──────────────────────── Storage ──────────────────────────

    /**
     * @notice One bonus, as recorded at deposit time and changed only by rule afterwards.
     * @dev The first four fields share one slot; `amount` is a full `uint256` so no bonus is
     *      unrepresentable and no cast can truncate one.
     */
    struct Reservation {
        /// Sole payout address, written once at {reserve} and carried through every move.
        address beneficiary;
        /// Timestamp from which the bonus may be claimed. Before it, the reservation is active.
        uint64 unlockAt;
        /// True once paid. Set BEFORE the transfer.
        bool claimed;
        /// True once lost: an exit before the cliff, or a rebalance that left no value.
        bool forfeited;
        /// The bonus, in `bonusToken` units. Zero once forfeited.
        uint256 amount;
    }

    /// @custom:storage-location erc7201:real.lp.storage.BonusEscrow
    struct BonusEscrowStorage {
        /// The only account allowed to {reserve}. Zero closes the reserve path.
        address adapter;
        /// Sum of every amount neither claimed nor forfeited (I1).
        uint256 totalReserved;
        /// Position NFT id => its bonus.
        mapping(uint256 => Reservation) reservations;
    }

    /**
     * @dev ERC-7201 slot for {BonusEscrowStorage}, computed as
     *      `keccak256(abi.encode(uint256(keccak256("real.lp.storage.BonusEscrow")) - 1)) & ~bytes32(uint256(0xff))`.
     *      Pinned as a literal because it must never move: it IS the obligations' address.
     *      `test/forge/unit/BonusEscrowBranches.t.sol` recomputes it and fails if it drifts.
     */
    bytes32 private constant BONUS_ESCROW_STORAGE =
        0x206c24b685fdfe8aa4f7e59e2f442e89924a4d38c64044591f2a80ed05456200;

    function _escrowStorage() private pure returns (BonusEscrowStorage storage $) {
        assembly {
            $.slot := BONUS_ESCROW_STORAGE
        }
    }

    // ──────────────────────── Events ───────────────────────────

    /// @notice The reserve right moved. Carries both sides; zero means the path is closed.
    event AdapterSet(address previousAdapter, address newAdapter);

    /// @notice A bonus was recorded for a freshly staked position.
    event BonusReserved(uint256 indexed tokenId, address indexed beneficiary, uint256 amount, uint64 unlockAt);

    /// @notice A bonus was paid to its recorded beneficiary.
    event BonusClaimed(uint256 indexed tokenId, address indexed beneficiary, uint256 amount);

    /// @notice A bonus was lost: the position left the vault before the cliff. `amount` is what
    ///         was owed until this transaction.
    event BonusForfeited(uint256 indexed tokenId, address indexed beneficiary, uint256 amount);

    /// @notice A bonus followed its position to a new NFT through a rebalance before the cliff,
    ///         scaled by the share of the position's value that stayed staked. `newAmount` is
    ///         never above `previousAmount`; zero means the reservation is now forfeited.
    event BonusMoved(
        uint256 indexed oldTokenId,
        uint256 indexed newTokenId,
        address indexed beneficiary,
        uint256 previousAmount,
        uint256 newAmount
    );

    /// @notice The unreserved balance left the escrow.
    event SurplusRecovered(address to, uint256 amount);

    // ──────────────────────── Modifiers ────────────────────────

    /// @dev The vault's two notifications, and nothing else, come through here.
    modifier onlyVault() {
        if (msg.sender != vault) revert NotVault(msg.sender, vault);
        _;
    }

    // ──────────────────────── Constructor ──────────────────────

    /**
     * @notice Deploys the IMPLEMENTATION. It holds no state of its own and is never called
     *         directly; the proxy in front of it runs {initialize}.
     * @param bonusToken_ The token every bonus is paid in. Must be one of the vault's pool tokens.
     * @param vault_ The vault PROXY whose notifications this escrow accepts.
     * @dev `_disableInitializers()` stops anyone from initialising the bare implementation.
     */
    constructor(IERC20 bonusToken_, address vault_) {
        if (address(bonusToken_) == address(0) || vault_ == address(0)) revert ZeroAddress();

        address token0_ = IBonusEscrowVault(vault_).token0();
        address token1_ = IBonusEscrowVault(vault_).token1();
        if (address(bonusToken_) == token0_) {
            bonusIsToken0 = true;
        } else if (address(bonusToken_) != token1_) {
            revert BonusTokenNotInPool(address(bonusToken_), token0_, token1_);
        }

        bonusToken = bonusToken_;
        vault = vault_;

        _disableInitializers();
    }

    // ──────────────────────── Initializer ──────────────────────

    /**
     * @notice One-time setup, executed on the PROXY in its own deployment transaction.
     * @param owner_   Owner: the `TimelockController` that owns the rest of the stack.
     * @param adapter_ The adapter allowed to {reserve}. `address(0)` leaves the reserve path
     *                 closed; the deploy scripts open it in the same timelock batch that links
     *                 the vault to this escrow, so neither half goes live without the other.
     * @dev `AdapterSet(address(0), adapter_)` is emitted either way, so the adapter history is
     *      complete from block one.
     */
    function initialize(address owner_, address adapter_) external initializer {
        __Ownable_init(owner_);
        __Ownable2Step_init();

        _escrowStorage().adapter = adapter_;

        emit AdapterSet(address(0), adapter_);
    }

    // ──────────────────────── Views ────────────────────────────

    /// @notice The only account allowed to {reserve}. Zero means the reserve path is closed.
    function adapter() external view returns (address) {
        return _escrowStorage().adapter;
    }

    /// @notice Sum of every bonus still owed — neither claimed nor forfeited. May exceed the
    ///         balance: reservations are recorded whatever the balance is.
    function totalReserved() external view returns (uint256) {
        return _escrowStorage().totalReserved;
    }

    /// @notice The bonus recorded under `tokenId`. A zero `beneficiary` means "no such reservation".
    function reservationOf(uint256 tokenId)
        external
        view
        returns (address beneficiary, uint256 amount, uint64 unlockAt, bool claimed, bool forfeited)
    {
        Reservation storage r = _escrowStorage().reservations[tokenId];
        return (r.beneficiary, r.amount, r.unlockAt, r.claimed, r.forfeited);
    }

    /// @notice What {claim} would pay once the escrow holds enough: the amount when the cliff has
    ///         passed and the reservation is neither claimed nor forfeited, zero otherwise.
    /// @dev Deliberately total rather than reverting, and deliberately blind to the balance: a
    ///      keeper or the frontend compares it with `bonusToken.balanceOf(escrow)` itself.
    function claimable(uint256 tokenId) external view returns (uint256) {
        Reservation storage r = _escrowStorage().reservations[tokenId];
        if (r.beneficiary == address(0) || r.claimed || r.forfeited || block.timestamp < r.unlockAt) return 0;
        return r.amount;
    }

    /// @notice True while the reservation under `tokenId` can still be forfeited or scaled: it
    ///         exists, is neither claimed nor forfeited, and its cliff has not passed.
    function isActive(uint256 tokenId) external view returns (bool) {
        return _isActive(_escrowStorage().reservations[tokenId]);
    }

    // ──────────────────────── Adapter function ─────────────────

    /**
     * @notice Records a bonus for a position the adapter has just staked for `beneficiary`.
     * @param tokenId     The position NFT. One reservation per NFT, ever.
     * @param beneficiary Sole payout address.
     * @param amount      The bonus, in `bonusToken` units, as the adapter computed it.
     * @param unlockAt    Timestamp from which it may be claimed.
     * @dev Adapter tier only. NO balance check of any kind (override O2): the bonus is recorded
     *      whatever this contract holds, and {claim} reverts until it is funded.
     */
    function reserve(uint256 tokenId, address beneficiary, uint256 amount, uint64 unlockAt) external {
        BonusEscrowStorage storage $ = _escrowStorage();

        address adapter_ = $.adapter;
        if (msg.sender != adapter_) revert NotAdapter(msg.sender, adapter_);
        if (beneficiary == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        Reservation storage r = $.reservations[tokenId];
        if (r.beneficiary != address(0)) revert DuplicateReservation(tokenId);

        r.beneficiary = beneficiary;
        r.unlockAt = unlockAt;
        r.amount = amount;
        $.totalReserved += amount;

        emit BonusReserved(tokenId, beneficiary, amount, unlockAt);
    }

    // ──────────────────────── Vault notifications ──────────────

    /**
     * @notice The vault reports that `tokenId` left it through `unstake`.
     * @dev Vault only. An ACTIVE reservation is forfeited; anything else returns at once. No
     *      external call and no transfer, so it fits the vault's fixed gas allowance with a wide
     *      margin and has nothing that could make the exit revert (I4) — the vault calls it
     *      inside `try` anyway.
     */
    function onUnstake(uint256 tokenId) external onlyVault {
        BonusEscrowStorage storage $ = _escrowStorage();
        Reservation storage r = $.reservations[tokenId];
        if (!_isActive(r)) return;

        uint256 amount = r.amount;
        $.totalReserved -= amount;
        r.amount = 0;
        r.forfeited = true;

        emit BonusForfeited(tokenId, r.beneficiary, amount);
    }

    /**
     * @notice The vault reports that `oldTokenId` was re-ranged into `newTokenId` under the same
     *         staker. `old_` is the old position as it was before its liquidity was withdrawn;
     *         `new_` is the new position as minted.
     * @dev Vault only, called with no `try` (the rebalance fails closed). An inactive reservation
     *      returns at once and reads NO oracle. An active one is valued twice at ONE price — the
     *      vault's TWAP tick, deviation flag not consulted — and scaled by `min(1, new / old)`:
     *      the bonus never increases, and a position worth nothing at the TWAP keeps nothing.
     *      The record moves to `newTokenId` (forfeited when the scaled amount is zero) and is
     *      deleted under `oldTokenId`, an NFT the vault burns in this same transaction.
     */
    function onRebalance(uint256 oldTokenId, uint256 newTokenId, Snapshot calldata old_, Snapshot calldata new_)
        external
        onlyVault
    {
        BonusEscrowStorage storage $ = _escrowStorage();
        Reservation storage r = $.reservations[oldTokenId];
        if (!_isActive(r)) return;

        Reservation storage moved = $.reservations[newTokenId];
        if (moved.beneficiary != address(0)) revert DuplicateReservation(newTokenId);

        uint256 amount = r.amount;
        uint256 newAmount = _scaled(amount, old_, new_);

        address beneficiary = r.beneficiary;
        moved.beneficiary = beneficiary;
        moved.unlockAt = r.unlockAt;
        moved.amount = newAmount;
        if (newAmount == 0) moved.forfeited = true;
        $.totalReserved -= amount - newAmount;

        delete $.reservations[oldTokenId];

        emit BonusMoved(oldTokenId, newTokenId, beneficiary, amount, newAmount);
    }

    // ──────────────────────── Claim ────────────────────────────

    /**
     * @notice Pays the bonus recorded under `tokenId` to its recorded beneficiary.
     * @param tokenId The reservation to pay — after a rebalance before the cliff, the NEW id;
     *        after a rebalance past the cliff, the id it had when the cliff passed.
     * @return amount The bonus paid.
     * @dev Callable by anyone, payable only to the beneficiary in storage. All or nothing: when
     *      the escrow holds less than the amount it reverts with {InsufficientFunds} and changes
     *      nothing (I8). `claimed` is set and `totalReserved` decremented BEFORE the transfer.
     */
    function claim(uint256 tokenId) external nonReentrant returns (uint256 amount) {
        BonusEscrowStorage storage $ = _escrowStorage();
        Reservation storage r = $.reservations[tokenId];

        address beneficiary = r.beneficiary;
        if (beneficiary == address(0)) revert UnknownReservation(tokenId);
        if (r.claimed) revert AlreadyClaimed(tokenId);
        if (r.forfeited) revert Forfeited(tokenId);
        if (block.timestamp < r.unlockAt) revert CliffNotReached(r.unlockAt, block.timestamp);

        amount = r.amount;
        uint256 balance = bonusToken.balanceOf(address(this));
        if (balance < amount) revert InsufficientFunds(amount, balance);

        r.claimed = true;
        $.totalReserved -= amount;

        bonusToken.safeTransfer(beneficiary, amount);

        emit BonusClaimed(tokenId, beneficiary, amount);
    }

    // ──────────────────────── Owner functions ──────────────────

    /// @notice Points the escrow at the adapter allowed to reserve, or at nothing.
    /// @param newAdapter The new adapter. `address(0)` closes the reserve path.
    /// @dev The adapter is replaceable, not upgradeable: replacing it is a new deployment, this
    ///      call and the vault's `setStakeOperator`, in one timelock batch. Reservations already
    ///      made are unaffected.
    function setAdapter(address newAdapter) external onlyOwner {
        BonusEscrowStorage storage $ = _escrowStorage();
        emit AdapterSet($.adapter, newAdapter);
        $.adapter = newAdapter;
    }

    /**
     * @notice Moves the UNRESERVED balance out: `balanceOf(this) - totalReserved`.
     * @param to Destination for the surplus.
     * @dev The amount is not an argument and cannot be, so no reservation is ever reachable.
     *      Reverts with {NoSurplus} when nothing is free — including while more is owed than held.
     *      No `nonReentrant`: the transfer is the last statement and the amount is derived from
     *      the live balance, so a callback that re-entered {claim} would only pay a beneficiary
     *      out of money that was never the surplus.
     */
    function recoverSurplus(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();

        uint256 balance = bonusToken.balanceOf(address(this));
        uint256 reserved = _escrowStorage().totalReserved;
        if (balance <= reserved) revert NoSurplus();

        uint256 amount = balance - reserved;
        bonusToken.safeTransfer(to, amount);

        emit SurplusRecovered(to, amount);
    }

    /// @notice UUPS upgrade hook. The owner is the timelock.
    /// @dev Empty body on purpose: `onlyOwner` is the whole authorization.
    function _authorizeUpgrade(address) internal override onlyOwner {}

    /// @notice Disabled. Renouncing would freeze `_authorizeUpgrade` forever.
    /// @dev Kept `onlyOwner` and not `view`, so it keeps the ABI of the call it overrides.
    function renounceOwnership() public override onlyOwner {
        revert RenounceDisabled();
    }

    // ──────────────────────── Internal helpers ─────────────────

    /// @dev Exists, not claimed, not forfeited, cliff not reached.
    function _isActive(Reservation storage r) private view returns (bool) {
        return r.beneficiary != address(0) && !r.claimed && !r.forfeited && block.timestamp < r.unlockAt;
    }

    /// @dev `min(amount, amount x valueNew / valueOld)`, both positions valued at the vault's TWAP
    ///      tick with {PositionValue-valueAt}; zero when the old position is worth nothing.
    function _scaled(uint256 amount, Snapshot calldata old_, Snapshot calldata new_) private view returns (uint256) {
        (, int24 twapTick,,) = IBonusEscrowVault(vault).previewTwap();

        uint256 valueOld =
            PositionValue.valueAt(old_.liquidity, old_.tickLower, old_.tickUpper, twapTick, bonusIsToken0);
        if (valueOld == 0) return 0;
        uint256 valueNew =
            PositionValue.valueAt(new_.liquidity, new_.tickLower, new_.tickUpper, twapTick, bonusIsToken0);
        if (valueNew >= valueOld) return amount;
        return Math.mulDiv(amount, valueNew, valueOld);
    }
}
