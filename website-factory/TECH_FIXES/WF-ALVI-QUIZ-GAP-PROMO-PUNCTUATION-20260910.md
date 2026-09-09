---
knowledge_id: WF-ALVI-QUIZ-GAP-PROMO-PUNCTUATION-20260910
category: TECH_FIXES
title: Measure visible fieldset gaps and format the complete price sentence
problem: A floated legend swallowed the intended margin gap; formatting CMS prices as a flex row left the sentence dot on a separate line.
context: ALVI public site, native fieldsets and a CMS-hydrated promotional paragraph.
solution_or_learning: Put spacing inside the cleared answer container; consume only terminal punctuation attached to the formatted offer, preserving later sentences and arbitrary prices.
project_source: docs/alvi/typography-spacing-20260910.md
evidence:
  - docs/alvi/qa-typography-spacing-20260910.json
  - docs/alvi/tests/site-copy.test.js
confidence: HIGH
reuse_scope: WEBSITE_FACTORY
created_at: 2026-09-10
source_version_head: de2deffb8f1e51c810eedcd1b82c1e8034b7df14
supersedes: null
status: CANDIDATE
---

Observed: 0px gap before the fix; 10px at seven tested widths afterward. Price values still come from the cabinet. Terminal dots disappear; punctuation before a following sentence remains. Transferable guidance is CANDIDATE; no conversion uplift or native-device certification claimed.
