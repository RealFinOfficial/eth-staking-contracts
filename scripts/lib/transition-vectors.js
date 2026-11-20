const hre = require("hardhat");

// The transition's shared constants and test vectors for the other repositories (the backend, the
// frontend, the indexer): spec 01 §9.3.1 (the receiving address) and §9.4.1 (the delivery voucher).
// Built from the COMPILED contracts on the in-process Hardhat network, never typed by hand:
//
//   - `holderInitCodeHash` and `holderCreationCode` are read from the TransitionReceiver's own
//     constants (its runtime is placed with `hardhat_setCode`, so nothing is deployed or sent);
//   - every CREATE2 vector is computed with ethers AND read back from `receivingAddressOf` of a
//     receiver runtime placed at the vector's receiver address, so the two must agree;
//   - every DeliveryVoucher vector is hashed with ethers' EIP-712 encoder and signed with Hardhat's
//     well-known account #0 key (public, test only), deterministically (RFC 6979).
//
// `scripts/export-transition-artifacts.js` writes the result to test/vectors/transition.json, and
// test/staking-v3/TransitionVectors.test.js fails when the committed file differs from a fresh build.

/** Hardhat's account #0: a PUBLIC test key, printed by every `hardhat node`. Never holds value. */
const PUBLIC_TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const DELIVERY_VOUCHER_TYPE =
  "DeliveryVoucher(address holder,uint8 route,uint256 eligiblePrincipal,uint256 eligibleReward,uint256 assetLimit,uint256 usdcLimit,uint256 burnTime,uint256 nonce,uint256 deadline)";

const DELIVERY_TYPES = {
  DeliveryVoucher: [
    { name: "holder", type: "address" },
    { name: "route", type: "uint8" },
    { name: "eligiblePrincipal", type: "uint256" },
    { name: "eligibleReward", type: "uint256" },
    { name: "assetLimit", type: "uint256" },
    { name: "usdcLimit", type: "uint256" },
    { name: "burnTime", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

/** Fixed inputs. Addresses are arbitrary but fixed, so the vectors never move. */
const CREATE2_INPUTS = [
  {
    receiver: "0x1000000000000000000000000000000000000001",
    holder: "0x00000000000000000000000000000000000A11cE",
    route: 1,
  },
  {
    receiver: "0x1000000000000000000000000000000000000001",
    holder: "0x00000000000000000000000000000000000A11cE",
    route: 2,
  },
  {
    receiver: "0x1000000000000000000000000000000000000001",
    holder: "0x00000000000000000000000000000000000A11cE",
    route: 3,
  },
  {
    receiver: "0x2000000000000000000000000000000000000002",
    holder: "0x0000000000000000000000000000000000000BEE",
    route: 2,
  },
];

const VOUCHER_MIGRATOR = "0x3000000000000000000000000000000000000003";
const VOUCHER_MESSAGE = {
  holder: "0x00000000000000000000000000000000000A11cE",
  route: 2,
  eligiblePrincipal: "20000000000000000000000",
  eligibleReward: "1000000000",
  assetLimit: "12000000000000000000000",
  usdcLimit: "1000000000",
  burnTime: "1763600000",
  nonce: "1",
  deadline: "1763686400",
};

/** Places `name`'s runtime at `address` on the in-process network (no transaction). */
async function placeRuntime(name, address) {
  const artifact = await hre.artifacts.readArtifact(name);
  await hre.network.provider.send("hardhat_setCode", [address, artifact.deployedBytecode]);
  return new hre.ethers.Contract(address, artifact.abi, hre.ethers.provider);
}

async function buildVectors() {
  if (hre.network.name !== "hardhat") {
    throw new Error("The transition vectors are built on the in-process hardhat network only");
  }
  const { ethers } = hre;
  const scratch = "0x00000000000000000000000000000000000000f1";
  const receiver = await placeRuntime("TransitionReceiver", scratch);
  const holderInitCodeHash = await receiver.HOLDER_INIT_CODE_HASH();
  const holderCreationCode = await receiver.HOLDER_CREATION_CODE();
  if (ethers.keccak256(holderCreationCode) !== holderInitCodeHash) {
    throw new Error("HOLDER_INIT_CODE_HASH is not keccak256(HOLDER_CREATION_CODE)");
  }

  const create2 = [];
  for (const input of CREATE2_INPUTS) {
    const salt = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint8"], [input.holder, input.route]));
    const receivingAddress = ethers.getCreate2Address(input.receiver, salt, holderInitCodeHash);
    const placed = await placeRuntime("TransitionReceiver", input.receiver);
    const onChain = await placed.receivingAddressOf(input.holder, input.route);
    if (onChain !== receivingAddress) {
      throw new Error(`receivingAddressOf disagrees with CREATE2 for ${JSON.stringify(input)}`);
    }
    create2.push({ ...input, salt, receivingAddress });
  }

  const wallet = new ethers.Wallet(PUBLIC_TEST_KEY);
  const typeHash = ethers.id(DELIVERY_VOUCHER_TYPE);
  const deliveryVoucher = [];
  for (const chainId of [43114, 43113]) {
    const domain = { name: "StakingMigrator", version: "1", chainId, verifyingContract: VOUCHER_MIGRATOR };
    const domainSeparator = ethers.TypedDataEncoder.hashDomain(domain);
    const structHash = ethers.TypedDataEncoder.from(DELIVERY_TYPES).hash(VOUCHER_MESSAGE);
    const digest = ethers.TypedDataEncoder.hash(domain, DELIVERY_TYPES, VOUCHER_MESSAGE);
    const signature = await wallet.signTypedData(domain, DELIVERY_TYPES, VOUCHER_MESSAGE);
    if (ethers.verifyTypedData(domain, DELIVERY_TYPES, VOUCHER_MESSAGE, signature) !== wallet.address) {
      throw new Error("the vector signature does not recover the test key");
    }
    deliveryVoucher.push({ domain, domainSeparator, message: VOUCHER_MESSAGE, structHash, digest, signer: wallet.address, signature });
  }

  return {
    description:
      "Transition vectors (spec 01 §9.3.1 and §9.4.1), generated from the compiled contracts by " +
      "scripts/export-transition-artifacts.js; checked by test/staking-v3/TransitionVectors.test.js. The signer " +
      "key is Hardhat's public account #0 key: TEST ONLY.",
    holderInitCodeHash,
    holderCreationCode,
    receivingAddress: {
      formula:
        "address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), receiverProxy, " +
        "keccak256(abi.encode(holder, uint8(route))), HOLDER_INIT_CODE_HASH)))))",
      vectors: create2,
    },
    deliveryVoucher: {
      typeString: DELIVERY_VOUCHER_TYPE,
      typeHash,
      types: DELIVERY_TYPES,
      vectors: deliveryVoucher,
    },
  };
}

/** The ABIs the indexer needs, as the plain arrays `abi/*.json` already holds. */
const EXPORTED_ABIS = ["TransitionReceiver", "StakingMigrator", "BurnStandIn", "PayoutStandIn"];

async function exportedAbis() {
  const out = {};
  for (const name of EXPORTED_ABIS) out[name] = (await hre.artifacts.readArtifact(name)).abi;
  return out;
}

module.exports = { buildVectors, exportedAbis, EXPORTED_ABIS, DELIVERY_TYPES, DELIVERY_VOUCHER_TYPE, PUBLIC_TEST_KEY };
