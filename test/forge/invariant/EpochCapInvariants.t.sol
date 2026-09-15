// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LocalHarness} from "../utils/LocalHarness.sol";
import {TokenX} from "../../../contracts/lp-staking/TokenX.sol";

/**
 * @notice Bounded actor driving {TokenX}'s epoch machinery: mints, scheduled arming, cancels,
 *         cap raises and time warps, in any order.
 *
 *  Two deliberate restrictions, each of which would otherwise contradict an invariant below
 *  rather than test it:
 *
 *    * caps are only ever RAISED. Lowering a cap under an existing tally is legal and simply
 *      freezes the epoch — pinned by `testFuzz_EpochCap_LoweringTheCapBelowTheTallyFreezesTheEpoch`
 *      — but it makes `mintedInEpoch <= epochCap` false by design, so it has no place in a
 *      campaign whose whole point is that ceiling.
 *    * epoch ids only ever move FORWARD. Re-selecting an older id is legal and resumes that
 *      id's tally — pinned by `testFuzz_EpochCap_ReselectingAnOldEpochResumesItsTally` — and
 *      would likewise falsify the monotonicity statement rather than test it.
 *
 *  The handler is the minter, so `mint` is driven directly: the subject is the cap, not the
 *  voucher machinery that normally sits in front of it.
 */
contract EpochCapHandler is Test {
    TokenX internal immutable tokenX;
    address internal immutable tokenXOwner;

    address[] internal actors;

    /// @notice Every epoch id this campaign has ever selected, in selection order.
    uint256[] internal touched;
    mapping(uint256 => bool) internal isTouched;

    // ──────────────────────── Ghosts ───────────────────────────

    uint256 public calls;
    uint256 public mints;
    /// @notice Scheduled rollovers that actually fired inside a mint.
    uint256 public activations;
    uint256 public arms;
    uint256 public cancels;
    /// @notice Set if `currentEpochId` was ever observed lower than it had been.
    bool public epochIdEverWentBackwards;

    /// @dev Next id the handler will arm. Strictly increasing — see the header.
    uint256 internal nextEpochId = 2;
    uint256 internal lastSeenEpochId;

    uint256 internal constant MAX_CAP = 1e24;
    uint256 internal constant MAX_MINT = 1e18;

    constructor(TokenX _tokenX, address _tokenXOwner, address[] memory _actors) {
        tokenX = _tokenX;
        tokenXOwner = _tokenXOwner;
        actors = _actors;
        touched.push(1); // {LocalHarness} arms epoch 1 at deploy time.
        isTouched[1] = true;
        lastSeenEpochId = 1;
    }

    // ──────────────────────── Actions ──────────────────────────

    function mintSome(uint256 actorSeed, uint256 amountSeed) external {
        calls++;
        _prime();
        _mint(actors[bound(actorSeed, 0, actors.length - 1)], bound(amountSeed, 1, MAX_MINT));
        _observe();
    }

    /// @dev Parks the next scheduled epoch. Overwrites any earlier arming, which is the
    ///      contract's own rescheduling mechanism.
    function armNext(uint256 capSeed, uint256 delaySeed) external {
        calls++;
        _prime();

        uint256 epochId = nextEpochId++;
        uint256 cap = bound(capSeed, 0, MAX_CAP);
        uint64 activatesAt = uint64(block.timestamp + bound(delaySeed, 1, 7 days));

        vm.prank(tokenXOwner);
        try tokenX.armNextEpoch(epochId, cap, activatesAt) {
            arms++;
            _touch(epochId);
        } catch {}
        _observe();
    }

    function cancelNext() external {
        calls++;
        _prime();

        vm.prank(tokenXOwner);
        try tokenX.cancelNextEpoch() {
            cancels++;
        } catch {}
        _observe();
    }

    /// @dev Raising the cap of the RUNNING epoch — the mid-epoch lever. Never lowers it.
    function raiseCap(uint256 capSeed) external {
        calls++;
        _prime();

        uint256 epochId = tokenX.currentEpochId();
        uint256 current = tokenX.epochCap(epochId);
        uint256 raised = bound(capSeed, current, MAX_CAP);

        vm.prank(tokenXOwner);
        try tokenX.setEpochCap(epochId, raised) {
            _touch(epochId);
        } catch {}
        _observe();
    }

    function warpForward(uint256 secondsSeed) external {
        calls++;
        _prime();
        vm.warp(block.timestamp + bound(secondsSeed, 1, 3 days));
        _observe();
    }

    // ──────────────────────── Views for the invariants ─────────

    function touchedEpochs() external view returns (uint256[] memory) {
        return touched;
    }

    // ──────────────────────── Internals ────────────────────────

    /**
     * @dev Makes both anti-vacuity assertions hard rather than probabilistic: the first
     *      action of any sequence mints once, and then arms a scheduled epoch one second out,
     *      warps past it and mints again — which is the only way a rollover can fire.
     */
    function _prime() private {
        if (mints == 0) _mint(actors[0], 1);
        if (activations == 0) {
            uint256 epochId = nextEpochId++;
            vm.prank(tokenXOwner);
            tokenX.armNextEpoch(epochId, MAX_CAP, uint64(block.timestamp + 1));
            arms++;
            _touch(epochId);
            vm.warp(block.timestamp + 2);
            _mint(actors[0], 1);
        }
    }

    function _mint(address to, uint256 amount) private {
        uint256 epochBefore = tokenX.currentEpochId();
        try tokenX.mint(to, amount) {
            mints++;
            uint256 epochAfter = tokenX.currentEpochId();
            if (epochAfter != epochBefore) activations++;
            _touch(epochAfter);
        } catch {}
    }

    function _touch(uint256 epochId) private {
        if (!isTouched[epochId]) {
            isTouched[epochId] = true;
            touched.push(epochId);
        }
    }

    function _observe() private {
        uint256 epochId = tokenX.currentEpochId();
        if (epochId < lastSeenEpochId) epochIdEverWentBackwards = true;
        lastSeenEpochId = epochId;
    }
}

