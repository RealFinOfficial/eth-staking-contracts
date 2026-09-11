// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LocalHarness} from "../utils/LocalHarness.sol";

/**
 * @notice Why this file exists: the epoch cap is the token's last line of defence — the one
 *         number a broken or captured distributor cannot talk its way past. Its arithmetic is
 *         deliberately a SUBTRACTION with a zero fallback (`cap > minted ? cap - minted : 0`)
 *         rather than `minted + amount > cap`, so a cap lowered below an existing tally
 *         behaves and does not panic. That choice, plus the lazy rollover that fires inside
 *         `mint` itself, is what these properties fence in.
 *
 *  The minter here is the test contract, not the distributor: the properties are about the
 *  cap, and driving `mint` directly removes the voucher machinery from the picture. Production
 *  wires the distributor, which the fork tier exercises end to end.
 */
contract EpochCapFuzzTest is LocalHarness {
    /// @dev Wide enough that a sequence of four mints can both fit and overflow the cap.
    uint256 internal constant MAX_CAP = 1e24;

    function setUp() public {
        _deployLocalStack();
        tokenX.setMinter(address(this));
    }

    // ──────────────────────── The cap itself ───────────────────

    /**
     * @dev The tally never exceeds the armed cap, for any sequence of mints of any sizes —
     *      including the ones that revert. A mint that fails must leave nothing behind.
     */
    function testFuzz_EpochCap_MintedNeverExceedsTheCap(uint256 capSeed, uint256[4] memory amountSeeds) public {
        uint256 cap = bound(capSeed, 0, MAX_CAP);
        tokenX.setEpochCap(EPOCH_ONE, cap);

        for (uint256 i = 0; i < amountSeeds.length; ++i) {
            uint256 amount = bound(amountSeeds[i], 0, MAX_CAP);
            try tokenX.mint(alice, amount) {} catch {}

            assertLe(tokenX.mintedInEpoch(EPOCH_ONE), cap, "the epoch tally never exceeds the armed cap");
            assertEq(tokenX.totalSupply(), tokenX.mintedInEpoch(EPOCH_ONE), "supply equals the tally of the one epoch");
        }
    }

    /**
     * @dev A mint is all-or-nothing against the headroom: it succeeds exactly when
     *      `amount <= cap - minted` (with a zero floor), and a refused mint moves neither the
     *      tally nor the supply. The `<=` is the assertion — a mint that exactly fills the
     *      remaining headroom must go through.
     */
    function testFuzz_EpochCap_MintIsAllOrNothingAgainstHeadroom(
        uint256 capSeed,
        uint256 preMintSeed,
        uint256 amountSeed
    ) public {
        uint256 cap = bound(capSeed, 1, MAX_CAP);
        uint256 preMint = bound(preMintSeed, 1, cap);
        uint256 amount = bound(amountSeed, 0, MAX_CAP);

        tokenX.setEpochCap(EPOCH_ONE, cap);
        tokenX.mint(alice, preMint);

        uint256 headroom = cap - preMint;
        uint256 supplyBefore = tokenX.totalSupply();

        bool minted;
        try tokenX.mint(alice, amount) {
            minted = true;
        } catch {}

        assertEq(minted, amount > 0 && amount <= headroom, "a mint succeeds exactly when it fits the headroom");
        if (minted) {
            assertEq(tokenX.totalSupply(), supplyBefore + amount, "a successful mint moves supply by exactly amount");
            assertEq(tokenX.mintedInEpoch(EPOCH_ONE), preMint + amount, "and moves the tally by the same amount");
        } else {
            assertEq(tokenX.totalSupply(), supplyBefore, "a refused mint must move no supply at all");
            assertEq(tokenX.mintedInEpoch(EPOCH_ONE), preMint, "and must leave the tally untouched");
        }
    }

    /**
     * @dev A cap lowered BELOW the amount already minted is legal and simply freezes the
     *      epoch: headroom floors at zero rather than underflowing, so every further mint is
     *      refused with the typed error instead of a panic.
     */
    function testFuzz_EpochCap_LoweringTheCapBelowTheTallyFreezesTheEpoch(uint256 capSeed, uint256 lowerSeed) public {
        uint256 cap = bound(capSeed, 2, MAX_CAP);
        uint256 lowered = bound(lowerSeed, 0, cap - 1);

        tokenX.setEpochCap(EPOCH_ONE, cap);
        tokenX.mint(alice, cap);
        tokenX.setEpochCap(EPOCH_ONE, lowered);

        assertEq(tokenX.mintedInEpoch(EPOCH_ONE), cap, "lowering the cap never rewrites what was already minted");

        vm.expectRevert();
        tokenX.mint(alice, 1);
        assertEq(tokenX.totalSupply(), cap, "and no further wei can be minted in the frozen epoch");
    }

    // ──────────────────────── Rollover ─────────────────────────

    /**
     * @dev A scheduled rollover charges the NEW epoch and leaves the old tally standing.
     *      Tallies are per epoch id and are never reset, so the two buckets always sum to the
     *      total supply however the boundary falls relative to the mints.
     */
    function testFuzz_EpochCap_ARolloverChargesTheNewEpochAndKeepsTheOldTally(
        uint256 firstCapSeed,
        uint256 secondCapSeed,
        uint256 firstMintSeed,
        uint256 secondMintSeed,
        uint256 delaySeed
    ) public {
        uint256 firstCap = bound(firstCapSeed, 1, MAX_CAP);
        uint256 secondCap = bound(secondCapSeed, 1, MAX_CAP);
        uint256 firstMint = bound(firstMintSeed, 1, firstCap);
        uint256 secondMint = bound(secondMintSeed, 1, secondCap);
        uint256 delay = bound(delaySeed, 1, 30 days);

        tokenX.setEpochCap(EPOCH_ONE, firstCap);
        tokenX.mint(alice, firstMint);

        uint64 activatesAt = uint64(block.timestamp + delay);
        tokenX.armNextEpoch(EPOCH_ONE + 1, secondCap, activatesAt);

        // Before the boundary the pending epoch is invisible to `mint`.
        (uint256 effectiveBefore,) = tokenX.effectiveEpoch();
        assertEq(effectiveBefore, EPOCH_ONE, "a pending epoch must not be charged before its activation time");

        vm.warp(activatesAt);
        tokenX.mint(bob, secondMint);

        assertEq(tokenX.currentEpochId(), EPOCH_ONE + 1, "the first mint past the boundary rolls the epoch in");
        assertEq(tokenX.mintedInEpoch(EPOCH_ONE), firstMint, "the old epoch keeps its tally after the rollover");
        assertEq(tokenX.mintedInEpoch(EPOCH_ONE + 1), secondMint, "the new epoch is charged only what came after");
        assertLe(tokenX.mintedInEpoch(EPOCH_ONE + 1), secondCap, "and never exceeds its own cap");
        assertEq(
            tokenX.totalSupply(),
            tokenX.mintedInEpoch(EPOCH_ONE) + tokenX.mintedInEpoch(EPOCH_ONE + 1),
            "total supply is exactly the sum of the per-epoch tallies"
        );
    }

    /**
     * @dev Re-selecting an epoch id that already carries a tally RESUMES that tally rather
     *      than resetting it, so rotating ids can never be used to mint the same cap twice.
     */
    function testFuzz_EpochCap_ReselectingAnOldEpochResumesItsTally(uint256 capSeed, uint256 firstMintSeed) public {
        uint256 cap = bound(capSeed, 2, MAX_CAP);
        uint256 firstMint = bound(firstMintSeed, 1, cap - 1);

        tokenX.setEpochCap(EPOCH_ONE, cap);
        tokenX.mint(alice, firstMint);

        tokenX.setEpochCap(EPOCH_ONE + 1, cap);
        tokenX.mint(bob, cap);

        // Back to the first epoch, with the SAME cap: only its unused headroom is left.
        tokenX.setEpochCap(EPOCH_ONE, cap);
        assertEq(tokenX.mintedInEpoch(EPOCH_ONE), firstMint, "re-selecting an epoch id keeps its earlier tally");

        vm.expectRevert();
        tokenX.mint(alice, cap - firstMint + 1);

        tokenX.mint(alice, cap - firstMint);
        assertEq(tokenX.mintedInEpoch(EPOCH_ONE), cap, "the resumed epoch fills to its cap and no further");
    }
}
