// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LocalHarness} from "./LocalHarness.sol";

import {LPStakingVault} from "../../../contracts/lp-staking/LPStakingVault.sol";
import {BonusEscrow} from "../../../contracts/lp-staking/BonusEscrow.sol";
import {ApeBondPositionAdapter} from "../../../contracts/lp-staking/ApeBondPositionAdapter.sol";
import {PositionValue} from "../../../contracts/lp-staking/libraries/PositionValue.sol";
import {TickMath} from "../../../contracts/lp-staking/libraries/TickMath.sol";
import {MockSoulZapCaller} from "../../../contracts/lp-staking/mocks/MockSoulZapCaller.sol";
import {MockUniswapV3Pool} from "../../../contracts/lp-staking/mocks/MockUniswapV3Pool.sol";
import {MockMathPositionManager} from "../../../contracts/lp-staking/mocks/MockMathPositionManager.sol";
import {INonfungiblePositionManager} from "../../../contracts/lp-staking/interfaces/INonfungiblePositionManager.sol";

/**
 * @title ApeBondHarness
 * @notice The ApeBond route on top of {LocalHarness}: a {BonusEscrow} proxy and an
 *         {ApeBondPositionAdapter} wired to the local vault exactly as the deploy scripts' timelock
 *         batch wires them (`vault.setBonusEscrow`, `vault.setStakeOperator`, `escrow.setAdapter`),
 *         one campaign, and a {MockSoulZapCaller} permitted for it.
 *
 *  Two rungs:
 *    * {_deployApeBond} — the local vault on {MockPositionManager} (fake liquidity math), the pool
 *      mock at tick 0. The branch tier: every revert, every boundary, every event.
 *    * {_deployMathRung} — a SECOND vault proxy on {MockMathPositionManager} (real Uniswap V3
 *      liquidity math) and a pool mock at the B.3 document's price, $0.25 per ASSET, with its own
 *      escrow and adapter. The value tier: the loop, the two-rebalance withdrawal (P3), and the
 *      after-cliff orderings, through the REAL vault.
 *
 *  The harness is the owner of every contract (it stands in for the timelock) and `apeGuardian`
 *  is the adapter's guardian. The escrow starts EMPTY on both rungs: reservations do not need a
 *  balance (override O2), and a test that claims funds it first with {_fundEscrow}.
 */
