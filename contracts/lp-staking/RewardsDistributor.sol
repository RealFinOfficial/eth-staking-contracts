// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";

import "./TokenX.sol";

/**
 * @title RewardsDistributor
 * @notice Pays LP staking rewards against EIP-712 vouchers signed off-chain by `signer`.
 *
 *  Cumulative model:
 *    - A voucher states the user's *lifetime* entitlement (`cumulativeAmount`), not a
 *      per-epoch delta. A claim pays `cumulativeAmount - claimed[user]` and stores the
 *      new cumulative figure. Older vouchers therefore become no-ops rather than
 *      double payments, and a user who skips epochs still collects everything at once.
 *    - The paid difference must be strictly positive; a replayed or stale voucher reverts.
 *
 *  Two reward legs, two distinct signed types:
 *    - `TokenXClaim` is paid by minting TokenX. This contract is expected to be the
 *      TokenX `minter`. The token's own per-epoch mint cap can make that mint revert;
 *      that is deliberate defense in depth and is never caught here.
 *    - `AssetClaim` is paid by transferring ASSET out of this contract's own balance,
 *      pre-funded by the treasury — so the balance held here is the damage cap for that
 *      leg. It is off by default and must be enabled by the owner.
 *    - The struct names differ, so the two digests can never be crossed over.
 *
 *  Voucher safety:
 *    - The signed `user` field is always `msg.sender`; it is never taken as an argument.
 *      A third party cannot redeem someone else's voucher, and the payout address can
 *      never diverge from the signed one.
 *
 *  UPGRADEABILITY (spec 01 revision 2026-08-26). This contract is the implementation
 *  behind a UUPS (ERC-1967) proxy — see `contracts/lp-staking/deploy/LPProxy.sol`.
 *
 *    - Why it is upgradeable at all, when the rest of the repo is not: `claimedTokenX` and
 *      `claimedAsset` are the ONLY record of what a user has already been paid, and the
 *      vouchers are cumulative. Fixing a bug by deploying a replacement contract would
 *      start those ledgers at zero, and every outstanding lifetime voucher would become
 *      payable a second time (finding SEC-04, `docs/lp-staking-audit-notes.md` §10).
 *      A proxy is what lets the code be replaced while the ledger stays where it is.
 *    - Mutable state therefore lives in ONE ERC-7201 namespaced struct, not in ordinary
 *      slots: an upgrade may append fields to that struct, and nothing an inherited OZ
 *      contract does to its own namespace can move ours.
 *    - `tokenX` and `asset` stay `immutable`. They are fixed protocol references, they
 *      live in the implementation's bytecode rather than in proxy storage, and an upgrade
 *      that changed either would be a different program, not a fix.
 *    - The implementation's own initializers are disabled in its constructor, so the
 *      bare implementation can never be initialised and taken over.
 *
 *  THREE-TIER ADMIN. `owner` is a `TimelockController` (48 h minimum delay on mainnet);
 *  `guardian` is a hot incident key that can ONLY pause; `operator` is a multisig with no
 *  delay for key rotation and treasury recovery:
 *
 *    | tier               | functions                                                     |
 *    |--------------------|---------------------------------------------------------------|
 *    | owner (timelock)   | `_authorizeUpgrade`, `setAssetClaimsEnabled`, `setGuardian`, `setOperator` |
 *    | guardian (hot key) | `setPaused`                                                   |
 *    | operator (multisig)| `setSigner`, `recoverExcessAsset`, and `setPaused`            |
 *
 *  A leaked signing key is contained by the guardian's pause in one transaction; the
 *  operator then rotates the signer from the multisig within hours. Nothing the guardian
 *  can do moves value or installs a key, which is what makes a hot guardian acceptable.
 *  The operator can pause as well, as the cold fallback for a lost guardian key.
 *  Ownership is two-step (`Ownable2StepUpgradeable`), and `renounceOwnership` is disabled.
 */
