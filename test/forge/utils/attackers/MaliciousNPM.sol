// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {INonfungiblePositionManager} from "../../../../contracts/lp-staking/interfaces/INonfungiblePositionManager.sol";

/**
 * @notice A position manager that lies, in the three ways that matter.
 *
 * @dev Why it gets this authority: the position manager is an immutable constructor
 *      argument on both the vault and the zapper, and every custody decision the vault makes
 *      is taken on data this contract returns (`positions`) or on custody it performs
 *      (`mint` / `burn` / `transferFrom`). A reviewer asking "what if the NPM misbehaves"
 *      is asking about a deploy-time misconfiguration or a periphery upgrade, both real.
 *
 *      Three levers, each one finding:
 *        * `mintReturnsExistingId` — `mint` hands back a tokenId that is ALREADY staked, so
 *          `rebalance` would overwrite a live staker record with someone else's.
 *        * `burnReverts` — the burn at the end of `rebalance` fails after the record has
 *          already moved.
 *        * `stealOnMint` — the NPM transfers the freshly minted NFT away from the vault
 *          during the mint, so the vault holds a record for an NFT it does not own.
 */
contract MaliciousNPM is ERC721 {
    using SafeERC20 for IERC20;

    struct P {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint128 owed0;
        uint128 owed1;
        uint256 principal0;
        uint256 principal1;
        bool exists;
    }

    mapping(uint256 => P) private _p;
    uint256 public nextTokenId = 1;
    uint256 public lastMintedId;

    // ── levers ───────────────────────────────────────────────
    uint256 public mintReturnsExistingId;
    bool public burnReverts;
    address public stealOnMintTo;

    constructor() ERC721("Malicious Positions", "EVIL-POS") {}

    function setMintReturnsExistingId(uint256 tokenId) external {
        mintReturnsExistingId = tokenId;
    }

    function setBurnReverts(bool v) external {
        burnReverts = v;
    }

    function setStealOnMintTo(address to) external {
        stealOnMintTo = to;
    }

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
        _p[tokenId] = P(token0_, token1_, fee_, tickLower, tickUpper, liquidity, 0, 0, principal0, principal1, true);
        _mint(to, tokenId);
    }

    function positions(uint256 tokenId)
        external
        view
        returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128)
    {
        P storage p = _p[tokenId];
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
            p.owed0,
            p.owed1
        );
    }

    function mint(INonfungiblePositionManager.MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        amount0 = params.amount0Desired;
        amount1 = params.amount1Desired;
        if (amount0 > 0) IERC20(params.token0).safeTransferFrom(msg.sender, address(this), amount0);
        if (amount1 > 0) IERC20(params.token1).safeTransferFrom(msg.sender, address(this), amount1);
        liquidity = uint128(amount0 + amount1);

        if (mintReturnsExistingId != 0) {
            // No new NFT: the caller is told an id it already holds a record for.
            return (mintReturnsExistingId, liquidity, amount0, amount1);
        }

        tokenId = nextTokenId++;
        lastMintedId = tokenId;
        _p[tokenId] = P(
            params.token0,
            params.token1,
            params.fee,
            params.tickLower,
            params.tickUpper,
            liquidity,
            0,
            0,
            amount0,
            amount1,
            true
        );
        _mint(params.recipient, tokenId);

        if (stealOnMintTo != address(0)) {
            _update(stealOnMintTo, tokenId, address(0)); // auth bypassed on purpose
        }
    }

    function decreaseLiquidity(INonfungiblePositionManager.DecreaseLiquidityParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1)
    {
        P storage p = _p[params.tokenId];
        require(p.liquidity >= params.liquidity && params.liquidity > 0, "Invalid liquidity");
        amount0 = (p.principal0 * params.liquidity) / p.liquidity;
        amount1 = (p.principal1 * params.liquidity) / p.liquidity;
        p.principal0 -= amount0;
        p.principal1 -= amount1;
        p.liquidity -= params.liquidity;
        p.owed0 += uint128(amount0);
        p.owed1 += uint128(amount1);
    }

    function collect(INonfungiblePositionManager.CollectParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1)
    {
        P storage p = _p[params.tokenId];
        amount0 = p.owed0 < params.amount0Max ? p.owed0 : params.amount0Max;
        amount1 = p.owed1 < params.amount1Max ? p.owed1 : params.amount1Max;
        p.owed0 -= uint128(amount0);
        p.owed1 -= uint128(amount1);
        if (amount0 > 0) IERC20(p.token0).safeTransfer(params.recipient, amount0);
        if (amount1 > 0) IERC20(p.token1).safeTransfer(params.recipient, amount1);
    }

    function burn(uint256 tokenId) external payable {
        require(!burnReverts, "MaliciousNPM: burn refused");
        delete _p[tokenId];
        _burn(tokenId);
    }

    function permit(address spender, uint256 tokenId, uint256, uint8, bytes32, bytes32) external payable {
        _approve(spender, tokenId, address(0));
    }
}
