// Operator front end for the `LPTimelock` that owns the five UUPS proxies: `LPStakingVault`,
// `RewardsDistributor`, `LPEpochRegistry`, `TokenOverture` and `LPZapper` — and, on a stack
// that carries the ApeBond route, the `BonusEscrow` proxy and the `ApeBondPositionAdapter`.
//
// Every owner-tier call on them — an upgrade, the zapper wiring, the bonus-escrow link, the
// stake-operator allowlist, the guardian, the operator, a new reward token, a reward token's
// switches, the Overture minter, the escrow's adapter and surplus, the adapter's campaigns and
// callers, an ownership move, and the timelock's own delay — has to go through this contract: schedule
// it, wait out `minDelay`, execute it. The operator tier is NOT here (`setTwapParams`,
// `rescuePosition`, `sweep`, `setSigner`, `recoverExcess`, `mintRewardToken`, the epoch
// schedule, the pauses): those are sent directly by the multisig with no delay. This script is the one place that
// builds the timelock transactions, so the calldata a Safe signs and the calldata the fork
// suites send are produced by the same code. `lp-switch-timelock.js` and `add-reward-token.js`
// build theirs with the builders exported below.
//
// ──────────────────────── how to run it ────────────────────────
//
// `hardhat run` accepts no positional arguments of its own (it rewrites `process.argv` to
// `[node, script]`), so the subcommand and its operands arrive as environment variables —
// the same convention every other script in this repo uses for its inputs:
//
//   TIMELOCK_ACTION=schedule TIMELOCK_TARGET=LPStakingVault TIMELOCK_FN=setGuardian \
//     TIMELOCK_ARGS=0xNewGuardian npx hardhat run scripts/lp-timelock.js --network sepolia
//
//   TIMELOCK_ACTION=execute  TIMELOCK_TARGET=LPStakingVault TIMELOCK_FN=setGuardian \
//     TIMELOCK_ARGS=0xNewGuardian npx hardhat run scripts/lp-timelock.js --network sepolia
//
//   TIMELOCK_ACTION=status  TIMELOCK_ID=0x… npx hardhat run scripts/lp-timelock.js --network sepolia
//   TIMELOCK_ACTION=cancel  TIMELOCK_ID=0x… npx hardhat run scripts/lp-timelock.js --network sepolia
//   TIMELOCK_ACTION=pending                 npx hardhat run scripts/lp-timelock.js --network sepolia
//
// `cancel` checks `canCancel(signer, id)` on the timelock first. When the signer cannot cancel
// the operation, the script prints the reason and sends nothing. When the signer holds no
// canceller role at all, it prints the `cancel` calldata for the canceller's Safe instead.
//
// ──────────────────────── the canceller role ────────────────────────
//
// `LPTimelock` lets REAL's Safe appoint a second canceller (ApeBonds' Safe) for a term of 1 to
// 180 days written on chain. REAL's Safe keeps its own canceller role with no term. The
// appointment is two steps, an offer and an acceptance, and five actions drive it:
//
//   TIMELOCK_ACTION=offer-canceller  CANCELLER_ADDRESS=0xApeSafe CANCELLER_TERM_DAYS=180 \
//     npx hardhat run scripts/lp-timelock.js --network sepolia
//   TIMELOCK_ACTION=accept-canceller CANCELLER_ADDRESS=0xApeSafe CANCELLER_TERM_DAYS=180 \
//     npx hardhat run scripts/lp-timelock.js --network sepolia
//   TIMELOCK_ACTION=withdraw-offer   CANCELLER_ADDRESS=0xApeSafe \
//     npx hardhat run scripts/lp-timelock.js --network sepolia
//   TIMELOCK_ACTION=revoke-canceller CANCELLER_ADDRESS=0xApeSafe \
//     npx hardhat run scripts/lp-timelock.js --network sepolia
//   TIMELOCK_ACTION=cancellers       npx hardhat run scripts/lp-timelock.js --network sepolia
//
// `offer-canceller`, `withdraw-offer` and `revoke-canceller` are calls of the timelock on
// itself (`offerCancellerRole`, `withdrawCancellerOffer`, `revokeRole(CANCELLER_ROLE, …)`), so
// each one is a scheduled operation like any other. The same command is run twice. The first run
// finds the operation unscheduled and schedules it. A run after `minDelay` finds it ready and
// executes it. A run in between prints the ready time and sends nothing. Each step sends only
// when the signer holds the role it needs (proposer, then executor), and prints the Safe
// transaction otherwise, exactly like `schedule` and `execute`.
//
// Before anything is scheduled, `offer-canceller` refuses what the contract would refuse at
// execution: the zero address, the timelock itself, a permanent canceller (REAL's Safe) and a
// term outside 1 to 180 days. Before an execute, `revoke-canceller` refuses while the
// appointee's term is still running (the execute would revert `CancellerTermActive`), and
// `withdraw-offer` refuses when there is no offer.
//
// `accept-canceller` is the appointee's own call, `acceptCancellerRole(CANCELLER_TERM_DAYS)`, and
// it has no delay. It must be sent inside the seven day window that opens when the offer
// executes, and it must name the offered term. When the signer is the appointee the script sends
// it. Otherwise it prints the calldata for the appointee's Safe. `CANCELLER_ADDRESS` defaults to
// the signer here. A missing, expired or mismatching offer is explained and nothing is sent.
//
// `cancellers` is read-only. It lists every address that ever received the canceller role or an
// offer (from the `RoleGranted` and `CancellerOffered` logs, scanned in chunks of at most 10,000
// blocks) plus every address in `CANCELLER_ADDRESS`, and prints for each: whether it holds the
// role, its term end, `isCancellerActive`, and its pending offer with `expiresAt`.
//
// `schedule` and `execute` take the SAME operands. That is deliberate: the operation id is a
// hash of the whole call tuple, so an execute that names a different argument than its
// schedule cannot be a typo that goes through — it is a different operation that does not
// exist.
//
// ──────────────────────── batches ────────────────────────
//
// Two more actions schedule and execute SEVERAL owner-tier calls as ONE timelock operation,
// which the contract runs in order, all or nothing. The calls come from a JSON file — an
// array of `{target, fn, args}` objects, where `target` is a registry kind or a raw address
// and `args` is an array in the function's own order:
//
//     [
//       { "target": "LPStakingVault", "fn": "upgradeToAndCall", "args": ["0xNewImpl", "0x"] },
//       { "target": "LPStakingVault", "fn": "setStakeOperator", "args": ["0xAdapter", "true"] }
//     ]
//
//   TIMELOCK_ACTION=schedule-batch TIMELOCK_BATCH=./activation.json \
//     npx hardhat run scripts/lp-timelock.js --network sepolia
//
//   TIMELOCK_ACTION=execute-batch  TIMELOCK_BATCH=./activation.json \
//     npx hardhat run scripts/lp-timelock.js --network sepolia
//
// Order and atomicity are the whole point. Activating the ApeBond route on a LIVE vault proxy
// is `upgradeToAndCall(newImplementation, 0x)` followed by `setStakeOperator(adapter, true)`,
// and the second call DOES NOT EXIST on the implementation the proxy runs before the first
// one: as two separate operations the second would be scheduled against code that has no such
// function and would revert after the delay. Inside one batch the upgrade lands first and the
// allowlist entry is written against the new code, in the same transaction.
//
// `status` and `cancel` need no batch variant — both take an id, and a batch id is an id.
// `pending` lists a batch as one row with every call under it.
//
// ──────────────────────── environment ────────────────────────
//
//   TIMELOCK_ACTION           schedule | execute | schedule-batch | execute-batch |
//                             cancel | status | pending | offer-canceller | accept-canceller |
//                             withdraw-offer | revoke-canceller | cancellers
//   TIMELOCK_TARGET           registry kind (LPStakingVault, RewardsDistributor,
//                             LPEpochRegistry, TokenOverture, LPZapper, BonusEscrow,
//                             ApeBondPositionAdapter, TimelockController) or a raw address
//   TIMELOCK_TARGET_ADDRESS   overrides the registry lookup for the target
//   TIMELOCK_FN               one of the owner-tier functions listed in OWNER_TIER below
//   TIMELOCK_ARGS             comma-separated arguments, in the function's own order
//   TIMELOCK_BATCH            schedule-batch / execute-batch; path to the JSON file above
//   TIMELOCK_SALT_TAG         distinguishes two otherwise identical operations (see below);
//                             applies to a batch too
//   TIMELOCK_DELAY            schedule / schedule-batch; defaults to `getMinDelay()`
//   TIMELOCK_ID               cancel / status
//   TIMELOCK_ADDRESS          overrides the registry lookup for the timelock itself
//   CANCELLER_ADDRESS         the appointee of offer-canceller, accept-canceller, withdraw-offer
//                             and revoke-canceller. For cancellers, extra addresses to report
//                             (comma-separated)
//   CANCELLER_TERM_DAYS       offer-canceller / accept-canceller. The term in whole days, 1..180
//   CONFIRM=yes               required on mainnet, like every other state-changing script
//
// ──────────────────────── the salt, and why it is derived ────────────────────────
//
// OpenZeppelin identifies an operation by `keccak256(abi.encode(target, value, data,
// predecessor, salt))`. Deriving the salt from the call itself
//
//     salt = keccak256(abi.encode("real.lp.timelock.v1", target, keccak256(data), tag))
//
// makes the id reproducible from nothing but the operands: schedule and execute agree without
// anyone having to write the salt down, and a third party can recompute the id of a pending
// operation from the public calldata alone. `predecessor` is always zero — this repo has no
// ordered operation chains.
//
// The cost of a derived salt is that the SAME call cannot be scheduled twice: once an
// operation is executed its state is `Done`, and OZ refuses to schedule a `Done` id again.
// `TIMELOCK_SALT_TAG` is the escape hatch — any string that has not been used before for that
// exact call produces a fresh id. Set it whenever an identical call has to run a second time
// (rotating the guardian back, re-pausing a leg, re-applying a parameter).
//
// A batch derives its salt the same way, from the whole list rather than from one call:
//
//     salt = keccak256(abi.encode("real.lp.timelock.v1.batch",
//                                 keccak256(abi.encode(targets, payloads)), tag))
//
// A different namespace string, so a one-call batch and the single operation that makes the
// same call can never share a salt; every value is zero, so they are not folded in.

