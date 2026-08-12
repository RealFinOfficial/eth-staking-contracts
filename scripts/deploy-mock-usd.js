const hre = require("hardhat");
const pools = require("./lib/pools");

// Deploys a USDC-like 6-decimal mock reward token (1,000,000 mUSD to deployer).
// Testnet only — mainnet uses real USDC.
//   MOCK_SUPPLY / MOCK_DECIMALS — optional overrides
async function main() {
  const chainId = await pools.chainId();
  if (pools.isMainnet(chainId)) {
    throw new Error("Refusing to deploy a mock token on mainnet");
  }

  const deployer = await pools.getSigner();
  const decimals = Number(process.env.MOCK_DECIMALS || 6);
  const supply = process.env.MOCK_SUPPLY || "1000000";

  console.log(`Network:  chain ${chainId}`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Supply:   ${supply} (${decimals} decimals)`);

  const factory = await hre.ethers.getContractFactory("MockERC20Decimals");
  const token = await factory.deploy(
    "Mock USD",
    "mUSD",
    hre.ethers.parseUnits(supply, decimals),
    decimals
  );
  await token.waitForDeployment();

  const address = await token.getAddress();
  console.log(`\nMockERC20Decimals (mUSD, ${decimals} decimals) deployed to: ${address}`);
  console.log(pools.explorerAddress(chainId, address));
  console.log(`\nUse it as REWARD_TOKEN=${address}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
