// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LocalHarness} from "../utils/LocalHarness.sol";
import {LPStakingVault} from "../../../contracts/lp-staking/LPStakingVault.sol";
import {LPZapper} from "../../../contracts/lp-staking/LPZapper.sol";
import {RewardsDistributor} from "../../../contracts/lp-staking/RewardsDistributor.sol";
import {SwapParams} from "../../../contracts/lp-staking/libraries/TwapGuard.sol";
import {MockUniswapV3Pool} from "../../../contracts/lp-staking/mocks/MockUniswapV3Pool.sol";
import {MockPositionManager} from "../../../contracts/lp-staking/mocks/MockPositionManager.sol";
import {ReentrantRouter} from "../utils/attackers/ReentrantRouter.sol";
import {ReentrantReceiver, HostileOwner} from "../utils/attackers/Receivers.sol";
import {HookToken} from "../utils/attackers/HostileTokens.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @notice Why this file exists: the vault and the zapper both hand control to an external
 *         address in the middle of a state change — the router mid-rebalance, the token push
 *         during a refund, the payout inside `claimAsset` — and each of those windows is
 *         defended by a `nonReentrant` the code never demonstrates. A guard that has never
 *         been attacked is an assumption.
 *
 *  Every attacker below records what happened rather than reverting, so the test can assert
 *  the exact rejection the guard produced instead of merely observing that "something
 *  failed". Each attacker carries its own NatSpec note stating why it holds the authority
 *  it does.
 */