const fs = require("fs");
const ethers = require("ethers");
const { scanLogs } = require("./lib/logs");

// ──────────────────────── the operations this script can build ────────────────────────

/**
 * The owner tier, in full. Everything here is `onlyOwner` on a contract the timelock owns, so
 * everything here can ONLY be reached through a scheduled operation. The guardian tier (the
 * vault's two pauses, the distributor's `pause`) and the operator tier (`setTwapParams`,
 * `rescuePosition`, `sweep`, `setSigner`, `recoverExcess`, the distributor's `mintRewardToken`
 * — the operator's only road to minting $OVTR, since the distributor proxy is the token's
 * minter — the registry's epoch functions, those same pauses and the unpauses, which are the
 * operator's alone) are deliberately absent: those are one-transaction
 * calls the hot key and the multisig send directly, and routing them through here would defeat
 * the reason they exist.
 *
 * `kinds` is the set of registry entries the function is legal on, which is what turns a
 * mistyped target into an error rather than a transaction that reverts after the delay.
 *
 * The same table is the whole vocabulary of a BATCH: every call in a `TIMELOCK_BATCH` file is
 * one entry from here, resolved and encoded exactly as a single operation would be, and a
 * batch may mix targets freely — the ApeBond activation is two calls on the vault, a later
 * adapter replacement is two on the vault and one on the escrow. Nothing in a batch may carry
 * ether: every value is zero, like every single operation this script builds.
 */
const PROXY_KINDS = ["LPStakingVault", "RewardsDistributor", "LPEpochRegistry", "TokenOverture", "LPZapper"];

/**
 * The ApeBond contracts (on Sepolia test stack #6 since 6 Oct, and part of the mainnet launch
 * deploy since the decision of 14 Oct 2026). `BonusEscrow` is a sixth UUPS proxy, Ownable2Step
 * like the five above; `ApeBondPositionAdapter` is `Ownable2Step` too (audit L-03) but has no
 * upgrade path — it is replaced, not upgraded.
 */
const ESCROW_KIND = "BonusEscrow";
const ADAPTER_KIND = "ApeBondPositionAdapter";

const OWNER_TIER = {
  acceptOwnership: {
    signature: "function acceptOwnership()",
    kinds: [...PROXY_KINDS, ESCROW_KIND, ADAPTER_KIND],
    note:
      "the second half of the Ownable2Step handover; the NEW owner (a timelock) sends it. On the " +
      "adapter it is the first call of the activation and replace-adapter batches",
  },
  transferOwnership: {
    signature: "function transferOwnership(address newOwner)",
    kinds: [...PROXY_KINDS, ESCROW_KIND, ADAPTER_KIND],
    note:
      "nominates a new owner on the Ownable2Step contracts (the five proxies, the escrow and the " +
      "adapter, used to move them to a new timelock); the nominee holds nothing until it sends " +
      "acceptOwnership",
  },
  setZapper: {
    signature: "function setZapper(address newZapper)",
    kinds: ["LPStakingVault"],
    note: "points the deposit path at a new periphery contract, or at address(0) to close it",
  },
  setBonusEscrow: {
    signature: "function setBonusEscrow(address newEscrow)",
    kinds: ["LPStakingVault"],
    note: "links the bonus escrow notified on unstake and rebalance, or address(0) to unlink it",
  },
  setStakeOperator: {
    signature: "function setStakeOperator(address stakeOperator, bool allowed)",
    kinds: ["LPStakingVault"],
    note: "adds or removes one trusted periphery contract on the `stakeFor` allowlist",
  },
  setGuardian: {
    signature: "function setGuardian(address newGuardian)",
    kinds: ["LPStakingVault", "RewardsDistributor", ADAPTER_KIND],
    note: "moves the undelayed pause tier to another hot key; on the two proxies it takes "
      + "address(0) to revoke and is owner OR operator since 2026-09-14 (the operator can also "
      + "send it directly), on the adapter it is owner OR the vault's operator since audit C-29 "
      + "and zero is rejected",
  },
  setOperator: {
    signature: "function setOperator(address newOperator)",
    kinds: ["LPStakingVault", "RewardsDistributor", "LPEpochRegistry", "LPZapper"],
    note: "moves the undelayed routine-operations tier to another multisig",
  },
  addRewardToken: {
    signature: "function addRewardToken(address token, bool conditional, bool claimsEnabled)",
    kinds: ["RewardsDistributor"],
    note: "adds a pre-funded reward token; claims of it revert with InsufficientFunds until it is funded",
  },
  setRewardTokenEnabled: {
    signature: "function setRewardTokenEnabled(address token, bool enabled)",
    kinds: ["RewardsDistributor"],
    note: "puts a reward token on, or takes it off, the emission schedule (does not touch claims)",
  },
  setClaimsEnabled: {
    signature: "function setClaimsEnabled(address token, bool enabled)",
    kinds: ["RewardsDistributor"],
    note:
      "opens or closes the claims of one reward token (e.g. $ASSET, 90 days after the mainnet launch " +
      "(opened by the timelock on order))",
  },
  setMinter: {
    signature: "function setMinter(address newMinter)",
    kinds: ["TokenOverture"],
    note: "moves the Overture token's minter role (the RewardsDistributor proxy since 2026-10-07), "
      + "or address(0) to stop minting",
  },
  setAdapter: {
    signature: "function setAdapter(address newAdapter)",
    kinds: [ESCROW_KIND],
    note: "points the escrow at the adapter allowed to reserve, or at address(0) to close it",
  },
  recoverSurplus: {
    signature: "function recoverSurplus(address to)",
    kinds: [ESCROW_KIND],
    note: "moves `balance - totalReserved` out; no amount argument, so no reservation is reachable",
  },
  recoverSurplusAmount: {
    signature: "function recoverSurplus(address to, uint256 amount)",
    kinds: [ESCROW_KIND],
    note:
      "moves a named amount of `balance - totalReserved` out; reverts SurplusExceeded above it, " +
      "so no reservation is reachable. The amount is in wei, 18 decimals: " +
      "1,000 $ASSET = 1000000000000000000000",
  },
  setSoulZapCaller: {
    signature: "function setSoulZapCaller(address caller, bool allowed)",
    kinds: [ADAPTER_KIND],
    note: "adds or removes one SoulZap contract on the depositFor allowlist",
  },
  setCampaign: {
    signature:
      "function setCampaign(bytes32 campaignId, (bool enabled, int24 downTicks, int24 upTicks, " +
      "int24 toleranceTicks, uint64 bonusCliffSeconds, uint16 bonusBps, uint256 minBonusAmount) config)",
    kinds: [ADAPTER_KIND],
    note:
      "creates or reconfigures one campaign: the band's offsets below and above the $ASSET price at " +
      "purchase and its tolerance, cliff, rate (<= 10,000 bps), minimum bonus. Pass the config as an " +
      "array or object in a TIMELOCK_BATCH file",
  },
  setCampaignEnabled: {
    signature: "function setCampaignEnabled(bytes32 campaignId, bool enabled)",
    kinds: [ADAPTER_KIND],
    note: "switches one existing campaign on or off",
  },
  setCampaignCaller: {
    signature: "function setCampaignCaller(bytes32 campaignId, address caller, bool allowed)",
    kinds: [ADAPTER_KIND],
    note: "permits or removes one caller for one campaign (the global allowlist is also needed)",
  },
  setValuationWindow: {
    signature: "function setValuationWindow(uint32 window)",
    kinds: [ADAPTER_KIND],
    note:
      "sets the window whose mean tick values every bonus (audit L-02), 300..3600 s; the pool must " +
      "already serve it (ceil(w / 6) + 1 current slots and w seconds of history)",
  },
  upgradeToAndCall: {
    signature: "function upgradeToAndCall(address newImplementation, bytes data)",
    kinds: [...PROXY_KINDS, ESCROW_KIND],
    note: "the upgrade itself; `data` is the reinitializer call, or 0x for none",
  },
  updateDelay: {
    signature: "function updateDelay(uint256 newDelay)",
    kinds: ["TimelockController"],
    note: "changing the delay is itself a delayed, publicly visible operation",
  },
  // The canceller appointment. Like `updateDelay`, these are calls of the timelock on itself:
  // each needs DEFAULT_ADMIN_ROLE, which only the timelock holds, so each is a scheduled
  // operation. The `offer-canceller`, `withdraw-offer` and `revoke-canceller` actions build them.
  offerCancellerRole: {
    signature: "function offerCancellerRole(address account, uint32 termDays)",
    kinds: ["TimelockController"],
    note:
      "offers the canceller role for termDays (1..180). The address accepts it within 7 days of " +
      "the execution, naming the same term",
  },
  withdrawCancellerOffer: {
    signature: "function withdrawCancellerOffer(address account)",
    kinds: ["TimelockController"],
    note: "deletes an executed, unaccepted canceller offer",
  },
  // The road for a rotated Safe to PROPOSER_ROLE and EXECUTOR_ROLE (a 48 h operation). For
  // CANCELLER_ROLE it reverts CancellerGrantOnlyByAcceptance for every caller, the timelock's
  // own scheduled call included, so the builder refuses that role before anything is scheduled:
  // the only road to the canceller role is `offer-canceller` and its acceptance.
  grantRole: {
    signature: "function grantRole(bytes32 role, address account)",
    kinds: ["TimelockController"],
    note:
      "grants a timelock role, e.g. PROPOSER_ROLE or EXECUTOR_ROLE to a rotated Safe. For " +
      "CANCELLER_ROLE it reverts CancellerGrantOnlyByAcceptance: use offer-canceller instead",
  },
  revokeRole: {
    signature: "function revokeRole(bytes32 role, address account)",
    kinds: ["TimelockController"],
    note:
      "revokes a timelock role. For CANCELLER_ROLE it reverts CancellerTermActive at execute " +
      "while the holder's term is running",
  },
};

