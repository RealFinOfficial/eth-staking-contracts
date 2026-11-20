// The committed transition artifacts are what the compiled contracts produce today:
// test/vectors/transition.json (spec 01 §9.3.1, §9.4.1) and the four abi/*.json files the indexer
// reads. Refresh both with `npx hardhat run scripts/export-transition-artifacts.js`.

const fs = require("fs");
const path = require("path");
const { expect } = require("chai");
const { ethers } = require("hardhat");

const { buildVectors, exportedAbis } = require("../../scripts/lib/transition-vectors");

const ROOT = path.join(__dirname, "..", "..");

describe("Transition vectors and ABIs", function () {
  it("test/vectors/transition.json equals a fresh build from the compiled contracts", async function () {
    const committed = JSON.parse(fs.readFileSync(path.join(ROOT, "test", "vectors", "transition.json"), "utf8"));
    expect(committed).to.deep.equal(JSON.parse(JSON.stringify(await buildVectors())));
    expect(committed.receivingAddress.vectors.length).to.be.at.least(3);
    expect(committed.deliveryVoucher.vectors.map((v) => v.domain.chainId)).to.deep.equal([43114, 43113]);
  });

  it("each voucher vector recovers its signer and its digest is domain + struct hash", function () {
    const committed = JSON.parse(fs.readFileSync(path.join(ROOT, "test", "vectors", "transition.json"), "utf8"));
    for (const v of committed.deliveryVoucher.vectors) {
      const digest = ethers.keccak256(ethers.concat(["0x1901", v.domainSeparator, v.structHash]));
      expect(digest).to.equal(v.digest);
      expect(ethers.recoverAddress(v.digest, v.signature)).to.equal(v.signer);
    }
  });

  it("the committed abi/*.json files equal the compiled ABIs", async function () {
    for (const [name, abi] of Object.entries(await exportedAbis())) {
      const committed = JSON.parse(fs.readFileSync(path.join(ROOT, "abi", `${name}.json`), "utf8"));
      expect(committed, name).to.deep.equal(abi);
    }
  });
});
