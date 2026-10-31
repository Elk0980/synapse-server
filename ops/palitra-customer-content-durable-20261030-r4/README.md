# Private executable candidate — durable content-only R4

Root — единственный native/browser/production writer. Этот каталог содержит только код для review и offline fixtures. R4 — отдельный namespace; frozenR1/R2/R3 не переписываются, старые stage/prepare/build/apply не повторяются. Агент не запускал Docker, native/server/browser/API/Git/shared-source, не менял DB/очереди/flags/env/mounts, не создавал агентов/чаты/таймеры. Нет manifest.json и deployment permit. Synthetic PASS не доказывает native readiness.

Namespace: `palitra-customer-content-durable-20261030-r4`. Актуальные полные SHA перечислены в SHA256.json. FILE_PINS helper закрывает ровно6 targets, after уже Root-reviewed: scoped account23a0 / factoryf36f, chat1a392 / adaptera727, SHOPshellb39d, widgetR25752. Unscoped95767 и старыйwidget80aa исключены. Main managed v332, прайс, attentionV2 не входят в image.

## Что закрыто и что ещё требуется

Три прежних placeholder-блокировки устранены конкретным кодом/доказательствами:

- Scoped account/factory frozen; defaultmandatory сохраняется для foreign generic drafts, true лишь internal Palitra isShop+approved-origin branch. Отдельный реальный factory regression включён в test_install.py.
- Полный source inventory Root-reviewed и native статусы/sidecars подтверждены descriptor `inventory-review.json` SHA68998c94bb34426777b8199d86d02daebe33f25120711f542f825a9778983ec1. Exact10content+CRM1; active3+CRM consistentSQL, fixed7retained copies opaque. Это НЕ deployment permit. Fresh discover/stat/schema/all rows/backup guards повторяются native; лишний/пропавший/aliased DB отказывает.
- Economy guard реализует source-exact warning projection и fixed opaque credential selection. Не импортирует app/factory/monitor/refresh и не делает API. Любые unknown/schema/cache/alert-transition отклоняются; нет override/manual true-флага.

Остались обязательные реальные входы: свежая собственная lease, exact current5images и66-file Compose chain, parentimage/appdiff0/full tree; exact source/managed/static/price pins; свежие DB inventory/schema/rows и очереди; native vault/cache/window guard; protected backups; child image/layer proof; independent inspect. Старые COUNTS2/3/screenshots не permit. Final manifest собирает Root только после fresh5images/inventory; старые apply не replay.

## Закрытый механизм

`install.py stage COMMIT MANIFEST_SHA`, затем `prepare`, `build`, `apply`, отдельный `inspect`.

Stage требует own ancestor lease и скачивает только immutable public code, verified helper/manifest/payload/guard hashes; server release создаётся новым private каталогом. Нижняя process-граница допускает закрытый allowlist, no shell/arbitrary node/app startup/other-service restart/down/pull. Timeout≤180с, RLIMIT_FSIZE/bounded stdout/stderr; probe≤10с и freshness≤5с.

Prepare: actual `/app` без covering mounts и точное совпадение pristine local base `sha256:9a1ab665339b10a49a49d8c605075ae701e4b28a9db1a3bb3ec49483fd8e6f44`. Full tree включает directory/file metadata, nlink/content SHA. Полная текущая config chain до100files (fresh Root native actual68; новый overlay даст69) и все5container identities/images/config/mounts/network/restart-state фиксируются. Native `/data` inventory — exact10content+CRM1. ActiveSQL: content.sqlite, salon-reports.sqlite, fixed Palitra private draft-accounts.sqlite, CRMcrm.sqlite в другом volume. Fixed7retained copies перечислены в OPAQUE_ARCHIVE_PATHS и descriptor: никаких wildcard exclusions, extra/missing .sqlite отказывает. Root metadata: mainarchives0600/uidgid0/nlink1, largest21,671,936B; existing sidecars только у трёх copies (0B WAL +32768B SHM), у четырёх отсутствуют. Main/sidecar presence/stat/bytes/mode по final descriptor сверяются fresh; не изменяются.

