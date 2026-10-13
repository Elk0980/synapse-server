# Задачи
- [x] T001 Проверить primary MAX документы и прямую официальную ссылку на schema.yaml, сохранить точные поля/ограничения без выдуманных API/statistics.
- [x] T002 Ограниченно реализовать encrypted-provider-compatible MAX access, authenticated binding и safe readonly transport через Claude; Root проверяет native scope/precision/revision/denied/stop/SQLite tests. Код и31 локальный тест, реальные доступы остаются T007.
- [x] T003 Параллельно реализовать MAX native current/lifetime collector, UTC boundaries/pagination/known post refresh; Root проверяет реальные контрактные границы и тесты, не принимает fake daily history. Код/13 локальных тестов; полный индекс/backfill не закрыт.
- [x] T004 Root подключает provider/accounts/access routes/adapter/server/shutdown и сохранённое расписание/index/backfill к текущей системе, проверяет отсутствие смешения компаний/дат/контекстов.
- [x] T005 Root добавляет lifetime post observation metadata/fencing и явно показывает семантику/неполноту в кабинете, сохраняет прежние источники и ручной ввод. Локально проверены246 social/24 DOM, старые строки перенесены с unknown period.
- [ ] T006 Выполнить actual integration/HTTP/DOM и регрессию текущих social источников, Spec gate/converge/diff; selective commit/push/update PR с единственной Spec строкой, проверить exactHEAD CI.
- [ ] T007 Подключить фактические существующие MAX доступы/каналы обеих компаний, подтвердить метрики/историю/индекс и рабочий persistent цикл после restart/second scheduled run; не заменять это локальными fixtures.
- [ ] T008 Сохранить полный scope10источников/native денежной цепочки/полной экономики; MAX счетчики не являются её завершением.

## Phase 1: Convergence
- [x] T009 HIGH Реализовать persistent полный native metadata backfill/index coverage в текущем MAX scheduler per FR005/FR008 (missing). Day enumeration и rotating known IDs обновляют только уже захваченный индекс; нужны возобновляемые bounded исторические шаги, boundary/uncertainty/coverage без фиктивного полного успеха.
- [x] T010 HIGH Подготовить и локально проверить совместимый rollback для post-period миграции per plan: backup/rollback (missing). Старый ON CONFLICT(post_id,date,metric) не работает с новым ключом; сохранить все новые наблюдения/происхождение в архиве и не выбирать произвольное значение mixed periods. Проверить отключение только нового MAX worker без нарушения прежних пяти источников.
- [ ] T011 HIGH Подтвердить реальные существующие доступы/оба канала/MAX metric constraints/full index и постоянный production цикл per SC002/SC003 (partial). Только отдельное подтверждённое окно одного писателя, свежая база/backup/rollback и реальные API/restart/second scheduled run; full10/native chain/economics остаются обязательными.


## Phase 2: Convergence
- [ ] T012 HIGH Подтвердить FR005/FR008 и SC002/SC003 на реальных существующих каналах обеих компаний после установки текущего bounded backfill/archive-aware кода: temporal inclusion, плотные границы/неопределённость и полнота native индекса, штатные обновления известных IDs, production restart и второй фактический плановый цикл (partial). Локальные450posts/reopen/281tests не являются этим доказательством; нужен отдельный подтверждённый ресурсный слот, свежая база/backup/совместимыйrollback. Приёмка full10/native chain/economics отдельно по071/093 остаётся обязательной.
