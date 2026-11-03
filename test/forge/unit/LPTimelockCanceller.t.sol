// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test, Vm} from "forge-std/Test.sol";
import {LPTimelock} from "../../../contracts/lp-staking/deploy/LPTimelock.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

/**
 * @notice Why this file exists: `LPTimelock` adds one thing to OpenZeppelin's `TimelockController`,
 *         a canceller role with a term written on chain (the plan of 2026-10-30, accepted by
 *         ApeBonds on 2026-11-03). REAL's Safe keeps the permanent canceller role the OZ
 *         constructor gives every proposer. Any other address reaches the role only in two steps:
 *         REAL's Safe offers it through a scheduled call of the timelock on itself, and the
 *         offered address accepts it inside a seven day window, naming the offered term.
 *
 *  The rule that carries the whole design is the cancel rule. A canceller with a term may cancel
 *  exactly the operations that were scheduled before its term end. So after the term it can still
 *  cancel what was proposed during the term, and it can never cancel an operation proposed after
 *  the term end, which includes the operation that revokes it.
 *
 *  Every revert below asserts its exact custom error with its exact arguments. A revert inside a
 *  scheduled operation surfaces at `execute`, because OpenZeppelin's `_execute` bubbles the revert
 *  data of the call it makes.
 *
 *  The cast: `real` stands for REAL's Safe (the only proposer and executor, a permanent canceller)
 *  and `ape` for ApeBonds' Safe (the appointee). The delay is the mainnet one, 48 hours. Time
 *  starts at `T0` so no timestamp in a test is ever zero, because a zero `expiresAt` or term end
 *  means "none" in the contract.
 */
