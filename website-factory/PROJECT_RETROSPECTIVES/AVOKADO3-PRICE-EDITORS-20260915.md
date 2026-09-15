---
knowledge_id: AVOKADO3-PRICE-EDITORS-20260915
category: PROJECT_RETROSPECTIVES
title: Avokado price and editor presentation with consistent promotion duration
project_source: AVOKADO3
confidence: MEDIUM
reuse_scope: PROJECT
created_at: 2026-09-15
source_version_head: 6cb62622da90add60e287e7768dc3a0c215dad87
status: CANDIDATE
---

Project Passport / handoff
- Goal: make the full price and editors convenient and visually consistent with Avokado3; make the route from showcase to full price visible.
- Reference: current ALVI price.html and shared price/site editor source, fetched from main. Avokado keeps its own four directions, copy, photos and booking destinations.
- Pages: Avokado3 index.html and price.html; shared Synapse price-editor.html?site=avokado and site-editor.html?site=avokado3.
- Structure: sticky brand and return button, direction/category navigation, service cards and price tables, certificates. Mobile navigation collapses and stays below the header.
- Appearance: the main Avokado3 video and poster, gold wordmark, cream text and transparent dark-green surfaces; visible gold full-price buttons for all three service directions.
- Editor: presentation layer activates only for Avokado site IDs. Existing edit/save controls and listeners are retained; Save and Return stay in the sticky bar. Header measurement positions the sidebar and sizes the canvas. Price editor now links to the Avokado3 site editor.
- User correction: all eight existing special offers have duration 45 minutes, including the first TURBO visit at 500 RUB. Embedded 60-minute promotion titles and the matching JSON-LD offer are corrected. Regular procedures and all prices remain intact.
- Laser: no duration row in public cards and no duration column in laser price tables. The editable data field is retained.

Price data integration
- Static data/price.json uses catalogVersion 3. The common AvokadoCatalog.prepare function performs the same one-time correction for existing API documents below version 3, without mutating the fetched object.
- The public showcase, public full price and price editor all use this preparation function. A later document already at version 3 retains its owner's new edits, including duration changes.
- No authenticated API PUT has been performed by this release. The existing backend document may still contain legacy values; the normal editor Save persists the prepared document. Backend save behavior has not been exercised in a browser.
- Authentication, API routes, CSRF handling, history and unsaved-change protection are preserved.

Validation
- Six catalogue regression checks pass: 48 services/6 showcased cards, shared price updates, showcase removal, laser duration suppression, migration from older API data, preservation of regular services and later editor changes, escaping and certificate fallback.
- Existing method timeline and four-photo transition checks pass, including the new seven-scene sequence with the gallery before reviews.
- New external and existing modified-page inline JavaScript parse successfully. The save/auth code and beforeunload guard match the original editor source.
- Current main and both shared editor blob SHAs were rechecked; no concurrent source changes were found.
- Browser refresh again timed out after 20 seconds on the existing editor dialog. Live desktop/mobile appearance, gallery interaction and authenticated saving remain UNKNOWN. A commit/ref update alone does not prove server delivery.

WEBSITE_PROJECT_LEARNING
- Reuse: a scoped Avokado theme around the established ALVI editor controls; a shared one-time data correction used by the display and editor.
- Rework avoided: replacing an established editor or scroll controller for a visual request.
- Main risks: old important sidebar offsets, variable header height, narrow-screen header overflow, and API data taking priority over updated static defaults. All are addressed in source; visual confirmation is still required.
- Never repeat: claim that static JSON changes necessarily update a separate content API, or claim visual success from source verification.
- Next exact action: publish the complete approved gallery assets, price and editor changes together, then verify public delivery and authenticated browser flows when the connection is available.
