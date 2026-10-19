require("@nomicfoundation/hardhat-toolbox");
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
    // Mainnet signs with the deployer's private key from MAINNET_PRIVATE_KEY, set on the
    // operator's machine only and never printed (decision of 2026-10-19). It is a separate
    // variable from the sepolia PRIVATE_KEY on purpose. dotenv fills every variable the shell
    // left unset from the repo .env, and that .env holds the Sepolia key under PRIVATE_KEY.
    // Reading PRIVATE_KEY here would let that Sepolia key become the mainnet deployer without
    // anyone setting it. With MAINNET_PRIVATE_KEY unset this network has no signer and every
    // state-changing script stops in pools.getSigner(). The Safe needs no signer here, the
    // scripts print its calldata.
    mainnet: {
      url:
        process.env.MAINNET_RPC_URL ||
        `https://mainnet.infura.io/v3/${process.env.INFURA_API_KEY}`,
      chainId: 1,
      accounts: process.env.MAINNET_PRIVATE_KEY ? [process.env.MAINNET_PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || "",
  },
};
