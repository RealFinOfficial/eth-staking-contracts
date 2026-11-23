// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.38;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";

import "../lp-staking/interfaces/INonfungiblePositionManager.sol";
import "../lp-staking/interfaces/ISwapRouter02.sol";
import "../lp-staking/libraries/OracleHistory.sol";
import "../lp-staking/libraries/TickMath.sol";
import "../lp-staking/libraries/TwapGuard.sol";
import "./interfaces/IStakingV3.sol";
import "./interfaces/ITransition.sol";

/// @dev What the migrator reads from, and calls on, the `LPStakingVault` proxy.
interface IMigratorLpVault {
    function stakeFor(address user, uint256 tokenId) external;

    function stakerOf(uint256 tokenId) external view returns (address);

    function positionManager() external view returns (address);

    function swapRouter() external view returns (address);

    function pool() external view returns (address);

    function token0() external view returns (address);

    function token1() external view returns (address);

    function fee() external view returns (uint24);

    function guardian() external view returns (address);

    function operator() external view returns (address);
}

/// @dev The one pool read the band needs beyond {IUniswapV3Pool}.
interface IMigratorPoolSpacing {
    function tickSpacing() external view returns (int24);
}

/**
 * @title StakingMigratorBase
 * @notice What the `StakingMigrator` and its delivery module `StakingMigratorDeliveries` share: the
 *         storage (ERC-7201 namespace `real.staking.storage.StakingMigrator`), the market immutables,
 *         the events and errors, the two previews, the delivery voucher digest and the helpers that
 *         trade, mint and stake. Split out on 2026-11-20 because the migrator with the three delivery
 *         entries did not fit the 24,576-byte code size limit (EIP-170, enforced on Ethereum and on
 *         Avalanche C-Chain alike): the entries' bodies live in the module, which the migrator runs
 *         with `delegatecall` in the proxy's context, so they read and write this same storage.
 *
 *  Nothing here has a storage variable outside the namespaces, so the split moves no slot.
 */
