#!/usr/bin/env bash
# Только чтение. Не выводит env/ключи/переписку. Перед запуском согласовать консоль.
set -Eeuo pipefail
df -B1 / /var/backups
du -x -B1 --max-depth=1 /opt /var/lib/docker /var/backups /var/log 2>/dev/null
docker system df
docker ps -aq | xargs -r docker inspect --format '{{.Name}} image={{.Image}} {{range .Mounts}} {{.Type}}:{{.Source}}->{{.Destination}}{{end}}'
systemctl list-timers --all --no-pager | grep -E 'backup|synapse' || true
find /opt /var/backups -xdev -type f \( -name '*.sqlite' -o -name '*.db' -o -name '*before-board-v10*' -o -name '*backup*.sh' \) -printf '%s %p\n' 2>/dev/null
