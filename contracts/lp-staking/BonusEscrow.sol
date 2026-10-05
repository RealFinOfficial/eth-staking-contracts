// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";

/**
 * @title BonusEscrow
 * @notice Custodian for the GUARANTEED ApeBond campaign bonus, and for nothing else.
 *
 *  What it is for (integration spec §6.3): an ApeBond purchase routed through SoulZap earns
 *  the buyer a fixed extra payout on top of the bond itself. That payout is promised at
 *  purchase time and paid after a cliff, so between those two moments the money has to be
 *  somewhere it cannot be spent twice, cannot be spent on someone else, and cannot be walked
 *  back by an admin. This contract is that somewhere:
 *
 *    - The adapter RESERVES against a balance this contract already holds. A reservation is
 *      never a promise to fund later: `reserve` reverts unless the unreserved balance already
 *      covers it, so an underfunded campaign fails the purchase transaction upstream rather
 *      than minting an IOU nobody can pay.
 *    - Every reservation is keyed by the purchase id, records its own beneficiary, its own
 *      amount and its own cliff, and is spent exactly once.
 *    - `totalReserved` is the sum of everything still owed. It is the ONLY thing standing
 *      between the owner and the balance: {recoverSurplus} can move `balance - totalReserved`
 *      and not one wei more, so reserved money is out of the admin's reach by arithmetic
 *      rather than by policy.
 *
 *  NO PAUSE, NO GUARDIAN — deliberately. The rest of the LP-staking stack runs a two-tier
 *  admin (a timelock owner, a multisig guardian holding the undelayed switches) because it has
 *  fast paths worth stopping: a leaked voucher signer, a claim function paying wrong amounts.
 *  Here there is nothing of that shape. A reservation is already funded, already priced and
 *  already owed; the only thing a pause could do is withhold money the contract has already
 *  been paid to hold. So {claim} has no switch in front of it, and there is no role that could
 *  add one without an upgrade. This is a promise-keeping contract, not a risk surface.
 *
 *  ADAPTER, NOT ROLE-SET. `adapter` is a single address and it is the only account that can
 *  reserve. It is set in {initialize} — the escrow is born owned by the timelock and born
 *  pointing at its adapter, because {setAdapter} is owner-tier and no key ever holds that tier.
 *  Replacing the adapter afterwards is one owner transaction ({setAdapter}, through the
 *  timelock), and setting it to `address(0)` closes the reserve path outright — which is the
 *  wind-down lever, and the closest thing to a pause this contract has. Reservations already
 *  made are unaffected by either: they are owed to their beneficiaries no matter who the
 *  adapter is afterwards.
 *
 *  ANYONE MAY TRIGGER A CLAIM, but only the RECORDED beneficiary is ever paid. The payout
 *  address comes from storage written at reserve time and is never taken as an argument, so an
 *  open trigger cannot redirect a single wei — it can only pay someone else's bonus for them,
 *  and pay their gas doing it. That is what lets the campaign be swept by a keeper, or by the
 *  front end on the user's behalf, without a signature scheme.
 *
 *  UPGRADEABILITY. This contract is the implementation behind a UUPS (ERC-1967) proxy — see
 *  `contracts/lp-staking/deploy/LPProxy.sol`. The team's split is by what the contract holds:
 *  the money-holding contract is upgradeable, the adapter in front of it is not.
 *
 *    - Why upgradeable: `reservations` and `totalReserved` are the only record of what is owed
 *      to whom. Fixing a bug by deploying a replacement would leave the ledger behind in a
 *      contract whose code is the thing being replaced, and every outstanding bonus with it.
 *      A proxy is what lets the code change while the obligations stay where they are.
 *    - Mutable state therefore lives in ONE ERC-7201 namespaced struct: an upgrade may append
 *      fields to it, and nothing an inherited OpenZeppelin contract does to its own namespace
 *      can move ours.
 *    - `bonusToken` stays `immutable`. Which token the campaign pays in is a fixed protocol
 *      reference; an upgrade that changed it would be settling the obligations in a different
 *      currency, which is a different program rather than a fix.
 *    - The implementation's own initializers are burnt in its constructor, so the bare
 *      implementation can never be initialised and taken over.
 *
 *  ADMIN. `owner` is the `TimelockController` that owns the rest of the stack, and it holds
 *  exactly three things: `_authorizeUpgrade`, {setAdapter} and {recoverSurplus}. Ownership is
 *  two-step (`Ownable2StepUpgradeable`), and `renounceOwnership` is disabled: renouncing would
 *  freeze `_authorizeUpgrade` forever, which is the opposite of why the proxy exists.
 */
