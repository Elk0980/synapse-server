# Проверка живости сайтов

Каталог содержит автономную проверку доступности сайтов без токенов, паролей и внешних библиотек. `check.sh` для каждого адреса из `targets.txt`:

- запрашивает главную страницу по HTTPS;
- сохраняет HTTP-код, время ответа в миллисекундах и размер тела в байтах;
- проверяет, что тело не пустое и не содержит строку `Not Found`;
- читает срок действия TLS-сертификата (если это невозможно, записывает `null`);
- атомарно обновляет `status.json`.

`index.html` читает `status.json` и показывает результат в тёмной таблице. Публикация этой папки веб-сервером настраивается отдельно.

## Установка

Предполагается, что репозиторий находится в `/opt/synapse-server`. Нужны `bash`, `curl`, `openssl`, GNU `date`, `timeout` и `awk`.

```bash
cd /opt/synapse-server
sudo chmod +x ops/health/check.sh
sudo cp ops/health/synapse-health.service ops/health/synapse-health.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now synapse-health.timer
sudo systemctl start synapse-health.service
sudo systemctl status synapse-health.timer
```

Последняя команда ручного запуска сразу создаёт первый результат, не дожидаясь таймера. Посмотреть расписание можно командой:

```bash
systemctl list-timers synapse-health.timer
```

## Добавление адреса

Добавьте доменное имя без `https://` и завершающего `/` отдельной строкой в `ops/health/targets.txt`. Пустые строки и строки, начинающиеся с `#`, игнорируются. При следующем запуске таймера адрес появится в `status.json`; для немедленной проверки выполните:

```bash
sudo systemctl start synapse-health.service
```

Для другого расположения репозитория измените `WorkingDirectory` и `ExecStart` в unit-файле перед копированием.
