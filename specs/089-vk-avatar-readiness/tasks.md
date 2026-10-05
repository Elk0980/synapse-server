# Tasks

## Phase 1: Preparation

- [x] T001 Isolate worktree at frozen PR450 and read project/Spec Kit instructions.
- [x] T002 Verify official avatar upload/save contract and absence of a verified suppression/crop contract.
- [x] T003 Document official OAuth readiness and minimal nonsecret owner inputs in docs/vk-connection-readiness.md.
- [x] T004 Document tracked sync auth audit and separately authorized read-only release preflight in docs/vk-release-auth-preflight.md.

## Phase 2: Implementation

- [x] T005 Implement metadata-only avatar preview and durable blocked apply audit in ops/crm/vk-avatar.js with mock tests.
- [x] T006 Wire owner HTTP/proxy routes; verify avatar upload/save remain denied in direct transport.
- [x] T007 Add avatar preparation UI with immutable disabled confirmation and DOM tests.
- [x] T008 Add primary-source avatar contract and limitations to docs/vk-avatar-readiness.md.

## Phase 3: Verification

- [x] T009 Run focused and full regressions, Spec Kit gate and convergence; record evidence.
- [x] T010 Independent review of final candidate; fix concrete findings and rerun affected checks.
- [ ] T011 Publish separate stacked draft PR and inspect CI at the exact head; report without merge/deploy.

## Phase 4: Convergence

Requirements FR-001 through FR-007 and local acceptance SC-001/002 are covered by the implementation, primary-source documents and executed checks in evidence.md. No additional implementation gaps were found. External delivery SC-003/T011 is intentionally tracked in the draft PR after source commit creation, so CI reporting does not require a further source change. Functional avatar mutation and live OAuth remain explicitly deferred by the spec, not silently counted as completed features.
