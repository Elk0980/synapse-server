# Свидетельства CF24

Контракт подтверждён root до кода; spec/plan/tasks/evidence записаны до реализации по Spec Kit 1.0.0. Исполнитель Codex. Проверки ниже выполнены самостоятельно 01.10.2026 в SOURCE, на синтетических memory SQLite и injected HTTP request/response; сеть и live API не использовались.

## Соответствие требованиям

| Требование | Реализация и проверка |
| --- | --- |
| FR-001 | Единственное дополнение autoposting DTO — scoped plan.linkOf. Проверены own/other company, совпадающие ideaId в двух компаниях, null для обычной карточки, запрет клиентского planLink и прежний PLAN_LINKED_POST. |
| FR-002 | Strict selection и явные ошибки для полей, unknown idea/platform, stale revision, empty/excluded/unapproved. При двух согласованных площадках выбирается ровно одна. |
| FR-003 | Общие plan/brief/profile и выбранные revision/approval повторно сверяются внутри транзакции. Injected гонки каждого состояния отказали без записи. Trigger отказа plan-link INSERT откатил новый draft и сохранил существующую соседнюю карточку. Длинный topic соседней идеи не блокирует selected, но прежний batch отказ сохраняется. |
| FR-004 | Selected replay после edit/archive возвращает current cardStatus/archivedAt; SQL snapshots существующей карточки не меняются. Throwing get и UPDATE trigger подтверждают отсутствие get/update для existing receipt. Batch skipped DTO остался прежним. |
| FR-005 | После await JSON два affected POST повторяют trusted company/edit guard и сохраняют userId. Injected revoke, permission loss, identity swap, in-place identity mutation, company loss и CSRF loss отказали без записи. Owner downgrade запрещает decision; fresh trusted actor записан реально. |
| FR-006 | Edit variant и revoke после schedule остановили drain без отправки; повторное schedule отказало. Существующие regression проверили плановые, platform-specific, workflow, source и recovery guards. |

## Выполненные команды и результаты

Node v24.18.1, путь C:/Program Files/nodejs/node.exe.

```powershell
& 'C:/Program Files/nodejs/node.exe' --test ops/crm/media-mentor-legacy-adaptation.test.js
```

Targeted: 20/20, exit 0. Первая проба выявила ошибку синтетической fixture: actor содержал поля trusted HTTP identity, которые существующий строгий normalizer отвергает. Исправлена только fixture; actors и identities разделены.

После усиления rollback fixture существующей соседней карточкой выполнен окончательный regression:

```powershell
& 'C:/Program Files/nodejs/node.exe' --test ops/crm/media-mentor-legacy-adaptation.test.js ops/crm/media-mentor-transfer.test.js ops/crm/media-mentor-http.test.js ops/crm/media-mentor.test.js ops/crm/autoposting.test.js ops/crm/autoposting-variants-history.test.js ops/crm/autoposting-source-links.test.js ops/crm/autoposting-recovery.test.js ops/crm/autoposting-review-batch.test.js ops/crm/content-factory-source-http.test.js
```

Окончательный runtime: 230/230, 0 failed, 0 skipped, exit 0. Это собственное выполнение, не пересказ авторского лога или проверки root.

```powershell
git diff --check -- ops/crm/autoposting.js ops/crm/media-mentor-transfer.js ops/crm/media-mentor-http.js ops/crm/media-mentor-legacy-adaptation.test.js specs/074-content-factory-legacy-adaptation
python -B tools/spec-kit/gate.py check
```

Diff check: exit 0. Gate: exit 0, 48 verifiedFiles; подтверждает процесс Spec Kit, не заменяет runtime.

## Целостность и границы

Свежие полные baseline четырёх existing ownership файлов сохранены в памяти до patch. Обратное применение только собственных hunks восстановило полное содержимое autoposting.js (1 hunk), media-mentor-transfer.js (5), media-mentor-http.js (2), с нормализацией CRLF/LF. Existing media-mentor-http.test.js не изменён. Созданы только новый тест и четыре документа specs074; schema/plan-link/server/UI/QA/state/manifest не редактировались.

Actual server HTTP, браузерный UX, production и публикация не проверялись. Legacy UI требует отдельной интеграции root. Отдельный обнаруженный root риск сохранения material approval при смене channel/profile не входит в CF24 и здесь не исправлялся. Selected replay сохраняет прежние current plan/brief/profile/approval guards; это возврат существующей связи с текущим статусом карточки, не обход отзыва согласования и не новый draft.

После финального чтения SHA передаются root; запись останавливается. Приёмка root отделена от этой собственной проверки.
