// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.38;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";

import "./interfaces/IStakingV3.sol";

/**
 * @title WeightedStakingPoolV3
 * @notice The $ASSET staking pool of the staking v3 campaign: a SEPARATE, minimal contract
 *         (decision of 2026-11-10), not a copy of the v2 `WeightedStakingPool`. It holds each
 *         wallet's $ASSET principal for the window and pays it back. It pays no reward of its own:
 *         the v3 bonus is reserved in the `V3BonusVault` (by the `StakingMigrator` for a transition,
 *         by this pool for a direct stake: the new-stake bonus) and paid there, in $ASSET, after
 *         `endEpoch`.
 *
 *  LIFECYCLE.
 *    - `stake(amount, deadline, signature)` before `endEpoch`: a direct stake, gated by an EIP-712
 *      `StakeVoucher(address user,uint256 nonce,uint256 deadline)` signed by {signer} (the backend
 *      key; domain "WeightedStakingPool" / "1", verifying contract = this proxy). The voucher says
 *      "this wallet may stake"; it carries no amount and no weight. Its nonce is the user's next
 *      {nonces} value and is spent by the call. THE NEW-STAKE BONUS (decision of 2026-11-12): when
 *      a bonus vault is linked, the stake reserves `amount * STAKE_BONUS_BPS * daysLeft /
 *      (campaignDays * 10_000)` (rounded down; 5 % on the first day, 5 % x 47 / 90 = 2.61 % with
 *      47 of 90 days left, 5 % / 90 in the last 24 hours; whole days rounded up, `daysLeft` capped
 *      at `campaignDays`, {previewStakeBonus}) through the vault's `reserveStake` (route 4),
 *      unlocked at `endEpoch` and forfeited by an early `withdraw` like every v3 reservation. A
 *      bonus that rounds to zero reserves nothing. Fail closed: the vault's revert reverts the
 *      stake, so a stake whose bonus the budget (`maxTotalReserved`, shared with the migrator's
 *      route bonuses) cannot take reverts `BudgetExceeded`. {stakeFor} reserves nothing itself.
 *    - `stakeFor(user, amount)` before `endEpoch`: callable ONLY by the registered {migrator}. The
 *      tokens are pulled from the migrator and credited to `user`. No pool voucher is checked: the
 *      migrator has already verified the backend's `TransitionVoucher`.
 *    - `withdraw(amount)` before `endEpoch`: the principal back IN FULL (no penalty). The bonus
 *      vault is told through `onEarlyExit(user)` (fail closed: no `try`) and forfeits, for any
 *      amount withdrawn, the user's whole v3 reservation AND every LP reservation of the user that
 *      is still active (rule of 2026-11-12). The notification is sent before and after the
 *      activation alike.
 *    - `unstake()` after `endEpoch`: the whole principal. `emergencyUnstake()` after `endEpoch`:
 *      the same payout under its own event (kept on purpose; the contract is upgradeable, so it can
 *      be removed later).
 *
 *  ACCOUNTING. The per-wallet principal is {stakes}(user) and the sum is {totalStaked}.
 *  `activationEpoch` gates no action: every gate above keys on `endEpoch` alone. Since 2026-11-12
 *  it sets the length of the new-stake bonus scale (`campaignDays`); the UI and the indexer show
 *  it as the window's start.
 *
 *  THE BONUS VAULT LINK. While the window is open (`block.timestamp < endEpoch`) a linked bonus
 *  vault cannot be unlinked or replaced ({BonusVaultLocked}): an unlinked pool would let every early
 *  exit skip `onEarlyExit` and keep its reservation. If the bonus vault reverts, the recovery is an
 *  upgrade of the bonus vault, never an unlink. Linking one from zero is allowed at any time.
 *
 *  STORAGE. The live Sepolia stack #6 proxy was deployed with the v2-shaped layout (weight, USDC
 *  reward, penalty). Every field of that layout stays in place, under its old name (the upgrades
 *  validator refuses a renamed member), marked deprecated: never written by this implementation and
 *  never read. A fresh deploy leaves them zero.
 *
 *  ADMIN: owner (the timelock) only — upgrades, `setSigner`, `setMigrator`, `setBonusVault`,
 *  `recoverERC20` (any token; of the staking token only the surplus above {totalStaked}). Ownership is two-step and `renounceOwnership` reverts (it would freeze the
 *  upgrade path).
 */
