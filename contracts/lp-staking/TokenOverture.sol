// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20BurnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";

/**
 * @title TokenOverture
 * @notice The Overture token (ticker $OVTR): one of the LP staking reward tokens. ERC-20 with
 *         18 decimals, EIP-2612 permit, burnable.
 *
 *  Supply:
 *    - Exactly one address — `minter` — may call `mint`. At launch the minter is the operator
 *      multisig, which mints $OVTR INTO `RewardsDistributor`; the distributor pays claims out of
 *      that balance by transfer, exactly like $ASSET. The distributor never mints.
 *    - There is no cap of any kind: no per-epoch cap, no total cap, no schedule. How much $OVTR
 *      exists is decided by the minter, and the emission schedule lives in `LPEpochRegistry`,
 *      which bounds nothing.
 *    - `mint` rejects a zero amount, so the token never emits a zero-value `Transfer` of its own
 *      making.
 *    - The owner (the timelock) moves the minter role with {setMinter}; `address(0)` disables
 *      minting entirely.
 *
 *  UPGRADEABILITY. This contract is the implementation behind a UUPS (ERC-1967) proxy — see
 *  `contracts/lp-staking/deploy/LPProxy.sol`. The proxy address is the token address.
 *    - `minter` lives in the ERC-7201 namespace `real.lp.storage.TokenOverture`. The ERC-20
 *      balances, the name and symbol, the permit domain and nonces, and the owner live in
 *      OpenZeppelin's own namespaces. An upgrade may append fields to ours.
 *    - The permit domain is `(name, "1", chainId, proxy address)`: `__ERC20Permit_init(name)`
 *      seeds it in the proxy's storage, and `address(this)` is the proxy under delegatecall.
 *    - The implementation's own initializers are disabled in its constructor.
 *    - Owner = the timelock: upgrades and `setMinter` take its public delay.
 *    - Ownership is two-step and `renounceOwnership` is disabled: an ownerless token could
 *      never be upgraded nor have its minter moved.
 */
contract TokenOverture is
    Initializable,
    UUPSUpgradeable,
    ERC20Upgradeable,
    ERC20BurnableUpgradeable,
    ERC20PermitUpgradeable,
    Ownable2StepUpgradeable
{
    // ──────────────────────── Errors ───────────────────────────

    /// @dev `mint` was called by an address that is not the current `minter`.
    error NotMinter(address caller);

    /// @dev A zero amount was passed where a positive one is required.
    error ZeroAmount();

    /// @dev `renounceOwnership` is disabled: it would freeze the upgrade path and the minter role.
    error RenounceDisabled();

    // ──────────────────────── Events ───────────────────────────

    /// @notice The minter role moved. Carries both sides.
    event MinterChanged(address previousMinter, address newMinter);

    // ──────────────────────── Storage ──────────────────────────

    /// @custom:storage-location erc7201:real.lp.storage.TokenOverture
    struct TokenOvertureStorage {
        /// The only address allowed to call `mint`. Zero disables minting.
        address minter;
    }

    /**
     * @dev ERC-7201 slot for {TokenOvertureStorage}, computed as
     *      `keccak256(abi.encode(uint256(keccak256("real.lp.storage.TokenOverture")) - 1)) & ~bytes32(uint256(0xff))`.
     *      `test/forge/unit/TokenOverture.t.sol` recomputes it and fails if it drifts.
     */
    bytes32 private constant TOKEN_OVERTURE_STORAGE =
        0x7ca9f8db09cacc7881e534e068295c46832e8cbf76a90cb6e2f245c9bf51b600;

    function _tokenStorage() private pure returns (TokenOvertureStorage storage $) {
        assembly {
            $.slot := TOKEN_OVERTURE_STORAGE
        }
    }

    // ──────────────────────── Constructor ──────────────────────

    /// @notice Deploys the IMPLEMENTATION; the proxy in front of it runs {initialize}.
    constructor() {
        _disableInitializers();
    }

    // ──────────────────────── Initializer ──────────────────────

    /// @notice One-time setup, executed on the PROXY in its own deployment transaction.
    /// @param name_   ERC-20 name; also the EIP-712 domain name `permit` uses. "Overture" at launch.
    /// @param symbol_ ERC-20 symbol. "OVTR" at launch.
    /// @param owner_  Owner: the timelock. Upgrades and `setMinter`.
    /// @param minter_ Initial minter: the operator multisig. `address(0)` starts with minting off.
    function initialize(string calldata name_, string calldata symbol_, address owner_, address minter_)
        external
        initializer
    {
        __ERC20_init(name_, symbol_);
        __ERC20Burnable_init();
        __ERC20Permit_init(name_);
        __Ownable_init(owner_);
        __Ownable2Step_init();
        // No `__UUPSUpgradeable_init()`: OpenZeppelin v5.6 re-exports the plain `UUPSUpgradeable`,
        // which declares no initializer (see `RewardsDistributor.initialize`).

        _tokenStorage().minter = minter_;
        emit MinterChanged(address(0), minter_);
    }

    // ──────────────────────── Minting ──────────────────────────

    modifier onlyMinter() {
        if (msg.sender != _tokenStorage().minter) revert NotMinter(msg.sender);
        _;
    }

    /// @notice Mints `amount` new tokens to `to`. Minter only; no cap of any kind.
    function mint(address to, uint256 amount) external onlyMinter {
        if (amount == 0) revert ZeroAmount();
        _mint(to, amount);
    }

    /// @notice The only address allowed to call `mint`. Zero means minting is off.
    function minter() external view returns (address) {
        return _tokenStorage().minter;
    }

    // ──────────────────────── Owner functions ──────────────────

    /// @notice Moves the minter role. `address(0)` disables minting.
    function setMinter(address newMinter) external onlyOwner {
        TokenOvertureStorage storage $ = _tokenStorage();
        emit MinterChanged($.minter, newMinter);
        $.minter = newMinter;
    }

    /// @notice UUPS upgrade hook: the owner (the timelock) authorizes every code change.
    function _authorizeUpgrade(address) internal override onlyOwner {}

    /// @notice Disabled. See {RenounceDisabled}.
    /// @dev Kept `onlyOwner` and deliberately NOT `view`: the ABI entry must keep looking like the
    ///      transaction it overrides so a caller gets the revert on-chain.
    function renounceOwnership() public override onlyOwner {
        revert RenounceDisabled();
    }
}
