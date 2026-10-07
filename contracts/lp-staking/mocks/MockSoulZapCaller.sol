// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

import "../ApeBondPositionAdapter.sol";

/// @dev The ERC-721 surface this mock needs from the position manager. Declared locally so
///      the mock works against any of the repo's position-manager doubles.
interface IMockNft {
    function approve(address to, uint256 tokenId) external;

    function setApprovalForAll(address operator, bool approved) external;

    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @dev The one vault call the loop lever makes.
interface IMockVault {
    function unstake(uint256 tokenId) external;
}

/**
 * @title MockSoulZapCaller
 * @notice Test-only stand-in for the SoulZap router contract that calls
 *         {ApeBondPositionAdapter-depositFor}.
 *
 *  Why it has to be a contract: every caller-side check of the adapter is about `msg.sender` —
 *  the two allowlists, `ownerOf(tokenId) == msg.sender` and the NFT approval — and production
 *  holds the freshly minted NFT in a contract, approves the adapter and calls `depositFor` in the
 *  same transaction. This does exactly that and nothing else: it swaps nothing and mints nothing.
 *
 *  Levers:
 *    * {Approval} picks how the adapter is authorized for the NFT — per token, as an operator for
 *      everything, or not at all (the `NftNotApproved` leg).
 *    * {depositTwice} presents the same NFT twice inside ONE outer transaction.
 *    * {depositAndUnstake} is the B.3 P2 loop: buy, credit THIS contract as the beneficiary, and
 *      unstake in the same transaction. The bonus must be forfeited.
 *    * {execute} forwards an arbitrary call, so a test can make this contract do anything an
 *      allowlisted caller could.
 */
contract MockSoulZapCaller is IERC721Receiver {
    enum Approval {
        PerToken,
        OperatorForAll,
        None
    }

    /// @notice How {deposit} authorizes the adapter for the NFT.
    Approval public approvalMode = Approval.PerToken;

    /// @notice Number of {depositFor} calls this contract has made.
    uint256 public deposits;

    function setApprovalMode(Approval mode) external {
        approvalMode = mode;
    }

    /// @notice Approves the adapter under the current {approvalMode} and deposits.
    function deposit(
        ApeBondPositionAdapter adapter,
        address positionManager,
        uint256 tokenId,
        bytes32 campaignId,
        address beneficiary
    ) external {
        _approve(adapter, positionManager, tokenId);
        deposits++;
        adapter.depositFor(tokenId, campaignId, beneficiary);
    }

    /// @notice The same deposit twice, back to back, in one transaction.
    function depositTwice(
        ApeBondPositionAdapter adapter,
        address positionManager,
        uint256 tokenId,
        bytes32 campaignId,
        address beneficiary
    ) external {
        _approve(adapter, positionManager, tokenId);
        deposits += 2;
        adapter.depositFor(tokenId, campaignId, beneficiary);
        adapter.depositFor(tokenId, campaignId, beneficiary);
    }

    /// @notice The loop of B.3 P2: deposit with THIS contract as the beneficiary, then unstake
    ///         the position in the same transaction. The NFT comes back here.
    function depositAndUnstake(
        ApeBondPositionAdapter adapter,
        address positionManager,
        uint256 tokenId,
        bytes32 campaignId,
        address vault
    ) external {
        _approve(adapter, positionManager, tokenId);
        deposits++;
        adapter.depositFor(tokenId, campaignId, address(this));
        IMockVault(vault).unstake(tokenId);
    }

    /// @notice Forwards a call, bubbling the revert reason so a test can assert on it.
    function execute(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure override returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    function _approve(ApeBondPositionAdapter adapter, address positionManager, uint256 tokenId) private {
        if (approvalMode == Approval.PerToken) {
            IMockNft(positionManager).approve(address(adapter), tokenId);
        } else if (approvalMode == Approval.OperatorForAll) {
            IMockNft(positionManager).setApprovalForAll(address(adapter), true);
        }
    }
}
