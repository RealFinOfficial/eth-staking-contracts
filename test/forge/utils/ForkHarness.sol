// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseForge} from "./BaseForge.sol";
import {Profiles} from "./Profiles.sol";
import {IUniswapV3FactoryLike, IUniswapV3PoolLike, INpmExtras, IERC20Like} from "./Interfaces.sol";

import {TokenX} from "../../../contracts/lp-staking/TokenX.sol";
import {RewardsDistributor} from "../../../contracts/lp-staking/RewardsDistributor.sol";
import {LPStakingVault} from "../../../contracts/lp-staking/LPStakingVault.sol";
import {LPZapper} from "../../../contracts/lp-staking/LPZapper.sol";
import {SwapParams} from "../../../contracts/lp-staking/libraries/TwapGuard.sol";
import {INonfungiblePositionManager} from "../../../contracts/lp-staking/interfaces/INonfungiblePositionManager.sol";
import {ISwapRouter02} from "../../../contracts/lp-staking/interfaces/ISwapRouter02.sol";

/**
 * @title ForkHarness
 * @notice Realism rung: the four production contracts, deployed by this test contract in
 *         the deploy script's own order and wiring, against REAL Uniswap V3 on a pinned
 *         fork of the active {Profiles.Profile}.
 *
 *  `01-contracts.md §5` mandates fork tests against the real NPM / factory / router /
 *  USDC / ASSET, so this is the default rung for adversarial tests: real tick spacing, real
 *  observation array, real router, real EIP-4494 domain, real token semantics.
 *
 *  Sepolia has no tREAL/tUSDC pool on any fee tier, so the harness creates and initializes
 *  one on the fork through the canonical `createAndInitializePoolIfNecessary` and seeds it
 *  with real liquidity. Everything after that point is genuine Uniswap behaviour.
 *
 *  ── Two rungs, because the oracle's coldness is itself a finding ──────────────────────
 *  `_forkAndDeploy()` stops with a **cold** oracle (cardinality 1, no history) — the state a
 *  freshly deployed stack is really in, and the one SEC-01 asserts against.
 *  `_deployForkedStack()` continues into `_warmOracle()` (grow to 100 slots, then 8 warp +
 *  round-trip-swap rounds) and is what every other file uses.
 *
 *  Harness-local parameter divergences from production are annotated inline.
 */
