// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm, VmSafe} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";
import {LocalHarness} from "../utils/LocalHarness.sol";
import {LPStakingVault} from "../../../contracts/lp-staking/LPStakingVault.sol";
import {LPProxy} from "../../../contracts/lp-staking/deploy/LPProxy.sol";
import {IBonusEscrowHooks} from "../../../contracts/lp-staking/interfaces/IBonusEscrowHooks.sol";
import {MockBonusEscrow} from "../../../contracts/lp-staking/mocks/MockBonusEscrow.sol";
import {MockForfeitingBonusEscrow} from "../../../contracts/lp-staking/mocks/MockForfeitingBonusEscrow.sol";
import {MockLightBonusEscrow} from "../../../contracts/lp-staking/mocks/MockLightBonusEscrow.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @notice Why this file exists: the vault reports every `unstake` and every `rebalance` to the
 *         bonus escrow it is linked to, and the two reports carry OPPOSITE failure rules. The
 *         exit fails OPEN — no escrow state, no escrow bug and no gas trick may keep a staker's
 *         position in the vault — while the rebalance fails CLOSED, because a rebalance that
 *         could skip the escrow is a withdrawal the escrow never sees (B.3 decision document,
 *         P3). Both rules, the gas floor that stops a caller from starving the exit hook on
 *         purpose, the order in which the vault calls the escrow, and the off switch
 *         (`bonusEscrow == 0`, the mainnet launch state) are each stated here as assertions.
 *
 *  Three escrow mocks are used:
 *    - {MockLightBonusEscrow} records each notification as an event — its own bookkeeping costs
 *      a few thousand gas — and reports the gas the hook actually received, so the "the vault
 *      calls the hook, in this order, with this allowance" tests never depend on a mock's
 *      storage writes fitting the allowance (they do not, in the unoptimized coverage build);
 *    - {MockBonusEscrow} reverts or burns its gas on demand, and records the rebalance hook
 *      (which has no gas cap) in storage;
 *    - {MockForfeitingBonusEscrow} does the real escrow's forfeiture work in the real storage
 *      shape, behind an {LPProxy}, and is what the vault's {LPStakingVault-BONUS_HOOK_GAS} was
 *      sized against (`test_HookGas_*`).
 */
