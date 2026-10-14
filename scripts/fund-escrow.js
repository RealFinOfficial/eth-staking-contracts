const hre = require("hardhat");
const pools = require("./lib/pools");

// Campaign operator: put bonus tokens ($ASSET) into the ApeBond {BonusEscrow} proxy.
//
// ──────────────────────── reserve now, fund later ────────────────────────
//
// Since 2026-10-05 the escrow records every bonus WHATEVER its balance is (override O2 of the B.3
// decision document: no ceiling of any kind). The balance matters at exactly one moment: a claim
// pays the whole amount out of it, or reverts with `InsufficientFunds(needed, balance)` and changes
// nothing, until the company funds the escrow. So the escrow can be SHORT — more owed
// (`totalReserved`) than held — and the backend alerts when it is. This script is how the company
// closes that gap, and how it tops up ahead of the cliffs.
//
// It is a plain ERC-20 `transfer` to the proxy: the escrow has no funding function, nothing to
// approve and no counter to raise. What the script adds is the arithmetic nobody should do at the
// keyboard: the balance, `totalReserved`, and their difference — the SURPLUS when positive (only
// that much is reachable by `recoverSurplus`), the SHORTFALL when negative (that many claims would
// revert today) — before and after.
//
// ──────────────────────── the two ways to say how much ────────────────────────
//
//   LP_APEBOND_FUND_AMOUNT   send exactly this many WHOLE tokens, e.g. "10000". Decimals come
//                            from the token itself
//   LP_APEBOND_FUND_TARGET   make `balance - totalReserved` equal this many whole tokens: the run
//                            sends `target - (balance - totalReserved)`, which COVERS a shortfall
//                            first, and sends nothing when the escrow already holds that much.
//                            TARGET=0 means "cover exactly what is owed". Safe to repeat.
//   (exactly one of the two)
//   LP_APEBOND_ESCROW        the escrow's address, when it is not the one recorded for this chain
//   DEPLOYMENTS_FILE         redirects the registry, like every other script here
//   CONFIRM=yes              required on mainnet
//
//     LP_APEBOND_FUND_TARGET=0     npx hardhat run scripts/fund-escrow.js --network sepolia
//     LP_APEBOND_FUND_AMOUNT=10000 npx hardhat run scripts/fund-escrow.js --network sepolia

/** The registry kind this script resolves. */
const ESCROW_KIND = "BonusEscrow";

/** The escrow's read surface. Nothing on it is called that changes state. */
const ESCROW_ABI = [
  "function bonusToken() view returns (address)",
  "function adapter() view returns (address)",
  "function owner() view returns (address)",
  "function vault() view returns (address)",
  "function totalReserved() view returns (uint256)",
];

/** The token surface. `transfer` is the one state-changing call this script makes. */
const TOKEN_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 value) returns (bool)",
];

/**
 * The escrow this run funds: the explicit override, else the registry entry for this chain.
 * Never invented — money sent to an address nobody recorded is money nobody can claim.
 */
function resolveEscrow(chainId) {
  if (process.env.LP_APEBOND_ESCROW) {
    try {
      return hre.ethers.getAddress(process.env.LP_APEBOND_ESCROW);
    } catch {
      throw new Error(`LP_APEBOND_ESCROW is not a valid address: ${process.env.LP_APEBOND_ESCROW}`);
    }
  }
  const address = pools.registryAddress(chainId, ESCROW_KIND);
  if (!address) {
    throw new Error(
      `No ${ESCROW_KIND} recorded for chain ${chainId} in the deployment registry. Activate the ` +
        `route with scripts/deploy-apebond.js first, point DEPLOYMENTS_FILE at the registry that ` +
        `records it, or name the escrow with LP_APEBOND_ESCROW=0x…`
    );
  }
  return hre.ethers.getAddress(address);
}

/**
 * Which of the two inputs was given, parsed against the token's own decimals.
 *
 * @returns {{mode: "amount"|"target", value: bigint, raw: string}}
 */
function resolveRequest(decimals) {
  const amount = process.env.LP_APEBOND_FUND_AMOUNT;
  const target = process.env.LP_APEBOND_FUND_TARGET;

  if (amount && target) {
    throw new Error(
      "Set LP_APEBOND_FUND_AMOUNT (send exactly this much) or LP_APEBOND_FUND_TARGET (make " +
        "balance - totalReserved equal this much) — not both. They answer different questions."
    );
  }
  if (!amount && !target) {
    throw new Error(
      "Set LP_APEBOND_FUND_AMOUNT in whole tokens, e.g. LP_APEBOND_FUND_AMOUNT=10000, or " +
        "LP_APEBOND_FUND_TARGET to the surplus over totalReserved the escrow should end up with " +
        "(0 covers exactly what is owed)"
    );
  }

  const mode = amount ? "amount" : "target";
  const raw = (amount || target).trim();
  let value;
  try {
    value = hre.ethers.parseUnits(raw, decimals);
  } catch {
    throw new Error(
      `${mode === "amount" ? "LP_APEBOND_FUND_AMOUNT" : "LP_APEBOND_FUND_TARGET"} is not a ` +
        `number in whole tokens: ${raw}`
    );
  }
  if (value < 0n) {
    throw new Error(
      `${mode === "amount" ? "LP_APEBOND_FUND_AMOUNT" : "LP_APEBOND_FUND_TARGET"} is negative: ${raw}`
    );
  }
  return { mode, value, raw };
}

