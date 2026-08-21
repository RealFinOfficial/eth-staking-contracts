/**
 * EIP-712 signing for the local-fork suite: ERC-2612 token permits, the position
 * manager's ERC-721 permit, and the back office's claim vouchers.
 *
 * Copied from test/lp-staking/fork/LPStakingFork.test.js L439–518 — keep in sync — with
 * the provider passed in instead of read off the Hardhat Runtime Environment.
 */

const ethers = require("ethers");

const {
  LOCAL_CHAIN_ID,
  ERC20_ABI,
  NPM_ABI,
  NFT_PERMIT_NAME,
  NFT_PERMIT_VERSION,
  FAR_DEADLINE,
} = require("./constants");

/** Field list of both claim legs; order and names must match the on-chain type strings. */
const CLAIM_FIELDS = [
  { name: "user", type: "address" },
  { name: "cumulativeAmount", type: "uint256" },
  { name: "deadline", type: "uint256" },
];

const ERC2612_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

const NFT_PERMIT_TYPES = {
  Permit: [
    { name: "spender", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

/**
 * Resolves the EIP-712 domain a contract actually uses by matching a candidate against its
 * on-chain DOMAIN_SEPARATOR. Needed because the fork reports chain id 31337 while some
 * contracts keep a separator cached from the chain they were deployed on and others
 * recompute it from `block.chainid`. Throws when no candidate matches, which is exactly the
 * signal that the documented name/version is wrong.
 *
 * Candidates, in order: 31337 (recomputed on the fork) -> the forked chain's real id
 * (cached before the fork) -> 1. The third is kept even for a Sepolia profile because it
 * costs one hash and it is the value every mainnet-born token caches — both real ASSET and
 * real USDC do exactly that at block 25,750,000.
 *
 * @param {object} provider
 * @param {string} address
 * @param {string} name
 * @param {string} version
 * @param {bigint} [profileChainId] Real chain id of the chain being forked.
 */
async function resolveDomain(provider, address, name, version, profileChainId) {
  const probe = new ethers.Contract(address, ERC20_ABI, provider);
  const onChain = await probe.DOMAIN_SEPARATOR();
  const candidates = [LOCAL_CHAIN_ID];
  if (profileChainId !== undefined && profileChainId !== null) candidates.push(BigInt(profileChainId));
  candidates.push(1n);

  for (const candidate of candidates) {
    const domain = { name, version, chainId: candidate, verifyingContract: address };
    if (ethers.TypedDataEncoder.hashDomain(domain) === onChain) return { domain, onChain };
  }
  throw new Error(
    `EIP-712 domain mismatch at ${address} for name="${name}" version="${version}": on-chain ${onChain}`
  );
}

async function signErc2612({
  provider,
  token,
  tokenName,
  tokenVersion,
  owner,
  spender,
  value,
  deadline,
  profileChainId,
}) {
  const address = await token.getAddress();
  const { domain } = await resolveDomain(provider, address, tokenName, tokenVersion, profileChainId);
  const nonce = await token.nonces(owner.address);
  const signature = await owner.signTypedData(domain, ERC2612_TYPES, {
    owner: owner.address,
    spender,
    value,
    nonce,
    deadline,
  });
  return ethers.Signature.from(signature);
}

async function signNftPermit({
  provider,
  npmAddress,
  owner,
  spender,
  tokenId,
  deadline,
  permitName = NFT_PERMIT_NAME,
  permitVersion = NFT_PERMIT_VERSION,
  profileChainId,
}) {
  const { domain } = await resolveDomain(
    provider,
    npmAddress,
    permitName,
    permitVersion,
    profileChainId
  );
  const npm = new ethers.Contract(npmAddress, NPM_ABI, provider);
  const nonce = (await npm.positions(tokenId)).nonce;
  const signature = await owner.signTypedData(domain, NFT_PERMIT_TYPES, {
    spender,
    tokenId,
    nonce,
    deadline,
  });
  return ethers.Signature.from(signature);
}

/**
 * The EIP-712 domain a deployed contract reports for itself (ERC-5267). The distributor is
 * deployed by this run, so its domain — chain id included, which is the fork's, not
 * mainnet's — is only knowable at runtime.
 */
async function readEip712Domain(contract) {
  const d = await contract.eip712Domain();
  return {
    name: d.name,
    version: d.version,
    chainId: d.chainId,
    verifyingContract: d.verifyingContract,
  };
}

/**
 * The back office attesting a lifetime entitlement, as it would in production.
 *
 * @param {"TokenXClaim"|"AssetClaim"} leg Struct name of the reward leg. The two type
 *   strings differ by exactly this name, which is what stops a voucher for one leg from
 *   being spent on the other — see RewardsDistributor.TOKENX_CLAIM_TYPEHASH /
 *   ASSET_CLAIM_TYPEHASH.
 */
async function signVoucher({ signer, domain, leg, user, cumulativeAmount, deadline = FAR_DEADLINE }) {
  if (leg !== "TokenXClaim" && leg !== "AssetClaim") {
    throw new Error(`unknown voucher leg ${leg}`);
  }
  return signer.signTypedData(
    domain,
    { [leg]: CLAIM_FIELDS },
    { user, cumulativeAmount, deadline }
  );
}

/** The type hash the contract must be using, recomputed from the struct definition. */
function claimTypeHash(leg) {
  return ethers.id(`${leg}(address user,uint256 cumulativeAmount,uint256 deadline)`);
}

module.exports = {
  resolveDomain,
  signErc2612,
  signNftPermit,
  readEip712Domain,
  signVoucher,
  claimTypeHash,
};
