// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "../interfaces/INonfungiblePositionManager.sol";

/**
 * @title MockPositionManager
 * @notice Test-only stand-in for the Uniswap V3 NonfungiblePositionManager.
 *
 *  Real ERC-721 ownership (OpenZeppelin {ERC721}), so `safeTransferFrom` really does call
 *  `onERC721Received` on contract recipients and approvals are really enforced. The
 *  liquidity side is bookkeeping only:
 *
 *    - `mint` consumes `mintConsumeBps` of each desired amount, pulls exactly that much
 *      through `transferFrom` and records it as the position's principal. Anything below
 *      `amount0Min` / `amount1Min` reverts the way the real mint does.
 *    - `decreaseLiquidity` credits principal pro rata to the burned liquidity plus any
 *      pending fees set for the position, mirroring fee compounding.
 *    - `collect` pays the owed amounts out of this contract's own balance, so a test must
 *      fund it for every principal it fabricates through `mintFake`.
 *    - `burn` reverts unless the position is completely empty, like the real one.
 *
 *  The struct types are taken from {INonfungiblePositionManager} rather than redeclared, so
 *  the calldata layout the contracts under test encode is exactly the layout decoded here.
 *  The interface is deliberately not inherited: OZ's `safeTransferFrom(address,address,
 *  uint256)` is not `virtual` and therefore cannot carry the required `override`.
 */
contract MockPositionManager is ERC721 {
    using SafeERC20 for IERC20;

    // ──────────────────────── Types ────────────────────────────

    struct PositionState {
        uint96 nonce;
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint128 tokensOwed0;
        uint128 tokensOwed1;
        uint256 principal0;
        uint256 principal1;
        bool exists;
    }

    // ──────────────────────── State ────────────────────────────

    mapping(uint256 => PositionState) private _positions;

    /// @notice Id the next mint will use.
    uint256 public nextTokenId = 1;
    /// @notice Id produced by the last mint, for tests that cannot read the return value.
    uint256 public lastMintedId;
    /// @notice Number of `mint` calls so far.
    uint256 public mintCalls;
    /// @notice Number of `permit` calls that reached the body.
    uint256 public permitCalls;

    /// @notice Share of each desired amount a mint actually consumes, in bps. Below 10000
    ///         the caller keeps dust, which is what exercises the refund paths.
    uint256 public mintConsumeBps = 10_000;
    /// @notice When true, `permit` reverts instead of granting the approval.
    bool public permitShouldFail;
    /// @notice When true, `mint` uses `_safeMint`, so a contract recipient gets the receipt
    ///         hook. The canonical position manager does not; the vault tolerates both.
    bool public safeMintEnabled;

    /// @dev Fees credited on top of principal by the next `decreaseLiquidity`.
    mapping(uint256 => uint128) public pendingFees0;
    mapping(uint256 => uint128) public pendingFees1;

    // ──────────────────────── Constructor ──────────────────────

    constructor() ERC721("Mock Uniswap V3 Positions", "MOCK-UNI-V3-POS") {}

    // ──────────────────────── Test setters ─────────────────────

    function setMintConsumeBps(uint256 bps) external {
        require(bps <= 10_000, "bps > 100%");
        mintConsumeBps = bps;
    }

    function setPermitShouldFail(bool value) external {
        permitShouldFail = value;
    }

    function setSafeMintEnabled(bool value) external {
        safeMintEnabled = value;
    }

    /// @notice Overwrites the principal backing a position's live liquidity.
    function setPrincipal(uint256 tokenId, uint256 principal0, uint256 principal1) external {
        _positions[tokenId].principal0 = principal0;
        _positions[tokenId].principal1 = principal1;
    }

    /// @notice Accrues fees that the next `decreaseLiquidity` adds to the owed amounts.
    function setPendingFees(uint256 tokenId, uint128 fees0, uint128 fees1) external {
        pendingFees0[tokenId] = fees0;
        pendingFees1[tokenId] = fees1;
    }

    /// @notice Fabricates a position without moving any tokens.
    /// @dev Fund this contract separately with `principal0` / `principal1` so a later
    ///      `collect` can actually pay them out.
    function mintFake(
        address to,
        address token0_,
        address token1_,
        uint24 fee_,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint256 principal0,
        uint256 principal1
    ) external returns (uint256 tokenId) {
        tokenId = nextTokenId++;
        lastMintedId = tokenId;

        _positions[tokenId] = PositionState({
            nonce: 0,
            token0: token0_,
            token1: token1_,
            fee: fee_,
            tickLower: tickLower,
            tickUpper: tickUpper,
            liquidity: liquidity,
            tokensOwed0: 0,
            tokensOwed1: 0,
            principal0: principal0,
            principal1: principal1,
            exists: true
        });

        _mint(to, tokenId);
    }

    // ──────────────────────── Position data ────────────────────

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
            p.nonce,
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

    // ──────────────────────── Liquidity actions ────────────────

    function mint(INonfungiblePositionManager.MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        require(block.timestamp <= params.deadline, "Transaction too old");

        amount0 = (params.amount0Desired * mintConsumeBps) / 10_000;
        amount1 = (params.amount1Desired * mintConsumeBps) / 10_000;
        require(amount0 >= params.amount0Min && amount1 >= params.amount1Min, "Price slippage check");

        liquidity = uint128(amount0 + amount1);
        require(liquidity > 0, "Zero liquidity");

        if (amount0 > 0) IERC20(params.token0).safeTransferFrom(msg.sender, address(this), amount0);
        if (amount1 > 0) IERC20(params.token1).safeTransferFrom(msg.sender, address(this), amount1);

        tokenId = nextTokenId++;
        lastMintedId = tokenId;
        mintCalls++;

        _positions[tokenId] = PositionState({
            nonce: 0,
            token0: params.token0,
            token1: params.token1,
            fee: params.fee,
            tickLower: params.tickLower,
            tickUpper: params.tickUpper,
            liquidity: liquidity,
            tokensOwed0: 0,
            tokensOwed1: 0,
            principal0: amount0,
            principal1: amount1,
            exists: true
        });

        if (safeMintEnabled) {
            _safeMint(params.recipient, tokenId);
        } else {
            _mint(params.recipient, tokenId);
        }
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

        amount0 = (p.principal0 * params.liquidity) / p.liquidity;
        amount1 = (p.principal1 * params.liquidity) / p.liquidity;
        require(amount0 >= params.amount0Min && amount1 >= params.amount1Min, "Price slippage check");

        p.principal0 -= amount0;
        p.principal1 -= amount1;
        p.liquidity -= params.liquidity;

        // Principal plus the fees accrued while the liquidity was live. Both leave through
        // `collect`, which is what makes fees compound into the next range.
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

    // ──────────────────────── ERC-721 extras ───────────────────

    function permit(address spender, uint256 tokenId, uint256 deadline, uint8, bytes32, bytes32)
        external
        payable
    {
        require(!permitShouldFail, "Permit failed");
        require(block.timestamp <= deadline, "Permit expired");

        permitCalls++;
        // auth == address(0) skips OZ's own approval check: the signature already is the
        // authorization on the real contract.
        _approve(spender, tokenId, address(0));
    }

    // ──────────────────────── Internal helpers ─────────────────

    function _requireAuthorized(uint256 tokenId) internal view {
        require(_isAuthorized(_requireOwned(tokenId), msg.sender, tokenId), "Not approved");
    }
}
