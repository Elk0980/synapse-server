# ALVI — Mobile Fit (ширина, кадрирование и баннер)

Extends Project Passport in iphone-hero-20260909.md. User screenshots are real-phone evidence of a 32px strip on the main/footer and price header, a cropped k3 face, ratings crossing the first face and an oversized promo.

FACT: shared CSS gave page shells calc(100% - 2rem); price intro/layout were separately narrowed. FIX: full-width main and price shells; retain centered margins on legal documents. Remove trailing 8rem blank footer padding. Price navigation items now fit their text instead of reserving 76vw each.
FACT: a single 70% crop served different faces. FIX: per-frame mobile focal positions based on inspected unchanged assets; first ratings move to the bottom of the first-scene content. No raster or video files changed.
FACT: modal close was inside its scroll panel and old CMS strings replaced shorter text. FIX: header/close outside a single scroll body, compact side portraits on phones, eager decoding with no empty error placeholder, exact four-string CMS migration preserving new edits and offer amounts.

QA: 13 media/copy behavioral tests pass; inline JS parses; structure check confirms both offers inside scroll body and close in header. k3 face bounds fit calculated 375x667,390x700,390x844,430x932 crops. Actual mobile rendering cannot be exercised in managed browser; final visual acceptance remains user-device evidence, not inferred from these checks. Desktop live modal smoke follows publication.

WEBSITE_PROJECT_LEARNING: generic shell width fixes created visible asymmetric strips; full-page backgrounds need full-width shells, internal text padding should stay inside. Content hydration must be included when reviewing a modal. Reuse the scoped shell and modal patterns only after more device evidence.
TOP_5_TIME_SINKS: unavailable viewport control; conflicting CSS layers; legacy CMS copy; screenshot-to-asset comparison; publish/sync waits. One revision cycle; timing not measured.
NEXT: publish approved autonomous changes, verify live assets/modal and collect phone acceptance.
