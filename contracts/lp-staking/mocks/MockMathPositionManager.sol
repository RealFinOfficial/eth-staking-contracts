// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

import "../interfaces/INonfungiblePositionManager.sol";
import "../libraries/LiquidityAmounts.sol";
import "../libraries/TickMath.sol";

/// @dev The one pool read this double makes: the price every mint and burn happens at.
interface IMockMathPool {
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
}

/**
 * @title MockMathPositionManager
 * @notice Test-only position manager with REAL Uniswap V3 liquidity math, for the ApeBond tests
 *         that need the value of a position to mean something — above all the two-rebalance
 *         withdrawal of the B.3 decision document (P3), driven through the real vault.
 *
 *  {MockPositionManager} records `liquidity = amount0 + amount1`, which is fine for custody tests
 *  and meaningless for valuation. This double instead mints `liquidity = getLiquidityForAmounts`
 *  at the pool's CURRENT price (`slot0().sqrtPriceX96`, settable on {MockUniswapV3Pool}),
 *  consumes the amounts that liquidity needs, and on `decreaseLiquidity` credits the amounts the
 *  burned liquidity is worth at the price of THAT moment — the same formulas, from the same
 *  vendored libraries, Uniswap itself uses. What it leaves out: tick-spacing enforcement (so the
 *  document's exact ranges can be used), protocol fees, and real fee accrual — a test adds fees
 *  by hand with {setPendingFees}, which are owed on the next `decreaseLiquidity`.
 *
 *  Amounts are rounded DOWN in both directions (Uniswap rounds the mint's amounts UP by at most
 *  one wei); a test must keep this contract funded for anything it owes beyond what it pulled,
 *  e.g. after moving the price or adding fees.
 */
