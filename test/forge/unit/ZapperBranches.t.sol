// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LocalHarness} from "../utils/LocalHarness.sol";
import {LPStakingVault} from "../../../contracts/lp-staking/LPStakingVault.sol";
import {LPZapper, PermitData} from "../../../contracts/lp-staking/LPZapper.sol";
import {SwapParams} from "../../../contracts/lp-staking/libraries/TwapGuard.sol";
import {MockUniswapV3Pool} from "../../../contracts/lp-staking/mocks/MockUniswapV3Pool.sol";
import {MockERC20Permit} from "../../../contracts/lp-staking/mocks/MockERC20Permit.sol";
import {MaliciousNPM} from "../utils/attackers/MaliciousNPM.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @notice Why this file exists: {LPZapper} is the only entry point that touches a user's
 *         ERC-20 balance, and its two most delicate decisions — the allowance-versus-permit
 *         branch and the "spend the whole balance" mint — are pure arithmetic on amounts.
 *         Both are stated here at their exact boundaries, against a token that really does
 *         implement EIP-2612 so the permit arm is exercised rather than argued about.
 */
contract ZapperBranchesTest is LocalHarness {
    uint256 internal constant ZAP = 1_000e6;

    /// @dev Cached in storage on purpose. `_zapSwap` is called inline in test arguments, and
    ///      an EXTERNAL read there would consume the `vm.prank` / `vm.expectRevert` armed on
    ///      the line above it — those cheatcodes bind to the very next call frame.
    bool internal usdcIsToken0Cached;

    function setUp() public {
        _deployLocalStack();
        usdcIsToken0Cached = zapper.usdcIsToken0();
    }

    // ──────────────────────── Constructor ──────────────────────

    function test_Constructor_RejectsAZeroVault() public {
        vm.expectRevert(LPZapper.ZeroAddress.selector);
        _deployZapper(
            address(0), address(npmMock), address(routerMock), token0, token1, address(usdcToken), address(asset)
        );
    }

    function test_Constructor_RejectsAZeroPositionManager() public {
        vm.expectRevert(LPZapper.ZeroAddress.selector);
        _deployZapper(
            address(vault), address(0), address(routerMock), token0, token1, address(usdcToken), address(asset)
        );
    }

    function test_Constructor_RejectsAZeroSwapRouter() public {
        vm.expectRevert(LPZapper.ZeroAddress.selector);
        _deployZapper(address(vault), address(npmMock), address(0), token0, token1, address(usdcToken), address(asset));
    }

    function test_Constructor_RejectsAZeroTokenOnEitherSide() public {
        vm.expectRevert(LPZapper.ZeroAddress.selector);
        _deployZapper(
            address(vault),
            address(npmMock),
            address(routerMock),
            address(0),
            token1,
            address(usdcToken),
            address(asset)
        );

        vm.expectRevert(LPZapper.ZeroAddress.selector);
        _deployZapper(
            address(vault),
            address(npmMock),
            address(routerMock),
            token0,
            address(0),
            address(usdcToken),
            address(asset)
        );
    }

    function test_Constructor_RejectsAnUnsortedOrDuplicatedPair() public {
        vm.expectRevert(abi.encodeWithSelector(LPZapper.TokensNotSorted.selector, token1, token0));
        _deployZapper(
            address(vault), address(npmMock), address(routerMock), token1, token0, address(usdcToken), address(asset)
        );

        vm.expectRevert(abi.encodeWithSelector(LPZapper.TokensNotSorted.selector, token0, token0));
        _deployZapper(
            address(vault), address(npmMock), address(routerMock), token0, token0, address(usdcToken), address(asset)
        );
    }

    function test_Constructor_RejectsAPoolThatIsNotTheConfiguredTriple() public {
        MockUniswapV3Pool wrong = new MockUniswapV3Pool(token0, token1, FEE);
        wrong.setFee(10_000);

        vm.expectRevert(abi.encodeWithSelector(LPZapper.PoolMismatch.selector, token0, token1, uint24(10_000)));
        new LPZapper(
            address(vault),
            address(npmMock),
            address(wrong),
            token0,
            token1,
            FEE,
            address(routerMock),
            address(usdcToken),
            address(asset),
            address(this),
            MIN_TWAP_WINDOW,
            500
        );
    }

    /// @dev USDC and ASSET must BE the pair, in one order or the other. A third token is the
    ///      misconfiguration this check exists to stop.
    function test_Constructor_RejectsAUsdcAssetPairThatIsNotThePoolPair() public {
        MockERC20Permit outsider = new MockERC20Permit("Outsider", "OUT", 1e24, 18);

        vm.expectRevert(
            abi.encodeWithSelector(
                LPZapper.TokenPairMismatch.selector, address(outsider), address(asset), token0, token1
            )
        );
        _deployZapper(
            address(vault), address(npmMock), address(routerMock), token0, token1, address(outsider), address(asset)
        );
    }

    /// @dev Both orientations must be accepted, and `usdcIsToken0` must record which one.
    function test_Constructor_RecordsWhichSideOfThePairIsUsdc() public view {
        assertFalse(zapper.usdcIsToken0(), "the harness pins ASSET as token0, so USDC is token1");
        assertEq(zapper.usdc(), address(usdcToken), "the USDC side must be stored as given");
        assertEq(zapper.asset(), address(asset), "the ASSET side must be stored as given");
    }

    function test_Constructor_AcceptsTheReversedPairOrientation() public {
        LPZapper reversed = _deployZapper(
            address(vault), address(npmMock), address(routerMock), token0, token1, address(asset), address(usdcToken)
        );
        assertTrue(reversed.usdcIsToken0(), "naming token0 as the USDC side must flip the recorded orientation");
    }

    // ──────────────────────── zapIn amounts ────────────────────

    function test_ZapIn_RevertsOnAZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(LPZapper.ZeroAmount.selector);
        zapper.zapIn(0, TICK_LOWER, TICK_UPPER, _zapSwap(0), FAR_DEADLINE);
    }

    /// @dev `swap.amountIn > usdcAmount` — swapping the ENTIRE input is the allowed edge.
    function test_ZapIn_SwappingTheWholeInputIsAllowed() public {
        vm.startPrank(alice);
        usdcToken.approve(address(zapper), ZAP);
        uint256 tokenId = zapper.zapIn(ZAP, TICK_LOWER, TICK_UPPER, _zapSwap(ZAP), FAR_DEADLINE);
        vm.stopPrank();

        assertEq(vault.stakerOf(tokenId), alice, "a fully-swapped zap must still mint and stake");
        assertEq(usdcToken.balanceOf(address(zapper)), 0, "and leave no USDC behind");
    }

    function test_ZapIn_OneWeiPastTheInputReverts() public {
        vm.startPrank(alice);
        usdcToken.approve(address(zapper), ZAP);
        vm.expectRevert(abi.encodeWithSelector(LPZapper.SwapAmountExceedsInput.selector, ZAP + 1, ZAP));
        zapper.zapIn(ZAP, TICK_LOWER, TICK_UPPER, _zapSwap(ZAP + 1), FAR_DEADLINE);
        vm.stopPrank();
    }

    /// @dev `amountIn == 0` skips the swap entirely; the zap then mints from USDC alone.
    function test_ZapIn_ZeroSwapLegNeverTouchesTheRouter() public {
        vm.startPrank(alice);
        usdcToken.approve(address(zapper), ZAP);
        zapper.zapIn(ZAP, TICK_LOWER, TICK_UPPER, _zapSwap(0), FAR_DEADLINE);
        vm.stopPrank();

        assertEq(routerMock.swapCalls(), 0, "a zero swap leg must not call the router");
    }

    function test_ZapIn_RevertsOnTheWrongSwapDirection() public {
        SwapParams memory swap = SwapParams({
            zeroForOne: !zapper.usdcIsToken0(), amountIn: ZAP / 2, amountOutMin: 0, amount0Min: 0, amount1Min: 0
        });

        vm.startPrank(alice);
        usdcToken.approve(address(zapper), ZAP);
        vm.expectRevert(
            abi.encodeWithSelector(
                LPZapper.InvalidSwapDirection.selector, !zapper.usdcIsToken0(), zapper.usdcIsToken0()
            )
        );
        zapper.zapIn(ZAP, TICK_LOWER, TICK_UPPER, swap, FAR_DEADLINE);
        vm.stopPrank();
    }

    /// @dev Every leftover wei goes back to the caller, on both legs.
    function test_ZapIn_RefundsBothLegsToTheCaller() public {
        npmMock.setMintConsumeBps(5_000);
        uint256 usdcBefore = usdcToken.balanceOf(alice);
        uint256 assetBefore = asset.balanceOf(alice);

        vm.startPrank(alice);
        usdcToken.approve(address(zapper), ZAP);
        zapper.zapIn(ZAP, TICK_LOWER, TICK_UPPER, _zapSwap(ZAP / 2), FAR_DEADLINE);
        vm.stopPrank();

        assertGt(asset.balanceOf(alice), assetBefore, "unconsumed ASSET must come back");
        // 500e6 was swapped away; of the 500e6 left the mint takes half and half is refunded.
        assertEq(usdcBefore - usdcToken.balanceOf(alice), ZAP - ZAP / 4, "only the consumed USDC may be kept");
        assertEq(usdcToken.balanceOf(address(zapper)), 0, "no USDC may stay on the zapper");
        assertEq(asset.balanceOf(address(zapper)), 0, "no ASSET may stay on the zapper");
    }

    // ──────────────────────── permit branch ────────────────────

    /// @dev The real EIP-2612 arm: no standing allowance, so the signature IS what authorises
    ///      the pull. This is the branch the Sepolia fork profile cannot reach, because its
    ///      test tokens have no permit at all.
    function test_ZapInWithPermit_UsesTheSignatureWhenThereIsNoAllowance() public {
        (uint8 v, bytes32 r, bytes32 s) = _signErc2612(alicePk, usdcToken, alice, address(zapper), ZAP, FAR_DEADLINE);
        PermitData memory permit = PermitData({value: ZAP, deadline: FAR_DEADLINE, v: v, r: r, s: s});

        assertEq(usdcToken.allowance(alice, address(zapper)), 0, "precondition: nothing is approved yet");

        vm.prank(alice);
        uint256 tokenId = zapper.zapInWithPermit(ZAP, TICK_LOWER, TICK_UPPER, _zapSwap(ZAP / 2), FAR_DEADLINE, permit);

        assertEq(vault.stakerOf(tokenId), alice, "the permit alone must be enough to zap");
    }

    /// @dev `allowance < permit.value` — one wei short is enough to make the permit run.
    function test_ZapInWithPermit_AllowanceOneWeiShortStillCallsThePermit() public {
        (uint8 v, bytes32 r, bytes32 s) = _signErc2612(alicePk, usdcToken, alice, address(zapper), ZAP, FAR_DEADLINE);
        PermitData memory permit = PermitData({value: ZAP, deadline: FAR_DEADLINE, v: v, r: r, s: s});

        vm.startPrank(alice);
        usdcToken.approve(address(zapper), ZAP - 1);
        zapper.zapInWithPermit(ZAP, TICK_LOWER, TICK_UPPER, _zapSwap(ZAP / 2), FAR_DEADLINE, permit);
        vm.stopPrank();

        assertEq(usdcToken.nonces(alice), 1, "the permit must have been consumed, so the nonce moved");
    }

    /// @dev `allowance == permit.value` — the skip arm. The signature is garbage on purpose:
    ///      if it were read at all, this would revert.
    function test_ZapInWithPermit_AllowanceExactlyEqualSkipsThePermit() public {
        PermitData memory permit = _dummyPermit(ZAP);

        vm.startPrank(alice);
        usdcToken.approve(address(zapper), ZAP);
        zapper.zapInWithPermit(ZAP, TICK_LOWER, TICK_UPPER, _zapSwap(ZAP / 2), FAR_DEADLINE, permit);
        vm.stopPrank();

        assertEq(usdcToken.nonces(alice), 0, "the permit must NOT have been consumed on the skip arm");
    }

    /// @dev The griefing case the NatSpec claims is harmless: a front-runner consumes the
    ///      signature, which leaves exactly the allowance the zap needs, so the zap succeeds.
    function test_ZapInWithPermit_SurvivesAFrontRunOfItsOwnSignature() public {
        (uint8 v, bytes32 r, bytes32 s) = _signErc2612(alicePk, usdcToken, alice, address(zapper), ZAP, FAR_DEADLINE);
        PermitData memory permit = PermitData({value: ZAP, deadline: FAR_DEADLINE, v: v, r: r, s: s});

        vm.prank(bob);
        usdcToken.permit(alice, address(zapper), ZAP, FAR_DEADLINE, v, r, s);
        assertEq(usdcToken.allowance(alice, address(zapper)), ZAP, "the front-run left the allowance in place");

        vm.prank(alice);
        uint256 tokenId = zapper.zapInWithPermit(ZAP, TICK_LOWER, TICK_UPPER, _zapSwap(ZAP / 2), FAR_DEADLINE, permit);
        assertEq(vault.stakerOf(tokenId), alice, "the zap must succeed anyway, on the allowance the griefer created");
    }

    /// @dev A permit that is neither covered by an allowance nor valid fails in the token.
    function test_ZapInWithPermit_RevertsOnAnUnusableSignature() public {
        PermitData memory permit = _dummyPermit(ZAP);

        vm.prank(alice);
        vm.expectRevert();
        zapper.zapInWithPermit(ZAP, TICK_LOWER, TICK_UPPER, _zapSwap(ZAP / 2), FAR_DEADLINE, permit);
    }

    // ──────────────────────── vault errors bubbling ────────────

    /**
     * @dev The three `stakeFor` rejections, raised through the zapper's own identity. With the
     *      canonical position manager a zap can never construct them — it mints a fresh id
     *      every time — so they are driven directly from the zapper address, which is exactly
     *      the caller the vault sees.
     */
    function test_StakeFor_BubblesAlreadyStakedFromTheVault() public {
        uint256 tokenId = _stakePosition(alice);

        vm.prank(address(zapper));
        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.AlreadyStaked.selector, tokenId, alice));
        vault.stakeFor(bob, tokenId);
    }

    function test_StakeFor_BubblesEmptyPositionFromTheVault() public {
        uint256 tokenId = _createPositionOn(address(zapper), token0, token1, FEE, TICK_LOWER, TICK_UPPER, 0, 0, 0);

        vm.startPrank(address(zapper));
        npmMock.approve(address(vault), tokenId);
        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.EmptyPosition.selector, tokenId));
        vault.stakeFor(alice, tokenId);
        vm.stopPrank();
    }

    function test_StakeFor_BubblesPositionPoolMismatchFromTheVault() public {
        uint256 tokenId =
            _createPositionOn(address(zapper), token0, token1, 500, TICK_LOWER, TICK_UPPER, LIQUIDITY, 0, 0);

        vm.startPrank(address(zapper));
        npmMock.approve(address(vault), tokenId);
        vm.expectRevert(
            abi.encodeWithSelector(LPStakingVault.PositionPoolMismatch.selector, tokenId, token0, token1, uint24(500))
        );
        vault.stakeFor(alice, tokenId);
        vm.stopPrank();
    }

    /**
     * @dev A position manager that hands back a tokenId someone is already staking is stopped
     *      one step EARLIER than the vault's `AlreadyStaked` check: the zapper's
     *      `positionManager.approve` reverts, because the zapper does not own the token it was
     *      told it minted. Worth pinning, because the vault's own guard is not what saves the
     *      existing staker here.
     */
    function test_ZapIn_AManagerReturningALiveTokenIdIsStoppedAtTheApprove() public {
        (LPStakingVault evilVault, LPZapper evilZapper, MaliciousNPM evilNpm) = _deployEvilStack();

        // alice stakes a position on the evil stack, then the manager is told to hand its id
        // back out of the next mint.
        evilNpm.mintFake(alice, token0, token1, FEE, TICK_LOWER, TICK_UPPER, LIQUIDITY, P_ASSET, P_USDC);
        uint256 live = evilNpm.lastMintedId();
        vm.startPrank(alice);
        evilNpm.approve(address(evilVault), live);
        evilVault.stake(live);
        vm.stopPrank();

        evilNpm.setMintReturnsExistingId(live);

        vm.startPrank(alice);
        usdcToken.approve(address(evilZapper), ZAP);
        vm.expectRevert();
        evilZapper.zapIn(ZAP, TICK_LOWER, TICK_UPPER, _zapSwap(ZAP / 2), FAR_DEADLINE);
        vm.stopPrank();

        assertEq(evilVault.stakerOf(live), alice, "the existing staker's record must survive the attempt");
    }

    // ──────────────────────── Owner surface ────────────────────

    function test_Sweep_MovesTheNamedAmountAndEmitsIt() public {
        vm.prank(alice);
        usdcToken.transfer(address(zapper), 500e6);

        vm.expectEmit(true, true, false, true, address(zapper));
        emit LPZapper.Swept(address(usdcToken), carol, 500e6);
        zapper.sweep(address(usdcToken), 500e6, carol);

        assertEq(usdcToken.balanceOf(address(zapper)), 0, "the sweep must clear the zapper");
    }

    /// @dev A zero amount is a legal no-op transfer, and still emits — the event is the
    ///      audit trail, not the movement.
    function test_Sweep_AcceptsAZeroAmount() public {
        vm.expectEmit(true, true, false, true, address(zapper));
        emit LPZapper.Swept(address(usdcToken), carol, 0);
        zapper.sweep(address(usdcToken), 0, carol);
    }

    function test_Sweep_RejectsTheZeroRecipient() public {
        vm.expectRevert(LPZapper.ZeroAddress.selector);
        zapper.sweep(address(usdcToken), 1, address(0));
    }

    /// @dev A zero token address is not special-cased anywhere; it fails in `SafeERC20`,
    ///      which refuses to call an address with no code.
    function test_Sweep_RejectsAZeroTokenAddress() public {
        vm.expectRevert();
        zapper.sweep(address(0), 1, carol);
    }

    function test_Sweep_RevertsWhenTheZapperDoesNotHoldTheAmount() public {
        vm.expectRevert();
        zapper.sweep(address(usdcToken), 1, carol);
    }

    function test_Sweep_IsOwnerOnly() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        zapper.sweep(address(usdcToken), 0, carol);
    }

    function test_RescuePosition_SendsAStrayNftToTheOwnerAndIsOwnerOnly() public {
        uint256 tokenId = _createPosition(alice, TICK_LOWER, TICK_UPPER, LIQUIDITY);
        vm.prank(alice);
        npmMock.transferFrom(alice, address(zapper), tokenId);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        zapper.rescuePosition(tokenId);

        zapper.rescuePosition(tokenId);
        assertEq(npmMock.ownerOf(tokenId), address(this), "the rescue must land on owner()");
    }

    function test_RescuePosition_RevertsWhenTheZapperDoesNotOwnTheToken() public {
        uint256 tokenId = _createPosition(alice, TICK_LOWER, TICK_UPPER, LIQUIDITY);

        vm.expectRevert();
        zapper.rescuePosition(tokenId);
    }

    // ──────────────────────── Receiver + preview ───────────────

    function test_Receiver_RejectsForeignNftsAndUnsolicitedPositions() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LPZapper.UnexpectedNftSender.selector, alice));
        zapper.onERC721Received(alice, alice, 1, "");

        vm.prank(address(npmMock));
        vm.expectRevert(abi.encodeWithSelector(LPZapper.UnsolicitedPosition.selector, alice, bob, uint256(3)));
        zapper.onERC721Received(alice, bob, 3, "");
    }

    /// @dev The success arm of the same hook. The canonical position manager mints with
    ///      `_mint` and never calls back, so this window is opened purely defensively — which
    ///      means only a manager that DOES call back can prove it works. Found by coverage:
    ///      without this test the `return` in `onERC721Received` is never executed.
    function test_Receiver_AcceptsTheCallbackFromTheZappersOwnMint() public {
        npmMock.setSafeMintEnabled(true);

        vm.startPrank(alice);
        usdcToken.approve(address(zapper), ZAP);
        uint256 tokenId = zapper.zapIn(ZAP, TICK_LOWER, TICK_UPPER, _zapSwap(ZAP / 2), FAR_DEADLINE);
        vm.stopPrank();

        assertEq(vault.stakerOf(tokenId), alice, "a call-back-happy manager must not break the zap");
    }

    /// @dev The zapper carries its own copy of the guard, tuned separately from the vault's.
    function test_PreviewTwap_ReadsTheZappersOwnParameters() public {
        poolMock.setTicks(int24(300), int24(0));

        (int24 spot, int24 mean, int24 ceiling, bool ok) = zapper.previewTwap();
        assertEq(spot, 300, "the preview must report the pool's spot tick");
        assertEq(mean, 0, "the preview must report the pool's mean tick");
        assertEq(ceiling, 500, "the preview must report the zapper's own ceiling");
        assertTrue(ok, "a 300-tick drift is inside a 500-tick ceiling");

        zapper.setTwapParams(MIN_TWAP_WINDOW, 200);
        (,,, bool tightened) = zapper.previewTwap();
        assertFalse(tightened, "retuning only the zapper must change only the zapper's answer");

        (,,, bool vaultUnchanged) = vault.previewTwap();
        assertTrue(vaultUnchanged, "the vault's own guard must be untouched");
    }

    function test_RenounceOwnership_KillsTheZappersAdminSurfaceOnly() public {
        zapper.renounceOwnership();
        assertEq(zapper.owner(), address(0), "ownership really is gone");

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        zapper.sweep(address(usdcToken), 0, carol);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        zapper.setTwapParams(600, 100);

        vm.startPrank(alice);
        usdcToken.approve(address(zapper), ZAP);
        uint256 tokenId = zapper.zapIn(ZAP, TICK_LOWER, TICK_UPPER, _zapSwap(ZAP / 2), FAR_DEADLINE);
        vm.stopPrank();
        assertEq(vault.stakerOf(tokenId), alice, "zapping must survive the loss of the zapper's owner");
    }

    // ──────────────────────── Helpers ──────────────────────────

    function _zapSwap(uint256 amountIn) private view returns (SwapParams memory) {
        return
            SwapParams({
                zeroForOne: usdcIsToken0Cached, amountIn: amountIn, amountOutMin: 0, amount0Min: 0, amount1Min: 0
            });
    }

    function _deployZapper(
        address vault_,
        address npm_,
        address router_,
        address t0,
        address t1,
        address usdc_,
        address asset_
    ) private returns (LPZapper) {
        return new LPZapper(
            vault_, npm_, address(poolMock), t0, t1, FEE, router_, usdc_, asset_, address(this), MIN_TWAP_WINDOW, 500
        );
    }

    /// @dev A parallel stack bound to a position manager that lies. Separate contracts,
    ///      because both the vault's and the zapper's manager are immutable.
    function _deployEvilStack() private returns (LPStakingVault v, LPZapper z, MaliciousNPM n) {
        n = new MaliciousNPM();
        v = new LPStakingVault(
            address(n), address(poolMock), token0, token1, FEE, address(routerMock), address(this), MIN_TWAP_WINDOW, 500
        );
        z = new LPZapper(
            address(v),
            address(n),
            address(poolMock),
            token0,
            token1,
            FEE,
            address(routerMock),
            address(usdcToken),
            address(asset),
            address(this),
            MIN_TWAP_WINDOW,
            500
        );
        v.setZapper(address(z));
        asset.transfer(address(n), 1_000_000e18);
        usdcToken.transfer(address(n), 1_000_000e6);
    }
}
