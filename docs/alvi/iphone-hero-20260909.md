# ALVI — iPhone Hero (видео и верхняя шапка)

## Project Passport / builder handoff
PROJECT: ALVI
ЦКП: opening video can start/resume while the first scene is visible; logo stays at the top of the intro.
BUSINESS GOAL: remove broken first impression before paid traffic.
AUDIENCE: mobile visitors, including iPhone and iPad.
PAGES / FUNNELS: main intro → services → booking.
DESIGN SYSTEM / COMPONENTS: existing logo, media and compact scenes; small explicit play fallback only when autoplay is blocked.
CONTENT / SEO: no factual copy or price changes.
ANALYTICS EVENTS: no new tracking required; no uplift claimed.
DO_NOT_CHANGE: photos, desktop scrub video, service content, reduced-motion preference.
NEXT_EXACT_ACTION: replace scroll-retired idle behavior with scene eligibility, then verify behavior and publish via PR.

WHAT_WE_ALREADY_KNOW: screenshot shows logo below content; source places sticky header after full-height media. Any 4px scroll retired opening video; play rejection offered no retry.
WHAT_CAN_BE_REUSED: supplied logo, existing MP4/WebM, poster fallback, compact scene observer. Relevant VALIDATED factory records: EMPTY.
WHAT_MUST_BE_TESTED: small scroll during loading, scene leave/return, autoplay refusal/click, visibility, reduced motion, header anchoring, desktop playback.
WHAT_IS_PROJECT_SPECIFIC: screenshot copy (4.8 and 1300–12000) matches a legacy local ALVI build, while canonical live root currently shows 4.9 and two ratings. Screenshot URL UNKNOWN; don't modify legacy hosting by assumption.

FACT: canonical root URL verified in browser; no inference that the screenshot is current.
OWNER_ASSUMPTION: none required.
DECISION: anchor compact header absolutely at top, prefer MP4 on iOS, preserve poster if video is unavailable.
DESIGN_HYPOTHESIS: explicit play fallback permits blocked-autoplay visitors to start motion; measure by successful play in behavioral tests and real-device acceptance. No conversion evidence yet.
EVIDENCE: user screenshot, source inspection, regression tests to follow.

Bottleneck: missing mobile viewport in managed browser. SYSTEMIC_PROBLEM, recurrence >=3: AUTOMATION_REQUIRED — supported mobile preview or a real-device QA runner needed; don't claim desktop inspection validates iPhone.

## Implementation checkpoint
- Header is absolutely anchored to the hero top, with safe-area padding and a separate mobile content offset.
- Opening video controller keys eligibility to first scene in compact mode; MP4 preferred on iOS. Denied autoplay has a synchronous click retry. Scene/lifecycle changes pause/resume without reloading.
- Nine mocked behavioral tests PASS; eight inline scripts parse. Integration review and live desktop smoke follow publication. Real-device iPhone rendering remains UNKNOWN.

## WEBSITE_PROJECT_LEARNING
WHAT_WE_WANTED: visible opening motion and a top-aligned mobile brand.
WHAT_WE_BUILT: scene-based media lifecycle plus anchored header.
WHAT_WORKED: source diagnosis and media-promise/lifecycle tests.
WHAT_DID_NOT_WORK: previous PR confirmed asset delivery and syntax but missed small-scroll retirement and normal-flow header placement.
WHAT_TOOK_THE_MOST_TIME: restricted mobile preview and tracing a screenshot with legacy copy.
WHAT_WAS_REWORKED: one-shot idle startup, scroll threshold and sticky header.
WHY_REWORK_WAS_NEEDED: mobile behavior had not been exercised end to end.
WHAT_SHOULD_BE_REUSED: eligibility-driven media lifecycle and explicit autoplay recovery.
WHAT_SHOULD_NEVER_BE_REPEATED: equating fetched new CSS with a successful iPhone UX.
WHAT_SHOULD_BE_AUTOMATED: real-device or supported mobile viewport smoke checks.
WHAT_WE_STILL_DO_NOT_KNOW: user's screenshot URL and current iPhone autoplay policy.

TOP_5_TIME_SINKS: absent mobile viewport; legacy screenshot identity; prior insufficient regression coverage; browser scroll timeouts; GitHub publish/sync latency.
Approximate time estimates: discovery 5 min; architecture/design 3 min; content/wireframes not applicable; implementation/tests 8 min; handoff 1 min; revision cycle 1 in this correction. These are estimates, not measured timings.
