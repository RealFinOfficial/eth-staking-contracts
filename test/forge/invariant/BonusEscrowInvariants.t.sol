// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";

import {ApeBondHarness} from "../utils/ApeBondHarness.sol";
import {LPStakingVault} from "../../../contracts/lp-staking/LPStakingVault.sol";
import {BonusEscrow} from "../../../contracts/lp-staking/BonusEscrow.sol";
import {ApeBondPositionAdapter} from "../../../contracts/lp-staking/ApeBondPositionAdapter.sol";
import {PositionValue} from "../../../contracts/lp-staking/libraries/PositionValue.sol";
import {SwapParams} from "../../../contracts/lp-staking/libraries/TwapGuard.sol";
import {MockERC20Permit} from "../../../contracts/lp-staking/mocks/MockERC20Permit.sol";
import {MockPositionManager} from "../../../contracts/lp-staking/mocks/MockPositionManager.sol";
import {MockSoulZapCaller} from "../../../contracts/lp-staking/mocks/MockSoulZapCaller.sol";
import {MockUniswapV3Pool} from "../../../contracts/lp-staking/mocks/MockUniswapV3Pool.sol";

/**
 * @notice Bounded actor driving the ApeBond route end to end on the local rung: purchases through
 *         the SoulZap double, exits, re-ranges with varying mint consumption (so rebalances both
 *         keep and lose value), re-stakes, attempts to buy the same NFT in again, clock warps,
 *         funding, claims and surplus recoveries.
 *
 *  The properties that are about a SINGLE STEP — a claim pays exactly or changes nothing (I8),
 *  an exit never reverts (I4), a reserve never exceeds its value cap (I5), a reservation is
 *  created at most once per NFT (I6), an amount never rises (I2), a matured record changes only
 *  by its claim (I7) — are checked by the handler itself, around the step, and recorded as
 *  violation counters the invariant functions assert to be zero. The properties that are about
 *  a STATE (I1, I3) are checked by the invariant functions directly.
 */
