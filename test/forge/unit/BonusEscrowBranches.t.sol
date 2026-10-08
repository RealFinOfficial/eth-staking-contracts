// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ApeBondHarness} from "../utils/ApeBondHarness.sol";
import {BonusEscrow} from "../../../contracts/lp-staking/BonusEscrow.sol";
import {BonusEscrowV2Mock} from "../../../contracts/lp-staking/mocks/BonusEscrowV2Mock.sol";
import {LPProxy} from "../../../contracts/lp-staking/deploy/LPProxy.sol";
import {IBonusEscrowHooks} from "../../../contracts/lp-staking/interfaces/IBonusEscrowHooks.sol";
import {PositionValue} from "../../../contracts/lp-staking/libraries/PositionValue.sol";
import {TickMath} from "../../../contracts/lp-staking/libraries/TickMath.sol";
import {HookToken} from "../utils/attackers/HostileTokens.sol";
import {ReentrantReceiver} from "../utils/attackers/Receivers.sol";
import {MisreportingVault} from "../utils/attackers/MisreportingVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @notice Why this file exists: {BonusEscrow} is a book of conditional promises. Every claim it
 *         makes is either an inequality — `now < unlockAt` decides whether a reservation is still
 *         ACTIVE, `balance >= amount` decides whether a claim pays, `balance > totalReserved`
 *         decides whether anything is surplus — or a rule about who may write — only the adapter
 *         reserves, only the vault reports. Each boundary and each gate is one assertion here.
 *
 *  The book under test (`book`) is a fresh escrow on the local vault with `carol` as its adapter
 *  and NO balance: since the 2026-10-05 override (O2) a reservation needs none, and every test
 *  that pays funds the escrow itself. The two vault notifications are called directly, pranked
 *  as the vault, with hand-built {IBonusEscrowHooks.Snapshot}s — that is how each scaling branch
 *  is reached with numbers the test chooses. `BonusEscrowHooks.t.sol` drives the same hooks
 *  through the real vault.
 *
 *  Positions are valued at the pool mock's TWAP, tick 0, with {PositionValue} — the same library
 *  the escrow uses — so an expected amount is computed here, never copied from a run.
 */