Ни один opaque archive или его backup НИКОГДА не открывается через SQLite: header0202 без WAL/SHM делает engine-open опасным созданием sidecars. Существующий механизм расширен одним fixed-path branch: regular/root/nlink/noalias/bound≤64MiB, raw header толькоmain, SHA каждого main+existingwal/shm, inode и metadata (mode/uid/gid/nlink/mtimeNs/ctimeNs), absence тоже фиксируется. Opaque raw bytes сохраняют все schema/rows/virtual bytes и sidecars сильнее пересоздания через engine. Raw EXCL backups0600 под private release, fsync/hash/source-before-after; при drift отказ/inspect, не restore/retry. Existing0Bwal копируется как0B, absent sidecars не создаются. Backup manifest прежний path+SHA, raw physicalfiles добавлены плоскими keys.

SQL active3+CRM сохраняют прежние query_only consistentbackup/quick_check/schema/allrows/sqlite_sequence. Startup/economy/queues/managed читают только activecontent/CRM; raw archives не участвуют в startup projections. Все prepare/build/apply/independentinspect phase guards охватывают union activeSQL+opaque, включая post-startup full preservation fence. Generic extra DB либо sidecar addition/removal/size/identity/content/metadata drift — отказ. Нет archive subsystem/recovery/migrations/DDL/очистки копий.


Build: pinned local parent alias, noRUN/npm, onlyADD tar ровно6 regular paths с прежними metadata; networknone/pullfalse. Parent Config exact; ancestry prefix+1. Full child `/app` и весь добавленный DiffID layer проверяются, включая outside-app/whiteouts/links/devices/duplicate/traversal/PAX. OCI и legacy export проверяются отдельным pinned stdlib auditor ниже; unknown format отказывает. Image-only Compose overlay последний, allowed config delta только content.image; forward plan пересчитывается перед up. CRM/Hugh/chat/Caddy не recreate.

Backups активных DB: readonly/query_only consistent SQLite backup в новые private release files; preserve logical schema/all rows/sqlite_sequence/source inode и backup SHA. No restore/DDL/UPDATE/claim/ack/send. Rawarchive backups описаны выше. Full managedv332 manifest/files/currentrevision, full static/site resources, priceversion/fullSHA, policies/legacydisabled scripts проверяются до/после. Легитимное параллельное изменение вызывает отказ, не перезапись. Ограничения:500krows/DB,5000schema rows,64MiB file/cell/backup,2GiB image archive,8MiB layer payload.

Journals O_EXCL+fsync: prepareTTL900с; bounded apply120с+startupmargin60с. Один build intent и один apply intent. Unknown timeout/error означает inspect-only. Independent inspect не доверяет installed.json; различает before/no-replay/after и повторно проверяет tree/config/layers/DB/data. Новая readbacklease послеTTL не возвращает write permit. DB rollback отсутствует.

## OCI/legacy image archive auditor R4

Root native readonly preflight доказал: Docker29/containerd export содержит blobs/sha256, regular126, legacy*/layer.tar count0, compatRows1. Descriptor actualmediaOCIindex; image.Id равен indexdigest9a1ab, selected configdigest71d021 — другой. Selected configblob3404B, rawConfig.config==inspect.Config TRUE, raw rootfs.diff_ids==inspect.RootFS.Layers TRUE, runtimeLinux/amd64/Variantnull. Parent118layers, lastOCI tar+gzip12225B magic1f8b. Это факты Root, не nativeпроверка агента; Rootриски/счётчики не объявляются deploymentpermit.

`image_archive_audit.py` — pure stdlib filesystem/tar/json/zlib, ни network/dependencies/app/extractall. Helper проверяет точный moduleSHA перед import. Outer archive≤2GiB,200k unique canonical regular/dir entries, no links/devices/traversal. Metadata≤1MiB/JSONduplicates/nonfinite отказ; graph≤128nodes/depth4/32refs/index; selected≤256layers. Unknown graph/media/layout/platform/ambiguous selection отказывает.

