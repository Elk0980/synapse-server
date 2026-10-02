# План CF22

Процесс Spec Kit 1.0.0. Один автор шести выделенных JS/test файлов и четырёх новых документов; контракт root согласовал до code.

## Реализация

Service optional workflow.get читает CF21 DTO, выбирает только operational keys и валидирует через общий helper в content-plan-worker.js (service уже импортирует slotsFor оттуда). Хранение jobs.snapshot и immutable hash переиспользуется; новая migration не нужна. Повторный read перед enqueue проверяет revision; replay lookup остаётся первым. На старые tasks/posts/snapshots writes не выполняются.

Worker helper проверяет exact queue shape/company/ranges/ref и возвращает новый safe DTO. Снимок проверяется после claim до authorize/provider и повторно при построении prompt; presence без корректного inputs.workflowRevision недопустима. Отсутствие workflow — прежний путь. Prompt добавляет whitelist context и объяснение пожеланий, без изменения результата/слотов.

HTTP optional workflow dependency: новый exact маршрут внутри существующего media-mentor namespace. GET view; PUT edit до чтения body и после await readJson. Fresh userId должен совпадать initial; fresh actor передаётся CF21 save. CSRF не реализуется заново: existing content-service bridge остаётся владельцем session/CSRF guard. В тесте injected guard моделирует отказ, не выдаётся за исполненный transport.

## Проверки

Synthetic node:sqlite fixtures и local injected JSON/auth/provider; только node --test для content-plan-service.test.js, content-plan-worker.test.js, media-mentor-http.test.js. Service test использует настоящий CF21; HTTP тоже. Worker invalid tests доказывают ноль authorize/provider calls. Spec Kit prerequisites/gate python -B с SPECIFY_FEATURE_NO_PERSIST=1 и scoped converge по FR/SC. Никаких network/API/live/service runs.

## Граница подключения

Root подключает workflow factory в server; CF20 владеет schedule guard. Эти файлы не редактируются CF22. Workflow context влияет только на новые задания после root wiring. Проверки здесь не доказывают runtime HTTP/session/CSRF bridge или production delivery.
