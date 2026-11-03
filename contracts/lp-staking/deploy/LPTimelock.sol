// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.38;

import "@openzeppelin/contracts/governance/TimelockController.sol";

/**
 * @title LPTimelock
 * @notice The `TimelockController` that owns the LP staking proxies (`LPStakingVault`,
 *         `RewardsDistributor`, `LPEpochRegistry`, `TokenOverture`, `LPZapper`, and the
 *         `BonusEscrow` proxy and the `ApeBondPositionAdapter` of the ApeBond route). It is
 *         OpenZeppelin's `TimelockController` with ONE addition: a canceller role with a term
 *         written on chain, so ApeBonds' Safe can veto owner-tier operations for a bounded time.
 *         Everything else (the proposer and executor roles, `schedule`, `execute`, `updateDelay`,
 *         the role admins) is untouched OpenZeppelin code.
 *
 *  Why a wrapper exists at all: the indexer only vendors artifacts whose `sourceName` starts with
 *  `contracts/lp-staking/`, and the repo wants one name for the deployed timelock across the
 *  deploy script, the suites and the explorer.
 *
 *  Deployment parameters (see `docs/specs/01-contracts.md` §2.5): `minDelay` is environment
 *  driven (48 hours on mainnet, short on a test stack so the flow can be rehearsed). `proposers`
 *  and `executors` are both `[multisig]`, REAL's Safe. Execution is deliberately NOT open.
 *  `admin` must be `address(0)`, and the constructor enforces it, so the timelock is the only
 *  holder of `DEFAULT_ADMIN_ROLE` from block one. Every role change, including every step of a
 *  canceller appointment, is therefore a scheduled and publicly visible operation.
 *
 *  THE CANCELLER ROLE. OpenZeppelin's constructor grants `CANCELLER_ROLE` to every proposer, so
 *  REAL's Safe holds it from the deploy, with no term (its `cancellerTermEnd` is 0). It can cancel
 *  any pending operation, and only the timelock can take that role away, through a 48 hour
 *  operation. Any other address reaches `CANCELLER_ROLE` in exactly one way, two steps:
 *
 *    1. The offer. REAL's Safe schedules a call of the timelock on itself,
 *       `offerCancellerRole(account, termDays)`, and executes it after the delay. The function
 *       requires `DEFAULT_ADMIN_ROLE`, which only the timelock holds, so this is the only way to
 *       reach it. The offer stores `termDays` and an expiry seven days after the execution
 *       (`CANCELLER_OFFER_WINDOW`). No role is granted by the offer.
 *    2. The acceptance. The offered address calls `acceptCancellerRole(termDays)` before the
 *       expiry, naming the offered term. The role is granted and the term end is written as the
 *       acceptance time plus `termDays` days. The term starts at the acceptance, never at the offer.
 *
 *  `grantRole(CANCELLER_ROLE, x)` reverts for every caller, the timelock's own scheduled calls
 *  included, so the offer and the acceptance are the only road to the role.
 *
 *  THE CANCEL RULE. A canceller with a term may cancel exactly the operations scheduled BEFORE its
 *  term end. `scheduledAt[id]` records the block time of the latest schedule of every operation id
 *  (set in `schedule` and `scheduleBatch`, the only two entry points to OpenZeppelin's private
 *  `_schedule`). So after the term the canceller can still cancel what was proposed during the
 *  term, and every such operation keeps its full veto window. It can never cancel an operation
 *  scheduled at or after its term end. That includes the operation that revokes it: a revocation
 *  scheduled after the term end cannot be blocked, which is why a hacked canceller can always be
 *  removed once its term is over.
 *
 *  THE TERM PROTECTS THE HOLDER FROM OTHERS, NOT FROM ITSELF. During the term a revocation reverts
 *  at execution (`CancellerTermActive`). `renounceRole` passes at any time, so a canceller that
 *  suspects a key leak can leave at once. A revocation and a renouncement both clear the term end
 *  and delete any unaccepted offer of that address, so no stale offer can be accepted later.
 *
 *  A RENEWAL is a new offer to a current canceller and a new acceptance. The acceptance RESETS the
 *  term end to the acceptance time plus the new term, also when the new end is earlier than the
 *  old one.
 *
 *  Invariants: `cancellerTermEnd[a] != 0` implies `hasRole(CANCELLER_ROLE, a)` (the term end is
 *  written only in `acceptCancellerRole`, next to the grant, and cleared only in `_revokeRole`).
 *  `cancel` stays the only consumer of `CANCELLER_ROLE`. This contract is not behind a proxy, so
 *  its storage layout carries no upgrade concern.
 */
