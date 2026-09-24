// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/**
 * @title MockERC20Permit
 * @notice Test-only ERC20 with configurable decimals and a real EIP-2612 `permit`.
 *
 *  {MockERC20Decimals} has no `permit`, so it cannot exercise {LPZapper.zapInWithPermit}'s
 *  signature branch — only its allowance-already-sufficient skip branch. This mock covers
 *  both: a valid signature grants the allowance, an invalid one reverts inside the token.
 */
contract MockERC20Permit is ERC20, ERC20Permit {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint256 initialSupply, uint8 decimals_)
        ERC20(name_, symbol_)
        ERC20Permit(name_)
    {
        _decimals = decimals_;
        _mint(msg.sender, initialSupply);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }
}
