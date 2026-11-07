# Свидетельства 225

Состояние: правки реализованы и проверены локально. Они не выпущены, в рабочей системе не проверены и не приняты. Права в живых данных не менялись.

## Тесты (07.11.2026, node 22.23.4, worktree `claude/cf-lena-onboarding` от `origin/main` 5bdeb403)
- `NODE_PATH=<основной checkout>/node_modules node --test sites/synapse/cabinet/*.test.cjs`: 1187 из 1187.
  - Новый тест `content-plan.test.cjs` «specs/225: «Указать таблицу» …». Не-владелец с `canEdit: true` видит кнопку, без права — нет. С прежним условием (`role === 'owner'`) тест падает: 40/41, проверено временной заменой условия.
  - `permission-help.test.cjs` проходит с новым текстом `settings.edit`.
- `cd ops/crm && node --test autoposting*.test.js content-archive.test.js`: 224 из 224.
  - Новый `autoposting-approval-companies.test.js`: 2 из 2. Без настройки согласование обязательно только в `palitra-love`. С `AUTOPOSTING_APPROVAL_COMPANIES=palitra-love,new-client` оно обязательно и в новой компании, а `approveAndScheduleAvailable` становится `true`. Неверные коды отбрасываются.
  - Прежние `autoposting-approval-http.test.js` и `autoposting-approval-destination.test.js` (Palitra) проходят без изменений.
- `python3 tools/spec-kit/gate.py check`: `status: ok`, verifiedFiles 48.

## Не проверено
- Живой кабинет под реальной учётной записью контент-менеджера: нет доступа и разрешения входить.
- Значение `AUTOPOSTING_APPROVAL_COMPANIES` на сервере не задавалось.
