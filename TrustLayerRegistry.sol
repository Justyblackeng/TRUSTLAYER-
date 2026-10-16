// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title TrustLayerRegistry
/// @notice Onchain registry of AI-generated credit credentials.
/// Each onboarded bank (issuer) signs credentials only for its own customers.
/// No personal data is stored: subjects are opaque bytes32 IDs and the score is
/// anchored to an offchain record through `scoreHash`.
contract TrustLayerRegistry is AccessControl {
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");
    uint40 public constant VALIDITY = 180 days;

    struct Credential {
        uint16 score;
        uint64 loanLimitNgn;
        uint40 issuedAt;
        uint40 expiresAt;
        bool revoked;
        address issuer;
        bytes32 scoreHash;
    }

    mapping(bytes32 => Credential) private _creds;
    mapping(address => string) public issuerName;

    event IssuerAdded(address indexed issuer, string name);
    event IssuerRemoved(address indexed issuer);
    event CredentialIssued(
        bytes32 indexed subjectId,
        address indexed issuer,
        uint16 score,
        uint64 loanLimitNgn,
        bytes32 scoreHash,
        uint40 expiresAt
    );
    event CredentialRevoked(bytes32 indexed subjectId, address indexed by);

    error ScoreOutOfRange();
    error NotOriginalIssuer();
    error NoCredential();

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function addIssuer(address issuer, string calldata name) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _grantRole(ISSUER_ROLE, issuer);
        issuerName[issuer] = name;
        emit IssuerAdded(issuer, name);
    }

    function removeIssuer(address issuer) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _revokeRole(ISSUER_ROLE, issuer);
        emit IssuerRemoved(issuer);
    }

    /// @notice Issue or refresh a credential. Only the original issuer can refresh it.
    function issue(bytes32 subjectId, uint16 score, uint64 loanLimitNgn, bytes32 scoreHash)
        external
        onlyRole(ISSUER_ROLE)
    {
        if (score < 300 || score > 850) revert ScoreOutOfRange();
        Credential storage c = _creds[subjectId];
        if (c.issuer != address(0) && c.issuer != msg.sender) revert NotOriginalIssuer();

        c.score = score;
        c.loanLimitNgn = loanLimitNgn;
        c.issuedAt = uint40(block.timestamp);
        c.expiresAt = uint40(block.timestamp + VALIDITY);
        c.revoked = false;
        c.issuer = msg.sender;
        c.scoreHash = scoreHash;

        emit CredentialIssued(subjectId, msg.sender, score, loanLimitNgn, scoreHash, c.expiresAt);
    }

    function revoke(bytes32 subjectId) external {
        Credential storage c = _creds[subjectId];
        if (c.issuer == address(0)) revert NoCredential();
        if (msg.sender != c.issuer && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotOriginalIssuer();
        c.revoked = true;
        emit CredentialRevoked(subjectId, msg.sender);
    }

    /// @notice Anyone (any lender) can verify. issuer == address(0) means "not found".
    function verify(bytes32 subjectId)
        external
        view
        returns (
            bool valid,
            uint16 score,
            uint64 loanLimitNgn,
            uint40 issuedAt,
            uint40 expiresAt,
            bool revoked,
            address issuer,
            string memory issuerName_,
            bytes32 scoreHash
        )
    {
        Credential memory c = _creds[subjectId];
        valid = c.issuer != address(0) && !c.revoked && block.timestamp < c.expiresAt;
        return (valid, c.score, c.loanLimitNgn, c.issuedAt, c.expiresAt, c.revoked, c.issuer, issuerName[c.issuer], c.scoreHash);
    }
}
