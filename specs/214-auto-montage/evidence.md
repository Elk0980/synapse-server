# Доказательства (07.11.2026, локально; production не трогался)

Состояние: **реализовано и проверено локально**. Не подключено, не проверено в рабочей системе, не принято.

## Тесты (ffmpeg 6.1.1, Node 22; клипы генерируются lavfi во временной папке, медиа в репозитории нет)

```
node --test ops/montage/render.test.js ops/montage/worker.test.js ops/content/montage-gateway.test.js \
  ops/crm/reel-materials-montage.test.js ops/crm/reel-materials.test.js ops/crm/reel-materials-http.test.js \
  ops/crm/content-stages.test.js ops/content/shooting*.test.js ops/content/compose-contract.test.js
# tests 42 · pass 42 · fail 0
```

- `render.test.js`: аргументы (`-protocol_whitelist file`, путь с `;` отклонён, `%{pts}` в титре не попадает в граф, клип за концом
  исходника обрезан); EDL ffmpeg-ом — синий→красный→белый по цвету кадра, «без звука» < −60 дБ, 1,25× ≈ 2,4 с, обложка JPEG;
  громкость 0,5 ≈ −6 дБ; исходник без звука → в ролике тихая дорожка.
- `worker.test.js` (CRM-обработчик «Материалов» ← шлюз content ← воркер, всё по HTTP на 127.0.0.1):
  правка `kind:edl` → v2, `editId`, `done`, sha256 совпадает с файлом, `kind:request` остаётся `pending`, рабочая папка пуста;
  черновик: 401 без сессии, 409 без дублей, повтор — `duplicate`; ролик идеи создан с темой/площадками, «сцен 2 из 3; нет дубля:
  сцены 3; обрезана тишина: сцены 1; титры: 1», первый кадр — последний дубль сцены 1, конец — вставка сцены 2; повтор — v2;
  изоляция: неверный ключ 401, чужая компания 403, дубль/идея чужой компании 404, `..` в пути 404, не-видео 415;
  два сбоя рендера → `failed`, третий проход ничего не берёт.
- Визуальная проверка кадра обложки с титром 540×960 (кириллица, перенос строк, обводка) — просмотрена вручную.

## Прочее

- `node --check ops/content/server.js`, `node --check ops/crm/server.js` — ок.
- Настоящий `ops/content/server.js` запущен локально: без флагов `/content/internal/montage/jobs` → 401 (ключ не настроен);
  с `MONTAGE_ENABLED=1` + хеш ключа + `avokado` → 200 `{"jobs":[]}`; неверный ключ → 401; кабинет без сессии → 401.
- `docker compose -f docker-compose.yml -f ops/montage/compose.montage.yml config --quiet` — ок. Образ не собирался:
  в среде исполнителя нет демона Docker — сборка `ops/montage/Dockerfile` проверяется при выпуске.
- `python3 tools/spec-kit/gate.py check` — `status: ok`.
