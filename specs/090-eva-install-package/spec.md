# Feature Specification: Eva connection preparation package

**Feature Branch**: `090-eva-install-package`
**Created**: 2026-10-05
**Status**: Development only

## User Scenarios & Testing

### User Story 1 - Receive a verifiable preparation file (Priority: P1)

Vlad downloads one complete file, copies one command on Linux, and receives a private preparation directory without finding IDs or writing SQL.

**Independent test**: Build twice from the same committed sources; checksums match. Run the generated command in a disposable Linux directory.

**Acceptance**: Valid package prepares only a new directory. Corrupt or unsafe content is rejected before extraction. An existing directory is never overwritten.

### User Story 2 - Understand what remains before connection (Priority: P1)

The owner sees that preparation is complete while server integration is still unverified. The package contains the reviewed personal pairing program for a later authorized operator step.

**Independent test**: Preparation performs no network or service operations, asks for no secrets and explicitly reports that Eva is not connected.

**Acceptance**: No deployment, timer change, credential access, CRM environment rewrite or bot activation occurs. Existing mock pairing proves hidden token entry, bounded owner confirmation, no first-sender ownership and refusal to overwrite configuration.

### Edge cases

Wrong platform/version, duplicate or escaping archive paths, symlinks, manifest mismatch, existing destination, interrupted extraction and modified output during cleanup all fail closed. Rollback never removes a preexisting or changed file.

## Requirements

- **FR-001**: Deliver immutable source package and SHA256 plus one literal Linux command referencing the delivered file.
- **FR-002**: Build reproducibly from exact repository commits with an explicit source allowlist; include no credentials or production data.
- **FR-003**: Verify archive and per-file hashes, sizes and safe names before any preparation writes; never overwrite existing paths.
- **FR-004**: Limit preparation to its new private directory; provide safe rollback for failed preparation and keep existing CRM files/keys untouched.
- **FR-005**: Never start Eva, deploy CRM, modify timers, acquire/read credentials or contact Telegram during preparation/tests.
- **FR-006**: Preserve reviewed owner pairing: personal hidden input, exact bot identity, private chat, one-time reverse confirmation, five-minute expiry and no configuration before success.
- **FR-007**: Document exact release/deployment blockers and the six supplied company codes without treating the registry as authorization to activate all projects.
- **FR-008**: Prove compatibility with main29c10c0, preserve VK changes, test Linux preparation, mock pairing and rollback, and retain independent review evidence.

## Success Criteria

- **SC-001**: Identical source versions produce byte-identical deliverables.
- **SC-002**: Every unsafe-package and rollback test preserves unrelated fixtures byte-for-byte.
- **SC-003**: The owner has one deliverable file and a tested copy/paste preparation command, with no manual ID lookup or SQL.
- **SC-004**: Reports clearly distinguish prepared/tested from connected/deployed.

## Assumptions and boundaries

Expected public bot: SynapseBusinessEvaBot. Owner numeric ID remains unknown and will only be derived by the existing personal pairing flow. Default timezone Etc/UTC follows the supplied environment, not an inferred city. Main anchor29c10c0 and PR4431d7d0b5 are exact source references; neither proves production state. Full connection requires an authorized CRM reader release and separately verified server socket configuration. This preparation task does not supply that authorization.
