# План CF2-UI
- База: дерево CF1-R2 `e2b582c5` в частной копии Claude; сдача отдельной дельтой.
- Файлы: `sites/synapse/cabinet/content-factory.js` (сводка «Составить план», запуск, опрос, вопросы, предложения, черновики), `content-factory.css`, `autoposting.js` (два события: перечитать список, открыть черновик прямым GET), `cabinet.html` (версия ресурсов `20261001-content-factory-cf2`), тесты `content-factory-generation.test.cjs`, `content-factory.test.cjs`, `autoposting-daily.test.cjs`.
- Существующие контракты кабинета: `crmQuery`/`csrfOptions`, ошибки с `status`/`code`; права `autoposting.view/edit`.
- Не меняется: `ops/`, бриф и двухнедельный план Медиа-наставника (`PUT /media-mentor/plan` не используется), согласование и расписание материалов.
- Проверки: отрицательная проба, DOM-тесты, мутации, весь кабинет, снимки на синтетике, `gate.py check`, `git diff --check`.

## План CF3-BOARD
- База `d8a77069`. Файлы: `sites/synapse/cabinet/autoposting.js` (доска, фильтры, окно редактора), `autoposting.css`, `content-factory.js` (вопрос о часовом поясе, подписи), `cabinet.html` (название вида «Контент-план»), тесты `autoposting-daily.test.cjs`, `autoposting.test.cjs`, `content-factory-generation.test.cjs`.
- Контракты не меняются: календарь `GET /autoposting/calendar`, карточка `GET /autoposting/posts/:id`, существующие правка/согласование/возврат/расписание в редакторе. Новых маршрутов и полей нет.
- Демо и снимки — вне репозитория, в пакете сдачи: временные CRM и сервис контента из рабочей копии, синтетика Palitra, внешняя сеть закрыта.

## План CF3-R1
- База `3e5105c6`. Файлы: `autoposting.js` (разметка окна, кнопка согласования, метка статуса, beforeunload), `autoposting.css` (колонки окна, компактный заголовок), `content-factory.js` (подпись ОВП в предложениях, заголовок сводки), `cabinet.html` (убрана ссылка из строки действий), тесты `autoposting-daily`, `autoposting`, `content-factory`, `content-factory-generation`.
- Контракты прежние: `approve`, `PATCH`, календарь; маршруты кабинета не меняются.

## План CF4-UI
- Сначала независимое ревью backend-снимка `CONTENT_FACTORY_CF4_BACKEND_REVIEW_R1_20261001` (manifest 32) в собственной QA-копии Claude; только чтение `ops/`.
- Файлы UI: `autoposting.js` (форма, история, задача, отправка и восстановление после неизвестного исхода, тексты), `autoposting.css`, тесты `autoposting-daily`, `autoposting`.

## План CF5-UI
- Сначала независимое ревью backend-снимка `CONTENT_FACTORY_CF5_BACKEND_REVIEW_20261001` (manifest 34) в собственной QA-копии Claude; только чтение `ops/`.
- Файлы UI: `autoposting.js` (удаление с подтверждением, «Удалённые материалы», восстановление, перечитывание после неизвестного исхода, подсказки полей), `autoposting.css`, `content-factory.js` (`archivedAt` при повторе переноса), тесты `autoposting-daily`, `content-factory-generation`.
- Контракты: `POST …/archive|restore {revision}`, `GET /autoposting/archived`, `DTO.archive`, `drafts[].archivedAt` — без изменения API.

