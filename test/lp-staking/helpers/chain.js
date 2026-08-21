/**
 * Provider, signers, fee pinning, transaction sending and log decoding for the
 * local-fork suite.
 *
 * Signers are local HD wallets derived from the Hardhat test mnemonic, not the node's
 * unlocked accounts. They hold the same addresses — so the deploy scripts, which do use
 * the unlocked accounts, sign as the very same deployer — but every transaction this file
 * sends is signed locally and submitted with `eth_sendRawTransaction`, which is what a
 * frontend and a back office actually do.
 */

const ethers = require("ethers");

const { MNEMONIC, DERIVATION_PREFIX, ROLES } = require("./constants");

/**
 * Fee pinning. Copied from test/lp-staking/fork/LPStakingFork.test.js L110–120 and
 * L240–277 — keep in sync.
 *
 * `maxFeePerGas` is `baseFeePerGas * FEE_HEADROOM` at the forked block, never below
 * MIN_MAX_FEE_PER_GAS. EIP-1559 lets the base fee grow by at most 12.5% per block, so 100x
 * survives ~40 consecutive full blocks — and this fork's blocks carry one transaction
 * each, so its base fee falls rather than rises. The headroom costs nothing: only
 * `baseFee + priority` is ever charged.
 */
const FEE_HEADROOM = 100n;
const MIN_MAX_FEE_PER_GAS = ethers.parseUnits("10", "gwei");
const PRIORITY_FEE_PER_GAS = ethers.parseUnits("1", "gwei");

/** Reads the forked block's own base fee and derives the ceiling every transaction carries. */
async function derivePinnedFees(provider) {
  const block = await provider.getBlock("latest");
  const baseFee = block.baseFeePerGas;
  if (baseFee === null || baseFee === undefined) {
    throw new Error(`forked block ${block.number} reports no baseFeePerGas`);
  }
  const headroom = baseFee * FEE_HEADROOM;
  const maxFeePerGas = headroom > MIN_MAX_FEE_PER_GAS ? headroom : MIN_MAX_FEE_PER_GAS;
  return {
    baseFee,
    maxFeePerGas,
    maxPriorityFeePerGas:
      PRIORITY_FEE_PER_GAS < maxFeePerGas ? PRIORITY_FEE_PER_GAS : maxFeePerGas,
  };
}

/**
 * Wraps a signer so every transaction it sends carries `fees`, unless the call site states
 * its own. Applied to every wallet the suite uses, which is what makes "no transaction
 * here depends on fee estimation" true rather than aspirational.
 */
function pinFees(signer, fees) {
  if (signer.__feesPinned) return signer;
  const send = signer.sendTransaction.bind(signer);
  signer.sendTransaction = (tx) =>
    send({
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      ...tx,
    });
  signer.__feesPinned = true;
  return signer;
}

/**
 * Named HD wallets on `provider`, every one of them fee-pinned.
 *
 * The accounts are a fact about the NODE, not about the chain it forks — `hardhat node`
 * unlocks the same test mnemonic whatever it is pointed at — so no profile carries them.
 * The parameter exists so a suite that needs a different role map can state it rather than
 * edit this file; both fork suites take the default.
 *
 * @param {object} provider
 * @param {object} fees From {@link derivePinnedFees}.
 * @param {{mnemonic?: string, derivationPrefix?: string, roles?: object}} [accounts]
 */
function makeWallets(provider, fees, accounts = {}) {
  const mnemonic = accounts.mnemonic || MNEMONIC;
  const derivationPrefix = accounts.derivationPrefix || DERIVATION_PREFIX;
  const roles = accounts.roles || ROLES;

  const wallets = {};
  for (const [role, index] of Object.entries(roles)) {
    const wallet = ethers.HDNodeWallet.fromPhrase(
      mnemonic,
      undefined,
      `${derivationPrefix}/${index}`
    ).connect(provider);
    wallets[role] = pinFees(wallet, fees);
  }
  return wallets;
}

// ─────────────────────────── transactions ───────────────────────────

/** Awaits a transaction and its receipt, and refuses a reverted one. */
async function send(txPromise) {
  const tx = await txPromise;
  const receipt = await tx.wait();
  if (receipt.status !== 1) {
    throw new Error(`transaction ${receipt.hash} reverted on chain (status ${receipt.status})`);
  }
  return receipt;
}

