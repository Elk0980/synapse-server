# Evidence

Baseline `93e6e70fc8a907c3ceac3e87352afc578362c48b` cloned into a separate task checkout. PR449 confirmed merged through GitHub read-only API. Open VK PR search returned none. Previous worker thread status could not be queried with available tools; none of its files were edited.

No live VK calls, credentials, permission changes, production deployment or timer operations. An isolated jsdom 26.1.0 dependency was installed outside the checkout. The shared npm cache failed with EEXIST; using a separate task cache resolved installation without deleting or changing the shared cache.

## Implemented and locally tested

Node 24.18.1 on Windows. The exact regression command is in [quickstart](quickstart.md). It covers existing analytics, description/cover, inbox, Onlypult flow and all new material/attachment tests. Final counts and exact commit CI links are recorded in the draft PR, because a commit cannot contain its own final CI result.

The final combined pass was **218 tests, all passed, no skips**. The cabinet subset contains 48 passing DOM tests (31 existing and 17 new). This final pass includes the navigation control-refresh edge and VK internal/unknown-error matrix. Spec Kit gate verified 48 official files; its five negative/process tests passed. `git diff --check` passed.

| Requirement | Evidence |
| --- | --- |
| FR-001, FR-004, FR-005 | `vk-materials.test.js` and `vk-direct-materials.test.js`: bounded album list, exact owner and selected album, user-token restriction, local preview, durable claim, restart/concurrency, unsafe destinations, timeouts, response limits, readback, source-byte purge. |
| FR-002, FR-003, FR-004, FR-005 | `vk-community-attachments.test.js`: photo/PDF-only DTOs, absent access keys, local preview with zero provider calls, explicit upload/save/send, file-only PDF, expiry, limits, company/peer/revision isolation, durable crash claim and no retry. |
| FR-006 | Cabinet DOM suites: destination and content preview, separate confirmation, edits/context invalidation, stale responses, uncertain outcome locks, expired-preview recovery and known late outcomes reconciled only with their original scope. |
| FR-007 | Real temporary content→CRM proxy tests: owner enforcement, company context, CSRF, preparation without writes, confirmed once-only uploads and replies. Exact Onlypult database row comparison remains unchanged. Lower-level outgoing CRM sockets are disabled in these fixtures. |
| FR-008 | [Research](research.md) records pinned primary VK schemas/SDK, token types, unavailable current dev portal pages, exact minimum permissions/issuance unknown, and avatar wall-post side effect. |

## Independent review and convergence

Two separate read-only agent sessions reviewed backend/security and UI/HTTP contracts. This is session independence, not a separate model/provider guarantee. Three concrete findings were reproduced and corrected with regression tests:

1. HTTP-200 VK internal/unknown/malformed errors were incorrectly definite failures in the inherited inbox transport; writes now remain uncertain. Codes 1, 10, 36, unknown codes and malformed error envelopes are covered across photo save, document save and both message paths.
2. Expired material previews could leave an unnecessary uncertainty lock. Local expiry and explicit pre-dispatch expiration errors now permit a new preview; network ambiguity remains locked.
3. Known reply outcomes arriving after company navigation could leave the original dialog locked. Captured operation scope is validated before privately reconciling its lock; old content never renders in the new company.

Convergence considered all eight FR requirements, three acceptance criteria, the four file-ownership/architecture areas and five repository constitution principles. Buildable gaps are closed; draft-PR creation and CI evidence are the final delivery step (T009). Final reviewers recheck the committed candidate and report its exact SHA in the PR handoff.

## Limits and remaining operational decisions

- No claim of deployment or live VK acceptance. No merge/deploy, browser-user session, credentials/OAuth/grants, real uploads/messages, Onlypult configuration or server timer action.
- Albums upload one JPEG/PNG into an existing album. Album creation/deletion, community document library, videos, avatar, menu/market and arbitrary formats remain out of scope. Avatar may create a wall post; it needs a separate product decision.
- Incoming photo/PDF support is deliberately bounded; unsupported/unsafe media are placeholders. PDF validation checks container markers, not malware. Image validation checks structure and dimensions, not full decoding.
- Interrupted `applying` album actions block further same-group upload attempts until manual operational reconciliation. There is no auto-reset/retry and no new reconciliation console. Expired private preview bytes are purged on subsequent scoped use or inbox module startup; there is no new background refresh/timer.
- Exact minimum scopes and suitable OAuth application/redirect setup remain unresolved. Private token entry is not token issuance, and public community reading is not evidence of editing rights.
- Previous codeworker's current thread status remains unavailable to this environment; the old checkout and its worktrees were never modified. Before final delivery GitHub main still resolved to PR449, and no competing open VK PR was observed.
