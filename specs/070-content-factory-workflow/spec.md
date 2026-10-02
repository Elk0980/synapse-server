# CF21 — настройки выпуска контент-завода

Процесс Spec Kit 1.0.0. Ограниченный модуль хранения настроек; режим сам не исполняет публикации.

## Сценарии

1. Владелец читает ещё не настроенную компанию: manual, configured=false, revision=0; чтение не создаёт настройки.
2. Владелец явно сохраняет manual, в том числе все значения по умолчанию: configured=true, revision=1. Следующий одинаковый нормализованный patch с актуальной версией — noop.
3. Владелец сохраняет имя ответственного, желаемые часы и сроки подготовки/согласования. Partial сохраняет другие поля; пустое имя и [] сбрасывают значения. Имя не утверждает наличие учётной записи или права пользователя.
4. Старая версия, чужая/удалённая компания и некорректные поля не меняют настройки. Сбой между записью версии и текущего указателя не оставляет частичной истории.

## Требования

- FR-001. createContentFactoryWorkflow(db,{now?}) предоставляет get(code) и save(code,{revision,fields:partial},actor). DTO ровно {companyCode,revision,configured,fields:{releaseMode,publisherName,hours,preparationDays,reviewDays},approverRole:'owner'}. Код компании нормализован в lowercase существующим company lookup; удалённая компания не доступна.
- FR-002. Default fields: releaseMode='manual', publisherName='', hours=[], preparationDays=0, reviewDays=0. GET не записывает company-specific строки. Первое явное сохранение default создаёт configured=true/revision1; configured означает наличие сохранённого решения, не готовность отправителя.
- FR-003. Строгие body/fields; partial непустой. releaseMode только exact manual|scheduled. publisherName — строка до 200 символов, trim, пустая допустима. hours — массив до 24 уникальных exact HH:MM (00:00–23:59), сортируется, [] сбрасывает. Сроки — целые 0..30 без coercion. Неизвестные поля/неверные типы — 400.
- FR-004. revision — безопасное неотрицательное целое. Stale revision — 409/REVISION_CONFLICT, включая одинаковый patch. Нормализованный noop после первого сохранения не меняет revision/историю/время/актора. Изменение создаёт одну следующую версию.
- FR-005. SQLite хранит company_id FK, immutable полные версии с UTC created_at и доверенным actor userId/userName; current указатель и версия записываются одной BEGIN IMMEDIATE транзакцией. Ошибка откатывает обе записи. Повторное создание фабрики не перезаписывает данные.
- FR-006. DTO и переданный hours не дают изменять сохранённые настройки по ссылке. Компании изолированы. approverRole всегда owner; поля не создают роли/права/учётные записи.
- FR-007. Только отдельные таблицы workflow. Не изменять posts/jobs/tasks/inputs/autoposting/server. Часы и сроки — пожелания для будущего плана; scheduled не создаёт расписание, задачу, отправку, таймер или уведомление. HTTP/snapshot/UI/runtime guard подключает root отдельным пакетом.

## Приёмка

- SC-001. Синтетическая SQLite подтверждает defaults без company writes, first-save и последующий normalized noop.
- SC-002. Проверены partial/reset, строгая валидация, revision409 и company isolation/deletion.
- SC-003. Проверены сохранённый actor, immutable history, повторная инициализация и rollback реального SQLite trigger failure.
- SC-004. Sentinel posts/jobs/tasks с запрещающими записи triggers сохраняются неизменными.
- SC-005. Изменены только два новых JS/test файла и четыре документа 070; нет сети/live/публикации/изменения прав.

## Область

Source CONTENT_FACTORY_CF2_CODEX_20261001: только ops/crm/content-factory-workflow.js, .test.js и specs/070-content-factory-workflow/{spec,plan,tasks,evidence}.md. Все существующие файлы и QA/state/manifest — readonly. Без агентов, сервисов, секретов, production, commit/push/deploy и клиентских сообщений.
