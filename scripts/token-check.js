const hre = require("hardhat");

const ERC20 = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
];

async function describe(label, addr) {
  const code = await hre.ethers.provider.getCode(addr);
  console.log(`\n${label}: ${addr}`);
  if (code === "0x") {
    console.log("  !! NO CONTRACT CODE AT THIS ADDRESS");
    return;
  }
  console.log("  bytecode size:", (code.length - 2) / 2, "bytes");
  const t = new hre.ethers.Contract(addr, ERC20, hre.ethers.provider);
  try {
    const [n, s, d, ts] = await Promise.all([t.name(), t.symbol(), t.decimals(), t.totalSupply()]);
    console.log(`  ${n} (${s}), decimals=${d}, totalSupply=${hre.ethers.formatUnits(ts, d)}`);
  } catch (e) {
    console.log("  !! ERC20 metadata calls failed:", e.shortMessage || e.message);
  }
}

async function main() {
  await describe("STAKING_TOKEN", process.env.STAKING_TOKEN);
  await describe("REWARD_TOKEN", process.env.REWARD_TOKEN);

  const block = await hre.ethers.provider.getBlock("latest");
  const act = Number(process.env.ACTIVATION_EPOCH);
  const end = Number(process.env.END_EPOCH);
  console.log("\nchain time:", block.timestamp, new Date(block.timestamp * 1000).toISOString());
  console.log("activation:", act, new Date(act * 1000).toISOString(), act <= block.timestamp ? "(ALREADY PASSED)" : `(in ${((act - block.timestamp) / 3600).toFixed(1)}h)`);
  console.log("end:       ", end, new Date(end * 1000).toISOString());
  console.log("duration:  ", ((end - act) / 86400).toFixed(2), "days");

  console.log("\nWEIGHT_SIGNER:", process.env.WEIGHT_SIGNER);
  console.log("  code:", (await hre.ethers.provider.getCode(process.env.WEIGHT_SIGNER)) === "0x" ? "EOA (expected)" : "CONTRACT (!! cannot produce ECDSA sigs)");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
