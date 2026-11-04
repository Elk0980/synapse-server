# Свидетельства

## PR (а) — сервер (04.11.2026, Бангкок)
- `node --test ops/crm/reel-materials.test.js` — 6 тестов, pass 6, fail 0 (EDL, фильтры, изоляция компаний, правка → задача → claim → v2, публикация, HTTP-права).
- `node --test ops/crm/reel-materials-http.test.js` — 1 тест на настоящем `server.js`, pass 1: ролик SMM → EDL → служебный queue/claim/versions → задача «Монтаж: …» на доске → черновик автопостинга v2 без даты; чужая компания 403/404; служебный API с личностью 403.
- Регрессия: `autoposting-trash-http.test.js`, `content-factory-source-http.test.js` — pass 9, fail 0.

## Исправления по независимому ревью №98 (05.11.2026, Бангкок)
### PR 501 — хост ролика
- `mediaUrl()` сравнивает origin с разрешённым списком (`PUBLISHING_ASSET_ORIGINS`, по умолчанию `https://synapse.synapsebusiness.ru` = `PUBLISHING_ASSET_ORIGIN` content); относительный путь `/content/publishing-assets/<code>/…` дополняется этим origin.
- `node --test ops/crm/reel-materials.test.js` — 7/7: `https://evil.example`, `…synapsebusiness.ru.evil.example`, порт `:8443`, `https://127.0.0.1`, `//evil.example/…` → 400 `MEDIA_HOST`; относительный путь принят; агент монтажа с чужим хостом → 400; свой список origin работает, `http://` в конфиге отклоняется; рилс плана с видео на чужом хосте скрыт.
- `node --test ops/crm/reel-materials-http.test.js` (настоящий CRM) — 1/1: чужой хост из кабинета 400, `/internal/…/versions` с чужим хостом 400, `/internal/reel-materials/hugh-log` с личностью 403, ключом сервиса — записи `user`,`hugh`.
### PR 501 — журнал в личный чат с Хью
- Где пишет 504: `ops/content/team-chat.js` (ветка `claude/night98-chats-tasks`) — таблица `team_chat_messages` content, колонки `room`/`kind`/`audience_id`, комната `hugh:<id>`, сообщения Хью — `user_id=0` + `audience_id`. «Материалы» пишут туда же (`ops/content/reel-materials-chat.js`): запрос — от пользователя (`kind='reel-edit'`), «Исправлено/отменена» — от «Хью · ИИ» (`kind='reel-edit-result'`), `client_id=reel-edit:<id>:request|done|cancelled` → без дублей.
- Подключение в `ops/content/server.js` — 3 точечные строки: создание модуля; после ответа proxy CRM на `/autoposting/reels…` (запись правки — сразу, чтения — не чаще 15 с); перед `peopleService.handle` для `GET /content/people/team-chat?room=hugh:<свой id>`. Ошибка CRM не роняет запрос (тайм-аут 1,5 с, предупреждение в журнал).
- Без PR 504 (на main нет колонки `room`) модуль возвращает `NO_ROOMS`, CRM не вызывает, ничего не пишет; журнал остаётся в карточке ролика (`reel.log`) и в редакторе.
- `node --test ops/content/reel-materials-chat.test.js` — 3/3 (комната hugh:7, повтор без дублей, общий чат пуст; без комнат — пропуск; чужая комната/компания/ответ CRM отклоняются, интервал 15 с).
- Сверка с кодом 504: `team-chat.js` из `origin/claude/night98-chats-tasks` + этот модуль (скрипт в scratchpad): `list(7,'hugh:7')` → 2 записи (Лена; Хью · ИИ «Исправлено: … готова v2»), `common` → 0, Таня читает `hugh:7` → 403.
- Регрессия content (настоящий server.js): autoposting-receipts-proxy, people-http, crm-permissions, content-factory-sources-proxy, media-mentor-proxy, chat-proxy, team-chat* — 39/39. CRM: autoposting-trash-http, content-factory-source-http, reel-materials* — 17/17.