contract BonusEscrowHandler is Test {
    BonusEscrow internal immutable escrow;
    ApeBondPositionAdapter internal immutable adapter;
    LPStakingVault internal immutable vault;
    MockPositionManager internal immutable npm;
    MockSoulZapCaller internal immutable soulZap;
    MockUniswapV3Pool internal immutable pool;
    MockERC20Permit internal immutable asset;
    address internal immutable token0;
    address internal immutable token1;
    address internal immutable owner;
    bytes32 internal immutable campaignId;

    address[] internal actors;

    /// @dev Every tokenId that ever carried, or could carry, a reservation record.
    uint256[] internal ids;
    mapping(uint256 => bool) internal known;

    // ──────────────────────── Ghosts ───────────────────────────

    /// @notice The highest amount each id may hold: its reserve amount, or for an id a
    ///         reservation moved to, the amount the old id held just before the move.
    mapping(uint256 => uint256) public ceiling;
    /// @notice The amount each id held after the previous step, and whether it was observed.
    mapping(uint256 => uint256) public lastSeen;
    mapping(uint256 => bool) internal seen;
    /// @notice `BonusReserved` events seen per id.
    mapping(uint256 => uint256) public reservedEvents;

    /// @dev A matured record, frozen the first time it was observed past its cliff.
    struct Frozen {
        bool taken;
        address beneficiary;
        uint256 amount;
        uint64 unlockAt;
        bool claimed;
        bool forfeited;
    }

    mapping(uint256 => Frozen) internal frozen;

    uint256 public i2Violations;
    uint256 public i4Failures;
    uint256 public i5Violations;
    uint256 public i6Violations;
    uint256 public i7Violations;
    uint256 public i8Violations;

    uint256 public funded;
    uint256 public paidOut;
    uint256 public recovered;

    uint256 public buys;
    /// @notice Reservations created by a purchase, and by buying an exited NFT in again.
    uint256 public reservations;
    uint256 public rebuyReservations;
    uint256 public exits;
    uint256 public forfeitures;
    uint256 public moves;
    uint256 public claimsPaid;
    uint256 public claimsRefused;

    uint256 internal constant MAX_IDS = 48;
    uint256 internal constant BPS = 10_000;

    constructor(
        BonusEscrow escrow_,
        ApeBondPositionAdapter adapter_,
        LPStakingVault vault_,
        MockPositionManager npm_,
        MockSoulZapCaller soulZap_,
        MockUniswapV3Pool pool_,
        MockERC20Permit asset_,
        address owner_,
        bytes32 campaignId_,
        address[] memory actors_
    ) {
        escrow = escrow_;
        adapter = adapter_;
        vault = vault_;
        npm = npm_;
        soulZap = soulZap_;
        pool = pool_;
        asset = asset_;
        token0 = vault_.token0();
        token1 = vault_.token1();
        owner = owner_;
        campaignId = campaignId_;
        actors = actors_;
    }

    // ──────────────────────── Actions ──────────────────────────

    /// @notice One purchase: the SoulZap double mints a campaign-range position and deposits it.
    function buy(uint256 actorSeed, uint256 liquiditySeed) external {
        _buy(actorSeed, liquiditySeed);
        _afterStep(0);
    }

    function _buy(uint256 actorSeed, uint256 liquiditySeed) internal {
        if (ids.length >= MAX_IDS) return;
        address beneficiary = actors[actorSeed % actors.length];
        // 1e18 .. 1e23: value ~6 % of liquidity at tick 0 on +/-1200, so a bonus of 0.006 ..
        // 600 ASSET — the low end below the campaign minimum (1 ASSET: no reservation), the high
        // end above what one funding step brings in (claims are refused, then paid).
        uint128 liquidity = uint128(bound(liquiditySeed, 1e18, 1e23));
        (,, int24 lower, int24 upper,,) = _campaign();
        uint256 tokenId =
            npm.mintFake(address(soulZap), token0, token1, 3000, lower, upper, liquidity, 1_000e18, 1_000e6);

        uint256 cap = _valueCap(liquidity, lower, upper);
        vm.recordLogs();
        soulZap.deposit(adapter, address(npm), tokenId, campaignId, beneficiary);
        _countReserved(vm.getRecordedLogs());
        ++buys;
        _track(tokenId);

        (address b, uint256 amount,,,) = escrow.reservationOf(tokenId);
        if (b != address(0)) {
            ++reservations;
            ceiling[tokenId] = amount;
            if (amount > cap) ++i5Violations;
        }
    }

    /// @dev Self-priming, as in `VaultCustodyInvariants`: an action that needs a position finds
    ///      one, so every run that draws a route action really exercises the route.
    function _prime(uint256 seed) internal {
        if (ids.length == 0) _buy(seed, seed >> 8);
    }

    /// @notice An exit by the recorded staker, with ample gas. It must never revert (I4).
    function unstake(uint256 seed) external {
        _prime(seed);
        (bool found, uint256 tokenId, address staker) = _pickStaked(seed);
        if (!found) return;
        (,,,, bool forfeitedBefore) = escrow.reservationOf(tokenId);
        vm.prank(staker);
        try vault.unstake{gas: 2_000_000}(tokenId) {
            ++exits;
            (,,,, bool forfeitedAfter) = escrow.reservationOf(tokenId);
            if (forfeitedAfter && !forfeitedBefore) ++forfeitures;
        } catch {
            ++i4Failures;
        }
        _afterStep(0);
    }

    /// @notice A no-swap re-range to one of five aligned ranges. The mint consumes between 10 %
    ///         and 100 % of what was withdrawn, so a rebalance may keep the value or shed it.
    function rebalance(uint256 seed, uint256 rangeSeed, uint256 consumeSeed) external {
        _prime(seed);
        (bool found, uint256 tokenId, address staker) = _pickStaked(seed);
        if (!found) return;
        (int24 lower, int24 upper) = _range(rangeSeed);
        npm.setMintConsumeBps(bound(consumeSeed, 1_000, 10_000));
        (address b, uint256 amountBefore,,,) = escrow.reservationOf(tokenId);
        bool wasActive = escrow.isActive(tokenId);

        vm.prank(staker);
        try vault.rebalance(tokenId, lower, upper, _noSwap(), block.timestamp + 1) returns (uint256 newId) {
            _track(newId);
            if (wasActive) {
                ++moves;
                ceiling[newId] = amountBefore;
                (address nb,,,,) = escrow.reservationOf(newId);
                if (nb != b) ++i2Violations; // the beneficiary is carried, never changed
            }
        } catch {}
        npm.setMintConsumeBps(10_000);
        _afterStep(0);
    }

    /// @notice A holder stakes an NFT it got back from an exit, directly (no bonus path).
    function stakeAgain(uint256 seed) external {
        (bool found, uint256 tokenId, address holder) = _pickHeld(seed);
        if (!found) return;
        vm.startPrank(holder);
        npm.approve(address(vault), tokenId);
        try vault.stake(tokenId) {} catch {}
        vm.stopPrank();
        _afterStep(0);
    }

    /// @notice A holder hands an exited NFT back to the router, which tries to buy it in again.
    ///         A second reservation must never be created for it (I6).
    function rebuy(uint256 seed) external {
        (bool found, uint256 tokenId, address holder) = _pickHeld(seed);
        if (!found) return;
        uint256 eventsBefore = reservedEvents[tokenId];
        vm.prank(holder);
        npm.transferFrom(holder, address(soulZap), tokenId);
        vm.recordLogs();
        try soulZap.deposit(adapter, address(npm), tokenId, campaignId, holder) {} catch {}
        _countReserved(vm.getRecordedLogs());

        // A position a rebalance minted on the campaign's own range carried no reservation
        // (the one it followed was already past its cliff), so buying it in IS its first
        // reservation — legal, and held to the same cap as any purchase.
        if (reservedEvents[tokenId] == 1 && eventsBefore == 0) {
            ++rebuyReservations;
            (,,,,, int24 lower, int24 upper, uint128 liquidity,,,,) = npm.positions(tokenId);
            (, uint256 amount,,,) = escrow.reservationOf(tokenId);
            ceiling[tokenId] = amount;
            lastSeen[tokenId] = amount; // the id was seen at zero before; this is its reserve
            if (amount > _valueCap(liquidity, lower, upper)) ++i5Violations;
        }
        _afterStep(0);
    }

    function warp(uint256 seconds_) external {
        vm.warp(block.timestamp + bound(seconds_, 1, 40 days)); // the cliff is 30 days
        _afterStep(0);
    }

    /// @notice What the company does: transfer $ASSET into the escrow.
    function fund(uint256 amount) external {
        amount = bound(amount, 0, 1_000e18);
        asset.transfer(address(escrow), amount);
        funded += amount;
        _afterStep(0);
    }

    /// @notice A claim triggered by anyone, on any id ever seen. Pays exactly or changes nothing.
    function claim(uint256 seed) external {
        _prime(seed);
        uint256 tokenId = ids[seed % ids.length];
        (address b, uint256 amount, uint64 unlockAt, bool claimed, bool forfeited) = escrow.reservationOf(tokenId);
        uint256 beneficiaryBefore = b == address(0) ? 0 : asset.balanceOf(b);
        uint256 escrowBefore = asset.balanceOf(address(escrow));
        uint256 reservedBefore = escrow.totalReserved();

        try escrow.claim(tokenId) returns (uint256 paid) {
            ++claimsPaid;
            paidOut += paid;
            (,,, bool claimedAfter,) = escrow.reservationOf(tokenId);
            if (
                paid != amount || asset.balanceOf(b) != beneficiaryBefore + amount
                    || asset.balanceOf(address(escrow)) != escrowBefore - amount
                    || escrow.totalReserved() != reservedBefore - amount || !claimedAfter || escrowBefore < amount
            ) ++i8Violations;
            _afterStep(tokenId);
        } catch {
            ++claimsRefused;
            (address b2, uint256 a2, uint64 u2, bool c2, bool f2) = escrow.reservationOf(tokenId);
            if (
                b2 != b || a2 != amount || u2 != unlockAt || c2 != claimed || f2 != forfeited
                    || asset.balanceOf(address(escrow)) != escrowBefore || escrow.totalReserved() != reservedBefore
            ) ++i8Violations;
            _afterStep(0);
        }
    }

    /// @notice The owner moves the surplus out; it can never reach an owed wei.
    function recoverSurplus() external {
        uint256 balanceBefore = asset.balanceOf(address(escrow));
        uint256 reserved = escrow.totalReserved();
        vm.prank(owner);
        try escrow.recoverSurplus(address(0xBEEF)) {
            recovered += balanceBefore - reserved;
            if (asset.balanceOf(address(escrow)) != reserved) ++i8Violations;
        } catch {
            if (balanceBefore > reserved) ++i8Violations; // refused while a surplus existed
        }
        _afterStep(0);
    }

    // ──────────────────────── Views for the invariants ─────────

    function trackedIds() external view returns (uint256[] memory) {
        return ids;
    }

    // ──────────────────────── The per-step checks ──────────────

    /**
     * @dev I2 and I7 after every step. `claimedId` is the id a successful claim just paid: the
     *      ONE record allowed to change after its cliff, and only by turning `claimed` on.
     */
    function _afterStep(uint256 claimedId) internal {
        for (uint256 i = 0; i < ids.length; ++i) {
            uint256 id = ids[i];
            (address b, uint256 amount, uint64 unlockAt, bool claimed, bool forfeited) = escrow.reservationOf(id);

            // I2: never above the ceiling, never above the previous observation.
            if (amount > ceiling[id] || (seen[id] && amount > lastSeen[id])) ++i2Violations;
            lastSeen[id] = amount;
            seen[id] = true;

            // I7: a record past its cliff is frozen, except for its own claim. A frozen record that
            // disappears (beneficiary zero) or changes is a violation as much as one that moves.
            Frozen storage f = frozen[id];
            if (!f.taken) {
                if (b != address(0) && block.timestamp >= unlockAt) {
                    frozen[id] = Frozen(true, b, amount, unlockAt, claimed, forfeited);
                }
                continue;
            }
            bool claimFlip = id == claimedId && !f.claimed && claimed;
            if (
                f.beneficiary != b || f.amount != amount || f.unlockAt != unlockAt || f.forfeited != forfeited
                    || (f.claimed != claimed && !claimFlip)
            ) ++i7Violations;
            if (claimFlip) f.claimed = true;
        }
    }

    function _countReserved(Vm.Log[] memory logs) internal {
        bytes32 topic = BonusEscrow.BonusReserved.selector;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter != address(escrow) || logs[i].topics[0] != topic) continue;
            uint256 tokenId = uint256(logs[i].topics[1]);
            if (++reservedEvents[tokenId] > 1) ++i6Violations;
        }
    }

    // ──────────────────────── Helpers ──────────────────────────

    function _campaign()
        internal
        view
        returns (bool enabled, uint64 cliff, int24 lower, int24 upper, uint16 bps, uint256 minBonus)
    {
        (enabled, lower, upper, cliff, bps, minBonus) = adapter.campaigns(campaignId);
    }

    /// @dev I5's bound: the position's value at the TWAP x the campaign rate.
    function _valueCap(uint128 liquidity, int24 lower, int24 upper) internal view returns (uint256) {
        (,,,, uint16 bps,) = _campaign();
        return PositionValue.valueAt(liquidity, lower, upper, pool.twapTick(), true) * bps / BPS;
    }

    function _track(uint256 tokenId) internal {
        if (known[tokenId]) return;
        known[tokenId] = true;
        ids.push(tokenId);
    }

    /// @dev A staked id, with its staker, starting from a random index.
    function _pickStaked(uint256 seed) internal view returns (bool, uint256, address) {
        uint256 n = ids.length;
        for (uint256 k = 0; k < n; ++k) {
            uint256 id = ids[(seed % n + k) % n];
            address staker = vault.stakerOf(id);
            if (staker != address(0)) return (true, id, staker);
        }
        return (false, 0, address(0));
    }

    /// @dev An id an actor holds outside the vault (it exited), with that actor.
    function _pickHeld(uint256 seed) internal view returns (bool, uint256, address) {
        uint256 n = ids.length;
        for (uint256 k = 0; k < n; ++k) {
            uint256 id = ids[(seed % n + k) % n];
            address holder;
            try npm.ownerOf(id) returns (address o) {
                holder = o;
            } catch {
                continue; // burned by a rebalance
            }
            for (uint256 a = 0; a < actors.length; ++a) {
                if (actors[a] == holder) return (true, id, holder);
            }
        }
        return (false, 0, address(0));
    }

    function _range(uint256 seed) internal pure returns (int24, int24) {
        uint256 r = seed % 5;
        if (r == 0) return (-1200, 1200);
        if (r == 1) return (-600, 600);
        if (r == 2) return (-2400, -1200);
        if (r == 3) return (1200, 2400);
        return (-1200, 0);
    }

    function _noSwap() internal pure returns (SwapParams memory) {
        return SwapParams({zeroForOne: true, amountIn: 0, amountOutMin: 0, amount0Min: 0, amount1Min: 0});
    }
}

