# План
Владелец: Claude · Б Контент-план (№98, доска №102). База: PR 496 (`codex/reel-plan-import-20261104`, head 761464e); ревью — Claude-ревьюер, приёмка — оркестратор.

(а) Сервер. Новый `ops/crm/content-plan-workspace.js`: таблицы `content_plan_questionnaires`, `content_plan_signoffs`; согласующие — внедряемая функция `approvers(code)` (заглушка «Владелец»). Маршруты в существующем `media-mentor-http.js`: `GET/PUT /media-mentor/questionnaire`, `GET/POST /media-mentor/plan/signoffs`; GET `/media-mentor` отдаёт `questionnaire`. Прокси content-сервиса уже пропускает `/media-mentor/*` с сессией, CSRF и правами автопостинга — его не меняем, кроме одной строки `loadBrief` для подсказки. `media-mentor.js`: поля `broll/style/props`. Подключение в `ops/crm/server.js` — одна строка.

(б) Клиент. Новый `sites/synapse/cabinet/content-plan.js` + `.css`; регистрация в реестре `SynapseModules` и в `SbCabinet.registerView`. Переиспользуем `/content/media-mentor-suggest`, `PUT /media-mentor/plan`, импорт PR 496.

Файлы чужих агентов не трогаем. Проверки: `node --test ops/crm/content-plan-workspace.test.js`, связанные тесты media-mentor/reel-plan/people-friday, jsdom, Playwright.
