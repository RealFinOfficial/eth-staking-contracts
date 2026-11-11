// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {StakingV3Harness} from "../utils/StakingV3Harness.sol";
import {LPStakingVault} from "../../../contracts/lp-staking/LPStakingVault.sol";
import {StakingMigrator} from "../../../contracts/staking-v3/StakingMigrator.sol";
import {V3BonusVault} from "../../../contracts/staking-v3/V3BonusVault.sol";
import {V3BonusVaultRetired} from "../../../contracts/lp-staking/mocks/V3BonusVaultRetired.sol";
import {IBonusEscrowHooks} from "../../../contracts/lp-staking/interfaces/IBonusEscrowHooks.sol";
import {SwapParams} from "../../../contracts/lp-staking/libraries/TwapGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";

/**
 * @notice {V3BonusVaultRetired} (TEST STACK ONLY): a retired staking v3 bonus vault that still owes
 *         an LP reservation holds the LP vault's listener link forever ({ListenerHasReservations});
 *         upgrading its proxy to the retirement implementation releases the link. Real
 *         `LPStakingVault` and real `V3BonusVault` behind proxies; the reservation is opened through
 *         the real migrator (`moveToLp`, route 2), the same path as {VaultBonusListenerTest-_join}.
 */
contract V3BonusVaultRetiredTest is StakingV3Harness {
    uint256 internal constant PRINCIPAL = 20_000e18;
    uint256 internal constant REWARD = 1_000e6;

    /// @dev The second v3 bonus vault, bound to the same LP vault: the listener the switch targets.
    V3BonusVault internal nextBonusVault;
    V3BonusVaultRetired internal retiredImpl;

    function setUp() public {
        _deployStakingV3();
        _approveMigrator(alice);
        nextBonusVault = _deployBonusVault(address(asset), address(0), address(poolV3), address(mathVault));
        retiredImpl = new V3BonusVaultRetired();
    }

    function _join() internal returns (uint256 tokenId) {
        StakingMigrator.Voucher memory v = _voucher(migrator, alice, 2, PRINCIPAL, REWARD, 1);
        vm.prank(alice);
        tokenId = migrator.moveToLp(REWARD, PRINCIPAL, 0, 0, FAR_DEADLINE, _noPermit(), _noPermit(), v);
    }

    function _implementationOf(address proxy) internal view returns (address) {
        return address(uint160(uint256(vm.load(proxy, ERC1967Utils.IMPLEMENTATION_SLOT))));
    }

    function _retire() internal {
        bonusVault.upgradeToAndCall(address(retiredImpl), "");
    }

    function _snapshot(uint256 tokenId) internal view returns (IBonusEscrowHooks.Snapshot memory s) {
        (,,,,, int24 lower, int24 upper, uint128 liquidity,,,,) = mathNpm.positions(tokenId);
        s = IBonusEscrowHooks.Snapshot({tickLower: lower, tickUpper: upper, liquidity: liquidity});
    }

    // ──────────────────────── 1. the link is held ──────────────

    function test_AnOpenLpReservationHoldsTheListenerLink() public {
        _join();
        uint256 owed = bonusVault.totalLpReserved();
        assertGt(owed, 0, "the fixture opened an LP reservation");
        vm.expectRevert(
            abi.encodeWithSelector(LPStakingVault.ListenerHasReservations.selector, address(bonusVault), owed)
        );
        mathVault.setBonusListener(address(nextBonusVault));
    }

    // ──────────────────────── 2. the retirement releases it ────

    function test_RetiredProxyReleasesTheLinkAndAcceptsEveryNotification() public {
        uint256 tokenId = _join();
        assertGt(bonusVault.totalLpReserved(), 0);
        address ownerBefore = bonusVault.owner();
        assertEq(ownerBefore, address(this));

        _retire();
        assertEq(_implementationOf(address(bonusVault)), address(retiredImpl));
        V3BonusVaultRetired retired = V3BonusVaultRetired(address(bonusVault));
        assertEq(retired.totalLpReserved(), 0, "nothing is owed any more");
        assertEq(retired.owner(), ownerBefore, "the owner is read from the same namespaced storage");
        assertEq(mathVault.bonusListener(), address(bonusVault), "still linked until the switch");

        // The notifications exactly as the vault sends them (from the vault).
        IBonusEscrowHooks.Snapshot memory s = _snapshot(tokenId);
        vm.startPrank(address(mathVault));
        retired.onUnstake(tokenId);
        retired.onRebalance(tokenId, tokenId + 1, s, s);
        vm.stopPrank();
        // And from anyone: no caller check, nothing to protect.
        vm.prank(stranger);
        retired.onUnstake(tokenId);

        // Through the real vault: a fail-closed rebalance passes, a fail-open unstake records no miss.
        vm.prank(alice);
        uint256 newId = mathVault.rebalance(
            tokenId,
            PRICE_TICK - 6932,
            PRICE_TICK + 6932,
            SwapParams({zeroForOne: true, amountIn: 0, amountOutMin: 0, amount0Min: 0, amount1Min: 0}),
            FAR_DEADLINE
        );
        assertEq(mathVault.stakerOf(newId), alice);
        vm.prank(alice);
        mathVault.unstake(newId);
        assertEq(mathNpm.ownerOf(newId), alice);
        assertEq(mathVault.listenerMissedAt(newId), 0, "onUnstake did not revert");

        vm.expectEmit(address(mathVault));
        emit LPStakingVault.BonusListenerSet(address(bonusVault), address(nextBonusVault));
        mathVault.setBonusListener(address(nextBonusVault));
        assertEq(mathVault.bonusListener(), address(nextBonusVault));
    }

    function test_RetiredProxyReleasesTheLinkWhileThePositionStaysStaked() public {
        uint256 tokenId = _join();
        _retire();
        assertEq(mathVault.stakerOf(tokenId), alice, "the position is still staked by its user");
        vm.expectEmit(address(mathVault));
        emit LPStakingVault.BonusListenerSet(address(bonusVault), address(nextBonusVault));
        mathVault.setBonusListener(address(nextBonusVault));
        assertEq(mathVault.bonusListener(), address(nextBonusVault));
    }

    // ──────────────────────── 3. upgrades stay with the owner ──

    function test_OnlyTheOwnerCanUpgradeTheRetiredProxy() public {
        _join();
        _retire();
        V3BonusVaultRetired retired = V3BonusVaultRetired(address(bonusVault));
        V3BonusVaultRetired another = new V3BonusVaultRetired();

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        retired.upgradeToAndCall(address(another), "");
        assertEq(_implementationOf(address(bonusVault)), address(retiredImpl));

        retired.upgradeToAndCall(address(another), "");
        assertEq(_implementationOf(address(bonusVault)), address(another));
        assertEq(retired.owner(), address(this));
    }

    function test_TheBareImplementationHasNoOwnerAndOwesNothing() public view {
        assertEq(retiredImpl.owner(), address(0));
        assertEq(retiredImpl.totalLpReserved(), 0);
    }
}
