/* One read-only source: /api/price, category first-visit, item first-1.
   The pin is a guard for the reviewed offer, never a fallback price/content copy. */
(function (host, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (host && host.document) api.start(host, host.document);
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';
  const OFFER_CONTRACT_SHA = '949388cddbb5fdb22abe869222e367dc5fc6211e59fc962c45e7c972a5bd9abc';
  const PRICE_PATH = '/api/price';
  const PRICE_LINK = '/price.html#first-1';
  const BOOKING_URL = 'https://n396010.yclients.com/company/375899/personal/menu';
  const MAX_RESPONSE = 512 * 1024;

  function fail(reason) { throw new Error(reason); }
  function plain(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
  function single(values, id) {
    if (!Array.isArray(values)) fail('unexpected-offer');
    const selected = values.filter(value => plain(value) && value.id === id);
    if (selected.length !== 1) fail('unexpected-offer');
    return selected[0];
  }
  function contract(item) {
    const keys = ['id', 'title', 'card', 'duration', 'price', 'desc', 'composition'];
    const selected = {};
    for (const key of keys) {
      if (typeof item[key] !== 'string' || !item[key] || item[key].length > 4000) fail('unexpected-offer');
      selected[key] = item[key];
    }
    return JSON.stringify(selected);
  }
  function safeBooking(value) {
    if (typeof value !== 'string') fail('unsafe-booking');
    let url;
    try { url = new URL(value); } catch (_) { fail('unsafe-booking'); }
    if (url.href !== BOOKING_URL || url.username || url.password || url.hash || url.search) fail('unsafe-booking');
    return url.href;
  }
  async function validateOffer(data, subtle) {
    if (!plain(data)) fail('unexpected-offer');
    const category = single(data.categories, 'first-visit');
    const item = single(category.items, 'first-1');
    const bytes = new TextEncoder().encode(contract(item));
    if (!subtle || typeof subtle.digest !== 'function') fail('verification-unavailable');
    const hash = Array.from(new Uint8Array(await subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
    if (hash !== OFFER_CONTRACT_SHA) fail('unexpected-offer');
    const booking = safeBooking(data.links && data.links.book);
    const minutes = /^([1-9]\d{0,2})\s*мин(?:\.|ут(?:а|ы)?)?$/u.exec(item.duration.trim());
    if (!minutes) fail('unexpected-offer');
    return Object.freeze({price: item.price, minutes: minutes[1], description: item.desc,
      conditions: item.composition, booking, priceLink: PRICE_LINK});
  }
  async function loadOffer(win) {
    const controller = new win.AbortController();
    const timer = win.setTimeout(() => controller.abort(), 5000);
    try {
      const response = await win.fetch(PRICE_PATH, {method: 'GET', credentials: 'omit', cache: 'no-store',
        headers: {'Accept': 'application/json'}, redirect: 'error', signal: controller.signal});
      if (!response.ok) fail('price-unavailable');
      const raw = await response.text();
      if (raw.length > MAX_RESPONSE) fail('price-response-too-large');
      return await validateOffer(JSON.parse(raw), win.crypto && win.crypto.subtle);
    } finally { win.clearTimeout(timer); }
  }
  function render(doc, offer) {
    doc.querySelector('[data-offer-price]').textContent = offer.price;
    doc.querySelector('[data-offer-duration]').textContent = 'Весь визит — ' + offer.minutes + ' минут';
    doc.querySelector('[data-offer-description]').textContent = offer.description;
    doc.querySelector('[data-offer-conditions]').textContent = offer.conditions;
    const booking = doc.querySelector('[data-offer-booking]');
    booking.setAttribute('href', offer.booking);
    booking.hidden = false;
    doc.querySelector('[data-offer-content]').hidden = false;
    doc.querySelector('[data-offer-fallback]').hidden = true;
    const status = doc.querySelector('[data-offer-status]');
    status.textContent = 'Предложение первого визита доступно.';
    status.setAttribute('aria-busy', 'false');
  }
  function unavailable(doc) {
    doc.querySelector('[data-offer-content]').hidden = true;
    const booking = doc.querySelector('[data-offer-booking]');
    booking.hidden = true;
    booking.removeAttribute('href');
    // Clear any value from a previous successful render. Never keep stale prices.
    for (const selector of ['[data-offer-price]', '[data-offer-duration]', '[data-offer-description]', '[data-offer-conditions]']) {
      doc.querySelector(selector).textContent = '';
    }
    doc.querySelector('[data-offer-fallback]').hidden = false;
    const status = doc.querySelector('[data-offer-status]');
    status.textContent = 'Предложение сейчас недоступно. Посмотрите действующий прайс или свяжитесь с администратором.';
    status.setAttribute('aria-busy', 'false');
  }
  async function start(win, doc) {
    try { render(doc, await loadOffer(win)); }
    catch (_) { unavailable(doc); }
  }
  return {PRICE_PATH, PRICE_LINK, OFFER_CONTRACT_SHA, contract, safeBooking, validateOffer, loadOffer, render, unavailable, start};
});
