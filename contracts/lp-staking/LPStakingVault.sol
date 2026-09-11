// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";

import "./interfaces/INonfungiblePositionManager.sol";
import "./interfaces/ISwapRouter02.sol";
import "./libraries/TwapGuard.sol";

/**
 * @title LPStakingVault
 * @notice Custody vault for Uniswap V3 ASSET-USDC liquidity positions.
 *
 *  Scope: custody and range management only. The vault holds staked position NFTs,
 *  records who staked each one, and lets the staker atomically re-range a position
 *  without ever losing custody. It computes no rewards, stores no dollar values and
 *  judges no ranges — scoring and reward accounting are entirely off-chain, driven by
 *  the full-state events emitted here.
 *
 *  Lifecycle:
 *    1. `stake` / `stakeWithPermit` (direct) or `stakeFor` (through the whitelisted zapper or
 *       an allowlisted stake operator) takes custody of a position NFT and records the staker.
 *    2. `rebalance` withdraws all liquidity and accrued fees, optionally swaps, mints a
 *       new position on the same pool, refunds dust, burns the emptied NFT and keeps the
 *       new one staked under the same staker. Trading fees compound into the new range.
 *    3. `unstake` returns the NFT to its staker.
 *
 *  Exits are unconditional: `unstake` is never gated by a pause switch, by a signature, or
 *  by backend liveness. Deposits and `rebalance` are each pausable behind their own switch,
 *  which the guardian or the operator can throw. Zaps stop with the deposit pause, because
 *  `zapIn` finishes through `stakeFor`.
 *
 *  The vault holds no fungible tokens between transactions. Any token0/token1 balance left
 *  at the end of a `rebalance` is refunded to the staker in the same transaction.
 *
 *  UPGRADEABILITY (spec 01 revision 2026-08-26). This contract is the implementation behind a
 *  UUPS (ERC-1967) proxy — see `contracts/lp-staking/deploy/LPProxy.sol`.
 *
 *    - Why it is upgradeable at all: `stakers` is the ONLY record of who owns each custodied
 *      position. Fixing a bug by deploying a replacement vault would leave every staked NFT
 *      behind at an address whose code is the bug, with no way to move the record with it. A
 *      proxy is what lets the code be replaced while custody and the ledger stay put.
 *    - Mutable state therefore lives in ONE ERC-7201 namespaced struct, not in ordinary slots:
 *      an upgrade may append fields to it, and nothing an inherited OZ contract does to its
 *      own namespace can move ours. {TwapGuard}'s two parameters have a namespace of their
 *      own, shared with the (non-upgradeable) zapper.
 *    - `positionManager`, `swapRouter`, `token0`, `token1`, `fee` and `pool` stay `immutable`.
 *      They are fixed protocol references, they live in the implementation's bytecode rather
 *      than in proxy storage, and an upgrade that changed one would be a different market,
 *      not a fix. The live `pool.token0()/token1()/fee()` triple check that proves them
 *      consistent therefore stays in the implementation constructor, where they are set.
 *    - The implementation's own initializers are disabled in its constructor, so the bare
 *      implementation can never be initialised and taken over.
 *    - `initialize` seeds the ERC-721 receive guard. An inline field initializer is
 *      constructor code and never runs behind a proxy, which would leave the guard at zero —
 *      not at {NOT_RECEIVING} — and `onERC721Received` would then reject nothing.
 *
 *  THREE-TIER ADMIN. `owner` is a `TimelockController` (48 h minimum delay on mainnet);
 *  `guardian` is a hot incident key that can ONLY pause; `operator` is a multisig with no
 *  delay for routine operations and recovery:
 *
 *    | tier               | functions                                                 |
 *    |--------------------|-----------------------------------------------------------|
 *    | owner (timelock)   | `_authorizeUpgrade`, `setZapper`, `setStakeOperator`,     |
 *    |                    | `setGuardian`, `setOperator`                              |
 *    | guardian (hot key) | `setDepositsPaused`, `setRebalancePaused`                 |
 *    | operator (multisig)| `setTwapParams`, `rescuePosition`, and both pause switches |
 *
 *  The split follows blast radius, then response time. The guardian can stop deposits and
 *  re-ranging in one transaction but can move nothing and set no key, so it is safe to hold
 *  on a hot key. The operator can move stray value (to itself) and recalibrate the guard, so
 *  it is a multisig; it can also throw both pause switches, as the cold fallback for a lost
 *  guardian key. Code changes and role changes go through the timelock's public delay.
 *  Ownership is two-step (`Ownable2StepUpgradeable`), and `renounceOwnership` is disabled:
 *  renouncing would freeze `_authorizeUpgrade` forever, which is the opposite of why the
 *  proxy exists.
 */
