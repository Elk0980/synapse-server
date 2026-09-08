/* Palitra Love: рендер прайса для страницы сайта и редактора Synapse. */
(function () {
  'use strict';
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
  function findItem(data, id) {
    for (const cat of data.categories || []) {
      const it = (cat.items || []).find((item) => item.id === id);
      if (it) return { cat, it };
    }
    return null;
  }
  function isPopular(data, id) {
    return ['self', 'two'].some((block) => (data.showcase?.[block] || []).includes(id));
  }
  function imageUrl(photo) {
    if (!photo) return '';
    if (/^(https?:)?\/\//.test(photo) || photo.startsWith('/')) return photo;
    return '/' + photo.replace(/^\.\//, '');
  }
  function productCard(data, item, opts) {
    const editor = opts.editor || false;
    const photo = item.photo ? `<img class="price-card__photo" src="${esc(imageUrl(item.photo))}" alt="${esc(item.title)}" loading="lazy">` : '';
    const description = item.desc ? `<p class="price-card__description">${esc(item.desc)}</p>` : '';
    const note = item.note ? `<p class="note">${esc(item.note)}</p>` : '';
    const star = editor ? opts.starHtml(item) : '';
    const edit = editor ? opts.editHtml(item) : `<a class="button outline price-card__button" href="/#zayavka">Заказать под Ваш повод</a>`;
    const price = `<p class="pc__price">${esc(item.price)}</p>`;
    const purchase = editor ? price : `<div class="product-purchase">${price}<a class="button product-telegram" href="https://t.me/palitralovee" target="_blank" rel="noopener">Написать в Telegram</a></div>`;
    return `<article class="pc price-card" id="${esc(item.id)}" data-id="${esc(item.id)}">${star}${photo}<div class="price-card__body"><h3 class="pc__title">${esc(item.title)}</h3>${description}${purchase}${note}${edit}</div></article>`;
  }
  function renderSections(data, opts = {}) {
    return (data.categories || []).filter((cat) => opts.editor || (cat.items || []).length).map((cat) => {
      const extra = opts.editor && opts.titleExtra ? opts.titleExtra(cat) : '';
      const cards = (cat.items || []).map((item) => productCard(data, item, opts)).join('\n');
      const empty = opts.editor && !cards ? '<p class="ps__note">В этом разделе пока нет позиций.</p>' : '';
      const tools = opts.editor && opts.addCardHtml ? opts.addCardHtml(cat) : '';
      return `<section class="ps" id="${esc(cat.id)}" data-cat="${esc(cat.id)}"><h2 class="ps__title">${esc(cat.title)}${extra}</h2><div class="price-grid">${cards}</div>${empty}${tools}</section>`;
    }).join('\n');
  }
  function renderNav(data, opts = {}) {
    const prefix = opts.prefix || '';
    return prefix + (data.categories || []).filter((cat) => opts.editor || (cat.items || []).length).map((cat) => `<li><a class="pnav__top" href="#${esc(cat.id)}">${esc(cat.title)}</a></li>`).join('\n');
  }
  const CACHE_KEY = 'palitra-public-price-v1';
  const validPrice = (data) => data && Array.isArray(data.categories) && data.categories.every((cat) =>
    cat && typeof cat.id === 'string' && typeof cat.title === 'string' && Array.isArray(cat.items) &&
    cat.items.every((item) => item && typeof item.id === 'string' && typeof item.title === 'string'));
  function readCachedPrice() {
    try {
      const data = JSON.parse(localStorage.getItem(CACHE_KEY));
      return validPrice(data) ? data : null;
    } catch (_) { return null; }
  }
  async function fetchPrice(source) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      // Public document only: no session, API key or CSRF token leaves this page.
      const response = await fetch(source, { cache: 'no-store', credentials: 'omit', signal: controller.signal });
      if (!response.ok) return null;
      const data = await response.json();
      return validPrice(data) ? data : null;
    } catch (_) { return null; }
    finally { clearTimeout(timeout); }
  }
  async function load(paths) {
    const cached = readCachedPrice();
    const latest = await fetchPrice(paths[0]);
    if (latest) {
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(latest)); } catch (_) { /* Storage can be disabled. */ }
      return latest;
    }
    if (cached) return cached;
    for (const source of paths.slice(1)) {
      const fallback = await fetchPrice(source);
      if (fallback) return fallback;
    }
    return null;
  }
  window.PalitraPrice = { esc, findItem, isPopular, renderSections, renderNav, load };
}());
