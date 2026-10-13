// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockFeeOnTransferERC20
 * @notice Test-only ERC20 that takes a settable cut out of every transfer, so the recipient
 *         receives less than the sender sent.
 *
 *  Models the fee-on-transfer class of token — PAXG, SafeMoon-style reflection tokens, and
 *  every ERC-20 with a transfer tax. The whole stack assumes `transfer(to, x)` moves exactly
 *  `x`: the vault and the zapper refund `balanceOf(this)` and the distributor books
 *  `paidAmount` before sending it. This mock is how that assumption gets stated out loud in
 *  a test instead of being taken on trust.
 *
 *  The fee is burned rather than routed to a collector: where it goes is irrelevant to the
 *  contracts under test, only that it never arrives.
 */
contract MockFeeOnTransferERC20 is ERC20 {
    /// @notice Share of every transfer that never arrives, in basis points.
    uint256 public feeBps;

    uint8 private immutable _decimals;

    error FeeTooHigh(uint256 bps);

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 initialSupply,
        uint8 decimals_,
        uint256 feeBps_
    ) ERC20(name_, symbol_) {
        if (feeBps_ > 10_000) revert FeeTooHigh(feeBps_);
        _decimals = decimals_;
        feeBps = feeBps_;
        _mint(msg.sender, initialSupply);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function setFeeBps(uint256 bps) external {
        if (bps > 10_000) revert FeeTooHigh(bps);
        feeBps = bps;
    }

    /// @dev Mints and burns are left whole — only a real transfer between two accounts is
    ///      taxed, which is what the tokens this models do.
    function _update(address from, address to, uint256 value) internal override {
        uint256 fee = (from == address(0) || to == address(0)) ? 0 : (value * feeBps) / 10_000;

        super._update(from, to, value - fee);
        if (fee > 0) super._update(from, address(0), fee);
    }
}
