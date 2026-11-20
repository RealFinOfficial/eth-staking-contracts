// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";

import {LPProxy} from "../../../contracts/lp-staking/deploy/LPProxy.sol";
import {StakingMigrator} from "../../../contracts/staking-v3/StakingMigrator.sol";
import {TransitionReceiver} from "../../../contracts/staking-v3/TransitionReceiver.sol";
import {V3BonusVault} from "../../../contracts/staking-v3/V3BonusVault.sol";
import {WeightedStakingPoolV3} from "../../../contracts/staking-v3/WeightedStakingPoolV3.sol";
import {ITransitionMigrator} from "../../../contracts/staking-v3/interfaces/ITransition.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IOperatorOf {
    function operator() external view returns (address);
}

/**
 * @notice The transition upgrade on the LIVE Sepolia stack #6 migrator (spec 01 §9.10): the proxy
 *         `0x58a0…F893` running the pre-transition implementation `0xe697…2a57`, owned by the stack's
 *         timelock, is upgraded with ONE `upgradeToAndCall(newImplementation,
 *         initializeTransition(receiver))` sent as the timelock; every stored value survives, the
 *         receiver is linked with the 3 % swap limit, and a route-3 delivery stakes on the real v3
 *         pool and reserves its bonus in the real bonus vault. Read-only against Sepolia: a local
 *         fork at a pinned block, nothing is sent.
 *
 *  The endpoint rule is the fork tier's (BaseForge): no endpoint and none configured -> skip; an
 *  endpoint configured but missing -> fail.
 */
contract TransitionUpgradeForkTest is Test {
    /// @dev After the migrator's last upgrade (block 12,155,283) and before its v3 pool's end.
    uint256 internal constant PINNED_BLOCK = 12_175_000;
    address internal constant MIGRATOR = 0x58a0464284020bF3368d3B629c5F693e94F8D893;
    address internal constant TIMELOCK = 0xf2F678AC5260BB297682D54DcD945BCB78901E20;
    address internal constant LIVE_IMPLEMENTATION = 0xe6976FcEc3218DBcea20D1220b70D87461082a57;
    bytes32 internal constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    StakingMigrator internal m;

    function setUp() public {
        string memory url = vm.envOr("SEPOLIA_RPC_URL", string(""));
        if (bytes(url).length == 0) {
            if (vm.envOr("LP_FORK_RPC_REQUIRED", false)) revert("SEPOLIA_RPC_URL configured but unresolved");
            vm.skip(true, "no Sepolia archive endpoint; run `npm run test:forge`");
        }
        vm.createSelectFork(url, PINNED_BLOCK);
        m = StakingMigrator(MIGRATOR);
    }

    struct Before {
        address signer;
        address stakingPool;
        address bonusVault;
        uint16 compoundBps;
        uint16 lpBps;
        uint16 restakeBps;
        bool compoundPaused;
        uint32 valuationWindow;
        uint32 twapWindow;
        uint24 maxDev;
        address owner;
    }

    function _snap() internal view returns (Before memory b) {
        b.signer = m.signer();
        b.stakingPool = m.stakingPool();
        b.bonusVault = m.bonusVault();
        b.compoundBps = m.compoundBps();
        b.lpBps = m.lpBps();
        b.restakeBps = m.restakeBps();
        b.compoundPaused = m.compoundPaused();
        b.valuationWindow = m.valuationWindow();
        b.twapWindow = m.twapWindow();
        b.maxDev = m.maxTwapDeviationTicks();
        b.owner = m.owner();
    }

    function test_UpgradeOfTheLiveMigratorKeepsItsStateLinksTheReceiverAndDelivers() public {
        assertEq(address(uint160(uint256(vm.load(MIGRATOR, IMPLEMENTATION_SLOT)))), LIVE_IMPLEMENTATION);
        (bool hasReceiver,) = MIGRATOR.staticcall(abi.encodeWithSignature("transitionReceiver()"));
        assertFalse(hasReceiver, "the live implementation predates the transition");
        Before memory b = _snap();
        assertEq(b.owner, TIMELOCK);

        TransitionReceiver receiver = _upgrade();

        assertEq(abi.encode(_snap()), abi.encode(b), "every stored value survives the upgrade");
        assertEq(m.transitionReceiver(), address(receiver));
        assertEq(m.swapLimitBps(), 300);
        vm.prank(TIMELOCK);
        vm.expectRevert();
        m.initializeTransition(address(receiver));

        _deliverRouteThree(receiver, b);
    }

    /// @dev The one timelock operation of spec 01 §9.10, sent as the timelock on the fork.
    function _upgrade() internal returns (TransitionReceiver receiver) {
        address newImpl = address(new StakingMigrator(address(m.lpVault()), m.usdc(), m.asset()));
        TransitionReceiver impl = new TransitionReceiver(MIGRATOR);
        receiver = TransitionReceiver(
            address(
                new LPProxy(
                    address(impl), abi.encodeCall(TransitionReceiver.initialize, (TIMELOCK, makeAddr("deliverer")))
                )
            )
        );
        vm.prank(TIMELOCK);
        m.upgradeToAndCall(newImpl, abi.encodeCall(StakingMigrator.initializeTransition, (address(receiver))));
    }

    /// @dev A route-3 delivery on the real stack. The operator rotates the voucher signer to a test
    ///      key (operator tier, undelayed), as it would after a leak.
    function _deliverRouteThree(TransitionReceiver receiver, Before memory b) internal {
        (address testSigner, uint256 testPk) = makeAddrAndKey("testVoucherSigner");
        vm.prank(IOperatorOf(address(m.lpVault())).operator());
        m.setSigner(testSigner);

        address holder = makeAddr("forkHolder");
        uint256 amount = 1_000e18;
        address at_ = receiver.receivingAddressOf(holder, 3);
        deal(m.asset(), at_, amount);
        ITransitionMigrator.DeliveryVoucher memory v;
        v.route = 3;
        v.eligiblePrincipal = amount;
        v.assetLimit = amount;
        v.burnTime = block.timestamp - 60;
        v.deadline = block.timestamp + 1 hours;
        bytes32 digest = m.deliveryVoucherDigest(holder, 3, amount, 0, amount, 0, v.burnTime, 0, v.deadline);
        (uint8 sv, bytes32 sr, bytes32 ss) = vm.sign(testPk, digest);
        v.signature = abi.encodePacked(sr, ss, sv);

        (uint256 reserved0,) = V3BonusVault(b.bonusVault).reservedOf(holder);
        vm.prank(holder);
        receiver.deliver(holder, 3, ITransitionMigrator.DeliveryLimits(0, 0, 0, block.timestamp + 1 hours), v);
        WeightedStakingPoolV3 pool = WeightedStakingPoolV3(b.stakingPool);
        assertEq(pool.stakes(holder), amount, "staked on the live v3 pool");
        (uint256 reserved1,) = V3BonusVault(b.bonusVault).reservedOf(holder);
        uint256 expected = v.burnTime < pool.bonusCutoff() ? amount * b.restakeBps / 10_000 : 0;
        assertEq(reserved1 - reserved0, expected, "the bonus by the burn time");
        assertEq(IERC20(m.asset()).balanceOf(at_), 0);
        assertTrue(m.migrated(holder));
    }
}
