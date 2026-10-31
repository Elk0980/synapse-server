# Tasks

- [x] T001 Сверить exact R1 baseline, concrete failure и границы; EARLY_STATUS/BEFORE.
- [x] T002 Реализовать proof-bound durable journal в existing AccountService и локальный модуль outcome, не отдельную службу.
- [x] T003 Подключить existing storefront к prepare/readback/resume без auto register и отделить wishlist failure.
- [x] T004 Новые fault/restart/response-loss/isolation fixtures на реальных candidate functions.
- [x] T005 Full diff/pins/syntax/frozen127 successor/точные boundaries и независимое source review07:17; runtime отдельно открыт.

Зависимости строго T001→T002→T003→T004→T005; дополнительных writers нет.

## Phase 2: Convergence

- [x] T006 [FR-001–010] Независимое SOURCE_ACCEPTED_WITH_LIMITS получено от координатора31Oct07:17UTC; frozen35pins неизменны. Это не runtime/release acceptance.
- [ ] T007 [FR-007, blocked] После допустимого восстановления имеющегося доступа сверить actual host/router/adapter/source/schema, полную доставку старых и новых точек входа, совместимый rollback и scope общего content; только затем fresh guards/backup/lease/production/readback и клиентская/административная приёмка. Не исполнять сейчас и не обходить denied transport.
- [ ] T008 [FR-009, open] Отдельно определить допустимое поведение доступа к предварительной guest-истории после входа в уже существующий аккаунт. Сейчас own registered history доступна, новый guest намеренно separate; ни count, ни телефон, ни audit не закрывают этот остаток.

## Phase 3: Actual-source integration

- [x] T009 Восстановить existing authorized browser/iframe route и получить fresh ordinary source12 без env/secrets/business writes; code hashes cache exact, source before сохранён отдельно.
- [x] T010 [FR-011,012] Actual HTTP/host/clientDialogs/Push/workspace integration: final139PASS/syntax34, frozen19/15deltas/4controls. Независимое чтение не нашло блокеров основного кандидата; источник не равен live.
- [x] T011 [FR-013, local] Security-preserving fallback R2: обе cookie/freshproof, A/B/logout, pending outcome OS-restart, actual admin route + сохраняемые cab/shop native+shell; один адресный run4PASS. Первичный fallback admin400 принят и устранён, независимый R2 verdict ещё ожидается.
- [ ] T012 [FR-014] Shared-content scope разрешён08:09UTC; actual source12/schema9/bootstrap/current337 прочитаны. Завершить release review и fresh guards/backup/lease/build/apply/readback, затем пять user/admin путей. Shared-chat diagnostic исключён.

## Phase 4: Guarded production delivery

- [x] T013 [local] Новый точный установщик12runtime+2static и RO verifier official storefront337→338; source guards/queues/economy/foreign/backup сохранены. Раздельные14 release checks,23 managed checks и1 config-identity target. Helper SHA рассчитан по фактическим read_bytes и проверен в основном/fallback model.
- [ ] T014 После независимого ревью доставить immutable commit, сверить downloaded SHA до исполнения; ownlease/prehistory/prepare/backups/build/fallbackimage, один apply/inspect, staticpair, official managed CAS180s/fullreadback, health всех затронутых проектов.
- [ ] T015 Подтверждённый TestКЛ: chat message/direct request/product→request/cart→request/direct manager; маркировка, реальные IDs и client/admin readback. Никаких чужих данных, оплаты, удаления, неизвестных повторов или соцсетей.


## Lifecycle R2 после реального preservation-stop31Oct

R1 helper/stage/prehistory/prepare подтверждены, build остановился до журнала из-за CRM events/sqlite_sequence; production R7/337 не менялся. СтаруюBASE не перезаписывать. Новый узкий R2 переносит обе imagebuilds до finalfreshBASE, связывает stagedcode/образы, сохраняет exactwholeDB/backup/apply и блокирует directprepare/applyCLI. 14 lifecycle + отдельные14 release delta PASS; source review/production/5TestКЛ paths ещё OPEN. Receipt: SERVER_ACCESS_RESUME_20261031/RELEASE_PROTOCOL_R2/FOR_REVIEW.md.

## Actual sparse-layer R3 — PRIVATE/source review pending

R2 main built, fallback stopped at strict archive because actual layer onlysite-orders while manifest3 included2unchanged files. Runtime R7/managed337 unchanged; no finalBASE/backups/apply. R3 fixes effective manifest/factory1 and preserves server/manager/fulltree; strictvalidator unchanged. New phase validates only two fixed existing image IDs and exports code artifacts, no Docker rebuild/replay/old journal writes. Sparse6, release14 and lifecycle14 PASS in separate runs; syntax16. Native validation/release/clientadmin5paths OPEN. Receipt RELEASE_EFFECTIVE_LAYER_R3/FOR_REVIEW.md.


## Corrected generated package boundary

Independent R3 review caught missing payload/server.js under one-file contract. Previous draft unexecuted and archived. Factory pins separate immutable server-after control and rewrites real package proof-read, leaving payload1/runtime controls. Actual package()337/338 + predecessor FNF/tamper/extra negatives covered; local Windows fileIO fixture only, production Linux safe_read unchanged. Separate7+14PASS, old14 lifecycle carried unchanged; source/native/production boundaries preserved. New review RELEASE_EFFECTIVE_LAYER_R3/REVIEW_R2/FOR_REVIEW.md pending; no production update yet.

## Separate current-release managed verifier

