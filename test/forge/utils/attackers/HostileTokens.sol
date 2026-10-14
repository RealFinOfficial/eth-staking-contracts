// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @notice ERC-20s that are legal but hostile, each modelling one real-world class the
 *         vault / zapper / distributor could be pointed at.
 *
 *  None of these can appear as the configured pool pair on a live deployment — the pool
 *  triple is checked in both constructors and the deploy script asserts decimals. They
 *  exist to answer the reviewer's question "and if the token misbehaves?" with a measured
 *  answer instead of an argument, and because `LPZapper.sweep`,
 *  `RewardsDistributor.recoverExcess` and — since the distributor became multi-token —
 *  `RewardsDistributor.addRewardToken` really do touch tokens nobody chose at deploy time.
 *  `addRewardToken` is owner tier (the timelock, 48 h public), and its NatSpec states that only
 *  plain ERC-20s are supported; the reward-token classes below measure what happens if a
 *  non-plain one is added anyway.
 */

/// @dev Skims a fee on every transfer, so `balanceOf(to)` after a transfer is always less
///      than the amount sent. Models USDT-with-fee-enabled, and every deflationary token.
///      Given no authority beyond being a token — that is the whole point: a token alone
///      must not be able to strand value in the stack.
contract FeeOnTransferToken is ERC20 {
    uint256 public feeBps;
    uint8 private immutable _decimals;

    constructor(string memory n, string memory s, uint8 d, uint256 feeBps_) ERC20(n, s) {
        _decimals = d;
        feeBps = feeBps_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setFeeBps(uint256 feeBps_) external {
        feeBps = feeBps_;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0) || feeBps == 0) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = (value * feeBps) / 10_000;
        super._update(from, address(this), fee);
        super._update(from, to, value - fee);
    }
}

/// @dev Returns `false` instead of reverting on a failed (or even a successful) transfer.
///      The pre-EIP-20-errata class that `SafeERC20` exists for. Authority: none — it only
///      has to be the token a call names.
contract ReturnsFalseToken {
    string public name = "Returns False";
    string public symbol = "RF";
    uint8 public decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    bool public transferReturns;
    bool public transferFromReturns;
    bool public approveReturns;

    constructor() {
        transferReturns = false;
        transferFromReturns = false;
        approveReturns = true;
    }

    function setReturns(bool transfer_, bool transferFrom_, bool approve_) external {
        transferReturns = transfer_;
        transferFromReturns = transferFrom_;
        approveReturns = approve_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return approveReturns;
    }

    /// @dev Moves the balance anyway, so a caller that ignores the return value is *also*
    ///      wrong about the accounting — the strictly worse variant of the bug.
    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return transferReturns;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return transferFromReturns;
    }
}

/// @dev USDC's two awkward properties in one token: an owner-controlled blocklist that makes
///      transfers to or from an address revert, and the non-zero -> non-zero `approve`
///      rejection that `forceApprove` exists to survive. Authority: an owner that can
///      blocklist anyone, which is exactly the real USDC trust model.
contract BlocklistUSDC is ERC20 {
    mapping(address => bool) public blocked;
    bool public rejectNonZeroToNonZeroApprove = true;

    constructor() ERC20("Blocklist USDC", "bUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address who, bool value) external {
        blocked[who] = value;
    }

    function setRejectNonZeroToNonZeroApprove(bool value) external {
        rejectNonZeroToNonZeroApprove = value;
    }

    function approve(address spender, uint256 value) public override returns (bool) {
        if (rejectNonZeroToNonZeroApprove) {
            require(value == 0 || allowance(msg.sender, spender) == 0, "USDC: approve from non-zero to non-zero");
        }
        return super.approve(spender, value);
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[from], "USDC: sender blocklisted");
        require(!blocked[to], "USDC: recipient blocklisted");
        super._update(from, to, value);
    }
}

/// @dev ERC-777-style push hook: every transfer calls the recipient back BEFORE the caller
///      regains control, which is the classic reentrancy surface a plain ERC-20 does not
///      have. `LPStakingVault._refundDust` and `RewardsDistributor.claim` both push tokens to
///      an address the caller controls, so the hook lands inside those functions.
///      Authority: the hook is only ever called on a recipient that opted in by
///      implementing {ITokenHook} — the attacker's own contract.
interface ITokenHook {
    function tokensReceived(address from, address to, uint256 amount) external;
}

contract HookToken is ERC20 {
    uint8 private immutable _decimals;
    /// @dev Only these addresses get called back. Keeps the hook out of unrelated transfers.
    mapping(address => bool) public hooked;

    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) {
        _decimals = d;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setHooked(address who, bool value) external {
        hooked[who] = value;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (to != address(0) && hooked[to] && to.code.length > 0) {
            ITokenHook(to).tokensReceived(from, to, value);
        }
    }
}

/// @dev A reward token whose own `transfer` re-enters the distributor while the distributor is
///      paying out of it — the token itself is the attacker, no recipient opt-in needed. Armed
///      with a target and a payload; every transfer FROM the target fires the payload once and
///      records what came back. Authority: none beyond having been added as a reward token,
///      which is the owner's (timelock's) decision; the question is what the guard does then.
contract ClaimReentrantToken is ERC20 {
    address public target;
    bytes public payload;
    uint256 public attempts;
    bool public lastReenterSucceeded;
    bytes public lastReturnData;
    bool private _inHook;

    constructor() ERC20("Reentrant Reward", "RRW") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (from != address(0) && from == target && !_inHook) {
            _inHook = true;
            attempts++;
            (bool ok, bytes memory ret) = target.call(payload);
            lastReenterSucceeded = ok;
            lastReturnData = ret;
            _inHook = false;
        }
    }
}

/// @dev A token whose `decimals()` reverts. Not a plain ERC-20; `addRewardToken` reads
///      `decimals()` and must refuse it rather than register a token whose unit it cannot state.
contract DecimalsRevertsToken is ERC20 {
    constructor() ERC20("No Decimals", "NODEC") {}

    function decimals() public pure override returns (uint8) {
        revert("no decimals");
    }
}

/// @dev A token whose `symbol()` returns `bytes32` instead of `string` — the MKR / SAI class.
///      Decoding the 32 returned bytes as a `string` fails, so `addRewardToken` reverts.
contract Bytes32SymbolToken {
    uint8 public constant decimals = 18;

    function symbol() external pure returns (bytes32) {
        return "MKR";
    }

    function balanceOf(address) external pure returns (uint256) {
        return 0;
    }
}
