# Local verification

Use Node 24. Tests use synthetic fixtures and the real local content-to-CRM proxy with external sockets disabled. Do not point tests at a real VK account or production server. Install/use jsdom 26.1.0 in an isolated temporary directory and set NODE_PATH to its node_modules; no runtime dependency changes are required.

```powershell
node --test ops/crm/vk-*.test.js ops/crm/social-vk*.test.js ops/crm/social-stats.test.js ops/crm/social-onlypult-flow.test.js ops/crm/autoposting-onlypult-flow.test.js ops/content/vk-*.test.js sites/synapse/cabinet/vk-*.test.cjs
python tools/spec-kit/gate.py check
python -m unittest discover -s tools/spec-kit -p 'test_*.py'
```

Inspect the full diff from dbb5f0759fd8a7ec50a5a6ade6069c728568811b. The draft targets 088-vk-materials-inbox, not main; PR450 must remain unchanged. No avatar upload/save methods or configuration to enable them should appear in the runtime transport. POST avatar-apply is a blocked audit endpoint, not a live mutation.

Setup evidence and remaining owner inputs: [VK connection readiness](../../docs/vk-connection-readiness.md), [avatar contract](../../docs/vk-avatar-readiness.md), [separately authorized release preflight](../../docs/vk-release-auth-preflight.md). This procedure grants no credentials, OAuth access, publication, merge or deployment.