OCI layout strict1.0.0. Из export index должен быть достижим точный child_info.Descriptor digest/mediaType/size; index Id не подменяется configdigest. В pinnedroot graph выбирается ровно один Linux/amd64/null runtime с exact fullRootFS+Config по actual inspect, configblob проверяется по своему digest/size. ImageId связан с pinnedroot digest либо actualconfigdigest; это не меняет strict build/IID authorization. Unknown/unknown Dockerattestations не выбираются и не исполняются, но их config/layer refs/hash/size проверяются пассивно. Unselected refs не дают выбрать чужой rootfs.

Каждый referenced blob локально существует с exact descriptor-size/hash. Selected lastblob поддерживает только explicit OCI/Dockerplain илиgzip mediaTypes; compressed≤16MiB, decoded≤8MiB. zstd/unknown decoder/multimember/truncated/corrupt/bomb отказ. Полный decoded SHA равен actualchildlastDiffID; хвост после tarEOF должен быть нулевым, затем вызывается **НЕИЗМЕНЁННЫЙ tar_members** со всеми sixpaths/metadata/content/outsideApp/whiteout/link/duplicate guards. Same full child/app tree, parentlayerprefix+1 и Config exact before/after остались.

Если compatmanifest.json есть, uniqueconfig+orderedLayers обязаны совпасть с выбранным OCI graph; legacy-only branch принимает pinnedconfig ID/plainlayer и те же fulltar guards. Native Root подтвердил lastCompatPath; wholeorderedPaths условие оставлено сильным и проверяется самим nativeauditor, без нового export preflight ради отдельного boolean.

Build/IID путь оставлен exact R3: неизвестный iidfile/imageId несовместимый результат должен отказать и перейти к readback, не выбирать случайный tag/другую image. Никаких новых build/run/up capabilities не добавлено. Archive export — privatecode artifact, default app никогда не запускается для probes.

## Economy и opaque probe

`economy_projection.py` читает только schema/metadata/aggregate arithmetic внутри readonly SQLite. Не возвращает расходы/суммы/балансы/config/ключи/ciphertext. Exact4 source hashes в reviewed-source-pins.json сравниваются с actual native tree. Source-extracted oracle исполняет только pure functions на synthetic fixtures; никаких factories.

`vault_probe.cjs` — отдельный фиксированный readonly Node stdlib crypto/SQLite computation в уже работающем parentcontent. Exact `/app/hugh-providers.js`6464ac246aa197ef8f9f197a332eed5d2b27f0acda445b08f89192c660514141 проверяется целиком; crypt/runtimeReport/checkBaseUrl/checkCurrent и balance-account callback source-checked. Master key остаётся внутри контейнера в existing env, plaintext только transient; derived key обнуляется, secret refs очищаются. Не выводятся ключи, ciphertext, индивидуальные key-hashes, суммы или plaintext. App modules не require; encrypt/refresh/API/factory никогда не вызываются.

Выход: provider→canDecryptAndPassRuntimeSelection, DeepSeekcanUseBalanceAccount, sourceSHA, timestamp, nonce-bound whole-settings aggregate binding, DB/WAL metadata. Runtime requires checkCurrent, balance callback его не требует — отдельные booleans необходимы. Wrongkey/corrupt envelope дают exact sourcefalse; отсутствующий/плохой source/schema/path/proof полностью отказывает. Empty decrypted string не отбрасывается самовольно.

Binding R2: каждый probe получает новый os.urandom nonce64hex, fixed exact code+один constrained argv, scope DBpath/source/parentCID/Image/Config/actual env проверяется. ОДИН HMAC-SHA256 полного canonical settings rowset (включая encrypted_key identity только внутри computation), key=public freshnonce, domain=`palitra-vault-snapshot/v2\n`. Это не индивидуальный key hash; plaintext, ciphertext, raw rows, amounts не возвращаются. Scalars допускаются только string/null/safeinteger; keys сортируются ordinal, rows по exact SQLite name. Python сравнивает MAC с тем же BEGIN snapshot, в котором читает economy+queues; затем независимый fresh readonly settings readback подтверждает отсутствие relevant change. Config/cipher change даже с прежней revision отказывает. Nonce-bound proof однократен, process-local issued registry; modified/replayed/missing/expired proof не принимается. Node source hash проверяется до/после crypto; parent/config/env до/после projection.

