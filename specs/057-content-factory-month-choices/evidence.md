# Свидетельства CF7

Прочитаны общие AGENTS.md и AGENT-ECONOMY.md. В общей synapse-server нет docs/spec-kit-policy.md и .specify/memory/constitution.md; прочитаны действительные файлы версии 1.0.0 в выделенной рабочей копии. Получено ограниченное владение шестью файлами ops/crm и новым пакетом 057. Claude сохраняет владение UI.

Сначала подготовлены spec/plan/tasks, затем реализация. Публикация, интеграция QA и живые API не выполнялись.

## Реальные проверки 01.10.2026
- Node v24.18.1: `node --test ops/crm/content-factory-inputs.test.js ops/crm/content-plan-service.test.js ops/crm/content-plan-worker.test.js` — 29/29 pass, 0 fail/cancel/skip, 528.2757 ms. Добавлены десять содержательных тестов; остальные — прежние.
- Совместимость существующей очереди, переноса и внутреннего runtime: `node --test ops/crm/content-plan-jobs.test.js ops/crm/content-plan-drafts.test.js ops/content/content-plan-runner.test.js` — 25/25 pass, 0 fail/cancel/skip, 572.7648 ms. Эти файлы не менялись. Исполнители синтетические; живых API не было.
- `python tools/spec-kit/gate.py check` — status ok, 48 официальных файлов, интеграции codex/claude/qwen. Проверка комплекта процесса не доказывает качество кода или подключённость моделей.
- `git diff --check` для разрешённой области — без ошибок. Untracked service/worker дополнительно проверяются по содержимому в converge.
- Converge prerequisites выполнен один раз с SPECIFY_FEATURE_DIRECTORY=specs/057-content-factory-month-choices, SPECIFY_FEATURE_NO_PERSIST=1 и PYTHONDONTWRITEBYTECODE=1: FEATURE_DIR соответствует пакету 057, tasks.md доступен. extensions.yml отсутствует, hooks нет.

## Converge: сверка требований
| Требование | Реализация и доказательство |
|---|---|
| FR-001 | FORMATS/ROLES переиспользованы в normalizeMonth и vocabulary. Тесты проверяют canonical order, ошибки типа/повторов/неизвестных значений без записи. |
| FR-002 | EMPTY_MONTH содержит []; merge при чтении старого JSON даёт defaults, partial save сохраняет прочие вводные. Проверены reset, no-op reorder, stale 409, отдельная компания/месяц и неизменность старой версии. |
| FR-003 | Service копирует month.inputs, existing jobs.enqueue сохраняет JSON снимок. После изменения месяца с revision 1 на 2 claim получает прежние formats/roles и monthRevision 1; другая компания не получает job. |
| FR-004 | Prompt передаёт monthInputs и обязательное соблюдение непустых наборов; валидатор проверяет обе независимые границы. Worker с несовместимым ответом даёт failed/INVALID_RESULT и 0 предложений. Старые снимки/[] работают, правило Shorts остаётся. |
| FR-005 | Service добавляет required вопрос target month.formats до проверки worker availability. Даже requireWorker без pulse возвращает needs_input; runOne не вызывает модель. Пустой список/reel/нулевой объём проверены как совместимые. |

Код соответствует spec/plan/tasks в границах пакета; оставшейся реализации по FR-001–005 не обнаружено. Converge не добавляет пустой раздел задач. Ревью и интеграция координатора ещё требуются.

## Контракт для UI
`month.inputs.formats`: post/story/reel/carousel; `month.inputs.roles`: reach/affection/sale. Поля необязательные; при чтении месяца всегда []; [] — все доступные, пропущенное поле PATCH — сохранить прежний выбор. Значения уникальные и нормализованы по порядку словаря. vocabulary.formats/roles содержит [{id,label}] из действительных словарей autoposting. Ошибки выбора 400, существующая stale revision 409.

Если выбран youtube_shorts с perDay > 0 и непустым formats без reel, generation job: status needs_input; questions содержит {id:'formats',target:'month.formats',required:true,text:'Для YouTube Shorts нужен формат Reels / Shorts / клип. Добавьте его в выбранные форматы или уберите объём YouTube Shorts.'}. Система не исправляет выбор сама. Старые снимки без fields продолжают работать. Проценты ОВП не вводятся.

## SHA256 шести изменённых файлов
- ops/crm/content-factory-inputs.js: 60C5F7D4C7F6D2A4054E7A8E42ADC53CFB3F85C751BFA60941847927F9AFE6BF
- ops/crm/content-factory-inputs.test.js: 01256F10C172F3F0A944974CE08B296802210313AC27237C3FA76DAE21B35222
- ops/crm/content-plan-service.js: 1F541EC82342D97BBAA282AC7EE582237537B2C6D023E622ED4AC341617BBA68
- ops/crm/content-plan-service.test.js: D9F36754501CEAE7E1FE8D193D56F1B99F30174CA330E13A2FC3BD64D954E32D
- ops/crm/content-plan-worker.js: FBDF938366F185CD44CD51F2E6433FFA935A350DE99F683D5F51EA94E48CB31E
- ops/crm/content-plan-worker.test.js: 50C12CF9232616ACB521A2A6D462268B78DB94F0CDA6610365AB7B507D7CD055

## Открыто вне пакета
UI выбора formats/roles и переход от вопроса month.formats принадлежат Claude. HTTP/proxy/UI общей QA, независимое ревью, manifest и интеграция принадлежат координатору. Production/live API не проверены. Исходный staged/untracked статус не менялся; новые агенты, сеть, секреты, коммиты/push/deploy не использовались.
