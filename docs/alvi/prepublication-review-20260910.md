# ALVI — Prepublication Review (проверка перед публикацией)

## Project Passport and builder handoff
PROJECT: ALVI. Base: bd245287c272fa6e3ed42c84351da25ae458f93a.
ЦКП / BUSINESS GOAL: mobile price navigation stays available, every service name, duration and price fits without horizontal scrolling; review the purchase paths before publication.
AUDIENCE: phone, tablet and desktop visitors. Primary conversion: a booking; secondary: program selection, administrator conversation, certificate enquiry.
PAGES: index, price, oferta, politika, soglasie. Expected funnels: self / couple / gift → program or price → booking or administrator.
FACT: Owner accepted both versions except mobile price navigation and tables; screenshots IMG_9395/9396 show navigation in the document flow and table columns outside the phone viewport.
WHAT_WE_ALREADY_KNOW: mobile tables have a 36rem minimum width; mobile menu is not sticky. No matching VALIDATED factory records; existing records are CANDIDATE.
WHAT_CAN_BE_REUSED: native anchors, the existing mobile menu, original logo, data/price.json and shared renderer.
WHAT_MUST_BE_TESTED: sticky positioning, dropdown scrolling, focus, resizing back to desktop, hydration, all four table categories, mobile horizontal overflow, self/couple/gift flows.
WHAT_IS_PROJECT_SPECIFIC: preserve accepted desktop and all current photos/animation. Published YCLIENTS destination is owner-supplied but returned 403 in this browser.
DECISION: move the existing mobile navigation into the header, label it «Выбрать ритуал», restore it to its original location for desktop; display table rows vertically on mobile.
DESIGN_HYPOTHESIS: a persistent menu reduces the return scroll needed to change a service category. Metric: selection possible at any scroll depth; no conversion lift claimed.
SUCCESS CRITERIA: zero horizontal overflow for price tables, title/time/price visible at 320–899px, the selected anchor clears the sticky header, desktop DOM placement/styles restored above the breakpoint.
ANALYTICS / SEO: existing implementation retained; audit only. No new facts or promises.
DO_NOT_CHANGE: prices, program content, booking destinations, photos, animation, accepted desktop presentation.
KNOWN RISKS: Chromium viewport simulation is not native iOS Safari; unavailable third-party booking cannot be treated as a completed conversion.
OPEN QUESTIONS: report only material factual conflicts discovered during review.
NEXT_EXACT_ACTION: prepare changes and a QA preview, return screenshots and a findings list; do not merge or publish before owner review.

## Checkpoints
OWNER REVIEW ACCEPTED (2026-09-09 UTC / 2026-09-10 Irkutsk): gift result must offer certificate purchase; replace the three time answers with ranges fitting existing recommendations (1–1.5, 2–3, 3–4 hours). Owner personally verified the ALVI YCLIENTS link works. Keep couple SPA minimum 6,900 ₽; ask Tatyana about the cheaper 4,600 ₽ entry. Add owner UTM and client domain/price tasks. Continue final checks and release under the owner's standing pre-advertising publication authorization.
FOLLOW-UP BUILDER HANDOFF: change only quiz time labels and gift-result action; restore ordinary YCLIENTS booking when selection changes back to a service. Keep program durations, prices, photographs and accepted desktop layout. Verify all 27 recommendation combinations against catalog durations, gift → service action reset, mobile controls and desktop result. Existing domain task must be updated instead of duplicated; task creation is not complete until the service returns actual records.

DISCOVERY / ARCHITECTURE / FUNNELS / WIREFRAME / CONTENT MODEL / DESIGN SYSTEM: scope and comparison baseline captured above. Internal QA preview uses source copies at controlled iframe viewport sizes; no production deployment.
PAGE DESIGN / IMPLEMENTATION: QA. The mobile header keeps the original logo plus separate «На главную» and «Выбрать ритуал» controls. The menu stays available at deep scroll positions. All four table categories retain actual column labels, including «Стоимость минуты» and «Для одного / для двоих».
IMPLEMENTATION REVIEW: QA. Browser viewport checks and tests below passed. No merge or production deployment in this iteration.
DATA: existing prices, program descriptions, booking links and certificate terms were preserved. Three funnel findings below are proposals, not published changes.
LEARNING: CANDIDATE record saved in website-factory/TECH_FIXES/WF-ALVI-STICKY-PRICE-NAV-20260910.md.

