// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {MockRealToken} from "../../../contracts/staking-v3/mocks/MockRealToken.sol";
import {BurnStandIn} from "../../../contracts/staking-v3/testnet/BurnStandIn.sol";
import {PayoutStandIn} from "../../../contracts/staking-v3/testnet/PayoutStandIn.sol";

/// @dev Shared keys and the EIP-2612 / access-signature signing helpers.
abstract contract StandInBase is Test {
    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 internal constant ACCESS_TYPEHASH = keccak256("MigrationAccess(address from,uint256 deadline)");

    uint256 internal constant SUPPLY = 1_000_000_000e18;

    MockRealToken internal token;
    address internal alice;
    uint256 internal alicePk;
    address internal bob;
    uint256 internal bobPk;
    address internal accessSigner;
    uint256 internal accessSignerPk;

    function _makeKeys() internal {
        (alice, alicePk) = makeAddrAndKey("alice");
        (bob, bobPk) = makeAddrAndKey("bob");
        (accessSigner, accessSignerPk) = makeAddrAndKey("accessSigner");
    }

    function _tokenDomain() internal view returns (bytes32) {
        return
            keccak256(
                abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256("REAL"), keccak256("1"), block.chainid, address(token))
            );
    }

    function _signPermit(uint256 pk, address owner_, address spender, uint256 value, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, owner_, spender, value, token.nonces(owner_), deadline));
        (v, r, s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", _tokenDomain(), structHash)));
    }
}

/// @notice The unit-test token: the features of the test $ASSET the bridge owner deployed.
contract MockRealTokenTest is StandInBase {
    function setUp() public {
        _makeKeys();
        token = new MockRealToken(alice, SUPPLY);
    }

    function test_Metadata_RealAsset18DecimalsWholeSupplyToTheHolder() public view {
        assertEq(token.name(), "REAL");
        assertEq(token.symbol(), "ASSET");
        assertEq(token.decimals(), 18);
        assertEq(token.totalSupply(), SUPPLY);
        assertEq(token.balanceOf(alice), SUPPLY);
    }

    function test_Permit_DomainIsRealVersionOne() public {
        assertEq(token.DOMAIN_SEPARATOR(), _tokenDomain(), "domain REAL / 1");
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(alicePk, alice, bob, 5e18, block.timestamp + 1);
        token.permit(alice, bob, 5e18, block.timestamp + 1, v, r, s);
        assertEq(token.allowance(alice, bob), 5e18);
    }

    function test_Burn_LowersSupplyAndEmitsTransferToZero() public {
        vm.expectEmit(address(token));
        emit IERC20Events.Transfer(alice, address(0), 3e18);
        vm.prank(alice);
        token.burn(3e18);
        assertEq(token.totalSupply(), SUPPLY - 3e18);
    }

    function test_BurnFrom_SpendsTheAllowance() public {
        vm.prank(alice);
        token.approve(bob, 4e18);
        vm.prank(bob);
        token.burnFrom(alice, 4e18);
        assertEq(token.allowance(alice, bob), 0);
        assertEq(token.balanceOf(alice), SUPPLY - 4e18);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, bob, 0, 1));
        token.burnFrom(alice, 1);
    }

    function test_NoMint_TheTokenHasNoMintEntry() public {
        (bool ok,) = address(token).call(abi.encodeWithSignature("mint(address,uint256)", alice, 1));
        assertFalse(ok, "no mint after construction");
    }
}

interface IERC20Events {
    event Transfer(address indexed from, address indexed to, uint256 value);
}

