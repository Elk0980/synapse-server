# Архив модулей — контракт #38

Кодовая реализация от 03.11.2026. Семь исходных модулей: `sites` (Сайты), `content-factory` (Контент-завод), `analytics`, `advertising`, `maps`, `crm`, `chat-hugh`. Назначение, ЦКП и кодовые источники хранятся в карточках; ответственные пока не назначены. Остальные модули добавляются последующей согласованной миграцией. Архив не запускает агентов и не предоставляет новых прав.

## Карта исходных данных

Основа проверки: main `ac4c7616`. Полная карта «модуль → базы/таблицы → кто пишет» опубликована комментарием 44 к задаче #38 перед реализацией. Это данные кода, а не инспекция production SQLite.

| Модуль | Базы и основные таблицы | Писатели |
|---|---|---|
| Сайты и прайсы | content.sqlite: documents, managed_sites, site_migrations; существующие sites/assets | content/server.js, site-store.js |
| CRM и задачи | crm.sqlite: leads, contacts, companies, tasks, task_coordination/history, task_comments, task_dispatch | crm/server.js, task-coordination.js, task-dispatch.js, autoposting-review-tasks.js |
| Контент и соцсети | crm.sqlite: content_factory_*, content_plan_*, autoposting_*, social_*; content.sqlite: telegram_source_* и actor_* | CRM inputs/workflow/jobs/autoposting/social-stats, content telegram-sources/actor-*; content runner вызывает API CRM |
| Аналитика | crm.sqlite: leads, expenses, external_stats, social_*, platform_demand_*; вычисляемые сводки | crm/server.js, social-stats.js, social-baselines.js, platform-demand.js |
| Реклама | Отдельный канонический рекламный реестр этим чтением не подтверждён | Не выдавать vk-direct.js за Яндекс Директ; данные источников пусты |
| Карты и отзывы | crm.sqlite: platform_demand_*, company_reviews/platforms/events | platform-demand.js, reviews.js |
| Чат и Хью | content.sqlite: project_chat_*, owner_private_*, client_dialog*, site_order_*; chat.sqlite: conversations/messages/client_tasks/client_task_comments/client_notifications/project_telegram_*; hugh-runtime.sqlite: reply_jobs/login_state/limit_state | content project-chat/site-orders/client-dialogs, chat server/bridges, hugh-runtime/job-store |
| Финансы и рассылки | crm.sqlite: finance_entries/audit, commercial_catalog, email_*, lead_email_outbox/recipients | commercial.js, email-campaigns.js, email-outbox.js |

Производственные `content.tasks`, `content.autoposting_posts` и `content.reviews` не найдены: совпадения в content tests — фикстуры. Реальные отдельные реестры задач: CRM/tasks, content/project_chat_tasks, chat/client_tasks. Мост task-dispatch-worker связывает лишь api-assistant-задачи; старые ручные записи автоматически не переносит. Старые `/t/...` и `/client-tasks` остаются достижимы. Общая страница архива не требует физического объединения четырёх БД. Предложения консолидации не реализованы.

## API

Все параметры strict: лишнее поле отклоняется. Доступ — существующий Owner и явные `companyCodes` подключения. Для новых архивов не добавляются системные проекты сверх выданного списка.

| Инструмент | Параметры | Результат |
|---|---|---|
| archive_list | module?, project?, session_id?, limit=50 (1–100), offset=0 (0–1000000) | modules, entries, pagination, usage, usage_pagination |
| archive_read | id, session_id? | entry |
| archive_write | module, project, type, text, session_id, client_ref; links?, task_id?, supersedes_id? | entry, created |

Типы: `tried` — пробовали; `succeeded` — получилось; `failed` — не получилось; `report` — отчёт; `decision` — решение; `next_step` — следующий шаг. Текст до 10000 символов, client_ref до 200. До 50 ссылок `{url,label,kind}`: только HTTPS без credentials; kind=`link/image/video/file`. Сервер не скачивает URL. Файлы уже находятся в разрешённом существующем хранилище; здесь сохраняется ссылка с сохранением его правил доступа. Загрузки файлов, base64 и частных документов в публичный Git нет.

`entry`: id, module, project, type, text, links, task_id, supersedes_id, agent `{id,name,kind}`, owner_id, created_at. Внутренние session_id/client_ref/request_hash записи наружу не возвращаются. Общий Owner-токен не доказывает личность отдельного процесса; авторство — учёт по явно переданной app-сессии, а не новая система аутентификации.

Запись требует открытую сессию того же владельца и точного набора проектов. Имя автора не принимается от клиента. Исправление — новый client_ref и supersedes_id в том же модуле/проекте. Задача должна быть действующей в том же проекте. Повтор client_ref с тем же нормализованным содержимым возвращает прежнюю запись; другое содержимое — 409. После неизвестного ответа сначала читать архив и повторять только тот же запрос с тем же ключом.

