// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/**
 * @title LPProxy
 * @notice The ERC-1967 proxy this repo puts in front of `LPStakingVault` and
 *         `RewardsDistributor`. It is OpenZeppelin's `ERC1967Proxy` with nothing added:
 *         no storage, no functions, no overrides — every call still falls through to the
 *         implementation, and the upgrade authority still lives in the implementation's
 *         own `_authorizeUpgrade` (UUPS).
 *
 *  Why a wrapper at all, if it adds no behaviour:
 *    - **Artifacts under `contracts/lp-staking/`.** Both the Hardhat artifact tree and the
 *      indexer's vendoring step key on the source path: the indexer asserts that every
 *      vendored artifact's `sourceName` starts with `contracts/lp-staking/`, which a file
 *      inside the OpenZeppelin package under `node_modules` can never satisfy. Compiling OZ's proxy through
 *      a file of our own gives the repo an artifact it owns and the indexer one it accepts.
 *    - **One deployed name.** The deploy script, the fork suites and the block explorer all
 *      refer to `LPProxy`, so "which proxy is this" has a single answer across the repo
 *      rather than one that depends on which dependency version was compiled.
 *
 *  Deliberately NOT added here: an admin, a fallback of our own, or any storage. Anything
 *  written by this contract would sit at slot 0 of the proxy and collide with the
 *  implementation's layout; ERC-1967 exists precisely to keep the proxy's own bookkeeping
 *  out of that space, and the implementations use ERC-7201 namespaces on top of it.
 */
contract LPProxy is ERC1967Proxy {
    /// @param implementation The initial implementation address, written to the ERC-1967 slot.
    /// @param data           ABI-encoded `initialize(...)` call, executed on the proxy in the
    ///                       deployment transaction. Never empty in this repo: an
    ///                       uninitialized proxy is one `initialize` race away from being
    ///                       owned by whoever calls it first.
    constructor(address implementation, bytes memory data) ERC1967Proxy(implementation, data) {}
}
