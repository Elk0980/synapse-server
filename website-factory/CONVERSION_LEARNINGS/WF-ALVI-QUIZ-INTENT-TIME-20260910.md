---
knowledge_id: WF-ALVI-QUIZ-INTENT-TIME-20260910
category: CONVERSION_LEARNINGS
title: Match a recommendation action and time label to the visitor's intent
problem: A gift recommendation retained a service-booking action; a one-hour option returned a ninety-minute program.
context: ALVI prepublication review with an existing owner-approved layout and fixed service catalog.
solution_or_learning: Route gift results to certificate ordering, reset service results to booking, and use three owner-accepted time ranges containing existing recommendation durations.
project_source: docs/alvi/prepublication-review-20260910.md
evidence:
  - Owner accepted these two fixes after reviewing screenshots.
  - 27 recommendation combinations checked; duration ranges verified against price.json.
  - Browser checked gift-to-service reset, mobile result and desktop gift result.
  - 25 total Node tests passed; follow-up viewport metrics stored separately.
confidence: HIGH
reuse_scope: WEBSITE_FACTORY
created_at: 2026-09-10
source_version_head: 3631e58655cc348a83b30d51e124c4e1b30ab1cf
supersedes: null
status: CANDIDATE
---

No conversion uplift is claimed. Reuse only where the catalog contains mixed service/gift intents; do not make arbitrary time ranges a global standard.

WEBSITE_PROJECT_LEARNING
- WHAT_WE_WANTED: complete the accepted navigation and funnel fixes before promotion.
- WHAT_WE_BUILT: responsive price navigation/tables plus gift-specific CTA and catalog-fitting time labels.
- WHAT_WORKED: keep service data unchanged; enumerate recommendation cases and exercise gift → service reset in the UI.
- WHAT_DID_NOT_WORK: an immediate screenshot caught the previous render; a fresh DOM check and settled screenshot resolved the discrepancy.
- WHAT_TOOK_THE_MOST_TIME: recovering source/browser context and determining the authenticated task-writing path.
- WHAT_WAS_REWORKED: the proposed duration restriction became three time ranges at the owner's request.
- WHY_REWORK_WAS_NEEDED: preserve the simple accepted quiz and existing catalog.
- WHAT_SHOULD_BE_REUSED: check intent-specific destinations and data compatibility alongside visual breakpoints.
- WHAT_SHOULD_NEVER_BE_REPEATED: call a prepared JSON payload a created CRM task, or claim native-device testing from viewport emulation.
- WHAT_SHOULD_BE_AUTOMATED: recommendation/catalog compatibility checks at content-update time.
- WHAT_WE_STILL_DO_NOT_KNOW: native mobile browser behavior, final YCLIENTS attribution and the cheaper couple-program validity.

TOP_5_TIME_SINKS: context restoration; task service discovery; unavailable authenticated cabinet; preview cold start; stale-frame screenshot verification. Approximate follow-up metrics: discovery 8 min; architecture/content 4 min; wireframe/design 0 min (existing layout retained); implementation/QA 12 min; handoff/release pending; revision_cycles 1. Estimates only, not measured throughput.

Hypothesis: an intent-matched CTA reduces wrong-path transitions. Acceptance: every gift result targets certificate contact, every ordinary result targets booking, including switching selections. Conversion impact requires real post-launch analytics.
