# План

Владелец: Claude — агент аналитики (№97, родитель №92). Файлы: ops/crm/server.js (ответ POST /leads),
ops/crm/lead-public-response.test.js, ops/crm/analytics.test.js (читает источник через GET с ключом), этот каталог.
Используется существующее: проверка ключа как в requireApiKey, serializeLead. Миграций нет, откат — вернуть строку ответа.
PR 499 (сшивка заявки с визитом) построен поверх этой ветки: правка того же участка, один исполнитель.
Проверки: тест ответа, analytics/origin, тесты форм sites/avokado3 и sites/alvi, полный ops/crm, gate.py check.
