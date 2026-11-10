/**
 * Unit tests for the fork suites' failure diagnostics (helpers/fork-diagnostics.js), on the
 * in-process Hardhat network: a really mined, really reverted transaction is traced.
 */

const hre = require("hardhat");
const { expect } = require("chai");

const diag = require("./helpers/fork-diagnostics");

describe("fork suite diagnostics (trace of a failed transaction)", function () {
  it("finds the transaction hash in the error shapes ethers and helpers/chain.js produce", function () {
    const h = "0x" + "ab".repeat(32);
    const h2 = "0x" + "cd".repeat(32);
    expect(diag.txHashesFromError({ message: `could not coalesce error (error={ "data": { "txHash": "${h}" } })` })).to.deep.equal([h]);
    expect(diag.txHashesFromError(new Error(`transaction ${h2} reverted on chain (status 0)`))).to.deep.equal([h2]);
    expect(diag.txHashesFromError({ message: "x", receipt: { hash: h } })).to.deep.equal([h]);
    expect(diag.txHashesFromError(new Error("no hash here"))).to.deep.equal([]);
    expect(diag.txHashesFromError(undefined)).to.deep.equal([]);
  });

  it("decodes Error(string), Panic and empty revert data", function () {
    const coder = hre.ethers.AbiCoder.defaultAbiCoder();
    expect(diag.decodeRevert("0x08c379a0" + coder.encode(["string"], ["boom"]).slice(2))).to.equal('Error("boom")');
    expect(diag.decodeRevert("0x4e487b71" + coder.encode(["uint256"], [0x11]).slice(2))).to.equal("Panic(0x11)");
    expect(diag.decodeRevert("0x")).to.equal("empty revert data (0x)");
    expect(diag.decodeRevert("0xdeadbeef")).to.match(/raw data 0xdeadbeef/);
  });

  it("traces a mined, reverted transaction: reason, first REVERT, open call frames", async function () {
    const [deployer, other] = await hre.ethers.getSigners();
    const Token = await hre.ethers.getContractFactory("MockERC20Permit");
    const token = await Token.deploy("T", "T", 1000n, 18);
    await token.waitForDeployment();

    // An explicit gas limit skips estimation, so the reverting transaction is mined.
    const tx = await token.connect(other).transfer(deployer.address, 1n, { gasLimit: 200_000 }).catch((e) => e);
    const hash = diag.txHashesFromError(tx)[0] || tx.hash;
    expect(hash).to.match(/^0x[0-9a-f]{64}$/);
    const receipt = await hre.ethers.provider.send("eth_getTransactionReceipt", [hash]);
    expect(receipt.status).to.equal("0x0");

    const trace = await hre.ethers.provider.send("debug_traceTransaction", [
      hash,
      { disableMemory: true, disableStorage: true },
    ]);
    const s = diag.summariseTrace(trace);
    expect(s.failed).to.equal(true);
    expect(s.firstRevert.op).to.equal("REVERT");
    expect(s.firstRevert.depth).to.equal(1);
    expect(s.openFrames).to.deep.equal([]);
    expect(s.lastSteps.at(-1)).to.match(/ REVERT /);
    // OpenZeppelin's ERC20InsufficientBalance custom error, reported as raw data.
    expect(diag.decodeRevert(s.returnValue)).to.match(/custom error/);

    const lines = [];
    const original = console.log;
    console.log = (line) => lines.push(String(line));
    try {
      await diag.printTransactionTrace(hre.ethers.provider, hash, "t");
      await diag.reportFailedTest({ state: "failed", err: new Error(`transaction ${hash} reverted on chain`) }, hre.ethers.provider, "t");
      await diag.printTransactionTrace(hre.ethers.provider, "0x" + "00".repeat(32), "t");
    } finally {
      console.log = original;
    }
    expect(lines.some((l) => /\[t diag\] trace: failed=true/.test(l))).to.equal(true);
    expect(lines.filter((l) => /first REVERT\/INVALID at depth 1/.test(l))).to.have.length(2);
    // A diagnostic that cannot trace says so in one line instead of throwing.
    expect(lines.some((l) => /could not trace 0x0{64}/.test(l))).to.equal(true);
  });

  it("follows a nested call into the frame that reverted", function () {
    const word = (addr) => "0x" + addr.slice(2).padStart(64, "0");
    const callee = "0x1111111111111111111111111111111111111111";
    const trace = {
      failed: true,
      gas: 50_000,
      returnValue: "",
      structLogs: [
        { depth: 1, pc: 0, op: "PUSH1", gas: 100, stack: [] },
        { depth: 1, pc: 10, op: "CALL", gas: 90, stack: ["0x0", "0x0", "0x0", "0x0", "0x0", word(callee), "0xffff"] },
        { depth: 2, pc: 0, op: "PUSH1", gas: 80, stack: [] },
        { depth: 2, pc: 5, op: "REVERT", gas: 70, stack: [] },
        { depth: 1, pc: 11, op: "REVERT", gas: 60, stack: [] },
      ],
    };
    const s = diag.summariseTrace(trace);
    expect(s.firstRevert).to.include({ op: "REVERT", depth: 2, pc: 5 });
    expect(s.stoppedOn).to.include({ op: "REVERT", depth: 1, pc: 11 });
    expect(s.openFrames).to.deep.equal([{ op: "CALL", to: hre.ethers.getAddress(callee), depth: 2, pc: 10, gas: 90 }]);
  });

  it("sees a failed hook or test anywhere in a suite tree", function () {
    expect(diag.suiteHasFailure({ tests: [{ state: "passed" }], suites: [] })).to.equal(false);
    expect(diag.suiteHasFailure({ tests: [], suites: [{ tests: [{ state: "failed" }] }] })).to.equal(true);
    expect(diag.suiteHasFailure({ _beforeAll: [{ state: "failed" }], tests: [] })).to.equal(true);
  });
});
