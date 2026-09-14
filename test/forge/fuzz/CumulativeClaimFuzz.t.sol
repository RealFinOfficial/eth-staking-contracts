// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LocalHarness} from "../utils/LocalHarness.sol";
import {RewardsDistributor} from "../../../contracts/lp-staking/RewardsDistributor.sol";

/**
 * @notice Why this file exists: the distributor's whole safety argument is one sentence —
 *         a voucher states a LIFETIME entitlement, a claim pays the difference, and the
 *         difference must be strictly positive. Point tests pin the sentence at a handful of
 *         numbers. These properties pin it over arbitrary voucher SEQUENCES, which is where
 *         a cumulative ledger goes wrong: a stale voucher that pays again, a ledger that
 *         moves backwards, a leg that leaks into the other one.
 *
 *  Every property is asserted against the two observable ledgers (`claimedTokenX` /
 *  `claimedAsset`) AND against the token balance, because those are the two numbers that
 *  must never disagree: the ledger is what stops the next claim, the balance is what the
 *  user actually got.
 */
contract CumulativeClaimFuzzTest is LocalHarness {
    /// @dev Comfortably inside {EPOCH_ONE_CAP} (1e24) so the epoch throttle never fires and
    ///      the property under test is the ledger, not the cap. The cap has its own file.
    uint256 internal constant MAX_ENTITLEMENT = 1e21;

    function setUp() public {
        _deployLocalStack();
        distributor.setAssetClaimsEnabled(true);
    }

    // ──────────────────────── The paid difference ──────────────

    /// @dev A second voucher pays exactly what it added, never the whole cumulative again.
    function testFuzz_Claim_PaidIsExactlyTheCumulativeDelta(uint256 firstSeed, uint256 secondSeed) public {
        uint256 first = bound(firstSeed, 1, MAX_ENTITLEMENT);
        uint256 second = bound(secondSeed, first + 1, MAX_ENTITLEMENT * 2);

        uint256 paidFirst = _claimTokenX(alice, first);
        uint256 paidSecond = _claimTokenX(alice, second);

        assertEq(paidFirst, first, "the first claim pays the whole entitlement");
        assertEq(paidSecond, second - first, "the second pays the delta and never the cumulative again");
        assertEq(distributor.claimedTokenX(alice), second, "the ledger stores the latest cumulative figure");
        assertEq(tokenX.balanceOf(alice), second, "and the balance equals the ledger, never exceeds it");
    }

    /// @dev The ledger never moves backwards and never exceeds the highest voucher seen,
    ///      whatever order the vouchers arrive in — including stale ones interleaved with
    ///      fresh ones.
    function testFuzz_Claim_TheLedgerIsMonotonicAcrossAnyVoucherSequence(uint256[5] memory seeds) public {
        uint256 highest;
        uint256 previousLedger;

        for (uint256 i = 0; i < seeds.length; ++i) {
            uint256 cumulative = bound(seeds[i], 0, MAX_ENTITLEMENT);
            if (cumulative > highest) highest = cumulative;

            bytes memory sig =
                _signVoucher(voucherSignerPk, distributor.TOKENX_CLAIM_TYPEHASH(), alice, cumulative, FAR_DEADLINE);
            vm.prank(alice);
            try distributor.claimTokenX(cumulative, FAR_DEADLINE, sig) {} catch {}

            uint256 ledger = distributor.claimedTokenX(alice);
            assertGe(ledger, previousLedger, "the cumulative ledger is monotonic, whatever the voucher order");
            assertLe(ledger, highest, "and never exceeds the highest cumulative figure ever signed");
            assertEq(tokenX.balanceOf(alice), ledger, "minted supply tracks the ledger exactly at every step");
            previousLedger = ledger;
        }
    }

    /// @dev Replay: re-submitting a voucher that has already been spent pays nothing and
    ///      moves nothing. The revert carries both sides of the comparison that refused it.
    function testFuzz_Claim_ReplayingAVoucherNeverPaysTwice(uint256 cumulativeSeed) public {
        uint256 cumulative = bound(cumulativeSeed, 1, MAX_ENTITLEMENT);

        _claimTokenX(alice, cumulative);
        uint256 balanceAfterFirst = tokenX.balanceOf(alice);

        bytes memory sig =
            _signVoucher(voucherSignerPk, distributor.TOKENX_CLAIM_TYPEHASH(), alice, cumulative, FAR_DEADLINE);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RewardsDistributor.NothingToClaim.selector, cumulative, cumulative));
        distributor.claimTokenX(cumulative, FAR_DEADLINE, sig);

        assertEq(tokenX.balanceOf(alice), balanceAfterFirst, "a replayed voucher must mint nothing at all");
        assertEq(distributor.claimedTokenX(alice), cumulative, "and must leave the ledger where it was");
    }

    // ──────────────────────── Leg independence ─────────────────

    /// @dev The two reward legs share a contract and share nothing else: two ledgers, two
    ///      payout mechanisms, and neither one's progress bounds the other's.
    function testFuzz_Claim_TheTwoLegsAreIndependent(uint256 tokenXSeed, uint256 assetSeed) public {
        uint256 tokenXCumulative = bound(tokenXSeed, 1, MAX_ENTITLEMENT);
        uint256 assetCumulative = bound(assetSeed, 1, MAX_ENTITLEMENT);

        uint256 assetBefore = asset.balanceOf(alice);

        uint256 paidTokenX = _claimTokenX(alice, tokenXCumulative);
        uint256 paidAsset = _claimAsset(alice, assetCumulative);

        assertEq(paidTokenX, tokenXCumulative, "the TokenX leg pays its own cumulative in full");
        assertEq(paidAsset, assetCumulative, "the ASSET leg pays its own, unaffected by the other leg");
        assertEq(distributor.claimedTokenX(alice), tokenXCumulative, "the TokenX ledger holds only TokenX");
        assertEq(distributor.claimedAsset(alice), assetCumulative, "the ASSET ledger holds only ASSET");
        assertEq(tokenX.balanceOf(alice), tokenXCumulative, "TokenX is minted, so the balance is the cumulative");
        assertEq(asset.balanceOf(alice) - assetBefore, assetCumulative, "ASSET is transferred out of the float");
    }

    /// @dev Cross-leg replay: the two legs sign DIFFERENT EIP-712 structs, so a TokenX
    ///      voucher presented to the ASSET leg recovers to a stranger and is refused. The
    ///      ledgers are untouched by the attempt.
    function testFuzz_Claim_ATokenXVoucherIsWorthlessOnTheAssetLeg(uint256 cumulativeSeed) public {
        uint256 cumulative = bound(cumulativeSeed, 1, MAX_ENTITLEMENT);

        bytes memory tokenXSig =
            _signVoucher(voucherSignerPk, distributor.TOKENX_CLAIM_TYPEHASH(), alice, cumulative, FAR_DEADLINE);

        vm.prank(alice);
        vm.expectRevert();
        distributor.claimAsset(cumulative, FAR_DEADLINE, tokenXSig);

        assertEq(distributor.claimedAsset(alice), 0, "a refused cross-leg voucher must leave the ASSET ledger at 0");
        assertEq(distributor.claimedTokenX(alice), 0, "and must not touch the leg it was actually signed for");
    }

    // ──────────────────────── Helpers ──────────────────────────

    function _claimTokenX(address user, uint256 cumulative) private returns (uint256 paid) {
        bytes memory sig =
            _signVoucher(voucherSignerPk, distributor.TOKENX_CLAIM_TYPEHASH(), user, cumulative, FAR_DEADLINE);
        vm.prank(user);
        paid = distributor.claimTokenX(cumulative, FAR_DEADLINE, sig);
    }

    function _claimAsset(address user, uint256 cumulative) private returns (uint256 paid) {
        bytes memory sig =
            _signVoucher(voucherSignerPk, distributor.ASSET_CLAIM_TYPEHASH(), user, cumulative, FAR_DEADLINE);
        vm.prank(user);
        paid = distributor.claimAsset(cumulative, FAR_DEADLINE, sig);
    }
}
