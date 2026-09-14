---
knowledge_id: WF-CATALOG-SHARED-PRICE-20260914
category: TECH_FIXES
title: Preserve live prices while upgrading an initial catalogue seed
problem: Adding showcase metadata in static data can overwrite live editor prices or leave initial API data without cards.
context: Avokado3 migration from initial version-one price seed to a four-direction catalogue.
solution_or_learning: Keep API values authoritative; supplement only missing display metadata. Replace initial showcase selection only when version, timestamp, original title and original selection all match the untouched seed. Explicit schema marker stops migration after editor save.
project_source: AVOKADO3
evidence: Node renderer tests for live price propagation, removed card selection, unique anchors, escaping and 48-record retention. Authenticated save and mobile visual checks pending.
confidence: MEDIUM
reuse_scope: WEBSITE_FACTORY
created_at: 2026-09-14
source_version_head: 48c3bcc6d7425f1eabc2fc961f10c26708df685a
supersedes: []
status: CANDIDATE
---
Never treat static fallback prices as newer than a valid live document. Do not hardcode offer savings independently from editable prices. Seed migrations need explicit untouched-seed detection; normal edited documents must retain their selections.
