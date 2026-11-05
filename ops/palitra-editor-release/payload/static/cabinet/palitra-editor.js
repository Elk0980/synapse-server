/* Palitra: выбор раздела редактора. Только штатная cookie-сессия кабинета; токены в адресе не принимаются и не передаются. */
(() => {
  'use strict';
  const config = window.PALITRA_EDITOR_CONFIG || {};
  const byId = id => document.getElementById(id);
  const relative = value => typeof value === 'string' && /^\/[A-Za-z0-9/_.-]*(?:#[A-Za-z0-9_-]+)?$/.test(value) && !value.startsWith('//');
  // Ссылка из бота не должна нести секретов: если в адресе есть параметры или фрагмент — убираем их из истории.
  if (location.search || location.hash) history.replaceState(null, '', location.pathname);
  (async () => {
    let response;
    try { response = await fetch('/content/whoami', { credentials: 'same-origin', cache: 'no-store' }); }
    catch (_) { byId('status').textContent = ''; byId('error').textContent = 'Кабинет недоступен. Попробуйте позже'; return; }
    if (!response.ok) {
      byId('status').textContent = '';
      const login = relative(config.loginUrl) ? config.loginUrl : '/cabinet.html';
      byId('error').replaceChildren('Войдите в кабинет Synapse своим аккаунтом: ', Object.assign(document.createElement('a'), { href: login, textContent: 'вход в кабинет' }), '. После входа откройте «Редактор Palitra» снова.');
      return;
    }
    byId('status').textContent = '';
    const price = byId('price-link');
    if (relative(config.priceEditorUrl)) {
      price.href = config.priceEditorUrl + '?site=' + encodeURIComponent('https://palitra-love-draft-1.synapsebusiness.ru');
      price.hidden = false;
    }
    else byId('price-missing').hidden = false;
    byId('photos-link').href = relative(config.photosUrl) ? config.photosUrl : '/cabinet/site-photos.html';
    // Карточка доступа — только подсказка интерфейса; право владельца проверяет сервер на каждом запросе.
    let identity = null;
    try { identity = await response.json(); } catch (_) { identity = null; }
    if (identity && identity.role === 'owner') {
      byId('access-hub-link').href = relative(config.accessUrl) ? config.accessUrl : '/cabinet/site-photos-access.html';
      byId('access-card').hidden = false;
    }
    byId('hub').hidden = false;
  })();
})();
