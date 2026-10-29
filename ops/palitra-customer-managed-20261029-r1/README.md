# Palitra: customer phone and current-account form prefill

Spec: specs/092-palitra-order-customer-forms.

This frozen payload changes only managed `assets/storefront.js` and `assets/order.js` for site `site-44bbe13f1bad5e005b2a`, company `palitra-love`. Use the existing authenticated site-file editor to create new revisions with its base-revision check. Save storefront first, independently verify, then save order on the fresh revision. Never overwrite immutable historical versions or replay a completed save.

The phone control keeps +7, normalizes a pasted Russian 8 prefix and preserves free messenger handles. Existing account responses expose a readonly presentation lifecycle for pristine checkout fields; account changes invalidate stale autofill. Manually edited fields, consent, auth payloads, passwords, cookies and CSRF remain unchanged. Guest chat reuse and optional registration fields are separate pending work.

Root independently ran 53 mask/prefill/contract fixtures plus 6 actual bindForm channel/fulfillment fixtures, all passing. Syntax checks pass. Before saving: fresh lease, workspace revision, exact file hashes and backup. After each save: history, full manifest comparison, public bytes including old query strings and live form checks. No service restart, queue, business-record or price edits belong to this payload.

Prepared on 29 October 2026; installation evidence is recorded separately after actual readback.

The native HTML textarea normalizes CRLF to LF. `order.editor-lf.js` is the exact editor payload: only CRLF/CR line endings of the reviewed order candidate become LF; all other characters are identical. Its SHA256 is `c590111397343a5b641ed84d44408aac8af82010973a88b106fa0d7ec4860ba6`. The first order save was stopped locally before submission on the byte guard, then this explicit normalized payload was frozen and syntax checked. The server's immutable prior revision remains unchanged.
