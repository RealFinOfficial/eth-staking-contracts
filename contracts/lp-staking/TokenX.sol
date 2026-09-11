// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/**
 * @title TokenX
 * @notice LP staking reward token. 18 decimals, EIP-2612 permit, burnable.
 *
 *  Minting:
 *    - Exactly one address — `minter` — may call `mint`. The owner (a multisig)
 *      sets it with `setMinter`. On mainnet that multisig is the LP operator, not
 *      the timelock proposer. That is the escape hatch: if the rewards
 *      distributor is found to be buggy, the owner deploys a fixed distributor
 *      and re-points `minter` at it. Setting `minter` to address(0) disables
 *      minting entirely. Ownership is two-step: a mistyped `transferOwnership`
 *      is recoverable until the new owner calls `acceptOwnership`, and it can
 *      never be renounced.
 *    - The token enforces its own per-epoch mint cap, independent of whatever
 *      the distributor believes. `setEpochCap(epochId, cap)` selects the current
 *      epoch and its cap in one call; `mint` accumulates into
 *      `mintedInEpoch[currentEpochId]` and reverts once the cap is reached.
 *      This is defense in depth — a compromised or broken distributor can never
 *      mint more than the cap the owner armed for the running epoch.
 *    - Tallies are keyed by epoch id and persist. Re-selecting an old epoch id
 *      keeps that epoch's earlier tally, so it cannot be reset by rotation.
 *    - Lowering a cap below the amount already minted in that epoch is allowed;
 *      it simply blocks all further minting in the epoch.
 *    - The initial state is `currentEpochId = 0` with a zero cap, so no mint can
 *      succeed until the owner arms an epoch.
 *    - `mint` rejects a zero amount outright, so the token never emits a
 *      zero-value Transfer of its own making.
 *
 *  Scheduled epoch rollover (lazy, no keeper):
 *    - `armNextEpoch(epochId, cap, activatesAt)` parks ONE pending epoch. The
 *      first `mint` at or after `activatesAt` rolls it in — it becomes the
 *      running epoch, its cap is armed, and the pending slot is cleared — all
 *      before that mint's own cap check. No keeper bot and no timed multisig
 *      transaction are needed: the rollover rides on the next mint.
 *    - Exactly one pending epoch exists at a time. A second `armNextEpoch`
 *      overwrites the first; `cancelNextEpoch` drops it.
 *    - The rollover is lazy, so `currentEpochId` can read stale between the
 *      boundary and the next mint. `effectiveEpoch()` is the honest answer:
 *      it is what a mint right now would account against.
 *    - `setEpochCap` is unchanged and stays the immediate lever (a switch now,
 *      or a mid-epoch cap raise). It deliberately does NOT touch the pending
 *      slot — see its own note.
 *
 *  The cap is an issuance throttle, not a payout rule. Claims are cumulative and
 *  charge whatever they mint against the epoch that is effective at claim time,
 *  so a backlog claimed late draws from that epoch's headroom. Rolling an epoch
 *  over changes which bucket is charged; it never changes what a user is owed.
 *
 *  Name and symbol are constructor parameters — the final branding is decided
 *  by the team at deployment time.
 */
