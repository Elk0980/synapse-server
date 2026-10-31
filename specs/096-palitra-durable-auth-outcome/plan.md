# План

Node CJS/SQLite и существующий storefront JS/jsdom. Single writer Root. Allowed: ops/palitra-auth-outcome-20261031, specs/096-palitra-durable-auth-outcome, новые receipts P0_AUTH_OUTCOME_20261031 и текущая status memory. Копии7 frozen R1 — baseline, actual fresh server pins отсутствуют. Не изменять R1, auth flags, чужие компании, prototype recovery providers.

1. Existing AccountService: scoped durable journal и secret-cookie proof, prepare/claim/commit/readback/resume/cancel; outcome/body matching; старый source user не служит target identity.
2. Deterministic target cookie derived via HMAC from attempt secret+server nonce, journal only hashes. Account target bound only after normal verified credentials. Idempotent central completion через existing provider; old/fresh guest mismatch fails closed.
3. Existing storefront consumer: memory-only operation state, explicit retry/resume, no auto password resend; recovered account state before register; wishlist failure does not re-enter signup.
4. New exact fault matrix before/after relevant writes/commits, restart on persistent fake DBs, response/cookie loss, negative isolation; pins/full diff/syntax/Spec convergence/freeze and independent review.

Actual site-workspace-http wrapper is not among available pinned sources; no assertion of live route forwarding/new routes. Conditional release remains blocked until actual sources. CrossDB crash atomicity is not promised; durable account outcome is authoritative for this operation.

31Oct actual-source stage: existing Chrome3 Timeweb parent/iframe подтверждены, UID0/currentR7/source12 прочитаны. Cached HTTPaced/host7799/workspaceHTTP3f08 теперь exact current по serverSHA; прежняя строка о missing источниках историческая. Разрешённый рабочий integration каталог ops/palitra-production-integration-20261031; before12 immutable source copies, accepted127 freeze не менять. Merge actualHTTPguards/widget settings с accepted proof/DTO; Push provider берёт тот же server HTTP orderContext. Не писать deployhelper/runtimepackage до отдельного pending общегоcontent scope.


## Lifecycle R2 после реального preservation-stop31Oct

R1 helper/stage/prehistory/prepare подтверждены, build остановился до журнала из-за CRM events/sqlite_sequence; production R7/337 не менялся. СтаруюBASE не перезаписывать. Новый узкий R2 переносит обе imagebuilds до finalfreshBASE, связывает stagedcode/образы, сохраняет exactwholeDB/backup/apply и блокирует directprepare/applyCLI. 14 lifecycle + отдельные14 release delta PASS; source review/production/5TestКЛ paths ещё OPEN. Receipt: SERVER_ACCESS_RESUME_20261031/RELEASE_PROTOCOL_R2/FOR_REVIEW.md.

## Actual sparse-layer R3 — PRIVATE/source review pending

R2 main built, fallback stopped at strict archive because actual layer onlysite-orders while manifest3 included2unchanged files. Runtime R7/managed337 unchanged; no finalBASE/backups/apply. R3 fixes effective manifest/factory1 and preserves server/manager/fulltree; strictvalidator unchanged. New phase validates only two fixed existing image IDs and exports code artifacts, no Docker rebuild/replay/old journal writes. Sparse6, release14 and lifecycle14 PASS in separate runs; syntax16. Native validation/release/clientadmin5paths OPEN. Receipt RELEASE_EFFECTIVE_LAYER_R3/FOR_REVIEW.md.


## Corrected generated package boundary

Independent R3 review caught missing payload/server.js under one-file contract. Previous draft unexecuted and archived. Factory pins separate immutable server-after control and rewrites real package proof-read, leaving payload1/runtime controls. Actual package()337/338 + predecessor FNF/tamper/extra negatives covered; local Windows fileIO fixture only, production Linux safe_read unchanged. Separate7+14PASS, old14 lifecycle carried unchanged; source/native/production boundaries preserved. New review RELEASE_EFFECTIVE_LAYER_R3/REVIEW_R2/FOR_REVIEW.md pending; no production update yet.
