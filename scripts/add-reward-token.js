const hre = require("hardhat");
const pools = require("./lib/pools");
const { deployProxyPair } = require("./lib/proxies");
const { buildOperation, encodeSchedule, encodeExecute, describeOperation, TIMELOCK_KIND } = require("./lp-timelock");

// Add a NEW reward token to the LP program — step one of the timelock operation that does it.
//
// Adding a reward token is an OWNER-tier call on `RewardsDistributor`
// (`addRewardToken(token, conditional, claimsEnabled)`), so it goes through the `LPTimelock`:
// the multisig schedules it, waits out `minDelay` (48 h on mainnet), then executes it. This
// script prepares everything around that operation and sends NOTHING to the timelock:
//
//   1. the token itself — either an existing ERC-20 (`REWARD_TOKEN_ADDRESS`), or a new
//      Overture-shaped token deployed here: a `TokenOverture` implementation + `LPProxy`,
//      `initialize(name, symbol, owner = the timelock, minter = the RewardsDistributor proxy)`,
//      through the same `deployProxyPair` the stack deploy uses (validation + manifest). Every
//      reward token we deploy carries the `IMintableRewardToken` mint and names the distributor
//      as its single minter (decision 2026-10-07), so once the timelock has added it the operator
//      mints it with `RewardsDistributor.mintRewardToken` — into the distributor, or to a wallet.
//   2. a `RewardToken:<SYMBOL>` entry in deployments.json.
//   3. the timelock operation, printed: target, calldata, salt, id, the `schedule` and
//      `execute` calldata for the Safe, and the two `lp-timelock.js` command lines.
//   4. the follow-ups the rest of the stack needs (funding, the indexer, the backend, the
//      schedule).
//
// The token must be a PLAIN ERC-20 (see `RewardsDistributor.addRewardToken`): `decimals()` and
// `symbol()` readable as uint8/string, exact transfers, no callbacks. Once added, a claim of it
// reverts with `InsufficientFunds` until the distributor holds enough of it — there is no cap.
//
// ──────────────────────── environment ────────────────────────
//
//   REWARD_TOKEN_ADDRESS        an existing ERC-20 to add, OR
//   REWARD_TOKEN_NAME / REWARD_TOKEN_SYMBOL   deploy a new Overture-shaped token (18 decimals)
//   REWARD_TOKEN_CONDITIONAL    1 if the backend forfeits it on unstake (like $ASSET), 0 if not
//                               (like $OVTR). Required: it is a program decision.
//   REWARD_TOKEN_CLAIMS_ENABLED 1 to open its claims in the same operation, 0 to open later
//                               with `setClaimsEnabled`. Required.
//   REWARD_TOKEN_MINTER         minter of a NEW token (default: the RewardsDistributor proxy from
//                               deployments.json — the rule; override only for a rehearsal)
//   TIMELOCK_SALT_TAG           passed through to the printed operation (see lp-timelock.js)
//   CONFIRM=yes                 required on mainnet before the token deploy
//
//     REWARD_TOKEN_NAME="Test Reward" REWARD_TOKEN_SYMBOL=TRW REWARD_TOKEN_CONDITIONAL=0 \
//       REWARD_TOKEN_CLAIMS_ENABLED=1 npx hardhat run scripts/add-reward-token.js --network sepolia

const TOKEN_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];
const DISTRIBUTOR_ABI = [
  "function owner() view returns (address)",
  "function rewardToken(address token) view returns ((bool registered, bool enabled, bool conditional, bool claimsEnabled, uint8 decimals))",
];

function requireFlag(name) {
  const raw = process.env[name];
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  throw new Error(`Set ${name} to 0 or 1 — it is a program decision, there is no default`);
}

