/* Palitra: настройки входа в редактор (PALITRA-BOT-EDITOR-35, проход 2).
   priceEditorUrl — действующий нативный редактор прайса кабинета (адрес подтверждён Root 12.10.2026).
   Пакет 12–18 подставляется только после его отдельной установки и QA Root.
   Только относительные пути кабинета https://synapse.synapsebusiness.ru, без токенов и параметров входа. */
window.PALITRA_EDITOR_CONFIG = Object.freeze({
  priceEditorUrl: '/price-editor-palitra.html',
  photosUrl: '/cabinet/site-photos.html',
  accessUrl: '/cabinet/site-photos-access.html',
  loginUrl: '/cabinet.html'
});
