# Palitra attention + account prefill delivery R10 — private candidate

Spec: specs/092-palitra-order-customer-forms (FR01/02/07/09). Root — единственный production/browser/native writer. Агент создаёт код и offline fixtures; native/server/browser/API/Git/shared writes0. manifest.json собран как ROOT_REVIEWED_CODE_ONLY из документированных5images; это не fresh native permit. FrozenR4 feature candidate, frozenR7 helper и прежние112 tests не изменены. Реализация и локальная проверка не являются установкой/личной live-приёмкой.

## Scope mapping

Новый parent только sha256:e22ca4d3892a01454d749fbef49c10c2a1a93f0a863d977914f32ae21455a343. Runtime4 из принятого ATTENTION_SCOPE_AFTER_R7: producer, server.js, SHOP native-host.js и SHOP shell.js. CAB native-host.js и shell.js — отдельные hoststatic2; в image их нет. Пять afterbytes exact frozenR4; только SHOP shell включает отдельно принятый combined-prefill candidate b7efae7638e05351296d93243f771b2c7ca134672bda1abe348ac7912d3fab60/379553B. Scope-review содержит полные before/after SHA, публичные code provenance paths; nativefreshness не утверждается.

R7 protected5 exact: account23a, factoryf36, core1a392, adaptera727, widget5752. SHOP b39→b7ef — единственное разрешённое пересечение. Managed version334/revision245ca…8d9f8/141files/history334 и обе принятые формы98eb/8d5f сохраняются. Price83 и full static остальные ресурсы сохраняются. Новый ordered Compose69→70, R7 image-only overlay остаётся последним predecessor. Foreign4 identities/config/image/restarts exact.

## Три фазы и явный порядок

1. Runtime: stage → prehistory → Root обычным штатным способом получает нужное readiness/cache окно ДО BASE → prepare → build → apply → отдельный inspect. Child FROM exact local parent, networknone/pullfalse, один ADD только runtime4/noRUN/noENV/noappmount. Старые CAB2 остаются before до отдельного runtime inspect; он создаёт runtime-accepted.json после full history SHA/readback. Apply его не создаёт.
2. Static host: static-prepare создаёт отдельный **readonly preservation anchor**, затем static-host атомарно меняет CAB native-host. Runtime уже имеет producer/route; новый host сохраняет v1 по умолчанию, старый CABshell совместим.
3. Static shell: только после host-returned либо отдельного readonly host-observed разрешён static-shell. Затем inspect-all заново подтверждает обе host files, runtime/Config/env/image/orderedplan/price/site/DB preservation и полный history SHA. Live UI старого/new сеанса320/390 и old query проверяет Root отдельно. Native guard PASS не подменяет их.

CLI: `install.py stage COMMIT MANIFEST_SHA`; `prehistory`; `prepare`; `build`; `apply`; **`inspect`**; `static-prepare`; `static-host`; `static-shell`; **`inspect-all`**. При partial/unknown static — `inspect-static`. Runtime inspect предназначен для фазы CAB-before; после static изменений использовать static/full inspect, не старый runtime inspect. Команды не запускаются агентом.

## Protected prehistory вне critical window

5GB/46k+ файлов не сканируются SHA десятки раз. До balance/BASE отдельный prehistory под своей lease проверяет parent/source/6before/staticmetadata/managed334 и захватывает полный actual history: все SHA, canonical pathset, directory+file dev/ino/mode/uid/gid/nlink/size/mtimeNs/ctimeNs и все managed rows/schema (3таблицы полностью, не только текущий сайт). Protected witness+ready пишутся EXCL, связаны code/manifest/source/full5identity/parent/current334. Неизвестный/существующий witness не перезаписывается.

На prepare/base guards сравниваются весь pathset+full stat и ALLmanaged DBrows/current334 с этим witness. Любой drift отказывает. После runtime independent и fullstatic acceptance выполняется полный SHA scan заново. Из reviewed QA_R4 SHA05545… перенесены только readonly tree/preservation primitives, без network/runtime imports/save. Old historical257 mismatch сохраняется как две фактические версии, не repair/ignore: historical manifest/fileset и actual SHA отдельно, current334manifest exact. Bounds прежние: perfile16MiB,total6GiB,250kfiles,180s scan. Witness ≤64MiB; oversized state failclosed.

