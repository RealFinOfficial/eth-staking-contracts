// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import "./interfaces/INonfungiblePositionManager.sol";

// ──────────────────────── Local interfaces ─────────────────────

/// @dev Only the two calls the adapter makes into the vault. Declared locally, like
///      {LPZapper}'s own copy, so the periphery never imports the core contract.
interface ILPStakingVault {
    function stakeFor(address user, uint256 tokenId) external;

    function stakerOf(uint256 tokenId) external view returns (address);
}

/// @dev Only the call the adapter makes into the escrow, named as integration spec §6.3
///      names it. {BonusEscrow} is the implementation behind it; the adapter talks to the
///      proxy and never needs the concrete type.
interface IApeBondBonusEscrow {
    function reserve(bytes32 purchaseId, address beneficiary, uint256 amount, uint64 unlockAt) external;
}

/**
 * @title ApeBondPositionAdapter
 * @notice The narrow gate between SoulZap and {LPStakingVault} — integration spec §6.1.
 *
 *  WHAT IT IS NOT. It does not swap, does not price a split, does not mint liquidity, does not
 *  hold an ApeBond Bill NFT and computes no rewards. SoulZap does all of that and arrives with
 *  a finished Uniswap V3 position; this contract's whole job is to decide whether REAL accepts
 *  that position, and — if it does — to move it into the vault and record the bonus, in the
 *  caller's own transaction. It swaps nothing, mints nothing and holds nothing between
 *  transactions: every NFT it takes custody of leaves for the vault a few lines later, and it
 *  never touches an ERC-20 at all.
 *
 *  THE TRUST BOUNDARY IS A SIGNATURE, NOT A CALLER. Two separate things have to be true for a
 *  deposit to land, and they come from two different places (§4.1). The SoulZap quote decides
 *  what gets executed; REAL's own backend signature decides what REAL is willing to accept and
 *  reward. So an allowlisted SoulZap caller with no signature gets nothing, and a valid
 *  signature presented by anyone else gets nothing either. The signed
 *  {PurchaseAuthorization} carries everything about the purchase that cannot be recovered from
 *  the minted NFT — the campaign, the buyer, what was paid, what bonus was promised — and the
 *  NFT itself is re-validated here against the parts that can.
 *
 *  WHY THE tokenId IS NOT SIGNED. It does not exist yet when the backend signs: the mint
 *  happens later, inside the same SoulZap transaction (§7). What stands in for it is a one-use
 *  `purchaseId` and a one-use `nonce`, an allowlisted caller, and full validation of the actual
 *  NFT presented here — pair, fee tier, exact signed ticks, and a liquidity floor.
 *
 *  REPLACEABLE, NOT UPGRADEABLE. This contract is a plain contract with a constructor, and
 *  that is the deliberate half of the team's split: the money-holding contract ({BonusEscrow})
 *  is a UUPS proxy because its ledger must survive a fix, and the gate in front of it is not,
 *  because it has no ledger worth surviving. Everything it stores is spent state — which
 *  purchase ids and nonces are used up — and every one of them belongs to a purchase that has
 *  already completed. Replacing it is two timelock transactions and no migration:
 *
 *    1. deploy the new adapter,
 *    2. `LPStakingVault.setStakeOperator(newAdapter, true)` and, to close the old door,
 *       `setStakeOperator(oldAdapter, false)`,
 *    3. `BonusEscrow.setAdapter(newAdapter)`.
 *
 *  Nothing moves and nothing is stranded, because at rest this contract owns nothing. The one
 *  thing a replacement does NOT inherit is the spent-id book, so the backend must never re-sign
 *  a `purchaseId` or a `nonce` it has already signed — which it must not do anyway, since both
 *  are one-use by construction.
 *
 *  NO RESCUE, NO SWEEP, NO ARBITRARY CALL. There is no owner function here that moves a token
 *  of any kind, and that is a decision rather than an omission (§6.1: "do not expose
 *  arbitrary-call capability"). The vault and the zapper each carry a rescue path because each
 *  has a real window in which it legitimately holds something; this contract's window is three
 *  statements wide and inside one `nonReentrant` call, so anything found sitting here
 *  afterwards was pushed in from outside — and {onERC721Received} already rejects every safe
 *  transfer that is not part of a live deposit. A plain `transferFrom` still bypasses that
 *  hook, so a misdirected position NFT, or a stray ERC-20, is unrecoverable HERE and would
 *  have to be written off. That is the accepted price: an adapter that can move an arbitrary
 *  token on an owner's say-so is a much larger surface than the one it would rescue, and the
 *  addresses people actually send positions to — the vault and the zapper — both keep theirs.
 *
 *  ADMIN, TWO TIERS, the same split as the rest of the stack and for the same reason —
 *  response time, not importance:
 *
 *    | tier                | functions                                         |
 *    |---------------------|---------------------------------------------------|
 *    | owner (timelock)    | {setSoulZapCaller}, {setGuardian}                 |
 *    | guardian (multisig) | {setPurchaseSigner}, {setDepositsPaused}          |
 *
 *  Admitting a caller is a code change in all but name, so it waits out the timelock and is
 *  public before it can run. A leaked purchase signer and a misbehaving integration are
 *  incidents, so they are answered in one multisig transaction: {setPurchaseSigner} to
 *  `address(0)` closes the path outright, and {setDepositsPaused} stops it without touching
 *  the signer. The vault's own `setDepositsPaused` stops this adapter too, since every deposit
 *  ends in `stakeFor` — this one exists so the ApeBond route can be stopped WITHOUT stopping
 *  ordinary REAL stakers.
 */
