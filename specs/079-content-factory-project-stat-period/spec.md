# Период заявок Контент завода в часовом поясе проекта

CF29-server. Процесс Spec Kit 1.0.0; исполнитель Codex, независимую приёмку и HTTP-интеграцию выполняет root отдельно.

## Цель и сценарий

UX §8 требует месяц проекта в его часовом поясе. Для Europe/Moscow заявка `2026-09-30T21:30:00Z` относится к октябрю. Существующая общая UTC-аналитика сохраняется без изменения поведения и DTO.

## Контракт

`attribution(code,from,to,options?)` и `overview(code,from,to,options?)` принимают только optional `{crmPeriod:'project'|'utc'}`. Отсутствие options, `{}` и explicit utc сохраняют прежнее UTC-поведение и прежний состав DTO. Null/array/nonobject/неизвестный mode дают 400 VALIDATION_ERROR с field crmPeriod; неизвестный собственный ключ options даёт тот же код с field равным ключу. Coercion нет.

Для project пояс читается исключительно из `companies.timezone` собственной активной компании, без значения клиента/аккаунта/platform/fallback. Пустой или невалидный пояс: 400 VALIDATION_ERROR, field timezone.

Только project возвращает `crm.period` (в attribution — period): `{basis:'project',timezone,from,to,startInclusive,endExclusive}`. Границы — UTC ISO с миллисекундами, from/to — включительные локальные даты. Диапазон заявок `[startInclusive,endExclusive)`; конец — начало следующего локального дня. Moscow октябрь2026: `2026-09-30T21:00:00.000Z`…`2026-10-31T21:00:00.000Z`.

## Требования

- FR-001 Optional project не меняет default UTC, existing callers, insights или DTO default/explicit utc.
- FR-002 Одинаковые вычисленные bounds применяются и к связанным заявкам, и к bySource. Переиспользовать existing dayBounds, учитывать DST, не считать период фиксированным числом часов.
- FR-003 Пояс — только собственной active company; строгая валидация options и timezone, без fallback и coercion.
- FR-004 Только opted attribution получает описанный period; metadata показывает реальные границы.
- FR-005 Суточные снимки площадок, aggregate, postMetrics, CF27 tags, публикационный реестр/лимиты и связи остаются прежними. Суточные агрегаты источников не выдаются за точные часы проекта. Чтение не пишет/не собирает и не вызывает API.

## Приёмка

- SC-001 Новая meaningful regression Moscow сначала падает на baseline CF27, затем проходит с настоящей SQLite/social-stats.
- SC-002 Проверены точные start/end, Moscow, Berlin spring/fall DST, own-company/active-company, invalid options/timezone, обе CRM выборки, readonly.
- SC-003 Default и explicit utc одинаковы без period; проектный overview меняет только crm. Existing social-stats/tags/stats-contract suites проходят.

## Область

Единственный писатель: Codex только `ops/crm/social-stats.js`, новый `ops/crm/social-stats-project-period.test.js`, четыре документа079. Root владеет social-stats-http/test/spec080; UI передаётся отдельно. Другие файлы, QA/manifest/state/immutable/CF28/Claude CF26 — readonly. Без сети, production, live API, секретов, прав, публикаций, commit/push/deploy и новых агентов.
