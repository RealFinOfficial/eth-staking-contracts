// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title INonfungiblePositionManager
 * @notice Minimal vendored interface for the Uniswap V3 NonfungiblePositionManager.
 *
 *  Why vendored: the npm package uniswap/v3-periphery is pinned to `pragma 0.7.6` and
 *  cannot be imported into a 0.8.x compilation unit. It re-declares only the surface the
 *  LP staking stack actually calls, with struct layouts and return tuples byte-identical
 *  to the deployed contract (0xC36442b4a4522E871399CD717aBDD847Ab11FE88 on mainnet),
 *  so ABI encoding matches exactly.
 *
 *  `mint`, `decreaseLiquidity`, `collect`, `burn` and `permit` are `payable` on the real
 *  contract (it inherits `PeripheryPayments` + `Multicall`). They are declared `payable`
 *  here too — calling a payable function with zero value is always valid.
 */
interface INonfungiblePositionManager {
    // ──────────────────────── Structures ────────────────────────

    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    // ──────────────────────── Position data ─────────────────────

    /// @notice Full on-chain state of a position NFT.
    /// @param tokenId The position NFT id.
    /// @return nonce Permit nonce of the position.
    /// @return operator Address approved for this single token.
    /// @return token0 First token of the pool, sorted ascending.
    /// @return token1 Second token of the pool.
    /// @return fee Pool fee tier in hundredths of a bip.
    /// @return tickLower Lower tick of the position range.
    /// @return tickUpper Upper tick of the position range.
    /// @return liquidity Liquidity currently held by the position.
    /// @return feeGrowthInside0LastX128 Fee growth of token0 as of the last action.
    /// @return feeGrowthInside1LastX128 Fee growth of token1 as of the last action.
    /// @return tokensOwed0 Uncollected token0 owed to the position.
    /// @return tokensOwed1 Uncollected token1 owed to the position.
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
        );

    // ──────────────────────── Liquidity actions ─────────────────

    /// @notice Mints a new position NFT for `params.recipient`.
    /// @param params Mint parameters, see {MintParams}.
    /// @return tokenId Id of the newly minted position NFT.
    /// @return liquidity Liquidity added to the position.
    /// @return amount0 Amount of token0 actually consumed.
    /// @return amount1 Amount of token1 actually consumed.
    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);

    /// @notice Burns liquidity from a position, crediting the amounts as owed.
    /// @param params Decrease parameters, see {DecreaseLiquidityParams}.
    /// @return amount0 Token0 credited as owed.
    /// @return amount1 Token1 credited as owed.
    function decreaseLiquidity(DecreaseLiquidityParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1);

    /// @notice Transfers owed tokens (principal removed by decreaseLiquidity plus fees).
    /// @param params Collect parameters, see {CollectParams}.
    /// @return amount0 Token0 transferred to `params.recipient`.
    /// @return amount1 Token1 transferred to `params.recipient`.
    function collect(CollectParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1);

    /// @notice Burns an empty position NFT. Requires zero liquidity and zero owed tokens.
    /// @param tokenId The position NFT to burn.
    function burn(uint256 tokenId) external payable;

    // ──────────────────────── ERC-721 surface ───────────────────

    /// @notice EIP-4494 style permit — approves `spender` for `tokenId` from an off-chain signature.
    /// @param spender Address to approve.
    /// @param tokenId The position NFT.
    /// @param deadline Signature expiry timestamp.
    /// @param v Signature recovery id.
    /// @param r Signature r value.
    /// @param s Signature s value.
    function permit(address spender, uint256 tokenId, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        payable;

    /// @notice Transfers a position NFT and invokes `onERC721Received` on a contract recipient.
    /// @param from Current owner.
    /// @param to Recipient.
    /// @param tokenId The position NFT.
    function safeTransferFrom(address from, address to, uint256 tokenId) external;

    /// @notice Transfers a position NFT without the receiver callback.
    /// @param from Current owner.
    /// @param to Recipient.
    /// @param tokenId The position NFT.
    function transferFrom(address from, address to, uint256 tokenId) external;

    /// @notice Current owner of a position NFT.
    /// @param tokenId The position NFT.
    /// @return owner The owner address.
    function ownerOf(uint256 tokenId) external view returns (address owner);

    /// @notice Approves `to` to transfer a single position NFT.
    /// @param to Address to approve.
    /// @param tokenId The position NFT.
    function approve(address to, uint256 tokenId) external;

    /// @notice The single address approved for one position NFT, or zero.
    /// @param tokenId The position NFT.
    /// @return operator The approved address.
    function getApproved(uint256 tokenId) external view returns (address operator);

    /// @notice Whether `operator` may move every position NFT `owner` holds.
    /// @param owner The NFT owner.
    /// @param operator The address to test.
    /// @return True when the blanket approval is in place.
    function isApprovedForAll(address owner, address operator) external view returns (bool);
}