contract WeightedStakingPoolV3 is
    Initializable,
    UUPSUpgradeable,
    Ownable2StepUpgradeable,
    EIP712Upgradeable,
    ReentrancyGuardTransient
{
    using SafeERC20 for IERC20;

    // ──────────────────────── Structures ────────────────────────

    struct StakeInfo {
        /// The wallet's staked principal.
        uint256 amount;
        /// @dev deprecated 2026-11-10, v2 leftover, never written
        uint256 weight;
        /// @dev deprecated 2026-11-10, v2 leftover, never written
        uint256 accumulatedWeight;
        /// @dev deprecated 2026-11-10, v2 leftover, never written
        uint256 lastUpdateTime;
    }

    // ──────────────────────── Constants ────────────────────────

    bytes32 public constant STAKE_VOUCHER_TYPEHASH =
        keccak256("StakeVoucher(address user,uint256 nonce,uint256 deadline)");

    /// @notice The new-stake bonus rate of a direct {stake} on the first campaign day, in basis
    ///         points (5 %); it scales down with the whole days left ({previewStakeBonus}).
    uint16 public constant STAKE_BONUS_BPS = 500;

    /// @dev The basis-point denominator of {STAKE_BONUS_BPS} (private: not part of the ABI).
    uint256 private constant BPS = 10_000;

    // ──────────────────────── Storage ──────────────────────────

    /// @custom:storage-location erc7201:real.staking.storage.WeightedStakingPoolV3
    struct PoolStorage {
        IERC20 stakingToken;
        /// @dev deprecated 2026-11-10, v2 leftover, never written
        IERC20 rewardToken;
        uint256 activationEpoch;
        uint256 endEpoch;
        /// @dev deprecated 2026-11-10, v2 leftover, never written
        uint256 poolDuration;
        address signer;
        uint256 totalStaked;
        /// @dev deprecated 2026-11-10, v2 leftover, never written
        uint256 totalWeightedStaked;
        /// @dev deprecated 2026-11-10, v2 leftover, never written
        uint256 totalAccumulatedWeight;
        /// @dev deprecated 2026-11-10, v2 leftover, never written
        uint256 totalForfeitedWeight;
        /// @dev deprecated 2026-11-10, v2 leftover, never written
        uint256 globalLastUpdateTime;
        /// @dev deprecated 2026-11-10, v2 leftover, never written
        uint256 totalRewards;
        /// @dev deprecated 2026-11-10, v2 leftover, never written
        uint256 totalRewardsClaimed;
        /// @dev deprecated 2026-11-10, v2 leftover, never written
        uint256 totalPenalized;
        mapping(address => StakeInfo) stakes;
        /// @dev deprecated 2026-11-10, v2 leftover, never written
        mapping(address => uint256) claimedRewards;
        /// Per-user `StakeVoucher` nonce: the next unused one.
        mapping(address => uint256) nonces;
        /// The only caller of {stakeFor}. Zero closes the path.
        address migrator;
        /// Notified by `withdraw` before `endEpoch`. Zero switches the notification off.
        address bonusVault;
        /// @dev deprecated 2026-11-10, v2 leftover, never written
        bool rewardsWaived;
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("real.staking.storage.WeightedStakingPoolV3")) - 1)) & ~0xff
    bytes32 private constant POOL_STORAGE = 0x2e7bda785777e966e24cba868272f146b3d9453f434083da348fd5d42a7a6e00;

    function _poolStorage() private pure returns (PoolStorage storage $) {
        assembly {
            $.slot := POOL_STORAGE
        }
    }

    // ──────────────────────── Events ───────────────────────────

    /// @notice One-time setup on a fresh proxy.
    event PoolInitialized(address indexed stakingToken, uint256 activationEpoch, uint256 endEpoch, address signer);
    /// @notice `amount` was credited to `user` (a direct `stake` or a migrator `stakeFor`).
    event Staked(address indexed user, uint256 amount);
    /// @notice The migrator staked `amount` for `user` (emitted after {Staked}).
    event StakedFor(address indexed user, address indexed by, uint256 amount);
    /// @notice `user` took `amount` back before `endEpoch`, in full; the bonus vault forfeits the
    ///         user's v3 bonus and every active LP bonus of the user.
    event Withdrawn(address indexed user, uint256 amount);
    /// @notice `user` took the whole principal back after `endEpoch`.
    event Unstaked(address indexed user, uint256 amount);
    /// @notice `user` took the whole principal back after `endEpoch` through `emergencyUnstake`.
    event EmergencyUnstaked(address indexed user, uint256 amount);
    /// @notice A `StakeVoucher` nonce was spent.
    event NonceUsed(address indexed user, uint256 nonce);
    event SignerChanged(address indexed oldSigner, address indexed newSigner);
    /// @notice The {stakeFor} caller changed. Both sides; zero closes the path.
    event MigratorSet(address previousMigrator, address newMigrator);
    /// @notice The early-exit listener changed. Both sides; zero switches it off.
    event BonusVaultSet(address previousBonusVault, address newBonusVault);

    // ──────────────────────── Errors ───────────────────────────

    /// @dev {stakeFor} called by someone other than the registered migrator.
    error NotMigrator(address caller, address migrator);
    /// @dev `renounceOwnership` is disabled: it would freeze the upgrade path forever.
    error RenounceDisabled();
    /// @dev {setBonusVault} would unlink or replace `current` before `endEpoch`.
    error BonusVaultLocked(address current, uint256 endEpoch);
    /// @dev {recoverERC20} of the staking token above the surplus (`balance - totalStaked`).
    error SurplusExceeded(uint256 requested, uint256 available);

    // ──────────────────────── Constructor / initializer ────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice One-time setup on the proxy, in its own deployment transaction.
     * @param owner_ The owner: the deployer while the deploy script wires the three v3 contracts,
     *        then the `LPTimelock` (two-step handover).
     * @param stakingToken_ $ASSET.
     * @param activationEpoch_ Start of the window: it gates nothing, and with `endEpoch_` sets the
     *        new-stake bonus scale (`campaignDays`).
     * @param endEpoch_ End of the window; also the bonus unlock time.
     * @param signer_ The `StakeVoucher` signer (the backend key).
     * @dev The migrator and the bonus vault do not exist yet when the pool is deployed (both take
     *      the pool's address in their own initializer); the deploy script links them afterwards
     *      with {setMigrator} and {setBonusVault}.
     */
    function initialize(
        address owner_,
        address stakingToken_,
        uint256 activationEpoch_,
        uint256 endEpoch_,
        address signer_
    ) external initializer {
        require(stakingToken_ != address(0), "Invalid staking token");
        require(endEpoch_ > activationEpoch_, "End must be after activation");
        require(signer_ != address(0), "Invalid signer");

        __Ownable_init(owner_);
        __Ownable2Step_init();
        __EIP712_init("WeightedStakingPool", "1");

        PoolStorage storage $ = _poolStorage();
        $.stakingToken = IERC20(stakingToken_);
        $.activationEpoch = activationEpoch_;
        $.endEpoch = endEpoch_;
        $.signer = signer_;

        emit PoolInitialized(stakingToken_, activationEpoch_, endEpoch_, signer_);
        emit SignerChanged(address(0), signer_);
    }

    // ──────────────────────── User functions ───────────────────

    /**
     * @notice Stake `amount` before `endEpoch`, with the backend's `StakeVoucher` for the caller.
     *         With a bonus vault linked, it also reserves the new-stake bonus ({previewStakeBonus})
     *         for the caller; the stake reverts with the vault (`BudgetExceeded`, `NotPool`).
     * @param amount Tokens pulled from the caller.
     * @param deadline The voucher's expiry (unix seconds).
     * @param signature The signer's EIP-712 signature over (caller, the caller's next nonce, deadline).
     */
    function stake(uint256 amount, uint256 deadline, bytes calldata signature) external nonReentrant {
        PoolStorage storage $ = _poolStorage();
        require(block.timestamp < $.endEpoch, "Pool has ended");
        require(amount > 0, "Amount must be > 0");
        require(signature.length != 0, "Signature required");
        require(block.timestamp <= deadline, "Signature expired");

        uint256 nonce = $.nonces[msg.sender]++;
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(STAKE_VOUCHER_TYPEHASH, msg.sender, nonce, deadline)));
        require(ECDSA.recover(digest, signature) == $.signer, "Invalid signature");
        emit NonceUsed(msg.sender, nonce);

        _credit(msg.sender, amount);

        // The new-stake bonus (2026-11-12), after every state change of the stake. Fail closed: a
        // revert of the bonus vault (`BudgetExceeded`, `NotPool`) reverts the stake.
        address bonusVault_ = $.bonusVault;
        if (bonusVault_ != address(0)) {
            uint256 bonus = _stakeBonus($, amount);
            if (bonus > 0) {
                IV3BonusVaultStakeBonus(bonusVault_).reserveStake(msg.sender, bonus, SafeCast.toUint64($.endEpoch));
            }
        }
    }

    /**
     * @notice Stake `amount` for `user`, pulled from the caller. Only the registered migrator.
     * @param user The staker credited.
     * @param amount Tokens pulled from the migrator.
     */
    function stakeFor(address user, uint256 amount) external nonReentrant {
        PoolStorage storage $ = _poolStorage();
        address migrator_ = $.migrator;
        if (msg.sender != migrator_) revert NotMigrator(msg.sender, migrator_);
        require(user != address(0), "Invalid user");
        require(block.timestamp < $.endEpoch, "Pool has ended");
        require(amount > 0, "Amount must be > 0");

        _credit(user, amount);
        emit StakedFor(user, msg.sender, amount);
    }

    /// @notice Withdraw before `endEpoch`, any amount. The principal is returned IN FULL; the
    ///         bonus vault forfeits the user's whole v3 bonus reservation AND every LP bonus
    ///         reservation of the user that is still active (rule of 2026-11-12).
    function withdraw(uint256 amount) external nonReentrant {
        PoolStorage storage $ = _poolStorage();
        require(block.timestamp < $.endEpoch, "Use unstake after pool ends");
        require(amount > 0, "Amount must be > 0");

        StakeInfo storage info = $.stakes[msg.sender];
        require(info.amount > 0, "Nothing to withdraw");
        require(amount <= info.amount, "Amount exceeds stake");

        info.amount -= amount;
        $.totalStaked -= amount;

        // After every state change, before any token leaves: the bonus is forfeited (fail closed).
        address bonusVault_ = $.bonusVault;
        if (bonusVault_ != address(0)) {
            IV3BonusVaultEarlyExit(bonusVault_).onEarlyExit(msg.sender);
        }

        $.stakingToken.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice After `endEpoch`: the whole principal back.
    function unstake() external nonReentrant {
        uint256 amount = _exit();
        emit Unstaked(msg.sender, amount);
    }

    /// @notice After `endEpoch`: the whole principal back (the same payout as {unstake}).
    function emergencyUnstake() external nonReentrant {
        uint256 amount = _exit();
        emit EmergencyUnstaked(msg.sender, amount);
    }

    // ──────────────────────── Owner functions ──────────────────

    /// @notice Change the `StakeVoucher` signer.
    function setSigner(address signer_) external onlyOwner {
        require(signer_ != address(0), "Invalid signer");
        PoolStorage storage $ = _poolStorage();
        emit SignerChanged($.signer, signer_);
        $.signer = signer_;
    }

    /// @notice Sets the only caller of {stakeFor} (the `StakingMigrator` proxy), or zero to close it.
    function setMigrator(address migrator_) external onlyOwner {
        PoolStorage storage $ = _poolStorage();
        emit MigratorSet($.migrator, migrator_);
        $.migrator = migrator_;
    }

    /// @notice Sets the bonus vault notified by an early `withdraw`. Before `endEpoch` a linked vault
    ///         can be neither unlinked (zero) nor replaced ({BonusVaultLocked}); linking one from
    ///         zero is always allowed, and after the end any change is. If the bonus vault reverts,
    ///         the recovery is an upgrade of the bonus vault, never an unlink.
    function setBonusVault(address bonusVault_) external onlyOwner {
        PoolStorage storage $ = _poolStorage();
        address current = $.bonusVault;
        if (current != address(0) && bonusVault_ != current && block.timestamp < $.endEpoch) {
            revert BonusVaultLocked(current, $.endEpoch);
        }
        emit BonusVaultSet(current, bonusVault_);
        $.bonusVault = bonusVault_;
    }

    /// @notice Recover ERC20 tokens sent here by mistake, to the owner. Any token in full (USDC
    ///         from the v2-era reward slot included); of the staking token only the surplus
    ///         `balanceOf(this) - totalStaked` (a plain transfer), never a staked principal
    ///         ({SurplusExceeded} above it).
    function recoverERC20(address token, uint256 amount) external onlyOwner {
        PoolStorage storage $ = _poolStorage();
        if (token == address($.stakingToken)) {
            uint256 balance = $.stakingToken.balanceOf(address(this));
            uint256 available = balance > $.totalStaked ? balance - $.totalStaked : 0;
            if (amount > available) revert SurplusExceeded(amount, available);
        }
        IERC20(token).safeTransfer(owner(), amount);
    }

    /// @dev UUPS: the owner (the timelock) is the whole authorization.
    function _authorizeUpgrade(address) internal override onlyOwner {}

    /// @notice Disabled: renouncing would freeze the upgrade path.
    function renounceOwnership() public override onlyOwner {
        revert RenounceDisabled();
    }

    // ──────────────────────── View functions ───────────────────

    function stakingToken() external view returns (address) {
        return address(_poolStorage().stakingToken);
    }

    /// @notice The window's start: it gates no action; the new-stake bonus reads it for the
    ///         campaign length ({previewStakeBonus}).
    function activationEpoch() external view returns (uint256) {
        return _poolStorage().activationEpoch;
    }

    function endEpoch() external view returns (uint256) {
        return _poolStorage().endEpoch;
    }

    /**
     * @notice The new-stake bonus a direct {stake} of `amount` would reserve now:
     *         `amount * STAKE_BONUS_BPS * daysLeft / (campaignDays * 10_000)`, rounded down, where
     *         `campaignDays` is `endEpoch - activationEpoch` in whole days rounded up and `daysLeft`
     *         is `endEpoch - block.timestamp` in whole days rounded up, capped at `campaignDays`
     *         (a stake before the activation gets the full rate). Zero from `endEpoch` on and while
     *         no bonus vault is linked (the stake then reserves nothing).
     */
    function previewStakeBonus(uint256 amount) external view returns (uint256) {
        PoolStorage storage $ = _poolStorage();
        if ($.bonusVault == address(0)) return 0;
        return _stakeBonus($, amount);
    }

    function signer() external view returns (address) {
        return _poolStorage().signer;
    }

    function migrator() external view returns (address) {
        return _poolStorage().migrator;
    }

    function bonusVault() external view returns (address) {
        return _poolStorage().bonusVault;
    }

    function totalStaked() external view returns (uint256) {
        return _poolStorage().totalStaked;
    }

    /// @notice The wallet's staked principal.
    function stakes(address user) external view returns (uint256 amount) {
        return _poolStorage().stakes[user].amount;
    }

    /// @notice The wallet's next `StakeVoucher` nonce.
    function nonces(address user) external view returns (uint256) {
        return _poolStorage().nonces[user];
    }

    // ──────────────────────── Internal helpers ─────────────────

    /// @dev The shared tail of `stake` and `stakeFor`: pull from `msg.sender`, credit `user`.
    function _credit(address user, uint256 amount) private {
        PoolStorage storage $ = _poolStorage();
        $.stakingToken.safeTransferFrom(msg.sender, address(this), amount);
        $.stakes[user].amount += amount;
        $.totalStaked += amount;
        emit Staked(user, amount);
    }

    /// @dev The new-stake bonus of `amount` at the current block time ({previewStakeBonus}).
    ///      `endEpoch > activationEpoch` (the initializer) keeps `campaignDays` at one or more.
    function _stakeBonus(PoolStorage storage $, uint256 amount) private view returns (uint256) {
        uint256 end = $.endEpoch;
        if (block.timestamp >= end) return 0;
        uint256 campaignDays = Math.ceilDiv(end - $.activationEpoch, 1 days);
        uint256 daysLeft = Math.ceilDiv(end - block.timestamp, 1 days);
        if (daysLeft > campaignDays) daysLeft = campaignDays;
        return Math.mulDiv(amount, uint256(STAKE_BONUS_BPS) * daysLeft, campaignDays * BPS);
    }

    /// @dev The shared body of `unstake` and `emergencyUnstake`: after the end, pay the whole stake.
    function _exit() private returns (uint256 amount) {
        PoolStorage storage $ = _poolStorage();
        require(block.timestamp >= $.endEpoch, "Pool not ended yet");
        StakeInfo storage info = $.stakes[msg.sender];
        amount = info.amount;
        require(amount > 0, "Nothing to unstake");
        info.amount = 0;
        $.totalStaked -= amount;
        $.stakingToken.safeTransfer(msg.sender, amount);
    }
}
