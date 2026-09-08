// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LocalHarness} from "../utils/LocalHarness.sol";
import {BonusEscrow} from "../../../contracts/lp-staking/BonusEscrow.sol";
import {BonusEscrowV2Mock} from "../../../contracts/lp-staking/mocks/BonusEscrowV2Mock.sol";
import {LPProxy} from "../../../contracts/lp-staking/deploy/LPProxy.sol";
import {HookToken} from "../utils/attackers/HostileTokens.sol";
import {MockERC20Permit} from "../../../contracts/lp-staking/mocks/MockERC20Permit.sol";
import {ReentrantReceiver} from "../utils/attackers/Receivers.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";

/**
 * @notice Why this file exists: {BonusEscrow} is a promise book with money behind it, and every
 *         claim it makes is an inequality — `available >= amount` at reserve time, `now >=
 *         unlockAt` at claim time, `balance - totalReserved` at recovery time. Each of those has
 *         a boundary a happy-path test steps straight over, and each boundary is one assertion
 *         here. The fuzzed ones (`testFuzz_` prefix, the repo's marker for a fuzzed test) take
 *         the same three inequalities and let the runner pick the numbers.
 *
 *  The escrow is stood up per test rather than pulled out of {LocalHarness}: it shares nothing
 *  with the four LP contracts, and the harness is used only for its actors and its ERC-20.
 */
