const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

// Shared plumbing for every interaction script: address resolution, pool-kind
// detection, mainnet guards and the Ledger nonce workaround. Nothing here is
// network- or pool-specific, so the same script runs on sepolia and mainnet
// against either StakingPool or WeightedStakingPool.

// The tracked registry, unless DEPLOYMENTS_FILE points somewhere else. The override
// exists for the local-fork integration suite: those runs deploy throwaway contracts on
// chain 31337 and must not rewrite the file that records the real mainnet deployment.
// Every other run leaves it unset and writes deployments.json as before.
const REGISTRY_PATH = process.env.DEPLOYMENTS_FILE
  ? path.resolve(process.env.DEPLOYMENTS_FILE)
  : path.join(__dirname, "..", "..", "deployments.json");

const KINDS = ["StakingPool", "WeightedStakingPool"];

const EXPLORERS = {
  1: "https://etherscan.io",
  11155111: "https://sepolia.etherscan.io",
};

const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
];

// ──────────────────────── network ────────────────────────

async function chainId() {
  return Number((await hre.ethers.provider.getNetwork()).chainId);
}

function isMainnet(id) {
  return id === 1;
}

function explorerAddress(id, address) {
  const base = EXPLORERS[id];
  return base ? `${base}/address/${address}` : address;
}

function explorerTx(id, hash) {
  const base = EXPLORERS[id];
  return base ? `${base}/tx/${hash}` : hash;
}

// ──────────────────────── deployment registry ────────────────────────

function readRegistry() {
  if (!fs.existsSync(REGISTRY_PATH)) return {};
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
}

function recordDeployment(id, kind, address, extra = {}) {
  const registry = readRegistry();
  const key = String(id);
  registry[key] = registry[key] || {};
  registry[key][kind] = { address, ...extra };
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n");
  console.log(`Recorded in ${path.basename(REGISTRY_PATH)} under chain ${key}.`);
}

function registryAddress(id, kind) {
  const entry = readRegistry()[String(id)];
  return entry && entry[kind] ? entry[kind].address : undefined;
}

// ──────────────────────── pool resolution ────────────────────────

// WeightedStakingPool exposes BASE_WEIGHT(); StakingPool does not. Probing is
// cheaper than trusting an env var that can silently point at the wrong pool.
async function detectKind(address) {
  const probe = new hre.ethers.Contract(
    address,
    ["function BASE_WEIGHT() view returns (uint256)"],
    hre.ethers.provider
  );
  try {
    await probe.BASE_WEIGHT();
    return "WeightedStakingPool";
  } catch {
    return "StakingPool";
  }
}

/**
 * Resolves which pool to act on, in priority order:
 *   1. POOL env var (explicit address) — kind is detected on-chain
 *   2. deployments.json entry for this chain and POOL_KIND
 * POOL_KIND defaults to WeightedStakingPool, the current deployment target.
 */
async function getPool() {
  const id = await chainId();
  const explicit = process.env.POOL;
  const requestedKind = process.env.POOL_KIND;

  if (requestedKind && !KINDS.includes(requestedKind)) {
    throw new Error(`POOL_KIND must be one of ${KINDS.join(", ")}`);
  }

  let address = explicit;
  let kind;

  if (address) {
    kind = await detectKind(address);
    if (requestedKind && requestedKind !== kind) {
      throw new Error(
        `POOL_KIND=${requestedKind} but ${address} on chain ${id} is a ${kind}`
      );
    }
  } else {
    kind = requestedKind || "WeightedStakingPool";
    address = registryAddress(id, kind);
    if (!address) {
      throw new Error(
        `No ${kind} recorded for chain ${id} in deployments.json — set POOL=<address> instead`
      );
    }
  }

  const code = await hre.ethers.provider.getCode(address);
  if (code === "0x") throw new Error(`No contract code at ${address} on chain ${id}`);

  const pool = await hre.ethers.getContractAt(kind, address);
  return { pool, kind, address, chainId: id, weighted: kind === "WeightedStakingPool" };
}

async function getErc20(address) {
  return new hre.ethers.Contract(address, ERC20_ABI, hre.ethers.provider);
}

// ──────────────────────── safety ────────────────────────

// Mainnet moves real funds, so every state-changing script demands CONFIRM=yes.
// Read-only scripts never call this.
function requireConfirmation(id, action) {
  if (!isMainnet(id)) return;
  if (process.env.CONFIRM === "yes") return;
  throw new Error(
    `Refusing to ${action} on mainnet without CONFIRM=yes.\n` +
      `  Re-run with CONFIRM=yes once you have checked the parameters above.`
  );
}

// ──────────────────────── transactions ────────────────────────

