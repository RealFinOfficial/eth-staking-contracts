// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

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
 *  The contract is not upgradeable. `signer` is rotatable for key-compromise recovery,
 *  and claims can be paused; nothing else about the payout math can be changed.
 */
contract RewardsDistributor is Ownable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    // ──────────────────────── Errors ───────────────────────────

    /// @dev A constructor argument that must reference a live address was address(0).
    error ZeroAddress();

    /// @dev Both claim functions are paused by the owner.
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

    // ──────────────────────── Constants ────────────────────────

    /// @notice EIP-712 type hash for the TokenX reward leg.
    bytes32 public constant TOKENX_CLAIM_TYPEHASH =
        keccak256("TokenXClaim(address user,uint256 cumulativeAmount,uint256 deadline)");

    /// @notice EIP-712 type hash for the ASSET reward leg.
    bytes32 public constant ASSET_CLAIM_TYPEHASH =
        keccak256("AssetClaim(address user,uint256 cumulativeAmount,uint256 deadline)");

    // ──────────────────────── State ────────────────────────────

    /// @notice Reward token minted by the TokenX leg. This contract must be its `minter`.
    TokenX public immutable tokenX;

    /// @notice Token paid by the ASSET leg, out of this contract's pre-funded balance.
    IERC20 public immutable asset;

    /// @notice Address whose EIP-712 signature authorizes a claim. Rotatable by the owner.
    address public signer;

    /// @notice While true, both claim functions revert. Nothing else is affected.
    bool public paused;

    /// @notice The ASSET leg is off until the owner turns it on.
    bool public assetClaimsEnabled;

    /// @notice Lifetime TokenX already paid to a user.
    mapping(address => uint256) public claimedTokenX;

    /// @notice Lifetime ASSET already paid to a user.
    mapping(address => uint256) public claimedAsset;

    // ──────────────────────── Events ───────────────────────────

    event Claimed(address indexed user, address indexed token, uint256 cumulativeAmount, uint256 paidAmount);
    event SignerChanged(address previousSigner, address newSigner);
    event Paused(bool paused);
    event AssetClaimsEnabled(bool enabled);
    event ExcessAssetRecovered(address to, uint256 amount);

    // ──────────────────────── Constructor ──────────────────────

    /// @param _tokenX       TokenX address; this contract is expected to be set as its minter.
    /// @param _asset        ASSET token paid by the second reward leg.
    /// @param _signer       Initial voucher signer.
    /// @param _initialOwner Owner (multisig). Controls the signer, the pause and the ASSET leg.
    constructor(address _tokenX, address _asset, address _signer, address _initialOwner)
        Ownable(_initialOwner)
        EIP712("RealLPRewards", "1")
    {
        if (_tokenX == address(0)) revert ZeroAddress();
        if (_asset == address(0)) revert ZeroAddress();
        if (_signer == address(0)) revert ZeroAddress();

        tokenX = TokenX(_tokenX);
        asset = IERC20(_asset);
        signer = _signer;

        // Mirrors the pools: the signer is followable from logs alone, from block one.
        emit SignerChanged(address(0), _signer);
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
        if (paused) revert ClaimsPaused();
        if (block.timestamp > deadline) revert ClaimExpired(deadline, block.timestamp);
        if (cumulativeAmount <= alreadyClaimed) revert NothingToClaim(cumulativeAmount, alreadyClaimed);

        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(typehash, msg.sender, cumulativeAmount, deadline))
        );
        address recovered = ECDSA.recover(digest, signature);
        if (recovered != signer) revert InvalidSignature(recovered, signer);

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
        uint256 alreadyClaimed = claimedTokenX[msg.sender];
        paidAmount = _verifyClaim(TOKENX_CLAIM_TYPEHASH, cumulativeAmount, alreadyClaimed, deadline, signature);

        claimedTokenX[msg.sender] = cumulativeAmount;

        tokenX.mint(msg.sender, paidAmount);

        emit Claimed(msg.sender, address(tokenX), cumulativeAmount, paidAmount);
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
        if (!assetClaimsEnabled) revert AssetClaimsDisabled();

        uint256 alreadyClaimed = claimedAsset[msg.sender];
        paidAmount = _verifyClaim(ASSET_CLAIM_TYPEHASH, cumulativeAmount, alreadyClaimed, deadline, signature);

        claimedAsset[msg.sender] = cumulativeAmount;

        asset.safeTransfer(msg.sender, paidAmount);

        emit Claimed(msg.sender, address(asset), cumulativeAmount, paidAmount);
    }

    // ──────────────────────── Owner functions ──────────────────

    /// @notice Rotate the voucher signer. Invalidates every outstanding signature.
    ///         This is the key-compromise recovery path.
    /// @param _signer The new signer.
    function setSigner(address _signer) external onlyOwner {
        if (_signer == address(0)) revert ZeroAddress();
        emit SignerChanged(signer, _signer);
        signer = _signer;
    }

    /// @notice Pause or unpause both claim functions. Affects nothing else.
    /// @param _paused True to block claims.
    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit Paused(_paused);
    }

    /// @notice Turn the ASSET reward leg on or off. Off by default.
    /// @param _enabled True to allow `claimAsset`.
    function setAssetClaimsEnabled(bool _enabled) external onlyOwner {
        assetClaimsEnabled = _enabled;
        emit AssetClaimsEnabled(_enabled);
    }

    /// @notice Move ASSET out of this contract to the owner — overfunding, a retired
    ///         reward leg, or a wind-down. Operational cleanup only.
    /// @param amount ASSET amount to transfer to the owner.
    /// @dev Emits {ExcessAssetRecovered}, like every other owner action, so a treasury
    ///      withdrawal is followable from logs alone rather than only from ERC-20 transfers.
    function recoverExcessAsset(uint256 amount) external onlyOwner {
        if (amount == 0) revert ZeroAmount();
        asset.safeTransfer(owner(), amount);
        emit ExcessAssetRecovered(owner(), amount);
    }
}
