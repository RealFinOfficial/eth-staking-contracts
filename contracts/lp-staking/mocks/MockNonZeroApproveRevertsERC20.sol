// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockNonZeroApproveRevertsERC20
 * @notice Test-only ERC20 that refuses to move a non-zero allowance straight to another
 *         non-zero value: the allowance must be reset to zero first.
 *
 *  Models USDT and the USDC-style approval race mitigation. A contract that calls a plain
 *  `approve(spender, amount)` against one of these is stuck for good the moment a non-zero
 *  allowance is left standing — which is why the vault and the zapper approve through
 *  `SafeERC20.forceApprove`, whose fallback writes a zero first.
 *
 *  {seedAllowance} fabricates exactly that standing allowance, because the contracts under
 *  test always reset their own approvals to zero and can therefore never produce one
 *  themselves. Without it the `forceApprove` fallback is unreachable and the pattern would
 *  go untested.
 */
contract MockNonZeroApproveRevertsERC20 is ERC20 {
    uint8 private immutable _decimals;

    /// @dev Raised for the non-zero -> non-zero move USDT forbids.
    error ApproveFromNonZeroAllowance(address spender, uint256 currentAllowance, uint256 requested);

    constructor(string memory name_, string memory symbol_, uint256 initialSupply, uint8 decimals_)
        ERC20(name_, symbol_)
    {
        _decimals = decimals_;
        _mint(msg.sender, initialSupply);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @dev Setting an allowance to zero is always allowed — that is the reset half of the
    ///      pattern. Only a non-zero value over a non-zero allowance is refused.
    function approve(address spender, uint256 value) public override returns (bool) {
        uint256 current = allowance(msg.sender, spender);
        if (value != 0 && current != 0) {
            revert ApproveFromNonZeroAllowance(spender, current, value);
        }
        return super.approve(spender, value);
    }

    /// @notice Writes an allowance without going through {approve}, to fabricate the stale
    ///         non-zero allowance a plain `approve` can no longer overwrite.
    function seedAllowance(address owner_, address spender, uint256 value) external {
        _approve(owner_, spender, value);
    }
}
