const fs = require("fs");
const path = require("path");

const hre = require("hardhat");
const pools = require("./lib/pools");

// Writes the ACCESS SIGNATURE FILE of the transition rehearsal (spec 01 §9.7.2, spec 03 §9.7): a JSON
// array of {"address", "deadline", "signature"}, one entry per wallet, each signature the burn
// stand-in's access signature for (that wallet, deadline), signed with the stand-in's access signer.
//
// The digest is BurnStandIn's own EIP-712 message (its NatSpec):
//     domain  EIP712Domain(name "BurnStandIn", version "1", chainId, verifyingContract = the stand-in)
//     type    MigrationAccess(address account,uint256 deadline)
// The site only passes the bytes on to `migrate(..., deadline, signature)`; it never builds them.
//
// Signs locally and sends nothing. When the stand-in is reachable it checks, read-only, that the key
// is the stand-in's `accessSigner()` and that every signature recovers to it. The key is read from a
// file or the environment and is NEVER printed or written.
//
// ──────────────────────── environment ────────────────────────
//
//   ACCESS_STANDIN           the BurnStandIn; default the registry's BurnStandIn of the chain
//   ACCESS_WALLETS           the wallets: a comma-separated list, or a path to a file with one address
//                            per line (or a JSON array of addresses)
//   ACCESS_DEADLINE          required, unix seconds, the same for every entry. No default on purpose:
//                            how long the access lasts is the operator's decision
//   ACCESS_SIGNER_KEY_FILE   path to a file (mode 0600, outside the repo) holding the access signer's
//                            private key, raw or as {"privateKey": "0x…"}
//   ACCESS_SIGNER_KEY        the same key from the environment (when no file is given)
//   ACCESS_OUT               where to write the file (required; outside the repo)
//   ACCESS_CHAIN_ID          only to sign offline for a chain this process cannot reach
//
//     ACCESS_WALLETS=wallets.txt ACCESS_DEADLINE=… ACCESS_SIGNER_KEY_FILE=~/.config/…/access.json \
//       ACCESS_OUT=/tmp/access.json npx hardhat run scripts/transition-access-file.js --network sepolia

const ACCESS_TYPES = {
  MigrationAccess: [
    { name: "account", type: "address" },
    { name: "deadline", type: "uint256" },
  ],
};

/** The stand-in's EIP-712 domain. */
function accessDomain(chainId, standIn) {
  return { name: "BurnStandIn", version: "1", chainId: BigInt(chainId), verifyingContract: hre.ethers.getAddress(standIn) };
}

/** Parses ACCESS_WALLETS: a comma list, or a file of lines or a JSON array. Checksummed, de-duplicated. */
function parseWallets(value) {
  if (!value) throw new Error("Set ACCESS_WALLETS (a comma-separated list or a file path)");
  let items;
  if (fs.existsSync(value)) {
    const text = fs.readFileSync(value, "utf8").trim();
    items = text.startsWith("[") ? JSON.parse(text) : text.split(/\r?\n/);
  } else {
    items = value.split(",");
  }
  const out = [];
  for (const raw of items.map((s) => String(s).trim()).filter(Boolean)) {
    if (!hre.ethers.isAddress(raw)) throw new Error(`Not an address in ACCESS_WALLETS: ${raw}`);
    const a = hre.ethers.getAddress(raw);
    if (!out.includes(a)) out.push(a);
  }
  if (out.length === 0) throw new Error("ACCESS_WALLETS names no wallet");
  return out;
}

/** Reads the signer key from a file or the environment, never echoing it. */
function readSignerKey(env) {
  let raw = env.ACCESS_SIGNER_KEY;
  if (env.ACCESS_SIGNER_KEY_FILE) {
    const text = fs.readFileSync(env.ACCESS_SIGNER_KEY_FILE, "utf8").trim();
    raw = text.startsWith("{") ? JSON.parse(text).privateKey : text;
  }
  if (!raw) throw new Error("Set ACCESS_SIGNER_KEY_FILE (preferred) or ACCESS_SIGNER_KEY");
  return new hre.ethers.Wallet(raw.startsWith("0x") ? raw : `0x${raw}`);
}

/** The access file's entries, signed with `wallet`. Pure apart from the signing. */
async function buildAccessFile({ chainId, standIn, wallet, wallets, deadline }) {
  const domain = accessDomain(chainId, standIn);
  const entries = [];
  for (const account of wallets) {
    const signature = await wallet.signTypedData(domain, ACCESS_TYPES, { account, deadline: BigInt(deadline) });
    entries.push({ address: account, deadline: Number(deadline), signature });
  }
  return entries;
}

/**
 * Throws unless `out` lies outside the repository. Both sides are resolved with `fs.realpathSync`
 * (the file's folder, as the file may not exist yet), so a symbolic link into the repository is
 * caught, and compared with `path.relative`, so a sibling folder whose name merely starts like the
 * repository's is not mistaken for it.
 */
function assertOutsideRepository(out, repoRoot = path.resolve(__dirname, "..")) {
  const resolved = path.resolve(out);
  const target = path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
  const rel = path.relative(fs.realpathSync(repoRoot), target);
  const outside = rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  if (!outside) {
    throw new Error("ACCESS_OUT must be outside the repository");
  }
}

async function main() {
  const env = process.env;
  const reachable = env.ACCESS_CHAIN_ID === undefined;
  const chainId = reachable ? await pools.chainId() : Number(env.ACCESS_CHAIN_ID);
  if (pools.isMainnet(chainId)) throw new Error("The access file belongs to the TEST stand-in; never a mainnet");
  const standIn = env.ACCESS_STANDIN || pools.registryAddress(chainId, "BurnStandIn");
  if (!standIn || !hre.ethers.isAddress(standIn)) throw new Error("Set ACCESS_STANDIN (no BurnStandIn recorded for this chain)");
  const deadline = env.ACCESS_DEADLINE;
  if (!deadline || !/^[0-9]+$/.test(deadline)) throw new Error("Set ACCESS_DEADLINE (unix seconds)");
  if (!env.ACCESS_OUT) throw new Error("Set ACCESS_OUT (a path outside the repo)");
  const out = path.resolve(env.ACCESS_OUT);
  assertOutsideRepository(out);

  const wallet = readSignerKey(env);
  const wallets = parseWallets(env.ACCESS_WALLETS);
  if (reachable) {
    const contract = new hre.ethers.Contract(standIn, ["function accessSigner() view returns (address)"], hre.ethers.provider);
    const onChain = await contract.accessSigner();
    if (hre.ethers.getAddress(onChain) !== wallet.address) {
      throw new Error(`The key is ${wallet.address}, but the stand-in's accessSigner() is ${onChain}`);
    }
  }
  const entries = await buildAccessFile({ chainId, standIn, wallet, wallets, deadline });
  for (const e of entries) {
    const recovered = hre.ethers.verifyTypedData(accessDomain(chainId, standIn), ACCESS_TYPES, {
      account: e.address,
      deadline: BigInt(e.deadline),
    }, e.signature);
    if (recovered !== wallet.address) throw new Error(`The signature of ${e.address} does not recover the signer`);
  }
  fs.writeFileSync(out, JSON.stringify(entries, null, 2) + "\n");
  console.log(`Wrote ${entries.length} access signatures (signer ${wallet.address}, deadline ${deadline}) to ${out}`);
}

module.exports = { ACCESS_TYPES, accessDomain, parseWallets, readSignerKey, buildAccessFile, assertOutsideRepository };

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
