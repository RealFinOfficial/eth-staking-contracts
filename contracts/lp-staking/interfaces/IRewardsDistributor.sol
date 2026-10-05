// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IRewardsDistributor
 * @notice The external surface of `RewardsDistributor` v1 (multi-token), frozen for the
 *         indexer, the backend signer, the frontend and `LPEpochRegistry`.
 *
 *  One voucher type for every reward token:
 *
 *      RewardClaim(address token,address user,uint256 cumulativeAmount,uint256 deadline)
 *
 *  signed under the EIP-712 domain `("RealLPRewards", "1", chainId, distributor proxy)`.
 *  The `token` field is part of the signed struct, so a voucher signed for one token can never
 *  be redeemed for another, and the ledger is kept per token: `claimed(token, user)`.
 *
 *  Every reward token is a PRE-FUNDED TRANSFER token. Nothing is minted at claim time. A claim
 *  pays exactly `cumulativeAmount - claimed(token, user)` out of the distributor's own balance
 *  of that token, and when that balance is short the claim reverts with {InsufficientFunds}
 *  until the company funds the contract. There is no cap, no budget, no running total and no
 *  other bound on what a valid voucher pays.
 *
 *  Ownable2Step / UUPS members (`owner`, `pendingOwner`, `transferOwnership`,
 *  `acceptOwnership`, `upgradeToAndCall`, `proxiableUUID`) and ERC-5267 `eip712Domain` are
 *  inherited from OpenZeppelin and are not repeated here.
 */
interface IRewardsDistributor {
    // ──────────────────────── Types ────────────────────────────

    /// @notice One reward token as passed to `initialize`.
    /// @param token          The ERC-20 paid by this leg. A plain ERC-20 (see `addRewardToken`).
    /// @param conditional    Off-chain meaning only: the backend forfeits a conditional token's
    ///                       accrued amount when a position is unstaked. The contract stores it
    ///                       for the indexer and never reads it.
    /// @param claimsEnabled  Whether `claim` pays this token from the start.
    struct RewardTokenInit {
        address token;
        bool conditional;
        bool claimsEnabled;
    }

    /// @notice The stored state of one reward token. Packed into one slot.
    /// @param registered     True once `addRewardToken` (or `initialize`) has seen the token.
    ///                       Never cleared: a token is never removed, only disabled.
    /// @param enabled        True while the token may be scheduled in `LPEpochRegistry`
    ///                       (`isRewardToken`). Does not gate `claim`.
    /// @param conditional    See {RewardTokenInit}.
    /// @param claimsEnabled  True while `claim` pays this token.
    /// @param decimals       `decimals()` read from the token when it was added.
    struct RewardToken {
        bool registered;
        bool enabled;
        bool conditional;
        bool claimsEnabled;
        uint8 decimals;
    }

    // ──────────────────────── Events ───────────────────────────

    /// @notice A claim paid out. Byte-identical to the pre-v1 event, so the indexer and the
    ///         backend parse it unchanged. `token` is the reward token paid.
    event Claimed(
        address indexed user,
        address indexed token,
        uint256 cumulativeAmount,
        uint256 paidAmount,
        uint256 timestamp
    );

    /// @notice A reward token joined the program. Full state of the new entry.
    event RewardTokenAdded(address indexed token, bool conditional, bool claimsEnabled, uint8 decimals, string symbol);

    /// @notice One of the two switches of a reward token changed. Carries the FULL new state of
    ///         both switches, whichever setter emitted it.
    event RewardTokenUpdated(address indexed token, bool enabled, bool claimsEnabled);

    /// @notice The operator moved a token balance out of the distributor to itself.
    event ExcessRecovered(address indexed token, address to, uint256 amount, uint256 timestamp);

    /// @notice The voucher signer changed. Carries both sides.
    event SignerChanged(address previousSigner, address newSigner);

    /// @notice The claim pause switch changed. Full new state.
    event Paused(bool paused);

    /// @notice The fast-path guardian changed. Carries both sides.
    event GuardianSet(address previousGuardian, address newGuardian);

    /// @notice The routine-operations tier changed. Carries both sides.
    event OperatorSet(address previousOperator, address newOperator);

