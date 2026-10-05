// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {LocalHarness} from "../utils/LocalHarness.sol";
import {RewardsDistributor} from "../../../contracts/lp-staking/RewardsDistributor.sol";
import {IRewardsDistributor} from "../../../contracts/lp-staking/interfaces/IRewardsDistributor.sol";
import {TokenOverture} from "../../../contracts/lp-staking/TokenOverture.sol";
import {MockERC20Permit} from "../../../contracts/lp-staking/mocks/MockERC20Permit.sol";

/**
 * @notice Bounded actor driving {RewardsDistributor} across THREE registered reward tokens
 *         ($ASSET, $OVTR, and a third token added through `addRewardToken`) for four users,
 *         interleaved with every way a claim is supposed to be refused — a stale voucher, a
 *         voucher with an expired deadline, a voucher for another token, another user's voucher,
 *         a voucher from a foreign key, a paused contract, a token whose claims are closed, and a
 *         token that was never registered — and with the treasury moves that change the balance
 *         under the claims: funding, `recoverExcess`, and time passing.
 *
 *  Refusals are not asserted inside the handler (a revert there would be swallowed by the
 *  campaign). Each is recorded as a ghost FLAG, and the flags are the invariants' teeth.
 *
 *  Every payment is accounted three independent ways, per token: the amount `claim` RETURNED,
 *  the `paidAmount` of every `Claimed` log the call emitted (read with `vm.recordLogs`), and the
 *  balance that left the distributor. The invariant that ties them together is stated against
 *  what was FUNDED and RECOVERED, never against a running total the contract keeps — the
 *  contract keeps none.
 */
