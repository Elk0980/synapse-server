/* Palitra: рендер прайса для страницы сайта и редактора Synapse. */
(function () {
  'use strict';
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
  const PRICE_UNKNOWN = 'Цена уточняется';
  /* Карточка без описания и без видимого примечания (на 02.10.2026 — 60 из 65 публичных карточек:
     у импортированных позиций описания нет, служебное примечание о цене скрыто). Раньше «Подробнее»
     открывало пустой блок и окно только с названием и ценой. Теперь — честная строка о том, что
     описания нет; состав, название и цену это не подменяет и не придумывает (specs/084). */
  const DETAILS_MISSING = 'Описание этого товара ещё не добавлено. Состав и стоимость менеджер подтвердит при заказе.';
  /* Служебные примечания импорта («Цена из публикации от 01.01.2026; актуальность уточняется при заказе»,
     «Цена на момент публикации, актуальную подтверждаем при заказе») на публичном сайте не показываются
     (замечание Дарьи 20.09.2026). Строки прайса не меняются: в редакторе ЛК примечание видно как есть,
     а любое другое примечание владельца (состав, размер, срок) остаётся на карточке. */
  // Без \b: в JS граница слова не работает для кириллицы.
  const AUTO_PRICE_NOTE = /^\s*цена\s+(?:из|на\s+момент)\s+публикации(?=[\s,;.:]|$)[\s\S]*актуальн/i;
  const isAutoPriceNote = (note) => AUTO_PRICE_NOTE.test(String(note ?? ''));
  function publicData(data, opts = {}) {
    const config = window.PALITRA_CONFIG || {};
    if (opts.editor || config.FLOWERS_VISIBLE !== false) return data;
    const categories = new Set(config.FLOWER_CATEGORY_IDS || ['bukety', 'korziny']);
    const items = new Set(config.FLOWER_ITEM_IDS || []);
    const photos = new Set(config.FLOWER_PHOTO_PATHS || []);
    return { ...data, categories: (data.categories || []).filter(cat => !categories.has(cat.id))
      .map(cat => ({ ...cat, items: (cat.items || []).filter(item => !items.has(item.id) && !photos.has(item.photo)) })) };
  }
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
  /* Несколько фото у товара (замечание Дарьи: «несколько фото у каждого товара»).
     Обложка — прежнее поле photo; дополнительные — необязательный список gallery. Товар без gallery
     выглядит и размечается как раньше. Только локальные пути сайта и https; повторы убираются; не больше 9. */
  const MAX_PHOTOS = 9;
  const safePhoto = (photo) => (typeof photo === 'string' && (/^\/(?!\/)/.test(photo) || /^https:\/\//i.test(photo)) ? photo : '');
  function photosOf(item) {
    // Обложка обрабатывается ровно как раньше (совместимость одиночного фото); дополнительные — строже.
    const cover = imageUrl(item.photo);
    const out = cover ? [cover] : [];
    for (const photo of Array.isArray(item.gallery) ? item.gallery : []) {
      if (out.length >= MAX_PHOTOS) break;
      // Дополнительные фото принимаются только как путь сайта или https — как проверяет сервер при сохранении.
      const url = safePhoto(typeof photo === 'string' ? photo.trim() : '');
      if (url && !out.includes(url)) out.push(url);
    }
    return out;
  }
  /* Лента с прокруткой и привязкой к кадру: на телефоне листается пальцем, на компьютере — кнопками
     и стрелками клавиатуры. Первое фото грузится как раньше, остальные — лениво. */
  function galleryHtml(item, images) {
    const total = images.length;
    const slides = images.map((src, index) => `<img class="price-card__photo photo" src="${esc(src)}" alt="${esc(item.title)} — фото ${index + 1} из ${total}" loading="lazy" decoding="async" width="800" height="1000">`).join('');
    return `<div class="product-media product-gallery" data-gallery role="group" aria-roledescription="галерея" aria-label="Фото товара: ${esc(item.title)}">`
      + `<div class="product-gallery__track" data-gallery-track tabindex="0" aria-label="Листайте фото: стрелки влево и вправо">${slides}</div>`
      + '<button class="product-gallery__nav product-gallery__nav--prev" type="button" data-gallery-prev aria-label="Предыдущее фото" disabled>‹</button>'
      + '<button class="product-gallery__nav product-gallery__nav--next" type="button" data-gallery-next aria-label="Следующее фото">›</button>'
      + `<p class="product-gallery__count" data-gallery-count aria-live="polite">1 / ${total}</p></div>`;
  }
  function galleryState(gallery) {
    const track = gallery.querySelector('[data-gallery-track]');
    const total = track ? track.children.length : 0;
    const width = track ? track.clientWidth : 0;
    const index = total && width ? Math.min(total - 1, Math.max(0, Math.round(track.scrollLeft / width))) : 0;
    return { track, total, index };
  }
  function syncGallery(gallery) {
    const { total, index } = galleryState(gallery);
    const count = gallery.querySelector('[data-gallery-count]');
    if (count) count.textContent = `${index + 1} / ${total}`;
    const prev = gallery.querySelector('[data-gallery-prev]');
    const next = gallery.querySelector('[data-gallery-next]');
    if (prev) prev.disabled = index <= 0;
    if (next) next.disabled = index >= total - 1;
  }
  function stepGallery(gallery, delta) {
    const { track, total, index } = galleryState(gallery);
    if (!track || !total) return;
    const target = Math.min(total - 1, Math.max(0, index + delta));
    const left = target * track.clientWidth;
    if (typeof track.scrollTo === 'function') track.scrollTo({ left, behavior: 'smooth' });
    else track.scrollLeft = left;
    syncGallery(gallery);
  }
  function installGallery(doc) {
    if (!doc || doc.__palitraGallery) return;
    doc.__palitraGallery = true;
    doc.addEventListener('click', (event) => {
      const button = event.target.closest && event.target.closest('[data-gallery-prev],[data-gallery-next]');
      if (!button) return;
      const gallery = button.closest('[data-gallery]');
      if (gallery) stepGallery(gallery, button.hasAttribute('data-gallery-next') ? 1 : -1);
    });
    doc.addEventListener('keydown', (event) => {
      const track = event.target.closest && event.target.closest('[data-gallery-track]');
      if (!track || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
      event.preventDefault();
      stepGallery(track.closest('[data-gallery]'), event.key === 'ArrowRight' ? 1 : -1);
    });
    // scroll не всплывает — слушаем на этапе перехвата, чтобы счётчик шёл за пальцем.
    doc.addEventListener('scroll', (event) => {
      const track = event.target && event.target.closest && event.target.closest('[data-gallery-track]');
      if (track) syncGallery(track.closest('[data-gallery]'));
    }, true);
  }
  function installDetails(doc) {
    if (!doc || doc.__palitraDetails) return;
    doc.__palitraDetails = true;
    let dialog, opener;
    const close = () => {
      if (!dialog) return;
      if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open');
      doc.body.classList.remove('product-dialog-open');
      opener?.focus();
    };
    doc.addEventListener('click', event => {
      if (event.target.closest('[data-product-close]')) { close(); return; }
      if (event.target.closest('.product-dialog [data-cart-open]')) { close(); return; }
      const summary = event.target.closest('[data-product-details] > summary');
      if (!summary) return;
      event.preventDefault();
      const card = summary.closest('.product-card');
      if (!card) return;
      if (!dialog) {
        dialog = doc.createElement('dialog');
        dialog.className = 'product-dialog';
        dialog.setAttribute('aria-labelledby', 'product-dialog-title');
        doc.body.append(dialog);
        dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
        dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
      }
      opener = summary;
      dialog.innerHTML = '<button type="button" class="product-dialog-close" data-product-close aria-label="Закрыть товар">×</button><div class="product-dialog-layout"></div>';
      const layout = dialog.querySelector('.product-dialog-layout');
      const media = card.querySelector('.product-media')?.cloneNode(true);
      if (media) layout.append(media);
      const body = doc.createElement('div'); body.className = 'product-dialog-body';
      const title = doc.createElement('h2'); title.id = 'product-dialog-title'; title.textContent = card.querySelector('h3')?.textContent || 'Товар';
      body.append(title);
      for (const field of card.querySelectorAll('[data-product-details] .price-card__description,[data-product-details] .note')) body.append(field.cloneNode(true));
      const footer = card.querySelector('.product-footer').cloneNode(true);
      /* Копия кнопки не наследует временную отметку «В корзине» после недавнего «Купить»:
         в окне всегда исходная подпись, сама кнопка по-прежнему только добавляет в корзину. */
      for (const add of footer.querySelectorAll('[data-add]')) {
        add.classList.remove('is-added');
        add.textContent = add.dataset.label || 'Купить';
      }
      body.append(footer);
      const checkout = doc.createElement('button'); checkout.type = 'button'; checkout.className = 'button outline';
      checkout.setAttribute('data-cart-open', ''); checkout.textContent = 'Перейти к оформлению'; body.append(checkout);
      layout.append(body);
      if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
      dialog.querySelectorAll('[data-gallery]').forEach(syncGallery);
      doc.body.classList.add('product-dialog-open');
      dialog.querySelector('[data-product-close]').focus();
    });
    doc.addEventListener('keydown', event => { if (event.key === 'Escape' && dialog?.open) { event.preventDefault(); close(); } });
  }
  /* Одна структура карточки для прайса и каталога: медиа-блок 4:5 (фото или заглушка),
     название, описание и примечание владельца — в содержимом; внизу у всех карточек ряда
     один и тот же компактный блок: цена + «Купить» (добавляет в корзину; онлайн-оплаты нет).
     Ссылок в Telegram и второй кнопки заявки в карточке нет (замечание Дарьи 20.09.2026).
     Пустая цена показывается словами, не нулём; тексты не обрезаются. */
  function productCard(item, opts = {}) {
    const editor = opts.editor || false;
    const images = photosOf(item);
    const media = images.length > 1
      ? galleryHtml(item, images)
      : images.length
        ? `<div class="product-media"><img class="price-card__photo photo" src="${esc(images[0])}" alt="${esc(item.title)}" loading="lazy" decoding="async" width="800" height="1000"></div>`
        : '<div class="product-media product-media--empty" aria-hidden="true"><img src="/assets/img/logo-mark.svg" alt="" width="64" height="64" loading="lazy"></div>';
    const description = item.desc ? `<p class="price-card__description">${esc(item.desc)}</p>` : '';
    // Редактор ЛК видит примечание как есть; публичная карточка скрывает служебное примечание импорта.
    const noteShown = Boolean(item.note) && (editor || !isAutoPriceNote(item.note));
    const note = noteShown ? `<p class="note">${esc(item.note)}</p>` : '';
    const star = editor ? opts.starHtml(item) : '';
    const priceText = !editor && window.PalitraPriceFormat ? window.PalitraPriceFormat.format(item.price) : String(item.price ?? '').trim();
    const known = Boolean(priceText);
    const price = `<p class="pc__price price" data-price-known="${known ? 'true' : 'false'}">${known ? esc(priceText) : PRICE_UNKNOWN}</p>`;
    const footer = editor
      ? `<div class="product-footer"><div class="product-purchase">${price}</div>${opts.editHtml(item)}</div>`
      : `<div class="product-footer"><div class="product-purchase">${price}<button class="button product-add" type="button" data-add data-id="${esc(item.id)}" data-title="${esc(item.title)}">Купить</button></div></div>`;
    const classes = ['pc', 'price-card', 'product-card'].concat(opts.extraClass ? [opts.extraClass] : []).join(' ');
    const dataCat = Array.isArray(opts.tags) && opts.tags.length ? ` data-cat="${esc(opts.tags.join(' '))}"` : '';
    const missing = description || note ? '' : `<p class="note product-details__missing" data-details-missing>${DETAILS_MISSING}</p>`;
    const details = editor ? description + note : `<details class="product-details" data-product-details><summary>Подробнее</summary>${description}${note}${missing}</details>`;
    return `<article class="${classes}" id="${esc(item.id)}" data-id="${esc(item.id)}"${dataCat}>${star}${media}<div class="price-card__body"><h3 class="pc__title">${esc(item.title)}</h3>${details}${footer}</div></article>`;
  }
  function renderSections(data, opts = {}) {
    return (publicData(data, opts).categories || []).filter((cat) => opts.editor || (cat.items || []).length).map((cat) => {
      const extra = opts.editor && opts.titleExtra ? opts.titleExtra(cat) : '';
      const cards = (cat.items || []).map((item) => productCard(item, opts)).join('\n');
      const empty = opts.editor && !cards ? '<p class="ps__note">В этом разделе пока нет позиций.</p>' : '';
      const tools = opts.editor && opts.addCardHtml ? opts.addCardHtml(cat) : '';
      return `<section class="ps" id="${esc(cat.id)}" data-cat="${esc(cat.id)}"><h2 class="ps__title">${esc(cat.title)}${extra}</h2><div class="price-grid">${cards}</div>${empty}${tools}</section>`;
    }).join('\n');
  }
  function renderNav(data, opts = {}) {
    const prefix = opts.prefix || '';
    return prefix + (publicData(data, opts).categories || []).filter((cat) => opts.editor || (cat.items || []).length).map((cat) => `<li><a class="pnav__top" href="#${esc(cat.id)}">${esc(cat.title)}</a></li>`).join('\n');
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
  if (typeof document !== 'undefined') { installGallery(document); installDetails(document); }
  window.PalitraPrice = { esc, findItem, isPopular, isAutoPriceNote, productCard, renderSections, renderNav, load, publicData, photosOf, syncGallery, PRICE_UNKNOWN, DETAILS_MISSING };
}());