contract MockMathPositionManager is ERC721 {
    using SafeERC20 for IERC20;

    struct PositionState {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint128 tokensOwed0;
        uint128 tokensOwed1;
        bool exists;
    }

    IMockMathPool public immutable pool;

    mapping(uint256 => PositionState) private _positions;
    mapping(uint256 => uint128) public pendingFees0;
    mapping(uint256 => uint128) public pendingFees1;

    uint256 public nextTokenId = 1;
    uint256 public lastMintedId;

    constructor(address pool_) ERC721("Mock Uniswap V3 Positions (math)", "MOCK-UNI-V3-MATH") {
        pool = IMockMathPool(pool_);
    }

    // ──────────────────────── Test helpers ─────────────────────

    /// @notice Fees owed to `tokenId` on its next `decreaseLiquidity`, on top of its principal.
    function setPendingFees(uint256 tokenId, uint128 fees0, uint128 fees1) external {
        pendingFees0[tokenId] = fees0;
        pendingFees1[tokenId] = fees1;
    }

    // ──────────────────────── Position manager surface ─────────

    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        )
    {
        PositionState storage p = _positions[tokenId];
        require(p.exists, "Invalid token ID");
        return (
            0,
            getApproved(tokenId),
            p.token0,
            p.token1,
            p.fee,
            p.tickLower,
            p.tickUpper,
            p.liquidity,
            0,
            0,
            p.tokensOwed0,
            p.tokensOwed1
        );
    }

    function mint(INonfungiblePositionManager.MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        require(block.timestamp <= params.deadline, "Transaction too old");
        require(params.tickLower < params.tickUpper, "TLU");

        (uint160 sqrtP,,,,,,) = pool.slot0();
        uint160 sqrtA = TickMath.getSqrtRatioAtTick(params.tickLower);
        uint160 sqrtB = TickMath.getSqrtRatioAtTick(params.tickUpper);
        liquidity = _liquidityForAmounts(sqrtP, sqrtA, sqrtB, params.amount0Desired, params.amount1Desired);
        require(liquidity > 0, "Zero liquidity");
        (amount0, amount1) = LiquidityAmounts.getAmountsForLiquidity(sqrtP, sqrtA, sqrtB, liquidity);
        require(amount0 >= params.amount0Min && amount1 >= params.amount1Min, "Price slippage check");

        if (amount0 > 0) IERC20(params.token0).safeTransferFrom(msg.sender, address(this), amount0);
        if (amount1 > 0) IERC20(params.token1).safeTransferFrom(msg.sender, address(this), amount1);

        tokenId = nextTokenId++;
        lastMintedId = tokenId;
        _positions[tokenId] = PositionState({
            token0: params.token0,
            token1: params.token1,
            fee: params.fee,
            tickLower: params.tickLower,
            tickUpper: params.tickUpper,
            liquidity: liquidity,
            tokensOwed0: 0,
            tokensOwed1: 0,
            exists: true
        });
        _mint(params.recipient, tokenId);
    }

    function decreaseLiquidity(INonfungiblePositionManager.DecreaseLiquidityParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1)
    {
        require(block.timestamp <= params.deadline, "Transaction too old");
        _requireAuthorized(params.tokenId);

        PositionState storage p = _positions[params.tokenId];
        require(params.liquidity > 0 && p.liquidity >= params.liquidity, "Invalid liquidity");

        (uint160 sqrtP,,,,,,) = pool.slot0();
        (amount0, amount1) = LiquidityAmounts.getAmountsForLiquidity(
            sqrtP, TickMath.getSqrtRatioAtTick(p.tickLower), TickMath.getSqrtRatioAtTick(p.tickUpper), params.liquidity
        );
        require(amount0 >= params.amount0Min && amount1 >= params.amount1Min, "Price slippage check");

        p.liquidity -= params.liquidity;
        p.tokensOwed0 += uint128(amount0) + pendingFees0[params.tokenId];
        p.tokensOwed1 += uint128(amount1) + pendingFees1[params.tokenId];
        delete pendingFees0[params.tokenId];
        delete pendingFees1[params.tokenId];
    }

    function collect(INonfungiblePositionManager.CollectParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1)
    {
        _requireAuthorized(params.tokenId);
        require(params.recipient != address(0), "Zero recipient");

        PositionState storage p = _positions[params.tokenId];
        amount0 = p.tokensOwed0 < params.amount0Max ? p.tokensOwed0 : params.amount0Max;
        amount1 = p.tokensOwed1 < params.amount1Max ? p.tokensOwed1 : params.amount1Max;
        p.tokensOwed0 -= uint128(amount0);
        p.tokensOwed1 -= uint128(amount1);

        if (amount0 > 0) IERC20(p.token0).safeTransfer(params.recipient, amount0);
        if (amount1 > 0) IERC20(p.token1).safeTransfer(params.recipient, amount1);
    }

    function burn(uint256 tokenId) external payable {
        _requireAuthorized(tokenId);
        PositionState storage p = _positions[tokenId];
        require(p.liquidity == 0 && p.tokensOwed0 == 0 && p.tokensOwed1 == 0, "Not cleared");
        delete _positions[tokenId];
        _burn(tokenId);
    }

    // ──────────────────────── Internal helpers ─────────────────

    function _requireAuthorized(uint256 tokenId) internal view {
        require(_isAuthorized(_requireOwned(tokenId), msg.sender, tokenId), "Not approved");
    }

    /// @dev v3-periphery `LiquidityAmounts.getLiquidityForAmounts`, which the vendored library
    ///      leaves out because no production contract needs it. Test-only.
    function _liquidityForAmounts(uint160 sqrtP, uint160 sqrtA, uint160 sqrtB, uint256 amount0, uint256 amount1)
        private
        pure
        returns (uint128)
    {
        if (sqrtP <= sqrtA) return _liquidity0(sqrtA, sqrtB, amount0);
        if (sqrtP < sqrtB) {
            uint128 l0 = _liquidity0(sqrtP, sqrtB, amount0);
            uint128 l1 = _liquidity1(sqrtA, sqrtP, amount1);
            return l0 < l1 ? l0 : l1;
        }
        return _liquidity1(sqrtA, sqrtB, amount1);
    }

    function _liquidity0(uint160 sqrtA, uint160 sqrtB, uint256 amount0) private pure returns (uint128) {
        uint256 intermediate = Math.mulDiv(sqrtA, sqrtB, 1 << 96);
        return uint128(Math.mulDiv(amount0, intermediate, sqrtB - sqrtA));
    }

    function _liquidity1(uint160 sqrtA, uint160 sqrtB, uint256 amount1) private pure returns (uint128) {
        return uint128(Math.mulDiv(amount1, 1 << 96, sqrtB - sqrtA));
    }
}