/// @notice The burn stand-in against the bridge owner's interface, revert list and check order (his
///         changes of 2026-11-23).
contract BurnStandInTest is StandInBase {
    BurnStandIn internal burner;
    address internal dest;
    uint256 internal closeAt;

    function setUp() public {
        _makeKeys();
        dest = makeAddr("avalancheReceiver");
        token = new MockRealToken(address(this), SUPPLY);
        token.transfer(alice, 1_000e18);
        token.transfer(bob, 1_000e18);
        burner = new BurnStandIn(address(token), address(this), accessSigner);
        burner.open();
        closeAt = burner.closeAt();
    }

    // ── The getters and the constructor ──

    function test_Getters_MatchTheBridgeInterface() public {
        BurnStandIn fresh = new BurnStandIn(address(token), address(this), accessSigner);
        assertEq(fresh.MIN_AMOUNT(), 1e18, "MIN_AMOUNT is 1e18");
        assertFalse(fresh.paused());
        assertFalse(fresh.requireSignature(), "off after deployment; the deploy script turns it on");
        assertFalse(fresh.opened(), "born closed");
        assertEq(fresh.closeAt(), 0, "closeAt is 0 before open()");
        assertEq(fresh.accessSigner(), accessSigner);
        assertEq(address(fresh.token()), address(token));
        assertEq(fresh.nextSeq(), 0);
    }

    function test_Constructor_BlocksTheTokenAndTheStandInItself() public {
        BurnStandIn fresh = new BurnStandIn(address(token), address(this), accessSigner);
        assertTrue(fresh.blockedDestination(address(token)), "the token");
        assertTrue(fresh.blockedDestination(address(fresh)), "the stand-in itself");
        assertFalse(fresh.blockedDestination(dest));
        assertFalse(fresh.blockedDestination(address(0)));
    }

    function test_Constructor_RejectsAZeroToken() public {
        vm.expectRevert(BurnStandIn.ZeroAddress.selector);
        new BurnStandIn(address(0), address(this), accessSigner);
    }

    // ── migrate ──

    function test_Migrate_BurnsTheCallersTokensAndEmitsTheBurnId() public {
        _approve(alice, 10e18);
        bytes32 id = _id(0, alice, dest, 10e18);
        vm.expectEmit(address(token));
        emit IERC20Events.Transfer(alice, address(0), 10e18);
        vm.expectEmit(address(burner));
        emit BurnStandIn.Migrated(id, 0, alice, dest, 10e18);
        vm.prank(alice);
        burner.migrate(10e18, dest);

        assertEq(token.balanceOf(alice), 990e18);
        assertEq(token.totalSupply(), SUPPLY - 10e18, "burned, not held");
        assertEq(token.balanceOf(address(burner)), 0);
        assertEq(burner.nextSeq(), 1);
    }

    function test_Migrate_SeqCountsEveryBurnSoEqualBurnsHaveDifferentIds() public {
        _approve(alice, 2e18);
        _approve(bob, 1e18);

        vm.recordLogs();
        vm.prank(alice);
        burner.migrate(1e18, dest);
        vm.prank(bob);
        burner.migrate(1e18, dest);
        vm.prank(alice);
        burner.migrate(1e18, dest);

        assertEq(burner.nextSeq(), 3);
        bytes32 first = _id(0, alice, dest, 1e18);
        bytes32 third = _id(2, alice, dest, 1e18);
        assertTrue(first != third, "same burn, different seq, different id");
        bytes32[] memory ids = _migratedIds();
        assertEq(ids.length, 3);
        assertEq(ids[0], first);
        assertEq(ids[1], _id(1, bob, dest, 1e18));
        assertEq(ids[2], third);
    }

    function test_Migrate_FromIsAlwaysTheCaller() public {
        vm.prank(alice);
        token.approve(bob, 5e18); // an allowance to bob does not let bob burn alice's tokens here
        _approve(bob, 5e18);

        vm.expectEmit(address(burner));
        emit BurnStandIn.Migrated(_id(0, bob, dest, 5e18), 0, bob, dest, 5e18);
        vm.prank(bob);
        burner.migrate(5e18, dest);
        assertEq(token.balanceOf(alice), 1_000e18, "alice untouched");
        assertEq(token.balanceOf(bob), 995e18);
    }

    function test_Migrate_WithoutAllowanceRevertsInTheToken() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(burner), 0, 1e18)
        );
        burner.migrate(1e18, dest);
    }

    // ── migrateWithPermit ──

    function test_MigrateWithPermit_OneTransactionAfterASignature() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(alicePk, alice, address(burner), 7e18, deadline);

        vm.expectEmit(address(burner));
        emit BurnStandIn.Migrated(_id(0, alice, dest, 7e18), 0, alice, dest, 7e18);
        vm.prank(alice);
        burner.migrateWithPermit(7e18, dest, deadline, v, r, s);
        assertEq(token.balanceOf(alice), 993e18);
        assertEq(token.allowance(alice, address(burner)), 0, "the permit's value is spent exactly");
    }

    function test_MigrateWithPermit_ThePermitValueMustBeTheAmountExactly() public {
        uint256 deadline = block.timestamp + 1 hours;
        // Signed for 8e18, called with 7e18: the permit fails, is ignored, and the burn has no allowance.
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(alicePk, alice, address(burner), 8e18, deadline);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(burner), 0, 7e18)
        );
        burner.migrateWithPermit(7e18, dest, deadline, v, r, s);
    }

    function test_MigrateWithPermit_TheOwnerIsTheCaller() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(alicePk, alice, address(burner), 7e18, deadline);
        vm.prank(bob); // alice's permit, bob's call: owner = bob, so the signature does not match
        vm.expectRevert();
        burner.migrateWithPermit(7e18, dest, deadline, v, r, s);
    }

    function test_MigrateWithPermit_AFrontRunPermitStillBurnsOnTheAllowance() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(alicePk, alice, address(burner), 7e18, deadline);
        token.permit(alice, address(burner), 7e18, deadline, v, r, s); // someone submits it first

        vm.prank(alice);
        burner.migrateWithPermit(7e18, dest, deadline, v, r, s);
        assertEq(token.balanceOf(alice), 993e18);
    }

    // ── Every error ──

    function test_Revert_EnforcedPause() public {
        burner.setPaused(true);
        _approve(alice, 1e18);
        vm.prank(alice);
        vm.expectRevert(BurnStandIn.EnforcedPause.selector);
        burner.migrate(1e18, dest);
    }

    function test_Revert_NotOpenedBeforeOpen() public {
        BurnStandIn fresh = new BurnStandIn(address(token), address(this), accessSigner);
        vm.prank(alice);
        token.approve(address(fresh), 1e18);
        vm.prank(alice);
        vm.expectRevert(BurnStandIn.NotOpened.selector);
        fresh.migrate(1e18, dest);
    }

    function test_Revert_ZeroDestination() public {
        _approve(alice, 1e18);
        vm.prank(alice);
        vm.expectRevert(BurnStandIn.ZeroDestination.selector);
        burner.migrate(1e18, address(0));
    }

    function test_Revert_BelowTheMinimum() public {
        _approve(alice, 1e18);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BurnStandIn.AmountBelowMinimum.selector, 1e18 - 1));
        burner.migrate(1e18 - 1, dest);

        vm.prank(alice);
        burner.migrate(1e18, dest); // exactly the minimum passes (amount >= MIN_AMOUNT)
    }

    // ── open(), closeAt, extendCloseAt ──

    function test_Open_SetsCloseAtToExactlyNinetyDaysLaterAndOnlyOnce() public {
        BurnStandIn fresh = new BurnStandIn(address(token), address(this), accessSigner);
        assertEq(fresh.closeAt(), 0);
        vm.warp(block.timestamp + 1234);
        fresh.open();
        assertTrue(fresh.opened());
        assertEq(fresh.closeAt(), block.timestamp + 90 days);
        vm.expectRevert(BurnStandIn.AlreadyOpened.selector);
        fresh.open();
    }

    function test_CloseAt_TheLastSecondPassesAndTheNextReverts() public {
        _approve(alice, 2e18);
        vm.warp(closeAt);
        vm.prank(alice);
        burner.migrate(1e18, dest); // closeAt itself is still open

        vm.warp(closeAt + 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BurnStandIn.MigrationClosed.selector, closeAt));
        burner.migrate(1e18, dest);
        assertTrue(burner.opened(), "opened stays true after the end");
    }

    function test_ExtendCloseAt_OnlyLaterAndItReopensAfterTheEnd() public {
        vm.expectRevert(abi.encodeWithSelector(BurnStandIn.CloseAtNotLater.selector, closeAt, closeAt));
        burner.extendCloseAt(closeAt);
        vm.expectRevert(abi.encodeWithSelector(BurnStandIn.CloseAtNotLater.selector, closeAt, closeAt - 1));
        burner.extendCloseAt(closeAt - 1);

        _approve(alice, 2e18);
        vm.warp(closeAt + 10);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BurnStandIn.MigrationClosed.selector, closeAt));
        burner.migrate(1e18, dest);

        uint256 second = closeAt + 30 days;
        burner.extendCloseAt(second);
        assertEq(burner.closeAt(), second);
        vm.warp(second);
        vm.prank(alice);
        burner.migrate(1e18, dest); // the second closeAt itself passes
        vm.warp(second + 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BurnStandIn.MigrationClosed.selector, second));
        burner.migrate(1e18, dest);
    }

    function test_ExtendCloseAt_NeedsTheOpening() public {
        BurnStandIn fresh = new BurnStandIn(address(token), address(this), accessSigner);
        vm.expectRevert(BurnStandIn.NotOpened.selector);
        fresh.extendCloseAt(block.timestamp + 1 days);
    }

    // ── Blocked destinations ──

    function test_Blocked_ARevertBeforeAnythingIsBurned() public {
        _approve(alice, 2e18);
        burner.setBlockedDestination(dest, true);
        assertTrue(burner.blockedDestination(dest));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BurnStandIn.DestinationBlocked.selector, dest));
        burner.migrate(1e18, dest);
        assertEq(token.balanceOf(alice), 1_000e18, "nothing burned");

        burner.setBlockedDestination(dest, false);
        vm.prank(alice);
        burner.migrate(1e18, dest);
        assertEq(token.balanceOf(alice), 999e18);
    }

    function test_Blocked_TheConstructorsTwoAddressesAreRefused() public {
        _approve(alice, 2e18);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BurnStandIn.DestinationBlocked.selector, address(token)));
        burner.migrate(1e18, address(token));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BurnStandIn.DestinationBlocked.selector, address(burner)));
        burner.migrate(1e18, address(burner));
    }

    function test_Blocked_AlsoTheLongVariantsWithTheSignature() public {
        burner.setRequireSignature(true);
        burner.setBlockedDestination(dest, true);
        uint256 accessDeadline = block.timestamp + 1 days;
        bytes memory sig = _signAccess(accessSignerPk, alice, accessDeadline);
        _approve(alice, 1e18);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BurnStandIn.DestinationBlocked.selector, dest));
        burner.migrate(1e18, dest, accessDeadline, sig);
    }

    // ── The access signature ──

    function test_Access_TheShortVariantsRevertWhileTheSignatureIsRequired() public {
        burner.setRequireSignature(true);
        _approve(alice, 2e18);
        vm.prank(alice);
        vm.expectRevert(BurnStandIn.AccessSignatureRequired.selector);
        burner.migrate(1e18, dest);

        (uint8 v, bytes32 r, bytes32 s) = _signPermit(alicePk, alice, address(burner), 1e18, block.timestamp + 1);
        vm.prank(alice);
        vm.expectRevert(BurnStandIn.AccessSignatureRequired.selector);
        burner.migrateWithPermit(1e18, dest, block.timestamp + 1, v, r, s);
    }

    function test_Access_TheLongVariantsBurnWithAValidSignature() public {
        burner.setRequireSignature(true);
        uint256 accessDeadline = block.timestamp + 7 days;
        bytes memory sig = _signAccess(accessSignerPk, alice, accessDeadline);

        _approve(alice, 1e18);
        vm.prank(alice);
        burner.migrate(1e18, dest, accessDeadline, sig);

        uint256 permitDeadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(alicePk, alice, address(burner), 2e18, permitDeadline);
        vm.expectEmit(address(burner));
        emit BurnStandIn.Migrated(_id(1, alice, dest, 2e18), 1, alice, dest, 2e18);
        vm.prank(alice);
        burner.migrateWithPermit(2e18, dest, permitDeadline, v, r, s, accessDeadline, sig);
        assertEq(token.balanceOf(alice), 997e18);
    }

    function test_Access_TheSignatureCoversOnlyTheCallerAndTheDeadline() public {
        burner.setRequireSignature(true);
        uint256 accessDeadline = block.timestamp + 7 days;
        bytes memory aliceSig = _signAccess(accessSignerPk, alice, accessDeadline);
        _approve(alice, 3e18);
        _approve(bob, 1e18);

        // Any amount and any destination with the same signature.
        vm.startPrank(alice);
        burner.migrate(1e18, dest, accessDeadline, aliceSig);
        burner.migrate(2e18, makeAddr("other"), accessDeadline, aliceSig);
        vm.stopPrank();

        // Another caller cannot use it.
        vm.prank(bob);
        vm.expectRevert(BurnStandIn.InvalidAccessSignature.selector);
        burner.migrate(1e18, dest, accessDeadline, aliceSig);

        // Nor can the deadline be changed.
        vm.prank(alice);
        vm.expectRevert(BurnStandIn.InvalidAccessSignature.selector);
        burner.migrate(1e18, dest, accessDeadline + 1, aliceSig);
    }

    function test_Access_ExpiredDeadlineReverts() public {
        burner.setRequireSignature(true);
        uint256 accessDeadline = block.timestamp + 1 days;
        bytes memory sig = _signAccess(accessSignerPk, alice, accessDeadline);
        _approve(alice, 2e18);

        vm.warp(accessDeadline);
        vm.prank(alice);
        burner.migrate(1e18, dest, accessDeadline, sig); // the deadline second itself is valid

        vm.warp(accessDeadline + 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BurnStandIn.AccessSignatureExpired.selector, accessDeadline));
        burner.migrate(1e18, dest, accessDeadline, sig);
    }

    function test_Access_AWrongSignerOrABadEncodingReverts() public {
        burner.setRequireSignature(true);
        uint256 accessDeadline = block.timestamp + 1 days;
        _approve(alice, 1e18);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(accessSignerPk, burner.accessDigest(alice, accessDeadline));
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

        bytes[] memory bad = new bytes[](6);
        bad[0] = _signAccess(bobPk, alice, accessDeadline); // the wrong key
        bad[1] = hex"1234"; // garbage
        bad[2] = abi.encodePacked(r, bytes32(uint256(s) | (uint256(v - 27) << 255))); // 64 bytes (EIP-2098)
        bad[3] = abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27)); // high s
        bad[4] = abi.encodePacked(r, s, v - 27); // v = 0 or 1
        bad[5] = abi.encodePacked(s, r, v); // r and s swapped
        for (uint256 i = 0; i < bad.length; ++i) {
            vm.prank(alice);
            vm.expectRevert(BurnStandIn.InvalidAccessSignature.selector);
            burner.migrate(1e18, dest, accessDeadline, bad[i]);
        }
        vm.prank(alice);
        burner.migrate(1e18, dest, accessDeadline, abi.encodePacked(r, s, v)); // r || s || v passes
    }

    function test_Access_WhileNotRequiredTheLongVariantsIgnoreDeadlineAndSignature() public {
        assertFalse(burner.requireSignature());
        _approve(alice, 3e18);
        vm.warp(block.timestamp + 10 days);
        uint256 expired = block.timestamp - 1;
        bytes memory valid = _signAccess(accessSignerPk, alice, expired);

        vm.startPrank(alice);
        burner.migrate(1e18, dest, expired, valid); // an expired deadline
        burner.migrate(1e18, dest, block.timestamp + 1, hex"deadbeef"); // garbage bytes
        burner.migrate(1e18, dest, 0, _signAccess(bobPk, alice, 0)); // the wrong key, deadline 0
        vm.stopPrank();
        assertEq(token.balanceOf(alice), 997e18);

        uint256 permitDeadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(alicePk, alice, address(burner), 2e18, permitDeadline);
        vm.prank(alice);
        burner.migrateWithPermit(2e18, dest, permitDeadline, v, r, s, expired, hex"00");
        assertEq(token.balanceOf(alice), 995e18);
    }

    function test_Access_TheDigestIsTheDocumentedEip712() public view {
        uint256 deadline = 1234;
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ASSET Migration"),
                keccak256("1"),
                block.chainid,
                address(burner)
            )
        );
        bytes32 typeHash = keccak256("MigrationAccess(address from,uint256 deadline)");
        bytes32 expected =
            keccak256(abi.encodePacked("\x19\x01", domain, keccak256(abi.encode(typeHash, alice, deadline))));
        assertEq(burner.accessDigest(alice, deadline), expected);
        assertEq(burner.MIGRATION_ACCESS_TYPEHASH(), typeHash);
    }

    // ── The order of the checks: the first failing one gives the error ──

    /// @dev Every condition of the list fails at the start; each step repairs exactly the condition
    ///      that just failed, so each step proves that one check comes before ALL later ones (every
    ///      neighbouring pair included).
    function test_Order_TheFirstFailingCheckWinsAtEveryStep() public {
        BurnStandIn b = new BurnStandIn(address(token), address(this), accessSigner);
        b.setRequireSignature(true); // 1-3 armed
        b.setPaused(true); // 4
        // 5: not opened. 6: closeAt == 0 is in the past as well.
        b.setBlockedDestination(address(0), true); // 7 and 8 both on the zero receiver
        uint256 small = 1e18 - 1; // 9; 10: alice has approved nothing to `b`
        uint256 expired = block.timestamp - 1;
        uint256 later = block.timestamp + 365 days;

        vm.startPrank(alice);
        // 1: the requirement is on and the variant has no signature.
        vm.expectRevert(BurnStandIn.AccessSignatureRequired.selector);
        b.migrate(small, address(0));
        // 2 before 3: an expired deadline AND a garbage signature.
        vm.expectRevert(abi.encodeWithSelector(BurnStandIn.AccessSignatureExpired.selector, expired));
        b.migrate(small, address(0), expired, hex"1234");
        // 3 before 4: a live deadline, the garbage signature, paused.
        vm.expectRevert(BurnStandIn.InvalidAccessSignature.selector);
        b.migrate(small, address(0), later, hex"1234");
        bytes memory sig = _signAccessOn(b, accessSignerPk, alice, later);
        // 4 before 5: paused and not opened.
        vm.expectRevert(BurnStandIn.EnforcedPause.selector);
        b.migrate(small, address(0), later, sig);
        vm.stopPrank();

        b.setPaused(false);
        // 5 before 6: not opened, and closeAt (0) already passed.
        vm.prank(alice);
        vm.expectRevert(BurnStandIn.NotOpened.selector);
        b.migrate(small, address(0), later, sig);

        b.open();
        uint256 firstClose = b.closeAt();
        vm.warp(firstClose + 1);
        // 6 before 7: closed and the zero receiver.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BurnStandIn.MigrationClosed.selector, firstClose));
        b.migrate(small, address(0), later, sig);

        b.extendCloseAt(later);
        // 7 before 8: the zero receiver, which is also blocked.
        vm.prank(alice);
        vm.expectRevert(BurnStandIn.ZeroDestination.selector);
        b.migrate(small, address(0), later, sig);
        // 8 before 9: a blocked receiver and an amount below the minimum.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BurnStandIn.DestinationBlocked.selector, address(token)));
        b.migrate(small, address(token), later, sig);
        // 9 before 10: below the minimum and no allowance.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BurnStandIn.AmountBelowMinimum.selector, small));
        b.migrate(small, dest, later, sig);
        // 10: no allowance, the token's own error.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(b), 0, 1e18));
        b.migrate(1e18, dest, later, sig);

        vm.prank(alice);
        token.approve(address(b), 1e18);
        vm.prank(alice);
        b.migrate(1e18, dest, later, sig);
        assertEq(b.nextSeq(), 1);
    }

    /// @dev With the requirement off, checks 1-3 do not exist: the first error is the pause.
    function test_Order_WithTheRequirementOffThePauseComesFirst() public {
        burner.setPaused(true);
        vm.prank(alice);
        vm.expectRevert(BurnStandIn.EnforcedPause.selector);
        burner.migrate(1, address(0), 0, hex"12");
        vm.prank(alice);
        vm.expectRevert(BurnStandIn.EnforcedPause.selector);
        burner.migrate(1, address(0));
    }

    // ── The test-only owner setters ──

    function test_Setters_OwnerOnlyAndEachTakesEffect() public {
        address newSigner = makeAddr("newSigner");
        burner.setPaused(true);
        burner.setRequireSignature(true);
        burner.setAccessSigner(newSigner);
        burner.setBlockedDestination(dest, true);
        burner.extendCloseAt(closeAt + 1);
        assertTrue(burner.paused());
        assertTrue(burner.requireSignature());
        assertEq(burner.accessSigner(), newSigner);
        assertTrue(burner.blockedDestination(dest));
        assertEq(burner.closeAt(), closeAt + 1);

        BurnStandIn fresh = new BurnStandIn(address(token), address(this), accessSigner);
        bytes memory notOwner = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice);
        vm.startPrank(alice);
        vm.expectRevert(notOwner);
        burner.setPaused(false);
        vm.expectRevert(notOwner);
        burner.setRequireSignature(false);
        vm.expectRevert(notOwner);
        burner.setAccessSigner(alice);
        vm.expectRevert(notOwner);
        burner.setBlockedDestination(dest, false);
        vm.expectRevert(notOwner);
        burner.extendCloseAt(closeAt + 2);
        vm.expectRevert(notOwner);
        fresh.open();
        vm.stopPrank();
    }

    // ── helpers ──

    function _approve(address who, uint256 amount) internal {
        vm.prank(who);
        token.approve(address(burner), amount);
    }

    function _id(uint256 seq, address from, address destination, uint256 amount) internal view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(burner), seq, from, destination, amount));
    }

    function _signAccess(uint256 pk, address from, uint256 deadline) internal view returns (bytes memory) {
        return _signAccessOn(burner, pk, from, deadline);
    }

    function _signAccessOn(BurnStandIn b, uint256 pk, address from, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, b.accessDigest(from, deadline));
        return abi.encodePacked(r, s, v);
    }

    function _migratedIds() internal returns (bytes32[] memory ids) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 n;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics[0] == BurnStandIn.Migrated.selector) ++n;
        }
        ids = new bytes32[](n);
        n = 0;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics[0] == BurnStandIn.Migrated.selector) ids[n++] = logs[i].topics[1];
        }
    }
}

