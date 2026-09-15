const fs = require("fs");
const os = require("os");
const path = require("path");

const { expect } = require("chai");
const ethers = require("ethers");
const hre = require("hardhat");

const forkNode = require("./helpers/fork-node");
const chain = require("./helpers/chain");
const runner = require("./helpers/scripts");
const C = require("./helpers/constants");

/**
 * The three operator scripts that follow the ApeBond activation, run as CHILD PROCESSES against a
 * stack this suite deploys with the repo's own scripts:
 *
 *   scripts/set-purchase-signer.js  the guardian's one undelayed transaction, which OPENS the
 *                                   deposit path the activation deliberately left closed
 *   scripts/fund-escrow.js          bonus tokens into the BonusEscrow proxy, by fixed amount or
 *                                   up to a FREE-balance target
 *   scripts/apebond-rehearsal.js    one whole purchase — mint, authorize, depositFor — and, after
 *                                   the cliff, the claim
 *
 * ── Why a spawned node and not the in-process Hardhat network ─────────────────────────────
 *
 * The same reason `DeployApeBond.test.js` gives: these are `hardhat run` scripts. They read their
 * inputs from the environment, resolve addresses out of `deployments.json`, sign with keys handed
 * to them as private keys, and exit with a status code that is itself part of the contract — the
 * claim phase is REQUIRED to exit non-zero when the cliff has not passed. A child process needs a
 * JSON-RPC endpoint, so this suite starts a plain `hardhat node` (no fork, no archive endpoint, so
 * it can never skip) and points every child at it with `LOCALHOST_RPC_URL`.
 *
 * ── The world ─────────────────────────────────────────────────────────────────────────────
 *
 * Mocks, not real Uniswap, exactly as `DeployApeBond.test.js` builds them: `MockERC20Decimals`
 * (18 and 6 decimals), `MockUniswapV3Pool`, `MockPositionManager`, `MockSwapRouter` and
 * `MockUniswapV3Factory`. The stack is deployed by `deploy-lp-staking.js` and the route is then
 * activated by `deploy-apebond.js`, both as children, both unmodified. The timelock's `minDelay`
 * is 0 on this throwaway chain, which is legal and is what the local-fork scenario uses too, so
 * the activation needs no wait.
 *
 * Two roles are deliberately placed:
 *   - the adapter's GUARDIAN is the deployer, because `hardhat run --network localhost` signs as
 *     account 0 and `setPurchaseSigner` is guardian tier. That is the documented test-stack
 *     arrangement (`deploy-apebond.js` defaults `LP_APEBOND_GUARDIAN` to the deploying key).
 *     A SECOND, standalone adapter whose guardian is somebody else is deployed here so the
 *     wrong-tier refusal can be exercised through `LP_APEBOND_ADAPTER`.
 *   - the SoulZap seat is an EOA — `w.soulZapCaller` — allowlisted at activation through
 *     `LP_APEBOND_SOULZAP_CALLERS`. SoulZap is not deployed on a test stack, and the adapter's
 *     allowlist is an address mapping that does not care whether the entry has code.
 *
 * The tracked `deployments.json` is never written: every child gets `DEPLOYMENTS_FILE` pointing at
 * a scratch file, and the tracked registry's sha256 is captured at load and asserted at the end.
 */

/** Captured before a single test runs; asserted again at the very end. */
const TRACKED_REGISTRY_SHA256 = runner.sha256File(runner.TRACKED_REGISTRY);

const FEE = 3000;
const TWAP_WINDOW = 300;
/** Zero is legal and right on a throwaway chain: the activation batch needs no wait. */
const MIN_DELAY = 0;
/** Chain 31337 — what `hardhat node` reports for itself. */
const CHAIN_ID = 31337;

/** The rehearsal's cliff in this suite. Short, because chain time is pushed past it by hand. */
const CLIFF_SECONDS = 600;

/** What the caller wallet is funded with, in whole tokens of each side of the pair. */
const CALLER_FUNDING_WHOLE = 10_000n;

