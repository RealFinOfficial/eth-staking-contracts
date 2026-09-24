// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LocalHarness} from "../utils/LocalHarness.sol";
import {RewardsDistributor} from "../../../contracts/lp-staking/RewardsDistributor.sol";

/**
 * @notice Bounded actor driving {RewardsDistributor} through both reward legs for four
 *         users, interleaved with the three ways a claim is supposed to be refused: a stale
 *         voucher, a paused contract, and a voucher from a signer that is not the configured
 *         one.
 *
 *  The one action that flips a switch RESTORES it before it returns: `pausedClaimAttempt`
 *  lifts the pause again on its way out, and the foreign-signer attempt never rotates the
 *  configured signer at all — it simply signs with a key the distributor was never told
 *  about. The distributor is therefore always claimable at the end of a call, which is what
 *  lets the anti-vacuity invariant be a hard assertion: every action first primes one
 *  successful claim on each leg, and priming can never be blocked by a switch a previous
 *  action left flipped.
 *
 *  Whether a refusal actually held is not asserted inside the handler (a revert there would
 *  be swallowed by the campaign). It is recorded as a ghost FLAG, and the flags are the
 *  invariants' teeth.
 */
contract ClaimLedgerHandler is Test {
    RewardsDistributor internal immutable distributor;
    address internal immutable distributorOwner;
    uint256 internal immutable signerPk;
    uint256 internal immutable foreignPk;
    bytes32 internal immutable domainSeparator;

    address[] internal actors;

    /// @dev The cumulative figure the handler has signed so far, per actor and per leg.
    mapping(address => uint256) public tokenXEntitlement;
    mapping(address => uint256) public assetEntitlement;
    /// @dev Last ledger value observed, per actor and per leg — the monotonicity witness.
    mapping(address => uint256) internal lastTokenXLedger;
    mapping(address => uint256) internal lastAssetLedger;

    // ──────────────────────── Ghosts ───────────────────────────

    uint256 public calls;
    uint256 public tokenXPaidTotal;
    uint256 public assetPaidTotal;
    /// @notice Set if any ledger was ever observed lower than it had been.
    bool public ledgerEverWentBackwards;
    /// @notice Set if a voucher that had already been spent paid a second time.
    bool public staleVoucherEverPaid;
    /// @notice Set if a claim went through while the contract was paused.
    bool public pausedClaimEverPaid;
    /// @notice Set if a voucher signed by a foreign key was ever honoured.
    bool public foreignVoucherEverPaid;

    uint256 internal constant FAR_DEADLINE = 10 ** 12;
    /// @dev Small enough that a full-depth campaign stays far inside the epoch cap and the
    ///      pre-funded ASSET float; the cap has its own invariant file.
    uint256 internal constant MAX_DELTA = 1e18;

    constructor(
        RewardsDistributor _distributor,
        address _distributorOwner,
        uint256 _signerPk,
        uint256 _foreignPk,
        bytes32 _domainSeparator,
        address[] memory _actors
    ) {
        distributor = _distributor;
        distributorOwner = _distributorOwner;
        signerPk = _signerPk;
        foreignPk = _foreignPk;
        domainSeparator = _domainSeparator;
        actors = _actors;
    }

    // ──────────────────────── Actions ──────────────────────────

    function claimTokenX(uint256 actorSeed, uint256 deltaSeed) external {
        calls++;
        _prime();
        _claimTokenXFor(actors[bound(actorSeed, 0, actors.length - 1)], bound(deltaSeed, 1, MAX_DELTA));
        _observeLedgers();
    }

    function claimAsset(uint256 actorSeed, uint256 deltaSeed) external {
        calls++;
        _prime();
        _claimAssetFor(actors[bound(actorSeed, 0, actors.length - 1)], bound(deltaSeed, 1, MAX_DELTA));
        _observeLedgers();
    }

    /// @dev Re-presents the cumulative figure the actor has already been paid for. The
    ///      strictly-positive-difference rule must refuse it.
    function replayStaleVoucher(uint256 actorSeed) external {
        calls++;
        _prime();

        address actor = actors[bound(actorSeed, 0, actors.length - 1)];
        uint256 cumulative = tokenXEntitlement[actor];
        if (cumulative == 0) return;

        bytes memory sig = _sign(signerPk, distributor.TOKENX_CLAIM_TYPEHASH(), actor, cumulative);
        vm.prank(actor);
        try distributor.claimTokenX(cumulative, FAR_DEADLINE, sig) returns (uint256 paid) {
            if (paid > 0) staleVoucherEverPaid = true;
        } catch {}
        _observeLedgers();
    }

    /// @dev Pauses, tries a perfectly valid fresh voucher, then unpauses again.
    function pausedClaimAttempt(uint256 actorSeed, uint256 deltaSeed) external {
        calls++;
        _prime();

        address actor = actors[bound(actorSeed, 0, actors.length - 1)];
        uint256 cumulative = tokenXEntitlement[actor] + bound(deltaSeed, 1, MAX_DELTA);
        bytes memory sig = _sign(signerPk, distributor.TOKENX_CLAIM_TYPEHASH(), actor, cumulative);

        vm.prank(distributorOwner);
        distributor.setPaused(true);

        vm.prank(actor);
        try distributor.claimTokenX(cumulative, FAR_DEADLINE, sig) {
            pausedClaimEverPaid = true;
            tokenXEntitlement[actor] = cumulative;
        } catch {}

        vm.prank(distributorOwner);
        distributor.setPaused(false);
        _observeLedgers();
    }

    /// @dev A voucher signed by a key the distributor has never been told about.
    function foreignVoucherAttempt(uint256 actorSeed, uint256 deltaSeed) external {
        calls++;
        _prime();

        address actor = actors[bound(actorSeed, 0, actors.length - 1)];
        uint256 cumulative = tokenXEntitlement[actor] + bound(deltaSeed, 1, MAX_DELTA);
        bytes memory sig = _sign(foreignPk, distributor.TOKENX_CLAIM_TYPEHASH(), actor, cumulative);

        vm.prank(actor);
        try distributor.claimTokenX(cumulative, FAR_DEADLINE, sig) {
            foreignVoucherEverPaid = true;
            tokenXEntitlement[actor] = cumulative;
        } catch {}
        _observeLedgers();
    }

    // ──────────────────────── Views for the invariants ─────────

    function actorList() external view returns (address[] memory) {
        return actors;
    }

    // ──────────────────────── Internals ────────────────────────

    /// @dev One guaranteed claim on each leg the first time any action runs, so the
    ///      anti-vacuity invariant does not have to rely on the selector lottery.
    function _prime() private {
        if (tokenXPaidTotal == 0) _claimTokenXFor(actors[0], 1);
        if (assetPaidTotal == 0) _claimAssetFor(actors[0], 1);
    }

    function _claimTokenXFor(address actor, uint256 delta) private {
        uint256 cumulative = tokenXEntitlement[actor] + delta;
        bytes memory sig = _sign(signerPk, distributor.TOKENX_CLAIM_TYPEHASH(), actor, cumulative);

        vm.prank(actor);
        try distributor.claimTokenX(cumulative, FAR_DEADLINE, sig) returns (uint256 paid) {
            tokenXEntitlement[actor] = cumulative;
            tokenXPaidTotal += paid;
        } catch {}
    }

    function _claimAssetFor(address actor, uint256 delta) private {
        uint256 cumulative = assetEntitlement[actor] + delta;
        bytes memory sig = _sign(signerPk, distributor.ASSET_CLAIM_TYPEHASH(), actor, cumulative);

        vm.prank(actor);
        try distributor.claimAsset(cumulative, FAR_DEADLINE, sig) returns (uint256 paid) {
            assetEntitlement[actor] = cumulative;
            assetPaidTotal += paid;
        } catch {}
    }

    /// @dev Records the monotonicity witness after every action.
    function _observeLedgers() private {
        for (uint256 i = 0; i < actors.length; ++i) {
            address actor = actors[i];
            uint256 tokenXLedger = distributor.claimedTokenX(actor);
            uint256 assetLedger = distributor.claimedAsset(actor);
            if (tokenXLedger < lastTokenXLedger[actor] || assetLedger < lastAssetLedger[actor]) {
                ledgerEverWentBackwards = true;
            }
            lastTokenXLedger[actor] = tokenXLedger;
            lastAssetLedger[actor] = assetLedger;
        }
    }

    function _sign(uint256 pk, bytes32 typehash, address user, uint256 cumulativeAmount)
        private
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(typehash, user, cumulativeAmount, FAR_DEADLINE));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
}

