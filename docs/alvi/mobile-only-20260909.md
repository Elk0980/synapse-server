# ALVI — preserve approved desktop, refine mobile menu and droplet

## Project Passport / builder handoff
PROJECT: ALVI; extends the UI-review and iPhone-hero passports.
BUSINESS GOAL / ЦКП: finish the mobile version while retaining the desktop version accepted by the owner.
PAGES / AUDIENCE: main and price; phone/tablet visitors and existing desktop visitors.
FACT: owner has accepted the mobile animation and asked to prioritize the droplet over a fully visible face. Latest screenshot confirms the first-video droplet is outside the crop.
OWNER_ASSUMPTION: the earlier exact menu specification is absent from this context. Announced interpretation: compact “Выбрать раздел” control, vertical categories/services, close after selection.
DO_NOT_CHANGE: mobile playback, media files, service facts, prices and approved desktop presentation.
WHAT_WE_ALREADY_KNOW: mobile.css is media scoped, but PR218 also changed global modal layout and four hydrated banner strings. PR217 replaced the desktop opening-loop lifecycle as well as mobile.
WHAT_CAN_BE_REUSED: existing native price anchors, CMS document, desktop grid and mobile opening controller. Relevant VALIDATED factory entries: EMPTY; existing modal/media records are CANDIDATE.
WHAT_MUST_BE_TESTED: desktop text after CMS hydration and resize; desktop/modal geometry; mobile menu expansion/selection wiring; droplet bounds; video behavior regressions.
WHAT_IS_PROJECT_SPECIFIC: baseline desktop PR215 (0885b49b1266b6b2b2153f917984f0f583990dff), accepted mobile animation PR217, user-requested droplet priority.
DESIGN_HYPOTHESIS: a collapsed vertical menu avoids clipped adjacent categories and long expanded navigation. Success: one initial control, native destination links, no document horizontal overflow; no conversion claim.
COMPONENTS / CONTENT: mobile-only price menu; desktop modal retains prior grid and source copy; compact copy remains a mobile presentation; opening crop changes from 86% to 62% for the video/poster/k1/k2.
NEXT_EXACT_ACTION: finish isolated implementation, verify and publish through PR under existing owner authorization.

## Checkpoint / learning
The desktop modal body wrapper uses display:contents to preserve the approved grid; fixed header and internal scroll are scoped to mobile. Source JSON is restored, and exact-string shortening only applies at the mobile breakpoint and outside the editor. Resizing back to desktop restores source text.
The new menu enhances existing links without creating controls on initial desktop load. Shared files only receive versioned links; menu styles for existing elements live inside the mobile media query.
Opening crop is checked against the existing source images. Real-device rendering remains pending user-device evidence; this environment has no mobile viewport control.
WEBSITE_PROJECT_LEARNING: a mobile-only stylesheet does not isolate global HTML, script or CMS changes. Preserve the accepted desktop baseline across all four layers. Test the responsive boundary and hydration, not just media-query presence.
TOP_5_TIME_SINKS: unavailable mobile browser; shared desktop/mobile modal; CMS hydration; desktop lifecycle regression audit; merge/sync wait. Revision cycle: one correction, with two new user requests integrated. Timings not measured.

QA checkpoint: 19 behavioral tests PASS (14 media / 5 copy), including desktop canplay startup, >4px retirement with 500ms fade, no new desktop autoplay-retry button, mode-switch cleanup, unchanged mobile lifecycle, source copy restoration after resize, later CMS edits and certificate terms. Nine inline scripts and the menu script parse. Calculated poster droplet bounds remain inside 375x667, 390x700, 390x844 and 430x932 viewports at 62%. This calculation is not a mobile browser screenshot.
The accepted desktop visual grid and normal opening lifecycle are restored. Existing recovery from a zero-sized/background viewport is retained to avoid reintroducing a missing-video defect; reduced-motion still uses its existing compact flow.