## Слои сохранности, не before/after widening

Runtime BASE неизменна: active3+CRM consistent readonly snapshots/schema/all business rows strict; fixed7archives opaque main/WAL/SHM exact+protected raw copies; только прежние2 bounded diagnostic cells по прежней policy/hwm. Перед каждым действием source/HMAC/startup/queue/economy guards прежние. Никаких CRMexceptions, flags/worker pause/queue mutations.

После runtime независимого AFTER новый static anchor нужен потому, что другие живые действия после завершённого runtime окна не обязаны совпадать со старым SQL BASE. Он не сбрасывает runtime proof/диагностический бюджет: старые base/receipts остаются immutable. Static anchor берёт новый consistent CURRENT snapshot, привязывается к runtime-accepted/base/child/witness SHA и к тем же фактическим container identities/Config/env/code/site/price. Внутри static окна SQL/raw preservation снова strict; собственный отдельный diagnostic journal G1 (никакого restart/G2) не может ослабить runtime journal. Startup/HMAC/queue/economy checks сохраняются консервативно даже без нового apprestart. Нет automatic re-anchor/restore/retry; любой новый businesswrite после static anchor вновь вызывает отказ. Tests отдельно доказывают сохранение legitimate preanchor CRM value и отказ latewrite.

## Exact source phases

Before server только23c966…, after только183a0e…; один phase никогда не принимает обе SHA. Package server_phase proof проверяет immutable23c code и183payload: меняется только PALITRA_MANAGER_ATTENTION_ROUTE..END, весь prefix/suffix/startup/footer byteexact. Source oracles/providers/budget/economy/vault/query files прежние. Inventory descriptor обновляет sourcefeature319→принятыйR7f36; paths/archives/mode/sidecars не меняются. Source path formula server вне разрешённого route exact; phase sourceguard после child не пропускает исходныйserver23.

## Host atomic delivery и unknown outcomes

Два literal закрытых host paths. Prepare сохраняет root/private EXCL beforecopies; fresh before SHA/regular/type/nlink1/root600/parent aliases/CAS. Каждый файл имеет собственный EXCL intent до temp/rename. Temp только в том же parent для atomic replace, exact mode/owner, fsyncfile+directory; перед rename повторный полный guard+lateCAS. Полный static expected map допускает только префикс0(old pair),1(new host+old shell),2(new pair), все остальные ресурсы exact. Returned и readonly-observed receipt для КАЖДОГО after member (host и shell) фиксируют target/intentSHA/staticanchorSHA/exactafter inode/stat; последующий sameSHA/newinode drift отвергается.

Unknown до/после rename не повторяется. inspect-static читает факт: partial-before → NO_REPLAY; host уже after и всё сохранено → private readonly host-observed, после чего Root может явно выполнить следующий shell step. Shell-before с существующим intent никогда не переписывается повторно. Неверный порядок/new shell+old host/неизвестный hash отказывают. Ни rollback ни recovery overwrite нет. Лишний temp после неизвестного исхода сохраняется для Root проверки; агент уборку production не выполняет.

## Tests и границы

Новые meaningful suites: test_runtime_host.py (4runtime+2host catalog/stage/assembler/full3phase/receipt/sourcephase/staticCURRENTanchor/latewrite/latecode/69predecessor и AST26 inherited guard primitives); test_host_static.py (real atomic filesystem, unknown before/after/lateCAS/order/others/backups); test_managed_history.py (real SQLite +full history files, faststat/fullSHA, ALLmanaged rows, known historical mismatch, versions/pathset/current forms/strict JSON). Fixture Docker/lease/price/readiness modeled, никогда не native. Исторические feature58 и R7 helper112 сохранены и не выдаются за тесты нового writer. Baseline29PASS был выполнен локально, но independent review воспроизвёл Windows-only отсутствиеos.fchmod вruntime fixture. Test revision1 исправляет ТОЛЬКО fresh test host_static.os proxy; realos и production helpers/payload не меняются. R8 original28пинов и registry6952431e… восстановлены byte-exact; отдельная TEST_REVISION_1 хранит corrected fixture. R9 наследует исправленный fixture. Ни одной productionфункции из-за Windows не изменено. Дополнительный test_r9_lineage проверяет весь helper AST exact R8 вне NAME/FILE_PINS/REVIEWED_DATA_PINS, exactapproved bytes, остальные5targets и реальныйassembler. Итог нового30прогона — FREEZE.json. Команда: `python -m unittest test_runtime_host test_managed_history test_host_static test_r9_lineage -q`. Python AST и Node --check всех6appfiles/supportJS PASS. InheritedR7 112 не запускались/не переписывались как будто это новые тесты;26 ключевыхguard primitives AST-exact и independent review нашёл64 неизменных функции.

