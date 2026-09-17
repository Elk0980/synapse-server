/* Palitra: рендер прайса для страницы сайта и редактора Synapse. */
(function () {
  'use strict';
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
  const PRICE_UNKNOWN = 'Цена уточняется';
  const TELEGRAM_URL = 'https://t.me/palitralovee';
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
  /* Одна структура карточки для прайса и каталога: медиа-блок 4:5 (фото или заглушка),
     название, описание и примечание прайса — в содержимом; внизу у всех карточек ряда
     одинаковый блок: цена + «В корзину», затем ссылки Telegram и заявки под повод.
     Пустая цена показывается словами, не нулём; тексты не обрезаются. */
  function productCard(item, opts = {}) {
    const editor = opts.editor || false;
    const image = imageUrl(item.photo);
    const media = image
      ? `<div class="product-media"><img class="price-card__photo photo" src="${esc(image)}" alt="${esc(item.title)}" loading="lazy" decoding="async" width="800" height="1000"></div>`
      : '<div class="product-media product-media--empty" aria-hidden="true"><img src="/assets/img/logo-mark.svg" alt="" width="64" height="64" loading="lazy"></div>';
    const description = item.desc ? `<p class="price-card__description">${esc(item.desc)}</p>` : '';
    const note = item.note ? `<p class="note">${esc(item.note)}</p>` : '';
    const star = editor ? opts.starHtml(item) : '';
    const priceText = String(item.price ?? '').trim();
    const known = Boolean(priceText);
    const price = `<p class="pc__price price" data-price-known="${known ? 'true' : 'false'}">${known ? esc(priceText) : PRICE_UNKNOWN}</p>`;
    const footer = editor
      ? `<div class="product-footer"><div class="product-purchase">${price}</div>${opts.editHtml(item)}</div>`
      : `<div class="product-footer"><div class="product-purchase">${price}<button class="button product-add" type="button" data-add data-id="${esc(item.id)}" data-title="${esc(item.title)}">В корзину</button></div><p class="product-links"><a class="product-telegram" href="${TELEGRAM_URL}" target="_blank" rel="noopener">Канал в Telegram</a><a class="price-card__button" href="/#zayavka">Заказать под Ваш повод</a></p></div>`;
    const classes = ['pc', 'price-card', 'product-card'].concat(opts.extraClass ? [opts.extraClass] : []).join(' ');
    const dataCat = Array.isArray(opts.tags) && opts.tags.length ? ` data-cat="${esc(opts.tags.join(' '))}"` : '';
    return `<article class="${classes}" id="${esc(item.id)}" data-id="${esc(item.id)}"${dataCat}>${star}${media}<div class="price-card__body"><h3 class="pc__title">${esc(item.title)}</h3>${description}${note}${footer}</div></article>`;
  }
  function renderSections(data, opts = {}) {
    return (data.categories || []).filter((cat) => opts.editor || (cat.items || []).length).map((cat) => {
      const extra = opts.editor && opts.titleExtra ? opts.titleExtra(cat) : '';
      const cards = (cat.items || []).map((item) => productCard(item, opts)).join('\n');
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
  window.PalitraPrice = { esc, findItem, isPopular, productCard, renderSections, renderNav, load, PRICE_UNKNOWN };
}());