abstract contract StakingMigratorBase is Initializable, EIP712Upgradeable, ReentrancyGuardTransient, TwapGuard {
    using SafeERC20 for IERC20;

    // ──────────────────────── Types ────────────────────────────

    /// @notice A holder's transition deliveries (spec 01 §9.4.2).
    struct Delivery {
        /// The holder's route, written by the first delivery and never changed.
        uint8 route;
        /// True once route 2 created its one position.
        bool lpCreated;
        /// The one position of route 2.
        uint256 lpTokenId;
        /// $ASSET taken by all deliveries so far.
        uint256 principalDelivered;
        /// USDC taken by all deliveries so far (route 2: the refunded dust included).
        uint256 rewardDelivered;
        /// The number of deliveries so far; the nonce the next voucher must carry.
        uint256 nextNonce;
    }

    // ──────────────────────── Constants ────────────────────────

    uint8 public constant ROUTE_COMPOUND = 1;
    uint8 public constant ROUTE_LP = 2;
    uint8 public constant ROUTE_RESTAKE = 3;

    uint16 public constant BPS = 10_000;

    /// @notice The recommended band's half-width: ln(2) / ln(1.0001) = 6931.47, rounded up. Below
    ///         the spot tick that is -50 % of the price, above it +100 %.
    int24 public constant LP_RANGE_TICKS = 6932;

    bytes32 public constant TRANSITION_VOUCHER_TYPEHASH = keccak256(
        "TransitionVoucher(address user,uint8 route,uint256 eligiblePrincipal,uint256 eligibleReward,uint256 nonce,uint256 deadline)"
    );

    bytes32 public constant DELIVERY_VOUCHER_TYPEHASH = keccak256(
        "DeliveryVoucher(address holder,uint8 route,uint256 eligiblePrincipal,uint256 eligibleReward,uint256 assetLimit,uint256 usdcLimit,uint256 burnTime,uint256 nonce,uint256 deadline)"
    );

    /// @notice The highest swap limit {setSwapLimitBps} accepts (10 %).
    uint16 public constant MAX_SWAP_LIMIT_BPS = 1000;

    /// @dev The swap limit {initializeTransition} starts with (3 %).
    uint16 internal constant INITIAL_SWAP_LIMIT_BPS = 300;

    // ──────────────────────── Immutables ───────────────────────

    IMigratorLpVault public immutable lpVault;
    INonfungiblePositionManager public immutable positionManager;
    ISwapRouter02 public immutable swapRouter;
    address public immutable usdc;
    address public immutable asset;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    bool public immutable assetIsToken0;

    // ──────────────────────── Storage ──────────────────────────

    /// @custom:storage-location erc7201:real.staking.storage.StakingMigrator
    struct MigratorStorage {
        address stakingPool;
        address bonusVault;
        address signer;
        uint16 compoundBps;
        uint16 lpBps;
        uint16 restakeBps;
        bool compoundPaused;
        uint32 valuationWindow;
        mapping(address => mapping(uint256 => bool)) usedNonces;
        /// One transition per wallet: set by the first successful route call.
        mapping(address => bool) migrated;
        // ── appended 2026-11-20 (the transition deliveries); nothing above moves ──
        /// The only caller of the three delivery entries; zero closes them.
        address transitionReceiver;
        /// Route 1 deliveries: the swap may return at most this much less than the TWAP value.
        uint16 swapLimitBps;
        mapping(address => Delivery) deliveries;
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("real.staking.storage.StakingMigrator")) - 1)) & ~0xff
    bytes32 private constant MIGRATOR_STORAGE = 0xa846ed032583543a4fbe67f8b477f1a29883d2f8c76050d7d3635994b7226e00;

    function _migratorStorage() internal pure returns (MigratorStorage storage $) {
        assembly {
            $.slot := MIGRATOR_STORAGE
        }
    }

    // ──────────────────────── Events ───────────────────────────

    event Compounded(
        address indexed user, uint256 principal, uint256 usdcIn, uint256 assetBought, uint256 staked, uint256 bonus
    );
    event MovedToLp(
        address indexed user,
        uint256 indexed tokenId,
        uint256 usdcIn,
        uint256 assetToLp,
        uint256 restaked,
        uint256 lpBonus,
        uint256 v3Bonus
    );
    event ClaimRestaked(address indexed user, uint256 principal, uint256 bonus);
    event CompoundPaused(address by);
    event CompoundUnpaused(address by);
    event RatesSet(uint16 compoundBps, uint16 lpBps, uint16 restakeBps);
    /// @notice A voucher nonce was spent (one per route call).
    event VoucherUsed(address indexed user, uint256 nonce, uint8 route);
    /// @notice USDC the position did not take, sent back to the caller by {moveToLp}.
    event UsdcRefunded(address indexed user, uint256 amount);
    event SignerSet(address previousSigner, address newSigner);
    event ValuationWindowSet(uint32 window);
    event TransitionReceiverSet(address previous, address next);
    event SwapLimitSet(uint16 previous, uint16 next);
    /// @notice A delivery voucher was spent (one per delivery).
    event DeliveryVoucherUsed(address indexed holder, uint256 nonce, uint8 route, uint256 burnTime);
    /// @notice One delivery of the transition (any of the three delivery entries).
    event TransitionDelivered(
        address indexed holder,
        uint8 indexed route,
        uint256 nonce,
        uint256 burnTime,
        uint256 assetIn,
        uint256 usdcIn,
        uint256 assetBought,
        uint256 staked,
        uint256 lpTokenId,
        uint256 lpBonus,
        uint256 v3Bonus
    );

    // ──────────────────────── Errors ───────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error TokenPairMismatch(address usdc, address asset, address token0, address token1);
    error InvalidRate(uint16 bps);
    error InvalidValuationWindow(uint32 window, uint32 minWindow, uint32 maxWindow);
    error CompoundIsPaused();
    error DeadlineExpired(uint256 deadline, uint256 blockTimestamp);
    error WrongRoute(uint8 expected, uint8 voucherRoute);
    error VoucherExpired(uint256 deadline, uint256 blockTimestamp);
    error VoucherNonceUsed(address user, uint256 nonce);
    error InvalidVoucherSignature();
    error PrincipalExceedsEligible(uint256 amount, uint256 eligible);
    error RewardExceedsEligible(uint256 amount, uint256 eligible);
    error NotOperator(address caller, address operator);
    error NotGuardianOrOperator(address caller, address guardian, address operator);
    error RenounceDisabled();
    error AlreadyMigrated(address user);
    error MinAssetOutZero();
    error CustodyAssertFailed(uint256 tokenId, address owner, address staker);
    error NotTransitionReceiver(address caller, address receiver);
    error StakingEnded(uint256 endEpoch);
    error InvalidDeliveryLimits(uint256 assetLimit, uint256 eligiblePrincipal, uint256 usdcLimit, uint256 eligibleReward);
    error InvalidBurnTime(uint256 burnTime);
    error RouteMismatch(address holder, uint8 storedRoute, uint8 route);
    error DeliveryNonceMismatch(address holder, uint256 expected, uint256 given);
    error UsdcNotArrived();
    error AssetNotArrived();
    error UsdcNotAccepted();
    error MatchingAssetNotArrived(uint256 needed, uint256 arrived);
    error UsdcBelowVoucher(uint256 required, uint256 delivered);
    error InvalidSwapLimit(uint16 bps, uint16 maxBps);

    // ──────────────────────── Constructor ──────────────────────

    /**
     * @notice Deploys the IMPLEMENTATION. Its market references are read from the LP vault and kept
     *         `immutable`, exactly like the zapper's.
     * @param lpVault_ The `LPStakingVault` proxy.
     * @param usdc_ USDC; one of the vault pool's two tokens.
     * @param asset_ $ASSET; the other one.
     * @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
     */
    constructor(address lpVault_, address usdc_, address asset_) TwapGuard(IMigratorLpVault(lpVault_).pool()) {
        if (usdc_ == address(0) || asset_ == address(0)) revert ZeroAddress();
        IMigratorLpVault v = IMigratorLpVault(lpVault_);
        address token0_ = v.token0();
        address token1_ = v.token1();
        bool assetFirst = asset_ == token0_ && usdc_ == token1_;
        if (!assetFirst && !(asset_ == token1_ && usdc_ == token0_)) {
            revert TokenPairMismatch(usdc_, asset_, token0_, token1_);
        }

        lpVault = v;
        positionManager = INonfungiblePositionManager(v.positionManager());
        swapRouter = ISwapRouter02(v.swapRouter());
        usdc = usdc_;
        asset = asset_;
        fee = v.fee();
        tickSpacing = IMigratorPoolSpacing(address(pool)).tickSpacing();
        assetIsToken0 = assetFirst;

        _disableInitializers();
    }

    // ──────────────────────── Previews ─────────────────────────

    /// @notice The band {moveToLp} mints on right now: 6,932 ticks each side of the spot tick,
    ///         the lower edge rounded down and the upper edge up to the spacing, clamped to the usable range.
    function lpRange() public view returns (int24 tickLower, int24 tickUpper) {
        (, int24 currentTick,,,,,) = pool.slot0();
        int256 spacing = tickSpacing;
        tickLower = _clampToUsable(_floorToSpacing(int256(currentTick) - LP_RANGE_TICKS, spacing), spacing);
        tickUpper = _clampToUsable(_ceilToSpacing(int256(currentTick) + LP_RANGE_TICKS, spacing), spacing);
    }

    /// @notice `usdcAmount` valued in $ASSET at the mean tick of {valuationWindow}.
    function usdcInAsset(uint256 usdcAmount) public view returns (uint256) {
        int24 tick = OracleHistory.meanTick(pool, _migratorStorage().valuationWindow);
        uint256 sqrtP = TickMath.getSqrtRatioAtTick(tick);
        uint256 q96 = 1 << 96;
        // price = token1 per token0 = (sqrtP / 2^96)^2. USDC as token1 -> divide by it, as token0 -> multiply.
        return assetIsToken0
            ? Math.mulDiv(Math.mulDiv(usdcAmount, q96, sqrtP), q96, sqrtP)
            : Math.mulDiv(Math.mulDiv(usdcAmount, sqrtP, q96), sqrtP, q96);
    }

    /// @notice The EIP-712 digest the signer signs for one delivery of `holder`.
    function deliveryVoucherDigest(
        address holder,
        uint8 route,
        uint256 eligiblePrincipal,
        uint256 eligibleReward,
        uint256 assetLimit,
        uint256 usdcLimit,
        uint256 burnTime,
        uint256 nonce,
        uint256 deadline
    ) public view returns (bytes32) {
        // Two halves of the same 32-byte-word encoding: one `abi.encode` of all ten values does not
        // fit the stack without the IR pipeline.
        bytes memory head = abi.encode(DELIVERY_VOUCHER_TYPEHASH, holder, route, eligiblePrincipal, eligibleReward);
        return _hashTypedDataV4(
            keccak256(bytes.concat(head, abi.encode(assetLimit, usdcLimit, burnTime, nonce, deadline)))
        );
    }

    // ──────────────────────── Shared helpers ───────────────────

    function _checkDeadline(uint256 deadline) internal view {
        if (block.timestamp > deadline) revert DeadlineExpired(deadline, block.timestamp);
    }

    /// @dev USDC -> $ASSET on the vault's pool, guarded. Returns what the balance actually gained.
    function _swapUsdcForAsset(uint256 usdcAmount, uint256 minAssetOut) internal returns (uint256 bought) {
        _checkTwapDeviation();
        uint256 before = IERC20(asset).balanceOf(address(this));
        IERC20(usdc).forceApprove(address(swapRouter), usdcAmount);
        swapRouter.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: usdc,
                tokenOut: asset,
                fee: fee,
                recipient: address(this),
                amountIn: usdcAmount,
                amountOutMinimum: minAssetOut,
                sqrtPriceLimitX96: 0
            })
        );
        IERC20(usdc).forceApprove(address(swapRouter), 0);
        bought = IERC20(asset).balanceOf(address(this)) - before;
    }

    /// @dev The adapter's custody check after `vault.stakeFor`: the NFT is the vault's and the vault
    ///      credits it to `user` (the caller of {moveToLp}, the holder of {moveToLpFor}).
    function _assertCustody(uint256 tokenId, address user) internal view {
        address owner_ = positionManager.ownerOf(tokenId);
        address staker = lpVault.stakerOf(tokenId);
        if (owner_ != address(lpVault) || staker != user) revert CustodyAssertFailed(tokenId, owner_, staker);
    }

    /// @dev Mints on {lpRange} with the whole USDC and the whole $ASSET as the desired amounts; the
    ///      position manager takes the matching pair and leaves the rest here.
    function _mintBand(uint256 usdcAmount, uint256 assetAmount, uint256 amount0Min, uint256 amount1Min, uint256 deadline)
        internal
        returns (uint256 tokenId, uint256 usdcUsed, uint256 assetUsed)
    {
        INonfungiblePositionManager.MintParams memory params =
            _mintParams(usdcAmount, assetAmount, amount0Min, amount1Min, deadline);

        IERC20(params.token0).forceApprove(address(positionManager), params.amount0Desired);
        IERC20(params.token1).forceApprove(address(positionManager), params.amount1Desired);
        uint256 used0;
        uint256 used1;
        (tokenId,, used0, used1) = positionManager.mint(params);
        IERC20(params.token0).forceApprove(address(positionManager), 0);
        IERC20(params.token1).forceApprove(address(positionManager), 0);
        (assetUsed, usdcUsed) = assetIsToken0 ? (used0, used1) : (used1, used0);
    }

    function _mintParams(
        uint256 usdcAmount,
        uint256 assetAmount,
        uint256 amount0Min,
        uint256 amount1Min,
        uint256 deadline
    ) internal view returns (INonfungiblePositionManager.MintParams memory params) {
        (params.tickLower, params.tickUpper) = lpRange();
        if (assetIsToken0) {
            (params.token0, params.token1) = (asset, usdc);
            (params.amount0Desired, params.amount1Desired) = (assetAmount, usdcAmount);
        } else {
            (params.token0, params.token1) = (usdc, asset);
            (params.amount0Desired, params.amount1Desired) = (usdcAmount, assetAmount);
        }
        params.fee = fee;
        params.amount0Min = amount0Min;
        params.amount1Min = amount1Min;
        params.recipient = address(this);
        params.deadline = deadline;
    }

    /// @dev The shared end of route 2 (direct and delivered): the position's bonus under its tokenId,
    ///      the $ASSET the position did not take staked in v3 for `user` with its bonus, the USDC dust
    ///      refunded to `user`. Reads `r.lpTokenId`, `r.usdcToLp`, `r.assetToLp`; writes `r.staked`,
    ///      `r.lpBonus`, `r.v3Bonus`.
    function _settleLp(
        address user,
        uint256 usdcAmount,
        uint256 assetAmount,
        bool bonusOpen,
        ITransitionMigrator.DeliveryResult memory r
    ) internal {
        MigratorStorage storage $ = _migratorStorage();
        uint64 unlockAt = SafeCast.toUint64(IWeightedStakingPoolV3Migration($.stakingPool).endEpoch());

        if (bonusOpen) r.lpBonus = Math.mulDiv(r.assetToLp + usdcInAsset(r.usdcToLp), $.lpBps, BPS);
        if (r.lpBonus > 0) IV3BonusVaultReservations($.bonusVault).reserveLp(r.lpTokenId, user, r.lpBonus, unlockAt);

        r.staked = assetAmount - r.assetToLp;
        if (r.staked > 0) {
            _stakeV3(user, r.staked);
            if (bonusOpen) r.v3Bonus = Math.mulDiv(r.staked, $.lpBps, BPS);
            _reserve(user, r.v3Bonus, unlockAt, ROUTE_LP);
        }

        uint256 usdcDust = usdcAmount - r.usdcToLp;
        if (usdcDust > 0) {
            IERC20(usdc).safeTransfer(user, usdcDust);
            emit UsdcRefunded(user, usdcDust);
        }
    }

    /// @dev Stakes `amount` in v3 for `user` and returns the pool's end as the bonus unlock time.
    function _stakeV3(address user, uint256 amount) internal returns (uint64 unlockAt) {
        address stakingPool_ = _migratorStorage().stakingPool;
        IERC20(asset).forceApprove(stakingPool_, amount);
        IWeightedStakingPoolV3Migration(stakingPool_).stakeFor(user, amount);
        unlockAt = SafeCast.toUint64(IWeightedStakingPoolV3Migration(stakingPool_).endEpoch());
    }

    /// @dev A zero `amount` (a zero rate, rounding, or the 30-day rule) reserves nothing and does
    ///      not call the bonus vault.
    function _reserve(address user, uint256 amount, uint64 unlockAt, uint8 route) internal {
        if (amount == 0) return;
        IV3BonusVaultReservations(_migratorStorage().bonusVault).reserve(user, amount, unlockAt, route);
    }

    /// @dev The adapter's rounding: towards negative infinity on the spacing.
    function _floorToSpacing(int256 tick, int256 spacing) internal pure returns (int256 rounded) {
        rounded = tick - tick % spacing;
        if (rounded > tick) rounded -= spacing;
    }

    /// @dev The adapter's rounding: towards positive infinity on the spacing.
    function _ceilToSpacing(int256 tick, int256 spacing) internal pure returns (int256 rounded) {
        rounded = tick - tick % spacing;
        if (rounded < tick) rounded += spacing;
    }

    /// @dev The adapter's clamp into Uniswap's usable range, rounded inward to the spacing.
    function _clampToUsable(int256 tick, int256 spacing) internal pure returns (int24) {
        int256 maxUsable = int256(TickMath.MAX_TICK) - int256(TickMath.MAX_TICK) % spacing;
        int256 minUsable = int256(TickMath.MIN_TICK) - int256(TickMath.MIN_TICK) % spacing;
        if (tick > maxUsable) return SafeCast.toInt24(maxUsable);
        if (tick < minUsable) return SafeCast.toInt24(minUsable);
        return SafeCast.toInt24(tick);
    }
}
