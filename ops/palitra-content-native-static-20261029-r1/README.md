# Встроенный контент: отдельный static-only пакет

Namespace `palitra-content-native-static-20261029-r1`. Это **отдельный** bounded UI release, а не изменение отказавшего runtime-helper или обход его queue guard. Старый `palitra-content-native-20261029-r1` prepare завершился отказом emails1, apply/restart/static0; его stage/apply/очередь не повторять и не менять. Два backend patch остаются отложены. Root — единственный production writer.

## Закрытый scope

Ровно девять файлов в `sites/synapse/cabinet/palitra-orders/`:

- Existing5: `cabinet.html`, `native-host.js`, `shell.js`, `palitra-content-tasks-ui.js`, `palitra-publication-composer.js`.
- NEW4: `palitra-content-material-ui.js`, `palitra-content-material-ui.css`, `palitra-content-plan-ui.js`, `palitra-content-plan-ui.css`.

Runtime source paths, mainCSS/composerCSS, DB и очередь не входят. Fresh before — действующий `INLINE_BASELINE`; after — отдельно принятый `INLINE_MERGED`, с честным profileunknown: работа с актуальными posts, серверный409PROFILE_CHANGED для старых сохраняет ввод. Static-only установка не подтверждает полную миграцию profile context.

## Основа и неизменные guards

Принятый smooth helper SHA `70a44c17429bc6a60c2ff71386d59afdac6b320227954ae1b45092d6c93fd022`: его `environment`, `lease`, `mount_digest` перенесены **побайтово**, без сокращения. New-target семантика — проверенный предыдущий static-only helper: отсутствие включая broken symlink, parent metadata, новый файл0644/root:root, атомарный no-clobber, backup только existing5, before/after CAS/readback. Новый manifest дополнительно требует exact fresh five image IDs, закрытые поля/targets и helper pin. HTML публикуется последним, NEW4 первыми.

Сохраняются весь прайс (полный SHA/version), прочие static HTML/JS/CSS, managed-policy, Caddy/Compose и actual ID/image/config/host/mounts пяти контейнеров. Legacy sync остаётся inactive. БД не открывается, поэтому queue guard здесь не вызывается: у пакета **нет runtime/lifecycle действий**, способных запускать CRM worker. Unsent email остаётся как был.

`command()` имеет точный allowlist только `lslocks --json --output PID,PATH` и `docker inspect` ровно пяти контейнеров. Любые `docker up/build/run/exec`, shell или mutating systemctl отвергаются. Единственный прямой subprocess.run — literal `systemctl is-active synapse-sync.timer`. В коде нет sqlite3, DB-функций, runtime path, build/up/rollback mode. Это проверяется fixtures/AST, а не только объявлением в README.

## Сборка и установка — только Root после review

1. Прочитать свежую основу и full UI diff; сохранить все данные/черновики/согласования. Проверить, что NEW4 ещё отсутствуют. Старая lease55317 свободна, но это не доказывает текущее окно; текущую56046 считать своей только по свежему native own-ancestor proof.
2. `python -B make_manifest.py INLINE_BASELINE INLINE_MERGED INLINE_IMAGE_IDS.json manifest.json`. Два snapshot-каталога **плоские**, с basename файлов. Manifest schema использует `targets` (не runtime `files`), exact nine target order, `beforeSha256:null` только NEW4; helper pin берётся окончательный. Expected images — пять actual fresh ID, без Env/секретов.
3. Payload под `payload/` содержит **только девять target-relative путей**. Backend files туда не копировать. Новый code-only immutable commit/manifest/helper pins; никакого private BASE/report/source collection/DB/credentials в Git.
4. Под fresh own ancestor lease: отдельный `stage COMMIT MANIFEST_SHA`, `prepare`, **один** `apply`, отдельный `inspect`. Prepare делает fresh BASE/точный backup, action900секунд. Guard требует ту же lease и неизменные изображения/config/price/static. При неизвестном исходе не повторять apply.
5. Независимый native readback и публичные exact GET/старые query, затем безопасная live UI проверка. После — только свою lease освободить и прочитать отсутствие. Пользовательскую незавершённую форму не перезагружать.

Runtime writes0, DB reads/writes0, schema/auth/settings/price writes0, service restarts0. Нет автоматического rollback; неопределённое состояние сначала читать. Отказавший runtime-пакет и исторические apply не переигрываются.

## Проверки и границы

`python -B -m unittest discover -s . -p test_install.py -v`; `python -B -m py_compile install.py make_manifest.py`.

Fixtures проверяют closed stage/pins, exact image IDs, fresh metadata/backup/expiry/lease/environment, атомарную защиту new collision, статический readback/oneattempt/HTMLlast, отсутствие DB/runtime/lifecycle capabilities. В Windows POSIX mode/chown/fsync-dir смоделированы; две реальные symlink fixtures требуют Windows privilege и могут быть SKIP, отдельный symlink unit проходит. Docker/systemctl/network наблюдения mocks; это не native/live/phone приёмка. Root отдельно принимает product profileunknown поведение и public manifest/payload.
