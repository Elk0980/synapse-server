/* Локальный снимок каталога Palitra: фильтры, описание, фотографии. Запросов и заказов нет. */
'use strict';
(() => {
  const doc = document;
  const grid = doc.querySelector('[data-products]');
  const nav = doc.querySelector('[data-category-nav]');
  if (!grid || !nav) return;
  const cards = [...grid.querySelectorAll('.product-card')];
  const panels = [...nav.querySelectorAll('[data-filter-dropdown]')];
  const query = (selector) => nav.querySelector(selector);
  const state = { cat: 'all', to: 'all', min: null, max: null, sort: '' };
  const error = query('[data-price-error]');
  const count = query('[data-filter-count]');
  const empty = doc.createElement('p');
  empty.className = 'catalog-empty'; empty.hidden = true;
  empty.textContent = 'По выбранным фильтрам товаров пока нет — измените условия или сбросьте фильтры.';
  grid.after(empty);
  const priceOf = (card) => card.dataset.snapshotPrice === '' ? null : Number(card.dataset.snapshotPrice);
  const options = (kind) => [...nav.querySelectorAll(`[data-${kind}-option]`)];
  const closePanel = (panel, focus = false) => {
    panel.open = false;
    if (focus) panel.querySelector('summary').focus();
  };
  const closePanels = () => panels.forEach((panel) => closePanel(panel));
  const money = (value) => (value / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
  function render() {
    const matched = cards.filter((card) => {
      const tags = card.dataset.cat.split(/\s+/);
      const recipient = card.dataset.snapshotRecipients.split(/\s+/);
      const price = priceOf(card);
      return (state.cat === 'all' || tags.includes('pk-' + state.cat))
        && (state.to === 'all' || recipient.includes(state.to))
        && (state.min === null && state.max === null || price !== null
          && (state.min === null || price >= state.min) && (state.max === null || price <= state.max));
    });
    const visible = new Set(matched);
    cards.forEach((card) => { card.hidden = !visible.has(card); });
    const ordered = cards.slice();
    if (state.sort) ordered.sort((a, b) => {
      const ap = priceOf(a), bp = priceOf(b);
      if (ap === null || bp === null) return ap === bp ? 0 : ap === null ? 1 : -1;
      return (ap - bp) * (state.sort === 'price-desc' ? -1 : 1);
    });
    ordered.forEach((card) => grid.append(card));
    empty.hidden = matched.length !== 0;
    if (count) count.textContent = `Найдено: ${matched.length} ${matched.length === 1 ? 'товар' : matched.length % 10 >= 2 && matched.length % 10 <= 4 && (matched.length % 100 < 10 || matched.length % 100 >= 20) ? 'товара' : 'товаров'}`;
    for (const kind of ['cat', 'to']) {
      const selected = options(kind).find((button) => button.dataset[kind + 'Option'] === state[kind]);
      options(kind).forEach((button) => button.setAttribute('aria-pressed', String(button === selected)));
      const panel = query(`[data-filter-dropdown="${kind}"]`);
      if (selected && panel) panel.querySelector('[data-dropdown-value]').textContent = selected.querySelector('.catalog-dropdown__text').textContent
        + (kind === 'cat' ? ` (${selected.querySelector('.catalog-dropdown__count').textContent})` : '');
    }
    const summary = query('[data-filter-dropdown="price"] [data-dropdown-value]');
    const range = state.min === null && state.max === null ? 'Любая'
      : state.min !== null && state.max !== null ? `${money(state.min)}–${money(state.max)} ₽`
        : state.min !== null ? `от ${money(state.min)} ₽` : `до ${money(state.max)} ₽`;
    if (summary) summary.textContent = range + (state.sort ? state.sort === 'price-asc' ? ' · по возрастанию' : ' · по убыванию' : '');
    nav.querySelectorAll('[data-price-sort]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.priceSort === state.sort)));
  }
  const parseMoney = (value) => {
    if (!value.trim()) return null;
    const clean = value.replace(/[\s\u00a0]/g, '');
    if (!/^\d{1,7}(?:[.,]\d{1,2})?$/.test(clean)) return NaN;
    const amount = Number(clean.replace(',', '.'));
    return amount > 0 ? Math.round(amount * 100) : NaN;
  };
  function applyPrice() {
    const min = parseMoney(query('[data-price-min]').value);
    const max = parseMoney(query('[data-price-max]').value);
    const invalid = Number.isNaN(min) || Number.isNaN(max) || min !== null && max !== null && min > max;
    if (error) { error.hidden = !invalid; error.textContent = invalid ? 'Проверьте суммы «от» и «до».' : ''; }
    if (invalid) return;
    Object.assign(state, { min, max }); render(); closePanels();
  }
  nav.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    for (const kind of ['cat', 'to']) if (button.hasAttribute(`data-${kind}-option`)) {
      state[kind] = button.dataset[kind + 'Option']; render();
      const panel = button.closest('details'); if (panel) closePanel(panel, true);
      return;
    }
    if (button.hasAttribute('data-price-sort')) { state.sort = button.dataset.priceSort; render(); return; }
    if (button.hasAttribute('data-price-apply')) { applyPrice(); return; }
    if (button.hasAttribute('data-filter-reset')) {
      Object.assign(state, { cat: 'all', to: 'all', min: null, max: null, sort: '' });
      query('[data-price-min]').value = ''; query('[data-price-max]').value = '';
      if (error) { error.hidden = true; error.textContent = ''; }
      closePanels(); render();
    }
  });
  nav.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      const panel = event.target.closest('details'); if (panel) { event.preventDefault(); closePanel(panel, true); }
    }
    if (event.key === 'Enter' && event.target.matches('[data-price-min],[data-price-max]')) { event.preventDefault(); applyPrice(); }
  });
  for (const panel of panels) panel.addEventListener('toggle', () => { if (panel.open) panels.filter((other) => other !== panel).forEach((other) => closePanel(other)); });
  doc.addEventListener('click', (event) => { if (!nav.contains(event.target)) closePanels(); });

  function syncGallery(gallery) {
    const track = gallery.querySelector('[data-gallery-track]');
    const total = track.children.length;
    const index = track.clientWidth ? Math.min(total - 1, Math.round(track.scrollLeft / track.clientWidth)) : Number(track.dataset.snapshotIndex || 0);
    const label = gallery.querySelector('[data-gallery-count]'); if (label) label.textContent = `${index + 1} / ${total}`;
    gallery.querySelector('[data-gallery-prev]').disabled = index <= 0;
    gallery.querySelector('[data-gallery-next]').disabled = index >= total - 1;
  }
  function stepGallery(gallery, delta) {
    const track = gallery.querySelector('[data-gallery-track]');
    const current = track.clientWidth ? Math.round(track.scrollLeft / track.clientWidth) : Number(track.dataset.snapshotIndex || 0);
    const target = Math.max(0, Math.min(track.children.length - 1, current + delta));
    track.dataset.snapshotIndex = String(target);
    if (typeof track.scrollTo === 'function') track.scrollTo({ left: target * track.clientWidth, behavior: 'smooth' });
    else track.scrollLeft = target * track.clientWidth;
    syncGallery(gallery);
  }
  doc.addEventListener('click', (event) => {
    const galleryButton = event.target.closest('[data-gallery-prev],[data-gallery-next]');
    if (galleryButton) { stepGallery(galleryButton.closest('[data-gallery]'), galleryButton.hasAttribute('data-gallery-next') ? 1 : -1); return; }
    const button = event.target.closest('[data-product-open]');
    if (!button) return;
    const details = button.closest('.product-card').querySelector('[data-product-details]');
    details.hidden = !details.hidden;
    button.setAttribute('aria-expanded', String(!details.hidden));
  });
  doc.addEventListener('keydown', (event) => {
    const track = event.target.closest('[data-gallery-track]');
    if (track && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) { event.preventDefault(); stepGallery(track.closest('[data-gallery]'), event.key === 'ArrowRight' ? 1 : -1); }
  });
  doc.addEventListener('scroll', (event) => { if (event.target.matches && event.target.matches('[data-gallery-track]')) syncGallery(event.target.closest('[data-gallery]')); }, true);

  // Геометрия сохранённого кадра — из публичного price-render.js; контейнер имеет исходную пропорцию 4:5.
  const phone = {
    'https://synapse.synapsebusiness.ru/content/publishing-assets/palitra-love/b298da647f10164319be4f522545b46c.jpg': [1290 / 2293, 0.5, 0.49900596421],
    'https://palitra-love.ru/api/assets/mu57hpv8-import-drive-manual-017.webp': [738 / 1313, 0.5, 0.49825783972],
    'https://palitra-love.ru/api/assets/mu57hqwj-import-drive-manual-007.webp': [740 / 1326, 0.5, 0.5],
    'https://palitra-love.ru/api/assets/mu57hrnk-import-tg-366-5.webp': [738 / 1313, 0.5, 0.49825783972],
    'https://palitra-love.ru/api/assets/mu57hruk-import-tg-366-6.webp': [738 / 1313, 0.5, 0.49825783972],
    'https://palitra-love.ru/api/assets/mu57htdm-import-tg-310-2.webp': [738 / 1313, 0.5, 0.49825783972],
    'https://palitra-love.ru/api/assets/mu57ilxc-import-tg-503-2.webp': [738 / 1313, 0.5, 0.49825783972],
    'https://palitra-love.ru/api/assets/mu57imni-import-drive-manual-012.webp': [738 / 1313, 0.5, 0.49825783972]
  };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const axis = (box, size, focus) => clamp(box / 2 - focus * size, size >= box ? box - size : 0, size >= box ? 0 : box - size);
  const percent = (value) => `${Math.round(value * 1000000) / 10000}%`;
  function frameImage(img) {
    const values = (img.dataset.photoFrame || '').split(' ').map(Number);
    if (values.length !== 3 || values.some((value) => !Number.isFinite(value))) return;
    const [fx, fy, scale] = values; const box = img.parentElement;
    const w = img.naturalWidth, h = img.naturalHeight, bw = box.clientWidth, bh = box.clientHeight;
    if (![w, h, bw, bh].every((value) => value > 0)) return;
    let ux = 0, uy = 0, uw = w, uh = h; const mask = phone[img.src];
    if (mask) { if (w / h > mask[0]) { uw = h * mask[0]; ux = mask[1] * (w - uw); } else { uh = w / mask[0]; uy = mask[2] * (h - uh); } }
    const k = Math.min(bw / uw, bh / uh) * scale;
    const properties = { position: 'absolute', left: percent((axis(bw, uw * k, fx) - ux * k) / bw), top: percent((axis(bh, uh * k, fy) - uy * k) / bh), right: 'auto', bottom: 'auto', width: percent(w * k / bw), height: percent(h * k / bh), 'max-width': 'none', 'max-height': 'none', 'min-width': '0', 'min-height': '0', margin: '0', padding: '0', 'aspect-ratio': 'auto', 'object-fit': 'fill', 'object-position': '50% 50%', transform: 'none', translate: 'none', scale: 'none', 'clip-path': `inset(${percent(uy / h)} ${percent((w - ux - uw) / w)} ${percent((h - uy - uh) / h)} ${percent(ux / w)})` };
    for (const [key, value] of Object.entries(properties)) img.style.setProperty(key, value, 'important');
    box.style.setProperty('overflow', 'hidden'); box.style.setProperty('position', 'relative');
  }
  const framed = [...doc.querySelectorAll('img[data-photo-frame]')];
  framed.forEach((img) => { img.addEventListener('load', () => frameImage(img)); if (img.complete) frameImage(img); });
  if (typeof ResizeObserver === 'function') { const observer = new ResizeObserver(() => framed.forEach(frameImage)); framed.forEach((img) => observer.observe(img.parentElement)); }
  doc.querySelectorAll('[data-gallery]').forEach(syncGallery);
  render();
})();