abstract contract ApeBondHarness is LocalHarness {
    // ──────────────────────── The campaign ─────────────────────

    bytes32 internal constant CAMPAIGN = keccak256("apebond.campaign.1");
    bytes32 internal constant OTHER_CAMPAIGN = keccak256("apebond.campaign.2");
    /// @dev Local rung: a range on the 60-tick grid around the pool mock's tick 0.
    int24 internal constant CAMPAIGN_TICK_LOWER = -1200;
    int24 internal constant CAMPAIGN_TICK_UPPER = 1200;
    uint16 internal constant BONUS_BPS = 1_000; // 10 % of the position's value
    uint64 internal constant CLIFF = 30 days;
    uint256 internal constant MIN_BONUS = 1e18; // one whole $ASSET
    /// @dev Liquidity of a local-rung purchase: its value at tick 0 is ~1.2e23 ASSET wei.
    uint128 internal constant BUY_LIQUIDITY = 2e24;

    // ──────────────────────── The B.3 document's vector (math rung) ─────────

    /// @dev $0.25 per ASSET with ASSET = token0 (18 decimals) and USDC = token1 (6 decimals):
    ///      raw price 2.5e-13, floor(ln(2.5e-13) / ln(1.0001)).
    int24 internal constant PRICE_TICK = -290188;
    /// @dev 0.2000 - 0.3125 USDC per ASSET: 20,000 ASSET + 5,000 USDC = $10,000 at $0.25.
    int24 internal constant START_LOWER = -292419;
    int24 internal constant START_UPPER = -287956;
    /// @dev Rebalance 1: 0.1368 - 0.25075, the upper bound 30 ticks ($0.00075) above the price.
    int24 internal constant R1_LOWER = -296217;
    int24 internal constant R1_UPPER = -290158;
    /// @dev Rebalance 2: 0.24925 - 0.4569, the lower bound 30 ticks below the price.
    int24 internal constant R2_LOWER = -290218;
    int24 internal constant R2_UPPER = -284157;
    /// @dev The math rung runs on the 0.01 % tier, whose tick spacing is 1, so the document's
    ///      ranges — 30 ticks from the price — can be used exactly as written.
    uint24 internal constant MATH_FEE = 100;
    uint256 internal constant START_ASSET = 20_000e18;
    uint256 internal constant START_USDC = 5_000e6;

    // ──────────────────────── Local rung ───────────────────────

    BonusEscrow internal escrow;
    ApeBondPositionAdapter internal adapter;
    MockSoulZapCaller internal soulZap;
    address internal apeGuardian;

    // ──────────────────────── Math rung ────────────────────────

    MockUniswapV3Pool internal mathPool;
    MockMathPositionManager internal mathNpm;
    LPStakingVault internal mathVault;
    BonusEscrow internal mathEscrow;
    ApeBondPositionAdapter internal mathAdapter;
    MockSoulZapCaller internal mathSoulZap;

    // ──────────────────────── Builders ─────────────────────────

    /// @notice The local rung: the {LocalHarness} stack plus the ApeBond route, linked.
    function _deployApeBond() internal {
        _deployLocalStack();
        apeGuardian = makeAddr("apeGuardian");

        escrow = _deployBonusEscrowProxy(address(asset), address(vault), address(this), address(0));
        adapter =
            new ApeBondPositionAdapter(address(npmMock), address(vault), address(escrow), address(this), apeGuardian);
        soulZap = new MockSoulZapCaller();
        _link(vault, escrow, adapter);
        _openCampaign(adapter, soulZap, CAMPAIGN, CAMPAIGN_TICK_LOWER, CAMPAIGN_TICK_UPPER);
    }

    /// @notice The math rung, on top of the local one: a second vault on real liquidity math at
    ///         $0.25 per ASSET, with its own escrow, adapter and caller.
    function _deployMathRung() internal {
        mathPool = new MockUniswapV3Pool(token0, token1, MATH_FEE);
        mathPool.setTicks(PRICE_TICK, PRICE_TICK);
        mathPool.setSqrtPriceX96(TickMath.getSqrtRatioAtTick(PRICE_TICK));
        mathNpm = new MockMathPositionManager(address(mathPool));

        VaultProxyParams memory params = _vaultParams(
            address(mathNpm), address(mathPool), token0, token1, address(routerMock), address(this), MIN_TWAP_WINDOW, 500
        );
        params.fee = MATH_FEE;
        mathVault = _deployVaultProxy(params);
        mathEscrow = _deployBonusEscrowProxy(address(asset), address(mathVault), address(this), address(0));
        mathAdapter = new ApeBondPositionAdapter(
            address(mathNpm), address(mathVault), address(mathEscrow), address(this), apeGuardian
        );
        mathSoulZap = new MockSoulZapCaller();
        _link(mathVault, mathEscrow, mathAdapter);
        _openCampaign(mathAdapter, mathSoulZap, CAMPAIGN, START_LOWER, START_UPPER);

        // Headroom for every amount the double may owe beyond what it pulled (price moves, fees).
        asset.transfer(address(mathNpm), 1_000_000e18);
        usdcToken.transfer(address(mathNpm), 1_000_000e6);
    }

    /// @dev The deploy scripts' link batch, in its order: the vault reports to the escrow, the
    ///      adapter may `stakeFor`, the escrow takes reservations from the adapter.
    function _link(LPStakingVault v, BonusEscrow e, ApeBondPositionAdapter a) internal {
        v.setBonusEscrow(address(e));
        v.setStakeOperator(address(a), true);
        e.setAdapter(address(a));
    }

    function _openCampaign(ApeBondPositionAdapter a, MockSoulZapCaller caller, bytes32 id, int24 lower, int24 upper)
        internal
    {
        a.setSoulZapCaller(address(caller), true);
        a.setCampaign(id, _campaignConfig(lower, upper));
        a.setCampaignCaller(id, address(caller), true);
    }

    function _campaignConfig(int24 lower, int24 upper)
        internal
        pure
        returns (ApeBondPositionAdapter.CampaignConfig memory)
    {
        return ApeBondPositionAdapter.CampaignConfig({
            enabled: true,
            tickLower: lower,
            tickUpper: upper,
            bonusCliffSeconds: CLIFF,
            bonusBps: BONUS_BPS,
            minBonusAmount: MIN_BONUS
        });
    }

    // ──────────────────────── Local-rung purchases ─────────────

    /// @notice A campaign-range position held by the SoulZap double, its principal funded.
    function _mintForSoulZap(uint128 liquidity) internal returns (uint256 tokenId) {
        return _createPositionOn(
            address(soulZap), token0, token1, FEE, CAMPAIGN_TICK_LOWER, CAMPAIGN_TICK_UPPER, liquidity, P_ASSET, P_USDC
        );
    }

    /// @notice One purchase through the router: mint, then `depositFor(beneficiary)`.
    function _buy(address beneficiary, uint128 liquidity) internal returns (uint256 tokenId) {
        tokenId = _mintForSoulZap(liquidity);
        soulZap.deposit(adapter, address(npmMock), tokenId, CAMPAIGN, beneficiary);
    }

    /// @notice The bonus the adapter must compute for `liquidity` on the local campaign range.
    function _expectedBonus(uint128 liquidity) internal view returns (uint256 value, uint256 bonus) {
        value =
            PositionValue.valueAt(liquidity, CAMPAIGN_TICK_LOWER, CAMPAIGN_TICK_UPPER, poolMock.twapTick(), true);
        bonus = value * BONUS_BPS / 10_000;
        if (bonus < MIN_BONUS) bonus = 0;
    }

    // ──────────────────────── Math-rung purchases ──────────────

    /**
     * @notice The B.3 document's starting purchase: the SoulZap double mints 20,000 ASSET + 5,000
     *         USDC on 0.2000 - 0.3125 through the math position manager, then deposits it for
     *         `beneficiary` through the math adapter.
     */
    function _buyDocumentPosition(address beneficiary) internal returns (uint256 tokenId) {
        tokenId = _mathMint(address(mathSoulZap), START_LOWER, START_UPPER, START_ASSET, START_USDC);
        mathSoulZap.deposit(mathAdapter, address(mathNpm), tokenId, CAMPAIGN, beneficiary);
    }

    /// @notice A real-math position minted for `holder` from the harness's own tokens.
    function _mathMint(address holder, int24 lower, int24 upper, uint256 amount0, uint256 amount1)
        internal
        returns (uint256 tokenId)
    {
        asset.approve(address(mathNpm), amount0);
        usdcToken.approve(address(mathNpm), amount1);
        (tokenId,,,) = mathNpm.mint(_mintParams(lower, upper, amount0, amount1, holder));
    }

    function _mintParams(int24 lower, int24 upper, uint256 amount0, uint256 amount1, address recipient)
        private
        view
        returns (INonfungiblePositionManager.MintParams memory p)
    {
        p = INonfungiblePositionManager.MintParams({
            token0: token0,
            token1: token1,
            fee: MATH_FEE,
            tickLower: lower,
            tickUpper: upper,
            amount0Desired: amount0,
            amount1Desired: amount1,
            amount0Min: 0,
            amount1Min: 0,
            recipient: recipient,
            deadline: block.timestamp
        });
    }

    /// @notice The value of a math-rung position NFT at the pool's TWAP, in ASSET wei.
    function _mathValue(uint256 tokenId) internal view returns (uint256) {
        (,,,,, int24 lower, int24 upper, uint128 liquidity,,,,) = mathNpm.positions(tokenId);
        return PositionValue.valueAt(liquidity, lower, upper, mathPool.twapTick(), true);
    }

    // ──────────────────────── Funding ──────────────────────────

    /// @notice What the company does: transfer $ASSET into the escrow.
    function _fundEscrow(BonusEscrow e, uint256 amount) internal {
        asset.transfer(address(e), amount);
    }

    // ──────────────────────── Reading a reservation ────────────

    function _reservation(BonusEscrow e, uint256 tokenId)
        internal
        view
        returns (address beneficiary, uint256 amount, uint64 unlockAt, bool claimed, bool forfeited)
    {
        return e.reservationOf(tokenId);
    }
}
