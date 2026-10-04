# VK community materials and manual inbox attachments

Owner scope: development and draft PR only. Base: PR449 / 93e6e70. No production access, credentials, OAuth issuance, grants, deployment, merge, live uploads or messages.

## Requirements

- FR-001: An owner can list existing photo albums of the company's checked design binding, preview one JPEG/PNG and caption, then explicitly upload it to a selected existing album. Album writes require a user-type design binding; community-type binding fails closed. Readback distinguishes accepted from verified.
- FR-002: Existing manual one-to-one inbox displays sanitized incoming photo and document attachments. Unsupported types remain visible as unavailable; arbitrary remote URLs, executable links and access keys never become accepted outgoing references.
- FR-003: An owner can prepare a manual reply containing text and at most one JPEG/PNG or PDF. Preparation stores a private local preview only. An explicit confirmation uploads and sends the frozen preview once to the previously loaded dialog. Existing text-only reply compatibility remains.
- FR-004: Every write is scoped to company, binding revision, group and (for inbox) peer. Durable claims precede external mutations; repeated/concurrent request IDs never duplicate uploads or sends. Changed bindings and expired previews fail closed. Unknown provider outcomes never auto-retry.
- FR-005: Files have strict byte/type/dimension limits, no URL ingestion, bounded upload/API responses, HTTPS destination allowlist and redirects disabled. No provider secrets/opaque upload responses in public errors or audit DTOs.
- FR-006: UI previews are invalidated by edits/company/dialog/binding changes; final action identifies destination and content. UI blocks repeated confirmation and reports unknown outcomes honestly.
- FR-007: Owner/company/CSRF proxy protections and Onlypult publication behavior remain intact. Tests use mocked providers/synthetic secrets only.
- FR-008: Document official method contracts and token-type evidence; exact minimum scope masks and token issuance remain unknown unless supported by primary evidence. Connection read checks do not prove editing rights.

## Acceptance

- SC-001: Tests prove no external write during preparation, one write chain after confirmation, duplicate and ambiguous outcome safety, company/revision/peer isolation and hostile upload rejection.
- SC-002: DOM tests prove preview invalidation and manual confirmation; backend/proxy and existing Onlypult/inbox regressions pass.
- SC-003: Draft PR includes evidence and current CI status. Implemented/tested are distinct from deployed/live.

## Explicit remaining gaps

Avatar is deferred: saveOwnerPhoto can create a wall post, requiring a separate product decision alongside Onlypult. Album creation/deletion, videos, market/menu, arbitrary document formats, forwarded-message resend, callback/Long Poll/background refresh and automatic replies are outside this increment. Existing analytics and description/cover remain from PR449.
