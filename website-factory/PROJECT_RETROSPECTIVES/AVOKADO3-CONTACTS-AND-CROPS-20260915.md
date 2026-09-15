---
knowledge_id: AVOKADO3-CONTACTS-AND-CROPS-20260915
category: PROJECT_RETROSPECTIVES
title: Contact choice, consistent result images and visit photo headroom
project_source: AVOKADO3
reuse_scope: PROJECT
created_at: 2026-09-15
source_version_head: a74f5a030e9b272b21dbb2b143af06344c1ec1df
confidence: HIGH
status: VERIFIED_SOURCE
supersedes: [AVOKADO3-RESULTS-GALLERY-20260915-framing]
---

## Owner rule — retain in future Avokado3 edits

Communication buttons linking to WhatsApp or another social network must open the main page's Contacts section, so the visitor chooses a channel. Use `#contacts` on the main page and `index.html#contacts` on the price page, in the same tab. Direct messenger links are the final choices inside Contacts (and the standalone contacts page). Online booking, telephone calls and map links retain their own destinations.

The header, catalogue help buttons and certificate button now follow this rule. `contact-route.js` also normalizes social links inserted or changed by the site editor and asynchronous catalogue. Contacts contains visible WhatsApp, Telegram and VK choices, using the studio URLs already present in its contacts page. The existing VK edit key is retained. Do not replace this choice with a compulsory messenger or rewrite these final choices back to Contacts.

## Requested image fixes

- All 14 results images now use 1024 × 1024 SVG frames referencing the previously published original photographs. Text and surrounding borders are excluded with deterministic viewport bounds. The two halves use the same scale; all original views and their order remain. The six-view collage and the vertical two-view comparison retain their respective layouts. The enlarged dialog clones the same frame.
- No generated image, skin retouch, body reshaping or per-half stretching is used. The original 14 assets remain unchanged. `results-crop-recipe.json` and `build-results-frames.cjs` reproduce the presentation markup.
- The fourth visit photo uses `object-position: 35% 0%`, preserving headroom in the wide frame. Its original file is unchanged.
- The owner explicitly approved all pending changes and immediate publication. This includes the ordinary crop/montage proposed after the image-generation attempt produced no usable output.

The clean derivative upload was rejected by automatic review because it did not accept the general publication approval as explicitly covering the sensitive image payload and public GitHub destination. The release therefore contains code and framing coordinates only, with no new photograph upload. All fourteen original source hashes were independently matched to the existing public main tree before using them. Raw source assets retain their original labels; those labels are outside the viewports shown by the website.

## Fixed price shortcut

The floating trial-session link and a new “Посмотреть весь прайс” link to `price.html` share a fixed panel and the existing reveal/finale visibility state. Desktop buttons sit together at the bottom right. On mobile they share the available width, wrap text, keep 52px minimum height and respect the safe-area inset. The booking edit key and entry point remain on the original booking anchor. Hidden actions cannot receive pointer or keyboard focus.

## Evidence and limits

All 14 resulting files and the contact sheet were visually inspected. A calculated 826 × 340 cover-crop preview confirmed the fourth photo's full head; this is a local framing preview, not a browser screenshot. Crop bounds and output dimensions passed checks. Catalogue tests cover main/price link destinations; routing tests cover initial, added and CMS-updated social links, exact hostname matching, and direct terminal choices. Existing visit timeline tests passed.

Existing slide timing, prices, 45-minute promotions, laser duration hiding and site styling are retained. No conversion lift is asserted. Live visual verification remains UNKNOWN while the browser connection is unavailable; GitHub content verification alone must not be reported as browser verification.

## Learning

Record visitor channel choice as a project rule, and enforce it after CMS hydration as well as in the initial markup. Preserve original comparison photos and equal scaling when standardizing a gallery. Check photo focal points against the actual wide frame; centered cover cropping can remove headroom even when the original is intact.
