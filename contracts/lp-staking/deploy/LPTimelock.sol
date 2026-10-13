// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/governance/TimelockController.sol";

/**
 * @title LPTimelock
 * @notice The `TimelockController` that owns the `LPStakingVault` and `RewardsDistributor`
 *         proxies. It is OpenZeppelin's `TimelockController` with nothing added: the same
 *         roles, the same `schedule`/`execute`/`cancel` surface, the same self-administration.
 *
 *  Why a wrapper at all, if it adds no behaviour: the same two reasons as {LPProxy} — the
 *  indexer only vendors artifacts whose `sourceName` starts with `contracts/lp-staking/`,
 *  and the repo wants one name for the deployed timelock across deploy script, suites and
 *  explorer.
 *
 *  Deployment parameters (see `docs/specs/01-contracts.md` §2.5): `minDelay` is
 *  environment-driven (48 h on mainnet, short on staging so the flow can be rehearsed),
 *  `proposers` and `executors` are both `[multisig]` — execution is deliberately NOT open —
 *  and `admin` is `address(0)`, which makes the timelock its own `DEFAULT_ADMIN_ROLE` holder.
 *  Shortening the delay is therefore itself a scheduled, publicly visible operation.
 */
contract LPTimelock is TimelockController {
    /// @param minDelay   Minimum seconds between `schedule` and the earliest `execute`.
    /// @param proposers  Addresses granted `PROPOSER_ROLE` (and `CANCELLER_ROLE`, per OZ).
    /// @param executors  Addresses granted `EXECUTOR_ROLE`. `address(0)` (open execution)
    ///                   is not used here.
    /// @param admin      Optional bootstrap admin; `address(0)` leaves the timelock
    ///                   self-administered from block one.
    constructor(uint256 minDelay, address[] memory proposers, address[] memory executors, address admin)
        TimelockController(minDelay, proposers, executors, admin)
    {}
}
