# №58 — кандидат резервной копии на D

**Пока не устанавливать.** Нужны review Claude, фактическая инвентаризация и
согласованное ночное окно. Старый backup.sh и его расписание пока сохраняются.
Этот пакет ещё не доказывает наличие полной копии либо восстановление за час.

## Что выяснено 04.11.2026

- main: fb598368; существующий backup.sh берёт отдельные файлы сайтов и raw
  named volumes. Нет полного дерева сайтов, .env, согласованного SQLite,
  шифрования, SHA, образов managed releases и Windows pull.
- before-board-v10 подтверждён исторической памяткой выпуска PR475; это
  страховка миграции CRM, не замена полного ежедневного бэкапа. Свежий размер
  и путь снимка нужно подтвердить inventory.
- ops/local-hugh и ops/hugh-runtime есть в исходниках. Стандартная локальная
  установка SynapseHugh и задача SynapseHughWorker не обнаружены. Активна
  другая SynapseBackgroundExecutionFabricV1; не менять её в рамках подготовки.
- D: свободно 113.33 GiB. Сервер 64.5/80 GB (81%) — исходное сообщение задачи,
  не свежий замер. Причины заполнения пока не установлены.
- Read-only inventory.sh подготовлен. Общая консоль занята, окно запрошено
  у Claude в №58. Не удалять Docker cache/образы/releases/старые снимки по догадке.

## Полнота и место

Включить **все** фактические bind/volume источники каждого контейнера,
все SQLite независимо от расширения (CRM, content, chat, runtime и прочие),
полные sites/panel/caddy/ops/managed releases с локальными изменениями,
.env/дополнительные env-файлы, Compose и overlays, service/timer units,
reverse proxy/TLS state, конфиги ОС, необходимые приватные каталоги и auth
runtime. Не включать /proc, /sys, /dev, Docker overlay cache и каталог архивов.
Пути named volumes брать из docker inspect, не угадывать по Compose из git.
Нестандартные БД, например PostgreSQL, требуют своего согласованного dump:
этот кандидат умеет только SQLite и должен быть дополнен при их обнаружении.

Публичный git не содержит этой инвентаризации и её private JSON. Host writers
(sync/release/cron) должны быть согласованно исключены на время снимка.
Текущий кандидат проверяет точное множество контейнеров и покрытие mounts;
pause всех контейнеров держится до конца чтения файлов, затем resume перед
экспортом образов. Это означает простой сайтов. **Этот компромисс Claude ещё
не принял.** При неприемлемом времени перейти к LVM/провайдерному snapshot,
после отдельной проверки доступности; не заявлять online backup.
Новая SQLite вне roots и новые host writers автоматически не обнаруживаются.

Пусть B — консервативный размер одной пары зашифрованных data/images, S —
SQLite scratch, M — число хранимых месяцев, R — распаковка плюс образы.
Нужно D ≥ (14+M)×B + R + B на загрузку + резерв. При 113 GiB и M=1, R=2B,
резерве 10 GiB это даёт B ≤5.7 GiB. Это оценка, а не измеренный объём.
На сервере нужны место для 3B, ещё B для атомарного следующего архива, S и
резерв. Старые копии удаляются лишь после успешной новой. Нельзя сначала
удалить страховку ради свободного места. Образы могут сделать B слишком
большим — тогда нужен согласованный переход на дедупликацию или больший D.
Ежемесячные копии не удаляются автоматически: место надо пересматривать.

## Доступ — короткий шаг лично Влада

После code-review, когда всё остальное готово: «ждёт Влада: создать отдельный
SSH-ключ backup-read и передать установщику только публичную часть».
Не передавать приватный ключ или age identity в чат.

```powershell
ssh-keygen -t ed25519 -f "$env:USERPROFILE\.ssh\synapse_backup_read" -C synapse-backup-read
```

Для автономной задачи нужен ключ без интерактивного запроса пароля,
с DACL только Влад+SYSTEM. Он не должен быть root-ключом. На сервере отдельный
пользователь backup-read, без sudo, без доступа к исходным данным; только
read/traverse завершённых encrypted bundles. Его root-owned forced command:

```text
restrict,command="/usr/bin/python3 /usr/local/lib/synapse-backup/backup_v2.py serve /etc/synapse-backup/reader.json" ssh-ed25519 <публичная часть>
```

Authorized_keys/скрипт/reader.json принадлежат root; reader.json только output.
Учётная запись не должна иметь других ключей/пароля/способа запуска shell.
Не ставить nologin без проверки: sshd запускает forced command через login shell.
Права назначения: архивный каталог root:backup-read 0750, итоговые каталоги
root:backup-read 0750 и encrypted files/receipt 0640. Скрипт применяет эти права
по reader_group только к завершённым encrypted bundles перед atomic rename.
Приватный scratch этому пользователю недоступен. Не расширять chmod на raw data.
Сначала проверить list/get и отказ shell, forwarding, put, traversal.
Host key сверить с консолью сервера и закрепить отдельным known_hosts, не
отключать StrictHostKeyChecking и не доверять вслепую ssh-keyscan.

