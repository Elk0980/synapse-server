---
knowledge_id: WF-ALVI-STICKY-PRICE-NAV-20260910
category: TECH_FIXES
title: Persistent mobile price navigation with correctly labelled responsive rows
problem: Mobile category controls scroll out of reach and wide tables hide the price column.
context: ALVI owner-approved desktop layout; mobile price screenshots show a displaced menu and clipped prices.
solution_or_learning: Move the existing native-link navigation into a sticky mobile header, retain an explicit home action, restore the original nav parent above the breakpoint, and derive mobile cell labels from each table's real headings rather than hardcoded duration and price labels.
project_source: ALVI
evidence: docs/alvi/prepublication-review-20260910.md; 13-width Chromium matrix over 5 pages; 36 table rows; deep-anchor clearance; 148 unchanged desktop element measurements; hydrated and fallback label tests; screenshots supplied for owner review.
confidence: MEDIUM
reuse_scope: WEBSITE_FACTORY
created_at: 2026-09-10
source_version_head: bd245287c272fa6e3ed42c84351da25ae458f93a
supersedes: []
status: CANDIDATE
---

Keep the original nav marker outside asynchronously replaced content. Measure the actual header height so links clear it after resize and text wrapping. Use a bounded, separately scrollable dropdown on short landscape screens. Empty cells must not gain a misleading visible label.

A desktop browser iframe can exercise CSS viewport widths and resize handlers, but does not reproduce physical mobile Safari, safe-area chrome, touch or autoplay policy. Record that limit explicitly; do not promote layout checks into universal device or conversion validation. CANDIDATE pending owner acceptance and device checks.
