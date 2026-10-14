// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";

import "./interfaces/INonfungiblePositionManager.sol";
import "./libraries/PositionValue.sol";
import "./libraries/TickMath.sol";

// ──────────────────────── Local interfaces ─────────────────────

/// @dev The calls the adapter makes into the vault. Declared locally, like {LPZapper}'s own copy,
///      so the periphery never imports the core contract.
interface IApeBondVault {
    function stakeFor(address user, uint256 tokenId) external;

    function stakerOf(uint256 tokenId) external view returns (address);

    function token0() external view returns (address);

    function token1() external view returns (address);

    function fee() external view returns (uint24);

    function pool() external view returns (address);

    function previewTwap()
        external
        view
        returns (int24 currentTick, int24 twapTick, int24 maxDeviationTicks, bool withinBounds);

    function bonusEscrow() external view returns (address);

    function operator() external view returns (address);
}

/// @dev The calls the adapter makes into the escrow. {BonusEscrow} is the implementation behind
///      it; the adapter talks to the proxy and never needs the concrete type.
interface IApeBondEscrow {
    function reserve(uint256 tokenId, address beneficiary, uint256 amount, uint64 unlockAt) external;

    function bonusToken() external view returns (address);

    function vault() external view returns (address);
}

/// @dev The two pool reads the adapter makes: the tick spacing every band sits on, and the spot
///      tick every band is placed around (the full Uniswap V3 `slot0` tuple).
interface IApeBondPool {
    function tickSpacing() external view returns (int24);

    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
}

/**
 * @title ApeBondPositionAdapter
 * @notice The narrow gate between SoulZap and {LPStakingVault} for ApeBond purchases (B.3 decision
 *         document, 2026-10-01, with the overrides of 2026-10-05).
 *
 *  WHAT IT DOES. SoulZap arrives with a finished Uniswap V3 position bought through ApeBond. In
 *  the caller's own transaction this contract decides whether REAL accepts it, COMPUTES the
 *  campaign bonus from the position itself, stakes the position in the vault for the buyer, and
 *  records the bonus in {BonusEscrow} under the position's `tokenId`. It swaps nothing, mints
 *  nothing, touches no ERC-20 and holds nothing between transactions.
 *
 *  THE CONTRACT COMPUTES THE BONUS (P1, A1). There is no signature, no purchase id and no bonus
 *  number from the router or from a backend. The bonus is
 *
 *      value = PositionValue.valueAt(liquidity, tickLower, tickUpper, twapTick, bonusIsToken0)
 *      bonus = value x bonusBps / 10,000          (zero when below the campaign's minBonusAmount)
 *
 *  where `twapTick` is the vault's own TWAP (`vault.previewTwap()`), and the deposit reverts when
 *  spot is outside the vault's TWAP bounds. Valuing at the TWAP means a price pushed inside the
 *  transaction cannot inflate the bonus (B.3 §5.1). Uncollected fees are not counted.
 *
 *  NO LIMIT OF ANY KIND (override O2, 2026-10-05). A campaign carries its band (two offsets and
 *  a tolerance, below), its cliff (`bonusCliffSeconds`), its rate (`bonusBps`, at most 10,000)
 *  and its minimum bonus (`minBonusAmount`, D6 — below it the position is staked normally and
 *  gets no reservation; nothing reverts). There is no per-purchase, per-campaign, daily or total
 *  cap, and the escrow records a bonus whatever its balance is; claims revert until the company
 *  funds it.
 *
 *  THE BAND FOLLOWS THE PRICE AT THE PURCHASE (Vladimir's decision of 14 Oct 2026). A campaign
 *  stores no range. It stores two offsets in $ASSET-price terms — `downTicks`, how far BELOW the
 *  $ASSET price the band starts, and `upTicks`, how far ABOVE it the band ends (the deploy
 *  scripts default to -50 % and +100 %) — and `toleranceTicks`. At each deposit the adapter reads
 *  the pool's spot tick from `slot0()` and places the expected band around it
 *  ({campaignRange}): the lower edge rounded DOWN and the upper edge rounded UP to the tick
 *  spacing, both kept inside Uniswap's tick bounds. The NFT is accepted when each of its two
 *  edges is at most `toleranceTicks` from the expected edge, so a purchase minted a few blocks
 *  earlier, or one tick-spacing off, still passes. When the price moves, the band moves with it:
 *  the timelock never has to re-centre a campaign.
 *
 *  TOKEN ORDER. A tick measures token1 per token0. When $ASSET is token0 its price RISES with the
 *  tick, so the band is [spot - downTicks, spot + upTicks]. When $ASSET is token1 its price FALLS
 *  as the tick rises, so the band is [spot - upTicks, spot + downTicks].
 *
 *  SPOT PLACES THE BAND, THE TWAP PAYS THE BONUS. The band has to sit where the purchase really
 *  minted, and a mint happens at spot, so spot is the band's reference. Spot can be pushed inside
 *  a transaction, but that only moves WHERE the accepted band sits, never WHAT the bonus pays:
 *  the bonus is the position's value at the vault's TWAP, and the deposit reverts when spot is
 *  outside the vault's TWAP bounds.
 *
 *  ONE FLOOR (audit C-14, 7 Oct 2026). A campaign's cliff is never below {minCliffSeconds}, an
 *  immutable set at deployment and never zero. With a zero cliff the bonus would unlock in the
 *  purchase's own block, the vault's exit report would find nothing left to forfeit, and a buyer
 *  could stake, unstake and keep the bonus in one transaction.
 *
 *  THE BONUS IS CONDITIONAL (D1-D3). Once reserved, it is the escrow's: the vault reports every
 *  `unstake` and `rebalance` to it, an exit before the cliff forfeits the bonus, and a rebalance
 *  before the cliff moves it to the new NFT scaled by the share of value that stayed staked.
 *
 *  WRITES NOTHING. `depositFor` changes no storage of this contract: the reentrancy lock and the
 *  NFT receive window are TRANSIENT storage (EIP-1153), cleared at the end of the transaction.
 *  Everything this contract stores is configuration set by the timelock.
 *
 *  REPLACEABLE, NOT UPGRADEABLE. Plain `Ownable`, owned by the timelock. Replacing it is: deploy
 *  the new adapter, configure its campaigns and callers, then ONE timelock batch —
 *  `vault.setStakeOperator(new, true)`, `vault.setStakeOperator(old, false)`,
 *  `escrow.setAdapter(new)` (B.3 §5.5). Nothing is migrated: no id book, no counter.
 *
 *  NO RESCUE, NO SWEEP, NO ARBITRARY CALL. No function here moves a token on anyone's say-so. A
 *  position NFT pushed in by a plain `transferFrom` outside a deposit is unrecoverable here; a
 *  safe transfer outside a deposit is rejected by {onERC721Received}.
 *
 *  ADMIN, TWO TIERS AND THE VAULT'S OPERATOR:
 *
 *    | tier                            | functions                                              |
 *    |---------------------------------|--------------------------------------------------------|
 *    | owner (timelock)                | {setCampaign}, {setCampaignEnabled},                   |
 *    |                                 | {setCampaignCaller}, {setSoulZapCaller}, {setGuardian} |
 *    | vault operator (multisig, read  | {setGuardian} (audit C-29)                             |
 *    | live from `vault.operator()`)   |                                                        |
 *    | guardian (pause key)            | {setDepositsPaused}                                    |
 *
 *  Admitting a caller or changing what a campaign pays is a code change in all but name, so it
 *  waits out the timelock. Stopping the route is an incident, so the guardian does it in one
 *  transaction; the vault's own deposit pause stops this adapter too (every deposit ends in
 *  `stakeFor`), but stops ordinary stakers with it. Replacing a leaked guardian key is an
 *  incident too, so the vault's operator may do it with no delay, as on the vault itself.
 *
 *  WHAT STILL RESTS ON TRUST (P6): the caller allowlist decides who can earn a bonus; the
 *  beneficiary is the router's word; and the vault's TWAP parameters, which this contract values
 *  at, are operator-tier with no delay (bounded to a 300..3600 s window and 1823 ticks).
 */