contract ApeBondPositionAdapter is Ownable, ReentrancyGuard, EIP712, IERC721Receiver {
    // ──────────────────────── Types ────────────────────────────

    /**
     * @notice What REAL's backend signed about one ApeBond purchase — integration spec §6.1,
     *         field for field and in that order.
     * @dev ABI-STABLE. SoulZap's API-side adapter builds this struct and the EIP-712 payload
     *      from the same definition, so a reordered, renamed, resized or inserted field is a
     *      breaking change for an integrator that cannot redeploy in step with us. It changes
     *      {PURCHASE_AUTHORIZATION_TYPEHASH} too, which invalidates every outstanding
     *      signature — deliberately loud, but only useful if it is never done by accident.
     * @param purchaseId Stable REAL identifier for this entitlement. Spent exactly once.
     * @param campaignId The ApeBond campaign this purchase belongs to.
     * @param soulZapRequestId The SoulZap quote this transaction executes. Correlation only.
     * @param beneficiary Buyer credited as the vault staker and as the bonus payee.
     * @param soulZapCaller The single address allowed to present this authorization.
     * @param inputToken What the buyer paid with. Audit trail; never touched on-chain here.
     * @param grossInputAmount What the buyer paid, before SoulZap's fee. Audit trail.
     * @param netInputAmount What reached the liquidity, after the fee. Audit trail.
     * @param guaranteedBonusAmount Campaign bonus to reserve. Zero means no bonus leg.
     * @param bonusUnlockAt Cliff from which the bonus may be claimed.
     * @param minLiquidity Floor under the minted position's liquidity.
     * @param expectedTickLower Lower tick the campaign approved. Matched exactly.
     * @param expectedTickUpper Upper tick the campaign approved. Matched exactly.
     * @param nonce One-use replay counter, independent of `purchaseId`.
     * @param deadline Quote expiry. The authorization is worthless after it.
     */
    struct PurchaseAuthorization {
        bytes32 purchaseId;
        bytes32 campaignId;
        bytes32 soulZapRequestId;
        address beneficiary;
        address soulZapCaller;
        address inputToken;
        uint256 grossInputAmount;
        uint256 netInputAmount;
        uint256 guaranteedBonusAmount;
        uint64 bonusUnlockAt;
        uint128 minLiquidity;
        int24 expectedTickLower;
        int24 expectedTickUpper;
        uint256 nonce;
        uint256 deadline;
    }

    // ──────────────────────── Constants ────────────────────────

    /// @notice EIP-712 type hash of {PurchaseAuthorization}, over the fields exactly as that
    ///         struct declares them.
    /// @dev Spelled out as a literal string rather than assembled, so it can be read against
    ///      the struct by eye and recomputed by a test. The domain is
    ///      `EIP712("RealApeBondPurchase", "1")`, DISTINCT from the rewards voucher domain
    ///      (`RealLPRewards`) — §6.4 requires the purchase-authorization signer and its
    ///      configuration to be separate from the {RewardsDistributor} voucher signer, and two
    ///      different domains mean neither signer's signatures can ever be replayed as the
    ///      other's even if the same key were used by mistake.
    bytes32 public constant PURCHASE_AUTHORIZATION_TYPEHASH = keccak256(
        "PurchaseAuthorization(bytes32 purchaseId,bytes32 campaignId,bytes32 soulZapRequestId,address beneficiary,address soulZapCaller,address inputToken,uint256 grossInputAmount,uint256 netInputAmount,uint256 guaranteedBonusAmount,uint64 bonusUnlockAt,uint128 minLiquidity,int24 expectedTickLower,int24 expectedTickUpper,uint256 nonce,uint256 deadline)"
    );

    /// @dev NFT-receipt guard states, mirroring {LPZapper} and {LPStakingVault}. Non-zero
    ///      sentinels keep the slot warm and avoid the 20k gas of a 0 -> 1 store on every
    ///      deposit, the same trick OZ's ReentrancyGuard uses.
    uint256 private constant NOT_RECEIVING = 1;
    uint256 private constant RECEIVING = 2;

    // ──────────────────────── Immutables ───────────────────────

    /// @notice The ONLY position manager whose NFTs this adapter accepts.
    INonfungiblePositionManager public immutable positionManager;
    /// @notice The vault that takes custody of every accepted position.
    ILPStakingVault public immutable vault;
    /// @notice The escrow that records every guaranteed campaign bonus.
    IApeBondBonusEscrow public immutable escrow;
    /// @notice First token of the campaign pool, sorted ascending by address.
    address public immutable token0;
    /// @notice Second token of the campaign pool.
    address public immutable token1;
    /// @notice Campaign pool fee tier in hundredths of a bip.
    uint24 public immutable fee;

    // ──────────────────────── State ────────────────────────────

    /// @notice Address whose EIP-712 signature authorizes a purchase. Zero closes the path.
    /// @dev Declared beside {depositsPaused} on purpose: `depositFor` reads both, and packing
    ///      them into one slot makes that one cold SLOAD rather than two.
    address public purchaseSigner;
    /// @notice While true, {depositFor} reverts. Nothing else on this contract is affected.
    bool public depositsPaused;

    /// @notice The fast-path incident responder (the multisig).
    address public guardian;

    /// @notice True while `caller` may present authorizations to {depositFor}.
    mapping(address => bool) public soulZapCallers;
    /// @notice True once `purchaseId` has been deposited. Ids are spent once, forever.
    mapping(bytes32 => bool) public consumedPurchaseIds;
    /// @notice True once `nonce` has been used. Independent of the purchase id.
    mapping(uint256 => bool) public consumedNonces;

    /// @dev NOT_RECEIVING outside the adapter's own NFT pull, RECEIVING during it.
    uint256 private _receiveGuard = NOT_RECEIVING;

    // ──────────────────────── Events ───────────────────────────

    /// @notice One ApeBond purchase became a staked REAL position. Integration spec §9, field
    ///         for field: the indexer keys an `ApeBondPurchase` on `purchaseId` and joins
    ///         `tokenId` to the vault's own `Staked` event from the same transaction.
    event ApeBondPositionDeposited(
        bytes32 indexed purchaseId,
        bytes32 indexed campaignId,
        address indexed beneficiary,
        bytes32 soulZapRequestId,
        uint256 tokenId,
        uint128 liquidity,
        int24 tickLower,
        int24 tickUpper,
        address inputToken,
        uint256 grossInputAmount,
        uint256 netInputAmount,
        uint256 guaranteedBonusAmount,
        uint64 bonusUnlockAt
    );

    /// @notice A SoulZap caller was allowed onto, or removed from, the allowlist.
    ///         Full new state: `allowed` is what the mapping says after this transaction.
    event SoulZapCallerSet(address indexed caller, bool allowed);

    /// @notice The purchase signer changed. Carries both sides for auditability.
    event PurchaseSignerSet(address previousSigner, address newSigner);

    /// @notice Deposit pause switch changed. Full new state.
    event DepositsPausedSet(bool depositsPaused);

    /// @notice The fast-path guardian changed. Carries both sides for auditability.
    event GuardianSet(address previousGuardian, address newGuardian);

    // ──────────────────────── Errors ───────────────────────────

    /// @dev An argument that must reference a live address was address(0).
    error ZeroAddress();

    /// @dev The two campaign tokens were passed unsorted. Uniswap sorts them ascending.
    error TokensNotSorted(address tokenA, address tokenB);

    /// @dev New deposits are switched off. Claims and unstakes are unaffected — neither goes
    ///      through this contract.
    error DepositsArePaused();

    /// @dev The caller is not on the SoulZap allowlist.
    error NotSoulZapCaller(address caller);

    /// @dev The authorization names a different SoulZap caller than the one presenting it.
    error CallerMismatch(address authorized, address caller);

    /// @dev The beneficiary is zero, or is one of the three addresses that would strand the
    ///      position — see the SEC-05 note on {depositFor}.
    error InvalidBeneficiary(address beneficiary);

    /// @dev The quote's deadline has passed.
    error AuthorizationExpired(uint256 deadline, uint256 blockTimestamp);

    /// @dev The signature does not recover to the configured purchase signer. `expected` is
    ///      address(0) when the path is closed.
    error InvalidSignature(address recovered, address expected);

    /// @dev This `purchaseId` has already been deposited.
    error PurchaseAlreadyProcessed(bytes32 purchaseId);

    /// @dev This `nonce` has already been used.
    error NonceAlreadyUsed(uint256 nonce);

    /// @dev The caller does not own the NFT it is trying to deposit.
    error NftNotHeldByCaller(uint256 tokenId, address owner, address caller);

    /// @dev The caller owns the NFT but has not approved this adapter for it.
    error NftNotApproved(uint256 tokenId, address caller);

    /// @dev The position is on a different pair or fee tier than the campaign's.
    error PositionPoolMismatch(uint256 tokenId, address positionToken0, address positionToken1, uint24 positionFee);

    /// @dev The position's range is not the exact range the authorization signed.
    error TickRangeMismatch(int24 tickLower, int24 tickUpper, int24 expectedTickLower, int24 expectedTickUpper);

    /// @dev The position holds no liquidity at all.
    error EmptyPosition(uint256 tokenId);

    /// @dev The position holds less liquidity than the authorization's floor.
    error InsufficientLiquidity(uint128 liquidity, uint128 minLiquidity);

    /// @dev The end state is not the one the whole call exists to produce.
    error CustodyAssertFailed(uint256 tokenId, address owner, address staker);

    /// @dev An ERC-721 other than the configured position manager tried to hand this contract
    ///      a token.
    error UnexpectedNftSender(address sender);

    /// @dev A position NFT was safe-transferred here outside a live deposit.
    error UnsolicitedPosition(address operator, address from, uint256 tokenId);

    /// @dev A guardian-tier function was called by someone else — the owner included.
    error NotGuardian(address caller, address guardian);

    // ──────────────────────── Modifiers ────────────────────────

    /// @dev The fast-path tier. Deliberately NOT satisfied by `owner()`, exactly as in the
    ///      vault and the distributor: the timelock has no business holding an undelayed
    ///      switch, and an operator reaching for one of these reaches for the multisig.
    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian(msg.sender, guardian);
        _;
    }

    // ──────────────────────── Constructor ──────────────────────

    /**
     * @param _positionManager Uniswap V3 NonfungiblePositionManager. The only accepted issuer.
     * @param _vault LPStakingVault (the PROXY) that will custody every accepted position.
     * @param _escrow BonusEscrow (the PROXY) that records every guaranteed bonus.
     * @param _token0 Expected campaign token0 (must sort below `_token1`).
     * @param _token1 Expected campaign token1.
     * @param _fee Expected campaign fee tier.
     * @param _initialOwner Owner: the `TimelockController` after the deploy handover.
     * @param _guardian Guardian: the multisig, directly.
     * @param _purchaseSigner Backend key that signs {PurchaseAuthorization}s. May be zero,
     *        which deploys the adapter with the deposit path closed until the guardian opens it.
     * @dev There is deliberately NO pool argument and therefore no live pool cross-check of the
     *      kind {LPZapper}'s constructor does. The adapter never reads a pool — it reads
     *      `positions(tokenId)`, which reports the pair and the fee tier and nothing else — so a
     *      pool address here would be a fourth configured value that nothing ever consults. The
     *      triple below is checked the two ways that do mean something on this contract: no zero
     *      side, and the Uniswap sort order, which is what makes `positions()`'s `token0` /
     *      `token1` comparable to it at all. Agreement with the VAULT's own triple is not
     *      checked here either, and does not need to be: a mismatched adapter cannot strand
     *      anything, because a position that passes this contract's check and fails the vault's
     *      reverts the whole deposit in `stakeFor`. The failure is loud, immediate, and lands on
     *      the first integration transaction rather than on a user.
     *
     *      `_purchaseSigner` and `_guardian` are announced from block one, mirroring the vault's
     *      `initialize`: a reader following the logs never has to assume an unlogged initial
     *      value.
     */
    constructor(
        address _positionManager,
        address _vault,
        address _escrow,
        address _token0,
        address _token1,
        uint24 _fee,
        address _initialOwner,
        address _guardian,
        address _purchaseSigner
    ) Ownable(_initialOwner) EIP712("RealApeBondPurchase", "1") {
        if (_positionManager == address(0) || _vault == address(0) || _escrow == address(0)) {
            revert ZeroAddress();
        }
        if (_token0 == address(0) || _token1 == address(0)) revert ZeroAddress();
        if (_token0 >= _token1) revert TokensNotSorted(_token0, _token1);
        if (_guardian == address(0)) revert ZeroAddress();

        positionManager = INonfungiblePositionManager(_positionManager);
        vault = ILPStakingVault(_vault);
        escrow = IApeBondBonusEscrow(_escrow);
        token0 = _token0;
        token1 = _token1;
        fee = _fee;

        guardian = _guardian;
        purchaseSigner = _purchaseSigner;

        emit GuardianSet(address(0), _guardian);
        emit PurchaseSignerSet(address(0), _purchaseSigner);
    }

    // ──────────────────────── SoulZap function ─────────────────

    /**
     * @notice Accepts one authorized, freshly minted position from SoulZap and stakes it in the
     *         vault for its buyer, reserving the campaign bonus in the same transaction.
     *
     * @dev The ordered checklist of integration spec §6.1, in this order and no other:
     *
     *        1. deposits are not paused,
     *        2. the caller is an allowlisted SoulZap caller,
     *        3. the authorization names that same caller,
     *        4. the beneficiary is a real, unstranding address,
     *        5. the quote has not expired,
     *        6. the EIP-712 signature recovers to the purchase signer,
     *        7. neither the purchase id nor the nonce has been spent,
     *        8. the caller owns the NFT and has approved this adapter for it,
     *        9. the position is on the campaign pair, fee tier and EXACT signed range, and
     *           carries at least `minLiquidity`,
     *       10. the purchase id and the nonce are marked spent — EFFECTS BEFORE INTERACTIONS,
     *       11. the NFT is pulled in,
     *       12. the vault is approved and `stakeFor` credits the beneficiary,
     *       13. the bonus is reserved,
     *       14. the end state is asserted,
     *       15. the integration event is emitted.
     *
     *      Steps 1–9 are cheap reads and come first so a doomed purchase costs the buyer the
     *      least gas the ordering allows. Step 10 sits between the last check and the first
     *      external call for the ordinary checks-effects-interactions reason, and it is worth
     *      being precise about what that buys HERE: this whole call is atomic inside SoulZap's,
     *      so a later revert un-spends the id along with everything else (§4.2 — "one
     *      transaction succeeds completely or reverts completely"). The consumption is not what
     *      makes a failed purchase leave no trace; that is the revert. It is what stops a
     *      re-entrant second `depositFor` — through the NFT receipt hook of a hostile position
     *      manager, or through the vault — from spending the same authorization twice inside one
     *      transaction, which `nonReentrant` also blocks and which two independent guards are
     *      cheap enough to block twice.
     *
     *      SEC-05 (`docs/lp-staking-audit-notes.md` §11) is why step 4 rejects three addresses
     *      rather than only zero. A position credited to the vault itself can never be unstaked
     *      — the recorded staker is a contract with no path to `unstake` — and `rescuePosition`
     *      refuses any tokenId that has a staker record, so the NFT is stranded until an
     *      upgrade. The same is true of this adapter and of the position manager. The vault
     *      does not yet carry that guard; this contract is a NEW deposit route and carries it
     *      from the start, for the addresses it can actually name.
     *
     *      The bonus leg is SKIPPED when `guaranteedBonusAmount` is zero, and that is a
     *      judgment call rather than an oversight: {BonusEscrow-reserve} rejects a zero amount,
     *      so calling it unconditionally would make a bonus-free campaign purchase impossible to
     *      stake at all. A campaign that promises nothing extra is a campaign REAL should still
     *      be able to run through this route, so zero means "no bonus leg", the event still
     *      carries `guaranteedBonusAmount = 0`, and the escrow's book stays free of empty rows.
     *
     *      Step 14 is a belt-and-braces assertion of the two facts the whole call exists to
     *      produce. It cannot fail against the deployed vault — `stakeFor` writes the staker and
     *      pulls custody in the same breath — and that is exactly why it is worth one SLOAD and
     *      one external read: it is what catches a vault, or an adapter configuration, that is
     *      not the one anybody thought it was, before the event says otherwise.
     *
     * @param tokenId The freshly minted position NFT, owned by the calling SoulZap contract.
     * @param authorization What REAL's backend signed about this purchase, see {PurchaseAuthorization}.
     * @param realSignature The backend's EIP-712 signature over `authorization`.
     */
    function depositFor(
        uint256 tokenId,
        PurchaseAuthorization calldata authorization,
        bytes calldata realSignature
    ) external nonReentrant {
        _checkAuthorization(authorization, realSignature);
        uint128 liquidity = _checkPosition(tokenId, authorization);

        consumedPurchaseIds[authorization.purchaseId] = true;
        consumedNonces[authorization.nonce] = true;

        // The canonical position manager's `safeTransferFrom` does call the receipt hook, so
        // the window really is used here — unlike the zapper's mint, where it is defensive.
        _receiveGuard = RECEIVING;
        positionManager.safeTransferFrom(msg.sender, address(this), tokenId);
        _receiveGuard = NOT_RECEIVING;

        // Per-token approval rather than `setApprovalForAll`: the adapter never holds an NFT
        // across transactions, and the vault's pull clears the approval on transfer.
        positionManager.approve(address(vault), tokenId);
        // The vault's own deposit pause reaches the purchase here: a paused vault reverts this
        // call with `DepositsArePaused` and takes the whole SoulZap transaction with it.
        vault.stakeFor(authorization.beneficiary, tokenId);

        if (authorization.guaranteedBonusAmount > 0) {
            escrow.reserve(
                authorization.purchaseId,
                authorization.beneficiary,
                authorization.guaranteedBonusAmount,
                authorization.bonusUnlockAt
            );
        }

        address owner_ = positionManager.ownerOf(tokenId);
        address staker = vault.stakerOf(tokenId);
        if (owner_ != address(vault) || staker != authorization.beneficiary) {
            revert CustodyAssertFailed(tokenId, owner_, staker);
        }

        _emitDeposited(tokenId, liquidity, authorization);
    }

    // ──────────────────────── ERC-721 receiver ─────────────────

    /**
     * @notice ERC-721 receipt hook. Accepts position NFTs only from the configured position
     *         manager and only inside this contract's own deposit.
     * @dev Two gates, the same two {LPZapper} and {LPStakingVault} use. The sender check keeps
     *      foreign ERC-721 collections out; the receipt-window check keeps out safe transfers
     *      of genuine position NFTs pushed in from outside a deposit — which, on this contract,
     *      would be unrecoverable, since it exposes no rescue path (see the contract note).
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
        if (_receiveGuard != RECEIVING) revert UnsolicitedPosition(operator, from, tokenId);
        return IERC721Receiver.onERC721Received.selector;
    }

    // ──────────────────────── Views ────────────────────────────

    /// @notice The EIP-712 digest a backend must sign for `authorization`, on this chain and
    ///         for this adapter.
    /// @dev Exposed so an integrator can check its signing pipeline against the contract
    ///       instead of against a second implementation of the same encoding.
    /// @param authorization The purchase to hash.
    /// @return The digest {depositFor} will recover against.
    function hashPurchaseAuthorization(PurchaseAuthorization calldata authorization)
        external
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(_structHash(authorization));
    }

    // ──────────────────────── Owner functions ──────────────────

    /**
     * @notice Allows or removes one SoulZap caller.
     * @dev Owner tier, the same tier and the same argument as {LPStakingVault-setStakeOperator}:
     *      admitting a caller is a code change in all but name, so it takes the timelock's delay
     *      and is publicly visible before it can run. Removing one urgently does not need this
     *      function — {setDepositsPaused} stops every caller in one guardian transaction.
     *
     *      The zero address is rejected rather than treated as a switch: this is a mapping, and
     *      zero would be a meaningless entry in it. The switch is the pause.
     * @param caller The SoulZap contract to allow or remove.
     * @param allowed True to allow {depositFor}, false to remove the right.
     */
    function setSoulZapCaller(address caller, bool allowed) external onlyOwner {
        if (caller == address(0)) revert ZeroAddress();
        emit SoulZapCallerSet(caller, allowed);
        soulZapCallers[caller] = allowed;
    }

    /**
     * @notice Rotates the fast-path guardian.
     * @dev Owner tier, like the vault's and the distributor's: who holds the undelayed switches
     *      is a slow decision even though what they hold is fast.
     * @param newGuardian The new guardian (the multisig).
     */
    function setGuardian(address newGuardian) external onlyOwner {
        if (newGuardian == address(0)) revert ZeroAddress();
        emit GuardianSet(guardian, newGuardian);
        guardian = newGuardian;
    }

    // ──────────────────────── Guardian functions ───────────────

    /**
     * @notice Rotates the key whose signature authorizes a purchase.
     * @dev Guardian tier, and zero is ALLOWED — both for {RewardsDistributor-setSigner}'s
     *      reason. A leaked signing key is the one incident where waiting out a timelock is
     *      itself the loss: every second of delay is another signature an attacker can mint. So
     *      the multisig rotates it with no delay, and setting it to `address(0)` closes the
     *      deposit path outright, which is the strongest thing this switch can do.
     *
     *      A rotation invalidates every outstanding authorization at once. That is intended:
     *      the old ones are exactly what is being repudiated.
     * @param newSigner The new purchase signer, or `address(0)` to close the path.
     */
    function setPurchaseSigner(address newSigner) external onlyGuardian {
        emit PurchaseSignerSet(purchaseSigner, newSigner);
        purchaseSigner = newSigner;
    }

    /**
     * @notice Stops and restarts ApeBond deposits.
     * @dev Guardian tier, the fast half of the mitigation pair. This switch is narrower than
     *      the vault's on purpose: `LPStakingVault.setDepositsPaused` stops this adapter too,
     *      but it stops ordinary REAL stakers and the zapper with it. This one takes the
     *      ApeBond route out and leaves everything else running.
     *
     *      Nothing else is gated by it. Unstaking is the vault's and needs no permission from
     *      here; the guaranteed bonus is the escrow's and is claimable while this is on (§4.5,
     *      §6.3) — neither path passes through this contract at all.
     * @param paused True to stop deposits, false to resume.
     */
    function setDepositsPaused(bool paused) external onlyGuardian {
        depositsPaused = paused;
        emit DepositsPausedSet(paused);
    }

    // ──────────────────────── Internal helpers ─────────────────

    /// @dev Steps 1–7 of the checklist: everything that can be decided from the authorization,
    ///      the caller and the clock, without reading the NFT.
    function _checkAuthorization(PurchaseAuthorization calldata authorization, bytes calldata realSignature)
        private
        view
    {
        if (depositsPaused) revert DepositsArePaused();
        if (!soulZapCallers[msg.sender]) revert NotSoulZapCaller(msg.sender);
        if (authorization.soulZapCaller != msg.sender) {
            revert CallerMismatch(authorization.soulZapCaller, msg.sender);
        }

        address beneficiary = authorization.beneficiary;
        if (
            beneficiary == address(0) || beneficiary == address(this) || beneficiary == address(vault)
                || beneficiary == address(positionManager)
        ) {
            revert InvalidBeneficiary(beneficiary);
        }

        if (block.timestamp > authorization.deadline) {
            revert AuthorizationExpired(authorization.deadline, block.timestamp);
        }

        // `signer` is read once and compared once. An unset signer needs no check of its own:
        // OZ's `ECDSA.recover` never returns `address(0)` — it reverts on a malformed signature
        // instead — so no signature can ever equal a zero signer, and the path is closed by the
        // same comparison that verifies a real one.
        address signer = purchaseSigner;
        address recovered = ECDSA.recover(_hashTypedDataV4(_structHash(authorization)), realSignature);
        if (recovered != signer) revert InvalidSignature(recovered, signer);

        if (consumedPurchaseIds[authorization.purchaseId]) {
            revert PurchaseAlreadyProcessed(authorization.purchaseId);
        }
        if (consumedNonces[authorization.nonce]) revert NonceAlreadyUsed(authorization.nonce);
    }

    /// @dev Steps 8–9: the NFT is the caller's, reachable by this adapter, and is the position
    ///      the authorization describes. Returns the liquidity for the event.
    function _checkPosition(uint256 tokenId, PurchaseAuthorization calldata authorization)
        private
        view
        returns (uint128 liquidity)
    {
        int24 tickLower;
        int24 tickUpper;
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
        (,, positionToken0, positionToken1, positionFee, tickLower, tickUpper, liquidity,,,,) =
            positionManager.positions(tokenId);

        if (positionToken0 != token0 || positionToken1 != token1 || positionFee != fee) {
            revert PositionPoolMismatch(tokenId, positionToken0, positionToken1, positionFee);
        }
        // EXACT, not "inside": the campaign approved one range and the bonus was priced against
        // it, so a wider or narrower position is a different product, not a better one.
        if (tickLower != authorization.expectedTickLower || tickUpper != authorization.expectedTickUpper) {
            revert TickRangeMismatch(
                tickLower, tickUpper, authorization.expectedTickLower, authorization.expectedTickUpper
            );
        }
        // Two separate facts, and the spec's §10 lists them separately: an empty NFT is a
        // broken mint, a thin one is a mint that missed the campaign's floor. `minLiquidity` may
        // legitimately be zero, so the emptiness check cannot be folded into it.
        if (liquidity == 0) revert EmptyPosition(tokenId);
        if (liquidity < authorization.minLiquidity) {
            revert InsufficientLiquidity(liquidity, authorization.minLiquidity);
        }
    }

    /**
     * @dev The EIP-712 struct hash. Written out field by field, in the struct's declared order,
     *      so it reads against {PURCHASE_AUTHORIZATION_TYPEHASH} line for line.
     *
     *      Split into two halves and concatenated because sixteen 32-byte words in one
     *      `abi.encode` do not fit on the stack under this repo's build (0.8.28, optimizer 200,
     *      no via-IR). The result is byte-identical: every field of {PurchaseAuthorization} is a
     *      static type, so each `abi.encode` here is just its arguments padded to 32 bytes and
     *      laid end to end, and concatenating the two is the same 512 bytes the one-call form
     *      would produce. `test_Digest_MatchesTheReferenceEncoding` recomputes it the long way
     *      and the Hardhat suite recomputes it a third time with `ethers.TypedDataEncoder`.
     */
    function _structHash(PurchaseAuthorization calldata authorization) private pure returns (bytes32) {
        return keccak256(
            bytes.concat(
                abi.encode(
                    PURCHASE_AUTHORIZATION_TYPEHASH,
                    authorization.purchaseId,
                    authorization.campaignId,
                    authorization.soulZapRequestId,
                    authorization.beneficiary,
                    authorization.soulZapCaller,
                    authorization.inputToken,
                    authorization.grossInputAmount
                ),
                abi.encode(
                    authorization.netInputAmount,
                    authorization.guaranteedBonusAmount,
                    authorization.bonusUnlockAt,
                    authorization.minLiquidity,
                    authorization.expectedTickLower,
                    authorization.expectedTickUpper,
                    authorization.nonce,
                    authorization.deadline
                )
            )
        );
    }

    /**
     * @dev Step 15, in a function of its own and with as few parameters as the event allows:
     *      thirteen fields plus the locals they come from do not fit on the stack together
     *      under this repo's build (0.8.28, optimizer 200, no via-IR).
     *
     *      `tickLower` / `tickUpper` are therefore read off the authorization rather than
     *      carried down from {_checkPosition}. That is not a shortcut: step 9 rejects the
     *      deposit unless the position's OWN ticks equal these two exactly, so by the time this
     *      runs the two pairs are the same number twice. The event reports the position's range,
     *      as §9 says it does.
     */
    function _emitDeposited(uint256 tokenId, uint128 liquidity, PurchaseAuthorization calldata authorization)
        private
    {
        emit ApeBondPositionDeposited(
            authorization.purchaseId,
            authorization.campaignId,
            authorization.beneficiary,
            authorization.soulZapRequestId,
            tokenId,
            liquidity,
            authorization.expectedTickLower,
            authorization.expectedTickUpper,
            authorization.inputToken,
            authorization.grossInputAmount,
            authorization.netInputAmount,
            authorization.guaranteedBonusAmount,
            authorization.bonusUnlockAt
        );
    }
}
