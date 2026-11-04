# Свидетельства
Реализовано только №95(а), без новой таблицы/модуля и без обращений к production. Следующие этапы не включены.
- Сервер: `node --test ops/crm/reel-plan*.test.js ops/crm/media-mentor*.test.js ops/content/media-mentor-suggest.test.js` — 173/173 PASS.
- Интерфейс: `node --test sites/synapse/cabinet/media-mentor*.test.cjs` с jsdom — 173/173 PASS; после усиления проверки сохранённого CRLF целевые 2/2 PASS.
- Проверены CSV/BOM/разделители/реплики; XLSX shared/inline/даты 1900/1904/первый лист, ограничения размера/координат до чтения, формулы/связи; старые планы/no-op, изоляция, CAS, атомарность, сохранение правок/повтор/поздний ответ компании, начальная пустая строка сценария.
- Синтаксис пяти изменённых JS, diff-check и `python tools/spec-kit/gate.py check` — PASS (48 файлов). Генератор и выбор его периода остаются 7–14 дней. Aggregate JSON плана: прежний лимит 200000 байт; ошибка сохраняет форму.
- Реальный 390px НЕ проверен: Browser Use init error3; Windows Computer Use остановлен URL confidence guard до UI-действий. Обхода, собственных вкладок и фоновых помощников нет. DOM-тесты не являются снимком экрана.
- Новые зависимости закреплены: read-excel-file 9.3.14, fflate 0.8.3, saxen 11.2.0; [документация reader](https://github.com/catamphetamine/read-excel-file). `npm audit` в частной копии выявил только прежний nodemailer; почтовый пакет не менялся.
Converge: FR-1…5 реализованы; FR-6 частично (версия ресурсов обновлена, реальный мобильный снимок отсутствует). Выпуск, подключение и приёмка Claude не заявлены.
