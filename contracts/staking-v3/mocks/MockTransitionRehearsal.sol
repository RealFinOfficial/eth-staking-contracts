// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.38;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockTokenMessengerV2
 * @notice TEST ONLY. Records a CCTP V2 `depositForBurn` exactly as Circle's TokenMessengerV2 takes it
 *         (the token is pulled from the caller), for the unit suite of the transition rehearsal
 *         commands (`scripts/lib/transition-rehearsal.js`).
 */
contract MockTokenMessengerV2 {
    using SafeERC20 for IERC20;

    struct Deposit {
        uint256 amount;
        uint32 destinationDomain;
        bytes32 mintRecipient;
        address burnToken;
        bytes32 destinationCaller;
        uint256 maxFee;
        uint32 minFinalityThreshold;
        address sender;
    }

    Deposit public last;

    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external {
        IERC20(burnToken).safeTransferFrom(msg.sender, address(this), amount);
        last = Deposit(
            amount, destinationDomain, mintRecipient, burnToken, destinationCaller, maxFee, minFinalityThreshold, msg.sender
        );
    }
}

/**
 * @title MockMessageTransmitterV2
 * @notice TEST ONLY. `receiveMessage` pays out of its own USDC balance what the "message" encodes as
 *         `abi.encode(recipient, amount)`; the attestation must be non-empty. Stands in for Circle's
 *         MessageTransmitterV2 in the unit suite of the rehearsal commands.
 */
contract MockMessageTransmitterV2 {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;

    constructor(address usdc_) {
        usdc = IERC20(usdc_);
    }

    function receiveMessage(bytes calldata message, bytes calldata attestation) external returns (bool) {
        require(attestation.length > 0, "no attestation");
        (address recipient, uint256 amount) = abi.decode(message, (address, uint256));
        usdc.safeTransfer(recipient, amount);
        return true;
    }
}

/**
 * @title MockUnstakeSource
 * @notice TEST ONLY. A source staking contract whose `unstake()` pays the caller a fixed principal and
 *         reward and emits the v2.0 contract's `Unstaked` event, for the rehearsal's `tr-unstake`.
 */
contract MockUnstakeSource {
    using SafeERC20 for IERC20;

    IERC20 public immutable stakingToken;
    IERC20 public immutable rewardToken;
    uint256 public immutable principal;
    uint256 public immutable reward;

    event Unstaked(
        address indexed user,
        uint256 amount,
        uint256 reward,
        uint256 claimedRewards,
        uint256 userWeight,
        uint256 totalEffectiveWeight
    );

    constructor(address stakingToken_, address rewardToken_, uint256 principal_, uint256 reward_) {
        stakingToken = IERC20(stakingToken_);
        rewardToken = IERC20(rewardToken_);
        principal = principal_;
        reward = reward_;
    }

    function unstake() external returns (uint256) {
        stakingToken.safeTransfer(msg.sender, principal);
        rewardToken.safeTransfer(msg.sender, reward);
        emit Unstaked(msg.sender, principal, reward, 0, 0, 0);
        return reward;
    }
}
