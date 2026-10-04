# Evidence

2026-10-04: isolated checkout at f6a93da88d8d9b67ec74dccf096c8a1dd6779bcb. Node v24.18.1. Existing Eva checkout unchanged. No live credentials, OAuth, server/browser changes or customer messages.

## Implemented and checked locally

- Separate analytics/design encrypted credential bindings, no changes to Onlypult storage/planner.
- Existing native metrics collector with independent direct transport and correct direct provenance, including an existing Onlypult-selected analytics account.
- Private description/static-cover preview, explicit apply, durable idempotency/audit, readback and guarded description rollback. Temporary preview image bytes are bounded and cleaned after completion.
- Owner/company/CSRF HTTP and UI integration alongside existing manual inbox; no callback, polling or automated response transport.
- Final targeted command in quickstart: **161 tests passed**, zero failed/skipped. Includes real local content→CRM HTTP services with mocked external VK and outbound socket blocking, valid synthetic Onlypult connection preserved byte-for-byte, native statistics reaching scoped snapshots with provider=direct, denied cross-company apply, CSRF rejection and one description mutation for repeated request ID.
- Additional analytics/provenance/project-period regressions: **48 passed**, zero failed/skipped. Total root validation: **209 passed**.
- Spec Kit gate: status ok, 48 official files verified; prerequisites resolved using SPECIFY_FEATURE_DIRECTORY=specs/087-vk-direct-tools. Initial sparse-checkout missing official Claude/Qwen skill files was resolved by materializing those tracked directories; no policy files changed.
- Independent read-only review found and verified fixes for user-token proof, wrapped upload responses, ambiguous provider internal errors, actual metric provenance, transient read retry classification and read-only state after an uncertain mutation. No remaining blocking finding reported within this scope.
- Convergence: FR-001–009 covered by direct/design/HTTP/proxy/DOM and regression tests; SC-001 and SC-002 checked with fixtures. SC-003 live acceptance explicitly remains outside this implementation authorization. Draft PR/CI recorded separately below.

## Limits / not performed

No live VK token, OAuth grant, API write, browser use, deployment, merge, role change or customer message. Mock tests do not prove live provider rights or rollout. User authorization/OAuth issuance is not implemented here; private fields accept only an already authorized token after a separate setup decision. Menu/mobile cover/avatar/albums/market and automatic customer replies are outside this increment.

An interrupted process can retain an applying action requiring manual operational reconciliation; no automatic resend or unlock. A cover restore needs a retained original image. Upload hosts are conservatively restricted by Synapse policy, not claimed as VK's complete official CDN contract.

## Reviewable delivery

Draft PR: https://github.com/Elk0980/synapse-server/pull/449, branch `087-vk-direct-tools`, base `f6a93da88d8d9b67ec74dccf096c8a1dd6779bcb`. Implementation commit `3f588dd80c8db300ee3e37acfa5f7b0cd8ce80ff`; follow-up replaces the public community number in fixtures with a generic fixture ID (no production behavior change). The affected design/DOM tests were rerun. CI results attach to the latest PR head; this document does not claim a completed CI run before its result exists. No merge or deployment.

## Compatibility and image boundary follow-up

The dedicated analytics selector now preserves the existing direct provider only when the new company record is explicitly absent. Configured, disabled, invalid or unreadable records never fall back; Onlypult without the new record keeps its previous unsupported VK behavior. A real collector regression proves an in-flight legacy result is discarded when the dedicated record appears. Five additional compatibility tests passed in the author's 109-test regression command; independent review of the selector reported no blocker. Root also reran the 48 analytics regressions successfully.

The image validator uses a nonrecursive invalid-character scan plus canonical Base64 roundtrip. All 22 design tests passed, including an actual multi-megabyte PNG preview, exactly 8 MiB accepted and 8 MiB + 1 byte rejected before provider access.

Windows execution disconnected before the final combined rerun and local commit. The exact reviewed patches were reconstructed against published head `51b5f27561285fbb2e4e84526c0d4af34ffa283a` and delivered atomically through GitHub's API; final CI must be read on the resulting PR head. That prior head passed vk-direct-tools, spec-kit and both project-chat-check runs. Local checkout requires reconciliation after connection recovery; do not overwrite its uncommitted copies or force-push the earlier head. No merge or deployment.
