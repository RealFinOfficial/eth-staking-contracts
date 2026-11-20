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
    bytes32 internal constant ACCESS_TYPEHASH = keccak256("MigrationAccess(address account,uint256 deadline)");

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

/// @notice The burn stand-in against the bridge owner's interface and revert list.
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
        closeAt = block.timestamp + 30 days;
        burner = new BurnStandIn(address(token), address(this), accessSigner, closeAt);
        burner.setOpened(true);
    }

    // ── The getters ──

    function test_Getters_MatchTheBridgeInterface() public {
        BurnStandIn fresh = new BurnStandIn(address(token), address(this), accessSigner, closeAt);
        assertEq(fresh.MIN_AMOUNT(), 1e18, "MIN_AMOUNT is 1e18");
        assertFalse(fresh.paused());
        assertFalse(fresh.requireSignature());
        assertFalse(fresh.opened(), "born closed");
        assertEq(fresh.closeAt(), closeAt);
        assertEq(fresh.accessSigner(), accessSigner);
        assertEq(address(fresh.token()), address(token));
        assertEq(fresh.nextSeq(), 0);
    }

    // ── migrate ──

    function test_Migrate_BurnsTheCallersTokensAndEmitsTheBurnId() public {
        vm.prank(alice);
        token.approve(address(burner), 10e18);

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
        vm.prank(alice);
        token.approve(address(burner), 2e18);
        vm.prank(bob);
        token.approve(address(burner), 1e18);

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
        vm.prank(bob);
        token.approve(address(burner), 5e18);

        vm.expectEmit(address(burner));
        emit BurnStandIn.Migrated(_id(0, bob, dest, 5e18), 0, bob, dest, 5e18);
        vm.prank(bob);
        burner.migrate(5e18, dest);
        assertEq(token.balanceOf(alice), 1_000e18, "alice untouched");
        assertEq(token.balanceOf(bob), 995e18);
    }

    function test_Migrate_WithoutAllowanceReverts() public {
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
        // Signed for 8e18, called with 7e18: the token recovers a different signer.
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(alicePk, alice, address(burner), 8e18, deadline);
        vm.prank(alice);
        vm.expectRevert();
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

    // ── The revert list ──

    function test_Revert_BeforeOpened() public {
        burner.setOpened(false);
        vm.prank(alice);
        vm.expectRevert(BurnStandIn.NotOpened.selector);
        burner.migrate(1e18, dest);
    }

    function test_Revert_AfterCloseAt() public {
        _approve(alice, 2e18);
        vm.warp(closeAt);
        vm.prank(alice);
        burner.migrate(1e18, dest); // closeAt itself is still open

        vm.warp(closeAt + 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BurnStandIn.Closed.selector, closeAt));
        burner.migrate(1e18, dest);
    }

    function test_Revert_WhilePaused() public {
        burner.setPaused(true);
        vm.prank(alice);
        vm.expectRevert(BurnStandIn.MigrationPaused.selector);
        burner.migrate(1e18, dest);
    }

    function test_Revert_BelowTheMinimum() public {
        _approve(alice, 1e18);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BurnStandIn.AmountBelowMinimum.selector, 1e18 - 1, 1e18));
        burner.migrate(1e18 - 1, dest);

        vm.prank(alice);
        burner.migrate(1e18, dest); // exactly the minimum passes (amount >= MIN_AMOUNT)
    }

    function test_Revert_ZeroDestination() public {
        _approve(alice, 1e18);
        vm.prank(alice);
        vm.expectRevert(BurnStandIn.ZeroDestination.selector);
        burner.migrate(1e18, address(0));
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

    function test_Access_AWrongSignerOrGarbageReverts() public {
        burner.setRequireSignature(true);
        uint256 accessDeadline = block.timestamp + 1 days;
        _approve(alice, 1e18);

        bytes memory wrongKey = _signAccess(bobPk, alice, accessDeadline);
        vm.prank(alice);
        vm.expectRevert(BurnStandIn.InvalidAccessSignature.selector);
        burner.migrate(1e18, dest, accessDeadline, wrongKey);

        vm.prank(alice);
        vm.expectRevert(BurnStandIn.InvalidAccessSignature.selector);
        burner.migrate(1e18, dest, accessDeadline, hex"1234");
    }

    function test_Access_TheLongVariantsCheckTheSignatureEvenWhenNotRequired() public {
        uint256 accessDeadline = block.timestamp + 1 days;
        _approve(alice, 2e18);
        bytes memory wrongKey = _signAccess(bobPk, alice, accessDeadline);
        bytes memory rightKey = _signAccess(accessSignerPk, alice, accessDeadline);
        vm.prank(alice);
        vm.expectRevert(BurnStandIn.InvalidAccessSignature.selector);
        burner.migrate(1e18, dest, accessDeadline, wrongKey);

        vm.prank(alice);
        burner.migrate(1e18, dest, accessDeadline, rightKey);
    }

    function test_Access_TheDigestIsTheDocumentedEip712() public view {
        uint256 deadline = 1234;
        bytes32 domain = keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256("BurnStandIn"), keccak256("1"), block.chainid, address(burner))
        );
        bytes32 expected =
            keccak256(abi.encodePacked("\x19\x01", domain, keccak256(abi.encode(ACCESS_TYPEHASH, alice, deadline))));
        assertEq(burner.accessDigest(alice, deadline), expected);
    }

    // ── The test-only owner setters ──

    function test_Setters_OwnerOnlyAndEachTakesEffect() public {
        address newSigner = makeAddr("newSigner");
        burner.setPaused(true);
        burner.setRequireSignature(true);
        burner.setOpened(false);
        burner.setCloseAt(123);
        burner.setAccessSigner(newSigner);
        assertTrue(burner.paused());
        assertTrue(burner.requireSignature());
        assertFalse(burner.opened());
        assertEq(burner.closeAt(), 123);
        assertEq(burner.accessSigner(), newSigner);

        bytes memory notOwner = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice);
        vm.startPrank(alice);
        vm.expectRevert(notOwner);
        burner.setPaused(false);
        vm.expectRevert(notOwner);
        burner.setRequireSignature(false);
        vm.expectRevert(notOwner);
        burner.setOpened(true);
        vm.expectRevert(notOwner);
        burner.setCloseAt(0);
        vm.expectRevert(notOwner);
        burner.setAccessSigner(alice);
        vm.stopPrank();
    }

    function test_Constructor_RejectsAZeroToken() public {
        vm.expectRevert(BurnStandIn.ZeroAddress.selector);
        new BurnStandIn(address(0), address(this), accessSigner, closeAt);
    }

    // ── helpers ──

    function _approve(address who, uint256 amount) internal {
        vm.prank(who);
        token.approve(address(burner), amount);
    }

    function _id(uint256 seq, address from, address destination, uint256 amount) internal view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(burner), seq, from, destination, amount));
    }

    function _signAccess(uint256 pk, address account, uint256 deadline) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, burner.accessDigest(account, deadline));
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

