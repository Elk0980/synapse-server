# Прямая ссылка на видео publishing-assets открывается и проигрывается в браузере

Процесс Spec Kit 1.0.0. Поручение root 01.10.2026 (PALITRA-MEDIA-PREVIEW-20261001), исполнитель — Claude, единственный автор.

## Контекст и факты
- Root открыл в Chrome сохранённый URL ролика `https://synapse.synapsebusiness.ru/content/publishing-assets/palitra-love/<32hex>.mp4`: у встроенного плеера `readyState=0`, `currentTime=0`, длительность неизвестна.
- HEAD того же URL: 200, `video/mp4`, `Content-Length` совпадает с оригиналом, `Accept-Ranges: bytes`, `inline`, `Content-Security-Policy: default-src 'none'; sandbox`.
- Маршрут GET/HEAD `/content/publishing-assets/<company>/<32hex>.<jpg|png|webp|mp4|webm>` в `ops/content/server.js` ставит этот CSP всем типам.
- При прямом открытии медиа-URL браузер строит служебный документ с элементом `<video src=URL>`. Этот документ получает CSP ответа. Элемент заново запрашивает тот же URL, и запрос проверяется по `media-src`. Без `media-src` действует `default-src 'none'` — загрузка запрещена.
- С изображениями этого не происходит: картинка — само тело документа, второго запроса нет.
- Встраивание того же URL в страницу кабинета (`<video>` в autoposting/media-mentor) подчиняется CSP страницы, а не ответа. У кабинета нет CSP, поэтому это место не было причиной.

## Сценарии
- US1: владелец или редактор открывает прямую ссылку на загруженный MP4/WebM. Плеер загружает ролик, его можно запустить и перемотать (Range 206).
- US2: прямая ссылка на изображение по-прежнему показывает картинку с прежней политикой.
- US3: неподдерживаемые типы, чужая компания и обход пути по-прежнему дают 404.

## Требования
- FR-001: для `mp4` и `webm` ответ GET/HEAD несёт `Content-Security-Policy: default-src 'none'; media-src 'self' https://synapse.synapsebusiness.ru; sandbox`. Разрешена только загрузка медиа с этого же адреса.
  - Явный origin страхует браузеры, у которых `'self'` в sandbox-документе считается непрозрачным.
- FR-002: для `jpg`, `png`, `webp` CSP остаётся `default-src 'none'; sandbox`.
- FR-003: не меняются:
  - `sandbox` без `allow-*`;
  - `X-Content-Type-Options: nosniff`, `Content-Type` по расширению;
  - `inline`-disposition, кэш `immutable`, `Accept-Ranges`, ответы 206 и 416;
  - шаблон пути и перечень типов, 404 для чужих компаний и обхода, 405 для прочих методов.
- FR-004: не добавляются `script-src`, `style-src`, `connect-src`, `frame-src`, `unsafe-*`, `*`, `data:`, `blob:` и заголовки CORS. Загрузка (POST), авторизация, права, CSRF, приватные вложения и другие маршруты не меняются.
- FR-005: интерфейс кабинета не меняется.

## Приёмка
- SC-001: серверный тест `ops/content/company-modules-access.test.js`.
  - MP4 и WebM, GET с Range (206) и HEAD (200): точный CSP FR-001, только директивы `default-src`/`media-src`/`sandbox`, `sandbox` без исключений, `nosniff`, без `Access-Control-Allow-Origin`.
  - PNG: точный прежний CSP.
  - Путь `.html` — 404 без медиа-политики.
  - Прежние проверки прав, типов, лимитов, Range и 404 остаются.
- SC-002: браузерная проверка механизма в облачном Chromium — локальный сервер, реальный маршрут, существующий WebM из `sites/alvi/video/alvi-hero.webm`.
  - До правки: CSP-отказ, медиазапроса нет.
  - После: медиазапрос с Range, плеер в состоянии playing, перемотка выполняется, CSP-ошибок нет.
  - MP4 в этой сборке Chromium без H.264 даёт ошибку демультиплексора, а не CSP. Это не проверка H.264.
- SC-003: root после выпуска открывает живой URL ролика в Chrome и на телефоне: загрузка, проигрывание, перемотка. До этого — реализовано и проверено локально, не выпущено, не принято.

## Границы
Один писатель — Claude, изолированная облачная копия от `origin/main` a03eab1.
- Изменяемые файлы: `ops/content/server.js` (маршрут GET/HEAD publishing-assets), `ops/content/company-modules-access.test.js`, `specs/051-publishing-video-preview`.
- Не трогаются: production, БД, ЛК, Telegram, Caddy, домены, права, ролики, материалы контент-плана.
