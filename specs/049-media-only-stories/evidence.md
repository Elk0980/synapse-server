# Проверка: сторис без подписи — от черновика до очереди и отправки

Дата: 30.09.2026. Исполнитель: Claude, единственный автор, второго писателя нет. Модель сессии настроена как `claude-opus-5-5`; фактическую обслуживающую модель платформа может заменить, это не проверялось.

Среда:
- изолированная облачная копия `Elk0980/synapse-server`, ветка `claude/story-publish-20260930` от `origin/main` 7eff08c;
- Linux, Node 22.22.2; на Windows и в CI не запускалось.

Конституция `.specify/memory/constitution.md` 1.0.0 и `docs/spec-kit-policy.md` прочитаны в этой копии и совпадают с принятой копией `palitra-editor-ux-20260924` по SHA256.

Production, ЛК, STATE, права, ключи, подключения, другие компании и Windows-репозиторий не менялись. Ничего не публиковалось.

## Порядок работы — честно
1. **Редакция 1.** Код написан до спецификации; converge → T006/T007. Промежуточный патч сохранён отдельно.
2. **Редакция 2.** Сначала spec/plan/tasks, потом T008–T012; converge → T014–T016. Отправка была временно закрыта до подтверждения контракта. Промежуточный патч v2 сохранён отдельно.
3. **Редакция 3** (замечание приёмки root). Root подтвердил контракт по первичной схеме, исполнитель прочитал сохранённую копию.
   - T017/T018: временная остановка снята; для сторис без текста поле `content` не отправляется.
   - Converge (проход 1 и единственный): расхождений нет, tasks.md после Phase 4 не менялся.

## Первичные источники
- **Onlypult OpenAPI** `https://onlypult.com/dev/openapi.yaml`.
  - Root получил её 30.09 в 23:26: HTTP 200, `application/octet-stream`, UTF-8 YAML.
  - Копия `ONLYPULT_OPENAPI_ROOT_REVIEW_20260930.yaml`, SHA256 `24a69953267e6066a3b76759f0c765e54c1e7fcafdbc2c09766c8d8a568e2479`. Исполнитель разобрал её YAML-парсером: `openapi: 3.0.3`, `info.version: 1.0.0`.
  - `PostCreateRequest.required = [profile_ids]`.
  - `content`: `{type: string, description: "Post text/content. Required unless media_ids or media_urls is provided."}`, без `minLength`.
  - `media_urls`: до 10 URI.
  - `PlatformSettings.is_story`: «Story (Instagram, Facebook, VK). Mutually exclusive with is_reels, is_shorts».
  - Описание `POST /posts`: «At most one of is_story / is_reels / is_shorts per platform key».
- **Instagram Graph API `POST /{ig-user-id}/media`:** `caption` описан для изображения, видео и карусели; у `STORIES` — `media_type` и `image_url`/`video_url`.
- **Onlypult FAQ по Stories:** только бизнес-аккаунты; при нескольких вложениях автоматически планируется первое.

**Выбор тела запроса.** Контракт делает `content` необязательным при `media_urls` и не требует пустой строки. Поэтому сторис без текста отправляется **без поля `content`**; `""` не используется. Схема подтверждает контракт, но не доступ конкретного профиля — это проверяется живой отправкой (T019).

## Проверено (FR)
- **FR-001/002:**
  - Сохранение и готовность по `format='story'` и по `is_story` без формата (сервер и DOM).
  - Прежние отказы: без материала; пост/Reels/карусель без текста; несверенный SHA256 пакета.
- **FR-003:**
  - Instagram в режиме Story: согласование версии → очередь → транспорт с `text:''`, `platformOptions`, материалом.
  - `MEDIA_ONLY_TARGET` с названием канала для Telegram, ВК, Instagram без Story или с `is_story:false`, для смешанного набора каналов и для компании без обязательного согласования. Согласование при этом откатывается.
  - Gates сохранены: `APPROVAL_REQUIRED`, согласование только другой площадки, время в прошлом, `CHANNEL_NOT_CONNECTED`.
  - Сообщения говорят о транспорте Synapse, а не о правиле площадки.
- **FR-004:** реальный транспорт отклоняет пустой текст для Instagram `{}`, `is_story:false`, `is_reels:true` и сторис без материала — `CONTENT_LIMIT`, ноль POST.
- **FR-005:**
  - Поток «очередь → реальный транспорт → заглушенный Onlypult»: ровно один POST с ключами `media_urls`, `platform_options`, `profile_ids`, `publish_now`, без `content`; `platform_options.instagram.is_story:true`.
  - Затем `needs_review` без ссылки и без повторного POST.
  - Сторис с текстом отправляет `content`.
  - Провайдер отклоняет пустой текст вне Story и сторис без материала до POST.
- **FR-006:**
  - Календарь: у Instagram Story нет замечания о тексте, у Telegram — точная причина.
  - Редактор: у Telegram причина и выключенная постановка; у Instagram с «Публиковать как Story» постановка доступна.
- **FR-007/008:** временный флаг, код остановки, опция фабрики, особый код очереди и текст кабинета удалены (`grep` пуст). Новых настроек нет.

## Команды и результаты

| Проверка | Результат |
|---|---|
| `node --test ops/crm/autoposting*.test.js` (с onlypult-flow) | 141/141 PASS |
| `node --test --test-concurrency=1 ops/crm/*.test.js` | 595: 594 PASS, 1 fail — `email-campaigns.test.js` «notification priority…», падает и на чистом 7eff08c, к задаче не относится |
| `node --test sites/synapse/cabinet/*.test.cjs` | 637/637 PASS |
| `node --check` четырёх изменённых модулей | PASS |
| `git diff --check` | PASS |
| `check_prerequisites.py` (SPECIFY_FEATURE_DIRECTORY=specs/049-media-only-stories) | PASS |
| `python3 tools/spec-kit/gate.py check` | ok, 48 файлов |

## Состояние
Реализовано и проверено локально. Не подключено, в рабочей системе не проверено, не принято. Живую отправку проверяет root только после подключения профиля Instagram через Onlypult и согласования конкретного материала (T019).