contract LPTimelockCancellerTest is Test {
    LPTimelock internal timelock;

    address internal real = makeAddr("real-safe");
    address internal ape = makeAddr("apebonds-safe");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant MIN_DELAY = 2 days;
    uint32 internal constant TERM = 180;
    uint256 internal constant T0 = 1_000_000;

    bytes32 internal constant DEFAULT_ADMIN_ROLE = 0x00;
    bytes32 internal CANCELLER_ROLE;
    bytes32 internal PROPOSER_ROLE;
    bytes32 internal EXECUTOR_ROLE;

    /// @dev Counts the salts of the harmless operations, so no two of them share an id.
    uint256 internal nonce;

    // Re-declared from the contract so `vm.expectEmit` can match them.
    event CancellerOffered(address indexed account, uint32 termDays, uint64 expiresAt);
    event CancellerOfferWithdrawn(address indexed account);
    event CancellerAccepted(address indexed account, uint64 termEnd);
    event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);
    event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);

    function setUp() public {
        vm.warp(T0);
        timelock = _deploy(address(0));
        CANCELLER_ROLE = timelock.CANCELLER_ROLE();
        PROPOSER_ROLE = timelock.PROPOSER_ROLE();
        EXECUTOR_ROLE = timelock.EXECUTOR_ROLE();
    }

    // ──────────────────────── Helpers ──────────────────────────

    function _deploy(address admin) internal returns (LPTimelock) {
        address[] memory proposers = new address[](1);
        proposers[0] = real;
        address[] memory executors = new address[](1);
        executors[0] = real;
        return new LPTimelock(MIN_DELAY, proposers, executors, admin);
    }

    /// @dev Schedules a call of the timelock on itself, as REAL's Safe, with the minimum delay.
    function _scheduleSelf(bytes memory data, bytes32 salt) internal returns (bytes32 id) {
        vm.prank(real);
        timelock.schedule(address(timelock), 0, data, bytes32(0), salt, MIN_DELAY);
        id = timelock.hashOperation(address(timelock), 0, data, bytes32(0), salt);
    }

    /// @dev Executes a scheduled call of the timelock on itself, as REAL's Safe.
    function _executeSelf(bytes memory data, bytes32 salt) internal {
        vm.prank(real);
        timelock.execute(address(timelock), 0, data, bytes32(0), salt);
    }

    /// @dev Schedule, wait out the delay, execute: the whole 48 hour path of one self-call.
    function _runSelf(bytes memory data, bytes32 salt) internal {
        _scheduleSelf(data, salt);
        vm.warp(block.timestamp + MIN_DELAY);
        _executeSelf(data, salt);
    }

    /// @dev The self-call, scheduled and ready, so a test can assert the revert of its execute.
    function _readySelf(bytes memory data, bytes32 salt) internal {
        _scheduleSelf(data, salt);
        vm.warp(block.timestamp + MIN_DELAY);
    }

    function _offerData(address account, uint32 termDays) internal pure returns (bytes memory) {
        return abi.encodeCall(LPTimelock.offerCancellerRole, (account, termDays));
    }

    function _revokeData(address account) internal view returns (bytes memory) {
        return abi.encodeCall(IAccessControl.revokeRole, (CANCELLER_ROLE, account));
    }

    /// @dev Offers the role through the 48 hour path. A fresh salt per call, so an offer can repeat.
    function _offer(address account, uint32 termDays) internal {
        _runSelf(_offerData(account, termDays), keccak256(abi.encode("offer", ++nonce)));
    }

    /// @dev Offer and acceptance in one step; returns the term end the acceptance wrote.
    function _appoint(address account, uint32 termDays) internal returns (uint64 termEnd) {
        _offer(account, termDays);
        vm.prank(account);
        timelock.acceptCancellerRole(termDays);
        termEnd = timelock.cancellerTermEnd(account);
    }

    /// @dev A harmless operation (an empty call to a plain address), scheduled by REAL's Safe now.
    function _scheduleNoop(uint256 delay) internal returns (bytes32 id) {
        bytes32 salt = keccak256(abi.encode("noop", ++nonce));
        vm.prank(real);
        timelock.schedule(stranger, 0, "", bytes32(0), salt, delay);
        id = timelock.hashOperation(stranger, 0, "", bytes32(0), salt);
    }

    function _offerOf(address account) internal view returns (uint32 termDays, uint64 expiresAt) {
        (termDays, expiresAt) = timelock.cancellerOffer(account);
    }

    /// @dev The invariant of the plan: a stored term end implies the role.
    function _assertTermImpliesRole(address account) internal view {
        if (timelock.cancellerTermEnd(account) != 0) {
            assertTrue(timelock.hasRole(CANCELLER_ROLE, account), "a term end without the role");
        }
    }

    function _unauthorized(address account, bytes32 role) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, account, role);
    }

    // ──────────────────────── Deploy ───────────────────────────

    function test_Deploy_TheProposerHoldsProposerExecutorAndAPermanentCancellerRole() public view {
        assertTrue(timelock.hasRole(PROPOSER_ROLE, real), "proposer");
        assertTrue(timelock.hasRole(EXECUTOR_ROLE, real), "executor");
        assertTrue(timelock.hasRole(CANCELLER_ROLE, real), "canceller");
        assertEq(timelock.cancellerTermEnd(real), 0, "REAL's canceller role has no term");
        assertTrue(timelock.isCancellerActive(real), "a permanent canceller is always active");
    }

    function test_Deploy_OnlyTheTimelockHoldsDefaultAdmin() public view {
        assertTrue(timelock.hasRole(DEFAULT_ADMIN_ROLE, address(timelock)), "the timelock is its own admin");
        assertFalse(timelock.hasRole(DEFAULT_ADMIN_ROLE, real), "REAL's Safe is not admin");
        assertFalse(timelock.hasRole(DEFAULT_ADMIN_ROLE, address(this)), "the deployer is not admin");
    }

    function test_Deploy_TheCancellerRoleIsAdministeredByDefaultAdmin() public view {
        assertEq(timelock.getRoleAdmin(CANCELLER_ROLE), DEFAULT_ADMIN_ROLE);
    }

    function test_Deploy_TheConstantsAreTheDecidedOnes() public view {
        assertEq(timelock.MAX_CANCELLER_TERM_DAYS(), 180, "term cap 180 days");
        assertEq(timelock.CANCELLER_OFFER_WINDOW(), 7 days, "offer window 7 days");
        assertEq(timelock.getMinDelay(), MIN_DELAY);
    }

    function test_Deploy_RejectsANonZeroBootstrapAdmin() public {
        address[] memory proposers = new address[](1);
        proposers[0] = real;
        vm.expectRevert(abi.encodeWithSelector(LPTimelock.BootstrapAdminNotAllowed.selector, stranger));
        new LPTimelock(MIN_DELAY, proposers, proposers, stranger);
    }

    // ──────────────────────── Offer ────────────────────────────

    function test_Offer_ADirectCallByTheProposerReverts() public {
        vm.prank(real);
        vm.expectRevert(_unauthorized(real, DEFAULT_ADMIN_ROLE));
        timelock.offerCancellerRole(ape, TERM);
    }

    function test_Offer_ThroughScheduleAndExecuteStoresTheOfferAndGrantsNothing() public {
        bytes memory data = _offerData(ape, TERM);
        _readySelf(data, "offer");
        uint64 expected = uint64(block.timestamp + 7 days);

        vm.expectEmit(address(timelock));
        emit CancellerOffered(ape, TERM, expected);
        _executeSelf(data, "offer");

        (uint32 termDays, uint64 expiresAt) = _offerOf(ape);
        assertEq(termDays, TERM, "termDays");
        assertEq(expiresAt, expected, "expiresAt = execution time + 7 days");
        assertFalse(timelock.hasRole(CANCELLER_ROLE, ape), "an offer grants no role");
        assertEq(timelock.cancellerTermEnd(ape), 0, "and writes no term end");
    }

    function test_Offer_TermZeroRevertsAtExecute() public {
        _readySelf(_offerData(ape, 0), "zero");
        vm.expectRevert(abi.encodeWithSelector(LPTimelock.CancellerTermOutOfBounds.selector, uint32(0)));
        _executeSelf(_offerData(ape, 0), "zero");
    }

    function test_Offer_Term181RevertsAtExecute() public {
        _readySelf(_offerData(ape, 181), "181");
        vm.expectRevert(abi.encodeWithSelector(LPTimelock.CancellerTermOutOfBounds.selector, uint32(181)));
        _executeSelf(_offerData(ape, 181), "181");
    }

    function test_Offer_TermsOneAndOneHundredEightyPass() public {
        _offer(ape, 1);
        (uint32 one,) = _offerOf(ape);
        assertEq(one, 1, "the shortest term");

        _offer(ape, 180);
        (uint32 max,) = _offerOf(ape);
        assertEq(max, 180, "the longest term, overwriting the first offer");
    }

    function testFuzz_Offer_EveryTermOutsideOneTo180Reverts(uint32 termDays) public {
        bytes memory data = _offerData(ape, termDays);
        _readySelf(data, "fuzz");
        if (termDays == 0 || termDays > 180) {
            vm.expectRevert(abi.encodeWithSelector(LPTimelock.CancellerTermOutOfBounds.selector, termDays));
        }
        _executeSelf(data, "fuzz");
    }

    function test_Offer_RejectsTheZeroAddress() public {
        _readySelf(_offerData(address(0), TERM), "zero-address");
        vm.expectRevert(abi.encodeWithSelector(LPTimelock.InvalidCancellerAccount.selector, address(0)));
        _executeSelf(_offerData(address(0), TERM), "zero-address");
    }

    function test_Offer_RejectsTheTimelockItself() public {
        _readySelf(_offerData(address(timelock), TERM), "self");
        vm.expectRevert(abi.encodeWithSelector(LPTimelock.InvalidCancellerAccount.selector, address(timelock)));
        _executeSelf(_offerData(address(timelock), TERM), "self");
    }

    function test_Offer_RejectsREALsPermanentCanceller() public {
        _readySelf(_offerData(real, TERM), "real");
        vm.expectRevert(abi.encodeWithSelector(LPTimelock.InvalidCancellerAccount.selector, real));
        _executeSelf(_offerData(real, TERM), "real");
    }

    function test_Offer_APendingOfferOperationIsCancelledByREAL() public {
        bytes32 id = _scheduleSelf(_offerData(ape, TERM), "offer");
        vm.prank(real);
        timelock.cancel(id);
        assertFalse(timelock.isOperation(id), "the offer never executes");
    }

    // ──────────────────────── Accept ───────────────────────────

    function test_Accept_ANonOfferedAddressReverts() public {
        _offer(ape, TERM);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(LPTimelock.NoCancellerOffer.selector, stranger));
        timelock.acceptCancellerRole(TERM);
    }

    function test_Accept_AWrongTermReverts() public {
        _offer(ape, TERM);
        vm.prank(ape);
        vm.expectRevert(abi.encodeWithSelector(LPTimelock.CancellerTermMismatch.selector, TERM, uint32(90)));
        timelock.acceptCancellerRole(90);
    }

    function test_Accept_PassesOneSecondBeforeTheOfferExpires() public {
        _offer(ape, TERM);
        (, uint64 expiresAt) = _offerOf(ape);
        vm.warp(expiresAt - 1);
        vm.prank(ape);
        timelock.acceptCancellerRole(TERM);
        assertTrue(timelock.hasRole(CANCELLER_ROLE, ape));
    }

    function test_Accept_RevertsAtTheExpiryInstant() public {
        _offer(ape, TERM);
        (, uint64 expiresAt) = _offerOf(ape);
        vm.warp(expiresAt);
        vm.prank(ape);
        vm.expectRevert(abi.encodeWithSelector(LPTimelock.CancellerOfferExpired.selector, ape, expiresAt));
        timelock.acceptCancellerRole(TERM);
    }

    function test_Accept_WritesTheTermEndGrantsTheRoleAndDeletesTheOffer() public {
        _offer(ape, TERM);
        vm.warp(block.timestamp + 3 days);
        uint64 expectedEnd = uint64(block.timestamp + uint256(TERM) * 1 days);

        vm.expectEmit(address(timelock));
        emit RoleGranted(CANCELLER_ROLE, ape, ape);
        vm.expectEmit(address(timelock));
        emit CancellerAccepted(ape, expectedEnd);
        vm.prank(ape);
        timelock.acceptCancellerRole(TERM);

        assertTrue(timelock.hasRole(CANCELLER_ROLE, ape), "the role");
        assertEq(timelock.cancellerTermEnd(ape), expectedEnd, "term end = acceptance time + days * 1 days");
        (uint32 termDays, uint64 expiresAt) = _offerOf(ape);
        assertEq(termDays, 0, "the offer is deleted");
        assertEq(expiresAt, 0, "the offer is deleted");
        _assertTermImpliesRole(ape);

        vm.prank(ape);
        vm.expectRevert(abi.encodeWithSelector(LPTimelock.NoCancellerOffer.selector, ape));
        timelock.acceptCancellerRole(TERM);
    }

    function test_Accept_ARenewalEmitsNoRoleGranted() public {
        _appoint(ape, TERM);
        _offer(ape, TERM);

        vm.recordLogs();
        vm.prank(ape);
        timelock.acceptCancellerRole(TERM);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 1, "only CancellerAccepted");
        assertEq(logs[0].topics[0], CancellerAccepted.selector, "no RoleGranted on a renewal");
    }

    function test_Accept_AfterAnOfferOverwriteTheOldTermReverts() public {
        _offer(ape, TERM);
        _offer(ape, 90);

        vm.prank(ape);
        vm.expectRevert(abi.encodeWithSelector(LPTimelock.CancellerTermMismatch.selector, uint32(90), TERM));
        timelock.acceptCancellerRole(TERM);

        vm.prank(ape);
        timelock.acceptCancellerRole(90);
        assertEq(timelock.cancellerTermEnd(ape), block.timestamp + 90 days);
    }

    // ──────────────────────── Withdraw ─────────────────────────

    function test_Withdraw_ThroughAnOperationDeletesTheOffer() public {
        _offer(ape, TERM);
        bytes memory data = abi.encodeCall(LPTimelock.withdrawCancellerOffer, (ape));
        _readySelf(data, "withdraw");

        vm.expectEmit(address(timelock));
        emit CancellerOfferWithdrawn(ape);
        _executeSelf(data, "withdraw");

        (uint32 termDays, uint64 expiresAt) = _offerOf(ape);
        assertEq(termDays, 0);
        assertEq(expiresAt, 0);
    }

    function test_Withdraw_AWithdrawnOfferCannotBeAccepted() public {
        _offer(ape, TERM);
        _runSelf(abi.encodeCall(LPTimelock.withdrawCancellerOffer, (ape)), "withdraw");

        vm.prank(ape);
        vm.expectRevert(abi.encodeWithSelector(LPTimelock.NoCancellerOffer.selector, ape));
        timelock.acceptCancellerRole(TERM);
    }

    function test_Withdraw_AMissingOfferReverts() public {
        bytes memory data = abi.encodeCall(LPTimelock.withdrawCancellerOffer, (ape));
        _readySelf(data, "withdraw");
        vm.expectRevert(abi.encodeWithSelector(LPTimelock.NoCancellerOffer.selector, ape));
        _executeSelf(data, "withdraw");
    }

    function test_Withdraw_ADirectCallByTheProposerReverts() public {
        _offer(ape, TERM);
        vm.prank(real);
        vm.expectRevert(_unauthorized(real, DEFAULT_ADMIN_ROLE));
        timelock.withdrawCancellerOffer(ape);
    }

    // ──────────────────────── Cancel ───────────────────────────

    function test_Cancel_ATermCancellerCancelsAnOperationScheduledDuringItsTerm() public {
        _appoint(ape, TERM);
        bytes32 id = _scheduleNoop(MIN_DELAY);

        vm.prank(ape);
        timelock.cancel(id);
        assertFalse(timelock.isOperation(id));
    }

    /// @dev Krum's P6: an operation proposed inside the term keeps its full veto window.
    function test_Cancel_AfterTheTermItStillCancelsOneScheduledAtTermEndMinusOne() public {
        uint64 termEnd = _appoint(ape, TERM);
        vm.warp(termEnd - 1);
        bytes32 id = _scheduleNoop(MIN_DELAY);
        vm.warp(termEnd + 1 hours);

        assertFalse(timelock.isCancellerActive(ape), "the term is over");
        vm.prank(ape);
        timelock.cancel(id);
        assertFalse(timelock.isOperation(id));
    }

    function test_Cancel_OneScheduledAtTermEndReverts() public {
        uint64 termEnd = _appoint(ape, TERM);
        vm.warp(termEnd);
        bytes32 id = _scheduleNoop(MIN_DELAY);

        vm.prank(ape);
        vm.expectRevert(abi.encodeWithSelector(LPTimelock.CancellerTermEnded.selector, ape, termEnd, id));
        timelock.cancel(id);
        assertTrue(timelock.isOperationPending(id));
    }

    function test_Cancel_REALCancelsAnything() public {
        uint64 termEnd = _appoint(ape, TERM);
        bytes32 during = _scheduleNoop(MIN_DELAY);
        vm.warp(termEnd + 10 days);
        bytes32 after_ = _scheduleNoop(MIN_DELAY);

        vm.startPrank(real);
        timelock.cancel(during);
        timelock.cancel(after_);
        vm.stopPrank();
        assertFalse(timelock.isOperation(during));
        assertFalse(timelock.isOperation(after_));
    }

    function test_Cancel_AfterRevocationTheCancellerCannotCancel() public {
        uint64 termEnd = _appoint(ape, TERM);
        vm.warp(termEnd);
        _runSelf(_revokeData(ape), "revoke");
        bytes32 id = _scheduleNoop(MIN_DELAY);

        vm.prank(ape);
        vm.expectRevert(_unauthorized(ape, CANCELLER_ROLE));
        timelock.cancel(id);
    }

    function test_Cancel_AStrangerReverts() public {
        bytes32 id = _scheduleNoop(MIN_DELAY);
        vm.prank(stranger);
        vm.expectRevert(_unauthorized(stranger, CANCELLER_ROLE));
        timelock.cancel(id);
    }

    // ──────────────────────── Revoke ───────────────────────────

    function test_Revoke_DuringTheTermRevertsAtExecute() public {
        uint64 termEnd = _appoint(ape, TERM);
        _readySelf(_revokeData(ape), "revoke");

        vm.expectRevert(abi.encodeWithSelector(LPTimelock.CancellerTermActive.selector, ape, termEnd));
        _executeSelf(_revokeData(ape), "revoke");
        assertTrue(timelock.hasRole(CANCELLER_ROLE, ape));
    }

    function test_Revoke_ScheduledAfterTheTermCannotBeCancelledByApeAndExecutes() public {
        uint64 termEnd = _appoint(ape, TERM);
        vm.warp(termEnd + 1);
        bytes32 id = _scheduleSelf(_revokeData(ape), "revoke");

        vm.prank(ape);
        vm.expectRevert(abi.encodeWithSelector(LPTimelock.CancellerTermEnded.selector, ape, termEnd, id));
        timelock.cancel(id);

        vm.warp(block.timestamp + MIN_DELAY);
        vm.expectEmit(address(timelock));
        emit RoleRevoked(CANCELLER_ROLE, ape, address(timelock));
        _executeSelf(_revokeData(ape), "revoke");

        assertFalse(timelock.hasRole(CANCELLER_ROLE, ape), "revoked");
        assertEq(timelock.cancellerTermEnd(ape), 0, "the term end is cleared");
    }

    function test_Revoke_ScheduledDuringTheTermCanBeCancelledByApeEvenAfterTheTerm() public {
        uint64 termEnd = _appoint(ape, TERM);
        vm.warp(termEnd - 1 days);
        bytes32 id = _scheduleSelf(_revokeData(ape), "revoke");
        vm.warp(termEnd + 1 days);

        vm.prank(ape);
        timelock.cancel(id);
        assertFalse(timelock.isOperation(id));
        assertTrue(timelock.hasRole(CANCELLER_ROLE, ape));
    }

    /// @dev Krum's P1: an offer made on day 170, never accepted, dies with the revocation after
    ///      the term. The acceptance reverts `NoCancellerOffer`, not `CancellerOfferExpired`, which
    ///      proves the offer was deleted rather than merely left to expire.
    function test_Revoke_ClearsTheTermEndAndDeletesThePendingOffer() public {
        uint64 termEnd = _appoint(ape, TERM);
        // Day 0 is the acceptance, derived from the stored term end: a local copy of
        // `block.timestamp` is re-read after `vm.warp` in the `--ir-minimum` coverage build.
        uint256 day0 = termEnd - 180 days;

        vm.warp(day0 + 168 days);
        _offer(ape, TERM); // executed on day 170
        (, uint64 expiresAt) = _offerOf(ape);
        assertEq(expiresAt, day0 + 177 days, "the window closes on day 177");

        vm.warp(termEnd + 1 days); // day 181
        _runSelf(_revokeData(ape), "revoke"); // executed on day 183

        assertFalse(timelock.hasRole(CANCELLER_ROLE, ape));
        assertEq(timelock.cancellerTermEnd(ape), 0, "term end cleared");
        (uint32 termDays, uint64 left) = _offerOf(ape);
        assertEq(termDays, 0, "offer deleted");
        assertEq(left, 0, "offer deleted");

        vm.prank(ape);
        vm.expectRevert(abi.encodeWithSelector(LPTimelock.NoCancellerOffer.selector, ape));
        timelock.acceptCancellerRole(TERM);
    }

    function test_Revoke_DeletesAnOpenOfferInsideItsWindowToo() public {
        uint64 termEnd = _appoint(ape, TERM);
        vm.warp(termEnd);
        _offer(ape, TERM);
        _runSelf(_revokeData(ape), "revoke");

        vm.prank(ape);
        vm.expectRevert(abi.encodeWithSelector(LPTimelock.NoCancellerOffer.selector, ape));
        timelock.acceptCancellerRole(TERM);
    }

    function test_Revoke_OtherRolesAreRevokedAsInOpenZeppelin() public {
        _runSelf(abi.encodeCall(IAccessControl.grantRole, (PROPOSER_ROLE, stranger)), "grant");
        assertTrue(timelock.hasRole(PROPOSER_ROLE, stranger));
        _runSelf(abi.encodeCall(IAccessControl.revokeRole, (PROPOSER_ROLE, stranger)), "revoke");
        assertFalse(timelock.hasRole(PROPOSER_ROLE, stranger));
    }

    // ──────────────────────── Renounce ─────────────────────────

    function test_Renounce_DuringTheTermClearsTheTermEndAndDeletesTheOffer() public {
        _appoint(ape, TERM);
        _offer(ape, TERM); // a renewal offer, not accepted
        assertTrue(timelock.isCancellerActive(ape), "inside the term");

        vm.expectEmit(address(timelock));
        emit RoleRevoked(CANCELLER_ROLE, ape, ape);
        vm.prank(ape);
        timelock.renounceRole(CANCELLER_ROLE, ape);

        assertFalse(timelock.hasRole(CANCELLER_ROLE, ape));
        assertEq(timelock.cancellerTermEnd(ape), 0, "term end cleared");
        (uint32 termDays, uint64 expiresAt) = _offerOf(ape);
        assertEq(termDays, 0, "offer deleted");
        assertEq(expiresAt, 0, "offer deleted");
    }

    // ──────────────────────── grantRole ────────────────────────

    function test_GrantRole_TheCancellerRoleThroughAnOperationReverts() public {
        bytes memory data = abi.encodeCall(IAccessControl.grantRole, (CANCELLER_ROLE, ape));
        _readySelf(data, "grant");
        vm.expectRevert(LPTimelock.CancellerGrantOnlyByAcceptance.selector);
        _executeSelf(data, "grant");
        assertFalse(timelock.hasRole(CANCELLER_ROLE, ape));
    }

    function test_GrantRole_TheCancellerRoleDirectlyRevertsForEveryone() public {
        vm.prank(real);
        vm.expectRevert(LPTimelock.CancellerGrantOnlyByAcceptance.selector);
        timelock.grantRole(CANCELLER_ROLE, ape);

        vm.prank(address(timelock));
        vm.expectRevert(LPTimelock.CancellerGrantOnlyByAcceptance.selector);
        timelock.grantRole(CANCELLER_ROLE, ape);
    }

    function test_GrantRole_OtherRolesStillNeedTheAdmin() public {
        vm.prank(real);
        vm.expectRevert(_unauthorized(real, DEFAULT_ADMIN_ROLE));
        timelock.grantRole(PROPOSER_ROLE, stranger);
    }

    // ──────────────────────── Renewal ──────────────────────────

    function test_Renewal_ResetsTheTermEndToAcceptanceTimePlusTheNewTerm() public {
        uint64 first = _appoint(ape, TERM);
        uint256 day0 = first - 180 days; // the first acceptance is day 0

        vm.warp(day0 + 163 days);
        _offer(ape, TERM); // executed on day 165
        vm.warp(day0 + 170 days);
        vm.prank(ape);
        timelock.acceptCancellerRole(TERM);

        assertEq(timelock.cancellerTermEnd(ape), day0 + 350 days, "day 170 + 180 = day 350");
    }

    function test_Renewal_ResetsEvenWhenTheNewEndIsEarlier() public {
        uint256 day0 = T0; // a constant, not a copy of `block.timestamp`, for the coverage build
        _appoint(ape, TERM);
        vm.warp(day0 + 8 days);
        _offer(ape, 1); // executed on day 10
        vm.prank(ape);
        timelock.acceptCancellerRole(1);

        assertEq(timelock.cancellerTermEnd(ape), day0 + 11 days, "day 10 + 1 = day 11, before day 180");
        _assertTermImpliesRole(ape);
    }

    /// @dev Decision 9c: an operation scheduled in a gap between a term end and a later
    ///      re-acceptance, and still pending at that acceptance, becomes cancellable again.
    function test_Renewal_OperationsScheduledInAGapBecomeCancellable() public {
        uint64 termEnd = _appoint(ape, TERM);
        vm.warp(termEnd + 5 days);
        bytes32 gap = _scheduleNoop(30 days);

        vm.prank(ape);
        vm.expectRevert(abi.encodeWithSelector(LPTimelock.CancellerTermEnded.selector, ape, termEnd, gap));
        timelock.cancel(gap);
        assertFalse(timelock.canCancel(ape, gap));

        _appoint(ape, TERM);
        assertTrue(timelock.canCancel(ape, gap), "scheduled before the new term end");
        vm.prank(ape);
        timelock.cancel(gap);
        assertFalse(timelock.isOperation(gap));
    }

    // ──────────────────────── scheduledAt ──────────────────────

    function test_ScheduledAt_ScheduleRecordsTheBlockTime() public {
        vm.warp(T0 + 12345);
        bytes32 id = _scheduleNoop(MIN_DELAY);
        assertEq(timelock.scheduledAt(id), T0 + 12345);
    }

    function test_ScheduledAt_ScheduleBatchRecordsTheBlockTime() public {
        address[] memory targets = new address[](2);
        targets[0] = stranger;
        targets[1] = address(timelock);
        uint256[] memory values = new uint256[](2);
        bytes[] memory payloads = new bytes[](2);
        payloads[1] = _offerData(ape, TERM);

        vm.warp(T0 + 777);
        vm.prank(real);
        timelock.scheduleBatch(targets, values, payloads, bytes32(0), "batch", MIN_DELAY);
        bytes32 id = timelock.hashOperationBatch(targets, values, payloads, bytes32(0), "batch");

        assertEq(timelock.scheduledAt(id), T0 + 777);
        assertTrue(timelock.canCancel(real, id));
    }

    function test_ScheduledAt_SchedulingAgainAfterACancelOverwritesIt() public {
        bytes32 salt = "again";
        vm.prank(real);
        timelock.schedule(stranger, 0, "", bytes32(0), salt, MIN_DELAY);
        bytes32 id = timelock.hashOperation(stranger, 0, "", bytes32(0), salt);
        assertEq(timelock.scheduledAt(id), T0);

        vm.prank(real);
        timelock.cancel(id);
        vm.warp(T0 + 50 days);
        vm.prank(real);
        timelock.schedule(stranger, 0, "", bytes32(0), salt, MIN_DELAY);
        assertEq(timelock.scheduledAt(id), T0 + 50 days, "the second schedule overwrites the first");
    }

    function test_ScheduledAt_AnUnknownIdReadsZero() public view {
        assertEq(timelock.scheduledAt(keccak256("never")), 0);
    }

    // ──────────────────────── Views ────────────────────────────

    function test_IsCancellerActive_FollowsTheRoleAndTheTerm() public {
        assertFalse(timelock.isCancellerActive(ape), "no role");
        assertTrue(timelock.isCancellerActive(real), "permanent");

        uint64 termEnd = _appoint(ape, TERM);
        assertTrue(timelock.isCancellerActive(ape), "inside the term");
        vm.warp(termEnd - 1);
        assertTrue(timelock.isCancellerActive(ape), "one second before the end");
        vm.warp(termEnd);
        assertFalse(timelock.isCancellerActive(ape), "at the end");
        assertTrue(timelock.hasRole(CANCELLER_ROLE, ape), "the role stays on chain after the term");

        _runSelf(_revokeData(ape), "revoke");
        assertFalse(timelock.isCancellerActive(ape), "revoked");
    }

    function test_CanCancel_AnswersWhatCancelWouldDo() public {
        bytes32 before = _scheduleNoop(MIN_DELAY);
        assertFalse(timelock.canCancel(ape, before), "no role yet");
        assertTrue(timelock.canCancel(real, before), "REAL, a pending id");
        assertFalse(timelock.canCancel(real, keccak256("never")), "an id that does not exist");

        uint64 termEnd = _appoint(ape, TERM);
        assertTrue(timelock.canCancel(ape, before), "scheduled before the term end");

        vm.warp(termEnd);
        bytes32 atEnd = _scheduleNoop(MIN_DELAY);
        assertFalse(timelock.canCancel(ape, atEnd), "scheduled at the term end");
        assertTrue(timelock.canCancel(real, atEnd), "REAL cancels anything pending");

        vm.warp(block.timestamp + MIN_DELAY);
        vm.prank(real);
        timelock.execute(stranger, 0, "", bytes32(0), keccak256(abi.encode("noop", nonce)));
        assertFalse(timelock.canCancel(real, atEnd), "a done operation is not pending");
    }

    // ──────────────────────── REAL's permanent role ────────────

    function test_RealPermanentRole_CanBeRevokedThroughAnOperationAtAnyTime() public {
        _appoint(ape, TERM); // an active term canceller does not shield REAL's role
        _runSelf(_revokeData(real), "revoke-real");

        assertFalse(timelock.hasRole(CANCELLER_ROLE, real));
        bytes32 id = _scheduleNoop(MIN_DELAY);
        vm.prank(real);
        vm.expectRevert(_unauthorized(real, CANCELLER_ROLE));
        timelock.cancel(id);
    }

    function test_RealPermanentRole_REALCanRenounceIt() public {
        vm.prank(real);
        timelock.renounceRole(CANCELLER_ROLE, real);
        assertFalse(timelock.hasRole(CANCELLER_ROLE, real));
        assertTrue(timelock.hasRole(PROPOSER_ROLE, real), "the other roles stay");
    }
}
