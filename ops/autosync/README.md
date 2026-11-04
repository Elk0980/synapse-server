# Автовыпуск статики кабинета (`synapse-autosync`)

Таймер раз в 2 минуты забирает публичный `main` по https (без ключей) в отдельный
bare-клон `/opt/synapse-autosync/repo` и выкладывает на боевой только статику
из белого списка:

- `sites/synapse/cabinet/**` и `sites/synapse/brand/**`;
- кроме `sites/synapse/cabinet.html`, тестов (`*.test.js`, `*.test.cjs`) и скрытых файлов.

`cabinet.html`, `ops/**`, Docker, Compose, Caddy, ключи и legacy sync
(`MANAGED_RELEASE_BLOCKS_LEGACY_SYNC`) скрипт не трогает. Удаления из `main` на боевом
не повторяются.

## Трёхсторонняя защита

База — последний выложенный коммит (`/var/lib/synapse-autosync/state.json`).
Для каждого изменённого файла белого списка:

| На боевом | Действие |
|---|---|
| равен версии из базы (не правился на сервере) | заменить версией из нового `main` |
| файла нет ни на боевом, ни в базе | добавить |
| уже равен новому `main` | ничего |
| отличается от базы (локальная правка) | пропустить, «локальная правка, не трогаю» |

Поэтому локальные правки сервера не перезаписываются.

## Проверка и откат

До замены прежние файлы копируются в `/var/backups/synapse-autosync/<время>-<commit>/`
(`manifest.json` — что было и чего не было). После замены каждый файл запрашивается
по `https://synapse.synapsebusiness.ru/...`: нужен ответ 200 и те же байты; затем
200 на `cabinet.html`. Любая ошибка — автоматический откат из копии, запись `ROLLBACK`
в журнал и `lastError` в state; этот коммит повторно не выкладывается до следующего merge.

Журнал: `/var/log/synapse-autosync/autosync.log`. Статус: `state.json` (commit, время,
выложенные файлы, пропуски, путь копии).

Ограничение: версия ассетов (`SB_CABINET_ASSET_VERSION` в `cabinet.html`) скриптом не
меняется. Если изменился уже загруженный браузером файл, без новой версии он может
подхватиться не сразу (кэш браузера). Новые файлы видны сразу.

## Установка (root). Таймер включать только после защиты main (№57)

Пока `main` не защищён (№57: обязательные проверки, без прямых push), любой, кто может
писать в `main`, сможет выложить статику кабинета. Поэтому до №57 ставится всё, кроме
`enable --now` таймера.

```sh
SHA=<принятый merge-коммит>; RAW=https://raw.githubusercontent.com/Elk0980/synapse-server/$SHA/ops/autosync
useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin synapse-autosync
install -d -o root -g root -m 755 /usr/local/lib/synapse-autosync
install -d -o synapse-autosync -g synapse-autosync -m 700 /var/backups/synapse-autosync
curl -fsSL $RAW/synapse-autosync.py -o /usr/local/lib/synapse-autosync/synapse-autosync.py
chown root:root /usr/local/lib/synapse-autosync/synapse-autosync.py && chmod 755 /usr/local/lib/synapse-autosync/synapse-autosync.py
curl -fsSL $RAW/synapse-autosync.service -o /etc/systemd/system/synapse-autosync.service
curl -fsSL $RAW/synapse-autosync.timer -o /etc/systemd/system/synapse-autosync.timer
curl -fsSL $RAW/synapse-autosync.logrotate -o /etc/logrotate.d/synapse-autosync
# запись в каталоги статики через группу (ACL на сервере не установлен); файлы остаются root:root 644
for d in /opt/synapse/sites/synapse/cabinet /opt/synapse/sites/synapse/brand; do
  find "$d" -type d -exec chgrp synapse-autosync {} + -exec chmod 2770 {} +; done
systemctl daemon-reload
systemd-analyze security synapse-autosync.service | tail -1     # цель ≤ 3.5
systemctl start synapse-autosync.service                         # первый запуск = база (--init не нужен)
# ТОЛЬКО после №57:
systemctl enable --now synapse-autosync.timer
```

Сверить sha256 скачанных файлов с файлами этого коммита. Пользователь не входит в группу
docker и не видит сокет Docker и `.env`; скрипт в `/usr/local/lib` принадлежит root,
автовыпуск переписать его не может. Состояние и bare-клон — `/var/lib/synapse-autosync`,
журнал — `/var/log/synapse-autosync/autosync.log` (logrotate, 8 недель), блокировка —
`/run/synapse-autosync/lock`.

Проверки перед выкладкой: все check-runs коммита на GitHub завершены с success/neutral/skipped
(запрос без токена, только для нового коммита; ожидающий перепроверяется не чаще раза в 5 минут);
симлинки и подмодули не выкладываются; путь проверяется через realpath; `node --check`
для JS, если на хосте есть node (на synapse-core node нет — синтаксис проверяет обязательный CI).
После выкладки пишется `cabinet/shell-version.json` `{"commit": "<sha>"}` — его читает оболочка
кабинета (PR 519); из репозитория этот файл не выкладывается. Копий хранится 10 последних.

## Остановить / откатить

```sh
systemctl disable --now synapse-autosync.timer          # выключить автовыпуск
cat /var/lib/synapse-autosync/state.json                 # что выложено, где копия, состояние CI
# ручной откат последнего выпуска: вернуть файлы из <копия>/files, удалить файлы с existed=false из manifest.json
```

## Тест

`python3 -m unittest ops/autosync/test_autosync.py` — правила трёх сторон, пропуск
локальной правки, белый список, откат при провале проверки, отсутствие повтора, shell-version.json,
симлинки, ожидание и отказ CI, STOP только при смене состояния (6 тестов).
