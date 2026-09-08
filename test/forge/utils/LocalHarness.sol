// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseForge} from "./BaseForge.sol";

import {TokenX} from "../../../contracts/lp-staking/TokenX.sol";
import {RewardsDistributor} from "../../../contracts/lp-staking/RewardsDistributor.sol";
import {LPStakingVault} from "../../../contracts/lp-staking/LPStakingVault.sol";
import {LPZapper, PermitData} from "../../../contracts/lp-staking/LPZapper.sol";
import {ApeBondPositionAdapter} from "../../../contracts/lp-staking/ApeBondPositionAdapter.sol";
import {SwapParams} from "../../../contracts/lp-staking/libraries/TwapGuard.sol";
import {INonfungiblePositionManager} from "../../../contracts/lp-staking/interfaces/INonfungiblePositionManager.sol";

import {MockERC20Permit} from "../../../contracts/lp-staking/mocks/MockERC20Permit.sol";
import {MockPositionManager} from "../../../contracts/lp-staking/mocks/MockPositionManager.sol";
import {MockSwapRouter} from "../../../contracts/lp-staking/mocks/MockSwapRouter.sol";
import {MockUniswapV3Pool} from "../../../contracts/lp-staking/mocks/MockUniswapV3Pool.sol";

/**
 * @title LocalHarness
 * @notice Determinism rung: the four production contracts against the repo's own mocks, no
 *         fork and no RPC.
 *
 *  This is the branch-coverage tier. Every `>` / `>=` boundary, every revert selector and
 *  every single-sided arm is reachable here in one transaction, at a price the fuzzer and
 *  the invariant runner can afford. What it deliberately does NOT claim is realism: the
 *  mocks fake tick math, fee accrual and the oracle. Anything whose truth depends on real
 *  Uniswap behaviour belongs in {ForkHarness}, not here.
 *
 *  Harness-local divergences from production, all deliberate:
 *    * The test contract stays the owner of all four contracts, and is ALSO the `guardian`
 *      AND the `operator` of the two proxies (the vault and the distributor). Production
 *      splits all three: the owner is a timelock, the guardian is a hot pause-only key and
 *      the operator is a multisig. Collapsing them here keeps every admin call in this tier
 *      callable without a prank; the files where the split itself is the subject
 *      ({AccessControlTest}, {VaultBranchesTest}, {DistributorBranchesTest}) build a second
 *      proxy with three distinct roles through {BaseForge-_deployVaultProxy} and
 *      {BaseForge-_deployDistributorProxy}, using {multisig} as the guardian and
 *      {operatorSafe} as the operator. Production also transfers ownership to LP_MULTISIG at
 *      the end of the deploy script; the access-control file re-creates that split explicitly
 *      where it is the subject.
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

    TokenX internal tokenX;
    RewardsDistributor internal distributor;
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

    /// @dev {ApeBondPositionAdapter}'s EIP-712 domain, re-declared for the same reason as the
    ///      typehash below. It is deliberately NOT the distributor's "RealLPRewards": spec §6.4
    ///      keeps the purchase signer apart from the rewards-voucher signer.
    string internal constant APE_BOND_DOMAIN_NAME = "RealApeBondPurchase";
    string internal constant APE_BOND_DOMAIN_VERSION = "1";

    /// @dev {ApeBondPositionAdapter-PURCHASE_AUTHORIZATION_TYPEHASH}, re-declared here so a
    ///      change to the struct fails a test instead of quietly re-signing the new shape.
    bytes32 internal constant PURCHASE_AUTHORIZATION_TYPEHASH = keccak256(
        "PurchaseAuthorization(bytes32 purchaseId,bytes32 campaignId,bytes32 soulZapRequestId,address beneficiary,address soulZapCaller,address inputToken,uint256 grossInputAmount,uint256 netInputAmount,uint256 guaranteedBonusAmount,uint64 bonusUnlockAt,uint128 minLiquidity,int24 expectedTickLower,int24 expectedTickUpper,uint256 nonce,uint256 deadline)"
    );

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
        tokenX = new TokenX(TOKENX_NAME, TOKENX_SYMBOL, address(this));
        distributor = _deployDistributorProxy(
            address(tokenX), address(asset), address(this), address(this), address(this), voucherSigner
        );
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
        zapper = new LPZapper(
            address(vault),
            address(npmMock),
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

        tokenX.setMinter(address(distributor));
        vault.setZapper(address(zapper));
        tokenX.setEpochCap(EPOCH_ONE, EPOCH_ONE_CAP);
    }

    function _fundActors() private {
        address[4] memory users = [alice, bob, carol, stranger];
        for (uint256 i = 0; i < users.length; ++i) {
            asset.transfer(users[i], USER_ASSET);
            usdcToken.transfer(users[i], USER_USDC);
            vm.deal(users[i], 100 ether);
        }
        // Pre-funds the ASSET leg so `claimAsset` has something to pay out.
        asset.transfer(address(distributor), 10_000_000e18);
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
        (, string memory name_, string memory version_, uint256 chainId_, address verifying_,,) =
            distributor.eip712Domain();
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH, keccak256(bytes(name_)), keccak256(bytes(version_)), chainId_, verifying_
            )
        );
    }

    function _voucherDigest(bytes32 typehash, address user, uint256 cumulativeAmount, uint256 deadline)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(typehash, user, cumulativeAmount, deadline));
        return keccak256(abi.encodePacked("\x19\x01", _distributorDomainSeparator(), structHash));
    }

    function _signVoucher(uint256 pk, bytes32 typehash, address user, uint256 cumulativeAmount, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _voucherDigest(typehash, user, cumulativeAmount, deadline));
        return abi.encodePacked(r, s, v);
    }

    /**
     * @dev The adapter's EIP-712 domain separator, RECOMPUTED from the name and version the
     *      contract declares rather than read back over a call. Two reasons, both practical:
     *      `vm.expectRevert` attaches to the next call, so a signing helper that made one of its
     *      own would swallow the expectation in every rejection test; and re-declaring the pair
     *      here is the harness's usual pin — a rename in the contract fails a test instead of
     *      quietly re-signing under the new name. That the contract really reports these two is
     *      asserted separately, by `test_Domain_IsTheDeclaredOne`.
     */
    function _adapterDomainSeparator(ApeBondPositionAdapter adapter_) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes(APE_BOND_DOMAIN_NAME)),
                keccak256(bytes(APE_BOND_DOMAIN_VERSION)),
                block.chainid,
                address(adapter_)
            )
        );
    }

    /**
     * @dev The digest REAL's backend signs for one ApeBond purchase, computed INDEPENDENTLY of
     *      the adapter's own `_structHash`. Every field of {PurchaseAuthorization} is a static
     *      type, so the struct encodes as its members laid end to end and one `abi.encode` of
     *      the whole thing is the reference form — while the contract splits the same encoding
     *      in two to fit the stack. Signing through this helper therefore makes every accepted
     *      signature a proof that the two agree, and `test_Digest_MatchesTheReferenceEncoding`
     *      states it directly.
     */
    function _purchaseDigest(
        ApeBondPositionAdapter adapter_,
        ApeBondPositionAdapter.PurchaseAuthorization memory authorization
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(PURCHASE_AUTHORIZATION_TYPEHASH, authorization));
        return keccak256(abi.encodePacked("\x19\x01", _adapterDomainSeparator(adapter_), structHash));
    }

    /// @notice REAL's backend authorizing one ApeBond purchase, as it would in production.
    function _signPurchaseAuthorization(
        uint256 pk,
        ApeBondPositionAdapter adapter_,
        ApeBondPositionAdapter.PurchaseAuthorization memory authorization
    ) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _purchaseDigest(adapter_, authorization));
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