## План CF6-UI
- Снимки backend накладываются только в собственную QA-копию: CF5 (34) → HISTORY_BATCH (10) → CF6 STATS_LINK (6). Ревью — одна собственная проба связи `autopostingId`; batch не перепроверяется.
- Файлы UI: `content-factory.js` и `content-factory.css` (дневной график, таблица значений, «Открыть материал»), `autoposting.js` и `autoposting.css` (ожидающий запрос открытия, нейтральное сообщение, свёрнутая история), тесты `content-factory-stats`, `autoposting-daily`.
- Контракты не меняются: `GET /social-stats`, `GET /autoposting/posts/:id`, событие `sb:content-factory-open-draft` (+ поле `source`).
## План CF7-UI
- Снимок CF7 (17 файлов, SHA сверены) накладывается только в собственную QA-копию поверх CF5 34 → HISTORY_BATCH 10 → STATS_LINK 6. Ревью — одна ограниченная проба C1–C3; большой аудит Codex не повторяется.
- Файлы UI: `content-factory.js`, `content-factory.css` (группы выбора, сводка, 409, ограничения в сводке плана, переход из вопроса), `autoposting.js` (группа удалённых в импорте); тесты `content-factory-month-choices` (новый), `autoposting`.
- Контракты не меняются: GET/PUT `/media-mentor/inputs/months/:month`, `GET /media-mentor/inputs` (словарь), `POST/GET /media-mentor/generation`, `POST /autoposting/import`, `GET /autoposting/archived`. Новый только параметр адреса настроек (`?company&month&focus`), обрабатываемый на клиенте.
## План CF13-UI
- Владелец записи: Claude — только `sites/synapse/cabinet/telegram-sources.js`, `telegram-sources-view.js`, `content-factory.css`, `autoposting.js` (сообщение открытия из «Исходников»), их тесты, `cabinet.html` (заголовок вида) и `specs/053`. `ops/`, общая копия и QA Codex — только чтение; снимок CF13 (55) накладывается только в собственную QA-копию.
- Модуль `telegramSources.mount` расширяется зависимостями из адаптера: `request` (GET), `send` (JSON с CSRF), `uploadFile` (XHR multipart с прогрессом), `openPost`. Адаптер проверяет компанию, право и URL каждого запроса.
- Контракты не меняются: `GET /content/telegram-sources/:company`, `POST …/upload`, `PATCH …/:id/metadata`, `POST …/:id/attach`, `GET …/:id/usage`, `GET /content/crm/autoposting/posts`, событие `sb:content-factory-open-draft` (`source: 'sources'`).
## План CF17-UI
- Владелец записи: Claude — `sites/synapse/cabinet/telegram-sources.js`, `module-guide.js` (одна строка подсказки вкладки), тест `telegram-sources-cf13.test.cjs`, `specs/053`. Контракты и `ops/` не меняются.
## План CF19-UI
- Владелец записи: Claude — `sites/synapse/cabinet/content-factory.js`, `content-factory-generation.test.cjs`, `content-factory-stats.test.cjs`, `specs/053`. CSS не меняется (используются существующие классы). Контракты не меняются: `GET /media-mentor/generation` (до 20 задач месяца с предложениями), `POST …/:id/drafts`, `GET /autoposting/calendar` (`meta.format/role`, `calendarReadiness.platforms`), `GET /social-stats` (`crm.posts[].format/ovpRole` nullable — добавляет root; до этого — неизвестно).

## План CF19-R1-UI
- Владелец записи: Claude — `sites/synapse/cabinet/content-factory.js` (одна таблица псевдонимов и её применение в списке площадок и сравнениях фильтра), `content-factory-stats.test.cjs`, `specs/053`. Контракты, `ops/`, CSS, интерфейсы workflow/вариантов/истории не меняются.
- Проверки: отрицательная проба нового теста на `64b8e53c`, проба root на исправленном файле, целевой набор `content-factory*.test.cjs`, `gate.py check`, снимки ПК 1366 и телефон 390.

