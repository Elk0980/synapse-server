# VK direct tools alongside Onlypult

Process: Spec Kit 1.0.0. Owner: Codex root. Authorized scope: code, tests, feature branch, draft PR; no runtime credentials, OAuth grants, role changes, deployment or customer messages.

## Goal and user stories
US1. Owner connects community analytics independently of the existing publishing provider and collects real metrics for the selected company.
US2. Owner previews and explicitly applies a community description or static cover, then sees the verified or uncertain result and a reversible description change.
US3. Owner uses the existing manual VK inbox; draft text never sends automatically. No new customer-chat transport is introduced.

## Requirements
- FR-001. Separate direct connections by company and purpose (analytics/design), group ID, declared token type and revision. Encrypt secrets with authenticated company/purpose/group binding. No credential DTOs/logs or permission expansion. Empty credentials only preserve the same binding.
- FR-002. Analytics requires a user token under the pinned official API contract. Design supports group/user tokens. Connection verification is read-only and must verify token type and exact group. Reading public group info alone is not proof of editing rights.
- FR-003. Reuse existing VK metrics mapping, date boundaries, snapshots and collection journal with an independent direct transport. Never change autoposting_channels or Onlypult planning/publishing; mismatch or stale connection must fail closed.
- FR-004. Owner-only company-scoped settings/check/state/preview/apply/history routes; content proxy enforces session and CSRF, CRM rechecks identity and company. No arbitrary VK method/URL proxy.
- FR-005. Support only description, static community cover and cover-media upload in this increment. Preview records target revision, before-state, payload hash and source bytes hash. Explicit apply has durable request ID deduplication and audit created before mutation. An uncertain result never retries automatically. Verify readback separately from provider acceptance.
- FR-006. Cover input is bounded validated image bytes; prevent URL fetching from user input and unsafe upload-server destinations, redirects and credential forwarding. No album/avatar/market/menu/mobile-cover implementation without its own contract. Assets and previews stay private.
- FR-007. Company switch clears secret inputs, previews and state and ignores stale responses. Existing manual inbox and Onlypult remain available. All new controls distinguish configured, checked, applied, verified and uncertain; no automatic sends or simulated metrics.
- FR-008. Description rollback is a new reviewed operation against the observed current value, never blind overwrite. Cover changes retain prior references and identify when manual restoration is needed; do not promise a reversible binary that was never retained.
- FR-009. Tests cover token type mismatch, authorization/CSRF, cross-company access, revision races, provider errors/redaction, idempotency/uncertainty, file validation and unchanged Onlypult behavior. Additive storage migrations only; disabling the new feature/connection leaves publishing intact.

## Acceptance
SC-001. With a fixture Onlypult VK publishing connection, direct VK analytics collects fixture metrics without any publishing credential or channel mutation.
SC-002. Description and static-cover operations have a preview, exactly-once local dispatch record, safe readback status and no action on stale/mismatched company or revision.
SC-003. Mock-based Node, HTTP/proxy and DOM checks pass; CI and draft PR identify exact commit. Live connection and provider acceptance remain unverified until separately authorized.
