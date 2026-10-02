# Свидетельства CF27

Процесс 1.0.0. До production/test-правок прочитаны общие AGENT-ECONOMY.md и местные AGENTS.md, docs/spec-kit-policy.md, .specify/memory/constitution.md; созданы spec/plan/tasks. Точное существующее имя теста `ops/crm/social-stats-tags.test.js` согласовано root.

## Реальные собственные проверки

Среда: Node v24.18.1, Python 3.14.6, Windows; только синтетические SQLite in-memory БД и подменённые adapters/transport. Рабочий каталог: `C:/Users/Vlad/Documents/Codex/AI_HANDOFF/SYNAPSE_BUSINESS/CONTENT_FACTORY_CF2_CODEX_20261001`.

1. До изменения `social-stats.js` выполнена команда `node --test --test-name-pattern="CF27: после receipt" ops/crm/social-stats-tags.test.js`: exit 1, 1 тест, 0 pass / 1 fail. Настоящие `createAutoposting`, `recordReceipt`, `update` подтвердили рост contentRevision и stale квитанцию; статистика ошибочно вернула `[1,"reel","sale"]` вместо `[1,null,null]`. Изначальные `post/reach` до правки были подтверждены тем же тестом.
2. Первый полный целевой прогон после fix: 59/60. Некорректная SQLite INTEGER-версия `9007199254740992` выявила RangeError драйвера при SELECT. Добавлен SQL CASE: только typeof integer и диапазон 1..9007199254740991; прочее NULL. Это не миграция/запись/приведение значения к версии по умолчанию.
3. Итоговая команда `node --test ops/crm/social-stats-tags.test.js ops/crm/social-stats.test.js`: exit 0, **60/60**, fail/cancelled/skipped 0. Из них suite меток 10/10 (5 прежних + 5 CF27), основной suite 50/50. Публикация запрещена synthetic transport; никаких live API.
4. `python tools/spec-kit/gate.py check`: exit 0, status ok, verifiedFiles 48.
5. `python -B .specify/scripts/python/check_prerequisites.py --json --require-spec --require-tasks --include-tasks` при process-local `SPECIFY_FEATURE_DIRECTORY=specs/077-content-factory-published-stat-tags`, `SPECIFY_FEATURE_NO_PERSIST=1`: exit 0, FEATURE_DIR точно 077, AVAILABLE_DOCS tasks.md. Переменные восстановлены; общий feature state не записывался. Extension hooks отсутствуют.
6. `git diff --check -- ops/crm/social-stats.js ops/crm/social-stats-tags.test.js specs/077-content-factory-published-stat-tags`: без whitespace ошибок. Поскольку тест071 и документы ещё untracked относительно Git, тест отдельно проверен `git -c core.autocrlf=false diff --no-index --check -- <immutable-CF23>/ops/crm/social-stats-tags.test.js ops/crm/social-stats-tags.test.js`: пустой вывод, exit 1 означает наличие ожидаемого diff.

## Результат и контракт

- FR-001/002: receipt version и current card version читаются из существующих колонок; смешанные/неизвестные/неравные версии одного выхода дают `[null,null]`. Два равных подтверждения одной текущей версии сохраняют метки.
- FR-003: whitelist прежний; известные поля проверяются независимо только после доказанной версии. Private meta, contentRevision и internal publishedVersions в публичный DTO не попадают.
- FR-004: проверены чужой owner receipt, несуществующая карточка999, совпавший числовой platformPostId, внешние/подделанные contentId, конфликт адреса, 201 receipts, отсутствие таблиц/meta/любой колонки версии, null/zero/negative/text/fraction/unsafe revision.
- FR-005: старый и новый выход одной карточки проверяются отдельно, включая stored_with_receipt; публичные receipts и связь с обращениями не меняются. total_changes до/после чтения одинаков. Batch SELECT meta остаётся один; записи и API вызовы не добавлены.

Converge: просмотрены 5 FR, 3 SC, 5 задач, 5 шагов плана и принципы I–V конституции в пределах пакета. Невыполненных требований не найдено; дополнительные задачи не добавлены. Это собственная проверка исполнителя, **не независимая приёмка root**. QA/production/live/UI не проверены и не изменены; интеграция остаётся root.

## Diff и SHA

Diff именно CF27 сверён с readonly `CONTENT_FACTORY_CF23_BACKEND_REVIEW_20261001` (Git diff дополнительно содержит прежние изменения071): `social-stats.js` +15/-5 строк, `social-stats-tags.test.js` +92/-7. Production diff: две безопасные версии SELECT, внутренний Set версий выхода, сравнение при выдаче обеих меток. Тест diff: version-aware fixture и пять регрессий. Остальные изменённые этим исполнителем файлы — четыре документа077.

- `ops/crm/social-stats.js`: `B51CA292220899455776A9DCD82FFC9FC3E92AE4B1BAF6E35835AA3ADCD543D6`
- `ops/crm/social-stats-tags.test.js`: `46D58A57CADCD4806B5EF5AC6FBADF2205C850A7DCC12BC566FC60F480B8B52E`

Окончательные SHA всех шести файлов передаются root после последней записи этого документа. После этого запись остановлена. Независимая приёмка и дальнейшая интеграция не заявляются исполненными.