const OWNER_TIER_INTERFACE = new ethers.Interface(
  Object.values(OWNER_TIER).map((spec) => spec.signature)
);

// Each entry's fragment, resolved once here by FULL signature, not by name: `recoverSurplus` is
// overloaded (two entries) and ethers refuses a bare overloaded name. A typo fails at load.
for (const spec of Object.values(OWNER_TIER)) {
  spec.fragment = OWNER_TIER_INTERFACE.getFunction(ethers.FunctionFragment.from(spec.signature).format());
}

/**
 * The timelock surface this script sends and reads: OZ v5's `TimelockController` plus what
 * `LPTimelock` adds for the term-limited canceller role (its functions, events and errors). The
 * errors are listed so a revert decodes to its name.
 */
const TIMELOCK_INTERFACE = new ethers.Interface([
  "function schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay)",
  "function execute(address target, uint256 value, bytes payload, bytes32 predecessor, bytes32 salt) payable",
  "function scheduleBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt, uint256 delay)",
  "function executeBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt) payable",
  "function hashOperation(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt) pure returns (bytes32)",
  "function hashOperationBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt) pure returns (bytes32)",
  "function cancel(bytes32 id)",
  "function getMinDelay() view returns (uint256)",
  "function getTimestamp(bytes32 id) view returns (uint256)",
  "function isOperation(bytes32 id) view returns (bool)",
  "function isOperationPending(bytes32 id) view returns (bool)",
  "function isOperationReady(bytes32 id) view returns (bool)",
  "function isOperationDone(bytes32 id) view returns (bool)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function getRoleAdmin(bytes32 role) view returns (bytes32)",
  "function grantRole(bytes32 role, address account)",
  "function revokeRole(bytes32 role, address account)",
  "function renounceRole(bytes32 role, address callerConfirmation)",
  "function PROPOSER_ROLE() view returns (bytes32)",
  "function EXECUTOR_ROLE() view returns (bytes32)",
  "function CANCELLER_ROLE() view returns (bytes32)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function MAX_CANCELLER_TERM_DAYS() view returns (uint32)",
  "function CANCELLER_OFFER_WINDOW() view returns (uint64)",
  "function cancellerOffer(address account) view returns (uint32 termDays, uint64 expiresAt)",
  "function cancellerTermEnd(address account) view returns (uint64)",
  "function scheduledAt(bytes32 id) view returns (uint64)",
  "function offerCancellerRole(address account, uint32 termDays)",
  "function withdrawCancellerOffer(address account)",
  "function acceptCancellerRole(uint32 termDays)",
  "function isCancellerActive(address account) view returns (bool)",
  "function canCancel(address account, bytes32 id) view returns (bool)",
  "event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)",
  "event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)",
  "event Cancelled(bytes32 indexed id)",
  "event MinDelayChange(uint256 oldDuration, uint256 newDuration)",
  "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
  "event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)",
  "event CancellerOffered(address indexed account, uint32 termDays, uint64 expiresAt)",
  "event CancellerOfferWithdrawn(address indexed account)",
  "event CancellerAccepted(address indexed account, uint64 termEnd)",
  "error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)",
  "error BootstrapAdminNotAllowed(address admin)",
  "error InvalidCancellerAccount(address account)",
  "error CancellerTermOutOfBounds(uint32 termDays)",
  "error NoCancellerOffer(address account)",
  "error CancellerOfferExpired(address account, uint64 expiresAt)",
  "error CancellerTermMismatch(uint32 offered, uint32 accepted)",
  "error CancellerTermActive(address account, uint64 termEnd)",
  "error CancellerTermEnded(address account, uint64 termEnd, bytes32 id)",
  "error CancellerGrantOnlyByAcceptance()",
]);

/** OZ's role ids: `keccak256("CANCELLER_ROLE")` and the zero admin role. */
const CANCELLER_ROLE = ethers.id("CANCELLER_ROLE");
const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;

/** `LPTimelock.MAX_CANCELLER_TERM_DAYS` and `CANCELLER_OFFER_WINDOW`, as decided on 2026-10-30. */
const MAX_CANCELLER_TERM_DAYS = 180;
const CANCELLER_OFFER_WINDOW = 7n * 86_400n;

/** The three canceller actions that are calls of the timelock on itself, and the function each builds. */
const CANCELLER_SELF_CALLS = {
  "offer-canceller": "offerCancellerRole",
  "withdraw-offer": "withdrawCancellerOffer",
  "revoke-canceller": "revokeRole",
};

/** This repo schedules no ordered chains, so an operation never waits on another one. */
const PREDECESSOR = ethers.ZeroHash;

/** Namespaced so a salt from this repo can never collide with one from another tool. */
const SALT_NAMESPACE = "real.lp.timelock.v1";

/** Its own namespace, so a one-call batch and the same call alone are different operations. */
const BATCH_SALT_NAMESPACE = "real.lp.timelock.v1.batch";

/** The registry key the timelock records itself under. */
const TIMELOCK_KIND = "TimelockController";

const ACTIONS = [
  "schedule",
  "execute",
  "schedule-batch",
  "execute-batch",
  "cancel",
  "status",
  "pending",
  ...Object.keys(CANCELLER_SELF_CALLS),
  "accept-canceller",
  "cancellers",
];

// ──────────────────────── builders (pure; the suites import these) ────────────────────────

/**
 * Coerces string operands — everything that arrives through the environment is a string —
 * into the types the fragment declares. Anything already typed is passed through untouched,
 * which is how the fork suites hand in a BigInt or an address object.
 */
function coerceArgs(fn, args) {
  const fragment = OWNER_TIER[fn].fragment;
  if (args.length !== fragment.inputs.length) {
    throw new Error(
      `${fn} takes ${fragment.inputs.length} argument(s) ` +
        `(${fragment.inputs.map((i) => `${i.type} ${i.name}`).join(", ") || "none"}) — got ${args.length}`
    );
  }
  return fragment.inputs.map((input, index) => coerceValue(fn, `argument ${index} (${input.name})`, input, args[index]));
}

/**
 * One value, by its ABI parameter. Strings become what the type needs (`true`/`false`, a BigInt);
 * a tuple — `ApeBondPositionAdapter.setCampaign`'s `CampaignConfig` — is taken as an array in
 * component order or as an object by component name (a batch file can hold either), or as the
 * JSON text of one, and every component is coerced the same way. A bool is never left to
 * ethers' truthiness: the string "false" would otherwise encode as true.
 */
function coerceValue(fn, label, input, raw) {
  if (input.baseType === "tuple") {
    let value = raw;
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        throw new Error(`${fn} ${label} must be a JSON array or object for ${input.type} — got ${raw}`);
      }
    }
    const parts = Array.isArray(value)
      ? value
      : input.components.map((component) => {
          if (!value || !(component.name in value)) {
            throw new Error(`${fn} ${label} is missing ${component.name}`);
          }
          return value[component.name];
        });
    if (parts.length !== input.components.length) {
      throw new Error(`${fn} ${label} needs ${input.components.length} components — got ${parts.length}`);
    }
    return input.components.map((component, i) =>
      coerceValue(fn, `${label}.${component.name}`, component, parts[i])
    );
  }
  if (input.type === "bool") {
    if (raw === true || raw === "true") return true;
    if (raw === false || raw === "false") return false;
    throw new Error(`${fn} ${label} must be true or false — got ${raw}`);
  }
  if (typeof raw !== "string" && typeof raw !== "number") return raw;
  if (input.type.startsWith("uint") || input.type.startsWith("int")) return BigInt(raw);
  return raw;
}

/** Empty string means no arguments, not one empty argument. */
function splitArgs(raw) {
  if (!raw) return [];
  return raw.split(",").map((value) => value.trim());
}

/** ABI-encodes one owner-tier call. */
function encodeOwnerCall(fn, args = []) {
  if (!OWNER_TIER[fn]) {
    throw new Error(`${fn} is not an owner-tier function — one of ${Object.keys(OWNER_TIER).join(", ")}`);
  }
  const coerced = coerceArgs(fn, args);
  if (fn === "grantRole" && String(coerced[0]).toLowerCase() === CANCELLER_ROLE) {
    throw new Error(
      "grantRole(CANCELLER_ROLE, …) reverts CancellerGrantOnlyByAcceptance for every caller, the " +
        "timelock's own scheduled call included. The canceller role is reached only through " +
        "TIMELOCK_ACTION=offer-canceller and the appointee's acceptance."
    );
  }
  return OWNER_TIER_INTERFACE.encodeFunctionData(OWNER_TIER[fn].fragment, coerced);
}

/**
 * The salt this repo uses, documented at the top of the file: a hash of the call itself plus
 * an optional tag, so schedule and execute agree without carrying a value between them.
 */
function deriveSalt({ target, data, tag = "" }) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "address", "bytes32", "string"],
      [SALT_NAMESPACE, ethers.getAddress(target), ethers.keccak256(data), tag]
    )
  );
}

