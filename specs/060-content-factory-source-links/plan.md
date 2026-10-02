# План CF10

1. Дополнить autoposting.js таблицей autoposting_source_links: company/request payload, source revision/SHA/URL, post/content revision, время и сохранённый ответ. Только ссылки и история; файлы остаются в content.
2. Выделить приватные createPrepared/updatePrepared. Обычные методы сохраняют проверки и поведение; attach вызывает ядро в собственной единственной транзакции.
3. Повтор распознавать до invalidate и чтения актуальной карточки. При первом вызове записывать DTO ответа в той же транзакции; usage перечитывает карточку.
4. Запустить новый синтетический тест и регрессию autoposting/recovery. Проверить полный diff и зафиксировать действительные результаты.

Разрешённые файлы: ops/crm/autoposting.js, ops/crm/autoposting-source-links.test.js, четыре документа specs/060-content-factory-source-links. Единственный писатель этой области — назначенный агент. Общая копия, QA, server.js, sites, manifests/state и остальные файлы только чтение. Наличие плана не является блокировкой production.
