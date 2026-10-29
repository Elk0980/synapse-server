# Palitra: nullable render and explicit draft saving

Spec: specs/092-palitra-order-customer-forms

This release changes two existing cabinet files. The shell skips actual nullable body entries; the composer says “Сохранить черновик” and explains that choosing a date does not schedule delivery. Editing, save payloads, consent, permissions and public SHOP sources are unchanged.

The installer publishes exactly two static files using fresh root-owned lease, compare-and-swap for both files before the first replacement, per-target backups, fixed image IDs, environment/price guards and an independent inspect. No runtime, database, queue, site-editor, price or service lifecycle writes are present. A completed or partial apply cannot be replayed. Build the manifest only after fresh native inspection; invoke stage, prepare, apply once, then inspect separately. Browser and public resource verification remain required.

Offline validation: `python ops/palitra-customer-static-20261029-r1/test_install.py`. The symlink fixture can skip when Windows lacks symlink permissions. Private UI tests and screenshots remain outside this repository.

Status29Oct: installed once and independently read back. Existing-query public resources and the prior staff session were personally verified at320/390; no runtime/database/restart writes. Full customer-form specification remains in progress.
