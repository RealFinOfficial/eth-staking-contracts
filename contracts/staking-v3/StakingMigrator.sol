// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.38;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";

import "../lp-staking/libraries/OracleHistory.sol";
import "./StakingMigratorBase.sol";
import "./StakingMigratorDeliveries.sol";

/**
 * @title StakingMigrator
 * @notice The one-call transition from the closed $ASSET staking window (sw2, v2) into staking v3.
 *         The staker first calls `unstake()` on sw2 themselves (only they can: it pays principal and
 *         USDC reward to `msg.sender`), then ONE call here runs one of three routes:
 *
 *    1. {compound}: pulls the USDC reward and the $ASSET principal, swaps the USDC into $ASSET
 *       through SwapRouter02 `exactInputSingle` on the LP vault's pool under this contract's
 *       {TwapGuard} (a non-zero `minAssetOut` is required), stakes principal + bought $ASSET in the
 *       v3 pool FOR the caller, and reserves `compoundBps` of (principal + min(bought, the USDC
 *       valued at the mean tick of {valuationWindow})) in the bonus vault, so a swap at a moved
 *       spot price can never raise the bonus above the TWAP-valued figure.
 *    2. {moveToLp}: pulls the USDC reward and the $ASSET principal, mints ONE position on the
 *       recommended band (6,932 ticks each side of the spot tick = -50 % / +100 % in price, rounded
 *       outward to the tick spacing; the ApeBond adapter's `_campaignRange` math) from the whole USDC
 *       and the matching $ASSET (the position manager takes what the band needs), stakes the NFT in
 *       the LP vault FOR the caller (`vault.stakeFor`; this contract is a stake operator), refunds
 *       the USDC dust, stakes the remaining $ASSET in v3 FOR the caller, asserts the custody (the
 *       position manager says the vault owns the NFT, the vault says the caller staked it;
 *       {CustodyAssertFailed} otherwise, the adapter's check), and reserves `lpBps` of
 *       (LP $ASSET leg + LP USDC leg valued in $ASSET at the mean tick of {valuationWindow}) under
 *       the position's tokenId and `lpBps` of the v3 remainder for the caller. No top-up from the
 *       wallet, and no swap of $ASSET into USDC, ever.
 *    3. {claimRestake}: pulls only the $ASSET principal (the USDC stays in the wallet), stakes it in
 *       v3 FOR the caller and reserves `restakeBps` of it.
 *
 *  THE 30-DAY BONUS RULE (2026-11-17). Each route reserves its FULL rate (the formulas above,
 *  never scaled by time) only while `block.timestamp < pool.bonusCutoff()`, i.e. while 30 or more
 *  whole days (rounded up) are left before the v3 pool's `endEpoch`. From the cutoff on (29 whole
 *  days left or fewer) every bonus of the route is zero, the LP part of {moveToLp} included: the
 *  route still stakes, marks the wallet {migrated} and emits its event with the bonus fields at
 *  zero, and the bonus vault is not called. The cutoff and its 30 days live in the pool
 *  (`WeightedStakingPoolV3.bonusCutoff`, `BONUS_MIN_DAYS_LEFT`), the one definition shared with
 *  the direct stake. The pool must therefore be upgraded no later than this migrator.
 *
 *  ELIGIBILITY. Only amounts that came out of a real sw2 claim earn a bonus. The backend attests
 *  them with an EIP-712 `TransitionVoucher(address user,uint8 route,uint256 eligiblePrincipal,
 *  uint256 eligibleReward,uint256 nonce,uint256 deadline)` (domain "StakingMigrator" / "1",
 *  verifying contract = this proxy) signed by {signer}. Each route checks: the voucher names this
 *  route, `assetAmount <= eligiblePrincipal`, `usdcAmount <= eligibleReward`, the nonce is unused
 *  for the caller, the deadline has not passed, the signature. `user` is always `msg.sender`. The
 *  v3 pool has no weight (decision of 2026-11-10): `pool.stakeFor(user, amount)`.
 *
 *  ONE TRANSITION PER WALLET. A sw2 claim is converted once: the first successful route call marks
 *  the caller {migrated}, and every later route call by that wallet reverts {AlreadyMigrated},
 *  whatever voucher it carries (the per-user nonce check stays as well).
 *
 *  PAUSE. Routes 1 and 2 trade against the pool, so they stop behind one switch while the pool has
 *  no liquidity: {pauseCompound} (the LP vault's guardian or operator, read live) and
 *  {unpauseCompound} (the operator only), the vault's pattern. The proxy is born paused. Route 3
 *  never trades and is never pausable.
 *
 *  Holds no funds between transactions; no ETH. Re-entrancy guarded; the voucher nonce is spent
 *  before any token moves.
 *
 *  THE TRANSITION DELIVERIES (spec 01 §9.4, 2026-11-20). Three more entries, {compoundFor},
 *  {moveToLpFor} and {claimRestakeFor}, are open ONLY to the {transitionReceiver}: it hands over the
 *  tokens that arrived at a holder's receiving address and this contract stakes them FOR that
 *  holder under the route of that address. Each delivery carries its own EIP-712 `DeliveryVoucher`
 *  (the same domain and signer as the `TransitionVoucher`) whose nonce must equal the holder's
 *  {deliveryOf} `nextNonce`, and whose cumulative limits cap what all deliveries of the holder may
 *  take (`principalDelivered <= assetLimit <= eligiblePrincipal`, the same for the reward). The
 *  first delivery stores the route and marks the holder {migrated}, so the direct routes refuse
 *  him afterwards, and a holder who moved directly cannot receive a delivery. The bonus of a
 *  delivery follows the voucher's `burnTime`, never the time of the stake: the full rate when
 *  `burnTime < pool.bonusCutoff()`, nothing otherwise. Route 1 swaps under a floor of
 *  {usdcInAsset} less {swapLimitBps}; route 2 mints its ONE position on the first delivery, only
 *  when the matching $ASSET of the whole USDC is there ({MatchingAssetNotArrived}), and stakes every
 *  later part in v3.
 *
 *  ADMIN: owner (the timelock) — upgrades, {setRates}, {setTransitionReceiver},
 *  {initializeTransition}; operator (the LP vault's, read live) — {setSigner}, {setTwapParams},
 *  {unpauseCompound}, {setSwapLimitBps}; guardian or operator — {pauseCompound}.
 */
