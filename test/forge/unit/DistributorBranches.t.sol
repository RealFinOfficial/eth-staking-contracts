// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LocalHarness} from "../utils/LocalHarness.sol";
import {RewardsDistributor} from "../../../contracts/lp-staking/RewardsDistributor.sol";
import {IRewardsDistributor} from "../../../contracts/lp-staking/interfaces/IRewardsDistributor.sol";
import {RewardsDistributorV2Mock} from "../../../contracts/lp-staking/mocks/RewardsDistributorV2Mock.sol";
import {MockERC20Permit} from "../../../contracts/lp-staking/mocks/MockERC20Permit.sol";
import {LPProxy} from "../../../contracts/lp-staking/deploy/LPProxy.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";

/**
 * @notice Why this file exists: {RewardsDistributor} v1 is a signature verifier with a ledger
 *         PER TOKEN, and every half of it has boundaries a happy-path test never reaches — the
 *         exact order its seven gates fire in, the `<=` that separates "nothing to claim" from a
 *         one-wei increment, the `<` that separates a funded payment from {InsufficientFunds},
 *         the three distinct ways an ECDSA signature can be malformed, and the two independent
 *         switches every reward token carries. Each of those is one branch, and each is one
 *         assertion here.
 *
 *  The harness registers the launch list: $ASSET conditional with claims CLOSED (as at launch)
 *  and $OVTR (the Overture token) with claims open, both pre-funded. Tests that pay $ASSET open
 *  its claims first, exactly as the timelock will after maturity.
 */