/**
 * OZ's own `hashOperation`, recomputed off-chain: `keccak256(abi.encode(target, value, data,
 * predecessor, salt))`. Recomputing rather than calling the contract means an id can be
 * quoted before the timelock exists — which the deploy script needs, since it prints the
 * mainnet Safe payloads in the same run that deploys the timelock.
 */
function operationId({ target, value = 0n, data, predecessor = PREDECESSOR, salt }) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256", "bytes", "bytes32", "bytes32"],
      [ethers.getAddress(target), value, data, predecessor, salt]
    )
  );
}

/**
 * Everything one operation is: the call, its salt, and its id. The single object that
 * `schedule`, `execute` and `cancel` all read from, so the three can never disagree.
 *
 * @param {{target: string, fn: string, args?: Array<unknown>, tag?: string, value?: bigint}} spec
 */
function buildOperation({ target, fn, args = [], tag = "", value = 0n }) {
  const data = encodeOwnerCall(fn, args);
  const salt = deriveSalt({ target, data, tag });
  return {
    fn,
    args,
    tag,
    target: ethers.getAddress(target),
    value,
    data,
    predecessor: PREDECESSOR,
    salt,
    id: operationId({ target, value, data, salt }),
  };
}

/** The `schedule(...)` calldata a Safe signs. */
function encodeSchedule(op, delay) {
  return TIMELOCK_INTERFACE.encodeFunctionData("schedule", [
    op.target,
    op.value,
    op.data,
    op.predecessor,
    op.salt,
    delay,
  ]);
}

/** The `execute(...)` calldata a Safe signs once the delay has elapsed. */
function encodeExecute(op) {
  return TIMELOCK_INTERFACE.encodeFunctionData("execute", [
    op.target,
    op.value,
    op.data,
    op.predecessor,
    op.salt,
  ]);
}

/**
 * The `cancel(id)` calldata. REAL's Safe, a permanent canceller, may send it for any pending id. A
 * term canceller (ApeBonds' Safe) may send it only for an id scheduled before its term end.
 */
function encodeCancel(id) {
  return TIMELOCK_INTERFACE.encodeFunctionData("cancel", [id]);
}

/** The operands of one operation, printed the same way by every action that builds one. */
function printOperation(op) {
  console.log(`\nOperation: ${describeOperation(op)}`);
  console.log(`  calldata:    ${op.data}`);
  console.log(`  predecessor: ${op.predecessor}`);
  console.log(`  salt:        ${op.salt}`);
  console.log(`  id:          ${op.id}`);
}

/** Human-readable one-liner for an operation, used by the CLI and by the deploy script. */
function describeOperation(op) {
  const rendered = coerceArgs(op.fn, op.args).map((value) => String(value));
  return `${op.fn}(${rendered.join(", ")}) on ${op.target}` + (op.tag ? ` [tag ${op.tag}]` : "");
}

// ──────────────────────── batch builders ────────────────────────

/**
 * The batch salt, documented at the top of the file: a hash of the whole call list plus an
 * optional tag, under its own namespace string. The values are not folded in because every
 * value this script builds is zero; the targets and the payloads are the operation.
 */
function deriveBatchSalt({ targets, payloads, tag = "" }) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const calls = coder.encode(
    ["address[]", "bytes[]"],
    [targets.map((target) => ethers.getAddress(target)), payloads]
  );
  return ethers.keccak256(
    coder.encode(
      ["string", "bytes32", "string"],
      [BATCH_SALT_NAMESPACE, ethers.keccak256(calls), tag]
    )
  );
}

/**
 * OZ's own `hashOperationBatch`, recomputed off-chain: `keccak256(abi.encode(targets, values,
 * payloads, predecessor, salt))`. Same reason as {operationId}: an id has to be quotable
 * before any transaction is sent, and by a third party who only has the public calldata.
 */
function batchOperationId({ targets, values, payloads, predecessor = PREDECESSOR, salt }) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address[]", "uint256[]", "bytes[]", "bytes32", "bytes32"],
      [targets.map((target) => ethers.getAddress(target)), values, payloads, predecessor, salt]
    )
  );
}

/**
 * Everything one BATCH operation is: the ordered calls, their salt, and the single id all of
 * them share. The timelock runs the calls in this order inside one transaction and reverts
 * the whole operation if any of them reverts, which is what makes an upgrade followed by a
 * call that only exists AFTER that upgrade a legal thing to schedule.
 *
 * Each op is `{target, fn, args}` — the same three operands a single operation takes — plus an
 * optional `kind`, the registry entry the target was resolved from. When a kind is given it is
 * checked against the function's own `kinds` list, exactly as the single actions check
 * `TIMELOCK_TARGET`, so a call aimed at the wrong contract is refused here rather than after
 * the delay.
 *
 * @param {Array<{target: string, fn: string, args?: Array<unknown>|string, kind?: string}>} ops
 * @param {string} tag
 */
function buildBatch(ops, tag = "") {
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new Error("A batch needs at least one call — got none");
  }

  const calls = ops.map((op, index) => {
    if (!op || typeof op !== "object" || Array.isArray(op)) {
      throw new Error(`Batch call ${index} must be an object {target, fn, args}`);
    }
    const { fn, kind } = op;
    if (!fn || !OWNER_TIER[fn]) {
      throw new Error(
        `Batch call ${index}: ${fn || "(no fn)"} is not an owner-tier function — ` +
          `one of ${Object.keys(OWNER_TIER).join(", ")}`
      );
    }
    if (kind && !OWNER_TIER[fn].kinds.includes(kind)) {
      throw new Error(
        `Batch call ${index}: ${fn} is not a function of ${kind} — ` +
          `it is legal on ${OWNER_TIER[fn].kinds.join(", ")}`
      );
    }
    if (typeof op.target !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(op.target)) {
      throw new Error(`Batch call ${index}: target must be an address — got ${op.target}`);
    }
    const args = typeof op.args === "string" ? splitArgs(op.args) : op.args || [];
    return {
      fn,
      args,
      kind,
      target: ethers.getAddress(op.target),
      value: 0n,
      data: encodeOwnerCall(fn, args),
    };
  });

  const targets = calls.map((call) => call.target);
  const values = calls.map((call) => call.value);
  const payloads = calls.map((call) => call.data);
  const salt = deriveBatchSalt({ targets, payloads, tag });

  return {
    calls,
    tag,
    targets,
    values,
    payloads,
    predecessor: PREDECESSOR,
    salt,
    id: batchOperationId({ targets, values, payloads, salt }),
  };
}

/** The `scheduleBatch(...)` calldata a Safe signs. */
function encodeScheduleBatch(batch, delay) {
  return TIMELOCK_INTERFACE.encodeFunctionData("scheduleBatch", [
    batch.targets,
    batch.values,
    batch.payloads,
    batch.predecessor,
    batch.salt,
    delay,
  ]);
}

/** The `executeBatch(...)` calldata a Safe signs once the delay has elapsed. */
function encodeExecuteBatch(batch) {
  return TIMELOCK_INTERFACE.encodeFunctionData("executeBatch", [
    batch.targets,
    batch.values,
    batch.payloads,
    batch.predecessor,
    batch.salt,
  ]);
}

/** Human-readable one-liner for one call inside a batch. */
function describeCall(call) {
  const rendered = coerceArgs(call.fn, call.args).map((value) => String(value));
  return `${call.fn}(${rendered.join(", ")}) on ${call.target}`;
}

// ──────────────────────── the CLI ────────────────────────

