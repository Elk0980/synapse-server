# План и владельцы

Spec Kit1.0.0, база ac4c7616, отдельный worktree. Координатор Codex — Доска в ЛК; backend агент пишет только ops/crm, UI агент только task-board.js/css/test, координатор интегрирует tasks.js/cabinet.html/PWA и выполняет проверку. Это распределение файлов, не серверный lease.

Использовать существующий ctx.crmQuery с CSRF и POST /coordination/mcp/{tool}, прежние tasks/task_coordination. Добавить products_list/task_duplicates в CRM tool dispatcher; не расширять внешнюю MCP-схему в этой задаче. tasks_list/task_get обогащаются product/chat полями, task_update — product/parent/priority/chat. Совместимость прежних вызовов обязательна.

Перед миграцией10 file-backed SQLite создать консистентную физическую резервную копию, проверить целостность, затем атомарно добавить схему и перенос. Прежние продукты сохраняются с mapping/флагом; не удалять комментарии или историю. При сбое не повышать версию, не запускать HTTP с частичной схемой. На сервере ничего не выполнять.

Новое отображение подключить во все owner #tasks-маршруты, старый client renderer сохранить. Отдельный board.html ведёт в существующий кабинет, board.webmanifest стартует задачи. Статические ресурсы получают новую версию. Публичный board.synapsebusiness.ru пока остаётся прежним серверным redirect: изменение маршрутизации не входит в этот PR.

Проверки: Node24 API/migration/портативность, JSDOM UI и маршруты, существующие tasks-mcp/coordination/client suites, синтаксис, Spec Kit, diff/секреты, независимое ревью. CUA отключён согласно актуальной памятке; браузер/скриншоты и iPhone вручную не обходить. Подготовить точный чек приёмки Claude в PR.
