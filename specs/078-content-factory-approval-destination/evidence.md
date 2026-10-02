# Свидетельства CF28

Правила и контракт прочитаны/согласованы root до кода. Spec Kit 1.0.0; spec/plan/tasks/evidence созданы до теста и реализации. Исполнитель Codex. Ниже собственное выполнение 01.10.2026 в SOURCE, отдельно от проверки/приёмки root.

## Failing regression до исправления

На прежнем коде выполнено:

```powershell
& 'C:/Program Files/nodejs/node.exe' --test ops/crm/autoposting-approval-destination.test.js
```

Один meaningful случай approve Telegram A → save/check B → NEW schedule упал с Missing expected rejection, exit 1: прежний код действительно создал расписание. После минимального исправления тот же тест прошёл без изменения отрицательного assertion.

## Реализация и converge FR-001–006

| Требование | Свидетельство |
| --- | --- |
| FR-001 | destination_revision сохраняется в channels и растёт при canonical target/provider/effective decrypted token change. A→B→A требует нового решения; rename, same-token, enabled и check metadata сохраняют destination revision. Транзакционный отказ multi-channel save сохраняет прежнюю destination revision. Telegram handle case нормализован; safe integer проверяется. |
| FR-002 | nullable approved_profile_revision/approved_destination_revision в platform reviews записываются вместе с текущим содержимым и решением. INSERT refusal откатывает решение, binding, историю и доставку. Partial Telegram сохраняется при смене VK. |
| FR-003 | schedule после awaited settings внутри BEGIN перечитывает sync destination/channel revision и current profile; stale/null binding409, profile-only update409, stale settings409. Проверены destination/name/profile races для approveAndSchedule, отдельная schedule race. Старая settings revision сверяется и для канала, которому согласование не обязательно. |
| FR-004 | deliveryApproved использует прежние content-only approvals; старые queued null bindings продолжают drain. Смена подключения после постановки по-прежнему останавливается CHANNEL_CHANGED. Нет новых массовых отмен или schedule/send side effects от нового binding. Relevant regression сохраняет lease, beforePublish, plan/profile/platform guards. |
| FR-005 | Internal approvalDestination возвращает только destinationRevision/channelRevision; GETsettings/body не расширены. Public approval DTO показывает stale destination/profile через прежние approved/stale. Company profile freshness читает только SELECT company_information, не information.get с побочной facts.sync записью. Missing adapter допускает content-only manual approval с null binding; NEW schedule fail closed. Promise adapter409. |
| FR-006 | 16 новых destination tests и 1 transport test, плюс existing regression. Синтетическая file SQLite закрыта и открыта заново; binding и revision после ABA сохранены, NEW schedule с действующим binding проходит. Migration прежней схемы требует нового решения только при NEW schedule. Company isolation, rollback и partial scope проверены. |

Converge: проверены все 6 FR, 4 сценария, 5 шагов plan и T001–007; оставшихся задач реализации в ограниченном пакете нет. Галочки не использовались вместо runtime/source проверки.

## Окончательные проверки

Node v24.18.1, C:/Program Files/nodejs/node.exe:

```powershell
& 'C:/Program Files/nodejs/node.exe' --test ops/crm/autoposting-approval-destination.test.js ops/crm/autoposting.test.js ops/crm/autoposting-transport.test.js ops/crm/autoposting-calendar-edge.test.js ops/crm/autoposting-calendar.test.js ops/crm/autoposting-variants-history.test.js ops/crm/media-mentor-legacy-adaptation.test.js ops/crm/media-mentor-transfer.test.js ops/crm/media-mentor-http.test.js ops/crm/autoposting-approval-http.test.js ops/crm/autoposting-onlypult-flow.test.js ops/crm/autoposting-source-links.test.js ops/crm/autoposting-recovery.test.js ops/crm/autoposting-review-batch.test.js ops/crm/content-factory-source-http.test.js
```

Окончательный runtime: 288/288, 0 failed, 0 skipped, exit 0. Предыдущие 129/129 и 286/286 были промежуточными. Попытка fresh DTO через information.get выявила два regression отказа календаря из-за facts.sync/создания новой profile revision; заменена pure SELECT. Calendar assertions не ослаблены, финальный no-write и временное company-field изменение проходят.

```powershell
git diff --check -- ops/crm/autoposting.js ops/crm/autoposting-transport.js ops/crm/autoposting-approval-destination.test.js ops/crm/autoposting.test.js ops/crm/autoposting-transport.test.js ops/crm/autoposting-calendar-edge.test.js ops/crm/autoposting-calendar.test.js ops/crm/autoposting-variants-history.test.js ops/crm/media-mentor-legacy-adaptation.test.js ops/crm/media-mentor-transfer.test.js specs/078-content-factory-approval-destination
python -B tools/spec-kit/gate.py check
```

Diff check exit 0; gate exit 0, 48 verifiedFiles. Gate подтверждает процесс, не runtime. Полный финальный runtime output сохранён в памяти исполнителя; авторский/чужой лог не выдаётся за собственный запуск.

## Целостность, границы и ограничения

Свежие полные baseline девяти existing ownership paths сохранены до записи. Reverse только своих patch восстановил полное исходное содержимое с нормализацией CRLF/LF: autoposting.js 16 hunks, transport.js 7, autoposting.test.js 1, transport.test.js 1, calendar-edge/calendar/variants-history/legacy-adaptation по 1, media-mentor-transfer.test.js 2. В пяти дополнительно разрешённых paths изменены только sync adapter fixtures; прежние assertions сохранены.

Новые файлы: один targeted test и четыре specs078 docs. CRMserver/Contentserver/socialstats/UI/QA/state/manifest не редактировались. Внешняя сеть, live API, production, права, commit/push/deploy и новые агенты не использовались. Existing HTTP regression использует синтетический локальный CRM test server; transport calls заменены synthetic responses. File SQLite — отдельный temporary synthetic файл, удалён после закрытия.

Manual/offline/legacy null binding остаётся решением по содержимому и может отображаться как такое согласование; при NEW schedule требуется новое решение с проверяемым назначением. Уже назначенные доставки сохраняют прежнюю семантику. Имя не снимает согласование, но прежний queued channel_revision guard по-прежнему может остановить отправку после любого saveSettings: этот guard намеренно не ослаблен. Браузерный UX и production не проверялись.

Окончательные SHA передаются root после последнего чтения; после сдачи запись STOP. Подключение/приёмка root — отдельный этап.
