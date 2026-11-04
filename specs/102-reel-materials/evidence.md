# Свидетельства

## PR (а) — сервер (04.11.2026, Бангкок)
- `node --test ops/crm/reel-materials.test.js` — 6 тестов, pass 6, fail 0 (EDL, фильтры, изоляция компаний, правка → задача → claim → v2, публикация, HTTP-права).
- `node --test ops/crm/reel-materials-http.test.js` — 1 тест на настоящем `server.js`, pass 1: ролик SMM → EDL → служебный queue/claim/versions → задача «Монтаж: …» на доске → черновик автопостинга v2 без даты; чужая компания 403/404; служебный API с личностью 403.
- Регрессия: `autoposting-trash-http.test.js`, `content-factory-source-http.test.js` — pass 9, fail 0.
