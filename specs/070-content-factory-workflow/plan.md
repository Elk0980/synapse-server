# План CF21

Процесс Spec Kit 1.0.0. Единственный автор новых файлов — агент CF21; контракт согласован root до записи.

## Стек и контракты

CommonJS JavaScript, существующая синхронная SQLite (node:sqlite в тесте). Переиспользовать company/fail/object/text/revision из company-information.js; existing файл только читать. Actor приходит от доверенного вызывающего HTTP слоя; фабрика не предоставляет самостоятельную аутентификацию и не назначает права.

get/save возвращают DTO FR-001. Defaults не материализуются при GET. Первый явный default/manual save отличается от noop: появление current строки означает configured=true. Проверять revision до сравнения нормализованных полей; partial сливается с текущим состоянием. Детерминированная сортировка часов не создаёт версию при перестановке.

## Хранение

Новые content_factory_workflow_versions: company_id/revision PK, полный JSON fields, created_at, actor_id/actor_name; immutable UPDATE/DELETE triggers. Новые content_factory_workflows: company_id PK, revision и составной FK на immutable version. Текущий DTO читает pointer JOIN version. Один BEGIN IMMEDIATE включает lookup активной компании, проверку revision, вставку snapshot и смену pointer. CREATE TABLE/TRIGGER IF NOT EXISTS при фабрике — добавочная миграция без переписывания existing данных.

## Проверки

Только новый node --test ops/crm/content-factory-workflow.test.js. Синтетическая :memory: БД, фиксированные часы; defaults/first save/noop, partial/reset/limits, stale revision, isolation/deletion, persisted actor, immutable snapshot, re-init, rollback trigger failure, sentinel posts/jobs/tasks. Spec Kit prerequisites и gate выполняются с отключённой записью Python bytecode и feature persistence; converge по FR/SC в пределах этого пакета.

## Границы интеграции

Не редактировать существующие inputs/autoposting/server/UI. Root подключит guarded GET/PUT, настройку/snapshot и schedule guard отдельно. Здесь scheduled только сохранённый выбор; manual не меняет уже созданные карточки. Настройки часов/сроков не являются назначенным сроком задачи. Не обещать исполнение, доступ аккаунта или доставку.