contract LPStakingVault is
    Initializable,
    UUPSUpgradeable,
    Ownable2StepUpgradeable,
    ReentrancyGuard,
    TwapGuard,
    IERC721Receiver
{
    using SafeERC20 for IERC20;

    // ──────────────────────── Constants ────────────────────────

    /// @dev NFT-receipt guard states. Non-zero sentinels keep the slot warm and avoid the
    ///      20k gas of a 0 -> 1 store on every stake, mirroring OZ's ReentrancyGuard trick.
    ///      A plain storage flag is used rather than 0.8.28 `transient` so the file keeps
    ///      compiling under its declared `pragma ^0.8.20`.
    uint256 private constant NOT_RECEIVING = 1;
    uint256 private constant RECEIVING = 2;

    // ──────────────────────── Immutables ───────────────────────

    /// @notice Uniswap V3 NonfungiblePositionManager holding the staked NFTs.
    /// @dev Implementation bytecode, not proxy storage — see the upgradeability note above.
    INonfungiblePositionManager public immutable positionManager;
    /// @notice SwapRouter02 used for the rebalance swap leg.
    /// @dev Implementation bytecode, not proxy storage — see the upgradeability note above.
    ISwapRouter02 public immutable swapRouter;
    /// @notice First token of the accepted pool, sorted ascending by address.
    /// @dev Implementation bytecode, not proxy storage — see the upgradeability note above.
    address public immutable token0;
    /// @notice Second token of the accepted pool.
    /// @dev Implementation bytecode, not proxy storage — see the upgradeability note above.
    address public immutable token1;
    /// @notice Fee tier of the accepted pool, in hundredths of a bip.
    /// @dev Implementation bytecode, not proxy storage — see the upgradeability note above.
    uint24 public immutable fee;

    // ──────────────────────── Storage ──────────────────────────

    /// @custom:storage-location erc7201:real.lp.storage.LPStakingVault
    struct LPStakingVaultStorage {
        /// Zapper allowed to call `stakeFor`. Zero disables the path.
        address zapper;
        /// Fast-path incident responder (hot key), set and rotated by the owner. Pause only.
        address guardian;
        /// When true, no new positions can be taken into custody. Never blocks exits.
        bool depositsPaused;
        /// When true, `rebalance` reverts. Never blocks `unstake` — the exit stays open.
        bool rebalancePaused;
        /// NOT_RECEIVING outside an expected NFT receipt, RECEIVING during one.
        uint256 receiveGuard;
        /// tokenId => staker. Zero means "not staked here".
        mapping(uint256 => address) stakers;
        /// Routine-operations tier (multisig, no delay): TWAP calibration and NFT rescue.
        /// Appended after `stakers` so the layout stays a strict extension of revision d852f44.
        address operator;
        /// Trusted periphery contracts allowed to call `stakeFor` BESIDE the single `zapper`.
        /// APPENDED after `operator`, and it must stay last: an upgrade may add fields to this
        /// namespace but may never reorder it, and everything above it is the layout the
        /// deployed proxy already wrote. See {setStakeOperator} for what an operator is
        /// trusted with.
        mapping(address => bool) stakeOperators;
    }

    /**
     * @dev ERC-7201 slot for {LPStakingVaultStorage}, computed as
     *      `keccak256(abi.encode(uint256(keccak256("real.lp.storage.LPStakingVault")) - 1)) & ~bytes32(uint256(0xff))`.
     *      Pinned as a literal because it must never move: `stakers` IS the custody ledger,
     *      and a moved namespace would read every staked position as unstaked — which is
     *      exactly the state `rescuePosition` is allowed to act on.
     *      `test/forge/unit/VaultBranches.t.sol` recomputes it and fails if it drifts.
     */
    bytes32 private constant LP_STAKING_VAULT_STORAGE =
        0x4c835a63e69815f7352ca18e845a5d8023cea9abbc2e923eb7a3a481844a6500;

    function _vaultStorage() private pure returns (LPStakingVaultStorage storage $) {
        assembly {
            $.slot := LP_STAKING_VAULT_STORAGE
        }
    }

    // ──────────────────────── Events ───────────────────────────

    /// @notice A position NFT entered custody. Carries the position's full range state.
    event Staked(
        address indexed user,
        uint256 indexed tokenId,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint256 timestamp
    );

    /// @notice A position NFT left custody and went back to its staker.
    event Unstaked(address indexed user, uint256 indexed tokenId, uint256 timestamp);

    /// @notice A position was re-ranged. `oldTokenId` -> `newTokenId` gives the indexer the
    ///         lineage; the old NFT no longer exists after this event.
    event Rebalanced(
        address indexed user,
        uint256 indexed oldTokenId,
        uint256 indexed newTokenId,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint256 amount0Refunded,
        uint256 amount1Refunded,
        uint256 timestamp
    );

    /// @notice Deposit pause switch changed. Full new state.
    event DepositsPausedSet(bool depositsPaused);

    /// @notice Rebalance pause switch changed. Full new state.
    event RebalancePausedSet(bool rebalancePaused);

    /// @notice Whitelisted zapper changed. Carries both sides for auditability.
    event ZapperSet(address previousZapper, address newZapper);

    /// @notice A stake operator was allowed onto, or removed from, the `stakeFor` allowlist.
    ///         Full new state: `allowed` is what the mapping says after this transaction.
    event StakeOperatorSet(address indexed operator, bool allowed);

    /// @notice A position NFT with no staker record left the vault for the operator. Never
    ///         fires for a staked position — see {rescuePosition}.
    event PositionRescued(uint256 indexed tokenId, address indexed to, uint256 timestamp);

    /// @notice The fast-path guardian changed. Carries both sides for auditability.
    event GuardianSet(address previousGuardian, address newGuardian);

    /// @notice The routine-operations tier changed. Carries both sides for auditability.
    event OperatorSet(address previousOperator, address newOperator);

    // ──────────────────────── Errors ───────────────────────────

    error ZeroAddress();
    error TokensNotSorted(address tokenA, address tokenB);
    error PoolMismatch(address poolToken0, address poolToken1, uint24 poolFee);
    error DepositsArePaused();
    error RebalanceIsPaused();
    error AlreadyStaked(uint256 tokenId, address staker);
    error NotStaker(uint256 tokenId, address caller, address staker);
    /// @dev `stakeFor` was called by an address that is neither the zapper nor an allowlisted
    ///      stake operator. ONE error for both halves of the check, on purpose: the caller
    ///      failed every route in, and the only route that has an address to name is the
    ///      zapper — the operator side is a mapping, with no counterpart to report. Every
    ///      other rejection in this file names the address that WOULD have been allowed
    ///      (`NotStaker`, `NotOperator`), so a second error carrying nothing but the caller
    ///      would be the odd one out, and splitting the two would need a rule for which one a
    ///      caller who is neither gets. The name is kept for the same reason the selector is:
    ///      it is what the deployed proxy, the zapper and every decoder already speak.
    error NotZapper(address caller, address zapper);
    /// @dev `stakeFor` was asked to credit the vault itself or the zapper — a position neither
    ///      contract could ever release, since neither has a path that calls `unstake`.
    error SelfCredit(address user);
    error PositionPoolMismatch(uint256 tokenId, address positionToken0, address positionToken1, uint24 positionFee);
    error EmptyPosition(uint256 tokenId);
    error UnexpectedNftSender(address sender);
    error UnsolicitedPosition(address operator, address from, uint256 tokenId);
    error SwapAmountExceedsBalance(address tokenIn, uint256 amountIn, uint256 balance);
    /// @dev A swap leg was reached with `amountIn == 0`, which SwapRouter02 reads as its
    ///      CONTRACT_BALANCE sentinel rather than as "nothing to swap".
    error ZeroAmount();
    error PositionIsStaked(uint256 tokenId, address staker);
    /// @dev An operator-tier function was called by someone else — the owner and the guardian included.
    error NotOperator(address caller, address operator);
    /// @dev A pause switch was called by someone who is neither the guardian nor the operator.
    error NotGuardianOrOperator(address caller, address guardian, address operator);
    /// @dev `renounceOwnership` is disabled: it would freeze the upgrade path forever.
    error RenounceDisabled();

    // ──────────────────────── Modifiers ────────────────────────

    /// @dev The routine-operations tier. Not satisfied by `owner()` or by the guardian.
    modifier onlyOperator() {
        address operator_ = _vaultStorage().operator;
        if (msg.sender != operator_) revert NotOperator(msg.sender, operator_);
        _;
    }

    /// @dev The pause tier: the guardian (hot key, fast path) or the operator (multisig, the
    ///      cold fallback for a lost guardian key). Deliberately NOT satisfied by `owner()`:
    ///      the timelock has no business holding an undelayed switch.
    modifier onlyGuardianOrOperator() {
        LPStakingVaultStorage storage $ = _vaultStorage();
        address guardian_ = $.guardian;
        address operator_ = $.operator;
        if (msg.sender != guardian_ && msg.sender != operator_) {
            revert NotGuardianOrOperator(msg.sender, guardian_, operator_);
        }
        _;
    }

    // ──────────────────────── Constructor ──────────────────────

    /**
     * @notice Deploys the IMPLEMENTATION. It holds no state of its own and is never called
     *         directly; the proxy in front of it runs {initialize}.
     * @param _positionManager Uniswap V3 NonfungiblePositionManager address.
     * @param _pool The single ASSET-USDC pool whose positions this vault accepts.
     * @param _token0 Expected pool token0 (must sort below `_token1`).
     * @param _token1 Expected pool token1.
     * @param _fee Expected pool fee tier.
     * @param _swapRouter SwapRouter02 address used by `rebalance`.
     * @dev Everything here is `immutable`, so it all belongs to the implementation and every
     *      check on it fires on the implementation deploy, before any proxy exists. That
     *      includes the live pool triple check: the three values it compares are immutables
     *      set in this very constructor, so this is the only place where checking them means
     *      anything.
     *
     *      `_disableInitializers()` is what stops anyone from initialising the bare
     *      implementation and owning a contract that, being un-proxied, custodies nothing —
     *      but would still be a confusing entry in every explorer and indexer.
     */
    constructor(
        address _positionManager,
        address _pool,
        address _token0,
        address _token1,
        uint24 _fee,
        address _swapRouter
    ) TwapGuard(_pool) {
        if (_positionManager == address(0) || _swapRouter == address(0)) revert ZeroAddress();
        if (_token0 == address(0) || _token1 == address(0)) revert ZeroAddress();
        if (_token0 >= _token1) revert TokensNotSorted(_token0, _token1);

        // Deployment sanity: the configured triple must be the pool actually passed in.
        // Misconfiguring this would silently accept positions from the wrong market.
        IUniswapV3Pool poolRef = IUniswapV3Pool(_pool);
        if (poolRef.token0() != _token0 || poolRef.token1() != _token1 || poolRef.fee() != _fee) {
            revert PoolMismatch(poolRef.token0(), poolRef.token1(), poolRef.fee());
        }

        positionManager = INonfungiblePositionManager(_positionManager);
        swapRouter = ISwapRouter02(_swapRouter);
        token0 = _token0;
        token1 = _token1;
        fee = _fee;

        _disableInitializers();
    }

    // ──────────────────────── Initializer ──────────────────────

    /**
     * @notice One-time setup, executed on the PROXY in its own deployment transaction.
     * @param owner_ Owner: the `TimelockController`. Upgrades, zapper and role changes.
     * @param guardian_ Guardian: the hot incident key. The two pause switches, nothing else.
     * @param operator_ Operator: the multisig. TWAP calibration and NFT rescue, no delay.
     * @param zapper_ Zapper whitelisted for `stakeFor`. The deploy script pre-computes the
     *        zapper's CREATE address and passes it here, so the proxy can be born owned by
     *        the timelock with the zap path already open. Zero leaves the path disabled.
     * @param twapWindow_ Initial TWAP window in seconds.
     * @param maxDeviationTicks_ Initial spot-vs-TWAP deviation ceiling, in ticks.
     * @dev Every mutable field is written here AND emitted here — including the ones whose
     *      initial value is the type's default — so an indexer can rebuild the whole state
     *      from this transaction's logs without assuming anything about the implementation.
     *      `receiveGuard` is seeded here rather than at its declaration: an inline field
     *      initializer is constructor code, a proxy never runs the implementation's
     *      constructor, and a guard left at zero is a guard that rejects nothing.
     */
    function initialize(
        address owner_,
        address guardian_,
        address operator_,
        address zapper_,
        uint32 twapWindow_,
        uint24 maxDeviationTicks_
    ) external initializer {
        __Ownable_init(owner_);
        __Ownable2Step_init();
        // No `__UUPSUpgradeable_init()`: OpenZeppelin v5.6 turned
        // `contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol` into a re-export of the plain
        // `UUPSUpgradeable`, which declares no initializer at all. There is nothing to seed —
        // the module's only state is the ERC-1967 implementation slot, and the proxy's own
        // constructor writes that before this function runs.

        if (guardian_ == address(0) || operator_ == address(0)) revert ZeroAddress();

        LPStakingVaultStorage storage $ = _vaultStorage();
        $.guardian = guardian_;
        $.operator = operator_;
        $.zapper = zapper_;
        $.receiveGuard = NOT_RECEIVING;

        emit GuardianSet(address(0), guardian_);
        emit OperatorSet(address(0), operator_);
        emit ZapperSet(address(0), zapper_);
        emit DepositsPausedSet(false);
        emit RebalancePausedSet(false);

        _setTwapParams(twapWindow_, maxDeviationTicks_); // emits TwapParamsSet
    }

    // ──────────────────────── User functions ───────────────────

    /**
     * @notice Stakes a position NFT the caller already approved to this vault.
     * @dev Reverts while deposits are paused. The position must belong to the exact
     *      configured pool and hold non-zero liquidity.
     * @param tokenId The Uniswap V3 position NFT to stake.
     */
    function stake(uint256 tokenId) external nonReentrant {
        _stake(msg.sender, tokenId);
    }

    /**
     * @notice Stakes a position NFT in one transaction using an EIP-4494 NFT permit,
     *         with no prior approval transaction.
     * @dev The permit is submitted directly. A griefer who front-runs the signature
     *      consumes it and makes this call revert; the user can retry with `stake` after
     *      the front-run approval, which is still valid, so no funds are ever at risk.
     * @param tokenId The Uniswap V3 position NFT to stake.
     * @param deadline Permit expiry timestamp.
     * @param v Permit signature recovery id.
     * @param r Permit signature r value.
     * @param s Permit signature s value.
     */
    function stakeWithPermit(uint256 tokenId, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        nonReentrant
    {
        positionManager.permit(address(this), tokenId, deadline, v, r, s);
        _stake(msg.sender, tokenId);
    }

    /**
     * @notice Stakes a position NFT held by the whitelisted zapper, or by an allowlisted stake
     *         operator, and credits `user` as the staker.
     * @dev TWO routes in, and they are separate on purpose (integration spec §6.2). `zapper` is
     *      the single address the REAL front end's own zap goes through and it stays exactly
     *      what it was; `stakeOperators` is an allowlist beside it, so a second periphery
     *      contract — the ApeBond position adapter — can deposit for its buyers without taking
     *      the zapper slot away from ordinary users. Either route is enough on its own.
     *
     *      Custody is pulled from `msg.sender`, which must have approved this vault for
     *      `tokenId`. Everything downstream is identical for both routes and for a direct
     *      `stake`: the same pool validation, the same duplicate check, and the same deposit
     *      pause, which lives inside `_stake` and therefore gates every operator too.
     *
     *      Crediting the vault or the zapper is rejected: neither contract can call
     *      `unstake`, and `rescuePosition` refuses recorded positions, so such a record
     *      would strand the NFT until an upgrade.
     * @param user Address credited as the staker and entitled to unstake.
     * @param tokenId The Uniswap V3 position NFT to stake.
     */
    function stakeFor(address user, uint256 tokenId) external nonReentrant {
        LPStakingVaultStorage storage $ = _vaultStorage();

        address zapper_ = $.zapper;
        bool authorized = (msg.sender == zapper_ && zapper_ != address(0)) || $.stakeOperators[msg.sender];
        if (!authorized) revert NotZapper(msg.sender, zapper_);

        if (user == address(0)) revert ZeroAddress();
        if (user == address(this) || user == zapper_) revert SelfCredit(user);
        _stake(user, tokenId);
    }

    /**
     * @notice Returns a staked position NFT to its staker.
     * @dev Permissionless by design: never gated by either pause switch, a signature, or
     *      backend liveness. Off-chain this is the early-exit signal.
     *
     *      The exit uses a plain `transferFrom`, not `safeTransferFrom`, and that is
     *      deliberate. The recipient is `msg.sender` — the recorded staker, who explicitly
     *      asked for the exit in this very call — so the NFT always lands back at the
     *      address that put it in. A `safeTransferFrom` would additionally demand an
     *      `onERC721Received` hook on that address: a contract staker without one could
     *      deposit (the receipt check on the deposit leg is on the vault, not on the
     *      depositor) but could never withdraw, and its position would be locked here
     *      forever. A plain transfer keeps the exit unconditional, as the header claims.
     * @param tokenId The staked position NFT to withdraw.
     */
    function unstake(uint256 tokenId) external nonReentrant {
        LPStakingVaultStorage storage $ = _vaultStorage();

        address staker = $.stakers[tokenId];
        if (staker != msg.sender) revert NotStaker(tokenId, msg.sender, staker);

        delete $.stakers[tokenId];

        positionManager.transferFrom(address(this), msg.sender, tokenId);

        emit Unstaked(msg.sender, tokenId, block.timestamp);
    }

    /**
     * @notice Atomically moves a staked position to a new range on the same pool.
     *
     * @dev Sequence, all in one transaction and without the NFT ever leaving custody:
     *      1. `decreaseLiquidity` the whole position, then `collect` everything owed —
     *         accrued trading fees are included and therefore **compound** into the new
     *         position rather than being paid out.
     *      2. Optional swap leg through SwapRouter02 when `swap.amountIn > 0`, guarded by
     *         the spot-vs-TWAP check.
     *      3. `mint` the new position on `[newTickLower, newTickUpper]` with the vault's
     *         whole token0/token1 balance as desired amounts.
     *      4. Refund every remaining token0/token1 wei to the staker.
     *      5. Burn the emptied old NFT.
     *      6. Move the staker record from the old tokenId to the new one.
     *
     *      Slippage: step 1 deliberately passes `amount0Min = amount1Min = 0`. Withdrawing
     *      the caller's own liquidity at spot cannot be sandwiched for profit in isolation,
     *      and the caller's real protection is applied where value can actually be lost —
     *      `swap.amountOutMin` on the swap and `swap.amount0Min` / `swap.amount1Min` on the
     *      mint, which together bound the round trip. Set them from a fresh quote.
     *
     *      Works while deposits are paused: re-ranging is part of exiting risk, not a deposit.
     *      It has its own switch instead — `setRebalancePaused`, held by the guardian —
     *      because this is the most complex function here and an upgrade cannot execute
     *      before the timelock's public delay, so the immediate mitigation has to be a
     *      switch the multisig can throw by itself. Pausing it never touches `unstake`:
     *      a staker locked out of re-ranging can always take the NFT out and manage it on
     *      Uniswap directly.
     *      No cooldown — gas, swap fees and slippage all fall on the caller, and abusive
     *      patterns are neutralized in off-chain scoring instead of in the contract.
     *
     * @param tokenId Currently staked position NFT.
     * @param newTickLower Lower tick of the new range.
     * @param newTickUpper Upper tick of the new range.
     * @param swap Swap leg and mint minimums, see {SwapParams}. `amountIn == 0` skips the swap.
     * @param deadline Expiry passed to `decreaseLiquidity` and `mint`.
     * @return newTokenId The freshly minted position NFT, now staked under the same staker.
     */
    function rebalance(
        uint256 tokenId,
        int24 newTickLower,
        int24 newTickUpper,
        SwapParams calldata swap,
        uint256 deadline
    ) external nonReentrant returns (uint256 newTokenId) {
        LPStakingVaultStorage storage $ = _vaultStorage();

        if ($.rebalancePaused) revert RebalanceIsPaused();

        address staker = $.stakers[tokenId];
        if (staker != msg.sender) revert NotStaker(tokenId, msg.sender, staker);

        _withdrawAll(tokenId, deadline);

        if (swap.amountIn > 0) {
            _executeSwap(swap);
        }

        uint128 newLiquidity;
        (newTokenId, newLiquidity) = _mintPosition(newTickLower, newTickUpper, swap, deadline);

        // Effects before the remaining interactions: the record moves to the new NFT and
        // the old id becomes unstakeable in the same breath.
        delete $.stakers[tokenId];
        $.stakers[newTokenId] = staker;

        (uint256 refund0, uint256 refund1) = _refundDust(staker);

        // The old NFT is empty (zero liquidity, zero owed) after step 1, so it can be
        // burned. Burning keeps custody clean: no dead NFTs accumulate in the vault and
        // no stale tokenId can ever be confused for a live stake.
        positionManager.burn(tokenId);

        emit Rebalanced(
            staker,
            tokenId,
            newTokenId,
            newTickLower,
            newTickUpper,
            newLiquidity,
            refund0,
            refund1,
            block.timestamp
        );
    }

    // ──────────────────────── ERC-721 receiver ─────────────────

    /**
     * @notice ERC-721 receipt hook. Accepts position NFTs only from the configured
     *         position manager and only inside a stake, stakeFor or rebalance flow.
     * @dev Unsolicited transfers revert, so the vault can never end up holding an NFT
     *      with no staker record behind it.
     * @param operator_ Address that triggered the transfer. Named with a trailing underscore
     *        because `operator()` is now a view on this contract and solc would otherwise
     *        warn about the shadowed declaration.
     * @param from Previous owner.
     * @param tokenId The NFT being transferred.
     * @return The ERC-721 receiver magic value.
     */
    function onERC721Received(address operator_, address from, uint256 tokenId, bytes calldata)
        external
        view
        override
        returns (bytes4)
    {
        if (msg.sender != address(positionManager)) revert UnexpectedNftSender(msg.sender);
        if (_vaultStorage().receiveGuard != RECEIVING) revert UnsolicitedPosition(operator_, from, tokenId);
        return IERC721Receiver.onERC721Received.selector;
    }

    // ──────────────────────── Owner functions ──────────────────

    /**
     * @notice Sets the single address allowed to call `stakeFor`.
     * @dev The zapper is replaceable periphery; set to the zero address to disable the
     *      path entirely.
     *
     *      Owner tier: pointing the deposit path at a new contract is a code change in all
     *      but name, so it takes the timelock's delay like an upgrade does. Stopping the
     *      existing zapper needs no delay — {setDepositsPaused} reverts every `zapIn`.
     * @param newZapper New zapper address, or zero to disable.
     */
    function setZapper(address newZapper) external onlyOwner {
        LPStakingVaultStorage storage $ = _vaultStorage();
        emit ZapperSet($.zapper, newZapper);
        $.zapper = newZapper;
    }

    /**
     * @notice Allows or removes one stake operator — an address that may call `stakeFor`
     *         beside the zapper.
     * @dev An operator is a TRUSTED PERIPHERY CONTRACT, not a user role. It is trusted with
     *      exactly one thing: naming which address gets credited for a position it hands over.
     *      It cannot take a position out, cannot re-range one, cannot reach either admin tier
     *      and cannot touch a position it did not deposit. The ApeBond adapter (integration
     *      spec §6.1) is the first of them, and a replacement adapter is allowlisted here
     *      rather than by moving the zapper, which stays pointed at the REAL zapper for
     *      ordinary users.
     *
     *      Owner tier, exactly like {setZapper} and for the same reason: adding a deposit
     *      entry point is a code change in all but name, so it takes the timelock's delay and
     *      is publicly visible before it can run. Removing one needs no delay to be effective
     *      in an incident — {setDepositsPaused} reverts every operator's `stakeFor` in one
     *      guardian transaction, because the pause is checked inside `_stake`.
     *
     *      The zero address is rejected rather than treated as a switch: unlike `zapper`,
     *      which uses zero to close its single-address path, this is a mapping and zero would
     *      be a meaningless entry in it.
     * @param stakeOperator The periphery contract to allow or remove. Named in full because a
     *        bare `operator` would shadow the {operator} view, which is the unrelated
     *        routine-operations ROLE.
     * @param allowed True to allow `stakeFor`, false to remove the right.
     */
    function setStakeOperator(address stakeOperator, bool allowed) external onlyOwner {
        if (stakeOperator == address(0)) revert ZeroAddress();
        emit StakeOperatorSet(stakeOperator, allowed);
        _vaultStorage().stakeOperators[stakeOperator] = allowed;
    }

    /**
     * @notice Rotates the fast-path guardian.
     * @param newGuardian The new guardian (the multisig).
     * @dev Owner tier: the guardian cannot rotate itself, so losing the multisig is
     *      recoverable through the timelock rather than terminal.
     */
    function setGuardian(address newGuardian) external onlyOwner {
        if (newGuardian == address(0)) revert ZeroAddress();
        LPStakingVaultStorage storage $ = _vaultStorage();
        emit GuardianSet($.guardian, newGuardian);
        $.guardian = newGuardian;
    }

    /**
     * @notice Rotates the routine-operations tier.
     * @param newOperator The new operator (the multisig).
     * @dev Owner tier: the operator cannot rotate itself, so losing the multisig is
     *      recoverable through the timelock rather than terminal.
     */
    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert ZeroAddress();
        LPStakingVaultStorage storage $ = _vaultStorage();
        emit OperatorSet($.operator, newOperator);
        $.operator = newOperator;
    }

    /**
     * @notice UUPS upgrade hook. The owner is the timelock, so every code change is
     *         scheduled on-chain with full calldata and cannot execute before the delay.
     * @dev Empty body on purpose: `onlyOwner` is the whole authorization.
     */
    function _authorizeUpgrade(address) internal override onlyOwner {}

    /**
     * @notice Disabled. Renouncing would leave `_authorizeUpgrade` with no caller, freezing
     *         the implementation forever — the exact failure the proxy exists to avoid.
     * @dev Kept `onlyOwner` so a stranger still gets the standard Ownable rejection and the
     *      owner gets a reason.
     *
     *      solc says "state mutability can be restricted to view" here, and that is left
     *      alone on purpose: marking it `view` would change the ABI entry's
     *      `stateMutability`, and every wallet, explorer and indexer that reads this ABI
     *      would then present the call as a read. It has to keep looking like the
     *      transaction it overrides, so that anyone who tries it gets the revert reason
     *      on-chain.
     */
    function renounceOwnership() public override onlyOwner {
        revert RenounceDisabled();
    }

    // ──────────────────────── Pause functions (guardian or operator) ────

    /**
     * @notice Pauses or resumes new deposits.
     * @dev Gates `stake`, `stakeWithPermit` and `stakeFor` only. `unstake` and `rebalance`
     *      stay available; `rebalance` has its own switch, see {setRebalancePaused}.
     *
     *      This is also the zap kill switch, and the operator kill switch with it. The check
     *      lives inside `_stake`, which every entry point ends in, so `LPZapper.zapIn` and
     *      every allowlisted stake operator ({setStakeOperator}) revert with
     *      {DepositsArePaused} while this is on — no periphery contract needs a pause of its
     *      own, and none can outlive this one.
     *
     *      Pause tier: the guardian is a hot key that can only pause, so this switch can be
     *      thrown in minutes without putting any value behind that key; the operator multisig
     *      can throw it too, so a lost guardian key never leaves a pause stuck for the 48 h
     *      its rotation through the timelock takes.
     * @param paused True to block new deposits.
     */
    function setDepositsPaused(bool paused) external onlyGuardianOrOperator {
        _vaultStorage().depositsPaused = paused;
        emit DepositsPausedSet(paused);
    }

    /**
     * @notice Pauses or resumes `rebalance`.
     * @dev The incident switch for the most complex path in the contract. It gates
     *      `rebalance` and nothing else: `unstake` stays open at all times, so a paused
     *      rebalance never traps a position — the staker withdraws the NFT and re-ranges it
     *      on Uniswap directly.
     *
     *      Pause tier: the guardian is a hot key that can only pause, so this switch can be
     *      thrown in minutes without putting any value behind that key; the operator multisig
     *      can throw it too, so a lost guardian key never leaves a pause stuck for the 48 h
     *      its rotation through the timelock takes.
     * @param paused True to block `rebalance`.
     */
    function setRebalancePaused(bool paused) external onlyGuardianOrOperator {
        _vaultStorage().rebalancePaused = paused;
        emit RebalancePausedSet(paused);
    }

    // ──────────────────────── Operator functions ───────────────

    /**
     * @notice Retunes the spot-vs-TWAP guard used by `rebalance`.
     * @param window New TWAP window in seconds (MIN_TWAP_WINDOW..MAX_TWAP_WINDOW).
     * @param maxDeviationTicks New deviation ceiling in ticks (0 < x <= MAX_TWAP_DEVIATION_TICKS).
     * @dev Operator tier: the guard's calibration is a routine parameter — misuse can only
     *      grief the swap legs (bounded by MIN/MAX_TWAP_WINDOW and MAX_TWAP_DEVIATION_TICKS),
     *      never move value — so it needs a multisig but not a delay. When the guard needs to
     *      stop mattering RIGHT NOW, the answer is {setRebalancePaused}, which the guardian holds.
     */
    function setTwapParams(uint32 window, uint24 maxDeviationTicks) external onlyOperator {
        _setTwapParams(window, maxDeviationTicks);
    }

    /**
     * @notice Recovers a position NFT the vault holds with no staker behind it.
     *
     * @dev Restricted to `stakers[tokenId] == address(0)`, and that single condition is
     *      what makes the function safe. **A position in legitimate custody always carries
     *      a staker record.** Every path that takes an NFT in writes the record in the same
     *      transaction: `_stake` sets it before pulling custody, and `rebalance` moves it
     *      from the old id to the new one. Every path that gives an NFT up clears the record
     *      in the same transaction: `unstake` deletes it before transferring out, and
     *      `rebalance` deletes the old id before burning it. Record and custody are created
     *      and destroyed together, so a zero record on an NFT the vault owns can only mean
     *      the NFT arrived without going through a stake path — which is exactly what this
     *      function exists to undo. A staked position is unreachable here by construction,
     *      no matter who the operator is.
     *
     *      `onERC721Received` already rejects safe transfers arriving outside a stake flow,
     *      but a plain `transferFrom` never consults the hook, so an NFT can still be pushed
     *      in by mistake and would otherwise stay here forever.
     *
     *      `nonReentrant` closes the one window where the invariant is momentarily open:
     *      inside `rebalance`, between the `mint` and the `stakers[newTokenId] = staker`
     *      write, the vault owns a new NFT that has no record yet, and between that write
     *      and the `burn` it owns an old NFT whose record has just been cleared. Sharing the
     *      reentrancy guard with `stake`, `unstake` and `rebalance` means this call can
     *      never execute inside one of them.
     *
     *      Operator tier, and the destination is `operator()` rather than a caller-supplied
     *      address — matching `RewardsDistributor.recoverExcessAsset`. Not `owner()`, which
     *      after the deploy is a `TimelockController` with no way to forward an ERC-721. A
     *      position NFT is unique and a mistyped recipient is unrecoverable, so the recovery
     *      path offers no place to mistype one; the operator multisig forwards it to the
     *      rightful holder off-chain. A plain `transferFrom` is used for the same reason
     *      {unstake} uses one — a multisig without an `onERC721Received` hook must not be
     *      locked out of its own recovery path.
     * @param tokenId Unrecorded position NFT held by this vault.
     */
    function rescuePosition(uint256 tokenId) external onlyOperator nonReentrant {
        LPStakingVaultStorage storage $ = _vaultStorage();

        address staker = $.stakers[tokenId];
        if (staker != address(0)) revert PositionIsStaked(tokenId, staker);

        address to = $.operator;
        positionManager.transferFrom(address(this), to, tokenId);

        emit PositionRescued(tokenId, to, block.timestamp);
    }

    // ──────────────────────── View functions ───────────────────

    /**
     * @notice Staker credited with a position NFT.
     * @param tokenId The position NFT.
     * @return The staker address, or zero when the NFT is not staked here.
     */
    function stakerOf(uint256 tokenId) external view returns (address) {
        return _vaultStorage().stakers[tokenId];
    }

    /// @notice Zapper allowed to call `stakeFor`. Zero disables the path.
    function zapper() external view returns (address) {
        return _vaultStorage().zapper;
    }

    /// @notice True while `stakeOperator` may call `stakeFor` beside the zapper.
    /// @param stakeOperator The address to look up in the allowlist. Not `operator`: that name
    ///        belongs to the routine-operations role, which this allowlist has nothing to do with.
    function isStakeOperator(address stakeOperator) external view returns (bool) {
        return _vaultStorage().stakeOperators[stakeOperator];
    }

    /// @notice The fast-path incident responder (the hot key). Pause only.
    function guardian() external view returns (address) {
        return _vaultStorage().guardian;
    }

    /// @notice The routine-operations tier (the multisig).
    function operator() external view returns (address) {
        return _vaultStorage().operator;
    }

    /// @notice True while no new position can be taken into custody. Never blocks exits.
    function depositsPaused() external view returns (bool) {
        return _vaultStorage().depositsPaused;
    }

    /// @notice True while `rebalance` reverts. Never blocks `unstake`.
    function rebalancePaused() external view returns (bool) {
        return _vaultStorage().rebalancePaused;
    }

    // ──────────────────────── Internal helpers ─────────────────

    /// @dev Shared body of every stake path. Validates the position, records the staker,
    ///      then pulls custody from `msg.sender`.
    function _stake(address user, uint256 tokenId) internal {
        LPStakingVaultStorage storage $ = _vaultStorage();

        if ($.depositsPaused) revert DepositsArePaused();

        address existing = $.stakers[tokenId];
        if (existing != address(0)) revert AlreadyStaked(tokenId, existing);

        (int24 tickLower, int24 tickUpper, uint128 liquidity) = _validatePosition(tokenId);

        $.stakers[tokenId] = user;

        $.receiveGuard = RECEIVING;
        positionManager.safeTransferFrom(msg.sender, address(this), tokenId);
        $.receiveGuard = NOT_RECEIVING;

        emit Staked(user, tokenId, tickLower, tickUpper, liquidity, block.timestamp);
    }

    /// @dev Rejects positions from any other pool and empty positions.
    function _validatePosition(uint256 tokenId)
        internal
        view
        returns (int24 tickLower, int24 tickUpper, uint128 liquidity)
    {
        address positionToken0;
        address positionToken1;
        uint24 positionFee;
        (, , positionToken0, positionToken1, positionFee, tickLower, tickUpper, liquidity, , , , ) =
            positionManager.positions(tokenId);

        if (positionToken0 != token0 || positionToken1 != token1 || positionFee != fee) {
            revert PositionPoolMismatch(tokenId, positionToken0, positionToken1, positionFee);
        }
        if (liquidity == 0) revert EmptyPosition(tokenId);
    }

    /// @dev Empties a position: burns all its liquidity, then collects principal + fees
    ///      into the vault. Leaves the NFT alive but with zero liquidity and zero owed.
    function _withdrawAll(uint256 tokenId, uint256 deadline) internal {
        (, , , , , , , uint128 liquidity, , , , ) = positionManager.positions(tokenId);

        if (liquidity > 0) {
            positionManager.decreaseLiquidity(
                INonfungiblePositionManager.DecreaseLiquidityParams({
                    tokenId: tokenId,
                    liquidity: liquidity,
                    amount0Min: 0,
                    amount1Min: 0,
                    deadline: deadline
                })
            );
        }

        positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
    }

    /// @dev TWAP-guarded exact-input swap between the pool's two tokens.
    ///      Approvals are exact and reset to zero afterwards; `forceApprove` is used so
    ///      USDC-style tokens that require a 0 allowance before a new one still work.
    ///      SwapRouter02's `ExactInputSingleParams` carries no deadline — the caller's
    ///      deadline is enforced by `decreaseLiquidity` and `mint` in the same transaction.
    ///
    ///      SwapRouter02 reads `amountIn == 0` as its `Constants.CONTRACT_BALANCE` sentinel —
    ///      "swap the router's whole balance of `tokenIn`, paid by the router" — so a zero
    ///      amount must never reach it. The guard below keeps that invariant next to the
    ///      router call rather than one function away at the call site.
    function _executeSwap(SwapParams calldata swap) internal {
        // SwapRouter02 reads `amountIn == 0` as its CONTRACT_BALANCE sentinel ("swap the whole
        // router balance"). The only call site is behind `amountIn > 0`; this keeps the
        // invariant where the router call is, so no refactor can drop it silently.
        if (swap.amountIn == 0) revert ZeroAmount();
        _checkTwapDeviation();

        (address tokenIn, address tokenOut) = swap.zeroForOne ? (token0, token1) : (token1, token0);

        uint256 balance = IERC20(tokenIn).balanceOf(address(this));
        if (swap.amountIn > balance) revert SwapAmountExceedsBalance(tokenIn, swap.amountIn, balance);

        IERC20(tokenIn).forceApprove(address(swapRouter), swap.amountIn);
        swapRouter.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: fee,
                recipient: address(this),
                amountIn: swap.amountIn,
                amountOutMinimum: swap.amountOutMin,
                sqrtPriceLimitX96: 0
            })
        );
        IERC20(tokenIn).forceApprove(address(swapRouter), 0);
    }

    /// @dev Mints a new position on the configured pool using the vault's whole balance
    ///      of both tokens as desired amounts, with the caller's minimums enforced.
    ///
    ///      Whole balance, not the amount this rebalance just withdrew, and that is
    ///      deliberate. The vault is drained of both tokens at the end of every rebalance,
    ///      so a token0/token1 balance sitting here beforehand can only be a misdirected
    ///      transfer; it joins this mint and whatever the mint leaves over is refunded to
    ///      this rebalancer. Only misdirected funds are ever at stake — staked value lives
    ///      inside the position NFTs and no stray balance can reach it. Tracking per-call
    ///      amounts instead would buy no protection for stakers and would strand the dust
    ///      on every pass. Other tokens have no such path and are recovered by the owner.
    function _mintPosition(int24 tickLower, int24 tickUpper, SwapParams calldata swap, uint256 deadline)
        internal
        returns (uint256 tokenId, uint128 liquidity)
    {
        uint256 amount0 = IERC20(token0).balanceOf(address(this));
        uint256 amount1 = IERC20(token1).balanceOf(address(this));

        IERC20(token0).forceApprove(address(positionManager), amount0);
        IERC20(token1).forceApprove(address(positionManager), amount1);

        // The canonical position manager uses `_mint`, not `_safeMint`, so no receipt hook
        // fires here. The guard is opened anyway so the flow stays correct against any
        // position manager that does call back.
        LPStakingVaultStorage storage $ = _vaultStorage();
        $.receiveGuard = RECEIVING;
        (tokenId, liquidity, , ) = positionManager.mint(
            INonfungiblePositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: fee,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: amount0,
                amount1Desired: amount1,
                amount0Min: swap.amount0Min,
                amount1Min: swap.amount1Min,
                recipient: address(this),
                deadline: deadline
            })
        );
        $.receiveGuard = NOT_RECEIVING;

        IERC20(token0).forceApprove(address(positionManager), 0);
        IERC20(token1).forceApprove(address(positionManager), 0);
    }

    /// @dev Sends every remaining token0/token1 wei to `to`. The vault is designed to hold
    ///      no fungible balance between transactions. Whole balance by design, the mirror
    ///      image of {_mintPosition}: a stray token0/token1 balance leaves with the next
    ///      rebalancer. See that function's note for why that trade is the intended one.
    function _refundDust(address to) internal returns (uint256 amount0, uint256 amount1) {
        amount0 = IERC20(token0).balanceOf(address(this));
        if (amount0 > 0) IERC20(token0).safeTransfer(to, amount0);

        amount1 = IERC20(token1).balanceOf(address(this));
        if (amount1 > 0) IERC20(token1).safeTransfer(to, amount1);
    }
}