contract RewardsDistributor is
    Initializable,
    UUPSUpgradeable,
    Ownable2StepUpgradeable,
    ReentrancyGuard,
    EIP712Upgradeable
{
    using SafeERC20 for IERC20;

    // ──────────────────────── Errors ───────────────────────────

    /// @dev An argument that must reference a live address was address(0).
    error ZeroAddress();

    /// @dev Both claim functions are paused by the guardian or the operator.
    error ClaimsPaused();

    /// @dev `claimAsset` was called while the ASSET leg is disabled.
    error AssetClaimsDisabled();

    /// @dev The voucher's deadline has passed.
    error ClaimExpired(uint256 deadline, uint256 blockTimestamp);

    /// @dev The voucher pays nothing: its cumulative figure is not above what was already claimed.
    error NothingToClaim(uint256 cumulativeAmount, uint256 alreadyClaimed);

    /// @dev The signature recovered to an address that is not the current `signer`.
    error InvalidSignature(address recovered, address expected);

    /// @dev A zero amount was passed where a positive one is required.
    error ZeroAmount();

    /// @dev An operator-tier function was called by someone else — the owner and the guardian included.
    error NotOperator(address caller, address operator);

    /// @dev A pause switch was called by someone who is neither the guardian nor the operator.
    error NotGuardianOrOperator(address caller, address guardian, address operator);

    /// @dev `renounceOwnership` is disabled: it would freeze the upgrade path forever.
    error RenounceDisabled();

    // ──────────────────────── Constants ────────────────────────

    /// @notice EIP-712 type hash for the TokenX reward leg.
    bytes32 public constant TOKENX_CLAIM_TYPEHASH =
        keccak256("TokenXClaim(address user,uint256 cumulativeAmount,uint256 deadline)");

    /// @notice EIP-712 type hash for the ASSET reward leg.
    bytes32 public constant ASSET_CLAIM_TYPEHASH =
        keccak256("AssetClaim(address user,uint256 cumulativeAmount,uint256 deadline)");

    // ──────────────────────── Immutables ───────────────────────

    /// @notice Reward token minted by the TokenX leg. This contract must be its `minter`.
    /// @dev Implementation bytecode, not proxy storage — see the upgradeability note above.
    TokenX public immutable tokenX;

    /// @notice Token paid by the ASSET leg, out of this contract's pre-funded balance.
    /// @dev Implementation bytecode, not proxy storage — see the upgradeability note above.
    IERC20 public immutable asset;

    // ──────────────────────── Storage ──────────────────────────

    /// @custom:storage-location erc7201:real.lp.storage.RewardsDistributor
    struct RewardsDistributorStorage {
        /// Address whose EIP-712 signature authorizes a claim. Rotatable by the operator.
        address signer;
        /// While true, both claim functions revert. Nothing else is affected.
        bool paused;
        /// The ASSET leg is off until the owner turns it on.
        bool assetClaimsEnabled;
        /// Fast-path incident responder (hot key), set and rotated by the owner. Pause only.
        address guardian;
        /// Lifetime TokenX already paid to a user.
        mapping(address => uint256) claimedTokenX;
        /// Lifetime ASSET already paid to a user.
        mapping(address => uint256) claimedAsset;
        /// Routine-operations tier (multisig, no delay): signer rotation and ASSET recovery.
        /// Appended after the mappings so the layout stays a strict extension of revision d852f44.
        address operator;
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

    // ──────────────────────── Events ───────────────────────────

    event Claimed(
        address indexed user,
        address indexed token,
        uint256 cumulativeAmount,
        uint256 paidAmount,
        uint256 timestamp
    );
    event SignerChanged(address previousSigner, address newSigner);
    event Paused(bool paused);
    event AssetClaimsEnabled(bool enabled);
    event ExcessAssetRecovered(address to, uint256 amount, uint256 timestamp);
    event GuardianSet(address previousGuardian, address newGuardian);

    /// @notice The routine-operations tier changed. Carries both sides for auditability.
    event OperatorSet(address previousOperator, address newOperator);

    // ──────────────────────── Modifiers ────────────────────────

    /// @dev The routine-operations tier. Not satisfied by `owner()` or by the guardian.
    modifier onlyOperator() {
        address operator_ = _distributorStorage().operator;
        if (msg.sender != operator_) revert NotOperator(msg.sender, operator_);
        _;
    }

    /// @dev The pause tier: the guardian (hot key, fast path) or the operator (multisig, the
    ///      cold fallback for a lost guardian key). Deliberately NOT satisfied by `owner()`:
    ///      the timelock has no business holding an undelayed switch.
    modifier onlyGuardianOrOperator() {
        RewardsDistributorStorage storage $ = _distributorStorage();
        address guardian_ = $.guardian;
        address operator_ = $.operator;
        if (msg.sender != guardian_ && msg.sender != operator_) {
            revert NotGuardianOrOperator(msg.sender, guardian_, operator_);
        }
        _;
    }

    // ──────────────────────── Constructor ──────────────────────

    /// @notice Deploys the IMPLEMENTATION. It holds no state of its own and is never called
    ///         directly; the proxy in front of it runs {initialize}.
    /// @param _tokenX TokenX address; the proxy is expected to be set as its minter.
    /// @param _asset  ASSET token paid by the second reward leg.
    /// @dev `_disableInitializers()` is what stops anyone from initialising the bare
    ///      implementation and owning a contract that, being un-proxied, controls nothing —
    ///      but would still be a confusing entry in every explorer and indexer.
    constructor(address _tokenX, address _asset) {
        if (_tokenX == address(0)) revert ZeroAddress();
        if (_asset == address(0)) revert ZeroAddress();

        tokenX = TokenX(_tokenX);
        asset = IERC20(_asset);

        _disableInitializers();
    }

    // ──────────────────────── Initializer ──────────────────────

    /// @notice One-time setup, executed on the PROXY in its own deployment transaction.
    /// @param owner_    Owner: the `TimelockController`. Upgrades, the ASSET-leg switch, roles.
    /// @param guardian_ Guardian: the hot incident key. Pause only.
    /// @param operator_ Operator: the multisig. Signer rotation and ASSET recovery, no delay.
    /// @param signer_   Initial voucher signer.
    /// @dev Every mutable field is written AND emitted here, including the two flags whose
    ///      initial value is `false`, so the state is rebuildable from logs alone.
    function initialize(address owner_, address guardian_, address operator_, address signer_)
        external
        initializer
    {
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
        emit AssetClaimsEnabled(false);
    }

    // ──────────────────────── Views ────────────────────────────

    /// @notice Address whose EIP-712 signature authorizes a claim.
    function signer() external view returns (address) {
        return _distributorStorage().signer;
    }

    /// @notice True while both claim functions are blocked.
    function paused() external view returns (bool) {
        return _distributorStorage().paused;
    }

    /// @notice True once the owner has switched the ASSET reward leg on.
    function assetClaimsEnabled() external view returns (bool) {
        return _distributorStorage().assetClaimsEnabled;
    }

    /// @notice The fast-path incident responder (the hot key). Pause only.
    function guardian() external view returns (address) {
        return _distributorStorage().guardian;
    }

    /// @notice The routine-operations tier (the multisig).
    function operator() external view returns (address) {
        return _distributorStorage().operator;
    }

    /// @notice Lifetime TokenX already paid to `user`.
    function claimedTokenX(address user) external view returns (uint256) {
        return _distributorStorage().claimedTokenX[user];
    }

    /// @notice Lifetime ASSET already paid to `user`.
    function claimedAsset(address user) external view returns (uint256) {
        return _distributorStorage().claimedAsset[user];
    }

    // ──────────────────────── Internal helpers ─────────────────

    /// @dev Shared voucher check for both legs. Verifies the pause flag, the deadline,
    ///      the strictly-positive payable difference and the signature, then returns the
    ///      amount to pay. `user` is bound to msg.sender by the caller, never by an argument.
    /// @param typehash        Type hash of the leg being claimed — distinct per leg, so a
    ///                        voucher signed for one leg cannot be spent on the other.
    /// @param alreadyClaimed  The user's stored cumulative figure for this leg.
    function _verifyClaim(
        bytes32 typehash,
        uint256 cumulativeAmount,
        uint256 alreadyClaimed,
        uint256 deadline,
        bytes calldata signature
    ) internal view returns (uint256 paidAmount) {
        RewardsDistributorStorage storage $ = _distributorStorage();

        if ($.paused) revert ClaimsPaused();
        if (block.timestamp > deadline) revert ClaimExpired(deadline, block.timestamp);
        if (cumulativeAmount <= alreadyClaimed) revert NothingToClaim(cumulativeAmount, alreadyClaimed);

        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(typehash, msg.sender, cumulativeAmount, deadline))
        );
        address recovered = ECDSA.recover(digest, signature);
        if (recovered != $.signer) revert InvalidSignature(recovered, $.signer);

        paidAmount = cumulativeAmount - alreadyClaimed;
    }

    // ──────────────────────── User functions ───────────────────

    /// @notice Claim the TokenX leg. Mints `cumulativeAmount - claimedTokenX[msg.sender]`
    ///         to the caller. The voucher is signed over the caller's own address, so it
    ///         can only ever be redeemed by them, to them.
    /// @param cumulativeAmount Lifetime TokenX entitlement stated by the voucher.
    /// @param deadline         Voucher expiry timestamp.
    /// @param signature        EIP-712 `TokenXClaim` attestation from `signer`.
    /// @return paidAmount      TokenX minted by this call.
    /// @dev The TokenX per-epoch mint cap can make the mint revert. That is intended.
    function claimTokenX(uint256 cumulativeAmount, uint256 deadline, bytes calldata signature)
        external
        nonReentrant
        returns (uint256 paidAmount)
    {
        RewardsDistributorStorage storage $ = _distributorStorage();

        uint256 alreadyClaimed = $.claimedTokenX[msg.sender];
        paidAmount = _verifyClaim(TOKENX_CLAIM_TYPEHASH, cumulativeAmount, alreadyClaimed, deadline, signature);

        $.claimedTokenX[msg.sender] = cumulativeAmount;

        tokenX.mint(msg.sender, paidAmount);

        emit Claimed(msg.sender, address(tokenX), cumulativeAmount, paidAmount, block.timestamp);
    }

    /// @notice Claim the ASSET leg. Transfers `cumulativeAmount - claimedAsset[msg.sender]`
    ///         to the caller out of this contract's pre-funded balance. Off until the owner
    ///         enables it.
    /// @param cumulativeAmount Lifetime ASSET entitlement stated by the voucher.
    /// @param deadline         Voucher expiry timestamp.
    /// @param signature        EIP-712 `AssetClaim` attestation from `signer`.
    /// @return paidAmount      ASSET transferred by this call.
    function claimAsset(uint256 cumulativeAmount, uint256 deadline, bytes calldata signature)
        external
        nonReentrant
        returns (uint256 paidAmount)
    {
        RewardsDistributorStorage storage $ = _distributorStorage();

        if (!$.assetClaimsEnabled) revert AssetClaimsDisabled();

        uint256 alreadyClaimed = $.claimedAsset[msg.sender];
        paidAmount = _verifyClaim(ASSET_CLAIM_TYPEHASH, cumulativeAmount, alreadyClaimed, deadline, signature);

        $.claimedAsset[msg.sender] = cumulativeAmount;

        asset.safeTransfer(msg.sender, paidAmount);

        emit Claimed(msg.sender, address(asset), cumulativeAmount, paidAmount, block.timestamp);
    }

    // ──────────────────────── Owner functions ──────────────────

    /// @notice Turn the ASSET reward leg on or off. Off by default.
    /// @param _enabled True to allow `claimAsset`.
    /// @dev Owner tier: switching a whole reward leg on is a program decision, not an
    ///      incident response, so it takes the timelock's delay like an upgrade does.
    function setAssetClaimsEnabled(bool _enabled) external onlyOwner {
        _distributorStorage().assetClaimsEnabled = _enabled;
        emit AssetClaimsEnabled(_enabled);
    }

    /// @notice Rotate the fast-path guardian.
    /// @param _guardian The new guardian (the multisig).
    /// @dev Owner tier: the guardian cannot rotate itself, so losing the multisig is
    ///      recoverable through the timelock rather than terminal.
    function setGuardian(address _guardian) external onlyOwner {
        if (_guardian == address(0)) revert ZeroAddress();
        RewardsDistributorStorage storage $ = _distributorStorage();
        emit GuardianSet($.guardian, _guardian);
        $.guardian = _guardian;
    }

    /// @notice Rotate the routine-operations tier.
    /// @param _operator The new operator (the multisig).
    /// @dev Owner tier: the operator cannot rotate itself, so losing the multisig is
    ///      recoverable through the timelock rather than terminal.
    function setOperator(address _operator) external onlyOwner {
        if (_operator == address(0)) revert ZeroAddress();
        RewardsDistributorStorage storage $ = _distributorStorage();
        emit OperatorSet($.operator, _operator);
        $.operator = _operator;
    }

    /// @notice UUPS upgrade hook. The owner is the timelock, so every code change is
    ///         scheduled on-chain with full calldata and cannot execute before the delay.
    /// @dev Empty body on purpose: `onlyOwner` is the whole authorization.
    function _authorizeUpgrade(address) internal override onlyOwner {}

    /// @notice Disabled. Renouncing would leave `_authorizeUpgrade` with no caller, freezing
    ///         the implementation forever — the exact failure the proxy exists to avoid.
    /// @dev Kept `onlyOwner` so a stranger still gets the standard Ownable rejection and the
    ///      owner gets a reason.
    ///
    ///      solc says "state mutability can be restricted to view" here, and that is left
    ///      alone on purpose: marking it `view` would change the ABI entry's
    ///      `stateMutability`, and every wallet, explorer and indexer that reads this ABI
    ///      would then present the call as a read. It has to keep looking like the
    ///      transaction it overrides, so that anyone who tries it gets the revert reason
    ///      on-chain.
    function renounceOwnership() public override onlyOwner {
        revert RenounceDisabled();
    }

    // ──────────────────────── Pause functions (guardian or operator) ────

    /// @notice Pause or unpause both claim functions. Affects nothing else.
    /// @param _paused True to block claims.
    /// @dev Pause tier: the incident switch. The guardian is a hot key that can only pause,
    ///      which is exactly why it can be hot; the operator multisig can throw it too, as
    ///      the cold fallback for a lost guardian key.
    function setPaused(bool _paused) external onlyGuardianOrOperator {
        _distributorStorage().paused = _paused;
        emit Paused(_paused);
    }

    // ──────────────────────── Operator functions ───────────────

    /// @notice Rotate the voucher signer. Invalidates every outstanding signature.
    ///         This is the key-compromise recovery path.
    /// @param _signer The new signer.
    /// @dev Operator tier: rotation must not wait out a timelock, but whoever holds this call
    ///      can install a signer of their own and mint up to the epoch cap, so it belongs to a
    ///      multisig, not to the hot guardian key. The guardian's `setPaused` is the
    ///      one-transaction containment; this is the follow-up.
    function setSigner(address _signer) external onlyOperator {
        if (_signer == address(0)) revert ZeroAddress();
        RewardsDistributorStorage storage $ = _distributorStorage();
        emit SignerChanged($.signer, _signer);
        $.signer = _signer;
    }

    /// @notice Move ASSET out of this contract to the operator — overfunding, a retired
    ///         reward leg, or a wind-down. Operational cleanup only.
    /// @param amount ASSET amount to transfer to the operator.
    /// @dev Emits {ExcessAssetRecovered}, like every other admin action, so a treasury
    ///      withdrawal is followable from logs alone rather than only from ERC-20 transfers.
    ///
    ///      Trust assumption, stated rather than mitigated: there is no reserve for signed
    ///      but unclaimed ASSET vouchers, so the operator can withdraw the whole ASSET leg
    ///      at any moment and leave outstanding `claimAsset` calls unpayable. That is
    ///      accepted because the operator — the multisig — is also the party that FUNDS this
    ///      balance: the ASSET leg is pre-funded treasury money, not user deposits, and no
    ///      staker principal is reachable from here. It is an operator call rather than an
    ///      owner call because moving treasury money must not wait out a timelock — and not a
    ///      guardian call, because the hot key must never move value. The TokenX leg is
    ///      unaffected: it is minted on claim under the token's own per-epoch cap and has no
    ///      balance to drain.
    function recoverExcessAsset(uint256 amount) external onlyOperator {
        if (amount == 0) revert ZeroAmount();
        address to = _distributorStorage().operator;
        asset.safeTransfer(to, amount);
        emit ExcessAssetRecovered(to, amount, block.timestamp);
    }
}
