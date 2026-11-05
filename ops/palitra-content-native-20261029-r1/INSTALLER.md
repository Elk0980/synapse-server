# Palitra: встроенный контент — bounded CRM-only installer

Кодовый кандидат в отдельной приватной папке. Сервер/браузер/контейнеры этой подготовкой не затронуты. Root остаётся единственным production writer. Namespace: `palitra-content-native-20261029-r1`.

## Закрытая область

Два существующих host-source файла `/opt/synapse/ops/crm/autoposting.js` и `server.js` плюс их единственный overlay в `/app` нового дочернего CRM image. Fresh prepare требует **одинакового before SHA у host-source, работающего runtime и immutable parent image**. Несовпадение — STOP, без установки старого checkout поверх свежего кода. CRM должен иметь только прежний RW `/data` mount; source bind отвергается, чтобы он не скрыл image overlay.

Девять static файлов в `sites/synapse/cabinet/palitra-orders/`: `cabinet.html`, `native-host.js`, `shell.js`, `palitra-content-tasks-ui.js`, `palitra-publication-composer.js`, **новые** `palitra-content-material-ui.js`, `palitra-content-material-ui.css`, `palitra-content-plan-ui.js` и `palitra-content-plan-ui.css`. Main shell CSS и composer CSS не входят. Новые четыре файла обязаны отсутствовать включая broken symlink. Scope и порядок manifest фиксированы в `SCOPE`; добавочные файлы и поля запрещены.

## Что наследуется и что не копировалось

Использованы проверенные принципы CRM-only/one-layer/fulltree/effective-compose из Avocado R5 и принятого `/tmp/pc-i4.py`. Этот helper самостоятельный: **не загружает прежние приватные reader-контракты**, не требует старых образов/Compose source pins и не переносит ledger DDL, миграции, email admission/seal, dormant-job исключения или настройки рассылок. Legacy blocking scripts/condition и disabled/inactive timer должны остаться точными и проверяются до/после. Их принятую SHA этот кандидат сохраняет, не выполняет scripts.

## Сборка пакета — Root

1. Fresh own lease и действующая политика единственного писателя. Старая53999 или55317 не доказывает нынешнее владение.
2. Root лично читает actual running-image hashes, целевые функции/экспорт/GET-route и контекст, проверяет совпадение host/runtime/image. При отличии от checkout кандидат строится из fresh bytes: только уникальные точные literal replacements, input/output SHA, подтверждение byte-exact сохранности вне patch. Полный старый `server.js` не устанавливать.
3. Подготовить два локальных reviewed snapshot-корня с полными target-relative путями. В before нет четырёх NEW. JSON пяти фактических image ID содержит только `containerName: sha256:...`, никаких Env/credentials.
4. `python make_manifest.py BEFORE_ROOT AFTER_ROOT IMAGE_IDS_JSON manifest.json`. Генератор не доказывает смысл root-review: запускать после личной проверки merged diff. `helperSha256` должен соответствовать окончательному `install.py`. Перенести только eleven code payload paths под `payload/`, manifest, helper и offline tests в новый immutable code-only commit. Никаких фотографий, private BASE/backup/отчётов/реальных данных в Git.

## Native процесс

`stage COMMIT MANIFEST_SHA` → `prepare` → **один** `apply` → отдельный `inspect`.

Stage проверяет immutable commit, точные manifest/helper/payload pins и bytes, до создания AREA собирает весь закрытый payload. Prepare проверяет ancestor flock PID/startTicks, пять ожидаемых image ID, полный runtime/image tree, startup/Node hook profile, full effective Compose каждой текущей цепочки и фактического config-hash. В свежем BASE сохраняются исходные file/parent metadata, полные container configs/mounts/network и guards.

**BASE и online SQLite backup приватные, mode0700/0600; они могут содержать конфигурацию и клиентские данные. Не публиковать и не передавать внешним моделям.** Public payload содержит только код.

