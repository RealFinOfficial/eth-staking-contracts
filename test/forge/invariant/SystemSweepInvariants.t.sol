// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LocalHarness} from "../utils/LocalHarness.sol";
import {LPStakingVault} from "../../../contracts/lp-staking/LPStakingVault.sol";
import {LPZapper} from "../../../contracts/lp-staking/LPZapper.sol";
import {RewardsDistributor} from "../../../contracts/lp-staking/RewardsDistributor.sol";
import {SwapParams} from "../../../contracts/lp-staking/libraries/TwapGuard.sol";
import {MockERC20Permit} from "../../../contracts/lp-staking/mocks/MockERC20Permit.sol";
import {MockPositionManager} from "../../../contracts/lp-staking/mocks/MockPositionManager.sol";
import {MockSwapRouter} from "../../../contracts/lp-staking/mocks/MockSwapRouter.sol";

/**
 * @notice Bounded actor driving the WHOLE stack at once — zapper, vault, distributor and
 *         token — through zaps, direct stakes, exits, swap-bearing re-ranges, reward claims
 *         and both owner recovery hatches, in any order.
 *
 *  This is the campaign behind the system-wide sweep: the three facts asserted after every
 *  single call are the ones every individual test also ends on, and the point of driving them
 *  from a mixed sequence is that a leak between two contracts (a refund that lands on the
 *  wrong one, an approval left standing after a swap that reverted downstream) only appears
 *  when the two are used together.
 *
 *  Only legitimate paths are driven. Pushing a stray ERC-20 into the vault or the zapper
 *  would falsify the residue statement by design — a stray legitimately sits there until the
 *  next caller absorbs it, which is `docs/lp-staking-audit-notes.md` item 4 and is pinned by
 *  name in the unit suites — so it belongs there and not in a sweep whose claim is that the
 *  contracts themselves never leave anything behind.
 */
/// @dev The whole stack in one argument. A flat constructor of twelve parameters does not
///      fit the stack under this repo's non-`via_ir` build.
struct Wiring {
    LPStakingVault vault;
    LPZapper zapper;
    RewardsDistributor distributor;
    MockPositionManager npm;
    MockSwapRouter router;
    MockERC20Permit asset;
    MockERC20Permit usdc;
    address protocolOwner;
    uint256 signerPk;
    bytes32 domainSeparator;
    uint24 fee;
}

