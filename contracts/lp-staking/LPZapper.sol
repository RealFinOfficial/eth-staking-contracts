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
 *  with is dust from a failed refund, recoverable by the owner through `sweep`, and every
 *  position NFT it ends a transaction with was pushed in from outside, recoverable through
 *  `rescuePosition`.
 *
 *  The vault must whitelist this address via `setZapper` before zapping works.
 *
 *  There is no pause switch here, and that is deliberate: every zap ends in
 *  `vault.stakeFor`, so `LPStakingVault.setDepositsPaused(true)` already reverts the whole
 *  `zapIn` with `DepositsArePaused`, and `setZapper(address(0))` takes the path out
 *  altogether. A flag of its own would only be a second thing to get wrong.
 *
 *  Zap-out is out of scope for V1: `unstake` returns the position NFT itself.
 */
contract LPZapper is Ownable, ReentrancyGuard, TwapGuard, IERC721Receiver {
    using SafeERC20 for IERC20;

    // ──────────────────────── Constants ────────────────────────

    /// @dev NFT-receipt guard states, mirroring {LPStakingVault}. Non-zero sentinels keep
    ///      the slot warm and avoid the 20k gas of a 0 -> 1 store on every zap, the same
    ///      trick OZ's ReentrancyGuard uses. A plain storage flag is used rather than
    ///      0.8.28 `transient` so the file keeps compiling under its declared
    ///      `pragma ^0.8.20`.
    uint256 private constant NOT_RECEIVING = 1;
    uint256 private constant RECEIVING = 2;

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

    /// @dev NOT_RECEIVING outside the zapper's own mint, RECEIVING during it.
    uint256 private _receiveGuard = NOT_RECEIVING;

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

    /// @notice A position NFT that was sitting on this contract outside a zap went to the
    ///         owner. The zapper holds no NFT between transactions, so every emission of
    ///         this event is a misdirected transfer being undone.
    event PositionRescued(uint256 indexed tokenId, address indexed to, uint256 timestamp);

    // ──────────────────────── Errors ───────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error TokensNotSorted(address tokenA, address tokenB);
    error PoolMismatch(address poolToken0, address poolToken1, uint24 poolFee);
    error TokenPairMismatch(address usdc, address asset, address token0, address token1);
    error InvalidSwapDirection(bool zeroForOne, bool expectedZeroForOne);
    error SwapAmountExceedsInput(uint256 amountIn, uint256 usdcAmount);
    error UnexpectedNftSender(address sender);
    error UnsolicitedPosition(address operator, address from, uint256 tokenId);

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
     * @param _maxTwapDeviationTicks Initial spot-vs-TWAP deviation ceiling, in ticks.
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
        uint24 _maxTwapDeviationTicks
    ) Ownable(_initialOwner) TwapGuard(_pool, _twapWindow, _maxTwapDeviationTicks) {
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
     * @notice ERC-721 receipt hook. Accepts position NFTs only from the configured position
     *         manager and only inside this contract's own mint.
     * @dev Two gates, mirroring {LPStakingVault}. The sender check keeps foreign ERC-721
     *      collections out; the receipt-window check keeps out safe transfers of genuine
     *      position NFTs pushed in from outside a zap, which would otherwise land here with
     *      nothing in the zap flow to move them on.
     *
     *      The canonical position manager mints with `_mint` and never calls back, so the
     *      window is opened defensively: it keeps the zap working against a position manager
     *      that does call back, and costs nothing against one that does not.
     * @param operator Address that triggered the transfer.
     * @param from Previous owner.
     * @param tokenId The NFT being transferred.
     * @return The ERC-721 receiver magic value.
     */
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata)
        external
        view
        override
        returns (bytes4)
    {
        if (msg.sender != address(positionManager)) revert UnexpectedNftSender(msg.sender);
        if (_receiveGuard != RECEIVING) revert UnsolicitedPosition(operator, from, tokenId);
        return IERC721Receiver.onERC721Received.selector;
    }

    // ──────────────────────── Owner functions ──────────────────

    /**
     * @notice Retunes this contract's own spot-vs-TWAP guard.
     * @dev Independent of the vault's parameters; both are tuned separately.
     * @param window New TWAP window in seconds (MIN_TWAP_WINDOW..MAX_TWAP_WINDOW).
     * @param maxDeviationTicks New deviation ceiling in ticks (0 < x <= MAX_TWAP_DEVIATION_TICKS).
     */
    function setTwapParams(uint32 window, uint24 maxDeviationTicks) external onlyOwner {
        _setTwapParams(window, maxDeviationTicks);
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

    /**
     * @notice Recovers a position NFT stranded on this contract.
     *
     * @dev The counterpart of {sweep} for the non-fungible side. `onERC721Received` now
     *      rejects safe transfers arriving outside a zap, but a plain `transferFrom` never
     *      consults the hook, so an NFT can still be pushed here by mistake. Without this
     *      function it would be stuck forever: nothing else in the contract moves an NFT
     *      the zap flow did not mint.
     *
     *      No allow-list of ids is needed, because the zapper owns no position NFT between
     *      transactions by design — it mints, approves the vault and hands custody over in
     *      the same call. Every id it owns when this function can run is therefore a stray.
     *
     *      `nonReentrant` is what makes that argument hold. Inside `_zapIn` there is a real
     *      window — from the `mint` until `vault.stakeFor` — where the zapper legitimately
     *      owns the new NFT and no record of it exists anywhere. Sharing the reentrancy
     *      guard with both zap entry points closes that window: this call cannot execute
     *      while a zap is in flight, only before or after one.
     *
     *      The destination is `owner()` rather than a caller-supplied address, matching
     *      `RewardsDistributor.recoverExcessAsset`. A position NFT is unique and a mistyped
     *      recipient is unrecoverable, so the recovery path offers no place to mistype one;
     *      the owner multisig forwards it to the rightful holder off-chain. A plain
     *      `transferFrom` is used for the same reason {LPStakingVault-unstake} uses one — a
     *      multisig without an `onERC721Received` hook must not be locked out of its own
     *      recovery path.
     *
     *      Reverts through the position manager's own authorization check when this
     *      contract does not own `tokenId`.
     * @param tokenId Position NFT held by this contract to send to the owner.
     */
    function rescuePosition(uint256 tokenId) external onlyOwner nonReentrant {
        address to = owner();
        positionManager.transferFrom(address(this), to, tokenId);
        emit PositionRescued(tokenId, to, block.timestamp);
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
        // The vault's deposit pause reaches the zap here: a paused vault reverts this call
        // with `DepositsArePaused` and takes the whole zap with it.
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
    ///
    ///      Whole balance, not the amount this call pulled in, and that is deliberate. A
    ///      token0/token1 balance sitting here before the call can only be a misdirected
    ///      transfer or dust from a failed refund — the zapper is drained at the end of
    ///      every zap — and the alternative, tracking per-call amounts, would buy nothing
    ///      but would leave the dust behind on every pass. So the stray joins this mint and
    ///      whatever the mint does not consume is refunded to this caller. Only misdirected
    ///      funds are ever at stake; staked positions are in the vault and are untouched.
    function _mintPosition(int24 tickLower, int24 tickUpper, SwapParams calldata swap, uint256 deadline)
        internal
        returns (uint256 tokenId)
    {
        uint256 amount0 = IERC20(token0).balanceOf(address(this));
        uint256 amount1 = IERC20(token1).balanceOf(address(this));

        IERC20(token0).forceApprove(address(positionManager), amount0);
        IERC20(token1).forceApprove(address(positionManager), amount1);

        // The canonical position manager uses `_mint`, not `_safeMint`, so no receipt hook
        // fires here. The guard is opened anyway so the flow stays correct against any
        // position manager that does call back.
        _receiveGuard = RECEIVING;
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
        _receiveGuard = NOT_RECEIVING;

        IERC20(token0).forceApprove(address(positionManager), 0);
        IERC20(token1).forceApprove(address(positionManager), 0);
    }

    /// @dev Sends every remaining USDC and ASSET wei back to `to`. Whole balance by design,
    ///      the mirror image of {_mintPosition}: a stray USDC or ASSET balance pushed in
    ///      from outside leaves with the next zapper rather than staying to be swept. See
    ///      that function's note for why that trade is the intended one.
    function _refundDust(address to) internal returns (uint256 usdcRefunded, uint256 assetRefunded) {
        usdcRefunded = IERC20(usdc).balanceOf(address(this));
        if (usdcRefunded > 0) IERC20(usdc).safeTransfer(to, usdcRefunded);

        assetRefunded = IERC20(asset).balanceOf(address(this));
        if (assetRefunded > 0) IERC20(asset).safeTransfer(to, assetRefunded);
    }
}
