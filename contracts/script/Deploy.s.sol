// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ChartVerifier} from "../src/ChartVerifier.sol";
import {ChartRegistry} from "../src/ChartRegistry.sol";
import {GridGame} from "../src/GridGame.sol";

/**
 * Deploys the Hindsight stack to CC3 Testnet and registers the Uniswap V3 pools whose
 * Swap events are allowed to become candles.
 *
 *   forge script script/Deploy.s.sol --rpc-url $CC3_RPC_URL --broadcast
 */
contract Deploy is Script {
    address constant USDC_WETH_005 = 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640;
    address constant USDC_WETH_001 = 0xE0554a476A092703abdB3Ef35c80e0D76d32939F;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(pk);

        ChartVerifier verifier = new ChartVerifier();
        ChartRegistry registry = new ChartRegistry();
        GridGame game = new GridGame(registry);

        // Only these pools may produce candles. Without the allowlist, anyone could deploy a
        // contract emitting a lookalike Swap event and forge a chart.
        verifier.registerPool(USDC_WETH_005, "USDC/WETH 0.05%", 6, 18, true);
        verifier.registerPool(USDC_WETH_001, "USDC/WETH 0.01%", 6, 18, true);

        // Seed the house bankroll. maxBet = bankroll/400, so 4000 CTC allows a 10 CTC bet.
        game.fundBankroll{value: 4_000 ether}();

        vm.stopBroadcast();

        console.log("CHART_VERIFIER_ADDRESS=%s", address(verifier));
        console.log("CHART_REGISTRY_ADDRESS=%s", address(registry));
        console.log("GRID_GAME_ADDRESS=%s", address(game));
        console.log("bankroll: %s wei, maxBet: %s wei", game.bankroll(), game.maxBet());
    }
}
