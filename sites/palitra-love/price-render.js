/* Palitra: рендер прайса для страницы сайта и редактора Synapse. */
(function () {
  'use strict';
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
  const PRICE_UNKNOWN = 'Цена уточняется';
  /* Служебные примечания импорта («Цена из публикации от 01.01.2026; актуальность уточняется при заказе»,
     «Цена на момент публикации, актуальную подтверждаем при заказе») на публичном сайте не показываются
     (замечание Дарьи 20.09.2026). Строки прайса не меняются: в редакторе ЛК примечание видно как есть,
     а любое другое примечание владельца (состав, размер, срок) остаётся на карточке. */
  // Без \b: в JS граница слова не работает для кириллицы.
  const AUTO_PRICE_NOTE = /^\s*цена\s+(?:из|на\s+момент)\s+публикации(?=[\s,;.:]|$)[\s\S]*актуальн/i;
  const isAutoPriceNote = (note) => AUTO_PRICE_NOTE.test(String(note ?? ''));
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
     название, описание и примечание владельца — в содержимом; внизу у всех карточек ряда
     один и тот же компактный блок: цена + «Купить» (добавляет в корзину; онлайн-оплаты нет).
     Ссылок в Telegram и второй кнопки заявки в карточке нет (замечание Дарьи 20.09.2026).
     Пустая цена показывается словами, не нулём; тексты не обрезаются. */
  function productCard(item, opts = {}) {
    const editor = opts.editor || false;
    const image = imageUrl(item.photo);
    const media = image
      ? `<div class="product-media"><img class="price-card__photo photo" src="${esc(image)}" alt="${esc(item.title)}" loading="lazy" decoding="async" width="800" height="1000"></div>`
      : '<div class="product-media product-media--empty" aria-hidden="true"><img src="/assets/img/logo-mark.svg" alt="" width="64" height="64" loading="lazy"></div>';
    const description = item.desc ? `<p class="price-card__description">${esc(item.desc)}</p>` : '';
    // Редактор ЛК видит примечание как есть; публичная карточка скрывает служебное примечание импорта.
    const noteShown = Boolean(item.note) && (editor || !isAutoPriceNote(item.note));
    const note = noteShown ? `<p class="note">${esc(item.note)}</p>` : '';
    const star = editor ? opts.starHtml(item) : '';
    const priceText = String(item.price ?? '').trim();
    const known = Boolean(priceText);
    const price = `<p class="pc__price price" data-price-known="${known ? 'true' : 'false'}">${known ? esc(priceText) : PRICE_UNKNOWN}</p>`;
    const footer = editor
      ? `<div class="product-footer"><div class="product-purchase">${price}</div>${opts.editHtml(item)}</div>`
      : `<div class="product-footer"><div class="product-purchase">${price}<button class="button product-add" type="button" data-add data-id="${esc(item.id)}" data-title="${esc(item.title)}">Купить</button></div></div>`;
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
  window.PalitraPrice = { esc, findItem, isPopular, isAutoPriceNote, productCard, renderSections, renderNav, load, PRICE_UNKNOWN };
}());