contract BonusEscrow is Initializable, UUPSUpgradeable, Ownable2StepUpgradeable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ──────────────────────── Errors ───────────────────────────

    /// @dev An argument that must reference a live address was address(0).
    error ZeroAddress();

    /// @dev A zero amount was passed where a positive one is required.
    error ZeroAmount();

    /// @dev {reserve} was called by someone other than the configured adapter — the owner
    ///      included. `adapter` is address(0) when the reserve path is closed.
    error NotAdapter(address caller, address adapter);

    /// @dev `purchaseId` already carries a reservation. Ids are spent once and never reused.
    error DuplicateReservation(bytes32 purchaseId);

    /// @dev The unreserved balance does not cover the requested reservation.
    error Underfunded(uint256 available, uint256 requested);

    /// @dev No reservation was ever recorded under `purchaseId`.
    error UnknownReservation(bytes32 purchaseId);

    /// @dev The reservation under `purchaseId` has already been paid out.
    error AlreadyClaimed(bytes32 purchaseId);

    /// @dev The cliff has not passed yet. `unlockAt` is the reservation's own, not a global one.
    error CliffNotReached(uint256 unlockAt, uint256 blockTimestamp);

    /// @dev Every wei held is reserved, so there is nothing an admin may take.
    error NoSurplus();

    /// @dev `renounceOwnership` is disabled: it would freeze the upgrade path forever.
    error RenounceDisabled();

    // ──────────────────────── Immutables ───────────────────────

    /// @notice The token every bonus is denominated in and paid in.
    /// @dev Implementation bytecode, not proxy storage — see the upgradeability note above.
    IERC20 public immutable bonusToken;

    // ──────────────────────── Storage ──────────────────────────

    /**
     * @notice One buyer's guaranteed bonus, as recorded at purchase time.
     * @dev Field sizes: `amount` is a full `uint256` so no campaign size is unrepresentable and
     *      no cast can silently truncate a bonus. `unlockAt` is the `uint64` the adapter passes
     *      in — seconds since the epoch, good past the year 500 billion — and `claimed` is the
     *      spent flag. Those three share one slot as declared, which is free: the packing falls
     *      out of the natural types rather than out of shrinking `amount` to fit.
     */
    struct Reservation {
        /// Sole payout address, written once and never taken as an argument afterwards.
        address beneficiary;
        /// Timestamp from which the bonus may be claimed. Before it, {claim} reverts.
        uint64 unlockAt;
        /// True once paid. Set BEFORE the transfer, so the record is spent before the money is.
        bool claimed;
        /// The bonus itself, in `bonusToken` units.
        uint256 amount;
    }

    /// @custom:storage-location erc7201:real.lp.storage.BonusEscrow
    struct BonusEscrowStorage {
        /// The only account allowed to {reserve}. Zero closes the reserve path.
        address adapter;
        /// Sum of every unclaimed reservation. The floor under the balance.
        uint256 totalReserved;
        /// Purchase id => the bonus owed for it.
        mapping(bytes32 => Reservation) reservations;
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

    event AdapterSet(address previousAdapter, address newAdapter);
    event BonusReserved(bytes32 indexed purchaseId, address indexed beneficiary, uint256 amount, uint64 unlockAt);
    event BonusClaimed(bytes32 indexed purchaseId, address indexed beneficiary, uint256 amount);
    event SurplusRecovered(address to, uint256 amount);

    // ──────────────────────── Constructor ──────────────────────

    /// @notice Deploys the IMPLEMENTATION. It holds no state of its own and is never called
    ///         directly; the proxy in front of it runs {initialize}.
    /// @param bonusToken_ Token every campaign bonus is paid in.
    /// @dev `_disableInitializers()` is what stops anyone from initialising the bare
    ///      implementation and owning a contract that, being un-proxied, custodies nothing —
    ///      but would still be a confusing entry in every explorer and indexer.
    constructor(IERC20 bonusToken_) {
        if (address(bonusToken_) == address(0)) revert ZeroAddress();

        bonusToken = bonusToken_;

        _disableInitializers();
    }

    // ──────────────────────── Initializer ──────────────────────

    /**
     * @notice One-time setup, executed on the PROXY in its own deployment transaction.
     * @param owner_   Owner: the `TimelockController` that owns the rest of the stack.
     * @param adapter_ The adapter allowed to {reserve}. `address(0)` leaves the reserve path
     *                 closed, which is legal and is what a harness or a staged campaign does.
     * @dev The adapter IS an argument, and it has to be. The escrow is born owned by the
     *      timelock (deploy note N-7: no key holds the owner tier, not even for one block), and
     *      {setAdapter} is owner-tier — so a deployer that did not pass the adapter here could
     *      never point the escrow at one without a scheduled timelock operation. The deploy
     *      script resolves the chicken-and-egg by PREDICTING the adapter's CREATE address from
     *      its own nonce, exactly as it predicts the zapper's for the vault, and then asserting
     *      the adapter really landed there.
     *
     *      `AdapterSet(address(0), adapter_)` is emitted either way, so the adapter history is
     *      complete from block one with no gap a reader has to assume was empty.
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

    /// @notice Sum of every reservation not yet claimed. Untouchable by {recoverSurplus}.
    function totalReserved() external view returns (uint256) {
        return _escrowStorage().totalReserved;
    }

    /// @notice The bonus recorded for `purchaseId`. A zero `beneficiary` means "no such id".
    function reservationOf(bytes32 purchaseId)
        external
        view
        returns (address beneficiary, uint256 amount, uint64 unlockAt, bool claimed)
    {
        Reservation storage r = _escrowStorage().reservations[purchaseId];
        return (r.beneficiary, r.amount, r.unlockAt, r.claimed);
    }

    /// @notice What {claim} would pay right now: the amount once the cliff has passed and the
    ///         reservation is unspent, and zero in every other case — unknown id, already
    ///         claimed, or still locked.
    /// @dev Deliberately total rather than reverting: a keeper sweeping a campaign asks this
    ///      about ids it does not know are ripe, and a revert would make that a try/catch.
    function claimable(bytes32 purchaseId) external view returns (uint256) {
        Reservation storage r = _escrowStorage().reservations[purchaseId];
        if (r.beneficiary == address(0) || r.claimed || block.timestamp < r.unlockAt) return 0;
        return r.amount;
    }

    // ──────────────────────── Adapter function ─────────────────

    /**
     * @notice Records a guaranteed bonus against the balance this contract already holds.
     * @param purchaseId  Id of the ApeBond purchase this bonus belongs to. Spent once.
     * @param beneficiary Sole payout address for it.
     * @param amount      Bonus size, in `bonusToken` units.
     * @param unlockAt    Timestamp from which it may be claimed.
     * @dev Adapter tier, and nothing else: the owner cannot reserve either. The funding check
     *      is the whole design — an underfunded reserve REVERTS, and because the adapter calls
     *      this inside the SoulZap purchase, that revert aborts the purchase itself. The buyer
     *      is never sold a bond whose promised bonus does not exist yet.
     *
     *      `available` is computed with a floor rather than a bare subtraction so that a
     *      balance that has somehow fallen below `totalReserved` reports `Underfunded(0, ...)`
     *      instead of a panic. A well-behaved ERC-20 cannot reach that state — this contract
     *      only ever sends what it has just un-reserved, or the surplus — but the reserve path
     *      is the one an integrator calls, and it should fail with a reason.
     */
    function reserve(bytes32 purchaseId, address beneficiary, uint256 amount, uint64 unlockAt) external nonReentrant {
        BonusEscrowStorage storage $ = _escrowStorage();

        address adapter_ = $.adapter;
        if (msg.sender != adapter_) revert NotAdapter(msg.sender, adapter_);
        if (beneficiary == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        Reservation storage r = $.reservations[purchaseId];
        if (r.beneficiary != address(0)) revert DuplicateReservation(purchaseId);

        uint256 balance = bonusToken.balanceOf(address(this));
        uint256 reserved = $.totalReserved;
        uint256 available = balance > reserved ? balance - reserved : 0;
        if (available < amount) revert Underfunded(available, amount);

        r.beneficiary = beneficiary;
        r.unlockAt = unlockAt;
        r.amount = amount;
        $.totalReserved = reserved + amount;

        emit BonusReserved(purchaseId, beneficiary, amount, unlockAt);
    }

    // ──────────────────────── User function ────────────────────

    /**
     * @notice Pays the bonus recorded for `purchaseId` to its recorded beneficiary.
     * @param purchaseId The reservation to spend.
     * @return amount The bonus paid.
     * @dev Callable by anyone, payable only to the beneficiary in storage — the caller can pay
     *      someone else's gas, never redirect their money. There is no pause and no role in
     *      front of this: a reservation is already funded and already owed, so nothing this
     *      contract knows about is a reason to withhold it.
     *
     *      Ordering: `claimed` is set and `totalReserved` is decremented BEFORE the transfer,
     *      so a callback token that re-enters mid-payout finds a reservation that is already
     *      spent — and the `nonReentrant` guard stops it before it can even look.
     */
    function claim(bytes32 purchaseId) external nonReentrant returns (uint256 amount) {
        BonusEscrowStorage storage $ = _escrowStorage();
        Reservation storage r = $.reservations[purchaseId];

        address beneficiary = r.beneficiary;
        if (beneficiary == address(0)) revert UnknownReservation(purchaseId);
        if (r.claimed) revert AlreadyClaimed(purchaseId);
        if (block.timestamp < r.unlockAt) revert CliffNotReached(r.unlockAt, block.timestamp);

        amount = r.amount;
        r.claimed = true;
        $.totalReserved -= amount;

        bonusToken.safeTransfer(beneficiary, amount);

        emit BonusClaimed(purchaseId, beneficiary, amount);
    }

    // ──────────────────────── Owner functions ──────────────────

    /// @notice Point the escrow at the adapter allowed to reserve, or at nothing.
    /// @param newAdapter The new adapter. `address(0)` closes the reserve path.
    /// @dev The documented re-pointing lever: the adapter is deliberately NOT upgradeable, so
    ///      replacing it means deploying a new one and calling this. Zero is allowed on purpose
    ///      — it is how a campaign is wound down without touching a single reservation.
    ///      Two-sided event, like every role change in this stack.
    function setAdapter(address newAdapter) external onlyOwner {
        BonusEscrowStorage storage $ = _escrowStorage();
        emit AdapterSet($.adapter, newAdapter);
        $.adapter = newAdapter;
    }

    /**
     * @notice Move the UNRESERVED balance out — leftover campaign funding, an over-transfer, or
     *         a wind-down.
     * @param to Destination for the surplus.
     * @dev The amount is not an argument and cannot be: it is recomputed here as
     *      `balanceOf(this) - totalReserved`, which is exactly the money nobody is owed. There
     *      is no argument an owner could pass, and no order the owner could give the timelock,
     *      that reaches a reservation. Reverts with {NoSurplus} rather than emitting a zero
     *      transfer, so a mistimed recovery is visible instead of silent.
     *
     *      No `nonReentrant`: the transfer is the last thing this function does, the amount is
     *      derived from the live balance rather than carried across the call, and a callback
     *      that re-entered {claim} would only pay a beneficiary out of money that was never the
     *      surplus. Guarding it would instead let a hostile token brick the owner's recovery.
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

    /// @notice UUPS upgrade hook. The owner is the timelock, so every code change is scheduled
    ///         on-chain with full calldata and cannot execute before the delay.
    /// @dev Empty body on purpose: `onlyOwner` is the whole authorization.
    function _authorizeUpgrade(address) internal override onlyOwner {}

    /// @notice Disabled. Renouncing would leave `_authorizeUpgrade` with no caller, freezing
    ///         the implementation forever — the exact failure the proxy exists to avoid.
    /// @dev Kept `onlyOwner` so a stranger still gets the standard Ownable rejection and the
    ///      owner gets a reason. Not marked `view` for the same reason as in
    ///      {RewardsDistributor}: it must keep the ABI `stateMutability` of the call it
    ///      overrides, so that anyone who tries it gets the revert reason on-chain.
    function renounceOwnership() public override onlyOwner {
        revert RenounceDisabled();
    }
}
