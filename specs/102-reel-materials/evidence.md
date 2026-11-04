# Свидетельства

## PR (а) — сервер (04.11.2026, Бангкок)
- `node --test ops/crm/reel-materials.test.js` — 6 тестов, pass 6, fail 0 (EDL, фильтры, изоляция компаний, правка → задача → claim → v2, публикация, HTTP-права).
- `node --test ops/crm/reel-materials-http.test.js` — 1 тест на настоящем `server.js`, pass 1: ролик SMM → EDL → служебный queue/claim/versions → задача «Монтаж: …» на доске → черновик автопостинга v2 без даты; чужая компания 403/404; служебный API с личностью 403.
- Регрессия: `autoposting-trash-http.test.js`, `content-factory-source-http.test.js` — pass 9, fail 0.

## PR (б) — «Материалы» и «Постинг» (05.11.2026, Бангкок)
- `node --test sites/synapse/cabinet/materials.test.cjs` (jsdom) — 5/5: регистрация `content-materials`, сетка v2/«правок: 1», фильтры уходят на сервер, перепутанные даты не уходят, ответ другой компании не показывается, маска 6 площадок, версии, «Скачать», «Создать публикацию» {version, platformIds}, переход в «Постинг», права view/edit.
- Playwright (Chromium) на стенде с заглушкой API и синтетическими роликами ffmpeg (testsrc2/smptebars, без данных клиентов), 390×844 и 1440×900: карточек 3, фильтр TikTok → 1, маска `tiktok`, черновик №77 «Ничего не отправлено», горизонтальная прокрутка 0 px на всех экранах, ошибок страницы 0. Снимки: materials-grid-390/1440, materials-detail-tiktok-390/1440 (scratchpad агента, в git не добавлены).
- Регрессия «Постинга»: autoposting-cf23 11/11, autoposting-cf26 3/3; autoposting.test.cjs и autoposting-daily.test.cjs дают одинаковый файловый тайм-аут и на чистом origin/main (сравнение списков подтестов совпало), т. е. это не следствие правки.
- Не проверено в браузере: маска в предпросмотре «Постинга» (проверены только синтаксис и общий рендер маски).
