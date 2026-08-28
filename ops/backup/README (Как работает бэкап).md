# Как работает бэкап

`backup.sh` ежедневно создаёт **один** архив `synapse-host-YYYY-MM-DD-HHMM.tar.gz`.
В него входят полный каталог развёртывания, итоговая конфигурация Docker Compose,
списки и версии контейнеров/образов, результаты `docker inspect` и содержимое
именованных Docker-томов сервисов из Compose. На время копирования томов скрипт
останавливает только работавшие контейнеры этого Compose-проекта, а затем снова
запускает их.

Рядом создаётся текстовый манифест `.manifest.txt` с составом, размером и
SHA-256. Оба файла загружаются через `rclone`. На Google Диске остаются 14 самых
новых ежедневных архивов и все архивы, созданные первого числа месяца.

## Требования и безопасность

Нужны `bash`, GNU `tar`, `gzip`, `docker compose` и `rclone`. Скрипт запускается
от `root`: конфигурация rclone читается только из
`/root/.config/rclone/rclone.conf`. Имя remote обязательно передаётся через
`RCLONE_REMOTE`; каталог на Диске можно изменить через `RCLONE_DESTINATION`
(по умолчанию `synapse-backups`). Секреты и конфигурацию rclone в Git добавлять
нельзя.

## Установка

```bash
sudo apt-get update && sudo apt-get install -y rclone
sudo rclone config
# Создайте Google Drive remote, например gdrive; секреты останутся вне Git.

sudo install -m 0755 /opt/synapse/ops/backup/backup.sh /usr/local/sbin/synapse-backup
sudo install -m 0644 /opt/synapse/ops/backup/synapse-backup.service /etc/systemd/system/
sudo install -m 0644 /opt/synapse/ops/backup/synapse-backup.timer /etc/systemd/system/
sudo sh -c 'printf "%s\n" "RCLONE_REMOTE=gdrive" "RCLONE_DESTINATION=synapse-backups" > /etc/synapse-backup.env'
sudo chmod 0600 /etc/synapse-backup.env
sudo systemctl daemon-reload
sudo systemctl enable --now synapse-backup.timer
```

Если репозиторий развёрнут не в `/opt/synapse`, добавьте в environment-файл
`SYNAPSE_DEPLOY_DIR=/другой/путь`. Локальный каталог можно задать переменной
`SYNAPSE_BACKUP_DIR`; по умолчанию используется `/var/backups/synapse`.

## Проверка

Сначала безопасно посмотреть план — команда ничего не создаёт, не останавливает
и не загружает:

```bash
sudo systemctl show synapse-backup.service -p EnvironmentFiles
sudo env RCLONE_REMOTE=gdrive /usr/local/sbin/synapse-backup --dry-run
sudo systemctl start synapse-backup.service
sudo journalctl -u synapse-backup.service -n 100 --no-pager
sudo rclone lsl --config /root/.config/rclone/rclone.conf gdrive:synapse-backups
```

Для локальной проверки возьмите значения `sha256=` и `archive=` из одного
манифеста и выполните:

```bash
cd /var/backups/synapse
printf '%s  %s\n' 'ЗНАЧЕНИЕ_SHA256' 'ИМЯ_АРХИВА' | sha256sum -c -
```

## Восстановление

1. Остановите сервисы и скачайте архив с манифестом.
2. Сверьте SHA-256, как показано выше.
3. Распакуйте архив во временный каталог и проверьте его состав.
4. Верните содержимое `deployment/` в каталог развёртывания.
5. Создайте отсутствующие именованные тома и скопируйте в них данные.
6. Запустите Compose и проверьте журналы.

Пример (имена томов возьмите из `docker/volumes/`):

```bash
sudo systemctl stop synapse-backup.timer
sudo docker compose -f /opt/synapse/docker-compose.yml down
mkdir -p /tmp/synapse-restore
sudo tar -xzf synapse-host-YYYY-MM-DD-HHMM.tar.gz -C /tmp/synapse-restore
sudo rsync -aHAX --delete /tmp/synapse-restore/deployment/ /opt/synapse/
sudo docker volume create ИМЯ_ТОМА
sudo rsync -aHAX --delete /tmp/synapse-restore/docker/volumes/ИМЯ_ТОМА/ \
  "$(sudo docker volume inspect --format '{{.Mountpoint}}' ИМЯ_ТОМА)/"
sudo docker compose -f /opt/synapse/docker-compose.yml up -d
sudo docker compose -f /opt/synapse/docker-compose.yml ps
```

Восстанавливайте каждый том отдельно. После проверки удалите временную копию и
снова включите таймер: `sudo systemctl start synapse-backup.timer`.
