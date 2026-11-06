# Свидетельства 182 (этап а)

Состояние: **реализовано и проверено локально**. Не подключено и не проверено в рабочей системе: деплоя нет, реальные API не вызывались.

## Документация площадок (06.11.2026)
- Onlypult: локальная копия onlypult.com/dev/openapi.yaml, `postsDelete` — «Delete a draft or scheduled post», ответ 204.
- Telegram Bot API `deleteMessage` (текст ограничений через docs.aiogram.dev, зеркало Bot API): 48 часов; `can_post_messages` — свои сообщения в канале; `can_delete_messages` — любые.
- VK `wall.delete` (dev.vk.ru): ключ пользователя (Implicit Flow), право `wall`; ошибки 104/210/703.
- YouTube `videos.delete` (developers.google.cn): DELETE, scopes `youtube`/`youtube.force-ssl`/`youtubepartner`, 50 единиц, 204.
- Instagram IG Media (developers.facebook.com): Deleting поддерживается для постов, Stories, Reels, каруселей.
- TikTok Content Posting API: эндпоинта удаления опубликованного нет.

## Тесты (фактические цифры)
- `node --test ops/crm/autoposting-unpublish.test.js` — 5/5 pass (план целей, Telegram+Onlypult с журналом и сохранением карточки, отказ/неопределённость/сменённый канал/вышедший в Onlypult пост, границы компании и версии, права маршрута).
- `node --test` autoposting.test.js, autoposting-trash.test.js, autoposting-transport.test.js, autoposting-onlypult-flow.test.js, social-onlypult-flow.test.js + unpublish — 145/145 pass.
- `node --test sites/synapse/cabinet/autoposting.test.cjs` (jsdom 24.1.3) — 62/62 pass, включая новый тест кнопки, окна подтверждения, итога и скрытия кнопки без права правки.
- autoposting-cf23/cf26/daily.test.cjs — 68/68 pass.
- `visual.cjs` в Chrome (playwright-core 1.47.2, SAMPLE-данные, сеть заглушена): 390 px и 1440 px, окно и итог — горизонтальной прокрутки нет (doc 390/390, zone 334/334), ошибок страницы нет. Скриншоты `390-*.png`, `1440-*.png`.
- `python tools/spec-kit/gate.py check` — status ok.
- Все внешние вызовы в тестах — заглушки `fetch`; секреты в тестах фиктивные.
