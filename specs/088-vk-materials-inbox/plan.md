# Implementation plan

One isolated checkout and branch `088-vk-materials-inbox`; no edits to another executor's worktree. A current thread-status tool is unavailable; GitHub open VK PR audit found none, and base main was PR449. This is not a claim that the earlier codeworker is stopped.

Use existing Node 24 SQLite services, encrypted company bindings, owner proxy and cabinet modules. No new dependencies in runtime. Add additive private tables for preview bytes and operation journals; expire/purge unused source bytes and discard after terminal dispatch. Preserve historical journal metadata.

File ownership:
- Materials backend: `ops/crm/vk-materials.js`, `vk-materials.test.js`, `vk-direct.js`, dedicated transport tests. Use existing `vk-design` image and URL validation where appropriate.
- Inbox backend: `ops/crm/vk-community.js`, `vk-community-attachments.test.js`, `vk-community-http.js`, HTTP tests.
- Cabinet: `sites/synapse/cabinet/vk-community.js`, `vk-tools.js`, their DOM tests. No general UI rework.
- Coordinator: specs/docs, `vk-tools-http.js`, service/proxy wiring, integration tests and verification.

Contracts: materials through `/vk-tools/design/albums`, `/material-preview`, `/material-apply`, `/material-history`; module methods `listAlbums`, `preview`, `apply`, `history`. Inbox through `/vk-community/reply-preview` and `/reply-confirm`; methods `previewReply`, `confirmReply`. Preview payload image/file data stays local until explicit apply/confirm. Existing routes remain.

Validation: targeted mock unit tests, DOM tests with isolated jsdom, actual local proxy fixtures with outbound network disabled, existing VK and Onlypult regression workflow, Spec Kit gate/convergence, independent review of frozen candidate. Draft PR only.
