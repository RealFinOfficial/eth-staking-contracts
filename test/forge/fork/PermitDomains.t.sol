// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkHarness} from "../utils/ForkHarness.sol";
import {LPZapper, PermitData} from "../../../contracts/lp-staking/LPZapper.sol";
import {SwapParams} from "../../../contracts/lp-staking/libraries/TwapGuard.sol";
import {IERC20Like} from "../utils/Interfaces.sol";
import {LPStakingVault} from "../../../contracts/lp-staking/LPStakingVault.sol";
import {ReentrantReceiver} from "../utils/attackers/Receivers.sol";

/**
 * @notice Why this file exists: an EIP-712 domain is a fact about a deployed contract on a
 *         specific chain, and it is exactly the kind of fact a mock cannot establish. Every
 *         signature here is verified by the REAL Uniswap position manager on the fork, and
 *         the ERC-2612 assertions are made against the tokens the profile really names.
 *
 *  The Sepolia profile's tokens (tREAL / tUSDC) are plain fixed-supply ERC-20s with NO
 *  EIP-2612. That is not a gap in coverage, it is a fact under test: `zapInWithPermit`'s
 *  allowance-first branch (`LPZapper` L226) is what makes the zap work with such a token at
 *  all, and this file proves both arms of that branch — the skip that succeeds and the
 *  permit call that cannot. The EIP-2612 signature path itself is covered deterministically
 *  in `test/forge/unit/ZapperBranches.t.sol` against `MockERC20Permit`, and graduates to
 *  real USDC under the mainnet profile.
 */
