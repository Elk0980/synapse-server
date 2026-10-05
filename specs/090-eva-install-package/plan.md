# Implementation Plan: Eva preparation package

Branch090-eva-install-package; Spec: spec.md; process1.0.0.

## Summary and technical context

Python3.9+ standard library builds a deterministic stored ZIP and a standalone Python preparation file containing that ZIP and a SHA256 manifest. Sources are read through git from exact commits, never from arbitrary workspace files. Linux bootstrap validates before exclusive private extraction. No subprocess, service, network or credential operation exists in bootstrap. Original setup/pairing and runtime remain unchanged.

## Constitution check

No deploy/merge permissions inferred. One writer per file. No customer/secret data. Source preparation, Linux CI and production connection remain separate states. No production or VK change is part of packaging.

## Ownership

- Root: build_package.py, build_package_test.py, PACKAGE_README.md, workflow, specs and generated artifacts outside repository.
- eva_bootstrap: package_bootstrap.py and package_bootstrap_test.py only.
- eva_source_audit: read-only original compatibility/pairing review; final independent review after implementation.

## Source baseline and contracts

Main29c10c07f27cd0b1e60dcf4c87f61236228e5c03 plus three PR443 commits ending1d7d0b5e4066de8a07cec5cd598d8af05b4cd98a were cherry-picked conflict-free into32ef85a8df6f4b76ff3d0d7cc3270d983b44c425. Package includes the exact original Eva files, reader source, and reviewed CRM integration patch; it cannot apply that patch itself. It includes the intentional PR443 sourceRef company/source isolation fix.

Manifest schema1 records source refs, file hashes, expected bot, timezone and six candidate company codes. Candidates are documentation only, not automatic scope activation. --check writes nothing. Default/--prepare makes only cwd/eva-prepared-<payload hash prefix>, mode0700, files0600, and prints the deployment blocker. Repeated preparation refuses existing output. Errors clean up only owned unchanged entries.

## Validation

Python mock pairing/setup, package adversarial/rollback tests, exact reproducibility, Linux generated command, Node reader/transport tests with real synthetic UNIX socket, CRM syntax, existing isolated image build and dormant compose validation. Git diff confirms preservation of main VK path. No live Telegram or production Docker. Immutable source artifact is not an immutable container image; mutable upstream image tag remains a deployment caveat.
