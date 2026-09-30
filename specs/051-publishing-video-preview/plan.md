# План

1. `ops/content/server.js`, GET/HEAD `/content/publishing-assets/...`: CSP выбирается по типу.
   - Видео (`VIDEO_TYPES`): `default-src 'none'; media-src 'self' ${PUBLISHING_ASSET_ORIGIN}; sandbox`.
   - Изображения: прежний `default-src 'none'; sandbox`.
   - Прочие заголовки, Range и пути без изменений. Комментарий с причиной.
2. `ops/content/company-modules-access.test.js`:
   - в тест видео — проверки SC-001 для MP4 и WebM (GET с Range и HEAD) и 404 для `.html`;
   - в тест фото — точное равенство прежнего CSP.
3. Проверки:
   - целевые тесты, затем полный `ops/content/*.test.js` (`--test-concurrency=1`);
   - контрольный прогон новых проверок на неизменённом `server.js` — должен упасть;
   - `node --check`, `git diff --check`, `gate.py check`;
   - браузерная проверка SC-002 скриптом `browser-check.cjs`. Он запускается вручную там, где Playwright уже установлен; в CI не входит.
