# План

1. `ops/content/site-store.js`
   - `LEGACY_SITES`: у `palitra-love` статус `draft` → `published`; адрес, имя и редакторы прежние (FR-004).
   - После миграции ALVI — третья по тому же образцу транзакция `palitra_publication_20261001` (FR-001–FR-003):
     - если отметка есть — выход;
     - `UPDATE managed_sites SET publication_status='published', updated_at=?` с условиями FR-001 и `publication_status<>'published'`;
     - `INSERT INTO site_migrations` в той же транзакции.
   - Комментарий: купленный домен ждёт DNS и миграцией не заявляется.
2. `ops/content/site-store.test.js` — тесты SC-001 по образцу тестов ALVI и Авокадо.
3. Проверки:
   - целевой файл и полный `ops/content/*.test.js` (`--test-concurrency=1`, как в CI);
   - `node --check`, `git diff --check`, `python tools/spec-kit/gate.py check`, converge по FR/SC.

Схема таблиц не меняется. Новых зависимостей, установок, внешних вызовов, прав и настроек нет. Выпуск делает root.
