# План

Владелец: Claude (единственный автор). Разрешённые файлы: `sites/palitra-love/price-render.js`, `sites/palitra-love/assets/catalog-live.js`, версии подключения в 24 HTML `sites/palitra-love`, тесты `sites/palitra-love/{client-check,mobile-cards,pages}.test.cjs`, этот каталог. Занятость: на доске и в открытых ветках `origin` правок `sites/palitra-love` нет; `main` 81789e0.

1. `price-render.js` — константа `DETAILS_MISSING`; в публичной карточке строка `[data-details-missing]` при пустых описании и видимом примечании; в окне товара копия кнопки без отметки «В корзине»; экспорт `DETAILS_MISSING`.
2. `catalog-live.js` — та же строка в запасной разметке; экспорт `DETAILS_MISSING`.
3. HTML — `?v=20261002details1` у `price-render.js` и `catalog-live.js`.
4. Тесты SC-001–SC-002, мутации, локальный стенд.

Выпуск — статика сайта; данные прайса и сервер не меняются. Откат — возврат двух файлов и версий.
