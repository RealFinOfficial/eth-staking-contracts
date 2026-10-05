// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @notice A vault that accepts a `stakeFor` and then reports the wrong thing about it.
 *
 * @dev Why it gets this authority: `vault` is an immutable constructor argument on
 *      {ApeBondPositionAdapter}, so the adapter has no way to verify at run time that the
 *      address it was pointed at is the vault anybody meant. The final custody assertion is
 *      the adapter's only defence against a wrong one, and an assertion nothing can trip is an
 *      assertion nobody has tested.
 *
 *      Two levers, both producing the same rejection from a different direction:
 *        * `takeCustody` false — `stakeFor` returns without pulling the NFT, so the adapter
 *          still owns it when it checks.
 *        * `reportedStaker` — custody moves, but `stakerOf` names somebody other than the
 *          beneficiary the purchase was signed for.
 */
contract MisreportingVault {
    /// @notice Set false to leave the NFT with the adapter.
    bool public takeCustody = true;
    /// @notice Overrides what {stakerOf} reports. Zero means "report what was recorded".
    address public reportedStaker;

    address public immutable positionManager;

    mapping(uint256 => address) private _stakers;

    constructor(address positionManager_) {
        positionManager = positionManager_;
    }

    function setTakeCustody(bool v) external {
        takeCustody = v;
    }

    function setReportedStaker(address v) external {
        reportedStaker = v;
    }

    function stakeFor(address user, uint256 tokenId) external {
        _stakers[tokenId] = user;
        if (takeCustody) {
            (bool ok,) = positionManager.call(
                abi.encodeWithSignature("transferFrom(address,address,uint256)", msg.sender, address(this), tokenId)
            );
            require(ok, "MisreportingVault: pull failed");
        }
    }

    function stakerOf(uint256 tokenId) external view returns (address) {
        return reportedStaker == address(0) ? _stakers[tokenId] : reportedStaker;
    }
}