async function main() {
  const hre = require("hardhat");
  const pools = require("./lib/pools");

  const chainId = await pools.chainId();
  const action = process.env.TIMELOCK_ACTION;
  if (!ACTIONS.includes(action)) {
    throw new Error(`Set TIMELOCK_ACTION to one of ${ACTIONS.join(", ")}`);
  }

  const timelockAddress =
    process.env.TIMELOCK_ADDRESS || pools.registryAddress(chainId, TIMELOCK_KIND);
  if (!timelockAddress) {
    throw new Error(
      `No ${TIMELOCK_KIND} recorded for chain ${chainId} in deployments.json — ` +
        `set TIMELOCK_ADDRESS=<address> instead`
    );
  }
  const code = await hre.ethers.provider.getCode(timelockAddress);
  if (code === "0x") throw new Error(`No contract code at ${timelockAddress} on chain ${chainId}`);

  const timelock = new hre.ethers.Contract(
    timelockAddress,
    TIMELOCK_INTERFACE,
    hre.ethers.provider
  );
  const minDelay = await timelock.getMinDelay();

  console.log(`Timelock:  ${timelockAddress}`);
  console.log(`  ${pools.explorerAddress(chainId, timelockAddress)}`);
  console.log(`minDelay:  ${minDelay}s`);

  if (action === "pending") return listPending(hre, pools, timelock, chainId);
  if (action === "status") return reportStatus(timelock, requireId(), minDelay);

  if (CANCELLER_SELF_CALLS[action]) {
    return runCancellerSelfCall({ hre, pools, timelock, timelockAddress, chainId, minDelay, action });
  }
  if (action === "accept-canceller") return acceptCanceller({ hre, pools, timelock, timelockAddress, chainId });
  if (action === "cancellers") return listCancellers({ hre, pools, timelock, chainId });

  if (action === "cancel") {
    const id = requireId();
    await reportStatus(timelock, id, minDelay);
    const signer = await pools.getSigner();
    // An operation that is not pending (never scheduled, cancelled or executed) cannot be
    // cancelled by anyone, so nothing is sent or printed for a Safe: the call would revert
    // TimelockUnexpectedOperationState.
    if (!(await timelock.isOperationPending(id))) {
      console.log(`\nOperation ${id} is not pending (never scheduled, cancelled or executed): nothing to cancel.`);
      return;
    }
    const cancelData = encodeCancel(id);
    console.log(`  cancel calldata: ${cancelData}`);
    // `canCancel` answers exactly what `cancel` would do, so a refusal is explained here instead
    // of becoming a reverted transaction. A signer without the role gets the Safe calldata.
    if (!(await timelock.canCancel(signer.address, id))) {
      const holds = await signerHoldsRole({
        timelock,
        timelockAddress,
        roleName: "CANCELLER_ROLE",
        signer,
        fn: "cancel",
        data: cancelData,
      });
      if (holds) await explainCancelRefusal(timelock, signer.address, id);
      return;
    }
    pools.requireConfirmation(chainId, `cancel timelock operation ${id}`);
    await pools.send(`Cancelling ${id}`, signer, (o) =>
      timelock.connect(signer).cancel(id, o)
    );
    return;
  }

  if (action === "schedule-batch" || action === "execute-batch") {
    // schedule-batch / execute-batch — same file, same operation, same rules as the single
    // pair above: print the operands and the calldata a Safe would sign, then send when the
    // signer holds the timelock role the action needs, or print the Safe transaction and stop
    // when it does not.
    const batch = buildBatch(
      readBatchFile().map((entry, index) => resolveBatchEntry(pools, chainId, entry, index)),
      process.env.TIMELOCK_SALT_TAG || ""
    );

    console.log(
      `\nBatch of ${batch.calls.length} call(s)` + (batch.tag ? ` [tag ${batch.tag}]` : "")
    );
    batch.calls.forEach((call, index) => {
      console.log(`  ${index}. ${describeCall(call)}`);
      console.log(`     calldata: ${call.data}`);
    });
    console.log(`  predecessor: ${batch.predecessor}`);
    console.log(`  salt:        ${batch.salt}`);
    console.log(`  id:          ${batch.id}`);

    const batchSigner = await pools.getSigner();

    if (action === "schedule-batch") {
      const delay = resolveDelay(minDelay);
      const scheduleBatchData = encodeScheduleBatch(batch, delay);
      console.log(`  scheduleBatch calldata: ${scheduleBatchData}`);
      const canSchedule = await signerHoldsRole({
        timelock,
        timelockAddress,
        roleName: "PROPOSER_ROLE",
        signer: batchSigner,
        fn: "scheduleBatch",
        data: scheduleBatchData,
      });
      if (!canSchedule) return;
      pools.requireConfirmation(chainId, `schedule batch ${batch.id}`);
      await pools.send(
        `Scheduling a batch of ${batch.calls.length} (delay ${delay}s)`,
        batchSigner,
        (o) =>
          timelock
            .connect(batchSigner)
            .scheduleBatch(
              batch.targets,
              batch.values,
              batch.payloads,
              batch.predecessor,
              batch.salt,
              delay,
              o
            )
      );
      await reportStatus(timelock, batch.id, minDelay);
      return;
    }

    const executeBatchData = encodeExecuteBatch(batch);
    console.log(`  executeBatch calldata:  ${executeBatchData}`);
    await reportStatus(timelock, batch.id, minDelay);
    const canExecuteBatch = await signerHoldsRole({
      timelock,
      timelockAddress,
      roleName: "EXECUTOR_ROLE",
      signer: batchSigner,
      fn: "executeBatch",
      data: executeBatchData,
    });
    if (!canExecuteBatch) return;
    pools.requireConfirmation(chainId, `execute batch ${batch.id}`);
    await pools.send(`Executing a batch of ${batch.calls.length}`, batchSigner, (o) =>
      timelock
        .connect(batchSigner)
        .executeBatch(batch.targets, batch.values, batch.payloads, batch.predecessor, batch.salt, o)
    );
    return;
  }

  // schedule / execute — same operands, same operation.
  const op = buildOperation({
    target: await resolveTarget(hre, pools, chainId),
    fn: requireFunction(),
    args: splitArgs(process.env.TIMELOCK_ARGS),
    tag: process.env.TIMELOCK_SALT_TAG || "",
  });

  printOperation(op);

  const signer = await pools.getSigner();
  const context = { pools, timelock, timelockAddress, chainId, minDelay, signer };

  if (action === "schedule") return scheduleOperation(context, op);

  await executeOperation(context, op);
}

/**
 * Prints the `schedule(...)` calldata, then schedules `op` when the signer holds PROPOSER_ROLE, or
 * prints the Safe transaction and stops when it does not. Shared by `schedule` and the canceller
 * self-call actions.
 */
async function scheduleOperation({ pools, timelock, timelockAddress, chainId, minDelay, signer }, op) {
  const delay = resolveDelay(minDelay);
  const scheduleData = encodeSchedule(op, delay);
  console.log(`  schedule calldata: ${scheduleData}`);
  const canSchedule = await signerHoldsRole({
    timelock,
    timelockAddress,
    roleName: "PROPOSER_ROLE",
    signer,
    fn: "schedule",
    data: scheduleData,
  });
  if (!canSchedule) return;
  pools.requireConfirmation(chainId, `schedule ${describeOperation(op)}`);
  await pools.send(`Scheduling ${op.fn} (delay ${delay}s)`, signer, (o) =>
    timelock.connect(signer).schedule(op.target, op.value, op.data, op.predecessor, op.salt, delay, o)
  );
  await reportStatus(timelock, op.id, minDelay);
}

/**
 * Prints the `execute(...)` calldata and the operation's state, then executes `op` when the
 * signer holds EXECUTOR_ROLE, or prints the Safe transaction and stops when it does not. Shared by
 * `execute` and the canceller self-call actions.
 */
async function executeOperation({ pools, timelock, timelockAddress, chainId, minDelay, signer }, op) {
  const executeData = encodeExecute(op);
  console.log(`  execute calldata:  ${executeData}`);
  await reportStatus(timelock, op.id, minDelay);
  const canExecute = await signerHoldsRole({
    timelock,
    timelockAddress,
    roleName: "EXECUTOR_ROLE",
    signer,
    fn: "execute",
    data: executeData,
  });
  if (!canExecute) return;
  pools.requireConfirmation(chainId, `execute ${describeOperation(op)}`);
  await pools.send(`Executing ${op.fn}`, signer, (o) =>
    timelock.connect(signer).execute(op.target, op.value, op.data, op.predecessor, op.salt, o)
  );
}

// ──────────────────────── the canceller actions ────────────────────────

/** The chain's latest block timestamp, the clock every term and offer is measured against. */
async function chainNow(timelock) {
  return BigInt((await timelock.runner.provider.getBlock("latest")).timestamp);
}

/** A timestamp as `<seconds> (<ISO time>)`. */
function when(seconds) {
  return `${seconds} (${new Date(Number(seconds) * 1000).toISOString()})`;
}

/** `CANCELLER_ADDRESS`, checksummed. Required unless `fallback` is given. */
function requireCancellerAddress(fallback) {
  const raw = process.env.CANCELLER_ADDRESS;
  if (!raw || raw.trim() === "") {
    if (fallback) return fallback;
    throw new Error("Set CANCELLER_ADDRESS to the address the canceller role is offered to");
  }
  try {
    return ethers.getAddress(raw.trim());
  } catch {
    throw new Error(`CANCELLER_ADDRESS is not a valid address: ${raw}`);
  }
}

/** `CANCELLER_TERM_DAYS`, a whole number of days in 1..`MAX_CANCELLER_TERM_DAYS`. */
function requireTermDays() {
  const raw = process.env.CANCELLER_TERM_DAYS;
  if (!raw || raw.trim() === "") {
    throw new Error(`Set CANCELLER_TERM_DAYS to the term in whole days, 1..${MAX_CANCELLER_TERM_DAYS}`);
  }
  if (!/^[0-9]+$/.test(raw.trim())) {
    throw new Error(`CANCELLER_TERM_DAYS must be a whole number of days — got ${raw}`);
  }
  const termDays = Number(raw.trim());
  if (termDays < 1 || termDays > MAX_CANCELLER_TERM_DAYS) {
    throw new Error(
      `CANCELLER_TERM_DAYS ${termDays} is outside 1..${MAX_CANCELLER_TERM_DAYS}: ` +
        `the offer would revert CancellerTermOutOfBounds at execute, after the whole delay`
    );
  }
  return termDays;
}

/**
 * The three canceller actions that are calls of the timelock on itself: `offer-canceller`,
 * `withdraw-offer` and `revoke-canceller`. Each builds one operation with target = the timelock
 * and runs it through the same schedule and execute flow as `schedule` and `execute`. Which step
 * runs is read from the operation's state on chain: unscheduled -> schedule, ready -> execute,
 * pending -> print the ready time, done -> say so.
 */
