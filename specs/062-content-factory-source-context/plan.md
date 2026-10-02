# План CF12

Единственный писатель: Codex `/root/content_factory_batch_review`. Разрешены только content-plan-service/jobs/worker.js и их test.js, новый ops/content/content-factory-source-context.js и test.js, четыре документа этой спецификации. Server/HTTP/autoposting/QA/manifest/state и остальные файлы только чтение.

1. Новый Content producer capture(code) выбирает scoped stored/text, последние100 по id DESC. COUNT OVER сохраняет согласованность total и списка. Проекция исключает любые файловые/авторские/Telegram поля; metadata только существующего словаря.
2. Оболочка `{schemaVersion:1,companyCode,total,truncated,assets,hash}` ≤64КиБ; hash=SHA256 canonical JSON без hash. Producer ограничивает число целых записей по окончательному размеру оболочки.
3. content-plan-jobs экспортирует строгий validateSourceLibrary и read-only lookupRequest. Existing enqueue fingerprint не изменяется. Сервис сначала проверяет body и replay, затем manifest и текущие вводные, сохраняет deep copy manifest.
4. Worker включает sourceLibrary в prompt и разрешает source:<id> только из своей сохранённой библиотеки. На новых snapshots namespace source: зарезервирован; на старых поведение brief asset IDs прежнее.
5. Локальные пробы SQLite памяти и существующие тесты очереди/сервиса/worker. Повторно проверить процесс gate и сохранность чужого исходного содержимого.

Миграций схемы нет: library хранится внутри существующего snapshot. Closed lookup/capture/start, identity/CSRF и доставка между контейнерами — отдельная область root; этот пакет их не объявляет выполненными.
