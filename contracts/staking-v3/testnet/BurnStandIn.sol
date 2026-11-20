// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.38;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @dev The two token entries the burn uses (the test $ASSET has both).
interface IBurnableToken {
    function burnFrom(address account, uint256 value) external;
}

/**
 * @title BurnStandIn
 * @notice TEST STAND-IN, NEVER DEPLOYED ON A MAINNET. It copies the burn interface of the
 *         bridge owner's burn contract on Ethereum (his answer of 2026-11-20, section 2) so the
 *         transition can be rehearsed on Sepolia before his own test instance exists. Only the
 *         interface and the listed reverts are copied; the owner setters are test-only.
 *
 *  THE BURN. `from` is always the caller. The tokens are taken from the caller with the token's
 *  `burnFrom`, after an `approve` ({migrate}) or with an EIP-2612 permit ({migrateWithPermit}:
 *  owner = the caller, spender = this contract, value = `amount` exactly). The token emits
 *  `Transfer(from, address(0), amount)` in the same transaction. Every burn emits
 *  {Migrated} with `id = keccak256(abi.encode(block.chainid, address(this), seq, from,
 *  destination, amount))`, where `seq` counts every burn from 0, so two equal burns have
 *  different ids.
 *
 *  A permit that was already submitted by someone else (its nonce spent) does not fail the call
 *  when the allowance it granted still covers `amount`: the permit is tried, and on failure the
 *  burn goes on against the existing allowance (`burnFrom` reverts when it is short).
 *
 *  THE REVERTS, in this order: before {opened} ({NotOpened}), after {closeAt} ({Closed}; the
 *  second `closeAt` itself is still open), while {paused} ({MigrationPaused}), `amount <
 *  MIN_AMOUNT` ({AmountBelowMinimum}), a zero `destination` ({ZeroDestination}), and the access
 *  signature: the two short variants revert {AccessSignatureRequired} while {requireSignature}
 *  is on.
 *
 *  THE ACCESS SIGNATURE. The bridge owner did not publish his digest, and the site only passes
 *  the bytes it receives on, so this stand-in defines its own. It covers only the caller and a
 *  deadline, as an EIP-712 typed message signed by {accessSigner}:
 *
 *      domain  EIP712Domain(name "BurnStandIn", version "1", chainId, verifyingContract = this)
 *      type    MigrationAccess(address account,uint256 deadline)
 *      digest  keccak256("\x19\x01" || domainSeparator ||
 *                        keccak256(abi.encode(MIGRATION_ACCESS_TYPEHASH, account, deadline)))
 *
 *  with `account` = the caller. {accessDigest} returns it. A deadline in the past
 *  (`block.timestamp > deadline`) reverts {AccessSignatureExpired}; a signature that does not
 *  recover to {accessSigner} reverts {InvalidAccessSignature}. The two long variants check the
 *  signature whenever they are called, also while {requireSignature} is off.
 */
