# План (редакция 2)

1. `ops/crm/autoposting.js`
   - `mediaOnlyStoryRow(row)`: материал есть, текст пуст, подписей нет, и `meta.format==='story'` или `platformOptions.instagram.is_story===true`. Используется в `readiness`: замечание о тексте не добавляется.
   - `storyTarget(row, platform)`: `platform==='instagram' && platformOptions.instagram.is_story===true`.
   - `schedulePrepared`: для такой карточки общий запрет текста заменяется поканальным. Каждый канал из `data.platformIds` должен быть `storyTarget` по фактической площадке канала (`channelPlatform`), иначе 409 `MEDIA_ONLY_TARGET` с названием канала. Проверки согласования/подключения/даты/профиля/расписок остаются на своих местах. Удаляется запрет MEDIA_ONLY_MANUAL из редакции 1.
   - `calendarReadiness`: для такой карточки у не-Story площадки — та же причина; у Instagram в режиме Story — замечания о тексте нет.
2. `ops/crm/autoposting-transport.js`
   - `publish`: пустой текст допустим, только если `channelId==='instagram'`, `row.provider==='onlypult'`, `post.platformOptions.instagram.is_story===true` и `media.length>0`. Иначе прежний `CONTENT_LIMIT`.
3. `ops/crm/onlypult-provider.js`
   - Редакция 3: по `PostCreateRequest` (`content` обязателен только без `media_urls`/`media_ids`) сторис без текста отправляется без поля `content`. Сторис с текстом отправляет `content`, как прежде.
   - Для не-Story режима или без материала пустой текст отклоняется (`CONTENT_LIMIT`) — вторая защита после транспорта.
   - Временный флаг и код остановки редакции 2 удаляются. Особый код в очереди и текст в кабинете тоже удаляются.
4. `sites/synapse/cabinet/autoposting.js`
   - `mediaOnlyStory(data)` учитывает оба признака.
   - `problems()`: для таких данных по каждому целевому каналу — площадка Instagram и опция Story, иначе причина с названием канала.
   - Общая причина редакции 1 удаляется.
5. Версия ассетов `20260930-story-publish`.
6. Тесты:
   - целевые в `autoposting.test.js`, `autoposting-onlypult-flow.test.js`, `autoposting.test.cjs`;
   - полные прогоны `ops/crm` и `sites/synapse/cabinet`;
   - `node --check`, `git diff --check`, `gate.py check`, converge.

Стоимость: внешних вызовов нет, миграций нет. Живую отправку делает root после подключения.