contract TokenX is ERC20, ERC20Burnable, ERC20Permit, Ownable2Step {
    // ──────────────────────── Errors ───────────────────────────

    /// @dev `mint` was called by an address that is not the current `minter`.
    error NotMinter(address caller);

    /// @dev The mint would push the running epoch past its armed cap.
    error EpochMintCapExceeded(uint256 epochId, uint256 cap, uint256 alreadyMinted, uint256 requested);

    /// @dev A zero amount was passed where a positive one is required.
    error ZeroAmount();

    /// @dev `armNextEpoch` was given an activation time that is not strictly in the future.
    error ActivationNotInFuture(uint64 activatesAt, uint256 blockTimestamp);

    /// @dev `cancelNextEpoch` was called with no epoch armed.
    error NoPendingEpoch();

    /// @dev `renounceOwnership` is disabled: the token is permanent and not upgradeable, and
    ///      `setMinter` / the epoch caps are its only controls. An ownerless token could never
    ///      arm another epoch, so minting would die with the running cap.
    error RenounceDisabled();

    // ──────────────────────── Types ────────────────────────────

    /// @notice The single scheduled epoch waiting to be rolled in by the next mint.
    /// @dev `activatesAt == 0` is the "nothing armed" sentinel. `armNextEpoch`
    ///      requires a strictly future timestamp, so a live arming can never carry 0.
    struct PendingEpoch {
        uint256 epochId;
        uint256 cap;
        uint64 activatesAt;
    }

    // ──────────────────────── State ────────────────────────────

    /// @notice The only address allowed to call `mint`. address(0) disables minting.
    address public minter;

    /// @notice Epoch id that `mint` currently accounts against. Set by `setEpochCap`.
    uint256 public currentEpochId;

    /// @notice Maximum amount mintable in an epoch, keyed by epoch id.
    mapping(uint256 => uint256) public epochCap;

    /// @notice Amount already minted in an epoch, keyed by epoch id. Never reset.
    mapping(uint256 => uint256) public mintedInEpoch;

    /// @notice The one scheduled epoch, if any. `activatesAt == 0` means none is armed.
    PendingEpoch public pendingEpoch;

    // ──────────────────────── Events ───────────────────────────

    event MinterChanged(address previousMinter, address newMinter);
    event EpochCapSet(uint256 epochId, uint256 cap);

    /// @dev A scheduled epoch was parked. Overwrites any earlier arming.
    event NextEpochArmed(uint256 epochId, uint256 cap, uint64 activatesAt);

    /// @dev The scheduled epoch was dropped before it ever activated. Carries what was discarded.
    event NextEpochCancelled(uint256 epochId, uint256 cap, uint64 activatesAt);

    /// @dev The scheduled epoch became the running epoch, inside the first mint past
    ///      its boundary. Carries both the time it was due (`scheduledFor`) and the time
    ///      it actually landed (`activatedAt`); the gap between them is the lazy lag.
    ///      For indexers this is also an epoch-cap event: it sets `epochCap[epochId] = cap`
    ///      and `currentEpochId = epochId` exactly as {EpochCapSet} would.
    event EpochActivated(uint256 epochId, uint256 cap, uint64 scheduledFor, uint256 activatedAt);

    // ──────────────────────── Constructor ──────────────────────

    /// @param _name         ERC-20 name; also the EIP-712 domain name used by `permit`.
    /// @param _symbol       ERC-20 symbol.
    /// @param _initialOwner Owner (multisig). Controls the minter, the epoch caps and
    ///                      the scheduled rollover.
    /// @dev `Ownable2Step` has no constructor of its own, so the owner is still installed by
    ///      `Ownable(_initialOwner)`; the two-step handshake only governs later transfers.
    constructor(string memory _name, string memory _symbol, address _initialOwner)
        ERC20(_name, _symbol)
        ERC20Permit(_name)
        Ownable(_initialOwner)
    {
        // Initial state, logged so an indexer never has to assume it: no minter, epoch 0
        // selected with a zero cap (so no mint can succeed until the owner arms an epoch).
        emit MinterChanged(address(0), address(0));
        emit EpochCapSet(0, 0);
    }

    // ──────────────────────── Modifiers ────────────────────────

    modifier onlyMinter() {
        if (msg.sender != minter) revert NotMinter(msg.sender);
        _;
    }

    // ──────────────────────── Minting ──────────────────────────

    /// @notice Mint new tokens. Callable only by `minter`, and only while the
    ///         running epoch has cap headroom left.
    /// @param to     Recipient of the newly minted tokens.
    /// @param amount Amount to mint, in wei (18 decimals).
    /// @dev A zero amount reverts instead of minting nothing. The claim path can never
    ///      produce one — it pays a strictly positive difference — so this only tightens
    ///      direct minter calls, and it kills the zero-value `Transfer` edge case for the
    ///      indexer at the source rather than filtering it downstream.
    /// @dev A scheduled epoch that has come due is rolled in first, so the cap checked
    ///      below is the new epoch's. See {armNextEpoch}.
    function mint(address to, uint256 amount) external onlyMinter {
        if (amount == 0) revert ZeroAmount();

        _rollPendingEpoch();

        uint256 epochId = currentEpochId;
        uint256 cap = epochCap[epochId];
        uint256 minted = mintedInEpoch[epochId];

        // Subtraction, not `minted + amount > cap`: the cap can be lowered below
        // the tally, and this keeps the typed error instead of an overflow panic.
        uint256 remaining = cap > minted ? cap - minted : 0;
        if (amount > remaining) {
            revert EpochMintCapExceeded(epochId, cap, minted, amount);
        }

        mintedInEpoch[epochId] = minted + amount;
        _mint(to, amount);
    }

    // ──────────────────────── Views ────────────────────────────

    /// @notice The epoch a mint would account against right now, with its cap.
    ///         Returns the pending epoch once it is due, otherwise the running one.
    /// @return epochId Epoch id that `mint` would charge at this block timestamp.
    /// @return cap     Cap that would be enforced for it.
    /// @dev The cap is returned alongside the id because reading `epochCap(epochId)`
    ///      separately is wrong while a rollover is pending-and-due: the pending cap is
    ///      not written to storage until the rollover actually happens, so the mapping
    ///      still holds that id's stale value (0 for an unused id). The tally is safe to
    ///      read directly — `mintedInEpoch(epochId)` is never touched by a rollover.
    function effectiveEpoch() public view returns (uint256 epochId, uint256 cap) {
        PendingEpoch memory p = pendingEpoch;
        if (p.activatesAt != 0 && block.timestamp >= p.activatesAt) {
            return (p.epochId, p.cap);
        }
        epochId = currentEpochId;
        return (epochId, epochCap[epochId]);
    }

    // ──────────────────────── Internal ─────────────────────────

    /// @dev Roll a due scheduled epoch in, then clear the slot. No-op when nothing is
    ///      armed or the boundary has not been reached. Arming the cap is written exactly
    ///      as {setEpochCap} writes it — an unconditional overwrite of `epochCap[epochId]`
    ///      — and `mintedInEpoch` is left alone, so scheduling an epoch id that already
    ///      carries a tally keeps that tally, same as re-selecting one by hand.
    function _rollPendingEpoch() internal {
        uint64 activatesAt = pendingEpoch.activatesAt;
        if (activatesAt == 0 || block.timestamp < activatesAt) return;

        uint256 epochId = pendingEpoch.epochId;
        uint256 cap = pendingEpoch.cap;

        delete pendingEpoch;

        currentEpochId = epochId;
        epochCap[epochId] = cap;

        emit EpochActivated(epochId, cap, activatesAt, block.timestamp);
    }

    // ──────────────────────── Owner functions ──────────────────

    /// @notice Point minting rights at a new address. address(0) disables minting.
    /// @param _minter The new minter, typically the rewards distributor.
    function setMinter(address _minter) external onlyOwner {
        emit MinterChanged(minter, _minter);
        minter = _minter;
    }

    /// @notice Select the running epoch and arm its mint cap in one call. Takes effect
    ///         immediately — this is the lever for an unscheduled switch or a mid-epoch
    ///         cap change. Re-selecting an earlier epoch id keeps that epoch's existing tally.
    /// @param epochId Epoch id that subsequent mints account against.
    /// @param cap     Maximum total amount mintable in that epoch, in wei.
    /// @dev Deliberately does NOT clear a pending scheduled epoch. An immediate switch made
    ///      while one is armed is therefore temporary: the scheduled epoch still rolls in at
    ///      its own boundary and supersedes this one. Call {cancelNextEpoch} first when the
    ///      immediate switch is meant to be the last word.
    function setEpochCap(uint256 epochId, uint256 cap) external onlyOwner {
        currentEpochId = epochId;
        epochCap[epochId] = cap;
        emit EpochCapSet(epochId, cap);
    }

    /// @notice Park the next epoch so it activates on its own, without a keeper and
    ///         without a transaction timed by hand. The first `mint` at or after
    ///         `activatesAt` rolls it in before checking its own cap.
    /// @param epochId     Epoch id to switch to when the boundary is crossed.
    /// @param cap         Cap to arm for it, in wei. Zero is allowed and schedules a freeze.
    /// @param activatesAt Unix timestamp from which the rollover is due. Must be strictly
    ///                    in the future.
    /// @dev Only one epoch can be pending: a second call overwrites the first outright,
    ///      which is also how a scheduled activation is rescheduled.
    /// @dev `activatesAt` must be strictly greater than `block.timestamp`. A past or
    ///      current timestamp is rejected rather than accepted as "due immediately",
    ///      because that is {setEpochCap}'s job and it does it atomically and visibly,
    ///      whereas an already-due arming would switch epochs at some unpredictable later
    ///      mint and log an activation whose scheduled time had already passed. The strict
    ///      check also protects the multisig flow, where a transaction can sit unexecuted
    ///      for hours: a stale `activatesAt` reverts loudly instead of silently arming a
    ///      switch that fires on the very next mint. It keeps `activatesAt == 0` usable as
    ///      the unambiguous "nothing armed" sentinel as well.
    /// @dev The rollover overwrites `epochCap[epochId]` and leaves `mintedInEpoch[epochId]`
    ///      untouched, so scheduling an epoch id that already has a tally resumes that
    ///      tally instead of resetting it.
    function armNextEpoch(uint256 epochId, uint256 cap, uint64 activatesAt) external onlyOwner {
        if (activatesAt <= block.timestamp) revert ActivationNotInFuture(activatesAt, block.timestamp);

        pendingEpoch = PendingEpoch({epochId: epochId, cap: cap, activatesAt: activatesAt});
        emit NextEpochArmed(epochId, cap, activatesAt);
    }

    /// @notice Drop the scheduled epoch, so no rollover happens. The running epoch and its
    ///         cap are left exactly as they are.
    /// @dev Reverts when nothing is armed. A cancel that had already been overtaken by the
    ///      activation would otherwise succeed silently and log a cancellation that never
    ///      happened; the revert reports the real state to the owner instead.
    function cancelNextEpoch() external onlyOwner {
        PendingEpoch memory p = pendingEpoch;
        if (p.activatesAt == 0) revert NoPendingEpoch();

        delete pendingEpoch;
        emit NextEpochCancelled(p.epochId, p.cap, p.activatesAt);
    }

    /// @notice Disabled. See {RenounceDisabled}.
    /// @dev Kept `onlyOwner` and deliberately NOT `view` (solc suggests it): the ABI entry must
    ///      keep looking like the transaction it overrides so a caller gets the revert on-chain.
    function renounceOwnership() public override onlyOwner {
        revert RenounceDisabled();
    }
}
