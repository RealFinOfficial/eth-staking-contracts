// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IUniswapV3Pool.sol";

// ──────────────────────── Shared types ─────────────────────────

/**
 * @notice Caller-supplied swap leg for a rebalance or a zap.
 * @dev Declared at file level here — and not inside either contract — because
 *      `LPStakingVault` and `LPZapper` must speak the exact same calldata shape and both
 *      already depend on this file for {TwapGuard}. Keeping the type next to the guard
 *      avoids a periphery -> core type dependency.
 *
 *      The frontend computes the split; the contracts only enforce TWAP sanity plus the
 *      caller's own minimums. `amountIn == 0` skips the swap step entirely — and with it
 *      the TWAP guard, which is only ever consulted from inside the swap leg. That is
 *      deliberate (2026-08-26 review, recommendation 3): a no-swap range move must stay
 *      available at any price, so it is the fallback while the guard is tripped. The price
 *      of that is that with `amountIn == 0` the mint minimums are the ONLY protection on
 *      the mint — quote `amount0Min` / `amount1Min` tightly, as a share of the position's
 *      total value, from a fresh reading.
 * @param zeroForOne  Swap direction: true swaps token0 -> token1, false token1 -> token0.
 * @param amountIn    Exact input amount for the swap leg. Zero means "no swap".
 * @param amountOutMin Minimum acceptable swap output (caller slippage bound on the swap).
 * @param amount0Min  Minimum token0 the mint must consume (caller slippage bound on the mint).
 * @param amount1Min  Minimum token1 the mint must consume (caller slippage bound on the mint).
 */
struct SwapParams {
    bool zeroForOne;
    uint256 amountIn;
    uint256 amountOutMin;
    uint256 amount0Min;
    uint256 amount1Min;
}

/**
 * @title TwapGuard
 * @notice Shared spot-vs-TWAP deviation check for the LP staking stack.
 *
 *  Implemented as an abstract contract rather than a `library` on purpose: the guard owns
 *  mutable, owner-tunable parameters plus their change event, and a stateless library
 *  cannot hold those. Inheriting contracts get the immutable pool reference, the
 *  parameters, the event and the errors in one piece, and only have to expose their own
 *  `onlyOwner` setter (the guard deliberately knows nothing about access control).
 *
 *  The two parameters live in an ERC-7201 namespace rather than in ordinary slots, because
 *  one of the two inheritors — `LPStakingVault` — runs behind a UUPS proxy and every slot it
 *  owns has to be immune to what an upgrade does to the inheritance layout above it. The
 *  namespace costs the other inheritor — the non-upgradeable `LPZapper` — nothing: it is a
 *  fixed slot either way. The `pool` reference stays `immutable`, so it is bytecode on both.
 *
 *  The constructor therefore takes ONLY the pool. The parameters are seeded by whoever knows
 *  when it is safe to write storage: the zapper's own constructor, and the vault's
 *  `initialize` — an inline field initializer or a base constructor never runs behind a proxy.
 *
 *  Mechanics:
 *    - Arithmetic-mean tick over `twapWindow` from `pool.observe([window, 0])`.
 *    - Spot tick from `pool.slot0()`.
 *    - Revert when the absolute difference exceeds `maxTwapDeviationTicks`.
 *
 *  The deviation parameter IS a tick count. Nothing here converts anything: the value the
 *  owner stores is the value compared against the tick difference, and the only unit in the
 *  file is the tick. A tick is a 1.0001x price step and steps compound, so the price a tick
 *  count admits is `1.0001^n - 1`; the inverse, for an operator who wants to size the guard
 *  in basis points, is exact and belongs off-chain:
 *
 *      ticks(bps) = floor( ln(1 + bps / 1e4) / ln(1.0001) )
 *
 *       500 bps  ->  487 ticks
 *      1000 bps  ->  953 ticks   (the deployed default)
 *      2000 bps  -> 1823 ticks   (MAX_TWAP_DEVIATION_TICKS, the widest setting)
 *
 *  `scripts/deploy-lp-staking.js` applies exactly that formula to `LP_TWAP_MAX_DEVIATION_BPS`
 *  and logs both numbers, so the human-facing knob stays in bps while the contract stores
 *  ticks. The earlier version of this guard read the bps number itself as a tick count,
 *  which admitted up to ~11% more price movement than the number said; that is gone.
 *
 *  What this guard is for: it is a manipulation circuit breaker, not a pricing oracle and
 *  not a slippage bound. It caps the damage of one scenario — a compromised frontend feeding
 *  a user `amountOutMin ~ 0` on a position the vault custodies — and is deliberately set
 *  wide enough never to trip on ordinary volatility. The EXACT protection on every value
 *  step is the caller's own `amountOutMin` / `amount0Min` / `amount1Min`, computed off-chain
 *  from a fresh quote; those bound what can actually be lost regardless of where this guard
 *  sits. See `docs/reviews/spec-review-2026-08-26.md` (F3, F4) in the lp-staking docs repo.
 */
