# Свидетельства №84

04.11.2026, время UTC.

- Актуальный public main прочитан и получен обычным fetch: `0a618bedc5ad6746f1d84f7b13af6cfd33f1e94d`. Чистый отдельный worktree создан в ветке `snapshot/server-live-20261104`.
- PR481 прочитан через GitHub: OPEN/draft, head `60b54e2efdbbf3ef1c4cf01d7fedf3b37568542b`, совпадает с приёмкой Claude55/374. Установки/слияния481 нет.
- session_start вернул503 «Карта не установлена», собственной session_id нет; session_end не имитировался. task tools работают.
- Штатный Timeweb account/server8936001/synapse-core подтверждён. Отдельная консоль подключена к пустому root prompt обычным Enter; shell вход/пароль не потребовался.
- В07:48:05.620 выполнена ровно одна metadata-команда `GIT_OPTIONAL_LOCKS=0 git -C /opt/synapse status --short --untracked-files=all | wc -l`. Вывод6452, затем пустой prompt. Содержимое файлов не читалось/не переносилось.
- Прямых download/filetransfer кнопок и открытых native SFTP-клиентов не найдено. Выделение свежих6452 мышью видно; первый CtrlShiftC не дал этих байтов в clipboard. Буфер остался исходным, его содержимое не выводилось. Точный экспорт пока не подтверждён.
- Локальный индекс2162 public main файлов сохранён вне git. Все48 последних публичных payload475→485 уже совпадают с main. Семь managed файлов могут содержать сохранённые посторонние доработки: content/auth-store.js, content/server.js, crm/server.js, crm/task-dispatch.js, tasks-mcp/documents.js, tasks-mcp/server.js, sites/synapse/cabinet.html. Actual bytes полного дерева локально отсутствуют; public payload нельзя объявить снимком сервера.
- Проверена зависимость481/68: issuer читает `comment.identity.verified/agentId/credentialId`, текущий CRM task_get возвращает только legacy поля комментария.68 planned, поэтому без неё автоматическая очередь ожидает authenticated Claude comment. Вопрос передан25/405; правило fail-closed не менялось.

В07:55:07.110 выполнено второе metadata-only чтение: HEAD `28fbec23b055cd57f793f77dbfe3f1c9d18c2f24`, обычный status386, раскрытый6452;15 групп5775 и677 прочих записей. Запись файлов отсутствует. Дополнительный native copy путь остановился до UI на инициализации kernel assets (os error3); повторов/исправлений инструмента не было.

Обычным публичным HTTPS без авторизации получены три точных файла кабинета, перечисленные в manifest.json. SHA оболочки `ebd258b3c5cf5c98e5895b74cf5318fdc94960bfb6e7079b869cdfabda09cef6` совпал с фактическим HTTP SHA предыдущего482. Root просмотрел полный diff HTML и содержимое двух новых ресурсов; стандартные признаки private/vendor keys, Telegram token и literal Bearer не найдены. Это проверка выбранных файлов, не полноты всего сервера.

В08:02:28.530 третье read-only чтение получило7 hashes/размеров:6 managed source copies и host cabinet.html. Host SHA совпал с HTTP. RAW Git blob SHA main совпал для task-dispatch.js/MCP documents.js/MCP server.js; три content/auth-store.js/content/server.js/crm/server.js отличаются и ещё не перенесены. Значения в manifest.json. CRLF Windows checkout не использовались вместо Git blob доказательства. Для дальнейшего штатного сравнения151 публичного runtime файла подготовлены3 checksum списков, результат проверки действующих образов пока pending.

Content server точно восстановлен локально из baseline755e27… и pinned478/485 hunks:135915B/SHAe7e220…dd65, совпал с новым managed-source чтением; exact reverse до baseline PASS, нормализации нет. Независимая проверка всего файла и diff не нашла встроенных секретов/личных данных/наполненного seed. Root проверил SHA/размер, стандартные secret patterns и Node syntax. Ветка хранит файл как captured-source под docs:27 относительных imports отсутствуют в main, рабочий backend этим неполным деревом не заменялся. auth-store.js и crm/server.js пока не получены.

Локальные проверки: Spec Kit check48 verifiedFiles PASS; Node syntax project-forms.js и восстановленного content server PASS. Staged HTTP hashes проверяются отдельно: для CSS с CRLF точечный -text сохраняет1893 байта. Полный исходник через clipboard/OCR не переносился.

Состояние: сбор НЕ завершён; код/права/БД/службы сервера не менялись. Приёмки снимка, runtime reproduction, merge снимка и установки481 нет. Последующие записи должны явно обновить этот статус по фактическим результатам.
