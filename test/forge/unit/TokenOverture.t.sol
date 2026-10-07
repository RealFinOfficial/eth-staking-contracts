// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseForge} from "../utils/BaseForge.sol";
import {TokenOverture} from "../../../contracts/lp-staking/TokenOverture.sol";
import {TokenOvertureV2Mock} from "../../../contracts/lp-staking/mocks/TokenOvertureV2Mock.sol";
import {IMintableRewardToken} from "../../../contracts/lp-staking/interfaces/IMintableRewardToken.sol";
import {LPProxy} from "../../../contracts/lp-staking/deploy/LPProxy.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {
    ERC20PermitUpgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";

/**
 * @notice Why this file exists: the Overture token ($OVTR) is a reward token minted by exactly one
 *         address — at launch the `RewardsDistributor` PROXY, which the operator drives with
 *         `mintRewardToken` — and it runs behind a UUPS proxy owned by the timelock.
 *         Three claims follow from that and each is measured here, always THROUGH THE PROXY —
 *         the bare implementation is a contract nobody uses:
 *
 *    1. Supply is decided by one address, the minter, and by nothing else: there is no cap, no
 *       epoch, no schedule anywhere in the token. A zero mint is refused so the token never
 *       emits a zero-value `Transfer` of its own making.
 *    2. The admin surface is two-tier and cannot be lost: the owner (the timelock) moves the
 *       minter and upgrades; ownership is two-step and cannot be renounced.
 *    3. Everything a holder relies on — balances, allowances, the permit domain and its
 *       nonces — lives in the proxy's storage and survives an upgrade, and the permit domain
 *       names the PROXY as its verifying contract.
 *
 *  Roles are split here the way production splits them: {timelock} owns the token, {minter}
 *  holds the mint right (it stands in for the distributor proxy; the distributor's own side
 *  is measured in `DistributorBranches.t.sol` and `AccessControl.t.sol`), and {stranger} holds
 *  neither.
 */