## Verification and limits

- Chromium iframe viewport matrix: 320, 360, 375, 390, 430, 768, 820, 899, 900, 1024, 1366, 1440 and 1920 CSS px. Five pages: main, price, offer, privacy and consent. Native desktop scrollbars reserve 15px, so usable content width is slightly narrower than the requested viewport.
- No page-wide horizontal overflow at those widths. Four price tables / 36 rows also have no internal horizontal overflow; main and legal pages contain no tables. Main service grids retain two mobile columns.
- Before change: table width 576px with only 375px usable at a 390px viewport. After change: 341px table width, entirely inside the page.
- Mobile header remains at y=0 after jumping to the body-massage section and to the last table. Body-massage heading begins at y=77px, below a 61px header. A card deep link from the main page opens «Релакс» at y=77.45px.
- Expanded categories, native anchors, menu collapse after selection and Escape tested. Menu returns to the original .price-layout container after crossing 900px; the transition was also checked after explicitly waiting for the matchMedia handler.
- At 844×390, expanded menu scrolls internally and ends at y=371.39px, within the 390px viewport. The separate «На главную» link navigates back to the main page.
- 148 selected desktop price elements have identical measured geometry, typography, display and positioning between baseline and candidate at 1366px. The patch does not change main-page layout or desktop styles.
- Quiz paths exercised: self/hour/tension → back massage; couple/few-hours/restore → calming program; gift → certificate; self/hour/restore → Relax. No personal information entered, no booking submitted.
- Main-page in-page anchors have existing targets. Card details, price navigation and home return exercised. All 36 current booking actions use the supplied YCLIENTS link; actual widget completion remains UNKNOWN.
- First-visit promo observed through actual scrolling. Tested at 320×568, 390×844, 844×390, 768×1024 and 1366×844: no horizontal overflow, close control visible, short mobile body scrolls; close action tested.
- Node tests: 21 existing booking/copy/video lifecycle cases passed; 2 additional semantic-table-label cases passed after correcting the test parser to accept extra row attributes. Both hydrated markup and static fallback checked.
- Source-based preview uses unchanged production media URLs and local fallback data. CMS copy may differ from that fallback; the 4,600 ₽ couple price and 6,900 ₽ headline were independently checked in LIVE DOM.
- These are Chromium layout simulations, not physical iPhone/iPad/Android or native Safari/Firefox tests. Browser safe-area behavior, touch gestures, mobile autoplay, low-power mode and the final external booking transaction are not fully verified. Production water video was observed loaded and playing; motion code is untouched and covered by existing lifecycle tests. Do not call this universal device certification.

## Findings for owner review before publication

| Priority / status | Versions | Finding | Proposed action |
| --- | --- | --- | --- |
| P1 / UNKNOWN | Both | n1070017.yclients.com returned «Нет доступа к странице403» in the inspection browser. The supplied second widget identifies Avokado, so it is not a substitute for ALVI. | Confirm the first widget opens ALVI and allows service/time selection. Check whether it asks for prepayment: the offer currently says no prepayment when booking through the site. The 403 is not proof of a general client outage. |
| P1 / QA finding | Both | Quiz «В подарок» returns a certificate but retains «Записаться» → generic YCLIENTS booking. | Change only the gift result to «Оформить сертификат» → the same administrator destination as price certificates. Keep ordinary service results on YCLIENTS. |
| P1 / QA finding | Both | «Для себя» + «Час» + «Восстановиться» returns «Релакс» (90 minutes in the price). The source mapping also does this for self/hour/together. The result itself omits duration. | Respect the selected time limit, show result duration, and link the result to its exact price entry. Use existing services; do not invent a shorter Relax program. |
| P2 / LIVE inconsistency | Both | Main headline and FAQ advertise couple programs from 6,900 ₽, while price #s2-5 lists «Релакс-мини» in the couple category at 4,600 ₽ / 1 hour. | Ask whether that couple program and price are current. If confirmed, synchronize minimum-price copy and structured data; otherwise correct the price item with salon approval. |

