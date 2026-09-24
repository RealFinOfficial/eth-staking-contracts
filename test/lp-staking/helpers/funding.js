/**
 * Puts the profile's real tokens into the test wallets on a fork.
 *
 * The shipped mainnet suite deploys its own mock tokens and mints to itself. A profile
 * suite cannot: tREAL and tUSDC on Sepolia are plain fixed-supply ERC-20s with no `owner()`
 * and no `mint`, and real USDC on mainnet will not mint for anyone either. So the tokens
 * have to come from somebody who already holds them.
 *
 * ── Two paths, in this order ──────────────────────────────────────────────────────────
 *
 * 1. **impersonate** — `hardhat_impersonateAccount` the profile's funder and send a real
 *    `transfer`. This is the honest path: the balance moves through the token's own code,
 *    `Transfer` is emitted, `totalSupply` stays right, and any transfer hook, blocklist or
 *    fee-on-transfer behaviour the real token has applies exactly as it would in production.
 *    Used whenever a funder actually holds enough.
 *
 * 2. **deal** — write the recipient's `balanceOf` storage slot directly. Nothing else can
 *    work when no holder covers the budget (on mainnet at block 25,750,000 the largest USDC
 *    whale holds 1.0 ASSET and the rest hold none), but it is a fabrication: `totalSupply`
 *    is left untouched, so the sum of balances no longer matches it, and no `Transfer` log
 *    is produced. Only used as the automatic fallback, and the caller is told which path ran
 *    so a test can state what it is standing on.
 *
 * ── Finding the balance slot ──────────────────────────────────────────────────────────
 *
 * Solidity puts `mapping(address => uint256) balances` at `keccak256(abi.encode(key, slot))`.
 * The slot number itself is a layout detail no ABI exposes, so it is discovered rather than
 * assumed: for each candidate slot the probe writes a sentinel, asks the token what
 * `balanceOf` now says, and restores the original word. The slot whose sentinel comes back
 * out of `balanceOf` is the one. That works through a proxy too — the search writes to the
 * address that holds the storage, which is the address `balanceOf` is called on.
 */

const ethers = require("ethers");

const { ERC20_ABI } = require("./constants");

/** How many mapping slots the probe is willing to try before giving up. */
const MAX_SLOT_PROBE = 30;

/** Gas the impersonated funder is given, so a whale with an empty balance can still send. */
const FUNDER_GAS_WEI = "0x21e19e0c9bab2400000"; // 10,000 ETH

/**
 * A value no real balance will ever be, so a slot that happens to already hold the right
 * number cannot produce a false positive.
 */
const SENTINEL = "0x" + "de".repeat(31) + "ad";

const abiCoder = ethers.AbiCoder.defaultAbiCoder();

/** Storage key of `mapping(address => uint256)[holder]` declared at `slot`. */
function balanceSlotKey(holder, slot) {
  return ethers.keccak256(abiCoder.encode(["address", "uint256"], [holder, slot]));
}

/**
 * Discovers which storage slot a token keeps its balances mapping in.
 *
 * @param {object} provider
 * @param {string} token
 * @param {string} probeHolder An address whose balance the probe may temporarily corrupt;
 *   the original word is written back before returning either way.
 * @returns {Promise<number>}
 */
async function findBalanceSlot(provider, token, probeHolder) {
  const erc20 = new ethers.Contract(token, ERC20_ABI, provider);

  for (let slot = 0; slot <= MAX_SLOT_PROBE; slot++) {
    const key = balanceSlotKey(probeHolder, slot);
    const original = await provider.send("eth_getStorageAt", [token, key, "latest"]);

    await provider.send("hardhat_setStorageAt", [token, key, SENTINEL]);
    let observed;
    try {
      observed = await erc20.balanceOf(probeHolder);
    } catch {
      observed = null;
    }
    await provider.send("hardhat_setStorageAt", [token, key, original]);

    if (observed !== null && observed === BigInt(SENTINEL)) return slot;
  }

  throw new Error(
    `could not find the balanceOf storage slot of ${token} in slots 0..${MAX_SLOT_PROBE}`
  );
}

/** Overwrites `holder`'s balance of `token` with `amount`. */
async function dealBalance(provider, token, holder, amount, slot) {
  const key = balanceSlotKey(holder, slot);
  await provider.send("hardhat_setStorageAt", [token, key, ethers.toBeHex(amount, 32)]);
}

