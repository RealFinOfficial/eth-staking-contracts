const hre = require("hardhat");
const pools = require("./lib/pools");

// Fund the RewardsDistributor with the two launch reward tokens, the way the operator does it.
//
// The distributor pays every claim out of its own balance by transfer. Nothing is minted at
// claim time, and there is no cap anywhere: a claim pays what its voucher says, and when the
// distributor holds less of that token than the claim pays, the claim reverts with
// `InsufficientFunds(token, needed, balance)` until the company funds the contract. This script
// is that funding:
//
//   - $OVTR: the operator multisig is the Overture token's MINTER, so it mints $OVTR straight
//     INTO the distributor — `TokenOverture.mint(distributor, amount)`.
//   - $ASSET: the operator transfers $ASSET it already holds INTO the distributor —
//     `ASSET.transfer(distributor, amount)`.
//
// When the configured signer IS the minter (for $OVTR) or holds the $ASSET (for $ASSET), the
// script sends the transaction. Otherwise — the mainnet case, where the operator is a Safe —
// it prints the exact `to` and `data` to paste into the Safe, and sends nothing.
//
// ──────────────────────── environment ────────────────────────
//
//   LP_FUND_OVTR_AMOUNT    $OVTR to mint into the distributor, in WHOLE tokens (decimals are
//                          read from chain). Empty or 0 skips the $OVTR leg. PLACEHOLDER:
//                          the launch figure is to be decided with Brandon before 7 Oct.
//   LP_FUND_ASSET_AMOUNT   $ASSET to transfer into the distributor, in whole tokens. Empty or 0
//                          skips the $ASSET leg. PLACEHOLDER, same as above.
//   LP_DISTRIBUTOR_ADDRESS overrides the deployments.json lookup of RewardsDistributor
//   LP_OVERTURE_ADDRESS    overrides the deployments.json lookup of TokenOverture
//   LP_ASSET               overrides the deployments.json lookup of the $ASSET token
//                          (LPZapper.asset in the registry)
//   CONFIRM=yes            required on mainnet, like every other state-changing script
//
//     LP_FUND_OVTR_AMOUNT=2000000 LP_FUND_ASSET_AMOUNT=3000 \
//       npx hardhat run scripts/lp-fund-rewards.js --network sepolia

const FUNDING_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function minter() view returns (address)",
  "function mint(address to, uint256 amount)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

const DISTRIBUTOR_ABI = [
  "function operator() view returns (address)",
  "function rewardToken(address token) view returns ((bool registered, bool enabled, bool conditional, bool claimsEnabled, uint8 decimals))",
];

/** A registry address, overridable by an env var; throws with the fix when neither exists. */
function resolve(chainId, envName, kind, field) {
  const explicit = process.env[envName];
  if (explicit) return hre.ethers.getAddress(explicit);
  const entry = (pools.readRegistry()[String(chainId)] || {})[kind];
  const value = entry && (field ? entry[field] : entry.address);
  if (!value) throw new Error(`No ${kind}${field ? `.${field}` : ""} for chain ${chainId} — set ${envName}`);
  return hre.ethers.getAddress(value);
}

/** Whole tokens -> smallest unit. Empty or "0" means "skip this leg". */
function parseAmount(envName, decimals) {
  const raw = (process.env[envName] || "").trim();
  if (raw === "" || raw === "0") return 0n;
  const amount = hre.ethers.parseUnits(raw, decimals);
  if (amount <= 0n) throw new Error(`${envName} must be positive — got ${raw}`);
  return amount;
}

async function fundLeg({ label, token, amount, decimals, symbol, distributor, signer, canSend, build, chainId }) {
  const human = hre.ethers.formatUnits(amount, decimals);
  const data = build.data;
  console.log(`\n${label}: ${human} ${symbol} into ${distributor}`);
  if (!canSend) {
    console.log(
      `  The signer ${signer.address} cannot send this one. Safe transaction for the operator:\n` +
        `    to:    ${token}\n    value: 0\n    data:  ${data}`
    );
    return false;
  }
  pools.requireConfirmation(chainId, `${label} ${human} ${symbol}`);
  await pools.send(`${label} ${human} ${symbol}`, signer, (o) => signer.sendTransaction({ to: token, data, ...o }));
  return true;
}

