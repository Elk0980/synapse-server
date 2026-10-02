# Проверка Eva и узкого исправления CRM

Дата:2026-10-02. Основа:08984a2e1bce85f914fa840ed2e194cc74fe31d6.
Среда: отдельный Windows checkout, Node24.18.1, Python; синтетические fixtures и mock Telegram.
Production, существующие credentials и клиентские данные в тестах не использовались.

## Выполненные проверки

| Команда / область | Результат |
|---|---|
| `node --test ops/eva-tasks/*.test.js` | 62 passed,0 failed: adapter7, bot27, runtime21, CRM regression7 |
| `python -m unittest discover -s ops/eva-tasks -p setup_test.py -v` | 18 passed |
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
CRM patch независимо проверен на SHA256
`7e75b5802aaa5194b296d7c80aee75244c21f9c261473f643229466fdd4e60e0`:
исходный код4pass/3fail, исправленный7pass. [Подробности](source-ref-before.md).

## Соответствие требованиям

FR001/004/005: adapter только чтение, canonical IDs, fresh source, no mutations.
FR002: bot navigation tests + actual runtime integration.
FR003/008: input/output authorization, safe cursor, redacted errors, setup tests.
FR006/007: fixed transport, duplicate/crash tests, no model/HTTP listener.
FR009: setup/compose/README готовы; личный ввод и activation остаются E8/E9.
FR010: приватный пакет установлен в существующий локальный AI_HANDOFF вне этого public repo;
в прежний вход добавлен указатель с сохранением содержимого и ACL. В публичный diff пакет не входит.
FR011: семь regression-сценариев; server.js изменён одним hunk, данные не мигрировались.

Spec Kit convergence: требования/план/конституция сверены с указанными файлами и тестами.
Необработанных buildable gaps в локальном scope не осталось. E8/E9 намеренно открыты:
согласование постоянного доступа и фактическая live-приёмка не подменены локальными тестами.

## Не выполнено и границы

- Docker отсутствует в локальном PATH: build/Compose/Linux filesystem/WAL mount не исполнены.
- Telegram username, owner ID, токен, точное имя CRM volume и часовой пояс лично не настроены.
- Нет production deploy, нового публичного endpoint, изменения существующих прав или отправки реальных сообщений.
- Read-only mount даёт процессу техническое чтение всей CRM; выдача этого доступа требует отдельного решения.
- Cursor сохраняется до ответа: после аварии возможен потерянный экран, восстанавливаемый /tasks;
  exactly-once сетевой доставки нет. Crash lock разбирает оператор, не автоматический перехват.
- Общая полнота legacy списков не заявлена; Eva честно обозначает CRM. Узкая дедупликация
  не создаёт межпроцессный unique-index и не исправляет исторические записи.

Инструкция запуска и точный объём согласования: [ops/eva-tasks/README.md](../../ops/eva-tasks/README.md).
Telegram API сверено с [официальной документацией](https://core.telegram.org/bots/api).
