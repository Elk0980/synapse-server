# План

Владелец исполнения: Claude-исполнитель (доска №214), проверяющий — Claude-оркестратор. Один автор на файлы ниже.

## Где работает ffmpeg

Отдельный контейнер `montage` (`ops/montage/Dockerfile`: node:24-alpine + ffmpeg + font-dejavu, без npm-зависимостей),
подключаемый вторым compose-файлом `ops/montage/compose.montage.yml`. Почему не внутри content: рендер долгий и тяжёлый по CPU,
content обслуживает кабинет; падение или OOM ffmpeg не должно ронять кабинет. Почему не на компьютере владельца: дубли лежат
на томе сервера, гонять гигабайты наружу дороже, чем считать на месте.

Лимиты сервера (по умолчанию, меняются через `.env`): `cpus: 1.5` (`MONTAGE_CPUS`), `mem_limit: 1536m` (`MONTAGE_MEM`),
`pids_limit: 128`, `-threads 2` (`MONTAGE_THREADS`), одно задание за раз, опрос раз в 60 с, таймаут процесса 20 мин.
Диск: том `montage_work`; до скачивания проверяется свободное место ≥ 3× исходников + 2 ГБ (`MONTAGE_MIN_FREE_MB`); исходник
≤ 4 ГБ (`MONTAGE_MAX_INPUT_MB`), результат ≤ 60 МБ (= `MAX_PUBLISHING_VIDEO_BYTES` content); папка задания удаляется всегда.
На сервере ~77 ГБ с квотой «Съёмки» 40 ГБ на компанию — без проверки места ffmpeg мог бы съесть резерв диска кабинета.

## Безопасность

- Сеть: `montage` только во внутренней сети `montage_internal` (`internal: true`, без выхода наружу); `content` в ней тоже.
  Воркер обращается только к `http://content:8080/content/internal/montage/*`.
- Ключи: у воркера только свой `MONTAGE_WORKER_KEY`; content хранит его SHA-256 (как у локального обработчика Хью).
  Ключ CRM воркеру не выдаётся — шлюз content сам ходит в существующий служебный API CRM.
- Компании: `MONTAGE_WORKER_COMPANIES`; шлюз отклоняет чужую компанию (403), дубль ищется по паре (компания, id),
  базовая версия — только `publishing-assets/<своя компания>/<hex>.mp4`; CRM повторно проверяет хост и компанию ссылки версии.
- ffmpeg: `-protocol_whitelist file` для каждого входа (защита от плейлистов/ссылок внутри присланного файла),
  `spawn` массивом без оболочки, пути только `[A-Za-z0-9_/.-]`, титры через `textfile` + `expansion=none`, контейнер
  `read_only`, `cap_drop: ALL`, `no-new-privileges`, пользователь `node`.
- Публичный путь `/content/internal/montage/*` проходит через caddy, но без ключа отвечает 401; при включённом флаге
  рекомендуется дополнительно закрыть этот путь в caddy (отдельное решение, этим PR не меняется).

## Существующие модули и контракты

| Модуль | Изменение |
|---|---|
| `ops/crm/reel-materials.js` | + `ideaInfo`, `addIdeaVersion` (добавочно; схема таблиц не меняется) |
| `ops/crm/reel-materials-http.js` | + `GET /internal/reel-materials/ideas/:ideaId`, `POST …/ideas/:ideaId/versions` (только ключ сервиса) |
| `ops/content/shooting.js` | + `actor`, `takes`, `openTake` в возвращаемом объекте (только чтение) |
| `ops/content/montage-gateway.js` | новый: таблица `montage_jobs`, кабинет `/content/montage/drafts`, шлюз воркера |
| `ops/content/server.js` | +4 строки: создание шлюза и вызов `montage.handle` перед «Съёмкой» |
| `ops/montage/*` | новый воркер, движок, тесты, Dockerfile, compose-override |

Контракт шлюза (ключ воркера): `GET /queue` (правки `kind:edl` своих компаний, без `failed`), `POST /edits/:id/claim|fail`,
`POST /reels/:id/versions`, `GET /jobs`, `POST /jobs/:id/claim|done|fail`, `GET /ideas/:ideaId` (идея + дубли),
`POST /ideas/:ideaId/versions`, `GET /takes/:id`, `GET /assets/:code/:name`, `POST /assets` (MP4/JPEG ≤ лимита content).
Кабинет: `POST /content/montage/drafts {ideaId}` (autoposting.edit + CSRF; 201 / 200 duplicate / 409 NO_TAKES / 503 MONTAGE_OFF),
`GET /content/montage/drafts?ideaId=` (autoposting.view).

## Миграции

Новая таблица content `montage_jobs` (`CREATE TABLE IF NOT EXISTS`). CRM без миграций.

## Проверки

`node --test ops/montage/render.test.js ops/montage/worker.test.js ops/content/montage-gateway.test.js ops/crm/reel-materials-montage.test.js`
плюс существующие `ops/crm/reel-materials*.test.js`, `ops/content/shooting*.test.js`, `ops/content/compose-contract.test.js`;
`docker compose -f docker-compose.yml -f ops/montage/compose.montage.yml config --quiet`; `python3 tools/spec-kit/gate.py check`.

## Выпуск (делает оркестратор/Root после ревью)

1. Сгенерировать ключ: `openssl rand -hex 32` → `MONTAGE_WORKER_KEY` в `.env` сервера; его `sha256sum` → `MONTAGE_WORKER_KEY_SHA256`.
2. `MONTAGE_WORKER_COMPANIES=<код компании>`, `MONTAGE_ENABLED=1`, `MONTAGE_WORKER_ENABLED=1`.
3. В `.env` сервера добавить `COMPOSE_FILE=docker-compose.yml:ops/montage/compose.montage.yml` — тогда обычные
   `docker compose …`, включая автосинк `ops/synapse-sync` (`docker compose up -d --build`), берут оба файла.
   Без этой строки следующий автосинк пересоздаст content без переменных и без сети воркера: автомонтаж молча выключится
   (данные не теряются). Затем `docker compose up -d --build content montage`.
4. Проверка: `docker compose … logs montage` — «включён»; правка `kind:edl` на тестовом ролике → v2 в «Материалах».
Откат: `MONTAGE_ENABLED=0` / `docker compose … stop montage`; таблица `montage_jobs` остаётся и ничего не делает.
