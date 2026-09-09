---
knowledge_id: WF-ALVI-MOBILE-SHELL-MODAL-20260909
category: TECH_FIXES
title: Full-width mobile shells and modal content independent of its close control
problem: Generic container shrinking creates an asymmetric background strip; scrollable modal panels can hide their own close control.
context: ALVI phone screenshots of main, price header, footer and dual-brand banner.
solution_or_learning: Scope narrow widths to readable text containers, preserve full-width page shells; keep modal header outside a min-height-zero scroll body and account for CMS hydration.
project_source: ALVI
evidence: Source diagnosis, user screenshots, 13 behavior tests and calculated crop bounds. Mobile visual acceptance pending.
confidence: MEDIUM
reuse_scope: WEBSITE_FACTORY
created_at: 2026-09-09
source_version_head: 6cf19b868be5da5c8502e61531782661fe355b00
supersedes: []
status: CANDIDATE
---

Do not replace testing at phone width with a CSS fetch. Keep existing reduced-motion behavior and actual offer data while adjusting layout.
