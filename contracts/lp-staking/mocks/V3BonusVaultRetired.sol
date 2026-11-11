// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.38;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";

import "../interfaces/IBonusEscrowHooks.sol";

/**
 * @title V3BonusVaultRetired
 * @notice TEST STACK ONLY. NEVER DEPLOY THIS ON MAINNET.
 *
 *  WHAT IT IS FOR. `LPStakingVault.setBonusListener` refuses to replace a bonus listener whose
 *  `totalLpReserved()` is not zero (`ListenerHasReservations`). On Sepolia test stack #6 the LP
 *  vault's listener is the FIRST staking v3 bonus vault (proxy
 *  0x72035F4BD96AcF498030E9A39eDc3546F3815221), which is retired, and it still holds one LP
 *  reservation whose owner can no longer act: the position stays staked, so the vault never
 *  sends the `onUnstake` that would forfeit or settle it, `V3BonusVault.reconcileLp` does not
 *  forfeit a record still held by its user, and `V3BonusVault.setVault` is refused while LP
 *  reservations are outstanding. No call of `V3BonusVault` can bring `totalLpReserved()` to zero,
 *  so the LP vault could never move to the second v3 set's bonus vault.
 *
 *  THE ONE OPERATION THAT USES IT. The owner (the stack's `LPTimelock`) upgrades the retired
 *  bonus vault proxy to this implementation with `upgradeToAndCall(thisImplementation, "")`.
 *  From then on the proxy reports `totalLpReserved() == 0`, and the LP vault's
 *  `setBonusListener(newBonusVault)` passes.
 *
 *  WHAT IT DOES. `totalLpReserved()` returns 0. `onUnstake` and `onRebalance` accept every call
 *  and do nothing: between the upgrade and the listener switch the LP vault still notifies this
 *  address, and its `onRebalance` call fails CLOSED (a revert here would revert the rebalance).
 *  Ownership is the same `Ownable2StepUpgradeable` base as `V3BonusVault`, so `owner()` keeps
 *  returning the timelock from the same ERC-7201 slot with no initializer call, and only the
 *  owner can upgrade the proxy again.
 *
 *  WHAT IT DROPS, ON PURPOSE. Nothing else exists: no claim, no funding, no surplus recovery, no
 *  reads of the old reservations, no storage of its own. The `V3BonusVault` storage stays in its
 *  namespaced slot untouched (its struct is declared below for the upgrades plugin only, never
 *  read), but every reservation of the retired vault, v3 and LP alike,
 *  becomes unreachable, and any token balance stays in the proxy until a later upgrade.
 */
contract V3BonusVaultRetired is Initializable, UUPSUpgradeable, Ownable2StepUpgradeable, IBonusEscrowHooks {
    // ── The retired layout, declared and never read ─────────────
    //
    // A verbatim copy of `V3BonusVault`'s namespaced storage struct. Nothing here reads or writes
    // it and it adds no storage: it exists only so the OpenZeppelin upgrades plugin
    // (`prepareUpgrade` in `scripts/deploy-implementation.js`) sees the same ERC-7201 namespace
    // and does not refuse the upgrade as a "Deleted namespace".

    struct UserReservation {
        uint256 amount;
        uint64 unlockAt;
    }

    struct LpReservation {
        address user;
        uint64 unlockAt;
        bool claimed;
        bool forfeited;
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
        uint256 maxTotalReserved;
        uint256 totalLpReserved;
        mapping(uint256 => bool) lpSettled;
    }

    error RenounceDisabled();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Always 0: the retired vault holds the LP vault's listener link no longer.
    function totalLpReserved() external pure returns (uint256) {
        return 0;
    }

    /// @inheritdoc IBonusEscrowHooks
    function onUnstake(uint256) external pure {}

    /// @inheritdoc IBonusEscrowHooks
    function onRebalance(uint256, uint256, Snapshot calldata, Snapshot calldata) external pure {}

    function _authorizeUpgrade(address) internal override onlyOwner {}

    /// @dev As in `V3BonusVault`: an ownerless proxy could never be upgraded again.
    function renounceOwnership() public override onlyOwner {
        revert RenounceDisabled();
    }
}
