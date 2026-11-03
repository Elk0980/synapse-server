# Свидетельства проверки

03.11.2026, Asia/Bangkok. Основа ac4c7616. До начала реализации выполнена только кодовая инвентаризация; результат опубликован комментарием 44 задачи #38. Базы production не читались и не менялись.

Личная проверка координатора (Windows):

| Проверка | Результат |
|---|---|
| `node --test --test-concurrency=2 ops/tasks-mcp/*.test.js ops/crm/task-coordination.test.js ops/crm/task-dispatch.test.js ops/crm/task-dispatch-http.test.js ops/crm/eva-task-reader.test.js` до добавления отдельного portable-теста | 124 сценария: 122 PASS, 2 SKIP, 0 FAIL; tests-final-r3.log вне Git |
| Новый `node --test ops/tasks-mcp/archive-portable.test.js` после общего прогона, без изменения продуктового кода | 1 PASS, 0 SKIP/FAIL; Python SQLite 3.50.4 открыла установленную схему, выполнила backup и отклонила UPDATE/DELETE/REPLACE |
| Spec Kit `gate.py check`, пять отрицательных сценариев Python | PASS, проверено 48 файлов комплекта; 5/5 PASS |
| Полный diff/границы | `git diff --check` PASS; `ops/content`, `sites/synapse`, CRM server.js и docker-compose.yml совпадают с базой |

Всего различных лично выполненных финальных сценариев: 123 PASS, 2 Windows SKIP, 0 FAIL. Пропуски: создание file symlink недоступно пользователю Windows и Linux-only UNIX-socket сценарий Eva. Linux workflow module-archive добавлен для запуска новых и прежних MCP/task-coordination тестов; его фактический статус проверяется отдельно после PR, локальным запуском не подменяется.

Окружение: Node 24.18.1 / SQLite 3.53.1; Python 3.14.6 / SQLite 3.50.4. Python/SQLite3.45.1 для нового архива здесь не запускалась. Все данные — синтетические, во временных файлах; реальные таблицы/клиенты в Git не попадали.

Покрытие: четырнадцать API-сценариев, восемнадцать migration-сценариев, два настоящих MCP→CRM сценария и переносимость. Проверены старые ID/схема/типизированные строки/FK/sequence/hidden rowid, WAL backup/reopen, повтор CLI без перезаписи backup, занятый writer, недостоверная/устаревшая копия, fault rollback, immutable raw SQL, session/project scopes, author capability, idempotency, аудит и ограниченная сводка за7дней. Прежние задачи/стадии/подзадачи/комментарии/UI-черновики/восстановление проходят без изменения страницы доски.

Независимый read-only review помог выявить недостающую проверку hidden rowid в preservation snapshot. Она добавлена и закрыта негативными тестами (rowid-only stale backup до DDL и fault rollback). Предположение, что текущий VACUUM INTO портит rowid, лично не подтвердилось; метод backup не заменяли по недоказанной причине. Консервативный guard отказывает, если hidden rowid недоступен через все alias и нет доказанного INTEGER PRIMARY KEY. Первый незавершённый общий прогон выявил ошибки тестового стенда (обязательный file backup и plain-text validation error SDK); они исправлены до финальных прогонов, его результаты в PASS не включены.

Spec Kit converge: FR1 закрыт комментарием44; FR2/3 — схема/миграция; FR4–7 — API/негативные/аудитные тесты; FR8 — действующая MAP-first цепочка и migration503; FR9 — strict links и отсутствие загрузки bytes; FR10 — общий регрессионный набор и отдельный portable сценарий. Code/локально проверено; production/connected/accepted не подтверждены.

Не выполнены: merge/deploy, миграция реальной crm.sqlite, наполнение личными данными, UI/телефон и приёмка Claude. session_start текущего установленного коннектора даёт известный 503 «Карта не установлена» без session_id; это не обходится архивом и не маскируется под успешную сессию.