/// @notice The payout stand-in: `Paid` with the running total, never above the burned amount.
contract PayoutStandInTest is StandInBase {
    PayoutStandIn internal payout;
    address internal dest;
    bytes32 internal constant ID = keccak256("burn-1");

    function setUp() public {
        _makeKeys();
        dest = makeAddr("avalancheReceiver");
        token = new MockRealToken(address(this), SUPPLY);
        payout = new PayoutStandIn(address(token), address(this));
        token.transfer(address(payout), 1_000e18);
    }

    function test_Pay_TransfersAndEmitsPaidWithTheRunningTotal() public {
        vm.expectEmit(address(token));
        emit IERC20Events.Transfer(address(payout), dest, 4e18);
        vm.expectEmit(address(payout));
        emit PayoutStandIn.Paid(ID, dest, 4e18, 4e18, 10e18);
        payout.pay(ID, dest, 4e18, 10e18);

        vm.expectEmit(address(payout));
        emit PayoutStandIn.Paid(ID, dest, 6e18, 10e18, 10e18);
        payout.pay(ID, dest, 6e18, 10e18);

        assertEq(token.balanceOf(dest), 10e18);
        assertEq(payout.paidTotal(ID), 10e18, "paid in full: paidTotal == burnAmount");
        assertEq(payout.burnAmountOf(ID), 10e18);
    }

    function test_Pay_RevertsWhenPaidTotalWouldPassTheBurnAmount() public {
        payout.pay(ID, dest, 4e18, 10e18);
        vm.expectRevert(abi.encodeWithSelector(PayoutStandIn.ExceedsBurnAmount.selector, ID, 4e18 + 7e18, 10e18));
        payout.pay(ID, dest, 7e18, 10e18);

        vm.expectRevert(abi.encodeWithSelector(PayoutStandIn.ExceedsBurnAmount.selector, keccak256("x"), 2e18, 1e18));
        payout.pay(keccak256("x"), dest, 2e18, 1e18);
    }

    function test_Pay_RevertsWhenTheBurnAmountDiffersFromAnEarlierPayment() public {
        payout.pay(ID, dest, 4e18, 10e18);
        vm.expectRevert(abi.encodeWithSelector(PayoutStandIn.BurnAmountMismatch.selector, ID, 10e18, 11e18));
        payout.pay(ID, dest, 1e18, 11e18);
    }

    function test_Pay_RevertsOnAZeroDestinationOrAZeroAmount() public {
        vm.expectRevert(PayoutStandIn.ZeroDestination.selector);
        payout.pay(ID, address(0), 1e18, 10e18);
        vm.expectRevert(PayoutStandIn.ZeroAmount.selector);
        payout.pay(ID, dest, 0, 10e18);
    }

    function test_Pay_OwnerOnly() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        payout.pay(ID, dest, 1e18, 10e18);
    }

    function test_Pay_IdsAreIndependent() public {
        payout.pay(ID, dest, 10e18, 10e18);
        payout.pay(keccak256("burn-2"), bob, 3e18, 5e18);
        assertEq(payout.paidTotal(keccak256("burn-2")), 3e18);
        assertEq(token.balanceOf(bob), 3e18);
    }

    function test_Constructor_RejectsAZeroToken() public {
        vm.expectRevert(PayoutStandIn.ZeroAddress.selector);
        new PayoutStandIn(address(0), address(this));
    }
}

