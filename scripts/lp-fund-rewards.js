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
//   - $OVTR: the RewardsDistributor PROXY is the Overture token's minter (decision 2026-10-07),
//     so the OPERATOR mints $OVTR INTO the distributor through it —
//     `RewardsDistributor.mintRewardToken(ovtr, distributor, amount)`, sent to the distributor.
//     FALLBACK, for a stack that has not been upgraded to that model yet (Sepolia stack #6 before
//     its activation, where the minter is still the operator): when `TokenOverture.minter()` IS
//     the configured signer, the script sends the old direct `TokenOverture.mint(distributor,
//     amount)` instead. It prints which of the two paths it took. Any other minter is an error
//     that names the activation steps.
//   - $ASSET: the operator transfers $ASSET it already holds INTO the distributor —
//     `ASSET.transfer(distributor, amount)`.
//
// When the configured signer is the operator (for the `mintRewardToken` path), the minter (for
// the fallback) or holds the $ASSET (for $ASSET), the script sends the transaction. Otherwise —
// the mainnet case, where the operator is a Safe — it prints the exact `to` and `data` to paste
// into the Safe, and sends nothing. The `mintRewardToken` call is simulated from the operator's
// address first, so a Safe transaction that would revert is never printed.
//
// ──────────────────────── environment ────────────────────────
//
//   LP_FUND_OVTR_AMOUNT    $OVTR to mint into the distributor, in WHOLE tokens (decimals are
//                          read from chain). Empty or 0 skips the $OVTR leg. PLACEHOLDER:
//                          the launch figure is to be decided with Brandon.
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
  "function mintRewardToken(address token, address to, uint256 amount)",
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

/**
 * Sends one funding transaction, or prints it for the operator's Safe. `to` is the contract the
 * call goes to (the token, or the distributor for `mintRewardToken`); `data` its calldata.
 */
async function fundLeg({ label, to, data, amount, decimals, symbol, distributor, signer, canSend, chainId }) {
  const human = hre.ethers.formatUnits(amount, decimals);
  console.log(`\n${label}: ${human} ${symbol} into ${distributor}`);
  if (!canSend) {
    console.log(
      `  The signer ${signer.address} cannot send this one. Safe transaction for the operator:\n` +
        `    to:    ${to}\n    value: 0\n    data:  ${data}`
    );
    return false;
  }
  pools.requireConfirmation(chainId, `${label} ${human} ${symbol}`);
  await pools.send(`${label} ${human} ${symbol}`, signer, (o) => signer.sendTransaction({ to, data, ...o }));
  return true;
}

/**
 * The $OVTR leg's route, decided by `TokenOverture.minter()`:
 *   - the distributor proxy -> `RewardsDistributor.mintRewardToken`, sent by the operator;
 *   - the configured signer -> FALLBACK, the direct `TokenOverture.mint` (a pre-upgrade stack);
 *   - anything else         -> an error naming the activation steps.
 */
function overtureRoute({ minter, signer, operator, distributorAddress, overtureAddress, amount }) {
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  if (same(minter, distributorAddress)) {
    return {
      path: "mintRewardToken",
      label: "Minting through RewardsDistributor.mintRewardToken",
      note: "path: RewardsDistributor.mintRewardToken — the distributor is the Overture minter; the operator sends it",
      to: distributorAddress,
      data: new hre.ethers.Interface(DISTRIBUTOR_ABI).encodeFunctionData("mintRewardToken", [
        overtureAddress,
        distributorAddress,
        amount,
      ]),
      canSend: same(operator, signer.address),
    };
  }
  if (same(minter, signer.address)) {
    return {
      path: "fallback",
      label: "FALLBACK minting with TokenOverture.mint",
      note:
        "path: FALLBACK — direct TokenOverture.mint. The signer is still the token's minter, so this stack " +
        "has not been activated for mintRewardToken (scripts/README.md, 'Activating mintRewardToken on a live stack')",
      to: overtureAddress,
      data: new hre.ethers.Interface(FUNDING_ABI).encodeFunctionData("mint", [distributorAddress, amount]),
      canSend: true,
    };
  }
  throw new Error(
    `TokenOverture.minter() is ${minter}: neither the RewardsDistributor proxy ${distributorAddress} ` +
      `(the model since 2026-10-07) nor the signer ${signer.address} (the pre-upgrade fallback). ` +
      `Finish the activation — upgrade the distributor, then TokenOverture.setMinter(${distributorAddress}) ` +
      `through the timelock — or run this with the minter's key.`
  );
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
    const route = overtureRoute({
      minter,
      signer,
      operator,
      distributorAddress,
      overtureAddress,
      amount: ovtrAmount,
    });
    console.log(`\n$OVTR minter: ${minter}`);
    console.log(route.note);
    if (route.path === "mintRewardToken") {
      // Simulated from the OPERATOR's address, whoever signs this run: a distributor that has
      // not been upgraded yet, or a token whose minter moved, reverts here instead of in the Safe.
      try {
        await hre.ethers.provider.call({ from: operator, to: route.to, data: route.data });
      } catch (error) {
        throw new Error(
          `RewardsDistributor.mintRewardToken would revert when the operator ${operator} sends it: ` +
            `${error.shortMessage || error.message}. Is the distributor implementation upgraded?`
        );
      }
    }
    await fundLeg({
      label: route.label,
      to: route.to,
      data: route.data,
      amount: ovtrAmount,
      decimals: ovtrDecimals,
      symbol: ovtrSymbol,
      distributor: distributorAddress,
      signer,
      canSend: route.canSend,
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
      to: assetAddress,
      data: iface.encodeFunctionData("transfer", [distributorAddress, assetAmount]),
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
