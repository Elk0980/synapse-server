# План 228

Владелец работ: Claude (ветка `claude/leo-agent-replies`). Разрешённые файлы: перечисленные ниже, `specs/228-leo-agent-replies/`.

## Существующие модули и контракты
- `ops/content/team-chat.js` — комнаты (`common`, `dm:a-b`, `hugh:<id>`), `chatAccess`, `room()`, `list`, `send`. Добавлено: таблица `team_chat_agent_replies` (reply_id, message_id, persona, owner_id, created_at), видимость ответов агента всем читающим комнату, поле `agentReply` в `list`, вызов ассистента по «Лео, …» (`leoAddressed`), экспорт `scope()` — та же проверка комнаты для агента.
- `ops/content/team-chat-answers.js` — встроенный ответ. Добавлено: персона Лео (имя в инструкции, автор «Лео · ИИ»), запасной ответ Лео `agent_pending` / `agent_redirect`, `finish` не пишет после `agent_answered`.
- `ops/content/team-chat-agent.js` (новый) — `reply`, `inbox`; владелец проверяется повторно по роли из `chatAccess`.
- `ops/content/people-http.js` — два маршрута до общего блока; `role=owner` до чтения тела, `read(code,true)` = CSRF + свежая сессия владельца.
- `ops/content/people-service.js` — подключение модуля.
- `sites/synapse/cabinet/chats.js`, `team-chat.js` — подпись персоны и статусы.

## Миграции
`CREATE TABLE IF NOT EXISTS team_chat_agent_replies` + индекс; существующие таблицы не меняются, статусы журнала — новые значения в TEXT-поле.

## Риски
- Ответ агента видят все читающие комнату (в отличие от встроенных ответов, видимых спрашивающему и владельцу): это сообщение, которое владелец осознанно публикует от персоны.
- Сотрудник без доступа к задачам (редактор без «задач») запасного ответа не получает, как и для Хью; его обращение к Лео всё равно попадает в inbox.
- Ответ Лео встроенным ИИ (при наличии ключа) использует прежний контекст Хью с именем Лео; полноценного контекста Медиа-наставника во встроенном ответе нет.

## Проверки
`NODE_PATH=… node --test ops/content/*.test.js sites/synapse/cabinet/*.test.cjs`, `python3 tools/spec-kit/gate.py check`.
