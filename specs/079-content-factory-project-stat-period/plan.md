# План CF29-server

1. Создать spec/plan/tasks/evidence до code. Базовый social-stats SHA CF27: B51CA292220899455776A9DCD82FFC9FC3E92AE4B1BAF6E35835AA3ADCD543D6.
2. Добавить новый synthetic SQLite suite; целевой Moscow baseline negative без production-правки. Проверять фактическое число связанных заявок, а не только metadata/helper.
3. В social-stats добавить малый helper options/bounds. Legacy UTC возвращает существующие строковые границы без нормализации/изменения DTO. Project валидирует companies.timezone и использует existing dayBounds(from).startMs / dayBounds(to).endMs. Один общий range для двух CRM SELECT, только opted period metadata. Overview передаёт options в attribution; остальные расчёты неизменны.
4. Meaningful tests: обе CRM выборки, границы с/без milliseconds, DST 23/25h и месяцы743/745h, scope, ошибочные options/timezone, default DTO, aggregate/postMetrics/CF27/лимиты, total_changes readonly.
5. Выполнить новый suite и existing social-stats, tags, stats-contract; gate/converge/diff. Evidence содержит реальные результаты, baseline и SHA. Затем остановить запись.

Никаких schema migrations, новых API clients/timers/permissions. HTTP parameter parsing и UI остаются вне этого пакета и не объявляются подключёнными.