contract BonusEscrowBranchesTest is ApeBondHarness {
    BonusEscrow internal book;

    uint256 internal constant BONUS = 100e18;
    uint64 internal constant UNLOCK = 1_000_000;

    uint256 internal constant ID1 = 101;
    uint256 internal constant ID2 = 102;
    uint256 internal constant ID3 = 103;
    uint256 internal constant UNKNOWN = 999;

    /// @dev Liquidity of the reported "old" position: worth ~1.2e23 ASSET wei at tick 0.
    uint128 internal constant OLD_LIQUIDITY = 2e24;

    function setUp() public {
        _deployApeBond();
        book = _deployBonusEscrowProxy(address(asset), address(vault), address(this), carol);
        vm.warp(1);
    }

    // ──────────────────────── Implementation constructor ───────

    function test_Constructor_RejectsAZeroBonusToken() public {
        vm.expectRevert(BonusEscrow.ZeroAddress.selector);
        new BonusEscrow(IERC20(address(0)), address(vault));
    }

    function test_Constructor_RejectsAZeroVault() public {
        vm.expectRevert(BonusEscrow.ZeroAddress.selector);
        new BonusEscrow(IERC20(address(asset)), address(0));
    }

    /// @dev A position's value can only be expressed in one of the pool's two tokens, so a bonus
    ///      token outside the pair is refused before any state exists.
    function test_Constructor_RejectsABonusTokenOutsideThePool() public {
        vm.expectRevert(
            abi.encodeWithSelector(BonusEscrow.BonusTokenNotInPool.selector, address(overture), token0, token1)
        );
        new BonusEscrow(IERC20(address(overture)), address(vault));
    }

    function test_Constructor_ValuesInToken0WhenTheBonusIsToken0() public view {
        assertEq(token0, address(asset), "the harness pins ASSET as token0");
        assertTrue(book.bonusIsToken0(), "an ASSET bonus values positions in token0");
        assertEq(address(book.bonusToken()), address(asset), "the bonus token immutable");
        assertEq(book.vault(), address(vault), "the vault immutable");
    }

    function test_Constructor_ValuesInToken1WhenTheBonusIsToken1() public {
        BonusEscrow usdcBook = _deployBonusEscrowProxy(address(usdcToken), address(vault), address(this), carol);
        assertFalse(usdcBook.bonusIsToken0(), "a USDC bonus values positions in token1");
        assertEq(address(usdcBook.bonusToken()), token1, "and records token1 as the bonus token");
    }

    /// @dev A bare implementation must be inert: its initializers are burnt in its constructor.
    function test_Constructor_DisablesTheImplementationsInitializers() public {
        BonusEscrow impl = new BonusEscrow(IERC20(address(asset)), address(vault));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(address(this), carol);
    }

    // ──────────────────────── Initializer ──────────────────────

    function test_Initialize_RejectsAZeroOwner() public {
        address impl = address(new BonusEscrow(IERC20(address(asset)), address(vault)));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new LPProxy(impl, abi.encodeCall(BonusEscrow.initialize, (address(0), carol)));
    }

    /// @dev The adapter history is complete from block one: `AdapterSet(0, adapter)` is emitted
    ///      even when the escrow is born with the reserve path closed (the deploy scripts' case).
    function test_Initialize_AnnouncesTheAdapterAndSetsTheOwner() public {
        address impl = address(new BonusEscrow(IERC20(address(asset)), address(vault)));

        vm.expectEmit(false, false, false, true);
        emit BonusEscrow.AdapterSet(address(0), address(0));
        BonusEscrow fresh =
            BonusEscrow(address(new LPProxy(impl, abi.encodeCall(BonusEscrow.initialize, (bob, address(0))))));

        assertEq(fresh.adapter(), address(0), "born with the reserve path closed");
        assertEq(fresh.totalReserved(), 0, "an empty book");
        assertEq(fresh.owner(), bob, "owned as initialised");
        assertEq(fresh.pendingOwner(), address(0), "with nobody pending");
    }

    function test_Initialize_CannotRunTwiceOnTheProxy() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        book.initialize(alice, carol);
    }

    // ──────────────────────── Storage ──────────────────────────

    /**
     * @dev The book's address, pinned: the literal in the contract is recomputed from the
     *      ERC-7201 formula, and each field is read where the clean v1 layout puts it — `adapter`
     *      at the base, `totalReserved` one above, and `reservations[tokenId]` two slots at
     *      `keccak256(abi.encode(tokenId, base + 2))`, the first packing `beneficiary`,
     *      `unlockAt`, `claimed` and `forfeited` in declaration order, the second `amount`.
     */
    function test_Storage_LivesAtThePinnedErc7201Slot() public {
        bytes32 base =
            keccak256(abi.encode(uint256(keccak256("real.lp.storage.BonusEscrow")) - 1)) & ~bytes32(uint256(0xff));
        assertEq(base, 0x206c24b685fdfe8aa4f7e59e2f442e89924a4d38c64044591f2a80ed05456200, "the pinned literal");

        _reserve(ID1, alice, BONUS, UNLOCK);
        vm.prank(address(vault));
        book.onUnstake(ID1); // forfeit, so the `forfeited` byte is set and readable

        _reserve(ID2, bob, 2 * BONUS, UNLOCK);

        assertEq(address(uint160(uint256(vm.load(address(book), base)))), carol, "slot 0 is `adapter`");
        assertEq(uint256(vm.load(address(book), bytes32(uint256(base) + 1))), 2 * BONUS, "slot 1 is `totalReserved`");

        bytes32 e1 = keccak256(abi.encode(ID1, bytes32(uint256(base) + 2)));
        uint256 p1 = uint256(vm.load(address(book), e1));
        assertEq(address(uint160(p1)), alice, "`beneficiary` opens the entry");
        assertEq(uint64(p1 >> 160), UNLOCK, "`unlockAt` follows it");
        assertEq((p1 >> 224) & 0xff, 0, "`claimed` follows `unlockAt`");
        assertEq((p1 >> 232) & 0xff, 1, "`forfeited` follows `claimed`");
        assertEq(uint256(vm.load(address(book), bytes32(uint256(e1) + 1))), 0, "`amount` opens the second slot");

        bytes32 e2 = keccak256(abi.encode(ID2, bytes32(uint256(base) + 2)));
        assertEq(uint256(vm.load(address(book), bytes32(uint256(e2) + 1))), 2 * BONUS, "a live entry's amount");
    }

    // ──────────────────────── reserve ──────────────────────────

    /// @dev Adapter tier only: the owner, a stranger and the vault are each refused, by name.
    function test_Reserve_RejectsEveryoneButTheAdapter() public {
        address[3] memory outsiders = [address(this), stranger, address(vault)];
        for (uint256 i = 0; i < outsiders.length; ++i) {
            vm.prank(outsiders[i]);
            vm.expectRevert(abi.encodeWithSelector(BonusEscrow.NotAdapter.selector, outsiders[i], carol));
            book.reserve(ID1, alice, BONUS, UNLOCK);
        }
    }

    /// @dev With the adapter unset the reserve path is closed for everyone, the former adapter
    ///      included — the error names the zero address as the only allowed caller.
    function test_Reserve_IsClosedWhileTheAdapterIsUnset() public {
        book.setAdapter(address(0));
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(BonusEscrow.NotAdapter.selector, carol, address(0)));
        book.reserve(ID1, alice, BONUS, UNLOCK);
    }

    function test_Reserve_RejectsAZeroBeneficiary() public {
        vm.prank(carol);
        vm.expectRevert(BonusEscrow.ZeroAddress.selector);
        book.reserve(ID1, address(0), BONUS, UNLOCK);
    }

    function test_Reserve_RejectsAZeroAmount() public {
        vm.prank(carol);
        vm.expectRevert(BonusEscrow.ZeroAmount.selector);
        book.reserve(ID1, alice, 0, UNLOCK);
    }

    /// @dev Override O2: no balance check of any kind. The escrow holds NOTHING and the
    ///      reservation is recorded, announced and counted all the same.
    function test_Reserve_RecordsTheBonusWithAnEmptyEscrow() public {
        assertEq(asset.balanceOf(address(book)), 0, "nothing in the escrow");

        vm.expectEmit(true, true, false, true, address(book));
        emit BonusEscrow.BonusReserved(ID1, alice, BONUS, UNLOCK);
        _reserve(ID1, alice, BONUS, UNLOCK);

        (address beneficiary, uint256 amount, uint64 unlockAt, bool claimed, bool forfeited) = book.reservationOf(ID1);
        assertEq(beneficiary, alice, "the beneficiary");
        assertEq(amount, BONUS, "the amount");
        assertEq(unlockAt, UNLOCK, "the cliff");
        assertFalse(claimed, "unclaimed");
        assertFalse(forfeited, "live");
        assertEq(book.totalReserved(), BONUS, "counted in what is owed");
        assertTrue(book.isActive(ID1), "and active before its cliff");
    }

    /// @dev No ceiling either: what is owed may grow far past the balance.
    function test_Reserve_TotalReservedMayExceedTheBalance() public {
        _fundEscrow(book, 1);
        _reserve(ID1, alice, BONUS, UNLOCK);
        _reserve(ID2, bob, type(uint128).max, UNLOCK);
        assertEq(book.totalReserved(), BONUS + type(uint128).max, "owed is the plain sum, whatever is held");
    }

    function test_Reserve_RejectsADuplicateOfALiveReservation() public {
        _reserve(ID1, alice, BONUS, UNLOCK);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(BonusEscrow.DuplicateReservation.selector, ID1));
        book.reserve(ID1, bob, BONUS, UNLOCK);
    }

    /// @dev A forfeited record stays, so the same NFT can never carry a second bonus (I6).
    function test_Reserve_RejectsADuplicateOfAForfeitedReservation() public {
        _reserve(ID1, alice, BONUS, UNLOCK);
        vm.prank(address(vault));
        book.onUnstake(ID1);

        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(BonusEscrow.DuplicateReservation.selector, ID1));
        book.reserve(ID1, alice, BONUS, UNLOCK);
    }

    function test_Reserve_RejectsADuplicateOfAClaimedReservation() public {
        _reserve(ID1, alice, BONUS, UNLOCK);
        _fundEscrow(book, BONUS);
        vm.warp(UNLOCK);
        book.claim(ID1);

        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(BonusEscrow.DuplicateReservation.selector, ID1));
        book.reserve(ID1, alice, BONUS, UNLOCK + 1);
    }

    // ──────────────────────── claim ────────────────────────────

    function test_Claim_RejectsAnUnknownReservation() public {
        vm.expectRevert(abi.encodeWithSelector(BonusEscrow.UnknownReservation.selector, UNKNOWN));
        book.claim(UNKNOWN);
    }

    function test_Claim_RejectsASecondClaim() public {
        _reserve(ID1, alice, BONUS, UNLOCK);
        _fundEscrow(book, 2 * BONUS);
        vm.warp(UNLOCK);
        book.claim(ID1);

        vm.expectRevert(abi.encodeWithSelector(BonusEscrow.AlreadyClaimed.selector, ID1));
        book.claim(ID1);
    }

    /// @dev A forfeited reservation never pays, funded or not, cliff passed or not.
    function test_Claim_RejectsAForfeitedReservation() public {
        _reserve(ID1, alice, BONUS, UNLOCK);
        vm.prank(address(vault));
        book.onUnstake(ID1);
        _fundEscrow(book, BONUS);
        vm.warp(UNLOCK);

        vm.expectRevert(abi.encodeWithSelector(BonusEscrow.Forfeited.selector, ID1));
        book.claim(ID1);
    }

    /// @dev The cliff, both sides of its one boundary: `unlockAt - 1` reverts with both numbers,
    ///      `unlockAt` itself pays.
    function test_Claim_TheCliffBoundaryIsExact() public {
        _reserve(ID1, alice, BONUS, UNLOCK);
        _fundEscrow(book, BONUS);

        vm.warp(UNLOCK - 1);
        vm.expectRevert(abi.encodeWithSelector(BonusEscrow.CliffNotReached.selector, UNLOCK, UNLOCK - 1));
        book.claim(ID1);

        vm.warp(UNLOCK);
        assertEq(book.claim(ID1), BONUS, "at the cliff it pays");
    }

    /// @dev All or nothing (I8): an empty escrow and an escrow short by one wei both refuse, with
    ///      the two numbers, and leave the reservation exactly as it was.
    function test_Claim_RevertsInsufficientFundsUntilTheWholeAmountIsHeld() public {
        _reserve(ID1, alice, BONUS, UNLOCK);
        vm.warp(UNLOCK);

        vm.expectRevert(abi.encodeWithSelector(BonusEscrow.InsufficientFunds.selector, BONUS, 0));
        book.claim(ID1);

        _fundEscrow(book, BONUS - 1);
        vm.expectRevert(abi.encodeWithSelector(BonusEscrow.InsufficientFunds.selector, BONUS, BONUS - 1));
        book.claim(ID1);

        (,,, bool claimed,) = book.reservationOf(ID1);
        assertFalse(claimed, "a refused claim spends nothing");
        assertEq(book.totalReserved(), BONUS, "and owes the same");

        _fundEscrow(book, 1);
        assertEq(book.claim(ID1), BONUS, "the exact balance is enough");
        assertEq(asset.balanceOf(address(book)), 0, "and is exactly consumed");
    }

    /// @dev Anyone may trigger a claim; only the recorded beneficiary is ever paid.
    function test_Claim_PaysTheRecordedBeneficiaryWhoeverTriggersIt() public {
        _reserve(ID1, alice, BONUS, UNLOCK);
        _fundEscrow(book, BONUS);
        vm.warp(UNLOCK);

        uint256 aliceBefore = asset.balanceOf(alice);
        uint256 strangerBefore = asset.balanceOf(stranger);

        vm.expectEmit(true, true, false, true, address(book));
        emit BonusEscrow.BonusClaimed(ID1, alice, BONUS);
        vm.prank(stranger);
        uint256 paid = book.claim(ID1);

        assertEq(paid, BONUS, "the return value is the amount");
        assertEq(asset.balanceOf(alice) - aliceBefore, BONUS, "the beneficiary is paid");
        assertEq(asset.balanceOf(stranger), strangerBefore, "the trigger is paid nothing");
        (,,, bool claimed,) = book.reservationOf(ID1);
        assertTrue(claimed, "and the reservation is spent");
        assertEq(book.totalReserved(), 0, "and released from what is owed");
    }

    function test_Claim_LeavesEveryOtherReservationAlone() public {
        _reserve(ID1, alice, BONUS, UNLOCK);
        _reserve(ID2, bob, 2 * BONUS, UNLOCK + 1);
        _fundEscrow(book, 3 * BONUS);

        vm.warp(UNLOCK);
        book.claim(ID1);

        assertEq(book.totalReserved(), 2 * BONUS, "only the claimed bonus leaves the book");
        assertEq(book.claimable(ID2), 0, "and a later cliff is still a cliff");
        assertTrue(book.isActive(ID2), "so the other one is still active");
    }

    /**
     * @dev The ordering claim, measured: the beneficiary is a callback contract that asks the
     *      escrow what is still claimable WHILE the payout transfer is in flight. It reads zero,
     *      which can only be true if `claimed` was set before the token moved.
     */
    function test_Claim_MarksTheReservationSpentBeforeTheTransfer() public {
        (BonusEscrow hooked, HookToken hookToken, ReentrantReceiver receiver) = _hookedEscrow();

        vm.prank(carol);
        hooked.reserve(ID1, address(receiver), BONUS, UNLOCK);
        receiver.configure(address(hooked), abi.encodeCall(BonusEscrow.claimable, (ID1)));

        vm.warp(UNLOCK);
        hooked.claim(ID1);

        assertEq(receiver.attempts(), 1, "the hook really fired inside the payout");
        assertTrue(receiver.lastReenterSucceeded(), "a read is allowed mid-payout");
        assertEq(abi.decode(receiver.lastReturnData(), (uint256)), 0, "and already reads as spent");
        assertEq(hookToken.balanceOf(address(receiver)), BONUS, "and the payout still lands");
    }

    /// @dev The same window with a WRITE aimed at it: a second claim from inside the first payout
    ///      is refused by the reentrancy guard; the outer claim completes.
    function test_Claim_CannotBeReenteredThroughACallbackToken() public {
        (BonusEscrow hooked,, ReentrantReceiver receiver) = _hookedEscrow();

        vm.startPrank(carol);
        hooked.reserve(ID1, address(receiver), BONUS, UNLOCK);
        hooked.reserve(ID2, address(receiver), BONUS, UNLOCK);
        vm.stopPrank();
        receiver.configure(address(hooked), abi.encodeCall(BonusEscrow.claim, (ID2)));

        vm.warp(UNLOCK);
        hooked.claim(ID1);

        assertEq(receiver.attempts(), 1, "the re-entrant call was attempted");
        assertFalse(receiver.lastReenterSucceeded(), "and rejected");
        assertEq(
            bytes4(receiver.lastReturnData()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector, "by the guard"
        );
        assertEq(hooked.totalReserved(), BONUS, "the second bonus is still owed");
        assertEq(hooked.claimable(ID2), BONUS, "and still claimable outside the window");
    }

    // ──────────────────────── onUnstake ────────────────────────

    /// @dev Vault only: the owner, the adapter and a stranger are each refused by name.
    function test_OnUnstake_RejectsEveryoneButTheVault() public {
        _reserve(ID1, alice, BONUS, UNLOCK);
        address[3] memory outsiders = [address(this), carol, stranger];
        for (uint256 i = 0; i < outsiders.length; ++i) {
            vm.prank(outsiders[i]);
            vm.expectRevert(abi.encodeWithSelector(BonusEscrow.NotVault.selector, outsiders[i], address(vault)));
            book.onUnstake(ID1);
        }
        assertTrue(book.isActive(ID1), "nothing was forfeited");
    }

    /// @dev An ACTIVE reservation is forfeited: event with the amount owed until now, amount to
    ///      zero, `forfeited` set, `totalReserved` released, the record kept.
    function test_OnUnstake_ForfeitsAnActiveReservation() public {
        _reserve(ID1, alice, BONUS, UNLOCK);
        _reserve(ID2, bob, 2 * BONUS, UNLOCK);

        vm.expectEmit(true, true, false, true, address(book));
        emit BonusEscrow.BonusForfeited(ID1, alice, BONUS);
        vm.prank(address(vault));
        book.onUnstake(ID1);

        (address beneficiary, uint256 amount, uint64 unlockAt, bool claimed, bool forfeited) = book.reservationOf(ID1);
        assertEq(beneficiary, alice, "the record stays");
        assertEq(amount, 0, "the amount is gone");
        assertEq(unlockAt, UNLOCK, "the cliff is kept for the record");
        assertFalse(claimed, "never claimed");
        assertTrue(forfeited, "forfeited");
        assertEq(book.totalReserved(), 2 * BONUS, "only the forfeited bonus left what is owed");
        assertFalse(book.isActive(ID1), "no longer active");
        assertEq(book.claimable(ID1), 0, "and never claimable");
    }

    /// @dev Every INACTIVE state returns at once: no event, no write.
    function test_OnUnstake_IsANoOpForEveryInactiveState() public {
        // matured, claimed, already forfeited, unknown
        _reserve(ID1, alice, BONUS, UNLOCK);
        _reserve(ID2, bob, BONUS, UNLOCK);
        _reserve(ID3, carol, BONUS, UNLOCK + 10);
        _fundEscrow(book, BONUS);
        vm.prank(address(vault));
        book.onUnstake(ID3); // forfeited before the cliff

        vm.warp(UNLOCK);
        book.claim(ID2); // claimed

        uint256 owedBefore = book.totalReserved();
        vm.recordLogs();
        vm.startPrank(address(vault));
        book.onUnstake(ID1); // matured: cliff reached
        book.onUnstake(ID2); // claimed
        book.onUnstake(ID3); // forfeited
        book.onUnstake(UNKNOWN); // never reserved
        vm.stopPrank();

        assertEq(vm.getRecordedLogs().length, 0, "no event at all");
        assertEq(book.totalReserved(), owedBefore, "nothing released");
        (, uint256 amount,,, bool forfeited) = book.reservationOf(ID1);
        assertEq(amount, BONUS, "the matured bonus is untouched");
        assertFalse(forfeited, "and not forfeited");
    }

    // ──────────────────────── onRebalance ──────────────────────

    function test_OnRebalance_RejectsEveryoneButTheVault() public {
        _reserve(ID1, alice, BONUS, UNLOCK);
        address[3] memory outsiders = [address(this), carol, stranger];
        for (uint256 i = 0; i < outsiders.length; ++i) {
            vm.prank(outsiders[i]);
            vm.expectRevert(abi.encodeWithSelector(BonusEscrow.NotVault.selector, outsiders[i], address(vault)));
            book.onRebalance(ID1, ID2, _old(), _old());
        }
    }

    /// @dev Inactive reservations return BEFORE the oracle is read: with `observe` reverting,
    ///      every inactive state still succeeds and moves nothing (D3).
    function test_OnRebalance_IsANoOpForEveryInactiveStateWithTheOracleDown() public {
        _reserve(ID1, alice, BONUS, UNLOCK);
        _reserve(ID2, bob, BONUS, UNLOCK);
        _reserve(ID3, carol, BONUS, UNLOCK + 10);
        _fundEscrow(book, BONUS);
        vm.prank(address(vault));
        book.onUnstake(ID3);
        vm.warp(UNLOCK);
        book.claim(ID2);
        poolMock.setObserveReverts(true);

        vm.recordLogs();
        vm.startPrank(address(vault));
        book.onRebalance(ID1, 201, _old(), _new(1)); // matured
        book.onRebalance(ID2, 202, _old(), _new(1)); // claimed
        book.onRebalance(ID3, 203, _old(), _new(1)); // forfeited
        book.onRebalance(UNKNOWN, 204, _old(), _new(1)); // unknown
        vm.stopPrank();

        assertEq(vm.getRecordedLogs().length, 0, "no event at all");
        (address stays, uint256 amount,,,) = book.reservationOf(ID1);
        assertEq(stays, alice, "a matured reservation stays under its old id");
        assertEq(amount, BONUS, "untouched");
        for (uint256 id = 201; id <= 204; ++id) {
            (address moved,,,,) = book.reservationOf(id);
            assertEq(moved, address(0), "nothing moved to a new id");
        }
    }

    /// @dev An ACTIVE reservation needs the oracle, so it fails closed without one (B.3 L2).
    function test_OnRebalance_AnActiveReservationFailsClosedWithTheOracleDown() public {
        _reserve(ID1, alice, BONUS, UNLOCK);
        poolMock.setObserveReverts(true);
        vm.prank(address(vault));
        vm.expectRevert(bytes("OLD"));
        book.onRebalance(ID1, ID2, _old(), _old());
    }

    /// @dev Same range, same liquidity: same value, same amount. The record moves to the new id,
    ///      keeps its beneficiary and cliff, and the old id is deleted.
    function test_OnRebalance_KeepingTheValueMovesTheSameAmount() public {
        _reserve(ID1, alice, BONUS, UNLOCK);

        vm.expectEmit(true, true, true, true, address(book));
        emit BonusEscrow.BonusMoved(ID1, ID2, alice, BONUS, BONUS);
        vm.prank(address(vault));
        book.onRebalance(ID1, ID2, _old(), _old());

        (address gone, uint256 goneAmount, uint64 goneUnlock,,) = book.reservationOf(ID1);
        assertEq(gone, address(0), "the old id is deleted");
        assertEq(goneAmount, 0, "entirely");
        assertEq(goneUnlock, 0, "entirely");
        (address beneficiary, uint256 amount, uint64 unlockAt, bool claimed, bool forfeited) = book.reservationOf(ID2);
        assertEq(beneficiary, alice, "the beneficiary moves with it");
        assertEq(amount, BONUS, "the amount is kept");
        assertEq(unlockAt, UNLOCK, "the cliff is carried");
        assertFalse(claimed, "unclaimed");
        assertFalse(forfeited, "live");
        assertEq(book.totalReserved(), BONUS, "nothing released");
    }

    /// @dev Half the liquidity on the same range: the amount is scaled by valueNew / valueOld,
    ///      computed here with the same library at the same TWAP, rounded down by `mulDiv`.
    function test_OnRebalance_AValueReducingMoveScalesTheAmountInProportion() public {
        _reserve(ID1, alice, BONUS, UNLOCK);
        _reserve(ID3, bob, BONUS, UNLOCK);
        IBonusEscrowHooks.Snapshot memory newer = _new(OLD_LIQUIDITY / 2);

        uint256 valueOld = _value(_old());
        uint256 valueNew = _value(newer);
        assertLt(valueNew, valueOld, "the new position is worth less");
        uint256 expected = Math.mulDiv(BONUS, valueNew, valueOld);

        vm.expectEmit(true, true, true, true, address(book));
        emit BonusEscrow.BonusMoved(ID1, ID2, alice, BONUS, expected);
        vm.prank(address(vault));
        book.onRebalance(ID1, ID2, _old(), newer);

        (, uint256 amount,,, bool forfeited) = book.reservationOf(ID2);
        assertEq(amount, expected, "scaled exactly");
        assertFalse(forfeited, "and still live");
        assertEq(book.totalReserved(), BONUS + expected, "the difference is released");
    }

    /// @dev A move into a position worth MORE (compounded fees, a top-up) never raises the bonus.
    function test_OnRebalance_AValueRaisingMoveKeepsTheAmount() public {
        _reserve(ID1, alice, BONUS, UNLOCK);
        assertGt(_value(_new(OLD_LIQUIDITY * 3)), _value(_old()), "the new position is worth more");

        vm.prank(address(vault));
        book.onRebalance(ID1, ID2, _old(), _new(OLD_LIQUIDITY * 3));

        (, uint256 amount,,,) = book.reservationOf(ID2);
        assertEq(amount, BONUS, "never more than reserved (I2)");
        assertEq(book.totalReserved(), BONUS, "and nothing added to what is owed");
    }

    /// @dev An old position worth nothing at the TWAP carries nothing forward: the moved record
    ///      is forfeited, even though the new position is worth something.
    function test_OnRebalance_AnOldPositionWorthNothingForfeits() public {
        _reserve(ID1, alice, BONUS, UNLOCK);
        IBonusEscrowHooks.Snapshot memory empty = _new(0);
        assertEq(_value(empty), 0, "zero liquidity is worth zero");

        vm.expectEmit(true, true, true, true, address(book));
        emit BonusEscrow.BonusMoved(ID1, ID2, alice, BONUS, 0);
        vm.prank(address(vault));
        book.onRebalance(ID1, ID2, empty, _old());

        (address beneficiary, uint256 amount,,, bool forfeited) = book.reservationOf(ID2);
        assertEq(beneficiary, alice, "the record moves");
        assertEq(amount, 0, "with nothing in it");
        assertTrue(forfeited, "and forfeited");
        assertEq(book.totalReserved(), 0, "all of it released");
        assertFalse(book.isActive(ID2), "so it is no longer active");
    }

    /// @dev A move that keeps a trace of liquidity scales the bonus down to zero: forfeited.
    function test_OnRebalance_AScaledAmountOfZeroForfeits() public {
        _reserve(ID1, alice, 1_000, UNLOCK);
        IBonusEscrowHooks.Snapshot memory dust = _new(1);
        assertEq(Math.mulDiv(1_000, _value(dust), _value(_old())), 0, "a trace scales a small bonus to zero");

        vm.prank(address(vault));
        book.onRebalance(ID1, ID2, _old(), dust);

        (, uint256 amount,,, bool forfeited) = book.reservationOf(ID2);
        assertEq(amount, 0, "nothing left");
        assertTrue(forfeited, "forfeited");
        vm.warp(UNLOCK);
        vm.expectRevert(abi.encodeWithSelector(BonusEscrow.Forfeited.selector, ID2));
        book.claim(ID2);
    }

    /// @dev The new id must be fresh: a reservation already under it is never overwritten, and
    ///      the rebalance fails closed instead.
    function test_OnRebalance_RejectsANewIdThatAlreadyCarriesAReservation() public {
        _reserve(ID1, alice, BONUS, UNLOCK);
        _reserve(ID2, bob, 2 * BONUS, UNLOCK);

        vm.prank(address(vault));
        vm.expectRevert(abi.encodeWithSelector(BonusEscrow.DuplicateReservation.selector, ID2));
        book.onRebalance(ID1, ID2, _old(), _old());
    }

    /// @dev The price both positions are valued at is the vault's TWAP, not the spot tick: with
    ///      spot pushed away and the TWAP left alone, the scaling is the TWAP's.
    function test_OnRebalance_ValuesBothPositionsAtTheTwapNotTheSpot() public {
        _reserve(ID1, alice, BONUS, UNLOCK);
        poolMock.setTicks(900, 0); // spot far off, TWAP 0
        IBonusEscrowHooks.Snapshot memory shifted = IBonusEscrowHooks.Snapshot({
            tickLower: CAMPAIGN_TICK_LOWER + 600, tickUpper: CAMPAIGN_TICK_UPPER + 600, liquidity: OLD_LIQUIDITY
        });
        uint256 expected = Math.mulDiv(BONUS, _value(shifted), _value(_old()));
        if (_value(shifted) >= _value(_old())) expected = BONUS;

        vm.prank(address(vault));
        book.onRebalance(ID1, ID2, _old(), shifted);

        (, uint256 amount,,,) = book.reservationOf(ID2);
        assertEq(amount, expected, "valued at the TWAP tick");
    }

    // ──────────────────────── recoverSurplus ───────────────────

    function test_RecoverSurplus_RejectsEveryoneButTheOwner() public {
        _fundEscrow(book, BONUS);
        address[3] memory outsiders = [carol, stranger, address(vault)];
        for (uint256 i = 0; i < outsiders.length; ++i) {
            vm.prank(outsiders[i]);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, outsiders[i]));
            book.recoverSurplus(outsiders[i]);
        }
    }

    function test_RecoverSurplus_RejectsAZeroDestination() public {
        _fundEscrow(book, BONUS);
        vm.expectRevert(BonusEscrow.ZeroAddress.selector);
        book.recoverSurplus(address(0));
    }

    function test_RecoverSurplus_NoSurplusWhenTheBalanceIsExactlyWhatIsOwed() public {
        _reserve(ID1, alice, BONUS, UNLOCK);
        _fundEscrow(book, BONUS);
        vm.expectRevert(BonusEscrow.NoSurplus.selector);
        book.recoverSurplus(operatorSafe);
    }

    /// @dev Override O2's other face: more owed than held is legal, and then nothing is surplus.
    function test_RecoverSurplus_NoSurplusWhileMoreIsOwedThanHeld() public {
        _reserve(ID1, alice, BONUS, UNLOCK);
        _fundEscrow(book, BONUS / 2);
        vm.expectRevert(BonusEscrow.NoSurplus.selector);
        book.recoverSurplus(operatorSafe);
    }

    function test_RecoverSurplus_MovesExactlyTheUnreservedBalance() public {
        _reserve(ID1, alice, BONUS, UNLOCK);
        _fundEscrow(book, BONUS + 7);

        vm.expectEmit(false, false, false, true, address(book));
        emit BonusEscrow.SurplusRecovered(operatorSafe, 7);
        book.recoverSurplus(operatorSafe);

        assertEq(asset.balanceOf(operatorSafe), 7, "the surplus, to the wei");
        assertEq(asset.balanceOf(address(book)), BONUS, "every owed wei stays");
    }

    /// @dev A forfeiture returns the bonus to the surplus: what was owed becomes recoverable.
    function test_RecoverSurplus_AForfeitedBonusBecomesSurplus() public {
        _reserve(ID1, alice, BONUS, UNLOCK);
        _fundEscrow(book, BONUS);
        vm.prank(address(vault));
        book.onUnstake(ID1);

        book.recoverSurplus(operatorSafe);
        assertEq(asset.balanceOf(operatorSafe), BONUS, "the forfeited bonus is free again");
    }

    // ──────────────────────── setAdapter ───────────────────────

    function test_SetAdapter_AnnouncesBothSidesAndMovesTheReserveRight() public {
        vm.expectEmit(false, false, false, true, address(book));
        emit BonusEscrow.AdapterSet(carol, bob);
        book.setAdapter(bob);
        assertEq(book.adapter(), bob, "the new adapter is stored");

        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(BonusEscrow.NotAdapter.selector, carol, bob));
        book.reserve(ID1, alice, BONUS, UNLOCK);

        vm.prank(bob);
        book.reserve(ID1, alice, BONUS, UNLOCK);
        assertEq(book.totalReserved(), BONUS, "and the new one can reserve");
    }

    function test_SetAdapter_RejectsEveryoneButTheOwner() public {
        address[3] memory outsiders = [carol, stranger, address(vault)];
        for (uint256 i = 0; i < outsiders.length; ++i) {
            vm.prank(outsiders[i]);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, outsiders[i]));
            book.setAdapter(outsiders[i]);
        }
        assertEq(book.adapter(), carol, "nobody else re-points the escrow");
    }

    /// @dev Zero closes the reserve path and leaves every standing reservation where it is.
    function test_SetAdapter_ZeroClosesTheReservePathAndLeavesTheBookIntact() public {
        _reserve(ID1, alice, BONUS, UNLOCK);
        book.setAdapter(address(0));

        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(BonusEscrow.NotAdapter.selector, carol, address(0)));
        book.reserve(ID2, bob, BONUS, UNLOCK);

        _fundEscrow(book, BONUS);
        vm.warp(UNLOCK);
        assertEq(book.claim(ID1), BONUS, "the standing reservation still pays");
    }

    // ──────────────────────── Ownership ────────────────────────

    function test_RenounceOwnership_IsDisabled() public {
        vm.expectRevert(BonusEscrow.RenounceDisabled.selector);
        book.renounceOwnership();
        assertEq(book.owner(), address(this), "the owner is where it was");

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        book.renounceOwnership();
    }

    // ──────────────────────── Upgrades ─────────────────────────

    /// @dev The reason the proxy exists: the book survives a code change, and pays through it.
    function test_Upgrade_PreservesTheBookAndTheRoles() public {
        _reserve(ID1, alice, BONUS, UNLOCK);
        _reserve(ID2, bob, 2 * BONUS, UNLOCK);
        vm.prank(address(vault));
        book.onUnstake(ID2);

        address v2 = address(new BonusEscrowV2Mock(IERC20(address(asset)), address(vault)));
        book.upgradeToAndCall(v2, "");

        assertEq(_implementationOf(address(book)), v2, "the ERC-1967 slot names the new code");
        assertEq(BonusEscrowV2Mock(address(book)).version(), 2, "and the new code runs");
        assertEq(book.totalReserved(), BONUS, "the total survives");
        assertEq(book.adapter(), carol, "the adapter survives");
        assertEq(book.owner(), address(this), "the owner survives");
        assertEq(book.vault(), address(vault), "the vault immutable is the same");

        (address b1, uint256 a1, uint64 u1, bool c1, bool f1) = book.reservationOf(ID1);
        assertEq(b1, alice, "the live reservation survives");
        assertEq(a1, BONUS, "with its amount");
        assertEq(u1, UNLOCK, "and its cliff");
        assertFalse(c1 || f1, "still live");
        (,,,, bool f2) = book.reservationOf(ID2);
        assertTrue(f2, "and the forfeited one stays forfeited");

        _fundEscrow(book, BONUS);
        vm.warp(UNLOCK);
        assertEq(book.claim(ID1), BONUS, "the obligation pays through the new code");
    }

    function test_Upgrade_V2StateLivesInItsOwnNamespace() public {
        _reserve(ID1, alice, BONUS, UNLOCK);
        address v2 = address(new BonusEscrowV2Mock(IERC20(address(asset)), address(vault)));
        book.upgradeToAndCall(v2, abi.encodeCall(BonusEscrowV2Mock.initializeV2, (42)));

        assertEq(BonusEscrowV2Mock(address(book)).upgradeMarker(), 42, "V2 state is readable");
        assertEq(book.totalReserved(), BONUS, "and V1's namespace is untouched");
        assertEq(book.adapter(), carol, "entirely");
    }

    function test_Upgrade_RejectsEveryoneButTheOwner() public {
        address v2 = address(new BonusEscrowV2Mock(IERC20(address(asset)), address(vault)));
        address[3] memory outsiders = [carol, alice, address(vault)];
        for (uint256 i = 0; i < outsiders.length; ++i) {
            vm.prank(outsiders[i]);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, outsiders[i]));
            book.upgradeToAndCall(v2, "");
        }
        book.upgradeToAndCall(v2, "");
        assertEq(_implementationOf(address(book)), v2, "the owner can upgrade");
    }

    // ──────────────────────── Views ────────────────────────────

    /// @dev `claimable` and `isActive` over every state a reservation can be in.
    function test_Views_ReportEveryState() public {
        assertEq(book.claimable(UNKNOWN), 0, "unknown: nothing claimable");
        assertFalse(book.isActive(UNKNOWN), "unknown: not active");

        _reserve(ID1, alice, BONUS, UNLOCK); // will be claimed
        _reserve(ID2, bob, BONUS, UNLOCK); // will be forfeited
        _reserve(ID3, carol, BONUS, UNLOCK); // will mature
        assertEq(book.claimable(ID1), 0, "locked: nothing claimable yet");
        assertTrue(book.isActive(ID1), "locked: active");

        vm.prank(address(vault));
        book.onUnstake(ID2);
        assertEq(book.claimable(ID2), 0, "forfeited: never claimable");
        assertFalse(book.isActive(ID2), "forfeited: not active");

        vm.warp(UNLOCK);
        assertEq(book.claimable(ID3), BONUS, "matured: claimable, whatever the balance");
        assertEq(asset.balanceOf(address(book)), 0, "and the balance is zero");
        assertFalse(book.isActive(ID3), "matured: not active");

        _fundEscrow(book, BONUS);
        book.claim(ID1);
        assertEq(book.claimable(ID1), 0, "claimed: nothing claimable");
        assertFalse(book.isActive(ID1), "claimed: not active");
    }

    // ──────────────────────── Fuzz ─────────────────────────────

    function testFuzz_Claim_PaysExactlyWhatWasReserved(uint256 amountSeed) public {
        uint256 amount = bound(amountSeed, 1, 1e30);
        _reserve(ID1, alice, amount, UNLOCK);
        deal(address(asset), address(book), amount);

        vm.warp(UNLOCK);
        uint256 before = asset.balanceOf(alice);
        uint256 paid = book.claim(ID1);

        assertEq(paid, amount, "the payout is the reservation, whatever its size");
        assertEq(asset.balanceOf(alice) - before, amount, "and lands on the beneficiary");
        assertEq(book.totalReserved(), 0, "and the book comes back to zero");
    }

    /// @dev Strictly before the cliff reverts with both numbers; at or after it pays.
    function testFuzz_Claim_TheCliffBoundaryHoldsAtAnyTimestamp(uint64 unlockSeed, uint64 nowSeed) public {
        uint64 unlockAt = uint64(bound(unlockSeed, 2, type(uint64).max - 1));
        uint256 at = bound(nowSeed, 1, type(uint64).max);
        _reserve(ID1, alice, BONUS, unlockAt);
        _fundEscrow(book, BONUS);

        vm.warp(at);
        if (at < unlockAt) {
            vm.expectRevert(abi.encodeWithSelector(BonusEscrow.CliffNotReached.selector, unlockAt, at));
            book.claim(ID1);
        } else {
            assertEq(book.claim(ID1), BONUS, "at or past the cliff it pays");
        }
    }

    /// @dev Whatever is owed and whatever is held, recovery leaves exactly `totalReserved` — or,
    ///      with nothing free, refuses and moves nothing.
    function testFuzz_RecoverSurplus_LeavesExactlyTotalReserved(uint256 owedSeed, uint256 heldSeed) public {
        uint256 owed = bound(owedSeed, 1, 1_000_000e18);
        uint256 held = bound(heldSeed, 0, 1_000_000e18);
        _reserve(ID1, alice, owed, UNLOCK);
        if (held > 0) _fundEscrow(book, held);

        if (held <= owed) {
            vm.expectRevert(BonusEscrow.NoSurplus.selector);
            book.recoverSurplus(operatorSafe);
            assertEq(asset.balanceOf(address(book)), held, "nothing moved");
        } else {
            book.recoverSurplus(operatorSafe);
            assertEq(asset.balanceOf(address(book)), owed, "exactly what is owed stays");
            assertEq(asset.balanceOf(operatorSafe), held - owed, "and only the surplus left");
        }
    }

    /// @dev I2 under any move: whatever the two positions, the amount never rises, and the
    ///      released part is exactly what leaves `totalReserved`.
    function testFuzz_OnRebalance_NeverIncreasesTheAmount(
        uint128 oldLiquiditySeed,
        uint128 newLiquiditySeed,
        int24 lowerSeed,
        int24 widthSeed,
        uint256 amountSeed
    ) public {
        uint256 amount = bound(amountSeed, 1, 1e30);
        IBonusEscrowHooks.Snapshot memory older = _new(uint128(bound(oldLiquiditySeed, 0, 1e30)));
        int24 lower = int24(bound(lowerSeed, -200_000, 199_000));
        int24 upper = lower + int24(bound(widthSeed, 1, 200_000 - int256(lower)));
        IBonusEscrowHooks.Snapshot memory newer = IBonusEscrowHooks.Snapshot({
            tickLower: lower, tickUpper: upper, liquidity: uint128(bound(newLiquiditySeed, 0, 1e30))
        });
        _reserve(ID1, alice, amount, UNLOCK);

        vm.prank(address(vault));
        book.onRebalance(ID1, ID2, older, newer);

        (, uint256 moved,,, bool forfeited) = book.reservationOf(ID2);
        assertLe(moved, amount, "never more than reserved");
        assertEq(book.totalReserved(), moved, "what is owed is exactly what moved");
        assertEq(forfeited, moved == 0, "forfeited exactly when nothing is left");
    }

    // ──────────────────────── Helpers ──────────────────────────

    function _reserve(uint256 tokenId, address beneficiary, uint256 amount, uint64 unlockAt) private {
        vm.prank(carol);
        book.reserve(tokenId, beneficiary, amount, unlockAt);
    }

    /// @dev The "old" position every scaling test reports: the campaign range, OLD_LIQUIDITY.
    function _old() private pure returns (IBonusEscrowHooks.Snapshot memory) {
        return IBonusEscrowHooks.Snapshot({
            tickLower: CAMPAIGN_TICK_LOWER, tickUpper: CAMPAIGN_TICK_UPPER, liquidity: OLD_LIQUIDITY
        });
    }

    /// @dev A "new" position on the same range with the given liquidity.
    function _new(uint128 liquidity) private pure returns (IBonusEscrowHooks.Snapshot memory) {
        return IBonusEscrowHooks.Snapshot({
            tickLower: CAMPAIGN_TICK_LOWER, tickUpper: CAMPAIGN_TICK_UPPER, liquidity: liquidity
        });
    }

    /// @dev What the escrow values a snapshot at: the pool mock's TWAP tick, in token0 (ASSET).
    function _value(IBonusEscrowHooks.Snapshot memory s) private view returns (uint256) {
        return PositionValue.valueAt(s.liquidity, s.tickLower, s.tickUpper, poolMock.twapTick(), true);
    }

    /**
     * @dev A second escrow paid in a callback token, with a contract beneficiary that re-enters on
     *      receipt. The escrow's constructor requires the bonus token to be one of its vault's
     *      pool tokens, so the "vault" here is a {MisreportingVault} reporting the hook token as
     *      token0 — the escrow reads nothing else from it in these two tests.
     */
    function _hookedEscrow() private returns (BonusEscrow hooked, HookToken hookToken, ReentrantReceiver receiver) {
        hookToken = new HookToken("Hook Bonus", "hBONUS", 18);
        MisreportingVault hookVault =
            new MisreportingVault(address(npmMock), address(hookToken), address(usdcToken), FEE, address(poolMock));
        hooked = _deployBonusEscrowProxy(address(hookToken), address(hookVault), address(this), carol);
        hookToken.mint(address(hooked), 10 * BONUS);

        receiver = new ReentrantReceiver();
        hookToken.setHooked(address(receiver), true);
    }

    /// @dev Reads the ERC-1967 implementation slot straight off the proxy.
    function _implementationOf(address proxy) private view returns (address) {
        return address(uint160(uint256(vm.load(proxy, ERC1967Utils.IMPLEMENTATION_SLOT))));
    }
}
