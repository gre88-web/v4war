// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { SiegeOfTheCrown } from "../src/SiegeOfTheCrown.sol";

interface Vm {
    function envAddress(string calldata name) external view returns (address value);
    function envOr(string calldata name, uint256 defaultValue) external view returns (uint256 value);
    function startBroadcast() external;
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

contract DeploySiegeOfTheCrown {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (SiegeOfTheCrown game) {
        uint256 privateKey = vm.envOr("PRIVATE_KEY", uint256(0));

        SiegeOfTheCrown.Config memory config = SiegeOfTheCrown.Config({
            treasury: vm.envAddress("TREASURY"),
            totalTiles: vm.envOr("TOTAL_TILES", uint256(10_000)),
            start: vm.envOr("START", uint256(5_000)),
            baseCost: vm.envOr("BASE_COST", uint256(0.0005 ether)),
            escalation: vm.envOr("ESCALATION", uint256(9)),
            feeBps: uint16(vm.envOr("FEE_BPS", uint256(300))),
            bonusBps: uint16(vm.envOr("BONUS_BPS", uint256(1_000))),
            initialClock: uint64(vm.envOr("INITIAL_CLOCK", uint256(24 hours))),
            extend: uint64(vm.envOr("EXTEND", uint256(30 seconds))),
            maxClock: uint64(vm.envOr("MAX_CLOCK", uint256(6 hours)))
        });

        if (privateKey == 0) {
            vm.startBroadcast();
        } else {
            vm.startBroadcast(privateKey);
        }

        game = new SiegeOfTheCrown(config);

        vm.stopBroadcast();
    }
}