async function main() {
  const chainId = await pools.chainId();
  const sender = await pools.getSigner();

  const escrowAddress = resolveEscrow(chainId);
  if ((await hre.ethers.provider.getCode(escrowAddress)) === "0x") {
    throw new Error(`No contract code at ${ESCROW_KIND} ${escrowAddress}`);
  }

  const escrow = new hre.ethers.Contract(escrowAddress, ESCROW_ABI, hre.ethers.provider);
  const tokenAddress = hre.ethers.getAddress(await escrow.bonusToken());
  const token = new hre.ethers.Contract(tokenAddress, TOKEN_ABI, hre.ethers.provider);

  const decimals = Number(await token.decimals());
  const symbol = await token.symbol();
  const units = (value) => `${hre.ethers.formatUnits(value, decimals)} ${symbol}`;

  const { mode, value, raw } = resolveRequest(decimals);

  // ──────── the "before" side, read in one pass ────────

  const beforeEscrow = await token.balanceOf(escrowAddress);
  const beforeSender = await token.balanceOf(sender.address);
  const totalReserved = await escrow.totalReserved();
  // SIGNED: negative is a shortfall — claims worth that much would revert today.
  const beforeFree = beforeEscrow - totalReserved;
  const describeFree = (free) =>
    free >= 0n ? `${units(free)} surplus` : `${units(-free)} SHORT — claims revert InsufficientFunds`;

  console.log(`${ESCROW_KIND}:      ${escrowAddress} (proxy)`);
  console.log(`  ${pools.explorerAddress(chainId, escrowAddress)}`);
  console.log(`  adapter:        ${await escrow.adapter()}`);
  console.log(`  vault:          ${await escrow.vault()}`);
  console.log(`  owner:          ${await escrow.owner()}`);
  console.log(`Network:          chain ${chainId} (${hre.network.name})`);
  console.log(`Bonus token:      ${await token.name()} (${symbol}) @ ${tokenAddress}`);
  console.log(`  decimals:       ${decimals} (read from the token)`);
  console.log(`From:             ${sender.address}`);
  console.log(`\n  — before —`);
  console.log(`  escrow balance: ${units(beforeEscrow)}`);
  console.log(`  totalReserved:  ${units(totalReserved)}  (what is owed; this run must not move it)`);
  console.log(`  balance - owed: ${describeFree(beforeFree)}`);
  console.log(`  sender balance: ${units(beforeSender)}`);

  // ──────── how much actually goes ────────

  let amount;
  if (mode === "amount") {
    amount = value;
    console.log(`\nRequested:        send exactly ${units(amount)} (LP_APEBOND_FUND_AMOUNT=${raw})`);
  } else {
    amount = value > beforeFree ? value - beforeFree : 0n;
    console.log(
      `\nRequested:        bring balance - totalReserved to ${units(value)} ` +
        `(LP_APEBOND_FUND_TARGET=${raw})`
    );
    console.log(`  now:            ${describeFree(beforeFree)}`);
    console.log(`  to send:        ${units(amount)}`);
  }

  if (amount === 0n) {
    console.log(
      mode === "target"
        ? `\nThe escrow already holds the target over what it owes — nothing to send, nothing sent.`
        : `\nLP_APEBOND_FUND_AMOUNT is zero — nothing to send, nothing sent.`
    );
    return;
  }

  if (beforeSender < amount) {
    throw new Error(
      `Insufficient ${symbol} at ${sender.address}: need ${units(amount)}, have ` +
        `${units(beforeSender)}. Nothing was sent.`
    );
  }

  pools.requireConfirmation(chainId, `send ${units(amount)} into ${ESCROW_KIND} ${escrowAddress}`);

  const tokenAsSender = new hre.ethers.Contract(tokenAddress, TOKEN_ABI, sender);
  await pools.send(`Funding the escrow with ${units(amount)}`, sender, (o) =>
    tokenAsSender.transfer(escrowAddress, amount, o)
  );

  // ──────── the "after" side, and the one invariant ────────

  const afterEscrow = await token.balanceOf(escrowAddress);
  const afterSender = await token.balanceOf(sender.address);
  const afterReserved = await escrow.totalReserved();
  const afterFree = afterEscrow - afterReserved;

  console.log(`\n  — after —`);
  console.log(`  escrow balance: ${units(afterEscrow)}  (+${units(afterEscrow - beforeEscrow)})`);
  console.log(`  totalReserved:  ${units(afterReserved)}`);
  console.log(`  balance - owed: ${describeFree(afterFree)}`);
  console.log(`  sender balance: ${units(afterSender)}  (-${units(beforeSender - afterSender)})`);

  // Funding reserves nothing, so `totalReserved` must read exactly what it read before. A change
  // here means a purchase, a claim or a forfeiture landed in the same window.
  if (afterReserved !== totalReserved) {
    throw new Error(
      `totalReserved moved from ${units(totalReserved)} to ${units(afterReserved)} across this ` +
        `run. Funding reserves nothing, so a purchase, claim or forfeiture landed in the same ` +
        `window — re-read the escrow before relying on the figures printed above.`
    );
  }
  // A fee-on-transfer token would deliver less than it took. The escrow's accounting assumes it
  // does not, so a short delivery is reported rather than rounded past.
  if (afterEscrow - beforeEscrow !== amount) {
    throw new Error(
      `The escrow received ${units(afterEscrow - beforeEscrow)} but ${units(amount)} was sent. ` +
        `${symbol} does not deliver what it takes; the escrow's claims assume it does.`
    );
  }
  console.log(
    afterFree >= 0n
      ? `\nDone. Every reservation (${units(afterReserved)} owed) is covered; ${units(afterFree)} is surplus.`
      : `\nDone, but the escrow is still SHORT by ${units(-afterFree)}: claims of that much revert until it is funded.`
  );
}

module.exports = {
  ESCROW_KIND,
  ESCROW_ABI,
  TOKEN_ABI,
  resolveEscrow,
  resolveRequest,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
