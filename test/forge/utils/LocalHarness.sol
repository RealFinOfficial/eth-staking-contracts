// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseForge} from "./BaseForge.sol";

import {TokenOverture} from "../../../contracts/lp-staking/TokenOverture.sol";
import {RewardsDistributor} from "../../../contracts/lp-staking/RewardsDistributor.sol";
import {LPEpochRegistry} from "../../../contracts/lp-staking/LPEpochRegistry.sol";
import {LPStakingVault} from "../../../contracts/lp-staking/LPStakingVault.sol";
import {LPZapper, PermitData} from "../../../contracts/lp-staking/LPZapper.sol";
import {SwapParams} from "../../../contracts/lp-staking/libraries/TwapGuard.sol";
import {INonfungiblePositionManager} from "../../../contracts/lp-staking/interfaces/INonfungiblePositionManager.sol";

import {MockERC20Permit} from "../../../contracts/lp-staking/mocks/MockERC20Permit.sol";
import {MockPositionManager} from "../../../contracts/lp-staking/mocks/MockPositionManager.sol";
import {MockSwapRouter} from "../../../contracts/lp-staking/mocks/MockSwapRouter.sol";
import {MockUniswapV3Pool} from "../../../contracts/lp-staking/mocks/MockUniswapV3Pool.sol";

/**
 * @title LocalHarness
 * @notice Determinism rung: the five production contracts against the repo's own mocks, no
 *         fork and no RPC.
 *
 *  This is the branch-coverage tier. Every `>` / `>=` boundary, every revert selector and
 *  every single-sided arm is reachable here in one transaction, at a price the fuzzer and
 *  the invariant runner can afford. What it deliberately does NOT claim is realism: the
 *  mocks fake tick math, fee accrual and the oracle. Anything whose truth depends on real
 *  Uniswap behaviour belongs in {ForkHarness}, not here.
 *
 *  Harness-local divergences from production, all deliberate:
 *    * The test contract is the owner of all five proxies, the `guardian` and `operator`
 *      of the vault and the distributor, and the operator of the registry and the zapper.
 *      Production splits these: the owner is a timelock, the guardian is a hot pause-only key
 *      and the operator is a multisig. Collapsing them here keeps every admin call in this tier
 *      callable without a prank; the files where the split itself is the subject
 *      ({AccessControlTest}, {VaultBranchesTest}, {DistributorBranchesTest}) build second
 *      proxies with distinct roles, using {multisig} as the guardian and {operatorSafe} as the
 *      operator.
 *    * The Overture token's minter is the distributor PROXY, exactly as in production: the
 *      token is born with the predicted proxy address ({_predictDistributorProxy}). This
 *      contract therefore mints $OVTR only through `distributor.mintRewardToken`, as the
 *      distributor's operator.
 *    * The distributor is registered with the launch list: $ASSET conditional with claims
 *      CLOSED (as at launch) and $OVTR with claims open. A test that claims $ASSET opens it
 *      with `distributor.setClaimsEnabled(address(asset), true)` first. Both tokens are
 *      pre-funded into the distributor ({DISTRIBUTOR_FUNDING} each): the harness mints $OVTR
 *      into it through `mintRewardToken` and transfers $ASSET into it, exactly as the operator
 *      does.
 *    * `twapWindow` is {MIN_TWAP_WINDOW} (300), which is also the production default, so a
 *      test that warps past a window warps five minutes.
 *    * The pool mock reports spot == TWAP == tick 0, so the guard passes unless a test
 *      moves it.
 */
