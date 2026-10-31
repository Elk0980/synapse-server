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
