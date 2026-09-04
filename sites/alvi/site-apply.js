/* ALVI · применение текстов и фонов главной из документа alvi/site (редактируется в кабинете Synapse).
   Разметка страницы — запасной вариант: если документ недоступен, страница остаётся как есть. */
(function () {
  'use strict';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  /* Текст → безопасный HTML: разрешены только em, strong, b, i, sup и перенос строки. */
  function rich(value) {
    let h = esc(value);
    h = h.replace(/&lt;(\/?)(em|strong|b|i|sup)&gt;/g, '<$1$2>');
    return h.replace(/\n/g, '<br>');
  }

  /* Шрифты, которые можно выбрать в редакторе (Google Fonts). Пусто — как на сайте. */
  const FONTS = {
    'Lora': '"Lora", Georgia, serif',
    'Cormorant Garamond': '"Cormorant Garamond", Georgia, serif',
    'Playfair Display': '"Playfair Display", Georgia, serif',
    'Noto Serif': '"Noto Serif", Georgia, serif',
    'Manrope': '"Manrope", "Segoe UI", Arial, sans-serif',
    'Montserrat': '"Montserrat", "Segoe UI", Arial, sans-serif',
    'Nunito': '"Nunito", "Segoe UI", Arial, sans-serif',
  };
  function loadFonts(names) {
    const need = [...new Set(names)].filter((n) => FONTS[n] && n !== 'Lora');
    if (!need.length) return;
    const id = 'alvi-site-fonts';
    const fam = need.map((n) => 'family=' + encodeURIComponent(n).replace(/%20/g, '+') + ':ital,wght@0,400;0,500;0,600;1,400').join('&');
    const href = 'https://fonts.googleapis.com/css2?' + fam + '&display=swap';
    let link = document.getElementById(id);
    if (link && link.getAttribute('href') === href) return;
    if (!link) { link = document.createElement('link'); link.id = id; link.rel = 'stylesheet'; document.head.appendChild(link); }
    link.href = href;
  }
  function applyStyle(el, style) {
    const st = style || {};
    if (st.font && FONTS[st.font]) el.style.fontFamily = FONTS[st.font]; else el.style.fontFamily = '';
    const pct = Number(st.size);
    if (pct && pct !== 100) {
      el.style.fontSize = '';
      const base = parseFloat(getComputedStyle(el).fontSize);
      el.style.fontSize = (base * pct / 100).toFixed(2) + 'px';
    } else {
      el.style.fontSize = '';
    }
  }
  let lastDoc = null;
  const EDIT_MODE = new URLSearchParams(location.search).get('edit') === '1' && window.parent !== window;

  /* ---------- Объекты и расположение (мини-конструктор: баннер и сцены первого экрана) ---------- */
  const ZONES = { 'promo-head': '.promo__head', 'promo-alvi': '.promo__half--alvi', 'promo-avokado': '.promo__half--avokado' };
  function zoneEl(zone) {
    if (ZONES[zone]) return document.querySelector(ZONES[zone]);
    const m = /^hero-(\d)$/.exec(zone || '');
    if (m) return document.querySelector(`.hero-scene[data-scene="${m[1]}"] .hero-scene__content`);
    return null;
  }
  const safeHref = (h) => /^(https?:\/\/|mailto:|tel:|#|\/|[\w-]+\.html)/i.test(h || '') ? h : '#';
  const safeSrc = (u) => /^(img\/|\/api\/assets\/|https:\/\/)[\w\-./%]+$/.test(u || '') ? u : '';
  /* Добавленный в редакторе объект: создаём элемент в своей зоне, если его ещё нет на странице. */
  function ensureExtra(f) {
    let el = document.querySelector(`[data-edit="${CSS.escape(f.key)}"]`);
    if (el) return el;
    const zone = zoneEl(f.zone); if (!zone) return null;
    const inHero = /^hero-/.test(f.zone || '');
    if (f.kind === 'button') { el = document.createElement('a'); el.className = (inHero ? 'button' : 'price-all__button promo__button') + ' x-extra x-extra--button'; el.target = '_blank'; el.rel = 'noopener'; }
    else if (f.kind === 'image') { el = document.createElement('img'); el.className = 'x-extra x-extra--image'; el.alt = ''; el.loading = 'lazy'; }
    else { el = document.createElement('p'); el.className = (inHero ? 'scene-copy' : 'promo__copy') + ' x-extra x-extra--text'; }
    el.setAttribute('data-edit', f.key); el.dataset.extra = '1';
    zone.appendChild(el);
    return el;
  }
  const layoutMode = () => (window.innerWidth < 900 ? 'mobile' : 'desktop');
  function applyLayout(el, f) {
    const L = (f.layout || {})[layoutMode()] || {};
    el.style.transform = (L.x || L.y) ? `translate(${Number(L.x) || 0}px, ${Number(L.y) || 0}px)` : '';
    el.style.width = L.w ? Math.max(40, Number(L.w)) + 'px' : '';
    el.style.maxWidth = L.w ? 'none' : '';
    el.style.textAlign = L.align || '';
    if (f.kind === 'image') { el.style.borderRadius = L.radius != null ? Number(L.radius) + 'px' : ''; el.style.display = f.hidden && !EDIT_MODE ? 'none' : 'block'; }
    else el.style.display = f.hidden && !EDIT_MODE ? 'none' : '';
    if (EDIT_MODE) el.classList.toggle('is-hidden-field', !!f.hidden);
  }
  function fieldMap(doc) {
    const map = new Map();
    for (const sec of doc.sections || []) for (const f of sec.fields || []) map.set(f.key, f);
    return map;
  }
  function applyFields(doc, skipKey) {
    lastDoc = doc;
    const map = fieldMap(doc);
    loadFonts([...map.values()].map((f) => f.style && f.style.font).filter(Boolean));
    // объекты, добавленные в редакторе
    for (const f of map.values()) if (f.added) ensureExtra(f);
    // объекты, удалённые в редакторе
    document.querySelectorAll('[data-edit][data-extra]').forEach((el) => { if (!map.has(el.getAttribute('data-edit'))) el.remove(); });
    document.querySelectorAll('[data-edit]').forEach((el) => {
      const key = el.getAttribute('data-edit');
      if (!map.has(key)) return;
      const f = map.get(key);
      if (f.kind === 'image') { const src = safeSrc(f.src); if (el.getAttribute('src') !== src) el.setAttribute('src', src); }
      else if (key !== skipKey) { const html = rich(f.value); if (el.innerHTML.trim() !== html) el.innerHTML = html; }
      if (f.kind === 'button' && el.tagName === 'A') el.setAttribute('href', safeHref(f.href));
      applyStyle(el, f.style);
      applyLayout(el, f);
    });
  }
  /* Размер считается от текущего размера на экране — при смене ширины окна пересчитываем. */
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    if (!lastDoc) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => applyFields(lastDoc), 200);
  });

  function applyBackgrounds(doc) {
    for (const sec of doc.sections || []) {
      const bg = sec.background;
      if (!bg) continue;
      const section = document.getElementById(sec.id);
      if (!section) continue;
      let layer = section.querySelector(':scope > .section-backdrop');
      const image = bg.image || bg.default || '';
      if (!image && !layer) continue;
      if (!layer) {
        layer = document.createElement('div');
        layer.className = 'section-backdrop';
        layer.setAttribute('aria-hidden', 'true');
        section.prepend(layer);
      }
      layer.style.backgroundImage = image ? `url('${image.replace(/'/g, '%27')}')` : 'none';
      layer.style.opacity = bg.opacity != null && bg.opacity !== '' ? String(bg.opacity) : '';
    }
  }

  async function load() {
    for (const p of ['/api/site', 'data/site.json']) {
      try {
        const r = await fetch(p, { cache: 'no-store' });
        if (!r.ok) continue;
        const j = await r.json();
        if (j && Array.isArray(j.sections)) return j;
      } catch (e) { /* следующий источник */ }
    }
    return null;
  }

  window.AlviSite = { rich, applyFields, applyBackgrounds, load, FONTS };

  /* ================= Режим правки «как в Тильде» =================
     Включается, когда страница открыта внутри редактора кабинета (iframe с ?edit=1).
     Тексты правятся прямо на странице, изменения уходят родителю через postMessage. */
  const PARENT_ORIGINS = ['https://synapse.synapsebusiness.ru', 'http://localhost:8125', 'http://127.0.0.1:8125'];
  let parentOrigin = null;
  const post = (msg) => { if (parentOrigin) window.parent.postMessage(msg, parentOrigin); };

  /* innerHTML контентeditable → текст с разрешёнными тегами и переносами строк. */
  function htmlToValue(el) {
    let h = el.innerHTML;
    h = h.replace(/<div><br\s*\/?><\/div>/gi, '\n').replace(/<div>/gi, '\n').replace(/<\/div>/gi, '');
    h = h.replace(/<br\s*\/?>/gi, '\n');
    h = h.replace(/<\/?(em|strong|b|i|sup)(\s[^>]*)?>/gi, (m, tag) => `<${m.startsWith('</') ? '/' : ''}${tag.toLowerCase()}>`);
    h = h.replace(/<(?!\/?(em|strong|b|i|sup)>)[^>]+>/gi, '');
    const t = document.createElement('textarea'); t.innerHTML = h;
    return t.value.replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
  }

  function enableEditMode() {
    const style = document.createElement('style');
    style.textContent = `
      [data-edit] { outline: 1px dashed rgba(227,212,167,0.45); outline-offset: 3px; cursor: move; transition: outline-color 120ms; min-width: 1ch; }
      [data-edit][contenteditable="true"] { cursor: text; }
      body.x-dragging, body.x-dragging * { cursor: grabbing !important; user-select: none; }
      [data-edit]:hover { outline-color: rgba(227,212,167,0.95); outline-style: solid; }
      [data-edit].is-editing { outline: 2px solid #e3d4a7; outline-offset: 4px; box-shadow: 0 0 0 6px rgba(227,212,167,0.15); }
      [data-edit][contenteditable]:focus { outline: 2px solid #e3d4a7; }
      .content-section.is-edit-target, #trust.is-edit-target, .promo__panel.is-edit-target { box-shadow: inset 0 0 0 3px rgba(227,212,167,0.7); }
      .promo.is-open { z-index: 70; }
      .floating-cta { pointer-events: none; opacity: 0.35; }
      .cookie-notice { display: none !important; }
      html { scroll-behavior: smooth; }
      /* Режим «вся страница»: первый экран раскладывается сценами подряд, ничего не прокручивается внутри */
      html.edit-full .hero { height: auto !important; min-height: 0 !important; }
      html.edit-full .hero__sticky { position: relative !important; top: auto !important; height: auto !important; min-height: 0 !important; opacity: 1 !important; overflow: visible !important; }
      html.edit-full .hero__media { position: absolute !important; inset: 0 !important; height: auto !important; }
      html.edit-full .hero__scenes { position: relative !important; inset: auto !important; margin-top: 0 !important; z-index: 10; }
      html.edit-full .hero-scene { position: relative !important; inset: auto !important; opacity: 1 !important; transform: none !important; pointer-events: auto !important; min-height: 34rem !important; padding-top: 6rem !important; padding-bottom: 4rem !important; border-bottom: 1px dashed rgba(227,212,167,0.25); }
      html.edit-full .hero-scene--breath { display: none !important; }
      html.edit-full .hero-scene .hero-scene__content { visibility: visible !important; }
      html.edit-full .scroll-cue, html.edit-full .intro-skip { display: none !important; }
      html.edit-full .hero__chrome { position: absolute !important; top: 0; margin: 0 !important; }
      html.edit-full .floating-cta { position: absolute !important; }
      html.edit-full .hero-scene .hero-scene__content { opacity: 1 !important; transform: none !important; }`;
    document.head.appendChild(style);
    try { document.execCommand('defaultParagraphSeparator', false, 'br'); } catch (e) {}

    let current = null;
    /* Ручки: ✥ — двигать объект (сдвиг сохраняется отдельно для десктопа и телефона), ↔ — ширина. */
    const hMove = document.createElement('div'); hMove.className = 'x-handle'; hMove.title = 'Перетащить (Alt + стрелки — по 1 px)'; hMove.textContent = '✥';
    const hSize = document.createElement('div'); hSize.className = 'x-handle x-handle--size'; hSize.title = 'Ширина'; hSize.textContent = '↔';
    document.body.appendChild(hMove); document.body.appendChild(hSize);
    window.placeHandles = () => {
      if (!current || !document.body.contains(current)) { hMove.classList.remove('is-on'); hSize.classList.remove('is-on'); return; }
      const r = current.getBoundingClientRect();
      hMove.style.left = (r.left - 12) + 'px'; hMove.style.top = (r.top - 12) + 'px'; hMove.classList.add('is-on');
      hSize.style.left = (r.right - 6) + 'px'; hSize.style.top = (r.top + r.height / 2 - 14) + 'px'; hSize.classList.add('is-on');
    };
    const placeHandles = window.placeHandles;
    window.addEventListener('scroll', placeHandles, true); window.addEventListener('resize', placeHandles);
    const fieldOf = (el) => lastDoc && fieldMap(lastDoc).get(el.getAttribute('data-edit'));
    const layoutOf = (f) => { f.layout = f.layout || {}; const m = layoutMode(); f.layout[m] = f.layout[m] || {}; return f.layout[m]; };
    const commitLayout = (f) => { const el = document.querySelector(`[data-edit="${CSS.escape(f.key)}"]`); if (el) applyLayout(el, f); placeHandles(); post({ type: 'alvi-edit-layout', key: f.key, layout: f.layout }); };
    let drag = null;
    hMove.addEventListener('pointerdown', (e) => {
      if (!current) return; const f = fieldOf(current); if (!f) return;
      const L = layoutOf(f); drag = { f, L, sx: e.clientX, sy: e.clientY, x0: Number(L.x) || 0, y0: Number(L.y) || 0, id: e.pointerId };
      hMove.setPointerCapture(e.pointerId); e.preventDefault();
    });
    hMove.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag.L.x = Math.round(drag.x0 + e.clientX - drag.sx); drag.L.y = Math.round(drag.y0 + e.clientY - drag.sy);
      applyLayout(current, drag.f); placeHandles();
    });
    hMove.addEventListener('pointerup', (e) => { if (drag && e.pointerId === drag.id) { const f = drag.f; drag = null; commitLayout(f); } });
    let size = null;
    hSize.addEventListener('pointerdown', (e) => {
      if (!current) return; const f = fieldOf(current); if (!f) return;
      const L = layoutOf(f); size = { f, L, sx: e.clientX, w0: current.getBoundingClientRect().width, id: e.pointerId };
      hSize.setPointerCapture(e.pointerId); e.preventDefault();
    });
    hSize.addEventListener('pointermove', (e) => {
      if (!size || e.pointerId !== size.id) return;
      size.L.w = Math.max(40, Math.round(size.w0 + e.clientX - size.sx));
      applyLayout(current, size.f); placeHandles();
    });
    hSize.addEventListener('pointerup', (e) => { if (size && e.pointerId === size.id) { const f = size.f; size = null; commitLayout(f); } });
    const select = (el, opts = {}) => {
      if (current && current !== el) { current.classList.remove('is-editing'); current.removeAttribute('contenteditable'); }
      current = el;
      el.classList.add('is-editing');
      if (opts.edit && el.tagName !== 'IMG') { el.setAttribute('contenteditable', 'true'); try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); } }
      else if (!opts.keepEdit) el.removeAttribute('contenteditable');
      const section = el.closest('section[id], footer, .floating-cta, article[data-scene], .promo');
      const r = el.getBoundingClientRect();
      setTimeout(placeHandles, 30);
      post({ type: 'alvi-edit-select', rect: { top: r.top + window.scrollY, left: r.left + window.scrollX, width: r.width, height: r.height }, key: el.getAttribute('data-edit'), sectionId: section ? (section.id || (section.dataset.scene != null ? 'hero-' + section.dataset.scene : section.className.split(' ')[0])) : null });
    };
    /* Как в Тильде: клик — выбрать, потянуть курсором — переместить, двойной клик — править текст. */
    let press = null;
    /* Ссылки и картинки браузер тянет как «перетаскивание ссылки» — отключаем, иначе объект не переносится. */
    document.addEventListener('dragstart', (e) => { if (e.target.closest && e.target.closest('[data-edit], .promo, .hero-scene')) e.preventDefault(); }, true);
    const noNativeDrag = () => document.querySelectorAll('[data-edit], [data-edit] *, .promo a, .promo img').forEach((n) => { n.setAttribute('draggable', 'false'); });
    noNativeDrag(); new MutationObserver(noNativeDrag).observe(document.body, { childList: true, subtree: true });
    document.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('.x-handle')) return;
      const el = e.target.closest('[data-edit]'); if (!el) return;
      if (el === current && el.getAttribute('contenteditable') === 'true') return; // внутри текста — обычное выделение
      const f = fieldOf(el); if (!f) return;
      const L = layoutOf(f);
      press = { el, f, L, sx: e.clientX, sy: e.clientY, x0: Number(L.x) || 0, y0: Number(L.y) || 0, moved: false, id: e.pointerId };
      e.preventDefault();
    }, true);
    document.addEventListener('pointermove', (e) => {
      if (!press || e.pointerId !== press.id) return;
      const dx = e.clientX - press.sx, dy = e.clientY - press.sy;
      if (!press.moved && Math.hypot(dx, dy) < 4) return;
      if (!press.moved) { press.moved = true; if (current !== press.el) select(press.el); document.body.classList.add('x-dragging'); }
      press.L.x = Math.round(press.x0 + dx); press.L.y = Math.round(press.y0 + dy);
      applyLayout(press.el, press.f); placeHandles();
    }, true);
    const endPress = (e) => {
      if (!press || (e && e.pointerId !== press.id)) return;
      const p = press; press = null; document.body.classList.remove('x-dragging');
      if (p.moved) { commitLayout(p.f); return; }
      select(p.el);
    };
    document.addEventListener('pointerup', endPress, true);
    document.addEventListener('pointercancel', endPress, true);
    document.addEventListener('dblclick', (e) => {
      const el = e.target.closest('[data-edit]'); if (!el) return;
      e.preventDefault(); select(el, { edit: true });
    }, true);
    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-edit]');
      if (el) { e.preventDefault(); e.stopPropagation(); return; }
      // клик по ссылке/кнопке вне редактируемого текста — не переходим
      if (e.target.closest('a, button, label')) { e.preventDefault(); }
      if (e.target.closest('.x-handle')) return;
      if (current) { current.classList.remove('is-editing'); current.removeAttribute('contenteditable'); current = null; placeHandles(); }
      const section = e.target.closest('section[id], .promo__panel');
      document.querySelectorAll('.is-edit-target').forEach((x) => x.classList.remove('is-edit-target'));
      if (section) { section.classList.add('is-edit-target'); post({ type: 'alvi-edit-section', sectionId: section.id || 'promo' }); }
    }, true);
    document.addEventListener('input', (e) => {
      const el = e.target.closest && e.target.closest('[data-edit]');
      if (!el) return;
      post({ type: 'alvi-edit-change', key: el.getAttribute('data-edit'), value: htmlToValue(el) });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && current) { current.blur(); }
      if (e.altKey && current && /^Arrow(Left|Right|Up|Down)$/.test(e.key)) {
        const f = fieldOf(current); if (!f) return; e.preventDefault();
        const L = layoutOf(f); const step = e.shiftKey ? 10 : 1;
        if (e.key === 'ArrowLeft') L.x = (Number(L.x) || 0) - step; if (e.key === 'ArrowRight') L.x = (Number(L.x) || 0) + step;
        if (e.key === 'ArrowUp') L.y = (Number(L.y) || 0) - step; if (e.key === 'ArrowDown') L.y = (Number(L.y) || 0) + step;
        commitLayout(f);
      }
    });
    document.addEventListener('input', () => setTimeout(placeHandles, 0));
    document.addEventListener('paste', (e) => {
      const el = e.target.closest && e.target.closest('[data-edit]');
      if (!el) return;
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, text);
    });

    window.addEventListener('message', (e) => {
      if (!PARENT_ORIGINS.includes(e.origin)) return;
      parentOrigin = e.origin;
      const m = e.data || {};
      if (m.type === 'alvi-edit-doc' && m.doc) {
        setTimeout(() => { lastH = 0; reportHeight(); }, 100);
        // не трогаем элемент, который сейчас редактируется, чтобы не сбить курсор
        const editingKey = current && current.getAttribute('data-edit');
        applyFields(m.doc, editingKey);
        applyBackgrounds(m.doc);
        placeHandles();
      }
      if (m.type === 'alvi-edit-view') {
        document.documentElement.classList.toggle('edit-full', !!m.full);
        window.dispatchEvent(new Event('resize'));
        setTimeout(reportHeight, 50); setTimeout(reportHeight, 400); setTimeout(reportHeight, 1200);
      }
      if (m.type === 'alvi-edit-scroll' && m.key) {
        const el = document.querySelector(`[data-edit="${CSS.escape(m.key)}"]`);
        if (el) { if (!document.documentElement.classList.contains('edit-full')) el.scrollIntoView({ block: 'center' }); select(el, { edit: true }); }
      }
      if (m.type === 'alvi-edit-scroll-section' && m.sectionId) {
        const el = document.getElementById(m.sectionId);
        if (m.sectionId === 'promo' && el) {
          // баннер: в режиме «вся страница» он лежит блоком, в режиме «экран» — всплывает
          if (!document.documentElement.classList.contains('edit-full') && window.alviPromoOpen) window.alviPromoOpen();
        }
        if (el) {
          if (!document.documentElement.classList.contains('edit-full')) el.scrollIntoView({ block: 'start' });
          const r = el.getBoundingClientRect();
          post({ type: 'alvi-edit-rect', rect: { top: r.top + window.scrollY, left: r.left + window.scrollX, width: r.width, height: r.height } });
        }
      }
    });
    /* Высота страницы — родителю, чтобы холст показал её целиком */
    let lastH = 0;
    function reportHeight() {
      const h = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
      if (Math.abs(h - lastH) < 4) return;
      lastH = h; post({ type: 'alvi-edit-height', height: h });
    }
    if (window.ResizeObserver) { const ro = new ResizeObserver(() => reportHeight()); ro.observe(document.documentElement); if (document.body) ro.observe(document.body); }
    setInterval(reportHeight, 1500);
    // сообщаем родителю, что готовы (он ответит документом)
    for (const o of PARENT_ORIGINS) { try { window.parent.postMessage({ type: 'alvi-edit-ready' }, o); } catch (e) {} }
  }

  if (EDIT_MODE) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', enableEditMode, { once: true });
    else enableEditMode();
  }

  const run = async () => {
    const doc = await load();
    if (!doc) return;
    applyFields(doc);
    applyBackgrounds(doc);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true });
  else run();
})();