/**
 * @notice Why this file exists: the epoch cap is defence in depth — the number a broken or
 *         captured distributor cannot argue its way past — and it is enforced across a lazy
 *         state machine that rolls over INSIDE a mint. Its correctness is therefore a
 *         property of sequences, not of single calls:
 *
 *           * no epoch's tally ever exceeds the cap armed for it;
 *           * the running epoch id only ever moves forward under forward-only arming;
 *           * the tokens in existence are exactly the sum of the per-epoch tallies, so no
 *             mint can escape being charged to some epoch.
 *
 *  The third is what a rollover bug would break: a mint that rolled the epoch in but charged
 *  the old bucket, or charged neither, would leave supply and tallies disagreeing.
 */
contract EpochCapInvariantsTest is LocalHarness {
    EpochCapHandler internal handler;

    function setUp() public {
        _deployLocalStack();

        address[] memory actors = new address[](4);
        actors[0] = alice;
        actors[1] = bob;
        actors[2] = carol;
        actors[3] = stranger;

        handler = new EpochCapHandler(tokenX, address(this), actors);
        tokenX.setMinter(address(handler));

        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = EpochCapHandler.mintSome.selector;
        selectors[1] = EpochCapHandler.mintSome.selector; // the hot path, weighted x3
        selectors[2] = EpochCapHandler.mintSome.selector;
        selectors[3] = EpochCapHandler.armNext.selector;
        selectors[4] = EpochCapHandler.warpForward.selector;
        selectors[5] = EpochCapHandler.warpForward.selector; // time must move for a rollover
        selectors[6] = EpochCapHandler.raiseCap.selector;
        selectors[7] = EpochCapHandler.cancelNext.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    // ──────────────────────── The ceiling ──────────────────────

    /// @dev The cap is a ceiling on the TALLY, not on a single mint, and it holds for every
    ///      epoch the campaign ever selected — including ones it rolled away from.
    function invariant_MintedNeverExceedsTheCapInAnyEpoch() public view {
        uint256[] memory epochs = handler.touchedEpochs();
        for (uint256 i = 0; i < epochs.length; ++i) {
            assertLe(
                tokenX.mintedInEpoch(epochs[i]),
                tokenX.epochCap(epochs[i]),
                "an epoch's tally never exceeds the cap armed for it"
            );
        }
    }

    /// @dev Under forward-only arming the running epoch id never regresses, so a scheduled
    ///      rollover can never resurrect an epoch whose headroom was already spent.
    function invariant_EpochIdsOnlyMoveForward() public view {
        assertFalse(handler.epochIdEverWentBackwards(), "the running epoch id moved backwards");
    }

    /// @dev Every minted wei is charged to exactly one epoch: supply and the sum of the
    ///      per-epoch tallies can never drift apart, however the rollovers fall.
    function invariant_TotalSupplyIsTheSumOfEveryEpochTally() public view {
        uint256[] memory epochs = handler.touchedEpochs();
        uint256 tallied;
        for (uint256 i = 0; i < epochs.length; ++i) {
            tallied += tokenX.mintedInEpoch(epochs[i]);
        }
        assertEq(tokenX.totalSupply(), tallied, "total supply is exactly the sum of the per-epoch tallies");
    }

    // ──────────────────────── Anti-vacuity ─────────────────────

    /**
     * @dev A precondition, not a property. Every mint above is wrapped in a `try/catch`, so a
     *      campaign in which the cap refused everything would satisfy all three invariants at
     *      zero. The handler primes both a mint and a scheduled activation on its first call,
     *      which is what makes these hard assertions.
     */
    function invariant_EpochMachineryIsActuallyExercised() public view {
        if (handler.calls() == 0) return;
        assertGt(handler.mints(), 0, "nothing was ever minted: the cap invariants are vacuous");
        assertGt(handler.activations(), 0, "no scheduled epoch ever rolled in: the lazy rollover is untested");
    }
}
