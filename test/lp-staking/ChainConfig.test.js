const { expect } = require("chai");
const hre = require("hardhat");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const uniswap = require("../../scripts/lib/uniswap");
const pools = require("../../scripts/lib/pools");
const logs = require("../../scripts/lib/logs");

const ROOT = path.join(__dirname, "..", "..");
/** A child that loads Hardhat (and with it dotenv) prints nothing but what the test asks for. */
const QUIET = { HARDHAT_NETWORK: "hardhat", DOTENV_CONFIG_QUIET: "true" };

/**
 * The per-chain facts of the scripts for the launch on Avalanche C-Chain (2026-11-20): the two
 * networks, the Uniswap V3 deployment of each chain, which chains are mainnets, the block
 * explorer and the `eth_getLogs` chunk of each chain. The six Avalanche Uniswap addresses were
 * checked read-only for code on their chains before they were written.
 */
describe("Chain configuration (Ethereum + Avalanche)", function () {
  describe("scripts/lib/uniswap.js", function () {
    it("has the Uniswap V3 deployment of Avalanche C-Chain (43114)", function () {
      expect(uniswap.forChain(43114)).to.deep.equal({
        factory: "0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD",
        positionManager: "0x655C406EBFa14EE2006250925e54ec43AD184f8B",
        swapRouter02: "0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE",
      });
    });

    it("has the Uniswap V3 deployment of Fuji (43113)", function () {
      expect(uniswap.forChain(43113)).to.deep.equal({
        factory: "0x6739FCFDC0c6939939C0e8D55188E8D0D973E617",
        positionManager: "0xd7144710b6152526fb33699b166b5917a73f67fe",
        swapRouter02: "0x701067e5f83d71975988be412bbd922d806fd29d",
      });
    });

    it("keeps every address a valid address and leaves an unknown chain without defaults", function () {
      for (const chain of Object.values(uniswap.UNISWAP_BY_CHAIN)) {
        for (const address of Object.values(chain)) expect(hre.ethers.isAddress(address)).to.equal(true);
      }
      expect(uniswap.forChain(31337)).to.deep.equal({});
    });
  });

  describe("scripts/lib/pools.js", function () {
    it("treats Ethereum (1) and Avalanche C-Chain (43114) as mainnets, the testnets not", function () {
      expect(pools.isMainnet(1)).to.equal(true);
      expect(pools.isMainnet(43114)).to.equal(true);
      expect(pools.isMainnet(11155111)).to.equal(false);
      expect(pools.isMainnet(43113)).to.equal(false);
      expect(pools.isMainnet(31337)).to.equal(false);
    });

    it("refuses a state change on Avalanche C-Chain without CONFIRM=yes", function () {
      const saved = process.env.CONFIRM;
      delete process.env.CONFIRM;
      try {
        expect(() => pools.requireConfirmation(43114, "deploy")).to.throw(/CONFIRM=yes/);
        expect(() => pools.requireConfirmation(43113, "deploy")).to.not.throw();
      } finally {
        if (saved !== undefined) process.env.CONFIRM = saved;
      }
    });

    it("links the explorer of each Avalanche chain", function () {
      const a = "0x0000000000000000000000000000000000000001";
      expect(pools.explorerAddress(43114, a)).to.equal(`https://snowtrace.io/address/${a}`);
      expect(pools.explorerTx(43113, "0xab")).to.equal("https://testnet.snowtrace.io/tx/0xab");
    });

    it("keys the deployment registry by the chain id, also for Avalanche", function () {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chain-config-"));
      const file = path.join(dir, "deployments.json");
      fs.writeFileSync(file, JSON.stringify({ 43113: { UniswapV3Pool: { address: "0x01" } } }));
      const out = execFileSync(
        process.execPath,
        [
          "-e",
          "require('hardhat');" +
            "process.stdout.write(String(require('./scripts/lib/pools').registryAddress(43113, 'UniswapV3Pool')))",
        ],
        { cwd: ROOT, env: { ...process.env, ...QUIET, DEPLOYMENTS_FILE: file } }
      ).toString();
      expect(out).to.equal("0x01");
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe("scripts/lib/logs.js", function () {
    it("has a chunk for every chain, none above 10,000 blocks", function () {
      expect(logs.MAX_LOG_CHUNK).to.equal(10_000);
      for (const id of [1, 11155111, 43114, 43113]) {
        expect(logs.LOG_CHUNK_BY_CHAIN[id], `chain ${id}`).to.be.a("number");
        expect(logs.logChunkFor(id)).to.be.at.most(10_000);
      }
      expect(logs.logChunkFor(1)).to.equal(10_000);
      expect(logs.logChunkFor(11155111)).to.equal(10_000);
      expect(logs.logChunkFor(43114)).to.equal(2_048);
      expect(logs.logChunkFor(43113)).to.equal(2_048);
      expect(logs.logChunkFor(31337)).to.equal(10_000);
    });

    it("scans in the chain's own chunk when no chunk is given", async function () {
      const latest = await hre.ethers.provider.getBlockNumber();
      const chunks = [];
      await logs.scanLogs(hre.ethers.provider, {
        address: hre.ethers.ZeroAddress,
        topics: [],
        fromBlock: 0,
        toBlock: latest,
        onChunk: ({ start, end }) => chunks.push(end - start + 1),
      });
      expect(Math.max(...chunks)).to.be.at.most(logs.logChunkFor(31337));
    });

    it("refuses a chunk above 10,000 blocks on any chain", async function () {
      await expect(
        logs.scanLogs(hre.ethers.provider, { address: hre.ethers.ZeroAddress, topics: [], fromBlock: 0, toBlock: 1, chunk: 10_001 })
      ).to.be.rejectedWith(/chunk must be at most 10000 blocks — got 10001/);
    });
  });

  describe("hardhat.config.js networks", function () {
    it("defines avalanche (43114) and avalanche-fuji (43113) on Infura with the existing key", function () {
      const key = process.env.INFURA_API_KEY;
      const main = hre.config.networks.avalanche;
      const fuji = hre.config.networks["avalanche-fuji"];
      expect(main.chainId).to.equal(43114);
      expect(fuji.chainId).to.equal(43113);
      if (!process.env.AVALANCHE_RPC_URL) {
        expect(main.url).to.equal(`https://avalanche-mainnet.infura.io/v3/${key}`);
      }
      if (!process.env.AVALANCHE_FUJI_RPC_URL) {
        expect(fuji.url).to.equal(`https://avalanche-fuji.infura.io/v3/${key}`);
      }
    });

    it("lets AVALANCHE_RPC_URL / AVALANCHE_FUJI_RPC_URL override the endpoints", function () {
      const out = execFileSync(
        process.execPath,
        [
          "-e",
          "const c = require('hardhat').config.networks;" +
            "process.stdout.write(JSON.stringify([c.avalanche.url, c['avalanche-fuji'].url]))",
        ],
        {
          cwd: ROOT,
          env: {
            ...process.env,
            ...QUIET,
            AVALANCHE_RPC_URL: "http://127.0.0.1:9/main",
            AVALANCHE_FUJI_RPC_URL: "http://127.0.0.1:9/fuji",
          },
        }
      ).toString();
      expect(JSON.parse(out)).to.deep.equal(["http://127.0.0.1:9/main", "http://127.0.0.1:9/fuji"]);
    });
  });

  describe("foundry.toml", function () {
    it("names both Avalanche endpoints in [rpc_endpoints]", function () {
      const toml = fs.readFileSync(path.join(ROOT, "foundry.toml"), "utf8");
      expect(toml).to.match(/^avalanche = "\$\{AVALANCHE_RPC_URL\}"$/m);
      expect(toml).to.match(/^avalanche-fuji = "\$\{AVALANCHE_FUJI_RPC_URL\}"$/m);
    });
  });
});
