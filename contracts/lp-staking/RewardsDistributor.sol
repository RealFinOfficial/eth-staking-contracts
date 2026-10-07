// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";

import "./interfaces/IRewardsDistributor.sol";
import "./interfaces/IMintableRewardToken.sol";

/**
 * @title RewardsDistributor
 * @notice Pays LP staking rewards, in any number of reward tokens, against EIP-712 vouchers
 *         signed off-chain by `signer`.
 *
 *  Cumulative model, per token:
 *    - A voucher states the user's *lifetime* entitlement in one token (`cumulativeAmount`),
 *      not a per-epoch delta. A claim pays `cumulativeAmount - claimed[token][user]` and stores
 *      the new cumulative figure. Older vouchers therefore become no-ops rather than double
 *      payments, and a user who skips epochs still collects everything at once.
 *    - The paid difference must be strictly positive; a replayed or stale voucher reverts.
 *
 *  One voucher type for every token:
 *
 *      RewardClaim(address token,address user,uint256 cumulativeAmount,uint256 deadline)
 *
 *    The token is a signed field, so a voucher signed for token A is worthless for token B:
 *    the digest differs, the signature recovers to some other address, and `claimed[B]` is
 *    never touched.
 *
 *  Every reward token is PRE-FUNDED and paid by TRANSFER. Nothing is minted AT CLAIM TIME. The
 *  company funds this contract with each reward token: the operator transfers $ASSET into it,
 *  and mints $OVTR into it through {mintRewardToken} (this proxy is the Overture token's minter).
 *  A claim pays out of this contract's own balance of the claimed token, and when that balance
 *  is short the claim reverts with {InsufficientFunds} — until the contract is funded. There is
 *  NO cap, NO budget, NO running total and NO other limit on what a valid voucher pays: the
 *  signed cumulative figure minus what was already claimed, nothing else. The emission schedule
 *  in `LPEpochRegistry` bounds nothing here.
 *
 *  Minting, outside the claim flow: {mintRewardToken} lets the OPERATOR mint a registered reward
 *  token that is mintable — it implements `IMintableRewardToken` and names this proxy as its
 *  `minter` — to one concrete wallet: a user's wallet, or this contract itself to pre-fund
 *  claims. No ledger moves when it does: `claimed[token][user]` is written by `claim` alone.
 *  $ASSET — a token this program does not control, recorded in `asset` at initialization — is
 *  refused BY ADDRESS with {AssetNotMintable}, whoever calls, before the token is ever called. It
 *  is funded by transfer only.
 *
 *  Reward tokens:
 *    - `initialize` registers the launch tokens; the owner (the timelock) adds more with
 *      {addRewardToken}. A token is never removed: {setRewardTokenEnabled} takes it off the
 *      schedule (`isRewardToken` turns false) and {setClaimsEnabled} closes its claims. The two
 *      switches are independent — a disabled token that still has claims open keeps paying
 *      what users earned while it was scheduled.
 *    - `conditional` is stored for the indexer and the backend (which forfeit a conditional
 *      token's accrued amount on unstake). The contract never reads it.
 *
 *  Voucher safety:
 *    - The signed `user` field is always `msg.sender`; it is never taken as an argument.
 *      A third party cannot redeem someone else's voucher, and the payout address can
 *      never diverge from the signed one.
 *
 *  Trust (stated, not mitigated): with no cap anywhere, a leaked signer key can sign vouchers
 *  that take the whole funded balance of every token until the guardian pauses claims. The
 *  guardian's {setPaused} is the one-transaction containment; the operator then rotates the
 *  signer with {setSigner}. The guardian key must therefore stay hot and watched. A leaked
 *  signer or guardian key cannot mint: {mintRewardToken} is the operator's alone, and it is the
 *  only path from this contract to a token's `mint`. Nothing here caps what the operator mints.
 *
 *  UPGRADEABILITY. This contract is the implementation behind a UUPS (ERC-1967) proxy — see
 *  `contracts/lp-staking/deploy/LPProxy.sol`.
 *
 *    - Why it is upgradeable: `claimed[token][user]` is the ONLY record of what a user has
 *      already been paid, and the vouchers are cumulative. Fixing a bug by deploying a
 *      replacement contract would start that ledger at zero, and every outstanding lifetime
 *      voucher would become payable a second time (finding SEC-04,
 *      `docs/lp-staking-audit-notes.md`). The rule that follows: the distributor proxy is
 *      UPGRADED, never REPLACED.
 *    - Mutable state lives in ONE ERC-7201 namespaced struct, `real.lp.storage.RewardsDistributor`.
 *      An upgrade may append fields to it, and nothing an inherited OZ contract does to its own
 *      namespace can move ours. This v1 layout is a fresh layout in the same namespace (the
 *      Sepolia stack #5 proxy that carried the pre-v1 layout is abandoned, not upgraded).
 *    - v2 (2026-10-07) APPENDS one field, `asset`, at the END of that struct and changes nothing
 *      above it. A fresh proxy sets it in {initialize}; a live v1 proxy is upgraded with
 *      `upgradeToAndCall(newImplementation, abi.encodeCall(initializeV2, (asset)))` through the
 *      timelock, which sets it in the same transaction as the code change.
 *    - There are no immutables: every reward token is proxy storage, so a token can be added
 *      by the owner without a new implementation.
 *    - The implementation's own initializers are disabled in its constructor, so the bare
 *      implementation can never be initialised and taken over.
 *
 *  THREE-TIER ADMIN. `owner` is a `TimelockController` (48 h minimum delay on mainnet);
 *  `guardian` is a hot incident key that can ONLY pause; `operator` is a multisig with no
 *  delay for key rotation, treasury recovery and minting a mintable reward token:
 *
 *    | tier                | functions                                                         |
 *    |---------------------|-------------------------------------------------------------------|
 *    | owner (timelock)    | `_authorizeUpgrade`, `addRewardToken`, `setRewardTokenEnabled`,   |
 *    |                     | `setClaimsEnabled`, `setOperator`, `setGuardian`, `initializeV2`  |
 *    | guardian (hot key)  | `setPaused`                                                       |
 *    | operator (multisig) | `setSigner`, `recoverExcess`, `mintRewardToken`, `setGuardian`,   |
 *    |                     | `setPaused`                                                       |
 *
 *  Nothing the guardian can do moves value or installs a key, which is what makes a hot
 *  guardian acceptable. The operator can pause as well, as the cold fallback for a lost
 *  guardian key, and it can revoke or replace the guardian with no delay — see {setGuardian}.
 *  Ownership is two-step (`Ownable2StepUpgradeable`), and `renounceOwnership` is disabled.
 */
