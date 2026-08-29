# Как работает бэкап

`backup.sh` создаёт в `/var/backups/synapse` один архив вида
`synapse-YYYY-MM-DD-HHMMSS.tar.gz`. В архив входят Caddyfile, все
Docker Compose-файлы, `content.json`, медиакаталоги сайтов и все
именованные Docker-тома Compose-проекта (в том числе том базы
данных). Хранятся семь самых новых архивов.

Пути можно изменить без правки скрипта через `SYNAPSE_DEPLOY_DIR` и
`SYNAPSE_BACKUP_DIR`; число копий — через `SYNAPSE_BACKUP_KEEP`. Переменные
можно записать в необязательный `/etc/synapse-backup.env`.

## Установка

```bash
sudo install -m 0755 /opt/synapse/ops/backup/backup.sh /usr/local/sbin/synapse-backup
sudo install -m 0644 /opt/synapse/ops/backup/synapse-backup.service /etc/systemd/system/
sudo install -m 0644 /opt/synapse/ops/backup/synapse-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now synapse-backup.timer
```

Таймер запускает бэкап ежедневно в 03:15 по московскому времени.

## Проверка

```bash
sudo systemctl start synapse-backup.service
sudo journalctl -u synapse-backup.service -n 100 --no-pager
sudo tar -tzf /var/backups/synapse/synapse-YYYY-MM-DD-HHMMSS.tar.gz
```

Если архив не удалось создать или он пуст, скрипт завершается с
ненулевым кодом, и systemd отмечает запуск как неуспешный.