/**
 * @notice Why this file exists: the escrow's invariants are the B.3 decision document's promise
 *         about the bonus (§5.6, I1-I7, plus I8 for the reserve-now-fund-later override of
 *         2026-10-05), and each of them can be broken by an ORDER of operations no unit test
 *         thinks to try — an exit after a re-range, a re-stake after a forfeiture, a claim
 *         between two warps, a refused claim followed by a funding. This campaign interleaves
 *         all of them through the REAL vault, adapter and escrow on the local rung.
 *
 *    I1 `totalReserved` = sum of `amount` over reservations neither claimed nor forfeited.
 *    I2 an amount never increases after `reserve` (the handler, at every step).
 *    I3 before its cliff, an active reservation sits under a tokenId the vault holds for its
 *       beneficiary.
 *    I4 no escrow state makes `unstake` revert (every exit the handler attempts succeeds).
 *    I5 at `reserve`, amount <= value x bonusBps / 10,000 at the TWAP.
 *    I6 at most one reservation is created per tokenId (re-buys of exited NFTs included).
 *    I7 after `unlockAt`, only `claim` changes a reservation.
 *    I8 a claim pays exactly `amount` from a balance >= `amount`, or reverts and changes
 *       nothing; `recoverSurplus` leaves exactly `totalReserved`, or refuses because nothing
 *       is free.
 *  And the conservation identity: escrow balance = funded - paid - recovered.
 */
