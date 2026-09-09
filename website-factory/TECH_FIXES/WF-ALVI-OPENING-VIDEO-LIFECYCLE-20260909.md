---
knowledge_id: WF-ALVI-OPENING-VIDEO-LIFECYCLE-20260909
category: TECH_FIXES
title: Scene-aware opening video and correctly anchored compact header
problem: A 4px scroll retired the intro video permanently; blocked autoplay had no recovery, and a sticky header after full-height media began below the first screen.
context: ALVI compact mobile intro, recurring user report after code-only checks.
solution_or_learning: Use scene eligibility rather than any scroll to govern playback, provide a user-gesture fallback, and anchor the header to the hero origin. Verify behavior beyond asset delivery.
project_source: ALVI
evidence: Source inspection and user screenshot; 9 mocked media tests passed; live desktop smoke pending. Real iPhone visual acceptance remains unknown.
confidence: MEDIUM
reuse_scope: WEBSITE_FACTORY
created_at: 2026-09-09
source_version_head: c622afd0ae251bd8689e972dbc14600e6c4043e4
supersedes: []
status: CANDIDATE
---

Do not equate published CSS with successful mobile playback. Never infer the screenshot URL from matching copy alone.

SYSTEMIC_PROBLEM / AUTOMATION_REQUIRED: supported mobile viewport or real-device browser QA must be available before claiming iPhone acceptance; this limitation has now caused repeated incomplete validation.
