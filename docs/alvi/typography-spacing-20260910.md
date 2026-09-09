# ALVI — Typography and Quiz Spacing (шрифт и интервалы квиза)

## Project passport / builder handoff
PROJECT: ALVI; source main de2deffb8f1e51c810eedcd1b82c1e8034b7df14.
ЦКП / BUSINESS GOAL: a readable quiz and consistent, restrained typography without isolated punctuation below the promotional price.
AUDIENCE / FUNNELS: phone, tablet and desktop visitors selecting self/couple/gift services; existing booking and certificate paths.
PAGES: index, price and public legal pages where the same system sans-serif stack appears.
FACT: owner screenshots IMG_9397/9398 show the question touching the answer border, a heavy sans-serif price and an isolated full stop after the offer.
WHAT_WE_ALREADY_KNOW: live DOM confirms zero legend-to-options spacing and a 600-weight system font on the price; the trailing dot is supplied by CMS text. Relevant factory records are CANDIDATE; no matching VALIDATED record found.
WHAT_CAN_BE_REUSED: existing Lora font, native fieldset/radio controls, current promo layout and safe CMS renderer.
WHAT_MUST_BE_TESTED: real gap above every first answer; no price punctuation on its own line after hydration; ordinary follow-up sentences preserved; narrow controls and mobile tables fit after the font change.
WHAT_IS_PROJECT_SPECIFIC: owner requests replacement of the font used by «500 ₽» throughout this public site. Interpret this as replacing the system sans-serif interface stack with existing Lora, not changing content or prices.
DESIGN SYSTEM / COMPONENTS: Lora regular price, Lora regular/medium controls; 10px separation before answers, only small changes to existing option/action spacing.
CONTENT / SEO / ANALYTICS: existing prices, claims, page metadata and events retained. Only a terminal full stop following the formatted promotional offer is removed on display.
HYPOTHESIS: restrained type and a small real gap improve visual separation; no measured conversion increase claimed.
SUCCESS CRITERIA: 10px answer separation, price font weight 400, no horizontal overflow at representative 320–1920px widths, unchanged booking destinations, no new external font dependency.
DO_NOT_CHANGE: images, animation, program data, quiz mapping, approved page composition, CRM or authentication.
KNOWN RISKS: CMS desktop transforms are existing project data; responsive Chromium QA does not certify physical Safari/Android behavior.
NEXT_EXACT_ACTION: apply the targeted CSS and promo punctuation fix, inspect responsive QA, publish through PR under standing authorization.

## Checkpoint
DISCOVERY / HANDOFF: complete. Current source hashes checked against main; refreshed stale local copies of legal pages and the unchanged mobile-performance script before QA.
IMPLEMENTATION: public interface and legal-body system/sans font declarations replaced with the existing Lora stack; banner price is regular 400, primary card actions medium 500. Quiz options use padding above the first answer so float clearance cannot swallow the visual gap. Terminal promo punctuation is consumed only when it ends the price sentence.
QA: 30 Chromium viewport configurations passed. Main and price checked at 320, 390, 768, 899, 900, 1366 and 1920px; open promo at 320, 390, 768 and 1366px; oferta, politika, soglasie and 404 at 320, 768 and 1366px. No page, checked text/button, or price-table horizontal overflow. All three first-answer gaps measure 10px. Promo price weight is 400, its final child is the offer rather than a detached dot, and both promo actions retain 46px height. Fonts reported loaded in main-page checks. Screenshots inspected for mobile quiz and mobile/desktop promo.
REGRESSION: five existing site-copy tests pass with added assertions for terminal punctuation removal and preservation of subsequent sentences; arbitrary cabinet price changes remain supported. JavaScript syntax check passed. No new test suite for CSS-only changes.
LIMITS: viewport simulations in Chromium, not physical Safari or Android; CMS may contain its own layout transforms. Native device behavior and external booking completion are outside this typography change. Existing booking links, program data, photographs and animation logic are unchanged.
RELEASE: QA complete; prepare PR, merge under standing owner authorization and verify production assets and rendered text.

## WEBSITE_PROJECT_LEARNING
WHAT_WE_WANTED: slight quiz separation and lighter, consistent type.
WHAT_WE_BUILT: real 10px answer spacing, Lora controls and price, terminal promo punctuation handling.
WHAT_WORKED: padding after cleared floating legends; reusing the existing font avoids adding another font load.
WHAT_DID_NOT_WORK: the old margin-top did not produce a visible gap; a flex offer left the CMS sentence dot as a separate line.
WHAT_TOOK_THE_MOST_TIME: source/cascade discovery and browser screenshot timeouts, rather than the patch itself.
WHAT_WAS_REWORKED / WHY: refreshed stale local baseline pages before editing; screenshot capture retried only after confirming page state.
WHAT_SHOULD_BE_REUSED: inspect real rendered spacing and the complete CMS-transformed sentence.
WHAT_SHOULD_NEVER_BE_REPEATED: treating a declared margin as proof of visible spacing; enlarging prices without checking punctuation flow.
WHAT_SHOULD_BE_AUTOMATED: retain regression coverage for CMS price formatting and immutable source provenance for local QA copies.
WHAT_WE_STILL_DO_NOT_KNOW: conversion effect and physical-device behavior.
TOP_5_TIME_SINKS: cascade/source discovery; refreshing stale QA sources; preview startup; intermittent browser screenshot timeouts; required release and artifact persistence. No customer access or approval delay in this iteration.
SPEED: one implementation revision. Discovery and QA dominate this small change; individual stage wall times were not instrumented, so no precision or speed improvement is claimed.
