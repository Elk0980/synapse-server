# Palitra R12: отдельный приватный пакет, не нативное разрешение

Namespace `palitra-attention-durable-20261030-r12`. Основание — точные 40 файлов
принятого приватного R11 (registry30ba49ed…9229d). R11 закрыт после отказа
DATABASE_SCHEMA_OR_ROWS_CHANGED_INSPECT_ONLY в backups, до Docker; его стадии
не повторяются. Этот новый пакет требует новой фактической базы, включающей
уже существующие к моменту её снятия записи. Никакие события не удаляются,
не подавляются и не исключаются из контроля. Очереди/мониторинг не отключаются.

В install.py ровно две буквальные замены относительно R11: NAME r11→r12 и
SHA scope-review.json. SOURCE_LINEAGE.json и R11_TO_R12.diff фиксируют точный
переход. Обратная замена полностью восстанавливает байты R11. AST вне NAME и
REVIEWED_DATA_PINS совпадает; в REVIEWED_DATA_PINS меняется только scope pin.
Managed module9d00, все шесть payload, rootmode0600, source guards, wholeDB/HMAC,
количество вызовов, TTL и все остальные проверки байтово прежние. R7 parent e22,
пять ожидаемых images, managed334/141файл/вся история и price83 не меняются.
Никаких данных нового события/Env/baseJSON в пакет не переносится.

manifest.json имеет технический ROOT_REVIEWED_CODE_ONLY. Это не окончательная
приёмка Root и не native permit. Свежие queue/cache/window/history/identity/BASE/
backup/права и единственный писатель остаются обязательными. Никаких гарантий
времени либо ослаблений отказа ради завершения. Root отдельно решает возможность
новой попытки после предусмотренной активности и проверяет fresh facts.

Проверки из этой папки:

    python verify_source.py
    python -m unittest test_runtime_host test_managed_history test_host_static test_r9_lineage test_host_metadata -q

34 fixtures выполняют только синтетические операции с временными файлами/SQLite.
Их строки STAGED/PREPARED/BUILT/APPLIED/AFTER_INDEPENDENT_READBACK_PASS и JSON о
recreation — вывод моков, не реальные действия. Историческое имя lineage теста
сохранено, но он проверяет R11→R12, exactR2/FULL, immutable payload и manifest.
Остальные четыре тестовых модуля байтово прежние. Python AST и Node --check
выполняют только синтаксическую проверку локальных исходников.

FREEZE/VERIFICATION/SHA256 фиксируют приватный код и реальные локальные результаты.
README_R11.md, assemble_private.py и прежние diff сохранены как исторические
исходники: не выполнять старый packaging script для нового выпуска.
package_r12.py — одноразовое создание приватного пакета, не запускать после freeze.
R11/DRAFT/R1/R2 не переписаны и проверены их registries. Браузер/native/network/
API/Env/реальныеDB/Git/shared/actions людям этим агентом не использовались.
