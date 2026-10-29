# Private executable candidate — durable content-only R2

Root — единственный native/browser/production writer. Этот каталог содержит только код для review и offline fixtures. R2 — отдельный namespace, frozenR1 не переписывается. Агент не запускал Docker, native/server/browser/API/Git/shared-source, не менял DB/очереди/flags/env/mounts, не создавал агентов/чаты/таймеры. Нет manifest.json и deployment permit. Synthetic PASS не доказывает native readiness.

Namespace: `palitra-customer-content-durable-20261030-r2`. Актуальные полные SHA перечислены в SHA256.json. FILE_PINS helper закрывает ровно6 targets, after уже Root-reviewed: scoped account23a0 / factoryf36f, chat1a392 / adaptera727, SHOPshellb39d, widgetR25752. Unscoped95767 и старыйwidget80aa исключены. Main managed v332, прайс, attentionV2 не входят в image.

## Что закрыто и что ещё требуется

Три прежних placeholder-блокировки устранены конкретным кодом/доказательствами:

- Scoped account/factory frozen; defaultmandatory сохраняется для foreign generic drafts, true лишь internal Palitra isShop+approved-origin branch. Отдельный реальный factory regression включён в test_install.py.
- Source inventory Root-reviewed и native-existence подтверждены descriptor `inventory-review.json` SHA8e2fb66d88cc1da78e297219068a7b924a94860c20b66042a52fac960c103311. Это НЕ deployment permit. Fresh discover/stat/schema/all rows/backup guards повторяются native; лишний/пропавший/aliased DB отказывает.
- Economy guard реализует source-exact warning projection и fixed opaque credential selection. Не импортирует app/factory/monitor/refresh и не делает API. Любые unknown/schema/cache/alert-transition отклоняются; нет override/manual true-флага.

Остались обязательные реальные входы: свежая собственная lease, exact current5images и66-file Compose chain, parentimage/appdiff0/full tree; exact source/managed/static/price pins; свежие DB inventory/schema/rows и очереди; native vault/cache/window guard; protected backups; child image/layer proof; independent inspect. Старые COUNTS2/3/screenshots не permit. Final manifest собирает Root только после fresh5images/inventory; старые apply не replay.

## Закрытый механизм

`install.py stage COMMIT MANIFEST_SHA`, затем `prepare`, `build`, `apply`, отдельный `inspect`.

Stage требует own ancestor lease и скачивает только immutable public code, verified helper/manifest/payload/guard hashes; server release создаётся новым private каталогом. Нижняя process-граница допускает закрытый allowlist, no shell/arbitrary node/app startup/other-service restart/down/pull. Timeout≤180с, RLIMIT_FSIZE/bounded stdout/stderr; probe≤10с и freshness≤5с.

Prepare: actual `/app` без covering mounts и точное совпадение pristine local base `sha256:9a1ab665339b10a49a49d8c605075ae701e4b28a9db1a3bb3ec49483fd8e6f44`. Full tree включает directory/file metadata, nlink/content SHA. Полная текущая config chain до100files (actual66) и все5container identities/images/config/mounts/network/restart-state фиксируются. Native `/data` inventory — content.sqlite, salon-reports.sqlite, fixed Palitra private draft-accounts.sqlite; CRMcrm.sqlite в другом volume. Generic extra account DB неожиданно появляется — отказ, не игнорирование.

Build: pinned local parent alias, noRUN/npm, onlyADD tar ровно6 regular paths с прежними metadata; networknone/pullfalse. Parent Config exact; ancestry prefix+1. Full child `/app` и весь добавленный DiffID layer проверяются, включая outside-app/whiteouts/links/devices/duplicate/traversal/PAX. Unknown Docker image export format отказывает. Image-only Compose overlay последний, allowed config delta только content.image; forward plan пересчитывается перед up. CRM/Hugh/chat/Caddy не recreate.

Backups: readonly/query_only consistent SQLite backup в новые private release files; preserve logical schema/all rows/sqlite_sequence/source inode и backup SHA. No restore/DDL/UPDATE/claim/ack/send. Full managedv332 manifest/files/currentrevision, full static/site resources, priceversion/fullSHA, policies/legacydisabled scripts проверяются до/после. Легитимное параллельное изменение вызывает отказ, не перезапись. Ограничения:500krows/DB,5000schema rows,64MiB file/cell/backup,2GiB image archive,8MiB layer payload.

Journals O_EXCL+fsync: prepareTTL900с; bounded apply120с+startupmargin60с. Один build intent и один apply intent. Unknown timeout/error означает inspect-only. Independent inspect не доверяет installed.json; различает before/no-replay/after и повторно проверяет tree/config/layers/DB/data. Новая readbacklease послеTTL не возвращает write permit. DB rollback отсутствует.

## Economy и opaque probe

`economy_projection.py` читает только schema/metadata/aggregate arithmetic внутри readonly SQLite. Не возвращает расходы/суммы/балансы/config/ключи/ciphertext. Exact4 source hashes в reviewed-source-pins.json сравниваются с actual native tree. Source-extracted oracle исполняет только pure functions на synthetic fixtures; никаких factories.

