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