/**
 * Asserts a call reverts with a specific custom error and mines nothing.
 *
 * `revertedWithCustomError` from hardhat-chai-matchers is bound to the Hardhat Runtime
 * Environment's provider, and these transactions go to a separate node over plain HTTP,
 * so the revert data is decoded here instead. Ethers surfaces it as `error.data` from the
 * `eth_estimateGas` the populate step runs, which is also why no block is produced.
 */
async function expectCustomError(provider, txPromise, iface, name) {
  const headBefore = await provider.getBlockNumber();

  let error = null;
  try {
    const tx = await txPromise;
    await tx.wait();
  } catch (caught) {
    error = caught;
  }

  if (error === null) {
    throw new Error(`expected a revert with ${name}, but the call succeeded`);
  }

  const data = revertData(error);
  if (data === null) {
    throw new Error(
      `expected a revert with ${name}, but no revert data was returned: ${
        error.shortMessage || error.message
      }`
    );
  }

  const parsed = iface.parseError(data);
  if (parsed === null) {
    throw new Error(`revert data ${data} does not decode against the given interface`);
  }
  if (parsed.name !== name) {
    throw new Error(`expected a revert with ${name}, got ${parsed.name}(${parsed.args})`);
  }

  const headAfter = await provider.getBlockNumber();
  if (headAfter !== headBefore) {
    throw new Error(
      `a reverted call mined a block: head moved ${headBefore} -> ${headAfter}`
    );
  }

  return { headBefore, args: parsed.args };
}

/**
 * Asserts a call reverts, without caring how. Used where the revert comes out of a third
 * party contract (the position manager rejecting a burnt tokenId), so there is no local
 * interface to decode against.
 */
async function expectReverted(promise, what) {
  let reverted = false;
  try {
    await promise;
  } catch {
    reverted = true;
  }
  if (!reverted) throw new Error(`expected ${what} to revert, but it returned`);
}

/** Digs the revert payload out of the several shapes ethers v6 can wrap it in. */
function revertData(error) {
  const candidates = [
    error?.data,
    error?.info?.error?.data,
    error?.error?.data,
    error?.error?.error?.data,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.startsWith("0x") && candidate.length >= 10) {
      return candidate;
    }
    if (candidate && typeof candidate.data === "string" && candidate.data.startsWith("0x")) {
      return candidate.data;
    }
  }
  return null;
}

// ─────────────────────────── log decoding ───────────────────────────

/**
 * First matching event in a receipt, by emitting address and name.
 *
 * Copied from test/lp-staking/fork/LPStakingFork.test.js L359–386 — keep in sync — with
 * the contract replaced by a bare interface, because several of the interfaces here come
 * from artifacts rather than from a deployed `ethers.Contract`.
 */
function parseEvent(receipt, iface, address, name) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== address.toLowerCase()) continue;
    let parsed = null;
    try {
      parsed = iface.parseLog(log);
    } catch {
      continue;
    }
    if (parsed && parsed.name === name) return parsed.args;
  }
  throw new Error(`no ${name} event from ${address} in receipt ${receipt.hash}`);
}

/**
 * Decodes raw `eth_getLogs` output against a lowercase address -> interface map. Logs from
 * an address that is not in the map, or that no fragment matches, come back with
 * `name: null` so a caller can assert on the full sequence rather than a filtered one.
 */
function decodeLogs(logs, ifacesByAddress) {
  return logs.map((log) => {
    const iface = ifacesByAddress[log.address.toLowerCase()];
    let parsed = null;
    if (iface) {
      try {
        parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      } catch {
        parsed = null;
      }
    }
    return {
      address: log.address.toLowerCase(),
      blockNumber: Number(log.blockNumber),
      logIndex: Number(log.logIndex),
      transactionHash: log.transactionHash,
      blockHash: log.blockHash,
      topics: log.topics,
      name: parsed ? parsed.name : null,
      args: parsed ? parsed.args : null,
    };
  });
}

/** The 32-byte topic encoding of an address, for indexed-topic filters. */
function addressTopic(address) {
  return ethers.zeroPadValue(ethers.getAddress(address), 32);
}

/** The 32-byte topic encoding of a uint256, for indexed-topic filters. */
function uintTopic(value) {
  return ethers.toBeHex(BigInt(value), 32);
}

module.exports = {
  derivePinnedFees,
  pinFees,
  makeWallets,
  send,
  expectCustomError,
  expectReverted,
  parseEvent,
  decodeLogs,
  addressTopic,
  uintTopic,
};
