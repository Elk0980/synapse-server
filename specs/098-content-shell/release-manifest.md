# Выпуск сборки №98: список файлов

Ветка `claude/night98-integration`. Составлено 05.11.2026, Бангкок. Документ перечисляет файлы для выпуска и не даёт разрешения на выпуск. Выпускает координатор.

## Влитые PR (merge-коммиты, по порядку)

| PR | Ветка | head | Что |
|---|---|---|---|
| 514 | claude/night98-a-shell-a | 5f3b98c | каркас, основа ветки (уже на main и на живом сайте) |
| 515 | claude/night98-a-settings | 09d7c2c | Настройки → Контент |
| 513 (+502, +496) | claude/content-plan-screen-20261105 | bbd4612 | контент-план; внутри 502 @623d46b и 496 codex/reel-plan-import-20261104 |
| 512 (+503, 505, 506) | claude/shooting-board-20261105 | d38a7cb | съёмка: список, суфлёр, загрузка, раскадровка |
| 508 (+501, 507) | claude/night98-reel-editor | 37388d7 | материалы и редактор |
| 509 (+504, +493) | claude/night98-chats-ui | 4d4767a | чаты, «Мои задачи», Хью; внутри 504 @6fbd1cf и 493 @4fb84d1 |
| 511 (+510) | claude/night98-connections-stats | cea711b | подключения и статистика |
| 516 | claude/app-icon-synapse-20261105 | 94434cc | значок «Синапс» |

Правки самой сборки:
- модули перенесены из `cabinetAssets`/`cabinetStyles` в `shellAssets`/`shellStyles` (контракт А v2.1);
- одна версия ассетов `20261105-night98-integ`;
- фикстура `ops/content/reel-materials-chat.test.js` совместима с миграцией комнат 504.

## Статика (sites/synapse → корень сайта)

Файлы `cabinet.html` и `cabinet/people.html` правятся патчем, без замены целиком. На живом сайте они отличаются от main.
- `specs/098-content-shell/cabinet-html.integration.patch` — от main (после 514). Контекст первого блока подстроен под живую копию: перед `</head>` там стоит строка `sites-projects.css`.
- `specs/098-content-shell/people-html.integration.patch` — живая версия совпадает с main.
- Лог проверки: `specs/098-content-shell/cabinet-html.integration.dryrun.txt`. Команда `patch --fuzz=0`, FAILED и fuzz нет.

Изменённые файлы. 05.11 живые версии совпали с main побайтно, поэтому их можно заменить целиком:
`board.webmanifest`, `manifest.webmanifest`, `cabinet/people.webmanifest`, `cabinet/autoposting.js`,
`cabinet/media-mentor.js`, `cabinet/media-mentor.css`, `cabinet/team-chat.html`, `cabinet/team-chat.js`, `cabinet/team-chat.css`.

Новые файлы:
- `brand/`: `app-identity.js`, `synapse-icon-32.png`, `synapse-icon-180.png`, `synapse-icon-192.png`, `synapse-icon-512.png`, `synapse-icon-512-maskable.png`;
- корень: `manifest-palitra.webmanifest`;
- `cabinet/`: `content-settings.{js,css}`, `reel-plan-import.js`, `content-plan.{js,css}`,
  `shooting-script.js`, `shooting-upload.js`, `shooting-prompter.js`, `shooting-board.js`, `shooting.{js,css}`,
  `materials.{js,css}`, `reel-editor.{js,css}`, `chats.{js,css}`, `my-tasks.js`,
  `content-connections.{js,css}`, `content-stats.js`, `people-palitra.webmanifest`.

Порядок в `shellAssets`: module-registry, content-settings, reel-plan-import, content-plan, shooting-script, shooting-upload, shooting-prompter, shooting-board, shooting, materials, reel-editor, chats, my-tasks, content-connections, content-stats.

## Серверы

