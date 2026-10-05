# Local validation only

Requires Node 24 with `node:sqlite`, Python 3, and jsdom 26.1.0 for DOM tests. Install the DOM dependency in a temporary directory and set `NODE_PATH` to its `node_modules`; no runtime dependency is added.

```sh
node --test ops/crm/vk-*.test.js ops/crm/social-vk*.test.js ops/crm/social-stats.test.js ops/crm/social-onlypult-flow.test.js ops/crm/autoposting-onlypult-flow.test.js ops/content/vk-*.test.js sites/synapse/cabinet/vk-*.test.cjs
python tools/spec-kit/gate.py check
git diff --check
```

Provider tests inject fake fetch implementations. Content→CRM integration tests start temporary local services and disable outbound sockets in the CRM fixture; credentials, database contents, files and recipients are synthetic. These tests never need a VK account, OAuth grant or production database. Temporary fixture services stop in test cleanup.

Review the handlers and UI together: preparation must not upload, confirmation must freeze destination/content, repeated IDs must return the saved outcome, another company/revision must fail, and an unknown result must remain visible without automatic resend. Incoming unsafe links and unsupported media must render as unavailable.

The GitHub `vk-direct-tools` workflow already includes new `vk-*.test.js` and cabinet tests by filename glob. Draft PR creation triggers checks only; do not merge or deploy this increment.
