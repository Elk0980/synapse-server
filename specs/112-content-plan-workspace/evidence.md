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
