# Tasks: Eva preparation package

## Phase 1: Baseline
- [x] T001 Audit current PR443 and read repository instructions in isolated worktree.
- [x] T002 Integrate exact PR443 sources onto main29c10c0 without editing VK and audit source differences.

## Phase 2: Verifiable preparation (US1)
- [x] T003 [US1] Implement deterministic source allowlist builder in ops/eva-tasks/build_package.py and reproducibility tests.
- [x] T004 [P] [US1] Implement safe offline extraction and rollback in ops/eva-tasks/package_bootstrap.py with adversarial tests.
- [ ] T005 [US1] Generate standalone file, ZIP, checksum manifest and literal one-command instruction outside the repository.

## Phase 3: Honest connection boundary (US2)
- [x] T006 [US2] Write ops/eva-tasks/PACKAGE_README.md with exact deployment blockers and personal pairing sequence.
- [x] T007 [US2] Run original mock setup/pairing and reader regression tests on combined main; preserve original secrets contracts.

## Phase 4: Validation
- [ ] T008 Validate Linux generated command, rollback, source reproducibility and existing Eva tests in isolated CI.
- [ ] T009 Obtain independent final review and record spec convergence and evidence.
- [ ] T010 Deliver immutable files, SHA256 and remaining operator actions; perform no server operations.

Dependencies: T001-T002 precede implementation. T003/T004 can run independently; T005 depends on both and T006. T008-T010 follow implementation.
