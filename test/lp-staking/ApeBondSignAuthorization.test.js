const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const script = require("../../scripts/apebond-sign-authorization");
const { purchaseAuthorizationTypeHash, PURCHASE_AUTHORIZATION_FIELDS } = require("./helpers/signing");

/**
 * `scripts/apebond-sign-authorization.js` — the sign-only pair a third-party router spends.
 *
 * The script is driven through its exported pipeline — environment parsing, the chain reads,
 * the pure builder, the off-chain signer and the digest/recovery assertion — against the same
 * in-process harness `ApeBondPositionAdapter.test.js` uses: a real vault proxy, a real escrow
 * proxy and a real adapter in front of `MockPositionManager`, `MockUniswapV3Pool` and
 * `MockSoulZapCaller`. No spawned node, no fork, no network: what `hardhat run` adds on top
 * (the registry lookup and the file write) is covered by the Sepolia dry run, not here.
 *
 * The router side is played by `MockSoulZapCaller`, which is what ApeBond's router does: it
 * holds the freshly minted NFT, approves the adapter and calls `depositFor` in one transaction.
 * The pair it presents is the JSON form the script writes — every number a decimal string —
 * so the success case also proves the file is usable exactly as it is handed over.
 */
describe("apebond-sign-authorization.js — a sign-only pair for a third-party router", function () {
  const FEE = 3000;
  const TWAP_WINDOW = 600;
  const MAX_DEVIATION_TICKS = 500;
  const TICK_LOWER = -600;
  const TICK_UPPER = 600;
  const LIQUIDITY = 1_000_000n;
  const MIN_LIQUIDITY = 500_000n;
  const ZERO = ethers.ZeroAddress;
  const TOKENS = (n) => ethers.parseEther(String(n));

  let owner, guardian, alice, bob, stranger;
  /** The purchase signer is a plain wallet because the script signs with a private key. */
  let signerWallet;
  let adapter, vault, escrow, soulZap, nfpm, bonus;
  let adapterAddr, vaultAddr, escrowAddr, soulZapAddr, nfpmAddr;
  let token0Addr, token1Addr, usdcAddr, bonusAddr;

  beforeEach(async function () {
    [owner, guardian, alice, bob, stranger] = await ethers.getSigners();
    signerWallet = ethers.Wallet.createRandom();

    const Token = await ethers.getContractFactory("MockERC20Decimals");
    const usdc = await Token.deploy("USD Coin", "USDC", 1_000_000n * 10n ** 6n, 6);
    const asset = await Token.deploy("Asset", "ASSET", 1_000_000n * 10n ** 18n, 18);
    usdcAddr = await usdc.getAddress();
    const sorted = usdcAddr.toLowerCase() < (await asset.getAddress()).toLowerCase() ? [usdc, asset] : [asset, usdc];
    token0Addr = await sorted[0].getAddress();
    token1Addr = await sorted[1].getAddress();

    bonus = await Token.deploy("Bonus", "BONUS", TOKENS(10_000_000), 18);
    bonusAddr = await bonus.getAddress();

    const pool = await (await ethers.getContractFactory("MockUniswapV3Pool")).deploy(token0Addr, token1Addr, FEE);
    const poolAddr = await pool.getAddress();
    nfpm = await (await ethers.getContractFactory("MockPositionManager")).deploy();
    nfpmAddr = await nfpm.getAddress();
    const router = await (await ethers.getContractFactory("MockSwapRouter")).deploy();

    vault = await upgrades.deployProxy(
      await ethers.getContractFactory("LPStakingVault"),
      [owner.address, guardian.address, owner.address, ZERO, TWAP_WINDOW, MAX_DEVIATION_TICKS],
      {
        kind: "uups",
        constructorArgs: [nfpmAddr, poolAddr, token0Addr, token1Addr, FEE, await router.getAddress()],
        unsafeAllow: ["constructor", "state-variable-immutable"],
      }
    );
    vaultAddr = await vault.getAddress();

    escrow = await upgrades.deployProxy(await ethers.getContractFactory("BonusEscrow"), [owner.address, ZERO], {
      kind: "uups",
      constructorArgs: [bonusAddr],
      unsafeAllow: ["constructor", "state-variable-immutable"],
    });
    escrowAddr = await escrow.getAddress();
    await bonus.transfer(escrowAddr, TOKENS(1_000));

    adapter = await (await ethers.getContractFactory("ApeBondPositionAdapter")).deploy(
      nfpmAddr,
      vaultAddr,
      escrowAddr,
      token0Addr,
      token1Addr,
      FEE,
      owner.address,
      guardian.address,
      signerWallet.address
    );
    adapterAddr = await adapter.getAddress();

    soulZap = await (await ethers.getContractFactory("MockSoulZapCaller")).deploy();
    soulZapAddr = await soulZap.getAddress();

    await vault.setStakeOperator(adapterAddr, true);
    await escrow.setAdapter(adapterAddr);
    await adapter.setSoulZapCaller(soulZapAddr, true);
  });

  /** The environment an operator would set, with every required variable present. */
  function envFor(overrides = {}) {
    return {
      LP_SIGN_BENEFICIARY: alice.address,
      LP_SIGN_SOULZAP_CALLER: soulZapAddr,
      LP_SIGN_INPUT_TOKEN: usdcAddr,
      LP_SIGN_GROSS: "1000",
      LP_SIGN_NET: "990",
      LP_SIGN_BONUS: "100",
      LP_SIGN_TICK_LOWER: String(TICK_LOWER),
      LP_SIGN_TICK_UPPER: String(TICK_UPPER),
      LP_SIGN_MIN_LIQUIDITY: String(MIN_LIQUIDITY),
      ...overrides,
    };
  }

  /** The script's pipeline up to the signature: env -> chain reads -> pure builder. */
  async function build(envOverrides = {}, { signerAddress = signerWallet.address } = {}) {
    const inputs = script.readSignInputs(envFor(envOverrides));
    const chain = await script.readChainState({ provider: ethers.provider, adapterAddress: adapterAddr, inputs });
    return { inputs, chain, ...script.buildAuthorization({ ...inputs, signerAddress }, chain) };
  }

  /** ...then the off-chain signature and the digest/recovery assertion against the adapter. */
  async function buildAndSign(envOverrides = {}) {
    const built = await build(envOverrides);
    const signed = await script.signAuthorization(built.authorization, signerWallet.privateKey, built.chain.domain);
    const onChainDigest = await adapter.hashPurchaseAuthorization(built.authorization);
    script.verifyAuthorization({
      domain: built.chain.domain,
      authorization: built.authorization,
      signature: signed.signature,
      digest: signed.digest,
      onChainDigest,
      purchaseSigner: built.chain.purchaseSigner,
    });
    return { ...built, ...signed, onChainDigest, json: script.authorizationToJson(built.authorization) };
  }

  /** The router's own mint: a position on the campaign pair, held by the router contract. */
  async function mintForRouter({ tickLower = TICK_LOWER, tickUpper = TICK_UPPER } = {}) {
    await nfpm.mintFake(soulZapAddr, token0Addr, token1Addr, FEE, tickLower, tickUpper, LIQUIDITY, 0, 0);
    return nfpm.lastMintedId();
  }

  function routerDeposit(tokenId, pair) {
    return soulZap.deposit(adapterAddr, nfpmAddr, tokenId, pair.json, pair.signature);
  }

  it("signs a pair the router spends with depositFor: custody, staker, reservation and event", async function () {
    const pair = await buildAndSign();
    const now = BigInt(pair.chain.nowSeconds);
    const a = pair.authorization;

    expect(pair.digest).to.equal(pair.onChainDigest);
    expect(pair.signer).to.equal(signerWallet.address);
    expect(pair.chain.typehash).to.equal(purchaseAuthorizationTypeHash());
    expect(pair.chain.tickSpacing).to.equal(60); // the mock pool has no tickSpacing(): the fee's standard spacing
    expect(a.campaignId).to.equal(ethers.id("REAL-APEBOND-REHEARSAL"));
    expect(a.nonce).to.equal(now);
    expect(a.purchaseId).to.equal(
      script.defaultPurchaseId({
        campaignId: a.campaignId,
        beneficiary: alice.address,
        soulZapCaller: soulZapAddr,
        nonce: now,
        chainId: pair.chain.chainId,
      })
    );
    expect(a.grossInputAmount).to.equal(1_000_000_000n); // 1,000 USDC, 6 decimals
    expect(a.netInputAmount).to.equal(990_000_000n);
    expect(a.guaranteedBonusAmount).to.equal(TOKENS(100));
    expect(a.bonusUnlockAt).to.equal(now + 300n);
    expect(a.deadline).to.equal(now + 3600n);
    expect(a.minLiquidity).to.equal(MIN_LIQUIDITY);

    // The file form: 14 fields in struct order, hex or decimal strings only.
    expect(Object.keys(pair.json)).to.deep.equal(PURCHASE_AUTHORIZATION_FIELDS.map((f) => f.name));
    expect(pair.json.expectedTickLower).to.equal("-600");
    expect(pair.json.grossInputAmount).to.equal("1000000000");

    const block = script.routerBlock({
      chainId: pair.chain.chainId,
      adapter: adapterAddr,
      domain: pair.chain.domain,
      authorization: a,
      signature: pair.signature,
      digest: pair.digest,
      figures: pair.figures,
    });
    expect(block).to.contain("FOR THE ROUTER SIDE");
    expect(block).to.contain(pair.signature);
    expect(block).to.contain(`Mint exactly on ticks [${TICK_LOWER}, ${TICK_UPPER}] with liquidity >= ${MIN_LIQUIDITY}`);
    expect(block).to.contain(`call depositFor from ${soulZapAddr}; single use.`);

    const tokenId = await mintForRouter();
    await expect(routerDeposit(tokenId, pair))
      .to.emit(adapter, "ApeBondPositionDeposited")
      .withArgs(
        a.purchaseId,
        a.campaignId,
        alice.address,
        tokenId,
        LIQUIDITY,
        TICK_LOWER,
        TICK_UPPER,
        usdcAddr,
        a.grossInputAmount,
        a.netInputAmount,
        a.guaranteedBonusAmount,
        a.bonusUnlockAt
      );
    expect(await nfpm.ownerOf(tokenId)).to.equal(vaultAddr);
    expect(await vault.stakerOf(tokenId)).to.equal(alice.address);
    const reservation = await escrow.reservationOf(a.purchaseId);
    expect(reservation.beneficiary).to.equal(alice.address);
    expect(reservation.amount).to.equal(TOKENS(100));
    expect(reservation.unlockAt).to.equal(a.bonusUnlockAt);
    expect(await adapter.consumedNonces(a.nonce)).to.equal(true);
  });

  it("refuses a signer key that is not the adapter's purchaseSigner, and signs nothing", async function () {
    const other = ethers.Wallet.createRandom();
    await expect(build({}, { signerAddress: other.address })).to.be.rejectedWith(
      new RegExp(`FAIL  LP_APEBOND_PURCHASE_SIGNER_KEY belongs to ${other.address}, and adapter.purchaseSigner\\(\\) is ${signerWallet.address}`)
    );
  });

  it("refuses a caller that is not on the adapter's SoulZap allowlist", async function () {
    await expect(build({ LP_SIGN_SOULZAP_CALLER: stranger.address })).to.be.rejectedWith(
      new RegExp(`FAIL  adapter.soulZapCallers\\(${stranger.address}\\) is true`)
    );
  });

  it("refuses a range off the pool's tick grid, and an inverted range", async function () {
    await expect(build({ LP_SIGN_TICK_LOWER: "-590" })).to.be.rejectedWith(
      /FAIL  \[-590, 600\] is on the pool's tick grid \(tickSpacing 60/
    );
    await expect(build({ LP_SIGN_TICK_LOWER: "600", LP_SIGN_TICK_UPPER: "-600" })).to.be.rejectedWith(
      /FAIL  LP_SIGN_TICK_LOWER \(600\) is below LP_SIGN_TICK_UPPER \(-600\)/
    );
  });

  it("refuses a net input above the gross input", async function () {
    await expect(build({ LP_SIGN_NET: "1000.000001" })).to.be.rejectedWith(
      /FAIL  LP_SIGN_NET \(1000\.000001\) is not above LP_SIGN_GROSS \(1000\)/
    );
  });

  it("refuses an input token that is not one of the pool's two, and a bonus the escrow cannot back", async function () {
    await expect(build({ LP_SIGN_INPUT_TOKEN: bonusAddr })).to.be.rejectedWith(
      /FAIL  LP_SIGN_INPUT_TOKEN .* is one of the pool's two tokens/
    );
    // 1,000 BONUS funded, nothing reserved yet: 1,000 is fine and 1,000.000000000000000001 is not.
    await build({ LP_SIGN_BONUS: "1000" });
    await expect(build({ LP_SIGN_BONUS: "1000.000000000000000001" })).to.be.rejectedWith(
      /FAIL  the escrow can still reserve 1000\.0 BONUS/
    );
  });

  it("lists every failing check at once", async function () {
    const error = await build({
      LP_SIGN_SOULZAP_CALLER: stranger.address,
      LP_SIGN_NET: "2000",
      LP_SIGN_TICK_LOWER: "-590",
    }).then(
      () => null,
      (e) => e
    );
    expect(error).to.not.equal(null);
    expect(error.message).to.match(/^3 check\(s\) failed; nothing was signed/);
    expect(error.checks.filter((c) => !c.ok)).to.have.lengthOf(3);
  });

  it("a pair presented after its deadline is rejected by the adapter (AuthorizationExpired)", async function () {
    const pair = await buildAndSign({ LP_SIGN_DEADLINE_SECONDS: "60" });
    const tokenId = await mintForRouter();
    await time.increase(120);

    await expect(routerDeposit(tokenId, pair))
      .to.be.revertedWithCustomError(adapter, "AuthorizationExpired")
      .withArgs(pair.authorization.deadline, (ts) => ts > pair.authorization.deadline);
  });

  it("two outstanding pairs sharing a nonce: the second is rejected by the adapter (NonceAlreadyUsed)", async function () {
    // Both signed before either lands, as two quotes handed out together would be. Different
    // beneficiaries give different default purchase ids, so the NONCE is the only thing shared.
    const first = await buildAndSign({ LP_SIGN_NONCE: "42" });
    const second = await buildAndSign({ LP_SIGN_NONCE: "42", LP_SIGN_BENEFICIARY: bob.address });
    expect(first.authorization.purchaseId).to.not.equal(second.authorization.purchaseId);

    await routerDeposit(await mintForRouter(), first);
    await expect(routerDeposit(await mintForRouter(), second))
      .to.be.revertedWithCustomError(adapter, "NonceAlreadyUsed")
      .withArgs(42n);

    // Once spent on chain, the script itself refuses that explicit nonce.
    await expect(build({ LP_SIGN_NONCE: "42", LP_SIGN_BENEFICIARY: stranger.address })).to.be.rejectedWith(
      /FAIL  nonce 42 has not been used on this adapter/
    );
  });

  it("the default nonce walks past consumed ones; an explicit one is reported, not moved", async function () {
    const consumed = new Set([100n, 101n]);
    const isConsumed = async (n) => consumed.has(n);
    expect(await script.resolveNonce({ nowSeconds: 100, isConsumed })).to.deep.equal({
      nonce: 102n,
      consumed: false,
      bumped: 2,
      explicit: false,
    });
    expect(await script.resolveNonce({ explicitNonce: 101n, nowSeconds: 100, isConsumed })).to.deep.equal({
      nonce: 101n,
      consumed: true,
      bumped: 0,
      explicit: true,
    });
  });

  it("refuses chain 1 and rejects malformed environment values before reading the chain", function () {
    expect(() => script.refuseMainnet(1)).to.throw(/refuses to run on mainnet/);
    expect(() => script.refuseMainnet(11155111)).to.not.throw();
    expect(() => script.refuseMainnet(31337)).to.not.throw();

    expect(() => script.readSignInputs(envFor({ LP_SIGN_BENEFICIARY: "" }))).to.throw(/Set LP_SIGN_BENEFICIARY/);
    expect(() => script.readSignInputs(envFor({ LP_SIGN_GROSS: "-5" }))).to.throw(/LP_SIGN_GROSS must be a non-negative number/);
    expect(() => script.readSignInputs(envFor({ LP_SIGN_TICK_UPPER: "6e2" }))).to.throw(/LP_SIGN_TICK_UPPER must be an integer/);
    expect(() => script.readSignInputs(envFor({ LP_SIGN_CAMPAIGN: "0x1234" }))).to.throw(/LP_SIGN_CAMPAIGN must be a 0x-prefixed bytes32/);
    expect(() => script.readSignerWallet({ LP_APEBOND_PURCHASE_SIGNER_KEY: "not-a-key" })).to.throw(
      /^LP_APEBOND_PURCHASE_SIGNER_KEY is not a valid private key \(the value is not printed\)$/
    );
  });
});
