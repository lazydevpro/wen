// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Script, console} from "forge-std/Script.sol";

/// Minimal probe: no deploy, no broadcast, no key. Just reads block.prevrandao
/// while forked onto CC3, which is where the reported panic would occur.
contract PrevrandaoProbe is Script {
    function run() external view {
        console.log("chainid    :", block.chainid);
        console.log("number     :", block.number);
        console.log("prevrandao :", block.prevrandao);
    }
}