contract SystemSweepHandler is Test {
    LPStakingVault internal immutable vault;
    LPZapper internal immutable zapper;
    RewardsDistributor internal immutable distributor;
    MockPositionManager internal immutable npm;
    MockSwapRouter internal immutable router;
    MockERC20Permit internal immutable asset;
    MockERC20Permit internal immutable usdc;
    address internal immutable protocolOwner;
    uint256 internal immutable signerPk;
    bytes32 internal immutable domainSeparator;
    uint24 internal immutable fee;

    address[] internal actors;

    uint256[] internal tracked;
    uint256[] internal staked;
    mapping(address => uint256) internal entitlement;

    // ──────────────────────── Ghosts ───────────────────────────

    uint256 public calls;
    uint256 public zaps;
    uint256 public stakes;
    uint256 public exits;
    uint256 public rebalances;
    uint256 public claims;
    uint256 public sweeps;

    int24 internal constant TICK_LOWER = -600;
    int24 internal constant TICK_UPPER = 600;
    uint256 internal constant FAR_DEADLINE = 10 ** 12;
    uint256 internal constant PRINCIPAL_ASSET = 1_000e18;
    uint256 internal constant PRINCIPAL_USDC = 1_000e6;
    uint256 internal constant MAX_ZAP_USDC = 10_000e6;
    uint256 internal constant MAX_CLAIM_DELTA = 1e18;
    uint256 internal constant MAX_LIVE_POSITIONS = 6;

    constructor(Wiring memory w, address[] memory _actors) {
        vault = w.vault;
        zapper = w.zapper;
        distributor = w.distributor;
        npm = w.npm;
        router = w.router;
        asset = w.asset;
        usdc = w.usdc;
        protocolOwner = w.protocolOwner;
        signerPk = w.signerPk;
        domainSeparator = w.domainSeparator;
        fee = w.fee;
        actors = _actors;
    }

    // ──────────────────────── Actions ──────────────────────────

    function zapIn(uint256 actorSeed, uint256 usdcSeed, uint256 swapSeed) external {
        calls++;
        _prime();

        address actor = actors[bound(actorSeed, 0, actors.length - 1)];
        uint256 usdcAmount = bound(usdcSeed, 1e6, MAX_ZAP_USDC);
        _zapFor(actor, usdcAmount, bound(swapSeed, 0, usdcAmount));
    }

    function stakeDirect(uint256 actorSeed) external {
        calls++;
        _prime();
        _stakeFresh(actors[bound(actorSeed, 0, actors.length - 1)]);
    }

    function exit(uint256 idSeed) external {
        calls++;
        _prime();
        if (staked.length == 0) return;

        uint256 index = bound(idSeed, 0, staked.length - 1);
        uint256 tokenId = staked[index];

        vm.prank(vault.stakerOf(tokenId));
        try vault.unstake(tokenId) {
            _removeStaked(index);
            exits++;
        } catch {}
    }

    /// @dev A re-range WITH a swap leg, so the router, the guard and both approvals are all
    ///      in the sequence rather than only the mint path.
    function rebalanceWithSwap(uint256 idSeed, uint256 amountSeed, uint256 tickSeed) external {
        calls++;
        _prime();
        if (staked.length == 0) return;

        uint256 index = bound(idSeed, 0, staked.length - 1);
        uint256 tokenId = staked[index];

        int24 lower = -int24(int256(bound(tickSeed, 1, 10))) * 60;
        SwapParams memory swap = SwapParams({
            zeroForOne: true, // ASSET -> USDC; the vault accepts either direction
            amountIn: bound(amountSeed, 0, PRINCIPAL_ASSET / 2),
            amountOutMin: 0,
            amount0Min: 0,
            amount1Min: 0
        });

        vm.prank(vault.stakerOf(tokenId));
        try vault.rebalance(tokenId, lower, lower + 600, swap, FAR_DEADLINE) returns (uint256 newTokenId) {
            _removeTracked(tokenId);
            staked[index] = newTokenId;
            tracked.push(newTokenId);
            rebalances++;
        } catch {}
    }

    function claimReward(uint256 actorSeed, uint256 deltaSeed) external {
        calls++;
        _prime();
        _claimFor(actors[bound(actorSeed, 0, actors.length - 1)], bound(deltaSeed, 1, MAX_CLAIM_DELTA));
    }

    /// @dev The owner's dust hatch on the zapper. The zapper holds nothing at rest, so this
    ///      is the zero-amount arm — which is exactly the shape the audit notes record as
    ///      permitted here and refused by `recoverExcessAsset`.
    function sweepZapper(uint256 tokenSeed) external {
        calls++;
        _prime();

        address token = bound(tokenSeed, 0, 1) == 0 ? address(asset) : address(usdc);
        uint256 amount = MockERC20Permit(token).balanceOf(address(zapper));

        vm.prank(protocolOwner);
        try zapper.sweep(token, amount, protocolOwner) {
            sweeps++;
        } catch {}
    }

    /// @dev The treasury hatch on the distributor, which moves ASSET the reward float owns.
    ///      It is an OPERATOR call, not an owner call; the local harness gives the distributor
    ///      the same address for all three roles, so `protocolOwner` is also its operator here.
    function recoverDistributorAsset(uint256 amountSeed) external {
        calls++;
        _prime();

        uint256 balance = asset.balanceOf(address(distributor));
        if (balance == 0) return;

        vm.prank(distributor.operator());
        try distributor.recoverExcessAsset(bound(amountSeed, 1, balance)) {} catch {}
    }

    // ──────────────────────── Views for the invariants ─────────

    function trackedIds() external view returns (uint256[] memory) {
        return tracked;
    }

    // ──────────────────────── Internals ────────────────────────

    /// @dev One guaranteed zap, one guaranteed direct stake and one guaranteed claim on the
    ///      first action of any sequence, so the anti-vacuity invariant is a hard assertion.
    function _prime() private {
        if (stakes == 0) _stakeFresh(actors[0]);
        if (zaps == 0) _zapFor(actors[0], 1_000e6, 500e6);
        if (claims == 0) _claimFor(actors[0], 1);
    }

    function _zapFor(address actor, uint256 usdcAmount, uint256 swapIn) private {
        // `usdcIsToken0` is false on this harness, so USDC -> ASSET is token1 -> token0.
        SwapParams memory swap =
            SwapParams({zeroForOne: false, amountIn: swapIn, amountOutMin: 0, amount0Min: 0, amount1Min: 0});

        vm.startPrank(actor);
        usdc.approve(address(zapper), usdcAmount);
        try zapper.zapIn(usdcAmount, TICK_LOWER, TICK_UPPER, swap, FAR_DEADLINE) returns (uint256 tokenId) {
            tracked.push(tokenId);
            staked.push(tokenId);
            zaps++;
        } catch {}
        vm.stopPrank();
    }

    function _stakeFresh(address actor) private {
        if (staked.length >= MAX_LIVE_POSITIONS) return;

        npm.mintFake(
            actor, address(asset), address(usdc), fee, TICK_LOWER, TICK_UPPER, 1e9, PRINCIPAL_ASSET, PRINCIPAL_USDC
        );
        uint256 tokenId = npm.lastMintedId();

        vm.startPrank(actor);
        npm.approve(address(vault), tokenId);
        try vault.stake(tokenId) {
            tracked.push(tokenId);
            staked.push(tokenId);
            stakes++;
        } catch {}
        vm.stopPrank();
    }

    function _claimFor(address actor, uint256 delta) private {
        uint256 cumulative = entitlement[actor] + delta;
        bytes32 structHash = keccak256(abi.encode(distributor.TOKENX_CLAIM_TYPEHASH(), actor, cumulative, FAR_DEADLINE));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);

        vm.prank(actor);
        try distributor.claimTokenX(cumulative, FAR_DEADLINE, abi.encodePacked(r, s, v)) {
            entitlement[actor] = cumulative;
            claims++;
        } catch {}
    }

    function _removeStaked(uint256 index) private {
        staked[index] = staked[staked.length - 1];
        staked.pop();
    }

    function _removeTracked(uint256 tokenId) private {
        for (uint256 i = 0; i < tracked.length; ++i) {
            if (tracked[i] == tokenId) {
                tracked[i] = tracked[tracked.length - 1];
                tracked.pop();
                return;
            }
        }
    }
}

