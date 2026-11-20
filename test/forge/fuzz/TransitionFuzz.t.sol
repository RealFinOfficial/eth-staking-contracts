// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {TransitionHarness} from "../utils/TransitionHarness.sol";
import {StakingMigratorBase} from "../../../contracts/staking-v3/StakingMigratorBase.sol";
import {ITransitionMigrator} from "../../../contracts/staking-v3/interfaces/ITransition.sol";

/**
 * @notice Fuzzed properties of the transition (spec 01 §9.9): the receiving address is the CREATE2
 *         formula for any holder and route; deliveries in any number of parts never exceed the
 *         voucher's limits and the limits never exceed the eligible amounts; the swap floor for any
 *         limit, amount and fill; route 2's matching amount for any USDC amount; the bonus by the
 *         burn time on both sides of the cutoff. Runs in both token orders (`LP_TOKEN_ORDER`).
 */
contract TransitionFuzzTest is TransitionHarness {
    function setUp() public {
        _deployTransition();
    }

    function testFuzz_ReceivingAddressIsTheCreate2Formula(address holder, uint8 routeSeed) public view {
        vm.assume(holder != address(0));
        uint8 route = uint8(bound(routeSeed, 1, 3));
        bytes32 salt = keccak256(abi.encode(holder, route));
        assertEq(
            receiver.receivingAddressOf(holder, route),
            vm.computeCreate2Address(salt, receiver.HOLDER_INIT_CODE_HASH(), address(receiver))
        );
    }

    /// @dev Route 3 in up to six parts with a voucher per part whose limit is any value up to the
    ///      eligible amount: the totals never pass the limit, the stake equals the total, the rest
    ///      waits at the address.
    function testFuzz_PartsNeverExceedTheVoucher(uint256 eligible, uint256[6] memory parts, uint256[6] memory limits)
        public
    {
        eligible = bound(eligible, 1e18, 1_000_000e18);
        uint256 paid;
        for (uint256 i = 0; i < 6; ++i) {
            uint256 part = bound(parts[i], 0, eligible);
            if (part > 0) _payAsset(alice, R3, part);
            paid += part;
            uint256 limit = bound(limits[i], 0, eligible);
            ITransitionMigrator.DeliveryVoucher memory v = _dvAt(alice, R3, eligible, 0, limit, 0, block.timestamp - 1);
            (uint256 before,,) = _delivered(alice);
            vm.prank(deliverer);
            try receiver.deliver(alice, R3, _limits(), v) returns (ITransitionMigrator.DeliveryResult memory r) {
                (uint256 afterP,,) = _delivered(alice);
                assertLe(afterP, limit, "within the voucher's limit");
                assertLe(limit, eligible, "the limit within the eligible amount");
                assertEq(afterP - before, r.staked);
            } catch {
                (uint256 afterP,,) = _delivered(alice);
                assertEq(afterP, before, "a refused delivery changes nothing");
            }
            (uint256 total,,) = _delivered(alice);
            assertLe(total, eligible);
            assertEq(poolV3.stakes(alice), total, "the stake is the delivered total");
            assertEq(asset.balanceOf(_at(alice, R3)), paid - total, "the rest waits at the address");
        }
    }

    /// @dev The floor is `usdcInAsset(usdc) * (10,000 - bps) / 10,000`; a fill at or above
    ///      `max(floor, minAssetOut)` stakes, a fill below reverts and leaves both tokens in place.
    function testFuzz_SwapFloor(uint16 bpsSeed, uint256 usdcAmount, uint256 rateSeed, uint256 minSeed) public {
        uint16 bps = uint16(bound(bpsSeed, 1, 1000));
        usdcAmount = bound(usdcAmount, 1e6, 1_000_000e6);
        uint256 rate = bound(rateSeed, 3e18, 5e18); // $ASSET per USDC the router fills at
        migrator.setSwapLimitBps(bps);
        routerMock.setRate(address(usdcToken), address(asset), rate, 1e6);
        uint256 floor = migrator.usdcInAsset(usdcAmount) * (10_000 - bps) / 10_000;
        uint256 minOut = bound(minSeed, 0, floor * 2);
        uint256 fill = usdcAmount * rate / 1e6;
        uint256 required = minOut > floor ? minOut : floor;

        _payAsset(alice, R1, 1e18);
        _payUsdc(alice, R1, usdcAmount);
        ITransitionMigrator.DeliveryLimits memory l = _limits();
        l.minAssetOut = minOut;
        ITransitionMigrator.DeliveryVoucher memory v = _dv(alice, R1, 1e18, usdcAmount);
        vm.prank(deliverer);
        if (fill >= required) {
            receiver.deliver(alice, R1, l, v);
            assertEq(routerMock.lastAmountOutMinimum(), required);
            assertEq(poolV3.stakes(alice), 1e18 + fill);
        } else {
            vm.expectRevert(bytes("Too little received"));
            receiver.deliver(alice, R1, l, v);
            assertEq(usdcToken.balanceOf(_at(alice, R1)), usdcAmount, "the USDC waits");
            assertEq(asset.balanceOf(_at(alice, R1)), 1e18, "the $ASSET waits");
        }
    }

    /// @dev For any USDC amount the matching $ASSET is never below what the position takes, and a
    ///      delivery with exactly that much creates the position from (almost) all the USDC.
    function testFuzz_MatchingAssetIsWhatThePositionTakes(uint256 usdcAmount) public {
        usdcAmount = bound(usdcAmount, 1e6, 1_000_000e6);
        uint256 probe = _assetNeededFor(usdcAmount);
        _payUsdc(alice, R2, usdcAmount);
        _payAsset(alice, R2, 1);
        ITransitionMigrator.DeliveryVoucher memory v = _dv(alice, R2, 100_000_000e18, usdcAmount);
        ITransitionMigrator.DeliveryLimits memory l = _limits();
        vm.prank(deliverer);
        try receiver.deliver(alice, R2, l, v) {
            revert("one wei of $ASSET can never match");
        } catch (bytes memory err) {
            uint256 needed;
            assembly ("memory-safe") {
                needed := mload(add(err, 36))
            }
            assertEq(bytes4(err), StakingMigratorBase.MatchingAssetNotArrived.selector);
            assertGe(needed, probe);
            assertLe(needed - probe, 2);
            _payAsset(alice, R2, needed - 1);
            ITransitionMigrator.DeliveryResult memory r =
                _deliver(alice, R2, _dv(alice, R2, 100_000_000e18, usdcAmount));
            assertGt(r.lpTokenId, 0);
            assertLe(usdcAmount - r.usdcToLp, usdcAmount / 1e6 + 2, "at most dust is refunded");
        }
    }

    function testFuzz_BonusFollowsTheBurnTime(uint256 burnTime, uint256 deliveredAt) public {
        uint256 cutoff = poolV3.bonusCutoff();
        deliveredAt = bound(deliveredAt, block.timestamp, v3End - 1);
        vm.warp(deliveredAt);
        burnTime = bound(burnTime, 1, deliveredAt);
        _payAsset(alice, R3, 10_000e18);
        ITransitionMigrator.DeliveryResult memory r =
            _deliver(alice, R3, _dvAt(alice, R3, 10_000e18, 0, 10_000e18, 0, burnTime));
        assertEq(r.v3Bonus, burnTime < cutoff ? 500e18 : 0);
    }
}
