---
knowledge_id: WF-ALVI-COMPACT-SERVICE-CARDS-20260909
category: COMPONENTS
title: Compact service cards with native full-detail links
problem: Full descriptive cards consume the mobile screen; shrinking all text harms readability.
context: ALVI main-page service showcases after desktop acceptance.
solution_or_learning: Use two mobile columns with photos, names, price, time and 44px actions; enable shortened presentation only after a valid details link exists. Preserve full desktop content and handle data hydration.
project_source: ALVI
evidence: Nine dynamic and nine fallback card source checks, syntax checks, CSS breakpoint audit; real-device visual acceptance pending.
confidence: MEDIUM
reuse_scope: WEBSITE_FACTORY
created_at: 2026-09-09
source_version_head: 09aeb91c1d45457fdde9780d6bf008f4ca652714
supersedes: []
status: CANDIDATE
---

Use native detail destinations rather than duplicating service facts in another modal. Keep compact modes scoped to the explicitly requested grids. Related: WF-ALVI-DESKTOP-BASELINE-20260909 and WF-ALVI-SERVICE-ACTIONS-20260909.

## Refinement after owner phone screenshot, 2026-09-09

The two-column layout is now visible on the owner's phone. Owner requests finer typography and smaller buttons: the prior 44px heading reserve and two full framed actions look too heavy. Keep the existing photos/columns and use a 14–16px system heading at weight 500 without reserved height, 13px values with 11px labels, tighter content spacing, a 38px tinted outline booking button and a 32px text-style detail action. The 4px action gap preserves separation. These sizes supersede the initial project-specific 44px action choice at the owner's request; they are not promoted as a universal accessibility standard.

QA: independent cascade review confirms all existing-element changes stay inside the mobile media query and override shared action and late inline card styles. Retain the card's min-height:0!important to prevent the old 27rem mobile minimum returning. No content truncation or data/link/media changes. Real-device visual acceptance of this refinement is pending; desktop/source checks follow publication. Source baseline: 424a4b7faea09fce0b72e5d00aef9feba21bc99e.