Queue guard читает существующую БД через `mode=ro`, `query_only=ON`, требует quick_check и нулевые изменения соединения. Отказывает любой unsent email, publishing post/delivery и scheduled post, который наступит до fixed expiry+600секунд либо имеет некорректную дату. Никаких очисток, переназначений, сдвига nextDue, admission flags или выключения отправки ради окна. В отказе — только счётчики, без ID/получателей. Схема и хеши **всех** старых строк сохраняются, любое расхождение требует inspect/нового review. Это консервативная модель: легитимная параллельная запись тоже остановит релиз, но не будет затёрта.

Protected backup использует SQLite backup API с **readonly source**, проверяет точную схему/строки в отдельной копии, без DB restore и без DDL. Полные guards выполняются до/после backup; progress проверяет только permit/lease/BASE, чтобы не запускать контейнерные probes на каждой странице.

Build — один новый локальный CRM child от фактического parent, закрытый tar ровно двух runtime файлов, `--network=none --pull=false`. Проверяются прежний layer prefix, ровно один слой, неизменный image Config и весь child tree. В новый Compose overlay добавляется только `crm.image`; config hash четырёх посторонних сервисов и их контейнеры целиком неизменны. Единственный lifecycle вызов: `up --detach --no-build --pull never --no-deps crm`. Никакого full deploy/старого sync/build других сервисов/pull.

После подтверждённого нового CRM и full guards сначала публикуются четыре новых static asset, затем два host-source и остальные JS, **HTML последним**. Существующие mode/owner сохраняются, NEW0644/root:root. New publication атомарно no-clobber, existing CAS, fsync directory и SHA readback. Каждая возвращённая публикация имеет отдельный journal marker. При неизвестном исходе apply/up не повторяются.

`inspect` заново проверяет running/image tree, host files, static metadata/SHA, whole price, unrelated static, policy, DB identity/schema/rows/queue, весь effective Compose и четыре посторонних контейнера. Возможна новая свежая собственная lease для readonly inspect после исходного TTL; apply permit не продлевается.

## Отчёт и откат

**Ровно один реальный restart/recreation CRM**, остальные сервисы0. Прямые DB/schema/settings/auth writes установщика0. Это **не равно доказанному отсутствию побочных действий демонов**: CRM при старте запускает email/autoposting, другие интервальные workers тоже могут менять данные. Queue/DB guards выявляют такие изменения и останавливают дальнейшую установку; они не отключают workers и не возвращают БД.

Автоматического rollback нет. Этот кандидат намеренно не предлагает команду, которая по неизвестному исходу перезапустит прежний worker. При сбое сначала Root читает attempt/child/up/published markers и actual state. Предпочтителен bounded forward fix на свежей базе. Отдельный code-only rollback допускается только после нового точного review: прежний immutable CRM image, CAS собственных exact-after host/static, та же схема/старые строки/пустые активные очереди и неизменные другие контейнеры; **никогда DB restore**, replay старого apply или изменение реальных posts/настроек. Если нужен готовый rollback-helper, он должен быть отдельным reviewed namespace, а не автоматическим продолжением этого apply.

## Проверки и границы

`python -m unittest discover -s . -p 'test_*.py' -v`; `python -m py_compile install.py make_manifest.py`.

Fixtures проверяют реальные временные файлы/SQLite readonly/backup, полный modeled pipeline, closed stage/tar/build command, one-layer/config refusal, single CRM up, HTML last, каскад отказов при изменении source/image/foreign state/БД/цен/lease/TTL/очередей и неизвестном up. Docker/systemctl/network/image tree наблюдения — mocks. На Windows POSIX owner/mode/chown/fsync-dir смоделированы; production safe_read оставляет Linux fd/path inode/ctime CAS, в Windows fixture чтение проверяется без несовместимого ctime. Это не Linux/native/live/physical-phone доказательство. Root должен независимо проверить merged helper, реальный payload, actual native bindings и живой UI.

## Последнее расширение scope

Добавлены только два NEW plan UI assets. Runtime2 прежние, static9, NEW4. `DIFF_FROM_88D4_BASE.patch` содержит точный helper diff от принятой исходной SHA88d4fb9c65f49f474fe0d4343ff7008abb0764ec12b92ac4c5d8e6dfd26e95b5; все guard функции сохранены. Старый helper snapshot локально `install.before-plan-scope.py`; он не является новым установщиком и не должен публиковаться/запускаться вместо актуального install.py.
