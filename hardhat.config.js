require("@nomicfoundation/hardhat-toolbox");
require("@nomicfoundation/hardhat-ledger");
require("@openzeppelin/hardhat-upgrades");
require("dotenv").config();

module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      evmVersion: "cancun",
    },
  },
  networks: {
    // A Hardhat node the test harness starts itself (see
    // test/lp-staking/integration/LPStakingLocalFork.test.js). The built-in `localhost`
    // network is fixed at http://127.0.0.1:8545, so the port the harness picked has to
    // come in through LOCALHOST_RPC_URL. LOCALHOST_GAS_PRICE pins the gas price for
    // `npx hardhat run --network localhost`: a forked node inherits mainnet's base fee,
    // and fee estimation against a pinned block is exactly the failure class the fork
    // suite already removed by pinning fees on every signer.
    // There is deliberately NO `hardhat` entry here — the in-process fork suite resets
    // with a bare `hardhat_reset`, and a config entry would change what that resets to.
    localhost: {
      url: process.env.LOCALHOST_RPC_URL || "http://127.0.0.1:8545",
      ...(process.env.LOCALHOST_GAS_PRICE
        ? { gasPrice: Number(process.env.LOCALHOST_GAS_PRICE) }
        : {}),
    },
    sepolia: {
      url: `https://sepolia.infura.io/v3/${process.env.INFURA_API_KEY}`,
      chainId: 11155111,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    // Mainnet signs through a Ledger only — no PRIVATE_KEY is ever loaded here.
    mainnet: {
      url:
        process.env.MAINNET_RPC_URL ||
        `https://mainnet.infura.io/v3/${process.env.INFURA_API_KEY}`,
      chainId: 1,
      ledgerAccounts: process.env.LEDGER_ACCOUNT ? [process.env.LEDGER_ACCOUNT] : [],
    },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || "",
  },
};
