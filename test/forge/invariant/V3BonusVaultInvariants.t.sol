// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";

import {StakingV3Harness} from "../utils/StakingV3Harness.sol";
import {V3BonusVault} from "../../../contracts/staking-v3/V3BonusVault.sol";
import {WeightedStakingPoolV3} from "../../../contracts/staking-v3/WeightedStakingPoolV3.sol";
import {IBonusEscrowHooks} from "../../../contracts/lp-staking/interfaces/IBonusEscrowHooks.sol";
import {MockERC20Permit} from "../../../contracts/lp-staking/mocks/MockERC20Permit.sol";

/**
 * @notice Bounded actor on a {V3BonusVault} whose pool is a real v3 pool: the migrator's two
 *         reserves, a direct `stake` in the pool (its new-stake bonus, route 4), the pool's early
 *         exit (v3 part and active LP parts), the vault's unstake and rebalance (with random value
 *         ratios), a `hold` step and a directed `claimHeld` step (the vault holds an id for its
 *         user from then on, a mocked `stakerOf`, so the held pay path of `_lpClaimable` is
 *         fuzzed), the permissionless `reconcileLp` (it forfeits an active id the vault does not
 *         hold), clock warps, funding,
 *         the three claims (`claim`, `claimV3`, `claimLp`), `claimLp` on another wallet's id and on
 *         an old id a rebalance deleted, and surplus recoveries. Per-step properties are checked
 *         around the step and kept as violation counters; state properties are checked by the
 *         invariant functions.
 */