abstract contract TwapGuard {
    // ──────────────────────── Constants ────────────────────────

    /// @notice Shortest permitted TWAP window, in seconds.
    uint32 public constant MIN_TWAP_WINDOW = 300;
    /// @notice Longest permitted TWAP window, in seconds. One hour: long enough for any
    ///         sane circuit breaker, short enough that a pool can actually serve it, so a
    ///         single owner transaction can no longer brick both swap legs.
    uint32 public constant MAX_TWAP_WINDOW = 3600;
    /// @notice Widest permitted deviation, in ticks. 1823 = floor(ln 1.2 / ln 1.0001), i.e.
    ///         a 20% price move — the loosest the guard may ever be configured.
    uint24 public constant MAX_TWAP_DEVIATION_TICKS = 1823;

    // ──────────────────────── Immutables ───────────────────────

    /// @notice Uniswap V3 pool this contract reads its oracle from.
    /// @dev Implementation bytecode, not storage — see the note above.
    IUniswapV3Pool public immutable pool;

    // ──────────────────────── Storage ──────────────────────────

    /// @custom:storage-location erc7201:real.lp.storage.TwapGuard
    struct TwapGuardStorage {
        /// TWAP lookback window in seconds.
        uint32 twapWindow;
        /// Maximum tolerated spot-vs-TWAP deviation, in ticks.
        uint24 maxTwapDeviationTicks;
    }

    /**
     * @dev ERC-7201 slot for {TwapGuardStorage}, computed as
     *      `keccak256(abi.encode(uint256(keccak256("real.lp.storage.TwapGuard")) - 1)) & ~bytes32(uint256(0xff))`.
     *      Pinned as a literal so it can never move under an upgrade of the vault.
     *      `test/forge/unit/VaultBranches.t.sol` recomputes it and fails if it drifts.
     */
    bytes32 private constant TWAP_GUARD_STORAGE =
        0xd1f904d9e9754969ffa2d33531f67fbdbb15fde03cb30a2cfdee997f4aa0c300;

    function _twapGuardStorage() private pure returns (TwapGuardStorage storage $) {
        assembly {
            $.slot := TWAP_GUARD_STORAGE
        }
    }

    // ──────────────────────── Events ───────────────────────────

    /// @notice Emitted on deploy and on every parameter change, with the full new state.
    event TwapParamsSet(uint32 window, uint24 maxDeviationTicks);

    // ──────────────────────── Errors ───────────────────────────

    error InvalidPool();
    error InvalidTwapWindow(uint32 window, uint32 minWindow, uint32 maxWindow);
    error InvalidTwapDeviation(uint24 maxDeviationTicks, uint24 maxAllowedTicks);
    error TwapDeviationTooHigh(int24 currentTick, int24 twapTick, int24 maxDeviationTicks);

    // ──────────────────────── Constructor ──────────────────────

    /**
     * @param _pool Uniswap V3 pool used as the price oracle.
     * @dev The parameters are NOT set here. A constructor never runs against proxy storage,
     *      and this guard is inherited by one contract that has some — see the note above.
     *      Every inheritor must call {_setTwapParams} itself: the zapper from its own
     *      constructor, the vault from `initialize`.
     */
    constructor(address _pool) {
        if (_pool == address(0)) revert InvalidPool();
        pool = IUniswapV3Pool(_pool);
    }

    // ──────────────────────── Parameter views ──────────────────

    /// @notice TWAP lookback window in seconds.
    function twapWindow() public view returns (uint32) {
        return _twapGuardStorage().twapWindow;
    }

    /// @notice Maximum tolerated spot-vs-TWAP deviation, in ticks.
    function maxTwapDeviationTicks() public view returns (uint24) {
        return _twapGuardStorage().maxTwapDeviationTicks;
    }

    // ──────────────────────── Internal helpers ─────────────────

    /// @dev Bounds-checks and stores the TWAP parameters. Access control is the
    ///      inheriting contract's responsibility.
    function _setTwapParams(uint32 _window, uint24 _maxDeviationTicks) internal {
        if (_window < MIN_TWAP_WINDOW || _window > MAX_TWAP_WINDOW) {
            revert InvalidTwapWindow(_window, MIN_TWAP_WINDOW, MAX_TWAP_WINDOW);
        }
        if (_maxDeviationTicks == 0 || _maxDeviationTicks > MAX_TWAP_DEVIATION_TICKS) {
            revert InvalidTwapDeviation(_maxDeviationTicks, MAX_TWAP_DEVIATION_TICKS);
        }
        TwapGuardStorage storage $ = _twapGuardStorage();
        $.twapWindow = _window;
        $.maxTwapDeviationTicks = _maxDeviationTicks;
        emit TwapParamsSet(_window, _maxDeviationTicks);
    }

    /// @dev Arithmetic-mean tick over `twapWindow`, rounded toward negative infinity
    ///      (matching Uniswap's own OracleLibrary), plus the current spot tick.
    function _twapAndSpotTicks() internal view returns (int24 twapTick, int24 currentTick) {
        uint32 window = _twapGuardStorage().twapWindow;

        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = window;
        secondsAgos[1] = 0;

        (int56[] memory tickCumulatives, ) = pool.observe(secondsAgos);

        int56 tickDelta = tickCumulatives[1] - tickCumulatives[0];
        int56 windowSigned = int56(uint56(window));

        twapTick = int24(tickDelta / windowSigned);
        // Solidity truncates toward zero; the oracle convention floors.
        if (tickDelta < 0 && tickDelta % windowSigned != 0) {
            twapTick--;
        }

        (, currentTick, , , , , ) = pool.slot0();
    }

    /// @dev Reverts when spot has drifted further from the TWAP than the configured
    ///      ceiling allows. Called before every swap executed by this stack.
    function _checkTwapDeviation() internal view {
        (int24 twapTick, int24 currentTick) = _twapAndSpotTicks();

        // Safe: maxTwapDeviationTicks is bounded by MAX_TWAP_DEVIATION_TICKS (1823) << 2**23.
        int24 maxDeviationTicks = int24(_twapGuardStorage().maxTwapDeviationTicks);

        int24 deviation = currentTick - twapTick;
        if (deviation < 0) deviation = -deviation;

        if (deviation > maxDeviationTicks) {
            revert TwapDeviationTooHigh(currentTick, twapTick, maxDeviationTicks);
        }
    }

    // ──────────────────────── View functions ───────────────────

    /**
     * @notice Reads the guard inputs without reverting, so a frontend can pre-check a
     *         transaction instead of discovering the revert on submission.
     * @return currentTick Spot tick from `slot0`.
     * @return twapTick Arithmetic-mean tick over `twapWindow`.
     * @return maxDeviationTicks Configured ceiling, expressed in ticks.
     * @return withinBounds True when a swap would pass the guard right now.
     */
    function previewTwap()
        external
        view
        returns (int24 currentTick, int24 twapTick, int24 maxDeviationTicks, bool withinBounds)
    {
        (twapTick, currentTick) = _twapAndSpotTicks();
        maxDeviationTicks = int24(_twapGuardStorage().maxTwapDeviationTicks);

        int24 deviation = currentTick - twapTick;
        if (deviation < 0) deviation = -deviation;
        withinBounds = deviation <= maxDeviationTicks;
    }
}