Чтение без session_id учитывается как Owner; с идентификатором — от имени проверенной открытой сессии. Успешный list/read/write и аудит атомарны: если аудит записать нельзя, результат операции не возвращается и новая запись не сохраняется. `usage` показывает действия за семь дней по доступным модулю/проекту/автору; чтение списка учитывается для каждой показанной пары модуль/проект. Это не доказательство запуска агента. Оба списка ограничены теми же limit/offset, с отдельными totals.

Существующий внутренний маршрут `POST /coordination/mcp/<name>` и прокси кабинета `/content/crm/coordination/mcp/<name>` используют тот же код. Проверки Owner/CSRF кабинета сохраняются. Экран «Архив» в #26 подключается отдельно, этот PR его не меняет. session_start возвращает `archives` с карточками и `{tool:{name:'archive_list',arguments:{module}}}` по теме запроса. Не выдаётся вымышленная ссылка на ещё не реализованный экран. Проверка MAP остаётся перед созданием/возобновлением сессии.

## Миграция и выпуск

Таблицы: `module_archive_modules`, `module_archive_entries`, `module_archive_access`, `module_archive_migrations`; именованная версия `module-archive-v1`. Общая нумерация schema_migrations, CRM server.js, auth и страницы не меняются. Запросы API не запускают DDL. Без отдельной установки archive_* даёт 503, session hints пусты, прежние task_* работают.

Только при отдельно разрешённом выпуске оператор готовит кандидат CRM с новыми файлами, проверяет компанию/окружение/владельца ресурса и **останавливает CRM и все остальные писатели этой БД**. База и резервная копия остаются на существующем приватном томе; копию не скачивают в Git. Текущий каталог, образ, точные пути, backup/rollback и возобновление сервиса проверяются по процедуре выпуска; следующая команда сама их не устанавливает.

Пример offline-команды внутри подготовленного CRM-окружения с существующей `/data/crm.sqlite` и свободным новым абсолютным путём копии:

```sh
node module-archive-migrate.js --database /data/crm.sqlite --backup /data/crm-before-module-archive-RUN_ID.sqlite --offline-confirmation CRM_STOPPED
```

`RUN_ID` оператор заменяет идентификатором конкретной попытки. Флаг CRM_STOPPED — явное подтверждение оператором внешней остановки, а не датчик состояния контейнеров. BEGIN EXCLUSIVE в WAL не доказывает отсутствие простаивающего писателя; мигратор не управляет контейнерами.

Инструмент открывает только существующий обычный SQLite-файл, отказывает при symlink/неправильном пути. Новый путь копии резервируется без перезаписи, VACUUM INTO сохраняет согласованные данные включая WAL. Проверяются integrity/FK, SHA-256 и совпадение прежних схем/типизированных строк/последовательностей, включая hidden rowid. Если все имена rowid заняты настоящими колонками и нет доказанного INTEGER PRIMARY KEY alias, сравнение отказывает с явной причиной. Затем своя исключительная транзакция и повторная сверка backup; изменение исходной БД после копии отменяет установку до DDL. После DDL проверяется сохранность всех прежних данных и объектов; ошибка откатывает транзакцию, backup сохраняется. При частичной/неожиданной архивной схеме автоматического «ремонта» нет.

Точный повтор уже завершённой миграции возвращает `installed:false`, не перезаписывая копию. При сбое сначала проверить реальное состояние, marker, целостность и оставшийся backup; не повторять неизвестную установку вслепую. При откате приложения добавленные таблицы можно сохранить для совместимости со старым кодом. Не восстанавливать старую БД поверх новых бизнес-записей и не удалять архивные записи; отдельное восстановление — решение оператора с актуальной копией.

SQL-триггеры запрещают UPDATE/DELETE и замену прежних rows через REPLACE в архивных таблицах. Карточки исходных модулей также неизменяемы; будущие изменения карточек требуют отдельной версии миграции.

## Проверка

Node 24, временные синтетические SQLite и тестовая MAP; существующие зависимости ops/tasks-mcp/package-lock.json. Наборы archive-crm, archive-migration и archive-integration проверяют собственные и чужие сессии/проекты, retries, append-only, audit rollback, WAL/backup/preservation и настоящую цепочку MCP → CRM. Общий tasks-mcp suite проверяет старые задачи, подзадачи, комментарии, стадии, черновики и восстановление прежнего UI без его изменения. Linux workflow module-archive выполняет новые тесты с прежними MCP/task-coordination.

Итоговые числа и ограничения — specs/094-module-archive/evidence.md. Производственная миграция, заполнение из AI_HANDOFF/чатов, UI на390px и приёмка Claude в рамках этого кодового PR не выполнялись.
