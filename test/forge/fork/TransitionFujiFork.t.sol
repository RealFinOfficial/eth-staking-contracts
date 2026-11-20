// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {console} from "forge-std/console.sol";

import {TransitionHarness} from "../utils/TransitionHarness.sol";

import {LPStakingVault} from "../../../contracts/lp-staking/LPStakingVault.sol";
import {INonfungiblePositionManager} from "../../../contracts/lp-staking/interfaces/INonfungiblePositionManager.sol";
import {MockERC20Permit} from "../../../contracts/lp-staking/mocks/MockERC20Permit.sol";
import {StakingMigratorBase} from "../../../contracts/staking-v3/StakingMigratorBase.sol";
import {ITransitionMigrator} from "../../../contracts/staking-v3/interfaces/ITransition.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IFujiFactory {
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address);
}

interface IFujiPool {
    function initialize(uint160 sqrtPriceX96) external;

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);

    function increaseObservationCardinalityNext(uint16 next) external;
}

interface IFiatToken {
    function masterMinter() external view returns (address);

    function configureMinter(address minter, uint256 allowance) external returns (bool);

    function mint(address to, uint256 amount) external returns (bool);
}

/**
 * @notice The transition on a fork of Avalanche Fuji (chain 43113) with the REAL Uniswap v3 contracts
 *         there and Circle's Fuji USDC, the token order of the real deployment: USDC is token0 of the
 *         pool (spec 01 §9.8, §9.9). On the fork: a new 0.30 % pool of a fresh test $ASSET and USDC at
 *         0.20 USDC per $ASSET with 50 USDC and 250 $ASSET on the −50 % / +100 % band, the price
 *         history grown in steps of 150 slots to 1,801 and aged past the 1,800-second valuation window,
 *         then the LP vault and the v3 set with the receiver, deployed the way
 *         `scripts/deploy-staking-v3.js` wires them (the scripts are JavaScript and cannot run inside
 *         Forge; their in-process run is test/staking-v3/DeployTransition.test.js), and every route:
 *           route 1   10,000 $ASSET and 2 USDC, then a top-up
 *           route 2   a first part below the matching amount (refused), then the completion
 *           route 3   two parts
 *           release   the holder takes its tokens back
 *           3 % floor a swap the swap limit refuses, the tokens wait
 *         It prints the gas of each `deliver` and `release`, with the touched accounts cooled first.
 *         Read-only: a local fork; nothing is sent to Fuji.
 */
