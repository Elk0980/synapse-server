# План

1. `ops/crm/autoposting.js`
   - Колонки `deleted_at`, `deleted_by`, `deleted_by_name`, `deleted_comment` (существующий механизм `ALTER TABLE ADD COLUMN`); таблица `autoposting_post_trash_events`; индекс `(company_id,deleted_at)`.
   - `rowFor(id,code,{deleted})` — по умолчанию только не удалённые.
   - Фильтр `deleted_at IS NULL`: `list`, `invalidate`, `calendarPlan`, `reviewReminderSummary`, `calendar` (доставки, расписки, индекс), `reorder`, выборка и захват `processDue`.
   - Импорт: причина `deleted` у пропуска.
   - Новые `remove`, `restore`, `trash`; `dto.deleted`.
2. `ops/crm/server.js` — маршруты `delete`, `restore` (POST) и `GET /autoposting/trash` внутри существующего блока автопостинга; права и компания — существующий `companyModuleContext`. Мост `ops/content` пересылает их общим правилом (`autoposting.edit` для записи), правок не требует.
3. `sites/synapse/cabinet/autoposting.js` — кнопка удаления с подтверждением вторым нажатием, раздел «Корзина», восстановление, обновление календаря.
4. Тесты SC-001–SC-003; мутации; полные прогоны.

Схема меняется только добавлением колонок и таблицы. Физического удаления строк и файлов нет. `cabinet.html` и версия ресурсов не меняются: `/cabinet/*` отдаётся с `Cache-Control: no-cache, must-revalidate`.
