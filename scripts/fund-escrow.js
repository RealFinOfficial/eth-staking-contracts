const hre = require("hardhat");

const pools = require("./lib/pools");

// Campaign operator: put bonus tokens into the ApeBond {BonusEscrow} proxy.
//
// ──────────────────────── why this is a plain transfer ────────────────────────
//
// The escrow has no funding function, and that is by design. It holds obligations, not a
// deposit book: `reserve` records what is owed and `claim` pays it, and the only thing that
// makes a reservation possible is that the proxy's own ERC-20 balance covers `totalReserved`
// plus the new amount. So funding it is an ordinary ERC-20 `transfer` to the proxy address —
// there is nothing to call, nothing to approve and no counter to raise. `scripts/fund-rewards.js`
// looks similar and is NOT the same shape: the staking pool's `addRewards` pulls with
// `safeTransferFrom` and increments a counter, because there the balance and the counter are two
// different facts.
//
// What this script adds over sending the transfer by hand is the three numbers nobody should
// have to compute in their head at the keyboard: `totalReserved` (the floor under the balance,
// which this run must leave exactly where it found it), the FREE balance
// (`balance - totalReserved`, which is what a new purchase can actually reserve against), and
// what the deployer is left holding.
//
// ──────────────────────── the two ways to say how much ────────────────────────
//
// A fixed amount is what a campaign top-up is: "send 10,000". A TARGET is what a re-run is:
// "make sure the free balance is 10,000", which sends the difference and sends nothing at all
// when the free balance is already there. Exactly one of the two is given, because they answer
// different questions and a run that was handed both would have to guess which one the operator
// meant.
//
// ──────────────────────── the environment ────────────────────────
//
//   LP_APEBOND_FUND_AMOUNT   how much to send, in WHOLE tokens, e.g. "10000". Decimals come
//                            from the token itself, never from an assumption
//   LP_APEBOND_FUND_TARGET   the FREE balance to reach, in whole tokens. The run sends
//                            `target - free` and sends nothing when free >= target, so the same
//                            command is safe to repeat. Mutually exclusive with the above
//   LP_APEBOND_ESCROW        the escrow's address, when it is not the one recorded for this
//                            chain in the registry
//   DEPLOYMENTS_FILE         redirects the registry, like every other script here
//   CONFIRM=yes              required on mainnet
//
//     LP_APEBOND_FUND_AMOUNT=10000 npx hardhat run scripts/fund-escrow.js --network sepolia
//     LP_APEBOND_FUND_TARGET=10000 npx hardhat run scripts/fund-escrow.js --network sepolia
//
// The runbook is in scripts/README.md under "After the activation: opening the route".

/** The registry kind this script resolves. */
const ESCROW_KIND = "BonusEscrow";

/** The escrow's read surface. Nothing on it is called that changes state. */
const ESCROW_ABI = [
  "function bonusToken() view returns (address)",
  "function adapter() view returns (address)",
  "function owner() view returns (address)",
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
      "Set LP_APEBOND_FUND_AMOUNT (send exactly this much) or LP_APEBOND_FUND_TARGET (top the " +
        "FREE balance up to this much) — not both. They answer different questions."
    );
  }
  if (!amount && !target) {
    throw new Error(
      "Set LP_APEBOND_FUND_AMOUNT in whole tokens, e.g. LP_APEBOND_FUND_AMOUNT=10000, or " +
        "LP_APEBOND_FUND_TARGET to the free balance the escrow should end up with"
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
  const beforeFree = beforeEscrow > totalReserved ? beforeEscrow - totalReserved : 0n;

  console.log(`${ESCROW_KIND}:      ${escrowAddress} (proxy)`);
  console.log(`  ${pools.explorerAddress(chainId, escrowAddress)}`);
  console.log(`  adapter:        ${await escrow.adapter()}`);
  console.log(`  owner:          ${await escrow.owner()}`);
  console.log(`Network:          chain ${chainId} (${hre.network.name})`);
  console.log(`Bonus token:      ${await token.name()} (${symbol}) @ ${tokenAddress}`);
  console.log(`  decimals:       ${decimals} (read from the token)`);
  console.log(`From:             ${sender.address}`);
  console.log(`\n  — before —`);
  console.log(`  escrow balance: ${units(beforeEscrow)}`);
  console.log(`  totalReserved:  ${units(totalReserved)}  (the floor; this run must not move it)`);
  console.log(`  FREE balance:   ${units(beforeFree)}  (balance - totalReserved)`);
  console.log(`  sender balance: ${units(beforeSender)}`);

  // ──────── how much actually goes ────────

  let amount;
  if (mode === "amount") {
    amount = value;
    console.log(`\nRequested:        send exactly ${units(amount)} (LP_APEBOND_FUND_AMOUNT=${raw})`);
  } else {
    amount = value > beforeFree ? value - beforeFree : 0n;
    console.log(
      `\nRequested:        bring the FREE balance to ${units(value)} ` +
        `(LP_APEBOND_FUND_TARGET=${raw})`
    );
    console.log(`  free now:       ${units(beforeFree)}`);
    console.log(`  to send:        ${units(amount)}`);
  }

  if (amount === 0n) {
    console.log(
      mode === "target"
        ? `\nThe free balance is already at or above the target — nothing to send, nothing sent.`
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
  const afterFree = afterEscrow > afterReserved ? afterEscrow - afterReserved : 0n;

  console.log(`\n  — after —`);
  console.log(`  escrow balance: ${units(afterEscrow)}  (+${units(afterEscrow - beforeEscrow)})`);
  console.log(`  totalReserved:  ${units(afterReserved)}`);
  console.log(`  FREE balance:   ${units(afterFree)}  (+${units(afterFree - beforeFree)})`);
  console.log(`  sender balance: ${units(afterSender)}  (-${units(beforeSender - afterSender)})`);

  // Funding reserves nothing, so `totalReserved` must read exactly what it read before. A change
  // here means a purchase landed in the same window, not that this run did something.
  if (afterReserved !== totalReserved) {
    throw new Error(
      `totalReserved moved from ${units(totalReserved)} to ${units(afterReserved)} across this ` +
        `run. Funding reserves nothing, so a purchase landed in the same window — re-read the ` +
        `escrow before relying on the free balance printed above.`
    );
  }
  // A fee-on-transfer token would deliver less than it took. The escrow's accounting assumes it
  // does not, so a short delivery is reported rather than rounded past.
  if (afterEscrow - beforeEscrow !== amount) {
    throw new Error(
      `The escrow received ${units(afterEscrow - beforeEscrow)} but ${units(amount)} was sent. ` +
        `${symbol} does not deliver what it takes; the escrow's funding invariant assumes it does.`
    );
  }
  console.log(
    `\nDone. The escrow can back ${units(afterFree)} of new reservations; ${units(afterReserved)} ` +
      `is already owed.`
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
