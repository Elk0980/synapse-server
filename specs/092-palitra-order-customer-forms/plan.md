# План

Root — единственный production writer. Агенты работают в отдельных приватных областях: идентичность/сессия, телефонные формы, nullable render и подпись черновика. Основная ветка текущей доработки codex/palitra-order-customer-forms основана на установленной контентной ветке; её старые apply не повторяются.

1. Снять реальные manager-attention/conversation refs, текущие public HTML/JS и hash runtime. Кабинет и public shop имеют разные shell/native-host bytes; не копировать один поверх другого.
2. Сопоставить существующую conversation-v1/session-grants группировку с attention projection; сначала доказать каноническую связь. Не делать миграцию или новый identity join до проверки модели.
3. Проверить actual AccountService и поддержку подтверждения телефона. Optional demographics, маска и autofill отделены от изменения авторизации. Не устранять backend отказ только HTML required.
4. Реализовать ограниченные private candidates на fresh bytes, проверять literal patch outside-exact. Использовать существующие server session/grants/CSRF/формы и существующий транспорт.
5. Meaningful DOM/VM и SQLite проверки текущих функций/контрактов; browser read-only на существующих материалах и своей тестовой области. При установке runtime определить фактический сервис и его startup workers; отказ CRM queue guard не разрешает его отключить или изменить очередь.
6. Установка только нового bounded code-only пакета после fresh lease/base/backup; независимые runtime/static/public readbacks, live320/390, старые сеансы и cleanup. Пользовательские незавершённые формы сохранять. REPORT/CURRENT и доказательства приватны.
