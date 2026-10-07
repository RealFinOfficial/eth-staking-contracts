// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseForge} from "../utils/BaseForge.sol";
import {RewardsDistributor} from "../../../contracts/lp-staking/RewardsDistributor.sol";
import {IRewardsDistributor} from "../../../contracts/lp-staking/interfaces/IRewardsDistributor.sol";
import {MockERC20Permit} from "../../../contracts/lp-staking/mocks/MockERC20Permit.sol";

/**
 * @notice Why this file exists: the backend signs `RewardClaim` vouchers with ethers/eth-account
 *         and the frontend decodes them, in other repositories, with other libraries. The only
 *         way those three can agree is a GOLDEN VECTOR — one fixed key, one fixed domain, one
 *         fixed message, one fixed signature — that the contract itself is shown to accept.
 *
 *  The vector below was produced with ethers v6.16.0 (`wallet.signTypedData`) and is published
 *  in the lane-1 interface freeze (`INTERFACE.md` §2.2). This file deploys the distributor proxy
 *  AT the vector's `verifyingContract` (0x1111…1111), puts a reward token AT the vector's `token`
 *  (0x2222…2222), sets the chain id, and redeems the exact signature bytes. If the contract's
 *  type string, domain or digest ever drifted, this test fails — and so would every voucher the
 *  backend signs.
 *
 *    signer key   0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
 *                 (Hardhat account #0, a PUBLIC TEST KEY — never a production key)
 *    signer       0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
 *    domain       ("RealLPRewards", "1", chainId, 0x1111111111111111111111111111111111111111)
 *    message      token 0x2222…2222, user 0x3333…3333, cumulativeAmount 1234500000000000000000,
 *                 deadline 1791331200 (2026-10-07T00:00:00Z)
 */
