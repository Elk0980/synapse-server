---
knowledge_id: WF-ALVI-OPENING-VIDEO-LIFECYCLE-20260909
category: TECH_FIXES
title: Scene-aware opening video and correctly anchored compact header
problem: A 4px scroll retired the intro video permanently; blocked autoplay had no recovery, and a sticky header after full-height media began below the first screen.
context: ALVI compact mobile intro, recurring user report after code-only checks.
solution_or_learning: Use scene eligibility rather than any scroll to govern playback, retry during ordinary page interaction without a dedicated player button, and anchor the header to the hero origin. Verify behavior beyond asset delivery.
project_source: ALVI
evidence: Updated after IMG_9401; 17 hero lifecycle tests pass, Chromium responsive playback checked at 320/390/768/1366px and refusal-to-ordinary-click recovery verified. Physical iPhone remains unknown.
confidence: MEDIUM
reuse_scope: WEBSITE_FACTORY
created_at: 2026-09-09
source_version_head: c622afd0ae251bd8689e972dbc14600e6c4043e4
supersedes: []
status: CANDIDATE
---

Do not equate published CSS with successful mobile playback. Never infer the screenshot URL from matching copy alone.

SYSTEMIC_PROBLEM / AUTOMATION_REQUIRED: supported mobile viewport or real-device browser QA must be available before claiming iPhone acceptance; this limitation has now caused repeated incomplete validation.


2026-09-10 project refinement: the owner rejected the dedicated «Включить видео» CTA. Decorative opening media now retries on normal touchend/click/keydown only while its scene is eligible. Do not introduce a separate media task into the sales path. Preserve the existing frame fallback and respect autoplay restrictions; user gestures can enable a retry but cannot guarantee OS permission. See docs/alvi/hero-autoplay-20260910.md. Status remains CANDIDATE.
