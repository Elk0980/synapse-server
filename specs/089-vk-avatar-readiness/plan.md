# Implementation plan

Use worktree synapse-vk-avatar and branch 089-vk-avatar-readiness, stacked on PR450's frozen dbb5f0 commit. Reuse Node24 SQLite, existing direct design binding, image validation, owner HTTP and cabinet infrastructure. No runtime dependencies or write-method allowlist additions.

File ownership (one writer per file): backend agent owns ops/crm/vk-avatar.js and vk-avatar.test.js; cabinet agent owns sites/synapse/cabinet/vk-tools.js and vk-tools.test.cjs; coordinator owns specs/docs, HTTP/wiring, direct-denial regressions and proxy integration. Separate agents research official avatar/OAuth contracts and audit tracked sync code read-only.

API: POST /vk-tools/design/avatar-preview {revision,image}; POST /avatar-apply {revision,previewId,requestId,confirmPublicPost:true} records blocked audit only; GET /avatar-history?revision=N. All remain owner/company/CSRF protected. DTO has companyCode/groupId/revision, source hash and metadata, warnings, capabilities {applyEnabled:false,cropSupported:false}. Preview before={hasPhoto,photo200,photoMax,photoMaxOrig}; absent fields are null. Application has no enabling path. Additive preview/audit tables contain no image bytes. The blocked endpoint permits auditing forged/manual confirmation attempts without granting publication authority; UI never calls it.

OAuth implementation is deferred until app eligibility and exact grants are verified. Produce an actionable architecture and nonsecret configuration checklist rather than a misleading login button. Sync audit is documentation only, not a server operation.

Validation: mocked unit/transport tests, DOM tests with isolated jsdom, actual local content-to-CRM proxy with outbound sockets disabled, full existing VK/Onlypult regression, Spec Kit gate, independent review and stacked draft PR CI. No production checks in this task.
