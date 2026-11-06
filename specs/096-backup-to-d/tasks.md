# Задачи

- [x] Прочитать №58, перевести in_progress, report/comment.
- [x] Изолированная ветка от свежего main, анализ старого backup и D.
- [x] Кандидаты create/serve/pull/restore/sandbox и расписания.
- [ ] Полная фактическая server inventory/место; окно консоли запрошено у Claude.
- [x] Review221: убрать pause; безопасные ссылки, отдельная ротация/status,
  stale.partial, приватный temp/место,2копии+receipt prune, кабинет/report/timeout.
- [x] Подготовить board-report через существующее явно настроенное MCP-подключение.
- [ ] Подключить private inventory/config/board endpoint после приёмки Claude.
- [ ] Проверить реальные age/OpenSSH/Windows/Docker и восстановление ≤1 часа.
- [ ] Влад: создать отдельный backup-read ключ; другие этапы этим не блокировать.
- [ ] Claude: review PR, затем отдельное разрешённое подключение и приёмка.

## Потоковый профиль — 05.11

- [x] Прочитать правила и фактические ограничения484/518; выделить отдельную ветку и владельцев файлов.
- [x] Описать проверяемый транспорт/lifecycle без новых привилегий backup-read; приёмка Claude отдельна.
- [x] Реализовать кандидат stream-профиля и минимальные hooks с сохранением архивного профиля.
- [ ] Проверить последовательные SQLite snapshot/WAL/удаление scratch/abort/таймаут/завершённый receipt.
- [ ] Проверить real age/старый restore и отрицательные сценарии list/get/пути/конкурентный читатель/бюджеты.
- [x] Обновить RECOVERY, пройти Windows backup suite и Spec Kit gate; Linux CI отдельно.
- [x] Пройти Linux FIFO/age/SQLite quota/link-race CI runtime745b363d:50/50; независимое Codex-review исправлений пройдено.
- [x] Исправить замечания Claude577: окно01–06, daily/ACK gate, bounded reports, late-DONE/own-temp quarantine, существующий SSH recipient; Windows64/46PASS18SKIP.
- [ ] Новый Linux CI64 и systemd verify для runtimeb1de32e; повторное ревью Claude окончательного head.
- [x] Открыть draft PR525 с отдельной строкой Spec:; передать окончательный head независимому Claude через№58.
- [ ] Независимая приёмка Claude окончательного head PR525.
- [ ] После приёмки и разрешённой передачи сервера — отдельная live-проверка копии наD; не отмечать заранее.
