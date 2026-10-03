# Проверка Eva и узкого исправления CRM

Дата:2026-10-02. Основа:08984a2e1bce85f914fa840ed2e194cc74fe31d6.
Среда: отдельный Windows checkout, Node24.18.1, Python; синтетические fixtures и mock Telegram.
Production, существующие credentials и клиентские данные в тестах не использовались.

## Выполненные проверки

| Команда / область | Результат |
|---|---|
| `node --test ops/eva-tasks/*.test.js ops/crm/eva-task-reader.test.js` | 103 passed,0 failed,1 Linux-only skipped:104 tests |
| `python -m unittest discover -s ops/eva-tasks -p setup_test.py -v` | 21 passed |
| `node --check ops/crm/server.js` | passed |
| `git diff --check` | passed |
| `python tools/spec-kit/gate.py check` | ok;48 official files verified;codex/claude/qwen |
| `node ops/eva-tasks/demo.js --snapshot` | Четыре списка, counts, источник CRM и ссылка кабинета; fixture-only |
| Credential pattern scan новых файлов | Нет совпадений ключей/токенов/приватных ключей; дополнительно ручной review |

Интеграционный тест использует настоящий bot.js внутри runtime: главная→Сегодня→карточка,
свежий источник перечитывается, исходящие действия проходят независимую allowlist-проверку.
Проверены ложные/устаревшие callback, чужой ID/группа, повтор update/перезапуск/авария,
недоступность источника, таймаут/обрыв JSON200, ограниченный backoff, отказ при webhook/409,
защита токена, отсутствие task snapshots и неизменность CRM, актуальное чтение WAL.
Проверены смешанный регистр company_code, перенос задачи, невозможные сроки как unknown.

Независимые ограниченные code reviews выявили и после правок перепроверили: повторные проекты
при регистре кода; потерю различия невалидного срока; ошибочную классификацию обрыва HTTP200.
Это независимые задачи проверки в том же агентном окружении, не доказательство независимого провайдера.
Первоначальный узкий CRM dedup patch независимо проверен на SHA256
`7e75b5802aaa5194b296d7c80aee75244c21f9c261473f643229466fdd4e60e0` (до добавления opt-in hook):
исходный код4pass/3fail, исправленный7pass. [Подробности](source-ref-before.md).

## Соответствие требованиям

FR001/004/005: task-only SELECT внутри CRM, canonical IDs, fresh source, no mutations.
FR002: bot navigation tests + actual runtime integration.
FR003/008: input/output authorization, safe cursor, redacted errors, setup tests.
FR006/007: fixed transport, duplicate/crash tests, no model/public HTTP listener.
FR009: setup/compose/README готовы; личный ввод и activation остаются E8/E9.
FR010: приватный пакет установлен в существующий локальный AI_HANDOFF вне этого public repo;
в прежний вход добавлен указатель с сохранением содержимого и ACL. В публичный diff пакет не входит.
FR011: семь regression-сценариев; dedup hunk сохранён, данные не мигрировались.
FR012/013: server-side approved project scope, удаление компании отзывает выдачу на следующем чтении;
фиксированные девять полей, strict path/method/body, размер/срок/UTF-8/schema, закрытый socket lifecycle.
Eva image/compose не получают DB, CRM key или основной env. Дополнительный server.js hook opt-in.

Spec Kit convergence: требования/план/конституция сверены с указанными файлами и тестами.
Необработанных buildable gaps в локальном scope не осталось. E8/E9 намеренно открыты:
согласование постоянного доступа и фактическая live-приёмка не подменены локальными тестами.

## Не выполнено и границы

- Docker отсутствует в локальном PATH: локальный build/Compose/Linux filesystem не исполнены.
- Telegram username, owner ID, токен, socket volume/project allowlist и часовой пояс лично не настроены.
- Нет production deploy, нового публичного endpoint, изменения существующих прав или отправки реальных сообщений.
- Whole-CRM mount заменён на task-only socket. Новый ограниченный доступ/поля в Telegram требуют решения.
- Cursor сохраняется до ответа: после аварии возможен потерянный экран, восстанавливаемый /tasks;
  exactly-once сетевой доставки нет. Crash lock разбирает оператор, не автоматический перехват.
- Общая полнота legacy списков не заявлена; Eva честно обозначает CRM. Узкая дедупликация
  не создаёт межпроцессный unique-index и не исправляет исторические записи.