describe("the ApeBond operator scripts — signer, funding and the live rehearsal", function () {
  // Several child processes per describe, plus a node. Slow, but every second of it is the real
  // scripts against a real endpoint.
  this.timeout(15 * 60 * 1000);

  let scratchDir, registryFile, logFile, recordFile;
  let node = null;
  let provider, fees, w;

  let assetAddr, usdcAddr, token0Addr, token1Addr;
  let poolAddr, nfpmAddr, routerAddr, factoryAddr;
  let nfpm;

  let vaultAddr, timelockAddr, escrowAddr, adapterAddr;
  /** A second adapter whose guardian is NOT the deployer, for the wrong-tier refusal. */
  let foreignAdapterAddr;

  let bonusTokenAddr, bonusDecimals, bonusToken;
  let token0, token1, decimals0, decimals1;

  const vaultIface = new ethers.Interface([
    "function stakerOf(uint256 tokenId) view returns (address)",
    "function isStakeOperator(address account) view returns (bool)",
    "function pool() view returns (address)",
    "function owner() view returns (address)",
  ]);
  const escrowIface = new ethers.Interface([
    "function adapter() view returns (address)",
    "function bonusToken() view returns (address)",
    "function totalReserved() view returns (uint256)",
    "function reservationOf(bytes32 purchaseId) view returns (address beneficiary,uint256 amount,uint64 unlockAt,bool claimed)",
    "function claimable(bytes32 purchaseId) view returns (uint256)",
  ]);
  const adapterIface = new ethers.Interface([
    "function owner() view returns (address)",
    "function vault() view returns (address)",
    "function escrow() view returns (address)",
    "function guardian() view returns (address)",
    "function purchaseSigner() view returns (address)",
    "function depositsPaused() view returns (bool)",
    "function soulZapCallers(address caller) view returns (bool)",
    "function consumedPurchaseIds(bytes32 purchaseId) view returns (bool)",
  ]);
  const erc20Iface = new ethers.Interface([
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address to,uint256 value) returns (bool)",
  ]);

  const at = (address, iface) => new ethers.Contract(address, iface, provider);
  const entry = (kind) => runner.registryEntry(registryFile, CHAIN_ID, kind);

  /** Deploys one compiled artifact from the deployer account. */
  async function deployArtifact(name, args = []) {
    const artifact = await hre.artifacts.readArtifact(name);
    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, w.deployer);
    return (await factory.deploy(...args)).waitForDeployment();
  }

  /** The environment every child gets: the node, the scratch registry, and nothing else. */
  function baseEnv(extra = {}) {
    return { LOCALHOST_RPC_URL: node.rpcUrl, DEPLOYMENTS_FILE: registryFile, ...extra };
  }

  /** Runs one of the scripts under test. Never throws on a non-zero exit — the tests assert it. */
  function run(script, extra) {
    return runner.runHardhatScript(`scripts/${script}`, baseEnv(extra), { logFile });
  }

  /** Runs a script that is expected to succeed, and says why it did not when it fails. */
  async function runOk(script, extra) {
    const result = await run(script, extra);
    if (result.code !== 0) {
      throw new Error(
        `${script} exited ${result.code}\n--- stdout ---\n${result.stdout}\n` +
          `--- stderr ---\n${result.stderr}`
      );
    }
    return result;
  }

  const purchaseSignerOf = (address) => at(address, adapterIface).purchaseSigner();
  const bonusBalance = (address) => bonusToken.balanceOf(address);

  /** `balance - totalReserved`: what the escrow can still back with new reservations. */
  async function freeBalance() {
    const escrow = at(escrowAddr, escrowIface);
    const balance = await bonusBalance(escrowAddr);
    const reserved = await escrow.totalReserved();
    return balance > reserved ? balance - reserved : 0n;
  }

  function readRecord() {
    return JSON.parse(fs.readFileSync(recordFile, "utf8"));
  }

  // ─────────────────────────────────────────────────────────────
  before(async function () {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-apebond-ops-"));
    registryFile = path.join(scratchDir, "deployments.json");
    logFile = path.join(scratchDir, "scripts.log");
    recordFile = path.join(scratchDir, `apebond-rehearsal-${CHAIN_ID}.json`);

    const port = await forkNode.getFreePort();
    node = await forkNode.spawnLocalNode({
      port,
      logFile: path.join(scratchDir, `hardhat-node-${port}.log`),
    });

    provider = new ethers.JsonRpcProvider(node.rpcUrl, undefined, forkNode.PROVIDER_OPTIONS);
    provider.pollingInterval = 50;
    fees = await chain.derivePinnedFees(provider);
    w = chain.makeWallets(provider, fees);

    // ── the world the deploy script validates against ───────────────────────────────────
    const asset = await deployArtifact("MockERC20Decimals", ["Asset", "ASSET", 10n ** 24n, 18]);
    const usdc = await deployArtifact("MockERC20Decimals", ["USD Coin", "USDC", 10n ** 13n, 6]);
    assetAddr = await asset.getAddress();
    usdcAddr = await usdc.getAddress();

    [token0Addr, token1Addr] =
      assetAddr.toLowerCase() < usdcAddr.toLowerCase() ? [assetAddr, usdcAddr] : [usdcAddr, assetAddr];

    const pool = await deployArtifact("MockUniswapV3Pool", [token0Addr, token1Addr, FEE]);
    poolAddr = await pool.getAddress();

    nfpm = await deployArtifact("MockPositionManager");
    nfpmAddr = await nfpm.getAddress();
    routerAddr = await (await deployArtifact("MockSwapRouter")).getAddress();

    const factory = await deployArtifact("MockUniswapV3Factory");
    factoryAddr = await factory.getAddress();
    await chain.send(factory.connect(w.deployer).setPool(token0Addr, token1Addr, FEE, poolAddr));

    // ── the stack, deployed by the repo's own script, WITHOUT the ApeBond route ──────────
    const deployed = await runner.runHardhatScript(
      "scripts/deploy-lp-staking.js",
      baseEnv({
        LP_ASSET: assetAddr,
        LP_USDC: usdcAddr,
        LP_POOL: poolAddr,
        LP_NPM: nfpmAddr,
        LP_ROUTER: routerAddr,
        LP_FACTORY: factoryAddr,
        LP_FEE: String(FEE),
        LP_SIGNER: w.backOffice.address,
        LP_MULTISIG: w.deployer.address,
        LP_GUARDIAN: w.guardian.address,
        LP_OPERATOR: w.operator.address,
        LP_TOKENX_NAME: "Token X",
        LP_TOKENX_SYMBOL: "TKX",
        LP_TIMELOCK_MIN_DELAY: String(MIN_DELAY),
        LP_TWAP_WINDOW: String(TWAP_WINDOW),
      }),
      { logFile }
    );
    if (deployed.code !== 0) {
      throw new Error(
        `deploy-lp-staking.js exited ${deployed.code}\n--- stdout ---\n${deployed.stdout}\n` +
          `--- stderr ---\n${deployed.stderr}`
      );
    }
    vaultAddr = entry("LPStakingVault").address;
    timelockAddr = entry("TimelockController").address;

    // ── the route, activated CLOSED, with the deployer as its guardian ───────────────────
    //
    // LP_APEBOND_PURCHASE_SIGNER is deliberately unset, which is what leaves the deposit path
    // shut and gives set-purchase-signer.js something to do. LP_APEBOND_GUARDIAN is unset too,
    // so it defaults to the deploying key — the one `hardhat run` signs as.
    const activated = await runner.runHardhatScript(
      "scripts/deploy-apebond.js",
      baseEnv({
        LP_APEBOND_SOULZAP_CALLERS: w.soulZapCaller.address,
        LP_APEBOND_ASSERT_POSITIONS: "",
        LP_APEBOND_WAIT_POLL_MS: "200",
      }),
      { logFile }
    );
    if (activated.code !== 0) {
      throw new Error(
        `deploy-apebond.js exited ${activated.code}\n--- stdout ---\n${activated.stdout}\n` +
          `--- stderr ---\n${activated.stderr}`
      );
    }
    escrowAddr = entry("BonusEscrow").address;
    adapterAddr = entry("ApeBondPositionAdapter").address;

    bonusTokenAddr = await at(escrowAddr, escrowIface).bonusToken();
    bonusToken = at(bonusTokenAddr, erc20Iface);
    bonusDecimals = Number(await bonusToken.decimals());

    token0 = at(token0Addr, erc20Iface);
    token1 = at(token1Addr, erc20Iface);
    decimals0 = Number(await token0.decimals());
    decimals1 = Number(await token1.decimals());

    // ── a SECOND adapter, guarded by somebody else, for the wrong-tier refusal ───────────
    foreignAdapterAddr = await (
      await deployArtifact("ApeBondPositionAdapter", [
        nfpmAddr,
        vaultAddr,
        escrowAddr,
        token0Addr,
        token1Addr,
        FEE,
        w.deployer.address,
        w.guardian.address,
        ethers.ZeroAddress,
      ])
    ).getAddress();

    // ── the SoulZap seat gets both pool tokens, so it can mint ──────────────────────────
    await chain.send(
      token0.connect(w.deployer).transfer(w.soulZapCaller.address, CALLER_FUNDING_WHOLE * 10n ** BigInt(decimals0))
    );
    await chain.send(
      token1.connect(w.deployer).transfer(w.soulZapCaller.address, CALLER_FUNDING_WHOLE * 10n ** BigInt(decimals1))
    );
  });

  after(async function () {
    if (node) await node.stop();
  });

  // ─────────────────────────────────────────────────────────────
  describe("the activated route this suite starts from", function () {
    it("activated the route with the deposit path CLOSED", async function () {
      const adapter = at(adapterAddr, adapterIface);
      expect(await adapter.purchaseSigner()).to.equal(ethers.ZeroAddress);
      expect(await adapter.depositsPaused()).to.equal(false);
      expect(await adapter.owner()).to.equal(timelockAddr);
      expect(await at(vaultAddr, vaultIface).isStakeOperator(adapterAddr)).to.equal(true);
      expect(await at(escrowAddr, escrowIface).adapter()).to.equal(adapterAddr);
      expect(await at(escrowAddr, escrowIface).totalReserved()).to.equal(0n);
    });

    it("put the guardian tier on the deploying key and allowlisted the SoulZap seat", async function () {
      const adapter = at(adapterAddr, adapterIface);
      expect(await adapter.guardian()).to.equal(w.deployer.address);
      expect(await adapter.soulZapCallers(w.soulZapCaller.address)).to.equal(true);
      // The second adapter is the same code with a different guardian, and nothing else.
      expect(await at(foreignAdapterAddr, adapterIface).guardian()).to.equal(w.guardian.address);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("set-purchase-signer.js", function () {
    it("refuses a run that names neither an address nor a key", async function () {
      const result = await run("set-purchase-signer.js", {});
      expect(result.code).to.equal(1);
      expect(result.stderr).to.contain("LP_APEBOND_PURCHASE_SIGNER");
      expect(await purchaseSignerOf(adapterAddr)).to.equal(ethers.ZeroAddress);
    });

    it("refuses a sender that does not hold the GUARDIAN tier, and names the tier", async function () {
      const result = await run("set-purchase-signer.js", {
        LP_APEBOND_ADAPTER: foreignAdapterAddr,
        LP_APEBOND_PURCHASE_SIGNER: w.apeBondSigner.address,
      });
      expect(result.code).to.equal(1);
      expect(result.stderr).to.contain("GUARDIAN tier");
      expect(result.stderr).to.contain(w.guardian.address);
      // Not one transaction was sent: the second adapter's signer is still zero.
      expect(await purchaseSignerOf(foreignAdapterAddr)).to.equal(ethers.ZeroAddress);
    });

    it("refuses a contract in the signer seat — ECDSA.recover only ever returns an EOA", async function () {
      const result = await run("set-purchase-signer.js", {
        LP_APEBOND_PURCHASE_SIGNER: escrowAddr,
      });
      expect(result.code).to.equal(1);
      expect(result.stderr).to.contain("is a contract");
      expect(await purchaseSignerOf(adapterAddr)).to.equal(ethers.ZeroAddress);
    });

    it("refuses address(0) without LP_APEBOND_ALLOW_CLOSE=1, even when it is already zero", async function () {
      // The signer IS zero here, so "nothing to do" would be a truthful answer — and a dangerous
      // one. A variable that resolved to the zero address by accident must not exit 0 on a run
      // that meant to open the route, so the zero guard sits ahead of the idempotency shortcut.
      expect(await purchaseSignerOf(adapterAddr)).to.equal(ethers.ZeroAddress);
      const result = await run("set-purchase-signer.js", {
        LP_APEBOND_PURCHASE_SIGNER: ethers.ZeroAddress,
      });
      expect(result.code).to.equal(1);
      expect(result.stderr).to.contain("LP_APEBOND_ALLOW_CLOSE=1");
      expect(result.stdout).to.not.contain("ALREADY");
    });

    it("refuses an address and a key that name two different signers", async function () {
      const result = await run("set-purchase-signer.js", {
        LP_APEBOND_PURCHASE_SIGNER: w.apeBondSigner.address,
        LP_APEBOND_PURCHASE_SIGNER_KEY: w.backOffice.privateKey,
      });
      expect(result.code).to.equal(1);
      expect(result.stderr).to.contain("two different signers");
      // The key itself is never echoed, not even in a rejection.
      expect(result.stderr).to.not.contain(w.backOffice.privateKey);
      expect(result.stdout).to.not.contain(w.backOffice.privateKey);
      expect(await purchaseSignerOf(adapterAddr)).to.equal(ethers.ZeroAddress);
    });

    it("sets the signer from a PRIVATE KEY without ever printing it", async function () {
      const result = await runOk("set-purchase-signer.js", {
        LP_APEBOND_PURCHASE_SIGNER_KEY: w.apeBondSigner.privateKey,
      });
      expect(await purchaseSignerOf(adapterAddr)).to.equal(w.apeBondSigner.address);
      expect(result.stdout).to.contain(w.apeBondSigner.address);
      expect(result.stdout).to.not.contain(w.apeBondSigner.privateKey);
      expect(result.stderr).to.not.contain(w.apeBondSigner.privateKey);
    });

    it("sends nothing when the signer is already that address", async function () {
      const before = await provider.getBlockNumber();
      const result = await runOk("set-purchase-signer.js", {
        LP_APEBOND_PURCHASE_SIGNER: w.apeBondSigner.address,
      });
      expect(result.stdout).to.contain("ALREADY");
      expect(await provider.getBlockNumber()).to.equal(before);
      expect(await purchaseSignerOf(adapterAddr)).to.equal(w.apeBondSigner.address);
    });

    it("closes the route with LP_APEBOND_ALLOW_CLOSE=1, and opens it again", async function () {
      const closed = await runOk("set-purchase-signer.js", {
        LP_APEBOND_PURCHASE_SIGNER: ethers.ZeroAddress,
        LP_APEBOND_ALLOW_CLOSE: "1",
      });
      expect(closed.stdout).to.contain("CLOSED");
      expect(await purchaseSignerOf(adapterAddr)).to.equal(ethers.ZeroAddress);

      await runOk("set-purchase-signer.js", {
        LP_APEBOND_PURCHASE_SIGNER: w.apeBondSigner.address,
      });
      expect(await purchaseSignerOf(adapterAddr)).to.equal(w.apeBondSigner.address);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("fund-escrow.js", function () {
    /** The sample campaign's bonus, restated in the bonus token's own decimals. */
    const bonusWhole = () => ethers.formatUnits(C.APEBOND_BONUS, C.ASSET_DECIMALS);

    it("refuses a run that states neither an amount nor a target", async function () {
      const result = await run("fund-escrow.js", {});
      expect(result.code).to.equal(1);
      expect(result.stderr).to.contain("LP_APEBOND_FUND_AMOUNT");
      expect(await bonusBalance(escrowAddr)).to.equal(0n);
    });

    it("refuses both at once — they answer different questions", async function () {
      const result = await run("fund-escrow.js", {
        LP_APEBOND_FUND_AMOUNT: "100",
        LP_APEBOND_FUND_TARGET: "100",
      });
      expect(result.code).to.equal(1);
      expect(result.stderr).to.contain("not both");
      expect(await bonusBalance(escrowAddr)).to.equal(0n);
    });

    it("refuses an amount the sender cannot cover, and sends nothing", async function () {
      const result = await run("fund-escrow.js", { LP_APEBOND_FUND_AMOUNT: "999999999" });
      expect(result.code).to.equal(1);
      expect(result.stderr).to.contain("Insufficient");
      expect(await bonusBalance(escrowAddr)).to.equal(0n);
    });

    it("transfers a fixed amount and leaves totalReserved where it was", async function () {
      const escrow = at(escrowAddr, escrowIface);
      const reservedBefore = await escrow.totalReserved();
      const senderBefore = await bonusBalance(w.deployer.address);

      const amount = ethers.parseUnits("100", bonusDecimals);
      const result = await runOk("fund-escrow.js", { LP_APEBOND_FUND_AMOUNT: "100" });

      expect(await bonusBalance(escrowAddr)).to.equal(amount);
      expect(await bonusBalance(w.deployer.address)).to.equal(senderBefore - amount);
      expect(await escrow.totalReserved()).to.equal(reservedBefore);
      expect(await freeBalance()).to.equal(amount);
      expect(result.stdout).to.contain("FREE balance");
    });

    it("tops the FREE balance up to a target, sending only the difference", async function () {
      const target = ethers.parseUnits("1000", bonusDecimals);
      const senderBefore = await bonusBalance(w.deployer.address);
      const escrowBefore = await bonusBalance(escrowAddr);

      await runOk("fund-escrow.js", { LP_APEBOND_FUND_TARGET: "1000" });

      expect(await bonusBalance(escrowAddr)).to.equal(target);
      expect(await bonusBalance(w.deployer.address)).to.equal(senderBefore - (target - escrowBefore));
      expect(await freeBalance()).to.equal(target);
    });

    it("sends nothing when the free balance already meets the target", async function () {
      const before = await provider.getBlockNumber();
      const result = await runOk("fund-escrow.js", { LP_APEBOND_FUND_TARGET: "1000" });
      expect(result.stdout).to.contain("nothing sent");
      expect(await provider.getBlockNumber()).to.equal(before);
      expect(await freeBalance()).to.equal(ethers.parseUnits("1000", bonusDecimals));
    });

    it("funded the escrow past the sample campaign's bonus", async function () {
      expect(await freeBalance()).to.be.greaterThan(ethers.parseUnits(bonusWhole(), bonusDecimals));
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("apebond-rehearsal.js — the deposit phase", function () {
    /** Everything the deposit phase needs, minus whatever a refusal test overrides. */
    const depositEnv = (extra = {}) => ({
      LP_REHEARSAL_CALLER_KEY: w.soulZapCaller.privateKey,
      LP_REHEARSAL_BENEFICIARY: w.alice.address,
      LP_APEBOND_PURCHASE_SIGNER_KEY: w.apeBondSigner.privateKey,
      LP_REHEARSAL_CLIFF_SECONDS: String(CLIFF_SECONDS),
      ...extra,
    });

    let deposit;
    let reservedBeforeDeposit;

    it("refuses a caller wallet that is not on the adapter's allowlist, before the mint", async function () {
      const mintsBefore = await nfpm.mintCalls();
      const result = await run("apebond-rehearsal.js", depositEnv({ LP_REHEARSAL_CALLER_KEY: w.bob.privateKey }));
      expect(result.code).to.equal(1);
      expect(result.stdout).to.contain("FAIL");
      expect(result.stderr).to.contain("The route is not open");
      // Not a single transaction: the position manager never minted.
      expect(await nfpm.mintCalls()).to.equal(mintsBefore);
    });

    it("refuses a signing key that is not the adapter's purchase signer", async function () {
      const mintsBefore = await nfpm.mintCalls();
      const result = await run(
        "apebond-rehearsal.js",
        depositEnv({ LP_APEBOND_PURCHASE_SIGNER_KEY: w.backOffice.privateKey })
      );
      expect(result.code).to.equal(1);
      expect(result.stderr).to.contain("The route is not open");
      expect(result.stdout).to.contain(w.apeBondSigner.address);
      expect(result.stdout).to.not.contain(w.backOffice.privateKey);
      expect(await nfpm.mintCalls()).to.equal(mintsBefore);
    });

    it("refuses a bonus the escrow cannot back, before the mint", async function () {
      const mintsBefore = await nfpm.mintCalls();
      const result = await run("apebond-rehearsal.js", depositEnv({ LP_REHEARSAL_BONUS: "999999" }));
      expect(result.code).to.equal(1);
      expect(result.stderr).to.contain("depositFor would revert Underfunded");
      expect(await nfpm.mintCalls()).to.equal(mintsBefore);
    });

    it("mints, authorizes and deposits in one run", async function () {
      reservedBeforeDeposit = await at(escrowAddr, escrowIface).totalReserved();
      deposit = await runOk("apebond-rehearsal.js", depositEnv());
      expect(deposit.stdout).to.contain("The deposit phase passed");
      expect(deposit.stdout).to.not.contain("FAIL");
      // Neither private key reaches the output.
      expect(deposit.stdout).to.not.contain(w.soulZapCaller.privateKey);
      expect(deposit.stdout).to.not.contain(w.apeBondSigner.privateKey);
    });

    it("left the vault holding the NFT and crediting the BENEFICIARY, not the caller", async function () {
      const record = readRecord();
      const vault = at(vaultAddr, vaultIface);
      expect(await nfpm.ownerOf(record.tokenId)).to.equal(vaultAddr);
      expect(await vault.stakerOf(record.tokenId)).to.equal(w.alice.address);
      expect(record.beneficiary).to.equal(w.alice.address);
      expect(record.soulZapCaller).to.equal(w.soulZapCaller.address);
      // The position really is the campaign's range, exactly — the adapter matches it, not
      // "contains it".
      const position = await nfpm.positions(record.tokenId);
      expect(Number(position.tickLower)).to.equal(record.tickLower);
      expect(Number(position.tickUpper)).to.equal(record.tickUpper);
      expect(position.liquidity).to.equal(BigInt(record.liquidity));
    });

    it("reserved the bonus in the escrow, unclaimable until the cliff", async function () {
      const record = readRecord();
      const escrow = at(escrowAddr, escrowIface);
      const reservation = await escrow.reservationOf(record.purchaseId);

      expect(reservation.beneficiary).to.equal(w.alice.address);
      expect(reservation.amount).to.equal(BigInt(record.guaranteedBonusAmount));
      expect(reservation.unlockAt).to.equal(BigInt(record.bonusUnlockAt));
      expect(reservation.claimed).to.equal(false);
      expect(await escrow.claimable(record.purchaseId)).to.equal(0n);
      expect(await escrow.totalReserved()).to.equal(
        reservedBeforeDeposit + BigInt(record.guaranteedBonusAmount)
      );
      // The sample campaign's 495, in the bonus token's own decimals.
      expect(record.guaranteedBonusAmount).to.equal(
        ethers.parseUnits(ethers.formatUnits(C.APEBOND_BONUS, C.ASSET_DECIMALS), bonusDecimals).toString()
      );
    });

    it("spent the purchase id and wrote a record file with every transaction hash", async function () {
      const record = readRecord();
      expect(await at(adapterAddr, adapterIface).consumedPurchaseIds(record.purchaseId)).to.equal(true);

      expect(record.chainId).to.equal(CHAIN_ID);
      expect(record.adapter).to.equal(adapterAddr);
      expect(record.escrow).to.equal(escrowAddr);
      expect(record.claim).to.equal(null);
      for (const key of ["mintTx", "approveNftTx", "depositTx"]) {
        expect(record.deposit[key], key).to.match(/^0x[0-9a-f]{64}$/);
      }
      // The record is a run artifact of a rehearsal, so it must be ignored like the batch file.
      const gitignore = fs.readFileSync(path.join(runner.TRACKED_REGISTRY, "..", ".gitignore"), "utf8");
      expect(gitignore).to.contain("apebond-rehearsal-*.json");
    });

    it("emitted ApeBondPositionDeposited, which the run read back out of its own receipt", async function () {
      const record = readRecord();
      const receipt = await provider.getTransactionReceipt(record.deposit.depositTx);
      const iface = new ethers.Interface([
        "event ApeBondPositionDeposited(bytes32 indexed purchaseId,bytes32 indexed campaignId,address indexed beneficiary,bytes32 soulZapRequestId,uint256 tokenId,uint128 liquidity,int24 tickLower,int24 tickUpper,address inputToken,uint256 grossInputAmount,uint256 netInputAmount,uint256 guaranteedBonusAmount,uint64 bonusUnlockAt)",
      ]);
      const parsed = receipt.logs
        .filter((log) => log.address.toLowerCase() === adapterAddr.toLowerCase())
        .map((log) => {
          try {
            return iface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((event) => event && event.name === "ApeBondPositionDeposited");

      expect(parsed, "ApeBondPositionDeposited").to.not.equal(undefined);
      expect(parsed.args.purchaseId).to.equal(record.purchaseId);
      expect(parsed.args.beneficiary).to.equal(w.alice.address);
      expect(parsed.args.tokenId).to.equal(BigInt(record.tokenId));
      expect(parsed.args.guaranteedBonusAmount).to.equal(BigInt(record.guaranteedBonusAmount));
      expect(parsed.args.bonusUnlockAt).to.equal(BigInt(record.bonusUnlockAt));
    });

    it("refuses a second run that reuses the same purchase id", async function () {
      // A fresh run derives a fresh id from the clock, so the collision is forced by replaying
      // the nonce the record carries: the adapter spends nonces once, forever.
      const record = readRecord();
      const result = await run(
        "apebond-rehearsal.js",
        depositEnv({ LP_REHEARSAL_TICK_LOWER: String(record.tickLower), LP_REHEARSAL_TICK_UPPER: String(record.tickUpper) })
      );
      // Either the run is refused up front (same second, same nonce) or it mints a second
      // position and succeeds with a NEW id. Both are correct; what must never happen is a
      // second reservation against the id that is already spent.
      const escrow = at(escrowAddr, escrowIface);
      const reservation = await escrow.reservationOf(record.purchaseId);
      expect(reservation.amount).to.equal(BigInt(record.guaranteedBonusAmount));
      expect(reservation.claimed).to.equal(false);
      if (result.code === 0) {
        expect(readRecord().purchaseId).to.not.equal(record.purchaseId);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("fund-escrow.js, once a reservation is live", function () {
    it("reports a FREE balance that excludes what is already owed", async function () {
      const escrow = at(escrowAddr, escrowIface);
      const reserved = await escrow.totalReserved();
      expect(reserved).to.be.greaterThan(0n);

      const balance = await bonusBalance(escrowAddr);
      const result = await runOk("fund-escrow.js", { LP_APEBOND_FUND_AMOUNT: "0" });
      expect(result.stdout).to.contain("nothing sent");
      expect(result.stdout).to.contain(ethers.formatUnits(reserved, bonusDecimals));
      expect(await freeBalance()).to.equal(balance - reserved);
      expect(await escrow.totalReserved()).to.equal(reserved);
    });

    it("tops up against the FREE balance, not the raw balance", async function () {
      const escrow = at(escrowAddr, escrowIface);
      const reserved = await escrow.totalReserved();
      const target = ethers.parseUnits("1000", bonusDecimals);

      await runOk("fund-escrow.js", { LP_APEBOND_FUND_TARGET: "1000" });

      expect(await freeBalance()).to.equal(target);
      // The raw balance is the target PLUS everything still owed to a buyer.
      expect(await bonusBalance(escrowAddr)).to.equal(target + reserved);
      expect(await escrow.totalReserved()).to.equal(reserved);
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("apebond-rehearsal.js — the claim phase", function () {
    let record;
    let escrowBeforeClaim, reservedBeforeClaim, aliceBeforeClaim;

    before(function () {
      record = readRecord();
    });

    it("exits non-zero before the cliff, prints the seconds left, and sends nothing", async function () {
      const blockBefore = await provider.getBlockNumber();
      const result = await run("apebond-rehearsal.js", { LP_REHEARSAL_PHASE: "claim" });

      expect(result.code).to.equal(1);
      expect(result.stdout).to.contain("Seconds remaining:");
      expect(result.stderr).to.contain("of the cliff left");
      expect(await provider.getBlockNumber()).to.equal(blockBefore);
      expect((await at(escrowAddr, escrowIface).reservationOf(record.purchaseId)).claimed).to.equal(false);
      expect(readRecord().claim).to.equal(null);
    });

    it("pays the beneficiary exactly the bonus once the cliff has passed", async function () {
      const escrow = at(escrowAddr, escrowIface);
      escrowBeforeClaim = await bonusBalance(escrowAddr);
      reservedBeforeClaim = await escrow.totalReserved();
      aliceBeforeClaim = await bonusBalance(w.alice.address);

      // Chain time past the cliff. The script reads `block.timestamp`, so the mine matters as
      // much as the increase.
      await provider.send("evm_increaseTime", [CLIFF_SECONDS + 60]);
      await provider.send("evm_mine", []);

      expect(await escrow.claimable(record.purchaseId)).to.equal(BigInt(record.guaranteedBonusAmount));

      const result = await runOk("apebond-rehearsal.js", { LP_REHEARSAL_PHASE: "claim" });
      expect(result.stdout).to.contain("The claim phase passed");
      expect(result.stdout).to.not.contain("FAIL");
      // The trigger is the deployer, not the beneficiary — and the money still went to alice.
      expect(result.stdout).to.contain("NOT the beneficiary");

      const bonus = BigInt(record.guaranteedBonusAmount);
      expect(await bonusBalance(w.alice.address)).to.equal(aliceBeforeClaim + bonus);
      expect(await bonusBalance(escrowAddr)).to.equal(escrowBeforeClaim - bonus);
      expect(await escrow.totalReserved()).to.equal(reservedBeforeClaim - bonus);
    });

    it("marked the reservation claimed and left nothing claimable", async function () {
      const escrow = at(escrowAddr, escrowIface);
      const reservation = await escrow.reservationOf(record.purchaseId);
      expect(reservation.claimed).to.equal(true);
      expect(reservation.amount).to.equal(BigInt(record.guaranteedBonusAmount));
      expect(await escrow.claimable(record.purchaseId)).to.equal(0n);
    });

    it("appended the claim to the record file", async function () {
      const after = readRecord();
      expect(after.purchaseId).to.equal(record.purchaseId);
      expect(after.claim).to.not.equal(null);
      expect(after.claim.tx).to.match(/^0x[0-9a-f]{64}$/);
      expect(after.claim.trigger).to.equal(w.deployer.address);
      expect(after.claim.amount).to.equal(record.guaranteedBonusAmount);
    });

    it("refuses a second claim of the same purchase, and sends nothing", async function () {
      const blockBefore = await provider.getBlockNumber();
      const aliceBefore = await bonusBalance(w.alice.address);

      const result = await run("apebond-rehearsal.js", { LP_REHEARSAL_PHASE: "claim" });
      expect(result.code).to.equal(1);
      expect(result.stderr).to.contain("already been claimed");
      expect(await provider.getBlockNumber()).to.equal(blockBefore);
      expect(await bonusBalance(w.alice.address)).to.equal(aliceBefore);
    });

    it("refuses a purchase id the escrow has never heard of", async function () {
      const result = await run("apebond-rehearsal.js", {
        LP_REHEARSAL_PHASE: "claim",
        LP_REHEARSAL_PURCHASE_ID: ethers.id("no such purchase"),
      });
      expect(result.code).to.equal(1);
      expect(result.stderr).to.contain("holds no reservation");
    });
  });

  // ─────────────────────────────────────────────────────────────
  describe("the tracked registry", function () {
    it("was never written by any of these runs", function () {
      expect(runner.sha256File(runner.TRACKED_REGISTRY)).to.equal(TRACKED_REGISTRY_SHA256);
    });
  });
});
