# VK avatar preparation and connection readiness

Owner scope: development, mocks and a separate draft PR stacked on immutable PR450 / dbb5f0759fd8a7ec50a5a6ade6069c728568811b. No merge, production/server/timer access, user browser, credentials, OAuth grant, permission changes, real uploads or messages.

## Requirements

- FR-001: Owner can prepare a square JPEG/PNG up to 8 MiB for the checked user-type design binding of the selected company. The server validates the image and reads current avatar metadata with groups.getById only. Persist metadata and SHA-256, never source bytes or provider secrets.
- FR-002: Avatar application is unconditionally disabled. No environment/UI/body switch, upload transport or saveOwnerPhoto allowlist is introduced. A valid explicit confirmation creates a blocked audit entry without any VK call. This is preparation, not a functional avatar mutation.
- FR-003: Preview and blocked audit are scoped by company, group and binding revision; previews expire after 30 minutes. Request/preview replay is durable and never starts a write. Foreign/changed bindings, invalid confirmation and forged enabling fields fail closed.
- FR-004: UI shows approximate square/circle previews of a prepared square image. It explains that VK may create a public wall post, crop API is unverified, and separate approval plus confirmed API access are needed before a later implementation can enable application. Confirmation controls remain disabled even if a response claims otherwise. Changing company, binding or source invalidates previews.
- FR-005: Document primary-source avatar contract, uncertainty about crop and minimum scopes, and current OAuth options/eligibility. Distinguish VK ID login from authority for legacy VK API mutations. Do not invent scopes, app eligibility or OAuth routes.
- FR-006: Document a secret-free code audit of sync authentication and the separately authorized production read-only preflight. The reported expired PAT is an unverified dependency; local/CI/public GitHub access cannot verify production authorization.
- FR-007: Preserve PR450, existing Onlypult publishing, inbox and design/material behavior. Tests are synthetic/mocked and cover owner/company/CSRF boundaries, image safety, no avatar external writes, durable blocked audit and DOM invalidation.

## Acceptance

- SC-001: Backend, HTTP/proxy and DOM tests prove FR-001 through FR-004 and FR-007 without live VK or credentials.
- SC-002: Readiness documents link official evidence and name only the minimal nonsecret owner inputs; unsupported crop/scopes/grants remain explicit blockers.
- SC-003: Independent review, local regression suite, Spec Kit convergence and draft PR CI are recorded separately from deployment/live acceptance.

## Deferred release work

Avatar upload/save/readback reconciliation and operational OAuth are not delivered here. They require a separately approved public-post effect and a confirmed app-specific API grant. No video, market/menu, background work or automatic replies are added.
