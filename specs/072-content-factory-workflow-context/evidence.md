# Свидетельства CF22

Дата: 2026-10-01. Процесс Spec Kit 1.0.0. Код CF22 и нижеуказанные проверки выполнил агент Codex в source CONTENT_FACTORY_CF2_CODEX_20261001. Синтетическая SQLite, подмены JSON/auth/provider без сети и live API. Контракт утверждён root до code.

## Свои реальные проверки

- node --test ops/crm/content-plan-service.test.js ops/crm/content-plan-worker.test.js ops/crm/media-mentor-http.test.js: exit 0; 54/54 passed (service12, worker19, HTTP23), fail/cancelled/skipped/todo0; duration422.6007ms. Один прогон этих трёх файлов, включая baseline checks и 12 новых тестов CF22.
- python -B .specify/scripts/python/check_prerequisites.py --json --require-spec --require-tasks --include-tasks: exit0 до code и после code, FEATURE_DIR=specs/072-content-factory-workflow-context. Использованы SPECIFY_FEATURE_DIRECTORY и SPECIFY_FEATURE_NO_PERSIST=1; feature-state/bytecode не записывались.
- python -B tools/spec-kit/gate.py check: exit0, status=ok, verifiedFiles=48. Это проверка файлов процесса, не подключения моделей.
- extensions.yml отсутствует. Scoped converge по 6FR/4SC/4сценариям/решениям plan/конституции: missing/partial/contradicts/unrequested findings0 внутри пакета; пустая convergence phase не добавлялась.

## Подтверждённое поведение

| Требование | Свидетельство |
| --- | --- |
| FR-001/FR-002 | Service использует настоящий CF21. Snapshot хранит только operational workflow + workflowRevision; private publisher/actor marker и имена полей отсутствуют. Правка после enqueue не меняет сохранённые snapshot/hash. Replay возвращает old job даже с mentor/workflow, запрещающими новое чтение. Реальная смена workflow revision между reads ->409 INPUTS_CHANGED и ноль jobs. Чужая компания/типы/body workflow отвергаются. Optional dependency absent не добавляет новые поля. |
| FR-003/FR-004 | Manual/scheduled/unset проходят через synthetic provider с exact operational context. 16 corrupted queue вариантов (company/unknown top/fields/publisherName/types/missing/reference/null) ->INVALID_RESULT, authorize=0 и provider=0. Старый job без workflow succeeds. Prompt явно обозначает пожелания/пояс/неназначенное расписание; результат не имеет scheduledAt, autoposting_posts не создаётся. |
| FR-005 | Настоящий CF21 и synthetic HTTP harness: GET/PUT200 no-store, view/edit/company isolation, actor из identity, malformed/body actor injection400, stale409, unsupported405, dependency absent501. После async JSON revoke/view downgrade/userId swap/CSRF loss ->403 и configured=false; fresh userName при том же userId попадает в history. |
| FR-006 | Изменены только 6 выделенных JS/test и 4 новых docs072; factory server wiring, schedule guard, права, UI, QA/state/manifest не менялись. |

## Контракт интеграции

createContentPlanService({mentor,jobs,workflow}) и createMediaMentorHandler({...existing,workflow}) принимают существующий CF21 factory instance. Root подключает его сам.

Новые jobs при dependency содержат snapshot.inputs.workflowRevision и snapshot.workflow={companyCode,revision,configured,fields:{releaseMode,hours,preparationDays,reviewDays}}. Для revision0 configured=false допускаются только CF21 defaults. Queue schema strict; fields.publisherName/actor/approverRole неизвестны и не отправляются API. Без workflow — прежний snapshot/prompt. Validator дополнительно сверяет workflowRevision с revision и company с job scope.

GET/PUT /media-mentor/workflow?companyCode=<code>: existing companyModuleContext view/edit; PUT повторяет edit context после readJson и запрещает смену userId, использует fresh actor. Ответ200 cache-control no-store. Неподключённый factory ->501, без ложного успеха. CSRF/session принадлежат существующему content-service bridge; synthetic injected guard доказывает обработку отказа, но не является проверкой реального transport/session.

## Чужие проверки и открытое

Root сообщил о приёмке зависимости CF21: 6/6 SHA и собственный 8/8 run. Это результаты root, а не дополнительный прогон CF22.

Root server wiring, settings/snapshot/UI и CF20 runtime schedule guard остаются отдельной интеграцией. scheduled context не включает worker, не назначает время, не создаёт права/задачи/отправки. Сервисов, браузера, production, live API, Telegram/клиентских сообщений, секретов, commit/push/deploy не было. Итоговые10SHA переданы root отдельно; после них запись остановлена. QA manifest мной не изменялся.
