# Свидетельства

04.11.2026, Windows Python 3.14: 7 PASS, 1 SKIP (age отсутствует).
Проверены committed WAL/старый текст, corrupt DB, retention, traversal,
запрет overwrite, строгий SSH host pin, ошибочный receipt без удаления старого.
Исправлено явное закрытие SQLite connections (иначе WinError32 при cleanup).
Spec Kit gate check PASS (48 файлов), PowerShell parser PASS, diff check PASS.
Linux CI отдельно проверяет настоящий age roundtrip. Результат CI записать после PR.
Docker/production/полная инвентаризация/копия на D/RTO/планировщик ещё не проверены.
Общая консоль запрошена в №58/comment182. Серверных изменений/ключей/таймеров 0.
Пакет — draft: live ACL verification, board-report, full managed restore/cutover и
приёмка ночной паузы остаются открытыми; stage verified/accepted не ставить.
