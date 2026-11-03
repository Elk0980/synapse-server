# План

Codex — единственный писатель в изолированном worktree codex/board-watchdog-20261104 от main fb598368. Область: CRM task-watchdog.js, task-coordination.js, server.js, связанные тесты и отдельный CI. Кабинет/бот/issuer принадлежат смежным задачам и здесь не меняются.

1. Прочитать59, памятки; исследовать пути стадий/no_report/бота.
2. Модуль policy/verifier/silence/digest/audit; серверные guards, owner-only endpoint, scheduled snapshots без отправки.
3. Проверить старые/новые записи и старые сеансы через MCP+кабинет; gates; draft PR.
4. До merge: Claude решает issuer/health/no-code/UI/Telegram-контракты. Реализация не расширяет права. После интеграции полный production acceptance отдельным разрешённым выпуском.

Новые таблицы additive, бизнес-строки не мигрируются. DDL выполняется при конструировании CRM как существующая coordination; на установке необходим штатный backup. Старые done не переписываются, новые переходы guarded. Откат кода сохраняет новые таблицы/данные, без слепого восстановления старой БД. Внешние проверки только фиксированный GitHub API и deployment health URL, без произвольных загрузок клиентских ссылок.
