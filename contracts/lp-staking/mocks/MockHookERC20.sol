// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title MockHookERC20
 * @notice Test-only ERC20 that hands control to a third party in the middle of a transfer,
 *         the way an ERC-777 `tokensReceived` hook does.
 *
 *  Models the callback class of token: ERC-777, ERC-1363 and every token whose transfer runs
 *  code the token holder did not write. Against such a token a plain `token.transfer(...)` is
 *  a re-entrancy vector, so every contract that moves one must survive an arbitrary call
 *  landing in the middle of its own state changes.
 *
 *  ERC-777 fires only for recipients registered with the ERC-1820 registry, and this mock
 *  keeps that shape: a hook is registered per recipient address, and only a transfer landing
 *  on that recipient fires it. The call target and calldata are settable rather than fixed to
 *  `to.tokensReceived(...)`, so a test can aim the re-entrant call at exactly the entry point
 *  under test without needing a bespoke attacker contract per target.
 *
 *  The hook's revert is bubbled unchanged, so the custom error raised inside the re-entered
 *  contract is what the test sees.
 */
contract MockHookERC20 is ERC20 {
    struct Hook {
        address target;
        bytes data;
    }

    /// @dev Recipient address => the call its incoming transfers trigger.
    mapping(address => Hook) private _hooks;

    uint8 private immutable _decimals;

    /// @notice Number of hook calls made so far, so a test can prove one really fired.
    uint256 public hookCalls;

    constructor(string memory name_, string memory symbol_, uint256 initialSupply, uint8 decimals_)
        ERC20(name_, symbol_)
    {
        _decimals = decimals_;
        _mint(msg.sender, initialSupply);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /**
     * @notice Registers the call that fires whenever a transfer lands on `recipient`.
     * @param recipient Transfer recipient that arms the hook. Nothing fires for any other.
     * @param target Contract the hook calls. Zero disarms the hook.
     * @param data Calldata for that call.
     */
    function setRecipientHook(address recipient, address target, bytes calldata data) external {
        _hooks[recipient] = Hook({target: target, data: data});
    }

    /**
     * @notice Runs a registered hook on demand, with no transfer around it.
     * @dev Lets a test prove the same call succeeds outside the window it was blocked in, so
     *      a re-entrancy assertion cannot pass for the wrong reason.
     * @param recipient The recipient whose hook to fire.
     */
    function fireRecipientHook(address recipient) external {
        _fireHook(recipient);
    }

    /// @dev The hook runs after the balances have moved, matching ERC-777's `tokensReceived`.
    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        _fireHook(to);
    }

    function _fireHook(address recipient) private {
        Hook storage hook = _hooks[recipient];
        if (hook.target == address(0)) return;

        hookCalls++;
        // `functionCall` bubbles the callee's revert data verbatim, so a custom error raised
        // by the re-entered contract survives the trip back out through this token.
        Address.functionCall(hook.target, hook.data);
    }
}
