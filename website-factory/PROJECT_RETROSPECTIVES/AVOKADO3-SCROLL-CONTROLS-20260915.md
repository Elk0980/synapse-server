---
knowledge_id: AVOKADO3-SCROLL-CONTROLS-20260915
category: PROJECT_RETROSPECTIVES
project_source: AVOKADO3
reuse_scope: PROJECT
source_version_head: 402cde993ed30cf296d1ffb43e2ddaf1bfbaecb4
created_at: 2026-09-15
status: VERIFIED_SOURCE
---

Owner requested the fixed buttons to hide while scrolling and return when scrolling stops, and the main site to start again after its end. A follow-up explicitly extends the same button behavior from phones to desktop.

`scroll-controls.js` hides the shared trial/price panel on all screen sizes while the scroll position changes, and restores it 220ms after the last movement. The existing hero/finale visibility rules still apply. An action with visible keyboard focus is not hidden. Changing viewport class clears the temporary hidden state. Desktop uses a vertical transition; phone retains the centered panel position.

Continuing downward from the document end starts another lap at the top. Wheel, upward finger swipes and PageDown/ArrowDown/Space are supported. A touch restart occurs on release. Reaching the footer by normal scrolling or an anchor alone does not restart, leaving footer links usable. Upward movement, horizontal gestures, Ctrl-wheel zoom, open image dialogs and editable controls do not restart the page. A cooldown prevents repeated resets from remaining input events. The reset removes only the old hash with replaceState, preserving query parameters and history state. Existing page nodes, CMS IDs, scroll slides and video are reused; the document is not cloned or reloaded.

Three focused tests pass for idle timing/resizing, footer/anchor navigation and repeated input, touch direction, dialog/input exclusions, and keyboard focus. JavaScript syntax passes. Browser interaction and live mobile appearance remain UNKNOWN because the connected browser is unavailable.

Portrait replacement: EXPLICITLY APPROVED / INCLUDED IN RELEASE. The owner supplied the light-sweater explaining-pose image to replace `assets/heroine-sport.png`. It has been inspected and encoded at the same 941 × 1672 dimensions as `heroine-explaining-20260915.webp` (39150 bytes), without cropping. The existing contain layout preserves head and hands, with 24px rounded corners on the portrait. The initial GitHub blob upload was rejected by automatic review, requiring explicit payload/destination authorization. The owner subsequently answered “разрешаю” to the question explicitly naming this light-sweater photograph, the public Elk0980/synapse-server repository and Avokado3. The upload was then accepted (blob d34d58dd8449272df4548a2308586e325344bf81); the page references the new asset. No alternative upload route was used. Browser visual verification remains UNKNOWN.

Learning: implement a repeat-page interaction from continued user input at the end, rather than resetting in a generic scroll handler, so normal anchor navigation and footer controls remain usable.
