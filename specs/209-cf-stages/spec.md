# 209 · Контент-завод: этапы идеи с сервера

Пакет G ночного выпуска 07.11.2026 (задачи доски №204/№192). Клиентские вкладки (cf-kit.js, content-plan.js, shooting*.js, materials.js) уже в main и сами угадывают этап по косвенным данным. Сервер отдаёт факты и вычисленный этап, только добавочными полями.

## Цель

Этап меняется сам по конкретному действию (решение Влада): решение по сценарию, загрузки съёмки, монтаж, публикация. Кнопок «подтвердить этап» нет. Без факта этап не выдумывается.

## Сценарии

1. СММ открывает «Контент-план» — у каждой идеи `stage` (id из CfKit.STAGES) и `publications`.
2. Оператор загрузил дубли на все кадры раскадровки — идея «Отснято» без нажатия кнопок.
3. Монтажёр загружает ролик к рилсу плана (`ideaId`) — «Монтаж на согласовании»; повторная загрузка — новая версия того же ролика.
4. Просьба правки к ролику — «Монтаж на доработке»; карточка с роликом согласована — «Готово к выходу».
5. Публикация запланирована / вышла / ошибка — «Запланировано к выходу» / «Опубликовано» со ссылкой / «Ошибка публикации».
6. Ролик снят вне плана (`offPlan: true`) — черновик идеи в плане, если это не сбрасывает решение по плану.
7. Вкладки знают часовой пояс компании.

## Требования

- FR-1. `GET /media-mentor`: у каждой `plan.days[i]` добавочные `stage`, `stageSource` (publication|montage|shooting|plan|script), `publications: [{platform, status, url, publishedAt}]`; у плана `stageFacts` (`shooting` true/false, `unpublished: false`, список id этапов).
- FR-2. Порядок: публикация → монтаж → съёмка → черновик/ручной статус плана → решение по сценарию. Сценарий: rejected → script_rework, pending → script_review, approved (или весь план согласован) → planned, нет версии с текстом → draft.
- FR-3. Съёмка: факты из базы content передаются CRM только прокси content доверенным заголовком `x-synapse-shooting-facts` (присланный браузером удаляется; CRM сверяет компанию). Все кадры раскадровки сняты → shot; без раскадровки — хотя бы один дубль (как summary() съёмки); черновик монтажа → edit_review; ручной «в монтаже» → editing.
- FR-4. Монтаж: у ролика «Материалов» идеи есть версии → edit_review; открытая правка → edit_rework; связанная карточка с роликом согласована для текущей версии содержимого → ready.
- FR-5. Публикации идеи: перенос версии плана (media_mentor_variant_transfers) и ролик идеи (reel_materials.idea_id → post_id). scheduled/publishing → scheduled; доставка published или отметка «вне ЛК» текущей версии → published (ссылка от площадки/отметки); failed/needs_review → publish_error. unpublished сервер не выдаёт: факта «снято с публикации» в CRM нет.
- FR-6. `POST /autoposting/reels` принимает необязательный `ideaId`: идея ищется только в плане своей компании (404 иначе), связь сохраняется в `reel_materials.idea_id`, в ответе `ideaId`, `planLink: {ideaId, source:'materials'}`. Есть ролик идеи (прямая связь или через перенесённую публикацию) → существующий `addVersion`, ответ 200 с `appended: true, appendedVersion`.
- FR-7. `offPlan: true` (несовместим с `ideaId`) → черновик идеи (`productionStatus: draft`, `format: reel`) через обычный `savePlan`, только пока план целиком в статусе pending. Иначе ролик сохраняется без связи, `offPlan: {created:false, reason}` (PLAN_DECIDED, PLAN_ABSENT, PLAN_REJECTED, NO_PLATFORM, NOT_CONFIGURED).
- FR-8. `GET /media-mentor`: `company: {code, timeZone, timeZoneSource}` из `companies.timezone` («Сведения о компании»); пусто → `timeZone: null, timeZoneSource: 'unset'`, значение не выдумывается.
- FR-9. Совместимость: только добавочные поля; `PUT /media-mentor/plan` отбрасывает присланные обратно `stage/stageSource/publications` (идея с ними сохраняется без новой версии). Права, ключи, MANAGED_RELEASE_BLOCKS_LEGACY_SYNC не меняются.

## Приёмка

Тесты `ops/crm/content-stages.test.js`, `ops/content/shooting.test.js` (факты), `ops/content/content-stages-proxy.test.js` (настоящие content+CRM) проходят; соседние наборы crm/content без новых падений; `python3 tools/spec-kit/gate.py check` OK.

## Ограничения

Сервер выпускается только вручную Root (managed-release). Не выдумывать этапы и данные. Изоляция компаний проверяется на сервере. Клиентские файлы этим PR не меняются.
