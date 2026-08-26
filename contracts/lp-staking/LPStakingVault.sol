// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "./interfaces/INonfungiblePositionManager.sol";
import "./interfaces/ISwapRouter02.sol";
import "./libraries/TwapGuard.sol";

/**
 * @title LPStakingVault
 * @notice Custody vault for Uniswap V3 ASSET-USDC liquidity positions.
 *
 *  Scope: custody and range management only. The vault holds staked position NFTs,
 *  records who staked each one, and lets the staker atomically re-range a position
 *  without ever losing custody. It computes no rewards, stores no dollar values and
 *  judges no ranges — scoring and reward accounting are entirely off-chain, driven by
 *  the full-state events emitted here.
 *
 *  Lifecycle:
 *    1. `stake` / `stakeWithPermit` (direct) or `stakeFor` (through the whitelisted
 *       zapper) takes custody of a position NFT and records the staker.
 *    2. `rebalance` withdraws all liquidity and accrued fees, optionally swaps, mints a
 *       new position on the same pool, refunds dust, burns the emptied NFT and keeps the
 *       new one staked under the same staker. Trading fees compound into the new range.
 *    3. `unstake` returns the NFT to its staker.
 *
 *  Exits are unconditional: `unstake` is never gated by a pause switch, by a signature, or
 *  by backend liveness. Deposits and `rebalance` are each pausable behind their own owner
 *  switch — `rebalance` is the most complex function here and the contract is immutable, so
 *  a bug found post-deploy has to have a mitigation. Zaps stop with the deposit pause,
 *  because `zapIn` finishes through `stakeFor`.
 *
 *  The vault holds no fungible tokens between transactions. Any token0/token1 balance left
 *  at the end of a `rebalance` is refunded to the staker in the same transaction.
 */
