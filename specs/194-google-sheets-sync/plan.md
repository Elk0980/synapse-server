# План реализации

Владелец: Claude (задача №193 доски). Разрешённые файлы: ops/content/google-sheets-client.js(+test), ops/content/google-sheets-sync.js(+test), specs/194-google-sheets-sync/*, docs/google-sheets-sync.md. Существующие модули не меняются.

## Модули

- `google-sheets-client.js` — fetch-клиент (инъекция fetchImpl, now). Методы: status, accessToken, getModifiedTime (Drive v3 files.get fields=modifiedTime), getValues, batchGetValues, batchUpdateValues (valueInputOption RAW), ensureSheet (addSheet при отсутствии). extractSpreadsheetId повторяет правила content-settings.js. Ошибки GoogleSheetsError с code/status/retryable (429, 5xx, сеть — повторяемы; 401 сбрасывает кеш токена). Scope: spreadsheets + drive.metadata.readonly.
- `google-sheets-sync.js` — createGoogleSheetsSync({db, client, getPlan, getSheetUrl, onProposal, now, intervalMs, …}). Таблицы `google_sheets_sync_queue` и `google_sheets_sync_state` создаются в переданной db (IF NOT EXISTS) — это не миграция боевой базы, модуль пока не подключён.
  - Снимок `rows_json`: последняя записанная строка и уже отправленные предложения по ideaId. Предложение — когда значение листа ≠ записанному, ≠ уже предложенному и ≠ значению ЛК.
  - Обычная выгрузка: колонки A–F сверяются с листом всегда, G–H переписываются, если строка изменилась в ЛК. Перед записью собираются правки команды (конфликт = ЛК тоже изменился).
  - Полная сверка: строки по порядку ЛК со 2-й, хвост очищается.
  - tick: ночная постановка → очередь → импорт (≤ раз в importEveryMs). Без ключа tick ничего не делает.

## Контракт getPlan

Массив или {items}; поля строки: ideaId|id, number, date|publishDate|publishAt, topic|title, format|kind, platforms, status|productionStatus, comments|comment. Сопоставление с конкретным API плана — на этапе регистрации.

## Проверки

node --test обоих тестовых файлов; python tools/spec-kit/gate.py check.
