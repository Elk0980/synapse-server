# Повторная проверка доступа завершения Контент завода

Spec Kit1.0.0, root. Только существующая проверка session/company/CSRF, новые права не создаются.

- FR-001 Для PUT workflow, POST отдельной версии и POST legacy variant decision/transfer Content proxy сначала дочитывает ограниченный JSON body, затем повторяет autoposting.edit своей компании/CSRF/userId. variants decision требует свежего owner. Отозванное во время body право не достигает записи CRM.
- FR-002 В доверенный CRM header идёт свежая identity, пользовательский header всегда удаляется; actor после смены displayName актуален. Без mutation старые маршруты/streaming поведение не меняются.
- FR-003 Не менять global permissions/другие компании/production/агентские активные файлы. Подключение только root ops/content/server.js, existing actual inputs-proxy fixture и её UI worker probe при необходимости, этот spec.

Приёмка: actual synthetic Content+CRM. Убедиться, что поток принят после initial auth, приостановить body, отозвать edit в synthetic auth DB, закончить body:403 без новой workflow версии/child. Тот же controlled input на прежнем proxy должен воспроизвести200/201. Fresh actor check отдельно. Normal reads/writes/CSRF/изолированные компании проходят.
