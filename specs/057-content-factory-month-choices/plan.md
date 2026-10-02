# План CF7

1. content-factory-inputs.js: расширить JSON месяца и vocabulary существующими FORMATS/ROLES; нормализовать списки, сохранять порядок, не менять БД и revision/company guards.
2. content-plan-service.js: сохранить копию month.inputs в снимке; выявить несовместимость Shorts/formats до проверки готовности исполнителя и enqueue с вопросом needs_input.
3. content-plan-worker.js: передавать ограничения в prompt и проверять каждый результат по снимку. Отсутствующие поля означают пустые списки.
4. Проверить только соответствующие inputs/service/worker тесты на memory SQLite и синтетическом исполнителе; связанные jobs/drafts тесты допустимы только для проверки совместимости, без изменения файлов.
5. Провести Spec Kit converge по FR-001–005; зафиксировать реальный результат, ограничения, SHA и контракт передачи. Интеграция принадлежит координатору.

Разрешённые файлы: ops/crm/content-factory-inputs.js, content-factory-inputs.test.js, content-plan-service.js, content-plan-service.test.js, content-plan-worker.js, content-plan-worker.test.js; specs/057-content-factory-month-choices/{spec,plan,tasks,evidence}.md. UI принадлежит Claude; QA и общие файлы не менять.

Миграция SQL не нужна: существующее версионированное JSON-хранилище месяца и неизменяемый JSON снимка задания. Новых прав и API-маршрутов нет.