contract LPTimelock is TimelockController {
    /// @notice The longest term an offer may carry, in days. Decided 2026-10-30.
    uint32 public constant MAX_CANCELLER_TERM_DAYS = 180;

    /// @notice How long an executed offer can be accepted: from its execution until 7 days later.
    uint64 public constant CANCELLER_OFFER_WINDOW = 7 days;

    /// @notice One unaccepted offer of the canceller role.
    /// @param termDays  The term, in whole days, the acceptance must name.
    /// @param expiresAt The first second at which the offer can no longer be accepted.
    ///                  0 means there is no offer.
    struct CancellerOffer {
        uint32 termDays;
        uint64 expiresAt;
    }

    /// @notice The unaccepted offer of each address. `expiresAt == 0` means none.
    mapping(address => CancellerOffer) public cancellerOffer;

    /// @notice The term end of each canceller, as a timestamp. 0 means a permanent canceller with
    ///         no term (REAL's Safe), or an address that holds no canceller role.
    mapping(address => uint64) public cancellerTermEnd;

    /// @notice The block time of the latest schedule of each operation id. Overwritten when an
    ///         id is scheduled again after a cancel. 0 for an id never scheduled.
    mapping(bytes32 => uint64) public scheduledAt;

    /// @notice An offer was stored for `account` (the execution of `offerCancellerRole`).
    event CancellerOffered(address indexed account, uint32 termDays, uint64 expiresAt);

    /// @notice The unaccepted offer of `account` was withdrawn by the timelock.
    event CancellerOfferWithdrawn(address indexed account);

    /// @notice `account` accepted its offer and holds the canceller role until `termEnd`.
    event CancellerAccepted(address indexed account, uint64 termEnd);

    /// @dev The constructor was given a non-zero bootstrap admin. The timelock must be the only
    ///      holder of `DEFAULT_ADMIN_ROLE`.
    error BootstrapAdminNotAllowed(address admin);

    /// @dev An offer named the zero address, the timelock itself, or a permanent canceller.
    error InvalidCancellerAccount(address account);

    /// @dev An offer named a term of 0 days or of more than `MAX_CANCELLER_TERM_DAYS`.
    error CancellerTermOutOfBounds(uint32 termDays);

    /// @dev `account` has no unaccepted offer.
    error NoCancellerOffer(address account);

    /// @dev The offer of `account` expired at `expiresAt`.
    error CancellerOfferExpired(address account, uint64 expiresAt);

    /// @dev The acceptance named a term other than the one offered.
    error CancellerTermMismatch(uint32 offered, uint32 accepted);

    /// @dev A revocation of `account` was executed before its term end `termEnd`.
    error CancellerTermActive(address account, uint64 termEnd);

    /// @dev `account`, whose term ended at `termEnd`, tried to cancel operation `id`, which was
    ///      scheduled at or after that term end.
    error CancellerTermEnded(address account, uint64 termEnd, bytes32 id);

    /// @dev `grantRole(CANCELLER_ROLE, ...)` was called. The role is reached only by an offer and
    ///      its acceptance.
    error CancellerGrantOnlyByAcceptance();

    /// @param minDelay   Minimum seconds between `schedule` and the earliest `execute`.
    /// @param proposers  Addresses granted `PROPOSER_ROLE`, and `CANCELLER_ROLE` with no term
    ///                   (OpenZeppelin grants both).
    /// @param executors  Addresses granted `EXECUTOR_ROLE`. `address(0)` (open execution) is not
    ///                   used here.
    /// @param admin      Must be `address(0)`, which leaves the timelock self-administered from
    ///                   block one. Any other value reverts `BootstrapAdminNotAllowed`. The
    ///                   parameter is kept so the constructor signature, and with it the explorer
    ///                   verification arguments, stay those of OpenZeppelin.
    constructor(uint256 minDelay, address[] memory proposers, address[] memory executors, address admin)
        TimelockController(minDelay, proposers, executors, admin)
    {
        if (admin != address(0)) revert BootstrapAdminNotAllowed(admin);
    }

    /// @notice Offers the canceller role to `account` for a term of `termDays` days. Reachable only
    ///         as a scheduled call of the timelock on itself. The offer can be accepted from this
    ///         execution until `CANCELLER_OFFER_WINDOW` later. A new offer to the same address
    ///         overwrites the previous one. An offer to a current term canceller is a renewal.
    /// @dev Reverts `InvalidCancellerAccount` for the zero address, the timelock itself and a
    ///      permanent canceller (one that holds the role with no term), and
    ///      `CancellerTermOutOfBounds` for a term outside [1, `MAX_CANCELLER_TERM_DAYS`].
    function offerCancellerRole(address account, uint32 termDays) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (account == address(0) || account == address(this)) revert InvalidCancellerAccount(account);
        if (hasRole(CANCELLER_ROLE, account) && cancellerTermEnd[account] == 0) revert InvalidCancellerAccount(account);
        if (termDays == 0 || termDays > MAX_CANCELLER_TERM_DAYS) revert CancellerTermOutOfBounds(termDays);
        uint64 expiresAt = uint64(block.timestamp) + CANCELLER_OFFER_WINDOW;
        cancellerOffer[account] = CancellerOffer(termDays, expiresAt);
        emit CancellerOffered(account, termDays, expiresAt);
    }

    /// @notice Deletes the unaccepted offer of `account`. Reachable only as a scheduled call of the
    ///         timelock on itself. Before the offer operation executes, cancelling that pending
    ///         operation is the instant way to stop it.
    /// @dev Reverts `NoCancellerOffer` when `account` has no offer.
    function withdrawCancellerOffer(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (cancellerOffer[account].expiresAt == 0) revert NoCancellerOffer(account);
        delete cancellerOffer[account];
        emit CancellerOfferWithdrawn(account);
    }

    /// @notice Accepts the offer made to the caller. `termDays` must equal the offered term. On
    ///         success the offer is deleted, the caller holds `CANCELLER_ROLE`, and its term end is
    ///         the acceptance time plus `termDays` days. On a renewal the role is already held, the
    ///         grant changes nothing, and the term end is reset to the new value.
    /// @dev Reverts `NoCancellerOffer`, `CancellerOfferExpired` at or after `expiresAt`, and
    ///      `CancellerTermMismatch`, in that order.
    function acceptCancellerRole(uint32 termDays) external {
        address account = _msgSender();
        CancellerOffer memory o = cancellerOffer[account];
        if (o.expiresAt == 0) revert NoCancellerOffer(account);
        if (block.timestamp >= o.expiresAt) revert CancellerOfferExpired(account, o.expiresAt);
        if (termDays != o.termDays) revert CancellerTermMismatch(o.termDays, termDays);
        delete cancellerOffer[account];
        // Renewal resets the term end: acceptance time plus the new term (decision 9).
        uint64 termEnd = uint64(block.timestamp) + uint64(termDays) * 1 days;
        cancellerTermEnd[account] = termEnd;
        // The internal grant bypasses the `grantRole` block below. It is a no-op on a renewal.
        _grantRole(CANCELLER_ROLE, account);
        emit CancellerAccepted(account, termEnd);
    }

    /// @notice OpenZeppelin's `cancel`, with the term rule in front of it. A canceller with a term
    ///         can cancel only an operation scheduled before its term end. A permanent canceller
    ///         (term end 0) can cancel any pending operation.
    /// @dev Reverts `CancellerTermEnded` when the caller has a term and `scheduledAt[id]` is at or
    ///      after it. A caller without the role has no term end and reaches OpenZeppelin's role
    ///      check, which reverts `AccessControlUnauthorizedAccount`.
    function cancel(bytes32 id) public override {
        address account = _msgSender();
        uint64 end = cancellerTermEnd[account];
        if (end != 0 && scheduledAt[id] >= end) revert CancellerTermEnded(account, end, id);
        super.cancel(id);
    }

    /// @notice OpenZeppelin's `schedule`, which also records the block time in `scheduledAt`.
    function schedule(
        address target,
        uint256 value,
        bytes calldata data,
        bytes32 predecessor,
        bytes32 salt,
        uint256 delay
    ) public override {
        super.schedule(target, value, data, predecessor, salt, delay);
        scheduledAt[hashOperation(target, value, data, predecessor, salt)] = uint64(block.timestamp);
    }

    /// @notice OpenZeppelin's `scheduleBatch`, which also records the block time in `scheduledAt`.
    function scheduleBatch(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata payloads,
        bytes32 predecessor,
        bytes32 salt,
        uint256 delay
    ) public override {
        super.scheduleBatch(targets, values, payloads, predecessor, salt, delay);
        scheduledAt[hashOperationBatch(targets, values, payloads, predecessor, salt)] = uint64(block.timestamp);
    }

    /// @notice OpenZeppelin's `grantRole`, except for `CANCELLER_ROLE`, which reverts
    ///         `CancellerGrantOnlyByAcceptance` for every caller. Every other role keeps the
    ///         OpenZeppelin rule (the role's admin, here the timelock).
    function grantRole(bytes32 role, address account) public override {
        if (role == CANCELLER_ROLE) revert CancellerGrantOnlyByAcceptance();
        super.grantRole(role, account);
    }

    /// @dev Single choke point for `revokeRole`, `renounceRole` and every scheduled self-call that
    ///      revokes. For `CANCELLER_ROLE` a revocation by anyone other than the holder reverts
    ///      `CancellerTermActive` before the term end. The term protects the holder from others,
    ///      never from itself, so `renounceRole` always passes. Both clear the term end and delete
    ///      any unaccepted offer of the address. `account != _msgSender()` is safe as the test:
    ///      `revokeRole` needs `DEFAULT_ADMIN_ROLE`, so its sender is the timelock, offers to the
    ///      timelock itself revert, and `renounceRole` forces `account == sender`.
    function _revokeRole(bytes32 role, address account) internal override returns (bool) {
        if (role == CANCELLER_ROLE) {
            uint64 end = cancellerTermEnd[account];
            if (block.timestamp < end && account != _msgSender()) revert CancellerTermActive(account, end);
            delete cancellerTermEnd[account];
            delete cancellerOffer[account];
        }
        return super._revokeRole(role, account);
    }

    /// @notice True when `account` holds `CANCELLER_ROLE` and is either permanent (term end 0) or
    ///         still inside its term. A canceller whose term is over still holds the role and can
    ///         still cancel the operations scheduled before its term end, see `canCancel`.
    function isCancellerActive(address account) external view returns (bool) {
        if (!hasRole(CANCELLER_ROLE, account)) return false;
        uint64 end = cancellerTermEnd[account];
        return end == 0 || block.timestamp < end;
    }

    /// @notice True when a `cancel(id)` sent by `account` now would pass: `account` holds
    ///         `CANCELLER_ROLE`, `id` is pending, and `account` is permanent or `id` was scheduled
    ///         before its term end.
    function canCancel(address account, bytes32 id) external view returns (bool) {
        if (!hasRole(CANCELLER_ROLE, account) || !isOperationPending(id)) return false;
        uint64 end = cancellerTermEnd[account];
        return end == 0 || scheduledAt[id] < end;
    }
}
