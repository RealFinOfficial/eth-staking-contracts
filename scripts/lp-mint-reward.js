const hre = require("hardhat");
const pools = require("./lib/pools");

// Operator front end for `RewardsDistributor.mintRewardToken(token, to, amount)`: mint a
// mintable reward token straight to ONE wallet, outside the voucher / claim flow.
//
// Decision 2026-10-07: every reward token we deploy ($OVTR and any Overture-shaped token added
// later) carries the `IMintableRewardToken` mint and names the RewardsDistributor PROXY as its
// single minter. The operator multisig therefore never mints on the token directly; it calls
// `mintRewardToken` on the distributor, which is operator-only and has no timelock delay. Two
// uses:
//
//   - a user's wallet: the tokens land there directly; no claim ledger moves, and the user's
//     vouchers keep paying exactly what they paid before;
//   - the distributor's own address (`MINT_TO=distributor`): that pre-funds the claims of the
//     token, the same thing `lp-fund-rewards.js` does for $OVTR.
//
// A claim never mints: it still pays by transfer out of the distributor's funded balance.
//
// When the configured signer IS the distributor's operator, the script sends the transaction.
// Otherwise — the mainnet case, where the operator is a Safe — it prints the exact `to` and
// `data` for the Safe and sends nothing. Either way the call is first SIMULATED from the
// operator's address, so a Safe transaction that would revert is never printed. The checks that
// run before that name the reason in plain words, in the contract's order: the token is $ASSET
// (refused by address, whoever calls), it is not registered, it has no `minter()`, or its minter
// is not the distributor (a stack that has not been activated yet — scripts/README.md,
// "Activating mintRewardToken on a live stack").
//
// ──────────────────────── environment ────────────────────────
//
//   MINT_TOKEN             the reward token: a deployments.json kind ("TokenOverture",
//                          "RewardToken:TRW"), a symbol as the token reports it ("OVTR",
//                          case-insensitive, matched against the distributor's reward tokens),
//                          or an address. Required.
//   MINT_TO                the receiving wallet (an address), or `distributor` for the
//                          distributor proxy itself. Required.
//   MINT_AMOUNT            the amount in WHOLE tokens, converted with the token's own
//                          `decimals()` ("1.5" is allowed). Must be positive. Required.
//   LP_DISTRIBUTOR_ADDRESS overrides the deployments.json lookup of RewardsDistributor
//   CONFIRM=yes            required on mainnet, like every other state-changing script
//
//     MINT_TOKEN=OVTR MINT_TO=0xUserWallet MINT_AMOUNT=250 \
//       npx hardhat run scripts/lp-mint-reward.js --network sepolia
//     MINT_TOKEN=TokenOverture MINT_TO=distributor MINT_AMOUNT=2000000 \
//       npx hardhat run scripts/lp-mint-reward.js --network sepolia

const DISTRIBUTOR_ABI = [
  "function operator() view returns (address)",
  "function asset() view returns (address)",
  "function rewardTokens() view returns (address[])",
  "function rewardToken(address token) view returns ((bool registered, bool enabled, bool conditional, bool claimsEnabled, uint8 decimals))",
  "function mintRewardToken(address token, address to, uint256 amount)",
];

const TOKEN_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function minter() view returns (address)",
];

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** A required env var, trimmed. */
function required(name) {
  const raw = (process.env[name] || "").trim();
  if (raw === "") throw new Error(`Set ${name}`);
  return raw;
}

/**
 * The token named by MINT_TOKEN: an address as given, else a deployments.json kind for this
 * chain, else a symbol among the distributor's registered reward tokens.
 */
async function resolveToken(key, chainId, distributor) {
  if (ADDRESS.test(key)) return hre.ethers.getAddress(key);

  const entry = (pools.readRegistry()[String(chainId)] || {})[key];
  if (entry && entry.address) return hre.ethers.getAddress(entry.address);

  const symbols = [];
  for (const address of await distributor.rewardTokens()) {
    const symbol = await new hre.ethers.Contract(address, TOKEN_ABI, hre.ethers.provider).symbol();
    if (symbol.toLowerCase() === key.toLowerCase()) return hre.ethers.getAddress(address);
    symbols.push(symbol);
  }
  throw new Error(
    `MINT_TOKEN ${key} is neither an address, a deployments.json kind for chain ${chainId}, nor the ` +
      `symbol of a reward token of the distributor (${symbols.join(", ") || "none registered"})`
  );
}