contract LPStakingVault is Ownable, ReentrancyGuard, TwapGuard, IERC721Receiver {
    using SafeERC20 for IERC20;

    // ──────────────────────── Constants ────────────────────────

    /// @dev NFT-receipt guard states. Non-zero sentinels keep the slot warm and avoid the
    ///      20k gas of a 0 -> 1 store on every stake, mirroring OZ's ReentrancyGuard trick.
    ///      A plain storage flag is used rather than 0.8.28 `transient` so the file keeps
    ///      compiling under its declared `pragma ^0.8.20`.
    uint256 private constant NOT_RECEIVING = 1;
    uint256 private constant RECEIVING = 2;

    // ──────────────────────── State ────────────────────────────

    /// @notice Uniswap V3 NonfungiblePositionManager holding the staked NFTs.
    INonfungiblePositionManager public immutable positionManager;
    /// @notice SwapRouter02 used for the rebalance swap leg.
    ISwapRouter02 public immutable swapRouter;
    /// @notice First token of the accepted pool, sorted ascending by address.
    address public immutable token0;
    /// @notice Second token of the accepted pool.
    address public immutable token1;
    /// @notice Fee tier of the accepted pool, in hundredths of a bip.
    uint24 public immutable fee;

    /// @notice Zapper allowed to call `stakeFor`. Zero disables the path.
    address public zapper;
    /// @notice When true, no new positions can be taken into custody. Never blocks exits.
    bool public depositsPaused;
    /// @notice When true, `rebalance` reverts. Never blocks `unstake` — the exit stays open.
    bool public rebalancePaused;

    /// @dev tokenId => staker. Zero means "not staked here".
    mapping(uint256 => address) private _stakers;
    /// @dev NOT_RECEIVING outside an expected NFT receipt, RECEIVING during one.
    uint256 private _receiveGuard = NOT_RECEIVING;

    // ──────────────────────── Events ───────────────────────────

    /// @notice A position NFT entered custody. Carries the position's full range state.
    event Staked(
        address indexed user,
        uint256 indexed tokenId,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint256 timestamp
    );

    /// @notice A position NFT left custody and went back to its staker.
    event Unstaked(address indexed user, uint256 indexed tokenId, uint256 timestamp);

    /// @notice A position was re-ranged. `oldTokenId` -> `newTokenId` gives the indexer the
    ///         lineage; the old NFT no longer exists after this event.
    event Rebalanced(
        address indexed user,
        uint256 indexed oldTokenId,
        uint256 indexed newTokenId,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint256 amount0Refunded,
        uint256 amount1Refunded,
        uint256 timestamp
    );

    /// @notice Deposit pause switch changed. Full new state.
    event DepositsPausedSet(bool depositsPaused);

    /// @notice Rebalance pause switch changed. Full new state.
    event RebalancePausedSet(bool rebalancePaused);

    /// @notice Whitelisted zapper changed. Carries both sides for auditability.
    event ZapperSet(address previousZapper, address newZapper);

    /// @notice A position NFT with no staker record left the vault for the owner. Never
    ///         fires for a staked position — see {rescuePosition}.
    event PositionRescued(uint256 indexed tokenId, address indexed to, uint256 timestamp);

    // ──────────────────────── Errors ───────────────────────────

    error ZeroAddress();
    error TokensNotSorted(address tokenA, address tokenB);
    error PoolMismatch(address poolToken0, address poolToken1, uint24 poolFee);
    error DepositsArePaused();
    error RebalanceIsPaused();
    error AlreadyStaked(uint256 tokenId, address staker);
    error NotStaker(uint256 tokenId, address caller, address staker);
    error NotZapper(address caller, address zapper);
    error PositionPoolMismatch(uint256 tokenId, address positionToken0, address positionToken1, uint24 positionFee);
    error EmptyPosition(uint256 tokenId);
    error UnexpectedNftSender(address sender);
    error UnsolicitedPosition(address operator, address from, uint256 tokenId);
    error SwapAmountExceedsBalance(address tokenIn, uint256 amountIn, uint256 balance);
    error PositionIsStaked(uint256 tokenId, address staker);

    // ──────────────────────── Constructor ──────────────────────

    /**
     * @param _positionManager Uniswap V3 NonfungiblePositionManager address.
     * @param _pool The single ASSET-USDC pool whose positions this vault accepts.
     * @param _token0 Expected pool token0 (must sort below `_token1`).
     * @param _token1 Expected pool token1.
     * @param _fee Expected pool fee tier.
     * @param _swapRouter SwapRouter02 address used by `rebalance`.
     * @param _initialOwner Owner (multisig) for the admin setters.
     * @param _twapWindow Initial TWAP window in seconds.
     * @param _maxTwapDeviationTicks Initial spot-vs-TWAP deviation ceiling, in ticks.
     */
    constructor(
        address _positionManager,
        address _pool,
        address _token0,
        address _token1,
        uint24 _fee,
        address _swapRouter,
        address _initialOwner,
        uint32 _twapWindow,
        uint24 _maxTwapDeviationTicks
    ) Ownable(_initialOwner) TwapGuard(_pool, _twapWindow, _maxTwapDeviationTicks) {
        if (_positionManager == address(0) || _swapRouter == address(0)) revert ZeroAddress();
        if (_token0 == address(0) || _token1 == address(0)) revert ZeroAddress();
        if (_token0 >= _token1) revert TokensNotSorted(_token0, _token1);

        // Deployment sanity: the configured triple must be the pool actually passed in.
        // Misconfiguring this would silently accept positions from the wrong market.
        IUniswapV3Pool poolRef = IUniswapV3Pool(_pool);
        if (poolRef.token0() != _token0 || poolRef.token1() != _token1 || poolRef.fee() != _fee) {
            revert PoolMismatch(poolRef.token0(), poolRef.token1(), poolRef.fee());
        }

        positionManager = INonfungiblePositionManager(_positionManager);
        swapRouter = ISwapRouter02(_swapRouter);
        token0 = _token0;
        token1 = _token1;
        fee = _fee;
    }

    // ──────────────────────── User functions ───────────────────

    /**
     * @notice Stakes a position NFT the caller already approved to this vault.
     * @dev Reverts while deposits are paused. The position must belong to the exact
     *      configured pool and hold non-zero liquidity.
     * @param tokenId The Uniswap V3 position NFT to stake.
     */
    function stake(uint256 tokenId) external nonReentrant {
        _stake(msg.sender, tokenId);
    }

    /**
     * @notice Stakes a position NFT in one transaction using an EIP-4494 NFT permit,
     *         with no prior approval transaction.
     * @dev The permit is submitted directly. A griefer who front-runs the signature
     *      consumes it and makes this call revert; the user can retry with `stake` after
     *      the front-run approval, which is still valid, so no funds are ever at risk.
     * @param tokenId The Uniswap V3 position NFT to stake.
     * @param deadline Permit expiry timestamp.
     * @param v Permit signature recovery id.
     * @param r Permit signature r value.
     * @param s Permit signature s value.
     */
    function stakeWithPermit(uint256 tokenId, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        nonReentrant
    {
        positionManager.permit(address(this), tokenId, deadline, v, r, s);
        _stake(msg.sender, tokenId);
    }

    /**
     * @notice Stakes a position NFT held by the whitelisted zapper and credits `user`
     *         as the staker.
     * @dev Only the zapper may call this. Custody is pulled from `msg.sender` (the zapper),
     *      which must have approved this vault for `tokenId`. Same pool validation and
     *      pause gate as `stake`.
     * @param user Address credited as the staker and entitled to unstake.
     * @param tokenId The Uniswap V3 position NFT to stake.
     */
    function stakeFor(address user, uint256 tokenId) external nonReentrant {
        address zapper_ = zapper;
        if (msg.sender != zapper_ || zapper_ == address(0)) revert NotZapper(msg.sender, zapper_);
        if (user == address(0)) revert ZeroAddress();
        _stake(user, tokenId);
    }

    /**
     * @notice Returns a staked position NFT to its staker.
     * @dev Permissionless by design: never gated by either pause switch, a signature, or
     *      backend liveness. Off-chain this is the early-exit signal.
     *
     *      The exit uses a plain `transferFrom`, not `safeTransferFrom`, and that is
     *      deliberate. The recipient is `msg.sender` — the recorded staker, who explicitly
     *      asked for the exit in this very call — so the NFT always lands back at the
     *      address that put it in. A `safeTransferFrom` would additionally demand an
     *      `onERC721Received` hook on that address: a contract staker without one could
     *      deposit (the receipt check on the deposit leg is on the vault, not on the
     *      depositor) but could never withdraw, and its position would be locked here
     *      forever. A plain transfer keeps the exit unconditional, as the header claims.
     * @param tokenId The staked position NFT to withdraw.
     */
    function unstake(uint256 tokenId) external nonReentrant {
        address staker = _stakers[tokenId];
        if (staker != msg.sender) revert NotStaker(tokenId, msg.sender, staker);

        delete _stakers[tokenId];

        positionManager.transferFrom(address(this), msg.sender, tokenId);

        emit Unstaked(msg.sender, tokenId, block.timestamp);
    }

    /**
     * @notice Atomically moves a staked position to a new range on the same pool.
     *
     * @dev Sequence, all in one transaction and without the NFT ever leaving custody:
     *      1. `decreaseLiquidity` the whole position, then `collect` everything owed —
     *         accrued trading fees are included and therefore **compound** into the new
     *         position rather than being paid out.
     *      2. Optional swap leg through SwapRouter02 when `swap.amountIn > 0`, guarded by
     *         the spot-vs-TWAP check.
     *      3. `mint` the new position on `[newTickLower, newTickUpper]` with the vault's
     *         whole token0/token1 balance as desired amounts.
     *      4. Refund every remaining token0/token1 wei to the staker.
     *      5. Burn the emptied old NFT.
     *      6. Move the staker record from the old tokenId to the new one.
     *
     *      Slippage: step 1 deliberately passes `amount0Min = amount1Min = 0`. Withdrawing
     *      the caller's own liquidity at spot cannot be sandwiched for profit in isolation,
     *      and the caller's real protection is applied where value can actually be lost —
     *      `swap.amountOutMin` on the swap and `swap.amount0Min` / `swap.amount1Min` on the
     *      mint, which together bound the round trip. Set them from a fresh quote.
     *
     *      Works while deposits are paused: re-ranging is part of exiting risk, not a deposit.
     *      It has its own switch instead — `setRebalancePaused` — because this is the most
     *      complex function in an immutable contract and a bug found after deploy needs a
     *      mitigation that is not "no mitigation at all". Pausing it never touches `unstake`:
     *      a staker locked out of re-ranging can always take the NFT out and manage it on
     *      Uniswap directly.
     *      No cooldown — gas, swap fees and slippage all fall on the caller, and abusive
     *      patterns are neutralized in off-chain scoring instead of in the contract.
     *
     * @param tokenId Currently staked position NFT.
     * @param newTickLower Lower tick of the new range.
     * @param newTickUpper Upper tick of the new range.
     * @param swap Swap leg and mint minimums, see {SwapParams}. `amountIn == 0` skips the swap.
     * @param deadline Expiry passed to `decreaseLiquidity` and `mint`.
     * @return newTokenId The freshly minted position NFT, now staked under the same staker.
     */
    function rebalance(
        uint256 tokenId,
        int24 newTickLower,
        int24 newTickUpper,
        SwapParams calldata swap,
        uint256 deadline
    ) external nonReentrant returns (uint256 newTokenId) {
        if (rebalancePaused) revert RebalanceIsPaused();

        address staker = _stakers[tokenId];
        if (staker != msg.sender) revert NotStaker(tokenId, msg.sender, staker);

        _withdrawAll(tokenId, deadline);

        if (swap.amountIn > 0) {
            _executeSwap(swap);
        }

        uint128 newLiquidity;
        (newTokenId, newLiquidity) = _mintPosition(newTickLower, newTickUpper, swap, deadline);

        // Effects before the remaining interactions: the record moves to the new NFT and
        // the old id becomes unstakeable in the same breath.
        delete _stakers[tokenId];
        _stakers[newTokenId] = staker;

        (uint256 refund0, uint256 refund1) = _refundDust(staker);

        // The old NFT is empty (zero liquidity, zero owed) after step 1, so it can be
        // burned. Burning keeps custody clean: no dead NFTs accumulate in the vault and
        // no stale tokenId can ever be confused for a live stake.
        positionManager.burn(tokenId);

        emit Rebalanced(
            staker,
            tokenId,
            newTokenId,
            newTickLower,
            newTickUpper,
            newLiquidity,
            refund0,
            refund1,
            block.timestamp
        );
    }

    // ──────────────────────── ERC-721 receiver ─────────────────

    /**
     * @notice ERC-721 receipt hook. Accepts position NFTs only from the configured
     *         position manager and only inside a stake, stakeFor or rebalance flow.
     * @dev Unsolicited transfers revert, so the vault can never end up holding an NFT
     *      with no staker record behind it.
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
     * @notice Retunes the spot-vs-TWAP guard used by `rebalance`.
     * @param window New TWAP window in seconds (MIN_TWAP_WINDOW..MAX_TWAP_WINDOW).
     * @param maxDeviationTicks New deviation ceiling in ticks (0 < x <= MAX_TWAP_DEVIATION_TICKS).
     */
    function setTwapParams(uint32 window, uint24 maxDeviationTicks) external onlyOwner {
        _setTwapParams(window, maxDeviationTicks);
    }

    /**
     * @notice Pauses or resumes new deposits.
     * @dev Gates `stake`, `stakeWithPermit` and `stakeFor` only. `unstake` and `rebalance`
     *      stay available; `rebalance` has its own switch, see {setRebalancePaused}.
     *
     *      This is also the zap kill switch. `LPZapper.zapIn` ends in `stakeFor`, so the
     *      whole zap reverts with {DepositsArePaused} while this is on — the zapper needs
     *      no pause state of its own.
     * @param paused True to block new deposits.
     */
    function setDepositsPaused(bool paused) external onlyOwner {
        depositsPaused = paused;
        emit DepositsPausedSet(paused);
    }

    /**
     * @notice Pauses or resumes `rebalance`.
     * @dev The incident switch for the one complex path in an immutable contract. It gates
     *      `rebalance` and nothing else: `unstake` stays open at all times, so a paused
     *      rebalance never traps a position — the staker withdraws the NFT and re-ranges it
     *      on Uniswap directly.
     * @param paused True to block `rebalance`.
     */
    function setRebalancePaused(bool paused) external onlyOwner {
        rebalancePaused = paused;
        emit RebalancePausedSet(paused);
    }

    /**
     * @notice Sets the single address allowed to call `stakeFor`.
     * @dev The zapper is replaceable periphery; set to the zero address to disable the
     *      path entirely.
     * @param newZapper New zapper address, or zero to disable.
     */
    function setZapper(address newZapper) external onlyOwner {
        emit ZapperSet(zapper, newZapper);
        zapper = newZapper;
    }

    /**
     * @notice Recovers a position NFT the vault holds with no staker behind it.
     *
     * @dev Restricted to `_stakers[tokenId] == address(0)`, and that single condition is
     *      what makes the function safe. **A position in legitimate custody always carries
     *      a staker record.** Every path that takes an NFT in writes the record in the same
     *      transaction: `_stake` sets it before pulling custody, and `rebalance` moves it
     *      from the old id to the new one. Every path that gives an NFT up clears the record
     *      in the same transaction: `unstake` deletes it before transferring out, and
     *      `rebalance` deletes the old id before burning it. Record and custody are created
     *      and destroyed together, so a zero record on an NFT the vault owns can only mean
     *      the NFT arrived without going through a stake path — which is exactly what this
     *      function exists to undo. A staked position is unreachable here by construction,
     *      no matter who the owner is.
     *
     *      `onERC721Received` already rejects safe transfers arriving outside a stake flow,
     *      but a plain `transferFrom` never consults the hook, so an NFT can still be pushed
     *      in by mistake and would otherwise stay here forever.
     *
     *      `nonReentrant` closes the one window where the invariant is momentarily open:
     *      inside `rebalance`, between the `mint` and the `_stakers[newTokenId] = staker`
     *      write, the vault owns a new NFT that has no record yet, and between that write
     *      and the `burn` it owns an old NFT whose record has just been cleared. Sharing the
     *      reentrancy guard with `stake`, `unstake` and `rebalance` means this call can
     *      never execute inside one of them.
     *
     *      The destination is `owner()` rather than a caller-supplied address, matching
     *      `RewardsDistributor.recoverExcessAsset`. A position NFT is unique and a mistyped
     *      recipient is unrecoverable, so the recovery path offers no place to mistype one;
     *      the owner multisig forwards it to the rightful holder off-chain. A plain
     *      `transferFrom` is used for the same reason {unstake} uses one — a multisig
     *      without an `onERC721Received` hook must not be locked out of its own recovery
     *      path.
     * @param tokenId Unrecorded position NFT held by this vault.
     */
    function rescuePosition(uint256 tokenId) external onlyOwner nonReentrant {
        address staker = _stakers[tokenId];
        if (staker != address(0)) revert PositionIsStaked(tokenId, staker);

        address to = owner();
        positionManager.transferFrom(address(this), to, tokenId);

        emit PositionRescued(tokenId, to, block.timestamp);
    }

    // ──────────────────────── View functions ───────────────────

    /**
     * @notice Staker credited with a position NFT.
     * @param tokenId The position NFT.
     * @return The staker address, or zero when the NFT is not staked here.
     */
    function stakerOf(uint256 tokenId) external view returns (address) {
        return _stakers[tokenId];
    }

    // ──────────────────────── Internal helpers ─────────────────

    /// @dev Shared body of every stake path. Validates the position, records the staker,
    ///      then pulls custody from `msg.sender`.
    function _stake(address user, uint256 tokenId) internal {
        if (depositsPaused) revert DepositsArePaused();

        address existing = _stakers[tokenId];
        if (existing != address(0)) revert AlreadyStaked(tokenId, existing);

        (int24 tickLower, int24 tickUpper, uint128 liquidity) = _validatePosition(tokenId);

        _stakers[tokenId] = user;

        _receiveGuard = RECEIVING;
        positionManager.safeTransferFrom(msg.sender, address(this), tokenId);
        _receiveGuard = NOT_RECEIVING;

        emit Staked(user, tokenId, tickLower, tickUpper, liquidity, block.timestamp);
    }

    /// @dev Rejects positions from any other pool and empty positions.
    function _validatePosition(uint256 tokenId)
        internal
        view
        returns (int24 tickLower, int24 tickUpper, uint128 liquidity)
    {
        address positionToken0;
        address positionToken1;
        uint24 positionFee;
        (, , positionToken0, positionToken1, positionFee, tickLower, tickUpper, liquidity, , , , ) =
            positionManager.positions(tokenId);

        if (positionToken0 != token0 || positionToken1 != token1 || positionFee != fee) {
            revert PositionPoolMismatch(tokenId, positionToken0, positionToken1, positionFee);
        }
        if (liquidity == 0) revert EmptyPosition(tokenId);
    }

    /// @dev Empties a position: burns all its liquidity, then collects principal + fees
    ///      into the vault. Leaves the NFT alive but with zero liquidity and zero owed.
    function _withdrawAll(uint256 tokenId, uint256 deadline) internal {
        (, , , , , , , uint128 liquidity, , , , ) = positionManager.positions(tokenId);

        if (liquidity > 0) {
            positionManager.decreaseLiquidity(
                INonfungiblePositionManager.DecreaseLiquidityParams({
                    tokenId: tokenId,
                    liquidity: liquidity,
                    amount0Min: 0,
                    amount1Min: 0,
                    deadline: deadline
                })
            );
        }

        positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
    }

    /// @dev TWAP-guarded exact-input swap between the pool's two tokens.
    ///      Approvals are exact and reset to zero afterwards; `forceApprove` is used so
    ///      USDC-style tokens that require a 0 allowance before a new one still work.
    ///      SwapRouter02's `ExactInputSingleParams` carries no deadline — the caller's
    ///      deadline is enforced by `decreaseLiquidity` and `mint` in the same transaction.
    function _executeSwap(SwapParams calldata swap) internal {
        _checkTwapDeviation();

        (address tokenIn, address tokenOut) = swap.zeroForOne ? (token0, token1) : (token1, token0);

        uint256 balance = IERC20(tokenIn).balanceOf(address(this));
        if (swap.amountIn > balance) revert SwapAmountExceedsBalance(tokenIn, swap.amountIn, balance);

        IERC20(tokenIn).forceApprove(address(swapRouter), swap.amountIn);
        swapRouter.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: fee,
                recipient: address(this),
                amountIn: swap.amountIn,
                amountOutMinimum: swap.amountOutMin,
                sqrtPriceLimitX96: 0
            })
        );
        IERC20(tokenIn).forceApprove(address(swapRouter), 0);
    }

    /// @dev Mints a new position on the configured pool using the vault's whole balance
    ///      of both tokens as desired amounts, with the caller's minimums enforced.
    ///
    ///      Whole balance, not the amount this rebalance just withdrew, and that is
    ///      deliberate. The vault is drained of both tokens at the end of every rebalance,
    ///      so a token0/token1 balance sitting here beforehand can only be a misdirected
    ///      transfer; it joins this mint and whatever the mint leaves over is refunded to
    ///      this rebalancer. Only misdirected funds are ever at stake — staked value lives
    ///      inside the position NFTs and no stray balance can reach it. Tracking per-call
    ///      amounts instead would buy no protection for stakers and would strand the dust
    ///      on every pass. Other tokens have no such path and are recovered by the owner.
    function _mintPosition(int24 tickLower, int24 tickUpper, SwapParams calldata swap, uint256 deadline)
        internal
        returns (uint256 tokenId, uint128 liquidity)
    {
        uint256 amount0 = IERC20(token0).balanceOf(address(this));
        uint256 amount1 = IERC20(token1).balanceOf(address(this));

        IERC20(token0).forceApprove(address(positionManager), amount0);
        IERC20(token1).forceApprove(address(positionManager), amount1);

        // The canonical position manager uses `_mint`, not `_safeMint`, so no receipt hook
        // fires here. The guard is opened anyway so the flow stays correct against any
        // position manager that does call back.
        _receiveGuard = RECEIVING;
        (tokenId, liquidity, , ) = positionManager.mint(
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

    /// @dev Sends every remaining token0/token1 wei to `to`. The vault is designed to hold
    ///      no fungible balance between transactions. Whole balance by design, the mirror
    ///      image of {_mintPosition}: a stray token0/token1 balance leaves with the next
    ///      rebalancer. See that function's note for why that trade is the intended one.
    function _refundDust(address to) internal returns (uint256 amount0, uint256 amount1) {
        amount0 = IERC20(token0).balanceOf(address(this));
        if (amount0 > 0) IERC20(token0).safeTransfer(to, amount0);

        amount1 = IERC20(token1).balanceOf(address(this));
        if (amount1 > 0) IERC20(token1).safeTransfer(to, amount1);
    }
}
