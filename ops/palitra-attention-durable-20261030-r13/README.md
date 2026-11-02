# Palitra R13 — приватный code-only пакет, NOT_NATIVE

Namespace `palitra-attention-durable-20261030-r13`. Основание — точные42 файла
замороженного приватного R12, registry465c5bc6f2a9e33eaf104a4d4e0c9dfac751046c695d85bea3179fcd5c566c4c.
Предшественник SEALED после защитного отказа до Docker. Его стадии и backups не
повторяются. Новый namespace допускает только отдельное решение Root о freshBASE,
не заменяет подтверждение устойчивой диагностики/очередей/окна и не является
разрешением на нативные действия. Серверные логи, Env, privateBASE и данные
пользователей в пакет не переносятся; частная причина отказа здесь не публикуется.

В install.py ровно две буквальные замены относительно принятого R12:
NAME r12→r13 и SHA scope-review.json. R12_TO_R13.diff/SOURCE_LINEAGE.json показывают
ограниченный переход. Обратные две замены возвращают полные байты R12; AST вне
NAME/REVIEWED_DATA_PINS неизменен, внутри pins меняется только scope provenance.
Scope меняет только kind/packagingProvenance. Manifest меняет только packageId
и helperSha256. Все пять images и шесть before/after payload остаются прежними.

Managed module9d00a086c983a0a7435cf6a6a2f726b570bc787bf52f56fc294ae03684aa640b
скопирован побайтно без нормализации CRCRLF. FULL-префикс6429байт с SHA69690754e6efb394e3fede769257dc39df7fd1fe221d018c5cd7f77e346aa2cd сохранён.
Родитель runtimeR7e22, managed334/141files/334history, price83 anchors, mode0600/
root/root/nlink1, все source/SQL/witness/wholeDB/HMAC/bridge/events проверки,
TTL/число guard вызовов и fail-closed условия не изменены. Диагностика и события
не маскируются, мониторинг/очереди/флаги/auth/consents не отключаются и не правятся.

manifest.json имеет только технический статус ROOT_REVIEWED_CODE_ONLY.
FREEZE явно NOT_ROOT_FINAL_ACCEPTANCE_OR_NATIVE_PERMIT. Root отдельно проверяет
полный diff, exactpins, fresh lease/history/identity/queue/cache/readiness/BASE,
принимает решение и сам выполняет разрешённые фазы/readback/live. Успешные
локальные fixtures не дают native permit и не гарантируют достаточное окно.

Проверки из этой папки:

    python verify_source.py
    python -m unittest test_runtime_host test_managed_history test_host_static test_r9_lineage test_host_metadata -q

Историческое имя lineage теста сохранено; он проверяет именно R12→R13/exactR2/
FULL/manifest/payload. Остальные четыре тестовых модуля неизменны. Fixtures
используют только синтетические временные файлы/SQLite и mocks. Все строки
STAGED/PREPARED/BUILT/APPLIED/AFTER_INDEPENDENT_READBACK_PASS и JSON о recreation
в тестовом stdout — синтетические события, не действия в рабочей системе.
Python AST и Node --check проверяют только синтаксис локальных файлов.

SOURCE_LINEAGE/VERIFICATION/FREEZE и SHA256 фиксируют результаты и полный пакет
без самоссылки registry. Старые diff, README_R11.md и packagers сохранены как
исторические исходники: их не выполнять. package_r13.py — одноразовая приватная
упаковка; после freeze не запускать повторно. R12/R11/DRAFT/R1/R2 неизменны,
проверены их registries. Этот агент не выполнял браузер/native/network/API/Env/
реальныеDB/Git/shared/managedsave и не создавал agents/chats/timers/сообщения людям.