contract V3BonusVaultHandler is Test {
    V3BonusVault internal immutable book;
    MockERC20Permit internal immutable asset;
    address internal immutable migrator;
    address internal immutable pool;
    address internal immutable vault;
    address internal immutable owner;
    int24 internal immutable lower;
    int24 internal immutable upper;

    address[3] internal users;
    uint256 internal nextId = 1;
    /// @dev The highest amount each tokenId may ever hold (its reserve, or what it was moved from).
    mapping(uint256 => uint256) public ceiling;

    uint256 public funded;
    uint256 public paid;
    uint256 public recovered;
    uint256 public scalingViolations;
    uint256 public shortClaimViolations;
    uint256 public overpayViolations;
    /// @dev An early exit left an active LP record of the user, or forfeited a non-active one.
    uint256 public earlyExitViolations;
    /// @dev A `claimLp` on another wallet's id or on a deleted old id that did not revert with its
    ///      expected error, or that changed state.
    uint256 public wrongClaimViolations;
    /// @dev Expected reverts, counted apart so they hide no real one: `NotLpReservationUser` on
    ///      another wallet's id, `NothingToClaim` on an old id a rebalance deleted.
    uint256 public expectedOwnerReverts;
    uint256 public expectedEmptyReverts;
    /// @dev LP records paid while neither settled nor missed-after: the HELD path of
    ///      `_lpClaimable` (the handler never mocks `listenerMissedAt`, so it is zero).
    uint256 public heldPaid;
    uint256 public holds;
    /// @dev The old ids of rebalances that moved the record (deleted under the old id).
    uint256[] internal oldIds;
    /// @dev The real v3 pool behind `pool` (the new-stake bonus, 2026-11-12) and its voucher key.
    WeightedStakingPoolV3 internal immutable stakePool;
    uint256 internal immutable signerPk;
    /// @dev A direct stake whose v3 reservation did not grow by exactly `previewStakeBonus`.
    uint256 public stakeBonusViolations;
    uint256 public directStakes;

    constructor(
        V3BonusVault book_,
        MockERC20Permit asset_,
        address migrator_,
        address pool_,
        address vault_,
        address owner_,
        int24 lower_,
        int24 upper_,
        WeightedStakingPoolV3 stakePool_,
        uint256 signerPk_
    ) {
        stakePool = stakePool_;
        signerPk = signerPk_;
        book = book_;
        asset = asset_;
        migrator = migrator_;
        pool = pool_;
        vault = vault_;
        owner = owner_;
        lower = lower_;
        upper = upper_;
        users = [makeAddr("u0"), makeAddr("u1"), makeAddr("u2")];
    }

    function _user(uint256 seed) internal view returns (address) {
        return users[seed % 3];
    }

    function reserve(uint256 seed, uint256 amount, uint256 lockFor) external {
        amount = bound(amount, 1, 1e24);
        lockFor = bound(lockFor, 1, 30 days);
        vm.prank(migrator);
        book.reserve(_user(seed), amount, uint64(block.timestamp + lockFor), uint8(1 + seed % 3));
    }

    function reserveLp(uint256 seed, uint256 amount, uint256 lockFor) external {
        amount = bound(amount, 1, 1e24);
        lockFor = bound(lockFor, 1, 30 days);
        uint256 id = nextId++;
        vm.prank(migrator);
        book.reserveLp(id, _user(seed), amount, uint64(block.timestamp + lockFor));
        ceiling[id] = amount;
    }

    /// @dev Rule of 2026-11-12: the exit forfeits the v3 part (while locked) and every ACTIVE LP
    ///      record of the user (open, before its unlock); every other record is left as it was.
    /// @dev A direct stake in the real v3 pool, with a voucher from the pool's signer: the
    ///      user's v3 reservation grows by exactly `previewStakeBonus(amount)` (route 4).
    function stake(uint256 seed, uint256 amount) external {
        if (block.timestamp >= stakePool.endEpoch()) return;
        address user = _user(seed);
        amount = bound(amount, 1, 1e24);
        vm.prank(owner);
        asset.transfer(user, amount);
        vm.prank(user);
        asset.approve(address(stakePool), amount);
        uint256 preview = stakePool.previewStakeBonus(amount);
        (uint256 before,) = book.reservedOf(user);
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("WeightedStakingPool"),
                keccak256("1"),
                block.chainid,
                address(stakePool)
            )
        );
        bytes32 structHash =
            keccak256(abi.encode(stakePool.STAKE_VOUCHER_TYPEHASH(), user, stakePool.nonces(user), block.timestamp));
        (uint8 v, bytes32 r, bytes32 sg) =
            vm.sign(signerPk, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        vm.prank(user);
        stakePool.stake(amount, block.timestamp, abi.encodePacked(r, sg, v));
        (uint256 afterAmount,) = book.reservedOf(user);
        if (afterAmount - before != preview) stakeBonusViolations++;
        directStakes++;
    }

    function earlyExit(uint256 seed) external {
        address user = _user(seed);
        uint256[] memory ids = book.lpTokensOf(user);
        bool[] memory wasActive = new bool[](ids.length);
        uint256[] memory amountBefore = new uint256[](ids.length);
        for (uint256 j = 0; j < ids.length; ++j) {
            (, uint256 lp, uint64 unlockAt, bool claimed, bool forfeited) = book.lpReservation(ids[j]);
            wasActive[j] = !claimed && !forfeited && block.timestamp < unlockAt;
            amountBefore[j] = lp;
        }
        vm.prank(pool);
        book.onEarlyExit(user);
        for (uint256 j = 0; j < ids.length; ++j) {
            (, uint256 lp,,, bool forfeited) = book.lpReservation(ids[j]);
            if (wasActive[j] && (!forfeited || lp != 0)) earlyExitViolations++;
            if (!wasActive[j] && lp != amountBefore[j]) earlyExitViolations++;
        }
    }

    function unstake(uint256 idSeed) external {
        if (nextId == 1) return;
        vm.prank(vault);
        book.onUnstake(1 + idSeed % (nextId - 1));
    }

    function rebalance(uint256 idSeed, uint128 oldL, uint128 newL) external {
        if (nextId == 1) return;
        uint256 oldId = 1 + idSeed % (nextId - 1);
        oldL = uint128(bound(oldL, 0, 1e22));
        newL = uint128(bound(newL, 0, 1e22));
        (, uint256 before,,,) = book.lpReservation(oldId);
        uint256 newId = nextId++;
        vm.prank(vault);
        book.onRebalance(
            oldId, newId, IBonusEscrowHooks.Snapshot(lower, upper, oldL), IBonusEscrowHooks.Snapshot(lower, upper, newL)
        );
        (address movedUser, uint256 moved,,,) = book.lpReservation(newId);
        if (movedUser != address(0)) {
            if (moved > before || moved > ceiling[oldId]) scalingViolations++;
            ceiling[newId] = before;
            oldIds.push(oldId);
        }
    }

    /// @dev The vault HOLDS `id` for the record's user from now on (a mocked `stakerOf`), so an
    ///      unlocked open record pays through the held path of `_lpClaimable`. Without this step no
    ///      handler id is staked in the vault and only settled records pay.
    function hold(uint256 idSeed) external {
        if (nextId == 1) return;
        uint256 id = 1 + idSeed % (nextId - 1);
        (address user,,,,) = book.lpReservation(id);
        if (user == address(0)) return;
        vm.mockCall(vault, abi.encodeWithSignature("stakerOf(uint256)", id), abi.encode(user));
        holds++;
    }

    function reconcile(uint256 idSeed) external {
        if (nextId == 1) return;
        book.reconcileLp(1 + idSeed % (nextId - 1));
    }

    function warp(uint256 by) external {
        vm.warp(block.timestamp + bound(by, 1, 10 days));
    }

    function fund(uint256 amount) external {
        amount = bound(amount, 1, 1e24);
        vm.startPrank(owner);
        asset.approve(address(book), amount);
        book.fund(amount);
        vm.stopPrank();
        funded += amount;
    }

    function claim(uint256 seed) external {
        address user = _user(seed);
        uint256 due = book.claimable(user);
        uint256 balance = asset.balanceOf(address(book));
        uint256 before = asset.balanceOf(user);
        uint256[] memory ids = book.lpTokensOf(user);
        bool[] memory wasClaimed = new bool[](ids.length);
        for (uint256 j = 0; j < ids.length; ++j) {
            (,,, wasClaimed[j],) = book.lpReservation(ids[j]);
        }
        vm.prank(user);
        try book.claim() returns (uint256 amount) {
            if (amount != due) overpayViolations++;
            if (asset.balanceOf(user) - before != amount) overpayViolations++;
            paid += amount;
            for (uint256 j = 0; j < ids.length; ++j) {
                (,,, bool claimed,) = book.lpReservation(ids[j]);
                if (claimed && !wasClaimed[j] && !book.lpSettled(ids[j])) heldPaid++;
            }
        } catch {
            if (due > 0 && balance >= due) shortClaimViolations++;
        }
    }

    /// @dev `claimV3` pays exactly the unlocked v3 part, and `claimable` drops by exactly that.
    function claimV3(uint256 seed) external {
        address user = _user(seed);
        (uint256 v3, uint64 unlockAt) = book.reservedOf(user);
        uint256 due = block.timestamp >= unlockAt ? v3 : 0;
        uint256 claimableBefore = book.claimable(user);
        uint256 balance = asset.balanceOf(address(book));
        uint256 before = asset.balanceOf(user);
        vm.prank(user);
        try book.claimV3() returns (uint256 amount) {
            if (amount != due) overpayViolations++;
            if (asset.balanceOf(user) - before != amount) overpayViolations++;
            if (claimableBefore - book.claimable(user) != amount) overpayViolations++;
            paid += amount;
        } catch {
            if (due > 0 && balance >= due) shortClaimViolations++;
        }
    }

    /// @dev `claimLp` pays one record of the user: `claimable` drops by exactly what it paid.
    function claimLp(uint256 seed, uint256 idSeed) external {
        address user = _user(seed);
        uint256[] memory ids = book.lpTokensOf(user);
        if (ids.length == 0) return;
        uint256 id = ids[idSeed % ids.length];
        uint256 claimableBefore = book.claimable(user);
        uint256 before = asset.balanceOf(user);
        vm.prank(user);
        try book.claimLp(id) returns (uint256 amount) {
            if (asset.balanceOf(user) - before != amount) overpayViolations++;
            if (claimableBefore - book.claimable(user) != amount) overpayViolations++;
            (,,, bool claimed,) = book.lpReservation(id);
            if (!claimed) overpayViolations++;
            if (!book.lpSettled(id)) heldPaid++;
            paid += amount;
        } catch {}
    }

    /// @dev The held path, directed: an open record is held for its user, the clock moves to its
    ///      unlock if needed, and its user's `claimLp` must pay exactly its amount (or revert
    ///      `InsufficientFunds` while the balance is short).
    function claimHeld(uint256 idSeed) external {
        if (nextId == 1) return;
        uint256 id = 1 + idSeed % (nextId - 1);
        (address user, uint256 lp, uint64 unlockAt, bool claimed, bool forfeited) = book.lpReservation(id);
        if (user == address(0) || claimed || forfeited) return;
        vm.mockCall(vault, abi.encodeWithSignature("stakerOf(uint256)", id), abi.encode(user));
        holds++;
        if (block.timestamp < unlockAt) vm.warp(unlockAt);
        uint256 balance = asset.balanceOf(address(book));
        uint256 before = asset.balanceOf(user);
        vm.prank(user);
        try book.claimLp(id) returns (uint256 amount) {
            if (amount != lp || asset.balanceOf(user) - before != amount) overpayViolations++;
            if (!book.lpSettled(id)) heldPaid++;
            paid += amount;
        } catch (bytes memory err) {
            bytes memory short = abi.encodeWithSelector(V3BonusVault.InsufficientFunds.selector, lp, balance);
            if (balance >= lp || keccak256(err) != keccak256(short)) shortClaimViolations++;
        }
    }

    /// @dev State a wrong `claimLp` must leave unchanged.
    function _snapshot(uint256 id) internal view returns (bytes32) {
        (address u, uint256 lp, uint64 unlockAt, bool claimed, bool forfeited) = book.lpReservation(id);
        return keccak256(
            abi.encode(
                book.totalReserved(),
                book.totalLpReserved(),
                asset.balanceOf(address(book)),
                u,
                lp,
                unlockAt,
                claimed,
                forfeited
            )
        );
    }

    /// @dev `claimLp` on an id from ANOTHER wallet's list: `NotLpReservationUser(id, caller,
    ///      owner)`, nothing changes.
    function claimLpOther(uint256 seed, uint256 otherSeed, uint256 idSeed) external {
        address caller = _user(seed);
        address other = users[(seed % 3 + 1 + otherSeed % 2) % 3];
        uint256[] memory ids = book.lpTokensOf(other);
        if (ids.length == 0) return;
        uint256 id = ids[idSeed % ids.length];
        bytes32 before = _snapshot(id);
        vm.prank(caller);
        try book.claimLp(id) {
            wrongClaimViolations++;
        } catch (bytes memory err) {
            if (
                keccak256(err)
                    == keccak256(abi.encodeWithSelector(V3BonusVault.NotLpReservationUser.selector, id, caller, other))
            ) {
                expectedOwnerReverts++;
            } else {
                wrongClaimViolations++;
            }
        }
        if (_snapshot(id) != before) wrongClaimViolations++;
    }

    /// @dev `claimLp` on an OLD id a rebalance deleted: `NothingToClaim`, nothing changes.
    function claimLpOld(uint256 seed, uint256 idx) external {
        if (oldIds.length == 0) return;
        uint256 id = oldIds[idx % oldIds.length];
        bytes32 before = _snapshot(id);
        vm.prank(_user(seed));
        try book.claimLp(id) {
            wrongClaimViolations++;
        } catch (bytes memory err) {
            if (keccak256(err) == keccak256(abi.encodeWithSelector(V3BonusVault.NothingToClaim.selector))) {
                expectedEmptyReverts++;
            } else {
                wrongClaimViolations++;
            }
        }
        if (_snapshot(id) != before) wrongClaimViolations++;
    }

    function recover(uint256 amount) external {
        uint256 balance = asset.balanceOf(address(book));
        uint256 reserved = book.totalReserved();
        if (balance <= reserved) return;
        amount = bound(amount, 1, balance - reserved);
        vm.prank(owner);
        book.recoverSurplus(owner, amount);
        recovered += amount;
    }

    /// @notice Σ of every open LP amount: each LP reservation in a user's list that is neither
    ///         claimed nor forfeited.
    function openLpSum() external view returns (uint256 sum) {
        for (uint256 i = 0; i < 3; ++i) {
            uint256[] memory ids = book.lpTokensOf(users[i]);
            for (uint256 j = 0; j < ids.length; ++j) {
                (, uint256 lp,, bool claimed, bool forfeited) = book.lpReservation(ids[j]);
                if (!claimed && !forfeited) sum += lp;
            }
        }
    }

    /// @notice Σ of every open amount: each user's v3 reservation plus each LP reservation in the
    ///         user's list that is neither claimed nor forfeited.
    function openSum() external view returns (uint256 sum) {
        for (uint256 i = 0; i < 3; ++i) {
            (uint256 amount,) = book.reservedOf(users[i]);
            sum += amount;
            uint256[] memory ids = book.lpTokensOf(users[i]);
            for (uint256 j = 0; j < ids.length; ++j) {
                (, uint256 lp,, bool claimed, bool forfeited) = book.lpReservation(ids[j]);
                if (!claimed && !forfeited) sum += lp;
            }
        }
    }
}

