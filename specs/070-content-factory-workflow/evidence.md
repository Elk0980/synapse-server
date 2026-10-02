# Свидетельства CF21

Дата: 2026-10-01. Процесс Spec Kit 1.0.0. Выполнил агент Codex CF21; только source-пакет, синтетическая локальная SQLite. Контракт согласован root до записи. Это не проверка production и не доказательство подключения HTTP/UI/runtime.

## Реальные проверки

- node --test ops/crm/content-factory-workflow.test.js: exit 0, 8/8 passed, fail/cancelled/skipped/todo 0, duration 159.8662 ms. Один прогон только нового теста.
- check_prerequisites.py --json --require-tasks --include-tasks: exit 0, FEATURE_DIR=specs/070-content-factory-workflow. После реализации --require-spec --require-tasks --include-tasks также exit 0. Использованы python -B, SPECIFY_FEATURE_DIRECTORY и SPECIFY_FEATURE_NO_PERSIST=1; feature-state/bytecode не записывались.
- python -B tools/spec-kit/gate.py check: exit 0, status=ok, verifiedFiles=48. Это проверка файлов процесса, не доступности моделей/провайдеров.
- Локальные speckit-implement/converge прочитаны; extensions.yml отсутствует, hooks отсутствуют. Existing .gitignore прочитан, не менялся по readonly границе.

## Покрытие требований

| Область | Проверенное поведение |
| --- | --- |
| FR-001/FR-002 | DTO defaults без company rows; first explicit manual/default -> configured=true/revision1; approverRole=owner |
| FR-003/FR-004 | partial/reset/trim/sorted unique hours, 24/00:00/23:59/0..30 boundaries; invalid types/unknown fields ->400; normalized noop без revision/history/time/actor writes; stale identical payload ->409 |
| FR-005 | Full immutable snapshots, trusted actor, fixed UTC clock; UPDATE/DELETE history rejected; re-init сохраняет данные; SQLite trigger failure при INSERT и UPDATE current pointer откатывает новую version; следующий save после rollback успешен |
| FR-006 | Uppercase company lookup, Alpha/Beta isolation, unknown/deleted company unavailable; input/result arrays не меняют сохранённое состояние по ссылке |
| FR-007 | Sentinel autoposting_posts/content_plan_jobs/tasks с INSERT/UPDATE/DELETE tripwire triggers остаются неизменными; нет scheduling/dispatch/tasks/rights code |

## Scoped converge

Сверены 7 FR, 5 SC, 4 сценария, решения плана и 6 принципов конституции. В выделенной области missing/partial/contradicts/unrequested findings: 0. Converged: реализация соответствует spec/plan/tasks этого storage-пакета. Converge не добавлял пустую фазу в tasks.

## Контракт передачи

Фабрика export createContentFactoryWorkflow(db,{now=Date.now}); методы get(code), save(code,{revision,fields:partial},actor). Две новые таблицы: content_factory_workflows (current pointer) и content_factory_workflow_versions (immutable история полных снимков). DTO содержит только companyCode/revision/configured/fields/approverRole. Default manual не материализуется до явного save. configured=true не означает готовность отправки. История сохраняется полностью в versions; дополнительный HTTP метод истории в этом пакете не создаётся.

publisherName — указанное пользователем имя, без подтверждения учётной записи; approverRole всегда owner. hours — до24 уникальных local HH:MM пожеланий без даты, сортировка; preparationDays/reviewDays — 0..30 пожеланий к будущему плану, не due_date существующей задачи. Записанный scheduled не отправляет материалы и не создаёт расписание. Actor присваивает доверенный HTTP слой, не клиентский body.

## Открытая интеграция и границы

Root подключает guarded GET/PUT (auth/company scope/CSRF), settings/snapshot и runtime schedule guard отдельно. Эти существующие файлы, inputs/autoposting/server/UI/QA/state/manifest мной не менялись. Новая фабрика сама не авторизует HTTP пользователя. Production, live API, worker, таймеры, Telegram/клиенты, секреты, сеть, commit/push/deploy не использовались. После итоговых SHA запись остановлена; шесть SHA переданы root отдельно, чтобы не создавать самоссылочную сумму evidence.
