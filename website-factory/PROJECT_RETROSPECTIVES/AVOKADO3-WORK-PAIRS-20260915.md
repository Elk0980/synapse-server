---
knowledge_id: AVOKADO3-WORK-PAIRS-20260915
category: PROJECT_RETROSPECTIVES
title: Sequential photographs and text for How we work
problem: Four simultaneous text cards do not show the visit one step at a time.
context: Existing sixth method scene on Avokado3; owner is supplying one photograph per step.
solution_or_learning: Prepare paired photo and copy scenes controlled by the existing single scroll timeline.
project_source: AVOKADO3
evidence: Four owner-specified photo assignments; timeline and transition tests pass; visual QA and publication blocked.
confidence: MEDIUM
reuse_scope: PROJECT
created_at: 2026-09-15
source_version_head: 04f63bd35a212ad9dd99aa1fd7cd68b51c62f336
supersedes: []
status: CANDIDATE
---

WHAT_WE_ALREADY_KNOW: Four existing steps with editable text; the method block already has one weighted scroll controller. The six-beat objections scene precedes reviews and this target scene.
WHAT_CAN_BE_REUSED: Existing sticky shell, text nodes and timeline. WF-CUMULATIVE-SCROLL-CMS-20260915 is CANDIDATE, not a validated default.
WHAT_MUST_BE_TESTED: Pair order, reverse and idle stability, original objection timing, final reading hold, no hidden focus targets, phone layout and CMS hydration.
WHAT_IS_PROJECT_SPECIFIC: Images supplied by the owner. Step 1 is 2A3A0224.jpg; step 2 is _W5A9221.jpg; step 3 is _W5A9227.jpg; step 4 is TARGET-door-desktop(1)(1).png.

Project Passport / builder handoff:
PROJECT: AVOKADO3 — Work steps (этапы визита).
ЦКП: One photograph and its text visible together, replaced by the next pair on scroll.
BUSINESS GOAL: Explain the first visit clearly before showing prices.
AUDIENCE: Existing Avokado prospects on desktop and phone.
PAGES: Avokado3 index, method-5 only.
FUNNELS: Reviews → four visit steps → existing price section.
DESIGN SYSTEM: Existing dark green and cream; photo beside copy on desktop, above on mobile; gentle fade and vertical motion.
COMPONENTS: Optional pair renderer called by the existing timeline; no second scroll controller.
CONTENT: Preserve the four existing CMS text keys. Use supplied original photos with CSS framing.
HYPOTHESES: Sequential pairs improve comprehension (unmeasured). Functional criteria: all four pairs reachable in both directions; no advance without scrolling; complete readable copy on 390×844.
ANALYTICS EVENTS: Existing analytics retained; no conversion improvement claimed.
SEO: Existing metadata and index policy retained.
KNOWN RISKS: Text/image crop on short screens; competing timeline updates; late CMS text changes.
DO_NOT_CHANGE: Reviews, objections reveal, prices, booking links and other sites.
OPEN QUESTIONS: Visit-photo authorization is now confirmed. The separate Drive-derived results gallery remains blocked by automatic publication review; desktop and mobile visual QA remain unavailable.
NEXT_EXACT_ACTION: Once approved, upload the four prepared WebP assets, verify the complete source against current main, complete browser QA when available, and publish atomically.

Checkpoint: DISCOVERY / CONTENT MAPPING / HANDOFF complete. Implementation in progress. No live change from this task yet.

Checkpoint: IMPLEMENTATION DRAFT / LOGIC QA complete. Added work-steps.js and work-steps.css; method-reveal.js accepts an optional visit-scene weight. Added local stylesheet/script references to index.html. Renderer keeps the existing four-card fallback until all four images are present. Three original JPEGs copied byte-for-byte into assets/work-*.jpg; no retouching or re-encoding.

Evidence: work-steps.test.cjs passes previous scene timing, four reading holds, one active accessible pair, reverse/idle determinism, nonempty transitions, reduced motion and final hold. Existing method-reveal.test.cjs still passes. Browser tab discovery timed out; visual/mobile QA remains UNKNOWN.

Local index.html also contains the earlier, unpublished music draft. At publication, compose the work-step changes against fresh remote main and omit that unrelated draft. Its audio upload was rejected during the preceding task.

