// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "./interfaces/INonfungiblePositionManager.sol";
import "./interfaces/ISwapRouter02.sol";
import "./libraries/TwapGuard.sol";

// ──────────────────────── Shared types ─────────────────────────

/**
 * @notice EIP-2612 permit payload for the USDC pull.
 * @param value Allowance the signature grants to this zapper.
 * @param deadline Permit expiry timestamp.
 * @param v Signature recovery id.
 * @param r Signature r value.
 * @param s Signature s value.
 */
struct PermitData {
    uint256 value;
    uint256 deadline;
    uint8 v;
    bytes32 r;
    bytes32 s;
}

/// @dev Only the call the zapper makes into the vault. Declared locally so the periphery
///      never has to import the core contract.
interface ILPStakingVault {
    function stakeFor(address user, uint256 tokenId) external;
}

/**
 * @title LPZapper
 * @notice One-transaction entry into LP staking: USDC in, staked ASSET-USDC position out.
 *
 *  Replaceable periphery. All custody and accounting live in `LPStakingVault`; this
 *  contract only sequences swap -> mint -> `stakeFor` and refunds what is left over. It
 *  holds no funds and no NFTs between transactions — every balance it ends a transaction
 *  with is dust from a failed refund, recoverable by the owner through `sweep`.
 *
 *  The vault must whitelist this address via `setZapper` before zapping works.
 *
 *  Zap-out is out of scope for V1: `unstake` returns the position NFT itself.
 */
