// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {ApeBondHarness} from "./ApeBondHarness.sol";

import {LPProxy} from "../../../contracts/lp-staking/deploy/LPProxy.sol";
import {LPStakingVault} from "../../../contracts/lp-staking/LPStakingVault.sol";
import {TickMath} from "../../../contracts/lp-staking/libraries/TickMath.sol";
import {MockERC20Permit} from "../../../contracts/lp-staking/mocks/MockERC20Permit.sol";
import {MockUniswapV3Pool} from "../../../contracts/lp-staking/mocks/MockUniswapV3Pool.sol";
import {MockMathPositionManager} from "../../../contracts/lp-staking/mocks/MockMathPositionManager.sol";
import {MockSwapRouter} from "../../../contracts/lp-staking/mocks/MockSwapRouter.sol";
import {WeightedStakingPoolV3} from "../../../contracts/staking-v3/WeightedStakingPoolV3.sol";
import {V3BonusVault} from "../../../contracts/staking-v3/V3BonusVault.sol";
import {StakingMigrator} from "../../../contracts/staking-v3/StakingMigrator.sol";

/**
 * @title StakingV3Harness
 * @notice The staking v3 stack on top of {ApeBondHarness}'s MATH RUNG: the real `LPStakingVault`
 *         over {MockMathPositionManager} (real Uniswap V3 liquidity math) and a pool mock at $0.25
 *         per $ASSET ($ASSET = token0, tick -290188, spacing 1). The three v3 proxies are deployed
 *         and wired the way `scripts/deploy-staking-v3.js` does it: the pool with its rewards
 *         waived, the bonus vault with a budget ({DEFAULT_BUDGET}), the pool's bonus vault, then (the
 *         timelock batch) the two migrator links, the vault's bonus listener and stake operator.
 *
 *  The harness is the owner of every contract and the math vault's guardian and operator, so
 *  every admin call is callable without a prank; `migratorSigner` signs the transition vouchers
 *  and `voucherSigner` (the LocalHarness key) the pool's own weight vouchers.
 *
 *  The router mock swaps USDC into $ASSET at the pool's price, 4 $ASSET per USDC.
 *
 *  {_deployFlippedRung} builds a second, independent market where USDC is token0 (a fresh $ASSET
 *  token is salted above the USDC address), for the orientation branches of the migrator.
 */