DB/WAL presence/dev/ino, regular/nlink/no-symlink сохраняются. Size/timestamps допускается менять **ТОЛЬКО на RO probe boundary** при совпадении exact scope MAC; SHMidentity сохраняется, missing sidecars для WAL-mode отказывают. Это исправляет nativeR1 standalone отказ, диагностированный только WALctimeNs при unchanged size/dev/ino/mtime и total_changes0. Writer не выдумывается. FrozenR1 и diagnostics не изменены.

WholeDB сохранность не подменяется MAC. Все прежние db_facts/assert_database SQLactive, prepare/apply и queue/economy алгоритмы сохранены; единственная bounded rawbranch дополняет сохранность fixed7archives. В base_guard дополнительно повторяется full assert_database+inode ПОСЛЕ startup_guard: поздний unrelated business/queue write по-прежнему отказывает до up. Relevant-scope MAC может пройти на unrelated-table WALwrite, но whole release на новых businessrows не проходит. Не вводятся DB locks/worker pause/queue mutation/manual attestation.

Guard проверяет no refresh через entire apply+margin window: cache revision/attempt/CACHE10min, wallet stale30min, budgetwindow reset, cooldown expiry, current60minreviewslot. Cache JSON metadata строго rootobject/available+balances/balancesarray/no duplicate/override keys; это исключает hidden spreadstatus/stale override. Любое warning-state изменение, включая active→false, отклоняется; olduncertain не retry permit. Native booleans сужают runtime-ready точно; без свежего bound proof helper не исполняет проекцию. Нет ручной attestation для разрешения.

## Native следующий readonly шаг Root

После code review и проверки SHA256.json выполнить **ровно fixed** `vault_probe.cjs` + `\nmain();` через аргументный `docker exec <fresh verified current contentCID> node -e <exact code> <fresh nonce64hex>`, timeout10. Код не менять/не выполнять произвольный require, не выводить process.env. Перед этим fresh native image/source/config/DATABASE_PATH сверить; это не app restart и не stage/apply. Ответ должен содержать только описанные safe booleans/bindings. Даже успешный standalone probe не заменяет fresh probe внутри prepare/pre-up.

`make_manifest.py FRESH_FIVE_IMAGES_JSON SOURCE_REVIEWED_DB_INVENTORY_JSON OUTPUT` проверяет6payload+inventory и создаёт новый файл; inputs не являются доказательством livefreshness, native helper сверяет заново. Schema1: packageId/status/helperSha256/expectedImages (ровно5)/files (ровно6target,beforeSha256,afterSha256,bytes)/databaseInventory (sourceReviewSha256,contentPaths (все10),crmPaths (один)). Finalmanifest здесь не создан.

## Offline проверки

- `python test_install.py` —32tests, real tempfiles/SQLite/tar, Docker/lease modeled; включая scope/failclosed/layer/unknown.
- `python test_economy_projection.py` —10tests,192 source-extracted conformance cases плюс opaque/shape/cache/window.
- `python test_vault_binding.py` —9tests, real SQLite + fixed crypto-selector + real Python projection, full-cipher/config mismatch, unrelated-write scope proof + wholeDB refusal, late-write fence, nonce replay/mismatch/expiry/parent/env/source/identity.
- `python test_image_archive_audit.py` —16tests, actual-style OCIINDEX/configdigest distinction+passiveattestation, gzip/plain/legacy, reference/config/rootfs/platform/identity/ambiguity, decompression bounds/corruption/hidden data, same scope callback.
- `python test_opaque_archives.py` —8tests, реальные raw files/EXCLcopies и запрет SQLiteopen; absent/presentwal/shm, drift/inode/bounds/review/backup. На Windows только safe_read fdctime reader заменён path-stability fixture, Linux production FD guards не менялись.
- `node --test test_vault_probe.cjs` —10tests, synthetic AES-GCM/HKDF keys only; stalecheck/balance distinction, wrongkey, corrupt envelope, host/contract, empty secret, sourcepin, full HMAC config/cipher/nonce binding.

Итого85tests (без повтора full suites account/widget, Root их проверил52 отдельно). Все тесты обязательны после finalfreeze. Ни один native effect ими не выдан за проверенный.
