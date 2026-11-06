# План №180 на актуальном main
Владелец: Claude (ветка claude/project-order-180-main). Основа логики — принятый ревью PR #569; механизмы #568 (плашка) и #519 (shell-modules.json, shell-version.json) не переносятся — плашка уже в main (#573).

Клиент (выпускается автовыпуском статики): `sites/synapse/cabinet/menu-preferences.js`.
- Обёртка `SynapseViewAs.render`: до `readSelectedProject` записывает серверный `lastCompanyCode` (если компания доступна) в `synapse_cabinet_project_v2:<userId>` — прежний механизм выбора кабинета.
- `initProjectPreferences` (вызывается из `initMenuPreferences`): сортирует существующие пункты `#project-menu` (MutationObserver), фиксирует выбор в фазе захвата клика, PUT с requestId; неизвестный исход — повтор тем же requestId.
- Без серверных полей — локальный журнал; 404/405 отключают PUT до перезагрузки. view-as — ничего не читает и не пишет.

Сервер (отдельный выпуск ops/content): `user-project-prefs.js`, правка `server.js` (маршрут и whoami), тесты. Таблица `user_project_prefs` создаётся `CREATE TABLE IF NOT EXISTS`, существующие таблицы не меняются.
