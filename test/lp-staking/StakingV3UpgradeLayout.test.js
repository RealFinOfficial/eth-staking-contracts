/**
 * Storage-layout pin for the minimal v3 pool (decision of 2026-11-10): the OpenZeppelin upgrades
 * validator grades the current `WeightedStakingPoolV3` as a legal successor of the implementation
 * live on Sepolia stack #6 before it (a verbatim copy, `WeightedStakingPoolV3WeightedMock`, commit
 * db26a15), offline, from the build info alone. A removed or renamed field of `PoolStorage` or
 * `StakeInfo` fails here before it can fail on the live proxy. The live-proxy check itself is
 * `scripts/validate-upgrade-safety.js --network sepolia`.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { CONTRACTS, checkRecordedLayouts } = require("../../scripts/validate-upgrade-safety");

describe("WeightedStakingPoolV3 storage layout", function () {
  it("is a legal UUPS successor of the weighted implementation live on stack #6", async function () {
    const Previous = await ethers.getContractFactory("WeightedStakingPoolV3WeightedMock");
    const Current = await ethers.getContractFactory("WeightedStakingPoolV3");
    await upgrades.validateImplementation(Current, { kind: "uups" });
    await upgrades.validateUpgrade(Previous, Current, { kind: "uups" });
  });

  // The transition (spec 01 §9.4.2, 2026-11-20): the migrator's three appended fields must leave
  // every recorded layout of its namespace intact (half 3 of validate-upgrade-safety.js).
  it("StakingMigrator is a legal successor of every layout recorded in the committed manifests", async function () {
    const results = await checkRecordedLayouts(CONTRACTS.filter((c) => c.name === "StakingMigrator"));
    expect(results.length).to.be.at.least(3, "stack #6 recorded three migrator implementations");
    for (const r of results) expect(r.ok, r.line).to.equal(true);
  });

  it("the recorded-layout check refuses a layout with a field moved (negative control)", async function () {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", ".openzeppelin", "sepolia.json"), "utf8"));
    const ns = "erc7201:real.staking.storage.StakingMigrator";
    const impl = Object.values(manifest.impls).find((i) => (i.layout.namespaces || {})[ns]);
    const broken = JSON.parse(JSON.stringify(impl));
    // Recorded with an extra address in front of `stakingPool`: the current layout no longer matches.
    broken.layout.namespaces[ns].unshift({ ...broken.layout.namespaces[ns][0], label: "inserted" });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "layout-"));
    fs.writeFileSync(path.join(dir, "broken.json"), JSON.stringify({ impls: { x: broken } }));
    const results = await checkRecordedLayouts(CONTRACTS.filter((c) => c.name === "StakingMigrator"), dir);
    expect(results).to.have.length(1);
    expect(results[0].ok).to.equal(false);
  });
});
