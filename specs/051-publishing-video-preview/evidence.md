# Проверка: прямая ссылка на видео publishing-assets

Дата: 01.10.2026. Исполнитель: Claude, единственный автор. Модель сессии настроена как `claude-opus-5-5`; фактическую обслуживающую модель платформа может заменить, это не проверялось.

Среда:
- изолированная облачная копия `Elk0980/synapse-server`, ветка `claude/publishing-video-preview-20261001` от `origin/main` a03eab10de24ec59e67b4cd4b9a20970fac2216f;
- Linux, Node 22.22.2;
- Chromium из уже установленного Playwright 1.56, headless. Установок не было.

Production, БД, ЛК, Telegram, Caddy, права и ролики не менялись.

## Причина — воспроизведена на реальном маршруте
Настоящий `ops/content/server.js` из main запущен локально с временной базой, одним локальным владельцем и файлом в `ASSETS_DIR/publishing/palitra-love/`. Файл — существующий `sites/alvi/video/alvi-hero.webm` (VP9, 52,2 с, 4 146 751 байт). URL открыт в Chromium напрямую, как root открывал ролик.

- **До правки** (main):
  - в консоли: «Refused to load media from '…/11111111111111111111111111111111.webm' because it violates the following Content Security Policy directive: "default-src 'none'". Note that 'media-src' was not explicitly set, so 'default-src' is used as a fallback.»;
  - запросов медиа — 0, только сам документ;
  - событий плеера CDP Media нет.
  Совпадает с живым симптомом root: `readyState 0`, длительность неизвестна.
- На копии маршрута без `sandbox`, но с тем же `default-src 'none'` — тот же отказ и `networkState 3`. Значит, причина в отсутствии `media-src`, а не в `sandbox`.
- С `default-src 'none'; media-src 'self'; sandbox` — загрузка, проигрывание и перемотка проходят.
- Изображение (JPEG) при прямом открытии показывается и с прежним CSP: элемент `img` 506×900, запрос один. Предупреждения только о встроенных стилях центрирования.
- Встраивание того же WebM в обычную страницу проигрывается и перематывается даже без правки: `readyState 4`, 1,5 с воспроизведения, перемотка на 30,0 с. Страница-плеер кабинета причиной не была.

## После правки (тот же сервер с патчем, тот же браузер)
- **WebM `alvi-hero.webm`:**
  - заголовки HEAD: `content-security-policy: default-src 'none'; media-src 'self' https://synapse.synapsebusiness.ru; sandbox`, `video/webm`, `nosniff`;
  - медиазапрос с `Range: bytes=0-`, без заголовка Origin;
  - CDP Media: декодер VpxVideoDecoder, 1280×720, длительность 52,167; конвейер kStarting → kPlaying; событие kPlay;
  - после 6 нажатий стрелки вправо в родных элементах управления — kSeek 0,52 → 3,13 с и состояние kSeeking;
  - ошибок плеера и CSP нет.
- **MP4 — ролик Б v2** (SHA256 `a1a1b334…fae2`, копия, загруженная с диска):
  - медиазапрос с Range есть, CSP-отказа нет;
  - плеер останавливается с `PipelineStatus 14` (DEMUXER_ERROR_NO_SUPPORTED_STREAMS): в этой сборке Chromium нет H.264 (`canPlayType('video/mp4; codecs="avc1.640028"')` пустой).
  - **Это не проверка H.264 и не проверка живого ролика.**
- **JPEG** — CSP прежний `default-src 'none'; sandbox`, картинка показывается.

## Тесты
- `node --test --test-name-pattern="publishing photo|video uploads" ops/content/company-modules-access.test.js`: 2 из 2.
- Контроль: те же тесты на неизменённом `server.js` — тест видео падает (нет `media-src`), тест фото проходит.
- Полный `node --test --test-concurrency=1 ops/content/*.test.js`: 550 тестов, 549 прошли, 1 пропущен, 0 упало.
- `node --check` изменённых файлов и `browser-check.cjs`; `git diff --check` — чисто; `python tools/spec-kit/gate.py check` — `status: ok`, 48 файлов.

## Converge (один проход)
- FR-001/002: код выбирает CSP по `VIDEO_TYPES`; тест проверяет точные строки для MP4, WebM и PNG.
- FR-003: тест проверяет `nosniff`, Content-Type, 206 и HEAD 200 с новой политикой; прежние проверки Range, 416, 404, 405 и прав не менялись и проходят.
- FR-004: тест разбирает директивы — только `default-src`, `media-src`, `sandbox`; `sandbox` пустой; нет `unsafe`, `*`, `data:`, `blob:`; нет `Access-Control-Allow-Origin`.
- FR-005: файлы кабинета не менялись.

Расхождений нет.

## Ограничения
- Облачный Chromium не декодирует H.264. Проигрывание именно MP4 ролика в Chrome и на телефоне (Safari iOS) проверяет root на живом URL после выпуска.
- Root видел у элемента `crossorigin=anonymous`. В этой сборке Chromium у элемента служебного документа атрибуты `controls, autoplay, name`, медиазапрос идёт без Origin.
  - Если живой Chrome действительно ставит `crossorigin`, запрос из sandbox-документа будет CORS с Origin `null`, и понадобится отдельное решение.
  - Например, `Access-Control-Allow-Origin` только на этом публичном маршруте для файлов без учётных данных. Оно не добавлялось: нет доказательства, и глобальный CORS поручение запрещает.
