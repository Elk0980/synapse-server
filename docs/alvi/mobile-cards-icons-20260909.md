# ALVI — compact mobile service cards and monochrome contact icons

Project Passport extension: mobile-only-20260909.md. Owner now explicitly authorizes monochrome messenger/map marks on both desktop and mobile, and two columns of main-page service cards on mobile. Other desktop presentation and accepted animation remain unchanged.

WHAT_WE_ALREADY_KNOW: coloured SVG images remain in contacts/footer; mobile cards occupy a whole row with full descriptions. All nine showcase cards link to full price entries.
WHAT_CAN_BE_REUSED: original Telegram/VK glyph paths, original MAX silhouette from the official brandbook asset, existing map outline and numeral geometry, native price anchors and booking actions. VALIDATED factory entries for this use: EMPTY; existing service actions record is CANDIDATE.
WHAT_MUST_BE_TESTED: all icon locations, transparent negative space and stroke inheritance; main mobile card readiness after asynchronous hydration; desktop preservation; full-details accessibility.
WHAT_IS_PROJECT_SPECIFIC: two main showcase grids (#for-self, #for-two), not the full price page or hero choice cards. DESIGN DECISION: photo/title/price/time/actions remain in compact cards with details by tap.

Builder handoff: keep source photos and video; render compact service cards in two columns only through 56.24rem. Retain original data and descriptions for desktop; show a native “Подробнее” price link on mobile before hiding descriptions. Preserve a minimum 44px action height. Change messenger/map icons to currentColor in contacts and footer. Use the exact silhouette path from img/brands/max.svg; do not invent another MAX mark.

Implementation: mobile-cards.css/js enhance the two existing grids; a MutationObserver handles asynchronous replacement by the price renderer. Fallback stays full when a usable details link cannot be created. Photos move above text in a 4:3 area. All existing-element layout rules are inside the mobile media query. New details links are hidden on desktop.
Icons use inline SVG and inherit link colour at every viewport width. Telegram and VK glyph geometry is reused, coloured badge fill is removed, map pins are outlined. MAX uses the unchanged official silhouette path, while the source asset/provenance file remains intact. Phone icon, ALVI emblem, targets and accessible names stay unchanged. The inherited phone stroke is explicitly cleared on service icons to preserve their geometry.

QA: JS syntax passes. The price renderer yields 5 self and 4 two-person cards; all have source photos, price anchors and actions. All nine fallback HTML cards have details targets as well. At 320px with 16px side padding and a 10px gutter, each card is 139px wide; text wraps and actions have no minimum width. This calculation is not a real mobile screenshot. Live desktop contacts/card smoke follows automatic publication.

WEBSITE_PROJECT_LEARNING: reduce a mobile card's visible information, not its font until unreadable. Gate compact presentation on access to full details. Monochrome logos need preserved holes and silhouettes; a blanket white filter can erase internal marks.
TOP_5_TIME_SINKS: missing local icon sources; shared phone SVG stroke; asynchronous card hydration; unsupported mobile viewport; pull-deployment delay. One revision cycle; timing not measured. No conversion result claimed.