abstract contract LocalHarness is BaseForge {
    // ──────────────────────── Actors ───────────────────────────

    address internal multisig;
    /// @dev The third admin address, so a three-tier test never has to reuse a user account.
    ///      Named `operatorSafe` rather than `operator` because `operator` is a view function
    ///      on the vault and on the distributor.
    address internal operatorSafe;
    address internal voucherSigner;
    uint256 internal voucherSignerPk;
    address internal alice;
    uint256 internal alicePk;
    address internal bob;
    uint256 internal bobPk;
    address internal carol;
    address internal stranger;

    // ──────────────────────── The stack ────────────────────────

    TokenOverture internal overture;
    RewardsDistributor internal distributor;
    LPEpochRegistry internal registry;
    LPStakingVault internal vault;
    LPZapper internal zapper;

    // ──────────────────────── The fake market ──────────────────

    MockERC20Permit internal asset; // 18 decimals, always token0 (see {_deployTokens})
    MockERC20Permit internal usdcToken; // 6 decimals, always token1
    MockUniswapV3Pool internal poolMock;
    MockPositionManager internal npmMock;
    MockSwapRouter internal routerMock;
    address internal token0;
    address internal token1;

    // ──────────────────────── Parameters ───────────────────────

    uint256 internal constant MINT_SUPPLY_ASSET = 1_000_000_000e18;
    uint256 internal constant MINT_SUPPLY_USDC = 1_000_000_000e6;
    uint256 internal constant USER_ASSET = 1_000_000e18;
    uint256 internal constant USER_USDC = 1_000_000e6;

    /// @dev Principal fabricated positions carry, and the fee accrual tests bolt on.
    uint256 internal constant P_ASSET = 1_000e18;
    uint256 internal constant P_USDC = 1_000e6;
    uint128 internal constant LIQUIDITY = 1_000_000;

    int24 internal constant TICK_LOWER = -600;
    int24 internal constant TICK_UPPER = 600;
    int24 internal constant NEW_TICK_LOWER = -1200;
    int24 internal constant NEW_TICK_UPPER = -600;

    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant ERC2612_PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    // ──────────────────────── The rung ─────────────────────────

    function _deployLocalStack() internal {
        _makeActors();
        _deployTokens();
        _deployMarket();
        _deployStack();
        _fundActors();
    }

    function _makeActors() private {
        multisig = makeAddr("multisig");
        operatorSafe = makeAddr("operatorSafe");
        (voucherSigner, voucherSignerPk) = makeAddrAndKey("voucherSigner");
        (alice, alicePk) = makeAddrAndKey("alice");
        (bob, bobPk) = makeAddrAndKey("bob");
        carol = makeAddr("carol");
        stranger = makeAddr("stranger");
    }

    /**
     * @dev Both real profiles sort the 18-decimal side below the 6-decimal side (ASSET <
     *      USDC on mainnet, tREAL < tUSDC on Sepolia), so the local tier pins the same
     *      ordering — otherwise a test reading `token0` would mean a different token here
     *      than on the fork. CREATE2 with a searched salt makes that a fact rather than a
     *      deployment accident, and the search is deterministic for a fixed bytecode.
     */
    function _deployTokens() private {
        asset = new MockERC20Permit("Asset", "ASSET", MINT_SUPPLY_ASSET, 18);

        for (uint256 salt = 0; salt < 256; ++salt) {
            MockERC20Permit candidate =
                new MockERC20Permit{salt: bytes32(salt)}("USD Coin", "USDC", MINT_SUPPLY_USDC, 6);
            if (address(candidate) > address(asset)) {
                usdcToken = candidate;
                break;
            }
        }
        require(address(usdcToken) != address(0), "LocalHarness: no salt sorted USDC above ASSET");

        token0 = address(asset);
        token1 = address(usdcToken);
    }

    function _deployMarket() private {
        poolMock = new MockUniswapV3Pool(token0, token1, FEE);
        npmMock = new MockPositionManager();
        routerMock = new MockSwapRouter();

        // 0.5 USDC per ASSET, the price both profiles initialize at.
        routerMock.setRate(token1, token0, 2e18, 1e6); // USDC -> ASSET
        routerMock.setRate(token0, token1, 1e6, 2e18); // ASSET -> USDC
        asset.transfer(address(routerMock), 100_000_000e18);
        usdcToken.transfer(address(routerMock), 100_000_000e6);
    }

    function _deployStack() private {
        // The token is born with the distributor PROXY as its minter, the way the deploy script
        // does it: the proxy's address is predicted before the token exists.
        address predictedDistributor = _predictDistributorProxy();
        overture = _deployOvertureProxy(OVERTURE_NAME, OVERTURE_SYMBOL, address(this), predictedDistributor);
        distributor = _deployDistributorProxy(
            address(this),
            address(this),
            address(this),
            voucherSigner,
            address(asset),
            _launchRewardTokens(address(asset), false, address(overture))
        );
        assertEq(address(distributor), predictedDistributor, "the distributor proxy must land on the prediction");
        registry = _deployRegistryProxy(address(distributor), address(this), address(this));
        // `zapper_` is left at zero and set by `setZapper` below: this harness IS the owner,
        // so it can. The deploy script cannot — its proxies are born owned by the timelock —
        // and pre-computes the address instead; {VaultBranchesTest} keeps one test on exactly
        // that path.
        vault = _deployVaultProxy(
            _vaultParams(
                address(npmMock),
                address(poolMock),
                token0,
                token1,
                address(routerMock),
                address(this),
                MIN_TWAP_WINDOW,
                500
            )
        );
        zapper = _deployZapperProxy(
            ZapperProxyParams({
                vault: address(vault),
                positionManager: address(npmMock),
                pool: address(poolMock),
                token0: token0,
                token1: token1,
                fee: FEE,
                swapRouter: address(routerMock),
                usdc: address(usdcToken),
                asset: address(asset),
                owner: address(this),
                operator: address(this),
                twapWindow: MIN_TWAP_WINDOW,
                maxDeviationTicks: 500
            })
        );

        vault.setZapper(address(zapper));
    }

    function _fundActors() private {
        address[4] memory users = [alice, bob, carol, stranger];
        for (uint256 i = 0; i < users.length; ++i) {
            asset.transfer(users[i], USER_ASSET);
            usdcToken.transfer(users[i], USER_USDC);
            vm.deal(users[i], 100 ether);
        }
        // Pre-funds both reward tokens, the way the operator does: $OVTR minted INTO the
        // distributor through `mintRewardToken` (the harness is the operator, the distributor is
        // the minter), $ASSET transferred into it.
        distributor.mintRewardToken(address(overture), address(distributor), DISTRIBUTOR_FUNDING);
        asset.transfer(address(distributor), DISTRIBUTOR_FUNDING);
    }

    // ──────────────────────── Position helpers ─────────────────

    /**
     * @notice Fabricates a position NFT for `holder` and funds the position manager so a
     *         later `collect` can really pay the principal out.
     */
    function _createPosition(address holder, int24 tickLower, int24 tickUpper, uint128 liquidity)
        internal
        returns (uint256 tokenId)
    {
        return _createPositionOn(holder, token0, token1, FEE, tickLower, tickUpper, liquidity, P_ASSET, P_USDC);
    }

    function _createPositionOn(
        address holder,
        address t0,
        address t1,
        uint24 fee_,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint256 principal0,
        uint256 principal1
    ) internal returns (uint256 tokenId) {
        npmMock.mintFake(holder, t0, t1, fee_, tickLower, tickUpper, liquidity, principal0, principal1);
        tokenId = npmMock.lastMintedId();
        if (t0 == token0 && principal0 > 0) asset.transfer(address(npmMock), principal0);
        if (t1 == token1 && principal1 > 0) usdcToken.transfer(address(npmMock), principal1);
    }

    /// @notice Fabricates a position, approves the vault and stakes it as `holder`.
    function _stakePosition(address holder) internal returns (uint256 tokenId) {
        tokenId = _createPosition(holder, TICK_LOWER, TICK_UPPER, LIQUIDITY);
        vm.startPrank(holder);
        npmMock.approve(address(vault), tokenId);
        vault.stake(tokenId);
        vm.stopPrank();
    }

    /// @dev Zero-swap params with no minimums — the "just re-range" leg.
    function _noSwap() internal pure returns (SwapParams memory) {
        return SwapParams({zeroForOne: true, amountIn: 0, amountOutMin: 0, amount0Min: 0, amount1Min: 0});
    }

    /// @dev An unusable permit payload, for the paths where the permit must be SKIPPED.
    function _dummyPermit(uint256 value) internal pure returns (PermitData memory) {
        return PermitData({value: value, deadline: FAR_DEADLINE, v: 27, r: bytes32(0), s: bytes32(0)});
    }

    // ──────────────────────── Signing helpers ──────────────────

    function _distributorDomainSeparator() internal view returns (bytes32) {
        return _domainSeparatorOf(distributor);
    }

    /// @dev The digest `distributor.claim(token, ...)` recovers the signer from.
    function _voucherDigest(address token, address user, uint256 cumulativeAmount, uint256 deadline)
        internal
        view
        returns (bytes32)
    {
        return _rewardClaimDigest(distributor, token, user, cumulativeAmount, deadline);
    }

    /// @notice Signs a `RewardClaim` voucher with an arbitrary key — {voucherSignerPk} for a valid
    ///         one, anything else to prove the rejection path.
    function _signVoucher(uint256 pk, address token, address user, uint256 cumulativeAmount, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _voucherDigest(token, user, cumulativeAmount, deadline));
        return abi.encodePacked(r, s, v);
    }

    /// @notice EIP-2612 permit over a {MockERC20Permit}, signed against its live domain.
    function _signErc2612(
        uint256 pk,
        MockERC20Permit token,
        address owner_,
        address spender,
        uint256 value,
        uint256 deadline
    ) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 structHash = keccak256(
            abi.encode(ERC2612_PERMIT_TYPEHASH, owner_, spender, value, token.nonces(owner_), deadline)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (v, r, s) = vm.sign(pk, digest);
    }
}