/**
 * Unlocks `address` on the node and returns a signer that sends as it.
 *
 * The signer is constructed directly rather than through `provider.getSigner(address)`:
 * ethers v6 checks that against `eth_accounts`, and an impersonated account is not in that
 * list, so the convenience method fails with "invalid account". `JsonRpcSigner` itself only
 * needs the node to accept `eth_sendTransaction` from the address, which is exactly what
 * impersonation arranges.
 */
async function impersonate(provider, address) {
  await provider.send("hardhat_impersonateAccount", [address]);
  await provider.send("hardhat_setBalance", [address, FUNDER_GAS_WEI]);
  return new ethers.JsonRpcSigner(provider, ethers.getAddress(address));
}

async function stopImpersonating(provider, address) {
  await provider.send("hardhat_stopImpersonatingAccount", [address]);
}

/**
 * Funds every recipient with the amounts it asks for, one token at a time.
 *
 * @param {object} provider Connected to the fork node.
 * @param {object} profile A profile from helpers/profiles.js.
 * @param {Array<{address: string, asset?: bigint, usdc?: bigint}>} recipients Amounts are in
 *   the tokens' own raw units; a missing or zero amount means "nothing of that token".
 * @param {{fees?: {maxFeePerGas: bigint, maxPriorityFeePerGas: bigint}}} [options] Fee
 *   ceiling for the impersonated transfers. A forked node inherits the forked chain's base
 *   fee, and these transactions are not sent through a fee-pinned wallet, so without this
 *   they are priced by estimation — the exact failure the fork suites already removed.
 * @returns {Promise<{asset: object, usdc: object}>} Per token: `{ path, funder, slot, total,
 *   receipts }`, where `path` is `"impersonate"`, `"deal"` or `"none"`. `receipts` is empty
 *   on the `deal` path — it mines nothing.
 */
async function fundFromProfile(provider, profile, recipients, options = {}) {
  const report = {};
  for (const role of ["asset", "usdc"]) {
    report[role] = await fundOne(provider, profile, role, recipients, options);
  }
  return report;
}

async function fundOne(provider, profile, role, recipients, options) {
  const spec = profile[role];
  const wanted = recipients
    .map((r) => ({ address: r.address, amount: BigInt(r[role] || 0n) }))
    .filter((r) => r.amount > 0n);

  const total = wanted.reduce((sum, r) => sum + r.amount, 0n);
  if (total === 0n) return { path: "none", funder: null, slot: null, total: 0n, receipts: [] };

  const token = new ethers.Contract(spec.address, ERC20_ABI, provider);

  // ── Path 1: a real holder who covers the whole budget. ──────────────────────────────
  if (profile.funding.mode === "impersonate") {
    for (const funder of profile.funding.funders) {
      const balance = await token.balanceOf(funder);
      if (balance < total) continue;

      const signer = await impersonate(provider, funder);
      const receipts = [];
      try {
        const overrides = options.fees
          ? {
              maxFeePerGas: options.fees.maxFeePerGas,
              maxPriorityFeePerGas: options.fees.maxPriorityFeePerGas,
            }
          : {};
        for (const { address, amount } of wanted) {
          const tx = await token.connect(signer).transfer(address, amount, overrides);
          const receipt = await tx.wait();
          if (receipt.status !== 1) {
            throw new Error(`funding transfer ${receipt.hash} reverted`);
          }
          receipts.push({ address, amount, receipt });
        }
      } finally {
        await stopImpersonating(provider, funder);
      }
      return { path: "impersonate", funder, slot: null, total, receipts };
    }
  }

  // ── Path 2: no holder covers it, so the balance is written straight into storage. ────
  if (profile.funding.fallback !== "deal") {
    throw new Error(
      `no funder covers ${total} of ${spec.symbol} and this profile declares no fallback`
    );
  }

  const slot = await findBalanceSlot(provider, spec.address, wanted[0].address);
  for (const { address, amount } of wanted) {
    const existing = await token.balanceOf(address);
    await dealBalance(provider, spec.address, address, existing + amount, slot);
  }
  // Deliberately no receipts: a storage write mines no block and emits no Transfer, which
  // is precisely the difference between this path and the honest one.
  return { path: "deal", funder: null, slot, total, receipts: [] };
}

module.exports = {
  MAX_SLOT_PROBE,
  balanceSlotKey,
  findBalanceSlot,
  dealBalance,
  impersonate,
  stopImpersonating,
  fundFromProfile,
};
