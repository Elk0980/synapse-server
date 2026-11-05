# План

Изолированный worktree `/home/claude/wt-kit`, ветка `claude/site-kit-20261104` от origin/main fb59836. Один писатель — Claude. Разрешённые файлы: `sites/_kit/**`, `sites/palitra-love/**/*.html` (только теги подключения), `sites/palitra-love/assets/kit/**` (генерируется), `sites/site-kit.test.cjs`, `tools/site-kit/**`, `specs/097-site-kit/**`, `.github/workflows/site-kit.yml` (новый, `permissions: contents: read`).

## Как kit попадает на домен: выбран вариант копий

Проверено в `caddy/Caddyfile`: каждый сайт — свой `root * /srv/sites/<сайт>` (palitra — сниппет `palitra_site`), `try_files {path} {path}/index.html /index.html`. Запрос `/_kit/select.css` с домена palitra вернул бы `index.html` (SPA-fallback) с кодом 200 — тихая поломка. Варианты:

1. Общий маршрут Caddy `/kit/*` → `/srv/sites/_kit` для каждого домена. Отклонён: меняет `caddy/` (вне разрешённой области), требует деплоя Caddy, а у сайтов, раздаваемых другими способами (панель, черновики), снова разойдётся.
2. **Копии внутри сайта, генерируемые одним скриптом** — выбран. `tools/site-kit/sync.js` копирует файлы побайтно в `sites/<сайт>/assets/kit/`, генерирует `theme.css` из `sites/_kit/sites.json`, на страницах с select вставляет/обновляет теги с `?v=<sha256[:10]>`. Сайт остаётся самодостаточным (деплой каталога целиком работает, как сейчас), правка — в одном месте, расхождение ловит тест и CI (`sync.js --check`).

Каталог копии — `assets/kit`, не `_kit`: `sites/_kit` содержит `index.html` и тест `no-nested-site-copies` счёл бы `sites/<сайт>/_kit` вложенной копией сайта.

## Порядок каскада

kit подключается после стилей сайта. `select.css` использует селектор `select:not([multiple]):not([size])` (специфичность 0,2,1) — сильнее `select{background:…}` сайта, shorthand которого иначе стёр бы стрелку. `fields.css` целиком в `:where()` — правила сайта важнее, kit лишь закрывает неоформленное. Фокус kit — в `:where()`, поэтому собственный `:focus-visible` сайта сохраняется.

## Почему JS-список, а не `appearance: base-select`

Настраиваемый select (`appearance: base-select`) есть только в новых Chromium; Safari и Firefox его не поддерживают. Чтобы список был в стиле сайта во всех браузерах на ПК, `select.js` строит combobox по шаблону WAI-ARIA, оставляя нативный select источником значения. На сенсорных экранах сохраняется системный список. base-select можно добавить позже как отдельное улучшение CSS.

## Тема palitra-love

Из существующих переменных `assets/styles.css`: `--surface`, `--text`, `--muted`, `--accent`, `--shadow`, `--font-body`, радиус 10px как у полей сайта. Тема записана в `sites.json`, а не в `styles.css`, чтобы не трогать стили сайта и не зависеть от кеша `styles.css?v=`.

## Проверки

`node --test sites/site-kit.test.cjs` (jsdom 26.1.0 как в ops/content), соседние `sites/*.test.cjs` и тесты palitra до/после; `tools/site-kit/browser-check.js` в Chromium; `tools/site-kit/screenshots.js` до (checkout main) и после; `python3 tools/spec-kit/gate.py check`; word-diff palitra.

## section-backdrop (FR8)

Только анализ, см. evidence.md: исправление требует правки 4 копий `site-apply.js` в чужих сайтах и `ops/content/tag_site.py` — следующая задача.