Corrected R3 source accepted with limits (57 pins); helper9952 downloaded and independently disk-verified before execution, stage PASS. The bundled predecessor managed verifier still names R1 and must not be used. Separate `ops/palitra-auth-chat-managed-20261031-r3/verify.py` binds exact R3 area/package/manifest21c/helper9952. All other guard functions are AST-exact predecessor. Six targeted isolated provenance tests PASS/0fail (0.489s), including old/foreign/tampered receipt rejection; Linux metadata/native acceptance not implied. Main accepted release files unchanged. Narrow review: SERVER_ACCESS_RESUME_20261031/MANAGED_R3_COMPANION_REVIEW/FOR_REVIEW.md. Actual images/release/static/managed CAS and client/admin QA remain OPEN.

## Native exact-image transcription correction R4

R3 stage/prehistory/imageanchor PASS, reuse1 refused after intent and before child/export/finalBASE/backups/apply. Main image ID in source was mistranscribed. Native build/image.id, child.image and Docker presence agree on all64 actual digits; fixed8 groups, all64 machine assertion and ASCII SHA256first16 a1fd46f9295637e1 independently match local. Wrong R3 ID inspect exit1. R3 sealed unchanged; no replay. Fresh R4 changes only closed namespaces and exact main-ID literal with pin cascades; all executable AST normalized-exact R3 and all product/static/sourceproof bytes exact. Separate local3PASS/1.018s; R4 RO provenance6PASS/0.453s and additional oldR3-area1PASS/0.015s. No old suite rerun. Narrow review EXACT_IMAGE_PIN_R4/FOR_REVIEW.md; actual release and five client/admin paths OPEN.

## R5 fresh natural cache window; R4 sealed

R4 independently source accepted65pins; both native existing image parent/config/fulltree/strictarchive PASS10:55:39UTC. Release1 prepared finalBASE, then refused ECONOMY_CACHE_EXPIRES_IN_WINDOW before backup/apply (metadata confirms). Do not repeat in old AREA. R5 changes only closed namespaces4->5 and bytehash cascade; executable AST normalized-exact and product/static/sourceproof exact R4. Separate3PASS1.035s + companion6PASS0.434s including oldR4 receipts. Operator pacing removes manual gaps: unchanged CLI imageprepare && reuse && release once each, only near start of actually observed new natural cache window, stop on nonzero; independent inspect separate. No provider refresh/CRM pause/guard weakening/new deployment logic. Review FRESH_WINDOW_R5/FOR_REVIEW.md; actual runtime/resources/clientadminQA OPEN.

## R6: images beforehand, direct admission immediately before final release

R5 reached partial backups (11physical files/7 of11paths) before cache-margin STOP, no apply. Foldermtime11:16:57 is latest child addition, not backupentry; the earlier166s single-guard interpretation was wrong. Read-only component timings are fast; repeated26fullguards accumulate. No guard optimization/caching/removal. R6 only namespace5->6/hashcascade, separate3+6PASS; unchanged inline additional cache admission1test/8casesPASS. Complete images before a following fresh naturalwindow within30min imageanchor; then statusok/new checked==attempt/age0..30s gate immediately followed ONLY by release, target first5s. Exact operator commands pinned in EARLY_WINDOW_R6/REVIEW_R2; earlier gate-before-images draft archived70pins and neverexecuted. WholeDB/currentfacts/nonce/clock/TTL/diagnosticchain/foreignconditions remain exact. Native release/resources/clientadmin5QA stillOPEN.


31Oct R7 namespace-only successor: R6 sealed partialimageattestation cacheSTOP beforefinalBASE/apply; no replay. Sourceguards andproductexact, targeted3+6PASS. Images earlynaturalwindow, gate&&ONLYrelease beginningFOLLOWINGactualnaturalwindow under30minanchor. Review/runtime/actual5QA pending.


## Fresh static-only delivery after actual R7 switch

R7 applied once: current content53fcc6…bfea26, started12:35:46.804UTC/restarts0. Pure pinned AuthOutcome constructor initialized exact empty account additive schema; old account rows/schema exact. Original inspect then refused DIAG_CLOCK_WINDOW; no old BASE/journal rewrite or backend reapply. Historical readonly classification found timestamp-only provider refresh and one linked schedule/partial/closed0 CRM run at13:01:46UTC (queueattempts6, evidence+1, snapshot only collected_at/run_id, three sequences). Nine other content paths preserved. This is not old runtime acceptance.

New ops/palitra-auth-chat-static-current-20261031-r1 is a separate explicit current/static context. Exact current fullDB snapshot/new diagnostic journal and original strict static guards, original evidence references and same own lease; CLI only prepare/host/shell/inspect. LF checker only provenance+namespace changed. Targeted18PASS/0FAIL/0.857s; new source review14pins df11e24d7ac932858f25ab157510cc4b53fc8df58c6bea1a93bc4d09baeaccd7 PENDING. Current schema/facts/source/5identity/backup/history/price/nonce/clock/staticTTL/CAS remain mandatory. Native new-context/static/managedSave/5TestKl paths not yet executed. Social actions0, unknown outcomes inspect-only.

R1 fresh companion narrow review requested one missing after-generation binding. Three envelope lines now require historical phaseafter/count2 and original diagnostic_generation equality (Id/StartedAt/restarts0). Native ROread confirms original after2/current identity exact; no late-receipt fallback. Targeted2PASS0.012s plus separate chain1PASS0.087s; old18/139 not rerun. R1 raw source retained69dc1fc/SUPERSEDED_SOURCE. R2 review12pins4fa5e9fa155ffbcad698ef74cebbe66f833261cecc4c72486c665bd7c495b3f2 pending; static0/Save0/QA0.
