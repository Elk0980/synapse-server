# Подтверждение заявки покупателю и выбранный Telegram

Spec: specs/092-palitra-order-customer-forms, FR-13/14, T020. Подготовлено и проверено локально; установка ещё не выполнена.

Actual main/draft order.js c590111397343a5b641ed84d44408aac8af82010973a88b106fa0d7ec4860ba6 после принятия заявки всегда переводит на /love-app/shop.html#chat?thread=N. На draft этот путь возвращает404. Готовое окно подтверждения и followTelegram не вызывались. Покупатель не видел успех и повторял отправку.

Единственный managed файл assets/order.js: существующий same-origin /chat?thread=N; окно с принятым номером без принудительного перехода; выбранный до reset Telegram получает проверенную c_ ссылку через существующий защищённый endpoint. Отказ явно показан, повтор ссылки не отправляет заявку заново. Формирование заявки, requestId, состав/цены, согласие, CSRF и права не меняются. Это не исправление доступности Telegram и не объединение карточек менеджера.

Три literal замены, полный обратный patch возвращает actual c590 побайтно. Root14 новых jsdom проверок PASS: обе площадки, старые/новые формы, корзина/подбор, сохранение requestId/ввода/согласия после потерянного ответа, double click, Telegram refusal/invalid/network/link-only retry, закрытие окна до позднего ответа. Локальный Chrome desktop/390/320 PASS без переполнения: подтверждение и unavailable Telegram. Только fake GUI orders2/link1/externalCalls0; стенд и вкладка закрыты. Это не реальная заявка и не физическая проверка iPhone.

## Ограниченная доставка336→337

verify_buyer_receipt.py — новый read-only checker/backup, не installer. Основа336/f3ec98b2c41c26d47ebf8a26f9599c0972d9cbc6de91d775f3808533d7dc789e; история336/141файл140прочих/прайс83/5полных runtime identities/hoststatic600 сохраняются. Добавлен exact storefront336 pin008f75ee…/64755B; register8d5f сохранён.28 функций принятого checker неизменны; compare добавляет pin/меняет labels, protect_before/readback меняют только имя защищённой копии. Full reverse exact48e6e0ab… . Ancestor приложен для review, запускать его нельзя.

23 synthetic SQLite/filesystem checker tests PASS83.883s. Native/HTTP вызовы замоканы. Проверяются полный history, неизвестные metadata, unrelated/foreign changes, modes, fullprice row/schema, one official Save, short180s permit, no replay/unknown outcome, ownlease. Не добавлены SQL DML/HTTP Save/docker exec/build/up/restart.

Root сначала свежие UI/account/company/source336, root/ownlease; один before создаёт отдельный private evidence namespace и backup root600/dir700. Только после PROTECTED_BEFORE_READY_NOT_SAVED в пределах180s — один штатный editor CAS Save единственного файла; затем отдельный after/fullreadback. Неизвестный исход — inspect, не повтор/rollback. Затем normal reload/main/draft/oldquery/resource pins и live forms без реальной отправки. R9–R13 и старые335/336 helpers не повторять. Общий restart/runtime/настройки/бизнес-записи не нужны.
