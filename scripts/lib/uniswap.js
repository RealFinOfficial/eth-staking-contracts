// The Uniswap V3 deployment, per chain.
//
// Uniswap V3 is NOT at one address across chains. Sepolia got its own deployment, and the
// mainnet addresses have zero code there — using them makes `getPool()` return garbage
// instead of reverting. Keyed by chain id; a chain that is not listed has no default, so
// LP_FACTORY / LP_NPM / LP_ROUTER become required for it — including a local fork, which
// reports 31337 rather than the chain id it forks.
//
// This map is the single copy. `scripts/deploy-lp-staking.js` reads the factory, the
// position manager and the router from it; `scripts/create-sepolia-pool.js` reads the
// factory and the position manager. Two copies of the same three addresses is one copy
// too many: a Sepolia address corrected in one file and not the other is a stack bound to
// a pool nobody trades on, and nothing in either script would notice.
const UNISWAP_BY_CHAIN = {
  // mainnet
  1: {
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    positionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
    swapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
  },
  // sepolia
  11155111: {
    factory: "0x0227628f3F023bb0B980b67D528571c95c6DaC1c",
    positionManager: "0x1238536071E1c677A632429e3655c799b22cDA52",
    swapRouter02: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E",
  },
  // Avalanche C-Chain. Checked read-only on 2026-11-20 (block 100,872,716): all three carry code,
  // and the position manager and the router both report this factory from `factory()`.
  43114: {
    factory: "0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD",
    positionManager: "0x655C406EBFa14EE2006250925e54ec43AD184f8B",
    swapRouter02: "0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE",
  },
  // Avalanche Fuji. Checked the same way on 2026-11-20 (block 61,376,661).
  43113: {
    factory: "0x6739FCFDC0c6939939C0e8D55188E8D0D973E617",
    positionManager: "0xd7144710b6152526fb33699b166b5917a73f67fe",
    swapRouter02: "0x701067e5f83d71975988be412bbd922d806fd29d",
  },
};

/** The three addresses for `chainId`, or an empty object when the chain has no defaults. */
function forChain(chainId) {
  return UNISWAP_BY_CHAIN[chainId] || {};
}

module.exports = { UNISWAP_BY_CHAIN, forChain };
