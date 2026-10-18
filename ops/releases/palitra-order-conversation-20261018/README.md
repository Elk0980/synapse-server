# Palitra order conversation — code package

This package contains a Root-only installer and eight application source files. The change adds one configured greeting per newly created order and a shared conversation view using existing authorized session grants.

The ZIP has exactly eleven files: two Python entrypoints, one manifest, five backend files and three UI files. The staging script verifies the ZIP, manifest, all before/after hashes, reversible hunks and frozen code references. It creates a new private code namespace and refuses an existing destination. Staging performs no build, deployment or database write.

The installer requires the exact accepted source209/static26/chain25 baseline and a fresh exclusive Root lease. It preserves the three existing cabinet modes0600, builds one child image and performs one content update. Worker, authentication, rights, queues and historical journals remain guarded. No data backfill or automatic retry/rollback is included.

Use `prepare_packet.py` with an immutable40-character commit URL to the adjacent `code-r1.zip`. Verify its published hash before native execution. Installation and customer/device acceptance are separate steps.