contract StakingMigrator is UUPSUpgradeable, Ownable2StepUpgradeable, StakingMigratorBase {
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
        uint256 nonce;
        uint256 deadline;
        bytes signature;
    }

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

    /// @dev The delivery module ({StakingMigratorDeliveries}) this implementation created; the three
    ///      delivery entries run there with `delegatecall`.
    address private immutable deliveryModule;

    /**
     * @notice Deploys the IMPLEMENTATION. Its market references are read from the LP vault and kept
     *         `immutable`, exactly like the zapper's, and it creates its delivery module from the same
     *         three arguments.
     * @param lpVault_ The `LPStakingVault` proxy.
     * @param usdc_ USDC; one of the vault pool's two tokens.
     * @param asset_ $ASSET; the other one.
     * @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
     */
    constructor(address lpVault_, address usdc_, address asset_) StakingMigratorBase(lpVault_, usdc_, asset_) {
        deliveryModule = address(new StakingMigratorDeliveries(lpVault_, usdc_, asset_));
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
     * @dev Born with the compound routes PAUSED and the rates 1000 / 1000 / 500 bps. The pool's
     *      staking token and the bonus vault's bonus token must both be {asset}
     *      ({TokenPairMismatch}(usdc, asset, poolStakingToken, bonusToken) otherwise).
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
        address poolToken = IWeightedStakingPoolV3Migration(stakingPool_).stakingToken();
        address bonusToken = IV3BonusVaultReservations(bonusVault_).bonusToken();
        if (poolToken != asset || bonusToken != asset) revert TokenPairMismatch(usdc, asset, poolToken, bonusToken);
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
     * @param minAssetOut The swap's `amountOutMinimum`; must be above zero ({MinAssetOutZero}).
     * @param deadline The call's own expiry.
     * @return staked The amount staked in v3 for the caller.
     * @return bonus The v3 reservation added (zero from the pool's `bonusCutoff()` on).
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
        if (minAssetOut == 0) revert MinAssetOutZero();
        _checkDeadline(deadline);
        _useVoucher(ROUTE_COMPOUND, assetAmount, usdcAmount, v);

        _pull(usdc, usdcAmount, usdcPermit);
        if (assetAmount > 0) _pull(asset, assetAmount, assetPermit);

        uint256 bought = _swapUsdcForAsset(usdcAmount, minAssetOut);
        staked = assetAmount + bought;

        MigratorStorage storage $ = _migratorStorage();
        uint64 unlockAt = _stakeV3(msg.sender, staked);
        // The bonus base values the bought part at the TWAP, never above what was actually bought.
        // Zero from the pool's bonus cutoff on (the 30-day rule).
        if (_bonusOpen()) {
            bonus = Math.mulDiv(assetAmount + Math.min(bought, usdcInAsset(usdcAmount)), $.compoundBps, BPS);
        }
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
        _assertCustody(tokenId, msg.sender);

        _finishLp(tokenId, usdcAmount, usdcUsed, assetAmount, assetUsed);
    }

    /**
     * @notice Route 3: stake the $ASSET principal in v3; the USDC reward stays in the wallet.
     * @param assetAmount $ASSET principal pulled (<= eligiblePrincipal; > 0).
     * @param deadline The call's own expiry.
     * @return bonus The v3 reservation added (zero from the pool's `bonusCutoff()` on).
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

        uint64 unlockAt = _stakeV3(msg.sender, assetAmount);
        if (_bonusOpen()) bonus = Math.mulDiv(assetAmount, _migratorStorage().restakeBps, BPS);
        _reserve(msg.sender, bonus, unlockAt, ROUTE_RESTAKE);

        emit ClaimRestaked(msg.sender, assetAmount, bonus);
    }

    // ──────────────────────── Transition deliveries ────────────

    /// @notice Route 1 for a transition holder: the receiver hands over what arrived at the holder's
    ///         route-1 receiving address, the USDC is swapped under the swap floor and everything is
    ///         staked in v3 for the holder. The {transitionReceiver} only. The body is
    ///         {StakingMigratorDeliveries-compoundFor}.
    function compoundFor(
        address,
        uint256,
        uint256,
        ITransitionMigrator.DeliveryLimits calldata,
        ITransitionMigrator.DeliveryVoucher calldata
    ) external returns (ITransitionMigrator.DeliveryResult memory) {
        _delegateToDeliveries();
    }

    /// @notice Route 2 for a transition holder: ONE LP position on the first delivery, which must
    ///         carry exactly the voucher's `usdcLimit` of USDC ({UsdcBelowVoucher} below it), v3 for
    ///         every later part. The {transitionReceiver} only. The body is
    ///         {StakingMigratorDeliveries-moveToLpFor}.
    function moveToLpFor(
        address,
        uint256,
        uint256,
        ITransitionMigrator.DeliveryLimits calldata,
        ITransitionMigrator.DeliveryVoucher calldata
    ) external returns (ITransitionMigrator.DeliveryResult memory) {
        _delegateToDeliveries();
    }

    /// @notice Route 3 for a transition holder: the $ASSET is staked in v3. The {transitionReceiver}
    ///         only. The body is {StakingMigratorDeliveries-claimRestakeFor}.
    function claimRestakeFor(
        address,
        uint256,
        ITransitionMigrator.DeliveryLimits calldata,
        ITransitionMigrator.DeliveryVoucher calldata
    ) external returns (ITransitionMigrator.DeliveryResult memory) {
        _delegateToDeliveries();
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

    /// @notice True once `user` has made their one transition (any route).
    function migrated(address user) external view returns (bool) {
        return _migratorStorage().migrated[user];
    }

    /// @notice The transition deliveries of `holder` so far.
    function deliveryOf(address holder)
        external
        view
        returns (
            uint8 route,
            bool lpCreated,
            uint256 lpTokenId,
            uint256 principalDelivered,
            uint256 rewardDelivered,
            uint256 nextNonce
        )
    {
        Delivery storage d = _migratorStorage().deliveries[holder];
        return (d.route, d.lpCreated, d.lpTokenId, d.principalDelivered, d.rewardDelivered, d.nextNonce);
    }

    /// @notice The only caller of the three delivery entries (zero: closed).
    function transitionReceiver() external view returns (address) {
        return _migratorStorage().transitionReceiver;
    }

    /// @notice How far below the TWAP value a route-1 delivery's swap may fill, in basis points.
    function swapLimitBps() external view returns (uint16) {
        return _migratorStorage().swapLimitBps;
    }

    /// @notice The EIP-712 digest the signer signs for `user`'s voucher.
    function voucherDigest(
        address user,
        uint8 route,
        uint256 eligiblePrincipal,
        uint256 eligibleReward,
        uint256 nonce,
        uint256 deadline
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(TRANSITION_VOUCHER_TYPEHASH, user, route, eligiblePrincipal, eligibleReward, nonce, deadline)
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

    /**
     * @notice Links the transition receiver and sets the swap limit to 3 %. Runs once: inside the
     *         upgrade (`upgradeToAndCall`) of a live proxy, or right after a fresh deploy while the
     *         deployer owns the proxy. Owner only.
     */
    function initializeTransition(address receiver_) external onlyOwner reinitializer(2) {
        if (receiver_ == address(0)) revert ZeroAddress();
        MigratorStorage storage $ = _migratorStorage();
        $.transitionReceiver = receiver_;
        $.swapLimitBps = INITIAL_SWAP_LIMIT_BPS;
        emit TransitionReceiverSet(address(0), receiver_);
        emit SwapLimitSet(0, INITIAL_SWAP_LIMIT_BPS);
    }

    /// @notice Replaces the transition receiver; zero closes the three delivery entries. Owner (the timelock).
    function setTransitionReceiver(address receiver_) external onlyOwner {
        MigratorStorage storage $ = _migratorStorage();
        emit TransitionReceiverSet($.transitionReceiver, receiver_);
        $.transitionReceiver = receiver_;
    }

    /// @notice Sets the route-1 delivery swap limit, `0 < bps <= MAX_SWAP_LIMIT_BPS`. The LP vault's
    ///         operator, undelayed: raised for a large holder whose swap cannot pass at 3 %.
    function setSwapLimitBps(uint16 bps) external onlyVaultOperator {
        if (bps == 0 || bps > MAX_SWAP_LIMIT_BPS) revert InvalidSwapLimit(bps, MAX_SWAP_LIMIT_BPS);
        MigratorStorage storage $ = _migratorStorage();
        emit SwapLimitSet($.swapLimitBps, bps);
        $.swapLimitBps = bps;
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

    /// @dev The whole eligibility check, then the nonce is spent and the wallet marked migrated —
    ///      before any token moves. A replayed nonce reports {VoucherNonceUsed}; a fresh voucher of
    ///      a wallet that already moved reports {AlreadyMigrated}.
    function _useVoucher(uint8 route, uint256 assetAmount, uint256 usdcAmount, Voucher calldata v) private {
        if (v.route != route) revert WrongRoute(route, v.route);
        if (block.timestamp > v.deadline) revert VoucherExpired(v.deadline, block.timestamp);
        if (assetAmount > v.eligiblePrincipal) revert PrincipalExceedsEligible(assetAmount, v.eligiblePrincipal);
        if (usdcAmount > v.eligibleReward) revert RewardExceedsEligible(usdcAmount, v.eligibleReward);

        MigratorStorage storage $ = _migratorStorage();
        if ($.usedNonces[msg.sender][v.nonce]) revert VoucherNonceUsed(msg.sender, v.nonce);
        if ($.migrated[msg.sender]) revert AlreadyMigrated(msg.sender);

        bytes32 digest = voucherDigest(msg.sender, route, v.eligiblePrincipal, v.eligibleReward, v.nonce, v.deadline);
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, v.signature);
        if (err != ECDSA.RecoverError.NoError || recovered != $.signer) revert InvalidVoucherSignature();

        $.usedNonces[msg.sender][v.nonce] = true;
        $.migrated[msg.sender] = true;
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

    /// @dev Route 2 after the vault stake: the two reservations, the v3 remainder, the USDC refund.
    function _finishLp(
        uint256 tokenId,
        uint256 usdcAmount,
        uint256 usdcUsed,
        uint256 assetAmount,
        uint256 assetUsed
    ) private {
        ITransitionMigrator.DeliveryResult memory r;
        (r.lpTokenId, r.usdcToLp, r.assetToLp) = (tokenId, usdcUsed, assetUsed);
        // Both parts follow the 30-day rule: zero from the pool's bonus cutoff on.
        _settleLp(msg.sender, usdcAmount, assetAmount, _bonusOpen(), r);
        emit MovedToLp(msg.sender, tokenId, usdcUsed, assetUsed, r.staked, r.lpBonus, r.v3Bonus);
    }

    /// @dev The 30-day rule (2026-11-17): true while an entry still earns its bonus, i.e. strictly
    ///      before the v3 pool's `bonusCutoff()` (30 or more whole days left before its end).
    function _bonusOpen() private view returns (bool) {
        return block.timestamp < IWeightedStakingPoolV3Migration(_migratorStorage().stakingPool).bonusCutoff();
    }

    /// @dev Runs the current call's calldata on {deliveryModule} with `delegatecall` and returns or
    ///      reverts with exactly its return data. The module was created by this implementation's own
    ///      constructor and its address is immutable, so the target can never change; it has no
    ///      `selfdestruct` and no `delegatecall` of its own.
    /// @custom:oz-upgrades-unsafe-allow delegatecall
    function _delegateToDeliveries() private {
        (bool ok, bytes memory ret) = deliveryModule.delegatecall(msg.data);
        assembly ("memory-safe") {
            switch ok
            case 0 { revert(add(ret, 0x20), mload(ret)) }
            default { return(add(ret, 0x20), mload(ret)) }
        }
    }
}