`vault_probe.cjs` — отдельный фиксированный readonly Node stdlib crypto/SQLite computation в уже работающем parentcontent. Exact `/app/hugh-providers.js`6464ac246aa197ef8f9f197a332eed5d2b27f0acda445b08f89192c660514141 проверяется целиком; crypt/runtimeReport/checkBaseUrl/checkCurrent и balance-account callback source-checked. Master key остаётся внутри контейнера в existing env, plaintext только transient; derived key обнуляется, secret refs очищаются. Не выводятся ключи, ciphertext, индивидуальные key-hashes, суммы или plaintext. App modules не require; encrypt/refresh/API/factory никогда не вызываются.

Выход: provider→canDecryptAndPassRuntimeSelection, DeepSeekcanUseBalanceAccount, sourceSHA, timestamp, nonce-bound whole-settings aggregate binding, DB/WAL metadata. Runtime requires checkCurrent, balance callback его не требует — отдельные booleans необходимы. Wrongkey/corrupt envelope дают exact sourcefalse; отсутствующий/плохой source/schema/path/proof полностью отказывает. Empty decrypted string не отбрасывается самовольно.

Binding R2: каждый probe получает новый os.urandom nonce64hex, fixed exact code+один constrained argv, scope DBpath/source/parentCID/Image/Config/actual env проверяется. ОДИН HMAC-SHA256 полного canonical settings rowset (включая encrypted_key identity только внутри computation), key=public freshnonce, domain=`palitra-vault-snapshot/v2\n`. Это не индивидуальный key hash; plaintext, ciphertext, raw rows, amounts не возвращаются. Scalars допускаются только string/null/safeinteger; keys сортируются ordinal, rows по exact SQLite name. Python сравнивает MAC с тем же BEGIN snapshot, в котором читает economy+queues; затем независимый fresh readonly settings readback подтверждает отсутствие relevant change. Config/cipher change даже с прежней revision отказывает. Nonce-bound proof однократен, process-local issued registry; modified/replayed/missing/expired proof не принимается. Node source hash проверяется до/после crypto; parent/config/env до/после projection.

DB/WAL presence/dev/ino, regular/nlink/no-symlink сохраняются. Size/timestamps допускается менять **ТОЛЬКО на RO probe boundary** при совпадении exact scope MAC; SHMidentity сохраняется, missing sidecars для WAL-mode отказывают. Это исправляет nativeR1 standalone отказ, диагностированный только WALctimeNs при unchanged size/dev/ino/mtime и total_changes0. Writer не выдумывается. FrozenR1 и diagnostics не изменены.

WholeDB сохранность не подменяется MAC. Все прежние db_facts/assert_database/backup/prepare/apply алгоритмы сохранены. В base_guard дополнительно повторяется full assert_database+inode ПОСЛЕ startup_guard: поздний unrelated business/queue write по-прежнему отказывает до up. Relevant-scope MAC может пройти на unrelated-table WALwrite, но whole release на новых businessrows не проходит. Не вводятся DB locks/worker pause/queue mutation/manual attestation.

Guard проверяет no refresh через entire apply+margin window: cache revision/attempt/CACHE10min, wallet stale30min, budgetwindow reset, cooldown expiry, current60minreviewslot. Cache JSON metadata строго rootobject/available+balances/balancesarray/no duplicate/override keys; это исключает hidden spreadstatus/stale override. Любое warning-state изменение, включая active→false, отклоняется; olduncertain не retry permit. Native booleans сужают runtime-ready точно; без свежего bound proof helper не исполняет проекцию. Нет ручной attestation для разрешения.

## Native следующий readonly шаг Root

После code review и проверки SHA256.json выполнить **ровно fixed** `vault_probe.cjs` + `\nmain();` через аргументный `docker exec <fresh verified current contentCID> node -e <exact code> <fresh nonce64hex>`, timeout10. Код не менять/не выполнять произвольный require, не выводить process.env. Перед этим fresh native image/source/config/DATABASE_PATH сверить; это не app restart и не stage/apply. Ответ должен содержать только описанные safe booleans/bindings. Даже успешный standalone probe не заменяет fresh probe внутри prepare/pre-up.

`make_manifest.py FRESH_FIVE_IMAGES_JSON SOURCE_REVIEWED_DB_INVENTORY_JSON OUTPUT` проверяет6payload+inventory и создаёт новый файл; inputs не являются доказательством livefreshness, native helper сверяет заново. Schema1: packageId/status/helperSha256/expectedImages (ровно5)/files (ровно6target,beforeSha256,afterSha256,bytes)/databaseInventory (sourceReviewSha256,contentPaths,crmPaths). Finalmanifest здесь не создан.

## Offline проверки

- `python test_install.py` —32tests, real tempfiles/SQLite/tar, Docker/lease modeled; включая scope/failclosed/layer/unknown.
- `python test_economy_projection.py` —10tests,192 source-extracted conformance cases плюс opaque/shape/cache/window.
- `python test_vault_binding.py` —9tests, real SQLite + fixed crypto-selector + real Python projection, full-cipher/config mismatch, unrelated-write scope proof + wholeDB refusal, late-write fence, nonce replay/mismatch/expiry/parent/env/source/identity.
- `node --test test_vault_probe.cjs` —10tests, synthetic AES-GCM/HKDF keys only; stalecheck/balance distinction, wrongkey, corrupt envelope, host/contract, empty secret, sourcepin, full HMAC config/cipher/nonce binding.

Итого61tests (без повтора full suites account/widget, Root их проверил52 отдельно). Все тесты обязательны после finalfreeze. Ни один native effect ими не выдан за проверенный.