abstract contract StakingV3Harness is ApeBondHarness {
    uint256 internal constant V3_DURATION = 90 days;
    uint256 internal constant WEIGHT = 1500;
    uint32 internal constant VALUATION_WINDOW = 1800;
    uint24 internal constant SWAP_DEVIATION_TICKS = 953;
    /// @dev The harness bonus vaults' `maxTotalReserved`: far above anything a test reserves.
    uint256 internal constant DEFAULT_BUDGET = type(uint128).max;

    WeightedStakingPoolV3 internal poolV3;
    V3BonusVault internal bonusVault;
    StakingMigrator internal migrator;

    address internal migratorSigner;
    uint256 internal migratorSignerPk;
    uint256 internal v3Start;
    uint256 internal v3End;

    // ── Flipped rung (USDC = token0) ──
    MockERC20Permit internal flippedAsset;
    MockUniswapV3Pool internal flippedPool;
    MockMathPositionManager internal flippedNpm;
    LPStakingVault internal flippedVault;
    WeightedStakingPoolV3 internal flippedPoolV3;
    V3BonusVault internal flippedBonusVault;
    StakingMigrator internal flippedMigrator;

    function _deployStakingV3() internal {
        _deployApeBond();
        _deployMathRung();
        (migratorSigner, migratorSignerPk) = makeAddrAndKey("migratorSigner");

        routerMock.setRate(address(usdcToken), address(asset), 4e18, 1e6);

        v3Start = block.timestamp;
        v3End = block.timestamp + V3_DURATION;
        poolV3 = _deployPoolV3(address(asset), address(usdcToken), v3Start, v3End);
        bonusVault = _deployBonusVault(address(asset), address(0), address(poolV3), address(mathVault));
        migrator = _deployMigrator(address(mathVault), address(usdcToken), address(asset), poolV3, bonusVault);
        _wireV3(mathVault, poolV3, bonusVault, migrator);
    }

    /// @dev The deploy script's pool: rewards waived.
    function _deployPoolV3(address staking, address reward, uint256 start, uint256 end)
        internal
        returns (WeightedStakingPoolV3)
    {
        return _deployPoolV3(staking, reward, start, end, true);
    }

    function _deployPoolV3(address staking, address reward, uint256 start, uint256 end, bool waived)
        internal
        returns (WeightedStakingPoolV3)
    {
        WeightedStakingPoolV3 impl = new WeightedStakingPoolV3();
        LPProxy proxy = new LPProxy(
            address(impl),
            abi.encodeCall(
                WeightedStakingPoolV3.initialize, (address(this), staking, reward, start, end, voucherSigner, waived)
            )
        );
        return WeightedStakingPoolV3(address(proxy));
    }

    function _deployBonusVault(address token, address migrator_, address pool_, address vault_)
        internal
        returns (V3BonusVault)
    {
        return _deployBonusVault(token, migrator_, pool_, vault_, DEFAULT_BUDGET);
    }

    function _deployBonusVault(address token, address migrator_, address pool_, address vault_, uint256 budget)
        internal
        returns (V3BonusVault)
    {
        V3BonusVault impl = new V3BonusVault();
        LPProxy proxy = new LPProxy(
            address(impl),
            abi.encodeCall(V3BonusVault.initialize, (address(this), token, migrator_, pool_, vault_, budget))
        );
        return V3BonusVault(address(proxy));
    }

    function _deployMigrator(
        address lpVault_,
        address usdc_,
        address asset_,
        WeightedStakingPoolV3 pool_,
        V3BonusVault bonus_
    ) internal returns (StakingMigrator) {
        address impl = _deployMigratorImpl(lpVault_, usdc_, asset_);
        LPProxy proxy = new LPProxy(
            impl,
            abi.encodeCall(
                StakingMigrator.initialize,
                (
                    address(this),
                    address(pool_),
                    address(bonus_),
                    migratorSigner,
                    MIN_TWAP_WINDOW,
                    SWAP_DEVIATION_TICKS,
                    VALUATION_WINDOW
                )
            )
        );
        return StakingMigrator(address(proxy));
    }

    function _deployMigratorImpl(address lpVault_, address usdc_, address asset_) internal returns (address) {
        return address(new StakingMigrator(lpVault_, usdc_, asset_));
    }

    /// @dev The deploy script's direct wiring (the pool's bonus vault) plus the timelock batch (the
    ///      two migrator links, then the vault's listener and stake operator), in their order.
    function _wireV3(LPStakingVault v, WeightedStakingPoolV3 p, V3BonusVault b, StakingMigrator m) internal {
        p.setBonusVault(address(b));
        p.setMigrator(address(m));
        b.setMigrator(address(m));
        v.setBonusListener(address(b));
        v.setStakeOperator(address(m), true);
        m.unpauseCompound();
    }

    // ──────────────────────── Flipped rung ─────────────────────

    /// @notice A market where USDC sorts BELOW $ASSET: a fresh $ASSET is salted above `usdcToken`.
    function _deployFlippedRung() internal {
        for (uint256 salt = 1000; salt < 1256; ++salt) {
            MockERC20Permit candidate = new MockERC20Permit{salt: bytes32(salt)}("Asset B", "ASSETB", 1e30, 18);
            if (address(candidate) > address(usdcToken)) {
                flippedAsset = candidate;
                break;
            }
        }
        require(address(flippedAsset) != address(0), "StakingV3Harness: no salt sorted ASSET above USDC");

        // $0.25 per $ASSET with USDC = token0: price = ASSET per USDC = 4e12 raw; tick = +290188.
        int24 tick = -PRICE_TICK;
        flippedPool = new MockUniswapV3Pool(address(usdcToken), address(flippedAsset), MATH_FEE);
        flippedPool.setTicks(tick, tick);
        flippedPool.setSqrtPriceX96(TickMath.getSqrtRatioAtTick(tick));
        flippedNpm = new MockMathPositionManager(address(flippedPool));

        VaultProxyParams memory params = _vaultParams(
            address(flippedNpm),
            address(flippedPool),
            address(usdcToken),
            address(flippedAsset),
            address(routerMock),
            address(this),
            MIN_TWAP_WINDOW,
            500
        );
        params.fee = MATH_FEE;
        flippedVault = _deployVaultProxy(params);

        flippedPoolV3 = _deployPoolV3(address(flippedAsset), address(usdcToken), v3Start, v3End);
        flippedBonusVault =
            _deployBonusVault(address(flippedAsset), address(0), address(flippedPoolV3), address(flippedVault));
        flippedMigrator = _deployMigrator(
            address(flippedVault), address(usdcToken), address(flippedAsset), flippedPoolV3, flippedBonusVault
        );
        _wireV3(flippedVault, flippedPoolV3, flippedBonusVault, flippedMigrator);

        routerMock.setRate(address(usdcToken), address(flippedAsset), 4e18, 1e6);
        flippedAsset.transfer(address(routerMock), 1e28);
        flippedAsset.transfer(alice, 1_000_000e18);
        flippedAsset.transfer(address(flippedNpm), 1_000_000e18);
        usdcToken.transfer(address(flippedNpm), 1_000_000e6);
    }

    // ──────────────────────── Vouchers ─────────────────────────

    function _voucher(StakingMigrator m, address user, uint8 route, uint256 principal, uint256 reward, uint256 nonce)
        internal
        view
        returns (StakingMigrator.Voucher memory v)
    {
        return _voucherSignedBy(m, migratorSignerPk, user, route, principal, reward, WEIGHT, nonce, FAR_DEADLINE);
    }

    function _voucherSignedBy(
        StakingMigrator m,
        uint256 pk,
        address user,
        uint8 route,
        uint256 principal,
        uint256 reward,
        uint256 weight,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (StakingMigrator.Voucher memory v) {
        bytes32 digest = m.voucherDigest(user, route, principal, reward, weight, nonce, deadline);
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        v = StakingMigrator.Voucher({
            route: route,
            eligiblePrincipal: principal,
            eligibleReward: reward,
            weight: weight,
            nonce: nonce,
            deadline: deadline,
            signature: abi.encodePacked(r, s, sv)
        });
    }

    function _noPermit() internal pure returns (StakingMigrator.Permit memory) {
        return StakingMigrator.Permit({value: 0, deadline: 0, v: 0, r: bytes32(0), s: bytes32(0)});
    }

    /// @dev `user` approves the migrator for both tokens of the main rung.
    function _approveMigrator(address user) internal {
        vm.startPrank(user);
        asset.approve(address(migrator), type(uint256).max);
        usdcToken.approve(address(migrator), type(uint256).max);
        vm.stopPrank();
    }

    /// @dev A pool-signed `Stake` weight voucher for a direct `poolV3.stake`.
    function _signStake(WeightedStakingPoolV3 p, address user, uint256 amount, uint256 weight, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(p.STAKE_TYPEHASH(), user, amount, weight, p.nonces(user), deadline));
        return _signPoolDigest(p, structHash);
    }

    function _signWithdraw(WeightedStakingPoolV3 p, address user, uint256 amount, uint256 weight, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash =
            keccak256(abi.encode(p.WITHDRAW_TYPEHASH(), user, amount, weight, p.nonces(user), deadline));
        return _signPoolDigest(p, structHash);
    }

    function _signUpdateWeight(WeightedStakingPoolV3 p, address user, uint256 amount, uint256 weight, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash =
            keccak256(abi.encode(p.UPDATE_WEIGHT_TYPEHASH(), user, amount, weight, p.nonces(user), deadline));
        return _signPoolDigest(p, structHash);
    }

    function _signPoolDigest(WeightedStakingPoolV3 p, bytes32 structHash) internal view returns (bytes memory) {
        bytes32 domain = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH, keccak256("WeightedStakingPool"), keccak256("1"), block.chainid, address(p)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(voucherSignerPk, digest);
        return abi.encodePacked(r, s, v);
    }
}