Root перед native: свежие availability/account/project/lease/5images/69chain/6before modes/pins/fullstatics; новое окно; stageimmutable/newnamespace. Cached scope/native22:45 report/managed-anchor не permit. Existing R7/R6/static/managed Save не повторять; managedCAS в R10 отсутствует. Полученный runtime/static результат независимо прочитать; root cleanup только собственных завершённых ресурсов, user sessions/drafts/history/consents сохранять.


## R9 lineage (история) и R10 следующий путь Root

Combined SHOP принят Root74 и independent74; эти74 — отдельные featurefixtures, не тесты installer. В R9 только NAME/AREA, один approvedSHOPafter, связанный scope/data pin; production helper AST вне3assignments exact R8. make_manifest.py меняет только docstring R8→R9. Остальные5payload/support/source/guards byteexact. Это не установка: native0, R8stage0; frozenR7/R8 не replay.

После final Root+independentcode acceptance Root сверяет свежие5images, parente22,69Compose, managed334/revision245ca86f12e50e696ee39c5d6c3ab0f1924c05e933abbcc3ba249a20e6d8d9f8,6before и собственнуюlease. Новый immutablecommit/newR9stage1; prehistory fullprotectedwitness ДО штатного readiness/cache refresh и BASE; затем prepare1/build1/apply1, независимый inspect приCABold. Далее отдельный static-prepare anchor, static-host1→static-shell1 и inspect-all/fullhistory/public/liveoldsession390/320. Unknown runtime→inspectonly; unknownstatic→inspect-staticonly, без повторнойзаписи/rollback. Текущие результаты nativefreshness не утверждают.


## R10 — строго фактический mode0600

R9 native stage1 PASS, prehistory1 отказал HOST_STATIC_ROOT_MODE доhistory/base/build/apply. Root personally прочитал оба закрытыхCABpaths23:23:52Z: regular/nlink1/rootuid0/gid0/canonical/noalias, mode0600, parents0755/root0; оба beforeSHA f27/b40 exact. Источник — HOST_MODE_PROVENANCE.json, не nativepermit. Агент native/productionchmod не выполнял.

Новый namespace palitra-attention-durable-20261030-r10. В install.py толькоNAME и pinnedSHA host_static.py; все productionfunctions/остальные top-levelassignments ASTexactR9. Единственное изменение host_static.py: file_state строго требует0600 вместо неподтверждённого0644. Никакого допуска644/660 и никаких chmod существующихproductionfiles. write_one, fchmod(beforemode), owner/nlink/path/lateCAS/unknown/backup/wholeDB guards неизменны. Все6payloadbytes exactR9; source/scope/inventory/parent/managed334 unchanged. R9 frozen31/stagedimmutable не повторять.

Fixtures создают файлы0600 наPOSIX. Windows compatibility действует только через module-local os proxy; новыйfixture больше не меняет реальный os.fchmod. Windows не доказывает native POSIXmode/ownership. test_host_metadata моделирует именно POSIXlstat и вызывает реальныеclosedpath+file_state на реальных fixturebytes: оба0600 принимаются;644/660/400/700,uid/gid/nlink/type/alias/symlink/чужойpath отказывают. test_r9_lineage вR10 проверяет ASTexactR9 вне NAME/REVIEWED_DATA_PINS, exactsingleliteral hostdiff и6payloadexact.

Полный новыйпрогон: `python -m unittest test_runtime_host test_managed_history test_host_static test_r9_lineage test_host_metadata -q` (30existing +4metadata). Финальный результат — FREEZE.json. FinalmanifestROOT_REVIEWED_CODE_ONLY по прежним документированным5images/e22; Root всё заново подтверждает native перед новымR10stage/prehistory. Остальные этапы и трёхфазная установка прежние, безreplay/rollback/DBrestore.
