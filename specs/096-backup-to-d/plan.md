# План

Один писатель Codex в ops/backup, specs/096-backup-to-d и отдельном CI.
Существующие backup.sh/таймер и local-worker сохраняются до согласованного перехода.
Новый Python CLI: create/serve/pull/restore; age; OpenSSH; Windows Task Scheduler.
Online VACUUM INTO без pause контейнеров, отдельная согласованность каждой БД.
Ссылки внутрь roots переписываются относительными. D housekeeping/status в finally.
Временная приватная расшифровка с бюджетом места и удалением при ошибках.
Board MCP reporter/outbox и server prune по точному D-receipt без SSH writes.
Миграций БД нет. Restore не переключает домены/отправителей и не заменяет production.
Проверки: WAL fixture, retention, SHA/ошибки, безопасные пути, age CI;
затем действительная инвентаризация/копия/Docker smoke/RTO в разрешённом окне.

## Дополнение: профиль потока

Ветка codex/backup-stream-to-d-20261105 от main7678403e. Один автор runtime: release478_package, отдельный автор новых tests: release478_migrations, Spec/RECOVERY/PR и финальная проверка — координатор Codex. Общие файлы не редактируются параллельно. Runtime-граница: ops/backup/backup_v2.py, новый модуль потока и при необходимости отдельный unit; legacy create/pull/serve/restore остаются совместимыми. Ключи, клиентские данные и server configs не входят в git.

Производитель с существующими root backup-полномочиями передаёт только age ciphertext через ограниченный канал. Читатель backup-read сохраняет list/get и не получает root/raw-data доступ. Выбор конкретного транспорта и lifecycle фиксируется после независимой проверки плана; данные продолжают использовать data.tar.age/images.tar.age и существующий restore.

Пока консоль у Claude, работа только локально/API. №25 читается раз в10мин; native-разрешение возникает исключительно по точному «ПЕРЕДАЮ КОНСОЛЬ CODEX». Установка потока — после принятия этого PR, без увеличения диска и без обхода LINK_OUTSIDE_ROOTS. Публикация draft PR разрешена, merge/production не выдаются за подготовку.
