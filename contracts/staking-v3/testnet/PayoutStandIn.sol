// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.38;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title PayoutStandIn
 * @notice TEST STAND-IN, NEVER DEPLOYED ON A MAINNET. It emits the `Paid` event of the bridge
 *         owner's payout contract on Avalanche C-Chain (his answer of 2026-11-20, section 2) so
 *         the payout of a burn can be rehearsed on Fuji by hand before his own test instance
 *         exists: the owner calls {pay} for each part of a payout.
 *
 *  {pay} transfers `amount` of the {token} this contract holds to `destination` (the token emits
 *  `Transfer` from here to `destination` in the same transaction) and emits {Paid} with
 *  `paidTotal` = everything paid for this `id` so far. A burn is paid in full when
 *  `paidTotal == burnAmount`. It reverts when `paidTotal` would pass `burnAmount`
 *  ({ExceedsBurnAmount}), when `burnAmount` differs from the value an earlier payment of the same
 *  `id` named ({BurnAmountMismatch}), on a zero `destination` ({ZeroDestination}) and on a zero
 *  `amount` ({ZeroAmount}).
 */
contract PayoutStandIn is Ownable {
    using SafeERC20 for IERC20;

    /// @notice The paid token (the test $ASSET on Fuji), funded into this contract.
    IERC20 public immutable token;

    /// @notice Everything paid for a burn id so far.
    mapping(bytes32 id => uint256) public paidTotal;
    /// @notice The burned amount the first payment of an id named (zero before it).
    mapping(bytes32 id => uint256) public burnAmountOf;

    event Paid(bytes32 indexed id, address indexed destination, uint256 amount, uint256 paidTotal, uint256 burnAmount);

    error ZeroAddress();
    error ZeroDestination();
    error ZeroAmount();
    error ExceedsBurnAmount(bytes32 id, uint256 paidTotal, uint256 burnAmount);
    error BurnAmountMismatch(bytes32 id, uint256 recorded, uint256 given);

    constructor(address token_, address owner_) Ownable(owner_) {
        if (token_ == address(0)) revert ZeroAddress();
        token = IERC20(token_);
    }

    /**
     * @notice Pays one part of the burn `id`.
     * @param id The burn id from `Migrated`.
     * @param destination The receiver the burn named.
     * @param amount What this payment sends.
     * @param burnAmount The burned amount.
     */
    function pay(bytes32 id, address destination, uint256 amount, uint256 burnAmount) external onlyOwner {
        if (destination == address(0)) revert ZeroDestination();
        if (amount == 0) revert ZeroAmount();
        uint256 recorded = burnAmountOf[id];
        if (recorded != 0 && recorded != burnAmount) revert BurnAmountMismatch(id, recorded, burnAmount);
        uint256 total = paidTotal[id] + amount;
        if (total > burnAmount) revert ExceedsBurnAmount(id, total, burnAmount);

        burnAmountOf[id] = burnAmount;
        paidTotal[id] = total;
        token.safeTransfer(destination, amount);
        emit Paid(id, destination, amount, total, burnAmount);
    }
}
