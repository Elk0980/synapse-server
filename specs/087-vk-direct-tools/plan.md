# Implementation plan

Process 1.0.0. Base f6a93da88d8d9b67ec74dccf096c8a1dd6779bcb, branch 087-vk-direct-tools, isolated vk-integration-work checkout. Stack: Node 24 node:sqlite, existing content proxy and cabinet JavaScript. No dependencies or live keys required.

## Ownership and increments
- Root: specification, ops/crm/server.js, ops/content/server.js, new ops/crm/vk-tools-http.js and route tests, docs and CI. Fresh targeted patches only.
- Analytics agent: ops/crm/vk-direct.js and tests, ops/crm/social-adapters.js and focused analytics tests. Shared direct connection contract agreed before consumers.
- Design agent: ops/crm/vk-design.js and tests. No edits to direct connector or root server files.
- UI agent: sites/synapse/cabinet/vk-community.js/css and tests plus new vk-tools.js/css if needed. No backend edits.
- API researcher/reviewer: read-only contract and independent review.

## Architecture
vk-direct owns separate company+purpose credential rows and a narrowly allowlisted internal VK transport. Analytics injects it into the existing collector; design consumes its checked group binding. A separate design journal stores immutable previews, before/after hashes, source hash and logical request results. No new project chat or publishing queue. The cabinet extends its VK area with independent analytics/design panels and retains the existing messages panel.

## Production boundaries / rollback
No deployment, credentials, grants, callback/Long Poll enablement or customer sends. Additive tables; disable new connection to stop direct operations without touching Onlypult. Description restore is guarded by current readback. Cover restoration may need a prior original image: expose that limitation before apply.

## Validation
Unit tests with synthetic tokens/provider replies, adapter regression suite, owner/company HTTP and proxy tests, DOM stale-response and preview tests, node --check, Spec Kit gate and independent security/correctness review. No external mutations during tests.
