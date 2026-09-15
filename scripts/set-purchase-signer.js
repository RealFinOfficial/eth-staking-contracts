const hre = require("hardhat");

const pools = require("./lib/pools");

// Guardian: point the ApeBond adapter at the backend key that signs purchases — or close the
// route by pointing it at nobody.
//
// ──────────────────────── what this is for ────────────────────────
//
// `scripts/deploy-apebond.js` activates the route CLOSED on purpose: it leaves
// `ApeBondPositionAdapter.purchaseSigner` at `address(0)`, and while it is zero every
// `depositFor` reverts with `InvalidSignature(recovered, 0)` — no signature can ever recover to
// the zero address, so the comparison that verifies a real signer is the same one that keeps
// the path shut. This script is the ONE transaction that opens it, and the one that shuts it
// again.
//
// ──────────────────────── the tier, and why it is the guardian ────────────────────────
//
// `setPurchaseSigner` carries the adapter's `onlyGuardian` modifier, NOT `onlyOwner`. That is
// deliberate and it is checked here before anything is sent: a leaked signing key is the one
// incident where waiting out a timelock is itself the loss, because every second of delay is
// another authorization the attacker can mint. So the seat that rotates it is the undelayed
// multisig, and the owner — the timelock — cannot make this call at all. A run from the wrong
// key fails on the read below with the role named, rather than reverting `NotGuardian` on chain
// and spending the gas to find out.
//
// ──────────────────────── the environment ────────────────────────
//
//   LP_APEBOND_PURCHASE_SIGNER      the new signer's ADDRESS
//   LP_APEBOND_PURCHASE_SIGNER_KEY  the new signer's PRIVATE KEY, from which the address is
//                                   derived. Exactly one of the two is required. The key is
//                                   never printed, never logged and never sent anywhere — it is
//                                   read only so an operator who holds the key does not have to
//                                   copy the address out of a second place and risk a typo
//   LP_APEBOND_ALLOW_CLOSE=1        required to set the signer to `address(0)`. Closing the
//                                   route invalidates every authorization the backend has
//                                   issued and stops every purchase in flight, so it is a
//                                   deliberate act and takes a second switch to say so
//   LP_APEBOND_ADAPTER              the adapter's address, when it is not the one recorded for
//                                   this chain in the registry
//   DEPLOYMENTS_FILE                redirects the registry, like every other script here
//   CONFIRM=yes                     required on mainnet
//
//     LP_APEBOND_PURCHASE_SIGNER=0xBackendKey \
//       npx hardhat run scripts/set-purchase-signer.js --network sepolia
//
// The runbook — where this sits between the activation and the first rehearsal purchase — is in
// scripts/README.md under "After the activation: opening the route".

/** The registry kind this script resolves. */
const ADAPTER_KIND = "ApeBondPositionAdapter";

/** The read surface. `setPurchaseSigner` is the only state-changing call this script makes. */
const ADAPTER_ABI = [
  "function guardian() view returns (address)",
  "function owner() view returns (address)",
  "function purchaseSigner() view returns (address)",
  "function depositsPaused() view returns (bool)",
  "function setPurchaseSigner(address newSigner)",
];