Инструкция запуска и точный объём согласования: [ops/eva-tasks/README.md](../../ops/eva-tasks/README.md).
Telegram API сверено с [официальной документацией](https://core.telegram.org/bots/api).

Дополнение02.10: документирована утверждённая схема владелец→Ева-координатор→проектные чаты,
разделение assigned/in_progress/executor_completed/reviewed и передача на том же CRM ID.
Это документационное уточнение: runtime, схема данных, значения статусов и доступы не менялись.

## Дополнение: ограничение доступа к задачам

Последующая реализация FR012/013 меняет transport, не CRM schema/statuses. [Аудит](least-privilege.md)
объясняет, почему общий API key, coordination GET и whole-volume mount не подходят.
Независимый review обнаружил сохранение доступа после soft-delete компании; INNER JOIN активной
компании и regression теперь проверяют отзыв при каждом чтении. Invalid UTF-8 тест дополнительно
проверен mutation в памяти: lossy decoder даёт1 ожидаемый FAIL, реальный fatal decoder проходит.
Mock inode-тест проверяет только дополнительный unlink нашего кода: native Node/libuv close
может удалить привязанный pathname, поэтому менять socket/volume при живом listener запрещено инструкцией.

Для Linux добавлен CI eva-task-reader: реальный UDS request/mode/cleanup на синтетической DB,
все тесты, image build и compose config. Результат конкретного commit проверяется после push;
один факт наличия workflow не считается выполненной Linux-проверкой. Production E2E/приёмка отдельно.

Совместимость проверена с main08984a2 и draft PR444 head afcf6d1: base общий, изменяемые пути
не пересекаются, PR444 не менялся и не merge-ился. Совместный production runtime не тестировался.

## Дополнение 03.10.2026: локальный token-first setup

FR014/015, SC005, E12/E13 реализованы локальным patch поверх PR443 head2bba36f; push/merge нет.
setup --pair принимает только публичные параметры bot username/timezone/socket volume. Токен
вводится первым лично; до двухстороннего подтверждения находится только в памяти. Свежая
192-bit ссылка из личной TTY и 40-bit код из выбранного private Telegram связывают этот аккаунт
с человеком у консоли. Один кандидат, одна попытка, общий SIGALRM300 секунд, повторные проверки
monotonic deadline; обычный setup остаётся offline. Знание username/первое сообщение не дают прав.
До успеха нет token/eva.env; после него используются прежние O_EXCL/O_NOFOLLOW0600/fsync helpers.
Блокировка flock каталога сериализует setup без нового lock-файла. Это не блокировка внешних poller.

Временный bootstrap ограничен четырьмя методами фиксированного HTTPS api.telegram.org, TLS с
проверкой hostname/cert; redirect/409/неоднозначная доставка/слишком большой ответ — отказ.
Подтверждает потребление только candidate update до записи env: обычный bot.js иначе трактует
/start nonce как запрос задач. Последующие updates оставлены runtime. Bootstrap не получает
socket/CRM, не запускает reader/Docker/systemd, не меняет project scope и не входит в image.

Проверки Windows, 03.10 около17:53 Asia/Bangkok:

- python -B -m unittest discover -s ops/eva-tasks -p '*_test.py': **60 passed** (31 setup +29 pairing).
  Используются фиктивные token/transport/HTTP connection, реальные Telegram-запросы запрещены
  в transport fixtures. Проверены stranger/group/forwarded/edited/callback/replay, неверные
  identity/webhook/code, TTL после input/ACK, frozen candidate, ACK failure, лимиты, TLS/redaction,
  отсутствие сохранения до подтверждения, отказ второго setup, offline manual mode, write failure.
- node --test ops/eva-tasks/*.test.js ops/crm/eva-task-reader.test.js ops/crm/task-coordination.test.js:
  **106 passed, 0 failed, 1 Linux-only skipped**. Runtime/CRM/compose авторизация не изменялись.
- Spec Kit gate: **48 files verified**; diff-check passed. CI discovery расширен на *_test.py,
  но новый CI не запускался: patch не отправлен в GitHub.
- Независимое ревью выявило legacy forward_date и поглощение SIGALRM при HTTPS close(); оба
  исправлены с регрессиями. Второй дефект воспроизведён in-memory до исправления.

Convergence: FR001–015, SC001–005 и локальные plan/tasks сверены; новых buildable gaps в данном
patch не осталось. E8/E9 отражают отдельные release/live этапы; локальные тесты их не заменяют.
Новые Linux TTY/SIGALRM/flock, реальный HTTPS/pairing и серверная установка ещё не проверены.
Официальные контракты: https://core.telegram.org/bots/api#getupdates и
https://core.telegram.org/bots/features#deep-linking .
