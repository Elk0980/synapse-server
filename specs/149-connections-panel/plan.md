# План 149-connections-panel

Владелец: Claude — подключения (код). Файлы: `sites/synapse/cabinet/{autoposting.js,autoposting.css,
content-connections.js,content-connections.css,content-factory.js,module-guide.js}` и их тесты,
`ops/crm/autoposting-transport.js` (+ тест), `specs/149-connections-panel/`.

## Существующие модули
- `autoposting.js` — «Постинг»; прежний блок каналов (renderChannels, обработчики, controls) перенесён без
  изменения логики в `createChannelsPanel(host, deps)`; deps: request, role, canEdit, companyCode, companyName.
- `content-connections.js` — модуль контракта А; монтирует панель через `ctx.api` (`/content/crm/...`).
- `autoposting-transport.js` `listProfiles` — добавлено `takenBy` по `autoposting_channels` других компаний.

## Межмодульная связь
`cabinet.channelsRevision` растёт после сохранения/проверки; «Постинг» при возврате перечитывает настройки.

## Проверки
`node --test sites/synapse/cabinet/*.test.cjs`, `node --test ops/crm/autoposting*.test.js`,
Playwright 390/1440 на настоящем cabinet.html с SAMPLE-заглушкой API.
