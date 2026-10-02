# План Eva

Опорный публичный коммит: 08984a2e1bce85f914fa840ed2e194cc74fe31d6. Процесс Spec Kit 1.0.0.
Один автор на файл, отдельный workspace; production и чужая Palitra worktree не затрагиваются.

1. `ops/eva-tasks/task-source.js`: node:sqlite readOnly + query_only, минимальная проекция tasks,
   companies, task_coordination, task_dispatch. Никаких CRM API ключей или поддельной owner identity.
2. `ops/eva-tasks/bot.js`: чистая owner-only логика, пагинация, непрозрачные callback, текущие данные.
3. `ops/eva-tasks/runtime.js`: Telegram long polling, allowlist методов, redacted ошибки, атомарный
   транспортный курсор и один процесс; никакого webhook/HTTP listener/LLM.
4. Отдельный opt-in compose: существующий `crm_data` монтируется только для чтения; токен и
   конфигурация вне git; отдельный volume хранит только cursor/lock. Корневой compose не меняется.
5. Личный ввод токена в серверной консоли через getpass; без веб-формы и новых публичных маршрутов.
6. Приватный пакет контекста готовится рядом с checkout, вне git/sites; не копирует внутренние
   инструкции, личную память и чаты. Это подготовленное обновление существующего AI_HANDOFF.

Минимум операций задач v1 — чтение. Добавление/смена статуса сейчас создали бы второй вход записи,
требующий полного подключения к существующей авторизации, revision и приёмке. Они не нужны для
первого проверяемого результата, остаются в кабинете.

Проверки: node --test ops/eva-tasks/*.test.js, python unittest setup helpers, статический аудит
новых файлов на секреты/публичные маршруты, сверка spec ↔ tests. Docker/Telegram live — только
после согласованного подключения. Снимки документов не доказывают текущую серверную активность.

Распределение: task_model — adapter; eva_ui — bot; eva_runtime — runtime; root — setup/docs/spec.

Дополнение поручения: task_model вносит узкую правку scope-дедупликации в ops/crm/server.js,
сохраняет baseline воспроизведения и regression tests. Никаких миграций или исправления рабочих данных.
