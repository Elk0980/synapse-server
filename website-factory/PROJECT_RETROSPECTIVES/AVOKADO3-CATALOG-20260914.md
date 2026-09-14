---
knowledge_id: AVOKADO3-CATALOG-20260914
category: PROJECT_RETROSPECTIVES
title: Avokado3 catalogue and price editor integration
problem: Landing price lists do not implement the requested ALVI service showcase.
context: Owner requests four directions matching ALVI reference screenshots.
solution_or_learning: Pending implementation and verification.
project_source: AVOKADO3
evidence: Live ALVI landing and price DOM; Avokado3 API 48 existing items; three owner screenshots.
confidence: MEDIUM
reuse_scope: PROJECT
created_at: 2026-09-14
source_version_head: 48c3bcc6d7425f1eabc2fc961f10c26708df685a
supersedes: []
status: CANDIDATE
---

WHAT_WE_ALREADY_KNOW: ALVI uses shared editable price data for landing cards and full price. Avokado API provides 48 items, certificates empty, durations frequently missing.
WHAT_CAN_BE_REUSED: Existing price editor authentication, upload, history, saving; ALVI paired card composition. Relevant local patterns are CANDIDATE, not VALIDATED.
WHAT_MUST_BE_TESTED: Price-to-card propagation, navigation, no missing IDs, empty data, editor save roundtrip, mobile overflow.
WHAT_IS_PROJECT_SPECIFIC: Laser, apparatus/body correction, manual/face massage, certificates. Preserve first three blocks and slide mechanic.

Project Passport:
- website_project_id: AVOKADO3-CATALOG-20260914
- business_project: Avokado
- business_goal: Help visitors choose a service and book.
- primary_audience: Studio customers in Irkutsk.
- primary_conversion: Existing online booking.
- secondary_conversions: Full price; contact studio; certificate inquiry.
- offer: Existing API prices and first-visit offers only.
- positioning: Existing Avokado identity.
- business_directions: laser, apparatus, manual/face, certificates.
- traffic_sources: UNKNOWN
- required_pages: index.html, price.html, existing price editor.
- required_integrations: /api/price and /content/avokado/price.
- analytics_requirements: Preserve current tracker; named links.
- seo_requirements: Do not alter current indexing policy.
- performance_requirements: No new frameworks/video; lazy images.
- brand_constraints: Warm green/gold; readable cards; ALVI layout reference.
- technical_constraints: Preserve self/two storage schema for existing API validation.
- conversion_hypotheses: Four clearly labelled directions reduce effort to choose; UNTESTED, metric service click-through; no conversion lift claim without analytics.
- success_criteria: Four landing sections; all 48 existing price records retained; common data source; editable selection; unknown durations show dash.
- unknowns: Current offer confirmation by owner; missing durations; certificate delivery terms.
- risks: Existing CMS overwrites old price selectors; editor shared with ALVI; cached deployment.

Builder handoff:
PROJECT: Avokado3
ЦКП: Four live price-backed service sections and editable full price.
PAGES: Landing catalogue, full price, existing editor.
FUNNELS: Direction → service → booking / contact; gift → certificate inquiry.
DESIGN SYSTEM: Existing palette, ALVI two-column photo/glass cards and aligned fact rows/actions.
COMPONENTS: Shared catalogue renderer, responsive nav, group selection in editor.
CONTENT: Existing price API; no ALVI testimonials or gift terms copied.
HYPOTHESES: Easier category choice, unvalidated.
ANALYTICS EVENTS: Existing link tracking and data-entry-point.
SEO: Preserve noindex/canonical state.
KNOWN RISKS: Empty API, old cached index, shared editor regression.
DO_NOT_CHANGE: Hero, pain scenes, method slides, contacts and booking destination.
OPEN QUESTIONS: Unspecified service durations remain unknown.
NEXT_EXACT_ACTION: Implement narrowly scoped catalogue and editor enhancements.

Checkpoint: DISCOVERY / ARCHITECTURE / CONTENT MODEL / HANDOFF complete; implementation next.

Checkpoint: IMPLEMENTATION complete. Source tests PASS: 48 records, six selected cards, shared price update, item removal, unique IDs, escaped HTML, dash for unknown duration, empty data. Inline script syntax and diff whitespace PASS. Browser became unavailable during editor inspection (repeated CDP tab timeout); visual and authenticated save roundtrip remain UNKNOWN.

WEBSITE_PROJECT_LEARNING:
- WHAT_WE_WANTED: ALVI-style cards for four Avokado directions and connected price editor.
- WHAT_WE_BUILT: Shared catalogue module, category-based showcases, full price tables, promo flag and direction fields, certificate editing, compatibility migration for initial seed.
- WHAT_WORKED: Existing API and editor schema reused without changing server permissions or validation.
- WHAT_DID_NOT_WORK: Browser connection timed out after ALVI inspection.
- WHAT_TOOK_THE_MOST_TIME: Existing content/editor mapping and browser recovery.
- WHAT_WAS_REWORKED: Full price uses compact tables for table categories instead of duplicating all services as large cards.
- WHY_REWORK_WAS_NEEDED: Match ALVI price behavior and avoid excessive page height.
- WHAT_SHOULD_BE_REUSED: One renderer fed by editable data, preserving unknown values.
- WHAT_SHOULD_NEVER_BE_REPEATED: Changing unrelated slide behavior during catalogue work.
- WHAT_SHOULD_BE_AUTOMATED: Data propagation and unique anchor regression tests.
- WHAT_WE_STILL_DO_NOT_KNOW: Real mobile rendering and authenticated save roundtrip pending.

TOP_5_TIME_SINKS: content routing discovery; sparse checkout; source editor review; browser timeout/retry; duplicate-anchor correction.
Timing estimates: discovery 8m, architecture 3m, wireframe 0m (owner reference), design/content 8m, implementation/checks 12m, revision_cycles 1, handoff 2m; approximate, no measured conversion results.
Next exact action: Publish and verify delivered files; complete visual/editor checks when browser available.