contract DistributorBranchesTest is LocalHarness {
    uint256 internal constant AWARD = 1_000e18;
    /// @dev secp256k1 group order; `N - s` is the malleable twin of any valid signature.
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    /// @dev The ERC-7201 base the contract pins as a literal.
    bytes32 internal constant NAMESPACE = 0x111abb03172b09f746748b28040854f0c669e7caa9373080b8bbaa7c3af02e00;

    address internal ovtr;

    function setUp() public {
        _deployLocalStack();
        ovtr = address(overture);
    }

    // ──────────────────────── Implementation constructor ───────

    /// @dev A bare implementation must be inert: its initializers are burnt in its own
    ///      constructor, so nobody can take ownership of the code the proxy delegates to.
    function test_Constructor_DisablesTheImplementationsInitializers() public {
        RewardsDistributor impl = new RewardsDistributor();

        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(address(this), multisig, operatorSafe, voucherSigner, _noTokens());
    }

    /**
     * @dev v1 carries NO protocol immutables: every reward token is proxy storage. The only value
     *      baked into the runtime code is OpenZeppelin's own `UUPSUpgradeable.__self` (the
     *      implementation's address, used by `onlyProxy`). The proof: take two independently
     *      deployed implementations, substitute B's address for every copy of A's address inside
     *      A's code, and the two are byte-identical — nothing else differs, so nothing else was
     *      baked in.
     */
    function test_Constructor_BakesNothingButTheUupsSelfAddressIntoTheCode() public {
        address a = address(new RewardsDistributor());
        address b = address(new RewardsDistributor());
        bytes memory codeA = a.code;
        uint256 replaced = _replaceAddress(codeA, a, b);
        assertGt(replaced, 0, "the UUPS self-address must appear in the code");
        assertEq(keccak256(codeA), keccak256(b.code), "apart from it, two implementations are byte-identical");
    }

    // ──────────────────────── Initializer ──────────────────────

    function test_Initialize_RejectsAZeroOwner() public {
        address impl = address(new RewardsDistributor());

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new LPProxy(
            impl,
            abi.encodeCall(
                RewardsDistributor.initialize, (address(0), multisig, operatorSafe, voucherSigner, _noTokens())
            )
        );
    }

    function test_Initialize_RejectsAZeroGuardian() public {
        address impl = address(new RewardsDistributor());

        vm.expectRevert(IRewardsDistributor.ZeroAddress.selector);
        new LPProxy(
            impl,
            abi.encodeCall(
                RewardsDistributor.initialize, (address(this), address(0), operatorSafe, voucherSigner, _noTokens())
            )
        );
    }

    /// @dev The operator's zero check shares the `||` with the guardian's, so it needs its own
    ///      arm: a zero operator would leave `setSigner` and `recoverExcess` callable by nobody.
    function test_Initialize_RejectsAZeroOperator() public {
        address impl = address(new RewardsDistributor());

        vm.expectRevert(IRewardsDistributor.ZeroAddress.selector);
        new LPProxy(
            impl,
            abi.encodeCall(
                RewardsDistributor.initialize, (address(this), multisig, address(0), voucherSigner, _noTokens())
            )
        );
    }

    function test_Initialize_RejectsAZeroSigner() public {
        address impl = address(new RewardsDistributor());

        vm.expectRevert(IRewardsDistributor.ZeroAddress.selector);
        new LPProxy(
            impl,
            abi.encodeCall(
                RewardsDistributor.initialize, (address(this), multisig, operatorSafe, address(0), _noTokens())
            )
        );
    }

    /// @dev The launch list goes through the same `_addRewardToken` as the owner's later
    ///      additions, so a zero entry is refused here exactly as it is there.
    function test_Initialize_RejectsAZeroTokenInTheList() public {
        address impl = address(new RewardsDistributor());
        IRewardsDistributor.RewardTokenInit[] memory list = _launchRewardTokens(address(asset), false, address(0));

        vm.expectRevert(IRewardsDistributor.ZeroAddress.selector);
        new LPProxy(
            impl,
            abi.encodeCall(RewardsDistributor.initialize, (address(this), multisig, operatorSafe, voucherSigner, list))
        );
    }

    function test_Initialize_RejectsADuplicateTokenInTheList() public {
        address impl = address(new RewardsDistributor());
        IRewardsDistributor.RewardTokenInit[] memory list = _launchRewardTokens(address(asset), false, address(asset));

        vm.expectRevert(abi.encodeWithSelector(IRewardsDistributor.RewardTokenAlreadyAdded.selector, address(asset)));
        new LPProxy(
            impl,
            abi.encodeCall(RewardsDistributor.initialize, (address(this), multisig, operatorSafe, voucherSigner, list))
        );
    }

    /// @dev An empty list is legal: a stack can be born with no reward token and gain them
    ///      through the timelock.
    function test_Initialize_AcceptsAnEmptyTokenList() public {
        RewardsDistributor fresh =
            _deployDistributorProxy(address(this), multisig, operatorSafe, voucherSigner, _noTokens());
        assertEq(fresh.rewardTokens().length, 0, "no token must be registered");
        assertFalse(fresh.isRewardToken(address(asset)), "and nothing must read as a reward token");
    }

    /**
     * @dev Every mutable field must be followable from logs alone, from block one — the pause
     *      flag whose initial value is `false` included, so an indexer never has to hardcode a
     *      default. The order is the one `initialize` writes it in: the three roles, the pause,
     *      then one `RewardTokenAdded` per token in list order.
     */
    function test_Initialize_AnnouncesEveryInitialFieldInOrder() public {
        RewardsDistributor impl = new RewardsDistributor();
        IRewardsDistributor.RewardTokenInit[] memory list = _launchRewardTokens(address(asset), false, ovtr);

        vm.expectEmit(false, false, false, true);
        emit IRewardsDistributor.GuardianSet(address(0), multisig);
        vm.expectEmit(false, false, false, true);
        emit IRewardsDistributor.OperatorSet(address(0), operatorSafe);
        vm.expectEmit(false, false, false, true);
        emit IRewardsDistributor.SignerChanged(address(0), voucherSigner);
        vm.expectEmit(false, false, false, true);
        emit IRewardsDistributor.Paused(false);
        vm.expectEmit(true, false, false, true);
        emit IRewardsDistributor.RewardTokenAdded(address(asset), true, false, 18, "ASSET");
        vm.expectEmit(true, false, false, true);
        emit IRewardsDistributor.RewardTokenAdded(ovtr, false, true, 18, OVERTURE_SYMBOL);
        RewardsDistributor fresh = RewardsDistributor(
            address(
                new LPProxy(
                    address(impl),
                    abi.encodeCall(
                        RewardsDistributor.initialize, (address(this), multisig, operatorSafe, voucherSigner, list)
                    )
                )
            )
        );

        // The events are the whole state, so the state has to agree with them.
        assertEq(fresh.guardian(), multisig, "the guardian must be what GuardianSet announced");
        assertEq(fresh.operator(), operatorSafe, "the operator must be what OperatorSet announced");
        assertEq(fresh.signer(), voucherSigner, "the signer must be what SignerChanged announced");
        assertFalse(fresh.paused(), "the pause flag must be what Paused announced");
        address[] memory tokens = fresh.rewardTokens();
        assertEq(tokens.length, 2, "both launch tokens must be registered");
        assertEq(tokens[0], address(asset), "in list order: $ASSET first");
        assertEq(tokens[1], ovtr, "then $OVTR");
    }

    /// @dev A proxy is initialised exactly once; a second call cannot re-seat the owner.
    function test_Initialize_CannotRunTwiceOnTheProxy() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        distributor.initialize(alice, alice, alice, alice, _noTokens());
    }

    function test_Initialize_StartsWithTheLaunchState() public view {
        assertFalse(distributor.paused(), "claims must be live from deployment");
        assertEq(distributor.signer(), voucherSigner, "the configured signer must be stored");
        assertEq(distributor.guardian(), address(this), "the configured guardian must be stored");
        assertEq(distributor.operator(), address(this), "the configured operator must be stored");
        assertEq(distributor.REWARD_CLAIM_TYPEHASH(), REWARD_CLAIM_TYPEHASH, "the one voucher type");
        assertEq(
            distributor.REWARD_CLAIM_TYPEHASH(),
            0x746a03cb3aaddb17f8408279b7ff5133a65d78143d19fbd50c05d05bca850c63,
            "the frozen typehash"
        );

        IRewardsDistributor.RewardToken memory a = distributor.rewardToken(address(asset));
        assertTrue(a.registered && a.enabled && a.conditional, "$ASSET: registered, enabled, conditional");
        assertFalse(a.claimsEnabled, "$ASSET claims are closed at launch");
        assertEq(a.decimals, 18, "$ASSET decimals read from the token");

        IRewardsDistributor.RewardToken memory o = distributor.rewardToken(ovtr);
        assertTrue(o.registered && o.enabled && o.claimsEnabled, "$OVTR: registered, enabled, claims open");
        assertFalse(o.conditional, "$OVTR is not conditional");
        assertEq(o.decimals, 18, "$OVTR decimals read from the token");
    }

    // ──────────────────────── Pinned storage ───────────────────

    /**
     * @dev The ledger's address, pinned. `REWARDS_DISTRIBUTOR_STORAGE` is a literal in the
     *      contract because it must never move: if it did, every `claimed[token][user]` would
     *      read zero after an upgrade and every lifetime voucher would pay out again. This
     *      recomputes the ERC-7201 derivation, checks the literal against it, and then reads
     *      every field of the v1 layout at the offset the struct puts it:
     *
     *        base+0  signer (20 bytes) | paused (byte 20)
     *        base+1  guardian
     *        base+2  operator
     *        base+3  rewardTokens.length, elements at keccak(base+3) + i
     *        base+4  tokens mapping:   keccak(token . base+4) -> RewardToken packed in one slot
     *                (registered byte 0, enabled byte 1, conditional byte 2,
     *                 claimsEnabled byte 3, decimals byte 4)
     *        base+5  claimed mapping:  keccak(user . keccak(token . base+5))
     *
     *      Measured on a twin whose guardian and operator are two different addresses, so the
     *      two slots cannot pass by holding the same value.
     */
    function test_Storage_TheV1LayoutLivesAtThePinnedErc7201Slot() public {
        bytes32 expected = keccak256(abi.encode(uint256(keccak256("real.lp.storage.RewardsDistributor")) - 1))
            & ~bytes32(uint256(0xff));
        assertEq(expected, NAMESPACE, "the pinned literal must be the ERC-7201 derivation");

        RewardsDistributor twin = _guardedTwin();
        vm.prank(operatorSafe);
        twin.setPaused(true);

        uint256 base = uint256(expected);
        uint256 slot0 = uint256(vm.load(address(twin), bytes32(base)));
        assertEq(address(uint160(slot0)), voucherSigner, "slot 0 must start with `signer`");
        assertEq((slot0 >> 160) & 0xff, 1, "`paused` must sit in byte 20 right after `signer`");
        assertEq(slot0 >> 168, 0, "and nothing else may share slot 0");

        assertEq(_loadAddress(address(twin), base + 1), multisig, "slot 1 must be `guardian`");
        assertEq(_loadAddress(address(twin), base + 2), operatorSafe, "slot 2 must be `operator`");

        assertEq(uint256(vm.load(address(twin), bytes32(base + 3))), 2, "slot 3 must be rewardTokens.length");
        uint256 elements = uint256(keccak256(abi.encode(base + 3)));
        assertEq(_loadAddress(address(twin), elements), address(asset), "element 0 at keccak(base+3)");
        assertEq(_loadAddress(address(twin), elements + 1), ovtr, "element 1 right after it");

        uint256 assetEntry = uint256(vm.load(address(twin), keccak256(abi.encode(address(asset), base + 4))));
        assertEq(assetEntry, 1 | (1 << 8) | (1 << 16) | (0 << 24) | (18 << 32), "$ASSET entry, packed");
        uint256 ovtrEntry = uint256(vm.load(address(twin), keccak256(abi.encode(ovtr, base + 4))));
        assertEq(ovtrEntry, 1 | (1 << 8) | (0 << 16) | (1 << 24) | (18 << 32), "$OVTR entry, packed");

        // The ledger, on the harness distributor where a claim can be made.
        _claim(ovtr, alice, AWARD);
        bytes32 inner = keccak256(abi.encode(ovtr, base + 5));
        bytes32 ledgerSlot = keccak256(abi.encode(alice, inner));
        assertEq(uint256(vm.load(address(distributor), ledgerSlot)), AWARD, "claimed[token][user] at its slot");
        assertEq(distributor.claimed(ovtr, alice), AWARD, "and the view reads the same word");
    }

    // ──────────────────────── Check order ──────────────────────
    //
    // The order is: paused -> UnknownRewardToken -> TokenClaimsDisabled -> ClaimExpired ->
    // NothingToClaim -> InvalidSignature -> InsufficientFunds. Each test below makes TWO
    // adjacent gates hostile at once and asserts the earlier one is reported, which is what turns
    // the order from documentation into a measurement.

    /// @dev With every gate hostile at once, the caller sees the pause and nothing else.
    function test_CheckOrder_PausedBeatsEveryOtherGate() public {
        MockERC20Permit stray = new MockERC20Permit("Stray", "STRAY", 0, 18);
        distributor.setPaused(true);

        vm.warp(1_000_000);
        vm.prank(alice);
        vm.expectRevert(IRewardsDistributor.ClaimsPaused.selector);
        distributor.claim(address(stray), 0, 0, hex"deadbeef");
    }

    function test_CheckOrder_PausedBeatsAnUnknownToken() public {
        MockERC20Permit stray = new MockERC20Permit("Stray", "STRAY", 0, 18);
        distributor.setPaused(true);

        bytes memory voucher = _sign(address(stray), alice, AWARD, FAR_DEADLINE);
        vm.prank(alice);
        vm.expectRevert(IRewardsDistributor.ClaimsPaused.selector);
        distributor.claim(address(stray), AWARD, FAR_DEADLINE, voucher);
    }

    /// @dev An unregistered token is BOTH unknown and switched off (its flags are all zero), so
    ///      it is the natural pair for these two gates — and the caller is told it is unknown.
    function test_CheckOrder_UnknownBeatsClaimsDisabled() public {
        MockERC20Permit stray = new MockERC20Permit("Stray", "STRAY", 1e24, 18);
        stray.transfer(address(distributor), 1e24); // funded, so only the registry is missing

        bytes memory voucher = _sign(address(stray), alice, AWARD, FAR_DEADLINE);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IRewardsDistributor.UnknownRewardToken.selector, address(stray)));
        distributor.claim(address(stray), AWARD, FAR_DEADLINE, voucher);
    }

    /// @dev $ASSET at launch: registered, claims closed. An expired voucher for it is reported
    ///      as closed, not as expired.
    function test_CheckOrder_ClaimsDisabledBeatsAnExpiredDeadline() public {
        vm.warp(1_000_000);
        uint256 deadline = block.timestamp - 1;

        bytes memory voucher = _sign(address(asset), alice, AWARD, deadline);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IRewardsDistributor.TokenClaimsDisabled.selector, address(asset)));
        distributor.claim(address(asset), AWARD, deadline, voucher);
    }

    function test_CheckOrder_ExpiredBeatsNothingToClaim() public {
        vm.warp(1_000_000);
        uint256 deadline = block.timestamp - 1;

        bytes memory voucher = _sign(ovtr, alice, 0, deadline);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IRewardsDistributor.ClaimExpired.selector, deadline, block.timestamp));
        distributor.claim(ovtr, 0, deadline, voucher);
    }

    /// @dev A zero cumulative with garbage for a signature: the cheap comparison fires before the
    ///      signature is ever recovered.
    function test_CheckOrder_NothingToClaimBeatsABadSignature() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IRewardsDistributor.NothingToClaim.selector, uint256(0), uint256(0)));
        distributor.claim(ovtr, 0, FAR_DEADLINE, hex"deadbeef");
    }

    /// @dev An empty balance AND a voucher from a stranger: the signature is reported, so an
    ///      unfunded token never tells a forger anything about the balance.
    function test_CheckOrder_InvalidSignatureBeatsInsufficientFunds() public {
        _drain(ovtr);
        (address impostor, uint256 impostorPk) = makeAddrAndKey("impostor");

        bytes memory voucher = _signVoucher(impostorPk, ovtr, alice, AWARD, FAR_DEADLINE);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IRewardsDistributor.InvalidSignature.selector, impostor, voucherSigner));
        distributor.claim(ovtr, AWARD, FAR_DEADLINE, voucher);
    }

    /// @dev And the last gate on its own: a perfectly valid voucher against an empty balance.
    function test_CheckOrder_InsufficientFundsIsTheLastGate() public {
        _drain(ovtr);

        bytes memory voucher = _sign(ovtr, alice, AWARD, FAR_DEADLINE);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IRewardsDistributor.InsufficientFunds.selector, ovtr, AWARD, uint256(0)));
        distributor.claim(ovtr, AWARD, FAR_DEADLINE, voucher);
    }

    // ──────────────────────── Funding: the only bound ──────────

    /**
     * @dev The contract pays out of its balance and NOTHING else bounds a valid voucher. A
     *      partly funded balance reverts with the exact numbers — the token, what this claim
     *      needs, what the contract holds — writes nothing and moves nothing, and the very same
     *      voucher pays in full once the company funds the contract.
     */
    function test_InsufficientFunds_RevertsWithExactArgumentsThenPaysOnceFunded() public {
        _drain(ovtr);
        overture.mint(address(distributor), AWARD / 2);
        bytes memory sig = _sign(ovtr, alice, AWARD, FAR_DEADLINE);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IRewardsDistributor.InsufficientFunds.selector, ovtr, AWARD, AWARD / 2));
        distributor.claim(ovtr, AWARD, FAR_DEADLINE, sig);

        assertEq(distributor.claimed(ovtr, alice), 0, "a refused claim must write nothing to the ledger");
        assertEq(overture.balanceOf(alice), 0, "and must move nothing");
        assertEq(overture.balanceOf(address(distributor)), AWARD / 2, "the partial balance stays where it is");

        overture.mint(address(distributor), AWARD / 2); // the company funds the rest

        vm.prank(alice);
        uint256 paid = distributor.claim(ovtr, AWARD, FAR_DEADLINE, sig);
        assertEq(paid, AWARD, "the same voucher pays in full once funded");
        assertEq(overture.balanceOf(address(distributor)), 0, "out of exactly the balance that was funded");
    }

    /// @dev `needed` is the DELTA this claim pays, not the voucher's cumulative figure, and the
    ///      comparison is strict: a balance equal to the delta pays it.
    function test_InsufficientFunds_ComparesTheDeltaAndEqualityPays() public {
        _claim(ovtr, alice, AWARD);
        _drain(ovtr);
        overture.mint(address(distributor), AWARD - 1);
        bytes memory sig = _sign(ovtr, alice, AWARD * 2, FAR_DEADLINE);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IRewardsDistributor.InsufficientFunds.selector, ovtr, AWARD, AWARD - 1));
        distributor.claim(ovtr, AWARD * 2, FAR_DEADLINE, sig);

        overture.mint(address(distributor), 1);
        vm.prank(alice);
        assertEq(distributor.claim(ovtr, AWARD * 2, FAR_DEADLINE, sig), AWARD, "balance == delta must pay");
        assertEq(overture.balanceOf(address(distributor)), 0, "leaving exactly nothing behind");
    }

    /**
     * @dev No cap, no budget, no running total: a cumulative at the top of the type pays out in
     *      full on the first claim, as long as the contract holds it. A fresh token with the
     *      whole uint256 range as its supply is added through the owner and funded with all of
     *      it; nothing in the distributor refuses the payment.
     */
    function test_NoBound_ACumulativeAtTheTopOfUint256PaysWhenFunded() public {
        MockERC20Permit huge = new MockERC20Permit("Huge", "HUGE", type(uint256).max, 18);
        distributor.addRewardToken(address(huge), false, true);
        huge.transfer(address(distributor), type(uint256).max);

        bytes memory voucher = _sign(address(huge), alice, type(uint256).max, FAR_DEADLINE);
        vm.prank(alice);
        uint256 paid = distributor.claim(address(huge), type(uint256).max, FAR_DEADLINE, voucher);

        assertEq(paid, type(uint256).max, "a maximal cumulative must pay out in full on the first claim");
        assertEq(distributor.claimed(address(huge), alice), type(uint256).max, "and the ledger must record it");

        bytes memory again = _sign(address(huge), alice, type(uint256).max, FAR_DEADLINE);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IRewardsDistributor.NothingToClaim.selector, type(uint256).max, type(uint256).max)
        );
        distributor.claim(address(huge), type(uint256).max, FAR_DEADLINE, again);
    }

    /// @dev Nothing is minted at claim time: the $OVTR supply is the same before and after a
    ///      claim, and the payment is a transfer out of the distributor's balance.
    function test_Claim_TransfersOutOfTheBalanceAndMintsNothing() public {
        uint256 supplyBefore = overture.totalSupply();
        uint256 balanceBefore = overture.balanceOf(address(distributor));

        _claim(ovtr, alice, AWARD);

        assertEq(overture.totalSupply(), supplyBefore, "a claim must never mint");
        assertEq(balanceBefore - overture.balanceOf(address(distributor)), AWARD, "it pays out of the balance");
        assertEq(overture.balanceOf(alice), AWARD, "to the claimer");
    }

    // ──────────────────────── Deadline boundary ────────────────

    /// @dev `block.timestamp > deadline` — equality is still inside the window.
    function test_Deadline_ADeadlineEqualToNowIsStillValid() public {
        vm.warp(1_000_000);
        bytes memory sig = _sign(ovtr, alice, AWARD, block.timestamp);

        vm.prank(alice);
        uint256 paid = distributor.claim(ovtr, AWARD, block.timestamp, sig);
        assertEq(paid, AWARD, "a deadline exactly at the current timestamp must be honoured");
    }

    function test_Deadline_OneSecondPastTheDeadlineReverts() public {
        vm.warp(1_000_000);
        uint256 deadline = block.timestamp - 1;
        bytes memory sig = _sign(ovtr, alice, AWARD, deadline);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IRewardsDistributor.ClaimExpired.selector, deadline, block.timestamp));
        distributor.claim(ovtr, AWARD, deadline, sig);
    }

    // ──────────────────────── Amount boundary ──────────────────

    /// @dev `cumulativeAmount <= alreadyClaimed` has two arms. This is the equal one.
    function test_Amount_RevertsWhenTheCumulativeIsUnchanged() public {
        _claim(ovtr, alice, AWARD);

        bytes memory voucher = _sign(ovtr, alice, AWARD, FAR_DEADLINE);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IRewardsDistributor.NothingToClaim.selector, AWARD, AWARD));
        distributor.claim(ovtr, AWARD, FAR_DEADLINE, voucher);
    }

    /// @dev ...and this is the strictly-smaller one: a stale voucher can never claw back.
    function test_Amount_RevertsOnAStaleSmallerCumulative() public {
        _claim(ovtr, alice, AWARD);

        bytes memory voucher = _sign(ovtr, alice, AWARD - 1, FAR_DEADLINE);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IRewardsDistributor.NothingToClaim.selector, AWARD - 1, AWARD));
        distributor.claim(ovtr, AWARD - 1, FAR_DEADLINE, voucher);
    }

    /// @dev One wei more is a valid claim, and pays exactly one wei.
    function test_Amount_AOneWeiIncrementIsPayable() public {
        _claim(ovtr, alice, AWARD);

        bytes memory voucher = _sign(ovtr, alice, AWARD + 1, FAR_DEADLINE);
        vm.prank(alice);
        uint256 paid = distributor.claim(ovtr, AWARD + 1, FAR_DEADLINE, voucher);
        assertEq(paid, 1, "the payout must be exactly the increment, not the cumulative");
    }

    // ──────────────────────── Signature shapes ─────────────────

    /// @dev The malleable twin (N - s, flipped v) recovers the same key on raw `ecrecover`.
    ///      OpenZeppelin's `ECDSA` rejects it outright, which is what stops a second, equally
    ///      valid encoding of the same voucher from existing.
    function test_Signature_HighSMalleableTwinIsRejected() public {
        bytes32 digest = _voucherDigest(ovtr, alice, AWARD, FAR_DEADLINE);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(voucherSignerPk, digest);

        bytes32 flippedS = bytes32(SECP256K1_N - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;
        bytes memory malleable = abi.encodePacked(r, flippedS, flippedV);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureS.selector, flippedS));
        distributor.claim(ovtr, AWARD, FAR_DEADLINE, malleable);
    }

    function test_Signature_WrongLengthIsRejectedWithTheLength() public {
        bytes memory tooShort = new bytes(64);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureLength.selector, uint256(64)));
        distributor.claim(ovtr, AWARD, FAR_DEADLINE, tooShort);
    }

    function test_Signature_AnImpossibleVIsRejected() public {
        bytes32 digest = _voucherDigest(ovtr, alice, AWARD, FAR_DEADLINE);
        (, bytes32 r, bytes32 s) = vm.sign(voucherSignerPk, digest);

        vm.prank(alice);
        vm.expectRevert(ECDSA.ECDSAInvalidSignature.selector);
        distributor.claim(ovtr, AWARD, FAR_DEADLINE, abi.encodePacked(r, s, uint8(29)));
    }

    /// @dev A zero `v` is the other impossible recovery id; it never recovers anything.
    function test_Signature_AZeroVIsRejected() public {
        bytes32 digest = _voucherDigest(ovtr, alice, AWARD, FAR_DEADLINE);
        (, bytes32 r, bytes32 s) = vm.sign(voucherSignerPk, digest);

        vm.prank(alice);
        vm.expectRevert(ECDSA.ECDSAInvalidSignature.selector);
        distributor.claim(ovtr, AWARD, FAR_DEADLINE, abi.encodePacked(r, s, uint8(0)));
    }

    function test_Signature_AVoucherSignedByAnybodyElseIsRejected() public {
        (address impostor, uint256 impostorPk) = makeAddrAndKey("impostor");

        bytes memory voucher = _signVoucher(impostorPk, ovtr, alice, AWARD, FAR_DEADLINE);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IRewardsDistributor.InvalidSignature.selector, impostor, voucherSigner));
        distributor.claim(ovtr, AWARD, FAR_DEADLINE, voucher);
    }

    /// @dev The signed `user` is `msg.sender`, never an argument: alice's voucher in bob's hands
    ///      hashes bob into the struct and recovers to nobody.
    function test_Signature_IsBoundToTheClaimer() public {
        bytes memory aliceSig = _sign(ovtr, alice, AWARD, FAR_DEADLINE);

        vm.prank(bob);
        vm.expectPartialRevert(IRewardsDistributor.InvalidSignature.selector);
        distributor.claim(ovtr, AWARD, FAR_DEADLINE, aliceSig);

        assertEq(distributor.claimed(ovtr, bob), 0, "bob's ledger must be untouched");
        assertEq(distributor.claimed(ovtr, alice), 0, "and so must alice's");
    }

    /**
     * @dev The token is a SIGNED field. A voucher for $OVTR presented for $ASSET (claims open,
     *      funded) recovers to some other address and is refused, and neither ledger moves.
     *      This is what replaced the two per-leg type hashes of the pre-v1 contract.
     */
    function test_Signature_AVoucherForOneTokenIsWorthlessForAnother() public {
        distributor.setClaimsEnabled(address(asset), true);
        bytes memory ovtrSig = _sign(ovtr, alice, AWARD, FAR_DEADLINE);
        uint256 assetBefore = asset.balanceOf(alice);

        vm.prank(alice);
        vm.expectPartialRevert(IRewardsDistributor.InvalidSignature.selector);
        distributor.claim(address(asset), AWARD, FAR_DEADLINE, ovtrSig);

        assertEq(distributor.claimed(address(asset), alice), 0, "the $ASSET ledger must be untouched");
        assertEq(distributor.claimed(ovtr, alice), 0, "and so must the ledger the voucher was signed for");
        assertEq(asset.balanceOf(alice), assetBefore, "and no $ASSET may move");
    }

    /**
     * @dev The EIP-712 domain carries `block.chainid`, and OpenZeppelin's `EIP712` recomputes
     *      the separator whenever the chain id moves away from the one it cached at
     *      initialization. A voucher signed on one chain is therefore worthless on a fork of it.
     */
    function test_Signature_IsNotReplayableOnAnotherChainId() public {
        bytes memory sig = _sign(ovtr, alice, AWARD, FAR_DEADLINE);

        vm.chainId(999);

        vm.prank(alice);
        vm.expectPartialRevert(IRewardsDistributor.InvalidSignature.selector);
        distributor.claim(ovtr, AWARD, FAR_DEADLINE, sig);
    }

    // ──────────────────────── Events + ledgers ─────────────────

    /// @dev `Claimed` is byte-identical to the pre-v1 event: user, token, cumulative, paid, time.
    function test_Claim_EmitsTheCumulativeAndThePaidAmountSeparately() public {
        _claim(ovtr, alice, AWARD);
        bytes memory sig = _sign(ovtr, alice, AWARD * 2, FAR_DEADLINE);

        vm.expectEmit(true, true, false, true, address(distributor));
        emit IRewardsDistributor.Claimed(alice, ovtr, AWARD * 2, AWARD, block.timestamp);
        vm.prank(alice);
        distributor.claim(ovtr, AWARD * 2, FAR_DEADLINE, sig);
    }

    function test_Claim_LedgersAreKeptPerUserAndPerToken() public {
        distributor.setClaimsEnabled(address(asset), true);
        uint256 aliceAssetBefore = asset.balanceOf(alice);

        _claim(ovtr, alice, AWARD);
        _claim(ovtr, bob, AWARD * 2);
        _claim(address(asset), alice, AWARD * 3);

        assertEq(distributor.claimed(ovtr, alice), AWARD, "alice's $OVTR ledger holds only her own cumulative");
        assertEq(distributor.claimed(ovtr, bob), AWARD * 2, "bob's $OVTR ledger holds only his own");
        assertEq(distributor.claimed(address(asset), alice), AWARD * 3, "alice's $ASSET ledger is separate");
        assertEq(distributor.claimed(address(asset), bob), 0, "bob never claimed $ASSET");
        assertEq(overture.balanceOf(alice), AWARD, "the $OVTR payments land per user");
        assertEq(overture.balanceOf(bob), AWARD * 2, "the $OVTR payments land per user");
        assertEq(asset.balanceOf(alice) - aliceAssetBefore, AWARD * 3, "and the $ASSET payment is separate");
    }

    // ──────────────────────── Reward tokens ────────────────────

    /**
     * @dev Adding a token reads its `decimals()` and `symbol()` from the token itself, enables it
     *      on arrival (so the registry can schedule it), appends it to `rewardTokens()`, and
     *      announces the full new entry.
     */
    function test_AddRewardToken_ReadsMetadataEnablesAndAppends() public {
        MockERC20Permit third = new MockERC20Permit("Third", "THRD", 1e30, 6);

        vm.expectEmit(true, false, false, true, address(distributor));
        emit IRewardsDistributor.RewardTokenAdded(address(third), true, false, 6, "THRD");
        distributor.addRewardToken(address(third), true, false);

        IRewardsDistributor.RewardToken memory t = distributor.rewardToken(address(third));
        assertTrue(t.registered, "registered");
        assertTrue(t.enabled, "enabled on arrival");
        assertTrue(t.conditional, "the conditional flag is stored as given");
        assertFalse(t.claimsEnabled, "claims as given (closed)");
        assertEq(t.decimals, 6, "a 6-decimal token is stored as 6");
        assertTrue(distributor.isRewardToken(address(third)), "enabled means isRewardToken");

        address[] memory list = distributor.rewardTokens();
        assertEq(list.length, 3, "appended to the list");
        assertEq(list[2], address(third), "at the end, in registration order");
    }

    /// @dev A new token pays nothing until it is funded — and then pays in full. No other gate.
    function test_AddRewardToken_ANewTokenRevertsUntilFundedThenPays() public {
        MockERC20Permit third = new MockERC20Permit("Third", "THRD", 1e30, 18);
        distributor.addRewardToken(address(third), false, true);
        bytes memory sig = _sign(address(third), alice, AWARD, FAR_DEADLINE);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IRewardsDistributor.InsufficientFunds.selector, address(third), AWARD, uint256(0))
        );
        distributor.claim(address(third), AWARD, FAR_DEADLINE, sig);

        third.transfer(address(distributor), AWARD);
        vm.prank(alice);
        assertEq(distributor.claim(address(third), AWARD, FAR_DEADLINE, sig), AWARD, "funded, it pays in full");
    }

    function test_AddRewardToken_RejectsZeroAndDuplicates() public {
        vm.expectRevert(IRewardsDistributor.ZeroAddress.selector);
        distributor.addRewardToken(address(0), false, true);

        vm.expectRevert(abi.encodeWithSelector(IRewardsDistributor.RewardTokenAlreadyAdded.selector, ovtr));
        distributor.addRewardToken(ovtr, false, true);
    }

    /// @dev A token that cannot report its symbol is not a plain ERC-20 and is refused; so is an
    ///      address with no code at all.
    function test_AddRewardToken_RejectsATokenWithoutReadableMetadata() public {
        SymbolRevertsToken noSymbol = new SymbolRevertsToken();
        vm.expectRevert(bytes("no symbol"));
        distributor.addRewardToken(address(noSymbol), false, true);

        vm.expectRevert();
        distributor.addRewardToken(makeAddr("not-a-contract"), false, true);

        assertFalse(distributor.rewardToken(address(noSymbol)).registered, "a refused token stays unregistered");
        assertEq(distributor.rewardTokens().length, 2, "and the list does not grow");
    }

    /// @dev Owner tier only: the operator and the guardian are both refused, measured on a twin
    ///      whose three roles are three addresses.
    function test_AddRewardToken_IsOwnerOnly() public {
        RewardsDistributor twin = _guardedTwin();
        MockERC20Permit third = new MockERC20Permit("Third", "THRD", 0, 18);

        vm.prank(operatorSafe);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operatorSafe));
        twin.addRewardToken(address(third), false, true);

        vm.prank(multisig);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, multisig));
        twin.addRewardToken(address(third), false, true);

        twin.addRewardToken(address(third), false, true);
        assertTrue(twin.isRewardToken(address(third)), "the owner can add it");
    }

    /**
     * @dev `enabled` gates the SCHEDULE only (it is what `isRewardToken` reports to the
     *      registry). A token taken off the schedule with its claims still open keeps paying
     *      what users earned while it was scheduled — exactly the "everything earned stays
     *      claimable at any time" rule.
     */
    function test_SetRewardTokenEnabled_OffTheScheduleStillPays() public {
        vm.expectEmit(true, false, false, true, address(distributor));
        emit IRewardsDistributor.RewardTokenUpdated(ovtr, false, true);
        distributor.setRewardTokenEnabled(ovtr, false);

        assertFalse(distributor.isRewardToken(ovtr), "off the schedule");
        IRewardsDistributor.RewardToken memory t = distributor.rewardToken(ovtr);
        assertTrue(t.registered && t.claimsEnabled, "still registered, claims still open");

        uint256 paid = _claim(ovtr, alice, AWARD);
        assertEq(paid, AWARD, "a disabled token with open claims still pays");

        vm.expectEmit(true, false, false, true, address(distributor));
        emit IRewardsDistributor.RewardTokenUpdated(ovtr, true, true);
        distributor.setRewardTokenEnabled(ovtr, true);
        assertTrue(distributor.isRewardToken(ovtr), "back on the schedule");
    }

    /// @dev Closing one token's claims stops that token alone, the event carries both switches,
    ///      and reopening restores the same voucher.
    function test_SetClaimsEnabled_ClosesOneTokenAndReopens() public {
        bytes memory sig = _sign(ovtr, alice, AWARD, FAR_DEADLINE);

        vm.expectEmit(true, false, false, true, address(distributor));
        emit IRewardsDistributor.RewardTokenUpdated(ovtr, true, false);
        distributor.setClaimsEnabled(ovtr, false);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IRewardsDistributor.TokenClaimsDisabled.selector, ovtr));
        distributor.claim(ovtr, AWARD, FAR_DEADLINE, sig);
        assertTrue(distributor.isRewardToken(ovtr), "closing claims does not take the token off the schedule");

        distributor.setClaimsEnabled(ovtr, true);
        vm.prank(alice);
        assertEq(distributor.claim(ovtr, AWARD, FAR_DEADLINE, sig), AWARD, "reopened, the same voucher pays");
    }

    /// @dev $ASSET's path at launch: closed, then opened by the owner (the timelock).
    function test_SetClaimsEnabled_OpensTheClosedAssetLeg() public {
        bytes memory sig = _sign(address(asset), alice, AWARD, FAR_DEADLINE);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IRewardsDistributor.TokenClaimsDisabled.selector, address(asset)));
        distributor.claim(address(asset), AWARD, FAR_DEADLINE, sig);

        vm.expectEmit(true, false, false, true, address(distributor));
        emit IRewardsDistributor.RewardTokenUpdated(address(asset), true, true);
        distributor.setClaimsEnabled(address(asset), true);

        vm.prank(alice);
        assertEq(distributor.claim(address(asset), AWARD, FAR_DEADLINE, sig), AWARD, "opened, $ASSET pays");

        IRewardsDistributor.RewardToken memory t = distributor.rewardToken(address(asset));
        assertTrue(t.conditional, "the switch leaves the conditional flag alone");
        assertEq(t.decimals, 18, "and the decimals");
    }

    function test_TokenSetters_RejectAnUnregisteredToken() public {
        address stray = makeAddr("stray");

        vm.expectRevert(abi.encodeWithSelector(IRewardsDistributor.UnknownRewardToken.selector, stray));
        distributor.setRewardTokenEnabled(stray, true);

        vm.expectRevert(abi.encodeWithSelector(IRewardsDistributor.UnknownRewardToken.selector, stray));
        distributor.setClaimsEnabled(stray, true);
    }

    function test_TokenSetters_AreOwnerOnly() public {
        RewardsDistributor twin = _guardedTwin();

        vm.startPrank(operatorSafe);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operatorSafe));
        twin.setRewardTokenEnabled(ovtr, false);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operatorSafe));
        twin.setClaimsEnabled(ovtr, false);
        vm.stopPrank();

        vm.startPrank(multisig);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, multisig));
        twin.setRewardTokenEnabled(ovtr, false);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, multisig));
        twin.setClaimsEnabled(ovtr, false);
        vm.stopPrank();
    }

    /// @dev `isRewardToken` = registered AND enabled. Claims open or closed does not enter it.
    function test_IsRewardToken_TruthTable() public {
        assertFalse(distributor.isRewardToken(makeAddr("never-registered")), "unregistered -> false");
        assertTrue(distributor.isRewardToken(ovtr), "registered + enabled + claims open -> true");
        assertTrue(distributor.isRewardToken(address(asset)), "registered + enabled + claims closed -> true");

        distributor.setRewardTokenEnabled(address(asset), false);
        assertFalse(distributor.isRewardToken(address(asset)), "registered + disabled + claims closed -> false");

        distributor.setRewardTokenEnabled(ovtr, false);
        assertFalse(distributor.isRewardToken(ovtr), "registered + disabled + claims open -> false");
    }

    // ──────────────────────── Admin surface ────────────────────

    function test_SetSigner_RejectsZeroAndAnnouncesBothSides() public {
        vm.expectRevert(IRewardsDistributor.ZeroAddress.selector);
        distributor.setSigner(address(0));

        vm.expectEmit(false, false, false, true, address(distributor));
        emit IRewardsDistributor.SignerChanged(voucherSigner, carol);
        distributor.setSigner(carol);
        assertEq(distributor.signer(), carol, "the new signer must be stored");
    }

    function test_SetPaused_EmitsTheFullNewState() public {
        vm.expectEmit(false, false, false, true, address(distributor));
        emit IRewardsDistributor.Paused(true);
        distributor.setPaused(true);
        assertTrue(distributor.paused(), "stored");

        vm.expectEmit(false, false, false, true, address(distributor));
        emit IRewardsDistributor.Paused(false);
        distributor.setPaused(false);
        assertFalse(distributor.paused(), "and back");
    }

    function test_RecoverExcess_RejectsAZeroAmount() public {
        vm.expectRevert(IRewardsDistributor.ZeroAmount.selector);
        distributor.recoverExcess(ovtr, 0);
    }

    /**
     * @dev The destination is `operator()` and there is no argument to mistype — not `owner()`,
     *      which after the deploy script is a timelock contract with no way to forward an ERC-20,
     *      and not `guardian()`, which is a hot key that must never move value. Measured on a twin
     *      whose three roles are DIFFERENT addresses, for a registered token AND a stray one.
     */
    function test_RecoverExcess_AlwaysSendsToTheOperatorForAnyToken() public {
        RewardsDistributor twin = _guardedTwin();
        asset.transfer(address(twin), 1_000e18);
        MockERC20Permit stray = new MockERC20Permit("Stray", "STRAY", 500e18, 18);
        stray.transfer(address(twin), 500e18);

        uint256 before = asset.balanceOf(operatorSafe);
        uint256 guardianBefore = asset.balanceOf(multisig);

        vm.expectEmit(true, false, false, true, address(twin));
        emit IRewardsDistributor.ExcessRecovered(address(asset), operatorSafe, 1_000e18, block.timestamp);
        vm.prank(operatorSafe);
        twin.recoverExcess(address(asset), 1_000e18);

        vm.expectEmit(true, false, false, true, address(twin));
        emit IRewardsDistributor.ExcessRecovered(address(stray), operatorSafe, 500e18, block.timestamp);
        vm.prank(operatorSafe);
        twin.recoverExcess(address(stray), 500e18);

        assertEq(asset.balanceOf(operatorSafe) - before, 1_000e18, "the recovery must land on operator()");
        assertEq(stray.balanceOf(operatorSafe), 500e18, "an unregistered stray is recoverable too");
        assertEq(asset.balanceOf(multisig), guardianBefore, "and the guardian must have received nothing");
    }

    function test_RecoverExcess_RevertsBeyondTheHeldBalance() public {
        uint256 held = overture.balanceOf(address(distributor));

        vm.expectRevert();
        distributor.recoverExcess(ovtr, held + 1);
    }

    /// @dev A stranger holds none of the three tiers. Every rejection names the caller, and each
    ///      names the tier it failed.
    function test_AdminFunctions_RejectAStranger() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        distributor.addRewardToken(makeAddr("t"), false, true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        distributor.setRewardTokenEnabled(ovtr, false);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        distributor.setClaimsEnabled(ovtr, false);
        vm.expectRevert(
            abi.encodeWithSelector(IRewardsDistributor.NotOwnerOrOperator.selector, alice, address(this), address(this))
        );
        distributor.setGuardian(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        distributor.setOperator(alice);
        vm.expectRevert(abi.encodeWithSelector(IRewardsDistributor.NotOperator.selector, alice, address(this)));
        distributor.setSigner(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IRewardsDistributor.NotGuardianOrOperator.selector, alice, address(this), address(this)
            )
        );
        distributor.setPaused(true);
        vm.expectRevert(abi.encodeWithSelector(IRewardsDistributor.NotOperator.selector, alice, address(this)));
        distributor.recoverExcess(ovtr, 1);
        vm.stopPrank();
    }

    /**
     * @dev The split is real in EVERY direction, which is the whole point of three tiers: the
     *      owner reaches neither undelayed tier, the guardian reaches only the pause switch, and
     *      the operator reaches its own calls plus the pause and `setGuardian`. Measured on a
     *      twin whose three roles are three different addresses.
     */
    function test_AdminFunctions_TheThreeTiersDoNotOverlap() public {
        RewardsDistributor twin = _guardedTwin();

        // The OWNER is rejected on the pause switch and on every operator function.
        vm.expectRevert(
            abi.encodeWithSelector(
                IRewardsDistributor.NotGuardianOrOperator.selector, address(this), multisig, operatorSafe
            )
        );
        twin.setPaused(true);
        vm.expectRevert(abi.encodeWithSelector(IRewardsDistributor.NotOperator.selector, address(this), operatorSafe));
        twin.setSigner(carol);
        vm.expectRevert(abi.encodeWithSelector(IRewardsDistributor.NotOperator.selector, address(this), operatorSafe));
        twin.recoverExcess(ovtr, 1);

        // The GUARDIAN is rejected on every owner function AND on every operator function —
        // `setGuardian` included, so a leaked hot key cannot keep itself installed.
        vm.startPrank(multisig);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, multisig));
        twin.setClaimsEnabled(address(asset), true);
        vm.expectRevert(
            abi.encodeWithSelector(
                IRewardsDistributor.NotOwnerOrOperator.selector, multisig, address(this), operatorSafe
            )
        );
        twin.setGuardian(multisig);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, multisig));
        twin.setOperator(multisig);
        vm.expectRevert(abi.encodeWithSelector(IRewardsDistributor.NotOperator.selector, multisig, operatorSafe));
        twin.setSigner(carol);
        vm.expectRevert(abi.encodeWithSelector(IRewardsDistributor.NotOperator.selector, multisig, operatorSafe));
        twin.recoverExcess(ovtr, 1);
        vm.stopPrank();

        // The OPERATOR is rejected on every owner function. `setGuardian` is NOT one of them —
        // it is owner OR operator — but `setOperator` is, so the operator cannot rotate itself.
        vm.startPrank(operatorSafe);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operatorSafe));
        twin.setClaimsEnabled(address(asset), true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operatorSafe));
        twin.setOperator(operatorSafe);
        twin.setGuardian(carol);
        vm.stopPrank();
        assertEq(twin.guardian(), carol, "the operator must be able to appoint a new guardian");
        twin.setGuardian(multisig); // put the guardian back for the assertions below

        // Each tier does work from its own address, and the pause takes either of two.
        vm.prank(multisig);
        twin.setPaused(true);
        assertTrue(twin.paused(), "the guardian must be able to pause");
        vm.prank(operatorSafe);
        twin.setPaused(false);
        assertFalse(twin.paused(), "and so must the operator, as the cold fallback");
        vm.prank(operatorSafe);
        twin.setSigner(carol);
        assertEq(twin.signer(), carol, "the operator must be able to rotate the signer");
        twin.setClaimsEnabled(address(asset), true);
        assertTrue(twin.rewardToken(address(asset)).claimsEnabled, "the owner must be able to open $ASSET claims");
    }

    function test_SetGuardian_AnnouncesBothSidesAndMovesTheTier() public {
        vm.expectEmit(false, false, false, true, address(distributor));
        emit IRewardsDistributor.GuardianSet(address(this), carol);
        distributor.setGuardian(carol);
        assertEq(distributor.guardian(), carol, "the new guardian must be stored");

        // The old guardian loses the tier immediately. This contract is still the OPERATOR here,
        // so the rejection has to be measured from an address that is neither.
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IRewardsDistributor.NotGuardianOrOperator.selector, alice, carol, address(this))
        );
        distributor.setPaused(true);
    }

    /**
     * @dev `address(0)` is NOT rejected by `setGuardian` — it is the explicit "no guardian" state,
     *      and writing it is how a compromised hot key is revoked without waiting out the owner's
     *      48 hour timelock. Once the slot holds zero every guardian path is closed, because
     *      `msg.sender` can never be the zero address, and the operator alone can pause.
     */
    function test_SetGuardian_AcceptsZeroAsTheExplicitNoGuardianState() public {
        vm.expectEmit(false, false, false, true, address(distributor));
        emit IRewardsDistributor.GuardianSet(address(this), address(0));
        distributor.setGuardian(address(0));
        assertEq(distributor.guardian(), address(0), "the guardian seat must be vacant");

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IRewardsDistributor.NotGuardianOrOperator.selector, alice, address(0), address(this))
        );
        distributor.setPaused(true);

        distributor.setPaused(true);
        assertTrue(distributor.paused(), "the operator must still be able to pause");

        vm.expectEmit(false, false, false, true, address(distributor));
        emit IRewardsDistributor.GuardianSet(address(0), carol);
        distributor.setGuardian(carol);
        vm.prank(carol);
        distributor.setPaused(false);
        assertFalse(distributor.paused(), "the re-appointed guardian must hold the tier");
    }

    /// @dev `setOperator` is owner-only and rejects zero, so the operator cannot rotate itself
    ///      and the timelock stays the only tier that can change the operator.
    function test_SetOperator_StaysOwnerOnlyAndStillRejectsZero() public {
        RewardsDistributor twin = _guardedTwin();

        vm.prank(operatorSafe);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operatorSafe));
        twin.setOperator(carol);

        vm.expectRevert(IRewardsDistributor.ZeroAddress.selector);
        twin.setOperator(address(0));
    }

    function test_SetOperator_AnnouncesBothSidesAndMovesTheTier() public {
        vm.expectEmit(false, false, false, true, address(distributor));
        emit IRewardsDistributor.OperatorSet(address(this), carol);
        distributor.setOperator(carol);
        assertEq(distributor.operator(), carol, "the new operator must be stored");

        vm.expectRevert(abi.encodeWithSelector(IRewardsDistributor.NotOperator.selector, address(this), carol));
        distributor.setSigner(bob);

        vm.prank(carol);
        distributor.setSigner(bob);
        assertEq(distributor.signer(), bob, "the new operator must be able to rotate the signer");
    }

    /// @dev Renouncing is disabled outright: under a UUPS proxy an ownerless contract could
    ///      never be upgraded again, nor gain a reward token.
    function test_RenounceOwnership_IsDisabled() public {
        vm.expectRevert(IRewardsDistributor.RenounceDisabled.selector);
        distributor.renounceOwnership();
        assertEq(distributor.owner(), address(this), "the owner must be exactly where it was");

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        distributor.renounceOwnership();
    }

    // ──────────────────────── Upgrades ─────────────────────────

    /**
     * @dev The reason the proxy exists (SEC-04): every per-token ledger must survive a code
     *      change. This upgrades a proxy that has already paid out in BOTH tokens, with a third
     *      token added and its switches moved, and checks that every field is exactly where it
     *      was, with new code behind it.
     */
    function test_Upgrade_PreservesEveryPerTokenLedgerTheRolesAndTheTokenList() public {
        distributor.setClaimsEnabled(address(asset), true);
        _claim(ovtr, alice, AWARD);
        _claim(address(asset), alice, AWARD * 2);
        _claim(ovtr, bob, AWARD * 3);
        MockERC20Permit third = new MockERC20Permit("Third", "THRD", 0, 6);
        distributor.addRewardToken(address(third), true, false);
        distributor.setRewardTokenEnabled(ovtr, false);

        address v2 = address(new RewardsDistributorV2Mock());
        distributor.upgradeToAndCall(v2, "");

        assertEq(_implementationOf(address(distributor)), v2, "the ERC-1967 slot must name the new code");
        assertEq(RewardsDistributorV2Mock(address(distributor)).version(), 2, "the new code must be the one running");
        assertEq(distributor.claimed(ovtr, alice), AWARD, "alice's $OVTR ledger survives");
        assertEq(distributor.claimed(address(asset), alice), AWARD * 2, "alice's $ASSET ledger survives");
        assertEq(distributor.claimed(ovtr, bob), AWARD * 3, "bob's $OVTR ledger survives");
        assertEq(distributor.signer(), voucherSigner, "the signer survives");
        assertEq(distributor.guardian(), address(this), "the guardian survives");
        assertEq(distributor.operator(), address(this), "the operator survives");
        assertEq(distributor.owner(), address(this), "the owner survives");

        address[] memory list = distributor.rewardTokens();
        assertEq(list.length, 3, "the token list survives");
        assertEq(list[2], address(third), "in order");
        assertFalse(distributor.isRewardToken(ovtr), "the enabled switch survives");
        assertTrue(distributor.rewardToken(address(asset)).claimsEnabled, "the claims switch survives");
        assertEq(distributor.rewardToken(address(third)).decimals, 6, "the stored decimals survive");

        // And the ledger still governs: the same lifetime voucher pays nothing twice.
        bytes memory voucher = _sign(ovtr, alice, AWARD, FAR_DEADLINE);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IRewardsDistributor.NothingToClaim.selector, AWARD, AWARD));
        distributor.claim(ovtr, AWARD, FAR_DEADLINE, voucher);
    }

    /// @dev V2 writes its own ERC-7201 namespace, and its reinitializer runs exactly once.
    function test_Upgrade_V2StateLivesInItsOwnNamespaceAndReinitializesOnce() public {
        _claim(ovtr, alice, AWARD);
        address v2 = address(new RewardsDistributorV2Mock());
        distributor.upgradeToAndCall(v2, abi.encodeCall(RewardsDistributorV2Mock.initializeV2, (42)));

        RewardsDistributorV2Mock upgraded = RewardsDistributorV2Mock(address(distributor));
        assertEq(upgraded.upgradeMarker(), 42, "the reinitializer ran inside the upgrade");

        vm.expectRevert(Initializable.InvalidInitialization.selector);
        upgraded.initializeV2(7);

        assertEq(distributor.claimed(ovtr, alice), AWARD, "and V2 did not touch V1's namespace");
        assertEq(distributor.signer(), voucherSigner, "nor V1's roles");
    }

    /// @dev Only the owner tier upgrades. Not a stranger, not the guardian, not the operator.
    function test_Upgrade_RejectsEveryoneButTheOwner() public {
        RewardsDistributor twin = _guardedTwin();
        address v2 = address(new RewardsDistributorV2Mock());

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        twin.upgradeToAndCall(v2, "");

        vm.prank(multisig);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, multisig));
        twin.upgradeToAndCall(v2, "");

        vm.prank(operatorSafe);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operatorSafe));
        twin.upgradeToAndCall(v2, "");

        twin.upgradeToAndCall(v2, "");
        assertEq(_implementationOf(address(twin)), v2, "the owner must be able to upgrade");
    }

    // ──────────────────────── Helpers ──────────────────────────

    function _noTokens() private pure returns (IRewardsDistributor.RewardTokenInit[] memory) {
        return new IRewardsDistributor.RewardTokenInit[](0);
    }

    /// @dev A second proxy whose owner (this contract), guardian (`multisig`) and operator
    ///      (`operatorSafe`) are THREE DIFFERENT addresses, which the shared harness deliberately
    ///      collapses into one. Registered with the launch list of the harness tokens.
    function _guardedTwin() private returns (RewardsDistributor) {
        return _deployDistributorProxy(
            address(this), multisig, operatorSafe, voucherSigner, _launchRewardTokens(address(asset), false, ovtr)
        );
    }

    /// @dev Moves the harness distributor's whole balance of `token` out, through the operator
    ///      (this contract), leaving it at zero.
    function _drain(address token) private {
        uint256 held = MockERC20Permit(token).balanceOf(address(distributor));
        if (held > 0) distributor.recoverExcess(token, held);
    }

    /// @dev Reads the ERC-1967 implementation slot straight off the proxy.
    function _implementationOf(address proxy) private view returns (address) {
        return address(uint160(uint256(vm.load(proxy, ERC1967Utils.IMPLEMENTATION_SLOT))));
    }

    /// @dev Replaces, in place, every 20-byte occurrence of `from` in `code` with `to`.
    function _replaceAddress(bytes memory code, address from, address to) private pure returns (uint256 count) {
        bytes20 f = bytes20(from);
        bytes20 t = bytes20(to);
        if (code.length < 20) return 0;
        for (uint256 i = 0; i + 20 <= code.length; ++i) {
            bool hit = true;
            for (uint256 k = 0; k < 20; ++k) {
                if (code[i + k] != f[k]) {
                    hit = false;
                    break;
                }
            }
            if (hit) {
                for (uint256 k = 0; k < 20; ++k) {
                    code[i + k] = t[k];
                }
                ++count;
                i += 19;
            }
        }
    }

    function _loadAddress(address target, uint256 slot) private view returns (address) {
        return address(uint160(uint256(vm.load(target, bytes32(slot)))));
    }

    function _sign(address token, address user, uint256 cumulative, uint256 deadline)
        private
        view
        returns (bytes memory)
    {
        return _signVoucher(voucherSignerPk, token, user, cumulative, deadline);
    }

    function _claim(address token, address user, uint256 cumulative) private returns (uint256 paid) {
        bytes memory sig = _sign(token, user, cumulative, FAR_DEADLINE);
        vm.prank(user);
        paid = distributor.claim(token, cumulative, FAR_DEADLINE, sig);
    }
}

/// @dev A token whose `symbol()` reverts: not a plain ERC-20, refused by `addRewardToken`.
contract SymbolRevertsToken {
    function decimals() external pure returns (uint8) {
        return 18;
    }

    function symbol() external pure returns (string memory) {
        revert("no symbol");
    }
}