## План CF23-UI
- Владелец записи: Claude — `sites/synapse/cabinet/content-factory.js` (блок «Подготовка и выпуск»), `autoposting.js` (версия для площадки, полная история), новые тесты `content-factory-workflow.test.cjs` и `autoposting-cf23.test.cjs`, CSS только при необходимости, `specs/053`. `ops/`, общий checkout, QA root, состояние и manifest — только чтение.
- Контракт — `CONTENT_FACTORY_CF23_BACKEND_REVIEW_20261001/CONTRACT.md`. Транспорт — существующие `ctx.crmQuery`/`ctx.apiJson` с CSRF; новых прав нет.
- Проверки: отрицательная проба на `ce468daf`, целевые тесты `content-factory*`, `autoposting*`, `materials-ui`, `platform-links`, gate, свежее применение 11 патчей, демо на настоящих сервисах в собственной QA-копии (дерево CF23 + снимки CF5 34 → HISTORY_BATCH 10 → STATS_LINK 6 → CF7 17 → CF13 55 → CF23 64), ПК 1366 и телефон 390.

## План CF26-UI
- Владелец записи: Claude — `sites/synapse/cabinet.html` (только `responseError`: запасной `details.code`), `autoposting.js` (строка `planLink` в окне карточки), `media-mentor.js` (адрес фокуса, кнопка переноса одной версии, точная расписка), новые тесты `media-mentor-cf26.test.cjs`, `autoposting-cf26.test.cjs`, `cabinet-error-code.test.cjs`, CSS только при необходимости, `specs/053`. `ops/`, общий checkout, QA root, состояние и manifest — только чтение; активные файлы CF28 (Codex) не читаются.
- Контракт — `CONTENT_FACTORY_CF26_BACKEND_REVIEW_20261001/CONTRACT.md`. Транспорт — существующие `ctx.crmQuery`/`ctx.apiJson` с CSRF; адрес фокуса — существующий маршрут оболочки `content-factory/plan/proposals` с параметрами. Состояние незавершённого переноса — в памяти модуля по компании и выбору.
- Проверки: отрицательная проба на `9efbb446`, целевые тесты `media-mentor*`, `autoposting*`, `content-factory*`, `materials-ui`, `mentor-simple-flow`, весь кабинет один раз, gate, свежее применение 12 патчей, проба и демо на настоящих сервисах в собственной QA-копии (дерево CF26 + CF5 34 → HISTORY_BATCH 10 → STATS_LINK 6 → CF7 17 → CF13 55 → CF23 64 → CF26 66), ПК 1366 и телефон 390.
## План CF26-R2-UI
- Владелец записи: Claude — `sites/synapse/cabinet/media-mentor.js` (проверка текущей отрисовки после каждого ожидания, явный фокус компании), `media-mentor-cf26.test.cjs` (регрессии R2 и фиксированные часы), часы фикстур в `media-mentor.test.cjs` и `media-mentor-variants-ui.test.cjs` (без изменения проверок), `specs/053`. Остальные `sites/`, `ops/`, QA root, состояние, manifest и общая копия — только чтение; проба root не меняется.
- Причина пяти падений root (789/794): порядок «Ближайшие сначала» считает «сегодня» по местной дате; при местном 2026-10-02 материал 2026-10-01 уходит в конец как прошедший, а тесты ждали его первым. Исправление — фиксированные часы окна теста (2026-09-30), а не изменение фильтра или ожиданий.
- Проверки: отрицательная проба R2 и проба root на `95a6977f`, проба root после исправления, целевой набор и весь кабинет в UTC и Asia/Bangkok, gate, `git diff --check`, свежее применение 13 патчей, проба на настоящих сервисах, демо ПК 1366 и телефон 390 с поздним ответом после перерисовки.
## План CF26-R3-UI
- Владелец записи: Claude — `sites/synapse/cabinet/media-mentor.js` (снимок полей раздела при начале действия и проверка в момент применения плана, фокус в момент применения, сбой перечитывания без замены формы, привязка строки переноса к версии панели), `media-mentor-cf26.test.cjs`, `specs/053`. Старые тесты с часами, остальные `sites/`, `ops/`, QA root, состояние, manifest — только чтение.
- Проверки: пробы root 6 на `34ec68f6` (4/6) и после исправления; новые тесты на `34ec68f6`; целевой набор и весь кабинет; gate; `git diff --check`; свежее применение 14 патчей; проба на настоящих сервисах; демо ПК 1366 и телефон 390 с явными пределами (поздний ответ плана — DOM).
## План CF29-UI + CF26-R4
- Владелец записи: Claude — `sites/synapse/cabinet/content-factory.js` (параметр `crmPeriod=project` вкладки «Статистика», проверка `crm.period`, методика, строка периода, подпись таблицы, неподтверждённые заявки), новый `content-factory-stat-period.test.cjs`, существующие тесты статистики только при необходимости; `media-mentor.js` (только обработчик загрузки материала: снимок полей, проверка текущей отрисовки, точная запись и её материалы) и `media-mentor-cf26.test.cjs`; `specs/053`. CSS — только если потребуется. `cabinet.html`, `autoposting.js`, остальные `sites/`, `ops/`, QA root, состояние, manifest, общая аналитика, T130/Tanya — только чтение. Пробы root не меняются.
- Контракт — `CONTENT_FACTORY_CF29_STATS_REVIEW_20261001/CONTRACT.md`. Проверка границ периода — через `Intl.DateTimeFormat` с поясом из `crm.period`: локальная дата `startInclusive` = `from`, на 1 мс раньше — предыдущий день; локальная дата `endExclusive` = день после `to`, на 1 мс раньше — `to`. Загрузка использует прежние `ctx.apiJson` (`/content/publishing-assets`) и `PATCH /autoposting/posts/:id` с ревизией; перечитывание — прежний `load` с охраной R3.
- Проверки: пробы root (3 статистики + 2 загрузки + 6 R3) на `0c4eff53` и после; новые тесты на `0c4eff53`; целевой набор в UTC и Asia/Bangkok; весь кабинет один раз; матрица часов; gate; `git diff --check`; свежее применение 16 патчей; QA-копия (дерево + CF5 34 → HISTORY_BATCH 10 → STATS_LINK 6 → CF7 17 → CF13 55 → CF23 64 → CF26 66 → CF29_STATS 80) с настоящими синтетическими CRM и сервисом контента; ПК 1366 и телефон 390 с явными пределами.
## План CF29-R2 / CF26-R5
- Владелец записи: Claude — `media-mentor.js` (одна проверка `isCurrent()` сразу после ответа файла вместо проверки только компании), `media-mentor-cf26.test.cjs` (исправленное ожидание A→B→A и новый тест повторного открытия), `media-mentor.css` (блок «Черновики и файлы»: `minmax(0,1fr)`/`min-width:0`, ширина поля файла и кнопок), одна правка CF19 в `content-factory-stats.test.cjs`, `specs/053`. Остальные `sites/`, `content-factory.js`, тест периода, `autoposting.js`, `cabinet.html`, `ops/`, пробы root, QA root, состояние, manifest — только чтение.
- Проверки: 16 проб root на `23ad8cee` и после; новые тесты на `23ad8cee`; целевой набор в UTC и Asia/Bangkok; весь кабинет один раз; матрица часов для CF19; gate; `git diff --check`; свежее применение 17 патчей; P1–P6 на настоящих синтетических сервисах; браузер 390/1366 с измерением дочерних прямоугольников (и тот же замер на `23ad8cee`).
## План CF29-R3
- Владелец записи: Claude — одна строка в случае CF19 «поля format/ovpRole ещё не приходят…» (`await f.month('2026-10')` после отрисовки) в `content-factory-stats.test.cjs`, `specs/053`. Остальные файлы — только чтение.
- Проверки: случай и весь файл статистики на `9aa6de8b` и после правки — обычные часы, 2026-11-15 и 2027-02-15 (libfaketime) в UTC и Asia/Bangkok; gate; `git diff --check`; свежее применение 17 патчей. Весь кабинет, backend и браузер не повторяются: код кабинета не меняется.
