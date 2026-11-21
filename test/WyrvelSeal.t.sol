// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {WyrvelSeal} from "../src/WyrvelSeal.sol";

contract WyrvelSealTest is Test {
    WyrvelSeal internal seal;

    bytes32 internal constant RECORD = keccak256("record-guangzhou");
    bytes internal constant PAYLOAD = "Pin a hash. Keep the data private.";

    event Committed(
        bytes32 indexed recordId,
        bytes32 commitment,
        uint64 pinnedAt,
        address indexed pinner
    );

    function setUp() public {
        seal = new WyrvelSeal();
        vm.warp(1_763_712_000);
    }

    function test_commitStoresKeccakAndEmits() public {
        bytes32 commitment = keccak256(PAYLOAD);
        address pinner = makeAddr("adapter");

        vm.expectEmit(true, true, false, true, address(seal));
        emit Committed(RECORD, commitment, uint64(block.timestamp), pinner);

        vm.prank(pinner);
        seal.commit(RECORD, commitment);

        (bytes32 got, uint64 pinnedAt, address who, bool pinned) = seal.sealOf(RECORD);
        assertEq(got, commitment);
        assertEq(pinnedAt, uint64(block.timestamp));
        assertEq(who, pinner);
        assertTrue(pinned);
    }

    function test_commitIsImmutable() public {
        bytes32 commitment = keccak256(PAYLOAD);
        seal.commit(RECORD, commitment);

        vm.expectRevert(abi.encodeWithSelector(WyrvelSeal.RecordAlreadyPinned.selector, RECORD));
        seal.commit(RECORD, keccak256("other payload"));

        (bytes32 got,,, bool pinned) = seal.sealOf(RECORD);
        assertEq(got, commitment);
        assertTrue(pinned);
    }

    function test_zeroRecordIdReverts() public {
        vm.expectRevert(WyrvelSeal.RecordIdRequired.selector);
        seal.commit(bytes32(0), keccak256(PAYLOAD));
    }

    function test_valueReverts() public {
        vm.expectRevert(WyrvelSeal.ValueNotAccepted.selector);
        seal.commit{ value: 1 }(RECORD, keccak256(PAYLOAD));
    }

    function test_unknownRecordIsNotPinned() public view {
        (bytes32 commitment, uint64 pinnedAt, address pinner, bool pinned) = seal.sealOf(RECORD);
        assertEq(commitment, bytes32(0));
        assertEq(pinnedAt, 0);
        assertEq(pinner, address(0));
        assertFalse(pinned);
    }

    function test_recordsAreIndependent() public {
        bytes32 first = keccak256("one");
        bytes32 second = keccak256("two");
        bytes32 idA = keccak256("a");
        bytes32 idB = keccak256("b");

        seal.commit(idA, first);
        seal.commit(idB, second);

        (bytes32 a,,,) = seal.sealOf(idA);
        (bytes32 b,,,) = seal.sealOf(idB);
        assertEq(a, first);
        assertEq(b, second);
    }

    function testFuzz_commitRoundTrip(bytes32 recordId, bytes32 commitment, address pinner) public {
        vm.assume(recordId != bytes32(0));
        vm.assume(pinner != address(0));

        vm.prank(pinner);
        seal.commit(recordId, commitment);

        (bytes32 got, uint64 pinnedAt, address who, bool pinned) = seal.sealOf(recordId);
        assertEq(got, commitment);
        assertEq(who, pinner);
        assertEq(pinnedAt, uint64(block.timestamp));
        assertTrue(pinned);
    }
}
