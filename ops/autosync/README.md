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

Журнал: `/var/log/synapse-autosync.log`. Статус: `state.json` (commit, время,
выложенные файлы, пропуски, путь копии).

Ограничение: версия ассетов (`SB_CABINET_ASSET_VERSION` в `cabinet.html`) скриптом не
меняется. Если изменился уже загруженный браузером файл, без новой версии он может
подхватиться не сразу (кэш браузера). Новые файлы видны сразу.

## Установка (root, одна команда на каждый шаг)

```sh
SHA=<принятый merge-коммит>; RAW=https://raw.githubusercontent.com/Elk0980/synapse-server/$SHA/ops/autosync
install -d -m 755 /opt/synapse-autosync /var/lib/synapse-autosync /var/backups/synapse-autosync
curl -fsSL $RAW/synapse-autosync.py -o /opt/synapse-autosync/synapse-autosync.py && chmod 755 /opt/synapse-autosync/synapse-autosync.py
curl -fsSL $RAW/synapse-autosync.service -o /etc/systemd/system/synapse-autosync.service
curl -fsSL $RAW/synapse-autosync.timer -o /etc/systemd/system/synapse-autosync.timer
touch /var/log/synapse-autosync.log
python3 /opt/synapse-autosync/synapse-autosync.py --init   # текущий main = база, ничего не выкладывается
systemctl daemon-reload && systemctl enable --now synapse-autosync.timer
```

Сверить sha256 скачанных файлов с файлами этого коммита до `--init`.

## Остановить / откатить

```sh
systemctl disable --now synapse-autosync.timer          # выключить автовыпуск
cat /var/lib/synapse-autosync/state.json                 # что выложено и где копия
# ручной откат последнего выпуска: вернуть файлы из <копия>/files, удалить файлы с existed=false из manifest.json
```

## Тест

`python3 -m unittest ops/autosync/test_autosync.py` — правила трёх сторон, пропуск
локальной правки, белый список, откат при провале проверки, отсутствие повтора.
