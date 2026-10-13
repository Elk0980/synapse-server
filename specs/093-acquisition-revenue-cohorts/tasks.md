# Задачи
- [x] T001 Проверить и отклонить кандидат first-payment-date; ограниченно исправить acquisition-date через Claude.
- [x] T002 Лично проверить24 теста исправленного кандидата и полный алгоритм.
- [x] T003 Добавить строгие даты/безопасные отношения/неподтверждённый НДС и adversarial tests.
- [x] T004 Подключить текущие SQL данные/observationTo/trusted scoped resolver без публичного подтверждения доказательств.
- [x] T005 Добавить доступный интерфейс и локально проверить API/DOM/сохранность.
- [ ] T006 Подключить реально доказанные lead/native links, полный lead journal/историю/расходы/маржу.
- [ ] T007 Личная рабочая приёмка обеих компаний и restart/second cycle всехисточников.

## Phase 1: Convergence
- [x] T008 HIGH Реализовать общий явно выбранный экономический календарь для Директа/UTC-native YCLIENTS/остальных расходов per FR004. API/кабинет выбирают анализный календарь; исходный timezone и UTC-покрытие сохраняются. Дневные суммы не сдвигаются; распределение пакетов2ГИС требует подтверждённого периода/правила. Код локально проверен; реальные данные и рабочая приёмка остаются T010.
- [ ] T009 HIGH Подключить persistent native lead/record proof reader и полный журнал заявок вместо injected facts per FR003/FR008/SC002 (missing); HTTP flags не являются доказательством.
- [ ] T010 HIGH Завершить реальные источники/полную историю/расходы/маржу и рабочую приёмку per SC002/SC003 (partial); ни вычислитель, ни локальный SQLite цикл не заменяют этот результат.

## Журнал приёма форм
- [x] T011 Подключить append-only receipts к обеим веткам POST /leads и сессии start/heartbeat/close к lifecycle сервера per FR009; прежняя заявка и доставка уведомлений сохраняются. Проверено локально; рабочая установка отдельно SC003.
- [x] T012 Проверить настоящий локальный HTTP intake, атомарность, company/privacy/origin scope, поддельные proof и restart gap per SC004. 8 HTTP-тестов без пропусков, включая Windows graceful fixture IPC и аварийное завершение только собственного child.
- [x] T013 Подключить scoped readonly журнал к существующему отчёту и кабинету, отдельно от первого касания и денег; проверить SQL/DOM и сохранить точные локальные доказательства. Существующий cohort leadJournal остаётся unavailable до genuine native linkage; receipt блок не повышает доверие.

## Phase 2: Convergence
- [ ] T014 HIGH Подключить persistent подтверждённое первое касание и native lead/record/client proof reader в server.js per FR003/FR008 (missing). Текущий receipt доказывает лишь принятую HTTP-попытку; source initializer не передаёт cohortFacts. Нужны реальные происхождение/корреляция/изоляция без совпадений контактов или public proof flags.
- [ ] T015 HIGH Подключить trusted полный payment-history/spend/VAT/record-cost reader per FR004/FR008 (missing). Вычислитель принимает scoped факты, но сервер ещё не получает доказательства полной истории, сравнимых затрат и себестоимости; неизвестное не превращать в verified.
- [ ] T016 HIGH Завершить фактические подключения всех10источников и рабочую приёмку обеих компаний per SC002/SC003 (partial). Проверить native источник→заявка→record→visit→cash, полномерную экономику и постоянный цикл после restart/второго реально наблюдённого планового запуска в подтверждённом окне одного писателя; локальные fixtures этого не доказывают.

## Источники экономических фактов
- [x] T017 Подключить readonly Direct native spend reader к настоящему SQL report per FR004/FR006/FR008/FR010. Текущая ревизия/tenant/config/native metadata/даты/нулевой полный ответ/поздние конфликты/SQL snapshot ограждаются; coverage одного провайдера явно partial и не подтверждает прочие расходы, first touch или native клиента. Полная T015/SC002 остаётся открытой.
- [x] T018 Сохранить точные native micro суммы в существующем cohort алгоритме per FR004/FR005/FR010, final-only rounding и строгая неполнота native report range. Проверить fractional kopeck, mix units, package allocations, CAC/ROMI и прежнюю денежную семантику; не превращать NULL/partial в0/verified.


## Phase 3: Convergence
- [ ] T019 HIGH Подключить genuine persistent первое касание и native lead/record/client proof producer+reader per FR003/FR008/T014 (missing). Новый Direct expense resolver не выдаёт native связь: leadBindings/paymentHistory null, source firstTouch не подтверждён. Нужен проверенный authenticated контракт корреляции и изоляция, без receiptReceivedAt/browserID/from_url/contact heuristics/public proof flags; не менять online booking/business data ради обхода отсутствия доказательства.
- [ ] T020 HIGH Завершить trusted полный client payment-history/expense inventory/VAT-income/record-cost reader per FR004/FR008/T015 (partial). Текущий resolver читает только фактический canonical Direct range, complete:false/coveredRanges; отсутствие остальных источников не ноль. Нужны реальные полные источники и сопоставимые валюта/налог/календарь без уменьшения scope.
- [ ] T021 HIGH Подтвердить SC002/SC003/T016 для обеих компаний и всех10источников (partial): native source→lead→record→visit→real cash/refunds, экономика полного окна, production install/перезапуск/второй наблюдённый плановый цикл. Только отдельное подтверждённое окно одного писателя, freshbase/backup/rollback; текущие183local backend/18DOM и cache/WAL fixtures не являются этим результатом.
