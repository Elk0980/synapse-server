# План

## Основы и владение

Основная ветка получена свежим fetch; существующие runtime/sites файлы не заменяются. Публичные байты Авокадо проверены по manifest, старый checkout не использован как источник формы.

- ops/integrations/yandex/server: core, адаптеры, store, policy/jobs; один автор серверной области.
- ops/integrations/yandex/ui: представление и injected same-origin adapter; отдельный автор.
- ops/integrations/yandex/landing: две тонкие обёртки, общие JS/CSS, fixture/tests; отдельный автор.
- Root проверяет все области и создаёт пакет/PR, пользовательский постоянный отчёт хранится приватно.

## Контракты

Node22+ с JSON.parse source/JSON.rawJSON; injected bounded transport и secret resolver; actor создаёт только действующая auth-система. Хранилище для локального single-host кандидата; production ACL/backup/queue подключаются на свежей основе. UI не обращается к Яндексу. Посадочные используют существующие callback.js/attribution.js byte-exact. Схема БД и действующие сервисы не меняются.

## Проверки и установка

Сначала синтетические тесты company/race/replay/ID/provenance, затем local fixture без внешних POST/Метрики, затем независимый review. Установка требует fresh runtime/pins, одного писателя, backup и compatibility review; их наличие не подразумевается этой спецификацией. Веб-редактор Авокадо управляет текстами/фонами, но не добавлением статических файлов. OAuth создаётся только штатным процессом с необходимым личным подтверждением.