async function runCancellerSelfCall({ pools, timelock, timelockAddress, chainId, minDelay, action }) {
  const fn = CANCELLER_SELF_CALLS[action];
  const account = requireCancellerAddress();
  let args;
  if (fn === "offerCancellerRole") {
    const termDays = requireTermDays();
    await refuseInvalidOffer(timelock, timelockAddress, account);
    args = [account, String(termDays)];
  } else if (fn === "withdrawCancellerOffer") {
    args = [account];
  } else {
    args = [CANCELLER_ROLE, account];
  }

  const op = buildOperation({
    target: timelockAddress,
    fn,
    args,
    tag: process.env.TIMELOCK_SALT_TAG || "",
  });
  printOperation(op);

  const { state, readyAt } = await reportStatus(timelock, op.id, minDelay);
  if (state === "done") {
    console.log(
      "\nThis operation was already executed. To run the same call again, set TIMELOCK_SALT_TAG " +
        "to a value not used before for it."
    );
    return;
  }
  if (state === "pending") {
    console.log(`\nNot ready yet: run the same command again after ${when(readyAt)} to execute it.`);
    return;
  }

  const signer = await pools.getSigner();
  const context = { pools, timelock, timelockAddress, chainId, minDelay, signer };

  if (state === "unset") {
    if (fn === "revokeRole") {
      await refuseInvalidRevocation(timelock, timelockAddress, account);
      if (!(await timelock.hasRole(CANCELLER_ROLE, account))) {
        console.log(`\n${account} holds no canceller role: nothing to schedule.`);
        return;
      }
      await describeTermForRevocation(timelock, account);
    }
    if (
      fn === "withdrawCancellerOffer" &&
      !(await offerToWithdraw({ pools, chainId, timelock, timelockAddress, account, minDelay }))
    ) {
      return;
    }
    return scheduleOperation(context, op);
  }

  // Ready. Refuse an execute the contract would revert or that would change nothing, and say why.
  const now = await chainNow(timelock);
  if (fn === "revokeRole") {
    if (!(await timelock.hasRole(CANCELLER_ROLE, account))) {
      console.log(
        `\n${account} holds no canceller role: nothing to revoke. Nothing sent (the execute would ` +
          "change nothing and still cost a Safe execution)."
      );
      return;
    }
    const termEnd = await timelock.cancellerTermEnd(account);
    // The execute lands in a later block, at `now + 1` at the earliest.
    if (now + 1n < termEnd) {
      console.log(
        `\nThe term of ${account} is active until ${when(termEnd)}: the execute would revert ` +
          `CancellerTermActive. Nothing sent. Run the same command again after that time.`
      );
      return;
    }
  }
  if (fn === "withdrawCancellerOffer") {
    const offer = await timelock.cancellerOffer(account);
    if (offer.expiresAt === 0n) {
      console.log(`\n${account} has no offer: the execute would revert NoCancellerOffer. Nothing sent.`);
      return;
    }
    if (now >= offer.expiresAt) {
      console.log(`\nThe offer expired at ${when(offer.expiresAt)}: withdrawing it changes nothing. Nothing sent.`);
      return;
    }
  }
  await executeOperation(context, op);
}

/**
 * The checks `offerCancellerRole` makes at execution, made here before anything is scheduled, so
 * a wrong address is refused now rather than after the whole delay.
 */
async function refuseInvalidOffer(timelock, timelockAddress, account) {
  if (account === ethers.ZeroAddress) {
    throw new Error("CANCELLER_ADDRESS is the zero address: the offer would revert InvalidCancellerAccount");
  }
  if (account.toLowerCase() === timelockAddress.toLowerCase()) {
    throw new Error("CANCELLER_ADDRESS is the timelock itself: the offer would revert InvalidCancellerAccount");
  }
  if ((await timelock.hasRole(CANCELLER_ROLE, account)) && (await timelock.cancellerTermEnd(account)) === 0n) {
    throw new Error(
      `${account} is a permanent canceller (REAL's Safe, no term): the offer would revert InvalidCancellerAccount`
    );
  }
}

/**
 * The addresses `revoke-canceller` refuses before anything is scheduled: the zero address, the
 * timelock itself, and a PERMANENT canceller (the role with term end 0, that is REAL's own Safe).
 * Revoking REAL's permanent role would be irreversible: `grantRole(CANCELLER_ROLE, …)` reverts for
 * everyone, and an offer to REAL's Safe could only ever give it a term.
 */
async function refuseInvalidRevocation(timelock, timelockAddress, account) {
  if (account === ethers.ZeroAddress) {
    throw new Error("CANCELLER_ADDRESS is the zero address: there is no canceller to revoke");
  }
  if (account.toLowerCase() === timelockAddress.toLowerCase()) {
    throw new Error("CANCELLER_ADDRESS is the timelock itself: there is no canceller to revoke");
  }
  if ((await timelock.hasRole(CANCELLER_ROLE, account)) && (await timelock.cancellerTermEnd(account)) === 0n) {
    throw new Error(
      `${account} is a permanent canceller (REAL's Safe, no term): revoke-canceller refuses it, because ` +
        "the permanent role can never be granted again (grantRole(CANCELLER_ROLE, …) reverts for everyone)"
    );
  }
}

/**
 * Before a revocation is scheduled: the appointee's term, and what it means for this operation.
 * The contract lets a term canceller cancel an operation whose SCHEDULE time is before its term
 * end (`scheduledAt[id] < cancellerTermEnd`), so the schedule time decides the veto, not the
 * ready time. The schedule lands in a later block, at `now + 1` at the earliest.
 */
async function describeTermForRevocation(timelock, account) {
  const termEnd = await timelock.cancellerTermEnd(account);
  if (termEnd === 0n) {
    console.log(`\n${account} has no term end: the revocation can execute as soon as it is ready.`);
    return;
  }
  const scheduleAt = (await chainNow(timelock)) + 1n;
  console.log(`\nThe term of ${account} ends at ${when(termEnd)}.`);
  if (scheduleAt < termEnd) {
    console.log(
      "  This revocation is scheduled DURING the term, so the appointee can cancel it at any time " +
        "until it executes, also after its term end. An execute before the term end reverts " +
        "CancellerTermActive. To make the revocation impossible for the appointee to block, " +
        "schedule it after the term end."
    );
  } else {
    console.log(
      "  The term is over: this revocation is scheduled after the term end, so the appointee " +
        "cannot cancel it, and it executes once ready."
    );
  }
}

/**
 * Before a `withdrawCancellerOffer` is scheduled: there must be an EXECUTED offer that can still be
 * accepted. An expired offer can no longer be accepted, so withdrawing it changes nothing. When
 * there is no executed offer, the offer is often still a pending operation, and that is stopped at
 * once with `cancel` on its id instead of a 48 h withdrawal. Returns true when scheduling makes
 * sense.
 *
 * The hint comes from a FULL scan of `CallScheduled` from the timelock's deploy block, not a
 * bounded one: an OpenZeppelin operation never expires, so an offer operation scheduled long ago
 * and never executed or cancelled is still pending, and a scan bounded to `minDelay` plus the
 * offer window would miss exactly that one. The scan prints its progress per chunk, and the
 * pending checks run in parallel.
 */
async function offerToWithdraw({ pools, chainId, timelock, timelockAddress, account }) {
  const offer = await timelock.cancellerOffer(account);
  if (offer.expiresAt !== 0n) {
    const now = await chainNow(timelock);
    if (now >= offer.expiresAt) {
      console.log(
        `\nThe offer expired at ${when(offer.expiresAt)}: withdrawing it changes nothing. Nothing scheduled.`
      );
      return false;
    }
    return true;
  }

  const selector = TIMELOCK_INTERFACE.getFunction("offerCancellerRole").selector;
  const target = timelockAddress.toLowerCase();
  const fromBlock = await scanStartBlock(pools, chainId, timelock);
  const scheduled = TIMELOCK_INTERFACE.getEvent("CallScheduled").topicHash;
  console.log(`\nLooking for a pending offer operation for ${account} (CallScheduled since block ${fromBlock})`);
  const logs = await scanTimelockLogs(timelock, [scheduled], fromBlock, ({ end, toBlock, found }) =>
    console.log(`  scanned to block ${end} of ${toBlock} (${found} CallScheduled log(s))`)
  );

  // A batch emits one CallScheduled per call under ONE id: group by id, count the calls, and keep
  // the ids where some call is an offer to this account aimed at THIS timelock.
  const byId = new Map();
  for (const log of logs) {
    const entry = byId.get(log.args.id) || { calls: 0, offersAccount: false };
    entry.calls += 1;
    if (
      log.args.target.toLowerCase() === target &&
      log.args.data.startsWith(selector) &&
      TIMELOCK_INTERFACE.decodeFunctionData("offerCancellerRole", log.args.data)[0].toLowerCase() ===
        account.toLowerCase()
    ) {
      entry.offersAccount = true;
    }
    byId.set(log.args.id, entry);
  }
  const candidates = [...byId].filter(([, entry]) => entry.offersAccount);
  const pending = await Promise.all(candidates.map(([id]) => timelock.isOperationPending(id)));
  const pendingOffers = candidates.filter((_, index) => pending[index]);

  console.log(`\n${account} has no executed offer: withdrawCancellerOffer would revert NoCancellerOffer. Nothing scheduled.`);
  if (pendingOffers.length === 0) {
    console.log("  No offer operation for it is pending either: there is nothing to withdraw.");
    return false;
  }
  for (const [id, entry] of pendingOffers) {
    const batch =
      entry.calls > 1 ? ` It is a batch of ${entry.calls} calls: cancelling it drops all ${entry.calls}.` : "";
    console.log(
      `  Its offer operation ${id} is still pending.${batch} Stop it at once with:\n` +
        `    TIMELOCK_ACTION=cancel TIMELOCK_ID=${id}`
    );
  }
  return false;
}

/**
 * `acceptCancellerRole(CANCELLER_TERM_DAYS)` for the appointee (`CANCELLER_ADDRESS`, default the
 * signer). Checks the offer the way the contract does (it exists, it has not expired, the term
 * matches) and explains a failure instead of sending. Sends when the signer is the appointee, and
 * prints the transaction for the appointee's Safe otherwise.
 */