abstract contract ForkHarness is BaseForge {
    // ──────────────────────── Actors ───────────────────────────

    /// @notice Final owner of all four contracts, as in the deploy script (LP_MULTISIG).
    address internal multisig;
    /// @notice Backend voucher signer (LP_SIGNER) and its key, so tests can sign real vouchers.
    address internal voucherSigner;
    uint256 internal voucherSignerPk;

    address internal alice;
    uint256 internal alicePk;
    address internal bob;
    uint256 internal bobPk;
    address internal carol;
    uint256 internal carolPk;
    address internal dave;
    uint256 internal davePk;
    /// @notice Seeds the pool with the liquidity every other actor trades against.
    address internal marketMaker;
    /// @notice Deep pockets, used only to push spot away from the TWAP on purpose.
    address internal whale;

    // ──────────────────────── The stack ────────────────────────

    TokenX internal tokenX;
    RewardsDistributor internal distributor;
    LPStakingVault internal vault;
    LPZapper internal zapper;

    // ──────────────────────── The market ───────────────────────

    IUniswapV3PoolLike internal poolRef;
    INonfungiblePositionManager internal npm;
    INpmExtras internal npmExtras;
    ISwapRouter02 internal router;
    IERC20Like internal asset;
    IERC20Like internal usdcToken;
    address internal token0;
    address internal token1;

    // ──────────────────────── Harness parameters ───────────────

    /// @dev Liquidity the market maker seeds, and the half-width of the range it seeds over.
    ///      +/-12000 ticks is a ~3.3x price band each way: deep enough that ordinary test
    ///      trades barely move spot, narrow enough that a whale can still push it past the
    ///      guard. Production liquidity is whatever LPs supply; nothing asserts on this
    ///      number, it only has to be there.
    uint256 internal constant SEED_ASSET = 5_000_000e18;
    uint256 internal constant SEED_USDC = 2_500_000e6;
    int24 internal constant SEED_HALF_WIDTH = 12000;

    /// @dev Per-user funding. Generous enough that no test has to think about running out.
    uint256 internal constant USER_ASSET = 100_000e18;
    uint256 internal constant USER_USDC = 100_000e6;
    uint256 internal constant WHALE_ASSET = 50_000_000e18;
    uint256 internal constant WHALE_USDC = 50_000_000e6;

    /// @dev Oracle warm-up. 8 x 60s = 480s of history for a 300s window, matching the
    ///      shipped Hardhat fork suite. Production warms up by being traded.
    uint256 internal constant WARMUP_ROUNDS = 8;
    uint256 internal constant WARMUP_STEP_SECONDS = 60;
    uint256 internal constant WARMUP_SWAP_USDC = 25e6;

    /// @dev Oracle slots the deploy script grows the pool into (LP_OBSERVATION_CARDINALITY).
    uint16 internal constant OBSERVATION_CARDINALITY = 100;

    // ──────────────────────── EIP-712 constants ────────────────

    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    /// @dev EIP-4494, as the canonical `NonfungiblePositionManager` declares it.
    bytes32 internal constant NFT_PERMIT_TYPEHASH =
        keccak256("Permit(address spender,uint256 tokenId,uint256 nonce,uint256 deadline)");

    // ──────────────────────── Rung 1: cold stack ───────────────

    /**
     * @dev Forks, makes a market, deploys and wires the stack, funds the actors — and stops
     *      with the pool oracle still cold (cardinality 1, no history). Use directly only
     *      when the coldness is the subject; otherwise call {_deployForkedStack}.
     */
    function _forkAndDeploy() internal {
        _loadProfile();
        vm.createSelectFork(_resolveForkRpc(), profile.pinnedBlock);
        assertEq(block.chainid, profile.chainId, "fork must report the profile's real chain id");

        _makeActors();
        _bindMarket();
        _fundActors();
        _seedPoolLiquidity();
        _deployStack();
    }

    /// @dev The full rung: cold stack, then a usable oracle.
    function _deployForkedStack() internal {
        _forkAndDeploy();
        _warmOracle();
    }

    // ──────────────────────── Setup steps ──────────────────────

    function _makeActors() private {
        (multisig,) = _cleanActor("multisig");
        (voucherSigner, voucherSignerPk) = _cleanActor("voucherSigner");
        (alice, alicePk) = _cleanActor("alice");
        (bob, bobPk) = _cleanActor("bob");
        (carol, carolPk) = _cleanActor("carol");
        (dave, davePk) = _cleanActor("dave");
        (marketMaker,) = _cleanActor("marketMaker");
        (whale,) = _cleanActor("whale");
    }

    /**
     * @dev An actor address that carries NO code on the fork.
     *
     *      This is not paranoia: on Sepolia at the pinned block, the plain
     *      `makeAddrAndKey("alice")` address already holds 23 bytes — an EIP-7702 delegation
     *      designator. Uniswap's `ERC721Permit` branches on `Address.isContract(owner)`, so a
     *      code-bearing owner is routed to ERC-1271 and a perfectly valid ECDSA signature is
     *      never even recovered. Deriving a clean address keeps every other test measuring
     *      what it says it measures; the code-bearing case is then tested deliberately, in
     *      `PermitDomains.t.sol`, instead of poisoning the whole suite.
     *
     *      The search is deterministic for a given pinned block, and re-derives itself if a
     *      later block gives one of these addresses code.
     */
    function _cleanActor(string memory name) private returns (address addr, uint256 pk) {
        for (uint256 i = 0; i < 64; ++i) {
            (addr, pk) = makeAddrAndKey(i == 0 ? name : string.concat(name, vm.toString(i)));
            if (addr.code.length == 0) {
                vm.label(addr, name);
                return (addr, pk);
            }
        }
        revert(string.concat("ForkHarness: no code-free address found for actor '", name, "'"));
    }

    /// @dev Binds the live Uniswap contracts and makes sure a pool exists to bind to.
    function _bindMarket() private {
        npm = INonfungiblePositionManager(profile.npm);
        npmExtras = INpmExtras(profile.npm);
        router = ISwapRouter02(profile.router);
        asset = IERC20Like(profile.asset);
        usdcToken = IERC20Like(profile.usdc);

        (token0, token1) = profile.asset < profile.usdc ? (profile.asset, profile.usdc) : (profile.usdc, profile.asset);

        address poolAddress = profile.pool;
        if (poolAddress == address(0)) {
            // Sepolia has no tREAL/tUSDC pool. Create it through the canonical periphery so
            // the pool is a genuine UniswapV3Pool deployed by the genuine factory.
            poolAddress = npmExtras.createAndInitializePoolIfNecessary(token0, token1, FEE, profile.initialSqrtPriceX96);
        }
        poolRef = IUniswapV3PoolLike(poolAddress);

        assertEq(poolRef.token0(), token0, "bound pool must carry the profile's token0");
        assertEq(poolRef.token1(), token1, "bound pool must carry the profile's token1");
        assertEq(poolRef.fee(), FEE, "bound pool must carry the profile's fee tier");
        assertEq(poolRef.tickSpacing(), TICK_SPACING, "0.30% tier must use 60-tick spacing");
    }

    /**
     * @dev Funds every actor from the profile's funder(s) with a plain `vm.prank` transfer —
     *      real token movement, real balances. `deal` (a storage write) is the automatic
     *      fallback only when no funder holds enough, so the suite still runs if the funder
     *      is drained on a later pinned block.
     */
    function _fundActors() private {
        address[6] memory users = [alice, bob, carol, dave, marketMaker, whale];
        uint256[6] memory assetAmounts = [USER_ASSET, USER_ASSET, USER_ASSET, USER_ASSET, SEED_ASSET * 2, WHALE_ASSET];
        uint256[6] memory usdcAmounts = [USER_USDC, USER_USDC, USER_USDC, USER_USDC, SEED_USDC * 2, WHALE_USDC];

        for (uint256 i = 0; i < users.length; ++i) {
            vm.deal(users[i], 100 ether);
            _fund(profile.asset, users[i], assetAmounts[i]);
            _fund(profile.usdc, users[i], usdcAmounts[i]);
        }
    }

    function _fund(address token, address to, uint256 amount) internal {
        for (uint256 i = 0; i < profile.funders.length; ++i) {
            address funder = profile.funders[i];
            if (IERC20Like(token).balanceOf(funder) >= amount) {
                vm.prank(funder);
                IERC20Like(token).transfer(to, amount);
                return;
            }
        }
        // Fallback: write the balance slot. Only reached when no funder is solvent enough.
        deal(token, to, IERC20Like(token).balanceOf(to) + amount);
    }

    /// @dev One wide market-maker position, so every other trade in the suite has a real
    ///      order book to hit. Nothing asserts on its size.
    function _seedPoolLiquidity() private {
        (, int24 tick,,,,,) = poolRef.slot0();
        int24 lower = _alignDown(tick) - SEED_HALF_WIDTH;
        int24 upper = _alignUp(tick) + SEED_HALF_WIDTH;

        uint256 tokenId = _mintPositionFor(marketMaker, lower, upper, SEED_ASSET, SEED_USDC);
        assertGt(tokenId, 0, "seed mint must produce a position");
        assertGt(poolRef.liquidity(), 0, "pool must hold in-range liquidity after seeding");
    }

    /// @dev Deploy + wiring + ownership, in exactly the order of scripts/deploy-lp-staking.js.
    function _deployStack() private {
        tokenX = new TokenX(TOKENX_NAME, TOKENX_SYMBOL, address(this));
        distributor = new RewardsDistributor(address(tokenX), profile.asset, voucherSigner, address(this));
        vault = new LPStakingVault(
            profile.npm,
            address(poolRef),
            token0,
            token1,
            FEE,
            profile.router,
            address(this),
            profile.twapWindow,
            profile.maxDevTicks
        );
        zapper = new LPZapper(
            address(vault),
            profile.npm,
            address(poolRef),
            token0,
            token1,
            FEE,
            profile.router,
            profile.usdc,
            profile.asset,
            address(this),
            profile.twapWindow,
            profile.maxDevTicks
        );

        // Wiring, while the deployer still owns everything.
        tokenX.setMinter(address(distributor));
        vault.setZapper(address(zapper));
        tokenX.setEpochCap(EPOCH_ONE, EPOCH_ONE_CAP);

        // Ownership to the multisig, as the script does before the oracle warm-up.
        tokenX.transferOwnership(multisig);
        distributor.transferOwnership(multisig);
        vault.transferOwnership(multisig);
        zapper.transferOwnership(multisig);
    }

    /**
     * @dev The permissionless half of the deploy script's tail, plus the history the script
     *      can only tell an operator to go and create: growing the array allocates slots,
     *      but they fill one per block that trades.
     */
    function _warmOracle() internal {
        poolRef.increaseObservationCardinalityNext(OBSERVATION_CARDINALITY);

        for (uint256 i = 0; i < WARMUP_ROUNDS; ++i) {
            _advance(WARMUP_STEP_SECONDS);
            // Round trip: price ends where it started, so spot stays on top of the TWAP and
            // only the observation array actually changes.
            uint256 out = _swap(whale, profile.usdc, profile.asset, WARMUP_SWAP_USDC, 0);
            _swap(whale, profile.asset, profile.usdc, out, 0);
        }
        _advance(WARMUP_STEP_SECONDS);

        (,,, bool withinBounds) = vault.previewTwap();
        assertTrue(withinBounds, "warm-up must leave spot inside the vault's TWAP guard");
    }

    // ──────────────────────── Market helpers ───────────────────

    /// @dev Moves the clock forward and mines, so the oracle sees a new timestamp.
    function _advance(uint256 seconds_) internal {
        vm.warp(block.timestamp + seconds_);
        vm.roll(block.number + 1);
    }

    /// @notice Exact-input swap through the real SwapRouter02, as `who`.
    function _swap(address who, address tokenIn, address tokenOut, uint256 amountIn, uint160 sqrtPriceLimitX96)
        internal
        returns (uint256 amountOut)
    {
        vm.startPrank(who);
        IERC20Like(tokenIn).approve(profile.router, amountIn);
        amountOut = router.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: FEE,
                recipient: who,
                amountIn: amountIn,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: sqrtPriceLimitX96
            })
        );
        IERC20Like(tokenIn).approve(profile.router, 0);
        vm.stopPrank();
    }

    /// @notice Mints a real position NFT to `who` through the real position manager.
    function _mintPositionFor(
        address who,
        int24 tickLower,
        int24 tickUpper,
        uint256 amount0Desired,
        uint256 amount1Desired
    ) internal returns (uint256 tokenId) {
        vm.startPrank(who);
        IERC20Like(token0).approve(profile.npm, amount0Desired);
        IERC20Like(token1).approve(profile.npm, amount1Desired);
        (tokenId,,,) = npm.mint(
            INonfungiblePositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: FEE,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: amount0Desired,
                amount1Desired: amount1Desired,
                amount0Min: 0,
                amount1Min: 0,
                recipient: who,
                deadline: block.timestamp + 1
            })
        );
        IERC20Like(token0).approve(profile.npm, 0);
        IERC20Like(token1).approve(profile.npm, 0);
        vm.stopPrank();
    }

    /// @notice A two-sided position around spot, the shape most tests want.
    function _mintAroundSpot(address who, int24 halfWidth) internal returns (uint256 tokenId) {
        (, int24 tick,,,,,) = poolRef.slot0();
        return _mintPositionFor(who, _alignDown(tick) - halfWidth, _alignUp(tick) + halfWidth, 10_000e18, 10_000e6);
    }

    /// @notice Approves the vault and stakes `tokenId` as `who`.
    function _stakeAs(address who, uint256 tokenId) internal {
        vm.startPrank(who);
        npm.approve(address(vault), tokenId);
        vault.stake(tokenId);
        vm.stopPrank();
    }

    function _currentTick() internal view returns (int24 tick) {
        (, tick,,,,,) = poolRef.slot0();
    }

    /// @notice Whale buys ASSET with USDC, pushing spot UP. ~175 ticks per 50k USDC at the
    ///         seeded depth; nothing asserts on the rate, tests assert on the outcome.
    function _pushSpotUp(uint256 usdcIn) internal returns (int24 movedTo) {
        _swap(whale, profile.usdc, profile.asset, usdcIn, 0);
        return _currentTick();
    }

    /// @notice Whale sells ASSET for USDC, pushing spot DOWN.
    function _pushSpotDown(uint256 assetIn) internal returns (int24 movedTo) {
        _swap(whale, profile.asset, profile.usdc, assetIn, 0);
        return _currentTick();
    }

    /// @notice |spot - TWAP| in ticks, as the guard measures it.
    function _deviationTicks() internal view returns (uint256) {
        (int24 spot, int24 twap,,) = vault.previewTwap();
        return _tickDistance(spot, twap);
    }

    /// @notice Mints a two-sided position around spot for `who` and stakes it.
    function _mintAndStake(address who, int24 halfWidth) internal returns (uint256 tokenId) {
        tokenId = _mintAroundSpot(who, halfWidth);
        _stakeAs(who, tokenId);
    }

    /// @notice The guard's own view, read from the vault so the test never re-implements it.
    function _previewTwap()
        internal
        view
        returns (int24 currentTick, int24 twapTick, int24 maxDeviationTicks, bool withinBounds)
    {
        return vault.previewTwap();
    }

    /// @dev Zero-swap params with no minimums — the "just re-range" leg.
    function _noSwap() internal pure returns (SwapParams memory) {
        return SwapParams({zeroForOne: false, amountIn: 0, amountOutMin: 0, amount0Min: 0, amount1Min: 0});
    }

    // ──────────────────────── Signing helpers ──────────────────

    /// @dev The distributor's live EIP-712 domain separator, rebuilt from what it reports
    ///      about itself (ERC-5267) rather than from constants this file assumes.
    function _distributorDomainSeparator() internal view returns (bytes32) {
        (, string memory name_, string memory version_, uint256 chainId_, address verifying_,,) =
            distributor.eip712Domain();
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH, keccak256(bytes(name_)), keccak256(bytes(version_)), chainId_, verifying_
            )
        );
    }

    /**
     * @notice Signs a claim voucher for `user` with an arbitrary key.
     * @param pk Signing key — {voucherSignerPk} for a valid voucher, anything else to prove
     *           the rejection path.
     * @param typehash `TOKENX_CLAIM_TYPEHASH` or `ASSET_CLAIM_TYPEHASH`; passing the wrong
     *                 one is exactly the cross-leg replay test.
     */
    function _signVoucher(uint256 pk, bytes32 typehash, address user, uint256 cumulativeAmount, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(typehash, user, cumulativeAmount, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _distributorDomainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @notice EIP-4494 permit for a position NFT, signed against the REAL position
    ///         manager's own `DOMAIN_SEPARATOR()` — never a recomputed guess.
    function _signNftPermit(uint256 pk, address spender, uint256 tokenId, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        (uint96 nonce,,,,,,,,,,,) = npm.positions(tokenId);
        bytes32 structHash = keccak256(abi.encode(NFT_PERMIT_TYPEHASH, spender, tokenId, uint256(nonce), deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", npmExtras.DOMAIN_SEPARATOR(), structHash));
        (v, r, s) = vm.sign(pk, digest);
    }
}
