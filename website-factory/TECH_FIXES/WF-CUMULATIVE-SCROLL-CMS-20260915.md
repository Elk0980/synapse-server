---
knowledge_id: WF-CUMULATIVE-SCROLL-CMS-20260915
category: TECH_FIXES
title: Cumulative scroll reveal inside an existing CMS slide
problem: Adding incremental animation can conflict with the old slide controller or CMS inline transforms.
context: Avokado3 fourth method slide with two panels and four CMS-managed text paragraphs.
solution_or_learning: Delegate from the existing scroll handler to one optional controller. Wrap text nodes instead of transforming CMS-managed nodes. Extend only the target slide distance; preallocate geometry and derive all reveal states from scroll position with no timer. Version the stylesheet URL when fixing a user-visible cache mismatch.
project_source: AVOKADO3
evidence: Live desktop six-stage forward sequence, reverse, idle stability, non-identity paper transform and next-slide gating; Node timeline/pan tests. Mobile visual QA pending.
confidence: MEDIUM
reuse_scope: WEBSITE_FACTORY
created_at: 2026-09-15
source_version_head: 79954e3adc2fa2221020e3c19034a01ca0c0490a
supersedes: []
status: CANDIDATE
---
Keep the original renderer as fallback if the optional animation stylesheet or expected markup is absent. Do not use competing scroll listeners that both toggle active scenes. Leave a reading hold after the final argument. Asset HTTP 200 or a matching hash establishes delivery, not visual acceptance in a cached user browser.

Extension, 2026-09-15: the draft visit-step renderer adds an optional weight for a second scene to the same timeline. Compare every earlier scene interval against the old timeline; all sampled indices, objection phases and reveal arrays remain unchanged. The new work-steps.test.cjs covers four full-opacity reading intervals, reverse/idle determinism, nonempty transitions, reduced motion and the final hold. These are logic checks; browser integration and mobile rendering remain unverified.

CMS detail: add counters and other UI beside an editable heading, outside its data-edit node. The content loader replaces that node's innerHTML, so nesting a counter inside it would remove the counter on hydration. This preventive source finding has not yet been verified in the browser.
