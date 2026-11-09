// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.38;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";

import "../lp-staking/interfaces/INonfungiblePositionManager.sol";
import "../lp-staking/interfaces/ISwapRouter02.sol";
import "../lp-staking/libraries/OracleHistory.sol";
import "../lp-staking/libraries/TickMath.sol";
import "../lp-staking/libraries/TwapGuard.sol";
import "./interfaces/IStakingV3.sol";

/// @dev What the migrator reads from, and calls on, the `LPStakingVault` proxy.
interface IMigratorLpVault {
    function stakeFor(address user, uint256 tokenId) external;

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
 * @title StakingMigrator
 * @notice The one-call transition from the closed $ASSET staking window (sw2, v2) into staking v3.
 *         The staker first calls `unstake()` on sw2 themselves (only they can: it pays principal and
 *         USDC reward to `msg.sender`), then ONE call here runs one of three routes:
 *
 *    1. {compound}: pulls the USDC reward and the $ASSET principal, swaps the USDC into $ASSET
 *       through SwapRouter02 `exactInputSingle` on the LP vault's pool under this contract's
 *       {TwapGuard}, stakes principal + bought $ASSET in the v3 pool FOR the caller, and reserves
 *       `compoundBps` of it in the bonus vault.
 *    2. {moveToLp}: pulls the USDC reward and the $ASSET principal, mints ONE position on the
 *       recommended band (6,932 ticks each side of the spot tick = -50 % / +100 % in price, rounded
 *       outward to the tick spacing; the ApeBond adapter's `_campaignRange` math) from the whole USDC
 *       and the matching $ASSET (the position manager takes what the band needs), stakes the NFT in
 *       the LP vault FOR the caller (`vault.stakeFor`; this contract is a stake operator), refunds
 *       the USDC dust, stakes the remaining $ASSET in v3 FOR the caller, and reserves `lpBps` of
 *       (LP $ASSET leg + LP USDC leg valued in $ASSET at the mean tick of {valuationWindow}) under
 *       the position's tokenId and `lpBps` of the v3 remainder for the caller. No top-up from the
 *       wallet, and no swap of $ASSET into USDC, ever.
 *    3. {claimRestake}: pulls only the $ASSET principal (the USDC stays in the wallet), stakes it in
 *       v3 FOR the caller and reserves `restakeBps` of it.
 *
 *  ELIGIBILITY. Only amounts that came out of a real sw2 claim earn a bonus. The backend attests
 *  them with an EIP-712 `TransitionVoucher(address user,uint8 route,uint256 eligiblePrincipal,
 *  uint256 eligibleReward,uint256 weight,uint256 nonce,uint256 deadline)` (domain "StakingMigrator"
 *  / "1", verifying contract = this proxy) signed by {signer}. Each route checks: the voucher names
 *  this route, `assetAmount <= eligiblePrincipal`, `usdcAmount <= eligibleReward`, the nonce is
 *  unused for the caller, the deadline has not passed, the signature. `weight` is passed through to
 *  the v3 pool as the caller's multiplier. `user` is always `msg.sender`.
 *
 *  PAUSE. Routes 1 and 2 trade against the pool, so they stop behind one switch while the pool has
 *  no liquidity: {pauseCompound} (the LP vault's guardian or operator, read live) and
 *  {unpauseCompound} (the operator only), the vault's pattern. The proxy is born paused. Route 3
 *  never trades and is never pausable.
 *
 *  Holds no funds between transactions; no ETH. Re-entrancy guarded; the voucher nonce is spent
 *  before any token moves.
 *
 *  ADMIN: owner (the timelock) — upgrades, {setRates}; operator (the LP vault's, read live) —
 *  {setSigner}, {setTwapParams}, {unpauseCompound}; guardian or operator — {pauseCompound}.
 */
contract StakingMigrator is
    Initializable,
    UUPSUpgradeable,
    Ownable2StepUpgradeable,
    EIP712Upgradeable,
    ReentrancyGuardTransient,
    TwapGuard
{
    using SafeERC20 for IERC20;

    // ──────────────────────── Types ────────────────────────────

    /// @notice An optional EIP-2612 permit. `deadline == 0` means "no permit, already approved".
    struct Permit {
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    /// @notice The backend's `TransitionVoucher` for the caller, with its signature.
    struct Voucher {
        uint8 route;
        uint256 eligiblePrincipal;
        uint256 eligibleReward;
        uint256 weight;
        uint256 nonce;
        uint256 deadline;
        bytes signature;
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
        "TransitionVoucher(address user,uint8 route,uint256 eligiblePrincipal,uint256 eligibleReward,uint256 weight,uint256 nonce,uint256 deadline)"
    );

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
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("real.staking.storage.StakingMigrator")) - 1)) & ~0xff
    bytes32 private constant MIGRATOR_STORAGE = 0xa846ed032583543a4fbe67f8b477f1a29883d2f8c76050d7d3635994b7226e00;

    function _migratorStorage() private pure returns (MigratorStorage storage $) {
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

    // ──────────────────────── Modifiers ────────────────────────

    modifier onlyVaultOperator() {
        address operator_ = lpVault.operator();
        if (msg.sender != operator_) revert NotOperator(msg.sender, operator_);
        _;
    }

    modifier onlyGuardianOrVaultOperator() {
        address guardian_ = lpVault.guardian();
        address operator_ = lpVault.operator();
        if (msg.sender != guardian_ && msg.sender != operator_) {
            revert NotGuardianOrOperator(msg.sender, guardian_, operator_);
        }
        _;
    }

    modifier whenCompoundOpen() {
        if (_migratorStorage().compoundPaused) revert CompoundIsPaused();
        _;
    }

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

    // ──────────────────────── Initializer ──────────────────────

    /**
     * @param owner_ The deployer while the deploy script wires the v3 contracts, then the timelock.
     * @param stakingPool_ The `WeightedStakingPoolV3` proxy.
     * @param bonusVault_ The `V3BonusVault` proxy.
     * @param signer_ The `TransitionVoucher` signer (the backend key).
     * @param twapWindow_ The swap guard's window (300 s, like the zapper).
     * @param maxDeviationTicks_ The swap guard's ceiling (953 ticks, like the zapper).
     * @param valuationWindow_ The window whose mean tick values the LP USDC leg (1,800 s, the
     *        adapter's); bounded to 300..3600 s and checked against the pool's history.
     * @dev Born with the compound routes PAUSED and the rates 1000 / 1000 / 500 bps.
     */
    function initialize(
        address owner_,
        address stakingPool_,
        address bonusVault_,
        address signer_,
        uint32 twapWindow_,
        uint24 maxDeviationTicks_,
        uint32 valuationWindow_
    ) external initializer {
        if (stakingPool_ == address(0) || bonusVault_ == address(0) || signer_ == address(0)) revert ZeroAddress();
        __Ownable_init(owner_);
        __Ownable2Step_init();
        __EIP712_init("StakingMigrator", "1");

        MigratorStorage storage $ = _migratorStorage();
        $.stakingPool = stakingPool_;
        $.bonusVault = bonusVault_;
        $.signer = signer_;
        $.compoundPaused = true;
        emit SignerSet(address(0), signer_);
        emit CompoundPaused(msg.sender);

        _setRates(1000, 1000, 500);
        _setTwapParams(twapWindow_, maxDeviationTicks_);

        if (valuationWindow_ < OracleHistory.MIN_WINDOW || valuationWindow_ > OracleHistory.MAX_WINDOW) {
            revert InvalidValuationWindow(valuationWindow_, OracleHistory.MIN_WINDOW, OracleHistory.MAX_WINDOW);
        }
        OracleHistory.requireServes(pool, valuationWindow_);
        $.valuationWindow = valuationWindow_;
        emit ValuationWindowSet(valuationWindow_);
    }

    // ──────────────────────── Routes ───────────────────────────

    /**
     * @notice Route 1: swap the USDC reward into $ASSET and stake everything in v3.
     * @param usdcAmount USDC pulled and swapped (<= the voucher's eligibleReward; > 0).
     * @param assetAmount $ASSET principal pulled (<= the voucher's eligiblePrincipal).
     * @param minAssetOut The swap's `amountOutMinimum`.
     * @param deadline The call's own expiry.
     * @return staked The amount staked in v3 for the caller.
     * @return bonus The v3 reservation added.
     */
    function compound(
        uint256 usdcAmount,
        uint256 assetAmount,
        uint256 minAssetOut,
        uint256 deadline,
        Permit calldata usdcPermit,
        Permit calldata assetPermit,
        Voucher calldata v
    ) external nonReentrant whenCompoundOpen returns (uint256 staked, uint256 bonus) {
        if (usdcAmount == 0) revert ZeroAmount();
        _checkDeadline(deadline);
        _useVoucher(ROUTE_COMPOUND, assetAmount, usdcAmount, v);

        _pull(usdc, usdcAmount, usdcPermit);
        if (assetAmount > 0) _pull(asset, assetAmount, assetPermit);

        uint256 bought = _swapUsdcForAsset(usdcAmount, minAssetOut);
        staked = assetAmount + bought;

        MigratorStorage storage $ = _migratorStorage();
        uint64 unlockAt = _stakeV3(msg.sender, staked, v.weight);
        bonus = Math.mulDiv(staked, $.compoundBps, BPS);
        _reserve(msg.sender, bonus, unlockAt, ROUTE_COMPOUND);

        emit Compounded(msg.sender, assetAmount, usdcAmount, bought, staked, bonus);
    }

    /**
     * @notice Route 2: one LP position on the recommended band from the whole USDC reward and the
     *         matching $ASSET, the rest of the $ASSET staked in v3.
     * @param usdcAmount USDC pulled (<= eligibleReward; > 0). What the position does not take is refunded.
     * @param assetAmount $ASSET principal pulled (<= eligiblePrincipal; > 0).
     * @param amount0Min The mint's token0 minimum.
     * @param amount1Min The mint's token1 minimum.
     * @param deadline The mint's deadline and the call's own expiry.
     * @return tokenId The position NFT, staked in the LP vault for the caller.
     */
    function moveToLp(
        uint256 usdcAmount,
        uint256 assetAmount,
        uint256 amount0Min,
        uint256 amount1Min,
        uint256 deadline,
        Permit calldata usdcPermit,
        Permit calldata assetPermit,
        Voucher calldata v
    ) external nonReentrant whenCompoundOpen returns (uint256 tokenId) {
        if (usdcAmount == 0 || assetAmount == 0) revert ZeroAmount();
        _checkDeadline(deadline);
        _useVoucher(ROUTE_LP, assetAmount, usdcAmount, v);

        _pull(usdc, usdcAmount, usdcPermit);
        _pull(asset, assetAmount, assetPermit);

        _checkTwapDeviation();
        uint256 usdcUsed;
        uint256 assetUsed;
        (tokenId, usdcUsed, assetUsed) = _mintBand(usdcAmount, assetAmount, amount0Min, amount1Min, deadline);

        positionManager.approve(address(lpVault), tokenId);
        lpVault.stakeFor(msg.sender, tokenId);

        _finishLp(tokenId, usdcAmount, usdcUsed, assetAmount, assetUsed, v.weight);
    }

    /**
     * @notice Route 3: stake the $ASSET principal in v3; the USDC reward stays in the wallet.
     * @param assetAmount $ASSET principal pulled (<= eligiblePrincipal; > 0).
     * @param deadline The call's own expiry.
     * @return bonus The v3 reservation added.
     */
    function claimRestake(uint256 assetAmount, uint256 deadline, Permit calldata assetPermit, Voucher calldata v)
        external
        nonReentrant
        returns (uint256 bonus)
    {
        if (assetAmount == 0) revert ZeroAmount();
        _checkDeadline(deadline);
        _useVoucher(ROUTE_RESTAKE, assetAmount, 0, v);

        _pull(asset, assetAmount, assetPermit);

        uint64 unlockAt = _stakeV3(msg.sender, assetAmount, v.weight);
        bonus = Math.mulDiv(assetAmount, _migratorStorage().restakeBps, BPS);
        _reserve(msg.sender, bonus, unlockAt, ROUTE_RESTAKE);

        emit ClaimRestaked(msg.sender, assetAmount, bonus);
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

    // ──────────────────────── Views ────────────────────────────

    function stakingPool() external view returns (address) {
        return _migratorStorage().stakingPool;
    }

    function bonusVault() external view returns (address) {
        return _migratorStorage().bonusVault;
    }

    function signer() external view returns (address) {
        return _migratorStorage().signer;
    }

    function compoundBps() external view returns (uint16) {
        return _migratorStorage().compoundBps;
    }

    function lpBps() external view returns (uint16) {
        return _migratorStorage().lpBps;
    }

    function restakeBps() external view returns (uint16) {
        return _migratorStorage().restakeBps;
    }

    function compoundPaused() external view returns (bool) {
        return _migratorStorage().compoundPaused;
    }

    function valuationWindow() external view returns (uint32) {
        return _migratorStorage().valuationWindow;
    }

    function isNonceUsed(address user, uint256 nonce) external view returns (bool) {
        return _migratorStorage().usedNonces[user][nonce];
    }

    /// @notice The EIP-712 digest the signer signs for `user`'s voucher.
    function voucherDigest(
        address user,
        uint8 route,
        uint256 eligiblePrincipal,
        uint256 eligibleReward,
        uint256 weight,
        uint256 nonce,
        uint256 deadline
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    TRANSITION_VOUCHER_TYPEHASH, user, route, eligiblePrincipal, eligibleReward, weight, nonce, deadline
                )
            )
        );
    }

    // ──────────────────────── Admin ────────────────────────────

    /// @notice Stops routes 1 and 2. The LP vault's guardian or operator.
    function pauseCompound() external onlyGuardianOrVaultOperator {
        _migratorStorage().compoundPaused = true;
        emit CompoundPaused(msg.sender);
    }

    /// @notice Reopens routes 1 and 2. The LP vault's operator only.
    function unpauseCompound() external onlyVaultOperator {
        _migratorStorage().compoundPaused = false;
        emit CompoundUnpaused(msg.sender);
    }

    /// @notice Rotates the voucher signer. The LP vault's operator (undelayed, like the
    ///         distributor's `setSigner`): a leaked key has to be replaceable without a 48 h wait.
    function setSigner(address signer_) external onlyVaultOperator {
        if (signer_ == address(0)) revert ZeroAddress();
        MigratorStorage storage $ = _migratorStorage();
        emit SignerSet($.signer, signer_);
        $.signer = signer_;
    }

    /// @notice Retunes the swap guard. The LP vault's operator, like the zapper's.
    function setTwapParams(uint32 window, uint24 maxDeviationTicks) external onlyVaultOperator {
        _setTwapParams(window, maxDeviationTicks);
    }

    /// @notice Sets the three route bonus rates, each at most 10,000 bps. Owner (the timelock).
    function setRates(uint16 compoundBps_, uint16 lpBps_, uint16 restakeBps_) external onlyOwner {
        _setRates(compoundBps_, lpBps_, restakeBps_);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function renounceOwnership() public override onlyOwner {
        revert RenounceDisabled();
    }

    // ──────────────────────── Internal helpers ─────────────────

    function _setRates(uint16 compoundBps_, uint16 lpBps_, uint16 restakeBps_) private {
        if (compoundBps_ > BPS) revert InvalidRate(compoundBps_);
        if (lpBps_ > BPS) revert InvalidRate(lpBps_);
        if (restakeBps_ > BPS) revert InvalidRate(restakeBps_);
        MigratorStorage storage $ = _migratorStorage();
        $.compoundBps = compoundBps_;
        $.lpBps = lpBps_;
        $.restakeBps = restakeBps_;
        emit RatesSet(compoundBps_, lpBps_, restakeBps_);
    }

    function _checkDeadline(uint256 deadline) private view {
        if (block.timestamp > deadline) revert DeadlineExpired(deadline, block.timestamp);
    }

    /// @dev The whole eligibility check, then the nonce is spent — before any token moves.
    function _useVoucher(uint8 route, uint256 assetAmount, uint256 usdcAmount, Voucher calldata v) private {
        if (v.route != route) revert WrongRoute(route, v.route);
        if (block.timestamp > v.deadline) revert VoucherExpired(v.deadline, block.timestamp);
        if (assetAmount > v.eligiblePrincipal) revert PrincipalExceedsEligible(assetAmount, v.eligiblePrincipal);
        if (usdcAmount > v.eligibleReward) revert RewardExceedsEligible(usdcAmount, v.eligibleReward);

        MigratorStorage storage $ = _migratorStorage();
        if ($.usedNonces[msg.sender][v.nonce]) revert VoucherNonceUsed(msg.sender, v.nonce);

        bytes32 digest =
            voucherDigest(msg.sender, route, v.eligiblePrincipal, v.eligibleReward, v.weight, v.nonce, v.deadline);
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, v.signature);
        if (err != ECDSA.RecoverError.NoError || recovered != $.signer) revert InvalidVoucherSignature();

        $.usedNonces[msg.sender][v.nonce] = true;
        emit VoucherUsed(msg.sender, v.nonce, route);
    }

    /// @dev Pulls `amount` of `token` from the caller, after the optional permit. The permit is
    ///      skipped when it is empty (`deadline == 0`) or the allowance already covers the pull, so a
    ///      front-run permit can never fail a call the existing allowance would carry.
    function _pull(address token, uint256 amount, Permit calldata p) private {
        if (p.deadline != 0 && IERC20(token).allowance(msg.sender, address(this)) < amount) {
            IERC20Permit(token).permit(msg.sender, address(this), p.value, p.deadline, p.v, p.r, p.s);
        }
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @dev USDC -> $ASSET on the vault's pool, guarded. Returns what the balance actually gained.
    function _swapUsdcForAsset(uint256 usdcAmount, uint256 minAssetOut) private returns (uint256 bought) {
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

    /// @dev Mints on {lpRange} with the whole USDC and the whole $ASSET as the desired amounts; the
    ///      position manager takes the matching pair and leaves the rest here.
    function _mintBand(uint256 usdcAmount, uint256 assetAmount, uint256 amount0Min, uint256 amount1Min, uint256 deadline)
        private
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
    ) private view returns (INonfungiblePositionManager.MintParams memory params) {
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

    /// @dev Route 2 after the vault stake: the two reservations, the v3 remainder, the USDC refund.
    function _finishLp(
        uint256 tokenId,
        uint256 usdcAmount,
        uint256 usdcUsed,
        uint256 assetAmount,
        uint256 assetUsed,
        uint256 weight
    ) private {
        MigratorStorage storage $ = _migratorStorage();
        uint64 unlockAt = SafeCast.toUint64(IWeightedStakingPoolV3Migration($.stakingPool).endEpoch());

        uint256 lpBonus = Math.mulDiv(assetUsed + usdcInAsset(usdcUsed), $.lpBps, BPS);
        if (lpBonus > 0) IV3BonusVaultReservations($.bonusVault).reserveLp(tokenId, msg.sender, lpBonus, unlockAt);

        uint256 remainder = assetAmount - assetUsed;
        uint256 v3Bonus;
        if (remainder > 0) {
            _stakeV3(msg.sender, remainder, weight);
            v3Bonus = Math.mulDiv(remainder, $.lpBps, BPS);
            _reserve(msg.sender, v3Bonus, unlockAt, ROUTE_LP);
        }

        uint256 usdcDust = usdcAmount - usdcUsed;
        if (usdcDust > 0) {
            IERC20(usdc).safeTransfer(msg.sender, usdcDust);
            emit UsdcRefunded(msg.sender, usdcDust);
        }

        emit MovedToLp(msg.sender, tokenId, usdcUsed, assetUsed, remainder, lpBonus, v3Bonus);
    }

    /// @dev Stakes `amount` in v3 for `user` and returns the pool's end as the bonus unlock time.
    function _stakeV3(address user, uint256 amount, uint256 weight) private returns (uint64 unlockAt) {
        address stakingPool_ = _migratorStorage().stakingPool;
        IERC20(asset).forceApprove(stakingPool_, amount);
        IWeightedStakingPoolV3Migration(stakingPool_).stakeFor(user, amount, weight);
        unlockAt = SafeCast.toUint64(IWeightedStakingPoolV3Migration(stakingPool_).endEpoch());
    }

    function _reserve(address user, uint256 amount, uint64 unlockAt, uint8 route) private {
        if (amount == 0) return;
        IV3BonusVaultReservations(_migratorStorage().bonusVault).reserve(user, amount, unlockAt, route);
    }

    /// @dev The adapter's rounding: towards negative infinity on the spacing.
    function _floorToSpacing(int256 tick, int256 spacing) private pure returns (int256 rounded) {
        rounded = tick - tick % spacing;
        if (rounded > tick) rounded -= spacing;
    }

    /// @dev The adapter's rounding: towards positive infinity on the spacing.
    function _ceilToSpacing(int256 tick, int256 spacing) private pure returns (int256 rounded) {
        rounded = tick - tick % spacing;
        if (rounded < tick) rounded += spacing;
    }

    /// @dev The adapter's clamp into Uniswap's usable range, rounded inward to the spacing.
    function _clampToUsable(int256 tick, int256 spacing) private pure returns (int24) {
        int256 maxUsable = int256(TickMath.MAX_TICK) - int256(TickMath.MAX_TICK) % spacing;
        int256 minUsable = int256(TickMath.MIN_TICK) - int256(TickMath.MIN_TICK) % spacing;
        if (tick > maxUsable) return SafeCast.toInt24(maxUsable);
        if (tick < minUsable) return SafeCast.toInt24(minUsable);
        return SafeCast.toInt24(tick);
    }
}
