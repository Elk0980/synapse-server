# Evidence

Initial compatibility audit: PR443 remains draft at1d7d0b5e4066de8a07cec5cd598d8af05b4cd98a. Three commits cherry-picked without conflicts onto main29c10c07f27cd0b1e60dcf4c87f61236228e5c03. Original Eva and reader sources identical; inherited VK preserved. Windows original tests: Python60/60; Node103 pass,1 Linux-only skip. This is not Linux or production proof. Packaging implementation and Linux validation pending.

Packaging implemented: deterministic explicit source allowlist, unchanged-builder check against selected commit, diff formatting pinned against user Git preferences, standalone payload/manifest SHA checks, exact22file boundary and Linux exclusive private extraction. Existing target and credentials are never read or overwritten. Bootstrap has no network/service/subprocess path. Windows Python suite98tests:86pass,12 Linux filesystem tests skipped; CRM syntax, diff check and Spec Kit48 pass. Adversarial archive checks are portable; real fd/mode/rollback tests await Linux CI. CI explicitly uses PR head SHA for package construction instead of synthetic merge SHA. Both archive and command are generated only from committed sources.

Independent initial audit found Git diff preferences and builder provenance gaps; both corrected with regression tests. Inherited full-checkout test commands are explicitly separated from standalone preparation in PACKAGE_README.md. Final Linux results, exact artifact checksums and independent extraction review will be recorded in the PR and delivery handoff after checks finish; production is not part of this evidence.

## Frozen delivery evidence

Delivery source commit is **7addf2a476a3d75ca575a1acaae4c41cfc8403a9**. Later evidence-only commits do not rename or rebuild this frozen artifact. The builder itself must match this commit; its SHA is embedded in the package manifest.

- [Linux Eva CI37262714044](https://github.com/Elk0980/synapse-server/actions/runs/37262714044):104/104 Node,98/98 Python,0 skipped; real synthetic UNIX socket, Linux fd/mode/rollback, mock pairing, CRM syntax, isolated image build and dormant Compose validation succeeded.
- Two Linux builds matched byte-for-byte. Literal COMMAND.txt succeeded, and a repeated run refused the existing directory. Windows builds and Linux CI report identical hashes below.
- `eva-prepare-7addf2a476a3.py`: SHA256 `24a9afcd4f385f7c124a9d63479c35e8ed3049944b8747d63a8b0bafdaa059a4`.
- `eva-prepare-7addf2a476a3.zip`: SHA256 `2722ab87e6a62a8779d039b49340397b3a306d16641d1200733e21f7f91f4fe6`.
- Independent final review PASS on source7addf2a. GIT_DIFF_OPTS was explicitly removed from child Git environment, with the reproduced overriding-config case added to the regression test.
- [VK regression37262713988](https://github.com/Elk0980/synapse-server/actions/runs/37262713988) and [Spec Kit37262713925](https://github.com/Elk0980/synapse-server/actions/runs/37262713925) succeeded. General project CI is tracked independently in PR452.

Spec converge: FR001-FR008 and SC001-SC004 checked against builder/bootstrap/tests/readme/delivery. No missing implementation within preparation scope. Production reader release, socket configuration, owner pairing and bot activation remain explicitly outside this task. No credentials, server deployment, timer operation or live Telegram call was performed.
