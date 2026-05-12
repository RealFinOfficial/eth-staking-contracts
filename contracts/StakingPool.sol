// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title StakingPool
 * @notice Staking pool with time-weighted USDC reward distribution.
 *
 *  Lifecycle:
 *    1. Deploy with activationEpoch & endEpoch — staking possible immediately
 *    2. Before activationEpoch — stake/withdraw freely, no rewards accrue
 *    3. activationEpoch -> endEpoch — active period, weight accumulates, withdraw = forfeit + penalty
 *    4. After endEpoch — unstake returns staked tokens + proportional USDC rewards
 */
contract StakingPool is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ──────────────────────── Structures ────────────────────────

    struct StakeInfo {
        uint256 amount;
        uint256 accumulatedWeight;
        uint256 lastUpdateTime;
    }

    // ──────────────────────── State ────────────────────────────

    IERC20  public immutable stakingToken;
    IERC20  public immutable rewardToken;
    uint256 public immutable activationEpoch;
    uint256 public immutable endEpoch;
    uint256 public immutable poolDuration;

    address public constant PENALTY_RECEIVER = 0xD6719Ce10F1b499Bd8FE022AB045b991b996dA6a;

    uint256 public totalStaked;
    uint256 public totalAccumulatedWeight;
    uint256 public totalForfeitedWeight;
    uint256 public globalLastUpdateTime;

    uint256 public totalRewards;
    uint256 public totalRewardsClaimed;
    uint256 public totalPenalized;

    mapping(address => StakeInfo) public stakes;
    mapping(address => uint256)   public claimedRewards;

    // ──────────────────────── Events ───────────────────────────

    event Staked(address indexed user, uint256 amount, uint256 totalStaked);
    event Withdrawn(address indexed user, uint256 amount, uint256 forfeitedWeight, uint256 penalty);
    event Unstaked(address indexed user, uint256 amount, uint256 reward, uint256 userWeight, uint256 totalEffectiveWeight);
    event EmergencyUnstaked(address indexed user, uint256 amount);
    event RewardsAdded(uint256 amount, uint256 totalRewards);
    event StakeUpdated(address indexed user, uint256 amount, uint256 accumulatedWeight);
    event GlobalUpdated(uint256 totalStaked, uint256 totalAccumulatedWeight, uint256 totalForfeitedWeight, uint256 timestamp);

    // ──────────────────────── Constructor ──────────────────────

    constructor(
        address _stakingToken,
        address _rewardToken,
        uint256 _activationEpoch,
        uint256 _endEpoch
    ) Ownable(msg.sender) {
        require(_stakingToken != address(0), "Invalid staking token");
        require(_rewardToken != address(0), "Invalid reward token");
        require(_stakingToken != _rewardToken, "Tokens must be different");
        require(_endEpoch > _activationEpoch, "End must be after activation");

        stakingToken = IERC20(_stakingToken);
        rewardToken = IERC20(_rewardToken);
        activationEpoch = _activationEpoch;
        endEpoch = _endEpoch;
        poolDuration = _endEpoch - _activationEpoch;
        globalLastUpdateTime = _activationEpoch;
    }

    // ──────────────────────── Internal helpers ─────────────────

    function _effectiveTime() internal view returns (uint256) {
        if (block.timestamp <= activationEpoch) return activationEpoch;
        if (block.timestamp >= endEpoch) return endEpoch;
        return block.timestamp;
    }

    function _updateGlobal() internal {
        uint256 t = _effectiveTime();
        if (t > globalLastUpdateTime && totalStaked > 0) {
            totalAccumulatedWeight += totalStaked * (t - globalLastUpdateTime);
        }
        globalLastUpdateTime = t;
    }

    function _updateUser(address user) internal {
        StakeInfo storage info = stakes[user];
        uint256 t = _effectiveTime();
        if (info.amount > 0 && t > info.lastUpdateTime) {
            info.accumulatedWeight += info.amount * (t - info.lastUpdateTime);
        }
        info.lastUpdateTime = t;
    }

    function _totalEffectiveWeight() internal view returns (uint256) {
        uint256 t = _effectiveTime();
        uint256 total = totalAccumulatedWeight;
        if (totalStaked > 0 && t > globalLastUpdateTime) {
            total += totalStaked * (t - globalLastUpdateTime);
        }
        return total - totalForfeitedWeight;
    }

    function _calculatePenalty(uint256 amount) internal view returns (uint256) {
        if (block.timestamp < activationEpoch) return 0;
        if (block.timestamp >= endEpoch) return 0;
        uint256 remaining = endEpoch - block.timestamp;
        return (amount * remaining) / (poolDuration * 2);
    }

    // ──────────────────────── User functions ───────────────────

    /// @notice Stake tokens. Allowed any time before endEpoch.
    function stake(uint256 amount) external nonReentrant {
        require(block.timestamp < endEpoch, "Pool has ended");
        require(amount > 0, "Amount must be > 0");

        _updateGlobal();
        _updateUser(msg.sender);

        stakingToken.safeTransferFrom(msg.sender, address(this), amount);

        stakes[msg.sender].amount += amount;
        totalStaked += amount;

        emit Staked(msg.sender, amount, totalStaked);
        emit StakeUpdated(msg.sender, stakes[msg.sender].amount, stakes[msg.sender].accumulatedWeight);
        emit GlobalUpdated(totalStaked, totalAccumulatedWeight, totalForfeitedWeight, _effectiveTime());
    }

    /// @notice Withdraw before endEpoch. Before activation: free. During active: forfeit weight + penalty.
    function withdraw(uint256 amount) external nonReentrant {
        require(block.timestamp < endEpoch, "Use unstake after pool ends");
        require(amount > 0, "Amount must be > 0");

        _updateGlobal();
        _updateUser(msg.sender);

        StakeInfo storage info = stakes[msg.sender];
        require(info.amount > 0, "Nothing to withdraw");
        require(amount <= info.amount, "Amount exceeds stake");

        uint256 forfeitedWeight = 0;
        uint256 penalty = 0;

        if (block.timestamp >= activationEpoch) {
            uint256 proportionalWeight = (info.accumulatedWeight * amount + info.amount - 1) / info.amount;
            if (proportionalWeight > info.accumulatedWeight) proportionalWeight = info.accumulatedWeight;
            totalForfeitedWeight += proportionalWeight;
            info.accumulatedWeight -= proportionalWeight;
            forfeitedWeight = proportionalWeight;

            penalty = _calculatePenalty(amount);
        }

        info.amount -= amount;
        totalStaked -= amount;

        uint256 userReceives = amount - penalty;
        if (penalty > 0) {
            totalPenalized += penalty;
            stakingToken.safeTransfer(PENALTY_RECEIVER, penalty);
        }
        stakingToken.safeTransfer(msg.sender, userReceives);

        emit Withdrawn(msg.sender, amount, forfeitedWeight, penalty);
        emit StakeUpdated(msg.sender, info.amount, info.accumulatedWeight);
        emit GlobalUpdated(totalStaked, totalAccumulatedWeight, totalForfeitedWeight, _effectiveTime());
    }

    /// @notice Unstake after endEpoch. Returns full stake + proportional USDC rewards.
    function unstake() external nonReentrant returns (uint256 userReward) {
        require(block.timestamp >= endEpoch, "Pool not ended yet");

        _updateGlobal();
        _updateUser(msg.sender);

        StakeInfo storage info = stakes[msg.sender];
        require(info.amount > 0, "Nothing to unstake");

        uint256 amount = info.amount;
        uint256 userWeight = info.accumulatedWeight;
        uint256 totalEffective = _totalEffectiveWeight();

        if (totalEffective > 0 && totalRewards > 0) {
            userReward = (totalRewards * userWeight) / totalEffective;
        }

        info.accumulatedWeight = 0;
        info.amount = 0;
        totalStaked -= amount;
        totalRewardsClaimed += userReward;
        claimedRewards[msg.sender] += userReward;

        stakingToken.safeTransfer(msg.sender, amount);
        if (userReward > 0) {
            rewardToken.safeTransfer(msg.sender, userReward);
        }

        emit Unstaked(msg.sender, amount, userReward, userWeight, totalEffective);
        emit StakeUpdated(msg.sender, 0, 0);
        emit GlobalUpdated(totalStaked, totalAccumulatedWeight, totalForfeitedWeight, _effectiveTime());
    }

    /// @notice Emergency unstake after endEpoch. Returns full stake but forfeits all rewards.
    function emergencyUnstake() external nonReentrant {
        require(block.timestamp >= endEpoch, "Pool not ended yet");

        StakeInfo storage info = stakes[msg.sender];
        require(info.amount > 0, "Nothing to unstake");

        // Snapshot global weight before changing totalStaked
        _updateGlobal();

        uint256 amount = info.amount;
        info.amount = 0;
        info.accumulatedWeight = 0;
        info.lastUpdateTime = 0;
        totalStaked -= amount;

        stakingToken.safeTransfer(msg.sender, amount);

        emit EmergencyUnstaked(msg.sender, amount);
        emit StakeUpdated(msg.sender, 0, 0);
        emit GlobalUpdated(totalStaked, totalAccumulatedWeight, totalForfeitedWeight, _effectiveTime());
    }

    // ──────────────────────── Owner functions ──────────────────

    /// @notice Fund the reward pool. Transfers USDC from caller into the contract.
    function addRewards(uint256 amount) external onlyOwner {
        require(amount > 0, "Amount must be > 0");
        rewardToken.safeTransferFrom(msg.sender, address(this), amount);
        totalRewards += amount;
        emit RewardsAdded(amount, totalRewards);
    }

    /// @notice Recover ERC20 tokens accidentally sent to this contract (not staking or reward token).
    function recoverERC20(address token, uint256 amount) external onlyOwner {
        require(token != address(stakingToken), "Cannot recover staking token");
        require(token != address(rewardToken), "Cannot recover reward token");
        IERC20(token).safeTransfer(owner(), amount);
    }

    /// @notice Recover excess reward tokens (overfunded or unclaimed due to rounding). Only after pool ends.
    function recoverExcessRewards() external onlyOwner {
        require(block.timestamp >= endEpoch, "Pool not ended yet");
        uint256 balance = rewardToken.balanceOf(address(this));
        uint256 recoverable;
        if (_totalEffectiveWeight() == 0 || totalStaked == 0) {
            recoverable = balance;
        } else {
            uint256 outstanding = totalRewards - totalRewardsClaimed;
            recoverable = balance > outstanding ? balance - outstanding : 0;
        }
        require(recoverable > 0, "Nothing to recover");
        rewardToken.safeTransfer(owner(), recoverable);
    }

    // ──────────────────────── View functions ───────────────────

    /// @notice Current weight of a user (amount x seconds in active period)
    function getUserWeight(address user) external view returns (uint256) {
        StakeInfo storage info = stakes[user];
        uint256 t = _effectiveTime();
        uint256 w = info.accumulatedWeight;
        if (info.amount > 0 && t > info.lastUpdateTime) {
            w += info.amount * (t - info.lastUpdateTime);
        }
        return w;
    }

    /// @notice Total effective weight (excluding forfeited)
    function getTotalEffectiveWeight() external view returns (uint256) {
        return _totalEffectiveWeight();
    }

    /// @notice Pending USDC reward for a user based on current weight and totalRewards
    function getPendingReward(address user) external view returns (uint256) {
        StakeInfo storage info = stakes[user];
        uint256 t = _effectiveTime();
        uint256 w = info.accumulatedWeight;
        if (info.amount > 0 && t > info.lastUpdateTime) {
            w += info.amount * (t - info.lastUpdateTime);
        }
        uint256 totalEffective = _totalEffectiveWeight();
        if (totalEffective == 0 || totalRewards == 0) return 0;
        return (totalRewards * w) / totalEffective;
    }

    /// @notice Current withdrawal penalty in basis points (0-5000). 0 before activation and after end.
    function getCurrentPenaltyPct() external view returns (uint256) {
        if (block.timestamp < activationEpoch) return 0;
        if (block.timestamp >= endEpoch) return 0;
        uint256 remaining = endEpoch - block.timestamp;
        return (5000 * remaining) / poolDuration;
    }

    /// @notice Current withdrawal penalty in wei for a user's full stake.
    function getCurrentPenalty(address user) external view returns (uint256) {
        uint256 amount = stakes[user].amount;
        if (amount == 0) return 0;
        return _calculatePenalty(amount);
    }
}
