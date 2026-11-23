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
 *         bridge owner's burn contract on Ethereum (his answer of 2026-11-20, section 2, with his
 *         changes of 2026-11-23) so the transition can be rehearsed on Sepolia before his own test
 *         instance exists. Only the interface, the access signature, the opening rules and the
 *         reverts in their order are copied; the owner setters are test-only.
 *
 *  THE BURN. `from` is always the caller. The tokens are taken from the caller with the token's
 *  `burnFrom`, after an `approve` ({migrate}) or with an EIP-2612 permit ({migrateWithPermit}:
 *  owner = the caller, spender = this contract, value = `amount` exactly). The token emits
 *  `Transfer(from, address(0), amount)` in the same transaction. Every burn emits
 *  {Migrated} with `id = keccak256(abi.encode(block.chainid, address(this), seq, from,
 *  destination, amount))`, where `seq` counts every burn from 0, so two equal burns have
 *  different ids.
 *
 *  The permit is tried and a failure is ignored: the burn goes on against the existing allowance
 *  (`burnFrom` reverts when it is short). So a permit already submitted by someone else does not
 *  fail the call while its allowance still covers `amount`.
 *
 *  OPENING. `closeAt` is 0 until the owner's {open} (once), which sets {opened} and `closeAt =
 *  block.timestamp + 90 days`. {extendCloseAt} moves `closeAt` only later, also after it passed
 *  (that opens the burn again). {opened} stays true after the end. A burn passes while
 *  `opened && !paused && block.timestamp <= closeAt` (the second `closeAt` itself still passes).
 *
 *  BLOCKED DESTINATIONS. {blockedDestination} lists receivers a burn may not name; the constructor
 *  puts the token and this contract on it, the owner adds and removes addresses.
 *
 *  THE ACCESS SIGNATURE (the bridge owner's format of 2026-11-23), signed by {accessSigner}:
 *
 *      domain  EIP712Domain(name "ASSET Migration", version "1", chainId, verifyingContract = this)
 *      type    MigrationAccess(address from,uint256 deadline)     from = the caller
 *      bytes   65, r || s || v, low s, v = 27 or 28; valid while block.timestamp <= deadline
 *
 *  {accessDigest} returns the digest. While {requireSignature} is on, the two short variants
 *  revert and the two long ones check the signature. While it is off, the two long variants
 *  ignore `deadline` and `signature` completely (an expired deadline and garbage bytes pass).
 *
 *  THE CHECKS, in this order; the first failing one gives the error:
 *    1 the requirement is on and the variant has no signature   {AccessSignatureRequired}
 *    2 the requirement is on and the deadline passed            {AccessSignatureExpired}
 *    3 the requirement is on and the signature is not valid      {InvalidAccessSignature}
 *    4 paused                                                    {EnforcedPause}
 *    5 before {open}                                             {NotOpened}
 *    6 after `closeAt`                                           {MigrationClosed}
 *    7 a zero receiver                                           {ZeroDestination}
 *    8 a blocked receiver                                        {DestinationBlocked}
 *    9 `amount < MIN_AMOUNT`                                     {AmountBelowMinimum}
 *   10 no allowance or balance                                   the token's own error
 *
 *  No OpenZeppelin `Pausable`: its `Paused` / `Unpaused` events are not in the bridge's ABI.
 */
contract BurnStandIn is Ownable, EIP712 {
    /// @notice The smallest burn, `amount >= MIN_AMOUNT`.
    uint256 public constant MIN_AMOUNT = 1e18;

    /// @dev How long the burn stays open after {open} (`closeAt = open time + OPEN_DURATION`).
    uint256 private constant OPEN_DURATION = 90 days;

    /// @notice The EIP-712 type of the access signature.
    bytes32 public constant MIGRATION_ACCESS_TYPEHASH = keccak256("MigrationAccess(address from,uint256 deadline)");

    /// @notice The token burned (the test $ASSET: `burnFrom` and EIP-2612 `permit`).
    IERC20 public immutable token;

    /// @notice True while burns are stopped.
    bool public paused;
    /// @notice True while the access signature is required.
    bool public requireSignature;
    /// @notice False until the owner's {open}; stays true after the end.
    bool public opened;
    /// @notice The last second a burn is accepted (unix time); 0 before {open}.
    uint256 public closeAt;
    /// @notice The key whose EIP-712 signature grants access ({accessDigest}).
    address public accessSigner;
    /// @notice The `seq` of the next burn; equal to the number of burns so far.
    uint256 public nextSeq;
    /// @notice True for a receiver a burn may not name.
    mapping(address destination => bool) public blockedDestination;

    event Migrated(bytes32 indexed id, uint256 seq, address indexed from, address indexed destination, uint256 amount);

    error ZeroAddress();
    error AccessSignatureRequired();
    error AccessSignatureExpired(uint256 deadline);
    error InvalidAccessSignature();
    error EnforcedPause();
    error NotOpened();
    error MigrationClosed(uint256 closeAt);
    error ZeroDestination();
    error DestinationBlocked(address destination);
    error AmountBelowMinimum(uint256 amount);
    error AlreadyOpened();
    error CloseAtNotLater(uint256 current, uint256 given);

    /**
     * @param token_ The burned token.
     * @param owner_ The test operator who may use the setters.
     * @param accessSigner_ The access signature key.
     */
    constructor(address token_, address owner_, address accessSigner_)
        Ownable(owner_)
        EIP712("ASSET Migration", "1")
    {
        if (token_ == address(0)) revert ZeroAddress();
        token = IERC20(token_);
        accessSigner = accessSigner_;
        blockedDestination[token_] = true;
        blockedDestination[address(this)] = true;
    }

    // ──────────────────────── The burn ─────────────────────────

    /// @notice Burns `amount` of the caller's tokens (after an `approve`) for `destination`.
    function migrate(uint256 amount, address destination) external {
        if (requireSignature) revert AccessSignatureRequired();
        _checkOpen(amount, destination);
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
        if (requireSignature) revert AccessSignatureRequired();
        _checkOpen(amount, destination);
        _permit(amount, permitDeadline, v, r, s);
        _burn(amount, destination);
    }

    /// @notice {migrate} with the access signature for (the caller, `deadline`); both are ignored
    ///         while {requireSignature} is off.
    function migrate(uint256 amount, address destination, uint256 deadline, bytes calldata signature) external {
        if (requireSignature) _checkAccess(deadline, signature);
        _checkOpen(amount, destination);
        _burn(amount, destination);
    }

    /// @notice {migrateWithPermit} with the access signature for (the caller, `deadline`); both are
    ///         ignored while {requireSignature} is off.
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
        if (requireSignature) _checkAccess(deadline, signature);
        _checkOpen(amount, destination);
        _permit(amount, permitDeadline, v, r, s);
        _burn(amount, destination);
    }

    /// @notice The EIP-712 digest {accessSigner} signs to let `from` burn until `deadline`.
    function accessDigest(address from, uint256 deadline) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(MIGRATION_ACCESS_TYPEHASH, from, deadline)));
    }

    // ──────────────────────── Opening ──────────────────────────

    /// @notice Opens the burn, once: `closeAt = block.timestamp + OPEN_DURATION`.
    function open() external onlyOwner {
        if (opened) revert AlreadyOpened();
        opened = true;
        closeAt = block.timestamp + OPEN_DURATION;
    }

    /// @notice Moves `closeAt` later, also after it passed (that opens the burn again).
    function extendCloseAt(uint256 newCloseAt) external onlyOwner {
        if (!opened) revert NotOpened();
        if (newCloseAt <= closeAt) revert CloseAtNotLater(closeAt, newCloseAt);
        closeAt = newCloseAt;
    }

    // ──────────────────────── Test-only setters ────────────────

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
    }

    function setRequireSignature(bool requireSignature_) external onlyOwner {
        requireSignature = requireSignature_;
    }

    function setAccessSigner(address accessSigner_) external onlyOwner {
        accessSigner = accessSigner_;
    }

    function setBlockedDestination(address destination, bool blocked) external onlyOwner {
        blockedDestination[destination] = blocked;
    }

    // ──────────────────────── Internal ─────────────────────────

    /// @dev Checks 2 and 3 of the list (1 is in the short variants).
    function _checkAccess(uint256 deadline, bytes calldata signature) private view {
        if (block.timestamp > deadline) revert AccessSignatureExpired(deadline);
        (address recovered, ECDSA.RecoverError err,) =
            ECDSA.tryRecoverCalldata(accessDigest(msg.sender, deadline), signature);
        if (err != ECDSA.RecoverError.NoError || recovered != accessSigner) revert InvalidAccessSignature();
    }

    /// @dev Checks 4 to 9 of the list.
    function _checkOpen(uint256 amount, address destination) private view {
        if (paused) revert EnforcedPause();
        if (!opened) revert NotOpened();
        if (block.timestamp > closeAt) revert MigrationClosed(closeAt);
        if (destination == address(0)) revert ZeroDestination();
        if (blockedDestination[destination]) revert DestinationBlocked(destination);
        if (amount < MIN_AMOUNT) revert AmountBelowMinimum(amount);
    }

    /// @dev The permit is tried; a failed one is ignored (`burnFrom` reverts when the allowance is short).
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
