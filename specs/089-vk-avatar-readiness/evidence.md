# Evidence

## Recovery and scope

On 2026-10-05 the executor became available again. The isolated 089-vk-avatar-readiness worktree still had base dbb5f0759fd8a7ec50a5a6ade6069c728568811b and its intended uncommitted changes. The previously uncertain writes of vk-avatar.js and vk-connection-readiness.md had not happened: both files were absent. They were reconstructed without reset/clean or edits to another worktree. The remaining avatar source reference was cleared on role loss; the clear-file DOM assertion was completed.

PR450's checkout was clean and its remote head was independently checked as dbb5f0759fd8a7ec50a5a6ade6069c728568811b, draft and unmerged. Work is stacked on its branch. No existing Onlypult, inbox, direct transport implementation, credentials, grant, server, timer, user browser or real VK operation was changed.

## Executed local checks (2026-10-05)

- Full vk-direct-tools workflow command from quickstart: **243/243 pass, 0 fail, 0 skipped**. This includes the prior 218 regressions, 17 avatar backend tests, 7 avatar DOM tests and one additional HTTP test.
- DOM tools plus community: **55/55 pass**. Backend avatar alone: **17/17 pass**.
- Spec Kit prerequisites pass; gate validates **48 files**; gate unit tests **5/5 pass**.
- Full diff reviewed against the base, including server's four-line integration change and existing behavior; git diff --check passes. No unrelated deletions or new dependencies.
- UI/HTTP independent reviewer: no findings; independently ran **29 tools DOM tests** and **9 HTTP/local proxy tests**. Exact-commit confirmation is recorded in the PR after commit creation.

The proxy fixture starts temporary content/CRM services with synthetic identity and credentials, blocks outbound sockets and asserts avatar preview makes only groups.getById. Blocked confirmation, duplicate confirmation and forged enable flags never call the provider. Existing album upload/description mocks and Onlypult rows remain correct. No live provider compatibility or token eligibility is claimed.

## Coverage and limitations

FR-001/003: square image and metadata validation, no source BLOB/base64 persistence, unknown fields, unsafe URLs, scoped checked user binding, post-await revision/connection changes, concurrent quota, 30-minute expiry, durable blocked request/preview replay and retained audit are covered by vk-avatar.test.js.

FR-002/004/007: no avatar upload/save transport or enabling flag; UI has no apply handler, rejects forged capability flags and drops stale source/company/role responses. HTTP/proxy enforce owner, company, revision, CSRF and bounded request sizes. Existing Onlypult and manual inbox regressions pass.

FR-005/006: primary-source contracts, app-specific unknown grants and separate nonsecret sync audit are documented. Avatar crop, exact minimum scopes and a functioning OAuth grant remain unresolved. The shared image parser is structural validation, not a full image decoder; this increment sends no image to VK. No functional avatar mutation or OAuth code is delivered.

## Independent review and convergence

Backend reviewer found no concrete defects and independently ran **29/29 avatar/backend/HTTP/direct-denial/local proxy tests**. UI/HTTP reviewer also found no defects, as recorded above. Both reviewed bounded changes without writing files or using live providers. Exact-commit reconfirmation follows in the PR metadata after source commit creation.

The coordinator checked all FR-001 through FR-007 against implementation and documents, and SC-001/002 against actual tests/research. No additional buildable gap remains within the preparation-only spec. SC-003/T011 is external delivery: CI links, exact head SHA and final delivery status are recorded in the draft PR after publication; its pending source checkbox is not a claim of failed local tests. No merge, deployment, release approval, public-post permission or working OAuth grant is implied.
