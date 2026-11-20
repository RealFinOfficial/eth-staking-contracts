// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.38;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/**
 * @title MockRealToken
 * @notice TEST ONLY. The features of the test $ASSET the bridge owner deployed on Sepolia
 *         (`0x0A5BCe3bc08608C9B4A4d88bA216fe203DA74861`) and Fuji
 *         (`0x8972F308997a18152283a4b65e8FE026d8cB7724`): name `REAL`, symbol `ASSET`, 18 decimals,
 *         EIP-2612 `permit` on the domain `REAL` / `1`, `burn` and `burnFrom`, and no mint after
 *         construction. The unit suites of the burn and payout stand-ins run against it.
 */
contract MockRealToken is ERC20, ERC20Burnable, ERC20Permit {
    /// @param holder Receives the whole supply.
    /// @param supply The fixed supply, in wei.
    constructor(address holder, uint256 supply) ERC20("REAL", "ASSET") ERC20Permit("REAL") {
        _mint(holder, supply);
    }
}
