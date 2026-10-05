// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./LPStakingVaultV2Mock.sol";

/**
 * @title LPStakingVaultV3Mock
 * @notice Test-only THIRD implementation for the vault proxy, and a forward-compatible upgrade
 *         of {LPStakingVaultV2Mock} rather than of {LPStakingVault}.
 *
 *  It exists for suites that have to upgrade the same proxy twice in one process. The storage
 *  layout check `prepareUpgrade` runs is not symmetric: it grades a candidate against the
 *  layout of the implementation the proxy RUNS, so once a proxy is on V2 the plain V1 contract
 *  is no longer a legal upgrade for it — V1 would DELETE the namespace
 *  `erc7201:real.lp.storage.LPStakingVaultV2` that V2 added, and the plugin refuses that. A
 *  second upgrade therefore has to move forward again, which is what this contract is.
 *
 *  It inherits V2's namespace untouched and adds no state of its own; the only difference is
 *  the `version()` marker, so a test can tell from the proxy which of the three implementations
 *  it is delegating to. `test/lp-staking/DeployApeBond.test.js` uses it for the
 *  `LP_APEBOND_MODE=upgrade-vault` run, after the activation run has already put V2 behind the
 *  same proxy.
 */
contract LPStakingVaultV3Mock is LPStakingVaultV2Mock {
    constructor(
        address _positionManager,
        address _pool,
        address _token0,
        address _token1,
        uint24 _fee,
        address _swapRouter
    ) LPStakingVaultV2Mock(_positionManager, _pool, _token0, _token1, _fee, _swapRouter) {}

    /// @inheritdoc LPStakingVaultV2Mock
    function version() external pure override returns (uint256) {
        return 3;
    }
}