contract RewardClaimGoldenVectorTest is BaseForge {
    address internal constant DISTRIBUTOR_AT = 0x1111111111111111111111111111111111111111;
    address internal constant TOKEN_AT = 0x2222222222222222222222222222222222222222;
    address internal constant USER = 0x3333333333333333333333333333333333333333;
    address internal constant GOLDEN_SIGNER = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    uint256 internal constant GOLDEN_SIGNER_PK = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 internal constant CUMULATIVE = 1234500000000000000000;
    uint256 internal constant DEADLINE = 1791331200;

    bytes32 internal constant GOLDEN_TYPEHASH = 0x746a03cb3aaddb17f8408279b7ff5133a65d78143d19fbd50c05d05bca850c63;
    bytes32 internal constant GOLDEN_STRUCT_HASH = 0x4eaf64b4fe0098dd640da7a5c528f85f6e5d8ed6f65f292b60a9d9065bfef584;

    bytes32 internal constant MAINNET_DOMAIN = 0x85b58a2464a6bbaeeaa741942d9fe25cdc3afca3c56c86fe12d8527ea9a792c5;
    bytes32 internal constant MAINNET_DIGEST = 0x97f5d34cfb470872d8a84efb208bb80e466482eaf92e8f73e341d6e948383352;
    bytes internal constant MAINNET_SIGNATURE =
        hex"bf7b1e4944b2063978769fd2859cb15b8f458299b89a2d2c05be3bf5d58b9aa21562c9a4700a2db4e1a86c42932e26b9c32cc5c90afbfffcedf0d784549262f61c";

    bytes32 internal constant SEPOLIA_DOMAIN = 0x823c6e07a16baeb83007f41b3ae4d1279a0bc9506c2152a284c8e4d9e8e11a4b;
    bytes32 internal constant SEPOLIA_DIGEST = 0xbe96070ef3d2f79552fb64236de83d4967f809706d43bd933e7fa7b6f1692582;
    bytes internal constant SEPOLIA_SIGNATURE =
        hex"e1e7c86fe7e8d1a4ab83123a4ee71e121957dcb403955fcb6a582ab460e152cd5d6f09318e0b9cb340ff29b47639780e0a249a22848d358157cc458928c330b71b";

    // ──────────────────────── The type ─────────────────────────

    /// @dev The type string, its hash and the contract's constant are one and the same thing.
    function test_Golden_TheTypehashIsTheFrozenOne() public {
        RewardsDistributor d = _deployGolden(1);
        assertEq(
            keccak256("RewardClaim(address token,address user,uint256 cumulativeAmount,uint256 deadline)"),
            GOLDEN_TYPEHASH,
            "the type string must hash to the frozen typehash"
        );
        assertEq(d.REWARD_CLAIM_TYPEHASH(), GOLDEN_TYPEHASH, "and the contract must carry exactly it");
        assertEq(
            keccak256(abi.encode(GOLDEN_TYPEHASH, TOKEN_AT, USER, CUMULATIVE, DEADLINE)),
            GOLDEN_STRUCT_HASH,
            "the struct hash of the golden message"
        );
    }

    // ──────────────────────── Mainnet (chain id 1) ─────────────

    function test_Golden_Mainnet_DomainAndDigestMatchTheVector() public {
        RewardsDistributor d = _deployGolden(1);

        (, string memory name_, string memory version_, uint256 chainId_, address verifying_,,) = d.eip712Domain();
        assertEq(name_, "RealLPRewards", "domain name");
        assertEq(version_, "1", "domain version");
        assertEq(chainId_, 1, "domain chain id");
        assertEq(verifying_, DISTRIBUTOR_AT, "domain verifying contract = the proxy");

        assertEq(_domainSeparatorOf(d), MAINNET_DOMAIN, "domain separator of the vector");
        assertEq(_rewardClaimDigest(d, TOKEN_AT, USER, CUMULATIVE, DEADLINE), MAINNET_DIGEST, "digest of the vector");
    }

    /// @dev The decisive check: the contract accepts the exact bytes the vector publishes.
    function test_Golden_Mainnet_TheContractRedeemsTheExactSignature() public {
        RewardsDistributor d = _deployGolden(1);

        vm.expectEmit(true, true, false, true, DISTRIBUTOR_AT);
        emit IRewardsDistributor.Claimed(USER, TOKEN_AT, CUMULATIVE, CUMULATIVE, block.timestamp);
        vm.prank(USER);
        uint256 paid = d.claim(TOKEN_AT, CUMULATIVE, DEADLINE, MAINNET_SIGNATURE);

        assertEq(paid, CUMULATIVE, "the whole cumulative is paid on the first claim");
        assertEq(d.claimed(TOKEN_AT, USER), CUMULATIVE, "and recorded on the token's ledger");
        assertEq(MockERC20Permit(TOKEN_AT).balanceOf(USER), CUMULATIVE, "and transferred to the user");
    }

    /// @dev Foundry's own signer, given the same key and digest, reproduces the published bytes —
    ///      RFC 6979 makes ECDSA deterministic, so the vector is a function of its inputs alone.
    function test_Golden_Mainnet_TheSignatureIsReproducibleFromTheKey() public {
        RewardsDistributor d = _deployGolden(1);
        assertEq(vm.addr(GOLDEN_SIGNER_PK), GOLDEN_SIGNER, "the key belongs to the golden signer");

        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(GOLDEN_SIGNER_PK, _rewardClaimDigest(d, TOKEN_AT, USER, CUMULATIVE, DEADLINE));
        assertEq(abi.encodePacked(r, s, v), MAINNET_SIGNATURE, "the published signature, byte for byte");
    }

    // ──────────────────────── Sepolia (chain id 11155111) ──────

    function test_Golden_Sepolia_DomainDigestAndRedemption() public {
        RewardsDistributor d = _deployGolden(11155111);

        assertEq(_domainSeparatorOf(d), SEPOLIA_DOMAIN, "domain separator of the Sepolia vector");
        assertEq(_rewardClaimDigest(d, TOKEN_AT, USER, CUMULATIVE, DEADLINE), SEPOLIA_DIGEST, "digest");

        vm.prank(USER);
        assertEq(d.claim(TOKEN_AT, CUMULATIVE, DEADLINE, SEPOLIA_SIGNATURE), CUMULATIVE, "redeemed on Sepolia");
    }

    /// @dev The chain id is part of the domain: the mainnet bytes are worthless on Sepolia.
    function test_Golden_TheMainnetSignatureIsWorthlessOnSepolia() public {
        RewardsDistributor d = _deployGolden(11155111);

        vm.prank(USER);
        vm.expectPartialRevert(IRewardsDistributor.InvalidSignature.selector);
        d.claim(TOKEN_AT, CUMULATIVE, DEADLINE, MAINNET_SIGNATURE);
    }

    /// @dev The deadline is signed: one second past it, the same bytes are refused as expired.
    function test_Golden_TheVectorExpiresAtItsDeadline() public {
        RewardsDistributor d = _deployGolden(1);
        vm.warp(DEADLINE + 1);

        vm.prank(USER);
        vm.expectRevert(abi.encodeWithSelector(IRewardsDistributor.ClaimExpired.selector, DEADLINE, DEADLINE + 1));
        d.claim(TOKEN_AT, CUMULATIVE, DEADLINE, MAINNET_SIGNATURE);
    }

    // ──────────────────────── Helpers ──────────────────────────

    /**
     * @dev Puts the stack exactly where the vector says it is: a funded 18-decimal reward token
     *      at 0x2222…2222 and the distributor PROXY at 0x1111…1111 (deployed with `deployCodeTo`,
     *      which runs the proxy's constructor — and with it `initialize` — at that address), on
     *      the given chain id, before the deadline.
     */
    function _deployGolden(uint256 chainId_) private returns (RewardsDistributor d) {
        vm.chainId(chainId_);
        vm.warp(DEADLINE - 1 days);

        MockERC20Permit template = new MockERC20Permit("Overture", "OVTR", 0, 18);
        vm.etch(TOKEN_AT, address(template).code);
        // The etched code is the template's runtime; its storage at TOKEN_AT starts empty, so the
        // balance is written directly. name/symbol read empty strings there, which the
        // distributor accepts — only `decimals()` (immutable in the bytecode) and the balance
        // matter to a claim.
        deal(TOKEN_AT, DISTRIBUTOR_AT, CUMULATIVE * 2);

        RewardsDistributor impl = new RewardsDistributor();
        IRewardsDistributor.RewardTokenInit[] memory tokens = new IRewardsDistributor.RewardTokenInit[](1);
        tokens[0] = IRewardsDistributor.RewardTokenInit({token: TOKEN_AT, conditional: false, claimsEnabled: true});
        bytes memory init = abi.encodeCall(
            RewardsDistributor.initialize,
            (address(this), address(this), address(this), GOLDEN_SIGNER, makeAddr("asset"), tokens)
        );
        deployCodeTo("LPProxy.sol:LPProxy", abi.encode(address(impl), init), DISTRIBUTOR_AT);
        d = RewardsDistributor(DISTRIBUTOR_AT);

        assertEq(d.signer(), GOLDEN_SIGNER, "precondition: the proxy is initialised with the golden signer");
    }
}