Отдельно Влад создаёт age identity (`age-keygen -o <приватный файл>`),
хранит копию вне этого ПК (например, защищённый носитель). На сервер передаётся
только публичный recipient. Для еженедельной автоматической проверки identity
нужна локально с DACL Влад+SYSTEM; не хранить единственную identity внутри архива.

## Приватная конфигурация, не в checkout

Server JSON (заполнить из inventory; max_* в байтах):

```json
{
  "reviewed_inventory": false,
  "output": "/var/backups/synapse-v2",
  "reader_group": "backup-read",
  "roots": ["/opt/synapse", "/ФАКТИЧЕСКИЙ/ИСТОЧНИК/ТОМА", "/etc/synapse"],
  "containers": ["ФАКТИЧЕСКИЕ-ИМЕНА"],
  "max_bundle_bytes": 1,
  "max_sqlite_bytes": 1,
  "recipient": "ПУБЛИЧНЫЙ-AGE-RECIPIENT"
}
```

Windows JSON:

```json
{
  "destination": "D:/Synapse_Backup",
  "host": "backup-read@ФАКТИЧЕСКИЙ-ХОСТ",
  "ssh_key": "C:/Users/Vlad/.ssh/synapse_backup_read",
  "known_hosts": "D:/Synapse_Private/backup_known_hosts",
  "identity": "D:/Synapse_Private/backup.agekey",
  "age": "D:/Tools/age/age.exe",
  "max_bundle_bytes": 1
}
```

Архивы лежат в `<destination>/synapse-YYYYMMDDTHHMMSSZ/`; дата — UTC, ночной
timer — Bangkok. Частичный каталог .partial не считается копией. На повторном
запуске недокачанный файл загружается заново, проверенные файлы не скачиваются.
Постоянная проверка SHA, раз в 7 суток decrypt/manifest/SQLite; status.json —
короткий результат без секретов. Поломка проверки даёт ненулевой код задачи.
Утренний отчёт в №58 ещё требует подключения к имеющемуся worker; backup-read
не даёт права записи в CRM. Не выдавать status.json за сообщение на доске.

Install-BackupTask.ps1 создаёт отдельную задачу, не трогает worker Хью.
04:30 использует часовой пояс Windows: перед установкой подтвердить Bangkok.
StartWhenAvailable и вход пользователя догружают пропущенное; задача работает
без чата, но в сеансе Влада. До входа пользователя при холодном старте загрузка
не начнётся. Для запуска до входа нужен отдельно согласованный principal.
Локальные Python/OpenSSH/age, Linux Python3.12+/age/Docker — обязательны.

## Восстановление

На отдельном Linux/Docker компьютере/новом сервере, куда скопированы scripts,
пара encrypted bundles, receipt.json и private config с путём identity:

```bash
python3 backup_v2.py restore /private/restore.json /private/КОПИЯ /private/restore-new
SYNAPSE_RESTORE_SITE_HOST=СОГЛАСОВАННЫЙ-СТАТИЧЕСКИЙ-ДОМЕН python3 sandbox.py /private/restore-new
```

Один вызов для распаковки и offline smoke в новом каталоге:

```bash
SYNAPSE_RESTORE_SITE_HOST=СОГЛАСОВАННЫЙ-СТАТИЧЕСКИЙ-ДОМЕН python3 backup_v2.py restore-smoke /private/restore.json /private/КОПИЯ /private/restore-new
```

Первая команда проверяет SHA, расшифровывает с аутентификацией age, безопасно
распаковывает в **новую** папку, проверяет все внутренние SHA и SQLite. Вторая
загружает сохранённые образы, создаёт только тестовые CRM/Caddy с уникальными
именами, без сети и портов, выполняет локальные HTTP probes, удаляет свои
контейнеры. Не трогает production volumes/имена; не запускает исходящие рассылки.
При Caddy с принудительным HTTPS/нестандартной конфигурацией probe потребует
reviewed sandbox Caddyfile. Кабинет/API между сервисами этим пока не проверяются.

VERIFIED.json не равен SANDBOX_OK.json. Даже SANDBOX_OK не равен переключению
production. Для нового боевого сервера нужны точный managed-compose recipe,
совместимые образы/архитектура/UID, networks, DNS/TLS и единственный активный
отправитель. Их надо получить из inventory и проверить; автоматический cutover
пока не реализован. План RTO: 10мин подготовка, 20мин перенос/decrypt, 20мин
подъём, 10мин проверка. Это целевой бюджет; фактический час ещё не измерен.

Приёмка: копия сегодня на D; выключение ПК ночью и реальная догрузка при входе;
restore старых чатов/вложений/черновиков/согласий, CRM/кабинета и минимум сайта;
перезапуск/обновление страницы и проверка актуальных ресурсов; измерить время.
При неуспехе копии/данные сохранять, не откатывать старую БД поверх новых записей.
