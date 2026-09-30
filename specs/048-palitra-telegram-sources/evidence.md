# Проверка приватного приёма исходников

Дата: 30.09.2026. Исполнитель: Codex, отдельная ветка `codex/palitra-source-intake-20260930`, база `8a500b8c671e3375cef0b043ab8964af7dd32422`. Процесс Spec Kit 1.0.0. Все события и учётные данные в тестах синтетические, Telegram-транспорт заменён заглушкой. Production, права, секреты и сообщения клиентов не менялись.

## Проверено

- FR-001/002: source-связь отдельна от рабочей комнаты; `/plan`, `/idea`, `/bind`, обращения по имени остаются текстом исходников. Ни legacy, ни room receive не вызываются. Выключенный источник сохраняет тело события в failed inbox.
- FR-003: SQLite-квитанция переживает закрытие/открытие БД; повтор chat/message возвращает тот же id и не скачивает файл. Временный отказ оставляет долговечную очередь, повтор после квитанции безопасен. SHA256 экономит место только в рамках компании.
- FR-004: файл 65 700 000 байт имеет метаданные, ссылку и manual_import; запрос getFile не делается. Небольшое MP4 проходит bridge → реальный локальный HTTP server → приватный модуль → скачивание с совпадением байтов. Неверная сигнатура и превышение квоты оставляют карточку.
- FR-005: проверены внутренний ключ, анонимный отказ, чужая компания, подмена company в file URL, отзыв компании/прав, приватные заголовки. Обычный публичный assets-маршрут не адресует вложенный private/company/hash; список не раскрывает file_id или имя файла на диске.
- FR-006: DOM-тесты подтверждают текстовый вывод без XSS, отказ от чужого file URL, корректные статусы, повтор запроса и игнорирование запоздалого ответа после уничтожения прежнего экрана.
- HTTP-сценарий после всех входящих проверяет нулевое число `project_chat_messages`, `project_chat_ai_jobs`, `project_chat_outbox`, `project_chat_tasks`.
- Ревью выявило миграцию source-группы и позднюю коллизию с рабочей комнатой. Обе исправлены: новый адрес резервируется выключенным в любом порядке migrate_to/migrate_from; поздняя коллизия возвращает выключенный source прежде room. Регрессии проверены через модуль, bridge и реальный локальный HTTP/settings. Данные рабочей комнаты модуль не меняет.
- Прежний ответ binding обычной группы сохранён. Первая полная проверка обнаружила лишнее `source:null`, исправлено до окончательной проверки.

## Команды и результаты

Прогоны завершены. Логи локальны, в публичный репозиторий не добавляются.

| Проверка | Результат |
|---|---|
| `node --test --test-concurrency=1 ops/content/*.test.js` | 529 tests: 526 PASS, 0 failed, 3 skipped |
| `node --test ops/chat/*.test.js sites/synapse/cabinet/telegram-sources.test.cjs` с существующим NODE_PATH/jsdom | 101/101 PASS, 0 skipped |
| `node --test sites/synapse/cabinet/*.test.cjs` после включения принятого UI-коммита | 627/627 PASS, 0 skipped |
| `node --test ops/content/telegram-sources.test.js ops/content/telegram-sources-integration.test.js` после исправления runtime-коллизии | 9/9 PASS |
| `node --check` для нового модуля, bridge, server и UI | PASS |
| Spec Kit `check_prerequisites.py --json --require-spec --require-tasks --include-tasks` | PASS, feature048 |
| `python tools/spec-kit/gate.py check` | PASS, 48 upstream-файлов |
| `git diff --check` | PASS |

Пропуски полного content прогона: Windows symbolic link, POSIX-права ключа и проверка реального Caddy (бинарник отсутствует). Они не заявлены пройденными; исходники/private HTTP проверены отдельными unit и интеграционным тестом.

## Границы результата и converge

Реализовано и проверено локально. После первого ревью root принял UI-коммит `dbcc4145dd78a34573ade71fb7e277fdac1df530` отдельного владельца; cherry-pick добавил adapter и вкладку исходников из «Контент завода». Смена компании/вида/logout уничтожает старый список. Конфигурация на сервере не входит в этот PR, feature им не включается. Рабочее подключение и ручной импорт истории не проверялись этим исполнителем. Нельзя считать пункт 10 полностью выполненным по локальным тестам.

Проверены 7 FR, 3 SC, 5 решений плана и 5 принципов конституции. Первый converge добавил T006 по SC-003/T005. Локальное UI-подключение теперь выполнено назначенным владельцем и принято root; оставшаяся HIGH/partial часть — рабочая приёмка разрешённого источника. T005/T006 остаются открытыми до её доказательства. `.specify/extensions.yml` отсутствует, hooks нет.

Независимый reviewer `content_meeting_package` повторно проверил фиксированный backend head `d9339bccba92bf57fce8983e499c467771429810`: оба порядка миграции, позднюю коллизию и сохранение обычного room receive. Обе первоначальные P1 сняты; других блокеров в выделенном scope не обнаружено. Полные прогоны он не повторял. CI этого backend head: оба project-chat checks PASS, Spec Kit PASS; для итогового head с UI нужны отдельные CI-результаты.

Подключение, порядок резервирования и ограничения описаны в `integration.md`. Лимит основан на [официальном getFile](https://core.telegram.org/bots/api#getfile), а не на возможности скачивания Telegram Desktop. Старое `/content` обещание видео отдельно отмечено владельцу команд.

## Ручной импорт (T007–T009), 30.09.2026

Исполнитель продолжения — Claude (единственный писатель после остановки Codex-автора). Незакоммиченный diff взят из рабочей копии `worktrees/palitra-editor-ux-20260924` без reset, наложен на `87072ae` в отдельной облачной копии; прогон — Linux, Node 22.22. Windows и CI (Node 24) здесь не запускались.

| Команда | Результат |
|---|---|
| `node --test ops/content/telegram-sources.test.js ops/content/telegram-sources-manual.test.js ops/content/telegram-sources-integration.test.js` | 14/14 PASS (включая 68 935 123 и 170 000 000 байт потоком, повтор/конфликт, CSRF/owner/sessionVersion/компания, обрыв, сигнатура, квота, companyLimits) |
| `node --test --test-concurrency=4 ops/content/*.test.js` | 544 tests: 543 PASS, 0 failed, 1 skipped |
| `node --test sites/synapse/cabinet/*.test.cjs` (jsdom через NODE_PATH) | 635/635 PASS |
| `node --check` модуля, multipart, server, UI, adapter | PASS |
| `git diff --cached --check` | PASS |
| `python tools/spec-kit/gate.py check` | status ok, 48 файлов |
| `check_prerequisites.py --json --require-spec --require-tasks --include-tasks` (с `SPECIFY_FEATURE_DIRECTORY`) | PASS, feature 048 |

Ревью кода продолжателем: поток пишется во временный каталог внутри приватного хранилища и переименовывается на том же диске; при ошибке, обрыве и дубле временный файл удаляется. Авторизация повторяется после чтения. Для истории без ссылки message ID не подделывается (`archive:<sha256>`). Скачивание потоковое. Оставлено как есть: одна ручная загрузка на процесс (429 для второй), `requestTimeout` 300 с (см. integration.md).

Не проверено: реальный файл на production, Caddy, Windows-прогон. T010 остаётся за координатором.
