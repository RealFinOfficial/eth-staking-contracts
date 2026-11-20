// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.38;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title TransitionHolder
 * @notice The holding contract at a receiving address of the transition (spec 01 §9.3.1). The
 *         `TransitionReceiver` proxy places it with CREATE2 at `receivingAddressOf(holder, route)`
 *         the first time a `deliver` or a `release` runs for that holder and route. Tokens usually
 *         arrive at that address BEFORE it is placed: the bridge's payout contract and Circle's mint
 *         send to the address directly.
 *
 *  Its whole behaviour: the constructor keeps the deployer (the receiver proxy) as the immutable
 *  `receiver`, and {pull} sends `amount` of `token` to `receiver` when `receiver` calls, and reverts
 *  {NotReceiver} for any other caller. No other function, no owner, no `receive`, no `fallback`:
 *  the tokens at a receiving address can go to the receiver only.
 *
 *  THIS FILE IS THE READABLE SOURCE OF A CONSTANT. The receiver carries this contract's creation
 *  code as the byte literal `HOLDER_CREATION_CODE` and its hash as `HOLDER_INIT_CODE_HASH`; every
 *  receiving address is derived from that hash. Changing this file does NOT change the deployed
 *  holder, and the unit tests fail until the literal and this source agree again (the comparison
 *  leaves out the compiler's metadata tail). Never change it: a new creation code would move every
 *  receiving address.
 */
contract TransitionHolder {
    using SafeERC20 for IERC20;

    /// @dev The receiver proxy that placed this contract.
    address private immutable receiver;

    error NotReceiver(address caller);

    constructor() {
        receiver = msg.sender;
    }

    /// @notice Sends `amount` of `token` to the receiver. The receiver only.
    function pull(address token, uint256 amount) external {
        if (msg.sender != receiver) revert NotReceiver(msg.sender);
        IERC20(token).safeTransfer(receiver, amount);
    }
}