/**
 * @notice Why this file exists: the distributor is a ledger, and a ledger's correctness is a
 *         statement about HISTORY, not about any single transaction. Three things must hold
 *         after every possible interleaving of claims and refusals:
 *
 *           * neither cumulative ledger ever moves backwards;
 *           * the TokenX in existence is exactly the sum of the TokenX ledgers — the
 *             distributor is the only minter, so nothing may appear that no claim booked;
 *           * the ASSET that left the pre-funded float is exactly the sum of the ASSET
 *             ledgers, and never more than was funded.
 *
 *  The refusal paths are folded into the same campaign rather than tested apart, because the
 *  interesting failure is not "a paused claim reverts" — the unit suite has that — but "a
 *  refused claim left the ledger consistent anyway".
 */
contract ClaimLedgerInvariantsTest is LocalHarness {
    ClaimLedgerHandler internal handler;

    /// @dev The ASSET float this campaign starts from; the conservation invariant is stated
    ///      against it rather than against a running total.
    uint256 internal assetFundedAtStart;

    function setUp() public {
        _deployLocalStack();
        distributor.setAssetClaimsEnabled(true);
        assetFundedAtStart = asset.balanceOf(address(distributor));

        (, uint256 foreignPk) = makeAddrAndKey("foreignSigner");

        address[] memory actors = new address[](4);
        actors[0] = alice;
        actors[1] = bob;
        actors[2] = carol;
        actors[3] = stranger;

        handler = new ClaimLedgerHandler(
            distributor, address(this), voucherSignerPk, foreignPk, _distributorDomainSeparator(), actors
        );

        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = ClaimLedgerHandler.claimTokenX.selector;
        selectors[1] = ClaimLedgerHandler.claimTokenX.selector; // the hot path, weighted x2
        selectors[2] = ClaimLedgerHandler.claimAsset.selector;
        selectors[3] = ClaimLedgerHandler.claimAsset.selector; // likewise
        selectors[4] = ClaimLedgerHandler.replayStaleVoucher.selector;
        selectors[5] = ClaimLedgerHandler.pausedClaimAttempt.selector;
        selectors[6] = ClaimLedgerHandler.foreignVoucherAttempt.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    // ──────────────────────── The ledgers ──────────────────────

    /// @dev A cumulative ledger that could move backwards would re-open every voucher ever
    ///      signed for that user. Nothing in the contract may ever lower one.
    function invariant_ClaimLedgersAreMonotonic() public view {
        assertFalse(handler.ledgerEverWentBackwards(), "a cumulative claim ledger moved backwards");
    }

    /// @dev The distributor is TokenX's only minter, so every wei in existence must be
    ///      booked against somebody's ledger. A mint the ledger does not know about is
    ///      exactly what a broken claim path would produce.
    function invariant_TokenXSupplyEqualsTheSumOfClaims() public view {
        address[] memory actors = handler.actorList();
        uint256 booked;
        for (uint256 i = 0; i < actors.length; ++i) {
            booked += distributor.claimedTokenX(actors[i]);
        }
        assertEq(tokenX.totalSupply(), booked, "TokenX in existence equals the sum of the TokenX claim ledgers");
    }

    /// @dev The ASSET leg pays out of a pre-funded float, so the float IS the damage cap.
    ///      What left it must equal what the ledgers booked, and can never exceed what was
    ///      funded.
    function invariant_AssetPaidIsExactlyWhatLeftTheFloat() public view {
        address[] memory actors = handler.actorList();
        uint256 booked;
        for (uint256 i = 0; i < actors.length; ++i) {
            booked += distributor.claimedAsset(actors[i]);
        }
        uint256 float_ = asset.balanceOf(address(distributor));
        assertEq(assetFundedAtStart - float_, booked, "ASSET that left the float equals the sum of the ASSET ledgers");
        assertLe(booked, assetFundedAtStart, "the float is the damage cap: no more can be paid than was funded");
    }

    /// @dev None of the three refusal paths may ever pay. Each is a ghost flag rather than an
    ///      assertion inside the handler, because a revert there would be swallowed.
    function invariant_NoRefusedClaimEverPaid() public view {
        assertFalse(handler.staleVoucherEverPaid(), "a voucher that had already been spent paid a second time");
        assertFalse(handler.pausedClaimEverPaid(), "a claim went through while claims were paused");
        assertFalse(handler.foreignVoucherEverPaid(), "a voucher signed by a foreign key was honoured");
    }

    // ──────────────────────── Anti-vacuity ─────────────────────

    /**
     * @dev A precondition, not a property. Every claim above is wrapped in a `try/catch`, so
     *      a handler whose vouchers never verified would leave all four invariants trivially
     *      true — the ledgers would simply stay at zero. Priming makes this a hard assertion:
     *      after any single action, both legs must have paid something.
     */
    function invariant_ClaimLedgerIsActuallyExercised() public view {
        if (handler.calls() == 0) return;
        assertGt(handler.tokenXPaidTotal(), 0, "no TokenX was ever claimed: the ledger invariants are vacuous");
        assertGt(handler.assetPaidTotal(), 0, "no ASSET was ever claimed: the float invariant is vacuous");
    }
}
