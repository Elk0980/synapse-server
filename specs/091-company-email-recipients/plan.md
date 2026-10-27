# План

Владелец координации и приёмки — Codex. Основной автор продуктового кандидата — существующий Claude Авокадо, фактически Opus 5.5; effort High интерфейсом не подтверждён. Независимый QA не меняет продукт. Одновременных продуктовых авторов нет.

Использовать email-settings, email-notifications, email-outbox, email-diagnostics и существующее поле API recipient. Общий parser email-recipients задаёт формат и сравнение SMTP ACK. Новая служебная таблица lead_email_recipients хранит pending/accepted/withdrawn отдельно по адресам. Старые бизнес-таблицы и отправленные задания не мигрируются.

Разрешённые продуктовые файлы: пять ops/crm/email-*.js, включая новый email-recipients.js, и sites/synapse/cabinet/settings.js. Проверки — соответствующие SMTP/SQLite и DOM tests. server.js не заменяется: действующее подключение emailSettings.notifications и общей квоты совместимо.

Установка отдельным bounded helper: свежая собственная lease, exact merged REVIEW_READY, фактические source hashes, полный runtime/image tree, текущая Compose chain после восстановления, protected backup, один CRM image слой поверх активного образа и один статический файл. Effective configuration отличается только crm.image; остальные образы, env, mounts, networks, данные и managed-release guard сохраняются. Старый полный deploy не воспроизводить.

Read-contract R3 отдельно приводит старый workerGraphExpected к принятому текущему image: только одна bridge-пара из прежних десяти, пять исходных reader-code файлов побайтно сохраняются. Новый закрытый manifest/loader не изменяет worker() или spec после импорта. Дополнительная узкая Root-проба проверяет pinned image/CID, graph10 и полное tree30; все прежние startup/hooks/mount/restart/foreign guards и Native scopes сохраняются. Рабочий обработчик не меняется и не перезапускается.

Откат не автоматический. Старый worker игнорирует ledger и не должен запускаться поверх частично принятых/неизвестных заданий или многозначной конфигурации. После включения двух адресов предпочтителен forward fix; БД не восстанавливается из старой копии.

Проверки: parser/atomicity/isolation/ciphertext, partial→reopen→retry remaining, квота на каждый SMTP, stale success/failure, unknown ACK, legacy sent, UI reload/company switch. Реальная доставка и физический телефон — отдельные границы доказательств.