contract LPZapper is Ownable, ReentrancyGuard, TwapGuard, IERC721Receiver {
    using SafeERC20 for IERC20;

    // ──────────────────────── State ────────────────────────────

    /// @notice Vault that takes custody of the minted position.
    ILPStakingVault public immutable vault;
    /// @notice Uniswap V3 NonfungiblePositionManager.
    INonfungiblePositionManager public immutable positionManager;
    /// @notice SwapRouter02 used for the USDC -> ASSET leg.
    ISwapRouter02 public immutable swapRouter;
    /// @notice First token of the pool, sorted ascending by address.
    address public immutable token0;
    /// @notice Second token of the pool.
    address public immutable token1;
    /// @notice Pool fee tier in hundredths of a bip.
    uint24 public immutable fee;
    /// @notice The USDC side of the pair — the token users zap in with.
    address public immutable usdc;
    /// @notice The ASSET side of the pair.
    address public immutable asset;
    /// @notice True when USDC is the pool's token0. Fixes the only valid swap direction.
    bool public immutable usdcIsToken0;

    // ──────────────────────── Events ───────────────────────────

    /// @notice A zap completed. The staker credit itself is evidenced by the vault's
    ///         `Staked` event; this one carries the zap-side amounts.
    event ZappedIn(
        address indexed user,
        uint256 indexed tokenId,
        uint256 usdcIn,
        uint256 usdcRefunded,
        uint256 assetRefunded,
        uint256 timestamp
    );

    /// @notice Dust recovered by the owner.
    event Swept(address indexed token, address indexed to, uint256 amount);

    // ──────────────────────── Errors ───────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error TokensNotSorted(address tokenA, address tokenB);
    error PoolMismatch(address poolToken0, address poolToken1, uint24 poolFee);
    error TokenPairMismatch(address usdc, address asset, address token0, address token1);
    error InvalidSwapDirection(bool zeroForOne, bool expectedZeroForOne);
    error SwapAmountExceedsInput(uint256 amountIn, uint256 usdcAmount);
    error UnexpectedNftSender(address sender);

    // ──────────────────────── Constructor ──────────────────────

    /**
     * @param _vault LPStakingVault that will hold the minted position.
     * @param _positionManager Uniswap V3 NonfungiblePositionManager address.
     * @param _pool The ASSET-USDC pool to mint into and to read the TWAP from.
     * @param _token0 Expected pool token0 (must sort below `_token1`).
     * @param _token1 Expected pool token1.
     * @param _fee Expected pool fee tier.
     * @param _swapRouter SwapRouter02 address.
     * @param _usdc USDC address; must be one side of the pair.
     * @param _asset ASSET address; must be the other side of the pair.
     * @param _initialOwner Owner (multisig) for `setTwapParams` and `sweep`.
     * @param _twapWindow Initial TWAP window in seconds.
     * @param _maxTwapDeviationBps Initial spot-vs-TWAP deviation ceiling in bps.
     */
    constructor(
        address _vault,
        address _positionManager,
        address _pool,
        address _token0,
        address _token1,
        uint24 _fee,
        address _swapRouter,
        address _usdc,
        address _asset,
        address _initialOwner,
        uint32 _twapWindow,
        uint24 _maxTwapDeviationBps
    ) Ownable(_initialOwner) TwapGuard(_pool, _twapWindow, _maxTwapDeviationBps) {
        if (_vault == address(0) || _positionManager == address(0) || _swapRouter == address(0)) {
            revert ZeroAddress();
        }
        if (_token0 == address(0) || _token1 == address(0)) revert ZeroAddress();
        if (_token0 >= _token1) revert TokensNotSorted(_token0, _token1);

        _requirePoolMatches(_pool, _token0, _token1, _fee);

        bool _usdcIsToken0 = (_usdc == _token0 && _asset == _token1);
        if (!_usdcIsToken0 && !(_usdc == _token1 && _asset == _token0)) {
            revert TokenPairMismatch(_usdc, _asset, _token0, _token1);
        }

        vault = ILPStakingVault(_vault);
        positionManager = INonfungiblePositionManager(_positionManager);
        swapRouter = ISwapRouter02(_swapRouter);
        token0 = _token0;
        token1 = _token1;
        fee = _fee;
        usdc = _usdc;
        asset = _asset;
        usdcIsToken0 = _usdcIsToken0;
    }

    // ──────────────────────── User functions ───────────────────

    /**
     * @notice Pulls USDC, swaps part of it to ASSET, mints a position in
     *         `[tickLower, tickUpper]` and stakes it in the vault crediting the caller.
     * @dev Requires a prior USDC approval to this contract. The swap leg is TWAP-guarded
     *      and must run USDC -> ASSET. All leftover USDC and ASSET goes back to the caller
     *      in the same transaction.
     * @param usdcAmount USDC to pull from the caller.
     * @param tickLower Lower tick of the new range.
     * @param tickUpper Upper tick of the new range.
     * @param swap Swap leg and mint minimums, see {SwapParams}. `amountIn == 0` skips the swap.
     * @param deadline Expiry passed to `mint`.
     * @return tokenId The minted position NFT, now staked in the vault for the caller.
     */
    function zapIn(
        uint256 usdcAmount,
        int24 tickLower,
        int24 tickUpper,
        SwapParams calldata swap,
        uint256 deadline
    ) external nonReentrant returns (uint256 tokenId) {
        tokenId = _zapIn(usdcAmount, tickLower, tickUpper, swap, deadline);
    }

    /**
     * @notice `zapIn` preceded by an EIP-2612 USDC permit — no prior approval transaction.
     * @dev The permit is skipped when the caller's allowance already covers `permit.value`.
     *      Permit signatures are public in the mempool and anyone can submit them, so a
     *      griefer can consume the signature first and make a bare `permit` call revert on
     *      a stale nonce. Checking the allowance first makes the zap succeed anyway,
     *      because the front-run permit produced exactly the allowance this call needs.
     * @param usdcAmount USDC to pull from the caller.
     * @param tickLower Lower tick of the new range.
     * @param tickUpper Upper tick of the new range.
     * @param swap Swap leg and mint minimums, see {SwapParams}.
     * @param deadline Expiry passed to `mint`.
     * @param permit EIP-2612 payload authorizing this contract to pull USDC.
     * @return tokenId The minted position NFT, now staked in the vault for the caller.
     */
    function zapInWithPermit(
        uint256 usdcAmount,
        int24 tickLower,
        int24 tickUpper,
        SwapParams calldata swap,
        uint256 deadline,
        PermitData calldata permit
    ) external nonReentrant returns (uint256 tokenId) {
        if (IERC20(usdc).allowance(msg.sender, address(this)) < permit.value) {
            IERC20Permit(usdc).permit(
                msg.sender,
                address(this),
                permit.value,
                permit.deadline,
                permit.v,
                permit.r,
                permit.s
            );
        }
        tokenId = _zapIn(usdcAmount, tickLower, tickUpper, swap, deadline);
    }

    // ──────────────────────── ERC-721 receiver ─────────────────

    /**
     * @notice ERC-721 receipt hook, accepting position NFTs from the configured position
     *         manager only.
     * @dev The canonical position manager mints with `_mint` and never calls back, so this
     *      hook is defensive: it keeps the zap working against a position manager that
     *      does, while still rejecting unsolicited NFTs from anywhere else.
     * @return The ERC-721 receiver magic value.
     */
    function onERC721Received(address, address, uint256, bytes calldata)
        external
        view
        override
        returns (bytes4)
    {
        if (msg.sender != address(positionManager)) revert UnexpectedNftSender(msg.sender);
        return IERC721Receiver.onERC721Received.selector;
    }

    // ──────────────────────── Owner functions ──────────────────

    /**
     * @notice Retunes this contract's own spot-vs-TWAP guard.
     * @dev Independent of the vault's parameters; both are tuned separately.
     * @param window New TWAP window in seconds (>= MIN_TWAP_WINDOW).
     * @param maxDeviationBps New deviation ceiling in bps (0 < x <= MAX_TWAP_DEVIATION_BPS).
     */
    function setTwapParams(uint32 window, uint24 maxDeviationBps) external onlyOwner {
        _setTwapParams(window, maxDeviationBps);
    }

    /**
     * @notice Recovers tokens stranded on this contract.
     * @dev The zapper holds no funds between transactions; any balance is dust left by a
     *      failed refund or a stray transfer.
     * @param token Token to sweep.
     * @param amount Amount to sweep.
     * @param to Recipient.
     */
    function sweep(address token, uint256 amount, address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit Swept(token, to, amount);
    }

    // ──────────────────────── Internal helpers ─────────────────

    /// @dev Deployment sanity: the configured triple must be the pool actually passed in.
    function _requirePoolMatches(address _pool, address _token0, address _token1, uint24 _fee) private view {
        IUniswapV3Pool poolRef = IUniswapV3Pool(_pool);
        if (poolRef.token0() != _token0 || poolRef.token1() != _token1 || poolRef.fee() != _fee) {
            revert PoolMismatch(poolRef.token0(), poolRef.token1(), poolRef.fee());
        }
    }

    /// @dev Shared body of both zap entry points.
    function _zapIn(
        uint256 usdcAmount,
        int24 tickLower,
        int24 tickUpper,
        SwapParams calldata swap,
        uint256 deadline
    ) internal returns (uint256 tokenId) {
        if (usdcAmount == 0) revert ZeroAmount();
        // The zapper can only spend what it just pulled; anything larger is a mistake in
        // the caller's split, caught before any external value moves.
        if (swap.amountIn > usdcAmount) revert SwapAmountExceedsInput(swap.amountIn, usdcAmount);

        IERC20(usdc).safeTransferFrom(msg.sender, address(this), usdcAmount);

        if (swap.amountIn > 0) {
            _executeSwap(swap);
        }

        tokenId = _mintPosition(tickLower, tickUpper, swap, deadline);

        // Per-token approval rather than `setApprovalForAll`: the zapper never holds an NFT
        // across transactions, and the vault's pull clears the approval on transfer.
        positionManager.approve(address(vault), tokenId);
        vault.stakeFor(msg.sender, tokenId);

        (uint256 usdcRefunded, uint256 assetRefunded) = _refundDust(msg.sender);

        emit ZappedIn(msg.sender, tokenId, usdcAmount, usdcRefunded, assetRefunded, block.timestamp);
    }

    /// @dev TWAP-guarded USDC -> ASSET exact-input swap. Approvals are exact and reset to
    ///      zero afterwards; `forceApprove` handles USDC's zero-first allowance rule.
    ///      SwapRouter02's `ExactInputSingleParams` carries no deadline — the caller's
    ///      deadline is enforced by `mint` in the same transaction.
    function _executeSwap(SwapParams calldata swap) internal {
        // USDC -> ASSET is the only direction a zap-in can take; `zeroForOne` must agree
        // with the pool's token ordering.
        if (swap.zeroForOne != usdcIsToken0) revert InvalidSwapDirection(swap.zeroForOne, usdcIsToken0);

        _checkTwapDeviation();

        IERC20(usdc).forceApprove(address(swapRouter), swap.amountIn);
        swapRouter.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: usdc,
                tokenOut: asset,
                fee: fee,
                recipient: address(this),
                amountIn: swap.amountIn,
                amountOutMinimum: swap.amountOutMin,
                sqrtPriceLimitX96: 0
            })
        );
        IERC20(usdc).forceApprove(address(swapRouter), 0);
    }

    /// @dev Mints a position to this contract using the whole current balance of both
    ///      tokens as desired amounts, with the caller's minimums enforced.
    function _mintPosition(int24 tickLower, int24 tickUpper, SwapParams calldata swap, uint256 deadline)
        internal
        returns (uint256 tokenId)
    {
        uint256 amount0 = IERC20(token0).balanceOf(address(this));
        uint256 amount1 = IERC20(token1).balanceOf(address(this));

        IERC20(token0).forceApprove(address(positionManager), amount0);
        IERC20(token1).forceApprove(address(positionManager), amount1);

        (tokenId, , , ) = positionManager.mint(
            INonfungiblePositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: fee,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: amount0,
                amount1Desired: amount1,
                amount0Min: swap.amount0Min,
                amount1Min: swap.amount1Min,
                recipient: address(this),
                deadline: deadline
            })
        );

        IERC20(token0).forceApprove(address(positionManager), 0);
        IERC20(token1).forceApprove(address(positionManager), 0);
    }

    /// @dev Sends every remaining USDC and ASSET wei back to `to`.
    function _refundDust(address to) internal returns (uint256 usdcRefunded, uint256 assetRefunded) {
        usdcRefunded = IERC20(usdc).balanceOf(address(this));
        if (usdcRefunded > 0) IERC20(usdc).safeTransfer(to, usdcRefunded);

        assetRefunded = IERC20(asset).balanceOf(address(this));
        if (assetRefunded > 0) IERC20(asset).safeTransfer(to, assetRefunded);
    }
}
