# ALVI — Background Motion Recovery (восстановление фоновой анимации)

## Project passport and builder handoff
PROJECT: ALVI; source main 48488b80fc49fa180988a1a0952aa0674bdb11ef.
ЦКП / BUSINESS GOAL: decorative water stays behind content, without a player button interrupting the price-to-booking path.
AUDIENCE / PAGES / FUNNELS: phone, tablet and desktop visitors; price and the main page's post-hero/contact backgrounds; existing service, couple and gift paths.
FACT: owner screenshot IMG_9400 shows a native play triangle over the mobile price. Price relies on autoplay alone; the main background swallows play rejection and never recovers. Contacts have a separate WebM-only background.
WHAT_WE_ALREADY_KNOW: autoplay can be refused even for decorative media; an HTML poster does not replace the native video surface. Relevant factory lifecycle records are CANDIDATE, not defaults. No matching VALIDATED record found.
WHAT_CAN_BE_REUSED: existing water-loop MP4/WebM and water-poster, approved dark veil, hero eligibility/lifecycle principles.
WHAT_MUST_BE_TESTED: hidden player before actual playback; refusal followed by ordinary touch recovery; fallback movement; pause/visibility/reduced-motion/data-saving; phone widths and desktop composition.
WHAT_IS_PROJECT_SPECIFIC: keep the ALVI water and approved hero animation. The screenshot's yellow battery suggests power saving, but the precise iOS rejection reason is UNKNOWN.
DESIGN SYSTEM / COMPONENTS: same background and veil; real video shown only after playing; subtle CSS motion of the existing water poster while video is unavailable; no new visible control.
CONTENT / SEO / ANALYTICS: no text, price, metadata, booking link or analytics change.
HYPOTHESIS: graceful background recovery removes a distracting player control and keeps decorative motion when autoplay fails. Success means no visible paused video surface, a running fallback animation and real-video recovery after a permitted user gesture; no conversion increase claimed.
DECISION: one small controller owns decorative water across main/price/contacts; hero media remain with their existing controller. The generic data-saving helper excludes water, which respects those preferences in its own lifecycle.
KNOWN RISKS: Chromium responsive QA cannot reproduce physical iPhone power-saving behavior or certify native Safari. CSS fallback is a soft movement of the existing image, not decoded video.
DO_NOT_CHANGE: approved desktop geometry, service photos, hero videos/slides, program data, CRM and authentication.
NEXT_EXACT_ACTION: implement and verify normal playback, denied autoplay, touch recovery and responsive screenshots; publish via PR under standing authorization.

## Checkpoint
DISCOVERY / HANDOFF: complete; source and owner screenshot inspected. Primary policy reference: https://webkit.org/blog/6784/new-video-policies-for-ios/ (muted inline playback, promises and direct user-gesture handlers).
IMPLEMENTATION: shared decorative-water controller and stylesheet added. Existing media/veil retained; MP4 precedes WebM, video is hidden before real playback and on pause/wait/error. Direct touch/click/keyboard retry has no automatic rejection loop. The poster's subtle movement pauses while video plays, offscreen and in hidden tabs; reduced-motion remains still. Contacts now have MP4 fallback too.
QA: 20 tests pass (6 background lifecycle scenarios and 14 unchanged hero lifecycle tests). Both changed scripts pass syntax checks. Chromium price checks at 320/390/768/1366px show readyState 4, advancing currentTime, no native controls and no page overflow. Main and contacts both play at 390/1366px. A separate QA-only denied-autoplay copy confirms video opacity 0 and moving poster before a normal button click, then playing MP4/opacity 1 and paused poster afterward. Screenshot at the reported mobile price section shows no play triangle. Evidence: docs/alvi/qa-background-water-20260910.json.
LIMITS: denied autoplay is simulated; a physical iPhone's low-power mode was not exercised. No claim of native-device certification. Test probes exist only in the local review copy.
RELEASE: ready for PR; publication and live verification pending.

## WEBSITE_PROJECT_LEARNING
WHAT_WE_WANTED: recover decorative motion without placing a video player over the price.
WHAT_WE_BUILT: playback-gated video, animated existing poster, gesture retry and shared visibility/preference ownership.
WHAT_WORKED: the playing event, explicit muted/inline properties, synchronous touch retry, and a fallback independent of media permissions.
WHAT_DID_NOT_WORK: autoplay alone and silently discarding rejection; relying on a native poster to hide player UI.
WHAT_TOOK_THE_MOST_TIME: integration and responsive media verification.
WHAT_WAS_REWORKED / WHY_REWORK_WAS_NEEDED: the local QA media-URL rewriter also changed MIME strings video/mp4 and video/webm into URLs. Corrected the QA helper; production MIME strings were already correct. Repeated the affected playback checks with verified MIME types and candidate URL.
WHAT_SHOULD_BE_REUSED: one owner per decorative-media lifecycle; a background must have a useful state before video succeeds.
WHAT_SHOULD_NEVER_BE_REPEATED: treating a successful desktop video load as evidence that an iPhone cannot show a native play overlay.
WHAT_SHOULD_BE_AUTOMATED: type-aware QA asset rewriting and candidate provenance checks; never rewrite MIME types as paths.
WHAT_WE_STILL_DO_NOT_KNOW: physical iPhone acceptance and any conversion effect.
TOP_5_TIME_SINKS: lifecycle integration; autoplay-denial fixture; correcting QA MIME rewriting; responsive/click verification; release verification. No credential or owner-approval wait.
SPEED: one product implementation revision; one QA-fixture correction. Discovery and implementation were each approximately 5–10 minutes; QA approximately 10–15 minutes. Stage timing is approximate, not instrumented.
