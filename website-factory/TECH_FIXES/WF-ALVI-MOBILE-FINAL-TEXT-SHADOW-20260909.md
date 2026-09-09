---
knowledge_id: WF-ALVI-MOBILE-FINAL-TEXT-SHADOW-20260909
category: TECH_FIXES
title: Soft text shadows for the bright final mobile hero frame
problem: A diffuse 16px shadow and reduced element opacity leave white text washed out on a bright photo.
context: Owner screenshot of the final ALVI mobile intro; owner prefers shadows over an outline.
solution_or_learning: Owner rejected the strong contact shadow on a real phone. Use two softer, lower-opacity shadows without a sharp edge; keep copy, prices and signature at full opacity. Scope only to the compact final scene inside the mobile breakpoint.
project_source: ALVI
evidence: Source cascade audit and owner screenshot. Real-device visual acceptance pending.
confidence: MEDIUM
reuse_scope: WEBSITE_FACTORY
created_at: 2026-09-09
source_version_head: 8c7f1d1bcf4ea8aaeaf57d8508a23417ebe7fd39
supersedes: []
status: CANDIDATE
---

Project scope extends the mobile-only passport. Existing desktop styles, scene imagery, playback, need cards and layout remain unchanged. Button receives the same text shadow and a soft outer shadow. The rule intentionally avoids shadows on the entire content container, which could affect the already-readable need cards.
WEBSITE_PROJECT_LEARNING: a soft halo alone does not provide edge contrast; element opacity attenuates the shadow as well as its text. No accessibility contrast certification is claimed from source inspection.
TOP_5_TIME_SINKS: mobile viewport unavailable; existing final tone overrides; inherited opacity; publication; server sync. One small revision; timing not measured.

Owner refinement (2026-09-09): IMG_9394 shows an excessive dark rim after PR #221. Replaced the .95 / .9 / .7 shadow stack with 3px / .45 and 10px / .3 soft layers; halved button outer-shadow opacity. Real-phone acceptance of this softer revision remains pending.
