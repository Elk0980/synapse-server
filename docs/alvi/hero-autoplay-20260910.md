# ALVI — opening video without a player button

## Passport and implementation checkpoint
PROJECT: ALVI; source main 883b5baed18dbb4e7b3c7028b0d5e35c2835e504.
GOAL: the first mobile screen opens naturally, without asking the visitor to start decorative media.
FACT: owner screenshot IMG_9401 shows the explicit «Включить видео» fallback after the review badges. Decorative-water recovery from PR227 does not own this separate opening video.
SCOPE: remove the button and its wiring; retain muted inline autoplay and retry synchronously during ordinary touch/click/keyboard interaction while the first scene is eligible. Keep the existing still-frame breathing fallback and approved desktop lifecycle.
DO_NOT_CHANGE: approved crop, photos, slide order, desktop geometry, price, booking links, CRM or authentication.
REUSE: scene-aware lifecycle, source fallback, stale-promise guards and existing frame animation. The factory lifecycle record is CANDIDATE, not a validated default.
QA_REQUIRED: normal playback; simulated refusal followed by ordinary interaction; no repeated play loop on scrolling; no offscreen/hidden-tab/reduced-motion retry; cleanup when switching to desktop; responsive 320/390/768/1366px first screen.
LIMIT: operating-system autoplay restrictions cannot be overridden by page code. Real iPhone power-saving behavior remains UNKNOWN; Chromium refusal simulation is QA, not native-device certification.
CHECKPOINT: implementation and QA complete. Publish through PR under the owner's existing authorization; live verification pending.


## QA and project learning
IMPLEMENTED: the explicit button, CSS and button option are removed. Compact-mode listeners retry directly inside normal touchend/click/keydown handlers; they respect scene eligibility and pending playback, and are removed when the controller is destroyed. No automatic rejection loop. The existing frame-breathing fallback, crop and desktop retirement remain.
TESTS: 23 passed — 17 hero lifecycle tests and 6 unchanged decorative-water tests; JS syntax check passed. Coverage includes repeated denial, ordinary touch/click/key recovery, hidden/offscreen state, source fallback, stale promises, cleanup and desktop 4px/500ms retirement.
BROWSER: normal playback at 320/390/768/1366px: readyState 4, paused false, opacity 1, no play button and no horizontal page overflow. Position remains 62% 50% in compact mode and 50% 50% on desktop. Under simulated denial, video opacity stays 0, the existing frame transform advances, and the first screen has no player control. A normal logo click starts the actual video; a later observation confirms visible playback.
EVIDENCE: docs/alvi/qa-hero-autoplay-20260910.json; review screenshot hero-without-play-button.png is from the 390px refusal fixture. No real iPhone power-saving certification.
WHAT_WORKED: separate decorative-media permission recovery from the visitor's sales actions; keep play() synchronous with ordinary input, with no extra visible button.
WHAT_DID_NOT_WORK: an explicit recovery CTA made background media look like another task for the visitor. Local QA URL rewriting also changed a dynamic video/ MIME prefix; corrected the fixture before all reported media checks. Production MIME code was already valid.
WHAT_WAS_REWORKED: the Node EventTarget test harness distinguishes boolean-capture removal from an options object; use matching capture objects for listener registration/removal, plus a disposed-state guard.
REUSE: scene eligibility, direct gesture recovery, pending-attempt guard and a useful pre-playback state. Keep the factory record CANDIDATE until broader validation.
UNKNOWN: physical iPhone/low-power behavior; conversion impact. No conversion claim.
TIME: one bounded product revision and a test/QA-fixture correction. No new photos, owner-approval or credential wait; exact stage durations were not instrumented.
