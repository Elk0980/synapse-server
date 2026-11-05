# Свидетельства (Claude — код, 05.11.2026)

Ветка `claude/autoposting-channels-112` от main, затем слита с main 73b6bf7 (после PR 520) без конфликтов.

## Что сделано
- `ops/content/auth-store.js`: право `autoposting.channels`; `autoposting.approve` → только `autoposting.view` + `company-information.view`; `autoposting.channels` → `autoposting.edit` (+ просмотр). Однократная миграция `auth_meta.autoposting_channels_v1`: INSERT OR IGNORE `autoposting.channels` всем с `autoposting.edit`, список id в `auth_meta`; снятое владельцем право при перезапуске не возвращается.
- `ops/content/company-team.js`: пресет «Администратор» + `autoposting.channels` (прежняя возможность сохранена).
- `ops/content/server.js` (прокси): `POST /autoposting/posts/:id/approve|reject` — `autoposting.view` (+ прежняя проверка `autoposting.approve`), без `edit`; `PUT /autoposting/settings`, `POST /autoposting/settings/:id/check` — `edit` + `channels`.
- `ops/crm/server.js`: решение по версии — контекст по `autoposting.approve` (без `edit`; просмотр гарантируют зависимости прав в content), каналы — `channels` + `edit`; `schedule:true` у approve требует `edit`.
- Кабинет: `autoposting.js` — поля и кнопки подключений активны только при `edit` + `channels`; `account.js` — подпись «⚠ Автопостинг — каналы публикации и ключи», у `edit` — «материалы и публикации».

## Проверки
- Новый `ops/content/autoposting-channels-permission.test.js`: зависимости, миграция (однократно, approve-only не получает, снятое не возвращается).
- `ops/content/company-modules-access.test.js` (реальные content + CRM): согласующий без edit читает, не правит (403), согласует и отклоняет (200), approve+schedule — 403; edit без approve не согласует; approver и edit без channels читают настройки (200), но PUT и check — 403; edit+channels сохраняет ключ, ключ не возвращается в ответе.
- `ops/crm/autoposting-approval-http.test.js`: те же правила на самой CRM по доверенной identity, включая channels без edit → 403.
- jsdom `autoposting.test.cjs`: edit без channels — материалы редактируемы, подключения заблокированы, PUT/check не отправляются.
- Прежние тесты, где редактор настраивает каналы (`studio-pilot-proxy`, `company-information`, `autoposting.test.cjs`), получили `autoposting.channels` — смысл проверок сохранён.
- Полные наборы ops/crm и ops/content — результаты ниже.

## Не сделано / ограничения
- Миграция выдаст `channels` и тем, у кого `edit` появился через прежнюю зависимость approve (например, согласующему). Снять лишнее — Влад в «Настройке аккаунтов» после выпуска.
- PR 537 построен поверх PR 523 (ветка 523 слита сюда, ревью 712/715) и сливается вторым: в `permission-help.js` добавлено пояснение `autoposting.channels` (⚠), тексты `autoposting.edit` (без ключей) и `autoposting.approve` (только просмотр; план — с правом правки) обновлены; тест требует точного совпадения каталога с PERMISSIONS. Подписи «Настройки аккаунтов» берутся из каталога 523, поэтому прежняя правка подписи в account.js заменена версией 523.
- Версия ресурсов кабинета (`SB_CABINET_ASSET_VERSION`) не менялась, чтобы не конфликтовать с соседними PR; при выпуске её нужно поднять (изменены autoposting.js, account.js).
- Выпуск, сервер и боевые базы не трогались.

## Прогоны 05.11.2026 (Linux, Node 22)
- Затронутые наборы (content + CRM HTTP, jsdom autoposting/account/content-factory-settings/vk-community, новые тесты): 133/133.
- Полный ops/crm: 1051, 1044 pass, 7 fail; на main 73b6bf7 тем же прогоном 5 fail. Разница — нестабильные под нагрузкой (company-links «CRM startup timed out» и на main; vk-materials таймер); calendar-http исправлен (контекст решения по approve), повтор — pass.
- Полный ops/content: 806, 13 fail при параллельной нагрузке («server starts», «Fixture service did not start»); повтор упавших файлов отдельно — 16/17, оставшийся `media-mentor-proxy.test.js` падает и на main 73b6bf7.
- gate.py check ok.
