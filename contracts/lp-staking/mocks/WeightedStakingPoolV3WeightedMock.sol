// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.38;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";

import "../../staking-v3/interfaces/IStakingV3.sol";

/**
 * @title WeightedStakingPoolV3WeightedMock — TEST ONLY. A verbatim copy of `WeightedStakingPoolV3`
 *        at commit db26a15: the implementation live on Sepolia stack #6 (proxy 0xB8F5…fcb9, impl
 *        0x2E7b…860A) before the minimal pool of 2026-11-10, with the weight multiplier, the USDC
 *        reward slot and the deprecated penalty counter. Only the contract name, the import path
 *        and this comment differ. It exists so the tests can stake on a proxy running the PREVIOUS
 *        implementation, upgrade it to the current one and prove the principal survives, and so
 *        `upgrades.validateUpgrade` can grade the two layouts offline.
 */
contract WeightedStakingPoolV3WeightedMock is
    Initializable,
    UUPSUpgradeable,
    Ownable2StepUpgradeable,
    EIP712Upgradeable,
    ReentrancyGuardTransient
{
    using SafeERC20 for IERC20;

    // ──────────────────────── Structures ────────────────────────

    struct StakeInfo {
        uint256 amount;
        uint256 weight; // multiplier in BASE_WEIGHT units; 0 = unset (no active stake)
        uint256 accumulatedWeight;
        uint256 lastUpdateTime;
    }

    // ──────────────────────── Constants ────────────────────────

    uint256 public constant BASE_WEIGHT = 1000; // x1.0
    uint256 public constant MAX_WEIGHT = 2000; // x2.0

    uint256 public constant BPS_DENOMINATOR = 10000;

    bytes32 public constant STAKE_TYPEHASH =
        keccak256("Stake(address user,uint256 amount,uint256 weight,uint256 nonce,uint256 deadline)");
    bytes32 public constant WITHDRAW_TYPEHASH =
        keccak256("Withdraw(address user,uint256 amount,uint256 weight,uint256 nonce,uint256 deadline)");
    bytes32 public constant UPDATE_WEIGHT_TYPEHASH =
        keccak256("UpdateWeight(address user,uint256 amount,uint256 weight,uint256 nonce,uint256 deadline)");

    // ──────────────────────── Storage ──────────────────────────

    /// @custom:storage-location erc7201:real.staking.storage.WeightedStakingPoolV3
    struct PoolStorage {
        IERC20 stakingToken;
        IERC20 rewardToken;
        uint256 activationEpoch;
        uint256 endEpoch;
        uint256 poolDuration;
        address signer;
        uint256 totalStaked;
        uint256 totalWeightedStaked;
        uint256 totalAccumulatedWeight;
        uint256 totalForfeitedWeight;
        uint256 globalLastUpdateTime;
        uint256 totalRewards;
        uint256 totalRewardsClaimed;
        /// DEPRECATED (2026-11-10, v3 has no principal penalty): never written any more; zero on a
        /// fresh deploy (Sepolia stack #6 keeps the figure its first implementation recorded). The
        /// field keeps its name and place so the layout of the deployed proxies does not shift (the
        /// upgrades validator refuses a renamed struct member, even with `oz-renamed-from`).
        uint256 totalPenalized;
        mapping(address => StakeInfo) stakes;
        mapping(address => uint256) claimedRewards;
        mapping(address => uint256) nonces;
        /// The only caller of {stakeFor}. Zero closes the path.
        address migrator;
        /// Notified by `withdraw` before `endEpoch`. Zero switches the notification off.
        address bonusVault;
        /// Set once by the initializer: the pool pays no reward (`addRewards` refused, `unstake`
        /// pays the principal with a zero reward after the end).
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

    event Staked(address indexed user, uint256 amount, uint256 weight, uint256 totalStaked);
    /// @notice `penalty` is always 0: v3 returns the principal in full (kept for ABI compatibility).
    event Withdrawn(address indexed user, uint256 amount, uint256 forfeitedWeight, uint256 penalty);
    event Unstaked(
        address indexed user,
        uint256 amount,
        uint256 reward,
        uint256 claimedRewards,
        uint256 userWeight,
        uint256 totalEffectiveWeight
    );
    event EmergencyUnstaked(address indexed user, uint256 amount);
    event RewardsAdded(uint256 amount, uint256 totalRewards);
    event StakeUpdated(
        address indexed user, uint256 amount, uint256 weight, uint256 accumulatedWeight, uint256 timestamp
    );
    event WeightUpdated(address indexed user, uint256 oldWeight, uint256 newWeight);
    event NonceUsed(address indexed user, uint256 nonce);
    event SignerChanged(address indexed oldSigner, address indexed newSigner);
    event GlobalUpdated(
        uint256 totalStaked,
        uint256 totalWeightedStaked,
        uint256 totalAccumulatedWeight,
        uint256 totalForfeitedWeight,
        uint256 totalPenalized,
        uint256 totalRewardsClaimed,
        uint256 timestamp
    );
    /// @notice `maxPenaltyBps` and `minPenaltyBps` are always 0: v3 has no principal penalty; the
    ///         fields stay so the v2-shaped event decodes unchanged. `bpsDenominator` is 10000.
    event PoolInitialized(
        address indexed stakingToken,
        address indexed rewardToken,
        uint256 activationEpoch,
        uint256 endEpoch,
        uint256 maxPenaltyBps,
        uint256 minPenaltyBps,
        uint256 bpsDenominator
    );

    /// @notice The migrator staked `amount` for `user` (emitted beside {Staked}).
    event StakedFor(address indexed user, address indexed by, uint256 amount, uint256 weight);
    /// @notice The {stakeFor} caller changed. Both sides; zero closes the path.
    event MigratorSet(address previousMigrator, address newMigrator);
    /// @notice The early-exit listener changed. Both sides; zero switches it off.
    event BonusVaultSet(address previousBonusVault, address newBonusVault);
    /// @notice The initializer's reward flag: true = no reward is ever paid (see {rewardsWaived}).
    event RewardsWaivedSet(bool waived);

    // ──────────────────────── Errors ───────────────────────────

    /// @dev {stakeFor} called by someone other than the registered migrator.
    error NotMigrator(address caller, address migrator);
    /// @dev `renounceOwnership` is disabled: it would freeze the upgrade path forever.
    error RenounceDisabled();

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
     * @param rewardToken_ The reward slot (USDC), kept for compatibility and left unfunded.
     * @param activationEpoch_ Start of the active period.
     * @param endEpoch_ End of the active period; also the bonus unlock time.
     * @param signer_ The weight-voucher signer (the backend key).
     * @param rewardsWaived_ True when the pool pays no reward (the v3 campaign): `addRewards` is
     *        refused and `unstake` after the end pays the principal with a zero reward.
     */
    function initialize(
        address owner_,
        address stakingToken_,
        address rewardToken_,
        uint256 activationEpoch_,
        uint256 endEpoch_,
        address signer_,
        bool rewardsWaived_
    ) external initializer {
        require(stakingToken_ != address(0), "Invalid staking token");
        require(rewardToken_ != address(0), "Invalid reward token");
        require(stakingToken_ != rewardToken_, "Tokens must be different");
        require(endEpoch_ > activationEpoch_, "End must be after activation");
        require(signer_ != address(0), "Invalid signer");

        __Ownable_init(owner_);
        __Ownable2Step_init();
        __EIP712_init("WeightedStakingPool", "1");

        PoolStorage storage $ = _poolStorage();
        $.stakingToken = IERC20(stakingToken_);
        $.rewardToken = IERC20(rewardToken_);
        $.activationEpoch = activationEpoch_;
        $.endEpoch = endEpoch_;
        $.poolDuration = endEpoch_ - activationEpoch_;
        $.globalLastUpdateTime = activationEpoch_;
        $.signer = signer_;
        $.rewardsWaived = rewardsWaived_;

        emit PoolInitialized(stakingToken_, rewardToken_, activationEpoch_, endEpoch_, 0, 0, BPS_DENOMINATOR);
        emit SignerChanged(address(0), signer_);
        emit MigratorSet(address(0), address(0));
        emit BonusVaultSet(address(0), address(0));
        emit RewardsWaivedSet(rewardsWaived_);
    }

    // ──────────────────────── Internal helpers ─────────────────

    function _effectiveTime() internal view returns (uint256) {
        PoolStorage storage $ = _poolStorage();
        if (block.timestamp <= $.activationEpoch) return $.activationEpoch;
        if (block.timestamp >= $.endEpoch) return $.endEpoch;
        return block.timestamp;
    }

    function _updateGlobal() internal {
        PoolStorage storage $ = _poolStorage();
        uint256 t = _effectiveTime();
        if (t > $.globalLastUpdateTime && $.totalWeightedStaked > 0) {
            $.totalAccumulatedWeight += $.totalWeightedStaked * (t - $.globalLastUpdateTime);
        }
        $.globalLastUpdateTime = t;
    }

    function _updateUser(address user) internal {
        StakeInfo storage info = _poolStorage().stakes[user];
        uint256 t = _effectiveTime();
        if (info.amount > 0 && t > info.lastUpdateTime) {
            info.accumulatedWeight += info.amount * info.weight * (t - info.lastUpdateTime);
        }
        info.lastUpdateTime = t;
    }

    function _totalEffectiveWeight() internal view returns (uint256) {
        PoolStorage storage $ = _poolStorage();
        uint256 t = _effectiveTime();
        uint256 total = $.totalAccumulatedWeight;
        if ($.totalWeightedStaked > 0 && t > $.globalLastUpdateTime) {
            total += $.totalWeightedStaked * (t - $.globalLastUpdateTime);
        }
        return total - $.totalForfeitedWeight;
    }

    function _verifyWeightSignature(
        bytes32 typehash,
        address user,
        uint256 amount,
        uint256 weight,
        uint256 deadline,
        bytes calldata signature
    ) internal {
        _checkWeight(weight);
        require(signature.length != 0, "Signature required");
        require(block.timestamp <= deadline, "Signature expired");
        PoolStorage storage $ = _poolStorage();
        uint256 nonce = $.nonces[user]++;
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(typehash, user, amount, weight, nonce, deadline)));
        require(ECDSA.recover(digest, signature) == $.signer, "Invalid signature");
        emit NonceUsed(user, nonce);
    }

    function _checkWeight(uint256 weight) internal pure {
        require(weight >= BASE_WEIGHT && weight <= MAX_WEIGHT, "Invalid weight");
    }

    function _applyWeight(address user, uint256 newWeight) internal {
        PoolStorage storage $ = _poolStorage();
        StakeInfo storage info = $.stakes[user];
        uint256 oldWeight = info.weight;
        if (oldWeight == newWeight) return;
        if (info.amount > 0) {
            $.totalWeightedStaked = $.totalWeightedStaked + info.amount * newWeight - info.amount * oldWeight;
        }
        info.weight = newWeight;
        emit WeightUpdated(user, oldWeight, newWeight);
    }

    function _emitGlobal() private {
        PoolStorage storage $ = _poolStorage();
        emit GlobalUpdated(
            $.totalStaked,
            $.totalWeightedStaked,
            $.totalAccumulatedWeight,
            $.totalForfeitedWeight,
            $.totalPenalized,
            $.totalRewardsClaimed,
            _effectiveTime()
        );
    }

    function _emitStakeUpdated(address user) private {
        StakeInfo storage info = _poolStorage().stakes[user];
        emit StakeUpdated(user, info.amount, info.weight, info.accumulatedWeight, _effectiveTime());
    }

    /// @dev The shared tail of `stake` and `stakeFor`: pull from `msg.sender`, credit `user`.
    function _credit(address user, uint256 amount, uint256 weight) private {
        PoolStorage storage $ = _poolStorage();
        $.stakingToken.safeTransferFrom(msg.sender, address(this), amount);

        $.stakes[user].amount += amount;
        $.totalStaked += amount;
        $.totalWeightedStaked += amount * weight;

        emit Staked(user, amount, weight, $.totalStaked);
    }

    // ──────────────────────── User functions ───────────────────

    /// @notice Stake tokens. Allowed any time before endEpoch. Signature mandatory (v2 semantics).
    function stake(uint256 amount, uint256 weight, uint256 deadline, bytes calldata signature) external nonReentrant {
        require(block.timestamp < _poolStorage().endEpoch, "Pool has ended");
        require(amount > 0, "Amount must be > 0");

        _updateGlobal();
        _updateUser(msg.sender);

        _verifyWeightSignature(STAKE_TYPEHASH, msg.sender, amount, weight, deadline, signature);
        _applyWeight(msg.sender, weight);

        _credit(msg.sender, amount, weight);

        _emitStakeUpdated(msg.sender);
        _emitGlobal();
    }

    /**
     * @notice Stake `amount` for `user`, pulled from the caller. Only the registered migrator.
     * @param user The staker credited.
     * @param amount Tokens pulled from the migrator.
     * @param weight The multiplier attested in the migrator's `TransitionVoucher`; becomes the
     *        user's multiplier exactly as a `stake` would set it.
     */
    function stakeFor(address user, uint256 amount, uint256 weight) external nonReentrant {
        PoolStorage storage $ = _poolStorage();
        address migrator_ = $.migrator;
        if (msg.sender != migrator_) revert NotMigrator(msg.sender, migrator_);
        require(user != address(0), "Invalid user");
        require(block.timestamp < $.endEpoch, "Pool has ended");
        require(amount > 0, "Amount must be > 0");
        _checkWeight(weight);

        _updateGlobal();
        _updateUser(user);
        _applyWeight(user, weight);

        _credit(user, amount, weight);
        emit StakedFor(user, msg.sender, amount, weight);

        _emitStakeUpdated(user);
        _emitGlobal();
    }

    /// @notice Withdraw before endEpoch. The principal is returned IN FULL (v3 has no penalty).
    ///         During the active period the weight of the withdrawn share is forfeited. Either way
    ///         the bonus vault forfeits the user's whole v3 bonus reservation.
    function withdraw(uint256 amount, uint256 weight, uint256 deadline, bytes calldata signature)
        external
        nonReentrant
    {
        PoolStorage storage $ = _poolStorage();
        require(block.timestamp < $.endEpoch, "Use unstake after pool ends");
        require(amount > 0, "Amount must be > 0");

        _updateGlobal();
        _updateUser(msg.sender);

        StakeInfo storage info = $.stakes[msg.sender];
        require(info.amount > 0, "Nothing to withdraw");
        require(amount <= info.amount, "Amount exceeds stake");

        uint256 newWeight;
        if (signature.length == 0) {
            newWeight = BASE_WEIGHT;
        } else {
            _verifyWeightSignature(WITHDRAW_TYPEHASH, msg.sender, amount, weight, deadline, signature);
            newWeight = weight;
        }
        _applyWeight(msg.sender, newWeight);

        uint256 forfeitedWeight = 0;

        if (block.timestamp >= $.activationEpoch) {
            uint256 proportionalWeight = (info.accumulatedWeight * amount + info.amount - 1) / info.amount;
            if (proportionalWeight > info.accumulatedWeight) proportionalWeight = info.accumulatedWeight;
            $.totalForfeitedWeight += proportionalWeight;
            info.accumulatedWeight -= proportionalWeight;
            forfeitedWeight = proportionalWeight;
        }

        info.amount -= amount;
        $.totalStaked -= amount;
        $.totalWeightedStaked -= amount * newWeight;
        if (info.amount == 0) {
            _applyWeight(msg.sender, 0);
        }

        // After every state change, before any token leaves: the bonus is forfeited (fail closed).
        address bonusVault_ = $.bonusVault;
        if (bonusVault_ != address(0)) {
            IV3BonusVaultEarlyExit(bonusVault_).onEarlyExit(msg.sender);
        }

        $.stakingToken.safeTransfer(msg.sender, amount);

        emit Withdrawn(msg.sender, amount, forfeitedWeight, 0);
        _emitStakeUpdated(msg.sender);
        _emitGlobal();
    }

    /// @notice Update the caller's weight multiplier without moving tokens.
    function updateWeight(uint256 weight, uint256 deadline, bytes calldata signature) external nonReentrant {
        PoolStorage storage $ = _poolStorage();
        require(block.timestamp < $.endEpoch, "Pool has ended");
        StakeInfo storage info = $.stakes[msg.sender];
        require(info.amount > 0, "Nothing staked");

        _updateGlobal();
        _updateUser(msg.sender);

        _verifyWeightSignature(UPDATE_WEIGHT_TYPEHASH, msg.sender, info.amount, weight, deadline, signature);
        _applyWeight(msg.sender, weight);

        _emitStakeUpdated(msg.sender);
        _emitGlobal();
    }

    /// @notice Unstake after endEpoch: stake + pro-rata rewards. Reverts until rewards are funded,
    ///         unless the rewards are waived: then it pays the stake with a zero reward.
    function unstake() external nonReentrant returns (uint256 userReward) {
        PoolStorage storage $ = _poolStorage();
        require(block.timestamp >= $.endEpoch, "Pool not ended yet");
        require($.totalRewards > 0 || $.rewardsWaived, "Rewards not funded");

        _updateGlobal();
        _updateUser(msg.sender);

        StakeInfo storage info = $.stakes[msg.sender];
        require(info.amount > 0, "Nothing to unstake");

        uint256 amount = info.amount;
        uint256 userWeight = info.accumulatedWeight;
        uint256 totalEffective = _totalEffectiveWeight();

        if (totalEffective > 0) {
            userReward = ($.totalRewards * userWeight) / totalEffective;
        }

        $.totalWeightedStaked -= amount * info.weight;
        info.accumulatedWeight = 0;
        info.amount = 0;
        info.weight = 0;
        $.totalStaked -= amount;
        $.totalRewardsClaimed += userReward;
        $.claimedRewards[msg.sender] += userReward;

        $.stakingToken.safeTransfer(msg.sender, amount);
        if (userReward > 0) {
            $.rewardToken.safeTransfer(msg.sender, userReward);
        }

        emit Unstaked(msg.sender, amount, userReward, $.claimedRewards[msg.sender], userWeight, totalEffective);
        emit StakeUpdated(msg.sender, 0, 0, 0, _effectiveTime());
        _emitGlobal();
    }

    /// @notice Emergency unstake after endEpoch. Returns the full stake, no rewards.
    function emergencyUnstake() external nonReentrant {
        PoolStorage storage $ = _poolStorage();
        require(block.timestamp >= $.endEpoch, "Pool not ended yet");

        StakeInfo storage info = $.stakes[msg.sender];
        require(info.amount > 0, "Nothing to unstake");

        _updateGlobal();

        uint256 amount = info.amount;
        $.totalWeightedStaked -= amount * info.weight;
        info.amount = 0;
        info.weight = 0;
        info.accumulatedWeight = 0;
        info.lastUpdateTime = 0;
        $.totalStaked -= amount;

        $.stakingToken.safeTransfer(msg.sender, amount);

        emit EmergencyUnstaked(msg.sender, amount);
        emit StakeUpdated(msg.sender, 0, 0, 0, _effectiveTime());
        _emitGlobal();
    }

    // ──────────────────────── Owner functions ──────────────────

    /// @notice Change the address authorized to sign weight attestations.
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

    /// @notice Sets the bonus vault notified by an early `withdraw`, or zero to switch it off.
    function setBonusVault(address bonusVault_) external onlyOwner {
        PoolStorage storage $ = _poolStorage();
        emit BonusVaultSet($.bonusVault, bonusVault_);
        $.bonusVault = bonusVault_;
    }

    /// @notice Fund the reward pool (v2 semantics). Refused when the rewards are waived.
    function addRewards(uint256 amount) external onlyOwner {
        PoolStorage storage $ = _poolStorage();
        require(!$.rewardsWaived, "Rewards waived");
        require(amount > 0, "Amount must be > 0");
        $.rewardToken.safeTransferFrom(msg.sender, address(this), amount);
        $.totalRewards += amount;
        emit RewardsAdded(amount, $.totalRewards);
    }

    /// @notice Recover ERC20 tokens accidentally sent here (not the staking or the reward token).
    function recoverERC20(address token, uint256 amount) external onlyOwner {
        PoolStorage storage $ = _poolStorage();
        require(token != address($.stakingToken), "Cannot recover staking token");
        require(token != address($.rewardToken), "Cannot recover reward token");
        IERC20(token).safeTransfer(owner(), amount);
    }

    /// @notice Recover excess reward tokens. Only after the pool ends.
    function recoverExcessRewards() external onlyOwner {
        PoolStorage storage $ = _poolStorage();
        require(block.timestamp >= $.endEpoch, "Pool not ended yet");
        uint256 balance = $.rewardToken.balanceOf(address(this));
        uint256 recoverable;
        if (_totalEffectiveWeight() == 0 || $.totalStaked == 0) {
            recoverable = balance;
        } else {
            uint256 outstanding = $.totalRewards - $.totalRewardsClaimed;
            recoverable = balance > outstanding ? balance - outstanding : 0;
        }
        require(recoverable > 0, "Nothing to recover");
        $.rewardToken.safeTransfer(owner(), recoverable);
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

    function rewardToken() external view returns (address) {
        return address(_poolStorage().rewardToken);
    }

    function activationEpoch() external view returns (uint256) {
        return _poolStorage().activationEpoch;
    }

    function endEpoch() external view returns (uint256) {
        return _poolStorage().endEpoch;
    }

    function poolDuration() external view returns (uint256) {
        return _poolStorage().poolDuration;
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

    /// @notice True when the pool pays no reward: `addRewards` reverts and `unstake` pays the
    ///         principal with a zero reward after the end. Fixed by the initializer.
    function rewardsWaived() external view returns (bool) {
        return _poolStorage().rewardsWaived;
    }

    function totalStaked() external view returns (uint256) {
        return _poolStorage().totalStaked;
    }

    function totalWeightedStaked() external view returns (uint256) {
        return _poolStorage().totalWeightedStaked;
    }

    function totalAccumulatedWeight() external view returns (uint256) {
        return _poolStorage().totalAccumulatedWeight;
    }

    function totalForfeitedWeight() external view returns (uint256) {
        return _poolStorage().totalForfeitedWeight;
    }

    function globalLastUpdateTime() external view returns (uint256) {
        return _poolStorage().globalLastUpdateTime;
    }

    function totalRewards() external view returns (uint256) {
        return _poolStorage().totalRewards;
    }

    function totalRewardsClaimed() external view returns (uint256) {
        return _poolStorage().totalRewardsClaimed;
    }

    /// @notice Deprecated: v3 has no principal penalty and never adds to this counter. Zero on a fresh
    ///         deploy; on Sepolia stack #6 it keeps what the first implementation recorded.
    function totalPenalized() external view returns (uint256) {
        return _poolStorage().totalPenalized;
    }

    /// @notice The v2 `stakes(user)` getter shape: amount, weight, accumulatedWeight, lastUpdateTime.
    function stakes(address user)
        external
        view
        returns (uint256 amount, uint256 weight, uint256 accumulatedWeight, uint256 lastUpdateTime)
    {
        StakeInfo storage info = _poolStorage().stakes[user];
        return (info.amount, info.weight, info.accumulatedWeight, info.lastUpdateTime);
    }

    function claimedRewards(address user) external view returns (uint256) {
        return _poolStorage().claimedRewards[user];
    }

    function nonces(address user) external view returns (uint256) {
        return _poolStorage().nonces[user];
    }

    function getUserWeight(address user) external view returns (uint256) {
        StakeInfo storage info = _poolStorage().stakes[user];
        uint256 t = _effectiveTime();
        uint256 w = info.accumulatedWeight;
        if (info.amount > 0 && t > info.lastUpdateTime) {
            w += info.amount * info.weight * (t - info.lastUpdateTime);
        }
        return w;
    }

    function getUserMultiplier(address user) external view returns (uint256) {
        return _poolStorage().stakes[user].weight;
    }

    function getTotalEffectiveWeight() external view returns (uint256) {
        return _totalEffectiveWeight();
    }

    function getPendingReward(address user) external view returns (uint256) {
        PoolStorage storage $ = _poolStorage();
        StakeInfo storage info = $.stakes[user];
        uint256 t = _effectiveTime();
        uint256 w = info.accumulatedWeight;
        if (info.amount > 0 && t > info.lastUpdateTime) {
            w += info.amount * info.weight * (t - info.lastUpdateTime);
        }
        uint256 totalEffective = _totalEffectiveWeight();
        if (totalEffective == 0 || $.totalRewards == 0) return 0;
        return ($.totalRewards * w) / totalEffective;
    }
}
