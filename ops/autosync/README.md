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

Проверка синтаксиса JS выполняется для всего набора до первой замены. Если хотя бы
один разрешённый JS не прошёл проверку (ошибка синтаксиса, нет node или превышен
лимит 5 МиБ), коммит целиком отклоняется: CSS/JSON,
остальные JS и `shell-version.json` не активируются, выложенный commit в state не
меняется. Сохраняется только отказ `lastError`; этот HEAD повторно не проверяется
до следующего merge. Локальные правки и остальные ограничения сохраняются.
Размер нового файла проверяется по метаданным Git до чтения содержимого. Слишком
большой JS блокирует весь набор; слишком большой файл другого типа пропускается.
Расширения `.js`, `.cjs`, `.mjs` проверяются без учёта регистра, включая `.JS` и `.MJS`.
Публичные корни `cabinet`/`brand` готовятся при установке. Новые вложенные каталоги
создаются по одному с явными правами `2775`, независимо от UMask службы; существующим
и приватным каталогам скрипт права не меняет.

Журнал: `/var/log/synapse-autosync/autosync.log`. Статус: `state.json` (commit, время,
выложенные файлы, пропуски, путь копии).

Ограничение: версия ассетов (`SB_CABINET_ASSET_VERSION` в `cabinet.html`) скриптом не
меняется. Если изменился уже загруженный браузером файл, без новой версии он может
подхватиться не сразу (кэш браузера). Новые файлы видны сразу.

## Установка (root). Таймер включать только после защиты main (№57)

На хосте обязателен `node` для `node --check`. Node ставится только из штатного
репозитория Ubuntu (`apt-get install nodejs`, 24.04 → 18.19.1; решение Влада 05.11.2026);
внешние репозитории и ключи не добавлять. Перед включением таймера обязателен
`sandbox-smoke.sh`: он запускает `node --check` и `git` по https с ограничениями юнита.
Без него запрет системного вызова (например, `pkey_alloc` у V8 без `@pkey`) проявился бы
только на первом настоящем PR: каждый коммит с JS отклонялся бы как `js-preflight`.

Пока `main` не защищён (№57: обязательные проверки, без прямых push), любой, кто может
писать в `main`, сможет выложить статику кабинета. Поэтому до №57 ставится всё, кроме
`enable --now` таймера.

```sh
apt-get install -y --no-install-recommends nodejs
command -v node >/dev/null && node --version || { echo 'STOP: требуется node для проверки JS'; exit 1; }
SHA=<принятый merge-коммит>; RAW=https://raw.githubusercontent.com/Elk0980/synapse-server/$SHA/ops/autosync
useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin synapse-autosync
install -d -o root -g root -m 755 /usr/local/lib/synapse-autosync
install -d -o synapse-autosync -g synapse-autosync -m 700 /var/backups/synapse-autosync
curl -fsSL $RAW/synapse-autosync.py -o /usr/local/lib/synapse-autosync/synapse-autosync.py
chown root:root /usr/local/lib/synapse-autosync/synapse-autosync.py && chmod 755 /usr/local/lib/synapse-autosync/synapse-autosync.py
curl -fsSL $RAW/synapse-autosync.service -o /etc/systemd/system/synapse-autosync.service
curl -fsSL $RAW/synapse-autosync.timer -o /etc/systemd/system/synapse-autosync.timer
curl -fsSL $RAW/synapse-autosync.logrotate -o /etc/logrotate.d/synapse-autosync
curl -fsSL $RAW/sandbox-smoke.sh -o /usr/local/lib/synapse-autosync/sandbox-smoke.sh
# запись в каталоги статики через группу (ACL на сервере не установлен); файлы остаются root:root 644
for d in /opt/synapse/sites/synapse/cabinet /opt/synapse/sites/synapse/brand; do
  find "$d" -type d -exec chgrp synapse-autosync {} + -exec chmod 2775 {} +; done
systemctl daemon-reload
systemd-analyze security synapse-autosync.service | tail -1     # цель ≤ 3.5
sh /usr/local/lib/synapse-autosync/sandbox-smoke.sh              # нужна строка SANDBOX OK
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
для всех JS/CJS/MJS обязателен на хосте; отсутствие node отклоняет весь коммит.
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
симлинки, ожидание и отказ CI, STOP только при смене состояния, отказ всего набора
при ошибке JS и успешная активация валидного набора, однократная запись повторяющейся
ошибки (symlink на пути) и `RECOVERED` после её устранения. Реальный `node --check`
обязателен в Linux CI; в локальной среде без node соответствующие тесты пропускаются.
CI-задача `sandbox` ставит Node из apt (как на хосте) и прогоняет `sandbox-smoke.sh` с юнитом,
а также проверяет, что без `@pkey` проверка падает.