contract TransitionFujiForkTest is TransitionHarness {
    uint256 internal constant PINNED_BLOCK = 61_384_000;
    address internal constant USDC = 0x5425890298aed601595a70AB815c96711a31Bc65;
    address internal constant FACTORY = 0x6739FCFDC0c6939939C0e8D55188E8D0D973E617;
    address internal constant NPM = 0xD7144710B6152526FB33699B166B5917a73f67FE;
    address internal constant ROUTER = 0x701067e5f83d71975988BE412Bbd922D806fd29D;
    uint24 internal constant POOL_FEE = 3000;

    MockERC20Permit internal fujiAsset;
    IFujiPool internal fujiPool;
    LPStakingVault internal fujiVault;
    address internal dave;
    address internal erin;

    function setUp() public {
        string memory url = vm.envOr("AVALANCHE_FUJI_RPC_URL", string(""));
        if (bytes(url).length == 0) {
            if (vm.envOr("LP_FORK_RPC_REQUIRED", false)) revert("AVALANCHE_FUJI_RPC_URL unresolved");
            vm.skip(true, "no Fuji endpoint; run `npm run test:forge` with INFURA_API_KEY set");
        }
        vm.createSelectFork(url, PINNED_BLOCK);
        assertEq(block.chainid, 43113);
        (alice,) = makeAddrAndKey("alice");
        (bob,) = makeAddrAndKey("bob");
        (carol,) = makeAddrAndKey("carol");
        dave = makeAddr("dave");
        erin = makeAddr("erin");
        deliverer = makeAddr("deliverer");
        (migratorSigner, migratorSignerPk) = makeAddrAndKey("migratorSigner");
        (voucherSigner, voucherSignerPk) = makeAddrAndKey("voucherSigner");

        _tokens();
        _pool();
        _history();
        _stack();
    }

    // ──────────────────────── The market ───────────────────────

    /// @dev A fresh test $ASSET above USDC's address (USDC = token0), and USDC minted through
    ///      Circle's own minter role, granted by its master minter on the fork.
    function _tokens() internal {
        for (uint256 salt = 0; salt < 64; ++salt) {
            MockERC20Permit t = new MockERC20Permit{salt: bytes32(salt)}("Test Asset", "ASSET", 1e30, 18);
            if (address(t) > USDC) {
                fujiAsset = t;
                break;
            }
        }
        require(address(fujiAsset) != address(0), "no salt put the asset above USDC");
        vm.prank(IFiatToken(USDC).masterMinter());
        IFiatToken(USDC).configureMinter(address(this), 10_000_000e6);
        IFiatToken(USDC).mint(address(this), 10_000_000e6);
        asset = fujiAsset;
        usdcToken = MockERC20Permit(USDC);
    }

    /// @dev 0.20 USDC per $ASSET: raw price token1/token0 = 5e18 / 1e6 = 5e12.
    function _pool() internal {
        fujiPool = IFujiPool(IFujiFactory(FACTORY).createPool(USDC, address(fujiAsset), POOL_FEE));
        fujiPool.initialize(uint160(Math.sqrt(uint256(5e12) << 192)));
        (, int24 tick,,,,,) = fujiPool.slot0();
        _mintBand(tick, 50e6, 250e18);
    }

    function _mintBand(int24 tick, uint256 usdcAmount, uint256 assetAmount) internal returns (uint256 tokenId) {
        int24 lower = _floor60(tick - 6932);
        int24 upper = _floor60(tick + 6932) + 60;
        IERC20(USDC).approve(NPM, usdcAmount);
        fujiAsset.approve(NPM, assetAmount);
        (tokenId,,,) = INonfungiblePositionManager(NPM)
            .mint(
                INonfungiblePositionManager.MintParams({
                token0: USDC,
                token1: address(fujiAsset),
                fee: POOL_FEE,
                tickLower: lower,
                tickUpper: upper,
                amount0Desired: usdcAmount,
                amount1Desired: assetAmount,
                amount0Min: 0,
                amount1Min: 0,
                recipient: address(this),
                deadline: block.timestamp
            })
            );
    }

    function _floor60(int24 t) internal pure returns (int24) {
        int24 r = t - (t % 60);
        return r > t ? r - 60 : r;
    }

    /// @dev The oracle grown in steps of 150 slots to 1,801 (the 1,800-second window + 1), then
    ///      observations written over more than 1,800 seconds, one per block (a small in-range mint).
    function _history() internal {
        for (uint16 n = 150; n < 1801; n += 150) {
            fujiPool.increaseObservationCardinalityNext(n);
        }
        fujiPool.increaseObservationCardinalityNext(1801);
        for (uint256 i = 0; i < 14; ++i) {
            vm.warp(block.timestamp + 150);
            vm.roll(block.number + 1);
            (, int24 tick,,,,,) = fujiPool.slot0();
            _mintBand(tick, 1e6, 5e18);
        }
        (,,, uint16 cardinality,,,) = fujiPool.slot0();
        assertGe(cardinality, 1801, "the current cardinality serves the 1,800 s window");
    }

    // ──────────────────────── The stack ────────────────────────

    function _stack() internal {
        VaultProxyParams memory p = VaultProxyParams({
            positionManager: NPM,
            pool: address(fujiPool),
            token0: USDC,
            token1: address(fujiAsset),
            fee: POOL_FEE,
            swapRouter: ROUTER,
            owner: address(this),
            guardian: address(this),
            operator: address(this),
            zapper: address(0),
            twapWindow: MIN_TWAP_WINDOW,
            maxDeviationTicks: 500
        });
        fujiVault = _deployVaultProxy(p);
        mathVault = fujiVault;
        v3Start = block.timestamp;
        v3End = block.timestamp + V3_DURATION;
        poolV3 = _deployPoolV3(address(fujiAsset), v3Start, v3End);
        bonusVault = _deployBonusVault(address(fujiAsset), address(0), address(poolV3), address(fujiVault));
        migrator = _deployMigrator(address(fujiVault), USDC, address(fujiAsset), poolV3, bonusVault);
        _wireV3(fujiVault, poolV3, bonusVault, migrator);
        receiver = _deployReceiver(migrator, address(this), deliverer);
        migrator.initializeTransition(address(receiver));
        assertFalse(migrator.assetIsToken0(), "USDC is token0, as on Avalanche");
    }

    // ──────────────────────── Helpers ──────────────────────────

    function _cool(address holder, uint8 route) internal {
        address[12] memory touched = [
            address(receiver),
            address(migrator),
            vm.computeCreateAddress(
                address(
                    uint160(
                        uint256(
                            vm.load(
                                address(migrator), 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc
                            )
                        )
                    )
                ),
                1
            ),
            address(fujiPool),
            ROUTER,
            NPM,
            address(fujiVault),
            address(poolV3),
            address(bonusVault),
            address(fujiAsset),
            USDC,
            _at(holder, route)
        ];
        for (uint256 i = 0; i < touched.length; ++i) {
            vm.cool(touched[i]);
        }
    }

    function _deliverMeasured(address holder, uint8 route, uint256 principal, uint256 reward, string memory label)
        internal
        returns (ITransitionMigrator.DeliveryResult memory r)
    {
        ITransitionMigrator.DeliveryVoucher memory v = _dv(holder, route, principal, reward);
        ITransitionMigrator.DeliveryLimits memory l = _limits();
        _cool(holder, route);
        vm.prank(deliverer);
        uint256 g = gasleft();
        r = receiver.deliver(holder, route, l, v);
        console.log(label, g - gasleft());
    }

    function _advance() internal {
        vm.warp(block.timestamp + 12);
        vm.roll(block.number + 1);
    }

    // ──────────────────────── The routes ───────────────────────

    function test_FujiFork_EveryRouteWithTheRealUniswapContracts() public {
        // Route 1: 10,000 $ASSET and 2 USDC, then a top-up of 1,000 $ASSET.
        _payAsset(alice, R1, 10_000e18);
        _payUsdc(alice, R1, 2e6);
        uint256 valued = migrator.usdcInAsset(2e6);
        ITransitionMigrator.DeliveryResult memory r1 =
            _deliverMeasured(alice, R1, 20_000e18, 2e6, "gas deliver route 1, first (swap 2 USDC on the real pool):");
        assertGe(r1.assetBought, valued * 9700 / 10_000, "filled within the 3 % floor");
        assertApproxEqRel(valued, 10e18, 0.02e18, "2 USDC are worth about 10 $ASSET at the 1,800 s mean");
        assertEq(poolV3.stakes(alice), 10_000e18 + r1.assetBought);
        _advance();
        _payAsset(alice, R1, 1_000e18);
        _deliverMeasured(alice, R1, 20_000e18, 2e6, "gas deliver route 1, top-up ($ASSET only, no swap):");
        assertEq(poolV3.stakes(alice), 11_000e18 + r1.assetBought);

        // Route 2: 5 USDC, a first part of 10 $ASSET (below the matching amount), then the rest.
        _advance();
        _payUsdc(bob, R2, 5e6);
        _payAsset(bob, R2, 10e18);
        ITransitionMigrator.DeliveryVoucher memory v2 = _dv(bob, R2, 1_000e18, 5e6);
        ITransitionMigrator.DeliveryLimits memory l = _limits();
        vm.prank(deliverer);
        vm.expectPartialRevert(StakingMigratorBase.MatchingAssetNotArrived.selector);
        receiver.deliver(bob, R2, l, v2);
        _payAsset(bob, R2, 40e18);
        ITransitionMigrator.DeliveryResult memory r2 =
            _deliverMeasured(bob, R2, 1_000e18, 5e6, "gas deliver route 2, first (mint on the real pool, LP stake):");
        assertGt(r2.lpTokenId, 0);
        assertEq(fujiVault.stakerOf(r2.lpTokenId), bob, "the real position is staked for bob");
        assertEq(INonfungiblePositionManager(NPM).ownerOf(r2.lpTokenId), address(fujiVault));
        assertApproxEqRel(r2.usdcToLp, 5e6, 0.001e18, "the position took the whole USDC");
        assertEq(r2.assetToLp + r2.staked, 50e18);
        _advance();
        _payAsset(bob, R2, 7e18);
        _deliverMeasured(bob, R2, 1_000e18, 5e6, "gas deliver route 2, top-up:");

        // Route 3 in two parts.
        _advance();
        _payAsset(carol, R3, 3_000e18);
        _deliverMeasured(carol, R3, 5_000e18, 0, "gas deliver route 3, first part:");
        _advance();
        _payAsset(carol, R3, 2_000e18);
        _deliverMeasured(carol, R3, 5_000e18, 0, "gas deliver route 3, second part:");
        assertEq(poolV3.stakes(carol), 5_000e18);

        // A release.
        _advance();
        _payAsset(dave, R1, 500e18);
        _payUsdc(dave, R1, 3e6);
        _cool(dave, R1);
        vm.prank(dave);
        uint256 g = gasleft();
        receiver.release(dave, R1);
        console.log("gas release, both tokens (places the holding contract):", g - gasleft());
        assertEq(fujiAsset.balanceOf(dave), 500e18);
        assertEq(IERC20(USDC).balanceOf(dave), 3e6);

        // The 3 % swap limit refuses a swap that moves the real pool too far: 20 USDC on 50 USDC of depth.
        _advance();
        _payAsset(erin, R1, 100e18);
        _payUsdc(erin, R1, 20e6);
        ITransitionMigrator.DeliveryVoucher memory ve = _dv(erin, R1, 100e18, 20e6);
        vm.prank(deliverer);
        vm.expectRevert(bytes("Too little received")); // SwapRouter02's own check of amountOutMinimum
        receiver.deliver(erin, R1, l, ve);
        assertEq(IERC20(USDC).balanceOf(_at(erin, R1)), 20e6, "the USDC waits");
        assertEq(fujiAsset.balanceOf(_at(erin, R1)), 100e18, "the $ASSET waits");
        // The same swap passes once the operator raises the limit to 10 %: the floor, not the TWAP
        // guard, refused it.
        migrator.setSwapLimitBps(1000);
        vm.prank(deliverer);
        receiver.deliver(erin, R1, l, ve);
        migrator.setSwapLimitBps(300);
        assertGt(poolV3.stakes(erin), 100e18, "staked once the limit allows the fill");

        assertEq(fujiAsset.balanceOf(address(receiver)), 0);
        assertEq(IERC20(USDC).balanceOf(address(receiver)), 0);
        assertEq(fujiAsset.balanceOf(address(migrator)), 0);
        assertEq(IERC20(USDC).balanceOf(address(migrator)), 0);
    }
}
