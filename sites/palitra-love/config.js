window.PALITRA_CONFIG = {
  SITE_URL: "https://palitra-love.ru",
  // Обратимый режим витрины. Исходный прайс и редактор сохраняют все товары.
  FLOWERS_VISIBLE: false,
  FLOWER_CATEGORY_IDS: ["bukety", "korziny"],
  // Подтверждённые по фото растения и букет из смешанной категории «Прочее».
  // Название «Товар №…» и слово «букет» не используются для автоматической классификации.
  // import-tg-753-1 (30.09): смешанный заказ — в кадре обложки букет роз из того же заказа (import-tg-753-2 в «Букетах»).
  FLOWER_ITEM_IDS: ["import-tg-372-1", "import-tg-372-2", "import-tg-372-3", "import-tg-372-4", "import-tg-372-5", "import-tg-372-6", "import-tg-372-7", "import-tg-379-1", "import-tg-389-1", "import-tg-753-1"],
  FLOWER_PHOTO_PATHS: ["/assets/img/gortenzii.jpg", "/assets/img/hrizantema.jpg", "/assets/img/korzina-vegg.jpg", "/assets/img/letnyaya-korzina.jpg"]
};
if (typeof document !== 'undefined') document.documentElement.dataset.flowers = window.PALITRA_CONFIG.FLOWERS_VISIBLE ? 'visible' : 'hidden';
