// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

import "../ApeBondPositionAdapter.sol";

/// @dev The ERC-721 surface this mock needs from the position manager. Declared locally so
///      the mock works against any of the repo's position-manager doubles.
interface IMockNft {
    function approve(address to, uint256 tokenId) external;

    function setApprovalForAll(address operator, bool approved) external;

    function ownerOf(uint256 tokenId) external view returns (address);
}

/**
 * @title MockSoulZapCaller
 * @notice Test-only stand-in for the SoulZap router contract that calls
 *         {ApeBondPositionAdapter-depositFor}.
 *
 *  Why it has to be a contract at all: every one of the adapter's caller-side checks is about
 *  `msg.sender` — the allowlist, `authorization.soulZapCaller`, `ownerOf(tokenId) == msg.sender`
 *  and the NFT approval. A plain signer can satisfy all four, but not the thing production
 *  actually does: hold the freshly minted NFT in a contract, approve the adapter for it, and
 *  call `depositFor` in the same transaction. This does exactly that and nothing else — it
 *  swaps nothing and mints nothing, because SoulZap's routing is not what these tests are
 *  about.
 *
 *  Three levers:
 *    * {Approval} picks how the adapter is authorized for the NFT — per token, as an operator
 *      for everything, or not at all (the `NftNotApproved` leg).
 *    * {depositTwice} presents the same authorization twice inside ONE outer transaction. That
 *      is the replay the spent-id book has to stop by itself: both calls are in the same
 *      transaction, so no revert rolls the first one back between them.
 *    * {execute} forwards an arbitrary call, so a test can make this contract do anything an
 *      allowlisted caller could — transfer the NFT away first, call with a stale signature, and
 *      so on — without a lever per case.
 *
 *  It implements {IERC721Receiver} so a position can be pushed to it with `safeTransferFrom`.
 *  It has no re-entrant hook: the adapter never sends anything back to its caller — no NFT, no
 *  refund, no callback — so there is no path on which one would fire.
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
        ApeBondPositionAdapter.PurchaseAuthorization calldata authorization,
        bytes calldata realSignature
    ) external {
        _approve(adapter, positionManager, tokenId);
        deposits++;
        adapter.depositFor(tokenId, authorization, realSignature);
    }

    /// @notice The same deposit twice, back to back, in one transaction.
    /// @dev The second call is the one under test: it must fail on the spent purchase id
    ///      rather than on anything the first call left half-done.
    function depositTwice(
        ApeBondPositionAdapter adapter,
        address positionManager,
        uint256 tokenId,
        ApeBondPositionAdapter.PurchaseAuthorization calldata authorization,
        bytes calldata realSignature
    ) external {
        _approve(adapter, positionManager, tokenId);
        deposits += 2;
        adapter.depositFor(tokenId, authorization, realSignature);
        adapter.depositFor(tokenId, authorization, realSignature);
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
