# Задачи

- [x] T1. content-stages.js: этап и публикации идеи по фактам CRM и доверенным фактам съёмки (FR-1…FR-5).
- [x] T2. shooting.facts/factsHeader + прокси content: удаление браузерного заголовка, добавление своего для GET /media-mentor (FR-3).
- [x] T3. media-mentor-http: обогащение GET /media-mentor, `company.timeZone` (FR-1, FR-8).
- [x] T4. media-mentor.savePlan: отбрасывать вычисленные поля (FR-9).
- [x] T5. reel-materials: колонка idea_id, `ideaId` с проверкой компании, новая версия вместо новой карточки, `planLink` в DTO (FR-6).
- [x] T6. `offPlan`: черновик идеи только при pending-плане, иначе честная причина (FR-7).
- [x] T7. Тесты: модульные, факты съёмки, сквозной content+CRM; полные наборы; gate.
- [ ] T8. Клиент (вне пакета G): брать `idea.stage`/`publications` в content-plan.js и materials.js; `ctx.company.timeZone || mentor.company.timeZone`; в materials.js передавать `ideaId` при загрузке к рилсу плана.
- [ ] T9. Независимое ревью.
- [ ] T10. Выпуск: Root вручную (crm, затем content).
