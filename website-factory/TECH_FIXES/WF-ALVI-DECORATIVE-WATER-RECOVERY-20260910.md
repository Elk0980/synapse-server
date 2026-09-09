---
knowledge_id: WF-ALVI-DECORATIVE-WATER-RECOVERY-20260910
category: TECH_FIXES
title: Hide paused background players and keep a media-independent fallback
problem: Denied autoplay exposes native player UI above content and leaves decorative water static.
context: ALVI price, post-hero and contact backgrounds with muted inline video.
solution_or_learning: Show video only after playing; hide it on interruption, keep an animated poster, retry directly from a normal user gesture, and centralize visibility and preference handling.
project_source: docs/alvi/background-water-20260910.md
evidence:
  - docs/alvi/tests/background-water.test.js
  - docs/alvi/qa-background-water-20260910.json
confidence: HIGH
reuse_scope: WEBSITE_FACTORY
created_at: 2026-09-10
source_version_head: 48488b80fc49fa180988a1a0952aa0674bdb11ef
supersedes: null
status: CANDIDATE
---

Six lifecycle tests cover denial/gesture recovery, buffering, hidden tabs, reduced motion/data saving, viewport eligibility and stale promises. Chromium confirms playing water at phone/tablet/desktop widths and a moving non-video fallback under simulated denial. Physical iOS power saving remains unverified; no conversion uplift is claimed. Existing hero lifecycle guidance remains applicable separately.

QA lesson: asset URL rewriting must preserve media MIME strings. The local harness briefly rewrote video/mp4 as a URL; affected browser checks were repeated after correction. A simulation of autoplay refusal must be distinguished from an accidental invalid-source failure.
