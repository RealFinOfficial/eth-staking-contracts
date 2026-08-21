/**
 * Network profiles for the fork harness.
 *
 * One scenario, one harness, two worlds. A profile is the complete set of facts that
 * differ between the chain the tests fork today (Sepolia, phase 1) and the chain they
 * graduate to (mainnet, phase 2): which endpoint serves it, which block is pinned, where
 * Uniswap lives on it, which two tokens the pool is made of, whether those tokens can
 * sign an EIP-2612 permit at all, and where test wallets get funded from.
 *
 * Selected by `LP_TEST_PROFILE`, default **sepolia**. An unknown value throws rather than
 * falling back, because a typo that silently ran the mainnet profile would look like a
 * pass while proving something else entirely.
 *
 * Nothing here is derived at runtime. Every address, block number, token name and supply
 * below was read from the live chain at the pinned block on 2026-08-25 and is asserted
 * again by `fork-node.probeFork` on every run, so a profile that has gone stale fails in
 * the first phase instead of halfway through the scenario.
 *
 * ── Why the shipped suites do not import this file ──────────────────────────────────
 *
 * `test/lp-staking/integration/LPStakingLocalFork.test.js` and `helpers/constants.js` are
 * reviewed and approved as they stand. They keep reading `constants.js` directly; this
 * file reuses the same constants for the mainnet profile, so the two can never disagree
 * about what mainnet is.
 */

const C = require("./constants");

// ─────────────────────────── Sepolia (phase 1, the default) ───────────────────────────

/**
 * Pinned ~700 blocks behind the head of 2026-08-25 (11,562,735). Far enough back that a
 * re-org can never move it, recent enough that the Uniswap Sepolia deployment and both
 * test tokens are all present.
 */
const SEPOLIA_PINNED_BLOCK = 11562000;

/**
 * The team's two Sepolia test tokens. Both are plain fixed-supply ERC-20s: no `owner()`,
 * no `mint`, and — the fact that shapes the whole permit story below — no
 * `DOMAIN_SEPARATOR()`, so no EIP-2612.
 *
 * tREAL sorts BELOW tUSDC, so tREAL is token0 on Sepolia. That is the same orientation
 * the mainnet pool has, which is why the scenario's swap direction needs no special case.
 */
const SEPOLIA_ASSET_ADDR = "0x8e65d19BE4bA1CC61005B4c70f21cd179512e33f";
const SEPOLIA_USDC_ADDR = "0x9E0F2263c0Cb67Ee08B8c8A42be8770870b05215";

/**
 * The wallet that holds effectively the whole supply of both test tokens: 949,839,675
 * tREAL (95% of 1e9) and 997,989,999 tUSDC (99.8% of 1e9) at the pinned block. The fork
 * impersonates it rather than writing balance slots, because a transfer from the real
 * holder is the same state transition production would make.
 */
const SEPOLIA_FUNDER_ADDR = "0xBb7403aAF82342A0d987A8603aAf881136B5D125";

/** Uniswap V3 is NOT at one address across chains; Sepolia got its own deployment. */
const SEPOLIA_FACTORY_ADDR = "0x0227628f3F023bb0B980b67D528571c95c6DaC1c";
const SEPOLIA_NPM_ADDR = "0x1238536071E1c677A632429e3655c799b22cDA52";
const SEPOLIA_ROUTER_ADDR = "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E";

/**
 * Public Sepolia archive endpoints, tried in order. **tenderly first, publicnode behind it.**
 *
 *   - `sepolia.gateway.tenderly.co` has served historical state at block 11562000 from every
 *     vantage point tried so far: a developer laptop, GitHub's runners, and this repo's and
 *     the indexer repo's CI.
 *   - `ethereum-sepolia-rpc.publicnode.com` is a LOAD-BALANCED POOL whose backends disagree
 *     about Sepolia archive availability, so one successful request proves nothing about the
 *     next one. Both halves were observed the same day: run 32845136586 found it pruned,
 *     fell through to tenderly and went green, while run 32845141961 found a backend that HAD
 *     the state, accepted it, and then failed on the first read of a different account with
 *     `-32000: historical state 996e...7774 is not available`. It stays listed as a fallback
 *     for when tenderly is unreachable, but it is no longer the first thing tried.
 *
 * Still deliberately OUT, re-probe before re-adding:
 *   - https://sepolia.drpc.org        -> "chain is not available on free plan"
 *   - https://rpc.sepolia.org         -> serves an HTML error page, not JSON-RPC
 * A candidate that is known dead only adds a node spawn and a timeout to every unconfigured
 * run.
 */
const SEPOLIA_PUBLIC_RPCS = [
  "https://sepolia.gateway.tenderly.co",
  "https://ethereum-sepolia-rpc.publicnode.com",
];

