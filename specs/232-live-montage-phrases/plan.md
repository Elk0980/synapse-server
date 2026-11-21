# План 232

Владелец: Claude. Разрешённые файлы: ops/crm/reel-requests.js, ops/crm/reel-materials.js (только предел подписи), sites/synapse/cabinet/materials.js, materials.css, тесты к ним, specs/232.

- ops/crm/reel-requests.js: `segmentsOf` принимает `enabled`/`sound`, подпись до 200; `liveEdit` сравнивает с разметкой версии, пишет «добавлены отрезки».
- ops/crm/reel-materials.js: предел подписи в `live.segments` EDL — 200.
- sites/synapse/cabinet/materials.js: `liveOps.initial` из разметки, `changed(toggles, segments)`, `active`; фраза — кнопка перехода плеера.
- Контракты: новые поля необязательны, старые клиенты и версии не затронуты. Миграций и переменных окружения нет.
- Проверки: node --test в ops/crm и sites/synapse/cabinet; gate.py check.
