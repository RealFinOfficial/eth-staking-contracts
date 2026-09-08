// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Profiles} from "./Profiles.sol";

import {LPStakingVault} from "../../../contracts/lp-staking/LPStakingVault.sol";
import {RewardsDistributor} from "../../../contracts/lp-staking/RewardsDistributor.sol";
import {LPProxy} from "../../../contracts/lp-staking/deploy/LPProxy.sol";

/**
 * @title BaseForge
 * @notice Bottom rung of the harness ladder: constants, the active network profile, and
 *         the fork-RPC resolution rule. Nothing is deployed here.
 *
 *  It deliberately has **no `setUp()`**. Every rung above is `abstract` and exposes a
 *  `_deployX()`; each concrete `*.t.sol` picks the lowest rung it needs and writes its own
 *  `setUp()` calling that. A `setUp()` here would force every test file to pay for a stack
 *  it may not use.
 *
 *  ── Skip vs fail ─────────────────────────────────────────────────────────────────────
 *  The rule is the shipped Hardhat fork suite's, one-sided and identical:
 *
 *    * No endpoint resolved AND the operator configured none  -> `vm.skip`. That is an
 *      environment fact (no `.env`, no network), not a defect, so `forge test` stays green
 *      on a bare machine.
 *    * No endpoint resolved but the operator DID configure one -> fail. Asking for the fork
 *      tier and not getting it is a defect.
 *    * An endpoint resolved but the fork cannot be established -> fail, loudly, wherever
 *      `vm.createSelectFork` reverts. Never converted into a skip.
 *
 *  `scripts/run-forge.mjs` does the resolving (forge does not read `.env`) and exports both
 *  `SEPOLIA_RPC_URL`/`MAINNET_RPC_URL` and `LP_FORK_RPC_REQUIRED`. Running bare `forge test`
 *  without the wrapper simply means nothing is exported, which lands on the skip arm.
 */
