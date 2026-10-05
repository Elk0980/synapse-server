# Tasks

## Phase 1: Contracts
- [x] T001 Audit baseline and establish isolated branch and scope.
- [x] T002 Record official VK API contracts and unsupported capabilities (FR-008).

## Phase 2: Implementation
- [x] T003 Implement album list, bounded preview, confirmed upload and journal/readback (FR-001, FR-004, FR-005).
- [x] T004 Implement safe incoming attachments and frozen manual reply preview/confirm (FR-002, FR-003, FR-004, FR-005).
- [x] T005 Implement cabinet destination/content previews, invalidation and explicit confirmations (FR-006).
- [x] T006 Wire owner/company HTTP and proxy routes; preserve Onlypult (FR-007).

## Phase 3: Verification
- [x] T007 Run mocks, DOM/proxy tests and VK/Onlypult regressions (SC-001, SC-002).
- [x] T008 Review candidate and converge against requirements; record evidence and gaps.
- [ ] T009 Open draft PR and check exact-commit CI (SC-003); do not merge/deploy.

## Phase 4: Convergence
- [x] T010 Classify internal/unknown VK errors as uncertain for inbox saves and sends per FR-004 (contradicts); test error 1/10/36 and unrecognized errors, without repeated dispatch.
- [x] T011 Recover safely from an expired preview rejected before dispatch per FR-006 (partial); preserve locks for network ambiguity.
- [x] T012 Reconcile a known late reply outcome with its original scope after company navigation per FR-006 (partial); never render old content in the new company.