const MAINNET_PUBLIC_RPCS = [
  "https://ethereum-rpc.publicnode.com",
  "https://eth-mainnet.public.blastapi.io",
  "https://eth-pokt.nodies.app",
  "https://eth.drpc.org",
  "https://eth.merkle.io",
];

/**
 * Mainnet USDC holders at block 25,750,000, largest first, copied from
 * test/lp-staking/fork/LPStakingFork.test.js L95-101 — keep in sync.
 *
 * Note what they are NOT: at that block the largest of them holds 1.0 ASSET and the rest
 * hold none, so the mainnet profile funds ASSET through {@link module:helpers/funding}'s
 * `deal` fallback. That is a known phase-2 fact, recorded here rather than discovered.
 */
const MAINNET_FUNDERS = [
  "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf", // Polygon (Matic) ERC20 bridge
  "0xA9D1e08C7793af67e9d92fe308d5697FB81d3E43", // Coinbase 10
  "0xcEe284F754E854890e311e3280b767F80797180d", // Arbitrum One bridge
  "0x55FE002aefF02F77364de339a1292923A15844B8", // Circle
  "0xf89d7b9c864f589bbF53a82105107622B35EaA40", // Bybit
];

// ─────────────────────────── The profiles ───────────────────────────

/**
 * @typedef {object} TokenProfile
 * @property {string} address Checksummed token address on the forked chain.
 * @property {bigint} decimals
 * @property {string} symbol
 * @property {string} name
 * @property {bigint} totalSupply Asserted at the pinned block; a different value means the
 *   endpoint is serving some other block.
 * @property {false|{name: string, version: string}} permit EIP-2612 domain, or `false`
 *   when the token has no `DOMAIN_SEPARATOR()` at all. Test steps read this instead of
 *   assuming: a permit step under a `permit: false` token proves a different branch, and
 *   says so in its title.
 */

/**
 * @typedef {object} Profile
 * @property {string} name
 * @property {string} logLabel Prefix on the harness's own console output.
 * @property {bigint} chainId Real chain id of the forked chain (11155111 / 1). NOT what
 *   the node reports for itself — see {@link Profile.localChainId}.
 * @property {bigint} localChainId What `hardhat node` reports regardless of what it forks.
 * @property {{envUrl: string, infuraHost: string, publicCandidates: string[]}} rpc
 * @property {number} pinnedBlock
 * @property {string} factory
 * @property {string} npm
 * @property {string} router
 * @property {string} multicall3
 * @property {TokenProfile} asset
 * @property {TokenProfile} usdc
 * @property {"create"|string} pool `"create"` when the suite must create the pool through
 *   `scripts/create-sepolia-pool.js`, otherwise the address of the pool that already exists.
 * @property {number} fee
 * @property {{num: bigint, den: bigint}} initialPrice USDC per ASSET, as an exact fraction.
 * @property {{name: string, version: string}} nftPermit EIP-712 domain of the position
 *   manager's ERC-721 permit.
 * @property {{mode: "impersonate", funders: string[], fallback: "deal"}} funding
 * @property {number} twapWindow
 * @property {number} maxDevBps
 */

/** @type {Profile} */
const sepolia = {
  name: "sepolia",
  /** Prefix on every message this profile's harness prints. */
  logLabel: "sepolia-fork",
  chainId: 11155111n,
  localChainId: C.LOCAL_CHAIN_ID,

  rpc: {
    envUrl: "SEPOLIA_RPC_URL",
    infuraHost: "https://sepolia.infura.io/v3/",
    publicCandidates: SEPOLIA_PUBLIC_RPCS,
  },

  pinnedBlock: SEPOLIA_PINNED_BLOCK,

  factory: SEPOLIA_FACTORY_ADDR,
  npm: SEPOLIA_NPM_ADDR,
  router: SEPOLIA_ROUTER_ADDR,
  multicall3: C.MULTICALL3_ADDR,

  asset: {
    address: SEPOLIA_ASSET_ADDR,
    decimals: 18n,
    symbol: "tREAL",
    name: "Test REAL",
    totalSupply: 10n ** 27n,
    permit: false,
  },
  usdc: {
    address: SEPOLIA_USDC_ADDR,
    decimals: 6n,
    symbol: "tUSDC",
    name: "TestUSDC",
    totalSupply: 10n ** 15n,
    permit: false,
  },

  // No tREAL/tUSDC pool exists on live Sepolia at any fee tier (100/500/3000/10000 all
  // return the zero address at the pinned block), so the fork creates one.
  pool: "create",
  fee: C.FEE,
  initialPrice: { num: C.PRICE_USDC_PER_ASSET_NUM, den: C.PRICE_USDC_PER_ASSET_DEN },

  // Canonical Uniswap periphery, so the ERC-721 permit domain is the same as mainnet's.
  nftPermit: { name: C.NFT_PERMIT_NAME, version: C.NFT_PERMIT_VERSION },

  funding: { mode: "impersonate", funders: [SEPOLIA_FUNDER_ADDR], fallback: "deal" },

  twapWindow: C.TWAP_WINDOW,
  maxDevBps: C.MAX_DEVIATION_BPS,
};

