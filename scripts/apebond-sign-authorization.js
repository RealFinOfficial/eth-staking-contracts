const fs = require("fs");
const path = require("path");
const ethers = require("ethers");
const hre = require("hardhat");

const pools = require("./lib/pools");
const rehearsal = require("./apebond-rehearsal");
const signing = require("../test/lp-staking/helpers/signing");

// A SIGN-ONLY ApeBond purchase authorization, for a third party that mints the position itself.
//
// ──────────────────────── what this is for ────────────────────────
//
// `apebond-rehearsal.js` plays BOTH sides of a purchase: it mints the position from a wallet that
// sits in the SoulZap seat, signs the authorization and calls `depositFor`, all in one run. That
// is no use to ApeBond's own SoulZap router on Sepolia, which mints the position in ITS contract
// and calls `adapter.depositFor(tokenId, authorization, signature)` from there. What the router
// needs from REAL is the other half only: one signed `{ authorization, signature }` pair it can
// present. This script produces exactly that pair and nothing else.
//
// It signs OFF CHAIN with the purchase-signer key and sends NO transaction. It reads the chain to
// check that the pair will be accepted — the key is the adapter's `purchaseSigner`, the router is
// allowlisted, the input token is one of the pool's two tokens, the range is on the pool's tick
// grid, the escrow can still back the bonus, and the adapter itself hashes the authorization to
// the digest that was signed — and it stops, having signed nothing, when any of those fails.
//
// ──────────────────────── test stacks only ────────────────────────
//
// This script REFUSES chain 1 outright, with no `CONFIRM=yes` escape. On mainnet a purchase
// authorization is issued by the backend's signing endpoint (roadmap step 5), which prices the
// quote and records it; it is never produced by hand from a key in an operator's `.env`.
//
// ──────────────────────── the environment ────────────────────────
//
//   LP_APEBOND_PURCHASE_SIGNER_KEY  the purchase-signer private key. Its address MUST equal
//                                   `adapter.purchaseSigner()` on chain. Never printed
//   LP_SIGN_BENEFICIARY             required: the buyer — credited as the vault staker and paid the
//                                   bonus. Must not be address(0), the adapter, the vault or the
//                                   position manager (the adapter rejects those)
//   LP_SIGN_SOULZAP_CALLER          required: the ONE address allowed to present the pair — the
//                                   router contract. Must be allowlisted (`soulZapCallers`)
//   LP_SIGN_INPUT_TOKEN             required: what the buyer paid with. Must be one of the pool's
//                                   two tokens. Audit trail only; the adapter never moves it
//   LP_SIGN_GROSS / LP_SIGN_NET     required: whole tokens, parsed with the INPUT token's
//                                   decimals. Net must not exceed gross
//   LP_SIGN_BONUS                   required: whole tokens of `escrow.bonusToken()`. Must not
//                                   exceed what the escrow can still reserve (balance minus
//                                   totalReserved). Zero means "no bonus leg"
//   LP_SIGN_CLIFF_SECONDS           bonusUnlockAt = chain time now + this (300). Fixed at SIGNING
//                                   time, not at deposit time
//   LP_SIGN_TICK_LOWER / _UPPER     required: integers, lower < upper, both multiples of the pool's
//                                   tickSpacing. The router must mint EXACTLY this range
//   LP_SIGN_MIN_LIQUIDITY           uint128 floor under the minted position's liquidity (1)
//   LP_SIGN_CAMPAIGN                bytes32 campaign id (the rehearsal campaign,
//                                   keccak256("REAL-APEBOND-REHEARSAL"))
//   LP_SIGN_DEADLINE_SECONDS        how long the pair stays valid, from chain time now (3600)
//   LP_SIGN_PURCHASE_ID             bytes32. Default: keccak256(abi.encode(campaign, beneficiary,
//                                   caller, nonce, chainId))
//   LP_SIGN_NONCE                   uint256. Default: chain time now in unix seconds, bumped while
//                                   `consumedNonces(nonce)` is true. An explicit nonce that is
//                                   already consumed stops the run
//   LP_SIGN_OUT                     output file. Default: apebond-authorization-<chainId>-<first 8
//                                   hex of purchaseId>.json beside the registry file (gitignored)
//   LP_APEBOND_ADAPTER/_ESCROW/_VAULT  address overrides for the registry lookups, exactly as in
//                                   `apebond-rehearsal.js` (escrow and vault are cross-checked
//                                   against the adapter's own)
//   DEPLOYMENTS_FILE                redirects the registry, like every other script here
//
//     LP_SIGN_BENEFICIARY=0x… LP_SIGN_SOULZAP_CALLER=0x… LP_SIGN_INPUT_TOKEN=0x… \
//     LP_SIGN_GROSS=1000 LP_SIGN_NET=990 LP_SIGN_BONUS=100 \
//     LP_SIGN_TICK_LOWER=-291360 LP_SIGN_TICK_UPPER=-288960 \
//       npx hardhat run scripts/apebond-sign-authorization.js --network sepolia
//
// ──────────────────────── what it writes ────────────────────────
//
// One JSON file (the pair plus the domain, the type hash, the digest and the signer) and one
// console block, "FOR THE ROUTER SIDE", which holds no secret and is meant to be pasted to the
// third party as it is. Nothing else is written, and no transaction is sent.
//
// A signed pair consumes nothing on chain until it is deposited, so two runs in the SAME second
// with the same beneficiary and caller produce the same default nonce and purchase id, and only
// one of the two pairs can ever land. Set LP_SIGN_NONCE to issue several pairs at once.

