# Задачи CF21

Процесс Spec Kit 1.0.0. Область ограничена новыми workflow/test и четырьмя документами 070.

## Phase 1: Контракт и подготовка

- [x] T001 Прочитать AGENT-ECONOMY/AGENTS/policy/constitution; согласовать DTO и first-save semantics с root (FR-001, FR-002).
- [x] T002 Создать spec/plan/tasks в выделенной области; проверить отсутствие hooks и существующих целевых файлов (SC-005).
- [x] T003 Проверить prerequisites без feature-state/bytecode записи.

## Phase 2: Реализация и проверка

- [x] T004 Написать синтетический meaningful тест defaults/first-save/noop/partial/reset/validation/revision/isolation (FR-001..FR-004, FR-006).
- [x] T005 Реализовать новый модуль с immutable version/current pointer, atomic rollback и actor (FR-005).
- [x] T006 Проверить re-init, immutable history, trigger failure и отсутствие writes posts/jobs/tasks (SC-003, SC-004, FR-007).
- [x] T007 Запустить только новый тест; выполнить scoped converge/gate, записать реальные результаты evidence (SC-001..SC-005).
- [x] T008 Зафиксировать шесть SHA и остановить запись, передать root контракт и границы подключения.