async function main() {
  const chainId = await pools.chainId();
  const network = hre.network.name;
  const registry = pools.readRegistry()[String(chainId)] || {};
  if (!registry.RewardsDistributor) throw new Error(`No RewardsDistributor for chain ${chainId} in deployments.json`);
  if (!registry[TIMELOCK_KIND]) throw new Error(`No ${TIMELOCK_KIND} for chain ${chainId} in deployments.json`);

  const distributorAddress = hre.ethers.getAddress(registry.RewardsDistributor.address);
  const timelockAddress = hre.ethers.getAddress(registry[TIMELOCK_KIND].address);
  const distributor = new hre.ethers.Contract(distributorAddress, DISTRIBUTOR_ABI, hre.ethers.provider);
  const conditional = requireFlag("REWARD_TOKEN_CONDITIONAL");
  const claimsEnabled = requireFlag("REWARD_TOKEN_CLAIMS_ENABLED");

  const owner = await distributor.owner();
  if (owner.toLowerCase() !== timelockAddress.toLowerCase()) {
    console.log(`WARNING: the distributor's owner is ${owner}, not the recorded timelock ${timelockAddress}.`);
  }

  // ── 1. the token ─────────────────────────────────────────────────────────────────────
  let tokenAddress;
  let extra = {};
  if (process.env.REWARD_TOKEN_ADDRESS) {
    tokenAddress = hre.ethers.getAddress(process.env.REWARD_TOKEN_ADDRESS);
    if ((await hre.ethers.provider.getCode(tokenAddress)) === "0x") throw new Error(`No code at ${tokenAddress}`);
  } else {
    const name = process.env.REWARD_TOKEN_NAME;
    const symbol = process.env.REWARD_TOKEN_SYMBOL;
    if (!name || !symbol) throw new Error("Set REWARD_TOKEN_ADDRESS, or REWARD_TOKEN_NAME and REWARD_TOKEN_SYMBOL");
    // The distributor proxy is the minter of every reward token we deploy; the operator reaches
    // `mint` only through `RewardsDistributor.mintRewardToken`.
    const minter = hre.ethers.getAddress(process.env.REWARD_TOKEN_MINTER || distributorAddress);
    if (minter !== distributorAddress) {
      console.log(
        `WARNING: REWARD_TOKEN_MINTER ${minter} is not the RewardsDistributor proxy ${distributorAddress}.\n` +
          `         RewardsDistributor.mintRewardToken cannot mint this token until the timelock moves its\n` +
          `         minter there with TokenOverture.setMinter.`
      );
    }
    const deployer = await pools.getSigner();
    console.log(`Deploying a new Overture-shaped reward token "${name}" (${symbol})`);
    console.log(`  owner = the timelock ${timelockAddress}, minter = ${minter}`);
    pools.requireConfirmation(chainId, `deploy the reward token ${symbol}`);
    const deployed = await deployProxyPair("TokenOverture", [], [name, symbol, timelockAddress, minter], deployer);
    tokenAddress = deployed.address;
    extra = {
      deployTx: deployed.tx.hash,
      block: deployed.receipt.blockNumber,
      implementation: deployed.impl.address,
      implementationTx: deployed.impl.tx.hash,
      owner: timelockAddress,
      minter,
    };
  }

  const token = new hre.ethers.Contract(tokenAddress, TOKEN_ABI, hre.ethers.provider);
  // The distributor will read exactly these two; failing here costs no 48 h wait.
  const symbol = await token.symbol();
  const decimals = Number(await token.decimals());
  const name = await token.name().catch(() => symbol);

  const state = await distributor.rewardToken(tokenAddress);
  if (state.registered) throw new Error(`${symbol} ${tokenAddress} is already a reward token of the distributor`);

  // ── 2. the registry entry ────────────────────────────────────────────────────────────
  pools.recordDeployment(chainId, `RewardToken:${symbol}`, tokenAddress, {
    ...extra,
    name,
    symbol,
    decimals,
    conditional,
    claimsEnabled,
    distributor: distributorAddress,
    addedVia: "timelock addRewardToken (pending until executed)",
  });

  // ── 3. the timelock operation ────────────────────────────────────────────────────────
  const op = buildOperation({
    target: distributorAddress,
    fn: "addRewardToken",
    args: [tokenAddress, conditional, claimsEnabled],
    tag: process.env.TIMELOCK_SALT_TAG || "",
  });
  const timelock = new hre.ethers.Contract(timelockAddress, ["function getMinDelay() view returns (uint256)"], hre.ethers.provider);
  const minDelay = await timelock.getMinDelay();
  const args = `${tokenAddress},${conditional},${claimsEnabled}`;
  console.log(
    `\n──────── the timelock operation (NOT sent by this script) ────────\n` +
      `${describeOperation(op)}\n` +
      `  calldata:  ${op.data}\n  salt:      ${op.salt}\n  id:        ${op.id}\n` +
      `  Safe -> timelock ${timelockAddress}\n` +
      `    schedule (delay ${minDelay}s): ${encodeSchedule(op, minDelay)}\n` +
      `    execute (after the delay):    ${encodeExecute(op)}\n\n` +
      `Or with the repo's front end (same operands for both):\n` +
      `  TIMELOCK_ACTION=schedule TIMELOCK_TARGET=RewardsDistributor TIMELOCK_FN=addRewardToken \\\n` +
      `    TIMELOCK_ARGS=${args} npx hardhat run scripts/lp-timelock.js --network ${network}\n` +
      `  TIMELOCK_ACTION=execute  TIMELOCK_TARGET=RewardsDistributor TIMELOCK_FN=addRewardToken \\\n` +
      `    TIMELOCK_ARGS=${args} npx hardhat run scripts/lp-timelock.js --network ${network}`
  );

  // ── 4. the follow-ups ────────────────────────────────────────────────────────────────
  console.log(
    `\n──────── after the execute ────────\n` +
      `1. Fund it: the distributor pays ${symbol} claims out of its own balance and reverts\n` +
      `   InsufficientFunds(token, needed, balance) until it holds enough. When the distributor is\n` +
      `   its minter (a token deployed here), the operator mints it in with\n` +
      `   MINT_TOKEN=${symbol} MINT_TO=${distributorAddress} MINT_AMOUNT=… npx hardhat run scripts/lp-mint-reward.js --network ${network}\n` +
      `   (RewardsDistributor.mintRewardToken; it needs the execute above first). Otherwise transfer\n` +
      `   ${symbol} into ${distributorAddress}.\n` +
      `2. Indexer module: register the token as an ERC-20 target from the execute block\n` +
      `   (init_lp_staking.sh with ADD_REWARD_TOKEN=1 REWARD_TOKEN_ADDRESS=${tokenAddress});\n` +
      `   RewardTokenAdded on the distributor announces it (decimals ${decimals}, conditional ${conditional}).\n` +
      `3. Backend: the token appears in lp_reward_tokens from the mirrored RewardTokenAdded event;\n` +
      `   it is priced (APR) only if it is $ASSET, otherwise shown as a quantity per epoch.\n` +
      `4. Schedule it: EPOCH_ACTION=set-amount EPOCH_ID=<a future epoch> EPOCH_TOKEN=${symbol} EPOCH_AMOUNT=…\n` +
      `   npx hardhat run scripts/lp-epoch.js --network ${network} (operator, at least 30 min before that epoch starts).`
  );
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