contract BonusEscrowBranchesTest is LocalHarness {
    BonusEscrow internal escrow;

    /// @dev What the harness funds the escrow with, and the ceiling on every reservation below.
    uint256 internal constant FUNDING = 1_000e18;
    uint256 internal constant BONUS = 100e18;
    uint64 internal constant CLIFF = 1_000_000;

    bytes32 internal constant P1 = keccak256("purchase-1");
    bytes32 internal constant P2 = keccak256("purchase-2");
    bytes32 internal constant UNKNOWN = keccak256("never-happened");

    /// @dev `carol` is the adapter throughout: a plain address the tests can prank, so "only the
    ///      adapter may reserve" is never satisfied by the caller happening to be the owner.
    function setUp() public {
        _deployLocalStack();

        escrow = _deployBonusEscrowProxy(address(asset), address(this), address(0));
        asset.transfer(address(escrow), FUNDING);
        escrow.setAdapter(carol);

        vm.warp(1);
    }

    // ──────────────────────── Implementation constructor ───────

    function test_Constructor_RejectsAZeroBonusToken() public {
        vm.expectRevert(BonusEscrow.ZeroAddress.selector);
        new BonusEscrow(IERC20(address(0)));
    }

    /// @dev A bare implementation must be inert: its initializers are burnt in its own
    ///      constructor, so nobody can take ownership of the code the proxy delegates to.
    function test_Constructor_DisablesTheImplementationsInitializers() public {
        BonusEscrow impl = new BonusEscrow(IERC20(address(asset)));

        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(address(this), address(0));
    }

    // ──────────────────────── Initializer ──────────────────────

    function test_Initialize_RejectsAZeroOwner() public {
        address impl = address(new BonusEscrow(IERC20(address(asset))));

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new LPProxy(impl, abi.encodeCall(BonusEscrow.initialize, (address(0), carol)));
    }

    /// @dev A zero `adapter_` opens the escrow with the reserve path CLOSED and announces it,
    ///      so the `AdapterSet` history is complete from block one rather than starting at the
    ///      first `setAdapter`.
    function test_Initialize_AnnouncesTheClosedReservePath() public {
        address impl = address(new BonusEscrow(IERC20(address(asset))));

        vm.expectEmit(false, false, false, true);
        emit BonusEscrow.AdapterSet(address(0), address(0));
        BonusEscrow fresh =
            BonusEscrow(address(new LPProxy(impl, abi.encodeCall(BonusEscrow.initialize, (bob, address(0))))));

        assertEq(fresh.adapter(), address(0), "a fresh escrow must have no adapter");
        assertEq(fresh.totalReserved(), 0, "and an empty book");
        assertEq(fresh.owner(), bob, "and the owner it was initialised with");
    }

    /**
     * @dev The production path, and the reason `adapter_` is an argument at all. The escrow is
     *      born owned by the TIMELOCK, and {setAdapter} is owner-tier, so a deploying key could
     *      never point it at an adapter afterwards — it has to be named in `initialize`. But the
     *      adapter's constructor needs the escrow's address, so the escrow cannot be told an
     *      address that already exists either.
     *
     *      `scripts/deploy-lp-staking.js` resolves that by PRE-COMPUTING the adapter's CREATE
     *      address from the deployer's nonce (escrow implementation at nonce M, escrow proxy at
     *      M + 1, adapter at M + 2) and asserting the adapter landed there. This reproduces the
     *      same three transactions with `vm.computeCreateAddress`, so the shape the script
     *      depends on is a tested one rather than a scripted one.
     */
    function test_Initialize_CanBeBornPointingAtAPreComputedAdapter() public {
        // Nonce M is the implementation, M + 1 the proxy, M + 2 the "adapter" — here any
        // contract, because `initialize` stores the address without calling it.
        uint256 implNonce = vm.getNonce(address(this));
        address predicted = vm.computeCreateAddress(address(this), implNonce + 2);

        address impl = address(new BonusEscrow(IERC20(address(asset))));

        vm.expectEmit(false, false, false, true);
        emit BonusEscrow.AdapterSet(address(0), predicted);
        BonusEscrow born =
            BonusEscrow(address(new LPProxy(impl, abi.encodeCall(BonusEscrow.initialize, (bob, predicted)))));

        MockERC20Permit landed = new MockERC20Permit("Adapter stand-in", "ADP", 0, 18);
        assertEq(address(landed), predicted, "the third CREATE must land on the predicted address");
        assertEq(born.adapter(), predicted, "and the escrow must have been born pointing at it");
        assertEq(born.owner(), bob, "with the owner it was initialised with, no key in between");

        // The whole point: nobody had to call `setAdapter`, and the reserve path is live for
        // that address and nobody else.
        asset.transfer(address(born), FUNDING);
        vm.prank(predicted);
        born.reserve(P1, alice, BONUS, CLIFF);
        assertEq(born.totalReserved(), BONUS, "the born-in adapter can reserve");
    }

    function test_Initialize_CannotRunTwiceOnTheProxy() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        escrow.initialize(alice, carol);
    }

    /**
     * @dev The book's address, pinned. `BONUS_ESCROW_STORAGE` is a literal in the contract
     *      because it must never move: if it did, `totalReserved` would read zero after an
     *      upgrade and every outstanding bonus would become invisible to {recoverSurplus}'s
     *      floor. This recomputes the ERC-7201 derivation and checks the literal against it,
     *      field by field.
     */
    function test_Storage_LivesAtThePinnedErc7201Slot() public {
        bytes32 expected =
            keccak256(abi.encode(uint256(keccak256("real.lp.storage.BonusEscrow")) - 1)) & ~bytes32(uint256(0xff));

        vm.prank(carol);
        escrow.reserve(P1, alice, BONUS, CLIFF);

        // Namespace slot 0 is `adapter` alone, slot 1 the running total.
        assertEq(address(uint160(uint256(vm.load(address(escrow), expected)))), carol, "slot 0 must be `adapter`");
        assertEq(uint256(vm.load(address(escrow), bytes32(uint256(expected) + 1))), BONUS, "slot 1 must be the total");

        // Slot 2 opens the `reservations` mapping; one entry is two slots, the first packing
        // `beneficiary` with `unlockAt` and `claimed` exactly as the struct declares them.
        bytes32 entry = keccak256(abi.encode(P1, bytes32(uint256(expected) + 2)));
        uint256 packed = uint256(vm.load(address(escrow), entry));
        assertEq(address(uint160(packed)), alice, "the entry must start with `beneficiary`");
        assertEq(uint64(packed >> 160), CLIFF, "`unlockAt` must sit right after `beneficiary`");
        assertEq((packed >> 224) & 0xff, 0, "`claimed` must sit right after `unlockAt`");
        assertEq(uint256(vm.load(address(escrow), bytes32(uint256(entry) + 1))), BONUS, "`amount` must open slot 1");
    }

    // ──────────────────────── setAdapter ───────────────────────

    function test_SetAdapter_AnnouncesBothSidesAndStores() public {
        vm.expectEmit(false, false, false, true, address(escrow));
        emit BonusEscrow.AdapterSet(carol, bob);
        escrow.setAdapter(bob);

        assertEq(escrow.adapter(), bob, "the new adapter must be stored");

        // The old one loses the tier immediately.
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(BonusEscrow.NotAdapter.selector, carol, bob));
        escrow.reserve(P1, alice, BONUS, CLIFF);
    }

    function test_SetAdapter_RejectsEveryoneButTheOwner() public {
        address[2] memory outsiders = [carol, stranger];
        for (uint256 i = 0; i < outsiders.length; ++i) {
            vm.prank(outsiders[i]);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, outsiders[i]));
            escrow.setAdapter(outsiders[i]);
        }
        assertEq(escrow.adapter(), carol, "no outsider may re-point the escrow");
    }

    /// @dev Zero is a legal adapter, and the only wind-down lever this contract has: it closes
    ///      the reserve path without touching a single standing reservation.
    function test_SetAdapter_ZeroClosesTheReservePathAndLeavesTheBookIntact() public {
        vm.prank(carol);
        escrow.reserve(P1, alice, BONUS, CLIFF);

        escrow.setAdapter(address(0));

        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(BonusEscrow.NotAdapter.selector, carol, address(0)));
        escrow.reserve(P2, bob, BONUS, CLIFF);

        assertEq(escrow.totalReserved(), BONUS, "a closed reserve path must not disturb the book");

        vm.warp(CLIFF);
        escrow.claim(P1);
        assertEq(asset.balanceOf(alice), USER_ASSET + BONUS, "and the bonus must still pay");
    }

    // ──────────────────────── reserve ──────────────────────────

    function test_Reserve_RejectsEveryoneButTheAdapter() public {
        // The OWNER is rejected too: reserving is the adapter's job and nobody else's.
        vm.expectRevert(abi.encodeWithSelector(BonusEscrow.NotAdapter.selector, address(this), carol));
        escrow.reserve(P1, alice, BONUS, CLIFF);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(BonusEscrow.NotAdapter.selector, stranger, carol));
        escrow.reserve(P1, alice, BONUS, CLIFF);
    }

    function test_Reserve_RejectsAZeroBeneficiaryAndAZeroAmount() public {
        vm.startPrank(carol);
        vm.expectRevert(BonusEscrow.ZeroAddress.selector);
        escrow.reserve(P1, address(0), BONUS, CLIFF);

        vm.expectRevert(BonusEscrow.ZeroAmount.selector);
        escrow.reserve(P1, alice, 0, CLIFF);
        vm.stopPrank();

        assertEq(escrow.totalReserved(), 0, "a rejected reserve must commit nothing");
    }

    function test_Reserve_SpendsAPurchaseIdExactlyOnce() public {
        vm.startPrank(carol);
        escrow.reserve(P1, alice, BONUS, CLIFF);

        vm.expectRevert(abi.encodeWithSelector(BonusEscrow.DuplicateReservation.selector, P1));
        escrow.reserve(P1, bob, 1, CLIFF);
        vm.stopPrank();

        (address beneficiary,,,) = escrow.reservationOf(P1);
        assertEq(beneficiary, alice, "the first reservation must be the one that stands");
        assertEq(escrow.totalReserved(), BONUS, "and a duplicate must commit nothing");
    }

    /**
     * @dev The gates fire adapter -> beneficiary -> amount -> duplicate -> funding, and the
     *      ordering is not inferable from the four checks in isolation. Each pair below is
     *      hostile on BOTH sides, so the error names which gate won.
     */
    function test_Reserve_GateOrderingIsAdapterFirstAndFundingLast() public {
        // Not the adapter AND a zero beneficiary: the caller gate wins.
        vm.expectRevert(abi.encodeWithSelector(BonusEscrow.NotAdapter.selector, address(this), carol));
        escrow.reserve(P1, address(0), 0, CLIFF);

        vm.startPrank(carol);

        // Zero beneficiary AND zero amount: the address check wins.
        vm.expectRevert(BonusEscrow.ZeroAddress.selector);
        escrow.reserve(P1, address(0), 0, CLIFF);

        // Zero amount AND unfundable: the amount check wins.
        vm.expectRevert(BonusEscrow.ZeroAmount.selector);
        escrow.reserve(P1, alice, 0, CLIFF);

        // Duplicate AND unfundable: the duplicate wins, because an id is spent before money is.
        escrow.reserve(P1, alice, FUNDING, CLIFF);
        vm.expectRevert(abi.encodeWithSelector(BonusEscrow.DuplicateReservation.selector, P1));
        escrow.reserve(P1, alice, FUNDING, CLIFF);

        vm.stopPrank();
    }

    /// @dev `available < amount` — equality is still fundable, one wei past it is not.
    function test_Reserve_TheFundingBoundaryIsExact() public {
        vm.startPrank(carol);

        vm.expectRevert(abi.encodeWithSelector(BonusEscrow.Underfunded.selector, FUNDING, FUNDING + 1));
        escrow.reserve(P1, alice, FUNDING + 1, CLIFF);

        escrow.reserve(P1, alice, FUNDING, CLIFF);
        assertEq(escrow.totalReserved(), FUNDING, "the whole unreserved balance must be reservable");

        // And a fully committed escrow reports nothing available rather than underflowing.
        vm.expectRevert(abi.encodeWithSelector(BonusEscrow.Underfunded.selector, 0, 1));
        escrow.reserve(P2, bob, 1, CLIFF);

        vm.stopPrank();
    }

    /// @dev Two reservations can never be funded by the same wei: the second one measures the
    ///      balance MINUS what the first already committed.
    function test_Reserve_NeverFundsTwoPromisesFromTheSameWei() public {
        vm.startPrank(carol);
        escrow.reserve(P1, alice, FUNDING - 10, CLIFF);

        vm.expectRevert(abi.encodeWithSelector(BonusEscrow.Underfunded.selector, 10, 11));
        escrow.reserve(P2, bob, 11, CLIFF);

        escrow.reserve(P2, bob, 10, CLIFF);
        vm.stopPrank();

        assertEq(escrow.totalReserved(), FUNDING, "the two reservations must sum to the balance");
        assertEq(asset.balanceOf(address(escrow)), FUNDING, "and no money moved on a reserve");
    }

    function test_Reserve_EmitsTheWholeReservation() public {
        vm.expectEmit(true, true, false, true, address(escrow));
        emit BonusEscrow.BonusReserved(P1, alice, BONUS, CLIFF);
        vm.prank(carol);
        escrow.reserve(P1, alice, BONUS, CLIFF);

        (address beneficiary, uint256 amount, uint64 unlockAt, bool claimed) = escrow.reservationOf(P1);
        assertEq(beneficiary, alice, "the beneficiary must be recorded");
        assertEq(amount, BONUS, "the amount must be recorded");
        assertEq(unlockAt, CLIFF, "the cliff must be recorded");
        assertFalse(claimed, "a fresh reservation is unspent");
    }

    /**
     * @dev The invariant the funding check exists for, at any split the runner picks: the sum of
     *      what was accepted never exceeds the balance, and the first rejection is the point
     *      where the remainder stopped covering the ask.
     */
    function testFuzz_Reserve_NeverCommitsMoreThanTheBalance(uint256[4] memory seeds) public {
        vm.startPrank(carol);
        for (uint256 i = 0; i < seeds.length; ++i) {
            uint256 amount = bound(seeds[i], 1, FUNDING);
            uint256 available = FUNDING - escrow.totalReserved();
            bytes32 id = keccak256(abi.encode("fuzz", i));

            if (amount > available) {
                vm.expectRevert(abi.encodeWithSelector(BonusEscrow.Underfunded.selector, available, amount));
                escrow.reserve(id, alice, amount, CLIFF);
            } else {
                escrow.reserve(id, alice, amount, CLIFF);
            }
            assertLe(escrow.totalReserved(), FUNDING, "the book may never exceed the balance");
        }
        vm.stopPrank();
    }

    // ──────────────────────── claim ────────────────────────────

    /// @dev `block.timestamp < unlockAt` — one second short reverts, the cliff itself pays.
    function test_Claim_OneSecondBeforeTheCliffReverts() public {
        _reserve(P1, alice, BONUS, CLIFF);

        vm.warp(CLIFF - 1);
        vm.expectRevert(abi.encodeWithSelector(BonusEscrow.CliffNotReached.selector, CLIFF, CLIFF - 1));
        escrow.claim(P1);
    }

    function test_Claim_PaysAtExactlyTheCliff() public {
        _reserve(P1, alice, BONUS, CLIFF);

        vm.warp(CLIFF);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit BonusEscrow.BonusClaimed(P1, alice, BONUS);
        uint256 paid = escrow.claim(P1);

        assertEq(paid, BONUS, "the call must return what it paid");
        assertEq(asset.balanceOf(alice), USER_ASSET + BONUS, "and the beneficiary must hold it");
        assertEq(escrow.totalReserved(), 0, "and the book must be settled");
        assertEq(asset.balanceOf(address(escrow)), FUNDING - BONUS, "and the escrow must be that much lighter");
    }

    /// @dev Anyone may trigger; only the RECORDED beneficiary is ever paid. The trigger pays the
    ///      gas and receives nothing, which is what makes an open trigger safe.
    function test_Claim_PaysTheRecordedBeneficiaryWhoeverTriggersIt() public {
        _reserve(P1, alice, BONUS, CLIFF);
        vm.warp(CLIFF);

        uint256 strangerBefore = asset.balanceOf(stranger);
        vm.prank(stranger);
        escrow.claim(P1);

        assertEq(asset.balanceOf(alice), USER_ASSET + BONUS, "the beneficiary must be paid");
        assertEq(asset.balanceOf(stranger), strangerBefore, "and the trigger must receive nothing");
    }

    function test_Claim_SpendsAReservationExactlyOnce() public {
        _reserve(P1, alice, BONUS, CLIFF);
        vm.warp(CLIFF);
        escrow.claim(P1);

        vm.expectRevert(abi.encodeWithSelector(BonusEscrow.AlreadyClaimed.selector, P1));
        escrow.claim(P1);

        assertEq(asset.balanceOf(alice), USER_ASSET + BONUS, "a second claim must pay nothing");
    }

    function test_Claim_RejectsAnIdNobodyReserved() public {
        vm.warp(CLIFF);
        vm.expectRevert(abi.encodeWithSelector(BonusEscrow.UnknownReservation.selector, UNKNOWN));
        escrow.claim(UNKNOWN);
    }

    /// @dev Inside `claim` the order is existence -> spent -> cliff. An unknown id at a
    ///      timestamp before every cliff must therefore still report the unknown id.
    function test_Claim_UnknownBeatsTheCliffCheck() public {
        vm.warp(1);
        vm.expectRevert(abi.encodeWithSelector(BonusEscrow.UnknownReservation.selector, UNKNOWN));
        escrow.claim(UNKNOWN);
    }

    function test_Claim_LeavesEveryOtherReservationAlone() public {
        _reserve(P1, alice, BONUS, CLIFF);
        _reserve(P2, bob, 2 * BONUS, CLIFF + 1);

        vm.warp(CLIFF);
        escrow.claim(P1);

        assertEq(escrow.totalReserved(), 2 * BONUS, "only the claimed bonus may leave the book");
        assertEq(escrow.claimable(P2), 0, "and a later cliff is still a cliff");
        assertEq(asset.balanceOf(bob), USER_ASSET, "and its beneficiary has been paid nothing");
    }

    /**
     * @dev The ordering claim, measured rather than argued: the beneficiary is a callback
     *      contract that asks the escrow what is still claimable WHILE the payout transfer is in
     *      flight. It reads zero, which can only be true if `claimed` was set and `totalReserved`
     *      decremented before the token moved.
     */
    function test_Claim_MarksTheReservationSpentBeforeTheTransfer() public {
        (BonusEscrow hooked, HookToken hookToken, ReentrantReceiver receiver) = _hookedEscrow();

        vm.prank(carol);
        hooked.reserve(P1, address(receiver), BONUS, CLIFF);
        receiver.configure(address(hooked), abi.encodeCall(BonusEscrow.claimable, (P1)));

        vm.warp(CLIFF);
        hooked.claim(P1);

        assertEq(receiver.attempts(), 1, "the hook must really have fired inside the payout");
        assertTrue(receiver.lastReenterSucceeded(), "a read is allowed to succeed mid-payout");
        assertEq(abi.decode(receiver.lastReturnData(), (uint256)), 0, "the reservation must already read as spent");
        assertEq(hookToken.balanceOf(address(receiver)), BONUS, "and the payout must still land");
    }

    /// @dev The same window, with a WRITE aimed at it: a second reservation the receiver tries
    ///      to claim from inside the first payout. The guard rejects it, and the outer claim
    ///      finishes — the attacker records the rejection rather than bubbling it.
    function test_Claim_CannotBeReenteredThroughACallbackToken() public {
        (BonusEscrow hooked,, ReentrantReceiver receiver) = _hookedEscrow();

        vm.startPrank(carol);
        hooked.reserve(P1, address(receiver), BONUS, CLIFF);
        hooked.reserve(P2, address(receiver), BONUS, CLIFF);
        vm.stopPrank();

        receiver.configure(address(hooked), abi.encodeCall(BonusEscrow.claim, (P2)));

        vm.warp(CLIFF);
        hooked.claim(P1);

        assertEq(receiver.attempts(), 1, "the re-entrant call must have been attempted");
        assertFalse(receiver.lastReenterSucceeded(), "and rejected");
        assertEq(
            bytes4(receiver.lastReturnData()),
            ReentrancyGuard.ReentrancyGuardReentrantCall.selector,
            "the guard is what rejected it"
        );
        assertEq(hooked.totalReserved(), BONUS, "the second bonus must still be owed");
        assertEq(hooked.claimable(P2), BONUS, "and still claimable outside the window");
    }

    function testFuzz_Claim_PaysExactlyWhatWasReserved(uint256 amountSeed) public {
        uint256 amount = bound(amountSeed, 1, FUNDING);
        _reserve(P1, alice, amount, CLIFF);

        vm.warp(CLIFF);
        uint256 paid = escrow.claim(P1);

        assertEq(paid, amount, "the payout is the reservation, whatever its size");
        assertEq(asset.balanceOf(alice), USER_ASSET + amount, "and it lands on the beneficiary");
        assertEq(escrow.totalReserved(), 0, "and the book comes back to zero");
    }

    /// @dev The cliff comparison at any pair of timestamps the runner picks: strictly before is
    ///      a revert, at or after is a payout. There is no third case.
    function testFuzz_Claim_TheCliffBoundaryHoldsAtAnyTimestamp(uint64 cliffSeed, uint64 nowSeed) public {
        uint64 cliff = uint64(bound(cliffSeed, 2, type(uint32).max));
        uint256 nowTs = bound(nowSeed, 1, type(uint32).max);

        _reserve(P1, alice, BONUS, cliff);
        vm.warp(nowTs);

        if (nowTs < cliff) {
            vm.expectRevert(abi.encodeWithSelector(BonusEscrow.CliffNotReached.selector, cliff, nowTs));
            escrow.claim(P1);
            assertEq(escrow.claimable(P1), 0, "a locked bonus reads as unclaimable");
        } else {
            assertEq(escrow.claimable(P1), BONUS, "an unlocked bonus reads as claimable");
            assertEq(escrow.claim(P1), BONUS, "and pays");
        }
    }

    // ──────────────────────── claimable ────────────────────────

    function test_Claimable_IsZeroForAnUnknownIdAndForASpentOne() public {
        assertEq(escrow.claimable(UNKNOWN), 0, "an id nobody reserved is worth nothing");

        _reserve(P1, alice, BONUS, CLIFF);
        vm.warp(CLIFF);
        assertEq(escrow.claimable(P1), BONUS, "an unlocked reservation is worth its amount");

        escrow.claim(P1);
        assertEq(escrow.claimable(P1), 0, "and nothing once it has been paid");
    }

    // ──────────────────────── recoverSurplus ───────────────────

    function test_RecoverSurplus_MovesExactlyTheUnreservedBalance() public {
        _reserve(P1, alice, BONUS, CLIFF);

        vm.expectEmit(false, false, false, true, address(escrow));
        emit BonusEscrow.SurplusRecovered(bob, FUNDING - BONUS);
        escrow.recoverSurplus(bob);

        assertEq(asset.balanceOf(bob), USER_ASSET + FUNDING - BONUS, "the surplus must land on `to`");
        assertEq(asset.balanceOf(address(escrow)), BONUS, "and exactly the reserved amount must stay");
    }

    /// @dev The floor is arithmetic, not policy: once everything is reserved there is nothing an
    ///      owner can take, and the bonus still pays in full afterwards.
    function test_RecoverSurplus_CannotReachAReservedWei() public {
        _reserve(P1, alice, BONUS, CLIFF);
        escrow.recoverSurplus(bob);

        vm.expectRevert(BonusEscrow.NoSurplus.selector);
        escrow.recoverSurplus(bob);

        vm.warp(CLIFF);
        escrow.claim(P1);
        assertEq(asset.balanceOf(alice), USER_ASSET + BONUS, "the bonus must pay in full after a sweep");
        assertEq(asset.balanceOf(address(escrow)), 0, "and the escrow ends empty");
    }

    function test_RecoverSurplus_RejectsAZeroDestinationAndEveryoneButTheOwner() public {
        vm.expectRevert(BonusEscrow.ZeroAddress.selector);
        escrow.recoverSurplus(address(0));

        address[2] memory outsiders = [carol, stranger];
        for (uint256 i = 0; i < outsiders.length; ++i) {
            vm.prank(outsiders[i]);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, outsiders[i]));
            escrow.recoverSurplus(outsiders[i]);
        }

        assertEq(asset.balanceOf(address(escrow)), FUNDING, "nothing may have moved");
    }

    /// @dev At any split of the balance, what the owner may take is exactly what nobody is owed.
    function testFuzz_RecoverSurplus_LeavesExactlyTotalReserved(uint256 amountSeed) public {
        uint256 amount = bound(amountSeed, 1, FUNDING);
        _reserve(P1, alice, amount, CLIFF);

        if (amount == FUNDING) {
            vm.expectRevert(BonusEscrow.NoSurplus.selector);
            escrow.recoverSurplus(bob);
        } else {
            escrow.recoverSurplus(bob);
            assertEq(asset.balanceOf(bob), USER_ASSET + FUNDING - amount, "the surplus is the whole remainder");
        }
        assertEq(asset.balanceOf(address(escrow)), escrow.totalReserved(), "what is left is exactly what is owed");
    }

    // ──────────────────────── Ownership ────────────────────────

    /**
     * @dev Renouncing is disabled outright. Under a UUPS proxy an ownerless contract can never be
     *      upgraded again — and here it would also freeze {setAdapter}, which is the only lever
     *      that can retire a compromised adapter.
     */
    function test_RenounceOwnership_IsDisabled() public {
        vm.expectRevert(BonusEscrow.RenounceDisabled.selector);
        escrow.renounceOwnership();

        assertEq(escrow.owner(), address(this), "the owner must be exactly where it was");

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        escrow.renounceOwnership();
    }

    // ──────────────────────── Upgrades ─────────────────────────

    /// @dev The reason the proxy exists: the book of obligations must survive a code change.
    function test_Upgrade_PreservesTheBookAndTheRoles() public {
        _reserve(P1, alice, BONUS, CLIFF);
        _reserve(P2, bob, 2 * BONUS, CLIFF);

        address v2 = address(new BonusEscrowV2Mock(IERC20(address(asset))));
        escrow.upgradeToAndCall(v2, "");

        assertEq(_implementationOf(address(escrow)), v2, "the ERC-1967 slot must name the new code");
        assertEq(BonusEscrowV2Mock(address(escrow)).version(), 2, "the new code must be the one running");
        assertEq(escrow.totalReserved(), 3 * BONUS, "the running total must survive the upgrade");
        assertEq(escrow.adapter(), carol, "the adapter must survive the upgrade");
        assertEq(escrow.owner(), address(this), "the owner must survive the upgrade");
        assertEq(address(escrow.bonusToken()), address(asset), "and the immutable is still the same token");

        (address beneficiary, uint256 amount, uint64 unlockAt, bool claimed) = escrow.reservationOf(P1);
        assertEq(beneficiary, alice, "the reservation must survive the upgrade");
        assertEq(amount, BONUS, "the reservation must survive the upgrade");
        assertEq(unlockAt, CLIFF, "the reservation must survive the upgrade");
        assertFalse(claimed, "and must still be unspent");

        // ...and it is still payable through the new code.
        vm.warp(CLIFF);
        assertEq(escrow.claim(P1), BONUS, "the obligation must pay after the upgrade");
    }

    /// @dev V2 writes its own ERC-7201 namespace, so new state cannot collide with V1's.
    function test_Upgrade_V2StateLivesInItsOwnNamespace() public {
        _reserve(P1, alice, BONUS, CLIFF);

        address v2 = address(new BonusEscrowV2Mock(IERC20(address(asset))));
        escrow.upgradeToAndCall(v2, abi.encodeCall(BonusEscrowV2Mock.initializeV2, (42)));

        BonusEscrowV2Mock upgraded = BonusEscrowV2Mock(address(escrow));
        assertEq(upgraded.upgradeMarker(), 42, "V2 state must be readable");
        assertEq(escrow.totalReserved(), BONUS, "and must not have touched V1's namespace");
        assertEq(escrow.adapter(), carol, "and must not have touched V1's namespace");
    }

    function test_Upgrade_RejectsEveryoneButTheOwner() public {
        address v2 = address(new BonusEscrowV2Mock(IERC20(address(asset))));

        address[2] memory outsiders = [carol, alice];
        for (uint256 i = 0; i < outsiders.length; ++i) {
            vm.prank(outsiders[i]);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, outsiders[i]));
            escrow.upgradeToAndCall(v2, "");
        }

        escrow.upgradeToAndCall(v2, "");
        assertEq(_implementationOf(address(escrow)), v2, "the owner must be able to upgrade");
    }

    // ──────────────────────── Helpers ──────────────────────────

    function _reserve(bytes32 purchaseId, address beneficiary, uint256 amount, uint64 unlockAt) private {
        vm.prank(carol);
        escrow.reserve(purchaseId, beneficiary, amount, unlockAt);
    }

    /// @dev A second escrow paid in a callback token, with a contract beneficiary that re-enters
    ///      on receipt. The token, not the escrow, is what opens the window.
    function _hookedEscrow() private returns (BonusEscrow hooked, HookToken hookToken, ReentrantReceiver receiver) {
        hookToken = new HookToken("Hook Bonus", "hBONUS", 18);
        hooked = _deployBonusEscrowProxy(address(hookToken), address(this), address(0));
        hookToken.mint(address(hooked), FUNDING);
        hooked.setAdapter(carol);

        receiver = new ReentrantReceiver();
        hookToken.setHooked(address(receiver), true);
    }

    /// @dev Reads the ERC-1967 implementation slot straight off the proxy.
    function _implementationOf(address proxy) private view returns (address) {
        return address(uint160(uint256(vm.load(proxy, ERC1967Utils.IMPLEMENTATION_SLOT))));
    }
}