**ops/content** (образ копирует `*.js`):
- новые: `content-settings.js`, `content-plan-approvers.js`, `shooting.js`, `shooting-storage.js`, `shooting-sketch.js`, `reel-materials-chat.js`, `team-chat-answers.js`;
- изменённые: `server.js`, `team-chat.js`, `people-service.js`, `people-http.js`, `people-tasks.js`, `people-crm-client.js`, `media-mentor-suggest.js`.

**ops/crm**. Образ меняется: `Dockerfile` переходит на `npm ci` по `package-lock.json`, в `package.json` добавлены зависимости `fflate`, `read-excel-file`, `saxen` (импорт XLSX, PR 496). Нужна пересборка образа.
- новые: `content-plan-workspace.js`, `reel-plan-file.js`, `reel-materials.js`, `reel-materials-http.js`, `people-board.js`, `content-connections.js`, `metrika-site-source.js`, `package-lock.json`;
- изменённые: `server.js`, `media-mentor.js`, `media-mentor-http.js`, `people-http.js`, `team-chat-task.js`.

Только для разработки, не выпускать: `ops/dev/chats-preview.cjs`, `ops/dev/team-chat-preview.cjs`.
CI: `.github/workflows/project-chat-check.yml`, `.github/workflows/team-chat.yml`.

Настройки, которые читает код. Значения и ключи здесь не меняются.
- content: необязательный приватный файл `shooting.json` рядом с базой (лимиты загрузки; если его нет, действуют значения по умолчанию); `ASSETS_DIR`; `HUGH_RUNTIME_URL` и `CHAT_API_KEY` для эскизов и ответов Хью — уже существующие.
- crm: необязательные `CONTENT_CONNECTIONS_DECLARED` и `CONTENT_CONNECTIONS_SITES_DIR`.

## Миграции

Все миграции добавляют таблицы через `CREATE TABLE IF NOT EXISTS` или колонки после проверки `PRAGMA`. Существующие данные не переписываются.

| Сервер | Таблица / изменение | Модуль |
|---|---|---|
| content | `content_settings` | content-settings.js (515) |
| content | `shooting_uploads`, `shooting_reels` + индексы | shooting.js (503) |
| content | `shooting_sketches` + индекс | shooting-sketch.js (512) |
| content | `team_chat_messages` + колонки `room`, `kind`, `ref_task_id`, `audience_id`, индекс `team_chat_room_idx` | team-chat.js (504) |
| content | `team_chat_answers` | team-chat-answers.js (493) |
| crm | `content_plan_questionnaires`, `content_plan_signoffs` | content-plan-workspace.js (502) |
| crm | `reel_materials`, `reel_versions`, `reel_edits` | reel-materials.js (501) |
| crm | `people_task_prefs`, `people_task_comment_receipts` | people-board.js (504) |

Перед выпуском сделайте резервные копии баз content и crm: колонки `team_chat_messages` нельзя откатить простым откатом кода.

## Проверки сборки (05.11, Бангкок)

- `node --check`: ops/content/server.js, ops/crm/server.js, ops/chat/server.js, ops/hugh-runtime/server.js, ops/tasks-mcp/server.js и все изменённые js — без ошибок.
- `node --test ops/content`: 797 тестов, 788 пройдено, 0 падений, 9 пропущено (на main: 765, 756, 0, 9).
- `node --test ops/crm`: 1051 тест, 2 падения. Те же 2 падают на main: «notification priority mirrors SMTP…» и «board products and plan use existing cabinet session…».
- `node --test sites/synapse/cabinet` и `sites/synapse/*.test.cjs`: 1073 теста, 3 падения. Те же 3 падают на main: `company-links.test.cjs` (2) и `editors.test.cjs` (1).
- Playwright 390 и 1440, настоящий cabinet.html с заглушкой API: Контент-план, Съёмка (список и рилс), Материалы, Постинг, Подключения, Статистика, Задачи, Мои задачи, Чаты, Настройки → Контент, плавающий Хью — всего 24 снимка. Горизонтальной прокрутки нет, ошибок консоли 0, «Модуль не открылся» и «Скоро» не появляются. На «Постинге» кнопки «Создать публикацию» нет.
