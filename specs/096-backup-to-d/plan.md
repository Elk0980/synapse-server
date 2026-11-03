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
