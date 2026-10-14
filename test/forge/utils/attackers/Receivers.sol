// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ITokenHook} from "./HostileTokens.sol";

/**
 * @notice Recipients that make a push fail, and owners that push back.
 */

/// @dev A contract with no `onERC721Received` and a reverting fallback. Models a multisig
///      or a plain treasury that never implemented the receiver hook — the case
///      {LPStakingVault-unstake} and {LPStakingVault-rescuePosition} use a plain
///      `transferFrom` for. Authority: none; being a code-bearing address is the whole
///      attack surface.
contract RejectingReceiver {
    /// @notice Set true to also make every plain call revert.
    bool public rejectEverything = true;

    function setRejectEverything(bool v) external {
        rejectEverything = v;
    }

    /// @dev Forwards a call so the contract can act as a staker / claimer.
    function execute(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret;
    }

    fallback() external payable {
        require(!rejectEverything, "RejectingReceiver: no");
    }

    receive() external payable {
        require(!rejectEverything, "RejectingReceiver: no");
    }
}

/// @dev The mirror image: a receiver that accepts NFTs and, on the same hook, calls back
///      into a configured target. Models a "smart" staker contract whose receipt hook is
///      the reentrancy vector — the vault opens its receive window during `_stake`, so this
///      is where a hook would land if a position manager used `_safeMint`.
contract ReentrantReceiver is IERC721Receiver, ITokenHook {
    address public target;
    bytes public payload;
    uint256 public attempts;
    bool public lastReenterSucceeded;
    bytes public lastReturnData;

    function configure(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
    }

    function execute(address target_, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target_.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret;
    }

    function approveErc721(address token, address spender, uint256 tokenId) external {
        (bool ok,) = token.call(abi.encodeWithSignature("approve(address,uint256)", spender, tokenId));
        require(ok, "approve failed");
    }

    function _reenter() private {
        if (target == address(0) || payload.length == 0) return;
        attempts++;
        (bool ok, bytes memory ret) = target.call(payload);
        lastReenterSucceeded = ok;
        lastReturnData = ret;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external override returns (bytes4) {
        _reenter();
        return IERC721Receiver.onERC721Received.selector;
    }

    /// @notice {HookToken} push hook — the ERC-777-style reentrancy leg.
    function tokensReceived(address, address, uint256) external override {
        _reenter();
    }
}

/// @dev An owner that reenters the contract it owns from inside a push it receives. Models a
///      compromised or simply "clever" multisig. Authority: it really is the owner, because
///      the question under test is what an owner can do to itself. Since N-1 every contract in
///      the stack is `Ownable2Step`, so becoming the owner takes two calls — the test
///      nominates, and this contract completes the handshake through its own `execute`.
contract HostileOwner is ITokenHook, IERC721Receiver {
    address public target;
    bytes public payload;
    uint256 public attempts;
    bool public lastReenterSucceeded;
    /// @dev The rejection bytes of the last reentrant call, so a test can assert WHICH error
    ///      stopped it — the reentrancy guard's own, rather than merely "something failed".
    bytes public lastReturnData;

    function configure(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
    }

    function execute(address target_, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target_.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret;
    }

    function tokensReceived(address, address, uint256) external override {
        if (target == address(0) || payload.length == 0) return;
        attempts++;
        (bool ok, bytes memory ret) = target.call(payload);
        lastReenterSucceeded = ok;
        lastReturnData = ret;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure override returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}
