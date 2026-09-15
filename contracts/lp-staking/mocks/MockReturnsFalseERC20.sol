// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockReturnsFalseERC20
 * @notice Test-only ERC20 whose `transfer` and `transferFrom` report failure by returning
 *         `false` instead of reverting, and move nothing.
 *
 *  Models the pre-ERC-20-standardisation tokens that signal failure in the return value —
 *  the original ZRX/BAT behaviour, and the reason {SafeERC20} exists at all. A contract that
 *  calls `token.transfer(...)` and ignores the return value would treat every one of these
 *  silent failures as a successful payout and book it as paid.
 *
 *  Every ERC-20 movement in this stack goes through `SafeERC20`, so this token must make the
 *  whole transaction revert rather than pass quietly. That is the property it exists to test.
 */
contract MockReturnsFalseERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint256 initialSupply, uint8 decimals_)
        ERC20(name_, symbol_)
    {
        _decimals = decimals_;
        _mint(msg.sender, initialSupply);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @dev No balance is touched and no `Transfer` is emitted: the caller is told `false`
    ///      and nothing else happens.
    function transfer(address, uint256) public pure override returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) public pure override returns (bool) {
        return false;
    }
}