contract VaultBonusHooksTest is LocalHarness {
    /// @dev `real.lp.storage.LPStakingVault`, the vault's ERC-7201 base.
    bytes32 internal constant VAULT_STORAGE = 0x4c835a63e69815f7352ca18e845a5d8023cea9abbc2e923eb7a3a481844a6500;

    /// @dev What the hook's own dispatch costs before its first instruction can read
    ///      `gasleft()`: the selector jump and the ABI decoder. Measured: 99,764 at entry in the
    ///      optimized build, 99,618 in the unoptimized coverage build — 2,000 covers both.
    uint256 internal constant HOOK_ENTRY_OVERHEAD = 2_000;

    bytes32 internal constant UNSTAKE_SEEN = keccak256("UnstakeSeen(uint256,uint256,address,address)");

    /// @dev A tokenId no real position uses, for the measurements that bypass the vault.
    uint256 internal constant MEASURED_ID = 7;

    MockBonusEscrow internal escrow;
    MockLightBonusEscrow internal light;
    MockForfeitingBonusEscrow internal forfeiting;

    /// @dev One `UnstakeSeen` the light escrow emitted, decoded.
    struct Seen {
        uint256 tokenId;
        uint256 gasAtEntry;
        address stakerAtHook;
        address nftOwnerAtHook;
    }

    function setUp() public {
        _deployLocalStack();
        escrow = new MockBonusEscrow(address(vault));
        light = new MockLightBonusEscrow(address(vault), address(npmMock), false);

        // The forfeiting escrow and its reservation are created HERE, so that in every test
        // the reservation slots, the escrow's proxy and its implementation are cold again —
        // the state a real exit meets them in.
        MockForfeitingBonusEscrow impl = new MockForfeitingBonusEscrow();
        forfeiting = MockForfeitingBonusEscrow(
            address(new LPProxy(address(impl), abi.encodeCall(MockForfeitingBonusEscrow.initialize, (address(vault)))))
        );
        forfeiting.reserve(MEASURED_ID, alice, 1_000e18, uint64(block.timestamp + 30 days));
    }

    // ──────────────────────── Constants ────────────────────────

    /// @dev EIP-150 forwards at most 63/64 of the remaining gas, so the floor is the allowance
    ///      scaled by 64/63 plus the call's own overhead — the vault's NatSpec, as numbers.
    function test_Constants_TheFloorCoversTheAllowanceAfterTheSixtyFourthRule() public view {
        assertEq(vault.BONUS_HOOK_GAS(), 100_000, "the hook's allowance");
        assertEq(vault.BONUS_HOOK_GAS_FLOOR(), (uint256(100_000) * 64) / 63 + 5_000, "the floor's formula");
        assertEq(vault.BONUS_HOOK_GAS_FLOOR(), 106_587, "the floor's value");
        assertGe(
            (vault.BONUS_HOOK_GAS_FLOOR() - 5_000) * 63 / 64,
            vault.BONUS_HOOK_GAS() - 1,
            "63/64 of the floor minus the overhead is the allowance (to the wei of integer division)"
        );
    }

    // ──────────────────────── The link ─────────────────────────

    function test_BonusEscrow_IsZeroByDefault() public view {
        assertEq(vault.bonusEscrow(), address(0), "a fresh vault notifies nobody, as mainnet launches");
    }

    /// @dev The link decides what every exit and every rebalance calls, so it is owner-tier:
    ///      the guardian, the operator and a stranger are all refused.
    function test_SetBonusEscrow_IsOwnerOnly() public {
        LPStakingVault v = _deployVaultProxy(
            VaultProxyParams({
                positionManager: address(npmMock),
                pool: address(poolMock),
                token0: token0,
                token1: token1,
                fee: FEE,
                swapRouter: address(routerMock),
                owner: address(this),
                guardian: multisig,
                operator: operatorSafe,
                zapper: address(0),
                twapWindow: MIN_TWAP_WINDOW,
                maxDeviationTicks: 500
            })
        );
        address[3] memory refused = [multisig, operatorSafe, stranger];
        for (uint256 i = 0; i < refused.length; ++i) {
            vm.prank(refused[i]);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, refused[i]));
            v.setBonusEscrow(address(escrow));
        }
        assertEq(v.bonusEscrow(), address(0), "nobody but the owner moved the link");

        v.setBonusEscrow(address(escrow));
        assertEq(v.bonusEscrow(), address(escrow), "the owner links it");
    }

    /// @dev Full state in every event: link, re-link, unlink, each carrying both sides.
    function test_SetBonusEscrow_AnnouncesBothSides() public {
        MockBonusEscrow second = new MockBonusEscrow(address(vault));

        vm.expectEmit(false, false, false, true, address(vault));
        emit LPStakingVault.BonusEscrowSet(address(0), address(escrow));
        vault.setBonusEscrow(address(escrow));

        vm.expectEmit(false, false, false, true, address(vault));
        emit LPStakingVault.BonusEscrowSet(address(escrow), address(second));
        vault.setBonusEscrow(address(second));

        vm.expectEmit(false, false, false, true, address(vault));
        emit LPStakingVault.BonusEscrowSet(address(second), address(0));
        vault.setBonusEscrow(address(0));
        assertEq(vault.bonusEscrow(), address(0), "unlinked again");
    }

    /**
     * @dev An address with no code is refused. Solidity checks the callee's code size BEFORE a
     *      `try` call and that check reverts in the vault itself, outside the `catch` — so an
     *      escrow address without code would make every `unstake` revert, the one thing that
     *      must never happen.
     */
    function test_SetBonusEscrow_RejectsAnAddressWithoutCode() public {
        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.NotAContract.selector, alice));
        vault.setBonusEscrow(alice);
        assertEq(vault.bonusEscrow(), address(0), "the refused link is not stored");
    }

    /// @dev Zero is the off switch: after an unlink, an exit and a rebalance call nobody.
    function test_SetBonusEscrow_ZeroSwitchesTheNotificationsOff() public {
        vault.setBonusEscrow(address(escrow));
        vault.setBonusEscrow(address(0));

        uint256 tokenId = _stakePosition(alice);
        vm.prank(alice);
        uint256 rebalanced = vault.rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, _noSwap(), FAR_DEADLINE);
        vm.prank(alice);
        vault.unstake(rebalanced);

        assertEq(escrow.unstakeCalls(), 0, "an unlinked escrow hears of no exit");
        assertEq(escrow.rebalanceCalls(), 0, "nor of any rebalance");
    }

    /**
     * @dev `bonusEscrow` was APPENDED to the vault's namespace: after `operator` (slot 4), so it
     *      opens slot 5 and every field before it — the custody ledger included — kept its slot.
     */
    function test_Storage_BonusEscrowSitsAtNamespaceSlotFive() public {
        bytes32 expected =
            keccak256(abi.encode(uint256(keccak256("real.lp.storage.LPStakingVault")) - 1)) & ~bytes32(uint256(0xff));
        assertEq(expected, VAULT_STORAGE, "the pinned base");

        vault.setBonusEscrow(address(escrow));

        assertEq(
            address(uint160(uint256(vm.load(address(vault), VAULT_STORAGE)))), address(zapper), "slot 0 is `zapper`"
        );
        assertEq(
            address(uint160(uint256(vm.load(address(vault), bytes32(uint256(VAULT_STORAGE) + 4))))),
            address(this),
            "slot 4 is still `operator`"
        );
        assertEq(
            address(uint160(uint256(vm.load(address(vault), bytes32(uint256(VAULT_STORAGE) + 5))))),
            address(escrow),
            "slot 5 is `bonusEscrow`"
        );
    }

    // ──────────────────────── No escrow: no call, no floor ─────

    function test_Unstake_WithNoEscrowMakesNoCall() public {
        uint256 tokenId = _stakePosition(alice);

        vm.prank(alice);
        vault.unstake(tokenId);

        assertEq(escrow.unstakeCalls(), 0, "an escrow nobody linked is never called");
        assertEq(npmMock.ownerOf(tokenId), alice, "and the exit completes");
    }

    /// @dev The gas floor guards the hook, so it only applies when there is a hook to guard:
    ///      with no escrow an exit runs on far less gas than the floor.
    function test_Unstake_WithNoEscrowNeedsNoGasFloor() public {
        uint256 tokenId = _stakePosition(alice);
        uint256 limit = vault.BONUS_HOOK_GAS_FLOOR() / 2;

        vm.prank(alice);
        vault.unstake{gas: limit}(tokenId);

        assertEq(npmMock.ownerOf(tokenId), alice, "an exit with no escrow must not need the floor");
    }

    function test_Rebalance_WithNoEscrowMakesNoCall() public {
        uint256 tokenId = _stakePosition(alice);

        vm.prank(alice);
        uint256 newTokenId = vault.rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, _noSwap(), FAR_DEADLINE);

        assertEq(escrow.rebalanceCalls(), 0, "an escrow nobody linked is never called");
        assertEq(vault.stakerOf(newTokenId), alice, "and the rebalance completes");
    }

    // ──────────────────────── unstake: the notification ────────

    /**
     * @dev The vault's promise on the exit hook's position in the sequence: AFTER the staker
     *      record is deleted (so the escrow can never be told about an exit that then fails to
     *      clear the record) and BEFORE the NFT leaves (so the escrow sees the position while
     *      it is still in custody). Both are read by the escrow from inside the hook.
     */
    function test_Unstake_NotifiesTheEscrowAfterTheRecordIsDeletedAndBeforeTheNftLeaves() public {
        vault.setBonusEscrow(address(light));
        uint256 tokenId = _stakePosition(alice);

        vm.recordLogs();
        vm.prank(alice);
        vault.unstake(tokenId);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        Seen[] memory seen = _unstakeSeen(logs);
        assertEq(seen.length, 1, "exactly one notification per exit");
        assertEq(seen[0].tokenId, tokenId, "naming the position that left");
        assertEq(seen[0].stakerAtHook, address(0), "the staker record was already deleted");
        assertEq(seen[0].nftOwnerAtHook, address(vault), "and the NFT was still in custody");
        assertEq(npmMock.ownerOf(tokenId), alice, "after the hook, the NFT reached the staker");
        assertEq(_countBonusHookFailed(logs), 0, "a hook that succeeds raises no alarm");
    }

    /// @dev The vault forwards the hook its WHOLE allowance: what the escrow sees at its first
    ///      instruction is {BONUS_HOOK_GAS} less the dispatch cost, never a 63/64 remainder.
    function test_Unstake_ForwardsTheFullAllowanceToTheHook() public {
        vault.setBonusEscrow(address(light));
        uint256 tokenId = _stakePosition(alice);

        vm.recordLogs();
        vm.prank(alice);
        vault.unstake(tokenId);

        uint256 atEntry = _unstakeSeen(vm.getRecordedLogs())[0].gasAtEntry;
        assertLe(atEntry, vault.BONUS_HOOK_GAS(), "never more than the allowance");
        assertGe(atEntry, vault.BONUS_HOOK_GAS() - HOOK_ENTRY_OVERHEAD, "and the whole allowance, less dispatch");
        console.log("gasleft() at the hook's first instruction", atEntry);
    }

    // ──────────────────────── unstake: fail open ───────────────

    /// @dev A reverting escrow never blocks an exit: the position goes back to its staker and
    ///      the vault raises `BonusHookFailed` — which the backend alerts on — before `Unstaked`.
    function test_Unstake_ARevertingEscrowNeverBlocksTheExit() public {
        escrow.setMode(MockBonusEscrow.Mode.RevertOnUnstake);
        vault.setBonusEscrow(address(escrow));
        uint256 tokenId = _stakePosition(alice);

        vm.expectEmit(true, false, false, true, address(vault));
        emit LPStakingVault.BonusHookFailed(tokenId);
        vm.expectEmit(true, true, false, true, address(vault));
        emit LPStakingVault.Unstaked(alice, tokenId, block.timestamp);
        vm.prank(alice);
        vault.unstake(tokenId);

        assertEq(npmMock.ownerOf(tokenId), alice, "the position must be back with its staker");
        assertEq(vault.stakerOf(tokenId), address(0), "and the record cleared");
        assertEq(escrow.unstakeCalls(), 0, "the escrow's own writes were rolled back with its revert");
    }

    /**
     * @dev An escrow that spends every unit of its allowance — the shape of an escrow bug that
     *      loops, or of one an attacker could make expensive — still cannot hold the exit: the
     *      out-of-gas stays inside the hook's frame, `catch` takes it, and the exit completes.
     *      The cost to the staker is bounded by the allowance: the burning exit spends at most
     *      {BONUS_HOOK_GAS} plus the call and event overhead more than an exit with no escrow.
     */
    function test_Unstake_AnEscrowThatBurnsItsAllowanceNeverBlocksTheExit() public {
        uint256 first = _stakePosition(alice);
        uint256 second = _stakePosition(alice);

        vm.prank(alice);
        uint256 before = gasleft();
        vault.unstake(first);
        uint256 withoutEscrow = before - gasleft();

        escrow.setMode(MockBonusEscrow.Mode.BurnGasOnUnstake);
        vault.setBonusEscrow(address(escrow));

        vm.expectEmit(true, false, false, true, address(vault));
        emit LPStakingVault.BonusHookFailed(second);
        vm.prank(alice);
        before = gasleft();
        vault.unstake(second);
        uint256 withBurningEscrow = before - gasleft();

        assertEq(npmMock.ownerOf(second), alice, "the exit completed");
        assertGt(withBurningEscrow, withoutEscrow + vault.BONUS_HOOK_GAS() / 2, "the escrow really burned its gas");
        assertLe(
            withBurningEscrow,
            withoutEscrow + vault.BONUS_HOOK_GAS() + 10_000,
            "but never more than its allowance plus the call and the event"
        );
        console.log("unstake gas without an escrow", withoutEscrow);
        console.log("unstake gas with an escrow that burns its allowance", withBurningEscrow);
    }

    /**
     * @dev Below the floor the exit REVERTS rather than letting the hook run short: a caller
     *      who tunes the gas limit so the hook runs out while the exit completes would keep a
     *      bonus that should have been forfeited. A revert costs the staker one retry; it
     *      never keeps the position, and here it changes nothing at all.
     */
    function test_Unstake_RevertsBelowTheGasFloor() public {
        vault.setBonusEscrow(address(light));
        uint256 tokenId = _stakePosition(alice);

        // Read before the prank: a view call in the call options would consume the cheatcodes.
        uint256 floor = vault.BONUS_HOOK_GAS_FLOOR();

        // The whole call gets exactly the floor; the record lookup and deletion before the
        // check spend some of it, so `gasleft()` at the check is below the floor.
        vm.prank(alice);
        vm.expectRevert(LPStakingVault.InsufficientGasForBonusHook.selector);
        vault.unstake{gas: floor}(tokenId);

        assertEq(vault.stakerOf(tokenId), alice, "a refused exit leaves the record");
        assertEq(npmMock.ownerOf(tokenId), address(vault), "and the custody");

        // The same exit with room for the hook and the transfer goes through.
        vm.recordLogs();
        vm.prank(alice);
        vault.unstake{gas: floor + 150_000}(tokenId);
        Seen[] memory seen = _unstakeSeen(vm.getRecordedLogs());
        assertEq(npmMock.ownerOf(tokenId), alice, "a retry with enough gas completes");
        assertEq(seen.length, 1, "and the escrow heard of it");
        assertGe(seen[0].gasAtEntry, vault.BONUS_HOOK_GAS() - HOOK_ENTRY_OVERHEAD, "with its whole allowance");
    }

    /**
     * @dev The floor's real claim, fuzzed over the gas limit: an exit that SUCCEEDS has always
     *      given the hook its whole allowance. The light escrow reports the gas it actually
     *      received at its first instruction, so a starved hook would show up as a smaller
     *      figure behind a successful exit — which this test forbids. Below the threshold the
     *      exit reverts and nothing moves.
     */
    function testFuzz_Unstake_ASuccessfulExitAlwaysGaveTheHookItsAllowance(uint256 limitSeed) public {
        vault.setBonusEscrow(address(light));
        uint256 tokenId = _stakePosition(alice);
        uint256 allowance = vault.BONUS_HOOK_GAS();
        uint256 limit = bound(limitSeed, vault.BONUS_HOOK_GAS_FLOOR() - 20_000, vault.BONUS_HOOK_GAS_FLOOR() + 250_000);

        vm.recordLogs();
        vm.prank(alice);
        (bool ok,) = address(vault).call{gas: limit}(abi.encodeCall(LPStakingVault.unstake, (tokenId)));
        Seen[] memory seen = _unstakeSeen(vm.getRecordedLogs());

        if (ok) {
            assertEq(seen.length, 1, "a successful exit ran the hook to completion");
            assertGe(
                seen[0].gasAtEntry,
                allowance - HOOK_ENTRY_OVERHEAD,
                "with its whole allowance, whatever the caller's gas limit"
            );
            assertEq(npmMock.ownerOf(tokenId), alice, "and the position left");
        } else {
            assertEq(seen.length, 0, "a failed exit leaves no notification behind");
            assertEq(vault.stakerOf(tokenId), alice, "and the record in place");
        }
    }

    // ──────────────────────── rebalance: the notification ──────

    /**
     * @dev The rebalance hook carries both positions. The OLD one must be read BEFORE its
     *      liquidity is withdrawn — after the withdrawal its liquidity is zero and the escrow
     *      could value nothing — and the NEW one is the range the caller asked for with the
     *      liquidity the mint returned. At hook time the record has already moved.
     */
    function test_Rebalance_ReportsBothPositionsAndCallsAfterTheRecordMoved() public {
        vault.setBonusEscrow(address(escrow));
        uint256 tokenId = _stakePosition(alice);

        vm.prank(alice);
        uint256 newTokenId = vault.rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, _noSwap(), FAR_DEADLINE);

        assertEq(escrow.rebalanceCalls(), 1, "exactly one notification per rebalance");
        assertEq(escrow.lastOldTokenId(), tokenId, "naming the old position");
        assertEq(escrow.lastNewTokenId(), newTokenId, "and the new one");

        IBonusEscrowHooks.Snapshot memory old_ = escrow.lastOld();
        assertEq(old_.tickLower, TICK_LOWER, "the old range's lower tick");
        assertEq(old_.tickUpper, TICK_UPPER, "the old range's upper tick");
        assertEq(old_.liquidity, LIQUIDITY, "the old liquidity as it was BEFORE the withdrawal");

        IBonusEscrowHooks.Snapshot memory new_ = escrow.lastNew();
        (,,,,, int24 lower, int24 upper, uint128 minted,,,,) = npmMock.positions(newTokenId);
        assertEq(new_.tickLower, NEW_TICK_LOWER, "the new range's lower tick");
        assertEq(new_.tickUpper, NEW_TICK_UPPER, "the new range's upper tick");
        assertEq(lower, NEW_TICK_LOWER, "as minted");
        assertEq(upper, NEW_TICK_UPPER, "as minted");
        assertEq(new_.liquidity, minted, "the liquidity the mint returned");

        assertEq(escrow.newStakerAtRebalance(), alice, "the record had moved to the new NFT");
        assertEq(escrow.oldStakerAtRebalance(), address(0), "and left the old one");
    }

    // ──────────────────────── rebalance: fail closed ───────────

    /**
     * @dev A reverting escrow reverts the rebalance — the whole of it: the old position keeps
     *      its liquidity, its record and its custody, and no new position exists.
     */
    function test_Rebalance_ARevertingEscrowRevertsTheRebalance() public {
        escrow.setMode(MockBonusEscrow.Mode.RevertOnRebalance);
        vault.setBonusEscrow(address(escrow));
        uint256 tokenId = _stakePosition(alice);
        uint256 lastMintedBefore = npmMock.lastMintedId();

        vm.prank(alice);
        vm.expectRevert(MockBonusEscrow.EscrowRejects.selector);
        vault.rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, _noSwap(), FAR_DEADLINE);

        (,,,,,,, uint128 liquidity,,,,) = npmMock.positions(tokenId);
        assertEq(liquidity, LIQUIDITY, "the old position keeps its liquidity");
        assertEq(vault.stakerOf(tokenId), alice, "and its record");
        assertEq(npmMock.ownerOf(tokenId), address(vault), "and its custody");
        assertEq(npmMock.lastMintedId(), lastMintedBefore, "and no new position exists");
        assertEq(escrow.rebalanceCalls(), 0, "and the escrow recorded nothing");
    }

    /// @dev Failing closed on `rebalance` never traps a position: with the escrow refusing
    ///      every rebalance, the exit still works.
    function test_Unstake_StillWorksWhileTheEscrowRefusesEveryRebalance() public {
        MockLightBonusEscrow refusing = new MockLightBonusEscrow(address(vault), address(npmMock), true);
        vault.setBonusEscrow(address(refusing));
        uint256 tokenId = _stakePosition(alice);

        vm.prank(alice);
        vm.expectRevert(MockLightBonusEscrow.EscrowRejects.selector);
        vault.rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, _noSwap(), FAR_DEADLINE);

        vm.recordLogs();
        vm.prank(alice);
        vault.unstake(tokenId);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(npmMock.ownerOf(tokenId), alice, "the exit is unconditional");
        assertEq(_unstakeSeenFrom(logs, address(refusing)), 1, "and the escrow still heard of it");
        assertEq(_countBonusHookFailed(logs), 0, "without any failure");
    }

    // ──────────────────────── Measurements ─────────────────────

    /**
     * @dev The measurement {LPStakingVault-BONUS_HOOK_GAS} was sized from: the real escrow's
     *      forfeiture of a live reservation, behind an ERC-1967 proxy, everything cold, measured
     *      from the caller (the cold-account charge of the escrow proxy included). Measured
     *      29,941 gas in the optimized build; asserted below a third of the allowance, so the
     *      escrow's real code has room to differ (see {_measuredBound} for the coverage build).
     */
    function test_HookGas_ARealisticForfeitureFitsTheAllowanceWithRoom() public {
        vm.prank(address(vault));
        uint256 before = gasleft();
        forfeiting.onUnstake(MEASURED_ID);
        uint256 used = before - gasleft();

        (, uint256 amount,,, bool forfeited) = forfeiting.reservationOf(MEASURED_ID);
        assertEq(amount, 0, "the measured call really forfeited");
        assertTrue(forfeited, "and marked the reservation");
        assertLt(used, _measuredBound(), "a realistic forfeiture uses a fraction of the allowance");
        console.log("onUnstake gas, forfeiting a live reservation (caller-measured)", used);
    }

    /// @dev The common case — a position that never had a bonus — is the cheaper branch.
    function test_HookGas_APositionWithNoReservationIsCheaper() public {
        vm.prank(address(vault));
        uint256 before = gasleft();
        forfeiting.onUnstake(MEASURED_ID + 1);
        uint256 used = before - gasleft();

        assertLt(used, _measuredBound(), "far inside the allowance");
        console.log("onUnstake gas, no reservation (caller-measured)", used);
    }

    /**
     * @dev The real flow end to end: the vault linked to the forfeiting escrow, a live
     *      reservation on a staked position, the staker exits before the cliff — the hook,
     *      running inside the vault's fixed allowance, forfeits the bonus, and nothing failed.
     */
    function test_HookGas_TheRealFlowForfeitsTheReservationOnUnstake() public {
        vault.setBonusEscrow(address(forfeiting));
        uint256 tokenId = _stakePosition(alice);
        forfeiting.reserve(tokenId, alice, 500e18, uint64(block.timestamp + 30 days));
        uint256 reservedBefore = forfeiting.totalReserved();

        vm.recordLogs();
        vm.prank(alice);
        vault.unstake(tokenId);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        (address beneficiary, uint256 amount,,, bool forfeited) = forfeiting.reservationOf(tokenId);
        assertEq(beneficiary, alice, "the record stays, so the NFT can never carry a second bonus");
        assertEq(amount, 0, "the amount is gone");
        assertTrue(forfeited, "the reservation is forfeited");
        assertEq(forfeiting.totalReserved(), reservedBefore - 500e18, "and the escrow's total released it");
        assertEq(_countBonusHookFailed(logs), 0, "the hook fitted its allowance: no failure raised");
        assertEq(npmMock.ownerOf(tokenId), alice, "and the exit completed");
    }

    // ──────────────────────── Helpers ──────────────────────────

    /**
     * @dev The ceiling the measurements are held to: a third of the allowance in the optimized
     *      build the vault ships with. `forge coverage --ir-minimum` compiles WITHOUT the
     *      optimizer, and the same escrow code costs about 16 % more there (34,876 vs 29,941 measured),
     *      so under coverage — and only there — the ceiling is half the allowance. The
     *      optimized figure is the one the allowance was sized against.
     */
    function _measuredBound() private view returns (uint256) {
        return vm.isContext(VmSafe.ForgeContext.Coverage) ? vault.BONUS_HOOK_GAS() / 2 : vault.BONUS_HOOK_GAS() / 3;
    }

    /// @dev Every `UnstakeSeen` the light escrow ({light}) emitted in `logs`, decoded.
    function _unstakeSeen(Vm.Log[] memory logs) private view returns (Seen[] memory out) {
        uint256 n = _unstakeSeenFrom(logs, address(light));
        out = new Seen[](n);
        uint256 k;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter == address(light) && logs[i].topics[0] == UNSTAKE_SEEN) {
                (uint256 gasAtEntry, address stakerAtHook, address nftOwnerAtHook) =
                    abi.decode(logs[i].data, (uint256, address, address));
                out[k++] = Seen({
                    tokenId: uint256(logs[i].topics[1]),
                    gasAtEntry: gasAtEntry,
                    stakerAtHook: stakerAtHook,
                    nftOwnerAtHook: nftOwnerAtHook
                });
            }
        }
    }

    /// @dev Number of `UnstakeSeen` events `emitter` emitted in `logs`.
    function _unstakeSeenFrom(Vm.Log[] memory logs, address emitter) private pure returns (uint256 count) {
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter == emitter && logs[i].topics[0] == UNSTAKE_SEEN) ++count;
        }
    }

    /// @dev Number of `BonusHookFailed` events the vault emitted in `logs`.
    function _countBonusHookFailed(Vm.Log[] memory logs) private view returns (uint256 count) {
        bytes32 topic = keccak256("BonusHookFailed(uint256)");
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == topic) ++count;
        }
    }
}
