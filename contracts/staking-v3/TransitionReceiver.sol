// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.38;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";

import "./interfaces/ITransition.sol";

/**
 * @title TransitionReceiver
 * @notice The receiving side of the transition on Avalanche (spec 01 §9.3). Every holder (the
 *         staker's own wallet, the same address on Ethereum and on Avalanche) has one receiving
 *         address per route (1 Compound, 2 Join LP and compound, 3 Claim rewards and restake
 *         principal): a CREATE2 address of this proxy, computed and never stored. The staker names it
 *         as the destination of the bridge's burn and of Circle's USDC transfer, and the tokens
 *         arrive there as plain transfers, usually before anything is deployed at that address.
 *
 *  ONLY TWO WAYS OUT. Tokens at a receiving address move only through this contract:
 *    - {deliver} (the deliverer, i.e. the service key, or the holder itself) hands them to the
 *      `StakingMigrator` entry of the address's route, which stakes them FOR the holder under a
 *      delivery voucher signed by the migrator's separate voucher key; what the voucher does not
 *      allow stays at the address;
 *    - {release} sends the whole balance of both tokens to the holder's own address, never anywhere
 *      else, each token as its own leg so a token that refuses the transfer cannot lock the other.
 *      The LP vault's operator may call it at any time, also for its own receiving address. Any
 *      other holder may call it for itself only while the operator's switch {holderReleaseOpen} is
 *      on ({setHolderRelease}); it is off after
 *      deployment and nothing turns it on by itself (the contract does not read the end of Testnet
 *      Staking). The switch is not a pause: it never stops {deliver} nor the operator's
 *      {release}, and what was already delivered (the Testnet Staking stake, the LP position) is the
 *      staker's own and leaves through those contracts' own exits.
 *  The first {deliver} or {release} for a holder and route places a {TransitionHolder} at the
 *  address with CREATE2; that contract can only hand its tokens to this proxy.
 *
 *  THE CREATION CODE IS FIXED FOR EVER. {HOLDER_CREATION_CODE} and {HOLDER_INIT_CODE_HASH} are
 *  byte literals (the compiled `TransitionHolder.sol`, compiler metadata included), never
 *  `type(TransitionHolder).creationCode`: the compiler's metadata hash moves with any source or
 *  setting, and a new hash would move every receiving address. An upgrade of this contract must
 *  keep both literals unchanged.
 *
 *  No pause and no guardian: the trading routes pause in the migrator (`pauseCompound`), and the
 *  operator's {release} is always an exit. Holds no tokens between transactions; no ETH.
 *
 *  ADMIN: owner (the timelock) — upgrades, ownership; operator (the LP vault's, read live, no
 *  delay) — {setDeliverer}, {setHolderRelease}, {release} at any time.
 */
