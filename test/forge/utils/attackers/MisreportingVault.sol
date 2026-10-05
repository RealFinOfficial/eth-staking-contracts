// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @notice A vault that accepts a `stakeFor` and then reports the wrong thing about it.
 *
 * @dev Why it gets this authority: `vault` is an immutable constructor argument on
 *      {ApeBondPositionAdapter}, so the adapter cannot verify at run time that the address it
 *      was pointed at is the vault anybody meant. The final custody assertion is the adapter's
 *      only defence against a wrong one, and an assertion nothing can trip is untested.
 *
 *      It answers the pool reads the adapter's constructor and `depositFor` make (`token0`,
 *      `token1`, `fee`, `pool`, `previewTwap`) from values a test sets, and has two levers that
 *      produce the same rejection from different directions:
 *        * `takeCustody` false — `stakeFor` returns without pulling the NFT;
 *        * `reportedStaker` — custody moves, but `stakerOf` names somebody else.
 */
contract MisreportingVault {
    bool public takeCustody = true;
    address public reportedStaker;

    address public immutable positionManager;
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;
    address public immutable pool;

    mapping(uint256 => address) private _stakers;

    constructor(address positionManager_, address token0_, address token1_, uint24 fee_, address pool_) {
        positionManager = positionManager_;
        token0 = token0_;
        token1 = token1_;
        fee = fee_;
        pool = pool_;
    }

    function setTakeCustody(bool v) external {
        takeCustody = v;
    }

    function setReportedStaker(address v) external {
        reportedStaker = v;
    }

    /// @dev Spot == TWAP == tick 0, inside any bound.
    function previewTwap()
        external
        pure
        returns (int24 currentTick, int24 twapTick, int24 maxDeviationTicks, bool withinBounds)
    {
        return (0, 0, 500, true);
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