    // ──────────────────────── Errors ───────────────────────────

    /// @dev An argument that must reference a live address was address(0).
    error ZeroAddress();

    /// @dev `claim` was called while the guardian or the operator has paused claims.
    error ClaimsPaused();

    /// @dev The token was never registered with the distributor.
    error UnknownRewardToken(address token);

    /// @dev The token is registered but its claims are switched off.
    error TokenClaimsDisabled(address token);

    /// @dev The voucher's deadline has passed.
    error ClaimExpired(uint256 deadline, uint256 blockTimestamp);

    /// @dev The voucher pays nothing: its cumulative figure is not above what was already claimed.
    error NothingToClaim(uint256 cumulativeAmount, uint256 alreadyClaimed);

    /// @dev The signature recovered to an address that is not the current `signer`.
    error InvalidSignature(address recovered, address expected);

    /// @dev The distributor holds less of `token` than this claim pays. The claim reverts until
    ///      the contract is funded; nothing is paid partially.
    error InsufficientFunds(address token, uint256 needed, uint256 balance);

    /// @dev `addRewardToken` (or `initialize`) named a token that is already registered.
    error RewardTokenAlreadyAdded(address token);

    /// @dev A zero amount was passed where a positive one is required.
    error ZeroAmount();

    /// @dev An operator-tier function was called by someone else — the owner and the guardian included.
    error NotOperator(address caller, address operator);

    /// @dev A pause switch was called by someone who is neither the guardian nor the operator.
    error NotGuardianOrOperator(address caller, address guardian, address operator);

    /// @dev `setGuardian` was called by someone who is neither the owner nor the operator.
    error NotOwnerOrOperator(address caller, address owner, address operator);

    /// @dev `renounceOwnership` is disabled: it would freeze the upgrade path forever.
    error RenounceDisabled();

    // ──────────────────────── User ─────────────────────────────

    /// @notice Pays `cumulativeAmount - claimed(token, msg.sender)` of `token` to the caller.
    /// @param token            Reward token the voucher was signed for.
    /// @param cumulativeAmount Lifetime entitlement of the caller in `token`, stated by the voucher.
    /// @param deadline         Voucher expiry timestamp.
    /// @param signature        EIP-712 `RewardClaim` signature by `signer()`.
    /// @return paidAmount      Amount of `token` transferred by this call.
    function claim(address token, uint256 cumulativeAmount, uint256 deadline, bytes calldata signature)
        external
        returns (uint256 paidAmount);

    // ──────────────────────── Owner (the timelock) ─────────────

    function addRewardToken(address token, bool conditional, bool claimsEnabled) external;

    function setRewardTokenEnabled(address token, bool enabled) external;

    function setClaimsEnabled(address token, bool enabled) external;

    function setOperator(address newOperator) external;

    // ──────────────────────── Owner or operator ────────────────

    function setGuardian(address newGuardian) external;

    // ──────────────────────── Guardian or operator ─────────────

    function setPaused(bool paused_) external;

    // ──────────────────────── Operator (the multisig) ──────────

    function setSigner(address newSigner) external;

    function recoverExcess(address token, uint256 amount) external;

    // ──────────────────────── Views ────────────────────────────

    /// @notice keccak256("RewardClaim(address token,address user,uint256 cumulativeAmount,uint256 deadline)")
    function REWARD_CLAIM_TYPEHASH() external view returns (bytes32);

    function signer() external view returns (address);

    function paused() external view returns (bool);

    function guardian() external view returns (address);

    function operator() external view returns (address);

    /// @notice Lifetime amount of `token` already paid to `user`.
    function claimed(address token, address user) external view returns (uint256);

    /// @notice Every token ever registered, in registration order. Disabled tokens included.
    function rewardTokens() external view returns (address[] memory);

    /// @notice The stored state of `token` (all fields zero when it was never registered).
    function rewardToken(address token) external view returns (RewardToken memory);

    /// @notice True when `token` is registered AND enabled — the test `LPEpochRegistry` applies
    ///         before it schedules an amount of `token`.
    function isRewardToken(address token) external view returns (bool);
}