/**
 * @notice Why this file exists: G-15, the system-wide sweep. Three facts are asserted after
 *         EVERY call of a mixed zapper/vault/distributor sequence:
 *
 *           * neither the vault nor the zapper holds a wei of either pool token at rest;
 *           * the vault owns a position exactly when it records a staker for it;
 *           * no approval either contract granted is still standing.
 *
 *  Each is also asserted in a narrower file. What only this campaign can catch is the
 *  cross-contract case: a zap that mints, hands custody to the vault and refunds, immediately
 *  followed by a swap-bearing re-range of a DIFFERENT position, with a claim and an owner
 *  recovery in between. Approvals in this stack are granted and revoked inside a single call
 *  on purpose; a sequence is the only place a revocation that was skipped on one path but not
 *  another shows up.
 */
contract SystemSweepInvariantsTest is LocalHarness {
    SystemSweepHandler internal handler;

    function setUp() public {
        _deployLocalStack();

        address[] memory actors = new address[](4);
        actors[0] = alice;
        actors[1] = bob;
        actors[2] = carol;
        actors[3] = stranger;

        handler = new SystemSweepHandler(
            Wiring({
                vault: vault,
                zapper: zapper,
                distributor: distributor,
                npm: npmMock,
                router: routerMock,
                asset: asset,
                usdc: usdcToken,
                protocolOwner: address(this),
                signerPk: voucherSignerPk,
                domainSeparator: _distributorDomainSeparator(),
                fee: FEE
            }),
            actors
        );

        // The position manager pays every `collect` out of its own balance, so it is funded
        // once here rather than on every fabricated position inside the campaign.
        asset.transfer(address(npmMock), 100_000_000e18);
        usdcToken.transfer(address(npmMock), 100_000_000e6);

        bytes4[] memory selectors = new bytes4[](9);
        selectors[0] = SystemSweepHandler.zapIn.selector;
        selectors[1] = SystemSweepHandler.zapIn.selector; // the widest path, weighted x2
        selectors[2] = SystemSweepHandler.rebalanceWithSwap.selector;
        selectors[3] = SystemSweepHandler.rebalanceWithSwap.selector; // likewise
        selectors[4] = SystemSweepHandler.stakeDirect.selector;
        selectors[5] = SystemSweepHandler.exit.selector;
        selectors[6] = SystemSweepHandler.claimReward.selector;
        selectors[7] = SystemSweepHandler.sweepZapper.selector;
        selectors[8] = SystemSweepHandler.recoverDistributorAsset.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    // ──────────────────────── The sweep ────────────────────────

    /// @dev Neither contract is a wallet. Every refund path drains them in the same call.
    function invariant_NoTokenResidueOnTheVaultOrTheZapper() public view {
        assertEq(asset.balanceOf(address(vault)), 0, "the vault holds no ASSET at rest");
        assertEq(usdcToken.balanceOf(address(vault)), 0, "the vault holds no USDC at rest");
        assertEq(asset.balanceOf(address(zapper)), 0, "the zapper holds no ASSET at rest");
        assertEq(usdcToken.balanceOf(address(zapper)), 0, "the zapper holds no USDC at rest");
    }

    /// @dev Custody and record are created together and destroyed together, whichever entry
    ///      point put the position in — a direct stake or the zapper's `stakeFor`.
    function invariant_CustodyAndRecordAgreeAfterAnySequence() public view {
        uint256[] memory ids = handler.trackedIds();
        for (uint256 i = 0; i < ids.length; ++i) {
            assertEq(
                npmMock.ownerOf(ids[i]) == address(vault),
                vault.stakerOf(ids[i]) != address(0),
                "the vault owns a position exactly when it records a staker for it"
            );
        }
    }

    /// @dev Every approval in this stack is exact and revoked in the same transaction, on
    ///      both contracts and towards both counterparties.
    function invariant_NoLingeringAllowanceAnywhere() public view {
        assertEq(asset.allowance(address(vault), address(npmMock)), 0, "vault -> manager ASSET allowance is cleared");
        assertEq(usdcToken.allowance(address(vault), address(npmMock)), 0, "vault -> manager USDC allowance likewise");
        assertEq(asset.allowance(address(vault), address(routerMock)), 0, "vault -> router ASSET allowance cleared");
        assertEq(usdcToken.allowance(address(vault), address(routerMock)), 0, "vault -> router USDC allowance likewise");
        assertEq(asset.allowance(address(zapper), address(npmMock)), 0, "zapper -> manager ASSET allowance cleared");
        assertEq(usdcToken.allowance(address(zapper), address(npmMock)), 0, "zapper -> manager USDC allowance likewise");
        assertEq(
            usdcToken.allowance(address(zapper), address(routerMock)), 0, "zapper -> router USDC allowance cleared"
        );
    }

    // ──────────────────────── Anti-vacuity ─────────────────────

    /**
     * @dev A precondition, not a property. All three invariants above are satisfied by an
     *      untouched stack, so a campaign whose every action silently reverted would pass
     *      them at zero. The handler primes a zap, a direct stake and a claim on its first
     *      call, which makes these hard assertions rather than a bet on the selector lottery.
     */
    function invariant_TheWholeStackIsActuallyExercised() public view {
        if (handler.calls() == 0) return;
        assertGt(handler.zaps(), 0, "no zap ever completed: the zapper half of the sweep is vacuous");
        assertGt(handler.stakes(), 0, "no direct stake ever completed: the vault half is vacuous");
        assertGt(handler.claims(), 0, "no reward was ever claimed: the distributor is not in the sequence");
    }
}
