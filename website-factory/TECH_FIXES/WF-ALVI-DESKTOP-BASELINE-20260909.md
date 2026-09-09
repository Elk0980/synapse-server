---
knowledge_id: WF-ALVI-DESKTOP-BASELINE-20260909
category: TECH_FIXES
title: Preserve accepted desktop behavior during mobile corrections
problem: Global markup, document migrations and shared controllers can change desktop even when a mobile stylesheet is scoped.
context: ALVI mobile iteration after explicit desktop acceptance.
solution_or_learning: Scope modal layout and copy to the same mobile breakpoint; preserve the original source document and restore it on resize; compare shared media behavior against the accepted baseline.
project_source: ALVI
evidence: PR218 source audit, owner acceptance constraint, responsive copy tests. Mobile real-device acceptance remains pending.
confidence: MEDIUM
reuse_scope: WEBSITE_FACTORY
created_at: 2026-09-09
source_version_head: 60e1253602dcec399b52a3d71204804544587013
supersedes: []
status: CANDIDATE
---

Extends WF-ALVI-MOBILE-SHELL-MODAL-20260909: its mobile layout fix remains useful, but shared modal changes require a separate desktop boundary check. A source-only media-query check cannot certify identical desktop hydration or video behavior.