contract PermitDomainsTest is ForkHarness {
    uint256 internal constant ZAP_USDC = 20_000e6;

    function setUp() public {
        _deployForkedStack();
    }

    // ──────────────────────── EIP-4494 (position NFT) ──────────

    function test_NftPermit_StakeWithPermitIsAcceptedByTheRealPositionManager() public {
        uint256 tokenId = _mintAroundSpot(alice, 600);
        (uint8 v, bytes32 r, bytes32 s) = _signNftPermit(alicePk, address(vault), tokenId, FAR_DEADLINE);

        vm.prank(alice);
        vault.stakeWithPermit(tokenId, FAR_DEADLINE, v, r, s);

        assertEq(vault.stakerOf(tokenId), alice, "the permit alone must be enough to take custody");
        assertEq(npm.ownerOf(tokenId), address(vault), "custody must really have moved to the vault");
    }

    /// @dev The manager recomputes its separator from `block.chainid` on every call, so the
    ///      fork's real chain id is what a signature must be bound to. Recomputed here from
    ///      the documented name/version and compared against what the contract reports.
    function test_NftPermit_DomainSeparatorIsRebuiltFromTheForksChainId() public view {
        bytes32 expected = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes(npmExtras.name())),
                keccak256(bytes("1")),
                block.chainid,
                address(npm)
            )
        );
        assertEq(
            npmExtras.DOMAIN_SEPARATOR(),
            expected,
            "the NFT permit domain must be name/version-1/chainid/manager, computed live"
        );
        assertEq(npmExtras.name(), "Uniswap V3 Positions NFT-V1", "the canonical periphery name is load-bearing");
        assertEq(block.chainid, profile.chainId, "the fork must sign against the profile's real chain id");
    }

    function test_NftPermit_RevertsOnAnExpiredDeadline() public {
        uint256 tokenId = _mintAroundSpot(alice, 600);
        uint256 deadline = block.timestamp - 1;
        (uint8 v, bytes32 r, bytes32 s) = _signNftPermit(alicePk, address(vault), tokenId, deadline);

        vm.prank(alice);
        vm.expectRevert(bytes("Permit expired"));
        vault.stakeWithPermit(tokenId, deadline, v, r, s);
    }

    function test_NftPermit_RevertsWhenSomeoneElseSignedIt() public {
        uint256 tokenId = _mintAroundSpot(alice, 600);
        (uint8 v, bytes32 r, bytes32 s) = _signNftPermit(bobPk, address(vault), tokenId, FAR_DEADLINE);

        vm.prank(alice);
        vm.expectRevert(bytes("Unauthorized"));
        vault.stakeWithPermit(tokenId, FAR_DEADLINE, v, r, s);
    }

    /// @dev The nonce lives on the position, so a consumed signature can never be replayed
    ///      onto the same token.
    function test_NftPermit_CannotBeReplayedAfterTheNonceMoves() public {
        uint256 tokenId = _mintAroundSpot(alice, 600);
        (uint96 nonceBefore,,,,,,,,,,,) = npm.positions(tokenId);
        (uint8 v, bytes32 r, bytes32 s) = _signNftPermit(alicePk, address(vault), tokenId, FAR_DEADLINE);

        vm.prank(alice);
        vault.stakeWithPermit(tokenId, FAR_DEADLINE, v, r, s);

        (uint96 nonceAfter,,,,,,,,,,,) = npm.positions(tokenId);
        assertEq(nonceAfter, nonceBefore + 1, "consuming the permit must advance the position's nonce");

        vm.prank(alice);
        vault.unstake(tokenId);

        vm.prank(alice);
        vm.expectRevert(bytes("Unauthorized"));
        vault.stakeWithPermit(tokenId, FAR_DEADLINE, v, r, s);
    }

    /**
     * @dev The griefing case the vault's NatSpec claims is harmless: a signature is public in
     *      the mempool and anyone may submit it. A front-runner consuming it makes
     *      `stakeWithPermit` revert — and leaves behind exactly the approval that call
     *      wanted, so the plain `stake` retry succeeds. No funds are ever at risk, measured.
     */
    function test_NftPermit_FrontRunningItStillLeavesThePlainStakeWorking() public {
        uint256 tokenId = _mintAroundSpot(alice, 600);
        (uint8 v, bytes32 r, bytes32 s) = _signNftPermit(alicePk, address(vault), tokenId, FAR_DEADLINE);

        // The griefer submits the signature first, from their own account.
        vm.prank(bob);
        npm.permit(address(vault), tokenId, FAR_DEADLINE, v, r, s);
        assertEq(npmExtras.getApproved(tokenId), address(vault), "the front-run left the vault approved");

        vm.prank(alice);
        vm.expectRevert(bytes("Unauthorized"));
        vault.stakeWithPermit(tokenId, FAR_DEADLINE, v, r, s);

        vm.prank(alice);
        vault.stake(tokenId);
        assertEq(vault.stakerOf(tokenId), alice, "the retry through the plain path must succeed");
    }

    /**
     * @dev A real limit of EIP-4494 that only a fork can show. Uniswap's `ERC721Permit`
     *      branches on `Address.isContract(owner)`: a code-bearing owner is routed to
     *      ERC-1271 and a perfectly valid ECDSA signature is never recovered at all. That
     *      covers contract wallets AND ordinary EOAs carrying an EIP-7702 delegation — at the
     *      pinned Sepolia block, several plainly-derived test addresses already do, which is
     *      why {ForkHarness} searches for code-free actors.
     *
     *      The consequence for users: `stakeWithPermit` is unusable from such an account and
     *      the revert carries no message. The plain approve-then-stake route still works, so
     *      nothing is lost beyond the one-transaction convenience.
     */
    function test_NftPermit_ACodeBearingOwnerCannotUseTheEip4494Path() public {
        ReentrantReceiver walletLike = new ReentrantReceiver();
        _fund(profile.asset, address(walletLike), 100_000e18);
        _fund(profile.usdc, address(walletLike), 100_000e6);

        int24 tick = _currentTick();
        uint256 tokenId =
            _mintPositionFor(address(walletLike), _alignDown(tick) - 600, _alignUp(tick) + 600, 10_000e18, 10_000e6);
        (uint8 v, bytes32 r, bytes32 s) = _signNftPermit(alicePk, address(vault), tokenId, FAR_DEADLINE);

        vm.expectRevert();
        walletLike.execute(
            address(vault), abi.encodeCall(LPStakingVault.stakeWithPermit, (tokenId, FAR_DEADLINE, v, r, s))
        );

        // The fallback route is unaffected.
        walletLike.approveErc721(profile.npm, address(vault), tokenId);
        walletLike.execute(address(vault), abi.encodeCall(LPStakingVault.stake, (tokenId)));
        assertEq(vault.stakerOf(tokenId), address(walletLike), "approve-then-stake must still work for a contract");
    }

    // ──────────────────────── EIP-2612 (the USDC side) ─────────

    /**
     * @dev States the profile's token facts on-chain instead of trusting the profile file:
     *      under `sepolia` neither tREAL nor tUSDC implements EIP-2612 at all, so a
     *      `DOMAIN_SEPARATOR()` call does not even return.
     */
    function test_Erc2612_ProfileTokenPermitSurfaceIsWhatTheProfileClaims() public view {
        (bool usdcOk,) = profile.usdc.staticcall(abi.encodeWithSignature("DOMAIN_SEPARATOR()"));
        (bool assetOk,) = profile.asset.staticcall(abi.encodeWithSignature("DOMAIN_SEPARATOR()"));

        assertEq(usdcOk, profile.usdcPermit, "the USDC side's real permit surface must match the profile");
        assertEq(assetOk, profile.assetPermit, "the ASSET side's real permit surface must match the profile");
    }

    /**
     * @dev `zapInWithPermit` L226: the permit is SKIPPED when the standing allowance already
     *      covers `permit.value`. That branch is what lets the zap work against a token with
     *      no permit at all — the signature here is deliberately garbage and never read.
     */
    function test_ZapInWithPermit_SkipsThePermitWhenTheStandingAllowanceCoversIt() public {
        int24 tick = _currentTick();
        SwapParams memory swap =
            SwapParams({zeroForOne: false, amountIn: 10_000e6, amountOutMin: 0, amount0Min: 0, amount1Min: 0});
        PermitData memory permit =
            PermitData({value: ZAP_USDC, deadline: FAR_DEADLINE, v: 27, r: bytes32(0), s: bytes32(0)});

        vm.startPrank(alice);
        usdcToken.approve(address(zapper), ZAP_USDC);
        uint256 tokenId = zapper.zapInWithPermit(
            ZAP_USDC, _alignDown(tick) - 6000, _alignUp(tick) + 6000, swap, FAR_DEADLINE, permit
        );
        vm.stopPrank();

        assertEq(vault.stakerOf(tokenId), alice, "the zap must complete without the permit ever being called");
    }

    /// @dev Exactly-equal allowance still skips: the comparison is `allowance < value`.
    function test_ZapInWithPermit_AllowanceEqualToTheValueStillSkipsThePermit() public {
        int24 tick = _currentTick();
        SwapParams memory swap =
            SwapParams({zeroForOne: false, amountIn: 10_000e6, amountOutMin: 0, amount0Min: 0, amount1Min: 0});
        PermitData memory permit =
            PermitData({value: ZAP_USDC, deadline: FAR_DEADLINE, v: 27, r: bytes32(0), s: bytes32(0)});

        vm.startPrank(alice);
        usdcToken.approve(address(zapper), ZAP_USDC); // exactly permit.value
        uint256 tokenId = zapper.zapInWithPermit(
            ZAP_USDC, _alignDown(tick) - 6000, _alignUp(tick) + 6000, swap, FAR_DEADLINE, permit
        );
        vm.stopPrank();

        assertEq(vault.stakerOf(tokenId), alice, "allowance == permit.value must take the skip branch");
    }

    /**
     * @dev The other arm, and the honest limit of the Sepolia profile: one wei short of the
     *      permit value and the contract really does call `IERC20Permit.permit` — which a
     *      token without EIP-2612 cannot serve. The revert is the token's, not the zapper's.
     */
    function test_ZapInWithPermit_RevertsWhenThePermitMustActuallyBeCalled() public {
        if (profile.usdcPermit) {
            // Under a profile whose USDC does implement EIP-2612 this branch is covered by a
            // real signature instead; nothing to assert here.
            return;
        }

        int24 tick = _currentTick();
        SwapParams memory swap =
            SwapParams({zeroForOne: false, amountIn: 10_000e6, amountOutMin: 0, amount0Min: 0, amount1Min: 0});
        PermitData memory permit =
            PermitData({value: ZAP_USDC, deadline: FAR_DEADLINE, v: 27, r: bytes32(0), s: bytes32(0)});

        vm.startPrank(alice);
        usdcToken.approve(address(zapper), ZAP_USDC - 1); // one wei short -> the permit is attempted
        vm.expectRevert();
        zapper.zapInWithPermit(ZAP_USDC, _alignDown(tick) - 6000, _alignUp(tick) + 6000, swap, FAR_DEADLINE, permit);
        vm.stopPrank();
    }

    /// @dev Standing-allowance safety: a zap consumes exactly the amount it was asked to
    ///      pull, never the whole approval, so leaving an allowance open is bounded by
    ///      `usdcAmount` and not by the approval.
    function test_ZapIn_ConsumesOnlyTheAmountAskedForFromAStandingAllowance() public {
        int24 tick = _currentTick();
        uint256 standing = 90_000e6;

        SwapParams memory swap =
            SwapParams({zeroForOne: false, amountIn: 10_000e6, amountOutMin: 0, amount0Min: 0, amount1Min: 0});

        vm.startPrank(alice);
        usdcToken.approve(address(zapper), standing);
        zapper.zapIn(ZAP_USDC, _alignDown(tick) - 6000, _alignUp(tick) + 6000, swap, FAR_DEADLINE);
        vm.stopPrank();

        assertEq(
            IERC20Like(profile.usdc).allowance(alice, address(zapper)),
            standing - ZAP_USDC,
            "a zap must draw down the standing allowance by exactly usdcAmount"
        );
    }

    /// @dev And the zapper never leaves an allowance of its own behind on the router or the
    ///      position manager — both are reset to zero inside the same call.
    function test_ZapIn_LeavesNoLingeringAllowanceOnTheRouterOrTheManager() public {
        int24 tick = _currentTick();
        SwapParams memory swap =
            SwapParams({zeroForOne: false, amountIn: 10_000e6, amountOutMin: 0, amount0Min: 0, amount1Min: 0});

        vm.startPrank(alice);
        usdcToken.approve(address(zapper), ZAP_USDC);
        zapper.zapIn(ZAP_USDC, _alignDown(tick) - 6000, _alignUp(tick) + 6000, swap, FAR_DEADLINE);
        vm.stopPrank();

        assertEq(IERC20Like(token0).allowance(address(zapper), profile.npm), 0, "no token0 allowance may survive a zap");
        assertEq(IERC20Like(token1).allowance(address(zapper), profile.npm), 0, "no token1 allowance may survive a zap");
        assertEq(
            IERC20Like(profile.usdc).allowance(address(zapper), profile.router),
            0,
            "no router allowance may survive a zap"
        );
    }
}