contract ClaimLedgerHandler is Test {
    RewardsDistributor internal immutable distributor;
    /// @dev The test contract: owner, operator, guardian, $OVTR minter, and holder of the supplies.
    address internal immutable admin;
    uint256 internal immutable signerPk;
    uint256 internal immutable foreignPk;
    bytes32 internal immutable domainSeparator;
    /// @dev Funded into the distributor, never registered.
    address internal immutable unregistered;

    address[] internal actors;
    address[] internal tokens;

    /// @dev Cumulative figure signed so far, per token and actor.
    mapping(address => mapping(address => uint256)) public entitlement;
    /// @dev Last ledger value observed, per token and actor — the monotonicity witness.
    mapping(address => mapping(address => uint256)) internal lastLedger;
    /// @dev The handler's mirror of each token's claim switch.
    mapping(address => bool) public claimsOpen;

    // ──────────────────────── Ghosts ───────────────────────────

    uint256 public calls;
    mapping(address => uint256) public paidByReturn;
    mapping(address => uint256) public paidByEvents;
    mapping(address => uint256) public funded;
    mapping(address => uint256) public recovered;

    bool public ledgerEverWentBackwards;
    bool public staleVoucherEverPaid;
    bool public expiredVoucherEverPaid;
    bool public foreignVoucherEverPaid;
    bool public crossTokenEverMoved;
    bool public thirdPartyEverPaid;
    bool public pausedClaimEverPaid;
    bool public closedTokenEverPaid;
    bool public unregisteredEverPaid;
    bool public foreignEmitterOrUserSeen;

    uint256 internal constant FAR_DEADLINE = 10 ** 12;
    uint256 internal constant MAX_DELTA = 1e18;
    uint256 internal constant MAX_FUND = 1_000e18;
    bytes32 internal constant CLAIMED_TOPIC = keccak256("Claimed(address,address,uint256,uint256,uint256)");
    bytes32 internal constant REWARD_CLAIM_TYPEHASH =
        keccak256("RewardClaim(address token,address user,uint256 cumulativeAmount,uint256 deadline)");

    constructor(
        RewardsDistributor _distributor,
        address _admin,
        uint256 _signerPk,
        uint256 _foreignPk,
        bytes32 _domainSeparator,
        address _unregistered,
        address[] memory _actors,
        address[] memory _tokens
    ) {
        distributor = _distributor;
        admin = _admin;
        signerPk = _signerPk;
        foreignPk = _foreignPk;
        domainSeparator = _domainSeparator;
        unregistered = _unregistered;
        actors = _actors;
        tokens = _tokens;
        for (uint256 i = 0; i < _tokens.length; ++i) {
            claimsOpen[_tokens[i]] = true;
            funded[_tokens[i]] = MockERC20Permit(_tokens[i]).balanceOf(address(_distributor));
        }
    }

    // ──────────────────────── Actions ──────────────────────────

    function claim(uint256 tokenSeed, uint256 actorSeed, uint256 deltaSeed) external {
        calls++;
        _prime();
        _claimFor(_token(tokenSeed), _actor(actorSeed), bound(deltaSeed, 1, MAX_DELTA));
        _observeLedgers();
    }

    /// @dev Re-presents the cumulative figure the actor has already been paid for.
    function replayStaleVoucher(uint256 tokenSeed, uint256 actorSeed) external {
        calls++;
        _prime();
        address token = _token(tokenSeed);
        address actor = _actor(actorSeed);
        uint256 cumulative = entitlement[token][actor];
        if (cumulative == 0) return;

        (bool paid,) =
            _attempt(token, actor, cumulative, FAR_DEADLINE, _sign(signerPk, token, actor, cumulative, FAR_DEADLINE));
        if (paid) staleVoucherEverPaid = true;
        _observeLedgers();
    }

    /// @dev A fresh voucher whose deadline is already behind the chain's clock.
    function expiredVoucherAttempt(uint256 tokenSeed, uint256 actorSeed, uint256 deltaSeed) external {
        calls++;
        _prime();
        address token = _token(tokenSeed);
        address actor = _actor(actorSeed);
        uint256 cumulative = entitlement[token][actor] + bound(deltaSeed, 1, MAX_DELTA);
        uint256 deadline = block.timestamp - 1;

        (bool paid,) = _attempt(token, actor, cumulative, deadline, _sign(signerPk, token, actor, cumulative, deadline));
        if (paid) {
            expiredVoucherEverPaid = true;
            entitlement[token][actor] = cumulative;
        }
        _observeLedgers();
    }

    /// @dev A voucher signed by a key the distributor has never been told about.
    function foreignVoucherAttempt(uint256 tokenSeed, uint256 actorSeed, uint256 deltaSeed) external {
        calls++;
        _prime();
        address token = _token(tokenSeed);
        address actor = _actor(actorSeed);
        uint256 cumulative = entitlement[token][actor] + bound(deltaSeed, 1, MAX_DELTA);

        (bool paid,) =
            _attempt(token, actor, cumulative, FAR_DEADLINE, _sign(foreignPk, token, actor, cumulative, FAR_DEADLINE));
        if (paid) {
            foreignVoucherEverPaid = true;
            entitlement[token][actor] = cumulative;
        }
        _observeLedgers();
    }

    /// @dev A valid voucher for token A presented for token B. Token B's ledger and token B's
    ///      balances (the distributor's and the actor's) must not move.
    function crossTokenAttempt(uint256 fromSeed, uint256 toSeed, uint256 actorSeed, uint256 deltaSeed) external {
        calls++;
        _prime();
        address tokenA = _token(fromSeed);
        address tokenB = _token(toSeed);
        if (tokenA == tokenB) return;
        address actor = _actor(actorSeed);
        uint256 cumulative = entitlement[tokenB][actor] + bound(deltaSeed, 1, MAX_DELTA);

        uint256 ledgerB = distributor.claimed(tokenB, actor);
        uint256 floatB = MockERC20Permit(tokenB).balanceOf(address(distributor));
        uint256 actorB = MockERC20Permit(tokenB).balanceOf(actor);

        (bool paid,) =
            _attempt(tokenB, actor, cumulative, FAR_DEADLINE, _sign(signerPk, tokenA, actor, cumulative, FAR_DEADLINE));
        if (
            paid || distributor.claimed(tokenB, actor) != ledgerB
                || MockERC20Permit(tokenB).balanceOf(address(distributor)) != floatB
                || MockERC20Permit(tokenB).balanceOf(actor) != actorB
        ) {
            crossTokenEverMoved = true;
        }
        _observeLedgers();
    }

    /// @dev Actor X presents actor Y's valid voucher.
    function thirdPartyAttempt(uint256 tokenSeed, uint256 ownerSeed, uint256 thiefSeed, uint256 deltaSeed) external {
        calls++;
        _prime();
        address token = _token(tokenSeed);
        address owner_ = _actor(ownerSeed);
        address thief = _actor(thiefSeed);
        if (owner_ == thief) return;
        uint256 cumulative = entitlement[token][owner_] + bound(deltaSeed, 1, MAX_DELTA);

        (bool paid,) =
            _attempt(token, thief, cumulative, FAR_DEADLINE, _sign(signerPk, token, owner_, cumulative, FAR_DEADLINE));
        if (paid) thirdPartyEverPaid = true;
        _observeLedgers();
    }

    /// @dev Pauses, tries a perfectly valid fresh voucher, then unpauses again.
    function pausedClaimAttempt(uint256 tokenSeed, uint256 actorSeed, uint256 deltaSeed) external {
        calls++;
        _prime();
        address token = _token(tokenSeed);
        address actor = _actor(actorSeed);
        uint256 cumulative = entitlement[token][actor] + bound(deltaSeed, 1, MAX_DELTA);
        bytes memory sig = _sign(signerPk, token, actor, cumulative, FAR_DEADLINE);

        vm.prank(admin);
        distributor.setPaused(true);
        (bool paid,) = _attempt(token, actor, cumulative, FAR_DEADLINE, sig);
        if (paid) {
            pausedClaimEverPaid = true;
            entitlement[token][actor] = cumulative;
        }
        vm.prank(admin);
        distributor.setPaused(false);
        _observeLedgers();
    }

    /// @dev Flips one token's claim switch and LEAVES it flipped: closed tokens stay closed until
    ///      a later toggle reopens them, and every claim on a closed token is watched.
    function toggleClaims(uint256 tokenSeed) external {
        calls++;
        _prime();
        address token = _token(tokenSeed);
        bool next = !claimsOpen[token];
        vm.prank(admin);
        distributor.setClaimsEnabled(token, next);
        claimsOpen[token] = next;
        _observeLedgers();
    }

    /// @dev A fully valid voucher for a token the distributor holds but never registered.
    function unregisteredClaimAttempt(uint256 actorSeed, uint256 amountSeed) external {
        calls++;
        _prime();
        address actor = _actor(actorSeed);
        uint256 cumulative = bound(amountSeed, 1, MAX_DELTA);
        (bool paid,) = _attempt(
            unregistered,
            actor,
            cumulative,
            FAR_DEADLINE,
            _sign(signerPk, unregistered, actor, cumulative, FAR_DEADLINE)
        );
        if (paid) unregisteredEverPaid = true;
        _observeLedgers();
    }

    /// @dev The company funds the distributor: $OVTR minted into it by the minter, the other
    ///      tokens transferred into it from the treasury (the test contract).
    function fund(uint256 tokenSeed, uint256 amountSeed) external {
        calls++;
        _prime();
        address token = _token(tokenSeed);
        uint256 amount = bound(amountSeed, 1, MAX_FUND);
        vm.prank(admin);
        if (token == tokens[1]) {
            TokenOverture(token).mint(address(distributor), amount);
        } else {
            MockERC20Permit(token).transfer(address(distributor), amount);
        }
        funded[token] += amount;
        _observeLedgers();
    }

    /// @dev The operator moves part of a balance out. Claims that no longer fit revert with
    ///      `InsufficientFunds` until a later `fund`.
    function recoverExcess(uint256 tokenSeed, uint256 amountSeed) external {
        calls++;
        _prime();
        address token = _token(tokenSeed);
        uint256 balance = MockERC20Permit(token).balanceOf(address(distributor));
        if (balance == 0) return;
        uint256 amount = bound(amountSeed, 1, balance);
        vm.prank(admin);
        distributor.recoverExcess(token, amount);
        recovered[token] += amount;
        _observeLedgers();
    }

    /// @dev Time passes. Vouchers carry far deadlines, so this only moves `block.timestamp` for
    ///      the expired-voucher action and the `Claimed` timestamps.
    function warp(uint256 secondsSeed) external {
        calls++;
        _prime();
        vm.warp(block.timestamp + bound(secondsSeed, 1, 30 days));
        _observeLedgers();
    }

    // ──────────────────────── Views for the invariants ─────────

    function actorList() external view returns (address[] memory) {
        return actors;
    }

    function tokenList() external view returns (address[] memory) {
        return tokens;
    }

    // ──────────────────────── Internals ────────────────────────

    /// @dev One guaranteed claim of every token on the very first action of a sequence, before
    ///      any toggle or recovery can have happened — so the anti-vacuity invariant is a hard
    ///      assertion and not a lottery.
    function _prime() private {
        for (uint256 i = 0; i < tokens.length; ++i) {
            if (paidByReturn[tokens[i]] == 0) _claimFor(tokens[i], actors[0], 1);
        }
    }

    function _claimFor(address token, address actor, uint256 delta) private {
        uint256 cumulative = entitlement[token][actor] + delta;
        (bool paid,) =
            _attempt(token, actor, cumulative, FAR_DEADLINE, _sign(signerPk, token, actor, cumulative, FAR_DEADLINE));
        if (paid) {
            entitlement[token][actor] = cumulative;
            if (!claimsOpen[token]) closedTokenEverPaid = true;
        }
    }

    /// @dev One claim, with its three accounts kept: the returned amount, the `Claimed` logs, and
    ///      the flags for the switches it must respect. Returns whether it paid.
    function _attempt(address token, address caller, uint256 cumulative, uint256 deadline, bytes memory sig)
        private
        returns (bool paid, uint256 amount)
    {
        bool wasPaused = distributor.paused();
        vm.recordLogs();
        vm.prank(caller);
        try distributor.claim(token, cumulative, deadline, sig) returns (uint256 p) {
            paid = true;
            amount = p;
            paidByReturn[token] += p;
            if (wasPaused) pausedClaimEverPaid = true;
            if (!claimsOpen[token]) closedTokenEverPaid = true;
            if (token == unregistered) unregisteredEverPaid = true;
        } catch {}
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics.length == 0 || logs[i].topics[0] != CLAIMED_TOPIC) continue;
            if (logs[i].emitter != address(distributor)) continue;
            address user = address(uint160(uint256(logs[i].topics[1])));
            address loggedToken = address(uint160(uint256(logs[i].topics[2])));
            (, uint256 paidAmount,) = abi.decode(logs[i].data, (uint256, uint256, uint256));
            paidByEvents[loggedToken] += paidAmount;
            if (user != caller || loggedToken != token) foreignEmitterOrUserSeen = true;
        }
    }

    function _observeLedgers() private {
        for (uint256 t = 0; t < tokens.length; ++t) {
            for (uint256 i = 0; i < actors.length; ++i) {
                uint256 ledger = distributor.claimed(tokens[t], actors[i]);
                if (ledger < lastLedger[tokens[t]][actors[i]]) ledgerEverWentBackwards = true;
                lastLedger[tokens[t]][actors[i]] = ledger;
            }
        }
    }

    function _token(uint256 seed) private view returns (address) {
        return tokens[bound(seed, 0, tokens.length - 1)];
    }

    function _actor(uint256 seed) private view returns (address) {
        return actors[bound(seed, 0, actors.length - 1)];
    }

    function _sign(uint256 pk, address token, address user, uint256 cumulativeAmount, uint256 deadline)
        private
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(REWARD_CLAIM_TYPEHASH, token, user, cumulativeAmount, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
}

