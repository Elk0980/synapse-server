# Свидетельства (время — Бангкок)

## (а) Сервер — 05.11 00:01
- `node --test ops/content/team-chat*.test.js ops/content/people*.test.js ops/crm/people*.test.js ops/crm/team-chat*.test.js ops/crm/task*.test.js sites/synapse/cabinet/team-chat.test.cjs`:
  138 тестов, 136 pass, 1 fail, 1 skip. Падение `task-*.test` №18 «board products and plan use existing cabinet session…» воспроизводится и на базе PR 493 без этих изменений (не связано).
- `ops/content/team-chat-rooms.test.js` (4): Хью молчит без обращения («Мы вчера обсуждали это с Хью», «Хьюстон…» — без ответа; «Хью, …», «@Хью», лог — с ответом);
  личный чат не читают третий сотрудник и владелец; чужая компания — 403; «Хью, поменяй контент-план» → задача Хью, сведение Лена↔Таня, запрос другой компании не сводится, телефон скрыт; комментарий по задаче один раз.
- `ops/crm/people-board.test.js` — реальный процесс CRM: разделы «Мне поставили»/«Я поставил Хью», источник system/manager, порядок, пауза (повтор без дубля комментария),
  «Удалённые» и возврат при `is_deleted=0`, чужая задача/компания — 404/403, без `tasks.self.edit` — 403.
- `ops/content/people-http.test.js` — реальный HTTP content: обращение к Хью, тишина без обращения, `team-chat/rooms`, личный чат, чужой лог — 403.
- `python3 tools/spec-kit/gate.py check` — status ok, 48 файлов.

## (б) Интерфейс — 05.11 00:20
- Модули `chats`, `hugh-chat` (`sites/synapse/cabinet/chats.js|css`), `tasks` (`my-tasks.js`) регистрируются через `window.SynapseModules.register`
  или очередь `SynapseModulesQueue` (контракт А, `specs/098-content-shell/contracts/module-registry.md`); ctx.api → `/content/people/*`.
- `node --test sites/synapse/cabinet/chats.test.cjs` (jsdom): 2/2 — регистрация трёх модулей, текст сообщений без HTML,
  отправка в выбранную комнату, разделы задач, перестановка ↓ → `order [12,11]`, «Удалить» → «Удалённые · 1», «Чат с Хью» → лог с `taskId`.
- Playwright (Chromium) на `ops/dev/chats-preview.cjs` (реальные team-chat.js и people-board.js, sqlite в памяти, синтетические данные QA):
  chats/tasks/hugh-chat × 390 и 1440 — `scrollWidth == clientWidth` во всех 6 случаях (390/390, 1440/1440), ошибок консоли 0.
  Снимки: в рабочем каталоге агента (не в git): chats-list-390, chats-390, chats-1440, tasks-390, tasks-1440, tasks-hugh-*, hugh-chat-390/1440.
- Видно на снимке лога: «Поменяй контент-план …» → «Я поставил Хью · задача №7» и сообщение Хью о похожем запросе Тани (№6).

## (б) Встраивание в экран «Задачи» и повторная проверка — 05.11 00:55
- Оболочка А не маршрутизирует `#tasks` в реестр (в контракте это «существующий экран»), поэтому `my-tasks.js` оборачивает прежний вид `tasks`:
  сотрудник на `#tasks` видит свою доску (модуль `tasks` через `SynapseModules.mount`), владелец — общую доску и ссылку «Мои задачи» → `#tasks/mine`;
  карточка `#tasks/<id>` открывается прежним экраном; без реестра А всё работает как раньше.
- `node --test sites/synapse/cabinet/chats.test.cjs` (jsdom): 4/4 — добавлены перетаскивание (dragstart→dragover→drop → `order [12,11]`) и встраивание в `#tasks`
  (сотрудник/карточка/владелец/`#tasks/mine`/уход с экрана: последовательность mount/unmount/legacy проверена).
- Playwright (Chromium), `ops/dev/chats-preview.cjs`: chats/tasks/hugh-chat × 390 и 1440 — `scrollWidth == clientWidth` 6/6 (390/390, 1440/1440), ошибок консоли 0;
  чаты: 5 комнат (общий, 3 личных, лог Хью), 4 сообщения в общем; задачи: 3 строки, 6 кнопок ↑↓; лог Хью: 2 сообщения.
- `python3 tools/spec-kit/gate.py check` — status ok, 48 файлов.
- Размер (б): 490 строк в 5 файлах + 1 строка регистрации в `cabinet.html` — один PR без разделения на (в).
- Не проверено: живой кабинет вместе с веткой А (оболочка ещё не на main), рабочий сервер, доступы Лены/Тани/СММ.