async function main() {
  const chainId = await pools.chainId();
  const signer = await pools.getSigner();

  const rawDistributor = process.env.LP_DISTRIBUTOR_ADDRESS || pools.registryAddress(chainId, "RewardsDistributor");
  if (!rawDistributor) {
    throw new Error(`No RewardsDistributor for chain ${chainId} in deployments.json — set LP_DISTRIBUTOR_ADDRESS`);
  }
  const distributorAddress = hre.ethers.getAddress(rawDistributor);
  const distributor = new hre.ethers.Contract(distributorAddress, DISTRIBUTOR_ABI, hre.ethers.provider);

  const tokenAddress = await resolveToken(required("MINT_TOKEN"), chainId, distributor);
  const rawTo = required("MINT_TO");
  let to;
  if (rawTo.toLowerCase() === "distributor") to = distributorAddress;
  else if (ADDRESS.test(rawTo)) to = hre.ethers.getAddress(rawTo);
  else throw new Error(`MINT_TO must be an address or "distributor" — got ${rawTo}`);
  if (to === hre.ethers.ZeroAddress) throw new Error("MINT_TO is the zero address; the distributor refuses it");

  const token = new hre.ethers.Contract(tokenAddress, TOKEN_ABI, hre.ethers.provider);
  const [symbol, decimals, operator, state] = await Promise.all([
    token.symbol(),
    token.decimals(),
    distributor.operator(),
    distributor.rewardToken(tokenAddress),
  ]);
  const rawAmount = required("MINT_AMOUNT");
  const amount = hre.ethers.parseUnits(rawAmount, Number(decimals));
  if (amount <= 0n) throw new Error(`MINT_AMOUNT must be positive — got ${rawAmount}`);

  // The contract's own checks, in its order, said in words before anything is simulated. A v1
  // distributor has no `asset()`; the simulation below then names the missing upgrade.
  let assetAddress = null;
  try {
    assetAddress = hre.ethers.getAddress(await distributor.asset());
  } catch {
    assetAddress = null;
  }
  if (assetAddress !== null && tokenAddress === assetAddress) {
    throw new Error(
      `${symbol} ${tokenAddress} is the distributor's $ASSET: mintRewardToken refuses it by address ` +
        `(AssetNotMintable), whoever calls. $ASSET is funded by transfer only.`
    );
  }
  if (!state.registered) {
    throw new Error(`${symbol} ${tokenAddress} is not a reward token of ${distributorAddress} (UnknownRewardToken)`);
  }
  let minter;
  try {
    minter = hre.ethers.getAddress(await token.minter());
  } catch {
    throw new Error(
      `${symbol} ${tokenAddress} has no minter(): it is not a token we deployed, so it cannot be minted ` +
        `through the distributor. Fund it by transfer.`
    );
  }
  if (minter !== distributorAddress) {
    throw new Error(
      `${symbol}'s minter is ${minter}, not the distributor ${distributorAddress}: mintRewardToken would ` +
        `revert NotMinter. Activate the stack first (scripts/README.md, "Activating mintRewardToken on a ` +
        `live stack": the distributor upgrade, then TokenOverture.setMinter through the timelock).`
    );
  }

  const label = to === distributorAddress ? `${to} (the distributor itself: pre-funds claims)` : to;
  const balanceBefore = await token.balanceOf(to);
  console.log(`Distributor: ${distributorAddress} (operator ${operator})`);
  console.log(`Signer:      ${signer.address}`);
  console.log(`Token:       ${symbol} ${tokenAddress} (${decimals} decimals, minter = the distributor)`);
  console.log(`Recipient:   ${label}`);
  console.log(`Amount:      ${rawAmount} ${symbol} (${amount} in smallest units)`);
  console.log(`Balance before: ${hre.ethers.formatUnits(balanceBefore, decimals)} ${symbol}`);

  const data = distributor.interface.encodeFunctionData("mintRewardToken", [tokenAddress, to, amount]);

  // Simulated from the OPERATOR's address, whoever signs this run, so a distributor that has not
  // been upgraded yet reverts here and not in the Safe.
  try {
    await hre.ethers.provider.call({ from: operator, to: distributorAddress, data });
  } catch (error) {
    throw new Error(
      `RewardsDistributor.mintRewardToken would revert when the operator ${operator} sends it: ` +
        `${error.shortMessage || error.message}. Is the distributor implementation upgraded?`
    );
  }

  const summary = `mint ${rawAmount} ${symbol} to ${to}`;
  if (operator.toLowerCase() !== signer.address.toLowerCase()) {
    console.log(
      `\nThe signer ${signer.address} is not the operator ${operator}: nothing sent.\n` +
        `Safe transaction for the operator (RewardsDistributor.mintRewardToken):\n` +
        `    to:    ${distributorAddress}\n    value: 0\n    data:  ${data}`
    );
    return;
  }

  pools.requireConfirmation(chainId, summary);
  const receipt = await pools.send(`RewardsDistributor.mintRewardToken: ${summary}`, signer, (o) =>
    signer.sendTransaction({ to: distributorAddress, data, ...o })
  );
  const balanceAfter = await token.balanceOf(to);
  console.log(`  tx:   ${receipt.hash} (block ${receipt.blockNumber})`);
  console.log(
    `Balance after:  ${hre.ethers.formatUnits(balanceAfter, decimals)} ${symbol} ` +
      `(+${hre.ethers.formatUnits(balanceAfter - balanceBefore, decimals)})`
  );
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
