// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {WyrvelSeal} from "../src/WyrvelSeal.sol";

/// @notice Deploys WyrvelSeal. The signing key is read from PRIVATE_KEY.
contract Deploy is Script {
    function run() external returns (WyrvelSeal seal) {
        uint256 privateKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(privateKey);
        seal = new WyrvelSeal();
        vm.stopBroadcast();
        console2.log("WyrvelSeal", address(seal));
    }
}
