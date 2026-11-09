// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {StakingV3Harness} from "../utils/StakingV3Harness.sol";
import {StakingMigrator} from "../../../contracts/staking-v3/StakingMigrator.sol";
import {V3BonusVault} from "../../../contracts/staking-v3/V3BonusVault.sol";
import {WeightedStakingPoolV3} from "../../../contracts/staking-v3/WeightedStakingPoolV3.sol";
import {LPProxy} from "../../../contracts/lp-staking/deploy/LPProxy.sol";
import {TwapGuard} from "../../../contracts/lp-staking/libraries/TwapGuard.sol";
import {OracleHistory} from "../../../contracts/lp-staking/libraries/OracleHistory.sol";
import {TickMath} from "../../../contracts/lp-staking/libraries/TickMath.sol";
import {SwapParams} from "../../../contracts/lp-staking/libraries/TwapGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {Vm} from "forge-std/Vm.sol";
import {LPStakingVault} from "../../../contracts/lp-staking/LPStakingVault.sol";

/**
 * @notice {StakingMigrator}: the three routes end to end on the math rung (real liquidity math),
 *         every eligibility gate of the `TransitionVoucher`, the pause tiers, the admin tiers and
 *         the band and valuation math, in both token orientations.
 */
contract StakingMigratorTest is StakingV3Harness {
    uint256 internal constant PRINCIPAL = 20_000e18;
    uint256 internal constant REWARD = 1_000e6;

    function setUp() public {
        _deployStakingV3();
        _approveMigrator(alice);
        _approveMigrator(bob);
    }

    // ──────────────────────── Route 1: compound ────────────────

    function test_Compound_SwapsStakesAndReservesTenPercent() public {
        StakingMigrator.Voucher memory v = _voucher(migrator, alice, 1, PRINCIPAL, REWARD, 1);
        uint256 assetBefore = asset.balanceOf(alice);
        uint256 usdcBefore = usdcToken.balanceOf(alice);
        uint256 bought = REWARD * 4e18 / 1e6; // the router's rate: 4,000 $ASSET
        uint256 staked = PRINCIPAL + bought;
        uint256 bonus = staked * 1000 / 10_000;

        vm.expectEmit(address(migrator));
        emit StakingMigrator.VoucherUsed(alice, 1, 1);
        vm.expectEmit(address(poolV3));
        emit WeightedStakingPoolV3.StakedFor(alice, address(migrator), staked, WEIGHT);
        vm.expectEmit(address(bonusVault));
        emit V3BonusVault.BonusReserved(alice, bonus, uint64(v3End), 1);
        vm.expectEmit(address(migrator));
        emit StakingMigrator.Compounded(alice, PRINCIPAL, REWARD, bought, staked, bonus);

        vm.prank(alice);
        (uint256 s, uint256 b) = migrator.compound(REWARD, PRINCIPAL, bought, FAR_DEADLINE, _noPermit(), _noPermit(), v);

        assertEq(s, staked);
        assertEq(b, bonus);
        assertEq(asset.balanceOf(alice), assetBefore - PRINCIPAL, "principal pulled");
        assertEq(usdcToken.balanceOf(alice), usdcBefore - REWARD, "reward pulled");
        (uint256 amount, uint256 weight,,) = poolV3.stakes(alice);
        assertEq(amount, staked, "staked for alice");
        assertEq(weight, WEIGHT, "the voucher's weight is the multiplier");
        (uint256 reserved, uint64 unlockAt) = bonusVault.reservedOf(alice);
        assertEq(reserved, bonus);
        assertEq(unlockAt, v3End, "unlocked at the pool's end");
        assertEq(bonusVault.totalReserved(), bonus);
        assertEq(asset.balanceOf(address(migrator)), 0, "holds nothing");
        assertEq(usdcToken.balanceOf(address(migrator)), 0, "holds nothing");
        assertEq(routerMock.lastFee(), MATH_FEE, "the vault pool's fee tier");
        assertEq(routerMock.lastAmountOutMinimum(), bought);
        assertTrue(migrator.isNonceUsed(alice, 1));
    }

    function test_Compound_WithNoPrincipalStakesTheBoughtAssetOnly() public {
        StakingMigrator.Voucher memory v = _voucher(migrator, alice, 1, PRINCIPAL, REWARD, 1);
        vm.prank(alice);
        (uint256 s,) = migrator.compound(REWARD, 0, 0, FAR_DEADLINE, _noPermit(), _noPermit(), v);
        assertEq(s, 4_000e18);
    }

    function test_Compound_ZeroRateReservesNothing() public {
        migrator.setRates(0, 1000, 500);
        StakingMigrator.Voucher memory v = _voucher(migrator, alice, 1, PRINCIPAL, REWARD, 1);
        vm.prank(alice);
        (, uint256 b) = migrator.compound(REWARD, PRINCIPAL, 0, FAR_DEADLINE, _noPermit(), _noPermit(), v);
        assertEq(b, 0);
        assertEq(bonusVault.totalReserved(), 0);
    }

    function test_Compound_RevertsWhilePaused() public {
        migrator.pauseCompound();
        StakingMigrator.Voucher memory v = _voucher(migrator, alice, 1, PRINCIPAL, REWARD, 1);
        vm.prank(alice);
        vm.expectRevert(StakingMigrator.CompoundIsPaused.selector);
        migrator.compound(REWARD, PRINCIPAL, 0, FAR_DEADLINE, _noPermit(), _noPermit(), v);
    }

    function test_Compound_RevertsOnZeroUsdc() public {
        StakingMigrator.Voucher memory v = _voucher(migrator, alice, 1, PRINCIPAL, REWARD, 1);
        vm.prank(alice);
        vm.expectRevert(StakingMigrator.ZeroAmount.selector);
        migrator.compound(0, PRINCIPAL, 0, FAR_DEADLINE, _noPermit(), _noPermit(), v);
    }

    function test_Compound_RevertsWhenTheSwapIsBelowItsMinimum() public {
        StakingMigrator.Voucher memory v = _voucher(migrator, alice, 1, PRINCIPAL, REWARD, 1);
        vm.prank(alice);
        vm.expectRevert(bytes("Too little received"));
        migrator.compound(REWARD, PRINCIPAL, 4_000e18 + 1, FAR_DEADLINE, _noPermit(), _noPermit(), v);
    }

    function test_Compound_RevertsWhenSpotIsOutsideTheTwapBound() public {
        mathPool.setCurrentTick(PRICE_TICK + int24(SWAP_DEVIATION_TICKS) + 1);
        StakingMigrator.Voucher memory v = _voucher(migrator, alice, 1, PRINCIPAL, REWARD, 1);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                TwapGuard.TwapDeviationTooHigh.selector,
                PRICE_TICK + int24(SWAP_DEVIATION_TICKS) + 1,
                PRICE_TICK,
                int24(SWAP_DEVIATION_TICKS)
            )
        );
        migrator.compound(REWARD, PRINCIPAL, 0, FAR_DEADLINE, _noPermit(), _noPermit(), v);
    }

    function test_Compound_UsesAnErc2612PermitWhenTheAllowanceIsShort() public {
        (address dave, uint256 davePk) = makeAddrAndKey("dave");
        asset.transfer(dave, PRINCIPAL);
        usdcToken.transfer(dave, REWARD);

        (uint8 uv, bytes32 ur, bytes32 us) =
            _signErc2612(davePk, usdcToken, dave, address(migrator), REWARD, FAR_DEADLINE);
        (uint8 av, bytes32 ar, bytes32 as_) =
            _signErc2612(davePk, asset, dave, address(migrator), PRINCIPAL, FAR_DEADLINE);
        StakingMigrator.Permit memory up =
            StakingMigrator.Permit({value: REWARD, deadline: FAR_DEADLINE, v: uv, r: ur, s: us});
        StakingMigrator.Permit memory ap =
            StakingMigrator.Permit({value: PRINCIPAL, deadline: FAR_DEADLINE, v: av, r: ar, s: as_});

        StakingMigrator.Voucher memory v = _voucher(migrator, dave, 1, PRINCIPAL, REWARD, 1);
        vm.prank(dave);
        (uint256 s,) = migrator.compound(REWARD, PRINCIPAL, 0, FAR_DEADLINE, up, ap, v);
        assertEq(s, PRINCIPAL + 4_000e18);
        assertEq(asset.nonces(dave), 1, "the permit was used");
    }

    function test_Compound_SkipsAPermitTheAllowanceAlreadyCovers() public {
        // A garbage permit with a deadline: it would revert if it were submitted.
        StakingMigrator.Permit memory junk =
            StakingMigrator.Permit({value: 1, deadline: FAR_DEADLINE, v: 27, r: bytes32(uint256(1)), s: bytes32(0)});
        StakingMigrator.Voucher memory v = _voucher(migrator, alice, 1, PRINCIPAL, REWARD, 1);
        vm.prank(alice);
        migrator.compound(REWARD, PRINCIPAL, 0, FAR_DEADLINE, junk, junk, v);
        assertEq(asset.nonces(alice), 0, "no permit was submitted");
    }

    // ──────────────────────── The voucher gates ────────────────

    function test_Voucher_ReplayIsRejected() public {
        StakingMigrator.Voucher memory v = _voucher(migrator, alice, 3, PRINCIPAL, 0, 7);
        vm.prank(alice);
        migrator.claimRestake(PRINCIPAL / 2, FAR_DEADLINE, _noPermit(), v);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StakingMigrator.VoucherNonceUsed.selector, alice, 7));
        migrator.claimRestake(PRINCIPAL / 2, FAR_DEADLINE, _noPermit(), v);
    }

    function test_Voucher_NoncesArePerUser() public {
        StakingMigrator.Voucher memory va = _voucher(migrator, alice, 3, PRINCIPAL, 0, 1);
        StakingMigrator.Voucher memory vb = _voucher(migrator, bob, 3, PRINCIPAL, 0, 1);
        vm.prank(alice);
        migrator.claimRestake(PRINCIPAL, FAR_DEADLINE, _noPermit(), va);
        vm.prank(bob);
        migrator.claimRestake(PRINCIPAL, FAR_DEADLINE, _noPermit(), vb);
        assertTrue(migrator.isNonceUsed(bob, 1));
    }

    function test_Voucher_AnotherUsersVoucherFailsTheSignature() public {
        StakingMigrator.Voucher memory v = _voucher(migrator, alice, 3, PRINCIPAL, 0, 1);
        vm.prank(bob);
        vm.expectRevert(StakingMigrator.InvalidVoucherSignature.selector);
        migrator.claimRestake(PRINCIPAL, FAR_DEADLINE, _noPermit(), v);
    }

    function test_Voucher_AStrangersSignatureIsRejected() public {
        StakingMigrator.Voucher memory v =
            _voucherSignedBy(migrator, alicePk, alice, 3, PRINCIPAL, 0, WEIGHT, 1, FAR_DEADLINE);
        vm.prank(alice);
        vm.expectRevert(StakingMigrator.InvalidVoucherSignature.selector);
        migrator.claimRestake(PRINCIPAL, FAR_DEADLINE, _noPermit(), v);
    }

    function test_Voucher_AMalformedSignatureIsRejected() public {
        StakingMigrator.Voucher memory v = _voucher(migrator, alice, 3, PRINCIPAL, 0, 1);
        v.signature = hex"1234";
        vm.prank(alice);
        vm.expectRevert(StakingMigrator.InvalidVoucherSignature.selector);
        migrator.claimRestake(PRINCIPAL, FAR_DEADLINE, _noPermit(), v);
    }

    function test_Voucher_AnAlteredWeightFailsTheSignature() public {
        StakingMigrator.Voucher memory v = _voucher(migrator, alice, 3, PRINCIPAL, 0, 1);
        v.weight = 2000;
        vm.prank(alice);
        vm.expectRevert(StakingMigrator.InvalidVoucherSignature.selector);
        migrator.claimRestake(PRINCIPAL, FAR_DEADLINE, _noPermit(), v);
    }

    function test_Voucher_WrongRouteIsRejected() public {
        StakingMigrator.Voucher memory v = _voucher(migrator, alice, 1, PRINCIPAL, REWARD, 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StakingMigrator.WrongRoute.selector, 3, 1));
        migrator.claimRestake(PRINCIPAL, FAR_DEADLINE, _noPermit(), v);
    }

    function test_Voucher_ExpiredIsRejected() public {
        StakingMigrator.Voucher memory v =
            _voucherSignedBy(migrator, migratorSignerPk, alice, 3, PRINCIPAL, 0, WEIGHT, 1, block.timestamp);
        vm.warp(block.timestamp + 1);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(StakingMigrator.VoucherExpired.selector, block.timestamp - 1, block.timestamp)
        );
        migrator.claimRestake(PRINCIPAL, FAR_DEADLINE, _noPermit(), v);
    }

    function test_Voucher_PrincipalAboveEligibleIsRejected() public {
        StakingMigrator.Voucher memory v = _voucher(migrator, alice, 3, PRINCIPAL, 0, 1);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(StakingMigrator.PrincipalExceedsEligible.selector, PRINCIPAL + 1, PRINCIPAL)
        );
        migrator.claimRestake(PRINCIPAL + 1, FAR_DEADLINE, _noPermit(), v);
    }

    function test_Voucher_RewardAboveEligibleIsRejected() public {
        StakingMigrator.Voucher memory v = _voucher(migrator, alice, 1, PRINCIPAL, REWARD, 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StakingMigrator.RewardExceedsEligible.selector, REWARD + 1, REWARD));
        migrator.compound(REWARD + 1, PRINCIPAL, 0, FAR_DEADLINE, _noPermit(), _noPermit(), v);
    }

    function test_Call_ExpiredDeadlineIsRejected() public {
        StakingMigrator.Voucher memory v = _voucher(migrator, alice, 3, PRINCIPAL, 0, 1);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(StakingMigrator.DeadlineExpired.selector, block.timestamp - 1, block.timestamp)
        );
        migrator.claimRestake(PRINCIPAL, block.timestamp - 1, _noPermit(), v);
    }

    function test_Voucher_TheWeightIsBoundedByThePool() public {
        StakingMigrator.Voucher memory v =
            _voucherSignedBy(migrator, migratorSignerPk, alice, 3, PRINCIPAL, 0, 2001, 1, FAR_DEADLINE);
        vm.prank(alice);
        vm.expectRevert(bytes("Invalid weight"));
        migrator.claimRestake(PRINCIPAL, FAR_DEADLINE, _noPermit(), v);
    }

    function test_Voucher_TheDigestIsTheTypedTransitionVoucher() public view {
        bytes32 typehash = keccak256(
            "TransitionVoucher(address user,uint8 route,uint256 eligiblePrincipal,uint256 eligibleReward,uint256 weight,uint256 nonce,uint256 deadline)"
        );
        assertEq(migrator.TRANSITION_VOUCHER_TYPEHASH(), typehash);
        bytes32 domain = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH, keccak256("StakingMigrator"), keccak256("1"), block.chainid, address(migrator)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(typehash, alice, uint8(2), uint256(5), uint256(6), uint256(1200), uint256(9), uint256(10))
        );
        assertEq(
            migrator.voucherDigest(alice, 2, 5, 6, 1200, 9, 10),
            keccak256(abi.encodePacked("\x19\x01", domain, structHash))
        );
    }

    // ──────────────────────── Route 2: join LP ─────────────────

    function _moveAlice() internal returns (uint256 tokenId, uint256 usdcUsed) {
        StakingMigrator.Voucher memory v = _voucher(migrator, alice, 2, PRINCIPAL, REWARD, 1);
        uint256 usdcBefore = usdcToken.balanceOf(alice);
        vm.prank(alice);
        tokenId = migrator.moveToLp(REWARD, PRINCIPAL, 0, 0, FAR_DEADLINE, _noPermit(), _noPermit(), v);
        usdcUsed = usdcBefore - usdcToken.balanceOf(alice);
    }

    function test_MoveToLp_MintsTheBandAndStakesTheNftForTheCaller() public {
        (int24 lower, int24 upper) = migrator.lpRange();
        uint256 assetBefore = asset.balanceOf(alice);
        (uint256 tokenId, uint256 usdcUsed) = _moveAlice();

        assertEq(mathVault.stakerOf(tokenId), alice, "the NFT is staked for alice");
        assertEq(mathNpm.ownerOf(tokenId), address(mathVault));
        (,,,,, int24 tl, int24 tu, uint128 liq,,,,) = mathNpm.positions(tokenId);
        assertEq(tl, lower);
        assertEq(tu, upper);
        assertEq(tl, PRICE_TICK - 6932, "spacing 1: exactly -6,932 ticks");
        assertEq(tu, PRICE_TICK + 6932, "spacing 1: exactly +6,932 ticks");
        assertGt(liq, 0);
        assertEq(asset.balanceOf(alice), assetBefore - PRINCIPAL, "no $ASSET comes back: the rest is staked");
        assertGt(usdcUsed, REWARD * 9999 / 10_000, "the position takes (almost) all the USDC");
        assertEq(asset.balanceOf(address(migrator)), 0);
        assertEq(usdcToken.balanceOf(address(migrator)), 0);
    }

    function test_MoveToLp_SplitsTheBonusBetweenThePositionAndTheRemainder() public {
        (uint256 tokenId, uint256 usdcUsed) = _moveAlice();
        (uint256 v3Amount,,,) = poolV3.stakes(alice);
        uint256 assetUsed = PRINCIPAL - v3Amount;
        // A symmetric band is a 50/50 value split: $1,000 of USDC pairs with ~4,000 $ASSET.
        assertApproxEqRel(assetUsed, 4_000e18, 0.01e18);

        uint256 lpBonus = (assetUsed + migrator.usdcInAsset(usdcUsed)) * 1000 / 10_000;
        (address user, uint256 amount, uint64 unlockAt, bool claimed, bool forfeited) =
            bonusVault.lpReservation(tokenId);
        assertEq(user, alice);
        assertEq(amount, lpBonus, "10 % of the LP legs, USDC valued at the mean tick");
        assertEq(unlockAt, v3End);
        assertFalse(claimed);
        assertFalse(forfeited);
        (uint256 v3Bonus,) = bonusVault.reservedOf(alice);
        assertEq(v3Bonus, v3Amount * 1000 / 10_000, "10 % of the remainder");
        assertEq(bonusVault.totalReserved(), lpBonus + v3Bonus);
        uint256[] memory ids = bonusVault.lpTokensOf(alice);
        assertEq(ids.length, 1);
        assertEq(ids[0], tokenId);
    }

    function test_MoveToLp_RefundsTheUsdcThePositionCannotPair() public {
        // 1,000 $ASSET can pair with only ~$250 of USDC: the rest comes back, nothing goes to v3.
        uint256 principal = 1_000e18;
        StakingMigrator.Voucher memory v = _voucher(migrator, alice, 2, principal, REWARD, 1);
        uint256 usdcBefore = usdcToken.balanceOf(alice);
        vm.prank(alice);
        uint256 tokenId = migrator.moveToLp(REWARD, principal, 0, 0, FAR_DEADLINE, _noPermit(), _noPermit(), v);

        uint256 usdcUsed = usdcBefore - usdcToken.balanceOf(alice);
        assertApproxEqRel(usdcUsed, 250e6, 0.01e18, "the matching USDC only");
        (uint256 v3Amount,,,) = poolV3.stakes(alice);
        assertLe(v3Amount, 1e15, "at most rounding dust is left for v3");
        (, uint256 lpAmount,,,) = bonusVault.lpReservation(tokenId);
        assertGt(lpAmount, 0);
    }

    function test_MoveToLp_EmitsTheRouteEvent() public {
        StakingMigrator.Voucher memory v = _voucher(migrator, alice, 2, PRINCIPAL, REWARD, 1);
        vm.recordLogs();
        vm.prank(alice);
        uint256 tokenId = migrator.moveToLp(REWARD, PRINCIPAL, 0, 0, FAR_DEADLINE, _noPermit(), _noPermit(), v);
        bytes32 topic = keccak256("MovedToLp(address,uint256,uint256,uint256,uint256,uint256,uint256)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool seen;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter == address(migrator) && logs[i].topics[0] == topic) {
                assertEq(uint256(logs[i].topics[1]), uint256(uint160(alice)));
                assertEq(uint256(logs[i].topics[2]), tokenId);
                seen = true;
            }
        }
        assertTrue(seen, "MovedToLp emitted");
    }

    function test_MoveToLp_RevertsWhilePaused() public {
        migrator.pauseCompound();
        StakingMigrator.Voucher memory v = _voucher(migrator, alice, 2, PRINCIPAL, REWARD, 1);
        vm.prank(alice);
        vm.expectRevert(StakingMigrator.CompoundIsPaused.selector);
        migrator.moveToLp(REWARD, PRINCIPAL, 0, 0, FAR_DEADLINE, _noPermit(), _noPermit(), v);
    }

    function test_MoveToLp_RevertsOnZeroAmounts() public {
        StakingMigrator.Voucher memory v = _voucher(migrator, alice, 2, PRINCIPAL, REWARD, 1);
        vm.startPrank(alice);
        vm.expectRevert(StakingMigrator.ZeroAmount.selector);
        migrator.moveToLp(0, PRINCIPAL, 0, 0, FAR_DEADLINE, _noPermit(), _noPermit(), v);
        vm.expectRevert(StakingMigrator.ZeroAmount.selector);
        migrator.moveToLp(REWARD, 0, 0, 0, FAR_DEADLINE, _noPermit(), _noPermit(), v);
        vm.stopPrank();
    }

    function test_MoveToLp_RevertsWhenSpotIsOutsideTheTwapBound() public {
        mathPool.setCurrentTick(PRICE_TICK - int24(SWAP_DEVIATION_TICKS) - 1);
        StakingMigrator.Voucher memory v = _voucher(migrator, alice, 2, PRINCIPAL, REWARD, 1);
        vm.prank(alice);
        vm.expectRevert();
        migrator.moveToLp(REWARD, PRINCIPAL, 0, 0, FAR_DEADLINE, _noPermit(), _noPermit(), v);
    }

    function test_MoveToLp_TheMintMinimumsAreEnforced() public {
        StakingMigrator.Voucher memory v = _voucher(migrator, alice, 2, PRINCIPAL, REWARD, 1);
        vm.prank(alice);
        vm.expectRevert(bytes("Price slippage check"));
        migrator.moveToLp(REWARD, PRINCIPAL, PRINCIPAL, 0, FAR_DEADLINE, _noPermit(), _noPermit(), v);
    }

    function test_MoveToLp_RevertsWhileTheVaultPausesDeposits() public {
        mathVault.pauseDeposits();
        StakingMigrator.Voucher memory v = _voucher(migrator, alice, 2, PRINCIPAL, REWARD, 1);
        vm.prank(alice);
        vm.expectRevert(LPStakingVault.DepositsArePaused.selector);
        migrator.moveToLp(REWARD, PRINCIPAL, 0, 0, FAR_DEADLINE, _noPermit(), _noPermit(), v);
    }

    function test_MoveToLp_ZeroLpRateReservesNothing() public {
        migrator.setRates(1000, 0, 500);
        StakingMigrator.Voucher memory v = _voucher(migrator, alice, 2, PRINCIPAL, REWARD, 1);
        vm.prank(alice);
        uint256 tokenId = migrator.moveToLp(REWARD, PRINCIPAL, 0, 0, FAR_DEADLINE, _noPermit(), _noPermit(), v);
        (address user,,,,) = bonusVault.lpReservation(tokenId);
        assertEq(user, address(0));
        assertEq(bonusVault.totalReserved(), 0);
    }

    // ──────────────────────── Route 3: claim and restake ───────

    function test_ClaimRestake_StakesThePrincipalAndReservesFivePercent() public {
        uint256 usdcBefore = usdcToken.balanceOf(alice);
        StakingMigrator.Voucher memory v = _voucher(migrator, alice, 3, PRINCIPAL, REWARD, 1);
        vm.expectEmit(address(migrator));
        emit StakingMigrator.ClaimRestaked(alice, PRINCIPAL, PRINCIPAL * 500 / 10_000);
        vm.prank(alice);
        uint256 b = migrator.claimRestake(PRINCIPAL, FAR_DEADLINE, _noPermit(), v);
        assertEq(b, 1_000e18);
        assertEq(usdcToken.balanceOf(alice), usdcBefore, "the USDC stays in the wallet");
        (uint256 amount,,,) = poolV3.stakes(alice);
        assertEq(amount, PRINCIPAL);
        (uint256 reserved,) = bonusVault.reservedOf(alice);
        assertEq(reserved, 1_000e18);
    }

    function test_ClaimRestake_IsNeverPaused() public {
        migrator.pauseCompound();
        StakingMigrator.Voucher memory v = _voucher(migrator, alice, 3, PRINCIPAL, 0, 1);
        vm.prank(alice);
        migrator.claimRestake(PRINCIPAL, FAR_DEADLINE, _noPermit(), v);
        (uint256 amount,,,) = poolV3.stakes(alice);
        assertEq(amount, PRINCIPAL);
    }

    function test_ClaimRestake_RevertsOnZero() public {
        StakingMigrator.Voucher memory v = _voucher(migrator, alice, 3, PRINCIPAL, 0, 1);
        vm.prank(alice);
        vm.expectRevert(StakingMigrator.ZeroAmount.selector);
        migrator.claimRestake(0, FAR_DEADLINE, _noPermit(), v);
    }

    function test_ClaimRestake_RevertsAfterThePoolEnded() public {
        vm.warp(v3End);
        StakingMigrator.Voucher memory v = _voucher(migrator, alice, 3, PRINCIPAL, 0, 1);
        vm.prank(alice);
        vm.expectRevert(bytes("Pool has ended"));
        migrator.claimRestake(PRINCIPAL, FAR_DEADLINE, _noPermit(), v);
    }

    // ──────────────────────── Pause and admin tiers ────────────

    function test_Pause_GuardianOrOperatorPausesOnlyTheOperatorUnpauses() public {
        address guardian_ = makeAddr("v3Guardian");
        address operator_ = makeAddr("v3Operator");
        mathVault.setGuardian(guardian_);
        mathVault.setOperator(operator_);

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(StakingMigrator.NotGuardianOrOperator.selector, stranger, guardian_, operator_)
        );
        migrator.pauseCompound();

        vm.expectEmit(address(migrator));
        emit StakingMigrator.CompoundPaused(guardian_);
        vm.prank(guardian_);
        migrator.pauseCompound();
        assertTrue(migrator.compoundPaused());

        vm.prank(guardian_);
        vm.expectRevert(abi.encodeWithSelector(StakingMigrator.NotOperator.selector, guardian_, operator_));
        migrator.unpauseCompound();

        vm.prank(operator_);
        migrator.pauseCompound();
        vm.expectEmit(address(migrator));
        emit StakingMigrator.CompoundUnpaused(operator_);
        vm.prank(operator_);
        migrator.unpauseCompound();
        assertFalse(migrator.compoundPaused());
    }

    function test_SetSigner_OperatorOnlyNonZeroAndEffective() public {
        address operator_ = makeAddr("v3Operator");
        mathVault.setOperator(operator_);
        vm.expectRevert(abi.encodeWithSelector(StakingMigrator.NotOperator.selector, address(this), operator_));
        migrator.setSigner(bob);

        vm.prank(operator_);
        vm.expectRevert(StakingMigrator.ZeroAddress.selector);
        migrator.setSigner(address(0));

        vm.expectEmit(address(migrator));
        emit StakingMigrator.SignerSet(migratorSigner, bob);
        vm.prank(operator_);
        migrator.setSigner(bob);
        assertEq(migrator.signer(), bob);

        // The old signer's vouchers stop working.
        StakingMigrator.Voucher memory v = _voucher(migrator, alice, 3, PRINCIPAL, 0, 1);
        vm.prank(alice);
        vm.expectRevert(StakingMigrator.InvalidVoucherSignature.selector);
        migrator.claimRestake(PRINCIPAL, FAR_DEADLINE, _noPermit(), v);
    }

    function test_SetTwapParams_OperatorOnly() public {
        migrator.setTwapParams(600, 500);
        assertEq(migrator.twapWindow(), 600);
        assertEq(migrator.maxTwapDeviationTicks(), 500);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(StakingMigrator.NotOperator.selector, stranger, address(this)));
        migrator.setTwapParams(600, 500);
    }

    function test_SetRates_OwnerOnlyAndBounded() public {
        vm.expectEmit(address(migrator));
        emit StakingMigrator.RatesSet(1, 2, 3);
        migrator.setRates(1, 2, 3);
        assertEq(migrator.compoundBps(), 1);
        assertEq(migrator.lpBps(), 2);
        assertEq(migrator.restakeBps(), 3);

        vm.expectRevert(abi.encodeWithSelector(StakingMigrator.InvalidRate.selector, 10_001));
        migrator.setRates(10_001, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(StakingMigrator.InvalidRate.selector, 10_001));
        migrator.setRates(0, 10_001, 0);
        vm.expectRevert(abi.encodeWithSelector(StakingMigrator.InvalidRate.selector, 10_001));
        migrator.setRates(0, 0, 10_001);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        migrator.setRates(1, 1, 1);
    }

    function test_Owner_RenounceIsDisabledAndUpgradeIsOwnerOnly() public {
        vm.expectRevert(StakingMigrator.RenounceDisabled.selector);
        migrator.renounceOwnership();

        address impl = _deployMigratorImpl(address(mathVault), address(usdcToken), address(asset));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        migrator.upgradeToAndCall(impl, "");
        migrator.upgradeToAndCall(impl, "");
        assertEq(migrator.compoundBps(), 1000, "state survives the upgrade");
    }

    // ──────────────────────── Construction and initialization ─

    function test_Initialize_DefaultsAndBornPaused() public {
        StakingMigrator m = _deployMigrator(address(mathVault), address(usdcToken), address(asset), poolV3, bonusVault);
        assertTrue(m.compoundPaused(), "born paused");
        assertEq(m.compoundBps(), 1000);
        assertEq(m.lpBps(), 1000);
        assertEq(m.restakeBps(), 500);
        assertEq(m.valuationWindow(), VALUATION_WINDOW);
        assertEq(m.twapWindow(), MIN_TWAP_WINDOW);
        assertEq(m.maxTwapDeviationTicks(), SWAP_DEVIATION_TICKS);
        assertEq(m.stakingPool(), address(poolV3));
        assertEq(m.bonusVault(), address(bonusVault));
        assertEq(m.signer(), migratorSigner);
        assertEq(m.owner(), address(this));
        assertEq(address(m.lpVault()), address(mathVault));
        assertEq(address(m.positionManager()), address(mathNpm));
        assertEq(address(m.swapRouter()), address(routerMock));
        assertEq(address(m.pool()), address(mathPool));
        assertEq(m.usdc(), address(usdcToken));
        assertEq(m.asset(), address(asset));
        assertEq(m.fee(), MATH_FEE);
        assertEq(m.tickSpacing(), 1);
        assertTrue(m.assetIsToken0());
    }

    function test_Initialize_ImplementationIsLocked() public {
        StakingMigrator impl =
            StakingMigrator(_deployMigratorImpl(address(mathVault), address(usdcToken), address(asset)));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(address(this), address(poolV3), address(bonusVault), migratorSigner, 300, 953, 1800);
    }

    function test_Initialize_RejectsZeroAddresses() public {
        address impl = _deployMigratorImpl(address(mathVault), address(usdcToken), address(asset));
        address[3] memory pools_ = [address(0), address(poolV3), address(poolV3)];
        address[3] memory bonuses = [address(bonusVault), address(0), address(bonusVault)];
        address[3] memory signers = [migratorSigner, migratorSigner, address(0)];
        for (uint256 i = 0; i < 3; ++i) {
            vm.expectRevert(StakingMigrator.ZeroAddress.selector);
            new LPProxy(
                impl,
                abi.encodeCall(
                    StakingMigrator.initialize, (address(this), pools_[i], bonuses[i], signers[i], 300, 953, 1800)
                )
            );
        }
    }

    function test_Initialize_RejectsAValuationWindowOutOfBounds() public {
        address impl = _deployMigratorImpl(address(mathVault), address(usdcToken), address(asset));
        vm.expectRevert(abi.encodeWithSelector(StakingMigrator.InvalidValuationWindow.selector, 299, 300, 3600));
        new LPProxy(
            impl,
            abi.encodeCall(
                StakingMigrator.initialize,
                (address(this), address(poolV3), address(bonusVault), migratorSigner, 300, 953, 299)
            )
        );
        vm.expectRevert(abi.encodeWithSelector(StakingMigrator.InvalidValuationWindow.selector, 3601, 300, 3600));
        new LPProxy(
            impl,
            abi.encodeCall(
                StakingMigrator.initialize,
                (address(this), address(poolV3), address(bonusVault), migratorSigner, 300, 953, 3601)
            )
        );
    }

    function test_Initialize_RequiresThePoolToServeTheValuationWindow() public {
        address impl = _deployMigratorImpl(address(mathVault), address(usdcToken), address(asset));
        mathPool.setHistorySeconds(1000);
        vm.expectRevert(abi.encodeWithSelector(OracleHistory.HistoryTooShort.selector, uint32(1800)));
        new LPProxy(
            impl,
            abi.encodeCall(
                StakingMigrator.initialize,
                (address(this), address(poolV3), address(bonusVault), migratorSigner, 300, 953, 1800)
            )
        );
    }

    function test_Constructor_RejectsZeroAndForeignTokens() public {
        vm.expectRevert(StakingMigrator.ZeroAddress.selector);
        new StakingMigrator(address(mathVault), address(0), address(asset));
        vm.expectRevert(StakingMigrator.ZeroAddress.selector);
        new StakingMigrator(address(mathVault), address(usdcToken), address(0));
        vm.expectRevert(
            abi.encodeWithSelector(
                StakingMigrator.TokenPairMismatch.selector, address(usdcToken), carol, token0, token1
            )
        );
        new StakingMigrator(address(mathVault), address(usdcToken), carol);
    }

    // ──────────────────────── Band and valuation math ──────────

    function test_LpRange_RoundsOutwardToTheSpacing() public {
        // The local rung's pool: fee 3000, spacing 60, tick 0.
        StakingMigrator m = StakingMigrator(_deployMigratorImpl(address(vault), address(usdcToken), address(asset)));
        (int24 lower, int24 upper) = m.lpRange();
        assertEq(lower, -6960, "-6932 rounded down to the 60 grid");
        assertEq(upper, 6960, "+6932 rounded up to the 60 grid");

        poolMock.setCurrentTick(-61);
        (lower, upper) = m.lpRange();
        assertEq(lower, -7020, "-6993 rounded down");
        assertEq(upper, 6900, "6871 rounded up");

        poolMock.setCurrentTick(60);
        (lower, upper) = m.lpRange();
        assertEq(lower, -6900, "-6872 rounded down");
        assertEq(upper, 7020, "6992 rounded up");
    }

    function test_LpRange_ClampsToTheUsableTicks() public {
        StakingMigrator m = StakingMigrator(_deployMigratorImpl(address(vault), address(usdcToken), address(asset)));
        poolMock.setCurrentTick(TickMath.MAX_TICK - 100);
        (, int24 upper) = m.lpRange();
        assertEq(upper, MAX_TICK_ALIGNED);
        poolMock.setCurrentTick(TickMath.MIN_TICK + 100);
        (int24 lower,) = m.lpRange();
        assertEq(lower, MIN_TICK_ALIGNED);
    }

    function test_UsdcInAsset_ValuesAtTheMeanTickNotTheSpot() public {
        uint256 atMean = migrator.usdcInAsset(1_000e6);
        assertApproxEqRel(atMean, 4_000e18, 0.001e18, "$1,000 at $0.25");
        mathPool.setCurrentTick(PRICE_TICK + 500); // the spot moves, the mean does not
        assertEq(migrator.usdcInAsset(1_000e6), atMean);
        mathPool.setTwapTick(PRICE_TICK + 6932); // the mean doubles the $ASSET price
        assertApproxEqRel(migrator.usdcInAsset(1_000e6), 2_000e18, 0.001e18);
    }

    // ──────────────────────── Flipped orientation ──────────────

    function test_Flipped_AllRoutesWorkWithUsdcAsToken0() public {
        _deployFlippedRung();
        assertFalse(flippedMigrator.assetIsToken0());
        assertApproxEqRel(flippedMigrator.usdcInAsset(1_000e6), 4_000e18, 0.001e18);

        vm.startPrank(alice);
        flippedAsset.approve(address(flippedMigrator), type(uint256).max);
        usdcToken.approve(address(flippedMigrator), type(uint256).max);
        (uint256 staked,) = flippedMigrator.compound(
            REWARD,
            PRINCIPAL,
            0,
            FAR_DEADLINE,
            _noPermit(),
            _noPermit(),
            _voucher(flippedMigrator, alice, 1, PRINCIPAL, REWARD, 1)
        );
        assertEq(staked, PRINCIPAL + 4_000e18);

        uint256 tokenId = flippedMigrator.moveToLp(
            REWARD,
            PRINCIPAL,
            0,
            0,
            FAR_DEADLINE,
            _noPermit(),
            _noPermit(),
            _voucher(flippedMigrator, alice, 2, PRINCIPAL, REWARD, 2)
        );
        vm.stopPrank();
        assertEq(flippedVault.stakerOf(tokenId), alice);
        (, uint256 lpAmount,,,) = flippedBonusVault.lpReservation(tokenId);
        assertApproxEqRel(lpAmount, 800e18, 0.02e18, "10 % of ~$2,000 = ~8,000 $ASSET");
    }
}
