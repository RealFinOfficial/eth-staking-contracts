// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.38;

import "../interfaces/IUniswapV3Pool.sol";

/**
 * @title OracleHistory
 * @notice The configuration-time check that a Uniswap V3 pool can serve a TWAP window, now and
 *         for as long as the window stays configured (audit L-04, the rule approved by krumbgf
 *         on 27 Oct 2026).
 *
 *  `observe([window, 0])` reverts only with `OLD`, when the stored history is shorter than the
 *  window. Three facts make that preventable when the window is SET rather than when it is read:
 *    - a pool's `observationCardinality` never decreases, and a pool has no admin;
 *    - a pool writes at most one observation per block;
 *    - blocks are at least {MIN_SECONDS_PER_SLOT} seconds apart (Ethereum: 12 s, halved here).
 *
 *  So if, when a window `w` is set, (a) `observe([w, 0])` succeeds and (b) the CURRENT
 *  `observationCardinality` is at least `ceil(w / 6) + 1`, then `observe(w)` cannot revert
 *  afterwards: the stored observations always span at least `w` seconds.
 *
 *  The CURRENT cardinality (slot0 field 4) is read, NOT `observationCardinalityNext`: grown
 *  slots are used only after the pool's index wraps the old buffer. Until then the old buffer
 *  keeps overwriting itself, and with a trade in every block its coverage can drop below `w`
 *  (150 slots cover only 1788 s in the worst case, under 1800 s).
 *
 *  It is called from every place that sets a window ({TwapGuard-_setTwapParams}, which covers
 *  `initialize` and `setTwapParams` of the vault and the zapper, and the ApeBond adapter's
 *  valuation window). The READ paths fail closed: {meanTick} has no try/catch fallback.
 *
 *  The library also holds the two things every window user shares: the window bounds
 *  ({MIN_WINDOW}, {MAX_WINDOW}; `TwapGuard.MIN_TWAP_WINDOW` / `MAX_TWAP_WINDOW` and the adapter's
 *  valuation window read them from here, because Solidity does not let one contract read another
 *  contract's constant by type name) and the one mean-tick computation ({meanTick}).
 */
library OracleHistory {
    /// Conservative block time: today's 12 s halved, so the guarantee survives 6 s slots.
    uint256 internal constant MIN_SECONDS_PER_SLOT = 6;

    /// Shortest window any LP contract may configure, in seconds.
    uint32 internal constant MIN_WINDOW = 300;
    /// Longest window any LP contract may configure, in seconds. One hour.
    uint32 internal constant MAX_WINDOW = 3600;

    error HistoryTooShort(uint32 window);
    error CardinalityTooLow(uint16 cardinality, uint256 needed);

    /// Reverts unless `pool` can serve `observe([window, 0])` now AND forever after.
    function requireServes(IUniswapV3Pool pool, uint32 window) internal view {
        uint256 needed = (uint256(window) + MIN_SECONDS_PER_SLOT - 1) / MIN_SECONDS_PER_SLOT + 1;
        (,,, uint16 cardinality,,,) = pool.slot0();
        if (cardinality < needed) revert CardinalityTooLow(cardinality, needed);

        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = window;
        try pool.observe(secondsAgos) returns (int56[] memory, uint160[] memory) {}
        catch {
            revert HistoryTooShort(window);
        }
    }

    /// Arithmetic-mean tick over `window` from `pool.observe([window, 0])`, rounded toward
    /// negative infinity (Uniswap's own OracleLibrary convention). Reverts with the pool's own
    /// error when the pool cannot serve the window: no fallback.
    function meanTick(IUniswapV3Pool pool, uint32 window) internal view returns (int24 tick) {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = window;
        secondsAgos[1] = 0;

        (int56[] memory tickCumulatives,) = pool.observe(secondsAgos);

        int56 tickDelta = tickCumulatives[1] - tickCumulatives[0];
        int56 windowSigned = int56(uint56(window));

        tick = int24(tickDelta / windowSigned);
        // Solidity truncates toward zero; the oracle convention floors.
        if (tickDelta < 0 && tickDelta % windowSigned != 0) {
            tick--;
        }
    }
}
