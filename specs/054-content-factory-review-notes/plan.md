# План
Codex единственный автор ops/crm/autoposting-review-notes.js и теста, интеграции в autoposting.js; specs/054. Claude владеет sites/specs053, их не менять.
Добавить отдельную таблицу замечаний с FK post/company, снимком версии/медиа и JSON списка. Создание таблицы рядом с существующей схемой autoposting, без изменения старых строк. Нормализация до побочных эффектов; INSERT в существующей транзакции reject. DTO отдаёт reviewNotes; HTTP reject уже использует права согласования и CSRF. Локальные SQLite-тесты и регрессия autoposting; HTTP-проверка отдельно до подключения UI.
Доверенной длительности у текущего DTO нет: durationVerified=false. Сервер принимает время как указанное пользователем, не обещает проверку границ файла.

Интеграция tasks: Codex ops/crm/autoposting-review-tasks.js и server.js. Таблица связей review-task, штатная tasks без изменения прав/статусов/dispatch. В createAutoposting dependency reviewTasks; обязательна в реальном server.js, локальные минимальные fixtures могут быть без задачника.