contract RewardsDistributor is
    Initializable,
    UUPSUpgradeable,
    Ownable2StepUpgradeable,
    ReentrancyGuard,
    EIP712Upgradeable,
    IRewardsDistributor
{
    using SafeERC20 for IERC20;

    // ──────────────────────── Constants ────────────────────────

    /// @notice EIP-712 type hash of the one voucher type, for every reward token.
    /// @dev keccak256("RewardClaim(address token,address user,uint256 cumulativeAmount,uint256 deadline)")
    ///      = 0x746a03cb3aaddb17f8408279b7ff5133a65d78143d19fbd50c05d05bca850c63.
    bytes32 public constant REWARD_CLAIM_TYPEHASH =
        keccak256("RewardClaim(address token,address user,uint256 cumulativeAmount,uint256 deadline)");

    // ──────────────────────── Storage ──────────────────────────

    /// @custom:storage-location erc7201:real.lp.storage.RewardsDistributor
    struct RewardsDistributorStorage {
        /// Address whose EIP-712 signature authorizes a claim. Rotatable by the operator.
        address signer;
        /// While true, `claim` reverts for every token. Nothing else is affected.
        bool paused;
        /// Fast-path incident responder (hot key). Pause only.
        address guardian;
        /// Routine-operations tier (multisig, no delay): signer rotation and treasury recovery.
        address operator;
        /// Every token ever registered, in registration order.
        address[] rewardTokens;
        /// token => its stored state.
        mapping(address => RewardToken) tokens;
        /// token => user => lifetime amount of that token already paid to that user.
        mapping(address => mapping(address => uint256)) claimed;
        /// The $ASSET reward token — a token this program does not control. Never mintable
        /// through this contract; funded by transfer only. Appended in v2: a v1 proxy gets it
        /// from {initializeV2}.
        address asset;
    }

    /**
     * @dev ERC-7201 slot for {RewardsDistributorStorage}, computed as
     *      `keccak256(abi.encode(uint256(keccak256("real.lp.storage.RewardsDistributor")) - 1)) & ~bytes32(uint256(0xff))`.
     *      Pinned as a literal because it must never move: it IS the ledger's address.
     *      `test/forge/unit/DistributorBranches.t.sol` recomputes it and fails if it drifts.
     */
    bytes32 private constant REWARDS_DISTRIBUTOR_STORAGE =
        0x111abb03172b09f746748b28040854f0c669e7caa9373080b8bbaa7c3af02e00;

    function _distributorStorage() private pure returns (RewardsDistributorStorage storage $) {
        assembly {
            $.slot := REWARDS_DISTRIBUTOR_STORAGE
        }
    }

    // ──────────────────────── Modifiers ────────────────────────

    /// @dev The routine-operations tier. Not satisfied by `owner()` or by the guardian.
    modifier onlyOperator() {
        address operator_ = _distributorStorage().operator;
        if (msg.sender != operator_) revert NotOperator(msg.sender, operator_);
        _;
    }

    /// @dev The pause tier: the guardian (hot key, fast path) or the operator (multisig, the
    ///      cold fallback for a lost guardian key). Deliberately NOT satisfied by `owner()`:
    ///      the timelock has no business holding an undelayed switch. The guardian slot may
    ///      hold `address(0)` — the "no guardian" state {setGuardian} can write — and then this
    ///      modifier admits the operator alone, because `msg.sender` is never the zero address.
    modifier onlyGuardianOrOperator() {
        RewardsDistributorStorage storage $ = _distributorStorage();
        address guardian_ = $.guardian;
        address operator_ = $.operator;
        if (msg.sender != guardian_ && msg.sender != operator_) {
            revert NotGuardianOrOperator(msg.sender, guardian_, operator_);
        }
        _;
    }

    /// @dev The guardian-rotation tier: the owner (the timelock, delayed) or the operator (the
    ///      multisig, undelayed). A hot key that holds an undelayed switch must be revocable
    ///      without a delay, and the operator already holds every switch the guardian holds,
    ///      so it gains no power it did not have.
    modifier onlyOwnerOrOperator() {
        address owner_ = owner();
        address operator_ = _distributorStorage().operator;
        if (msg.sender != owner_ && msg.sender != operator_) {
            revert NotOwnerOrOperator(msg.sender, owner_, operator_);
        }
        _;
    }

    // ──────────────────────── Constructor ──────────────────────

    /// @notice Deploys the IMPLEMENTATION. It holds no state of its own and is never called
    ///         directly; the proxy in front of it runs {initialize}.
    /// @dev `_disableInitializers()` stops anyone from initialising the bare implementation.
    constructor() {
        _disableInitializers();
    }

    // ──────────────────────── Initializer ──────────────────────

    /// @notice One-time setup, executed on the PROXY in its own deployment transaction.
    /// @param owner_    Owner: the `TimelockController`. Upgrades, reward tokens, roles.
    /// @param guardian_ Guardian: the hot incident key. Pause only.
    /// @param operator_ Operator: the multisig. Signer rotation, recovery and minting, no delay.
    /// @param signer_   Initial voucher signer.
    /// @param asset_    The $ASSET token: the registered reward token {mintRewardToken} refuses.
    ///                  Non-zero. It is registered like any other reward token — through
    ///                  `tokens_`, as the conditional launch token — and this only marks which
    ///                  registered token it is.
    /// @param tokens_   The launch reward tokens, in order. May be empty.
    /// @dev Every mutable field is written AND emitted here, the pause flag whose initial value
    ///      is `false` included, so the state is rebuildable from logs alone. The order of the
    ///      events is: `GuardianSet`, `OperatorSet`, `SignerChanged`, `Paused(false)`,
    ///      `AssetSet`, then one `RewardTokenAdded` per token in `tokens_` order.
    function initialize(
        address owner_,
        address guardian_,
        address operator_,
        address signer_,
        address asset_,
        RewardTokenInit[] calldata tokens_
    ) external initializer {
        __Ownable_init(owner_);
        __Ownable2Step_init();
        // No `__UUPSUpgradeable_init()`: OpenZeppelin v5.6 turned
        // `contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol` into a re-export of the plain
        // `UUPSUpgradeable`, which declares no initializer at all. There is nothing to seed —
        // the module's only state is the ERC-1967 implementation slot, and the proxy's own
        // constructor writes that before this function runs.
        __EIP712_init("RealLPRewards", "1");

        if (guardian_ == address(0) || operator_ == address(0)) revert ZeroAddress();
        if (signer_ == address(0)) revert ZeroAddress();

        RewardsDistributorStorage storage $ = _distributorStorage();
        $.guardian = guardian_;
        $.operator = operator_;
        $.signer = signer_;

        emit GuardianSet(address(0), guardian_);
        emit OperatorSet(address(0), operator_);
        emit SignerChanged(address(0), signer_);
        emit Paused(false);
        _setAsset(asset_);

        for (uint256 i = 0; i < tokens_.length; ++i) {
            _addRewardToken(tokens_[i].token, tokens_[i].conditional, tokens_[i].claimsEnabled);
        }
    }

    /// @notice The v1 -> v2 migration of a LIVE proxy: records which registered reward token is
    ///         $ASSET, the one {mintRewardToken} refuses. Runs once, and only for the owner.
    /// @param asset_ The $ASSET token. Non-zero.
    /// @dev Meant to run ATOMICALLY inside the upgrade itself:
    ///      `upgradeToAndCall(newImplementation, abi.encodeCall(initializeV2, (asset)))`, scheduled
    ///      on and executed by the timelock. `onlyOwner` holds there because `upgradeToAndCall`
    ///      delegatecalls this function from the proxy, so `msg.sender` stays the timelock — the
    ///      owner. `reinitializer(2)` makes it run once: a second call reverts
    ///      `InvalidInitialization`. Same check and same event as {initialize}: zero ->
    ///      {ZeroAddress}, then {AssetSet}.
    ///      On a proxy deployed fresh at v2, {initialize} (version 1) already set the field, and
    ///      this function stays callable once by the owner there too: it would re-point the
    ///      field — an owner-tier change, public for the whole timelock delay like any other.
    function initializeV2(address asset_) external reinitializer(2) onlyOwner {
        _setAsset(asset_);
    }

    // ──────────────────────── Views ────────────────────────────

    /// @inheritdoc IRewardsDistributor
    function signer() external view returns (address) {
        return _distributorStorage().signer;
    }

    /// @inheritdoc IRewardsDistributor
    function paused() external view returns (bool) {
        return _distributorStorage().paused;
    }

    /// @inheritdoc IRewardsDistributor
    function guardian() external view returns (address) {
        return _distributorStorage().guardian;
    }

    /// @inheritdoc IRewardsDistributor
    function operator() external view returns (address) {
        return _distributorStorage().operator;
    }

    /// @inheritdoc IRewardsDistributor
    function asset() external view returns (address) {
        return _distributorStorage().asset;
    }

    /// @inheritdoc IRewardsDistributor
    function claimed(address token, address user) external view returns (uint256) {
        return _distributorStorage().claimed[token][user];
    }

    /// @inheritdoc IRewardsDistributor
    function rewardTokens() external view returns (address[] memory) {
        return _distributorStorage().rewardTokens;
    }

    /// @inheritdoc IRewardsDistributor
    function rewardToken(address token) external view returns (RewardToken memory) {
        return _distributorStorage().tokens[token];
    }

    /// @inheritdoc IRewardsDistributor
    function isRewardToken(address token) external view returns (bool) {
        RewardToken storage t = _distributorStorage().tokens[token];
        return t.registered && t.enabled;
    }

    // ──────────────────────── User functions ───────────────────

    /// @notice Pays `cumulativeAmount - claimed(token, msg.sender)` of `token` to the caller,
    ///         out of this contract's pre-funded balance of `token`.
    /// @param token            Reward token the voucher was signed for.
    /// @param cumulativeAmount Lifetime entitlement of the caller in `token`.
    /// @param deadline         Voucher expiry timestamp.
    /// @param signature        EIP-712 `RewardClaim` signature by `signer`.
    /// @return paidAmount      Amount of `token` transferred by this call.
    /// @dev Check order, each a distinct revert: paused -> {ClaimsPaused}; token never
    ///      registered -> {UnknownRewardToken}; claims of the token off -> {TokenClaimsDisabled};
    ///      deadline passed -> {ClaimExpired}; nothing new to pay -> {NothingToClaim}; signature
    ///      not by `signer` -> {InvalidSignature}; balance short -> {InsufficientFunds}. Then the
    ///      ledger is written, then the transfer, then {Claimed}. The balance check is the
    ///      only thing between a valid voucher and its payment: no cap, no budget, no total.
    function claim(address token, uint256 cumulativeAmount, uint256 deadline, bytes calldata signature)
        external
        nonReentrant
        returns (uint256 paidAmount)
    {
        RewardsDistributorStorage storage $ = _distributorStorage();

        if ($.paused) revert ClaimsPaused();

        RewardToken storage t = $.tokens[token];
        if (!t.registered) revert UnknownRewardToken(token);
        if (!t.claimsEnabled) revert TokenClaimsDisabled(token);

        if (block.timestamp > deadline) revert ClaimExpired(deadline, block.timestamp);

        uint256 alreadyClaimed = $.claimed[token][msg.sender];
        if (cumulativeAmount <= alreadyClaimed) revert NothingToClaim(cumulativeAmount, alreadyClaimed);

        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(REWARD_CLAIM_TYPEHASH, token, msg.sender, cumulativeAmount, deadline))
        );
        address recovered = ECDSA.recover(digest, signature);
        address signer_ = $.signer;
        if (recovered != signer_) revert InvalidSignature(recovered, signer_);

        paidAmount = cumulativeAmount - alreadyClaimed;

        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance < paidAmount) revert InsufficientFunds(token, paidAmount, balance);

        $.claimed[token][msg.sender] = cumulativeAmount;

        IERC20(token).safeTransfer(msg.sender, paidAmount);

        emit Claimed(msg.sender, token, cumulativeAmount, paidAmount, block.timestamp);
    }

    // ──────────────────────── Owner functions ──────────────────

    /// @notice Adds a reward token to the program. Owner tier: a new token is a program
    ///         decision and takes the timelock's delay like an upgrade does.
    /// @param token         The ERC-20 to pay. Must be a PLAIN ERC-20: `decimals()` returning
    ///                      `uint8`, `symbol()` returning `string`, a `transfer` that moves
    ///                      exactly the amount asked (no fee on transfer, no rebasing) and that
    ///                      does not call back into the receiver. A token that breaks one of
    ///                      these is not supported; `addRewardToken` reverts when `decimals()`
    ///                      or `symbol()` cannot be read as such.
    /// @param conditional   Stored for the indexer and the backend; never read here.
    /// @param claimsEnabled Whether `claim` pays the token from this transaction on.
    /// @dev Enabled on arrival (`isRewardToken` turns true, so the registry can schedule it).
    ///      A claim of the new token reverts with {InsufficientFunds} until it is funded.
    function addRewardToken(address token, bool conditional, bool claimsEnabled) external onlyOwner {
        _addRewardToken(token, conditional, claimsEnabled);
    }

    /// @notice Puts a registered token on, or takes it off, the emission schedule.
    /// @dev Does not touch claims: a token taken off the schedule keeps paying what was earned
    ///      while its claims stay open. {RewardTokenUpdated} carries both switches.
    function setRewardTokenEnabled(address token, bool enabled) external onlyOwner {
        RewardToken storage t = _requireRegistered(token);
        t.enabled = enabled;
        emit RewardTokenUpdated(token, enabled, t.claimsEnabled);
    }

    /// @notice Opens or closes the claims of one registered token.
    /// @dev Owner tier: opening a token's claims (e.g. $ASSET after maturity) is a program
    ///      decision. The incident switch for ALL tokens is {setPaused}, which needs no delay.
    function setClaimsEnabled(address token, bool enabled) external onlyOwner {
        RewardToken storage t = _requireRegistered(token);
        t.claimsEnabled = enabled;
        emit RewardTokenUpdated(token, t.enabled, enabled);
    }

    /// @notice Appoint, replace or REVOKE the fast-path guardian.
    /// @param newGuardian The new guardian, or `address(0)` to leave the tier vacant.
    /// @dev Owner OR operator. The owner is a timelock 48 h away on mainnet, so a guardian key
    ///      known to be compromised must be revocable without that delay; the operator already
    ///      holds `setPaused`, so it gains nothing by holding this too. `address(0)` is the
    ///      explicit "no guardian" state: {onlyGuardianOrOperator} then admits the operator alone.
    function setGuardian(address newGuardian) external onlyOwnerOrOperator {
        RewardsDistributorStorage storage $ = _distributorStorage();
        emit GuardianSet($.guardian, newGuardian);
        $.guardian = newGuardian;
    }

    /// @notice Rotate the routine-operations tier.
    /// @dev Owner tier: the operator cannot rotate itself, so losing the multisig is recoverable
    ///      through the timelock rather than terminal.
    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert ZeroAddress();
        RewardsDistributorStorage storage $ = _distributorStorage();
        emit OperatorSet($.operator, newOperator);
        $.operator = newOperator;
    }

    /// @notice UUPS upgrade hook. The owner is the timelock, so every code change is scheduled
    ///         on-chain with full calldata and cannot execute before the delay.
    /// @dev Empty body on purpose: `onlyOwner` is the whole authorization.
    function _authorizeUpgrade(address) internal override onlyOwner {}

    /// @notice Disabled. Renouncing would leave `_authorizeUpgrade` with no caller, freezing
    ///         the implementation forever — the exact failure the proxy exists to avoid.
    /// @dev Kept `onlyOwner` (a stranger gets the standard Ownable rejection) and deliberately
    ///      NOT `view`, so the ABI entry keeps looking like the transaction it overrides.
    function renounceOwnership() public override onlyOwner {
        revert RenounceDisabled();
    }

    // ──────────────────────── Pause (guardian or operator) ─────

    /// @notice Pause or unpause `claim` for every token. Affects nothing else.
    function setPaused(bool paused_) external onlyGuardianOrOperator {
        _distributorStorage().paused = paused_;
        emit Paused(paused_);
    }

    // ──────────────────────── Operator functions ───────────────

    /// @notice Rotate the voucher signer. Invalidates every outstanding signature.
    /// @dev Operator tier: rotation must not wait out a timelock, but whoever holds this call
    ///      can install a signer of their own and take the funded balances, so it belongs to a
    ///      multisig, not to the hot guardian key.
    function setSigner(address newSigner) external onlyOperator {
        if (newSigner == address(0)) revert ZeroAddress();
        RewardsDistributorStorage storage $ = _distributorStorage();
        emit SignerChanged($.signer, newSigner);
        $.signer = newSigner;
    }

    /// @notice Move `amount` of any token out of this contract to the operator — overfunding,
    ///         a retired reward token, a stray transfer, or a wind-down.
    /// @dev Trust assumption, stated rather than mitigated: there is no reserve for signed but
    ///      unclaimed vouchers, so the operator can withdraw a whole reward balance and leave
    ///      outstanding claims reverting with {InsufficientFunds} until it funds the contract
    ///      again. That is accepted because the operator is the party that FUNDS these balances:
    ///      they are company money, not user deposits, and no staker principal is reachable
    ///      from here. Operator tier because moving treasury money must not wait out a timelock,
    ///      and not the guardian, because the hot key must never move value.
    function recoverExcess(address token, uint256 amount) external onlyOperator {
        if (amount == 0) revert ZeroAmount();
        address to = _distributorStorage().operator;
        IERC20(token).safeTransfer(to, amount);
        emit ExcessRecovered(token, to, amount, block.timestamp);
    }

    /// @notice Mint `amount` of the reward token `token` to the wallet `to`, OUTSIDE the voucher
    ///         flow — to a user's wallet, or to this contract itself to pre-fund the claims of
    ///         `token`.
    /// @param token  A registered reward token, enabled or not, that implements
    ///               `IMintableRewardToken` and names this proxy as its `minter`. Never $ASSET.
    /// @param to     The wallet that receives the new tokens. Any address except zero.
    /// @param amount The number of tokens to mint, in `token`'s smallest unit. Positive.
    /// @dev Operator tier: minting is treasury work like funding and recovery, so it must not wait
    ///      out a timelock, and the hot guardian key must never create value. Check order, each a
    ///      distinct revert: caller not the operator -> {NotOperator}; `token` is $ASSET ->
    ///      {AssetNotMintable}; token never registered -> {UnknownRewardToken}; `to` is zero ->
    ///      {ZeroAddress}; `amount` is zero -> {ZeroAmount}. Then `token.mint(to, amount)`, then
    ///      {RewardTokenMinted}.
    ///      $ASSET is refused BY ADDRESS, before the token is ever called: it is a token this
    ///      program does not control, so no `mint` it might expose is ever reached from here.
    ///      For every other token the token's own revert is NOT wrapped: it bubbles up unchanged.
    ///      A registered token with no `mint` reverts inside the token, and a token whose minter
    ///      is not this proxy reverts with its own error — `TokenOverture.NotMinter(address(this))`.
    ///      Claims are untouched: no ledger moves here, and `claim` still pays by transfer out of
    ///      the balance and never mints.
    ///      No `nonReentrant`: this function writes NO distributor storage (it only reads the
    ///      token's registration), so a token that calls back into this contract during `mint`
    ///      finds no half-written state to exploit.
    function mintRewardToken(address token, address to, uint256 amount) external onlyOperator {
        if (token == _distributorStorage().asset) revert AssetNotMintable(token);
        _requireRegistered(token);
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        IMintableRewardToken(token).mint(to, amount);
        emit RewardTokenMinted(token, to, amount, block.timestamp);
    }

    // ──────────────────────── Internal ─────────────────────────

    /// @dev Registers one token: zero and duplicates rejected, `decimals()` and `symbol()` read
    ///      from the token, enabled on arrival, appended to `rewardTokens`.
    function _addRewardToken(address token, bool conditional, bool claimsEnabled) private {
        if (token == address(0)) revert ZeroAddress();
        RewardsDistributorStorage storage $ = _distributorStorage();
        RewardToken storage t = $.tokens[token];
        if (t.registered) revert RewardTokenAlreadyAdded(token);

        uint8 decimals_ = IERC20Metadata(token).decimals();
        string memory symbol_ = IERC20Metadata(token).symbol();

        t.registered = true;
        t.enabled = true;
        t.conditional = conditional;
        t.claimsEnabled = claimsEnabled;
        t.decimals = decimals_;
        $.rewardTokens.push(token);

        emit RewardTokenAdded(token, conditional, claimsEnabled, decimals_, symbol_);
    }

    /// @dev Records the $ASSET address and announces it. Shared by {initialize} and
    ///      {initializeV2}, so both run the same check and emit the same event.
    function _setAsset(address asset_) private {
        if (asset_ == address(0)) revert ZeroAddress();
        _distributorStorage().asset = asset_;
        emit AssetSet(asset_);
    }

    /// @dev The stored entry of a registered token, or {UnknownRewardToken}.
    function _requireRegistered(address token) private view returns (RewardToken storage t) {
        t = _distributorStorage().tokens[token];
        if (!t.registered) revert UnknownRewardToken(token);
    }
}
