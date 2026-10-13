// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import "../interfaces/IBonusEscrowHooks.sol";

/// @dev The one vault view this mock reads at hook time.
interface IVaultStakerOfForLightEscrowMock {
    function stakerOf(uint256 tokenId) external view returns (address);
}

/**
 * @title MockLightBonusEscrow
 * @notice Test-only escrow that records each notification as an EVENT instead of in storage.
 *
 *  Why it exists beside {MockBonusEscrow}: that mock records an `onUnstake` in five storage
 *  slots, and five zero-to-non-zero writes cost about 90,000 gas — nearly the whole of the
 *  vault's 100,000 `BONUS_HOOK_GAS`. In the optimized build it fits with a few hundred gas to
 *  spare; in the unoptimized `forge coverage` build it does not, the hook runs out of gas, and
 *  the vault (correctly) emits `BonusHookFailed`. A test of "the vault calls the hook" must not
 *  depend on the mock's own bookkeeping fitting the allowance, so this mock's bookkeeping is
 *  one event — a few thousand gas — and the test reads the logs.
 *
 *  It also measures, rather than fails, when the vault starves it: `gasAtEntry` is what the
 *  hook actually received, so a test can assert it was the whole allowance.
 *
 *  `rejectRebalance` makes `onRebalance` revert, for the fail-closed tests.
 */
contract MockLightBonusEscrow is IBonusEscrowHooks {
    /// @notice One `onUnstake`, with what the escrow observed at its first instruction.
    event UnstakeSeen(uint256 indexed tokenId, uint256 gasAtEntry, address stakerAtHook, address nftOwnerAtHook);

    /// @notice One `onRebalance`, with the two snapshots as received.
    event RebalanceSeen(uint256 indexed oldTokenId, uint256 indexed newTokenId, Snapshot old_, Snapshot new_);

    error NotVault(address caller);
    error EscrowRejects();

    address public immutable vault;
    address public immutable positionManager;
    bool public immutable rejectRebalance;

    constructor(address vault_, address positionManager_, bool rejectRebalance_) {
        vault = vault_;
        positionManager = positionManager_;
        rejectRebalance = rejectRebalance_;
    }

    function onUnstake(uint256 tokenId) external {
        uint256 gasAtEntry = gasleft();
        if (msg.sender != vault) revert NotVault(msg.sender);
        emit UnstakeSeen(
            tokenId,
            gasAtEntry,
            IVaultStakerOfForLightEscrowMock(vault).stakerOf(tokenId),
            IERC721(positionManager).ownerOf(tokenId)
        );
    }

    function onRebalance(uint256 oldTokenId, uint256 newTokenId, Snapshot calldata old_, Snapshot calldata new_)
        external
    {
        if (msg.sender != vault) revert NotVault(msg.sender);
        if (rejectRebalance) revert EscrowRejects();
        emit RebalanceSeen(oldTokenId, newTokenId, old_, new_);
    }
}
