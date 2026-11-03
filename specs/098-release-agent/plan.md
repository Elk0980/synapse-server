# План и границы

Только ops/release-agent/**, .github/workflows/release-agent.yml и эта спецификация.
Main fb598368, изолированная ветка codex/release-agent-20261103. Общие router/board
принадлежат26; production478/477 занят другим агентом. Локальный документ не lease.

1. Разведка main, service-guides и task25/35 без изменения сервера.
2. Транзакционный engine + immutable recipe/image capture + SQLite backup.
3. Signed admission interface exact SHA/parent/task/comment/CI/срок. Реальный
   authenticated issuer зависит от решенияClaude169/172, самостоятельно не имитировать.
4. Исходящий MCP board transport и durable outbox с readback unknown.
5. Snapshot-only inventory и inert installer/systemd units. Не делать reset/активацию.
6. Windows units, Linux flock/install-copy и настоящий disposable Compose rollback.
7. После решений: production inventory/reconciliation, static/config path handling,
   ACL rollback UI у26, final bootstrap и приёмка полного сценария Claude.

Миграций production в текущем кандидате нет. Откат image допускается только с
forward-compatible данными; backup не восстанавливается поверх новых записей.
Полный managed recipe поступает из принятого приватного слоя, не подменяется
публичным docker-compose.yml. Неподдержанные пути останавливают выпуск целиком.
