// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LocalHarness} from "../utils/LocalHarness.sol";
import {LPStakingVault} from "../../../contracts/lp-staking/LPStakingVault.sol";
import {SwapParams} from "../../../contracts/lp-staking/libraries/TwapGuard.sol";
import {MockERC20Permit} from "../../../contracts/lp-staking/mocks/MockERC20Permit.sol";
import {MockPositionManager} from "../../../contracts/lp-staking/mocks/MockPositionManager.sol";

/**
 * @notice Bounded actor driving {LPStakingVault} through stake / unstake / rebalance
 *         sequences on a pool of four users, plus a hostile owner repeatedly trying to
 *         rescue a position that IS staked.
 *
 *  Only LEGITIMATE custody paths are driven. A stray NFT pushed in with a plain
 *  `transferFrom` would put the vault in the one state the equivalence below does not
 *  describe — owned, with no staker record — and that state is what `rescuePosition` exists
 *  to undo; it is pinned by name in `test/forge/unit/VaultBranches.t.sol`. Mixing it in here
 *  would weaken the equivalence into an implication and hide a real regression.
 *
 *  Every action self-primes: if nothing is staked yet it stakes first, so an exit action
 *  that is drawn at all always has a live position to work on. That is what lets the
 *  anti-vacuity invariant assert an exit SUCCEEDED whenever one was ATTEMPTED, instead of
 *  merely hoping the draw was lucky — see {VaultCustodyInvariantsTest} for why the gate is
 *  the attempt counter rather than the call counter.
 */