/** @type {Profile} */
const mainnet = {
  name: "mainnet",
  // "local-fork", not "mainnet-fork": the shipped suite has printed and asserted this
  // exact label since it was approved, and this profile is that suite's world.
  logLabel: "local-fork",
  chainId: 1n,
  localChainId: C.LOCAL_CHAIN_ID,

  rpc: {
    envUrl: "MAINNET_RPC_URL",
    infuraHost: "https://mainnet.infura.io/v3/",
    publicCandidates: MAINNET_PUBLIC_RPCS,
  },

  pinnedBlock: C.PINNED_BLOCK,

  factory: C.FACTORY_ADDR,
  npm: C.NPM_ADDR,
  router: C.ROUTER_ADDR,
  multicall3: C.MULTICALL3_ADDR,

  // Both real tokens cache their EIP-712 separator from chain id 1, so on a fork that
  // reports 31337 the domain that verifies is still the chain-1 one. That is exactly what
  // `signing.resolveDomain`'s candidate list is for.
  asset: {
    address: C.REAL_ASSET_ADDR,
    decimals: 18n,
    symbol: "ASSET",
    name: "REAL",
    totalSupply: null, // moves between blocks; nothing asserts it
    permit: { name: "REAL", version: "1" },
  },
  usdc: {
    address: C.REAL_USDC_ADDR,
    decimals: 6n,
    symbol: "USDC",
    name: "USD Coin",
    totalSupply: null,
    permit: { name: "USD Coin", version: "2" },
  },

  pool: C.REAL_POOL_ADDR,
  fee: C.FEE,
  initialPrice: { num: C.PRICE_USDC_PER_ASSET_NUM, den: C.PRICE_USDC_PER_ASSET_DEN },

  nftPermit: { name: C.NFT_PERMIT_NAME, version: C.NFT_PERMIT_VERSION },

  funding: { mode: "impersonate", funders: MAINNET_FUNDERS, fallback: "deal" },

  twapWindow: C.TWAP_WINDOW,
  maxDevBps: C.MAX_DEVIATION_BPS,
};

const profiles = { sepolia, mainnet };

const DEFAULT_PROFILE = "sepolia";

// ─────────────────────────── Selection and RPC resolution ───────────────────────────

/**
 * The profile `LP_TEST_PROFILE` names, defaulting to sepolia.
 *
 * @param {object} [env] Environment to read from.
 * @returns {Profile}
 * @throws when the variable names a profile that does not exist — a silent fallback would
 *   run a different chain's tests and still report a pass.
 */
function resolveProfile(env = process.env) {
  const requested = env.LP_TEST_PROFILE || DEFAULT_PROFILE;
  const profile = profiles[requested];
  if (!profile) {
    throw new Error(
      `LP_TEST_PROFILE=${requested} is not a known profile — ` +
        `expected one of ${Object.keys(profiles).join(", ")}`
    );
  }
  return profile;
}

/**
 * Endpoints to try, in the order the runbook specifies:
 *   <profile>_RPC_URL -> INFURA_API_KEY -> the profile's public list.
 *
 * An explicitly configured endpoint is always used ALONE: an operator who named one asked
 * for that one, and walking past it to a public node would hide the fact that it is down.
 *
 * @param {Profile} profile
 * @param {object} [env]
 * @returns {string[]}
 */
function resolveRpcCandidates(profile, env = process.env) {
  const configured = env[profile.rpc.envUrl];
  if (configured) return [configured];
  if (env.INFURA_API_KEY) return [`${profile.rpc.infuraHost}${env.INFURA_API_KEY}`];
  return [...profile.rpc.publicCandidates];
}

/**
 * Whether an endpoint was configured for this profile, which is what turns a skip into a
 * failure. Same semantics as the mainnet rule in `fork-node.decideOnForkFailure`: an
 * operator who set either variable asked for these tests to run, so silence would be a lie.
 *
 * @param {Profile} profile
 * @param {object} [env]
 * @returns {boolean}
 */
function isConfigured(profile, env = process.env) {
  return Boolean(env[profile.rpc.envUrl] || env.INFURA_API_KEY);
}

module.exports = {
  profiles,
  sepolia,
  mainnet,
  DEFAULT_PROFILE,
  resolveProfile,
  resolveRpcCandidates,
  isConfigured,
  SEPOLIA_PUBLIC_RPCS,
  MAINNET_PUBLIC_RPCS,
  SEPOLIA_FUNDER_ADDR,
  MAINNET_FUNDERS,
};
