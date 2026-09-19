/* Campaign continuity, conversion intents and the site counter.
   Единственный счётчик сайта — Яндекс Метрика 112772817 (номер подтверждён клиенткой
   18.09.2026). Вебвизор выключен. Загрузчик и инициализация выполняются ровно один раз. */
(function (host, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (host && host.document) api.start(host, host.document);
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';
  const storageKey = 'avk_src';
  const counterId = 112772817;
  const counterLoader = 'https://mc.yandex.ru/metrika/tag.js?id=' + counterId;
  const keys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'yclid'];
  const lifetime = 30 * 86400000;
  const sitePages = /\/(?:index\.html|price\.html|contacts\.html)?$/;
  const bookingHost = /(^|\.)yclients\.com$/i;
  function readAttribution(location, referrer, storage, now) {
    const query = new URL(location.href).searchParams;
    const incoming = {};
    keys.forEach(key => { const value = query.get(key); if (value) incoming[key] = value.slice(0, 512); });
    let saved = {};
    try { saved = JSON.parse(storage.getItem(storageKey) || '{}') || {}; } catch (_) {}
    const seen = Date.parse(saved.first_seen);
    let result = {};
    let internalReferrer = false;
    try { internalReferrer = new URL(referrer).origin === location.origin; } catch (_) {}
    if (Object.keys(incoming).length) {
      const sameCampaign = keys.every(key => (incoming[key] || '') === (saved[key] || ''));
      const keepDate = internalReferrer && sameCampaign && Number.isFinite(seen) && seen <= now && now - seen < lifetime;
      result = {...incoming, first_seen: keepDate ? saved.first_seen : new Date(now).toISOString()};
    } else if (Number.isFinite(seen) && seen <= now && now - seen < lifetime) {
      keys.forEach(key => { if (typeof saved[key] === 'string' && saved[key]) result[key] = saved[key].slice(0, 512); });
      result.first_seen = saved.first_seen;
    } else {
      try {
        const ref = new URL(referrer);
        if (['http:', 'https:'].includes(ref.protocol) && ref.hostname !== location.hostname) {
          result = {utm_source: ref.hostname.replace(/^www\./, ''), utm_medium: 'referral', first_seen: new Date(now).toISOString()};
        }
      } catch (_) {}
    }
    try {
      if (Object.keys(result).length) storage.setItem(storageKey, JSON.stringify(result));
      else storage.removeItem(storageKey);
    } catch (_) {}
    // Keep this visit's tags in memory even when browser storage is unavailable.
    return result;
  }
  function decorateUrl(value, base, attribution, entryPoint) {
    let url;
    try { url = new URL(value, base); } catch (_) { return value; }
    if (!['https:', 'http:'].includes(url.protocol)) return value;
    const current = new URL(base);
    const booking = bookingHost.test(url.hostname);
    const internal = url.origin === current.origin && sitePages.test(url.pathname) && url.pathname !== current.pathname && !value.startsWith('#');
    if (!booking && !internal) return value;
    keys.forEach(key => { if (attribution[key]) url.searchParams.set(key, attribution[key]); });
    // The ad creative's utm_content and the website button are different dimensions.
    if (booking && entryPoint) url.searchParams.set('entry_point', entryPoint);
    return url.href;
  }
  function classify(value, base) {
    let url;
    try { url = new URL(value, base); } catch (_) { return null; }
    if (url.protocol === 'tel:') return {event: 'phone_click', channel: 'phone'};
    if (['tg:', 'whatsapp:', 'viber:'].includes(url.protocol)) return {event: 'messenger_click', channel: url.protocol.slice(0, -1)};
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    if (bookingHost.test(url.hostname)) return {event: 'booking_click', channel: 'yclients'};
    for (const [host, channel] of [
      [/^(?:.+\.)?(?:wa\.me|whatsapp\.com)$/i, 'whatsapp'],
      [/^(?:.+\.)?(?:t\.me|telegram\.me|telegram\.org)$/i, 'telegram'],
      [/^(?:.+\.)?(?:vk\.com|vk\.me|vkontakte\.ru)$/i, 'vk'],
      [/^(?:.+\.)?max\.ru$/i, 'max']
    ]) if (host.test(url.hostname)) return {event: 'messenger_click', channel};
    const current = new URL(base);
    if (url.origin === current.origin) {
      if ((/\/price\.html$/.test(url.pathname) && url.pathname !== current.pathname) || url.hash === '#price') return {event: 'price_click'};
      if ((/\/contacts\.html$/.test(url.pathname) && url.pathname !== current.pathname) || url.hash === '#contacts') return {event: 'contact_choice'};
    }
    return null;
  }
  // Счётчик сайта. Договор о состоянии, важен для повторных вызовов:
  //   win.__metrikaReady выставляется ТОЛЬКО после того, как загрузчик реально вставлен
  //   в документ. Сбой до вставки состояние не меняет, поэтому следующий вызов
  //   с рабочим документом подключит счётчик как обычно.
  //   Возвращается true только когда вставлен загрузчик И прошла инициализация.
  // Аналитика ни при каких ошибках не должна обрывать атрибуцию, поэтому исключения
  // гасятся здесь, а не улетают в start().
  function startCounter(win, doc) {
    if (!win || win.__metrikaReady) return false;
    // Тот же признак отказа от трекинга, что и у emit() ниже — отдельной механики не заводим.
    if (win.navigator && win.navigator.doNotTrack === '1') return false;
    // Документ без создания элементов (тесты, урезанное окружение) — счётчик просто
    // не подключается, состояние не меняется.
    if (!doc || typeof doc.createElement !== 'function') return false;
    // Очередь ym определяется до вставки загрузчика, как в официальном коде счётчика.
    try {
      win.ym = win.ym || function () { (win.ym.a = win.ym.a || []).push(arguments); };
      win.ym.l = Number(new Date());
    } catch (_) { return false; }
    try {
      const script = doc.createElement('script');
      script.async = true;
      script.src = counterLoader;
      const scripts = typeof doc.getElementsByTagName === 'function' ? doc.getElementsByTagName('script') : null;
      const first = scripts && scripts[0];
      if (first && first.parentNode) first.parentNode.insertBefore(script, first);
      else (doc.head || doc.documentElement).appendChild(script);
    } catch (_) { return false; }
    // Загрузчик на странице — второй раз его вставлять нельзя даже при сбое init ниже.
    win.__metrikaReady = true;
    try {
      win.ym(counterId, 'init', {clickmap: true, trackLinks: true, accurateTrackBounce: true, webvisor: false});
    } catch (_) { return false; }
    return true;
  }
  function start(win, doc) {
    if (win.__avokadoAttributionLoaded) return;
    win.__avokadoAttributionLoaded = true;
    // Ещё один рубеж: что бы ни случилось со счётчиком, разметка ссылок и события
    // атрибуции обязаны запуститься.
    try { startCounter(win, doc); } catch (_) {}
    let storage;
    try { storage = win.localStorage; } catch (_) {}
    const attribution = readAttribution(win.location, doc.referrer || '', storage, Date.now());
    const page = /\/price\.html$/.test(win.location.pathname) ? 'price' : /\/contacts\.html$/.test(win.location.pathname) ? 'contacts' : 'landing';
    function entryPoint(anchor, event) {
      const value = anchor.getAttribute('data-entry-point') || '';
      return /^[a-z0-9_-]{1,80}$/i.test(value) ? value : page + '_' + event.replace(/_click$/, '');
    }
    function decorate(anchor) {
      const value = anchor.getAttribute('href');
      if (!value) return;
      const action = classify(value, win.location.href);
      const point = action && action.event === 'booking_click' ? entryPoint(anchor, 'booking_click') : '';
      const next = decorateUrl(value, win.location.href, attribution, point);
      if (next !== value) anchor.setAttribute('href', next);
    }
    function scan(node) {
      if (node.matches && node.matches('a[href]')) decorate(node);
      if (node.querySelectorAll) node.querySelectorAll('a[href]').forEach(decorate);
    }
    function emit(event) {
      if (win.navigator && win.navigator.doNotTrack === '1') return;
      win.dataLayer = win.dataLayer || [];
      win.dataLayer.push(event);
    }
    scan(doc);
    if (win.MutationObserver) new win.MutationObserver(records => records.forEach(record => {
      if (record.type === 'attributes') decorate(record.target);
      else record.addedNodes.forEach(scan);
    })).observe(doc.body, {subtree: true, childList: true, attributes: true, attributeFilter: ['href']});
    function onClick(event) {
      if (event.button !== undefined && event.button > 1) return;
      const anchor = event.target && event.target.closest && event.target.closest('a[href]');
      if (!anchor) return;
      // Capture also covers a newly inserted link before its mutation callback runs.
      decorate(anchor);
      const action = classify(anchor.getAttribute('href'), win.location.href);
      if (action) emit({...action, entry_point: entryPoint(anchor, action.event)});
    }
    doc.addEventListener('click', onClick, true);
    doc.addEventListener('auxclick', event => { if (event.button === 1) onClick(event); }, true);
    if (page === 'price') emit({event: 'price_view', entry_point: 'price_page'});
    return {attribution};
  }
  return {storageKey, lifetime, counterId, counterLoader, readAttribution, decorateUrl, classify, startCounter, start};
});