contract TransitionReceiver is Initializable, UUPSUpgradeable, Ownable2StepUpgradeable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    // ──────────────────────── Constants ────────────────────────

    /// @notice The creation code of `TransitionHolder.sol` as compiled on 2026-11-20 (solc 0.8.38,
    ///         optimizer 200 runs, cancun). Never changes.
    bytes public constant HOLDER_CREATION_CODE =
        hex"60a0604052348015600e575f5ffd5b50336080526080516101d16100305f395f8181604d015260a101526101d15ff3fe"
        hex"608060405234801561000f575f5ffd5b5060043610610029575f3560e01c8063f2d5d56b1461002d575b5f5ffd5b6100"
        hex"4061003b366004610166565b610042565b005b336001600160a01b037f00000000000000000000000000000000000000"
        hex"0000000000000000000000000016146100925760405163b1d0d50760e01b81523360048201526024015b604051809103"
        hex"90fd5b6100c66001600160a01b0383167f00000000000000000000000000000000000000000000000000000000000000"
        hex"00836100ca565b5050565b6100d78383836001610104565b6100ff57604051635274afe760e01b81526001600160a01b"
        hex"0384166004820152602401610089565b505050565b60405163a9059cbb60e01b5f8181526001600160a01b0386166004"
        hex"52602485905291602083604481808b5af1925060015f5114831661015a57838315161561014e573d5f823e3d81fd5b5f"
        hex"873b113d1516831692505b60405250949350505050565b5f5f60408385031215610177575f5ffd5b82356001600160a0"
        hex"1b038116811461018d575f5ffd5b94602093909301359350505056fea26469706673582212203e75a2bda33bb069bbc3"
        hex"f8371a189a34ba5f107305d5281c3383e847e875563964736f6c63430008260033";

    /// @notice keccak256 of {HOLDER_CREATION_CODE}: the init code hash of every receiving address.
    bytes32 public constant HOLDER_INIT_CODE_HASH = 0xc9fdfcb43183a49244ffe584d9e69edfb144922f0930ecd33fd099814b33579b;

    uint8 private constant ROUTE_COMPOUND = 1;
    uint8 private constant ROUTE_LP = 2;
    uint8 private constant ROUTE_RESTAKE = 3;

    // ──────────────────────── Immutables ───────────────────────

    /// @notice The `StakingMigrator` proxy.
    address public immutable migrator;
    /// @notice $ASSET (the migrator's).
    address public immutable asset;
    /// @notice USDC (the migrator's).
    address public immutable usdc;
    /// @notice The `LPStakingVault` proxy (the migrator's); its `operator()` is this contract's operator.
    address public immutable lpVault;

    // ──────────────────────── Storage ──────────────────────────

    /// @custom:storage-location erc7201:real.staking.storage.TransitionReceiver
    struct ReceiverStorage {
        /// The service key that may {deliver} for any holder (zero: no service).
        address deliverer;
        /// True while the holder itself may {release} (false after deployment; the operator's switch).
        bool holderReleaseOpen;
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("real.staking.storage.TransitionReceiver")) - 1)) & ~0xff
    bytes32 private constant RECEIVER_STORAGE = 0xbf47d769c666d32187355e6a46533dc36966945841db7129fd2683fcc6da5900;

    function _receiverStorage() private pure returns (ReceiverStorage storage $) {
        assembly {
            $.slot := RECEIVER_STORAGE
        }
    }

    // ──────────────────────── Events ───────────────────────────

    event Delivered(
        address indexed holder,
        uint8 indexed route,
        address indexed receivingAddress,
        address caller,
        uint256 nonce,
        uint256 burnTime,
        uint256 assetIn,
        uint256 usdcIn,
        uint256 staked,
        uint256 lpTokenId,
        uint256 bonus,
        uint256 principalDelivered,
        uint256 rewardDelivered
    );
    event Released(
        address indexed holder,
        uint8 indexed route,
        address indexed receivingAddress,
        address caller,
        uint256 assetAmount,
        uint256 usdcAmount
    );
    event HolderPlaced(address indexed holder, uint8 indexed route, address receivingAddress);
    event DelivererSet(address previousDeliverer, address newDeliverer);
    event HolderReleaseSet(bool open);

    // ──────────────────────── Errors ───────────────────────────

    error ZeroAddress();
    error InvalidRoute(uint8 route);
    error NotDelivererOrHolder(address caller, address deliverer, address holder);
    error NotHolderOrOperator(address caller, address holder, address operator);
    error NotOperator(address caller, address operator);
    error HolderReleaseClosed();
    error NothingToDeliver(address holder, uint8 route);
    error NothingToRelease(address holder, uint8 route);
    error HolderPlacementFailed(address expected, address placed);
    error ReleaseFailed(address holder, uint8 route);
    error OnlySelf();
    error RenounceDisabled();

    // ──────────────────────── Constructor ──────────────────────

    /**
     * @notice Deploys the IMPLEMENTATION; the migrator's market references are kept `immutable`.
     * @param migrator_ The `StakingMigrator` proxy.
     * @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
     */
    constructor(address migrator_) {
        if (migrator_ == address(0)) revert ZeroAddress();
        ITransitionMigratorMarket m = ITransitionMigratorMarket(migrator_);
        address asset_ = m.asset();
        address usdc_ = m.usdc();
        address lpVault_ = m.lpVault();
        if (asset_ == address(0) || usdc_ == address(0) || lpVault_ == address(0)) revert ZeroAddress();
        migrator = migrator_;
        asset = asset_;
        usdc = usdc_;
        lpVault = lpVault_;
        _disableInitializers();
    }

    // ──────────────────────── Initializer ──────────────────────

    /**
     * @param owner_ The timelock, or the deployer while the deploy script wires the v3 contracts.
     * @param deliverer_ The service key (zero allowed: no service; the holders deliver themselves).
     */
    function initialize(address owner_, address deliverer_) external initializer {
        __Ownable_init(owner_);
        __Ownable2Step_init();
        _receiverStorage().deliverer = deliverer_;
        emit DelivererSet(address(0), deliverer_);
    }

    // ──────────────────────── The receiving addresses ──────────

    /// @notice The receiving address of `holder` for `route`: CREATE2 of this proxy with
    ///         `salt = keccak256(abi.encode(holder, route))` and {HOLDER_INIT_CODE_HASH}.
    function receivingAddressOf(address holder, uint8 route) public view returns (address) {
        _checkRoute(route);
        if (holder == address(0)) revert ZeroAddress();
        bytes32 salt = keccak256(abi.encode(holder, route));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, HOLDER_INIT_CODE_HASH)))));
    }

    /// @notice True once the holding contract is placed at the receiving address.
    function isPlaced(address holder, uint8 route) external view returns (bool) {
        return receivingAddressOf(holder, route).code.length > 0;
    }

    // ──────────────────────── Deliver and release ──────────────

    /**
     * @notice Stakes, for `holder`, what arrived at the holder's receiving address of `route`, as far
     *         as the voucher allows. The deliverer or the holder.
     * @dev Takes `min(balance, voucher limit - delivered so far)` of each token (no USDC for route 3,
     *      nor for route 2 once its position exists), pulls it from the holding contract, approves
     *      exactly it to the migrator, calls the route's migrator entry (which pulls it and reverts
     *      on any rule it breaks; its revert bubbles up unchanged) and sets both approvals back to
     *      zero. The rest stays at the receiving address.
     */
    function deliver(
        address holder,
        uint8 route,
        ITransitionMigrator.DeliveryLimits calldata limits,
        ITransitionMigrator.DeliveryVoucher calldata voucher
    ) external nonReentrant returns (ITransitionMigrator.DeliveryResult memory result) {
        address deliverer_ = _receiverStorage().deliverer;
        if (msg.sender != deliverer_ && msg.sender != holder) {
            revert NotDelivererOrHolder(msg.sender, deliverer_, holder);
        }
        address receiving = _place(holder, route);

        (uint256 assetIn, uint256 usdcIn) = _deliverable(holder, route, receiving, voucher);
        if (assetIn == 0 && usdcIn == 0) revert NothingToDeliver(holder, route);

        _take(receiving, asset, assetIn);
        _take(receiving, usdc, usdcIn);
        if (route == ROUTE_COMPOUND) {
            result = ITransitionMigrator(migrator).compoundFor(holder, assetIn, usdcIn, limits, voucher);
        } else if (route == ROUTE_LP) {
            result = ITransitionMigrator(migrator).moveToLpFor(holder, assetIn, usdcIn, limits, voucher);
        } else {
            result = ITransitionMigrator(migrator).claimRestakeFor(holder, assetIn, limits, voucher);
        }
        if (assetIn > 0) IERC20(asset).forceApprove(migrator, 0);
        if (usdcIn > 0) IERC20(usdc).forceApprove(migrator, 0);

        _emitDelivered(holder, route, receiving, voucher, assetIn, usdcIn, result);
    }

    /**
     * @notice Sends the whole $ASSET and USDC balance of the holder's receiving address of `route` to
     *         `holder`, never to another address. The LP vault's operator at any time; the holder only
     *         while {holderReleaseOpen} ({HolderReleaseClosed} otherwise).
     * @dev Each token is its own leg ({releaseLeg}, called on this contract inside `try`): a leg that
     *      reverts (the holder on USDC's blacklist, USDC paused) is rolled back whole, its token
     *      stays at the receiving address and its amount is reported as 0 in {Released}; the other
     *      leg still pays. {NothingToRelease} when both balances are zero, {ReleaseFailed} when a
     *      balance exists and every attempted leg reverted. The operator is read when the caller is
     *      not the holder, or when the holder calls while {holderReleaseOpen} is off (an operator that
     *      is itself the holder still releases); the holder's call while it is on never reads it.
     */
    function release(address holder, uint8 route) external nonReentrant {
        if (msg.sender != holder) {
            address operator_ = ITransitionLpVault(lpVault).operator();
            if (msg.sender != operator_) revert NotHolderOrOperator(msg.sender, holder, operator_);
        } else if (!_receiverStorage().holderReleaseOpen) {
            if (msg.sender != ITransitionLpVault(lpVault).operator()) revert HolderReleaseClosed();
        }
        address receiving = _place(holder, route);

        uint256 assetAmount = IERC20(asset).balanceOf(receiving);
        uint256 usdcAmount = IERC20(usdc).balanceOf(receiving);
        if (assetAmount == 0 && usdcAmount == 0) revert NothingToRelease(holder, route);
        if (assetAmount > 0) {
            try this.releaseLeg(receiving, asset, holder, assetAmount) {} catch {
                assetAmount = 0;
            }
        }
        if (usdcAmount > 0) {
            try this.releaseLeg(receiving, usdc, holder, usdcAmount) {} catch {
                usdcAmount = 0;
            }
        }
        if (assetAmount == 0 && usdcAmount == 0) revert ReleaseFailed(holder, route);
        emit Released(holder, route, receiving, msg.sender, assetAmount, usdcAmount);
    }

    /**
     * @notice One token leg of {release}: pulls `amount` of `token` from the holding contract at
     *         `receiving` and sends it to `to`. Open ONLY to this contract itself ({OnlySelf}), which
     *         calls it from {release} inside `try`, so a leg that reverts is rolled back whole and
     *         cannot lock the other token.
     * @dev No reentrancy guard of its own: it is reachable only through {release}, which holds the
     *      guard, and a second guard would refuse this self call.
     */
    function releaseLeg(address receiving, address token, address to, uint256 amount) external {
        if (msg.sender != address(this)) revert OnlySelf();
        ITransitionHolder(receiving).pull(token, amount);
        IERC20(token).safeTransfer(to, amount);
    }

    // ──────────────────────── Admin ────────────────────────────

    /// @notice Replaces or clears (zero) the service key. The LP vault's operator, undelayed, so a
    ///         leaked key is replaceable at once; the owner is refused.
    function setDeliverer(address deliverer_) external {
        address operator_ = ITransitionLpVault(lpVault).operator();
        if (msg.sender != operator_) revert NotOperator(msg.sender, operator_);
        ReceiverStorage storage $ = _receiverStorage();
        emit DelivererSet($.deliverer, deliverer_);
        $.deliverer = deliverer_;
    }

    /// @notice The service key that may {deliver} for any holder.
    function deliverer() external view returns (address) {
        return _receiverStorage().deliverer;
    }

    /// @notice Opens (true) or closes (false) the holder's own {release}. The LP vault's operator,
    ///         undelayed; the owner is refused. The operator's {release} is never affected.
    function setHolderRelease(bool open) external {
        address operator_ = ITransitionLpVault(lpVault).operator();
        if (msg.sender != operator_) revert NotOperator(msg.sender, operator_);
        _receiverStorage().holderReleaseOpen = open;
        emit HolderReleaseSet(open);
    }

    /// @notice True while the holder itself may {release}.
    function holderReleaseOpen() external view returns (bool) {
        return _receiverStorage().holderReleaseOpen;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function renounceOwnership() public override onlyOwner {
        revert RenounceDisabled();
    }

    // ──────────────────────── Internal ─────────────────────────

    function _checkRoute(uint8 route) private pure {
        if (route != ROUTE_COMPOUND && route != ROUTE_LP && route != ROUTE_RESTAKE) revert InvalidRoute(route);
    }

    /// @dev Places the holding contract at the receiving address when it has no code yet, and returns
    ///      the address. Checks the route and the holder (through {receivingAddressOf}).
    function _place(address holder, uint8 route) private returns (address receiving) {
        receiving = receivingAddressOf(holder, route);
        if (receiving.code.length > 0) return receiving;
        bytes memory code = HOLDER_CREATION_CODE;
        bytes32 salt = keccak256(abi.encode(holder, route));
        address placed;
        assembly ("memory-safe") {
            placed := create2(0, add(code, 0x20), mload(code), salt)
        }
        if (placed != receiving) revert HolderPlacementFailed(receiving, placed);
        emit HolderPlaced(holder, route, receiving);
    }

    /// @dev What one delivery may take: each token's balance at `at`, capped by what the voucher still
    ///      allows (no USDC for route 3, nor for route 2 once its position exists).
    function _deliverable(
        address holder,
        uint8 route,
        address receiving,
        ITransitionMigrator.DeliveryVoucher calldata voucher
    ) private view returns (uint256 assetIn, uint256 usdcIn) {
        (, bool lpCreated,, uint256 principalDelivered, uint256 rewardDelivered,) =
            ITransitionMigrator(migrator).deliveryOf(holder);
        uint256 assetAllowed = voucher.assetLimit > principalDelivered ? voucher.assetLimit - principalDelivered : 0;
        uint256 usdcAllowed;
        if (route == ROUTE_COMPOUND || (route == ROUTE_LP && !lpCreated)) {
            usdcAllowed = voucher.usdcLimit > rewardDelivered ? voucher.usdcLimit - rewardDelivered : 0;
        }
        assetIn = _min(IERC20(asset).balanceOf(receiving), assetAllowed);
        usdcIn = _min(IERC20(usdc).balanceOf(receiving), usdcAllowed);
    }

    /// @dev Pulls `amount` of `token` from the holding contract at `at` and approves exactly it to the
    ///      migrator. Nothing for a zero amount.
    function _take(address receiving, address token, uint256 amount) private {
        if (amount == 0) return;
        ITransitionHolder(receiving).pull(token, amount);
        IERC20(token).forceApprove(migrator, amount);
    }

    function _emitDelivered(
        address holder,
        uint8 route,
        address receiving,
        ITransitionMigrator.DeliveryVoucher calldata voucher,
        uint256 assetIn,
        uint256 usdcIn,
        ITransitionMigrator.DeliveryResult memory result
    ) private {
        (,,, uint256 principalDelivered, uint256 rewardDelivered,) = ITransitionMigrator(migrator).deliveryOf(holder);
        emit Delivered(
            holder,
            route,
            receiving,
            msg.sender,
            voucher.nonce,
            voucher.burnTime,
            assetIn,
            usdcIn,
            result.staked,
            result.lpTokenId,
            result.lpBonus + result.v3Bonus,
            principalDelivered,
            rewardDelivered
        );
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }
}
