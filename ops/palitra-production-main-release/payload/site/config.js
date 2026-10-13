window.PALITRA_CONFIG = {
  SITE_URL: "https://palitra-love.ru",
  // Обратимый режим витрины. Исходный прайс и редактор сохраняют все товары.
  FLOWERS_VISIBLE: false,
  FLOWER_CATEGORY_IDS: ["bukety", "korziny"],
  // Подтверждённые по фото растения и букет из смешанной категории «Прочее».
  // Название «Товар №…» и слово «букет» не используются для автоматической классификации.
  // import-tg-753-1 (30.09): смешанный заказ — в кадре обложки букет роз из того же заказа (import-tg-753-2 в «Букетах»).
  FLOWER_ITEM_IDS: ["import-tg-372-1", "import-tg-372-2", "import-tg-372-3", "import-tg-372-4", "import-tg-372-5", "import-tg-372-6", "import-tg-372-7", "import-tg-379-1", "import-tg-389-1", "import-tg-753-1"],
  FLOWER_PHOTO_PATHS: ["/assets/img/gortenzii.jpg", "/assets/img/hrizantema.jpg", "/assets/img/korzina-vegg.jpg", "/assets/img/letnyaya-korzina.jpg"],
  // Дарья 05.10.2026: «карточки без названия убрать». Обратимо: прайс, редактор ЛК и история не меняются,
  // карточка с пустым названием или с автоматическим «Товар №…» только не показывается на сайте.
  // false — вернуть показ всех; UNNAMED_SHOW_IDS — вернуть отдельные позиции, не меняя их данные.
  HIDE_UNNAMED: true,
  UNNAMED_SHOW_IDS: [],
  // Публичные категории в порядке Дарьи (05.10.2026). Данные прайса не переименовываются:
  // source — id категорий прайса, из которых берутся товары. Для новых категорий source — id,
  // который можно завести в прайсе; пока такой категории нет, раздел честно пустой.
  PUBLIC_CATEGORIES: [
    { key: "all", title: "Весь каталог", source: [] },
    { key: "vypiska", title: "Выписка", source: ["vypiska"] },
    { key: "dr-muzhchiny", title: "День рождения мужчины", source: ["dr-muzhchine"] },
    { key: "dr-devushki", title: "День рождения девушки", source: ["dr-zhenschine"] },
    { key: "dr-malyshey", title: "День рождения малышей", source: ["dr-detyam"] },
    { key: "gender-pati", title: "Гендер пати", source: ["gender-pati"] },
    { key: "devichnik", title: "Девичник", source: ["devichnik"] },
    { key: "malchishnik", title: "Мальчишник", source: ["malchishnik"] },
    { key: "dlya-mamy", title: "Шары для мамы", source: ["dlya-mamy"] },
    { key: "v-potolok", title: "Шары в потолок", source: ["v-potolok"] },
    { key: "s-foto", title: "Шары с фото", source: ["s-foto"] },
    { key: "dlya-biznesa", title: "Шары для бизнеса", source: ["dlya-biznesa"] }
  ],
  // Прежние адреса /catalog/<раздел> работают как раньше; здесь — только точные соответствия
  // для подсветки публичной категории (раздел с теми же товарами).
  LEGACY_SECTION_CATEGORY: { vypiska: "vypiska", muzhchinam: "dr-muzhchiny", devichnik: "devichnik" }
};
if (typeof document !== 'undefined') document.documentElement.dataset.flowers = window.PALITRA_CONFIG.FLOWERS_VISIBLE ? 'visible' : 'hidden';

// PALITRA-CHECKOUT 13.10.2026: приём заявок на подключённом магазине включён (тестовая блокировка черновика снята).
window.PALITRA_CONFIG.DRAFT_ONLY = false;
window.PALITRA_CONFIG.SITE_URL = location.origin;
// Явное решение Влада 13.10.2026: временные праздничные подборки Palitra — по московскому времени (только Palitra).
window.PALITRA_CONFIG.COMPANY_TIMEZONE = 'Europe/Moscow';

// Черновик: настоящие общие ракурсы тех же наборов, 12.10.2026. Общий прайс и цены не меняются.
// sourcePhoto — обложка в общем прайсе, к которой относится подмена: если Дарья заменит обложку в прайсе,
// черновик сразу покажет её фото, а не это.
window.PALITRA_CONFIG.DRAFT_PHOTO_OVERRIDES = {
  'vypiska-1': { sourcePhoto: '/assets/img/vypiska-malchik.jpg', photo: 'https://synapse.synapsebusiness.ru/content/publishing-assets/palitra-love/796154a73723327173395b8cdb2a4b14.jpg' },
  'import-drive-manual-014': { sourcePhoto: '/api/assets/mu57hpv7-import-drive-manual-014.webp', photo: 'https://synapse.synapsebusiness.ru/content/publishing-assets/palitra-love/b298da647f10164319be4f522545b46c.jpg' }
};