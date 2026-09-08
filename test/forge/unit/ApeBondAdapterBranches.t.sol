// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LocalHarness} from "../utils/LocalHarness.sol";
import {ApeBondPositionAdapter} from "../../../contracts/lp-staking/ApeBondPositionAdapter.sol";
import {BonusEscrow} from "../../../contracts/lp-staking/BonusEscrow.sol";
import {LPStakingVault} from "../../../contracts/lp-staking/LPStakingVault.sol";
import {MockSoulZapCaller} from "../../../contracts/lp-staking/mocks/MockSoulZapCaller.sol";
import {MockPositionManager} from "../../../contracts/lp-staking/mocks/MockPositionManager.sol";
import {MockERC20Permit} from "../../../contracts/lp-staking/mocks/MockERC20Permit.sol";
import {MisreportingVault} from "../utils/attackers/MisreportingVault.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @notice Why this file exists: {ApeBondPositionAdapter-depositFor} is one ordered checklist
 *         and nothing else. Every line of it is a rejection a happy-path test steps straight
 *         over, and each rejection is one assertion here — by selector and by the values the
 *         error carries, because "it reverted" is not the same claim as "it reverted for the
 *         reason the spec names" (§10 lists the reasons one by one).
 *
 *  The fuzzed ones (`testFuzz_` prefix, the repo's marker) take the three checks that are
 *  inequalities rather than equalities — the exact range, the liquidity floor and the deadline
 *  — and let the runner pick the numbers around each boundary.
 *
 *  The adapter and its escrow are stood up per test rather than pulled out of {LocalHarness}:
 *  they are a second deposit route bolted beside the four LP contracts, not part of them, and
 *  the harness is used for its actors, its market and its vault proxy.
 *
 *  `soulZap` is a {MockSoulZapCaller}, not an EOA, because every caller-side check the adapter
 *  makes is about a contract that holds the freshly minted NFT, approves the adapter and calls
 *  in the same transaction. `carol` is the beneficiary throughout, so "the buyer got it" is
 *  never satisfied by the buyer happening to be the caller.
 */
contract ApeBondAdapterBranchesTest is LocalHarness {
    ApeBondPositionAdapter internal adapter;
    BonusEscrow internal escrow;
    MockSoulZapCaller internal soulZap;
    /// @dev The bonus is a token of its own: §6.3 forbids the escrow from sharing balances with
    ///      the vault or the distributor, and a third token is how a test can tell them apart.
    MockERC20Permit internal bonusToken;

    address internal purchaseSigner;
    uint256 internal purchaseSignerPk;

    uint256 internal constant ESCROW_FUNDING = 1_000e18;
    uint256 internal constant BONUS = 100e18;
    uint128 internal constant MIN_LIQUIDITY = 500_000;
    uint64 internal constant CLIFF = 30 days;
    uint24 internal constant OTHER_FEE = 500;

    bytes32 internal constant PURCHASE = keccak256("apebond-purchase-1");
    bytes32 internal constant CAMPAIGN = keccak256("apebond-campaign-1");
    bytes32 internal constant REQUEST = keccak256("soulzap-request-1");

    uint256 internal constant GROSS_INPUT = 1_000e6;
    uint256 internal constant NET_INPUT = 990e6;

    function setUp() public {
        _deployLocalStack();
        vm.warp(1_000_000);

        (purchaseSigner, purchaseSignerPk) = makeAddrAndKey("purchaseSigner");

        bonusToken = new MockERC20Permit("Bonus", "BONUS", 10_000_000e18, 18);
        escrow = _deployBonusEscrowProxy(address(bonusToken), address(this), address(0));
        bonusToken.transfer(address(escrow), ESCROW_FUNDING);

        adapter = _deployAdapter(address(vault), address(escrow), token0, token1, FEE);
        soulZap = new MockSoulZapCaller();

        vault.setStakeOperator(address(adapter), true);
        escrow.setAdapter(address(adapter));
        adapter.setSoulZapCaller(address(soulZap), true);
    }

    // ──────────────────────── Harness helpers ──────────────────

    function _deployAdapter(address vault_, address escrow_, address t0, address t1, uint24 fee_)
        internal
        returns (ApeBondPositionAdapter)
    {
        return new ApeBondPositionAdapter(
            address(npmMock), vault_, escrow_, t0, t1, fee_, address(this), multisig, purchaseSigner
        );
    }

    /// @dev One campaign purchase with every field at its default. Tests mutate the copy.
    function _auth() internal view returns (ApeBondPositionAdapter.PurchaseAuthorization memory) {
        return ApeBondPositionAdapter.PurchaseAuthorization({
            purchaseId: PURCHASE,
            campaignId: CAMPAIGN,
            soulZapRequestId: REQUEST,
            beneficiary: carol,
            soulZapCaller: address(soulZap),
            inputToken: address(usdcToken),
            grossInputAmount: GROSS_INPUT,
            netInputAmount: NET_INPUT,
            guaranteedBonusAmount: BONUS,
            bonusUnlockAt: uint64(block.timestamp) + CLIFF,
            minLiquidity: MIN_LIQUIDITY,
            expectedTickLower: TICK_LOWER,
            expectedTickUpper: TICK_UPPER,
            nonce: 1,
            deadline: FAR_DEADLINE
        });
    }

    function _position(int24 tickLower, int24 tickUpper, uint128 liquidity) internal returns (uint256) {
        return _createPositionOn(address(soulZap), token0, token1, FEE, tickLower, tickUpper, liquidity, 0, 0);
    }

    function _defaultPosition() internal returns (uint256) {
        return _position(TICK_LOWER, TICK_UPPER, LIQUIDITY);
    }

    function _deposit(uint256 tokenId, ApeBondPositionAdapter.PurchaseAuthorization memory authorization) internal {
        _depositSignedBy(purchaseSignerPk, tokenId, authorization);
    }

    function _depositSignedBy(
        uint256 pk,
        uint256 tokenId,
        ApeBondPositionAdapter.PurchaseAuthorization memory authorization
    ) internal {
        soulZap.deposit(
            adapter, address(npmMock), tokenId, authorization, _signPurchaseAuthorization(pk, adapter, authorization)
        );
    }

    // ──────────────────────── Deployment ───────────────────────

    function test_Constructor_RejectsEveryZeroReference() public {
        vm.expectRevert(ApeBondPositionAdapter.ZeroAddress.selector);
        new ApeBondPositionAdapter(
            address(0), address(vault), address(escrow), token0, token1, FEE, address(this), multisig, purchaseSigner
        );

        vm.expectRevert(ApeBondPositionAdapter.ZeroAddress.selector);
        new ApeBondPositionAdapter(
            address(npmMock), address(0), address(escrow), token0, token1, FEE, address(this), multisig, purchaseSigner
        );

        vm.expectRevert(ApeBondPositionAdapter.ZeroAddress.selector);
        new ApeBondPositionAdapter(
            address(npmMock), address(vault), address(0), token0, token1, FEE, address(this), multisig, purchaseSigner
        );

        vm.expectRevert(ApeBondPositionAdapter.ZeroAddress.selector);
        new ApeBondPositionAdapter(
            address(npmMock),
            address(vault),
            address(escrow),
            address(0),
            token1,
            FEE,
            address(this),
            multisig,
            purchaseSigner
        );

        vm.expectRevert(ApeBondPositionAdapter.ZeroAddress.selector);
        new ApeBondPositionAdapter(
            address(npmMock),
            address(vault),
            address(escrow),
            token0,
            address(0),
            FEE,
            address(this),
            multisig,
            purchaseSigner
        );

        vm.expectRevert(ApeBondPositionAdapter.ZeroAddress.selector);
        new ApeBondPositionAdapter(
            address(npmMock),
            address(vault),
            address(escrow),
            token0,
            token1,
            FEE,
            address(this),
            address(0),
            purchaseSigner
        );
    }

    function test_Constructor_RejectsAnUnsortedPair() public {
        vm.expectRevert(abi.encodeWithSelector(ApeBondPositionAdapter.TokensNotSorted.selector, token1, token0));
        _deployAdapter(address(vault), address(escrow), token1, token0, FEE);
    }

    /// @dev Zero is allowed for the signer alone, and it is the wind-down state rather than a
    ///      misconfiguration: the adapter deploys with the deposit path closed.
    function test_Constructor_AcceptsAnUnsetSignerAndKeepsThePathClosed() public {
        ApeBondPositionAdapter closed = new ApeBondPositionAdapter(
            address(npmMock), address(vault), address(escrow), token0, token1, FEE, address(this), multisig, address(0)
        );
        assertEq(closed.purchaseSigner(), address(0), "the path must start closed");
    }

    function test_Constructor_PinsEveryImmutableAndBothRoles() public view {
        assertEq(address(adapter.positionManager()), address(npmMock), "position manager");
        assertEq(address(adapter.vault()), address(vault), "vault");
        assertEq(address(adapter.escrow()), address(escrow), "escrow");
        assertEq(adapter.token0(), token0, "token0");
        assertEq(adapter.token1(), token1, "token1");
        assertEq(adapter.fee(), FEE, "fee");
        assertEq(adapter.owner(), address(this), "owner");
        assertEq(adapter.guardian(), multisig, "guardian");
        assertEq(adapter.purchaseSigner(), purchaseSigner, "purchase signer");
        assertFalse(adapter.depositsPaused(), "deposits must start open");
    }

    // ──────────────────────── The typed data ───────────────────

    /// @dev The harness signs against a recomputed domain; this is the assertion that the
    ///      contract really declares the one it recomputes — chain id and address included.
    function test_Domain_IsTheDeclaredOne() public view {
        (, string memory name_, string memory version_, uint256 chainId_, address verifying_,,) = adapter.eip712Domain();

        assertEq(name_, APE_BOND_DOMAIN_NAME, "domain name");
        assertEq(version_, APE_BOND_DOMAIN_VERSION, "domain version");
        assertEq(chainId_, block.chainid, "domain chain id");
        assertEq(verifying_, address(adapter), "domain verifying contract");
        assertTrue(
            keccak256(bytes(name_)) != keccak256("RealLPRewards"),
            "the purchase domain must not be the rewards-voucher domain"
        );
    }

    function test_Typehash_MatchesTheStructDefinition() public view {
        assertEq(
            adapter.PURCHASE_AUTHORIZATION_TYPEHASH(),
            PURCHASE_AUTHORIZATION_TYPEHASH,
            "the adapter's typehash must be the one the harness signs against"
        );
    }

    /**
     * @dev The contract splits its `abi.encode` in two to fit the stack; this recomputes the
     *      same struct hash the reference way — one `abi.encode` of the whole static struct —
     *      and asserts the two are the same 32 bytes. Every other test in this file signs
     *      through {LocalHarness-_purchaseDigest}, so a divergence here would fail all of them
     *      too; this one names it.
     */
    function test_Digest_MatchesTheReferenceEncoding() public view {
        ApeBondPositionAdapter.PurchaseAuthorization memory authorization = _auth();
        assertEq(
            adapter.hashPurchaseAuthorization(authorization),
            _purchaseDigest(adapter, authorization),
            "the adapter's digest must equal the reference encoding"
        );
    }

    /// @dev The domain binds the chain and the contract, so a sibling adapter's signature is
    ///      worthless here — which is what makes a second campaign deployment safe.
    function test_Digest_IsBoundToThisAdapter() public {
        ApeBondPositionAdapter sibling = _deployAdapter(address(vault), address(escrow), token0, token1, FEE);
        ApeBondPositionAdapter.PurchaseAuthorization memory authorization = _auth();

        assertTrue(
            adapter.hashPurchaseAuthorization(authorization) != sibling.hashPurchaseAuthorization(authorization),
            "two adapters must not share a digest"
        );

        uint256 tokenId = _defaultPosition();
        bytes memory foreign = _signPurchaseAuthorization(purchaseSignerPk, sibling, authorization);
        vm.expectRevert();
        soulZap.deposit(adapter, address(npmMock), tokenId, authorization, foreign);
    }

    // ──────────────────────── The happy path ───────────────────

    function test_DepositFor_StakesReservesAndKeepsNothing() public {
        uint256 tokenId = _defaultPosition();
        ApeBondPositionAdapter.PurchaseAuthorization memory authorization = _auth();

        _deposit(tokenId, authorization);

        assertEq(npmMock.ownerOf(tokenId), address(vault), "the vault must end up with the NFT");
        assertEq(vault.stakerOf(tokenId), carol, "and the buyer must be its staker");
        (address beneficiary, uint256 amount,, bool claimed) = escrow.reservationOf(PURCHASE);
        assertEq(beneficiary, carol, "the bonus is the buyer's");
        assertEq(amount, BONUS, "and it is the signed amount");
        assertFalse(claimed, "and it is not paid yet");
        assertTrue(adapter.consumedPurchaseIds(PURCHASE), "the purchase id is spent");
        assertTrue(adapter.consumedNonces(1), "and so is the nonce");
        assertEq(npmMock.balanceOf(address(adapter)), 0, "the adapter must hold no NFT");
        assertEq(bonusToken.balanceOf(address(adapter)), 0, "and no bonus token");
        assertEq(asset.balanceOf(address(adapter)), 0, "and no pair token");
        assertEq(usdcToken.balanceOf(address(adapter)), 0, "nor the other side of the pair");
    }

    /// @dev A campaign with no extra payout must still be routable: {BonusEscrow-reserve}
    ///      rejects a zero amount, so the leg is skipped rather than made impossible.
    function test_DepositFor_SkipsTheEscrowForAZeroBonus() public {
        uint256 tokenId = _defaultPosition();
        ApeBondPositionAdapter.PurchaseAuthorization memory authorization = _auth();
        authorization.guaranteedBonusAmount = 0;

        _deposit(tokenId, authorization);

        assertEq(vault.stakerOf(tokenId), carol, "the position still lands");
        assertEq(escrow.totalReserved(), 0, "and nothing is reserved");
        (address beneficiary,,,) = escrow.reservationOf(PURCHASE);
        assertEq(beneficiary, address(0), "the escrow's book stays free of empty rows");
        assertTrue(adapter.consumedPurchaseIds(PURCHASE), "the id is spent all the same");
    }

    function test_DepositFor_AcceptsAnOperatorForAllApproval() public {
        soulZap.setApprovalMode(MockSoulZapCaller.Approval.OperatorForAll);
        uint256 tokenId = _defaultPosition();

        _deposit(tokenId, _auth());

        assertEq(vault.stakerOf(tokenId), carol, "operator approval is enough");
    }

    // ──────────────────────── Checklist rejections ─────────────

    function test_DepositFor_RevertsWhileTheAdaptersDepositsArePaused() public {
        vm.prank(multisig);
        adapter.setDepositsPaused(true);
        uint256 tokenId = _defaultPosition();

        vm.expectRevert(ApeBondPositionAdapter.DepositsArePaused.selector);
        _deposit(tokenId, _auth());
    }

    function test_DepositFor_RevertsForACallerOffTheAllowlist() public {
        adapter.setSoulZapCaller(address(soulZap), false);
        uint256 tokenId = _defaultPosition();

        vm.expectRevert(abi.encodeWithSelector(ApeBondPositionAdapter.NotSoulZapCaller.selector, address(soulZap)));
        _deposit(tokenId, _auth());
    }

    function test_DepositFor_RevertsWhenTheAuthorizationNamesAnotherCaller() public {
        adapter.setSoulZapCaller(stranger, true);
        uint256 tokenId = _defaultPosition();
        ApeBondPositionAdapter.PurchaseAuthorization memory authorization = _auth();
        authorization.soulZapCaller = stranger;

        vm.expectRevert(
            abi.encodeWithSelector(ApeBondPositionAdapter.CallerMismatch.selector, stranger, address(soulZap))
        );
        _deposit(tokenId, authorization);
    }

    /**
     * @dev The SEC-05 set, all four at once (`docs/lp-staking-audit-notes.md` §11). Crediting
     *      the vault, the adapter or the position manager writes a staker record that `unstake`
     *      cannot reach and `rescuePosition` refuses to touch, so the NFT would be stranded
     *      until an upgrade. Zero is the ordinary fourth case.
     */
    function test_DepositFor_RevertsForEveryStrandingBeneficiary() public {
        address[4] memory bad = [address(0), address(adapter), address(vault), address(npmMock)];

        for (uint256 i = 0; i < bad.length; ++i) {
            uint256 tokenId = _defaultPosition();
            ApeBondPositionAdapter.PurchaseAuthorization memory authorization = _auth();
            authorization.beneficiary = bad[i];

            vm.expectRevert(abi.encodeWithSelector(ApeBondPositionAdapter.InvalidBeneficiary.selector, bad[i]));
            _deposit(tokenId, authorization);
        }
    }

    function test_DepositFor_RevertsOnAnExpiredAuthorization() public {
        uint256 tokenId = _defaultPosition();
        ApeBondPositionAdapter.PurchaseAuthorization memory authorization = _auth();
        authorization.deadline = block.timestamp - 1;

        vm.expectRevert(
            abi.encodeWithSelector(
                ApeBondPositionAdapter.AuthorizationExpired.selector, authorization.deadline, block.timestamp
            )
        );
        _deposit(tokenId, authorization);
    }

    function test_DepositFor_RevertsOnAForeignSignature() public {
        (address impostor, uint256 impostorPk) = makeAddrAndKey("impostor");
        uint256 tokenId = _defaultPosition();

        vm.expectRevert(
            abi.encodeWithSelector(ApeBondPositionAdapter.InvalidSignature.selector, impostor, purchaseSigner)
        );
        _depositSignedBy(impostorPk, tokenId, _auth());
    }

    /// @dev An unset signer needs no check of its own: `ECDSA.recover` never returns
    ///      `address(0)`, so no signature can ever equal a zero signer and the path is closed
    ///      by the same comparison that verifies a real one.
    function test_DepositFor_RevertsForEverySignatureOnceTheSignerIsUnset() public {
        vm.prank(multisig);
        adapter.setPurchaseSigner(address(0));
        uint256 tokenId = _defaultPosition();

        vm.expectRevert(
            abi.encodeWithSelector(ApeBondPositionAdapter.InvalidSignature.selector, purchaseSigner, address(0))
        );
        _deposit(tokenId, _auth());
    }

    function test_DepositFor_RevertsOnAReplayedPurchaseId() public {
        _deposit(_defaultPosition(), _auth());

        uint256 second = _defaultPosition();
        ApeBondPositionAdapter.PurchaseAuthorization memory authorization = _auth();
        authorization.nonce = 2;

        vm.expectRevert(abi.encodeWithSelector(ApeBondPositionAdapter.PurchaseAlreadyProcessed.selector, PURCHASE));
        _deposit(second, authorization);
    }

    function test_DepositFor_RevertsOnAReplayedNonce() public {
        _deposit(_defaultPosition(), _auth());

        uint256 second = _defaultPosition();
        ApeBondPositionAdapter.PurchaseAuthorization memory authorization = _auth();
        authorization.purchaseId = keccak256("apebond-purchase-2");

        vm.expectRevert(abi.encodeWithSelector(ApeBondPositionAdapter.NonceAlreadyUsed.selector, 1));
        _deposit(second, authorization);
    }

    /// @dev Two `depositFor` calls inside ONE outer call, so no revert separates them: only the
    ///      spent-id book written before the transfers can stop the second.
    function test_DepositFor_RevertsOnAReplayInsideOneTransaction() public {
        uint256 tokenId = _defaultPosition();
        ApeBondPositionAdapter.PurchaseAuthorization memory authorization = _auth();

        vm.expectRevert(abi.encodeWithSelector(ApeBondPositionAdapter.PurchaseAlreadyProcessed.selector, PURCHASE));
        soulZap.depositTwice(
            adapter,
            address(npmMock),
            tokenId,
            authorization,
            _signPurchaseAuthorization(purchaseSignerPk, adapter, authorization)
        );
    }

    function test_DepositFor_RevertsWhenTheCallerDoesNotOwnTheNft() public {
        soulZap.setApprovalMode(MockSoulZapCaller.Approval.None);
        uint256 tokenId = _createPositionOn(alice, token0, token1, FEE, TICK_LOWER, TICK_UPPER, LIQUIDITY, 0, 0);

        vm.expectRevert(
            abi.encodeWithSelector(ApeBondPositionAdapter.NftNotHeldByCaller.selector, tokenId, alice, address(soulZap))
        );
        _deposit(tokenId, _auth());
    }

    function test_DepositFor_RevertsWithoutAnApproval() public {
        soulZap.setApprovalMode(MockSoulZapCaller.Approval.None);
        uint256 tokenId = _defaultPosition();

        vm.expectRevert(
            abi.encodeWithSelector(ApeBondPositionAdapter.NftNotApproved.selector, tokenId, address(soulZap))
        );
        _deposit(tokenId, _auth());
    }

    function test_DepositFor_RevertsForAPositionOnAnotherPair() public {
        uint256 tokenId =
            _createPositionOn(address(soulZap), token0, address(tokenX), FEE, TICK_LOWER, TICK_UPPER, LIQUIDITY, 0, 0);

        vm.expectRevert(
            abi.encodeWithSelector(
                ApeBondPositionAdapter.PositionPoolMismatch.selector, tokenId, token0, address(tokenX), FEE
            )
        );
        _deposit(tokenId, _auth());
    }

    function test_DepositFor_RevertsForAPositionOnAnotherFeeTier() public {
        uint256 tokenId =
            _createPositionOn(address(soulZap), token0, token1, OTHER_FEE, TICK_LOWER, TICK_UPPER, LIQUIDITY, 0, 0);

        vm.expectRevert(
            abi.encodeWithSelector(
                ApeBondPositionAdapter.PositionPoolMismatch.selector, tokenId, token0, token1, OTHER_FEE
            )
        );
        _deposit(tokenId, _auth());
    }

    function test_DepositFor_RevertsForAnEmptyPosition() public {
        uint256 tokenId = _position(TICK_LOWER, TICK_UPPER, 0);
        ApeBondPositionAdapter.PurchaseAuthorization memory authorization = _auth();
        authorization.minLiquidity = 0;

        vm.expectRevert(abi.encodeWithSelector(ApeBondPositionAdapter.EmptyPosition.selector, tokenId));
        _deposit(tokenId, authorization);
    }

    /**
     * @dev The final assertion, tripped from both sides by a vault that is not the one anybody
     *      thought it was. It cannot fail against the deployed vault — `stakeFor` writes the
     *      record and pulls custody in the same breath — which is exactly why it is worth
     *      proving it fires at all.
     */
    function test_DepositFor_RevertsWhenTheVaultDoesNotEndUpWithTheNft() public {
        MisreportingVault liar = new MisreportingVault(address(npmMock));
        liar.setTakeCustody(false);
        ApeBondPositionAdapter lied = _deployAdapter(address(liar), address(escrow), token0, token1, FEE);
        lied.setSoulZapCaller(address(soulZap), true);
        escrow.setAdapter(address(lied));

        uint256 tokenId = _defaultPosition();
        ApeBondPositionAdapter.PurchaseAuthorization memory authorization = _auth();

        vm.expectRevert(
            abi.encodeWithSelector(ApeBondPositionAdapter.CustodyAssertFailed.selector, tokenId, address(lied), carol)
        );
        soulZap.deposit(
            lied,
            address(npmMock),
            tokenId,
            authorization,
            _signPurchaseAuthorization(purchaseSignerPk, lied, authorization)
        );
    }

    function test_DepositFor_RevertsWhenTheVaultCreditsSomebodyElse() public {
        MisreportingVault liar = new MisreportingVault(address(npmMock));
        liar.setReportedStaker(stranger);
        ApeBondPositionAdapter lied = _deployAdapter(address(liar), address(escrow), token0, token1, FEE);
        lied.setSoulZapCaller(address(soulZap), true);
        escrow.setAdapter(address(lied));

        uint256 tokenId = _defaultPosition();
        ApeBondPositionAdapter.PurchaseAuthorization memory authorization = _auth();

        vm.expectRevert(
            abi.encodeWithSelector(
                ApeBondPositionAdapter.CustodyAssertFailed.selector, tokenId, address(liar), stranger
            )
        );
        soulZap.deposit(
            lied,
            address(npmMock),
            tokenId,
            authorization,
            _signPurchaseAuthorization(purchaseSignerPk, lied, authorization)
        );
    }

    // ──────────────────────── Atomicity ────────────────────────

    /**
     * @dev The spent-id book is written BEFORE the transfers, and a later revert rolls it back
     *      with everything else — which is why §10 says there is no recovery workflow for a
     *      half-completed purchase. This asserts exactly that: after an underfunded reserve the
     *      NFT is still SoulZap's and the purchase id is NOT consumed.
     */
    function test_DepositFor_UnwindsCompletelyWhenTheEscrowIsUnderfunded() public {
        uint256 tokenId = _defaultPosition();
        ApeBondPositionAdapter.PurchaseAuthorization memory authorization = _auth();
        authorization.guaranteedBonusAmount = ESCROW_FUNDING + 1;

        vm.expectRevert(abi.encodeWithSelector(BonusEscrow.Underfunded.selector, ESCROW_FUNDING, ESCROW_FUNDING + 1));
        _deposit(tokenId, authorization);

        assertEq(npmMock.ownerOf(tokenId), address(soulZap), "the NFT never left the caller");
        assertFalse(adapter.consumedPurchaseIds(PURCHASE), "and the id is not spent");
        assertFalse(adapter.consumedNonces(1), "nor the nonce");
        assertEq(escrow.totalReserved(), 0, "and nothing is owed");
    }

    function test_DepositFor_RevertsWhenTheVaultsOwnPauseIsOn() public {
        vault.setDepositsPaused(true);
        uint256 tokenId = _defaultPosition();

        vm.expectRevert(LPStakingVault.DepositsArePaused.selector);
        _deposit(tokenId, _auth());
    }

    function test_DepositFor_RevertsWhenTheAdapterIsNoLongerAStakeOperator() public {
        vault.setStakeOperator(address(adapter), false);
        uint256 tokenId = _defaultPosition();

        vm.expectRevert(abi.encodeWithSelector(LPStakingVault.NotZapper.selector, address(adapter), address(zapper)));
        _deposit(tokenId, _auth());
    }

    // ──────────────────────── The receipt hook ─────────────────

    function test_OnERC721Received_RejectsAnUnsolicitedPosition() public {
        uint256 tokenId = _createPositionOn(alice, token0, token1, FEE, TICK_LOWER, TICK_UPPER, LIQUIDITY, 0, 0);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(ApeBondPositionAdapter.UnsolicitedPosition.selector, alice, alice, tokenId)
        );
        npmMock.safeTransferFrom(alice, address(adapter), tokenId);
    }

    function test_OnERC721Received_RejectsAForeignCollection() public {
        MockPositionManager other = new MockPositionManager();
        other.mintFake(alice, token0, token1, FEE, TICK_LOWER, TICK_UPPER, LIQUIDITY, 0, 0);
        uint256 tokenId = other.lastMintedId();

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ApeBondPositionAdapter.UnexpectedNftSender.selector, address(other)));
        other.safeTransferFrom(alice, address(adapter), tokenId);
    }

    /// @dev The window closes again, so a deposit does not leave a door open behind it.
    function test_OnERC721Received_ClosesTheWindowAfterADeposit() public {
        _deposit(_defaultPosition(), _auth());

        uint256 stray = _createPositionOn(alice, token0, token1, FEE, TICK_LOWER, TICK_UPPER, LIQUIDITY, 0, 0);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(ApeBondPositionAdapter.UnsolicitedPosition.selector, alice, alice, stray)
        );
        npmMock.safeTransferFrom(alice, address(adapter), stray);
    }

    // ──────────────────────── Administration ───────────────────

    function test_Admin_TheTwoTiersDoNotOverlap() public {
        // Owner tier: the allowlist and the guardian seat.
        vm.expectRevert(abi.encodeWithSelector(ApeBondPositionAdapter.NotGuardian.selector, address(this), multisig));
        adapter.setDepositsPaused(true);
        vm.expectRevert(abi.encodeWithSelector(ApeBondPositionAdapter.NotGuardian.selector, address(this), multisig));
        adapter.setPurchaseSigner(alice);

        // Guardian tier: the two undelayed switches, and nothing else.
        vm.startPrank(multisig);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, multisig));
        adapter.setSoulZapCaller(alice, true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, multisig));
        adapter.setGuardian(alice);
        adapter.setDepositsPaused(true);
        vm.stopPrank();

        assertTrue(adapter.depositsPaused(), "the guardian holds the switch that stops the route");
    }

    function test_Admin_RejectsAZeroSoulZapCallerAndAZeroGuardian() public {
        vm.expectRevert(ApeBondPositionAdapter.ZeroAddress.selector);
        adapter.setSoulZapCaller(address(0), true);

        vm.expectRevert(ApeBondPositionAdapter.ZeroAddress.selector);
        adapter.setGuardian(address(0));
    }

    /// @dev A SoulZap caller is a `depositFor` right, not an admin right — in NEITHER tier.
    function test_Admin_ASoulZapCallerHasNoAdminPower() public {
        vm.startPrank(address(soulZap));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(soulZap)));
        adapter.setSoulZapCaller(stranger, true);
        vm.expectRevert(abi.encodeWithSelector(ApeBondPositionAdapter.NotGuardian.selector, address(soulZap), multisig));
        adapter.setDepositsPaused(true);
        vm.stopPrank();

        assertTrue(adapter.soulZapCallers(address(soulZap)), "and it keeps the one right it was given");
    }

    /// @dev Rotating the signer repudiates every outstanding authorization in one transaction —
    ///      the point of putting it in the undelayed tier.
    function test_Admin_ASignerRotationInvalidatesOutstandingAuthorizations() public {
        uint256 tokenId = _defaultPosition();
        ApeBondPositionAdapter.PurchaseAuthorization memory authorization = _auth();
        bytes memory stale = _signPurchaseAuthorization(purchaseSignerPk, adapter, authorization);

        (address rotated, uint256 rotatedPk) = makeAddrAndKey("rotatedSigner");
        vm.prank(multisig);
        adapter.setPurchaseSigner(rotated);

        vm.expectRevert(
            abi.encodeWithSelector(ApeBondPositionAdapter.InvalidSignature.selector, purchaseSigner, rotated)
        );
        soulZap.deposit(adapter, address(npmMock), tokenId, authorization, stale);

        _depositSignedBy(rotatedPk, tokenId, authorization);
        assertEq(vault.stakerOf(tokenId), carol, "the new key works at once");
    }

    // ──────────────────────── Fuzz ─────────────────────────────

    /**
     * @dev The range check is an EQUALITY, not a containment: the campaign priced its bonus
     *      against one range, so a wider position is a different product rather than a better
     *      one. Anything but the signed pair is rejected, and the signed pair is accepted.
     */
    function testFuzz_TickRange_OnlyTheExactSignedRangeIsAccepted(int24 tickLower, int24 tickUpper) public {
        tickLower = int24(bound(tickLower, MIN_TICK_ALIGNED, MAX_TICK_ALIGNED - TICK_SPACING));
        tickUpper = int24(bound(tickUpper, tickLower + TICK_SPACING, MAX_TICK_ALIGNED));

        uint256 tokenId = _position(tickLower, tickUpper, LIQUIDITY);
        ApeBondPositionAdapter.PurchaseAuthorization memory authorization = _auth();

        if (tickLower == TICK_LOWER && tickUpper == TICK_UPPER) {
            _deposit(tokenId, authorization);
            assertEq(vault.stakerOf(tokenId), carol, "the exact range must be accepted");
        } else {
            vm.expectRevert(
                abi.encodeWithSelector(
                    ApeBondPositionAdapter.TickRangeMismatch.selector, tickLower, tickUpper, TICK_LOWER, TICK_UPPER
                )
            );
            _deposit(tokenId, authorization);
        }
    }

    /// @dev The liquidity floor is inclusive, and zero is rejected whatever the floor says —
    ///      the two are separate facts, and `minLiquidity == 0` is the case that separates them.
    function testFuzz_Liquidity_TheFloorIsInclusiveAndZeroIsAlwaysRejected(uint128 liquidity, uint128 minLiquidity)
        public
    {
        liquidity = uint128(bound(liquidity, 0, 1e12));
        minLiquidity = uint128(bound(minLiquidity, 0, 1e12));

        uint256 tokenId = _position(TICK_LOWER, TICK_UPPER, liquidity);
        ApeBondPositionAdapter.PurchaseAuthorization memory authorization = _auth();
        authorization.minLiquidity = minLiquidity;

        if (liquidity == 0) {
            vm.expectRevert(abi.encodeWithSelector(ApeBondPositionAdapter.EmptyPosition.selector, tokenId));
            _deposit(tokenId, authorization);
        } else if (liquidity < minLiquidity) {
            vm.expectRevert(
                abi.encodeWithSelector(ApeBondPositionAdapter.InsufficientLiquidity.selector, liquidity, minLiquidity)
            );
            _deposit(tokenId, authorization);
        } else {
            _deposit(tokenId, authorization);
            assertEq(vault.stakerOf(tokenId), carol, "at or above the floor must be accepted");
        }
    }

    /// @dev The deadline boundary is inclusive: `block.timestamp == deadline` still passes, and
    ///      one second later does not.
    function testFuzz_Deadline_TheBoundaryIsInclusive(uint256 deadline) public {
        deadline = bound(deadline, block.timestamp - 1_000, block.timestamp + 1_000);

        uint256 tokenId = _defaultPosition();
        ApeBondPositionAdapter.PurchaseAuthorization memory authorization = _auth();
        authorization.deadline = deadline;

        if (block.timestamp <= deadline) {
            _deposit(tokenId, authorization);
            assertEq(vault.stakerOf(tokenId), carol, "an unexpired quote must be accepted");
        } else {
            vm.expectRevert(
                abi.encodeWithSelector(ApeBondPositionAdapter.AuthorizationExpired.selector, deadline, block.timestamp)
            );
            _deposit(tokenId, authorization);
        }
    }

    /// @dev Every distinct purchase id is its own row, and every distinct nonce its own flag:
    ///      the two books are independent, and neither is a hash of the other.
    function testFuzz_ReplayBooks_AreIndependent(bytes32 purchaseId, uint256 nonce) public {
        vm.assume(purchaseId != PURCHASE);
        vm.assume(nonce != 1);

        uint256 tokenId = _defaultPosition();
        ApeBondPositionAdapter.PurchaseAuthorization memory authorization = _auth();
        authorization.purchaseId = purchaseId;
        authorization.nonce = nonce;
        authorization.guaranteedBonusAmount = 0;

        _deposit(tokenId, authorization);

        assertTrue(adapter.consumedPurchaseIds(purchaseId), "the id is spent");
        assertTrue(adapter.consumedNonces(nonce), "and the nonce is");
        assertFalse(adapter.consumedPurchaseIds(PURCHASE), "and no other id is");
        assertFalse(adapter.consumedNonces(1), "nor any other nonce");
    }
}
