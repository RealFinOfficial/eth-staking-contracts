// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LocalHarness} from "../utils/LocalHarness.sol";
import {IRewardsDistributor} from "../../../contracts/lp-staking/interfaces/IRewardsDistributor.sol";
import {MockERC20Permit} from "../../../contracts/lp-staking/mocks/MockERC20Permit.sol";

/**
 * @notice Why this file exists: the distributor's whole safety argument is one sentence, held
 *         PER TOKEN — a voucher states a LIFETIME entitlement in one token, a claim pays the
 *         difference, the difference must be strictly positive, and the only thing that can stop
 *         a valid voucher is the contract's balance of that token. Point tests pin the sentence
 *         at a handful of numbers. These properties pin it over arbitrary voucher SEQUENCES and
 *         arbitrary token pairs, which is where a cumulative ledger goes wrong: a stale voucher
 *         that pays again, a ledger that moves backwards, one token's voucher that leaks into
 *         another token's ledger.
 *
 *  Every property is asserted against the observable ledger (`claimed(token, user)`) AND against
 *  the token balance, because those are the two numbers that must never disagree: the ledger is
 *  what stops the next claim, the balance is what the user actually got. Both launch tokens are
 *  claimable here ($ASSET's claims are opened in `setUp`, as the timelock will after maturity).
 */
