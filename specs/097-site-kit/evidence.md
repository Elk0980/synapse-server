# Проверки

04.11.2026, Linux, Node 22.23.4, jsdom 26.1.0 (версия ops/content) во временном каталоге вне репозитория, Playwright 1.63.0 + предустановленный Chromium. База — origin/main fb59836.

## Состояние: реализовано / проверено локально. Не подключено к рабочей системе, не принято

- Не слито, не развёрнуто. Живой palitra-love.ru не совпадает с origin/main (H1, storefront.js на бою) — по сообщению оркестратора 04.11.2026; выкладка из main перезапишет живую главную. Подключение kit на палитре — одна вставка тегов на страницу, переносится на боевую версию отдельно.
- CI workflow site-kit ещё не запускался (запустится на PR); результат проверяется отдельно.

## Тесты

- `node --test sites/site-kit.test.cjs` — 10/10 PASS. Проверка, что тест ловит дефект: до запуска sync после правки select.js тест №1 упал с перечнем расходящихся файлов.
- `node --test sites/*.test.cjs` (site-kit, no-nested-site-copies, site-seo ALVI/Авокадо) — 21/21 PASS.
- `node tools/site-kit/sync.js --check` — синхронизировано, 28 файлов (4 копии + 24 страницы).
- Тесты palitra-love (`sites/palitra-love/*.test.cjs`, `assets/*.test.cjs`) — 75/76; единственные падения в `assets/order.test.cjs` (таймеры «двойной клик», «429/503», «прайс грузится») есть и на чистом main без изменений: main 9/11 и 8/11, ветка 10/11 и 10/11 — нестабильные по времени тесты, kit они не загружают. Не исправлялись (вне границ).
- `python3 tools/spec-kit/gate.py check` — PASS, verifiedFiles 48.
- Word-diff palitra-love: в 24 html изменилась только вставка `<link …/assets/kit/theme.css|fields.css|select.css?v=…>` и `<script …/assets/kit/select.js?v=… defer>` сразу после `styles.css`; удалений нет; тексты, цены, JSON-LD не тронуты. `assets/styles.css` не менялся.

## Браузер (Chromium, tools/site-kit/browser-check.js)

Страницы `/`, `/oferta/` (видимая форма), `/catalog/`, `/price.html` (список только в корзине — скрипт открывает её через `[data-cart-open]`) palitra-love, итоговая версия — по 7/7 ok: appearance none у всех select; клик по тексту подписи открывает список, Escape закрывает; выбор «Telegram» мышью меняет нативный select и order.js показывает поле ника Telegram (код сайта получил change); клавиатура ArrowDown/Home/Enter, видимый outline фокуса; программное `select.value='max'` обновляет кнопку; значение в FormData; телефон 390px (isMobile+hasTouch): системный список, контрол оформлен.

Найдено браузерной проверкой и исправлено: Escape в открытом списке всплывал до `document` и order.js закрывал всю корзину (на `/catalog/`, `/price.html` первый прогон 3/7). Теперь Escape открытого списка не всплывает (как у системного select); закрытый список Escape не перехватывает — покрыто тестом jsdom.

## Скриншоты (вне git)

`/home/claude/wt-kit-shots/before` — checkout main fb59836, `/home/claude/wt-kit-shots/after` — ветка; по 24 страницы × 1280/390, `__open.png` — раскрытый список на 1280, `report.json` — computed appearance каждого select. После: 0 системных select на palitra-love (48 снимков). Обзор `--all-sites`: системные select остались только на board (отложен в sites.json как внутренняя доска).

## section-backdrop под видеофоном (FR8) — только анализ

Корень: `ops/content/tag_site.py` при разметке сайта записывает в `data/site.json` для каждой секции `background.default` — картинку статического `.section-backdrop`, найденного в исходной вёрстке. `applyBackgrounds()` в `site-apply.js` рисует `bg.image || bg.default` и создаёт слой, если его нет. Когда позже вёрстка убирает статический фон (секция стала прозрачной над общим видео `#herovid`), `default` в site.json остаётся, и site-apply снова вставляет подложку поверх видео. Пример avokado3: `top.background.default = assets/hero-poster.jpg`, `method-3.background.default = assets/consult-green-wall.webp`; лечится в каждом сайте CSS-заплатками `#top>.section-backdrop{display:none}`, `#method-3>.section-backdrop{display:none}`, `#method-5.work-steps-ready>.section-backdrop{display:none}`.

Общего места сейчас нет: `site-apply.js` — 4 разные копии (alvi, avokado, avokado2, avokado3), `tag_site.py` в ops/content. Предлагаемая следующая задача (вне границ этого PR):
1. В `applyBackgrounds`: `default` только обновляет существующий статический слой; новый слой создаётся лишь для явной картинки владельца (`if (!bg.image && !layer) continue`).
2. В `tag_site.py`: не записывать `default` для секций без статического слоя / с видеофоном.
3. Вынести `applyBackgrounds` в `sites/_kit/site-apply-backgrounds.js` и раздать через тот же `sync.js`, затем убрать per-site заплатки после скриншотов до/после.

## Доработка по ревью PR 487 (04.11)
- select.js: поиск по буквам при скрытом выбранном пункте (start = -1) больше не даёт TypeError; тест падает на прежнем коде и проходит на новом.
- aria-label без связанной подписи: ближайший `<label>` рядом, затем placeholder/пустой первый пункт; иначе атрибута нет (select.name не используется).
- palitra-love: `--kit-control-weight: 700` — значение в списке той же жирности, что поля ввода (computed: input 700, kit-кнопка 700).
- site-kit.yml: actions закреплены по SHA (checkout v4.4.0, setup-node v4.4.0, upload-artifact v4.6.2).
- Проверки: site-kit + site-seo + no-nested — 23/23; `sync.js --check` — ок; browser-check `/` и `/oferta/` — ок; скриншоты 48, системных select 0 (вне git).
