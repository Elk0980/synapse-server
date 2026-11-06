# Задачи 142-rules-enforcement

- [x] T1 Модуль `ops/crm/task-rules.js`: якорь, доказательство «проверено», поля постановки, журнал, сводка.
- [x] T2 Сторож: создать `rules` в том же режиме, раздел в `snapshot`/`digest`, многоссылочное evidence для `verified`.
- [x] T3 Координация: проверки до сторожа в `toolAsync`, в `save`, `selfStatus`, `task_create`, `session_start` → `rules.seen`; поле `rules_anchor`.
- [x] T4 tasks-mcp: передача `rules_revision`/`rules_version` в CRM; строка правил в `SESSION_RULES`.
- [x] T5 Тесты: `task-rules.test.js`, `rules-http.test.js`; обновить `task-watchdog.test.js`, `watchdog-http.test.js`, `map-integration.test.js`.
- [x] T6 Spec Kit + PR «Spec: specs/142-rules-enforcement», отчёт в №142, запрос ревьюера в №25.
