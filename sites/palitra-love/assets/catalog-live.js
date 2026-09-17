/* Catalog cards use the same saved price document as the client editor. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else api.mount(root);
}(typeof window === 'undefined' ? null : window, function () {
  'use strict';
  const aliases = {
    vypiska: ['vypiska', 'shary', 'malysham'],
    'dr-detyam': ['den-rozhdeniya', 'malysham', 'shary'],
    'dr-muzhchine': ['den-rozhdeniya', 'muzhchinam', 'shary'],
    'dr-zhenschine': ['den-rozhdeniya', 'shary'],
    bukety: ['bukety'], korziny: ['korziny', 'bukety'],
    dofaminovye: ['dofaminovye', 'shary'],
    giganty: ['shary-giganty', 'shary'], devichnik: ['devichnik', 'shary']
  };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  function safeImage(value) {
    const url = String(value || '');
    return /^\/(?!\/)/.test(url) || /^https:\/\//i.test(url) ? url : '';
  }
  function entries(data, pathname) {
    const selected = pathname.replace(/\/(?:index\.html)?$/, '').split('/')[2] || '';
    return (data.categories || []).flatMap(category => (category.items || []).map(item => ({
      ...item, category: category.title,
      tags: [...new Set([category.id, ...(aliases[category.id] || [])])]
    }))).filter(item => !selected || item.tags.includes(selected));
  }
  /* Карточка каталога — та же карточка прайса (price-render.js), с тегами раздела для фильтра.
     Небезопасные адреса фото отбрасываются до рендера: остаётся заглушка. */
  function card(item, render) {
    const draw = typeof render === 'function' ? render : fallbackCard;
    return draw({ ...item, photo: safeImage(item.photo) }, { extraClass: 'card', tags: item.tags });
  }
  /* Запасная разметка на случай отсутствия price-render.js: та же структура и классы. */
  function fallbackCard(item, opts) {
    const image = safeImage(item.photo);
    const priceText = String(item.price ?? '').trim();
    const media = image
      ? `<div class="product-media"><img class="price-card__photo photo" src="${esc(image)}" alt="${esc(item.title)}" loading="lazy" decoding="async" width="800" height="1000"></div>`
      : '<div class="product-media product-media--empty" aria-hidden="true"><img src="/assets/img/logo-mark.svg" alt="" width="64" height="64" loading="lazy"></div>';
    return `<article class="pc price-card product-card${opts.extraClass ? ' ' + esc(opts.extraClass) : ''}" id="${esc(item.id)}" data-id="${esc(item.id)}"${opts.tags ? ` data-cat="${esc(opts.tags.join(' '))}"` : ''}>${media}<div class="price-card__body"><h3 class="pc__title">${esc(item.title)}</h3>${item.desc ? `<p class="price-card__description">${esc(item.desc)}</p>` : ''}${item.note ? `<p class="note">${esc(item.note)}</p>` : ''}<div class="product-footer"><div class="product-purchase"><p class="pc__price price" data-price-known="${priceText ? 'true' : 'false'}">${priceText ? esc(priceText) : 'Цена уточняется'}</p><button class="button product-add" type="button" data-add data-id="${esc(item.id)}" data-title="${esc(item.title)}">В корзину</button></div><p class="product-links"><a class="product-telegram" href="https://t.me/palitralovee" target="_blank" rel="noopener">Канал в Telegram</a><a class="price-card__button" href="/#zayavka">Заказать под Ваш повод</a></p></div></div></article>`;
  }
  function schema(list, origin, pathname) {
    return { '@context': 'https://schema.org', '@type': 'ItemList', name: 'Каталог Palitra',
      numberOfItems: list.length,
      itemListElement: list.map((item, index) => ({ '@type': 'ListItem', position: index + 1,
        item: { '@type': 'Product', name: item.title, url: `${origin}${pathname}#${encodeURIComponent(item.id)}`,
          ...(safeImage(item.photo) ? { image: new URL(item.photo, origin).href } : {}),
          ...(item.desc ? { description: item.desc } : {}) }
      })) };
  }
  function removeProductLists(node) {
    if (Array.isArray(node)) return node.map(removeProductLists).filter(Boolean);
    if (!node || typeof node !== 'object') return node;
    if (['Product', 'ItemList'].includes(node['@type'])) return null;
    const copy = { ...node };
    if (copy['@graph']) copy['@graph'] = removeProductLists(copy['@graph']);
    return copy;
  }
  async function mount(win) {
    const doc = win.document;
    if (doc.body.dataset.page !== 'catalog' || !win.PalitraPrice) return;
    const container = doc.querySelector('[data-products]');
    if (!container) return;
    const data = await win.PalitraPrice.load(['/api/price', '/data/price.json']);
    if (!data) return; // Keep the existing fallback if the service is unavailable.
    const list = entries(data, win.location.pathname);
    const render = win.PalitraPrice.productCard;
    container.innerHTML = list.length ? list.map(item => card(item, render)).join('') : '<p>В этом разделе пока нет товаров.</p>';
    doc.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
      try { script.textContent = JSON.stringify(removeProductLists(JSON.parse(script.textContent))); } catch (_) {}
    });
    const structured = doc.createElement('script');
    structured.type = 'application/ld+json';
    structured.id = 'palitra-catalog-schema';
    doc.head.append(structured);
    const updateSchema = () => {
      const filter = doc.querySelector('[data-filter][aria-pressed="true"]')?.dataset.filter || 'all';
      const visible = filter === 'all' ? list : list.filter(item => item.tags.includes(filter));
      structured.textContent = JSON.stringify(schema(visible, win.location.origin, win.location.pathname));
    };
    doc.querySelectorAll('[data-filter]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.filter === 'all'));
      button.addEventListener('click', () => {
        doc.querySelectorAll('[data-filter]').forEach(other => other.setAttribute('aria-pressed', String(other === button)));
        updateSchema();
      });
    });
    updateSchema();
  }
  return { entries, card, fallbackCard, schema, removeProductLists, mount };
}));