function sameValue(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

/**
 * The adapter this run acts on: the explicit override, else the registry entry for this chain.
 * Never invented — an adapter that is not recorded anywhere is an adapter nobody can point at.
 */
function resolveAdapter(chainId) {
  if (process.env.LP_APEBOND_ADAPTER) {
    try {
      return hre.ethers.getAddress(process.env.LP_APEBOND_ADAPTER);
    } catch {
      throw new Error(`LP_APEBOND_ADAPTER is not a valid address: ${process.env.LP_APEBOND_ADAPTER}`);
    }
  }
  const address = pools.registryAddress(chainId, ADAPTER_KIND);
  if (!address) {
    throw new Error(
      `No ${ADAPTER_KIND} recorded for chain ${chainId} in the deployment registry. Activate ` +
        `the route with scripts/deploy-apebond.js first, point DEPLOYMENTS_FILE at the registry ` +
        `that records it, or name the adapter with LP_APEBOND_ADAPTER=0x…`
    );
  }
  return hre.ethers.getAddress(address);
}

/**
 * The new signer, from whichever of the two inputs was given.
 *
 * Both together are accepted only when they agree, because that is the one case where the
 * operator has stated the same fact twice rather than two different facts. The key itself never
 * leaves this function.
 */
function resolveNewSigner() {
  const explicit = process.env.LP_APEBOND_PURCHASE_SIGNER;
  const key = process.env.LP_APEBOND_PURCHASE_SIGNER_KEY;

  if (!explicit && !key) {
    throw new Error(
      "Set LP_APEBOND_PURCHASE_SIGNER to the new signer's address, or " +
        "LP_APEBOND_PURCHASE_SIGNER_KEY to its private key"
    );
  }

  let fromAddress = null;
  if (explicit) {
    try {
      fromAddress = hre.ethers.getAddress(explicit);
    } catch {
      throw new Error(`LP_APEBOND_PURCHASE_SIGNER is not a valid address: ${explicit}`);
    }
  }

  let fromKey = null;
  if (key) {
    try {
      fromKey = new hre.ethers.Wallet(key).address;
    } catch {
      // The key is NOT in this message. A malformed key is still a key.
      throw new Error("LP_APEBOND_PURCHASE_SIGNER_KEY is not a valid private key");
    }
  }

  if (fromAddress && fromKey && !sameValue(fromAddress, fromKey)) {
    throw new Error(
      `LP_APEBOND_PURCHASE_SIGNER is ${fromAddress} but LP_APEBOND_PURCHASE_SIGNER_KEY belongs ` +
        `to ${fromKey}. They name two different signers; set one of them.`
    );
  }

  return {
    address: fromAddress || fromKey,
    source: fromAddress
      ? fromKey
        ? "LP_APEBOND_PURCHASE_SIGNER (confirmed by the key)"
        : "LP_APEBOND_PURCHASE_SIGNER"
      : "LP_APEBOND_PURCHASE_SIGNER_KEY (address derived; the key was not printed)",
  };
}

async function main() {
  const chainId = await pools.chainId();
  const sender = await pools.getSigner();

  const adapterAddress = resolveAdapter(chainId);
  const code = await hre.ethers.provider.getCode(adapterAddress);
  if (code === "0x") throw new Error(`No contract code at ${ADAPTER_KIND} ${adapterAddress}`);

  const adapter = new hre.ethers.Contract(adapterAddress, ADAPTER_ABI, hre.ethers.provider);
  const { address: newSigner, source } = resolveNewSigner();

  const guardian = hre.ethers.getAddress(await adapter.guardian());
  const owner = hre.ethers.getAddress(await adapter.owner());
  const current = hre.ethers.getAddress(await adapter.purchaseSigner());
  const closing = newSigner === hre.ethers.ZeroAddress;

  console.log(`${ADAPTER_KIND}: ${adapterAddress}`);
  console.log(`  ${pools.explorerAddress(chainId, adapterAddress)}`);
  console.log(`Network:        chain ${chainId} (${hre.network.name})`);
  console.log(`Sender:         ${sender.address}`);
  console.log(`  guardian:     ${guardian}${sameValue(guardian, sender.address) ? "  <-- you" : ""}`);
  console.log(`  owner:        ${owner} (the timelock; it CANNOT make this call)`);
  console.log(`Current signer: ${current === hre.ethers.ZeroAddress ? "0x0 — the deposit path is CLOSED" : current}`);
  console.log(`New signer:     ${closing ? "0x0 — this CLOSES the deposit path" : newSigner}`);
  console.log(`  read from:    ${source}`);
  console.log(`depositsPaused: ${await adapter.depositsPaused()}`);

  // ──────── the refusals, all of them before a single transaction ────────

  // The zero guard comes FIRST, before the "already set" shortcut, and that order is the point.
  // A variable that resolved to the zero address by accident — an empty shell variable, a
  // truncated paste — would otherwise print "already 0x0, nothing to do" and exit 0 on a run
  // whose whole purpose was to OPEN the route. Refusing zero up front turns that quiet success
  // into a loud failure, and costs a deliberate closer exactly one extra environment variable.
  if (closing && process.env.LP_APEBOND_ALLOW_CLOSE !== "1") {
    throw new Error(
      `Refusing to set the purchase signer to address(0) without LP_APEBOND_ALLOW_CLOSE=1. ` +
        `Zero is legal and is the strongest switch this function has — it repudiates every ` +
        `authorization the backend has issued and reverts every depositFor in flight — so ` +
        `closing the route takes a second, explicit switch. Re-run with ` +
        `LP_APEBOND_ALLOW_CLOSE=1 once that is what you mean.`
    );
  }

  if (sameValue(current, newSigner)) {
    console.log(
      `\n${ADAPTER_KIND}.purchaseSigner is ALREADY ${newSigner} — nothing to do, nothing sent.`
    );
    return;
  }

  if (!sameValue(guardian, sender.address)) {
    throw new Error(
      `setPurchaseSigner is GUARDIAN tier on this adapter (onlyGuardian, deliberately not ` +
        `satisfied by owner()). The guardian is ${guardian}; you are ${sender.address}. Run this ` +
        `from the guardian key — the owner ${owner} cannot make this call at all, so there is no ` +
        `timelock route to it either.`
    );
  }

  if (!closing) {
    // ECDSA.recover can only ever return an EOA, so a contract in this seat is a route that can
    // never be opened — the same check scripts/set-signer.js makes for the same reason.
    const signerCode = await hre.ethers.provider.getCode(newSigner);
    if (signerCode !== "0x") {
      throw new Error(
        `${newSigner} is a contract. The adapter verifies purchases with ECDSA.recover, which ` +
          `only ever returns an EOA, so a contract here closes the route rather than opening it.`
      );
    }
  }

  console.log(
    `\nEvery authorization signed by ${
      current === hre.ethers.ZeroAddress ? "the previous signer" : current
    } stops working the moment this lands. Switch the backend over in the same window.`
  );

  pools.requireConfirmation(
    chainId,
    closing
      ? `CLOSE the ApeBond deposit path on ${adapterAddress}`
      : `set the ApeBond purchase signer to ${newSigner}`
  );

  const adapterAsGuardian = new hre.ethers.Contract(adapterAddress, ADAPTER_ABI, sender);
  await pools.send(
    closing ? "Closing the deposit path" : `Setting the purchase signer to ${newSigner}`,
    sender,
    (o) => adapterAsGuardian.setPurchaseSigner(newSigner, o)
  );

  const after = hre.ethers.getAddress(await adapter.purchaseSigner());
  console.log(`\n${ADAPTER_KIND}.purchaseSigner: ${current} -> ${after}`);
  if (!sameValue(after, newSigner)) {
    throw new Error(`purchaseSigner reads ${after} after the call, expected ${newSigner}`);
  }
  console.log(
    closing
      ? "The deposit path is CLOSED: every depositFor now reverts InvalidSignature."
      : "The deposit path is OPEN for authorizations signed by that key."
  );
}

module.exports = {
  ADAPTER_KIND,
  ADAPTER_ABI,
  resolveAdapter,
  resolveNewSigner,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
