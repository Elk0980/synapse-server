# Карточка и список материалов: одна UX-коррекция

Новый namespace `palitra-content-native-ux-20261029-r1`. Только **один существующий** файл: `sites/synapse/cabinet/palitra-orders/palitra-content-material-ui.js`. NEW0. HTML, остальные восемь файлов установленного static9, runtime source, DB/очереди/настройки/права не входят.

Основа helper — принятый static9 SHA `7212049d4cb6fadca364863be8b48358e7fd3a5282d855c6ec3ba9caabccdb0c`, который Root установил одним apply и независимо прочитал. Старые static9 apply/new4 не повторять: четыре файла уже существуют. Native runtime-helper остановился до apply на emails1; этот UX-пакет его не меняет и queue guard не обходит.

В helper изменены только namespace, закрытый single-file allowlist/NEW0, count/result labels и порядок публикации единственного файла. `environment`, `lease`, `mount_digest`, точный readonly command allowlist, fresh before/metadata/parent/backup/CAS/readback guards сохранены. `DIFF_FROM_STATIC9.patch` — точный diff. Требуются fresh five image IDs; все контейнерные ID/image/config/host/mounts неизменны. Сохраняются whole price, managed-policy, Caddy/Compose и все остальные static HTML/JS/CSS. Ни SQLite, ни docker up/build/run/exec, ни mutating systemctl helper не допускает.

## Review и manifest

Текущий принятый before material UI: `ba47239741cf85a7b5e70c733acf794ddb68f6ee6e92cc0734432dde47344e8c`. Root должен заново сверить actual SHA. UX after готовит агент формы отдельно; helper не включает продуктовый payload и не объявляет его проверенным.

`python -B make_manifest.py BEFORE_MATERIAL_JS AFTER_MATERIAL_JS INLINE_IMAGE_IDS.json manifest.json`.

Генератор требует exact before выше; при новом actual состоянии — STOP и свежий review, не подмена старым source. Manifest schema: `schema`, `status:ROOT_REVIEWED_CODE_ONLY`, `packageId`, `helperSha256`, `expectedImages`, `targets` ровно с одной строкой target/beforeSha256/afterSha256. Никаких null before. Payload содержит ровно один полный relative target path. Новый immutable code-only commit; private BASE/backup/report/данные в Git не отправлять.

## Native последовательность

Новые собственные native вкладки и fresh own ancestor flock. Прошлая56046/start17034003 освобождена, но факт освобождения не заменяет свежую проверку. После Root review: новый `stage COMMIT MANIFEST_SHA`, `prepare` (fresh BASE + backup одного файла), один `apply`, отдельный `inspect`. Permit900секунд, прежняя lease должна сохраняться. Не повторять неизвестные операции/старые apply.

Затем public exact GET старого query, безопасная перезагрузка только завершённого собственного UI и личная проверка нового текста/поиска/списка, без реальных отправок. Освободить только собственную lease и прочитать отсутствие. Пользовательский ввод и незавершённые формы не сносить.

Runtime writes0, DB reads/writes0, schema/auth/settings/price writes0, service restarts0. Очередь не открывается и не меняется. Прежняя граница profileunknown/409PROFILE_CHANGED сохраняется, backend context patch не считается установленным.

## Offline проверки

`python -B -m unittest discover -s . -p test_install.py -v`; `python -B -m py_compile install.py make_manifest.py`.

Реальные временные FS fixtures проверяют one-file prepare/backup/apply/inspect, CAS/неизвестную правку, metadata/expiry/lease/image/environment, closed payload/stage, запрет null/new targets, no DB/runtime/lifecycle capabilities. Docker/systemctl/network — mocks. Windows POSIX mode/chown/fsync-dir смоделированы; одна native symlink fixture может SKIP из-за Windows privilege, отдельный symlink guard unit PASS. Эти проверки не равны native/live/physical-phone приёмке.
