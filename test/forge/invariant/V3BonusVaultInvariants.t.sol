// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";

import {StakingV3Harness} from "../utils/StakingV3Harness.sol";
import {V3BonusVault} from "../../../contracts/staking-v3/V3BonusVault.sol";
import {IBonusEscrowHooks} from "../../../contracts/lp-staking/interfaces/IBonusEscrowHooks.sol";
import {MockERC20Permit} from "../../../contracts/lp-staking/mocks/MockERC20Permit.sol";

/**
 * @notice Bounded actor on a bare {V3BonusVault}: the migrator's two reserves, the pool's early
 *         exit, the vault's unstake and rebalance (with random value ratios), clock warps, funding,
 *         claims and surplus recoveries. Per-step properties are checked around the step and kept
 *         as violation counters; state properties are checked by the invariant functions.
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

    function earlyExit(uint256 seed) external {
        vm.prank(pool);
        book.onEarlyExit(_user(seed));
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

    function recover(uint256 amount) external {
        uint256 balance = asset.balanceOf(address(book));
        uint256 reserved = book.totalReserved();
        if (balance <= reserved) return;
        amount = bound(amount, 1, balance - reserved);
        vm.prank(owner);
        book.recoverSurplus(owner, amount);
        recovered += amount;
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

    /// @dev I2: the balance is what came in less what went out — nothing else moves tokens.
    function invariant_BalanceIsConserved() public view {
        assertEq(asset.balanceOf(address(book)), handler.funded() - handler.paid() - handler.recovered());
    }

    /// @dev I3: no rebalance raised a bonus above the amount it moved or the original reserve.
    function invariant_ScalingNeverRaisesABonus() public view {
        assertEq(handler.scalingViolations(), 0);
    }

    /// @dev I4: a claim pays exactly `claimable`, and reverts only when the balance is short.
    function invariant_ClaimPaysExactlyOrIsShort() public view {
        assertEq(handler.overpayViolations(), 0);
        assertEq(handler.shortClaimViolations(), 0);
    }
}
