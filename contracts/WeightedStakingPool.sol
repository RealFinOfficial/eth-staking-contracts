// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title WeightedStakingPool
 * @notice Staking pool with time-weighted USDC reward distribution and per-user
 *         weight multipliers attested by an off-chain signer (EIP-712).
 *
 *  Weight multiplier:
 *    - Each user has a single multiplier for their entire stake, in BASE_WEIGHT units
 *      (1000 = x1.0, 2000 = x2.0). Effective weight accrues as amount * multiplier * seconds.
 *    - A multiplier above BASE_WEIGHT requires an EIP-712 signature from `signer` over
 *      (user, amount, weight, nonce, deadline). weight == BASE_WEIGHT never needs a signature.
 *    - signature == 0x on stake means "no weight change" (weight param is ignored),
 *      except on a user's first stake where the weight param is always read and must
 *      be BASE_WEIGHT when unsigned.
 *    - signature == 0x on withdraw resets the multiplier to BASE_WEIGHT — the boost is
 *      tied to the attested amount, so reducing the stake without a fresh attestation
 *      drops the boost.
 *    - On every multiplier change the accrued weight is checkpointed at the old
 *      multiplier before the new one takes effect.
 *
 *  Lifecycle (same as StakingPool):
 *    1. Deploy with activationEpoch & endEpoch — staking possible immediately
 *    2. Before activationEpoch — stake/withdraw freely, no rewards accrue
 *    3. activationEpoch -> endEpoch — active period, weight accumulates, withdraw = forfeit + penalty
 *    4. After endEpoch — unstake returns staked tokens + proportional USDC rewards
 */
