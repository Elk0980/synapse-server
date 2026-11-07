# План 224 — «Убрать» и «Архив»

Владелец работы — Claude (ветка `claude/cf-archive`). Разрешённая область: файлы ниже. Чужие ветки и PR, права, ключи и развёртывание не трогаются.

## Что уже было (переиспользуем)
| Сущность | Хранилище | Было | Решение |
|---|---|---|---|
| Публикация | `autoposting_posts` (`archived_at`, `archived_by`), `autoposting-recovery.js` | архив и восстановление черновика, «Удалённые материалы» | расширить: `reason`, `confirmPublished`; опубликованное — только пометка архива без смены статуса |
| Ролик | `reel_materials` | нет | добавочные колонки `archived_at`, `archived_by`, `archive_reason`, журнал `reel_archive_events` |
| Версия ролика | `reel_versions` | нет | те же добавочные колонки |
| Строка плана | `media_mentor_plans.plan.days` (JSON, версии неизменяемы) | только пересохранение плана | отдельная метка `media_mentor_idea_archive` с копией строки, фильтр в `planOf` |

Почему строка плана не хранит архив внутри JSON плана: любое сохранение плана создаёт новую версию и сбрасывает согласование. Метка рядом с планом убирает строку без новой версии. Все чтения внутри `media-mentor` идут через `planOf`, поэтому план, решения по версиям, согласование целиком, отметки согласующих (`content-plan-workspace` читает `mentor.get`) и этапы (`content-stages.apply`) видят план без убранных строк. Замечания к строкам привязаны к индексу сохранённой версии, поэтому `addFeedback` читает сырой план.

## Контракты (новые и расширенные)
- `POST /media-mentor/plan/ideas/:ideaId/archive {reason?}` → снимок `/media-mentor` с `archivedIdeas`.
- `POST /media-mentor/plan/ideas/:ideaId/restore {}` → снимок.
- `GET /media-mentor` → новое поле `archivedIdeas[]: {ideaId,date,platform,format,topic,inPlan,archive:{archivedAt,archivedBy,archivedByName,reason}}`.
- `GET /autoposting/reels?archived=1`; `POST /autoposting/reels/:id/archive {reason?}`, `…/restore {}`; `POST /autoposting/reels/:id/versions/:v/archive {reason?}`, `…/restore {}`. В ответе ролика новые поля: `archive`, `archivedVersions`, а в полной карточке ещё `archivedVersionList`.
- `POST /autoposting/posts/:id/archive {revision, reason?, confirmPublished?}`. Поле `archive.reason` в DTO публикации.

Прокси content уже пропускает `/autoposting/*` и `/media-mentor/*` с проверкой сессии, права `autoposting.edit` для записи и CSRF, поэтому изменений в прокси нет.

## Миграции
Только добавочные: `ALTER TABLE … ADD COLUMN` (идемпотентно, при старте) и `CREATE TABLE IF NOT EXISTS`. Существующие строки не меняются. Откат кода оставляет колонки пустыми. Старый код их игнорирует, но строки плана с меткой снова становятся видимыми.

## Файлы
- Сервер (`ops/crm/*`, выпускается вручную): `media-mentor.js`, `media-mentor-http.js`, `reel-materials.js`, `reel-materials-http.js`, `autoposting-recovery.js`, `autoposting.js` (поле DTO), `content-stages.js` (убранный ролик не двигает этап), `media-mentor-transfer.js` (перенос по версиям площадок пропускает убранные строки).
- Кабинет (`sites/synapse/cabinet/**`, раскатывается автосинком): `content-plan.js/.css`, `materials.js/.css`, `autoposting.js/.css`.
- Тесты: `ops/crm/content-archive.test.js` (новый), `media-mentor-http.test.js`, `media-mentor.test.js` (список таблиц), `media-mentor-transfer.test.js`, `cabinet/materials.test.cjs`, `content-plan.test.cjs`, `autoposting-daily.test.cjs`.

## Порядок выпуска
Сначала CRM, потом кабинет. Кабинет без нового сервера: «Контент-план» не показывает кнопок, потому что нет `archivedIdeas`. «Монтаж» показывает кнопки, но сервер ответит 404, и в окне подтверждения появится сообщение «Не удалось убрать». Ничего не ломается и не пишется.

## Проверки
Тесты из spec.md, полный набор `ops/crm` (сравнение с `origin/main`), полный набор кабинета, gate, скриншоты стенда (настоящие JS и CSS кабинета, SAMPLE-данные, headless Chrome).