/**
 * @notice Why this file exists: the distributor is a ledger PER TOKEN, and a ledger's correctness
 *         is a statement about HISTORY, not about any single transaction. After every possible
 *         interleaving of claims, refusals, switch flips, funding and recoveries, for EVERY
 *         registered token:
 *
 *           1. no `claimed[token][user]` ever moves backwards;
 *           2. what was paid — by the returned amounts, by the `Claimed` logs, and by the
 *              balance — is one number: Σ paid = Σ Claimed.paidAmount = funded − balance −
 *              recovered, and it equals the sum of that token's ledgers;
 *           3. tokens are isolated: a voucher for token A never moves token B's ledger or
 *              token B's balances;
 *           4. only the signed user is ever paid: each user's balance gain in a token is
 *              exactly that user's ledger in that token, and another user's voucher never pays;
 *           5. while paused nothing pays, and a token whose claims are closed never pays;
 *           6. a token that was never registered never pays, however well it is funded and
 *              however valid its voucher.
 *
 *  There is no cap anywhere to state an invariant about. The only bound is the balance, and
 *  invariant 2 is what pins it.
 */
contract ClaimLedgerInvariantsTest is LocalHarness {
    ClaimLedgerHandler internal handler;
    MockERC20Permit internal third;
    MockERC20Permit internal neverRegistered;

    address[] internal actorsAtStart;
    address[] internal tokensAtStart;
    /// @dev token => actor => balance before the campaign.
    mapping(address => mapping(address => uint256)) internal startBalance;
    uint256 internal neverRegisteredFunding;

    function setUp() public {
        _deployLocalStack();
        distributor.setClaimsEnabled(address(asset), true);

        // A third reward token, added the way the timelock adds one, and funded.
        third = new MockERC20Permit("Third", "THRD", 1e30, 18);
        distributor.addRewardToken(address(third), false, true);
        third.transfer(address(distributor), DISTRIBUTOR_FUNDING);

        // A fourth token the distributor HOLDS but never registered.
        neverRegistered = new MockERC20Permit("Never", "NVR", 1e30, 18);
        neverRegisteredFunding = 1_000_000e18;
        neverRegistered.transfer(address(distributor), neverRegisteredFunding);

        (, uint256 foreignPk) = makeAddrAndKey("foreignSigner");

        actorsAtStart.push(alice);
        actorsAtStart.push(bob);
        actorsAtStart.push(carol);
        actorsAtStart.push(stranger);
        tokensAtStart.push(address(asset));
        tokensAtStart.push(address(overture)); // index 1: the handler mints this one as the minter
        tokensAtStart.push(address(third));
        for (uint256 t = 0; t < tokensAtStart.length; ++t) {
            for (uint256 i = 0; i < actorsAtStart.length; ++i) {
                startBalance[tokensAtStart[t]][actorsAtStart[i]] =
                    MockERC20Permit(tokensAtStart[t]).balanceOf(actorsAtStart[i]);
            }
        }

        handler = new ClaimLedgerHandler(
            distributor,
            address(this),
            voucherSignerPk,
            foreignPk,
            _distributorDomainSeparator(),
            address(neverRegistered),
            actorsAtStart,
            tokensAtStart
        );

        // The handler acts as the owner, operator, guardian, $OVTR minter and treasury through
        // `vm.prank` of this contract, which holds all five roles in the local harness.
        bytes4[] memory selectors = new bytes4[](14);
        selectors[0] = ClaimLedgerHandler.claim.selector;
        selectors[1] = ClaimLedgerHandler.claim.selector; // the hot path, weighted x3
        selectors[2] = ClaimLedgerHandler.claim.selector;
        selectors[3] = ClaimLedgerHandler.replayStaleVoucher.selector;
        selectors[4] = ClaimLedgerHandler.expiredVoucherAttempt.selector;
        selectors[5] = ClaimLedgerHandler.foreignVoucherAttempt.selector;
        selectors[6] = ClaimLedgerHandler.crossTokenAttempt.selector;
        selectors[7] = ClaimLedgerHandler.thirdPartyAttempt.selector;
        selectors[8] = ClaimLedgerHandler.pausedClaimAttempt.selector;
        selectors[9] = ClaimLedgerHandler.toggleClaims.selector;
        selectors[10] = ClaimLedgerHandler.unregisteredClaimAttempt.selector;
        selectors[11] = ClaimLedgerHandler.fund.selector;
        selectors[12] = ClaimLedgerHandler.recoverExcess.selector;
        selectors[13] = ClaimLedgerHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    // ──────────────────────── 1. Monotonic ledgers ─────────────

    /// @dev A cumulative ledger that could move backwards would re-open every voucher ever signed
    ///      for that user in that token. Nothing in the contract may ever lower one.
    function invariant_1_EveryLedgerIsMonotonic() public view {
        assertFalse(handler.ledgerEverWentBackwards(), "a cumulative claim ledger moved backwards");
        assertFalse(handler.staleVoucherEverPaid(), "a voucher that had already been spent paid a second time");
        assertFalse(handler.expiredVoucherEverPaid(), "a voucher past its deadline paid");
        assertFalse(handler.foreignVoucherEverPaid(), "a voucher signed by a foreign key was honoured");
    }

    // ──────────────────────── 2. Conservation per token ────────

    /// @dev Per token: Σ returned = Σ `Claimed.paidAmount` = funded − balance − recovered = Σ ledgers.
    function invariant_2_PaidEqualsEventsEqualsFundedMinusBalanceMinusRecovered() public view {
        address[] memory tokens = handler.tokenList();
        address[] memory actors = handler.actorList();
        for (uint256 t = 0; t < tokens.length; ++t) {
            address token = tokens[t];
            uint256 byReturn = handler.paidByReturn(token);
            uint256 byEvents = handler.paidByEvents(token);
            uint256 balance = MockERC20Permit(token).balanceOf(address(distributor));
            uint256 byBalance = handler.funded(token) - balance - handler.recovered(token);

            uint256 ledgers;
            for (uint256 i = 0; i < actors.length; ++i) {
                ledgers += distributor.claimed(token, actors[i]);
            }

            assertEq(byReturn, byEvents, "the amounts claim returned equal the Claimed logs' paidAmount");
            assertEq(byEvents, byBalance, "the Claimed logs equal funded - balance - recovered");
            assertEq(byBalance, ledgers, "and equal the sum of the token's ledgers");
        }
    }

    // ──────────────────────── 3. Cross-token isolation ─────────

    /// @dev A voucher for one token never moved another token's ledger or balances, and every
    ///      `Claimed` log named the token and the caller of the claim that emitted it.
    function invariant_3_TokensAreIsolated() public view {
        assertFalse(handler.crossTokenEverMoved(), "a voucher for one token moved another token");
        assertFalse(handler.foreignEmitterOrUserSeen(), "a Claimed log named a token or user other than the claim's");
    }

    // ──────────────────────── 4. Only the signed user ──────────

    /// @dev Each user's balance gain in each token is exactly that user's ledger in that token —
    ///      so every wei a claim paid reached the user the voucher named — and a voucher in
    ///      another user's hands never paid.
    function invariant_4_OnlyTheSignedUserIsPaid() public view {
        assertFalse(handler.thirdPartyEverPaid(), "another user's voucher paid its presenter");
        address[] memory tokens = handler.tokenList();
        address[] memory actors = handler.actorList();
        for (uint256 t = 0; t < tokens.length; ++t) {
            for (uint256 i = 0; i < actors.length; ++i) {
                assertEq(
                    MockERC20Permit(tokens[t]).balanceOf(actors[i]) - startBalance[tokens[t]][actors[i]],
                    distributor.claimed(tokens[t], actors[i]),
                    "a user's balance gain equals that user's ledger, token by token"
                );
            }
        }
    }

    // ──────────────────────── 5. Switches ──────────────────────

    function invariant_5_PausedAndClosedTokensNeverPay() public view {
        assertFalse(handler.pausedClaimEverPaid(), "a claim went through while claims were paused");
        assertFalse(handler.closedTokenEverPaid(), "a token whose claims were closed paid");
    }

    // ──────────────────────── 6. Unregistered tokens ───────────

    function invariant_6_AnUnregisteredTokenNeverPays() public view {
        assertFalse(handler.unregisteredEverPaid(), "a token that was never registered paid");
        assertEq(
            neverRegistered.balanceOf(address(distributor)),
            neverRegisteredFunding,
            "the unregistered token's balance never left the distributor"
        );
        assertFalse(distributor.rewardToken(address(neverRegistered)).registered, "and it is still unregistered");
    }

    // ──────────────────────── Anti-vacuity ─────────────────────

    /**
     * @dev A precondition, not a property. Every claim above is wrapped in a `try/catch`, so a
     *      handler whose vouchers never verified would leave every invariant trivially true.
     *      Priming makes this a hard assertion: after any single action, every registered token
     *      has paid something, and its `Claimed` logs were really read.
     */
    function invariant_TheLedgersAreActuallyExercised() public view {
        if (handler.calls() == 0) return;
        address[] memory tokens = handler.tokenList();
        for (uint256 t = 0; t < tokens.length; ++t) {
            assertGt(handler.paidByReturn(tokens[t]), 0, "a registered token was never claimed: vacuous");
            assertGt(handler.paidByEvents(tokens[t]), 0, "no Claimed log was ever read: vacuous");
        }
    }
}
