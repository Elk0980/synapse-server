# План

Владелец: Claude · Д «Чаты и Задачи» (задача №103). Ветка `claude/night98-chats-tasks` поверх `codex/team-chat-hugh-80-20261104` (PR 493).

## Существующее, что переиспользуем
- `ops/content/team-chat.js` (PR 480) + `team-chat-answers.js` (PR 493): сообщения, команды, проверенные ответы.
- `ops/content/people-http.js`, `people-tasks.js`, `people-crm-client.js`: сессия, CSRF, `tasks.self.*`, узкий вызов CRM.
- `ops/crm/people-http.js`, `team-chat-task.js`: узкие действия CRM от имени человека.
- Реестр модулей и плавающая панель — оболочка А (`module-registry.js`, контракт А).

## Изменения
- (а) Сервер: колонки `room/kind/ref_task_id/audience_id` в `team_chat_messages` (миграция ALTER, старые строки = `common`);
  `GET /content/people/team-chat?room=`, `GET …/team-chat/rooms`, `GET …/my-board`, `POST …/my-board/action`;
  CRM: `ops/crm/people-board.js` (`myBoard`, `myBoardAction`, `taskChatComment`), `hughTask` через `team-chat-task.js`.
- (б) Интерфейс: `sites/synapse/cabinet/chats.js|css` (модули `chats`, `hugh-chat`), `my-tasks.js` (модуль `tasks`),
  предпросмотр `ops/dev/chats-preview.cjs`, одна строка регистрации в `cabinet.html`.

## Проверки
node --test (unit + реальный CRM-процесс), jsdom модулей, Playwright 390/1440.
