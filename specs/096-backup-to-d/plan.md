# План

Один писатель Codex в ops/backup, specs/096-backup-to-d и отдельном CI.
Существующие backup.sh/таймер и local-worker сохраняются до согласованного перехода.
Новый Python CLI: create/serve/pull/restore; age; OpenSSH; Windows Task Scheduler.
Снимок требует согласованного ночного окна: pause всех контейнеров на время
SQLite и tar; внешние host writers предварительно остановлены владельцем ресурса.
Образы выгружаются после resume. Сначала review этого компромисса Claude.
Миграций БД нет. Restore не переключает домены/отправителей и не заменяет production.
Проверки: WAL fixture, retention, SHA/ошибки, безопасные пути, age CI;
затем действительная инвентаризация/копия/Docker smoke/RTO в разрешённом окне.
