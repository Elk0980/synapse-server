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