// hardhat-ledger resolves the nonce with the "pending" block tag and does not
// retry; Infura returns an intermittent -32603 for that tag, which aborts the
// transaction before it reaches the device. Supplying the nonce ourselves makes
// the plugin skip its own lookup.
async function resolveNonce(address) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      return await hre.ethers.provider.getTransactionCount(address, "pending");
    } catch (error) {
      console.log(`  pending nonce attempt ${attempt}/5 failed: ${error.message}`);
    }
  }
  const latest = await hre.ethers.provider.getTransactionCount(address, "latest");
  console.log(`  falling back to latest nonce: ${latest}`);
  return latest;
}

async function getSigner() {
  const signers = await hre.ethers.getSigners();
  if (signers.length === 0) {
    throw new Error(
      "No signer for this network — set PRIVATE_KEY (testnet) or LEDGER_ACCOUNT (mainnet)"
    );
  }
  return signers[0];
}

/**
 * Sends one transaction with an explicit nonce, waits for it and logs the hash.
 * `build` receives the overrides object so call sites stay one-liners:
 *   await send("stake", signer, (o) => pool.stake(amount, o))
 */
async function send(label, signer, build) {
  const id = await chainId();
  const nonce = await resolveNonce(signer.address);
  console.log(`${label}... (nonce ${nonce})`);
  if (isMainnet(id)) console.log("  confirm on the Ledger");

  const tx = await build({ nonce });
  const receipt = await tx.wait();
  console.log(`  done: ${explorerTx(id, receipt.hash)}`);
  return receipt;
}

/** Approves `spender` for `amount` only when the current allowance is short. */
async function ensureAllowance(token, signer, spender, amount, label) {
  const current = await token.allowance(signer.address, spender);
  if (current >= amount) {
    console.log(`${label} allowance already sufficient.`);
    return;
  }
  await send(`Approving ${label}`, signer, (o) =>
    token.connect(signer).approve(spender, amount, o)
  );
}

// ──────────────────────── EIP-712 attestations ────────────────────────

const WEIGHT_ACTIONS = ["Stake", "Withdraw", "UpdateWeight"];

async function signWeight({ pool, action, user, amount, weight, deadline, privateKey }) {
  if (!WEIGHT_ACTIONS.includes(action)) {
    throw new Error(`action must be one of ${WEIGHT_ACTIONS.join(", ")}`);
  }
  const domain = {
    name: "WeightedStakingPool",
    version: "1",
    chainId: await chainId(),
    verifyingContract: await pool.getAddress(),
  };
  const types = {
    [action]: [
      { name: "user", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "weight", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };
  const value = {
    user,
    amount,
    weight,
    nonce: await pool.nonces(user),
    deadline,
  };
  const wallet = new hre.ethers.Wallet(privateKey);
  return wallet.signTypedData(domain, types, value);
}

/**
 * Produces the (weight, deadline, signature) triple a WeightedStakingPool call
 * needs. Two supply routes:
 *   SIGNATURE + DEADLINE + WEIGHT — an attestation already issued by the backend
 *   WEIGHT_SIGNER_KEY + WEIGHT    — sign locally (testnet convenience only)
 */
async function resolveAttestation({ pool, action, user, amount }) {
  const weight = process.env.WEIGHT;
  if (!weight) throw new Error("Set WEIGHT (1000 = x1.0 … 2000 = x2.0)");

  if (process.env.SIGNATURE) {
    const deadline = process.env.DEADLINE;
    if (!deadline) throw new Error("Set DEADLINE alongside SIGNATURE");
    return { weight: BigInt(weight), deadline: BigInt(deadline), signature: process.env.SIGNATURE };
  }

  const key = process.env.WEIGHT_SIGNER_KEY;
  if (!key) {
    throw new Error(
      "Set SIGNATURE + DEADLINE (backend-issued), or WEIGHT_SIGNER_KEY to sign locally"
    );
  }

  const onChainSigner = await pool.signer();
  const local = new hre.ethers.Wallet(key).address;
  if (local.toLowerCase() !== onChainSigner.toLowerCase()) {
    throw new Error(
      `WEIGHT_SIGNER_KEY is ${local} but the pool expects attestations from ${onChainSigner}`
    );
  }

  const deadline = BigInt(
    process.env.DEADLINE || (await hre.ethers.provider.getBlock("latest")).timestamp + 3600
  );
  const signature = await signWeight({
    pool,
    action,
    user,
    amount,
    weight: BigInt(weight),
    deadline,
    privateKey: key,
  });
  console.log(`Signed ${action} attestation locally (weight ${weight}, deadline ${deadline}).`);
  return { weight: BigInt(weight), deadline, signature };
}

// ──────────────────────── formatting ────────────────────────

function epochToIso(seconds) {
  return new Date(Number(seconds) * 1000).toISOString();
}

module.exports = {
  KINDS,
  chainId,
  isMainnet,
  explorerAddress,
  explorerTx,
  readRegistry,
  recordDeployment,
  registryAddress,
  detectKind,
  getPool,
  getErc20,
  requireConfirmation,
  resolveNonce,
  getSigner,
  send,
  ensureAllowance,
  signWeight,
  resolveAttestation,
  epochToIso,
};