contract WeightedStakingPool is Ownable, ReentrancyGuard, EIP712 {
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

    bytes32 public constant STAKE_TYPEHASH =
        keccak256("Stake(address user,uint256 amount,uint256 weight,uint256 nonce,uint256 deadline)");
    bytes32 public constant WITHDRAW_TYPEHASH =
        keccak256("Withdraw(address user,uint256 amount,uint256 weight,uint256 nonce,uint256 deadline)");
    bytes32 public constant UPDATE_WEIGHT_TYPEHASH =
        keccak256("UpdateWeight(address user,uint256 amount,uint256 weight,uint256 nonce,uint256 deadline)");

    address public constant PENALTY_RECEIVER = 0xD6719Ce10F1b499Bd8FE022AB045b991b996dA6a;

    // ──────────────────────── State ────────────────────────────

    IERC20  public immutable stakingToken;
    IERC20  public immutable rewardToken;
    uint256 public immutable activationEpoch;
    uint256 public immutable endEpoch;
    uint256 public immutable poolDuration;

    address public signer;

    uint256 public totalStaked;
    uint256 public totalWeightedStaked; // sum of amount * weight over all stakers
    uint256 public totalAccumulatedWeight;
    uint256 public totalForfeitedWeight;
    uint256 public globalLastUpdateTime;

    uint256 public totalRewards;
    uint256 public totalRewardsClaimed;
    uint256 public totalPenalized;

    mapping(address => StakeInfo) public stakes;
    mapping(address => uint256)   public claimedRewards;
    mapping(address => uint256)   public nonces;

    // ──────────────────────── Events ───────────────────────────

    event Staked(address indexed user, uint256 amount, uint256 weight, uint256 totalStaked);
    event Withdrawn(address indexed user, uint256 amount, uint256 forfeitedWeight, uint256 penalty);
    event Unstaked(address indexed user, uint256 amount, uint256 reward, uint256 userWeight, uint256 totalEffectiveWeight);
    event EmergencyUnstaked(address indexed user, uint256 amount);
    event RewardsAdded(uint256 amount, uint256 totalRewards);
    event StakeUpdated(address indexed user, uint256 amount, uint256 accumulatedWeight);
    event WeightUpdated(address indexed user, uint256 oldWeight, uint256 newWeight);
    event NonceUsed(address indexed user, uint256 nonce);
    event SignerChanged(address indexed oldSigner, address indexed newSigner);
    event GlobalUpdated(uint256 totalStaked, uint256 totalAccumulatedWeight, uint256 totalForfeitedWeight, uint256 timestamp);
    event PoolInitialized(address indexed stakingToken, address indexed rewardToken, uint256 activationEpoch, uint256 endEpoch);

    // ──────────────────────── Constructor ──────────────────────

    constructor(
        address _stakingToken,
        address _rewardToken,
        uint256 _activationEpoch,
        uint256 _endEpoch,
        address _signer
    ) Ownable(msg.sender) EIP712("WeightedStakingPool", "1") {
        require(_stakingToken != address(0), "Invalid staking token");
        require(_rewardToken != address(0), "Invalid reward token");
        require(_stakingToken != _rewardToken, "Tokens must be different");
        require(_endEpoch > _activationEpoch, "End must be after activation");
        require(_signer != address(0), "Invalid signer");

        stakingToken = IERC20(_stakingToken);
        rewardToken = IERC20(_rewardToken);
        activationEpoch = _activationEpoch;
        endEpoch = _endEpoch;
        poolDuration = _endEpoch - _activationEpoch;
        globalLastUpdateTime = _activationEpoch;
        signer = _signer;

        emit PoolInitialized(_stakingToken, _rewardToken, _activationEpoch, _endEpoch);
        emit SignerChanged(address(0), _signer);
    }

    // ──────────────────────── Internal helpers ─────────────────

    function _effectiveTime() internal view returns (uint256) {
        if (block.timestamp <= activationEpoch) return activationEpoch;
        if (block.timestamp >= endEpoch) return endEpoch;
        return block.timestamp;
    }

    function _updateGlobal() internal {
        uint256 t = _effectiveTime();
        if (t > globalLastUpdateTime && totalWeightedStaked > 0) {
            totalAccumulatedWeight += totalWeightedStaked * (t - globalLastUpdateTime);
        }
        globalLastUpdateTime = t;
    }

    function _updateUser(address user) internal {
        StakeInfo storage info = stakes[user];
        uint256 t = _effectiveTime();
        if (info.amount > 0 && t > info.lastUpdateTime) {
            info.accumulatedWeight += info.amount * info.weight * (t - info.lastUpdateTime);
        }
        info.lastUpdateTime = t;
    }

    function _totalEffectiveWeight() internal view returns (uint256) {
        uint256 t = _effectiveTime();
        uint256 total = totalAccumulatedWeight;
        if (totalWeightedStaked > 0 && t > globalLastUpdateTime) {
            total += totalWeightedStaked * (t - globalLastUpdateTime);
        }
        return total - totalForfeitedWeight;
    }

    function _calculatePenalty(uint256 amount) internal view returns (uint256) {
        if (owner() == address(0)) return 0;
        if (block.timestamp < activationEpoch) return 0;
        if (block.timestamp >= endEpoch) return 0;
        uint256 remaining = endEpoch - block.timestamp;
        return (amount * remaining) / (poolDuration * 2);
    }

    /// @dev Verifies an EIP-712 weight attestation and consumes the user's nonce.
    function _verifyWeightSignature(
        bytes32 typehash,
        address user,
        uint256 amount,
        uint256 weight,
        uint256 deadline,
        bytes calldata signature
    ) internal {
        require(block.timestamp <= deadline, "Signature expired");
        uint256 nonce = nonces[user]++;
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(typehash, user, amount, weight, nonce, deadline))
        );
        require(ECDSA.recover(digest, signature) == signer, "Invalid signature");
        // Emitted exactly when a nonce is consumed, across stake/withdraw/updateWeight —
        // lets the backend track the next nonce from events instead of eth_call.
        emit NonceUsed(user, nonce);
    }

    /// @dev Resolves the multiplier that applies after this call.
    ///      - empty signature: keep current weight ("no change"); on first stake the
    ///        weight param is read and must equal BASE_WEIGHT
    ///      - weight == BASE_WEIGHT: no signature verification needed
    ///      - otherwise: valid signer attestation over (user, amount, weight, nonce, deadline)
    function _resolveWeight(
        bytes32 typehash,
        address user,
        uint256 amount,
        uint256 weight,
        uint256 deadline,
        bytes calldata signature
    ) internal returns (uint256) {
        uint256 current = stakes[user].weight;
        if (signature.length == 0) {
            if (current == 0) {
                require(weight == BASE_WEIGHT, "Signature required");
                return BASE_WEIGHT;
            }
            return current;
        }
        require(weight >= BASE_WEIGHT && weight <= MAX_WEIGHT, "Invalid weight");
        if (weight == BASE_WEIGHT) return BASE_WEIGHT;
        _verifyWeightSignature(typehash, user, amount, weight, deadline, signature);
        return weight;
    }

    /// @dev Applies a new multiplier. Caller must have checkpointed accruals
    ///      (_updateGlobal + _updateUser) beforehand.
    function _applyWeight(address user, uint256 newWeight) internal {
        StakeInfo storage info = stakes[user];
        uint256 oldWeight = info.weight;
        if (oldWeight == newWeight) return;
        if (info.amount > 0) {
            totalWeightedStaked = totalWeightedStaked + info.amount * newWeight - info.amount * oldWeight;
        }
        info.weight = newWeight;
        emit WeightUpdated(user, oldWeight, newWeight);
    }

    // ──────────────────────── User functions ───────────────────

    /// @notice Stake tokens. Allowed any time before endEpoch.
    /// @param amount   Tokens to stake.
    /// @param weight   Multiplier in BASE_WEIGHT units. Ignored when signature is empty,
    ///                 except on first stake (must then be BASE_WEIGHT).
    /// @param deadline Signature expiry timestamp. Ignored when signature is empty.
    /// @param signature EIP-712 signer attestation, or 0x for no weight change.
    function stake(uint256 amount, uint256 weight, uint256 deadline, bytes calldata signature)
        external
        nonReentrant
    {
        require(owner() != address(0), "Staking disabled");
        require(block.timestamp < endEpoch, "Pool has ended");
        require(amount > 0, "Amount must be > 0");

        _updateGlobal();
        _updateUser(msg.sender);

        uint256 newWeight = _resolveWeight(STAKE_TYPEHASH, msg.sender, amount, weight, deadline, signature);
        _applyWeight(msg.sender, newWeight);

        stakingToken.safeTransferFrom(msg.sender, address(this), amount);

        stakes[msg.sender].amount += amount;
        totalStaked += amount;
        totalWeightedStaked += amount * newWeight;

        emit Staked(msg.sender, amount, newWeight, totalStaked);
        emit StakeUpdated(msg.sender, stakes[msg.sender].amount, stakes[msg.sender].accumulatedWeight);
        emit GlobalUpdated(totalStaked, totalAccumulatedWeight, totalForfeitedWeight, _effectiveTime());
    }

    /// @notice Withdraw before endEpoch. Before activation: free. During active: forfeit weight + penalty.
    /// @param amount   Tokens to withdraw.
    /// @param weight   New multiplier for the remaining stake (signed), ignored when signature is empty.
    /// @param deadline Signature expiry timestamp. Ignored when signature is empty.
    /// @param signature EIP-712 signer attestation; 0x resets the multiplier to BASE_WEIGHT.
    function withdraw(uint256 amount, uint256 weight, uint256 deadline, bytes calldata signature)
        external
        nonReentrant
    {
        require(block.timestamp < endEpoch, "Use unstake after pool ends");
        require(amount > 0, "Amount must be > 0");

        _updateGlobal();
        _updateUser(msg.sender);

        StakeInfo storage info = stakes[msg.sender];
        require(info.amount > 0, "Nothing to withdraw");
        require(amount <= info.amount, "Amount exceeds stake");

        // Unsigned withdraw resets the boost: the multiplier was attested for the
        // pre-withdraw amount, so keeping it on a smaller stake needs a fresh signature.
        uint256 newWeight = signature.length == 0
            ? BASE_WEIGHT
            : _resolveWeight(WITHDRAW_TYPEHASH, msg.sender, amount, weight, deadline, signature);
        _applyWeight(msg.sender, newWeight);

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
        totalWeightedStaked -= amount * newWeight;
        if (info.amount == 0) {
            _applyWeight(msg.sender, 0); // weight resets with the stake; next stake sets it anew
        }

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

    /// @notice Update the caller's weight multiplier without moving tokens.
    ///         The attestation is signed over the caller's current staked amount.
    function updateWeight(uint256 weight, uint256 deadline, bytes calldata signature)
        external
        nonReentrant
    {
        require(block.timestamp < endEpoch, "Pool has ended");
        StakeInfo storage info = stakes[msg.sender];
        require(info.amount > 0, "Nothing staked");

        _updateGlobal();
        _updateUser(msg.sender);

        uint256 newWeight;
        if (signature.length == 0) {
            require(weight == BASE_WEIGHT, "Signature required");
            newWeight = BASE_WEIGHT;
        } else {
            newWeight = _resolveWeight(UPDATE_WEIGHT_TYPEHASH, msg.sender, info.amount, weight, deadline, signature);
        }
        _applyWeight(msg.sender, newWeight);

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

        totalWeightedStaked -= amount * info.weight;
        info.accumulatedWeight = 0;
        info.amount = 0;
        info.weight = 0;
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

        // Snapshot global weight before changing totalWeightedStaked
        _updateGlobal();

        uint256 amount = info.amount;
        totalWeightedStaked -= amount * info.weight;
        info.amount = 0;
        info.weight = 0;
        info.accumulatedWeight = 0;
        info.lastUpdateTime = 0;
        totalStaked -= amount;

        stakingToken.safeTransfer(msg.sender, amount);

        emit EmergencyUnstaked(msg.sender, amount);
        emit StakeUpdated(msg.sender, 0, 0);
        emit GlobalUpdated(totalStaked, totalAccumulatedWeight, totalForfeitedWeight, _effectiveTime());
    }

    // ──────────────────────── Owner functions ──────────────────

    /// @notice Change the address authorized to sign weight attestations.
    function setSigner(address _signer) external onlyOwner {
        require(_signer != address(0), "Invalid signer");
        emit SignerChanged(signer, _signer);
        signer = _signer;
    }

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

    /// @notice Current accrued weight of a user (amount x multiplier x seconds, in BASE_WEIGHT units)
    function getUserWeight(address user) external view returns (uint256) {
        StakeInfo storage info = stakes[user];
        uint256 t = _effectiveTime();
        uint256 w = info.accumulatedWeight;
        if (info.amount > 0 && t > info.lastUpdateTime) {
            w += info.amount * info.weight * (t - info.lastUpdateTime);
        }
        return w;
    }

    /// @notice Current weight multiplier of a user (BASE_WEIGHT units, 0 if no stake)
    function getUserMultiplier(address user) external view returns (uint256) {
        return stakes[user].weight;
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
            w += info.amount * info.weight * (t - info.lastUpdateTime);
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