async function acceptCanceller({ pools, timelock, timelockAddress, chainId }) {
  const termDays = requireTermDays();
  const signer = await pools.getSigner();
  const appointee = requireCancellerAddress(signer.address);
  const offer = await timelock.cancellerOffer(appointee);
  const now = await chainNow(timelock);

  console.log(`\nAppointee: ${appointee}`);
  if (offer.expiresAt === 0n) {
    console.log(`  ${appointee} has no offer: acceptCancellerRole would revert NoCancellerOffer. Nothing sent.`);
    return;
  }
  console.log(`  offer: ${offer.termDays} days, expiresAt ${when(offer.expiresAt)}`);
  // The acceptance lands in a later block, at `now + 1` at the earliest.
  if (now + 1n >= offer.expiresAt) {
    console.log(
      "  the offer expired: acceptCancellerRole would revert CancellerOfferExpired. Nothing sent. " +
        "REAL's Safe has to make a new offer."
    );
    return;
  }
  if (offer.termDays !== BigInt(termDays)) {
    console.log(
      `  the offer is for ${offer.termDays} days, not ${termDays}: acceptCancellerRole would revert ` +
        "CancellerTermMismatch. Nothing sent."
    );
    return;
  }

  const data = TIMELOCK_INTERFACE.encodeFunctionData("acceptCancellerRole", [termDays]);
  console.log(`  acceptCancellerRole calldata: ${data}`);
  if (signer.address.toLowerCase() !== appointee.toLowerCase()) {
    console.log(
      `\nThe signer ${signer.address} is not the appointee: nothing sent.\n` +
        `Safe transaction for the appointee ${appointee} (LPTimelock.acceptCancellerRole), ` +
        `to be sent before ${when(offer.expiresAt)}:\n` +
        `    to:    ${timelockAddress}\n    value: 0\n    data:  ${data}`
    );
    return;
  }
  pools.requireConfirmation(chainId, `accept the canceller role for ${termDays} days`);
  await pools.send(`Accepting the canceller role for ${termDays} days`, signer, (o) =>
    timelock.connect(signer).acceptCancellerRole(termDays, o)
  );
  await reportCanceller(timelock, appointee, await chainNow(timelock));
}

/** Prints one address's canceller state: the role, the term end, the activity, the offer. */
async function reportCanceller(timelock, account, now) {
  const [holds, termEnd, active, offer] = await Promise.all([
    timelock.hasRole(CANCELLER_ROLE, account),
    timelock.cancellerTermEnd(account),
    timelock.isCancellerActive(account),
    timelock.cancellerOffer(account),
  ]);
  const termLine =
    termEnd === 0n
      ? holds
        ? "0 (permanent, no term)"
        : "0 (no term)"
      : `${when(termEnd)}${now >= termEnd ? " [ended]" : ""}`;
  const offerLine =
    offer.expiresAt === 0n
      ? "none"
      : `${offer.termDays} days, expiresAt ${when(offer.expiresAt)}${now >= offer.expiresAt ? " [expired]" : " [open]"}`;
  console.log(
    `\nCanceller ${account}\n` +
      `  holds CANCELLER_ROLE: ${holds ? "yes" : "no"}\n` +
      `  term end:             ${termLine}\n` +
      `  isCancellerActive:    ${active ? "yes" : "no"}\n` +
      `  pending offer:        ${offerLine}`
  );
}

/**
 * The first block of a log scan on this timelock: the `block` of the registry entry whose address
 * IS this timelock (so `TIMELOCK_ADDRESS` pointing at, say, `TimelockControllerNext` scans from
 * that contract's own deploy block). When no entry records it, the scan starts at block 0 and a
 * warning says so: correct, only slower.
 */
async function scanStartBlock(pools, chainId, timelock) {
  const address = (await timelock.getAddress()).toLowerCase();
  const entries = Object.values(pools.readRegistry()[String(chainId)] || {});
  const entry = entries.find((e) => e && typeof e.address === "string" && e.address.toLowerCase() === address);
  const fromBlock = entry ? entry.block || 0 : 0;
  if (!entry || !entry.block) {
    console.log(
      `\nWARNING: no deploy block recorded for ${address} in the registry: the log scan starts at ` +
        "block 0 (correct, only slower)."
    );
  }
  return fromBlock;
}

/**
 * Every log of the timelock whose topics match `topics`, from `fromBlock` to the latest block,
 * through the shared chunked scanner (`scripts/lib/logs.js`, at most 10,000 blocks per call).
 * Each log is returned with its parsed `args` next to the raw fields. `onChunk` reports progress.
 */
async function scanTimelockLogs(timelock, topics, fromBlock = 0, onChunk) {
  const provider = timelock.runner.provider;
  const logs = await scanLogs(provider, {
    address: await timelock.getAddress(),
    topics,
    fromBlock,
    toBlock: await provider.getBlockNumber(),
    onChunk,
  });
  return logs.map((log) => ({ ...log, args: TIMELOCK_INTERFACE.parseLog(log).args }));
}

/**
 * Every address that ever received the canceller role or an offer, from the `RoleGranted` and
 * `CancellerOffered` logs, plus every address in `CANCELLER_ADDRESS`, with its current state.
 * The scan starts at the timelock's recorded deploy block and moves in chunks of at most 10,000
 * blocks, the `eth_getLogs` range the Infura plan accepts.
 */
async function listCancellers({ pools, timelock, chainId }) {
  const fromBlock = await scanStartBlock(pools, chainId, timelock);
  const accounts = new Map();
  const add = (address) => accounts.set(ethers.getAddress(address).toLowerCase(), ethers.getAddress(address));

  // One topic0 list, so each chunk is ONE eth_getLogs call for both events.
  const roleGranted = TIMELOCK_INTERFACE.getEvent("RoleGranted").topicHash;
  const offered = TIMELOCK_INTERFACE.getEvent("CancellerOffered").topicHash;
  for (const log of await scanTimelockLogs(timelock, [[roleGranted, offered]], fromBlock)) {
    if (log.topics[0] === roleGranted && log.args.role !== CANCELLER_ROLE) continue;
    add(log.args.account);
  }
  for (const raw of splitArgs(process.env.CANCELLER_ADDRESS)) add(raw);

  console.log(`\n${accounts.size} canceller address(es) since block ${fromBlock}:`);
  const now = await chainNow(timelock);
  for (const account of accounts.values()) await reportCanceller(timelock, account, now);
}

/**
 * Why a canceller cannot cancel the pending operation `id`: it was scheduled at or after the
 * canceller's term end. (The not-pending case is answered for every signer before this runs.)
 */
async function explainCancelRefusal(timelock, account, id) {
  const termEnd = await timelock.cancellerTermEnd(account);
  const scheduled = await timelock.scheduledAt(id);
  console.log(
    `\nOperation ${id} was scheduled at ${when(scheduled)}, at or after the signer's term end ` +
      `${termEnd}: cancel would revert CancellerTermEnded. Nothing sent. REAL's Safe can still cancel it.`
  );
}

function requireId() {
  const id = process.env.TIMELOCK_ID;
  if (!id || !/^0x[0-9a-fA-F]{64}$/.test(id)) {
    throw new Error("Set TIMELOCK_ID to the 32-byte operation id");
  }
  return id.toLowerCase();
}

function requireFunction() {
  const fn = process.env.TIMELOCK_FN;
  if (!fn) throw new Error(`Set TIMELOCK_FN to one of ${Object.keys(OWNER_TIER).join(", ")}`);
  if (!OWNER_TIER[fn]) {
    throw new Error(`TIMELOCK_FN ${fn} is not owner-tier — one of ${Object.keys(OWNER_TIER).join(", ")}`);
  }
  return fn;
}

/** The name the Safe printout gives the holder of each timelock role. */
const ROLE_HOLDER_NAMES = {
  PROPOSER_ROLE: "proposer",
  EXECUTOR_ROLE: "executor",
  CANCELLER_ROLE: "canceller",
};

/**
 * The role check in front of every schedule, execute and cancel this script sends. The timelock
 * takes a schedule only from a PROPOSER_ROLE holder, an execute only from an EXECUTOR_ROLE holder
 * and a cancel only from a CANCELLER_ROLE holder, and on mainnet these roles belong to Safes
 * (REAL's Safe, and ApeBonds' Safe as a term canceller), never to the key this script runs with. A
 * send from that key would revert on chain. So when the signer lacks the role, the transaction is
 * printed for the Safe and nothing is sent, the same way `lp-fund-rewards.js` and `lp-epoch.js`
 * treat a signer that is not the operator. Returns true when the signer holds the role.
 */
async function signerHoldsRole({ timelock, timelockAddress, roleName, signer, fn, data }) {
  const role = await timelock[roleName]();
  if (await timelock.hasRole(role, signer.address)) return true;
  const holder = ROLE_HOLDER_NAMES[roleName];
  console.log(
    `\nThe signer ${signer.address} does not hold ${roleName} on the timelock: nothing sent.\n` +
      `Safe transaction for the ${holder} (LPTimelock.${fn}):\n` +
      `    to:    ${timelockAddress}\n    value: 0\n    data:  ${data}`
  );
  return false;
}

/** The delay a schedule asks for: the timelock's own minimum unless told otherwise, never less. */
function resolveDelay(minDelay) {
  const delay = process.env.TIMELOCK_DELAY ? BigInt(process.env.TIMELOCK_DELAY) : minDelay;
  if (delay < minDelay) {
    throw new Error(`TIMELOCK_DELAY ${delay} is below the timelock's minDelay ${minDelay}`);
  }
  return delay;
}