contract ReentrancyTest is LocalHarness {
    /// @dev The exact bytes OpenZeppelin's guard returns. Built once in `setUp` because
    ///      `abi.encodeWithSelector` is not a compile-time constant.
    bytes internal guardRejection;

    function setUp() public {
        _deployLocalStack();
        guardRejection = abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
    }

    // ──────────────────────── Router re-entering the vault ─────

    function test_Reentrancy_RouterCannotReenterUnstakeMidRebalance() public {
        (LPStakingVault v, ReentrantRouter r, uint256 tokenId) = _reentrantVaultWithStake();
        r.configure(address(v), abi.encodeCall(LPStakingVault.unstake, (tokenId)));

        vm.prank(alice);
        v.rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, _swapAll(), FAR_DEADLINE);

        _assertGuardRejected(r, "unstake");
    }

    function test_Reentrancy_RouterCannotReenterRebalanceMidRebalance() public {
        (LPStakingVault v, ReentrantRouter r, uint256 tokenId) = _reentrantVaultWithStake();
        r.configure(
            address(v),
            abi.encodeCall(LPStakingVault.rebalance, (tokenId, TICK_LOWER, TICK_UPPER, _noSwap(), FAR_DEADLINE))
        );

        vm.prank(alice);
        v.rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, _swapAll(), FAR_DEADLINE);

        _assertGuardRejected(r, "rebalance");
    }

    /// @dev `ReentrantAttacker.Mode.Stake` exists in the repo's mocks but was never used.
    ///      This is that path: a fresh stake attempted from inside a live rebalance.
    function test_Reentrancy_RouterCannotReenterStakeMidRebalance() public {
        (LPStakingVault v, ReentrantRouter r, uint256 tokenId) = _reentrantVaultWithStake();
        uint256 spare = _createPosition(address(r), TICK_LOWER, TICK_UPPER, LIQUIDITY);
        r.configure(address(v), abi.encodeCall(LPStakingVault.stake, (spare)));

        vm.prank(alice);
        v.rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, _swapAll(), FAR_DEADLINE);

        _assertGuardRejected(r, "stake");
    }

    function test_Reentrancy_RouterCannotReenterStakeForMidRebalance() public {
        (LPStakingVault v, ReentrantRouter r, uint256 tokenId) = _reentrantVaultWithStake();
        v.setZapper(address(r)); // the router is whitelisted, so ONLY the guard can stop it
        uint256 spare = _createPosition(address(r), TICK_LOWER, TICK_UPPER, LIQUIDITY);
        r.configure(address(v), abi.encodeCall(LPStakingVault.stakeFor, (bob, spare)));

        vm.prank(alice);
        v.rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, _swapAll(), FAR_DEADLINE);

        _assertGuardRejected(r, "stakeFor");
    }

    /**
     * @dev The window the vault's NatSpec calls out by name: between the `mint` and the
     *      `stakers[newTokenId] = staker` write the vault owns an NFT with no record, and
     *      between that write and the `burn` it owns one whose record was just cleared.
     *      `rescuePosition` shares the guard precisely so it cannot run there. The router is
     *      made the GUARDIAN — the tier `rescuePosition` now sits in — so that ONLY the guard
     *      is left standing between it and the rescue. (It could not be made the owner: the
     *      proxy's handover is two-step and the router never calls `acceptOwnership`.)
     */
    function test_Reentrancy_RouterCannotReenterRescuePositionMidRebalance() public {
        (LPStakingVault v, ReentrantRouter r, uint256 tokenId) = _reentrantVaultWithStake();
        v.setGuardian(address(r));
        r.configure(address(v), abi.encodeCall(LPStakingVault.rescuePosition, (tokenId)));

        vm.prank(alice);
        v.rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, _swapAll(), FAR_DEADLINE);

        _assertGuardRejected(r, "rescuePosition");
    }

    // ──────────────────────── Router re-entering the zapper ────

    function test_Reentrancy_RouterCannotReenterZapInMidZap() public {
        (, LPZapper z, ReentrantRouter r) = _reentrantStack();
        r.configure(
            address(z), abi.encodeCall(LPZapper.zapIn, (100e6, TICK_LOWER, TICK_UPPER, _noSwap(), FAR_DEADLINE))
        );

        vm.startPrank(alice);
        usdcToken.approve(address(z), 1_000e6);
        z.zapIn(1_000e6, TICK_LOWER, TICK_UPPER, _zapHalf(), FAR_DEADLINE);
        vm.stopPrank();

        _assertGuardRejected(r, "zapIn");
    }

    /// @dev Same argument as the vault's: from the `mint` until `vault.stakeFor`, the zapper
    ///      legitimately owns an unrecorded NFT. `rescuePosition` shares the guard.
    function test_Reentrancy_RouterCannotReenterZapperRescuePositionMidZap() public {
        (, LPZapper z, ReentrantRouter r) = _reentrantStack();
        z.transferOwnership(address(r));
        r.configure(address(z), abi.encodeCall(LPZapper.rescuePosition, (1)));

        vm.startPrank(alice);
        usdcToken.approve(address(z), 1_000e6);
        z.zapIn(1_000e6, TICK_LOWER, TICK_UPPER, _zapHalf(), FAR_DEADLINE);
        vm.stopPrank();

        _assertGuardRejected(r, "zapper rescuePosition");
    }

    // ──────────────────────── Token push hooks ─────────────────

    /**
     * @dev An ERC-777-style token calls the RECIPIENT back on every transfer, which turns
     *      `_refundDust` — the very last interaction in a rebalance — into a reentrancy
     *      vector. The staker here is a contract that opted into the hook, so it is attacking
     *      only itself; the point is that the guard, not the ordering, is what stops it.
     */
    function test_Reentrancy_ARefundPushCannotReenterTheVault() public {
        (LPStakingVault v, HookToken hookToken0, HookToken hookToken1, MockPositionManager npm2) = _hookTokenVault();
        ReentrantReceiver staker = new ReentrantReceiver();
        hookToken0.setHooked(address(staker), true);

        uint256 tokenId = _createHookPosition(npm2, hookToken0, hookToken1, address(staker));
        staker.approveErc721(address(npm2), address(v), tokenId);
        staker.execute(address(v), abi.encodeCall(LPStakingVault.stake, (tokenId)));

        npm2.setMintConsumeBps(5_000); // guarantees a refund, hence a push, hence a hook
        staker.configure(address(v), abi.encodeCall(LPStakingVault.unstake, (tokenId)));

        staker.execute(
            address(v),
            abi.encodeCall(LPStakingVault.rebalance, (tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, _noSwap(), FAR_DEADLINE))
        );

        assertEq(staker.attempts(), 1, "the refund push must really have called the hook");
        assertFalse(staker.lastReenterSucceeded(), "and the vault must have rejected the reentrant call");
        assertEq(staker.lastReturnData(), guardRejection, "with the reentrancy guard's own error");
    }

    /**
     * @dev The same shape on the reward side: `claimAsset` pushes real ASSET to the claimer,
     *      so an ASSET with a recipient hook lands inside the claim. The ledger write happens
     *      before the transfer, so even without the guard the second claim would find nothing
     *      owed — the guard makes that belt-and-braces rather than load-bearing, and this
     *      test pins which of the two actually fires.
     */
    function test_Reentrancy_AnAssetPayoutHookCannotReenterClaimAsset() public {
        HookToken hookAsset = new HookToken("Hook Asset", "hASSET", 18);
        RewardsDistributor d =
            _deployDistributorProxy(address(tokenX), address(hookAsset), address(this), address(this), voucherSigner);
        d.setAssetClaimsEnabled(true);
        hookAsset.mint(address(d), 1_000_000e18);

        ReentrantReceiver claimer = new ReentrantReceiver();
        hookAsset.setHooked(address(claimer), true);

        bytes memory sig = _signAssetVoucherFor(d, address(claimer), 1_000e18);
        claimer.configure(address(d), abi.encodeCall(RewardsDistributor.claimAsset, (1_000e18, FAR_DEADLINE, sig)));

        claimer.execute(address(d), abi.encodeCall(RewardsDistributor.claimAsset, (1_000e18, FAR_DEADLINE, sig)));

        assertEq(claimer.attempts(), 1, "the payout must really have called the hook");
        assertFalse(claimer.lastReenterSucceeded(), "and the distributor must have rejected the reentrant claim");
        assertEq(claimer.lastReturnData(), guardRejection, "with the reentrancy guard's own error");
        assertEq(hookAsset.balanceOf(address(claimer)), 1_000e18, "and the claimer is paid exactly once");
    }

    /**
     * @dev FINDING (behaviour, not a vulnerability): `LPZapper.sweep` is the one external
     *      function in the stack with NO `nonReentrant`. A hostile owner sweeping a
     *      hook-bearing token really can reenter it and sweep again in the same transaction.
     *      It is `onlyOwner`, so this is the owner acting against itself with tokens it may
     *      already move freely — recorded so the asymmetry with every other entry point is a
     *      known decision rather than an oversight.
     */
    function test_Reentrancy_ZapperSweepIsUnguardedAndReallyDoesReenter() public {
        HookToken stray = new HookToken("Stray", "STR", 18);
        HostileOwner hostile = new HostileOwner();
        zapper.transferOwnership(address(hostile));

        stray.mint(address(zapper), 200e18);
        stray.setHooked(address(hostile), true);
        hostile.configure(address(zapper), abi.encodeCall(LPZapper.sweep, (address(stray), 100e18, address(hostile))));

        hostile.execute(address(zapper), abi.encodeCall(LPZapper.sweep, (address(stray), 100e18, address(hostile))));

        // Two nested attempts, not one: the reentrant sweep pushes again, which fires the
        // hook again. The third attempt is what finally fails, and it fails on the BALANCE —
        // never on a guard.
        assertEq(hostile.attempts(), 2, "the sweep's push must have reached the hook, recursively");
        assertTrue(hostile.lastReenterSucceeded(), "sweep really is reentrant: no guard stops it");
        assertEq(stray.balanceOf(address(zapper)), 0, "both sweeps landed, draining the zapper in one transaction");
        assertEq(stray.balanceOf(address(hostile)), 200e18, "and the owner took the whole balance");
    }

    /**
     * @dev FINDING (behaviour, not a vulnerability), the distributor's twin of the sweep
     *      finding above: `recoverExcessAsset` also carries NO `nonReentrant`, and it now
     *      pays the GUARDIAN rather than the owner. A hostile guardian holding a hook-bearing
     *      ASSET therefore really can reenter it and recover twice in one transaction.
     *      It is `onlyGuardian` and the destination is the guardian itself, so this is the
     *      funding party acting against a balance it funded — recorded so the asymmetry with
     *      every other entry point is a known decision rather than an oversight.
     *
     *      (A hostile OWNER is no longer expressible on this contract: ownership is two-step,
     *      so a contract that never calls `acceptOwnership` never becomes the owner.)
     */
    function test_Reentrancy_RecoverExcessAssetIsUnguardedAndReallyDoesReenter() public {
        HookToken hookAsset = new HookToken("Hook Asset", "hASSET", 18);
        HostileOwner hostileGuardian = new HostileOwner();
        RewardsDistributor d = _deployDistributorProxy(
            address(tokenX), address(hookAsset), address(this), address(hostileGuardian), voucherSigner
        );

        hookAsset.mint(address(d), 200e18);
        hookAsset.setHooked(address(hostileGuardian), true);
        hostileGuardian.configure(address(d), abi.encodeCall(RewardsDistributor.recoverExcessAsset, (100e18)));

        hostileGuardian.execute(address(d), abi.encodeCall(RewardsDistributor.recoverExcessAsset, (100e18)));

        assertEq(hostileGuardian.attempts(), 2, "the payout push must have reached the hook, recursively");
        assertTrue(hostileGuardian.lastReenterSucceeded(), "recoverExcessAsset really is reentrant: no guard stops it");
        assertEq(hookAsset.balanceOf(address(d)), 0, "both recoveries landed in one transaction");
        assertEq(hookAsset.balanceOf(address(hostileGuardian)), 200e18, "and the guardian took the whole balance");
    }

    // ──────────────────────── Guard scope ──────────────────────

    /// @dev The guard is shared across the vault's whole user surface, which is what makes
    ///      every argument above hold for any pairing, not just the ones tested.
    function test_Reentrancy_TheVaultsGuardIsSharedAcrossEveryEntryPoint() public {
        (LPStakingVault v, ReentrantRouter r, uint256 tokenId) = _reentrantVaultWithStake();
        // The router needs both tiers to reach every payload below: `setZapper` is owner
        // tier, `rescuePosition` is guardian tier. Ownership is two-step and the router never
        // accepts, so the guardian is the one that gets handed over.
        v.setZapper(address(r));
        v.setGuardian(address(r));

        bytes[5] memory payloads = [
            abi.encodeCall(LPStakingVault.unstake, (tokenId)),
            abi.encodeCall(LPStakingVault.stake, (tokenId)),
            abi.encodeCall(LPStakingVault.stakeFor, (bob, tokenId)),
            abi.encodeCall(LPStakingVault.rescuePosition, (tokenId)),
            abi.encodeCall(LPStakingVault.rebalance, (tokenId, TICK_LOWER, TICK_UPPER, _noSwap(), FAR_DEADLINE))
        ];

        for (uint256 i = 0; i < payloads.length; ++i) {
            uint256 snap = vm.snapshotState();
            r.configure(address(v), payloads[i]);
            vm.prank(alice);
            v.rebalance(tokenId, NEW_TICK_LOWER, NEW_TICK_UPPER, _swapAll(), FAR_DEADLINE);
            assertEq(r.lastReturnData(), guardRejection, "every vault entry point must share the one guard");
            vm.revertToState(snap);
        }
    }

    // ──────────────────────── Helpers ──────────────────────────

    function _assertGuardRejected(ReentrantRouter r, string memory what) private view {
        assertEq(r.attempts(), 1, string.concat("the router must actually have tried to reenter ", what));
        assertFalse(r.lastReenterSucceeded(), string.concat("the reentrant ", what, " must be rejected"));
        assertEq(r.lastReturnData(), guardRejection, string.concat("the rejection of ", what, " must be the guard's"));
    }

    /// @dev token0 -> token1 with the whole withdrawn principal.
    function _swapAll() private pure returns (SwapParams memory) {
        return SwapParams({zeroForOne: true, amountIn: P_ASSET, amountOutMin: 0, amount0Min: 0, amount1Min: 0});
    }

    function _zapHalf() private view returns (SwapParams memory) {
        return
            SwapParams({
                zeroForOne: zapper.usdcIsToken0(), amountIn: 500e6, amountOutMin: 0, amount0Min: 0, amount1Min: 0
            });
    }

    /// @dev A parallel stack whose ROUTER is the attacker. The router address is an immutable
    ///      constructor argument on both contracts, so it cannot be swapped into the harness
    ///      stack after the fact.
    function _reentrantStack() private returns (LPStakingVault v, LPZapper z, ReentrantRouter r) {
        r = new ReentrantRouter();
        r.setRate(1e6, 2e18); // 18-decimal in, 6-decimal out, at the harness price
        asset.transfer(address(r), 10_000_000e18);
        usdcToken.transfer(address(r), 10_000_000e6);

        v = _deployVaultProxy(
            address(npmMock),
            address(poolMock),
            token0,
            token1,
            FEE,
            address(r),
            address(this),
            address(this),
            MIN_TWAP_WINDOW,
            500
        );
        z = new LPZapper(
            address(v),
            address(npmMock),
            address(poolMock),
            token0,
            token1,
            FEE,
            address(r),
            address(usdcToken),
            address(asset),
            address(this),
            MIN_TWAP_WINDOW,
            500
        );
        v.setZapper(address(z));
    }

    function _reentrantVaultWithStake() private returns (LPStakingVault v, ReentrantRouter r, uint256 tokenId) {
        (v,, r) = _reentrantStack();
        tokenId = _createPosition(alice, TICK_LOWER, TICK_UPPER, LIQUIDITY);
        vm.startPrank(alice);
        npmMock.approve(address(v), tokenId);
        v.stake(tokenId);
        vm.stopPrank();
    }

    /// @dev A vault whose token0 calls its recipients back on every transfer.
    function _hookTokenVault()
        private
        returns (LPStakingVault v, HookToken t0, HookToken t1, MockPositionManager npm2)
    {
        t0 = new HookToken("Hook Asset", "hASSET", 18);
        for (uint256 salt = 0; salt < 256; ++salt) {
            HookToken candidate = new HookToken{salt: bytes32(salt)}("Hook USDC", "hUSDC", 6);
            if (address(candidate) > address(t0)) {
                t1 = candidate;
                break;
            }
        }
        require(address(t1) != address(0), "no salt sorted the hook pair");

        MockUniswapV3Pool p = new MockUniswapV3Pool(address(t0), address(t1), FEE);
        npm2 = new MockPositionManager();
        v = _deployVaultProxy(
            address(npm2),
            address(p),
            address(t0),
            address(t1),
            FEE,
            address(routerMock),
            address(this),
            address(this),
            MIN_TWAP_WINDOW,
            500
        );
    }

    function _createHookPosition(MockPositionManager npm2, HookToken t0, HookToken t1, address holder)
        private
        returns (uint256 tokenId)
    {
        npm2.mintFake(holder, address(t0), address(t1), FEE, TICK_LOWER, TICK_UPPER, LIQUIDITY, P_ASSET, 0);
        tokenId = npm2.lastMintedId();
        t0.mint(address(npm2), P_ASSET);
    }

    /// @dev An ASSET-leg voucher bound to a distributor other than the harness's own.
    function _signAssetVoucherFor(RewardsDistributor target, address user, uint256 cumulative)
        private
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(target.ASSET_CLAIM_TYPEHASH(), user, cumulative, FAR_DEADLINE));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparatorOf(target), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(voucherSignerPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _domainSeparatorOf(RewardsDistributor target) private view returns (bytes32) {
        (, string memory n, string memory ver, uint256 cid, address verifying,,) = target.eip712Domain();
        return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256(bytes(n)), keccak256(bytes(ver)), cid, verifying));
    }
}
