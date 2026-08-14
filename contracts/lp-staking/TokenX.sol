// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/**
 * @title TokenX
 * @notice LP staking reward token. 18 decimals, EIP-2612 permit, burnable.
 *
 *  Minting:
 *    - Exactly one address — `minter` — may call `mint`. The owner (a multisig)
 *      sets it with `setMinter`. That is the escape hatch: if the rewards
 *      distributor is found to be buggy, the owner deploys a fixed distributor
 *      and re-points `minter` at it. Setting `minter` to address(0) disables
 *      minting entirely.
 *    - The token enforces its own per-epoch mint cap, independent of whatever
 *      the distributor believes. `setEpochCap(epochId, cap)` selects the current
 *      epoch and its cap in one call; `mint` accumulates into
 *      `mintedInEpoch[currentEpochId]` and reverts once the cap is reached.
 *      This is defense in depth — a compromised or broken distributor can never
 *      mint more than the cap the owner armed for the running epoch.
 *    - Tallies are keyed by epoch id and persist. Re-selecting an old epoch id
 *      keeps that epoch's earlier tally, so it cannot be reset by rotation.
 *    - Lowering a cap below the amount already minted in that epoch is allowed;
 *      it simply blocks all further minting in the epoch.
 *    - The initial state is `currentEpochId = 0` with a zero cap, so no mint can
 *      succeed until the owner arms an epoch.
 *
 *  Name and symbol are constructor parameters — the final branding is decided
 *  by the team at deployment time.
 */
contract TokenX is ERC20, ERC20Burnable, ERC20Permit, Ownable {
    // ──────────────────────── Errors ───────────────────────────

    /// @dev `mint` was called by an address that is not the current `minter`.
    error NotMinter(address caller);

    /// @dev The mint would push the running epoch past its armed cap.
    error EpochMintCapExceeded(uint256 epochId, uint256 cap, uint256 alreadyMinted, uint256 requested);

    // ──────────────────────── State ────────────────────────────

    /// @notice The only address allowed to call `mint`. address(0) disables minting.
    address public minter;

    /// @notice Epoch id that `mint` currently accounts against. Set by `setEpochCap`.
    uint256 public currentEpochId;

    /// @notice Maximum amount mintable in an epoch, keyed by epoch id.
    mapping(uint256 => uint256) public epochCap;

    /// @notice Amount already minted in an epoch, keyed by epoch id. Never reset.
    mapping(uint256 => uint256) public mintedInEpoch;

    // ──────────────────────── Events ───────────────────────────

    event MinterChanged(address previousMinter, address newMinter);
    event EpochCapSet(uint256 epochId, uint256 cap);

    // ──────────────────────── Constructor ──────────────────────

    /// @param _name         ERC-20 name; also the EIP-712 domain name used by `permit`.
    /// @param _symbol       ERC-20 symbol.
    /// @param _initialOwner Owner (multisig). Controls `setMinter` and `setEpochCap`.
    constructor(string memory _name, string memory _symbol, address _initialOwner)
        ERC20(_name, _symbol)
        ERC20Permit(_name)
        Ownable(_initialOwner)
    {}

    // ──────────────────────── Modifiers ────────────────────────

    modifier onlyMinter() {
        if (msg.sender != minter) revert NotMinter(msg.sender);
        _;
    }

    // ──────────────────────── Minting ──────────────────────────

    /// @notice Mint new tokens. Callable only by `minter`, and only while the
    ///         running epoch has cap headroom left.
    /// @param to     Recipient of the newly minted tokens.
    /// @param amount Amount to mint, in wei (18 decimals).
    function mint(address to, uint256 amount) external onlyMinter {
        uint256 epochId = currentEpochId;
        uint256 cap = epochCap[epochId];
        uint256 minted = mintedInEpoch[epochId];

        // Subtraction, not `minted + amount > cap`: the cap can be lowered below
        // the tally, and this keeps the typed error instead of an overflow panic.
        uint256 remaining = cap > minted ? cap - minted : 0;
        if (amount > remaining) {
            revert EpochMintCapExceeded(epochId, cap, minted, amount);
        }

        mintedInEpoch[epochId] = minted + amount;
        _mint(to, amount);
    }

    // ──────────────────────── Owner functions ──────────────────

    /// @notice Point minting rights at a new address. address(0) disables minting.
    /// @param _minter The new minter, typically the rewards distributor.
    function setMinter(address _minter) external onlyOwner {
        emit MinterChanged(minter, _minter);
        minter = _minter;
    }

    /// @notice Select the running epoch and arm its mint cap in one call.
    ///         Re-selecting an earlier epoch id keeps that epoch's existing tally.
    /// @param epochId Epoch id that subsequent mints account against.
    /// @param cap     Maximum total amount mintable in that epoch, in wei.
    function setEpochCap(uint256 epochId, uint256 cap) external onlyOwner {
        currentEpochId = epochId;
        epochCap[epochId] = cap;
        emit EpochCapSet(epochId, cap);
    }
}