contract VaultCustodyHandler is Test {
    LPStakingVault internal immutable vault;
    MockPositionManager internal immutable npm;
    MockERC20Permit internal immutable asset;
    MockERC20Permit internal immutable usdc;
    address internal immutable router;
    address internal immutable vaultGuardian;
    uint24 internal immutable fee;

    address[] internal actors;

    /// @notice Every id the handler created that has not been burned.
    uint256[] internal tracked;
    /// @notice The subset of {tracked} the vault currently holds.
    uint256[] internal staked;

    // ──────────────────────── Ghosts ───────────────────────────

    /// @notice Handler calls that ran to completion. Zero means the campaign proves nothing.
    uint256 public calls;
    uint256 public stakes;
    uint256 public unstakes;
    uint256 public rebalances;
    uint256 public rescueAttempts;
    /// @notice Exit actions drawn against a live position — the denominator the anti-vacuity
    ///         invariant gates on. Incremented before the call, so an exit that is attempted
    ///         and then always reverts is still counted and still fails the campaign.
    uint256 public exitAttempts;
    /// @notice Set if `rescuePosition` ever released a position that carried a staker.
    bool public rescueEverMovedAStakedPosition;

    int24 internal constant TICK_LOWER = -600;
    int24 internal constant TICK_UPPER = 600;
    uint256 internal constant FAR_DEADLINE = 10 ** 12;
    uint256 internal constant PRINCIPAL_ASSET = 1_000e18;
    uint256 internal constant PRINCIPAL_USDC = 1_000e6;
    uint256 internal constant MAX_LIVE_POSITIONS = 8;

    constructor(
        LPStakingVault _vault,
        MockPositionManager _npm,
        MockERC20Permit _asset,
        MockERC20Permit _usdc,
        address _router,
        address _vaultGuardian,
        uint24 _fee,
        address[] memory _actors
    ) {
        vault = _vault;
        npm = _npm;
        asset = _asset;
        usdc = _usdc;
        router = _router;
        vaultGuardian = _vaultGuardian;
        fee = _fee;
        actors = _actors;
    }

    // ──────────────────────── Actions ──────────────────────────

    function stakeOne(uint256 actorSeed) external {
        calls++;
        _stakeFresh(actors[bound(actorSeed, 0, actors.length - 1)]);
    }

    function unstakeOne(uint256 idSeed) external {
        calls++;
        _prime();
        if (staked.length == 0) return;
        exitAttempts++;

        uint256 index = bound(idSeed, 0, staked.length - 1);
        uint256 tokenId = staked[index];
        address staker = vault.stakerOf(tokenId);

        vm.prank(staker);
        try vault.unstake(tokenId) {
            _removeStaked(index);
            unstakes++;
        } catch {}
    }

    function rebalanceOne(uint256 idSeed, uint256 tickSeed) external {
        calls++;
        _prime();
        if (staked.length == 0) return;
        exitAttempts++;

        uint256 index = bound(idSeed, 0, staked.length - 1);
        uint256 tokenId = staked[index];
        address staker = vault.stakerOf(tokenId);

        int24 lower = -int24(int256(bound(tickSeed, 1, 10))) * 60;
        int24 upper = lower + 600;
        SwapParams memory noSwap =
            SwapParams({zeroForOne: true, amountIn: 0, amountOutMin: 0, amount0Min: 0, amount1Min: 0});

        vm.prank(staker);
        try vault.rebalance(tokenId, lower, upper, noSwap, FAR_DEADLINE) returns (uint256 newTokenId) {
            // The old NFT is burned by the rebalance, so it leaves both lists entirely.
            _removeTracked(tokenId);
            staked[index] = newTokenId;
            tracked.push(newTokenId);
            rebalances++;
        } catch {}
    }

    /// @dev The GUARDIAN repeatedly attacking the recovery hatch it holds. Every one of
    ///      these MUST be refused; the flag it would set is the invariant's teeth.
    function rescueStaked(uint256 idSeed) external {
        calls++;
        _prime();
        if (staked.length == 0) return;

        uint256 tokenId = staked[bound(idSeed, 0, staked.length - 1)];
        rescueAttempts++;

        vm.prank(vaultGuardian);
        try vault.rescuePosition(tokenId) {
            rescueEverMovedAStakedPosition = true;
        } catch {}
    }

    // ──────────────────────── Views for the invariants ─────────

    function trackedIds() external view returns (uint256[] memory) {
        return tracked;
    }

    function stakedCount() external view returns (uint256) {
        return staked.length;
    }

    // ──────────────────────── Internals ────────────────────────

    /// @dev Guarantees a staked position exists before an action that needs one.
    function _prime() private {
        if (staked.length == 0) _stakeFresh(actors[0]);
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
 * @notice Why this file exists: the vault's safety argument is a single equivalence —
 *         **the vault owns a position if and only if it holds a staker record for it** — plus
 *         two housekeeping facts that make the equivalence enforceable: the vault holds no
 *         fungible balance between transactions, and it leaves no allowance standing behind
 *         it. Point tests prove each of the three at chosen moments. Only a campaign proves
 *         them after an ARBITRARY interleaving of stakes, exits and re-ranges, which is where
 *         the momentary gaps inside `rebalance` (mint before the record moves, record cleared
 *         before the burn) would show.
 */
contract VaultCustodyInvariantsTest is LocalHarness {
    VaultCustodyHandler internal handler;

    /// @dev Below this many calls in a run, the anti-vacuity check would be reporting the
    ///      run's warm-up rather than a defect, so it stands down entirely.
    uint256 internal constant ANTI_VACUITY_MIN_CALLS = 10;

    function setUp() public {
        _deployLocalStack();

        address[] memory actors = new address[](4);
        actors[0] = alice;
        actors[1] = bob;
        actors[2] = carol;
        actors[3] = stranger;

        // `rescuePosition` is guardian tier; the local harness gives the vault the same
        // address for owner and guardian, so this reads it off the contract rather than
        // assuming which of the two it is.
        handler = new VaultCustodyHandler(
            vault, npmMock, asset, usdcToken, address(routerMock), vault.guardian(), FEE, actors
        );

        // The position manager pays every `collect` out of its own balance, so it is funded
        // once here rather than on every fabricated position inside the campaign.
        asset.transfer(address(npmMock), 100_000_000e18);
        usdcToken.transfer(address(npmMock), 100_000_000e6);

        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = VaultCustodyHandler.stakeOne.selector;
        selectors[1] = VaultCustodyHandler.stakeOne.selector; // the hot path, weighted x2
        selectors[2] = VaultCustodyHandler.rebalanceOne.selector;
        selectors[3] = VaultCustodyHandler.rebalanceOne.selector; // the widest window, x2
        selectors[4] = VaultCustodyHandler.rebalanceOne.selector;
        selectors[5] = VaultCustodyHandler.unstakeOne.selector;
        selectors[6] = VaultCustodyHandler.unstakeOne.selector;
        selectors[7] = VaultCustodyHandler.rescueStaked.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    // ──────────────────────── The equivalence ──────────────────

    /// @dev Custody and record are created together and destroyed together, in both
    ///      directions, for every position the campaign has ever put through the vault.
    function invariant_CustodyAndStakerRecordAgree() public view {
        uint256[] memory ids = handler.trackedIds();
        for (uint256 i = 0; i < ids.length; ++i) {
            bool vaultOwns = npmMock.ownerOf(ids[i]) == address(vault);
            bool hasStaker = vault.stakerOf(ids[i]) != address(0);
            assertEq(vaultOwns, hasStaker, "the vault owns a position exactly when it records a staker for it");
        }
    }

    /// @dev The recovery hatch can never reach a position that carries a staker, however
    ///      often the owner tries and whatever the sequence around it.
    function invariant_RescueNeverMovesAStakedPosition() public view {
        assertFalse(
            handler.rescueEverMovedAStakedPosition(), "rescuePosition released a position that had a staker record"
        );
    }

    // ──────────────────────── Housekeeping ─────────────────────

    /// @dev The vault is a custody contract, not a wallet: it holds no pool token at rest.
    function invariant_VaultHoldsNoErc20Residue() public view {
        assertEq(asset.balanceOf(address(vault)), 0, "the vault holds no ASSET between transactions");
        assertEq(usdcToken.balanceOf(address(vault)), 0, "the vault holds no USDC between transactions");
    }

    /// @dev Every approval the vault grants is exact and reset to zero in the same call, so
    ///      no standing allowance is ever left for the position manager or the router.
    function invariant_VaultLeavesNoLingeringAllowance() public view {
        assertEq(asset.allowance(address(vault), address(npmMock)), 0, "no ASSET allowance survives to the manager");
        assertEq(usdcToken.allowance(address(vault), address(npmMock)), 0, "no USDC allowance survives to it either");
        assertEq(asset.allowance(address(vault), address(routerMock)), 0, "no ASSET allowance survives to the router");
        assertEq(usdcToken.allowance(address(vault), address(routerMock)), 0, "and no USDC allowance either");
    }

    // ──────────────────────── Anti-vacuity ─────────────────────

    /**
     * @dev A precondition, not a property. Every action above swallows its revert in a
     *      `try/catch`, so a harness that silently refused every call would leave all four
     *      invariants trivially true. This pins that the campaign really moved positions
     *      through the vault and really exercised the exits.
     *
     *      The two clauses are gated differently, because the handler's ghosts are storage
     *      and forge resets them for EVERY run — they count one run's calls, not the
     *      campaign's. `stakes` needs no more than the call-count gate: every action either
     *      stakes or self-primes, so past the warm-up a run has staked whatever it drew.
     *      `unstakes + rebalances` cannot be gated that way. The selector table gives the
     *      non-exit actions 3 of 8 weights, so a run whose first {ANTI_VACUITY_MIN_CALLS}
     *      draws are all `stakeOne` / `rescueStaked` is legal at (3/8)^10 per run — rare
     *      enough to look like a defect, common enough to fail a 512-run campaign roughly
     *      3 % of the time. It is not a defect: an exit that was never drawn is a fact about
     *      the draw, not about the vault. So the clause is gated on an exit having been
     *      ATTEMPTED. The teeth are unchanged, because self-priming guarantees every drawn
     *      exit has a live position to act on: an exit that is attempted and never succeeds
     *      still fails the campaign, which is the property this check exists to defend.
     */
    function invariant_VaultCustodyIsActuallyExercised() public view {
        if (handler.calls() < ANTI_VACUITY_MIN_CALLS) return;
        assertGt(handler.stakes(), 0, "no position was ever staked: the custody invariants would pass vacuously");
        if (handler.exitAttempts() == 0) return;
        assertGt(
            handler.unstakes() + handler.rebalances(),
            0,
            "an exit was attempted but no position ever left custody: the destroy-together half is untested"
        );
    }
}
