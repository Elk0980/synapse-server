---
knowledge_id: AVOKADO3-PAPER-REVEAL-20260915
category: PROJECT_RETROSPECTIVES
title: Scroll-controlled objection scene with paper placement motion
problem: All objection/answer copy appears at once; owner requests gradual presentation.
context: Existing six-slide method presentation on Avokado3.
solution_or_learning: Pending QA of weighted scroll timeline and six cumulative reveals.
project_source: AVOKADO3
evidence: Owner screenshot and approved sequence: questions, answer panel/heading, four individual paragraphs.
confidence: MEDIUM
reuse_scope: PROJECT
created_at: 2026-09-15
source_version_head: 87e1d02173edb97e5e996c3ad7fcf1c6addebca1
supersedes: []
status: CANDIDATE
---

WHAT_WE_ALREADY_KNOW: Six existing sticky slides; target method-3 has two panels and four paragraphs, all populated by site CMS. No validated reusable timeline record found in the available canonical categories.
WHAT_CAN_BE_REUSED: Existing method shell, scroll events, dark cards and editable text nodes.
WHAT_MUST_BE_TESTED: Forward and reverse reveal order, idle stability, next scene gating, viewport overflow, reduced motion, no-JS fallback and text hydration.
WHAT_IS_PROJECT_SPECIFIC: Six ordered beats inside the fourth method slide; prices and statements are not edited by this task.

Project Passport / builder handoff:
PROJECT: Avokado3 paper reveal.
ЦКП: Scroll questions → answer panel → four arguments with calm paper-like placement.
BUSINESS GOAL: Let visitors read concerns and responses in sequence.
AUDIENCE: Avokado prospects on desktop and phone.
PAGES: Existing landing only.
FUNNELS: Preserve service/booking flow; next method slide after reading hold.
DESIGN SYSTEM: Existing typography/dark palette; small X/Z rotations and downward settling, no real white sheets.
COMPONENTS: Weighted timeline controller plus scoped transform CSS.
CONTENT: Existing CMS markup untouched.
HYPOTHESES: Gradual disclosure improves reading, UNTESTED. Metric: progression beyond this slide; requires actual analytics before claiming improvement.
ANALYTICS EVENTS: Existing analytics preserved.
SEO: Existing index policy retained.
KNOWN RISKS: Small viewport overflow; animation double-controller conflicts; CMS inline transforms.
DO_NOT_CHANGE: Other slide content, photos, catalogue, prices, existing booking links.
OPEN QUESTIONS: None required for implementation; mobile real-device acceptance remains a separate visual check.
NEXT_EXACT_ACTION: Implement six phases with stable layout and backward scrubbing; test in browser.

Checkpoint: DISCOVERY / ARCHITECTURE / HANDOFF complete. Implementation next.
