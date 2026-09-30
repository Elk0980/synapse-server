# Проверка подключения исходников

Дата: 30.09.2026. Основа: d9339bccba92bf57fce8983e499c467771429810. Проверено локально Codex; не production.

## Результат
В «Контент завод» добавлена вкладка «Исходники из Telegram» и alias. Раздел использует существующий prepared module без его изменения и `apiJson` оболочки. Право — прежнее `autoposting.view` либо owner плюс выбранная компания из identity.companies. Создание контента, отправка сообщений, изменение прав и включение intake отсутствуют.

Adapter уничтожает список и отменяет GET при смене компании, переходе из раздела или logout. Реальный список сам отбрасывает ответ после destroy. Другие виды не реализуют новый необязательный `onLeave`, их черновики сохраняются. Новая запись module-guide не утверждает факт подключения.

## Проверки
Среда: Node v24.18.1 (`C:/Program Files/nodejs/node.exe`), jsdom из `C:/Users/Vlad/Documents/Codex/hugh-connector-testdeps/node_modules` через NODE_PATH. Без установок.

```text
node --test sites/synapse/cabinet/telegram-sources-view.test.cjs sites/synapse/cabinet/content-factory.test.cjs sites/synapse/cabinet/telegram-sources.test.cjs sites/synapse/cabinet/workspace.test.cjs sites/synapse/cabinet/menu-preferences.test.cjs
32 tests, 32 pass, 0 fail
```

- 10 новых интеграционных тестов выполняют настоящий router, bootstrap, adapter, список и module-guide в JSDOM. Проверены обе ссылки, название/активная вкладка, script order, company ACL, owner, неизвестная компания в storage, отмена и поздний ответ предыдущего проекта, переходы назад/вперёд, сохранение черновика, отсутствие фоновых запросов скрытого вида, пагинация/повтор и GET-only. Logout проверен до сетевого ответа.
- Исходные тесты списка дополнительно проверяют XSS и чужие file URL.
- Первая регрессионная проверка обнаружила отсутствие нового раздела в стандартной карте памяток (workspace.test.cjs). Добавлена только соответствующая запись, повторный запуск всех 32 тестов успешен.
- До реализации новые тесты падали из-за отсутствующего adapter, после реализации прошли.
- `node --check sites/synapse/cabinet/telegram-sources-view.js` — успешно; inline JS также выполняется в интеграционных тестах.
- `python tools/spec-kit/gate.py check` — status ok, 48 официальных файлов, codex/claude/qwen.
- `git diff --check` — успешно.

## Converge
Проверены FR-001–005, SC-001–002, 4 пункта плана и принципы I–V конституции. Функциональных пробелов, противоречий или лишних изменений не обнаружено. Converged; новых задач не добавлено.

## Границы результата / передача
Только UI-подключение поверх подготовленного commit. Авторские telegram-sources.js, backend, bridge и compose не изменялись. Приём исходников остаётся выключен по прежней конфигурации. Реальные Telegram/HTTP, production, мобильный браузер и визуальная приёмка не проверялись этим исполнителем. Отдельный commit передаётся координатору для включения в PR владельцем источников; PR/merge/deploy здесь не выполнялись. Откат UI-коммита скрывает вкладку, сохранённые исходники не удаляет.
