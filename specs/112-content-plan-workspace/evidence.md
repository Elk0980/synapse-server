# Свидетельства (локально, 05.11, Бангкок)

## (а) Сервер
- `node --test ops/crm/content-plan-workspace.test.js` — 5/5 PASS: анкета частями, 409 на устаревшую ревизию, отказ лишних полей и чужих площадок, изоляция alpha/beta; заглушка «Владелец» → стадия `smm`, `fridaySummary(approvedIdeas)` 0 → 7 → после снятия отметки 0; два согласующих — каждый только свою галочку (403 на чужую); правка `broll` возвращает план на согласование; пустая подпись → 409 и `emptyIdeas`; HTTP: view читает, view не пишет (403), GET `/media-mentor` отдаёт анкету, 405 на лишний метод.
- `node --test ops/content/media-mentor-suggest.test.js` — 44/44 PASS (новый тест: непустые поля анкеты в задании Хью, пустые — нет).
- `ops/crm`: reel-plan*, media-mentor*, content-plan-* — 185/185 PASS; `ops/content`: media-mentor*, people-friday, people-plan — 68/68 PASS.
- Полный `ops/crm` `node --test`: 1028 PASS, 3 FAIL; те же 3 падают на базе PR 496 без моих правок (1023 PASS, 3 FAIL): SMTP-уведомления, smoke-test, board products — окружение, не эта задача.
- `node --check` ops/crm/server.js, ops/content/server.js — OK.
- Не проверено: живой кабинет, выпуск, реальные согласующие из «Настроек → Контент» (ждёт агента А).

## Ревью PR 496 (№95, комм. 480) — исправлено в этой ветке
- `ops/crm/package-lock.json` (lockfileVersion 3, 8 пакетов, у всех integrity, registry.npmjs.org); Dockerfile `COPY package*.json` + `npm ci --omit=dev`. Локально `npm ci --omit=dev` (Node 22.23) — 8 пакетов, require fflate/read-excel-file/saxen OK. `docker build` не выполнен: демон Docker в среде недоступен.
- `exportCell` в reel-plan-file.js: «= + - @» экранируются для будущей выгрузки; тест 6/6 PASS. Выгрузки плана в CSV сейчас нет — правило для неё.
- specs/105-reel-plan-import/evidence.md:10 обновлён.

## Ревью 502 (координатор, 05.11) — согласующие из «Настроек → Контент»
- `ops/content/content-plan-approvers.js` читает `content_settings` (схема контракта А) и фильтрует кандидатов; прокси (`ops/content/server.js`, 10 строк) удаляет присланный браузером `x-synapse-content-approvers` и ставит свой только для `/media-mentor/plan/signoffs`; POST отметки — право `content-plan.approve` (прокси и CRM).
- `node --test ops/crm/content-plan-workspace.test.js` — 6/6 PASS (новый HTTP-тест: Лена и Таня с просмотром + content-plan.approve; первая отметка — `approval`, 0 согласовано; вторая — `smm`, 7 в счётчике пятницы; редактор без права — 403; владелец при назначенных — 404; битый заголовок — 400).
- `node --test ops/content/content-plan-approvers-proxy.test.js` — 1/1 PASS: настоящие процессы CRM и content; согласующий другой компании отброшен из списка; подделанный заголовок из браузера не меняет список; CSRF обязателен; viewer — 403; alvi остаётся на заглушке «Владелец».
- **Зависит от PR 496**: `ops/crm/reel-plan-file.test.js` и `ops/content/media-mentor-proxy.test.js` (import-preview) требуют `npm ci --omit=dev` в `ops/crm` (lockfile PR 496, fflate/read-excel-file). Без него — `Cannot find module 'fflate'`; после — 6/6 и 1/1 PASS. Тесты анкеты и отметок от этого не зависят.
- Связанные: ops/crm content-plan/media-mentor/reel-plan — 132 (130 + 2 из-за fflate до npm ci, затем PASS); ops/content media-mentor/people/approvers/company-modules — 117 (116 + 1 из-за fflate, затем PASS).
- Ограничение: если согласующего добавят в Настройках после того, как план уже стал «к СММ», стадия вернётся в «На согласовании», а прежнее решение approved останется до снятия отметки или правки плана.
