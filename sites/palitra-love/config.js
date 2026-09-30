window.PALITRA_CONFIG = {
  SITE_URL: "https://palitra-love.ru",
  // Обратимый режим витрины. Исходный прайс и редактор сохраняют все товары.
  FLOWERS_VISIBLE: false,
  FLOWER_CATEGORY_IDS: ["bukety", "korziny"],
  FLOWER_ITEM_IDS: ["import-tg-372-3"],
  FLOWER_PHOTO_PATHS: ["/assets/img/gortenzii.jpg", "/assets/img/hrizantema.jpg", "/assets/img/korzina-vegg.jpg", "/assets/img/letnyaya-korzina.jpg"]
};
if (typeof document !== 'undefined') document.documentElement.dataset.flowers = window.PALITRA_CONFIG.FLOWERS_VISIBLE ? 'visible' : 'hidden';
