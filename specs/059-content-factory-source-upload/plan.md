# План CF9
1. Прочитать текущие файлы и зафиксировать основу; менять точечными patch.
2. Потоковый multipart сохраняет manual default whitelist, upload использует отдельные разрешённые file/caption/metadata. Ограниченные metadata JSON и PATCH body.
3. Миграция JSON metadata/revision в существующей таблице, новый namespace upload:<company>/SHA, поиск stored SHA компании до записи; прежние Telegram origin не трогать.
4. ACL/CSRF до чтения и после async, транзакционный PATCH с revision, MIME/quota/temp cleanup переиспользовать.
5. Новый синтетический тест и один прогон старого manual теста; converge по FR, evidence/SHA для координатора.
Content Dockerfile копирует только content/*.js: словарь metadata закреплён здесь по действительным CRM FORMATS/CAPTION_PLATFORMS, тест сверяет его с ними. Runtime зависимости от CRM не добавлять. UI, attach/context и интеграция принадлежат координатору/Claude.
