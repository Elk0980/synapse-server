# Реализация

Свежий main fb598368 (PR478), ветка codex/team-chat-20261103. Изолированный worktree, единственный писатель своих изменений; production не используется. ops/tasks-mcp и страница доски исключены.

Переиспользуются people-service/http, createPeopleTasks.access, createPeopleCrmClient, CRM people handler, tasks и coordination history. Узкая capability teamChatTask не меняет actor.role и не открывает owner API.

Новая team_chat_messages в content.sqlite и team_chat_task_receipts в CRM — только CREATE IF NOT EXISTS и индексы. Старые таблицы не копируются/не удаляются. Receipt связывает даже семантический дубль с исходной задачей после done; CRM BEGIN IMMEDIATE сериализует создание. Существующий trigger начальной coordination revision сохраняется.

Новая team-chat.html/js/css доступна через people.html; текущая Caddy policy /cabinet/* no-cache доставляет ресурсы существующим сессиям после reload. Обратная совместимость: предыдущий UI продолжает работать, новые таблицы не удалять при откате кода. Серверная миграция/backup и фактический rollout только в отдельном разрешённом выпуске.

Проверки: реальные loopback HTTP content/CRM, SQLite crash/replay/duplicates, CSRF/отзыв, JSDOM для черновика/XSS/unknown, синтетический браузер ПК900 и390px. Полноценная production приёмка остаётся Claude.
