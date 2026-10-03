# План Eva

Опорный публичный коммит: 08984a2e1bce85f914fa840ed2e194cc74fe31d6. Процесс Spec Kit 1.0.0.
Один автор на файл, отдельный workspace; production и чужая Palitra worktree не затрагиваются.

1. `ops/crm/eva-task-reader.js`: опциональный UNIX socket внутри CRM, SELECT фиксированных полей
   tasks/companies/task_coordination/task_dispatch, обязательный server-side scope проектов.
   `ops/eva-tasks/socket-source.js` читает и проверяет ответ. Никаких CRM API ключей, DB mount
   или поддельной owner identity. Старый DB adapter — только fixture/reference, в image Eva не попадает.
2. `ops/eva-tasks/bot.js`: чистая owner-only логика, пагинация, непрозрачные callback, текущие данные.
3. `ops/eva-tasks/runtime.js`: Telegram long polling, allowlist методов, redacted ошибки, атомарный
   транспортный курсор и один процесс; никакого webhook/HTTP listener/LLM.
4. Отдельный opt-in compose: Eva видит только отдельный socket volume, токен и cursor/lock.
   Dormant override добавляет socket существующему CRM после согласования; корневой compose не меняется.
5. Личный ввод токена в серверной консоли через getpass; без веб-формы и новых публичных маршрутов.
6. Приватный пакет контекста готовится рядом с checkout, вне git/sites; не копирует внутренние
   инструкции, личную память и чаты. Это подготовленное обновление существующего AI_HANDOFF.
7. Дополнение 03.10: setup --pair с заранее указанными bot username/timezone/socket volume.
   Новый pairing.py — короткий интерактивный bootstrap на Python stdlib; token только в памяти
   до обратного подтверждения из личного Telegram в доверенной TTY. Не импортирует task reader,
   не создаёт transport-state и не включается в Docker image. Имеющиеся private-file helpers
   записывают token/env исключительно после подтверждения; flock каталога исключает второй setup.
   Привязка — доказательство контроля личной TTY и выбранного Telegram, не внешняя проверка
   личности по username. Требуются остановленные другие poller этого выделенного бота.
   Root владеет setup/pairing/spec/docs; eva_review — pairing_test.py и независимый review.

Минимум операций задач v1 — чтение. Добавление/смена статуса сейчас создали бы второй вход записи,
требующий полного подключения к существующей авторизации, revision и приёмке. Они не нужны для
первого проверяемого результата, остаются в кабинете.

Проверки: node --test ops/eva-tasks/*.test.js ops/crm/eva-task-reader.test.js, python unittest setup helpers, статический аудит
новых файлов на секреты/публичные маршруты, сверка spec ↔ tests. Docker/Telegram live — только
после согласованного подключения. Снимки документов не доказывают текущую серверную активность.

Распределение: eva_review — CRM socket; eva_ui — bot; eva_runtime — socket client/runtime;
eva_setup — setup/compose; root — docs/spec/итоговая проверка. Один автор на файл.

Дополнение поручения: task_model вносит узкую правку scope-дедупликации в ops/crm/server.js,
сохраняет baseline воспроизведения и regression tests. Никаких миграций или исправления рабочих данных.
