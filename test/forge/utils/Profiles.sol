// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title Profiles
 * @notice The one place a network fact lives, so Phase 1 -> Phase 2 is a switch and not a
 *         rewrite.
 *
 *  The whole Foundry tier is written against a {Profile} rather than against literal
 *  addresses. `LP_TEST_PROFILE=sepolia` (the default) runs everything on a fork of Sepolia
 *  with the team's test tokens; `LP_TEST_PROFILE=mainnet` re-runs the identical test bodies
 *  against real ASSET/USDC and the real 0.30% pool. Nothing but this file changes between
 *  the two.
 *
 *  Phase 1 is Sepolia. The mainnet profile is wired here so that graduation costs one
 *  environment variable, but it is NOT the tier that runs today — the shipped Hardhat
 *  mainnet-fork suites remain the mainnet evidence until the team graduates this tier.
 */
library Profiles {
    /**
     * @param name             Profile name, used in assertion messages and skip reasons.
     * @param chainId          Chain id the fork reports (forge keeps the real one, unlike Hardhat).
     * @param pinnedBlock      Fork block. Pinned so every run sees identical state AND so
     *                         forge's per-block RPC cache is shared across every test file.
     * @param factory          Uniswap V3 factory.
     * @param npm              NonfungiblePositionManager.
     * @param router           SwapRouter02.
     * @param asset            The 18-decimal side of the pair (ASSET / tREAL).
     * @param usdc             The 6-decimal side of the pair (USDC / tUSDC), the zap-in token.
     * @param pool             The ASSET/USDC pool, or `address(0)` to create + initialize it
     *                         on the fork (Sepolia has no such pool on any fee tier).
     * @param initialSqrtPriceX96 Price to initialize a created pool at. Ignored when `pool != 0`.
     * @param funders          Addresses holding both tokens, tried in order for `vm.prank`
     *                         transfers before falling back to `deal`.
     * @param usdcPermit       True when the USDC side implements EIP-2612. tUSDC does NOT.
     * @param assetPermit      True when the ASSET side implements EIP-2612. tREAL does NOT.
     * @param twapWindow       TWAP window the harness deploys with, in seconds.
     * @param maxDevTicks      Spot-vs-TWAP ceiling the harness deploys with, in ticks.
     */
    struct Profile {
        string name;
        uint256 chainId;
        uint256 pinnedBlock;
        address factory;
        address npm;
        address router;
        address asset;
        address usdc;
        address pool;
        uint160 initialSqrtPriceX96;
        address[] funders;
        bool usdcPermit;
        bool assetPermit;
        uint32 twapWindow;
        uint24 maxDevTicks;
    }

    /// @dev Fee tier and spacing are the same on both profiles: 0.30% / 60.
    uint24 internal constant FEE = 3000;
    int24 internal constant TICK_SPACING = 60;

    /**
     * @notice Phase 1. Sepolia at a block a few hundred behind the 2026-08-25 head
     *         (11,562,735), served as archive by the company Infura key.
     * @dev tREAL and tUSDC are plain fixed-supply ERC-20s: no owner, no mint, and no
     *      EIP-2612 — hence `usdcPermit = assetPermit = false`. The funder is the address
     *      that holds essentially the whole supply of both (949,839,675 tREAL /
     *      997,989,999 tUSDC at the pinned block).
     */
    function sepolia() internal pure returns (Profile memory p) {
        address[] memory funders = new address[](1);
        funders[0] = 0xBb7403aAF82342A0d987A8603aAf881136B5D125;

        p = Profile({
            name: "sepolia",
            chainId: 11155111,
            pinnedBlock: 11562000,
            factory: 0x0227628f3F023bb0B980b67D528571c95c6DaC1c,
            npm: 0x1238536071E1c677A632429e3655c799b22cDA52,
            router: 0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E,
            asset: 0x8e65d19BE4bA1CC61005B4c70f21cd179512e33f, // "Test REAL", 18 dec -> token0
            usdc: 0x9E0F2263c0Cb67Ee08B8c8A42be8770870b05215, // "TestUSDC", 6 dec -> token1
            pool: address(0), // no tREAL/tUSDC pool exists on any fee tier -> created on the fork
            // 0.5 tUSDC per tREAL, the price the shipped suites and .env.example both use.
            initialSqrtPriceX96: 56022770974786135785472,
            funders: funders,
            usdcPermit: false,
            assetPermit: false,
            twapWindow: 300, // TwapGuard.MIN_TWAP_WINDOW: shortest legal window, shortest warm-up.
            // Production deploys 1800 (scripts/deploy-lp-staking.js LP_TWAP_WINDOW default).
            maxDevTicks: 500
        });
    }

    /**
     * @notice Phase 2 (graduation). Real ASSET/USDC at the block the shipped Hardhat fork
     *         suite pins, so both toolchains see identical pool state.
     * @dev Wired, not exercised, until the team graduates this tier. The funders are the
     *      USDC holders the shipped suite impersonates, largest first; ASSET is acquired by
     *      swapping USDC through the real pool, exactly as that suite does.
     */
    function mainnet() internal pure returns (Profile memory p) {
        address[] memory funders = new address[](5);
        funders[0] = 0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf; // Polygon (Matic) ERC20 bridge
        funders[1] = 0xA9D1e08C7793af67e9d92fe308d5697FB81d3E43; // Coinbase 10
        funders[2] = 0xcEe284F754E854890e311e3280b767F80797180d; // Arbitrum One bridge
        funders[3] = 0x55FE002aefF02F77364de339a1292923A15844B8; // Circle
        funders[4] = 0xf89d7b9c864f589bbF53a82105107622B35EaA40; // Bybit

        p = Profile({
            name: "mainnet",
            chainId: 1,
            pinnedBlock: 25750000,
            factory: 0x1F98431c8aD98523631AE4a59f267346ea31F984,
            npm: 0xC36442b4a4522E871399CD717aBDD847Ab11FE88,
            router: 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45,
            asset: 0x99E980265Bf36516C442be982df1772a6cCb3233, // "REAL", 18 dec, EIP-2612 v"1"
            usdc: 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48, // USDC, 6 dec, EIP-2612 v"2"
            pool: 0xe76532bae172876B6c7170Ce02309715502c360B,
            initialSqrtPriceX96: 0, // unused: the pool already exists
            funders: funders,
            usdcPermit: true,
            assetPermit: true,
            twapWindow: 300,
            maxDevTicks: 500
        });
    }

    /// @dev Name -> profile. Reverts on an unknown name rather than silently defaulting.
    function byName(string memory name) internal pure returns (Profile memory) {
        bytes32 h = keccak256(bytes(name));
        if (h == keccak256("sepolia")) return sepolia();
        if (h == keccak256("mainnet")) return mainnet();
        revert(string.concat("Profiles: unknown LP_TEST_PROFILE '", name, "' (expected sepolia|mainnet)"));
    }
}
