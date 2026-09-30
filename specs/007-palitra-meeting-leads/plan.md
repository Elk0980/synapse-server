# План

1. Сохранить совместимость SQLite: добавить contact/delivery колонки с пустым default и group_required=0; в outbox добавить destination=manager. Старые строки остаются прежними.
2. site-orders.js валидирует и сохраняет структурный контракт. Legacy fingerprint неизменен; новый включает нормализованный контакт и доставку.
3. project-chat.js передаёт read-only reader текущей привязки комнаты своей компании. server.js включает groupNotificationSites=['palitra'] и узкий owner+CSRF маршрут renotify-group.
4. При приёме новой заявки group_required фиксируется; отдельный group outbox при существующей привязке. Отсутствие привязки не теряет заказ и видно в ЛК. Старые заказы не получают групповые задания.
5. Очередь проверяет актуальность группы до claim, личные операции ограничены destination=manager. Результаты разделены, повтор вручную адресный.
6. Cabinet site-orders.js показывает канал/контакт/доставку и groupNotify, экранирует строки и не превращает произвольный контакт в ссылку.
7. Unit, HTTP integration, cabinet DOM и существующие client-dialogs isolation тесты; затем Spec Kit converge и gate.

Разрешённые файлы: ops/content/site-orders*, узкий стык project-chat.js/server.js, sites/synapse/cabinet/site-orders*, эта спецификация. База949753e, изолированная веткаcodex/palitra-meeting-leads-20260930. Восстановление прерванной первоначальной распаковки подтверждено приватным evidence; до реализации worktree чистая. Секреты и клиентские данные не читаются/не публикуются.
