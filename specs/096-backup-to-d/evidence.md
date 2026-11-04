# Свидетельства

## Исправление review221, 04.11.2026

Windows Python3.14:18PASS/4SKIP (age/Linux/symlink права). Добавлены регрессии:
сбой weekly не пропускает rotation/status/report; partial24h; key/temp вне
архивов; NO_SPACE до decrypt; prune только по точному latestreceipt; SSHack/delete
запрещены; board неизвестная доставка не повторяется; кабинет обязателен вsmoke.
Linux CI дополнительно запускает настоящий create→age→restore с открытой WAL,
абсолютной ссылкой и запретом всех Docker-команд кроме inspect/ps/image save.
Отдельно проверяется age-auth failure после пересчёта SHA усечённого ciphertext.
SpecKit48PASS, PowerShell/BashsyntaxPASS, diffcheckPASS. CIрезультат — в№58/PR484.
Ни server inventory, ни фактическая копияD, ни реальные контейнеры/RTO не проверены.
MCP report использует private существующее подключение после приёмки, сейчас
тестируется fixture/mocks; нет заявленной доставки из фонового ПК в production.

## Первый кандидат до review221 (история)
04.11.2026, Windows Python 3.14: 7 PASS, 1 SKIP (age отсутствует).
Проверены committed WAL/старый текст, corrupt DB, retention, traversal,
запрет overwrite, строгий SSH host pin, ошибочный receipt без удаления старого.
Исправлено явное закрытие SQLite connections (иначе WinError32 при cleanup).
Spec Kit gate check PASS (48 файлов), PowerShell parser PASS, diff check PASS.
Linux CI отдельно проверяет настоящий age roundtrip. Результат CI записать после PR.
Docker/production/полная инвентаризация/копия на D/RTO/планировщик ещё не проверены.
Общая консоль запрошена в №58/comment182. Серверных изменений/ключей/таймеров 0.
Пакет — draft: live ACL verification, подключение board-report, full managed restore/cutover и
приёмка ночной паузы остаются открытыми; stage verified/accepted не ставить.

## Потоковая копия — новые свидетельства

Начало05.11 01:25Бангкок. Ветка создана от main7678403e; primary checkout/production не менялись. ПравилаSpecKit1.0.0 прочитаны. Старые23теста выше относятся к архивному484 и не являются доказательством потока.

Проверенный локально кандидат: `backup_stream.py` SHA256
`b1f9dad543df61ee53b0de286e67d4b00b1150feb2458e276ddbae3cfa796e71`,
`backup_v2.py` `779e3cb4c8dd7325a0ed180115a35c3342e4a136e1e5fa90f26e86d4eaec8168`.
Windows Python3.14, настоящий age1.3.2: полный backup suite48 тестов,
34PASS/14SKIP/0FAIL. Пропуски включают Linux FIFO, UID, quota, link-race,
online producer и Docker sandbox; это НЕ пройденная Linux-проверка.
Spec Kit gate check48файлов PASS, git diff --check PASS.

Реальный age roundtrip на одноразовой fixture identity подтвердил старые
WAL-сообщения, вложение, черновик и согласие через прежний restore.
Изменённый ciphertext с пересчитанным внешним SHA отклонён проверкой age.
Protocol fixtures проверяют обязательную weekly-проверку до promote/ACK,
receipt/SHA/размеры, обрыв без дописывания, неизвестный исход без повторного
чтения FIFO, private paths вне назначения и PENDING при недоставленном отчёте.

Предварительный независимый Codex review нашёл два P1: устаревший полный stage
мог скрыть свежую копию; замена родительского каталога источника могла обойти
leaf-only O_NOFOLLOW. В кандидате исправлены единая проверка свежести и
openat всей цепочки с привязкой SQLite FD/sidecars. Добавлены регрессии;
Независимый Codex review исправления не обнаружил оставшихся P1; после него
та же привязка чтения добавлена в классификацию SQLite по заголовку.
Linux-исполнение ещё ожидается. Codex review не является приёмкой Claude.

Не выполнены: Linux CI exact head, production-установка, сегодняшняя копия
наD, проверка реального состава/внешних ссылок, подключение отчётов,
выключенныйПК→свежая копия, полный sandbox и измерение RTO. Ключи/права,
production-сервисы и legacy guard этим PR не изменялись.
