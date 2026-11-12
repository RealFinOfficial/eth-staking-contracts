// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";

import {StakingV3Harness} from "../utils/StakingV3Harness.sol";
import {V3BonusVault} from "../../../contracts/staking-v3/V3BonusVault.sol";
import {IBonusEscrowHooks} from "../../../contracts/lp-staking/interfaces/IBonusEscrowHooks.sol";
import {MockERC20Permit} from "../../../contracts/lp-staking/mocks/MockERC20Permit.sol";

/**
 * @notice Bounded actor on a bare {V3BonusVault}: the migrator's two reserves, the pool's early
 *         exit (v3 part and active LP parts), the vault's unstake and rebalance (with random value
 *         ratios), the permissionless `reconcileLp` (no handler tokenId is staked in the vault, so
 *         an active one is forfeited), clock warps, funding, the three claims (`claim`, `claimV3`,
 *         `claimLp`) and surplus recoveries. Per-step properties are checked around the step and
 *         kept as violation counters; state properties are checked by the invariant functions.
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

    constructor(
        V3BonusVault book_,
        MockERC20Permit asset_,
        address migrator_,
        address pool_,
        address vault_,
        address owner_,
        int24 lower_,
        int24 upper_
    ) {
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
        }
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
        vm.prank(user);
        try book.claim() returns (uint256 amount) {
            if (amount != due) overpayViolations++;
            if (asset.balanceOf(user) - before != amount) overpayViolations++;
            paid += amount;
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
            paid += amount;
        } catch {}
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
        address pool_ = makeAddr("bookPool");
        book = _deployBonusVault(address(asset), migrator_, pool_, address(mathVault));
        handler = new V3BonusVaultHandler(
            book, asset, migrator_, pool_, address(mathVault), address(this), START_LOWER, START_UPPER
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

    /// @dev I6: an early exit forfeits every active LP record of the user and touches no other.
    function invariant_EarlyExitForfeitsExactlyTheActiveLpRecords() public view {
        assertEq(handler.earlyExitViolations(), 0);
    }
}
