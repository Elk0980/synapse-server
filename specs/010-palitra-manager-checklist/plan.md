# План

1. В site-orders.js добавить отдельные таблицы текущих отметок/событий, без изменения существующих статусов. Два ключа, проверка Palitra, версия на каждую отметку, серверный actor.
2. orderJSON и orderSummary включают checklist только для Palitra. ЛК получает последние 20 событий истории с текущими значениями; полный журнал остаётся в БД.
3. Узкий PUT /content/palitra/orders/:id/checklist под существующими owner+CSRF: body item/checked/revision, unknown fields запрещены. GET того же пути возвращает текущую заявку владельцу для разрешения409 без потери строк за первой страницей.
4. client-dialogs.js добавляет две строки клавиатуры и callback oc:order:item:checked:revision. Проверяет активного оператора и client_bot_map; сохраняет отметку, возвращает существующему мосту обновление той же клавиатуры. Ошибка редактирования сообщения не откатывает БД и не отправляет клиенту ничего.
5. cabinet/site-orders.js/css — две компактные отметки, последняя подпись/время, история, явная отмена. На409 обновляет конкретную заявку без потери ранее показанных строк.
6. Unit, HTTP, DOM и существующие client-dialogs/bridge тесты, diff check, Spec Kit converge/gate. Commit и отдельный зависимый PR, без merge/deploy.
7. По замечанию при live-приёмке подпись старой проверки получателя в Palitra уточнить датой и явно отделить от доставки заявок; backend-историю и транспорт не менять.

Один писатель: site-orders*, client-dialogs*, узкий server.js, cabinet/site-orders*, spec010. Base ea34364, branch codex/palitra-manager-checklist-20260930. project-chat.js/CRM/напоминания — вне области.