const DEFAULT_CLIFF_SECONDS = 300n;
const DEFAULT_DEADLINE_SECONDS = 3600n;
const DEFAULT_MIN_LIQUIDITY = 1n;
/** The rehearsal campaign's id, so a test-stack purchase is tagged the same way either route. */
const DEFAULT_CAMPAIGN_ID = ethers.id(rehearsal.REHEARSAL_CAMPAIGN);

const DOMAIN_NAME = "RealApeBondPurchase";
const DOMAIN_VERSION = "1";

/** How far the default nonce may be bumped past consumed ones before the run gives up. */
const MAX_NONCE_BUMPS = 1000;

/** Uniswap V3's usable tick bounds. A range outside them cannot be minted. */
const MIN_TICK = -887272;
const MAX_TICK = 887272;
const UINT64_MAX = (1n << 64n) - 1n;
const UINT128_MAX = (1n << 128n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;

/** Uniswap V3's fee -> tick spacing map, used only when the pool will not say. */
const TICK_SPACING_BY_FEE = { 100: 1, 500: 10, 3000: 60, 10000: 200 };

const FIELDS = signing.PURCHASE_AUTHORIZATION_FIELDS;
const TYPES = { PurchaseAuthorization: FIELDS };
/** The struct as an ABI tuple, derived from the one field list so no third copy exists. */
const AUTH_TUPLE = `(${FIELDS.map((f) => `${f.type} ${f.name}`).join(",")})`;

const ADAPTER_ABI = [
  "function vault() view returns (address)",
  "function escrow() view returns (address)",
  "function positionManager() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function purchaseSigner() view returns (address)",
  "function depositsPaused() view returns (bool)",
  "function soulZapCallers(address caller) view returns (bool)",
  "function consumedPurchaseIds(bytes32 purchaseId) view returns (bool)",
  "function consumedNonces(uint256 nonce) view returns (bool)",
  "function PURCHASE_AUTHORIZATION_TYPEHASH() view returns (bytes32)",
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
  `function hashPurchaseAuthorization(${AUTH_TUPLE} authorization) view returns (bytes32)`,
];

const ESCROW_ABI = [
  "function bonusToken() view returns (address)",
  "function adapter() view returns (address)",
  "function totalReserved() view returns (uint256)",
];

const VAULT_ABI = [
  "function pool() view returns (address)",
  "function depositsPaused() view returns (bool)",
  "function isStakeOperator(address account) view returns (bool)",
];

const POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function tickSpacing() view returns (int24)",
];

const TOKEN_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
];

// ──────────────────────── small helpers ────────────────────────