async function main() {
  const chainId = await pools.chainId();
  const signer = await pools.getSigner();

  const distributorAddress = resolve(chainId, "LP_DISTRIBUTOR_ADDRESS", "RewardsDistributor");
  const overtureAddress = resolve(chainId, "LP_OVERTURE_ADDRESS", "TokenOverture");
  const assetAddress = resolve(chainId, "LP_ASSET", "LPZapper", "asset");

  const distributor = new hre.ethers.Contract(distributorAddress, DISTRIBUTOR_ABI, hre.ethers.provider);
  const overture = new hre.ethers.Contract(overtureAddress, FUNDING_ABI, hre.ethers.provider);
  const asset = new hre.ethers.Contract(assetAddress, FUNDING_ABI, hre.ethers.provider);

  // Both legs must be reward tokens the distributor actually pays; funding anything else would
  // strand tokens until `recoverExcess`.
  for (const [label, address] of [["Overture token", overtureAddress], ["ASSET", assetAddress]]) {
    const state = await distributor.rewardToken(address);
    if (!state.registered) throw new Error(`${label} ${address} is not a reward token of ${distributorAddress}`);
  }

  const [ovtrSymbol, ovtrDecimals, assetSymbol, assetDecimals, minter, operator] = await Promise.all([
    overture.symbol(),
    overture.decimals(),
    asset.symbol(),
    asset.decimals(),
    overture.minter(),
    distributor.operator(),
  ]);
  const ovtrAmount = parseAmount("LP_FUND_OVTR_AMOUNT", Number(ovtrDecimals));
  const assetAmount = parseAmount("LP_FUND_ASSET_AMOUNT", Number(assetDecimals));
  if (ovtrAmount === 0n && assetAmount === 0n) {
    throw new Error("Set LP_FUND_OVTR_AMOUNT and/or LP_FUND_ASSET_AMOUNT (whole tokens)");
  }

  console.log(`Distributor: ${distributorAddress} (operator ${operator})`);
  console.log(`Signer:      ${signer.address}`);
  const before = [await overture.balanceOf(distributorAddress), await asset.balanceOf(distributorAddress)];
  console.log(
    `Balances before: ${hre.ethers.formatUnits(before[0], ovtrDecimals)} ${ovtrSymbol}, ` +
      `${hre.ethers.formatUnits(before[1], assetDecimals)} ${assetSymbol}`
  );

  const iface = new hre.ethers.Interface(FUNDING_ABI);
  if (ovtrAmount > 0n) {
    await fundLeg({
      label: "Minting",
      token: overtureAddress,
      amount: ovtrAmount,
      decimals: ovtrDecimals,
      symbol: ovtrSymbol,
      distributor: distributorAddress,
      signer,
      canSend: minter.toLowerCase() === signer.address.toLowerCase(),
      build: { data: iface.encodeFunctionData("mint", [distributorAddress, ovtrAmount]) },
      chainId,
    });
  }
  if (assetAmount > 0n) {
    const held = await asset.balanceOf(signer.address);
    await fundLeg({
      label: "Transferring",
      token: assetAddress,
      amount: assetAmount,
      decimals: assetDecimals,
      symbol: assetSymbol,
      distributor: distributorAddress,
      signer,
      canSend: held >= assetAmount,
      build: { data: iface.encodeFunctionData("transfer", [distributorAddress, assetAmount]) },
      chainId,
    });
  }

  const after = [await overture.balanceOf(distributorAddress), await asset.balanceOf(distributorAddress)];
  console.log(
    `\nBalances after:  ${hre.ethers.formatUnits(after[0], ovtrDecimals)} ${ovtrSymbol}, ` +
      `${hre.ethers.formatUnits(after[1], assetDecimals)} ${assetSymbol}` +
      (after[0] === before[0] && after[1] === before[1] ? "  (unchanged: nothing was sent by this run)" : "")
  );
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
