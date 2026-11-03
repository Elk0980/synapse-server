# План и конфигурационный контракт

Один писатель Codex в прежнем worktree/ветке codex/board-watchdog-20261104. Никаких общих production изменений. Список MCP-инструментов не трогать.

1. Observe default и условные SQL guards без потери старых данных.
2. В существующем content proxy — подписанный cabinet-session context; в существующем MCP — подпись выбранного credential ID. CRM task-principal проверяет HMAC/срок/method/path/identity hash/agent_access.
3. Async prepare на всех HTTP стадиях, синхронный guard + атомарные principal/proofs; acceptance перед done; authenticated reports и no-code exception.
4. Проверки режимов, настоящего cabinet/MCP/dispatch, отзыва доступа в прежнем клиенте, старых форм/метаданных, GitHub/health, подписи/разных ключей. SpecKit и отдельный CI.

## Приватная конфигурация при будущем разрешённом выпуске

- CRM: TASK_WATCHDOG_MODE=observe по умолчанию, enforce — явный выбор оператора после проверки привязок. TASK_WATCHDOG_HEALTH_URL — единственный доверенный HTTPS health с полным SHA в version. Без URL sample пропускается.
- CRM: TASK_WATCHDOG_CLAUDE_AGENT_ID и TASK_WATCHDOG_RELEASE_AGENT_ID — разные положительные ID из agents, по умолчанию0 (роль не назначена). Свободный agents.kind не выдаёт роль.
- MCP: TASKS_MCP_AGENT_ID опционально связывает основной ключ с одним ID. Общий ключ разных чатов оставлять непривязанным; нельзя выводить личность из аргумента agent.
- MCP: TASKS_MCP_AGENT_CREDENTIALS — приватный JSON-массив token/agentId/projects (projects опционально, только подмножество TASKS_MCP_PROJECTS). Каждый отдельный ключ уникален; agent_access должен содержать тот же owner и точный нормализованный scope, включая старые неявные Synapse-проекты. Значения ключей не помещать в PR/логи.
- Никакой генерации/ротации ключей, изменения реальных grant или включения режима в этом PR.

Новые таблицы additive. Перед будущей установкой штатный backup. Бизнес-строки и старые done не переписываются. Откат кода сохраняет новые таблицы и данные, без слепого восстановления старой БД. Docker сохраняет существующие COPY: principal module входит CRM *.js, issuers встроены в текущие server.js. Общие файлы server.js пересекаются с PR477: перенести только ограниченные identity/async hunks, сохранить его инструменты/диспетчер.
