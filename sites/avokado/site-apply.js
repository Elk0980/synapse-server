/* АВОКАДО · применение текстов и фонов главной из документа avokado/site (редактируется в кабинете Synapse).
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
    const id = 'avokado-site-fonts';
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
  function applyFields(doc) {
    lastDoc = doc;
    const map = new Map();
    for (const sec of doc.sections || []) for (const f of sec.fields || []) map.set(f.key, f);
    loadFonts([...map.values()].map((f) => f.style && f.style.font).filter(Boolean));
    document.querySelectorAll('[data-edit]').forEach((el) => {
      const key = el.getAttribute('data-edit');
      if (!map.has(key)) return;
      const f = map.get(key);
      const html = rich(f.value);
      if (el.innerHTML.trim() !== html) el.innerHTML = html;
      applyStyle(el, f.style);
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
      /* Пустой image означает штатный фон из разметки/CSS (background.default
         нужен редактору для превью и восстановления). */
      const image = bg.image || '';
      if (!image && layer) { layer.remove(); continue; }
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

  window.AvokadoSite = { rich, applyFields, applyBackgrounds, load, FONTS };

  /* ================= Режим правки «как в Тильде» =================
     Включается, когда страница открыта внутри редактора кабинета (iframe с ?edit=1).
     Тексты правятся прямо на странице, изменения уходят родителю через postMessage. */
  const EDIT_MODE = new URLSearchParams(location.search).get('edit') === '1' && window.parent !== window;
  const PARENT_ORIGINS = ['https://synapse.synapsebusiness.ru'];
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
      [data-edit] { outline: 1px dashed rgba(227,212,167,0.45); outline-offset: 3px; cursor: text; transition: outline-color 120ms; min-width: 1ch; }
      [data-edit]:hover { outline-color: rgba(227,212,167,0.95); outline-style: solid; }
      [data-edit].is-editing { outline: 2px solid #e3d4a7; outline-offset: 4px; box-shadow: 0 0 0 6px rgba(227,212,167,0.15); }
      [data-edit][contenteditable]:focus { outline: 2px solid #e3d4a7; }
      .content-section.is-edit-target, #trust.is-edit-target { box-shadow: inset 0 0 0 3px rgba(227,212,167,0.7); }
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
    const activateMethodScene = (el) => {
      const scene = el && el.closest && el.closest('.method-scene');
      if (!scene) return;
      document.querySelectorAll('.method-scene').forEach((item) => item.classList.toggle('active', item === scene));
    };
    const select = (el) => {
      if (current && current !== el) { current.classList.remove('is-editing'); current.removeAttribute('contenteditable'); }
      current = el;
      activateMethodScene(el);
      el.classList.add('is-editing');
      el.setAttribute('contenteditable', 'true');
      try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
      const section = el.closest('section[id], footer, .floating-cta, article[data-scene]');
      const r = el.getBoundingClientRect();
      post({ type: 'alvi-edit-select', rect: { top: r.top + window.scrollY, left: r.left + window.scrollX, width: r.width, height: r.height }, key: el.getAttribute('data-edit'), sectionId: section ? (section.id || (section.dataset.scene != null ? 'hero-' + section.dataset.scene : section.className.split(' ')[0])) : null });
    };
    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-edit]');
      if (el) { e.preventDefault(); e.stopPropagation(); if (current !== el) select(el); return; }
      // клик по ссылке/кнопке вне редактируемого текста — не переходим
      if (e.target.closest('a, button, label')) { e.preventDefault(); }
      const section = e.target.closest('section[id]');
      document.querySelectorAll('.is-edit-target').forEach((x) => x.classList.remove('is-edit-target'));
      if (section) { section.classList.add('is-edit-target'); post({ type: 'alvi-edit-section', sectionId: section.id }); }
    }, true);
    document.addEventListener('input', (e) => {
      const el = e.target.closest && e.target.closest('[data-edit]');
      if (!el) return;
      post({ type: 'alvi-edit-change', key: el.getAttribute('data-edit'), value: htmlToValue(el) });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && current) { current.blur(); }
    });
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
        const doc = m.doc;
        lastDoc = doc;
        const map = new Map();
        for (const sec of doc.sections || []) for (const f of sec.fields || []) map.set(f.key, f);
        loadFonts([...map.values()].map((f) => f.style && f.style.font).filter(Boolean));
        document.querySelectorAll('[data-edit]').forEach((el) => {
          const key = el.getAttribute('data-edit');
          if (!map.has(key)) return;
          const f = map.get(key);
          if (key !== editingKey) { const html = rich(f.value); if (el.innerHTML.trim() !== html) el.innerHTML = html; }
          applyStyle(el, f.style);
        });
        applyBackgrounds(doc);
      }
      if (m.type === 'alvi-edit-view') {
        document.documentElement.classList.toggle('edit-full', !!m.full);
        window.dispatchEvent(new Event('resize'));
        setTimeout(reportHeight, 50); setTimeout(reportHeight, 400); setTimeout(reportHeight, 1200);
      }
      if (m.type === 'alvi-edit-scroll' && m.key) {
        const el = document.querySelector(`[data-edit="${CSS.escape(m.key)}"]`);
        if (el) { activateMethodScene(el); if (!document.documentElement.classList.contains('edit-full')) el.scrollIntoView({ block: 'center' }); setTimeout(() => activateMethodScene(el), 0); select(el); }
      }
      if (m.type === 'alvi-edit-scroll-section' && m.sectionId) {
        const el = document.getElementById(m.sectionId);
        if (el) {
          activateMethodScene(el);
          if (!document.documentElement.classList.contains('edit-full')) el.scrollIntoView({ block: 'start' });
          setTimeout(() => activateMethodScene(el), 0);
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