The 2-minute response promise is consistent in current FAQ/floating copy, but the response time itself was not measured. Hours (09:00–22:00), public phone, address and proprietor details match the current reviewed page sources. Certificate delivery copy on main, FAQ, quiz and price is aligned. This is a consistency check, not confirmation of operational or legal facts.

## Review artifacts

Owner-facing screenshot gallery contains the prepared mobile header/tables, current gift result on desktop, current one-hour quiz result on mobile, LIVE couple headline, couple price item and the mobile promo. The requested mobile fixes are prepared; the three funnel changes above are not applied. Full raw viewport measurements: qa-viewport-metrics-20260910.json.

NEXT_EXACT_ACTION: Owner reviews this list and confirms whether the 4,600 ₽ couple mini-program is current. Apply accepted funnel changes in a follow-up commit, verify the external booking destination when accessible, then publish only after the requested prepublication review.

## Accepted follow-up — final QA

The findings above describe the initial review and are retained as history. The owner accepted the gift action and requested three broad time choices instead of changing program durations or redesigning results. Implemented: «1–1,5 часа», «2–3 часа», «3–4 часа»; gift → «Оформить сертификат» → existing administrator chat; every subsequent ordinary service result restores «Записаться» → ALVI YCLIENTS.

- 25 Node tests passed, including all 27 gift/service combinations and catalog-duration checks for every non-gift recommendation.
- Real UI path on the candidate: gift → certificate action and then self → Relax → YCLIENTS. Keyboard focus moves to the result. Desktop gift result visually checked after the render settled; the initial immediately captured frame was stale and excluded from deliverables.
- Follow-up quiz geometry: 320, 360, 390, 430, 768, 820, 899, 900, 1024, 1366, 1440, 1920 px; no page or option overflow. Booking action height 46px at every checked width. These supplement the earlier five-page / 13-width matrix; unchanged legal pages were not needlessly re-tested.
- Rechecked all four price tables at 320, 375, 768, 899, 900 and 1366px: no overflow. Sticky header at 390px is 61px tall; the selected body-massage heading settles at y=77.11px. Separate home link returns to index.html. Desktop header remains relative.
- Owner-confirmed operational fact: n1070017.yclients.com works for the owner. This does not replace a completed transaction in our browser; no booking or personal data submitted.
- Owner-confirmed minimum couple SPA price: 6,900 ₽. Existing lower «Релакс-мини» 4,600 ₽ left unchanged pending Tatyana's confirmation; its task payload explains the conflict.
- Three task payloads are ready in launch-tasks-20260910.json: update the existing spaalvi.ru domain task, create the cheaper-program confirmation task, create the owner's YCLIENTS UTM task. STATUS: PREPARED_NOT_WRITTEN, because the current cabinet session reports incorrect credentials. A repository payload is not a live CRM record. No automatic seeding or authentication changes were introduced.
- Deadline assumption for these tasks: before promotion, provisionally 2026-09-10. Domain ownership / access must be checked before buying another name; no domain purchase is performed.

Release scope: publish this reviewed PR under the owner's standing authorization, then check the production HTML and user-facing navigation/result. Remaining launch dependencies are Tatyana's price decision, domain access and UTM setup. Physical-device Safari/Android testing and external transaction completion remain unverified, as already disclosed.

NEXT_EXACT_ACTION: release the checked site changes; resume actual task creation through the authenticated cabinet after access is restored, deduplicate by project/title and verify returned task records.
