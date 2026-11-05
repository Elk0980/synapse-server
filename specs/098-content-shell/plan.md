# План 098 (а) · каркас

Владелец: агент «А · Каркас». Ветка claude/night98-a-shell от origin/main. Разрешённые файлы:
sites/synapse/cabinet.html (точечно), sites/synapse/cabinet/module-registry.js, shell.css,
sites/synapse/cabinet/content-factory.test.cjs (ожидания меню), specs/098-content-shell/*.

- cabinet.html: блок меню «Контент» и «Настройки» вставлен после «Задач»; порядок и превращение «Хью» в «Чаты»
  делает скрипт оболочки (строки «Хью» и «Формы проектов» живой копии не трогаются). Новые ассеты — отдельный
  document.write после cabinetAssets (списки shellAssets/shellStyles), а не правка общих списков.
- Маршруты модулей: MODULE_ROUTES (content/plan, content/shooting, content/materials, content/connections,
  content/stats, chats, settings/content); контейнеры экранов создаёт скрипт.
- Права видимости: permittedView, новые строки после существующих условий.
- module-registry.js: реестр, ctx, заглушка, плавающая панель чата. shell.css: заглушка, FAB, адаптивность.
- Проверки: node --test всех тестов кабинета и ops/content (сравнение с main), Playwright 390/1440 со стабом API,
  patch --dry-run на живой копии cabinet.html.

## Согласование с main после №495/497

В изолированной ветке объединить принятый520@aba39b8 с main@dedae14e. Два конфликта касаются только общей версии ресурсов в cabinet.html и её тестового ожидания: оставить принятую520 версию night98-integ и проверку её формата. Остальные изменения №495/497 переносит обычный merge; Content-runtime из520 не заменяется, миграция12 и подтверждение личности сохраняются. Производственную копию HTML по-прежнему обновлять отдельным адресным integration.patch после свежей проверки, без fuzz.

Этот шаг не запускает выпуск и не закрывает отдельный контракт безопасного отката Content после появления личных комнат. До фактических миграций обязательны проверенные копии обеих БД и независимое принятие Claude нового head.