contract V3BonusVaultInvariantsTest is StakingV3Harness {
    V3BonusVault internal book;
    V3BonusVaultHandler internal handler;

    function setUp() public {
        _deployStakingV3();
        address migrator_ = makeAddr("bookMigrator");
        // A real v3 pool (90 days from now) is the book's pool, so direct stakes reserve through it.
        WeightedStakingPoolV3 stakePool = _deployPoolV3(address(asset), block.timestamp, block.timestamp + 90 days);
        address pool_ = address(stakePool);
        book = _deployBonusVault(address(asset), migrator_, pool_, address(mathVault));
        stakePool.setBonusVault(address(book));
        handler = new V3BonusVaultHandler(
            book,
            asset,
            migrator_,
            pool_,
            address(mathVault),
            address(this),
            START_LOWER,
            START_UPPER,
            stakePool,
            voucherSignerPk
        );
        asset.approve(address(book), type(uint256).max);
        // The handler funds as the owner (this contract), which holds the $ASSET supply.
        targetContract(address(handler));
    }

    /// @dev I1: `totalReserved` is exactly the sum of every open reservation.
    function invariant_TotalReservedIsTheSumOfOpenReservations() public view {
        assertEq(book.totalReserved(), handler.openSum());
    }

    /// @dev I5: `totalLpReserved` is exactly the LP part of the open reservations.
    function invariant_TotalLpReservedIsTheSumOfOpenLpReservations() public view {
        assertEq(book.totalLpReserved(), handler.openLpSum());
        assertLe(book.totalLpReserved(), book.totalReserved());
    }

    /// @dev I2: the balance is what came in less what went out — nothing else moves tokens.
    function invariant_BalanceIsConserved() public view {
        assertEq(asset.balanceOf(address(book)), handler.funded() - handler.paid() - handler.recovered());
    }

    /// @dev I3: no rebalance raised a bonus above the amount it moved or the original reserve.
    function invariant_ScalingNeverRaisesABonus() public view {
        assertEq(handler.scalingViolations(), 0);
    }

    /// @dev I4: a claim pays exactly `claimable`, and reverts only when the balance is short;
    ///      `claimV3` and `claimLp` pay exactly their part (2026-11-12).
    function invariant_ClaimPaysExactlyOrIsShort() public view {
        assertEq(handler.overpayViolations(), 0);
        assertEq(handler.shortClaimViolations(), 0);
    }

    /// @dev I8: a direct stake reserves exactly `previewStakeBonus` (the new-stake bonus).
    function invariant_ADirectStakeReservesExactlyThePreview() public view {
        assertEq(handler.stakeBonusViolations(), 0);
    }

    /// @dev I7: `claimLp` on another wallet's id reverts `NotLpReservationUser`, on an old id a
    ///      rebalance deleted reverts `NothingToClaim`, and neither changes any state.
    function invariant_WrongClaimLpRevertsAndChangesNothing() public view {
        assertEq(handler.wrongClaimViolations(), 0);
    }

    /// @dev I6: an early exit forfeits every active LP record of the user and touches no other.
    function invariant_EarlyExitForfeitsExactlyTheActiveLpRecords() public view {
        assertEq(handler.earlyExitViolations(), 0);
    }
}
