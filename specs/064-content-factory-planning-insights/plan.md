# План CF14

Единственный писатель Codex `/root/content_factory_batch_review`. Только новые ops/crm/content-factory-planning-insights.js/test.js и четыре документа этой спецификации. Все существующие файлы, server/service/jobs/worker/HTTP/sites/QA/manifest/state только чтение.

1. Проверить company/month, вычислить предыдущий календарный месяц, зафиксировать injected clock (по умолчанию Date.now).
2. Прочитать одну existing stats.overview. Переиспользовать чистые правила social-insights.buildInsights для признаков покрытия и состояния; исходные тексты/значения не копировать. Не создавать сравнение разных месяцев и не импортировать state followers в итоги периода.
3. Проецировать только whitelist площадок social-insights. Использовать отдельные timezone/coverage/freshness; несовместимые history/otherIntervals/provider/kind не соединять с основным рядом. Архив публикаций не ранжировать и не оценивать по одному ролику.
4. Рекомендации только фиксированные проверки качества, без успешных тем и причин. При missing пустой список. При exception/mismatched scope/invalid overview явный unavailable без эха данных.
   RECOMMENDATIONS/LIMITATIONS экспортируются замороженными, UNAVAILABLE_LIMITATION/OPEN_PERIOD_LIMITATION — фиксированными строками для validator root, без второго словаря текстов.
5. Предел8КиБ проверяется на окончательном JSON. Пробы памяти SQLite и synthetic DTO, без collect/сети. Converge и финальные шесть SHA, затем остановить запись.

DTO согласован root: {schemaVersion:1,companyCode,planMonth,source:{kind:'saved_social_stats',status:'available'|'unavailable',period:{from,to,timezone},capturedAt},platforms:[{platform,timezone,coverage:'missing'|'partial'|'complete'|'state_only'|'incompatible',confidence:'insufficient'|'limited'|'descriptive',freshness:{status:'unknown'|'recent'|'stale',lastCollectedAt,basis:'saved_collection_time'},editorialRecommendations:[{code,text}]}],limitations:[fixed text]}.

Root проверяет owner/analytics.view перед вызовом и делает early lookup до чтения статистики. Снимок server-only; root отдельно убирает служебные даты/идентификаторы из MODEL-проекции. Этот пакет не утверждает завершённой HTTP/runtime интеграции.
