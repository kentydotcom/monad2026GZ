// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title WyrvelSeal
/// @notice Pins a 32-byte keccak256 commitment under a record id.
///         The payload stays off-chain. A record cannot be rewritten.
contract WyrvelSeal {
    struct Seal {
        bytes32 commitment;
        uint64 pinnedAt;
        address pinner;
    }

    mapping(bytes32 recordId => Seal) private _seals;

    event Committed(
        bytes32 indexed recordId,
        bytes32 commitment,
        uint64 pinnedAt,
        address indexed pinner
    );

    error RecordAlreadyPinned(bytes32 recordId);
    error RecordIdRequired();
    error ValueNotAccepted();

    function commit(bytes32 recordId, bytes32 commitment) external payable {
        if (msg.value != 0) revert ValueNotAccepted();
        if (recordId == bytes32(0)) revert RecordIdRequired();
        if (_seals[recordId].pinner != address(0)) revert RecordAlreadyPinned(recordId);

        uint64 pinnedAt = uint64(block.timestamp);
        _seals[recordId] = Seal({ commitment: commitment, pinnedAt: pinnedAt, pinner: msg.sender });

        emit Committed(recordId, commitment, pinnedAt, msg.sender);
    }

    function sealOf(bytes32 recordId)
        external
        view
        returns (bytes32 commitment, uint64 pinnedAt, address pinner, bool pinned)
    {
        Seal storage seal = _seals[recordId];
        pinned = seal.pinner != address(0);
        return (seal.commitment, seal.pinnedAt, seal.pinner, pinned);
    }
}
