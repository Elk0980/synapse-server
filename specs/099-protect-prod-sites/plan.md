# План реализации

Единственный писатель новых tools/protect-prod-sites, workflows protect-prod-sites*,
docs/production-sites и specs/099-protect-prod-sites — Codex №57. Worker №55 не менять.
Разведка main и комментарий184 предшествуют созданию ветки/изменениям файлов.
Чистый worktree от fb598368. Python stdlib guard с API paging и base-only target
workflow; отдельные read-only PR тесты. Полный план в docs/production-sites/PLAN.md.
Проверить негативные случаи, реальный PR без/с меткой, SpecKit, diff вне sites.
Настройки required checks и runtime подключение оставлять на отдельную приёмку.

## План изменения 05.11 (Claude, ветка claude/guard-own-domains)

Единственный писатель: Claude, файлы `tools/protect-prod-sites/{guard,test_guard}.py`,
`docs/production-sites/PLAN.md`, этот spec. Workflows не меняются: доверенный job уже
работает из base checkout, где лежат Caddyfile и Compose. PR #559 не трогается.
Публичные маршруты server.js, CLIENT_SITE_SOURCES и общие JS снимаются с метки (FR-010).
