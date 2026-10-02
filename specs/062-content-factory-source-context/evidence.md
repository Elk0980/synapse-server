# Свидетельства CF12

## Реализовано

Content createSourceContext({db}).capture(code) читает scoped stored/text, ограничивает последние100 и UTF-8 размер всего manifest64КиБ. Сохраняет целые подписи/metadata, total/truncated и canonical SHA256 без hash. Файлы, ссылки доставки, disk/chat/author/provenance поля не выбираются. Пустая библиотека не создаёт таблиц.

CRM validateSourceLibrary строго проверяет company/schema/ключи/типы/id/revision/metadata/порядок/лимиты/hash, возвращает отдельную копию. create(code,body,manifest) сохраняет sourceLibrary в существующем snapshot. Read-only jobs.lookupRequest возвращает прежний DTO до чтения новых вводных и manifest, конфликт месяца409. Алгоритм enqueue fingerprint не изменён.

Worker передаёт библиотеку как данные и принимает source:<id> только из своей библиотеки. Namespace source: зарезервирован на новых snapshots; старые snapshots и brief IDs работают по прежнему контракту. Автоматического прикрепления нет.

## Собственные локальные проверки01.10.2026

- Первичный узкий прогон43/43; затем добавлены отдельные пробы валидного hash при превышении64КиБ и сохранения непустой библиотеки после закрытия/открытия файловой SQLiteБД.
- Финальный расширенный прогон144/144: content-factory-source-context; content-plan-service/jobs/worker/drafts; media-mentor, transfer, rollout, pilot, http. Node v24.18.1. Синтетические memory/file SQLite, введённый тестовый provider, без внешней сети/моделей/production.
- Пробы отдельно подтверждают другие компании, stored/text фильтр, последние100, полный UTF-8 размер включая hash, сохранность подписи, рекурсивную сортировку ключей hash, replay после правки библиотеки и brief/month, отсутствие повторного чтения через throwing context/mentor, неизменность snapshot_hash, конфликт месяца, запрет body.sourceLibrary, unknown/foreign source IDs и legacy namespace.
- `git diff --check` без ошибок. `python -B tools/spec-kit/gate.py check`: status=ok, verifiedFiles48; это проверка процесса, не HTTP или runtime интеграции.
- Сравнение с сохранённым перед работой содержимым: все неизменённые строки шести существующих файлов сохранены в исходном порядке; исходные тесты не удалены. Семь явно заменённых строк относятся к create signature/snapshot, exports/return очереди, validator assets и prompt; остальные изменения добавлены точечно.

## Converge

Проверены FR-001–006, три сценария приёмки и четыре решения плана. В разрешённой области незакрытых требований не обнаружено; новых convergence tasks нет. Запись после передачи окончательных SHA остановлена.

## Не проверено и не подключено этим пакетом

Закрытый HTTP lookup перед capture, plan-start, identity/CSRF, межслужебная доставка и Content runner принадлежат root и требуют его интеграционной проверки. Нет общего commit двух служб; снимок сохраняет состояние момента capture. UI, analytics, рабочая библиотека, внешняя модель и production не проверялись. Из наличия файла не следует право использовать материал или подтверждение его подписи как факта.
