---
knowledge_id: AVOKADO3-RESULTS-GALLERY-20260915
category: PROJECT_RETROSPECTIVES
title: Full-frame results gallery before reviews
problem: Prospects need real examples before the review and visit explanation slides.
context: Owner supplied a Drive folder with 14 before-and-after collages.
solution_or_learning: One additional scene with manual category browsing and full-size viewing, preserving each source collage.
project_source: AVOKADO3
evidence: All 14 files downloaded and visually inspected; metadata and seven-scene timeline tests pass. Publication of images blocked by automatic review.
confidence: MEDIUM
reuse_scope: PROJECT
created_at: 2026-09-15
source_version_head: 6cb62622da90add60e287e7768dc3a0c215dad87
supersedes: []
status: CANDIDATE
---

Project Passport / handoff
- Goal: show real examples between the existing objections slide and reviews.
- Audience: studio prospects on desktop and phone.
- Page: Avokado3 main page, inside the existing method presentation.
- Funnel: objections → results → reviews → four visit pairs → catalogue.
- Content: 12 body-correction collages and 2 laser-epilation collages. These are image counts, not unique client counts. No new numerical result claims.
- Design: existing cream, gold and green; two complete images on desktop, one on mobile, filters and manual arrows, native horizontal swipe, enlarged image dialog.
- Data: full source dimensions retained; WebP quality 90; total 840178 bytes. No crop, retouch or AI modification. Object-fit contain keeps source labels visible.
- Accessibility: keyboard controls, focus return after dialog, current category state, live position label, reduced-motion support, direct image-link fallback.
- Integration: insert method-results before method-4 without renaming existing CMS IDs. Visit target resolves from its stable method-5 ID. Total weighted duration becomes 14.6 units; original objections timing is preserved.
- Do not change: existing review backgrounds, ratings, visit text, prices, booking links and unrelated music draft.
- Analytics: no conversion effect measured or claimed.
- Verification: JavaScript syntax, fourteen local assets, two category counts, unique IDs and complete scene order pass. Timeline tests cover original timing and all four later visit holds. Browser and mobile visual QA remain UNKNOWN because the browser connection fails on an editor prompt.

Publication checkpoint: BLOCKED / CODE READY.
The owner requested immediate publication. Automatic review rejected the first Drive image upload, then rejected a single retry after metadata confirmed public link access for every image and ownership of the GitHub destination. It requires explicit authorization naming the Drive source and public Elk0980/synapse-server destination. No image was uploaded and no further route was attempted.

The main branch contains only the completed visit-photo sequence and catalogue transparency changes. This draft adds the gallery code and updated tests but deliberately has no result image blobs. Do not merge or publish this branch until the 14 result assets are approved and included. The private photo pack is Avokado3-results-photos-ready.zip; assets/result-01-20260915.webp through result-14-20260915.webp match this source.

WEBSITE_PROJECT_LEARNING
- Wanted: proof from the owner's real materials before the reviews slide.
- Built: complete native gallery with whole-image display, two categories, arrows, swipe and an accessible enlarged view.
- Worked: source inspection, lossless framing, concise category assignment, preservation of earlier scroll intervals, isolation from the live release.
- Did not work: public image-upload approval; browser recovery.
- Main time sinks: repeated browser timeouts, publication authorization checks, slow binary transfer approvals.
- Reworked: separated the core release from the gallery so the unaffected requested changes could ship.
- Reuse: stable scene IDs and explicit timeline tests when adding a scene to an established presentation.
- Never repeat: claim visible success from a source commit or HTTP hash alone; activate a gallery whose image publication is blocked.
- Automation candidate: source/destination publication scope recorded before asset transfer, with no bypass after rejection.
- Unknown: desktop visual quality, mobile fit, dialog interaction and conversion effect.