abstract contract BaseForge is Test {
    // ──────────────────────── Pool constants ───────────────────

    /// @notice Fee tier of the ASSET/USDC pool on both profiles, in hundredths of a bip.
    uint24 internal constant FEE = 3000;
    /// @notice Tick spacing that Uniswap pairs with the 0.30% tier.
    int24 internal constant TICK_SPACING = 60;
    /// @notice Widest usable ticks, aligned down/up to {TICK_SPACING}.
    int24 internal constant MIN_TICK_ALIGNED = -887220;
    int24 internal constant MAX_TICK_ALIGNED = 887220;

    // ──────────────────────── Guard constants ──────────────────

    /// @notice TwapGuard.MIN_TWAP_WINDOW, re-declared so a change to the contract fails a test.
    uint32 internal constant MIN_TWAP_WINDOW = 300;
    /// @notice TwapGuard.MAX_TWAP_WINDOW, re-declared for the same reason.
    uint32 internal constant MAX_TWAP_WINDOW = 3600;
    /// @notice TwapGuard.MAX_TWAP_DEVIATION_TICKS, re-declared for the same reason.
    ///         1823 = floor(ln 1.2 / ln 1.0001), a 20% price move.
    uint24 internal constant MAX_TWAP_DEVIATION_TICKS = 1823;

    // ──────────────────────── Test parameters ──────────────────

    /// @dev Far enough that no test ever trips a Uniswap deadline by accident.
    uint256 internal constant FAR_DEADLINE = 10 ** 12;
    uint128 internal constant MAX_UINT128 = type(uint128).max;

    /// @dev TokenX branding is a deploy-time decision; the Hardhat suites' placeholder is reused.
    string internal constant TOKENX_NAME = "Token X";
    string internal constant TOKENX_SYMBOL = "TKX";

    /// @dev Epoch armed by the harness. Production arms this through LP_EPOCH_ID/LP_EPOCH_CAP.
    uint256 internal constant EPOCH_ONE = 1;
    uint256 internal constant EPOCH_ONE_CAP = 1e24; // 1,000,000 TokenX

    // ──────────────────────── Profile ──────────────────────────

    /// @notice The network facts every test in this tier is written against.
    Profiles.Profile internal profile;

    /// @dev Loads `LP_TEST_PROFILE` (default "sepolia") into {profile}. Idempotent.
    function _loadProfile() internal {
        profile = Profiles.byName(vm.envOr("LP_TEST_PROFILE", string("sepolia")));
    }

    // ──────────────────────── Fork RPC ─────────────────────────

    /**
     * @dev Resolves the endpoint for {profile} and applies the skip-vs-fail rule above.
     *      Returns the URL; the caller passes it straight to `vm.createSelectFork`.
     */
    function _resolveForkRpc() internal returns (string memory url) {
        string memory key =
            keccak256(bytes(profile.name)) == keccak256("mainnet") ? "MAINNET_RPC_URL" : "SEPOLIA_RPC_URL";
        url = vm.envOr(key, string(""));
        if (bytes(url).length > 0) return url;

        if (vm.envOr("LP_FORK_RPC_REQUIRED", false)) {
            revert(
                string.concat(
                    "fork RPC required but unresolved for profile '",
                    profile.name,
                    "': ",
                    key,
                    " is empty. An operator configured an endpoint, so this is a defect, not an environment fact."
                )
            );
        }

        vm.skip(
            true,
            string.concat(
                "no archive endpoint for profile '",
                profile.name,
                "'. Run `npm run test:forge` (it resolves ",
                key,
                " from .env / INFURA_API_KEY / public archive endpoints), or set ",
                key,
                " yourself."
            )
        );
    }

    // ──────────────────────── Proxy deployment ─────────────────

    /**
     * @notice Deploys the distributor the way production does: an implementation carrying the
     *         two immutables, then an {LPProxy} whose constructor delegatecalls `initialize`.
     * @dev Lives on this rung rather than on one harness because BOTH {LocalHarness} and
     *      {ForkHarness} need the identical two-transaction shape, and a test that deploys a
     *      bare implementation instead would be testing a contract nobody deploys.
     */
    function _deployDistributorProxy(
        address tokenX_,
        address asset_,
        address owner_,
        address guardian_,
        address signer_
    ) internal returns (RewardsDistributor) {
        RewardsDistributor impl = new RewardsDistributor(tokenX_, asset_);
        LPProxy proxy =
            new LPProxy(address(impl), abi.encodeCall(RewardsDistributor.initialize, (owner_, guardian_, signer_)));
        return RewardsDistributor(address(proxy));
    }

    /**
     * @notice Deploys the vault the way production does: an implementation carrying the six
     *         immutables (and running the live pool triple check on them), then an {LPProxy}
     *         whose constructor delegatecalls `initialize`.
     * @dev Same reason as {_deployDistributorProxy} for living on this rung: {LocalHarness},
     *      {ForkHarness} and the two guard-math files all need the identical two-transaction
     *      shape, and a bare implementation is a contract nobody deploys — its `initialize`
     *      is burnt, so it has no storage to test against at all.
     */
    function _deployVaultProxy(
        address positionManager_,
        address pool_,
        address token0_,
        address token1_,
        uint24 fee_,
        address swapRouter_,
        address owner_,
        address guardian_,
        uint32 twapWindow_,
        uint24 maxDeviationTicks_
    ) internal returns (LPStakingVault) {
        address impl = _deployVaultImpl(positionManager_, pool_, token0_, token1_, fee_, swapRouter_);
        LPProxy proxy = new LPProxy(
            impl, abi.encodeCall(LPStakingVault.initialize, (owner_, guardian_, twapWindow_, maxDeviationTicks_))
        );
        return LPStakingVault(address(proxy));
    }

    /**
     * @dev The vault implementation's `new`, in a frame of its own. Nothing else lives here.
     *
     *      This split is a BUILD requirement, not a style choice. Foundry's test preprocessor
     *      ("dynamic test linking") rewrites every `new X(...)` in a test source into a
     *      generated `FoundryPpConstructorArgs(...)` call plus a create, and that rewrite costs
     *      extra stack slots at the site. Inside {_deployVaultProxy} — ten parameters, a return
     *      slot and two locals already live — the six constructor arguments then push
     *      `positionManager_` one slot past the EVM's sixteen, and solc 0.8.28 fails the build
     *      with "Stack too deep" (LValue.cpp) pointing at the rewritten line.
     *
     *      The preprocessor is off by default in forge 1.7.1 and on in the `stable` toolchain
     *      CI installs, so this broke CI only. Reproduce it locally with
     *      `forge build --dynamic-test-linking`. Six parameters and no other live values leave
     *      the site far under the limit either way.
     *
     *      The alternative fixes are both worse: `via_ir` would make Foundry and Hardhat compile
     *      different bytecode (foundry.toml's opening note), and pinning the preprocessor off in
     *      foundry.toml would hide the problem rather than remove it.
     */
    function _deployVaultImpl(
        address positionManager_,
        address pool_,
        address token0_,
        address token1_,
        uint24 fee_,
        address swapRouter_
    ) private returns (address) {
        return address(new LPStakingVault(positionManager_, pool_, token0_, token1_, fee_, swapRouter_));
    }

    // ──────────────────────── Tick helpers ─────────────────────

    /// @dev Largest usable tick <= `tick`. Uniswap rejects a mint on an unaligned bound.
    function _alignDown(int24 tick) internal pure returns (int24) {
        int24 aligned = (tick / TICK_SPACING) * TICK_SPACING;
        if (tick < 0 && tick % TICK_SPACING != 0) aligned -= TICK_SPACING;
        return aligned;
    }

    /// @dev Smallest usable tick >= `tick`.
    function _alignUp(int24 tick) internal pure returns (int24) {
        int24 down = _alignDown(tick);
        return down == tick ? down : down + TICK_SPACING;
    }

    /// @dev |a - b| for ticks. Widened to int256 first so neither the subtraction nor the
    ///      negation can wrap at the int24 extremes.
    function _tickDistance(int24 a, int24 b) internal pure returns (uint256) {
        int256 d = int256(a) - int256(b);
        return d >= 0 ? uint256(d) : uint256(-d);
    }
}
