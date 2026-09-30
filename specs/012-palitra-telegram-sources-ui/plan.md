# План

1. Реальная оболочка `sites/synapse/cabinet.html`: script registration, вкладка/section/title/router/категория и существующий company ACL. Добавить необязательный lifecycle `onLeave` при уходе из вида и logout; прежние виды его не имеют, их DOM не уничтожается.
2. Отдельный `sites/synapse/cabinet/telegram-sources-view.js`: registerView, повторная проверка контекста компании, mount списка в card, destroy и отмена GET при уходе/смене компании. Не менять `telegram-sources.js`.
   `module-guide.js`: только стандартная запись из четырёх шагов для нового вида, без изменения общего шаблона или заявлений о подключённом приёме.
3. `sites/synapse/cabinet/telegram-sources-view.test.cjs`: настоящий shell и модуль, фиктивный fetch, навигация/права/изоляция/ошибка/пагинация. Дополнительно существующие `content-factory.test.cjs`, `telegram-sources.test.cjs` и регрессии shell.
4. Зафиксировать реальные результаты в evidence, сопоставить с FR/SC через converge, отдельный commit для включения владельцем spec 048. Без PR, merge/deploy, прав и отправок.

Миграций, зависимостей и серверных изменений нет. Откат — убрать этот commit; приватные сохранённые исходники не удаляются. Runtime: Node 24 и установленный jsdom. Конституция I–V: локальные проверки отделены от live, один писатель, исходный API переиспользуется, клиентские данные не нужны.