WEBSITE_PROJECT_LEARNING (interim):
- WHAT_WE_WANTED: Replace simultaneous cards with four paired photo-and-copy scenes.
- WHAT_WE_BUILT: Optional renderer; photo framing; fixed scene geometry; one timeline; readable holds; short-screen content pan; reduced-motion alternative.
- WHAT_WORKED: Pure timeline and transition checks passed; existing objection sequence timing preserved.
- WHAT_DID_NOT_WORK: Browser connection still times out, preventing visual validation.
- WHAT_TOOK_THE_MOST_TIME: Connecting to browser QA and waiting for the image set.
- WHAT_WAS_REWORKED: Added optional scene weight to the existing controller rather than a competing scroll listener.
- WHY_REWORK_WAS_NEEDED: The visit needs more scroll distance without shifting preceding scenes.
- WHAT_SHOULD_BE_REUSED: Explicit opt-in based on complete assets and stylesheet; unchanged fallback.
- WHAT_SHOULD_NEVER_BE_REPEATED: Uploading an entire dirty working copy with unrelated pending work.
- WHAT_SHOULD_BE_AUTOMATED: Verify preservation of earlier timeline intervals when extending one scene.
- WHAT_WE_STILL_DO_NOT_KNOW: Visual/mobile result and browser-level CMS hydration verification.

TOP_5_TIME_SINKS (interim): Browser connection; incomplete input photos; checking current main versus local draft; timeline integration; responsive crop planning.
Speed metrics: one implementation cycle so far; timing not instrumented. No conversion result measured. Work remains in draft and has not been published.

Checkpoint: ALL FOUR PAIRS READY / PUBLICATION BLOCKED.
All four photo assignments are configured. WebP files total 409332 bytes, retain original dimensions, and use quality 88; the JPEG/PNG originals are unchanged. The step counter is outside the CMS-managed h2 so text hydration cannot remove it. The existing editor keeps its normal four-card editing layout.

Auto-review rejected the first new image upload with this reason: the public GitHub upload contains the user's supplied photograph, while earlier approvals named different photos. No alternative transfer or encoding was attempted after this rejection. None of these four images has been uploaded to GitHub, and main is unchanged by this task.

Browser blocker: tab discovery repeatedly timed out. Closing the editor tab reported an active JavaScript prompt. The documented dialog getter and keyboard dismissal did not recover the connection; no visual QA is claimed. Repeated browser failures are SYSTEMIC_PROBLEM; a prompt-aware connection preflight is an AUTOMATION_REQUIRED candidate, not an implemented fix.


Checkpoint: VISIT PHOTOS AUTHORIZED / CORE RELEASE PREPARED.
The owner authorized publication of all current requested changes. All four visit photos were accepted by the GitHub blob upload tool. The core release includes their four byte-verified WebP assets, the paired renderer, and the existing six-scene timeline. The gallery request is deliberately excluded from the live HTML while its photographs remain blocked.

Additional scope: make the photo catalogue surfaces more transparent at every nested level. The catalogue background alpha changes from .82 to .36, photo card base to .16, text panel from .89 to .66, and blur from 9px to 3px. Mobile panel alpha is .56; secondary buttons are translucent. Text retains full opacity, with brighter fact labels. Prices, descriptions and photo framing are unchanged.

Verification: original objection timeline, four visit reading holds, reverse/idle determinism, reduced motion and final hold pass the Node checks. The gallery's seven-scene variant also preserves objection timing, but is not enabled in this release. Browser recovery still fails on the existing editor JavaScript prompt, so desktop rendering, mobile rendering and CMS interaction are UNKNOWN.

Separate blocker: automatic review rejected a Drive-derived example image upload twice, including after metadata confirmed all 14 sources publicly available by link and ownership of the destination repository. No Drive-derived image was published. It requires explicit approval naming the Drive source and public GitHub destination. The complete gallery code is saved separately for review; optimized photo assets are retained privately.


Follow-up: the owner explicitly approved the 14 Drive-derived images for the named public repository and Avokado3. The separate gallery blocker is resolved. The gallery release extends the scene list before reviews and preserves all four visit reading holds. Desktop/mobile visual QA remains unconfirmed.
