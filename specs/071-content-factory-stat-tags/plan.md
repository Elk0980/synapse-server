# План

Root единственный писатель social-stats.js/test и нового social-stats-tags.test.js. Агент CF20 autoposting.js только чтение. Существующий attributionPosts уже устанавливает доказанный id, повторно не угадывать связь. Batch join companies/autoposting_posts по отобранным уникальным id, whitelist meta.format/meta.role. DTO только две метки; прежние метрики/атрибуция не меняются.

Проверки: sqlite synthetic fixtures, старые social-stats tests, SHA/diff/gate. После остановки остальных авторов синхронизировать проверенные пути в QA.