contract ApeBondPositionAdapter is Ownable, ReentrancyGuardTransient, IERC721Receiver {
    // ──────────────────────── Types ────────────────────────────

    /**
     * @notice What the timelock configures per campaign — and the only numbers a campaign has.
     *         The band is not stored: it is placed around the pool's spot tick at each purchase
     *         (see {campaignRange}). A campaign exists once `downTicks` and `upTicks` are both
     *         above zero.
     * @param enabled True while deposits into the campaign are accepted.
     * @param downTicks How far below the $ASSET price at the purchase the band starts, in ticks
     *        ("down" = a LOWER $ASSET price). Above zero.
     * @param upTicks How far above the $ASSET price at the purchase the band ends, in ticks ("up"
     *        = a HIGHER $ASSET price). Above zero; `downTicks + upTicks` is below the width of
     *        Uniswap's whole tick range.
     * @param toleranceTicks The largest accepted distance of each NFT edge from the expected
     *        edge, in ticks. At least the pool's tick spacing.
     * @param bonusCliffSeconds Seconds from the deposit until the bonus can be claimed; at least
     *        {minCliffSeconds}.
     * @param bonusBps The bonus as a share of the position's value, in basis points (<= 10,000).
     * @param minBonusAmount Below this computed bonus the position is staked without a bonus.
     */
    struct CampaignConfig {
        bool enabled;
        int24 downTicks;
        int24 upTicks;
        int24 toleranceTicks;
        uint64 bonusCliffSeconds;
        uint16 bonusBps;
        uint256 minBonusAmount;
    }

    /// @dev One deposit's computed figures, carried in memory to stay inside the stack limit
    ///      (0.8.28, optimizer 200, no via-IR).
    struct Deposit {
        uint128 liquidity;
        int24 tickLower;
        int24 tickUpper;
        int24 twapTick;
        uint64 unlockAt;
        uint256 positionValue;
        uint256 bonus;
    }

    // ──────────────────────── Constants ────────────────────────

    /// @notice Basis-point denominator; also the ceiling of `bonusBps` (the whole value).
    uint16 public constant BPS = 10_000;

    // ──────────────────────── Immutables ───────────────────────

    /// @notice The ONLY position manager whose NFTs this adapter accepts.
    INonfungiblePositionManager public immutable positionManager;
    /// @notice The vault (the PROXY) that takes custody of every accepted position.
    IApeBondVault public immutable vault;
    /// @notice The escrow (the PROXY) that records every bonus.
    IApeBondEscrow public immutable escrow;
    /// @notice The vault's pool token0, read from the vault at construction.
    address public immutable token0;
    /// @notice The vault's pool token1, read from the vault at construction.
    address public immutable token1;
    /// @notice The vault's pool fee tier, read from the vault at construction.
    uint24 public immutable fee;
    /// @notice The vault's pool tick spacing; every campaign band sits on it.
    int24 public immutable tickSpacing;
    /// @notice True when the escrow's bonus token is token0; positions are valued in it.
    bool public immutable bonusIsToken0;
    /// @notice The shortest cliff {setCampaign} accepts, in seconds. Never zero (audit C-14).
    uint64 public immutable minCliffSeconds;
    /// @dev The vault's pool, read once at construction: the spot tick every band is placed around.
    IApeBondPool private immutable _pool;

    // ──────────────────────── State (configuration only) ───────

    /// @notice While true, {depositFor} reverts. Nothing else on this contract is affected.
    bool public depositsPaused;

    /// @notice The fast-path incident responder: {setDepositsPaused}, nothing else.
    address public guardian;

    /// @notice True while `caller` may call {depositFor} at all (the global allowlist).
    mapping(address => bool) public soulZapCallers;

    /// @notice Campaign id => its configuration. An unset campaign has `downTicks == upTicks == 0`.
    mapping(bytes32 => CampaignConfig) public campaigns;

    /// @notice Campaign id => caller => true while that caller may deposit into that campaign.
    mapping(bytes32 => mapping(address => bool)) public campaignCallers;

    /// @dev True only inside the adapter's own NFT pull. Transient: never persisted.
    bool private transient _receiving;

    // ──────────────────────── Events ───────────────────────────

    /// @notice One ApeBond purchase became a staked REAL position. `positionValue` is the value at
    ///         `twapTick` in the bonus token; `bonusAmount` is zero (and `bonusUnlockAt` zero)
    ///         when the computed bonus was below the campaign's minimum.
    event ApeBondPositionDeposited(
        uint256 indexed tokenId,
        bytes32 indexed campaignId,
        address indexed beneficiary,
        uint128 liquidity,
        int24 tickLower,
        int24 tickUpper,
        int24 twapTick,
        uint256 positionValue,
        uint256 bonusAmount,
        uint64 bonusUnlockAt
    );

    /// @notice A campaign was created or reconfigured. Full new state.
    event CampaignSet(
        bytes32 indexed campaignId,
        bool enabled,
        int24 downTicks,
        int24 upTicks,
        int24 toleranceTicks,
        uint64 bonusCliffSeconds,
        uint16 bonusBps,
        uint256 minBonusAmount
    );

    /// @notice A campaign was switched on or off. Full new state.
    event CampaignEnabledSet(bytes32 indexed campaignId, bool enabled);

    /// @notice A caller was permitted for, or removed from, one campaign. Full new state.
    event CampaignCallerSet(bytes32 indexed campaignId, address indexed caller, bool allowed);

    /// @notice A caller was put on, or removed from, the global allowlist. Full new state.
    event SoulZapCallerSet(address indexed caller, bool allowed);

    /// @notice Deposit pause switch changed. Full new state.
    event DepositsPausedSet(bool depositsPaused);

    /// @notice The guardian changed. Carries both sides.
    event GuardianSet(address previousGuardian, address newGuardian);

    // ──────────────────────── Errors ───────────────────────────

    /// @dev An argument that must reference a live address was address(0).
    error ZeroAddress();

    /// @dev The escrow's bonus token is neither of the vault's two pool tokens.
    error BonusTokenNotInPool(address bonusToken, address token0, address token1);

    /// @dev The escrow is linked to a different vault than this adapter deposits into.
    error EscrowVaultMismatch(address escrowVault, address vault);

    /// @dev The vault does not report its exits and re-ranges to this adapter's escrow (it reports
    ///      to `vaultEscrow`, zero meaning nobody), so a bonus reserved now could never be forfeited.
    error EscrowNotLinked(address vaultEscrow, address escrow);

    /// @dev New deposits are switched off.
    error DepositsArePaused();

    /// @dev The caller is not on the global allowlist.
    error NotSoulZapCaller(address caller);

    /// @dev The caller is on the global allowlist but not permitted for this campaign.
    error NotCampaignCaller(bytes32 campaignId, address caller);

    /// @dev No campaign is configured under this id.
    error UnknownCampaign(bytes32 campaignId);

    /// @dev The campaign exists and is switched off.
    error CampaignDisabled(bytes32 campaignId);

    /// @dev The campaign id is zero, which is reserved as "no campaign".
    error ZeroCampaignId();

    /// @dev Campaign offsets no band can be built from: an offset at or below zero, a tolerance
    ///      below the pool's tick spacing, or a band as wide as Uniswap's whole tick range.
    error InvalidCampaignOffsets(int24 downTicks, int24 upTicks, int24 toleranceTicks, int24 tickSpacing);

    /// @dev `bonusBps` above 10,000 (more than the whole value).
    error BonusBpsTooHigh(uint16 bonusBps);

    /// @dev The constructor was given a zero cliff floor.
    error ZeroMinCliff();

    /// @dev A campaign cliff below {minCliffSeconds}.
    error CliffBelowMinimum(uint64 cliffSeconds, uint64 minCliffSeconds);

    /// @dev The beneficiary is zero, or an address that would strand the position.
    error InvalidBeneficiary(address beneficiary);

    /// @dev The caller does not own the NFT it is trying to deposit.
    error NftNotHeldByCaller(uint256 tokenId, address owner, address caller);

    /// @dev The caller owns the NFT but has not approved this adapter for it.
    error NftNotApproved(uint256 tokenId, address caller);

    /// @dev The position is on a different pair or fee tier than the vault's.
    error PositionPoolMismatch(uint256 tokenId, address positionToken0, address positionToken1, uint24 positionFee);

    /// @dev An edge of the position is further than the campaign's tolerance from the edge of the
    ///      band placed around the pool's spot tick.
    error TickRangeOutsideTolerance(
        int24 tickLower, int24 tickUpper, int24 expectedLower, int24 expectedUpper, int24 toleranceTicks
    );

    /// @dev The position holds no liquidity.
    error EmptyPosition(uint256 tokenId);

    /// @dev Spot is further from the vault's TWAP than the vault's ceiling allows (a large
    ///      purchase can move the price itself). The router must surface this one.
    error PriceOutsideTwapBounds(int24 currentTick, int24 twapTick, int24 maxDeviationTicks);

    /// @dev The end state is not the one the whole call exists to produce.
    error CustodyAssertFailed(uint256 tokenId, address owner, address staker);

    /// @dev An ERC-721 other than the configured position manager tried to hand over a token.
    error UnexpectedNftSender(address sender);

    /// @dev A position NFT was safe-transferred here outside a live deposit.
    error UnsolicitedPosition(address operator, address from, uint256 tokenId);

    /// @dev A guardian-tier function was called by someone else — the owner included.
    error NotGuardian(address caller, address guardian);

    /// @dev {setGuardian} was called by someone who is neither the owner nor the vault's operator —
    ///      the standing guardian included, since a guardian cannot rotate itself.
    error NotOwnerOrOperator(address caller);

    // ──────────────────────── Modifiers ────────────────────────

    /// @dev The fast-path tier. Deliberately NOT satisfied by `owner()`.
    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian(msg.sender, guardian);
        _;
    }

    /// @dev The guardian seat: the owner (the timelock) OR the vault's operator (the multisig,
    ///      read live from `vault.operator()`, so a rotation on the vault applies here too).
    modifier onlyOwnerOrVaultOperator() {
        if (msg.sender != owner() && msg.sender != vault.operator()) revert NotOwnerOrOperator(msg.sender);
        _;
    }

    // ──────────────────────── Constructor ──────────────────────

    /**
     * @param _positionManager Uniswap V3 NonfungiblePositionManager. The only accepted issuer.
     * @param _vault LPStakingVault (the PROXY) that custodies every accepted position.
     * @param _escrow BonusEscrow (the PROXY) that records every bonus. It must be linked to the
     *        same vault, and its bonus token must be one of the vault's two pool tokens.
     * @param _initialOwner Owner: the deploying key while the campaigns are configured, then the
     *        `TimelockController` (one `transferOwnership`, no acceptance step).
     * @param _guardian Guardian: the pause key.
     * @param minCliffSeconds_ The shortest campaign cliff {setCampaign} will accept, in seconds.
     *        Immutable and never zero; the deploy scripts default it to one day and refuse less on
     *        mainnet (`LP_APEBOND_MIN_CLIFF_SECONDS`).
     * @dev The pool's token pair, fee and tick spacing are READ, never configured: a campaign can
     *      only ever be about the vault's own pool, so a configured copy could only be wrong.
     */
    constructor(
        address _positionManager,
        address _vault,
        address _escrow,
        address _initialOwner,
        address _guardian,
        uint64 minCliffSeconds_
    ) Ownable(_initialOwner) {
        if (_positionManager == address(0) || _vault == address(0) || _escrow == address(0)) {
            revert ZeroAddress();
        }
        if (_guardian == address(0)) revert ZeroAddress();
        if (minCliffSeconds_ == 0) revert ZeroMinCliff();

        address escrowVault = IApeBondEscrow(_escrow).vault();
        if (escrowVault != _vault) revert EscrowVaultMismatch(escrowVault, _vault);

        address token0_ = IApeBondVault(_vault).token0();
        address token1_ = IApeBondVault(_vault).token1();
        address bonusToken_ = IApeBondEscrow(_escrow).bonusToken();
        if (bonusToken_ == token0_) {
            bonusIsToken0 = true;
        } else if (bonusToken_ != token1_) {
            revert BonusTokenNotInPool(bonusToken_, token0_, token1_);
        }

        positionManager = INonfungiblePositionManager(_positionManager);
        vault = IApeBondVault(_vault);
        escrow = IApeBondEscrow(_escrow);
        token0 = token0_;
        token1 = token1_;
        fee = IApeBondVault(_vault).fee();
        IApeBondPool pool_ = IApeBondPool(IApeBondVault(_vault).pool());
        _pool = pool_;
        tickSpacing = pool_.tickSpacing();
        minCliffSeconds = minCliffSeconds_;

        guardian = _guardian;
        emit GuardianSet(address(0), _guardian);
        emit DepositsPausedSet(false);
    }

    // ──────────────────────── SoulZap function ─────────────────

    /**
     * @notice Accepts one freshly minted position from SoulZap, stakes it in the vault for its
     *         buyer, and records the bonus this contract computes for it.
     *
     * @dev Step 0 (audit C-12, 7 Oct 2026), then the order of B.3 §5.4, and no other:
     *        0. the vault reports to this adapter's escrow: `vault.bonusEscrow() == escrow`.
     *           A vault that reports to no escrow, or to another one, never forfeits the bonus
     *           of an early exit, so a reservation made then would be unconditional;
     *        1. deposits are not paused;
     *        2. the caller is on the global allowlist AND permitted for the campaign;
     *        3. the campaign exists and is enabled;
     *        4. the beneficiary is not zero, the adapter, the vault or the position manager;
     *        5. the caller owns the NFT and has approved this adapter for it;
     *        6. the position is on the vault's pair and fee, each edge within the campaign's
     *           tolerance of the band placed around the pool's spot tick ({campaignRange}), with
     *           liquidity above zero;
     *        7. the vault's TWAP; revert when spot is outside its bounds;
     *        8. value = valueAt(position, TWAP); bonus = value x bonusBps / 10,000, zero below
     *           the campaign's minimum (D6 — staked normally, no reservation);
     *        9. the NFT is pulled in, the vault approved, `vault.stakeFor(beneficiary, tokenId)`;
     *       10. a bonus above zero is reserved in the escrow, unlocking after the campaign's cliff;
     *       11. custody assertion: the vault owns the NFT and credits the beneficiary;
     *       12. {ApeBondPositionDeposited}.
     *
     *      A second `depositFor` of the same NFT cannot earn a second bonus: the escrow keeps
     *      every record, forfeited ones included, and refuses a duplicate.
     * @param tokenId The freshly minted position NFT, owned by the calling SoulZap contract.
     * @param campaignId The campaign the purchase belongs to.
     * @param beneficiary The buyer: credited as the vault staker and as the bonus payee.
     */
    function depositFor(uint256 tokenId, bytes32 campaignId, address beneficiary) external nonReentrant {
        CampaignConfig memory campaign = _checkCaller(campaignId);
        _checkBeneficiary(beneficiary);
        Deposit memory d = _checkPosition(tokenId, campaign);
        _price(d, campaign);

        _receiving = true;
        positionManager.safeTransferFrom(msg.sender, address(this), tokenId);
        _receiving = false;

        // Per-token approval: the adapter never holds an NFT across transactions, and the vault's
        // pull clears the approval on transfer. A paused vault reverts here with
        // `DepositsArePaused` and takes the whole purchase with it.
        positionManager.approve(address(vault), tokenId);
        vault.stakeFor(beneficiary, tokenId);

        if (d.bonus > 0) {
            escrow.reserve(tokenId, beneficiary, d.bonus, d.unlockAt);
        }

        address owner_ = positionManager.ownerOf(tokenId);
        address staker = vault.stakerOf(tokenId);
        if (owner_ != address(vault) || staker != beneficiary) {
            revert CustodyAssertFailed(tokenId, owner_, staker);
        }

        emit ApeBondPositionDeposited(
            tokenId,
            campaignId,
            beneficiary,
            d.liquidity,
            d.tickLower,
            d.tickUpper,
            d.twapTick,
            d.positionValue,
            d.bonus,
            d.unlockAt
        );
    }

    // ──────────────────────── ERC-721 receiver ─────────────────

    /**
     * @notice ERC-721 receipt hook. Accepts position NFTs only from the configured position
     *         manager and only inside this contract's own deposit.
     * @param operator Address that triggered the transfer.
     * @param from Previous owner.
     * @param tokenId The NFT being transferred.
     * @return The ERC-721 receiver magic value.
     */
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata)
        external
        view
        override
        returns (bytes4)
    {
        if (msg.sender != address(positionManager)) revert UnexpectedNftSender(msg.sender);
        if (!_receiving) revert UnsolicitedPosition(operator, from, tokenId);
        return IERC721Receiver.onERC721Received.selector;
    }

    // ──────────────────────── Views ────────────────────────────

    /**
     * @notice The band a purchase into `campaignId` must match right now: the campaign's offsets
     *         placed around the pool's spot tick, oriented by which pool token $ASSET is, the
     *         lower edge rounded down and the upper edge rounded up to the tick spacing, both
     *         kept inside Uniswap's tick bounds. A deposit accepts an NFT whose edges are each
     *         within `toleranceTicks` of these two.
     * @dev Reverts {UnknownCampaign} when no campaign is configured under `campaignId`.
     * @return tickLower The expected lower edge.
     * @return tickUpper The expected upper edge.
     * @return currentTick The pool's spot tick the band was placed around.
     */
    function campaignRange(bytes32 campaignId)
        external
        view
        returns (int24 tickLower, int24 tickUpper, int24 currentTick)
    {
        return _campaignRange(_existing(campaignId));
    }

    /**
     * @notice The bonus {depositFor} would compute for `liquidity` on the band {campaignRange}
     *         returns right now, and the position value it is a share of. Zero bonus below the
     *         minimum.
     * @dev For quotes and tests. Reverts like {depositFor} when the campaign is unknown or spot is
     *      outside the TWAP bounds.
     */
    function previewBonus(bytes32 campaignId, uint128 liquidity)
        external
        view
        returns (uint256 positionValue, uint256 bonus, int24 twapTick)
    {
        CampaignConfig memory campaign = _existing(campaignId);
        (int24 tickLower, int24 tickUpper,) = _campaignRange(campaign);
        return _preview(campaign, liquidity, tickLower, tickUpper);
    }

    /**
     * @notice The bonus {depositFor} would compute for `liquidity` on the explicit range
     *         [`tickLower`, `tickUpper`], and the position value it is a share of. A quote only:
     *         the range is valued as given, with no tolerance check against the campaign's band.
     * @dev Reverts like {previewBonus} when the campaign is unknown or spot is outside the TWAP
     *      bounds.
     */
    function previewBonusAt(bytes32 campaignId, uint128 liquidity, int24 tickLower, int24 tickUpper)
        external
        view
        returns (uint256 positionValue, uint256 bonus, int24 twapTick)
    {
        return _preview(_existing(campaignId), liquidity, tickLower, tickUpper);
    }

    // ──────────────────────── Owner functions (timelock) ───────

    /**
     * @notice Creates or reconfigures one campaign. Affects only deposits made afterwards: a
     *         reservation already in the escrow keeps its amount and its unlock time.
     * @dev Validates what can be validated at configuration time: a non-zero id; offsets a band
     *      can be built from (`downTicks` and `upTicks` above zero, together narrower than
     *      Uniswap's whole tick range, and a tolerance of at least one tick spacing, since every
     *      NFT edge sits on the spacing); a rate no larger than the whole value; and a cliff no
     *      shorter than {minCliffSeconds} (audit C-14). Nothing else: there is no limit of any
     *      kind (override O2).
     */
    function setCampaign(bytes32 campaignId, CampaignConfig calldata config) external onlyOwner {
        if (campaignId == bytes32(0)) revert ZeroCampaignId();
        int24 down = config.downTicks;
        int24 up = config.upTicks;
        int24 tolerance = config.toleranceTicks;
        if (
            down <= 0 || up <= 0 || tolerance < tickSpacing
                || int256(down) + int256(up) >= int256(TickMath.MAX_TICK) - int256(TickMath.MIN_TICK)
        ) {
            revert InvalidCampaignOffsets(down, up, tolerance, tickSpacing);
        }
        if (config.bonusBps > BPS) revert BonusBpsTooHigh(config.bonusBps);
        if (config.bonusCliffSeconds < minCliffSeconds) {
            revert CliffBelowMinimum(config.bonusCliffSeconds, minCliffSeconds);
        }

        campaigns[campaignId] = config;
        emit CampaignSet(
            campaignId,
            config.enabled,
            down,
            up,
            tolerance,
            config.bonusCliffSeconds,
            config.bonusBps,
            config.minBonusAmount
        );
    }

    /// @notice Switches one existing campaign on or off.
    function setCampaignEnabled(bytes32 campaignId, bool enabled) external onlyOwner {
        CampaignConfig storage campaign = _existing(campaignId);
        campaign.enabled = enabled;
        emit CampaignEnabledSet(campaignId, enabled);
    }

    /// @notice Permits or removes one caller for one campaign. A caller needs this AND the global
    ///         allowlist ({setSoulZapCaller}).
    /// @dev The campaign need not be configured yet, so one timelock batch may permit the caller
    ///      and configure the campaign in either order; a deposit into an unconfigured campaign
    ///      still reverts with {UnknownCampaign}.
    function setCampaignCaller(bytes32 campaignId, address caller, bool allowed) external onlyOwner {
        if (campaignId == bytes32(0)) revert ZeroCampaignId();
        if (caller == address(0)) revert ZeroAddress();
        campaignCallers[campaignId][caller] = allowed;
        emit CampaignCallerSet(campaignId, caller, allowed);
    }

    /// @notice Puts one caller on, or takes it off, the global allowlist.
    /// @dev Removing a caller urgently does not need this: {setDepositsPaused} stops every caller
    ///      in one guardian transaction.
    function setSoulZapCaller(address caller, bool allowed) external onlyOwner {
        if (caller == address(0)) revert ZeroAddress();
        soulZapCallers[caller] = allowed;
        emit SoulZapCallerSet(caller, allowed);
    }

    /**
     * @notice Rotates the guardian.
     * @dev Owner OR the vault's operator (audit C-29, 7 Oct 2026). The guardian holds an undelayed
     *      switch, so a leaked guardian key could pause or unpause ApeBond deposits for the whole
     *      48 h a timelock-only rotation would take; the operator multisig replaces it at once,
     *      exactly as it can on the vault. Zero is still refused; to empty the seat in a hurry the
     *      operator appoints itself, which gives it nothing beyond the deposit pause it already
     *      holds on the vault.
     */
    function setGuardian(address newGuardian) external onlyOwnerOrVaultOperator {
        if (newGuardian == address(0)) revert ZeroAddress();
        emit GuardianSet(guardian, newGuardian);
        guardian = newGuardian;
    }

    // ──────────────────────── Guardian function ────────────────

    /**
     * @notice Stops and restarts ApeBond deposits.
     * @dev Narrower than the vault's own deposit pause, which stops every staker: this one takes
     *      the ApeBond route out and leaves everything else running. Unstakes and bonus claims
     *      never pass through this contract and are unaffected.
     */
    function setDepositsPaused(bool paused) external onlyGuardian {
        depositsPaused = paused;
        emit DepositsPausedSet(paused);
    }

    // ──────────────────────── Internal helpers ─────────────────

    /// @dev Steps 0-3: the vault-escrow link, the pause, the two allowlists, the campaign.
    function _checkCaller(bytes32 campaignId) private view returns (CampaignConfig memory campaign) {
        address vaultEscrow = vault.bonusEscrow();
        if (vaultEscrow != address(escrow)) revert EscrowNotLinked(vaultEscrow, address(escrow));
        if (depositsPaused) revert DepositsArePaused();
        if (!soulZapCallers[msg.sender]) revert NotSoulZapCaller(msg.sender);
        if (!campaignCallers[campaignId][msg.sender]) revert NotCampaignCaller(campaignId, msg.sender);

        campaign = campaigns[campaignId];
        if (campaign.downTicks <= 0 || campaign.upTicks <= 0) revert UnknownCampaign(campaignId);
        if (!campaign.enabled) revert CampaignDisabled(campaignId);
    }

    /// @dev Step 4. A position credited to the vault, the adapter or the position manager could
    ///      never be unstaked (SEC-05).
    function _checkBeneficiary(address beneficiary) private view {
        if (
            beneficiary == address(0) || beneficiary == address(this) || beneficiary == address(vault)
                || beneficiary == address(positionManager)
        ) {
            revert InvalidBeneficiary(beneficiary);
        }
    }

    /// @dev Steps 5-6: the NFT is the caller's, reachable by this adapter, and is a position on
    ///      the vault's pool, within the campaign's tolerance of its band, with some liquidity.
    function _checkPosition(uint256 tokenId, CampaignConfig memory campaign)
        private
        view
        returns (Deposit memory d)
    {
        address owner_ = positionManager.ownerOf(tokenId);
        if (owner_ != msg.sender) revert NftNotHeldByCaller(tokenId, owner_, msg.sender);
        if (
            positionManager.getApproved(tokenId) != address(this)
                && !positionManager.isApprovedForAll(msg.sender, address(this))
        ) {
            revert NftNotApproved(tokenId, msg.sender);
        }

        address positionToken0;
        address positionToken1;
        uint24 positionFee;
        (,, positionToken0, positionToken1, positionFee, d.tickLower, d.tickUpper, d.liquidity,,,,) =
            positionManager.positions(tokenId);

        if (positionToken0 != token0 || positionToken1 != token1 || positionFee != fee) {
            revert PositionPoolMismatch(tokenId, positionToken0, positionToken1, positionFee);
        }
        _checkRange(d, campaign);
        if (d.liquidity == 0) revert EmptyPosition(tokenId);
    }

    /// @dev Step 6, the band: each NFT edge at most `toleranceTicks` from the matching edge of the
    ///      band placed around the pool's spot tick right now.
    function _checkRange(Deposit memory d, CampaignConfig memory campaign) private view {
        (int24 expectedLower, int24 expectedUpper,) = _campaignRange(campaign);
        int256 tolerance = campaign.toleranceTicks;
        if (
            _distance(d.tickLower, expectedLower) > tolerance || _distance(d.tickUpper, expectedUpper) > tolerance
        ) {
            revert TickRangeOutsideTolerance(
                d.tickLower, d.tickUpper, expectedLower, expectedUpper, campaign.toleranceTicks
            );
        }
    }

    /**
     * @dev The band for `campaign` around the pool's spot tick. $ASSET as token0: its price rises
     *      with the tick, so "down" is below the tick. $ASSET as token1: its price falls as the
     *      tick rises, so "down" is ABOVE the tick and the two offsets swap sides. The lower edge
     *      is rounded down and the upper edge up to the spacing (the band only ever widens), then
     *      both are clamped into the usable tick range. All arithmetic is int256: no int24 sum
     *      can overflow on the way.
     */
    function _campaignRange(CampaignConfig memory campaign)
        private
        view
        returns (int24 tickLower, int24 tickUpper, int24 currentTick)
    {
        (, currentTick,,,,,) = _pool.slot0();
        (int256 below, int256 above) = bonusIsToken0
            ? (int256(campaign.downTicks), int256(campaign.upTicks))
            : (int256(campaign.upTicks), int256(campaign.downTicks));
        int256 spacing = tickSpacing;
        tickLower = _clampToUsable(_floorToSpacing(int256(currentTick) - below, spacing), spacing);
        tickUpper = _clampToUsable(_ceilToSpacing(int256(currentTick) + above, spacing), spacing);
    }

    /// @dev Steps 7-8 for the two quote views: one hypothetical position, priced like a deposit.
    function _preview(CampaignConfig memory campaign, uint128 liquidity, int24 tickLower, int24 tickUpper)
        private
        view
        returns (uint256 positionValue, uint256 bonus, int24 twapTick)
    {
        Deposit memory d;
        d.liquidity = liquidity;
        d.tickLower = tickLower;
        d.tickUpper = tickUpper;
        _price(d, campaign);
        return (d.positionValue, d.bonus, d.twapTick);
    }

    /// @dev Steps 7-8: the TWAP (reverting outside its bounds), the value at it, and the bonus.
    function _price(Deposit memory d, CampaignConfig memory campaign) private view {
        (int24 currentTick, int24 twapTick, int24 maxDeviationTicks, bool withinBounds) = vault.previewTwap();
        if (!withinBounds) revert PriceOutsideTwapBounds(currentTick, twapTick, maxDeviationTicks);

        d.twapTick = twapTick;
        d.positionValue = PositionValue.valueAt(d.liquidity, d.tickLower, d.tickUpper, twapTick, bonusIsToken0);
        uint256 bonus = Math.mulDiv(d.positionValue, campaign.bonusBps, BPS);
        if (bonus < campaign.minBonusAmount) bonus = 0;
        d.bonus = bonus;
        if (bonus > 0) d.unlockAt = SafeCast.toUint64(block.timestamp + campaign.bonusCliffSeconds);
    }

    /// @dev The stored campaign, reverting when none is configured under `campaignId`.
    function _existing(bytes32 campaignId) private view returns (CampaignConfig storage campaign) {
        campaign = campaigns[campaignId];
        if (campaign.downTicks <= 0 || campaign.upTicks <= 0) revert UnknownCampaign(campaignId);
    }

    /// @dev `tick` rounded DOWN (towards negative infinity) to a multiple of `spacing`. Solidity's
    ///      `%` keeps the sign of `tick`, so `tick - tick % spacing` rounds towards ZERO, which is
    ///      UP for a negative tick; a negative tick off the grid therefore takes one more step
    ///      down: -61 on a 60 grid is -120, not -60.
    function _floorToSpacing(int256 tick, int256 spacing) private pure returns (int256 rounded) {
        rounded = tick - tick % spacing;
        if (rounded > tick) rounded -= spacing;
    }

    /// @dev `tick` rounded UP (towards positive infinity) to a multiple of `spacing`. Rounding
    ///      towards zero is DOWN for a positive tick, so a positive tick off the grid takes one
    ///      more step up: 61 on a 60 grid is 120, and -61 is -60.
    function _ceilToSpacing(int256 tick, int256 spacing) private pure returns (int256 rounded) {
        rounded = tick - tick % spacing;
        if (rounded < tick) rounded += spacing;
    }

    /// @dev `tick` clamped into the usable range: Uniswap's [MIN_TICK, MAX_TICK] rounded INWARD to
    ///      the spacing. Rounding towards zero is inward for both bounds (-887272 and 887272 on a
    ///      60 grid give -887220 and 887220).
    function _clampToUsable(int256 tick, int256 spacing) private pure returns (int24) {
        int256 maxUsable = int256(TickMath.MAX_TICK) - int256(TickMath.MAX_TICK) % spacing;
        int256 minUsable = int256(TickMath.MIN_TICK) - int256(TickMath.MIN_TICK) % spacing;
        if (tick > maxUsable) return SafeCast.toInt24(maxUsable);
        if (tick < minUsable) return SafeCast.toInt24(minUsable);
        return SafeCast.toInt24(tick);
    }

    /// @dev |a - b| in int256, so no int24 difference can overflow.
    function _distance(int24 a, int24 b) private pure returns (int256) {
        int256 diff = int256(a) - int256(b);
        return diff < 0 ? -diff : diff;
    }
}