contract TokenOvertureTest is BaseForge {
    TokenOverture internal overture;

    address internal timelock;
    address internal minter;
    address internal stranger;
    address internal alice;
    uint256 internal alicePk;
    address internal bob;

    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    /// @dev The literal the contract pins; recomputed in {test_Storage_LivesAtThePinnedErc7201Slot}.
    bytes32 internal constant TOKEN_OVERTURE_STORAGE =
        0x7ca9f8db09cacc7881e534e068295c46832e8cbf76a90cb6e2f245c9bf51b600;

    event MinterChanged(address previousMinter, address newMinter);
    event Transfer(address indexed from, address indexed to, uint256 value);

    function setUp() public {
        timelock = makeAddr("timelock");
        minter = makeAddr("minter");
        stranger = makeAddr("stranger");
        (alice, alicePk) = makeAddrAndKey("alice");
        bob = makeAddr("bob");

        overture = _deployOvertureProxy(OVERTURE_NAME, OVERTURE_SYMBOL, timelock, minter);
    }

    // ──────────────────────── Initialization ───────────────────

    function test_Initialize_SetsTheLaunchState() public view {
        assertEq(overture.name(), "Overture", "the ERC-20 name is the launch name");
        assertEq(overture.symbol(), "OVTR", "the ERC-20 symbol is the launch symbol");
        assertEq(overture.decimals(), 18, "the Overture token has 18 decimals");
        assertEq(overture.owner(), timelock, "the owner is the timelock");
        assertEq(overture.pendingOwner(), address(0), "nothing is pending at birth");
        assertEq(overture.minter(), minter, "the minter is the address initialize named");
        assertEq(overture.totalSupply(), 0, "the token is born with no supply");
    }

    /// @dev The minter is followable from logs alone: `initialize` announces it, from zero.
    function test_Initialize_AnnouncesTheMinter() public {
        TokenOverture impl = new TokenOverture();

        vm.expectEmit(false, false, false, true);
        emit MinterChanged(address(0), minter);
        new LPProxy(address(impl), abi.encodeCall(TokenOverture.initialize, ("Overture", "OVTR", timelock, minter)));
    }

    /// @dev A zero minter is a legal birth state — minting simply starts switched off.
    function test_Initialize_AcceptsAZeroMinterAsMintingOff() public {
        TokenOverture off = _deployOvertureProxy(OVERTURE_NAME, OVERTURE_SYMBOL, timelock, address(0));
        assertEq(off.minter(), address(0), "the minter slot holds zero");

        vm.prank(minter);
        vm.expectRevert(abi.encodeWithSelector(TokenOverture.NotMinter.selector, minter));
        off.mint(alice, 1);
    }

    function test_Initialize_RejectsAZeroOwner() public {
        TokenOverture impl = new TokenOverture();

        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableInvalidOwner.selector, address(0)));
        new LPProxy(address(impl), abi.encodeCall(TokenOverture.initialize, ("Overture", "OVTR", address(0), minter)));
    }

    /// @dev A proxy is initialised exactly once; a second call cannot re-seat owner or minter.
    function test_Initialize_CannotRunTwiceOnTheProxy() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        overture.initialize("Other", "OTH", stranger, stranger);
    }

    /// @dev The bare implementation burnt its own initializers in its constructor, so nobody can
    ///      take ownership of the code the proxy delegates to.
    function test_Constructor_DisablesTheImplementationsInitializers() public {
        TokenOverture impl = new TokenOverture();

        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize("Overture", "OVTR", timelock, minter);
    }

    // ──────────────────────── Minting ──────────────────────────

    function test_Mint_ByTheMinterCreditsTheRecipient() public {
        vm.expectEmit(true, true, false, true, address(overture));
        emit Transfer(address(0), alice, 1_000e18);
        vm.prank(minter);
        overture.mint(alice, 1_000e18);

        assertEq(overture.balanceOf(alice), 1_000e18, "the recipient holds what was minted");
        assertEq(overture.totalSupply(), 1_000e18, "the supply grew by exactly the mint");
    }

    function test_Mint_RejectsEveryoneButTheMinter() public {
        address[3] memory callers = [timelock, stranger, alice];
        for (uint256 i = 0; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(TokenOverture.NotMinter.selector, callers[i]));
            overture.mint(callers[i], 1);
        }
    }

    function test_Mint_RejectsAZeroAmount() public {
        vm.prank(minter);
        vm.expectRevert(TokenOverture.ZeroAmount.selector);
        overture.mint(alice, 0);
    }

    function test_Mint_RejectsTheZeroAddressAsRecipient() public {
        vm.prank(minter);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InvalidReceiver.selector, address(0)));
        overture.mint(address(0), 1);
    }

    /**
     * @dev No cap of any kind: three very large mints in a row, in the same block and across
     *      a long time gap, all go through. The removed per-epoch cap would have refused the
     *      first one with a zero cap armed.
     */
    function test_Mint_HasNoCapOfAnyKind() public {
        vm.startPrank(minter);
        overture.mint(alice, 1e30);
        overture.mint(alice, 1e30);
        vm.warp(block.timestamp + 3650 days);
        overture.mint(bob, 1e30);
        vm.stopPrank();

        assertEq(overture.totalSupply(), 3e30, "every mint landed, uncapped");
        assertEq(overture.balanceOf(alice), 2e30, "alice holds both mints");
        assertEq(overture.balanceOf(bob), 1e30, "bob holds his");
    }

    /// @dev The cap surface is gone from the ABI, not merely unused: a call to any of its old
    ///      selectors hits no function and no fallback, so it fails.
    function test_Mint_NoEpochOrCapFunctionExists() public {
        bytes[5] memory calls = [
            abi.encodeWithSignature("setEpochCap(uint256,uint256)", 1, 1e24),
            abi.encodeWithSignature("armNextEpoch(uint256,uint256,uint64)", 2, 1e24, uint64(block.timestamp + 1)),
            abi.encodeWithSignature("cancelNextEpoch()"),
            abi.encodeWithSignature("effectiveEpoch()"),
            abi.encodeWithSignature("currentEpochId()")
        ];
        for (uint256 i = 0; i < calls.length; ++i) {
            vm.prank(timelock);
            (bool ok,) = address(overture).call(calls[i]);
            assertFalse(ok, "no epoch or cap function exists on the Overture token");
        }
    }

    /**
     * @dev The token carries the `IMintableRewardToken` shape every reward token this program
     *      deploys must carry. The implicit conversion below compiles only because the token
     *      inherits the interface; the selector is the pinned `mint(address,uint256)`; and the
     *      call through the interface type mints for the minter alone.
     */
    function test_Mint_CarriesTheIMintableRewardTokenShape() public {
        IMintableRewardToken shaped = overture;
        assertEq(IMintableRewardToken.mint.selector, bytes4(0x40c10f19), "the pinned selector");
        assertEq(TokenOverture.mint.selector, IMintableRewardToken.mint.selector, "the token's mint is that shape");

        vm.prank(minter);
        shaped.mint(alice, 5e18);
        assertEq(overture.balanceOf(alice), 5e18, "it mints through the interface type");

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(TokenOverture.NotMinter.selector, stranger));
        shaped.mint(alice, 1);
    }

    // ──────────────────────── Minter role ──────────────────────

    function test_SetMinter_ByTheOwnerMovesTheRoleAndAnnouncesBothSides() public {
        vm.expectEmit(false, false, false, true, address(overture));
        emit MinterChanged(minter, bob);
        vm.prank(timelock);
        overture.setMinter(bob);

        assertEq(overture.minter(), bob, "the role moved");

        vm.prank(minter);
        vm.expectRevert(abi.encodeWithSelector(TokenOverture.NotMinter.selector, minter));
        overture.mint(alice, 1);

        vm.prank(bob);
        overture.mint(alice, 1);
        assertEq(overture.balanceOf(alice), 1, "the new minter mints");
    }

    function test_SetMinter_RejectsEveryoneButTheOwner() public {
        address[3] memory callers = [minter, stranger, alice];
        for (uint256 i = 0; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, callers[i]));
            overture.setMinter(callers[i]);
        }
    }

    /// @dev `address(0)` is the "minting off" state, and nobody can mint in it.
    function test_SetMinter_ZeroDisablesMinting() public {
        vm.prank(timelock);
        overture.setMinter(address(0));

        vm.prank(minter);
        vm.expectRevert(abi.encodeWithSelector(TokenOverture.NotMinter.selector, minter));
        overture.mint(alice, 1);
    }

    // ──────────────────────── Ownership ────────────────────────

    function test_RenounceOwnership_IsDisabledForTheOwner() public {
        vm.prank(timelock);
        vm.expectRevert(TokenOverture.RenounceDisabled.selector);
        overture.renounceOwnership();
        assertEq(overture.owner(), timelock, "the owner is unchanged");
    }

    function test_RenounceOwnership_GivesAStrangerTheOwnableRejection() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, stranger));
        overture.renounceOwnership();
    }

    /// @dev Two-step: a nomination changes nothing until the nominee accepts, and nobody else
    ///      can accept for it.
    function test_TransferOwnership_IsTwoStep() public {
        vm.prank(timelock);
        overture.transferOwnership(bob);
        assertEq(overture.owner(), timelock, "a nomination does not move ownership");
        assertEq(overture.pendingOwner(), bob, "the nominee is pending");

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, stranger));
        overture.acceptOwnership();

        vm.prank(bob);
        overture.acceptOwnership();
        assertEq(overture.owner(), bob, "the nominee accepted");
        assertEq(overture.pendingOwner(), address(0), "nothing is pending afterwards");
    }

    // ──────────────────────── Permit (through the proxy) ───────

    /// @dev The permit domain names the PROXY as its verifying contract, with the launch name and
    ///      version "1" — recomputed from scratch, not read back from the token's own view.
    function test_Permit_DomainSeparatorNamesTheProxy() public view {
        bytes32 expected = keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256("Overture"), keccak256("1"), block.chainid, address(overture))
        );
        assertEq(overture.DOMAIN_SEPARATOR(), expected, "the permit domain is (Overture, 1, chainid, proxy)");

        (, string memory name_, string memory version_, uint256 chainId_, address verifying_,,) =
            overture.eip712Domain();
        assertEq(name_, "Overture", "ERC-5267 name");
        assertEq(version_, "1", "ERC-5267 version");
        assertEq(chainId_, block.chainid, "ERC-5267 chain id");
        assertEq(verifying_, address(overture), "ERC-5267 verifying contract is the proxy");
    }

    function test_Permit_GrantsTheAllowanceAndBumpsTheNonce() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(alicePk, alice, bob, 500e18, 0, deadline);

        vm.prank(stranger); // anyone may submit a permit
        overture.permit(alice, bob, 500e18, deadline, v, r, s);

        assertEq(overture.allowance(alice, bob), 500e18, "the permit granted the allowance");
        assertEq(overture.nonces(alice), 1, "the nonce moved on");
    }

    /// @dev A submitted signature is spent: replaying it recovers to some other address under
    ///      the next nonce and is rejected.
    function test_Permit_RejectsAReplay() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(alicePk, alice, bob, 500e18, 0, deadline);
        overture.permit(alice, bob, 500e18, deadline, v, r, s);

        vm.expectPartialRevert(ERC20PermitUpgradeable.ERC2612InvalidSigner.selector);
        overture.permit(alice, bob, 500e18, deadline, v, r, s);
    }

    function test_Permit_RejectsAnExpiredSignature() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(alicePk, alice, bob, 500e18, 0, deadline);

        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(ERC20PermitUpgradeable.ERC2612ExpiredSignature.selector, deadline));
        overture.permit(alice, bob, 500e18, deadline, v, r, s);
    }

    /// @dev A signature made for the bare IMPLEMENTATION's address is worthless at the proxy:
    ///      the domain is bound to the proxy, the address users actually hold.
    function test_Permit_RejectsASignatureForAnotherVerifyingContract() public {
        address impl = address(uint160(uint256(vm.load(address(overture), ERC1967Utils.IMPLEMENTATION_SLOT))));
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 wrongDomain =
            keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256("Overture"), keccak256("1"), block.chainid, impl));
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, alice, bob, 500e18, 0, deadline));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(alicePk, keccak256(abi.encodePacked("\x19\x01", wrongDomain, structHash)));

        vm.expectPartialRevert(ERC20PermitUpgradeable.ERC2612InvalidSigner.selector);
        overture.permit(alice, bob, 500e18, deadline, v, r, s);
    }

    // ──────────────────────── Burn ─────────────────────────────

    function test_Burn_DestroysTheHoldersOwnTokens() public {
        _mint(alice, 1_000e18);

        vm.prank(alice);
        overture.burn(400e18);

        assertEq(overture.balanceOf(alice), 600e18, "the holder's balance fell by the burn");
        assertEq(overture.totalSupply(), 600e18, "the supply fell by the burn");
    }

    function test_BurnFrom_SpendsTheAllowance() public {
        _mint(alice, 1_000e18);
        vm.prank(alice);
        overture.approve(bob, 300e18);

        vm.prank(bob);
        overture.burnFrom(alice, 200e18);

        assertEq(overture.balanceOf(alice), 800e18, "the holder's balance fell");
        assertEq(overture.allowance(alice, bob), 100e18, "the allowance was spent");
        assertEq(overture.totalSupply(), 800e18, "the supply fell");
    }

    function test_BurnFrom_WithoutAllowanceReverts() public {
        _mint(alice, 1_000e18);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, bob, 0, 1));
        overture.burnFrom(alice, 1);
    }

    // ──────────────────────── Upgrade ──────────────────────────

    /**
     * @dev The upgrade claim, measured end to end: the timelock swaps the code and runs the V2
     *      reinitializer in one call, and every piece of holder state — balances, supply,
     *      allowances, permit nonces and domain — plus owner and minter reads the same after.
     */
    function test_Upgrade_ByTheOwnerKeepsEveryHolderFact() public {
        _mint(alice, 1_000e18);
        vm.prank(alice);
        overture.approve(bob, 250e18);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(alicePk, alice, stranger, 7, 0, deadline);
        overture.permit(alice, stranger, 7, deadline, v, r, s);
        bytes32 domainBefore = overture.DOMAIN_SEPARATOR();

        TokenOvertureV2Mock v2 = new TokenOvertureV2Mock();
        vm.prank(timelock);
        overture.upgradeToAndCall(address(v2), abi.encodeCall(TokenOvertureV2Mock.initializeV2, (42)));

        TokenOvertureV2Mock upgraded = TokenOvertureV2Mock(address(overture));
        assertEq(
            address(uint160(uint256(vm.load(address(overture), ERC1967Utils.IMPLEMENTATION_SLOT)))),
            address(v2),
            "the ERC-1967 slot names V2"
        );
        assertEq(upgraded.version(), 2, "the proxy runs V2 code");
        assertEq(upgraded.upgradeMarker(), 42, "the reinitializer ran once, in the upgrade call");

        assertEq(overture.balanceOf(alice), 1_000e18, "balances survive");
        assertEq(overture.totalSupply(), 1_000e18, "supply survives");
        assertEq(overture.allowance(alice, bob), 250e18, "allowances survive");
        assertEq(overture.allowance(alice, stranger), 7, "permit-granted allowances survive");
        assertEq(overture.nonces(alice), 1, "permit nonces survive");
        assertEq(overture.DOMAIN_SEPARATOR(), domainBefore, "the permit domain survives");
        assertEq(overture.name(), "Overture", "the name survives");
        assertEq(overture.symbol(), "OVTR", "the symbol survives");
        assertEq(overture.owner(), timelock, "the owner survives");
        assertEq(overture.minter(), minter, "the minter survives");

        // The minter still mints under V2.
        vm.prank(minter);
        overture.mint(bob, 1);
        assertEq(overture.balanceOf(bob), 1, "minting works after the upgrade");

        // And V2's reinitializer is one-shot.
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        upgraded.initializeV2(43);
    }

    function test_Upgrade_RejectsEveryoneButTheOwner() public {
        TokenOvertureV2Mock v2 = new TokenOvertureV2Mock();
        address[2] memory callers = [minter, stranger];
        for (uint256 i = 0; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, callers[i]));
            overture.upgradeToAndCall(address(v2), "");
        }
    }

    // ──────────────────────── Storage ──────────────────────────

    /**
     * @dev The namespace, pinned. `TOKEN_OVERTURE_STORAGE` is a literal in the contract; this
     *      recomputes the ERC-7201 derivation, checks the literal against it, and reads the
     *      minter straight out of the proxy at that slot.
     */
    function test_Storage_LivesAtThePinnedErc7201Slot() public {
        bytes32 expected =
            keccak256(abi.encode(uint256(keccak256("real.lp.storage.TokenOverture")) - 1)) & ~bytes32(uint256(0xff));
        assertEq(expected, TOKEN_OVERTURE_STORAGE, "the pinned literal is the ERC-7201 slot");

        assertEq(
            address(uint160(uint256(vm.load(address(overture), expected)))), minter, "namespace slot 0 holds `minter`"
        );

        vm.prank(timelock);
        overture.setMinter(bob);
        assertEq(address(uint160(uint256(vm.load(address(overture), expected)))), bob, "and follows setMinter");
    }

    // ──────────────────────── Helpers ──────────────────────────

    function _mint(address to, uint256 amount) internal {
        vm.prank(minter);
        overture.mint(to, amount);
    }

    function _signPermit(uint256 pk, address owner_, address spender, uint256 value, uint256 nonce, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, owner_, spender, value, nonce, deadline));
        (v, r, s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", overture.DOMAIN_SEPARATOR(), structHash)));
    }
}
