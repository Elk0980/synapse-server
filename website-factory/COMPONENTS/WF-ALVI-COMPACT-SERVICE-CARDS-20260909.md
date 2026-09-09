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