function sameAddress(a, b) {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

function isoOf(seconds) {
  return new Date(Number(seconds) * 1000).toISOString();
}

/** Throws on chain 1. No `CONFIRM=yes` escape: mainnet pairs come from the backend. */
function refuseMainnet(chainId) {
  if (pools.isMainnet(Number(chainId))) {
    throw new Error(
      "apebond-sign-authorization.js refuses to run on mainnet. It is a TEST-STACK script: it " +
        "signs a purchase authorization with a key read from the environment. On mainnet the " +
        "authorization is issued by the backend's signing endpoint (roadmap step 5)."
    );
  }
}

// ──────────────────────── the environment ────────────────────────

/**
 * Every LP_SIGN_* input, parsed as far as it can be without the chain. Amounts stay strings
 * here because their decimals are a chain fact; {buildAuthorization} parses them.
 *
 * @param {object} env `process.env` or a test's stand-in.
 */
function readSignInputs(env = process.env) {
  const text = (name) => {
    const raw = env[name];
    return raw === undefined || String(raw).trim() === "" ? undefined : String(raw).trim();
  };
  const required = (name) => {
    const value = text(name);
    if (value === undefined) throw new Error(`Set ${name}`);
    return value;
  };
  const address = (name) => {
    const value = required(name);
    try {
      return ethers.getAddress(value);
    } catch {
      throw new Error(`${name} is not a valid address: ${value}`);
    }
  };
  const wholeTokens = (name) => {
    const value = required(name);
    if (!/^[0-9]+(\.[0-9]+)?$/.test(value)) {
      throw new Error(`${name} must be a non-negative number of whole tokens (e.g. 1000 or 12.5): ${value}`);
    }
    return value;
  };
  const uint = (name, fallback) => {
    const value = text(name);
    if (value === undefined) return fallback;
    if (!/^[0-9]+$/.test(value)) throw new Error(`${name} must be a non-negative integer: ${value}`);
    const parsed = BigInt(value);
    if (parsed > UINT256_MAX) throw new Error(`${name} does not fit a uint256: ${value}`);
    return parsed;
  };
  const int = (name) => {
    const value = required(name);
    if (!/^-?[0-9]+$/.test(value)) throw new Error(`${name} must be an integer: ${value}`);
    return Number(value);
  };
  const bytes32 = (name, fallback) => {
    const value = text(name);
    if (value === undefined) return fallback;
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${name} must be a 0x-prefixed bytes32: ${value}`);
    return value.toLowerCase();
  };

  return {
    beneficiary: address("LP_SIGN_BENEFICIARY"),
    soulZapCaller: address("LP_SIGN_SOULZAP_CALLER"),
    inputToken: address("LP_SIGN_INPUT_TOKEN"),
    gross: wholeTokens("LP_SIGN_GROSS"),
    net: wholeTokens("LP_SIGN_NET"),
    bonus: wholeTokens("LP_SIGN_BONUS"),
    cliffSeconds: uint("LP_SIGN_CLIFF_SECONDS", DEFAULT_CLIFF_SECONDS),
    tickLower: int("LP_SIGN_TICK_LOWER"),
    tickUpper: int("LP_SIGN_TICK_UPPER"),
    minLiquidity: uint("LP_SIGN_MIN_LIQUIDITY", DEFAULT_MIN_LIQUIDITY),
    campaignId: bytes32("LP_SIGN_CAMPAIGN", DEFAULT_CAMPAIGN_ID),
    deadlineSeconds: uint("LP_SIGN_DEADLINE_SECONDS", DEFAULT_DEADLINE_SECONDS),
    purchaseId: bytes32("LP_SIGN_PURCHASE_ID", undefined),
    nonce: uint("LP_SIGN_NONCE", undefined),
    out: text("LP_SIGN_OUT"),
  };
}

/** The purchase-signer key as a provider-less wallet. The key itself is never printed. */
function readSignerWallet(env = process.env) {
  const raw = env.LP_APEBOND_PURCHASE_SIGNER_KEY;
  if (!raw || String(raw).trim() === "") {
    throw new Error("Set LP_APEBOND_PURCHASE_SIGNER_KEY to the purchase signer's private key");
  }
  try {
    return new ethers.Wallet(String(raw).trim());
  } catch {
    throw new Error("LP_APEBOND_PURCHASE_SIGNER_KEY is not a valid private key (the value is not printed)");
  }
}

// ──────────────────────── the chain ────────────────────────

/**
 * The first nonce the adapter has not consumed. An explicit nonce is reported as it is, with
 * its consumed flag, so the builder can refuse it by name; the default starts at `nowSeconds`
 * and walks forward past consumed ones.
 *
 * @param {{explicitNonce?: bigint, nowSeconds: number|bigint, isConsumed: (n: bigint) => Promise<boolean>}} args
 */
async function resolveNonce({ explicitNonce, nowSeconds, isConsumed }) {
  if (explicitNonce !== undefined) {
    return { nonce: explicitNonce, consumed: Boolean(await isConsumed(explicitNonce)), bumped: 0, explicit: true };
  }
  let nonce = BigInt(nowSeconds);
  for (let bumped = 0; bumped < MAX_NONCE_BUMPS; bumped++, nonce++) {
    if (!(await isConsumed(nonce))) return { nonce, consumed: false, bumped, explicit: false };
  }
  throw new Error(
    `Every nonce from ${nowSeconds} to ${nonce - 1n} is consumed on this adapter. Set LP_SIGN_NONCE.`
  );
}

/**
 * Everything the builder needs to know about the chain, read in one place. Read-only: the
 * provider is only ever asked `eth_call`, `eth_chainId` and `eth_getBlockByNumber`.
 *
 * The escrow and the vault are read OFF THE ADAPTER, because those are the contracts a
 * `depositFor` will actually touch.
 *
 * @param {{provider: object, adapterAddress: string, inputs: object}} args
 */
async function readChainState({ provider, adapterAddress, inputs }) {
  const adapter = new ethers.Contract(adapterAddress, ADAPTER_ABI, provider);
  const [network, block] = await Promise.all([provider.getNetwork(), provider.getBlock("latest")]);

  const [
    purchaseSigner,
    callerAllowlisted,
    token0,
    token1,
    fee,
    positionManager,
    vaultAddress,
    escrowAddress,
    typehash,
    rawDomain,
    adapterPaused,
  ] = await Promise.all([
    adapter.purchaseSigner(),
    adapter.soulZapCallers(inputs.soulZapCaller),
    adapter.token0(),
    adapter.token1(),
    adapter.fee(),
    adapter.positionManager(),
    adapter.vault(),
    adapter.escrow(),
    adapter.PURCHASE_AUTHORIZATION_TYPEHASH(),
    adapter.eip712Domain(),
    adapter.depositsPaused(),
  ]);

  const vault = new ethers.Contract(vaultAddress, VAULT_ABI, provider);
  const escrow = new ethers.Contract(escrowAddress, ESCROW_ABI, provider);
  const [poolAddress, vaultPaused, isStakeOperator, escrowAdapter, bonusTokenAddress, totalReserved] =
    await Promise.all([
      vault.pool(),
      vault.depositsPaused(),
      vault.isStakeOperator(adapterAddress),
      escrow.adapter(),
      escrow.bonusToken(),
      escrow.totalReserved(),
    ]);

  const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
  const [poolToken0, poolToken1] = await Promise.all([pool.token0(), pool.token1()]);
  let tickSpacing;
  let tickSpacingSource = "pool.tickSpacing()";
  try {
    tickSpacing = Number(await pool.tickSpacing());
  } catch {
    tickSpacing = TICK_SPACING_BY_FEE[Number(fee)];
    tickSpacingSource = `the standard spacing for fee ${fee}`;
  }

  const bonusToken = new ethers.Contract(bonusTokenAddress, TOKEN_ABI, provider);
  const [bonusDecimals, bonusSymbol, escrowBalance] = await Promise.all([
    bonusToken.decimals().then(Number),
    bonusToken.symbol(),
    bonusToken.balanceOf(escrowAddress),
  ]);
  const escrowFree = escrowBalance > totalReserved ? escrowBalance - totalReserved : 0n;

  // Decimals are read only for a token the builder will accept: anything else is refused
  // before its amounts matter, and may not even be an ERC-20.
  let inputDecimals;
  let inputSymbol;
  if (sameAddress(inputs.inputToken, token0) || sameAddress(inputs.inputToken, token1)) {
    const inputToken = new ethers.Contract(inputs.inputToken, TOKEN_ABI, provider);
    [inputDecimals, inputSymbol] = await Promise.all([inputToken.decimals().then(Number), inputToken.symbol()]);
  }

  const nonce = await resolveNonce({
    explicitNonce: inputs.nonce,
    nowSeconds: block.timestamp,
    isConsumed: (n) => adapter.consumedNonces(n),
  });

  return {
    chainId: Number(network.chainId),
    nowSeconds: block.timestamp,
    adapter: ethers.getAddress(adapterAddress),
    vault: ethers.getAddress(vaultAddress),
    escrow: ethers.getAddress(escrowAddress),
    positionManager: ethers.getAddress(positionManager),
    purchaseSigner: ethers.getAddress(purchaseSigner),
    callerAllowlisted,
    token0: ethers.getAddress(token0),
    token1: ethers.getAddress(token1),
    fee: Number(fee),
    pool: ethers.getAddress(poolAddress),
    poolToken0: ethers.getAddress(poolToken0),
    poolToken1: ethers.getAddress(poolToken1),
    tickSpacing,
    tickSpacingSource,
    inputDecimals,
    inputSymbol,
    bonusToken: ethers.getAddress(bonusTokenAddress),
    bonusDecimals,
    bonusSymbol,
    escrowBalance,
    totalReserved,
    escrowFree,
    typehash,
    domain: {
      name: rawDomain.name,
      version: rawDomain.version,
      chainId: rawDomain.chainId,
      verifyingContract: ethers.getAddress(rawDomain.verifyingContract),
    },
    nonce: nonce.nonce,
    nonceConsumed: nonce.consumed,
    nonceBumped: nonce.bumped,
    nonceExplicit: nonce.explicit,
    route: { adapterPaused, vaultPaused, isStakeOperator, escrowAdapter: ethers.getAddress(escrowAdapter) },
  };
}

// ──────────────────────── the builder (pure) ────────────────────────

/** The default purchase id: unique per campaign, buyer, router, nonce and chain. */
function defaultPurchaseId({ campaignId, beneficiary, soulZapCaller, nonce, chainId }) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "address", "address", "uint256", "uint256"],
      [campaignId, beneficiary, soulZapCaller, nonce, chainId]
    )
  );
}

/**
 * Builds the 14-field `PurchaseAuthorization` from the inputs and the chain facts, and checks
 * every condition that can be decided before signing. Pure: no provider, no clock of its own
 * (`chain.nowSeconds` is the clock), no I/O.
 *
 * Every check is evaluated, and when any fails the error lists all of the failures at once
 * and carries the full list as `error.checks`, so an operator fixes the whole environment in
 * one pass rather than one variable per run.
 *
 * @param {object} inputs {readSignInputs} output plus `signerAddress`, the address of the key
 *   that will sign.
 * @param {object} chain {readChainState} output.
 * @returns {{authorization: object, checks: {ok: boolean, message: string}[], figures: object}}
 */
function buildAuthorization(inputs, chain) {
  const checks = [];
  const check = (ok, message) => {
    checks.push({ ok: Boolean(ok), message });
    return Boolean(ok);
  };

  // The key and the domain.
  check(
    chain.purchaseSigner !== ethers.ZeroAddress,
    `adapter.purchaseSigner() is set (${chain.purchaseSigner}); zero means the route is closed`
  );
  check(
    sameAddress(inputs.signerAddress, chain.purchaseSigner),
    `LP_APEBOND_PURCHASE_SIGNER_KEY belongs to ${inputs.signerAddress}, and adapter.purchaseSigner() ` +
      `is ${chain.purchaseSigner}`
  );
  check(
    chain.domain.name === DOMAIN_NAME &&
      chain.domain.version === DOMAIN_VERSION &&
      BigInt(chain.domain.chainId) === BigInt(chain.chainId) &&
      sameAddress(chain.domain.verifyingContract, chain.adapter),
    `the adapter's EIP-712 domain is ${DOMAIN_NAME} / ${DOMAIN_VERSION} / chain ${chain.chainId} / ` +
      `${chain.adapter} (on chain: ${chain.domain.name} / ${chain.domain.version} / chain ` +
      `${chain.domain.chainId} / ${chain.domain.verifyingContract})`
  );
  check(
    chain.typehash === signing.purchaseAuthorizationTypeHash(),
    `adapter.PURCHASE_AUTHORIZATION_TYPEHASH() is the 14-field type hash this script signs ` +
      `(${chain.typehash})`
  );

  // The two parties.
  check(
    chain.callerAllowlisted,
    `adapter.soulZapCallers(${inputs.soulZapCaller}) is true — the router is allowlisted`
  );
  const forbiddenBeneficiaries = [ethers.ZeroAddress, chain.adapter, chain.vault, chain.positionManager];
  check(
    !forbiddenBeneficiaries.some((a) => sameAddress(a, inputs.beneficiary)),
    `the beneficiary ${inputs.beneficiary} is not address(0), the adapter, the vault or the ` +
      `position manager (the adapter rejects those with InvalidBeneficiary)`
  );

  // The pool and the input token.
  check(
    sameAddress(chain.poolToken0, chain.token0) && sameAddress(chain.poolToken1, chain.token1),
    `the vault's pool ${chain.pool} trades the adapter's pair ${chain.token0} / ${chain.token1}`
  );
  const inputIsPoolToken = check(
    sameAddress(inputs.inputToken, chain.token0) || sameAddress(inputs.inputToken, chain.token1),
    `LP_SIGN_INPUT_TOKEN ${inputs.inputToken} is one of the pool's two tokens (${chain.token0}, ${chain.token1})`
  );

  // The amounts.
  let grossInputAmount;
  let netInputAmount;
  if (inputIsPoolToken) {
    try {
      grossInputAmount = ethers.parseUnits(inputs.gross, chain.inputDecimals);
      netInputAmount = ethers.parseUnits(inputs.net, chain.inputDecimals);
    } catch {
      check(false, `LP_SIGN_GROSS ${inputs.gross} and LP_SIGN_NET ${inputs.net} fit ${chain.inputDecimals} decimals`);
    }
    if (grossInputAmount !== undefined && netInputAmount !== undefined) {
      check(
        netInputAmount <= grossInputAmount,
        `LP_SIGN_NET (${inputs.net}) is not above LP_SIGN_GROSS (${inputs.gross})`
      );
    }
  }
  let guaranteedBonusAmount;
  try {
    guaranteedBonusAmount = ethers.parseUnits(inputs.bonus, chain.bonusDecimals);
  } catch {
    check(false, `LP_SIGN_BONUS ${inputs.bonus} fits ${chain.bonusDecimals} decimals`);
  }
  if (guaranteedBonusAmount !== undefined) {
    check(
      guaranteedBonusAmount <= chain.escrowFree,
      `the escrow can still reserve ${ethers.formatUnits(chain.escrowFree, chain.bonusDecimals)} ` +
        `${chain.bonusSymbol} (balance minus totalReserved), and LP_SIGN_BONUS is ${inputs.bonus}`
    );
  }

  // The range.
  const { tickLower, tickUpper } = inputs;
  const ticksInRange = check(
    Number.isSafeInteger(tickLower) &&
      Number.isSafeInteger(tickUpper) &&
      tickLower >= MIN_TICK &&
      tickUpper <= MAX_TICK,
    `the ticks [${tickLower}, ${tickUpper}] are inside Uniswap V3's [${MIN_TICK}, ${MAX_TICK}]`
  );
  if (ticksInRange) {
    check(tickLower < tickUpper, `LP_SIGN_TICK_LOWER (${tickLower}) is below LP_SIGN_TICK_UPPER (${tickUpper})`);
    check(
      Boolean(chain.tickSpacing) && tickLower % chain.tickSpacing === 0 && tickUpper % chain.tickSpacing === 0,
      `[${tickLower}, ${tickUpper}] is on the pool's tick grid (tickSpacing ${chain.tickSpacing}, from ` +
        `${chain.tickSpacingSource})`
    );
  }

  // The clock-derived fields and the nonce.
  check(inputs.minLiquidity <= UINT128_MAX, `LP_SIGN_MIN_LIQUIDITY ${inputs.minLiquidity} fits a uint128`);
  check(inputs.deadlineSeconds >= 1n, `LP_SIGN_DEADLINE_SECONDS (${inputs.deadlineSeconds}) is at least 1`);
  const now = BigInt(chain.nowSeconds);
  const bonusUnlockAt = now + inputs.cliffSeconds;
  check(bonusUnlockAt <= UINT64_MAX, `bonusUnlockAt ${bonusUnlockAt} fits a uint64`);
  const deadline = now + inputs.deadlineSeconds;
  check(deadline <= UINT256_MAX, `the deadline ${deadline} fits a uint256`);
  check(!chain.nonceConsumed, `nonce ${chain.nonce} has not been used on this adapter`);

  const failures = checks.filter((c) => !c.ok);
  if (failures.length > 0) {
    const error = new Error(
      `${failures.length} check(s) failed; nothing was signed:\n` +
        failures.map((f) => `  FAIL  ${f.message}`).join("\n")
    );
    error.checks = checks;
    throw error;
  }

  const purchaseId =
    inputs.purchaseId ??
    defaultPurchaseId({
      campaignId: inputs.campaignId,
      beneficiary: inputs.beneficiary,
      soulZapCaller: inputs.soulZapCaller,
      nonce: chain.nonce,
      chainId: chain.chainId,
    });

  const authorization = {
    purchaseId,
    campaignId: inputs.campaignId,
    beneficiary: inputs.beneficiary,
    soulZapCaller: inputs.soulZapCaller,
    inputToken: inputs.inputToken,
    grossInputAmount,
    netInputAmount,
    guaranteedBonusAmount,
    bonusUnlockAt,
    minLiquidity: inputs.minLiquidity,
    expectedTickLower: tickLower,
    expectedTickUpper: tickUpper,
    nonce: chain.nonce,
    deadline,
  };

  return {
    authorization,
    checks,
    figures: {
      gross: inputs.gross,
      net: inputs.net,
      bonus: inputs.bonus,
      inputSymbol: chain.inputSymbol,
      inputDecimals: chain.inputDecimals,
      bonusSymbol: chain.bonusSymbol,
      bonusDecimals: chain.bonusDecimals,
    },
  };
}

// ──────────────────────── signing and verification ────────────────────────

/**
 * Signs `authorization` under `domain` with `key` (a private key or an ethers wallet), off
 * chain, and returns the signature with the local EIP-712 digest it covers.
 */
async function signAuthorization(authorization, key, domain) {
  const wallet = typeof key === "string" ? new ethers.Wallet(key) : key;
  const signature = await signing.signPurchaseAuthorization({ signer: wallet, domain, authorization });
  const digest = ethers.TypedDataEncoder.hash(domain, TYPES, authorization);
  return { signature, digest, signer: wallet.address };
}

/**
 * The two assertions that prove the pair will verify on chain: the adapter hashes the
 * authorization to the digest that was signed, and ECDSA recovery of the signature over that
 * digest yields the adapter's `purchaseSigner`. Throws on either mismatch.
 */
function verifyAuthorization({ domain, authorization, signature, digest, onChainDigest, purchaseSigner }) {
  const localDigest = ethers.TypedDataEncoder.hash(domain, TYPES, authorization);
  if (digest !== undefined && digest !== localDigest) {
    throw new Error(`The signed digest ${digest} is not the local EIP-712 digest ${localDigest}`);
  }
  if (onChainDigest !== localDigest) {
    throw new Error(
      `adapter.hashPurchaseAuthorization() returns ${onChainDigest}, the local EIP-712 encoder ` +
        `${localDigest}. The two encodings disagree; the pair would revert InvalidSignature. Nothing was written.`
    );
  }
  const recovered = ethers.recoverAddress(localDigest, signature);
  if (!sameAddress(recovered, purchaseSigner)) {
    throw new Error(`The signature recovers to ${recovered}, but adapter.purchaseSigner() is ${purchaseSigner}`);
  }
  return { digest: localDigest, recovered };
}

// ──────────────────────── output ────────────────────────

/** The 14 fields in struct order: bytes32 and addresses as hex, every number as a decimal string. */
function authorizationToJson(authorization) {
  const out = {};
  for (const { name, type } of FIELDS) {
    const value = authorization[name];
    out[name] = type === "bytes32" || type === "address" ? value : BigInt(value).toString();
  }
  return out;
}

function reminderLine(authorization) {
  return (
    `Mint exactly on ticks [${authorization.expectedTickLower}, ${authorization.expectedTickUpper}] ` +
    `with liquidity >= ${authorization.minLiquidity}; call depositFor from ` +
    `${authorization.soulZapCaller}; single use.`
  );
}

/** The whole JSON file. */
function authorizationRecord({ chainId, adapter, domain, typehash, authorization, signature, digest, signer, figures }) {
  return {
    chainId,
    adapter,
    domain: {
      name: domain.name,
      version: domain.version,
      chainId: Number(domain.chainId),
      verifyingContract: domain.verifyingContract,
    },
    typehash,
    authorization: authorizationToJson(authorization),
    signature,
    digest,
    signer,
    createdAt: new Date().toISOString(),
    deadlineIso: isoOf(authorization.deadline),
    bonusUnlockIso: isoOf(authorization.bonusUnlockAt),
    notes: [
      "TEST STACK ONLY. Mainnet authorizations are issued by the backend signing endpoint (roadmap step 5), not by this script.",
      reminderLine(authorization),
      `Amounts are in base units: grossInputAmount and netInputAmount in the input token's ${figures.inputDecimals} decimals, guaranteedBonusAmount in the bonus token's ${figures.bonusDecimals} decimals.`,
      "bonusUnlockAt was fixed at signing time (chain time + cliff), not at deposit time.",
      "The escrow could back the bonus when this was signed; a deposit reverts Underfunded if it cannot when it lands.",
    ],
  };
}

/** The console block for the third party. Holds no secret; meant to be pasted as it is. */
function routerBlock({ chainId, adapter, domain, authorization, signature, digest, figures }) {
  const json = authorizationToJson(authorization);
  const comments = {
    grossInputAmount: `${figures.gross} ${figures.inputSymbol}`,
    netInputAmount: `${figures.net} ${figures.inputSymbol}`,
    guaranteedBonusAmount: `${figures.bonus} ${figures.bonusSymbol}`,
    bonusUnlockAt: `${isoOf(authorization.bonusUnlockAt)} (UTC)`,
    deadline: `${isoOf(authorization.deadline)} (UTC)`,
  };
  const keyWidth = Math.max(...FIELDS.map((f) => f.name.length)) + 1;
  const valueWidth = Math.max(
    ...FIELDS.filter((f) => comments[f.name]).map((f) => JSON.stringify(json[f.name]).length + 1)
  );

  const lines = [
    "──────── FOR THE ROUTER SIDE ────────",
    `chain id:  ${chainId}`,
    `adapter:   ${adapter}`,
    "call:      depositFor(uint256 tokenId, PurchaseAuthorization authorization, bytes realSignature)",
    `EIP-712 domain: { name: "${domain.name}", version: "${domain.version}", chainId: ${domain.chainId}, verifyingContract: "${domain.verifyingContract}" }`,
    "authorization (PurchaseAuthorization, 14 fields in struct order, amounts in base units):",
    "{",
  ];
  for (const { name } of FIELDS) {
    const key = `${name}:`.padEnd(keyWidth + 1);
    const value = `${JSON.stringify(json[name])},`;
    lines.push(comments[name] ? `  ${key} ${value.padEnd(valueWidth)}  // ${comments[name]}` : `  ${key} ${value}`);
  }
  lines.push(
    "}",
    `signature: ${signature}`,
    `digest:    ${digest} (equals adapter.hashPurchaseAuthorization(authorization) on chain)`,
    `deadline:  ${isoOf(authorization.deadline)} UTC (unix ${authorization.deadline})`,
    reminderLine(authorization),
    "─────────────────────────────────────"
  );
  return lines.join("\n");
}

/** Where the JSON goes: LP_SIGN_OUT, else beside the registry this run reads. */
function resolveOutFile(chainId, purchaseId, out) {
  if (out) return path.resolve(out);
  const registryPath = process.env.DEPLOYMENTS_FILE
    ? path.resolve(process.env.DEPLOYMENTS_FILE)
    : path.join(__dirname, "..", "deployments.json");
  return path.join(path.dirname(registryPath), `apebond-authorization-${chainId}-${purchaseId.slice(2, 10)}.json`);
}

function printChecks(checks) {
  for (const { ok, message } of checks) console.log(`${ok ? "OK  " : "FAIL"}  ${message}`);
}

// ──────────────────────── the run ────────────────────────

async function main() {
  const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
  refuseMainnet(chainId);

  const inputs = readSignInputs(process.env);
  const wallet = readSignerWallet(process.env);

  console.log(`ApeBond sign-only authorization — chain ${chainId} (${hre.network.name}). No transaction is sent.`);
  const stack = await rehearsal.resolveStack(chainId);
  const chain = await readChainState({ provider: hre.ethers.provider, adapterAddress: stack.adapterAddress, inputs });

  console.log(`\n──────── the stack, read off the chain ────────`);
  console.log(`ApeBondPositionAdapter: ${chain.adapter}`);
  console.log(`BonusEscrow:            ${chain.escrow}`);
  console.log(`LPStakingVault:         ${chain.vault}`);
  console.log(`pool:                   ${chain.pool} (tickSpacing ${chain.tickSpacing})`);
  console.log(`token0 / token1:        ${chain.token0} / ${chain.token1}`);
  console.log(`bonusToken:             ${chain.bonusSymbol} ${chain.bonusToken} (${chain.bonusDecimals} decimals)`);
  console.log(
    `escrow free:            ${ethers.formatUnits(chain.escrowFree, chain.bonusDecimals)} ${chain.bonusSymbol} ` +
      `(balance ${ethers.formatUnits(chain.escrowBalance, chain.bonusDecimals)} minus totalReserved ` +
      `${ethers.formatUnits(chain.totalReserved, chain.bonusDecimals)})`
  );
  console.log(`chain time:             ${chain.nowSeconds} (${isoOf(chain.nowSeconds)})`);
  console.log(
    `nonce:                  ${chain.nonce}` +
      (chain.nonceExplicit ? " (LP_SIGN_NONCE)" : ` (chain time, bumped ${chain.nonceBumped} past used nonces)`)
  );

  console.log(`\n──────── the checks ────────`);
  let built;
  try {
    built = buildAuthorization({ ...inputs, signerAddress: wallet.address }, chain);
  } catch (error) {
    if (error.checks) printChecks(error.checks);
    throw error;
  }
  printChecks(built.checks);
  const { authorization, figures } = built;

  const adapter = new hre.ethers.Contract(chain.adapter, ADAPTER_ABI, hre.ethers.provider);
  if (await adapter.consumedPurchaseIds(authorization.purchaseId)) {
    throw new Error(`purchaseId ${authorization.purchaseId} has already been spent on this adapter. Nothing was signed.`);
  }
  console.log(`OK    purchaseId ${authorization.purchaseId} has not been spent on this adapter`);

  const { signature, digest, signer } = await signAuthorization(authorization, wallet, chain.domain);
  const onChainDigest = await adapter.hashPurchaseAuthorization(authorization);
  verifyAuthorization({
    domain: chain.domain,
    authorization,
    signature,
    digest,
    onChainDigest,
    purchaseSigner: chain.purchaseSigner,
  });
  console.log(`OK    adapter.hashPurchaseAuthorization() equals the local EIP-712 digest ${digest}`);
  console.log(`OK    the signature recovers to adapter.purchaseSigner() ${chain.purchaseSigner}`);

  // Facts about the route TODAY, not about the pair: the pair stays valid until its deadline,
  // but a deposit presented while one of these holds reverts.
  const warnings = [];
  if (chain.route.adapterPaused) warnings.push("adapter.depositsPaused() is true — depositFor reverts DepositsArePaused");
  if (chain.route.vaultPaused) warnings.push("vault.depositsPaused() is true — depositFor reverts in stakeFor");
  if (!chain.route.isStakeOperator) warnings.push("vault.isStakeOperator(adapter) is false — depositFor reverts in stakeFor");
  if (!sameAddress(chain.route.escrowAdapter, chain.adapter)) {
    warnings.push(`escrow.adapter() is ${chain.route.escrowAdapter}, not this adapter — the bonus reserve reverts NotAdapter`);
  }
  for (const warning of warnings) console.log(`WARN  ${warning}`);

  const outFile = resolveOutFile(chainId, authorization.purchaseId, inputs.out);
  const record = authorizationRecord({
    chainId,
    adapter: chain.adapter,
    domain: chain.domain,
    typehash: chain.typehash,
    authorization,
    signature,
    digest,
    signer,
    figures,
  });
  fs.writeFileSync(outFile, JSON.stringify(record, null, 2) + "\n");
  console.log(`\nWritten: ${outFile}\n`);

  console.log(routerBlock({ chainId, adapter: chain.adapter, domain: chain.domain, authorization, signature, digest, figures }));
}

module.exports = {
  DEFAULT_CLIFF_SECONDS,
  DEFAULT_DEADLINE_SECONDS,
  DEFAULT_MIN_LIQUIDITY,
  DEFAULT_CAMPAIGN_ID,
  refuseMainnet,
  readSignInputs,
  readSignerWallet,
  resolveNonce,
  readChainState,
  defaultPurchaseId,
  buildAuthorization,
  signAuthorization,
  verifyAuthorization,
  authorizationToJson,
  authorizationRecord,
  routerBlock,
  resolveOutFile,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