/** The `TIMELOCK_BATCH` file, parsed and checked to be the array of call objects it must be. */
function readBatchFile() {
  const filePath = process.env.TIMELOCK_BATCH;
  if (!filePath) {
    throw new Error(
      'Set TIMELOCK_BATCH to a JSON file holding [{"target": …, "fn": …, "args": [ … ]}, …]'
    );
  }
  if (!fs.existsSync(filePath)) throw new Error(`No batch file at ${filePath}`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${filePath} is not valid JSON — ${error.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${filePath} must hold a JSON ARRAY of {target, fn, args} objects`);
  }
  if (parsed.length === 0) throw new Error(`${filePath} holds no calls — a batch needs at least one`);
  return parsed;
}

/**
 * One entry of the batch file, turned into the `{target, fn, args, kind}` shape {@link
 * buildBatch} takes. `target` is a registry kind or a raw address, the same choice
 * `TIMELOCK_TARGET` / `TIMELOCK_TARGET_ADDRESS` offer a single operation — a value that looks
 * like a 20-byte address is used as one, anything else is looked up in the registry and is
 * checked against the function's own `kinds` list first.
 */
function resolveBatchEntry(pools, chainId, entry, index) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`Batch call ${index} must be an object {target, fn, args}`);
  }
  const fn = entry.fn;
  if (!fn || !OWNER_TIER[fn]) {
    throw new Error(
      `Batch call ${index}: ${fn || "(no fn)"} is not an owner-tier function — ` +
        `one of ${Object.keys(OWNER_TIER).join(", ")}`
    );
  }
  const target = entry.target;
  if (typeof target !== "string" || target.length === 0) {
    throw new Error(
      `Batch call ${index}: set "target" to one of ${OWNER_TIER[fn].kinds.join(", ")} ` +
        `or to a raw address`
    );
  }
  if (/^0x[0-9a-fA-F]{40}$/.test(target)) {
    return { target: ethers.getAddress(target), fn, args: entry.args };
  }
  if (!OWNER_TIER[fn].kinds.includes(target)) {
    throw new Error(
      `Batch call ${index}: ${fn} is not a function of ${target} — ` +
        `it is legal on ${OWNER_TIER[fn].kinds.join(", ")}`
    );
  }
  const address = pools.registryAddress(chainId, target);
  if (!address) {
    throw new Error(
      `Batch call ${index}: no ${target} recorded for chain ${chainId} in deployments.json — ` +
        `put a raw address in "target" instead`
    );
  }
  return { target: ethers.getAddress(address), fn, args: entry.args, kind: target };
}

/**
 * The target, by registry kind or by address. The kind is checked against the function's own
 * `kinds` list, so `setClaimsEnabled` aimed at the vault fails here rather than after the
 * delay.
 */
async function resolveTarget(hre, pools, chainId) {
  const fn = requireFunction();
  const explicit = process.env.TIMELOCK_TARGET_ADDRESS;
  if (explicit) return hre.ethers.getAddress(explicit);

  const kind = process.env.TIMELOCK_TARGET;
  if (!kind) {
    throw new Error(
      `Set TIMELOCK_TARGET to one of ${OWNER_TIER[fn].kinds.join(", ")}, ` +
        `or TIMELOCK_TARGET_ADDRESS to a raw address`
    );
  }
  if (!OWNER_TIER[fn].kinds.includes(kind)) {
    throw new Error(`${fn} is not a function of ${kind} — it is legal on ${OWNER_TIER[fn].kinds.join(", ")}`);
  }
  const address = kind === TIMELOCK_KIND
    ? pools.registryAddress(chainId, TIMELOCK_KIND)
    : pools.registryAddress(chainId, kind);
  if (!address) {
    throw new Error(
      `No ${kind} recorded for chain ${chainId} in deployments.json — ` +
        `set TIMELOCK_TARGET_ADDRESS=<address> instead`
    );
  }
  return hre.ethers.getAddress(address);
}

/**
 * `getTimestamp` tells the whole story: 0 unset, 1 done, anything else is the ready-at.
 *
 * The countdown is measured against the CHAIN's latest block timestamp, not the local clock:
 * that is the value `execute` compares against, and on a fork the two can be days apart.
 */
async function reportStatus(timelock, id, minDelay) {
  const timestamp = await timelock.getTimestamp(id);
  console.log(`\nOperation ${id}`);
  if (timestamp === 0n) {
    console.log("  state:   UNSET — never scheduled, or cancelled");
    return { state: "unset", readyAt: null };
  }
  if (timestamp === 1n) {
    console.log("  state:   DONE — already executed");
    return { state: "done", readyAt: null };
  }
  const ready = await timelock.isOperationReady(id);
  const readyAt = new Date(Number(timestamp) * 1000).toISOString();
  console.log(`  state:   ${ready ? "READY" : "PENDING"}`);
  console.log(`  readyAt: ${timestamp} (${readyAt})`);
  if (!ready) {
    const now = (await timelock.runner.provider.getBlock("latest")).timestamp;
    console.log(
      `  waits:   ${Number(timestamp) - now}s more (chain time ${now}, minDelay ${minDelay}s)`
    );
  }
  return { state: ready ? "ready" : "pending", readyAt: timestamp };
}

/**
 * Every operation the timelock has ever been told about, with its current state.
 *
 * OZ stores one timestamp per id and enumerates nothing, so the list has to come from the
 * logs: `CallScheduled` from the timelock's own deploy block forward (see {@link scanStartBlock}),
 * in chunks of at most 10,000 blocks, then one `getTimestamp` per id.
 */
async function listPending(hre, pools, timelock, chainId) {
  const fromBlock = await scanStartBlock(pools, chainId, timelock);
  const logs = await scanTimelockLogs(
    timelock,
    [TIMELOCK_INTERFACE.getEvent("CallScheduled").topicHash],
    fromBlock
  );

  if (logs.length === 0) {
    console.log(`\nNo CallScheduled logs since block ${fromBlock}.`);
    return;
  }

  // A batch emits one `CallScheduled` per call, all carrying the SAME id and an `index` that
  // counts them, so the logs are grouped by id first: one row per operation, every call of it
  // listed underneath in the order the timelock will run them.
  const byId = new Map();
  for (const log of logs) {
    if (!byId.has(log.args.id)) byId.set(log.args.id, []);
    byId.get(log.args.id).push(log);
  }

  console.log(`\n${byId.size} scheduled operation(s) since block ${fromBlock}:`);
  for (const [id, calls] of byId) {
    const timestamp = await timelock.getTimestamp(id);
    const state =
      timestamp === 0n ? "CANCELLED" : timestamp === 1n ? "DONE" : (await timelock.isOperationReady(id)) ? "READY" : "PENDING";
    const first = calls[0];
    console.log(
      `  ${state.padEnd(9)} ${id}` +
        (calls.length > 1 ? `  (batch of ${calls.length})` : "") +
        `\n    scheduled in block ${first.blockNumber}` +
        (timestamp > 1n ? `  readyAt ${timestamp} (${new Date(Number(timestamp) * 1000).toISOString()})` : "")
    );
    for (const log of calls) {
      let label = "unknown call";
      try {
        const parsed = OWNER_TIER_INTERFACE.parseTransaction({ data: log.args.data });
        if (parsed) label = `${parsed.name}(${parsed.args.map(String).join(", ")})`;
      } catch {
        label = `raw ${log.args.data.slice(0, 10)}`;
      }
      console.log(`    ${log.args.index}. ${label}\n       target ${log.args.target}`);
    }
  }
}

/**
 * The canceller shape every new `LPTimelock` must have, as `[label, actual, expected]` rows for a
 * script's own check printer (`deploy-lp-staking.js`, `lp-switch-timelock.js`). The timelock is
 * the only DEFAULT_ADMIN_ROLE holder and the admin of CANCELLER_ROLE, so every canceller change is
 * a scheduled operation. The multisig is a permanent canceller (term end 0). The term cap and the
 * offer window are the decided ones.
 */
async function cancellerShapeChecks(timelock, { timelockAddress, multisig, deployer }) {
  return [
    ["LPTimelock.getRoleAdmin(CANCELLER_ROLE)", await timelock.getRoleAdmin(CANCELLER_ROLE), DEFAULT_ADMIN_ROLE],
    ["LPTimelock.DEFAULT_ADMIN_ROLE[timelock]", await timelock.hasRole(DEFAULT_ADMIN_ROLE, timelockAddress), true],
    ["LPTimelock.DEFAULT_ADMIN_ROLE[multisig]", await timelock.hasRole(DEFAULT_ADMIN_ROLE, multisig), false],
    ["LPTimelock.DEFAULT_ADMIN_ROLE[deployer]", await timelock.hasRole(DEFAULT_ADMIN_ROLE, deployer), false],
    ["LPTimelock.MAX_CANCELLER_TERM_DAYS", await timelock.MAX_CANCELLER_TERM_DAYS(), MAX_CANCELLER_TERM_DAYS],
    ["LPTimelock.CANCELLER_OFFER_WINDOW", await timelock.CANCELLER_OFFER_WINDOW(), CANCELLER_OFFER_WINDOW],
    ["LPTimelock.CANCELLER_ROLE[multisig]", await timelock.hasRole(CANCELLER_ROLE, multisig), true],
    ["LPTimelock.cancellerTermEnd[multisig]", await timelock.cancellerTermEnd(multisig), 0n],
  ];
}

module.exports = {
  main,
  CANCELLER_ROLE,
  DEFAULT_ADMIN_ROLE,
  MAX_CANCELLER_TERM_DAYS,
  CANCELLER_OFFER_WINDOW,
  cancellerShapeChecks,
  PROXY_KINDS,
  ESCROW_KIND,
  ADAPTER_KIND,
  OWNER_TIER,
  OWNER_TIER_INTERFACE,
  TIMELOCK_INTERFACE,
  TIMELOCK_KIND,
  PREDECESSOR,
  SALT_NAMESPACE,
  BATCH_SALT_NAMESPACE,
  encodeOwnerCall,
  deriveSalt,
  operationId,
  buildOperation,
  encodeSchedule,
  encodeExecute,
  encodeCancel,
  describeOperation,
  deriveBatchSalt,
  batchOperationId,
  buildBatch,
  encodeScheduleBatch,
  encodeExecuteBatch,
  describeCall,
  resolveBatchEntry,
};

// `hardhat run` executes this file as the entry point; a `require` from the fork suites must
// only pick up the builders above.
if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