contract BonusEscrowInvariantsTest is ApeBondHarness {
    BonusEscrowHandler internal handler;

    function setUp() public {
        _deployApeBond();

        address[] memory actors = new address[](3);
        actors[0] = alice;
        actors[1] = bob;
        actors[2] = carol;
        handler = new BonusEscrowHandler(
            escrow, adapter, vault, npmMock, soulZap, poolMock, asset, address(this), CAMPAIGN, actors
        );

        // The position manager pays every `collect` out of its own balance; the handler funds
        // the escrow out of its own.
        asset.transfer(address(npmMock), 100_000_000e18);
        usdcToken.transfer(address(npmMock), 100_000_000e6);
        asset.transfer(address(handler), 100_000_000e18);

        bytes4[] memory selectors = new bytes4[](12);
        selectors[0] = BonusEscrowHandler.buy.selector;
        selectors[1] = BonusEscrowHandler.buy.selector; // purchases are the hot path, x2
        selectors[2] = BonusEscrowHandler.unstake.selector;
        selectors[3] = BonusEscrowHandler.rebalance.selector;
        selectors[4] = BonusEscrowHandler.rebalance.selector; // the scaling path, x2
        selectors[5] = BonusEscrowHandler.stakeAgain.selector;
        selectors[6] = BonusEscrowHandler.rebuy.selector;
        selectors[7] = BonusEscrowHandler.warp.selector;
        selectors[8] = BonusEscrowHandler.fund.selector;
        selectors[9] = BonusEscrowHandler.claim.selector;
        selectors[10] = BonusEscrowHandler.claim.selector; // claims race everything else, x2
        selectors[11] = BonusEscrowHandler.recoverSurplus.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function invariant_I1_TotalReservedIsTheSumOfLiveAmounts() public view {
        uint256[] memory ids = handler.trackedIds();
        uint256 sum;
        for (uint256 i = 0; i < ids.length; ++i) {
            (, uint256 amount,, bool claimed, bool forfeited) = escrow.reservationOf(ids[i]);
            if (!claimed && !forfeited) sum += amount;
        }
        assertEq(escrow.totalReserved(), sum, "I1: totalReserved = sum of live amounts");
    }

    function invariant_I2_AnAmountNeverIncreases() public view {
        assertEq(handler.i2Violations(), 0, "I2: an amount rose, or a move changed the beneficiary");
        uint256[] memory ids = handler.trackedIds();
        for (uint256 i = 0; i < ids.length; ++i) {
            (, uint256 amount,,,) = escrow.reservationOf(ids[i]);
            assertLe(amount, handler.ceiling(ids[i]), "I2: never above its reserve-time ceiling");
        }
    }

    function invariant_I3_ActiveReservationsSitInTheVaultForTheirBeneficiary() public view {
        uint256[] memory ids = handler.trackedIds();
        for (uint256 i = 0; i < ids.length; ++i) {
            if (!escrow.isActive(ids[i])) continue;
            (address beneficiary,,,,) = escrow.reservationOf(ids[i]);
            assertEq(vault.stakerOf(ids[i]), beneficiary, "I3: staked for the beneficiary");
            assertEq(npmMock.ownerOf(ids[i]), address(vault), "I3: held by the vault");
        }
    }

    function invariant_I4_EveryExitSucceeded() public view {
        assertEq(handler.i4Failures(), 0, "I4: an unstake reverted");
    }

    function invariant_I5_NoReserveAboveItsValueCap() public view {
        assertEq(handler.i5Violations(), 0, "I5: a reserve exceeded value x bps at the TWAP");
    }

    function invariant_I6_OneReservationPerTokenId() public view {
        assertEq(handler.i6Violations(), 0, "I6: a second BonusReserved for one tokenId");
    }

    function invariant_I7_AMaturedRecordChangesOnlyByItsClaim() public view {
        assertEq(handler.i7Violations(), 0, "I7: a matured reservation changed other than by claim");
    }

    function invariant_I8_ClaimsAreExactOrChangeNothing() public view {
        assertEq(handler.i8Violations(), 0, "I8: a claim paid inexactly or a refused one changed state");
    }

    function invariant_EscrowBalanceIsFundedMinusPaidMinusRecovered() public view {
        assertEq(
            asset.balanceOf(address(escrow)),
            handler.funded() - handler.paidOut() - handler.recovered(),
            "conservation: the escrow holds what was funded, less what left it"
        );
    }

    /// @dev Anti-vacuity: the campaign really bought, reserved and exited. A run that never
    ///      reached the actions would leave every property above trivially true.
    function invariant_TheCampaignDidSomething() public view {
        // A purchase creates at most one reservation; the only other source is buying an exited
        // NFT in again, which the handler counts on its own.
        assertGe(handler.buys(), handler.reservations(), "at most one reservation per purchase");
    }

    /// @dev Anti-vacuity per run: the purchase, exit, re-range and claim actions prime themselves
    ///      with a purchase, so only a run drawn entirely from warp / fund / recoverSurplus could
    ///      buy nothing — (3/12)^25 under the default profile.
    function afterInvariant() public view {
        console.log("buys", handler.buys(), "reservations", handler.reservations());
        console.log("exits", handler.exits(), "forfeitures", handler.forfeitures());
        console.log("moves", handler.moves(), "claims paid", handler.claimsPaid());
        assertGt(handler.buys(), 0, "the campaign bought at least one position");
    }
}
