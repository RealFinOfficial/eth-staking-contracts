/**
 * Storage-layout pin for the minimal v3 pool (decision of 2026-11-10): the OpenZeppelin upgrades
 * validator grades the current `WeightedStakingPoolV3` as a legal successor of the implementation
 * live on Sepolia stack #6 before it (a verbatim copy, `WeightedStakingPoolV3WeightedMock`, commit
 * db26a15), offline, from the build info alone. A removed or renamed field of `PoolStorage` or
 * `StakeInfo` fails here before it can fail on the live proxy. The live-proxy check itself is
 * `scripts/validate-upgrade-safety.js --network sepolia`.
 */
const { ethers, upgrades } = require("hardhat");

describe("WeightedStakingPoolV3 storage layout", function () {
  it("is a legal UUPS successor of the weighted implementation live on stack #6", async function () {
    const Previous = await ethers.getContractFactory("WeightedStakingPoolV3WeightedMock");
    const Current = await ethers.getContractFactory("WeightedStakingPoolV3");
    await upgrades.validateImplementation(Current, { kind: "uups" });
    await upgrades.validateUpgrade(Previous, Current, { kind: "uups" });
  });

});