contract CumulativeClaimFuzzTest is LocalHarness {
    /// @dev Far inside the {DISTRIBUTOR_FUNDING} each token is pre-funded with, so the balance
    ///      never runs short by accident; the funding property has its own fuzz below.
    uint256 internal constant MAX_ENTITLEMENT = 1e21;

    address[2] internal tokens;

    function setUp() public {
        _deployLocalStack();
        distributor.setClaimsEnabled(address(asset), true);
        tokens = [address(asset), address(overture)];
    }

    // ──────────────────────── The paid difference ──────────────

    /// @dev A second voucher pays exactly what it added, never the whole cumulative again.
    function testFuzz_Claim_PaidIsExactlyTheCumulativeDelta(uint256 tokenSeed, uint256 firstSeed, uint256 secondSeed)
        public
    {
        address token = _pick(tokenSeed);
        uint256 first = bound(firstSeed, 1, MAX_ENTITLEMENT);
        uint256 second = bound(secondSeed, first + 1, MAX_ENTITLEMENT * 2);
        uint256 before = MockERC20Permit(token).balanceOf(alice);

        uint256 paidFirst = _claim(token, alice, first);
        uint256 paidSecond = _claim(token, alice, second);

        assertEq(paidFirst, first, "the first claim pays the whole entitlement");
        assertEq(paidSecond, second - first, "the second pays the delta and never the cumulative again");
        assertEq(distributor.claimed(token, alice), second, "the ledger stores the latest cumulative figure");
        assertEq(MockERC20Permit(token).balanceOf(alice) - before, second, "and the balance gain equals the ledger");
    }

    /// @dev Per token, the ledger never moves backwards and never exceeds the highest voucher
    ///      seen, whatever order the vouchers arrive in — stale ones interleaved with fresh ones,
    ///      and the two tokens interleaved with each other.
    function testFuzz_Claim_EachLedgerIsMonotonicAcrossAnyVoucherSequence(
        uint256[6] memory amountSeeds,
        uint256[6] memory tokenSeeds
    ) public {
        uint256[2] memory highest;
        uint256[2] memory previousLedger;
        uint256[2] memory startBalance =
            [MockERC20Permit(tokens[0]).balanceOf(alice), MockERC20Permit(tokens[1]).balanceOf(alice)];

        for (uint256 i = 0; i < amountSeeds.length; ++i) {
            uint256 k = bound(tokenSeeds[i], 0, 1);
            address token = tokens[k];
            uint256 cumulative = bound(amountSeeds[i], 0, MAX_ENTITLEMENT);
            if (cumulative > highest[k]) highest[k] = cumulative;

            bytes memory sig = _signVoucher(voucherSignerPk, token, alice, cumulative, FAR_DEADLINE);
            vm.prank(alice);
            try distributor.claim(token, cumulative, FAR_DEADLINE, sig) {} catch {}

            for (uint256 j = 0; j < 2; ++j) {
                uint256 ledger = distributor.claimed(tokens[j], alice);
                assertGe(ledger, previousLedger[j], "each cumulative ledger is monotonic, whatever the voucher order");
                assertLe(ledger, highest[j], "and never exceeds the highest cumulative ever signed for its token");
                assertEq(
                    MockERC20Permit(tokens[j]).balanceOf(alice) - startBalance[j],
                    ledger,
                    "what the user holds tracks its token's ledger exactly at every step"
                );
                previousLedger[j] = ledger;
            }
        }
    }

    /// @dev Replay: re-submitting a voucher that has already been spent pays nothing and moves
    ///      nothing. The revert carries both sides of the comparison that refused it.
    function testFuzz_Claim_ReplayingAVoucherNeverPaysTwice(uint256 tokenSeed, uint256 cumulativeSeed) public {
        address token = _pick(tokenSeed);
        uint256 cumulative = bound(cumulativeSeed, 1, MAX_ENTITLEMENT);

        _claim(token, alice, cumulative);
        uint256 balanceAfterFirst = MockERC20Permit(token).balanceOf(alice);

        bytes memory sig = _signVoucher(voucherSignerPk, token, alice, cumulative, FAR_DEADLINE);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IRewardsDistributor.NothingToClaim.selector, cumulative, cumulative));
        distributor.claim(token, cumulative, FAR_DEADLINE, sig);

        assertEq(MockERC20Permit(token).balanceOf(alice), balanceAfterFirst, "a replayed voucher must pay nothing");
        assertEq(distributor.claimed(token, alice), cumulative, "and must leave the ledger where it was");
    }

    // ──────────────────────── Token independence ───────────────

    /// @dev Two reward tokens share a contract and share nothing else: two ledgers, two balances,
    ///      and neither one's progress bounds the other's.
    function testFuzz_Claim_TheTokensAreIndependent(uint256 assetSeed, uint256 ovtrSeed) public {
        uint256 assetCumulative = bound(assetSeed, 1, MAX_ENTITLEMENT);
        uint256 ovtrCumulative = bound(ovtrSeed, 1, MAX_ENTITLEMENT);
        uint256 assetBefore = asset.balanceOf(alice);

        uint256 paidOvtr = _claim(address(overture), alice, ovtrCumulative);
        uint256 paidAsset = _claim(address(asset), alice, assetCumulative);

        assertEq(paidOvtr, ovtrCumulative, "the $OVTR claim pays its own cumulative in full");
        assertEq(paidAsset, assetCumulative, "the $ASSET claim pays its own, unaffected by the other token");
        assertEq(distributor.claimed(address(overture), alice), ovtrCumulative, "the $OVTR ledger holds only $OVTR");
        assertEq(distributor.claimed(address(asset), alice), assetCumulative, "the $ASSET ledger holds only $ASSET");
        assertEq(overture.balanceOf(alice), ovtrCumulative, "$OVTR transferred out of the distributor");
        assertEq(asset.balanceOf(alice) - assetBefore, assetCumulative, "$ASSET transferred out of the distributor");
    }

    /**
     * @dev Cross-token replay: the token is a SIGNED field, so a voucher for token A presented
     *      for token B hashes B into the struct, recovers to some other address, and is refused.
     *      Neither ledger and neither balance moves. This holds for every amount and both
     *      directions.
     */
    function testFuzz_Claim_ATokenAVoucherIsWorthlessForTokenB(uint256 directionSeed, uint256 cumulativeSeed) public {
        uint256 k = bound(directionSeed, 0, 1);
        address tokenA = tokens[k];
        address tokenB = tokens[1 - k];
        uint256 cumulative = bound(cumulativeSeed, 1, MAX_ENTITLEMENT);

        uint256 aBefore = MockERC20Permit(tokenA).balanceOf(alice);
        uint256 bBefore = MockERC20Permit(tokenB).balanceOf(alice);
        uint256 bFloat = MockERC20Permit(tokenB).balanceOf(address(distributor));

        bytes memory sigForA = _signVoucher(voucherSignerPk, tokenA, alice, cumulative, FAR_DEADLINE);

        vm.prank(alice);
        vm.expectPartialRevert(IRewardsDistributor.InvalidSignature.selector);
        distributor.claim(tokenB, cumulative, FAR_DEADLINE, sigForA);

        assertEq(distributor.claimed(tokenB, alice), 0, "a refused cross-token voucher leaves token B's ledger at 0");
        assertEq(distributor.claimed(tokenA, alice), 0, "and does not touch the token it was signed for");
        assertEq(MockERC20Permit(tokenB).balanceOf(alice), bBefore, "no token B reached the user");
        assertEq(MockERC20Permit(tokenA).balanceOf(alice), aBefore, "nor token A");
        assertEq(MockERC20Permit(tokenB).balanceOf(address(distributor)), bFloat, "token B's float is untouched");
    }

    /// @dev A voucher names its user; in anybody else's hands it pays nobody, on any token.
    function testFuzz_Claim_AVoucherIsWorthlessForAnyOtherUser(uint256 tokenSeed, uint256 cumulativeSeed, address thief)
        public
    {
        vm.assume(thief != alice && thief != address(0));
        address token = _pick(tokenSeed);
        uint256 cumulative = bound(cumulativeSeed, 1, MAX_ENTITLEMENT);

        bytes memory aliceSig = _signVoucher(voucherSignerPk, token, alice, cumulative, FAR_DEADLINE);

        vm.prank(thief);
        vm.expectPartialRevert(IRewardsDistributor.InvalidSignature.selector);
        distributor.claim(token, cumulative, FAR_DEADLINE, aliceSig);

        assertEq(distributor.claimed(token, thief), 0, "the thief's ledger stays empty");
        assertEq(distributor.claimed(token, alice), 0, "and alice's entitlement is intact");
    }

    // ──────────────────────── The balance is the only bound ────

    /**
     * @dev For a token funded with exactly `funded`, a valid voucher for `cumulative` pays it in
     *      full whenever `cumulative <= funded`, and otherwise reverts with
     *      `InsufficientFunds(token, cumulative, funded)` and changes nothing. No other number —
     *      no cap, no epoch quantity, no running total — enters the decision.
     */
    function testFuzz_Claim_TheFundedBalanceIsTheOnlyBound(uint256 fundedSeed, uint256 cumulativeSeed) public {
        MockERC20Permit third = new MockERC20Permit("Third", "THRD", type(uint128).max, 18);
        distributor.addRewardToken(address(third), false, true);

        uint256 funded = bound(fundedSeed, 0, type(uint128).max);
        uint256 cumulative = bound(cumulativeSeed, 1, type(uint128).max);
        third.transfer(address(distributor), funded);

        bytes memory sig = _signVoucher(voucherSignerPk, address(third), alice, cumulative, FAR_DEADLINE);
        vm.prank(alice);
        if (cumulative <= funded) {
            assertEq(distributor.claim(address(third), cumulative, FAR_DEADLINE, sig), cumulative, "funded: pays all");
            assertEq(third.balanceOf(address(distributor)), funded - cumulative, "out of the funded balance");
        } else {
            vm.expectRevert(
                abi.encodeWithSelector(
                    IRewardsDistributor.InsufficientFunds.selector, address(third), cumulative, funded
                )
            );
            distributor.claim(address(third), cumulative, FAR_DEADLINE, sig);
            assertEq(distributor.claimed(address(third), alice), 0, "a short balance writes nothing");
            assertEq(third.balanceOf(address(distributor)), funded, "and moves nothing");
        }
    }

    // ──────────────────────── Helpers ──────────────────────────

    function _pick(uint256 seed) private view returns (address) {
        return tokens[bound(seed, 0, 1)];
    }

    function _claim(address token, address user, uint256 cumulative) private returns (uint256 paid) {
        bytes memory sig = _signVoucher(voucherSignerPk, token, user, cumulative, FAR_DEADLINE);
        vm.prank(user);
        paid = distributor.claim(token, cumulative, FAR_DEADLINE, sig);
    }
}