contract BurnStandIn is Ownable, EIP712 {
    /// @notice The smallest burn, `amount >= MIN_AMOUNT`.
    uint256 public constant MIN_AMOUNT = 1e18;

    /// @notice The EIP-712 type of the access signature.
    bytes32 public constant MIGRATION_ACCESS_TYPEHASH = keccak256("MigrationAccess(address account,uint256 deadline)");

    /// @notice The token burned (the test $ASSET: `burnFrom` and EIP-2612 `permit`).
    IERC20 public immutable token;

    /// @notice True while burns are stopped.
    bool public paused;
    /// @notice True while the access signature is required.
    bool public requireSignature;
    /// @notice False until the owner opens the burn.
    bool public opened;
    /// @notice The last second a burn is accepted (unix time).
    uint256 public closeAt;
    /// @notice The key whose EIP-712 signature grants access ({accessDigest}).
    address public accessSigner;
    /// @notice The `seq` of the next burn; equal to the number of burns so far.
    uint256 public nextSeq;

    event Migrated(bytes32 indexed id, uint256 seq, address indexed from, address indexed destination, uint256 amount);

    error ZeroAddress();
    error NotOpened();
    error Closed(uint256 closeAt);
    error MigrationPaused();
    error AmountBelowMinimum(uint256 amount, uint256 minimum);
    error ZeroDestination();
    error AccessSignatureRequired();
    error AccessSignatureExpired(uint256 deadline);
    error InvalidAccessSignature();

    /**
     * @param token_ The burned token.
     * @param owner_ The test operator who may use the setters.
     * @param accessSigner_ The access signature key.
     * @param closeAt_ The last second a burn is accepted.
     */
    constructor(address token_, address owner_, address accessSigner_, uint256 closeAt_)
        Ownable(owner_)
        EIP712("BurnStandIn", "1")
    {
        if (token_ == address(0)) revert ZeroAddress();
        token = IERC20(token_);
        accessSigner = accessSigner_;
        closeAt = closeAt_;
    }

    // ──────────────────────── The burn ─────────────────────────

    /// @notice Burns `amount` of the caller's tokens (after an `approve`) for `destination`.
    function migrate(uint256 amount, address destination) external {
        _checkOpen(amount, destination);
        if (requireSignature) revert AccessSignatureRequired();
        _burn(amount, destination);
    }

    /// @notice {migrate} with the caller's EIP-2612 permit for exactly `amount`.
    function migrateWithPermit(
        uint256 amount,
        address destination,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        _checkOpen(amount, destination);
        if (requireSignature) revert AccessSignatureRequired();
        _permit(amount, permitDeadline, v, r, s);
        _burn(amount, destination);
    }

    /// @notice {migrate} with the access signature for (the caller, `deadline`).
    function migrate(uint256 amount, address destination, uint256 deadline, bytes calldata signature) external {
        _checkOpen(amount, destination);
        _checkAccess(deadline, signature);
        _burn(amount, destination);
    }

    /// @notice {migrateWithPermit} with the access signature for (the caller, `deadline`).
    function migrateWithPermit(
        uint256 amount,
        address destination,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s,
        uint256 deadline,
        bytes calldata signature
    ) external {
        _checkOpen(amount, destination);
        _checkAccess(deadline, signature);
        _permit(amount, permitDeadline, v, r, s);
        _burn(amount, destination);
    }

    /// @notice The EIP-712 digest {accessSigner} signs to let `account` burn until `deadline`.
    function accessDigest(address account, uint256 deadline) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(MIGRATION_ACCESS_TYPEHASH, account, deadline)));
    }

    // ──────────────────────── Test-only setters ────────────────

    function setOpened(bool opened_) external onlyOwner {
        opened = opened_;
    }

    function setCloseAt(uint256 closeAt_) external onlyOwner {
        closeAt = closeAt_;
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
    }

    function setRequireSignature(bool requireSignature_) external onlyOwner {
        requireSignature = requireSignature_;
    }

    function setAccessSigner(address accessSigner_) external onlyOwner {
        accessSigner = accessSigner_;
    }

    // ──────────────────────── Internal ─────────────────────────

    function _checkOpen(uint256 amount, address destination) private view {
        if (!opened) revert NotOpened();
        if (block.timestamp > closeAt) revert Closed(closeAt);
        if (paused) revert MigrationPaused();
        if (amount < MIN_AMOUNT) revert AmountBelowMinimum(amount, MIN_AMOUNT);
        if (destination == address(0)) revert ZeroDestination();
    }

    function _checkAccess(uint256 deadline, bytes calldata signature) private view {
        if (block.timestamp > deadline) revert AccessSignatureExpired(deadline);
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(accessDigest(msg.sender, deadline), signature);
        if (err != ECDSA.RecoverError.NoError || recovered != accessSigner) revert InvalidAccessSignature();
    }

    /// @dev The permit is tried; a spent one is fine when its allowance still covers `amount`
    ///      (`burnFrom` reverts otherwise).
    function _permit(uint256 amount, uint256 permitDeadline, uint8 v, bytes32 r, bytes32 s) private {
        try IERC20Permit(address(token)).permit(msg.sender, address(this), amount, permitDeadline, v, r, s) {} catch {}
    }

    function _burn(uint256 amount, address destination) private {
        uint256 seq = nextSeq++;
        bytes32 id = keccak256(abi.encode(block.chainid, address(this), seq, msg.sender, destination, amount));
        IBurnableToken(address(token)).burnFrom(msg.sender, amount);
        emit Migrated(id, seq, msg.sender, destination, amount);
    }
}
