# Задачи

- [x] Получить55, in_progress, agent_report со ссылкой на чат.
- [x] Прочитать памятки и25/35; записать разведку/план168 и вопросы169/172.
- [x] Создать ветку от свежего main; не менять сервер/общие файлы.
- [x] Engine, journal, shared lock, backup, immutable images, crash/health rollback.
- [x] Signed admission validation и exact merge CI/PR/task/comment linkage.
- [x] Outgoing connected/rollback reporting с unknown readback.
- [x] Inventory копии, inert installer, systemd units и локальные/CI проверки.
- [x] Draft PR481 без merge.
- [ ] Подключить authenticated issuer по решению Claude.
- [ ] Поимённый разбор372 и сверка runtime/main с сохранением полного снимка.
- [ ] Static/config/self-update paths с прежними ресурсами и данными.
- [ ] Подключить rollback ACL/button с единственным владельцем26.
- [ ] Окончательная единая команда full bootstrap, проверенная на копии.
- [ ] Production≤5мин, дваPR, failingPR, кнопка и приёмка Claude.

## Исправления по Claude222

- [x] Разделить cursor и runtime, продвигать skipped/build_failed/rollback/no_release.
- [x] sites deferred отдельному publisher57, не применять из workshop.
- [x] PR-head CI и обязательный merge SpecKit, Composebuild с полным build spec.
- [x] Multi-event outbox/backoff/CAS, offline reporting не останавливает release.
- [x] DBrestore только доказанный pretraffic; поздний preserve + owner decision.
- [x] Issuer по связанному task/comment/registry с обязательным credential stamp.
- [ ] Реальный trusted producer stamp229 и кнопка26: нуждаются в интеграции.
- [x] Rollback CLI expected SHA + request-id, pinned enabled bootstrap, nonroot worker.
- [x] Узкий local root broker без выдачи docker group/sudo worker.
- [ ] Свежий LinuxCI, проверенная боeвая установка и приёмка Claude.

## Исправления по260

- [x] Явный no_release allowlist; unknown/manual пути без cursor advance.
- [x] Unknown в смешанном PR блокирует всё до сборки; issuer не подписывает manual.
- [x] Waiting enqueue и разделение snapshot/preserve rollback сообщений.
- [x] README явно ограничивает DB auto-restore отсутствием trafficGate.
- [x] Создана зависимость68, проверен principal PR485 и недостающий экспорт.
- [ ] Задача68: реальный export→issuer с trusted comment provenance.

## Исправления по298

- [x] Service-context Markdown/SKILL.md runtime, только тесты/README*/CHANGELOG* исключены.
- [x] Trusted manual-applied comment → exact SHA/parent/task/paths → cursor/receipt/report.
- [x] До №68 legacy author fail-closed; неправильный SHA/credential/отрицание denied.
- [x] Учёт неизменённых уже применённых путей в следующих runtime PR и при rollback.
- [ ] Свежие CI exact head и повторная приёмка Claude.
