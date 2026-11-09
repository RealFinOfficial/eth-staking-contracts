// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {LocalHarness} from "../utils/LocalHarness.sol";
import {LPStakingVault} from "../../../contracts/lp-staking/LPStakingVault.sol";
import {LPStakingVaultPreListenerMock} from "../../../contracts/lp-staking/mocks/LPStakingVaultPreListenerMock.sol";
import {LPProxy} from "../../../contracts/lp-staking/deploy/LPProxy.sol";
import {MockLightBonusEscrow} from "../../../contracts/lp-staking/mocks/MockLightBonusEscrow.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
 * @notice The configurable hook gas allowances (Glamsterdam fix, audit notes item 20).
 *
 *  Glamsterdam (EIP-8037, live on Sepolia since 2026-10-06) reprices state creation: a new storage
 *  slot costs about ten times more. The vault's two fail-open notifications used FIXED stipends
 *  (100,000 for the escrow's `onUnstake`, 250,000 for each listener call), and on Sepolia the
 *  listener's `onRebalance` ran out at 250,000 (`eth_estimateGas` 399,311). The allowances are now
 *  owner-set storage: {LPStakingVault-setBonusHookGas}, bounded 100,000..3,000,000, defaults
 *  400,000 / 1,000,000 written by `initialize` or, for a live vault, by `initializeV2` inside the
 *  upgrade. Foundry prices gas by the pre-Glamsterdam schedule, so nothing here reproduces the
 *  repricing itself: these tests pin the setter, the defaults, the floors and the layout.
 */
contract VaultBonusHookGasTest is LocalHarness {
    /// @dev `real.lp.storage.LPStakingVault`, the vault's ERC-7201 base.
    bytes32 internal constant VAULT_STORAGE = 0x4c835a63e69815f7352ca18e845a5d8023cea9abbc2e923eb7a3a481844a6500;
    bytes32 internal constant UNSTAKE_SEEN = keccak256("UnstakeSeen(uint256,uint256,address,address)");
    uint256 internal constant HOOK_ENTRY_OVERHEAD = 2_000;

    function setUp() public {
        _deployLocalStack();
    }

    // ──────────────────────── Setter ───────────────────────────

    function test_SetBonusHookGas_IsOwnerOnly() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vault.setBonusHookGas(500_000, 1_500_000);
    }

    function test_SetBonusHookGas_StoresAnnouncesAndMovesTheFloors() public {
        vm.expectEmit(false, false, false, true, address(vault));
        emit LPStakingVault.BonusHookGasSet(500_000, 1_500_000);
        vault.setBonusHookGas(500_000, 1_500_000);

        assertEq(vault.bonusHookGas(), 500_000, "escrow allowance");
        assertEq(vault.bonusListenerGas(), 1_500_000, "listener allowance");
        assertEq(vault.bonusHookGasFloor(), uint256(500_000) * 64 / 63 + 5_000, "escrow floor follows");
        assertEq(vault.bonusListenerGasFloor(), uint256(1_500_000) * 64 / 63 + 5_000, "listener floor follows");
    }

    function test_SetBonusHookGas_AcceptsBothBoundsInclusive() public {
        vault.setBonusHookGas(100_000, 3_000_000);
        assertEq(vault.bonusHookGas(), 100_000);
        assertEq(vault.bonusListenerGas(), 3_000_000);
        vault.setBonusHookGas(3_000_000, 100_000);
        assertEq(vault.bonusHookGas(), 3_000_000);
        assertEq(vault.bonusListenerGas(), 100_000);
    }

    function test_SetBonusHookGas_RefusesEachSideOutsideTheBounds() public {
        uint256[4] memory bad = [uint256(0), 99_999, 3_000_001, type(uint256).max];
        for (uint256 i = 0; i < bad.length; ++i) {
            vm.expectRevert(
                abi.encodeWithSelector(LPStakingVault.BonusHookGasOutOfBounds.selector, bad[i], uint256(400_000))
            );
            vault.setBonusHookGas(bad[i], 400_000);
            vm.expectRevert(
                abi.encodeWithSelector(LPStakingVault.BonusHookGasOutOfBounds.selector, uint256(400_000), bad[i])
            );
            vault.setBonusHookGas(400_000, bad[i]);
        }
        assertEq(vault.bonusHookGas(), 400_000, "a refused call changes nothing");
        assertEq(vault.bonusListenerGas(), 1_000_000, "on either side");
    }

    function testFuzz_SetBonusHookGas_FloorsAreTheSixtyFourthRule(uint256 escrowSeed, uint256 listenerSeed) public {
        uint256 e = bound(escrowSeed, 100_000, 3_000_000);
        uint256 l = bound(listenerSeed, 100_000, 3_000_000);
        vault.setBonusHookGas(e, l);
        assertEq(vault.bonusHookGasFloor(), e * 64 / 63 + 5_000);
        assertEq(vault.bonusListenerGasFloor(), l * 64 / 63 + 5_000);
        assertGe((vault.bonusHookGasFloor() - 5_000) * 63 / 64, e - 1, "63/64 of the floor covers the allowance");
    }

    // ──────────────────────── initialize ───────────────────────

    function test_Initialize_RefusesAnAllowanceOutsideTheBounds() public {
        address impl =
            address(new LPStakingVault(address(npmMock), address(poolMock), token0, token1, FEE, address(routerMock)));
        vm.expectRevert(
            abi.encodeWithSelector(LPStakingVault.BonusHookGasOutOfBounds.selector, uint256(99_999), uint256(1_000_000))
        );
        new LPProxy(
            impl,
            abi.encodeCall(
                LPStakingVault.initialize,
                (address(this), multisig, operatorSafe, address(0), MIN_TWAP_WINDOW, 500, 99_999, 1_000_000)
            )
        );
    }

    // ──────────────────────── initializeV2 (the live upgrade) ──

    /// @dev The live stack #6 / mainnet path: a vault on the pre-fix code (version 1, no gas
    ///      fields) upgraded with `upgradeToAndCall(newImpl, initializeV2())` gets the defaults in
    ///      the same call, announced, and the step cannot run twice.
    function test_InitializeV2_WritesTheDefaultsIntoALiveVault() public {
        LPStakingVault live = _preFixVault();
        address impl =
            address(new LPStakingVault(address(npmMock), address(poolMock), token0, token1, FEE, address(routerMock)));
        assertEq(uint256(vm.load(address(live), bytes32(uint256(VAULT_STORAGE) + 8))), 0, "no gas fields before");

        vm.expectEmit(false, false, false, true, address(live));
        emit LPStakingVault.BonusHookGasSet(400_000, 1_000_000);
        live.upgradeToAndCall(impl, abi.encodeCall(LPStakingVault.initializeV2, ()));

        assertEq(live.bonusHookGas(), 400_000, "escrow default written");
        assertEq(live.bonusListenerGas(), 1_000_000, "listener default written");
        assertEq(
            uint256(vm.load(address(live), bytes32(uint256(VAULT_STORAGE) + 8))),
            400_000 | (uint256(1_000_000) << 128),
            "and stored, not just the view's fallback"
        );

        vm.expectRevert(Initializable.InvalidInitialization.selector);
        live.initializeV2();
    }

    /// @dev Upgraded WITHOUT the reinitializer (`0x`), the vault still forwards the defaults: the
    ///      views fall back to them while the storage is zero. `initializeV2` stays owner-only.
    function test_InitializeV2_AnUpgradeWithoutItStillUsesTheDefaults() public {
        LPStakingVault live = _preFixVault();
        address impl =
            address(new LPStakingVault(address(npmMock), address(poolMock), token0, token1, FEE, address(routerMock)));
        live.upgradeToAndCall(impl, "");

        assertEq(uint256(vm.load(address(live), bytes32(uint256(VAULT_STORAGE) + 8))), 0, "nothing stored");
        assertEq(live.bonusHookGas(), 400_000, "the escrow default is used");
        assertEq(live.bonusListenerGas(), 1_000_000, "the listener default is used");
        assertEq(live.bonusHookGasFloor(), uint256(400_000) * 64 / 63 + 5_000, "with its floor");

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        live.initializeV2();

        live.initializeV2();
        assertEq(
            uint256(vm.load(address(live), bytes32(uint256(VAULT_STORAGE) + 8))), 400_000 | (uint256(1_000_000) << 128)
        );
    }

    /// @dev A vault born with `initialize` keeps the values it holds: `initializeV2` only fills
    ///      a zero, and announces what it leaves in place.
    function test_InitializeV2_KeepsTheValuesAVaultAlreadyHolds() public {
        vault.setBonusHookGas(700_000, 2_000_000);
        vm.expectEmit(false, false, false, true, address(vault));
        emit LPStakingVault.BonusHookGasSet(700_000, 2_000_000);
        vault.initializeV2();
        assertEq(vault.bonusHookGas(), 700_000);
        assertEq(vault.bonusListenerGas(), 2_000_000);
    }

    // ──────────────────────── Layout ───────────────────────────

    /// @dev The two allowances are APPENDED after `bonusListener` (slot 7) and share slot 8
    ///      (uint128 each, escrow in the low half). Slot 7 keeps the listener link.
    function test_Storage_TheAllowancesShareNamespaceSlotEight() public {
        vault.setBonusHookGas(123_456, 2_345_678);
        assertEq(
            uint256(vm.load(address(vault), bytes32(uint256(VAULT_STORAGE) + 7))), 0, "slot 7 is `bonusListener`, unset"
        );
        assertEq(
            uint256(vm.load(address(vault), bytes32(uint256(VAULT_STORAGE) + 8))),
            123_456 | (uint256(2_345_678) << 128),
            "slot 8 packs both allowances"
        );
    }

    // ──────────────────────── The hook gets the configured value ─

    /// @dev Raised to 1,000,000, the escrow's `onUnstake` receives the raised allowance and the
    ///      exit below the raised floor reverts, exactly as at the defaults.
    function test_Unstake_ForwardsTheConfiguredAllowanceBehindItsFloor() public {
        MockLightBonusEscrow light = new MockLightBonusEscrow(address(vault), address(npmMock), false);
        vault.setBonusEscrow(address(light));
        vault.setBonusHookGas(1_000_000, 1_000_000);
        uint256 tokenId = _stakePosition(alice);
        uint256 floor = vault.bonusHookGasFloor();

        vm.prank(alice);
        vm.expectRevert(LPStakingVault.InsufficientGasForBonusHook.selector);
        vault.unstake{gas: floor}(tokenId);

        vm.recordLogs();
        vm.prank(alice);
        vault.unstake{gas: floor + 150_000}(tokenId);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 atEntry;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter == address(light) && logs[i].topics[0] == UNSTAKE_SEEN) {
                (atEntry,,) = abi.decode(logs[i].data, (uint256, address, address));
            }
        }
        assertLe(atEntry, 1_000_000, "never more than the configured allowance");
        assertGe(atEntry, 1_000_000 - HOOK_ENTRY_OVERHEAD, "and all of it, less dispatch");
        assertEq(npmMock.ownerOf(tokenId), alice, "the exit completed");
    }

    // ──────────────────────── Helpers ──────────────────────────

    /// @dev A proxy on the pre-fix vault code (the 746b22c build, `LPStakingVaultPreListenerMock`),
    ///      owned by this test: version 1, nothing in namespace slot 8.
    function _preFixVault() private returns (LPStakingVault) {
        address oldImpl = address(
            new LPStakingVaultPreListenerMock(
                address(npmMock), address(poolMock), token0, token1, FEE, address(routerMock)
            )
        );
        return LPStakingVault(
            address(
                new LPProxy(
                    oldImpl,
                    abi.encodeCall(
                        LPStakingVaultPreListenerMock.initialize,
                        (address(this), multisig, operatorSafe, address(0), MIN_TWAP_WINDOW, 500)
                    )
                )
            )
        );
    }
}
